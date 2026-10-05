// Sealed gate events gain a `decisionSummary` in the events LIST
// (`handleEventsList` / `eventBrief`, src/v2.ts), computed from the run's
// recorded decisions (`Store.listGateDecisions` / `handleGateDecisions`) and
// each gate step's own `findings` count (the count the client now keeps on
// every posted step, a sibling change this file does not drive).
//
// Field names chosen by this file (stated per the dispatch brief): the key
// is `decisionSummary`, nested under the event brief sibling to `gate`, with
// five counts: `decisions` (every recorded decision for the run), `fixed`
// (distinct finding ids selected by `fix` decisions), `added` (decisions
// carrying an `addedFinding`), `declined` (each APPROVED step's own
// `findings` count minus the distinct ids fixed AT THAT STEP, summed over
// approved steps only) and `approvedWithReason` (`approve` decisions
// carrying a `reason`). The worked numbers below are the spec's own example
// ("4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a
// reason"), reproduced exactly rather than invented, so the shape of the
// fixture doubles as the acceptance example.
//
// "None" choice (stated per the dispatch brief): an in-flight gate, a gate
// naming no run, and a sealed run-naming gate with ZERO recorded decisions
// all carry NO `decisionSummary` key — absent, never a zeroed object —
// mirroring `withGateDecisions`' own "nothing to show" rule on the
// single-event detail read.
//
// This file drives the REAL production server (`startServer`). Today
// `eventBrief` carries no `decisionSummary` key on ANY event, gate or
// otherwise (confirmed by reading it directly), so every POSITIVE assertion
// below (the worked example, the dedup pin, the approved-only-sum pin, and
// the one-query structural pin) fails against production as it stands — the
// positive cases always read `undefined` where a computed object is
// expected, and the one-query pin counts ZERO matching statements where it
// expects exactly one, because nothing queries `gate_decisions` from the
// list path at all yet. The four ABSENCE pins (zero decisions / in-flight /
// no runId / non-gate) are bound/negative pins that legitimately PASS
// already — there is nothing to wrongly populate yet — and are kept to
// catch a later implementation that fabricates the key where the spec
// forbids it (e.g. an in-flight gate, or every gate unconditionally).
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer, type ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface DecisionSummaryWire {
  decisions: number;
  fixed: number;
  added: number;
  declined: number;
  approvedWithReason: number;
}

interface EventBrief {
  id: string;
  kind: string;
  runId?: string;
  gate?: { inFlight?: boolean; outcome?: string; steps?: unknown[]; [key: string]: unknown };
  decisionSummary?: DecisionSummaryWire;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: EventBrief[];
  openRuns: unknown[];
}

interface GateStepFixture {
  name: string;
  status: string;
  findings: number;
}

describe("sealed gate events carry a decisionSummary in the events list", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function registerAgent(key: string, agentId: string, role = "ORCHESTRATOR"): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role });
    expect(res.status).toBe(200);
  }

  function gatePayload(
    intent: string,
    steps: GateStepFixture[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { intent, outcome: "passed", steps, ...overrides };
  }

  async function postGate(
    key: string,
    agentId: string,
    gate: Record<string, unknown>,
  ): Promise<string> {
    const res = await postJson("/api/v2/gates", { projectKey: key, agentId, gate });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResponse;
    return body.event as string;
  }

  async function postDecision(
    key: string,
    agentId: string,
    decision: Record<string, unknown>,
  ): Promise<void> {
    const res = await postJson("/api/v2/gate-decisions", { projectKey: key, agentId, decision });
    expect(res.status).toBe(201);
  }

  async function listEvents(key: string): Promise<EventBrief[]> {
    const res = await getJson(`/api/v2/events?project=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    return body.events;
  }

  function eventById(events: EventBrief[], id: string): EventBrief {
    const found = events.find((e) => e.id === id);
    if (found === undefined) throw new Error(`event ${id} not found in list`);
    return found;
  }

  // ── the worked example, lifted verbatim from the spec's own Counting
  // rules paragraph ───────────────────────────────────────────────────────

  test("the spec's own worked example — two approved steps, a 3-id distinct fix plus one added finding, one reasoned approval — computes decisions:4 fixed:3 added:1 declined:16 approvedWithReason:1", async () => {
    boot();
    const key = await createProject("decision-summary-worked-example");
    await registerAgent(key, "orchestrator-1");

    const runId = "run-worked-example-1";
    const eventId = await postGate(
      key,
      "orchestrator-1",
      gatePayload(
        "wave 7 no-mistakes gate",
        [
          { name: "review", status: "passed", findings: 10 },
          { name: "test", status: "passed", findings: 9 },
        ],
        { run: { id: runId } },
      ),
    );

    await postDecision(key, "orchestrator-1", {
      runId,
      action: "fix",
      step: "review",
      findings: ["f1", "f2", "f3"],
    });
    await postDecision(key, "orchestrator-1", {
      runId,
      action: "fix",
      step: "review",
      addedFinding: { id: "fx-1", file: "src/a.ts", description: "an extra finding" },
    });
    await postDecision(key, "orchestrator-1", {
      runId,
      action: "approve",
      step: "review",
      reason: "looks fine",
    });
    await postDecision(key, "orchestrator-1", { runId, action: "approve", step: "test" });

    const events = await listEvents(key);
    const event = eventById(events, eventId);
    expect(event.decisionSummary).toEqual({
      decisions: 4,
      fixed: 3,
      added: 1,
      declined: 16,
      approvedWithReason: 1,
    });
  });

  // ── fixed is DISTINCT, never a sum of each decision's own count ─────────

  test("fixed counts a finding id ONCE even when two different fix decisions both select it — a sum of each decision's own findings length would read 4, not the correct 3", async () => {
    boot();
    const key = await createProject("decision-summary-dedup-fixed");
    await registerAgent(key, "orchestrator-1");

    const runId = "run-dedup-1";
    const eventId = await postGate(
      key,
      "orchestrator-1",
      gatePayload("dedup gate", [{ name: "fix-step", status: "passed", findings: 8 }], {
        run: { id: runId },
      }),
    );

    await postDecision(key, "orchestrator-1", {
      runId,
      action: "fix",
      step: "fix-step",
      findings: ["f1", "f2"],
    });
    await postDecision(key, "orchestrator-1", {
      runId,
      action: "fix",
      step: "fix-step",
      findings: ["f2", "f3"],
    });
    await postDecision(key, "orchestrator-1", { runId, action: "approve", step: "fix-step" });

    const events = await listEvents(key);
    const summary = eventById(events, eventId).decisionSummary;
    expect(summary?.fixed).toBe(3);
    expect(summary?.decisions).toBe(3);
    expect(summary?.declined).toBe(5); // 8 step findings − 3 distinct fixed
    expect(summary?.approvedWithReason).toBe(0);
  });

  // ── declined sums ONLY over steps that were actually approved ───────────

  test("declined sums only the APPROVED steps — a step that was fixed-but-never-approved, and a step that was skipped, contribute NOTHING even though their own findings counts are nonzero", async () => {
    boot();
    const key = await createProject("decision-summary-approved-only");
    await registerAgent(key, "orchestrator-1");

    const runId = "run-approved-only-1";
    const eventId = await postGate(
      key,
      "orchestrator-1",
      gatePayload(
        "approved-only gate",
        [
          { name: "stepA", status: "passed", findings: 10 },
          { name: "stepB", status: "passed", findings: 7 },
          { name: "stepC", status: "passed", findings: 4 },
        ],
        { run: { id: runId } },
      ),
    );

    await postDecision(key, "orchestrator-1", {
      runId,
      action: "approve",
      step: "stepA",
      reason: "fine",
    });
    await postDecision(key, "orchestrator-1", {
      runId,
      action: "fix",
      step: "stepB",
      findings: ["x1"],
    });
    await postDecision(key, "orchestrator-1", { runId, action: "skip", step: "stepC" });

    const events = await listEvents(key);
    const summary = eventById(events, eventId).decisionSummary;
    expect(summary?.decisions).toBe(3);
    expect(summary?.fixed).toBe(1); // the fix on stepB still counts toward fixed
    expect(summary?.added).toBe(0);
    // Only stepA was approved: 10 findings − 0 fixed AT stepA (the one fix
    // decision named stepB, not stepA) = 10. stepB's 7 and stepC's 4 never
    // enter the sum because neither step was approved.
    expect(summary?.declined).toBe(10);
    expect(summary?.approvedWithReason).toBe(1);
  });

  // ── "none" — absent key, never a zeroed object ───────────────────────────

  test("a sealed gate naming a run with ZERO recorded decisions carries no decisionSummary key at all", async () => {
    boot();
    const key = await createProject("decision-summary-zero-decisions");
    await registerAgent(key, "orchestrator-1");

    const eventId = await postGate(
      key,
      "orchestrator-1",
      gatePayload("no decisions yet", [{ name: "solo", status: "passed", findings: 2 }], {
        run: { id: "run-zero-decisions-1" },
      }),
    );

    const events = await listEvents(key);
    const event = eventById(events, eventId);
    expect("decisionSummary" in event).toBe(false);
  });

  test("an in-flight gate (gate.inFlight === true) carries no decisionSummary even when decisions are already recorded for its runId", async () => {
    boot();
    const key = await createProject("decision-summary-in-flight");
    await registerAgent(key, "orchestrator-1");

    const runId = "run-inflight-1";
    const eventId = await postGate(key, "orchestrator-1", {
      intent: "still running",
      outcome: "checks-passed",
      inFlight: true,
      steps: [{ name: "solo", status: "running", findings: 0 }],
      run: { id: runId },
    });
    await postDecision(key, "orchestrator-1", { runId, action: "approve", step: "solo" });

    const events = await listEvents(key);
    const event = eventById(events, eventId);
    expect("decisionSummary" in event).toBe(false);
  });

  test("a gate naming no run carries no decisionSummary, whatever decisions exist for OTHER runs in the same project", async () => {
    boot();
    const key = await createProject("decision-summary-no-run-id");
    await registerAgent(key, "orchestrator-1");

    const otherRunId = "run-with-decisions-elsewhere-1";
    await postGate(
      key,
      "orchestrator-1",
      gatePayload("a sibling gate with a run", [{ name: "solo", status: "passed", findings: 5 }], {
        run: { id: otherRunId },
      }),
    );
    await postDecision(key, "orchestrator-1", { runId: otherRunId, action: "approve", step: "solo" });

    const runlessEventId = await postGate(
      key,
      "orchestrator-1",
      gatePayload("names no run at all", [{ name: "solo", status: "passed", findings: 3 }]),
    );

    const events = await listEvents(key);
    const event = eventById(events, runlessEventId);
    expect(event.runId).toBeUndefined();
    expect("decisionSummary" in event).toBe(false);
  });

  test("a non-gate event (a milestone) never carries decisionSummary", async () => {
    boot();
    const key = await createProject("decision-summary-non-gate-event");
    await registerAgent(key, "orchestrator-1");

    const res = await postJson("/api/v2/milestones", {
      projectKey: key,
      agentId: "orchestrator-1",
      type: "custom",
      label: "a non-gate marker",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResponse;
    const milestoneId = body.event as string;

    const events = await listEvents(key);
    const event = eventById(events, milestoneId);
    expect(event.kind).toBe("milestone");
    expect("decisionSummary" in event).toBe(false);
  });

  // ── G1 — ONE grouped query per list read, never one per gate ───────────

  test("the events LIST read touches gate_decisions through exactly ONE statement for the whole page, whatever the number of sealed gates with recorded decisions on it — not one query per gate", async () => {
    boot();
    const key = await createProject("decision-summary-one-grouped-query");
    await registerAgent(key, "orchestrator-1");

    for (const n of [1, 2, 3]) {
      const runId = `run-query-count-${n}`;
      await postGate(
        key,
        "orchestrator-1",
        gatePayload(`query count gate ${n}`, [{ name: "solo", status: "passed", findings: 1 }], {
          run: { id: runId },
        }),
      );
      await postDecision(key, "orchestrator-1", { runId, action: "approve", step: "solo" });
    }

    const rawDb = (handle!.store as unknown as { db: Database }).db;
    const originalQuery = rawDb.query.bind(rawDb) as (
      sql: string,
      ...rest: unknown[]
    ) => ReturnType<Database["query"]>;
    let gateDecisionsQueryCalls = 0;
    const querySpy = spyOn(rawDb, "query").mockImplementation(
      ((sql: string, ...rest: unknown[]) => {
        if (typeof sql === "string" && /gate_decisions/i.test(sql)) {
          gateDecisionsQueryCalls++;
        }
        return originalQuery(sql, ...rest);
      }) as typeof rawDb.query,
    );

    let res: Response;
    try {
      res = await getJson(`/api/v2/events?project=${key}`);
    } finally {
      querySpy.mockRestore();
    }

    expect(res.status).toBe(200);
    // Sanity — the three gates really did reach decisionSummary territory:
    // asserted via the positive tests above; this test is purely structural.
    expect(gateDecisionsQueryCalls).toBe(1);
  });
});
