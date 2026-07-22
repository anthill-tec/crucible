// CR-CRU-007 §S4 items 1, 2, 3, 4, 6 (density set, release 0.1.0) —
// Density-mode drill-in behaviors. Drives the REAL production public/app.js
// shell inside a happy-dom window — same harness pattern as
// tests/drill-in.test.ts / tests/run-cards.test.ts: real VanJS/VanX vendor
// bundles, real public/app-logic.mjs, real public/app.js; `fetch` is
// scripted.
//
// RED phase: expected to fail against the CURRENT public/app.js RunOverlay
// (from C3), which renders the SAME plain suite tree in both Detail and
// Density mode and has none of: data-testid="heat-strip", "heat-cell",
// "digest-row", "digest-expander", "tree-scroll", "density-toggle", or a
// `data-leaf-key` attribute on leaf-row elements.
//
// Contract this file defines for GREEN (identifiers verbatim):
//   §S4 item 1 (failures float, green folds — Density mode only):
//     - a 0-failure run opens with every `[data-testid="suite-row"]`
//       collapsed (no `[data-testid="leaf-row"]` anywhere) showing
//       `name + ✓count` text.
//     - a run WITH failures auto-expands ONLY the failing suite(s) (their
//       leaves render without a click, and the suite is auto-fetched via
//       `?suite=<name>`); all-pass suites stay collapsed to their counted
//       row and are NEVER auto-fetched.
//     - Detail mode renders the plain tree — nothing auto-expands.
//
//   CR-CRU-038 §S1 UPDATE (2026-07-22, patch cycle): the "auto-expands ONLY
//   the failing suite(s)" behavior above is RETIRED for OPEN — a run with
//   ≥1 failure now opens MINIMIZED: every suite (failing or not) renders
//   its header + counts only, leaves collapsed, nothing auto-fetched. The
//   failure-jump control now does the on-demand load+expand+focus that
//   auto-expand used to do eagerly on open. Tests below that pinned the old
//   auto-expand-on-open behavior are retargeted in place (see inline
//   "CR-CRU-038 §S1" notes at each site); a 0-failure run's default is
//   UNCHANGED.
//   §S4 item 2 (heat-strip minimap — Density mode only):
//     - `[data-testid="heat-strip"]` renders one `[data-testid="heat-cell"]`
//       per leaf in the run, any run size (no count threshold). A failing
//       leaf's cell class contains "app-heat-fail", a pending leaf's cell
//       class contains "app-heat-pending", a passing leaf's cell class
//       contains "app-heat-pass".
//     - clicking the first fail-classed cell expands that leaf's
//       `[data-testid="failure-box"]` (its `failure.message` text becomes
//       visible).
//     - Detail mode renders NO heat-strip for the same fixture.
//   §S4 item 3 (failure digest — Density mode only):
//     - leaves within one suite sharing an identical `failure.message`
//       collapse into one `[data-testid="digest-row"]` containing the
//       shared message and a `[data-testid="digest-expander"]` labeled
//       `+N identical` (N = group size - 1); clicking the expander reveals
//       the individual `[data-testid="leaf-row"]`s for the grouped leaves.
//     - leaves with DIFFERENT failure messages never group (render as
//       plain leaf-rows).
//     - Detail mode never digests — identical-message leaves all render as
//       individual leaf-rows even after a manual suite expand.
//   §S4 item 4 (virtualized tree — ALWAYS ON, both modes):
//     - a 10 000-leaf synthetic run keeps mounted tree-row DOM nodes
//       (`suite-row` + `leaf-row` combined) under 200 after expanding the
//       largest suite, in BOTH Detail and Density mode.
//     - the initial drill-in fetch is `?depth=suites` and contains no leaf
//       entries, holding at 10k scale (already true from C3's suites-first
//       paging).
//     - CR-CRU-034 §S1 RE-SOURCE: a virtualized suite's leaf list's scroll
//       source is the bounded run-detail scroller `[data-testid=
//       "pane-scroll"]` (NOT the retired per-suite `[data-testid=
//       "tree-scroll"]` 60vh inner box); each mounted `[data-testid=
//       "leaf-row"]` carries a `data-leaf-key` identity attribute
//       (`"<suiteName>::<leafName>"`); scrolling `pane-scroll` changes WHICH
//       leaf-row identities are mounted while the mounted count stays under
//       200.
//   §S4 item 6 (density toggle — independent of Detail/Density):
//     - `[data-testid="density-toggle"]` exposes its current mode via a
//       `data-density` attribute, cycling "comfortable" -> "compact" ->
//       "ultra" -> "comfortable" on click, and applies a matching root
//       class (`app-density-<mode>`) to `document.documentElement`.
//     - the choice persists to `localStorage` under the key
//       `"crucible.density.mode"` and is honored as the default on the
//       next cold mount.
//     - the density toggle behaves identically regardless of which tier
//       drives the drill-in's presentation (Density for regression/e2e,
//       Detail for unit/module/integration) — CR-CRU-007 C5b FINAL
//       re-baseline: the mode badge/switch is REMOVED ENTIRELY, so there is
//       no `[data-testid="drillin-mode"]` element anywhere to interact with
//       (was: "flipping the density toggle never changes drillin-mode's
//       data-mode, and vice versa" — every affected assertion below was
//       rewritten; see the RED agent's dispatch report for the list).
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

/** Same mountApp harness pattern as tests/drill-in.test.ts. */
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
        throw new Error(`density.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
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
      throw new Error(`density.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?density=${cacheBust}`);

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

function mountedTreeRowCount(overlay: Element): number {
  return overlay.querySelectorAll('[data-testid="suite-row"], [data-testid="leaf-row"]').length;
}

async function mountAtRunCold(
  eventId: string,
  tier: string,
  detail: EventDetailFixture,
  brief: EventBriefFixture,
  localStorageSeed?: Record<string, string>,
): Promise<void> {
  await mountApp({
    pathname: `/run/${eventId}`,
    projects: [],
    events: [brief],
    eventDetails: { [eventId]: detail },
    localStorageSeed,
  });
}

// ── §S4 item 1 — failures float, green folds ───────────────────────────────

describe("§S4.1 — failures float, green folds (Density mode)", () => {
  test("a run with 0 failures opens with every suite collapsed to 'name + ✓count' rows", async () => {
    const now = Date.now();
    const eventId = "evt-fold-zero-fail";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-fold",
      agentId: "fold-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 800 },
      tree: [
        { name: "SuiteP1", status: "pass", children: [{ name: "p1", status: "pass", duration_ms: 5 }, { name: "p2", status: "pass", duration_ms: 5 }, { name: "p3", status: "pass", duration_ms: 5 }] },
        { name: "SuiteP2", status: "pass", children: [{ name: "p4", status: "pass", duration_ms: 5 }, { name: "p5", status: "pass", duration_ms: 5 }] },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-fold", agentId: "fold-agent", kind: "test", tier: "regression", codec: "junit", timestamp: now, total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 800, hasCoverage: false };
    await mountAtRunCold(eventId, "regression", detail, brief);

    // CR-CRU-007 C5b FINAL re-baseline (§S4.0 — no drillin-mode element
    // anywhere; regression tier renders Density presentation by itself).
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelectorAll('[data-testid="suite-row"]').length).toBe(2);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);

    const suiteP1 = findByText(overlay, '[data-testid="suite-row"]', "SuiteP1");
    expect(suiteP1).toBeDefined();
    expect(suiteP1!.textContent ?? "").toContain("✓3");
    const suiteP2 = findByText(overlay, '[data-testid="suite-row"]', "SuiteP2");
    expect(suiteP2).toBeDefined();
    expect(suiteP2!.textContent ?? "").toContain("✓2");

    // bound: nothing was auto-fetched since every suite folded.
    expect(fetchLog.some((u) => u.includes("suite="))).toBe(false);

    // CR-CRU-038 §S1 AC — "an all-pass run's tree default is unchanged":
    // this 0-failure run's collapsed (▸) default predates and is UNAFFECTED
    // by the §S1 minimized-error-tree change (there is nothing to minimize
    // further — it was always collapsed).
    expect(suiteP1!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    expect(suiteP2!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
  });

  // CR-CRU-038 §S1 RETARGET (2026-07-22): was "a run with failures opens
  // with ONLY failing suites auto-expanded" — auto-expand-on-open is
  // retired. A failing run now opens MINIMIZED: the failing suite's
  // HEADER (with its `1 ✗ 1 ✓` counts) is visible but its leaves stay
  // collapsed exactly like an all-pass suite, and nothing auto-fetches.
  test("a run with failures opens MINIMIZED: the failing suite's header (with counts) renders but its leaves stay collapsed and un-fetched, same as an all-pass suite", async () => {
    const now = Date.now();
    const eventId = "evt-fold-with-fail";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-fold",
      agentId: "fold-agent-2",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      summary: { total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 800 },
      tree: [
        {
          name: "SuiteFailing",
          status: "fail",
          children: [
            { name: "okLeaf", status: "pass", duration_ms: 5 },
            { name: "badLeaf", status: "fail", duration_ms: 5, failure: { message: "boom" } },
          ],
        },
        {
          name: "SuitePassing",
          status: "pass",
          children: [
            { name: "p1", status: "pass", duration_ms: 5 },
            { name: "p2", status: "pass", duration_ms: 5 },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-fold", agentId: "fold-agent-2", kind: "test", tier: "regression", codec: "junit", timestamp: now, total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 800, hasCoverage: false };
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;

    // CR-CRU-038 §S1 — the FAILING suite's leaves are NOT auto-fetched;
    // its header renders with its `1 ✗ 1 ✓` counts, collapsed (▸).
    expect(fetchLog.some((u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteFailing"))).toBe(false);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
    const suiteFailingRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteFailing");
    expect(suiteFailingRow).toBeDefined();
    expect(suiteFailingRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    expect(suiteFailingRow!.textContent ?? "").toContain("1 ✗");

    // SuitePassing stays collapsed to its counted row and was never fetched
    // (unchanged bound — this was already true and still is).
    expect(fetchLog.some((u) => u.includes("suite=SuitePassing"))).toBe(false);
    const suitePassingRow = findByText(overlay, '[data-testid="suite-row"]', "SuitePassing");
    expect(suitePassingRow).toBeDefined();
    expect(suitePassingRow!.textContent ?? "").toContain("✓2");

    // The suite is still reachable on demand: clicking its header expands
    // it exactly like any collapsed suite (failing or not).
    suiteFailingRow!.click();
    await settle();
    const suiteFailingRowAfter = findByText(overlay, '[data-testid="suite-row"]', "SuiteFailing")!;
    expect(fetchLog.some((u) => u.includes(`/api/v2/events/${eventId}`) && u.includes("suite=SuiteFailing"))).toBe(true);
    expect(suiteFailingRowAfter.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▾");
    const leafRowsAfter = overlay.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRowsAfter.length).toBe(2);
    expect(Array.from(leafRowsAfter).some((r) => (r.textContent ?? "").includes("okLeaf"))).toBe(true);
    expect(Array.from(leafRowsAfter).some((r) => (r.textContent ?? "").includes("badLeaf"))).toBe(true);
  });

  // CR-CRU-038 §S1 RETARGET (2026-07-22): was "Detail mode bound: the same
  // failing fixture auto-expands (like Density) but renders NONE of the
  // Density-only elements" — auto-expand-on-open is retired for BOTH
  // presentations. Detail mode now opens this failing fixture MINIMIZED
  // exactly like Density does (no leaf-row, no fetch, no inline failure
  // box); the still-valid Detail-vs-Density bound (no heat-strip/status-
  // chips/digest-row) is kept, plus a manual-expand check proving the
  // suite's leaves + failure box are still reachable on click.
  test("Detail mode bound: the same failing fixture opens MINIMIZED (no auto-expand) and renders NONE of the Density-only elements (heat-strip / status-chips / digest-row)", async () => {
    const now = Date.now();
    const eventId = "evt-fold-detail-bound";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-fold",
      agentId: "fold-agent-3",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 100 },
      tree: [
        {
          name: "SuiteFailingDetail",
          status: "fail",
          children: [
            { name: "okLeaf", status: "pass", duration_ms: 5 },
            { name: "badLeaf", status: "fail", duration_ms: 5, failure: { message: "boom detail" } },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-fold", agentId: "fold-agent-3", kind: "test", tier: "unit", codec: "junit", timestamp: now, total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 100, hasCoverage: false };
    await mountAtRunCold(eventId, "unit", detail, brief);

    // CR-CRU-007 C5b re-baseline (§S4.0 — Density is regression-only):
    // modified from asserting data-mode="Detail" — a unit-tier drill-in now
    // renders no drillin-mode element at all.
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;

    // CR-CRU-038 §S1 — the failing suite stays MINIMIZED on open in Detail
    // mode too: no auto-fetch, no leaf-row, no inline failure box.
    expect(fetchLog.some((u) => u.includes("suite=SuiteFailingDetail"))).toBe(false);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
    expect(findByText(overlay, '[data-testid="leaf-row"]', "badLeaf")).toBeUndefined();
    expect(findByText(overlay, '[data-testid="leaf-row"]', "okLeaf")).toBeUndefined();
    expect(overlay.querySelector('[data-testid="failure-box"]')).toBeNull();
    const suiteFailingDetailRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteFailingDetail");
    expect(suiteFailingDetailRow).toBeDefined();
    expect(suiteFailingDetailRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");

    // Bound: Density-only presentation additions are absent in Detail mode.
    expect(overlay.querySelector('[data-testid="heat-strip"]')).toBeNull();
    expect(overlay.querySelector('[data-testid="density-status-chips"]')).toBeNull();
    expect(overlay.querySelectorAll('[data-testid="digest-row"]').length).toBe(0);

    // The suite is still reachable on demand: clicking it fetches + renders
    // its leaves and the failed leaf's inline failure box, same as before.
    suiteFailingDetailRow!.click();
    await settle();
    expect(fetchLog.some((u) => u.includes("suite=SuiteFailingDetail"))).toBe(true);
    const leafRows = overlay.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(2);
    expect(findByText(overlay, '[data-testid="leaf-row"]', "badLeaf")).toBeDefined();
    expect(findByText(overlay, '[data-testid="leaf-row"]', "okLeaf")).toBeDefined();
    const failureBox = overlay.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect((failureBox!.textContent ?? "")).toContain("boom detail");
  });
});

// ── CR-CRU-038 §S1 — error runs open MINIMIZED; failure-jump expands from
// collapsed (docs/changes/CR-CRU-038-patch-run-detail-controls.md) ─────────
//
// RED phase: expected to FAIL against the CURRENT public/app.js — a run
// with ≥1 failure still auto-expands its failing suite(s) on open
// (`autoExpandFailing`, app.js:3077, called unconditionally from the
// `?depth=suites` load at app.js:3047), and `jumpToNextFailure`
// (app.js:3329) computes its candidate leaves from `suiteLeaves.val`
// (app.js:3312-3322) — which stays empty when nothing auto-fetched, so a
// jump click from a truly collapsed default currently finds ZERO
// candidates and does nothing (the walk described below does not yet
// happen). Contract this block defines for GREEN:
//   - a run with ≥1 failure opens with every suite's HEADER visible (with
//     its inline `✗/✓` counts) but its leaf rows collapsed — a failing
//     suite is rendered identically to an all-pass suite on open.
//   - clicking `[data-testid="failure-jump"]` from that collapsed default
//     still advances to + focus-opens the next failing leaf (the suite
//     gets loaded/expanded on demand as part of the jump).
describe("§S1 (CR-CRU-038) — error run opens minimized; failure-jump expands from collapsed", () => {
  test("opening a run with failures renders every suite's header (with counts) but collapses ALL leaf rows — a failing suite looks identical to a passing one until clicked", async () => {
    const now = Date.now();
    const eventId = "evt-s1-minimized-open";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-s1-minimized",
      agentId: "s1-agent",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 40 },
      tree: [
        {
          name: "SuiteAlpha",
          status: "fail",
          children: [
            { name: "okA", status: "pass", duration_ms: 5 },
            { name: "badA", status: "fail", duration_ms: 5, failure: { message: "boom alpha" } },
          ],
        },
        {
          name: "SuiteBeta",
          status: "pass",
          children: [{ name: "okB", status: "pass", duration_ms: 5 }],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-s1-minimized", agentId: "s1-agent", kind: "test", tier: "unit", codec: "junit", timestamp: now, total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 40, hasCoverage: false };
    await mountAtRunCold(eventId, "unit", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelectorAll('[data-testid="suite-row"]').length).toBe(2);
    // Nothing fetched: neither suite auto-expanded, failing or not.
    expect(fetchLog.some((u) => u.includes("suite="))).toBe(false);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
    expect(overlay.querySelector('[data-testid="failure-box"]')).toBeNull();

    const suiteAlphaRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteAlpha");
    expect(suiteAlphaRow).toBeDefined();
    expect(suiteAlphaRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    expect(suiteAlphaRow!.textContent ?? "").toContain("1 ✗");
    expect(suiteAlphaRow!.textContent ?? "").toContain("1 ✓");

    const suiteBetaRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteBeta");
    expect(suiteBetaRow).toBeDefined();
    expect(suiteBetaRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    // CR-CRU-038 §S1 — unit-tier (Detail) run: the collapsed all-pass suite
    // shows the FULL `0 ✗ 1 ✓` counts (the `✓N` green-fold is Density-only),
    // matching SuiteAlpha's full form above and drill-in.test.ts:1540.
    expect(suiteBetaRow!.textContent ?? "").toContain("0 ✗ 1 ✓");
  });

  test("clicking the failure-jump from the collapsed default still expands the target suite and focus-opens the failing leaf's failure box", async () => {
    const now = Date.now();
    const eventId = "evt-s1-jump-from-collapsed";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-s1-jump",
      agentId: "s1-jump-agent",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 2, passed: 0, failed: 2, pending: 0, duration_ms: 20 },
      tree: [
        {
          name: "SuiteJump",
          status: "fail",
          children: [
            { name: "j1", status: "fail", duration_ms: 5, failure: { message: "boom j1" } },
            { name: "j2", status: "fail", duration_ms: 5, failure: { message: "boom j2" } },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-s1-jump", agentId: "s1-jump-agent", kind: "test", tier: "unit", codec: "junit", timestamp: now, total: 2, passed: 0, failed: 2, pending: 0, duration_ms: 20, hasCoverage: false };
    await mountAtRunCold(eventId, "unit", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    // Precondition: fully collapsed, nothing fetched (the §S1 default).
    expect(fetchLog.some((u) => u.includes("suite=SuiteJump"))).toBe(false);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
    const suiteJumpRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteJump")!;
    expect(suiteJumpRow.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");

    // CR-CRU-038 §S3 RETARGET (2026-07-22): failure-jump moved OUT of the
    // footer into the drill-in header — the footer is retired entirely
    // (it carried nothing else). Query at `document` (was scoped inside
    // `[data-testid="failures-footer"]`, which no longer exists).
    expect(document.querySelector('[data-testid="failures-footer"]')).toBeNull();
    const jump = document.querySelector('[data-testid="failure-jump"]') as HTMLElement | null;
    expect(jump).not.toBeNull();
    jump!.click();
    await settle();

    // The jump loaded/expanded SuiteJump on demand — its leaves are now
    // reachable and the toggle flips to expanded.
    expect(fetchLog.some((u) => u.includes("suite=SuiteJump"))).toBe(true);
    const suiteJumpRowAfter = findByText(overlay, '[data-testid="suite-row"]', "SuiteJump")!;
    expect(suiteJumpRowAfter.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▾");

    // jumpPos starts at 0 and advances by 1 on the first click, so with 2
    // failing leaves in input order [j1, j2] the target is j2 (index 1) —
    // matching the existing jump-cursor convention (drill-in.test.ts's
    // footer-anatomy test: 3 leaves, first click lands on the 2nd).
    const j2Row = overlay.querySelector('[data-leaf-key="SuiteJump::j2"]');
    expect(j2Row).not.toBeNull();
    const failureBox = j2Row!.nextElementSibling;
    expect(failureBox?.getAttribute("data-testid")).toBe("failure-box");
    expect((failureBox?.textContent ?? "")).toContain("boom j2");
  });
});

// ── §S4 item 2 — heat-strip minimap ─────────────────────────────────────────

function buildHeatFixture(eventId: string, tier: string, now: number, total: number, failIndices: number[], pendingIndices: number[]) {
  const children: LeafFixture[] = [];
  for (let i = 0; i < total; i++) {
    if (failIndices.includes(i)) {
      children.push({ name: `t${i}`, status: "fail", duration_ms: 5, failure: { message: i === failIndices[0] ? "first failure" : `failure at ${i}` } });
    } else if (pendingIndices.includes(i)) {
      children.push({ name: `t${i}`, status: "pending", duration_ms: 5 });
    } else {
      children.push({ name: `t${i}`, status: "pass", duration_ms: 5 });
    }
  }
  const failed = failIndices.length;
  const pending = pendingIndices.length;
  const passed = total - failed - pending;
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey: "proj-heat",
    agentId: "heat-agent",
    kind: "test",
    tier,
    codec: "junit",
    timestamp: now,
    summary: { total, passed, failed, pending, duration_ms: 500 },
    tree: [{ name: "SuiteHeat", status: failed > 0 ? "fail" : "pass", children }],
  };
  const brief: EventBriefFixture = { id: eventId, projectKey: "proj-heat", agentId: "heat-agent", kind: "test", tier, codec: "junit", timestamp: now, total, passed, failed, pending, duration_ms: 500, hasCoverage: false };
  return { detail, brief };
}

describe("§S4.2 — heat-strip minimap (Density mode)", () => {
  test("a 60-test fixture renders exactly 60 heat cells, classed fail/pending/pass", async () => {
    const now = Date.now();
    const eventId = "evt-heat-60";
    const { detail, brief } = buildHeatFixture(eventId, "regression", now, 60, [10, 40], [5]);
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const heatStrip = overlay.querySelector('[data-testid="heat-strip"]');
    expect(heatStrip).not.toBeNull();
    const cells = heatStrip!.querySelectorAll('[data-testid="heat-cell"]');
    expect(cells.length).toBe(60);

    const failCells = Array.from(cells).filter((c) => c.className.includes("app-heat-fail"));
    const pendingCells = Array.from(cells).filter((c) => c.className.includes("app-heat-pending"));
    const passCells = Array.from(cells).filter((c) => c.className.includes("app-heat-pass"));
    expect(failCells.length).toBe(2);
    expect(pendingCells.length).toBe(1);
    expect(passCells.length).toBe(57);
  });

  test("an 8-test Density run renders exactly 8 heat cells (no count threshold)", async () => {
    const now = Date.now();
    const eventId = "evt-heat-8";
    const { detail, brief } = buildHeatFixture(eventId, "regression", now, 8, [], []);
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const heatStrip = overlay.querySelector('[data-testid="heat-strip"]');
    expect(heatStrip).not.toBeNull();
    expect(heatStrip!.querySelectorAll('[data-testid="heat-cell"]').length).toBe(8);
  });

  test("clicking the first red cell expands that test's failure box (failure.message becomes visible)", async () => {
    const now = Date.now();
    const eventId = "evt-heat-click";
    const { detail, brief } = buildHeatFixture(eventId, "regression", now, 60, [10, 40], [5]);
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const heatStrip = overlay.querySelector('[data-testid="heat-strip"]')!;
    const cells = heatStrip.querySelectorAll('[data-testid="heat-cell"]');
    const firstRedCell = Array.from(cells).find((c) => c.className.includes("app-heat-fail")) as HTMLElement | undefined;
    expect(firstRedCell).toBeDefined();

    expect(overlay.querySelector('[data-testid="failure-box"]')).toBeNull();
    firstRedCell!.click();
    await settle();

    const failureBox = overlay.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect((failureBox!.textContent ?? "")).toContain("first failure");
  });

  test("Detail mode bound: the same 60-test fixture renders NO heat-strip", async () => {
    const now = Date.now();
    const eventId = "evt-heat-detail-bound";
    const { detail, brief } = buildHeatFixture(eventId, "unit", now, 60, [10, 40], [5]);
    await mountAtRunCold(eventId, "unit", detail, brief);

    // CR-CRU-007 C5b re-baseline (§S4.0 — Density is regression-only):
    // modified from asserting data-mode="Detail" — a unit-tier drill-in now
    // renders no drillin-mode element at all.
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    expect(overlay.querySelector('[data-testid="heat-strip"]')).toBeNull();
  });
});

// ── §S4 item 3 — failure digest ─────────────────────────────────────────────

describe("§S4.3 — failure digest (Density mode)", () => {
  test("4 leaves with identical failure.message render as 1 digest row + '+3 identical' expander; expanding reveals the individual leaves", async () => {
    const now = Date.now();
    const eventId = "evt-digest-group";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-digest",
      agentId: "digest-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      summary: { total: 4, passed: 0, failed: 4, pending: 0, duration_ms: 200 },
      tree: [
        {
          name: "SuiteDigest",
          status: "fail",
          children: [
            { name: "d1", status: "fail", duration_ms: 5, failure: { message: "identical boom" } },
            { name: "d2", status: "fail", duration_ms: 5, failure: { message: "identical boom" } },
            { name: "d3", status: "fail", duration_ms: 5, failure: { message: "identical boom" } },
            { name: "d4", status: "fail", duration_ms: 5, failure: { message: "identical boom" } },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-digest", agentId: "digest-agent", kind: "test", tier: "regression", codec: "junit", timestamp: now, total: 4, passed: 0, failed: 4, pending: 0, duration_ms: 200, hasCoverage: false };
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    // CR-CRU-038 §S1 — SuiteDigest no longer auto-expands on open (the run
    // has failures, so it opens MINIMIZED); expand it explicitly via its
    // suite-row click to reach the digest grouping this test exercises.
    expect(overlay.querySelectorAll('[data-testid="digest-row"]').length).toBe(0);
    const suiteDigestRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteDigest");
    expect(suiteDigestRow).toBeDefined();
    expect(suiteDigestRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    suiteDigestRow!.click();
    await settle();

    const digestRows = overlay.querySelectorAll('[data-testid="digest-row"]');
    expect(digestRows.length).toBe(1);
    expect((digestRows[0]!.textContent ?? "")).toContain("identical boom");

    const expander = digestRows[0]!.querySelector('[data-testid="digest-expander"]');
    expect(expander).not.toBeNull();
    expect((expander!.textContent ?? "").trim()).toBe("+3 identical");

    // Collapsed: none of the 4 grouped leaves render as individual leaf-rows yet.
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);

    (expander as HTMLElement).click();
    await settle();

    const leafRows = overlay.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(4);
    for (const name of ["d1", "d2", "d3", "d4"]) {
      expect(Array.from(leafRows).some((r) => (r.textContent ?? "").includes(name))).toBe(true);
    }
  });

  test("leaves with DIFFERENT failure messages don't group — each renders its own leaf-row", async () => {
    const now = Date.now();
    const eventId = "evt-digest-nogroup";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-digest",
      agentId: "digest-agent-2",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      summary: { total: 3, passed: 0, failed: 3, pending: 0, duration_ms: 200 },
      tree: [
        {
          name: "SuiteDigestDiff",
          status: "fail",
          children: [
            { name: "e1", status: "fail", duration_ms: 5, failure: { message: "message A" } },
            { name: "e2", status: "fail", duration_ms: 5, failure: { message: "message B" } },
            { name: "e3", status: "fail", duration_ms: 5, failure: { message: "message C" } },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-digest", agentId: "digest-agent-2", kind: "test", tier: "regression", codec: "junit", timestamp: now, total: 3, passed: 0, failed: 3, pending: 0, duration_ms: 200, hasCoverage: false };
    await mountAtRunCold(eventId, "regression", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    // CR-CRU-038 §S1 — the run opens MINIMIZED; expand SuiteDigestDiff via its
    // suite-row click (mirroring the retargeted identical-message sibling
    // above) to reach the leaves this test exercises.
    const suiteDiffRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteDigestDiff");
    expect(suiteDiffRow).toBeDefined();
    expect(suiteDiffRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
    suiteDiffRow!.click();
    await settle();

    expect(overlay.querySelectorAll('[data-testid="digest-row"]').length).toBe(0);
    const leafRows = overlay.querySelectorAll('[data-testid="leaf-row"]');
    expect(leafRows.length).toBe(3);
  });

  test("Detail mode bound: identical-message leaves never digest, even after a manual suite expand", async () => {
    const now = Date.now();
    const eventId = "evt-digest-detail-bound";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-digest",
      agentId: "digest-agent-3",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 4, passed: 0, failed: 4, pending: 0, duration_ms: 200 },
      tree: [
        {
          name: "SuiteDigestDetail",
          status: "fail",
          children: [
            { name: "f1", status: "fail", duration_ms: 5, failure: { message: "identical boom detail" } },
            { name: "f2", status: "fail", duration_ms: 5, failure: { message: "identical boom detail" } },
            { name: "f3", status: "fail", duration_ms: 5, failure: { message: "identical boom detail" } },
            { name: "f4", status: "fail", duration_ms: 5, failure: { message: "identical boom detail" } },
          ],
        },
      ],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-digest", agentId: "digest-agent-3", kind: "test", tier: "unit", codec: "junit", timestamp: now, total: 4, passed: 0, failed: 4, pending: 0, duration_ms: 200, hasCoverage: false };
    await mountAtRunCold(eventId, "unit", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteDigestDetail");
    expect(suiteRow).toBeDefined();
    suiteRow!.click();
    await settle();

    expect(overlay.querySelectorAll('[data-testid="digest-row"]').length).toBe(0);
    expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(4);
  });
});

// ── §S4 item 4 — virtualized tree (always-on, both modes) ──────────────────

/**
 * Builds a 10 000-leaf synthetic run: one clearly-largest suite ("SuiteBig",
 * 300 leaves — including 1 fail + 1 pending so it also exercises §S4.1's
 * auto-expand in Density mode) plus enough 200-leaf "SuiteOtherN" suites to
 * reach exactly 10 000 leaves total. Keeping every OTHER suite well under
 * SuiteBig's size makes "the largest suite" unambiguous while keeping
 * fixture construction and (pre-virtualization) worst-case DOM mounting
 * cheap enough to run without a custom test timeout.
 */
function manyLeavesFixture(eventId: string, tier: string, now: number) {
  const BIG_SIZE = 300;
  const OTHER_SIZE = 200;
  const TOTAL = 10_000;

  const bigLeaves: LeafFixture[] = [];
  for (let i = 0; i < BIG_SIZE; i++) {
    if (i === 50) bigLeaves.push({ name: `big-${i}`, status: "fail", duration_ms: 5, failure: { message: "big-fail" } });
    else if (i === 200) bigLeaves.push({ name: `big-${i}`, status: "pending", duration_ms: 5 });
    else bigLeaves.push({ name: `big-${i}`, status: "pass", duration_ms: 5 });
  }
  const suites: SuiteFixture[] = [{ name: "SuiteBig", status: "fail", children: bigLeaves }];

  let remaining = TOTAL - BIG_SIZE;
  let suiteIdx = 0;
  while (remaining > 0) {
    const size = Math.min(OTHER_SIZE, remaining);
    const leaves: LeafFixture[] = [];
    for (let i = 0; i < size; i++) leaves.push({ name: `o${suiteIdx}-${i}`, status: "pass", duration_ms: 5 });
    suites.push({ name: `SuiteOther${suiteIdx}`, status: "pass", children: leaves });
    remaining -= size;
    suiteIdx += 1;
  }

  const total = suites.reduce((sum, s) => sum + s.children.length, 0);
  const failed = suites.reduce((sum, s) => sum + s.children.filter((l) => l.status === "fail").length, 0);
  const pending = suites.reduce((sum, s) => sum + s.children.filter((l) => l.status === "pending").length, 0);
  const passed = total - failed - pending;

  const detail: EventDetailFixture = {
    id: eventId,
    projectKey: "proj-virt",
    agentId: "virt-agent",
    kind: "test",
    tier,
    codec: "junit",
    timestamp: now,
    summary: { total, passed, failed, pending, duration_ms: 5000 },
    tree: suites,
  };
  const brief: EventBriefFixture = { id: eventId, projectKey: "proj-virt", agentId: "virt-agent", kind: "test", tier, codec: "junit", timestamp: now, total, passed, failed, pending, duration_ms: 5000, hasCoverage: false };
  return { detail, brief, total };
}

describe("§S4.4 — virtualized tree (always-on, both modes)", () => {
  test(
    "Detail mode: expanding the largest suite of a 10 000-leaf run keeps mounted tree-row nodes under 200, and scrolling changes which rows are mounted",
    async () => {
      const now = Date.now();
      const eventId = "evt-virt-detail";
      const { detail, brief, total } = manyLeavesFixture(eventId, "unit", now);
      expect(total).toBe(10_000);
      await mountAtRunCold(eventId, "unit", detail, brief);

      const overlay = document.querySelector('[data-testid="run-overlay"]')!;
      const bigSuiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteBig");
      expect(bigSuiteRow).toBeDefined();
      bigSuiteRow!.click();
      await settle();

      expect(fetchLog.some((u) => u.includes("suite=SuiteBig"))).toBe(true);
      expect(mountedTreeRowCount(overlay)).toBeLessThan(200);

      // CR-CRU-034 §S1 RE-SOURCE: virtualization's scroll source is now the
      // bounded run-detail scroller `pane-scroll` (the retired per-suite
      // `tree-scroll` 60vh inner box no longer owns this scroll listener).
      const scrollContainer = overlay.querySelector('[data-testid="pane-scroll"]') as HTMLElement | null;
      expect(scrollContainer).not.toBeNull();
      Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(scrollContainer, "scrollHeight", { value: 300 * 28, configurable: true });

      const beforeKeys = new Set(
        Array.from(overlay.querySelectorAll('[data-testid="leaf-row"]')).map((el) => el.getAttribute("data-leaf-key")),
      );
      expect(beforeKeys.size).toBeGreaterThan(0);

      scrollContainer!.scrollTop = 300 * 28 - 500;
      scrollContainer!.dispatchEvent(new Event("scroll"));
      await settle();

      const afterKeys = new Set(
        Array.from(overlay.querySelectorAll('[data-testid="leaf-row"]')).map((el) => el.getAttribute("data-leaf-key")),
      );
      expect(afterKeys.size).toBeLessThan(200);
      const overlap = [...beforeKeys].filter((k) => afterKeys.has(k));
      expect(overlap.length).toBeLessThan(beforeKeys.size);
    },
    20_000,
  );

  // CR-CRU-038 §S1 RETARGET (2026-07-22): was "... largest (failing) suite
  // auto-expands and still keeps mounted tree-row nodes under 200" —
  // auto-expand-on-open is retired at ANY scale: SuiteBig (the failing,
  // largest suite) now stays collapsed/un-fetched on open just like every
  // other suite, so the "mounted rows < 200" bound is nearly trivial here
  // (only suite-row headers mount) — the real virtualized-expand case is
  // covered by the sibling Detail-mode test above, which clicks to expand.
  test(
    "Density mode: a 10 000-leaf run's largest (failing) suite stays collapsed/un-fetched on open (minimized default, at scale) and mounted tree-row nodes stay under 200",
    async () => {
      const now = Date.now();
      const eventId = "evt-virt-density";
      const { detail, brief, total } = manyLeavesFixture(eventId, "regression", now);
      expect(total).toBe(10_000);
      await mountAtRunCold(eventId, "regression", detail, brief);

      const overlay = document.querySelector('[data-testid="run-overlay"]')!;
      expect(fetchLog.some((u) => u.includes("suite=SuiteBig"))).toBe(false);
      expect(fetchLog.some((u) => u.includes("suite=SuiteOther0"))).toBe(false);
      expect(overlay.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
      const bigSuiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteBig");
      expect(bigSuiteRow).toBeDefined();
      expect(bigSuiteRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▸");
      expect(mountedTreeRowCount(overlay)).toBeLessThan(200);
    },
    20_000,
  );

  // CR-CRU-038 §S1 RETARGET (2026-07-22): the title/comment previously said
  // "SuiteBig auto-expands but stays windowed" — auto-expand-on-open is
  // retired, so SuiteBig (like every suite) stays collapsed/un-fetched on
  // this cold mount; the assertions below never actually depended on
  // auto-expand (they only check paging order + a mounted-row ceiling, both
  // trivially true when everything is collapsed too), so only the stale
  // wording is corrected here — no behavior change to assert.
  test("the initial drill-in fetch for a 10 000-leaf run is suites-first (?depth=suites before any ?suite=); SuiteBig stays collapsed/un-fetched (minimized default) and mounted rows stay under 200", async () => {
    const now = Date.now();
    const eventId = "evt-virt-payload";
    const { detail, brief, total } = manyLeavesFixture(eventId, "unit", now);
    expect(total).toBe(10_000);
    await mountAtRunCold(eventId, "unit", detail, brief);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const eventFetches = fetchLog.filter((u) => u.includes(`/api/v2/events/${eventId}`));
    expect(eventFetches.length).toBeGreaterThan(0);
    expect(eventFetches[0]).toContain("depth=suites");
    expect(mountedTreeRowCount(overlay)).toBeLessThan(200);
  });
});

// ── §S4 item 6 — density toggle (independent of Detail/Density) ────────────

const DENSITY_STORAGE_KEY = "crucible.density.mode";

describe("§S4.6 — density toggle (comfortable / compact / ultra)", () => {
  test("cycles comfortable -> compact -> ultra -> comfortable and applies a matching root class", async () => {
    const now = Date.now();
    await mountApp({ pathname: "/", projects: [], events: [] });
    void now;

    const toggle = document.querySelector('[data-testid="density-toggle"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("data-density")).toBe("comfortable");
    expect(document.documentElement.classList.contains("app-density-comfortable")).toBe(true);

    toggle!.click();
    await settle();
    expect(document.querySelector('[data-testid="density-toggle"]')!.getAttribute("data-density")).toBe("compact");
    expect(document.documentElement.classList.contains("app-density-compact")).toBe(true);
    expect(document.documentElement.classList.contains("app-density-comfortable")).toBe(false);

    document.querySelector('[data-testid="density-toggle"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector('[data-testid="density-toggle"]')!.getAttribute("data-density")).toBe("ultra");
    expect(document.documentElement.classList.contains("app-density-ultra")).toBe(true);

    document.querySelector('[data-testid="density-toggle"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector('[data-testid="density-toggle"]')!.getAttribute("data-density")).toBe("comfortable");
    expect(document.documentElement.classList.contains("app-density-comfortable")).toBe(true);
  });

  test("the chosen mode persists to localStorage and is honored on the next cold mount", async () => {
    await mountApp({ pathname: "/", projects: [], events: [] });
    const toggle = document.querySelector('[data-testid="density-toggle"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();

    toggle!.click(); // -> compact
    await settle();
    toggle!.click(); // -> ultra
    await settle();
    expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("ultra");

    // Simulate reload: fresh mount (fresh Storage per GlobalRegistrator.register)
    // seeded with the persisted value.
    await mountApp({ pathname: "/", projects: [], events: [], localStorageSeed: { [DENSITY_STORAGE_KEY]: "ultra" } });
    const reloaded = document.querySelector('[data-testid="density-toggle"]') as HTMLElement | null;
    expect(reloaded).not.toBeNull();
    expect(reloaded!.getAttribute("data-density")).toBe("ultra");
    expect(document.documentElement.classList.contains("app-density-ultra")).toBe(true);
  });

  // CR-CRU-007 C5b FINAL re-baseline: the mode badge/switch is REMOVED
  // ENTIRELY (§S4.0 — purely tier-contextual, no drillin-mode element
  // anywhere). Rewritten from "flipping density never changes drillin-mode's
  // data-mode, and vice versa" (which asserted a data-mode attribute that no
  // longer exists) to: the comfortable/compact/ultra density-toggle (idea 6
  // — the only user-facing control left) behaves identically regardless of
  // which tier-driven presentation (Density for regression, Detail for
  // unit) is showing, and neither tier ever renders a drillin-mode element.
  test("the comfortable/compact/ultra density-toggle is independent of tier-driven presentation — no drillin-mode element exists on either tier", async () => {
    const now = Date.now();
    const eventId = "evt-density-independence";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-independence",
      agentId: "independence-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "SuiteIndep", status: "pass", children: [{ name: "i1", status: "pass", duration_ms: 5 }] }],
    };
    const brief: EventBriefFixture = { id: eventId, projectKey: "proj-independence", agentId: "independence-agent", kind: "test", tier: "regression", codec: "junit", timestamp: now, total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5, hasCoverage: false };
    await mountAtRunCold(eventId, "regression", detail, brief);

    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    const densityToggle = document.querySelector('[data-testid="density-toggle"]') as HTMLElement | null;
    expect(densityToggle).not.toBeNull();
    expect(densityToggle!.getAttribute("data-density")).toBe("comfortable");

    densityToggle!.click(); // comfortable -> compact
    await settle();
    expect(document.querySelector('[data-testid="density-toggle"]')!.getAttribute("data-density")).toBe("compact");
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();

    // Same control, same behavior on a Detail-presented (unit-tier) run.
    const eventId2 = "evt-density-independence-unit";
    const detail2: EventDetailFixture = {
      id: eventId2,
      projectKey: "proj-independence",
      agentId: "independence-agent-2",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "SuiteIndep2", status: "pass", children: [{ name: "i2", status: "pass", duration_ms: 5 }] }],
    };
    const brief2: EventBriefFixture = { id: eventId2, projectKey: "proj-independence", agentId: "independence-agent-2", kind: "test", tier: "unit", codec: "junit", timestamp: now, total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5, hasCoverage: false };
    await mountAtRunCold(eventId2, "unit", detail2, brief2);

    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
    expect(document.querySelector('[data-testid="density-toggle"]')).not.toBeNull();
  });
});
