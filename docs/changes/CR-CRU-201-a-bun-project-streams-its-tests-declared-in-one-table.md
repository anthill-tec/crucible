# CR-CRU-201 — a bun test run shows its console live on the board

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-224 · **Status** PENDING
- **Filed 2026-10-20.** User rulings 2026-10-20; the design is in `DN-crucible-live-test-progress.md`.
- **Split at its gap analysis, 2026-10-31.** User ruling: three dog-food-safe units.
  - **This CR:** bun's console live view, with the board's view-only stream mode it needs.
  - **CR-CRU-225:** the `crucible.targets` table declares a stream, and the shipped Vitest and Playwright reporters stream
    the Crucible shape.
  - **CR-CRU-226:** the clean break. `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` are refused, the
    `playwright` codec retires, and this repo's `package.json` and the Vitest fixture move to the table.
- **Gap analysis 2026-10-31.** Re-scored to 13 points. User rulings:
  - the run start carries the client's `total`;
  - a live failure shows its name, file and message;
  - the client relays the whole console, and the board reads it.

  CR-CRU-224's narration ruling applies here too: no in-run count for a relayed run, and the closing `ran N/M` and
  `ingesting…` stay.

The file keeps its first slug.

**Pre-review: due** — the CR scores 13 points, its gap analysis needed rulings from the user, and it changes the shipped
client's surface.

**PROPOSED, awaiting the user's ruling** (Rule 19):
- **P1:** a stream codec states its kind, `stream: "record" | "view"`. `crucible-events` is `record` and `bun-console` is
  `view`. Health lists `bun-console` under `codecs.test`.
- **P2:** the run's total is a new nullable `total` column on `runs`, which takes migration v22. The live state's own
  `run-start` total, when a stream gives one, wins over it.
- **P3:** the client tees the runner's console into `<reports dir>/bun-console.log`, and the relay follows that file.
- **P4:** a view-only streamed run that is aborted is stored as today, with no tree. The console is not its record.

## Problem

A `bun test` run reaches the board only at exit. While it runs, the client counts its console result lines and sends
`running N/M · <file>` as a heartbeat. The board sees no test name, status or failure until the JUnit report arrives.

`bun test` has no structured stream: its console result lines are its only live source. Its record stays its JUnit report
(the DN's console-only row), so its live view must come from a stream that is NOT the run's record.

CR-CRU-200's board takes only record-bearing streams: a run holding a stream closed by a JUnit report is refused.

The board may run on another machine. The console exists only where the client runs, so it reaches the board as HTTP
batches, never as a file the board reads.

## Design (user rulings 2026-10-20 and 2026-10-31)

- **A view-only stream.** The board learns a second kind of stream codec, one that fills the live state and is never the
  run's record. A run holding a view-only stream closes through its JUnit ingest as today, and its stream is deleted when
  it settles.
- **`bun-console`.** A board codec that reads bun's console into the live state:
  - each result line is one finished test;
  - each `<file>:` header names the current file;
  - each failure's detail block is married to its `(fail)` line by CR-CRU-088's rule, which already lives in
    `src/codecs/bun-console.ts`.
- **The total.** The run start carries the client's own count of the tests it is about to run (its source scan), so the
  live view reads `412/1280`.
- **The relay.** The bun client relays the runner's whole console output, as written, through CR-CRU-224's shared relay.
  The board, not the client, picks out the result lines.
- **The record is unchanged:** the JUnit report.

## Steps

### §S1 — a view-only stream on the board

- **The codec kind.** `Codec.stream` becomes `"record" | "view"` *(P1)*. `crucible-events` is `"record"`, as CR-CRU-200
  shipped it. Every existing check of `stream === true` reads `stream !== undefined`, or the kind it means.
- **The route.** `POST /api/v2/runs/<runId>/stream` takes a view codec under the same rules as a record codec:
  - offsets, overlap, gap, the size bound;
  - one codec per run, fixed by the first batch;
  - the quiet touch;
  - the throttled frames.
- **The close.** A run holding a VIEW stream closes through `POST /api/v2/runs` with its report codec (`junit`), as a run
  with no stream does.
  - `refuseStreamedRunClose` refuses only a run holding a RECORD stream.
  - Closing a view-stream run with `codec: "bun-console"` and no data is refused (400): a view stream is no record.
  - At settle the batches and live state are deleted, as for a record stream.
- **The abort.** An aborted view-stream run is stored exactly as today, with no tree and no `incomplete` *(P4)*. The
  sweep, the abort route and the readers are unchanged for it.

### §S2 — the run start carries a total

- **The route.** `POST /api/v2/runs/start` takes an optional `total`, an integer ≥ 0. Any other value is a 400 that states
  nothing was started. It is stored on the run *(P2)*.
- **The live read.** `Store#runLive` answers `total` from the live state's own `run-start` when the stream gives one, else
  from the run's start total. A total of 0 is no total.
- **The brief.** The open-run brief's `live` is unchanged in shape (CR-CRU-223 §S1).

### §S3 — the `bun-console` codec

- **What it reads:** bun's piped console, in both result-line forms:
  - the coloured `✓` / `✗` glyphs with SGR runs;
  - the plain `(pass)` / `(fail)` / `(skip)` / `(todo)` lines.

  SGR escapes are stripped before anything is kept.
- **What each line does in the live state:**
  - **a pass line:** `completed + 1`, `passed + 1`;
  - **a fail line:** `completed + 1`, `failed + 1`, and one failure with:
    - `name`: the result line's composed `suite > name`;
    - `suite`: everything before the last ` > `, or `?`;
    - `file`: the current file, or `?`;
    - `message`: the married block's `error:` text, first line;
    - `id`: `<suite>::<name>#<n>`;
  - **a skip or todo line:** `completed + 1`, `pending + 1`;
  - **a `<file>:` header:** sets `currentFile`.
- **The marriage is CR-CRU-088's rule,** shared with `parseBunConsoleFailures`. That function's line-by-line reading
  becomes one exported reader that both the JUnit raw-output reading and this codec call: a source check asserts both
  import it, so the rule is never copied.
- **Reading across batches.** A detail block printed before its `(fail)` line can span batches. The live fill decodes from
  the run's decoded offset, and moves that offset only to just past the LAST RESULT LINE it read. So the next batch re-reads
  any pending block with the line that follows it.
- **No record path.** `bun-console` has no `parse` for a record. Sending it as a body report or as a close codec is a 400.

### §S4 — the bun client relays its console

**Where it applies:** every bun-client verb that opens a run and narrates today:
- `test` (`cmd_test`);
- the tier verbs, `regression` and `pre-merge-gate`'s bun suite (`cmd_regression`).

**The steps:**
1. **The board check.** Before the run opens, the client reads the board's health. When health lists `bun-console`, the
   run relays. When it doesn't (an older board), or no run is opened, the run is exactly as today: no relay, today's
   narration and JUnit close. Nothing is refused, since the view is optional.
2. **The total.** The run start carries `total`, the existing `_prescan_test_total`.
3. **The console file.** The runner's combined output goes, as `run_streamed` already reads it, into
   `<reports dir>/bun-console.log` *(P3)*. The reports dir's wipe removes the file first. A `StreamRelay` (CR-CRU-224 §S2)
   follows it with codec `bun-console`.
4. **The close.** At the runner's exit, the client calls `finish` (bounded), then closes with the JUnit ingest exactly as
   today. The record is unchanged.
5. **Failures never fail the run.** A relay failure is said once on stderr and never fails the run or its exit.
6. **Narration.** For a relayed run, the narrator posts no in-run `running N/M` count. It posts its closing `ran N/M` and
   `ingesting…` as today. An unrelayed run narrates as today.

### §S5 — the record of the design, and the close-out

- **The record of the design:**
  - PRD §4.4 names `bun-console` as a view-only stream codec, and the run start's `total`;
  - the DN's console-only row names CR-CRU-201's view-only mode;
  - the local server API doc (`.lavish/crucible-server-api.html`, not in git) is updated for the start's `total`, the view
    codecs and the close rule.
- **Schema:** migration v22. `docs/RUNBOOK.md`'s schema figures follow.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-measured and re-recorded once
  each, in their own commits. `tests/health-names-the-codecs-it-decodes.test.ts`'s and
  `tests/gate-milestone-scope-and-suites.test.ts`'s codec lists follow §S1.

## Acceptance criteria

- [ ] **AC1 — the view-only kind.**
  - `crucible-events` is `stream: "record"` and `bun-console` is `stream: "view"`.
  - A run holding a view stream closes through `POST /api/v2/runs` `codec: "junit"` and stores exactly what the same
    JUnit close stores with no stream. Its batches and live state are deleted at settle.
  - A run holding a record stream is still refused a JUnit close (CR-CRU-200).
  - `bun-console` sent as a report, or as a close codec, is a 400.
  - An aborted view-stream run is stored as today, with no tree.
- [ ] **AC2 — the start's total.**
  - `POST /api/v2/runs/start` stores an integer `total` ≥ 0, and refuses any other value (400, nothing started).
  - `Store#runLive` and the brief answer it as `total`, with a stream's own `run-start` total winning, and 0 as none.
  - Migration v22 adds the column, and RUNBOOK's figures read v22.
- [ ] **AC3 — the codec reads bun's console.** On captured bun console text in both forms (coloured and plain), sent in
  batches that split a line and split a detail block from its `(fail)` line:
  - the live counts, `currentFile` and failures (name, suite, file, first message line, fallback id) are what §S3 states;
  - a block whose echo names another test marries no one, by CR-CRU-088's rule;
  - the reader is shared with the JUnit raw-output reading: a source check proves it, on synthetic sources both ways.
- [ ] **AC4 — the client relays.** The bun client relays the console for `test`, a tier verb, `regression` and the gate's
  bun suite. Across those:
  - the run start carries the prescanned `total`;
  - the record is the same JUnit close as today;
  - a board without `bun-console`, or no `runId`, runs exactly as today, with no relay;
  - a relay failure never changes the run's exit;
  - a relayed run posts no `running N/M`, and posts `ran N/M` and `ingesting…`.
- [ ] **AC5 — on the board while it runs.** A real `bun test` run through the real bun client, against a scratch board, on
  a fixture whose tests wait on one another. While the run works, the open run's `/live` shows each finished test, a
  failure with its message, and `total` from the scan. The stored run equals today's JUnit run of the same tests.
- [ ] **AC6 — the design record and the guards.**
  - PRD §4.4 and the DN read as §S5 states.
  - The health and gate-milestone codec lists follow.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC7 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in
  their own commits.

## Non-goals

- **A structured stream from `bun test` itself:** it has no reporter API.
- **The declaration table and the shipped reporters** (CR-CRU-225); a declared script's console is relayed as-is, and
  whatever the board finds in it is shown.
- **The clean break and the `playwright` codec's retirement** (CR-CRU-226).
- **Maven's console live view** (CR-CRU-203), which reuses this CR's view-only mode.
- **Data-carrying SSE frames**, and any change to `/api/stream`.
