// CR-CRU-010 §S2+§S3 — cross-surface regression hardening.
//
// §S2: a dedicated request-pair test proving the v1 shim and v2 API stay
// consistent about the SAME stored event: v1 ingest → v2 event list shows
// the §S0 flattened brief (no nested `summary`); v2 ingest → v1 event list
// shows the legacy nested `summary`.
//
// §S3: one NAMED assertion per missing-required-field validation branch
// across the shim (src/server.ts) and v2 (src/v2.ts), each asserting HTTP
// 400 and the EXACT `error` string naming the field, per the CR's
// gap-analysis file:line list. These branches already exist in production
// today — they are expected to PASS immediately (regression-guarding
// existing behavior, not new behavior). Any failure here is a real defect,
// not something to "fix" by loosening the assertion.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

const JUNIT_3CASE_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

describe("cross-surface + per-branch 400 hardening — CR-CRU-010 §S2+§S3", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function seedProjectV1(): string {
    const key = crypto.randomUUID();
    handle!.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
    return key;
  }

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

  async function createProjectV2(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  // ─────────────────────────────────────────────────────────────────────
  // §S2 cross-surface pair
  // ─────────────────────────────────────────────────────────────────────
  describe("§S2 cross-surface pair", () => {
    test("v1 POST /api/ingest → v2 GET /api/v2/events shows a flattened brief with NO nested summary key", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const ingestRes = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        data: JUNIT_3CASE_1FAIL,
        agentId: "cross-v1-to-v2",
      });
      expect(ingestRes.status).toBe(200);

      const eventsRes = await getJson(`/api/v2/events?project=${pk}`);
      expect(eventsRes.status).toBe(200);
      const body = (await eventsRes.json()) as OkResponse & {
        events: Array<Record<string, unknown>>;
      };
      expect(body.ok).toBe(true);
      expect(body.events.length).toBe(1);
      const event = body.events[0]!;

      // §S0 flattened brief shape.
      expect(typeof event.id).toBe("string");
      expect(event.projectKey).toBe(pk);
      expect(event.agentId).toBe("cross-v1-to-v2");
      expect(event.kind).toBe("test");
      expect(event.codec).toBe("junit");
      expect(typeof event.timestamp).toBe("number");
      expect(event.total).toBe(3);
      expect(event.passed).toBe(2);
      expect(event.failed).toBe(1);
      expect(event.pending).toBe(0);
      expect(event.duration_ms).toBe(60);
      expect(typeof event.hasCoverage).toBe("boolean");
      expect("summary" in event).toBe(false);
    });

    test("v2 POST /api/v2/runs → v1 GET /api/events shows the SAME event with a nested summary object", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("cross-v2-to-v1");

      const ingestRes = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "cross-v2-to-v1-agent",
        codec: "junit",
        data: JUNIT_3CASE_1FAIL,
      });
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse & { event: string };

      const eventsRes = await getJson(`/api/events?projectKey=${key}`);
      expect(eventsRes.status).toBe(200);
      const body = (await eventsRes.json()) as OkResponse & {
        events: Array<{ id: string; summary?: unknown; [key: string]: unknown }>;
      };
      expect(body.ok).toBe(true);
      expect(body.events.length).toBe(1);
      const event = body.events[0]!;

      expect(event.id).toBe(ingestBody.event);
      expect(event.summary).toEqual({ total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 60 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // §S3 per-branch 400 assertions (gap-analysis file:line list)
  // ─────────────────────────────────────────────────────────────────────
  describe("§S3 per-branch 400 assertions", () => {
    // src/server.ts:108
    test("400: compile ingest without errors (v1 /api/ingest/compile)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const res = await postJson("/api/ingest/compile", { projectKey: pk, agentId: "a1" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("errors must be a non-empty string");
    });

    // src/v2.ts:369
    test("400: compile ingest without errors (v2 /api/v2/runs/compile)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("compile-v2-missing-errors");

      const res = await postJson("/api/v2/runs/compile", { projectKey: key, agentId: "a1" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("errors must be a non-empty string");
    });

    // src/server.ts:131
    test("400: parsed ingest without summary (v1 /api/ingest/parsed)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const res = await postJson("/api/ingest/parsed", { projectKey: pk, agentId: "a1", tree: [] });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("summary is required");
    });

    // src/server.ts:134
    test("400: parsed ingest without tree (v1 /api/ingest/parsed)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const res = await postJson("/api/ingest/parsed", {
        projectKey: pk,
        agentId: "a1",
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("tree is required");
    });

    // src/v2.ts:331
    test("400: parsed ingest without summary (v2 /api/v2/runs/parsed)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("parsed-v2-missing-summary");

      const res = await postJson("/api/v2/runs/parsed", { projectKey: key, agentId: "a1", tree: [] });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("summary is required");
    });

    // src/v2.ts:334
    test("400: parsed ingest without tree (v2 /api/v2/runs/parsed)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("parsed-v2-missing-tree");

      const res = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        agentId: "a1",
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("tree is required");
    });

    // src/server.ts:174
    test("400: ingest status missing projectKey query param (v1 GET /api/ingest/status)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/ingest/status");

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("projectKey query parameter is required");
    });

    // src/v2.ts:481
    test("400: status missing project query param (v2 GET /api/v2/status)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/status");

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("project query parameter is required");
    });

    // src/server.ts:203
    test("400: events delete missing eventId (v1 POST /api/events/delete)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const res = await postJson("/api/events/delete", { projectKey: pk });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("eventId is required");
    });

    // src/server.ts:263
    test("400: agentId missing (v1 POST /api/agents/heartbeat)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProjectV1();

      const res = await postJson("/api/agents/heartbeat", { projectKey: pk });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("agentId is required");
    });

    // src/server.ts:288
    test("400: agentId missing (v1 POST /api/agents/remove)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/agents/remove", {});

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("agentId is required");
    });

    // src/v2.ts:223
    test("400: agentId missing (v2 POST /api/v2/agents/register)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("agents-v2-register-missing-agentid");

      const res = await postJson("/api/v2/agents/register", { projectKey: key });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("agentId is required");
    });

    // src/v2.ts:248
    test("400: agentId missing (v2 POST /api/v2/agents/unregister)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProjectV2("agents-v2-unregister-missing-agentid");

      const res = await postJson("/api/v2/agents/unregister", { projectKey: key });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("agentId is required");
    });
  });
});
