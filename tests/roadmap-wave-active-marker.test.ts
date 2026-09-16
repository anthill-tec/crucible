// CR-CRU-116 §S4 — ONE wave carries the `· active` marker, and today the
// renderer gives it to all of them. C2 RED.
//
// Spec: docs/changes/CR-CRU-116-only-one-wave-is-active.md §S4 and its four
//       ACs (exactly one marker with work in flight; ZERO markers with none;
//       both header texts asserted WHOLE in the SAME render; `data-active`
//       reads `"false"` on the non-active box).
//
// ── WHAT IS BROKEN TODAY (read 2026-09-09) ────────────────────────────────
//
// `focusedReleaseView` (public/app-logic.mjs) computes activeness ONCE for
// the whole release — `const active = kind === "proposed"` — and copies that
// one flag into every wave box it builds (`{ wave, active, entries, rows,
// hiddenCount, mergedCount, lanes, soloRows }`). Its own comment states the
// `false` branch is "UNREACHABLE by construction", which was true while a
// release held ONE wave and is false now that 0.2.0 holds waves 5 and 6.
// The renderer reads that flag verbatim: `data-active` at public/app.js:3072
// and the `Wave ${box.wave}${box.active === true ? " · active" : ""}` label
// at :3100. So a proposed release with two waves renders `· active` on BOTH
// boxes, and a release with nothing in flight renders it anyway.
//
// Every assertion below therefore FAILS against current production, and each
// fails for that one reason — the marker is a RELEASE fact where §S4 requires
// a per-WAVE one, derived exactly as §S1 derives it: the box whose wave holds
// an `IN_PROGRESS` cr carries the marker, and no other box does.
//
// ── WHAT IS ASSERTED, AND WHY IT IS THE PUBLISHED SURFACE ─────────────────
//
// Where the per-wave answer is COMPUTED is GREEN's to choose (the shape that
// matches this codebase is `focusedReleaseView`, beside the membership it is
// a fact about). Nothing below names an internal symbol: every assertion
// reads the rendered header text and the published `data-active` attribute,
// through the REAL public/app.js shell driving its own fetch chain and
// van.js's real scheduler inside happy-dom — the harness
// tests/roadmap-wave-header.test.ts established, reused verbatim.
//
// EVERY FIXTURE ID IS SYNTHETIC (CR-CRU-096 AC29 — Crucible is
// project-INDEPENDENT). Wave labels `5` and `6` are the CR's own example and
// are fixture data, not a claim about our backlog.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

/** The marker as the renderer writes it (public/app.js:3100) — a MIDDLE DOT
 *  (U+00B7), stated once so no assertion below can pin a lookalike. */
const MARKER = " \u00b7 active";

// ── Fixture types (the wire shapes, as tests/roadmap-wave-header.test.ts
//    declares them) ─────────────────────────────────────────────────────────

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

/** `src/v2.ts` (`releaseBrief`) — what `GET …/releases` publishes. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
  timestamp: number;
}

/** `src/v2.ts` (`proposalBrief`) — what `GET …/release-proposals` publishes. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** `src/types.ts` (`QueueEntry`) — what `GET …/queue` publishes, in the
 *  canonical order (CR-CRU-095 §S1: release → wave → seq). */
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

// ── THE TWO-WAVE FIXTURE ───────────────────────────────────────────────────
//
// TWO_WAVE_BOARD — the reusable shape §S4's third AC says the roadmap suite
// lacks: ONE proposed, focused release holding TWO waves, where the waves
// differ in the ONE fact the marker is now a function of.
//
//   0.6.0  proposed, in flight and focused by default — waves `5` and `6`.
//          Wave 5 is COMPLETE: 4 members, all COMPLETED, nothing running —
//          the live shape of wave 5 under 0.2.0, which is why it renders the
//          marker on the board today and must not.
//          Wave 6 is the one with work in flight: 3 members, one
//          IN_PROGRESS (with its `planId`, as the queue publishes it) and two
//          PENDING.
//   0.5.0  shipped — two settled members, so the strip has a tag and the
//          focus really is a CHOICE rather than the only gate there is.
//
// The waves differ in SIZE as well as in activeness (4 vs 3), so an assertion
// cannot pass by reading the wrong box, and no track is declared anywhere:
// lanes exist only above one track, so the header's identity phrase is the
// wave and its marker and nothing else (public/app.js:3097-3101).
//
// TWO_WAVE_BOARD_IDLE is the SAME board with the running cr set back to
// PENDING — §S4's second AC, the branch the current comment calls
// "UNREACHABLE by construction".

const SHIP_050 = 1787149125; // epoch SECONDS
const TARGET_060 = 1790000000;

const SHIPPED_050: ReleaseFixture = {
  version: "0.5.0",
  commit: "c07274c",
  releasedAt: SHIP_050,
  crs: ["CR-SETTLED-A", "CR-SETTLED-B"],
  packages: [],
  timestamp: SHIP_050 * 1000,
};

const PROPOSED_060: ProposalFixture = {
  label: "0.6.0",
  targetAt: TARGET_060,
  timestamp: 1787000000,
  waves: ["5", "6"],
};

const WAVE_FIVE_SIZE = 4;
const WAVE_SIX_SIZE = 3;
/** The one member of wave 6 that is mid-run. */
const RUNNING_CR = "CR-SIX-BETA";

const WAVE_FIVE: QueueFixture[] = Array.from({ length: WAVE_FIVE_SIZE }, (_, index) => ({
  cr: `CR-FIVE-${String(index + 1).padStart(2, "0")}`,
  title: `CR-FIVE-${String(index + 1).padStart(2, "0")} — landed wave-five member`,
  wave: "5",
  dependsOn: [],
  status: "COMPLETED",
  seq: 5000 + (index + 1) * 10,
  release: "0.6.0",
}));

const WAVE_SIX: QueueFixture[] = [
  {
    cr: "CR-SIX-ALPHA",
    title: "CR-SIX-ALPHA — scheduled",
    wave: "6",
    dependsOn: [],
    status: "PENDING",
    seq: 6010,
    release: "0.6.0",
  },
  {
    cr: RUNNING_CR,
    title: "CR-SIX-BETA — the work in flight",
    wave: "6",
    dependsOn: [],
    status: "IN_PROGRESS",
    planId: 41,
    seq: 6020,
    release: "0.6.0",
  },
  {
    cr: "CR-SIX-GAMMA",
    title: "CR-SIX-GAMMA — scheduled",
    wave: "6",
    dependsOn: [],
    status: "PENDING",
    seq: 6030,
    release: "0.6.0",
  },
];

const SHIPPED_MEMBERS: QueueFixture[] = [
  { cr: "CR-SETTLED-A", title: "CR-SETTLED-A — delivered", wave: "4", dependsOn: [], status: "COMPLETED", seq: 4010, release: "0.5.0" },
  { cr: "CR-SETTLED-B", title: "CR-SETTLED-B — delivered", wave: "4", dependsOn: [], status: "COMPLETED", seq: 4020, release: "0.5.0" },
];

/** Wave 5 first, so first-appearance order puts the COMPLETE wave ahead of
 *  the running one — the order the boxes render in. */
const TWO_WAVE_BOARD: QueueFixture[] = [
  ...SHIPPED_MEMBERS,
  ...WAVE_FIVE,
  ...WAVE_SIX,
];

/** §S4's second AC — the same two waves with NOTHING in flight. */
const TWO_WAVE_BOARD_IDLE: QueueFixture[] = TWO_WAVE_BOARD.map((entry) =>
  entry.cr === RUNNING_CR
    ? ({ ...entry, status: "PENDING", planId: undefined } satisfies QueueFixture)
    : entry,
);

// ── Harness (tests/roadmap-wave-header.test.ts, verbatim) ──────────────────

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
 *  supply it: wide enough that every fixture gate fits one window. */
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
  const key = opts.key ?? "wave-marker-key";
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
      const proposals = opts.proposals ?? [PROPOSED_060];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_050] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? TWO_WAVE_BOARD });
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
    throw new Error(`roadmap-wave-active-marker.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapWaveMarker=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production shell driving its
 *  own fetch chain and van.js's real reactive scheduler. */
async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ───────────────────────────────────────────────────────────

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

function headerEl(wave: string): HTMLElement {
  const header = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-header"]');
  if (header === null) {
    throw new Error(`wave ${wave} renders no [data-testid="roadmap-wave-header"]`);
  }
  return header;
}

/** The header's IDENTITY PHRASE, read WHOLE: everything the header says other
 *  than the whole-membership count it also publishes as its own element. The
 *  count is removed from a CLONE, so the assertion reads exactly the phrase
 *  `Wave 5` / `Wave 6 · active` the design writes, and nothing is asserted
 *  about how GREEN nests it. */
function headerPhrase(wave: string): string {
  const clone = headerEl(wave).cloneNode(true) as HTMLElement;
  clone.querySelector('[data-testid="roadmap-wave-count"]')?.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The whole-membership count the header publishes beside the phrase. */
function countText(wave: string): string {
  const el = headerEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-count"]');
  if (el === null) {
    throw new Error(`wave ${wave}'s header renders no [data-testid="roadmap-wave-count"]`);
  }
  return (el.textContent ?? "").trim();
}

/** §S4/AC1 — the marker COUNTED ACROSS EVERY BOX THAT RENDERED, which is the
 *  only reading that can catch "both of them carry it". Inspecting one box
 *  answers a different question. */
const markedWaves = (): string[] =>
  waveEls()
    .filter((box) => headerPhrase(box.getAttribute("data-wave") ?? "").includes(MARKER))
    .map((box) => box.getAttribute("data-wave") ?? "");

const activeAttrWaves = (): string[] =>
  waveEls()
    .filter((box) => box.getAttribute("data-active") === "true")
    .map((box) => box.getAttribute("data-wave") ?? "");

/** The roll-up line (`N merged ✓ · awaiting the tag`), or null where the wave
 *  has nothing merged and the line is absent by AC5a. */
function rollupText(wave: string): string | null {
  const el = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-rollup"]');
  return el === null ? null : (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

const nodeCount = (wave: string): number =>
  waveEl(wave).querySelectorAll('[data-testid="roadmap-node"]').length;

// ── §S4 — one wave carries the marker ─────────────────────────────────────

describe("CR-CRU-116 §S4 — the `· active` marker belongs to ONE wave, not to the release", () => {
  test(
    "a proposed release holding TWO waves marks exactly ONE box: counted across both boxes, " +
      "the only marker is on wave 6, the wave holding the IN_PROGRESS cr",
    async () => {
      await mountApp();

      // The fixture really is §S4's case: one focused in-flight release, two
      // waves rendered, and exactly one cr mid-run — in wave 6.
      expect(flow().getAttribute("data-kind")).toBe("proposed");
      expect(flow().getAttribute("data-version")).toBe("0.6.0");
      expect(waveNames()).toEqual(["5", "6"]);
      const running = TWO_WAVE_BOARD.filter((entry) => entry.status === "IN_PROGRESS");
      expect(running.map((entry) => entry.cr)).toEqual([RUNNING_CR]);
      expect(running[0]!.wave).toBe("6");

      // AC1 — COUNTED, not inspected: the marker is on wave 6 and on no other
      // box. `toEqual` bounds it in both directions at once, so two markers
      // fail as loudly as none.
      expect(markedWaves()).toEqual(["6"]);
      // And wave 5 — complete, nothing running — says nothing anywhere in its
      // header about being active.
      expect(headerPhrase("5")).not.toContain(MARKER);
    },
  );

  test(
    "both header phrases read WHOLE in the SAME render: wave 5 reads `Wave 5` with no marker " +
      "while wave 6 reads `Wave 6 · active`",
    async () => {
      await mountApp();

      // One render, both boxes, each phrase asserted entire — an assertion
      // that a substring is missing cannot tell `Wave 5` from `Wave 5 · idle`.
      expect(headerPhrase("5")).toBe("Wave 5");
      expect(headerPhrase("6")).toBe(`Wave 6${MARKER}`);

      // The header's other published fact is untouched by the marker: each box
      // still states its OWN whole membership, not the release's 7.
      expect(countText("5")).toBe(String(WAVE_FIVE_SIZE));
      expect(countText("6")).toBe(String(WAVE_SIX_SIZE));
    },
  );

  test(
    "data-active publishes `false` on the wave with nothing running and `true` on the wave " +
      "holding the open work",
    async () => {
      await mountApp();

      expect(activeAttr("5")).toBe("false");
      expect(activeAttr("6")).toBe("true");
      // The attribute is bounded the same way the marker is: exactly one box
      // publishes `true`, so the attribute and the word cannot disagree about
      // how many waves are active.
      expect(activeAttrWaves()).toEqual(["6"]);
      expect(activeAttrWaves()).toEqual(markedWaves());
    },
  );

  test(
    "a proposed release holding two waves with NO work in flight renders ZERO markers, and the " +
      "boxes are otherwise intact — both present, counts, rows and roll-up unchanged",
    async () => {
      await mountApp({ queue: TWO_WAVE_BOARD_IDLE });

      // The branch the current comment calls "UNREACHABLE by construction":
      // an in-flight release whose waves hold no open work.
      expect(flow().getAttribute("data-kind")).toBe("proposed");
      expect(TWO_WAVE_BOARD_IDLE.some((entry) => entry.status === "IN_PROGRESS")).toBe(false);

      // The render is otherwise INTACT — asserted FIRST, deliberately. This
      // branch has never executed, so nothing about it is proven: the boxes,
      // their whole-membership counts, the rows they draw and the roll-up all
      // have to survive the missing marker. Asserting them ahead of the marker
      // means they are shown to hold TODAY, so when this test fails it fails
      // on the marker and on nothing else.
      expect(waveNames()).toEqual(["5", "6"]);
      expect(countText("5")).toBe(String(WAVE_FIVE_SIZE));
      expect(countText("6")).toBe(String(WAVE_SIX_SIZE));
      // Wave 5 is entirely merged: it draws no rows and states its merged work
      // as the roll-up line. Wave 6 has nothing merged, so AC5a's absence
      // holds and all three of its members are drawn.
      expect(nodeCount("5")).toBe(0);
      expect(rollupText("5")).toBe(`${WAVE_FIVE_SIZE} merged ✓ \u00b7 awaiting the tag`);
      expect(nodeCount("6")).toBe(WAVE_SIX_SIZE);
      expect(rollupText("6")).toBeNull();

      // §S4/AC2 — ZERO markers, on either channel, and that is NOT an error.
      expect(markedWaves()).toEqual([]);
      expect(activeAttrWaves()).toEqual([]);
      expect(activeAttr("5")).toBe("false");
      expect(activeAttr("6")).toBe("false");
      expect(headerPhrase("5")).toBe("Wave 5");
      expect(headerPhrase("6")).toBe("Wave 6");
    },
  );
});
