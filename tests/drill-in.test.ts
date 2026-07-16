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
//   - `[data-testid="drillin-mode"]` (BROAD tiers — regression/e2e — only)
//     exposes the current mode via a `data-mode` attribute
//     ("Detail" | "Density"), defaulted per `L.drillinDefaultMode(tier)` and
//     overridable by click; the override persists to
//     `L.drillinModeStorageKey(tier)` in localStorage.
//   - a "← timeline" control (matched by text, same convention as the
//     existing "← projects" workspace chip) closes the overlay exactly like
//     Escape — restoring the underlying surface's own route (home stays
//     home, workspace stays workspace).
//
// CR-CRU-007 C5b re-baseline (2026-07-15, user-corrected against the live
// render — see docs/changes/CR-CRU-007-timeline-drill-in.md §S3/§S4.0):
//   0. Density is REGRESSION-ONLY. Focused tiers (unit/module/integration)
//      are ALWAYS Detail and render NO `drillin-mode` element at all — the
//      §S4.0 describe blocks below were updated in place to this rule (were:
//      focused tiers rendered the switch defaulted to "Detail"; a focused
//      group also had its own persisted override — both dropped).
//   1. F4 anatomy — see the "F4 anatomy" describe block near the end of this
//      file for the full contract (tree-line rows, ▾/▸ affordance,
//      `${failed} ✗ ${passed} ✓` suite counts, BOTH-mode auto-expand of
//      failing suites, inline failure box with no click required, the
//      failures-footer + raw-output-for-test-events, and the F4½
//      status-chips row). RECONCILED (2026-07-15, approved): the ORIGINAL
//      "§S3 — test-run drill-in body" test above and the "§S4.5 progressive
//      payload" test's ProgSuiteC assertion were updated in place to the
//      both-modes auto-expand rule — a FAILING suite's `?suite=` fetch is
//      asserted straight from the fetch log (no suite-row click first);
//      PASSING suites (SuiteB / ProgSuiteD) still require an explicit
//      suite-row click, which both tests now exercise directly, keeping
//      §S4.5's on-demand paging covered.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  // §S3 failure-box degradation (user defect 2026-07-15) — `message` is now
  // OPTIONAL: a bare `<failure type="AssertionError"/>` (no message) or an
  // entirely empty `{}` (neither message nor type) are both legal fixtures.
  message?: string;
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
  /** F4 anatomy (§S3 re-baseline) — stored raw output for TEST events too
   * (previously compile-only via `compile.raw`); the failures-footer's
   * raw-output toggle reveals this. */
  raw?: string;
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

    // RECONCILED (F4 anatomy, both-modes auto-expand — approved 2026-07-15):
    // the FAILING suite (SuiteA) is fetched and its leaves rendered on OPEN,
    // no suite-row click needed — was: "no leaves yet ... suiteARow!.click()".
    const suiteRows = overlay!.querySelectorAll('[data-testid="suite-row"]');
    expect(suiteRows.length).toBe(2);

    const suiteAFetch = fetchLog.find(
      (u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteA"),
    );
    expect(suiteAFetch).toBeDefined();

    const leafRows = overlay!.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(2);

    const failLeaf = findByText(overlay!, '[data-testid="leaf-row"]', "testFail1");
    const passLeaf = findByText(overlay!, '[data-testid="leaf-row"]', "testPass1");
    expect(failLeaf).toBeDefined();
    expect(passLeaf).toBeDefined();

    // PASSING suites still require the click (§S4.5 on-demand paging stays
    // covered): SuiteB is NOT auto-fetched, and only renders its leaf after
    // an explicit suite-row click.
    expect(fetchLog.some((u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteB"))).toBe(
      false,
    );
    const suiteBRow = findByText(overlay!, '[data-testid="suite-row"]', "SuiteB");
    expect(suiteBRow).toBeDefined();
    suiteBRow!.click();
    await settle();

    const suiteBFetch = fetchLog.find(
      (u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteB"),
    );
    expect(suiteBFetch).toBeDefined();
    const testPass2Row = findByText(overlay!, '[data-testid="leaf-row"]', "testPass2");
    expect(testPass2Row).toBeDefined();

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

// ── Compile drill-in status line (user defect 2026-07-15) — a clean tsc
// drill-in rendered a fully EMPTY pane; a status line must ALWAYS render
// first: `<format> · N errors · M warnings`, pass-green when errorCount is
// 0, fail-red otherwise, then diagnostics (or the empty-state line when
// none); the raw-output toggle renders ONLY when a non-empty `raw` is
// stored. ───────────────────────────────────────────────────────────────
describe("Compile drill-in status line (user defect 2026-07-15)", () => {
  test("a clean compile (0 errors, 0 warnings, no diagnostics) renders a pass-green compile-status line + the empty-state line; no raw-output toggle when raw is empty", async () => {
    const now = Date.now();
    const eventId = "evt-compile-status-clean";
    const projectKey = "proj-compile-status-1";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Compile Status Clean",
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
          agentId: "compile-status-clean-agent",
          kind: "compile",
          tier: "unit",
          codec: "tsc",
          timestamp: now,
          hasCoverage: false,
          errors: 0,
          warnings: 0,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "compile-status-clean-agent",
          kind: "compile",
          tier: "unit",
          codec: "tsc",
          timestamp: now,
          compile: {
            format: "tsc",
            errorCount: 0,
            warningCount: 0,
            diagnostics: [],
            raw: "",
          },
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay).not.toBeNull();

    const status = overlay.querySelector('[data-testid="compile-status"]');
    expect(status).not.toBeNull();
    expect((status!.textContent ?? "").trim()).toBe("tsc · 0 errors · 0 warnings");
    expect(status!.className).toContain("app-ratio-pass");
    expect(status!.className).not.toContain("app-ratio-fail");
    expect(status!.className).not.toContain("app-ratio-error");

    const overlayText = overlay.textContent ?? "";
    expect(overlayText).toContain("clean compile — no diagnostics");
    // The status line precedes the empty-state text in document order.
    expect(overlayText.indexOf("tsc · 0 errors · 0 warnings")).toBeLessThan(
      overlayText.indexOf("clean compile — no diagnostics"),
    );

    expect(overlay.querySelector('[data-testid="diag-group"]')).toBeNull();
    expect(overlay.querySelector('[data-testid="raw-toggle"]')).toBeNull();
  });

  test("2 error diagnostics render a fail-red compile-status line + the diagnostics list; the raw-output toggle is present and reveals the stored raw output", async () => {
    const now = Date.now();
    const eventId = "evt-compile-status-errors";
    const projectKey = "proj-compile-status-2";
    const rawOutput = "tsc raw output — 2 errors fixture";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Compile Status Errors",
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
          agentId: "compile-status-errors-agent",
          kind: "compile",
          tier: "unit",
          codec: "tsc",
          timestamp: now,
          hasCoverage: false,
          errors: 2,
          warnings: 0,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "compile-status-errors-agent",
          kind: "compile",
          tier: "unit",
          codec: "tsc",
          timestamp: now,
          compile: {
            format: "tsc",
            errorCount: 2,
            warningCount: 0,
            diagnostics: [
              { file: "src/a.ts", line: 3, col: 1, message: "type mismatch", level: "error" },
              { file: "src/b.ts", line: 9, col: 4, message: "missing property", level: "error" },
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
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay).not.toBeNull();

    const status = overlay.querySelector('[data-testid="compile-status"]');
    expect(status).not.toBeNull();
    expect((status!.textContent ?? "").trim()).toBe("tsc · 2 errors · 0 warnings");
    expect(status!.className).toContain("app-ratio-fail");
    expect(status!.className).not.toContain("app-ratio-pass");
    expect(status!.className).not.toContain("app-ratio-error");

    const groups = overlay.querySelectorAll('[data-testid="diag-group"]');
    expect(groups.length).toBe(2);
    expect(overlay.textContent ?? "").not.toContain("clean compile — no diagnostics");

    const rawToggle = overlay.querySelector('[data-testid="raw-toggle"]') as HTMLElement | null;
    expect(rawToggle).not.toBeNull();
    expect(overlay.querySelector('[data-testid="raw-output"]')).toBeNull();
    rawToggle!.click();
    await settle();
    const rawOutputEl = overlay.querySelector('[data-testid="raw-output"]');
    expect(rawOutputEl).not.toBeNull();
    expect((rawOutputEl!.textContent ?? "")).toContain(rawOutput);
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

  // RE-TARGETED (CR-CRU-016 §S1 tabs-hide + tab-in-header, CR's
  // approved-modification list): the workspace back chip's text is now
  // tab-keyed (`← runs` on the default Runs tab) instead of the retired
  // constant `← timeline` — was `findByText(overlay!, "button, a", "← timeline")`.
  // Home's chip stays `← timeline` (see the test above, unaffected).
  test("from the workspace: '← runs' closes the overlay and restores the workspace route (workspace stays workspace, not home)", async () => {
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

    const back = findByText(overlay!, "button, a", "← runs");
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

  // CR-CRU-007 VERIFY-findings fix (2026-07-15) — FINDING 2: §S3 states
  // "failing suites auto-expand in BOTH modes" with NO cold-load carve-out,
  // but public/app.js:802-847 gates the Detail-mode auto-expand behind
  // `openedInApp` (captured from `overlayViaNavigate`, which is only true
  // for an in-app card/marker click) — `presentationOf(ev) === "Density" ||
  // openedInApp`. A cold mount at `/p/<key>/run/<id>` never sets
  // `overlayViaNavigate`, so a Detail-mode (unit/module/integration) cold
  // deep-link into a FAILING run renders collapsed, contradicting the spec.
  // The test above only asserted suite-row COUNT + suite name text (true
  // even with the failing suite collapsed) and stayed green through this
  // bug — these two tests pin the real rendered outcome: the failing
  // suite's leaves + inline failure box must appear on cold mount with NO
  // click, in Detail presentation, exactly as a warm (in-app) open does.
  test("cold-mounting /p/<key>/run/<id> for a unit-tier (Detail) run with a FAILING suite auto-expands it: fetches ?suite=<failing> with no click and renders the failed leaf's failure-box inline", async () => {
    const now = Date.now();
    const eventId = "evt-cold-autoexpand-fail";
    const projectKey = "proj-cold-autoexpand";
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [
        { key: projectKey, name: "Cold Autoexpand", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "cold-autoexpand-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 2,
          failed: 1,
          pending: 0,
          duration_ms: 12,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "cold-autoexpand-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 12 },
          tree: [
            {
              name: "ColdFailSuite",
              status: "fail",
              children: [
                { name: "coldOkLeaf", status: "pass", duration_ms: 4 },
                {
                  name: "coldBadLeaf",
                  status: "fail",
                  duration_ms: 5,
                  failure: { message: "cold deep-link failure", trace: "at coldBadLeaf\nat file.ts:9:1" },
                },
              ],
            },
            {
              name: "ColdPassSuite",
              status: "pass",
              children: [{ name: "coldOkLeaf2", status: "pass", duration_ms: 3 }],
            },
          ],
        },
      },
    });

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    // The FAILING suite's leaves fetch fired with NO click on the suite-row.
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent("ColdFailSuite")}`))).toBe(true);
    const badLeafRow = findByText(overlay!, '[data-testid="leaf-row"]', "coldBadLeaf");
    expect(badLeafRow).toBeDefined();
    const okLeafRow = findByText(overlay!, '[data-testid="leaf-row"]', "coldOkLeaf");
    expect(okLeafRow).toBeDefined();

    // The inline failure box renders with no click on the failed leaf-row.
    const failureBox = overlay!.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect((failureBox!.textContent ?? "")).toContain("cold deep-link failure");
    expect((failureBox!.textContent ?? "")).toContain("at file.ts:9:1");

    // Bound: the PASSING suite stays collapsed on cold load too (folded
    // rule is unaffected by this fix) — never fetched, no leaf-row.
    expect(fetchLog.some((u) => u.includes(`suite=${encodeURIComponent("ColdPassSuite")}`))).toBe(false);
    expect(findByText(overlay!, '[data-testid="leaf-row"]', "coldOkLeaf2")).toBeUndefined();
  });

  test("cold-mounting /p/<key>/run/<id> for an ALL-PASS unit-tier run fetches nothing beyond ?depth=suites (no ?suite= fetch, no leaf-row) — protects §S4.5 progressive paging", async () => {
    const now = Date.now();
    const eventId = "evt-cold-allpass";
    const projectKey = "proj-cold-allpass";
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [
        { key: projectKey, name: "Cold All Pass", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "cold-allpass-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          duration_ms: 8,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "cold-allpass-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 8 },
          tree: [
            {
              name: "AllPassSuite",
              status: "pass",
              children: [
                { name: "passLeaf1", status: "pass", duration_ms: 3 },
                { name: "passLeaf2", status: "pass", duration_ms: 5 },
              ],
            },
          ],
        },
      },
    });

    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();

    expect(fetchLog.some((u) => u.includes("depth=suites"))).toBe(true);
    expect(fetchLog.some((u) => /[?&]suite=/.test(u))).toBe(false);
    expect(overlay!.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
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

// CR-CRU-007 C5b — FINAL re-baseline (supersedes the earlier "Density is
// regression-only WITH a switch" pass): the mode badge/switch is REMOVED
// ENTIRELY. There is no `drillin-mode` element anywhere, no toggle, no
// persistence key. Presentation is purely tier-contextual: regression/e2e
// render Density (chips row + heat-strip + folds); unit/module/integration
// render the Detail tree; compile renders diagnostics. Every test below was
// rewritten from the earlier switch-based contract to this one — see the RED
// agent's dispatch report for the full list of superseded assertions.
describe("§S4.0 — purely tier-contextual presentation (no mode switch)", () => {
  test("a regression-tier run renders Density presentation (heat-strip) with NO drillin-mode element", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-regression-1", "regression", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelector('[data-testid="heat-strip"]')).not.toBeNull();
  });

  test("an e2e-tier run renders Density presentation (heat-strip) with NO drillin-mode element", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-e2e-1", "e2e", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelector('[data-testid="heat-strip"]')).not.toBeNull();
  });

  test("a unit-tier run renders the Detail tree (no heat-strip) with NO drillin-mode element", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-unit-1", "unit", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelectorAll('[data-testid="suite-row"]').length).toBe(3);
    expect(overlay.querySelector('[data-testid="heat-strip"]')).toBeNull();
  });

  test("module- and integration-tier runs render the Detail tree with NO drillin-mode element", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-module-1", "module", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="run-overlay"]')!.querySelector('[data-testid="heat-strip"]'),
    ).toBeNull();

    await mountAtRunCold("evt-mode-integration-1", "integration", now);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="run-overlay"]')!.querySelector('[data-testid="heat-strip"]'),
    ).toBeNull();
  });

  test("a 200-test unit-tier run STILL renders Detail (no heat-strip, no drillin-mode) — no code path selects presentation from test count", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-unit-200", "unit", now, 200);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelectorAll('[data-testid="suite-row"]').length).toBe(3);
    expect(overlay.querySelector('[data-testid="heat-strip"]')).toBeNull();
  });

  test("a 200-test regression-tier run STILL renders Density (heat-strip present) — no code path selects presentation from test count", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-regression-200", "regression", now, 200);
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelector('[data-testid="heat-strip"]')).not.toBeNull();
  });

  test("no drillin-mode persistence key is ever written to localStorage — unit tier", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-nopersist-unit", "unit", now);
    expect(window.localStorage.length).toBe(0);
  });

  test("no drillin-mode persistence key is ever written to localStorage — regression tier", async () => {
    const now = Date.now();
    await mountAtRunCold("evt-mode-nopersist-regression", "regression", now);
    expect(window.localStorage.length).toBe(0);
  });

  test("a compile drill-in renders the diagnostics body with NO drillin-mode element", async () => {
    const now = Date.now();
    const eventId = "evt-mode-compile-1";
    await mountApp({
      pathname: `/run/${eventId}`,
      projects: [],
      events: [
        {
          id: eventId,
          projectKey: "proj-mode",
          agentId: "compile-mode-agent",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          hasCoverage: false,
          errors: 1,
          warnings: 0,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey: "proj-mode",
          agentId: "compile-mode-agent",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          compile: {
            format: "rustc",
            errorCount: 1,
            warningCount: 0,
            diagnostics: [{ file: "src/lib.rs", line: 1, col: 1, message: "boom", level: "error" }],
            raw: "error: boom\n --> src/lib.rs:1:1",
          },
        },
      },
    });
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    expect(document.querySelector('[data-testid="diag-group"]')).not.toBeNull();
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
          passed: 3,
          failed: 0,
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
          // RECONCILED (approved 2026-07-15): ALL-PASS fixture — under the
          // both-modes auto-expand rule a FAILING suite's leaves render on
          // open, which would make this test's "no leaf rows initially"
          // assertion unsatisfiable. All-pass preserves the test's true
          // intent (suites-first paging: nothing auto-expands, so no leaves
          // render until a suite-row click) — was: ProgSuiteA status "fail"
          // with a failing leaf.
          summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 100 },
          tree: [
            {
              name: "ProgSuiteA",
              status: "pass",
              children: [
                { name: "p1", status: "pass", duration_ms: 5 },
                { name: "p2", status: "pass", duration_ms: 5 },
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

    // RECONCILED (F4 anatomy, both-modes auto-expand — approved 2026-07-15):
    // ProgSuiteC (failing) is fetched and expanded ON OPEN, no suite-row
    // click needed — was: "suiteCRow!.click()" before asserting the fetch.
    const suiteCFetch = fetchLog.find(
      (u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=ProgSuiteC"),
    );
    expect(suiteCFetch).toBeDefined();

    const leafRows = overlay!.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(2);
    const leafTexts = Array.from(leafRows).map((l) => l.textContent ?? "");
    expect(leafTexts.some((t) => t.includes("cFail"))).toBe(true);
    expect(leafTexts.some((t) => t.includes("cPass"))).toBe(true);
    // bound: ProgSuiteD (passing) was never AUTO-expanded — none of its
    // leaves fetched/rendered until clicked.
    expect(leafTexts.some((t) => t.includes("dPass"))).toBe(false);
    expect(fetchLog.some((u) => u.includes("suite=ProgSuiteD"))).toBe(false);

    // PASSING suites still require the click (§S4.5 on-demand paging stays
    // covered): clicking ProgSuiteD's suite-row DOES fetch + render it.
    const suiteDRow = findByText(overlay!, '[data-testid="suite-row"]', "ProgSuiteD");
    expect(suiteDRow).toBeDefined();
    suiteDRow!.click();
    await settle();

    const suiteDFetch = fetchLog.find(
      (u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=ProgSuiteD"),
    );
    expect(suiteDFetch).toBeDefined();
    const dPassRow = findByText(overlay!, '[data-testid="leaf-row"]', "dPass");
    expect(dPassRow).toBeDefined();
  });
});

// ── F4 anatomy (user-corrected against the live render, CR-CRU-007 §S3
// re-baseline 2026-07-15) ────────────────────────────────────────────────
//
// RED phase: expected to fail against the CURRENT public/app.js RunOverlay,
// which (a) renders suite-row/leaf-row WITHOUT an "app-tree-line" class or a
// ▾/▸ `[data-testid="tree-toggle"]` affordance, (b) formats suite counts
// "✓P ✗F" (pass-first, no spaces) instead of the spec's `${F} ✗ ${P} ✓`
// (fail-first, spaced), (c) only auto-expands a failing suite's leaves in
// Density mode (§S4.1's `autoExpandFailing` is gated on `mode.val ===
// "Density"`) rather than in BOTH Detail and Density, (d) only shows a
// failed leaf's `[data-testid="failure-box"]` after a click
// (`toggleFailure`/`openFailures`) rather than inline on open, and (e) has
// no `[data-testid="failures-footer"]` at all for test-kind events (raw
// output + a "toggle raw output"/jump affordance currently exist ONLY on
// the compile body). Contract this block defines for GREEN:
//   - `[data-testid="suite-row"]` / `[data-testid="leaf-row"]` both carry an
//     "app-tree-line" class (no bordered card-box class).
//   - each suite-row contains `[data-testid="tree-toggle"]` whose text is
//     "▾" while its leaves are loaded/expanded, "▸" while collapsed.
//   - suite-row text contains `${failedCount} ✗ ${passedCount} ✓`.
//   - a FAILING suite's leaves are fetched/rendered on OPEN with no suite-row
//     click, in Detail mode too (not Density-only); an all-pass suite stays
//     collapsed (no fetch) until clicked.
//   - a failed leaf's `[data-testid="failure-box"]` (message + trace, trace's
//     LAST line matching `at …`) renders inline beneath it with NO leaf-row
//     click required.
//   - `[data-testid="failures-footer"]` (test-kind events, when ≥1 failure
//     exists) renders text matching `▸ N more failures · toggle raw output`
//     (N = total failing leaves - 1); its `[data-testid="failure-jump"]`
//     control calls `scrollIntoView()` on the NEXT failing leaf-row when
//     clicked; its `[data-testid="raw-toggle"]` toggles
//     `[data-testid="raw-output"]` containing the event detail's stored
//     `raw` field (test events get a `raw` field too now, not just compile).
describe("F4 anatomy — tree lines, ▾/▸ affordance, fail-first counts", () => {
  test("suite/leaf rows are tree-line elements with a ▾/▸ affordance and fail-first `F ✗ P ✓` counts; a failing suite auto-expands on open in Detail mode with no click", async () => {
    const now = Date.now();
    const eventId = "evt-anatomy-1";
    const projectKey = "proj-anatomy-1";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Anatomy", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "anatomy-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 4,
          passed: 2,
          failed: 2,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "anatomy-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 4, passed: 2, failed: 2, pending: 0, duration_ms: 100 },
          tree: [
            {
              name: "SuiteFail",
              status: "fail",
              children: [
                { name: "okLeaf", status: "pass", duration_ms: 5 },
                {
                  name: "badLeaf",
                  status: "fail",
                  duration_ms: 5,
                  failure: { message: "boom detail", trace: "some frame\nat file.ts:12:3" },
                },
                // Failure fidelity (user note): a legacy/partial ingest can
                // land a failed leaf with NO failure object (e.g. the client
                // discarded <failure> content) — graceful degradation only,
                // no failure box, no "undefined" text.
                { name: "silentFail", status: "fail", duration_ms: 5 },
              ],
            },
            {
              name: "SuitePass",
              status: "pass",
              children: [{ name: "okLeaf2", status: "pass", duration_ms: 5 }],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay).not.toBeNull();

    // Tree-line class on both suite-row and leaf-row — not a bordered card box.
    const suiteFailRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteFail")!;
    expect(suiteFailRow).toBeDefined();
    expect(suiteFailRow.className).toMatch(/\bapp-tree-line\b/);

    const suitePassRow = findByText(overlay, '[data-testid="suite-row"]', "SuitePass")!;
    expect(suitePassRow).toBeDefined();
    expect(suitePassRow.className).toMatch(/\bapp-tree-line\b/);

    // ▾/▸ affordance: SuiteFail auto-expanded (▾), SuitePass collapsed (▸).
    const failToggle = suiteFailRow.querySelector('[data-testid="tree-toggle"]');
    expect(failToggle).not.toBeNull();
    expect((failToggle!.textContent ?? "").trim()).toBe("▾");
    const passToggle = suitePassRow.querySelector('[data-testid="tree-toggle"]');
    expect(passToggle).not.toBeNull();
    expect((passToggle!.textContent ?? "").trim()).toBe("▸");

    // Fail-first, spaced counts: "2 ✗ 1 ✓" (badLeaf + silentFail / okLeaf) /
    // "0 ✗ 1 ✓" for the all-pass suite.
    expect(suiteFailRow.textContent ?? "").toContain("2 ✗ 1 ✓");
    expect(suitePassRow.textContent ?? "").toContain("0 ✗ 1 ✓");

    // COLORED per status (user note vs the F4 mock): the ✗ / ✓ count
    // segments are separate spans carrying status-color classes, not plain
    // uncolored text glued together.
    const failCountSpan = suiteFailRow.querySelector('[data-testid="suite-count-fail"]');
    expect(failCountSpan).not.toBeNull();
    expect((failCountSpan!.textContent ?? "").trim()).toBe("2 ✗");
    expect(failCountSpan!.className).toMatch(/\bapp-count-fail\b/);

    const passCountSpan = suiteFailRow.querySelector('[data-testid="suite-count-pass"]');
    expect(passCountSpan).not.toBeNull();
    expect((passCountSpan!.textContent ?? "").trim()).toBe("1 ✓");
    expect(passCountSpan!.className).toMatch(/\bapp-count-pass\b/);

    const suitePassFailCountSpan = suitePassRow.querySelector('[data-testid="suite-count-fail"]');
    expect(suitePassFailCountSpan).not.toBeNull();
    expect(suitePassFailCountSpan!.className).toMatch(/\bapp-count-fail\b/);
    const suitePassPassCountSpan = suitePassRow.querySelector('[data-testid="suite-count-pass"]');
    expect(suitePassPassCountSpan).not.toBeNull();
    expect(suitePassPassCountSpan!.className).toMatch(/\bapp-count-pass\b/);

    // Auto-expand in DETAIL mode (unit tier, no click on suite-row): badLeaf's
    // leaf-row is ALREADY rendered.
    const badLeafRow = findByText(overlay, '[data-testid="leaf-row"]', "badLeaf");
    expect(badLeafRow).toBeDefined();
    expect(badLeafRow!.className).toMatch(/\bapp-tree-line\b/);
    const okLeafRow = findByText(overlay, '[data-testid="leaf-row"]', "okLeaf");
    expect(okLeafRow).toBeDefined();
    expect(fetchLog.some((u) => u.includes("suite=SuiteFail"))).toBe(true);

    // Passing leaves render GREEN/bright (user note vs the F4 mock) — an
    // explicit "pass" color class, NOT the dim/faint ink the plain
    // `.app-leaf-row` base rule currently applies to every status.
    expect(okLeafRow!.className).toMatch(/\bapp-leaf-pass\b/);
    expect(okLeafRow!.className).not.toMatch(/\b(app-leaf-dim|app-dim|app-faint)\b/);

    // Bound: the all-pass suite stays collapsed — never fetched.
    expect(findByText(overlay, '[data-testid="leaf-row"]', "okLeaf2")).toBeUndefined();
    expect(fetchLog.some((u) => u.includes("suite=SuitePass"))).toBe(false);

    // Inline failure box — NO click on badLeafRow.
    const failureBox = overlay.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect((failureBox!.textContent ?? "")).toContain("boom detail");
    expect((failureBox!.textContent ?? "")).toContain("at file.ts:12:3");
    const traceLines = (failureBox!.textContent ?? "").trim().split("\n");
    expect(traceLines[traceLines.length - 1]).toMatch(/^at /);

    // RECONCILED (2026-07-15, user defect — failure-box degradation,
    // CR-CRU-007 §S3 AC): a failed leaf with NO failure object now renders a
    // DEGRADED failure box (`test failed` + the reporter note) instead of no
    // box at all — was: "produces NO failure box ... afterSilentFail must
    // NOT be a failure-box". The box's text is never empty and never says
    // "undefined".
    const silentFailRow = findByText(overlay, '[data-testid="leaf-row"]', "silentFail");
    expect(silentFailRow).toBeDefined();
    expect(silentFailRow!.className).toMatch(/\bapp-tree-line\b/);
    expect(silentFailRow!.textContent ?? "").toContain("✗");
    const afterSilentFail = silentFailRow!.nextElementSibling;
    expect(afterSilentFail?.getAttribute("data-testid")).toBe("failure-box");
    expect((afterSilentFail?.textContent ?? "")).toContain("test failed");
    expect((afterSilentFail?.textContent ?? "")).toContain("no failure detail captured by the reporter");
    expect(overlay.textContent ?? "").not.toContain("undefined");
  });
});

// CR-CRU-007 §S3 anatomy (final user correction, live screenshot): NO
// edge/outline highlight on any tree row — status is text color alone; the
// ONLY boxed element inside the tree is the failure box. happy-dom's
// mountApp harness never loads public/styles.css (VanJS DOM is asserted
// structurally, not via computed style — see this file's header), so this
// is a grep-style assertion over the REAL stylesheet source, same
// convention as the codec "registry-only resolution" grep tests
// (tests/codec-parsepath.test.ts) and tests/drill-in-mode.test.ts's new
// "no drillin-mode source references" tests.
describe("F4 anatomy — no border/outline highlight on tree rows (styles.css)", () => {
  const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

  /** Extracts a CSS rule's `{ ... }` body for an EXACT selector text (first match). */
  function ruleBody(selector: string): string | undefined {
    const idx = STYLES_SRC.indexOf(selector);
    if (idx === -1) return undefined;
    const braceStart = STYLES_SRC.indexOf("{", idx);
    const braceEnd = STYLES_SRC.indexOf("}", braceStart);
    if (braceStart === -1 || braceEnd === -1) return undefined;
    return STYLES_SRC.slice(braceStart + 1, braceEnd);
  }

  test(".app-suite-row carries no border/outline in its base rule", () => {
    const body = ruleBody(".app-suite-row {") ?? ruleBody(".app-suite-row{");
    expect(body).toBeDefined();
    expect(body ?? "").not.toMatch(/\bborder\b/);
    expect(body ?? "").not.toMatch(/\boutline\b/);
  });

  test(".app-suite-row.fail carries no red border/outline (the row-border removed by the live-screenshot correction)", () => {
    const body = ruleBody(".app-suite-row.fail {") ?? ruleBody(".app-suite-row.fail{");
    // Either the selector is gone entirely, or (if kept for some other
    // reason) its body must not set a border/outline.
    if (body !== undefined) {
      expect(body).not.toMatch(/\bborder\b/);
      expect(body).not.toMatch(/\boutline\b/);
    }
  });

  test(".app-leaf-row (base + status modifiers) never carries a border/outline", () => {
    for (const selector of [".app-leaf-row {", ".app-leaf-row{", ".app-leaf-row.fail {", ".app-leaf-row.fail{", ".app-leaf-row.pending {", ".app-leaf-row.pending{"]) {
      const body = ruleBody(selector);
      if (body === undefined) continue;
      expect(body).not.toMatch(/\bborder\b/);
      expect(body).not.toMatch(/\boutline\b/);
    }
  });

  test("bound: .app-failure-box remains the ONLY boxed element inside the tree — it still carries a border", () => {
    const body = ruleBody(".app-failure-box {") ?? ruleBody(".app-failure-box{");
    expect(body).toBeDefined();
    expect(body ?? "").toMatch(/\bborder\b/);
  });
});

// ── Failure-box degradation (user defect 2026-07-15) — the box NEVER
// renders empty. bun's JUnit reporter emits bare `<failure type="AssertionError"/>`
// (no message attribute, no text) — a failing leaf whose `failure` is
// exactly `{type:"AssertionError"}` must still render a non-empty box
// (type as the message line + a dim reporter note); a failing leaf with NO
// failure object at all, or one with neither message nor type, degrades
// further to "test failed" + the same note. No `.app-failure-trace` node
// renders when `trace` is absent. ────────────────────────────────────────
describe("Failure-box degradation (user defect 2026-07-15)", () => {
  test("failure={type only} renders type + reporter note; NO failure object (or {} with neither) renders 'test failed' + the same note; no .app-failure-trace when trace is absent", async () => {
    const now = Date.now();
    const eventId = "evt-degrade-1";
    const projectKey = "proj-degrade-1";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Degrade",
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
          agentId: "degrade-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 0,
          failed: 3,
          pending: 0,
          duration_ms: 30,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "degrade-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 0, failed: 3, pending: 0, duration_ms: 30 },
          tree: [
            {
              name: "DegradeSuite",
              status: "fail",
              children: [
                { name: "typeOnlyFail", status: "fail", duration_ms: 5, failure: { type: "AssertionError" } },
                { name: "noFailureObjFail", status: "fail", duration_ms: 5 },
                { name: "emptyFailureFail", status: "fail", duration_ms: 5, failure: {} },
              ],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay).not.toBeNull();

    // 1. failure = {type:"AssertionError"} (no message) — box text contains
    //    "AssertionError" AND the reporter note; never empty; no trace node
    //    (trace absent).
    const typeOnlyRow = findByText(overlay, '[data-testid="leaf-row"]', "typeOnlyFail");
    expect(typeOnlyRow).toBeDefined();
    const typeOnlyBox = typeOnlyRow!.nextElementSibling;
    expect(typeOnlyBox?.getAttribute("data-testid")).toBe("failure-box");
    const typeOnlyText = (typeOnlyBox?.textContent ?? "").trim();
    expect(typeOnlyText.length).toBeGreaterThan(0);
    expect(typeOnlyText).toContain("AssertionError");
    expect(typeOnlyText).toContain("no failure detail captured by the reporter");
    expect(typeOnlyBox!.querySelector(".app-failure-trace")).toBeNull();

    // 2. NO failure object at all — box renders "test failed" + the same
    //    note; never empty.
    const noFailureRow = findByText(overlay, '[data-testid="leaf-row"]', "noFailureObjFail");
    expect(noFailureRow).toBeDefined();
    const noFailureBox = noFailureRow!.nextElementSibling;
    expect(noFailureBox?.getAttribute("data-testid")).toBe("failure-box");
    const noFailureText = (noFailureBox?.textContent ?? "").trim();
    expect(noFailureText.length).toBeGreaterThan(0);
    expect(noFailureText).toContain("test failed");
    expect(noFailureText).toContain("no failure detail captured by the reporter");
    expect(noFailureBox!.querySelector(".app-failure-trace")).toBeNull();

    // 3. failure = {} (neither message nor type) — same "test failed" + note.
    const emptyFailureRow = findByText(overlay, '[data-testid="leaf-row"]', "emptyFailureFail");
    expect(emptyFailureRow).toBeDefined();
    const emptyFailureBox = emptyFailureRow!.nextElementSibling;
    expect(emptyFailureBox?.getAttribute("data-testid")).toBe("failure-box");
    const emptyFailureText = (emptyFailureBox?.textContent ?? "").trim();
    expect(emptyFailureText.length).toBeGreaterThan(0);
    expect(emptyFailureText).toContain("test failed");
    expect(emptyFailureText).toContain("no failure detail captured by the reporter");

    expect(overlay.textContent ?? "").not.toContain("undefined");
  });
});

describe("F4 anatomy — failures-footer (jump + raw-output, test events)", () => {
  test("renders '▸ N more failures · toggle raw output'; the jump calls scrollIntoView on the next failing leaf; the raw toggle reveals the event's stored raw output", async () => {
    const now = Date.now();
    const eventId = "evt-anatomy-footer-1";
    const projectKey = "proj-anatomy-footer-1";
    const rawOutput = "raw test runner output — anatomy footer fixture";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Footer", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "footer-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 3,
          passed: 0,
          failed: 3,
          pending: 0,
          duration_ms: 30,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "footer-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 3, passed: 0, failed: 3, pending: 0, duration_ms: 30 },
          raw: rawOutput,
          tree: [
            {
              name: "SuiteFooter",
              status: "fail",
              children: [
                { name: "f1", status: "fail", duration_ms: 10, failure: { message: "m1" } },
                { name: "f2", status: "fail", duration_ms: 10, failure: { message: "m2" } },
                { name: "f3", status: "fail", duration_ms: 10, failure: { message: "m3" } },
              ],
            },
          ],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;

    const footer = overlay.querySelector('[data-testid="failures-footer"]');
    expect(footer).not.toBeNull();
    expect((footer!.textContent ?? "")).toMatch(/▸ 2 more failures · toggle raw output/);

    // Jump: the SECOND failing leaf-row (f2) is the "next" failure — stub
    // scrollIntoView (happy-dom has no real layout) and assert it fires on
    // exactly that row.
    const f2Row = findByText(overlay, '[data-testid="leaf-row"]', "f2") as HTMLElement;
    expect(f2Row).toBeDefined();
    const scrollCalls: HTMLElement[] = [];
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      function (this: HTMLElement) {
        scrollCalls.push(this);
      };
    const jump = footer!.querySelector('[data-testid="failure-jump"]') as HTMLElement | null;
    expect(jump).not.toBeNull();
    jump!.click();
    await settle();
    expect(scrollCalls.length).toBe(1);
    expect(scrollCalls[0]).toBe(f2Row);

    // Raw toggle — test events too (not compile-only).
    expect(overlay.querySelector('[data-testid="raw-output"]')).toBeNull();
    const rawToggle = footer!.querySelector('[data-testid="raw-toggle"]') as HTMLElement | null;
    expect(rawToggle).not.toBeNull();
    rawToggle!.click();
    await settle();
    const rawOutputEl = overlay.querySelector('[data-testid="raw-output"]');
    expect(rawOutputEl).not.toBeNull();
    expect(rawOutputEl!.textContent ?? "").toContain(rawOutput);
  });
});

// ── F4½ header anatomy — status chips above the heat-strip (Density) ──────
describe("F4½ anatomy — status-chips row above the heat-strip (Density presentation)", () => {
  test("a regression-tier run renders '✗ failures N · ⏭ pending N · ✓ passed N' above the heat-strip", async () => {
    const now = Date.now();
    const eventId = "evt-anatomy-chips-1";
    const projectKey = "proj-anatomy-chips-1";
    const children = [];
    for (let i = 0; i < 5; i++) {
      if (i < 2) children.push({ name: `t${i}`, status: "fail" as const, duration_ms: 5, failure: { message: `boom${i}` } });
      else if (i === 2) children.push({ name: `t${i}`, status: "pending" as const, duration_ms: 5 });
      else children.push({ name: `t${i}`, status: "pass" as const, duration_ms: 5 });
    }
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Chips", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "chips-agent",
          kind: "test",
          tier: "regression",
          codec: "junit",
          timestamp: now,
          total: 5,
          passed: 2,
          failed: 2,
          pending: 1,
          duration_ms: 200,
          hasCoverage: false,
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "chips-agent",
          kind: "test",
          tier: "regression",
          codec: "junit",
          timestamp: now,
          summary: { total: 5, passed: 2, failed: 2, pending: 1, duration_ms: 200 },
          tree: [{ name: "SuiteChips", status: "fail", children }],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;

    const chips = overlay.querySelector('[data-testid="density-status-chips"]');
    expect(chips).not.toBeNull();
    expect((chips!.textContent ?? "")).toMatch(/✗ failures 2 · ⏭ pending 1 · ✓ passed 2/);

    const heatStrip = overlay.querySelector('[data-testid="heat-strip"]');
    expect(heatStrip).not.toBeNull();
    // Bound: the chips row precedes the heat-strip in document order.
    expect(chips!.compareDocumentPosition(heatStrip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);

    // COLORED per status, suite-row level too: this suite has a pending leaf
    // (1), so its inline counts include a separate amber-classed pending
    // segment alongside the fail/pass ones.
    const suiteChipsRow = overlay.querySelector('[data-testid="suite-row"]')!;
    const pendingCountSpan = suiteChipsRow.querySelector('[data-testid="suite-count-pending"]');
    expect(pendingCountSpan).not.toBeNull();
    expect((pendingCountSpan!.textContent ?? "").trim()).toBe("1 ⏭");
    expect(pendingCountSpan!.className).toMatch(/\bapp-count-pending\b/);
  });

  test("a unit-tier (Detail) run renders NO status-chips row", async () => {
    const now = Date.now();
    const eventId = "evt-anatomy-chips-2";
    const projectKey = "proj-anatomy-chips-2";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "ChipsDetail", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "chips-detail-agent",
          kind: "test",
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
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "chips-detail-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
          tree: [{ name: "SuiteChipsDetail", status: "pass", children: [{ name: "t0", status: "pass", duration_ms: 5 }] }],
        },
      },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    card!.click();
    await settle();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelector('[data-testid="density-status-chips"]')).toBeNull();
  });
});
