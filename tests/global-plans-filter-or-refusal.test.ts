// CR-CRU-165 N2/AC8 — `GET /api/v2/plans` (the unscoped, ALL-projects read,
// CR-CRU-026 §S3.2) silently IGNORES `cr=`/`status=` today and always
// returns every project's plans. The project-scoped sibling
// `GET …/projects/<key>/plans` honours both and refuses a bad `status` with
// a 400 (tests/plans-status-filter.test.ts). N2's rule: the unscoped route
// either HONOURS the filters (with the scoped route's own validation) or
// REFUSES them naming the scoped route — but it must NEVER answer a
// filtered query with the unfiltered list. That invariant is what this file
// asserts, deliberately without committing to WHICH of the two answers
// GREEN picks, so a correct implementation of either shape passes it.
//
// RED phase: src/v2.ts's handlePlansGlobalList reads no query parameters at
// all — `store.listProjects().flatMap((p) => store.listPlans(p.key))` — so
// every case below, today, returns every plan of every project regardless
// of `cr=`/`status=`, violating the "never unfiltered for a filtered query"
// invariant both cases assert.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface PlanRecord {
  planId: number | string;
  projectKey: string;
  cr: string;
  status: string;
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

describe("GET /api/v2/plans — the unscoped read never answers a filtered query with the unfiltered list (CR-CRU-165 N2/AC8)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function withFixtureAgent(body: unknown): unknown {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
      return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
    }
    return body;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function registerOrchestrator(key: string, agentId: string): Promise<void> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
    return body.project.key;
  }

  async function filePlan(key: string, cr: string): Promise<void> {
    const res = await postJson(`/api/v2/projects/${key}/plans`, { cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
  }

  /** Either GREEN's accepted answer, or proof the query wasn't silently ignored. */
  function assertNeverUnfilteredAnswer(
    res: Response,
    body: PlansListResponse | ErrResponse,
    predicate: (p: PlanRecord) => boolean,
    totalPlansOnBoard: number,
  ): void {
    if (res.status === 200) {
      const ok = body as PlansListResponse;
      // HONOURED: every row satisfies the filter — a response carrying a
      // non-matching row proves the query was ignored.
      expect(ok.plans.every(predicate)).toBe(true);
      // And it must not just HAPPEN to equal the unfiltered set in size —
      // on this fixture the matching set is strictly smaller.
      expect(ok.plans.length).toBeLessThan(totalPlansOnBoard);
    } else {
      // REFUSED: must be a definitive 400 naming the scoped route, not a
      // silent pass-through and not a crash.
      expect(res.status).toBe(400);
      const err = body as ErrResponse;
      expect(err.ok).toBe(false);
      expect(err.error.toLowerCase()).toMatch(/projects\/<key>\/plans|status|cr/);
    }
  }

  test("`?cr=<cr>` never returns the unfiltered list — either exactly that cr's plan(s), or a 400 naming the scoped route", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyA = await createProject(`global-filter-a-${crypto.randomUUID()}`);
    const keyB = await createProject(`global-filter-b-${crypto.randomUUID()}`);
    await filePlan(keyA, "CR-GLOBAL-FILTER-TARGET");
    await filePlan(keyB, "CR-GLOBAL-FILTER-OTHER");

    const res = await getJson(`/api/v2/plans?cr=${encodeURIComponent("CR-GLOBAL-FILTER-TARGET")}`);
    const body = (await res.json()) as PlansListResponse | ErrResponse;
    assertNeverUnfilteredAnswer(res, body, (p) => p.cr === "CR-GLOBAL-FILTER-TARGET", 2);
  });

  test("`?status=closed` never returns the unfiltered list — either exactly the closed plans, or a 400 naming the scoped route", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyA = await createProject(`global-filter-closed-a-${crypto.randomUUID()}`);
    const keyB = await createProject(`global-filter-closed-b-${crypto.randomUUID()}`);
    await filePlan(keyA, "CR-GLOBAL-FILTER-OPEN");
    const closeRes = await postJson(`/api/v2/projects/${keyB}/plans`, {
      cr: "CR-GLOBAL-FILTER-CLOSED",
      cycles: [{ label: "solo" }],
    });
    expect(closeRes.status).toBe(201);
    const closedPlan = (await closeRes.json()) as { planId: number | string; cycles: { id: number }[] };
    const cycleId = closedPlan.cycles[0]!.id;
    await (async () => {
      const toActive = await fetch(
        `http://localhost:${handle!.server.port}/api/v2/projects/${keyB}/plans/${closedPlan.planId}/cycles/${cycleId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(withFixtureAgent({ status: "active" })),
        },
      );
      expect(toActive.status).toBe(200);
      const toDone = await fetch(
        `http://localhost:${handle!.server.port}/api/v2/projects/${keyB}/plans/${closedPlan.planId}/cycles/${cycleId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(withFixtureAgent({ status: "done" })),
        },
      );
      expect(toDone.status).toBe(200);
      const close = await fetch(
        `http://localhost:${handle!.server.port}/api/v2/projects/${keyB}/plans/${closedPlan.planId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(withFixtureAgent({ status: "closed", merge: { commit: "abc0001" } })),
        },
      );
      expect(close.status).toBe(200);
    })();

    const res = await getJson(`/api/v2/plans?status=closed`);
    const body = (await res.json()) as PlansListResponse | ErrResponse;
    assertNeverUnfilteredAnswer(res, body, (p) => p.status === "closed", 2);
  });

  test("with NO filter params, the unscoped read returns EVERY project's plans, exactly as today — no regression from AC8", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyA = await createProject(`global-filter-unfiltered-a-${crypto.randomUUID()}`);
    const keyB = await createProject(`global-filter-unfiltered-b-${crypto.randomUUID()}`);
    await filePlan(keyA, "CR-GLOBAL-UNFILTERED-A");
    await filePlan(keyB, "CR-GLOBAL-UNFILTERED-B");

    const res = await getJson(`/api/v2/plans`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.plans.map((p) => p.cr).sort()).toEqual(["CR-GLOBAL-UNFILTERED-A", "CR-GLOBAL-UNFILTERED-B"]);
  });
});
