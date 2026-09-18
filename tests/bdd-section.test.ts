// CR-CRU-015 §S3 (cycle 491, RED) — the BDD section renders the GHERKIN of a
// real ingested run: the feature, its scenarios, and each scenario's ordered
// steps with each step's own outcome. Not a tally, not a second Runs timeline.
//
// MEASURED ON THIS BRANCH BEFORE THE FIX (7d90f87):
//   public/app.js:2638 `BddFeed` renders ONE string and nothing else —
//   "BDD run results already stream into the Runs timeline — a dedicated BDD
//   surface does not exist yet" (:2644-2645), wrapped by `BddPlaceholder`
//   (:2650) in `greyed("app-center")`. `public/app.js:4841` already dispatches
//   `state.workspaceTab === "BDD"` to it, so the route and the tab have
//   existed since CR-CRU-007 and only the CONTENT is absent.
//
// HARNESS — the house idiom for every pane test in this repo
// (tests/project-independence-strings.test.ts, tests/drill-in.test.ts,
// tests/playwright-codec.test.ts's DOM block, tests/workspace-rail-collapse
// .test.ts): real VanJS/VanX vendor bundles, the real public/app-logic.mjs and
// the real public/app.js inside a happy-dom window, with `fetch` scripted to
// serve canned v2 payloads — including the progressive `?depth=suites` /
// `?suite=<name>` event-detail contract, so whichever depth strategy the
// section uses to read a run's tree finds real data.
//
// THE FIXTURE IS THE CODEC'S OWN OUTPUT SHAPE, proven in C1 by
// tests/playwright-codec.test.ts: one suite node per scenario named
// `<Feature title> › <Scenario title>`, one leaf per Gherkin step IN ORDER
// with the LITERAL step line as its name (`And` verbatim), per-step status,
// `failure.message` on the broken step, and NO leaves after a break.
//
// CONTRACT THIS FILE DEFINES FOR GREEN (identifiers verbatim):
//   • `[data-testid="workspace-bdd"]` — the BDD pane container, mirroring
//     `workspace-runs`: `greyed("app-center")`, i.e. it carries `greyed` when
//     and ONLY when the backend is unreachable (public/app.js's `greyed()` is
//     `() => state.backendUp ? cls : cls + " greyed"`).
//   • `[data-testid="bdd-feature"]` — one node per feature, holding
//     `[data-testid="bdd-feature-title"]` with the feature title verbatim.
//   • `[data-testid="bdd-scenario"]` — one node per scenario, inside its
//     feature, holding `[data-testid="bdd-scenario-title"]` with the SCENARIO
//     title alone (the codec's `<Feature> › ` prefix is split, never repeated
//     per row), and `data-bdd-status` ∈ pass|fail|pending.
//   • `[data-testid="bdd-step"]` — one node per Gherkin step, in step order,
//     whose text is the literal step line, carrying its OWN outcome in
//     `data-bdd-status` ∈ pass|fail|pending.
//   • `[data-testid="bdd-step-failure"]` — the failure message, rendered
//     INSIDE the `bdd-step` that failed.
//   • the no-run case renders exactly one `.app-empty` inside the pane's
//     `[data-testid="pane-scroll"]` — the same locator CR-CRU-097's shipped
//     guard (tests/project-independence-strings.test.ts) reads.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { workspaceTabs } from "../public/app-logic.mjs";

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

/** CR-CRU-097 AC1's two rules, restated here so §S3's own empty state is
 *  railed from this side too rather than only by the shipped guard. */
const ANY_PROJECT_CR = /CR-[A-Z]{2,}-\d+/;
const RELEASE_VERSION = /\b\d+\.\d+(?:\.\d+)?\b/;

const FEATURE_TITLE = "Gherkin Rendering Feature";
const PASSING_SCENARIO = "a passing scenario renders every step";
const FAILING_SCENARIO = "a failing scenario stops at the broken step";
const FAILURE_MESSAGE = "expect(received).toBe(expected) — the step never rendered";

/** The shared first step line, IDENTICAL in both scenarios on purpose: a
 *  section that looked steps up globally instead of within their own scenario
 *  would render it once and fail the ordered reads below. */
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

/** The tree `src/codecs/playwright.ts` produces for a two-scenario feature —
 *  the exact shape C1 proved and stored, including the codec's rule that a
 *  broken scenario has NO leaves after the break. */
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
  /** Milliseconds AFTER the mount clock this run was recorded — the shell
   *  picks the BDD run with the greatest timestamp, so a run that arrives
   *  later in a project's life says so here. */
  offsetMs?: number;
}

/** A playwright-coded `e2e` run — what a real `bun-crucible.py e2e` drive of
 *  this repo's own BDD suite has filed since C1. */
function bddRun(id = "evt-bdd-gherkin"): RunFixture {
  return { id, tier: "e2e", codec: "playwright", tree: gherkinTree() };
}

/** A run with no Gherkin in it at all — the negative fixture for the empty
 *  state: a junit-coded unit run is not a BDD run, whatever else it is. */
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
  /** Event ids whose DETAIL read the board refuses — the run is in the feed
   *  (so the section picks it) and reading its Gherkin fails. */
  failingDetails?: string[];
}

/** AC7's driver, and the reason `healthReachable` is module state: the shell
 *  owns exactly ONE writer that can take `state.backendUp` down —
 *  `watchdogTick`, which probes `/api/v2/health` after >20s of stream silence
 *  — so liveness is flipped by failing that probe, never by assigning the
 *  flag (technique lifted from tests/workspace-rail-collapse.test.ts). */
let healthReachable = true;
let cacheBust = 0;
let fetchLog: string[] = [];

/** The project's runs AS THE BOARD HOLDS THEM RIGHT NOW — module state, not a
 *  mount-time constant, so a test can file a LATER run into a live pane the
 *  way a real ingest does, without remounting the section (remounting is the
 *  workaround under test: it rebuilds the pane's own state). */
let liveRuns: RunFixture[] = [];

/** Event ids whose detail read the board currently refuses. */
let detailReadFails = new Set<string>();

async function mountApp(opts: MountOpts): Promise<void> {
  liveRuns = [...(opts.runs ?? [])];
  detailReadFails = new Set(opts.failingDetails ?? []);
  healthReachable = true;
  fetchLog = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';

  const now = Date.now();
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
    agentId: "bdd-section-agent",
    kind: "test",
    tier: run.tier,
    codec: run.codec,
    timestamp: now + (run.offsetMs ?? 0),
    summary: summarize(run.tree),
    tree: run.tree,
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    // Order matters: the sub-collection routes all contain "/api/v2/projects",
    // and the event-detail route is a prefix of the event LIST route.
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
          agentId: "bdd-section-agent",
          kind: "test",
          tier: run.tier,
          codec: run.codec,
          timestamp: now + (run.offsetMs ?? 0),
          ...summarize(run.tree),
          hasCoverage: false,
        })),
      });
    }
    if (url.includes("/api/v2/health")) {
      if (!healthReachable) throw new Error("health probe: connection refused");
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    // Permissive rather than throwing: an unanticipated poll must not decide
    // this file's verdict — the subject is what the BDD pane RENDERS.
    return okResponse({ ok: true });
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  // Dynamic import with a cache-bust query, the house harness pattern: each
  // mount must evaluate a FRESH public/app-logic.mjs against the freshly
  // registered happy-dom globals.
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?bddSection=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately — the production shell schedules its renders
 *  through VanJS's own pipeline inside happy-dom (same choice the sibling
 *  pane harnesses make). */
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

/** The BDD pane container — the node whose class `greyed()` composes. */
function bddPane(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]');
  if (el === null) {
    throw new Error(
      'no [data-testid="workspace-bdd"] is mounted on the BDD tab (CR-CRU-015 §S3). ' +
        `The mounted central pane renders: ${norm(
          document.querySelector<HTMLElement>(".app-center")?.textContent,
        ).slice(0, 240)}`,
    );
  }
  return el;
}

/** Whatever the BDD tab has mounted, however unbuilt — used by the tests that
 *  read the pane's TEXT rather than its structure, so they report the real
 *  copy instead of throwing on a missing testid. */
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

function featureBlocks(): HTMLElement[] {
  return Array.from(bddPane().querySelectorAll<HTMLElement>('[data-testid="bdd-feature"]'));
}

function scenarioBlocks(root: ParentNode = bddPane()): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="bdd-scenario"]'));
}

function scenarioTitles(root: ParentNode = bddPane()): string[] {
  return scenarioBlocks(root).map((s) =>
    norm(s.querySelector<HTMLElement>('[data-testid="bdd-scenario-title"]')?.textContent),
  );
}

function scenarioBlock(title: string): HTMLElement {
  const found = scenarioBlocks().find(
    (s) =>
      norm(s.querySelector<HTMLElement>('[data-testid="bdd-scenario-title"]')?.textContent) ===
      title,
  );
  if (found === undefined) {
    throw new Error(
      `the BDD section renders no scenario titled "${title}"; it renders: ` +
        `${JSON.stringify(scenarioTitles())}`,
    );
  }
  return found;
}

function stepRows(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="bdd-step"]'));
}

/** A step row's own text, with any rendered failure message stripped out, so
 *  the step LINE is compared rather than the line plus its diagnostics. */
function stepText(row: HTMLElement): string {
  const failure = row.querySelector<HTMLElement>('[data-testid="bdd-step-failure"]');
  const failureText = failure === null ? "" : norm(failure.textContent);
  const whole = norm(row.textContent);
  return failureText === "" ? whole : norm(whole.replace(failureText, ""));
}

function stepLines(root: ParentNode): string[] {
  return stepRows(root).map(stepText);
}

function stepStatuses(root: ParentNode): Array<string | null> {
  return stepRows(root).map((r) => r.getAttribute("data-bdd-status"));
}

function paneEmptyStates(): HTMLElement[] {
  const pane =
    document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]') ??
    document.querySelector<HTMLElement>(".app-center");
  const scroll = pane?.querySelector<HTMLElement>('[data-testid="pane-scroll"]') ?? pane;
  return Array.from(scroll?.querySelectorAll<HTMLElement>(".app-empty") ?? []);
}

// ──────────────────────────────────────────────────────────────────────────
// §S3 AC1/AC2/AC4/AC5 — the section renders the Gherkin
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-015 §S3 — the BDD tab renders an ingested run's Gherkin", () => {
  test("renders the feature title once, its scenario titles in order, and each scenario's own ordered step lines with per-step outcomes", async () => {
    await mountBdd({ key: "bdd-gherkin", runs: [bddRun()] });

    // The FEATURE is a heading of its own, named once — the codec's
    // "<Feature> › <Scenario>" node name is split, not printed per row.
    const features = featureBlocks();
    expect(features.length).toBe(1);
    expect(
      norm(
        features[0]!.querySelector<HTMLElement>('[data-testid="bdd-feature-title"]')?.textContent,
      ),
    ).toBe(FEATURE_TITLE);

    // Both scenarios, in the run's own order, titled by their SCENARIO half.
    expect(scenarioTitles(features[0]!)).toEqual([PASSING_SCENARIO, FAILING_SCENARIO]);
    for (const title of scenarioTitles()) expect(title).not.toContain("›");

    // Each scenario's steps, IN ORDER, with the literal Gherkin line — `And`
    // preserved verbatim — read within their own scenario block.
    const passing = scenarioBlock(PASSING_SCENARIO);
    expect(stepLines(passing)).toEqual(PASSING_STEPS);
    expect(stepStatuses(passing)).toEqual(["pass", "pass", "pass", "pass"]);

    const failing = scenarioBlock(FAILING_SCENARIO);
    expect(stepLines(failing)).toEqual(FAILING_STEPS);
    // Per-step outcome, not a scenario verdict smeared over its steps.
    expect(stepStatuses(failing)).toEqual(["pass", "fail"]);

    // BOUND — exactly the six steps the run recorded: no seventh row invented
    // after the break (the codec emits no leaves past a failed step), and no
    // scenario collapsed into a count.
    expect(stepRows(bddPane()).length).toBe(6);

    // NEGATIVE — this is the Gherkin, not a tally and not a second Runs
    // timeline: no event cards, no ratio pills in the BDD pane.
    expect(bddPane().querySelectorAll('[data-testid="event-card"]').length).toBe(0);
    expect(bddPane().querySelectorAll('[data-testid="ratio-pill"]').length).toBe(0);
  });

  test("a failing scenario carries its failure AT the step that broke, with the message, and nowhere else", async () => {
    await mountBdd({ key: "bdd-failure", runs: [bddRun()] });

    const failing = scenarioBlock(FAILING_SCENARIO);
    expect(failing.getAttribute("data-bdd-status")).toBe("fail");
    expect(scenarioBlock(PASSING_SCENARIO).getAttribute("data-bdd-status")).toBe("pass");

    // POSITIVE — the failure renders INSIDE the broken step, carrying the
    // message the codec preserved.
    const brokenStep = stepRows(failing).find((r) => stepText(r) === FAILING_STEPS[1]);
    expect(brokenStep).toBeDefined();
    const failureNode = brokenStep!.querySelector<HTMLElement>('[data-testid="bdd-step-failure"]');
    expect(failureNode).not.toBeNull();
    expect(norm(failureNode!.textContent)).toContain(FAILURE_MESSAGE);

    // BOUND — exactly ONE failure is rendered in the whole pane, and it is not
    // attached to the passing step of the same scenario nor to any step of the
    // passing scenario. "Which step broke" is the whole point.
    expect(bddPane().querySelectorAll('[data-testid="bdd-step-failure"]').length).toBe(1);
    const passingStepOfFailingScenario = stepRows(failing).find(
      (r) => stepText(r) === FAILING_STEPS[0],
    );
    expect(passingStepOfFailingScenario).toBeDefined();
    expect(
      passingStepOfFailingScenario!.querySelector('[data-testid="bdd-step-failure"]'),
    ).toBeNull();
    expect(
      scenarioBlock(PASSING_SCENARIO).querySelectorAll('[data-testid="bdd-step-failure"]').length,
    ).toBe(0);
  });

  // AC4 — the note is DELETED. Asserted on the RENDERED DOM in BOTH states
  // (populated and empty), never on app.js source, so a surviving code comment
  // cannot fail it and moving the sentence into a variable cannot pass it.
  test("the pane never claims the dedicated BDD surface does not exist — populated or empty", async () => {
    await mountBdd({ key: "bdd-claim-populated", runs: [bddRun()] });
    const populated = bddPaneText();
    expect(populated.length).toBeGreaterThan(0);
    expect(populated).not.toContain("a dedicated BDD surface does not exist yet");
    expect(populated).not.toMatch(/surface[\s\S]{0,40}does not exist/i);

    await mountBdd({ key: "bdd-claim-empty" });
    const empty = bddPaneText();
    expect(empty.length).toBeGreaterThan(0);
    expect(empty).not.toContain("a dedicated BDD surface does not exist yet");
    expect(empty).not.toMatch(/surface[\s\S]{0,40}does not exist/i);
  });

  // AC5 — CR-CRU-078's empty-state rule: ONE definitive empty state, no
  // skeleton chrome, and (CR-CRU-097 AC1) no CR id and no release version.
  test("with no run recorded the tab shows exactly one definitive empty state and no skeleton Gherkin chrome", async () => {
    await mountBdd({ key: "bdd-empty" });

    const empties = paneEmptyStates();
    expect(empties.length).toBe(1);
    const text = norm(empties[0]!.textContent);
    // Definitive: a statement, not a dash, a spinner or a loading placeholder.
    expect(text.length).toBeGreaterThan(20);
    expect(text.toLowerCase()).toContain("run");
    expect(text).not.toMatch(ANY_PROJECT_CR);
    expect(text).not.toMatch(RELEASE_VERSION);

    // No skeleton chrome — CR-CRU-078: an empty surface draws the empty state
    // and NOTHING else.
    expect(featureBlocks().length).toBe(0);
    expect(scenarioBlocks().length).toBe(0);
    expect(stepRows(bddPane()).length).toBe(0);
  });

  test("a project whose only run is a junit unit run shows the same empty state — a run without Gherkin is not a BDD run", async () => {
    await mountBdd({ key: "bdd-empty-junit", runs: [junitUnitRun()] });

    expect(paneEmptyStates().length).toBe(1);
    expect(featureBlocks().length).toBe(0);
    expect(stepRows(bddPane()).length).toBe(0);
    // BOUND — and it certainly does not render the unit suite's own names as
    // if they were Gherkin.
    expect(bddPaneText()).not.toContain("SomeUnitSuite");
    expect(bddPaneText()).not.toContain("adds two numbers");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §S3 — the read that FAILED: stated while it stands, gone when it is stale
//
// The pane reads the run's tree itself, so a refused read is a state of its
// own — and the two branches that state it were the only changed code paths
// with no coverage. The second test is the REGRESSION test for a sticky
// error: the failure flag short-circuits the render, so a failure that is
// never cleared makes a LATER, perfectly readable run render the earlier
// run's error until the operator switches tabs and back (which rebuilds the
// pane's state — the workaround, deliberately not used here).
// ──────────────────────────────────────────────────────────────────────────

/** Polls the mounted pane until `done()` holds, the way the shell's own poll
 *  fallback re-reads the feed — real timers, no state assigned by hand. */
async function waitFor(done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await sleep(500);
    await settle();
  }
}

describe("CR-CRU-015 §S3 — the BDD pane states a failed read, and a newer run supersedes it", () => {
  test("a run whose Gherkin the board cannot return renders an explicit failure — never the no-run empty state, and no half-drawn Gherkin", async () => {
    // The no-run copy, read from the shell itself rather than pinned here, so
    // the comparison below is about WHICH state is rendered and not about
    // anybody's wording.
    await mountBdd({ key: "bdd-read-fails-control" });
    const noRunCopy = norm(paneEmptyStates()[0]!.textContent);
    expect(noRunCopy.length).toBeGreaterThan(20);

    await mountBdd({
      key: "bdd-read-fails",
      runs: [bddRun("evt-bdd-unreadable")],
      failingDetails: ["evt-bdd-unreadable"],
    });

    await waitFor(() => /unavailable|failed|could not/i.test(norm(paneEmptyStates()[0]?.textContent)), 5_000);
    const empties = paneEmptyStates();
    expect(empties.length).toBe(1);
    const stated = norm(empties[0]!.textContent);
    // A run IS in the feed, so "no run yet" would be a lie: the pane says the
    // read failed instead.
    expect(stated).not.toBe(noRunCopy);
    expect(stated).toMatch(/unavailable|failed|could not/i);

    // …and nothing is half-drawn beside it: no feature, no scenario, no step.
    expect(featureBlocks().length).toBe(0);
    expect(scenarioBlocks().length).toBe(0);
    expect(stepRows(bddPane()).length).toBe(0);
  }, 20_000);

  test("after a failed read, the NEXT run's successful read renders its Gherkin — the error does not stick to the pane", async () => {
    const stale = { ...bddRun("evt-bdd-stale"), offsetMs: -60_000 };
    await mountBdd({ key: "bdd-read-recovers", runs: [stale], failingDetails: [stale.id] });

    // PRECONDITION — the pane really is in the failed state.
    await waitFor(() => /unavailable|failed|could not/i.test(norm(paneEmptyStates()[0]?.textContent)), 5_000);
    expect(norm(paneEmptyStates()[0]!.textContent)).toMatch(/unavailable|failed|could not/i);
    expect(featureBlocks().length).toBe(0);

    // A NEWER run is ingested for the same project and its read succeeds —
    // filed into the live feed, with the pane left exactly as it is.
    liveRuns = [stale, bddRun("evt-bdd-fresh")];
    await waitFor(() => featureBlocks().length > 0);

    // The newer run's Gherkin renders, and the older run's error is gone.
    expect(featureBlocks().length).toBe(1);
    expect(scenarioTitles()).toEqual([PASSING_SCENARIO, FAILING_SCENARIO]);
    expect(stepLines(scenarioBlock(PASSING_SCENARIO))).toEqual(PASSING_STEPS);
    expect(paneEmptyStates().length).toBe(0);
  }, 40_000);
});

// ──────────────────────────────────────────────────────────────────────────
// §S3 AC7 — greyed-because-unreachable vs gated-on-the-tab
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-015 §S3 — the populated section's dimming means liveness, never build state", () => {
  test(
    "a populated BDD pane is NOT greyed while the backend is up, and gains `greyed` only when the shell's own watchdog loses the backend — with its Gherkin still rendered",
    async () => {
      await mountBdd({ key: "bdd-greyed", runs: [bddRun()] });

      // The pane is populated — so "not greyed" is a statement about a
      // rendered surface, not about an absent one.
      expect(featureBlocks().length).toBe(1);
      expect(stepRows(bddPane()).length).toBe(6);
      expect(classTokens(bddPane())).toContain("app-center");
      expect(classTokens(bddPane())).not.toContain("greyed");

      // Flip liveness the way the shell does — `watchdogTick` probes
      // /api/v2/health after >20s of stream silence and only a FAILING probe
      // flips the flag. Nothing here assigns `state.backendUp`.
      healthReachable = false;
      try {
        setSystemTime(new Date(Date.now() + 60_000));
        await sleep(6_000); // the watchdog ticks every 5s
        await settle();
      } finally {
        setSystemTime();
      }

      // `greyed` arrives with the liveness loss — and the Gherkin is still
      // there: a dimmed pane is a stale pane, never an unbuilt one.
      expect(classTokens(bddPane())).toContain("greyed");
      expect(featureBlocks().length).toBe(1);
      expect(stepLines(scenarioBlock(PASSING_SCENARIO))).toEqual(PASSING_STEPS);
    },
    30_000,
  );

  test("on a backend project BDD is gated ON THE TAB — disabled, unclickable, pane never mounts — and no pane is dimmed for it", async () => {
    await mountApp({ key: "bdd-gated", projectType: "backend" });

    const tab = tabButton("BDD");
    expect(tab).toBeDefined();
    expect(tab!.disabled).toBe(true);
    expect(classTokens(tab!)).toContain("disabled");

    tab!.click();
    await settle();

    // The gate holds: the BDD pane never mounts and the tab never activates.
    expect(document.querySelector('[data-testid="workspace-bdd"]')).toBeNull();
    expect(classTokens(tab!)).not.toContain("on");

    // …and the gate is expressed ONLY there: the pane the workspace DID mount
    // (the shell's `Workflow` default, public/app.js's initial state) is not
    // dimmed, so a dimmed pane can never be read as "this project is gated out
    // of a tab".
    const mounted = document.querySelector<HTMLElement>(".app-center");
    expect(mounted).not.toBeNull();
    expect(classTokens(mounted!)).not.toContain("greyed");
    expect(tabButton("Workflow")).toBeDefined();
    expect(classTokens(tabButton("Workflow")!)).toContain("on");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §S3 AC6 — the frontend-only gate: A RAIL, BORN GREEN.
//
// public/app-logic.mjs:300-314 already returns `disabled: name === "BDD" &&
// project.type !== "frontend"`, so these assertions pass on the tree as it
// stands. They are written anyway and declared as such — the same precedent
// tests/ci-toolchain-provisioning.test.ts's header states for a guard whose
// subject is already correct: populating a section is exactly the change that
// un-gates one by accident, and a rail that was never red is the only kind of
// test that can catch that.
// ──────────────────────────────────────────────────────────────────────────

describe("CR-CRU-015 §S3 — the BDD tab stays frontend-only (RAIL, born green)", () => {
  test("workspaceTabs disables BDD for a backend project and enables it for a frontend one", () => {
    const backend = workspaceTabs({ type: "backend" }).find((t) => t.name === "BDD");
    expect(backend).toBeDefined();
    expect(backend!.disabled).toBe(true);

    const frontend = workspaceTabs({ type: "frontend" }).find((t) => t.name === "BDD");
    expect(frontend).toBeDefined();
    expect(frontend!.disabled).toBe(false);

    // BOUND — the gate is BDD's alone: populating the section must not gate
    // (or un-gate) any other tab on project type. Coverage gates on its own
    // rule (`latestCoverageEventId`) and is excluded here.
    const backendTabs = workspaceTabs({ type: "backend" }).filter(
      (t) => t.name !== "BDD" && t.name !== "Coverage",
    );
    expect(backendTabs.length).toBeGreaterThan(0);
    for (const t of backendTabs) expect(t.disabled).toBe(false);
  });
});
