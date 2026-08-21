// CR-CRU-014 §S3 — the Roadmap GRAPH VIEW (Cytoscape). This is the graph half
// of the exclusive table|graph toggle whose TABLE half already ships on this
// branch (tests/roadmap-pane.test.ts). Three contracts are pinned here:
//
//   1. The two vendored Cytoscape UMD files exist under public/ at the pinned
//      versions (Cytoscape.js 3.34.1 + cytoscape-dagre 4.0.0). Presence + an
//      identifying/version string, never byte size.
//   2. A PURE, browser-free graph-data builder — buildRoadmapGraph(entries,
//      releases) → {nodes, edges} — exported from public/app-logic.mjs (the
//      ES-module home of the SPA's pure logic, alongside workspaceTabs et al.).
//      One CR = one rectangle (type "cr") node; each dependsOn = one directed
//      edge (prereq → dependant); a release boundary = one diamond (type
//      "milestone") node; Start/End ellipse (type "terminal") nodes bracket
//      the DAG. wave/track/status ride node DATA fields (style-driving), never
//      the label text.
//   3. The EXCLUSIVE toggle: table is the default; switching to graph removes
//      the table rows from the DOM and mounts the graph container, and back —
//      exactly ONE view is present at a time.
//
// RED phase — expected to FAIL against CURRENT production:
//   • public/cytoscape.umd.js + public/cytoscape-dagre.js are ABSENT.
//   • public/app-logic.mjs exports no `buildRoadmapGraph` (call is
//     "not a function").
//   • public/app.js RoadmapPanel renders the table only — there is no
//     `roadmap-view-graph`/`roadmap-view-table` toggle and no `roadmap-graph`
//     container, so every toggle assertion fails at its first query.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { existsSync, readFileSync } from "node:fs";
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

// ── §S3 graph-data builder types + boundary ────────────────────────────────
interface GraphNode {
  data: {
    id: string;
    type: "cr" | "terminal" | "milestone";
    label?: string;
    cr?: string;
    wave?: string;
    track?: string;
    status?: string;
    terminal?: "start" | "end";
    version?: string;
  };
}
interface GraphEdge {
  data: { id: string; source: string; target: string };
}
interface RoadmapGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
interface BuilderEntry {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED";
  track?: string;
}
interface BuilderRelease {
  version: string;
  commit?: string;
  timestamp: number;
}
// The ambient tests/app-logic.d.ts predates this export, so cast the module to
// the builder boundary ONCE (GREEN adds both the runtime export and its
// declaration). Until then this const is `undefined` and every call below
// throws "is not a function" — the intended missing-export RED signal.
const buildRoadmapGraph = (
  AppLogic as unknown as {
    buildRoadmapGraph: (entries: BuilderEntry[], releases: BuilderRelease[]) => RoadmapGraph;
  }
).buildRoadmapGraph;

// A → (root, done) ; B depends on A (in-progress, track-2) ; C depends on A+B
// (pending, wave 6). One release boundary at 0.1.0.
const ENTRIES: BuilderEntry[] = [
  { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED" },
  {
    cr: "CR-B",
    title: "Beta",
    wave: "5",
    dependsOn: ["CR-A"],
    status: "IN_PROGRESS",
    track: "track-2",
  },
  { cr: "CR-C", title: "Gamma", wave: "6", dependsOn: ["CR-A", "CR-B"], status: "PENDING" },
];
const RELEASES: BuilderRelease[] = [{ version: "0.1.0", commit: "abc1234", timestamp: 1 }];

const crNodes = (g: RoadmapGraph): GraphNode[] => g.nodes.filter((n) => n.data.type === "cr");
const nodeById = (g: RoadmapGraph, id: string): GraphNode | undefined =>
  g.nodes.find((n) => n.data.id === id);
const terminals = (g: RoadmapGraph): GraphNode[] =>
  g.nodes.filter((n) => n.data.type === "terminal");
const hasEdge = (g: RoadmapGraph, source: string, target: string): boolean =>
  g.edges.some((e) => e.data.source === source && e.data.target === target);

// ── §S3 graph-library vendoring — the two pinned UMD files ──────────────────

describe("§S3 — Cytoscape graph libraries are vendored under public/ at pinned versions", () => {
  const CYTO = path.join(REPO_ROOT, "public/cytoscape.umd.js");
  const DAGRE = path.join(REPO_ROOT, "public/cytoscape-dagre.js");

  test("public/cytoscape.umd.js exists and is the pinned Cytoscape.js 3.34.1 UMD", () => {
    expect(existsSync(CYTO)).toBe(true);
    const src = readFileSync(CYTO, "utf8");
    // Identifying string + pinned version literal that the real UMD embeds
    // (cytoscape exposes `.version === "3.34.1"`). NOT a byte-size assertion.
    expect(src).toContain("cytoscape");
    expect(src).toContain("3.34.1");
  });

  test("public/cytoscape-dagre.js exists and is the pinned cytoscape-dagre plugin UMD", () => {
    expect(existsSync(DAGRE)).toBe(true);
    const src = readFileSync(DAGRE, "utf8");
    // The dagre-plugin UMD embeds its name banner "cytoscape-dagre" and
    // registers the "dagre" layout; the 4.0.0 dist bundles dagre v3 and does
    // NOT embed a "4.0.0" literal, so the identifier is the pinned handle.
    expect(src).toContain("cytoscape-dagre");
    expect(src).toContain("dagre");
  });
});

// ── §S3 graph-data builder — pure, browser-free {nodes, edges} ──────────────

describe("§S3 — buildRoadmapGraph maps one CR to one rectangle (action) node", () => {
  test("every queue entry becomes exactly one type:'cr' node", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    expect(crNodes(g).length).toBe(3);
    expect(crNodes(g).map((n) => n.data.id).sort()).toEqual(["CR-A", "CR-B", "CR-C"]);
    for (const n of crNodes(g)) expect(n.data.type).toBe("cr");
  });

  test("a CR node carries wave/track/status as DATA, never baked into the label", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    const a = nodeById(g, "CR-A");
    const b = nodeById(g, "CR-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // status/wave live in style-driving data fields.
    expect(a!.data.status).toBe("COMPLETED");
    expect(a!.data.wave).toBe("5");
    // label is the human title only — NOT the status/wave text.
    expect(a!.data.label).toBe("Alpha");
    expect(a!.data.label).not.toContain("COMPLETED");
    expect(a!.data.label).not.toContain("5");
    // track rides its own data field for lane styling.
    expect(b!.data.status).toBe("IN_PROGRESS");
    expect(b!.data.track).toBe("track-2");
    expect(b!.data.label).toBe("Beta");
  });

  test("a CR with no title falls back to its CR id as the label", () => {
    const g = buildRoadmapGraph(
      [{ cr: "CR-Z", wave: "5", dependsOn: [], status: "PENDING" }],
      [],
    );
    expect(nodeById(g, "CR-Z")!.data.label).toBe("CR-Z");
  });
});

describe("§S3 — buildRoadmapGraph maps each dependsOn to one directed edge", () => {
  test("exactly one edge per dependsOn, directed prereq → dependant", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    const crIds = new Set(crNodes(g).map((n) => n.data.id));
    const depEdges = g.edges.filter((e) => crIds.has(e.data.source) && crIds.has(e.data.target));
    // B←A (1) + C←{A,B} (2) = 3 dependency edges.
    expect(depEdges.length).toBe(3);
    // Direction: the prerequisite is the SOURCE (execution flows deps-first).
    expect(hasEdge(g, "CR-A", "CR-B")).toBe(true);
    expect(hasEdge(g, "CR-A", "CR-C")).toBe(true);
    expect(hasEdge(g, "CR-B", "CR-C")).toBe(true);
  });

  test("dependency edges are NOT reversed (dependant → prereq is absent)", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    expect(hasEdge(g, "CR-B", "CR-A")).toBe(false);
    expect(hasEdge(g, "CR-C", "CR-A")).toBe(false);
    expect(hasEdge(g, "CR-C", "CR-B")).toBe(false);
  });
});

describe("§S3 — buildRoadmapGraph brackets the DAG with Start/End terminals and release milestones", () => {
  test("exactly one Start and one End ellipse terminal node exist", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    const t = terminals(g);
    expect(t.length).toBe(2);
    expect(t.filter((n) => n.data.terminal === "start").length).toBe(1);
    expect(t.filter((n) => n.data.terminal === "end").length).toBe(1);
  });

  test("Start feeds every root CR; every sink CR feeds End", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    const startId = terminals(g).find((n) => n.data.terminal === "start")!.data.id;
    const endId = terminals(g).find((n) => n.data.terminal === "end")!.data.id;
    // CR-A is the only root (empty dependsOn); CR-C is the only sink.
    expect(hasEdge(g, startId, "CR-A")).toBe(true);
    expect(hasEdge(g, startId, "CR-B")).toBe(false);
    expect(hasEdge(g, "CR-C", endId)).toBe(true);
    expect(hasEdge(g, "CR-A", endId)).toBe(false);
  });

  test("each release boundary becomes exactly one type:'milestone' (diamond) node", () => {
    const g = buildRoadmapGraph(ENTRIES, RELEASES);
    const milestones = g.nodes.filter((n) => n.data.type === "milestone");
    expect(milestones.length).toBe(1);
    expect(milestones[0].data.version).toBe("0.1.0");
    expect(milestones[0].data.label).toBe("0.1.0");
  });
});

// ── §S3 exclusive table|graph toggle — real app.js in happy-dom ─────────────

interface QueueEntryFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED";
  planId?: number;
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestCoverageEventId?: string;
}
interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  queue: QueueEntryFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/queue/.test(url)) {
      body = { ok: true, entries: opts.queue };
    } else if (/\/api\/v2\/projects\/[^/]+\/releases/.test(url)) {
      body = { ok: true, releases: [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`roadmap-graph.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  // Runtime-selected specifier (cache-bust query) — each mount re-evals the
  // real app.js and needs a FRESH app-logic module instance, so this import
  // MUST stay dynamic; a static import would resolve once and share state.
  await import(`${APP_LOGIC_PATH}?roadmapGraph=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

// Real-timer settle (not fake timers): this drives the REAL van.js reactive
// runtime inside happy-dom, whose derived-DOM flush is scheduled on the real
// microtask/timer loop — vi.useFakeTimers() would freeze van's own scheduler
// and the DOM would never paint. Mirrors tests/roadmap-pane.test.ts.
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

const rowCount = (): number => document.querySelectorAll('[data-testid="roadmap-row"]').length;
const graphCount = (): number => document.querySelectorAll('[data-testid="roadmap-graph"]').length;

const TOGGLE_QUEUE: QueueEntryFixture[] = [
  { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED" },
  { cr: "CR-B", title: "Beta", wave: "5", dependsOn: ["CR-A"], status: "IN_PROGRESS" },
];

function mountToggle(): Promise<void> {
  return mountApp({
    pathname: "/p/toggle-key/roadmap",
    projects: [project({ key: "toggle-key" })],
    queue: TOGGLE_QUEUE,
  });
}

describe("§S3 — the roadmap view is an EXCLUSIVE table|graph toggle (table default)", () => {
  test("cold /p/<key>/roadmap load offers the table|graph toggle and defaults to the TABLE view", async () => {
    await mountToggle();
    // The segmented view control is present in BOTH view states so either
    // view is one click away — both options exist on the default load.
    expect(document.querySelector('[data-testid="roadmap-view-table"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="roadmap-view-graph"]')).not.toBeNull();
    // Default arm: the table is rendered, the graph container is not.
    expect(rowCount()).toBeGreaterThan(0);
    expect(graphCount()).toBe(0);
  });

  test("switching to graph REMOVES the table rows and mounts exactly one graph container", async () => {
    await mountToggle();
    const toGraph = document.querySelector<HTMLElement>('[data-testid="roadmap-view-graph"]');
    expect(toGraph).not.toBeNull();
    toGraph!.click();
    await settle();
    // Exactly one view: graph container up, table rows gone.
    expect(graphCount()).toBe(1);
    expect(rowCount()).toBe(0);
  });

  test("switching back to table REMOVES the graph container and restores the rows", async () => {
    await mountToggle();
    document.querySelector<HTMLElement>('[data-testid="roadmap-view-graph"]')!.click();
    await settle();
    const toTable = document.querySelector<HTMLElement>('[data-testid="roadmap-view-table"]');
    expect(toTable).not.toBeNull();
    toTable!.click();
    await settle();
    expect(rowCount()).toBeGreaterThan(0);
    expect(graphCount()).toBe(0);
  });
});
