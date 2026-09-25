// CR-CRU-007 C5b — "playwright" registry codec, pulled forward from
// CR-CRU-015 §S2 (BDD results reporting AC): parses a Playwright JSON
// reporter report (`@playwright/test` `--reporter=json`, INCLUDING the
// playwright-bdd flavor where Gherkin feature/scenario names come through
// as ordinary suite/spec titles — playwright-bdd converts BDD scenarios to
// native Playwright tests, so the JSON shape is IDENTICAL either way) into
// the canonical feature → scenario → step RunSchema tree, per CR-CRU-010's
// registry-only resolution pattern (Codec.parse/parsePath, no direct-call
// escape hatches outside the registry entry).
//
// RED phase: `src/codecs/playwright.ts` (parsePlaywright / parsePlaywrightPath)
// and the `codecs.get("playwright")` registry entry do not exist yet — every
// test below is expected to FAIL (module-not-found / registry-undefined /
// TypeError) until GREEN implements §S2. The fixture below was crafted from
// a REAL `bunx playwright test --reporter=json` run of this repo's OWN
// converted BDD suite (tests/e2e/features/*.feature via playwright-bdd) —
// verified shape (2026-07-15, @playwright/test 1.61.1, playwright-bdd
// 9.2.0): top-level `{config, suites, errors, stats}`; `suites[i]` = one
// generated spec.js file (`.title` = the file path, `.specs` = [], nested
// `.suites[j]` = one Feature, `.title` = the literal Gherkin Feature name);
// `suites[i].suites[j].specs[k]` = one Scenario (`.title` = scenario name,
// `.ok` = boolean, `.tests[0].results` = attempts); each result carries
// `.status` ("passed" | "failed" | "timedOut" | "skipped" | "interrupted"),
// `.duration`, and `.steps[]` = `{title, duration, error?: {message, stack}}`
// — `title` is the LITERAL Gherkin step text ("Given …" / "When …" /
// "Then …" / "And …"); once a step errors, subsequent steps in that attempt
// are absent from the array (Playwright halts the test.step() chain).
//
// Contract this file defines for GREEN:
//   - `codecs.get("playwright")!.parse` (+ `.parsePath`) exist and delegate
//     to `parsePlaywright` / `parsePlaywrightPath` — registry-only
//     resolution, same as the "junit" entry (CR-CRU-010 §S1).
//   - RunSchema.tree: one `SuiteNode` PER SCENARIO — `name` =
//     "<Feature title> › <Scenario title>" (mirrors how parseJunit already
//     flattens nested <testsuite> wrappers down to their leaf suites,
//     dropping the wrapper name but keeping full identity via a composed
//     name here since the model has no 3rd tree level); `status` derived
//     from the LAST attempt's `status` ("passed" -> "pass",
//     "skipped"/"interrupted" -> "pending", else -> "fail").
//   - `SuiteNode.children`: one `TestLeaf` PER STEP, in step order — `name`
//     = the step's literal title (Given/When/Then/And text); `status` =
//     "fail" when the step carries an `error`, else "pass"; `duration_ms` =
//     `Math.round(step.duration)`; `failure` = `{message, trace}` from
//     `step.error.message` / `step.error.stack` when present.
//   - `RunSchema.summary` aggregates total/passed/failed/pending/duration_ms
//     across every leaf, same shape as parseJunit's `summarize()`.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { startServer } from "../src/server.ts";
import { codecs } from "../src/codecs/index.ts";
import type { Codec } from "../src/codecs/index.ts";
import type { RunSchema, SuiteNode, TestLeaf } from "../src/types.ts";

/** Runtime-only view of the not-yet-existing "playwright" registry entry —
 * mirrors tests/codec-parsepath.test.ts's `parsePathOf` helper so this file
 * stays tsc-clean before AND after GREEN registers the entry. */
function playwrightCodec(): Codec | undefined {
  return codecs.get("playwright");
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "codec-playwright-"));
}

/**
 * A REAL Playwright JSON reporter payload shape (see the file header for
 * provenance), trimmed to 1 feature / 2 scenarios: "Scenario A passing" (3
 * green Given/When/Then steps) and "Scenario B failing" (a passing Given
 * step, then a failing When step whose error HALTS the attempt — no Then
 * step recorded, matching Playwright's real test.step() abort behavior).
 */
const PLAYWRIGHT_REPORT = {
  config: { version: "1.61.1" },
  suites: [
    {
      title: "tests/e2e/features/sample.feature.spec.js",
      file: "tests/e2e/features/sample.feature.spec.js",
      column: 0,
      line: 0,
      specs: [],
      suites: [
        {
          title: "Sample Feature",
          file: "tests/e2e/features/sample.feature.spec.js",
          line: 3,
          column: 6,
          specs: [
            {
              title: "Scenario A passing",
              ok: true,
              tags: [],
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [
                    {
                      workerIndex: 0,
                      parallelIndex: 0,
                      status: "passed",
                      duration: 10,
                      errors: [],
                      stdout: [],
                      stderr: [],
                      retry: 0,
                      steps: [
                        { title: "Given a thing", duration: 5 },
                        { title: "When it happens", duration: 3 },
                        { title: "Then it works", duration: 2 },
                      ],
                      startTime: "2026-07-15T00:00:00.000Z",
                      annotations: [],
                      attachments: [],
                    },
                  ],
                  status: "expected",
                },
              ],
              id: "spec-a",
              file: "tests/e2e/features/sample.feature.spec.js",
              line: 6,
              column: 3,
            },
            {
              title: "Scenario B failing",
              ok: false,
              tags: [],
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [
                    {
                      workerIndex: 0,
                      parallelIndex: 0,
                      status: "failed",
                      duration: 5,
                      error: {
                        message: "Error: boom",
                        stack: "Error: boom\n    at file.ts:10:5",
                      },
                      errors: [
                        {
                          message: "Error: boom",
                          stack: "Error: boom\n    at file.ts:10:5",
                        },
                      ],
                      stdout: [],
                      stderr: [],
                      retry: 0,
                      steps: [
                        { title: "Given a thing", duration: 4 },
                        {
                          title: "When it breaks",
                          duration: 1,
                          error: {
                            message: "Error: boom",
                            stack: "Error: boom\n    at file.ts:10:5",
                          },
                        },
                      ],
                      startTime: "2026-07-15T00:00:05.000Z",
                      annotations: [],
                      attachments: [],
                    },
                  ],
                  status: "unexpected",
                },
              ],
              id: "spec-b",
              file: "tests/e2e/features/sample.feature.spec.js",
              line: 14,
              column: 3,
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: { startTime: "2026-07-15T00:00:00.000Z", duration: 20, expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
};

describe("codecs registry — 'playwright' entry (CR-CRU-007 C5b, pulled from CR-CRU-015 §S2)", () => {
  test("codecs.get('playwright') exists with a parse function", () => {
    expect(playwrightCodec()).toBeDefined();
    expect(typeof playwrightCodec()!.parse).toBe("function");
  });

  test("codecs.get('playwright')!.parsePath is a function", () => {
    const parsePathFn = (playwrightCodec() as unknown as { parsePath?: unknown } | undefined)?.parsePath;
    expect(typeof parsePathFn).toBe("function");
  });
});

describe("parsePlaywright — feature → scenario → step tree (real reporter shape)", () => {
  test("2 scenarios (1 pass, 1 fail) parse to one SuiteNode PER SCENARIO, named '<Feature> › <Scenario>'", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));

    expect(result.tree.length).toBe(2);
    const names = result.tree.map((s) => s.name);
    expect(names).toContain("Sample Feature › Scenario A passing");
    expect(names).toContain("Sample Feature › Scenario B failing");
  });

  test("the passing scenario's tree node is status 'pass' with 3 passing step leaves in Given/When/Then order", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));
    const scenarioA = result.tree.find((s) => s.name === "Sample Feature › Scenario A passing");
    expect(scenarioA).toBeDefined();
    expect(scenarioA?.status).toBe("pass");
    expect(scenarioA?.children.map((c) => c.name)).toEqual([
      "Given a thing",
      "When it happens",
      "Then it works",
    ]);
    expect(scenarioA?.children.every((c) => c.status === "pass")).toBe(true);
    expect(scenarioA?.children.map((c) => c.duration_ms)).toEqual([5, 3, 2]);
  });

  test("the failing scenario's tree node is status 'fail'; its failing step carries failure {message, trace}; the halted step never appears", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));
    const scenarioB = result.tree.find((s) => s.name === "Sample Feature › Scenario B failing");
    expect(scenarioB).toBeDefined();
    expect(scenarioB?.status).toBe("fail");
    expect(scenarioB?.children.length).toBe(2);

    const givenStep = scenarioB?.children.find((c) => c.name === "Given a thing");
    expect(givenStep?.status).toBe("pass");

    const whenStep = scenarioB?.children.find((c) => c.name === "When it breaks");
    expect(whenStep?.status).toBe("fail");
    expect(whenStep?.duration_ms).toBe(1);
    expect(whenStep?.failure?.message).toBe("Error: boom");
    expect(whenStep?.failure?.trace).toContain("at file.ts:10:5");

    // The halted "Then …" step never ran — no leaf for it, not even a
    // synthetic one (matches the REAL Playwright reporter's own behavior).
    expect(scenarioB?.children.some((c) => c.name.startsWith("Then"))).toBe(false);
  });

  test("summary aggregates total/passed/failed/pending/duration_ms across every step leaf, matching parseJunit's summarize() semantics", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));
    // 5 total leaves (3 + 2): 4 passed, 1 failed, 0 pending.
    expect(result.summary).toEqual({
      total: 5,
      passed: 4,
      failed: 1,
      pending: 0,
      duration_ms: 5 + 3 + 2 + 4 + 1,
    });
  });
});

describe("parsePlaywrightPath — file + directory resolution", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  test("parsePath(filePath) resolves the SAME RunSchema as parsing the file's contents directly (delegate check)", async () => {
    const dir = freshDir();
    tmpDirs.push(dir);
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(PLAYWRIGHT_REPORT));

    const parsePathFn = (playwrightCodec() as unknown as { parsePath: (p: string) => Promise<RunSchema> })
      .parsePath;
    const viaPath = await parsePathFn(reportPath);
    const viaInline = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));
    expect(viaPath).toEqual(viaInline);
  });

  test("parsePath(dirPath) finds report.json inside the directory", async () => {
    const dir = freshDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "report.json"), JSON.stringify(PLAYWRIGHT_REPORT));

    const parsePathFn = (playwrightCodec() as unknown as { parsePath: (p: string) => Promise<RunSchema> })
      .parsePath;
    const result = await parsePathFn(dir);
    expect(result.tree.length).toBe(2);
  });
});

describe("registry-only resolution (grep AC, CR-CRU-010 pattern)", () => {
  test("no direct parsePlaywright/parsePlaywrightPath call exists outside the registry entry", () => {
    const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const v2Src = readFileSync(new URL("../src/v2.ts", import.meta.url), "utf8");
    expect(serverSrc).not.toContain("parsePlaywright");
    expect(v2Src).not.toContain("parsePlaywright");

    const codecsSrc = readFileSync(new URL("../src/codecs/index.ts", import.meta.url), "utf8");
    const nonImportOccurrences = codecsSrc
      .split("\n")
      .filter(
        (line) => !line.trimStart().startsWith("import") && line.includes("parsePlaywright"),
      );
    // Exactly the registry entry's parse + parsePath registrations — not a
    // stray direct call anywhere else in the file.
    expect(nonImportOccurrences.length).toBeGreaterThan(0);
    expect(nonImportOccurrences.length).toBeLessThanOrEqual(2);

    const mapStart = codecsSrc.indexOf("export const codecs");
    expect(mapStart).toBeGreaterThanOrEqual(0);
    const mapEnd = codecsSrc.indexOf("]);", mapStart);
    expect(mapEnd).toBeGreaterThan(mapStart);
    const mapLiteral = codecsSrc.slice(mapStart, mapEnd);
    expect(mapLiteral).toContain('"playwright"');
    expect(mapLiteral).toContain("parsePlaywright");
  });
});

describe("v2 ingest with codec:'playwright' stores the feature → scenario → step tree", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("POST /api/v2/runs with codec:'playwright' stores the parsed tree; GET /api/v2/events/<id> returns it verbatim", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const createRes = await fetch(`http://localhost:${handle.server.port}/api/v2/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bdd-project", type: "frontend" }),
    });
    const created = (await createRes.json()) as { ok: true; project: { key: string } };
    const projectKey = created.project.key;

    // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs now refuses an
    // unregistered agentId (409) — register the ingesting agent first.
    await fetch(`http://localhost:${handle.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey, agentId: "bdd-agent", role: "report" }),
    });

    const ingestRes = await fetch(`http://localhost:${handle.server.port}/api/v2/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectKey,
        agentId: "bdd-agent",
        codec: "playwright",
        data: JSON.stringify(PLAYWRIGHT_REPORT),
        tier: "e2e",
      }),
    });
    expect(ingestRes.status).toBe(200);
    const ingestBody = (await ingestRes.json()) as { ok: true; event: string };

    const eventRes = await fetch(
      `http://localhost:${handle.server.port}/api/v2/events/${ingestBody.event}`,
    );
    expect(eventRes.status).toBe(200);
    const eventBody = (await eventRes.json()) as {
      ok: true;
      event: { codec?: string; tree?: Array<{ name: string; status: string; children: unknown[] }> };
    };
    expect(eventBody.event.codec).toBe("playwright");
    expect(eventBody.event.tree?.length).toBe(2);
    const names = eventBody.event.tree?.map((s) => s.name) ?? [];
    expect(names).toContain("Sample Feature › Scenario A passing");
    expect(names).toContain("Sample Feature › Scenario B failing");
  });
});

// ── drill-in renders scenario/step rows (DOM test, happy-dom harness) ─────
//
// Self-contained happy-dom harness — same pattern as tests/drill-in.test.ts
// (real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; `fetch` scripted to serve canned v2 API payloads,
// including the progressive `?depth=suites` / `?suite=<name>` contract).
// The tree fixture below is the EXACT shape `parsePlaywright` is contracted
// to produce (asserted above) — this test proves the (codec-agnostic)
// drill-in genuinely renders a playwright-coded run's scenario/step tree
// with Given/When/Then step names and the "playwright" codec badge, not
// just that the codec itself parses correctly.
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface DomSuiteNode {
  name: string;
  status: "pass" | "fail" | "pending";
  children: Array<{ name: string; status: "pass" | "fail" | "pending"; duration_ms: number; failure?: { message: string; trace?: string } }>;
}

let cacheBust = 0;

async function mountAppWithPlaywrightRun(eventId: string, tree: DomSuiteNode[]): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/` });
  document.body.innerHTML = '<div id="app"></div>';

  const projectKey = "proj-bdd-dom";
  const summary = tree.reduce(
    (acc, suite) => {
      for (const leaf of suite.children) {
        acc.total += 1;
        if (leaf.status === "pass") acc.passed += 1;
        else if (leaf.status === "fail") acc.failed += 1;
        else acc.pending += 1;
      }
      return acc;
    },
    { total: 0, passed: 0, failed: 0, pending: 0 },
  );

  const detail = {
    id: eventId,
    projectKey,
    agentId: "bdd-dom-agent",
    kind: "test",
    tier: "e2e",
    codec: "playwright",
    timestamp: Date.now(),
    summary: { ...summary, duration_ms: 100 },
    tree,
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = tree.find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const shallow = tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: {
            passed: n.children.filter((c) => c.status === "pass").length,
            failed: n.children.filter((c) => c.status === "fail").length,
            pending: n.children.filter((c) => c.status === "pending").length,
          },
        }));
        body = { ok: true, event: { ...detail, tree: shallow } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = {
        ok: true,
        projects: [{ key: projectKey, name: "BDD DOM", type: "frontend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() }],
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
            agentId: "bdd-dom-agent",
            kind: "test",
            tier: "e2e",
            codec: "playwright",
            timestamp: Date.now(),
            ...summary,
            duration_ms: 100,
            hasCoverage: false,
          },
        ],
      };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`playwright-codec.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?playwrightCodecDom=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 20));
}

// CR-CRU-038 §S1 RETARGET (2026-07-22): this test previously PASSED
// against production because the e2e-tier drill-in auto-expanded the
// failing scenario on open (§S4.1's now-retired auto-expand). That default
// is gone — a failing run (any tier) now opens MINIMIZED — so this test
// now FAILS until GREEN lands, expanding the failing scenario via an
// explicit suite-row click instead. It still proves the drill-in needs NO
// playwright-specific UI work: Given/When/Then step names render exactly
// like any other leaf name once expanded, and the codec badge passes
// `e.codec` through verbatim. The genuinely RED half of this AC (codec
// resolution + tree storage) is covered by the "v2 ingest with
// codec:'playwright'" describe block above.
describe("drill-in renders scenario/step rows for a playwright-coded run (DOM, happy-dom harness)", () => {
  afterEach(async () => {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });

  test("event card shows the 'playwright' codec badge; opening it renders the failing scenario's steps (Given/When/Then names) inline, with the passing scenario collapsed", async () => {
    const eventId = "evt-bdd-dom-1";
    const tree: DomSuiteNode[] = [
      {
        // The passing scenario sits in its OWN all-green feature, so under
        // the progressive default it folds at the feature level and "the rest
        // don't render" is a clean bound (see the migration note below).
        name: "Another Feature › Scenario A passing",
        status: "pass",
        children: [
          { name: "Given a thing", status: "pass", duration_ms: 5 },
          { name: "When it happens", status: "pass", duration_ms: 3 },
          { name: "Then it works", status: "pass", duration_ms: 2 },
        ],
      },
      {
        name: "Sample Feature › Scenario B failing",
        status: "fail",
        children: [
          { name: "Given a thing", status: "pass", duration_ms: 4 },
          {
            name: "When it breaks",
            status: "fail",
            duration_ms: 1,
            failure: { message: "Error: boom", trace: "Error: boom\n    at file.ts:10:5" },
          },
        ],
      },
    ];
    await mountAppWithPlaywrightRun(eventId, tree);

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.querySelector('[data-testid="codec-badge"]')?.textContent).toBe("playwright");
    card!.click();
    await new Promise((r) => setTimeout(r, 200));

    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    // MIGRATED 2026-09-24 (CR-CRU-145 §S1, authorized by the orchestrator):
    // a codec:"playwright" run no longer opens MINIMIZED — it opens
    // PROGRESSIVELY EXPANDED. The failing feature floats first and opens,
    // and its failing scenario's steps render ON OPEN with no click; the
    // all-green feature folds, so the passing scenario's steps never render.
    // The non-playwright MINIMIZED default is pinned in
    // tests/playwright-run-progressive-expansion.test.ts (the junit case).
    const failScenarioRow = Array.from(overlay!.querySelectorAll('[data-testid="suite-row"]')).find(
      (el) => (el.textContent ?? "").includes("Scenario B failing"),
    );
    expect(failScenarioRow).toBeDefined();
    expect(
      (failScenarioRow as HTMLElement).querySelector('[data-testid="tree-toggle"]')!.textContent?.trim(),
    ).toBe("▾");

    // The failing scenario's Given/When/Then step names render like any
    // other leaf name — with NO click.
    const whenBreaksLeaf = Array.from(overlay!.querySelectorAll('[data-testid="leaf-row"]')).find((el) =>
      (el.textContent ?? "").includes("When it breaks"),
    );
    expect(whenBreaksLeaf).toBeDefined();

    const givenLeaf = Array.from(overlay!.querySelectorAll('[data-testid="leaf-row"]')).find((el) =>
      (el.textContent ?? "").includes("Given a thing"),
    );
    expect(givenLeaf).toBeDefined();

    // Bound: the passing scenario's steps never rendered (folded/collapsed,
    // never clicked).
    const whenHappensLeaf = Array.from(overlay!.querySelectorAll('[data-testid="leaf-row"]')).find((el) =>
      (el.textContent ?? "").includes("When it happens"),
    );
    expect(whenHappensLeaf).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// CR-CRU-145 §S3 — the missing frame elements: a verdict PER BROWSER.
//
// Measured 2026-09-24 at gap analysis: `specToNode` flattens the results of
// ALL of a spec's `tests` and keeps the LAST as the verdict — but a spec's
// `tests` array is one entry PER PLAYWRIGHT PROJECT, not one per retry
// (`playwright.config.ts`'s `testMatch` runs `mobile-viewport-responsive
// .feature` under BOTH `chromium-mobile` and `webkit-iphone`). So today ONE
// browser's verdict silently replaces the other's whenever both run the same
// spec, and the dropped `projectName` means neither can even be told apart
// once merged.
//
// THESE CASES ARE ADDITIVE — every existing case above is untouched, per the
// non-goal ("existing behavior and unit coverage stand"). The fixtures below
// use the SAME real reporter shape as `PLAYWRIGHT_REPORT` above (see that
// fixture's provenance note): `spec.tests[i]` is one PROJECT's test replica,
// carrying its OWN `projectName` and its OWN `results` (that project's own
// attempts/retries, last-of-array is that project's last attempt).
//
// DESIGN CHOICE DECLARED FOR THE ORCHESTRATOR (the AC does not name a field):
// the CR's own wording — "additive to the node shape" — is read as SuiteNode
// gaining one new optional field, `browser`, sourced from `projectName`,
// rather than folding the project into the composed `name` string (which
// already composes Feature+Scenario and has no room for a third dimension
// without inventing a second separator). `browser` is the word F11's own
// prose uses throughout ("each scenario names the browser it ran in", "each
// browser gets its own verdict") and is what these tests assert. If GREEN's
// author prefers a different field name, this file is the place to change
// it — but the field must exist and be OPTIONAL so every other codec's
// SuiteNode (no `browser`) still typechecks.
type ScenarioNode = SuiteNode & { browser?: string };

// A single-project report — the ALREADY-EXISTING `PLAYWRIGHT_REPORT` fixture
// carries `projectName: "chromium"` on both specs' sole `tests[0]` entry, and
// the codec drops it today (no `browser` reaches `SuiteNode` at all).
describe("CR-CRU-145 §S3 — projectName reaches each scenario as `browser`", () => {
  test("a single-project report's scenario nodes each carry `browser` from the report's projectName", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(PLAYWRIGHT_REPORT));
    const tree = result.tree as ScenarioNode[];
    const scenarioA = tree.find((s) => s.name === "Sample Feature › Scenario A passing");
    const scenarioB = tree.find((s) => s.name === "Sample Feature › Scenario B failing");
    expect(scenarioA).toBeDefined();
    expect(scenarioB).toBeDefined();
    expect(scenarioA?.browser).toBe("chromium");
    expect(scenarioB?.browser).toBe("chromium");
  });
});

interface PwStepFixture {
  title: string;
  duration: number;
  error?: { message: string; stack: string };
}

/** Builds one spec's `tests[]` entry for ONE Playwright project: its own
 *  `projectName` and its own ordered `results` (retries within THAT project
 *  only — never mixed with another project's attempts). */
function projectTest(projectName: string, results: Array<{ status: string; steps: PwStepFixture[] }>) {
  return {
    timeout: 30000,
    annotations: [],
    expectedStatus: "passed",
    projectId: projectName,
    projectName,
    results: results.map((r, i) => ({
      workerIndex: 0,
      parallelIndex: 0,
      status: r.status,
      duration: r.steps.reduce((sum, s) => sum + s.duration, 0),
      retry: i,
      steps: r.steps,
      startTime: "2026-09-24T00:00:00.000Z",
      annotations: [],
      attachments: [],
    })),
    status: "expected",
  };
}

const GIVEN_STEP: PwStepFixture = { title: "Given the board is open on a phone", duration: 3 };
const CHROMIUM_PASS_STEP: PwStepFixture = { title: "Then the Roadmap pane scrolls inside its own box", duration: 2 };
const WEBKIT_FAIL_STEP: PwStepFixture = {
  title: "Then the Roadmap pane scrolls inside its own box",
  duration: 1,
  error: { message: "expected pane scrollTop > 0, got 0", stack: "Error: expected pane scrollTop > 0, got 0\n    at mobile-viewport.spec.ts:22:9" },
};

/** One feature, one spec, run under BOTH `chromium-mobile` (passing) and
 *  `webkit-iphone` (failing) — the exact cross-browser collision §S3
 *  describes, `mobile-viewport-responsive.feature`'s own scenario name kept
 *  verbatim from F11's mock. `order` controls which project's `tests[]`
 *  entry comes first, so the fix is proven independent of report order. */
function twoProjectReport(order: "mobile-first" | "webkit-first") {
  const mobile = projectTest("chromium-mobile", [{ status: "passed", steps: [GIVEN_STEP, CHROMIUM_PASS_STEP] }]);
  const webkit = projectTest("webkit-iphone", [{ status: "failed", steps: [GIVEN_STEP, WEBKIT_FAIL_STEP] }]);
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
                tests: order === "mobile-first" ? [mobile, webkit] : [webkit, mobile],
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

describe("CR-CRU-145 §S3 — a verdict PER BROWSER: one spec run under two projects decodes to TWO scenario nodes", () => {
  test("mobile-first report order: two nodes, each named with its own browser, each keeping its own verdict; the run summary counts both", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(twoProjectReport("mobile-first")));
    const tree = result.tree as ScenarioNode[];
    const crossBrowser = tree.filter((s) => s.name === "responsive phone band › the pane scrolls in its own box");

    // POSITIVE — exactly two nodes, one per project, neither hiding the other.
    expect(crossBrowser.length).toBe(2);
    const chromiumNode = crossBrowser.find((s) => s.browser === "chromium-mobile");
    const webkitNode = crossBrowser.find((s) => s.browser === "webkit-iphone");
    expect(chromiumNode).toBeDefined();
    expect(webkitNode).toBeDefined();

    // POSITIVE — each browser's OWN verdict: the webkit failure is never
    // hidden behind the chromium pass, and vice versa.
    expect(chromiumNode?.status).toBe("pass");
    expect(webkitNode?.status).toBe("fail");
    expect(webkitNode?.children.find((c: TestLeaf) => c.status === "fail")?.failure?.message).toBe(
      "expected pane scrollTop > 0, got 0",
    );

    // POSITIVE — the run summary counts BOTH nodes' leaves (2 steps each: 4
    // total, 3 passed [chromium's 2 + webkit's Given], 1 failed).
    expect(result.summary.total).toBe(4);
    expect(result.summary.passed).toBe(3);
    expect(result.summary.failed).toBe(1);
  });

  test("webkit-first report order: the SAME two verdicts resolve, independent of which project's tests[] entry comes first", async () => {
    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(twoProjectReport("webkit-first")));
    const tree = result.tree as ScenarioNode[];
    const crossBrowser = tree.filter((s) => s.name === "responsive phone band › the pane scrolls in its own box");

    expect(crossBrowser.length).toBe(2);
    const chromiumNode = crossBrowser.find((s) => s.browser === "chromium-mobile");
    const webkitNode = crossBrowser.find((s) => s.browser === "webkit-iphone");
    expect(chromiumNode?.status).toBe("pass");
    expect(webkitNode?.status).toBe("fail");
  });
});

describe("CR-CRU-145 §S3 — retries within ONE project still resolve to that project's own last attempt", () => {
  test("two projects, each retried, each keep their OWN last attempt — never the globally-last result across both projects", async () => {
    // Project A: fails, fails, then PASSES (3 attempts) — its own last is
    // "pass". Project B: passes, then FAILS (2 attempts) — its own last is
    // "fail". Today's flatten-and-take-last-across-ALL-tests bug would
    // collapse this whole spec to ONE node carrying whichever project's
    // `tests[]` entry happens to sit last in the report (project B here),
    // silently dropping project A's node and its genuinely-passing verdict.
    const failStep: PwStepFixture = {
      title: "Then it eventually passes",
      duration: 2,
      error: { message: "flaky failure", stack: "Error: flaky failure\n    at retry.spec.ts:9:1" },
    };
    const passStep: PwStepFixture = { title: "Then it eventually passes", duration: 2 };
    const projectA = projectTest("chromium", [
      { status: "failed", steps: [GIVEN_STEP, failStep] },
      { status: "failed", steps: [GIVEN_STEP, failStep] },
      { status: "passed", steps: [GIVEN_STEP, passStep] },
    ]);
    const projectB = projectTest("firefox", [
      { status: "passed", steps: [GIVEN_STEP, passStep] },
      { status: "failed", steps: [GIVEN_STEP, failStep] },
    ]);
    const report = {
      config: { version: "1.61.1" },
      suites: [
        {
          title: "tests/e2e/features/retry-sample.feature.spec.js",
          file: "tests/e2e/features/retry-sample.feature.spec.js",
          column: 0,
          line: 0,
          specs: [],
          suites: [
            {
              title: "Retry Feature",
              file: "tests/e2e/features/retry-sample.feature.spec.js",
              line: 3,
              column: 6,
              specs: [
                {
                  title: "a flaky scenario",
                  ok: false,
                  tags: [],
                  tests: [projectA, projectB],
                  id: "spec-retry",
                  file: "tests/e2e/features/retry-sample.feature.spec.js",
                  line: 6,
                  column: 3,
                },
              ],
            },
          ],
        },
      ],
      errors: [],
      stats: { startTime: "2026-09-24T00:00:00.000Z", duration: 8, expected: 1, skipped: 0, unexpected: 1, flaky: 1 },
    };

    const result: RunSchema = await playwrightCodec()!.parse(JSON.stringify(report));
    const tree = result.tree as ScenarioNode[];
    const nodes = tree.filter((s) => s.name === "Retry Feature › a flaky scenario");
    expect(nodes.length).toBe(2);

    const chromiumNode = nodes.find((s) => s.browser === "chromium");
    const firefoxNode = nodes.find((s) => s.browser === "firefox");
    expect(chromiumNode).toBeDefined();
    expect(firefoxNode).toBeDefined();

    // POSITIVE — chromium's OWN last attempt (the 3rd) is "pass", carrying
    // that attempt's own steps, not the 1st/2nd failing attempt's.
    expect(chromiumNode?.status).toBe("pass");
    expect(chromiumNode?.children.every((c: TestLeaf) => c.status === "pass")).toBe(true);

    // POSITIVE — firefox's OWN last attempt (the 2nd) is "fail", independent
    // of chromium's verdict sitting elsewhere in the same spec.
    expect(firefoxNode?.status).toBe("fail");
    expect(firefoxNode?.children.some((c: TestLeaf) => c.status === "fail")).toBe(true);
  });
});

