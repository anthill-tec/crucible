// CR-CRU-056 §S3b (C3, server) — "Ingest ONLY from registered agents;
// implicit agent-creation retired" (user ruling 2026-08-01, second). Run/
// compile/gate ingest carrying an `agentId` with NO live registered row is
// REFUSED — 409, ok:false, run NOT stored, help[] naming registration as the
// next action. The v1 "ingest-as-implicit-heartbeat" behaviour survives
// ONLY as a heartbeat for a REGISTERED agent (refreshes lastSeen); it never
// CREATES or resurrects an agent row — the exact 2026-08-01 "vidushi
// resurrection" scenario (a pruned row silently re-materialised by a bare
// ingest with no registration).
//
// RED phase: src/store.ts's recordTestEvent/recordCompileEvent/
// recordGateEvent each call `this.touchAgent(projectKey, agentId)`
// UNCONDITIONALLY before inserting the event (see store.ts:816-817,
// store.ts:849-850, store.ts:903-904 — "§S3 implicit heartbeat — creates the
// agent row if new, bumps lastSeen") and src/v2.ts's handleRuns/
// handleRunsParsed/handleRunsCompile/handleGates never check
// store.hasAgent() first — every ingest below from an unregistered agentId
// reads back its CURRENT success status (200/201) and a freshly
// materialised agent row, instead of a 409 refusal with no row created.
//
// Harness: drives the real production server (startServer) + real HTTP,
// the same pattern as tests/agent-cycle-binding.test.ts and
// tests/checkpoint-stop.test.ts. State checks read `handle.store` directly.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface ErrResponse {
  ok: false;
  error?: unknown;
  help?: unknown;
  [key: string]: unknown;
}

function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`.toLowerCase();
}

function expectUnregisteredRefusal(res: Response, body: ErrResponse): void {
  expect(res.status).toBe(409);
  expect(body.ok).toBe(false);
  expect(Array.isArray(body.help)).toBe(true);
  expect((body.help as unknown[]).length).toBeGreaterThan(0);
  expect(errorSurface(body)).toContain("regist");
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function boot(): ServerHandle {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function postJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path_: string): Promise<Response> {
  return fetch(`${base()}${path_}`);
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  return key;
}

async function registerOrchestrator(key: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

async function unregisterAgent(key: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
  expect(res.status).toBe(200);
}

async function listAgentIds(key: string): Promise<string[]> {
  const res = await getJson(`/api/v2/agents?project=${key}`);
  const body = (await res.json()) as { ok: true; agents: Array<{ agentId: string }> };
  return body.agents.map((a) => a.agentId);
}

const passingRun = {
  summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
  tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 10 }] }],
};

const gate = { intent: "no-mistakes run", outcome: "passed", steps: ["test"] };

// ── §S3b — POST /api/v2/runs/parsed ───────────────────────────────────────

describe("§S3b — POST /api/v2/runs/parsed from an agentId with NO live registered row is refused; no run stored, NO agent row created", () => {
  test("a never-registered agentId -> 409, ok:false; the run is NOT stored AND the ghost agentId never appears in GET /api/v2/agents (the 2026-08-01 'vidushi resurrection' case, first form: never registered at all)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const eventsBefore = h.store.listEvents(key, 50).length;

    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "vidushi",
      summary: passingRun.summary,
      tree: passingRun.tree,
    });

    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).length).toBe(eventsBefore);
    // POSITIVE + NEGATIVE — no agent row was materialised for the ghost id.
    expect(h.store.hasAgent(key, "vidushi")).toBe(false);
    expect(await listAgentIds(key)).not.toContain("vidushi");
  });

  test("a LIVE registered ORCHESTRATOR caller ingests exactly as today (200, run stored) — BORN GREEN: today's route never checks liveness, so this already passes and must keep passing after GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-parsed-1");

    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "orch-parsed-1",
      summary: passingRun.summary,
      tree: passingRun.tree,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; event: string };
    expect(body.ok).toBe(true);
    expect(h.store.listEvents(key, 50).some((e) => e.id === body.event)).toBe(true);
  });
});

// ── §S3b — POST /api/v2/runs ──────────────────────────────────────────────

describe("§S3b — POST /api/v2/runs (raw codec) from an agentId with NO live registered row is refused; no run stored, no agent row created", () => {
  test("a never-registered agentId -> 409, ok:false; the run is NOT stored and no agent row is materialised", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const eventsBefore = h.store.listEvents(key, 50).length;

    const junitXml =
      '<testsuite name="suite" tests="1" failures="0"><testcase name="t" time="0.01"/></testsuite>';
    const res = await postJson("/api/v2/runs", {
      projectKey: key,
      agentId: "ghost-runner",
      codec: "junit",
      data: junitXml,
    });

    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).length).toBe(eventsBefore);
    expect(h.store.hasAgent(key, "ghost-runner")).toBe(false);
  });

  test("a LIVE registered ORCHESTRATOR caller ingests exactly as today (200, run stored) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-runs-1");

    const junitXml =
      '<testsuite name="suite" tests="1" failures="0"><testcase name="t" time="0.01"/></testsuite>';
    const res = await postJson("/api/v2/runs", {
      projectKey: key,
      agentId: "orch-runs-1",
      codec: "junit",
      data: junitXml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; event: string };
    expect(body.ok).toBe(true);
    expect(h.store.listEvents(key, 50).some((e) => e.id === body.event)).toBe(true);
  });
});

// ── §S3b — POST /api/v2/runs/compile ──────────────────────────────────────

describe("§S3b — POST /api/v2/runs/compile from an agentId with NO live registered row is refused; no compile event stored, no agent row created", () => {
  test("a never-registered agentId -> 409, ok:false; NO compile event is recorded and no agent row is materialised", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const res = await postJson("/api/v2/runs/compile", {
      projectKey: key,
      agentId: "ghost-compiler",
      errors: "src/x.ts:1:1: error TS2304: Cannot find name 'x'.",
    });

    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "compile").length).toBe(0);
    expect(h.store.hasAgent(key, "ghost-compiler")).toBe(false);
  });

  test("a LIVE registered ORCHESTRATOR caller ingests exactly as today (200, ok:true) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-compile-1");

    const res = await postJson("/api/v2/runs/compile", {
      projectKey: key,
      agentId: "orch-compile-1",
      errors: "src/x.ts:1:1: error TS2304: Cannot find name 'x'.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "compile").length).toBe(1);
  });
});

// ── §S3b — POST /api/v2/gates (gate-snapshot ingest) ──────────────────────

describe("§S3b — POST /api/v2/gates from an agentId with NO live registered row is refused; no gate event stored, no agent row created", () => {
  test("a never-registered agentId -> 409, ok:false; NO gate event is recorded and no agent row is materialised", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const res = await postJson("/api/v2/gates", { projectKey: key, agentId: "ghost-gate", gate });

    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "gate").length).toBe(0);
    expect(h.store.hasAgent(key, "ghost-gate")).toBe(false);
  });

  test("a LIVE registered ORCHESTRATOR caller ingests exactly as today (201, ok:true) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-gate-ingest-1");

    const res = await postJson("/api/v2/gates", { projectKey: key, agentId: "orch-gate-ingest-1", gate });
    expect(res.status).toBe(201);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "gate").length).toBe(1);
  });
});

// ── §S3b — after unregister, ingest under the same id is refused; row stays gone ──

describe("§S3b — after an agent unregisters, ingest under its OLD id is refused and the row stays gone", () => {
  test("register -> unregister -> POST /api/v2/runs/parsed with the SAME agentId -> 409; the agent row is NOT re-created (the 2026-08-01 'vidushi resurrection' case, second form: registered yesterday, pruned/unregistered today)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "vidushi");
    await unregisterAgent(key, "vidushi");
    expect(h.store.hasAgent(key, "vidushi")).toBe(false);

    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "vidushi",
      summary: passingRun.summary,
      tree: passingRun.tree,
    });

    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.hasAgent(key, "vidushi")).toBe(false);
    expect(await listAgentIds(key)).not.toContain("vidushi");
  });
});

// ── §S3b — regression: a REGISTERED agent's ingest still refreshes lastSeen (implicit heartbeat preserved for KNOWN agents) ──

describe("§S3b regression — a REGISTERED agent's ingest still refreshes its lastSeen (the heartbeat survives for known agents; only agent-CREATION is retired)", () => {
  test("register, capture lastSeen, wait, then ingest a run -> the agent's lastSeen strictly increases to (at least) the ingest time — BORN GREEN: this is the ONE part of the old implicit-heartbeat behaviour §S3b explicitly keeps", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-heartbeat-1");

    const before = h.store.getAgent(key, "orch-heartbeat-1")!;
    const beforeLastSeen = before.lastSeen;

    // A real (small but non-zero) wall-clock gap — no injected clock needed
    // here since the assertion is a strict increase, not an exact delta.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "orch-heartbeat-1",
      summary: passingRun.summary,
      tree: passingRun.tree,
    });
    expect(res.status).toBe(200);

    const after = h.store.getAgent(key, "orch-heartbeat-1")!;
    // POSITIVE — lastSeen moved forward (the heartbeat fired).
    expect(after.lastSeen).toBeGreaterThan(beforeLastSeen);
    // NEGATIVE bound — firstSeen (registration time) must NOT have moved;
    // this is a heartbeat on the EXISTING row, not a fresh re-creation.
    expect(after.firstSeen).toBe(before.firstSeen);
  });
});

// ── §S3b — the v1 shim ingest surface (/api/ingest) ───────────────────────

describe("§S3b — the v1 shim ingest surface (/api/ingest)", () => {
  // FINDING (read src/server.ts before writing this): the v1 shim is NOT a
  // shared parse path that would inherit §S3b's refusal — it was fully
  // RETIRED by CR-CRU-008 §S4 ("the CR-CRU-003 v1 shim routes are RETIRED
  // (soak-gated): every legacy /api/* route now falls through to the
  // generic 404 JSON"; see src/server.ts's fetch handler — only
  // /api/health and /api/stream are pinned before the `/api/` prefix falls
  // to `err(404, "unknown route: ...")`). There is no `/api/ingest` route
  // in production at all, registered-agent or not. This pin asserts that
  // ARCHITECTURE fact directly: POST /api/ingest 404s today via the generic
  // catch-all, for a reason UNRELATED to agent registration — and must
  // keep 404ing that same way after GREEN (§S3b adds no new behavior here;
  // there is no shim ingest path left to gain a 409 from).
  test("POST /api/ingest 404s via the generic v1-retirement catch-all ('unknown route'), regardless of agentId — BORN GREEN, unrelated to §S3b's registration refusal", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-shim-1");

    const res = await postJson("/api/ingest", {
      projectKey: key,
      agentId: "orch-shim-1",
      codec: "junit",
      data: "<testsuite/>",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(String(body.error ?? "")).toContain("unknown route");
  });
});
