// The Crucible reporter for Playwright: streams a run as `crucible-events` NDJSON.
//
// The bun client hands this file to a runner through `CRUCIBLE_REPORTERS` (the
// directory holding it), and names the stream file in `CRUCIBLE_STREAM`, which
// this reporter reads itself. With `CRUCIBLE_STREAM` unset it writes nothing.
//
// Every line is written whole with a synchronous write as its event happens, so
// a reader following the file sees each test as it finishes:
//   - `run-start`, with the total `onBegin` sees: every test in every project;
//   - one `test-end` per test per project, from its last attempt: an attempt is
//     the last when it is skipped, ends as the test expects, or uses the last
//     retry. Its `status` follows `test.outcome()`, its `suite` is the describe
//     titles after the file, and its `browser` is the project;
//   - at `onEnd`, a `pending` `test-end` for every test that never ran (a failed
//     dependency project, `--max-failures`, an interrupt), and the last result
//     of any test not yet streamed;
//   - `run-end`, with the totals of the `test-end`s it follows.
//
// A test's `steps` are its attempt's `test.step` steps: the `test.step`
// children of the `Background` hook first, then the top-level ones. A hook's
// own step and a fixture are not steps.
//
// It imports only Playwright types (erased at load) and `node:` built-ins, so it
// loads from an install with no `node_modules` above it.
import { closeSync, openSync, writeSync } from "node:fs";
import { relative } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

type StreamStatus = "pass" | "fail" | "pending";

interface StreamFailure {
  message: string;
  trace?: string;
}

interface StreamStep {
  name: string;
  status: StreamStatus;
  duration_ms: number;
  failure?: StreamFailure;
}

const STREAM_VAR = "CRUCIBLE_STREAM";
const SUITE_SEPARATOR = " › ";
const BACKGROUND_HOOK = "Background";
const HOOK_CATEGORY = "hook";
const STEP_CATEGORY = "test.step";

function streamStatus(test: TestCase): StreamStatus {
  const outcome = test.outcome();
  if (outcome === "expected" || outcome === "flaky") return "pass";
  if (outcome === "unexpected") return "fail";
  return "pending";
}

function isLastAttempt(test: TestCase, result: TestResult): boolean {
  return result.status === "skipped"
    || result.status === test.expectedStatus
    || result.retry >= test.retries;
}

function failureOf(error: TestError): StreamFailure {
  const failure: StreamFailure = { message: error.message ?? error.value ?? "" };
  if (typeof error.stack === "string" && error.stack !== "") failure.trace = error.stack;
  return failure;
}

function describeChain(test: TestCase): string[] {
  const chain: string[] = [];
  let parent: Suite | undefined = test.parent;
  while (parent !== undefined && parent.type === "describe") {
    chain.unshift(parent.title);
    parent = parent.parent;
  }
  return chain;
}

// The `test.step` children of every `Background` hook step, found through the
// hook steps that hold it.
function backgroundSteps(steps: ReadonlyArray<TestStep>): TestStep[] {
  const found: TestStep[] = [];
  for (const step of steps) {
    if (step.category !== HOOK_CATEGORY) continue;
    if (step.title === BACKGROUND_HOOK) {
      found.push(...step.steps.filter((child) => child.category === STEP_CATEGORY));
    } else {
      found.push(...backgroundSteps(step.steps));
    }
  }
  return found;
}

function streamStep(step: TestStep): StreamStep {
  const duration = Number.isFinite(step.duration) ? Math.max(0, step.duration) : 0;
  if (step.error === undefined) return { name: step.title, status: "pass", duration_ms: duration };
  return { name: step.title, status: "fail", duration_ms: duration, failure: failureOf(step.error) };
}

function stepsOf(result: TestResult): StreamStep[] {
  const topLevel = result.steps.filter((step) => step.category === STEP_CATEGORY);
  return [...backgroundSteps(result.steps), ...topLevel].map(streamStep);
}

export default class CrucibleReporter implements Reporter {
  private fd: number | undefined;
  private rootDir = "";
  private root: Suite | undefined;
  private readonly reported = new Set<string>();
  private counts = { total: 0, passed: 0, failed: 0, pending: 0 };

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.close();
    this.reported.clear();
    this.counts = { total: 0, passed: 0, failed: 0, pending: 0 };
    this.rootDir = config.rootDir;
    this.root = suite;
    const path = process.env[STREAM_VAR];
    if (path === undefined || path === "") return;
    this.fd = openSync(path, "w");
    this.write({ event: "run-start", total: suite.allTests().length });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (isLastAttempt(test, result)) this.testEnd(test, result);
  }

  onEnd(result: FullResult): void {
    for (const test of this.root?.allTests() ?? []) this.testEnd(test, test.results.at(-1));
    this.write({ event: "run-end", ...this.counts, duration_ms: Math.max(0, result.duration) });
    this.close();
  }

  private testEnd(test: TestCase, result: TestResult | undefined): void {
    if (this.reported.has(test.id)) return;
    this.reported.add(test.id);
    const status = result === undefined ? "pending" : streamStatus(test);
    this.record(status);
    const file = relative(this.rootDir, test.location.file);
    const chain = describeChain(test);
    const error = result?.error ?? result?.errors[0];
    this.write({
      event: "test-end",
      id: test.id,
      name: test.title,
      suite: chain.length > 0 ? chain.join(SUITE_SEPARATOR) : file,
      browser: test.parent.project()?.name || undefined,
      file,
      status,
      ...(result !== undefined && Number.isFinite(result.duration) && result.duration >= 0
        ? { duration_ms: result.duration }
        : {}),
      steps: result === undefined ? [] : stepsOf(result),
      ...(status === "fail" && error !== undefined ? { failure: failureOf(error) } : {}),
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
