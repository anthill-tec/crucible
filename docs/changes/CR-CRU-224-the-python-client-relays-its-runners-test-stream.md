# CR-CRU-224 — the python client relays its runner's test stream

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status** PENDING
- **Filed 2026-10-30.** Split from CR-CRU-200 at its gap analysis. User ruling: split by layer — the live view (CR-CRU-223),
  the board (CR-CRU-200), then this CR, the client. pytest keeps its JUnit record.
- **Gap analysis 2026-10-31, after CR-CRU-200 merged (Rule 20).** Re-scored from 8 to 13 points. User rulings:
  - a unittest run's JUnit report is dropped, not kept as a fallback;
  - xmlrunner leaves the python client entirely;
  - the live total is unittest's `countTestCases()`;
  - a streamed run keeps the narrator's closing messages and sends no in-run count.
- **Spec pre-review 2026-10-31 (`CR-CRU-224-SPEC-REVIEW`).** F1–F18 are folded in. User rulings:
  - a stream the board flags incomplete makes the verb exit non-zero, the gate included (F15);
  - when the board opens no run, or can't be reached, the suite still runs and files nothing (P1);
  - the relay sends up to the last whole UTF-8 character, not whole lines only (P2).

**Pre-review: ran** — the CR scores 13 points, its gap analysis needed rulings from the user, and it changes the shipped
client's surface.

**P1–P4, approved by the user 2026-10-31** with the CR (Rule 19):
- **P1:** two outcomes.
  - A board that does not decode `crucible-events` refuses the run before the suite is spawned. Health is read before
    `open_run`, so no run is left open.
  - When no run is opened or the board can't be reached, the suite runs and nothing is filed (the user's ruling).
- **P2:** batches end at the last complete UTF-8 character (the user's ruling).
- **P3:** `RELAY_SECONDS` is 2.0, the board's `LIVE_FRAME_MS` and the narrator's cadence.
- **P4:** the stream file is `<reports dir>/crucible-events.ndjson`, named to the runner through `CRUCIBLE_STREAM` and removed
  by the reports dir's wipe.

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
  - Python unittest needs no stream declaration: its runner is Crucible's own. That amends the DN's declaration paragraph for
    this case.
- **The relay decodes nothing.** It follows the stream file and sends what was written since the last batch, in throttled
  batches, to the open run. At close it sends whatever the board has not acknowledged before closing the run. Counting tests
  is the client's job, never the relay's.
- **The relay is shared**, in the run module (`clients/_crucible_run.py`), for every stack's client to use as its runner gains
  a stream (CR-CRU-201 to CR-CRU-203).
- **A unittest run's record is its stream.**
  - There is no JUnit fallback.
  - A record the board flags incomplete never exits green.
  - A pytest run keeps its JUnit report and its narration, as today.
- **Narration for a streamed run:** no in-run count (the board shows the stream's count). The closing `ran N/N` (counted from
  the stream) and `ingesting…` stay.

## Steps

### §S1 — the runner writes the stream

**What it runs.** `clients/subtest_runner.py` runs `unittest` through a `unittest.TextTestRunner`, with a subclass of
`unittest.TextTestResult`, not xmlrunner.
- **Its command line:** `discover -s <dir> -p <pattern> -v`, or dotted targets plus `-v`. `-o <reports>` is gone.
- **Its exit code:**

  | Outcome | Exit |
  |---|---|
  | success | 0 |
  | no test ran | 5 |
  | anything else | 1 |

  These are `unittest`'s own codes. The interpreter running it needs Python 3.12 or later, for `unittest`'s exit 5 and
  `addDuration`.
- **Its console:** it prints one verbose verdict line per counted case, passing subtests included, so the console reads as it
  read under xmlrunner.

**The counting rule is CR-CRU-189's, unchanged:**
- a passing subtest is its own case;
- a parent is counted as its subtests once one was recorded;
- an enclosing subtest is counted like a parent;
- a parent that fails or errors in its body or `tearDown` is still a case of its own;
- a test under `@expectedFailure` is counted as a whole.

**The stream.** The runner reads `CRUCIBLE_STREAM`, then removes it from its own `os.environ` before any test runs, so no test
or nested run inherits it. With it set, the runner:
- opens the file it names in truncate mode;
- writes CR-CRU-200's event shape, one JSON object per line;
- encodes each line with `json.dumps` at its default `ensure_ascii`, so any text — a lone surrogate included — is written;
- flushes each line as it is written.

**The events:**
- **`run-start`:** at `startTestRun`, with `total` set to the suite's `countTestCases()`.
  - That is the runner's own count, not a bound. Counted subtests can take the completed count above it, and a `setUpClass` or
    `setUpModule` error can leave it below.
  - `run-end` states the truth (CR-CRU-223's bar is capped at 100 %).
- **`test-end`:** one per counted case, with these fields.
  - **`id`:** the test's `id()`, or its subtest's `id()`.
  - **`name`:**
    - a test: its method name;
    - a subtest: the method name followed by the subtest's description;
    - a `setUpClass` / `setUpModule` error or skip (an `_ErrorHolder`): the holder's description;
    - a load error (`_FailedTest`): the module that failed to load.
  - **`suite`:** the case's `module.Class`, with a leading `__main__.` stripped. A load error's suite is its `module.Class`,
    `unittest.loader._FailedTest`.
  - **`file`:** the module's source file, relative to the working directory when it lies under it, else absolute (and absolute
    when no relative path exists), with `\` read as `/`.
  - **`status`:**

    | Outcome | `status` |
    |---|---|
    | success | `pass` |
    | expected failure | `pass` |
    | failure | `fail` |
    | error | `fail` |
    | unexpected success | `fail` |
    | skip | `pending` |

  - **`duration_ms`:**
    - a test: its time as `addDuration` reports it;
    - a subtest: the time since the previous case of the same test ended, or since the test started.
  - **`failure`:** for a failing case, `{message, type, trace}`. `type` is the exception's class name, `message` its text, and
    `trace` the formatted traceback. A skip's reason is not a failure.

  The fixture's frozen `expected.json` (AC1) pins every one of these names, taken from xmlrunner 4.0.0's report of the same
  cases before xmlrunner is removed. Where xmlrunner's suite name carried a `-<timestamp>` suffix, the stream's carries none.
  That is intended: the board's suite names for a python unittest run lose the suffix.
- **`run-end`:** at `stopTestRun`, with `total`, `passed`, `failed` and `pending` equal to the counts of the `test-end` lines
  written, and the run's `duration_ms`.

**A stream write that fails** (`OSError`) is said once on stderr, and the runner stops writing the stream and finishes the
test run. That stream then has no `run-end`, and the board flags it incomplete.

**Without `CRUCIBLE_STREAM`** the runner writes no stream and runs as before.

### §S2 — the shared relay

`clients/_crucible_run.py` gains `StreamRelay(post_fn, project_key, agent_id, run_id, path, codec, batch_limit)`, with
`start()` and `finish(deadline_seconds)`.
- It decodes and counts nothing.
- `batch_limit` is the board's `limits.ingest_body_bytes` from health. When health gives none, it is
  `RELAY_DEFAULT_BATCH_BYTES`, the shipped minimum of `ingest_body_bytes` (1 MiB).

**While the runner works,** a background thread wakes every `RELAY_SECONDS` *(P3)*:
- **Reading:** it reads the file past `held`, the bytes the board has acknowledged.
- **Cutting:** it cuts what it read at the last complete UTF-8 character *(P2)* into batches whose encoded request body
  (`{projectKey, agentId, codec, from: held, data}`, as `json.dumps` sends it) stays within `batch_limit`. A line longer than a
  batch spans batches; the board holds the partial line.
- **Sending:** each batch goes to `POST /api/v2/runs/<runId>/stream`. Each post has a timeout, `RELAY_POST_TIMEOUT_SECONDS`.
- **The answer moves the relay on:**
  - **200:** its `held` becomes the relay's.
  - **409 carrying `held`** (a gap, or a differing overlap): the relay resends from that `held`.
  - **413 carrying `held`** (the stream's total): all further sending stops. The board has recorded the cut, and the record
    says so.
  - **Any other 4xx** (400; 404; a 409 without `held`, such as a settled run or an unregistered caller; a 413 without `held`,
    a body over the limit): all further sending stops, said once on stderr.
  - **Unreachable, a timeout, or a 5xx:** retried on the next tick, said once on stderr, and never fatal to the run.

**`finish(deadline_seconds)`:**
1. It stops the thread and joins it. The join is bounded by the post timeout.
2. It sends everything not yet acknowledged, under the same rules, with up to `RELAY_FINISH_ATTEMPTS` tries per batch before
   the deadline.
3. It confirms the board's `held` with an empty batch at `from: held`.
4. It answers that confirmed `held`, and whether sending stopped and why.

### §S3 — the python client streams a unittest run

**For a unittest run with `--agent`** (`test`, the tier verbs, `regression`, `pre-merge-gate`):

1. **Before the run is opened:** the client reads the board's health.
   - **A board that doesn't decode `crucible-events`:** the client refuses before the run is opened or the suite spawned,
     *(P1)*. The envelope names the board's version and the version floor, and the exit is 1.
   - **A board that can't be reached, or an `open_run` that answers no `runId`:** the suite runs, no stream is set, and nothing
     is filed. The envelope is `ok: false` with the reason, and the exit is 1 unless the runner's exit is already non-zero.
2. **The run:** the client:
   - wipes the reports dir, removing the stream file as well as any report;
   - sets `CRUCIBLE_STREAM` to `<reports dir>/crucible-events.ndjson` *(P4)* in the runner's environment;
   - starts the relay;
   - spawns the runner.

   On every other path, and on every run without `--agent`, the client removes `CRUCIBLE_STREAM` from the child's environment.
3. **After the runner exits,** the client calls `finish` and reads the stream file locally. That is the client's one reading of
   the stream: it counts its `test-end` lines, each read as JSON, and the totals of its `run-end`.
   - **Ran nothing:** `ran_nothing(exit, count)`, or zero discovery (`_is_zero_discovery`, keeping the `no-tests-discovered`
     warning). This is decided first, from the local count. Such a run is aborted with its reason, as today.
   - **No stream at all:** the local file has no `test-end` line, the board's confirmed `held` is 0, and the runner exited
     non-zero. The captured output is ingested as a compile failure, as today's no-report path does.
   - **Otherwise, the stream close:** `POST /api/v2/runs` with `runId`, `codec: "crucible-events"`, no `data`, and `coverage`,
     `raw`, `tier`, `context`, `release` and `runnerExit`.
     - The client prints the ingest line, and builds the envelope from the board's answer as today.
     - A `stream-incomplete` warning rides the envelope.
     - A close the board refuses (a 400) is followed by the client's abort of the run, with the refusal as its reason.
   - **The exit** is `verb_exit(runner_exit, response)`. It is non-zero whenever the answer carries `stream-incomplete`, for
     the gate as for any other verb.
4. **On an interrupt** (`abandon_trap`), the client calls `finish` with a short deadline before the run is aborted. So the board
   keeps every test it acknowledged by then (CR-CRU-200).

**Narration:** the narrator observes the output but posts no in-run `running N` count for a streamed run. Its closing message
is `ran <test-end count>/<run-end total>`, falling back to the count when there is no `run-end`, then `ingesting…`. Both are
posted before the close.

**Unchanged:**
- a run without `--agent` sets no stream, runs the suite and files nothing;
- a pytest run (JUnit report, narration, `subtests-uncounted`);
- `auto-ingest` (a pre-existing JUnit dir).

### §S4 — xmlrunner leaves the python client

- **The runner:** `subtest_runner.py` imports nothing from xmlrunner.
  - Its fallback path, `FALLBACK_SIGNAL` and its "No module named xmlrunner" exit are removed.
  - The client's unittest `subtests-uncounted` warning (`_FallbackWatch`'s unittest branch) is removed. pytest's stays.
- **The client:** `_xmlrunner_cmd` is replaced by the runner's new command line. Every text naming xmlrunner for a unittest run
  is reworded:
  - the module docstring;
  - the `--python` help;
  - the runner label in `[crucible] … exit=`;
  - `_no_xml_errors_text`;
  - `_no_report_subject`.
- **Packaging:** `pyproject.toml`'s `dev` group drops `unittest-xml-reporting` and its comment block. `crucible_axi/install.py`'s
  comment naming `-m xmlrunner` follows.
- **The record of the design:**
  - the PRD's ingest paragraph (§4.4) and the DN client-fleet inventory name the stream for python unittest;
  - the DN records that python unittest declares no stream;
  - `tests/fixtures/reports/README.md` records that the `python/xmlrunner/` fixture stays frozen for the `junit` codec and
    `auto-ingest`, produced before this CR by a runner that no longer writes JUnit.

### §S5 — the test suite follows

Every test file naming xmlrunner (30 across `tests/`) is moved to the stream, kept, or retired, by what it pins:
- **Under `tests/client/` (24 files):** those driving a unittest run through xmlrunner, or pinning its JUnit path, its
  fallback signal or xmlrunner's absence.
- **Outside it (6):** `tests/clients-python-arduino-crucible.test.ts`, `tests/shim-retirement.test.ts`,
  `tests/a-streamed-run-equals-its-junit-record.test.ts`, `tests/real-stack-reports-decode-on-the-board.test.ts`,
  `tests/junit-reading-is-one-rule-for-every-stack.test.ts` and `tests/fixtures/reports/README.md`.
  - The last four keep the frozen `python/xmlrunner/` fixture.
  - The first two drive the python client's `test` verb through a fake xmlrunner and `-o`.

RED's report lists each file and what became of it.

### §S6 — the close-out

- **`SHARED_MODULE_LINE_BUDGETS`** is pinned at three sites:
  - `tests/client/test_arduino_client_sends_its_runners_reports.py`;
  - `tests/client/test_mvn_client_sends_its_runners_reports.py`;
  - `tests/client/test_rust_client_sends_its_runners_reports.py`.

  It is re-measured for `_crucible_run.py`, and for `_crucible_axi.py` if touched, and re-recorded at all three sites once, in
  one commit of its own, at the close-out. Until then these three pins are the CR's known red, as CR-CRU-200's
  `PROSE_CITATIONS` pin was.
- **`PROSE_CITATIONS`** heads are re-measured and re-recorded once, in their own commit.

### Follow-ups this CR triggers (another project's surface)

Model B's bootstrap skill checks `import xmlrunner, coverage`, and its python agent templates describe "unittest + xmlrunner",
`TEST-*.xml` and `ingest junit:`. Model B is told at merge, with these named; changing them is Model B's.

## Acceptance criteria

- [ ] **AC1 — the runner writes the stream.**
  - **The fixture:** a committed project, `tests/fixtures/unittest-project`, holds cases that:
    - pass, fail, error, are skipped, are expected to fail, or succeed unexpectedly;
    - fail in `tearDown`;
    - have passing, failing and nested subtests;
    - hit a `setUpClass` error and a module that fails to load;
    - carry a non-ASCII name and message.
  - **What its stream holds:** run through the new runner, the stream is one `run-start` (`total` = `countTestCases()`), one
    `test-end` per case CR-CRU-189 counts, and one `run-end` whose totals equal the `test-end` counts.
  - **Each `test-end`'s fields:** its `id`, `name`, `suite`, `file`, `status`, `duration_ms` (≥ 0) and `failure` match
    `tests/fixtures/unittest-project/expected.json`. That file is frozen from xmlrunner's report of the same cases, before
    xmlrunner is removed.
  - **On the board:** the fixture run is stored with no `incomplete`.
  - **Flushing:** a line is in the file before the next test starts.
  - **Exit codes:** 0 on success, 5 with no test, 1 otherwise.
  - **`CRUCIBLE_STREAM`:** gone from the tests' environment.
  - **xmlrunner absent:** the runner runs under an interpreter that cannot import xmlrunner, and its source imports none.
  - **A failed stream write:** said once; the run finishes, and its stream has no `run-end`.
- [ ] **AC2 — the stream equals the JUnit record.** The comparison:
  - takes suite names without xmlrunner's `-<timestamp>` suffix;
  - excludes durations;
  - compares statuses, names, files and failures.

  The binding check is the fixture: its stream-decoded run equals its JUnit-decoded run under that comparison, and that is
  what `expected.json` freezes.

  Recorded evidence, made once before the JUnit path is removed: `tests/client` is run through the python client both ways
  against the DEV board, and the two stored runs are equal under the same comparison. The runs are named in the cycle's report.
- [ ] **AC3 — tests reach the board while the run works.** The real python client and the real runner, against a scratch board
  (`tests/client/real_board.py`), run a suite whose tests wait on one another. The open run's `GET /api/v2/runs/<runId>/live`
  shows each finished test and each failure before the run ends.
- [ ] **AC4 — the relay.** Driven through its post function:
  - it cuts at the last complete UTF-8 character, splitting a long line across batches;
  - every encoded body stays within `batch_limit`, and the default applies when health gives none;
  - a 200's `held` and a 409's `held` move the next `from`, and a 413 carrying `held` stops sending;
  - a 400, a 404, a 409 without `held` (settled, unregistered) and a 413 without `held` stop sending, said once;
  - an unreachable board, a timeout or a 5xx is retried, said once, and never fails the run;
  - `finish` stops and joins the thread within its bound, sends what was never acknowledged (including batches refused while
    the run worked), and confirms `held` with an empty batch;
  - `RELAY_SECONDS`, `RELAY_POST_TIMEOUT_SECONDS`, `RELAY_FINISH_ATTEMPTS` and `RELAY_DEFAULT_BATCH_BYTES` are each one named
    constant;
  - the relay reads no event.
- [ ] **AC5 — the close.**
  - **The close itself:** a streamed unittest run closes through `POST /api/v2/runs` with `runId`, `codec: "crucible-events"`
    and no `data`, carrying `coverage`, `raw`, `tier`, `context`, `release` and `runnerExit`.
  - **The client's output:** it prints the ingest line, builds the envelope from the board's answer, and carries
    `stream-incomplete` when the board answers it. The exit is non-zero when that warning is present.
  - **Ran nothing:** a zero-test run (exit 5) is caught before the close by the local count, keeping `no-tests-discovered`, and
    aborted.
  - **No stream:** a runner that wrote none is ingested as a compile failure.
  - **A refused close:** the run is aborted.
  - **Which verbs:** `test`, a tier verb, `regression` and `pre-merge-gate`.
- [ ] **AC6 — when the board can't stream.**
  - A board whose health lists no `crucible-events`: the run is refused before it is opened or spawned, and the exit is 1.
  - An unreachable board, or no `runId`: the suite runs and nothing is filed. The envelope is `ok: false`, and the exit is
    non-zero.
  - In each case no stream is set.
- [ ] **AC7 — an interrupted or killed run.**
  - Interrupted before its first test, the open run is aborted, as today.
  - Interrupted after some tests, the bounded `finish` delivers what was written, and the run is aborted with every test the
    board acknowledged (CR-CRU-200).
  - The relay's thread is stopped on every exit.
- [ ] **AC8 — narration.** A streamed run posts no `running N`. It posts `ran <test-end count>/<run-end total>`, then
  `ingesting…`, before its close, on a suite with subtests. A pytest run narrates exactly as today.
- [ ] **AC9 — isolation.**
  - A nested client run inside a streamed run (this repo's own client tests) writes nothing into the outer stream.
  - A stale `crucible-events.ndjson` from an earlier run is removed by the wipe, never relayed or counted.
  - A run without `--agent`, or one that is not streaming, leaves no `CRUCIBLE_STREAM` in the child's environment.
- [ ] **AC10 — pytest and auto-ingest are unchanged.** A pytest run is filed from its JUnit report, with its narration and
  `subtests-uncounted`. `auto-ingest` files a JUnit dir as today.
- [ ] **AC11 — xmlrunner is gone.**
  - No file under `clients/` or `crucible_axi/` imports, runs or names xmlrunner, outside a comment recording its removal.
  - `pyproject.toml` lists no `unittest-xml-reporting`, and its comment block names none.
  - The python client's help and messages for a unittest run don't name it.
  - The unittest `subtests-uncounted` warning and the runner's fallback signal are gone.
  - PRD §4.4, the DN client-fleet inventory, the DN's declaration paragraph and `tests/fixtures/reports/README.md` read as
    §S4 states.
- [ ] **AC12 — the test suite.** Each of the 30 files naming xmlrunner is moved, kept or retired, as listed in RED's report. The
  pre-merge gate passes, its python client suite run now streamed to the board.
- [ ] **AC13 — the close-out.**
  - `SHARED_MODULE_LINE_BUDGETS` is re-recorded at its three sites in one commit.
  - The `PROSE_CITATIONS` heads are re-recorded in one commit.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.

## Non-goals

- **The board's side** (CR-CRU-200) and **its view** (CR-CRU-223).
- **Other streams:** any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195), and a pytest stream.
- **A JUnit fallback for unittest** (user ruling 2026-10-31).
- **The relay's use by the other clients**, which comes with their streams.
- **Model B's bootstrap skill and agent templates** (a follow-up for Model B).
