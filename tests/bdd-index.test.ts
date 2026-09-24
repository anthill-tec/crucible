// CR-CRU-145 §S2 — the BDD tab is an INDEX of the project's BDD-bearing
// runs, honouring the hierarchy it sits in (cycle → agent-run → detail).
//
// MEASURED ON THIS BRANCH (158ec48): `BddPanel`/`BddFeed` (public/app.js
// ~L3040-3117) render the LATEST BDD run's Gherkin inline and nothing else
// — no list, no "which run", no cycle. There is no `[data-testid=
// "bdd-index-row"]` anywhere. Every test below is RED until GREEN replaces
// the BDD pane's content with an index.
//
// HARNESS — the same house idiom as tests/bdd-section.test.ts (real VanJS/
// VanX, real public/app-logic.mjs + public/app.js, scripted fetch) combined
// with tests/cycle-run-navigation.test.ts's plan/cycle fixture (for the
// "cycle → linked runs → detail" AC, which needs a REAL declared cycle to
// drive through the Workflow tab's own existing chain).
//
// TESTIDS DECLARED HERE FOR GREEN (the AC does not name them — smallest
// reading, same precedent as tests/bdd-section.test.ts's declared choices):
//   [data-testid="bdd-index-row"]    — one per BDD-bearing run
//     [data-testid="bdd-index-when"]    — relative-time text
//     [data-testid="bdd-index-who"]     — the filing agentId
//     [data-testid="bdd-index-cycle"]   — the cycle label, or the literal
//                                          word "unbound" when the run
//                                          carries no cycleId
//     [data-testid="bdd-index-verdict"] — the verdict + scenario counts
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

/** CR-CRU-097 AC1's two rules, restated here as tests/bdd-section.test.ts
 *  and tests/project-namespace-tripwire.test.ts already do. */
const ANY_PROJECT_CR = /CR-[A-Z]{2,}-\d+/;
const RELEASE_VERSION = /\b\d+\.\d+(?:\.\d+)?\b/;

interface EventFixture {
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
  context?: { cycleId?: number; cycle?: string };
}

interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  merge?: { commit: string };
  cycles: CycleFixture[];
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
  projects: ProjectFixture[];
  events: EventFixture[];
  plans?: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans ?? [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/(releases|release-proposals|queue)/.test(url)) {
      body = { ok: true, releases: [], proposals: [], totalCount: 0, entries: [] };
    } else if (url.includes("/api/v2/events?") || url.endsWith("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (/\/api\/v2\/events\/[^/?]+/.test(url)) {
      const id = decodeURIComponent(/\/api\/v2\/events\/([^/?]+)/.exec(url)![1]!);
      const brief = opts.events.find((e) => e.id === id);
      if (brief === undefined) {
        body = { ok: false, error: "no such event" };
      } else {
        const parsed = new URL(url, "http://localhost");
        const depth = parsed.searchParams.get("depth");
        const tree =
          depth === "suites"
            ? [{ name: "a scenario", status: brief.failed > 0 ? "fail" : "pass", counts: { passed: brief.passed, failed: brief.failed, pending: brief.pending } }]
            : [];
        body = {
          ok: true,
          event: {
            id: brief.id,
            projectKey: brief.projectKey,
            agentId: brief.agentId,
            kind: brief.kind,
            tier: brief.tier,
            codec: brief.codec,
            timestamp: brief.timestamp,
            context: brief.context,
            summary: { total: brief.total, passed: brief.passed, failed: brief.failed, pending: brief.pending, duration_ms: 10 },
            tree,
          },
        };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`bdd-index.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?bddIndex=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return { name: overrides.key, type: "frontend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now, ...overrides };
}

function playwrightRun(overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "agentId" | "timestamp">): EventFixture {
  return { kind: "test", tier: "e2e", codec: "playwright", total: 59, passed: 58, failed: 1, pending: 0, ...overrides };
}

async function clickTab(name: string): Promise<HTMLElement> {
  const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
    (t) => (t.textContent ?? "").trim() === name,
  );
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  return tab!;
}

async function openBddTab(): Promise<void> {
  await clickTab("BDD");
}

function bddPane(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]');
  if (el === null) throw new Error('no [data-testid="workspace-bdd"] mounted on the BDD tab');
  return el;
}

function indexRows(): HTMLElement[] {
  return Array.from(bddPane().querySelectorAll<HTMLElement>('[data-testid="bdd-index-row"]'));
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

describe("CR-CRU-145 §S2 — the BDD tab lists the project's BDD-bearing runs, newest first", () => {
  test("lists ONLY playwright-coded runs (junit excluded), newest first, each row naming when/who/cycle/verdict", async () => {
    const key = "proj-bdd-index";
    const now = Date.now();
    const older = playwrightRun({ id: "evt-idx-older", projectKey: key, agentId: "idx-runner-older", timestamp: now - 6 * 3600_000, context: { cycleId: 301, cycle: "the older fix" } });
    const newer = playwrightRun({ id: "evt-idx-newer", projectKey: key, agentId: "idx-runner-newer", timestamp: now - 3600_000, total: 12, passed: 12, failed: 0, context: { cycleId: 302, cycle: "the newer fix" } });
    const unrelatedJunit: EventFixture = { id: "evt-idx-junit", projectKey: key, agentId: "idx-junit-agent", kind: "test", tier: "unit", codec: "junit", timestamp: now - 1_000, total: 4, passed: 4, failed: 0, pending: 0 };

    await mountApp({ projects: [project({ key })], events: [older, newer, unrelatedJunit], pathname: `/p/${key}` });
    await openBddTab();

    const rows = indexRows();
    // BOUND — the junit run never appears: this is a BDD index, not a
    // general run list.
    expect(rows.length).toBe(2);

    // POSITIVE — newest first.
    expect(rows[0]!.getAttribute("data-run-id") ?? "").toBe("evt-idx-newer");
    expect(rows[1]!.getAttribute("data-run-id") ?? "").toBe("evt-idx-older");

    const newerRow = rows[0]!;
    expect(norm(newerRow.querySelector('[data-testid="bdd-index-who"]')?.textContent)).toContain("idx-runner-newer");
    expect(norm(newerRow.querySelector('[data-testid="bdd-index-cycle"]')?.textContent)).toContain("the newer fix");
    const verdict = norm(newerRow.querySelector('[data-testid="bdd-index-verdict"]')?.textContent);
    expect(verdict).toContain("12");
    const whenText = norm(newerRow.querySelector('[data-testid="bdd-index-when"]')?.textContent);
    expect(whenText.length).toBeGreaterThan(0);
    expect(whenText).not.toMatch(/^\d+$/); // a relative-time idiom, not a raw epoch
  });

  test("a run with no cycleId is listed AS UNBOUND — never hidden, never attributed to a cycle it does not carry", async () => {
    const key = "proj-bdd-index-unbound";
    const now = Date.now();
    const unbound = playwrightRun({ id: "evt-idx-unbound", projectKey: key, agentId: "idx-gate-agent", timestamp: now });
    await mountApp({ projects: [project({ key })], events: [unbound], pathname: `/p/${key}` });
    await openBddTab();

    const rows = indexRows();
    expect(rows.length).toBe(1);
    expect(norm(rows[0]!.querySelector('[data-testid="bdd-index-cycle"]')?.textContent)).toBe("unbound");
  });
});

describe("CR-CRU-145 §S2 — a row opens the SAME /p/<key>/run/<id> route the Runs pane and the Workflow chain use", () => {
  test("clicking an index row navigates to /p/<key>/run/<id> and opens the run overlay for THAT run", async () => {
    const key = "proj-bdd-index-route";
    const run = playwrightRun({ id: "evt-idx-route", projectKey: key, agentId: "idx-route-agent", timestamp: Date.now() });
    await mountApp({ projects: [project({ key })], events: [run], pathname: `/p/${key}` });
    await openBddTab();

    indexRows()[0]!.click();
    await settle();

    // POSITIVE — asserted on the ROUTE itself (CR-CRU-016 §S3's shared
    // route), not merely on "something opened".
    expect(location.pathname).toBe(`/p/${key}/run/evt-idx-route`);
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
  });
});

describe("CR-CRU-145 §S2 — cycle → linked runs → detail lands the SAME rendering as the index does", () => {
  test("opening the run through its declared cycle's linked-run row (the Workflow chain) and opening it through the BDD index both land on the identical route + identical run-overlay content", async () => {
    const key = "proj-bdd-index-cycle-chain";
    const now = Date.now();
    const cycleId = 8801;
    const run = playwrightRun({ id: "evt-idx-cycle-chain", projectKey: key, agentId: "idx-chain-agent", timestamp: now, context: { cycleId, cycle: "the chained fix" } });
    const plan: PlanFixture = {
      planId: 9101,
      cr: "the chained fix plan",
      projectKey: key,
      status: "closed",
      merge: { commit: "abc1234" },
      cycles: [{ id: cycleId, label: "the chained fix", status: "done" }],
    };

    await mountApp({ projects: [project({ key })], events: [run], plans: [plan], pathname: `/p/${key}` });

    // Path A — the EXISTING cycle → linked-runs → detail chain (Workflow
    // tab, CR-CRU-020's history drill-down, left alone by this CR).
    await clickTab("Workflow");
    const history = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
    expect(history).not.toBeNull();
    const crGroup = Array.from(history!.querySelectorAll<HTMLElement>('[data-testid="cr-group"]')).find(
      (g) => g.getAttribute("data-cr") === "the chained fix plan",
    );
    expect(crGroup).toBeDefined();
    crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();
    const cycleRow = crGroup!.querySelector<HTMLElement>('[data-testid="lens-cycle-row"][data-status="done"]');
    expect(cycleRow).not.toBeNull();
    cycleRow!.querySelector<HTMLElement>('[data-testid="cycle-toggle"]')!.click();
    await settle();
    const linkedRow = cycleRow!.querySelector<HTMLElement>('[data-testid="linked-run-row"]');
    expect(linkedRow).not.toBeNull();
    linkedRow!.click();
    await settle();

    const routeViaChain = location.pathname;
    const overlayViaChain = document.querySelector('[data-testid="run-overlay"]');
    expect(overlayViaChain).not.toBeNull();
    // POSITIVE — the SAME progressive-specification rendering §S1 defines:
    // the run's ONE scenario shows its steps without a click (this is what
    // makes "lands the same rendering" a real, falsifiable claim rather
    // than "some overlay opened").
    expect(overlayViaChain!.querySelectorAll('[data-testid="suite-row"] [data-testid="tree-toggle"]').length).toBeGreaterThan(0);
    const toggleGlyphViaChain = overlayViaChain!.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim();

    // Path B — the BDD index, direct entry.
    await clickTab("BDD");
    const row = document.querySelector<HTMLElement>('[data-testid="bdd-index-row"]');
    expect(row).not.toBeNull();
    row!.click();
    await settle();

    const routeViaIndex = location.pathname;
    const overlayViaIndex = document.querySelector('[data-testid="run-overlay"]');
    expect(overlayViaIndex).not.toBeNull();
    const toggleGlyphViaIndex = overlayViaIndex!.querySelector('[data-testid="tree-toggle"]')?.textContent?.trim();

    // POSITIVE — identical route, identical rendering, for the SAME run.
    expect(routeViaIndex).toBe(routeViaChain);
    expect(toggleGlyphViaIndex).toBe(toggleGlyphViaChain);
    expect(toggleGlyphViaIndex).toBe("▾"); // the scenario is expanded, not "▸"
  });
});

describe("CR-CRU-145 §S2 — the empty state still names no CR id and no release version (CR-CRU-097)", () => {
  test("a project with no BDD-bearing run shows the CR-CRU-078 empty state, naming neither a CR id nor a release version", async () => {
    const key = "proj-bdd-index-empty";
    const junitOnly: EventFixture = { id: "evt-idx-empty-junit", projectKey: key, agentId: "idx-empty-agent", kind: "test", tier: "unit", codec: "junit", timestamp: Date.now(), total: 1, passed: 1, failed: 0, pending: 0 };
    await mountApp({ projects: [project({ key })], events: [junitOnly], pathname: `/p/${key}` });
    await openBddTab();

    expect(indexRows().length).toBe(0);
    const empty = bddPane().querySelector('[data-testid="pane-scroll"] .app-empty');
    expect(empty).not.toBeNull();
    const text = norm(empty!.textContent);
    expect(text.length).toBeGreaterThan(20);
    expect(text.toLowerCase()).toContain("run");
    expect(text).not.toMatch(ANY_PROJECT_CR);
    expect(text).not.toMatch(RELEASE_VERSION);
  });
});
