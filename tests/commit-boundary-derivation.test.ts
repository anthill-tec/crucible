// CR-CRU-126 — a plan read scans every event, once per plan.
//
// WHY THIS FILE EXISTS BESIDE tests/plans.test.ts. That suite owns the
// commitBoundary API as served over HTTP (its "commitBoundary (closed plans)"
// describe boots the real server per test). This CR's subject is the
// DERIVATION itself — its cost and its exact output — and §S2 requires the
// timed pin to run in-process against a `:memory:` store with no server and no
// concurrent traffic, which is precisely what that suite cannot offer: a file
// naming the server boot helper is INTEGRATION by scripts/test-targets.ts's
// rule, and a timed assertion sharing a file with seven throwaway HTTP servers
// is the 2026-09-07 false latency alarm waiting to happen. So the Store-level
// contract lives here (unit: no browser, no process, no server, no waiting),
// the per-route surface lives in tests/commit-boundary-routes.test.ts, and
// plans.test.ts is left untouched — its 53 tests are this CR's baseline.
//
// The output-equality tests below are CHARACTERIZATION pins: they pass before
// the fix and must pass after it, byte for byte. That is the point — the field
// has ZERO consumers in `public/` (measured: 473 files, byte-safe scan), so
// nothing else in this repo would notice a refactor quietly changing it.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { Plan, RunSchema, SuiteNode, TestLeaf } from "../src/types.ts";

// A fixed instant, so every stamped value (closedAt, event timestamps) is an
// exact number the assertions can name rather than a shape check.
const t0 = 1_700_000_000_000;

/** The plan-cycle attention checkpoint cadence CR-CRU-023 §S3(a) promises. */
const checkpointCadence = 60_000;

/**
 * §S2's ceiling: an ABSOLUTE bound above the expected post-fix figure. HELD at
 * 50 ms after the fixture was re-sized to the board's real rows (see
 * `wideTree`/`wideRaw` below) — and the re-measurement is what justifies it.
 *
 * Measured 2026-09-12 on the blob-laden fixture (50 plans, 30,625 B/row) by
 * timing, per `/plans`-equivalent request, each query shape a fix could ship:
 *
 *   what the fix does                            | @200 ev  | @2000 ev  |
 *   ---------------------------------------------|----------|-----------|
 *   today: unbounded per-plan scan, `SELECT *`    | 192.7 ms | 1896.8 ms |
 *   indexed + cycle-filtered, but KEEPS SELECT *  |   5.1 ms |   57.6 ms |
 *   indexed + cycle-filtered, two columns (§S1)   |   1.3 ms |   13.6 ms |
 *
 * So 50 ms is not arbitrary: it falls between the only two outcomes that can
 * ship. §S1's fix clears it with ~3.7x of headroom, while a fix that adds the
 * index and the WHERE clause and still selects the wide columns FAILS it. That
 * discrimination is the entire reason the fixture carries blobs; without them
 * both shapes finish in single-digit ms and the ceiling cannot tell them apart.
 */
const ceilingMillis = 50;

/**
 * §S2's SCALING bound, which is the real subject: ten times the events must not
 * cost ten times the time. Stated as an absolute delta rather than a ratio on
 * purpose — post-fix both figures are small enough that a ratio is noise, while
 * a delta stays meaningful at every scale.
 *
 * HELD at 30 ms, for the reason the same measurement gives: against the
 * blob-laden fixture today's code moves 192.7 -> 1896.8 ms (delta 1704 ms), a
 * fix that keeps `SELECT *` moves 5.1 -> 57.6 ms (delta 52.5 ms — still FAILS,
 * so this bound catches it independently of the ceiling), and §S1's fix moves
 * 1.3 -> 13.6 ms (delta 12.3 ms, ~2.4x inside the bound). Per the CR's ruling 5
 * the CEILING widens before this delta ever does: the delta is the assertion
 * that carries the CR, and a ceiling is a smoke alarm.
 */
const scalingToleranceMillis = 30;

const scratchDirs: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru126-"));
  scratchDirs.push(dir);
  return join(dir, "crucible.db");
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  // Retention well above the fixture size: the default cap (100) would prune
  // the very events whose cost is under measurement.
  store.addProject({ key, name: "boundary", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
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

describe("commitBoundary output contract (CR-CRU-126 §S1)", () => {
  test("a closed, merged plan reports the exact merge commit, branch and earliest/latest linked-run commits", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-1", ["c1"]);
    const cycleId = plan.cycles[0]!.id;

    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "c1a2b3c" } });
    recordRun(store, key, t0 + 2_000, { cycleId, git: { branch: "feat/x", commit: "d4e5f6a" } });

    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "abc1234" }));

    // Byte-identical, key set included: an extra key, a null, or a drifted
    // commit all fail here. This is the ONLY guard on the field's shape.
    expect(planOf(store, key, "CR-BOUND-1").commitBoundary).toEqual({
      mergeCommit: "abc1234",
      branch: "feat/x",
      firstRunCommit: "c1a2b3c",
      lastRunCommit: "d4e5f6a",
      closedAt: t0 + 4_000,
    });
  });

  test("an OPEN plan reports no commitBoundary key at all — absent, not null", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-OPEN", ["c1"]);
    recordRun(store, key, t0 + 1_000, {
      cycleId: plan.cycles[0]!.id,
      git: { branch: "feat/x", commit: "c1a2b3c" },
    });

    const read = planOf(store, key, "CR-BOUND-OPEN");
    expect(read.status).toBe("open");
    expect("commitBoundary" in read).toBe(false);
  });

  test("a closed plan with NO merge commit reports no commitBoundary key at all — absent, not partially populated", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-NOMERGE", ["c1"]);
    const cycleId = plan.cycles[0]!.id;
    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "c1a2b3c" } });
    setSystemTime(t0 + 2_000);
    sealCycle(store, key, plan.planId, cycleId);
    planned(store.closePlan(key, plan.planId));

    const read = planOf(store, key, "CR-BOUND-NOMERGE");
    expect(read.status).toBe("closed");
    expect("commitBoundary" in read).toBe(false);
  });

  test("a closed merged plan whose linked runs carry no context.git reports mergeCommit and closedAt ONLY", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-NOGIT", ["c1"]);
    const cycleId = plan.cycles[0]!.id;
    // Linked runs exist — they simply carry no git context.
    recordRun(store, key, t0 + 1_000, { cycleId });
    recordRun(store, key, t0 + 2_000, { cycleId });
    setSystemTime(t0 + 3_000);
    sealCycle(store, key, plan.planId, cycleId);
    setSystemTime(t0 + 4_000);
    planned(store.closePlan(key, plan.planId, { commit: "def5678" }));

    expect(planOf(store, key, "CR-BOUND-NOGIT").commitBoundary).toEqual({
      mergeCommit: "def5678",
      closedAt: t0 + 4_000,
    });
  });

  test("a plan whose runs span several cycles reports the EARLIEST and LATEST commit across all of them, in timestamp order", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-MULTI", ["c1", "c2"]);
    const first = plan.cycles[0]!.id;
    const second = plan.cycles[1]!.id;

    // Interleaved in TIME across the two cycles, so a per-cycle walk (rather
    // than a timestamp-ordered one) would answer "ccc3333" as the latest.
    recordRun(store, key, t0 + 1_000, { cycleId: first, git: { branch: "feat/m", commit: "aaa1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId: second, git: { branch: "feat/m", commit: "bbb2222" } });
    recordRun(store, key, t0 + 3_000, { cycleId: first, git: { branch: "feat/m", commit: "ccc3333" } });
    recordRun(store, key, t0 + 4_000, { cycleId: second, git: { branch: "feat/m", commit: "ddd4444" } });

    setSystemTime(t0 + 5_000);
    sealCycle(store, key, plan.planId, first);
    sealCycle(store, key, plan.planId, second);
    setSystemTime(t0 + 6_000);
    planned(store.closePlan(key, plan.planId, { commit: "merge99" }));

    expect(planOf(store, key, "CR-BOUND-MULTI").commitBoundary).toEqual({
      mergeCommit: "merge99",
      branch: "feat/m",
      firstRunCommit: "aaa1111",
      lastRunCommit: "ddd4444",
      closedAt: t0 + 6_000,
    });
  });

  test("runs linked to ANOTHER plan's cycles never contribute to this plan's boundary", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    setSystemTime(t0);
    const mine = filePlanWithCycles(store, key, "CR-BOUND-MINE", ["c1"]);
    const theirs = filePlanWithCycles(store, key, "CR-BOUND-THEIRS", ["c1"]);
    const myCycle = mine.cycles[0]!.id;
    const theirCycle = theirs.cycles[0]!.id;

    // The other plan's runs BRACKET mine in time: the earliest and the latest
    // event in the project both belong to it, so a boundary that forgot the
    // cycle filter would answer with its commits and its branch.
    recordRun(store, key, t0 + 1_000, { cycleId: theirCycle, git: { branch: "feat/them", commit: "eee1111" } });
    recordRun(store, key, t0 + 2_000, { cycleId: myCycle, git: { branch: "feat/me", commit: "fff2222" } });
    recordRun(store, key, t0 + 3_000, { cycleId: myCycle, git: { branch: "feat/me", commit: "999333a" } });
    recordRun(store, key, t0 + 4_000, { cycleId: theirCycle, git: { branch: "feat/them", commit: "888444b" } });

    setSystemTime(t0 + 5_000);
    sealCycle(store, key, mine.planId, myCycle);
    setSystemTime(t0 + 6_000);
    planned(store.closePlan(key, mine.planId, { commit: "mymerge" }));

    expect(planOf(store, key, "CR-BOUND-MINE").commitBoundary).toEqual({
      mergeCommit: "mymerge",
      branch: "feat/me",
      firstRunCommit: "fff2222",
      lastRunCommit: "999333a",
      closedAt: t0 + 6_000,
    });
  });
});

interface CostFixture {
  store: Store;
  key: string;
}

/**
 * The WIDE COLUMNS `SELECT *` marshals, sized from the live board.
 *
 * DRIFT-4 measured the marshalling of `tree`/`coverage`/`compile`/`payload` —
 * not the row COUNT — as the dominant cost: 37.0 MB per scan, ~3.87 GB per
 * `/plans` request, to produce a 104.6 KB response. `deriveCommitBoundary`
 * reads every column of every row and parses only `context`, so the blobs are
 * pure waste that the row count alone cannot express. A fixture of small events
 * therefore lets a fix that adds the index and the WHERE clause but KEEPS
 * `SELECT *` pass this pin while production stays slow — which is exactly the
 * hole these blobs close (§S2, ruled 2026-09-12 on RED escalation 4).
 *
 * The sizes are NOT invented. Read from a read-only `.backup` replica of
 * `data/crucible.db` on 2026-09-12, over its 1301 context-bearing events:
 *
 *   column   | rows carrying it | mean bytes | total
 *   ---------|------------------|------------|----------
 *   tree     | 1216 (93.5%)     |     23,016 |  27.99 MB
 *   payload  | 1188 (91.3%)     |      9,888 |  11.75 MB
 *   coverage |   12  (0.9%)     |        109 |   1.3 KB
 *   context  | 1301  (100%)     |         30 |  39.4 KB
 *   ALL WIDE | —                |     30,600 |  39.79 MB
 *
 * The shares and sizes below reproduce that shape rather than a flat average:
 * the built fixture measures 30,625 B per row against the board's 30,600, and
 * 61.3 MB across 2000 events. `coverage` is deliberately TINY because the
 * board's is — `Coverage` is three fixed axes, so it cannot be large — and the
 * bulk lives in `tree` and in `payload`, where captured `raw` output rides.
 */
const wideTree: SuiteNode[] = Array.from({ length: 8 }, (_unused, suite) => ({
  name: `suite ${suite} — store/commit boundary`,
  status: "pass" as const,
  // 27 cases x 8 suites lands the serialised column on 22,961 B, against the
  // board's 23,016 B mean tree.
  children: Array.from({ length: 27 }, (_leaf, index): TestLeaf => ({
    name: `case ${suite}.${index} — resolves the recorded boundary for a closed plan`,
    status: "pass",
    duration_ms: 4,
  })),
}));

/**
 * ~9.9 KB of captured runner output. This rides the `payload` column (CR-CRU-038
 * §S2b threads `raw` into the generic payload blob), landing it on 9,866 B
 * against the board's 9,888 B mean.
 */
const wideRaw = "[bun test] tests/store.test.ts: ok — derivation path exercised\n".repeat(154);

/**
 * One fixture event, carrying the wide columns on the board's share of rows.
 * Keyed off the row index rather than randomised, so the fixture — and every
 * timing taken against it — is deterministic.
 */
function costRun(index: number): RunSchema {
  return {
    summary: { total: 216, passed: 216, failed: 0, pending: 0, duration_ms: 12 },
    // 15 rows in 16 carry a tree (board: 93.5%).
    tree: index % 16 === 0 ? [] : wideTree,
    // 1 row in 100 carries coverage (board: 0.9%). `recordTestEvent` DISCARDS
    // coverage from a failing run (§S4), so the summary above must stay at
    // failed: 0 or this column would never reach the table at all.
    ...(index % 100 === 0
      ? { coverage: { lines: { total: 216, covered: 194, percent: 89.8 } } }
      : {}),
    // 11 rows in 12 carry raw output -> the `payload` column (board: 91.3%).
    ...(index % 12 === 0 ? {} : { raw: wideRaw }),
  };
}

/**
 * §S2's fixture: `planCount` plans that are CLOSED-WITH-MERGE and `eventCount`
 * context-bearing events spread across their cycles, each row carrying the
 * board-shaped wide columns above.
 *
 * The plans MUST end closed-with-merge (§S2, DRIFT-7): `deriveCommitBoundary`
 * returns immediately unless status is `closed`, `merge` is present and
 * `closedAt` is present, so a fixture of OPEN plans times ZERO derivations and
 * would pass on today's code — a born-vacuous pin.
 *
 * Measured on this fixture 2026-09-12, closed: 192.7 ms at 200 events and
 * 1896.8 ms at 2000. That 1.9 s is the point of the blobs — it is the same
 * order as the 2567.9 ms the live `/plans` actually costs, where the previous
 * small-event fixture reported 133 ms and so under-stated the defect ~14x.
 */
function closedMergedFixture(planCount: number, eventCount: number, withQueue = false): CostFixture {
  const store = new Store(":memory:");
  const key = seedProject(store);
  const cycles: Array<{ planId: number; cycleId: number; cr: string }> = [];
  for (let index = 0; index < planCount; index += 1) {
    const cr = `CR-COST-${index}`;
    const plan = filePlanWithCycles(store, key, cr, ["c1"]);
    cycles.push({ planId: plan.planId, cycleId: plan.cycles[0]!.id, cr });
  }
  for (let index = 0; index < eventCount; index += 1) {
    const target = cycles[index % cycles.length]!;
    store.recordTestEvent(key, "fixture-agent", costRun(index), {
      context: { cycleId: target.cycleId, git: { branch: "feat/x", commit: `c${index}` } },
    });
  }
  for (const cycle of cycles) {
    sealCycle(store, key, cycle.planId, cycle.cycleId);
    planned(store.closePlan(key, cycle.planId, { commit: `merge${cycle.planId}` }));
  }
  if (withQueue) {
    store.replaceQueue(
      key,
      cycles.map((cycle, index) => ({ cr: cycle.cr, wave: "6", dependsOn: [], seq: 6_001 + index })),
    );
  }
  return { store, key };
}

/** Median of three timed samples, after one warm-up call. */
function medianElapsed(work: () => void): number {
  work();
  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  return samples.sort((left, right) => left - right)[1]!;
}

/** How many of a project's plans actually carry a derived boundary. */
function derivedCount(fixture: CostFixture): number {
  return fixture.store
    .listPlans(fixture.key)
    .filter((plan) => plan.commitBoundary !== undefined).length;
}

describe("the derivation's cost (CR-CRU-126 §S2 — in-process, :memory:, no server, no concurrent traffic)", () => {
  test("listPlans over 50 closed-and-merged plans costs no more against 2000 context-bearing events than against 200", () => {
    const atM = closedMergedFixture(50, 200);
    const atTenM = closedMergedFixture(50, 2_000);

    // NON-VACUITY, asserted rather than assumed: all 50 plans really are
    // closed-with-merge, so 50 derivations fire on every read below.
    expect(derivedCount(atM)).toBe(50);
    expect(derivedCount(atTenM)).toBe(50);

    const small = medianElapsed(() => {
      atM.store.listPlans(atM.key);
    });
    const large = medianElapsed(() => {
      atTenM.store.listPlans(atTenM.key);
    });

    expect(large).toBeLessThanOrEqual(small + scalingToleranceMillis);
    // Generous, because it is a HANG guard and not a measurement: the blobs put
    // the pre-fix run at ~1.9 s per read and this test takes four of them at
    // each size, which overruns bun's 5 s default. A default-timeout kill would
    // report a timeout instead of the figures, hiding the very number the CR is
    // about. The assertions above are what bound the time; this only stops a
    // genuinely wedged run from hanging the suite.
  }, 120_000);

  test("listPlans over 50 closed-and-merged plans and 2000 context-bearing events completes within the ceiling", () => {
    const fixture = closedMergedFixture(50, 2_000);
    expect(derivedCount(fixture)).toBe(50);

    expect(
      medianElapsed(() => {
        fixture.store.listPlans(fixture.key);
      }),
    ).toBeLessThanOrEqual(ceilingMillis);
  }, 120_000);

  test("the queue read costs no more against 2000 context-bearing events than against 200 — deriveQueueStatus stops paying for the boundary", () => {
    const atM = closedMergedFixture(50, 200, true);
    const atTenM = closedMergedFixture(50, 2_000, true);

    // The queue read reaches the same 50 closed plans, once per row.
    const rows = atTenM.store.listQueue(atTenM.key);
    expect(rows.length).toBe(50);
    expect(rows.every((row) => row.status === "COMPLETED")).toBe(true);

    const small = medianElapsed(() => {
      atM.store.listQueue(atM.key);
    });
    const large = medianElapsed(() => {
      atTenM.store.listQueue(atTenM.key);
    });

    expect(large).toBeLessThanOrEqual(small + scalingToleranceMillis);
    expect(large).toBeLessThanOrEqual(ceilingMillis);
  }, 120_000);
});

describe("the boundary lookup is one INDEXED query (CR-CRU-126 §S1)", () => {
  test("events carries a (project_key, cycle_id) index and a cycle-scoped lookup plans to it", () => {
    const dbPath = scratchDbPath();
    const store = new Store(dbPath);
    const key = seedProject(store);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-INDEX", ["c1"]);
    const cycleId = plan.cycles[0]!.id;
    recordRun(store, key, t0 + 1_000, { cycleId, git: { branch: "feat/x", commit: "c1a2b3c" } });
    setSystemTime();

    const side = new Database(dbPath, { readonly: true });
    try {
      const indexes = side
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`,
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("idx_events_project_cycle");

      // Reachability, not speed: the plan must NAME the index for the
      // project+cycle lookup the derivation makes. The timed pin above is what
      // proves the query is fast; both, or neither means much.
      const steps = side
        .query<{ detail: string }, [string, number]>(
          `EXPLAIN QUERY PLAN SELECT cycle_id, context FROM events
           WHERE project_key = ? AND cycle_id = ?`,
        )
        .all(key, cycleId)
        .map((row) => row.detail)
        .join(" | ");
      expect(steps).toContain("idx_events_project_cycle");
    } finally {
      side.close();
    }
  });
});

describe("§S1a — a plan read is NOT a pure read: the ACTIVE-cycle checkpoint survives this CR", () => {
  test("listPlans on an ACTIVE cycle durably checkpoints active_ms_accumulated, and a later read past the cadence advances it", () => {
    const dbPath = scratchDbPath();
    setSystemTime(t0);
    const store = new Store(dbPath);
    const key = seedProject(store);
    const plan = filePlanWithCycles(store, key, "CR-BOUND-ACTIVE", ["c1"]);
    const cycleId = plan.cycles[0]!.id;
    planned(store.transitionCycle(key, plan.planId, cycleId, "active"));

    // Read the DURABLE column through a second connection: what a crash would
    // recover, not what the read path returned.
    const side = new Database(dbPath, { readonly: true });
    const persisted = (): number | null =>
      side
        .query<{ active_ms_accumulated: number | null }, [string, number]>(
          `SELECT active_ms_accumulated FROM plan_cycles WHERE project_key = ? AND cycle_id = ?`,
        )
        .get(key, cycleId)?.active_ms_accumulated ?? null;

    try {
      expect(persisted()).toBe(0);

      // Three cadence windows into the epoch: the read path MUST fold them
      // into the durable column (CR-CRU-023 §S3(a)'s designed piggyback).
      setSystemTime(t0 + 3 * checkpointCadence);
      const firstRead = store.listPlans(key)[0]!;
      expect(firstRead.cycles[0]!.activeMs).toBe(3 * checkpointCadence);
      expect(persisted()).toBe(3 * checkpointCadence);

      // Two windows later, a SECOND read must advance it again. A memoised
      // toPlan/listPlans answers from the first read and writes nothing —
      // turning a bounded 60 s loss into the whole epoch, which is exactly
      // what §S1a prohibits this CR from doing.
      setSystemTime(t0 + 5 * checkpointCadence);
      const secondRead = store.listPlans(key)[0]!;
      expect(secondRead.cycles[0]!.activeMs).toBe(5 * checkpointCadence);
      expect(persisted()).toBe(5 * checkpointCadence);
    } finally {
      side.close();
    }
  });
});
