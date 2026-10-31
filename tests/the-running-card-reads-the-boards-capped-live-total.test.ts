// The running card's live count text reads the board's answer for `total`,
// and that answer is never below `completed`, so the card never shows
// `3/2` (CR-CRU-201 §S2, AC2: "public/app.js's live count text shows it").
//
// The path is real end to end on the board's side: a real server
// (`startServer`, port 0, ":memory:") opens a run, takes a `crucible-events`
// stream whose `run-start` states 2 tests and which then finishes 3, and
// serves the open-run brief on `GET /api/v2/events`. That brief — exactly as
// the board served it — is what the REAL public/app.js is mounted on, through
// tests/helpers/live-run-harness.ts, and the card's `running-count` is read.
//
// The harness replaces the global fetch when it mounts the page, so the
// board is read with the fetch captured before any mount.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import { bootOn, eventLine, readyProject } from "./helpers/run-stream-harness.ts";
import { mountLive, unmountLive, type OpenRunFixture } from "./helpers/live-run-harness.ts";

const realFetch = globalThis.fetch;

const handles: ServerHandle[] = [];

afterEach(async () => {
  await unmountLive();
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "card-reader";

async function post(handle: ServerHandle, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await realFetch(`http://127.0.0.1:${handle.server.port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The open-run brief the board serves for a run that finished 3 tests of a stated 2. */
async function overrunBrief(): Promise<{ key: string; brief: OpenRunFixture }> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "capped-card");
  const started = await post(handle, "/api/v2/runs/start", { projectKey: key, agentId: AGENT, stack: "bun", tier: "unit" });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const runId = started.body.runId as string;
  const pass = (n: number) =>
    eventLine({ event: "test-end", id: `c${n}`, name: `case ${n}`, suite: "Card", file: "src/card.test.ts", status: "pass" });
  const stream = eventLine({ event: "run-start", total: 2 }) + pass(1) + pass(2) + pass(3);
  const batch = await post(handle, `/api/v2/runs/${runId}/stream`, {
    projectKey: key,
    agentId: AGENT,
    codec: "crucible-events",
    from: 0,
    data: stream,
  });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const res = await realFetch(`http://127.0.0.1:${handle.server.port}/api/v2/events?project=${key}`);
  const events = (await res.json()) as { openRuns: OpenRunFixture[] };
  const brief = events.openRuns.find((r) => r.runId === runId);
  if (brief === undefined) throw new Error(`the board served no open-run brief for ${runId}`);
  return { key, brief };
}

describe("the running card shows the board's capped live total", () => {
  test("a run that finished 3 tests of a stated 2: the board's brief answers total 3, and the card reads `3/3`, never `3/2`", async () => {
    const { key, brief } = await overrunBrief();
    expect(brief.live).toEqual({ completed: 3, total: 3, passed: 3, failed: 0, pending: 0, currentFile: "src/card.test.ts" });

    await mountLive({
      pathname: "/",
      projects: [
        { key, name: "Capped Card", type: "backend", agentsOnline: 1, agentsTotal: 1, active: true, lastActivity: Date.now() },
      ],
      agents: [{ agentId: AGENT, projectKey: key, liveness: "online", lastSeen: Date.now(), message: "running" }],
      events: [],
      eventDetails: {},
      openRuns: [brief],
      live: {},
    });
    const cards = document.querySelectorAll('[data-testid="running-card"]');
    expect(cards.length).toBe(1);
    const count = (cards[0] as HTMLElement).querySelector('[data-testid="running-count"]');
    expect((count?.textContent ?? "").trim()).toBe("3/3");
    expect((cards[0] as HTMLElement).textContent ?? "").not.toContain("3/2");
  });
});
