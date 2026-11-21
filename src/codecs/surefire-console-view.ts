// The `surefire-console` view codec: maven's combined console, relayed as an
// open run's view stream while surefire or failsafe runs, read into its live
// state batch by batch. It is never the run's record (that stays the surefire
// reports), so it has no `parse`; where the view and the record differ, the
// record wins.
//
// Only maven's own log lines are read — `[INFO] `, `[ERROR] ` or `[WARNING] `
// after ANSI SGR is stripped — so a test's own output is passed over, except
// as a failure's message. The per-class counts, the open `Running` classes and
// a failure still waiting for its message are held between batches as the
// live row's reader state, and the decoded offset moves past every whole line,
// so no batch re-reads a decoded byte.
import { wholeConsoleLines } from "./bun-console.ts";
import type { ViewCodec, ViewFill, ViewLive } from "./index.ts";

/** One class's counts as its `-- in` line last set them: run, failed (failures + errors), pending (skipped). */
type ClassCounts = [run: number, failed: number, pending: number];

/** A failure line read, waiting for the line that decides its message. */
interface PendingFailure {
  suite: string;
  name: string;
}

/** The reader's state, as the live row holds it: kept compact, as it is written on every batch. */
interface ReaderState {
  /** Each class's counts, by class. */
  counts: Record<string, ClassCounts>;
  /** The classes `Running` and not yet closed by their `-- in` line, in the order they opened. */
  open: string[];
  /** A failure whose message is not decided yet. */
  waiting: PendingFailure | null;
}

const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const LOG_PREFIX = /^\[(?:INFO|ERROR|WARNING)\] /;
const CLASS_COUNTS = /^Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+), .* -- in (\S+)$/;
const FAILURE_LINE = /^(\S+) -- Time elapsed: .* <<< (?:FAILURE|ERROR)!$/;
const RUNNING = /^Running (\S+)$/;

/** A live failure's id: `<suite>::<name>#<n>`, `n` counting that suite and name among the run's live failures from 1. */
function failureId(live: ViewLive, suite: string, name: string): string {
  const n = live.failures.filter((f) => f.suite === suite && f.name === name).length + 1;
  return `${suite}::${name}#${n}`;
}

/** Add one failure — its file the class — unless the run's live failures already hold that suite and name. */
function addFailure(live: ViewLive, failure: PendingFailure, message: string | undefined): void {
  if (live.failures.some((f) => f.suite === failure.suite && f.name === failure.name)) return;
  live.failures.push({
    id: failureId(live, failure.suite, failure.name),
    name: failure.name,
    suite: failure.suite,
    file: failure.suite,
    ...(message !== undefined ? { message } : {}),
  });
}

/** Set a class's counts in `live`, replacing — never adding to — any counts an earlier line set for it. */
function setClassCounts(live: ViewLive, state: ReaderState, cls: string, next: ClassCounts): void {
  const previous = state.counts[cls];
  if (previous !== undefined) {
    const [run, failed, pending] = previous;
    live.completed -= run;
    live.failed -= failed;
    live.pending -= pending;
    live.passed -= run - failed - pending;
  }
  const [run, failed, pending] = next;
  state.counts[cls] = next;
  live.completed += run;
  live.failed += failed;
  live.pending += pending;
  live.passed += run - failed - pending;
}

/**
 * A failure line's token as suite and name: a token that is a class itself is
 * a class-level failure named `""`; any other splits at the last `.` before
 * the first `(` (no `.` gives suite `?`).
 */
function splitToken(state: ReaderState, token: string): PendingFailure {
  if (state.counts[token] !== undefined || state.open.includes(token)) return { suite: token, name: "" };
  const paren = token.indexOf("(");
  const head = paren === -1 ? token : token.slice(0, paren);
  const dot = head.lastIndexOf(".");
  return dot === -1 ? { suite: "?", name: token } : { suite: token.slice(0, dot), name: token.slice(dot + 1) };
}

/**
 * Read the whole lines of `text` — the held stream from the decoded byte
 * offset `offset` — into `live`, resuming from `readerState`:
 *  - a pending failure takes the next non-blank line as its message, unless
 *    that line starts with `[`, when it has none;
 *  - a `Running <class>` line opens the class and makes it the current file;
 *  - a line ending `-- in <class>` sets that class's counts and closes it;
 *  - a `<token> -- Time elapsed: … <<< FAILURE!` or `<<< ERROR!` line is one
 *    failure, de-duplicated by suite and name.
 * The current file is the last class still open, else none. Answers the
 * offset past the last whole line and the reader's state.
 */
function fill(text: string, offset: number, readerState: string | null, live: ViewLive): ViewFill {
  const state: ReaderState =
    readerState === null ? { counts: {}, open: [], waiting: null } : (JSON.parse(readerState) as ReaderState);
  const { lines, consumed } = wholeConsoleLines(text);
  for (const raw of lines) {
    const line = raw.replace(ANSI_SGR, "");
    if (state.waiting !== null) {
      if (line.trim() === "") continue;
      const isLog = line.startsWith("[");
      addFailure(live, state.waiting, isLog ? undefined : line);
      state.waiting = null;
      if (!isLog) continue;
    }
    if (!LOG_PREFIX.test(line)) continue;
    const body = line.replace(LOG_PREFIX, "");
    const running = RUNNING.exec(body);
    if (running !== null) {
      const cls = running[1] ?? "";
      state.open = [...state.open.filter((c) => c !== cls), cls];
      continue;
    }
    const counts = CLASS_COUNTS.exec(body);
    if (counts !== null) {
      const cls = counts[5] ?? "";
      setClassCounts(live, state, cls, [Number(counts[1]), Number(counts[2]) + Number(counts[3]), Number(counts[4])]);
      state.open = state.open.filter((c) => c !== cls);
      continue;
    }
    const failure = FAILURE_LINE.exec(body);
    if (failure !== null) state.waiting = splitToken(state, failure[1] ?? "");
  }
  const current = state.open.at(-1);
  if (current !== undefined) live.currentFile = current;
  else delete live.currentFile;
  return { offset: offset + Buffer.byteLength(text.slice(0, consumed), "utf8"), readerState: JSON.stringify(state) };
}

/** The `surefire-console` view codec. */
export const surefireConsoleView: ViewCodec = { name: "surefire-console", fill };
