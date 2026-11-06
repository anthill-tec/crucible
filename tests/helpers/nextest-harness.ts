// A rust run's nextest stream and test list, driven over real HTTP: the
// captured runs under `tests/fixtures/nextest/runs/` (see the README there),
// the stream sent to `POST /api/v2/runs/<runId>/stream` under the `nextest`
// codec, the test list posted to `POST /api/v2/runs/<runId>/tests` under
// `nextest-list`, and the close through `POST /api/v2/runs` naming `nextest`
// and sending no report.
//
// The line builders write nextest's own `libtest-json-plus` shapes (message
// format version 0.1), field for field as the captured streams hold them, for
// the cases no real run can be steered into (a split at a chosen line, a
// stream cut short). `listOf` writes a test list in the captured lists' shape,
// built on a captured list so every field nextest writes is there.
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerHandle } from "../../src/server.ts";
import {
  batchesOf,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  storedEvent,
  type Answer,
  type StoredRun,
} from "./run-stream-harness.ts";

/** The record stream codec a nextest stream is read under. */
export const NEXTEST_CODEC = "nextest";

/** The codec the test list route takes nextest's own test list under. */
export const LIST_CODEC = "nextest-list";

export const NEXTEST_RUNS = join(import.meta.dir, "..", "fixtures", "nextest", "runs");

/** Every captured run, by its directory name. */
export const CAPTURED_RUNS = [
  "all-pass",
  "a-failure",
  "distinct-targets",
  "same-name",
  "spawned-thread-panic",
  "should-panic-without-a-panic",
  "err-return",
  "flaky-retries",
  "timeout",
] as const;

export type CapturedRunName = (typeof CAPTURED_RUNS)[number];

export interface CapturedRun {
  name: CapturedRunName;
  stream: string;
  list: string;
  junit: string;
}

/** One captured run's three files, as nextest wrote them. */
export function capturedRun(name: CapturedRunName): CapturedRun {
  const read = (file: string): string => readFileSync(join(NEXTEST_RUNS, name, file), "utf-8");
  return { name, stream: read("stream.jsonl"), list: read("list.json"), junit: read("junit.xml") };
}

export function testsRoute(runId: string): string {
  return `/api/v2/runs/${runId}/tests`;
}

/** The test list posted to the open run, `data` as given (nextest's own text unless a test sends otherwise). */
export function postList(
  handle: ServerHandle,
  runId: string,
  projectKey: string,
  agentId: string,
  data: unknown,
  codec: unknown = LIST_CODEC,
): Promise<Answer> {
  return postJson(handle, testsRoute(runId), { projectKey, agentId, codec, data });
}

/** `text` sent to the open run under the `nextest` codec, cut at `cuts` (character indices); each batch answered 200. */
export async function streamNextest(
  handle: ServerHandle,
  runId: string,
  projectKey: string,
  agentId: string,
  text: string,
  cuts: readonly number[] = [],
): Promise<void> {
  for (const [index, batch] of batchesOf(text, cuts).entries()) {
    const res = await sendBatch(handle, runId, {
      projectKey,
      agentId,
      codec: NEXTEST_CODEC,
      from: batch.from,
      data: batch.data,
    });
    expect(res.status, `nextest batch ${index} (from ${batch.from}): ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.held).toBe(batch.heldAfter);
  }
}

/** The close of a nextest run: `POST /api/v2/runs` with the runId, the `nextest` codec, and no report. */
export function closeNextest(handle: ServerHandle, projectKey: string, agentId: string, runId: string): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", { projectKey, agentId, runId, codec: NEXTEST_CODEC });
}

export interface NextestRunPlan {
  /** The stream, sent in one batch unless `cuts` splits it. */
  stream: string;
  cuts?: readonly number[];
  /** The test list posted before the first batch; none when absent. */
  list?: string;
  /** The run start's own `total`; none when absent. */
  startTotal?: number;
}

export interface ClosedNextestRun {
  key: string;
  runId: string;
  answer: Answer;
  event: StoredRun;
}

/** A run opened (rust), given its list and its stream, and closed under `nextest`; answers the stored event. */
export async function closedNextestRun(
  handle: ServerHandle,
  agentId: string,
  plan: NextestRunPlan,
): Promise<ClosedNextestRun> {
  const key = await readyProject(handle, [agentId], "nextest-run");
  const runId = await openRun(handle, key, agentId, {
    stack: "rust",
    tier: "unit",
    ...(plan.startTotal !== undefined ? { total: plan.startTotal } : {}),
  });
  if (plan.list !== undefined) {
    const listed = await postList(handle, runId, key, agentId, plan.list);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  }
  await streamNextest(handle, runId, key, agentId, plan.stream, plan.cuts ?? []);
  const answer = await closeNextest(handle, key, agentId, runId);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const event = await storedEvent(handle, answer.body.event);
  return { key, runId, answer, event };
}

// ── nextest's lines ─────────────────────────────────────────────────────────

export type BinaryKind = "lib" | "bin" | "test";

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/** A test binary starting: `{"type":"suite","event":"started",...}`. */
export function suiteStarted(crate: string, binary: string, kind: BinaryKind, testCount: number): string {
  return line({ type: "suite", event: "started", test_count: testCount, nextest: { crate, test_binary: binary, kind } });
}

/** A test binary's result line, with whatever figures it states. */
export function suiteResult(
  crate: string,
  binary: string,
  kind: BinaryKind,
  event: "ok" | "failed",
  figures: { passed: number; failed: number; ignored: number },
): string {
  return line({
    type: "suite",
    event,
    ...figures,
    measured: 0,
    filtered_out: 0,
    exec_time: 0.004,
    nextest: { crate, test_binary: binary, kind },
  });
}

/** The full name a test line carries: `<crate>::<binary>$<path>`. */
export function testName(crate: string, binary: string, path: string): string {
  return `${crate}::${binary}$${path}`;
}

export function testStarted(name: string): string {
  return line({ type: "test", event: "started", name });
}

export function testOk(name: string, execTime: number): string {
  return line({ type: "test", event: "ok", name, exec_time: execTime });
}

/** A failed test: its captured `stdout`, or (for a timeout) its `reason`. */
export function testFailed(name: string, execTime: number, out: { stdout: string } | { reason: string }): string {
  return line({ type: "test", event: "failed", name, exec_time: execTime, ...out });
}

export function testIgnored(name: string): string {
  return line({ type: "test", event: "ignored", name });
}

/** A panic's captured output, as a test's own thread writes it. */
export function panicStdout(threadPath: string, tid: number, location: string, message: string): string {
  return (
    `\nthread '${threadPath}' (${tid}) panicked at ${location}:\n${message}\n` +
    "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n"
  );
}

// ── nextest's test list ─────────────────────────────────────────────────────

export interface ListedBinary {
  crate: string;
  binaryName: string;
  kind: BinaryKind;
  /** Each test path, and whether the run's filter matches it (false: an ignored test, which a default run does not match). */
  tests: Array<{ path: string; matches: boolean }>;
}

/** The binary id nextest gives a binary: `<crate>` for a lib, `<crate>::bin/<name>` for a bin, `<crate>::<name>` for a test. */
export function binaryId(b: Pick<ListedBinary, "crate" | "binaryName" | "kind">): string {
  if (b.kind === "lib") return b.crate;
  if (b.kind === "bin") return `${b.crate}::bin/${b.binaryName}`;
  return `${b.crate}::${b.binaryName}`;
}

/**
 * A test list in the shape `cargo nextest list --message-format json` writes,
 * built on the captured `all-pass` list: its build metadata kept, its suites
 * replaced by `binaries`, and its `test-count` theirs.
 */
export function listOf(binaries: readonly ListedBinary[]): string {
  const template = JSON.parse(capturedRun("all-pass").list) as Record<string, unknown>;
  const suites: Record<string, unknown> = {};
  let count = 0;
  for (const b of binaries) {
    const id = binaryId(b);
    const testcases: Record<string, unknown> = {};
    for (const t of b.tests) {
      count += 1;
      testcases[t.path] = {
        kind: "test",
        ignored: !t.matches,
        "filter-match": t.matches ? { status: "matches" } : { status: "mismatch", reason: "ignored" },
      };
    }
    suites[id] = {
      "package-name": b.crate,
      "binary-id": id,
      "binary-name": b.binaryName,
      "package-id": `path+file:///tmp/nextest-fixture-scratch/crates/${b.crate}#0.1.0`,
      kind: b.kind,
      "binary-path": `/tmp/nextest-fixture-scratch/target/debug/deps/${b.binaryName}-0000000000000000`,
      "build-platform": "target",
      cwd: `/tmp/nextest-fixture-scratch/crates/${b.crate}`,
      status: "listed",
      testcases,
    };
  }
  return `${JSON.stringify({ ...template, "test-count": count, "rust-suites": suites })}\n`;
}
