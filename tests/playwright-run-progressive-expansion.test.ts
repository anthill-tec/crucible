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
//   • "green features fold" is read at the SUITE-ROW granularity the
//     drill-in already has, not as a NEW third DOM level grouping several
//     `suite-row`s under a collapsible feature heading. The codec's
//     `SuiteNode` is one node PER SCENARIO (feature identity lives only in
//     the composed `"<Feature> › <Scenario>"` name — CR-CRU-007's own
//     precedent for a level the model has no room for); §S1's own text
//     leans on REUSE ("its collapse … are the frame this CR wanted, and
//     they are reused by not being touched"), and the existing `foldSuites`
//     fold rule already operates per suite. F11's mock draws a feature
//     heading, which is a legitimate GREEN choice this file does not
//     forbid — but this file asserts only the STEP-VISIBILITY behaviour
//     (expanded vs folded, fetched vs not), never a specific heading
//     element, so it passes equally against a GREEN that adds a heading and
//     one that doesn't.
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

// ── Fixture: 3 features, 4 scenarios, deliberately shaped to separate the
// three progressive-expansion rules from one another ─────────────────────
const GIVEN = (n: number) => ({ name: `Given step ${n}`, status: "pass" as const, duration_ms: 2 });
const THEN_PASS = (n: number) => ({ name: `Then step ${n} passes`, status: "pass" as const, duration_ms: 2 });
const THEN_FAIL = { name: "Then it breaks", status: "fail" as const, duration_ms: 3, failure: { message: "expected pane scrollTop > 0, got 0", trace: "Error: expected pane scrollTop > 0, got 0\n    at run-detail.spec.ts:14:3" } };

const S1_NAME = "Alpha Feature › first scenario auto-expands";
const S2_NAME = "Alpha Feature › third scenario stays folded";
const S3_NAME = "Beta Feature › an all-green feature folds entirely";
const S4_NAME = "Gamma Feature › a failing scenario auto-expands anywhere";

function progressiveTree(): SuiteFixture[] {
  return [
    { name: S1_NAME, status: "pass", children: [GIVEN(1), THEN_PASS(1)] },
    { name: S2_NAME, status: "pass", children: [GIVEN(2), THEN_PASS(2)] },
    { name: S3_NAME, status: "pass", children: [GIVEN(3), THEN_PASS(3)] },
    { name: S4_NAME, status: "fail", children: [GIVEN(4), THEN_FAIL] },
  ];
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
  test("on open: the failing scenario AND the first scenario of the first feature show their steps without a click; a later scenario of that same feature, and an all-green later feature, stay folded", async () => {
    const eventId = "evt-s1-progressive";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // POSITIVE — the very first scenario overall is expanded on open.
    expect(isExpanded(suiteRow(S1_NAME))).toBe(true);
    expect(leafRowsOf(S1_NAME).length).toBe(2);

    // POSITIVE — the failing scenario (a different feature entirely) is
    // ALSO expanded on open, with no click.
    expect(isExpanded(suiteRow(S4_NAME))).toBe(true);
    expect(leafRowsOf(S4_NAME).some((r) => (r.textContent ?? "").includes("Then it breaks"))).toBe(true);

    // BOUND — a LATER scenario of the SAME first feature is not
    // auto-expanded: "the first scenarios" is not "every scenario".
    expect(isExpanded(suiteRow(S2_NAME))).toBe(false);
    expect(leafRowsOf(S2_NAME).length).toBe(0);

    // BOUND — an entirely separate ALL-GREEN feature, further down, folds
    // whole: green features fold.
    expect(isExpanded(suiteRow(S3_NAME))).toBe(false);
    expect(leafRowsOf(S3_NAME).length).toBe(0);
  });

  test("a long run issues NO per-suite read for a scenario that has not scrolled into view — asserted on the requests made, not on timing", async () => {
    const eventId = "evt-s1-no-eager-fetch";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // The two never-expanded scenarios' names never reach a `?suite=` read.
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S2_NAME)}`))).toBe(false);
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S3_NAME)}`))).toBe(false);

    // …while the two auto-expanded ones legitimately were read — the
    // absence above is a real signal, not a fetch mock that never fires.
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S1_NAME)}`))).toBe(true);
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S4_NAME)}`))).toBe(true);
  });

  test("scrolling deep into the pane loads and shows a previously-folded scenario's steps, with no click", async () => {
    const eventId = "evt-s1-scroll-loads";
    await mountApp({ pathname: `/run/${eventId}`, events: [playwrightEvent(eventId)] });

    // PRECONDITION — S3 (the all-green later feature) is folded and unread.
    expect(isExpanded(suiteRow(S3_NAME))).toBe(false);
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S3_NAME)}`))).toBe(false);

    await scrollDeep();

    // POSITIVE — it is now expanded, its steps rendered, and the read that
    // produced them is in the log — WITHOUT a suite-row click anywhere in
    // this test.
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent(S3_NAME)}`))).toBe(true);
    expect(isExpanded(suiteRow(S3_NAME))).toBe(true);
    expect(leafRowsOf(S3_NAME).map((r) => (r.textContent ?? "").includes("Given step 3"))).toContain(true);
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
