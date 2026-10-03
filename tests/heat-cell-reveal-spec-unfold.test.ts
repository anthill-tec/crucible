// CR-CRU-159 C2 — heat-strip reveal: the feature unfold (G5/AC3). Same
// happy-dom harness pattern as tests/heat-cell-reveal.test.ts (C1): real
// production public/app.js, real public/app-logic.mjs, real VanJS/VanX
// vendor bundles; `fetch` is scripted.
//
// RED phase: expected to fail against the CURRENT `HeatCell`/`SynthHeatCell`
// handlers (public/app.js), which call `reveal(...)` but never touch
// `openFeatures`/`toggleFeature` — CR-CRU-159's own Gap analysis, G5: "a
// folded feature mounts nothing... SynthHeatCell loads the suite but never
// unfolds its feature." Every assertion below that checks the clicked
// scenario's feature re-opens, or that its row/leaf then mounts and blinks,
// fails against today's code for exactly that missing unfold, not a harness
// defect.
//
// Contract this file defines for GREEN (identifiers verbatim):
//   - a heat cell (loaded `HeatCell` or synthetic `SynthHeatCell`) whose
//     target scenario's FEATURE is currently folded (`openFeatures.val[...]
//     !== true`) sets that feature open — so the target's `SuiteGroup` (and
//     its `leaf-row`s) mounts — alongside its existing `reveal()`.
//   - a feature that is ALREADY open is left open by a reveal inside it (no
//     accidental re-fold of an unrelated already-open feature).
//
// Two fixture techniques this file relies on (both already-established house
// idioms elsewhere in this suite, tests/playwright-run-progressive-expansion.
// test.ts and tests/heat-cell-reveal.test.ts respectively):
//   - "loaded scenario, then manually refolded": a FAILING scenario
//     auto-loads and its feature auto-opens on mount (CR-CRU-145's
//     openProgressively); this file folds that feature by hand (clicking
//     its `feature-heading`, exactly what the already-shipped
//     `toggleFeature` supports) so an already-LOADED scenario sits inside a
//     now-folded feature — the "a loaded scenario's cell" case the CR names.
//   - "not-yet-loaded, still loading": this file's own fetch mock can hold a
//     NAMED suite's `?suite=` response pending (never resolving until the
//     test calls `release(...)`) — the same "control the async, don't sleep
//     for it" idiom tests/heat-cell-reveal.test.ts's `interceptBlinkTimer`
//     already uses for the 10s blink cleanup. A scenario still mid-fetch
//     when its feature is folded is a genuine, reachable production race
//     (network latency), not a fabricated state.
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

interface FailureFixture {
  message: string;
}
interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
interface SuiteFixture {
  // "<Feature title> › <Scenario title>" — the codec's own naming
  // (src/codecs/playwright.ts's `collectScenarios`).
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
  tree: SuiteFixture[];
}
interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
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

function briefOf(detail: EventDetailFixture): EventBriefFixture {
  const c = suiteCounts(detail.tree.flatMap((s) => s.children));
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
  };
}

/** Holds a NAMED suite's `?suite=` fetch pending until `release(name)` is
 *  called — simulates a still-in-flight load (`suiteLoading` true,
 *  `suiteLeaves` still undefined), never a sleep. */
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
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        if (opts.lock !== undefined) await opts.lock.waitIfLocked(suiteParam);
        const match = detail.tree.find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = detail.tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
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

function scenario(
  featureTitle: string,
  scenarioTitle: string,
  status: "pass" | "fail",
  children: LeafFixture[],
): SuiteFixture {
  return { name: `${featureTitle} › ${scenarioTitle}`, status, children };
}

function playwrightEvent(
  id: string,
  tree: SuiteFixture[],
  opts: Partial<EventDetailFixture> = {},
): EventDetailFixture {
  return {
    id,
    projectKey: "proj-heat-spec-unfold",
    agentId: "heat-spec-unfold-agent",
    kind: "test",
    tier: "e2e",
    codec: "playwright",
    timestamp: Date.now(),
    tree,
    ...opts,
  };
}

// ── §S1 AC3/G5 — a loaded scenario's cell, refolded by hand ────────────────

describe("§S1 AC3/G5 — a loaded scenario's heat cell, inside a feature refolded by hand, unfolds that feature again and reveals the leaf", () => {
  function buildTree(): SuiteFixture[] {
    return [
      scenario("KeptOpenFeature", "its own failing scenario", "fail", [
        { name: "kept-open-given", status: "pass", duration_ms: 2 },
        { name: "kept-open-then", status: "fail", duration_ms: 2, failure: { message: "kept-open-failure" } },
      ]),
      scenario("RefoldTargetFeature", "mixed outcome scenario", "fail", [
        { name: "refold-given-ok", status: "pass", duration_ms: 2 },
        {
          name: "refold-then-breaks",
          status: "fail",
          duration_ms: 2,
          failure: { message: "refold-then-breaks-failure" },
        },
      ]),
    ];
  }

  test("a GREEN leaf's heat cell unfolds its refolded feature, scrolls + blinks its own leaf row, and leaves the other already-open feature open", async () => {
    const eventId = "evt-heat-spec-refold-green";
    const detail = playwrightEvent(eventId, buildTree());
    await mountAtRunCold(eventId, detail);

    // PRECONDITION — both features auto-open on mount (both failing,
    // CR-CRU-145 §S1): this is the existing baseline this file does not
    // change.
    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);

    // Refold the target feature by hand (toggleFeature — already works
    // today); its scenario's leaves stay loaded in suiteLeaves, only hidden.
    clickFeatureHeading("RefoldTargetFeature");
    await settle();
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(false);
    expect(
      overlay().querySelector(
        '[data-leaf-key="RefoldTargetFeature › mixed outcome scenario::refold-given-ok"]',
      ),
    ).toBeNull();

    const cell = overlay().querySelector(
      '[title="RefoldTargetFeature › mixed outcome scenario › refold-given-ok"]',
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    cell!.click();
    await settle();

    // RED — G5: SynthHeatCell/HeatCell never touch openFeatures, so the
    // feature stays folded and the leaf row this click targets never mounts.
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);
    const row = overlay().querySelector(
      '[data-leaf-key="RefoldTargetFeature › mixed outcome scenario::refold-given-ok"]',
    );
    expect(row).not.toBeNull();
    expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

    // BOUND — the OTHER, already-open feature is left untouched.
    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
  });

  test("a RED leaf's heat cell unfolds its refolded feature and reveals the failing leaf with its failure box", async () => {
    const eventId = "evt-heat-spec-refold-red";
    const detail = playwrightEvent(eventId, buildTree());
    await mountAtRunCold(eventId, detail);

    clickFeatureHeading("RefoldTargetFeature");
    await settle();
    expect(isFeatureOpen("RefoldTargetFeature")).toBe(false);

    const cell = overlay().querySelector(
      '[title="RefoldTargetFeature › mixed outcome scenario › refold-then-breaks"]',
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    cell!.click();
    await settle();

    expect(isFeatureOpen("RefoldTargetFeature")).toBe(true);
    const row = overlay().querySelector(
      '[data-leaf-key="RefoldTargetFeature › mixed outcome scenario::refold-then-breaks"]',
    );
    expect(row).not.toBeNull();
    expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

    const failureBox = overlay().querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(failureBox!.textContent ?? "").toContain("refold-then-breaks-failure");

    expect(isFeatureOpen("KeptOpenFeature")).toBe(true);
  });
});

// ── §S1 AC3/G5 — a green synthetic cell, naturally folded, below the fold ──

describe("§S1 AC3/G5 — a green synthetic cell of a not-yet-loaded scenario in a naturally-folded, deep feature unfolds it and reveals the scenario's own row", () => {
  function buildTree(fillerCount: number): SuiteFixture[] {
    const tree: SuiteFixture[] = [
      scenario("KeptOpenFeature2", "its own failing scenario", "fail", [
        { name: "kept-open-2-given", status: "pass", duration_ms: 2 },
        {
          name: "kept-open-2-then",
          status: "fail",
          duration_ms: 2,
          failure: { message: "kept-open-2-failure" },
        },
      ]),
    ];
    for (let i = 0; i < fillerCount; i++) {
      tree.push(
        scenario(`FillerFeature${i}`, "its one calm scenario", "pass", [
          { name: `filler-${i}-given`, status: "pass", duration_ms: 2 },
          { name: `filler-${i}-then`, status: "pass", duration_ms: 2 },
        ]),
      );
    }
    tree.push(
      scenario("DeepGreenFeature", "its calm target scenario", "pass", [
        { name: "deep-green-given", status: "pass", duration_ms: 2 },
        { name: "deep-green-then", status: "pass", duration_ms: 2 },
      ]),
    );
    return tree;
  }

  test("clicking the green synthetic cell unfolds DeepGreenFeature, expands + blinks its scenario row (carrying data-suite-key), and leaves KeptOpenFeature2 open", async () => {
    const eventId = "evt-heat-spec-synth-green";
    const detail = playwrightEvent(eventId, buildTree(24));
    await mountAtRunCold(eventId, detail);

    expect(isFeatureOpen("KeptOpenFeature2")).toBe(true);
    // PRECONDITION — folds naturally: not the report-first feature, and not
    // failing (CR-CRU-145 §S1's "green features fold" rule).
    expect(isFeatureOpen("DeepGreenFeature")).toBe(false);

    const cell = overlay().querySelector(
      '.app-heat-pass[title="DeepGreenFeature › its calm target scenario"]',
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    cell!.click();
    await settle();

    // RED — G5: the feature stays folded, so the scenario's SuiteGroup (and
    // its data-suite-key row) never mounts, even though the suite is now
    // loaded (expanded) in state.
    expect(isFeatureOpen("DeepGreenFeature")).toBe(true);
    const row = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).find(
      (el) => el.getAttribute("data-suite-key") === "DeepGreenFeature › its calm target scenario",
    );
    expect(row).not.toBeUndefined();
    expect(row!.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim()).toBe("▾");
    expect(row!.classList.contains("app-locate-blink")).toBe(true);

    expect(isFeatureOpen("KeptOpenFeature2")).toBe(true);
  });
});

// ── §S1 AC3/G5 — a red synthetic cell still loading, folded by hand ────────

describe("§S1 AC3/G5 — a red synthetic cell of a scenario still loading (suiteLoading, not yet mounted) in a refolded feature unfolds it and reveals the first failing leaf", () => {
  test("folding the feature while its auto-load is in flight, then clicking its still-synthetic red cell, unfolds the feature and reveals the failing leaf once the load resolves", async () => {
    const eventId = "evt-heat-spec-synth-red-locked";
    const LOCKED_SUITE = "RedLockedFeature › locked scenario";
    const tree: SuiteFixture[] = [
      scenario("KeptOpenFeature3", "its own failing scenario", "fail", [
        { name: "kept-open-3-given", status: "pass", duration_ms: 2 },
        {
          name: "kept-open-3-then",
          status: "fail",
          duration_ms: 2,
          failure: { message: "kept-open-3-failure" },
        },
      ]),
      scenario("RedLockedFeature", "locked scenario", "fail", [
        { name: "red-locked-given", status: "pass", duration_ms: 2 },
        {
          name: "red-locked-then",
          status: "fail",
          duration_ms: 2,
          failure: { message: "red-locked-then-failure" },
        },
      ]),
    ];
    const detail = playwrightEvent(eventId, tree);
    const lock = new SuiteLock([LOCKED_SUITE]);
    await mountAtRunCold(eventId, detail, lock);

    // PRECONDITION — RedLockedFeature auto-opens (CR-CRU-145 §S1, it is
    // failing), which renders its scenario's suite-row (as for ANY
    // not-yet-loaded scenario of an open feature, C1's own AC2 precedent),
    // but COLLAPSED — its own auto-load (openProgressively's loadSuite) is
    // still pending, this test's own lock, never resolved yet — so the
    // HeatStrip cell for it is STILL a SynthHeatCell (red), and the
    // scenario's leaf list has not mounted.
    expect(isFeatureOpen("RedLockedFeature")).toBe(true);
    expect(overlay().querySelector(`.app-heat-fail[title="${LOCKED_SUITE}"]`)).not.toBeNull();
    const collapsedRow = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).find(
      (el) => el.getAttribute("data-suite-key") === LOCKED_SUITE,
    );
    expect(collapsedRow).not.toBeUndefined();
    expect(collapsedRow!.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim()).toBe("▸");
    expect(
      overlay().querySelector('[data-leaf-key="RedLockedFeature › locked scenario::red-locked-then"]'),
    ).toBeNull();

    // Fold it by hand while the load is in flight — a real, reachable race
    // (the user closes a feature while its scenario is still arriving).
    clickFeatureHeading("RedLockedFeature");
    await settle();
    expect(isFeatureOpen("RedLockedFeature")).toBe(false);

    const cell = overlay().querySelector(
      `.app-heat-fail[title="${LOCKED_SUITE}"]`,
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    cell!.click(); // SynthHeatCell's onclick awaits loadSuite — also locked, stays pending
    await settle();

    // Let both the stale auto-load AND the click's own loadSuite resolve.
    lock.release(LOCKED_SUITE);
    await settle();

    // RED — G5: the feature stays folded (HeatCell/SynthHeatCell never
    // touch openFeatures), so even once the load lands, the failing leaf's
    // row never mounts.
    expect(isFeatureOpen("RedLockedFeature")).toBe(true);
    const row = overlay().querySelector(
      '[data-leaf-key="RedLockedFeature › locked scenario::red-locked-then"]',
    );
    expect(row).not.toBeNull();
    expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

    const failureBox = overlay().querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(failureBox!.textContent ?? "").toContain("red-locked-then-failure");

    expect(isFeatureOpen("KeptOpenFeature3")).toBe(true);
  });
});
