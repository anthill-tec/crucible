// §S2 — every plan read answers byte-identically to today's, on a
// populated store this file builds itself.
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
// Every store here is a POPULATED store this file builds itself
// (tests/helpers/populated-store.ts): several projects, one archived, and
// plans of every status — merged, unmerged, aborted, open with an active,
// failed, renamed, skipped and appended cycle — written through the ordinary
// door under a pinned clock. The reference reads it through a raw connection
// before any `Store` opens it; nothing here reads the operator's dev store, so
// the answer depends on the code alone.
//
// EXCLUDED: an ACTIVE cycle's live `activeMs` — it moves with `Date.now()`,
// so neither side can be pinned against it here. It is pinned separately,
// under a fixed clock, in `tests/plan-reads-run-in-fixed-statements.test.ts`
// ("a batched plan read still checkpoints every ACTIVE cycle correctly").
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { handleV2, type V2Deps } from "../src/v2.ts";
import type { Plan, PlanCycle } from "../src/types.ts";
import { populateStore } from "./helpers/populated-store.ts";

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
 * A populated store, written through the ordinary door and closed, at a fresh
 * scratch path — the subject every case below reads.
 */
function buildPopulatedStore(): string {
  const dbPath = join(tmpDir(), "populated.db");
  const built = Store.open(dbPath);
  populateStore(built);
  closeStore(built);
  return dbPath;
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

describe("§S2 — every plan read, on a populated store, answers byte-identically to the pre-change per-plan read", () => {
  test("store.listPlans(key), for every project, equals the frozen reference built off the SAME store (GUARD)", () => {
    const dbPath = buildPopulatedStore();
    // The reference reads the file raw FIRST, before any `Store` opens it.
    const referenceByPlanId = byPlanId(referencePlans(dbPath).map(stripActiveMs));
    // Non-vacuity: the population really holds plans of every status, across
    // live and archived projects.
    expect(referenceByPlanId.size).toBeGreaterThan(20);
    const statuses = new Set([...referenceByPlanId.values()].map((plan) => plan.status));
    expect([...statuses].sort()).toEqual(["aborted", "closed", "open"]);

    const store = Store.open(dbPath);
    const projectKeys = [
      ...store.listProjects(false).map((p) => p.key),
      ...store.listProjects(true).map((p) => p.key),
    ];
    expect(store.listProjects(true).length).toBeGreaterThan(0);
    const liveByPlanId = byPlanId(projectKeys.flatMap((key) => store.listPlans(key).map(stripActiveMs)));
    closeStore(store);

    expect(sortedPlanIds([...liveByPlanId.values()])).toEqual(sortedPlanIds([...referenceByPlanId.values()]));
    for (const [planId, reference] of referenceByPlanId) {
      expect(liveByPlanId.get(planId)).toEqual(reference);
    }
  });
});

describe("§S2 — the `plans`, `status` and global (Workflow home) v2 routes answer byte-identically to the reference, on a populated store", () => {
  const deps: V2Deps = { version: "probe", healthPayload: () => ({}) };

  async function getJson(store: Store, path: string): Promise<any> {
    const req = new Request(`http://plan-read-identity${path}`);
    const res = await handleV2(store, req, new URL(req.url), deps);
    if (res === null) throw new Error(`no v2 route matched ${path}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  test("GET …/projects/<key>/plans (unfiltered) and ?status=closed both answer byte-identically to the reference, per project (GUARD)", async () => {
    const dbPath = buildPopulatedStore();
    const reference = referencePlans(dbPath).map(stripActiveMs);
    expect(reference.length).toBeGreaterThan(20);

    const store = Store.open(dbPath);
    const projectKeys = store.listProjects(false).map((p) => p.key);
    expect(projectKeys.length).toBeGreaterThan(1);

    for (const key of projectKeys) {
      const referenceForProject = reference.filter((plan) => plan.projectKey === key);
      expect(referenceForProject.length).toBeGreaterThan(0);
      const body = await getJson(store, `/api/v2/projects/${key}/plans`);
      const routePlans: Plan[] = body.plans.map(stripActiveMs);
      expect(byPlanId(routePlans)).toEqual(byPlanId(referenceForProject));

      const referenceClosed = referenceForProject.filter((plan) => plan.status === "closed");
      expect(referenceClosed.length).toBeGreaterThan(0);
      const closedBody = await getJson(store, `/api/v2/projects/${key}/plans?status=closed`);
      const routeClosed: Plan[] = closedBody.plans.map(stripActiveMs);
      expect(byPlanId(routeClosed)).toEqual(byPlanId(referenceClosed));
    }
    closeStore(store);
  });

  test("GET /api/v2/plans (the global read behind the Workflow home view) answers byte-identically to the reference, across every non-archived project (GUARD)", async () => {
    const dbPath = buildPopulatedStore();
    const reference = referencePlans(dbPath).map(stripActiveMs);

    const store = Store.open(dbPath);
    const nonArchivedKeys = new Set(store.listProjects(false).map((p) => p.key));
    const referenceGlobal = reference.filter((plan) => nonArchivedKeys.has(plan.projectKey));
    // Non-vacuity: the archived project's plans are really left out, and the
    // global read still has several projects' plans to answer.
    expect(referenceGlobal.length).toBeLessThan(reference.length);
    expect(new Set(referenceGlobal.map((plan) => plan.projectKey)).size).toBeGreaterThan(1);

    const body = await getJson(store, "/api/v2/plans");
    const routePlans: Plan[] = body.plans.map(stripActiveMs);
    closeStore(store);

    expect(byPlanId(routePlans)).toEqual(byPlanId(referenceGlobal));
  });
});
