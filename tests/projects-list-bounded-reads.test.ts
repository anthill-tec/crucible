// The projects list (`handleProjectsList`, GET /api/v2/projects) is built from
// bounded reads: it no longer loads every event of every project to draw each
// project's card, and its payload is byte-identical to the whole-history
// derivation it replaces.
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       AC1 (a run view's reads stay fast while agents run). The page reads
//       the projects list on every heartbeat (the card's agentsOnline/
//       agentsTotal move with it), so a projects list that parses the whole
//       event history — every stored tree — costs the server's one thread
//       as much as the events list it no longer re-reads.
//
// Two halves:
//   - PAYLOAD: on a seeded store (several projects; many events; coverage on
//     some, several a day, two at the same instant; a failing run's coverage
//     discarded; records newer than every run; a project whose old days live
//     only in rollups; one with no events; one archived), the answer equals —
//     as JSON text — what the whole-history derivation (`listEvents` of every
//     event, then the first event, the first coverage-bearing event, and the
//     last-of-day coverage per UTC day merged over the rollups) yields.
//   - COST: the rows the handler reads from the store do not grow with the
//     event history: adding 200 runs without coverage leaves the count of rows
//     it reads unchanged (a row counter on the store's queries, not timing).
import { describe, test, expect, afterEach, setSystemTime, spyOn } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import { resolveLimit } from "../src/limits.ts";
import type { RunEvent, RunSummary } from "../src/types.ts";

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "projects-list-bounded-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

const AGENT = "projects-list-seed-agent";

function summary(failed = 0): RunSummary {
  return { total: 10, passed: 10 - failed, failed, pending: 0, duration_ms: 40 };
}

/** One test run at `at`; with `percent`, it carries line coverage. A tree with
 *  a few suites, so a whole-history read parses something real. */
function run(key: string, at: string, percent?: number, failed = 0): void {
  setSystemTime(new Date(at));
  handle!.store.recordTestEvent(
    key,
    AGENT,
    {
      summary: summary(failed),
      tree: [1, 2, 3].map((s) => ({
        name: `suite-${s}`,
        status: "pass" as const,
        children: [1, 2].map((l) => ({ name: `leaf-${l}`, status: "pass" as const, duration_ms: 1 })),
      })),
      ...(percent !== undefined
        ? { coverage: { lines: { total: 1000, covered: percent * 10, percent } } }
        : {}),
    },
    { tier: "unit" },
  );
}

function day(d: number, hh: number, mm = 0): string {
  return `2026-07-${String(10 + d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;
}

function project(key: string, name: string, retention: number): void {
  handle!.store.addProject({ key, name, type: "backend", sutRoot: "/tmp", retention });
}

const ALPHA = "00000000-0000-4000-8000-00000000a001";
const BETA = "00000000-0000-4000-8000-00000000b002";
const GAMMA = "00000000-0000-4000-8000-00000000c003";
const DELTA = "00000000-0000-4000-8000-00000000d004";
const NOW = "2026-07-17T00:00:00.000Z";

function seed(): void {
  // ALPHA — many runs over six UTC days; coverage on some, several a day.
  project(ALPHA, "alpha", 1_000_000);
  for (let d = 0; d < 6; d++) {
    for (let h = 0; h < 20; h++) run(ALPHA, day(d, h, 5));
    run(ALPHA, day(d, 8, 30), 60 + d);
    run(ALPHA, day(d, 21, 30), 70 + d);
  }
  // Two coverage runs at the SAME instant on day 2: the later insert is newer.
  run(ALPHA, day(2, 22), 81);
  run(ALPHA, day(2, 22), 82);
  // A failing run carries no coverage (it is discarded on a red run).
  run(ALPHA, day(5, 23), 99, 2);
  // Records newer than every run, at the same instant as one more run: a
  // release, a gate for that released version (retired on arrival, so never
  // in the feed), and a live gate — the newest row of all.
  run(ALPHA, day(6, 1), 90);
  setSystemTime(new Date(day(6, 1)));
  handle!.store.recordMilestoneEvent(ALPHA, AGENT, "release", { label: "9.9.9" });
  handle!.store.recordGateEvent(ALPHA, AGENT, { outcome: "pass", steps: [] }, { version: "9.9.9" });
  handle!.store.recordGateEvent(ALPHA, AGENT, { outcome: "pass", steps: [] });

  // BETA — a small retention: its old days survive only as rollups.
  project(BETA, "beta", 5);
  for (let d = 0; d < 4; d++) {
    run(BETA, day(d, 9), 40 + d);
    run(BETA, day(d, 12));
    run(BETA, day(d, 15), 50 + d);
  }

  // GAMMA — no events at all.
  project(GAMMA, "gamma", 100);

  // DELTA — runs with coverage, then archived.
  project(DELTA, "delta", 100);
  run(DELTA, day(1, 10), 33);
  run(DELTA, day(2, 10));
  handle!.store.archiveProject(DELTA);
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getText(path: string): Promise<string> {
  const res = await fetch(`${base()}${path}`);
  expect(res.status).toBe(200);
  return res.text();
}

/** The events list's brief of a project's newest event — the same brief the
 *  projects list draws its `lastEvent` with — or null. */
async function newestBrief(key: string): Promise<unknown> {
  const body = JSON.parse(await getText(`/api/v2/events?project=${key}&limit=1`)) as {
    events: Array<Record<string, unknown>>;
  };
  const first = body.events[0];
  if (first === undefined) return null;
  const { decisionSummary: _ignored, ...brief } = first;
  return brief;
}

/** The whole-history derivation: every event, read through `listEvents`. */
async function wholeHistoryProjects(archived: boolean): Promise<unknown[]> {
  const store = handle!.store;
  const inactiveMs = resolveLimit("project_inactive_ms");
  const now = Date.now();
  const projects = [];
  for (const p of store.listProjects(archived)) {
    const agents = store.listAgents(p.key);
    const events: RunEvent[] = store.listEvents(p.key, Number.MAX_SAFE_INTEGER);
    const last = events[0];
    const greenCovered = events.find((e) => e.coverage !== undefined);
    const byDay = new Map<string, number>();
    for (const r of store.listRollups(p.key)) {
      if (r.lastCoverage !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(r.bucket)) {
        byDay.set(r.bucket, r.lastCoverage.lines.percent);
      }
    }
    const seen = new Set<string>();
    for (const e of events) {
      if (e.coverage === undefined) continue;
      const d = new Date(e.timestamp).toISOString().slice(0, 10);
      if (seen.has(d)) continue;
      seen.add(d);
      byDay.set(d, e.coverage.lines.percent);
    }
    const coverageTrend = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([d, percent]) => ({ day: d, percent }));
    const lastActivity = Math.max(last?.timestamp ?? 0, ...agents.map((a) => a.lastSeen), 0);
    const ageMs = Math.floor((now - lastActivity) / 1000) * 1000;
    projects.push({
      ...p,
      agentsOnline: agents.filter((a) => a.liveness !== "tombstoned").length,
      agentsTotal: agents.length,
      lastEvent: last !== undefined ? await newestBrief(p.key) : null,
      latestGreenCoverage: greenCovered?.coverage ?? null,
      ...(greenCovered !== undefined ? { latestCoverageEventId: greenCovered.id } : {}),
      ...(coverageTrend.length > 0 ? { coverageTrend } : {}),
      active: ageMs <= inactiveMs,
      lastActivity,
    });
  }
  projects.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
  return projects;
}

/** Counts the rows the store's queries hand back while `body` runs. */
async function rowsRead(body: () => Promise<unknown>): Promise<number> {
  const db = (handle!.store as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  let rows = 0;
  const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
    const stmt = query(sql) as Statement;
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "all" || prop === "values") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            rows += out.length;
            return out;
          };
        }
        if (prop === "get") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            if (out !== null && out !== undefined) rows += 1;
            return out;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }) as typeof db.query);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return rows;
}

describe("the projects list is built from bounded reads", () => {
  test("the payload is byte-identical to the whole-history derivation, for the live and the archived listing", async () => {
    boot();
    seed();
    setSystemTime(new Date(NOW));

    const live = JSON.parse(await getText("/api/v2/projects")) as { ok: boolean; projects: unknown[] };
    expect(live.ok).toBe(true);
    expect(live.projects.length).toBe(3);
    expect(JSON.stringify(live.projects)).toBe(JSON.stringify(await wholeHistoryProjects(false)));

    // The seed exercised what the derivation draws: a newest record, a
    // coverage trend merged over rollups, and a project with nothing.
    const byKey = new Map(
      (live.projects as Array<Record<string, unknown>>).map((p) => [p.key as string, p]),
    );
    expect((byKey.get(ALPHA)!.lastEvent as { kind: string }).kind).toBe("gate");
    expect((byKey.get(ALPHA)!.coverageTrend as unknown[]).length).toBe(7);
    expect((byKey.get(BETA)!.coverageTrend as unknown[]).length).toBe(4);
    expect(byKey.get(GAMMA)!.lastEvent).toBeNull();
    expect("coverageTrend" in byKey.get(GAMMA)!).toBe(false);

    const archived = JSON.parse(await getText("/api/v2/projects?archived=true")) as { projects: unknown[] };
    expect(archived.projects.length).toBe(1);
    expect(JSON.stringify(archived.projects)).toBe(JSON.stringify(await wholeHistoryProjects(true)));
  });

  test("the rows the handler reads do not grow with the event history", async () => {
    boot();
    project(ALPHA, "alpha", 1_000_000);
    for (let d = 0; d < 4; d++) {
      for (let h = 0; h < 5; h++) run(ALPHA, day(d, h));
      run(ALPHA, day(d, 12), 50 + d);
    }
    setSystemTime(new Date(NOW));
    const before = await rowsRead(() => getText("/api/v2/projects"));

    // 200 more runs, none carrying coverage, on the same days.
    for (let d = 0; d < 4; d++) {
      for (let i = 0; i < 50; i++) run(ALPHA, day(d, 13 + Math.floor(i / 6), i % 60));
    }
    setSystemTime(new Date(NOW));
    const after = await rowsRead(() => getText("/api/v2/projects"));

    expect(before).toBeGreaterThan(0);
    expect(after, `the projects list read ${after - before} more rows after 200 more runs`).toBe(before);
  });
});
