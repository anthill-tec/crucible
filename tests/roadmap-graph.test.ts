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
//   3. CR-CRU-078 §S1/AC1 — the toggle is RETIRED: the graph renders
//      UNCONDITIONALLY, beside the table, with no view state to select one.
//
// RED phase — expected to FAIL against CURRENT production:
//   • public/cytoscape.umd.js + public/cytoscape-dagre.js are ABSENT.
//   • public/app-logic.mjs exports no `buildRoadmapGraph` (call is
//     "not a function").
//   • public/app.js RoadmapPanel renders the table only — there is no
//     `roadmap-graph` container at all, so every graph assertion below fails
//     at its first query.
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
    // CR-CRU-077 §S1/AC2 — the orchestrator-assigned queue position, carried
    // as node DATA a layout can rank on. NOT an edge (DN decision 5).
    seq?: number;
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
  // CR-CRU-091 §S2/AC18 — the STORED queue position `listQueue` publishes on
  // EVERY entry. Optional here only so the fixtures that assert nothing about
  // ordering stay untouched; the live read always carries it.
  seq?: number;
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
    // CR-CRU-077 §S4/AC6 — the label is the CR id plus a terse status suffix,
    // and NEVER the human title; the raw status and the wave stay out of the
    // text entirely (they ride data.status / data.wave for the stylesheet).
    expect(a!.data.label).toBe("CR-A ✓ merged");
    expect(a!.data.label).not.toContain("COMPLETED");
    expect(a!.data.label).not.toContain("5");
    // track rides its own data field for lane styling.
    expect(b!.data.status).toBe("IN_PROGRESS");
    expect(b!.data.track).toBe("track-2");
    expect(b!.data.label).toBe("CR-B ▶");
  });

  // "Falls back to" was CR-014 semantics, when a title WOULD have been the
  // label. CR-CRU-077 §S4/AC6 made the label the id regardless, so what a
  // missing title has to be is a non-event: no placeholder, no "(untitled)",
  // and no throw.
  test("a CR with NO title still labels as its bare id — a missing title adds no placeholder", () => {
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
    // CR-CRU-077 §S4/AC6 — id + suffix, and the untracked suffix is its own.
    expect(untracked!.data.label).toBe("CR-U ✓ untracked");
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
 *
 * CR-CRU-091 §S2/AC18 — each row also carries the STORED `seq` the live read
 * publishes on every entry, since that is now what the builder consumes. The
 * value is the row's authored POSITION on a 10-stride, not its array index:
 * stored `seq` is stamped per (release, wave) block by `wave-sequence`, so it
 * is never globally the index, and a stride keeps every ordering assertion
 * below able to tell a consumed `seq` from a re-derived one.
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
      seq: entries.length * 10,
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

// ── CR-CRU-077 §S1 — ORDERING: AC2 (authored queue sequence), AC3 (parallel
//    branches, never a chain), AC8 (no edge derived from wave structure) ─────
//
// THE TENSION, resolved before a line was asserted. AC2 requires the
// orchestrator-assigned queue sequence to be HONOURED for two CRs with no
// dependency between them; DN decision 5 forbids inventing any edge to express
// sequence; AC3 requires those same two CRs to remain PARALLEL BRANCHES. Read
// "honoured" as "drawn", and AC2 contradicts both decision 5 and AC3.
//
// It is not a contradiction, because decision 5 already names the resolution:
// "Order comes from `depends-on` plus the orchestrator-assigned queue
// sequence". The queue sequence is INPUT DATA, not something the graph
// derives. So the builder owes exactly two things, and neither is an edge:
//
//   1. CARRY the authored position onto each CR node as data (`data.seq`, a
//      monotonic numeric field) so a layout can RANK on it — dagre orders
//      same-rank siblings by a tie-break it is given, so a carried sequence is
//      honourable without a single edge.
//   2. NEVER SUBSTITUTE an order of its own — not the CR id, not the wave, not
//      the status. Re-author the queue and the carried order must follow the
//      re-authoring, exactly and only.
//
// Why the alternatives fail:
//   • An explicitly-typed non-dependency "order" edge (`seq:<a>-><b>`) fails
//     TWICE: decision 5 forbids inventing an edge to express sequence at all,
//     whatever it is typed, and an edge a→b makes b reachable from a, which is
//     the CHAIN that AC3 explicitly rules out.
//   • Node EMISSION order alone is too weak to be the carrier: it is implicit,
//     it says nothing once the nodes array is filtered or interleaved with
//     diamonds and terminals (which it already is), and no layout contract
//     promises to read it. It is asserted below as a corroborating property,
//     never as the load-bearing one.
//
// So AC2 is satisfied by node data, AC3 by the continued ABSENCE of an edge,
// and decision 5 by both. All three hold simultaneously; nothing is traded.

/** CR nodes in EMISSION order — the order the builder pushed them. */
const crOrder = (g: RoadmapGraph): string[] => crNodes(g).map((n) => n.data.id);

/** CR nodes lacking a numeric carried position, by id. */
const missingSeq = (g: RoadmapGraph): string[] =>
  crNodes(g)
    .filter((n) => typeof n.data.seq !== "number" || !Number.isFinite(n.data.seq))
    .map((n) => n.data.id);

/**
 * CR ids ordered by their CARRIED queue position. A node with no numeric `seq`
 * is reported as `<id>:no-seq` rather than silently falling back to emission
 * order — a fallback would let every re-authoring assertion below pass
 * vacuously against a builder that carries no sequence at all.
 */
const bySeq = (g: RoadmapGraph): string[] => {
  const missing = missingSeq(g);
  if (missing.length > 0) return crOrder(g).map((id) => (missing.includes(id) ? `${id}:no-seq` : id));
  return [...crNodes(g)].sort((a, b) => a.data.seq! - b.data.seq!).map((n) => n.data.id);
};

/** Canonical, order-independent edge SET: every edge's whole `data`, sorted. */
const edgeSet = (g: RoadmapGraph): string[] => g.edges.map((e) => JSON.stringify(e.data)).sort();

/** Transitive `depends-on` closure, computed from the ENTRIES alone. */
function dependencyClosure(entries: BuilderEntry[]): Map<string, Set<string>> {
  const dependants = new Map<string, string[]>();
  for (const e of entries) {
    for (const dep of e.dependsOn) {
      const bucket = dependants.get(dep);
      if (bucket === undefined) dependants.set(dep, [e.cr]);
      else bucket.push(e.cr);
    }
  }
  const closure = new Map<string, Set<string>>();
  for (const e of entries) {
    const seen = new Set<string>();
    const frontier = [e.cr];
    while (frontier.length > 0) {
      for (const next of dependants.get(frontier.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        frontier.push(next);
      }
    }
    closure.set(e.cr, seen);
  }
  return closure;
}
const REAL_CLOSURE = dependencyClosure(REAL_ENTRIES);
/** "No dependency between them" — in EITHER direction, transitively. */
const dependencyRelated = (a: string, b: string): boolean =>
  (REAL_CLOSURE.get(a)?.has(b) ?? false) || (REAL_CLOSURE.get(b)?.has(a) ?? false);

const authoredIndex = (cr: string): number => REAL_ENTRIES.findIndex((e) => e.cr === cr);
const entryFor = (cr: string): BuilderEntry => REAL_ENTRIES[authoredIndex(cr)];

/**
 * Which release REGION a CR sits in — its `crs` index in ship order, or the
 * unshipped region after the newest diamond. Membership only, never wave:
 * AC2/AC3 scope ordering to "within a region", and a release boundary
 * legitimately adds cross-region reachability (AC1c).
 */
const SHIP_ORDER = [...REAL_RELEASES].sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0));
const REGION = new Map<string, number>();
SHIP_ORDER.forEach((rel, stage) => {
  for (const cr of membersOf(rel)) if (!REGION.has(cr)) REGION.set(cr, stage);
});
const regionOf = (cr: string): number => REGION.get(cr) ?? SHIP_ORDER.length;

/** Every same-wave, same-region pair the queue leaves genuinely independent. */
const SAME_WAVE_INDEPENDENT: [string, string][] = (() => {
  const pairs: [string, string][] = [];
  for (let i = 0; i < REAL_ENTRIES.length; i += 1) {
    for (let j = i + 1; j < REAL_ENTRIES.length; j += 1) {
      const a = REAL_ENTRIES[i].cr;
      const b = REAL_ENTRIES[j].cr;
      if (REAL_ENTRIES[i].wave !== REAL_ENTRIES[j].wave) continue;
      if (regionOf(a) !== regionOf(b)) continue;
      if (dependencyRelated(a, b)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
})();

/** Authored-adjacent pairs with no declared dependency either way. */
const ADJACENT_INDEPENDENT: [string, string][] = REAL_ENTRIES.slice(1)
  .map((e, i): [string, string] => [REAL_ENTRIES[i].cr, e.cr])
  .filter(([a, b]) => !dependencyRelated(a, b));

/**
 * Deterministic RE-AUTHORINGS of the same queue. Reversal is the maximal
 * permutation; the 3-stride interleave is a non-trivial one that is neither
 * the original nor its reverse.
 */
const reversed = <T,>(xs: T[]): T[] => [...xs].reverse();
const strided = <T,>(xs: T[]): T[] => {
  const out: T[] = [];
  for (let start = 0; start < 3; start += 1) {
    for (let i = start; i < xs.length; i += 3) out.push(xs[i]);
  }
  return out;
};

/**
 * A permutation RE-AUTHORED: the rows in their new order, each carrying the
 * stored `seq` that order implies.
 *
 * CR-CRU-091/AC18 — re-authoring the real queue means re-stamping the stored
 * `seq` (that is what `wave-sequence` does), not shuffling a response array:
 * `listQueue` is `ORDER BY seq`, so a payload permuted WITHOUT re-stamping is
 * not a re-authored queue at all. The builder consumes the published value, so
 * an ordering assertion has to move the value it consumes.
 */
const reauthored = (xs: BuilderEntry[]): BuilderEntry[] =>
  xs.map((e, i) => ({ ...e, seq: i * 10 }));

/**
 * The three wave profiles AC8 must be completely blind to: every entry in ONE
 * wave, every entry in its OWN wave, and no `wave` field at all.
 */
const WAVE_MUTATIONS: { name: string; entries: BuilderEntry[] }[] = [
  { name: "every wave identical", entries: REAL_ENTRIES.map((e) => ({ ...e, wave: "1" })) },
  {
    name: "every wave distinct",
    entries: REAL_ENTRIES.map((e, i) => ({ ...e, wave: String(i + 1) })),
  },
  {
    name: "every wave absent",
    entries: REAL_ENTRIES.map(({ wave: _wave, ...rest }) => rest as BuilderEntry),
  },
];

/**
 * The AC2 anti-substitution pair, measured off the checked-in queue table on
 * 2026-08-27: CR-CRU-082 is authored BEFORE CR-CRU-081, so authored order and
 * CR-id order DISAGREE, and neither depends on the other. A builder that
 * "orders by CR number" gets this pair backwards; only carrying the authored
 * sequence gets it right.
 */
const AUTHORED_BEFORE = "CR-CRU-082";
const AUTHORED_AFTER = "CR-CRU-081";

/**
 * The AC3 fan-out pairs: same wave, same region, each pair declaring one
 * SHARED prerequisite and no dependency on each other, so the only correct
 * shape is two parallel branches off that prerequisite.
 */
const PARALLEL_PAIRS: { upstream: string; a: string; b: string }[] = [
  { upstream: "CR-CRU-074", a: "CR-CRU-080", b: "CR-CRU-082" },
  { upstream: "CR-CRU-066", a: "CR-CRU-068", b: "CR-CRU-069" },
];

describe("CR-CRU-077 §S1/AC2 — the authored queue sequence is CARRIED as data, never invented as an edge", () => {
  test("every CR node carries its orchestrator-assigned queue position as a numeric `data.seq`, strictly increasing in authored order", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(REAL_ENTRIES.length).toBeGreaterThan(80);
    expect(crNodes(g).length).toBe(REAL_ENTRIES.length);
    // Named diff: which CRs arrive with no carried position at all.
    expect(missingSeq(g)).toEqual([]);
    // Distinct — a layout cannot tie-break on a repeated rank.
    const values = crNodes(g).map((n) => n.data.seq!);
    expect(new Set(values).size).toBe(values.length);
    // Monotonic in AUTHORED order: entry i is carried before entry i+1.
    const outOfOrder = REAL_ENTRIES.slice(1)
      .map((e, i) => ({ before: REAL_ENTRIES[i].cr, after: e.cr }))
      .filter(({ before, after }) => !(nodeById(g, before)!.data.seq! < nodeById(g, after)!.data.seq!))
      .map(({ before, after }) => `${before} !< ${after}`);
    expect(outOfOrder).toEqual([]);
  });

  test("two CRs with no dependency between them keep their AUTHORED order — CR-CRU-082 before CR-CRU-081, which is NOT their id order", () => {
    // Fixture guards first: if the queue table is re-authored these fail with
    // a readable cause instead of blaming the builder.
    expect(entryFor(AUTHORED_BEFORE).wave).toBe(entryFor(AUTHORED_AFTER).wave);
    expect(regionOf(AUTHORED_BEFORE)).toBe(regionOf(AUTHORED_AFTER));
    expect(dependencyRelated(AUTHORED_BEFORE, AUTHORED_AFTER)).toBe(false);
    expect(authoredIndex(AUTHORED_BEFORE)).toBeLessThan(authoredIndex(AUTHORED_AFTER));
    // …and the trap is live: id order is the OPPOSITE of authored order.
    expect(AUTHORED_BEFORE > AUTHORED_AFTER).toBe(true);

    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(missingSeq(g)).toEqual([]);
    expect(nodeById(g, AUTHORED_BEFORE)!.data.seq!).toBeLessThan(
      nodeById(g, AUTHORED_AFTER)!.data.seq!,
    );
  });

  test("a RE-AUTHORED queue yields correspondingly re-authored order — the graph never substitutes an order of its own", () => {
    const authored = REAL_ENTRIES.map((e) => e.cr);
    for (const { name, entries } of [
      { name: "as authored", entries: REAL_ENTRIES },
      { name: "reversed", entries: reauthored(reversed(REAL_ENTRIES)) },
      { name: "3-strided", entries: reauthored(strided(REAL_ENTRIES)) },
    ]) {
      const g = buildRoadmapGraph(entries, REAL_RELEASES);
      // The carried order IS the input order — not the original, not the id
      // order, not the wave order.
      expect({ name, order: bySeq(g) }).toEqual({ name, order: entries.map((e) => e.cr) });
    }
    // The permutations are real: neither degenerates to the authored order.
    expect(reversed(authored)).not.toEqual(authored);
    expect(strided(authored)).not.toEqual(authored);
    expect(strided(authored)).not.toEqual(reversed(authored));
    // Re-authoring changes the carried ORDER and NOTHING structural: sequence
    // is not an edge channel, so the edge SET is untouched (decision 5).
    const base = edgeSet(buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES));
    expect(base.length).toBeGreaterThan(100);
    expect(edgeSet(buildRoadmapGraph(reversed(REAL_ENTRIES), REAL_RELEASES))).toEqual(base);
    expect(edgeSet(buildRoadmapGraph(strided(REAL_ENTRIES), REAL_RELEASES))).toEqual(base);
  });

  test("the queue position rides DATA only: no CR-to-CR edge expresses sequence, and re-authoring changes no label", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(missingSeq(g)).toEqual([]);
    // Only CR nodes are sequenced — a diamond and a terminal have no queue
    // position, so nothing can rank the flow's brackets by one.
    expect(
      g.nodes.filter((n) => n.data.type !== "cr" && n.data.seq !== undefined).map((n) => n.data.id),
    ).toEqual([]);
    // No edge joins an authored-adjacent, dependency-free pair: adjacency in
    // the queue is a position, never a prerequisite.
    expect(ADJACENT_INDEPENDENT.length).toBeGreaterThan(0);
    const sequenceEdges = ADJACENT_INDEPENDENT.filter(
      ([a, b]) => hasEdge(g, a, b) || hasEdge(g, b, a),
    ).map(([a, b]) => `${a} ~ ${b}`);
    expect(sequenceEdges).toEqual([]);
    // The position never leaks into text: re-authoring the queue moves every
    // `seq` and must leave every label byte-identical.
    const labels = (gr: RoadmapGraph): [string, string][] =>
      [...crNodes(gr)].sort((x, y) => (x.data.id < y.data.id ? -1 : 1)).map((n) => [n.data.id, n.data.label!]);
    expect(labels(buildRoadmapGraph(reversed(REAL_ENTRIES), REAL_RELEASES))).toEqual(labels(g));
  });
});

describe("CR-CRU-077 §S1/AC3 — same-wave CRs with no dependency between them fan OUT, they never chain", () => {
  test("synthetic fan-out: two same-wave dependants of one root are parallel branches off it, AND still carry their authored order", () => {
    // Unambiguous by construction: X and Y share wave 4 and one prerequisite,
    // and neither depends on the other. AC3 (parallel) and AC2 (ordered) must
    // hold in the SAME graph — that is the whole tension, in three entries.
    const entries: BuilderEntry[] = [
      { cr: "CR-R", title: "Root", wave: "3", dependsOn: [], status: "COMPLETED", seq: 10 },
      { cr: "CR-X", title: "Left", wave: "4", dependsOn: ["CR-R"], status: "PENDING", seq: 20 },
      { cr: "CR-Y", title: "Right", wave: "4", dependsOn: ["CR-R"], status: "PENDING", seq: 30 },
    ];
    const g = buildRoadmapGraph(entries, []);
    // Parallel branches from the SAME upstream node.
    expect(hasEdge(g, "CR-R", "CR-X")).toBe(true);
    expect(hasEdge(g, "CR-R", "CR-Y")).toBe(true);
    // Not a chain: no edge and no PATH between them, either way.
    expect(hasEdge(g, "CR-X", "CR-Y")).toBe(false);
    expect(hasEdge(g, "CR-Y", "CR-X")).toBe(false);
    expect(reachable(g, "CR-X", "CR-Y")).toBe(false);
    expect(reachable(g, "CR-Y", "CR-X")).toBe(false);
    // …and the authored order is still honoured, edgelessly.
    expect(missingSeq(g)).toEqual([]);
    expect(nodeById(g, "CR-X")!.data.seq!).toBeLessThan(nodeById(g, "CR-Y")!.data.seq!);
  });

  test("real shape: CR-CRU-080/CR-CRU-082 off CR-CRU-074 and CR-CRU-068/CR-CRU-069 off CR-CRU-066 are parallel branches", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    for (const { upstream, a, b } of PARALLEL_PAIRS) {
      // Fixture guards: the pair really is same-wave, same-region, mutually
      // independent, and really does share that one declared prerequisite.
      expect({
        pair: `${a}~${b}`,
        sameWave: entryFor(a).wave === entryFor(b).wave,
        sameRegion: regionOf(a) === regionOf(b),
        related: dependencyRelated(a, b),
        sharedPrereq:
          entryFor(a).dependsOn.includes(upstream) && entryFor(b).dependsOn.includes(upstream),
      }).toEqual({
        pair: `${a}~${b}`,
        sameWave: true,
        sameRegion: true,
        related: false,
        sharedPrereq: true,
      });
      // Parallel branches off the shared upstream, and no chain between them.
      expect({
        pair: `${a}~${b}`,
        fanA: hasEdge(g, upstream, a),
        fanB: hasEdge(g, upstream, b),
        chainAB: reachable(g, a, b),
        chainBA: reachable(g, b, a),
      }).toEqual({ pair: `${a}~${b}`, fanA: true, fanB: true, chainAB: false, chainBA: false });
    }
  });

  test("EVERY same-wave, same-region pair the queue leaves independent is unreachable in the graph, both ways", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    // Non-vacuous: the live queue really does hold hundreds of such pairs.
    expect(SAME_WAVE_INDEPENDENT.length).toBeGreaterThan(20);
    const chained = SAME_WAVE_INDEPENDENT.filter(
      ([a, b]) => reachable(g, a, b) || reachable(g, b, a),
    ).map(([a, b]) => `${a} ~ ${b}`);
    expect(chained).toEqual([]);
  });
});

describe("CR-CRU-077 §S1/AC8 — no edge, and no carried order, is derived from wave structure", () => {
  test("mutating EVERY entry's wave (all identical / all distinct / all absent) leaves the edge SET byte-identical", () => {
    const base = edgeSet(buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES));
    // Non-vacuous on both sides: real edges, and genuinely varied real waves.
    expect(base.length).toBeGreaterThan(100);
    expect(new Set(REAL_ENTRIES.map((e) => e.wave)).size).toBeGreaterThan(1);
    // The three profiles really are three different profiles.
    const profile = (entries: BuilderEntry[]): string => JSON.stringify(entries.map((e) => e.wave));
    const profiles = WAVE_MUTATIONS.map((m) => profile(m.entries));
    expect(new Set([...profiles, profile(REAL_ENTRIES)]).size).toBe(4);
    for (const { name, entries } of WAVE_MUTATIONS) {
      // Same CR set, same dependencies, same releases — ONLY `wave` differs.
      expect(entries.map((e) => e.cr)).toEqual(REAL_ENTRIES.map((e) => e.cr));
      expect({ name, edges: edgeSet(buildRoadmapGraph(entries, REAL_RELEASES)) }).toEqual({
        name,
        edges: base,
      });
    }
  });

  test("the carried queue order is not wave-derived either: the same wave mutations leave every `data.seq` ordering identical", () => {
    // The trap this closes: deriving `seq` by sorting on wave (then index) is
    // both "an order of its own" (AC2) and wave-derived structure (AC8), and
    // it would sail past an edge-only AC8 assertion.
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(missingSeq(g)).toEqual([]);
    const base = bySeq(g);
    expect(base).toEqual(REAL_ENTRIES.map((e) => e.cr));
    for (const { name, entries } of WAVE_MUTATIONS) {
      expect({ name, order: bySeq(buildRoadmapGraph(entries, REAL_RELEASES)) }).toEqual({
        name,
        order: base,
      });
    }
  });

  test("no edge id, source or target names a wave — not a boundary, and not a wave terminating in a release", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(g.edges.length).toBeGreaterThan(100);
    const waveish = g.edges
      .filter((e) => /wave/i.test(`${e.data.id} ${e.data.source} ${e.data.target}`))
      .map((e) => e.data.id);
    expect(waveish).toEqual([]);
    // Every edge is accounted for by a NON-wave channel: a declared
    // dependency, release membership, the release chain, or a terminal.
    const known = /^(dep:|rel:ship:|rel:gate:|rel:chain:|start->)|->end$/;
    expect(g.edges.filter((e) => !known.test(e.data.id)).map((e) => e.data.id)).toEqual([]);
  });
});

describe("CR-CRU-077 §S1 — the ordering assertions above cannot pass on an empty graph", () => {
  test("an empty queue yields no CR nodes, no ordering pairs and no edges, so every quantifier above is non-vacuous only against the real fixture", () => {
    const empty = buildRoadmapGraph([], []);
    expect(crNodes(empty)).toEqual([]);
    expect(crOrder(empty)).toEqual([]);
    expect(bySeq(empty)).toEqual([]);
    expect(missingSeq(empty)).toEqual([]);
    // The universally-quantified sets above are all empty here — which is
    // exactly why each of those tests asserts its own population size.
    expect(dependencyClosure([]).size).toBe(0);
    // …and the real fixture populates every one of them.
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(crNodes(g).length).toBeGreaterThan(80);
    expect(g.edges.length).toBeGreaterThan(100);
    expect(SAME_WAVE_INDEPENDENT.length).toBeGreaterThan(20);
    expect(ADJACENT_INDEPENDENT.length).toBeGreaterThan(0);
    expect(PARALLEL_PAIRS.length).toBe(2);
    expect(REAL_CLOSURE.size).toBe(REAL_ENTRIES.length);
  });
});

// ── CR-CRU-077 §S4 (AC6) labels + §S3 (AC5) track — the pure builder half ───
//
// Spec: docs/changes/CR-CRU-077-roadmap-graph-is-the-execution-dag.md §S3, §S4,
// AC5 / AC6. Design authority: docs/research/DN-crucible-roadmap-view.md "Row
// grammar" — "`CR-id` + bare `depends-on` + status + a terse track/cycle
// overlay. **No titles** — the identifier is what every other surface keys on,
// and a full title crowds it out."
//
// THE DEFECT UNDER TEST, verified in public/app-logic.mjs:818 —
// `label: e.title ?? e.cr`. The node label is the human TITLE, so the id every
// other surface keys on is invisible (or truncated away) on the graph, and the
// status the DN's grammar puts in the row is nowhere in the text at all. That
// is defect 3 of the Problem section.
//
// THE PINNED SUFFIX VOCABULARY, and why each element is DERIVABLE from the
// builder's OWN two inputs (`entries`, `releases`) — nothing here is guessed:
//   • COMPLETED           → `<id> ✓ merged`      — AC6's verbatim example
//     (`CR-CRU-090 ✓ merged`). Derivable: `COMPLETED` IS "a plan closed with a
//     merge commit" (src/types.ts:348), so "merged" restates the wire value.
//   • COMPLETED_UNTRACKED → `<id> ✓ untracked`   — CR-083's fourth derived
//     value. Derivable: it means "a cr some release SHIPPED but no plan ever
//     tracked" (src/types.ts:334), i.e. a completion (same ✓ family) that is
//     NOT a merge — and the terse form of the wording the table badge already
//     uses for it, "completed · tracking absent" (public/app.js:2368).
//   • IN_PROGRESS         → `<id> ▶`             — ▶ is already this view's
//     active marker (public/app.js:2362). Carries NO cycle position: see the
//     gap note below.
//   • PENDING             → `<id>`               — bare id, per AC6.
//
// THE CYCLE-POSITION GAP (AC6's `CR-CRU-077 ▶ 2/3` example), asserted NOWHERE
// here because it is NOT DERIVABLE IN THIS BUILDER, and faking it would pin a
// contract GREEN could only satisfy by inventing data:
//   • A cycle position is computed from a PLAN: `roadmapCyclePosition(plan)`
//     reads `plan.cycles` and returns `cycle <i>/<n>` (public/app.js:2354-2358).
//     `cycles: PlanCycle[]` is a field of `Plan` (src/types.ts:323).
//   • The builder's queue input is `QueueEntry` — `{cr, title?, wave,
//     dependsOn, size?, status, planId?}` (src/types.ts:355-363). It carries
//     NO cycles. `planId` is an identifier, not a position: resolving it to
//     `2/3` needs the plan payload, a THIRD input this builder is never handed
//     (`buildRoadmapGraph(entries, releases)` keeps its signature — the CR's
//     own D6, spec line 142).
//   • So the in-progress marker is asserted WITHOUT a position, which is also
//     the existing precedent: the table's own lane badge degrades to
//     `<track> ▶` whenever the position is null (public/app.js:2362).
//   The suffix is therefore either a DATA PREREQUISITE (plans reach the
//   builder) or belongs to the render cycle — an orchestrator call, not a
//   test's to fabricate.

/** The terse status suffix, keyed by the four derived `QueueStatus` values. */
const STATUS_SUFFIX: Record<BuilderEntry["status"], string> = {
  COMPLETED: " ✓ merged",
  COMPLETED_UNTRACKED: " ✓ untracked",
  IN_PROGRESS: " ▶",
  PENDING: "",
};
/** AC6's whole label: the CR id plus a terse status suffix and NOTHING else. */
const expectedLabel = (e: BuilderEntry): string => `${e.cr}${STATUS_SUFFIX[e.status]}`;

describe("CR-CRU-077 §S4/AC6 — a CR node label is the id plus a terse status suffix, and NO title", () => {
  test("the real 88-row shape has titles worth crowding out — the no-title assertions below are not vacuous", () => {
    // Non-vacuity guard: if the README table stopped yielding titles, "no
    // label contains its title" would pass against a builder that renders
    // nothing but titles.
    const untitled = REAL_ENTRIES.filter((e) => (e.title ?? "").length === 0).map((e) => e.cr);
    expect(untitled).toEqual([]);
    // …and they are long prose, which is exactly why AC6 removes them: a
    // title crowds the identifier out of the node box.
    expect(REAL_ENTRIES.filter((e) => (e.title ?? "").length > 20).length).toBeGreaterThan(40);
  });

  test("EVERY type:'cr' node label LEADS with its own CR id — the offenders are named", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(crNodes(g).length).toBe(REAL_ENTRIES.length);
    const notLeading = crNodes(g)
      .filter((n) => !(n.data.label ?? "").startsWith(n.data.id))
      .map((n) => `${n.data.id} → ${JSON.stringify(n.data.label)}`);
    expect(notLeading).toEqual([]);
  });

  test("NO node label contains its own entry's `title` string — the offenders are named", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    // AC6's own stated measurement: "asserted by checking that no node label
    // contains its own entry's `title` string, so an `id + title` label
    // fails". Matched per-entry, so a title is never mistaken for a suffix.
    const leaking = crNodes(g)
      .map((n) => ({ node: n, entry: entryFor(n.data.id) }))
      .filter(({ node, entry }) => (node.data.label ?? "").includes(entry.title ?? "\u0000"))
      .map(({ node, entry }) => `${node.data.id}: label ${JSON.stringify(node.data.label)} carries title ${JSON.stringify(entry.title)}`);
    expect(leaking).toEqual([]);
  });

  test("every label is EXACTLY id + terse status suffix across the real shape — nothing else is in the text", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    // The tightest form of AC6: the whole label, for every node, byte-exact.
    // Stronger than the containment check above, which a one-word title could
    // slip past.
    const wrong = crNodes(g)
      .map((n) => ({ id: n.data.id, label: n.data.label, want: expectedLabel(entryFor(n.data.id)) }))
      .filter((r) => r.label !== r.want);
    expect(wrong).toEqual([]);
  });

  test("a PENDING entry's label is the BARE id — no suffix at all", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    const pending = REAL_ENTRIES.filter((e) => e.status === "PENDING");
    expect(pending.length).toBeGreaterThan(0);
    const suffixed = pending
      .map((e) => nodeById(g, e.cr)!)
      .filter((n) => n.data.label !== n.data.id)
      .map((n) => `${n.data.id} → ${JSON.stringify(n.data.label)}`);
    expect(suffixed).toEqual([]);
  });
});

describe("CR-CRU-077 §S4/AC6 — each derived status maps to its own terse suffix", () => {
  /** One entry, one status, one label — the suffix in isolation. */
  const labelFor = (status: BuilderEntry["status"]): string => {
    const g = buildRoadmapGraph(
      [{ cr: "CR-CRU-099", title: "A title long enough to crowd the identifier out", wave: "9", dependsOn: [], status }],
      [],
    );
    return nodeById(g, "CR-CRU-099")!.data.label!;
  };

  test("COMPLETED → `<id> ✓ merged` (AC6's verbatim example shape)", () => {
    expect(labelFor("COMPLETED")).toBe("CR-CRU-099 ✓ merged");
  });

  test("COMPLETED_UNTRACKED → `<id> ✓ untracked`, DISTINCT from COMPLETED (CR-083's fourth value)", () => {
    expect(labelFor("COMPLETED_UNTRACKED")).toBe("CR-CRU-099 ✓ untracked");
    // The two completions must not collapse into one another: the graph has to
    // read "shipped, never tracked" differently from "merged".
    expect(labelFor("COMPLETED_UNTRACKED")).not.toBe(labelFor("COMPLETED"));
  });

  test("IN_PROGRESS → `<id> ▶` — the active marker WITHOUT a cycle position (not derivable here)", () => {
    // See the gap note above: `2/3` lives on `plan.cycles`, and the builder is
    // handed queue entries + releases only. Asserting a position would pin
    // fabricated data, so the marker stands alone — the same degradation the
    // table's lane badge already makes when the position is null.
    expect(labelFor("IN_PROGRESS")).toBe("CR-CRU-099 ▶");
    // Nothing numeric may appear beyond the id itself.
    expect(labelFor("IN_PROGRESS").slice("CR-CRU-099".length)).not.toMatch(/\d/);
  });

  test("PENDING → the bare `<id>`, byte for byte", () => {
    expect(labelFor("PENDING")).toBe("CR-CRU-099");
  });

  test("the four statuses yield four DISTINCT labels — no status is unreadable off the node", () => {
    const all = (["COMPLETED", "COMPLETED_UNTRACKED", "IN_PROGRESS", "PENDING"] as const).map(labelFor);
    expect(new Set(all).size).toBe(4);
    // The status is text on the node, but the raw wire value never is — it
    // stays on data.status for the stylesheet (the pre-existing contract).
    for (const label of all) {
      expect(label).not.toContain("COMPLETED");
      expect(label).not.toContain("PENDING");
      expect(label).not.toContain("IN_PROGRESS");
    }
  });
});

describe("CR-CRU-077 §S4/AC6 — the title leaks NOWHERE, and non-CR labels are untouched", () => {
  test("a SHORT title cannot hide inside the suffix — a 3-char title is absent from every label", () => {
    // The containment check against the real shape leans on long titles; a
    // terse title is the case where an `id + title` label looks plausible.
    // "Zed" shares no character run with the id or with any pinned suffix.
    const entries: BuilderEntry[] = [
      { cr: "CR-CRU-091", title: "Zed", wave: "9", dependsOn: [], status: "COMPLETED" },
      { cr: "CR-CRU-092", title: "Zed", wave: "9", dependsOn: ["CR-CRU-091"], status: "IN_PROGRESS" },
      { cr: "CR-CRU-093", title: "Zed", wave: "9", dependsOn: ["CR-CRU-092"], status: "PENDING" },
      { cr: "CR-CRU-094", title: "Zed", wave: "9", dependsOn: ["CR-CRU-093"], status: "COMPLETED_UNTRACKED" },
    ];
    const g = buildRoadmapGraph(entries, []);
    const leaking = crNodes(g)
      .filter((n) => (n.data.label ?? "").includes("Zed"))
      .map((n) => `${n.data.id} → ${JSON.stringify(n.data.label)}`);
    expect(leaking).toEqual([]);
    // …and each is still its own exact id + suffix.
    expect(crNodes(g).map((n) => n.data.label)).toEqual(entries.map(expectedLabel));
  });

  test("a milestone label stays the BARE version string and a terminal stays Start/End — AC6 governs CR nodes only", () => {
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(milestoneNodes(g).map((n) => n.data.label).sort()).toEqual(["0.1.0", "0.1.1", "0.1.2", "0.1.3"]);
    for (const m of milestoneNodes(g)) expect(m.data.label).toBe(m.data.version);
    const t = terminals(g);
    expect(t.find((n) => n.data.terminal === "start")!.data.label).toBe("Start");
    expect(t.find((n) => n.data.terminal === "end")!.data.label).toBe("End");
    // A diamond and a bracket hold no status, so neither may grow a suffix.
    for (const n of [...milestoneNodes(g), ...t]) {
      expect(n.data.label).not.toContain("✓");
      expect(n.data.label).not.toContain("▶");
    }
  });
});

describe("CR-CRU-077 §S3/AC5 — the reported track RIDES the node, and its absence is not an error", () => {
  test("an entry WITH a track carries it verbatim on data.track", () => {
    const g = buildRoadmapGraph(
      [{ cr: "CR-CRU-095", title: "Tracked", wave: "9", dependsOn: [], status: "IN_PROGRESS", track: "track-2" }],
      [],
    );
    expect(nodeById(g, "CR-CRU-095")!.data.track).toBe("track-2");
  });

  test("an entry with NO track omits the key entirely — never null, never the empty string", () => {
    const g = buildRoadmapGraph(
      [
        { cr: "CR-CRU-096", title: "Untracked", wave: "9", dependsOn: [], status: "PENDING" },
        // A wire null is the live shape too: `track` is a PLAN column
        // (src/store.ts:226) and the plan payload omits it when null
        // (src/store.ts:3280), so the builder must not turn one into a key.
        { cr: "CR-CRU-097", title: "Nulled", wave: "9", dependsOn: [], status: "PENDING", track: null as unknown as string },
      ],
      [],
    );
    for (const cr of ["CR-CRU-096", "CR-CRU-097"]) {
      const data = nodeById(g, cr)!.data;
      expect("track" in data).toBe(false);
      expect(data.track).toBeUndefined();
      expect(data.track).not.toBe(null);
      expect(data.track).not.toBe("");
    }
  });

  test("the LIVE queue shape reports no track at all, and the graph is complete anyway — absence is not an error", () => {
    // `QueueEntry` (src/types.ts:355-363) has no `track` field: track lives on
    // `Plan` (src/types.ts:318). So the real roadmap payload carries none, and
    // AC5's "its absence is not an error" is the MEASURED case, not a corner.
    const g = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(REAL_ENTRIES.filter((e) => e.track !== undefined)).toEqual([]);
    expect(crNodes(g).filter((n) => "track" in n.data)).toEqual([]);
    // Nothing degraded: every entry still became a node, with its status text.
    expect(crNodes(g).length).toBe(REAL_ENTRIES.length);
    expect(crNodes(g).filter((n) => (n.data.label ?? "") === "")).toEqual([]);
    // AC5 forbids a hard-coded track COUNT, so the distinct tracks present are
    // DERIVED and reported, never compared against a pinned number.
    const tracks = new Set(crNodes(g).map((n) => n.data.track).filter((t) => t !== undefined));
    expect([...tracks]).toEqual([...new Set(REAL_ENTRIES.map((e) => e.track).filter((t) => t !== undefined))]);
  });

  test("§S3 draws no lane and no wave container: track is DATA, and never text on the node", () => {
    const g = buildRoadmapGraph(
      [
        { cr: "CR-CRU-098", title: "Laned", wave: "9", dependsOn: [], status: "IN_PROGRESS", track: "track-2" },
      ],
      [],
    );
    const n = nodeById(g, "CR-CRU-098")!;
    expect(n.data.track).toBe("track-2");
    // The overlay the DN's row grammar puts in the TABLE row is not the graph
    // label: AC6 admits the id and a status suffix and nothing else.
    expect(n.data.label).not.toContain("track-2");
    expect(n.data.label).toBe("CR-CRU-098 ▶");
    // No container/lane node type is invented here — that chrome is CR-085's.
    expect(new Set(g.nodes.map((x) => x.data.type))).toEqual(new Set(["cr", "terminal"]));
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
interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}
// CR-CRU-077 §S4 — the plan payload the CYCLE POSITION lives on. Same shape
// the table's lane badge is already fed by (tests/roadmap-pane.test.ts).
interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
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
  // CR-CRU-077 §S2/AC4 — the release ledger the collapse assertions need. The
  // toggle/style/tap tests above ran with an EMPTY ledger, which is still the
  // default, so nothing they assert changes.
  releases?: BuilderRelease[];
  // CR-CRU-077 §S4 — the cycle plans `GET …/plans` returns. Defaults to the
  // EMPTY array every test above already received, so nothing they assert
  // changes; only the live-state tests below pass one.
  plans?: PlanFixture[];
  // Runs INSIDE the freshly registered window, after the scripted `fetch` and
  // BEFORE the app boots — the only place a test can pre-seed a would-be
  // persistence store (localStorage/sessionStorage) so AC4's "not persisted"
  // can be asserted as an ABSENCE of restore, not just an absence of write.
  beforeBoot?: () => void;
}

// A Cytoscape stylesheet rule as `cy.style().json()` returns it.
interface CyStyleRule {
  selector: string;
  style: Record<string, unknown>;
}
interface CyCollection {
  length: number;
  nonempty: () => boolean;
  empty: () => boolean;
  emit: (event: string) => unknown;
  // `data(key)` is cytoscape's own per-element read — the RENDERED value, not
  // the builder's input object. Typed `unknown` and narrowed at each use.
  data: (key: string) => unknown;
  // Cytoscape's own "is this element actually drawn" predicate (it folds in
  // `display`/`visibility` and a hidden parent), so an assertion on it holds
  // whether a collapse implementation REMOVES its members or HIDES them.
  visible: () => boolean;
  isParent: () => boolean;
  map: <T>(fn: (ele: CyCollection) => T) => T[];
  // cytoscape's own per-element style reader: `style()` is every RESOLVED
  // property of the drawn element, `style(name)` just one. Untyped by
  // construction (it mirrors the stylesheet), so narrowed at each use.
  style: (name?: string) => unknown;
  // The laid-out model position dagre wrote — the layout's own output.
  position: () => { x: number; y: number };
}
interface CyHandle {
  style: () => { json: () => CyStyleRule[] };
  $id: (id: string) => CyCollection;
  nodes: (selector?: string) => CyCollection;
  edges: (selector?: string) => CyCollection;
  // Cytoscape's own "has this instance been torn down" predicate — the only
  // honest way to observe that a retired mount was DISPOSED rather than
  // abandoned with its canvas layers, renderer and window listeners.
  destroyed: () => boolean;
  // …and cytoscape's own disposal, which the per-test teardown calls so no
  // retired mount survives into another test file.
  destroy: () => void;
}

// public/app.js guards its Cytoscape mount on the plain-HTML global
// `window.cytoscape` (the vendored UMD, loaded by index.html) and publishes the
// live instance as `window.crucibleRoadmapCy`. happy-dom ships no canvas
// backend, so cytoscape's canvas renderer aborts with "Could not create canvas
// of type 2d" and never yields an instance — hence the minimal 2d-context stub.
// Test-harness only: no production seam, the stylesheet read below is the real
// one app.js hands to cytoscape.
//
// The 2d-context stub is PER MOUNT: `HTMLCanvasElement` (and `OffscreenCanvas`)
// are classes of the freshly registered happy-dom window, so their prototypes
// have to be patched again on every mount. The two vendored UMDs are NOT: they
// are 1.18 MB of source that attaches `cytoscape` to the real globalThis (the
// object happy-dom aliases `window` to, and one unregister does not delete),
// and cytoscape reads `window.*`/`document` through that live global rather
// than capturing either at load time. Re-evaluating them per mount cost this
// file 28 parses of that 1.18 MB and left the compiled code of all 28 resident
// for the REST of the bun process — the cross-file load that starved a
// poll-tick test 100 files later. One eval, reused by every mount.
let cytoscapeLoaded = false;

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
  if (cytoscapeLoaded) return;
  (0, eval)(readFileSync(path.join(REPO_ROOT, "public/cytoscape.umd.js"), "utf8"));
  (0, eval)(readFileSync(path.join(REPO_ROOT, "public/cytoscape-dagre.js"), "utf8"));
  cytoscapeLoaded = true;
}

// The live instance app.js publishes on the window (public/app.js) — the DOM
// lib has no declaration for it, so the known shape is asserted once here.
function roadmapCy(): CyHandle | undefined {
  const win = window as unknown as { crucibleRoadmapCy?: CyHandle };
  return win.crucibleRoadmapCy;
}

let cacheBust = 0;

/**
 * Close the current mount for good: DESTROY the live Cytoscape instance, drop
 * the reference app.js published, then close the happy-dom window.
 *
 * The destroy is the point, and so is its order. `window.crucibleRoadmapCy` is
 * written on the REAL globalThis (happy-dom aliases `window` to it) and is not
 * one of the keys `unregister()` restores, so a mount that is merely
 * unregistered leaves a fully live instance — renderer, canvas layers,
 * animation queue — reachable for the rest of the bun process. Measured on this
 * file before this teardown existed: 81 tests finished with 27 undestroyed
 * instances, 92 MB of retained heap and 63 MB external AFTER a forced GC, and
 * an abandoned instance re-armed its redraw against whatever happy-dom window
 * was current LATER — work, and a null-2d-context throw, charged to other test
 * files. With the teardown: 0 undestroyed instances, 41 MB retained heap, 20 MB
 * external. `cy.destroy()` is the app's own retirement path (the remount at
 * public/app.js:2547-2556 calls the live teardown and then destroys, in that
 * order, so the generation guard has already orphaned every in-flight
 * `complete` callback before the instance goes), and dropping the global
 * reference is what lets the instance be collected.
 */
async function closeMount(): Promise<void> {
  if (!GlobalRegistrator.isRegistered) return;
  const win = globalThis as { crucibleRoadmapCy?: CyHandle };
  const cy = win.crucibleRoadmapCy;
  if (cy !== undefined) {
    if (!cy.destroyed()) cy.destroy();
    delete win.crucibleRoadmapCy;
  }
  await GlobalRegistrator.unregister();
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  await closeMount();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/queue/.test(url)) {
      body = { ok: true, entries: opts.queue };
    } else if (/\/api\/v2\/projects\/[^/]+\/releases/.test(url)) {
      body = { ok: true, releases: opts.releases ?? [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans ?? [] };
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
    // A real `Response.json()` PARSES the wire bytes, so every call yields a
    // FRESH object graph. Resolving the same `body` object made every poll a
    // no-op for vanX (`replace` writes the identical object identities back, so
    // nothing notifies and no binding re-runs), which silently made a live
    // re-render UNOBSERVABLE to every test in this file. Round-trip through
    // JSON so the harness has the identity behaviour the browser has.
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(JSON.stringify(body)) as unknown,
    } as Response;
  }) as typeof fetch;

  opts.beforeBoot?.();

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

afterEach(closeMount);

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

// CR-CRU-078 §S1 — RETIRED (2 assertion sites, stated rather than vanished):
// the two `roadmap-view-table`/`roadmap-view-graph` EXISTENCE assertions
// (previously :1612-1613) and the two EXCLUSIVITY tests that went with them
// ("switching to graph removes the table rows", "switching back restores
// them") defended a contract AC1 deletes — one body at a time, selected by
// `roadmapViewMode`. There is no button to query and no exclusion to observe:
// the zones render together. Their surviving value — the graph container
// mounts on a cold load, and the table rows are there too — is asserted below
// unconditionally, and the whole-surface contract (three zones, one pane,
// neither testid in DOM or source) is pinned in
// tests/roadmap-release-strip.test.ts.
describe("CR-CRU-078 §S1/AC1 — a cold /p/<key>/roadmap load renders the graph UNCONDITIONALLY", () => {
  test("the graph container mounts with no view switch, and the table rows render beside it", async () => {
    await mountToggle();
    expect(graphCount()).toBe(1);
    expect(rowCount()).toBeGreaterThan(0);
    // The retired affordance is gone from the DOM, not merely unused.
    expect(document.querySelector('[data-testid="roadmap-view-table"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-view-graph"]')).toBeNull();
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
    // §S1 — no navigation preamble: the graph is already mounted.

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

// ── CR-CRU-077 §S2 / AC4 — collapse is by RELEASE ───────────────────────────
//
// Spec: docs/changes/CR-CRU-077-roadmap-graph-is-the-execution-dag.md §S2 +
// AC4 (as corrected by gap-analysis round 3): "collapse is by **release**: a
// shipped release renders as one node carrying its CR count and expands on
// click, while the unreleased region stays expanded", plus §S2's "Expansion
// state is UI state, not persisted." AC4's old wave-container clause was
// REMOVED by DRIFT-1 — §S3/AC5 govern containers and that chrome is
// CR-CRU-085's — so the last test below FORBIDS wave chrome, to stop AC4 being
// satisfied by grouping on waves instead of on releases.
//
// THE SEAM, and why it is a RENDER assertion (the CR's Risk section requires
// one: "a source-only check already gave a false positive once this cycle"):
// these tests drive the REAL public/app.js in happy-dom and the REAL vendored
// cytoscape + dagre (mountApp's `cytoscape: true` → installCytoscape), then
// read the LIVE instance app.js publishes on `window.crucibleRoadmapCy`. So
// every assertion below is on cytoscape's own rendered element registry —
// which nodes exist and which are actually drawn — never on a call count and
// never on app.js source. Cytoscape draws to a <canvas>, so there is no
// per-node DOM element to query or click: node presence is read through
// `cy.$id(...)` and the click is `…emit("tap")`, cytoscape's own dispatch into
// the delegated `cy.on("tap", …)` handler — exactly the precedent the CR-083
// tap test above already relies on.
//
// Fixtures are the LIVE shape (REAL_ENTRIES, 88 parsed queue rows; and the
// verbatim 4-release REAL_RELEASES ledger), so the counts AC4 talks about are
// the measured ones. Feasibility measured, not assumed: this mount lays 94
// nodes out in ~0.4s under happy-dom.
//
// THE PINNED CONTRACT — the four render-side decisions AC4 leaves open, each
// derived from an AC already shipped rather than invented here:
//   1. A release's ONE node IS the existing `milestone:<version>` diamond. The
//      builder already emits exactly one node per release, and AC1 requires it
//      to keep an inbound and an outbound edge; a SECOND "collapsed" node
//      beside it would duplicate the release in the flow.
//   2. The count rides that node as `data.crCount` AND is visible in its
//      `label`: "carrying its CR count" is a claim about what the user sees, so
//      a count nobody can read is not rendered.
//   3. Collapse state is `data.collapsed` — `true` while collapsed, `false`
//      once expanded. The node PERSISTS through expansion (it is marked, not
//      removed): AC1 forbids a release whose diamond has no edges, and
//      `rel:chain:` wires the diamonds to each other, so a diamond that
//      vanished on expand would break the release chain mid-graph.
//   4. "Not individually present" is measured as NOT RENDERED — absent from
//      the graph, or present-but-not-drawn (`visible()` false, which folds in
//      `display`/`visibility` and a hidden parent). Both are honest collapse
//      implementations; pinning one would pin a mechanism, not AC4's outcome.
//
// THE DEFECT UNDER TEST, measured against today's render (real cytoscape,
// live shape, graph view up): `cy.$id("CR-CRU-001").nonempty()` is `true` —
// a CR that shipped in 0.1.0 renders as its own node — and
// `cy.$id("milestone:0.1.0")` carries `data.crCount === undefined` with
// `label === "0.1.0"`. There is no collapse of any kind and no count anywhere,
// so all four of 0.1.0 / 0.1.1 / 0.1.2 / 0.1.3 render 62 member CRs loose in
// the flow.

/** The release ledger's per-version membership count, measured 2026-08-27. */
const EXPECTED_RELEASE_CR_COUNTS: Record<string, number> = {
  "0.1.0": 60,
  "0.1.1": 0,
  "0.1.2": 1,
  "0.1.3": 1,
};

/** The node id the builder already gives a release diamond. */
const releaseNodeId = (version: string): string => `milestone:${version}`;

/** The CRs a release shipped that the queue actually carries — the collapsible members. */
const membersInQueue = (rel: BuilderRelease): string[] => {
  const queued = new Set(REAL_ENTRIES.map((e) => e.cr));
  return membersOf(rel).filter((cr) => queued.has(cr));
};

/** Every CR in NO release — AC4's "unreleased region", which stays expanded. */
const UNRELEASED_CRS = REAL_ENTRIES.map((e) => e.cr).filter((cr) => !ALL_RELEASED.has(cr));

/** The live instance, or a named failure — a missing handle is never a pass. */
function liveCy(): CyHandle {
  const cy = roadmapCy();
  if (cy === undefined) {
    throw new Error("no cytoscape instance was published on window.crucibleRoadmapCy");
  }
  return cy;
}

/** cytoscape's `data(key)` is untyped by construction — narrow, never assert. */
const stringData = (node: CyCollection, key: string): string => {
  const value = node.data(key);
  return typeof value === "string" ? value : "";
};

/** Rendered = in the graph AND actually drawn (see pinned decision 4). */
const isRendered = (cy: CyHandle, id: string): boolean => {
  const node = cy.$id(id);
  return node.nonempty() && node.visible();
};

/** Every CR id the graph currently DRAWS, whatever the collapse mechanism. */
const renderedCrIds = (cy: CyHandle): string[] =>
  cy
    .nodes('[type="cr"]')
    .map((n) => (n.visible() ? stringData(n, "id") : ""))
    .filter((id) => id !== "")
    .sort();

/**
 * The endpoints of every edge the graph currently DRAWS. Read off cytoscape's
 * own edge elements (their `source`/`target` data), so a collapse that leaves
 * an edge behind pointing at a hidden CR is visible to the assertions below.
 */
const visibleEdgeEnds = (cy: CyHandle): { source: string; target: string }[] => {
  const ends: { source: string; target: string }[] = [];
  const drawn = cy
    .edges()
    .map((e) =>
      e.visible() ? { source: stringData(e, "source"), target: stringData(e, "target") } : undefined,
    );
  for (const end of drawn) {
    if (end !== undefined) ends.push(end);
  }
  return ends;
};

/** The live roadmap in the GRAPH view, real cytoscape, real app.js. */
async function mountLiveRoadmapGraph(
  opts: { pathname?: string; beforeBoot?: () => void } = {},
): Promise<void> {
  await mountApp({
    pathname: opts.pathname ?? "/p/live-roadmap/roadmap",
    projects: [project({ key: "live-roadmap" })],
    queue: REAL_ENTRIES,
    releases: REAL_RELEASES,
    cytoscape: true,
    beforeBoot: opts.beforeBoot,
  });
  // §S1 — the graph renders unconditionally; nothing to click.
}

describe("CR-CRU-077 §S2/AC4 — a shipped release renders as ONE node carrying its CR count", () => {
  test("the live fixture really carries the release membership every assertion below keys on", () => {
    // Non-vacuity guard, pure — no render. If the ledger fixture or the README
    // queue table stopped yielding membership, "the members are not rendered"
    // would pass against a graph that collapses nothing at all.
    expect(REAL_RELEASES.map((r) => r.version).sort()).toEqual(["0.1.0", "0.1.1", "0.1.2", "0.1.3"]);
    for (const rel of REAL_RELEASES) {
      // Every CR the ledger claims is a real queue row, so the collapsed count
      // and the hidden node set are the SAME number by construction.
      expect(membersInQueue(rel)).toEqual(membersOf(rel));
      expect(membersInQueue(rel).length).toBe(EXPECTED_RELEASE_CR_COUNTS[rel.version]);
    }
    // The unreleased region is substantial and holds the CRs in flight — so
    // "stays expanded" is a claim about real nodes.
    expect(UNRELEASED_CRS.length).toBeGreaterThan(20);
    expect(UNRELEASED_CRS).toContain("CR-CRU-077");
    expect(UNRELEASED_CRS).toContain("CR-CRU-085");
    // …and the two regions together are the whole queue, nothing double-counted.
    const membersTotal = REAL_RELEASES.reduce((sum, rel) => sum + membersInQueue(rel).length, 0);
    expect(membersTotal + UNRELEASED_CRS.length).toBe(REAL_ENTRIES.length);
  });

  test("each shipped release renders as EXACTLY ONE node, collapsed, whose CR count is on the node AND in its label", async () => {
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    for (const rel of REAL_RELEASES) {
      const id = releaseNodeId(rel.version);
      // Exactly one node per release — the diamond, not a second collapsed twin.
      const sameVersion = cy
        .nodes(`[version="${rel.version}"]`)
        .map((n) => stringData(n, "id"))
        .sort();
      expect(sameVersion).toEqual([id]);
      const node = cy.$id(id);
      expect(isRendered(cy, id)).toBe(true);
      // Collapsed by DEFAULT — no interaction has happened yet.
      expect(node.data("collapsed")).toBe(true);
      // The count it carries is its OWN membership, not the whole queue.
      expect(node.data("crCount")).toBe(EXPECTED_RELEASE_CR_COUNTS[rel.version]);
    }

    // …and the count is VISIBLE, not merely stored — measured on the label with
    // the version text REMOVED, because every version string here already
    // contains the digits `0` and `1` ("0.1.2" would satisfy a naive "the label
    // mentions 1" check on its own). The zero-CR release (0.1.1) is asserted on
    // `crCount` alone: rendering the literal text "0 CRs" is a caption choice
    // AC4 does not force, while the count itself is still carried.
    for (const rel of REAL_RELEASES) {
      const count = EXPECTED_RELEASE_CR_COUNTS[rel.version];
      const label = stringData(cy.$id(releaseNodeId(rel.version)), "label");
      expect(label).toContain(rel.version);
      if (count === 0) continue;
      const withoutVersion = label.split(rel.version).join(" ");
      expect(withoutVersion).toMatch(new RegExp(`(^|\\D)${count}(\\D|$)`));
    }
  });

  test("while collapsed, the member CRs are NOT individually rendered — the hidden set is exactly RELEASE membership", async () => {
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    // Every shipped CR is folded into its release node…
    const stillRendered = REAL_RELEASES.flatMap(membersInQueue).filter((cr) => isRendered(cy, cr));
    expect(stillRendered).toEqual([]);
    // …and what remains drawn is EXACTLY the unreleased complement. A GREEN
    // that collapsed on waves (or on status, or on anything else) fails here
    // even if its node count happened to match.
    expect(renderedCrIds(cy)).toEqual([...UNRELEASED_CRS].sort());
  });

  test("collapsing a release strands nothing: its node keeps inbound AND outbound flow, and no drawn edge dangles into a hidden CR", async () => {
    // The AC1 × AC4 interaction, and the reason it needs its own test: a
    // release's inflow is its MEMBER CRs (`rel:ship:<cr>-><ver>`). Fold those
    // members away and a naive collapse leaves the diamond with no inbound edge
    // at all — the exact defect AC1 exists to forbid ("no milestone node is
    // ever edgeless") — or leaves an edge drawn to a node that is no longer
    // there. Read off the rendered edge set, so either failure is caught.
    await mountLiveRoadmapGraph();
    const cy = liveCy();
    const ends = visibleEdgeEnds(cy);
    expect(ends.length).toBeGreaterThan(0);

    for (const rel of REAL_RELEASES) {
      const id = releaseNodeId(rel.version);
      expect(ends.filter((e) => e.target === id).length).toBeGreaterThan(0);
      expect(ends.filter((e) => e.source === id).length).toBeGreaterThan(0);
    }
    // No dangling half-edge: everything an edge touches is itself drawn.
    const dangling = ends
      .filter((e) => !isRendered(cy, e.source) || !isRendered(cy, e.target))
      .map((e) => `${e.source}->${e.target}`);
    expect(dangling).toEqual([]);
  });

  test("the unreleased region stays expanded: every CR in no release is drawn individually, with no interaction at all", async () => {
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    const missing = UNRELEASED_CRS.filter((cr) => !isRendered(cy, cr));
    expect(missing).toEqual([]);
    // Named, so this cannot pass on an empty unreleased set.
    expect(isRendered(cy, "CR-CRU-077")).toBe(true);
    expect(isRendered(cy, "CR-CRU-085")).toBe(true);
  });

  test("tapping a collapsed release node EXPANDS it: its members render, and the node stays, marked expanded", async () => {
    await mountLiveRoadmapGraph();
    const target = REAL_RELEASES.find((r) => r.version === "0.1.0")!;
    const id = releaseNodeId(target.version);
    const members = membersInQueue(target);

    // Precondition (collapsed) — read through the live instance, not assumed.
    expect(liveCy().$id(id).data("collapsed")).toBe(true);
    expect(members.filter((cr) => isRendered(liveCy(), cr))).toEqual([]);

    liveCy().$id(id).emit("tap");
    await settle();

    // Re-read the handle: an implementation may remount the instance.
    const cy = liveCy();
    const notRendered = members.filter((cr) => !isRendered(cy, cr));
    expect(notRendered).toEqual([]);
    // The diamond is still there and now reads as expanded (pinned decision 3:
    // AC1 forbids the release chain losing a node).
    expect(isRendered(cy, id)).toBe(true);
    expect(cy.$id(id).data("collapsed")).toBe(false);
    // Expanding ONE release does not expand the others.
    const other = releaseNodeId("0.1.2");
    expect(cy.$id(other).data("collapsed")).toBe(true);
    expect(isRendered(cy, "CR-CRU-066")).toBe(false);
  });

  test("tapping the same release node again RE-COLLAPSES it — the state is a toggle, not one-way", async () => {
    await mountLiveRoadmapGraph();
    const target = REAL_RELEASES.find((r) => r.version === "0.1.2")!;
    const id = releaseNodeId(target.version);
    const members = membersInQueue(target);
    expect(members).toEqual(["CR-CRU-066"]);

    liveCy().$id(id).emit("tap");
    await settle();
    expect(members.filter((cr) => !isRendered(liveCy(), cr))).toEqual([]);
    expect(liveCy().$id(id).data("collapsed")).toBe(false);

    liveCy().$id(id).emit("tap");
    await settle();

    const cy = liveCy();
    expect(members.filter((cr) => isRendered(cy, cr))).toEqual([]);
    expect(cy.$id(id).data("collapsed")).toBe(true);
    // Re-collapsing restores the count-carrying node, it does not blank it.
    expect(cy.$id(id).data("crCount")).toBe(EXPECTED_RELEASE_CR_COUNTS[target.version]);
  });

  test("expansion is UI state, not persisted: toggling writes NOTHING — no fetch, no storage, no history or URL write", async () => {
    await mountLiveRoadmapGraph();
    const id = releaseNodeId("0.1.0");
    const members = membersInQueue(REAL_RELEASES.find((r) => r.version === "0.1.0")!);

    // Spies installed AFTER boot, so the app's own startup fetches and the
    // density-mode storage read are not counted — only what the TOGGLE does.
    // `globalThis` carries no `fetch` declaration in this project's lib set, so
    // the scripted global is reached through the same named boundary const
    // mountApp uses above (a DOM/global shape the compiler cannot see).
    const globalScope: { fetch: typeof fetch } = globalThis as unknown as {
      fetch: typeof fetch;
    };
    const scriptedFetch = globalScope.fetch;
    let fetchCalls = 0;
    globalScope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      return scriptedFetch(input, init);
    }) as typeof fetch;
    const storage = window.localStorage;
    const session = window.sessionStorage;
    let storageWrites = 0;
    storage.setItem = () => {
      storageWrites += 1;
    };
    session.setItem = () => {
      storageWrites += 1;
    };
    let historyWrites = 0;
    window.history.pushState = () => {
      historyWrites += 1;
    };
    window.history.replaceState = () => {
      historyWrites += 1;
    };
    const hrefBefore = window.location.href;

    liveCy().$id(id).emit("tap");
    await settle();
    // Restored before the assertions, so a failing expectation cannot leak the
    // counting wrapper into the next test.
    globalScope.fetch = scriptedFetch;

    // The toggle really happened — otherwise "nothing was written" is vacuous.
    expect(members.filter((cr) => !isRendered(liveCy(), cr))).toEqual([]);
    expect(liveCy().$id(id).data("collapsed")).toBe(false);

    // …and it reached no server, no storage, no history entry, no URL.
    expect(fetchCalls).toBe(0);
    expect(storageWrites).toBe(0);
    expect(historyWrites).toBe(0);
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  test("expansion survives NOTHING: a fresh mount starts collapsed even when a seeded store and URL claim otherwise", async () => {
    // The other half of "not persisted": a fresh app must not RESTORE an
    // expansion from anywhere. Every plausible carrier is pre-seeded before the
    // app boots — storage keys in the app's own `crucible.*` namespace, plus a
    // query and a hash on the URL — and the graph must still come up collapsed.
    const seeded = ["0.1.0"];
    await mountLiveRoadmapGraph({
      pathname: "/p/live-roadmap/roadmap?expand=0.1.0#expand=0.1.0",
      beforeBoot: () => {
        for (const key of [
          "crucible.roadmap.expanded",
          "crucible.roadmap.collapse",
          "crucible.roadmap.releases.expanded",
        ]) {
          window.localStorage.setItem(key, JSON.stringify(seeded));
          window.sessionStorage.setItem(key, JSON.stringify(seeded));
        }
      },
    });
    const cy = liveCy();

    // Guard: this really is the roadmap graph, and the seeded URL did not
    // derail the route (routeParse reads `location.pathname` only).
    expect(window.location.search).toBe("?expand=0.1.0");
    expect(document.querySelector('[data-testid="roadmap-graph"]')).not.toBeNull();

    const id = releaseNodeId("0.1.0");
    expect(cy.$id(id).data("collapsed")).toBe(true);
    expect(membersInQueue(REAL_RELEASES.find((r) => r.version === "0.1.0")!).filter((cr) =>
      isRendered(cy, cr),
    )).toEqual([]);
  });

  test("collapse is by RELEASE and by nothing else: the graph draws no wave container and no lane", async () => {
    // AC5/§S3 — that chrome is CR-CRU-085's, so a GREEN cannot satisfy AC4 by
    // grouping the flow on waves. `data.wave` ON a CR node is legitimate
    // carried data (AC8); a wave CONTAINER is the forbidden thing, and in
    // cytoscape a container box IS a compound parent.
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    const types = [...new Set(cy.nodes().map((n) => stringData(n, "type")))].sort();
    expect(types).toEqual(["cr", "milestone", "terminal"]);
    const compoundParents = cy
      .nodes()
      .map((n) => (n.isParent() ? stringData(n, "id") : ""))
      .filter((id) => id !== "");
    expect(compoundParents).toEqual([]);
    const compoundChildren = cy
      .nodes()
      .map((n) => (stringData(n, "parent") === "" ? "" : stringData(n, "id")))
      .filter((id) => id !== "");
    expect(compoundChildren).toEqual([]);

    // Nor as DOM chrome around the canvas. SCOPED to the graph container:
    // CR-CRU-078 §S1 renders the TABLE zone beside the graph, and the table's
    // own `roadmap-wave-divider` headings are AC16's legitimate chrome — a
    // document-wide query only equalled "the graph draws none" while the
    // exclusive toggle guaranteed the table was absent.
    const container = document.querySelector('[data-testid="roadmap-graph"]');
    expect(container).not.toBeNull();
    expect(container!.querySelectorAll('[data-testid*="wave"], [data-testid*="lane"]').length).toBe(0);
    expect(container!.querySelectorAll('[data-testid="roadmap-wave-divider"]').length).toBe(0);
  });
});

// ── CR-CRU-077 §S4 / AC7 — live state is MOTION, and only IN_PROGRESS has it ─
//
// Spec: §S4 ("Labels lead with the CR id + terse status. Active CRs carry
// animated inflow, a pulsing ring and cycle position; everything else is
// static"), AC7 ("only nodes for `IN_PROGRESS` CRs carry live/animated state;
// `COMPLETED`, `COMPLETED_UNTRACKED` … and `PENDING` nodes are static.
// Asserted on the rendered output, since the previous animation attempt looked
// correct in source while binding nothing"), and DN decision 6, "Motion means
// live … so motion always means 'work is happening right now'".
//
// WHAT ACTUALLY DRIVES ANIMATION IN THIS STACK — measured, not assumed:
//   • Nothing does, today. The graph's entire live-state vocabulary is four
//     STATIC stylesheet rules (public/app.js:2552-2573): each derived status
//     maps to a border/background colour pair, IN_PROGRESS included (#eab308
//     on #3f2d0a). No cytoscape class, no animation, no overlay, no timer.
//   • A CSS keyframe cannot reach a node. Cytoscape draws to a <canvas>, so
//     the app's own keyframe idiom (`app-run-pulse`, public/styles.css:1026)
//     has no per-node element to land on. The only things that can move a
//     node or an edge here are cytoscape's own element animations
//     (`ele.animate`, which drives the canvas-side `overlay-*`/border/
//     `line-dash-offset` properties) or a timer/SSE-driven restyle.
//   • Both DO run and DO step under this harness — measured with the real
//     vendored cytoscape in happy-dom: one `ele.animate({style:{…}})` moved
//     the rendered `border-width` 2 → 6.99 → 12 across 800ms with
//     `ele.animated()` true throughout, and a self-restarting animation kept
//     the rendered value moving indefinitely (5.0 / 4.0 / 2.99 / 5.99 / 3.01
//     at 150ms intervals). So the mechanism AC7 needs is available AND
//     observable here; nothing below asks for something the stack cannot do.
//   • An un-animated element is byte-stable. The full rendered style of a
//     COMPLETED, a PENDING and an IN_PROGRESS node, plus their edges, was
//     IDENTICAL over 600ms, 2.6s and 5.6s — the last window crossing the
//     app's own 5s poll and the SSE restyle at public/app.js:2724 — on one
//     cytoscape instance that is never remounted.
//
// SO AC7 IS ASSERTED AS MOTION, on the rendered output, and as nothing else:
//   1. LIVE = the node's own rendered style CHANGES over a real window with
//      no interaction (§S4's pulsing ring) AND at least one of its INBOUND
//      edges does too (§S4's animated inflow). This is the assertion the CR's
//      Risk section demands: a declaration that binds nothing — the mermaid
//      animation directive that "looked correct in source" — cannot move a
//      rendered value, so it fails here. A source string, a class name or a
//      stylesheet rule alone would not.
//   2. STATIC = the same fingerprint, over the same window, unchanged.
//      Measured stable above, so this is a real discriminator, not a race.
//   3. A node's fingerprint is its OWN rendering plus its OWN inflow. An edge
//      feeding a live CR is that CR's inflow and is never counted against its
//      upstream node's staticness.
//   4. Sampled FOUR times across ~480ms against the first sample, so a
//      periodic animation cannot alias back to its starting phase and read as
//      static.
//
// THE CYCLE POSITION — the data path, measured. A position lives on
// `plan.cycles`, and public/app.js:2354 already computes it:
// `roadmapCyclePosition(plan)` → `cycle <i+1>/<n>` for the plan's ACTIVE
// cycle, `null` when no cycle is active (the table's lane badge then degrades
// to a bare `▶`, public/app.js:2362). The BUILDER cannot supply it — it is
// handed queue entries and releases only — but the RENDERER can:
// `state.plans` sits in the same module scope as `mountRoadmapCy`, and
// `RoadmapPanelBody` already reads it (`Array.from(state.plans)`, :2437) for
// that badge. The missing piece is WIRING, not data: `RoadmapGraphBody`
// (:2738) reads `state.queue` + `state.releases` and hands `mountRoadmapCy`
// no plans at all, so today the mount has no cycle in reach and the rendered
// label of an IN_PROGRESS node is exactly `<cr> ▶` (measured). The tests
// below therefore feed plans through the app's OWN
// `GET /api/v2/projects/<key>/plans` payload — the same wire that badge is
// fed by — and read the position back off the rendered node. Nothing is
// fabricated: with no active cycle, the marker must appear with NO position.

/** Four CRs, one per derived status, wired so each has its own inflow. */
const LIVE_STATE_QUEUE: QueueEntryFixture[] = [
  { cr: "CR-DONE", title: "Merged", wave: "5", dependsOn: [], status: "COMPLETED", planId: 401 },
  {
    cr: "CR-UNTRACKED",
    title: "Shipped, unproven",
    wave: "5",
    dependsOn: ["CR-DONE"],
    status: "COMPLETED_UNTRACKED",
  },
  {
    cr: "CR-LIVE",
    title: "Running now",
    wave: "6",
    dependsOn: ["CR-DONE"],
    status: "IN_PROGRESS",
    planId: 402,
  },
  { cr: "CR-PEND", title: "Not started", wave: "6", dependsOn: ["CR-LIVE"], status: "PENDING" },
];

/** CR-LIVE's plan, mid-flight: cycle 2 of 3 is the ACTIVE one. */
const LIVE_STATE_PLANS: PlanFixture[] = [
  {
    planId: 401,
    cr: "CR-DONE",
    projectKey: "live-state",
    status: "closed",
    cycles: [{ id: 1, label: "C1", status: "done" }],
  },
  {
    planId: 402,
    cr: "CR-LIVE",
    projectKey: "live-state",
    status: "open",
    track: "track-1",
    cycles: [
      { id: 2, label: "C1", status: "done" },
      { id: 3, label: "C2", status: "active" },
      { id: 4, label: "C3", status: "pending" },
    ],
  },
];

/**
 * The same plan with NO active cycle — `roadmapCyclePosition` returns null
 * here, which is the case a fabricated position would paper over.
 */
const NO_ACTIVE_CYCLE_PLANS: PlanFixture[] = [
  {
    planId: 402,
    cr: "CR-LIVE",
    projectKey: "live-state",
    status: "open",
    track: "track-1",
    cycles: [
      { id: 2, label: "C1", status: "done" },
      { id: 3, label: "C2", status: "done" },
    ],
  },
];

/** The live-state shape in the GRAPH view, real cytoscape, real app.js. */
async function mountLiveStateGraph(plans: PlanFixture[] = []): Promise<void> {
  await mountApp({
    pathname: "/p/live-state/roadmap",
    projects: [project({ key: "live-state" })],
    queue: LIVE_STATE_QUEUE,
    plans,
    cytoscape: true,
  });
  // §S1 — the graph renders unconditionally; nothing to click.
}

/** One element's whole RESOLVED style, as cytoscape currently draws it. */
const elementStyleJson = (ele: CyCollection): string => {
  const resolved = ele.style();
  return typeof resolved === "object" && resolved !== null ? JSON.stringify(resolved) : String(resolved);
};

/** The ids of the drawn edges that flow INTO a node — its inflow. */
const inflowEdgeIds = (cy: CyHandle, id: string): string[] =>
  cy
    .edges()
    .map((e) => (stringData(e, "target") === id ? stringData(e, "id") : ""))
    .filter((edgeId) => edgeId !== "")
    .sort();

/** A node's rendering, and its inflow's rendering, as two comparable strings. */
interface Fingerprint {
  node: string;
  inflow: string;
}
const fingerprint = (cy: CyHandle, id: string): Fingerprint => ({
  node: elementStyleJson(cy.$id(id)),
  inflow: cy
    .edges()
    .map((e) =>
      stringData(e, "target") === id ? `${stringData(e, "id")}=${elementStyleJson(e)}` : "",
    )
    .filter((sample) => sample !== "")
    .sort()
    .join("\u0000"),
});

/** Did it MOVE? — per node, node-side and inflow-side, separately. */
interface Motion {
  node: boolean;
  inflow: boolean;
}

/**
 * Sample the rendered fingerprints of `ids` four times across ~480ms with NO
 * interaction, and report what changed against the first sample. The live
 * instance is re-read each round, so an implementation that remounts is
 * measured on whatever it publishes rather than on a stale handle.
 *
 * Real elapsed time is the point (see `settle`'s note): fake timers would
 * freeze van's scheduler AND cytoscape's animation loop, which is the very
 * thing under test.
 */
async function motionByNode(ids: string[]): Promise<Record<string, Motion>> {
  const first: Record<string, Fingerprint> = {};
  const moved: Record<string, Motion> = {};
  for (const id of ids) {
    first[id] = fingerprint(liveCy(), id);
    moved[id] = { node: false, inflow: false };
  }
  for (let round = 0; round < 4; round += 1) {
    await settle(6);
    for (const id of ids) {
      const now = fingerprint(liveCy(), id);
      if (now.node !== first[id].node) moved[id].node = true;
      if (now.inflow !== first[id].inflow) moved[id].inflow = true;
    }
  }
  return moved;
}

/**
 * Every piece of text the graph RENDERS for a node: its resolved label (the
 * canvas text cytoscape paints, read through the stylesheet's own `label`
 * mapper) plus any DOM text the graph container carries, so a DOM overlay is
 * measured as fairly as a canvas label. Neither is pinned by AC7.
 */
const renderedNodeText = (cy: CyHandle, id: string): string => {
  const label = cy.$id(id).style("label");
  const container = document.querySelector('[data-testid="roadmap-graph"]');
  return `${typeof label === "string" ? label : ""} ${container?.textContent ?? ""}`;
};

describe("CR-CRU-077 §S4/AC7 — only an IN_PROGRESS CR carries live state, and live means MOTION", () => {
  test("the fixture really carries all FOUR derived statuses, each rendered with its own inflow — the negatives below cannot pass on an empty set", async () => {
    // Non-vacuity, both halves: every status value AC7 names is present as a
    // real drawn node, and every one of them has at least one drawn inbound
    // edge, so "its inflow is static" is never a claim about no edges.
    expect([...new Set(LIVE_STATE_QUEUE.map((e) => e.status))].sort()).toEqual([
      "COMPLETED",
      "COMPLETED_UNTRACKED",
      "IN_PROGRESS",
      "PENDING",
    ]);
    await mountLiveStateGraph();
    const cy = liveCy();
    for (const entry of LIVE_STATE_QUEUE) {
      expect({ cr: entry.cr, rendered: isRendered(cy, entry.cr) }).toEqual({
        cr: entry.cr,
        rendered: true,
      });
      // The RENDERED status, read off cytoscape — the value the stylesheet and
      // any live-state rule actually see.
      expect(stringData(cy.$id(entry.cr), "status")).toBe(entry.status);
      expect(inflowEdgeIds(cy, entry.cr).length).toBeGreaterThan(0);
    }
  });

  test("an IN_PROGRESS CR's node AND its inflow MOVE with no interaction — a declaration that binds nothing fails here", async () => {
    await mountLiveStateGraph();
    // Guard: the inflow being measured exists, so "the inflow moved" is a
    // claim about a real edge.
    expect(inflowEdgeIds(liveCy(), "CR-LIVE")).toEqual(["dep:CR-DONE->CR-LIVE"]);

    const moved = await motionByNode(["CR-LIVE"]);
    // §S4's two live affordances, separately: the pulsing ring is the node
    // moving, the animated inflow is its inbound edge moving.
    expect(moved["CR-LIVE"]).toEqual({ node: true, inflow: true });
  });

  test("COMPLETED, COMPLETED_UNTRACKED and PENDING nodes are STATIC — one assertion per derived value, so 'animate anything not listed' fails on the fourth", async () => {
    await mountLiveStateGraph();
    const moved = await motionByNode(["CR-LIVE", "CR-DONE", "CR-UNTRACKED", "CR-PEND"]);

    // WINDOW FENCE, first: the live CR moved in the SAME sampling window, so
    // "nothing moved" below is a fact about those nodes and not about a window
    // too short to see motion at all.
    expect(moved["CR-LIVE"]).toEqual({ node: true, inflow: true });

    // One assertion per value AC7 names as static.
    expect(moved["CR-DONE"]).toEqual({ node: false, inflow: false });
    expect(moved["CR-UNTRACKED"]).toEqual({ node: false, inflow: false });
    expect(moved["CR-PEND"]).toEqual({ node: false, inflow: false });
    // …and the whole picture in one diff, so a failure names the status that
    // leaked motion (CR-PEND's inflow is the LIVE node's outflow: motion there
    // would read as "work is happening" on a CR nobody has started).
    expect(moved).toEqual({
      "CR-LIVE": { node: true, inflow: true },
      "CR-DONE": { node: false, inflow: false },
      "CR-UNTRACKED": { node: false, inflow: false },
      "CR-PEND": { node: false, inflow: false },
    });
  });

  test("the live node renders its CYCLE POSITION in roadmapCyclePosition's own N/M form", async () => {
    await mountLiveStateGraph(LIVE_STATE_PLANS);
    const cy = liveCy();
    expect(isRendered(cy, "CR-LIVE")).toBe(true);

    // The position the app's OWN helper computes for this plan — index of the
    // ACTIVE cycle, one-based, over the cycle count (public/app.js:2354).
    const plan = LIVE_STATE_PLANS.find((p) => p.cr === "CR-LIVE")!;
    const activeIndex = plan.cycles.findIndex((c) => c.status === "active");
    expect(activeIndex).toBe(1);
    expect(plan.cycles.length).toBe(3);
    const expectedPosition = `${activeIndex + 1}/${plan.cycles.length}`;

    const text = renderedNodeText(cy, "CR-LIVE");
    expect(text).toContain(expectedPosition);
    // …and it is the RIGHT position: no OTHER N/M is rendered for it, so an
    // off-by-one or a hard-coded "1/1" fails instead of passing on containment.
    expect([...new Set(text.match(/\d+\/\d+/g) ?? [])]).toEqual([expectedPosition]);
  });

  test("with NO active cycle the live marker still appears, and NO position is fabricated", async () => {
    await mountLiveStateGraph(NO_ACTIVE_CYCLE_PLANS);
    const cy = liveCy();
    // Fixture guard: this plan really has no active cycle, so `null` is what
    // the helper returns for it.
    const plan = NO_ACTIVE_CYCLE_PLANS.find((p) => p.cr === "CR-LIVE")!;
    expect(plan.cycles.some((c) => c.status === "active")).toBe(false);

    // No invented position — the lane badge's own degradation (a bare `▶`).
    expect(renderedNodeText(cy, "CR-LIVE").match(/\d+\/\d+/g)).toBeNull();
    // …and the CR is still LIVE: an absent position never downgrades an
    // IN_PROGRESS CR to static.
    expect(await motionByNode(["CR-LIVE"])).toEqual({
      "CR-LIVE": { node: true, inflow: true },
    });
  });
});

// ── CR-CRU-077 AC9 — the LIVE roadmap renders, at whatever size it is ───────
//
// AC9: "the graph renders the live roadmap at whatever size it currently is
// … without a parse/layout error, and `unknownDependencies` stays empty. The
// count is deliberately not pinned: a hard-coded size fails on the next CR
// filed rather than on a defect." So nothing below asserts a CR count — only
// that the fixture is the real thing and big enough to be a real layout.
//
// "No parse/layout error" is measured three ways, all on the render:
//   • no window `error`, no `unhandledrejection` and no `console.error` from
//     boot through the mounted graph (measured baseline today: zero of each);
//   • the instance is PUBLISHED — a throw inside the mount callback never
//     reaches `window.crucibleRoadmapCy = cy`, so `liveCy()` failing names it;
//   • every DRAWN node has a finite, non-NaN position, and those positions are
//     spread over more than one rank/row — dagre really ran, rather than
//     leaving 94 nodes piled on one point. Positions are read for the DRAWN
//     set only: the collapse layout runs over `:visible` by design, so a
//     folded-away node legitimately keeps its pre-layout (0,0).
//
// `unknownDependencies` is not a builder output — it is the queue-side fact
// that every declared `depends-on` resolves to a real row, and it is asserted
// here on the SAME live fixture the render is driven from, plus its rendered
// consequence: no drawn edge may reference a node the graph does not have.

/** The drawn nodes and the positions the layout gave them. */
interface DrawnNode {
  id: string;
  x: number;
  y: number;
}
const drawnNodes = (cy: CyHandle): DrawnNode[] => {
  const rows: DrawnNode[] = [];
  for (const row of cy
    .nodes()
    .map((n) => (n.visible() ? { id: stringData(n, "id"), at: n.position() } : undefined))) {
    if (row !== undefined) rows.push({ id: row.id, x: row.at.x, y: row.at.y });
  }
  return rows;
};

/** Names the nodes a layout failure would leave at NaN/Infinity. */
const notLaidOut = (drawn: DrawnNode[]): string[] =>
  drawn
    .filter((d) => !Number.isFinite(d.x) || !Number.isFinite(d.y))
    .map((d) => `${d.id}@${d.x},${d.y}`);

/** Any edge END that is not a node of the graph — a dependency to nowhere. */
const edgeEndsWithoutNode = (cy: CyHandle): string[] =>
  cy
    .edges()
    .map((e) => {
      const source = stringData(e, "source");
      const target = stringData(e, "target");
      const missing = [source, target].filter((end) => !cy.$id(end).nonempty());
      return missing.length === 0 ? "" : `${source}->${target} missing ${missing.join("+")}`;
    })
    .filter((problem) => problem !== "");

describe("CR-CRU-077 AC9 — the live roadmap renders at its current size, with no parse or layout error", () => {
  test("the live shape mounts clean: nothing thrown or logged, every drawn node laid out, unknownDependencies empty", async () => {
    // The queue-side half of AC9, on the same fixture the render uses. Guarded
    // on the fixture being the real thing rather than on its size.
    expect(REAL_ENTRIES.length).toBeGreaterThan(80);
    expect(REAL_RELEASES.length).toBe(4);
    const queued = new Set(REAL_ENTRIES.map((e) => e.cr));
    const unknownDependencies = [
      ...new Set(REAL_ENTRIES.flatMap((e) => e.dependsOn).filter((d) => !queued.has(d))),
    ].sort();
    expect(unknownDependencies).toEqual([]);

    const failures: string[] = [];
    let restoreConsole = (): void => undefined;
    await mountLiveRoadmapGraph({
      // Installed INSIDE the freshly registered window, before the app boots,
      // so a throw or an error log from the mount itself is captured.
      beforeBoot: () => {
        window.addEventListener("error", (event) => failures.push(`error: ${event.message}`));
        window.addEventListener("unhandledrejection", (event) =>
          failures.push(`unhandledrejection: ${String(event.reason)}`),
        );
        const original = console.error;
        restoreConsole = () => {
          console.error = original;
        };
        console.error = (...args: unknown[]) => {
          failures.push(`console.error: ${args.map((a) => String(a)).join(" ")}`);
        };
      },
    });
    // Restored before any assertion, so a failing expectation cannot leak the
    // capturing console into the next test.
    restoreConsole();

    // The instance exists — a parse/layout throw never gets this far.
    const cy = liveCy();
    expect(failures).toEqual([]);

    // Everything the builder emitted for the live shape is IN the graph…
    const graph = buildRoadmapGraph(REAL_ENTRIES, REAL_RELEASES);
    expect(cy.nodes().length).toBe(graph.nodes.length);
    expect(edgeEndsWithoutNode(cy)).toEqual([]);

    // …and everything DRAWN was actually laid out, over a real 2-D spread.
    const drawn = drawnNodes(cy);
    expect(notLaidOut(drawn)).toEqual([]);
    expect(drawn.length).toBeGreaterThan(20);
    expect(new Set(drawn.map((d) => d.x)).size).toBeGreaterThan(1);
    expect(new Set(drawn.map((d) => d.y)).size).toBeGreaterThan(1);
  });

  test("AC9 holds in BOTH collapse states — the fold reroute changes the graph dagre is given", async () => {
    await mountLiveRoadmapGraph();
    const collapsed = drawnNodes(liveCy());
    expect(notLaidOut(collapsed)).toEqual([]);
    expect(collapsed.length).toBeGreaterThan(20);

    // Expand every release: each tap re-routes the `fold:` edges and re-runs
    // dagre over a different drawn subgraph — the layout C4 made conditional.
    for (const rel of REAL_RELEASES) {
      liveCy().$id(releaseNodeId(rel.version)).emit("tap");
      await settle();
    }
    const cy = liveCy();
    const expanded = drawnNodes(cy);

    // Non-vacuous: the two states really are different graphs, and the second
    // one draws the whole roadmap.
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.length).toBe(cy.nodes().length);
    expect(notLaidOut(expanded)).toEqual([]);
    expect(new Set(expanded.map((d) => d.x)).size).toBeGreaterThan(1);
    expect(new Set(expanded.map((d) => d.y)).size).toBeGreaterThan(1);
    expect(edgeEndsWithoutNode(cy)).toEqual([]);
  });
});

// ── CR-CRU-077 VERIFY round (cycle 287) — the RENDERED half of AC2/AC4 ──────
//
// Nine ACs passed at the BUILDER boundary. Two of them do not hold once the
// graph is actually DRAWN and actually LIVE, and one harness defect is what hid
// them: mountApp's scripted `Response.json()` resolved the SAME body object on
// every call, so `vanX.replace` wrote identical identities back, nothing
// notified, and no test in this file had ever observed a second render. With
// `json()` parsing fresh objects the way a real Response does, both defects are
// reachable:
//
//   1. EXPANSION DOES NOT SURVIVE A LIVE RE-RENDER. `expanded` is a `const
//      expanded = new Set()` INSIDE the mount callback (public/app.js), and
//      `RoadmapGraphBody` re-runs on every `state.queue`/`state.plans`/
//      `state.releases` change, so one poll tick silently re-collapses whatever
//      the user opened. This file already holds the precedent for the fix —
//      `lensOpenKeys` (app.js) and `state.collapsedCycles` (app.js:45-51,
//      "Keyed OUTSIDE the render tree … so poll-tick re-renders … never reset an
//      expansion").
//   2. THE CARRIED ORDER NEVER REACHES THE LAYOUT. AC2's `data.seq` is consumed
//      by nothing: cytoscape-dagre's documented `sort` option
//      (public/cytoscape-dagre.js:206-213, applied at :419/:445) is not passed,
//      so dagre orders same-rank siblings on its own and the authored queue
//      order is invisible on the canvas.
//
// Both are RENDER assertions on the live instance, driven the same way the AC4
// collapse tests above are: real app.js, real vendored cytoscape + dagre, live
// shape. No new production seam — happy-dom ships no `EventSource`, so app.js
// takes its own §S5 poll fallback (`setInterval(refetch, 5000)`), which is the
// same re-render an SSE change frame drives in the browser.

/** cytoscape's `data(key)` for a numeric field — narrowed, never asserted. */
const numberData = (node: CyCollection, key: string): number => {
  const value = node.data(key);
  return typeof value === "number" ? value : Number.NaN;
};

/**
 * happy-dom ships NO `EventSource`, so public/app.js normally degrades to its
 * §S5 5s `setInterval(refetch, 5000)` poll. Installing a SCRIPTABLE one lets a
 * test drive the app's OWN live path — an SSE change frame → `refetch()`
 * (app.js `connectStream`) — with no wall-clock wait and no guessed duration.
 * The handlers invoked are app.js's own; nothing here is a production seam,
 * exactly like installCytoscape's 2d-context stub above.
 */
interface ScriptedStream {
  /** Deliver one SSE change frame to every stream the app opened. */
  changeFrame: () => void;
}
function installEventSource(): ScriptedStream {
  const opened: { onmessage: (() => void) | null }[] = [];
  class StubEventSource {
    static readonly CLOSED = 2;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) {
      opened.push(this);
    }
    close(): void {
      this.readyState = StubEventSource.CLOSED;
    }
  }
  // The global EventSource slot. happy-dom leaves it undefined and this
  // project's lib set carries no declaration for it, so the write goes through
  // ONE named boundary const — the same shape the `canvasProto` stub above uses.
  const globalScope: { EventSource: unknown } = globalThis as unknown as {
    EventSource: unknown;
  };
  globalScope.EventSource = StubEventSource;
  return {
    changeFrame: () => {
      if (opened.length === 0) throw new Error("public/app.js opened no EventSource");
      for (const stream of opened) stream.onmessage?.();
    },
  };
}

/**
 * The live roadmap graph over a MUTABLE COPY of the queue payload plus the
 * stream handle: a test edits the copy, delivers one change frame, and the app
 * refetches and re-renders on its own. The shared fixture arrays stay untouched.
 */
async function mountStreamedRoadmapGraph(): Promise<{
  served: BuilderEntry[];
  changeFrame: () => Promise<void>;
}> {
  const served: BuilderEntry[] = REAL_ENTRIES.map((e) => ({ ...e }));
  let stream: ScriptedStream | undefined;
  await mountApp({
    pathname: "/p/live-roadmap/roadmap",
    projects: [project({ key: "live-roadmap" })],
    queue: served,
    releases: REAL_RELEASES,
    cytoscape: true,
    beforeBoot: () => {
      stream = installEventSource();
    },
  });
  // §S1 — the graph renders unconditionally; nothing to click.
  return {
    served,
    changeFrame: async () => {
      stream!.changeFrame();
      await settle();
    },
  };
}

describe("CR-CRU-077 §S2/AC4 — an expansion SURVIVES the live re-render, and still survives no reload", () => {
  test("one CHANGED queue payload re-renders the graph and the expanded release STAYS expanded", async () => {
    const { served, changeFrame } = await mountStreamedRoadmapGraph();
    const id = releaseNodeId("0.1.0");
    const members = membersInQueue(REAL_RELEASES.find((r) => r.version === "0.1.0")!);
    expect(members.length).toBeGreaterThan(0);

    const before = liveCy();
    expect(before.$id(id).data("collapsed")).toBe(true);
    before.$id(id).emit("tap");
    await settle();
    // Precondition, measured: the expansion really happened.
    expect(members.filter((cr) => !isRendered(liveCy(), cr))).toEqual([]);
    expect(liveCy().$id(id).data("collapsed")).toBe(false);

    // ONE changed payload. The churn is a status flip on an UNRELEASED CR, so
    // release membership — and therefore the fold set — is untouched and only
    // the re-render is under test.
    const churned = served.find((e) => e.cr === "CR-CRU-078")!;
    expect(churned.status).toBe("PENDING");
    expect(ALL_RELEASED.has(churned.cr)).toBe(false);
    churned.status = "IN_PROGRESS";
    await changeFrame();

    // The re-render REALLY happened — the changed payload landed AND the body
    // rebuilt its instance. Without both, "the expansion survived" is vacuous.
    const after = liveCy();
    expect(after.$id("CR-CRU-078").data("status")).toBe("IN_PROGRESS");
    expect(after).not.toBe(before);

    // …and the expansion is still there, on the release the user opened only.
    expect(members.filter((cr) => !isRendered(after, cr))).toEqual([]);
    expect(after.$id(id).data("collapsed")).toBe(false);
    expect(after.$id(releaseNodeId("0.1.2")).data("collapsed")).toBe(true);
    expect(isRendered(after, "CR-CRU-066")).toBe(false);
  });

  test("a FRESH page load still comes up collapsed — surviving a re-render is not surviving a reload (§S2)", async () => {
    // The fence against fixing the test above with storage/URL: the expansion
    // must live in the PAGE and nowhere a reload can reach.
    await mountStreamedRoadmapGraph();
    const id = releaseNodeId("0.1.0");
    const members = membersInQueue(REAL_RELEASES.find((r) => r.version === "0.1.0")!);
    liveCy().$id(id).emit("tap");
    await settle();
    expect(liveCy().$id(id).data("collapsed")).toBe(false);

    // A real reload: a brand-new window and a brand-new app.js evaluation.
    await mountLiveRoadmapGraph();
    const cy = liveCy();
    expect(cy.$id(id).data("collapsed")).toBe(true);
    expect(members.filter((cr) => isRendered(cy, cr))).toEqual([]);
  });

  test("the retired instance is DESTROYED on remount, not abandoned with its canvas and listeners", async () => {
    const { served, changeFrame } = await mountStreamedRoadmapGraph();
    const before = liveCy();
    expect(before.destroyed()).toBe(false);

    served.find((e) => e.cr === "CR-CRU-078")!.status = "IN_PROGRESS";
    await changeFrame();

    const after = liveCy();
    // Non-vacuous: a remount really happened, so "the old one is gone" is a
    // claim about a retired instance rather than about the live one.
    expect(after).not.toBe(before);
    expect(after.destroyed()).toBe(false);
    expect(before.destroyed()).toBe(true);
  });
});

// ── CR-CRU-077 §S1/AC2 — the carried order reaches the DRAWING ──────────────
//
// Under `rankDir: "LR"` a dagre rank is a COLUMN: every node of one rank shares
// an x (no `boundingBox` is passed, so the positions are dagre's own), and y is
// the within-rank order the layout chose. `data.seq` is the authored queue
// position. So "the authored order is visible" is exactly: within each column,
// increasing y means increasing seq.

interface RankedCr {
  id: string;
  seq: number;
  x: number;
  y: number;
}

/** Every DRAWN CR node with its authored position and the place dagre gave it. */
const drawnRankedCrs = (cy: CyHandle): RankedCr[] => {
  const rows: RankedCr[] = [];
  for (const row of cy
    .nodes('[type="cr"]')
    .map((n) =>
      n.visible()
        ? { id: stringData(n, "id"), seq: numberData(n, "seq"), at: n.position() }
        : undefined,
    )) {
    if (row !== undefined) rows.push({ id: row.id, seq: row.seq, x: row.at.x, y: row.at.y });
  }
  return rows;
};

/** The drawn CR columns, each sorted by the y the layout assigned. */
const drawnCrColumns = (cy: CyHandle): RankedCr[][] => {
  const columns = new Map<string, RankedCr[]>();
  for (const cr of drawnRankedCrs(cy)) {
    // Rounded so float noise cannot split one rank into two columns.
    const key = cr.x.toFixed(6);
    const bucket = columns.get(key);
    if (bucket === undefined) columns.set(key, [cr]);
    else bucket.push(cr);
  }
  return [...columns.values()]
    .filter((bucket) => bucket.length > 1)
    .map((bucket) => [...bucket].sort((a, b) => a.y - b.y));
};

/** Adjacent same-rank CR pairs the drawing puts out of authored order, NAMED. */
const outOfAuthoredOrder = (cy: CyHandle): string[] => {
  const wrong: string[] = [];
  for (const column of drawnCrColumns(cy)) {
    for (let i = 1; i < column.length; i++) {
      const above = column[i - 1];
      const below = column[i];
      if (above.seq > below.seq) {
        wrong.push(
          `rank x=${above.x.toFixed(1)}: ${above.id} (seq ${above.seq}) drawn above ` +
            `${below.id} (seq ${below.seq})`,
        );
      }
    }
  }
  return wrong;
};

/** How many adjacent same-rank CR pairs the drawing even has — non-vacuity. */
const adjacentSameRankPairs = (cy: CyHandle): number =>
  drawnCrColumns(cy).reduce((total, column) => total + column.length - 1, 0);

describe("CR-CRU-077 §S1/AC2 — the authored queue order is visible in the DRAWN graph", () => {
  test("within every drawn rank, the CRs are laid out in authored `data.seq` order — the out-of-order pairs are named", async () => {
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    // Non-vacuity, both halves: the layout really ran (finite positions) and it
    // really does stack CRs within ranks, so "in order" is a claim about a
    // populated set of same-rank pairs rather than about no pairs at all.
    const drawn = drawnRankedCrs(cy);
    expect(drawn.length).toBeGreaterThan(20);
    expect(drawn.filter((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y))).toEqual([]);
    expect(drawn.filter((c) => !Number.isFinite(c.seq))).toEqual([]);
    expect(adjacentSameRankPairs(cy)).toBeGreaterThan(10);

    expect(outOfAuthoredOrder(cy)).toEqual([]);
  });

  test("…and in the fully EXPANDED state too, where every released CR is drawn as well", async () => {
    await mountLiveRoadmapGraph();
    for (const rel of REAL_RELEASES) {
      liveCy().$id(releaseNodeId(rel.version)).emit("tap");
      await settle();
    }
    const cy = liveCy();
    expect(drawnRankedCrs(cy).length).toBe(REAL_ENTRIES.length);
    expect(adjacentSameRankPairs(cy)).toBeGreaterThan(10);

    expect(outOfAuthoredOrder(cy)).toEqual([]);
  });
});

// ── CR-CRU-077 §S2/AC4 — the fold credits the SAME diamond the builder does ──

/** A graph mount over an arbitrary queue + ledger, real cytoscape. */
async function mountGraph(
  key: string,
  queue: BuilderEntry[],
  releases: BuilderRelease[],
): Promise<void> {
  await mountApp({
    pathname: `/p/${key}/roadmap`,
    projects: [project({ key })],
    queue,
    releases,
    cytoscape: true,
  });
}

// One CR claimed by TWO tags. The builder resolves it in SHIP order — the older
// claim wins, "since that is when it shipped" (app-logic.mjs) — so
// `rel:ship:CR-DUP->0.2.0` is the edge it emits. The live payload arrives
// NEWEST-FIRST, so a render that iterates the ledger as given credits the
// NEWEST claim instead and folds CR-DUP under the wrong diamond, leaving a
// backwards `fold:milestone:0.3.0->milestone:0.2.0` where its ship edge was.
const OVERLAP_QUEUE: BuilderEntry[] = [
  { cr: "CR-DUP", title: "Doubly claimed", wave: "1", dependsOn: [], status: "COMPLETED" },
  { cr: "CR-LATER", title: "Later", wave: "2", dependsOn: ["CR-DUP"], status: "COMPLETED" },
  { cr: "CR-OPEN", title: "Open", wave: "3", dependsOn: ["CR-LATER"], status: "PENDING" },
];
const OVERLAP_RELEASES: BuilderRelease[] = [
  { version: "0.3.0", releasedAt: 2000, crs: ["CR-DUP", "CR-LATER"], timestamp: 20 },
  { version: "0.2.0", releasedAt: 1000, crs: ["CR-DUP"], timestamp: 10 },
];

describe("CR-CRU-077 §S2/AC4 — a doubly-claimed CR folds under the diamond the BUILDER credits", () => {
  test("the older claim wins on BOTH sides: no backwards diamond→diamond fold, and expanding 0.2.0 is what reveals CR-DUP", async () => {
    // Fixture guard: the builder really credits the OLDER tag, so the render's
    // tie-break has a definite right answer to match.
    const g = buildRoadmapGraph(OVERLAP_QUEUE, OVERLAP_RELEASES);
    expect(hasEdge(g, "CR-DUP", "milestone:0.2.0")).toBe(true);
    expect(hasEdge(g, "CR-DUP", "milestone:0.3.0")).toBe(false);

    await mountGraph("overlap-older", OVERLAP_QUEUE, OVERLAP_RELEASES);
    const cy = liveCy();
    expect(cy.$id("milestone:0.2.0").nonempty()).toBe(true);
    expect(cy.$id("milestone:0.3.0").nonempty()).toBe(true);
    // Collapsed, so CR-DUP is folded away under exactly one of them.
    expect(isRendered(cy, "CR-DUP")).toBe(false);
    // A fold that credits the newer diamond reroutes CR-DUP's ship edge into a
    // 0.3.0 → 0.2.0 edge, which runs against the release chain.
    const backwards = visibleEdgeEnds(cy).filter(
      (e) => e.source === "milestone:0.3.0" && e.target === "milestone:0.2.0",
    );
    expect(backwards).toEqual([]);

    // Expanding the diamond the builder credits is what reveals it…
    cy.$id("milestone:0.2.0").emit("tap");
    await settle();
    expect(isRendered(liveCy(), "CR-DUP")).toBe(true);
  });

  test("expanding the NEWER claimant does not reveal it — the two sides cannot disagree", async () => {
    await mountGraph("overlap-newer", OVERLAP_QUEUE, OVERLAP_RELEASES);
    liveCy().$id("milestone:0.3.0").emit("tap");
    await settle();
    const cy = liveCy();
    // 0.3.0's own member is revealed, so the tap was not a no-op…
    expect(isRendered(cy, "CR-LATER")).toBe(true);
    // …while CR-DUP stays folded under 0.2.0.
    expect(isRendered(cy, "CR-DUP")).toBe(false);
  });
});

// ── CR-CRU-077 §S2/AC4 — a collapsed diamond has a RENDERED affordance ──────
//
// DN decision 1 makes a release node "expandable on click", and `data.collapsed`
// is written on every mount — but nothing renders it, so a collapsed diamond and
// an expanded one are pixel-identical and the affordance is undiscoverable. The
// app's own design language for exactly this is the ▸/▾ drill-in glyph
// (`ToggleGlyph`, public/app.js), so the state rides the diamond's label line —
// text on the node, which is what an assertion (and a user) can actually read.

describe("CR-CRU-077 §S2/AC4 — the collapse state is VISIBLE on the diamond", () => {
  test("a collapsed diamond reads ▸ and an expanded one reads ▾, on the label, and the version and count stay", async () => {
    await mountLiveRoadmapGraph();
    const id = releaseNodeId("0.1.0");

    const collapsed = stringData(liveCy().$id(id), "label");
    expect(liveCy().$id(id).data("collapsed")).toBe(true);
    expect(collapsed).toContain("▸");
    expect(collapsed).not.toContain("▾");
    // The affordance is ADDED to what AC4 already renders, never instead of it.
    expect(collapsed).toContain("0.1.0");
    expect(collapsed).toContain(`${EXPECTED_RELEASE_CR_COUNTS["0.1.0"]} CRs`);

    liveCy().$id(id).emit("tap");
    await settle();

    const expanded = stringData(liveCy().$id(id), "label");
    expect(liveCy().$id(id).data("collapsed")).toBe(false);
    expect(expanded).toContain("▾");
    expect(expanded).not.toContain("▸");
    expect(expanded).toContain("0.1.0");
    expect(expanded).toContain(`${EXPECTED_RELEASE_CR_COUNTS["0.1.0"]} CRs`);

    // Every diamond carries one, including the zero-CR release.
    const glyphless = liveCy()
      .nodes('[type="milestone"]')
      .map((m) => (/[▸▾]/.test(stringData(m, "label")) ? "" : stringData(m, "id")))
      .filter((name) => name !== "");
    expect(glyphless).toEqual([]);
  });
});

// ── CR-CRU-077 §S2 — a `fold:` reroute does not read as a declared dependency ─

describe("CR-CRU-077 §S2 — a fold reroute is drawn distinctly from a declared dependency", () => {
  test("the stylesheet carries its own edge.roadmap-fold rule, and a drawn fold edge resolves differently from a dep edge", async () => {
    await mountLiveRoadmapGraph();
    const cy = liveCy();

    const norm = (selector: string): string => selector.replace(/\s+/g, "");
    const foldRule = cy
      .style()
      .json()
      .find((r) => norm(r.selector) === "edge.roadmap-fold");
    expect(foldRule).toBeDefined();

    // …and it actually reaches the drawing: a rerouted edge and a declared
    // dependency edge, both drawn, resolve to different styles.
    const foldIds = cy
      .edges()
      .map((e) => (stringData(e, "id").startsWith("fold:") && e.visible() ? stringData(e, "id") : ""))
      .filter((id) => id !== "");
    const depIds = cy
      .edges()
      .map((e) => (stringData(e, "id").startsWith("dep:") && e.visible() ? stringData(e, "id") : ""))
      .filter((id) => id !== "");
    expect(foldIds.length).toBeGreaterThan(0);
    expect(depIds.length).toBeGreaterThan(0);
    expect(elementStyleJson(cy.$id(foldIds[0]))).not.toBe(elementStyleJson(cy.$id(depIds[0])));
  });
});

// ── CR-CRU-078 §S6 — a node with NO carried position is not "position 0" ────
//
// CR-CRU-091/AC18 made `data.seq` the stored integer, OMITTED when unusable
// rather than defaulted, precisely so "no carried position" stays a readable
// state — the one milestone and terminal nodes occupy by design. The render's
// within-rank re-seating then sorted on `(a.data("seq") ?? 0)`, which undoes
// that omission at the last possible moment: a CR with no position sorts ahead
// of every positioned one, as though the queue had authored it first.
//
// THE DECISION: a positionless node KEEPS the slot the layout gave it. Only
// the nodes that carry a position are re-seated, and only into the slots those
// same nodes already occupy. Nothing is invented — not "first", not "last",
// both of which are positions the queue never authored — and a node with no
// position can never displace one that has it. With every CR positioned (the
// live shape) this is byte-identical to seating the whole rank.
const POSITIONLESS_QUEUE: BuilderEntry[] = [
  { cr: "CR-ROOT", title: "Root", wave: "1", dependsOn: [], status: "COMPLETED", seq: 10 },
  // Emitted (and therefore laid out) in the order A, NOSEQ, B; authored LAST
  // of the three by `seq`, so a render that carries the position must lift
  // CR-B above CR-A.
  { cr: "CR-A", title: "Alpha", wave: "2", dependsOn: ["CR-ROOT"], status: "PENDING", seq: 40 },
  { cr: "CR-NOSEQ", title: "Unpositioned", wave: "2", dependsOn: ["CR-ROOT"], status: "PENDING" },
  { cr: "CR-B", title: "Beta", wave: "2", dependsOn: ["CR-ROOT"], status: "PENDING", seq: 20 },
];

/** The drawn CR columns as ids, top to bottom — the within-rank order drawn. */
const drawnColumnIds = (cy: CyHandle): string[][] =>
  drawnCrColumns(cy).map((column) => column.map((cr) => cr.id));

describe("CR-CRU-078 §S6 — a CR with no carried `seq` keeps its laid-out slot, and never sorts as position 0", () => {
  test("the fan-out rank draws CR-B above CR-A (carried order) with CR-NOSEQ left exactly where the layout put it — never hoisted to the top", async () => {
    // Fixture guard: the builder really OMITS the position, so the render is
    // being handed the state under test rather than a zero.
    const g = buildRoadmapGraph(POSITIONLESS_QUEUE, []);
    expect(missingSeq(g)).toEqual(["CR-NOSEQ"]);

    await mountGraph("positionless", POSITIONLESS_QUEUE, []);
    const columns = drawnColumnIds(liveCy());
    // Non-vacuity: the three same-wave dependants really do share one rank, so
    // there is a within-rank order to be right or wrong about.
    const rank = columns.find((column) => column.includes("CR-NOSEQ"));
    expect(rank).toBeDefined();
    expect(rank!.length).toBe(3);

    // The positioned pair is drawn in CARRIED order…
    expect(rank!.filter((id) => id !== "CR-NOSEQ")).toEqual(["CR-B", "CR-A"]);
    // …and the positionless node is NOT hoisted above them. `?? 0` puts it
    // first every time, whatever the layout chose, so this is the fence.
    expect(rank![0]).not.toBe("CR-NOSEQ");
    // It kept the middle slot dagre gave it: the re-seating moved the two
    // positioned nodes around it, not it around them.
    expect(rank!).toEqual(["CR-B", "CR-NOSEQ", "CR-A"]);
  });
});
