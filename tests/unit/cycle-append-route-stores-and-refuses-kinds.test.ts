// The cycle-append route as a client's `cycle-add` meets it: the KIND a cycle
// is appended with is the kind the board stores and serves back, an unknown
// kind is refused with the route's own wording and stores nothing, and a cycle
// appended to the open plan of a CR whose earlier plan was aborted lands on
// that open plan alone.
//
// Routes pinned:
//   POST  /api/v2/projects/<key>/plans                       — file a plan
//   POST  /api/v2/projects/<key>/plans/<planId>/cycles       — append a cycle
//   PATCH /api/v2/projects/<key>/plans/<planId>/cycles/<id>  — activate / complete a cycle
//   POST  /api/v2/projects/<key>/plans/<planId>/abort        — abort a plan
//   GET   /api/v2/projects/<key>/plans                       — read the plans back
//
// Server rules pinned: `parseCycleInput`'s accepted kinds and its invalid-kind
// refusal (src/v2.ts), and `Store#appendCycle`'s insert of the parsed kind
// (src/store.ts). `appendCycle`'s fix-needs-its-verify-done guard itself is
// pinned by tests/unit/cycle-add-fix-only.test.ts; here a fix append is
// made only after its plan's verify cycle is done, as a client must.
//
// Safety: every board is in process (no socket) on a ":memory:" store; nothing outside
// the process is read or written.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, getJson, postJson, register, send } from "../helpers/run-stream-harness.ts";
import type { Answer } from "../helpers/run-stream-harness.ts";

const ORCH = "cycle-append-orchestrator";

/** The change record a non-fix append carries (CR-CRU-165 §S1). */
const CHANGE_RECORD = {
  reason: "round-trip coverage for this kind",
  cause: "gap-analysis",
  specRef: "design note §S4",
} as const;

/** The route's own refusal of an unknown kind, as `parseCycleInput` words it. */
const SMOKE_REFUSAL = "invalid kind: smoke (expected red-green | verify | fix)";

interface CycleRow {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanRow {
  planId: number;
  cr: string;
  status: string;
  cycles: CycleRow[];
}

let handle: BoardHandle | undefined;

afterEach(() => {
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

/** A project created over the route, with the orchestrator registered. */
async function newProject(h: BoardHandle, name: string): Promise<string> {
  const created = await postJson(h, "/api/v2/projects", { name });
  expect(created.status, `creating ${name}`).toBe(200);
  const key = (created.body.project as { key: string }).key;
  await register(h, key, ORCH);
  return key;
}

/** File a plan for `cr` with one red-green cycle; answers the stored plan. */
async function filePlan(h: BoardHandle, key: string, cr: string, firstCycle: string): Promise<PlanRow> {
  const filed = await postJson(h, `/api/v2/projects/${key}/plans`, {
    cr,
    cycles: [{ label: firstCycle, kind: "red-green" }],
    agentId: ORCH,
  });
  expect(filed.status, `filing ${cr}: ${JSON.stringify(filed.body)}`).toBe(201);
  return filed.body as unknown as PlanRow;
}

function appendCycle(h: BoardHandle, key: string, planId: number, body: Record<string, unknown>): Promise<Answer> {
  return postJson(h, `/api/v2/projects/${key}/plans/${planId}/cycles`, { agentId: ORCH, ...body });
}

async function moveCycle(h: BoardHandle, key: string, planId: number, cycleId: number, status: string): Promise<void> {
  const moved = await patchJson(h, `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    status,
    agentId: ORCH,
  });
  expect(moved.status, `moving cycle ${cycleId} to ${status}: ${JSON.stringify(moved.body)}`).toBe(200);
}

async function planById(h: BoardHandle, key: string, planId: number): Promise<PlanRow> {
  const read = await getJson(h, `/api/v2/projects/${key}/plans`);
  const matches = (read.plans as PlanRow[]).filter((p) => p.planId === planId);
  expect(matches.length, `plan ${planId} is held exactly once`).toBe(1);
  return matches[0]!;
}

function kindsByLabel(plan: PlanRow): Record<string, string> {
  return Object.fromEntries(plan.cycles.map((c) => [c.label, c.kind]));
}

describe("POST …/plans/<planId>/cycles stores the kind it is given", () => {
  test("a verify cycle appended with its change record reads back as verify, beside the untouched red-green cycle", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "cycle-append-verify");
    const plan = await filePlan(handle, key, "CR-KIND-VERIFY", "the red-green cycle");

    const appended = await appendCycle(handle, key, plan.planId, {
      label: "the verify cycle",
      kind: "verify",
      ...CHANGE_RECORD,
    });
    expect(appended.status, JSON.stringify(appended.body)).toBe(201);
    expect(appended.body.kind).toBe("verify");

    const stored = await planById(handle, key, plan.planId);
    expect(kindsByLabel(stored)).toEqual({
      "the red-green cycle": "red-green",
      "the verify cycle": "verify",
    });
  });

  test("every declared kind round-trips as itself, and an unknown kind is refused 400 with the route's invalid-kind wording, storing nothing", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "cycle-append-roundtrip");
    const plan = await filePlan(handle, key, "CR-KIND-ROUNDTRIP", "the filed cycle");

    const redGreen = await appendCycle(handle, key, plan.planId, {
      label: "appended red-green",
      kind: "red-green",
      ...CHANGE_RECORD,
    });
    expect(redGreen.status, JSON.stringify(redGreen.body)).toBe(201);
    const verify = await appendCycle(handle, key, plan.planId, {
      label: "appended verify",
      kind: "verify",
      ...CHANGE_RECORD,
    });
    expect(verify.status, JSON.stringify(verify.body)).toBe(201);

    // A fix follows a DONE verify: every cycle up to and including the
    // verify one is completed in order before the fix is appended.
    const ordered = (await planById(handle, key, plan.planId)).cycles;
    expect(ordered.map((c) => c.label)).toEqual(["the filed cycle", "appended red-green", "appended verify"]);
    for (const cycle of ordered) {
      await moveCycle(handle, key, plan.planId, cycle.id, "active");
      await moveCycle(handle, key, plan.planId, cycle.id, "done");
    }
    const fix = await appendCycle(handle, key, plan.planId, { label: "appended fix", kind: "fix" });
    expect(fix.status, JSON.stringify(fix.body)).toBe(201);

    expect(kindsByLabel(await planById(handle, key, plan.planId))).toEqual({
      "the filed cycle": "red-green",
      "appended red-green": "red-green",
      "appended verify": "verify",
      "appended fix": "fix",
    });

    const refused = await appendCycle(handle, key, plan.planId, {
      label: "appended smoke",
      kind: "smoke",
      ...CHANGE_RECORD,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toBe(SMOKE_REFUSAL);

    const after = await planById(handle, key, plan.planId);
    expect(after.cycles.map((c) => c.label)).not.toContain("appended smoke");
    expect(after.cycles.length).toBe(4);
  });

  test("a cycle appended to a CR's re-filed open plan lands there with its kind, while the aborted sibling keeps exactly its own cycle", async () => {
    handle = bootInProcess();
    const key = await newProject(handle, "cycle-append-aborted-sibling");
    const cr = "CR-KIND-ABORTED-SIBLING";
    const abandoned = await filePlan(handle, key, cr, "the abandoned cycle");

    const aborted = await postJson(handle, `/api/v2/projects/${key}/plans/${abandoned.planId}/abort`, {
      userApproved: true,
      agentId: ORCH,
      reason: "a spec change invalidated the aborted sibling",
      cause: "gap-analysis",
      specRef: "design note §S2b",
    });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);

    const recovered = await filePlan(handle, key, cr, "the recovered cycle");
    expect(recovered.planId).not.toBe(abandoned.planId);

    const appended = await appendCycle(handle, key, recovered.planId, {
      label: "the cycle the client could not add",
      kind: "verify",
      reason: "a spec change added a verify pass here",
      cause: "gap-analysis",
      specRef: "design note §S1",
    });
    expect(appended.status, JSON.stringify(appended.body)).toBe(201);

    expect(kindsByLabel(await planById(handle, key, recovered.planId))).toEqual({
      "the recovered cycle": "red-green",
      "the cycle the client could not add": "verify",
    });
    const sibling = await planById(handle, key, abandoned.planId);
    expect(sibling.status).toBe("aborted");
    expect(kindsByLabel(sibling)).toEqual({ "the abandoned cycle": "red-green" });
  });
});
