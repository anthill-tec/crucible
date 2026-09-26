// GET \u2026/plans status filter (\u00a7S1, AC1/AC2) and the two project-wide
// facts `filed` / `lastClosedCr` (\u00a7S2, AC3).
//
// Spec (the "status shows the work in flight" change doc under
// docs/changes/):
//   AC1 — on a board with open/closed/aborted plans, ?status=open|closed|
//     aborted returns EXACTLY that bucket; ?status=open&cr=<cr> returns only
//     that CR's open plan; the ?status=open response carries no plan with a
//     commitBoundary.
//   AC2 — ?status=<anything else> (including "") -> 400 ok:false, help[]
//     naming open/closed/aborted. No `status` param -> unchanged (today's
//     `plans` array).
//   AC3 — every GET …/plans response (unfiltered, ?status=open, ?cr=<cr>)
//     carries `filed` (the project's total plan count) and `lastClosedCr`
//     (the `cr` with the latest `closedAt`, or null). An aborted-only board
//     has `lastClosedCr: null` and `filed` = the aborted count. A project
//     with no plans has `filed: 0` and `lastClosedCr: null`.
//
// RED phase: src/v2.ts's handlePlansList (~L1900) reads only `cr`/`track`
// off the query string and passes {ok:true, plans} straight through — no
// `status` param is read, no `filed`/`lastClosedCr` fields exist anywhere on
// this response. Every filter assertion below fails because the filter is
// silently ignored (all statuses come back together); every AC2 400 case
// fails because the route always answers 200; every AC3 assertion fails
// because `filed`/`lastClosedCr` are `undefined` on the response.
//
// Harness: reuses the exact postJson/patchJson/getJson + withFixtureAgent +
// createProject + scopedPlansPath conventions from tests/plans-global.test.ts,
// and the activate->done->close-with-merge idiom from that same file's
// closePlan() (commit-boundary-routes.test.ts confirms a merge-commit close
// alone — no run ingestion — is enough for store.ts's deriveCommitBoundary to
// publish a `{mergeCommit, closedAt}` boundary).
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { startServer } from "../src/server.ts";

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  projectKey: string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  merge?: { commit: string };
  commitBoundary?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PlanFileResponse extends PlanRecord {}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
  filed?: number | null;
  lastClosedCr?: string | null;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  [key: string]: unknown;
}

describe("GET \u2026/plans status filter + filed/lastClosedCr (\u00a7S1/\u00a7S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    setSystemTime();
  });

  function withFixtureAgent(body: unknown): unknown {
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !("agentId" in (body as Record<string, unknown>))
    ) {
      return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
    }
    return body;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function registerOrchestrator(key: string, agentId: string): Promise<void> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
    return body.project.key;
  }

  function scopedPlansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function filePlan(key: string, cr: string): Promise<PlanFileResponse> {
    const res = await postJson(scopedPlansPath(key), { cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
    return (await res.json()) as PlanFileResponse;
  }

  async function transitionCycle(
    key: string,
    planId: number | string,
    cycleId: number,
    status: string,
  ): Promise<void> {
    const res = await patchJson(`${scopedPlansPath(key)}/${planId}/cycles/${cycleId}`, { status });
    expect(res.status).toBe(200);
  }

  /** Seals an ALREADY-FILED plan's one cycle (active -> done) then closes it
   * with the given merge commit \u2014 split out so a fixture can control FILE
   * order independently of CLOSE order. */
  async function closeFiledPlan(
    key: string,
    plan: PlanFileResponse,
    mergeCommit: string,
  ): Promise<void> {
    const cycleId = plan.cycles[0]!.id;
    await transitionCycle(key, plan.planId, cycleId, "active");
    await transitionCycle(key, plan.planId, cycleId, "done");
    const closeRes = await patchJson(`${scopedPlansPath(key)}/${plan.planId}`, {
      status: "closed",
      merge: { commit: mergeCommit },
    });
    expect(closeRes.status).toBe(200);
  }

  /** Files a single-cycle plan and aborts it (userApproved:true) — no
   * activation needed; abort transitions whatever cycle state it finds. */
  async function fileAndAbortPlan(key: string, cr: string): Promise<string> {
    const plan = await filePlan(key, cr);
    const res = await postJson(`${scopedPlansPath(key)}/${plan.planId}/abort`, {
      userApproved: true,
    });
    expect(res.status).toBe(200);
    return cr;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A fresh project with ONE open plan, TWO closed plans and ONE aborted
   * plan. Filed through the real HTTP routes end to end.
   *
   * The two closed plans are FILED in the OPPOSITE order from the order they
   * CLOSE in: `CR-T-CLOSED-LATE` is filed FIRST (lower planId) but closed
   * SECOND (later closedAt); `CR-T-CLOSED-EARLY` is filed SECOND (higher
   * planId) but closed FIRST (earlier closedAt). This separates "latest
   * closedAt" from "highest planId" / "last filed" / "last row in plan_id
   * order" — a GREEN that computed `lastClosedCr` from any of THOSE instead
   * of the real `closedAt` column would still pick the wrong cr here.
   */
  async function buildMixedBoard(): Promise<{
    key: string;
    openCr: string;
    closedEarlyCr: string;
    closedLateCr: string;
    closedEarlyPlanId: number | string;
    closedLatePlanId: number | string;
    abortedCr: string;
  }> {
    const key = await createProject(`plans-status-${crypto.randomUUID()}`);
    const openPlan = await filePlan(key, "CR-T-OPEN");
    // File order: LATE-to-close first, EARLY-to-close second — the reverse of
    // close order (below) — so planId order and closedAt order disagree.
    const closedLatePlan = await filePlan(key, "CR-T-CLOSED-LATE");
    const closedEarlyPlan = await filePlan(key, "CR-T-CLOSED-EARLY");
    // Close order: EARLY first, LATE second, with a real time gap so their
    // closed_at values can never collide — the "latest closedAt wins"
    // assertion must be decided by actual ordering, not a tie.
    await closeFiledPlan(key, closedEarlyPlan, "aaa1111");
    await sleep(5);
    await closeFiledPlan(key, closedLatePlan, "bbb2222");
    const abortedCr = await fileAndAbortPlan(key, "CR-T-ABORTED");
    return {
      key,
      openCr: openPlan.cr,
      closedEarlyCr: closedEarlyPlan.cr,
      closedLateCr: closedLatePlan.cr,
      closedEarlyPlanId: closedEarlyPlan.planId,
      closedLatePlanId: closedLatePlan.planId,
      abortedCr,
    };
  }

  // ── AC1 (§S1) — exact per-status buckets, no commitBoundary under ?status=open ──

  test("?status=open returns EXACTLY the one open plan (closed + aborted excluded)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const res = await getJson(scopedPlansPath(board.key, "?status=open"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.ok).toBe(true);
    expect(body.plans.map((p) => p.cr)).toEqual([board.openCr]);
    expect(body.plans[0]!.status).toBe("open");
  });

  test("?status=closed returns EXACTLY the two closed plans (open + aborted excluded)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const res = await getJson(scopedPlansPath(board.key, "?status=closed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.plans.map((p) => p.cr).sort()).toEqual(
      [board.closedEarlyCr, board.closedLateCr].sort(),
    );
    expect(body.plans.every((p) => p.status === "closed")).toBe(true);
  });

  test("?status=aborted returns EXACTLY the one aborted plan (open + closed excluded)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const res = await getJson(scopedPlansPath(board.key, "?status=aborted"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.plans.map((p) => p.cr)).toEqual([board.abortedCr]);
    expect(body.plans[0]!.status).toBe("aborted");
  });

  test("?status=open&cr=<cr> returns only that CR's open plan; the same status with a CLOSED cr returns none", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const matched = await getJson(
      scopedPlansPath(board.key, `?status=open&cr=${encodeURIComponent(board.openCr)}`),
    );
    expect(matched.status).toBe(200);
    const matchedBody = (await matched.json()) as PlansListResponse;
    expect(matchedBody.plans.length).toBe(1);
    expect(matchedBody.plans[0]!.cr).toBe(board.openCr);

    // Combination is AND, not OR: a real cr on this board whose plan is
    // CLOSED, not open, must come back empty under ?status=open.
    const mismatched = await getJson(
      scopedPlansPath(board.key, `?status=open&cr=${encodeURIComponent(board.closedEarlyCr)}`),
    );
    expect(mismatched.status).toBe(200);
    const mismatchedBody = (await mismatched.json()) as PlansListResponse;
    expect(mismatchedBody.plans).toEqual([]);
  });

  test("the UNFILTERED read carries commitBoundary on both closed plans; the ?status=open read carries NO plan with a commitBoundary — made meaningful by the same board's unfiltered closed plans carrying one", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const unfiltered = await getJson(scopedPlansPath(board.key));
    const unfilteredBody = (await unfiltered.json()) as PlansListResponse;
    const closedEarly = unfilteredBody.plans.find((p) => p.cr === board.closedEarlyCr);
    const closedLate = unfilteredBody.plans.find((p) => p.cr === board.closedLateCr);
    expect(closedEarly?.commitBoundary).toEqual({
      mergeCommit: "aaa1111",
      closedAt: expect.any(Number),
    });
    expect(closedLate?.commitBoundary).toEqual({
      mergeCommit: "bbb2222",
      closedAt: expect.any(Number),
    });

    const openOnly = await getJson(scopedPlansPath(board.key, "?status=open"));
    const openOnlyBody = (await openOnly.json()) as PlansListResponse;
    expect(openOnlyBody.plans.length).toBeGreaterThan(0);
    expect(openOnlyBody.plans.every((p) => p.commitBoundary === undefined)).toBe(true);
  });

  // ── AC2 (§S1) — invalid status -> 400 with help[]; no param -> unchanged today's array ──

  test("?status=bogus -> 400 ok:false, help[] names open/closed/aborted", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject(`plans-status-bad-${crypto.randomUUID()}`);

    const res = await getJson(scopedPlansPath(key, "?status=bogus"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.help)).toBe(true);
    const help = (body.help as string[]).join(" ").toLowerCase();
    expect(help).toContain("open");
    expect(help).toContain("closed");
    expect(help).toContain("aborted");
  });

  test("?status= (empty string) -> 400 ok:false, same help[] contract as any other invalid value", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject(`plans-status-empty-${crypto.randomUUID()}`);

    const res = await getJson(scopedPlansPath(key, "?status="));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    const help = (body.help as string[]).join(" ").toLowerCase();
    expect(help).toContain("open");
    expect(help).toContain("closed");
    expect(help).toContain("aborted");
  });

  test("GET …/plans with NO status parameter returns the same plans array it returns today (expected to PASS already — no regression from this CR)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const board = await buildMixedBoard();

    const res = await getJson(scopedPlansPath(board.key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.ok).toBe(true);
    expect(body.plans.map((p) => p.cr).sort()).toEqual(
      [board.openCr, board.closedEarlyCr, board.closedLateCr, board.abortedCr].sort(),
    );
  });

  // ── AC3 (§S2) — `filed` + `lastClosedCr` on every GET …/plans response ──

  test("on the mixed board, unfiltered / ?status=open / ?cr=<cr> ALL carry filed:4 and lastClosedCr = the CR closed latest — NOT the CR with the highest planId", async () => {
    handle = startServer({ port: 0, dbPath: ':memory:' });
    const board = await buildMixedBoard();

    // The fixture's separation is explicit and asserted here so a future
    // edit cannot silently re-align "filed order" with "close order" again:
    // the plan that closes LATEST must carry the LOWER planId.
    expect(Number(board.closedLatePlanId)).toBeLessThan(Number(board.closedEarlyPlanId));

    const unfiltered = (await (
      await getJson(scopedPlansPath(board.key))
    ).json()) as PlansListResponse;
    expect(unfiltered.filed).toBe(4);
    expect(unfiltered.lastClosedCr).toBe(board.closedLateCr);

    const openOnly = (await (
      await getJson(scopedPlansPath(board.key, "?status=open"))
    ).json()) as PlansListResponse;
    expect(openOnly.filed).toBe(4);
    expect(openOnly.lastClosedCr).toBe(board.closedLateCr);

    const byCr = (await (
      await getJson(scopedPlansPath(board.key, `?cr=${encodeURIComponent(board.openCr)}`))
    ).json()) as PlansListResponse;
    expect(byCr.filed).toBe(4);
    expect(byCr.lastClosedCr).toBe(board.closedLateCr);
  });

  test("tie-break: two plans on the SAME board closed at the IDENTICAL closedAt — lastClosedCr is the one with the HIGHER planId, not simply the first/last row found", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject(`plans-status-tie-${crypto.randomUUID()}`);
    const lowPlan = await filePlan(key, "CR-T-TIE-LOW");
    const highPlan = await filePlan(key, "CR-T-TIE-HIGH");
    expect(Number(highPlan.planId)).toBeGreaterThan(Number(lowPlan.planId));

    // System-clock injection (bun:test's setSystemTime, the idiom
    // tests/commit-boundary-derivation.test.ts and siblings use): the store
    // stamps `closed_at` from `Date.now()` with no injectable clock of its
    // own, so pinning the SAME instant across both closes — never advancing
    // it between them — is the only honest way to force a genuine tie
    // (rather than a real-clock race that could pass for the wrong reason).
    setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    await closeFiledPlan(key, lowPlan, "tie-low-sha");
    await closeFiledPlan(key, highPlan, "tie-high-sha");
    setSystemTime();

    const res = await getJson(scopedPlansPath(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    const lowRow = body.plans.find((p) => p.cr === lowPlan.cr);
    const highRow = body.plans.find((p) => p.cr === highPlan.cr);
    // Proves the tie is GENUINE — both plans really share one closed_at —
    // rather than the assertion below passing by real-clock coincidence.
    expect(lowRow?.commitBoundary?.closedAt).toEqual(highRow?.commitBoundary?.closedAt);

    expect(body.lastClosedCr).toBe(highPlan.cr);
  });

  test("an aborted-only board: lastClosedCr is null, filed equals the aborted count (2)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject(`plans-status-aborted-only-${crypto.randomUUID()}`);
    await fileAndAbortPlan(key, "CR-T-ABORTED-ONLY-1");
    await fileAndAbortPlan(key, "CR-T-ABORTED-ONLY-2");

    const res = await getJson(scopedPlansPath(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.plans.every((p) => p.status === "aborted")).toBe(true);
    expect(body.filed).toBe(2);
    expect(body.lastClosedCr).toBeNull();
  });

  test("a project with no plans at all: filed is 0, lastClosedCr is null, plans is []", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject(`plans-status-empty-project-${crypto.randomUUID()}`);

    const res = await getJson(scopedPlansPath(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.plans).toEqual([]);
    expect(body.filed).toBe(0);
    expect(body.lastClosedCr).toBeNull();
  });
});
