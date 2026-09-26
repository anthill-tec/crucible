// GET …/queue mergeCommit column (§S9, AC13) — the release ceremony's
// landing-commit source moves from `plans --fields mergeCommit` to `queue`.
//
// Spec: the "status shows the work in flight" change doc under
// docs/changes/, §S9, AC13.
//   AC13 — on a board holding a CR with a closed plan (merge commit
//   recorded), a CR whose only plan is aborted, a CR with an open plan and a
//   queued CR with no plan, GET …/queue gives the first its merge commit as
//   `mergeCommit` and the other three `null`. A CR with two closed plans
//   gets the merge commit of the one closed later.
//
// RED (measured against current `src/store.ts` — `QueueEntry`/`listQueue`
// carry no `mergeCommit` field at all): every assertion below fails on
// `undefined`, not a mis-derived value.
//
// Harness: the plan file/close/abort idiom from tests/queue-registration.test.ts
// (`filePlan`/`closePlanWithMerge`) and tests/plans-status-filter.test.ts
// (`fileAndAbortPlan`), against a real HTTP server. Queue rows are SEEDED
// straight on the store (`seedQueue`, the same "board as history left it"
// idiom tests/queue-registration.test.ts uses) rather than through the bulk
// POST /queue route, because that route now refuses to INSERT a release-less
// cr (an existing safeguard on the bulk queue-replace route) — orthogonal
// to what GET …/queue derives, which is the
// only thing under test here.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

interface QueueEntryResponse {
  cr: string;
  wave: string | number;
  status: string;
  planId?: number;
  mergeCommit?: string | null;
  [key: string]: unknown;
}

interface QueueGetResponse {
  ok: true;
  entries: QueueEntryResponse[];
  [key: string]: unknown;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  cycles: Array<{ id: number; label: string; kind: string; status: string }>;
  [key: string]: unknown;
}

describe("GET …/queue carries mergeCommit (§S9, AC13)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru150-queue-mc-"));
    return startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`${base()}${path}`);
  }

  const ORCH = "queue-mc-orchestrator";

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    const reg = await postJson("/api/v2/agents/register", {
      projectKey: body.project.key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  /** Seeds the queue rows directly on the store — orthogonal to the bulk
   *  POST route's release-membership refusal (see file header). */
  function seedQueue(key: string, crs: string[]): void {
    handle!.store.replaceQueue(
      key,
      crs.map((cr) => ({ cr, wave: "1", dependsOn: [] })),
    );
  }

  async function filePlan(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    const res = await postJson(plansPath(key), { agentId: ORCH, cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, cycleId: body.cycles[0]!.id };
  }

  async function closeWithMerge(
    key: string,
    planId: number,
    cycleId: number,
    commit: string,
  ): Promise<void> {
    const act = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      agentId: ORCH,
      status: "active",
    });
    expect(act.status).toBe(200);
    const done = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      agentId: ORCH,
      status: "done",
    });
    expect(done.status).toBe(200);
    const close = await patchJson(plansPath(key, `/${planId}`), {
      agentId: ORCH,
      status: "closed",
      merge: { commit },
    });
    expect(close.status).toBe(200);
  }

  async function fileAndAbort(key: string, cr: string): Promise<void> {
    const { planId } = await filePlan(key, cr);
    const res = await postJson(plansPath(key, `/${planId}/abort`), {
      agentId: ORCH,
      userApproved: true,
    });
    expect(res.status).toBe(200);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getQueue(key: string): Promise<QueueGetResponse> {
    const res = await getJson(`/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    return (await res.json()) as QueueGetResponse;
  }

  function findEntry(entries: QueueEntryResponse[], cr: string): QueueEntryResponse {
    const e = entries.find((x) => x.cr === cr);
    expect(e).toBeDefined();
    return e!;
  }

  test("a closed-with-merge cr carries its plan's merge commit as mergeCommit; an aborted-only cr, an open-plan cr and a plan-less queued cr all carry mergeCommit:null", async () => {
    handle = boot();
    const key = await createProject("queue-merge-commit-ac13");

    const CLOSED = "CR-T-QMC-CLOSED";
    const ABORTED = "CR-T-QMC-ABORTED";
    const OPEN = "CR-T-QMC-OPEN";
    const QUEUED = "CR-T-QMC-QUEUED";
    seedQueue(key, [CLOSED, ABORTED, OPEN, QUEUED]);

    const { planId: closedPlanId, cycleId: closedCycleId } = await filePlan(key, CLOSED);
    await closeWithMerge(key, closedPlanId, closedCycleId, "closed1sha");

    await fileAndAbort(key, ABORTED);

    await filePlan(key, OPEN); // stays open — never activated/closed

    const { entries } = await getQueue(key);

    expect(findEntry(entries, CLOSED).mergeCommit).toBe("closed1sha");
    expect(findEntry(entries, ABORTED).mergeCommit).toBeNull();
    expect(findEntry(entries, OPEN).mergeCommit).toBeNull();
    expect(findEntry(entries, QUEUED).mergeCommit).toBeNull();
  });

  test("a cr with TWO closed plans carries the merge commit of the one closed LATER — distinct from the earlier plan's commit and from the planId its own `status` derivation links to", async () => {
    handle = boot();
    const key = await createProject("queue-merge-commit-two-closed");

    const TWO_CLOSED = "CR-T-QMC-TWOCLOSED";
    seedQueue(key, [TWO_CLOSED]);

    const first = await filePlan(key, TWO_CLOSED);
    await closeWithMerge(key, first.planId, first.cycleId, "early-sha");
    await sleep(5);
    const second = await filePlan(key, TWO_CLOSED);
    await closeWithMerge(key, second.planId, second.cycleId, "late-sha");

    const { entries } = await getQueue(key);
    const row = findEntry(entries, TWO_CLOSED);

    // The existing derived `status`/`planId` link (src/store.ts
    // `queueStatusOf`) picks the FIRST closed-with-merge plan in ascending
    // plan_id order — the EARLIER plan here. This is untouched by §S9
    // (AC14: "the first six [columns] unchanged"), so it stays a fixed point
    // that proves `mergeCommit` cannot be a mere re-read of that link.
    expect(row.planId).toBe(first.planId);
    expect(row.mergeCommit).toBe("late-sha");
  });
});
