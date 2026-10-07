// §S2 — every plan read answers byte-identically to today's, on a copy of
// the dev store.
//
// This is NOT "compare two Store instances running the same code" — that
// would be trivially identical before GREEN exists at all. The REFERENCE
// below is an INDEPENDENT raw-SQL re-implementation of `toPlan`/`listCycleRows`
// (read, never imported from `src/store.ts`, following the frozen-reference
// pattern `tests/commit-boundary-migrates-to-stored-columns.test.ts` set for
// this CR's own §S1), restated here so it cannot move with the code it
// checks. §S2 only changes HOW MANY STATEMENTS a plan read runs — never what
// it answers — so the live Store's answer must equal this reference both
// BEFORE and AFTER the batching change. Today (before GREEN) these tests are
// GUARDS: they already pass, and exist to catch GREEN quietly changing a
// byte of output while it changes the query count.
//
// Every store here is a PLAIN FILE COPY of `data/crucible.db` (+ `-wal`/
// `-shm`), copied ONCE into one scratch dir, then duplicated — the live
// board writes while suites run, so two independent copies of the live file
// could diverge or tear. SKIPPED (not failed) when no dev store exists: a
// clean checkout and CI carry no dev data.
//
// EXCLUDED: an ACTIVE cycle's live `activeMs` — it moves with `Date.now()`,
// so neither side can be pinned against it here. It is pinned separately,
// under a fixed clock, in `tests/plan-reads-run-in-fixed-statements.test.ts`
// ("a batched plan read still checkpoints every ACTIVE cycle correctly").
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { handleV2, type V2Deps } from "../src/v2.ts";
import type { Plan, PlanCycle } from "../src/types.ts";

const LIVE_STORE = join(process.cwd(), "data", "crucible.db");

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-read-identity-"));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A PLAIN FILE COPY of the live store (main file + `-wal`/`-shm` siblings
 * when present) into `dest` — `copyFileSync`, never `sqlite3 .backup`; the
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

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

/** Strip the clock-moving `activeMs` field from every cycle, both sides. */
function stripActiveMs(plan: Plan): Plan {
  return {
    ...plan,
    cycles: plan.cycles.map((cycle): PlanCycle => {
      const { activeMs: _activeMs, ...rest } = cycle;
      return rest;
    }),
  };
}

interface PlanRowRef {
  plan_id: number;
  project_key: string;
  cr: string;
  title: string | null;
  orchestrator: string | null;
  wave: string | null;
  track: string | null;
  status: string;
  merge_commit: string | null;
  closed_at: number | null;
  abort_reason: string | null;
  abort_cause: string | null;
  abort_spec_ref: string | null;
  boundary_branch: string | null;
  boundary_first_commit: string | null;
  boundary_last_commit: string | null;
}

interface CycleRowRef {
  cycle_id: number;
  label: string;
  kind: string;
  status: string;
  activated_at: number | null;
  done_at: number | null;
  change_reason: string | null;
  change_cause: string | null;
  change_spec_ref: string | null;
  change_kind: string | null;
}

/** `Store.planStatusOf` restated — `closed`/`aborted` verbatim, else `open`. */
function planStatusOf(stored: string): Plan["status"] {
  return stored === "closed" ? "closed" : stored === "aborted" ? "aborted" : "open";
}

/**
 * A FROZEN ORACLE of `toPlan`/`listCycleRows` as they read TODAY (activeMs
 * excluded, see file header): every plan of every project (archived
 * included — `listPlans` itself carries no archived gate), built straight
 * off the plan and plan_cycles rows, cycles in `seq` then `cycle_id` order.
 */
function referencePlans(dbPath: string): Plan[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const plans = db
      .query<PlanRowRef, []>(`SELECT * FROM plans ORDER BY plan_id ASC`)
      .all();
    return plans.map((row): Plan => {
      const cycleRows = db
        .query<CycleRowRef, [string, number]>(
          `SELECT cycle_id, label, kind, status, activated_at, done_at,
                  change_reason, change_cause, change_spec_ref, change_kind
             FROM plan_cycles WHERE project_key = ? AND plan_id = ?
             ORDER BY seq ASC, cycle_id ASC`,
        )
        .all(row.project_key, row.plan_id);
      const cycles: PlanCycle[] = cycleRows.map((cycle) => ({
        id: cycle.cycle_id,
        label: cycle.label,
        kind: cycle.kind as PlanCycle["kind"],
        status: cycle.status as PlanCycle["status"],
        ...(cycle.activated_at !== null ? { activatedAt: cycle.activated_at } : {}),
        ...(cycle.done_at !== null ? { doneAt: cycle.done_at } : {}),
        ...(cycle.change_reason !== null ? { reason: cycle.change_reason } : {}),
        ...(cycle.change_cause !== null ? { cause: cycle.change_cause as PlanCycle["cause"] } : {}),
        ...(cycle.change_spec_ref !== null ? { specRef: cycle.change_spec_ref } : {}),
        ...(cycle.change_kind !== null ? { changeKind: cycle.change_kind as PlanCycle["changeKind"] } : {}),
      }));
      const plan: Plan = {
        planId: row.plan_id,
        projectKey: row.project_key,
        cr: row.cr,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.orchestrator !== null ? { orchestrator: row.orchestrator } : {}),
        ...(row.wave !== null ? { wave: row.wave } : {}),
        ...(row.track !== null ? { track: row.track } : {}),
        status: planStatusOf(row.status),
        cycles,
        ...(row.merge_commit !== null ? { merge: { commit: row.merge_commit } } : {}),
        ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
        ...(typeof row.abort_reason === "string" ? { reason: row.abort_reason } : {}),
        ...(typeof row.abort_cause === "string" ? { cause: row.abort_cause as Plan["cause"] } : {}),
        ...(typeof row.abort_spec_ref === "string" ? { specRef: row.abort_spec_ref } : {}),
      };
      if (plan.status !== "closed" || plan.merge === undefined || plan.closedAt === undefined) {
        return plan;
      }
      return {
        ...plan,
        commitBoundary: {
          mergeCommit: plan.merge.commit,
          ...(typeof row.boundary_branch === "string" ? { branch: row.boundary_branch } : {}),
          ...(typeof row.boundary_first_commit === "string"
            ? { firstRunCommit: row.boundary_first_commit }
            : {}),
          ...(typeof row.boundary_last_commit === "string"
            ? { lastRunCommit: row.boundary_last_commit }
            : {}),
          closedAt: plan.closedAt,
        },
      };
    });
  } finally {
    db.close();
  }
}

function byPlanId(plans: readonly Plan[]): Map<number, Plan> {
  const out = new Map<number, Plan>();
  for (const plan of plans) out.set(plan.planId, plan);
  return out;
}

function sortedPlanIds(plans: readonly Plan[]): number[] {
  return plans.map((plan) => plan.planId).sort((a, b) => a - b);
}

describe("§S2 — every plan read, on a copy of the dev store, answers byte-identically to the pre-change per-plan read", () => {
  test("store.listPlans(key), for every project, equals the frozen reference built off the SAME copy (GUARD)", () => {
    if (!existsSync(LIVE_STORE)) {
      console.log(
        `[§S2] SKIPPED: no ${LIVE_STORE} to copy — a clean checkout and CI carry no dev store.`,
      );
      return;
    }
    const dir = tmpDir();
    const snapshotPath = join(dir, "snapshot.db");
    if (!copyLiveStore(snapshotPath)) {
      throw new Error(`copyFileSync of ${LIVE_STORE} failed after existsSync reported it present`);
    }
    // TWO INDEPENDENT DUPLICATES of the ONE snapshot: the reference reads one
    // raw, unmigrated by anything here; `Store.open` migrates the other to
    // THIS build's SCHEMA_VERSION (today's build's real chain) and answers
    // through the real `listPlans`.
    const referencePath = join(dir, "reference.db");
    const livePath = join(dir, "live.db");
    for (const dest of [referencePath, livePath]) {
      copyFileSync(snapshotPath, dest);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${snapshotPath}${suffix}`)) copyFileSync(`${snapshotPath}${suffix}`, `${dest}${suffix}`);
      }
    }

    const liveStore = Store.open(livePath);
    const projectKeys = [
      ...liveStore.listProjects(false).map((p) => p.key),
      ...liveStore.listProjects(true).map((p) => p.key),
    ];
    const liveByPlanId = byPlanId(
      projectKeys.flatMap((key) => liveStore.listPlans(key).map(stripActiveMs)),
    );
    closeStore(liveStore);

    // The reference reads the OTHER duplicate directly — never migrated by
    // anything but `referencePlans`' own raw SQL, which only ever SELECTs
    // the columns this build's schema already carries.
    const migratedForSchema = Store.open(referencePath); // run the SAME migration chain so the columns referencePlans reads exist
    closeStore(migratedForSchema);
    const referenceByPlanId = byPlanId(referencePlans(referencePath).map(stripActiveMs));

    if (referenceByPlanId.size === 0) {
      console.log(`[§S2] SKIPPED: the dev store copy holds no plans to compare.`);
      return;
    }

    expect(sortedPlanIds([...liveByPlanId.values()])).toEqual(sortedPlanIds([...referenceByPlanId.values()]));
    for (const [planId, reference] of referenceByPlanId) {
      expect(liveByPlanId.get(planId)).toEqual(reference);
    }
  });
});

describe("§S2 — the `plans`, `status` and global (Workflow home) v2 routes answer byte-identically to the reference, on a copy of the dev store", () => {
  const deps: V2Deps = { version: "probe", healthPayload: () => ({}) };

  async function getJson(store: Store, path: string): Promise<any> {
    const req = new Request(`http://plan-read-identity${path}`);
    const res = await handleV2(store, req, new URL(req.url), deps);
    if (res === null) throw new Error(`no v2 route matched ${path}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  test("GET …/projects/<key>/plans (unfiltered) and ?status=closed both answer byte-identically to the reference, per project (GUARD)", async () => {
    if (!existsSync(LIVE_STORE)) {
      console.log(`[§S2] SKIPPED: no ${LIVE_STORE} to copy.`);
      return;
    }
    const dir = tmpDir();
    const snapshotPath = join(dir, "snapshot.db");
    if (!copyLiveStore(snapshotPath)) {
      throw new Error(`copyFileSync of ${LIVE_STORE} failed after existsSync reported it present`);
    }
    const referencePath = join(dir, "reference.db");
    const livePath = join(dir, "live.db");
    for (const dest of [referencePath, livePath]) {
      copyFileSync(snapshotPath, dest);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${snapshotPath}${suffix}`)) copyFileSync(`${snapshotPath}${suffix}`, `${dest}${suffix}`);
      }
    }
    closeStore(Store.open(referencePath)); // migrate the reference's duplicate too, same reason as above.
    const reference = referencePlans(referencePath).map(stripActiveMs);
    if (reference.length === 0) {
      console.log(`[§S2] SKIPPED: the dev store copy holds no plans to compare.`);
      return;
    }

    const liveStore = Store.open(livePath);
    const projectKeys = liveStore.listProjects(false).map((p) => p.key);
    expect(projectKeys.length).toBeGreaterThan(0);

    for (const key of projectKeys) {
      const referenceForProject = reference.filter((plan) => plan.projectKey === key);
      const body = await getJson(liveStore, `/api/v2/projects/${key}/plans`);
      const routePlans: Plan[] = body.plans.map(stripActiveMs);
      expect(byPlanId(routePlans)).toEqual(byPlanId(referenceForProject));

      const referenceClosed = referenceForProject.filter((plan) => plan.status === "closed");
      const closedBody = await getJson(liveStore, `/api/v2/projects/${key}/plans?status=closed`);
      const routeClosed: Plan[] = closedBody.plans.map(stripActiveMs);
      expect(byPlanId(routeClosed)).toEqual(byPlanId(referenceClosed));
    }
    closeStore(liveStore);
  });

  test("GET /api/v2/plans (the global read behind the Workflow home view) answers byte-identically to the reference, across every non-archived project (GUARD)", async () => {
    if (!existsSync(LIVE_STORE)) {
      console.log(`[§S2] SKIPPED: no ${LIVE_STORE} to copy.`);
      return;
    }
    const dir = tmpDir();
    const snapshotPath = join(dir, "snapshot.db");
    if (!copyLiveStore(snapshotPath)) {
      throw new Error(`copyFileSync of ${LIVE_STORE} failed after existsSync reported it present`);
    }
    const referencePath = join(dir, "reference.db");
    const livePath = join(dir, "live.db");
    for (const dest of [referencePath, livePath]) {
      copyFileSync(snapshotPath, dest);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${snapshotPath}${suffix}`)) copyFileSync(`${snapshotPath}${suffix}`, `${dest}${suffix}`);
      }
    }
    closeStore(Store.open(referencePath));
    const reference = referencePlans(referencePath).map(stripActiveMs);
    if (reference.length === 0) {
      console.log(`[§S2] SKIPPED: the dev store copy holds no plans to compare.`);
      return;
    }

    const liveStore = Store.open(livePath);
    const nonArchivedKeys = new Set(liveStore.listProjects(false).map((p) => p.key));
    const referenceGlobal = reference.filter((plan) => nonArchivedKeys.has(plan.projectKey));

    const body = await getJson(liveStore, "/api/v2/plans");
    const routePlans: Plan[] = body.plans.map(stripActiveMs);
    closeStore(liveStore);

    expect(byPlanId(routePlans)).toEqual(byPlanId(referenceGlobal));
  });
});
