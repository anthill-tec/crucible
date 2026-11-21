// The Crucible reporter for Vitest: streams a run as `crucible-events` NDJSON.
//
// The bun client hands this file to a runner through `CRUCIBLE_REPORTERS` (the
// directory holding it), and names the stream file in `CRUCIBLE_STREAM`, which
// this reporter reads itself. With `CRUCIBLE_STREAM` unset it writes nothing.
//
// Every line is written whole with a synchronous write as its event happens, so
// a reader following the file sees each test as it finishes:
//   - `run-start`, with no `total`: Vitest's `onTestRunStart` receives only the
//     files, before anything is collected;
//   - one `test-end` per test case, as it finishes (`onTestCaseResult`). Tests
//     that never report a result of their own (skipped statically, todo) are
//     swept from their module when it ends;
//   - one failing `test-end` named `?` for a module that fails to load;
//   - `run-end`, with the totals of the `test-end`s it follows.
//
// It imports only `vitest` types (erased at load) and `node:` built-ins, so it
// loads from an install with no `node_modules` above it.
import { closeSync, openSync, writeSync } from "node:fs";
import type {
  Reporter,
  SerializedError,
  TestCase,
  TestModule,
  TestSpecification,
} from "vitest/node";

type StreamStatus = "pass" | "fail" | "pending";

interface StreamFailure {
  message: string;
  type?: string;
  trace?: string;
}

const STREAM_VAR = "CRUCIBLE_STREAM";
const LOAD_FAILURE_NAME = "?";
const SUITE_SEPARATOR = " > ";

function streamStatus(state: string): StreamStatus {
  if (state === "passed") return "pass";
  if (state === "failed") return "fail";
  return "pending";
}

function failureOf(error: SerializedError | undefined): StreamFailure {
  const failure: StreamFailure = { message: error?.message ?? "" };
  if (typeof error?.name === "string" && error.name !== "") failure.type = error.name;
  const trace = traceOf(error);
  if (trace !== undefined) failure.trace = trace;
  return failure;
}

function traceOf(error: SerializedError | undefined): string | undefined {
  if (typeof error?.stack === "string" && error.stack !== "") return error.stack;
  const frames = error?.stacks ?? [];
  if (frames.length === 0) return undefined;
  return frames
    .map((frame) => `    at ${frame.method || "<anonymous>"} (${frame.file}:${frame.line}:${frame.column})`)
    .join("\n");
}

function describeChain(testCase: TestCase): string[] {
  const chain: string[] = [];
  let parent = testCase.parent;
  while (parent.type === "suite") {
    chain.unshift(parent.name);
    parent = parent.parent;
  }
  return chain;
}

export default class CrucibleReporter implements Reporter {
  private fd: number | undefined;
  private startedAt = 0;
  private readonly reported = new Set<string>();
  private counts = { total: 0, passed: 0, failed: 0, pending: 0 };

  onTestRunStart(_specifications: ReadonlyArray<TestSpecification>): void {
    this.close();
    this.reported.clear();
    this.counts = { total: 0, passed: 0, failed: 0, pending: 0 };
    this.startedAt = Date.now();
    const path = process.env[STREAM_VAR];
    if (path === undefined || path === "") return;
    this.fd = openSync(path, "w");
    this.write({ event: "run-start" });
  }

  onTestCaseResult(testCase: TestCase): void {
    this.testEnd(testCase);
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.sweep(testModule);
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    for (const testModule of testModules) this.sweep(testModule);
    this.write({ event: "run-end", ...this.counts, duration_ms: Date.now() - this.startedAt });
    this.close();
  }

  // The module's tests that reported no result of their own, and a module
  // that failed to load as its one `?` test.
  private sweep(testModule: TestModule): void {
    for (const testCase of testModule.children.allTests()) this.testEnd(testCase);
    const errors = testModule.errors();
    if (errors.length === 0 || testModule.children.size > 0) return;
    const key = `${testModule.id}${LOAD_FAILURE_NAME}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.record("fail");
    this.write({
      event: "test-end",
      id: key,
      name: LOAD_FAILURE_NAME,
      suite: testModule.relativeModuleId,
      file: testModule.relativeModuleId,
      status: "fail",
      failure: failureOf(errors[0]),
    });
  }

  private testEnd(testCase: TestCase): void {
    if (this.reported.has(testCase.id)) return;
    this.reported.add(testCase.id);
    const result = testCase.result();
    const status = streamStatus(result.state);
    this.record(status);
    const file = testCase.module.relativeModuleId;
    const chain = describeChain(testCase);
    const duration = testCase.diagnostic()?.duration;
    this.write({
      event: "test-end",
      id: testCase.id,
      name: testCase.name,
      suite: chain.length > 0 ? chain.join(SUITE_SEPARATOR) : file,
      file,
      status,
      ...(duration !== undefined && Number.isFinite(duration) && duration >= 0
        ? { duration_ms: duration }
        : {}),
      ...(result.state === "failed" ? { failure: failureOf(result.errors[0]) } : {}),
    });
  }

  private record(status: StreamStatus): void {
    this.counts.total += 1;
    if (status === "pass") this.counts.passed += 1;
    else if (status === "fail") this.counts.failed += 1;
    else this.counts.pending += 1;
  }

  private write(event: Record<string, unknown>): void {
    if (this.fd === undefined) return;
    writeSync(this.fd, `${JSON.stringify(event)}\n`);
  }

  private close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }
}
