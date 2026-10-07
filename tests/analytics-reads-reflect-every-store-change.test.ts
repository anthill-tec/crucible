// §S3 — the analytics cache is removed: each of the four analytics reads
// (velocity, burndown, forecast and the plan-change counts) is computed on
// EVERY request, so it always reflects the store's current state.
//
// Proof technique: a write that moves the figure WITHOUT ever calling a
// `Store` method — a raw SQL write through a SECOND `bun:sqlite` connection
// to the same file (the precedent `tests/event-cycle-id-backfill.test.ts`
// and `tests/closing-a-plan-stores-its-commit-boundary.test.ts` already use
// for "read what a crash would recover, not what the Store API derives").
// Such a write fires NO `Store.onChange` event at all — not `"events"`, not
// anything — so `AnalyticsCache` (which only drops a project's held answers
// on an `"events"`-kind change) is never told the underlying numbers moved.
//
// Against TODAY's cached code every one of these tests FAILS: the first
// read populates the cache; the direct write invalidates nothing; the
// second read is served the STALE cached answer, identical to the first.
// Once §S3 removes the cache (every handler always recomputes), the second
// read reflects the write's exact new value — the assertions below.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

/** Narrow a store op's `T | { error: string }` union, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  return result as Exclude<T, { error: string }>;
}

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function boot(): { handle: ServerHandle; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "analytics-fresh-"));
  scratchDirs.push(dir);
  const dbPath = join(dir, "crucible.db");
  handle = startServer({ port: 0, dbPath });
  return { handle, dbPath };
}

interface AnalyticsBody {
  ok?: boolean;
  release?: string;
  pointsPerDay?: number;
  days?: Array<{ day: string; points: number }>;
  committedPoints?: number;
  remainingPoints?: number;
  status?: string;
  changes?: { "spec-design"?: number; "gap-analysis"?: number; unrecorded?: number };
  [key: string]: unknown;
}

async function getJson(h: ServerHandle, path: string): Promise<{ status: number; body: AnalyticsBody }> {
  const res = await fetch(`http://localhost:${h.server.port}${path}`);
  let body: AnalyticsBody = {};
  try {
    body = (await res.json()) as AnalyticsBody;
  } catch {
    // No JSON body on some failure shapes — fail on the FIELDS below, never
    // on a JSON.parse throw.
  }
  return { status: res.status, body };
}

/** A fresh raw connection to the SAME file the Store already has open. */
function rawConnection(dbPath: string): Database {
  return new Database(dbPath);
}

const P_VELOCITY = "00000000-0000-4000-8000-0000c0000001";
const P_BURNDOWN = "00000000-0000-4000-8000-0000c0000002";
const P_FORECAST = "00000000-0000-4000-8000-0000c0000003";
const P_CHANGES = "00000000-0000-4000-8000-0000c0000004";

describe("§S3 — AnalyticsCache no longer exists", () => {
  test("src/analytics-cache.ts does not exist", () => {
    expect(existsSync("src/analytics-cache.ts")).toBe(false);
  });

  test("no file under src/ imports analyticsCacheFor or names AnalyticsCache", () => {
    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTsFiles(full));
        else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const offenders: string[] = [];
    for (const file of walkTsFiles("src")) {
      const text = readFileSync(file, "utf8");
      if (text.includes("analyticsCacheFor") || text.includes("AnalyticsCache")) {
        offenders.push(file);
      }
    }
    // POSITIVE/BOUND — the empty list names which files remain, instead of
    // a bare boolean, so a failure here is diagnostic, not just "false".
    expect(offenders).toEqual([]);
  });
});

describe("the four analytics reads recompute on every request — no held answer survives a store change the cache was never told about", () => {
  test("velocity's pointsPerDay and today's series reflect a release member's re-pointed, already-merged plan, even though the re-point fired no `events` change", async () => {
    const { handle: h, dbPath } = boot();
    const release = "9.9.0";
    h.store.addProject({ key: P_VELOCITY, name: "velocity-fresh", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    h.store.upsertQueueEntry(P_VELOCITY, { cr: "CR-ALPHA", release, wave: "1", title: "CR-ALPHA", points: 3 });
    const plan = planned(
      h.store.filePlan(P_VELOCITY, { cr: "CR-ALPHA", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    const cycleId = plan.cycles[0]!.id;
    planned(h.store.transitionCycle(P_VELOCITY, plan.planId, cycleId, "active"));
    planned(h.store.transitionCycle(P_VELOCITY, plan.planId, cycleId, "done"));
    planned(h.store.closePlan(P_VELOCITY, plan.planId, { commit: "merge001" }));

    const before = await getJson(h, `/api/v2/projects/${P_VELOCITY}/analytics/velocity?release=${release}`);
    expect(before.status).toBe(200);
    // POSITIVE — one merged, 3-point cr, merged today: a single-day series.
    expect(before.body.days).toHaveLength(1);
    expect(before.body.days![0]!.points).toBe(3);
    expect(before.body.pointsPerDay).toBe(3);

    // A direct write to the declaration journal — bypasses EVERY store
    // method (`upsertQueueEntry`, `appendCycle`, …), so it fires NO
    // `Store.onChange` event the cache could ever have been told about.
    const raw = rawConnection(dbPath);
    raw
      .query(
        `INSERT INTO queue_declarations (project_key, cr, verb, change_json, points, author, at)
         VALUES (?, ?, 'cr-plan', ?, ?, NULL, ?)`,
      )
      .run(P_VELOCITY, "CR-ALPHA", JSON.stringify({ points: { from: 3, to: 8 } }), 8, Date.now());
    raw.close();

    const after = await getJson(h, `/api/v2/projects/${P_VELOCITY}/analytics/velocity?release=${release}`);
    expect(after.status).toBe(200);
    // POSITIVE — the fresh read reflects the new 8 points on the SAME day;
    // NEGATIVE/BOUND — never the stale 3 the cache would have held.
    expect(after.body.days![0]!.points).toBe(8);
    expect(after.body.pointsPerDay).toBe(8);
  });

  test("burndown's committedPoints reflects a release member's re-point, even though the re-point fired no `events` change", async () => {
    const { handle: h, dbPath } = boot();
    const release = "9.9.0";
    h.store.addProject({ key: P_BURNDOWN, name: "burndown-fresh", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    h.store.upsertQueueEntry(P_BURNDOWN, { cr: "CR-BETA", release, wave: "1", title: "CR-BETA", points: 5 });

    const before = await getJson(h, `/api/v2/projects/${P_BURNDOWN}/analytics/burndown?release=${release}`);
    expect(before.status).toBe(200);
    expect(before.body.committedPoints).toBe(5);

    const raw = rawConnection(dbPath);
    raw
      .query(
        `INSERT INTO queue_declarations (project_key, cr, verb, change_json, points, author, at)
         VALUES (?, ?, 'cr-plan', ?, ?, NULL, ?)`,
      )
      .run(P_BURNDOWN, "CR-BETA", JSON.stringify({ points: { from: 5, to: 12 } }), 12, Date.now());
    raw.close();

    const after = await getJson(h, `/api/v2/projects/${P_BURNDOWN}/analytics/burndown?release=${release}`);
    expect(after.status).toBe(200);
    // POSITIVE — the re-point lands as a +7 step; NEGATIVE/BOUND — never
    // the stale 5 the cache would have held.
    expect(after.body.committedPoints).toBe(12);
  });

  test("forecast's remainingPoints reflects a release member's re-point, even though the re-point fired no `events` change", async () => {
    const { handle: h, dbPath } = boot();
    const release = "9.9.0";
    h.store.addProject({ key: P_FORECAST, name: "forecast-fresh", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    h.store.upsertQueueEntry(P_FORECAST, { cr: "CR-GAMMA", release, wave: "1", title: "CR-GAMMA", points: 4 });

    const before = await getJson(h, `/api/v2/projects/${P_FORECAST}/analytics/forecast?release=${release}`);
    expect(before.status).toBe(200);
    expect(before.body.remainingPoints).toBe(4);
    expect(before.body.status).toBe("insufficient_history");

    const raw = rawConnection(dbPath);
    raw
      .query(
        `INSERT INTO queue_declarations (project_key, cr, verb, change_json, points, author, at)
         VALUES (?, ?, 'cr-plan', ?, ?, NULL, ?)`,
      )
      .run(P_FORECAST, "CR-GAMMA", JSON.stringify({ points: { from: 4, to: 9 } }), 9, Date.now());
    raw.close();

    const after = await getJson(h, `/api/v2/projects/${P_FORECAST}/analytics/forecast?release=${release}`);
    expect(after.status).toBe(200);
    // POSITIVE — remainingPoints moves from 4 to 9; NEGATIVE/BOUND — never
    // the stale 4 the cache would have held.
    expect(after.body.remainingPoints).toBe(9);
    expect(after.body.status).toBe("insufficient_history");
  });

  test("the plan-change counts reflect a cycle's recorded change, even though the write fired no `events` change", async () => {
    const { handle: h, dbPath } = boot();
    const release = "9.9.0";
    h.store.addProject({ key: P_CHANGES, name: "changes-fresh", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    h.store.upsertQueueEntry(P_CHANGES, { cr: "CR-DELTA", release, wave: "1", title: "CR-DELTA", points: 3 });
    const plan = planned(
      h.store.filePlan(P_CHANGES, { cr: "CR-DELTA", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    const cycleId = plan.cycles[0]!.id;

    const before = await getJson(h, `/api/v2/projects/${P_CHANGES}/analytics/changes?release=${release}`);
    expect(before.status).toBe(200);
    expect(before.body.changes?.["spec-design"]).toBe(0);

    // A direct write to the cycle row — bypasses `appendCycle` (the only
    // store path that records a change AND emits `"events"`), so it fires NO
    // `Store.onChange` event the cache could ever have been told about.
    const raw = rawConnection(dbPath);
    raw
      .query(`UPDATE plan_cycles SET change_kind = ?, change_cause = ? WHERE project_key = ? AND cycle_id = ?`)
      .run("append", "spec-design", P_CHANGES, cycleId);
    raw.close();

    const after = await getJson(h, `/api/v2/projects/${P_CHANGES}/analytics/changes?release=${release}`);
    expect(after.status).toBe(200);
    // POSITIVE — the recorded append is counted; NEGATIVE/BOUND — never the
    // stale 0 the cache would have held, and never counted twice.
    expect(after.body.changes?.["spec-design"]).toBe(1);
    expect(after.body.changes?.["gap-analysis"] ?? 0).toBe(0);
  });
});
