// CR-CRU-126 §S1b — the historical `events.cycle_id` column is backfilled.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT tests/commit-boundary-derivation.ts.
// §S1 moved the boundary derivation's membership test onto the `cycle_id`
// COLUMN. CR-CRU-094 §S1 added that column with "history left NULL" and never
// backfilled it, so on the real board 712 of 1306 context-bearing rows carry a
// `context.cycleId` and a NULL column, and 13 closed CRs lose `branch` /
// `firstRunCommit` / `lastRunCommit`. NO EXISTING TEST CAN SEE THIS: every row
// a fixture inserts goes through `insertEvent`, which binds the column
// unconditionally (`event.context?.cycleId ?? event.cycleId ?? null`), so a
// fixture literally cannot produce the defective row through the normal path.
// The subject here is therefore the MIGRATION CHAIN, not the derivation — the
// same ownership split that gives `tests/event-role-backfill.test.ts` (CR-057
// §S4's labeled backfill) its own file beside the suites that own the data it
// repairs. tests/commit-boundary-derivation.test.ts keeps its 11 derivation
// pins untouched as this CR's baseline.
//
// ── The contract these tests are written against (absent until GREEN) ───────
//
//   ONE APPENDED body on `MIGRATIONS` (user ruling 2026-09-12), whose whole
//   statement is the rule `insertEvent` already applies, applied retroactively:
//
//     UPDATE events SET cycle_id = json_extract(context, '$.cycleId')
//      WHERE cycle_id IS NULL
//
//   The body is found here BY ITS DESCRIPTION — it must name both `cycle_id`
//   and `backfill` — never by index and never by `MIGRATIONS.length - 1`, both
//   of which the next CR to append a step is free to move (the convention
//   tests/gate-retirement.test.ts and tests/roadmap-registration-store.test.ts
//   already follow). Until that body exists every test below fails on
//   `backfillStep()`, which is the honest RED reason: the chain never repairs
//   history.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// Every store is an mkdtempSync scratch file; the live data/crucible.db is
// NEVER opened, and no server is booted (unit tier by scripts/test-targets.ts:
// no browser, no process, no listener, no waiting).
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import type { Plan, RunSchema } from "../src/types.ts";

const t0 = 1_700_000_000_000;

const scratchDirs: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru126-backfill-"));
  scratchDirs.push(dir);
  return join(dir, "crucible.db");
}

/** One CR-CRU-071 chain body, as much of it as this file reads. */
interface ChainStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-126 §S1b: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/**
 * The ONE body this CR owns, found by what it declares. A description naming
 * both `cycle_id` and `backfill` is the contract — the CR-094 body names
 * `cycle_id` without backfilling, and the CR-057/CR-024 bodies backfill other
 * columns, so neither is matched.
 */
function backfillStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => {
    const description = step.description ?? "";
    return /cycle_id/i.test(description) && /backfill/i.test(description);
  });
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-126 §S1b: expected exactly ONE cycle_id backfill body in the ${chain.length}-step ` +
        `migration chain (its description must name both "cycle_id" and "backfill"), found ` +
        `${owned.length} — the 712 historical rows whose cycle_id column is NULL are never ` +
        `repaired, so §S1's column filter silently drops their plans' branch and run commits`,
    );
  }
  return owned[0] as ChainStep;
}

/** Rewind a store to just before the backfill body, so the chain re-runs it. */
function rewindToPreBackfill(dbPath: string): void {
  const version = backfillStep().from;
  const db = new Database(dbPath);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

interface RawEventRow {
  id: string;
  cycle_id: number | string | null;
  context: string | null;
}

/** Every event row, straight from the file, in a stable order. */
function rawEvents(dbPath: string): RawEventRow[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<RawEventRow, []>(`SELECT id, cycle_id, context FROM events ORDER BY id ASC`)
      .all();
  } finally {
    db.close();
  }
}

function rowById(rows: RawEventRow[], id: string): RawEventRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no event row ${id}`);
  return row;
}

function countEvents(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events`).get()!.n;
  } finally {
    db.close();
  }
}

/**
 * The defect, counted: rows whose `context` carries an INTEGER `cycleId` while
 * the column is still NULL. This is the number the migration must drive to
 * zero, and the number that proves a fixture is not vacuous.
 */
function rowsOwedABackfill(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM events
          WHERE context IS NOT NULL
            AND typeof(json_extract(context, '$.cycleId')) = 'integer'
            AND cycle_id IS NULL`,
      )
      .get()!.n;
  } finally {
    db.close();
  }
}

/** NULL the whole column, exactly as CR-CRU-094's "history left NULL" did. */
function nullOutCycleIdColumn(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`UPDATE events SET cycle_id = NULL`);
  } finally {
    db.close();
  }
}

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

// ── the derivation fixture (AC1) ────────────────────────────────────────────

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

function planOf(store: Store, key: string, cr: string): Plan {
  const plan = store.listPlans(key).find((candidate) => candidate.cr === cr);
  if (plan === undefined) throw new Error(`no plan for ${cr}`);
  return plan;
}

/**
 * A scratch FILE store holding one closed-and-merged plan whose two linked runs
 * carry git context — the shape `deriveCommitBoundary` answers in full. Returns
 * the project key and the boundary as the store reports it with the column
 * correctly populated: the reference every NULL-column assertion is measured
 * against.
 */
function seedClosedMergedPlan(dbPath: string): { key: string; cr: string } {
  const store = Store.open(dbPath);
  try {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "backfill", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    const cr = "CR-BACKFILL-1";
    setSystemTime(t0);
    const plan = planned(
      store.filePlan(key, { cr, cycles: [{ label: "c1", kind: "red-green" as const }] }),
    );
    const cycleId = plan.cycles[0]!.id;

    setSystemTime(t0 + 1_000);
    store.recordTestEvent(key, "fixture-agent", testRun(), {
      context: { cycleId, git: { branch: "feature/CR-CRU-096", commit: "d2b0e82" } },
    });
    setSystemTime(t0 + 2_000);
    store.recordTestEvent(key, "fixture-agent", testRun(), {
      context: { cycleId, git: { branch: "feature/CR-CRU-096", commit: "61d118f" } },
    });

    setSystemTime(t0 + 3_000);
    planned(store.transitionCycle(key, plan.planId, cycleId, "active"));
    planned(store.transitionCycle(key, plan.planId, cycleId, "done"));
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "abc1234" }));

    return { key, cr };
  } finally {
    closeStore(store);
  }
}

// ── the history fixture (AC2-AC5) ───────────────────────────────────────────

interface SeedRow {
  id: string;
  context: string | null;
  cycleId: number | null;
}

/**
 * Rows written with a RAW INSERT, which is the only way to produce the row this
 * CR is about: `insertEvent` binds `cycle_id` from `context.cycleId`
 * unconditionally, so no fixture routed through the store can leave the column
 * NULL while the blob carries a binding.
 */
const HISTORY: SeedRow[] = [
  {
    id: "evt-history-linked-a",
    context: JSON.stringify({
      cycleId: 41,
      git: { branch: "feature/CR-CRU-096", commit: "d2b0e82" },
    }),
    cycleId: null,
  },
  {
    id: "evt-history-linked-b",
    context: JSON.stringify({
      cycleId: 41,
      git: { branch: "feature/CR-CRU-096", commit: "61d118f" },
    }),
    cycleId: null,
  },
  { id: "evt-history-linked-other-cycle", context: JSON.stringify({ cycleId: 7 }), cycleId: null },
  // `context` present, NO cycleId key — the backfill derives, it never invents.
  {
    id: "evt-history-no-cycle-key",
    context: JSON.stringify({ agent: "CR-OLD-1-RED", git: { branch: "main", commit: "0000000" } }),
    cycleId: null,
  },
  // No context at all (a lifecycle row): nothing to derive from, ever.
  { id: "evt-history-no-context", context: null, cycleId: null },
  // A non-numeric cycleId — representable in the blob (the column has INTEGER
  // AFFINITY, not an INTEGER constraint), so it is the one shape that can tempt
  // an implementation into CASTing and inventing a numeric binding.
  {
    id: "evt-history-odd-cycle",
    context: JSON.stringify({ cycleId: "not-a-number" }),
    cycleId: null,
  },
  // A post-CR-094 row: the column is already bound and must be left alone.
  { id: "evt-modern-declared", context: JSON.stringify({ cycleId: 99 }), cycleId: 99 },
];

/**
 * A store with the CURRENT schema (created by this build, so no structural
 * retrofit is owed) carrying the historical rows, rewound to the version just
 * before the backfill body so the next open runs it.
 */
function seedHistoryStore(dbPath: string): string {
  const key = crypto.randomUUID();
  const store = Store.open(dbPath);
  store.addProject({ key, name: "history", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
  closeStore(store);

  const db = new Database(dbPath);
  try {
    let timestamp = t0;
    for (const row of HISTORY) {
      db.query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, context, cycle_id)
         VALUES (?, ?, 'history-agent', 'test', 'unit', ?, ?, ?)`,
      ).run(row.id, key, timestamp++, row.context, row.cycleId);
    }
  } finally {
    db.close();
  }
  rewindToPreBackfill(dbPath);
  return key;
}

describe("CR-CRU-126 §S1b — a NULL cycle_id column still derives the right boundary", () => {
  test("a store whose events carry context.cycleId but a NULL cycle_id COLUMN reports the SAME commitBoundary, byte for byte, as one whose column is set", () => {
    const dbPath = scratchDbPath();
    const { key, cr } = seedClosedMergedPlan(dbPath);

    // The reference: the column is populated (insertEvent bound it), so this is
    // today's correct, fully-populated answer.
    const reference = Store.open(dbPath);
    const before = planOf(reference, key, cr).commitBoundary;
    closeStore(reference);
    expect(before).toEqual({
      mergeCommit: "abc1234",
      branch: "feature/CR-CRU-096",
      firstRunCommit: "d2b0e82",
      lastRunCommit: "61d118f",
      closedAt: t0 + 4_000,
    });

    // Now make it a pre-CR-094 store: the blob keeps every binding, the column
    // loses all of them.
    const owedBefore = rowsOwedABackfill(dbPath);
    expect(owedBefore).toBe(0);
    nullOutCycleIdColumn(dbPath);

    // NON-VACUITY, asserted before the subject: the fixture really does hold
    // rows of the defective shape, and NOT ONE row anywhere still carries a
    // bound column. Without this the test would pass against a fixture that
    // never lost a binding — which is exactly how the existing 11 derivation
    // tests stay green on a board where 13 CRs are wrong.
    const damaged = rawEvents(dbPath);
    expect(damaged.filter((row) => row.cycle_id !== null)).toEqual([]);
    expect(rowsOwedABackfill(dbPath)).toBeGreaterThanOrEqual(2);

    rewindToPreBackfill(dbPath);

    const repaired = Store.open(dbPath);
    try {
      expect(planOf(repaired, key, cr).commitBoundary).toEqual(before);
    } finally {
      closeStore(repaired);
    }
  });
});

describe("CR-CRU-126 §S1b — the backfill migration", () => {
  test("after the chain runs, zero context-bearing rows carrying an integer context.cycleId are left with a NULL cycle_id column", () => {
    const dbPath = scratchDbPath();
    seedHistoryStore(dbPath);

    // Precondition — three rows are owed a binding, so a migration that does
    // nothing cannot pass by finding nothing to do.
    expect(rowsOwedABackfill(dbPath)).toBe(3);

    Store.open(dbPath);

    expect(rowsOwedABackfill(dbPath)).toBe(0);
    // The values are DERIVED from each row's own blob, not smeared from one
    // row to the next: two rows take 41 and the third takes 7.
    const rows = rawEvents(dbPath);
    expect(rowById(rows, "evt-history-linked-a").cycle_id).toBe(41);
    expect(rowById(rows, "evt-history-linked-b").cycle_id).toBe(41);
    expect(rowById(rows, "evt-history-linked-other-cycle").cycle_id).toBe(7);
    // The blob is the source, never the casualty: nothing is moved out of it.
    expect(JSON.parse(rowById(rows, "evt-history-linked-a").context!)).toEqual({
      cycleId: 41,
      git: { branch: "feature/CR-CRU-096", commit: "d2b0e82" },
    });
  });

  test("a row whose context carries NO cycleId — and one with no context at all — is left NULL, while an already-bound row keeps the binding it had", () => {
    const dbPath = scratchDbPath();
    seedHistoryStore(dbPath);

    Store.open(dbPath);

    const rows = rawEvents(dbPath);
    expect(rowById(rows, "evt-history-no-cycle-key").cycle_id).toBeNull();
    expect(rowById(rows, "evt-history-no-context").cycle_id).toBeNull();
    // Not touched, not re-derived, not bumped: the modern row is exactly as the
    // ingest path left it.
    expect(rowById(rows, "evt-modern-declared").cycle_id).toBe(99);
  });

  test("a non-numeric context.cycleId never becomes a NUMERIC binding — a CAST would invent cycle 0 and hand that row to some other plan's boundary", () => {
    const dbPath = scratchDbPath();
    seedHistoryStore(dbPath);

    Store.open(dbPath);

    const odd = rowById(rawEvents(dbPath), "evt-history-odd-cycle");
    expect(typeof odd.cycle_id === "number").toBe(false);
    // And the unparseable row does not abort the step: its numeric neighbours
    // in the SAME store are still repaired.
    expect(rowsOwedABackfill(dbPath)).toBe(0);
  });

  test("the step is IDEMPOTENT: forcing the chain to run it a second time over already-backfilled rows changes not one column", () => {
    const dbPath = scratchDbPath();
    seedHistoryStore(dbPath);

    Store.open(dbPath);
    const first = rawEvents(dbPath);
    // Four rows hold a NUMERIC binding after the first run (41, 41, 7, 99).
    // Counted by TYPE, not by non-NULL: whether an unparseable `cycleId` lands
    // as text or stays NULL is the previous test's subject, not this one's.
    expect(first.filter((row) => typeof row.cycle_id === "number").length).toBe(4);

    // Rewind and open again — the body applies a SECOND time, now against rows
    // it already filled. A statement that re-derives unconditionally, or one
    // that widens its WHERE clause, moves a value here.
    rewindToPreBackfill(dbPath);
    Store.open(dbPath);
    expect(rawEvents(dbPath)).toEqual(first);

    // And a plain re-open (nothing owed, no step runs) is equally inert.
    Store.open(dbPath);
    expect(rawEvents(dbPath)).toEqual(first);
  });

  test("the event COUNT and the exact set of event ids are unchanged — the step is an UPDATE, never an insert, a delete or a table rebuild", () => {
    const dbPath = scratchDbPath();
    seedHistoryStore(dbPath);

    const countBefore = countEvents(dbPath);
    const idsBefore = rawEvents(dbPath).map((row) => row.id);
    expect(countBefore).toBe(HISTORY.length);

    Store.open(dbPath);

    expect(countEvents(dbPath)).toBe(countBefore);
    // The id SET, not just the tally: a CREATE-copy-DROP rebuild that keeps the
    // count while losing a row is caught here.
    expect(rawEvents(dbPath).map((row) => row.id)).toEqual(idsBefore);
  });
});
