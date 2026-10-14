// §S1, AC1's real-scale half — "a release's total equals the sum
// of its live CRs' points read from the same store's queue (raw sqlite)",
// proved over a POPULATED store this file builds itself.
//
// Baseline (measured against this checkout): `handleAnalyticsBurndown` /
// `burndown()` answer no `totalPoints` field at all (see
// tests/release-live-total-points.test.ts's own baseline note), so the HTTP
// answer below always reads `totalPoints: undefined`, never the oracle sum
// computed independently from the SAME store's raw queue rows — a mismatch
// for the right reason, not a typo.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// The store is a POPULATED one this file builds itself
// (tests/helpers/populated-store.ts) in an mkdtemp scratch directory: several
// projects, one archived, each queueing the release with pointed, unpointed,
// re-pointed, voided, superseded and moved-out entries and one whose plan
// merged. The server this test boots runs ENTIRELY against that scratch file
// (a fresh, random port — never :3850/:3849/39877). Nothing here reads the
// operator's dev store, so the verdict depends on the code alone.
//
// The ORACLE is a raw `bun:sqlite` read of the store's `queue_entries` +
// `queue_declarations` tables ONLY — never the `Store` class, never
// `burndown()` — so a bug shared between the oracle and the production code
// cannot hide behind this test: "live CR" is read straight off
// `lifecycle_json` (absent, or present but neither VOID nor SUPERSEDED) and
// "its points" is the latest `queue_declarations` row naming that cr whose
// `points` column is not NULL — exactly the §S1 prose ("merged + pending;
// voided and superseded excluded; current points").
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { POPULATED_RELEASE, populateStore } from "./helpers/populated-store.ts";

const RELEASE = POPULATED_RELEASE;

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function releaseProjectKeys(dbPath: string, release: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ project_key: string }, [string]>(
        `SELECT DISTINCT project_key FROM queue_entries WHERE release = ?`,
      )
      .all(release)
      .map((row) => row.project_key);
  } finally {
    db.close();
  }
}

interface RawLifecycleRow {
  cr: string;
  lifecycle_json: string | null;
}

/**
 * The frozen oracle for §S1's "the release's live total": raw SQL over the
 * store ONLY (no `Store`, no `burndown()`) — every `queue_entries` row for
 * this (project, release) that is NOT dead (`lifecycle_json` absent, or
 * present with neither state VOID nor SUPERSEDED), summing each one's
 * latest `queue_declarations.points` (its CURRENT points; a cr with no such
 * row contributes nothing — unpointed, per §S1's own excluded list).
 */
function oracleLiveTotal(dbPath: string, projectKey: string, release: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<RawLifecycleRow, [string, string]>(
        `SELECT cr, lifecycle_json FROM queue_entries WHERE project_key = ? AND release = ?`,
      )
      .all(projectKey, release);
    let total = 0;
    for (const row of rows) {
      if (row.lifecycle_json !== null) {
        const lifecycle = JSON.parse(row.lifecycle_json) as { state?: string };
        if (lifecycle.state === "VOID" || lifecycle.state === "SUPERSEDED") continue;
      }
      const pointsRow = db
        .query<{ points: number }, [string, string]>(
          `SELECT points FROM queue_declarations
            WHERE project_key = ? AND cr = ? AND points IS NOT NULL
            ORDER BY id DESC LIMIT 1`,
        )
        .get(projectKey, row.cr);
      if (pointsRow !== null) total += pointsRow.points;
    }
    return total;
  } finally {
    db.close();
  }
}

/** Every queue row's lifecycle state for `release`, across projects (raw). */
function rawLifecycleStates(dbPath: string, release: string): Array<string | null> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ lifecycle_json: string | null }, [string]>(
        `SELECT lifecycle_json FROM queue_entries WHERE release = ?`,
      )
      .all(release)
      .map((row) =>
        row.lifecycle_json === null
          ? null
          : ((JSON.parse(row.lifecycle_json) as { state?: string }).state ?? null),
      );
  } finally {
    db.close();
  }
}

describe("§S1 — real-scale: a populated store's own live release total", () => {
  test("the release's totalPoints, served over HTTP from a populated store, equals the sum its queue's own rows name, read raw off the SAME store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-live-total-populated-"));
    scratchDirs.push(dir);
    const dbPath = join(dir, "crucible.db");
    const built = Store.open(dbPath);
    const populated = populateStore(built);
    (built as unknown as { db: Database }).db.close();

    const projectKeys = releaseProjectKeys(dbPath, RELEASE);
    // Non-vacuity: every populated project queues the release, and the queue
    // really holds the rows the oracle must exclude.
    expect(projectKeys.sort()).toEqual(populated.projects.map((project) => project.key).sort());
    const lifecycles = rawLifecycleStates(dbPath, RELEASE);
    expect(lifecycles.filter((state) => state === "VOID").length).toBe(projectKeys.length);
    expect(lifecycles.filter((state) => state === "SUPERSEDED").length).toBe(projectKeys.length);

    // Every oracle read happens BEFORE the server (and the Store it opens)
    // ever touches the file, so nothing here races the server's own reads.
    const oracleTotals = new Map(projectKeys.map((key) => [key, oracleLiveTotal(dbPath, key, RELEASE)]));
    for (const total of oracleTotals.values()) expect(total).toBeGreaterThan(0);

    handle = startServer({ port: 0, dbPath });
    const base = `http://localhost:${handle.server.port}`;

    // Compared for every LIVE project. An archived project's queue is not
    // served (`listQueue` answers it empty), so its burndown is no measure of
    // its rows; the oracle still reads its rows above, so the population the
    // raw read walks is the whole store.
    const liveKeys = new Set(
      populated.projects.filter((project) => !project.archived).map((project) => project.key),
    );
    expect(liveKeys.size).toBeGreaterThan(1);
    let compared = 0;
    for (const projectKey of projectKeys.filter((key) => liveKeys.has(key))) {
      const res = await fetch(
        `${base}/api/v2/projects/${projectKey}/analytics/burndown?release=${encodeURIComponent(RELEASE)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { totalPoints?: number; committedPoints?: number };
      const oracle = oracleTotals.get(projectKey)!;
      expect(body.totalPoints).toBe(oracle);
      compared += 1;
    }

    expect(compared).toBe(liveKeys.size);
  });
});
