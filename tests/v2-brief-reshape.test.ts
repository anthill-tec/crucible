// CR-CRU-006 §S0 — event-brief reshape: v2 event BRIEFS (GET /api/v2/events list
// items, status.lastTest/lastCompile, project-rollup lastEvent) hoist the run
// numbers to top-level scalars {id, projectKey, agentId, kind, tier, codec,
// timestamp, total, passed, failed, pending, duration_ms, hasCoverage} with NO
// nested `summary`. Full detail (GET /api/v2/events/:id) keeps nested
// summary/tree unchanged. The v1 shim's GET /api/events shape is untouched.
// Drives the REAL production server (startServer) end to end.
import { describe, test, expect, afterEach } from "bun:test";

import { startServer } from "../src/server.ts";
import type { Coverage } from "../src/types.ts";

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
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBriefLike[];
}

interface EventGetResponse extends OkResponse {
  event: {
    id: string;
    summary?: unknown;
    tree?: unknown[];
    [key: string]: unknown;
  };
}

interface StatusResponse extends OkResponse {
  status: {
    hasData: boolean;
    lastTest: EventBriefLike | null;
    lastCompile: EventBriefLike | null;
  };
}

interface ProjectRollup {
  key: string;
  lastEvent: EventBriefLike | null;
  [key: string]: unknown;
}

interface ProjectsRollupResponse extends OkResponse {
  projects: ProjectRollup[];
}

// The exact §S0 flattened-brief field set for a "test"-kind event.
const FLATTENED_TEST_BRIEF_KEYS = [
  "id",
  "projectKey",
  "agentId",
  "kind",
  "tier",
  "codec",
  "timestamp",
  "total",
  "passed",
  "failed",
  "pending",
  "duration_ms",
  "hasCoverage",
].sort();

// CR-CRU-007 §S5.2 F8 vitals anatomy (additive) — a COVERAGE-BEARING brief
// also gains the optional `coverageLines` field (see
// tests/v2-brief-context.test.ts). The guard for coverage-bearing items
// below pins this exact set; the no-coverage failItem (still
// FLATTENED_TEST_BRIEF_KEYS) keeps proving the field's absence.
const FLATTENED_TEST_BRIEF_KEYS_WITH_COVERAGE_LINES = [
  ...FLATTENED_TEST_BRIEF_KEYS,
  "coverageLines",
].sort();

// rustc fixture: 1 error[E0308] block + 1 plain warning block (matches the
// fixture used across the v2 runs/events suite).
const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

describe("v2 event-brief reshape (CR-CRU-006 §S0)", () => {
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

  async function getText(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`);
    return { status: res.status, text: await res.text() };
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

  async function seedFailingTestEvent(key: string): Promise<string> {
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "fail-agent",
      summary: { total: 4, passed: 2, failed: 2, pending: 0, duration_ms: 80 },
      tree: [{ name: "s", status: "fail", children: [{ name: "t1", status: "fail", duration_ms: 30 }] }],
    });
    const body = (await res.json()) as OkResponse & { event: string };
    expect(res.status).toBe(200);
    return body.event;
  }

  async function seedCompileEvent(key: string): Promise<string> {
    const res = await postJson("/api/v2/runs/compile", {
      projectKey: key,
      agentId: "compile-agent",
      errors: RUSTC_ERRORS,
      format: "rustc",
    });
    const body = (await res.json()) as OkResponse & { event: string };
    expect(res.status).toBe(200);
    return body.event;
  }

  // -------------------------------------------------------------------
  // 1. GET /api/v2/events list items — flattened brief, no summary key.
  // -------------------------------------------------------------------
  test("GET /api/v2/events list items carry flattened top-level run numbers + hasCoverage, no summary key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-list");

    await seedCoveredTestEvent(key);
    Bun.sleepSync(2);
    await seedFailingTestEvent(key);
    Bun.sleepSync(2);
    await seedCompileEvent(key);

    const res = await getJson(`/api/v2/events?project=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    expect(body.ok).toBe(true);
    expect(body.events.length).toBe(3);

    const covItem = body.events.find((e) => e.agentId === "cov-agent");
    const failItem = body.events.find((e) => e.agentId === "fail-agent");
    const compileItem = body.events.find((e) => e.agentId === "compile-agent");
    expect(covItem).toBeDefined();
    expect(failItem).toBeDefined();
    expect(compileItem).toBeDefined();

    // Covered test-kind item — exact flattened field set + exact values.
    // Coverage-bearing, so the set additionally includes `coverageLines`
    // (CR-CRU-007 §S5.2 F8 — additive, coverage-bearing events only).
    expect(Object.keys(covItem!).sort()).toEqual(FLATTENED_TEST_BRIEF_KEYS_WITH_COVERAGE_LINES);
    expect("summary" in covItem!).toBe(false);
    expect(covItem!.id).toMatch(/^evt-/);
    expect(covItem!.projectKey).toBe(key);
    expect(covItem!.kind).toBe("test");
    expect(covItem!.codec).toBe("parsed");
    expect(typeof covItem!.timestamp).toBe("number");
    expect(covItem!.total).toBe(5);
    expect(covItem!.passed).toBe(5);
    expect(covItem!.failed).toBe(0);
    expect(covItem!.pending).toBe(0);
    expect(covItem!.duration_ms).toBe(120);
    expect(covItem!.hasCoverage).toBe(true);

    // Failing test-kind item — exact flattened field set + exact values,
    // hasCoverage false (no coverage was ever attached).
    expect(Object.keys(failItem!).sort()).toEqual(FLATTENED_TEST_BRIEF_KEYS);
    expect("summary" in failItem!).toBe(false);
    expect(failItem!.kind).toBe("test");
    expect(failItem!.total).toBe(4);
    expect(failItem!.passed).toBe(2);
    expect(failItem!.failed).toBe(2);
    expect(failItem!.pending).toBe(0);
    expect(failItem!.duration_ms).toBe(80);
    expect(failItem!.hasCoverage).toBe(false);

    // Compile brief — kind "compile", hasCoverage false, no summary key.
    // The run-number fields may carry 0s or be omitted for a compile event
    // (it never has a RunSummary) — assert only what §S0 pins precisely.
    expect("summary" in compileItem!).toBe(false);
    expect(compileItem!.kind).toBe("compile");
    expect(compileItem!.hasCoverage).toBe(false);
    expect(compileItem!.id).toMatch(/^evt-/);
    expect(compileItem!.projectKey).toBe(key);
    expect(compileItem!.agentId).toBe("compile-agent");
    expect(typeof compileItem!.tier).toBe("string");
    expect(typeof compileItem!.timestamp).toBe("number");
  });

  // -------------------------------------------------------------------
  // 2. status.lastTest/lastCompile + project-rollup lastEvent — same
  //    flattened shape, no summary key.
  // -------------------------------------------------------------------
  test("status.lastTest/lastCompile and project-rollup lastEvent are flattened briefs with no summary key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-status");

    const testId = await seedCoveredTestEvent(key);
    Bun.sleepSync(2);
    const compileId = await seedCompileEvent(key);

    const statusRes = await getJson(`/api/v2/status?project=${key}`);
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as StatusResponse;
    expect(statusBody.ok).toBe(true);

    const lastTest = statusBody.status.lastTest;
    expect(lastTest).not.toBeNull();
    expect(lastTest!.id).toBe(testId);
    expect("summary" in lastTest!).toBe(false);
    // Coverage-bearing (same `seedCoveredTestEvent` fixture) — additionally
    // carries `coverageLines`.
    expect(Object.keys(lastTest!).sort()).toEqual(FLATTENED_TEST_BRIEF_KEYS_WITH_COVERAGE_LINES);
    expect(lastTest!.total).toBe(5);
    expect(lastTest!.passed).toBe(5);
    expect(lastTest!.failed).toBe(0);
    expect(lastTest!.pending).toBe(0);
    expect(lastTest!.duration_ms).toBe(120);
    expect(lastTest!.hasCoverage).toBe(true);

    const lastCompile = statusBody.status.lastCompile;
    expect(lastCompile).not.toBeNull();
    expect(lastCompile!.id).toBe(compileId);
    expect("summary" in lastCompile!).toBe(false);
    expect(lastCompile!.kind).toBe("compile");
    expect(lastCompile!.hasCoverage).toBe(false);

    // Project-rollup lastEvent brief — most recent event (the compile one),
    // same flattened shape, no summary key.
    const rollupRes = await getJson("/api/v2/projects");
    expect(rollupRes.status).toBe(200);
    const rollupBody = (await rollupRes.json()) as ProjectsRollupResponse;
    const project = rollupBody.projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    const lastEvent = project!.lastEvent;
    expect(lastEvent).not.toBeNull();
    expect(lastEvent!.id).toBe(compileId);
    expect("summary" in lastEvent!).toBe(false);
    expect(lastEvent!.kind).toBe("compile");
    expect(lastEvent!.agentId).toBe("compile-agent");
    expect(lastEvent!.hasCoverage).toBe(false);
    expect(typeof lastEvent!.timestamp).toBe("number");
  });

  // -------------------------------------------------------------------
  // 3. GET /api/v2/events/<id> detail — nested summary AND tree unchanged.
  // -------------------------------------------------------------------
  test("GET /api/v2/events/:id detail keeps nested summary and tree unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-detail");
    const id = await seedCoveredTestEvent(key);

    const res = await getJson(`/api/v2/events/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventGetResponse;
    expect(body.ok).toBe(true);
    expect(body.event.id).toBe(id);
    // Nested summary object, unchanged shape.
    expect(body.event.summary).toEqual({ total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 120 });
    // Nested tree, unchanged — still present and non-empty.
    expect(Array.isArray(body.event.tree)).toBe(true);
    expect((body.event.tree as unknown[]).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // 4. v1 contract untouched — GET /api/events items still carry nested
  //    summary (contract-locked shim shape).
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // 5. TOON uniform-table form — ≥2 test-event briefs now scalar-only.
  // -------------------------------------------------------------------
  test("GET /api/v2/events?fmt=toon with >=2 test-event briefs emits the uniform-table form", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("brief-toon");

    // Two same-shaped test-kind briefs (both without coverage) so the
    // flattened field set is identical/order-identical across rows —
    // the precondition for TOON's uniform-table detection.
    await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "toon-1",
      summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 20 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 10 }] }],
    });
    Bun.sleepSync(2);
    await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "toon-2",
      summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 30 },
      tree: [{ name: "s", status: "fail", children: [{ name: "t1", status: "fail", duration_ms: 15 }] }],
    });

    const { status, text } = await getText(`/api/v2/events?project=${key}&fmt=toon`);
    expect(status).toBe(200);
    expect(text).toMatch(/^events\[\d+\]\{/m);
  });
});
