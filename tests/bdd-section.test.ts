// CR-CRU-015 §S3 (cycle 491) → CR-CRU-145 §S4 MIGRATION (cycle 511, RED).
//
// §S3 shipped a bespoke `BddFeed` renderer (public/app.js, retired by this
// CR) that rendered the LATEST BDD run's Gherkin inline. CR-CRU-145 §S4
// retires `BddFeed`/`BddFeature`/`BddScenario`/`BddStep`/`BddRunIdentity`
// outright — no shim, no second path — because §S1 makes the run detail the
// ONE renderer of a playwright run's Gherkin (opened as a specification,
// progressively expanded) and §S2 turns the BDD tab into an INDEX of runs
// that hands off to that same run detail.
//
// THIS FILE MIGRATES rather than being deleted (§S4's own instruction). Its
// 13 original assertions are triaged below, one by one, each one NAMED in
// this header so the RED report can cite it without re-deriving the table:
//
//   KEPT, RE-POINTED at the run detail (the single renderer, opened via the
//   BDD index's own row — proving the index hands off rather than forking):
//     1. "renders the feature title once, its scenario titles in order, and
//        each scenario's own ordered step lines with per-step outcomes"
//     2. "a failing scenario carries its failure AT the step that broke"
//     10. "a populated pane names WHEN … and WHICH agent filed it" — the C3
//        byline, which §S4 AC3 states explicitly MOVES to the renderer.
//     11. "the pane FOLLOWS its subject" — RE-INTERPRETED (not merely
//        re-pointed): the retired pane auto-updated to whichever run was
//        LATEST, with no navigation. The run detail is opened by an EXPLICIT
//        route per run (§S2's whole point — no second renderer, one shared
//        route), so there is no "currently displayed run" to silently swap
//        out from under a reader. §S4 AC3's own wording — "follows the
//        subject (a DIFFERENT RUN NAMED WHEN A DIFFERENT RUN IS OPENED)" —
//        is the SMALLER, testable claim this migrates to: opening a
//        different run's detail names THAT run, never a stale one.
//
//   KEPT, RE-POINTED at the BDD INDEX (§S2's new surface — the tab itself,
//   which still carries `[data-testid="workspace-bdd"]`):
//     4. "with no run recorded … exactly one definitive empty state, no
//        skeleton chrome" — now the INDEX's own empty state.
//     5. "a project whose only run is a junit unit run shows the same empty
//        state" — same reasoning, index-level.
//     7. "a populated pane is NOT greyed while up, greyed only via the
//        watchdog" — RE-POINTED: "with its Gherkin still rendered" becomes
//        "with its index rows still rendered" (the index has no Gherkin of
//        its own to keep rendering — §S2's whole point).
//
//   KEPT UNCHANGED (never referenced the retired component's internals —
//   these assert `workspaceTabs()` and the tab-gate mechanism, both
//   untouched by this CR):
//     8. "on a backend project BDD is gated ON THE TAB"
//     9. "workspaceTabs disables BDD for a backend project…" (pure logic)
//
//   AMENDED (the AC itself is superseded, not merely re-pointed — §S4's own
//   instruction: "The no-tally bound is superseded… what survives is that
//   the BDD tab does not reproduce the Runs timeline's card grammar."):
//     13. "a run WITH failures is NAMED, never TALLIED" → counts are now
//        EXPECTED (the index row's verdict, F11 A; the specification's own
//        content, F11's card f) — the surviving bound is narrower: no
//        `event-card`/`ratio-pill` (the Runs timeline's OWN card grammar)
//        anywhere in the BDD pane, and the index itself renders no full
//        Gherkin (that content lives at the renderer the row hands off to).
//
//   DELETED — asserted ONLY the retired component's own internals, with no
//   observable-Gherkin content left to re-point once that component's
//   source is gone:
//     3. "the pane never claims the dedicated BDD surface does not exist" —
//        guarded a placeholder STRING that belonged solely to `BddFeed`'s
//        not-yet-built state. Once `BddFeed`'s source is deleted, NO code
//        path in the whole app can ever produce that string again — the
//        check becomes unfalsifiable, not merely redundant.
//     6a. "the read that FAILED: stated while it stands, gone when it is
//        stale" and
//     6b. "after a failed read, the NEXT run's successful read renders its
//        Gherkin — the error does not stick to the pane"
//        — both asserted `BddFeed`'s own `load()` memo/stale-error state
//        machine: the pane autonomously fetched ONE run's detail behind the
//        scenes and could get stuck on an old error. The INDEX never
//        autonomously fetches a run's detail (it reads only the
//        already-in-memory briefs `visibleEvents()` already holds — §S2's
//        own text); a run detail's OWN read failure is the run detail's
//        GENERIC `loadError` handling (pre-existing, codec-agnostic, and
//        covered elsewhere — not this CR's surface). There is no equivalent
//        "the pane's own stuck error" state left to preserve.
//
// HARNESS — unchanged house idiom (real VanJS/VanX, real public/app-logic
// .mjs + public/app.js, scripted fetch including the progressive
// `?depth=suites` / `?suite=<name>` contract).
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { relativeTime, workspaceTabs } from "../public/app-logic.mjs";

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

/** CR-CRU-097 AC1's two rules, restated here so §S2's own empty state is
 *  railed from this side too rather than only by the shipped guard. */
const ANY_PROJECT_CR = /CR-[A-Z]{2,}-\d+/;
const RELEASE_VERSION = /\b\d+\.\d+(?:\.\d+)?\b/;

const FEATURE_TITLE = "Gherkin Rendering Feature";
const PASSING_SCENARIO = "a passing scenario renders every step";
const FAILING_SCENARIO = "a failing scenario stops at the broken step";
const FAILURE_MESSAGE = "expect(received).toBe(expected) — the step never rendered";

const SHARED_GIVEN = "Given the board has a frontend project";
const PASSING_STEPS = [
  SHARED_GIVEN,
  "When a BDD run is ingested for it",
  "And the run carries its Gherkin steps",
  "Then the BDD section renders them in order",
];
const FAILING_STEPS = [SHARED_GIVEN, "When the specification breaks"];

interface Leaf {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: { message: string; trace?: string };
}

interface SuiteNode {
  name: string;
  status: "pass" | "fail" | "pending";
  children: Leaf[];
}

function gherkinTree(): SuiteNode[] {
  return [
    {
      name: `${FEATURE_TITLE} › ${PASSING_SCENARIO}`,
      status: "pass",
      children: PASSING_STEPS.map((name, i) => ({
        name,
        status: "pass" as const,
        duration_ms: 5 + i,
      })),
    },
    {
      name: `${FEATURE_TITLE} › ${FAILING_SCENARIO}`,
      status: "fail",
      children: [
        { name: FAILING_STEPS[0] as string, status: "pass", duration_ms: 4 },
        {
          name: FAILING_STEPS[1] as string,
          status: "fail",
          duration_ms: 1,
          failure: {
            message: FAILURE_MESSAGE,
            trace: `${FAILURE_MESSAGE}\n    at bdd-section.steps.ts:42:7`,
          },
        },
      ],
    },
  ];
}

interface RunFixture {
  id: string;
  tier: string;
  codec: string;
  tree: SuiteNode[];
  agentId?: string;
  offsetMs?: number;
  /** CR-CRU-145 §S2 — the run's cycle binding, carried through to the index
   *  row's cycle chip and the run detail's byline. Absent → unbound. */
  context?: { cycleId?: number; cycle?: string };
}

function bddRun(id = "evt-bdd-gherkin"): RunFixture {
  return { id, tier: "e2e", codec: "playwright", tree: gherkinTree() };
}

function junitUnitRun(id = "evt-unit-junit"): RunFixture {
  return {
    id,
    tier: "unit",
    codec: "junit",
    tree: [
      {
        name: "SomeUnitSuite",
        status: "pass",
        children: [{ name: "adds two numbers", status: "pass", duration_ms: 2 }],
      },
    ],
  };
}

function summarize(tree: SuiteNode[]): {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
} {
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
  key: string;
  projectType?: "backend" | "frontend";
  runs?: RunFixture[];
  failingDetails?: string[];
}

let healthReachable = true;
let cacheBust = 0;
let mountNow = 0;
const HARNESS_AGENT_ID = "bdd-section-agent";
let fetchLog: string[] = [];
let liveRuns: RunFixture[] = [];
let detailReadFails = new Set<string>();

async function mountApp(opts: MountOpts): Promise<void> {
  liveRuns = [...(opts.runs ?? [])];
  detailReadFails = new Set(opts.failingDetails ?? []);
  healthReachable = true;
  fetchLog = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';

  mountNow = Date.now();
  const now = mountNow;
  const project = {
    key: opts.key,
    name: opts.key,
    type: opts.projectType ?? "frontend",
    agentsOnline: 1,
    agentsTotal: 1,
    active: true,
    lastActivity: now,
  };
  const detailOf = (run: RunFixture): Record<string, unknown> => ({
    id: run.id,
    projectKey: opts.key,
    agentId: run.agentId ?? HARNESS_AGENT_ID,
    kind: "test",
    tier: run.tier,
    codec: run.codec,
    timestamp: now + (run.offsetMs ?? 0),
    context: run.context,
    summary: summarize(run.tree),
    tree: run.tree,
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return okResponse({ ok: true, proposals: [], totalCount: 0 });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: [] });
    }
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    if (eventMatch !== null) {
      const eventId = eventMatch[1] as string;
      if (detailReadFails.has(eventId)) {
        return okResponse({ ok: false, error: "this run's detail could not be read" });
      }
      const run = liveRuns.find((r) => r.id === eventId);
      if (run === undefined) return okResponse({ ok: false, error: "no such event" });
      const detail = detailOf(run);
      const params = new URL(url, "http://localhost").searchParams;
      const suiteParam = params.get("suite");
      if (suiteParam !== null) {
        const match = run.tree.find((n) => n.name === suiteParam);
        return okResponse({
          ok: true,
          event: { ...detail, tree: match !== undefined ? [match] : [] },
        });
      }
      if (params.get("depth") === "suites") {
        return okResponse({
          ok: true,
          event: {
            ...detail,
            tree: run.tree.map((n) => ({
              name: n.name,
              status: n.status,
              counts: {
                passed: n.children.filter((c) => c.status === "pass").length,
                failed: n.children.filter((c) => c.status === "fail").length,
                pending: n.children.filter((c) => c.status === "pending").length,
              },
            })),
          },
        });
      }
      return okResponse({ ok: true, event: detail });
    }
    if (url.includes("/api/v2/projects")) {
      return okResponse({ ok: true, projects: [project] });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) {
      return okResponse({
        ok: true,
        events: liveRuns.map((run) => ({
          id: run.id,
          projectKey: opts.key,
          agentId: run.agentId ?? HARNESS_AGENT_ID,
          kind: "test",
          tier: run.tier,
          codec: run.codec,
          timestamp: now + (run.offsetMs ?? 0),
          context: run.context,
          ...summarize(run.tree),
          hasCoverage: false,
        })),
      });
    }
    if (url.includes("/api/v2/health")) {
      if (!healthReachable) throw new Error("health probe: connection refused");
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    return okResponse({ ok: true });
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?bddSection=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

afterEach(async () => {
  setSystemTime();
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

function tabButton(name: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-tab"]'),
  ).find((el) => norm(el.textContent) === name);
}

async function openBddTab(): Promise<void> {
  const tab = tabButton("BDD");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

async function mountBdd(opts: MountOpts): Promise<void> {
  await mountApp(opts);
  await openBddTab();
}

/** The BDD pane container — the node whose class `greyed()` composes. Still
 *  `[data-testid="workspace-bdd"]`: §S2 replaces its CONTENT with an index,
 *  not the container itself. */
function bddPane(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]');
  if (el === null) {
    throw new Error(
      'no [data-testid="workspace-bdd"] is mounted on the BDD tab (CR-CRU-145 §S2). ' +
        `The mounted central pane renders: ${norm(
          document.querySelector<HTMLElement>(".app-center")?.textContent,
        ).slice(0, 240)}`,
    );
  }
  return el;
}

function bddPaneText(): string {
  const el =
    document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]') ??
    document.querySelector<HTMLElement>(".app-center");
  return norm(el?.textContent);
}

const classTokens = (el: Element): string[] =>
  norm(el.getAttribute("class"))
    .split(" ")
    .filter((t) => t !== "");

function indexRows(): HTMLElement[] {
  return Array.from(bddPane().querySelectorAll<HTMLElement>('[data-testid="bdd-index-row"]'));
}

function paneEmptyStates(): HTMLElement[] {
  const pane =
    document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]') ??
    document.querySelector<HTMLElement>(".app-center");
  const scroll = pane?.querySelector<HTMLElement>('[data-testid="pane-scroll"]') ?? pane;
  return Array.from(scroll?.querySelectorAll<HTMLElement>(".app-empty") ?? []);
}

/** Opens `runId`'s detail via the INDEX row — the hand-off §S2 defines,
 *  never a bespoke direct fetch. Throws a diagnostic naming the missing row
 *  rather than a downstream null-deref, matching this file's house style. */
async function openRunFromIndex(runId: string): Promise<void> {
  const row = indexRows().find((r) => r.getAttribute("data-run-id") === runId);
  if (row === undefined) {
    throw new Error(
      `no [data-testid="bdd-index-row"][data-run-id="${runId}"] on the BDD index; rows present: ` +
        JSON.stringify(indexRows().map((r) => r.getAttribute("data-run-id"))),
    );
  }
  row.click();
  await settle();
}

function runOverlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error('no [data-testid="run-overlay"] mounted after opening a run');
  return el;
}

function suiteRow(scenarioName: string): HTMLElement {
  const found = Array.from(
    runOverlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]'),
  ).find((el) => (el.textContent ?? "").includes(scenarioName));
  if (found === undefined) {
    throw new Error(`no suite-row contains "${scenarioName}" in the run overlay`);
  }
  return found;
}

function leafRowsOf(scenarioName: string): HTMLElement[] {
  const row = suiteRow(scenarioName);
  const group = row.parentElement;
  return Array.from(group?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

function leafText(row: HTMLElement): string {
  const failure = row.querySelector<HTMLElement>('[data-testid="failure-box"]');
  const failureText = failure === null ? "" : norm(failure.textContent);
  const whole = norm(row.textContent);
  return failureText === "" ? whole : norm(whole.replace(failureText, ""));
}

function runByline(): string {
  const node = runOverlay().querySelector<HTMLElement>('[data-testid="run-byline"]');
  if (node === null) {
    throw new Error(
      'the run detail renders no [data-testid="run-byline"]: it does not name the run whose ' +
        "specification it shows — when it was recorded and which agent filed it " +
        `(CR-CRU-145 §S4 AC3). The overlay renders: ${norm(runOverlay().textContent).slice(0, 240)}`,
    );
  }
  return norm(node.textContent);
}

function boardRelativeTime(offsetMs: number): string {
  return relativeTime(mountNow + offsetMs, Date.now());
}

// ──────────────────────────────────────────────────────────────────────────
// NEW — §S4 AC1: `BddFeed` and its siblings are GONE, asserted BY ABSENCE
// (not by inspection). No test in this migration checked this before: the
// 13 original assertions were all triaged to KEEP/DELETE/AMEND, but none of
// them named the retirement itself as a fact to assert. A GREEN that left a
// dead `BddFeed` branch behind (unreachable, unshimmed, but still declared)
// would satisfy every migrated behavioural test above while failing this
// CR's own §S4 AC1 in letter and spirit.
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 AC1 — the bespoke BDD renderer is RETIRED, asserted by absence", () => {
  test("no BddFeed/BddFeature/BddScenario/BddStep/BddRunIdentity declaration survives in public/app.js — no shim, no dead branch, no second path", () => {
    for (const symbol of ["BddFeed", "BddFeature", "BddScenario", "BddStep", "BddRunIdentity"]) {
      expect(APP_JS_SRC).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// KEPT, RE-POINTED — the Gherkin now renders at the run detail, reached via
// the BDD index's own row (§S2's hand-off, not a fork).
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 (migrated from CR-CRU-015 §S3) — the run detail renders an opened run's Gherkin, reached via the BDD index", () => {
  test("MIGRATED #1 — the run's ordered scenario/step content, per-step outcomes, verbatim text — asserted at the renderer the index hands off to", async () => {
    await mountBdd({ key: "bdd-gherkin", runs: [bddRun()] });
    await openRunFromIndex("evt-bdd-gherkin");

    // Both scenarios auto-expand on open without a click: the passing one is
    // the FIRST scenario of the (only) feature, the failing one auto-expands
    // because it fails (§S1's progressive-expansion rule).
    expect(leafRowsOf(PASSING_SCENARIO).map(leafText)).toEqual(PASSING_STEPS);
    expect(leafRowsOf(PASSING_SCENARIO).every((r) => r.className.includes("pass"))).toBe(true);

    expect(leafRowsOf(FAILING_SCENARIO).map(leafText)).toEqual(FAILING_STEPS);
    const failingSteps = leafRowsOf(FAILING_SCENARIO);
    expect(failingSteps[0]!.className).toContain("pass");
    expect(failingSteps[1]!.className).toContain("fail");

    // BOUND — exactly the six steps the run recorded.
    expect(runOverlay().querySelectorAll('[data-testid="leaf-row"]').length).toBe(6);
  });

  test("MIGRATED #2 — a failing scenario carries its failure AT the step that broke, with the message, and nowhere else", async () => {
    await mountBdd({ key: "bdd-failure", runs: [bddRun()] });
    await openRunFromIndex("evt-bdd-gherkin");

    const brokenStep = leafRowsOf(FAILING_SCENARIO).find((r) => leafText(r) === FAILING_STEPS[1]);
    expect(brokenStep).toBeDefined();
    const failureBox = brokenStep!.querySelector<HTMLElement>('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(norm(failureBox!.textContent)).toContain(FAILURE_MESSAGE);

    // BOUND — exactly ONE failure box renders in the whole overlay, and it
    // is not attached to the passing step of the same scenario.
    expect(runOverlay().querySelectorAll('[data-testid="failure-box"]').length).toBe(1);
    const passingStepOfFailingScenario = leafRowsOf(FAILING_SCENARIO).find(
      (r) => leafText(r) === FAILING_STEPS[0],
    );
    expect(passingStepOfFailingScenario).toBeDefined();
    expect(passingStepOfFailingScenario!.querySelector('[data-testid="failure-box"]')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// KEPT, RE-POINTED — the empty state now belongs to the INDEX.
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 (migrated) — the BDD INDEX's own empty state", () => {
  test("MIGRATED #4 — with no BDD-bearing run recorded, the index shows exactly one definitive empty state and no skeleton chrome", async () => {
    await mountBdd({ key: "bdd-empty" });

    const empties = paneEmptyStates();
    expect(empties.length).toBe(1);
    const text = norm(empties[0]!.textContent);
    expect(text.length).toBeGreaterThan(20);
    expect(text.toLowerCase()).toContain("run");
    expect(text).not.toMatch(ANY_PROJECT_CR);
    expect(text).not.toMatch(RELEASE_VERSION);

    expect(indexRows().length).toBe(0);
  });

  test("MIGRATED #5 — a project whose only run is a junit unit run shows the same index empty state — a run without Gherkin is not a BDD run", async () => {
    await mountBdd({ key: "bdd-empty-junit", runs: [junitUnitRun()] });

    expect(paneEmptyStates().length).toBe(1);
    expect(indexRows().length).toBe(0);
    expect(bddPaneText()).not.toContain("SomeUnitSuite");
    expect(bddPaneText()).not.toContain("adds two numbers");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DELETED (documented, not silently dropped) —
//   #3 "the pane never claims the dedicated BDD surface does not exist"
//   #6a "the read that FAILED: stated while it stands, gone when it is stale"
//   #6b "after a failed read, the NEXT run's successful read renders …"
// See this file's header for the reason each one asserted only `BddFeed`'s
// own retired internals, with nothing observable left to re-point.
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// KEPT, RE-POINTED — dimming means liveness, never build state (index-level).
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 (migrated) — the populated INDEX's dimming means liveness, never build state", () => {
  test(
    "MIGRATED #7 — a populated BDD index is NOT greyed while the backend is up, and gains `greyed` only when the shell's own watchdog loses the backend — with its rows still rendered",
    async () => {
      await mountBdd({ key: "bdd-greyed", runs: [bddRun()] });

      expect(indexRows().length).toBe(1);
      expect(classTokens(bddPane())).toContain("app-center");
      expect(classTokens(bddPane())).not.toContain("greyed");

      healthReachable = false;
      try {
        setSystemTime(new Date(Date.now() + 60_000));
        await sleep(6_000);
        await settle();
      } finally {
        setSystemTime();
      }

      expect(classTokens(bddPane())).toContain("greyed");
      // The index's OWN content survives the dimming — a dimmed pane is a
      // STALE pane, never an unbuilt one.
      expect(indexRows().length).toBe(1);
    },
    30_000,
  );

  test("MIGRATED #8 (UNCHANGED — never referenced BddFeed's internals) — on a backend project BDD is gated ON THE TAB — disabled, unclickable, pane never mounts — and no pane is dimmed for it", async () => {
    await mountApp({ key: "bdd-gated", projectType: "backend" });

    const tab = tabButton("BDD");
    expect(tab).toBeDefined();
    expect(tab!.disabled).toBe(true);
    expect(classTokens(tab!)).toContain("disabled");

    tab!.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-bdd"]')).toBeNull();
    expect(classTokens(tab!)).not.toContain("on");

    const mounted = document.querySelector<HTMLElement>(".app-center");
    expect(mounted).not.toBeNull();
    expect(classTokens(mounted!)).not.toContain("greyed");
    // RE-PINNED 2026-10 (approved by the orchestrator, user ruling
    // 2026-10-07): the pane stays on the landing tab, which for this idle
    // fixture (no open plan, no gate in flight) is now Roadmap (was: Workflow).
    expect(tabButton("Roadmap")).toBeDefined();
    expect(classTokens(tabButton("Roadmap")!)).toContain("on");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// KEPT UNCHANGED — pure `workspaceTabs()` rail, born green (same precedent
// tests/ci-toolchain-provisioning.test.ts's header states): populating the
// tab is exactly the change that could un-gate it by accident.
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 (migrated, UNCHANGED) — the BDD tab stays frontend-only (RAIL, born green)", () => {
  test("MIGRATED #9 — workspaceTabs disables BDD for a backend project and enables it for a frontend one", () => {
    const backend = workspaceTabs({ type: "backend" }).find((t) => t.name === "BDD");
    expect(backend).toBeDefined();
    expect(backend!.disabled).toBe(true);

    const frontend = workspaceTabs({ type: "frontend" }).find((t) => t.name === "BDD");
    expect(frontend).toBeDefined();
    expect(frontend!.disabled).toBe(false);

    const backendTabs = workspaceTabs({ type: "backend" }).filter(
      (t) => t.name !== "BDD" && t.name !== "Coverage",
    );
    expect(backendTabs.length).toBeGreaterThan(0);
    for (const t of backendTabs) expect(t.disabled).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// KEPT, RE-POINTED (+ RE-INTERPRETED for #11) — the C3 byline moves WITH the
// renderer (§S4 AC3): whoever renders a playwright run's specification names
// WHO filed it, WHEN, and follows the subject.
// ──────────────────────────────────────────────────────────────────────────

const FILER_ALPHA = "e2e-runner-alpha";
const FILER_BRAVO = "e2e-runner-bravo";
const FILER_CHARLIE = "e2e-runner-charlie";

const AGED_OFFSET_MS = -(2 * 3600 + 1800) * 1000;
const OLDER_OFFSET_MS = -(3 * 3600 + 1800) * 1000;
const NEWER_OFFSET_MS = -(1 * 3600 + 1800) * 1000;
const TALLY_OFFSET_MS = -(6 * 3600 + 1800) * 1000;
const BYSTANDER_OFFSET_MS = -(20 * 3600 + 1800) * 1000;

const NEWER_FEATURE_TITLE = "Superseding Run Feature";
const NEWER_SCENARIO = "the newer run's own specification renders";
const NEWER_STEPS = [
  "Given a newer BDD run is filed for the same project",
  "When the shell's own poll re-reads the project's feed",
  "Then the section renders THIS run's specification",
];

function newerBddRun(): RunFixture {
  return {
    id: "evt-bdd-newer",
    tier: "e2e",
    codec: "playwright",
    agentId: FILER_BRAVO,
    offsetMs: NEWER_OFFSET_MS,
    tree: [
      {
        name: `${NEWER_FEATURE_TITLE} › ${NEWER_SCENARIO}`,
        status: "pass",
        children: NEWER_STEPS.map((name, i) => ({
          name,
          status: "pass" as const,
          duration_ms: 7 + i,
        })),
      },
    ],
  };
}

const TALLY_FEATURE_TITLE = "Tally Bound Feature";
const TALLY_CASES = ["one", "two", "three", "four", "five"];
const TALLY_PASSED = 13;
const TALLY_FAILED = 5;
const TALLY_TOTAL = 18;
// CORRECTED against C2 GREEN's settled progressive-expansion rule
// (a25ff4e, public/app.js `openProgressively`/`specFeaturesOf`): the ONE
// feature here is opened (it is both the only and the failing feature), but
// ONLY a scenario that is failing OR among its first SPEC_FIRST_OPEN (2)
// scenarios loads its steps on open. The 5 failing "case breaks" scenarios
// already fill (and exceed) that window, so the 6th, all-green "clean path"
// scenario's row renders but stays FOLDED — its steps are never fetched
// until it scrolls into view or is clicked. The DOM therefore shows exactly
// the failing scenarios' own steps on open, not the run's full step count.
const TALLY_VISIBLE_LEAF_ROWS = TALLY_CASES.length * 3; // 5 failing scenarios × 3 steps each

function tallyRun(): RunFixture {
  const broken: SuiteNode[] = TALLY_CASES.map((word) => ({
    name: `${TALLY_FEATURE_TITLE} › the ${word} case breaks`,
    status: "fail" as const,
    children: [
      { name: "Given the suite is prepared", status: "pass" as const, duration_ms: 3 },
      { name: `When it exercises the ${word} case`, status: "pass" as const, duration_ms: 3 },
      {
        name: `Then the ${word} case reports its outcome`,
        status: "fail" as const,
        duration_ms: 3,
        failure: { message: `the ${word} case never reached its assertion` },
      },
    ],
  }));
  return {
    id: "evt-bdd-tally",
    tier: "e2e",
    codec: "playwright",
    agentId: FILER_CHARLIE,
    offsetMs: TALLY_OFFSET_MS,
    tree: [
      ...broken,
      {
        name: `${TALLY_FEATURE_TITLE} › the clean path still runs to the end`,
        status: "pass",
        children: [
          { name: "Given the clean path is prepared", status: "pass", duration_ms: 2 },
          { name: "When it runs to the end", status: "pass", duration_ms: 2 },
          { name: "Then every step of it passes", status: "pass", duration_ms: 2 },
        ],
      },
    ],
  };
}

describe("CR-CRU-145 §S4 (migrated) — the run detail names the run whose specification it renders", () => {
  test("MIGRATED #10 — an opened run's detail names WHEN it was recorded, in the board's own relative-time idiom, and WHICH agent filed it", async () => {
    await mountBdd({
      key: "bdd-run-identity",
      runs: [{ ...bddRun("evt-bdd-identity"), agentId: FILER_ALPHA, offsetMs: AGED_OFFSET_MS }],
    });
    await openRunFromIndex("evt-bdd-identity");

    const identity = runByline();

    const recordedAt = boardRelativeTime(AGED_OFFSET_MS);
    expect(recordedAt).not.toBe("just now");
    expect(identity).toContain(recordedAt);

    expect(identity).toContain(FILER_ALPHA);
    expect(identity).not.toContain(HARNESS_AGENT_ID);

    expect(runOverlay().querySelectorAll('[data-testid="run-byline"]').length).toBe(1);
    expect(identity).not.toContain(String(mountNow + AGED_OFFSET_MS));
    expect(identity).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  }, 20_000);

  test("MIGRATED #11 (RE-INTERPRETED — see this file's header) — the byline FOLLOWS THE SUBJECT: opening a DIFFERENT run's detail names THAT run, never a stale one", async () => {
    const older = { ...bddRun("evt-bdd-older"), agentId: FILER_ALPHA, offsetMs: OLDER_OFFSET_MS };
    const newer = newerBddRun();
    await mountBdd({ key: "bdd-run-identity-follows", runs: [older, newer] });

    await openRunFromIndex("evt-bdd-older");
    expect(runByline()).toContain(FILER_ALPHA);
    expect(runByline()).toContain(boardRelativeTime(OLDER_OFFSET_MS));
    expect(leafRowsOf(PASSING_SCENARIO).length).toBeGreaterThan(0);

    // Close the run and open the NEWER one's own detail — the SAME index,
    // a DIFFERENT row.
    document.querySelector<HTMLElement>('[data-testid="run-overlay"] .app-chip')?.click();
    await settle();
    await openBddTab();
    await openRunFromIndex("evt-bdd-newer");

    expect(leafRowsOf(NEWER_SCENARIO).map(leafText)).toEqual(NEWER_STEPS);

    const identity = runByline();
    expect(identity).toContain(FILER_BRAVO);
    expect(identity).toContain(boardRelativeTime(NEWER_OFFSET_MS));

    // NEGATIVE — the newer run's OWN detail never carries the older run's
    // filer or timestamp.
    expect(identity).not.toContain(FILER_ALPHA);
    expect(identity).not.toContain(boardRelativeTime(OLDER_OFFSET_MS));
    expect(runOverlay().querySelectorAll('[data-testid="run-byline"]').length).toBe(1);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// AMENDED — the no-tally bound is SUPERSEDED (§S4's own instruction): counts
// are now the specification's own content (index verdict, run detail
// summary). What survives is that the BDD tab never reproduces the Runs
// timeline's OWN card grammar.
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-145 §S4 (AMENDED, was 'NAMED never TALLIED') — the index shows counts, but never the Runs timeline's own card grammar", () => {
  test("MIGRATED+AMENDED #13 — a run with failures is named AND its counts render on the index row, but the index draws no event-card/ratio-pill and no full Gherkin of its own", async () => {
    const run = tallyRun();
    expect(summarize(run.tree)).toMatchObject({
      total: TALLY_TOTAL,
      passed: TALLY_PASSED,
      failed: TALLY_FAILED,
    });

    await mountBdd({
      key: "bdd-run-identity-tally",
      runs: [
        { ...bddRun("evt-bdd-bystander"), agentId: FILER_ALPHA, offsetMs: BYSTANDER_OFFSET_MS },
        run,
      ],
    });

    // POSITIVE — the index row for the tally run carries its own counts
    // (F11 A: "its verdict with counts") — this is the superseding rule,
    // not the old refusal.
    const tallyRow = indexRows().find((r) => r.getAttribute("data-run-id") === "evt-bdd-tally");
    expect(tallyRow).toBeDefined();
    const verdict = norm(
      tallyRow!.querySelector('[data-testid="bdd-index-verdict"]')?.textContent,
    );
    expect(verdict).toContain(String(TALLY_PASSED));
    expect(verdict).toContain(String(TALLY_FAILED));

    // POSITIVE — it is named too (who/when), on the SAME row.
    expect(norm(tallyRow!.textContent)).toContain(FILER_CHARLIE);

    // BOUND — the index draws NO Runs-timeline card grammar: no
    // `event-card`, no `ratio-pill`, anywhere in the BDD pane.
    expect(bddPane().querySelectorAll('[data-testid="event-card"]').length).toBe(0);
    expect(bddPane().querySelectorAll('[data-testid="ratio-pill"]').length).toBe(0);

    // BOUND — the index itself renders no full Gherkin of the tally run:
    // opening its detail is what reveals the steps, not the index row.
    expect(bddPane().querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);

    // Opening the row reveals the specification — but per §S1's settled
    // progressive-expansion rule (C2 GREEN), that means the FAILING
    // scenarios' steps immediately, not literally every step of the run:
    // the one all-green "clean path" scenario stays folded until scrolled
    // into view or clicked. This still proves the counts-forbidden rule
    // really did move (opening reveals real Gherkin content), without
    // asserting a figure no correct implementation could ever produce.
    await openRunFromIndex("evt-bdd-tally");
    const cleanPathRow = Array.from(
      runOverlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]'),
    ).find((el) => (el.textContent ?? "").includes("the clean path still runs to the end"));
    expect(cleanPathRow).toBeDefined();
    expect(
      cleanPathRow!.parentElement?.querySelectorAll('[data-testid="leaf-row"]').length,
    ).toBe(0);
    expect(runOverlay().querySelectorAll('[data-testid="leaf-row"]').length).toBe(
      TALLY_VISIBLE_LEAF_ROWS,
    );
  }, 20_000);
});
