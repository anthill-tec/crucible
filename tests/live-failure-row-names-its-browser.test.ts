// An open run's live failure row names its browser, so one scenario failing
// under two Playwright projects reads as two distinct rows in the live
// drill-in (`/run/<runId>` in its live mode).
//
// The failures the view draws are the ones a REAL board answers: a
// `playwright-bdd` run is opened on an in-process board (`bootOn`, port 0,
// ":memory:"), one scenario's failing `test-end` is streamed under `chromium`
// and under `firefox`, and `GET /api/v2/runs/<runId>/live` is read. That
// answer — every key the board serialised, `browser` included — is what the
// live drill-in's /live read is answered with (tests/helpers/live-run-harness.ts),
// so a key renamed on one side of the crossing is caught here.
//
// INTERFACE CHOICE: the browser is drawn inside the `live-failure-row`, beside
// the test's name and file; this file asserts the row's text, not a testid.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import {
  mountLive,
  unmountLive,
  type LiveCounts,
  type LiveFailureFixture,
  type LiveMountOpts,
} from "./helpers/live-run-harness";
import { base, bootOn, eventLine, openRun, readyProject, sendBatch } from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(async () => {
  await unmountLive();
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "live-browser-row-runner";
const SCENARIO = "Pay by card";
const FEATURE_FILE = "features/checkout.feature";

function failingScenario(id: string, browser: string | undefined, name = SCENARIO): string {
  return eventLine({
    event: "test-end",
    id,
    name,
    suite: "Checkout",
    file: FEATURE_FILE,
    ...(browser !== undefined ? { browser } : {}),
    status: "fail",
    duration_ms: 7,
    failure: { message: "card declined" },
    steps: [
      { name: "Given a cart holding one book", status: "pass", duration_ms: 3 },
      { name: "When I pay by card", status: "fail", duration_ms: 4, failure: { message: "card declined" } },
    ],
  });
}

interface LiveAnswerBody {
  state: string;
  live?: LiveCounts;
  failures: LiveFailureFixture[];
}

/** An open run on a real board, streamed `text`; answers its runId, its key and its /live answer. */
async function liveOf(text: string): Promise<{ runId: string; key: string; body: LiveAnswerBody }> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "live-browser-row");
  const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const res = await fetch(`${base(handle)}/api/v2/runs/${encodeURIComponent(runId)}/live`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as LiveAnswerBody;
  expect(body.state).toBe("open");
  return { runId, key, body };
}

function liveFixture(runId: string, key: string, body: LiveAnswerBody): LiveMountOpts {
  const failed = body.failures.length;
  const live: LiveCounts = body.live ?? { completed: failed, total: failed, passed: 0, failed, pending: 0 };
  return {
    pathname: `/run/${runId}`,
    projects: [
      {
        key,
        name: "Live Browser Row Project",
        type: "frontend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: Date.now(),
        retention: 100,
      },
    ],
    agents: [{ agentId: AGENT, projectKey: key, liveness: "online", lastSeen: Date.now(), message: "running" }],
    events: [],
    eventDetails: {},
    openRuns: [{ runId, projectKey: key, agentId: AGENT, startedAt: Date.now() - 5_000, tier: "e2e", live }],
    live: { [runId]: { state: "open", live, failures: body.failures } },
  };
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function failureRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="live-failure-row"]'));
}

describe("a live failure row names its browser", () => {
  test("one scenario failing under chromium and firefox reads as two distinct rows, each naming its own browser and not the other", async () => {
    const { runId, key, body } = await liveOf(
      eventLine({ event: "run-start", total: 2 }) +
        failingScenario("card-chromium", "chromium") +
        failingScenario("card-firefox", "firefox"),
    );
    // PRECONDITION — the board answered both failures with their browsers.
    expect(body.failures.map((f) => (f as LiveFailureFixture & { browser?: string }).browser)).toEqual([
      "chromium",
      "firefox",
    ]);

    await mountLive(liveFixture(runId, key, body));

    const rows = failureRows();
    expect(rows.length).toBe(2);
    const [chromiumRow, firefoxRow] = rows.map(text);
    // Both rows name the same scenario…
    expect(text(rows[0]?.querySelector('[data-testid="live-failure-name"]') ?? null)).toBe(SCENARIO);
    expect(text(rows[1]?.querySelector('[data-testid="live-failure-name"]') ?? null)).toBe(SCENARIO);
    // …each names its own browser, and only its own.
    expect(chromiumRow).toContain("chromium");
    expect(chromiumRow).not.toContain("firefox");
    expect(firefoxRow).toContain("firefox");
    expect(firefoxRow).not.toContain("chromium");
    // NEGATIVE — the two rows do not read alike.
    expect(chromiumRow).not.toBe(firefoxRow);
  });

  test("a live failure stated with no browser draws its row with no browser and no placeholder", async () => {
    const { runId, key, body } = await liveOf(
      eventLine({ event: "run-start", total: 2 }) +
        failingScenario("card-chromium", "chromium") +
        failingScenario("adds", undefined, "Pay by voucher"),
    );

    await mountLive(liveFixture(runId, key, body));

    const rows = failureRows();
    expect(rows.length).toBe(2);
    expect(text(rows[0] ?? null)).toContain("chromium");
    const plain = text(rows[1] ?? null);
    expect(plain).toContain("Pay by voucher");
    expect(plain).not.toContain("chromium");
    expect(plain).not.toContain("undefined");
    expect(plain).not.toContain("null");
  });
});
