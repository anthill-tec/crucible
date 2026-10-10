// CR-CRU-174 §S1, AC1's real-scale half — "on a copy of the dev store,
// 0.3.0's total equals the sum of its live CRs' points read from the same
// copy's queue (raw sqlite on the copy only)".
//
// Baseline (measured against this checkout): `handleAnalyticsBurndown` /
// `burndown()` answer no `totalPoints` field at all (see
// tests/release-live-total-points.test.ts's own baseline note), so the HTTP
// answer below always reads `totalPoints: undefined`, never the oracle sum
// computed independently from the SAME copy's raw queue rows — a mismatch
// for the right reason, not a typo.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// The live store is touched ONLY as one `copyFileSync` snapshot (database
// file + `-wal`/`-shm` siblings, when present) into an mkdtemp scratch
// directory; the original `data/crucible.db` is never opened by this file,
// and the server this test boots runs ENTIRELY against the scratch copy
// (a fresh, random port — never :3850/:3849/39877). When there is no dev
// store (CI, a clean checkout) the test states that and skips, as every
// other real-scale case in this suite does (see
// tests/commit-boundary-migrates-to-stored-columns.test.ts's own precedent).
//
// The ORACLE is a raw `bun:sqlite` read of the copy's `queue_entries` +
// `queue_declarations` tables ONLY — never the `Store` class, never
// `burndown()` — so a bug shared between the oracle and the production code
// cannot hide behind this test: "live CR" is read straight off
// `lifecycle_json` (absent, or present but neither VOID nor SUPERSEDED) and
// "its points" is the latest `queue_declarations` row naming that cr whose
// `points` column is not NULL — exactly the §S1 prose ("merged + pending;
// voided and superseded excluded; current points").
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const RELEASE = "0.3.0";
const LIVE_STORE = join(process.cwd(), "data", "crucible.db");

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * A PLAIN FILE COPY of the live store (main file + `-wal`/`-shm` siblings,
 * when present) into `dest` — `copyFileSync`, never `sqlite3 .backup`, and
 * the original is opened by nothing here. Returns `false` (never throws)
 * when there is no live store to copy.
 */
function copyLiveStore(dest: string): boolean {
  if (!existsSync(LIVE_STORE)) return false;
  copyFileSync(LIVE_STORE, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const src = `${LIVE_STORE}${suffix}`;
    if (existsSync(src)) copyFileSync(src, `${dest}${suffix}`);
  }
  return true;
}

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
 * copy ONLY (no `Store`, no `burndown()`) — every `queue_entries` row for
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

describe("CR-CRU-174 §S1 — real-scale: a copy of the dev store's own 0.3.0 live total", () => {
  test("0.3.0's totalPoints, served over HTTP from a copy of the dev store, equals the sum its queue's own rows name, read raw off the SAME copy", async () => {
    if (!existsSync(LIVE_STORE)) {
      console.log(
        `[CR-CRU-174 §S1] SKIPPED: no ${LIVE_STORE} to copy — a clean checkout and CI carry no dev ` +
          `store, and its data is never committed.`,
      );
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "release-live-total-devstore-"));
    scratchDirs.push(dir);
    const dbPath = join(dir, "crucible.db");
    if (!copyLiveStore(dbPath)) {
      throw new Error(`copyFileSync of ${LIVE_STORE} failed after existsSync reported it present`);
    }

    const projectKeys = releaseProjectKeys(dbPath, RELEASE);
    if (projectKeys.length === 0) {
      console.log(
        `[CR-CRU-174 §S1] SKIPPED: the dev store copy holds no ${RELEASE} queue rows to compare.`,
      );
      return;
    }

    // Every oracle read happens BEFORE the server (and the Store it opens)
    // ever touches the copy, so nothing here races the server's own reads.
    const oracleTotals = new Map(projectKeys.map((key) => [key, oracleLiveTotal(dbPath, key, RELEASE)]));

    handle = startServer({ port: 0, dbPath });
    const base = `http://localhost:${handle.server.port}`;

    let compared = 0;
    for (const projectKey of projectKeys) {
      const res = await fetch(
        `${base}/api/v2/projects/${projectKey}/analytics/burndown?release=${encodeURIComponent(RELEASE)}`,
      );
      if (res.status !== 200) {
        // An archived or otherwise unservable project for this release:
        // its oracle total is simply never compared, not a failure of this
        // real-scale proof's own concern (the route's own refusal rules).
        continue;
      }
      const body = (await res.json()) as { totalPoints?: number; committedPoints?: number };
      const oracle = oracleTotals.get(projectKey)!;
      expect(body.totalPoints).toBe(oracle);
      compared += 1;
    }

    if (compared === 0) {
      console.log(
        `[CR-CRU-174 §S1] SKIPPED: every project holding ${RELEASE} queue rows refused the burndown ` +
          `route on this copy (archived, or no CR ever planned into the release).`,
      );
    }
  });
});
