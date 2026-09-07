// CR-CRU-004 §S1 (runs/events/status routes) + §S2 (run context, graceful) +
// §S5 (every write reports changed:true|false) — v2 API: raw junit ingest,
// parsed ingest w/ context, compile ingest, events list/get/delete, status.
// Drives the REAL production server (startServer) — the /api/v2/runs*,
// /api/v2/events*, /api/v2/status routes do not exist in src/v2.ts yet
// (RED phase), so they currently 404 through src/server.ts's catch-all
// until GREEN wires handleV2 to dispatch them.
import { describe, test, expect, afterEach } from "bun:test";
// CR-CRU-094 §S1/AC1 — the column is read STRAIGHT OUT OF THE STORE FILE by a
// second connection, the way tests/store-migration.test.ts's `columnsOf` /
// `rowCounts` already inspect a store; nothing else in this file needs sqlite.
import { Database } from "bun:sqlite";
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

// 3-case junit: 2 pass + 1 fail w/ message="boom". Originally copied from the
// v1 `ingest-routes.test.ts` fixture — that file was deleted by CR-CRU-008's
// C7 v1-retirement sweep (`5193768`), so THIS is now the canonical copy.
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
// (originally the same fixture as the v1 `tests/ingest-routes.test.ts`, deleted
// by CR-CRU-008's C7 v1-retirement sweep — history, not a live sibling).
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

  // CR-CRU-008 §S4 — guarded run deletion: DELETE now carries an optional
  // {userApproved} body (the approval gate); a caller with none gets the
  // codebase's uniform empty-body treatment.
  async function deleteJson(path: string, body?: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs, /api/v2/runs/parsed,
  // and /api/v2/runs/compile now refuse an unregistered agentId (409) — each
  // distinct agentId these fixtures ingest under must be live registered
  // first (the pre-existing 400/404 validation-error pins that fire before
  // any registered-caller check — unknown codec, malformed data, unknown
  // project, missing fields — are untouched; only the calls that expect a
  // 2xx ingest to actually succeed need this).
  async function registerAgent(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
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
      await registerAgent(key, "red-1");

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
      await registerAgent(key, "green-1");

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
      await registerAgent(key, "dp-1");

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
      await registerAgent(key, "ctx-agent");

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
      await registerAgent(key, "no-ctx-agent");

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
      await registerAgent(key, "discard-agent");

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
      await registerAgent(key, "compile-agent");

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
      await registerAgent(key, "seed-agent");
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

    // CR-CRU-008 §S4 — spec-superseded re-pin: single-event DELETE is now
    // DOUBLE-GATED (project's allowRunDeletion config AND a per-call
    // userApproved:true), replacing the old unconditional-delete contract.
    // 403 without config, 409 without approval, 200 only with both; a
    // repeat delete (both gates still open) then 404s on the now-gone event.
    test("DELETE /api/v2/events/:id?project=<key>: 403 without allowRunDeletion; 409 with config ON but no userApproved; 200 with both gates open (changed:true, event gone); repeat → 404 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-delete");
      const [id] = await seedThreeEvents(key);

      // Gate 1 — config off.
      const configOff = await deleteJson(`/api/v2/events/${id}?project=${key}`, {
        userApproved: true,
      });
      expect(configOff.status).toBe(403);
      const configOffBody = (await configOff.json()) as ErrResponse;
      expect(configOffBody.ok).toBe(false);
      expect(handle.store.getEvent(id!)).not.toBeNull();

      // Gate 2 — config on, approval missing.
      const patchRes = await patchJson(`/api/v2/projects/${key}`, { allowRunDeletion: true });
      expect(patchRes.status).toBe(200);
      const approvalMissing = await deleteJson(`/api/v2/events/${id}?project=${key}`, {});
      expect(approvalMissing.status).toBe(409);
      const approvalMissingBody = (await approvalMissing.json()) as ErrResponse;
      expect(approvalMissingBody.ok).toBe(false);
      expect(handle.store.getEvent(id!)).not.toBeNull();

      // Both gates open.
      const first = await deleteJson(`/api/v2/events/${id}?project=${key}`, {
        userApproved: true,
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as OkResponse;
      expect(firstBody.ok).toBe(true);
      expect(firstBody.changed).toBe(true);
      expect(handle.store.getEvent(id!)).toBeNull();

      // Repeat — same (open) gates, event already gone → 404.
      const second = await deleteJson(`/api/v2/events/${id}?project=${key}`, {
        userApproved: true,
      });
      expect(second.status).toBe(404);
      const secondBody = (await second.json()) as ErrResponse;
      expect(secondBody.ok).toBe(false);
    });

    // CR-CRU-008 §S4 — spec-superseded re-pin: the wrong-project 404 is only
    // reachable once BOTH gates are open on the (wrong) project doing the
    // calling — otherwise the config/approval gate would fire first and mask
    // the ownership check this test actually pins.
    test("DELETE /api/v2/events/:id?project=<wrong-key>, both gates open on wrong-key → 404 and the event still exists", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-delete-wrongproj");
      const otherKey = await createProject("events-delete-otherproj");
      const [id] = await seedThreeEvents(key);
      const patchRes = await patchJson(`/api/v2/projects/${otherKey}`, { allowRunDeletion: true });
      expect(patchRes.status).toBe(200);

      const res = await deleteJson(`/api/v2/events/${id}?project=${otherKey}`, {
        userApproved: true,
      });

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
      await registerAgent(key, "status-agent");

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

// ───────────────────────────────────────────────────────────────────────────
// CR-CRU-094 §S1/AC1 — THE CYCLE BINDING RIDES THE RUN, AS A COLUMN.
//
// RED. Re-verified against production on 2026-09-07: `createBaseTables`'s
// `CREATE TABLE IF NOT EXISTS events` block has no `cycle_id`, and `eventBrief`
// projects no top-level `cycleId` — it passes `context` through verbatim and
// stops there. Every assertion below fails for that one reason.
//
// WHY THE COLUMN IS READ OUT OF THE SQLITE FILE AND NOT OFF THE RESPONSE: a
// fixture asserting only `context.cycleId` passes TODAY — CR-CRU-056 §S3 has
// stamped the blob since it merged — and therefore proves nothing about this
// CR. So this block's store is FILE-BACKED, not `:memory:`, and a second
// read-only connection reads the row back, the same "open the store file and
// inspect it raw" approach tests/store-migration.test.ts's `columnsOf` /
// `rowCounts` established.
//
// ONE SEAM, NOT TWO. §S1 pins the stamp at `resolveIngestAttach`'s return, and
// the gates route calls that same function. A test cannot observe "there is
// only ONE write site" — absence of a second site is not an observable. What
// it CAN observe is the property that makes the single seam worth having:
// BOTH STAMPED SURFACES AGREE, a run and a gate posted by the same bound agent
// carrying the same column, with the gate route gaining no write of its own.
// That is how the last AC1 test below is written, deliberately.
const SYNTHETIC_CR = "CR-AUTH-1";

describe("CR-CRU-094 §S1/AC1 — the cycle binding rides the run as a column", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let dbPath = "";
  let dirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** A REAL server on a REAL store file — `:memory:` has no file to read. */
  function boot(): void {
    const dir = freshDir();
    dirs.push(dir);
    dbPath = join(dir, "crucible.db");
    handle = startServer({ port: 0, dbPath });
  }

  async function send(method: string, path_: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path_}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function newProject(): Promise<string> {
    const res = await send("POST", "/api/v2/projects", { name: `cyc-${crypto.randomUUID()}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  /** `register --agent <id> --role <r> [--cycle <n>]`, over the real route. */
  async function register(
    key: string,
    agentId: string,
    role: string,
    cycleId?: number,
  ): Promise<void> {
    const res = await send("POST", "/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role,
      ...(cycleId !== undefined ? { cycleId } : {}),
    });
    expect(res.status).toBe(200);
  }

  /** Files a one-cycle plan and activates it, through the real plans API. */
  async function activeCycle(key: string): Promise<number> {
    await register(key, "fixture-orch", "ORCHESTRATOR");
    const filed = await send("POST", `/api/v2/projects/${key}/plans`, {
      agentId: "fixture-orch",
      cr: SYNTHETIC_CR,
      cycles: [{ label: "solo" }],
    });
    expect(filed.status).toBe(201);
    const plan = (await filed.json()) as { planId: number; cycles: Array<{ id: number }> };
    const cycleId = plan.cycles[0]!.id;
    const activated = await send(
      "PATCH",
      `/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
      { agentId: "fixture-orch", status: "active" },
    );
    expect(activated.status).toBe(200);
    return cycleId;
  }

  /** A parsed run ingested with NO explicit context — the binding is the
   *  server's to resolve, which is the case §S1 is about. */
  async function ingestRun(key: string, agentId: string): Promise<string> {
    const res = await send("POST", "/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      summary: { total: 4, passed: 4, failed: 0, pending: 0, duration_ms: 80 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass" }] }],
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as RunsPostResponse).event;
  }

  /** The SECOND stamped surface, same seam. */
  async function ingestGate(key: string, agentId: string): Promise<string> {
    const res = await send("POST", "/api/v2/gates", {
      projectKey: key,
      agentId,
      gate: { intent: "merge gate", outcome: "passed", steps: [{ name: "tests", status: "passed" }] },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as OkResponse & { event: string }).event;
  }

  async function briefOf(key: string, eventId: string): Promise<Record<string, unknown>> {
    const res = await fetch(
      `http://localhost:${handle!.server.port}/api/v2/events?project=${key}&limit=100`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    const brief = body.events.find((e) => e.id === eventId);
    if (brief === undefined) throw new Error(`event ${eventId} is absent from the feed`);
    return brief;
  }

  function eventsColumns(): string[] {
    const db = new Database(dbPath);
    try {
      return db
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .map((c) => c.name);
    } finally {
      db.close();
    }
  }

  /** The stored binding, read out of the FILE. Fails with the MISSING
   *  CONTRACT rather than a bare `no such column` SQLite error. */
  function storedCycleId(eventId: string): number | null {
    if (!eventsColumns().includes("cycle_id")) {
      throw new Error(
        "CR-CRU-094 §S1/AC1: `events` has no `cycle_id` column — the binding is not on the run",
      );
    }
    const db = new Database(dbPath);
    try {
      const row = db
        .query<{ cycle_id: number | null }, [string]>(
          "SELECT cycle_id FROM events WHERE id = ?",
        )
        .get(eventId);
      if (row === null) throw new Error(`no events row for ${eventId}`);
      return row.cycle_id;
    } finally {
      db.close();
    }
  }

  /** Which RUN rows carry a given binding — bounded, so a stamp that leaks
   *  onto rows it never resolved fails instead of passing wider. Scoped to
   *  `kind = 'test'` because §S2 (a LATER cycle) will stamp lifecycle rows
   *  too, and that must not retro-break this AC. */
  function runRowsBoundTo(cycleId: number): string[] {
    if (!eventsColumns().includes("cycle_id")) {
      throw new Error(
        "CR-CRU-094 §S1/AC1: `events` has no `cycle_id` column — the binding is not on the run",
      );
    }
    const db = new Database(dbPath);
    try {
      return db
        .query<{ id: string }, [number]>(
          "SELECT id FROM events WHERE kind = 'test' AND cycle_id = ? ORDER BY id",
        )
        .all(cycleId)
        .map((r) => r.id);
    } finally {
      db.close();
    }
  }

  test("AC1 — a run ingested by an agent registered `--cycle N` carries cycle_id = N in the store FILE", async () => {
    boot();
    const key = await newProject();
    const cycleId = await activeCycle(key);
    await register(key, "bound-red", "RED", cycleId);

    const eventId = await ingestRun(key, "bound-red");

    expect(storedCycleId(eventId)).toBe(cycleId);
    // Bounded: EXACTLY this run, not "at least one". A stamp applied to every
    // row of the project would satisfy a `>= 1` count and fail here.
    expect(runRowsBoundTo(cycleId)).toEqual([eventId]);
  });

  test("AC1 — the API projects a TOP-LEVEL cycleId on that run, beside an UNTOUCHED context passthrough", async () => {
    boot();
    const key = await newProject();
    const cycleId = await activeCycle(key);
    await register(key, "bound-green", "GREEN", cycleId);
    const eventId = await ingestRun(key, "bound-green");

    const brief = await briefOf(key, eventId);

    // The reader can tell a bound run from an unbound one without unpacking a
    // blob — which is the whole observable §S1 exists to add.
    expect(brief.cycleId).toBe(cycleId);
    // AC3 at the wire, for consumer #1: `public/app.js`'s `linkedRunsFor`,
    // `runningRunsFor` and the runFeed card filter all read `e.context?.cycleId`
    // off exactly this payload. The column must not DISPLACE the blob — §S1
    // keeps `context` authoritative for the frontend on purpose.
    expect(brief.context).toEqual({ cycleId });
  });

  test("AC1 — an UNBOUND caller's run projects NO cycleId key at all: absent, never null and never 0", async () => {
    boot();
    const key = await newProject();
    await register(key, "unbound-orch", "ORCHESTRATOR");

    const eventId = await ingestRun(key, "unbound-orch");
    const brief = await briefOf(key, eventId);

    // ABSENT, matching the additive convention `eventBrief` already uses for
    // `action` / `firstSeen` / `role` / `gate` / `version`. A truthiness check
    // would pass on `null` and on `0`; this one cannot.
    expect("cycleId" in brief).toBe(false);
    expect(brief.context).toBeUndefined();
    // ... and the column agrees: nullable, unset, never a placeholder 0.
    expect(storedCycleId(eventId)).toBeNull();
  });

  test("AC1 — BOTH stamped surfaces agree: a gate from the same bound agent carries the same column", async () => {
    boot();
    const key = await newProject();
    const cycleId = await activeCycle(key);
    await register(key, "bound-verify", "VERIFY", cycleId);

    const runId = await ingestRun(key, "bound-verify");
    const gateId = await ingestGate(key, "bound-verify");

    // The gates route adds no stamping of its own; it calls the SAME
    // `resolveIngestAttach`. If the column were written at the run route
    // instead of at that seam, this is the assertion that fails.
    expect(storedCycleId(gateId)).toBe(cycleId);
    expect(storedCycleId(runId)).toBe(cycleId);
    const gateBrief = await briefOf(key, gateId);
    expect(gateBrief.cycleId).toBe(cycleId);
  });
});
