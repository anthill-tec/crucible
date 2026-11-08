// The `go-test` codec: `go test -json`'s stream (test2json), one JSON event
// per line, read as a go run's RECORD stream. Each terminal event — a
// `pass`, `fail` or `skip` naming a test — is one case in the board's one
// test-end shape; a parent whose subtests reported is not a case of its own
// unless it failed in its own right. A package's `fail` with no failing test
// (a build failure, a panic before any test, a failed TestMain) is one case
// named for the package, carrying the package's output — or, when the event
// names its `FailedBuild`, that build's output. Since go 1.24 an output event
// may carry `OutputType` (`frame`, `error`, `error-continue`); a stream that
// carries it is read by it, else each output line is classed by its text.
import type { DecodedRun } from "./index.ts";
import type { SuiteNode, TestLeaf } from "../types.ts";
import { CUT_REASON, summaryOf, undecodableReason, type StreamLine, type TestEndEvent } from "./crucible-events.ts";
import { failureOf, suiteStatus } from "./junit.ts";

/** The actions test2json documents; any other is a kind no codec knows. */
const ACTIONS: ReadonlySet<string> = new Set([
  "start",
  "run",
  "pause",
  "cont",
  "output",
  "pass",
  "fail",
  "skip",
  "bench",
  "build-output",
  "build-fail",
]);

/** A line the testing package frames a test's output with: `=== RUN` and its kin, `--- PASS:` and its kin. */
const FRAME = /^\s*(=== (RUN|PAUSE|CONT|NAME)\s|--- (PASS|FAIL|SKIP|BENCH):)/;

/** A located message, as `t.Error`/`t.Log`/`t.Skip` write it: indent, `<file>.go:<line>: `, text. */
const HEADER = /^(\s+)(\S+\.go):(\d+): ?(.*)$/;

/** A goroutine trace's frame in a test file: tab, path, `<name>_test.go:<line>`. */
const TEST_FRAME = /^\t(?:\S*\/)?([^/\s]+_test\.go):(\d+)\b/;

/** What the reader holds of one test that has not yet ended. */
interface TestRecord {
  /** The first located error's message, its continuation lines appended. */
  message: string[];
  /** The first located error's indent; its continuation lines are indented four more. */
  indent?: string;
  /** Whether the line read last belongs to the first located error's message. */
  inMessage: boolean;
  /** The first located error's `<file>:<line>`. */
  fileLine?: string;
  /** The first test-file frame of an untyped line (a panic's trace) as `<file>:<line>`. */
  frameLine?: string;
  /** The test's output lines that are neither frame nor located error. */
  untyped: string[];
  /** The test's output lines, frames aside. */
  trace: string[];
  /** The text of the last located line (a skip's reason). */
  lastLocated?: string;
  /** Whether the test reported a located error of its own. */
  ownError: boolean;
  /** Whether the test panicked in its own output. */
  ownPanic: boolean;
  /** Whether a subtest of this test reached its end. */
  subtestEnded: boolean;
  /** Whether a subtest of this test failed. */
  subtestFailed: boolean;
}

/** The state the reader carries between batches. */
interface ReaderState {
  /** Whether the stream carries `OutputType`. */
  typed: boolean;
  /** The tests not yet ended, keyed `<package> <test>`. */
  tests: Record<string, TestRecord>;
  /** The packages a test of which failed. */
  failingPackages: Record<string, boolean>;
  /** Each package's own output lines (those naming no test). */
  packageOutput: Record<string, string[]>;
  /** Each build's output, keyed by its import path. */
  builds: Record<string, string>;
  /** The top-level tests started, keyed `<package> <test>`, in start order. */
  started: string[];
  /** The top-level tests that reached their end, keyed `<package> <test>`, in end order. */
  reached: string[];
  /** The lines that could not be read. */
  undecodable: number;
}

/** One case read from a terminal event. */
export interface GoCase {
  suite: string;
  name: string;
  status: TestLeaf["status"];
  duration_ms: number;
  failure?: NonNullable<TestLeaf["failure"]>;
  file: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): ReaderState {
  return {
    typed: false,
    tests: {},
    failingPackages: {},
    packageOutput: {},
    builds: {},
    started: [],
    reached: [],
    undecodable: 0,
  };
}

function recordOf(state: ReaderState, key: string): TestRecord {
  return (state.tests[key] ??= {
    message: [],
    inMessage: false,
    untyped: [],
    trace: [],
    ownError: false,
    ownPanic: false,
    subtestEnded: false,
    subtestFailed: false,
  });
}

/** An event's `Output`, its trailing newline removed. */
function outputOf(event: Record<string, unknown>): string {
  return String(event["Output"] ?? "").replace(/\n$/, "");
}

/**
 * A go-test line reader: reads one line into a case, resuming from the state
 * (`state()`) the last batch's reader carried.
 */
export class GoTestReader {
  readonly held: ReaderState;

  constructor(state: string | null = null) {
    this.held = state !== null ? (JSON.parse(state) as ReaderState) : emptyState();
  }

  /** The reader's state, carried to the next batch. */
  state(): string {
    return JSON.stringify(this.held);
  }

  /** One line read: a case, nothing (`null`), a blank line, or an undecodable one. */
  readCase(line: string): GoCase | null | "undecodable" | "blank" {
    if (line.trim().length === 0) return "blank";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed) || typeof parsed["Action"] !== "string") {
      this.held.undecodable += 1;
      return "undecodable";
    }
    const event = parsed;
    const action = parsed["Action"];
    if (!ACTIONS.has(action)) return null;
    if ("OutputType" in event) this.held.typed = true;
    if (action === "build-output") {
      const importPath = String(event["ImportPath"] ?? "");
      this.held.builds[importPath] = (this.held.builds[importPath] ?? "") + String(event["Output"] ?? "");
      return null;
    }
    const pkg = typeof event["Package"] === "string" ? event["Package"] : "";
    const test = typeof event["Test"] === "string" ? event["Test"] : undefined;
    const elapsed = typeof event["Elapsed"] === "number" ? event["Elapsed"] * 1000 : 0;
    if (test === undefined) return this.packageEvent(action, pkg, event, elapsed);
    return this.testEvent(action, pkg, test, event, elapsed);
  }

  /** A package's own event: its output held; its `fail`, when no test of it failed, one case. */
  private packageEvent(action: string, pkg: string, event: Record<string, unknown>, elapsed: number): GoCase | null {
    if (action === "output") (this.held.packageOutput[pkg] ??= []).push(outputOf(event));
    if (action !== "fail" || this.held.failingPackages[pkg] === true) return null;
    const failedBuild = typeof event["FailedBuild"] === "string" ? event["FailedBuild"] : undefined;
    const buildOutput = failedBuild !== undefined ? this.held.builds[failedBuild] : undefined;
    const text = buildOutput ?? (this.held.packageOutput[pkg] ?? []).join("\n");
    return { suite: pkg, name: pkg, status: "fail", duration_ms: elapsed, failure: failureOf({ message: text }), file: pkg };
  }

  /** A test's event: its start noted, its output held, its terminal event one case. */
  private testEvent(
    action: string,
    pkg: string,
    test: string,
    event: Record<string, unknown>,
    elapsed: number,
  ): GoCase | null {
    const key = `${pkg} ${test}`;
    const top = test.split("/")[0] ?? test;
    const topKey = `${pkg} ${top}`;
    const isBenchmark = top.startsWith("Benchmark");
    if (action === "run") {
      if (!test.includes("/") && !isBenchmark && !this.held.started.includes(topKey)) this.held.started.push(topKey);
      return null;
    }
    if (action === "output") {
      this.output(recordOf(this.held, key), outputOf(event), event["OutputType"]);
      return null;
    }
    if (action !== "pass" && action !== "fail" && action !== "skip") return null;
    if (!isBenchmark && !this.held.reached.includes(topKey)) this.held.reached.push(topKey);
    if (action === "fail") this.held.failingPackages[pkg] = true;
    const record = recordOf(this.held, key);
    const slash = test.lastIndexOf("/");
    if (slash > 0) {
      const parent = recordOf(this.held, `${pkg} ${test.slice(0, slash)}`);
      parent.subtestEnded = true;
      if (action === "fail") parent.subtestFailed = true;
    }
    delete this.held.tests[key];
    if (action === "pass") {
      if (record.subtestEnded) return null;
      return { suite: pkg, name: test, status: "pass", duration_ms: elapsed, file: pkg };
    }
    if (action === "skip") {
      if (record.subtestEnded) return null;
      return {
        suite: pkg,
        name: test,
        status: "pending",
        duration_ms: elapsed,
        ...(record.lastLocated !== undefined ? { failure: { message: record.lastLocated } } : {}),
        file: pkg,
      };
    }
    // A parent that failed only because a subtest failed is no case of its own.
    if (record.subtestEnded && record.subtestFailed && !record.ownError && !record.ownPanic) return null;
    const message = record.message.length > 0 ? record.message.join("\n") : record.untyped.join("\n");
    const fileLine = record.fileLine ?? record.frameLine;
    const failure = failureOf({
      message,
      ...(fileLine !== undefined ? { type: `${pkg}/${fileLine}` } : {}),
      trace: record.trace.join("\n"),
    });
    const file = fileLine !== undefined ? `${pkg}/${fileLine.split(":")[0]}` : pkg;
    return { suite: pkg, name: test, status: "fail", duration_ms: elapsed, failure, file };
  }

  /** One output line of a test, classed by its `OutputType` when the stream carries it, else by its text. */
  private output(record: TestRecord, text: string, outputType: unknown): void {
    let kind: "frame" | "error" | "continue" | "untyped";
    if (this.held.typed) {
      kind =
        outputType === "frame"
          ? "frame"
          : outputType === "error"
            ? "error"
            : outputType === "error-continue"
              ? "continue"
              : "untyped";
    } else if (FRAME.test(text)) kind = "frame";
    else if (HEADER.test(text)) kind = "error";
    else if (record.indent !== undefined && record.inMessage && text.startsWith(`${record.indent}    `)) {
      kind = "continue";
    } else kind = "untyped";
    if (kind === "frame") {
      record.inMessage = false;
      return;
    }
    record.trace.push(text);
    const header = HEADER.exec(text);
    if (header !== null) record.lastLocated = header[4];
    if (kind === "error") {
      record.ownError = true;
      if (record.fileLine === undefined && header !== null) {
        record.fileLine = `${(header[2] ?? "").split("/").pop()}:${header[3]}`;
        record.indent = header[1];
        record.message.push(header[4] ?? "");
        record.inMessage = true;
      } else record.inMessage = false;
      return;
    }
    if (kind === "continue") {
      if (record.inMessage) {
        const indent = `${record.indent ?? ""}    `;
        record.message.push(text.startsWith(indent) ? text.slice(indent.length) : text.trimStart());
      }
      return;
    }
    record.inMessage = false;
    record.untyped.push(text);
    if (text.startsWith("panic: ")) record.ownPanic = true;
    const frame = TEST_FRAME.exec(text);
    if (frame !== null && record.frameLine === undefined) record.frameLine = `${frame[1]}:${frame[2]}`;
  }

  /** One line read into the board's one test-end shape; a failure's detail rides only on a failed case. */
  read(line: string): StreamLine {
    const read = this.readCase(line);
    if (read === "blank") return { event: "blank" };
    if (read === "undecodable") return { event: "undecodable" };
    if (read === null) return { event: "unknown" };
    const test: TestEndEvent = {
      event: "test-end",
      name: read.name,
      suite: read.suite,
      file: read.file,
      status: read.status,
      duration_ms: read.duration_ms,
    };
    if (read.status === "fail" && read.failure !== undefined) test.failure = read.failure;
    return test;
  }
}

/**
 * A go-test stream decoded into the canonical run, synchronously: one suite
 * node per package in first-seen order, one leaf per case in stream order —
 * a skip keeping its reason and a failure its type, which is why the tree is
 * built here and not by the shared stream assembly. `incomplete` states why
 * the stream cannot be trusted, joined by "; ": a top-level test that started
 * and never reported; fewer top-level tests reached than the run's
 * `startTotal`, when above 0; an undecodable line; a cut at
 * `ingest_body_bytes`.
 */
export function parseGoTest(text: string, options: { cut?: boolean; startTotal?: number } = {}): DecodedRun {
  const reader = new GoTestReader();
  const suites = new Map<string, TestLeaf[]>();
  const files = new Set<string>();
  for (const line of text.split("\n")) {
    const read = reader.readCase(line);
    if (read === null || read === "blank" || read === "undecodable") continue;
    const leaf: TestLeaf = { name: read.name, status: read.status, duration_ms: Math.round(read.duration_ms) };
    if (read.failure !== undefined) leaf.failure = read.failure;
    const children = suites.get(read.suite) ?? [];
    children.push(leaf);
    suites.set(read.suite, children);
    files.add(read.file);
  }
  const tree: SuiteNode[] = [...suites.entries()].map(([name, children]) => ({
    name,
    status: suiteStatus(children),
    children,
  }));
  const summary = summaryOf(tree.flatMap((suite) => suite.children));
  const held = reader.held;
  const reasons: string[] = [];
  for (const started of held.started) {
    if (held.reached.includes(started)) continue;
    const [pkg, test] = started.split(" ");
    reasons.push(`${test} (${pkg}) started and never reported`);
  }
  const total = options.startTotal;
  if (total !== undefined && total > 0 && held.reached.length < total) {
    reasons.push(`the run listed ${total} top-level tests, the stream reached ${held.reached.length}`);
  }
  reasons.push(...undecodableReason(held.undecodable));
  if (options.cut === true) reasons.push(CUT_REASON);
  return { summary, tree, files: [...files], ...(reasons.length > 0 ? { incomplete: reasons.join("; ") } : {}) };
}
