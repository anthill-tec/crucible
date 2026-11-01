// An open run's live failures carry their browser, and its live fill ignores
// a test's steps:
//  - a failing `test-end` naming a `browser` stores it on its live failure:
//    `run_live_failures` has a nullable `browser` column, and
//    `RunLiveFailure` answers it (`Store#runLive` and
//    `GET /api/v2/runs/<runId>/live`), so one scenario failing under two
//    browsers shows two distinct failures;
//  - a failure with no browser stores NULL and answers no `browser` key;
//  - the live fill (`fillRunLive`) counts tests, never steps: an expected
//    failure (a passing test holding a failing step) adds no failure, and a
//    failing test's failing step adds none of its own;
//  - an ill-formed `browser` or `steps` makes its line undecodable, so the
//    live fill counts it as no completed test and stores no failure for it.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerHandle } from "../src/server.ts";
import {
  base,
  bootOn,
  eventLine,
  openRun,
  readyProject,
  sendBatch,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

function dbOf(handle: ServerHandle): Database {
  return (handle.store as unknown as { db: Database }).db;
}

const AGENT = "live-browser-runner";

/** An open run, streamed one batch of `text`; answers its runId. */
async function streamingRun(handle: ServerHandle, text: string): Promise<string> {
  const key = await readyProject(handle, [AGENT], "live-browser");
  const runId = await openRun(handle, key, AGENT, { stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  return runId;
}

async function liveRoute(handle: ServerHandle, runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}/api/v2/runs/${encodeURIComponent(runId)}/live`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function storedBrowsers(handle: ServerHandle, runId: string): Array<string | null> {
  return dbOf(handle)
    .query<{ browser: string | null }, [string]>(
      `SELECT browser FROM run_live_failures WHERE run_id = ? ORDER BY position`,
    )
    .all(runId)
    .map((row) => row.browser);
}

const FAILING_STEPS = [
  { name: "Given a cart holding one book", status: "pass", duration_ms: 3 },
  { name: "When I pay by card", status: "fail", duration_ms: 4, failure: { message: "card declined" } },
];

/** One scenario failing under chromium and under firefox. */
const TWO_BROWSER_FAILURES =
  eventLine({ event: "run-start", total: 2 }) +
  eventLine({
    event: "test-end",
    id: "card-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "fail",
    duration_ms: 7,
    failure: { message: "card declined", type: "AssertionError" },
    steps: FAILING_STEPS,
  }) +
  eventLine({
    event: "test-end",
    id: "card-firefox",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "firefox",
    status: "fail",
    duration_ms: 8,
    failure: { message: "card declined", type: "AssertionError" },
    steps: FAILING_STEPS,
  });

const TWO_FAILURES = [
  {
    id: "card-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    message: "card declined",
    type: "AssertionError",
  },
  {
    id: "card-firefox",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "firefox",
    message: "card declined",
    type: "AssertionError",
  },
];

describe("live failures carry their browser", () => {
  test("a scenario failing under two browsers is two live failures, each naming its browser, in Store#runLive", async () => {
    const handle = boot();
    const runId = await streamingRun(handle, TWO_BROWSER_FAILURES);

    const live = handle.store.runLive(runId);
    expect(live?.failures as unknown).toEqual(TWO_FAILURES);
    expect(storedBrowsers(handle, runId)).toEqual(["chromium", "firefox"]);
  });

  test("GET /api/v2/runs/<runId>/live answers each failure's browser", async () => {
    const handle = boot();
    const runId = await streamingRun(handle, TWO_BROWSER_FAILURES);

    const body = await liveRoute(handle, runId);
    expect(body.state).toBe("open");
    expect(body.failures).toEqual(TWO_FAILURES);
  });

  test("a failure stated with no browser stores NULL and answers no browser key", async () => {
    const handle = boot();
    const runId = await streamingRun(
      handle,
      eventLine({ event: "test-end", id: "t1", name: "adds", suite: "math", file: "src/math.ts", status: "fail", failure: { message: "1 + 1 is not 3" } }),
    );

    expect(storedBrowsers(handle, runId)).toEqual([null]);
    const failures = handle.store.runLive(runId)?.failures ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toHaveProperty("browser");
    expect(failures[0]?.message).toBe("1 + 1 is not 3");
  });
});

describe("the live fill ignores steps", () => {
  test("an expected failure holding a failing step adds no failure; a failing test's failing step adds none beside the test's own", async () => {
    const handle = boot();
    const runId = await streamingRun(
      handle,
      eventLine({ event: "run-start", total: 2 }) +
        eventLine({
          event: "test-end",
          id: "expected-failure-chromium",
          name: "A known defect stays failing",
          suite: "Known defects",
          file: "features/known.feature",
          browser: "chromium",
          status: "pass",
          duration_ms: 5,
          steps: [
            { name: "Given the known defect", status: "pass", duration_ms: 1 },
            { name: "Then it still fails", status: "fail", duration_ms: 4, failure: { message: "expected to fail" } },
          ],
        }) +
        eventLine({
          event: "test-end",
          id: "card-webkit",
          name: "Pay by card",
          suite: "Checkout",
          file: "features/checkout.feature",
          browser: "webkit",
          status: "fail",
          duration_ms: 7,
          failure: { message: "card declined" },
          steps: FAILING_STEPS,
        }),
    );

    const live = handle.store.runLive(runId);
    expect({ completed: live?.completed, passed: live?.passed, failed: live?.failed, pending: live?.pending }).toEqual({
      completed: 2,
      passed: 1,
      failed: 1,
      pending: 0,
    });
    expect(live?.failures as unknown).toEqual([
      {
        id: "card-webkit",
        name: "Pay by card",
        suite: "Checkout",
        file: "features/checkout.feature",
        browser: "webkit",
        message: "card declined",
      },
    ]);
  });

  test("a line with an empty browser or a step of a bad status is no completed test and stores no failure", async () => {
    const handle = boot();
    const runId = await streamingRun(
      handle,
      eventLine({ event: "test-end", id: "empty-browser", name: "Pay by card", suite: "Checkout", browser: "", status: "fail", failure: { message: "x" } }) +
        eventLine({
          event: "test-end",
          id: "bad-step",
          name: "Pay by voucher",
          suite: "Checkout",
          browser: "chromium",
          status: "fail",
          failure: { message: "y" },
          steps: [{ name: "When I redeem it", status: "broken" }],
        }) +
        eventLine({ event: "test-end", id: "good", name: "Pay by gift card", suite: "Checkout", browser: "chromium", status: "pass", duration_ms: 1 }),
    );

    const live = handle.store.runLive(runId);
    expect({ completed: live?.completed, passed: live?.passed, failed: live?.failed }).toEqual({ completed: 1, passed: 1, failed: 0 });
    expect(live?.failures).toEqual([]);
  });
});
