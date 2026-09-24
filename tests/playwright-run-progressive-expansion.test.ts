// CR-CRU-145 §S1 — ONE renderer: the run detail, opened as a specification
// for BDD (`codec: "playwright"`) runs.
//
// MEASURED ON THIS BRANCH (158ec48, before this CR's GREEN): `RunDetailBody`
// (public/app.js ~L5953) fetches `?depth=suites` and then auto-expands
// NOTHING — CR-CRU-038 §S1 retired auto-expand entirely, so every suite
// (failing or not, whatever the codec) renders collapsed (▸) until an
// explicit `suite-row` click. There is no feature-grouping concept at all in
// the drill-in (a playwright scenario's `name` is "<Feature> › <Scenario>",
// but nothing splits it), no `stack ▸` disclosure (a stored trace renders
// unconditionally inline via `.app-failure-trace` when a leaf's failure box
// is open), and no byline (`DetailHeadContent` renders only
// "Run detail · <eventId>"). Every test below is RED against that baseline
// until GREEN implements §S1.
//
// HARNESS — the house idiom (tests/drill-in.test.ts's `mountApp`, reused
// near-verbatim): real VanJS/VanX vendor bundles, the real
// public/app-logic.mjs and the real public/app.js inside a happy-dom window,
// `fetch` scripted to serve the SAME progressive `?depth=suites` / `?suite=`
// contract the real server implements (tests/v2-stream-paging.test.ts).
//
// TWO DESIGN CHOICES THE AC DOES NOT SETTLE — declared here, same house
// precedent as tests/bdd-section.test.ts's "WHERE in the pane… NOT
// asserted" note:
//   • "the first scenarios of the first feature" (plural, no count given).
//     Read at its SMALLEST defensible width: the literal FIRST scenario is
//     asserted expanded; a LATER scenario of the SAME first feature is
//     asserted still folded on open. A GREEN that expands more than one is
//     not contradicted by that bound (it only fails if NOTHING beyond the
//     first is ever expandable), but this file does not require it.
//   • "loads its steps as it scrolls into view" cannot be driven by REAL
//     layout — happy-dom computes no geometry, so `offsetTop`/
//     `getBoundingClientRect` are 0 for every node (the reason the
//     production virtualizer at `handlePaneScroll` already keys off
//     `pane.scrollTop` alone, not real element positions). These tests
//     therefore drive the SAME mechanism the codebase already exposes for
//     this purpose: a `scroll` event dispatched at a large `.scrollTop` on
//     the run detail's OWN `[data-testid="pane-scroll"]` box (the exact
//     technique tests/inpane-drill-in.test.ts's header-stability tests and
//     tests/density.test.ts's virtualization tests already use). A test
//     that needs IntersectionObserver instead is not written here — nothing
//     in this codebase's history uses it, and happy-dom's own intersection
//     reporting cannot be trusted either.
//   • "green features fold" — AMENDED 2026-09-24 by orchestrator ruling
//     (was: suite-row granularity, no feature heading; F11 is the approved
//     visual contract and B draws a FEATURE level, so that reading let an
//     implementation pass without the structure F11 approved). The
//     corrected contract has its OWN describe block below ("F11 draws a
//     FEATURE level"), with its testids declared there.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { relativeTime } from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
const APP_JS_PATH = path.join(REPO_ROOT, "public/app.js");

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: { message: string; trace?: string };
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec: string;
  timestamp: number;
  context?: { cycle?: string; cycleId?: number };
  tree: SuiteFixture[];
}

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

function summarize(tree: SuiteFixture[]) {
  const s = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 };
  for (const suite of tree) {
    for (const leaf of suite.children) {
      s.total += 1;
      if (leaf.status === "pass") s.passed += 1;
      else if (leaf.status === "fail") s.failed += 1;
      else s.pending += 1;
      s.duration_ms += leaf.duration_ms;
    }
  }
  return s;
}

interface MountOpts {
  pathname: string;
  projectKey?: string;
  events: EventDetailFixture[];
}

let cacheBust = 0;
let fetchLog: string[] = [];

/** Same mountApp harness pattern as tests/drill-in.test.ts, trimmed to what
 *  §S1's run-detail assertions need: a fixed set of full event details
 *  (briefs are derived, never authored twice). */
async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${opts.pathname}` });
  document.body.innerHTML = '<div id="app"></div>';
  fetchLog = [];

  const byId = new Map(opts.events.map((e) => [e.id, e]));
  const projectKey = opts.projectKey ?? "proj-s1-run-detail";

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = byId.get(id);
      if (detail === undefined) {
        throw new Error(`playwright-run-progressive-expansion.test.ts: no fixture for event ${id}`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = detail.tree.find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = detail.tree.map((n) => ({ name: n.name, status: n.status, counts: suiteCounts(n.children) }));
        body = { ok: true, event: { ...detail, summary: summarize(detail.tree), tree } };
      } else {
        body = { ok: true, event: { ...detail, summary: summarize(detail.tree) } };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = {
        ok: true,
        projects: [{ key: projectKey, name: "S1 Run Detail", type: "frontend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() }],
      };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = {
        ok: true,
        events: opts.events.map((e) => ({
          id: e.id,
          projectKey: e.projectKey,
          agentId: e.agentId,
          kind: e.kind,
          tier: e.tier,
          codec: e.codec,
          timestamp: e.timestamp,
          context: e.context,
          ...summarize(e.tree),
          hasCoverage: false,
        })),
      };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`playwright-run-progressive-expansion.test.ts: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?s1RunDetail=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error("no [data-testid=\"run-overlay\"] mounted");
  return el;
}

function suiteRow(name: string): HTMLElement {
  const found = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).find((el) =>
    (el.textContent ?? "").includes(name),
  );
  if (found === undefined) {
    const seen = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).map((el) =>
      (el.textContent ?? "").trim(),
    );
    throw new Error(`no suite-row contains "${name}"; rows present: ${JSON.stringify(seen)}`);
  }
  return found;
}

function isExpanded(row: HTMLElement): boolean {
  return row.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim() === "▾";
}

function leafRowsOf(suiteName: string): HTMLElement[] {
  const row = suiteRow(suiteName);
  const group = row.parentElement;
  return Array.from(group?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

function paneScrollEl(): HTMLElement {
  const el = overlay().querySelector<HTMLElement>('[data-testid="pane-scroll"]');
  if (el === null) throw new Error("no [data-testid=\"pane-scroll\"] inside the run-overlay");
  return el;
}

/** Simulates "scrolled deep into the pane" the only way happy-dom's lack of
 *  real layout permits — see the file header's declared design choice. */
async function scrollDeep(): Promise<void> {
  const pane = paneScrollEl();
  pane.scrollTop = 100_000;
  pane.dispatchEvent(new Event("scroll"));
  await settle();
}

// ── Fixture: 3 features, 7 scenarios, shaped to separate the progressive-
// expansion rules from one another. AMENDED 2026-09-24 by orchestrator ruling
// (F11's reading wins): features are ordered failures-first, and the FIRST
// feature in THAT order is the one whose first scenarios open. So the failing
// feature (Gamma, listed LAST in the report) floats to the top and opens; its
// report-first green scenario opens with it; a later one of its scenarios has a
// row but stays folded until it scrolls into view; and the all-green features
// (Alpha, listed FIRST in the report, and Beta) fold at the FEATURE level —
// zero scenario rows until clicked. The all-green-run branch of the rule (no
// failing feature, so the report-first feature opens) is pinned by its own
// test below.
const GIVEN = (n: number) => ({ name: `Given step ${n}`, status: "pass" as const, duration_ms: 2 });
const THEN_PASS = (n: number) => ({ name: `Then step ${n} passes`, status: "pass" as const, duration_ms: 2 });
const THEN_FAIL = { name: "Then it breaks", status: "fail" as const, duration_ms: 3, failure: { message: "expected pane scrollTop > 0, got 0", trace: "Error: expected pane scrollTop > 0, got 0\n    at run-detail.spec.ts:14:3" } };

const ALPHA_A_NAME = "Alpha Feature › listed first in the report, but all green";
const ALPHA_B_NAME = "Alpha Feature › its second green scenario";
const BETA_NAME = "Beta Feature › an all-green feature folds entirely";
const GAMMA_FIRST_NAME = "Gamma Feature › the failing feature's first scenario opens";
const S4_NAME = "Gamma Feature › a failing scenario auto-expands anywhere";
const GAMMA_MID_NAME = "Gamma Feature › a middle scenario";
const GAMMA_LATE_NAME = "Gamma Feature › a later scenario loads as it scrolls into view";

function progressiveTree(): SuiteFixture[] {
  return [
    { name: ALPHA_A_NAME, status: "pass", children: [GIVEN(1), THEN_PASS(1)] },
    { name: ALPHA_B_NAME, status: "pass", children: [GIVEN(2), THEN_PASS(2)] },
    { name: BETA_NAME, status: "pass", children: [GIVEN(3), THEN_PASS(3)] },
    { name: GAMMA_FIRST_NAME, status: "pass", children: [GIVEN(5), THEN_PASS(5)] },
    { name: S4_NAME, status: "fail", children: [GIVEN(4), THEN_FAIL] },
    { name: GAMMA_MID_NAME, status: "pass", children: [GIVEN(6), THEN_PASS(6)] },
    { name: GAMMA_LATE_NAME, status: "pass", children: [GIVEN(7), THEN_PASS(7)] },
  ];
}

function suiteRead(name: string): boolean {
  return fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(name)}`));
}

/** A feature-group's heading reads ▾ and it holds scenario rows — or ▸ and
 *  it holds NONE (folded at the feature level). */
function featureOf(title: string): HTMLElement {
  const found = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]')).find(
    (el) => el.getAttribute("data-feature-name") === title,
  );
  if (found === undefined) throw new Error(`no feature-group named "${title}"`);
  return found;
}

function featureFolded(title: string): boolean {
  const group = featureOf(title);
  return (
    group.querySelector('[data-testid="feature-toggle"]')?.textContent?.trim() === "▸" &&
    group.querySelectorAll('[data-testid="suite-row"]').length === 0
  );
}

function playwrightEvent(id: string, opts: Partial<EventDetailFixture> = {}): EventDetailFixture {
  return {
    id,
    projectKey: "proj-s1-run-detail",
    agentId: "s1-run-detail-agent",
    kind: "test",
    tier: "e2e",
    codec: "playwright",
    timestamp: Date.now(),
    tree: progressiveTree(),
    ...opts,
  };
}

describe("CR-CRU-145 §S1 — a playwright run's detail opens PROGRESSIVELY EXPANDED", () => {
  test("on open: the failing feature floats first and opens — its failing scenario AND its first scenario show their steps without a click, a later scenario of it has a row but stays folded — and every all-green feature (even the report-first one) folds at the FEATURE level", async () => {
    const eventId = "evt-s1-progressive";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // POSITIVE — the failing scenario is expanded on open, with no click,
    // its steps rendered.
    expect(isExpanded(suiteRow(S4_NAME))).toBe(true);
    expect(leafRowsOf(S4_NAME).some((r) => (r.textContent ?? "").includes("Then it breaks"))).toBe(true);

    // POSITIVE — the failing feature is the FIRST feature in failures-first
    // order, so its first scenario (report-first within it, and green) ALSO
    // shows its steps on open.
    expect(isExpanded(suiteRow(GAMMA_FIRST_NAME))).toBe(true);
    expect(leafRowsOf(GAMMA_FIRST_NAME).length).toBe(2);

    // BOUND — a LATER scenario of that same first feature has its row but is
    // not auto-expanded: "the first scenarios" is not "every scenario".
    expect(isExpanded(suiteRow(GAMMA_LATE_NAME))).toBe(false);
    expect(leafRowsOf(GAMMA_LATE_NAME).length).toBe(0);

    // BOUND — every all-green feature folds whole at the feature level, the
    // report-first one (Alpha) included: zero scenario rows until clicked.
    expect(featureFolded("Alpha Feature")).toBe(true);
    expect(featureFolded("Beta Feature")).toBe(true);
  });

  test("a long run issues NO per-suite read for a scenario that has not scrolled into view — asserted on the requests made, not on timing", async () => {
    const eventId = "evt-s1-no-eager-fetch";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // The never-expanded scenarios' names never reach a `?suite=` read: the
    // folded later scenario of the open feature, and every scenario of the
    // folded all-green features.
    expect(suiteRead(GAMMA_LATE_NAME)).toBe(false);
    expect(suiteRead(ALPHA_A_NAME)).toBe(false);
    expect(suiteRead(ALPHA_B_NAME)).toBe(false);
    expect(suiteRead(BETA_NAME)).toBe(false);

    // …while the auto-expanded ones legitimately were read — the absence
    // above is a real signal, not a fetch mock that never fires.
    expect(suiteRead(S4_NAME)).toBe(true);
    expect(suiteRead(GAMMA_FIRST_NAME)).toBe(true);
  });

  test("scrolling deep into the pane loads and shows a previously-folded scenario's steps, with no click", async () => {
    const eventId = "evt-s1-scroll-loads";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // PRECONDITION — the open feature's later scenario is folded and unread.
    expect(isExpanded(suiteRow(GAMMA_LATE_NAME))).toBe(false);
    expect(suiteRead(GAMMA_LATE_NAME)).toBe(false);

    await scrollDeep();

    // POSITIVE — it is now expanded, its steps rendered, and the read that
    // produced them is in the log — WITHOUT a suite-row click anywhere in
    // this test.
    expect(suiteRead(GAMMA_LATE_NAME)).toBe(true);
    expect(isExpanded(suiteRow(GAMMA_LATE_NAME))).toBe(true);
    expect(leafRowsOf(GAMMA_LATE_NAME).map((r) => (r.textContent ?? "").includes("Given step 7"))).toContain(true);

    // BOUND — a feature folded at the feature level has no rows to scroll
    // into view, so scrolling reads none of its scenarios.
    expect(suiteRead(ALPHA_A_NAME)).toBe(false);
    expect(suiteRead(BETA_NAME)).toBe(false);
  });

  test("an ALL-GREEN run has no failing feature, so the REPORT-first feature opens: its first scenario shows its steps, a later one of it stays folded, and every other feature folds", async () => {
    const eventId = "evt-s1-all-green";
    const greenTree: SuiteFixture[] = [
      { name: "Delta Feature › its first scenario opens", status: "pass", children: [GIVEN(11), THEN_PASS(11)] },
      { name: "Delta Feature › its second scenario", status: "pass", children: [GIVEN(12), THEN_PASS(12)] },
      { name: "Delta Feature › its third scenario stays folded", status: "pass", children: [GIVEN(13), THEN_PASS(13)] },
      { name: "Epsilon Feature › a later all-green feature folds", status: "pass", children: [GIVEN(14), THEN_PASS(14)] },
    ];
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: greenTree })] });

    // POSITIVE — the report-first feature opens, and its first scenario
    // shows its steps without a click.
    expect(featureFolded("Delta Feature")).toBe(false);
    expect(isExpanded(suiteRow("Delta Feature › its first scenario opens"))).toBe(true);
    expect(leafRowsOf("Delta Feature › its first scenario opens").length).toBe(2);

    // BOUND — a later scenario of it has a row but stays folded and unread.
    expect(isExpanded(suiteRow("Delta Feature › its third scenario stays folded"))).toBe(false);
    expect(suiteRead("Delta Feature › its third scenario stays folded")).toBe(false);

    // BOUND — every other feature folds at the feature level, unread.
    expect(featureFolded("Epsilon Feature")).toBe(true);
    expect(suiteRead("Epsilon Feature › a later all-green feature folds")).toBe(false);
  });
});

describe("CR-CRU-145 §S1 — a failing step's message sits AT that step, with a stack ▸ disclosure", () => {
  test("the failing step's leaf row carries its message inline, and a 'stack ▸' control reveals the stored stack on click — with NO trace ↗ / trace.zip anywhere", async () => {
    const eventId = "evt-s1-stack-disclosure";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    const failingLeaf = leafRowsOf(S4_NAME).find((r) => (r.textContent ?? "").includes("Then it breaks"));
    expect(failingLeaf).toBeDefined();

    // POSITIVE — the failure message sits AT the failing step (inside its
    // own leaf row's subtree), not in some run-level footer.
    expect((failingLeaf!.textContent ?? "")).toContain("expected pane scrollTop > 0, got 0");

    // POSITIVE — a 'stack ▸' disclosure exists at that step and is closed
    // by default; clicking it reveals the stored stack text.
    const toggle = failingLeaf!.querySelector<HTMLElement>('[data-testid="stack-toggle"]');
    expect(toggle).not.toBeNull();
    expect((toggle!.textContent ?? "").trim()).toBe("stack ▸");
    expect(failingLeaf!.querySelector('[data-testid="stack-trace"]')).toBeNull();

    toggle!.click();
    await settle();

    const revealed = overlay().querySelector('[data-testid="stack-trace"]');
    expect(revealed).not.toBeNull();
    expect((revealed!.textContent ?? "")).toContain("at run-detail.spec.ts:14:3");

    // NEGATIVE — §S3's named gap: no `trace ↗` link, and no reference to
    // trace.zip, anywhere in the whole overlay.
    expect(overlay().textContent ?? "").not.toContain("trace ↗");
    expect(overlay().textContent ?? "").not.toContain("trace.zip");
    expect(overlay().querySelectorAll('a[href*="trace.zip"]').length).toBe(0);
  });
});

describe("CR-CRU-145 §S1 — every OTHER codec's run detail is UNCHANGED", () => {
  test("a junit unit run still opens MINIMIZED — no suite auto-expanded, same as before this CR", async () => {
    const eventId = "evt-s1-junit-unchanged";
    const junitTree: SuiteFixture[] = [
      { name: "SomeSuite", status: "fail", children: [{ name: "a failing case", status: "fail", duration_ms: 1, failure: { message: "boom" } }] },
      { name: "OtherSuite", status: "pass", children: [{ name: "a passing case", status: "pass", duration_ms: 1 }] },
    ];
    await mountApp({
      pathname: `/run/${eventId}`,
      events: [
        {
          id: eventId,
          projectKey: "proj-s1-run-detail",
          agentId: "junit-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: Date.now(),
          tree: junitTree,
        },
      ],
    });

    // BOUND — even the FAILING junit suite stays collapsed on open: §S1's
    // progressive-expansion default is scoped to `codec: "playwright"`
    // alone, so a non-playwright run must show the SAME minimized default
    // CR-CRU-038 shipped.
    expect(isExpanded(suiteRow("SomeSuite"))).toBe(false);
    expect(leafRowsOf("SomeSuite").length).toBe(0);
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent("SomeSuite")}`))).toBe(false);
  });
});

describe("CR-CRU-145 §S1 — the drill-in's existing frame is REUSED, not re-implemented", () => {
  test("the progressive-expansion default calls L.foldSuites (a SECOND call site beyond the existing failure-jump one) rather than re-deriving the failing-suite set, and no second digest implementation is added", () => {
    const src = readFileSync(APP_JS_PATH, "utf8");
    const foldSuitesCallSites = (src.match(/L\.foldSuites\(/g) ?? []).length;
    const digestFailuresCallSites = (src.match(/L\.digestFailures\(/g) ?? []).length;

    // POSITIVE — today there is exactly ONE call site (jumpToNextFailure's
    // failure-jump load). Progressive expansion reusing the SAME helper to
    // compute its failing-suite auto-expand set means a genuinely NEW call
    // site appears.
    expect(foldSuitesCallSites).toBeGreaterThanOrEqual(2);

    // BOUND — no second, parallel digest-grouping implementation was
    // written for the playwright path; the generic Density digest stays the
    // ONLY one.
    expect(digestFailuresCallSites).toBe(1);
  });
});

describe("CR-CRU-145 §S1/§S4 — the byline: who filed the run, when, and its cycle — following the subject", () => {
  test("a playwright run's detail names WHO filed it, WHEN (the board's relative-time idiom), and its cycle", async () => {
    const eventId = "evt-s1-byline";
    const mountedAt = Date.now();
    await mountApp({
      pathname: `/run/${eventId}`,
      events: [
        playwrightEvent(eventId, {
          agentId: "byline-filer-alpha",
          timestamp: mountedAt - (2 * 3600 + 1800) * 1000,
          context: { cycle: "the responsive-band fix", cycleId: 777 },
        }),
      ],
    });

    const byline = overlay().querySelector<HTMLElement>('[data-testid="run-byline"]');
    expect(byline).not.toBeNull();
    const text = (byline!.textContent ?? "").trim();

    // POSITIVE — WHO.
    expect(text).toContain("byline-filer-alpha");
    // POSITIVE — WHEN, through the board's OWN formatter (not a hand-typed
    // string), so a poll's few seconds cannot roll this across a boundary.
    const expectedRel = relativeTime(mountedAt - (2 * 3600 + 1800) * 1000, Date.now());
    expect(text).toContain(expectedRel);
    // POSITIVE — its cycle.
    expect(text).toContain("the responsive-band fix");
  });

  test("the byline FOLLOWS the subject: opening a DIFFERENT run shows a DIFFERENT byline", async () => {
    const firstId = "evt-s1-byline-first";
    const secondId = "evt-s1-byline-second";
    const now = Date.now();
    await mountApp({
      pathname: `/run/${firstId}`,
      events: [
        playwrightEvent(firstId, { agentId: "byline-filer-first", timestamp: now - 3_600_000 }),
        playwrightEvent(secondId, { agentId: "byline-filer-second", timestamp: now - 7_200_000 }),
      ],
    });

    const firstText = (overlay().querySelector('[data-testid="run-byline"]')?.textContent ?? "").trim();
    expect(firstText).toContain("byline-filer-first");
    expect(firstText).not.toContain("byline-filer-second");

    // Navigate to the SECOND run's own detail directly (same route family).
    history.pushState(null, "", `/run/${secondId}`);
    window.dispatchEvent(new Event("popstate"));
    await settle();

    const secondText = (overlay().querySelector('[data-testid="run-byline"]')?.textContent ?? "").trim();
    expect(secondText).toContain("byline-filer-second");
    expect(secondText).not.toContain("byline-filer-first");
  });
});

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// CR-CRU-145 \u00a7S1 \u2014 F11 DRAWS A FEATURE LEVEL (orchestrator ruling 2026-09-24,
// amending this file's earlier "suite-row granularity, no feature heading"
// reading \u2014 see the file header).
//
// F11 (the APPROVED visual contract, B) draws "\u25be Feature: responsive phone
// band 3 \u2713 1 \u2717" and "\u25b8 Feature: roadmap graph 6 \u2713", each feature's scenarios
// nested beneath ITS OWN heading, and "\u25b8 14 more features, all green \u2014
// folded". So a feature is its own DOM group, carrying its OWN pass/fail
// counts, its OWN expand/fold state, and the failing feature (like the
// failing scenario) floats ahead of the green ones.
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// TESTIDS DECLARED HERE (F11 names no identifier \u2014 the smallest reading
// consistent with its drawing, same house precedent as this file's other
// declared choices):
//   [data-testid="feature-group"]   \u2014 one per feature, wrapping its heading
//                                     AND its nested scenario suite-rows.
//     data-feature-name              \u2014 the feature's own title (the part of
//                                     the codec's "<Feature> \u203a <Scenario>"
//                                     name before the separator).
//     data-feature-status            \u2014 "fail" | "pass" (any failing scenario
//                                     beneath it makes the feature "fail").
//   [data-testid="feature-heading"] \u2014 the clickable heading row inside a
//                                     feature-group; carries the feature's
//                                     OWN pass/fail counts as TEXT (F11's
//                                     "3 \u2713 1 \u2717" / "6 \u2713").
//     [data-testid="feature-toggle"] \u2014 \u25be (expanded) / \u25b8 (folded) glyph, the
//                                     same convention `tree-toggle` already
//                                     uses one level down.
// A feature-group's scenarios (existing `[data-testid="suite-row"]` nodes)
// are DESCENDANTS of it when expanded; when folded, NONE of that feature's
// suite-rows exist in the DOM at all (mirrors the existing suite-row/
// leaf-row fold contract one level up).
const FEATURE_GREEN_TITLE = "F11 Green Feature";
const FEATURE_FAIL_TITLE = "F11 Failing Feature";
const GREEN_SCENARIO_A = `${FEATURE_GREEN_TITLE} \u203a first green scenario`;
const GREEN_SCENARIO_B = `${FEATURE_GREEN_TITLE} \u203a second green scenario`;
const FAIL_SCENARIO = `${FEATURE_FAIL_TITLE} \u203a the scenario that breaks`;

/** The green feature is listed FIRST in the report; the failing feature
 *  SECOND \u2014 the report's own order is the ADVERSARIAL one for "failures
 *  float": a GREEN that merely preserved report order would put the green
 *  feature-group first in the DOM, which every ordering assertion below
 *  catches. */
function featureLevelTree(): SuiteFixture[] {
  return [
    { name: GREEN_SCENARIO_A, status: "pass", children: [GIVEN(101), THEN_PASS(101)] },
    { name: GREEN_SCENARIO_B, status: "pass", children: [GIVEN(102), THEN_PASS(102)] },
    {
      name: FAIL_SCENARIO,
      status: "fail",
      children: [GIVEN(103), { name: "Then it breaks", status: "fail", duration_ms: 2, failure: { message: "feature-level failure" } }],
    },
  ];
}

function featureGroups(): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]'));
}

function featureGroup(title: string): HTMLElement {
  const found = featureGroups().find((el) => el.getAttribute("data-feature-name") === title);
  if (found === undefined) {
    throw new Error(
      `no feature-group named "${title}"; groups present: ` +
        JSON.stringify(featureGroups().map((el) => el.getAttribute("data-feature-name"))),
    );
  }
  return found;
}

function featureExpanded(group: HTMLElement): boolean {
  return group.querySelector('[data-testid="feature-toggle"]')?.textContent?.trim() === "\u25be";
}

describe("CR-CRU-145 \u00a7S1 \u2014 F11 draws a FEATURE level: its own heading, its own counts, its own expand/fold, failures float", () => {
  test("each feature renders as its own heading carrying that feature's OWN counts, with its scenarios nested beneath it", async () => {
    const eventId = "evt-s1-feature-level-counts";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: featureLevelTree() })] });

    expect(featureGroups().length).toBe(2);

    const greenGroup = featureGroup(FEATURE_GREEN_TITLE);
    expect(greenGroup.getAttribute("data-feature-status")).toBe("pass");
    expect(greenGroup.getAttribute("data-feature-passed")).toBe("2");
    expect(greenGroup.getAttribute("data-feature-failed")).toBe("0");
    const greenHeading = greenGroup.querySelector('[data-testid="feature-heading"]');
    expect(greenHeading).not.toBeNull();
    expect((greenHeading!.textContent ?? "")).toContain("2");

    const failGroup = featureGroup(FEATURE_FAIL_TITLE);
    expect(failGroup.getAttribute("data-feature-status")).toBe("fail");
    // POSITIVE \u2014 the failing feature's OWN counts: 1 scenario passed
    // (GREEN_SCENARIO would be a different feature; here there is exactly
    // one scenario, and it fails) \u2014 0 passed, 1 failed.
    expect(failGroup.getAttribute("data-feature-passed")).toBe("0");
    expect(failGroup.getAttribute("data-feature-failed")).toBe("1");
    const failHeading = failGroup.querySelector('[data-testid="feature-heading"]');
    expect(failHeading).not.toBeNull();
    expect((failHeading!.textContent ?? "")).toContain("1");

    // BOUND \u2014 scenarios sit BENEATH their own feature's group, never a
    // sibling's: the green feature's group contains ONLY its own two
    // scenarios, never the failing feature's.
    expect(greenGroup.querySelectorAll('[data-testid="suite-row"]').length).toBeLessThanOrEqual(2);
    expect((greenGroup.textContent ?? "")).not.toContain("the scenario that breaks");
    expect((failGroup.textContent ?? "")).not.toContain("first green scenario");
  });

  test("the feature containing the failure is EXPANDED on open; the all-green feature is FOLDED — and expands on click", async () => {
    const eventId = "evt-s1-feature-level-fold";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: featureLevelTree() })] });

    const failGroup = featureGroup(FEATURE_FAIL_TITLE);
    expect(featureExpanded(failGroup)).toBe(true);
    expect(failGroup.querySelectorAll('[data-testid="suite-row"]').length).toBeGreaterThan(0);

    const greenGroup = featureGroup(FEATURE_GREEN_TITLE);
    expect(featureExpanded(greenGroup)).toBe(false);
    // BOUND \u2014 folded really means folded: NO suite-row for either of its
    // scenarios exists in the DOM at all, not merely hidden leaves.
    expect(greenGroup.querySelectorAll('[data-testid="suite-row"]').length).toBe(0);
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(GREEN_SCENARIO_A)}`))).toBe(false);

    // Clicking the folded feature's heading expands it.
    greenGroup.querySelector<HTMLElement>('[data-testid="feature-heading"]')!.click();
    await settle();

    const greenGroupAfter = featureGroup(FEATURE_GREEN_TITLE);
    expect(featureExpanded(greenGroupAfter)).toBe(true);
    expect(greenGroupAfter.querySelectorAll('[data-testid="suite-row"]').length).toBeGreaterThan(0);
    expect((greenGroupAfter.textContent ?? "")).toContain("first green scenario");
  });

  test("failures float: the failing feature (and its scenario) sit BEFORE the green ones in the rendered order, though the report lists the green feature FIRST", async () => {
    const eventId = "evt-s1-feature-level-float";
    // The fixture (featureLevelTree) deliberately lists the GREEN feature's
    // scenarios FIRST and the failing one LAST \u2014 report order is the
    // adversarial case for "floats".
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: featureLevelTree() })] });

    const groups = featureGroups();
    expect(groups.map((g) => g.getAttribute("data-feature-name"))).toEqual([
      FEATURE_FAIL_TITLE,
      FEATURE_GREEN_TITLE,
    ]);

    // AMENDED 2026-09-24 by orchestrator ruling (escalation #3): the green
    // feature is FOLDED on open (zero scenario rows, per the fold test
    // above), so its rows exist only once it is unfolded. Assert the fold
    // first, then unfold it by its heading and compare scenario-row order.
    const greenGroup = featureGroup(FEATURE_GREEN_TITLE);
    expect(greenGroup.querySelectorAll('[data-testid="suite-row"]').length).toBe(0);
    greenGroup.querySelector<HTMLElement>('[data-testid="feature-heading"]')!.click();
    await settle();

    // The SAME ordering holds at the scenario level, independent of feature
    // grouping: the failing scenario's own suite-row precedes both green
    // scenarios' rows in document order.
    const allSuiteRows = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]'));
    const failIdx = allSuiteRows.findIndex((r) => (r.textContent ?? "").includes("the scenario that breaks"));
    const greenAIdx = allSuiteRows.findIndex((r) => (r.textContent ?? "").includes("first green scenario"));
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(greenAIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeLessThan(greenAIdx);
  });
});

