// CR-CRU-145 §S1 — the NEW AC added 2026-09-24 (e289470), owned by C2 as
// RED+GREEN: "A scenario that ran under two browsers opens that browser's
// own steps." Found breaking at C1 GREEN (5a53a37): with one SuiteNode PER
// (spec, project) now emitted, every seam below still treats a scenario's
// identity as its NAME alone, so a same-named failing-browser row silently
// shows the passing browser's content.
//
// SEAMS UNDER TEST (measured on this branch, e289470, before C2 GREEN):
//   - src/v2.ts handleEventGet, its `?suite=<name>` branch: does
//     `(event.tree ?? []).find((node) => node.name === suite)` — always the
//     FIRST same-named node; `browser` never read from the query.
//   - src/v2.ts handleEventGet, its `?depth=suites` branch: maps each node to
//     `{name, status, counts}` — `browser` dropped from the skeleton reply.
//   - public/app.js RunDetailBody: its `suiteLeaves`,
//     `suiteLoading` and `suiteWindow` maps are all keyed by
//     `suite.name` alone; `loadSuite` fetches `?suite=<name>`
//     with no browser and matches the reply by `name` alone; `expandSuite`
//     early-returns once ANY node of that name has loaded, so
//     a second same-named suite-row never issues its own fetch at all;
//     `HeatStrip`, `resolveRaw` (keys leaves by
//     `suite.name`) and `TestBody` (`leavesMap[suite.name]`)
//     all read the same name-only map.
//
// DESIGN CHOICES DECLARED HERE — the AC names the DEFECT, not the wire
// contract, so this file fixes the contract:
//   - the per-suite read's browser scope is the query parameter `browser`
//     (mirrors SuiteNode's own field name) — `?suite=<name>&browser=<b>`.
//     OMITTED, it returns the first same-named node, UNCHANGED — the "no
//     browser param" bound this CR's own AC text calls out.
//   - the UI-level test proves the keying bug WITHOUT inventing a `data-*`
//     attribute the AC never asked for: `TestBody` (measured above) already
//     renders one `[data-testid="suite-row"]` PER TREE NODE, in `d.tree`
//     order, never reordered by name — so with the fixture below (the
//     FIRST-listed browser passing, the SECOND failing, this AC's own
//     framing) DOM order alone tells the two same-named rows apart. A GREEN
//     that reorders same-named rows independent of report order would
//     invalidate this assumption; nothing in the AC or F11 asks for that.
//
// FIXTURE PROVENANCE — the route-level run is a `playwright-bdd` run streamed
// to a real board (`streamBddRun`, tests/helpers/playwright-bdd-run.ts), as
// the bun client streams one: the feature `responsive phone band` run under
// two browsers, `chromium-mobile` listed FIRST and passing, `webkit-iphone`
// SECOND and failing (the `mobile-viewport-responsive.feature` collision
// `playwright.config.ts`'s `testMatch` produces). The board stores one suite
// per feature and browser, so the two suites share one name and only their
// browser tells them apart: what these routes serve is what the store wrote,
// never a tree hand-authored to match what the test wants.
//
// SAFETY: every server binds port 0 on ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerHandle } from "../../src/server.ts";
import type { SuiteNode, RunSummary } from "../../src/types.ts";
import { settleDom } from "../helpers/dom-settle";
import { bddProject, failingStep, passingStep, streamBddRun, type BddScenario } from "../helpers/playwright-bdd-run.ts";
import { bootOn, getJson } from "../helpers/run-stream-harness.ts";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── Shared fixture: ONE feature, ONE scenario, run under TWO browsers ─────
const FEATURE_NAME = "responsive phone band";
const UI_SCENARIO = "the pane scrolls in its own box";
const GIVEN_STEP = "Given the board is open on a phone";
const THEN_STEP = "Then the Roadmap pane scrolls inside its own box";
const FAIL_MESSAGE = "expected pane scrollTop > 0, got 0";
const PASS_BROWSER = "chromium-mobile";
const FAIL_BROWSER = "webkit-iphone";

/** The scenario under both browsers, `chromium-mobile` FIRST and passing,
 *  `webkit-iphone` SECOND and failing at its second step — this AC's own
 *  framing ("the FIRST-listed browser passes and the second fails"). */
function crossBrowserScenarios(): BddScenario[] {
  return [
    {
      feature: FEATURE_NAME,
      browser: PASS_BROWSER,
      name: UI_SCENARIO,
      status: "pass",
      steps: [passingStep(GIVEN_STEP), passingStep(THEN_STEP)],
    },
    {
      feature: FEATURE_NAME,
      browser: FAIL_BROWSER,
      name: UI_SCENARIO,
      status: "fail",
      steps: [passingStep(GIVEN_STEP), failingStep(THEN_STEP, FAIL_MESSAGE)],
      failure: { message: FAIL_MESSAGE },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────
// ROUTE LEVEL — GET /api/v2/events/:id?depth=suites | ?suite=<name>[&browser=<b>]
// ──────────────────────────────────────────────────────────────────────
interface ServedStep {
  name: string;
  status: string;
  failure?: { message: string };
}
interface ServedScenario {
  name: string;
  status: string;
  failure?: { message: string };
  steps?: ServedStep[];
}
interface ServedSuite {
  name: string;
  status: string;
  browser?: string;
  counts?: { passed: number; failed: number; pending: number };
  children?: ServedScenario[];
}

function servedTree(body: Record<string, unknown>): ServedSuite[] {
  return ((body.event as { tree?: ServedSuite[] } | undefined)?.tree ?? []) as ServedSuite[];
}

describe("CR-CRU-145 §S1 — route: a scenario run under two browsers opens THAT browser's own steps", () => {
  const handles: ServerHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
  });

  /** A board holding the streamed cross-browser run; answers it and the run's event id. */
  async function seedCrossBrowserRun(name: string): Promise<{ handle: ServerHandle; id: string }> {
    const handle = bootOn();
    handles.push(handle);
    const key = await bddProject(handle, name);
    const id = await streamBddRun(handle, key, crossBrowserScenarios(), "e2e");
    return { handle, id };
  }

  test("?depth=suites carries each browser's suite with its OWN browser — the two same-named suites stay distinguishable", async () => {
    const { handle, id } = await seedCrossBrowserRun("browser-scoping-depth");

    const tree = servedTree(await getJson(handle, `/api/v2/events/${id}?depth=suites`));

    // BOUND — exactly the two suites of the one feature, nothing else.
    expect(tree.length).toBe(2);
    const sameNamed = tree.filter((n) => n.name === FEATURE_NAME);
    expect(sameNamed.length).toBe(2);

    // POSITIVE — each suite's OWN browser reaches the reply; neither is
    // undefined, and neither is confused with the other's.
    const passNode = sameNamed.find((n) => n.browser === PASS_BROWSER);
    const failNode = sameNamed.find((n) => n.browser === FAIL_BROWSER);
    expect(passNode).toBeDefined();
    expect(failNode).toBeDefined();
    expect(passNode?.status).toBe("pass");
    expect(failNode?.status).toBe("fail");
    // Counted over its scenarios: one each.
    expect(passNode?.counts).toEqual({ passed: 1, failed: 0, pending: 0 });
    expect(failNode?.counts).toEqual({ passed: 0, failed: 1, pending: 0 });
  });

  test("the per-suite read is narrowed by browser: returns the REQUESTED browser's suite, never the first same-named one; browser omitted still returns the first match, unchanged", async () => {
    const { handle, id } = await seedCrossBrowserRun("browser-scoping-suite");
    const suiteRead = `/api/v2/events/${id}?suite=${encodeURIComponent(FEATURE_NAME)}`;

    // BOUND — no `browser` param: first match, UNCHANGED (chromium-mobile is
    // streamed first — this is the CR's own "unchanged" clause, not a new
    // behaviour).
    const unscopedTree = servedTree(await getJson(handle, suiteRead));
    expect(unscopedTree.length).toBe(1);
    expect(unscopedTree[0]?.browser).toBe(PASS_BROWSER);
    expect(unscopedTree[0]?.status).toBe("pass");

    // POSITIVE — narrowed to the FAILING browser: its OWN suite, its OWN
    // scenario failing AT its second step with that step's message, never
    // the passing browser's data.
    const failTree = servedTree(await getJson(handle, `${suiteRead}&browser=${encodeURIComponent(FAIL_BROWSER)}`));
    expect(failTree.length).toBe(1);
    expect(failTree[0]?.browser).toBe(FAIL_BROWSER);
    expect(failTree[0]?.status).toBe("fail");
    const failScenario = failTree[0]?.children?.[0];
    expect(failTree[0]?.children?.length).toBe(1);
    expect(failScenario?.name).toBe(UI_SCENARIO);
    expect(failScenario?.status).toBe("fail");
    expect(failScenario?.steps?.map((s) => [s.name, s.status])).toEqual([
      [GIVEN_STEP, "pass"],
      [THEN_STEP, "fail"],
    ]);
    expect(failScenario?.steps?.[1]?.failure?.message).toBe(FAIL_MESSAGE);

    // POSITIVE — narrowed to the PASSING browser, independently, proving the
    // narrowing is not a coincidence of "the failing one always wins".
    const passTree = servedTree(await getJson(handle, `${suiteRead}&browser=${encodeURIComponent(PASS_BROWSER)}`));
    expect(passTree.length).toBe(1);
    expect(passTree[0]?.browser).toBe(PASS_BROWSER);
    expect(passTree[0]?.status).toBe("pass");
    const passScenario = passTree[0]?.children?.[0];
    expect(passScenario?.steps?.map((s) => [s.name, s.status])).toEqual([
      [GIVEN_STEP, "pass"],
      [THEN_STEP, "pass"],
    ]);
    // NEGATIVE — the passing browser's own suite carries no failure at all.
    expect(passScenario?.failure).toBeUndefined();
    expect(passScenario?.steps?.some((s) => s.failure !== undefined)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// UI LEVEL — the run detail keys loaded leaves / loading flag / window /
// leaf keys by (name, browser); each browser's row reads and shows THAT
// browser's own steps.
//
// The run is served as the board serves a streamed playwright-bdd run: codec
// `crucible-events`, framework `playwright-bdd`; one suite per feature and
// browser (`name`, `status`, `counts` over its scenarios, `browser`), each
// scenario a leaf of it carrying its Gherkin `steps`; a
// `?suite=<feature>&browser=<b>` read answers that browser's suite alone.
// ──────────────────────────────────────────────────────────────────────
/** The feature run under both browsers: one suite per browser, the
 *  scenario a leaf of each, `chromium-mobile` listed FIRST and passing,
 *  `webkit-iphone` SECOND and failing. */
function crossBrowserScenarioTree(): SuiteNode[] {
  return [
    {
      name: FEATURE_NAME,
      status: "pass",
      browser: PASS_BROWSER,
      children: [
        {
          name: UI_SCENARIO,
          status: "pass",
          duration_ms: 5,
          steps: [
            { name: GIVEN_STEP, status: "pass", duration_ms: 3 },
            { name: THEN_STEP, status: "pass", duration_ms: 2 },
          ],
        },
      ],
    },
    {
      name: FEATURE_NAME,
      status: "fail",
      browser: FAIL_BROWSER,
      children: [
        {
          name: UI_SCENARIO,
          status: "fail",
          duration_ms: 4,
          failure: { message: FAIL_MESSAGE },
          steps: [
            { name: GIVEN_STEP, status: "pass", duration_ms: 3 },
            { name: THEN_STEP, status: "fail", duration_ms: 1, failure: { message: FAIL_MESSAGE } },
          ],
        },
      ],
    },
  ];
}

/** The run's counts over its scenarios, as the board counts a playwright-bdd run. */
const CROSS_BROWSER_SCENARIO_SUMMARY: RunSummary = { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 9 };

let cacheBust = 0;
let fetchLog: string[] = [];

function suiteSkeleton(tree: SuiteNode[]) {
  return tree.map((n) => {
    const counts = { passed: 0, failed: 0, pending: 0 };
    for (const leaf of n.children) {
      if (leaf.status === "pass") counts.passed += 1;
      else if (leaf.status === "fail") counts.failed += 1;
      else counts.pending += 1;
    }
    return { name: n.name, status: n.status, counts, ...(n.browser !== undefined ? { browser: n.browser } : {}) };
  });
}

/** The fields the board serves on a streamed playwright-bdd run. */
const BDD_RUN = { stack: "bun", framework: "playwright-bdd", codec: "crucible-events" } as const;

async function mountApp(eventId: string, tree: SuiteNode[], summary: RunSummary): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/run/${eventId}` });
  document.body.innerHTML = '<div id="app"></div>';
  fetchLog = [];
  const projectKey = "proj-browser-scoping";

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      if (id !== eventId) {
        throw new Error(`playwright-run-browser-scoping.test.ts: no fixture for event ${id}`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const browserParam = parsed.searchParams.get("browser");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const candidates = tree.filter((n) => n.name === suiteParam);
        // §S1 route contract this file also proves at the route level: with
        // a `browser` param, that browser's OWN node; omitted, the first
        // same-named node, unchanged.
        const match = browserParam !== null ? candidates.find((n) => n.browser === browserParam) : candidates[0];
        body = {
          ok: true,
          event: { id: eventId, kind: "test", tier: "e2e", ...BDD_RUN, summary, tree: match !== undefined ? [match] : [] },
        };
      } else if (depthParam === "suites") {
        body = { ok: true, event: { id: eventId, kind: "test", tier: "e2e", ...BDD_RUN, summary, tree: suiteSkeleton(tree) } };
      } else {
        body = { ok: true, event: { id: eventId, kind: "test", tier: "e2e", ...BDD_RUN, summary, tree } };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = {
        ok: true,
        projects: [{ key: projectKey, name: "Browser Scoping", type: "frontend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() }],
      };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = {
        ok: true,
        events: [
          {
            id: eventId,
            projectKey,
            agentId: "browser-scoping-ui-agent",
            kind: "test",
            tier: "e2e",
            codec: BDD_RUN.codec,
            timestamp: Date.now(),
            ...summary,
            hasCoverage: false,
            stack: BDD_RUN.stack,
            framework: BDD_RUN.framework,
          },
        ],
      };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`playwright-run-browser-scoping.test.ts: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?browserScoping=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 8 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error('no [data-testid="run-overlay"] mounted');
  return el;
}

/** ALL suite-rows whose text includes `name` — with two same-named nodes
 *  there are TWO, in `d.tree` order (see the file header's DOM-order
 *  design-choice note). */
function suiteRowsNamed(name: string): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).filter((el) =>
    (el.textContent ?? "").includes(name),
  );
}

/** A row's OWN leaf rows — scoped to its OWN `app-suite-group` wrapper, not
 *  a name-based re-search, so the two same-named rows stay distinguishable
 *  by the ELEMENT the caller already has. */
function leafRowsOf(row: HTMLElement): HTMLElement[] {
  const group = row.parentElement;
  return Array.from(group?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

describe("CR-CRU-145 §S1 — UI: a scenario run under two browsers opens THAT browser's own steps", () => {
  // Rows are located by their BROWSER LABEL (never DOM order): the feature
  // fails, so it opens on its own and reads each browser's suite, which
  // answers that browser's scenario with its steps. The core bound: each row
  // shows its OWN browser's steps and NEVER the other browser's, asserted by
  // absence both ways.
  function rowForBrowser(browser: string): HTMLElement {
    const rows = suiteRowsNamed(UI_SCENARIO).filter((el) => (el.textContent ?? "").includes(browser));
    if (rows.length !== 1) {
      throw new Error(`expected exactly one "${UI_SCENARIO}" row labelled ${browser}; found ${rows.length}`);
    }
    return rows[0]!;
  }

  function readFor(browser: string): boolean {
    return fetchLog.some(
      (u) => u.includes(`suite=${encodeURIComponent(FEATURE_NAME)}`) && u.includes(`browser=${encodeURIComponent(browser)}`),
    );
  }

  test("the failing browser's row opens with its OWN failing step (never the passing browser's); the passing browser's row shows only its OWN steps; each row's read carries that row's browser", async () => {
    const eventId = "evt-cross-browser-run-detail";
    await mountApp(eventId, crossBrowserScenarioTree(), CROSS_BROWSER_SCENARIO_SUMMARY);

    // PRECONDITION — both same-named scenario rows are present, each named
    // by its own browser, under ONE feature.
    expect(
      Array.from(overlay().querySelectorAll('[data-testid="feature-group"]')).map((g) => g.getAttribute("data-feature-name")),
    ).toEqual([FEATURE_NAME]);
    expect(suiteRowsNamed(UI_SCENARIO).length).toBe(2);
    const failRow = rowForBrowser(FAIL_BROWSER);
    const passRow = rowForBrowser(PASS_BROWSER);
    expect(failRow).not.toBe(passRow);

    // Each browser's suite was read ON OPEN, with no click, by a read scoped
    // to that browser.
    expect(readFor(FAIL_BROWSER)).toBe(true);
    expect(readFor(PASS_BROWSER)).toBe(true);

    // POSITIVE — the failing row's OWN steps carry the failing step's
    // message AT that step.
    const failLeaves = leafRowsOf(failRow);
    expect(failLeaves.length).toBe(2);
    const failThenLeaf = failLeaves.find((r) => (r.textContent ?? "").includes(THEN_STEP));
    expect(failThenLeaf).toBeDefined();
    expect(failThenLeaf!.textContent ?? "").toContain(FAIL_MESSAGE);

    // NEGATIVE — never the passing browser's steps: the failing row holds
    // exactly one row for that step, and it carries the failure.
    const failStepLeaves = failLeaves.filter((r) => (r.textContent ?? "").includes(THEN_STEP));
    expect(failStepLeaves.length).toBe(1);
    expect(failStepLeaves.some((r) => !(r.textContent ?? "").includes(FAIL_MESSAGE))).toBe(false);

    // POSITIVE — the passing row DOES carry its own passing steps.
    const passLeaves = leafRowsOf(passRow);
    expect(passLeaves.length).toBe(2);
    const passLeafText = passLeaves.map((r) => r.textContent ?? "").join(" | ");
    expect(passLeafText).toContain(GIVEN_STEP);
    expect(passLeafText).toContain(THEN_STEP);
    // NEGATIVE — and NEVER the failing browser's failure message.
    expect(passLeafText).not.toContain(FAIL_MESSAGE);
    expect(passLeaves.some((r) => r.classList.contains("fail"))).toBe(false);
  });
});
