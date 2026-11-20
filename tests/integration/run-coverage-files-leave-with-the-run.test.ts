// A run's coverage files leave the store with the run. After each path that
// removes a run, no `run_coverage_files` row of that run remains and every
// other run's rows are as they were:
//
//  - one event deleted (`Store#deleteEvent`);
//  - a project's events cleared (`Store#clearEvents`);
//  - a project deleted (`Store#deleteProjectCascade`);
//  - a retention sweep that evicts the run (`enforceRetention`, run by the
//    ingest that takes the project over its cap).
//
// Each run is ingested over the real production router (`bootInProcess`,
// in-memory store) with a coverage block, so its rows are the ones an ingest writes; the removals are
// the store's own. A kept run's rows are compared whole, before and after.
//
// The rows held before a removal are read by a reading that does not fail by
// itself, so the removal is exercised first and each test then states, in
// order: the run is gone, it had rows, none remains, the others are untouched.
import { afterEach, describe, expect, test } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, readyProject, register } from "../helpers/run-stream-harness.ts";
import {
  dbOf,
  eventIdOf,
  fileRowCount,
  fileRowFingerprint,
  fileRowTotal,
  heldCounts,
  heldFileRows,
  ingestRun,
  lcovText,
} from "../helpers/coverage-files-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

const AGENT = "coverage-runner";

/** A green run whose coverage names `files` files under `prefix`; answers the event it stored. */
async function runWithFiles(handle: BoardHandle, key: string, prefix: string, files: number): Promise<string> {
  const records = Array.from({ length: files }, (_, index) => ({
    path: `${prefix}/file-${index}.ts`,
    lf: 10 + index,
    lh: index,
    fnf: 2,
    fnh: 1,
  }));
  return eventIdOf(await ingestRun(handle, key, AGENT, { codec: "lcov", data: lcovText(records) }));
}

describe("every path that removes a run removes its coverage files", () => {
  test("deleting one event removes that run's file rows and leaves another run's as they were", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const doomed = await runWithFiles(handle, key, "doomed", 3);
    const kept = await runWithFiles(handle, key, "kept", 2);
    const db = dbOf(handle.store);
    const doomedBefore = heldFileRows(db, doomed);
    const keptBefore = heldFileRows(db, kept);

    expect(handle.store.deleteEvent(doomed, key)).toBe(true);

    expect(handle.store.getEvent(doomed)).toBeNull();
    expect(handle.store.getEvent(kept)).not.toBeNull();
    expect(heldCounts(doomedBefore, keptBefore)).toEqual([3, 2]);
    expect(fileRowCount(db, doomed)).toBe(0);
    expect(fileRowFingerprint(db, kept)).toEqual(keptBefore as string[]);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("clearing a project's events removes the file rows of every run of the project and leaves another project's", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "cleared");
    const other = await readyProject(handle, [AGENT], "kept-project");
    const first = await runWithFiles(handle, key, "first", 3);
    const second = await runWithFiles(handle, key, "second", 4);
    const kept = await runWithFiles(handle, other, "kept", 2);
    const db = dbOf(handle.store);
    const firstBefore = heldFileRows(db, first);
    const secondBefore = heldFileRows(db, second);
    const keptBefore = heldFileRows(db, kept);

    handle.store.clearEvents(key);

    expect([handle.store.getEvent(first), handle.store.getEvent(second)]).toEqual([null, null]);
    expect(handle.store.getEvent(kept)).not.toBeNull();
    expect(heldCounts(firstBefore, secondBefore, keptBefore)).toEqual([3, 4, 2]);
    expect([fileRowCount(db, first), fileRowCount(db, second)]).toEqual([0, 0]);
    expect(fileRowFingerprint(db, kept)).toEqual(keptBefore as string[]);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("deleting a project removes the file rows of every run of the project and leaves another project's", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "deleted");
    const other = await readyProject(handle, [AGENT], "kept-project");
    const first = await runWithFiles(handle, key, "first", 3);
    const second = await runWithFiles(handle, key, "second", 1);
    const kept = await runWithFiles(handle, other, "kept", 2);
    const db = dbOf(handle.store);
    const firstBefore = heldFileRows(db, first);
    const secondBefore = heldFileRows(db, second);
    const keptBefore = heldFileRows(db, kept);

    handle.store.deleteProjectCascade(key);

    expect(handle.store.getProject(key)).toBeNull();
    expect([handle.store.getEvent(first), handle.store.getEvent(second)]).toEqual([null, null]);
    expect(handle.store.getEvent(kept)).not.toBeNull();
    expect(heldCounts(firstBefore, secondBefore, keptBefore)).toEqual([3, 1, 2]);
    expect([fileRowCount(db, first), fileRowCount(db, second)]).toEqual([0, 0]);
    expect(fileRowFingerprint(db, kept)).toEqual(keptBefore as string[]);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("a retention sweep that evicts a run removes its file rows and leaves the newer run's and another project's", async () => {
    const handle = boot();
    // A cap of one run: the ingest of a second run evicts the first.
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "capped", type: "backend", sutRoot: "/tmp/capped", retention: 1 });
    await register(handle, key, AGENT);
    const other = await readyProject(handle, [AGENT], "uncapped");
    const elsewhere = await runWithFiles(handle, other, "elsewhere", 2);
    const evicted = await runWithFiles(handle, key, "evicted", 3);
    const db = dbOf(handle.store);
    // The run is held until a newer one takes the project over its cap.
    expect(handle.store.getEvent(evicted)).not.toBeNull();
    const evictedBefore = heldFileRows(db, evicted);
    const elsewhereBefore = heldFileRows(db, elsewhere);

    const newer = await runWithFiles(handle, key, "newer", 4);

    // The sweep removed the older run itself, and its files with it.
    expect(handle.store.getEvent(evicted)).toBeNull();
    expect(handle.store.getEvent(newer)).not.toBeNull();
    expect(handle.store.getEvent(elsewhere)).not.toBeNull();
    expect(heldCounts(evictedBefore, elsewhereBefore)).toEqual([3, 2]);
    expect(fileRowCount(db, evicted)).toBe(0);
    expect(fileRowCount(db, newer)).toBe(4);
    expect(fileRowFingerprint(db, elsewhere)).toEqual(elsewhereBefore as string[]);
    expect(fileRowTotal(db)).toBe(6);
  });
});
