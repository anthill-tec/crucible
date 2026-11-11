// The lists stay as they are when a run keeps its coverage files:
//
//  - `GET /api/v2/projects`, the recent feed (`GET /api/v2/events?project=`)
//    and `GET /api/v2/status` answer a project whose coverage run has files
//    exactly as they answer it without those files;
//  - none of them runs a statement on `run_coverage_files`;
//  - an event brief carries the run's totals as before, and no file key.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store). "Without those files" is the same run with its file rows taken out
// on the board's own connection, so nothing but the files differs between the
// two answers.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import { bootOn, getJson, readyProject } from "./helpers/run-stream-harness.ts";
import {
  dbOf,
  eventIdOf,
  fileReadKeysOf,
  fileRowCount,
  filesTableStatements,
  ingestRun,
  recordQueries,
  TWELVE_BLOCK,
  type QueryRecord,
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

const AGENT = "list-reader";

/** A board whose one project's newest run is a green run of the twelve files. */
async function projectWithAFileBearingRun(): Promise<{ handle: ServerHandle; key: string; eventId: string }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT], "file-bearing");
  const eventId = eventIdOf(await ingestRun(handle, key, AGENT, TWELVE_BLOCK));
  expect(fileRowCount(dbOf(handle.store), eventId)).toBe(12);
  return { handle, key, eventId };
}

/** Take the run's file rows out, leaving the run as one that kept no files. */
function takeTheFilesOut(handle: ServerHandle, eventId: string): void {
  const db = dbOf(handle.store);
  db.query(`DELETE FROM run_coverage_files WHERE event_id = ?`).run(eventId);
  expect(fileRowCount(db, eventId)).toBe(0);
}

/** One read's body, and the statements the store ran to answer it. */
async function logged(handle: ServerHandle, route: string): Promise<{ body: Record<string, unknown>; records: QueryRecord[] }> {
  let body: Record<string, unknown> = {};
  const records = await recordQueries(handle.store, async () => {
    body = await getJson(handle, route);
  });
  // The log is live: the read ran statements on the store's connection.
  expect(records.length).toBeGreaterThan(0);
  return { body, records };
}

function projectOf(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const project = (body.projects as Array<Record<string, unknown>>).find((entry) => entry.key === key);
  expect(project, `the projects list names project ${key}`).toBeDefined();
  return project ?? {};
}

/** A brief of the twelve-file run: its totals' lines percent, and no file key. */
function expectTheBriefOfTheRun(brief: Record<string, unknown>, eventId: string): void {
  expect(brief.id).toBe(eventId);
  expect(brief.hasCoverage).toBe(true);
  expect(brief.coverageLines).toBe(49.1);
  expect(fileReadKeysOf(brief)).toEqual([]);
  expect(JSON.stringify(brief)).not.toContain("/home/dev/app/src/");
}

describe("the statement log these reads are held to", () => {
  test("sees the one statement on the files table that the store's connection runs, with the row it hands back", async () => {
    const { handle, eventId } = await projectWithAFileBearingRun();

    const records = await recordQueries(handle.store, async () => {
      fileRowCount(dbOf(handle.store), eventId);
    });

    const seen = filesTableStatements(records);
    expect(seen.length).toBe(1);
    expect(seen[0]?.handed).toEqual([{ n: 12 }]);
  });
});

describe("the projects list answers a project with a file-bearing coverage run as it answers one without", () => {
  test("GET /api/v2/projects runs no statement on the files table, and its last event carries no file key", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();

    const { body, records } = await logged(handle, "/api/v2/projects");

    expect(filesTableStatements(records).map((record) => record.sql)).toEqual([]);
    expectTheBriefOfTheRun(projectOf(body, key).lastEvent as Record<string, unknown>, eventId);
  });

  test("GET /api/v2/projects answers the project the same with the run's files and without them", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();
    const withFiles = projectOf(await getJson(handle, "/api/v2/projects"), key);

    takeTheFilesOut(handle, eventId);
    const withoutFiles = projectOf(await getJson(handle, "/api/v2/projects"), key);

    expect(withFiles).toEqual(withoutFiles);
    expect((withFiles.lastEvent as { id?: unknown }).id).toBe(eventId);
  });
});

describe("an event brief answers a file-bearing coverage run as it answers one without", () => {
  test("the recent feed runs no statement on the files table, and its brief carries no file key", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();

    const { body, records } = await logged(handle, `/api/v2/events?project=${key}&limit=10`);

    expect(filesTableStatements(records).map((record) => record.sql)).toEqual([]);
    const briefs = (body.events as Array<Record<string, unknown>>).filter((brief) => brief.kind === "test");
    expect(briefs.length).toBe(1);
    expectTheBriefOfTheRun(briefs[0] ?? {}, eventId);
  });

  test("the recent feed answers the same with the run's files and without them", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();
    const withFiles = await getJson(handle, `/api/v2/events?project=${key}&limit=10`);

    takeTheFilesOut(handle, eventId);
    const withoutFiles = await getJson(handle, `/api/v2/events?project=${key}&limit=10`);

    expect(withFiles.events).toEqual(withoutFiles.events);
    expect((withFiles.events as Array<{ id: string }>).map((brief) => brief.id)).toContain(eventId);
  });

  test("GET /api/v2/status runs no statement on the files table, and its last test carries no file key", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();

    const { body, records } = await logged(handle, `/api/v2/status?project=${key}`);

    expect(filesTableStatements(records).map((record) => record.sql)).toEqual([]);
    expectTheBriefOfTheRun((body.status as { lastTest: Record<string, unknown> }).lastTest, eventId);
  });

  test("GET /api/v2/status answers its last test the same with the run's files and without them", async () => {
    const { handle, key, eventId } = await projectWithAFileBearingRun();
    const withFiles = (await getJson(handle, `/api/v2/status?project=${key}`)).status as { lastTest: Record<string, unknown> };

    takeTheFilesOut(handle, eventId);
    const withoutFiles = (await getJson(handle, `/api/v2/status?project=${key}`)).status as { lastTest: Record<string, unknown> };

    expect(withFiles.lastTest).toEqual(withoutFiles.lastTest);
    expect(withFiles.lastTest.id).toBe(eventId);
  });
});
