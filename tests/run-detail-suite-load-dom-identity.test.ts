// DOM-level regression coverage for the run view's suite-load isolation:
// loading one suite's leaves must not rebuild any OTHER suite's rendered
// row or heat-strip cell. Same happy-dom harness pattern this suite's other
// run-detail DOM tests already use: real production public/app.js, real
// public/app-logic.mjs, real VanJS/VanX vendor bundles; `fetch` is scripted.
//
// Why this fails today: inside RunDetailBody, TestBody and HeatStrip both
// read suiteLeaves synchronously as a single van.state map. VanJS therefore
// tracks the WHOLE map as one dependency of the body's outer derivation, so
// writing suiteLeaves.val for just ONE suite (loadSuite, called from
// expandSuite's click handler, from SynthHeatCell's click handler, and from
// loadScrolledScenarios on scroll — all three write the same state) reruns
// the entire body derivation and replaces every suite's row/cell, loaded or
// not. Measured directly on a real run view: 2-3 of every 6 suite loads
// replaced the OTHER suites' rows. The two tests below tag every rendered
// suite-row and heat-cell element before triggering ONE suite's load (by
// click, the same suiteLeaves write path loadScrolledScenarios uses) and
// assert every element outside that suite keeps its identity — the exact
// node object, still attached to the document — afterwards, for a plain run
// and for a spec (BDD) run. The loaded suite's OWN cells are expected to
// change (synthetic counts become real per-leaf cells); every test below
// states that expectation explicitly instead of leaving it unchecked.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
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
  kind: "test";
  tier: string;
  codec?: string;
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
interface MountOpts {
  pathname?: string;
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

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
        throw new Error(`run-detail-suite-load-dom-identity.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
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
      throw new Error(`run-detail-suite-load-dom-identity.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?suiteLoadIdentity=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 6): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
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

async function mountAtRunCold(eventId: string, detail: EventDetailFixture): Promise<void> {
  await mountApp({
    pathname: `/run/${eventId}`,
    events: [briefOf(detail)],
    eventDetails: { [eventId]: detail },
  });
}

/** A plain-tree fixture of `suiteCount` suites, each `leavesPerSuite`
 *  all-passing leaves — `tier: "e2e"` renders Density (the one presentation
 *  with a heat strip), so every assertion below exercises both anatomies. */
function manySuitesFixture(eventId: string, suiteCount: number, leavesPerSuite: number): EventDetailFixture {
  const tree: SuiteFixture[] = [];
  for (let s = 1; s <= suiteCount; s++) {
    const suiteName = `Suite-${String(s).padStart(2, "0")}`;
    const children: LeafFixture[] = [];
    for (let l = 1; l <= leavesPerSuite; l++) {
      children.push({ name: `${suiteName}-leaf-${l}`, status: "pass", duration_ms: 3 });
    }
    tree.push({ name: suiteName, status: "pass", children });
  }
  return {
    id: eventId,
    projectKey: "proj-suite-load-identity",
    agentId: "suite-load-identity-agent",
    kind: "test",
    tier: "e2e",
    timestamp: Date.now(),
    tree,
  };
}

/** A spec-run fixture: ONE feature (so it auto-opens, CR-CRU-145's
 *  progressive-expansion default — the first feature always unfolds) holding
 *  `scenarioCount` all-passing scenarios named by BDD_SEP (" › "), each with
 *  `leavesPerScenario` steps. `tier: "e2e"` + `codec: "playwright"` renders
 *  Density AND the spec (feature → scenario) anatomy (isSpecRun). */
function specManyScenariosFixture(
  eventId: string,
  featureName: string,
  scenarioCount: number,
  leavesPerScenario: number,
): EventDetailFixture {
  const tree: SuiteFixture[] = [];
  for (let s = 1; s <= scenarioCount; s++) {
    const suiteName = `${featureName} › Scenario ${s}`;
    const children: LeafFixture[] = [];
    for (let l = 1; l <= leavesPerScenario; l++) {
      children.push({ name: `step-${l}`, status: "pass", duration_ms: 2 });
    }
    tree.push({ name: suiteName, status: "pass", children });
  }
  return {
    id: eventId,
    projectKey: "proj-spec-suite-load-identity",
    agentId: "spec-suite-load-identity-agent",
    kind: "test",
    tier: "e2e",
    codec: "playwright",
    timestamp: Date.now(),
    tree,
  };
}

/** Tags every currently-rendered element matched by `selector` with a unique
 *  `data-identity-probe` value and returns the captured element references
 *  keyed by a caller-supplied label — the SAME node objects, not clones, so
 *  a later `toBe()` / `isConnected` check proves identity rather than
 *  structural equality. */
function tagAll(root: ParentNode, selector: string, labelOf: (el: Element) => string): Map<string, Element> {
  const captured = new Map<string, Element>();
  let i = 0;
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const tag = `probe-${i}`;
    i += 1;
    el.setAttribute("data-identity-probe", tag);
    captured.set(`${labelOf(el)}::${tag}`, el);
  }
  return captured;
}

function belongsToSuite(title: string, suiteKey: string): boolean {
  return title === suiteKey || title.startsWith(`${suiteKey} › `);
}

describe("a loaded suite renders without rebuilding the other suites' DOM — plain run", () => {
  test("clicking one collapsed suite's row loads its leaves and every OTHER suite-row keeps the exact same DOM node", async () => {
    const eventId = "evt-plain-suite-load-identity";
    const detail = manySuitesFixture(eventId, 6, 5);
    await mountAtRunCold(eventId, detail);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const rowsBefore = tagAll(overlay, '[data-testid="suite-row"]', (el) =>
      el.getAttribute("data-suite-key") ?? "",
    );
    expect(rowsBefore.size).toBe(6);

    const loadedKey = "Suite-03";
    const targetRow = findByText(overlay, '[data-testid="suite-row"]', loadedKey);
    expect(targetRow).toBeDefined();
    targetRow!.click();
    await settle();

    const otherKeys = ["Suite-01", "Suite-02", "Suite-04", "Suite-05", "Suite-06"];
    let checked = 0;
    for (const [label, before] of rowsBefore) {
      const key = label.split("::")[0]!;
      if (key === loadedKey) continue;
      checked += 1;
      // Same object still attached to the live document — identity, not a
      // coincidentally-equal replacement node.
      expect((before as HTMLElement).isConnected, `suite row "${key}" was detached (rebuilt)`).toBe(true);
      const after = overlay.querySelector(`[data-testid="suite-row"][data-suite-key="${CSS.escape(key)}"]`);
      expect(after, `suite row "${key}" should still resolve to an element`).not.toBeNull();
      expect(after, `suite row "${key}" was replaced by a different element`).toBe(before);
    }
    expect(checked).toBe(5);
    expect(otherKeys.length).toBe(5);

    // The loaded suite's OWN row legitimately re-renders (▸ becomes ▾, a
    // leaf list appears) — no identity claim is made about it here.
    const loadedRowAfter = overlay.querySelector('[data-testid="suite-row"][data-suite-key="Suite-03"]');
    expect(loadedRowAfter).not.toBeNull();
    expect(loadedRowAfter!.querySelector('[data-testid="tree-toggle"]')?.textContent).toBe("▾");
  });

  test("clicking one collapsed suite's row keeps every OTHER suite's synthetic heat-cell identity, and only that suite's own cells turn real", async () => {
    const eventId = "evt-plain-heat-cell-identity";
    const detail = manySuitesFixture(eventId, 6, 5);
    await mountAtRunCold(eventId, detail);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const strip = overlay.querySelector('[data-testid="heat-strip"]');
    expect(strip).not.toBeNull();
    const cellsBefore = Array.from(strip!.querySelectorAll('[data-testid="heat-cell"]')) as HTMLElement[];
    // 6 suites x 5 leaves, every suite still collapsed at mount: 30 synthetic cells.
    expect(cellsBefore.length).toBe(30);
    cellsBefore.forEach((el, i) => el.setAttribute("data-identity-probe", `probe-${i}`));
    const titleAt = new Map<string, string>(cellsBefore.map((el) => [el.getAttribute("data-identity-probe")!, el.title]));

    const loadedKey = "Suite-03";
    const targetRow = findByText(overlay, '[data-testid="suite-row"]', loadedKey);
    targetRow!.click();
    await settle();

    const otherCells = cellsBefore.filter((el) => !belongsToSuite(titleAt.get(el.getAttribute("data-identity-probe")!)!, loadedKey));
    const loadedCellsBefore = cellsBefore.filter((el) => belongsToSuite(titleAt.get(el.getAttribute("data-identity-probe")!)!, loadedKey));
    // 5 other suites x 5 leaves = 25 cells that must be untouched; the
    // loaded suite contributed the remaining 5 synthetic cells.
    expect(otherCells.length).toBe(25);
    expect(loadedCellsBefore.length).toBe(5);

    for (const cell of otherCells) {
      expect(cell.isConnected, `heat cell titled "${cell.title}" was detached (rebuilt)`).toBe(true);
    }
    // The loaded suite's OWN synthetic cells are legitimately gone — real,
    // per-leaf cells replace them.
    for (const cell of loadedCellsBefore) {
      expect(cell.isConnected, `Suite-03's synthetic heat cell should have been replaced`).toBe(false);
    }
    const stripAfter = overlay.querySelector('[data-testid="heat-strip"]')!;
    const realCellsForLoaded = Array.from(stripAfter.querySelectorAll('[data-testid="heat-cell"]')).filter(
      (el) => (el as HTMLElement).title.startsWith(`${loadedKey} › `),
    );
    expect(realCellsForLoaded.length).toBe(5);
    expect(stripAfter.querySelectorAll('[data-testid="heat-cell"]').length).toBe(30);
  });
});

describe("a loaded suite renders without rebuilding the other suites' DOM — spec (BDD) run", () => {
  test("loading one not-yet-loaded scenario's leaves keeps every OTHER scenario's suite-row the exact same DOM node", async () => {
    const eventId = "evt-spec-suite-load-identity";
    const detail = specManyScenariosFixture(eventId, "Calm Feature", 6, 3);
    await mountAtRunCold(eventId, detail);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    // CR-CRU-145's progressive-expansion default already loaded Scenario 1
    // and Scenario 2 on mount (SPEC_FIRST_OPEN) — tagging happens AFTER that
    // settles, so this test targets the SAME suiteLeaves-write path a later
    // scroll-triggered load uses (loadScrolledScenarios), not just the
    // initial mount.
    const rowsBefore = tagAll(overlay, '[data-testid="suite-row"]', (el) =>
      el.getAttribute("data-suite-key") ?? "",
    );
    expect(rowsBefore.size).toBe(6);

    const loadedKey = "Calm Feature › Scenario 3";
    const targetRow = findByText(overlay, '[data-testid="suite-row"]', "Scenario 3");
    expect(targetRow).toBeDefined();
    // Scenario 3 is still collapsed (only Scenario 1/2 auto-loaded) — this
    // click is the first fetch of its leaves.
    expect(targetRow!.querySelector('[data-testid="tree-toggle"]')?.textContent).toBe("▸");
    targetRow!.click();
    await settle();

    let checked = 0;
    for (const [label, before] of rowsBefore) {
      const key = label.split("::")[0]!;
      if (key === loadedKey) continue;
      checked += 1;
      expect((before as HTMLElement).isConnected, `scenario row "${key}" was detached (rebuilt)`).toBe(true);
      const after = overlay.querySelector(`[data-testid="suite-row"][data-suite-key="${CSS.escape(key)}"]`);
      expect(after, `scenario row "${key}" should still resolve to an element`).not.toBeNull();
      expect(after, `scenario row "${key}" was replaced by a different element`).toBe(before);
    }
    expect(checked).toBe(5);

    const loadedRowAfter = overlay.querySelector(
      `[data-testid="suite-row"][data-suite-key="${CSS.escape(loadedKey)}"]`,
    );
    expect(loadedRowAfter).not.toBeNull();
    expect(loadedRowAfter!.querySelector('[data-testid="tree-toggle"]')?.textContent).toBe("▾");
  });

  test("loading one not-yet-loaded scenario's leaves keeps every OTHER scenario's heat-strip cells, and only that scenario's own cells turn real", async () => {
    const eventId = "evt-spec-heat-cell-identity";
    const detail = specManyScenariosFixture(eventId, "Calm Feature", 6, 3);
    await mountAtRunCold(eventId, detail);

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const strip = overlay.querySelector('[data-testid="heat-strip"]');
    expect(strip).not.toBeNull();
    const cellsBefore = Array.from(strip!.querySelectorAll('[data-testid="heat-cell"]')) as HTMLElement[];
    // 6 scenarios x 3 leaves = 18 cells, whichever mix of real (Scenario 1/2,
    // auto-loaded) and synthetic (Scenario 3-6, still collapsed) the
    // progressive default left behind.
    expect(cellsBefore.length).toBe(18);
    cellsBefore.forEach((el, i) => el.setAttribute("data-identity-probe", `probe-${i}`));
    const titleAt = new Map<string, string>(cellsBefore.map((el) => [el.getAttribute("data-identity-probe")!, el.title]));

    const loadedKey = "Calm Feature › Scenario 3";
    const targetRow = findByText(overlay, '[data-testid="suite-row"]', "Scenario 3");
    targetRow!.click();
    await settle();

    const otherCells = cellsBefore.filter((el) => !belongsToSuite(titleAt.get(el.getAttribute("data-identity-probe")!)!, loadedKey));
    const loadedCellsBefore = cellsBefore.filter((el) => belongsToSuite(titleAt.get(el.getAttribute("data-identity-probe")!)!, loadedKey));
    expect(otherCells.length).toBe(15);
    expect(loadedCellsBefore.length).toBe(3);

    for (const cell of otherCells) {
      expect(cell.isConnected, `heat cell titled "${cell.title}" was detached (rebuilt)`).toBe(true);
    }
    for (const cell of loadedCellsBefore) {
      expect(cell.isConnected, `Scenario 3's synthetic heat cell should have been replaced`).toBe(false);
    }
    const stripAfter = overlay.querySelector('[data-testid="heat-strip"]')!;
    const realCellsForLoaded = Array.from(stripAfter.querySelectorAll('[data-testid="heat-cell"]')).filter(
      (el) => (el as HTMLElement).title.startsWith(`${loadedKey} › `),
    );
    expect(realCellsForLoaded.length).toBe(3);
    expect(stripAfter.querySelectorAll('[data-testid="heat-cell"]').length).toBe(18);
  });
});
