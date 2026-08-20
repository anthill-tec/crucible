// CR-CRU-017 §S3 — the READ surface the UI's running/aborted cards stand on.
//
// §S1 gave the server a run LIFECYCLE (an open run in SQLite, an auto-abort
// sweep, lifecycle columns on the settling event) but no way to READ any of it:
// `GET /api/v2/events` served neither the open runs nor the settling event's
// lifecycle fields, so a dashboard could not paint a "running…" card at all and
// could not tell an aborted run from a passing one. §S3 ("Timeline shows an
// OPEN run as a live running… card … the aborted card") is unimplementable
// without that surface, so this cycle added exactly two additive things:
//
//   Store#listOpenRuns(projectKey?) -> RunRecord[]        // newest-first
//   GET /api/v2/events -> { …, openRuns: [ {runId, projectKey, agentId,
//                                           startedAt, tier?, stack?,
//                                           context?} ] }
//   GET /api/v2/events -> events[i] additionally carries startedAt,
//                         runtime_ms, status, abortReason — each ABSENT
//                         (never null) on an event with no run behind it.
//
// This suite is that contract's own pin: it fails if a later CR drops
// `openRuns`, renames a lifecycle key, starts serving nulls, keeps serving a
// settled run as open, or recomputes runtime_ms at serve time instead of
// forwarding the stored value. tests/run-lifecycle.test.ts owns §S0/§S1 and is
// not touched by this file; the graceful-degradation guard it pins is asserted
// here again from the BRIEF's side, because that is the shape this CR changed.
//
// REAL TIMERS, DELIBERATELY (the same exception tests/run-lifecycle.test.ts
// documents): the subject here IS wall-clock time — `startedAt` and
// `runtime_ms` are produced by the SERVER's own clock inside a separate
// request, and the auto-abort trigger is a staleness deadline that same clock
// reads. Fake timers would advance THIS process's clock, not the clock under
// test, so the assertions would measure nothing. Delays are therefore the
// smallest that clear the deadline they test, and the abort case awaits the
// CONDITION (polling the real read surface) instead of a guessed duration.
//
// SAFETY: every server binds port 0 (never the dog-food 3849) and every store
// is ":memory:" — `data/crucible.db` is never opened.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const handles: ServerHandle[] = [];
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
});

function boot(dbPath = ":memory:"): ServerHandle {
  const handle = startServer({ port: 0, dbPath });
  handles.push(handle);
  return handle;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.server.port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${handle.server.port}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface LivenessOverride {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

function seedProject(handle: ServerHandle, liveness?: LivenessOverride): string {
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "P",
    type: "backend",
    sutRoot: "/tmp/p",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  return key;
}

// ORCHESTRATOR for the same reason tests/run-lifecycle.test.ts uses it: a bound
// TDD role is orthogonal to the read surface (CR-CRU-056 §S2's 409 is not the
// subject here).
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
  extra: Record<string, unknown> = {},
): Promise<{ runId: string; startedAt: number }> {
  const res = await postJson(handle, "/api/v2/runs/start", {
    projectKey: key,
    agentId,
    ...extra,
  });
  expect(res.status).toBe(202);
  return (await res.json()) as { runId: string; startedAt: number };
}

const PARSED_RUN = {
  summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 7 },
  tree: [
    { name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 7 }] },
  ],
};

interface OpenRunBrief {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  tier?: string;
  context?: Record<string, unknown>;
}

function openRunsOf(body: Record<string, unknown>): OpenRunBrief[] {
  const runs = body.openRuns;
  if (!Array.isArray(runs)) {
    throw new Error(
      "CR-CRU-017 §S3: GET /api/v2/events must serve an additive `openRuns` array — the " +
        `timeline's live "running…" card has no other source. Got: ${JSON.stringify(runs)}`,
    );
  }
  return runs as OpenRunBrief[];
}

const eventsOf = (body: Record<string, unknown>) => body.events as Record<string, unknown>[];

/**
 * The RUN events only. Registering an agent stores a `lifecycle` event, which
 * the feed serves alongside runs (and which the timeline never renders as a
 * card), so every count assertion below is about this slice.
 */
const runEventsOf = (body: Record<string, unknown>) =>
  eventsOf(body).filter((e) => e.kind !== "lifecycle");

/**
 * A filed plan's FIRST cycle id, activated — the only kind of cycleId the
 * ingest/start attach boundary accepts (a made-up id is a 400, by design), and
 * what §S3's Workflow-tab AC needs a running run to be bound to.
 */
async function activeCycleId(handle: ServerHandle, key: string, agentId: string): Promise<number> {
  const filed = await postJson(handle, `/api/v2/projects/${key}/plans`, {
    cr: "CR-READ-SURFACE",
    agentId,
    cycles: [{ label: "C1", kind: "red-green" }],
  });
  expect(filed.ok).toBe(true);
  const plan = (await filed.json()) as { planId: number; cycles: { id: number }[] };
  const cycleId = plan.cycles[0]?.id as number;
  const activated = await fetch(
    `http://127.0.0.1:${handle.server.port}/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active", agentId }),
    },
  );
  expect(activated.ok).toBe(true);
  return cycleId;
}

describe("CR-CRU-017 §S3-R1 — an OPEN run is READABLE: the events list serves it under `openRuns`, with the startedAt an elapsed timer counts from", () => {
  test("a started-but-unsettled run appears with its runId/agentId/startedAt and its start context, and carries NO counts or event id (a start is not an end)", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-a");
    const cycleId = await activeCycleId(handle, key, "reader-a");
    const started = await startRun(handle, key, "reader-a", {
      tier: "unit",
      context: { cycleId },
    });

    const body = await getJson(handle, `/api/v2/events?project=${key}`);
    const open = openRunsOf(body);
    expect(open).toHaveLength(1);
    expect(open[0]?.runId).toBe(started.runId);
    expect(open[0]?.agentId).toBe("reader-a");
    expect(open[0]?.projectKey).toBe(key);
    // The timer's origin — the SERVER's startedAt, byte-equal to the one
    // /runs/start answered, never a re-read of the clock at serve time.
    expect(open[0]?.startedAt).toBe(started.startedAt);
    expect(open[0]?.tier).toBe("unit");
    // §S3's Workflow-tab AC ("an active cycle's open span shows its currently
    // running run") can only bind the run to a cycle through this context.
    expect(open[0]?.context?.cycleId).toBe(cycleId);
    // An open run has no event: fabricating counts is exactly what would let a
    // running card be mistaken for a finished one.
    for (const forbidden of ["id", "total", "passed", "failed", "duration_ms", "eventId"]) {
      expect(open[0] as unknown as Record<string, unknown>).not.toHaveProperty(forbidden);
    }
    // No RUN event exists yet either — `events` stays the settled-history feed.
    expect(runEventsOf(body)).toHaveLength(0);
  });

  test("`openRuns` is project-SCOPED like `events`: another project's open run never leaks into a workspace feed", async () => {
    const handle = boot();
    const mine = seedProject(handle);
    const theirs = seedProject(handle);
    await register(handle, mine, "reader-mine");
    await register(handle, theirs, "reader-theirs");
    await startRun(handle, mine, "reader-mine");
    await startRun(handle, theirs, "reader-theirs");

    const scoped = openRunsOf(await getJson(handle, `/api/v2/events?project=${mine}`));
    expect(scoped.map((r) => r.agentId)).toEqual(["reader-mine"]);
    // The collective (home) feed sees both.
    const all = openRunsOf(await getJson(handle, "/api/v2/events"));
    expect(all.map((r) => r.agentId).sort()).toEqual(["reader-mine", "reader-theirs"]);
  });

  test("Store#listOpenRuns is newest-first and returns ONLY open runs — a settled run is gone from it the moment its ingest closes it", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-b");
    const first = await startRun(handle, key, "reader-b");
    await Bun.sleep(5);
    const second = await startRun(handle, key, "reader-b");

    expect(handle.store.listOpenRuns(key).map((r) => r.runId)).toEqual([
      second.runId,
      first.runId,
    ]);
    expect(handle.store.listOpenRuns(key).every((r) => r.state === "open")).toBe(true);

    const ingest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "reader-b",
      runId: first.runId,
      ...PARSED_RUN,
    });
    expect(ingest.status).toBe(200);
    expect(handle.store.listOpenRuns(key).map((r) => r.runId)).toEqual([second.runId]);
  });
});

describe("CR-CRU-017 §S3-R2 — a run RESOLVES on the read surface: the ingest moves it out of `openRuns` and into `events` carrying its lifecycle fields", () => {
  test("after the closing ingest the run is no longer open, and its ONE event brief serves startedAt + runtime_ms (forwarded from the row) alongside the tool-reported duration_ms", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-c");
    const started = await startRun(handle, key, "reader-c");
    await Bun.sleep(30);
    const ingest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "reader-c",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(ingest.status).toBe(200);

    const body = await getJson(handle, `/api/v2/events?project=${key}`);
    expect(openRunsOf(body)).toHaveLength(0);
    const events = runEventsOf(body);
    expect(events).toHaveLength(1);
    const brief = events[0] as Record<string, number>;
    expect(brief.startedAt).toBe(started.startedAt);
    // Forwarded, not recomputed: the brief's runtime_ms is byte-equal to the
    // value the stored event carries. Two sources of truth for this number is
    // precisely the drift this assertion exists to catch.
    const stored = handle.store.getEvent(events[0]?.id as string);
    expect(brief.runtime_ms).toBe(stored?.runtimeMs as number);
    expect(brief.runtime_ms).toBeGreaterThanOrEqual(25);
    // The tool's own duration is untouched and distinct from wall-clock runtime.
    expect(brief.duration_ms).toBe(7);
    expect(brief.runtime_ms).toBeGreaterThan(brief.duration_ms);
    // A cleanly ended run carries NO status/abortReason: not-aborted is
    // expressed by absence, so the UI can never read a passing run as aborted.
    expect(brief).not.toHaveProperty("status");
    expect(brief).not.toHaveProperty("abortReason");
  });
});

describe("CR-CRU-017 §S3-R3 — an ABORTED run is DISTINGUISHABLE on the read surface: status + abortReason travel with the event brief", () => {
  test("an auto-aborted run (agent tombstoned) leaves `openRuns` empty and serves a brief with status 'aborted' and the reason text the aborted card renders", async () => {
    // Staleness ruled out, so the only trigger left is the tombstone.
    setEnv("CRUCIBLE_RUN_ABANDON_MS", "3600000");
    const handle = boot();
    const key = seedProject(handle, {
      staleAfterMs: 5,
      tombstoneAfterMs: 10,
      pruneAfterMs: 3_600_000,
    });
    await register(handle, key, "reader-d");
    await startRun(handle, key, "reader-d");

    // Await the CONDITION, not a guessed duration: each poll is itself the
    // read that sweeps (§S1 settles a dead run inside the events handler), so
    // this loop is the real mechanism the dashboard's refetch drives.
    let body: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      body = await getJson(handle, `/api/v2/events?project=${key}`);
      if (runEventsOf(body).length > 0) break;
      await Bun.sleep(10);
    }
    expect(openRunsOf(body)).toHaveLength(0);
    const events = runEventsOf(body);
    expect(events).toHaveLength(1);
    const brief = events[0] as Record<string, unknown>;
    expect(brief.status).toBe("aborted");
    expect(brief.abortReason).toBe("agent died");
    // Still a run, still kind "test" — the aborted state is a FOURTH
    // presentation, not a new kind (§S2's terminology note).
    expect(brief.kind).toBe("test");
    expect(brief.startedAt).toBeTypeOf("number");
    expect(brief.runtime_ms).toBeTypeOf("number");
  });
});

describe("CR-CRU-017 §S3-R4 — GRACEFUL DEGRADATION holds at the BRIEF: a single-shot ingest serves NONE of the four lifecycle keys — absent, never null", () => {
  test("an ingest with no runId yields a brief carrying no startedAt / runtime_ms / status / abortReason key at all, and `openRuns` is an empty array rather than a missing field", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-e");
    const ingest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "reader-e",
      ...PARSED_RUN,
    });
    expect(ingest.status).toBe(200);

    const body = await getJson(handle, `/api/v2/events?project=${key}`);
    // Present-and-empty, so a consumer never has to distinguish "no open runs"
    // from "this server does not report open runs".
    expect(openRunsOf(body)).toEqual([]);
    const brief = runEventsOf(body)[0] as Record<string, unknown>;
    for (const absent of ["startedAt", "runtime_ms", "status", "abortReason"]) {
      // `not.toHaveProperty` is the strict form the guard needs: a served
      // `null` would satisfy a `toBeUndefined()` check on JSON round-trip and
      // silently weaken §S1's byte-identical regression guarantee.
      expect(brief).not.toHaveProperty(absent);
    }
  });
});

describe("CR-CRU-017 §S3-R5 — the additive field never displaces the existing feed", () => {
  test("the anchored ?cycleId= fetch is byte-unchanged (no openRuns key), and the recent-N feed still serves the same events it did before", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-f");
    const cycleId = await activeCycleId(handle, key, "reader-f");
    await startRun(handle, key, "reader-f", { context: { cycleId } });

    const anchored = await getJson(handle, `/api/v2/events?project=${key}&cycleId=${cycleId}`);
    expect(anchored).not.toHaveProperty("openRuns");
    expect(Array.isArray(anchored.events)).toBe(true);
    // …while the feed the timeline actually renders does report it.
    expect(openRunsOf(await getJson(handle, `/api/v2/events?project=${key}`))).toHaveLength(1);
  });

  test("an ARCHIVED project's open run is excluded, exactly as its events are", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "reader-g");
    await startRun(handle, key, "reader-g");
    expect(openRunsOf(await getJson(handle, "/api/v2/events"))).toHaveLength(1);

    const archived = await postJson(handle, `/api/v2/projects/${key}/archive`, {});
    expect(archived.status).toBe(200);
    expect(openRunsOf(await getJson(handle, "/api/v2/events"))).toHaveLength(0);
    expect(handle.store.listOpenRuns()).toHaveLength(0);
  });
});
