// CR-CRU-007 §S3 (drill-in slide-over, codec-aware) + §S4 item 0
// (tier-default mode + manual override) + §S4 item 5 (progressive payload,
// consume-only — the API already exists, CR-CRU-004 §S4).
//
// Drives the REAL production public/app.js shell inside a happy-dom window
// — same harness pattern as tests/run-cards.test.ts / tests/shell-final-form.test.ts:
// real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; `fetch` is scripted. The single-event GET mock below
// re-implements the server's ALREADY-COVERED progressive-payload contract
// (?depth=suites -> {name,status,counts}; ?suite=<name> -> that suite's full
// leaves — see tests/v2-stream-paging.test.ts) purely so app.js's
// CONSUMPTION of that contract can be exercised without booting the real
// HTTP server.
//
// RED phase: expected to fail against the CURRENT public/app.js RunOverlay,
// which is a static placeholder (`div.app-empty` "run detail lands in
// CR-CRU-007"), has no onclick on EventCard, never fetches
// /api/v2/events/<id>, and has none of: data-testid="failure-box",
// "raw-toggle", "raw-output", "drillin-mode", "suite-row", "leaf-row",
// "diag-group", "diag-line" (drill-in scoped), or a "← timeline" back
// control. Contract this file defines for GREEN:
//   - clicking `[data-testid="event-card"]` navigates to `/run/<id>` (or
//     `/p/<key>/run/<id>` from the workspace) and opens
//     `[data-testid="run-overlay"]` (already exists, reused as-is).
//   - test body: `[data-testid="suite-row"]` per top-level suite (no leaves
//     until expanded); clicking one fetches `?suite=<name>` and renders
//     `[data-testid="leaf-row"]` per leaf; clicking a FAILED leaf-row
//     toggles `[data-testid="failure-box"]` containing failure.message +
//     failure.trace.
//   - compile body: `[data-testid="diag-group"]` per distinct file, each
//     containing `[data-testid="diag-line"]` rows formatted
//     `file:line:col — message` and level-classed (class contains "error"
//     or "warning"); `[data-testid="raw-toggle"]` toggles
//     `[data-testid="raw-output"]` (the stored raw compiler output); NO
//     `[data-testid="drillin-mode"]` renders for compile events.
//   - `[data-testid="drillin-mode"]` (test events only) exposes the current
//     mode via a `data-mode` attribute ("Detail" | "Density"), defaulted
//     per `L.drillinDefaultMode(tier)` and overridable by click; the
//     override persists to `L.drillinModeStorageKey(tier)` in localStorage.
//   - a "← timeline" control (matched by text, same convention as the
//     existing "← projects" workspace chip) closes the overlay exactly like
//     Escape — restoring the underlying surface's own route (home stays
//     home, workspace stays workspace).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

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

interface FailureFixture {
  message: string;
  type?: string;
  trace?: string;
}
interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface DiagnosticFixture {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
}
interface CompileFixture {
  format: string;
  errorCount: number;
  warningCount: number;
  diagnostics: DiagnosticFixture[];
  raw: string;
}

interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: SuiteFixture[];
  compile?: CompileFixture;
}

interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  errors?: number;
  warnings?: number;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
  /** Seeds localStorage BEFORE app.js boots — simulates "remembered from a previous session" since happy-dom gives each GlobalRegistrator.register() a fresh Storage(). */
  localStorageSeed?: Record<string, string>;
}

let cacheBust = 0;
let fetchLog: string[] = [];

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** Same mountApp harness pattern as tests/run-cards.test.ts, extended with a per-event-id GET mock. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';
  fetchLog = [];

  if (opts.localStorageSeed !== undefined) {
    for (const [key, value] of Object.entries(opts.localStorageSeed)) {
      window.localStorage.setItem(key, value);
    }
  }

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`drill-in.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = (detail.tree ?? []).find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = (detail.tree ?? []).map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects ?? [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`drill-in.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?drillIn=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

describe("§S3 — test-run drill-in body (suite tree + failure box)", () => {
  test("clicking a 🧪 card opens run-overlay with the suite tree; the URL gains /run/<eventId>; expanding the failing suite and its failed leaf reveals failure.message + trace", async () => {
    const now = Date.now();
    const eventId = "evt-drill-test-1";
    const projectKey = "proj-drill-1";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Drill Test",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "drill-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 2,
          failed: 1,
          pending: 0,
          duration_ms: 1200,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "drill-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 1200 },
          tree: [
            {
              name: "SuiteA",
              status: "fail",
              children: [
                { name: "testPass1", status: "pass", duration_ms: 10 },
                {
                  name: "testFail1",
                  status: "fail",
                  duration_ms: 20,
                  failure: {
                    message: "expected 2 to equal 3",
                    trace: "at testFail1 (file.ts:10:5)",
                  },
                },
              ],
            },
            {
              name: "SuiteB",
              status: "pass",
              children: [{ name: "testPass2", status: "pass", duration_ms: 15 }],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    expect(location.pathname).toBe(`/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    // Suite tree present, no leaves yet (progressive payload — see §S4.5 tests below).
    const suiteRows = overlay!.querySelectorAll('[data-testid="suite-row"]');
    expect(suiteRows.length).toBe(2);

    const suiteARow = findByText(overlay!, '[data-testid="suite-row"]', "SuiteA");
    expect(suiteARow).toBeDefined();
    suiteARow!.click();
    await settle();

    const suiteFetch = fetchLog.find((u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteA"));
    expect(suiteFetch).toBeDefined();

    const leafRows = overlay!.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(2);

    const failLeaf = findByText(overlay!, '[data-testid="leaf-row"]', "testFail1");
    const passLeaf = findByText(overlay!, '[data-testid="leaf-row"]', "testPass1");
    expect(failLeaf).toBeDefined();
    expect(passLeaf).toBeDefined();

    // bound: clicking the PASSING leaf never produces a failure box.
    passLeaf!.click();
    await settle();
    expect(overlay!.querySelector('[data-testid="failure-box"]')).toBeNull();

    failLeaf!.click();
    await settle();

    const failureBox = overlay!.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect((failureBox!.textContent ?? "")).toContain("expected 2 to equal 3");
    expect((failureBox!.textContent ?? "")).toContain("at testFail1 (file.ts:10:5)");
    // bound: mono/red-accent styling is a real class, not an unstyled box.
    expect(failureBox!.className.length).toBeGreaterThan(0);
  });
});

describe("§S3 — compile drill-in body (diagnostics by file + raw toggle)", () => {
  test("clicking a 🛠 card opens the SAME run-overlay with diagnostics grouped by file, a working raw-output toggle, and no drillin-mode switch", async () => {
    const now = Date.now();
    const eventId = "evt-drill-compile-1";
    const projectKey = "proj-drill-2";
    const rawOutput =
      "error[E0308]: mismatched types\n --> src/lib.rs:12:5\nwarning: unused variable\n --> src/lib.rs:20:1\nerror: missing semicolon\n --> src/main.rs:3:9";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Drill Compile",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "compile-drill-agent",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          hasCoverage: false,
          errors: 2,
          warnings: 1,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "compile-drill-agent",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          compile: {
            format: "rustc",
            errorCount: 2,
            warningCount: 1,
            diagnostics: [
              { file: "src/lib.rs", line: 12, col: 5, message: "mismatched types", level: "error" },
              { file: "src/lib.rs", line: 20, col: 1, message: "unused variable", level: "warning" },
              { file: "src/main.rs", line: 3, col: 9, message: "missing semicolon", level: "error" },
            ],
            raw: rawOutput,
          },
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    expect(location.pathname).toBe(`/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    // bound: compile drill-ins render no mode switch.
    expect(overlay!.querySelector('[data-testid="drillin-mode"]')).toBeNull();

    const groups = overlay!.querySelectorAll('[data-testid="diag-group"]');
    expect(groups.length).toBe(2);

    const libGroup = findByText(overlay!, '[data-testid="diag-group"]', "src/lib.rs");
    expect(libGroup).toBeDefined();
    const libLines = libGroup!.querySelectorAll('[data-testid="diag-line"]');
    expect(libLines.length).toBe(2);
    const libLineTexts = Array.from(libLines).map((l) => (l.textContent ?? "").trim());
    expect(libLineTexts).toContain("src/lib.rs:12:5 — mismatched types");
    expect(libLineTexts).toContain("src/lib.rs:20:1 — unused variable");

    const errorLine = Array.from(libLines).find((l) => (l.textContent ?? "").includes("mismatched types"));
    const warningLine = Array.from(libLines).find((l) => (l.textContent ?? "").includes("unused variable"));
    expect(errorLine!.className).toContain("error");
    expect(warningLine!.className).toContain("warning");

    const mainGroup = findByText(overlay!, '[data-testid="diag-group"]', "src/main.rs");
    expect(mainGroup).toBeDefined();
    expect(mainGroup!.querySelectorAll('[data-testid="diag-line"]').length).toBe(1);

    // Raw-output toggle: hidden until clicked, then reveals the stored raw text, then hides again.
    expect(overlay!.querySelector('[data-testid="raw-output"]')).toBeNull();
    const rawToggle = overlay!.querySelector('[data-testid="raw-toggle"]') as HTMLElement | null;
    expect(rawToggle).not.toBeNull();

    rawToggle!.click();
    await settle();
    const rawOutputEl = overlay!.querySelector('[data-testid="raw-output"]');
    expect(rawOutputEl).not.toBeNull();
    expect((rawOutputEl!.textContent ?? "")).toContain("mismatched types");
    expect((rawOutputEl!.textContent ?? "")).toContain("src/main.rs:3:9");

    rawToggle!.click();
    await settle();
    expect(overlay!.querySelector('[data-testid="raw-output"]')).toBeNull();
  });
});

describe("§S3 — back control ('← timeline') and Escape parity", () => {
  function testFixture(eventId: string, projectKey: string, now: number) {
    return {
      brief: {
        id: eventId,
        projectKey,
        agentId: "back-agent",
        kind: "test" as const,
        tier: "unit",
        codec: "junit",
        timestamp: now,
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        duration_ms: 5,
        hasCoverage: false,
      },
      detail: {
        id: eventId,
        projectKey,
        agentId: "back-agent",
        kind: "test" as const,
        tier: "unit",
        codec: "junit",
        timestamp: now,
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
        tree: [{ name: "SuiteOnly", status: "pass" as const, children: [{ name: "t1", status: "pass" as const, duration_ms: 5 }] }],
      },
    };
  }

  test("from home: '← timeline' closes the overlay and restores the home route (home stays home)", async () => {
    const now = Date.now();
    const eventId = "evt-back-home-1";
    const projectKey = "proj-back-1";
    const fx = testFixture(eventId, projectKey, now);
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Back Home", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    expect(location.pathname).toBe(`/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    const back = findByText(overlay!, "button, a", "← timeline");
    expect(back).toBeDefined();
    back!.click();
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
    expect(document.querySelector('[data-testid="timeline"]')).not.toBeNull();
  });

  test("from the workspace: '← timeline' closes the overlay and restores the workspace route (workspace stays workspace, not home)", async () => {
    const now = Date.now();
    const eventId = "evt-back-ws-1";
    const projectKey = "proj-back-2";
    const fx = testFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        { key: projectKey, name: "Back Workspace", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();
    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    const back = findByText(overlay!, "button, a", "← timeline");
    expect(back).toBeDefined();
    back!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}`);
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });

  test("Escape closes the overlay with the exact same route restore as '← timeline'", async () => {
    const now = Date.now();
    const eventId = "evt-back-esc-1";
    const projectKey = "proj-back-3";
    const fx = testFixture(eventId, projectKey, now);
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Back Escape", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
  });
});

describe("§S3 — cold load of /p/<key>/run/<id>", () => {
  test("a fresh mount at /p/<key>/run/<id> renders the same drill-in over the workspace", async () => {
    const now = Date.now();
    const eventId = "evt-cold-1";
    const projectKey = "proj-cold-1";
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [
        { key: projectKey, name: "Cold Load", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "cold-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          duration_ms: 5,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "cold-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 5 },
          tree: [
            {
              name: "ColdSuite",
              status: "fail",
              children: [
                {
                  name: "coldFail",
                  status: "fail",
                  duration_ms: 5,
                  failure: { message: "cold load failure", trace: "at coldFail" },
                },
              ],
            },
          ],
        },
      },
    });

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelectorAll('[data-testid="suite-row"]').length).toBe(1);
    expect((overlay!.textContent ?? "")).toContain("ColdSuite");
  });
});

// ── §S4 item 0 — tier-default mode ─────────────────────────────────────────

function tierFixture(eventId: string, tier: string, now: number, total = 4) {
  return {
    brief: {
      id: eventId,
      projectKey: "proj-mode",
      agentId: "mode-agent",
      kind: "test" as const,
      tier,
      codec: "junit",
      timestamp: now,
      total,
      passed: total - 1,
      failed: 1,
      pending: 0,
      duration_ms: 500,
      hasCoverage: false,
    },
    detail: {
      id: eventId,
      projectKey: "proj-mode",
      agentId: "mode-agent",
      kind: "test" as const,
      tier,
      codec: "junit",
      timestamp: now,
      summary: { total, passed: total - 1, failed: 1, pending: 0, duration_ms: 500 },
      tree: [
        { name: "SuiteX", status: "fail" as const, children: [{ name: "leafFail", status: "fail" as const, duration_ms: 5, failure: { message: "fail" } }] },
        { name: "SuiteY", status: "pass" as const, children: [{ name: "leafPass", status: "pass" as const, duration_ms: 5 }] },
        { name: "SuiteZ", status: "pass" as const, children: [{ name: "leafPass2", status: "pass" as const, duration_ms: 5 }] },
      ],
    },
  };
}

async function mountAtRunCold(eventId: string, tier: string, now: number, total = 4, localStorageSeed?: Record<string, string>) {
  const fx = tierFixture(eventId, tier, now, total);
  await mountApp({
    pathname: `/run/${eventId}`,
    projects: [],
    events: [fx.brief],
    eventDetails: { [eventId]: fx.detail },
    localStorageSeed,
  });
}

describe("§S4.0 — tier-default mode selection", () => {
  test("a regression-tier run defaults the mode switch to Density", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-regression-1", "regression", now);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]');
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Density");
  });

  test("an e2e-tier run defaults the mode switch to Density", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-e2e-1", "e2e", now);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]');
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Density");
  });

  test("a unit-tier run defaults the mode switch to Detail", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-unit-1", "unit", now);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]');
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Detail");
  });

  test("module- and integration-tier runs default the mode switch to Detail", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-module-1", "module", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");

    await mountAtRunCold("evt-mode-integration-1", "integration", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");
  });

  test("a 200-test unit-tier run STILL defaults to Detail — no code path selects the mode from test count", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-unit-200", "unit", now, 200);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]');
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Detail");
  });
});

describe("§S4.0 — manual override persistence (per-tier-group localStorage)", () => {
  test("flipping the mode switch on a regression-tier run writes ONLY the broad persistence key, not the focused one", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-persist-1", "regression", now);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]') as HTMLElement | null;
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Density");

    modeSwitch!.click();
    await settle();
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");

    const broadKey = AppLogic.drillinModeStorageKey("regression");
    const focusedKey = AppLogic.drillinModeStorageKey("unit");
    expect(window.localStorage.getItem(broadKey)).toBe("Detail");
    expect(window.localStorage.getItem(focusedKey)).toBeNull();
  });

  test("a remembered broad-group override is honored as the default for the NEXT regression open AND the next e2e open", async () => {
    const now = Date.now();
    const broadKey = AppLogic.drillinModeStorageKey("regression");

    await mountAtRunCold("evt-mode-persist-2a", "regression", now, 4, { [broadKey]: "Detail" });
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");

    await mountAtRunCold("evt-mode-persist-2b", "e2e", now, 4, { [broadKey]: "Detail" });
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");
  });

  test("a broad-group override does NOT leak into the focused (unit/module/integration) tier-group default", async () => {
    const now = Date.now();
    const broadKey = AppLogic.drillinModeStorageKey("regression");
    const focusedKey = AppLogic.drillinModeStorageKey("unit");

    await mountAtRunCold("evt-mode-persist-3", "unit", now, 4, { [broadKey]: "Detail" });
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");
    expect(window.localStorage.getItem(focusedKey)).toBeNull();
  });

  test("the focused group persists its own override independently (unit override remembered on a later module open)", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-persist-4a", "unit", now);
    const modeSwitch = document.querySelector('[data-testid="drillin-mode"]') as HTMLElement | null;
    expect(modeSwitch!.getAttribute("data-mode")).toBe("Detail");
    modeSwitch!.click();
    await settle();
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Density");

    const focusedKey = AppLogic.drillinModeStorageKey("unit");
    expect(window.localStorage.getItem(focusedKey)).toBe("Density");

    await mountAtRunCold("evt-mode-persist-4b", "module", now, 4, { [focusedKey]: "Density" });
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Density");
  });
});

describe("§S4.0 — mode is presentation-only this cycle", () => {
  test("in Detail mode the plain suite tree renders regardless of run size, and no Density-only heat-strip renders", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-presentation-1", "unit", now, 200);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelectorAll('[data-testid="suite-row"]').length).toBe(3);
    // bound: Density-mode-only affordance (lands in C4) must not render here.
    expect(overlay!.querySelector('[data-testid="heat-strip"]')).toBeNull();
    expect(document.querySelector('[data-testid="drillin-mode"]')!.getAttribute("data-mode")).toBe("Detail");
  });
});

// ── §S4 item 5 — progressive payload (consume-only) ─────────────────────────

describe("§S4.5 — progressive payload (suites-first paging)", () => {
  test("opening the drill-in fetches ?depth=suites FIRST; the initial DOM has suite rows but no leaf rows", async () => {
    const now = Date.now();
    const eventId = "evt-progressive-1";
    const projectKey = "proj-progressive-1";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Progressive", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "progressive-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 2,
          failed: 1,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "progressive-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 },
          tree: [
            {
              name: "ProgSuiteA",
              status: "fail",
              children: [
                { name: "pFail", status: "fail", duration_ms: 5, failure: { message: "boom" } },
                { name: "pPass", status: "pass", duration_ms: 5 },
              ],
            },
            {
              name: "ProgSuiteB",
              status: "pass",
              children: [{ name: "pPass2", status: "pass", duration_ms: 5 }],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    const eventFetches = fetchLog.filter((u) => u.includes(`/api/v2/events/${eventId}`));
    expect(eventFetches.length).toBeGreaterThan(0);
    expect(eventFetches[0]).toContain("depth=suites");

    expect(overlay!.querySelectorAll('[data-testid="suite-row"]').length).toBe(2);
    expect(overlay!.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
  });

  test("expanding a suite fetches ?suite=<name> and renders ONLY that suite's leaves", async () => {
    const now = Date.now();
    const eventId = "evt-progressive-2";
    const projectKey = "proj-progressive-2";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Progressive 2", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "progressive-agent-2",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 2,
          failed: 1,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "progressive-agent-2",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 },
          tree: [
            {
              name: "ProgSuiteC",
              status: "fail",
              children: [
                { name: "cFail", status: "fail", duration_ms: 5, failure: { message: "boom c" } },
                { name: "cPass", status: "pass", duration_ms: 5 },
              ],
            },
            {
              name: "ProgSuiteD",
              status: "pass",
              children: [{ name: "dPass", status: "pass", duration_ms: 5 }],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    const suiteCRow = findByText(overlay!, '[data-testid="suite-row"]', "ProgSuiteC");
    expect(suiteCRow).toBeDefined();
    suiteCRow!.click();
    await settle();

    const suiteFetch = fetchLog.find(
      (u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=ProgSuiteC"),
    );
    expect(suiteFetch).toBeDefined();

    const leafRows = overlay!.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(2);
    const leafTexts = Array.from(leafRows).map((l) => l.textContent ?? "");
    expect(leafTexts.some((t) => t.includes("cFail"))).toBe(true);
    expect(leafTexts.some((t) => t.includes("cPass"))).toBe(true);
    // bound: ProgSuiteD was never expanded — none of its leaves fetched/rendered.
    expect(leafTexts.some((t) => t.includes("dPass"))).toBe(false);
    expect(fetchLog.some((u) => u.includes("suite=ProgSuiteD"))).toBe(false);
  });
});
