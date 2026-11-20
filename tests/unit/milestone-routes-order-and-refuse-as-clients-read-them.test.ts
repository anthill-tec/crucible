// The milestone routes as the clients read them back: a `pre-merge-gate`
// milestone history is served newest first, each record stamped with the
// millisecond it was taken and an `evt-<ms>-<seq>` id whose sequence grows
// numerically (a client that orders by these is tested against their real
// shape); and a `cr-merged` post from an agent still bound to the done cycle of
// its now-closed plan is refused with the stale-binding wording a client
// relays, recording nothing, while the same post from the agent re-registered
// unbound records the marker with its merge commit.
//
// Routes pinned:
//   POST  /api/v2/milestones                                  — record a milestone
//   GET   /api/v2/projects/<key>/milestones?type=<type>       — one type's records
//   POST  /api/v2/agents/register | /api/v2/agents/unregister — the poster's binding
//   POST  /api/v2/projects/<key>/plans, PATCH …/plans/<id>, PATCH …/cycles/<id>
//                                                             — the bound cycle's plan
//
// Server rules pinned: `Store#listMilestonesByType`'s order (timestamp DESC,
// insertion DESC), `Store#nextEventId`'s `evt-<ms>-<seq>`, and
// `resolveIngestAttach`'s stale-binding refusal on the milestones route
// (src/v2.ts).
//
// The clock is frozen with bun:test's `setSystemTime`, which the in-process
// server reads too, so a timestamp and a same-millisecond tie are exact rather
// than raced. Safety: every board is in process (no socket) on a ":memory:" store.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, getJson, postJson, register, send } from "../helpers/run-stream-harness.ts";
import type { Answer } from "../helpers/run-stream-harness.ts";

const ORCH = "milestone-orchestrator";
const GATED_CR = "CR-GATE-ORDER";
const MERGED_CR = "CR-MERGE-POST";
const MERGE_SHA = "a1b2c3d4e5f6";

/** 2026-01-02T03:04:05.006Z — a fixed instant, so a stamped ms is known exactly. */
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 6);

const EVENT_ID = /^evt-(\d+)-(\d+)$/;

interface MilestoneRecord {
  id: string;
  type?: string;
  label?: string;
  timestamp?: number;
  outcome?: string;
  commit?: string;
  [key: string]: unknown;
}

let handle: BoardHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
});

async function patchJson(h: BoardHandle, route: string, body: unknown): Promise<Answer> {
  const res = await send(h, `${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function newProject(h: BoardHandle, name: string): Promise<string> {
  const created = await postJson(h, "/api/v2/projects", { name });
  expect(created.status, `creating ${name}`).toBe(200);
  const key = (created.body.project as { key: string }).key;
  await register(h, key, ORCH);
  return key;
}

/** One well-formed red `pre-merge-gate` verdict for `GATED_CR`; answers the recorded id. */
async function postGate(h: BoardHandle, key: string): Promise<string> {
  const res = await postJson(h, "/api/v2/milestones", {
    projectKey: key,
    agentId: ORCH,
    type: "pre-merge-gate",
    label: GATED_CR,
    outcome: "fail",
    passed: 7,
    failed: 1,
    failingTests: ["suite::the_one_failure"],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(typeof res.body.event).toBe("string");
  return res.body.event as string;
}

async function milestonesOfType(h: BoardHandle, key: string, type: string): Promise<MilestoneRecord[]> {
  const read = await getJson(h, `/api/v2/projects/${key}/milestones?type=${type}`);
  expect(read.ok).toBe(true);
  return read.milestones as MilestoneRecord[];
}

function idParts(id: string): { ms: number; seq: number } {
  const match = EVENT_ID.exec(id);
  expect(match, `an event id is evt-<ms>-<seq>; got ${id}`).not.toBeNull();
  return { ms: Number(match![1]), seq: Number(match![2]) };
}

describe("GET …/milestones?type= lists a CR's gate history as the clients order it", () => {
  test("gates recorded at three instants read back newest first, each stamped with its millisecond and an evt-<ms>-<seq> id", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "milestone-order-instants");
    const instants = [T0, T0 + 1_000, T0 + 2_500];
    const posted: string[] = [];
    for (const at of instants) {
      setSystemTime(new Date(at));
      posted.push(await postGate(handle, key));
    }

    const listed = await milestonesOfType(handle, key, "pre-merge-gate");
    expect(listed.map((m) => m.id)).toEqual([...posted].reverse());
    expect(listed.map((m) => m.timestamp)).toEqual([...instants].reverse());
    expect(listed.map((m) => idParts(m.id).ms)).toEqual([...instants].reverse());
    expect(listed.every((m) => m.label === GATED_CR && m.type === "pre-merge-gate")).toBe(true);
  });

  test("gates recorded within one millisecond read back in reverse posting order, their sequence numbers growing numerically past two digits", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "milestone-order-same-ms");
    setSystemTime(new Date(T0));

    const posted: string[] = [];
    // Post until a sequence number has three digits, bounded so a server
    // that never got there fails the bound rather than looping.
    while (posted.length < 150) {
      posted.push(await postGate(handle, key));
      if (idParts(posted[posted.length - 1]!).seq >= 100) break;
    }
    const seqs = posted.map((id) => idParts(id).seq);
    expect(seqs.some((s) => s < 100)).toBe(true);
    expect(seqs.some((s) => s >= 100)).toBe(true);
    for (const [i, seq] of seqs.entries()) {
      if (i > 0) expect(seq, `seq ${seq} follows ${seqs[i - 1]}`).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(posted.every((id) => idParts(id).ms === T0)).toBe(true);

    const listed = await milestonesOfType(handle, key, "pre-merge-gate");
    expect(listed.map((m) => m.id)).toEqual([...posted].reverse());
    expect(listed.every((m) => m.timestamp === T0)).toBe(true);
  });
});

describe("POST /api/v2/milestones — a cr-merged post from a stale binding", () => {
  /**
   * The CR's plan filed, its one cycle activated, `poster` registered bound to
   * that cycle, then the cycle completed and the plan closed with its merge
   * commit: the poster's binding now names a done cycle of a closed plan.
   */
  async function closedPlanWithABoundPoster(h: BoardHandle, poster: string): Promise<{ key: string; cycleId: number }> {
    const key = await newProject(h, `milestone-stale-${poster}`);
    const filed = await postJson(h, `/api/v2/projects/${key}/plans`, {
      cr: MERGED_CR,
      cycles: [{ label: "solo", kind: "red-green" }],
      agentId: ORCH,
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const planId = filed.body.planId as number;
    const cycleId = (filed.body.cycles as Array<{ id: number }>)[0]!.id;
    const cycleRoute = `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`;

    const active = await patchJson(h, cycleRoute, { status: "active", agentId: ORCH });
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    const bound = await postJson(h, "/api/v2/agents/register", {
      projectKey: key,
      agentId: poster,
      role: "ORCHESTRATOR",
      cycleId,
    });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    const done = await patchJson(h, cycleRoute, { status: "done", agentId: ORCH });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const closed = await patchJson(h, `/api/v2/projects/${key}/plans/${planId}`, {
      status: "closed",
      merge: { commit: MERGE_SHA },
      agentId: ORCH,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    return { key, cycleId };
  }

  function postCrMerged(h: BoardHandle, key: string, poster: string): Promise<Answer> {
    return postJson(h, "/api/v2/milestones", {
      projectKey: key,
      agentId: poster,
      type: "cr-merged",
      label: MERGED_CR,
      commit: MERGE_SHA,
    });
  }

  test("is refused 409 with the stale-binding wording naming the bound cycle and its closed plan, and records no cr-merged marker", async () => {
    handle = bootInProcess();
    const poster = "stale-merge-poster";
    const { key, cycleId } = await closedPlanWithABoundPoster(handle, poster);

    const refused = await postCrMerged(handle, key, poster);
    expect(refused.status).toBe(409);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toBe(
      `bound cycle ${cycleId} is in closed plan ${MERGED_CR} — ingest refused, run NOT stored`,
    );
    expect(refused.body.event).toBeUndefined();
    expect(await milestonesOfType(handle, key, "cr-merged")).toEqual([]);
  });

  test("once the poster is unregistered and registered again unbound, the same post records exactly one cr-merged marker carrying the merge commit", async () => {
    handle = bootInProcess();
    const poster = "remedied-merge-poster";
    const { key } = await closedPlanWithABoundPoster(handle, poster);
    expect((await postCrMerged(handle, key, poster)).status).toBe(409);

    const gone = await postJson(handle, "/api/v2/agents/unregister", { projectKey: key, agentId: poster });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const again = await postJson(handle, "/api/v2/agents/register", {
      projectKey: key,
      agentId: poster,
      role: "ORCHESTRATOR",
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    const recorded = await postCrMerged(handle, key, poster);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const markers = await milestonesOfType(handle, key, "cr-merged");
    expect(markers.length).toBe(1);
    expect(markers[0]!.id).toBe(recorded.body.event as string);
    expect(markers[0]!.label).toBe(MERGED_CR);
    expect(markers[0]!.commit).toBe(MERGE_SHA);
  });
});
