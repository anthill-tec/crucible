// CR-CRU-011 §S0 — cycle-plan API (server, additive): file/append plans,
// cycle transitions across kinds, plan close + commitBoundary, run linkage
// tolerance, query filters, SSE change notification, and non-interference
// with run-event rollups. C1 is server-only — no UI/lens assertions here.
// Drives the REAL production server (startServer), same harness pattern as
// tests/v2-core.test.ts. (History: this line also cited
// tests/shim-ingest-events.test.ts — archived by CR-CRU-008's shim-retirement
// sweep, then deleted outright with tests/archive by CR-CRU-047.)
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

  // CR-CRU-056 §S2b fixture-repair (C3): every mutating v2 WORKFLOW verb this
  // file exercises (plan-file, cycle-add, cycle transitions, plan close/
  // backfill, and run ingest) now refuses an unregistered caller (409) —
  // these are functional coverage tests, not the §S2b auth suite itself, so
  // they must model a CORRECTLY-registered caller rather than assert on the
  // refusal. `withFixtureAgent` merges a live-registered `agentId` into any
  // JSON body that doesn't already declare one (a body that already sets its
  // own agentId — e.g. parsedRunBody — passes through untouched).
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

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
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

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `plans-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
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
      agentId: "fixture-orch",
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

    test("pending -> skipped succeeds — the one legal shortcut (orchestrator cancels an unnecessary cycle without activating it)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-3");

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "skipped",
      });
      expect(res.status).toBe(200);
      expect(await getCycleStatus(key, "CR-T-3")).toBe("skipped");
    });

    test("pending -> failed (skipping active) -> 400 naming both states — the boundary of the one shortcut", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const { planId, cycleId } = await fileSingleCycle(key, "CR-T-3b");

      const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
        status: "failed",
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/pending/i);
      expect(text).toMatch(/failed/i);
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

  // ── §S7 — run linkage: an unknown cycleId is REFUSED (400) ──────────────────
  // CR-CRU-024 §S7 supersedes CR-011 §S0's tolerance — Crucible is the source of truth
  describe("run linkage — unknown cycleId refused (§S7)", () => {
    test("a run ingested with a context.cycleId that resolves to no cycle in the project → 400 (ok:false + help), no event stored", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      // File a plan so the project HAS real cycles — the ingested cycleId (999999)
      // still matches none of them, so §S7 refuses the ingest (never stored on trust).
      await postJson(plansPath(key), { cr: "CR-T-LINK", cycles: [{ label: "a" }, { label: "b" }] });

      const before = await getJson(`/api/v2/events?project=${key}`);
      const beforeBody = (await before.json()) as EventsListResponse;
      const beforeCount = beforeBody.events.length;

      const res = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody({ context: { cycleId: 999999 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as string[]).length).toBeGreaterThan(0);

      // No event stored — the events count is unchanged after the refused ingest.
      const listed = await getJson(`/api/v2/events?project=${key}`);
      const listedBody = (await listed.json()) as EventsListResponse;
      expect(listedBody.events.length).toBe(beforeCount);
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
      // CR-CRU-057 §S1 — `role` is a deliberate ADDITIVE key: `fixture-orch`
      // (createProject's registered caller) declares role:"ORCHESTRATOR",
      // so the ingest-response echo now carries it alongside the pre-CR-011
      // set. Any agent with a declared role gets the key, bound or not —
      // this is not a subset loosening, it's recording the intended shape.
      expect(Object.keys(body).sort()).toEqual(["changed", "event", "ok", "role", "run", "verdict"].sort());
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

  // ── §S6.11 (CR-CRU-021) — optional plan title, captured at filing ────────
  // The CR ROOT element in the Workflow active view renders `<cr> · <title>`
  // when the plan carries one (heat-highlighted id, title captured at plan
  // filing via this additive optional `title` field), and the id-only root
  // when it doesn't (graceful degradation, §S6.11). RED phase: expected to
  // fail against CURRENT production — POST /plans has no `title` handling at
  // all (src/v2.ts handlePlanFile ~512, no `title` in the V2Body interface,
  // no `title` column in src/store.ts filePlan) — title is silently dropped
  // today, never 400s on a bad type, and never appears in GET.
  describe("POST /api/v2/projects/<key>/plans — optional title (§S6.11)", () => {
    test('a string title is stored and returned VERBATIM on the POST response and on GET /plans', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-TITLE-1",
        title: "Runtime checkpoint persistence",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect(filedBody.title).toBe("Runtime checkpoint persistence");

      const listed = await getJson(plansPath(key, "?cr=CR-TITLE-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-TITLE-1")!;
      expect(plan.title).toBe("Runtime checkpoint persistence");
    });

    test("omitting title entirely files the plan with NO title field on the POST response or on GET (absent, not null — graceful degradation, §S6.11 id-only root)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-TITLE-2",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect("title" in filedBody).toBe(false);

      const listed = await getJson(plansPath(key, "?cr=CR-TITLE-2"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-TITLE-2")!;
      expect("title" in plan).toBe(false);
    });

    test("a non-string title -> 400 naming the title field", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-TITLE-3",
        title: 12345,
        cycles: [{ label: "a" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/\btitle\b/i);
    });

    test("an empty-object title -> 400 naming the title field (not silently coerced to string)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-TITLE-4",
        title: { nested: true },
        cycles: [{ label: "a" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/\btitle\b/i);
    });
  });

  // ── §S6 RE-BASELINE (CR-CRU-021, cycle 19, user 2026-07-17) — optional plan
  // orchestrator identity, mirroring the §S6.11 `title` pattern ────────────
  // "The root also carries the ORCHESTRATOR IDENTITY (user re-baseline
  // 2026-07-17 — replaces the removed per-row `by <orchestrator>`
  // narration): rendered `<cr> · <title> — <orchestrator>` via an additive
  // optional `orchestrator` field on `POST /plans` (stored, returned by GET)
  // AND accepted by PATCH on an OPEN plan (one-field backfill so the
  // executing plan can be stamped); absent → segment omitted."
  //
  // RED phase: expected to fail against CURRENT production — `Plan` has no
  // `orchestrator` field at all (src/types.ts's `Plan` interface only carries
  // `title`; `RunContext.orchestrator` is an unrelated, pre-existing field on
  // RUN EVENTS, not plans), `handlePlanFile` (src/v2.ts ~514) never reads
  // `body.orchestrator`, and `handlePlanClose` (src/v2.ts ~621, the sole
  // PATCH …/plans/<planId> handler) unconditionally 400s any body whose
  // `status` isn't literally `"closed"` — so an orchestrator-only PATCH body
  // (no `status`) 400s today for the WRONG reason (missing status), not
  // because the plan is open/closed.
  describe("POST /api/v2/projects/<key>/plans — optional orchestrator (§S6 re-baseline, cycle 19)", () => {
    test("a string orchestrator is stored and returned VERBATIM on the POST response and on GET /plans", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-ORCH-1",
        orchestrator: "vidushi",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect(filedBody.orchestrator).toBe("vidushi");

      const listed = await getJson(plansPath(key, "?cr=CR-ORCH-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-ORCH-1")!;
      expect(plan.orchestrator).toBe("vidushi");
    });

    test("omitting orchestrator entirely files the plan with NO orchestrator field on the POST response or on GET (absent, not null — graceful degradation)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-ORCH-2",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect("orchestrator" in filedBody).toBe(false);

      const listed = await getJson(plansPath(key, "?cr=CR-ORCH-2"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-ORCH-2")!;
      expect("orchestrator" in plan).toBe(false);
    });

    test("a non-string orchestrator -> 400 naming the orchestrator field", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-ORCH-3",
        orchestrator: 12345,
        cycles: [{ label: "a" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/\borchestrator\b/i);
    });

    test("an empty-object orchestrator -> 400 naming the orchestrator field (not silently coerced to string)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-ORCH-4",
        orchestrator: { nested: true },
        cycles: [{ label: "a" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/\borchestrator\b/i);
    });
  });

  describe("PATCH .../plans/<planId> — optional orchestrator one-field backfill (§S6 re-baseline, cycle 19)", () => {
    test('PATCH {orchestrator} on an OPEN plan (no "status", no "merge") stores it as a one-field backfill, visible on a subsequent GET, and the plan STAYS open', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-ORCH-PATCH-1",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const plan = (await filed.json()) as PlanFileResponse;
      expect("orchestrator" in plan).toBe(false); // sanity: unstamped at filing

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), {
        orchestrator: "vidushi",
      });
      expect(patched.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-ORCH-PATCH-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const stamped = listedBody.plans.find((p) => p.cr === "CR-ORCH-PATCH-1")!;
      expect(stamped.orchestrator).toBe("vidushi");
      expect(stamped.status).toBe("open");
    });

    test("a non-string orchestrator on PATCH -> 400 naming the orchestrator field, plan left unstamped", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-ORCH-PATCH-2",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), {
        orchestrator: 999,
      });
      expect(patched.status).toBe(400);
      const text = await bodyText(patched);
      expect(text).toMatch(/\borchestrator\b/i);

      const listed = await getJson(plansPath(key, "?cr=CR-ORCH-PATCH-2"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const unstamped = listedBody.plans.find((p) => p.cr === "CR-ORCH-PATCH-2")!;
      expect("orchestrator" in unstamped).toBe(false);
    });

    test("PATCH {orchestrator} on a CLOSED plan -> 400 (the one-field backfill applies to an executing/open plan only)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-ORCH-PATCH-3",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc9999" },
      });
      expect(closeRes.status).toBe(200);

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), {
        orchestrator: "vidushi",
      });
      expect(patched.status).toBe(400);
    });
  });

  // ── RED addendum (cycle 13, gap 3) — POST /plans `wave` coercion ─────────
  // src/v2.ts:537 currently accepts ONLY strings for `wave`
  // (`typeof body.wave === "string" ? body.wave : undefined`) — a numeric
  // wave (e.g. the orchestrator's real plan 4, filed with `wave: 4`) is
  // silently coerced to `undefined` and stored NULL, with no 400 at all.
  // The lens sorts wave labels with the string-label model
  // (`numericLabelCompare`, public/app-logic.mjs) — a numeric wave must
  // coerce to its string form on entry to match that model, exactly the
  // way an already-string wave is accepted unchanged; anything else
  // (an object) 400s naming the field, mirroring the §S6.11 `title` pattern.
  describe("POST /api/v2/projects/<key>/plans — wave coercion (RED addendum, cycle 13, gap 3)", () => {
    test('a numeric wave (4) is stored and returned as the STRING "4" on the POST response and on GET', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-NUM-1",
        wave: 4,
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect(filedBody.wave).toBe("4");
      expect(typeof filedBody.wave).toBe("string");

      const listed = await getJson(plansPath(key, "?cr=CR-WAVE-NUM-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-WAVE-NUM-1")!;
      expect(plan.wave).toBe("4");
      expect(typeof plan.wave).toBe("string");
    });

    test('a string wave ("4") is stored and returned UNCHANGED', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-STR-1",
        wave: "4",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const filedBody = (await filed.json()) as PlanFileResponse;
      expect(filedBody.wave).toBe("4");

      const listed = await getJson(plansPath(key, "?cr=CR-WAVE-STR-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const plan = listedBody.plans.find((p) => p.cr === "CR-WAVE-STR-1")!;
      expect(plan.wave).toBe("4");
    });

    test("a non-string-non-number wave (an object) -> 400 naming the wave field", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), {
        cr: "CR-WAVE-BAD-1",
        wave: { nested: true },
        cycles: [{ label: "a" }],
      });
      expect(res.status).toBe(400);
      const text = await bodyText(res);
      expect(text).toMatch(/\bwave\b/i);
    });
  });

  // ── CR-CRU-031 §S1 — `wave` one-field backfill on the plan PATCH ─────────
  // Extends PATCH …/plans/<planId> (`handlePlanClose`) so a body carrying
  // `wave` with NO `status` stamps the plan's wave — allowed on OPEN **and**
  // CLOSED plans (unlike the existing `orchestrator` one-field backfill just
  // above, which 400s a closed plan — a merged plan's wave is exactly what
  // needs correcting, per the CR-021 History mis-grouping this CR fixes).
  // `wave` coerces number -> its decimal string exactly as the POST /plans
  // path already does (RED addendum cycle 13, gap 3, tested above); unknown
  // planId -> 404; a non-string/non-number wave (an object) -> 400 naming
  // the field; rollups/events untouched.
  //
  // RED phase: expected to fail against CURRENT production —
  // `handlePlanClose` (src/v2.ts ~765) only recognizes `body.orchestrator` in
  // the one-field-backfill branch, so a `{wave:...}`-only body (no `status`)
  // falls through to the `body.status !== "closed"` check and 400s for the
  // WRONG reason ("status must be \"closed\" to close a plan" — never
  // mentions "wave", never distinguishes open/closed, never 404s an unknown
  // plan on this path), and `store.ts` has no wave-backfill method at all.
  describe("PATCH .../plans/<planId> — wave one-field backfill (CR-CRU-031 §S1)", () => {
    test('PATCH {wave:"4"} (no status) on an OPEN plan stores it as a one-field backfill, visible on GET, plan STAYS open', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-1",
        cycles: [{ label: "a" }],
      });
      expect(filed.status).toBe(201);
      const plan = (await filed.json()) as PlanFileResponse;
      expect("wave" in plan).toBe(false); // sanity: filed without a wave

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), { wave: "4" });
      expect(patched.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const stamped = listedBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-1")!;
      expect(stamped.wave).toBe("4");
      expect(stamped.status).toBe("open");
    });

    test("PATCH {wave} (no status) on a CLOSED plan ALSO succeeds and its wave updates — the point of this CR, contrasting with the orchestrator backfill which 400s a closed plan", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-CLOSED-1",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "closedwave1" },
      });
      expect(closeRes.status).toBe(200);

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), { wave: "4" });
      expect(patched.status).toBe(200);

      const listed = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-CLOSED-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const stamped = listedBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-CLOSED-1")!;
      expect(stamped.wave).toBe("4");
      expect(stamped.status).toBe("closed");
    });

    test('a numeric wave on PATCH coerces to its decimal STRING, matching the POST /plans coercion, on both an OPEN and a CLOSED plan', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      // OPEN
      const filedOpen = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-NUM-OPEN",
        cycles: [{ label: "a" }],
      });
      const planOpen = (await filedOpen.json()) as PlanFileResponse;
      const patchedOpen = await patchJson(plansPath(key, `/${planOpen.planId}`), { wave: 4 });
      expect(patchedOpen.status).toBe(200);
      const listedOpen = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-NUM-OPEN"));
      const listedOpenBody = (await listedOpen.json()) as PlansListResponse;
      const stampedOpen = listedOpenBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-NUM-OPEN")!;
      expect(stampedOpen.wave).toBe("4");
      expect(typeof stampedOpen.wave).toBe("string");

      // CLOSED
      const filedClosed = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-NUM-CLOSED",
        cycles: [{ label: "a" }],
      });
      const planClosed = (await filedClosed.json()) as PlanFileResponse;
      const cycleId = planClosed.cycles[0]!.id;
      await patchJson(plansPath(key, `/${planClosed.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${planClosed.planId}/cycles/${cycleId}`), { status: "done" });
      await patchJson(plansPath(key, `/${planClosed.planId}`), {
        status: "closed",
        merge: { commit: "closedwavenum1" },
      });
      const patchedClosed = await patchJson(plansPath(key, `/${planClosed.planId}`), { wave: 7 });
      expect(patchedClosed.status).toBe(200);
      const listedClosed = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-NUM-CLOSED"));
      const listedClosedBody = (await listedClosed.json()) as PlansListResponse;
      const stampedClosed = listedClosedBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-NUM-CLOSED")!;
      expect(stampedClosed.wave).toBe("7");
      expect(typeof stampedClosed.wave).toBe("string");
    });

    test("an unknown planId -> 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await patchJson(plansPath(key, "/999999"), { wave: "4" });
      expect(res.status).toBe(404);
    });

    test("a non-string-non-number wave (an object) on PATCH -> 400 naming the wave field, plan left unstamped", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-BAD-1",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), { wave: { nested: true } });
      expect(patched.status).toBe(400);
      const text = await bodyText(patched);
      expect(text).toMatch(/\bwave\b/i);

      const listed = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-BAD-1"));
      const listedBody = (await listed.json()) as PlansListResponse;
      const unstamped = listedBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-BAD-1")!;
      expect("wave" in unstamped).toBe(false);
    });

    test("wave backfill on a closed plan adds NO events, changes NO events-list count, and leaves commitBoundary untouched (rollups/events untouched)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const filed = await postJson(plansPath(key), {
        cr: "CR-WAVE-PATCH-ROLLUP-1",
        cycles: [{ label: "a" }],
      });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "active" });
      await patchJson(plansPath(key, `/${plan.planId}/cycles/${cycleId}`), { status: "done" });
      await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "rollupwave1" },
      });

      const before = await getJson(`/api/v2/events?project=${key}`);
      const beforeBody = (await before.json()) as EventsListResponse;
      // CR-CRU-056 §S2b fixture-repair: createProject() now registers the
      // fixture orchestrator, which itself journals ONE lifecycle event
      // (CR-CRU-011 §S1) — the baseline is that registration event, not
      // zero; the point of this test (rollups/events untouched by wave
      // backfill) is the UNCHANGED count across the backfill, asserted below.
      const baselineCount = beforeBody.events.length;

      const listedBefore = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-ROLLUP-1"));
      const listedBeforeBody = (await listedBefore.json()) as PlansListResponse;
      const boundaryBefore = listedBeforeBody.plans.find(
        (p) => p.cr === "CR-WAVE-PATCH-ROLLUP-1",
      )!.commitBoundary!;

      const patched = await patchJson(plansPath(key, `/${plan.planId}`), { wave: "9" });
      expect(patched.status).toBe(200);

      const after = await getJson(`/api/v2/events?project=${key}`);
      const afterBody = (await after.json()) as EventsListResponse;
      expect(afterBody.events.length).toBe(baselineCount);

      const listedAfter = await getJson(plansPath(key, "?cr=CR-WAVE-PATCH-ROLLUP-1"));
      const listedAfterBody = (await listedAfter.json()) as PlansListResponse;
      const afterPlan = listedAfterBody.plans.find((p) => p.cr === "CR-WAVE-PATCH-ROLLUP-1")!;
      expect(afterPlan.wave).toBe("9");
      expect(afterPlan.commitBoundary).toEqual(boundaryBefore);
    });
  });

  // ── §S0 — plans are not run events ────────────────────────────────────────
  describe("plans do not affect run-event surfaces", () => {
    test("filing, transitioning, and closing a plan add NO events and change NO events-list count", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const before = await getJson(`/api/v2/events?project=${key}`);
      const beforeBody = (await before.json()) as EventsListResponse;
      // CR-CRU-056 §S2b fixture-repair: createProject() now registers the
      // fixture orchestrator, which itself journals ONE lifecycle event
      // (CR-CRU-011 §S1) — the baseline is that registration event, not
      // zero; the point of this test (plans add no run-events) is the
      // UNCHANGED count across plan filing/transition/close, asserted below.
      const baselineCount = beforeBody.events.length;

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
      expect(afterBody.events.length).toBe(baselineCount);
    });
  });
});
