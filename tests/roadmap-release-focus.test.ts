// CR-CRU-078 §S4 + §S5 + §S6 — ZONE 2 (the focused release's flowchart) and
// ZONE 3 (the table scoped to that release), plus AC27's lifecycle second axis.
//
// Spec: docs/changes/CR-CRU-078-roadmap-graph-and-table-together.md
//       §S4 (only the focused release gets wave detail)
//       §S5 (the table follows the focused release)
//       §S6 (authored order is carried, never re-derived)
//       AC8, AC9, AC10, AC11, AC12, AC13, AC14, AC15, AC16, AC20, AC27
//
// SCOPE — ZONES 2 AND 3 ONLY. Zone 1's paging is C2
// (tests/roadmap-release-strip.test.ts); selection/highlight, focus durability
// and the AC19 empty state are C4; the visual grammar (AC21–AC26) is C5.
//
// WHY THIS FILE IS A SIBLING SUITE, and what it replaces.
// The now-DELETED tests/roadmap-graph.test.ts pinned CR-CRU-077's composition: a
// dependency-composed whole-project DAG laid out by cytoscape-dagre, 94 nodes
// and 208 edges on the live board, 160 of them `dependsOn`. That composition is
// what THIS CR replaces (spec Problem + AC20), so the file is retired with its
// subject rather than edited around it, and the contracts of CR-077/CR-083 that
// SURVIVE the replacement are carried forward here, on the new surface:
//   • a flowchart node label carries no title (CR-077 §S4/AC6 → AC11);
//   • the authored queue order is visible in the drawing (CR-077 §S1/AC2 → AC9);
//   • a node's tap is status-gated exactly like its row (CR-083 AC7);
//   • COMPLETED_UNTRACKED is a distinct rendered state (CR-083 AC7);
//   • the published `seq` is consumed verbatim and OMITTED when unusable
//     (CR-091 AC18) — the node's `data-seq`, since nothing re-derives order.
//
// RED phase — expected to FAIL against current production, which:
//   • exports none of `focusedReleaseView`/`roadmapTableColumns`/`briefCrTitle`/
//     `lifecycleBadge` from public/app-logic.mjs, so each pure call is "not a
//     function", and `releaseStripFocusIndex` ignores a second argument;
//   • renders zone 2 as the cytoscape whole-project DAG — no
//     `[data-testid="roadmap-flow"]`, no wave container, no delivered summary,
//     and 160 drawn `dependsOn` edges;
//   • renders zone 3 over the WHOLE queue with an unconditional wave cell, the
//     full title, no column head and nothing at all for `lifecycle`.
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
const APP_LOGIC_SRC = readFileSync(path.join(REPO_ROOT, "public/app-logic.mjs"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
const INDEX_HTML_SRC = readFileSync(path.join(REPO_ROOT, "public/index.html"), "utf8");

// ── The pure boundary ──────────────────────────────────────────────────────
//
// The ambient tests/app-logic.d.ts predates these exports, so the module is
// cast to the boundary under test ONCE (the tests/roadmap-release-strip.test.ts
// pattern). Until GREEN adds them each call is "is not a function" — the
// intended missing-export RED signal.

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

/** `src/v2.ts:1755-1763` (`releaseBrief`) — what `GET …/releases` publishes. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
  timestamp: number;
}

/** `src/v2.ts:2045-2057` (`proposalBrief`) — what `GET …/release-proposals`
 *  publishes. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** `src/types.ts:365-372` (`QueueLifecycle`) — CR-CRU-091 §S2's SECOND axis. */
interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
}

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes,
 *  `ORDER BY seq`. */
interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  planId?: number;
  seq?: number;
  release?: string;
  track?: string;
  lifecycle?: LifecycleFixture;
}

interface StripGate {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}

/** §S4 — one wave CONTAINER of the focused release: the wave, and its CRs in
 *  the authored order the payload arrived in. */
interface FlowWave {
  wave: string;
  entries: QueueFixture[];
}

/** §S4/§S5 — everything zones 2 and 3 draw for ONE focused release. */
interface FocusedReleaseView {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: StripGate["dateState"];
  /** Membership, in the authored order `listQueue` published. */
  members: QueueFixture[];
  /** The wave containers, in first-appearance (authored) order. */
  waves: FlowWave[];
  /** AC8's delivered CR count. */
  crCount: number;
  packages: PackageFixture[] | undefined;
  /** AC8 — `empty` (the ceremony delivered none) is not `absent` (pre-084). */
  packagesState: "listed" | "empty" | "absent";
  /** AC12 — the tracks REPORTED by this release's members. */
  tracks: string[];
}

interface LifecycleBadge {
  state: "SUPERSEDED" | "VOID";
  text: string;
}

const Logic = AppLogic as unknown as {
  formatReleaseDate: (epochSeconds: unknown) => string;
  releaseStripGates: (releases: unknown, proposals: unknown) => StripGate[];
  releaseStripFocusIndex: (gates: StripGate[], focusedVersion?: string) => number;
  focusedReleaseView: (
    gate: StripGate,
    releases: unknown,
    entries: unknown,
  ) => FocusedReleaseView;
  roadmapTableColumns: (entries: unknown) => string[];
  briefCrTitle: (title: unknown, cr: unknown) => string;
  crStatusMark: (status: unknown) => string;
  lifecycleBadge: (lifecycle: unknown) => LifecycleBadge | null;
};

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// One board, deliberately richer than any single AC needs, so no assertion can
// pass by accident:
//   • the project total (9 rows) EXCEEDS every release's membership, so
//     "renders everything" cannot pass AC10;
//   • inside 0.2.0 the AUTHORED order disagrees with a dependency walk
//     (CR-E is authored before CR-D, which it depends on), so a renderer that
//     re-derives order fails AC13 and the row that inverts is AC15's;
//   • 0.2.0 spans two waves and two tracks, 0.1.0 spans two waves and NO
//     track, and SINGLE_WAVE spans one of each — the three AC12 states;
//   • 0.1.0 delivered two packages, 0.1.1 delivered NONE (`packages: []`), and
//     0.0.9 predates CR-CRU-084 (no `packages` key at all).

/** The measured 0.1.0 ledger row: `releasedAt` 1787149125 is 2026-08-19 in
 *  SECONDS and 1970-01-21 read as MILLISECONDS. */
const SHIP_010 = 1787149125;
const SHIP_011 = SHIP_010 + 86_400;
const SHIP_009 = SHIP_010 - 86_400;
const TARGET_020 = 1790000000; // 2026-09-21
const RETIRED_AT = 1787200000000; // lifecycle `at` is epoch MILLISECONDS

const PKG_PYPI: PackageFixture = { registry: "pypi", name: "crucible-axi", version: "0.1.0" };
const PKG_NPM: PackageFixture = {
  registry: "npm",
  name: "@anthill-tec/crucible-server",
  version: "0.1.0",
};

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: SHIP_010,
  crs: ["CR-A", "CR-B", "CR-C"],
  packages: [PKG_PYPI, PKG_NPM],
  timestamp: SHIP_010 * 1000,
};

/** A release that shipped NOTHING and published NOTHING — the live 0.1.1 shape
 *  with CR-CRU-084's EMPTY (not absent) packages. */
const SHIPPED_011: ReleaseFixture = {
  version: "0.1.1",
  releasedAt: SHIP_011,
  crs: [],
  packages: [],
  timestamp: SHIP_011 * 1000,
};

/** A pre-CR-CRU-084 ledger row: no `packages` KEY at all. */
const SHIPPED_009: ReleaseFixture = {
  version: "0.0.9",
  releasedAt: SHIP_009,
  crs: [],
  timestamp: SHIP_009 * 1000,
};

const PROPOSED_020: ProposalFixture = {
  label: "0.2.0",
  targetAt: TARGET_020,
  timestamp: 1787000000,
  waves: ["5", "6"],
};

/** `listReleases` publishes NEWEST FIRST (CR-CRU-091 §S1). */
const LEDGER: ReleaseFixture[] = [SHIPPED_011, SHIPPED_010];

const QUEUE: QueueFixture[] = [
  // ── 0.1.0, shipped: waves 1 and 2, no track ever reported ────────────────
  { cr: "CR-A", title: "CR-A — Domain core and SQLite storage", wave: "1", dependsOn: [], status: "COMPLETED", planId: 11, seq: 10, release: "0.1.0" },
  { cr: "CR-B", title: "CR-B — Codec translation layer", wave: "1", dependsOn: ["CR-A"], status: "COMPLETED", planId: 12, seq: 20, release: "0.1.0" },
  { cr: "CR-C", title: "CR-C — v1 compatibility shim", wave: "2", dependsOn: ["CR-B"], status: "COMPLETED_UNTRACKED", seq: 30, release: "0.1.0" },
  // ── 0.2.0, in flight: waves 5 and 6, two tracks, an authored inversion ───
  { cr: "CR-E", title: "CR-E — Authored FIRST, depends on CR-D", wave: "5", dependsOn: ["CR-D"], status: "PENDING", seq: 40, release: "0.2.0", track: "track-1" },
  { cr: "CR-D", title: "CR-D — Authored SECOND, depends on nothing", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 14, seq: 50, release: "0.2.0", track: "track-1" },
  { cr: "CR-F", title: "CR-F — Work that moved elsewhere", wave: "6", dependsOn: [], status: "PENDING", seq: 60, release: "0.2.0", track: "track-2", lifecycle: { state: "SUPERSEDED", by: "CR-CRU-085", at: RETIRED_AT } },
  { cr: "CR-G", title: "CR-G — Work that is not happening", wave: "6", dependsOn: [], status: "PENDING", seq: 70, release: "0.2.0", track: "track-2", lifecycle: { state: "VOID", reason: "the pipeline it served was retired", at: RETIRED_AT } },
  // ── claimed by NO release: the project total exceeds every membership ────
  { cr: "CR-Y", title: "CR-Y — Unclaimed backlog", wave: "9", dependsOn: [], status: "PENDING", seq: 80 },
  { cr: "CR-Z", title: "CR-Z — Unclaimed backlog too", wave: "9", dependsOn: [], status: "PENDING", seq: 90 },
];

/** The AC14 board: CR-D and CR-E swapped in the AUTHORED order, same wave,
 *  same deps, `seq` re-stamped to match (the wire cannot disagree with
 *  itself — `listQueue` is `ORDER BY seq`). */
const QUEUE_SWAPPED: QueueFixture[] = QUEUE.map((entry) =>
  entry.cr === "CR-E" ? { ...entry, seq: 50 } : entry.cr === "CR-D" ? { ...entry, seq: 40 } : entry,
).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

/** A release spanning ONE wave with ONE track — AC12's negative half. */
const SINGLE_WAVE_QUEUE: QueueFixture[] = [
  { cr: "CR-S1", title: "CR-S1 — Only wave", wave: "7", dependsOn: [], status: "PENDING", seq: 10, release: "0.3.0", track: "track-1" },
  { cr: "CR-S2", title: "CR-S2 — Only wave too", wave: "7", dependsOn: [], status: "PENDING", seq: 20, release: "0.3.0", track: "track-1" },
];
const PROPOSED_030: ProposalFixture = {
  label: "0.3.0",
  timestamp: 1787000000,
  waves: ["7"],
};

/**
 * A dependency-only walk over the given rows: every CR emitted after each of
 * its own in-view dependencies. This is what §S6 retired, and it is here ONLY
 * as the non-vacuity guard for AC13 — a fixture whose authored order AGREES
 * with this walk proves nothing.
 */
function dependencyWalk(rows: QueueFixture[]): string[] {
  const byCr = new Map(rows.map((row) => [row.cr, row]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (cr: string): void => {
    if (seen.has(cr)) return;
    seen.add(cr);
    for (const dep of byCr.get(cr)?.dependsOn ?? []) if (byCr.has(dep)) visit(dep);
    out.push(cr);
  };
  for (const row of rows) visit(row.cr);
  return out;
}

// ── Harness ────────────────────────────────────────────────────────────────

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: { id: number; label: string; status: string }[];
}

interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  plans?: PlanFixture[];
}

/** happy-dom runs no layout engine, so the strip would measure a zero track
 *  and render a zero-gate window — and zones 2/3 read their focus from the
 *  strip's own sequence. The box model is supplied exactly as
 *  tests/roadmap-release-strip.test.ts supplies it: wide enough that every
 *  fixture's gates fit in one window, so nothing here depends on paging. */
const TRACK_W = 800;
const PITCH = 100;

function rect(left: number, width: number): DOMRect {
  const box = {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => box,
  };
  return box as unknown as DOMRect;
}

function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip-track") return rect(0, TRACK_W);
    if (testid === "roadmap-strip-ruler") return rect(0, PITCH);
    return rect(0, 0);
  };
}

let cacheBust = 0;

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const key = opts.key ?? "focus-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals` must not be swallowed by `/releases`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [PROPOSED_020];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? LEDGER });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? QUEUE });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: opts.plans ?? [] });
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          {
            key,
            name: key,
            type: "backend",
            agentsOnline: 0,
            agentsTotal: 0,
            active: true,
            lastActivity: Date.now(),
          } satisfies ProjectFixture,
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-release-focus.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern, shared with
  // tests/roadmap-release-strip.test.ts).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapReleaseFocus=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production `public/app.js`
 *  shell driving its own fetch chain and van.js's real reactive scheduler
 *  inside happy-dom. Faking the clock would freeze the very render pass under
 *  test (and the strip's own measure tick). */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const flowEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="roadmap-flow"]');

function flow(): HTMLElement {
  const el = flowEl();
  if (el === null) throw new Error('no [data-testid="roadmap-flow"] rendered');
  return el;
}

const waveEls = (): HTMLElement[] => all('[data-testid="roadmap-wave"]');
const waveNames = (): string[] => waveEls().map((w) => w.getAttribute("data-wave") ?? "");
const nodeEls = (): HTMLElement[] => all('[data-testid="roadmap-node"]');
const nodeCrs = (): string[] => nodeEls().map((n) => n.getAttribute("data-cr") ?? "");
const nodeFor = (cr: string): HTMLElement => {
  const node = nodeEls().find((n) => n.getAttribute("data-cr") === cr);
  if (node === undefined) throw new Error(`no flowchart node rendered for ${cr}`);
  return node;
};
const nodesInWave = (wave: string): string[] => {
  const box = waveEls().find((w) => w.getAttribute("data-wave") === wave);
  if (box === undefined) throw new Error(`no wave container rendered for ${wave}`);
  return Array.from(box.querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]')).map(
    (n) => n.getAttribute("data-cr") ?? "",
  );
};

const rowEls = (): HTMLElement[] => all('[data-testid="roadmap-row"]');
const rowOrder = (): string[] => rowEls().map((r) => r.getAttribute("data-cr") ?? "");
const rowFor = (cr: string): HTMLElement => {
  const row = rowEls().find((r) => r.getAttribute("data-cr") === cr);
  if (row === undefined) throw new Error(`no table row rendered for ${cr}`);
  return row;
};
const cell = (row: HTMLElement, column: string): HTMLElement | null =>
  row.querySelector<HTMLElement>(`[data-column="${column}"]`);
const cellText = (cr: string, column: string): string =>
  (cell(rowFor(cr), column)?.textContent ?? "").trim();
const headColumns = (): string[] => {
  const head = document.querySelector<HTMLElement>('[data-testid="roadmap-table-head"]');
  if (head === null) throw new Error('no [data-testid="roadmap-table-head"] rendered');
  return Array.from(head.querySelectorAll<HTMLElement>("[data-column]")).map(
    (c) => c.getAttribute("data-column") ?? "",
  );
};
const statusText = (cr: string): string =>
  (rowFor(cr).querySelector('[data-testid="roadmap-status-badge"]')?.textContent ?? "").trim();
const lifecycleEl = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>('[data-testid="roadmap-lifecycle-badge"]');

async function clickGate(version: string): Promise<void> {
  const gate = all('[data-testid="roadmap-gate"]').find(
    (g) => g.getAttribute("data-version") === version,
  );
  if (gate === undefined) throw new Error(`no strip gate rendered for ${version}`);
  gate.click();
  await settle();
}

// ── §S4/AC8 — a SHIPPED release states what it delivered ────────────────────

describe("CR-CRU-078 §S4/AC8 — focusing a shipped release states what it DELIVERED, and draws no waves", () => {
  test("the delivered summary carries the CR count, the waves spanned, the ship date and the packages — and NOT one wave container", async () => {
    await mountApp();
    await clickGate("0.1.0");

    expect(flow().getAttribute("data-kind")).toBe("shipped");
    expect(flow().getAttribute("data-version")).toBe("0.1.0");

    const delivered = document.querySelector<HTMLElement>('[data-testid="roadmap-delivered"]');
    expect(delivered).not.toBeNull();
    expect(
      (
        document.querySelector('[data-testid="roadmap-delivered-crs"]')?.textContent ?? ""
      ).trim(),
    ).toContain("3");
    const waves = (
      document.querySelector('[data-testid="roadmap-delivered-waves"]')?.textContent ?? ""
    ).trim();
    expect(waves).toContain("1");
    expect(waves).toContain("2");
    // AC30 — the ship date is the ONE formatter's answer, never constructed here.
    expect(
      (
        document.querySelector('[data-testid="roadmap-delivered-date"]')?.textContent ?? ""
      ).trim(),
    ).toContain(Logic.formatReleaseDate(SHIP_010));
    expect(Logic.formatReleaseDate(SHIP_010)).toBe("2026-08-19");

    // The Workflow history view owns historical waves: none is reconstructed.
    expect(waveEls().length).toBe(0);
    expect(nodeEls().length).toBe(0);
  });

  test("the packages the release delivered are named, each with its registry", async () => {
    await mountApp();
    await clickGate("0.1.0");

    const box = document.querySelector<HTMLElement>('[data-testid="roadmap-delivered-packages"]');
    expect(box).not.toBeNull();
    expect(box!.getAttribute("data-packages-state")).toBe("listed");
    const packages = all('[data-testid="roadmap-package"]').map((p) =>
      (p.textContent ?? "").trim(),
    );
    expect(packages.length).toBe(2);
    expect(packages[0]!).toContain("pypi");
    expect(packages[0]!).toContain("crucible-axi");
    expect(packages[1]!).toContain("npm");
    expect(packages[1]!).toContain("@anthill-tec/crucible-server");
  });

  test("a release that delivered NO package says so explicitly — never an apparently complete release", async () => {
    await mountApp();
    await clickGate("0.1.1");

    const box = document.querySelector<HTMLElement>('[data-testid="roadmap-delivered-packages"]');
    expect(box).not.toBeNull();
    expect(box!.getAttribute("data-packages-state")).toBe("empty");
    expect(all('[data-testid="roadmap-package"]').length).toBe(0);
    expect((box!.textContent ?? "").trim()).toContain("no package recorded");
  });

  test("a pre-CR-CRU-084 release, whose ledger row carries no `packages` KEY, is not passed off as complete either", async () => {
    await mountApp({ releases: [SHIPPED_009], proposals: [] });

    const box = document.querySelector<HTMLElement>('[data-testid="roadmap-delivered-packages"]');
    expect(box).not.toBeNull();
    // `absent` and `empty` stay DISTINGUISHABLE (CR-CRU-084 AC4) while both
    // render an explicit no-package state.
    expect(box!.getAttribute("data-packages-state")).toBe("absent");
    expect(all('[data-testid="roadmap-package"]').length).toBe(0);
    expect((box!.textContent ?? "").trim()).toContain("no package recorded");
  });
});

// ── §S4/AC9 — the IN-FLIGHT release gets its wave detail ────────────────────

describe("CR-CRU-078 §S4/AC9 — the in-flight release draws Start → wave container(s) → gate → End", () => {
  test("landing focuses the release in progress and draws its wave containers, each holding that wave's CRs in AUTHORED order", async () => {
    await mountApp();

    expect(flow().getAttribute("data-kind")).toBe("proposed");
    expect(flow().getAttribute("data-version")).toBe("0.2.0");

    // One Start, one End, and the release's own gate between the waves and End.
    const terminals = all('[data-testid="roadmap-flow-terminal"]').map((t) =>
      t.getAttribute("data-terminal"),
    );
    expect(terminals).toEqual(["start", "end"]);
    const gate = document.querySelector<HTMLElement>('[data-testid="roadmap-flow-gate"]');
    expect(gate).not.toBeNull();
    expect(gate!.getAttribute("data-version")).toBe("0.2.0");
    expect(gate!.getAttribute("data-kind")).toBe("proposed");

    expect(waveNames()).toEqual(["5", "6"]);
    // AC9 — authored order INSIDE the container: CR-E was authored before
    // CR-D even though CR-E depends on CR-D.
    expect(nodesInWave("5")).toEqual(["CR-E", "CR-D"]);
    // CR-CRU-096 §S5/AC9a — wave 6 holds CR-F (SUPERSEDED) and CR-G (VOID).
    // A `PENDING` row carrying a disposition is not work, so it gets NO row
    // here at all. Nothing is lost: the box still STATES both members (AC3)
    // and zone 3 still carries the dispositions, which is where that axis
    // lives now.
    expect(nodesInWave("6")).toEqual([]);
    const waveSix = waveEls().find((w) => w.getAttribute("data-wave") === "6");
    expect(waveSix!.getAttribute("data-cr-count")).toBe("2");
    expect(lifecycleEl(rowFor("CR-F"))).not.toBeNull();
    expect(lifecycleEl(rowFor("CR-G"))).not.toBeNull();
  });

  test("no CR outside the focused release reaches the flowchart", async () => {
    await mountApp();
    // CR-CRU-096 §S5 — zone 2 draws the WORK: the top of the scheduled queue
    // plus whatever is running. CR-F and CR-G are dispositioned (AC9a) and
    // draw no rows, so the drawn set is the focused release's actionable ∪
    // running members.
    expect(nodeCrs().sort()).toEqual(["CR-D", "CR-E"]);
    // The fact this test exists for, stated independently of the trim:
    // nothing DRAWN belongs to another release.
    const focusedCrs = new Set(QUEUE.filter((e) => e.release === "0.2.0").map((e) => e.cr));
    expect(nodeCrs().filter((cr) => !focusedCrs.has(cr))).toEqual([]);
    // Fixture guard: the project really does carry more than this.
    expect(QUEUE.length).toBeGreaterThan(4);
  });

  test("a node carries its derived status as TEXT and its published `seq` verbatim, and no node carries a title", async () => {
    await mountApp();

    const inProgress = nodeFor("CR-D");
    expect(inProgress.getAttribute("data-status")).toBe("IN_PROGRESS");
    expect(
      (
        inProgress.querySelector('[data-testid="roadmap-node-status"]')?.textContent ?? ""
      ).trim().length,
    ).toBeGreaterThan(0);
    // CR-CRU-091/AC18 on the new surface: the STORED `seq`, never an index.
    expect(inProgress.getAttribute("data-seq")).toBe("50");
    expect(nodeFor("CR-E").getAttribute("data-seq")).toBe("40");

    // AC11 — a node label containing its entry's `title` string fails. Read
    // off the RENDERED nodes rather than the queue: after CR-CRU-096 §S5 zone
    // 2 draws a window on the membership, so an entry it does not draw has no
    // node to read.
    expect(nodeEls().length).toBeGreaterThan(0);
    for (const node of nodeEls()) {
      const entry = QUEUE.find((e) => e.cr === node.getAttribute("data-cr"));
      expect(entry?.title).toBeDefined();
      expect(node.textContent ?? "").not.toContain(entry!.title!);
    }
  });

  test("an entry whose published `seq` is unusable OMITS the attribute rather than defaulting it to a position the queue never authored", async () => {
    const queue: QueueFixture[] = [
      { cr: "CR-P", title: "CR-P — positioned", wave: "5", dependsOn: [], status: "PENDING", seq: 10, release: "0.2.0" },
      { cr: "CR-Q", title: "CR-Q — no carried position", wave: "5", dependsOn: [], status: "PENDING", release: "0.2.0" },
    ];
    await mountApp({ queue, releases: [] });

    expect(nodeFor("CR-P").getAttribute("data-seq")).toBe("10");
    expect(nodeFor("CR-Q").hasAttribute("data-seq")).toBe(false);
    expect(rowFor("CR-Q").hasAttribute("data-seq")).toBe(false);
  });
});

// ── AC20 — zero dependency edges ────────────────────────────────────────────

describe("CR-CRU-078 AC20 — ZERO dependency edges are drawn; dependency is the table's column alone", () => {
  test("the flowchart draws no edge of any kind, and states no dependency", async () => {
    await mountApp();

    // The fixture really does declare a dependency between two drawn CRs, so
    // this cannot pass on an edgeless fixture.
    expect(QUEUE.find((e) => e.cr === "CR-E")!.dependsOn).toEqual(["CR-D"]);

    expect(flow().querySelectorAll('[data-testid="roadmap-edge"]').length).toBe(0);
    expect(flow().querySelectorAll("svg, canvas, line, path").length).toBe(0);
    // Dependency is stated in the TABLE and nowhere else.
    expect(flow().querySelectorAll('[data-testid="roadmap-depends-chip"]').length).toBe(0);
    expect(all('[data-testid="roadmap-depends-chip"]').length).toBeGreaterThan(0);
    expect(cellText("CR-E", "deps")).toContain("CR-D");
  });

  test("the composition that drew 160 of them is gone — the builder, the mount and the layout library with it", () => {
    // CR-CRU-077's builder keyed every dependency edge `dep:<from>-><to>`.
    expect(APP_LOGIC_SRC).not.toContain("dep:");
    expect(APP_LOGIC_SRC).not.toContain("buildRoadmapGraph");
    expect(APP_JS_SRC).not.toContain("buildRoadmapGraph");
    // The mounted-instance seam the canvas render published, and the two
    // vendored UMDs it needed: an unused 400 KB download on every page load
    // would be the composition still shipping, just not drawing.
    expect(APP_JS_SRC).not.toContain("crucibleRoadmapCy");
    expect(existsSync(path.join(REPO_ROOT, "public/cytoscape.umd.js"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "public/cytoscape-dagre.js"))).toBe(false);
    expect(INDEX_HTML_SRC).not.toContain("cytoscape");
  });
});

// ── §S5/AC10 — the table follows the focused release ────────────────────────

describe("CR-CRU-078 §S5/AC10 — the table renders the focused release's CRs and NOTHING else", () => {
  test("the row count equals that release's membership, never the project total", async () => {
    await mountApp();

    // Non-vacuity: the project carries strictly more rows than the release.
    expect(QUEUE.length).toBe(9);
    expect(rowOrder()).toEqual(["CR-E", "CR-D", "CR-F", "CR-G"]);
    expect(rowOrder().length).toBeLessThan(QUEUE.length);
  });

  test("clicking another gate REPLACES the rows with that release's membership", async () => {
    await mountApp();
    expect(rowOrder()).toEqual(["CR-E", "CR-D", "CR-F", "CR-G"]);

    await clickGate("0.1.0");
    expect(rowOrder()).toEqual(["CR-A", "CR-B", "CR-C"]);

    await clickGate("0.1.1");
    // 0.1.1 shipped nothing at all — an honest empty membership, not the
    // whole project falling back into view.
    expect(rowOrder()).toEqual([]);

    await clickGate("0.2.0");
    expect(rowOrder()).toEqual(["CR-E", "CR-D", "CR-F", "CR-G"]);
  });

  test("the strip marks WHICH gate the two lower zones are following", async () => {
    await mountApp();
    const focused = (): string[] =>
      all('[data-testid="roadmap-gate"][data-focused="true"]').map(
        (g) => g.getAttribute("data-version") ?? "",
      );
    expect(focused()).toEqual(["0.2.0"]);
    await clickGate("0.1.0");
    expect(focused()).toEqual(["0.1.0"]);
  });
});

// ── §S5/AC11 — the row grammar, and the title's ONE home ────────────────────

describe("CR-CRU-078 §S5/AC11 — a row carries the CR id AND its brief title", () => {
  test("every row renders both, and the title column is the CR's own H1 without the id it already shows", async () => {
    await mountApp();

    expect(headColumns()).toContain("cr");
    expect(headColumns()).toContain("title");
    for (const cr of rowOrder()) {
      expect(cellText(cr, "cr")).toBe(cr);
      expect(cellText(cr, "title").length).toBeGreaterThan(0);
    }
    // "Brief" is the point (§S5 calls the full title bloat): the id prefix the
    // row already carries in its own column is not repeated in the title.
    expect(cellText("CR-D", "title")).toBe("Authored SECOND, depends on nothing");
    expect(cellText("CR-D", "title")).not.toContain("CR-D");
  });

  test("`briefCrTitle` strips only the row's own leading id, and never invents one", () => {
    expect(Logic.briefCrTitle("CR-CRU-078 — the roadmap is a flowchart", "CR-CRU-078")).toBe(
      "the roadmap is a flowchart",
    );
    expect(Logic.briefCrTitle("CR-CRU-078: the roadmap is a flowchart", "CR-CRU-078")).toBe(
      "the roadmap is a flowchart",
    );
    // A title that does NOT open with its own id is left exactly as authored.
    expect(Logic.briefCrTitle("the roadmap is a flowchart", "CR-CRU-078")).toBe(
      "the roadmap is a flowchart",
    );
    // Another CR's id inside the sentence is content, not a prefix.
    expect(Logic.briefCrTitle("CR-CRU-077 is superseded", "CR-CRU-078")).toBe(
      "CR-CRU-077 is superseded",
    );
    expect(Logic.briefCrTitle(undefined, "CR-CRU-078")).toBe("");
  });
});

// ── §S5/AC12 — the two CONDITIONAL columns ──────────────────────────────────

describe("CR-CRU-078 §S5/AC12 — `wave` appears only across waves, `track` only across tracks", () => {
  test("a release spanning two waves and two tracks shows both columns", async () => {
    await mountApp();
    expect(headColumns()).toEqual(["cr", "title", "deps", "status", "wave", "track"]);
    expect(cellText("CR-E", "wave")).toBe("5");
    expect(cellText("CR-F", "track")).toBe("track-2");
  });

  test("a release spanning two waves with NO track reported shows `wave` and not `track`", async () => {
    await mountApp();
    await clickGate("0.1.0");
    expect(headColumns()).toContain("wave");
    expect(headColumns()).not.toContain("track");
    expect(cell(rowFor("CR-A"), "track")).toBeNull();
  });

  test("a release inside ONE wave on ONE track shows neither — a single container carries no information", async () => {
    await mountApp({ queue: SINGLE_WAVE_QUEUE, releases: [], proposals: [PROPOSED_030] });
    expect(rowOrder()).toEqual(["CR-S1", "CR-S2"]);
    expect(headColumns()).not.toContain("wave");
    expect(headColumns()).not.toContain("track");
    expect(cell(rowFor("CR-S1"), "wave")).toBeNull();
    // AC16's second clause, in the table's own region: no wave chrome either.
    expect(all('[data-testid="roadmap-wave-divider"]').length).toBe(0);
  });

  test("`roadmapTableColumns` is the one place that decides, and it decides from the ROWS it is given", () => {
    expect(Logic.roadmapTableColumns(SINGLE_WAVE_QUEUE)).toEqual([
      "cr",
      "title",
      "deps",
      "status",
    ]);
    const twoWaves = QUEUE.filter((e) => e.release === "0.1.0");
    expect(Logic.roadmapTableColumns(twoWaves)).toEqual(["cr", "title", "deps", "status", "wave"]);
    const twoOfBoth = QUEUE.filter((e) => e.release === "0.2.0");
    expect(Logic.roadmapTableColumns(twoOfBoth)).toEqual([
      "cr",
      "title",
      "deps",
      "status",
      "wave",
      "track",
    ]);
    expect(Logic.roadmapTableColumns([])).toEqual(["cr", "title", "deps", "status"]);
  });
});

// ── §S6/AC13-AC15 — the authored order is carried, and only VALIDATED ───────

describe("CR-CRU-078 §S6/AC13 — rows preserve the authored `seq` verbatim inside the release", () => {
  test("the rendered order is the published order, on a fixture whose authored order DISAGREES with a dependency walk", async () => {
    await mountApp();
    const members = QUEUE.filter((entry) => entry.release === "0.2.0");
    // Non-vacuity: a renderer that re-derived order would produce a DIFFERENT
    // sequence, so this assertion can only pass on a carried order.
    expect(dependencyWalk(members)).not.toEqual(members.map((entry) => entry.cr));
    expect(dependencyWalk(members)).toEqual(["CR-D", "CR-E", "CR-F", "CR-G"]);
    expect(rowOrder()).toEqual(["CR-E", "CR-D", "CR-F", "CR-G"]);
  });
});

describe("CR-CRU-078 §S6/AC14 — the order is EDITABLE", () => {
  test("re-registering with two CRs swapped (same wave, same deps) swaps their rows and their nodes", async () => {
    await mountApp({ queue: QUEUE_SWAPPED });
    expect(rowOrder()).toEqual(["CR-D", "CR-E", "CR-F", "CR-G"]);
    expect(nodesInWave("5")).toEqual(["CR-D", "CR-E"]);
    // The deps did not move — only the authoring did.
    expect(cellText("CR-E", "deps")).toContain("CR-D");
  });
});

describe("CR-CRU-078 §S6/AC15 — an inverted authoring is WARNED, never reordered", () => {
  test("the row authored before its own dependency carries the warning, stays where it was authored, and is the only warned row", async () => {
    await mountApp();
    const warned = rowEls()
      .filter((r) => r.querySelector('[data-testid="roadmap-order-warning"]') !== null)
      .map((r) => r.getAttribute("data-cr"));
    expect(warned).toEqual(["CR-E"]);
    expect(rowOrder()[0]).toBe("CR-E");
  });

  test("the same authoring, once corrected, warns nothing", async () => {
    await mountApp({ queue: QUEUE_SWAPPED });
    const warned = rowEls().filter(
      (r) => r.querySelector('[data-testid="roadmap-order-warning"]') !== null,
    );
    expect(warned.length).toBe(0);
  });
});

// ── AC16 — no wave twice, and no chrome for a wave carrying nothing ─────────

describe("CR-CRU-078 §S6/AC16 — no wave is rendered twice inside one region", () => {
  test("a wave that re-appears in the authoring heads its rows ONCE and opens ONE container", async () => {
    // The authoring interleaves wave 5 and wave 6 — the live board's
    // `Wave 1,2,3,4,3,4,…` failure mode, reproduced inside one release.
    const queue: QueueFixture[] = [
      { cr: "CR-I1", title: "CR-I1 — one", wave: "5", dependsOn: [], status: "PENDING", seq: 10, release: "0.2.0" },
      { cr: "CR-I2", title: "CR-I2 — two", wave: "6", dependsOn: [], status: "PENDING", seq: 20, release: "0.2.0" },
      { cr: "CR-I3", title: "CR-I3 — three", wave: "5", dependsOn: [], status: "PENDING", seq: 30, release: "0.2.0" },
      { cr: "CR-I4", title: "CR-I4 — four", wave: "6", dependsOn: [], status: "PENDING", seq: 40, release: "0.2.0" },
    ];
    await mountApp({ queue, releases: [] });

    expect(waveNames()).toEqual(["5", "6"]);
    expect(new Set(waveNames()).size).toBe(waveNames().length);
    // …and every CR still lands inside its OWN wave, authored order intact.
    expect(nodesInWave("5")).toEqual(["CR-I1", "CR-I3"]);
    expect(nodesInWave("6")).toEqual(["CR-I2", "CR-I4"]);
    expect(rowOrder()).toEqual(["CR-I1", "CR-I2", "CR-I3", "CR-I4"]);

    const dividers = all('[data-testid="roadmap-wave-divider"]').map((d) =>
      (d.textContent ?? "").trim(),
    );
    expect(dividers.length).toBe(new Set(dividers).size);
  });
});

// ── AC27 — the lifecycle SECOND axis, on both surfaces ──────────────────────

describe("CR-CRU-078 AC27 — a dead CR does not read as live work, on the row AND on the node", () => {
  test("a SUPERSEDED row names its successor and KEEPS its derived status — the two axes are additive", async () => {
    await mountApp();

    const row = rowFor("CR-F");
    const badge = lifecycleEl(row);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("data-lifecycle")).toBe("SUPERSEDED");
    expect((badge!.textContent ?? "").trim()).toContain("CR-CRU-085");
    expect((badge!.textContent ?? "").toLowerCase()).toContain("superseded");
    // ADDITIVE: `status` is still rendered, unchanged.
    expect(statusText("CR-F")).toBe("PENDING");
  });

  test("a VOID row is legible as abandoned, carries its reason, and also keeps its status", async () => {
    await mountApp();

    const row = rowFor("CR-G");
    const badge = lifecycleEl(row);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("data-lifecycle")).toBe("VOID");
    expect((badge!.textContent ?? "").toLowerCase()).toContain("abandoned");
    expect((badge!.textContent ?? "")).toContain("the pipeline it served was retired");
    expect(statusText("CR-G")).toBe("PENDING");
  });

  test("the two lifecycle states are distinguishable from each other and from every status value", async () => {
    await mountApp();

    const superseded = (lifecycleEl(rowFor("CR-F"))!.textContent ?? "").trim();
    const voided = (lifecycleEl(rowFor("CR-G"))!.textContent ?? "").trim();
    expect(superseded).not.toBe(voided);
    // Neither is mistakable for a status: both rows read PENDING, and neither
    // badge says so.
    for (const text of [superseded, voided]) {
      for (const status of ["PENDING", "IN_PROGRESS", "COMPLETED", "COMPLETED_UNTRACKED"]) {
        expect(text).not.toContain(status);
      }
    }
  });

  test("both states stay legible on zone 3's row, and a TRIMMED wave draws no row for them at all", async () => {
    await mountApp();

    // CR-CRU-096 AC9a — a dispositioned CR is not work, so a TRIMMED wave box
    // renders no row for it: every member of this board declares a wave, so
    // no node is drawn for `CR-F`/`CR-G` here and there is no node badge on
    // THIS board either. That is the trim, NOT a removal of the badge —
    // AC9b keeps the node's badge wherever a node renders (the untrimmed
    // AC18a loose group, and a running dispositioned CR per AC9c). The FACT
    // this test exists for is unchanged — a VOID/SUPERSEDED CR's disposition
    // is visible, additively with its derived status — and is asserted here
    // on zone 3's row (`roadmap-lifecycle-badge`).
    expect(nodeCrs()).not.toContain("CR-F");
    expect(nodeCrs()).not.toContain("CR-G");
    expect(all('[data-testid="roadmap-node-lifecycle"]').length).toBe(0);

    const superseded = rowFor("CR-F");
    expect(superseded.getAttribute("data-lifecycle")).toBe("SUPERSEDED");
    const supersededText = (lifecycleEl(superseded)?.textContent ?? "").trim();
    expect(supersededText.toLowerCase()).toContain("superseded");
    expect(supersededText).toContain("CR-CRU-085");
    // The row keeps its derived status alongside: the two axes stay additive.
    expect(statusText("CR-F")).toBe("PENDING");

    const voided = rowFor("CR-G");
    expect(voided.getAttribute("data-lifecycle")).toBe("VOID");
    const voidedText = (lifecycleEl(voided)?.textContent ?? "").trim();
    expect(voidedText.toLowerCase()).toContain("abandoned");
    expect(voidedText).not.toBe(supersededText);
  });

  test("an entry with NO `lifecycle` key renders exactly as today — absent, never defaulted", async () => {
    await mountApp();

    expect(QUEUE.find((e) => e.cr === "CR-D")!.lifecycle).toBeUndefined();
    expect(lifecycleEl(rowFor("CR-D"))).toBeNull();
    expect(rowFor("CR-D").hasAttribute("data-lifecycle")).toBe(false);
    expect(nodeFor("CR-D").hasAttribute("data-lifecycle")).toBe(false);
    // CR-CRU-096 AC9a — the node's own badge is gone; the absence that still
    // matters is that no disposition is INVENTED for an entry declaring none,
    // on either surface.
    expect(nodeFor("CR-D").querySelectorAll("[data-lifecycle]").length).toBe(0);
  });

  test("`lifecycleBadge` is the one place the copy lives, and an absent axis yields nothing", () => {
    expect(Logic.lifecycleBadge(undefined)).toBeNull();
    expect(Logic.lifecycleBadge(null)).toBeNull();
    expect(Logic.lifecycleBadge({ state: "WHAT", at: 1 })).toBeNull();

    const superseded = Logic.lifecycleBadge({ state: "SUPERSEDED", by: "CR-X", at: 1 })!;
    expect(superseded.state).toBe("SUPERSEDED");
    expect(superseded.text).toContain("CR-X");

    // A SUPERSEDED record with no successor still reads as superseded rather
    // than naming an `undefined` one.
    const orphan = Logic.lifecycleBadge({ state: "SUPERSEDED", at: 1 })!;
    expect(orphan.text.toLowerCase()).toContain("superseded");
    expect(orphan.text).not.toContain("undefined");

    const voided = Logic.lifecycleBadge({ state: "VOID", reason: "dropped", at: 1 })!;
    expect(voided.state).toBe("VOID");
    expect(voided.text.toLowerCase()).toContain("abandoned");
    expect(voided.text).toContain("dropped");
  });
});

// ── The pure zone-2 model ───────────────────────────────────────────────────

describe("CR-CRU-078 §S4 — `focusedReleaseView` answers what ONE focused release's zone 2 IS", () => {
  const gateFor = (version: string): StripGate => {
    const gates = Logic.releaseStripGates(LEDGER, [PROPOSED_020]);
    const gate = gates.find((g) => g.version === version);
    if (gate === undefined) throw new Error(`no gate for ${version}`);
    return gate;
  };

  test("a proposed release's membership is the CRs DECLARED into it, grouped into waves in authored order", () => {
    const view = Logic.focusedReleaseView(gateFor("0.2.0"), LEDGER, QUEUE);
    expect(view.kind).toBe("proposed");
    expect(view.members.map((m) => m.cr)).toEqual(["CR-E", "CR-D", "CR-F", "CR-G"]);
    expect(view.waves.map((w) => w.wave)).toEqual(["5", "6"]);
    expect(view.waves[0]!.entries.map((e) => e.cr)).toEqual(["CR-E", "CR-D"]);
    expect(view.crCount).toBe(4);
    expect(view.tracks).toEqual(["track-1", "track-2"]);
    // A proposal has shipped nothing, so it has published nothing.
    expect(view.packagesState).toBe("absent");
  });

  test("a shipped release's membership is the ledger's frozen `crs`, and the queue's authored order still orders it", () => {
    const view = Logic.focusedReleaseView(gateFor("0.1.0"), LEDGER, QUEUE);
    expect(view.kind).toBe("shipped");
    expect(view.members.map((m) => m.cr)).toEqual(["CR-A", "CR-B", "CR-C"]);
    expect(view.crCount).toBe(3);
    expect(view.waves.map((w) => w.wave)).toEqual(["1", "2"]);
    expect(view.tracks).toEqual([]);
    expect(view.packagesState).toBe("listed");
    expect(view.packages).toEqual([PKG_PYPI, PKG_NPM]);
    expect(view.date).toBe(Logic.formatReleaseDate(SHIP_010));
  });

  test("`empty` packages and an `absent` packages key are DIFFERENT facts and stay so", () => {
    expect(Logic.focusedReleaseView(gateFor("0.1.1"), LEDGER, QUEUE).packagesState).toBe("empty");
    const legacy = Logic.releaseStripGates([SHIPPED_009], [])[0]!;
    expect(Logic.focusedReleaseView(legacy, [SHIPPED_009], QUEUE).packagesState).toBe("absent");
  });

  test("a release nothing declares into is EMPTY membership, never a fallback to the whole queue", () => {
    const view = Logic.focusedReleaseView(gateFor("0.1.1"), LEDGER, QUEUE);
    expect(view.members).toEqual([]);
    expect(view.waves).toEqual([]);
    expect(view.crCount).toBe(0);
  });
});

describe("CR-CRU-078 §S4/§S5 — the focused release is the STRIP's, and a click moves it", () => {
  test("`releaseStripFocusIndex` honours a user-chosen version and falls back to the release in progress", () => {
    const gates = Logic.releaseStripGates(LEDGER, [PROPOSED_020]);
    // Ship order, then the proposal: 0.1.0 shipped before 0.1.1 (§S9).
    expect(gates.map((g) => g.version)).toEqual(["0.1.0", "0.1.1", "0.2.0"]);
    // Default: the first live proposal — the next release to ship.
    expect(Logic.releaseStripFocusIndex(gates)).toBe(2);
    expect(Logic.releaseStripFocusIndex(gates, "0.1.0")).toBe(0);
    // A version no longer in the sequence falls back rather than focusing none.
    expect(Logic.releaseStripFocusIndex(gates, "9.9.9")).toBe(2);
    expect(Logic.releaseStripFocusIndex([], "0.1.0")).toBe(-1);
  });
});

// ── Carried forward from the retired graph suite ────────────────────────────

describe("CR-CRU-083 AC7 — a node's tap is status-gated exactly like its row", () => {
  const tabIsOn = (label: string): boolean =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).some(
      (tab) => (tab.textContent ?? "").includes(label) && tab.classList.contains("on"),
    );

  test("an IN_PROGRESS node lands on Workflow; a PENDING node is inert", async () => {
    await mountApp({
      plans: [
        {
          planId: 14,
          cr: "CR-D",
          projectKey: "focus-key",
          status: "open",
          track: "track-1",
          cycles: [{ id: 1, label: "C1", status: "active" }],
        },
      ],
    });

    nodeFor("CR-E").click();
    await settle();
    expect(tabIsOn("Workflow")).toBe(false);

    nodeFor("CR-D").click();
    await settle();
    expect(tabIsOn("Workflow")).toBe(true);
  });

  test("COMPLETED_UNTRACKED stays a state of its own on the node and in the row", async () => {
    await mountApp();
    await clickGate("0.1.0");

    expect(statusText("CR-C")).toBe("completed · tracking absent");
    expect(rowFor("CR-C").querySelector('[data-testid="roadmap-status-badge"]')!.className).toContain(
      "completed_untracked",
    );
  });
});

// ── AC11 — the node's `id + status` vocabulary ──────────────────────────────
//
// One of the six halves CR-CRU-077 was credited with carrying forward, and the
// DELETED tests/roadmap-graph.test.ts was the only place that pinned it. That
// suite asserted the label on cytoscape's `node.data.label`, which no longer
// exists; the vocabulary itself moved into `crStatusMark` and onto the
// flowchart node's own status span, and NOTHING asserted the words.
//
// The words are the whole point: AC23 requires every state to stay determinable
// with colour stripped, so if two statuses shared a mark — or a mark went
// missing — the node would be unreadable in exactly the mode the AC tests.

const nodeStatusText = (cr: string): string =>
  (nodeFor(cr).querySelector('[data-testid="roadmap-node-status"]')?.textContent ?? "").trim();

/** CR-CRU-096 §S4/AC12/AC12b — AC12's rule applied to the FIXTURE: the first
 *  actionable entry (`PENDING` carrying no `lifecycle`) in the published order
 *  among the rows given. The marker is one fact about the whole zone, so this
 *  is asked once over the drawn rows in document order and never per box. */
const firstActionableCr = (entries: readonly QueueFixture[]): string | undefined =>
  entries.find((entry) => entry.status === "PENDING" && !("lifecycle" in entry))?.cr;

/** CR-CRU-096 §S4/AC12/AC13 — the annotation slot an entry EARNS, derived from
 *  the FIXTURE's own facts (its declared `dependsOn`, and whether the published
 *  order names it `next`) and never read back out of the render: an expectation
 *  taken from the DOM would assert nothing, and a spurious or misplaced
 *  annotation must still fail. `next` first, then `deps` naming every declared
 *  id in FULL (AC13a), joined by the design's `·`. A row that earns neither
 *  renders no slot at all, so its contribution is `""`. */
const expectedAnnotation = (entry: QueueFixture, nextCr: string | undefined): string => {
  const parts: string[] = [];
  if (entry.cr === nextCr) parts.push("next");
  const deps = entry.status === "PENDING" ? entry.dependsOn : [];
  if (deps.length > 0) parts.push(`deps ${deps.join(", ")}`);
  return parts.join(" · ");
};

describe("CR-CRU-078 AC11 — a node is its id plus a terse status mark, and each derived status has its OWN words", () => {
  /** One entry per derived `QueueStatus`, all declared into the focused
   *  release, so the four marks are observable on one rendered board.
   *
   *  CR-CRU-096 §S5/AC18a — they declare NO wave (`wave: ""`, the wire's own
   *  way of declaring none, `src/types.ts:392`), because a WAVE box draws only
   *  the scheduled top plus what is running: a merged CR gets no row there any
   *  more. The `wave: null` group takes the row arrangement but NOT the trim,
   *  so it is the surface on which all four marks are still rendered — which
   *  is what this test is about. */
  const STATUS_QUEUE: QueueFixture[] = [
    { cr: "CR-M1", title: "CR-M1 — merged through a tracked plan", wave: "", dependsOn: [], status: "COMPLETED", seq: 10, release: "0.2.0" },
    { cr: "CR-M2", title: "CR-M2 — shipped, never tracked", wave: "", dependsOn: [], status: "COMPLETED_UNTRACKED", seq: 20, release: "0.2.0" },
    { cr: "CR-M3", title: "CR-M3 — under way right now", wave: "", dependsOn: [], status: "IN_PROGRESS", seq: 30, release: "0.2.0" },
    { cr: "CR-M4", title: "CR-M4 — nothing to say yet", wave: "", dependsOn: [], status: "PENDING", seq: 40, release: "0.2.0" },
  ];

  test("the four derived statuses map to four DISTINCT literal marks", () => {
    expect(Logic.crStatusMark("COMPLETED")).toBe("✓ merged");
    expect(Logic.crStatusMark("COMPLETED_UNTRACKED")).toBe("✓ untracked");
    expect(Logic.crStatusMark("IN_PROGRESS")).toBe("▶ in progress");
    expect(Logic.crStatusMark("PENDING")).toBe("pending");
    // DISTINCT, not merely non-empty: with colour stripped the text is all
    // that is left, so two statuses sharing a mark is an unreadable state.
    const marks = ["COMPLETED", "COMPLETED_UNTRACKED", "IN_PROGRESS", "PENDING"].map((s) =>
      Logic.crStatusMark(s),
    );
    expect(new Set(marks).size).toBe(4);
    // The two completions must not collapse: "merged" and "shipped but never
    // tracked" are different facts about the same ✓ family.
    expect(Logic.crStatusMark("COMPLETED")).not.toBe(Logic.crStatusMark("COMPLETED_UNTRACKED"));
  });

  test("an unrecognised or absent status yields NO mark — a mark is a claim about execution state", () => {
    for (const status of ["", "NOPE", "completed", undefined, null, 7, {}]) {
      expect(Logic.crStatusMark(status)).toBe("");
    }
  });

  test("the RENDERED node carries exactly its status's mark, its own id, and no title", async () => {
    await mountApp({ queue: STATUS_QUEUE });
    expect(nodeCrs()).toEqual(["CR-M1", "CR-M2", "CR-M3", "CR-M4"]);
    // STATUS_QUEUE declares no wave, so all four rows are drawn (the loose
    // group takes no trim) in the fixture's own published order — which makes
    // the fixture itself the drawn-row list AC12's rule is applied to.
    const nextCr = firstActionableCr(STATUS_QUEUE);
    for (const entry of STATUS_QUEUE) {
      expect(nodeStatusText(entry.cr)).toBe(Logic.crStatusMark(entry.status));
      // BYTE-EXACT, so a one-word title cannot slip past as a suffix — and
      // RE-POINTED for CR-CRU-096 §S4/AC8, which put the row's ANNOTATION SLOT
      // (`next`, `deps <ids>`) after the mark. The expectation is still the
      // WHOLE rendered string, now `id + mark + the slot the FIXTURE earns`
      // and nothing else: it is built from the fixture's declared facts, never
      // read back out of the render, so a spurious annotation, a misplaced
      // `next` and a leaked title all still fail here.
      const node = nodeFor(entry.cr);
      expect((node.textContent ?? "").trim()).toBe(
        `${entry.cr}${Logic.crStatusMark(entry.status)}${expectedAnnotation(entry, nextCr)}`,
      );
      expect(node.textContent ?? "").not.toContain(entry.title!);
    }
    // The four literal strings, on the board, as words.
    expect(nodeStatusText("CR-M1")).toBe("✓ merged");
    expect(nodeStatusText("CR-M2")).toBe("✓ untracked");
    expect(nodeStatusText("CR-M3")).toBe("▶ in progress");
    expect(nodeStatusText("CR-M4")).toBe("pending");
  });
});

// ── AC12b/AC13/AC13a on a SYNTHETIC board ──────────────────────────────────
//
// CR-CRU-096 AC29 — this CR's annotation contract is stated on a fixture of
// this CR's own making. It was briefly pinned byte-exactly against the parsed
// LIVE board (`docs/changes/README.md`), which names the real `CR-CRU-<n>` ids
// of the project running Crucible — and the commit that added the assertion
// edited that README too, so fixture and backlog moved together. Crucible is
// project-INDEPENDENT: a criterion that only holds while our own backlog has a
// given shape is not a criterion. The live-shape suite below keeps what
// CR-CRU-078 built it for (scale, identity, the no-title rule) and so
// CORROBORATES this contract rather than stating it.

describe("CR-CRU-096 §S4/AC12b/AC13/AC13a — ONE `next` across the whole zone, and a `deps` slot naming every declared id", () => {
  /** Two wave boxes, arranged so the PER-BOX reading AC12b rules out would
   *  mark TWO rows: the second box opens with an actionable row of its own.
   *  Both boxes stay under `ROADMAP_WAVE_ROWS`, so the §S5 trim hides nothing
   *  and the drawn set is the fixture's actionable ∪ running members — the
   *  merged member rolls up (AC6a) and is no row. The first actionable row
   *  also declares a dependency, so the `next`+`deps` composition and the `·`
   *  join are exercised on the same row. */
  const ANNOTATION_QUEUE: QueueFixture[] = [
    { cr: "CR-W1-A", title: "CR-W1-A — the top of the scheduled queue", wave: "1", dependsOn: ["CR-W1-C"], status: "PENDING", seq: 10, release: "0.2.0" },
    { cr: "CR-W1-B", title: "CR-W1-B — under way, so it earns no dependency slot", wave: "1", dependsOn: ["CR-W1-A"], status: "IN_PROGRESS", seq: 20, release: "0.2.0" },
    { cr: "CR-W1-C", title: "CR-W1-C — merged, so it rolls up instead of drawing", wave: "1", dependsOn: [], status: "COMPLETED", seq: 30, release: "0.2.0" },
    { cr: "CR-W2-A", title: "CR-W2-A — the SECOND box's own first actionable row", wave: "2", dependsOn: ["CR-W1-A", "CR-W1-B"], status: "PENDING", seq: 40, release: "0.2.0" },
    { cr: "CR-W2-B", title: "CR-W2-B — deeper in the second box", wave: "2", dependsOn: ["CR-W2-A"], status: "PENDING", seq: 50, release: "0.2.0" },
  ];

  test("every drawn row is its id, its mark and exactly the slot the FIXTURE earns — the marker ONCE across both boxes", async () => {
    await mountApp({ queue: ANNOTATION_QUEUE });
    // Fixture guards: two boxes really are drawn, the merged member really is
    // absent, and the second box really does open with an actionable row —
    // without which the cross-box rule below would pass vacuously.
    expect(waveNames()).toEqual(["1", "2"]);
    expect(nodesInWave("1")).toEqual(["CR-W1-A", "CR-W1-B"]);
    expect(nodesInWave("2")).toEqual(["CR-W2-A", "CR-W2-B"]);

    const drawn = nodeCrs();
    const entryFor = (cr: string): QueueFixture =>
      ANNOTATION_QUEUE.find((entry) => entry.cr === cr)!;
    // AC12's rule applied ONCE across the drawn rows in document order, never
    // per box.
    const nextCr = firstActionableCr(drawn.map(entryFor));
    expect(nextCr).toBe("CR-W1-A");
    const wrong = drawn
      .map((cr) => ({
        cr,
        got: (nodeFor(cr).textContent ?? "").trim(),
        want: `${cr}${Logic.crStatusMark(entryFor(cr).status)}${expectedAnnotation(entryFor(cr), nextCr)}`,
      }))
      .filter((row) => row.got !== row.want);
    expect(wrong).toEqual([]);
    // Stated in LITERALS as well, so the sweep above cannot pass by agreeing
    // with a helper that is wrong in the same way: `next` first, then every
    // declared id in FULL (AC13a), joined by the design's `·`.
    expect((nodeFor("CR-W1-A").textContent ?? "").trim()).toBe(
      "CR-W1-Apendingnext · deps CR-W1-C",
    );
    expect((nodeFor("CR-W2-A").textContent ?? "").trim()).toBe(
      "CR-W2-Apendingdeps CR-W1-A, CR-W1-B",
    );
    // AC12b — ONE marker for the whole ZONE: the second box's first actionable
    // row carries none, and no other row does either.
    expect(nodeEls().filter((node) => (node.textContent ?? "").includes("next")).length).toBe(1);
  });
});

// ── The at-scale / live-shape render smoke ─────────────────────────────────
//
// Carried forward from the DELETED tests/roadmap-graph.test.ts, which was the
// only suite that rendered the REAL project shape rather than a hand-sized
// board. Every fixture above is deliberately small so that one AC's assertion
// cannot pass by accident; none of them would notice a renderer that only
// works at five rows.
//
// FIXTURE PROVENANCE — no server, no network, no git at test time:
//   • ENTRIES are PARSED from the checked-in `docs/changes/README.md` queue
//     table, which is the authored queue `queue register` ingests, so it IS the
//     real shape. The size stays UNPINNED — a guard asserts the table still
//     parses, so a README edit that breaks the shape is loud rather than
//     silently vacuous.
//   • The LEDGER is the measured `GET /api/v2/projects/<key>/releases` payload
//     (2026-08-27), kept NEWEST-FIRST exactly as the live read publishes it —
//     which is the whole point here: §S9's blocker was the strip rendering that
//     array order verbatim.
//   • The PROPOSAL is the authored `release-propose --target` shape for the
//     in-flight 0.2.0. The live board's ledger has no checked-in source and the
//     tracked `crucible.db` is an empty placeholder, so both are pinned as data.

const crIdList = (numbers: string): string[] =>
  numbers.split(/\s+/).filter(Boolean).map((n) => `CR-CRU-${n}`);

const livePackages = (version: string, ...registries: string[]): PackageFixture[] =>
  registries.map((registry) => ({
    registry,
    name: registry === "pypi" ? "crucible-axi" : "@anthill-tec/crucible-server",
    version,
  }));

/** `releasedAt` is epoch SECONDS (the tag's own commit date); `timestamp` is the
 *  ingest instant in ms and is NOT ship order. */
const LIVE_LEDGER: ReleaseFixture[] = [
  {
    version: "0.1.3",
    commit: "7408886",
    releasedAt: 1787819729,
    crs: ["CR-CRU-090"],
    packages: livePackages("0.1.3", "pypi", "npm"),
    timestamp: 1787830734630,
  },
  {
    version: "0.1.2",
    commit: "9ef24b1",
    releasedAt: 1787181002,
    crs: ["CR-CRU-066"],
    packages: livePackages("0.1.2", "pypi", "npm"),
    timestamp: 1787325487922,
  },
  {
    // The measured zero-CR release: the live payload OMITS `crs` rather than
    // sending `[]`, and `packages` still carries two entries.
    version: "0.1.1",
    commit: "abc30d5",
    releasedAt: 1787151205,
    packages: livePackages("0.1.1", "pypi", "npm"),
    timestamp: 1787325487410,
  },
  {
    version: "0.1.0",
    commit: "c07274c",
    releasedAt: 1787149125,
    crs: crIdList(`
      001 002 003 004 005 006 007 008 009 010 011 012 013 016 019 020 021 023 024 025 026
      027 028 029 030 031 032 033 034 035 036 037 038 039 040 041 042 043 044 045 046 047
      048 049 050 051 052 053 054 055 056 057 058 059 060 061 062 063 064 065
    `),
    packages: livePackages("0.1.0", "pypi"),
    timestamp: 1787325487188,
  },
];

const LIVE_PROPOSAL: ProposalFixture = {
  label: "0.2.0",
  targetAt: 1790000000,
  timestamp: 1787900000,
  waves: ["5"],
};

/**
 * The authored queue, read off the checked-in CR-queue table. One row is
 * `| [CR-NNN](file) | title | type | status | depends-on | wave |`.
 *
 * `status` keeps the leading token only — the table annotates it with the target
 * release (`COMPLETED (0.2.0)`), which is prose, not a status, and is where the
 * declared `release` comes from. `VOID` maps to `PENDING` because that is what
 * the live board reports for the one VOID row.
 *
 * `seq` is the row's authored POSITION on a 10-stride, not its array index:
 * stored `seq` is stamped per (release, wave) block, so it is never globally the
 * index, and a stride keeps a consumed `seq` distinguishable from a re-derived
 * one.
 */
function parseQueueTable(src: string): QueueFixture[] {
  const entries: QueueFixture[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("| [CR-")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const cr = /CR-[A-Z]+-\d{3}/.exec(cells[0]!)?.[0];
    if (cr === undefined) continue;
    const statusToken = /^[A-Z_]+/.exec(cells[3]!)?.[0];
    const release =
      /\((\d+\.\d+\.\d+)\)/.exec(cells[3]!)?.[1] ?? /\((\d+\.\d+\.\d+)\)/.exec(cells[5]!)?.[1];
    entries.push({
      cr,
      title: cells[1],
      wave: /^\d+/.exec(cells[5]!)?.[0] ?? cells[5]!,
      dependsOn: (cells[4]!.match(/\d{3}/g) ?? []).map((n) => `CR-CRU-${n}`),
      status: statusToken === "COMPLETED" ? "COMPLETED" : "PENDING",
      seq: entries.length * 10,
      ...(release === undefined ? {} : { release }),
    });
  }
  return entries;
}

const LIVE_ENTRIES: QueueFixture[] = parseQueueTable(
  readFileSync(path.join(REPO_ROOT, "docs/changes/README.md"), "utf8"),
);
const LIVE_IN_FLIGHT = LIVE_ENTRIES.filter((entry) => entry.release === "0.2.0");

describe("CR-CRU-078 AC1/AC28 — the whole board renders at the LIVE shape, not just at fixture scale", () => {
  test("the parsed fixture IS the real shape: a full queue, every dependency resolving, and a real release declared into", () => {
    // Guards on the FIXTURE, not a pinned size: if the README table stopped
    // parsing, every assertion below would pass vacuously.
    expect(LIVE_ENTRIES.length).toBeGreaterThan(80);
    const ids = new Set(LIVE_ENTRIES.map((entry) => entry.cr));
    const unknownDependencies = [
      ...new Set(
        LIVE_ENTRIES.flatMap((entry) => entry.dependsOn).filter((dep) => !ids.has(dep)),
      ),
    ].sort();
    expect(unknownDependencies).toEqual([]);
    // A real in-flight membership, and it is a strict SUBSET — so "renders the
    // focused release" is a different answer from "renders the queue".
    expect(LIVE_IN_FLIGHT.length).toBeGreaterThan(10);
    expect(LIVE_IN_FLIGHT.length).toBeLessThan(LIVE_ENTRIES.length);
    // Titles worth crowding an identifier out — the no-title assertion below
    // is not passing against a table that yields none.
    expect(LIVE_ENTRIES.filter((entry) => (entry.title ?? "").length > 20).length).toBeGreaterThan(
      40,
    );
    // The ledger really is newest-first, so a strip that echoes the array
    // order is visibly wrong at this shape.
    expect(LIVE_LEDGER.map((r) => r.version)).toEqual(["0.1.3", "0.1.2", "0.1.1", "0.1.0"]);
  });

  test("the strip is ONE monotonic sequence at the live shape — the exact board §S9's blocker rendered backwards", async () => {
    await mountApp({
      releases: LIVE_LEDGER,
      proposals: [LIVE_PROPOSAL],
      queue: LIVE_ENTRIES,
    });
    const gates = all('[data-testid="roadmap-gate"]');
    expect(gates.map((g) => g.getAttribute("data-version"))).toEqual([
      "0.1.0",
      "0.1.1",
      "0.1.2",
      "0.1.3",
      "0.2.0",
    ]);
    expect(gates.map((g) => g.getAttribute("data-kind"))).toEqual([
      "shipped",
      "shipped",
      "shipped",
      "shipped",
      "proposed",
    ]);
    // Monotonic by DATE across the whole run, not merely by array position.
    // ISO days sort lexicographically, so the rendered text is comparable.
    const dates = gates.map((g) =>
      (g.querySelector('[data-testid="roadmap-gate-date"]')?.textContent ?? "").trim(),
    );
    for (const day of dates) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! >= dates[i - 1]!).toBe(true);
    }
    // …and no zone opted out at this scale.
    expect(flowEl()).not.toBeNull();
    expect(rowEls().length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-strip-error"]')).toBeNull();
  });

  test("landing focuses the in-flight release: zone 3 carries its whole membership in authored order, and zone 2 draws its window on it", async () => {
    await mountApp({
      releases: LIVE_LEDGER,
      proposals: [LIVE_PROPOSAL],
      queue: LIVE_ENTRIES,
    });
    const declared = LIVE_IN_FLIGHT.map((entry) => entry.cr);
    // Zone 2: one container per wave, each STATING its whole membership (AC3)
    // while drawing only what CR-CRU-096 §S5 says it draws — the scheduled top
    // plus what is running. So membership is asserted on the counts, and the
    // drawn rows are asserted to be a WINDOW: a subsequence of the published
    // order, never a re-ordering of it (CR-CRU-091 AC18).
    expect(waveNames()).toEqual([...new Set(LIVE_IN_FLIGHT.map((entry) => entry.wave))]);
    const counted = waveEls().reduce(
      (sum, box) => sum + Number(box.getAttribute("data-cr-count")),
      0,
    );
    expect(counted).toBe(declared.length);
    const drawn = nodeCrs();
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(declared.length);
    expect(drawn).toEqual(declared.filter((cr) => drawn.includes(cr)));
    // Zone 3 follows the same focus and carries every member — never the whole
    // 91-row queue.
    expect(rowOrder()).toEqual(declared);
    expect(rowOrder().length).toBeLessThan(LIVE_ENTRIES.length);
  });

  test("focusing a SHIPPED release at the live shape renders its FROZEN membership and draws no waves", async () => {
    await mountApp({
      releases: LIVE_LEDGER,
      proposals: [LIVE_PROPOSAL],
      queue: LIVE_ENTRIES,
    });
    await clickGate("0.1.0");
    const frozen = LIVE_LEDGER.find((r) => r.version === "0.1.0")!.crs!;
    const inQueue = new Set(LIVE_ENTRIES.map((entry) => entry.cr));
    // Every one of 0.1.0's 60 frozen members is a row the queue still carries,
    // so the expectation is the ledger's list and not a filtered echo of it.
    expect(frozen.filter((cr) => !inQueue.has(cr))).toEqual([]);
    expect(frozen.length).toBeGreaterThan(50);
    expect(rowOrder().sort()).toEqual([...frozen].sort());
    // §S4 — a shipped release states what it delivered; the Workflow history
    // view owns historical waves.
    expect(waveEls().length).toBe(0);
  });

  test("every node at the live shape is its id plus its status mark, with no title anywhere in the text", async () => {
    await mountApp({
      releases: LIVE_LEDGER,
      proposals: [LIVE_PROPOSAL],
      queue: LIVE_ENTRIES,
    });
    // Read off the RENDERED nodes: after CR-CRU-096 §S5 zone 2 draws a window
    // on the membership, so an entry it does not draw has no node to read —
    // and every node it DOES draw is still a member of the focused release.
    const byCr = new Map(LIVE_IN_FLIGHT.map((entry) => [entry.cr, entry]));
    const rendered = nodeEls().map((node) => {
      const cr = node.getAttribute("data-cr") ?? "";
      return { cr, entry: byCr.get(cr), got: (node.textContent ?? "").trim() };
    });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.filter((row) => row.entry === undefined).map((row) => row.cr)).toEqual([]);
    // CR-CRU-078 AC11/AC28 at SCALE — every drawn node OPENS with its own id
    // and its status mark, so identity and the greyscale-safe mark survive at
    // the live shape. What a row may then ADD is CR-CRU-096's annotation
    // contract, and that contract is stated byte-exactly on that CR's own
    // SYNTHETIC fixture above (AC29): this board is parsed from
    // docs/changes/README.md and names the real CRs of the project running
    // Crucible, so it may corroborate the contract and never be the fixture
    // for it.
    const mismatched = rendered
      .filter((row) => !row.got.startsWith(`${row.cr}${Logic.crStatusMark(row.entry!.status)}`))
      .map((row) => ({ cr: row.cr, got: row.got }));
    expect(mismatched).toEqual([]);
    // Per-entry, so a long prose title is never mistaken for a status suffix.
    const leaking = rendered
      .filter((row) => row.got.includes(row.entry!.title ?? "\u0000"))
      .map((row) => row.cr);
    expect(leaking).toEqual([]);
  });
});
