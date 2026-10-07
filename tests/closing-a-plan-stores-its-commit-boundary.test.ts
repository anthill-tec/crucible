// CR-CRU-169 §S1 — a closed plan's commit boundary is stored when it closes.
//
// `closePlan` (`src/store.ts`) still only writes `status`, `merge_commit` and
// `closed_at`. The boundary stays DERIVED on every read (`deriveCommitBoundary`,
// called from `toPlan`), re-scanning the events/milestones/gates tables for
// every cycle on every plan read. That is this CR's whole premise: a closed
// plan's boundary never changes, yet the code re-computes it anyway — paying
// ~1,895 statements per plan read AND silently drifting once retention evicts
// the runs the derivation depends on.
//
// This file is written BEFORE `plans` gains its three new columns
// (`boundary_branch`, `boundary_first_commit`, `boundary_last_commit`), so:
//   - the raw-column tests fail with "no such column" — the row simply does
//     not carry what they ask for yet;
//   - the "stays unchanged after close" tests fail because the read API
//     (`Store.listPlans` → `commitBoundary`) still RE-DERIVES on every read,
//     so a later run/gate/milestone — or retention evicting the earliest
//     one — visibly MOVES the answer, which these tests assert it may not.
//
// Every store here is `:memory:` or an mkdtemp scratch file; the live
// `data/crucible.db` is never opened.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { CommitBoundary, Plan, RunSchema } from "../src/types.ts";

const t0 = 1_700_000_000_000;

const scratchDirs: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru169-close-"));
  scratchDirs.push(dir);
  return join(dir, "crucible.db");
}

function seedProject(store: Store, retention?: number): string {
  const key = crypto.randomUUID();
  store.addProject({
    key,
    name: "boundary-at-close",
    type: "backend",
    sutRoot: "/tmp",
    // A huge default cap: tests that care about eviction set their own.
    retention: retention ?? 1_000_000,
  });
  return key;
}

/** Narrow the store's `Plan | PlanOpError` unions, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String(result.error)}`);
  return result as Exclude<T, { error: string }>;
}

function testRun(): RunSchema {
  return {
    summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 12 },
    tree: [
      { name: "suite", status: "pass", children: [{ name: "case", status: "pass", duration_ms: 4 }] },
    ],
  };
}

/** Record one context-bearing run event, stamped at an exact instant. */
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
    store.filePlan(key, {
      cr,
      cycles: labels.map((label) => ({ label, kind: "red-green" as const })),
    }),
  );
}

/** Drive a cycle pending -> active -> done (the only route to a closable plan). */
function sealCycle(store: Store, key: string, planId: number, cycleId: number): void {
  planned(store.transitionCycle(key, planId, cycleId, "active"));
  planned(store.transitionCycle(key, planId, cycleId, "done"));
}

function planOf(store: Store, key: string, cr: string): Plan {
  const plan = store.listPlans(key).find((candidate) => candidate.cr === cr);
  if (plan === undefined) throw new Error(`no plan for ${cr}`);
  return plan;
}

interface BoundaryColumnsRow {
  boundary_branch: string | null;
  boundary_first_commit: string | null;
  boundary_last_commit: string | null;
  merge_commit: string | null;
  closed_at: number | null;
}

/**
 * The plan row's own stored columns, read through a SECOND raw connection on
 * the file-backed store — never through the Store API, which derives rather
 * than reads. Same discipline as `commit-boundary-derivation.test.ts`'s
 * `active_ms_accumulated` checkpoint read: the durable column is what a crash
 * would recover, not what the read path happens to answer with.
 */
function rawPlanRow(dbPath: string, planId: number): BoundaryColumnsRow {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<BoundaryColumnsRow, [number]>(
        `SELECT boundary_branch, boundary_first_commit, boundary_last_commit, merge_commit, closed_at
           FROM plans WHERE plan_id = ?`,
      )
      .get(planId);
    if (row === null) throw new Error(`no plan row for plan_id ${String(planId)}`);
    return row;
  } finally {
    db.close();
  }
}

describe("closePlan stores the derived boundary ON THE ROW (CR-CRU-169 §S1)", () => {
  test("a merged plan whose linked runs carry git context stores boundary_branch/first/last ON THE ROW, byte for byte with the derived answer", () => {
    const dbPath = scratchDbPath();
    const store = new Store(dbPath);
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-STORE-1", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/close", commit: "c1a2b3c" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/close", commit: "d4e5f6a" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "abc1234" }));

    const row = rawPlanRow(dbPath, plan.planId);
    expect(row.merge_commit).toBe("abc1234");
    expect(row.closed_at).toBe(t0 + 4_000);
    expect(row.boundary_branch).toBe("feat/close");
    expect(row.boundary_first_commit).toBe("c1a2b3c");
    expect(row.boundary_last_commit).toBe("d4e5f6a");
  });

  test("a merged plan whose linked runs carry NO git context stores NULL for boundary_branch/first/last, never a derived guess", () => {
    const dbPath = scratchDbPath();
    const store = new Store(dbPath);
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-STORE-NOGIT", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    // Linked runs exist — they simply carry no git context.
    recordRun(store, key, t0 + 1_000, { cycleId });
    recordRun(store, key, t0 + 2_000, { cycleId });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "def5678" }));

    const row = rawPlanRow(dbPath, plan.planId);
    expect(row.merge_commit).toBe("def5678");
    expect(row.boundary_branch).toBeNull();
    expect(row.boundary_first_commit).toBeNull();
    expect(row.boundary_last_commit).toBeNull();
  });

  test("a plan closed WITHOUT a merge stores NULL for all three boundary columns", () => {
    const dbPath = scratchDbPath();
    const store = new Store(dbPath);
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-STORE-NOMERGE", ["c1"]);
    const cycleId = plan.cycles[0]!.id;
    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "c1a2b3c" } });
    setSystemTime(t0 + 2_000);
    sealCycle(store, key, plan.planId, cycleId);
    planned(store.closePlan(key, plan.planId));

    const row = rawPlanRow(dbPath, plan.planId);
    expect(row.merge_commit).toBeNull();
    expect(row.boundary_branch).toBeNull();
    expect(row.boundary_first_commit).toBeNull();
    expect(row.boundary_last_commit).toBeNull();
  });
});

describe("a stored boundary is a RECORD, immune to activity filed after close (CR-CRU-169 §S1 AC)", () => {
  test("a run recorded AFTER close against one of the plan's cycles does not change the read commitBoundary — today's derivation would", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-LATER-RUN", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "aaa1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/x", commit: "bbb2222" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "merge99" }));

    const expected: CommitBoundary = {
      mergeCommit: "merge99",
      branch: "feat/x",
      firstRunCommit: "aaa1111",
      lastRunCommit: "bbb2222",
      closedAt: t0 + 4_000,
    };
    // Precondition: the boundary is exactly what close saw, so the case can
    // never pass by testing nothing.
    expect(planOf(store, key, "CR-CLOSE-LATER-RUN").commitBoundary).toEqual(expected);

    // A run filed LATER, against the very cycle this plan closed. Today's
    // `deriveCommitBoundary` re-scans on every read and would pick this up as
    // the new `lastRunCommit`.
    recordRun(store, key, t0 + 5_000, { cycleId, git: { branch: "feat/x", commit: "zzz9999" } });

    expect(planOf(store, key, "CR-CLOSE-LATER-RUN").commitBoundary).toEqual(expected);
  });

  test("a gate recorded AFTER close against one of the plan's cycles does not change the read commitBoundary — today's derivation would", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-LATER-GATE", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "aaa1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/x", commit: "bbb2222" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "merge-g" }));

    const expected: CommitBoundary = {
      mergeCommit: "merge-g",
      branch: "feat/x",
      firstRunCommit: "aaa1111",
      lastRunCommit: "bbb2222",
      closedAt: t0 + 4_000,
    };
    expect(planOf(store, key, "CR-CLOSE-LATER-GATE").commitBoundary).toEqual(expected);

    setSystemTime(t0 + 5_000);
    store.recordGateEvent(
      key,
      "fixture-agent",
      { status: "pass" },
      { context: { cycleId, git: { branch: "feat/x", commit: "gate0001" } } },
    );

    expect(planOf(store, key, "CR-CLOSE-LATER-GATE").commitBoundary).toEqual(expected);
  });

  test("a milestone recorded AFTER close against one of the plan's cycles does not change the read commitBoundary — today's derivation would", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-LATER-MILESTONE", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "aaa1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/x", commit: "bbb2222" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "merge-m" }));

    const expected: CommitBoundary = {
      mergeCommit: "merge-m",
      branch: "feat/x",
      firstRunCommit: "aaa1111",
      lastRunCommit: "bbb2222",
      closedAt: t0 + 4_000,
    };
    expect(planOf(store, key, "CR-CLOSE-LATER-MILESTONE").commitBoundary).toEqual(expected);

    setSystemTime(t0 + 5_000);
    store.recordMilestoneEvent(key, "fixture-agent", "custom", {
      context: { cycleId, git: { branch: "feat/x", commit: "mile0001" } },
    });

    expect(planOf(store, key, "CR-CLOSE-LATER-MILESTONE").commitBoundary).toEqual(expected);
  });

  test("retention evicting the plan's earliest run AFTER close does not change the read commitBoundary — today's derivation loses its earliest commit", () => {
    const store = new Store(":memory:");
    // A cap of 2: the two pre-close runs exactly fill it, so a THIRD
    // (post-close) run is what tips retention into evicting the first one.
    const key = seedProject(store, 2);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-CLOSE-RETENTION", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "aaa1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/x", commit: "bbb2222" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "merge-r" }));

    const expected: CommitBoundary = {
      mergeCommit: "merge-r",
      branch: "feat/x",
      firstRunCommit: "aaa1111",
      lastRunCommit: "bbb2222",
      closedAt: t0 + 4_000,
    };
    expect(planOf(store, key, "CR-CLOSE-RETENTION").commitBoundary).toEqual(expected);

    // A third run, filed after close, pushes the project's disposable-event
    // count to 3 against a cap of 2 — retention evicts the OLDEST one
    // (`aaa1111`, the earliest run this plan's boundary pinned as first).
    recordRun(store, key, t0 + 5_000, { cycleId, git: { branch: "feat/x", commit: "ccc3333" } });

    expect(planOf(store, key, "CR-CLOSE-RETENTION").commitBoundary).toEqual(expected);
  });
});
