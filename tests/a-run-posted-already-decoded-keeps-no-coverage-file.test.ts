// A run posted already decoded to `POST /api/v2/runs/parsed` is totals only:
// a `coverageFiles` key in its body is ignored, as every key the route does
// not name is.
//
//  - the run is stored, with the coverage totals its body states;
//  - no `run_coverage_files` row is stored for it;
//  - its answer has neither `coverageFileCount` nor `coverageFiles`.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store), beside a run of files on the same board, so "no row" is never "no
// table".
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import { bootOn, postJson, readyProject, type Answer } from "./helpers/run-stream-harness.ts";
import {
  dbOf,
  eventIdOf,
  eventRead,
  fileRowCount,
  fileRowTotal,
  ingestRun,
  runBlockOf,
  TWELVE_BLOCK,
} from "./helpers/coverage-files-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "decoded-poster";

const POSTED_TOTALS = {
  lines: { total: 80, covered: 31, percent: 38.8 },
  functions: { total: 4, covered: 2, percent: 50 },
};

/** The two files the posted body names: well-formed, so nothing but the route's own reading keeps them out. */
const POSTED_FILES = [
  { path: "src/posted-beta.ts", lines: { total: 40, covered: 1, percent: 2.5 }, functions: { total: 1, covered: 0, percent: 0 } },
  { path: "src/posted-alpha.ts", lines: { total: 40, covered: 30, percent: 75 }, functions: { total: 3, covered: 2, percent: 66.7 } },
];

function postDecoded(handle: ServerHandle, key: string): Promise<Answer> {
  return postJson(handle, "/api/v2/runs/parsed", {
    projectKey: key,
    agentId: AGENT,
    summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 3 },
    tree: [
      {
        name: "Decoded",
        status: "pass",
        children: [
          { name: "d1", status: "pass", duration_ms: 1 },
          { name: "d2", status: "pass", duration_ms: 2 },
        ],
      },
    ],
    coverage: POSTED_TOTALS,
    coverageFiles: POSTED_FILES,
  });
}

describe("a run posted already decoded with a coverageFiles key in its body", () => {
  test("is stored with the totals its body states, and the full read answers no file", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const answer = await postDecoded(handle, key);

    const eventId = eventIdOf(answer);
    const event = await eventRead(handle, eventId);
    expect(event.coverage).toEqual(POSTED_TOTALS);
    expect(event.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 3 });
    expect((event.tree as Array<{ name: string; children: unknown[] }>).map((suite) => [suite.name, suite.children.length])).toEqual([["Decoded", 2]]);
    expect("coverageFiles" in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain("src/posted-");
  });

  test("stores no file row, beside a run of 12 files that stores its 12", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const fileBearing = eventIdOf(await ingestRun(handle, key, AGENT, TWELVE_BLOCK));

    const eventId = eventIdOf(await postDecoded(handle, key));

    const db = dbOf(handle.store);
    expect(fileRowCount(db, eventId)).toBe(0);
    expect(fileRowCount(db, fileBearing)).toBe(12);
    // No row under any id: the twelve are the table's every row.
    expect(fileRowTotal(db)).toBe(12);
  });

  test("is answered with neither coverageFileCount nor coverageFiles", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const answer = await postDecoded(handle, key);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const run = runBlockOf(answer);
    expect(Object.keys(run).filter((name) => name.startsWith("coverageFile"))).toEqual([]);
    expect([run.total, run.passed, run.failed, run.pending]).toEqual([2, 2, 0, 0]);
    expect(Object.keys(answer.body).filter((name) => name.startsWith("coverageFile"))).toEqual([]);
    expect(JSON.stringify(answer.body)).not.toContain("src/posted-");
  });
});
