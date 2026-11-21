// A CR closed over a pre-merge gate that was not green keeps the reason its
// closer gave, at every route a client reads it back from:
//   - the plan close stores `merge.acceptedFailingGateReason` exactly as given
//     and the plans read serves it back beside the merge commit; a close that
//     states no reason stores none, and an empty or non-string reason is
//     refused with the route's own wording, closing nothing;
//   - the project's history lists every such close under
//     `acceptedFailingGates` ({cr, planId, commit, reason, closedAt}, oldest
//     close first), and a project with none lists an empty array;
//   - a `cr-merged` marker posted with the reason reads back carrying it.
// The server does not judge the gate itself: refusing a red gate is the
// clients' rule, so these tests file no gate verdict before closing.
//
// Routes pinned:
//   POST  /api/v2/projects/<key>/plans                       — file a plan
//   PATCH /api/v2/projects/<key>/plans/<planId>/cycles/<id>  — seal its cycle
//   PATCH /api/v2/projects/<key>/plans/<planId>              — close it, with `merge`
//   GET   /api/v2/projects/<key>/plans[?status=closed]       — the plans read
//   GET   /api/v2/projects/<key>/history                     — `acceptedFailingGates`
//   POST  /api/v2/milestones, GET …/milestones?type=cr-merged — the merge marker
//
// The clock is frozen with bun:test's `setSystemTime`, which the in-process
// server reads too, so each close's `closedAt` is exact rather than raced.
// Safety: every board is in process (no socket) on a ":memory:" store.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, getJson, postJson, register, send } from "../helpers/run-stream-harness.ts";
import type { Answer } from "../helpers/run-stream-harness.ts";

const ORCH = "accepted-gate-orchestrator";
const MERGE_SHA = "accceeed0002";
// Spaces, a tab, a dash and a non-ASCII character: served back byte for byte.
const REASON = "accepted known flake —  fixed by the next change\tsee the gate";
const REFUSAL = "merge.acceptedFailingGateReason must be a non-empty string";
const T0 = Date.UTC(2031, 2, 14, 9, 0, 0);

interface PlanRow {
  planId: number;
  cr: string;
  status: string;
  merge?: { commit?: string; acceptedFailingGateReason?: string };
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

/** File `cr` with one cycle and seal that cycle, so the plan may close. Answers its plan id. */
async function sealedPlan(h: BoardHandle, key: string, cr: string): Promise<number> {
  const filed = await postJson(h, `/api/v2/projects/${key}/plans`, {
    cr,
    cycles: [{ label: "solo" }],
    agentId: ORCH,
  });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const planId = filed.body.planId as number;
  const cycleId = (filed.body.cycles as Array<{ id: number }>)[0]!.id;
  for (const status of ["active", "done"]) {
    const moved = await patchJson(h, `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
      status,
      agentId: ORCH,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
  return planId;
}

function closePlan(h: BoardHandle, key: string, planId: number, merge: unknown): Promise<Answer> {
  return patchJson(h, `/api/v2/projects/${key}/plans/${planId}`, {
    status: "closed",
    agentId: ORCH,
    merge,
  });
}

async function plansRead(h: BoardHandle, key: string, query = ""): Promise<PlanRow[]> {
  const read = await getJson(h, `/api/v2/projects/${key}/plans${query}`);
  expect(read.ok).toBe(true);
  return read.plans as PlanRow[];
}

async function historyRead(h: BoardHandle, key: string): Promise<Record<string, unknown>> {
  const read = await getJson(h, `/api/v2/projects/${key}/history`);
  expect(read.ok).toBe(true);
  return read;
}

describe("PATCH …/plans/<planId> — a close over an accepted failing gate", () => {
  test("stores the reason as given, and the plans read serves it back under merge.acceptedFailingGateReason beside the commit", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "accepted-gate-close");
    const planId = await sealedPlan(handle, key, "ACCEPT-GATE-1");

    const closed = await closePlan(handle, key, planId, {
      commit: MERGE_SHA,
      acceptedFailingGateReason: REASON,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const answered = closed.body.plan as PlanRow;
    expect(answered.status).toBe("closed");
    expect(answered.merge).toEqual({ commit: MERGE_SHA, acceptedFailingGateReason: REASON });

    for (const query of ["", "?status=closed"]) {
      const rows = (await plansRead(handle, key, query)).filter((p) => p.planId === planId);
      expect(rows.length, `GET …/plans${query}`).toBe(1);
      expect(rows[0]!.status).toBe("closed");
      expect(rows[0]!.merge, `GET …/plans${query}`).toEqual({
        commit: MERGE_SHA,
        acceptedFailingGateReason: REASON,
      });
    }
  });

  test("a close with a merge commit and no reason stores none: its merge is the commit alone", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "green-gate-close");
    const planId = await sealedPlan(handle, key, "GREEN-GATE-1");

    const closed = await closePlan(handle, key, planId, { commit: MERGE_SHA });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((closed.body.plan as PlanRow).merge).toEqual({ commit: MERGE_SHA });

    const row = (await plansRead(handle, key, "?status=closed")).find((p) => p.planId === planId)!;
    expect(row.merge).toEqual({ commit: MERGE_SHA });
    expect("acceptedFailingGateReason" in row.merge!).toBe(false);
  });

  test("an empty or non-string reason is refused 400 with the route's wording, the plan stays open and nothing is listed as accepted", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "refused-reason-close");
    const planId = await sealedPlan(handle, key, "REFUSED-REASON-1");

    for (const reason of ["", 42, null]) {
      const refused = await closePlan(handle, key, planId, {
        commit: MERGE_SHA,
        acceptedFailingGateReason: reason,
      });
      expect(refused.status, `reason ${JSON.stringify(reason)}: ${JSON.stringify(refused.body)}`).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toBe(REFUSAL);
    }

    const row = (await plansRead(handle, key)).find((p) => p.planId === planId)!;
    expect(row.status).toBe("open");
    expect("merge" in row).toBe(false);
    expect((await historyRead(handle, key)).acceptedFailingGates).toEqual([]);
  });
});

describe("GET …/history — acceptedFailingGates", () => {
  test("lists each close over an accepted failing gate with its cr, planId, commit, reason and closedAt, oldest close first, leaving out every other plan", async () => {
    handle = bootInProcess();
    setSystemTime(new Date(T0));
    const key = await newProject(handle, "accepted-gate-history");
    const first = await sealedPlan(handle, key, "ACCEPT-GATE-FILED-FIRST");
    const second = await sealedPlan(handle, key, "ACCEPT-GATE-FILED-SECOND");
    const plain = await sealedPlan(handle, key, "GREEN-GATE-CLOSED");
    await sealedPlan(handle, key, "STILL-OPEN");

    // Closed in the reverse of their filing order, so a list kept in plan
    // order rather than close order reads back wrong.
    setSystemTime(new Date(T0 + 1_000));
    expect((await closePlan(handle, key, second, {
      commit: "5ec0nd000001",
      acceptedFailingGateReason: "second filed, closed first",
    })).status).toBe(200);
    setSystemTime(new Date(T0 + 2_000));
    expect((await closePlan(handle, key, plain, { commit: "9reen0000001" })).status).toBe(200);
    setSystemTime(new Date(T0 + 3_000));
    expect((await closePlan(handle, key, first, {
      commit: "f1r5t0000001",
      acceptedFailingGateReason: REASON,
    })).status).toBe(200);

    const history = await historyRead(handle, key);
    expect(history.acceptedFailingGates).toEqual([
      {
        cr: "ACCEPT-GATE-FILED-SECOND",
        planId: second,
        commit: "5ec0nd000001",
        reason: "second filed, closed first",
        closedAt: T0 + 1_000,
      },
      {
        cr: "ACCEPT-GATE-FILED-FIRST",
        planId: first,
        commit: "f1r5t0000001",
        reason: REASON,
        closedAt: T0 + 3_000,
      },
    ]);
  });

  test("a project with no close over an accepted failing gate lists an empty array", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "no-accepted-gate-history");
    expect((await historyRead(handle, key)).acceptedFailingGates).toEqual([]);

    const planId = await sealedPlan(handle, key, "GREEN-GATE-ONLY");
    expect((await closePlan(handle, key, planId, { commit: MERGE_SHA })).status).toBe(200);
    expect((await historyRead(handle, key)).acceptedFailingGates).toEqual([]);
  });
});

describe("POST /api/v2/milestones — the cr-merged marker of an accepted close", () => {
  test("a cr-merged marker posted with the reason reads back carrying it exactly; one posted without carries no reason key", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "accepted-gate-marker");
    const markers: Array<{ cr: string; reason?: string }> = [
      { cr: "ACCEPT-GATE-MARKED", reason: REASON },
      { cr: "GREEN-GATE-MARKED" },
    ];
    const ids = new Map<string, string>();
    for (const { cr, reason } of markers) {
      const posted = await postJson(handle, "/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "cr-merged",
        label: cr,
        commit: MERGE_SHA,
        ...(reason !== undefined ? { acceptedFailingGateReason: reason } : {}),
      });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      ids.set(cr, posted.body.event as string);
    }

    const read = await getJson(handle, `/api/v2/projects/${key}/milestones?type=cr-merged`);
    expect(read.ok).toBe(true);
    const listed = read.milestones as Array<Record<string, unknown>>;
    expect(listed.length).toBe(2);
    const accepted = listed.filter((m) => m.label === "ACCEPT-GATE-MARKED");
    expect(accepted.length).toBe(1);
    expect(accepted[0]!.id).toBe(ids.get("ACCEPT-GATE-MARKED")!);
    expect(accepted[0]!.commit).toBe(MERGE_SHA);
    expect(accepted[0]!.acceptedFailingGateReason).toBe(REASON);
    const green = listed.find((m) => m.label === "GREEN-GATE-MARKED")!;
    expect(green.id).toBe(ids.get("GREEN-GATE-MARKED")!);
    expect("acceptedFailingGateReason" in green).toBe(false);
  });
});
