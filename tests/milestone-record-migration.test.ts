// CR-CRU-129 §S1 — the migration that moves milestone and gate rows out of
// `events` and into the tables they should always have had.
//
// ── The seams this suite is written against (stated, so GREEN honours them) ─
//
//   // src/store.ts
//   /** One record the migration looked at, and what became of it. */
//   export interface MilestoneRecordMigrationEntry {
//     readonly id: string;                     // the event id it came from
//     readonly kind: "milestone" | "gate";
//     readonly type?: string;                  // milestone type; absent for a gate
//     readonly result: "moved" | "already-present";
//   }
//   /** A record this migration can PROVE is missing, and why it can prove it. */
//   export interface MilestoneRecordLoss {
//     readonly what: string;                   // e.g. "cr-merged"
//     readonly id: string;                     // the cr id / label that is gone
//     readonly reason: string;                 // the surviving evidence that names it
//   }
//   export interface MilestoneRecordMigrationReport {
//     readonly entries: readonly MilestoneRecordMigrationEntry[];
//     readonly tally: { moved: number; alreadyPresent: number; unrecoverable: number };
//     readonly unrecoverable: readonly MilestoneRecordLoss[];
//   }
//   export function migrateMilestoneRecords(db: Database): MilestoneRecordMigrationReport;
//
//   …plus ONE new step in the CR-CRU-071 `MIGRATIONS` chain that calls it, so
//   the move happens on an ordinary boot and the reporting function is not
//   live code sitting beside a dead step. This suite finds that step BY ITS
//   DESCRIPTION, never by index and never by the chain's length, exactly as
//   tests/gate-retirement.test.ts finds its own.
//
// 🚨 TWO TABLE NAMES ARE PINNED HERE, AND ONLY HERE: `milestones` and `gates`.
// A migration is the one place where the destination is the contract — "the
// rows moved" is unprovable without saying where to. Every OTHER §S1 test
// (tests/milestone-records-survive-retention.test.ts) is written purely
// against behaviour and would pass whatever the tables are called, so if the
// orchestrator rules different names, this file is the only one that moves.
//
// ── "NAMES what it could not recover" ──────────────────────────────────────
// The migration cannot resurrect a row that retention already deleted; the CR
// says so ("Events already evicted are gone"). What it must not do is report
// success over the survivors. The evidence it has is INSIDE the data it is
// already reading: a surviving `release` record names the CRs it shipped in
// its own `crs`, and a `cr-merged` record for each of those CRs should exist.
// A named CR with no surviving `cr-merged` record is landing evidence that was
// EVICTED — which is precisely what happened on 2026-09-13, when the four
// `cr-merged` records for CR-CRU-077/078/091/092 went in the same sweep — and
// the migration must say so by id rather than quietly finishing.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// Every store here is an mkdtempSync scratch file. The live `data/crucible.db`
// is NEVER opened, copied or migrated.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import * as storeModule from "../src/store.ts";

interface ChainStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
  satisfiedBy?(db: Database): boolean;
}

interface MigrationEntry {
  id: string;
  kind: string;
  type?: string;
  result: string;
}

interface RecordLoss {
  what: string;
  id: string;
  reason: string;
}

interface MigrationReport {
  entries: MigrationEntry[];
  tally: { moved: number; alreadyPresent: number; unrecoverable: number };
  unrecoverable: RecordLoss[];
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-129: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/** The ONE body this CR owns, found by what it DECLARES — never by index. */
function recordsStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => /CR-129|CR-CRU-129/.test(step.description ?? ""));
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-129 §S1: expected exactly ONE step in the ${chain.length}-step migration chain to ` +
        `declare the milestone/gate record move (its description must name CR-129), found ` +
        `${owned.length}. Without it, a store that already holds milestone rows in \`events\` ` +
        `never moves them and the records stay prunable on every existing board.`,
    );
  }
  return owned[0]!;
}

function migrate(db: Database): MigrationReport {
  const mod = storeModule as { migrateMilestoneRecords?: unknown };
  if (typeof mod.migrateMilestoneRecords !== "function") {
    throw new Error(
      "CR-CRU-129 §S1: src/store.ts exports no `migrateMilestoneRecords(db)` — the AC requires a " +
        "per-record result and a tally, and a chain step's `apply(db): void` can report neither.",
    );
  }
  return (mod.migrateMilestoneRecords as (db: Database) => MigrationReport)(db);
}

function stampUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    // DELETE journal mode so the stamp leaves no -wal/-shm siblings behind.
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${version};`);
  } finally {
    db.close();
  }
}

/** Store exposes no public close — reach the handle the way the store
 *  migration suites already do (tests/event-cycle-id-backfill.test.ts). */
function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

function count(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()!.n;
}

function eventsHolding(db: Database): number {
  return count(db, `SELECT COUNT(*) AS n FROM events WHERE kind IN ('milestone', 'gate')`);
}

describe("CR-CRU-129 §S1 — the migration out of `events`", () => {
  const scratchDirs: string[] = [];
  const open: Database[] = [];

  afterEach(() => {
    while (open.length > 0) open.pop()?.close();
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "cru129-migrate-"));
    scratchDirs.push(dir);
    return join(dir, "crucible.db");
  }

  function raw(dbPath: string): Database {
    const db = new Database(dbPath);
    open.push(db);
    return db;
  }

  /**
   * A store as history left it: milestone and gate rows sitting in `events`,
   * written the way a pre-129 build wrote them. Seeded with raw SQL on purpose
   * — after GREEN the record-writing methods no longer put a row there, so the
   * fixture the migration exists for would be unbuildable through the API.
   */
  function seedLegacyRows(
    dbPath: string,
    projectKey: string,
    rows: Array<{ id: string; kind: string; payload?: unknown; retiredAt?: number }>,
  ): void {
    const db = raw(dbPath);
    const insert = db.query(
      `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, payload, retired_at)
       VALUES (?, ?, ?, ?, 'unit', ?, ?, ?)`,
    );
    let stamp = 1_780_000_000_000;
    for (const row of rows) {
      insert.run(
        row.id,
        projectKey,
        "historic-orchestrator",
        row.kind,
        (stamp += 1000),
        row.payload === undefined ? null : JSON.stringify(row.payload),
        row.retiredAt ?? null,
      );
    }
    db.close();
    open.splice(open.indexOf(db), 1);
  }

  /** Create the project through the API, then close, so raw seeding can follow. */
  function seedProject(dbPath: string): string {
    const store = Store.open(dbPath);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "historic", type: "backend", sutRoot: "/tmp" });
    closeStore(store);
    return key;
  }

  const RELEASE_ROW = {
    id: "evt-legacy-release",
    kind: "milestone",
    payload: {
      type: "release",
      label: "0.1.0",
      commit: "1111111111111111111111111111111111111111",
      releasedAt: 1_780_000_000,
      crs: ["CR-FIXTURE-ALPHA", "CR-FIXTURE-BETA"],
    },
  };
  const MERGED_ROWS = ["CR-FIXTURE-ALPHA", "CR-FIXTURE-BETA"].map((cr) => ({
    id: `evt-legacy-merged-${cr}`,
    kind: "milestone",
    payload: { type: "cr-merged", label: cr, commit: `merge-${cr}` },
  }));
  const PROPOSAL_ROW = {
    id: "evt-legacy-proposal",
    kind: "milestone",
    payload: { type: "release-proposal", label: "0.2.0", targetAt: 1_788_220_800 },
  };
  const VERSIONED_GATE = {
    id: "evt-legacy-gate-versioned",
    kind: "gate",
    payload: { gate: { intent: "ship 0.2.0", outcome: "passed", steps: [] }, version: "0.2.0" },
  };
  const VERSIONLESS_GATE = {
    id: "evt-legacy-gate-versionless",
    kind: "gate",
    payload: { gate: { intent: "routine gate", outcome: "passed", steps: [] } },
    retiredAt: 1_780_000_500_000,
  };
  const TELEMETRY_ROW = { id: "evt-legacy-test", kind: "test" };

  const COMPLETE_FIXTURE = [
    RELEASE_ROW,
    ...MERGED_ROWS,
    PROPOSAL_ROW,
    VERSIONED_GATE,
    VERSIONLESS_GATE,
    TELEMETRY_ROW,
  ];
  /** Every structural row in COMPLETE_FIXTURE — the telemetry row is not one. */
  const STRUCTURAL_COUNT = COMPLETE_FIXTURE.length - 1;

  // ─────────────────────────────────────────────────────────────────────────
  test(
    "an ordinary boot of a store still holding milestone and gate rows in `events` moves every one " +
      "of them out, leaves the telemetry row where it is, and answers the release reads from the " +
      "new home",
    () => {
      const dbPath = scratch();
      const key = seedProject(dbPath);
      seedLegacyRows(dbPath, key, COMPLETE_FIXTURE);
      // Rewind to just before this CR's step so the chain runs it on open.
      stampUserVersion(dbPath, recordsStep().from);

      // Non-vacuity: the rows really are in `events` before the boot.
      const probe = raw(dbPath);
      expect(eventsHolding(probe)).toBe(STRUCTURAL_COUNT);
      probe.close();
      open.splice(open.indexOf(probe), 1);

      const store = Store.open(dbPath);
      const releases = store.listReleases(key);
      const proposals = store.listReleaseProposals(key);
      closeStore(store);

      const after = raw(dbPath);
      expect(eventsHolding(after)).toBe(0);
      // The telemetry row is untouched — this migration moves records, not
      // everything it can reach.
      expect(count(after, `SELECT COUNT(*) AS n FROM events WHERE kind = 'test'`)).toBe(1);
      expect(count(after, `SELECT COUNT(*) AS n FROM milestones`)).toBe(4);
      expect(count(after, `SELECT COUNT(*) AS n FROM gates`)).toBe(2);

      // And the reads answer from the new home, carrying what the rows carried.
      expect(releases).toHaveLength(1);
      expect(releases[0]!.label).toBe("0.1.0");
      expect(releases[0]!.crs).toEqual(["CR-FIXTURE-ALPHA", "CR-FIXTURE-BETA"]);
      expect(releases[0]!.releasedAt).toBe(1_780_000_000);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.label).toBe("0.2.0");
    },
  );

  test("the migration reports a per-record result and a tally naming every row it moved", () => {
    const dbPath = scratch();
    const key = seedProject(dbPath);
    seedLegacyRows(dbPath, key, COMPLETE_FIXTURE);

    const db = raw(dbPath);
    const report = migrate(db);

    expect(report.entries).toHaveLength(STRUCTURAL_COUNT);
    expect(report.entries.map((entry) => entry.id).sort()).toEqual(
      COMPLETE_FIXTURE.filter((row) => row.kind !== "test")
        .map((row) => row.id)
        .sort(),
    );
    // Per RECORD, not per batch: each entry says what it was and what became
    // of it, so a partially-applied move is readable rather than a bare count.
    const release = report.entries.find((entry) => entry.id === RELEASE_ROW.id)!;
    expect(release.kind).toBe("milestone");
    expect(release.type).toBe("release");
    expect(release.result).toBe("moved");
    const gate = report.entries.find((entry) => entry.id === VERSIONLESS_GATE.id)!;
    expect(gate.kind).toBe("gate");
    expect(gate.result).toBe("moved");

    expect(report.tally).toEqual({
      moved: STRUCTURAL_COUNT,
      alreadyPresent: 0,
      unrecoverable: 0,
    });
    // The telemetry row was never a candidate.
    expect(report.entries.some((entry) => entry.id === TELEMETRY_ROW.id)).toBe(false);
    expect(eventsHolding(db)).toBe(0);
  });

  test("a SECOND run writes nothing and duplicates nothing", () => {
    const dbPath = scratch();
    const key = seedProject(dbPath);
    seedLegacyRows(dbPath, key, COMPLETE_FIXTURE);

    const db = raw(dbPath);
    const first = migrate(db);
    expect(first.tally.moved).toBe(STRUCTURAL_COUNT);
    const milestonesAfterFirst = count(db, `SELECT COUNT(*) AS n FROM milestones`);
    const gatesAfterFirst = count(db, `SELECT COUNT(*) AS n FROM gates`);
    expect(milestonesAfterFirst).toBe(4);
    expect(gatesAfterFirst).toBe(2);

    const second = migrate(db);

    expect(second.tally.moved).toBe(0);
    expect(second.entries).toEqual([]);
    expect(count(db, `SELECT COUNT(*) AS n FROM milestones`)).toBe(milestonesAfterFirst);
    expect(count(db, `SELECT COUNT(*) AS n FROM gates`)).toBe(gatesAfterFirst);
    expect(eventsHolding(db)).toBe(0);
    db.close();
    open.splice(open.indexOf(db), 1);

    // And the reads still see exactly one of each, not two.
    const store = Store.open(dbPath);
    expect(store.listReleases(key)).toHaveLength(1);
    expect(store.listReleaseProposals(key)).toHaveLength(1);
    closeStore(store);
  });

  test(
    "the migration NAMES the records it cannot recover — a release naming CRs whose `cr-merged` " +
      "evidence was already evicted is reported by id, not silently counted as a success",
    () => {
      const dbPath = scratch();
      const key = seedProject(dbPath);
      // The 2026-09-13 shape: the release survived, two of the `cr-merged`
      // records it names did not.
      seedLegacyRows(dbPath, key, [
        {
          id: "evt-partial-release",
          kind: "milestone",
          payload: {
            type: "release",
            label: "0.1.0",
            commit: "2222222222222222222222222222222222222222",
            crs: ["CR-EVICTED-ONE", "CR-EVICTED-TWO", "CR-SURVIVOR"],
          },
        },
        {
          id: "evt-partial-merged-091",
          kind: "milestone",
          payload: { type: "cr-merged", label: "CR-SURVIVOR", commit: "merge-survivor" },
        },
      ]);

      const db = raw(dbPath);
      const report = migrate(db);

      // What IS here still moves — the migration is not refused by the loss.
      expect(report.tally.moved).toBe(2);
      // ... and what is NOT here is named, by id.
      expect(report.unrecoverable.map((loss) => loss.id).sort()).toEqual([
        "CR-EVICTED-ONE",
        "CR-EVICTED-TWO",
      ]);
      expect(report.tally.unrecoverable).toBe(2);
      for (const loss of report.unrecoverable) {
        expect(loss.what).toBe("cr-merged");
        // The reason cites the surviving evidence that proves the absence,
        // so a reader can tell "evicted" from "never happened".
        expect(loss.reason).toContain("0.1.0");
      }
      // The CR whose record survived is NOT reported as lost.
      expect(report.unrecoverable.map((loss) => loss.id)).not.toContain("CR-SURVIVOR");
    },
  );

  test("a store with nothing missing reports nothing unrecoverable — the naming is evidence-driven, not unconditional", () => {
    const dbPath = scratch();
    const key = seedProject(dbPath);
    seedLegacyRows(dbPath, key, COMPLETE_FIXTURE);

    const db = raw(dbPath);
    const report = migrate(db);

    expect(report.unrecoverable).toEqual([]);
    expect(report.tally.unrecoverable).toBe(0);
    expect(report.tally.moved).toBe(STRUCTURAL_COUNT);
  });
});
