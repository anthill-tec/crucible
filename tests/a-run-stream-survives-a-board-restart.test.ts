// A run's stream survives a board restart: the batches the board acknowledged
// are persisted (§S2), so a board opened again on the same database file
// holds them, serves the same live state, and closes the run to the same
// record a single board would have stored.
//
// `Store` has no close verb, so the restart is a SECOND server — a second
// `Store.open` through `startServer` — opened on the same database file after
// the first server stopped listening. Every batch, read and close goes
// through the real HTTP routes; the live state is read through each server's
// own `Store#runLive`.
//
// Safety: the database file sits in a fresh OS tmpdir, removed after each
// test; every server binds port 0.
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerHandle } from "../src/server.ts";
import type { RunLive } from "../src/types.ts";
import {
  batchesOf,
  bootOn,
  closeStream,
  eventLine,
  openRun,
  readyProject,
  sendAll,
  sendBatch,
  storedEvent,
  utf8,
  type StoredRun,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];
const scratchDirs: string[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() ?? "", { recursive: true, force: true });
});

function boot(dbPath = ":memory:"): ServerHandle {
  const handle = bootOn(dbPath);
  handles.push(handle);
  return handle;
}

function scratchDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-stream-restart-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

// ── The stream ──────────────────────────────────────────────────────────────

const AGENT = "restart-streamer";

const L_START = eventLine({ event: "run-start", total: 3 });
const L_PASS = eventLine({
  event: "test-end",
  id: "s-1",
  name: "parses — café",
  suite: "Parser",
  file: "src/a.test.ts",
  status: "pass",
  duration_ms: 10,
});
const L_FAIL = eventLine({
  event: "test-end",
  id: "s-2",
  name: "rejects 😀",
  suite: "Parser",
  file: "src/b.test.ts",
  status: "fail",
  duration_ms: 12,
  failure: { message: "expected 1\nreceived 2", type: "AssertionError", trace: "expected 1\nreceived 2\n  at Parser.rejects" },
});
const L_PENDING = eventLine({
  event: "test-end",
  id: "s-3",
  name: "later",
  suite: "Lexer",
  file: "src/c.test.ts",
  status: "pending",
  duration_ms: 0,
});
const L_END = eventLine({ event: "run-end", total: 3, passed: 1, failed: 1, pending: 1, duration_ms: 30 });

const TEXT = L_START + L_PASS + L_FAIL + L_PENDING + L_END;

/** What the first board acknowledges: through the failing test, and half the pending one. */
const ACKED_END = L_START.length + L_PASS.length + L_FAIL.length + Math.floor(L_PENDING.length / 2);

/** The batches before the restart (cut mid-line in the failing test, after its "😀"), and the rest after it. */
const CUTS = [L_START.length + L_PASS.length + L_FAIL.indexOf("😀") + "😀".length, ACKED_END];

/** §S4's live state after the acknowledged batches: two tests complete, the partial line not yet counted. */
const LIVE_AT_RESTART: RunLive = {
  completed: 2,
  total: 3,
  passed: 1,
  failed: 1,
  pending: 0,
  currentFile: "src/b.test.ts",
  failures: [
    { id: "s-2", name: "rejects 😀", suite: "Parser", file: "src/b.test.ts", message: "expected 1", type: "AssertionError" },
  ],
};

const EXPECTED_SUMMARY = { total: 3, passed: 1, failed: 1, pending: 1, duration_ms: 30 };

const EXPECTED_TREE = [
  {
    name: "Parser",
    status: "fail",
    children: [
      { name: "parses — café", status: "pass", duration_ms: 10 },
      {
        name: "rejects 😀",
        status: "fail",
        duration_ms: 12,
        failure: { message: "expected 1\nreceived 2", type: "AssertionError", trace: "expected 1\nreceived 2\n  at Parser.rejects" },
      },
    ],
  },
  { name: "Lexer", status: "pass", children: [{ name: "later", status: "pending", duration_ms: 0 }] },
];

/** The run as ONE board stores it: the same batches, never restarted. */
async function singleBoardRecord(): Promise<Pick<StoredRun, "summary" | "tree">> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const runId = await openRun(handle, key, AGENT, { stack: "bun" });
  await sendAll(handle, runId, key, AGENT, batchesOf(TEXT, CUTS));
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  const event = await storedEvent(handle, closed.body.event);
  return { summary: event.summary, tree: event.tree };
}

interface Restarted {
  first: ServerHandle;
  second: ServerHandle;
  key: string;
  runId: string;
}

/** Batches acknowledged through a first board, then a second board opened on the same file. */
async function restartMidStream(): Promise<Restarted> {
  const dbPath = scratchDb();
  const first = boot(dbPath);
  const key = await readyProject(first, [AGENT]);
  const runId = await openRun(first, key, AGENT, { stack: "bun" });
  const before = batchesOf(TEXT.slice(0, ACKED_END), CUTS.slice(0, 1));
  await sendAll(first, runId, key, AGENT, before);
  // The first board stops listening; its Store stays readable for the comparison.
  handles.splice(handles.indexOf(first), 1);
  first.stop();
  const second = boot(dbPath);
  return { first, second, key, runId };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a run's stream survives a board restart", () => {
  test("the second board holds exactly the bytes the first acknowledged — a matching resend appends nothing, a differing one is a 409 carrying held", async () => {
    const { second, key, runId } = await restartMidStream();
    const acked = TEXT.slice(0, ACKED_END);
    const resend = await sendBatch(second, runId, { projectKey: key, agentId: AGENT, from: 0, data: acked });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body.held).toBe(utf8(acked));

    const differing = await sendBatch(second, runId, {
      projectKey: key,
      agentId: AGENT,
      from: 0,
      data: acked.replace("café", "cafe"),
    });
    expect(differing.status).toBe(409);
    expect(differing.body.held).toBe(utf8(acked));
  });

  test("the live state read through the second board's Store equals the first's", async () => {
    const { first, second, runId } = await restartMidStream();
    const before = first.store.runLive(runId);
    expect(before).toEqual(LIVE_AT_RESTART);
    expect(second.store.runLive(runId)).toEqual(before);
  });

  test("the stream finished and closed through the second board decodes to the same run one board stores", async () => {
    const { second, key, runId } = await restartMidStream();
    const rest = TEXT.slice(ACKED_END);
    const tail = await sendBatch(second, runId, { projectKey: key, agentId: AGENT, from: utf8(TEXT.slice(0, ACKED_END)), data: rest });
    expect(tail.status, JSON.stringify(tail.body)).toBe(200);
    expect(tail.body.held).toBe(utf8(TEXT));

    const closed = await closeStream(second, key, AGENT, runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const restarted = await storedEvent(second, closed.body.event);
    expect(restarted.summary).toEqual(EXPECTED_SUMMARY);
    expect(restarted.tree).toEqual(EXPECTED_TREE);

    const single = await singleBoardRecord();
    expect(restarted.summary).toEqual(single.summary);
    expect(restarted.tree).toEqual(single.tree);
    expect(second.store.getRun(runId)?.state).toBe("ended");
  });
});
