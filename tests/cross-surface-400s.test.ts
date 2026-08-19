// CR-CRU-010 §S2+§S3 — cross-surface regression hardening.
//
// §S3: one NAMED assertion per missing-required-field validation branch
// across v2 (src/v2.ts), each asserting HTTP 400 and the EXACT `error`
// string naming the field, per the CR's gap-analysis file:line list. These
// branches already exist in production today — they are expected to PASS
// immediately (regression-guarding existing behavior, not new behavior).
// Any failure here is a real defect, not something to "fix" by loosening
// the assertion.
//
// CR-CRU-008 §S4 modernization note: the original §S2 "cross-surface pair"
// describe (proving the v1 shim and v2 API stayed consistent about the SAME
// stored event) and the six v1-route §S3 branches (compile/parsed-summary/
// parsed-tree/ingest-status/events-delete/agents-heartbeat/agents-remove)
// had the v1 shim itself as their SUBJECT — moved wholesale to
// tests/archive/v1-sections.test.ts on shim retirement. The v2-route §S3
// branches below are unaffected and stay in place.
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
  // §S2 cross-surface pair — CR-CRU-008 §S4: BOTH tests here had the v1
  // surface as their actual SUBJECT (one asserted a v1-written event's v2
  // read shape, the other asserted a v2-written event's v1 read shape) —
  // moved wholesale to tests/archive/v1-sections.test.ts on shim retirement.
  // ─────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────
  // §S3 per-branch 400 assertions (gap-analysis file:line list)
  // CR-CRU-008 §S4: the v1-route branches (compile/parsed-summary/
  // parsed-tree/ingest-status/events-delete/agents-heartbeat/agents-remove)
  // moved to tests/archive/v1-sections.test.ts on shim retirement — their
  // SUBJECT was each v1 route's own validation branch, not incidental
  // seeding. The v2 counterparts below (already covering the same
  // src/v2.ts branches) stay in place unchanged.
  // ─────────────────────────────────────────────────────────────────────
  describe("§S3 per-branch 400 assertions", () => {
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

    // src/v2.ts:481
    test("400: status missing project query param (v2 GET /api/v2/status)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/status");

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("project query parameter is required");
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
