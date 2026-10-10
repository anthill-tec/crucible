// CR-CRU-165 §S3/AC12 — a NEW analytics read: per-release counts of recorded
// plan changes (insert, rename, non-FIX append, skip) and plan aborts, each
// broken down by cause (spec-design | gap-analysis), with a pre-existing
// skip/abort that carries no record (this CR's own 23 historical skips +
// the aborted plans before it, §S3's words, "never back-filled") counted as
// `unrecorded` rather than dropped or guessed.
//
// Shape decision (RED-authored, narrowest reading of AC12's own text —
// "counts recorded plan changes … and aborts per release, by cause"): one
// new GET-only route beside the existing three (src/v2.ts's
// `analytics` dispatch, §S2–§S4 of CR-CRU-022) —
//   GET /api/v2/projects/<key>/analytics/changes?release=<label>
//   -> { ok: true, release, changes: {"spec-design": n, "gap-analysis": n,
//        unrecorded: n}, aborts: {"spec-design": n, "gap-analysis": n,
//        unrecorded: n} }
// — two flat per-cause count maps, nothing else. Release MEMBERSHIP is read
// off the queue's CURRENT `release` field (`store.listQueue`, the same
// `QueueEntry.release` the burndown/forecast reads already key off) — unlike
// `burndown`'s full declaration-journal replay (which exists to reconstruct
// a release's STORY-POINT scope over time), a plan-change/abort COUNT has no
// time dimension to replay: it is a present-tense count of what a release's
// CURRENT members carry, so this file never touches
// `store.listQueueDeclarations`. Error/validation shape mirrors the existing
// three reads exactly: `requireHeldProject` (400 bad UUID / 404 unknown
// project) and `requireReleaseParam` (400 missing `release`); zero members
// for the named release -> 404, verbatim precedent from
// `handleAnalyticsBurndown`.
//
// A cycle whose `changeKind` is `"abort"` (the pending cycles a PLAN abort
// cascades to `skipped`, §S2b) is counted ONCE at the PLAN level inside
// `aborts`, never a second time inside `changes` — the negative bound this
// file's main test proves by exact count (a double-counting GREEN would
// inflate `changes["gap-analysis"]` from 1 to 2).
//
// Baseline (measured against current src/v2.ts / src/analytics.ts): no
// `analytics/changes` segment is dispatched (`segments[2] === "velocity" |
// "burndown" | "forecast"` is the full list) and `src/analytics.ts` exports
// no change/abort counting function at all, so every request below 404s
// with an unknown-route body, not the `{changes, aborts}` payload — every
// assertion on `body.changes`/`body.aborts` fails against production.
//
// Fixture technique for the "unrecorded" bucket: a real pre-CR-165
// (schema v13) sqlite file, built from the LITERAL pre-migration
// `plans`/`plan_cycles` DDL (same technique as
// tests/cycle-change-fields-storage-migration.test.ts's `makeLegacyStore` —
// never a downgrade of a future build), carrying an ALREADY-aborted plan
// with an ALREADY-skipped cycle, neither with a reason/cause/specRef column
// to even populate (those columns don't exist pre-migration) — booting the
// real server against it runs the real v14 migration, so the "no record"
// case is genuine legacy data, not a hand-waved absent field on an
// otherwise-fresh board.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { ChangeRecord } from "../src/types.ts";

/** Narrow a store op's `T | { error: string }` union, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  return result as Exclude<T, { error: string }>;
}

interface ChangeCounts {
  "spec-design"?: number;
  "gap-analysis"?: number;
  unrecorded?: number;
  [key: string]: unknown;
}
interface ChangesBody {
  ok?: boolean;
  release?: string;
  changes?: ChangeCounts;
  aborts?: ChangeCounts;
  [key: string]: unknown;
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

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru165-changes-"));
  scratchDirs.push(dir);
  return dir;
}

function boot(dbPath?: string): ServerHandle {
  const dir = scratch();
  handle = startServer({ port: 0, dbPath: dbPath ?? join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getChanges(
  key: string,
  release?: string,
): Promise<{ status: number; body: ChangesBody }> {
  const qs = release !== undefined ? `?release=${encodeURIComponent(release)}` : "";
  const res = await fetch(`${base()}/api/v2/projects/${key}/analytics/changes${qs}`);
  let body: ChangesBody = {};
  try {
    body = (await res.json()) as ChangesBody;
  } catch {
    // Not-yet-existing route: no JSON body. Fail on the FIELDS below.
  }
  return { status: res.status, body };
}

/**
 * A pre-CR-165 (user_version 13) file: literal pre-migration `plans`/
 * `plan_cycles`/`projects` DDL (lifted verbatim from
 * tests/cycle-change-fields-storage-migration.test.ts's makeLegacyStore),
 * carrying ONE plan that is already `aborted` with ONE cycle already
 * `skipped` — neither column exists yet to even hold a reason.
 */
function makeLegacyStore(dir: string, key: string, cr: string): string {
  const dbPath = join(dir, "legacy.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(`PRAGMA journal_mode = DELETE;`);
    db.exec(`
      CREATE TABLE plans (
        plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        cr TEXT NOT NULL,
        title TEXT,
        orchestrator TEXT,
        wave TEXT,
        track TEXT,
        status TEXT NOT NULL,
        merge_commit TEXT,
        closed_at INTEGER
      );
      CREATE TABLE plan_cycles (
        project_key TEXT NOT NULL,
        cycle_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        activated_at INTEGER,
        done_at INTEGER,
        active_ms_accumulated INTEGER,
        seq REAL,
        PRIMARY KEY (project_key, cycle_id)
      );
      CREATE TABLE projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sut_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        liveness TEXT,
        retention INTEGER,
        archived_at INTEGER,
        allow_run_deletion INTEGER
      );
    `);
    db.query(
      `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, 'legacy-cru165-changes', 'backend', '/tmp', 1700000000000)`,
    ).run(key);
    db.query(
      `INSERT INTO plans (plan_id, project_key, cr, status, wave) VALUES (9101, ?, ?, 'aborted', '1')`,
    ).run(key, cr);
    db.query(
      `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status, seq, done_at)
       VALUES (?, 101, 9101, 'legacy skipped (no reason)', 'red-green', 'skipped', 1, 1700000000000)`,
    ).run(key);
    db.exec(`PRAGMA user_version = 13;`);
  } finally {
    db.close();
  }
  return dbPath;
}

function record(suffix: string, cause: "spec-design" | "gap-analysis"): ChangeRecord {
  return { reason: `r-${suffix}`, cause, specRef: `ref-${suffix}` };
}

describe("AC12 — GET …/analytics/changes: recorded plan changes and aborts per release, by cause", () => {
  test("counts insert/rename/non-FIX-append/skip under `changes` and plan aborts under `aborts`, both by cause, with the legacy (pre-CR-165) skip+abort counted as unrecorded and an abort's own cascaded cycle-skip counted ONCE (never doubled into `changes`)", async () => {
    const key = "00000000-0000-7000-8165-000000000c01";
    const RELEASE = "9.9.0";
    boot(makeLegacyStore((() => scratch())(), key, "CR-LEGACY-ABORTED-C165"));

    handle!.store.upsertQueueEntry(key, {
      cr: "CR-LEGACY-ABORTED-C165",
      release: RELEASE,
      wave: "1",
      title: "legacy aborted",
    });

    // append (non-FIX, recorded) — cause spec-design.
    const planAppend = planned(
      handle!.store.filePlan(key, { cr: "CR-NEW-APPEND", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(
      handle!.store.appendCycle(
        key,
        planAppend.planId,
        { label: "c2 extra", kind: "red-green" },
        undefined,
        record("append", "spec-design"),
      ),
    );

    // rename (recorded) — cause gap-analysis.
    const planRename = planned(
      handle!.store.filePlan(key, { cr: "CR-NEW-RENAME", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(
      handle!.store.editCycleLabel(
        key,
        planRename.planId,
        planRename.cycles[0]!.id,
        "c1 renamed",
        record("rename", "gap-analysis"),
      ),
    );

    // skip (recorded) — cause spec-design.
    const planSkip = planned(
      handle!.store.filePlan(key, {
        cr: "CR-NEW-SKIP",
        cycles: [{ label: "c1", kind: "red-green" }, { label: "c2", kind: "red-green" }],
      }),
    );
    planned(
      handle!.store.transitionCycle(
        key,
        planSkip.planId,
        planSkip.cycles[0]!.id,
        "skipped",
        record("skip", "spec-design"),
      ),
    );

    // insert-before (recorded) — cause spec-design.
    const planInsert = planned(
      handle!.store.filePlan(key, { cr: "CR-NEW-INSERT", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(
      handle!.store.appendCycle(
        key,
        planInsert.planId,
        { label: "c0 inserted", kind: "red-green" },
        planInsert.cycles[0]!.id,
        record("insert", "spec-design"),
      ),
    );

    // abort (recorded) — cause gap-analysis; its own pending cycle cascades
    // to `skipped` with changeKind "abort" and must NOT also land in `changes`.
    const planAbort = planned(
      handle!.store.filePlan(key, {
        cr: "CR-NEW-ABORT",
        cycles: [{ label: "c1", kind: "red-green" }, { label: "c2", kind: "red-green" }],
      }),
    );
    planned(handle!.store.transitionCycle(key, planAbort.planId, planAbort.cycles[0]!.id, "active"));
    planned(handle!.store.abortPlan(key, planAbort.planId, record("abort", "gap-analysis")));

    for (const cr of ["CR-NEW-APPEND", "CR-NEW-RENAME", "CR-NEW-SKIP", "CR-NEW-INSERT", "CR-NEW-ABORT"]) {
      handle!.store.upsertQueueEntry(key, { cr, release: RELEASE, wave: "1", title: cr });
    }

    const { status, body } = await getChanges(key, RELEASE);
    expect(status).toBe(200);
    expect(body.ok).not.toBe(false);
    expect(body.release).toBe(RELEASE);

    // POSITIVE — exact per-cause counts.
    expect(body.changes?.["spec-design"]).toBe(3); // append + skip + insert
    expect(body.changes?.["gap-analysis"]).toBe(1); // rename ONLY
    expect(body.changes?.unrecorded).toBe(1); // the legacy skip
    expect(body.aborts?.["gap-analysis"]).toBe(1); // CR-NEW-ABORT
    expect(body.aborts?.unrecorded).toBe(1); // the legacy abort

    // NEGATIVE / BOUND — nothing leaks into the wrong bucket.
    expect(body.aborts?.["spec-design"] ?? 0).toBe(0);
    expect(body.changes?.["gap-analysis"]).toBe(1); // not 2 — the abort's
    // own cascaded skip (changeKind "abort", cause gap-analysis) is NOT
    // double-counted here alongside CR-NEW-RENAME.
  });

  test("release scoping: a recorded skip filed into a DIFFERENT release never counts for the queried one, and is counted for its own; an unknown release 404s", async () => {
    boot();
    const key = "00000000-0000-7000-8165-000000000c02";
    handle!.store.addProject({ key, name: "scoping", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const plan = planned(
      handle!.store.filePlan(key, {
        cr: "CR-OTHER-RELEASE",
        cycles: [{ label: "c1", kind: "red-green" }, { label: "c2", kind: "red-green" }],
      }),
    );
    planned(
      handle!.store.transitionCycle(
        key,
        plan.planId,
        plan.cycles[0]!.id,
        "skipped",
        record("other-release", "spec-design"),
      ),
    );
    handle!.store.upsertQueueEntry(key, { cr: "CR-OTHER-RELEASE", release: "9.8.0", wave: "1", title: "x" });

    // Queried release ("9.9.0") has no members at all -> 404, same
    // precedent as handleAnalyticsBurndown's null -> 404.
    const missing = await getChanges(key, "9.9.0");
    expect(missing.status).toBe(404);

    // Its OWN release counts it.
    const own = await getChanges(key, "9.8.0");
    expect(own.status).toBe(200);
    expect(own.body.changes?.["spec-design"]).toBe(1);
    expect(own.body.changes?.["gap-analysis"] ?? 0).toBe(0);
    expect(own.body.changes?.unrecorded ?? 0).toBe(0);
  });

  test("a missing `release` query param is refused with 400, naming the parameter", async () => {
    boot();
    const key = "00000000-0000-7000-8165-000000000c03";
    handle!.store.addProject({ key, name: "no-release", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const { status, body } = await getChanges(key, undefined);
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(String(body.error ?? "")).toContain("release");
  });
});
