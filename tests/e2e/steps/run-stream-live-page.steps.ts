// A run streaming its tests through the REAL stream route moves the page
// without a reload: the running card's progress, the live drill-in's failures
// and the agent's `running …` line in the Project pane — then closes into its
// settled card.
//
// Nothing here is doubled. The run is opened with POST /api/v2/runs/start
// (run-lifecycle.steps.ts), each batch goes to POST
// /api/v2/runs/<runId>/stream, and the close is POST /api/v2/runs naming the
// `crucible-events` codec with no report. There is NO `page.route` stub of
// the live reads: the open-run brief's `live` and GET /api/v2/runs/<runId>/live
// answer what the board filled from the stream, and the page moves on the
// board's own throttled `events` frames. A frame may lag a batch by up to the
// board's frame cadence (two seconds), so every wait below is on the DOM, with
// a timeout of a few cadences — never a sleep.
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { Step } from "./world.ts";

const STREAM_CODEC = "crucible-events";

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/**
 * The run's test stream, as the three batches it is sent in. Four tests: two
 * pass and two fail, the total stated by the run-start, the run-end closing it.
 */
const STREAM_BATCHES: readonly string[] = [
  line({ event: "run-start", total: 4 }) +
    line({ event: "test-end", id: "s-1", name: "parses a batch", suite: "Relay", file: "src/relay.test.ts", status: "pass", duration_ms: 4 }) +
    line({
      event: "test-end",
      id: "s-2",
      name: "rejects a gap",
      suite: "Relay",
      file: "src/gap.test.ts",
      status: "fail",
      duration_ms: 6,
      failure: { message: "expected 409, received 200", type: "AssertionError" },
    }),
  line({ event: "test-end", id: "s-3", name: "resends its tail", suite: "Relay", file: "src/resend.test.ts", status: "pass", duration_ms: 5 }),
  line({
    event: "test-end",
    id: "s-4",
    name: "closes twice",
    suite: "Close",
    file: "src/close.test.ts",
    status: "fail",
    duration_ms: 7,
    failure: { message: "expected one event, found two", type: "AssertionError" },
  }) + line({ event: "run-end", total: 4, passed: 2, failed: 2, pending: 0, duration_ms: 22 }),
];

/** A frame lags a batch by at most one cadence; a few cadences bound the wait. */
const secondsToMs = (seconds: number): number => seconds * 1_000;

const agentRow = (page: Page, agentId: string): Locator =>
  page.getByTestId("project-pane").getByTestId("agent-row").filter({ hasText: agentId });

Step(
  "the run streams batch {int} of its test stream through the stream route",
  async ({ request, world }, n: number) => {
    const data = STREAM_BATCHES[n - 1];
    expect(data, `the stream has ${String(STREAM_BATCHES.length)} batches`).toBeDefined();
    const from = STREAM_BATCHES.slice(0, n - 1).reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0);
    const res = await request.post(`/api/v2/runs/${world.runId as string}/stream`, {
      data: {
        projectKey: world.projectKey as string,
        agentId: world.streamingAgent as string,
        codec: STREAM_CODEC,
        from,
        data,
      },
    });
    const body = (await res.json()) as { ok?: boolean; held?: number };
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.held).toBe(from + Buffer.byteLength(data ?? "", "utf8"));
  },
);

Step("agent {string} is the run's streaming agent", async ({ world }, agentId: string) => {
  world.streamingAgent = agentId;
});

Step(
  "the running card for {string} reads {string} in {string} within {int} seconds",
  async ({ page }, agentId: string, count: string, file: string, seconds: number) => {
    const card = page.getByTestId("running-card").filter({ hasText: agentId });
    await expect(card.getByTestId("running-count")).toHaveText(count, { timeout: secondsToMs(seconds) });
    await expect(card.getByTestId("running-file")).toHaveText(file, { timeout: secondsToMs(seconds) });
  },
);

Step(
  "the project pane's agent row for {string} reads {string} within {int} seconds",
  async ({ page }, agentId: string, text: string, seconds: number) => {
    const message = agentRow(page, agentId).locator(".app-agent-msg");
    await expect(message).toHaveText(text, { timeout: secondsToMs(seconds) });
  },
);

Step(
  "the project pane's agent row for {string} no longer reads a running line within {int} seconds",
  async ({ page }, agentId: string, seconds: number) => {
    const message = agentRow(page, agentId).locator(".app-agent-msg");
    await expect(message).toBeVisible();
    await expect(message).not.toHaveText(/^running /, { timeout: secondsToMs(seconds) });
  },
);

Step(
  "the live drill-in lists the failures {string} in order within {int} seconds",
  async ({ page }, names: string, seconds: number) => {
    const expected = names.split("|").map((name) => name.trim());
    const rows = page.getByTestId("live-failure-row");
    await expect(rows).toHaveCount(expected.length, { timeout: secondsToMs(seconds) });
    await expect(rows.getByTestId("live-failure-name")).toHaveText(expected);
  },
);

Step("the run is closed through POST \\/api\\/v2\\/runs naming the crucible-events codec", async ({ request, world }) => {
  const res = await request.post("/api/v2/runs", {
    data: {
      projectKey: world.projectKey as string,
      agentId: world.streamingAgent as string,
      runId: world.runId as string,
      codec: STREAM_CODEC,
    },
  });
  const body = (await res.json()) as { event?: string; run?: { total?: number; failed?: number } };
  expect(res.status(), JSON.stringify(body)).toBe(200);
  expect(typeof body.event).toBe("string");
  world.eventId = body.event;
});
