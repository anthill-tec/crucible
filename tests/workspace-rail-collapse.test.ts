// CR-CRU-093 §S1/§S2 — THE PROJECT RAIL COLLAPSES TO A SLIVER, AND THE
// CONTROL THAT COLLAPSES IT LIVES ON THE PANE.
//
// Spec: docs/changes/CR-CRU-093-project-rail-collapses.md
//       §S1 (the measured surface), §S2 (the affordance — on the pane itself)
//       AC2, AC9, AC10, AC12.
// Approved design: `.lavish/crucible-workflow-flowchart.html` §14 and §14.1 —
//       §14.1 is three CAPTURES of the running board, and it is where the
//       sliver (rather than a 0px column) was approved: "the pane becomes a
//       34px sliver carrying only the re-open button and a vertical
//       PROJECT · VITALS label".
//
// WHAT LIVES HERE AND WHAT DOES NOT — the split is deliberate and is the same
// one tests/roadmap-visual-grammar.test.ts already documents. happy-dom runs
// no layout engine, so AC1's "≥ 1.30× wider collapsed" and AC11's floor are
// asserted in headless Chromium (tests/roadmap-visual-grammar.test.ts,
// `CR-CRU-093 — the project rail collapses to a sliver`), where a real engine
// resolves a grid column. This file asserts what is true WITHOUT layout: the
// control's element type, its accessible name, its `aria-expanded`, where in
// the tree it sits, the words the sliver keeps, that the collapsed modifier
// COMPOSES with `greyed()`'s reactive binding, and that the roadmap's rendered
// content does not move when the rail does.
//
// AC10's KEYBOARD half is also asserted in Chromium, and deliberately not
// here: happy-dom does not synthesise a `click` from Enter/Space on a
// `<button>` (measured — a dispatched `keydown` produces zero clicks), so an
// Enter/Space assertion in this file would not be testing the platform's
// native button activation, it would be DEMANDING a redundant `onkeydown`
// handler that no browser needs. What this file asserts instead is the
// precondition that makes native activation true: the control is a real
// `<button>`, enabled, and not removed from the tab order.
//
// §S3 (state outside the render tree), §S4 (persistence), AC7's both-widths
// sweep and AC11 are NOT asserted here — later cycles own them.
//
// RED phase — expected to FAIL against current production, which renders NO
// collapse affordance at all: `ProjectPane` (public/app.js) is
// `data-testid="project-pane"`, `greyed("app-pane")`, a section title, the
// project card, the roadmap chip and `VitalsRail` — and `aria-expanded`
// appears ZERO times in the whole shell.
import { describe, test, expect, afterEach, setSystemTime, spyOn } from "bun:test";
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

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Synthetic ids throughout (CR-CRU-096 AC29): Crucible is project-independent,
// and a criterion that only holds while our own backlog has a given shape is
// not a criterion. One PROPOSED release in flight over two waves plus one
// shipped release, so AC12 has both a CR-row ORDER and a release MEMBERSHIP to
// compare across the collapse.

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

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: { id: number; label: string; status: string }[];
}

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

const WAVE_ONE: QueueFixture[] = [
  { cr: "CR-W1-01", title: "CR-W1-01 — synthetic wave-one member", wave: "1", dependsOn: [], status: "COMPLETED", seq: 10, release: "0.4.0" },
  { cr: "CR-W1-02", title: "CR-W1-02 — synthetic wave-one member", wave: "1", dependsOn: [], status: "IN_PROGRESS", planId: 41, seq: 20, release: "0.4.0" },
  { cr: "CR-W1-03", title: "CR-W1-03 — synthetic wave-one member", wave: "1", dependsOn: ["CR-W1-02"], status: "PENDING", seq: 30, release: "0.4.0" },
];

const WAVE_TWO: QueueFixture[] = [
  { cr: "CR-W2-01", title: "CR-W2-01 — synthetic wave-two member", wave: "2", dependsOn: [], status: "PENDING", seq: 500, release: "0.4.0" },
  { cr: "CR-W2-02", title: "CR-W2-02 — synthetic wave-two member", wave: "2", dependsOn: [], status: "PENDING", seq: 510, release: "0.4.0" },
];

const SHIPPED_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
];

const QUEUE: QueueFixture[] = [...SHIPPED_MEMBERS, ...WAVE_ONE, ...WAVE_TWO];

// ── Harness (tests/roadmap-wave-header.test.ts, verbatim) ───────────────────

interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  plans?: PlanFixture[];
  /** CR-CRU-093 §S4 — what the origin's web storage already holds when the
   *  shell boots. A re-registration hands happy-dom a FRESH window, so a
   *  reload is modelled by carrying the previous window's storage across
   *  (`reloadApp` below); tests/density.test.ts seeds `localStorage` the same
   *  way for the same reason. Both stores are carried because AC5 leaves the
   *  mechanism to the implementer — nothing here names a key. */
  storageSeed?: StorageSnapshot;
}

/** Every string the origin holds, per web storage. */
interface StorageSnapshot {
  local: Record<string, string>;
  session: Record<string, string>;
}

/** happy-dom runs no layout engine, so the release strip would measure a zero
 *  track and render a zero-gate window — and zone 2 reads its focus from the
 *  strip's own sequence. The box model is supplied exactly as the sibling
 *  suites supply it: wide enough that every fixture gate fits one window, so
 *  nothing here depends on paging. */
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

/** AC9's driver. The shell owns exactly ONE writer that can take
 *  `state.backendUp` DOWN — `watchdogTick`, which probes `/api/v2/health`
 *  after >20s of stream silence (public/app.js) — so the flip is driven by
 *  failing that probe, never by assigning the flag. */
let healthReachable = true;

let cacheBust = 0;

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const key = opts.key ?? "rail-collapse-key";
  healthReachable = true;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  // CR-CRU-093 §S4 — seeded BEFORE the shell is evaluated, because boot is
  // when a persisted preference is read (the density guard reads its key at
  // module top level, public/app.js).
  if (opts.storageSeed !== undefined) {
    for (const [k, v] of Object.entries(opts.storageSeed.local)) {
      window.localStorage.setItem(k, v);
    }
    for (const [k, v] of Object.entries(opts.storageSeed.session)) {
      window.sessionStorage.setItem(k, v);
    }
  }
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals` must not be swallowed by `/releases`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [PROPOSED_040];
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
      if (!healthReachable) throw new Error("health probe: connection refused");
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`workspace-rail-collapse.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workspaceRailCollapse=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production shell driving its
 *  own fetch chain and van.js's real reactive scheduler. */
async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

afterEach(async () => {
  setSystemTime(); // never leak an injected clock into another file
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const norm = (text: string | null): string => (text ?? "").replace(/\s+/g, " ").trim();

/** The accessible name, computed the two ways a `<button>` can carry one:
 *  an explicit `aria-label`, else its rendered text. Which of the two GREEN
 *  uses is GREEN's choice; the NAME is the contract. */
const accessibleName = (el: Element): string =>
  norm(el.getAttribute("aria-label") ?? el.textContent).toLowerCase();

const COLLAPSE_NAME = "collapse project rail";
const EXPAND_NAME = "expand project rail";

function pane(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="project-pane"]');
  if (el === null) throw new Error('no [data-testid="project-pane"] rendered');
  return el;
}

const namedControls = (name: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("button, [role=button], a, span, div")).filter(
    (el) => accessibleName(el) === name,
  );

/** The one control, whichever state it is in. Throws with the absent name
 *  spelled out, so a RED run reads as "the affordance does not exist" and
 *  never as a selector typo. */
function railToggle(): HTMLElement {
  const found = [...namedControls(COLLAPSE_NAME), ...namedControls(EXPAND_NAME)];
  if (found.length !== 1) {
    throw new Error(
      `expected exactly ONE control named "${COLLAPSE_NAME}" or "${EXPAND_NAME}" in the ` +
        `shell (CR-CRU-093 §S2); found ${found.length}. The project pane renders: ` +
        Array.from(pane().querySelectorAll("button"))
          .map((b) => `"${accessibleName(b)}"`)
          .join(", "),
    );
  }
  return found[0] as HTMLElement;
}

async function toggleRail(): Promise<void> {
  railToggle().click();
  await settle();
}

const classTokens = (el: Element): string[] =>
  norm(el.getAttribute("class"))
    .split(" ")
    .filter((token) => token !== "");

const ariaExpanded = (): string | null => railToggle().getAttribute("aria-expanded");

/** AC12's subject — zone 3's CR rows, in the order they are drawn. */
const crRowOrder = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="roadmap-row"]')).map(
    (row) => row.getAttribute("data-cr") ?? "",
  );

/** AC12's other subject — RELEASE MEMBERSHIP as the view publishes it: the
 *  focused release's wave boxes, each with the CRs drawn inside it. */
const releaseMembership = (): string[][] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="roadmap-wave"]')).map((box) => [
    box.getAttribute("data-wave") ?? "",
    ...Array.from(box.querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]')).map(
      (node) => node.getAttribute("data-cr") ?? "",
    ),
  ]);

/**
 * AC9 — take the backend DOWN the way the shell does. `watchdogTick` only
 * probes `/api/v2/health` once the stream has been silent for >20s, and only a
 * FAILING probe flips the pill (public/app.js), so the clock is moved past that
 * window and the probe is made unreachable; the watchdog's own 5s interval then
 * runs on real timers. Nothing here assigns `state.backendUp` — an assignment
 * would prove that an assignment works, not that the shell's liveness path
 * reaches the rail's class binding.
 */
async function driveBackendDown(): Promise<void> {
  healthReachable = false;
  try {
    setSystemTime(new Date(Date.now() + 60_000));
    await sleep(6_000); // the watchdog ticks every 5s
    await settle();
  } finally {
    setSystemTime();
  }
}

// ── §S2 — the affordance, on the pane ──────────────────────────────────────

describe("the project rail's collapse control", () => {
  test("is a real <button> the keyboard can reach, not a click-only span", async () => {
    await mountApp();

    const control = railToggle();

    // AC10 — a `<button>`. The shell's existing lens/cycle expanders are
    // click-only `span`s (public/styles.css), which is exactly what this
    // control may not be: only a real button is focusable and activatable by
    // Enter/Space without a hand-written key handler.
    expect(control.tagName).toBe("BUTTON");
    expect((control as HTMLButtonElement).disabled).toBe(false);
    expect(control.getAttribute("aria-hidden")).toBeNull();
    // Not removed from the tab order: absent `tabindex` is fine (a button is
    // natively focusable), a NEGATIVE one is not.
    expect(Number(control.getAttribute("tabindex") ?? "0")).toBeGreaterThanOrEqual(0);
  });

  test("lives on the project pane and never inside the view column", async () => {
    await mountApp();

    const control = railToggle();

    // §S2 — the control lives ON THE PANE, beside the section title that
    // already heads it, so the collapsed sliver keeps it on screen.
    expect(pane().contains(control)).toBe(true);

    // AC12 — and it is not part of the view column's DOM.
    const centers = Array.from(document.querySelectorAll<HTMLElement>(".app-center"));
    expect(centers.length).toBeGreaterThan(0);
    expect(centers.some((center) => center.contains(control))).toBe(false);
  });

  test("names itself collapse while expanded and expand while collapsed, with aria-expanded tracking every step", async () => {
    await mountApp();

    // AC10 — this is the shell's FIRST `aria-expanded`; `grep` returns zero
    // occurrences in public/app.js today.
    expect(accessibleName(railToggle())).toBe(COLLAPSE_NAME);
    expect(ariaExpanded()).toBe("true");

    await toggleRail();
    expect(accessibleName(railToggle())).toBe(EXPAND_NAME);
    expect(ariaExpanded()).toBe("false");

    // AC2 — and the collapsed rail is re-openable from that same control.
    await toggleRail();
    expect(accessibleName(railToggle())).toBe(COLLAPSE_NAME);
    expect(ariaExpanded()).toBe("true");
  });

  test("collapsed, the sliver still says in words what it holds", async () => {
    await mountApp();
    await toggleRail();

    // §S2 / design §14.1 — "the pane becomes a 34px sliver carrying only the
    // re-open button and a vertical PROJECT · VITALS label". The words are
    // the requirement: a glyph-only sliver fails.
    expect(norm(pane().textContent).toLowerCase()).toContain("project · vitals");
  });

  test("the collapsed modifier composes with greyed() rather than replacing it", async () => {
    await mountApp();

    const expandedTokens = classTokens(pane());
    expect(expandedTokens).toContain("app-pane");
    expect(expandedTokens).not.toContain("greyed");

    await toggleRail();
    const collapsedTokens = classTokens(pane());
    const modifier = collapsedTokens.filter((token) => !expandedTokens.includes(token));
    // The collapsed state is carried on the rail's OWN class binding — GREEN
    // names the token, this reads whichever token it chose.
    expect(modifier.length).toBeGreaterThan(0);

    // AC9 — now flip liveness through the shell's own watchdog. `greyed()` is
    // a reactive closure (`() => state.backendUp ? cls : cls + " greyed"`), so
    // a modifier written imperatively onto `classList` is wiped right here.
    await driveBackendDown();

    const downTokens = classTokens(pane());
    expect(downTokens).toContain("app-pane");
    expect(downTokens).toContain("greyed");
    for (const token of modifier) expect(downTokens).toContain(token);

    // …and it is still collapsed: the liveness flip is not a re-expand.
    expect(accessibleName(railToggle())).toBe(EXPAND_NAME);
    expect(ariaExpanded()).toBe("false");
  }, 30_000);

  test("the roadmap draws the identical CR rows, order and release membership with the rail collapsed", async () => {
    await mountApp();

    const rowsExpanded = crRowOrder();
    const membershipExpanded = releaseMembership();
    // Non-vacuity: a board that drew nothing would compare equal to itself.
    expect(rowsExpanded).toEqual(["CR-W1-01", "CR-W1-02", "CR-W1-03", "CR-W2-01", "CR-W2-02"]);
    // Wave 1 draws two of its three: CR-CRU-096's trim rolls the MERGED
    // `CR-W1-01` into the wave header rather than drawing it a node. That is
    // the shipped content, and AC12's demand is that the collapse does not
    // move it.
    expect(membershipExpanded).toEqual([
      ["1", "CR-W1-02", "CR-W1-03"],
      ["2", "CR-W2-01", "CR-W2-02"],
    ]);

    await toggleRail();

    // AC12 — shell chrome only. The release strip's gate WINDOW is carved out
    // (it is measured, and CR-CRU-078 already ships the re-measure), so it is
    // deliberately not read here: the CR rows, their order and their release
    // membership are.
    expect(crRowOrder()).toEqual(rowsExpanded);
    expect(releaseMembership()).toEqual(membershipExpanded);
  });
});

// ── §S3 — the state lives OUTSIDE the render tree ──────────────────────────
//
// Spec: docs/changes/CR-CRU-093-project-rail-collapses.md §S3, §S4 —
//       AC3 (survives a poll tick), AC4 (survives navigation),
//       AC5 (survives reload), AC6 (an uninterpretable stored value boots
//       expanded), AC8 (toggling does not remount the pane).
//
// WHY THESE LIVE HERE AND NOT IN CHROMIUM. Every claim below is about STATE
// and STORAGE, not geometry: "still collapsed after a poll frame", "still
// collapsed on the Workflow tab", "the same element node", "boots expanded
// from a corrupt string". A layout engine decides none of them, and each is
// decidable from the rendered DOM — the control's accessible name, its
// `aria-expanded`, and element identity. AC5's FIRST-PAINT half is the one
// clause that needs a real engine (there is no paint to be early to without
// one), and it is asserted in tests/roadmap-visual-grammar.test.ts.
//
// RED phase — §S4 does not exist: `grep localStorage public/app.js` returns
// only the density preference, and the rail's flag (`railCollapsed`,
// public/app.js) is initialised to `false` on every boot with nothing read and
// nothing written. AC5 and AC6 therefore fail on the ABSENCE of persistence.

/** Every string the origin currently holds. A happy-dom re-registration hands
 *  the shell a brand-new window (and so a brand-new, empty storage), which is
 *  exactly why a "reload" has to carry this across. */
function snapshotStorage(): StorageSnapshot {
  const dump = (store: Storage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null) out[k] = store.getItem(k) ?? "";
    }
    return out;
  };
  return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
}

/** THE RELOAD. The app is torn down and re-mounted from source with the
 *  origin's storage carried across — which is what a browser reload is. The
 *  assertions that follow read the RENDERED state, never a key, because AC5
 *  was reworded on 2026-09-03 precisely so the mechanism stays GREEN's
 *  choice. */
async function reloadApp(opts: MountOpts = {}): Promise<void> {
  const carried = snapshotStorage();
  await mountApp({ ...opts, storageSeed: carried });
}

/** The keys whose value the collapse ITSELF wrote — the implementation's own
 *  persistence handle, discovered rather than invented (AC6 has to corrupt
 *  whatever GREEN chose, and AC5 forbids this file from naming it). */
function writtenKeys(before: StorageSnapshot, after: StorageSnapshot): StorageSnapshot {
  const changed = (
    was: Record<string, string>,
    now: Record<string, string>,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(now)) if (was[k] !== v) out[k] = v;
    return out;
  };
  return { local: changed(before.local, after.local), session: changed(before.session, after.session) };
}

const keyCount = (snap: StorageSnapshot): number =>
  Object.keys(snap.local).length + Object.keys(snap.session).length;

/** The same keys, every one of them holding `value` — the seed AC6 boots
 *  from. */
const seededWith = (keys: StorageSnapshot, value: string): StorageSnapshot => ({
  local: Object.fromEntries(Object.keys(keys.local).map((k) => [k, value])),
  session: Object.fromEntries(Object.keys(keys.session).map((k) => [k, value])),
});

/** The workspace's ONE active pane scroller (public/app.js `activePaneEl`:
 *  "exactly one pane-scroll renders per route"). */
function paneScroll(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="pane-scroll"]');
  if (el === null) throw new Error('no [data-testid="pane-scroll"] rendered');
  return el;
}

/** Click a tab in the shell's own strip, by the name it draws. */
async function switchTab(name: string): Promise<void> {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-tab"]'),
  );
  const tab = tabs.find((button) => norm(button.textContent) === name);
  if (tab === undefined) {
    throw new Error(
      `no workspace tab named "${name}"; the strip draws ` +
        tabs.map((b) => `"${norm(b.textContent)}"`).join(", "),
    );
  }
  if (tab.disabled) throw new Error(`the "${name}" tab is disabled in this fixture`);
  tab.click();
  await settle();
}

/** Open the run detail through the shell's OWN entry point for it — a
 *  Back/Forward landing on `/p/<key>/run/<id>`, which public/app.js's popstate
 *  listener parses and turns into `state.route.overlay` (the same route
 *  `navigate()` builds when a run row is clicked). Nothing here assigns the
 *  route. */
async function openRunDetail(key: string, eventId: string): Promise<void> {
  history.pushState(null, "", `/p/${key}/run/${eventId}`);
  window.dispatchEvent(new Event("popstate"));
  await settle();
}

/** Close it the way a user does — Escape, which the shell binds to
 *  `closeDetail()` (public/app.js). */
async function closeRunDetail(): Promise<void> {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
}

/** The rail's state as the SHELL publishes it: the control's accessible name
 *  and `aria-expanded`. Mechanism-free — no class token, no storage key. */
function expectRailCollapsed(where: string): void {
  expect(`${where}: ${accessibleName(railToggle())}`).toBe(`${where}: ${EXPAND_NAME}`);
  expect(`${where}: ${ariaExpanded()}`).toBe(`${where}: false`);
}

function expectRailExpanded(where: string): void {
  expect(`${where}: ${accessibleName(railToggle())}`).toBe(`${where}: ${COLLAPSE_NAME}`);
  expect(`${where}: ${ariaExpanded()}`).toBe(`${where}: true`);
}

describe("the rail's collapsed state, outside the render tree", () => {
  test("survives a poll tick that delivers a data frame", async () => {
    await mountApp();
    await toggleRail();
    expectRailCollapsed("collapsed");

    // Count the frames the SHELL fetches, so "a poll tick elapsed" is a fact
    // and not an assumption about timers.
    const fetched: string[] = [];
    const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
    const inner = scriptedGlobals.fetch;
    scriptedGlobals.fetch = ((url: string, init?: RequestInit) => {
      fetched.push(String(url));
      return inner(url as unknown as RequestInfo, init);
    }) as unknown as typeof fetch;

    // AC3 — one FULL poll interval: the shell polls on `setInterval(refetch,
    // 5000)` (public/app.js; a bare literal, there is no POLL_MS constant).
    // Real timers, driven by the shell's own interval — nothing here calls
    // `refetch` directly, because the bug being designed out is precisely that
    // the shell's own re-render re-expands the rail.
    await sleep(6_000);
    await settle();

    // The frame really was delivered: the poll refetched the project slice.
    expect(fetched.some((url) => url.includes("/api/v2/projects"))).toBe(true);

    // AC3 — still collapsed. A mount-local flag fails right here.
    expectRailCollapsed("after one poll frame");
  }, 30_000);

  test("survives switching tabs and opening and closing a run detail", async () => {
    await mountApp();
    // The workspace lands on the Roadmap route (mountApp's url), so this
    // collapse happens on ONE tab and every later reading is on another.
    await toggleRail();
    expectRailCollapsed("Roadmap");

    // AC4 — the pane is a single instance shared by every tab (§S1), so the
    // state is workspace-global.
    await switchTab("Runs");
    expect(document.querySelector('[data-testid="workspace-runs"]')).not.toBeNull();
    expectRailCollapsed("Runs");

    await switchTab("Workflow");
    expectRailCollapsed("Workflow");

    await openRunDetail("rail-collapse-key", "evt-rail-1");
    // Non-vacuity: the detail really did open, so "still collapsed" is a
    // reading taken over a detail and not over the same feed twice.
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
    expectRailCollapsed("run detail open");

    await closeRunDetail();
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
    expectRailCollapsed("run detail closed");
  }, 30_000);

  test("survives a reload, in both directions", async () => {
    await mountApp();
    expectRailExpanded("first boot");

    await toggleRail();
    expectRailCollapsed("collapsed");

    // AC5 — the reload. Asserted on the RENDERED state (the control's own
    // name and `aria-expanded`), never on a storage key: the key, the value
    // set and the store are GREEN's to choose.
    await reloadApp();
    expectRailCollapsed("after reload");

    // …and the other direction, so a hardcoded "always boot collapsed" is not
    // a passing implementation either.
    await toggleRail();
    expectRailExpanded("expanded");
    await reloadApp();
    expectRailExpanded("after second reload");
  }, 30_000);

  test("boots EXPANDED from a stored value it cannot interpret, without throwing and without console.error", async () => {
    // Discover the handle rather than inventing one: collapse once and read
    // what the collapse itself wrote. AC5 forbids this file from naming a key,
    // and AC6 has to corrupt whatever GREEN actually chose.
    await mountApp();
    const clean = snapshotStorage();
    await toggleRail();
    const written = writtenKeys(clean, snapshotStorage());
    if (keyCount(written) === 0) {
      throw new Error(
        "CR-CRU-093 §S4/AC6: collapsing the rail wrote NOTHING to localStorage or " +
          "sessionStorage, so there is no stored value to make uninterpretable — the " +
          "persistence AC5 requires does not exist yet (public/app.js reads and writes " +
          "the rail's flag nowhere; `railCollapsed` is re-initialised to false on every " +
          "boot). Follow DENSITY_STORAGE_KEY + DENSITY_MODES.includes(...).",
      );
    }

    // Every shape a stored preference can arrive in and still mean nothing:
    // corrupt, empty, whitespace, wrongly-typed (a JSON object, and a bare
    // boolean — storage holds strings), and wrongly-cased.
    const uninterpretable = ["\u0000\u0001garbage", "", "   ", '{"collapsed":true}', "true", "COLLAPSED", "Collapsed"];
    for (const value of uninterpretable) {
      const errors = spyOn(console, "error");
      try {
        // A throw during boot fails the test here, which is AC6's "without
        // throwing" half — the shell never gets to render.
        await mountApp({ storageSeed: seededWith(written, value) });
        expectRailExpanded(`stored ${JSON.stringify(value)}`);
        expect({ value, consoleErrors: errors.mock.calls.map((call) => String(call[0])) }).toEqual({
          value,
          consoleErrors: [],
        });
      } finally {
        errors.mockRestore();
      }
    }

    // …and ABSENT: nothing stored at all boots expanded too.
    const errors = spyOn(console, "error");
    try {
      await mountApp({ storageSeed: { local: {}, session: {} } });
      expectRailExpanded("nothing stored");
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  test("collapsing and re-expanding never remounts the active pane or moves its reading position", async () => {
    await mountApp();

    const before = paneScroll();
    // CR-CRU-016's contract is about a READING POSITION, so give it one: at
    // scrollTop 0 a remounted pane would compare equal to a kept one.
    before.scrollTop = 137;
    expect(before.scrollTop).toBe(137);

    await toggleRail();
    // AC8 — the SAME element node (identity, not equality). A binding that
    // re-renders the body on a rail flip rebuilds this box and loses the
    // position.
    expect(paneScroll()).toBe(before);
    expect(paneScroll().scrollTop).toBe(137);

    await toggleRail();
    expect(paneScroll()).toBe(before);
    expect(paneScroll().scrollTop).toBe(137);
  }, 30_000);
});
