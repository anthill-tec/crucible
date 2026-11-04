// CR-CRU-145 §S1 — ONE renderer: the run detail, opened as a specification
// for BDD (`codec: "playwright"`) runs.
//
// MEASURED ON THIS BRANCH (158ec48, before this CR's GREEN): `RunDetailBody`
// (public/app.js) fetches `?depth=suites` and then auto-expands
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
//     In the scenario shape an open feature's one read answers every
//     scenario of it, so every scenario of an open feature shows its steps.
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
  /** A scenario's Gherkin steps; absent on a plain test. */
  steps?: LeafFixture[];
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
  /** The browser a feature's suite ran under; set on a playwright-bdd run's suites. */
  browser?: string;
}
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec: string;
  framework?: string;
  stack?: string;
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
      const browserParam = parsed.searchParams.get("browser");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = detail.tree.find(
          (n) => n.name === suiteParam && (browserParam === null || n.browser === browserParam),
        );
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = detail.tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
          ...(n.browser !== undefined ? { browser: n.browser } : {}),
        }));
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
          ...(e.framework !== undefined ? { stack: e.stack, framework: e.framework } : {}),
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

/** A plain-tree suite row is expanded: its toggle reads "\u25be". */
function isExpanded(row: HTMLElement): boolean {
  return row.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim() === "\u25be";
}

/** A scenario row shows its steps: the step rows drawn in its own group. */
function stepsShown(name: string): boolean {
  return leafRowsOf(name).length > 0;
}

function leafRowsOf(suiteName: string): HTMLElement[] {
  const row = suiteRow(suiteName);
  const group = row.parentElement;
  return Array.from(group?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

// ── Fixture: 3 features, 7 scenarios, served as the board serves a streamed
// playwright-bdd run: one suite per feature (under one browser), each
// scenario a leaf of it carrying its Gherkin steps. Features are ordered
// failures-first; every failing feature opens, then the first SPEC_FIRST_OPEN
// (2) features in that order; an open feature's one read answers all of its
// scenarios with their steps. So the failing feature (Gamma, listed LAST in
// the report) floats to the top and opens, every scenario of it showing its
// steps; Alpha (listed FIRST in the report, all green) is the second feature
// in that order and opens too; and Beta, beyond the first two, folds at the
// FEATURE level — zero scenario rows, its suite unread until clicked. The
// all-green-run branch of the rule (no failing feature, so the report-first
// features open) is pinned by its own test below.
const GIVEN = (n: number): LeafFixture => ({ name: `Given step ${n}`, status: "pass", duration_ms: 2 });
const THEN_PASS = (n: number): LeafFixture => ({ name: `Then step ${n} passes`, status: "pass", duration_ms: 2 });
const THEN_FAIL: LeafFixture = { name: "Then it breaks", status: "fail", duration_ms: 3, failure: { message: "expected pane scrollTop > 0, got 0", trace: "Error: expected pane scrollTop > 0, got 0\n    at run-detail.spec.ts:14:3" } };

const BROWSER = "chromium";

/** A scenario leaf: its status and duration are its steps'. */
function scenario(name: string, steps: LeafFixture[]): LeafFixture {
  const failed = steps.find((st) => st.status === "fail");
  return {
    name,
    status: failed !== undefined ? "fail" : "pass",
    duration_ms: steps.reduce((sum, st) => sum + st.duration_ms, 0),
    ...(failed?.failure !== undefined ? { failure: { message: failed.failure.message } } : {}),
    steps,
  };
}

/** A feature run under one browser: the suite the board stores for it. */
function feature(name: string, scenarios: LeafFixture[]): SuiteFixture {
  return {
    name,
    status: scenarios.some((sc) => sc.status === "fail") ? "fail" : "pass",
    children: scenarios,
    browser: BROWSER,
  };
}

const ALPHA_A_NAME = "listed first in the report, but all green";
const ALPHA_B_NAME = "its second green scenario";
const BETA_NAME = "an all-green feature beyond the first two folds entirely";
const GAMMA_FIRST_NAME = "the failing feature's first scenario opens";
const S4_NAME = "a failing scenario auto-expands anywhere";
const GAMMA_MID_NAME = "a middle scenario";
const GAMMA_LATE_NAME = "a later scenario of the open feature";

function progressiveTree(): SuiteFixture[] {
  return [
    feature("Alpha Feature", [
      scenario(ALPHA_A_NAME, [GIVEN(1), THEN_PASS(1)]),
      scenario(ALPHA_B_NAME, [GIVEN(2), THEN_PASS(2)]),
    ]),
    feature("Beta Feature", [scenario(BETA_NAME, [GIVEN(3), THEN_PASS(3)])]),
    feature("Gamma Feature", [
      scenario(GAMMA_FIRST_NAME, [GIVEN(5), THEN_PASS(5)]),
      scenario(S4_NAME, [GIVEN(4), THEN_FAIL]),
      scenario(GAMMA_MID_NAME, [GIVEN(6), THEN_PASS(6)]),
      scenario(GAMMA_LATE_NAME, [GIVEN(7), THEN_PASS(7)]),
    ]),
  ];
}

/** Whether a `?suite=` read of the feature `name` (under its browser) was made. */
function suiteRead(name: string): boolean {
  return fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(name)}&browser=${BROWSER}`));
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
    codec: "crucible-events",
    framework: "playwright-bdd",
    stack: "bun",
    timestamp: Date.now(),
    tree: progressiveTree(),
    ...opts,
  };
}

describe("CR-CRU-145 §S1 — a playwright run's detail opens PROGRESSIVELY EXPANDED", () => {
  test("on open: the failing feature floats first and opens — its failing scenario AND its first scenario show their steps without a click, and so does a later scenario of it — the second feature in failures-first order opens too, and an all-green feature beyond the first two folds at the FEATURE level", async () => {
    const eventId = "evt-s1-progressive";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // POSITIVE — the failing feature floats first, ahead of the report-first one.
    expect(
      Array.from(overlay().querySelectorAll('[data-testid="feature-group"]')).map((g) => g.getAttribute("data-feature-name")),
    ).toEqual(["Gamma Feature", "Alpha Feature", "Beta Feature"]);

    // POSITIVE — the failing scenario shows its steps on open, with no click.
    expect(leafRowsOf(S4_NAME).some((r) => (r.textContent ?? "").includes("Then it breaks"))).toBe(true);

    // POSITIVE — the failing feature's first scenario (report-first within
    // it, and green) ALSO shows its steps on open.
    expect(leafRowsOf(GAMMA_FIRST_NAME).length).toBe(2);

    // POSITIVE — the open feature's one read answers every scenario of it,
    // so a LATER scenario shows its steps too.
    expect(leafRowsOf(GAMMA_LATE_NAME).map((r) => (r.textContent ?? "").trim())).toEqual(
      expect.arrayContaining([expect.stringContaining("Given step 7"), expect.stringContaining("Then step 7 passes")]),
    );
    expect(leafRowsOf(GAMMA_LATE_NAME).length).toBe(2);

    // POSITIVE — the second feature in failures-first order (Alpha, the
    // report-first one) is within the first SPEC_FIRST_OPEN and opens.
    expect(featureFolded("Alpha Feature")).toBe(false);
    expect(stepsShown(ALPHA_A_NAME)).toBe(true);

    // BOUND — the all-green feature beyond the first two folds whole at the
    // feature level: zero scenario rows until clicked.
    expect(featureFolded("Beta Feature")).toBe(true);
  });

  test("a long run issues NO per-suite read for a feature that has not opened — asserted on the requests made, not on timing", async () => {
    const eventId = "evt-s1-no-eager-fetch";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // The folded feature's suite never reaches a `?suite=` read.
    expect(suiteRead("Beta Feature")).toBe(false);

    // …while the open features' suites legitimately were read, each once, by
    // feature and browser — the absence above is a real signal, not a fetch
    // mock that never fires.
    expect(suiteRead("Gamma Feature")).toBe(true);
    expect(suiteRead("Alpha Feature")).toBe(true);
    expect(fetchLog.filter((u) => u.includes("suite=")).length).toBe(2);
  });

  test("an ALL-GREEN run has no failing feature, so the REPORT-first features open: their scenarios show their steps, and every feature beyond the first two folds", async () => {
    const eventId = "evt-s1-all-green";
    const greenTree: SuiteFixture[] = [
      feature("Delta Feature", [
        scenario("its first scenario opens", [GIVEN(11), THEN_PASS(11)]),
        scenario("its second scenario", [GIVEN(12), THEN_PASS(12)]),
        scenario("its third scenario", [GIVEN(13), THEN_PASS(13)]),
      ]),
      feature("Epsilon Feature", [scenario("the second feature's scenario opens", [GIVEN(14), THEN_PASS(14)])]),
      feature("Zeta Feature", [scenario("a later all-green feature folds", [GIVEN(15), THEN_PASS(15)])]),
    ];
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: greenTree })] });

    // POSITIVE — the report-first feature opens, and its scenarios show their
    // steps without a click, its third included.
    expect(featureFolded("Delta Feature")).toBe(false);
    expect(leafRowsOf("its first scenario opens").length).toBe(2);
    expect(leafRowsOf("its third scenario").length).toBe(2);
    expect(suiteRead("Delta Feature")).toBe(true);

    // POSITIVE — so does the second feature in report order.
    expect(featureFolded("Epsilon Feature")).toBe(false);
    expect(leafRowsOf("the second feature's scenario opens").length).toBe(2);

    // BOUND — every feature beyond the first two folds at the feature level, unread.
    expect(featureFolded("Zeta Feature")).toBe(true);
    expect(suiteRead("Zeta Feature")).toBe(false);
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
const FEATURE_LEADING_TITLE = "F11 Leading Green Feature";
const GREEN_SCENARIO_A = "first green scenario";
const GREEN_SCENARIO_B = "second green scenario";
const FAIL_SCENARIO = "the scenario that breaks";

/** The green features are listed FIRST in the report; the failing feature
 *  LAST — the report's own order is the ADVERSARIAL one for "failures
 *  float": a GREEN that merely preserved report order would put a green
 *  feature-group first in the DOM, which every ordering assertion below
 *  catches. The leading green feature takes the second of the first
 *  SPEC_FIRST_OPEN places in failures-first order, so the green feature
 *  under test is the one beyond them that folds. */
function featureLevelTree(): SuiteFixture[] {
  return [
    feature(FEATURE_LEADING_TITLE, [scenario("a leading green scenario", [GIVEN(100), THEN_PASS(100)])]),
    feature(FEATURE_GREEN_TITLE, [
      scenario(GREEN_SCENARIO_A, [GIVEN(101), THEN_PASS(101)]),
      scenario(GREEN_SCENARIO_B, [GIVEN(102), THEN_PASS(102)]),
    ]),
    feature(FEATURE_FAIL_TITLE, [
      scenario(FAIL_SCENARIO, [GIVEN(103), { name: "Then it breaks", status: "fail", duration_ms: 2, failure: { message: "feature-level failure" } }]),
    ]),
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

    expect(featureGroups().length).toBe(3);

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
    expect(suiteRead(FEATURE_GREEN_TITLE)).toBe(false);

    // Clicking the folded feature's heading expands it.
    greenGroup.querySelector<HTMLElement>('[data-testid="feature-heading"]')!.click();
    await settle();

    const greenGroupAfter = featureGroup(FEATURE_GREEN_TITLE);
    expect(featureExpanded(greenGroupAfter)).toBe(true);
    expect(greenGroupAfter.querySelectorAll('[data-testid="suite-row"]').length).toBeGreaterThan(0);
    expect((greenGroupAfter.textContent ?? "")).toContain("first green scenario");
    // POSITIVE — opening it read its suite, which answered its scenarios' steps.
    expect(suiteRead(FEATURE_GREEN_TITLE)).toBe(true);
    expect(leafRowsOf(GREEN_SCENARIO_A).length).toBe(2);
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
      FEATURE_LEADING_TITLE,
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

// "Every other feature containing a failure is expanded with its failing
// scenarios' steps shown" covers MORE than one failing feature; the fixtures
// above each carry exactly one. This one carries TWO failing features and one
// green, listed green-first so report order is the adversarial one.
const TWO_FAIL_GREEN_A = "the green feature's first green scenario";
const TWO_FAIL_GREEN_B = "the green feature's second green scenario";
const TWO_FAIL_ONE_FIRST = "the first failing feature's report-first scenario";
const TWO_FAIL_ONE_BROKEN = "the first failing feature's scenario that breaks";
const TWO_FAIL_TWO_FIRST = "the second failing feature's report-first scenario";
const TWO_FAIL_TWO_BROKEN = "the second failing feature's scenario that breaks";

function twoFailingFeaturesTree(): SuiteFixture[] {
  const breaks = (n: number): LeafFixture => ({ name: `Then step ${n} breaks`, status: "fail", duration_ms: 3, failure: { message: `failure ${n}` } });
  return [
    feature("Two-Fail Green Feature", [
      scenario(TWO_FAIL_GREEN_A, [GIVEN(201), THEN_PASS(201)]),
      scenario(TWO_FAIL_GREEN_B, [GIVEN(202), THEN_PASS(202)]),
    ]),
    feature("Two-Fail First Failing Feature", [
      scenario(TWO_FAIL_ONE_FIRST, [GIVEN(203), THEN_PASS(203)]),
      scenario(TWO_FAIL_ONE_BROKEN, [GIVEN(204), breaks(204)]),
    ]),
    feature("Two-Fail Second Failing Feature", [
      scenario(TWO_FAIL_TWO_FIRST, [GIVEN(205), THEN_PASS(205)]),
      scenario(TWO_FAIL_TWO_BROKEN, [GIVEN(206), breaks(206)]),
    ]),
  ];
}

describe("CR-CRU-145 \u00a7S1 \u2014 a run with TWO failing features expands BOTH, and folds the green one", () => {
  test("the first failing feature opens per the first-feature rule, the SECOND failing feature is expanded with its failing scenario's steps shown, and the green feature folds", async () => {
    const eventId = "evt-s1-two-failing-features";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId, { tree: twoFailingFeaturesTree() })] });

    // Failures float: both failing features precede the green one.
    const order = featureGroups().map((g) => g.getAttribute("data-feature-name"));
    expect(order.length).toBe(3);
    expect(order[2]).toBe("Two-Fail Green Feature");
    const [firstTitle, secondTitle] = [order[0]!, order[1]!];
    expect([firstTitle, secondTitle].sort()).toEqual(["Two-Fail First Failing Feature", "Two-Fail Second Failing Feature"]);
    const scenariosOf = (title: string) =>
      title === "Two-Fail First Failing Feature"
        ? { first: TWO_FAIL_ONE_FIRST, broken: TWO_FAIL_ONE_BROKEN, step: "Then step 204 breaks" }
        : { first: TWO_FAIL_TWO_FIRST, broken: TWO_FAIL_TWO_BROKEN, step: "Then step 206 breaks" };

    // POSITIVE \u2014 the first feature in failures-first order: its failing
    // scenario AND its first scenario show their steps without a click.
    const first = scenariosOf(firstTitle);
    expect(featureExpanded(featureGroup(firstTitle))).toBe(true);
    expect(leafRowsOf(first.broken).some((r) => (r.textContent ?? "").includes(first.step))).toBe(true);
    expect(leafRowsOf(first.first).length).toBe(2);

    // POSITIVE \u2014 the SECOND failing feature is expanded too, its failing
    // scenario's steps shown without a click.
    const second = scenariosOf(secondTitle);
    const secondGroup = featureGroup(secondTitle);
    expect(featureExpanded(secondGroup)).toBe(true);
    expect(secondGroup.querySelectorAll('[data-testid="suite-row"]').length).toBeGreaterThan(0);
    expect(leafRowsOf(second.broken).some((r) => (r.textContent ?? "").includes(second.step))).toBe(true);
    expect(suiteRead(secondTitle)).toBe(true);

    // BOUND \u2014 the green feature folds whole, its scenarios unread.
    expect(featureFolded("Two-Fail Green Feature")).toBe(true);
    expect(suiteRead("Two-Fail Green Feature")).toBe(false);
  });
});

// A spec run's step line keeps the verbatim Gherkin the codec stored, so its
// glyph and duration are drawn by CSS from attributes the leaf row sets. The
// source-assertion technique of tests/roadmap-visual-grammar.test.ts: read the
// shipped public/styles.css, comments stripped, and hold its rules to account.
const STYLES_RULES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");

/** Every `selector { body }` rule; an @media wrapper's own brace is skipped,
 *  its inner rules still match. */
function cssRules(): Array<{ selectors: string[]; body: string }> {
  return [...STYLES_RULES_SRC.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim()),
    body: m[2]!,
  }));
}

/** The rules whose `content` draws `attr(<attribute>)`; asserts each is scoped
 *  to `.app-leaf-step` on the given pseudo-element and returns the class the
 *  pseudo-element hangs off. */
function attrDrawingTargets(attribute: string, pseudo: "::before" | "::after"): string[] {
  const drawing = cssRules().filter((r) => new RegExp(`content:[^;]*attr\\(${attribute}\\)`).test(r.body));
  expect(drawing.length).toBeGreaterThan(0);
  const targets: string[] = [];
  for (const rule of drawing) {
    for (const selector of rule.selectors) {
      const m = new RegExp(`^\\.app-leaf-step\\s+\\.([\\w-]+)${pseudo}$`).exec(selector);
      if (m === null) throw new Error(`attr(${attribute}) is drawn by "${selector}", not scoped as .app-leaf-step .<cell>${pseudo}`);
      targets.push(m[1]!);
    }
  }
  return targets;
}

describe("CR-CRU-145 \u00a7S1 \u2014 a playwright step's glyph and duration are CSS-drawn from its own attributes, scoped to .app-leaf-step", () => {
  test("styles.css draws the glyph (::before) from data-glyph and the duration (::after) from data-duration, ONLY under .app-leaf-step", () => {
    expect(attrDrawingTargets("data-glyph", "::before")).toEqual(["app-leaf-name"]);
    expect(attrDrawingTargets("data-duration", "::after")).toEqual(["app-leaf-duration"]);
  });

  test("a playwright leaf row is an .app-leaf-step whose cells carry data-glyph / data-duration; a junit leaf row carries neither and prints its glyph as text", async () => {
    const glyphCell = attrDrawingTargets("data-glyph", "::before")[0]!;
    const durationCell = attrDrawingTargets("data-duration", "::after")[0]!;

    const pwId = "evt-s1-leaf-attrs-playwright";
    await mountApp({ pathname: `/run/${pwId}`, events: [playwrightEvent(pwId)] });
    const failing = leafRowsOf(S4_NAME).find((r) => (r.textContent ?? "").includes("Then it breaks"));
    const passing = leafRowsOf(S4_NAME).find((r) => (r.textContent ?? "").includes("Given step 4"));
    expect(failing).toBeDefined();
    expect(passing).toBeDefined();
    for (const row of [failing!, passing!]) {
      expect(row.classList.contains("app-leaf-step")).toBe(true);
      const duration = row.querySelector(`.${durationCell}`)?.getAttribute("data-duration") ?? "";
      expect(duration.length).toBeGreaterThan(0);
    }
    // POSITIVE \u2014 the attribute carries the step's own verdict glyph, and the
    // name cell holds the verbatim step text alone (the glyph is not drawn twice).
    const failName = failing!.querySelector(`.${glyphCell}`)!;
    expect(failName.getAttribute("data-glyph")).toBe("\u2717");
    expect((failName.textContent ?? "").trim()).toBe("Then it breaks");
    expect(passing!.querySelector(`.${glyphCell}`)!.getAttribute("data-glyph")).toBe("\u2713");

    const junitId = "evt-s1-leaf-attrs-junit";
    await mountApp({
      pathname: `/run/${junitId}`,
      events: [
        {
          id: junitId,
          projectKey: "proj-s1-run-detail",
          agentId: "junit-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: Date.now(),
          tree: [{ name: "JunitSuite", status: "fail", children: [{ name: "a failing case", status: "fail", duration_ms: 1, failure: { message: "boom" } }] }],
        },
      ],
    });
    suiteRow("JunitSuite").click();
    await settle();
    const junitRows = leafRowsOf("JunitSuite");
    expect(junitRows.length).toBe(1);
    const junitRow = junitRows[0]!;
    // BOUND \u2014 the CSS rules above never reach a junit row: no scope class, no
    // attributes; its glyph is printed in the name cell as text.
    expect(junitRow.classList.contains("app-leaf-step")).toBe(false);
    expect(junitRow.querySelector("[data-glyph]")).toBeNull();
    expect(junitRow.querySelector("[data-duration]")).toBeNull();
    expect((junitRow.querySelector(`.${glyphCell}`)?.textContent ?? "").trim()).toBe("\u2717 a failing case");
  });
});

