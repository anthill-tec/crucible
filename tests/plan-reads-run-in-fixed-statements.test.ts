// §S2 — a project's plans are read in a fixed number of statements, however
// many plans the project holds, and no plan read reaches the events,
// milestones or gates tables.
//
// `listPlans` reads the project's plan ROWS in one statement, then calls
// `toPlan` once per row; `toPlan` calls `listCycleRows`, which runs its own
// `SELECT * FROM plan_cycles WHERE project_key = ? AND plan_id = ?` — ONE
// query PER PLAN. §S1 (an earlier cycle) already moved the commit-boundary
// derivation out of the read path (a closed plan's boundary is stored on
// close and read, never re-derived), so a plan read no longer touches
// `events`, `milestones` or `gates` at all; what remains is this per-plan
// cycle query, and it is what makes a 200-plan project cost ~190 more
// statements than a 10-plan one.
//
// Every store here is an mkdtemp scratch file; `data/crucible.db` is never
// opened. Statement counting follows the same technique the CR's own gap
// analysis used (`test-reports/ga169/baseline.ts`): wrap `db.query` and count
// every `.all()`/`.get()`/`.run()`/`.values()` call it hands out.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { handleV2, type V2Deps } from "../src/v2.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-read-cost-"));
  scratchDirs.push(dir);
  return join(dir, "crucible.db");
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "plan-read-cost", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
  return key;
}

/** Narrow the store's `T | PlanOpError` unions, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) {
    throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  }
  return result as Exclude<T, { error: string }>;
}

/**
 * `crCount` CRs cycle through `totalPlans` plans total: each CR's history of
 * closed/aborted plans grows with `totalPlans`, but the number of CRs — and
 * so the number of plans left OPEN at the end — stays fixed at `crCount`
 * regardless of `totalPlans`. Every plan carries 1-3 cycles (several cycles
 * each, per the mix the dispatch calls for); every cycle but a currently-open
 * plan's trailing one is sealed `done`, so closed/aborted/open plans all
 * appear and `closePlan`'s "every cycle terminal" rule is honoured.
 *
 * The clock never advances while this runs, so no cycle is ever read past
 * the 60s checkpoint cadence: `deriveAndCheckpointActiveMs`'s conditional
 * UPDATE never fires here and so never confounds the statement count under
 * test. The ACTIVE-cycle case — where that UPDATE DOES fire — is pinned on
 * its own, under a fixed clock, in the last describe block below.
 */
function buildPlansFixture(store: Store, key: string, totalPlans: number, crCount: number): void {
  const open = new Map<string, { planId: number; lastCycleId: number }>();
  for (let i = 0; i < totalPlans; i++) {
    const cr = `CR-PLANCOUNT-${i % crCount}`;
    const prior = open.get(cr);
    if (prior !== undefined) {
      if (i % 2 === 0) {
        // `closePlan` refuses while any cycle is non-terminal — seal the
        // trailing pending cycle first.
        planned(store.transitionCycle(key, prior.planId, prior.lastCycleId, "active"));
        planned(store.transitionCycle(key, prior.planId, prior.lastCycleId, "done"));
        planned(store.closePlan(key, prior.planId, { commit: `${cr}-${i}-commit` }));
      } else {
        // `abortPlan` seals an active cycle and skips a pending one itself.
        planned(
          store.abortPlan(key, prior.planId, {
            reason: "superseded by a later refile",
            cause: "spec-design",
            specRef: `spec-${i}`,
          }),
        );
      }
      open.delete(cr);
    }
    const labels = i % 3 === 0 ? ["c1"] : i % 3 === 1 ? ["c1", "c2"] : ["c1", "c2", "c3"];
    const plan = planned(
      store.filePlan(key, {
        cr,
        cycles: labels.map((label) => ({ label, kind: "red-green" as const })),
      }),
    );
    for (const cycle of plan.cycles.slice(0, -1)) {
      planned(store.transitionCycle(key, plan.planId, cycle.id, "active"));
      planned(store.transitionCycle(key, plan.planId, cycle.id, "done"));
    }
    const last = plan.cycles[plan.cycles.length - 1]!;
    open.set(cr, { planId: plan.planId, lastCycleId: last.id });
  }
}

/** Register one queue entry per CR the fixture above files plans for. */
function registerQueueEntries(store: Store, key: string, crCount: number): void {
  for (let i = 0; i < crCount; i++) {
    const cr = `CR-PLANCOUNT-${i}`;
    store.upsertQueueEntry(key, { cr, release: "0.1.0", wave: "1", title: cr });
  }
}

/**
 * Wrap `store`'s private `db.query` for the duration of `fn`, counting every
 * prepared statement's `.all()`/`.get()`/`.run()`/`.values()` call — the same
 * technique `test-reports/ga169/baseline.ts` used to measure the CR's
 * baseline. Restores the original `query` afterward.
 */
async function countStatements(
  store: Store,
  fn: () => unknown,
): Promise<{ total: number; sqlLog: string[] }> {
  const db = (store as unknown as { db: Database }).db;
  const origQuery = db.query.bind(db);
  let total = 0;
  const sqlLog: string[] = [];
  (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
    const prepared = origQuery(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const record = () => {
      total++;
      sqlLog.push(sql.replace(/\s+/g, " ").trim());
    };
    const wrap = (method: string) => (...args: unknown[]) => {
      record();
      return prepared[method]!(...args);
    };
    return { ...prepared, all: wrap("all"), get: wrap("get"), run: wrap("run"), values: wrap("values") };
  }) as typeof db.query;
  try {
    await fn();
  } finally {
    (db as unknown as { query: typeof db.query }).query = origQuery;
  }
  return { total, sqlLog };
}

const CR_COUNT = 5;

describe("§S2 — a project's plans are read in a fixed number of statements", () => {
  test("listPlans runs the same number of statements whether the project holds 10 plans or 200", async () => {
    const smallStore = new Store(scratchDbPath());
    const smallKey = seedProject(smallStore);
    buildPlansFixture(smallStore, smallKey, 10, CR_COUNT);

    const largeStore = new Store(scratchDbPath());
    const largeKey = seedProject(largeStore);
    buildPlansFixture(largeStore, largeKey, 200, CR_COUNT);

    // Sanity: the fixtures really do differ in plan count, so an equal
    // statement count below is not a "both are tiny" accident.
    expect(smallStore.listPlans(smallKey).length).toBe(10);
    expect(largeStore.listPlans(largeKey).length).toBe(200);

    const small = await countStatements(smallStore, () => smallStore.listPlans(smallKey));
    const large = await countStatements(largeStore, () => largeStore.listPlans(largeKey));

    // Today: 1 (the plans SELECT) + one `listCycleRows` SELECT per plan, so
    // small=11 and large=201 — this is the failure this test exists to show.
    expect(large.total).toBe(small.total);
  });

  test("listPlans queries none of the events, milestones or gates tables (GUARD — already true after the commit-boundary-at-close change)", async () => {
    const store = new Store(scratchDbPath());
    const key = seedProject(store);
    buildPlansFixture(store, key, 30, CR_COUNT);

    const { sqlLog } = await countStatements(store, () => store.listPlans(key));

    const forbidden = sqlLog.filter((sql) => /\b(events|milestones|gates)\b/i.test(sql));
    expect(forbidden).toEqual([]);
  });
});

describe("§S2 — every plan-reading v2 route shares listPlans' statement count", () => {
  const deps: V2Deps = { version: "probe", healthPayload: () => ({}) };

  async function getJson(store: Store, path: string): Promise<{ status: number; body: any }> {
    const req = new Request(`http://plan-read-cost${path}`);
    const res = await handleV2(store, req, new URL(req.url), deps);
    if (res === null) throw new Error(`no v2 route matched ${path}`);
    const body = await res.json();
    return { status: res.status, body };
  }

  test("GET …/projects/<key>/plans (the `plans` read) runs the same number of statements for 10 plans as for 200", async () => {
    const smallStore = new Store(scratchDbPath());
    const smallKey = seedProject(smallStore);
    buildPlansFixture(smallStore, smallKey, 10, CR_COUNT);

    const largeStore = new Store(scratchDbPath());
    const largeKey = seedProject(largeStore);
    buildPlansFixture(largeStore, largeKey, 200, CR_COUNT);

    const small = await countStatements(smallStore, () =>
      getJson(smallStore, `/api/v2/projects/${smallKey}/plans`),
    );
    const large = await countStatements(largeStore, () =>
      getJson(largeStore, `/api/v2/projects/${largeKey}/plans`),
    );

    const smallBody = await getJson(smallStore, `/api/v2/projects/${smallKey}/plans`);
    const largeBody = await getJson(largeStore, `/api/v2/projects/${largeKey}/plans`);
    expect(smallBody.body.plans.length).toBe(10);
    expect(largeBody.body.plans.length).toBe(200);

    expect(large.total).toBe(small.total);
  });

  test("GET …/projects/<key>/plans?status=closed (the `status` read) runs the same number of statements for 10 plans as for 200, even though far more plans are closed", async () => {
    const smallStore = new Store(scratchDbPath());
    const smallKey = seedProject(smallStore);
    buildPlansFixture(smallStore, smallKey, 10, CR_COUNT);

    const largeStore = new Store(scratchDbPath());
    const largeKey = seedProject(largeStore);
    buildPlansFixture(largeStore, largeKey, 200, CR_COUNT);

    const smallBody = await getJson(smallStore, `/api/v2/projects/${smallKey}/plans?status=closed`);
    const largeBody = await getJson(largeStore, `/api/v2/projects/${largeKey}/plans?status=closed`);
    // Sanity: the filtered set genuinely scales with plan history (never 0,
    // and the large store has far more closed plans than the small one) —
    // otherwise an equal statement count below would be vacuous.
    expect(smallBody.body.plans.length).toBeGreaterThan(0);
    expect(largeBody.body.plans.length).toBeGreaterThan(smallBody.body.plans.length * 5);

    const small = await countStatements(smallStore, () =>
      getJson(smallStore, `/api/v2/projects/${smallKey}/plans?status=closed`),
    );
    const large = await countStatements(largeStore, () =>
      getJson(largeStore, `/api/v2/projects/${largeKey}/plans?status=closed`),
    );

    expect(large.total).toBe(small.total);
  });

  test("GET /api/v2/plans (the global read behind the Workflow home view) runs the same number of statements for 10 plans as for 200", async () => {
    const smallStore = new Store(scratchDbPath());
    const smallKey = seedProject(smallStore);
    buildPlansFixture(smallStore, smallKey, 10, CR_COUNT);

    const largeStore = new Store(scratchDbPath());
    const largeKey = seedProject(largeStore);
    buildPlansFixture(largeStore, largeKey, 200, CR_COUNT);

    const smallBody = await getJson(smallStore, "/api/v2/plans");
    const largeBody = await getJson(largeStore, "/api/v2/plans");
    expect(smallBody.body.plans.length).toBe(10);
    expect(largeBody.body.plans.length).toBe(200);

    const small = await countStatements(smallStore, () => getJson(smallStore, "/api/v2/plans"));
    const large = await countStatements(largeStore, () => getJson(largeStore, "/api/v2/plans"));

    expect(large.total).toBe(small.total);
  });
});

describe("§S2 guard — the roadmap/queue read's statement count tracks registered CRs, not plan history", () => {
  const deps: V2Deps = { version: "probe", healthPayload: () => ({}) };

  async function getQueue(store: Store, path: string): Promise<{ status: number; body: any }> {
    const req = new Request(`http://plan-read-cost${path}`);
    const res = await handleV2(store, req, new URL(req.url), deps);
    if (res === null) throw new Error(`no v2 route matched ${path}`);
    return { status: res.status, body: await res.json() };
  }

  // `GET …/queue` derives each entry's status from `planStatusFacts`, one
  // indexed query PER REGISTERED CR — never through `listPlans`/`toPlan`, so
  // it was never part of the N+1 §S2 fixes. This is a REGRESSION GUARD, not
  // a RED test: it already passes today, and exists to catch a future
  // "simplify the roadmap read" change that routes it back through
  // `listPlans` and reintroduces an O(plans) cost under a different name.
  test("GET …/projects/<key>/queue runs the same number of statements for 10 plans as for 200, when both register the same CRs (GUARD)", async () => {
    const smallStore = new Store(scratchDbPath());
    const smallKey = seedProject(smallStore);
    buildPlansFixture(smallStore, smallKey, 10, CR_COUNT);
    registerQueueEntries(smallStore, smallKey, CR_COUNT);

    const largeStore = new Store(scratchDbPath());
    const largeKey = seedProject(largeStore);
    buildPlansFixture(largeStore, largeKey, 200, CR_COUNT);
    registerQueueEntries(largeStore, largeKey, CR_COUNT);

    const smallBody = await getQueue(smallStore, `/api/v2/projects/${smallKey}/queue`);
    const largeBody = await getQueue(largeStore, `/api/v2/projects/${largeKey}/queue`);
    expect(smallBody.body.entries.length).toBe(CR_COUNT);
    expect(largeBody.body.entries.length).toBe(CR_COUNT);
    // Each entry's derived status still reflects the plan history behind it
    // (IN_PROGRESS: the last-filed plan per cr is always open by construction).
    expect(smallBody.body.entries.every((e: { status: string }) => e.status === "IN_PROGRESS")).toBe(true);
    expect(largeBody.body.entries.every((e: { status: string }) => e.status === "IN_PROGRESS")).toBe(true);

    const small = await countStatements(smallStore, () =>
      getQueue(smallStore, `/api/v2/projects/${smallKey}/queue`),
    );
    const large = await countStatements(largeStore, () =>
      getQueue(largeStore, `/api/v2/projects/${largeKey}/queue`),
    );

    expect(large.total).toBe(small.total);
  });
});

describe("§S2 guard — a batched plan read still checkpoints every ACTIVE cycle correctly", () => {
  const CADENCE = 60_000; // Store's ACTIVE_MS_CHECKPOINT_CADENCE_MS, restated here (frozen).
  const t0 = 1_700_000_000_000;

  // `deriveAndCheckpointActiveMs` runs once PER ACTIVE CYCLE, inside `toPlan`.
  // Batching `listCycleRows` across plans must not turn that into a single
  // cross-plan computation — each cycle's own `activatedAt` must still gate
  // its own checkpoint. This already holds today (one `toPlan` call per
  // plan, each running the same per-cycle logic); it is pinned here, across
  // SEVERAL plans read in one `listPlans` call, so a future batching change
  // cannot quietly fold several cycles' epochs together.
  test("listPlans over several plans checkpoints each ACTIVE cycle's activeMs independently, at the same cadence as a single-plan read (GUARD)", () => {
    setSystemTime(t0);
    const store = new Store(scratchDbPath());
    const key = seedProject(store);

    const staleCycles: { cycleId: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const plan = planned(
        store.filePlan(key, { cr: `CR-ACTIVEMS-${i}`, cycles: [{ label: "c1", kind: "red-green" }] }),
      );
      planned(store.transitionCycle(key, plan.planId, plan.cycles[0]!.id, "active"));
      staleCycles.push({ cycleId: plan.cycles[0]!.id });
    }

    // Three cadence windows pass, THEN a sixth plan's cycle activates — its
    // epoch has run 0 ms at read time, unlike the five stale ones.
    setSystemTime(t0 + 3 * CADENCE);
    const freshPlan = planned(
      store.filePlan(key, { cr: "CR-ACTIVEMS-fresh", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(store.transitionCycle(key, freshPlan.planId, freshPlan.cycles[0]!.id, "active"));
    const freshCycleId = freshPlan.cycles[0]!.id;

    const rawDb = (store as unknown as { db: Database }).db;
    const persisted = (cycleId: number): number | null =>
      rawDb
        .query<{ active_ms_accumulated: number | null }, [string, number]>(
          `SELECT active_ms_accumulated FROM plan_cycles WHERE project_key = ? AND cycle_id = ?`,
        )
        .get(key, cycleId)?.active_ms_accumulated ?? null;

    for (const { cycleId } of staleCycles) expect(persisted(cycleId)).toBe(0);
    expect(persisted(freshCycleId)).toBe(0);

    const plans = store.listPlans(key); // ONE batched read over all six plans.
    const activeMsByCycle = new Map<number, number | undefined>();
    for (const plan of plans) {
      for (const cycle of plan.cycles) activeMsByCycle.set(cycle.id, cycle.activeMs);
    }

    for (const { cycleId } of staleCycles) {
      expect(activeMsByCycle.get(cycleId)).toBe(3 * CADENCE);
      // The checkpoint is DURABLE: a second connection on the same file sees it.
      expect(persisted(cycleId)).toBe(3 * CADENCE);
    }
    // The fresh cycle has run 0 ms — no checkpoint write, no drift.
    expect(activeMsByCycle.get(freshCycleId)).toBe(0);
    expect(persisted(freshCycleId)).toBe(0);
  });
});
