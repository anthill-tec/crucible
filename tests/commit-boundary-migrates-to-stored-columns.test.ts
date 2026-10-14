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
// The real-scale case is a fixture too: several projects (one archived) and
// many plans, built deterministically through the same door and downgraded the
// same way. No case here reads the live dev store: the gate measures the
// code, never the age of whatever data a board happens to hold.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION, MIGRATIONS } from "../src/store.ts";
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

/**
 * The ONE chain body this file owns, found by what it declares — never by
 * index and never by the chain's length, both of which every later step is
 * free to move (the tests/gate-retirement.test.ts pattern).
 */
function boundaryStep(): (typeof MIGRATIONS)[number] {
  const owned = MIGRATIONS.filter((step) => (step.description ?? "").includes("boundary_branch"));
  if (owned.length !== 1) {
    throw new Error(
      `expected exactly ONE commit-boundary body in the ${MIGRATIONS.length}-step migration chain, found ${owned.length}`,
    );
  }
  return owned[0]!;
}

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

    // This file's own step is the v18 -> v19 rung; the open migrates the store
    // on to the chain's end, wherever later steps put it.
    const step = boundaryStep();
    expect(step.from).toBe(PRE_BOUNDARY_VERSION);
    expect(step.to).toBe(PRE_BOUNDARY_VERSION + 1);
    expect(userVersion(fixture.dbPath)).toBe(SCHEMA_VERSION);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(PRE_BOUNDARY_VERSION);
    expect(migrated.migration).not.toBeNull();
    expect(migrated.migration?.from).toBe(PRE_BOUNDARY_VERSION);
    expect(migrated.migration?.to).toBe(SCHEMA_VERSION);
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

// ── AC1 — real scale, against a fixture this file builds ───────────────────

/** The project shapes the real-scale fixture spreads its plans across: two
 *  live projects and one that is archived once its plans are filed, so the
 *  comparison reaches plans `listProjects` answers on both sides of the flag. */
const SCALE_PROJECTS = [
  { key: "boundary-scale-alpha", archived: false },
  { key: "boundary-scale-beta", archived: false },
  { key: "boundary-scale-gamma", archived: true },
] as const;

/** Merged plans per project; each gets 1–3 cycles by its index. */
const SCALE_MERGED_PLANS = 6;

/**
 * A store at real scale, built deterministically through the ordinary door
 * and then downgraded to `PRE_BOUNDARY_VERSION` on disk: per project, merged
 * plans of one to three cycles whose runs INTERLEAVE across the cycles in
 * time; runs with and without git context; runs posted in the SAME
 * millisecond (so the insert-sequence tie-break decides first and last); git
 * context arriving on milestones and gate snapshots as well as test runs; a
 * merged plan whose only git context is on a milestone; a merged plan with no
 * runs at all; and the open, aborted and closed-unmerged plans that must keep
 * no boundary. Every clock read is pinned, so two builds hold the same rows.
 */
function buildScaleFixture(): { dir: string; dbPath: string } {
  const dir = tmpDir();
  const dbPath = join(dir, "crucible.db");
  const store = new Store(dbPath);
  let clock = t0;
  const tick = (ms: number): number => {
    clock += ms;
    setSystemTime(clock);
    return clock;
  };
  setSystemTime(clock);

  SCALE_PROJECTS.forEach(({ key }, projectIndex) => {
    store.addProject({ key, name: key, type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    const branch = `feat/scale-${String(projectIndex)}`;

    for (let planIndex = 0; planIndex < SCALE_MERGED_PLANS; planIndex++) {
      const cycleCount = 1 + (planIndex % 3);
      const labels = Array.from({ length: cycleCount }, (_, c) => `c${String(c + 1)}`);
      tick(1_000);
      const plan = filePlanWithCycles(store, key, `SCALE-${String(projectIndex)}-${String(planIndex)}`, labels);
      const cycleIds = plan.cycles.map((cycle) => cycle.id);
      const commit = (n: number): string => `p${String(projectIndex)}-${String(planIndex)}-${String(n)}`;

      if (planIndex === 4) {
        // Git context only on a milestone: test runs carry none.
        recordRun(store, key, tick(10), { cycleId: cycleIds[0]! });
        store.recordMilestoneEvent(key, "fixture-agent", "cr-merged", {
          label: `scale-${String(planIndex)}`,
          context: { cycleId: cycleIds[0]!, git: { branch, commit: commit(0) } },
        });
      } else if (planIndex !== 5) {
        // Plan 5 records nothing at all; every other merged plan interleaves
        // runs across its cycles, newest cycle first, so display order and
        // time order disagree.
        for (let round = 0; round < 3; round++) {
          for (const cycleId of [...cycleIds].reverse()) {
            const at = tick(round === 1 ? 0 : 7);
            const withGit = (round + cycleId) % 2 === 0 || planIndex === 0;
            recordRun(store, key, at, {
              cycleId,
              ...(withGit ? { git: { branch, commit: commit(round * 10 + cycleId) } } : {}),
            });
          }
        }
        tick(5);
        store.recordGateEvent(
          key,
          "fixture-agent",
          { status: "pass", run: { id: `scale-gate-${String(projectIndex)}-${String(planIndex)}` } },
          { context: { cycleId: cycleIds[cycleIds.length - 1]!, git: { branch, commit: commit(99) } } },
        );
        if (planIndex % 2 === 1) {
          // A milestone in the SAME millisecond as the gate: the tie-break
          // decides which of the two is the plan's last commit.
          store.recordMilestoneEvent(key, "fixture-agent", "cr-merged", {
            label: `scale-${String(planIndex)}`,
            context: { cycleId: cycleIds[0]!, git: { branch, commit: commit(98) } },
          });
        }
      }

      for (const cycleId of cycleIds) {
        tick(3);
        sealCycle(store, key, plan.planId, cycleId);
      }
      tick(3);
      planned(store.closePlan(key, plan.planId, { commit: `merge-${commit(0)}` }));
    }

    tick(1_000);
    filePlanWithCycles(store, key, `SCALE-${String(projectIndex)}-OPEN`, ["c1"]);
    tick(1_000);
    const aborted = filePlanWithCycles(store, key, `SCALE-${String(projectIndex)}-ABORT`, ["c1"]);
    planned(store.abortPlan(key, aborted.planId, changeRecord(`scale-abort-${String(projectIndex)}`)));
    tick(1_000);
    const unmerged = filePlanWithCycles(store, key, `SCALE-${String(projectIndex)}-UNMERGED`, ["c1"]);
    recordRun(store, key, tick(10), {
      cycleId: unmerged.cycles[0]!.id,
      git: { branch, commit: "never-merged" },
    });
    tick(3);
    sealCycle(store, key, unmerged.planId, unmerged.cycles[0]!.id);
    tick(3);
    planned(store.closePlan(key, unmerged.planId));
  });

  for (const { key, archived } of SCALE_PROJECTS) {
    if (archived) store.archiveProject(key);
  }

  closeStore(store);
  downgradeToPreBoundary(dbPath);
  return { dir, dbPath };
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
 * connection on the downgraded fixture BEFORE it is ever opened through
 * `Store`, for every plan of every project (the plans `allPlanBoundaries`
 * reaches through `listProjects`):
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
  const db = new Database(dbPath, { readonly: true });
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

describe("AC1 — a real-scale store, migrated, answers every plan's commitBoundary exactly as the pre-migration derivation does", () => {
  test("every plan's commitBoundary on a migrated real-scale fixture equals the frozen pre-migration derivation over the SAME rows, byte for byte", () => {
    const fixture = buildScaleFixture();
    expect(userVersion(fixture.dbPath)).toBe(PRE_BOUNDARY_VERSION);

    // The fixture is read through a raw connection FIRST, with the
    // pre-change rule frozen in this file — `Store.open` always migrates what
    // it opens, so no open through this build can answer what the
    // pre-migration derivation answers. Only then is it opened the ordinary
    // way and migrated all the way to `SCHEMA_VERSION`, exercising the real
    // chain.
    const beforeBoundaries = referenceBoundaries(fixture.dbPath);

    // Non-vacuity: the fixture reaches every shape the comparison must hold.
    const planCount = SCALE_PROJECTS.length * (SCALE_MERGED_PLANS + 3);
    const values = Object.values(beforeBoundaries);
    expect(values.length).toBe(planCount);
    expect(values.filter((b) => b === null).length).toBe(SCALE_PROJECTS.length * 3);
    const withGit = values.filter((b) => b?.firstRunCommit !== undefined);
    expect(withGit.length).toBe(SCALE_PROJECTS.length * (SCALE_MERGED_PLANS - 1));
    expect(withGit.some((b) => b!.firstRunCommit !== b!.lastRunCommit)).toBe(true);
    expect(values.filter((b) => b !== null && b.firstRunCommit === undefined).length).toBe(
      SCALE_PROJECTS.length,
    );

    const after = Store.open(fixture.dbPath);
    expect(after.schemaVersion).toBe(SCHEMA_VERSION);
    expect(after.migration?.from).toBe(PRE_BOUNDARY_VERSION);
    const afterBoundaries = allPlanBoundaries(after);
    closeStore(after);

    expect(afterBoundaries).toEqual(beforeBoundaries);
  });
});
