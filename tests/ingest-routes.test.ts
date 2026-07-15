// CR-CRU-002 §S4 — Minimal ingest routes (the CR's production call path):
// POST /api/ingest {projectKey, format, data|dataPath, agentId}
// POST /api/ingest/compile {projectKey, agentId, errors, format?}
// Both extend the REAL production server (startServer) — not a hand-wired store.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

interface IngestOkResponse {
  ok: true;
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    duration_ms: number;
  };
}

interface CompileOkResponse {
  ok: true;
  summary: { failed: number; pending: number };
}

interface IngestErrResponse {
  ok: false;
  error: string;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ingest-route-"));
}

// 3-case junit: 2 pass (times 0.01/0.02) + 1 fail w/ message="boom" (time 0.03).
// summary => {total:3, passed:2, failed:1, pending:0, duration_ms:60}
const JUNIT_INLINE_3CASE = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

// rustc fixture per CR §S2 AC4: 1 error[E0308] block + 1 plain warning block.
const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

describe("POST /api/ingest + POST /api/ingest/compile — §S4", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let tmpDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  function seedProject(): string {
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

  test("inline junit data → 200 {ok:true, summary}; newest event carries kind/codec/agentId and preserves failure.message", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProject();

    const res = await postJson("/api/ingest", {
      projectKey: pk,
      format: "junit",
      data: JUNIT_INLINE_3CASE,
      agentId: "red-1",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestOkResponse;
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      pending: 0,
      duration_ms: 60,
    });

    const newest = handle.store.listEvents(pk)[0];
    expect(newest).toBeDefined();
    expect(newest!.kind).toBe("test");
    expect(newest!.codec).toBe("junit");
    expect(newest!.agentId).toBe("red-1");

    const failedLeaf = newest!.tree?.flatMap((s) => s.children).find((c) => c.status === "fail");
    expect(failedLeaf?.failure?.message).toBe("boom");
  });

  test("dataPath pointing at a temp dir containing TEST-a.xml (2 pass) → 200 with summary.total 2", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProject();

    const dir = freshDir();
    tmpDirs.push(dir);
    const xmlA = [
      '<testsuite name="SuiteA" tests="2">',
      '<testcase name="a1" time="0.1"/>',
      '<testcase name="a2" time="0.1"/>',
      "</testsuite>",
    ].join("\n");
    writeFileSync(join(dir, "TEST-a.xml"), xmlA);

    const res = await postJson("/api/ingest", {
      projectKey: pk,
      format: "junit",
      dataPath: dir,
      agentId: "dp-1",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestOkResponse;
    expect(body.ok).toBe(true);
    expect(body.summary.total).toBe(2);
  });

  describe("validation", () => {
    test("non-UUID projectKey → 400 {ok:false, error} mentioning UUID", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/ingest", {
        projectKey: "not-a-uuid",
        format: "junit",
        data: JUNIT_INLINE_3CASE,
        agentId: "a1",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toContain("uuid");
    });

    test("unknown-but-valid UUID → 404 {ok:false, error}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/ingest", {
        projectKey: crypto.randomUUID(),
        format: "junit",
        data: JUNIT_INLINE_3CASE,
        agentId: "a1",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    test("unsupported format 'tap' → 400 {ok:false, error}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "tap",
        data: "whatever",
        agentId: "a1",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
    });

    test("neither data nor dataPath → 400 {ok:false, error}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        agentId: "a1",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
    });

    test("malformed junit `data` → 400 JSON {ok:false, error}, never a plain-text 500", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        data: "<not-junit>",
        agentId: "a1",
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });

    test("nonexistent dataPath → 400 JSON {ok:false, error}, never a plain-text 500", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        dataPath: join(tmpdir(), "ingest-route-definitely-missing"),
        agentId: "a1",
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as IngestErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });
  });

  test("POST /api/ingest/compile — rustc fixture → 200 {ok:true, summary:{failed:1, pending:1}}; newest event kind=compile codec=rustc", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProject();

    const res = await postJson("/api/ingest/compile", {
      projectKey: pk,
      agentId: "green-1",
      errors: RUSTC_ERRORS,
      format: "rustc",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as CompileOkResponse;
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ failed: 1, pending: 1 });

    const newest = handle.store.listEvents(pk)[0];
    expect(newest).toBeDefined();
    expect(newest!.kind).toBe("compile");
    expect(newest!.codec).toBe("rustc");
  });

  test("ingest is an implicit heartbeat: after a junit ingest, listAgents(pk) contains the ingesting agent", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProject();

    const res = await postJson("/api/ingest", {
      projectKey: pk,
      format: "junit",
      data: JUNIT_INLINE_3CASE,
      agentId: "red-1",
    });
    expect(res.status).toBe(200);

    const agents = handle.store.listAgents(pk);
    expect(agents.some((a) => a.agentId === "red-1")).toBe(true);
  });
});
