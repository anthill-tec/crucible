// RETIRED-CONTRACT ARCHIVE — CR-CRU-008 §S4, 2026-07-17. The v1 shim these
// tests pinned has been retired (soak gate passed); this file is moved to
// tests/archive/ and excluded from `bun test` (see bunfig.toml
// [test].pathIgnorePatterns). Kept for historical reference only — do not
// resurrect without a new CR reintroducing the legacy `/api/*` routes.
//
// CR-CRU-003 §S3 — v1 contract-test suite. One describe block per DN §3
// subsection (docs/research/DN-crucible-api-reconstruction.md §1-§3). Fixture
// payloads are copied verbatim from the DN's examples, including the exact
// client-variant shapes the surviving fleet sends (rust/mvn/bun/arduino/python).
// This is the PERMANENT regression gate for the shim's wire contract — it locks
// the byte-level behavior the legacy `*-crucible.py` scripts depend on, forever.
//
// Drives the REAL production server (startServer) on port 0 / :memory:, never a
// hand-wired store.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server.ts";
import type { Coverage, RunSummary } from "../../src/types.ts";

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
  projects: Array<{ key: string; name: string; sutRoot?: string }>;
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

interface IngestOkResponse {
  ok: true;
  summary: RunSummary;
}

interface CompileOkResponse {
  ok: true;
  summary: { failed: number; pending: number };
}

interface EventsListResponse {
  ok: true;
  events: Array<{ id: string; projectKey: string; timestamp: number; coverage?: Coverage }>;
}

// DN §3.4 / CR-CRU-002 §S2 AC4 — the canonical rustc fixture, byte-identical to
// the one used across the codec + ingest-route test suites.
const RUSTC_FIXTURE = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

// DN §3.6 — python traceback dialect (two "File ..., line N" frames, ending in
// an ImportError line), byte-identical to the compile-codec fixture.
const PYTHON_FIXTURE = [
  "Traceback (most recent call last):",
  '  File "main.py", line 10, in <module>',
  "    import foo",
  '  File "foo.py", line 3, in <module>',
  "    import y",
  "ImportError: no module named y",
].join("\n");

// mvn/javac dialect — format-less compile ingest (mvn/arduino/vscode omit
// `format` entirely; server auto-detects via [ERROR]/[WARNING] markers).
const MVN_JAVAC_FIXTURE = [
  "[ERROR] /x/Foo.java:[42,13] cannot find symbol",
  "[WARNING] /x/Foo.java:[10,1] deprecated API",
].join("\n");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "v1-contract-"));
}

describe("DN v1 contract suite (§1-§3)", () => {
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

  function seedProject(): string {
    const key = crypto.randomUUID();
    handle!.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  // ── DN §1 Service identity — error shape on every 4xx ──────────────────

  describe("DN §1 — error shape {ok:false, error:<actionable message>} on every 4xx", () => {
    test("non-UUID projectKey, unknown project, malformed JSON, and missing required field all carry ok:false + non-empty error", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const cases: Array<() => Promise<Response>> = [
        () => postJson("/api/agents/heartbeat", { agentId: "a", projectKey: "not-a-uuid" }),
        () =>
          postJson("/api/ingest", {
            projectKey: crypto.randomUUID(),
            format: "junit",
            data: "<testsuite/>",
            agentId: "a",
          }),
        () =>
          fetch(`http://localhost:${handle!.server.port}/api/projects/add`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not-json",
          }),
        () => postJson("/api/agents/remove", { projectKey: pk }), // missing agentId
      ];

      for (const run of cases) {
        const res = await run();
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      }
    });
  });

  // ── DN §3.1 POST /api/projects/add (+ GET /api/projects) ───────────────

  describe("DN §3.1 — POST /api/projects/add (arduino-crucible.py projects/add flow)", () => {
    test("arduino variant {key,name,sut_root} → 200 {ok:true}; duplicate key → 400 (idempotent self-registration quirk, ignored by the client)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      const arduinoPayload = {
        key,
        name: "sheetal-firmware",
        sut_root: "/home/pi/projects/sheetal",
      };

      const first = await postJson("/api/projects/add", arduinoPayload);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as OkResponse;
      expect(firstBody.ok).toBe(true);

      const second = await postJson("/api/projects/add", arduinoPayload);
      expect(second.status).toBe(400);
      const secondBody = (await second.json()) as ErrResponse;
      expect(secondBody.ok).toBe(false);
    });

    test("GET /api/projects lists the arduino-registered project with sut_root preserved as sutRoot", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = crypto.randomUUID();
      await postJson("/api/projects/add", {
        key,
        name: "sheetal-firmware",
        sut_root: "/home/pi/projects/sheetal",
      });

      const res = await getJson("/api/projects");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectsListResponse;
      expect(body.ok).toBe(true);
      const project = body.projects.find((p) => p.key === key);
      expect(project).toBeDefined();
      expect(project?.sutRoot).toBe("/home/pi/projects/sheetal");
    });
  });

  // ── DN §3.2 POST /api/agents/heartbeat (+ GET /api/agents) ─────────────

  describe("DN §3.2 — POST /api/agents/heartbeat client-variant fidelity", () => {
    test("rust variant: top-level displayName+source, NO identity object → 200; GET /api/agents shows the agent WITHOUT that displayName anywhere (top-level silently ignored)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "rust-agent-1",
        projectKey: pk,
        status: "online",
        message: "RED: 3/5 tests failing",
        displayName: "Rust CR Agent",
        source: "rust-crucible",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "rust-agent-1");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("online");
      expect(JSON.stringify(agent)).not.toContain("Rust CR Agent");
    });

    test("mvn variant: identity:{displayName,source} (no repoPath) → identity honored via GET /api/agents", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/agents/heartbeat", {
        agentId: "CR-OA-002-A-RED",
        projectKey: pk,
        status: "busy",
        message: "RED: 3/5 tests failing",
        identity: { displayName: "CR-OA-002-A RED Agent", source: "claude-code" },
      });
      expect(res.status).toBe(200);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "CR-OA-002-A-RED");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("busy");
      expect(agent?.identity?.displayName).toBe("CR-OA-002-A RED Agent");
      expect(agent?.identity?.source).toBe("claude-code");
    });

    test("bun variant: identity:{displayName,source,repoPath} → repoPath honored via GET /api/agents; identity persists across a later identity-less heartbeat", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const first = await postJson("/api/agents/heartbeat", {
        agentId: "bun-agent-1",
        projectKey: pk,
        status: "online",
        message: "GREEN: implementing",
        identity: {
          displayName: "CR-CRU-003-C3 Agent",
          source: "openclaw",
          repoPath: "/abs/path",
        },
      });
      expect(first.status).toBe(200);

      // identity omitted on the second beat — DN §3.2 "preserved across
      // heartbeats that omit it".
      const second = await postJson("/api/agents/heartbeat", {
        agentId: "bun-agent-1",
        projectKey: pk,
        status: "online",
        message: "GREEN: done",
      });
      expect(second.status).toBe(200);

      const listRes = await getJson(`/api/agents?projectKey=${pk}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "bun-agent-1");
      expect(agent).toBeDefined();
      expect(agent?.identity?.repoPath).toBe("/abs/path");
      expect(agent?.identity?.displayName).toBe("CR-CRU-003-C3 Agent");
      expect(agent?.message).toBe("GREEN: done");
    });
  });

  // ── DN §3.3 POST /api/agents/remove ─────────────────────────────────────

  describe("DN §3.3 — POST /api/agents/remove", () => {
    test("missing agentId → 400 {ok:false}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/agents/remove", { projectKey: pk });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("agentId with projectKey omitted removes the agent everywhere (v2 requires agentId, tolerates missing projectKey)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk1 = seedProject();
      const pk2 = seedProject();
      handle.store.touchAgent(pk1, "shared-1", { message: "hi" });
      handle.store.touchAgent(pk2, "shared-1", { message: "hi" });

      const res = await postJson("/api/agents/remove", { agentId: "shared-1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const list1 = (await (await getJson(`/api/agents?projectKey=${pk1}`)).json()) as AgentsListResponse;
      const list2 = (await (await getJson(`/api/agents?projectKey=${pk2}`)).json()) as AgentsListResponse;
      expect(list1.agents.some((a) => a.agentId === "shared-1")).toBe(false);
      expect(list2.agents.some((a) => a.agentId === "shared-1")).toBe(false);
    });
  });

  // ── DN §3.4 POST /api/ingest (raw, server-side parser) ─────────────────

  describe("DN §3.4 — POST /api/ingest — dataPath file AND directory; response summary shape", () => {
    test("dataPath = a single FILE (not a TEST-* dir) → 200 {ok:true} with exact summary key set", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const dir = freshDir();
      tmpDirs.push(dir);
      const filePath = join(dir, "run.xml");
      writeFileSync(
        filePath,
        [
          '<testsuite name="Solo" tests="2">',
          '<testcase name="s1" time="0.01"/>',
          '<testcase name="s2" time="0.02"/>',
          "</testsuite>",
        ].join("\n"),
      );

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        dataPath: filePath,
        agentId: "arduino-1",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestOkResponse;
      expect(body.ok).toBe(true);
      expect(Object.keys(body.summary).sort()).toEqual(
        ["duration_ms", "failed", "passed", "pending", "total"].sort(),
      );
      expect(body.summary.total).toBe(2);
    });

    test("dataPath = a DIRECTORY of 2 surefire TEST-*.xml fixtures → summary.total sums both files", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const dir = freshDir();
      tmpDirs.push(dir);

      writeFileSync(
        join(dir, "TEST-com.example.FooTest.xml"),
        [
          '<testsuite name="com.example.FooTest" tests="2">',
          '<testcase name="a" time="0.1"/>',
          '<testcase name="b" time="0.1"/>',
          "</testsuite>",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "TEST-com.example.BarTest.xml"),
        [
          '<testsuite name="com.example.BarTest" tests="3">',
          '<testcase name="c" time="0.1"/>',
          '<testcase name="d" time="0.1"/>',
          '<testcase name="e" time="0.1"><failure message="boom"/></testcase>',
          "</testsuite>",
        ].join("\n"),
      );

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        dataPath: dir,
        agentId: "mvn-1",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestOkResponse;
      expect(body.ok).toBe(true);
      expect(body.summary).toEqual({
        total: 5,
        passed: 4,
        failed: 1,
        pending: 0,
        duration_ms: 500,
      });
    });

    test("inline `data` XML string also succeeds (the alternative to dataPath)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest", {
        projectKey: pk,
        format: "junit",
        data: [
          '<testsuite name="Inline" tests="1">',
          '<testcase name="i1" time="0.05"/>',
          "</testsuite>",
        ].join("\n"),
        agentId: "python-1",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestOkResponse;
      expect(body.ok).toBe(true);
      expect(body.summary.total).toBe(1);
    });
  });

  // ── DN §3.5 POST /api/ingest/parsed ─────────────────────────────────────

  describe("DN §3.5 — POST /api/ingest/parsed — java-skill payload with branches axis; coverage discard on failed>0", () => {
    // Verbatim (aside from projectKey) from DN §3.5's example: summary 34/34/0/0,
    // full three-axis coverage (lines+functions+branches — the java/vscode shape).
    function javaSkillPayload(pk: string, failed: number) {
      return {
        projectKey: pk,
        agentId: "mvn-crucible",
        summary: {
          total: 34,
          passed: 34 - failed,
          failed,
          pending: 0,
          duration_ms: 5120,
        },
        tree: [
          {
            name: "suite-name",
            status: failed > 0 ? "fail" : "pass",
            children: [{ name: "test-name", status: failed > 0 ? "fail" : "pass", duration_ms: 12 }],
          },
        ],
        coverage: {
          lines: { total: 1000, covered: 900, percent: 90.0 },
          functions: { total: 200, covered: 180, percent: 90.0 },
          branches: { total: 400, covered: 300, percent: 75.0 },
        },
      };
    }

    test("failed:0 → coverage (including branches axis) is stored and retrievable via GET /api/events", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest/parsed", javaSkillPayload(pk, 0));
      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestOkResponse;
      expect(body.ok).toBe(true);

      const eventsRes = await getJson(`/api/events?projectKey=${pk}`);
      const eventsBody = (await eventsRes.json()) as EventsListResponse;
      expect(eventsBody.events[0]?.coverage?.branches).toEqual({
        total: 400,
        covered: 300,
        percent: 75.0,
      });
    });

    test("failed:2 with the SAME java-skill coverage payload → coverage discarded (verified via GET /api/events, not just the store)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest/parsed", javaSkillPayload(pk, 2));
      expect(res.status).toBe(200);

      const eventsRes = await getJson(`/api/events?projectKey=${pk}`);
      const eventsBody = (await eventsRes.json()) as EventsListResponse;
      const stored = eventsBody.events[0];
      expect(stored).toBeDefined();
      expect(stored?.coverage).toBeUndefined();
    });
  });

  // ── DN §3.6 POST /api/ingest/compile ────────────────────────────────────

  describe("DN §3.6 — POST /api/ingest/compile — format optional", () => {
    test("python variant: explicit format:'python' → {ok:true, summary:{failed:1, pending:0}}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "python-crucible",
        format: "python",
        errors: PYTHON_FIXTURE,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CompileOkResponse;
      expect(body.ok).toBe(true);
      expect(body.summary).toEqual({ failed: 1, pending: 0 });
    });

    test("mvn variant: format OMITTED entirely (javac auto-detected) → {ok:true, summary:{failed:1, pending:1}}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "mvn-crucible",
        errors: MVN_JAVAC_FIXTURE,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CompileOkResponse;
      expect(body.ok).toBe(true);
      expect(body.summary).toEqual({ failed: 1, pending: 1 });
    });

    test("rustc fixture (CR-CRU-002 §S2 AC4) with NO format field → {ok:true, summary:{failed:1, pending:1}}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "rust-crucible",
        errors: RUSTC_FIXTURE,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as CompileOkResponse;
      expect(body.ok).toBe(true);
      expect(body.summary).toEqual({ failed: 1, pending: 1 });
    });
  });

  // ── DN §3.7 POST /api/ingest/clear / GET /api/ingest/status ────────────

  describe("DN §3.7 — POST /api/ingest/clear / GET /api/ingest/status", () => {
    test("POST /api/ingest/clear removes stored events; a subsequent GET /api/ingest/status flips hasData back to false", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "a1",
        errors: RUSTC_FIXTURE,
        format: "rustc",
      });

      const before = await getJson(`/api/ingest/status?projectKey=${pk}`);
      const beforeBody = (await before.json()) as { ok: true; status: { hasData: boolean } };
      expect(beforeBody.status.hasData).toBe(true);

      const clearRes = await postJson("/api/ingest/clear", { projectKey: pk });
      expect(clearRes.status).toBe(200);
      const clearBody = (await clearRes.json()) as { ok: true; cleared: number };
      expect(clearBody.ok).toBe(true);
      expect(clearBody.cleared).toBe(1);

      const after = await getJson(`/api/ingest/status?projectKey=${pk}`);
      const afterBody = (await after.json()) as { ok: true; status: { hasData: boolean } };
      expect(afterBody.status.hasData).toBe(false);
    });

    test("GET /api/ingest/status?type=unit (the TDD/BDD axis param) is tolerated without erroring", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await getJson(`/api/ingest/status?projectKey=${pk}&type=unit`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true };
      expect(body.ok).toBe(true);
    });
  });

  // ── DN §3.8 Events ───────────────────────────────────────────────────────

  describe("DN §3.8 — Events: id format, GET /api/events default limit, POST /api/events/delete, POST /api/events/clear", () => {
    test("event id format is evt-<epoch-ms>-<seq>", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "a1",
        errors: RUSTC_FIXTURE,
      });

      const res = await getJson(`/api/events?projectKey=${pk}`);
      const body = (await res.json()) as EventsListResponse;
      expect(body.events[0]?.id).toMatch(/^evt-\d+-\d+$/);
    });

    test("GET /api/events with 55 events inserted and NO ?limit → default limit 50, newest first", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const inserted: string[] = [];
      for (let i = 0; i < 55; i++) {
        const event = handle.store.recordTestEvent(pk, "seed", {
          summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
          tree: [],
        });
        inserted.push(event.id);
      }
      // newest-first: reverse insertion order, first 50.
      const expectedIds = [...inserted].reverse().slice(0, 50);

      const res = await getJson(`/api/events?projectKey=${pk}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as EventsListResponse;
      expect(body.ok).toBe(true);
      expect(body.events.length).toBe(50);
      expect(body.events.map((e) => e.id)).toEqual(expectedIds);
    });

    test("GET /api/events?limit=1 returns exactly the newest event", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const first = handle.store.recordTestEvent(pk, "a1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [],
      });
      Bun.sleepSync(2);
      const second = handle.store.recordTestEvent(pk, "a1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [],
      });

      const res = await getJson(`/api/events?projectKey=${pk}&limit=1`);
      const body = (await res.json()) as EventsListResponse;
      expect(body.events.length).toBe(1);
      expect(body.events[0]?.id).toBe(second.id);
      expect(body.events[0]?.id).not.toBe(first.id);
    });

    test("POST /api/events/delete with a WRONG projectKey does not delete the event", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const otherPk = seedProject();
      const event = handle.store.recordTestEvent(pk, "a1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [],
      });

      const res = await postJson("/api/events/delete", { eventId: event.id, projectKey: otherPk });
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
      expect(handle.store.getEvent(event.id)).not.toBeNull();
    });

    test("POST /api/events/clear removes all events for the project and returns the count", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      handle.store.recordTestEvent(pk, "a1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [],
      });
      handle.store.recordTestEvent(pk, "a1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [],
      });

      const res = await postJson("/api/events/clear", { projectKey: pk });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; cleared: number };
      expect(body.ok).toBe(true);
      expect(body.cleared).toBe(2);
      expect(handle.store.listEvents(pk).length).toBe(0);
    });
  });
});
