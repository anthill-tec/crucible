// CR-CRU-004 §S1+§S5 — v2 API: orientation, health parity, project rollups (PRD §4.2),
// agent lifecycle verbs (PRD §4.3), and the changed:true|false write-report contract (§S5).
// Drives the REAL production server (startServer) — src/v2.ts does not exist yet (RED
// phase), so every v2 route currently 404s through the existing catch-all in src/server.ts
// (`{ok:false, error}` at HTTP 404) until GREEN wires it in.
import { describe, test, expect, afterEach } from "bun:test";
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
