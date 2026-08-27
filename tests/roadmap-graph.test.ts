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
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
  track?: string;
}
interface BuilderRelease {
  version: string;
  commit?: string;
  timestamp: number;
  // CR-CRU-077 §S1 — the release-gating inputs CR-080/084 added to the live
  // payload: `releasedAt` is the tag's OWN commit date (epoch SECONDS) and is
  // ship order; `crs` is membership; `packages` is what the tag delivered.
  // All optional because the live ledger OMITS `crs` entirely for a release
  // that shipped none (measured on 0.1.1, 2026-08-27).
  releasedAt?: number;
  crs?: string[];
  packages?: { registry: string; name: string; version: string }[];
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

// ── CR-CRU-083 AC7 — the fourth derived status reaches the GRAPH consumer ───

describe("CR-CRU-083 AC7 — buildRoadmapGraph carries COMPLETED_UNTRACKED through verbatim", () => {
  test("an untracked-completion entry keeps its wire status on data.status (never normalised to COMPLETED/PENDING) and never leaks it into the label", () => {
    const g = buildRoadmapGraph(
      [
        { cr: "CR-U", title: "Untracked", wave: "5", dependsOn: [], status: "COMPLETED_UNTRACKED" },
        { cr: "CR-T", title: "Tracked", wave: "5", dependsOn: ["CR-U"], status: "COMPLETED" },
      ],
      [],
    );
    const untracked = nodeById(g, "CR-U");
    expect(untracked).toBeDefined();
    // The style-driving data field is the wire value itself — the stylesheet
    // selects on it, so any normalisation silently restyles it as COMPLETED.
    expect(untracked!.data.status).toBe("COMPLETED_UNTRACKED");
    expect(untracked!.data.label).toBe("Untracked");
    expect(untracked!.data.label).not.toContain("COMPLETED");
    // The tracked sibling is untouched — the two remain distinct in the graph.
    expect(nodeById(g, "CR-T")!.data.status).toBe("COMPLETED");
  });
});

// ── CR-CRU-077 §S1 — release gating: the diamond sits IN the flow ───────────
//
// Spec: docs/changes/CR-CRU-077-roadmap-graph-is-the-execution-dag.md §S1,
// AC1 / AC1b / AC1c. Design authority: docs/research/DN-crucible-roadmap-view.md
// decision 3 ("Release boundaries gate the flow. Work after a release boundary
// does not start before it; the boundary sits *in* the flow, never beside it")
// and decision 5 ("No synthetic ordering edges … nothing invents an edge to
// express sequence").
//
// THE DEFECT UNDER TEST, verified in public/app-logic.mjs:840-845: milestone
// nodes are pushed as nodes and never referenced by any edge, so every release
// diamond floats BESIDE the DAG. Edges come from `dependsOn` plus the
// Start/End brackets alone, so a release — the hardest ordering constraint in
// the project — is currently decorative.
//
// FIXTURE PROVENANCE — pure builder, no server, no network, no git at test time:
//   • ENTRIES are PARSED from the checked-in `docs/changes/README.md` queue
//     table (88 rows as of 2026-08-27). That table is the authored queue which
//     `queue register` ingests, so it IS the real shape, and parsing keeps the
//     size unpinned — AC9 deliberately refuses a hard-coded count. Every
//     `Depends on` cell resolves inside the table, which is `unknownDependencies`
//     empty (asserted below, so a README edit that breaks the shape is loud).
//   • RELEASES are a LITERAL fixture captured verbatim from
//     `GET /api/v2/projects/<key>/releases` on 2026-08-27. The release ledger
//     has NO checked-in source — the tracked `crucible.db` is an empty
//     placeholder and there is no changelog — so the measured payload is pinned
//     as data rather than fetched, keeping the builder contract deterministic
//     and offline. It is kept NEWEST-FIRST exactly as the live payload arrives:
//     ship order is the builder's job to derive from `releasedAt`, never the
//     array order's.

const crIdList = (numbers: string): string[] =>
  numbers.split(/\s+/).filter(Boolean).map((n) => `CR-CRU-${n}`);

/** The two published artefacts, as the live `packages` array carries them. */
const relPackages = (version: string, ...registries: string[]) =>
  registries.map((registry) => ({
    registry,
    name: registry === "pypi" ? "crucible-axi" : "@anthill-tec/crucible-server",
    version,
  }));

// Verbatim live ledger, newest-first. `releasedAt` is epoch SECONDS (the tag's
// own commit date); `timestamp` is the ingest instant in ms and is NOT ship
// order — CR-077's gap analysis F2 measured that using it attributes the whole
// backlog to 0.1.0.
const REAL_RELEASES: BuilderRelease[] = [
  {
    version: "0.1.3",
    commit: "74088863dfb250dfb8d75917b79ec4e29de8b685",
    releasedAt: 1787819729,
    crs: ["CR-CRU-090"],
    packages: relPackages("0.1.3", "pypi", "npm"),
    timestamp: 1787830734630,
  },
  {
    version: "0.1.2",
    commit: "9ef24b1867ab33f34c66c7acf4633fb3995bf339",
    releasedAt: 1787181002,
    crs: ["CR-CRU-066"],
    packages: relPackages("0.1.2", "pypi", "npm"),
    timestamp: 1787325487922,
  },
  {
    // AC1's measured zero-CR release. The live payload OMITS `crs` altogether
    // rather than sending `[]`, and CR-084's `packages` still carries 2
    // entries — so "shipped no CRs" is distinguishable from "delivered
    // nothing", and the builder must treat a MISSING `crs` as empty membership
    // rather than as unknown.
    version: "0.1.1",
    commit: "abc30d5732e71ed11f8d0b81d6248f95b68b2b12",
    releasedAt: 1787151205,
    packages: relPackages("0.1.1", "pypi", "npm"),
    timestamp: 1787325487410,
  },
  {
    version: "0.1.0",
    commit: "c07274c853088fb9b6c40e3c05b1e763b1d29e78",
    releasedAt: 1787149125,
    crs: crIdList(`
      001 002 003 004 005 006 007 008 009 010 011 012 013 016 019 020 021 023 024 025 026
      027 028 029 030 031 032 033 034 035 036 037 038 039 040 041 042 043 044 045 046 047
      048 049 050 051 052 053 054 055 056 057 058 059 060 061 062 063 064 065
    `),
    packages: relPackages("0.1.0", "pypi"),
    timestamp: 1787325487188,
  },
];

/**
 * The authored queue, read off the checked-in CR-queue table. One row is
 * `| [CR-NNN](file) | title | type | status | depends-on | wave |`.
 *
 * `status` keeps the leading token only — the table annotates it with a target
 * release (`COMPLETED (0.2.0)`), which is prose, not a status. `VOID` is mapped
 * to `PENDING` because that is what the live board reports for the one VOID row
 * (CR-CRU-082, measured 2026-08-27); nothing here depends on that row.
 */
function parseQueueTable(src: string): BuilderEntry[] {
  const entries: BuilderEntry[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("| [CR-")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const cr = /CR-[A-Z]+-\d{3}/.exec(cells[0])?.[0];
    if (cr === undefined) continue;
    const statusToken = /^[A-Z_]+/.exec(cells[3])?.[0];
    entries.push({
      cr,
      title: cells[1],
      wave: /^\d+/.exec(cells[5])?.[0] ?? cells[5],
      dependsOn: (cells[4].match(/\d{3}/g) ?? []).map((n) => `CR-CRU-${n}`),
      status: statusToken === "COMPLETED" ? "COMPLETED" : "PENDING",
    });
  }
  return entries;
}

const REAL_ENTRIES: BuilderEntry[] = parseQueueTable(
  readFileSync(path.join(REPO_ROOT, "docs/changes/README.md"), "utf8"),
);

const milestoneNodes = (g: RoadmapGraph): GraphNode[] =>
  g.nodes.filter((n) => n.data.type === "milestone");
const milestoneFor = (g: RoadmapGraph, version: string): GraphNode | undefined =>
  milestoneNodes(g).find((n) => n.data.version === version);
const edgesInto = (g: RoadmapGraph, id: string): GraphEdge[] =>
  g.edges.filter((e) => e.data.target === id);
const edgesOutOf = (g: RoadmapGraph, id: string): GraphEdge[] =>
  g.edges.filter((e) => e.data.source === id);

/** Directed reachability — "flows into" is a PATH, not necessarily one edge. */
function reachable(g: RoadmapGraph, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const e of g.edges) {
    const bucket = outgoing.get(e.data.source);
    if (bucket === undefined) outgoing.set(e.data.source, [e.data.target]);
    else bucket.push(e.data.target);
  }
  const seen = new Set<string>([from]);
  const frontier = [from];
  while (frontier.length > 0) {
    for (const next of outgoing.get(frontier.pop()!) ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      frontier.push(next);
    }
  }
  return false;
}

/** Membership is `crs` and NOTHING else; a missing `crs` is empty membership. */
const membersOf = (rel: BuilderRelease): string[] => rel.crs ?? [];
const ALL_RELEASED = new Set(REAL_RELEASES.flatMap(membersOf));

describe("CR-CRU-077 §S1/AC1 — no release diamond is edgeless (live 4-release / 88-entry shape)", () => {
  test("the parsed queue fixture is the real shape and every declared dependency resolves (unknownDependencies empty)", () => {
    // Guard on the fixture itself, not a pinned size (AC9): if the README
    // table stops parsing, every assertion below would pass vacuously.
    expect(REAL_ENTRIES.length).toBeGreaterThan(80);
    const ids = new Set(REAL_ENTRIES.map((e) => e.cr));
    const unknownDependencies = [
      ...new Set(REAL_ENTRIES.flatMap((e) => e.dependsOn).filter((d) => !ids.has(d))),
    ].sort();
    expect(unknownDependencies).toEqual([]);
    // The named CRs the release assertions below key on are all present.
    for (const cr of ["CR-CRU-090", "CR-CRU-066", "CR-CRU-078", "CR-CRU-085"]) {
      expect(ids.has(cr)).toBe(true);
    }
    expect(REAL_RELEASES.length).toBe(4);
  });

  test("EVERY milestone node has at least one inbound AND one outbound edge — the edgeless versions are named", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(milestoneNodes(g).length).toBe(4);
    // The failure diff names the offending versions with their edge counts,
    // because "a milestone with zero edges is the defect this CR fixes".
    const edgeless = milestoneNodes(g)
      .filter(
        (m) =>
          edgesInto(g, m.data.id).length === 0 || edgesOutOf(g, m.data.id).length === 0,
      )
      .map(
        (m) =>
          `${m.data.version}: in=${edgesInto(g, m.data.id).length} out=${edgesOutOf(g, m.data.id).length}`,
      );
    expect(edgeless).toEqual([]);
  });

  test("per diamond: 0.1.0, 0.1.1, 0.1.2 and 0.1.3 each gate the flow (inbound and outbound)", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    for (const version of ["0.1.0", "0.1.1", "0.1.2", "0.1.3"]) {
      const m = milestoneFor(g, version);
      expect(m).toBeDefined();
      expect({
        version,
        inbound: edgesInto(g, m!.data.id).length > 0,
        outbound: edgesOutOf(g, m!.data.id).length > 0,
      }).toEqual({ version, inbound: true, outbound: true });
    }
  });

  test("0.1.1 shipped ZERO CRs and still chains: 0.1.0 → 0.1.1 → 0.1.2", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const zeroCr = REAL_RELEASES.find((r) => r.version === "0.1.1")!;
    // Live shape, not hypothetical: no membership, yet two delivered packages.
    expect(membersOf(zeroCr)).toEqual([]);
    expect(zeroCr.packages!.length).toBe(2);
    const prev = milestoneFor(g, "0.1.0")!;
    const zero = milestoneFor(g, "0.1.1")!;
    const next = milestoneFor(g, "0.1.2")!;
    expect(edgesInto(g, zero.data.id).length).toBeGreaterThan(0);
    expect(edgesOutOf(g, zero.data.id).length).toBeGreaterThan(0);
    expect(reachable(g, prev.data.id, zero.data.id)).toBe(true);
    expect(reachable(g, zero.data.id, next.data.id)).toBe(true);
  });

  test("the diamond chain runs in SHIP order (releasedAt), not in payload order", () => {
    // The live payload arrives newest-first, so a builder that trusts the array
    // order chains the releases backwards.
    expect(REAL_RELEASES.map((r) => r.version)).toEqual(["0.1.3", "0.1.2", "0.1.1", "0.1.0"]);
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const oldest = milestoneFor(g, "0.1.0")!;
    const newest = milestoneFor(g, "0.1.3")!;
    expect(reachable(g, oldest.data.id, newest.data.id)).toBe(true);
    expect(reachable(g, newest.data.id, oldest.data.id)).toBe(false);
  });
});

describe("CR-CRU-077 AC1b — release membership comes from `crs`, and nothing else", () => {
  test("synthetic two-release shape: each CR flows INTO its own diamond and OUT of the preceding one", () => {
    // Unambiguous by construction: one CR per release, no dependencies, so
    // only `crs` can place either CR relative to either diamond.
    const entries: BuilderEntry[] = [
      { cr: "CR-1", title: "First", wave: "1", dependsOn: [], status: "COMPLETED" },
      { cr: "CR-2", title: "Second", wave: "2", dependsOn: [], status: "COMPLETED" },
    ];
    const releases: BuilderRelease[] = [
      { version: "1.0.0", commit: "bbb", releasedAt: 2000, crs: ["CR-2"], timestamp: 20 },
      { version: "0.9.0", commit: "aaa", releasedAt: 1000, crs: ["CR-1"], timestamp: 10 },
    ];
    const g = buildRoadmapGraph(entries, releases);
    const first = milestoneFor(g, "0.9.0");
    const second = milestoneFor(g, "1.0.0");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Into its own diamond.
    expect(reachable(g, "CR-1", first!.data.id)).toBe(true);
    expect(reachable(g, "CR-2", second!.data.id)).toBe(true);
    // Out of the preceding diamond — the release gates the work that follows.
    expect(reachable(g, first!.data.id, "CR-2")).toBe(true);
    // And never the other way round: a shipped CR does not follow its own
    // diamond, and a later CR never precedes an earlier release.
    expect(reachable(g, first!.data.id, "CR-1")).toBe(false);
    expect(reachable(g, "CR-2", first!.data.id)).toBe(false);
  });

  test("real shape: CR-CRU-090 gates 0.1.3 and follows 0.1.2; CR-CRU-066 gates 0.1.2 and follows 0.1.1", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const m011 = milestoneFor(g, "0.1.1")!;
    const m012 = milestoneFor(g, "0.1.2")!;
    const m013 = milestoneFor(g, "0.1.3")!;
    // Membership is the only claim: these two ids ARE the `crs` of those tags.
    expect(membersOf(REAL_RELEASES.find((r) => r.version === "0.1.3")!)).toEqual(["CR-CRU-090"]);
    expect(membersOf(REAL_RELEASES.find((r) => r.version === "0.1.2")!)).toEqual(["CR-CRU-066"]);
    expect(reachable(g, "CR-CRU-090", m013.data.id)).toBe(true);
    expect(reachable(g, m012.data.id, "CR-CRU-090")).toBe(true);
    expect(reachable(g, "CR-CRU-066", m012.data.id)).toBe(true);
    expect(reachable(g, m011.data.id, "CR-CRU-066")).toBe(true);
  });

  test("every CR→diamond edge's source is a member of THAT release's `crs`", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const crIds = new Set(crNodes(g).map((n) => n.data.id));
    const byId = new Map(milestoneNodes(g).map((m) => [m.data.id, m.data.version!]));
    const memberships = new Map(REAL_RELEASES.map((r) => [r.version, new Set(membersOf(r))]));
    const inboundCrEdges = g.edges.filter(
      (e) => byId.has(e.data.target) && crIds.has(e.data.source),
    );
    // Non-vacuous: 0.1.3 must actually be gated by the CR it shipped.
    expect(
      inboundCrEdges.filter((e) => byId.get(e.data.target) === "0.1.3").length,
    ).toBeGreaterThan(0);
    const foreign = inboundCrEdges
      .filter((e) => !memberships.get(byId.get(e.data.target)!)!.has(e.data.source))
      .map((e) => `${e.data.source} → ${byId.get(e.data.target)}`);
    expect(foreign).toEqual([]);
  });
});

describe("CR-CRU-077 AC1c — CRs in no release flow AFTER the newest diamond", () => {
  test("named unreleased CRs (CR-CRU-078, CR-CRU-085) are downstream of 0.1.3 and upstream of no diamond", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const newest = milestoneFor(g, "0.1.3")!;
    for (const cr of ["CR-CRU-078", "CR-CRU-085"]) {
      expect(REAL_ENTRIES.find((e) => e.cr === cr)!.status).toBe("PENDING");
      expect(ALL_RELEASED.has(cr)).toBe(false);
      expect({ cr, afterNewest: reachable(g, newest.data.id, cr) }).toEqual({
        cr,
        afterNewest: true,
      });
      const gated = milestoneNodes(g)
        .filter((m) => reachable(g, cr, m.data.id))
        .map((m) => `${cr} → ${m.data.version}`);
      expect(gated).toEqual([]);
    }
  });

  test("EVERY entry absent from every `crs` sits after the newest diamond and before none", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const newest = milestoneFor(g, "0.1.3")!;
    const unreleased = REAL_ENTRIES.map((e) => e.cr).filter((cr) => !ALL_RELEASED.has(cr));
    expect(unreleased.length).toBeGreaterThan(0);
    const notDownstream = unreleased.filter((cr) => !reachable(g, newest.data.id, cr));
    expect(notDownstream).toEqual([]);
    const upstreamOfADiamond = unreleased.flatMap((cr) =>
      milestoneNodes(g).filter((m) => reachable(g, cr, m.data.id)).map((m) => `${cr} → ${m.data.version}`),
    );
    expect(upstreamOfADiamond).toEqual([]);
  });
});

describe("CR-CRU-077 §S1 — a diamond's edges are never manufactured from wave structure", () => {
  test("with NO releases there are no milestone nodes and no milestone edges at all", () => {
    // The fence against a fake fix that invents diamonds (or edges to them)
    // out of wave structure: waves 1…6 are all present in the real queue, and
    // an empty ledger must still yield a diamond-free graph.
    const g = buildRoadmapGraph(REAL_ENTRIES, []);
    expect(milestoneNodes(g)).toEqual([]);
    const milestoneish = g.edges
      .filter((e) => /milestone|release/i.test(`${e.data.id} ${e.data.source} ${e.data.target}`))
      .map((e) => e.data.id);
    expect(milestoneish).toEqual([]);
    // …and the wave labels really are varied, so the fence is not vacuous.
    expect(new Set(REAL_ENTRIES.map((e) => e.wave)).size).toBeGreaterThan(1);
  });

  test("releases with EMPTY membership gain no CR edges from shared waves, yet still chain to each other", () => {
    // Four CRs, no dependencies, two waves; two releases that shipped nothing.
    // `crs` is the only membership channel, so a wave-derived (or `wave`-field
    // derived) edge would show up here as a CR↔diamond edge.
    const entries: BuilderEntry[] = [
      { cr: "CR-W1a", title: "a", wave: "1", dependsOn: [], status: "COMPLETED" },
      { cr: "CR-W1b", title: "b", wave: "1", dependsOn: [], status: "COMPLETED" },
      { cr: "CR-W2a", title: "c", wave: "2", dependsOn: [], status: "PENDING" },
      { cr: "CR-W2b", title: "d", wave: "2", dependsOn: [], status: "PENDING" },
    ];
    const releases: BuilderRelease[] = [
      { version: "2.0.0", commit: "bbb", releasedAt: 2000, crs: [], timestamp: 20 },
      { version: "1.0.0", commit: "aaa", releasedAt: 1000, crs: [], timestamp: 10 },
    ];
    const g = buildRoadmapGraph(entries, releases);
    const diamondIds = new Set(milestoneNodes(g).map((m) => m.data.id));
    const crIds = new Set(entries.map((e) => e.cr));
    const fabricated = g.edges
      .filter(
        (e) =>
          (diamondIds.has(e.data.source) && crIds.has(e.data.target)) ||
          (crIds.has(e.data.source) && diamondIds.has(e.data.target)),
      )
      .map((e) => `${e.data.source} → ${e.data.target}`);
    expect(fabricated).toEqual([]);
    // But the boundaries themselves still sit IN the flow (DN decision 3).
    const older = milestoneFor(g, "1.0.0")!;
    const newer = milestoneFor(g, "2.0.0")!;
    expect(edgesInto(g, older.data.id).length).toBeGreaterThan(0);
    expect(edgesOutOf(g, newer.data.id).length).toBeGreaterThan(0);
    expect(reachable(g, older.data.id, newer.data.id)).toBe(true);
  });
});

// ── §S3 exclusive table|graph toggle — real app.js in happy-dom ─────────────

interface QueueEntryFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
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
  // Opt-in: also load the vendored Cytoscape UMDs so public/app.js really
  // instantiates the graph (see installCytoscape). Off for the toggle tests,
  // which only need the container's presence/absence.
  cytoscape?: boolean;
}

// A Cytoscape stylesheet rule as `cy.style().json()` returns it.
interface CyStyleRule {
  selector: string;
  style: Record<string, unknown>;
}
interface CyCollection {
  length: number;
  nonempty: () => boolean;
  emit: (event: string) => unknown;
}
interface CyHandle {
  style: () => { json: () => CyStyleRule[] };
  $id: (id: string) => CyCollection;
}

// public/app.js guards its Cytoscape mount on the plain-HTML global
// `window.cytoscape` (the vendored UMD, loaded by index.html) and publishes the
// live instance as `window.crucibleRoadmapCy`. happy-dom ships no canvas
// backend, so cytoscape's canvas renderer aborts with "Could not create canvas
// of type 2d" and never yields an instance — hence the minimal 2d-context stub.
// Test-harness only: no production seam, the stylesheet read below is the real
// one app.js hands to cytoscape.
function installCytoscape(): void {
  const ctx2d = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "canvas") return { width: 300, height: 150 };
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
        if (prop === "createLinearGradient" || prop === "createPattern") {
          return () => ({ addColorStop: () => undefined });
        }
        return () => undefined;
      },
      set: () => true,
    },
  );
  const canvasProto: { getContext: unknown } = HTMLCanvasElement.prototype;
  canvasProto.getContext = () => ctx2d;
  // cytoscape's texture cache renders into an OffscreenCanvas when the global
  // exists (happy-dom provides one whose getContext yields null).
  const offscreen: { prototype: { getContext: unknown } } | undefined =
    (globalThis as { OffscreenCanvas?: { prototype: { getContext: unknown } } }).OffscreenCanvas;
  if (offscreen !== undefined) offscreen.prototype.getContext = () => ctx2d;
  (0, eval)(readFileSync(path.join(REPO_ROOT, "public/cytoscape.umd.js"), "utf8"));
  (0, eval)(readFileSync(path.join(REPO_ROOT, "public/cytoscape-dagre.js"), "utf8"));
}

// The live instance app.js publishes on the window (public/app.js) — the DOM
// lib has no declaration for it, so the known shape is asserted once here.
function roadmapCy(): CyHandle | undefined {
  const win = window as unknown as { crucibleRoadmapCy?: CyHandle };
  return win.crucibleRoadmapCy;
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

  if (opts.cytoscape === true) installCytoscape();

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

// ── CR-CRU-083 AC7 — the graph STYLE half of the same consumer contract ─────

describe("CR-CRU-083 AC7 — the graph stylesheet styles COMPLETED_UNTRACKED distinctly", () => {
  test("the live Cytoscape stylesheet carries its own node[status=\"COMPLETED_UNTRACKED\"] rule, visually distinct from the COMPLETED rule", async () => {
    await mountApp({
      pathname: "/p/toggle-key/roadmap",
      projects: [project({ key: "toggle-key" })],
      queue: [
        { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED" },
        { cr: "CR-U", title: "Untracked", wave: "5", dependsOn: ["CR-A"], status: "COMPLETED_UNTRACKED" },
      ],
      cytoscape: true,
    });
    document.querySelector<HTMLElement>('[data-testid="roadmap-view-graph"]')!.click();
    await settle();

    const cy = roadmapCy();
    expect(cy).toBeDefined();
    const rules = cy!.style().json();
    // cytoscape re-serialises selectors with spaces around `=`.
    const norm = (selector: string): string => selector.replace(/\s+/g, "");
    const ruleFor = (status: string): CyStyleRule | undefined =>
      rules.find((r) => norm(r.selector) === `node[status="${status}"]`);

    // Guard the reader itself: the three shipped status rules are found this way.
    const completed = ruleFor("COMPLETED");
    expect(completed).toBeDefined();
    expect(ruleFor("IN_PROGRESS")).toBeDefined();
    expect(ruleFor("PENDING")).toBeDefined();

    const untracked = ruleFor("COMPLETED_UNTRACKED");
    expect(untracked).toBeDefined();
    // Distinct STYLE, not merely a distinct selector — an untracked node must
    // not read as a fully tracked completion.
    expect(JSON.stringify(untracked!.style)).not.toBe(JSON.stringify(completed!.style));
  });
});

// ── CR-CRU-083 AC7 — the graph TAP half of the same consumer contract ───────
//
// The table row is already status-gated (public/app.js:2391 — swap only for
// IN_PROGRESS or COMPLETED, everything else inert). The graph node's tap
// handler (public/app.js:2579-2581) is status-BLIND: `cy.on("tap","node",…)`
// swaps to Workflow for every node, so tapping a COMPLETED_UNTRACKED (or
// PENDING) node lands the user on a Workflow tab with nothing to show, while
// the row for the SAME cr does nothing. AC7 forbids exactly that: no consumer
// of derived status may fall through to a default. The two surfaces must agree.
//
// Driven through the live cytoscape instance the real app.js published —
// `cy.$id(<cr>).emit("tap")` is cytoscape's own event dispatch, so the
// delegated `("tap","node")` handler is reached the way a real pointer tap
// reaches it. Nothing calls the handler directly (that would bypass the gate
// under test).

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find(
    (el) => (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

function tabIsOn(name: string): boolean {
  const tab = findByText(document, '[data-testid="workspace-tab"]', name);
  return tab !== undefined && tab.classList.contains("on");
}

describe("CR-CRU-083 AC7 — tapping a graph node is status-gated exactly like the table row", () => {
  test("tapping a COMPLETED_UNTRACKED node (and a PENDING one) does NOT swap to Workflow; tapping a COMPLETED node does", async () => {
    await mountApp({
      pathname: "/p/toggle-key/roadmap",
      projects: [project({ key: "toggle-key" })],
      queue: [
        { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED" },
        {
          cr: "CR-U",
          title: "Untracked",
          wave: "5",
          dependsOn: ["CR-A"],
          status: "COMPLETED_UNTRACKED",
        },
        { cr: "CR-P", title: "Pending", wave: "6", dependsOn: ["CR-A"], status: "PENDING" },
      ],
      cytoscape: true,
    });
    document.querySelector<HTMLElement>('[data-testid="roadmap-view-graph"]')!.click();
    await settle();

    const cy = roadmapCy();
    expect(cy).toBeDefined();
    // GUARD — the three nodes really are in the live graph, so an "inert"
    // verdict below cannot come from tapping nothing at all.
    expect(cy!.$id("CR-A").nonempty()).toBe(true);
    expect(cy!.$id("CR-U").nonempty()).toBe(true);
    expect(cy!.$id("CR-P").nonempty()).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    // COMPLETED_UNTRACKED — there is no plan to land on, so the tap is inert.
    cy!.$id("CR-U").emit("tap");
    await settle();
    expect(tabIsOn("Workflow")).toBe(false);
    expect(tabIsOn("Roadmap")).toBe(true);

    // PENDING — inert for the same reason (the row already is).
    cy!.$id("CR-P").emit("tap");
    await settle();
    expect(tabIsOn("Workflow")).toBe(false);
    expect(tabIsOn("Roadmap")).toBe(true);

    // COMPLETED — DOES land on Workflow: gating is a distinction, not a dead
    // surface. Last, because the swap unmounts the graph.
    cy!.$id("CR-A").emit("tap");
    await settle();
    expect(tabIsOn("Workflow")).toBe(true);
  });
});
