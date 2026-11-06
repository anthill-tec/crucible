// The `nextest` codec: cargo-nextest's `libtest-json-plus` stream (message
// format version 0.1), one JSON object per line, read as a rust run's RECORD
// stream. Each result line is one test in the board's one test-end shape
// (`TestEndEvent`); `started` lines and a suite's result lines are not tests,
// and a suite line's figures are never read as counts. A result's suite is its
// test binary's id, resolved from the run's test list (`cargo nextest list
// --message-format json`) when the open run was given one, else from the kind
// the stream's suite lines state for its `<crate>::<binary name>`.
import type { DecodedRun } from "./index.ts";
import {
  assembleStream,
  CUT_REASON,
  summaryOf,
  undecodableReason,
  type StreamLine,
  type TestEndEvent,
} from "./crucible-events.ts";

/** One listed test binary: its id, its crate and binary name, and the paths of the tests it holds. */
interface ListedBinary {
  id: string;
  crate: string;
  binaryName: string;
  paths: ReadonlySet<string>;
}

/** nextest's test list as the board reads it: its binaries, and its tests the run's filter matches. */
export interface NextestList {
  binaries: ListedBinary[];
  total: number;
}

class NotAList extends Error {
  constructor(why: string) {
    super(`data is not a nextest test list: ${why}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * nextest's test list read from its JSON text: each binary of `rust-suites`
 * with its `binary-id`, `package-name`, `binary-name` and `testcases`, each
 * test carrying a `filter-match` status. The total is the tests whose
 * `filter-match` is `matches`. Throws when the text is no such list.
 */
export function parseNextestList(text: string): NextestList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NotAList("it is not JSON");
  }
  if (!isObject(parsed) || !isObject(parsed["rust-suites"])) throw new NotAList("it holds no rust-suites");
  const binaries: ListedBinary[] = [];
  let total = 0;
  for (const [key, suite] of Object.entries(parsed["rust-suites"])) {
    if (!isObject(suite) || !isObject(suite["testcases"])) throw new NotAList(`suite ${key} holds no testcases`);
    const id = suite["binary-id"];
    const crate = suite["package-name"];
    const binaryName = suite["binary-name"];
    if (typeof id !== "string" || typeof crate !== "string" || typeof binaryName !== "string") {
      throw new NotAList(`suite ${key} names no binary-id, package-name and binary-name`);
    }
    const paths = new Set<string>();
    for (const [path, testcase] of Object.entries(suite["testcases"])) {
      if (!isObject(testcase) || !isObject(testcase["filter-match"])) {
        throw new NotAList(`test ${path} of ${id} carries no filter-match`);
      }
      const status = testcase["filter-match"]["status"];
      if (typeof status !== "string") throw new NotAList(`test ${path} of ${id} carries no filter-match status`);
      paths.add(path);
      if (status === "matches") total += 1;
    }
    binaries.push({ id, crate, binaryName, paths });
  }
  return { binaries, total };
}

/** A test list as a run holds it once taken: its total, and each binary's id, crate, binary name and test paths. */
interface HeldList {
  total: number;
  binaries: Array<{ id: string; crate: string; binaryName: string; paths: string[] }>;
}

/**
 * nextest's test list read once, as an open run takes it: its listed total,
 * and `held`, the form the run keeps — only what a result's suite resolves
 * from — which each batch and the close read in place of the list. Throws
 * when the text is no such list.
 */
export function takeNextestList(text: string): { total: number; held: string } {
  const list = parseNextestList(text);
  const held: HeldList = {
    total: list.total,
    binaries: list.binaries.map(({ id, crate, binaryName, paths }) => ({ id, crate, binaryName, paths: [...paths] })),
  };
  return { total: list.total, held: JSON.stringify(held) };
}

/** A run's held test list (`takeNextestList`'s `held`) read back. */
function heldListOf(held: string): NextestList {
  const list = JSON.parse(held) as HeldList;
  return {
    total: list.total,
    binaries: list.binaries.map((b) => ({ id: b.id, crate: b.crate, binaryName: b.binaryName, paths: new Set(b.paths) })),
  };
}

/** The kinds the stream's suite lines state, per `<crate>::<binary name>`, in first-seen order. */
type Kinds = Record<string, string[]>;

/** The binary id nextest gives a binary of `kind`: `<crate>` for a lib, `<crate>::<name>` for a test, else `<crate>::<kind>/<name>`. */
function binaryIdOf(crate: string, binaryName: string, kind: string): string {
  if (kind === "lib" || kind === "proc-macro") return crate;
  if (kind === "test") return `${crate}::${binaryName}`;
  return `${crate}::${kind}/${binaryName}`;
}

/**
 * A failure's message: the first found in its captured output of the test's
 * own thread's panic line, cut before its trailing colon; a line starting
 * `note: test did not panic as expected`; the first panic line of any thread,
 * cut the same way; the first non-blank line.
 */
function messageOf(path: string, stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const panic = (line: string): string => line.replace(/:\s*$/, "");
  const own = lines.find((line) => line.startsWith(`thread '${path}' (`) && line.includes(") panicked at "));
  if (own !== undefined) return panic(own);
  const notPanicked = lines.find((line) => line.startsWith("note: test did not panic as expected"));
  if (notPanicked !== undefined) return notPanicked;
  const anyThread = lines.find((line) => line.startsWith("thread '"));
  if (anyThread !== undefined) return panic(anyThread);
  return lines.find((line) => line.trim().length > 0);
}

/** A result line's name, `<crate>::<binary name>$<path>`, split; its path's retry suffix `#<n>` removed. */
function splitName(name: string): { crate: string; binaryName: string; path: string } | null {
  const dollar = name.indexOf("$");
  if (dollar === -1) return null;
  const binary = name.slice(0, dollar);
  const colons = binary.indexOf("::");
  if (colons <= 0 || colons + 2 >= binary.length) return null;
  const path = name.slice(dollar + 1).replace(/#\d+$/, "");
  if (path.length === 0) return null;
  return { crate: binary.slice(0, colons), binaryName: binary.slice(colons + 2), path };
}

const RESULTS: Readonly<Record<string, TestEndEvent["status"]>> = { ok: "pass", failed: "fail", ignored: "pending" };

const SUITE_EVENTS: ReadonlySet<string> = new Set(["started", "ok", "failed"]);

/**
 * A nextest line reader: reads one line into the board's one test-end shape,
 * resolving each result's suite against `list` and the kinds the stream's
 * suite lines stated so far (`state`, carried between batches). `unresolved`
 * names each `<crate>::<binary name>` a result could not be resolved to one
 * test binary for.
 */
export class NextestLineReader {
  private readonly kinds: Kinds;
  readonly unresolved: string[] = [];

  constructor(
    private readonly list: NextestList | undefined,
    state: string | null,
  ) {
    this.kinds = state !== null ? (JSON.parse(state) as Kinds) : {};
  }

  /** The kinds seen so far, as the state carried to the next batch. */
  state(): string {
    return JSON.stringify(this.kinds);
  }

  read(line: string): StreamLine {
    if (line.trim().length === 0) return { event: "blank" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { event: "undecodable" };
    }
    if (!isObject(parsed)) return { event: "undecodable" };
    const { type, event } = parsed;
    if (typeof event !== "string") return { event: "undecodable" };
    if (type === "suite") {
      if (!SUITE_EVENTS.has(event)) return { event: "undecodable" };
      if (event === "started") this.noteKind(parsed["nextest"]);
      return { event: "unknown" };
    }
    if (type !== "test" || typeof parsed["name"] !== "string") return { event: "undecodable" };
    if (event === "started") return { event: "unknown" };
    const status = RESULTS[event];
    const name = splitName(parsed["name"]);
    if (status === undefined || name === null) return { event: "undecodable" };
    const execTime = parsed["exec_time"];
    if (execTime !== undefined && (typeof execTime !== "number" || !Number.isFinite(execTime) || execTime < 0)) {
      return { event: "undecodable" };
    }
    const suite = this.suiteOf(name);
    const test: TestEndEvent = {
      event: "test-end",
      name: name.path,
      suite,
      file: suite,
      status,
      duration_ms: typeof execTime === "number" ? execTime * 1000 : 0,
    };
    if (status === "fail") {
      const stdout = typeof parsed["stdout"] === "string" ? parsed["stdout"] : undefined;
      const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : undefined;
      const message = stdout !== undefined ? messageOf(name.path, stdout) : reason;
      const body = stdout ?? reason;
      test.failure = { ...(message !== undefined ? { message } : {}), ...(body !== undefined ? { trace: body } : {}) };
    }
    return test;
  }

  private noteKind(meta: unknown): void {
    if (!isObject(meta)) return;
    const { crate, test_binary: binaryName, kind } = meta;
    if (typeof crate !== "string" || typeof binaryName !== "string" || typeof kind !== "string") return;
    const key = `${crate}::${binaryName}`;
    const kinds = this.kinds[key] ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    this.kinds[key] = kinds;
  }

  /**
   * The listed binary of the result's crate and binary name whose tests hold
   * its path; else, when the stream's suite lines state one kind for its
   * `<crate>::<binary name>`, that kind's binary id; else that key, noted as
   * unresolved.
   */
  private suiteOf(name: { crate: string; binaryName: string; path: string }): string {
    const holders = (this.list?.binaries ?? []).filter(
      (b) => b.crate === name.crate && b.binaryName === name.binaryName && b.paths.has(name.path),
    );
    if (holders.length === 1) return holders[0]!.id;
    const key = `${name.crate}::${name.binaryName}`;
    const kinds = this.kinds[key] ?? [];
    if (kinds.length === 1) return binaryIdOf(name.crate, name.binaryName, kinds[0]!);
    if (!this.unresolved.includes(key)) this.unresolved.push(key);
    return key;
  }
}

/** A nextest line reader over a run's held stream, given the run's held test list (absent when none). */
export function nextestLineReader(list: string | undefined, state: string | null): NextestLineReader {
  return new NextestLineReader(list !== undefined ? heldListOf(list) : undefined, state);
}

/**
 * A nextest stream decoded into the canonical run, synchronously: one suite
 * node per suite in first-seen order, one leaf per result in stream order.
 * `incomplete` states why the stream cannot be trusted, joined by "; ": its
 * passed and failed tests differing from the run's total (the listed total,
 * else `startTotal`) when that total is above 0; a result's binary resolving
 * to no one test binary; an undecodable line; a cut at `ingest_body_bytes`.
 * `list` is the run's held test list (`takeNextestList`'s `held`).
 */
export function parseNextest(
  text: string,
  options: { cut?: boolean; list?: string; startTotal?: number } = {},
): DecodedRun {
  const list = options.list !== undefined ? heldListOf(options.list) : undefined;
  const reader = new NextestLineReader(list, null);
  const { tree, leaves, files, undecodable } = assembleStream(text, (line) => reader.read(line));
  const summary = summaryOf(leaves);
  const reasons: string[] = [];
  const total = list !== undefined ? list.total : options.startTotal;
  const held = summary.passed + summary.failed;
  if (total !== undefined && total > 0 && held !== total) {
    reasons.push(`the run listed ${total} tests, the stream holds ${held}`);
  }
  for (const key of reader.unresolved) reasons.push(`the results of ${key} resolve to no one test binary`);
  reasons.push(...undecodableReason(undecodable));
  if (options.cut === true) reasons.push(CUT_REASON);
  return { summary, tree, files, ...(reasons.length > 0 ? { incomplete: reasons.join("; ") } : {}) };
}
