// The plan-filing route as a client's `plan-file` meets it: the KIND each filed
// cycle declares is the kind the board stores and serves back (read from the
// store, never from the POST response), a cycle filed with no kind is stored
// `red-green`, and an unknown kind refuses the whole filing with the route's
// own wording, storing no plan and no cycle.
//
// Routes pinned:
//   POST /api/v2/projects/<key>/plans  — file a plan
//   GET  /api/v2/projects/<key>/plans  — read the plans back
//
// Server rules pinned: `parseCycleInput`'s `red-green` default and its
// invalid-kind refusal (src/v2.ts), as `handlePlanFile` applies them to every
// entry before any write, and `Store#filePlan`'s insert of each parsed kind in
// the authored order (src/store.ts). The append route's side of the same rules
// is pinned by tests/integration/cycle-append-route-stores-and-refuses-kinds.test.ts.
//
// Safety: every board is in process (no socket) on a ":memory:" store; nothing outside
// the process is read or written.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, getJson, postJson, readyProject } from "../helpers/run-stream-harness.ts";
import type { Answer } from "../helpers/run-stream-harness.ts";

const ORCH = "plan-file-kinds-orchestrator";

/** The route's own refusal of an unknown kind, as `parseCycleInput` words it. */
const SMOKE_REFUSAL = "invalid kind: smoke (expected red-green | verify | fix)";

interface CycleRow {
  id: number;
  label: string;
  kind: string;
}

interface PlanRow {
  planId: number;
  cr: string;
  cycles: CycleRow[];
}

let handle: BoardHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function fileCycles(h: BoardHandle, key: string, cr: string, cycles: unknown[]): Promise<Answer> {
  return postJson(h, `/api/v2/projects/${key}/plans`, {
    cr,
    title: `${cr} under test`,
    wave: "1",
    agentId: ORCH,
    cycles,
  });
}

async function storedPlans(h: BoardHandle, key: string): Promise<PlanRow[]> {
  return (await getJson(h, `/api/v2/projects/${key}/plans`)).plans as PlanRow[];
}

/** The one stored plan for `cr`, read back from the store. */
async function storedPlanFor(h: BoardHandle, key: string, cr: string): Promise<PlanRow> {
  const matches = (await storedPlans(h, key)).filter((p) => p.cr === cr);
  expect(matches.length, `plan for ${cr} is held exactly once`).toBe(1);
  return matches[0]!;
}

/** The plan's cycles as an ORDERED list of [label, kind] — a map keyed by
 *  label would lose the authored order this file pins. */
function orderedPairs(plan: PlanRow): Array<[string, string]> {
  return plan.cycles.map((c) => [c.label, c.kind]);
}

describe("POST …/plans stores the kind each filed cycle declares", () => {
  test("a cycle filed with no kind is stored as red-green, read back from the store", async () => {
    handle = bootInProcess();
    const key = await readyProject(handle, [ORCH], "plan-file-kindless");
    const cr = "CR-FILE-KINDLESS";

    const filed = await fileCycles(handle, key, cr, [{ label: "a cycle carrying no kind" }]);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    expect(orderedPairs(await storedPlanFor(handle, key, cr))).toEqual([["a cycle carrying no kind", "red-green"]]);
  });

  test("two different declared kinds in one filing are stored against their own cycles, in the authored order", async () => {
    handle = bootInProcess();
    const key = await readyProject(handle, [ORCH], "plan-file-two-kinds");
    const cr = "CR-FILE-TWO-KINDS";

    // Different kinds in non-alphabetical order: a pairing that sorts,
    // reverses or applies one kind to every cycle reads back differently.
    const filed = await fileCycles(handle, key, cr, [
      { label: "the verify sweep", kind: "verify" },
      { label: "the follow-up repair", kind: "fix" },
    ]);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    expect(orderedPairs(await storedPlanFor(handle, key, cr))).toEqual([
      ["the verify sweep", "verify"],
      ["the follow-up repair", "fix"],
    ]);
  });

  test("an unrecognised kind is refused 400 with the route's exact invalid-kind body and stores no plan and no cycle", async () => {
    handle = bootInProcess();
    const key = await readyProject(handle, [ORCH], "plan-file-unknown-kind");
    expect(await storedPlans(handle, key), "the project starts with no plans").toEqual([]);

    // The python test's filing: one cycle, kind `smoke`.
    const refused = await fileCycles(handle, key, "CR-FILE-UNKNOWN-KIND", [
      { label: "the verify sweep", kind: "smoke" },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toBe(SMOKE_REFUSAL);

    // The same refusal when `smoke` follows a valid cycle: the whole filing
    // is refused, so the valid cycle before it is not stored either.
    const refusedAfterValid = await fileCycles(handle, key, "CR-FILE-UNKNOWN-KIND-SECOND", [
      { label: "a valid verify cycle", kind: "verify" },
      { label: "the smoke cycle", kind: "smoke" },
    ]);
    expect(refusedAfterValid.status).toBe(400);
    expect(refusedAfterValid.body.ok).toBe(false);
    expect(refusedAfterValid.body.error).toBe(SMOKE_REFUSAL);

    expect(await storedPlans(handle, key), "a refused kind stores no plan and no cycle").toEqual([]);
  });
});
