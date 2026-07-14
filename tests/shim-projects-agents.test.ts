// CR-CRU-003 §S1+§S2 — v1 shim routes: projects (add/list) + agents (heartbeat/remove/list).
// Drives the REAL production server (startServer), not a hand-wired store, per DN
// §3.1-3.3 byte contract. Item 7 (Store.removeAgent event-emission fold-in) is
// asserted directly against Store since it is a store-level behavior.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ChangeKind } from "../src/store.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
}

interface ProjectsListResponse {
  ok: true;
  projects: Array<{ key: string; name: string; sutRoot?: string; sut_root?: string }>;
}

interface AgentsListResponse {
  ok: true;
  agents: Array<{
    agentId: string;
    projectKey: string;
    status: string;
    message: string;
    identity: Record<string, unknown>;
  }>;
}

describe("v1 shim — projects + agents routes (§S1+§S2)", () => {
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

  // ── §1 POST /api/projects/add ────────────────────────────────────────

  describe("POST /api/projects/add", () => {
    test("valid uuid key + sut_root snake_case → 200 {ok:true, ...} and project stored with sutRoot === sut_root", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();

      const res = await postJson("/api/projects/add", {
        key,
        name: "P",
        sut_root: "/tmp/p",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const stored = handle.store.getProject(key);
      expect(stored).not.toBeNull();
      expect(stored?.sutRoot).toBe("/tmp/p");
      expect(stored?.name).toBe("P");
    });

    test("duplicate key (idempotent self-registration quirk) → second add is 400 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();

      const first = await postJson("/api/projects/add", { key, name: "P", sut_root: "/tmp/p" });
      expect(first.status).toBe(200);

      const second = await postJson("/api/projects/add", { key, name: "P", sut_root: "/tmp/p" });
      expect(second.status).toBe(400);
      const body = (await second.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("non-UUID key → 400 with error containing UUID", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/projects/add", {
        key: "not-a-uuid",
        name: "P",
        sut_root: "/tmp/p",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toContain("UUID");
    });
  });

  // ── §2 GET /api/projects ─────────────────────────────────────────────

  describe("GET /api/projects", () => {
    test("returns {ok:true, projects:[...]} containing the added project", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });

      const res = await getJson("/api/projects");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsListResponse;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.projects)).toBe(true);
      expect(body.projects.some((p) => p.key === key)).toBe(true);
    });

    test("?name=p (case-insensitive substring) filters to matching projects", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key1 = crypto.randomUUID();
      const key2 = crypto.randomUUID();
      handle.store.addProject({ key: key1, name: "Project-P", type: "backend", sutRoot: "/tmp/1" });
      handle.store.addProject({ key: key2, name: "Other", type: "backend", sutRoot: "/tmp/2" });

      const res = await getJson("/api/projects?name=p");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsListResponse;
      expect(body.ok).toBe(true);
      const keys = body.projects.map((p) => p.key);
      expect(keys).toContain(key1);
      expect(keys).not.toContain(key2);
    });

    test("?name=zzz (no match) → empty projects list", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });

      const res = await getJson("/api/projects?name=zzz");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsListResponse;
      expect(body.ok).toBe(true);
      expect(body.projects).toEqual([]);
    });
  });

  // ── §3+§4 POST /api/agents/heartbeat ─────────────────────────────────

  describe("POST /api/agents/heartbeat", () => {
    function seedProject(): string {
      const key = crypto.randomUUID();
      handle!.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
      return key;
    }

    test("top-level displayName/source (NO identity object) → 200 {ok:true}; agent stored WITHOUT that displayName anywhere", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: pk,
        status: "online",
        message: "m",
        displayName: "TOP-LEVEL-IGNORED",
        source: "x",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "a1");
      expect(agent).toBeDefined();
      // top-level displayName/source must be silently ignored — must not surface anywhere.
      expect(JSON.stringify(agent)).not.toContain("TOP-LEVEL-IGNORED");
    });

    test("identity:{displayName,source,repoPath} is honored, and preserved across a later identity-less heartbeat with a new message", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const first = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: pk,
        status: "online",
        message: "first",
        identity: { displayName: "Real", source: "openclaw", repoPath: "/r" },
      });
      expect(first.status).toBe(200);

      const second = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: pk,
        status: "online",
        message: "second-message",
      });
      expect(second.status).toBe(200);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "a1");
      expect(agent).toBeDefined();
      expect(agent?.identity?.displayName).toBe("Real");
      expect(agent?.message).toBe("second-message");
    });

    test("status:'busy' → stored agent status is 'busy'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: pk,
        status: "busy",
        message: "working",
      });
      expect(res.status).toBe(200);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "a1");
      expect(agent?.status).toBe("busy");
    });

    test("unknown-but-valid-UUID projectKey → 404 {ok:false, error} with a non-empty actionable message", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: crypto.randomUUID(),
        status: "online",
        message: "m",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    test("non-UUID projectKey → 400 {ok:false, error} containing UUID", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "a1",
        projectKey: "not-a-uuid",
        status: "online",
        message: "m",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toContain("UUID");
    });
  });

  // ── §5 POST /api/agents/remove ───────────────────────────────────────

  describe("POST /api/agents/remove", () => {
    test("{agentId, projectKey} → {ok:true} and the agent is gone from that project", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      handle.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
      handle.store.touchAgent(key, "a1", { message: "hi" });

      const res = await postJson("/api/agents/remove", { agentId: "a1", projectKey: key });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const listRes = await getJson(`/api/agents?projectKey=${key}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      expect(listBody.agents.some((a) => a.agentId === "a1")).toBe(false);
    });

    test("agentId only (no projectKey) removes the agent across ALL projects (DN §3.3)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key1 = crypto.randomUUID();
      const key2 = crypto.randomUUID();
      handle.store.addProject({ key: key1, name: "p1", type: "backend", sutRoot: "/tmp/1" });
      handle.store.addProject({ key: key2, name: "p2", type: "backend", sutRoot: "/tmp/2" });
      handle.store.touchAgent(key1, "shared", { message: "hi" });
      handle.store.touchAgent(key2, "shared", { message: "hi" });

      const res = await postJson("/api/agents/remove", { agentId: "shared" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const list1 = (await (await getJson(`/api/agents?projectKey=${key1}`)).json()) as AgentsListResponse;
      const list2 = (await (await getJson(`/api/agents?projectKey=${key2}`)).json()) as AgentsListResponse;
      expect(list1.agents.some((a) => a.agentId === "shared")).toBe(false);
      expect(list2.agents.some((a) => a.agentId === "shared")).toBe(false);
    });
  });
});

// ── §7 Store-level: removeAgent event-emission fold-in (deferred) ────────
describe("Store.removeAgent — 'agents' change event only fires when a row was actually deleted", () => {
  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  test("removeAgent on a never-existed agent fires NO 'agents' event", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const seen: ChangeKind[] = [];
    store.onChange((kind) => seen.push(kind));

    store.removeAgent(pk, "ghost-never-existed");

    expect(seen).toEqual([]);
  });

  test("removeAgent on a real agent fires exactly one 'agents' event", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    store.touchAgent(pk, "a1", { message: "hi" });

    const seen: ChangeKind[] = [];
    const unsubscribe = store.onChange((kind) => seen.push(kind));
    // Subscribed AFTER touchAgent — only the removeAgent call should be observed.

    store.removeAgent(pk, "a1");
    unsubscribe();

    expect(seen).toEqual(["agents"]);
  });
});
