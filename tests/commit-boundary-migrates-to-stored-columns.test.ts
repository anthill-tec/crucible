// CR-CRU-169 §S1 — the migration chain: schema v18 -> v19.
//
// `plans` has no `boundary_branch` / `boundary_first_commit` / `boundary_last_commit`
// columns yet (SCHEMA_VERSION reads 18, MIGRATIONS has 18 steps — measured on
// this build: `bun -e "import('./src/store.ts').then(m => console.log(m.SCHEMA_VERSION,
// m.MIGRATIONS.length))"` prints `18 18`). So every assertion below fails for
// one of three reasons, never a typo:
//   - the version never moves past 18 (no step exists to run);
//   - no pre-upgrade backup is written (nothing migrated, so nothing is backed up);
//   - the raw column read throws "no such column: boundary_branch" (the row
//     simply has nowhere to hold what the test asks for).
//
// ── Safety ─────────────────────────────────────────────────────────────────
// The synthetic fixtures are mkdtemp scratch files, built through the ordinary
// `Store` door and then DOWNGRADED on disk to the pre-this-CR shape — the
// `tests/milestone-dates-migration.test.ts` / `tests/release-unification-migration
// .test.ts` idiom, so the same fixture-builder keeps testing the real migration
// once it exists rather than a shape only a pre-GREEN build can produce.
//
// The real-scale case touches `data/crucible.db` ONLY as one `copyFileSync`
// snapshot (database file + `-wal`/`-shm` siblings) into an mkdtemp directory,
// duplicated there for the before and after stores; the live file itself is
// never opened, written or migrated. When
// there is no dev store (CI, a clean checkout) the case states that and skips.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import type { ChangeRecord, CommitBoundary, Plan, RunSchema } from "../src/types.ts";

const t0 = 1_700_000_000_000;

/** The version §S1's step upgrades FROM — stated once, matching the spec text
 *  ("schema v18 -> v19") rather than derived from the chain's current length,
 *  so this file keeps naming the right rung even once MIGRATIONS grows past it. */
const PRE_BOUNDARY_VERSION = 18;

const scratchDirs: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "boundary-migrate-"));
  scratchDirs.push(dir);
  return dir;
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function siblings(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).filter((f: string) => pattern.test(f));
}

const PRE_UPGRADE_RE = /\.pre-upgrade-\d+$/;

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

/**
 * Put a store this build just wrote back to the shape a board at
 * `PRE_BOUNDARY_VERSION` really has: the three boundary columns gone, the
 * chain stamped back. A NO-OP against today's build (which writes this shape
 * already); real work only once §S1's columns exist — the
 * `milestone-dates-migration.test.ts` idiom, applied to this CR's own columns.
 */
function downgradeToPreBoundary(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    const present = columnsOf(db, "plans");
    for (const column of ["boundary_branch", "boundary_first_commit", "boundary_last_commit"]) {
      if (present.includes(column)) db.exec(`ALTER TABLE plans DROP COLUMN "${column}"`);
    }
    db.exec(`PRAGMA user_version = ${String(PRE_BOUNDARY_VERSION)};`);
  } finally {
    db.close();
  }
}

function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String(result.error)}`);
  return result as Exclude<T, { error: string }>;
}

function testRun(): RunSchema {
  return {
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 4 },
    tree: [
      { name: "suite", status: "pass", children: [{ name: "case", status: "pass", duration_ms: 4 }] },
    ],
  };
}

function recordRun(
  store: Store,
  key: string,
  at: number,
  context: { cycleId: number; git?: { branch: string; commit: string } },
): void {
  setSystemTime(at);
  store.recordTestEvent(key, "fixture-agent", testRun(), { context });
}

function filePlanWithCycles(store: Store, key: string, cr: string, labels: string[]): Plan {
  return planned(
    store.filePlan(key, { cr, cycles: labels.map((label) => ({ label, kind: "red-green" as const })) }),
  );
}

function sealCycle(store: Store, key: string, planId: number, cycleId: number): void {
  planned(store.transitionCycle(key, planId, cycleId, "active"));
  planned(store.transitionCycle(key, planId, cycleId, "done"));
}

function changeRecord(suffix: string): ChangeRecord {
  return { reason: `reason-${suffix}`, cause: "spec-design", specRef: `spec-${suffix}` };
}

interface Fixture {
  dir: string;
  dbPath: string;
  key: string;
  mergedWithGitId: number;
  mergedWithGitExpected: CommitBoundary;
  mergedNoGitId: number;
  mergedNoGitExpected: CommitBoundary;
  openPlanId: number;
  abortedPlanId: number;
  closedUnmergedId: number;
}

/**
 * Five plans in one project, covering every shape §S1's step must tell apart:
 * closed+merged WITH a git-bearing run, closed+merged WITHOUT one, open,
 * aborted, and closed WITHOUT a merge. Built through the ordinary door (so the
 * "before" boundary is captured by the SAME derivation the migration step must
 * reproduce), then downgraded to the pre-boundary-columns shape on disk.
 */
function buildFixture(): Fixture {
  const dir = tmpDir();
  const dbPath = join(dir, "crucible.db");
  const store = new Store(dbPath);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "cru169-migrate", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

  setSystemTime(t0);
  const withGit = filePlanWithCycles(store, key, "CR-MIGRATE-GIT", ["c1"]);
  const withGitCycle = withGit.cycles[0]!.id;
  recordRun(store, key, t0 + 1_000, { cycleId: withGitCycle, git: { branch: "feat/mig", commit: "aaa1111" } });
  recordRun(store, key, t0 + 2_000, { cycleId: withGitCycle, git: { branch: "feat/mig", commit: "bbb2222" } });
  setSystemTime(t0 + 3_000);
  sealCycle(store, key, withGit.planId, withGitCycle);
  setSystemTime(t0 + 4_000);
  planned(store.closePlan(key, withGit.planId, { commit: "merge-git" }));

  const noGit = filePlanWithCycles(store, key, "CR-MIGRATE-NOGIT", ["c1"]);
  const noGitCycle = noGit.cycles[0]!.id;
  recordRun(store, key, t0 + 11_000, { cycleId: noGitCycle });
  setSystemTime(t0 + 12_000);
  sealCycle(store, key, noGit.planId, noGitCycle);
  setSystemTime(t0 + 13_000);
  planned(store.closePlan(key, noGit.planId, { commit: "merge-nogit" }));

  setSystemTime(t0 + 20_000);
  const openPlan = filePlanWithCycles(store, key, "CR-MIGRATE-OPEN", ["c1"]);

  setSystemTime(t0 + 30_000);
  const abortedPlan = filePlanWithCycles(store, key, "CR-MIGRATE-ABORT", ["c1"]);
  planned(store.abortPlan(key, abortedPlan.planId, changeRecord("abort")));

  const unmerged = filePlanWithCycles(store, key, "CR-MIGRATE-UNMERGED", ["c1"]);
  const unmergedCycle = unmerged.cycles[0]!.id;
  setSystemTime(t0 + 41_000);
  sealCycle(store, key, unmerged.planId, unmergedCycle);
  setSystemTime(t0 + 42_000);
  planned(store.closePlan(key, unmerged.planId));

  // Captured from the ORDINARY read path — whatever this build's `toPlan`
  // answers today (derived now, stored after GREEN) — before the file is
  // touched any further.
  const mergedWithGitExpected = store.listPlans(key).find((p) => p.cr === "CR-MIGRATE-GIT")!.commitBoundary!;
  const mergedNoGitExpected = store.listPlans(key).find((p) => p.cr === "CR-MIGRATE-NOGIT")!.commitBoundary!;

  closeStore(store);
  downgradeToPreBoundary(dbPath);

  return {
    dir,
    dbPath,
    key,
    mergedWithGitId: withGit.planId,
    mergedWithGitExpected,
    mergedNoGitId: noGit.planId,
    mergedNoGitExpected,
    openPlanId: openPlan.planId,
    abortedPlanId: abortedPlan.planId,
    closedUnmergedId: unmerged.planId,
  };
}

interface BoundaryColumnsRow {
  boundary_branch: string | null;
  boundary_first_commit: string | null;
  boundary_last_commit: string | null;
}

function rawBoundaryRow(dbPath: string, planId: number): BoundaryColumnsRow {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<BoundaryColumnsRow, [number]>(
        `SELECT boundary_branch, boundary_first_commit, boundary_last_commit FROM plans WHERE plan_id = ?`,
      )
      .get(planId);
    if (row === null) throw new Error(`no plan row for plan_id ${String(planId)}`);
    return row;
  } finally {
    db.close();
  }
}

describe("the migration chain: schema v18 -> v19 (CR-CRU-169 §S1)", () => {
  test("a store at v18 migrates to v19: user_version advances, the Store discloses the migration, and a pre-upgrade backup is written", () => {
    const fixture = buildFixture();
    expect(userVersion(fixture.dbPath)).toBe(PRE_BOUNDARY_VERSION);

    const migrated = Store.open(fixture.dbPath);

    expect(userVersion(fixture.dbPath)).toBe(PRE_BOUNDARY_VERSION + 1);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(PRE_BOUNDARY_VERSION);
    expect(migrated.migration).not.toBeNull();
    expect(migrated.migration?.from).toBe(PRE_BOUNDARY_VERSION);
    expect(migrated.migration?.to).toBe(PRE_BOUNDARY_VERSION + 1);
    expect(siblings(fixture.dir, PRE_UPGRADE_RE).length).toBeGreaterThan(0);
  });

  test("the migration backfills a closed, merged plan whose runs carry git context: the stored boundary matches what today's derivation answered, byte for byte", () => {
    const fixture = buildFixture();
    Store.open(fixture.dbPath);

    const row = rawBoundaryRow(fixture.dbPath, fixture.mergedWithGitId);
    expect(row.boundary_branch).toBe(fixture.mergedWithGitExpected.branch ?? null);
    expect(row.boundary_first_commit).toBe(fixture.mergedWithGitExpected.firstRunCommit ?? null);
    expect(row.boundary_last_commit).toBe(fixture.mergedWithGitExpected.lastRunCommit ?? null);
    // Non-vacuity: the fixture really did produce a full boundary to backfill.
    expect(fixture.mergedWithGitExpected.branch).toBe("feat/mig");
    expect(fixture.mergedWithGitExpected.firstRunCommit).toBe("aaa1111");
    expect(fixture.mergedWithGitExpected.lastRunCommit).toBe("bbb2222");
  });

  test("the migration backfills a closed, merged plan whose runs carry NO git context: boundary_branch/first/last land NULL, matching today's derivation", () => {
    const fixture = buildFixture();
    expect(fixture.mergedNoGitExpected.branch).toBeUndefined();
    expect(fixture.mergedNoGitExpected.firstRunCommit).toBeUndefined();
    expect(fixture.mergedNoGitExpected.lastRunCommit).toBeUndefined();

    Store.open(fixture.dbPath);

    const row = rawBoundaryRow(fixture.dbPath, fixture.mergedNoGitId);
    expect(row.boundary_branch).toBeNull();
    expect(row.boundary_first_commit).toBeNull();
    expect(row.boundary_last_commit).toBeNull();
  });

  test("the migration stores NO boundary for an open plan, an aborted plan, or a plan closed without a merge", () => {
    const fixture = buildFixture();
    Store.open(fixture.dbPath);

    for (const planId of [fixture.openPlanId, fixture.abortedPlanId, fixture.closedUnmergedId]) {
      const row = rawBoundaryRow(fixture.dbPath, planId);
      expect(row.boundary_branch).toBeNull();
      expect(row.boundary_first_commit).toBeNull();
      expect(row.boundary_last_commit).toBeNull();
    }
  });

  test("a BRAND-NEW store is built AT v19 already: the boundary columns exist, no backup is written, and nothing was migrated", () => {
    const dir = tmpDir();
    const fresh = join(dir, "crucible.db");

    const store = Store.open(fresh);

    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(PRE_BOUNDARY_VERSION);
    const db = new Database(fresh, { readonly: true });
    try {
      const cols = columnsOf(db, "plans");
      expect(cols).toContain("boundary_branch");
      expect(cols).toContain("boundary_first_commit");
      expect(cols).toContain("boundary_last_commit");
    } finally {
      db.close();
    }
    expect(store.migration).toBeNull();
    expect(siblings(dir, PRE_UPGRADE_RE)).toEqual([]);
  });
});

// ── AC1 — real scale, against a copy of the dev store ──────────────────────

const LIVE_STORE = join(process.cwd(), "data", "crucible.db");

/**
 * A PLAIN FILE COPY of the live store (main file + `-wal`/`-shm` siblings, when
 * present) into `dest` — `copyFileSync`, never `sqlite3 .backup`, and the
 * original is opened by nothing here. Returns `false` (never throws) when
 * there is no live store to copy.
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

function allPlanBoundaries(store: Store): Record<string, CommitBoundary | null> {
  const out: Record<string, CommitBoundary | null> = {};
  for (const archived of [false, true]) {
    for (const project of store.listProjects(archived)) {
      for (const plan of store.listPlans(project.key)) {
        out[String(plan.planId)] = plan.commitBoundary ?? null;
      }
    }
  }
  return out;
}

/**
 * A FROZEN ORACLE of the pre-change rule: `Store.deriveCommitBoundary` in
 * `src/store.ts` as of commit 9a11ae6, the rule every plan read applied
 * before the boundary was stored. It is restated here, never imported, so the
 * baseline cannot move with the code it checks. Read through a raw
 * connection on the snapshot COPY only, for every plan of every project (the
 * plans `allPlanBoundaries` reaches through `listProjects`):
 *   - only a closed plan with a merge commit and a close time has a boundary;
 *   - its cycles in display order (`seq`, then `cycle_id`); for each of
 *     `events`, `milestones`, `gates`, then each cycle, the rows with that
 *     `cycle_id` and a non-null `context`, by `timestamp` then `rowid`;
 *   - merged by `timestamp`, ties by the id's trailing insert sequence (an id
 *     with no numeric tail ranks 0), stable otherwise;
 *   - the first `context.git` gives `branch` and `firstRunCommit`, the last
 *     gives `lastRunCommit`; a field with no git context is omitted.
 */
function referenceBoundaries(dbPath: string): Record<string, CommitBoundary | null> {
  interface PlanRowRef {
    plan_id: number;
    project_key: string;
    status: string;
    merge_commit: string | null;
    closed_at: number | null;
  }
  interface ContextRow {
    timestamp: number;
    id: string;
    context: string;
  }
  const ordinal = (id: string): number => {
    const tail = Number(id.slice(id.lastIndexOf("-") + 1));
    return Number.isFinite(tail) ? tail : 0;
  };
  const db = new Database(dbPath);
  try {
    const out: Record<string, CommitBoundary | null> = {};
    const plans = db
      .query<PlanRowRef, []>(
        `SELECT plan_id, project_key, status, merge_commit, closed_at FROM plans
          WHERE project_key IN (SELECT key FROM projects)`,
      )
      .all();
    for (const plan of plans) {
      if (plan.status !== "closed" || plan.merge_commit === null || plan.closed_at === null) {
        out[String(plan.plan_id)] = null;
        continue;
      }
      const cycleIds = db
        .query<{ cycle_id: number }, [string, number]>(
          `SELECT cycle_id FROM plan_cycles WHERE project_key = ? AND plan_id = ?
            ORDER BY seq ASC, cycle_id ASC`,
        )
        .all(plan.project_key, plan.plan_id)
        .map((cycle) => cycle.cycle_id);
      const rows: ContextRow[] = [];
      for (const table of ["events", "milestones", "gates"]) {
        for (const cycleId of cycleIds) {
          rows.push(
            ...db
              .query<ContextRow, [string, number]>(
                `SELECT timestamp, id, context FROM ${table}
                  WHERE project_key = ? AND cycle_id = ? AND context IS NOT NULL
                  ORDER BY timestamp ASC, rowid ASC`,
              )
              .all(plan.project_key, cycleId),
          );
        }
      }
      rows.sort((left, right) => left.timestamp - right.timestamp || ordinal(left.id) - ordinal(right.id));
      let branch: string | undefined;
      let firstRunCommit: string | undefined;
      let lastRunCommit: string | undefined;
      for (const row of rows) {
        const git = (JSON.parse(row.context) as { git?: { branch: string; commit: string } }).git;
        if (git === undefined) continue;
        branch ??= git.branch;
        firstRunCommit ??= git.commit;
        lastRunCommit = git.commit;
      }
      out[String(plan.plan_id)] = {
        mergeCommit: plan.merge_commit,
        ...(branch !== undefined ? { branch } : {}),
        ...(firstRunCommit !== undefined ? { firstRunCommit } : {}),
        ...(lastRunCommit !== undefined ? { lastRunCommit } : {}),
        closedAt: plan.closed_at,
      };
    }
    return out;
  } finally {
    db.close();
  }
}

describe("AC1 — a copy of the dev store, migrated, answers every plan's commitBoundary exactly as today's build does", () => {
  test("every plan's commitBoundary on a migrated copy of the dev store equals the SAME copy-of-today's-build answer, byte for byte", () => {
    if (!existsSync(LIVE_STORE)) {
      console.log(
        `[CR-CRU-169 §S1] SKIPPED: no ${LIVE_STORE} to copy — a clean checkout and CI carry no ` +
          `dev store, and its data is never committed.`,
      );
      return;
    }
    const dir = tmpDir();
    const snapshotPath = join(dir, "snapshot.db");
    const beforePath = join(dir, "before.db");
    const afterPath = join(dir, "after.db");

    // TWO INDEPENDENT DUPLICATES of one snapshot, never one read twice — reasoned out:
    //
    // `Store.open` always migrates whatever it opens up to THIS build's own
    // `SCHEMA_VERSION`, and a migration cannot be undone in place, and this
    // build READS the stored boundary rather than deriving it — so no open of
    // a store through this build can answer what today's derivation answers.
    // The `beforePath` copy is therefore never opened through `Store` at all:
    // `referenceBoundaries` reads it through a raw connection and applies the
    // pre-change derivation rule, frozen in this file. The `afterPath` copy is
    // opened the ordinary way and migrates all the way to `SCHEMA_VERSION`,
    // exercising the real chain. Comparing the two is then "the migrated
    // answer equals today's", which is what AC1 states.
    if (!copyLiveStore(snapshotPath)) {
      throw new Error(`copyFileSync of ${LIVE_STORE} failed after existsSync reported it present`);
    }
    // ONE copy of the live store, then duplicated: the live board writes while
    // suites run, so two separate copies of the live file can diverge or tear.
    // The snapshot's own `-wal`/`-shm` siblings travel with each duplicate.
    for (const dest of [beforePath, afterPath]) {
      copyFileSync(snapshotPath, dest);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${snapshotPath}${suffix}`)) copyFileSync(`${snapshotPath}${suffix}`, `${dest}${suffix}`);
      }
    }

    const beforeBoundaries = referenceBoundaries(beforePath);

    if (Object.keys(beforeBoundaries).length === 0) {
      console.log(
        `[CR-CRU-169 §S1] SKIPPED: the dev store copy holds no plans to compare — the proof's ` +
          `reach, not the proof, is what is lost here.`,
      );
      return;
    }

    const after = Store.open(afterPath);
    expect(after.schemaVersion).toBeGreaterThan(PRE_BOUNDARY_VERSION);
    const afterBoundaries = allPlanBoundaries(after);
    closeStore(after);

    expect(afterBoundaries).toEqual(beforeBoundaries);
  });
});
