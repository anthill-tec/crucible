// CR-CRU-004 §S1+§S5 — v2 API: orientation, health parity, project rollups (PRD §4.2),
// agent lifecycle verbs (PRD §4.3), and the changed:true|false write-report contract (§S5).
// Drives the REAL production server (startServer) — src/v2.ts does not exist yet (RED
// phase), so every v2 route currently 404s through the existing catch-all in src/server.ts
// (`{ok:false, error}` at HTTP 404) until GREEN wires it in.
import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Coverage, RunSummary } from "../src/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface OrientationResponse {
  ok: true;
  service: string;
  version: string;
  projects: unknown[];
  help: string[];
}

interface HealthResponse {
  ok: boolean;
  status: string;
  version: string;
  uptime_s: number;
  counts: { projects: number; agents: number; events: number };
}

interface ProjectPayload {
  key: string;
  name: string;
  type: string;
  sutRoot?: string;
}

interface ProjectRollup extends ProjectPayload {
  agentsOnline: number;
  agentsTotal: number;
  lastEvent: unknown;
  latestGreenCoverage: unknown;
}

interface ProjectsRollupResponse {
  ok: true;
  projects: ProjectRollup[];
}

interface AgentPayload {
  agentId: string;
  projectKey: string;
  status: string;
  message: string;
  identity: Record<string, unknown>;
  liveness?: string;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentPayload[];
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
}

describe("v2 API — orientation, health parity, project rollups, agent verbs (CR-CRU-004 §S1+§S5)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    setSystemTime(); // reset the injected clock so it never leaks to other files
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(name: string, type?: string): Promise<string> {
    const res = await postJson("/api/v2/projects", type !== undefined ? { name, type } : { name });
    const body = (await res.json()) as OkResponse & { project: ProjectPayload };
    return body.project.key;
  }

  function parsedBody(overrides: {
    projectKey: string;
    agentId?: string;
    summary?: Partial<RunSummary>;
    coverage?: Coverage;
    // CR-CRU-038 §S2b — optional run-level captured raw output.
    raw?: string;
  }) {
    return {
      projectKey: overrides.projectKey,
      agentId: overrides.agentId ?? "ingest-agent",
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
      ...(overrides.coverage !== undefined ? { coverage: overrides.coverage } : {}),
      ...(overrides.raw !== undefined ? { raw: overrides.raw } : {}),
    };
  }

  // ── GET /api/v2 — orientation ─────────────────────────────────────────
  describe("GET /api/v2", () => {
    test("200 {ok:true, service:'crucible', version:<string>, projects:[...], help:[non-empty strings]}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2");

      expect(res.status).toBe(200);
      const body = (await res.json()) as OrientationResponse;
      expect(body.ok).toBe(true);
      expect(body.service).toBe("crucible");
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
      expect(Array.isArray(body.projects)).toBe(true);
      expect(isNonEmptyStringArray(body.help)).toBe(true);
    });

    test("projects array reflects a project added through the store (not a hardcoded empty stub)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      handle.store.addProject({ key, name: "orient-p", type: "backend", sutRoot: "/tmp" });

      const res = await getJson("/api/v2");
      const body = (await res.json()) as OrientationResponse;
      const keys = (body.projects as Array<{ key: string }>).map((p) => p.key);
      expect(keys).toContain(key);
    });
  });

  // ── GET /api/v2/health — parity with /api/health ────────────────────────
  describe("GET /api/v2/health", () => {
    test("same shape and values as GET /api/health (same store instance)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      handle.store.addProject({ key, name: "h", type: "backend", sutRoot: "/tmp" });

      const v1Res = await getJson("/api/health");
      const v2Res = await getJson("/api/v2/health");

      expect(v2Res.status).toBe(200);
      const v1Body = (await v1Res.json()) as HealthResponse;
      const v2Body = (await v2Res.json()) as HealthResponse;

      expect(Object.keys(v2Body).sort()).toEqual(Object.keys(v1Body).sort());
      expect(v2Body.ok).toBe(true);
      expect(v2Body.status).toBe("healthy");
      expect(typeof v2Body.version).toBe("string");
      expect(typeof v2Body.uptime_s).toBe("number");
      expect(v2Body.counts).toEqual({ projects: 1, agents: 0, events: 0 });
    });
  });

  // ── POST /api/v2/projects ───────────────────────────────────────────────
  describe("POST /api/v2/projects", () => {
    test("{name:'X'} (no key) → 200 {ok:true, changed:true, project:{key:UUID, name:'X', type:'backend'}}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/projects", { name: "X" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { project: ProjectPayload };
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(body.project.key).toMatch(UUID_RE);
      expect(body.project.name).toBe("X");
      expect(body.project.type).toBe("backend");
    });

    test("repeating with the SAME auto-generated key + any name → 200 {ok:true, changed:false} (NOT 400 — differs from the v1 shim)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const first = await postJson("/api/v2/projects", { name: "X" });
      const firstBody = (await first.json()) as OkResponse & { project: ProjectPayload };
      const key = firstBody.project.key;

      const second = await postJson("/api/v2/projects", { key, name: "a different name entirely" });

      expect(second.status).toBe(200);
      const body = (await second.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(false);
    });

    test("{key:'bad'} (non-UUID key) → 400", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/projects", { key: "bad" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("{} (no name) → 400", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/projects", {});

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("{name:'F', type:'frontend'} → project.type is 'frontend'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/projects", { name: "F", type: "frontend" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { project: ProjectPayload };
      expect(body.project.type).toBe("frontend");
    });
  });

  // ── GET /api/v2/projects — rollups ──────────────────────────────────────
  describe("GET /api/v2/projects — rollups", () => {
    test("fresh project: agentsOnline=0, agentsTotal=0, lastEvent=null, latestGreenCoverage=null", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("roll");

      const res = await getJson("/api/v2/projects");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsRollupResponse;
      const project = body.projects.find((p) => p.key === key);
      expect(project).toBeDefined();
      expect(project!.agentsOnline).toBe(0);
      expect(project!.agentsTotal).toBe(0);
      expect(project!.lastEvent).toBeNull();
      expect(project!.latestGreenCoverage).toBeNull();
    });

    test("after agent register + a green parsed ingest with coverage (via v2 /api/v2/runs/parsed, same store — modernized off the retired v1 shim, CR-CRU-008 §S4): agentsTotal>=1, lastEvent non-null, latestGreenCoverage non-null", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("roll2");

      const registerRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "roll-agent",
        message: "m",
        identity: { displayName: "R" },
      });
      expect(registerRes.status).toBe(200);

      const coverage: Coverage = { lines: { total: 10, covered: 8, percent: 80 } };
      const ingestRes = await postJson(
        "/api/v2/runs/parsed",
        parsedBody({ projectKey: key, agentId: "roll-agent", coverage }),
      );
      expect(ingestRes.status).toBe(200);

      const res = await getJson("/api/v2/projects");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsRollupResponse;
      const project = body.projects.find((p) => p.key === key);
      expect(project).toBeDefined();
      expect(project!.agentsTotal).toBeGreaterThanOrEqual(1);
      expect(project!.lastEvent).not.toBeNull();
      expect(project!.latestGreenCoverage).not.toBeNull();
    });
  });

  // CR-CRU-038 §S2b — server-side raw-output capture: `RunEvent.raw?: string`
  // is stored by both ingest paths and served verbatim on the event GET.
  // Neither ingest path accepts/stores/serves `raw` today (gap-analysis
  // finding), so every test below FAILS until GREEN wires it through
  // src/types.ts (RunEvent.raw) + src/store.ts (recordTestEvent) + src/v2.ts
  // (handleRunsParsed / handleRuns already pass `run` through unchanged) +
  // src/codecs/junit.ts (system-out/err extraction, see junit-codec.test.ts).
  describe("raw-output capture — POST /api/v2/runs/parsed + POST /api/v2/runs (junit) → GET /api/v2/events/:id (CR-CRU-038 §S2b)", () => {
    async function fetchEventRaw(eventId: string): Promise<Record<string, unknown>> {
      const res = await getJson(`/api/v2/events/${eventId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; event: Record<string, unknown> };
      return body.event;
    }

    test("POST .../runs/parsed with body.raw set → the stored event, fetched via GET /api/v2/events/:id, carries raw with that EXACT text", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("raw-parsed-present");
      const raw = "captured stdout line\ncaptured stderr line";

      const ingestRes = await postJson("/api/v2/runs/parsed", parsedBody({ projectKey: key, raw }));
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse & { event: string };

      const event = await fetchEventRaw(ingestBody.event);
      expect(event.raw).toBe(raw);
    });

    test("POST .../runs/parsed WITHOUT a raw field → the stored event carries NO raw key at all (not fabricated as an empty string)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("raw-parsed-absent");

      const ingestRes = await postJson("/api/v2/runs/parsed", parsedBody({ projectKey: key }));
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse & { event: string };

      const event = await fetchEventRaw(ingestBody.event);
      expect(Object.prototype.hasOwnProperty.call(event, "raw")).toBe(false);
    });

    test("raw persists on a FAILING parsed ingest — unlike coverage, raw is never discarded on fail", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("raw-parsed-failing");
      const raw = "failure diagnostics blob";

      const ingestRes = await postJson(
        "/api/v2/runs/parsed",
        parsedBody({ projectKey: key, raw, summary: { total: 5, passed: 4, failed: 1 } }),
      );
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse & { event: string };

      const event = await fetchEventRaw(ingestBody.event);
      expect(event.raw).toBe(raw);
    });

    test("POST /api/v2/runs (codec:'junit') with <system-out>/<system-err> in the XML → the stored event carries raw containing both captured texts", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("raw-junit-ingest");
      const xml = [
        '<testsuite name="RawSuite" tests="1">',
        '<testcase name="t1" time="0.01"/>',
        "<system-out>junit stdout capture</system-out>",
        "<system-err>junit stderr capture</system-err>",
        "</testsuite>",
      ].join("\n");

      const ingestRes = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "junit-raw-agent",
        codec: "junit",
        data: xml,
      });
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse & { event: string };

      const event = await fetchEventRaw(ingestBody.event);
      expect(event.raw).toContain("junit stdout capture");
      expect(event.raw).toContain("junit stderr capture");
    });
  });

  // CR-CRU-037 §S1 — `agentsOnline` must equal the HIGHLIGHTED set (every
  // non-tombstoned agent: online + stale), not just `liveness === "online"`.
  // Today src/v2.ts (~line 297) filters on "online" only, so a still-
  // highlighted "stale" agent silently drops out of the count while its row
  // stays lit in the UI — the count disagrees with what is on screen.
  describe("GET /api/v2/projects — agentsOnline counts the highlighted (non-tombstoned) set (CR-CRU-037 §S1)", () => {
    test(
      "one online agent + one stale agent (both highlighted, neither tombstoned) → agentsOnline == 2; " +
        "a third tombstoned agent is excluded from the count (currently FAILS: production counts only " +
        "liveness === 'online' and returns 1)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const T0 = 1_700_000_000_000;
        setSystemTime(T0);
        const key = await createProject("s1-agents-online-count");

        // Registered first so it ages all the way to "tombstoned" (silence
        // >= 300_000ms, tests/liveness.test.ts's default T2) by the time the
        // other two agents are checked.
        await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId: "tomb-agent",
          message: "m",
        });

        // 240s later: register the two agents that must stay highlighted.
        setSystemTime(T0 + 240_000);
        await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId: "stale-agent",
          message: "m",
        });
        await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId: "online-agent",
          message: "m",
        });

        // 60s later still (T0+300_000 total): tomb-agent's silence is
        // exactly 300_000ms → tombstoned. stale-agent's silence is exactly
        // 60_000ms (T0+300_000 - T0+240_000) → stale (closed-open T1
        // boundary, tests/liveness.test.ts). online-agent is heartbeat at
        // this exact instant → silence 0 → online.
        setSystemTime(T0 + 300_000);
        await postJson("/api/v2/agents/heartbeat", {
          projectKey: key,
          agentId: "online-agent",
          message: "m2",
        });

        // Confirm the fixture actually landed on the intended liveness
        // states before asserting the count — the count assertion is
        // meaningless if the fixture drifted off its intended boundaries.
        const agentsRes = await getJson(`/api/v2/agents?project=${key}`);
        const agentsBody = (await agentsRes.json()) as AgentsListResponse;
        expect(agentsBody.agents.find((a) => a.agentId === "online-agent")?.liveness).toBe(
          "online",
        );
        expect(agentsBody.agents.find((a) => a.agentId === "stale-agent")?.liveness).toBe("stale");
        expect(agentsBody.agents.find((a) => a.agentId === "tomb-agent")?.liveness).toBe(
          "tombstoned",
        );

        const res = await getJson("/api/v2/projects");
        expect(res.status).toBe(200);
        const body = (await res.json()) as ProjectsRollupResponse;
        const project = body.projects.find((p) => p.key === key);
        expect(project).toBeDefined();
        // online + stale are BOTH highlighted (non-tombstoned) → count == 2.
        // Current production (`agents.filter(a => a.liveness === "online")`)
        // excludes the stale agent and returns 1.
        expect(project!.agentsOnline).toBe(2);
        // Bound: the tombstoned agent is still counted in agentsTotal (every
        // registered, non-pruned agent) — only the highlighted count changes.
        expect(project!.agentsTotal).toBe(3);
      },
    );
  });

  // ── POST /api/v2/agents/register ────────────────────────────────────────
  describe("POST /api/v2/agents/register", () => {
    test("known project → 200 {ok:true, changed:true, help:[non-empty strings]}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("reg-p");

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "a1",
        message: "m",
        identity: { displayName: "A" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(isNonEmptyStringArray(body.help)).toBe(true);
    });

    test("second register of the same agent → changed:false", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("reg-p2");
      const registerBody = { projectKey: key, agentId: "a1", message: "m", identity: { displayName: "A" } };

      const first = await postJson("/api/v2/agents/register", registerBody);
      expect(first.status).toBe(200);
      const second = await postJson("/api/v2/agents/register", registerBody);

      expect(second.status).toBe(200);
      const body = (await second.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(false);
    });

    test("unknown (valid-UUID but unregistered) project → 404 with help array present", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/agents/register", {
        projectKey: crypto.randomUUID(),
        agentId: "a1",
        message: "m",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse & { help?: unknown };
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
    });

    test("missing agentId → 400", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("reg-p3");

      const res = await postJson("/api/v2/agents/register", { projectKey: key, message: "m" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });
  });

  // ── POST /api/v2/agents/heartbeat ───────────────────────────────────────
  describe("POST /api/v2/agents/heartbeat", () => {
    test("{ok:true}; updates message/status of an already-registered agent", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("hb-p");
      await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "a1",
        message: "initial",
        identity: { displayName: "A" },
      });

      const res = await postJson("/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId: "a1",
        message: "heartbeat-message",
        status: "busy",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "a1");
      expect(agent).toBeDefined();
      expect(agent!.message).toBe("heartbeat-message");
      expect(agent!.status).toBe("busy");
    });

    test("a fresh agent's computed liveness is 'online' via GET /api/v2/agents?project=", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("hb-p2");
      await postJson("/api/v2/agents/register", { projectKey: key, agentId: "a1", message: "m" });
      await postJson("/api/v2/agents/heartbeat", { projectKey: key, agentId: "a1", message: "m2" });

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "a1");
      expect(agent).toBeDefined();
      expect(agent!.liveness).toBe("online");
    });
  });

  // ── POST /api/v2/agents/unregister ──────────────────────────────────────
  describe("POST /api/v2/agents/unregister", () => {
    test("{projectKey, agentId} → {ok:true, changed:true}; repeat → changed:false; agent gone from GET", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("unreg-p");
      await postJson("/api/v2/agents/register", { projectKey: key, agentId: "a1", message: "m" });

      const first = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId: "a1" });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as OkResponse;
      expect(firstBody.ok).toBe(true);
      expect(firstBody.changed).toBe(true);

      const second = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId: "a1" });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as OkResponse;
      expect(secondBody.ok).toBe(true);
      expect(secondBody.changed).toBe(false);

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as AgentsListResponse;
      expect(listBody.agents.some((a) => a.agentId === "a1")).toBe(false);
    });
  });
});
