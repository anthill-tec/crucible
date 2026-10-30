// A run streamed as `crucible-events` is stored as the same record its JUnit
// report is stored as — for every real stack's report in
// `tests/fixtures/reports/<stack>/` (see the README there).
//
// For each fixture, on a real server (`startServer`, port 0, ":memory:"):
//  1. its JUnit reports are posted to `POST /api/v2/runs` as its client sends
//     them (tests/real-stack-reports-decode-on-the-board.test.ts's way:
//     `codec: "junit"`, the stack, the report texts, bun's console as `raw`),
//     and the stored run is read back through `GET /api/v2/events/<id>`;
//  2. that run's tests are re-expressed here as a `crucible-events` stream —
//     a `run-start` with the total, one `test-end` per case with its suite,
//     name, status, duration and failure, and a `run-end` with the counts and
//     the duration — plus one line of a kind no codec knows, carrying
//     multibyte text, which the codec skips;
//  3. the stream is sent to a run opened with `POST /api/v2/runs/start`, in
//     several batches through `POST /api/v2/runs/<runId>/stream`: one cut
//     falls mid-line inside the first test, one directly after a four-byte
//     character, so the next batch's `from` counts it as four UTF-8 bytes;
//  4. the run is closed with `POST /api/v2/runs` `{runId, codec:
//     "crucible-events"}` and no report;
//  5. the stored summary and tree equal the JUnit run's.
//
// A JSON string cannot carry part of a character's UTF-8 bytes — half a
// surrogate pair is a lone surrogate, which the route refuses — so "a batch
// splitting a multibyte character" is held as a cut at the character's own
// boundary inside a line, where a board counting characters or UTF-16 units
// instead of UTF-8 bytes would answer a gap or an overlap.
//
// No fixture file is added: the stream is built from the stored JUnit run.
import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerHandle } from "../src/server.ts";
import {
  batchesOf,
  bootOn,
  closeStream,
  eventLine,
  openRun,
  postJson,
  readyProject,
  sendAll,
  storedEvent,
} from "./helpers/run-stream-harness.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "reports");

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

// ── The fixtures ────────────────────────────────────────────────────────────

interface Expected {
  stack: string;
  reports: string[];
  raw?: string;
}

interface Fixture {
  label: string;
  stack: string;
  reports: string[];
  raw?: string;
}

function loadFixture(dir: string): Fixture {
  const label = dir;
  const root = join(FIXTURES, dir);
  const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf-8")) as Expected;
  const read = (rel: string): string => readFileSync(join(root, rel), "utf-8");
  return {
    label,
    stack: expected.stack,
    reports: expected.reports.map(read),
    ...(expected.raw !== undefined ? { raw: read(expected.raw) } : {}),
  };
}

/**
 * Every fixture directory under `tests/fixtures/reports/`: each one holding
 * an `expected.json`, at any depth (python keeps one per runner), read off
 * the tree rather than kept by hand, so a stack's fixture added later is
 * streamed too. Sorted, so the run order is the same on every machine.
 */
function fixtureDirs(): string[] {
  return readdirSync(FIXTURES, { recursive: true, encoding: "utf-8" })
    .flatMap((entry) =>
      entry.split(/[\\/]/).at(-1) === "expected.json" ? [dirname(entry).split("\\").join("/")] : [],
    )
    .sort((a, b) => a.localeCompare(b));
}

/** The fewest fixture directories the read may find: the six stacks' fixtures committed today. */
const AT_LEAST = 6;

const FIXTURE_SET: Fixture[] = fixtureDirs().map(loadFixture);

// ── The stored run, and the same run as a stream ────────────────────────────

interface Failure {
  message?: string;
  type?: string;
  trace?: string;
}

interface Leaf {
  name: string;
  status: string;
  duration_ms: number;
  failure?: Failure;
}

interface Node {
  name: string;
  status: string;
  children: Leaf[];
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

/** The note line: a kind the codec skips, carrying two- and four-byte characters. */
const NOTE = eventLine({ event: "note", text: "café — 😀 done" });

/**
 * The stored JUnit run as a `crucible-events` stream, and the cuts that split
 * it into batches: mid-line inside the first test, and directly after the
 * note's four-byte character.
 */
function asStream(summary: Summary, tree: Node[]): { text: string; cuts: number[] } {
  const tests: string[] = [];
  let ordinal = 0;
  for (const suite of tree) {
    for (const leaf of suite.children) {
      ordinal += 1;
      tests.push(
        eventLine({
          event: "test-end",
          id: `case-${ordinal}`,
          name: leaf.name,
          suite: suite.name,
          status: leaf.status,
          duration_ms: leaf.duration_ms,
          ...(leaf.failure !== undefined ? { failure: leaf.failure } : {}),
        }),
      );
    }
  }
  const head = eventLine({ event: "run-start", total: summary.total });
  const first = tests[0] ?? "";
  const rest = tests.slice(1).join("");
  const end = eventLine({
    event: "run-end",
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    pending: summary.pending,
    duration_ms: summary.duration_ms,
  });
  const text = head + first + NOTE + rest + end;
  const midFirst = head.length + Math.floor(first.length / 2);
  const afterEmoji = head.length + first.length + NOTE.indexOf("😀") + "😀".length;
  const intoEnd = text.length - end.length + 3;
  return { text, cuts: [noSurrogateSplit(text, midFirst), afterEmoji, intoEnd] };
}

/** A cut never falls between the two halves of a surrogate pair. */
function noSurrogateSplit(text: string, cut: number): number {
  const code = text.charCodeAt(cut - 1);
  return code >= 0xd800 && code <= 0xdbff ? cut + 1 : cut;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the fixtures are read from tests/fixtures/reports/, never kept by hand", () => {
  test("the read finds at least the six stacks' fixture directories, so an empty read cannot pass vacuously", () => {
    const dirs = fixtureDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(AT_LEAST);
    expect(dirs).toEqual(expect.arrayContaining(["arduino", "bun", "mvn", "python/pytest", "python/xmlrunner", "rust"]));
    expect(FIXTURE_SET.map((f) => f.label)).toEqual(dirs);
  });
});

for (const f of FIXTURE_SET) {
  describe(`a real ${f.label} run streamed as crucible-events is stored as its JUnit record`, () => {
    test(`the stream sent in batches and closed with no report stores the summary and tree the JUnit report stores (${f.label})`, async () => {
      const handle = boot();
      const agentId = `stream-${f.stack}`;
      const key = await readyProject(handle, [agentId]);

      // 1. The JUnit record, as the client sends it.
      const junit = await postJson(handle, "/api/v2/runs", {
        projectKey: key,
        agentId,
        codec: "junit",
        stack: f.stack,
        data: f.reports,
        ...(f.raw !== undefined ? { raw: f.raw } : {}),
      });
      expect(junit.status, JSON.stringify(junit.body)).toBe(200);
      const record = await storedEvent(handle, junit.body.event);
      const summary = record.summary as unknown as Summary;
      const tree = record.tree as unknown as Node[];
      expect(tree.length).toBeGreaterThan(0);
      expect(summary.failed).toBeGreaterThan(0);
      // A stream keeps one node per suite name: the fixture names each suite once.
      const names = tree.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);

      // 2.–3. The same run as a stream, sent in batches to an open run.
      const { text, cuts } = asStream(summary, tree);
      const runId = await openRun(handle, key, agentId, { stack: f.stack });
      const batches = batchesOf(text, cuts);
      expect(batches.length).toBe(4);
      // The batch after the four-byte character starts at a UTF-8 offset its UTF-16 index does not equal.
      expect(batches[2]?.from).toBeGreaterThan(cuts[1] ?? 0);
      await sendAll(handle, runId, key, agentId, batches);

      // 4. The close: the stream codec and no report.
      const closed = await closeStream(handle, key, agentId, runId);
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(closed.body.ok).toBe(true);

      // 5. The same record.
      const streamed = await storedEvent(handle, closed.body.event);
      expect(streamed.summary).toEqual(record.summary);
      expect(streamed.tree).toEqual(record.tree);
      expect(handle.store.getRun(runId)?.state).toBe("ended");
    });
  });
}
