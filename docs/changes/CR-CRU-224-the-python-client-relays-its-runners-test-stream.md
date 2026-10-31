# CR-CRU-224 — the python client relays its runner's test stream

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status** PENDING
- **Filed 2026-10-30.** Split from CR-CRU-200 at its gap analysis. User ruling: split by layer — the live view (CR-CRU-223),
  the board (CR-CRU-200), then this CR, the client. pytest keeps its JUnit record.
- **Gap analysis 2026-10-31, after CR-CRU-200 merged (Rule 20).** Re-scored from 8 to 13 points. User rulings:
  - a unittest run's JUnit report is dropped, not kept as a fallback;
  - xmlrunner leaves the python client entirely;
  - the live total is unittest's `countTestCases()`;
  - a streamed run keeps the narrator's closing messages and sends no in-run count.

**Pre-review: due** — the CR scores 13 points, its gap analysis needed rulings from the user, and it changes another project's
surface (the shipped client and its installer).

**PROPOSED, awaiting the user's ruling** (Rule 19). The gap analysis chose these; each is marked *(proposed)* where the steps
state it:
- **P1:** a unittest run that cannot stream refuses before the suite is spawned, and nothing runs. That covers a board that
  doesn't decode `crucible-events` and a run the board did not open.
- **P2:** the relay sends whole lines only. A last line with no newline goes at close.
- **P3:** `RELAY_SECONDS` is 2.0, the board's `LIVE_FRAME_MS` and the narrator's cadence.
- **P4:** the stream file is `<reports dir>/crucible-events.ndjson`, named to the runner through `CRUCIBLE_STREAM`.

## Problem

Once the board takes a test stream on an open run and keeps it as the run's record (CR-CRU-200), something has to write the
stream and send it. `DN-crucible-live-test-progress.md` settles both:
- the runner writes the Crucible event shape to a file the client names through an environment variable;
- a shared client relay follows the file and sends it, as written, in throttled batches, to the run the client opened.

The python client's own unittest runner (`clients/subtest_runner.py`) is the runner Crucible owns, so it is where the stream is
proven first.

## Design (user rulings 2026-10-20, 2026-10-30 and 2026-10-31)

- **The runner Crucible owns writes the stream.**
  - `subtest_runner.py` runs plain `unittest`, counting every subtest as CR-CRU-189 counts them, and writes one Crucible event
    per counted case to the file `CRUCIBLE_STREAM` names.
  - It no longer uses xmlrunner and writes no JUnit report.
  - xmlrunner leaves the python client and its install.
- **The relay decodes nothing.** It follows the stream file, sends what was written since the last batch, in throttled batches,
  to the open run. At close it sends whatever the board has not acknowledged before closing the run.
- **The relay is shared**, in the run module (`clients/_crucible_run.py`), for every stack's client to use as its runner gains
  a stream (CR-CRU-201 to CR-CRU-203).
- **A unittest run's record is its stream.** There is no JUnit fallback. A pytest run keeps its JUnit report and its
  narration, as today.
- **Narration for a streamed run:** no in-run count (the board shows the stream's count); the closing `ran N/N` and
  `ingesting…` messages stay.

## Steps

### §S1 — the runner writes the stream

`clients/subtest_runner.py` runs `unittest`, not xmlrunner.
- **Its command line:** `discover -s <dir> -p <pattern> -v`, or dotted targets, plus `-v`. `-o <reports>` is gone.
- **Its result:** a subclass of `unittest.TextTestResult`, so the console still prints unittest's verbose verdict lines, which
  the narrator's closing count reads.
- **Its exit code:** 0 when the run was successful, else 1, as `unittest` exits.

**The counting rule is CR-CRU-189's, unchanged:**
- a passing subtest is its own case;
- a parent is counted as its subtests once one was recorded;
- an enclosing subtest is counted like a parent;
- a parent that fails or errors in its body or `tearDown` is still a case of its own;
- a test under `@expectedFailure` is counted as a whole.

**With `CRUCIBLE_STREAM` set,** the runner writes CR-CRU-200's event shape to that file, one line per event, flushed as each is
written:
- **`run-start`:** at `startTestRun`, with `total` set to the suite's `countTestCases()`. That is a lower bound once subtests
  count; the view caps the bar (CR-CRU-223).
- **`test-end`:** one per counted case.
  - **Identity:** `id` is the test's `id()`, or its subtest's `id()`. `name` and `suite` are named exactly as the JUnit report
    named that case (`name` its test name, `suite` its `module.Class`).
  - **Location:** `file` is the module's source file relative to the working directory, with `\` read as `/`.
  - **`status`:**

    | Outcome | `status` |
    |---|---|
    | success | `pass` |
    | expected failure | `pass` |
    | failure | `fail` |
    | error | `fail` |
    | unexpected success | `fail` |
    | skip | `pending` |

  - **`duration_ms`:** the case's own time.
  - **`failure`:** for a failing case, `{message, type, trace}`, read as the JUnit report read them: `type` the exception's
    class name, `message` its text, `trace` the formatted traceback. A skip's reason is not a failure.
- **`run-end`:** at `stopTestRun`, with the run's `total`, `passed`, `failed`, `pending` and `duration_ms`.

Without `CRUCIBLE_STREAM` the runner writes no stream and runs as before.

### §S2 — the shared relay

`clients/_crucible_run.py` gains a stream relay that every stack's client can use.

**What it is given:**
- the post function, the project key, the agent id and the run id;
- the stream file;
- the codec (`crucible-events`);
- the batch byte limit, the board's `limits.ingest_body_bytes` from health, less the batch's envelope.

**While the runner works,** a background thread wakes every `RELAY_SECONDS` *(proposed, P3)*:
- It reads the file past `held`, the bytes the board has acknowledged, and sends the whole lines found *(proposed, P2)* to
  `POST /api/v2/runs/<runId>/stream` as `{projectKey, agentId, codec, from: held, data}`, in batches within the byte limit.
- **The answer moves the relay on:**
  - the board's `held` becomes the relay's;
  - a 409 carrying `held` (a gap, or a differing overlap) resends from that `held`;
  - a 413 for the stream's total stops all further sending: the board records the cut, and the run's record says so.
- **A failure is never fatal:** any other failure (unreachable, a 5xx) is retried on the next tick. It is said once on
  stderr, and never fails the run.

**At close** (`finish`):
1. stop the thread;
2. send everything not yet acknowledged, the last line included even without a newline, under the same rules;
3. answer whether the board holds any of the stream.

**On an interrupt** the thread stops, and the run is handled as an abandoned run is today.

### §S3 — the python client streams a unittest run

**For a unittest run with `--agent`** (`test`, the tier verbs, `regression`, `pre-merge-gate`):
1. **Before the suite is spawned:**
   - the client reads the board's health;
   - it needs the board to decode `crucible-events` and to have opened the run (`open_run` answered a `runId`);
   - otherwise it refuses before spawning, nothing runs, and the envelope says why *(proposed, P1)*. A board too old names its
     version and the version floor, as the ingest's refusal does today.
2. **The run:** the client sets `CRUCIBLE_STREAM` to `<reports dir>/crucible-events.ndjson` *(proposed, P4)* in the runner's
   environment, after wiping the reports dir as today, starts the relay, and spawns the runner.
3. **After the runner exits,** the client runs the relay's `finish`:
   - **The board holds stream bytes:** the run closes through CR-CRU-200's stream close, `POST /api/v2/runs` with `runId`,
     `codec: "crucible-events"`, no `data`, and the `coverage`, `raw`, `tier`, `context`, `release` and `runnerExit` the
     JUnit ingest sent.
     - The board's answer prints the ingest line, and the envelope is built from it as today, a `stream-incomplete` warning
       riding it.
     - The exit is `verb_exit(runner_exit, response)`.
   - **The board holds no stream:** the runner wrote nothing, for example when it crashed before `startTestRun`. Today's
     no-report path then ingests the captured output as a compile failure, unchanged.
4. **The "ran nothing" decision is the client's own,** made locally from the stream file: the count of its `test-end` lines,
   each read as JSON. This is the one place the client reads the stream; the relay itself decodes nothing.

**Narration:** the narrator observes the output but sends no in-run `running N` count for a streamed run. Its closing
`ran N/N` and `ingesting…` are posted, as today.

**Unchanged paths:**
- a run without `--agent` sets no stream, runs the suite and files nothing, as today;
- a pytest run is unchanged: JUnit report, narration, `subtests-uncounted`;
- `auto-ingest` (a pre-existing JUnit dir) is unchanged.

### §S4 — xmlrunner leaves the python client

- **The runner:** `subtest_runner.py` imports nothing from xmlrunner.
  - Its fallback path is removed, along with `FALLBACK_SIGNAL` and the "No module named xmlrunner" exit.
  - The client's unittest `subtests-uncounted` warning (`_FallbackWatch`'s unittest branch) is removed. pytest's stays.
- **The client:** `_xmlrunner_cmd` is replaced by the runner's new command line. Every user-facing text naming xmlrunner for a
  unittest run is reworded, without it:
  - the module docstring;
  - the `--python` help;
  - the runner label in `[crucible] … exit=`;
  - `_no_xml_errors_text`;
  - `_no_report_subject`.
- **Packaging:** `pyproject.toml`'s `dev` group drops `unittest-xml-reporting` and its comment block. `crucible_axi/install.py`'s
  comment follows.
- **Docs:** the PRD's ingest paragraph (§4.4) and the DN client-fleet inventory name the stream for python unittest.

### §S5 — the client suite follows

Every client test that drives a unittest run through xmlrunner, or pins its JUnit path, is moved to the stream or retired when
it pins removed behaviour:
- the fallback signal;
- xmlrunner's absence;
- the per-class `TEST-*.xml` reports of a unittest run.

The gap analysis counted 30 test files under `tests/client/` naming xmlrunner. Each one is listed in the RED cycle's report,
with what became of it.

### §S6 — the close-out

- **`SHARED_MODULE_LINE_BUDGETS`** for `_crucible_run.py` (and `_crucible_axi.py`, if touched) are re-measured and re-recorded
  once, in their own commit.
- **`PROSE_CITATIONS`** heads are re-measured and re-recorded once, in their own commit.

## Acceptance criteria

- [ ] **AC1 — the runner writes the stream.** A committed fixture project, `tests/fixtures/unittest-project`, holds cases that
  pass, fail, error, are skipped, are expected to fail, succeed unexpectedly, fail in `tearDown`, and have passing, failing and
  nested subtests.
  - **Its stream:** run through the new runner, it writes one `run-start` (`total` = `countTestCases()`), one `test-end` per
    case CR-CRU-189 counts, and one `run-end`.
  - **Its fields:** each `test-end`'s `name`, `suite`, `file`, `status`, `duration_ms` (≥ 0) and `failure` match the case as
    stated in `tests/fixtures/unittest-project/expected.json`. That file is frozen from the JUnit path, before it is removed.
  - **Flushing:** a line is in the file before the next test starts.
  - **xmlrunner gone:** the runner runs under an interpreter that cannot import xmlrunner, and its source imports none.
- [ ] **AC2 — the stream equals the JUnit record.** Both are asserted before the JUnit path is removed:
  - **Real run:** `tests/client` is run through the python client twice against the DEV board, through the JUnit path and
    through the stream. The two stored runs have equal summaries, and equal trees as `run` reads them back. The runs are named
    in the cycle's report.
  - **Fixture:** the fixture project's stream-decoded run equals its JUnit-decoded run, and that expectation is frozen into
    `expected.json`, which AC1 then pins.
- [ ] **AC3 — tests reach the board while the run works.** The real python client and the real runner, against a scratch board
  (`tests/client/real_board.py`), run a suite whose tests wait on one another. The open run's `GET /api/v2/runs/<runId>/live`
  shows each finished test and each failure before the run ends.
- [ ] **AC4 — the relay.** Driven through its post function:
  - it sends whole lines only, from `held`, within the byte limit;
  - a 409's `held` moves the next `from`;
  - a 413 stops sending;
  - a failing post is said once on stderr and retried, never failing the run;
  - `finish` stops the thread and sends what the board never acknowledged, including a batch the board refused while the run
    worked and a last line without a newline;
  - `RELAY_SECONDS` is one named constant.
- [ ] **AC5 — the close.** A streamed unittest run closes through `POST /api/v2/runs` with `runId`, `codec: "crucible-events"`
  and no `data`, carrying `coverage`, `raw`, `tier`, `context`, `release` and `runnerExit` as the JUnit ingest did.
  - **The envelope:** it states the board's filed run, carries `stream-incomplete` when the board answers it, and exits by
    `verb_exit`.
  - **No stream held:** a runner that wrote no stream is ingested as a compile failure, as today.
  - **Ran nothing:** this is decided from the stream's `test-end` count.
  - **Every verb:** this holds for `test`, a tier verb, `regression` and `pre-merge-gate`.
- [ ] **AC6 — refusing before the run.** With `--agent`, a unittest run refuses before the suite is spawned, and nothing runs,
  when:
  - the board's health lists no `crucible-events`; the envelope names the board's version and the floor;
  - `open_run` answers no `runId`.
- [ ] **AC7 — an interrupted or killed run.**
  - A run interrupted before its first test leaves the open run aborted, as today.
  - A run interrupted after some tests leaves it aborted with those tests (CR-CRU-200).
  - The relay's thread is stopped on every exit.
- [ ] **AC8 — narration.** A streamed run posts no `running N` heartbeat, and posts `ran N/N` then `ingesting…` before its
  close. A pytest run narrates exactly as today.
- [ ] **AC9 — pytest and auto-ingest are unchanged.** A pytest run is filed from its JUnit report, with its narration and its
  `subtests-uncounted` warning. `auto-ingest` files a JUnit dir as today.
- [ ] **AC10 — xmlrunner is gone.**
  - No file under `clients/` or `crucible_axi/` imports or runs xmlrunner.
  - `pyproject.toml` does not list `unittest-xml-reporting`.
  - The python client's help and messages for a unittest run do not name it.
  - The unittest `subtests-uncounted` warning and the runner's fallback signal are gone.
  - The PRD §4.4 and the DN client-fleet inventory name the stream for python unittest.
- [ ] **AC11 — the client suite.** Each of the 30 `tests/client/` files naming xmlrunner is moved to the stream or retired, as
  listed in RED's report. The python client suite passes through the pre-merge gate, its own run now streamed to the board.
- [ ] **AC12 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-measured and re-recorded,
  each once, in their own commits. `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.

## Non-goals

- **The board's side** (CR-CRU-200) and **its view** (CR-CRU-223).
- **Other streams:** any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195), and a pytest stream.
- **A JUnit fallback for unittest** (user ruling 2026-10-31).
- **The relay's use by the other clients**, which comes with their streams.
