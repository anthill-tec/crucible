// CR-CRU-223 — network-level test doubles for the TWO live reads an open run's
// live view makes: the events feed's open-run brief (its `live` field) and
// GET /api/v2/runs/<runId>/live. The same seam burndown-analytics-mock.ts
// uses, for the same reason: the data behind them is unreachable through the
// real routes in this CR.
//
// WHY A MOCK, NOT THE REAL STATE: the live state is filled from a test stream
// the board takes in CR-CRU-200; until then `Store#runLive` answers nothing,
// so no sequence of real requests can give an open run a live state. Every
// other part of each scenario is real — the run is opened with
// POST /api/v2/runs/start, ingested or aborted through the real routes, the
// change frames are the server's own, and the SPA is unmodified.
//
// Both doubles PASS THROUGH to the real server first and only fill in what the
// live state would hold:
//  - the events feed: the real response, with `live` added to THIS run's
//    open-run brief only while the real brief carries none;
//  - /live: the real answer whenever it is a settled answer (`ended` /
//    `aborted` with the real event id — the route this CR ships answers that
//    without any live state), and otherwise the fixture's open answer,
//    honouring `?from=`.
import type { Page } from "@playwright/test";

export interface LiveCountsFixture {
  completed: number;
  total?: number;
  passed: number;
  failed: number;
  pending: number;
  currentFile?: string;
}

export interface LiveFailureFixture {
  id: string;
  name: string;
  suite: string;
  file: string;
  message?: string;
  type?: string;
}

/** The live state a scenario holds for its run; mutated in place to move it. */
export interface LiveStateFixture {
  live: LiveCountsFixture;
  failures: LiveFailureFixture[];
  /** Every /live URL the page asked for, in order (path + query). */
  reads: string[];
}

/** The F25 run: 412 of 1280, three failures, the last with only a type. */
export function f25LiveState(currentFile: string): LiveStateFixture {
  return {
    live: { completed: 412, total: 1280, passed: 409, failed: 3, pending: 0, currentFile },
    failures: [
      {
        id: "f-1",
        name: "test_acks_each_batch",
        suite: "test_relay.RelayTest",
        file: "test_relay.py",
        message: "AssertionError: 3 != 4 : the board acknowledged 3 batches",
      },
      {
        id: "f-2",
        name: "test_close_sends_the_rest",
        suite: "test_relay.RelayTest",
        file: "test_relay.py",
        message: "AssertionError: offset 4096 never sent",
      },
      {
        id: "f-3",
        name: "test_run_end_totals",
        suite: "test_stream.StreamTest",
        file: "test_stream.py",
        type: "KeyError",
      },
    ],
    reads: [],
  };
}

interface OpenRunWire {
  runId: string;
  live?: unknown;
  [key: string]: unknown;
}

/** Install the two live-read doubles for `runId`. Call before the page loads. */
export async function routeRunLive(page: Page, runId: string, state: LiveStateFixture): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/v2/events",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { openRuns?: OpenRunWire[]; [key: string]: unknown };
      if (Array.isArray(body.openRuns)) {
        body.openRuns = body.openRuns.map((run) =>
          run.runId === runId && run.live === undefined ? { ...run, live: { ...state.live } } : run,
        );
      }
      await route.fulfill({ response, json: body });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/v2/runs/${runId}/live`,
    async (route) => {
      const url = new URL(route.request().url());
      state.reads.push(`${url.pathname}${url.search}`);
      const real = await route.fetch();
      if (real.status() === 200) {
        const body = (await real.json()) as { state?: string };
        if (body.state === "ended" || body.state === "aborted") {
          await route.fulfill({ response: real, json: body });
          return;
        }
      }
      const from = Number(url.searchParams.get("from") ?? "0") || 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: "open",
          live: { ...state.live },
          failures: state.failures.slice(from),
          failuresFrom: from,
        }),
      });
    },
  );
}
