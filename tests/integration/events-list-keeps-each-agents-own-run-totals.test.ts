// The events list as a client reads its own runs back: two agents filing JUnit
// reports into ONE project at the same time each find exactly their own run in
// `GET /api/v2/events`, carrying the totals decoded from THEIR report — never
// the other agent's, never a merge of both.
//
// Routes pinned:
//   POST /api/v2/agents/register                   — the two filing agents
//   POST /api/v2/runs (codec "junit")              — each agent's report, sent concurrently
//   GET  /api/v2/events?project=<key>&limit=100    — the briefs, read back per agent
//
// Safety: every server binds port 0 on a ":memory:" store.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import { bootOn, getJson, postJson, register } from "../helpers/run-stream-harness.ts";

const ALPHA = "agent-alpha";
const BRAVO = "agent-bravo";

interface EventBrief {
  id: string;
  agentId: string;
  kind: string;
  total: number;
  passed: number;
  failed: number;
  [key: string]: unknown;
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

/** A JUnit report of `passing` passing cases and `failing` failing ones, each named after its agent. */
function junit(agent: string, passing: number, failing: number): string {
  const cases: string[] = [];
  for (let i = 0; i < passing; i++) cases.push(`<testcase name="${agent}_pass_${i}" time="0.01"/>`);
  for (let i = 0; i < failing; i++) {
    cases.push(`<testcase name="${agent}_fail_${i}" time="0.01"><failure message="boom">trace</failure></testcase>`);
  }
  return [`<testsuite name="${agent}" tests="${passing + failing}">`, ...cases, "</testsuite>"].join("\n");
}

describe("GET /api/v2/events keeps each agent's own run totals", () => {
  test("two agents filing concurrently into one project each read back exactly one run with their own (total, passed, failed)", async () => {
    handle = bootOn();
    const created = await postJson(handle, "/api/v2/projects", { name: "events-two-agents" });
    expect(created.status).toBe(200);
    const key = (created.body.project as { key: string }).key;
    await register(handle, key, ALPHA);
    await register(handle, key, BRAVO);

    const [alpha, bravo] = await Promise.all([
      postJson(handle, "/api/v2/runs", { projectKey: key, agentId: ALPHA, codec: "junit", data: junit(ALPHA, 3, 0) }),
      postJson(handle, "/api/v2/runs", { projectKey: key, agentId: BRAVO, codec: "junit", data: junit(BRAVO, 6, 1) }),
    ]);
    expect(alpha.status, JSON.stringify(alpha.body)).toBe(200);
    expect(bravo.status, JSON.stringify(bravo.body)).toBe(200);
    expect(alpha.body.event).not.toBe(bravo.body.event);

    const read = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
    const runs = (read.events as EventBrief[]).filter((e) => e.kind === "test");
    const alphaRuns = runs.filter((e) => e.agentId === ALPHA);
    const bravoRuns = runs.filter((e) => e.agentId === BRAVO);
    expect(alphaRuns.length).toBe(1);
    expect(bravoRuns.length).toBe(1);
    expect(runs.length).toBe(2);

    expect(alphaRuns[0]!.id).toBe(alpha.body.event as string);
    expect(bravoRuns[0]!.id).toBe(bravo.body.event as string);
    expect([alphaRuns[0]!.total, alphaRuns[0]!.passed, alphaRuns[0]!.failed]).toEqual([3, 3, 0]);
    expect([bravoRuns[0]!.total, bravoRuns[0]!.passed, bravoRuns[0]!.failed]).toEqual([7, 6, 1]);
  });
});
