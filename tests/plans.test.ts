// CR-CRU-011 §S0 — cycle-plan API (server, additive): file/append plans,
// cycle transitions across kinds, plan close + commitBoundary, run linkage
// tolerance, query filters, SSE change notification, and non-interference
// with run-event rollups. C1 is server-only — no UI/lens assertions here.
// Drives the REAL production server (startServer), same harness pattern as
// tests/v2-core.test.ts / tests/shim-ingest-events.test.ts.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  track?: string;
  cycles: CyclePayload[];
  merge?: { commit: string };
  commitBoundary?: {
    mergeCommit: string;
    branch?: string;
    firstRunCommit?: string;
    lastRunCommit?: string;
    closedAt: number;
  };
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

interface RunIngestResponse {
  ok: true;
  changed: boolean;
  event: string;
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  projectKey: string;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: EventBrief[];
}

describe("cycle-plan API (CR-CRU-011 §S0)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `plans-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function bodyText(res: Response): Promise<string> {
    return JSON.stringify(await res.json());
  }

  function parsedRunBody(overrides: {
    context?: Record<string, unknown>;
    summary?: Record<string, unknown>;
  }) {
    return {
      agentId: "ingest-agent",
      summary: {
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 100,
        ...overrides.summary,
      },
      tree: [
        {
          name: "s",
          status: "pass",
          children: [{ name: "t1", status: "pass", duration_ms: 50 }],
        },
      ],
      ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    };
  }

  // ── §S0 — file + append ─────────────────────────────────────────────────
  describe("POST /api/v2/projects/<key>/plans — file a plan", () => {
    test("201 with two distinct numeric cycle ids, pending statuses, plan open", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-X-1",
        cycles: [{ label: "a" }, { label: "b" }],
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as PlanFileResponse;
      expect(body.cr).toBe("CR-X-1");
      expect(body.status).toBe("open");
      expect(body.cycles.length).toBe(2);
      expect(typeof body.cycles[0]!.id).toBe("number");
      expect(typeof body.cycles[1]!.id).toBe("number");
      expect(body.cycles[0]!.id).not.toBe(body.cycles[1]!.id);
      expect(body.cycles[0]!.status).toBe("pending");
      expect(body.cycles[1]!.status).toBe("pending");
    });

    test("second POST for the same open cr → 400 naming cr", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const first = await postJson(plansPath(key), { cr: "CR-X-1", cycles: [{ label: "a" }] });
      expect(first.status).toBe(201);

      const second = await postJson(plansPath(key), { cr: "CR-X-1", cycles: [{ label: "b" }] });
      expect(second.status).toBe(400);
      const text = await bodyText(second);
      expect(text).toMatch(/\bcr\b/i);
    });

    test("appending a cycle to an open plan returns a new unique id", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-X-2",
        cycles: [{ label: "a" }, { label: "b" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const existingIds = new Set(plan.cycles.map((c) => c.id));

      const appended = await postJson(plansPath(key, `/${plan.planId}/cycles`), { label: "c" });
      expect([200, 201]).toContain(appended.status);
      const appendedBody = (await appended.json()) as { id: number; [key: string]: unknown };
      expect(typeof appendedBody.id).toBe("number");
      expect(existingIds.has(appendedBody.id)).toBe(false);
    });
  });

  // ── §S0 — cycle transitions ──────────────────────────────────────────────
  describe("PATCH .../plans/<planId>/cycles/<id> — transitions", () => {
    async function fileSingleCycle(key: string, cr: string, kind?: string) {
      const res = await postJson(plansPath(key), {
        cr,
        cycles: [{ label: "solo", ...(kind !== undefined ? { kind } : {}) }],
      });
      const body = (await res.json()) as PlanFileResponse;
      return { planId: body.planId, cycleId: body.cycles[0]!.id };
    }

    async function getCycleStatus(key: string, cr: string): Promise<string> {
      const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
      const body = (await res.json()) as PlansListResponse;
      const plan = body.plans.find((p) => p.cr === cr);
      return plan!.cycles[0]!.status;
    }

    test("pending -> active -> done succeeds", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-1");

      const toActive = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "active",
      });
      expect(toActive.status).toBe(200);
      expect(await getCycleStatus(key, "CR-T-1")).toBe("active");

      const toDone = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "done",
      });
      expect(toDone.status).toBe(200);
      expect(await getCycleStatus(key, "CR-T-1")).toBe("done");
    });

    test("pending -> done (skipping active) -> 400 naming both states", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-2");

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "done",
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/pending/i);
      expect(text).toMatch(/done/i);
    });

    test("pending -> skipped (skipping active) -> 400 naming both states", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-3");

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "skipped",
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/pending/i);
      expect(text).toMatch(/skipped/i);
    });

    test("active -> skipped succeeds", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-4");
      await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "skipped",
      });
      expect(res.status).toBe(200);
      expect(await getCycleStatus(key, "CR-T-4")).toBe("skipped");
    });

    test("active -> failed succeeds", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-5");
      await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "failed",
      });
      expect(res.status).toBe(200);
      expect(await getCycleStatus(key, "CR-T-5")).toBe("failed");
    });

    test("a GREEN run ingest linked via context.cycleId does NOT change cycle status", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-6");
      await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });
      expect(await getCycleStatus(key, "CR-T-6")).toBe("active");

      const ingest = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({ context: { cycleId } }),
      });
      expect(ingest.status).toBe(200);

      // GREEN ingest alone must NOT auto-close the cycle — only the
      // orchestrator's explicit PATCH does.
      expect(await getCycleStatus(key, "CR-T-6")).toBe("active");
    });
  });

  // ── §S0 — kinds ───────────────────────────────────────────────────────────
  describe("cycle kinds", () => {
    for (const kind of ["red-green", "verify", "fix"] as const) {
      test(`kind:"${kind}" — pending -> active -> done succeeds identically`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject();
        const filed = await postJson(plansPath(key), {
          cr: `CR-K-${kind}`,
          cycles: [{ label: "solo", kind }],
        });
        const plan = (await filed.json()) as PlanFileResponse;
        expect(plan.cycles[0]!.kind).toBe(kind);
        const cycleId = plan.cycles[0]!.id;

        const toActive = await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), {
          status: "active",
        });
        expect(toActive.status).toBe(200);

        const toDone = await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), {
          status: "done",
        });
        expect(toDone.status).toBe(200);

        const listed = await getJson(plansPath(key, `?cr=${encodeURIComponent(`CR-K-${kind}`)}`));
        const listedBody = (await listed.json()) as PlansListResponse;
        expect(listedBody.plans[0]!.cycles[0]!.status).toBe("done");
      });
    }

    test("omitted kind defaults to red-green", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), {
        cr: "CR-K-default",
        cycles: [{ label: "solo" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      expect(plan.cycles[0]!.kind).toBe("red-green");
    });

    test('kind:"deploy" -> 400 naming kind', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const res = await postJson(plansPath(key), {
        cr: "CR-K-bad",
        cycles: [{ label: "solo", kind: "deploy" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/kind/i);
    });
  });

  // ── §S0 — plan close ─────────────────────────────────────────────────────
  describe("PATCH .../plans/<planId> — close", () => {
    test("closing with a non-terminal cycle -> 400 listing its id", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), {
        cr: "CR-C-1",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id; // stays "pending" — non-terminal

      const res = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc1234" },
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toContain(String(cycleId));
    });

    test("closing after all cycles are terminal succeeds and GET shows closed + merge commit", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), {
        cr: "CR-C-2",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });

      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc1234" },
      });
      expect(closeRes.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-C-2"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const closedPlan = listedBody.plans.find((p) => p.cr === "CR-C-2")!;
      expect(closedPlan.status).toBe("closed");
      expect(JSON.stringify(closedPlan)).toContain("abc1234");
    });
  });

  // ── §S0 — commitBoundary ──────────────────────────────────────────────────
  describe("commitBoundary (closed plans)", () => {
    test("closed plan with linked runs carrying context.git derives full commitBoundary", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), {
        cr: "CR-B-1",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });

      await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({
          context: { cycleId, git: { branch: "feat/x", commit: "c1a2b3c" } },
          summary: { failed: 2, passed: 3, total: 5 },
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({
          context: { cycleId, git: { branch: "feat/x", commit: "d4e5f6a" } },
        }),
      });

      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc1234" },
      });
      expect(closeRes.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-B-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const closedPlan = listedBody.plans.find((p) => p.cr === "CR-B-1")!;
      const boundary = closedPlan.commitBoundary!;
      expect(boundary.mergeCommit).toBe("abc1234");
      expect(boundary.branch).toBe("feat/x");
      expect(boundary.firstRunCommit).toBe("c1a2b3c");
      expect(boundary.lastRunCommit).toBe("d4e5f6a");
      expect(typeof boundary.closedAt).toBe("number");
    });

    test("closed plan with NO linked git context returns ONLY mergeCommit + closedAt (absent, not null)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), {
        cr: "CR-B-2",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });

      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "def5678" },
      });
      expect(closeRes.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-B-2"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const closedPlan = listedBody.plans.find((p) => p.cr === "CR-B-2")!;
      const boundary = closedPlan.commitBoundary!;
      expect(boundary.mergeCommit).toBe("def5678");
      expect(typeof boundary.closedAt).toBe("number");
      expect(Object.keys(boundary).sort()).toEqual(["closedAt", "mergeCommit"]);
    });
  });

  // ── §S0 — run linkage tolerance ────────────────────────────────────────────
  describe("run linkage tolerance", () => {
    test("a run ingested with an UNKNOWN context.cycleId is stored and queryable (never 4xx)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      // No plan filed at all on this project — cycleId is unknown by construction.

      const res = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({ context: { cycleId: 999999 } }),
      });
      expect(res.status).toBeLessThan(400);
      const body = (await res.json()) as RunIngestResponse;
      expect(body.ok).toBe(true);

      const listed = await getJson(`/api/v2/events?project=${key}`);
      const listedBody = (await listed.json()) as EventsListResponse;
      expect(listedBody.events.some((e) => e.id === body.event)).toBe(true);
    });

    test("a planless project's parsed ingest is byte-identical to pre-CR-011 (regression guard)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RunIngestResponse;
      expect(Object.keys(body).sort()).toEqual(["changed", "event", "ok", "run", "verdict"].sort());
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
    });
  });

  // ── §S0 — query filters ─────────────────────────────────────────────────
  describe("GET .../plans — query filters", () => {
    test("no filter returns all plans; ?cr= and ?track= filter; track carried verbatim, absent otherwise", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      await postJson(plansPath(key), { cr: "CR-Q-1", cycles: [{ label: "a" }] });
      await postJson(plansPath(key), { cr: "CR-Q-2", track: "track-2", cycles: [{ label: "a" }] });

      const all = await getJson(plansPath(key));
      const allBody = (await all.json()) as PlansListResponse;
      expect(allBody.plans.length).toBe(2);

      const byCr = await getJson(plansPath(key, "?cr=CR-Q-1"));
      const byCrBody = (await byCr.json()) as PlansListResponse;
      expect(byCrBody.plans.length).toBe(1);
      expect(byCrBody.plans[0]!.cr).toBe("CR-Q-1");

      const byTrack = await getJson(plansPath(key, "?track=track-2"));
      const byTrackBody = (await byTrack.json()) as PlansListResponse;
      expect(byTrackBody.plans.length).toBe(1);
      expect(byTrackBody.plans[0]!.cr).toBe("CR-Q-2");

      const planQ1 = allBody.plans.find((p) => p.cr === "CR-Q-1")!;
      const planQ2 = allBody.plans.find((p) => p.cr === "CR-Q-2")!;
      expect("track" in planQ1).toBe(false);
      expect(planQ2.track).toBe("track-2");
    });
  });

  // ── §S0 — SSE change notification ──────────────────────────────────────────
  describe("plan mutations emit a store change event", () => {
    test("filing, transitioning, and closing a plan each fire store.onChange for the project", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const calls: Array<[string, string | undefined]> = [];
      const unsubscribe = handle.store.onChange((kind, projectKey) => {
        calls.push([kind, projectKey]);
      });

      const filed = await postJson(plansPath(key), { cr: "CR-S-1", cycles: [{ label: "a" }] });
      const plan = (await filed.json()) as PlanFileResponse;
      expect(calls.some(([, pk]) => pk === key)).toBe(true);

      calls.length = 0;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      expect(calls.some(([, pk]) => pk === key)).toBe(true);

      calls.length = 0;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      expect(calls.some(([, pk]) => pk === key)).toBe(true);

      calls.length = 0;
      await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc1234" },
      });
      expect(calls.some(([, pk]) => pk === key)).toBe(true);

      unsubscribe();
    });
  });

  // ── §S0 — plans are not run events ────────────────────────────────────────
  describe("plans do not affect run-event surfaces", () => {
    test("filing, transitioning, and closing a plan add NO events and change NO events-list count", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const before = await getJson(`/api/v2/events?project=${key}`);
      const beforeBody = (await before.json()) as EventsListResponse;
      expect(beforeBody.events.length).toBe(0);

      const filed = await postJson(plansPath(key), { cr: "CR-N-1", cycles: [{ label: "a" }] });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc1234" },
      });

      const after = await getJson(`/api/v2/events?project=${key}`);
      const afterBody = (await after.json()) as EventsListResponse;
      expect(afterBody.events.length).toBe(0);
    });
  });
});
