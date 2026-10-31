// The `bun-console` view codec: bun's console, relayed as an open run's view
// stream, read into its live state batch by batch. It is never the run's
// record (that stays its JUnit report), so it has no `parse`.
//
// Each line is read by the same resumable readers the record's raw-output
// reading uses (src/codecs/bun-console.ts): the marriage reader for the result
// lines and the detail married to each failure, the load-error reader for the
// file headers and the load-error blocks. Their pending state is held between
// batches as the live row's reader state, and the decoded offset moves past
// every whole line, so no batch re-reads a decoded byte.
import type { RunLiveFailure } from "../types.ts";
import {
  BunConsoleFailureReader,
  BunLoadErrorReader,
  type BunConsoleFailureState,
  type BunLoadErrorState,
  wholeConsoleLines,
} from "./bun-console.ts";
import type { ViewCodec, ViewFill, ViewLive } from "./index.ts";

/** Both readers' pending state, as the live row holds it. */
interface ReaderState {
  failure: BunConsoleFailureState;
  load: BunLoadErrorState;
}

/** A live failure's id: `<suite>::<name>#<n>`, `n` counting that suite and name among the run's live failures from 1. */
function failureId(live: ViewLive, suite: string, name: string): string {
  const n = live.failures.filter((f) => f.suite === suite && f.name === name).length + 1;
  return `${suite}::${name}#${n}`;
}

function addFailure(live: ViewLive, failure: Omit<RunLiveFailure, "id">): void {
  live.failures.push({ id: failureId(live, failure.suite, failure.name), ...failure });
}

/**
 * Read the whole lines of `text` — the held stream from the decoded byte
 * offset `offset` — into `live`, resuming the readers from `readerState`:
 *  - a pass line: completed + 1, passed + 1;
 *  - a fail line: completed + 1, failed + 1, and one failure named by the
 *    line's composed `suite > name`, its suite everything before the last
 *    ` > ` (else `?`), its file the current file (else `?`), and its message
 *    the married block's first line when one is married;
 *  - a skip or todo line: completed + 1, pending + 1;
 *  - a `<file>:` header: the current file;
 *  - a load-error block with a file: failed + 1, and one failure `?` in that
 *    file, its message the block's `error:` line.
 * Answers the offset past the last whole line and the readers' state.
 */
function fill(text: string, offset: number, readerState: string | null, live: ViewLive): ViewFill {
  const held = readerState === null ? undefined : (JSON.parse(readerState) as ReaderState);
  const failures = new BunConsoleFailureReader(held?.failure);
  const loads = new BunLoadErrorReader(held?.load);
  const { lines, consumed } = wholeConsoleLines(text);
  for (const line of lines) {
    const result = failures.read(line);
    const load = loads.read(line);
    const file = loads.currentFile;
    if (file !== undefined) live.currentFile = file;
    if (result !== null) {
      live.completed += 1;
      if (result.status === "pass") live.passed += 1;
      else if (result.status === "fail") {
        live.failed += 1;
        const cut = result.name.lastIndexOf(" > ");
        const message = result.detail?.message;
        addFailure(live, {
          name: result.name,
          suite: cut === -1 ? "?" : result.name.slice(0, cut),
          file: live.currentFile ?? "?",
          ...(message !== undefined ? { message } : {}),
        });
      } else live.pending += 1;
    }
    if (load?.kind === "end" && load.file !== undefined) {
      live.failed += 1;
      addFailure(live, { name: "?", suite: "?", file: load.file, message: load.message });
    }
  }
  const state: ReaderState = { failure: failures.snapshot(), load: loads.snapshot() };
  return { offset: offset + Buffer.byteLength(text.slice(0, consumed), "utf8"), readerState: JSON.stringify(state) };
}

/** The `bun-console` view codec. */
export const bunConsoleView: ViewCodec = { name: "bun-console", fill };
