// The closed-plans read as the clients' `landings` and `release-notes` verbs
// consume it: a plan closed WITH a merge commit reads back carrying it as
// `merge.commit`, a plan closed WITHOUT one carries no `merge` key at all (the
// close takes `merge` as optional, and the client tells a landed CR from a
// merely closed one by it), and a plan's title is stored and served verbatim —
// a newline, a tab and runs of spaces included — so any one-line rendering is
// the client's own doing, never the board's.
//
// Routes pinned:
//   POST  /api/v2/projects/<key>/plans                       — file a plan (with a title)
//   PATCH /api/v2/projects/<key>/plans/<planId>/cycles/<id>  — seal its cycle
//   PATCH /api/v2/projects/<key>/plans/<planId>              — close it, with or without `merge`
//   GET   /api/v2/projects/<key>/plans?status=closed         — the closed plans read
//
// Safety: every server binds port 0 on a ":memory:" store.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import { base, bootOn, getJson, postJson, register } from "../helpers/run-stream-harness.ts";
import type { Answer } from "../helpers/run-stream-harness.ts";

const ORCH = "closed-plans-orchestrator";
const MERGE_SHA = "0123abcd4567";

interface ClosedPlan {
  planId: number;
  cr: string;
  status: string;
  title?: string;
  merge?: { commit?: string };
  [key: string]: unknown;
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function patchJson(h: ServerHandle, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${base(h)}${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function newProject(h: ServerHandle, name: string): Promise<string> {
  const created = await postJson(h, "/api/v2/projects", { name });
  expect(created.status, `creating ${name}`).toBe(200);
  const key = (created.body.project as { key: string }).key;
  await register(h, key, ORCH);
  return key;
}

/** File `cr` (titled when `title` is given), seal its one cycle and close it — with `commit` as its merge when given. */
async function landPlan(
  h: ServerHandle,
  key: string,
  cr: string,
  opts: { title?: string; commit?: string },
): Promise<number> {
  const filed = await postJson(h, `/api/v2/projects/${key}/plans`, {
    cr,
    cycles: [{ label: "solo" }],
    agentId: ORCH,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
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
  const closed = await patchJson(h, `/api/v2/projects/${key}/plans/${planId}`, {
    status: "closed",
    agentId: ORCH,
    ...(opts.commit !== undefined ? { merge: { commit: opts.commit } } : {}),
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return planId;
}

async function closedPlans(h: ServerHandle, key: string): Promise<ClosedPlan[]> {
  const read = await getJson(h, `/api/v2/projects/${key}/plans?status=closed`);
  expect(read.ok).toBe(true);
  return read.plans as ClosedPlan[];
}

describe("GET …/plans?status=closed serves what each close recorded", () => {
  test("a plan closed with a merge commit carries it, and one closed without a merge carries no merge key at all", async () => {
    handle = bootOn();
    const key = await newProject(handle, "closed-plans-merge");
    const merged = await landPlan(handle, key, "CR-LANDED-MERGED", { commit: MERGE_SHA });
    const bare = await landPlan(handle, key, "CR-LANDED-BARE", {});

    const plans = await closedPlans(handle, key);
    expect(plans.map((p) => p.cr).sort()).toEqual(["CR-LANDED-BARE", "CR-LANDED-MERGED"]);
    const mergedRow = plans.find((p) => p.planId === merged)!;
    const bareRow = plans.find((p) => p.planId === bare)!;
    expect(mergedRow.status).toBe("closed");
    expect(mergedRow.merge).toEqual({ commit: MERGE_SHA });
    expect(bareRow.status).toBe("closed");
    expect("merge" in bareRow).toBe(false);
  });

  test("a title holding a newline, a tab and runs of spaces is served back byte for byte", async () => {
    handle = bootOn();
    const key = await newProject(handle, "closed-plans-title");
    const wrapped = "Wrapped   title\twith a tab\n## [9.9.9] - 2020-01-01";
    const planId = await landPlan(handle, key, "CR-LANDED-WRAPPED", { title: wrapped, commit: MERGE_SHA });

    const row = (await closedPlans(handle, key)).find((p) => p.planId === planId)!;
    expect(row.title).toBe(wrapped);
  });
});
