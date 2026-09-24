// CR-CRU-145 §S1 — the NEW AC added 2026-09-24 (e289470), owned by C2 as
// RED+GREEN: "A scenario that ran under two browsers opens that browser's
// own steps." Found breaking at C1 GREEN (5a53a37): with one SuiteNode PER
// (spec, project) now emitted, every seam below still treats a scenario's
// identity as its NAME alone, so a same-named failing-browser row silently
// shows the passing browser's content.
//
// SEAMS UNDER TEST (measured on this branch, e289470, before C2 GREEN):
//   - src/v2.ts handleEventGet ~L3789: `?suite=<name>` does
//     `(event.tree ?? []).find((node) => node.name === suite)` — always the
//     FIRST same-named node; `browser` never read from the query.
//   - src/v2.ts handleEventGet ~L3797-3802: `?depth=suites` maps each node to
//     `{name, status, counts}` — `browser` dropped from the skeleton reply.
//   - public/app.js RunDetailBody (~L5953): `suiteLeaves` (~L5956),
//     `suiteLoading` (~L5962) and `suiteWindow` (~L5965) are all keyed by
//     `suite.name` alone; `loadSuite` (~L6001-6013) fetches `?suite=<name>`
//     with no browser and matches the reply by `name` alone; `expandSuite`
//     (~L6024-6027) early-returns once ANY node of that name has loaded, so
//     a second same-named suite-row never issues its own fetch at all;
//     `HeatStrip` (~L6216-6227), `resolveRaw` (~L6395-6410, keys leaves by
//     `suite.name`) and `TestBody` (~L6467-6498, `leavesMap[suite.name]`)
//     all read the same name-only map.
//
// DESIGN CHOICES DECLARED HERE — the AC names the DEFECT, not the wire
// contract, so this file fixes the contract the same way C1's own
// tests/playwright-codec.test.ts fixed the codec's additive field:
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
// FIXTURE PROVENANCE — a REAL two-project Playwright JSON reporter payload
// (the exact `chromium-mobile` / `webkit-iphone` collision
// `playwright.config.ts`'s `testMatch` produces for
// `mobile-viewport-responsive.feature`, same shape as
// tests/playwright-codec.test.ts's own `twoProjectReport`) run through the
// SAME `parsePlaywright` codec C1 GREEN (5a53a37) ships
// (src/codecs/playwright.ts), so the SuiteNode[] these tests see is exactly
// what production now emits — never hand-authored to match what the test
// wants.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import { parsePlaywright } from "../src/codecs/playwright.ts";
import type { SuiteNode, RunSummary } from "../src/types.ts";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── Shared fixture: ONE Playwright JSON report, TWO projects, run through
// the REAL codec ────────────────────────────────────────────────────────
interface StepFixture {
  title: string;
  duration: number;
  error?: { message: string; stack: string };
}

function projectTest(projectName: string, status: string, steps: StepFixture[]) {
  return {
    timeout: 30000,
    annotations: [],
    expectedStatus: "passed",
    projectId: projectName,
    projectName,
    results: [
      {
        workerIndex: 0,
        parallelIndex: 0,
        status,
        duration: steps.reduce((sum, s) => sum + s.duration, 0),
        retry: 0,
        steps,
        startTime: "2026-09-24T00:00:00.000Z",
        annotations: [],
        attachments: [],
      },
    ],
    status: "expected",
  };
}

const GIVEN_STEP: StepFixture = { title: "Given the board is open on a phone", duration: 3 };
const PASS_STEP: StepFixture = { title: "Then the Roadmap pane scrolls inside its own box", duration: 2 };
const FAIL_STEP: StepFixture = {
  title: "Then the Roadmap pane scrolls inside its own box",
  duration: 1,
  error: {
    message: "expected pane scrollTop > 0, got 0",
    stack: "Error: expected pane scrollTop > 0, got 0\n    at mobile-viewport.spec.ts:22:9",
  },
};

const SCENARIO_NAME = "responsive phone band › the pane scrolls in its own box";
const PASS_BROWSER = "chromium-mobile";
const FAIL_BROWSER = "webkit-iphone";

/** A REAL two-project Playwright JSON report: `chromium-mobile` listed
 *  FIRST and passing, `webkit-iphone` listed SECOND and failing — this AC's
 *  own framing ("the FIRST-listed browser passes and the second fails"). */
function crossBrowserReport() {
  return {
    config: { version: "1.61.1" },
    suites: [
      {
        title: "tests/e2e/features/mobile-viewport-responsive.feature.spec.js",
        file: "tests/e2e/features/mobile-viewport-responsive.feature.spec.js",
        column: 0,
        line: 0,
        specs: [],
        suites: [
          {
            title: "responsive phone band",
            file: "tests/e2e/features/mobile-viewport-responsive.feature.spec.js",
            line: 3,
            column: 6,
            specs: [
              {
                title: "the pane scrolls in its own box",
                ok: false,
                tags: [],
                tests: [
                  projectTest(PASS_BROWSER, "passed", [GIVEN_STEP, PASS_STEP]),
                  projectTest(FAIL_BROWSER, "failed", [GIVEN_STEP, FAIL_STEP]),
                ],
                id: "spec-cross-browser",
                file: "tests/e2e/features/mobile-viewport-responsive.feature.spec.js",
                line: 6,
                column: 3,
              },
            ],
          },
        ],
      },
    ],
    errors: [],
    stats: { startTime: "2026-09-24T00:00:00.000Z", duration: 6, expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
  };
}

/** Run through the REAL codec, exactly as C1 GREEN's ingest path does. */
function crossBrowserTree(): SuiteNode[] {
  return parsePlaywright(JSON.stringify(crossBrowserReport())).tree;
}

function crossBrowserSummary(): RunSummary {
  return parsePlaywright(JSON.stringify(crossBrowserReport())).summary;
}

// ──────────────────────────────────────────────────────────────────────
// ROUTE LEVEL — GET /api/v2/events/:id?depth=suites | ?suite=<name>[&browser=<b>]
// ──────────────────────────────────────────────────────────────────────
interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface RunsParsedResponse extends OkResponse {
  event: string;
}

interface EventGetResponse extends OkResponse {
  event: {
    id: string;
    tree?: unknown;
    [key: string]: unknown;
  };
}

describe("CR-CRU-145 §S1 — route: a scenario run under two browsers opens THAT browser's own steps", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function postJson(p: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function getJson(p: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${p}`);
  }
  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }
  async function registerAgent(projectKey: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey, agentId, role: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
  }
  async function seedCrossBrowserEvent(projectKey: string): Promise<string> {
    const agentId = "browser-scoping-agent";
    await registerAgent(projectKey, agentId);
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey,
      agentId,
      summary: crossBrowserSummary(),
      tree: crossBrowserTree(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsParsedResponse;
    return body.event;
  }

  test("?depth=suites carries each scenario node's OWN browser — the two same-named nodes stay distinguishable", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("browser-scoping-depth");
    const id = await seedCrossBrowserEvent(key);

    const res = await getJson(`/api/v2/events/${id}?depth=suites`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventGetResponse;
    const tree = body.event.tree as Array<{
      name: string;
      status: string;
      browser?: string;
      counts: { passed: number; failed: number; pending: number };
    }>;

    const sameNamed = tree.filter((n) => n.name === SCENARIO_NAME);
    // BOUND — both nodes still reach the skeleton (this much already works).
    expect(sameNamed.length).toBe(2);

    // POSITIVE — each node's OWN browser reaches the reply; neither is
    // undefined, and neither is confused with the other's.
    const passNode = sameNamed.find((n) => n.browser === PASS_BROWSER);
    const failNode = sameNamed.find((n) => n.browser === FAIL_BROWSER);
    expect(passNode).toBeDefined();
    expect(failNode).toBeDefined();
    expect(passNode?.status).toBe("pass");
    expect(failNode?.status).toBe("fail");
    expect(passNode?.counts).toEqual({ passed: 2, failed: 0, pending: 0 });
    expect(failNode?.counts).toEqual({ passed: 1, failed: 1, pending: 0 });
  });

  test("the per-suite read is narrowed by browser: returns the REQUESTED browser's node, never the first same-named one; browser omitted still returns the first match, unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("browser-scoping-suite");
    const id = await seedCrossBrowserEvent(key);

    // BOUND — no `browser` param: first match, UNCHANGED (chromium-mobile is
    // listed first in the ingested tree — this is the CR's own "unchanged"
    // clause, not a new behaviour).
    const unscoped = await getJson(`/api/v2/events/${id}?suite=${encodeURIComponent(SCENARIO_NAME)}`);
    expect(unscoped.status).toBe(200);
    const unscopedBody = (await unscoped.json()) as EventGetResponse;
    const unscopedTree = unscopedBody.event.tree as Array<{ name: string; status: string; browser?: string }>;
    expect(unscopedTree.length).toBe(1);
    expect(unscopedTree[0]?.browser).toBe(PASS_BROWSER);
    expect(unscopedTree[0]?.status).toBe("pass");

    // POSITIVE — narrowed to the FAILING browser: its OWN node, its OWN
    // failing step's message, never the passing browser's data.
    const failScoped = await getJson(
      `/api/v2/events/${id}?suite=${encodeURIComponent(SCENARIO_NAME)}&browser=${encodeURIComponent(FAIL_BROWSER)}`,
    );
    expect(failScoped.status).toBe(200);
    const failBody = (await failScoped.json()) as EventGetResponse;
    const failTree = failBody.event.tree as Array<{
      name: string;
      status: string;
      browser?: string;
      children: Array<{ name: string; status: string; failure?: { message: string } }>;
    }>;
    expect(failTree.length).toBe(1);
    expect(failTree[0]?.browser).toBe(FAIL_BROWSER);
    expect(failTree[0]?.status).toBe("fail");
    const failStep = failTree[0]?.children.find((c) => c.status === "fail");
    expect(failStep?.failure?.message).toBe("expected pane scrollTop > 0, got 0");

    // POSITIVE — narrowed to the PASSING browser, independently, proving the
    // narrowing is not a coincidence of "the failing one always wins".
    const passScoped = await getJson(
      `/api/v2/events/${id}?suite=${encodeURIComponent(SCENARIO_NAME)}&browser=${encodeURIComponent(PASS_BROWSER)}`,
    );
    expect(passScoped.status).toBe(200);
    const passBody = (await passScoped.json()) as EventGetResponse;
    const passTree = passBody.event.tree as Array<{
      name: string;
      status: string;
      browser?: string;
      children: Array<{ status: string; failure?: unknown }>;
    }>;
    expect(passTree.length).toBe(1);
    expect(passTree[0]?.browser).toBe(PASS_BROWSER);
    expect(passTree[0]?.status).toBe("pass");
    // NEGATIVE — the passing browser's own node carries no failure at all.
    expect(passTree[0]?.children.some((c) => c.status === "fail")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// UI LEVEL — the run detail keys loaded leaves / loading flag / window /
// leaf keys by (name, browser); expanding a browser's row fetches and
// shows THAT browser's own steps.
// ──────────────────────────────────────────────────────────────────────
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
          event: { id: eventId, kind: "test", tier: "e2e", codec: "playwright", tree: match !== undefined ? [match] : [] },
        };
      } else if (depthParam === "suites") {
        body = { ok: true, event: { id: eventId, kind: "test", tier: "e2e", codec: "playwright", summary, tree: suiteSkeleton(tree) } };
      } else {
        body = { ok: true, event: { id: eventId, kind: "test", tier: "e2e", codec: "playwright", summary, tree } };
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
            codec: "playwright",
            timestamp: Date.now(),
            ...summary,
            hasCoverage: false,
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
  test("expanding the failing browser's row fetches and shows its OWN failing step — never the passing browser's; expanding the passing browser's row fetches and shows only its OWN; each click's request carries that row's browser", async () => {
    const eventId = "evt-cross-browser-run-detail";
    const tree = crossBrowserTree();
    const summary = crossBrowserSummary();
    await mountApp(eventId, tree, summary);

    const rows = suiteRowsNamed(SCENARIO_NAME);
    // PRECONDITION — both same-named scenario rows are present, in the
    // FIXTURE's own order: the passing browser first, the failing second
    // (this AC's own framing).
    expect(rows.length).toBe(2);
    const passRow = rows[0]!;
    const failRow = rows[1]!;

    // Expand the FAILING browser's row FIRST.
    failRow.click();
    await settleDom();

    // MOCK VERIFICATION — that click's OWN request names the browser it
    // scoped to.
    expect(
      fetchLog.some(
        (u) => u.includes(`suite=${encodeURIComponent(SCENARIO_NAME)}`) && u.includes(`browser=${encodeURIComponent(FAIL_BROWSER)}`),
      ),
    ).toBe(true);

    // POSITIVE — the failing row's OWN leaves carry the failing step's
    // message AT that step.
    const failLeaves = leafRowsOf(failRow);
    const failThenLeaf = failLeaves.find((r) => (r.textContent ?? "").includes(FAIL_STEP.title));
    expect(failThenLeaf).toBeDefined();
    expect(failThenLeaf!.textContent ?? "").toContain("expected pane scrollTop > 0, got 0");

    // NEGATIVE — never the passing browser's steps: the failing row's own
    // subtree never renders a clean pass (no failure message) for that same
    // step title.
    expect((failThenLeaf!.textContent ?? "").includes("✓") && !(failThenLeaf!.textContent ?? "").includes("expected pane scrollTop")).toBe(false);

    // Expand the PASSING browser's row SECOND, independently.
    passRow.click();
    await settleDom();

    expect(
      fetchLog.some(
        (u) => u.includes(`suite=${encodeURIComponent(SCENARIO_NAME)}`) && u.includes(`browser=${encodeURIComponent(PASS_BROWSER)}`),
      ),
    ).toBe(true);

    // POSITIVE — the passing row's OWN leaves never carry the other
    // browser's failure message.
    const passLeaves = leafRowsOf(passRow);
    const passLeafText = passLeaves.map((r) => r.textContent ?? "").join(" | ");
    expect(passLeafText).not.toContain("expected pane scrollTop > 0, got 0");
    // POSITIVE — and DOES carry its own passing step.
    expect(passLeafText).toContain(GIVEN_STEP.title);
  });
});
