// CR-CRU-096 C1 (cycle 309) — THE WAVE HEADER TELLS THE TRUTH: which release
// the wave belongs to, and how big the wave is.
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S1 ("active" means the wrong thing), §S2 (the count is computed,
//       published, and never drawn), §S8 (shape and colour grammar)
//       AC1, AC2, AC3, AC4 — and AC29 on every fixture below.
// Approved design: `.lavish/crucible-workflow-flowchart.html` §1 (the wave
//       header is `<h4><span>Wave 5 · active</span><span>28</span></h4>`) and
//       §7 ("Wave container | drawn when | the focused release is the active
//       one"; "Motion | the CR is IN_PROGRESS").
//
// SCOPE — the wave HEADER only. The roll-up (§S3, AC5–AC7), the chip→row
// rewrite and the trim (§S4/§S5, AC8–AC18), the horizontal axis (§S6, AC20)
// and the shipped path (§S7, AC21–AC24) are cycles 310–313 and are asserted
// nowhere here. This file is a sibling of tests/roadmap-release-focus.test.ts
// (CR-CRU-078 C3) and reuses its harness verbatim: the REAL public/app.js
// shell driving its own fetch chain and van.js's real scheduler inside
// happy-dom, with the box model stubbed because happy-dom runs no layout.
//
// WHAT IS ASSERTED, AND WHY IT IS THE PUBLISHED SURFACE AND NOT A FUNCTION
// NAME. "This wave belongs to the focused, in-flight release" is a decision,
// so it belongs in the pure module (`focusedReleaseView`,
// public/app-logic.mjs:1154, already answers `kind === "proposed"` vs
// `"shipped"` — stamping each wave box there is the shape that matches this
// codebase). But GREEN may put it anywhere: every assertion below reads the
// PUBLISHED `data-active` attribute and the RENDERED header text, never an
// internal name.
//
// AC29 — EVERY FIXTURE ID IS SYNTHETIC (`CR-W1-01`, `CR-W2-01`, `CR-Q-1`,
// `CR-S-A`). Crucible is project-INDEPENDENT: a criterion that only holds
// while our own backlog has a given shape is not a criterion. CR ids named in
// comments are provenance, never fixture data.
//
// RED phase — expected to FAIL against current production, which:
//   • answers `data-active` from `box.entries.some(status === "IN_PROGRESS")`
//     (public/app.js:2797), so a wave of the in-flight release with nothing
//     running publishes `"false"`;
//   • renders the label `Wave ${box.wave}` and nothing else
//     (public/app.js:2802) — no `· active` marker and no count, even though
//     `data-cr-count` is on the element and correct (`:2791`).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

// ── Fixture types (the wire shapes, as tests/roadmap-release-focus.test.ts
//    declares them) ───────────────────────────────────────────────────────────

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

/** `src/v2.ts:1755-1763` (`releaseBrief`) — what `GET …/releases` publishes. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
  timestamp: number;
}

/** `src/v2.ts:2045-2057` (`proposalBrief`) — what `GET …/release-proposals`
 *  publishes. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes,
 *  in the canonical order (CR-CRU-095 §S1: release → wave → seq). */
interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  planId?: number;
  seq?: number;
  release?: string;
  track?: string;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One synthetic board built for AC3's demand that the wave's count cannot be
// confused with the release view's:
//
//   0.4.0  proposed, IN FLIGHT and focused by default — TWO waves,
//          `1` holding 28 (22 COMPLETED, 6 PENDING) and `2` holding 3.
//          Release membership is therefore 31, so a header reading the release
//          view's `crCount` (public/app.js:2892) shows 31 and fails, and a
//          single-wave fixture — which AC3 rejects explicitly — could not tell
//          the two apart.
//          NOTHING in it is IN_PROGRESS: this is exactly §S1's case, the wave
//          the design draws as `WAVE 5 · ACTIVE` with 18 of 20 merged and
//          nothing running.
//          The 22-merged/6-pending split is also trim-READY: when cycle 311's
//          roll-up and trim land, wave `1` shows ~5 rows while its header must
//          still say 28, so these assertions survive that cycle unchanged.
//   0.5.0  proposed and NOT focused — one wave `3` of 2, so "the focused
//          release" can be told from "any proposal".
//   0.1.0  shipped — its own two CRs, to focus a settled tag.

const SHIP_010 = 1787149125; // 2026-08-19, epoch SECONDS
const TARGET_040 = 1790000000;

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: SHIP_010,
  crs: ["CR-S-A", "CR-S-B"],
  packages: [],
  timestamp: SHIP_010 * 1000,
};

const PROPOSED_040: ProposalFixture = {
  label: "0.4.0",
  targetAt: TARGET_040,
  timestamp: 1787000000,
  waves: ["1", "2"],
};

const PROPOSED_050: ProposalFixture = {
  label: "0.5.0",
  timestamp: 1787000001,
  waves: ["3"],
};

const WAVE_ONE_SIZE = 28;
const WAVE_ONE_MERGED = 22;
const WAVE_TWO_SIZE = 3;

const WAVE_ONE: QueueFixture[] = Array.from({ length: WAVE_ONE_SIZE }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return {
    cr: `CR-W1-${n}`,
    title: `CR-W1-${n} — synthetic wave-one member`,
    wave: "1",
    dependsOn: [],
    status: index < WAVE_ONE_MERGED ? "COMPLETED" : "PENDING",
    seq: (index + 1) * 10,
    release: "0.4.0",
  } satisfies QueueFixture;
});

const WAVE_TWO: QueueFixture[] = Array.from({ length: WAVE_TWO_SIZE }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return {
    cr: `CR-W2-${n}`,
    title: `CR-W2-${n} — synthetic wave-two member`,
    wave: "2",
    dependsOn: [],
    status: "PENDING",
    seq: 500 + index * 10,
    release: "0.4.0",
  } satisfies QueueFixture;
});

const UNFOCUSED_WAVE: QueueFixture[] = [
  { cr: "CR-Q-1", title: "CR-Q-1 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 900, release: "0.5.0" },
  { cr: "CR-Q-2", title: "CR-Q-2 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 910, release: "0.5.0" },
];

const SHIPPED_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
];

const QUEUE: QueueFixture[] = [...SHIPPED_MEMBERS, ...WAVE_ONE, ...WAVE_TWO, ...UNFOCUSED_WAVE];

/** §S1's OTHER half: a wave with something actually running. The marker and
 *  the border must not start depending on it — nor stop. */
const QUEUE_WITH_RUNNER: QueueFixture[] = QUEUE.map((entry) =>
  entry.cr === "CR-W1-23"
    ? ({ ...entry, status: "IN_PROGRESS", planId: 41 } satisfies QueueFixture)
    : entry,
);

/** The membership of 0.4.0 — 31, the number the RELEASE view publishes and
 *  the number no wave header may show. */
const RELEASE_040_MEMBERSHIP = WAVE_ONE_SIZE + WAVE_TWO_SIZE;

// ── Harness (tests/roadmap-release-focus.test.ts, verbatim) ─────────────────

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: { id: number; label: string; status: string }[];
}

interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  plans?: PlanFixture[];
}

/** happy-dom runs no layout engine, so the strip would measure a zero track
 *  and render a zero-gate window — and zone 2 reads its focus from the strip's
 *  own sequence. The box model is supplied exactly as the sibling suites
 *  supply it: wide enough that every fixture gate fits one window, so nothing
 *  here depends on paging. */
const TRACK_W = 800;
const PITCH = 100;

function rect(left: number, width: number): DOMRect {
  const box = {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => box,
  };
  return box as unknown as DOMRect;
}

function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip-track") return rect(0, TRACK_W);
    if (testid === "roadmap-strip-ruler") return rect(0, PITCH);
    return rect(0, 0);
  };
}

let cacheBust = 0;

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const key = opts.key ?? "wave-header-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals` must not be swallowed by `/releases`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [PROPOSED_040, PROPOSED_050];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_010] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? QUEUE });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: opts.plans ?? [] });
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          {
            key,
            name: key,
            type: "backend",
            agentsOnline: 0,
            agentsTotal: 0,
            active: true,
            lastActivity: Date.now(),
          },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-wave-header.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapWaveHeader=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production shell driving its
 *  own fetch chain and van.js's real reactive scheduler. */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

function flow(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="roadmap-flow"]');
  if (el === null) throw new Error('no [data-testid="roadmap-flow"] rendered');
  return el;
}

const waveEls = (): HTMLElement[] => all('[data-testid="roadmap-wave"]');
const waveNames = (): string[] => waveEls().map((w) => w.getAttribute("data-wave") ?? "");

function waveEl(wave: string): HTMLElement {
  const box = waveEls().find((w) => w.getAttribute("data-wave") === wave);
  if (box === undefined) {
    throw new Error(`no wave container rendered for wave ${wave} (have: ${waveNames().join(", ")})`);
  }
  return box;
}

const activeAttr = (wave: string): string | null => waveEl(wave).getAttribute("data-active");

/** AC2/AC3 — the HEADER is the subject: the count must ride in it, not be
 *  appended after the CRs. Its internal structure is GREEN's to choose, so
 *  the marker is read out of the header's TEXT and never off a nested tag. */
function headerEl(wave: string): HTMLElement {
  const header = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-header"]');
  if (header === null) throw new Error(`wave ${wave} renders no [data-testid="roadmap-wave-header"]`);
  return header;
}

const headerText = (wave: string): string =>
  (headerEl(wave).textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** The whole box's text, for the "nothing anywhere says active" direction. */
const boxText = (wave: string): string =>
  (waveEl(wave).textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function countText(wave: string): string {
  const el = headerEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-count"]');
  if (el === null) throw new Error(`wave ${wave}'s header renders no [data-testid="roadmap-wave-count"]`);
  return (el.textContent ?? "").trim();
}

/** The `· active` marker, read as a WORD out of the header (§S8: status is
 *  written as text, so the view survives a greyscale screenshot). */
const headerSaysActive = (wave: string): boolean => headerText(wave).includes("active");

async function clickGate(version: string): Promise<void> {
  const gate = all('[data-testid="roadmap-gate"]').find(
    (g) => g.getAttribute("data-version") === version,
  );
  if (gate === undefined) throw new Error(`no strip gate rendered for ${version}`);
  gate.click();
  await settle();
}

// ── AC4's reader: what the SHIPPED stylesheet actually animates ─────────────
//
// happy-dom has no cascade, so "renders no animation" is asserted the one way
// that is true without one: every rule in public/styles.css that declares an
// `animation` is collected, and no element of the active wave's chrome MATCHES
// any of them. A real-engine `getComputedStyle` check on the same fact is
// CR-CRU-078 C5's (tests/roadmap-visual-grammar.test.ts, headless Chromium).

function animatingSelectors(css: string): string[] {
  // COMMENTS FIRST. A `/* … */` between a rule's closing `}` and the next
  // selector is part of neither, but the rule split below sees only braces:
  // left in place, the comment's text (commas and all) is swallowed into the
  // following selector string, which then matches nothing and — fed to
  // `matches()` — is not even a valid selector. Stripping them here is why
  // production is free to document a rule from above it, as this stylesheet
  // does throughout.
  const decommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // `@keyframes` bodies are stops (`0%`, `50%`), not selectors: drop them
  // whole, one nesting level deep, before looking at any rule.
  const rules = decommented.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: string[] = [];
  for (const match of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\banimation(?:-name)?\s*:/.test(match[2] ?? "")) continue;
    for (const selector of (match[1] ?? "").split(",")) {
      const trimmed = selector.trim();
      if (trimmed !== "") out.push(trimmed);
    }
  }
  return out;
}

const ANIMATING = animatingSelectors(STYLES_SRC);

// ── §S1/AC1 — "active" means THIS WAVE BELONGS TO THE IN-FLIGHT RELEASE ────

describe("CR-CRU-096 §S1/AC1 — a wave publishes `data-active` from its RELEASE, not from whether some CR is mid-run", () => {
  test("every wave of the focused in-flight release publishes data-active=true with NO CR IN_PROGRESS", async () => {
    await mountApp();

    // The fixture really is the §S1 case: in flight, nothing running.
    expect(flow().getAttribute("data-kind")).toBe("proposed");
    expect(flow().getAttribute("data-version")).toBe("0.4.0");
    expect(QUEUE.some((entry) => entry.status === "IN_PROGRESS")).toBe(false);

    expect(waveNames()).toEqual(["1", "2"]);
    expect(activeAttr("1")).toBe("true");
    expect(activeAttr("2")).toBe("true");
  });

  test("a SHIPPED focus publishes no active wave, and an UNFOCUSED release's waves are not published at all — focus decides, and only the focus", async () => {
    await mountApp();

    // 0.5.0 is a live proposal too, but it is not the focus: zone 2 draws one
    // release, so no wave of it exists to claim anything.
    expect(waveNames()).toEqual(["1", "2"]);
    expect(waveNames()).not.toContain("3");

    await clickGate("0.1.0");
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    // AC1a — the observable AC1's second clause actually has: a SHIPPED focus
    // publishes `false` by rendering NO WAVE BOX AT ALL. `data-active` is
    // `kind === "proposed"` and zone 2 draws boxes only when the focus is not
    // shipped, so a rendered box can never carry `false`; asserting the
    // absence of boxes is the only thing here that can fail for the reason it
    // claims. Counting `[data-active="true"]` boxes would pass vacuously on
    // zero boxes of ANY kind.
    expect(waveEls()).toEqual([]);
    expect(waveNames()).toEqual([]);

    // Focus the OTHER proposal: its wave is now the in-flight one, and 0.4.0's
    // two waves are gone rather than lingering as active.
    await clickGate("0.5.0");
    expect(waveNames()).toEqual(["3"]);
    expect(activeAttr("3")).toBe("true");
  });

  test("a CR that is actually running is not what makes the wave active: with one IN_PROGRESS in wave 1, wave 2 — which has none — is still active", async () => {
    await mountApp({ queue: QUEUE_WITH_RUNNER });

    // Non-vacuity: exactly one member is mid-run, and it is in wave 1.
    const running = QUEUE_WITH_RUNNER.filter((entry) => entry.status === "IN_PROGRESS");
    expect(running.map((entry) => entry.cr)).toEqual(["CR-W1-23"]);
    expect(running[0]!.wave).toBe("1");

    expect(activeAttr("1")).toBe("true");
    expect(activeAttr("2")).toBe("true");
  });
});

// ── §S1/AC2 — the marker is a WORD in the header, and tracks `data-active` ──

describe("CR-CRU-096 §S1/AC2 — the header renders the `· active` marker exactly when data-active=true", () => {
  test("an active wave's header states `Wave <n> · active`, not the bare `Wave <n>`", async () => {
    await mountApp();

    const one = headerText("1");
    expect(one).toContain("wave 1");
    expect(one).toContain("· active");
    // §S8 — the marker is a WORD, so the fact survives greyscale; the border is
    // the second channel, never the only one.
    expect(headerSaysActive("1")).toBe(true);
    expect(headerSaysActive("2")).toBe(true);
  });

  test("the marker tracks the published attribute across every focus: every wave that renders publishes true and says `active`, and the shipped focus — AC1a's `false` — renders no header to say anything", async () => {
    await mountApp();

    let sawActive = false;
    for (const version of ["0.4.0", "0.1.0", "0.5.0"]) {
      await clickGate(version);
      const shipped = flow().getAttribute("data-kind") === "shipped";
      // AC1a — the honest observable: `data-active` is `kind === "proposed"`
      // and boxes render only for a non-shipped focus, so no rendered header
      // can ever be paired with `false`. The `false` side of the
      // biconditional is the ABSENCE of boxes, which is what is asserted for
      // the shipped focus rather than a value no box can publish.
      if (shipped) {
        expect(waveEls()).toEqual([]);
        continue;
      }
      expect(waveNames().length).toBeGreaterThan(0);
      for (const wave of waveNames()) {
        expect(activeAttr(wave)).toBe("true");
        expect(headerSaysActive(wave)).toBe(true);
        sawActive = true;
      }
    }
    expect(sawActive).toBe(true);
  });
});

// ── §S2/AC3 — the header states the wave's OWN whole membership ─────────────

describe("CR-CRU-096 §S2/AC3 — the header draws the count that is already published, for ITS OWN wave", () => {
  test("a two-wave release renders 28 and 3 — each equal to its own wave element's data-cr-count", async () => {
    await mountApp();

    const publishedOne = waveEl("1").getAttribute("data-cr-count") ?? "";
    const publishedTwo = waveEl("2").getAttribute("data-cr-count") ?? "";
    expect(publishedOne).toBe(String(WAVE_ONE_SIZE));
    expect(publishedTwo).toBe(String(WAVE_TWO_SIZE));

    // The drawn count is the PUBLISHED count — the same fact twice, never a
    // second derivation that could drift from it.
    expect(countText("1")).toBe(publishedOne);
    expect(countText("2")).toBe(publishedTwo);
  });

  test("the count is the WAVE's membership, never the release view's crCount and never the merged or actionable subset", async () => {
    await mountApp();

    // The release view publishes 31 — a different fact (AC21's, for a shipped
    // tag the ledger's `crs.length`). No header may show it.
    expect(flow().getAttribute("data-cr-count")).toBe(String(RELEASE_040_MEMBERSHIP));
    expect(RELEASE_040_MEMBERSHIP).not.toBe(WAVE_ONE_SIZE);
    expect(countText("1")).not.toBe(String(RELEASE_040_MEMBERSHIP));
    expect(countText("2")).not.toBe(String(RELEASE_040_MEMBERSHIP));
    expect(headerText("1")).not.toContain(String(RELEASE_040_MEMBERSHIP));

    // Nor the 22 merged, nor the 6 still actionable: the header states SIZE.
    expect(countText("1")).not.toBe(String(WAVE_ONE_MERGED));
    expect(countText("1")).not.toBe(String(WAVE_ONE_SIZE - WAVE_ONE_MERGED));
  });
});

// ── §S1/AC4 — motion stays reserved for IN_PROGRESS (CR-078 AC24) ──────────

describe("CR-CRU-096 §S1/AC4 — an active wave with no running CR renders NO animation", () => {
  test("the active wave box and its header match no animating rule in the shipped stylesheet", async () => {
    await mountApp();

    // The precondition is the AC: an ACTIVE wave with nothing running.
    expect(QUEUE.some((entry) => entry.status === "IN_PROGRESS")).toBe(false);
    expect(activeAttr("1")).toBe("true");

    // Parser sanity + non-vacuity: the stylesheet really does animate
    // something, and the thing it animates is the RUNNING CR.
    expect(ANIMATING.length).toBeGreaterThan(0);
    expect(ANIMATING.every((selector) => !selector.includes("%"))).toBe(true);
    expect(ANIMATING).toContain(".app-flow-node.in_progress");

    const box = waveEl("1");
    const chrome: HTMLElement[] = [
      box,
      headerEl("1"),
      ...Array.from(headerEl("1").querySelectorAll<HTMLElement>("*")),
    ];
    for (const element of chrome) {
      for (const selector of ANIMATING) {
        expect(element.matches(selector)).toBe(false);
      }
      expect(element.style.animation).toBe("");
      expect(element.style.animationName).toBe("");
    }
    // The box does not borrow the running CR's class to get its look, either.
    expect(box.className).not.toContain("in_progress");
    expect(box.className).not.toContain("pulse");
  });

  test("the active-wave marker's second channel is a BORDER: the stylesheet's `[data-active=\"true\"]` rule colours an edge and declares no animation", async () => {
    await mountApp();
    expect(activeAttr("1")).toBe("true");

    const activeRules = Array.from(
      STYLES_SRC.matchAll(/([^{}]*\[data-active="true"\][^{}]*)\{([^{}]*)\}/g),
    );
    expect(activeRules.length).toBeGreaterThan(0);
    expect(activeRules.some(([, , body]) => /border-color\s*:/.test(body ?? ""))).toBe(true);
    for (const [, , body] of activeRules) {
      expect(/\banimation(?:-name)?\s*:/.test(body ?? "")).toBe(false);
    }
  });
});

// ── The AC4 READER itself, pinned ──────────────────────────────────────────
//
// `animatingSelectors` is test infrastructure, and a defect in it reads as a
// defect in production: before it stripped comments, the text between a rule's
// `}` and the next selector leaked into that selector, so a documented
// animating rule went unrecognised and the leaked string — commas and all —
// was handed to `matches()`. This test feeds the parser the exact shape and
// pins the whole answer, so the stylesheet stays free to be commented from
// above and this reader can never silently mis-read it again.

describe("animatingSelectors — the AC4 reader survives comments between rules", () => {
  test("a comma-bearing comment sitting between a `}` and an animating selector contributes nothing to the parsed selectors", () => {
    const css = `
.quiet { color: red; }
/* AC24 — MOTION MEANS LIVE, and it reuses app-run-pulse, the running card's
   pulse, rather than inventing a third motion vocabulary. */
.app-flow-node.in_progress,
.app-evt-running {
  animation: app-run-pulse 1.6s ease-in-out infinite;
}
@keyframes app-run-pulse {
  /* the stops carry a comment too */
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.named { animation-name: app-run-pulse; }
`;

    expect(animatingSelectors(css)).toEqual([
      ".app-flow-node.in_progress",
      ".app-evt-running",
      ".named",
    ]);
  });
});
