// CR-CRU-056 C2 (server) — §S3: ingest attaches by binding; the CLIENT-side
// resolver is DELETED. New model: the binding lives on the AGENT ROW (§S1,
// C1 GREEN, merged — POST /api/v2/agents/register {cycleId} validates and
// stores `boundCycleId`). A BOUND agent's ingest is stamped SERVER-side from
// its row — the client sends NO resolved cycle at all — re-validated LIVE:
// if the bound cycle is no longer active (done/plan closed), the ingest
// gets a 409 definitive error and never spills into another cycle. An
// UNBOUND `report`-phase agent's runs attach ONLY via explicit
// `context.cycleId` (§S7, CR-CRU-024, unchanged) or are stored cycle-less
// with the existing envelope warning. §S2's consumer sweep names the
// gate-snapshot route (POST /api/v2/gates) as a second stamped surface.
//
// RED phase: NONE of this server-stamping/re-validation exists in production
// yet.
//   - handleRunsParsed/handleGates build `context`/stamp fields verbatim from
//     the POSTED body (runMeta/eventContext) — neither looks up the posting
//     agent's `boundCycleId` at all, so a bound agent's context-less ingest
//     stores NO context today (nothing to stamp FROM).
//   - CR-CRU-024 §S7's validateCycleRef only checks that an explicit
//     context.cycleId names a REAL, non-terminal cycle in THIS project — it
//     never compares the id against the POSTING AGENT's own binding, so a
//     conflicting-but-valid cycleId is silently accepted today.
//   - A bound agent's stale binding (cycle since transitioned to done) is
//     never re-checked at ingest time at all — today's ingest neither reads
//     nor cares about `boundCycleId`.
// Two describe blocks below (labelled "regression guard") pin behavior that
// is ALREADY correct today — CR-CRU-024 §S7's explicit-context path for an
// UNBOUND agent, and a matching (belt-and-braces) explicit cycleId trivially
// equal to the binding — mirroring the established "guard:" convention in
// tests/ingest-cycle-validation.test.ts (§S7.3). Every other test below is a
// genuine RED failure against the missing server-stamping/re-validation
// contract.
//
// Harness: drives the REAL production server (startServer) + real HTTP —
// register/plans/cycles conventions from tests/agent-cycle-binding.test.ts
// (fileAndActivate/transitionCycle via the real PATCH routes), and the
// parsedRunBody/postParsedRun/eventsForProject conventions from
// tests/ingest-cycle-validation.test.ts (GET /api/v2/events as the read
// path) — no new mechanism invented here.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface ErrResponse {
  ok: false;
  error?: unknown;
  help?: unknown;
  [key: string]: unknown;
}

interface RunsPostResponse {
  ok: boolean;
  changed?: boolean;
  event?: string;
  help?: string[];
  error?: string;
  // CR-CRU-056 C5 — the server's echo of the attachment it actually applied.
  context?: { cycleId?: number };
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  agentId: string;
  kind: string;
  context?: { cycleId?: number; cycle?: string };
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: EventBrief[];
}

interface PlanCyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  cycles: PlanCyclePayload[];
  [key: string]: unknown;
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

// CR-CRU-056 §S2b fixture-repair (C3): plan-file/cycle-transition are
// mutating v2 workflow verbs and now refuse an unregistered caller (409) —
// merge a live-registered agentId into any JSON body lacking one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function postJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function patchJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getJson(path_: string): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`);
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  return key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

// `seedProject` creates the project directly via the store (bypassing the
// HTTP layer entirely), so "fixture-orch" is never live-registered for it —
// unlike every other file in this sweep, there's no createProject() HTTP
// round trip to piggyback the registration onto. Register it once per
// project key, memoized, right before the first workflow-verb HTTP call.
const fixtureOrchestratorProjects = new Set<string>();

async function ensureFixtureOrchestrator(key: string): Promise<void> {
  if (fixtureOrchestratorProjects.has(key)) return;
  const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId: "fixture-orch", phase: "ORCHESTRATOR" }),
  });
  expect(res.status).toBe(200);
  fixtureOrchestratorProjects.add(key);
}

/** Files a one-cycle plan and activates it via the real PATCH transition route. */
async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
  await ensureFixtureOrchestrator(key);
  const res = await postJson(plansPath(key), { cr, cycles: [{ label: "solo" }] });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  const planId = body.planId;
  const cycleId = body.cycles[0]!.id;
  const activateRes = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
    status: "active",
  });
  expect(activateRes.status).toBe(200);
  return { planId, cycleId };
}

async function transitionCycle(
  key: string,
  planId: number,
  cycleId: number,
  status: string,
): Promise<void> {
  await ensureFixtureOrchestrator(key);
  const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  expect(res.status).toBe(200);
}

async function registerBound(
  key: string,
  agentId: string,
  phase: string,
  cycleId: number,
): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, phase, cycleId });
  expect(res.status).toBe(200);
}

async function registerUnbound(key: string, agentId: string, phase: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, phase });
  expect(res.status).toBe(200);
}

/** Builds a passing-summary parsed-run body (never triggers the unrelated afterRed help). */
function parsedRunBody(overrides: {
  projectKey: string;
  agentId: string;
  context?: Record<string, unknown>;
  summary?: Partial<RunSummary>;
}) {
  return {
    projectKey: overrides.projectKey,
    agentId: overrides.agentId,
    summary: {
      total: 3,
      passed: 3,
      failed: 0,
      pending: 0,
      duration_ms: 42,
      ...overrides.summary,
    },
    tree: [
      {
        name: "suite",
        status: "pass",
        children: [{ name: "t1", status: "pass", duration_ms: 10 }],
      },
    ] as SuiteNode[],
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
  };
}

async function postParsedRun(
  key: string,
  agentId: string,
  context?: Record<string, unknown>,
): Promise<Response> {
  return postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key, agentId, context }));
}

async function eventsForProject(key: string): Promise<EventBrief[]> {
  const res = await getJson(`/api/v2/events?project=${key}`);
  const body = (await res.json()) as EventsListResponse;
  return body.events;
}

/**
 * `eventsForProject` also surfaces the "registered" lifecycle event every
 * `registerBound`/`registerUnbound` call appends (CR-CRU-011 §S1) — filter
 * down to `kind === "test"` so run-ingest counting assertions aren't thrown
 * off by the registration noise a bound-agent test always has at least one
 * of.
 */
async function testEventsForProject(key: string): Promise<EventBrief[]> {
  return (await eventsForProject(key)).filter((e) => e.kind === "test");
}

async function eventsForCycle(key: string, cycleId: number): Promise<EventBrief[]> {
  const res = await getJson(`/api/v2/events?project=${key}&cycleId=${cycleId}`);
  const body = (await res.json()) as EventsListResponse;
  return body.events;
}

function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`.toLowerCase();
}

describe("§S3.1 — a BOUND agent's ingest with NO context.cycleId is server-stamped from its binding", () => {
  test("run ingest with no context field at all -> 200, the STORED event's context.cycleId equals the agent's registered boundCycleId (server-stamped, no client-resolved cycle sent)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C2-stamp-runs");
    const agentId = "stamp-bound-1";
    await registerBound(key, agentId, "RED", cycleId);

    const before = await testEventsForProject(key);
    expect(before.length).toBe(0);

    const res = await postParsedRun(key, agentId, undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);

    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    // POSITIVE — the exact bound cycle id, stamped with no client input.
    expect(events[0]!.context?.cycleId).toBe(cycleId);
  });
});

describe("§S3.2 regression guard — an explicit context.cycleId MATCHING the binding is accepted (belt-and-braces)", () => {
  test("run ingest whose explicit context.cycleId equals the agent's OWN binding -> 200, event stored and linked to that cycle, no conflict raised", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C2-stamp-matching");
    const agentId = "stamp-bound-matching-1";
    await registerBound(key, agentId, "GREEN", cycleId);

    const res = await postParsedRun(key, agentId, { cycleId });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    // NEGATIVE — a matching explicit cycleId must never be treated as a
    // conflict (no conflict wording anywhere in the response envelope).
    expect(JSON.stringify(body).toLowerCase()).not.toContain("conflict");

    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(cycleId);
  });
});

describe("§S3.3 — a BOUND agent's ingest with a CONFLICTING explicit context.cycleId is REFUSED (409)", () => {
  test("run ingest whose explicit context.cycleId names a DIFFERENT (but real, active) cycle than the agent's binding -> 409, ok:false, help names BOTH the binding and the conflicting id, run NOT stored", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId: boundCycleId } = await fileAndActivate(key, "CR-CRU-056-C2-conflict-bound");
    const { cycleId: conflictingCycleId } = await fileAndActivate(key, "CR-CRU-056-C2-conflict-other");
    const agentId = "stamp-bound-conflict-1";
    await registerBound(key, agentId, "FIX", boundCycleId);

    const res = await postParsedRun(key, agentId, { cycleId: conflictingCycleId });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as unknown[]).length).toBeGreaterThan(0);
    // POSITIVE — help names BOTH ids so the caller can see exactly what
    // conflicted with what.
    const surface = errorSurface(body);
    expect(surface).toContain(String(boundCycleId));
    expect(surface).toContain(String(conflictingCycleId));

    // NEGATIVE — nothing stored on a refused ingest.
    const events = await testEventsForProject(key);
    expect(events.length).toBe(0);
  });
});

describe("§S3.4 — a BOUND agent's ingest AFTER its cycle is done is REFUSED (409), with no spill into another project's active cycle", () => {
  test("two-plans-two-cycles fixture (2026-08-01 mis-attach scenario, inverted): binding cycle A transitions to done while cycle B (a SIBLING plan) stays active -> ingest against the now-done binding -> 409, run NOT stored anywhere, and cycle B's own event feed stays EMPTY (no silent spill)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { planId: planA, cycleId: cycleA } = await fileAndActivate(key, "CR-CRU-056-C2-done-A");
    const { cycleId: cycleB } = await fileAndActivate(key, "CR-CRU-056-C2-done-B");
    const agentId = "stamp-bound-done-1";
    await registerBound(key, agentId, "VERIFY", cycleA);

    // Mirrors 2026-08-01 live: plan A's cycle finishes while plan B's cycle
    // (an entirely different plan) is STILL active in the same project.
    await transitionCycle(key, planA, cycleA, "done");

    const res = await postParsedRun(key, agentId, undefined);

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as unknown[]).length).toBeGreaterThan(0);

    // NEGATIVE — no event anywhere in the project...
    const projectEvents = await testEventsForProject(key);
    expect(projectEvents.length).toBe(0);
    // ...and specifically NOT silently attributed to the sibling's still-
    // active cycle B (the exact failure mode this CR closes).
    const cycleBEvents = await eventsForCycle(key, cycleB);
    expect(cycleBEvents.length).toBe(0);
  });
});

describe("§S3.5 regression guard — an UNBOUND report-phase agent's ingest is UNCHANGED (CR-CRU-024 §S7)", () => {
  test("unbound report-phase agent, explicit VALID context.cycleId -> 200, attaches to that cycle exactly as before (§S7 unchanged)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C2-unbound-report-explicit");
    const agentId = "unbound-report-1";
    await registerUnbound(key, agentId, "report");

    const res = await postParsedRun(key, agentId, { cycleId });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);

    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(cycleId);
  });

  test("unbound report-phase agent, NO context at all -> 200, event stored CYCLE-LESS (no context.cycleId fabricated) exactly as before (§S7 unchanged)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const agentId = "unbound-report-2";
    await registerUnbound(key, agentId, "report");

    const res = await postParsedRun(key, agentId, undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);

    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    // NEGATIVE — no cycle fabricated for an unbound agent with no explicit context.
    expect(events[0]!.context?.cycleId).toBeUndefined();
  });
});

describe("§S3.6 — §S2's consumer sweep, second surface: gate-snapshot ingest is ALSO server-stamped from a bound agent's binding", () => {
  test("POST /api/v2/gates from a BOUND agent with no explicit context -> 201, the STORED gate event's context.cycleId equals the agent's boundCycleId (same stamping as runs)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C2-stamp-gates");
    const agentId = "stamp-bound-gate-1";
    await registerBound(key, agentId, "VERIFY", cycleId);

    const res = await postJson("/api/v2/gates", {
      projectKey: key,
      agentId,
      gate: { intent: "verify", outcome: "passed", steps: [] },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);

    const events = await eventsForProject(key);
    const gateEvent = events.find((e) => e.kind === "gate");
    expect(gateEvent).toBeDefined();
    // POSITIVE — the exact bound cycle id, stamped with no client input.
    expect(gateEvent!.context?.cycleId).toBe(cycleId);
  });
});

// ── C5 (VERIFY fix round) — the ingest RESPONSE echoes the attachment ───────
//
// §S3 moved cycle attachment SERVER-side, but the ingest response only ever
// returned {ok, changed, event, run, verdict, help}: an agent that had just
// ingested could not tell from the response WHICH cycle absorbed its
// evidence, and had to issue a second GET /api/v2/events to find out. That is
// an observability regression against the pre-CR behavior (where the client
// resolved the cycle itself and echoed it) and against the content-first
// discipline the rest of this CR honours. The response now echoes the applied
// attachment on `context.cycleId` — the SAME path the events read-side
// already serves, so the echo is a drop-in for the follow-up GET.

describe("§S3.7 (C5) — the ingest RESPONSE echoes the cycle the server attached the run to", () => {
  test("BOUND agent, run ingest with no context at all -> the 200 response itself carries context.cycleId === the binding, matching the STORED event (no second GET needed)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C5-echo-runs");
    const agentId = "echo-bound-1";
    await registerBound(key, agentId, "RED", cycleId);

    const res = await postParsedRun(key, agentId, undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    // POSITIVE — the response NAMES the attachment the server applied.
    expect(body.context?.cycleId).toBe(cycleId);

    // ...and it agrees with what actually landed in the feed: the echo is a
    // faithful read-back of the stored event, never an independent guess.
    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    expect(body.context?.cycleId).toBe(events[0]!.context!.cycleId!);
    // Additive: the pre-existing envelope fields are untouched.
    expect(body.changed).toBe(true);
    expect(typeof body.event).toBe("string");
    expect(body.run).toBeDefined();
    expect(typeof body.verdict).toBe("string");
  });

  test("UNBOUND report-phase agent, cycle-less ingest -> 200 with NO cycle fabricated in the response echo (absence is stated by omission, never invented)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const agentId = "echo-unbound-1";
    await registerUnbound(key, agentId, "report");

    const res = await postParsedRun(key, agentId, undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    // NEGATIVE — the event was stored cycle-less, so the echo carries no
    // cycle: no null, no zero, no active-cycle guess.
    expect(body.context?.cycleId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("cycleId");

    const events = await testEventsForProject(key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBeUndefined();
  });

  test("UNBOUND report-phase agent with an explicit VALID context.cycleId -> the response echoes THAT id (the echo reports what was applied, however it was applied)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C5-echo-explicit");
    const agentId = "echo-unbound-explicit-1";
    await registerUnbound(key, agentId, "report");

    const res = await postParsedRun(key, agentId, { cycleId });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.context?.cycleId).toBe(cycleId);
  });

  test("BOUND agent, gate ingest -> the 201 response echoes context.cycleId on the SAME path as the run response (both stamped surfaces answer identically)", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const { cycleId } = await fileAndActivate(key, "CR-CRU-056-C5-echo-gates");
    const agentId = "echo-bound-gate-1";
    await registerBound(key, agentId, "VERIFY", cycleId);

    const res = await postJson("/api/v2/gates", {
      projectKey: key,
      agentId,
      gate: { intent: "verify", outcome: "passed", steps: [] },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.context?.cycleId).toBe(cycleId);
  });

  test("UNBOUND agent's gate ingest with no context -> 201 with no fabricated cycle in the echo", async () => {
    const handle_ = boot();
    const key = seedProject(handle_.store);
    const agentId = "echo-unbound-gate-1";
    await registerUnbound(key, agentId, "report");

    const res = await postJson("/api/v2/gates", {
      projectKey: key,
      agentId,
      gate: { intent: "verify", outcome: "passed", steps: [] },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.context?.cycleId).toBeUndefined();
  });
});
