// RETIRED-CONTRACT ARCHIVE — CR-CRU-008 §S4 addendum, 2026-07-17. This file
// collects individual describe/test SECTIONS whose actual SUBJECT was the
// v1 shim, extracted out of otherwise-still-live suites once the shim
// retired (as opposed to whole-file archives like v1-contract.test.ts,
// shim-ingest-events.test.ts, shim-projects-agents.test.ts). Moved here and
// excluded from `bun test` (see bunfig.toml [test].pathIgnorePatterns).
// Kept for historical reference only — do not resurrect without a new CR
// reintroducing the legacy `/api/*` routes.
//
// Provenance per section, so a future reader can find the live sibling (if
// any) that continues to cover the same ground on v2:
//   1. tests/ingest-routes.test.ts (CR-CRU-002 §S4) — the ENTIRE file moved;
//      its subject was POST /api/ingest + POST /api/ingest/compile
//      themselves. The equivalent v2 coverage already lives in
//      tests/v2-runs-events.test.ts (dataPath/malformed-data/rustc-compile
//      cases).
//   2. tests/cross-surface-400s.test.ts §S2 "cross-surface pair" (CR-CRU-010
//      §S2) — both tests asserted a v1-write/v2-read (or v2-write/v1-read)
//      shape pairing; the pairing itself no longer exists once v1 retires.
//   3. tests/cross-surface-400s.test.ts §S3 v1-route branches (CR-CRU-010
//      §S3) — each asserted ONE v1 route's own missing-field 400. The
//      parallel v2-route branches (same file) stay live and cover the
//      shared src/v2.ts validation logic going forward.
//   4. tests/codec-parsepath.test.ts (CR-CRU-010 §S1) — the v1
//      POST /api/ingest instance of the parsePath-missing-codec 400; the
//      v2 POST /api/v2/runs sibling (same file) already covers the shared
//      parseRunBody/registry logic.
//   5. tests/v2-brief-reshape.test.ts (CR-CRU-006 §S0) — "v1 GET
//      /api/events items still carry nested summary" pinned the v1 shim's
//      OWN response shape directly.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server.ts";
import { codecs } from "../../src/codecs/index.ts";
import type { Coverage, RunSchema } from "../../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. tests/ingest-routes.test.ts (whole file) — CR-CRU-002 §S4
// ═══════════════════════════════════════════════════════════════════════
describe("[ARCHIVED] POST /api/ingest + POST /api/ingest/compile — §S4 (was tests/ingest-routes.test.ts)", () => {
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

// ═══════════════════════════════════════════════════════════════════════
// 2. tests/cross-surface-400s.test.ts §S2 "cross-surface pair" — CR-CRU-010 §S2
// ═══════════════════════════════════════════════════════════════════════
describe("[ARCHIVED] §S2 cross-surface pair (was tests/cross-surface-400s.test.ts)", () => {
  const JUNIT_3CASE_1FAIL = [
    '<testsuite name="Suite1" tests="3">',
    '<testcase name="t1" time="0.01"/>',
    '<testcase name="t2" time="0.02"/>',
    '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
    "</testsuite>",
  ].join("\n");

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

// ═══════════════════════════════════════════════════════════════════════
// 3. tests/cross-surface-400s.test.ts §S3 v1-route branches — CR-CRU-010 §S3
// ═══════════════════════════════════════════════════════════════════════
describe("[ARCHIVED] §S3 per-branch 400 assertions — v1 routes (was tests/cross-surface-400s.test.ts)", () => {
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

  // src/server.ts:174
  test("400: ingest status missing projectKey query param (v1 GET /api/ingest/status)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await getJson("/api/ingest/status");

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("projectKey query parameter is required");
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
});

// ═══════════════════════════════════════════════════════════════════════
// 4. tests/codec-parsepath.test.ts (v1 instance) — CR-CRU-010 §S1
// ═══════════════════════════════════════════════════════════════════════
describe("[ARCHIVED] Codec.parsePath — v1 dataPath 400 naming the codec (was tests/codec-parsepath.test.ts)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let tmpDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
    codecs.delete("stub-nopath");
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

  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "codec-parsepath-"));
  }

  const JUNIT_2CASE_ALLPASS = [
    '<testsuite name="SuiteA" tests="2">',
    '<testcase name="a1" time="0.1"/>',
    '<testcase name="a2" time="0.1"/>',
    "</testsuite>",
  ].join("\n");

  test("400: dataPath request through a codec without parsePath names the codec (v1 POST /api/ingest)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProjectV1();
    const dir = freshDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "TEST-a.xml"), JUNIT_2CASE_ALLPASS);

    codecs.set("stub-nopath", { parse: (data: string) => JSON.parse(data) as RunSchema });

    const res = await postJson("/api/ingest", {
      projectKey: pk,
      format: "stub-nopath",
      dataPath: dir,
      agentId: "a1",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("stub-nopath");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. tests/v2-brief-reshape.test.ts (v1 instance) — CR-CRU-006 §S0
// ═══════════════════════════════════════════════════════════════════════
describe("[ARCHIVED] v1 GET /api/events items still carry nested summary (was tests/v2-brief-reshape.test.ts)", () => {
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

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function seedCoveredTestEvent(key: string): Promise<string> {
    const coverage: Coverage = { lines: { total: 10, covered: 8, percent: 80 } };
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cov-agent",
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 120 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 50 }] }],
      coverage,
    });
    const body = (await res.json()) as OkResponse & { event: string };
    expect(res.status).toBe(200);
    return body.event;
  }

  test("v1 GET /api/events items still carry nested summary (contract-locked, untouched by §S0)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-v1-contract");
    await seedCoveredTestEvent(key);

    const res = await getJson(`/api/events?projectKey=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & {
      events: Array<{ id: string; summary?: unknown; [key: string]: unknown }>;
    };
    expect(body.ok).toBe(true);
    expect(body.events.length).toBe(1);
    expect(body.events[0]?.summary).toEqual({
      total: 5,
      passed: 5,
      failed: 0,
      pending: 0,
      duration_ms: 120,
    });
  });
});
