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
   with console output. Where the runner has no structured stream, the source is its console result
   lines, which the client already reads.
2. **Relay.** The client follows the stream and sends it, in throttled batches, to the run it opened
   at start. It sends the stream as written; it decodes nothing.
3. **Board.** The board decodes each batch with the codec the stream declares, keeps the open run's
   live state (completed of total, current file, every failure as it happens, Playwright's steps),
   and pushes it over the live feed.

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
- **Playwright:** the shipped reporter emits each Gherkin step as an event, so its JSON report is no
  longer needed, and the board's `playwright` codec retires once nothing declares it.

| Source | The record | The live view |
|---|---|---|
| Structured stream: Vitest and Playwright (shipped reporters), nextest libtest JSON, go `-json`, the python and arduino runners Crucible owns | the stream file | the same stream, as it is written |
| Console only: `bun test`, maven | the JUnit report | the console result lines |

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
    "test:e2e":  { "stream": { "codec": "crucible-events", "path": "env:CRUCIBLE_STREAM" } },
    "test:unit": { "junit": "flag", "console": "bun-console" }
  }
}
```

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

### Totals

The run-start event carries the runner's own total where it has one (Vitest's collected tests,
Playwright's `onBegin`, nextest's start, go's list). bun keeps its source scan, which already
excludes nothing it should count.

## Where it lands (user ruling)

In 0.4.0, wave 8, after CR-CRU-152 moves every stack's report decoding onto the board (user ruling:
split by available number, all in the current wave, the date unchanged):

| CR | Lands | Depends on |
|---|---|---|
| CR-CRU-200 | the stream route, the `crucible-events` codec, the client relay, the stream as the record and its completeness check, the board's live view; proven on the python runner Crucible owns | 152 |
| CR-CRU-201 | bun's one-table declaration (clean break), the `bun-console` codec, the shipped Vitest and Playwright reporters; Playwright's JSON report and codec retire | 200 |
| CR-CRU-202 | rust streams through nextest's libtest JSON | 200 |
| CR-CRU-203 | the arduino runner streams; maven's console live view | 200 |

Go's stream lands with its client (CR-CRU-195), which therefore also depends on CR-CRU-200.

## Open for CR-CRU-200's gap analysis

- The board's live view: where the open run's progress and early failures show (a storyboard frame
  before RED).
- nextest's libtest JSON is marked experimental: measure what it needs to run and how stable it is.
- How often the relay sends, and what the board keeps of a stream once the final report closes the
  run.
- Maven's source: a shipped JUnit Platform listener, or its console lines.
