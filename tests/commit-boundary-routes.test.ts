// CR-CRU-126 §S1 — EVERY response that carries `commitBoundary` today still
// carries it after the derivation is rewritten (gap analysis DRIFT-8).
//
// The four surfaces are asserted SEPARATELY, one test each, because the failure
// this guards against is a fix that quietly narrows the API: an earlier draft of
// this CR proposed deriving the field only on a single-plan read, which would
// have removed it from the unfiltered list while every other test still passed.
// `commitBoundary` has zero consumers in `public/`, so nothing else in this repo
// would notice.
//
// The Store-level contract (exact values, absence cases, cost) lives in
// tests/commit-boundary-derivation.test.ts; this file owns the ROUTES only.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface PlanRecord {
  planId: number;
  cr: string;
  status: string;
  track?: string;
  cycles: Array<{ id: number }>;
  commitBoundary?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

/** The boundary every route below must answer for the fixture's closed plan. */
const expectedBoundary = {
  mergeCommit: "abc1234",
  branch: "feat/x",
  firstRunCommit: "c1a2b3c",
  lastRunCommit: "d4e5f6a",
  closedAt: expect.any(Number),
};

describe("commitBoundary is served on every route that carries it today (CR-CRU-126 §S1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function url(path: string): string {
    return `http://localhost:${handle!.server.port}${path}`;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(url(path), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function plansAt(path: string): Promise<PlanRecord[]> {
    const res = await fetch(url(path));
    expect(res.status).toBe(200);
    return ((await res.json()) as PlansListResponse).plans;
  }

  /**
   * A project holding ONE plan, closed with a merge commit, whose two linked
   * runs carry `context.git` — the only shape that derives a boundary at all.
   * Filed over HTTP through the real routes, so the fixture exercises the same
   * wiring the assertions read back.
   */
  async function boardWithClosedMergedPlan(cr: string, track: string): Promise<string> {
    const created = await postJson("/api/v2/projects", { name: `boundary-${crypto.randomUUID()}` });
    const key = ((await created.json()) as { project: { key: string } }).project.key;
    const registered = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: "fixture-orch",
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);

    const filed = await postJson(`/api/v2/projects/${key}/plans`, {
      cr,
      track,
      agentId: "fixture-orch",
      cycles: [{ label: "c1" }],
    });
    const plan = (await filed.json()) as { planId: number; cycles: Array<{ id: number }> };
    const cycleId = plan.cycles[0]!.id;
    await patchJson(`/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`, {
      status: "active",
      agentId: "fixture-orch",
    });

    for (const commit of ["c1a2b3c", "d4e5f6a"]) {
      const ingested = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        agentId: "fixture-orch",
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
        tree: [{ name: "s", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 5 }] }],
        context: { cycleId, git: { branch: "feat/x", commit } },
      });
      expect(ingested.status).toBe(200);
    }

    await patchJson(`/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`, {
      status: "done",
      agentId: "fixture-orch",
    });
    const closed = await patchJson(`/api/v2/projects/${key}/plans/${plan.planId}`, {
      status: "closed",
      merge: { commit: "abc1234" },
      agentId: "fixture-orch",
    });
    expect(closed.status).toBe(200);
    return key;
  }

  test("the UNFILTERED project plans list carries the full boundary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await boardWithClosedMergedPlan("CR-ROUTE-ALL", "track-1");

    const plans = await plansAt(`/api/v2/projects/${key}/plans`);
    const closed = plans.find((plan) => plan.cr === "CR-ROUTE-ALL")!;
    expect(closed.commitBoundary).toEqual(expectedBoundary);
  });

  test("the ?cr= filtered list carries the full boundary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await boardWithClosedMergedPlan("CR-ROUTE-CR", "track-1");

    const plans = await plansAt(`/api/v2/projects/${key}/plans?cr=CR-ROUTE-CR`);
    expect(plans.length).toBe(1);
    expect(plans[0]!.commitBoundary).toEqual(expectedBoundary);
  });

  test("the ?track= filtered list carries the full boundary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await boardWithClosedMergedPlan("CR-ROUTE-TRACK", "track-2");

    const plans = await plansAt(`/api/v2/projects/${key}/plans?track=track-2`);
    expect(plans.length).toBe(1);
    expect(plans[0]!.commitBoundary).toEqual(expectedBoundary);
  });

  test("the GLOBAL cross-project plans list carries the full boundary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    await boardWithClosedMergedPlan("CR-ROUTE-GLOBAL", "track-3");

    const plans = await plansAt("/api/v2/plans");
    const closed = plans.find((plan) => plan.cr === "CR-ROUTE-GLOBAL")!;
    expect(closed.commitBoundary).toEqual(expectedBoundary);
  });
});
