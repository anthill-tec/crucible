// CR-CRU-004 §S1 (runs/events/status routes) + §S2 (run context, graceful) +
// §S5 (every write reports changed:true|false) — v2 API: raw junit ingest,
// parsed ingest w/ context, compile ingest, events list/get/delete, status.
// Drives the REAL production server (startServer) — the /api/v2/runs*,
// /api/v2/events*, /api/v2/status routes do not exist in src/v2.ts yet
// (RED phase), so they currently 404 through src/server.ts's catch-all
// until GREEN wires handleV2 to dispatch them.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { Coverage, RunContext, RunSummary, SuiteNode } from "../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface RunsPostResponse extends OkResponse {
  changed: boolean;
  event: string;
  verdict: string;
  run?: unknown;
}

interface CompileRunResponse extends OkResponse {
  changed: boolean;
  event: string;
  errors: number;
  warnings: number;
  verdict: string;
}

interface EventGetResponse extends OkResponse {
  event: {
    id: string;
    tier?: string;
    context?: RunContext;
    tree?: SuiteNode[];
    coverage?: Coverage;
    [key: string]: unknown;
  };
}

interface EventsListResponse extends OkResponse {
  events: Array<{ id: string; timestamp: number; [key: string]: unknown }>;
}

interface StatusResponse extends OkResponse {
  status: {
    hasData: boolean;
    lastTest: unknown;
    lastCompile: unknown;
  };
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "v2-runs-route-"));
}

// 3-case junit: 2 pass + 1 fail w/ message="boom" — matches ingest-routes.test.ts fixture.
// summary => {total:3, passed:2, failed:1, pending:0, duration_ms:60}
const JUNIT_3CASE_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

// 3-case junit, all pass — for the GREEN-verdict path.
const JUNIT_3CASE_ALLPASS = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"/>',
  "</testsuite>",
].join("\n");

// rustc fixture per CR §S2 AC4: 1 error[E0308] block + 1 plain warning block
// (same fixture as tests/ingest-routes.test.ts).
const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

describe("v2 API — runs, events, status (CR-CRU-004 §S1+§S2+§S5)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let tmpDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
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

  async function deleteJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, { method: "DELETE" });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  function parsedRunBody(overrides: {
    projectKey: string;
    agentId?: string;
    summary?: Partial<RunSummary>;
    coverage?: Coverage;
    tier?: string;
    context?: RunContext;
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
      ...(overrides.tier !== undefined ? { tier: overrides.tier } : {}),
      ...(overrides.coverage !== undefined ? { coverage: overrides.coverage } : {}),
      ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    };
  }

  // ---------------------------------------------------------------------
  // §S1 POST /api/v2/runs — raw codec ingest
  // ---------------------------------------------------------------------
  describe("POST /api/v2/runs", () => {
    test("junit data w/ 1 failing case → 200 {ok:true, changed:true, event:'evt-…', verdict starting 'RED'}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-red");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "red-1",
        codec: "junit",
        data: JUNIT_3CASE_1FAIL,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(body.event).toMatch(/^evt-/);
      expect(body.verdict.startsWith("RED")).toBe(true);
      expect(body.run).toBeDefined();

      // Observable effect: a real event landed in the store with the right summary.
      const stored = handle.store.getEvent(body.event);
      expect(stored?.summary).toEqual({ total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 60 });
    });

    test("junit data, all pass → verdict starting 'GREEN'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-green");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "green-1",
        codec: "junit",
        data: JUNIT_3CASE_ALLPASS,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      expect(body.verdict.startsWith("GREEN")).toBe(true);

      const stored = handle.store.getEvent(body.event);
      expect(stored?.summary?.failed).toBe(0);
    });

    test("dataPath variant: temp dir with TEST-a.xml (all pass) → 200, verdict starting 'GREEN'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-datapath");
      const dir = freshDir();
      tmpDirs.push(dir);
      const xmlA = [
        '<testsuite name="SuiteA" tests="2">',
        '<testcase name="a1" time="0.1"/>',
        '<testcase name="a2" time="0.1"/>',
        "</testsuite>",
      ].join("\n");
      writeFileSync(join(dir, "TEST-a.xml"), xmlA);

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "dp-1",
        codec: "junit",
        dataPath: dir,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      expect(body.verdict.startsWith("GREEN")).toBe(true);
      const stored = handle.store.getEvent(body.event);
      expect(stored?.summary?.total).toBe(2);
    });

    test("unknown codec → 400 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-badcodec");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "a1",
        codec: "not-a-real-codec",
        data: "whatever",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("malformed junit data → 400 JSON {ok:false, error}, never a plain-text 500", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-badxml");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "a1",
        codec: "junit",
        data: "<not-junit>",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });

    test("nonexistent dataPath → 400 JSON {ok:false, error}, never a plain-text 500", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("runs-baddatapath");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "a1",
        codec: "junit",
        dataPath: join(tmpdir(), "v2-runs-definitely-missing"),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });

    test("unknown project → 404 with help array present", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/runs", {
        projectKey: crypto.randomUUID(),
        agentId: "a1",
        codec: "junit",
        data: JUNIT_3CASE_1FAIL,
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse & { help?: unknown };
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect(isNonEmptyStringArray(body.help)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // §S1+§S2 POST /api/v2/runs/parsed — parsed ingest + run context
  // ---------------------------------------------------------------------
  describe("POST /api/v2/runs/parsed", () => {
    test("with context {git, wave, orchestrator} + tier:'regression' → 200 {ok:true, changed:true, event, verdict}; GET events/:id echoes context deep-equal + tier", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("parsed-context");
      const context: RunContext = {
        git: { branch: "develop", commit: "abc123" },
        wave: "w1",
        orchestrator: "track-2",
      };

      const res = await postJson(
        "/api/v2/runs/parsed",
        parsedRunBody({ projectKey: key, agentId: "ctx-agent", tier: "regression", context }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(body.event).toMatch(/^evt-/);
      expect(typeof body.verdict).toBe("string");

      const getRes = await getJson(`/api/v2/events/${body.event}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as EventGetResponse;
      expect(getBody.ok).toBe(true);
      expect(getBody.event.context).toEqual(context);
      expect(getBody.event.tier).toBe("regression");
    });

    test("with NO context → 200 ok; the stored event has NO context key at all (graceful — no fabrication)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("parsed-no-context");

      const res = await postJson(
        "/api/v2/runs/parsed",
        parsedRunBody({ projectKey: key, agentId: "no-ctx-agent" }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);

      const stored = handle.store.getEvent(body.event);
      expect(stored).not.toBeNull();
      expect("context" in (stored as object)).toBe(false);

      const getRes = await getJson(`/api/v2/events/${body.event}`);
      const getBody = (await getRes.json()) as EventGetResponse;
      expect("context" in getBody.event).toBe(false);
    });

    test("coverage discard-on-fail: failing summary + coverage → the stored event has no coverage key (help mention of DISCARDED is optional)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("parsed-discard-coverage");
      const coverage: Coverage = { lines: { total: 10, covered: 8, percent: 80 } };

      const res = await postJson(
        "/api/v2/runs/parsed",
        parsedRunBody({
          projectKey: key,
          agentId: "discard-agent",
          summary: { failed: 1, passed: 4 },
          coverage,
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse & { help?: unknown };
      expect(body.ok).toBe(true);

      // Stored-event fact is the required assertion; a help[] hint mentioning
      // "DISCARDED" is optional per the CR's discard-on-fail note.
      const stored = handle.store.getEvent(body.event);
      expect(stored).not.toBeNull();
      expect(stored?.coverage === undefined).toBe(true);
      if (body.help !== undefined) {
        expect(isNonEmptyStringArray(body.help)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------
  // §S1 POST /api/v2/runs/compile
  // ---------------------------------------------------------------------
  describe("POST /api/v2/runs/compile", () => {
    test("rustc fixture (1 error, 1 warning) → 200 {ok:true, changed:true, event, errors:1, warnings:1, verdict containing 'COMPILE'}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("compile-run");

      const res = await postJson("/api/v2/runs/compile", {
        projectKey: key,
        agentId: "compile-agent",
        errors: RUSTC_ERRORS,
        format: "rustc",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CompileRunResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(body.event).toMatch(/^evt-/);
      expect(body.errors).toBe(1);
      expect(body.warnings).toBe(1);
      expect(body.verdict).toContain("COMPILE");

      const stored = handle.store.getEvent(body.event);
      expect(stored?.kind).toBe("compile");
    });

    test("missing errors field → 400 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("compile-missing-errors");

      const res = await postJson("/api/v2/runs/compile", {
        projectKey: key,
        agentId: "a1",
        format: "rustc",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // §S1 GET /api/v2/events + GET/DELETE /api/v2/events/:id
  // ---------------------------------------------------------------------
  describe("GET /api/v2/events + GET/DELETE /api/v2/events/:id", () => {
    async function seedThreeEvents(key: string): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await postJson(
          "/api/v2/runs/parsed",
          parsedRunBody({ projectKey: key, agentId: "seed-agent", summary: { total: i + 1 } }),
        );
        const body = (await res.json()) as RunsPostResponse;
        ids.push(body.event);
        // Bun's event ids are epoch-ms based — force distinct timestamps for
        // a stable newest-first ordering assertion.
        Bun.sleepSync(2);
      }
      return ids;
    }

    test("GET /api/v2/events?project=<key>&limit=2 → {ok:true, events} 2 newest, newest-first", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-list");
      const ids = await seedThreeEvents(key);

      const res = await getJson(`/api/v2/events?project=${key}&limit=2`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as EventsListResponse;
      expect(body.ok).toBe(true);
      expect(body.events.length).toBe(2);
      expect(body.events[0]?.id).toBe(ids[2]);
      expect(body.events[1]?.id).toBe(ids[1]);
    });

    test("GET /api/v2/events/:id → {ok:true, event} full detail (tree present)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-get");
      const [id] = await seedThreeEvents(key);

      const res = await getJson(`/api/v2/events/${id}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as EventGetResponse;
      expect(body.ok).toBe(true);
      expect(body.event.id).toBe(id);
      expect(Array.isArray(body.event.tree)).toBe(true);
      expect((body.event.tree as SuiteNode[]).length).toBeGreaterThan(0);
    });

    test("GET /api/v2/events/:id — unknown id → 404 {ok:false} with an event-specific error (not the generic route catch-all)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/events/evt-0000000000000-9999");

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      // Distinguishes a real "event not found" 404 from the pre-existing
      // generic `unknown route: ...` catch-all in src/server.ts — a stub
      // that never wires this route must NOT satisfy this assertion.
      expect(body.error.toLowerCase()).not.toContain("unknown route");
      expect(body.error.toLowerCase()).toContain("event");
    });

    test("DELETE /api/v2/events/:id?project=<key> → {ok:true, changed:true}; repeat → 404 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-delete");
      const [id] = await seedThreeEvents(key);

      const first = await deleteJson(`/api/v2/events/${id}?project=${key}`);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as OkResponse;
      expect(firstBody.ok).toBe(true);
      expect(firstBody.changed).toBe(true);
      expect(handle.store.getEvent(id!)).toBeNull();

      const second = await deleteJson(`/api/v2/events/${id}?project=${key}`);
      expect(second.status).toBe(404);
      const secondBody = (await second.json()) as ErrResponse;
      expect(secondBody.ok).toBe(false);
    });

    test("DELETE /api/v2/events/:id?project=<wrong-key> → 404 and the event still exists", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-delete-wrongproj");
      const otherKey = await createProject("events-delete-otherproj");
      const [id] = await seedThreeEvents(key);

      const res = await deleteJson(`/api/v2/events/${id}?project=${otherKey}`);

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(handle.store.getEvent(id!)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // §S1 GET /api/v2/status
  // ---------------------------------------------------------------------
  describe("GET /api/v2/status", () => {
    test("?project=<key> → {ok:true, status:{hasData, lastTest, lastCompile}}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("status-p");

      const runRes = await postJson(
        "/api/v2/runs/parsed",
        parsedRunBody({ projectKey: key, agentId: "status-agent" }),
      );
      const runBody = (await runRes.json()) as RunsPostResponse;

      const res = await getJson(`/api/v2/status?project=${key}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as StatusResponse;
      expect(body.ok).toBe(true);
      expect(body.status.hasData).toBe(true);
      expect(body.status.lastTest).not.toBeNull();
      expect(body.status.lastCompile).toBeNull();
      expect((body.status.lastTest as { id: string }).id).toBe(runBody.event);
    });

    test("missing project query param → 400 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/status");

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });
  });
});
