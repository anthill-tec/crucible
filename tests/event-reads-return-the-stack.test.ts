// Every read that serves an event as a BRIEF returns the event's stored
// `stack` when it has one, and has no `stack` key at all when it has none.
//
// The brief-served reads (each one built by `eventBrief`, src/v2.ts):
//  - the events list `GET /api/v2/events?project=…` (`events[]`);
//  - its cycle-anchored form `…&cycleId=<id>` (`events[]`);
//  - its release-anchored form `…&release=<label>` (`events[]`);
//  - `GET /api/v2/status?project=…` — `status.lastTest` / `status.lastCompile`;
//  - `GET /api/v2/projects` — each project's `lastEvent`.
// Beside them, the detail read `GET /api/v2/events/<id>` serves the full event
// and already carries the stack; it is checked here as a guard.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store): events are ingested on each of the three ingest routes
// (`/api/v2/runs`, `/api/v2/runs/parsed`, `/api/v2/runs/compile`) and read back
// through the board's own reads.
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

interface Answered {
  status: number;
  body: Record<string, unknown>;
}

async function sendJson(
  handle: ServerHandle,
  method: "POST" | "PATCH",
  route: string,
  body: unknown,
): Promise<Answered> {
  const res = await fetch(`${base(handle)}${route}`, {
    method,
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

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORCHESTRATOR = "fixture-orch";

/** A project with its orchestrator registered (plans and ingests need a live caller). */
async function seedProject(handle: ServerHandle): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: `stack-reads-${key}`, type: "backend", sutRoot: "/tmp/p" });
  const res = await sendJson(handle, "POST", "/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  // Let the clock move past the registration's own lifecycle row, so the
  // ingest that follows is the project's newest event.
  await Bun.sleep(5);
  return key;
}

/** File a one-cycle plan and activate its cycle; returns the cycle id. */
async function activeCycle(handle: ServerHandle, key: string): Promise<number> {
  const filed = await sendJson(handle, "POST", `/api/v2/projects/${key}/plans`, {
    agentId: ORCHESTRATOR,
    cr: "CR-STACK-READS",
    cycles: [{ label: "A" }],
  });
  expect(filed.status).toBe(201);
  const planId = filed.body.planId as number | string;
  const cycleId = (filed.body.cycles as { id: number }[])[0]!.id;
  const moved = await sendJson(handle, "PATCH", `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    agentId: ORCHESTRATOR,
    status: "active",
  });
  expect(moved.status).toBe(200);
  await Bun.sleep(5);
  return cycleId;
}

/** Declare a release on the project's roadmap so runs may be filed under it. */
function declareRelease(handle: ServerHandle, key: string, label: string): void {
  handle.store.recordReleaseProposal(key, "fixture-setup", {
    label,
    targetAt: Math.floor(Date.now() / 1000) + 86_400,
  });
}

// ── The three ingest routes, each with a minimal body it accepts ────────────

type IngestRoute = "/api/v2/runs" | "/api/v2/runs/parsed" | "/api/v2/runs/compile";

/** Each route with a distinct stack, so a hard-coded or crossed value shows. */
const ROUTES: ReadonlyArray<{ route: IngestRoute; stack: string }> = [
  { route: "/api/v2/runs", stack: "mvn" },
  { route: "/api/v2/runs/parsed", stack: "python" },
  { route: "/api/v2/runs/compile", stack: "rust" },
];

const JUNIT_ONE_PASS = [
  '<testsuite name="Suite" tests="1">',
  '<testcase name="t1" time="0.01"/>',
  "</testsuite>",
].join("\n");

const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

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

/** Ingest on `route` as the orchestrator; returns the stored event id. */
async function ingest(
  handle: ServerHandle,
  key: string,
  route: IngestRoute,
  extra: Record<string, unknown>,
): Promise<string> {
  const res = await sendJson(handle, "POST", route, {
    projectKey: key,
    agentId: ORCHESTRATOR,
    ...payloadFor(route),
    ...extra,
  });
  expect(res.status).toBe(200);
  const eventId = res.body.event as string;
  expect(eventId).toMatch(/^evt-/);
  return eventId;
}

async function startRun(handle: ServerHandle, key: string, stack: string): Promise<string> {
  const res = await sendJson(handle, "POST", "/api/v2/runs/start", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    stack,
  });
  expect(res.status).toBe(202);
  const runId = res.body.runId;
  expect(typeof runId).toBe("string");
  return runId as string;
}

// ── The reads ───────────────────────────────────────────────────────────────

type Brief = Record<string, unknown> & { id: string };

/** The ONE entry of `events` carrying `eventId` (exactly one, never more). */
function onlyEntry(events: Brief[], eventId: string): Brief {
  const hits = events.filter((e) => e.id === eventId);
  expect(hits.length).toBe(1);
  return hits[0]!;
}

async function fromPlainList(handle: ServerHandle, key: string, eventId: string): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
  return onlyEntry(body.events as Brief[], eventId);
}

async function fromCycleList(
  handle: ServerHandle,
  key: string,
  cycleId: number,
  eventId: string,
): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&cycleId=${cycleId}`);
  const events = body.events as Brief[];
  expect(events.length).toBe(1);
  return onlyEntry(events, eventId);
}

async function fromReleaseList(
  handle: ServerHandle,
  key: string,
  release: string,
  eventId: string,
): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&release=${encodeURIComponent(release)}`);
  const events = body.events as Brief[];
  expect(events.length).toBe(1);
  return onlyEntry(events, eventId);
}

/** `status.lastCompile` for the compile route, `status.lastTest` otherwise. */
async function fromStatus(
  handle: ServerHandle,
  key: string,
  route: IngestRoute,
  eventId: string,
): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/status?project=${key}`);
  const status = body.status as Record<string, Brief | null>;
  const brief = route === "/api/v2/runs/compile" ? status.lastCompile : status.lastTest;
  expect(brief).not.toBeNull();
  expect(brief!.id).toBe(eventId);
  return brief!;
}

async function fromProjectLastEvent(handle: ServerHandle, key: string, eventId: string): Promise<Brief> {
  const body = await getJson(handle, "/api/v2/projects");
  const projects = (body.projects as { key: string; lastEvent: Brief | null }[]).filter((p) => p.key === key);
  expect(projects.length).toBe(1);
  const lastEvent = projects[0]!.lastEvent;
  expect(lastEvent).not.toBeNull();
  expect(lastEvent!.id).toBe(eventId);
  return lastEvent!;
}

async function fromDetail(handle: ServerHandle, eventId: string): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  const event = body.event as Brief;
  expect(event.id).toBe(eventId);
  return event;
}

// ── An event ingested with a stack reads it back everywhere ────────────────

describe("an event ingested with a stack reads it back on every brief-served read", () => {
  for (const { route, stack } of ROUTES) {
    test(`an event ingested on ${route} stating stack "${stack}" carries it on the events list brief`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const eventId = await ingest(handle, key, route, { stack });

      const brief = await fromPlainList(handle, key, eventId);
      expect(brief.stack).toBe(stack);
    });

    test(`an event ingested on ${route} stating stack "${stack}" beside a cycle carries it on the cycle-anchored events list brief`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const cycleId = await activeCycle(handle, key);
      const eventId = await ingest(handle, key, route, { stack, context: { cycleId } });

      const brief = await fromCycleList(handle, key, cycleId, eventId);
      expect(brief.cycleId).toBe(cycleId);
      expect(brief.stack).toBe(stack);
    });

    test(`an event ingested on ${route} stating stack "${stack}" under a release carries it on the release-anchored events list brief`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      declareRelease(handle, key, "4.2.0");
      const eventId = await ingest(handle, key, route, { stack, release: "4.2.0" });

      const brief = await fromReleaseList(handle, key, "4.2.0", eventId);
      expect(brief.release).toBe("4.2.0");
      expect(brief.stack).toBe(stack);
    });

    const statusField = route === "/api/v2/runs/compile" ? "lastCompile" : "lastTest";
    test(`an event ingested on ${route} stating stack "${stack}" carries it on the status read's ${statusField}`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const eventId = await ingest(handle, key, route, { stack });

      const brief = await fromStatus(handle, key, route, eventId);
      expect(brief.stack).toBe(stack);
    });

    test(`an event ingested on ${route} stating stack "${stack}" carries it on its project's lastEvent in the projects list`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const eventId = await ingest(handle, key, route, { stack });

      const brief = await fromProjectLastEvent(handle, key, eventId);
      expect(brief.stack).toBe(stack);
    });

    test(`regression guard: an event ingested on ${route} stating stack "${stack}" carries it on the event detail read`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const eventId = await ingest(handle, key, route, { stack });

      const event = await fromDetail(handle, eventId);
      expect(event.stack).toBe(stack);
    });
  }
});

// ── A run's stack, from its start, reaches the list ─────────────────────────

describe("a run's event carries its start's stack on the events list", () => {
  for (const { route, stack } of ROUTES) {
    test(`a run started with stack "${stack}" and closed on ${route} by an ingest stating none carries the start's stack on the events list brief`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const runId = await startRun(handle, key, stack);
      const eventId = await ingest(handle, key, route, { runId });

      const brief = await fromPlainList(handle, key, eventId);
      expect(brief.stack).toBe(stack);
    });
  }

  test(`an aborted run started with stack "bun" carries that stack on its aborted event's events list brief`, async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const runId = await startRun(handle, key, "bun");
    const aborted = await sendJson(handle, "POST", `/api/v2/runs/${runId}/abort`, {
      projectKey: key,
      agentId: ORCHESTRATOR,
      reason: "the suite was interrupted",
    });
    expect(aborted.status).toBe(200);

    const body = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
    const abortedEvents = (body.events as Brief[]).filter((e) => e.status === "aborted");
    expect(abortedEvents.length).toBe(1);
    expect(abortedEvents[0]!.abortReason).toBe("the suite was interrupted");
    expect(abortedEvents[0]!.stack).toBe("bun");
  });
});

// ── Absent means absent ─────────────────────────────────────────────────────

function expectNoStackKey(brief: Brief, read: string): void {
  // The key itself is absent — never present as null, undefined or a default.
  expect({ read, hasStackKey: Object.hasOwn(brief, "stack") }).toEqual({ read, hasStackKey: false });
}

describe("regression guard: an event never told its stack has no stack key on any read", () => {
  for (const { route } of ROUTES) {
    test(`regression guard: events ingested on ${route} with no stack and no started stack carry no stack key on the list, cycle, release, status, lastEvent and detail reads`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const cycleId = await activeCycle(handle, key);
      declareRelease(handle, key, "4.3.0");

      const inCycle = await ingest(handle, key, route, { context: { cycleId } });
      await Bun.sleep(5);
      const inRelease = await ingest(handle, key, route, { release: "4.3.0" });
      await Bun.sleep(5);
      const plain = await ingest(handle, key, route, {});

      expectNoStackKey(await fromPlainList(handle, key, plain), "events list");
      expectNoStackKey(await fromCycleList(handle, key, cycleId, inCycle), "cycle-anchored list");
      expectNoStackKey(await fromReleaseList(handle, key, "4.3.0", inRelease), "release-anchored list");
      expectNoStackKey(await fromStatus(handle, key, route, plain), "status");
      expectNoStackKey(await fromProjectLastEvent(handle, key, plain), "projects lastEvent");
      expectNoStackKey(await fromDetail(handle, plain), "event detail");
    });
  }
});
