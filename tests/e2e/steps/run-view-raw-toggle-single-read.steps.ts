// run-view-raw-toggle-single-read.feature — steps. CR-CRU-167 §S2: the run
// view must show the raw toggle only when `rawBytes` is present on the
// ?depth=suites read, fetch the raw text with exactly one full read
// (`GET /api/v2/events/<id>`, no query string) the first time the toggle
// opens, and never fetch it again on a later suite load. Tracks every
// request the page makes to the run's own event endpoint
// (`page.on("request", ...)`) from before the cold-URL navigation, so every
// assertion below is made on the REAL requests the browser issued — never on
// a mocked fetch.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestJunit, JUNIT_3CASE_1FAIL } from "./harness.ts";

/** Two all-passing suites, plus a `<system-out>` raw capture at the
 *  `<testsuites>` root — `parseJunit` (src/codecs/junit.ts) joins it into
 *  the run's `raw` field. A distinctive marker string so the drawn raw
 *  panel can be told apart from any other text in the overlay. */
const RAW_MARKER = "RAWNET-MARKER-9f2c captured run output";
function junitTwoSuitesWithRaw(): string {
  return [
    "<testsuites>",
    '<testsuite name="RawNet-Suite1" tests="1">',
    '<testcase name="t1" time="0.01"/>',
    "</testsuite>",
    '<testsuite name="RawNet-Suite2" tests="1">',
    '<testcase name="t1" time="0.01"/>',
    "</testsuite>",
    `<system-out>${RAW_MARKER}</system-out>`,
    "</testsuites>",
  ].join("\n");
}

Step(
  "an e2e run with captured raw output across two suites is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestJunit(request, world.projectKey as string, agentId, junitTwoSuitesWithRaw(), "e2e");
    world.eventId = res.event;
  },
);

Step(
  "an e2e run with no raw output is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestJunit(request, world.projectKey as string, agentId, JUNIT_3CASE_1FAIL, "e2e");
    world.eventId = res.event;
  },
);

/** The pathname segment identifying "the run's own event endpoint", decoded
 *  back to the plain event id so a request's id can be compared against
 *  `world.eventId` regardless of how the browser percent-encoded it. */
function requestEventId(url: string): string | null {
  const parsed = new URL(url);
  const match = /\/api\/v2\/events\/([^/?]+)$/.exec(parsed.pathname);
  return match === null ? null : decodeURIComponent(match[1]!);
}

/** True for the FULL read only — `GET /api/v2/events/<id>` with NO query
 *  string at all. `?depth=suites` and `?suite=<name>` both have a
 *  query string and must never count here. */
function isFullReadOf(url: string, eventId: string): boolean {
  const parsed = new URL(url);
  return parsed.search === "" && requestEventId(url) === eventId;
}

Step("I start recording the run's event requests", async ({ page, world }) => {
  const log: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (requestEventId(url) !== null) log.push(url);
  });
  world.eventRequestLog = log;
});

function fullReadCount(world: Record<string, unknown>): number {
  const log = (world.eventRequestLog as string[] | undefined) ?? [];
  const eventId = world.eventId as string;
  return log.filter((u) => isFullReadOf(u, eventId)).length;
}

Step("no full read of the run has been requested", async ({ world }) => {
  const log = (world.eventRequestLog as string[] | undefined) ?? [];
  expect(fullReadCount(world), `requests so far: ${JSON.stringify(log)}`).toBe(0);
});

Step("exactly one full read of the run has been requested", async ({ world }) => {
  const log = (world.eventRequestLog as string[] | undefined) ?? [];
  expect(fullReadCount(world), `requests so far: ${JSON.stringify(log)}`).toBe(1);
});

Step("the run overlay shows a raw toggle", async ({ page }) => {
  await expect(page.getByTestId("run-overlay").getByTestId("raw-toggle")).toBeVisible();
});

Step("the run overlay shows no raw toggle", async ({ page }) => {
  await expect(page.getByTestId("run-overlay")).toBeVisible();
  await expect(page.getByTestId("run-overlay").getByTestId("raw-toggle")).toHaveCount(0);
});

Step("the raw toggle reveals the captured raw output text", async ({ page }) => {
  await expect(page.getByTestId("run-overlay").getByTestId("raw-output")).toContainText(RAW_MARKER);
});
