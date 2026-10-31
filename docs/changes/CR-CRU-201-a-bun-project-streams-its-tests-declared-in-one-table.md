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
  - the run start carries the client's `total`, held in a new `runs.total` column; the board caps it at the completed
    count, and the client sends it only when its scan covers what runs;
  - a live failure shows its name, file and message;
  - a load error shows live as a failure, by the rule that files it in the record;
  - the client relays the whole console and the board reads it, but only bun's own runs relay;
  - view codecs live in their own registry, listed in health as `codecs.view`.

  CR-CRU-224's narration ruling applies here too: no in-run count for a relayed run, and the closing `ran N/M` and
  `ingesting…` stay.
- **Pre-review 2026-10-31** (`CR-CRU-201-SPEC-REVIEW`): its 15 findings are folded in. F1, F2, F5 and F15 hold the
  dog-food and scope rules; F3, F7 and P1 hold the codec shape.

The file keeps its first slug.

**Approved by the user 2026-10-31**, with P3–P5 as proposed (no longer open):

- **P3:** the client tees the runner's console into `<reports dir>/bun-console.log`, and the relay follows that file.
- **P4:** a view-only streamed run that is aborted is stored as today: no tree, no summary, no `incomplete`. The console
  is not its record.
- **P5:** the codec keeps its pending failure block in a bounded reader state on the live row (`run_live.reader_state`,
  migration v22). The decoded offset then moves past every whole line, so no batch re-reads an earlier one (pre-review F7).

## Problem

A `bun test` run reaches the board only at exit. While it runs, the client counts its console result lines and sends
`running N/M · <file>` as a heartbeat. The board sees no test name, status or failure until the JUnit report arrives.

`bun test` has no structured stream: its console result lines are its only live source. Its record stays its JUnit report
(the DN's console-only row), so its live view must come from a stream that is NOT the run's record.

CR-CRU-200's board takes only record-bearing streams: a run holding a stream closed by a JUnit report is refused.

The board may run on another machine. The console exists only where the client runs, so it reaches the board as HTTP
batches, never as a file the board reads.

## Design (user rulings 2026-10-20 and 2026-10-31)

- **A view-only stream.** The board learns view codecs, held in their own registry. A view codec fills the live state and
  is never the run's record. A run holding a view stream closes through its report as today, and its stream is deleted
  when it settles.
- **`bun-console`.** The first view codec. It reads bun's console into the live state:
  - each result line is one finished test;
  - each `<file>:` header names the current file;
  - each failure's detail block is married to its `(fail)` line by CR-CRU-088's rule, which already lives in
    `src/codecs/bun-console.ts`;
  - each load-error block is a failure, by the rule the record already files it with.
- **The total.** The run start carries the client's own count of the tests it is about to run (its source scan), so the
  live view reads `412/1280`. The board never shows a total below the completed count.
- **The relay.** The bun client relays the runner's whole console output, as written, through CR-CRU-224's shared relay.
  The board, not the client, picks out the result lines. Only a run whose console is bun's own relays.
- **The record is unchanged:** the JUnit report.

## Steps

### §S1 — view codecs on the board

- **The registry.** View codecs live in their own registry, `viewCodecs` in `src/codecs/index.ts`, beside the report
  codecs. `bun-console` is its first entry.
  - A view codec states its name and one method, `fill`. That method reads the held text from the decoded offset and the
    reader state into the live state, and returns the new offset and reader state.
  - It has no `parse`. Because it is not in the report registry, every report and close route refuses `bun-console` as
    an unknown codec (400), with no per-route check.
  - Health lists it under `codecs.view`; `codecs.test` and `codecs.stream` are unchanged.
- **The stream route.** `POST /api/v2/runs/<runId>/stream` takes a codec from either the record stream codecs
  (`crucible-events`) or the view registry, under CR-CRU-200's rules unchanged:
  - offsets, overlap, gap, the size bound;
  - one codec per run, fixed by the first batch;
  - the quiet touch;
  - the throttled frames.
- **The live fill.** `fillRunLive` is the one caller of a codec's fill. It sends a `crucible-events` stream to that
  codec's existing line reading, unchanged, and a view stream to its codec's `fill`.
- **The close.** A run holding a VIEW stream closes through its report as a run with no stream does:
  - the JUnit close (`POST /api/v2/runs`);
  - the parsed close (`/runs/parsed`);
  - the compile close (`/runs/compile`);
  - a body or raw report close by any report codec.

  `refuseStreamedRunClose` is the one check on all three routes; it refuses only a run holding a RECORD stream. At settle
  the batches, live state and failures are deleted, as for a record stream.
- **The abort.** `abortRun`, which the sweep and the abort route share, decodes a held stream through
  `abortedStreamRecord` only when it is a RECORD stream. A view-stream run is aborted exactly as a run with no stream
  *(P4)*: no tree, no summary, no `incomplete`. Its batches, live state and failures are deleted.

### §S2 — the run start carries a total

- **The route.** `POST /api/v2/runs/start` takes an optional `total`, an integer ≥ 0. Any other value is a 400 that states
  nothing was started. It is stored on the run, in the nullable `runs.total` column (migration v22).
- **The live read.** `Store#runLive` (and the open-run brief's `live`) answers `total` as follows:
  1. the live state's own `run-start` total when the stream gives one;
  2. otherwise, the run's start total;
  3. with either source, never below `completed`, and with 0 read as no total.

  `public/app.js`'s live count text reads that answer, so it never shows `1300/1280`.
- **No batch yet.** An open run with a start total but no batch has no live state. `/live` answers 404 as today.

### §S3 — the `bun-console` codec

- **What it reads:** bun's piped console, in both forms. SGR escapes are stripped before anything is kept.
  - **coloured:** `✓` pass, `✗` fail, `»` skip and `✎` todo, with SGR runs;
  - **plain:** `(pass)`, `(fail)`, `(skip)` and `(todo)`.
- **Line breaks.** The fill splits lines by the shared reader's rule (`LINE_BREAK`, Python's `splitlines`), so `\r\n` and
  `\r` end a line as `\n` does.
- **What each line does in the live state:**
  - **a pass line:** `completed + 1`, `passed + 1`;
  - **a fail line:** `completed + 1`, `failed + 1`, and one failure with:
    - `name`: the result line's composed `suite > name`;
    - `suite`: everything before the last ` > `, or `?`;
    - `file`: the current file, or `?`;
    - `message`: the married block's `error:` text, first line;
    - `id`: `<suite>::<name>#<n>`, where `n` counts that `<suite>::<name>` among the run's live failures from 1, as
      CR-CRU-200's fallback id does;
  - **a skip or todo line:** `completed + 1`, `pending + 1`;
  - **a `<file>:` header:** sets `currentFile`;
  - **a load-error block:** `failed + 1` and one failure, by `parseBunLoadErrors`' rule:
    - name `?`, suite `?`;
    - file: the file it names;
    - message: its `error:` line.
- **One rule, shared.** The marriage is CR-CRU-088's rule. `parseBunConsoleFailures`' line-by-line reading becomes one
  exported, resumable reader: one line in, its effects out, with its pending-block state readable and restorable.
  - Both the JUnit raw-output reading and this codec call it, so the rule is never copied.
  - The load-error reading is shared the same way.
  - A source check asserts both callers import them.
- **Across batches** *(P5)*. The reader's pending state is held on the live row as `run_live.reader_state` (migration
  v22). It is the pending block's `error:` line, the echo name, and its trace cut at `TRACE_LIMIT`, so it stays bounded.
  - The decoded offset moves past every whole line, and a partial last line waits for the next batch.
  - No batch re-reads an earlier one, however long the tail is (pre-review F7).

### §S4 — the bun client relays its console

**Which runs relay** (user ruling). A run relays only when its console is bun's own:

- the client's own `bun test` (`cmd_test`, and `cmd_regression` with no declared script);
- a declared script with no `crucible.reportPath` and no `crucible.rawReport` entry. Such a script is handed bun's
  `--reporter=junit` flags, so by its own declaration it runs `bun test`. In this repo that is `test:unit`,
  `test:integration` and `test:regression`.

A script that declares an env report path or a raw report (this repo's `test:e2e`) does not relay, nor does
`pre-merge-gate`'s python suite. Each runs exactly as today.

**The steps:**

1. **The board check.** Before the run opens, the client reads the board's health. The run relays only when health lists
   `bun-console` under `codecs.view`. On an older board, with no run opened, or under `--no-lifecycle`, the run is exactly
   as today: no relay, today's narration, today's close. Nothing is refused, since the view is optional.
2. **The total.** The run start carries `total` only when the scan covers what runs:
   - the client's own `bun test`, with `test`'s targets when it has them (`_prescan_test_total`);
   - no `total` for a declared script, nor for a `--name` filter.
3. **The console file.** The runner's combined output, as `run_streamed` already reads it, is also written to
   `<reports dir>/bun-console.log` *(P3)*. The reports dir's wipe removes the old file first, so a previous run's console
   is never relayed. A `StreamRelay` (CR-CRU-224 §S2) follows the file with codec `bun-console`.
4. **The relay stops on every exit.** It is finished (bounded) before every close and stopped on every other exit:
   - the JUnit close;
   - the compile close when no JUnit was written;
   - `emit_ran_nothing`, `_emit_filter_ran_nothing` and `_emit_filter_uncounted`;
   - the starved no-report exit;
   - `RunAbandoned` on a signal.

   The record of each is unchanged.
5. **Failures never fail the run.** A relay failure is said once on stderr, and never changes the run or its exit.
6. **Narration and liveness** (pre-review F1):
   - while the relay is live, the narrator posts no in-run `running N/M`, because the relay's batches and quiet touches
     keep the agent alive;
   - once the relay stops (a refusal, a cut, an error), the narrator goes back to its `running N/M` ticks, so the run
     is never swept as `agent died`;
   - the closing `ran N/M` and `ingesting…` are posted as today;
   - an unrelayed run narrates as today.

### §S5 — the record of the design, and the close-out

- **The PRD:**
  - §4.4 names `bun-console` as a view codec in its own registry, the run start's `total`, and drops "registered with
    `stream: true`" for the kinds;
  - §3.3 states that an abort or the sweep decodes only a RECORD stream.
- **The DN:**
  - its console-only row names CR-CRU-201's view codec;
  - its Design layer 1 says the client relays the whole console and the board reads the result lines;
  - the "Playwright's steps … are CR-CRU-201's" sentence moves to CR-CRU-225, as that CR plans, with its pin in
    `tests/docs-live-test-stream-design-record.test.ts`.
- **Schema:** migration v22 adds `runs.total` and `run_live.reader_state`. `docs/RUNBOOK.md`'s schema figures follow.
- **The local API doc:** `.lavish/crucible-server-api.html` (gitignored, not in git) is updated for the start's `total`,
  `codecs.view`, the view stream and the close rule. This is a manual close-out check by the orchestrator; no test reads it.
- **The existing tests that follow** (Rule 16):
  - `tests/health-names-the-codecs-it-decodes.test.ts` (`codecs.view`);
  - `tests/gate-milestone-scope-and-suites.test.ts`'s codec lists;
  - `tests/a-streamed-run-closes-into-its-record.test.ts` (`stream: true` and its probe codec);
  - `tests/crucible-events-codec-reads-the-event-shape.test.ts` ("marked stream: true…");
  - `tests/run-stream-tables-migrate-in-and-die-with-their-project.test.ts` (schema version 21 → 22).

  A test edit that changes what a test asserts is the orchestrator's ruling, in its own commit.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-measured and re-recorded once
  each, in their own commits.

### Dog-food (Rule 21)

- **The order.** The client relays only when health lists `bun-console` under `codecs.view`. The board registers it only
  in the build that also has every part of §S1: the view close, the abort check, and the fill routing.
- **During this CR.** The DEV board on :3850 runs develop's code, which has no `codecs.view`. So every run this CR's
  agents and gate file against it is unrelayed, as today. AC5 proves the relay on a scratch board built from the branch.
- **After the merge.** Once the board restarts on the merged code, the bun gate's own `test:unit` and `test:integration`
  relay. F1's fall-back keeps them filing even when the relay stops.

## Acceptance criteria

- [ ] **AC1 — the view registry and the close.**
  - `bun-console` is in the view registry and not in the report registry.
  - Health lists it under `codecs.view`, and leaves `codecs.test` and `codecs.stream` unchanged.
  - Sent as a body report, a raw report, or as any close's codec, it is refused as unknown (400).
  - The stream route takes it under CR-CRU-200's rules: offsets, overlap, gap, the size bound, the codec fixed by the
    first batch, the quiet touch and the throttled frames, each shown for a view stream.
  - A run holding a view stream closes through the JUnit, parsed, compile and raw-report closes. Each stores exactly what
    the same close stores with no stream, and the batches, live state and failures are deleted at settle.
  - A run holding a record stream is still refused those closes (CR-CRU-200).
  - A view-stream run aborted by the abort route or by the sweep stores no tree, no summary and no `incomplete`. Its held
    stream is deleted.
  - `fillRunLive` is the one caller of `fill`, and a `crucible-events` stream fills exactly as before.
- [ ] **AC2 — the start's total.**
  - `POST /api/v2/runs/start` stores an integer `total` ≥ 0, and refuses any other value (400, nothing started).
  - `Store#runLive` and the brief answer `total` by §S2's order: a stream's own `run-start` first; never below
    `completed`; 0 as none. `public/app.js`'s live count text shows it.
  - An open run with a start total and no batch answers `/live` 404.
  - Migration v22 adds `runs.total` and `run_live.reader_state`, and RUNBOOK's figures read v22.
- [ ] **AC3 — the codec reads bun's console.** On captured bun console text, sent in batches that split a line and split a
  detail block from its `(fail)` line:
  - **the forms:** the coloured form (`✓ ✗ » ✎`), the plain form (`(pass) (fail) (skip) (todo)`), and a CRLF capture;
  - **the live state:** the counts, `currentFile` and failures (name, suite, file, first message line, and the fallback
    id with its `n`) are what §S3 states;
  - **a load-error block** is one failure with its file;
  - **a block whose echo names another test** marries no one;
  - **a long tail with no result line,** over many batches, never re-reads a decoded byte, and its reader state stays
    within `TRACE_LIMIT`;
  - **the shared reader:** the marriage and load-error readers are shared with the JUnit raw-output reading; a source
    check proves it, on synthetic sources both ways.
- [ ] **AC4 — the client relays.** Run through the bun client against a stub board:
  - **Which runs relay:** the client's own `bun test` (`test`, and `regression` with no script) and a declared script
    with no report declaration relay; a script with an env report path or a raw report does not.
  - **The total:** the run start carries the prescanned `total` for the client's own `bun test`, and none for a declared
    script or a `--name` filter.
  - **No relay:** a board without `codecs.view`, no `runId`, or `--no-lifecycle` runs exactly as today.
  - **The wipe:** removes an old `bun-console.log` before the run.
  - **Every exit:** each exit in §S4 step 4 stops the relay, and nothing is posted to the run after its close.
  - **A relay failure:** said once on stderr, and never changes the run's exit.
  - **Narration:** a relayed run posts no `running N/M` while the relay is live, and posts `ran N/M` and `ingesting…`.
  - **A relay stopped mid-run:** the narrator's ticks resume, and the run still files its JUnit record.
- [ ] **AC5 — on the board while it runs.** A real `bun test` run through the real bun client, against a scratch board
  built from this branch, on a fixture whose tests wait on one another. While the run works:
  - the open run's `/live` `completed` rises batch by batch;
  - a failure shows with its name, file and message before the run ends;
  - `total` is the scan's count.

  The stored run equals the same tests' JUnit run filed with no relay, on summary counts, statuses and leaf names
  (ids, timestamps and durations aside).
- [ ] **AC6 — the design record and the guards.**
  - PRD §4.4 and §3.3, and the DN, read as §S5 states.
  - The existing tests §S5 names follow it.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC7 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in
  their own commits.

## Non-goals

- **A structured stream from `bun test` itself:** it has no reporter API.
- **Live views for declared Vitest or Playwright scripts:** CR-CRU-225 gives them a structured stream. This CR relays
  only bun's own console.
- **The declaration table and the shipped reporters** (CR-CRU-225).
- **The clean break and the `playwright` codec's retirement** (CR-CRU-226).
- **A declared regression runner** (CR-CRU-222). Its runs relay by §S4's rule as written.
- **Maven's console live view** (CR-CRU-203), which adds a second view codec to this CR's registry.
- **Data-carrying SSE frames**, and any change to `/api/stream`.
