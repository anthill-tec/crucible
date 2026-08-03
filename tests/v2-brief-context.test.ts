// CR-CRU-007 §S1 — eventBrief context passthrough (additive `RunContext.cycle`)
// + compile counts (errors/warnings). Today `eventBrief` (src/v2.ts) carries
// neither `context` nor `errors`/`warnings` — run cards cannot render context
// badges or compile previews from the GET /api/v2/events list payload until
// GREEN adds them. Drives the REAL production server (startServer) end to
// end, same harness pattern as tests/v2-brief-reshape.test.ts (CR-CRU-006 §S0).
import { describe, test, expect, afterEach } from "bun:test";

import { startServer } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface EventBriefLike {
  id: string;
  projectKey?: string;
  agentId: string;
  kind: string;
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  summary?: unknown;
  context?: unknown;
  errors?: unknown;
  warnings?: unknown;
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBriefLike[];
}

// rustc fixture: 1 error[E0308] block + 1 plain warning block — matches the
// fixture used across the v2 runs/events + v2-brief-reshape suites
// (errorCount 1 / warningCount 1, confirmed against src/codecs/compile.ts).
const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

describe("v2 eventBrief context passthrough + compile counts (CR-CRU-007 §S1)", () => {
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

  // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs/parsed and
  // /api/v2/runs/compile now refuse an unregistered `agentId` (409) — each
  // distinct agentId these fixtures ingest under must be a LIVE registered
  // agent (the tests key their assertions off agentId, so a single shared
  // id can't stand in for all of them).
  async function registerAgent(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
  }

  async function listBriefs(key: string): Promise<EventBriefLike[]> {
    const res = await getJson(`/api/v2/events?project=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    expect(body.ok).toBe(true);
    return body.events;
  }

  // -------------------------------------------------------------------
  // 1. §S1 item 1 — RunContext gains OPTIONAL `cycle?: string` (additive);
  //    the brief carries an optional `context` passthrough, verbatim,
  //    when the event was ingested with one — absent (not null) otherwise.
  // -------------------------------------------------------------------
  test("GET /api/v2/events brief carries context verbatim (incl. additive cycle) when ingested with one; absent (no key) when not", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-context");

    // Exact fixture per dispatch — copied verbatim, not paraphrased.
    const context = {
      git: { branch: "feat/x", commit: "abc1234def" },
      wave: 2,
      orchestrator: "track-1",
      cycle: "checkpoint persistence",
    };

    await registerAgent(key, "ctx-brief-agent");
    const withCtxRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "ctx-brief-agent",
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 120 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 50 }] }],
      context,
    });
    expect(withCtxRes.status).toBe(200);

    await registerAgent(key, "no-ctx-agent");
    const noCtxRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "no-ctx-agent",
      summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 30 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 10 }] }],
    });
    expect(noCtxRes.status).toBe(200);

    const briefs = await listBriefs(key);
    const withCtxItem = briefs.find((e) => e.agentId === "ctx-brief-agent");
    const noCtxItem = briefs.find((e) => e.agentId === "no-ctx-agent");
    expect(withCtxItem).toBeDefined();
    expect(noCtxItem).toBeDefined();

    // Context-bearing brief — deep-equal to exactly what was stored.
    expect(withCtxItem!.context).toEqual(context);

    // Context-less brief — the key is ABSENT, not null/undefined-valued.
    expect("context" in noCtxItem!).toBe(false);
  });

  // -------------------------------------------------------------------
  // 2. §S1 item — compile-event briefs carry `errors`/`warnings` counts
  //    (from the stored compile payload); test-event briefs carry neither.
  // -------------------------------------------------------------------
  test("compile-event brief carries errors/warnings counts from the stored compile payload; test-event brief carries neither key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-compile-counts");

    await registerAgent(key, "compile-brief-agent");
    const compileRes = await postJson("/api/v2/runs/compile", {
      projectKey: key,
      agentId: "compile-brief-agent",
      errors: RUSTC_ERRORS,
      format: "rustc",
    });
    expect(compileRes.status).toBe(200);

    await registerAgent(key, "test-brief-agent");
    const testRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "test-brief-agent",
      summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 15 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    });
    expect(testRes.status).toBe(200);

    const briefs = await listBriefs(key);
    const compileItem = briefs.find((e) => e.agentId === "compile-brief-agent");
    const testItem = briefs.find((e) => e.agentId === "test-brief-agent");
    expect(compileItem).toBeDefined();
    expect(testItem).toBeDefined();

    expect(compileItem!.kind).toBe("compile");
    expect(compileItem!.errors).toBe(1);
    expect(compileItem!.warnings).toBe(1);

    expect(testItem!.kind).toBe("test");
    expect("errors" in testItem!).toBe(false);
    expect("warnings" in testItem!).toBe(false);
  });

  // -------------------------------------------------------------------
  // 2b. §S5.2 F8 vitals anatomy (user defect 2026-07-15) — eventBrief gains
  //     optional `coverageLines` (the stored coverage's lines percent) on
  //     coverage-bearing events, so the workspace coverage-trend card can
  //     derive its bar chart from the already-loaded timeline slice without
  //     a second round-trip. Absent (not null) on events with no coverage.
  //     No other brief field changes.
  // -------------------------------------------------------------------
  test("eventBrief carries optional coverageLines (lines percent) on coverage-bearing events; absent otherwise; no other brief field changes", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-coverage-lines");

    await registerAgent(key, "coverage-lines-agent");
    const withCovRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "coverage-lines-agent",
      summary: { total: 4, passed: 4, failed: 0, pending: 0, duration_ms: 90 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 20 }] }],
      coverage: { lines: { total: 100, covered: 90, percent: 90 } },
    });
    expect(withCovRes.status).toBe(200);

    await registerAgent(key, "no-coverage-lines-agent");
    const noCovRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "no-coverage-lines-agent",
      summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 10 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    });
    expect(noCovRes.status).toBe(200);

    const briefs = await listBriefs(key);
    const withCovItem = briefs.find((e) => e.agentId === "coverage-lines-agent");
    const noCovItem = briefs.find((e) => e.agentId === "no-coverage-lines-agent");
    expect(withCovItem).toBeDefined();
    expect(noCovItem).toBeDefined();

    expect(withCovItem!.coverageLines).toBe(90);
    expect("coverageLines" in noCovItem!).toBe(false);

    // No other brief field changes — the rest of the coverage-bearing
    // brief's shape is exactly what CR-CRU-006/007 already established.
    expect(withCovItem!.hasCoverage).toBe(true);
    expect(withCovItem!.total).toBe(4);
    expect(withCovItem!.passed).toBe(4);
    expect(withCovItem!.failed).toBe(0);
    expect("summary" in withCovItem!).toBe(false);
  });

  // -------------------------------------------------------------------
  // 3. Regression guard — the flattened brief still carries NO `summary`
  //    key (CR-CRU-006 §S0 cross-surface contract intact).
  // -------------------------------------------------------------------
  test("regression guard: the flattened brief still has no summary key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-summary-regression");

    await registerAgent(key, "summary-regression-agent");
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "summary-regression-agent",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    });
    expect(res.status).toBe(200);

    const briefs = await listBriefs(key);
    const item = briefs.find((e) => e.agentId === "summary-regression-agent");
    expect(item).toBeDefined();
    expect("summary" in item!).toBe(false);
  });
});
