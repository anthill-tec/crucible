// Heat-strip reveal in a specification run: the feature unfold. Same
// happy-dom harness pattern as tests/heat-cell-reveal.test.ts: real
// production public/app.js, real public/app-logic.mjs, real VanJS/VanX
// vendor bundles; `fetch` is scripted.
//
// The run is served as the board serves a streamed `playwright-bdd` run (its
// served shape read off a real board once, then modelled here): the run
// detail carries codec `crucible-events` and framework `playwright-bdd`; its
// `?depth=suites` read lists one suite per feature and browser — `name`,
// `status`, `counts` over its scenarios, `browser`; its
// `?suite=<feature>&browser=<b>` read answers that one suite with its
// scenarios as leaves, each carrying its Gherkin `steps`.
//
// In that shape a heat cell is a SCENARIO: a loaded suite draws one cell per
// scenario, titled `<feature> [<browser>] › <scenario>`; a suite not yet
// loaded draws synthetic cells from its counts, titled
// `<feature> [<browser>]`. The contract this file holds:
//   - a heat cell (loaded `HeatCell` or synthetic `SynthHeatCell`) whose
//     scenario's FEATURE is currently folded opens that feature, so the
//     scenario's row mounts, and reveals it — the row blinks;
//   - a loaded scenario's cell reveals that scenario's own row;
//   - a synthetic cell of a suite not yet loaded loads it and reveals its
//     first failing scenario's row when red, else its first scenario's row;
//   - a feature that is ALREADY open is left open by a reveal elsewhere.
//
// Two fixture techniques this file relies on:
//   - "loaded scenario, then manually refolded": a FAILING feature opens and
//     loads on mount (`openProgressively`); this file folds it by hand
//     (clicking its `feature-heading`, which `toggleFeature` supports) so an
//     already-LOADED scenario sits inside a now-folded feature;
//   - "not-yet-loaded, still loading": this file's own fetch mock can hold a
//     NAMED suite's `?suite=` response pending (never resolving until the
//     test calls `release(...)`) — the "control the async, don't sleep for
//     it" idiom tests/heat-cell-reveal.test.ts's `interceptBlinkTimer` uses
//     for the 10s blink cleanup. A suite still mid-fetch when its feature is
//     folded is a genuine, reachable production race (network latency).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const BROWSER = "chromium";

interface FailureFixture {
  message: string;
}
interface StepFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
/** A scenario: a leaf of its feature's suite, its Gherkin steps under it. */
interface ScenarioFixture extends StepFixture {
  steps: StepFixture[];
}
/** A feature run under one browser: the suite the board stores for it. */
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: ScenarioFixture[];
  browser: string;
}
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  timestamp: number;
  stack: string;
  framework: string;
  codec: string;
  tree: SuiteFixture[];
}
interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  hasCoverage: boolean;
  stack: string;
  framework: string;
}

function countsOf(leaves: StepFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of leaves) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** The run's counts are over its scenarios, as the board counts a playwright-bdd run. */
function briefOf(detail: EventDetailFixture): EventBriefFixture {
  const c = countsOf(detail.tree.flatMap((s) => s.children));
  return {
    id: detail.id,
    projectKey: detail.projectKey,
    agentId: detail.agentId,
    kind: "test",
    tier: detail.tier,
    codec: detail.codec,
    timestamp: detail.timestamp,
    total: c.passed + c.failed + c.pending,
    passed: c.passed,
    failed: c.failed,
    pending: c.pending,
    duration_ms: 500,
    hasCoverage: false,
    stack: detail.stack,
    framework: detail.framework,
  };
}

/** Holds a NAMED suite's `?suite=` fetch pending until `release(name)` is
 *  called — simulates a still-in-flight load (`suiteLoading` true, its
 *  leaves still undefined), never a sleep. */
class SuiteLock {
  private readonly locked: Set<string>;
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(lockedNames: string[]) {
    this.locked = new Set(lockedNames);
  }

  async waitIfLocked(name: string): Promise<void> {
    if (!this.locked.has(name)) return;
    await new Promise<void>((resolve) => {
      const list = this.waiters.get(name) ?? [];
      list.push(resolve);
      this.waiters.set(name, list);
    });
  }

  release(name: string): void {
    this.locked.delete(name);
    const list = this.waiters.get(name) ?? [];
    this.waiters.delete(name);
    for (const resolve of list) resolve();
  }
}

interface MountOpts {
  pathname?: string;
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
  lock?: SuiteLock;
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(
          `heat-cell-reveal-spec-unfold.test.ts mountApp: no eventDetails fixture for id ${id}`,
        );
      }
      const summary = { ...countsOf(detail.tree.flatMap((s) => s.children)), duration_ms: 500 };
      const served = { ...detail, summary: { total: summary.passed + summary.failed + summary.pending, ...summary } };
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const browserParam = parsed.searchParams.get("browser");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        if (opts.lock !== undefined) await opts.lock.waitIfLocked(suiteParam);
        const match = detail.tree.find(
          (n) => n.name === suiteParam && (browserParam === null || n.browser === browserParam),
        );
        body = { ok: true, event: { ...served, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = detail.tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: countsOf(n.children),
          browser: n.browser,
        }));
        body = { ok: true, event: { ...served, tree } };
      } else {
        body = { ok: true, event: served };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`heat-cell-reveal-spec-unfold.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?heatCellRevealSpecUnfold=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 6): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

async function mountAtRunCold(
  eventId: string,
  detail: EventDetailFixture,
  lock?: SuiteLock,
): Promise<void> {
  await mountApp({
    pathname: `/run/${eventId}`,
    events: [briefOf(detail)],
    eventDetails: { [eventId]: detail },
    lock,
  });
}

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error('no [data-testid="run-overlay"] mounted');
  return el;
}

function featureGroup(title: string): HTMLElement {
  const found = Array.from(
    overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]'),
  ).find((el) => el.getAttribute("data-feature-name") === title);
  if (found === undefined) throw new Error(`no feature-group named "${title}"`);
  return found;
}

function isFeatureOpen(title: string): boolean {
  return (
    featureGroup(title).querySelector('[data-testid="feature-toggle"]')?.textContent?.trim() === "▾"
  );
}

function clickFeatureHeading(title: string): void {
  featureGroup(title).querySelector<HTMLElement>('[data-testid="feature-heading"]')!.click();
}

/** The key the view gives a feature's suite under its browser. */
const suiteKey = (featureTitle: string): string => `${featureTitle} [${BROWSER}]`;

/** The scenario row of `scenarioTitle` in `featureTitle`, or null when it is not mounted. */
function scenarioRowOrNull(featureTitle: string, scenarioTitle: string): HTMLElement | null {
  return overlay().querySelector<HTMLElement>(
    `[data-testid="suite-row"][data-leaf-key="${suiteKey(featureTitle)}::${scenarioTitle}"]`,
  );
}

/** Every row of the overlay that carries the locate blink. */
function blinkingRows(): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>(".app-locate-blink"));
}

/** The step rows drawn under a scenario row (its group). */
function stepRowsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.parentElement?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

function scenario(name: string, steps: StepFixture[]): ScenarioFixture {
  const failed = steps.find((s) => s.status === "fail");
  return {
    name,
    status: failed !== undefined ? "fail" : "pass",
    duration_ms: steps.reduce((sum, s) => sum + s.duration_ms, 0),
    ...(failed?.failure !== undefined ? { failure: failed.failure } : {}),
    steps,
  };
}

function feature(name: string, scenarios: ScenarioFixture[]): SuiteFixture {
  return {
    name,
    status: scenarios.some((s) => s.status === "fail") ? "fail" : "pass",
    children: scenarios,
    browser: BROWSER,
  };
}

const passStep = (name: string): StepFixture => ({ name, status: "pass", duration_ms: 2 });
const failStep = (name: string, message: string): StepFixture => ({
  name,
  status: "fail",
  duration_ms: 2,
  failure: { message },
});

function bddEvent(id: string, tree: SuiteFixture[]): EventDetailFixture {
  return {
    id,
    projectKey: "proj-heat-spec-unfold",
    agentId: "heat-spec-unfold-agent",
    kind: "test",
    tier: "e2e",
    timestamp: Date.now(),
    stack: "bun",
    framework: "playwright-bdd",
    codec: "crucible-events",
    tree,
  };
}

// ── a loaded scenario's cell, in a feature refolded by hand ────────────────

describe("a loaded scenario's heat cell, inside a feature refolded by hand, unfolds that feature again and reveals the scenario's row", () => {
  function buildTree(): SuiteFixture[] {
    return [
      feature("KeptOpenFeature", [
        scenario("its own failing scenario", [
          passStep("kept-open-given"),
          failStep("kept-open-then", "kept-open-failure"),
        ]),
      ]),
      feature("RefoldTargetFeature", [
        scenario("a calm scenario", [passStep("refold-calm-given"), passStep("refold-calm-then")]),
        scenario("a breaking scenario", [
          passStep("refold-given-ok"),
          failStep("refold-then-breaks", "refold-then-breaks-failure"),
        ]),
      ]),
    ];
  }

  test("a GREEN scenario's heat cell unfolds its refolded feature, blinks that scenario's own row, and leaves the other already-open feature open", async () => {
    const eventId = "evt-heat-spec-refold-green";
    await mountAtRunCold(eventId, bddEvent(eventId, buildTree()));

    // PRECONDITION — both features open and load on mount (both failing).
    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);
    expect(scenarioRowOrNull("RefoldTargetFeature", "a calm scenario")).not.toBeNull();

    // Refold the target feature by hand; its scenarios stay loaded, only
    // their rows unmount.
    clickFeatureHeading("RefoldTargetFeature");
    await settle();
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(false);
    expect(scenarioRowOrNull("RefoldTargetFeature", "a calm scenario")).toBeNull();

    const cell = overlay().querySelector<HTMLElement>(
      `.app-heat-pass[title="${suiteKey("RefoldTargetFeature")} › a calm scenario"]`,
    );
    expect(cell).not.toBeNull();
    cell!.click();
    await settle();

    // POSITIVE — the feature is open again and the clicked scenario's own
    // row is the one located.
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);
    const row = scenarioRowOrNull("RefoldTargetFeature", "a calm scenario");
    expect(row).not.toBeNull();
    expect(row!.classList.contains("app-locate-blink")).toBe(true);
    // BOUND — that one row alone blinks: not its sibling scenario.
    expect(blinkingRows()).toEqual([row!]);

    // BOUND — the OTHER, already-open feature is left untouched.
    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
  });

  test("a RED scenario's heat cell unfolds its refolded feature and reveals that scenario's row, its failing step carrying its failure box", async () => {
    const eventId = "evt-heat-spec-refold-red";
    await mountAtRunCold(eventId, bddEvent(eventId, buildTree()));

    clickFeatureHeading("RefoldTargetFeature");
    await settle();
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(false);

    const cell = overlay().querySelector<HTMLElement>(
      `.app-heat-fail[title="${suiteKey("RefoldTargetFeature")} › a breaking scenario"]`,
    );
    expect(cell).not.toBeNull();
    cell!.click();
    await settle();

    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);
    const row = scenarioRowOrNull("RefoldTargetFeature", "a breaking scenario");
    expect(row).not.toBeNull();
    expect(row!.classList.contains("app-locate-blink")).toBe(true);
    expect(blinkingRows()).toEqual([row!]);

    // POSITIVE — the scenario's failing step, under its row, carries its
    // failure box with the step's own message.
    const failingStep = stepRowsOf(row!).find(
      (s) => s.getAttribute("data-leaf-key") === `${suiteKey("RefoldTargetFeature")} › a breaking scenario::refold-then-breaks`,
    );
    expect(failingStep).toBeDefined();
    const failureBox = failingStep!.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(failureBox!.textContent ?? "").toContain("refold-then-breaks-failure");

    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
  });
});

// ── a green synthetic cell, naturally folded, below the fold ───────────────

describe("a green synthetic cell of a not-yet-loaded suite in a naturally-folded, deep feature unfolds it and reveals its first scenario's row", () => {
  function buildTree(fillerCount: number): SuiteFixture[] {
    const tree: SuiteFixture[] = [
      feature("KeptOpenFeature2", [
        scenario("its own failing scenario", [
          passStep("kept-open-2-given"),
          failStep("kept-open-2-then", "kept-open-2-failure"),
        ]),
      ]),
    ];
    for (let i = 0; i < fillerCount; i++) {
      tree.push(
        feature(`FillerFeature${i}`, [
          scenario("its one calm scenario", [passStep(`filler-${i}-given`), passStep(`filler-${i}-then`)]),
        ]),
      );
    }
    tree.push(
      feature("DeepGreenFeature", [
        scenario("its calm target scenario", [passStep("deep-green-given"), passStep("deep-green-then")]),
        scenario("its second calm scenario", [passStep("deep-green-2-given"), passStep("deep-green-2-then")]),
      ]),
    );
    return tree;
  }

  test("clicking a green synthetic cell unfolds DeepGreenFeature, loads it and blinks its first scenario's row (its steps drawn), and leaves KeptOpenFeature2 open", async () => {
    const eventId = "evt-heat-spec-synth-green";
    await mountAtRunCold(eventId, bddEvent(eventId, buildTree(24)));

    expect(isFeatureOpen("KeptOpenFeature2")).toBe(true);
    // PRECONDITION — folds naturally (neither failing nor among the first
    // features to open), unread: its two cells are synthetic, one per scenario.
    expect(isFeatureOpen("DeepGreenFeature")).toBe(false);
    const cells = Array.from(
      overlay().querySelectorAll<HTMLElement>(`.app-heat-pass[title="${suiteKey("DeepGreenFeature")}"]`),
    );
    expect(cells.length).toBe(2);

    // The SECOND synthetic cell: a synthetic cell names no scenario, so even
    // it reveals the suite's first scenario.
    cells[1]!.click();
    await settle();

    expect(isFeatureOpen("DeepGreenFeature")).toBe(true);
    const row = scenarioRowOrNull("DeepGreenFeature", "its calm target scenario");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-suite-key")).toBe(suiteKey("DeepGreenFeature"));
    expect(row!.classList.contains("app-locate-blink")).toBe(true);
    // POSITIVE — the loaded scenario's steps are drawn under its row.
    expect(stepRowsOf(row!).map((s) => s.getAttribute("data-leaf-key"))).toEqual([
      `${suiteKey("DeepGreenFeature")} › its calm target scenario::deep-green-given`,
      `${suiteKey("DeepGreenFeature")} › its calm target scenario::deep-green-then`,
    ]);
    // NEGATIVE — its second scenario is not located; BOUND — nothing else is.
    expect(scenarioRowOrNull("DeepGreenFeature", "its second calm scenario")?.classList.contains("app-locate-blink")).toBe(false);
    expect(blinkingRows()).toEqual([row!]);

    expect(isFeatureOpen("KeptOpenFeature2")).toBe(true);
  });
});

// ── a red synthetic cell still loading, folded by hand ─────────────────────

describe("a red synthetic cell of a suite still loading (suiteLoading, not yet mounted) in a refolded feature unfolds it and reveals its first failing scenario's row", () => {
  test("folding the feature while its auto-load is in flight, then clicking its still-synthetic red cell, unfolds the feature and reveals the first failing scenario's row once the load resolves", async () => {
    const eventId = "evt-heat-spec-synth-red-locked";
    const LOCKED_FEATURE = "RedLockedFeature";
    const tree: SuiteFixture[] = [
      feature("KeptOpenFeature3", [
        scenario("its own failing scenario", [
          passStep("kept-open-3-given"),
          failStep("kept-open-3-then", "kept-open-3-failure"),
        ]),
      ]),
      // A passing scenario first, so "the first FAILING scenario" is not
      // merely "the first scenario".
      feature(LOCKED_FEATURE, [
        scenario("a calm scenario first", [passStep("red-locked-calm-given")]),
        scenario("locked scenario", [
          passStep("red-locked-given"),
          failStep("red-locked-then", "red-locked-then-failure"),
        ]),
      ]),
    ];
    const lock = new SuiteLock([LOCKED_FEATURE]);
    await mountAtRunCold(eventId, bddEvent(eventId, tree), lock);

    // PRECONDITION — RedLockedFeature opens on mount (it is failing), but its
    // own load (openProgressively's loadSuite) is held by this test's lock:
    // its heat cells are STILL synthetic, and none of its scenario rows has
    // mounted.
    expect(isFeatureOpen(LOCKED_FEATURE)).toBe(true);
    const failCell = `.app-heat-fail[title="${suiteKey(LOCKED_FEATURE)}"]`;
    expect(overlay().querySelectorAll(failCell).length).toBe(1);
    expect(scenarioRowOrNull(LOCKED_FEATURE, "locked scenario")).toBeNull();
    expect(scenarioRowOrNull(LOCKED_FEATURE, "a calm scenario first")).toBeNull();

    // Fold it by hand while the load is in flight — a real, reachable race
    // (the user closes a feature while its scenarios are still arriving).
    clickFeatureHeading(LOCKED_FEATURE);
    await settle();
    expect(isFeatureOpen(LOCKED_FEATURE)).toBe(false);

    const cell = overlay().querySelector<HTMLElement>(failCell);
    expect(cell).not.toBeNull();
    cell!.click(); // SynthHeatCell's onclick awaits loadSuite — also locked, stays pending
    await settle();

    // Let both the stale auto-load AND the click's own loadSuite resolve.
    lock.release(LOCKED_FEATURE);
    await settle();

    expect(isFeatureOpen(LOCKED_FEATURE)).toBe(true);
    const row = scenarioRowOrNull(LOCKED_FEATURE, "locked scenario");
    expect(row).not.toBeNull();
    expect(row!.classList.contains("app-locate-blink")).toBe(true);
    // NEGATIVE — the suite's first (passing) scenario is not the one located.
    expect(scenarioRowOrNull(LOCKED_FEATURE, "a calm scenario first")?.classList.contains("app-locate-blink")).toBe(false);
    expect(blinkingRows()).toEqual([row!]);

    // POSITIVE — its failing step carries its failure box with its message.
    const failingStep = stepRowsOf(row!).find(
      (s) => s.getAttribute("data-leaf-key") === `${suiteKey(LOCKED_FEATURE)} › locked scenario::red-locked-then`,
    );
    expect(failingStep).toBeDefined();
    const failureBox = failingStep!.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(failureBox!.textContent ?? "").toContain("red-locked-then-failure");

    expect(isFeatureOpen("KeptOpenFeature3")).toBe(true);
  });
});
