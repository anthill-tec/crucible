// CR-CRU-200 §S1 — the `crucible-events` codec: one Crucible event shape,
// newline-delimited JSON (a `run-start`, a `test-end` per test, a `run-end`),
// decoded into the canonical run through JUnit's own reading rules
// (`failureOf`, `suiteStatus`). A stream codec: it reads a run's held stream,
// never a report sent as one.
import type { RunSummary, SuiteNode, TestLeaf, TestStep } from "../types.ts";
import type { DecodedRun } from "./index.ts";
import { failureOf, nonBlank, suiteStatus } from "./junit.ts";
import type { FailureParts } from "./junit.ts";

/** The name JUnit gives a blank suite or case. */
const BLANK_NAME = "?";

/** A `test-end` event, its keys checked. */
export interface TestEndEvent {
  event: "test-end";
  id?: string;
  name: string;
  suite?: string;
  file?: string;
  browser?: string;
  status: TestLeaf["status"];
  duration_ms?: number;
  failure?: FailureParts;
  steps?: StepEvent[];
}

/** One step of a `test-end`, its keys checked as a `test-end`'s are. */
export interface StepEvent {
  name: string;
  status: TestLeaf["status"];
  duration_ms?: number;
  failure?: FailureParts;
}

/** A `run-start` event, its total checked. */
export interface RunStartEvent {
  event: "run-start";
  total?: number;
}

/** A `run-end` event, its totals checked. */
export interface RunEndEvent {
  event: "run-end";
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms?: number;
}

/**
 * One stream line, read: a known event, a `blank` line, a kind no codec
 * knows (`unknown`, skipped silently), or a line that cannot be read
 * (`undecodable`, skipped and counted).
 */
export type StreamLine =
  | RunStartEvent
  | TestEndEvent
  | RunEndEvent
  | { event: "blank" }
  | { event: "unknown" }
  | { event: "undecodable" };

const STATUSES: ReadonlySet<string> = new Set(["pass", "fail", "pending"]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFailure(value: unknown): value is FailureParts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const parts = value as Record<string, unknown>;
  return optionalString(parts["message"]) && optionalString(parts["type"]) && optionalString(parts["trace"]);
}

/** A `test-end`'s `steps`, each step's keys checked; null when any is ill-formed. */
function readSteps(value: unknown): StepEvent[] | null {
  if (!Array.isArray(value)) return null;
  const steps: StepEvent[] = [];
  for (const step of value as unknown[]) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) return null;
    const { name, status, duration_ms: duration, failure } = step as Record<string, unknown>;
    if (typeof name !== "string" || typeof status !== "string" || !STATUSES.has(status)) return null;
    if (duration !== undefined && !isDuration(duration)) return null;
    if (failure !== undefined && !isFailure(failure)) return null;
    steps.push({
      name,
      status: status as TestLeaf["status"],
      ...(duration !== undefined ? { duration_ms: duration } : {}),
      ...(failure !== undefined ? { failure } : {}),
    });
  }
  return steps;
}

/** A parsed object as the event its `event` key names, its keys checked. */
function readEvent(fields: Record<string, unknown>): StreamLine {
  const kind = fields["event"];
  if (typeof kind !== "string") return { event: "undecodable" };
  if (kind === "run-start") {
    const total = fields["total"];
    if (total === undefined) return { event: "run-start" };
    return isCount(total) ? { event: "run-start", total } : { event: "undecodable" };
  }
  if (kind === "test-end") {
    const { id, name, suite, file, browser, status, duration_ms: duration, failure } = fields;
    if (typeof name !== "string" || typeof status !== "string" || !STATUSES.has(status)) {
      return { event: "undecodable" };
    }
    if (!optionalString(id) || !optionalString(suite) || !optionalString(file)) return { event: "undecodable" };
    if (duration !== undefined && !isDuration(duration)) return { event: "undecodable" };
    if (failure !== undefined && !isFailure(failure)) return { event: "undecodable" };
    if (browser !== undefined && (typeof browser !== "string" || browser.length === 0)) return { event: "undecodable" };
    const steps = fields["steps"] === undefined ? undefined : readSteps(fields["steps"]);
    if (steps === null) return { event: "undecodable" };
    return {
      event: "test-end",
      name,
      status: status as TestLeaf["status"],
      ...(id !== undefined ? { id: id as string } : {}),
      ...(suite !== undefined ? { suite: suite as string } : {}),
      ...(file !== undefined ? { file: file as string } : {}),
      ...(browser !== undefined ? { browser } : {}),
      ...(duration !== undefined ? { duration_ms: duration } : {}),
      ...(failure !== undefined ? { failure } : {}),
      ...(steps !== undefined ? { steps } : {}),
    };
  }
  if (kind === "run-end") {
    const { total, passed, failed, pending, duration_ms: duration } = fields;
    if (!isCount(total) || !isCount(passed) || !isCount(failed) || !isCount(pending)) {
      return { event: "undecodable" };
    }
    if (duration !== undefined && !isDuration(duration)) return { event: "undecodable" };
    return {
      event: "run-end",
      total,
      passed,
      failed,
      pending,
      ...(duration !== undefined ? { duration_ms: duration } : {}),
    };
  }
  return { event: "unknown" };
}

/** One stream line read as §S1 states: blank, unknown, undecodable, or a known event. */
export function readStreamLine(line: string): StreamLine {
  if (line.trim().length === 0) return { event: "blank" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { event: "undecodable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { event: "undecodable" };
  return readEvent(parsed as Record<string, unknown>);
}

/** A test's suite as its node is named: `?` when blank or absent. */
export function suiteNameOf(test: TestEndEvent): string {
  return nonBlank(test.suite) ?? BLANK_NAME;
}

/** A test's leaf name: `?` when blank. */
export function leafNameOf(test: TestEndEvent): string {
  return nonBlank(test.name) ?? BLANK_NAME;
}

/** A test's file by JUnit's file rule: its non-blank `file`, else its suite's name, `\` read as `/`. */
function fileOf(test: TestEndEvent): string {
  return (nonBlank(test.file) ?? suiteNameOf(test)).replace(/\\/g, "/");
}

/** A step as its leaf reads: rounded duration (0 when absent), its failure kept only when it failed. */
function toStep(step: StepEvent): TestStep {
  const read: TestStep = { name: step.name, status: step.status, duration_ms: Math.round(step.duration_ms ?? 0) };
  if (step.status === "fail") read.failure = failureOf(step.failure ?? {});
  return read;
}

/** A `test-end` as the leaf JUnit would store for the same case, its steps read by the same rules. */
function toLeaf(test: TestEndEvent): TestLeaf {
  const leaf: TestLeaf = {
    name: leafNameOf(test),
    status: test.status,
    duration_ms: Math.round(test.duration_ms ?? 0),
  };
  if (test.status === "fail") leaf.failure = failureOf(test.failure ?? {});
  if (test.steps !== undefined) leaf.steps = test.steps.map(toStep);
  return leaf;
}

function countsOf(leaves: readonly TestLeaf[]): Omit<RunSummary, "duration_ms"> {
  const counts = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const leaf of leaves) {
    counts.total += 1;
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

function figures(counts: Omit<RunSummary, "duration_ms">): string {
  return `total ${counts.total}, passed ${counts.passed}, failed ${counts.failed}, pending ${counts.pending}`;
}

/**
 * A `crucible-events` stream decoded into the canonical run, synchronously:
 * one suite node per distinct (suite, browser) in first-seen order, one leaf per
 * `test-end` in stream order, counts from the leaves, the duration the last
 * `run-end`'s, else the leaves' sum. `incomplete` states, in §S1's order and
 * joined by "; ", why the stream cannot be trusted — `cut` (a batch the board
 * refused at `ingest_body_bytes`) being the last reason; it is absent when
 * nothing is wrong.
 */
export function parseCrucibleEvents(text: string, cut = false): DecodedRun {
  // Keyed by (suite, browser): one node per distinct pair, in first-seen order.
  const suites = new Map<string, { name: string; browser?: string; children: TestLeaf[] }>();
  const leaves: TestLeaf[] = [];
  const files = new Set<string>();
  let runEnd: RunEndEvent | undefined;
  let afterRunEnd = false;
  let undecodable = 0;
  for (const line of text.split("\n")) {
    const read = readStreamLine(line);
    if (read.event === "undecodable") undecodable += 1;
    else if (read.event === "run-end") runEnd = read;
    else if (read.event === "test-end") {
      if (runEnd !== undefined) afterRunEnd = true;
      const leaf = toLeaf(read);
      leaves.push(leaf);
      const name = suiteNameOf(read);
      const key = JSON.stringify([name, read.browser ?? null]);
      const suite = suites.get(key);
      if (suite === undefined) {
        suites.set(key, { name, ...(read.browser !== undefined ? { browser: read.browser } : {}), children: [leaf] });
      } else suite.children.push(leaf);
      files.add(fileOf(read));
    }
  }
  const tree: SuiteNode[] = [...suites.values()].map(({ name, browser, children }) => ({
    name,
    status: suiteStatus(children),
    ...(browser !== undefined ? { browser } : {}),
    children,
  }));
  const counts = countsOf(leaves);
  const leafDuration = leaves.reduce((sum, leaf) => sum + leaf.duration_ms, 0);
  const summary: RunSummary = { ...counts, duration_ms: runEnd?.duration_ms ?? leafDuration };
  const reasons: string[] = [];
  if (runEnd === undefined) reasons.push("no run-end");
  else {
    const stated = { total: runEnd.total, passed: runEnd.passed, failed: runEnd.failed, pending: runEnd.pending };
    const differs = (["total", "passed", "failed", "pending"] as const).some((key) => stated[key] !== counts[key]);
    if (differs) reasons.push(`run-end states ${figures(stated)}, the tests count ${figures(counts)}`);
  }
  if (afterRunEnd) reasons.push("a test after run-end");
  if (undecodable > 0) reasons.push(`${undecodable} undecodable ${undecodable === 1 ? "line" : "lines"}`);
  if (cut) reasons.push("cut at ingest_body_bytes");
  return {
    summary,
    tree,
    files: [...files],
    ...(reasons.length > 0 ? { incomplete: reasons.join("; ") } : {}),
  };
}
