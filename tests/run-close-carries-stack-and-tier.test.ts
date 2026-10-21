// A run opened through `POST /api/v2/runs/start` states its stack and tier
// once; the ingest that closes it (on `/api/v2/runs`, `/api/v2/runs/parsed` or
// `/api/v2/runs/compile`, carrying the `runId`) must not lose them, and must
// not change them:
//
//  - a closing ingest that states neither stack nor tier gets an event whose
//    detail carries the start's stack and tier;
//  - a closing ingest whose stack, or tier, differs from its start's is refused
//    with 400 naming both values — nothing is stored, the agent row is not
//    touched, and the run stays open;
//  - a `stack` that is present (on the start or on any ingest) must be a
//    non-empty string — `""` or a non-string is refused with 400 and nothing
//    is stored.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); every outcome is read back through the board's own reads — the
// event detail `GET /api/v2/events/<id>`, the events list (its `events` and
// `openRuns`) and the agents list `GET /api/v2/agents?project=…`.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Posted> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function seedProject(handle: ServerHandle): string {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  return key;
}

async function register(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

async function startRun(
  handle: ServerHandle,
  key: string,
  agentId: string,
  meta: { stack?: string; tier?: string },
): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId, ...meta });
  expect(res.status).toBe(202);
  const runId = res.body.runId;
  expect(typeof runId).toBe("string");
  return runId as string;
}

interface EventDetail {
  id: string;
  tier?: string;
  stack?: string;
  [key: string]: unknown;
}

async function eventDetail(handle: ServerHandle, eventId: string): Promise<EventDetail> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  return body.event as EventDetail;
}

async function eventIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.events as { id: string }[]).map((e) => e.id);
}

async function openRunIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.openRuns as { runId: string }[]).map((r) => r.runId);
}

interface AgentBrief {
  agentId: string;
  message: string;
  lastSeen: number;
  [key: string]: unknown;
}

async function agentById(handle: ServerHandle, key: string, agentId: string): Promise<AgentBrief> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  const agent = (body.agents as AgentBrief[]).find((a) => a.agentId === agentId);
  expect(agent).toBeDefined();
  return agent!;
}

// ── The three ingest routes, each with a minimal body it accepts ────────────

type IngestRoute = "/api/v2/runs" | "/api/v2/runs/parsed" | "/api/v2/runs/compile";

const INGEST_ROUTES: readonly IngestRoute[] = [
  "/api/v2/runs",
  "/api/v2/runs/parsed",
  "/api/v2/runs/compile",
];

const JUNIT_ONE_PASS = [
  '<testsuite name="Suite" tests="1">',
  '<testcase name="t1" time="0.01"/>',
  "</testsuite>",
].join("\n");

const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

/** The route's own payload — no stack, no tier, no runId. */
function payloadFor(route: IngestRoute): Record<string, unknown> {
  switch (route) {
    case "/api/v2/runs":
      return { codec: "junit", data: JUNIT_ONE_PASS };
    case "/api/v2/runs/parsed":
      return {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
        tree: [{ name: "Suite", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 10 }] }],
      };
    case "/api/v2/runs/compile":
      return { format: "tsc", errors: TSC_ONE_ERROR };
  }
}

function ingestBody(
  route: IngestRoute,
  key: string,
  agentId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { projectKey: key, agentId, ...payloadFor(route), ...extra };
}

// ── Carried across the close ────────────────────────────────────────────────

describe("an ingest that closes a run keeps the stack and tier its start stated", () => {
  for (const route of INGEST_ROUTES) {
    test(`a run started with stack and tier, closed on ${route} by an ingest stating neither, gets an event carrying the start's stack and tier`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "closer-silent";
      await register(handle, key, agentId);
      const runId = await startRun(handle, key, agentId, { stack: "bun", tier: "integration" });

      const res = await postJson(handle, route, ingestBody(route, key, agentId, { runId }));
      expect(res.status).toBe(200);
      const eventId = res.body.event as string;
      expect(eventId).toMatch(/^evt-/);

      const event = await eventDetail(handle, eventId);
      expect(event.id).toBe(eventId);
      expect(event.stack).toBe("bun");
      expect(event.tier).toBe("integration");
      // The run was closed by that event — no longer open.
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });

    test(`regression guard: a run started with NO stack and closed on ${route} by an ingest stating one gets an event carrying the ingest's stack`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "closer-states-stack";
      await register(handle, key, agentId);
      const runId = await startRun(handle, key, agentId, {});

      const res = await postJson(handle, route, ingestBody(route, key, agentId, { runId, stack: "python" }));
      expect(res.status).toBe(200);
      const eventId = res.body.event as string;

      const event = await eventDetail(handle, eventId);
      expect(event.id).toBe(eventId);
      expect(event.stack).toBe("python");
      expect(event.tier).toBe("unit");
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });
  }
});

// ── No change mid-run ───────────────────────────────────────────────────────

/**
 * Open a run under `start`, post the agent's own heartbeat message, then
 * snapshot everything a refused close must leave untouched.
 */
async function openRunWithSnapshot(
  handle: ServerHandle,
  key: string,
  agentId: string,
  start: { stack: string; tier: string },
): Promise<{ runId: string; events: string[]; message: string; lastSeen: number }> {
  await register(handle, key, agentId);
  const runId = await startRun(handle, key, agentId, start);
  const beat = await postJson(handle, "/api/v2/agents/heartbeat", {
    projectKey: key,
    agentId,
    message: "running the suite",
  });
  expect(beat.status).toBe(200);
  const agent = await agentById(handle, key, agentId);
  expect(agent.message).toBe("running the suite");
  const events = await eventIds(handle, key);
  // Let the clock move on, so a touch of the agent row would show in lastSeen.
  await Bun.sleep(15);
  return { runId, events, message: agent.message, lastSeen: agent.lastSeen };
}

async function expectNothingChanged(
  handle: ServerHandle,
  key: string,
  agentId: string,
  snapshot: { runId: string; events: string[]; message: string; lastSeen: number },
): Promise<void> {
  // No event stored.
  expect(await eventIds(handle, key)).toEqual(snapshot.events);
  // The agent row is not touched.
  const agent = await agentById(handle, key, agentId);
  expect(agent.message).toBe(snapshot.message);
  expect(agent.lastSeen).toBe(snapshot.lastSeen);
  // The run is still open on the board.
  expect(await openRunIds(handle, key)).toContain(snapshot.runId);
}

describe("an ingest that closes a run cannot change its stack or tier", () => {
  for (const route of INGEST_ROUTES) {
    test(`a closing ingest on ${route} whose stack differs from its start's is refused 400 naming both stacks, storing nothing and leaving the run open`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "closer-stack-change";
      const snap = await openRunWithSnapshot(handle, key, agentId, { stack: "bun", tier: "integration" });

      const res = await postJson(
        handle,
        route,
        ingestBody(route, key, agentId, { runId: snap.runId, stack: "mvn", tier: "integration" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.event).toBeUndefined();
      const error = res.body.error as string;
      expect(typeof error).toBe("string");
      expect(error).toContain("bun");
      expect(error).toContain("mvn");

      await expectNothingChanged(handle, key, agentId, snap);
    });

    test(`a closing ingest on ${route} whose tier differs from its start's is refused 400 naming both tiers, storing nothing and leaving the run open`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "closer-tier-change";
      const snap = await openRunWithSnapshot(handle, key, agentId, { stack: "bun", tier: "integration" });

      const res = await postJson(
        handle,
        route,
        ingestBody(route, key, agentId, { runId: snap.runId, stack: "bun", tier: "e2e" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.event).toBeUndefined();
      const error = res.body.error as string;
      expect(typeof error).toBe("string");
      expect(error).toContain("integration");
      expect(error).toContain("e2e");

      await expectNothingChanged(handle, key, agentId, snap);
    });

    test(`regression guard: a closing ingest on ${route} stating the same stack and tier as its start is accepted and its event carries them`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "closer-same-values";
      await register(handle, key, agentId);
      const runId = await startRun(handle, key, agentId, { stack: "bun", tier: "integration" });

      const res = await postJson(
        handle,
        route,
        ingestBody(route, key, agentId, { runId, stack: "bun", tier: "integration" }),
      );
      expect(res.status).toBe(200);
      const eventId = res.body.event as string;

      const event = await eventDetail(handle, eventId);
      expect(event.stack).toBe("bun");
      expect(event.tier).toBe("integration");
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });
  }
});

// ── A stack is a word ───────────────────────────────────────────────────────

const NOT_A_WORD: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "an empty string", value: "" },
  { label: "a number", value: 42 },
  { label: "an object", value: {} },
];

describe("a stated stack must be a non-empty string", () => {
  for (const bad of NOT_A_WORD) {
    test(`a run start stating ${bad.label} as its stack is refused 400 and opens no run`, async () => {
      const handle = boot();
      const key = seedProject(handle);
      const agentId = "starter-bad-stack";
      await register(handle, key, agentId);
      const eventsBefore = await eventIds(handle, key);
      expect(await openRunIds(handle, key)).toEqual([]);

      const res = await postJson(handle, "/api/v2/runs/start", {
        projectKey: key,
        agentId,
        stack: bad.value,
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.runId).toBeUndefined();
      expect(String(res.body.error)).toContain("stack");

      expect(await openRunIds(handle, key)).toEqual([]);
      expect(await eventIds(handle, key)).toEqual(eventsBefore);
    });

    for (const route of INGEST_ROUTES) {
      test(`an ingest on ${route} stating ${bad.label} as its stack is refused 400 and stores no event`, async () => {
        const handle = boot();
        const key = seedProject(handle);
        const agentId = "ingester-bad-stack";
        await register(handle, key, agentId);
        const eventsBefore = await eventIds(handle, key);

        const res = await postJson(handle, route, ingestBody(route, key, agentId, { stack: bad.value }));
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.event).toBeUndefined();
        expect(String(res.body.error)).toContain("stack");

        expect(await eventIds(handle, key)).toEqual(eventsBefore);
      });
    }
  }
});
