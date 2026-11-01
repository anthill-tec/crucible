# DN — a run reports its progress test by test

**Status** settled with the user 2026-10-20 · **Lands in** CR-CRU-200 to CR-CRU-203 (0.4.0) · **Applies to** every
stack; proven first on bun / TypeScript (bun test, Vitest, Playwright), then rust (nextest), python,
maven, arduino, go.

## What happens today

A run's live progress is a count, not data.

- Each client feeds its runner's console output, line by line, to a shared narrator that counts lines
  matching one stack-specific pattern (bun's `(pass)`/`(fail)` or ✓/✗, nextest's human result lines,
  maven's per-class lines). The total comes from the runner's own start line (nextest) or from
  scanning test sources for `test(`/`it(` calls (bun).
- A throttled heartbeat carries the text `running N/M · <file>` to the board, which shows it on the
  agent's card. The board learns no test name, status or failure until the final report arrives.
- Any runner the pattern does not know narrates nothing: a Vitest run through a declared script
  (measured), and almost certainly Playwright (unmeasured).
- `crucible.rawReport` names the runner's full report that the board decodes (Playwright's JSON,
  which keeps every Gherkin step JUnit drops). "Raw" misnames it: it is the most decoded report the
  run has.

## What each runner can stream

| Stack | Runner | Live, structured, per test |
|---|---|---|
| bun / TS | `bun test` 1.4 | none: reporters are `junit` (at exit) and `dots`; its console result lines carry each test's name and status |
| bun / TS | Vitest 5 | a reporter API (`onTestRunStart`, `onTestCaseResult`, `onTestModuleEnd`, `onTestRunEnd`) |
| bun / TS | Playwright | a reporter API (`onBegin` with the total, `onTestBegin`, `onTestEnd`, `onStepEnd`, `onEnd`) |
| rust | cargo-nextest 0.9 | native: `--message-format libtest-json` / `libtest-json-plus` (marked experimental) |
| python | Crucible's own `subtest_runner.py` | ours to emit |
| go | `go test -json` | native, stable |
| maven | surefire | none built in (a JUnit Platform listener would be one); console lines per class |
| arduino | native g++ harness | ours to emit |

## The design

Three layers, the same for every stack.

1. **Source.** While the runner works, an event stream is written to a file the client names through
   an environment variable (the `env:<VAR>` mechanism `reportPath` already uses), so it never mixes
   with console output. Where the runner has no structured stream, the source is its console: the
   client relays the whole console as written, and the board reads the result lines from it
   (CR-CRU-201's `bun-console` view codec for `bun test`).
2. **Relay.** The client follows the stream and sends it, in throttled batches, to the run it opened
   at start. It sends the stream as written; it decodes nothing.
3. **Board.** The board decodes each batch with the codec the stream declares, keeps the open run's
   live state (completed of total, current file, every failure as it happens), and pushes it over
   the live feed.

### The stream is the record (user ruling)

Where a runner streams structured events, the stream file **is** the run's record; no final test
report is read.

- **Delivery.** The live batches are best-effort, but the stream is written to a file first. At
  close the client sends whatever the board has not acknowledged, so the board holds the whole file:
  the record is JUnit's equal, written one test at a time instead of at exit.
- **Completeness.** A run-end event carries the runner's own totals. The board checks the tests it
  holds against them; a mismatch flags the run instead of being trusted.
- **Where the stream is console only** (`bun test`, maven's surefire), the console lines give the
  live view and the JUnit report stays the record: bun's console failures are free text, with no
  structured message, type or trace.
- **Coverage** (lcov, coverage.py, JaCoCo, llvm-cov) is known only at exit and stays a final report
  on every stack.
- **Playwright:** the shipped reporter streams each scenario as one test, and its Gherkin steps ride
  inside that scenario's `test-end` (`steps`), so its JSON report is no longer needed, and the board's
  `playwright` codec retires once nothing declares it.

| Source | The record | The live view |
|---|---|---|
| Structured stream: Vitest and Playwright (shipped reporters), nextest libtest JSON, go `-json`, the python and arduino runners Crucible owns | the stream file | the same stream, as it is written |
| Console only: `bun test`, maven | the JUnit report | the console result lines, read on the board by a view codec (`bun test`'s by CR-CRU-201's `bun-console`) |

### Event format (user ruling)

- **One Crucible event shape**, newline-delimited JSON: a run-start event carrying the total when the
  runner knows it, and a test-end event per test (id, name, file, status, duration, failure). The
  reporters Crucible ships and the runners Crucible owns emit it directly, decoded on the board by
  one `crucible-events` codec.
- **Native streams keep their own codecs:** nextest's libtest JSON, go's `test2json`, bun's console
  result lines (`bun-console`). Each format is decoded once, on the board.

### Reporters (user ruling)

- The Vitest and Playwright reporters that emit the Crucible shape ship **inside the client
  install**, beside the clients.
- The project's config never names a machine path: the client hands the reporter's location to the
  runner through a variable Crucible fixes, and the project's `vitest.config` / `playwright.config`
  adds the reporter from that variable when it is set. The same config runs unchanged with no
  client (CI, a developer's shell).

### Declaration (user ruling: one table per script, clean break)

A bun project declares, per `package.json` script, one table:

```json
"crucible": {
  "targets": {
    "test:e2e":  { "framework": "playwright-bdd", "stream": { "codec": "crucible-events", "path": "env:CRUCIBLE_STREAM" } },
    "test:unit": { "framework": "bun-test", "junit": "flag", "console": "bun-console", "coverage": "lcov" }
  }
}
```

- **The modality is the script's name** (CR-CRU-225): a project selects its codecs by the testing tools of each
  test modality it runs (unit, regression, and BDD where needed), and the modality is read from the script's name by
  the template the client already reads (`test:<tier>`). The table does not restate it.
- `framework` is required: the test framework the script runs, which the run carries to the board. For bun it is one
  of `bun-test`, `vitest`, `playwright` and `playwright-bdd`; `pytest`, `unittest`, `nextest`, `surefire`, `go-test`
  and `arduino-native` are reserved for the other stacks (CR-CRU-225 P1). A script with no entry runs as `bun-test`.
- `coverage` is optional: the coverage codec the client sends, refused unless the target can produce it (for bun,
  `lcov` on a `junit: flag` target with framework `bun-test`). Undeclared, it is `lcov`, as before.
- **Model B writes the table** (the Model B contract): modelb-axi's `init` offers the tools per modality for the
  selected stacks and writes the table; `migrate` detects a legacy project's tools and older keys, proposes a table
  and confirms it with the user; `update` brings an older table to the current shape.
- A target declares **either** a structured `stream` (its record and its live view) **or** a
  `junit` report (its record), optionally with the `console` codec that reads its live view.
- `stream` is new: the event codec and how the runner is told where to write the file.
- `junit` replaces `crucible.reportPath.<script>` (`flag` or `env:<VAR>`).
- `crucible.rawReport` has no successor: its only use, Playwright's step-keeping JSON, is replaced
  by the stream.
- An undeclared target keeps today's default: `bun test` with the `flag` JUnit report and the bun
  console view.
- **Clean break:** `crucible.reportPath` and `crucible.rawReport` are refused, with a message naming
  the table that replaces them, as `--phase` was when it became `--role`.
- The other stacks declare the same three facts in their own place (`crucible.toml` for cargo,
  python, maven, arduino, go); the vocabulary is the same.
- **Python unittest declares no stream** (CR-CRU-224 amends this paragraph for that case): its
  runner is Crucible's own (`clients/subtest_runner.py`), which always writes the
  `crucible-events` stream to the file `CRUCIBLE_STREAM` names, so there is nothing to declare.

### Totals

The run-start event carries the runner's own total where it has one (Playwright's `onBegin`,
nextest's start, go's list). bun keeps its source scan, which already excludes nothing it should
count.

Vitest's `run-start` states no total (CR-CRU-225 P9): its `onTestRunStart` receives only the files,
before anything is collected, so the live view shows a count with no total until the run ends.

## Where it lands (user ruling)

In 0.4.0, wave 8, after CR-CRU-152 moves every stack's report decoding onto the board (user ruling:
split by available number, all in the current wave, the date unchanged). CR-CRU-200 was split by layer at its gap analysis
(user ruling 2026-10-30): the board's live view first, CR-CRU-223; then the board, CR-CRU-200; then the client,
CR-CRU-224:

| CR | Lands | Depends on |
|---|---|---|
| CR-CRU-223 | the board's live view (storyboard F25, option A): the running card's progress, the live drill-in at `/run/<runId>`, the `RunLive` contract, `Store#runLive`'s signature, the open-run brief's `live` and the `/live` route | — |
| CR-CRU-200 | the stream route, the `crucible-events` codec, the stream as the record and its completeness check, the body of `Store#runLive` and the change frames that move the live view | 152, 206, 219, 220, 223 |
| CR-CRU-224 | the python client relays its runner's test stream; proven on the python runner Crucible owns | 200 |
| CR-CRU-201 | bun's console live view: the board's view-only stream mode and the `bun-console` codec; the JUnit report stays the record (split 2026-10-31, user ruling) | 200, 224 |
| CR-CRU-225 | the `crucible.targets` table declares each script's framework, record, console and coverage; the run carries its framework; the shipped Vitest reporter streams the Crucible shape | 200, 224, 201 |
| CR-CRU-228 | the shipped Playwright reporter streams each scenario as a test with its steps; the specification view reads it (split from 225, 2026-11-01, user ruling) | 225 |
| CR-CRU-226 | the clean break: `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` refused; Playwright's JSON report and codec retire | 225, 228 |
| CR-CRU-202 | rust streams through nextest's libtest JSON | 200 |
| CR-CRU-203 | the arduino runner streams; maven's console live view, through CR-CRU-201's view-only mode | 200, 201 |

Go's stream lands with its client (CR-CRU-195), which therefore also depends on CR-CRU-200.

What CR-CRU-200 leaves to later CRs (its non-goals):

- Playwright's steps are in the stored run's record, not in the live state (CR-CRU-228, user ruling 3): an open BDD
  run's live state holds the counts, the current file and the failures, as CR-CRU-200's does for any stream.
- A stream that only feeds the view, and is never the run's record (`bun-console`, maven's console), is CR-CRU-201's
  and CR-CRU-203's to define, with its codec.

## Open for CR-CRU-200's gap analysis

- The board's live view — settled (storyboard F25, option A; CR-CRU-223): the running card
  (`RunningCard`) shows the open run's progress and opens the run detail's live mode (`LiveRunBody`) at
  `/run/<runId>`, which reads `GET /api/v2/runs/<runId>/live` (`handleRunLive`) through `Store#runLive`.
- nextest's libtest JSON is marked experimental: measure what it needs to run and how stable it is.
- How often the relay sends, and what the board keeps of a stream once the final report closes the
  run.
- Maven's source: a shipped JUnit Platform listener, or its console lines.
