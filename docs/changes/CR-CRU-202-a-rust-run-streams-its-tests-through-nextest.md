# CR-CRU-202 — the board decodes a rust run's nextest stream as its record and its live view

**Type** feature · **Points** 13 (re-scored at its gap analysis, 2026-11-06) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-200 · **Status** PENDING · Pre-review: ran — 8 points; user rulings at the gap analysis
- **Filed 2026-10-20** (user rulings 2026-10-20; design in `DN-crucible-live-test-progress.md`).
- **Split at its gap analysis 2026-11-06** (user ruling): this CR keeps the board's half (the codec, the live view, the
  record and its check); CR-CRU-233 takes the rust client's half (streaming on every verb, the total, the declaration,
  the JUnit path's removal).
- **Pre-review 2026-11-06** (`CR-CRU-202-SPEC-REVIEW`): eight findings, all folded — health's lists re-pinned (AC8),
  the timeout and always-failing-retry exemptions (AC3), the message rule (§S3), same-name binaries (§S7, by user
  ruling: the client supplies the binary ids), ignored results above the total (§S4), a total of 0 (§S5), and the PRD
  and DN amended (a `chore(docs)` commit on develop).
- **Gap analysis 2026-11-06**, on develop `6afc06b7`: baseline bun 4706/0 (`evt-1793985219460-3`), python 6082/0
  (`evt-1793986841461-4`).

## Problem

- **A rust run's live progress is a count, and its record is a report written at exit.** The rust client narrates
  from nextest's human result lines and files the JUnit report nextest writes when the run ends.
- **nextest can stream each test as JSON.** cargo-nextest (0.9.130, measured) writes libtest-shaped JSON lines with
  `--message-format libtest-json-plus`, marked experimental in its help. The DN rules a structured stream the run's
  record (user ruling 2026-10-20, re-affirmed 2026-11-06).
- **The board has no codec for it.** The board's only record stream codec is `crucible-events`, and three places read
  a held stream with that codec by name: the live fill (`fillRunLive`), an aborted run's record
  (`abortedStreamRecord`) and the close (`parseRunBody`'s stream path).

## What the gap analysis measured

On a scratch crate (lib, bin and integration targets; pass, fail, `#[ignore]`, a flaky test under `--retries 2`, a
test past its `slow-timeout`) and on three crates of a real consumer (`nai`: 1434 tests, 104 test binaries):
- **What it needs:** `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1` in the environment, or nextest refuses the run (exit 95);
  `--message-format-version 0.1`, the only version (a later major is refused).
- **Where it goes:** to stdout, one JSON object per line; the human output goes to stderr. The same under
  `cargo llvm-cov nextest` and under `cargo llvm-cov show-env`.
- **When:** each test's line is written as it finishes (a 3 s test's line arrived 3 s after the others).
- **On `nai`:** 3076 lines, every one JSON, one result per test, no test reported twice.
- **The events:**
  - `{"type":"suite","event":"started","test_count":N,"nextest":{"crate","test_binary","kind"}}` when a test binary
    starts. It repeats for a binary that is re-opened later, with the same `test_count`.
  - `{"type":"test","event":"started","name":"<crate>::<binary>$<path>"}`.
  - `{"type":"test","event":"ok"|"failed"|"ignored","name":…,"exec_time":<seconds>}`; a failure carries `stdout`
    (the test's captured output, the panic in it) or, for a timeout, `reason: "time limit exceeded"`.
  - `{"type":"suite","event":"ok"|"failed","passed","failed","ignored",…}` per binary: these counts repeat and
    miscount (a binary was reported `failed` 1/1 and later `ok` 1/0).
- **What it lacks:**
  - **No run total up front:** a binary is announced only when its first test starts; on `nai` the sum of the
    announced counts reached 1434 only after 1314 tests had finished.
  - **No run-end event and no runner totals**, so the stream cannot state its own completeness.
  - **No failure type** (JUnit's "test failure with exit code 101").
  - **Ignored tests inconsistently:** an `ignored` result in one run; none in a fail-fast run or a filtered run, where
    the test's `started` line appears with no result.
- **Retries:** only the last attempt's result is written, its name suffixed `#<attempt>` (`…$flaky::flips#2`).
- **Naming against JUnit:** JUnit's classname is the crate for a lib binary (`nx202`), `<crate>::bin/<name>` for a
  bin target and `<crate>::<name>` for an integration test; its test name is the path after `$`. The stream's test
  lines carry `<crate>::<binary>$<path>`; the binary's kind is on the `-plus` suite lines only.
- **What JUnit holds that the board reads:** status (`failure` element → fail, `skipped` → pending), the failure's
  message (the panic's first line, `thread '<name>' (<tid>) panicked at <file>:<line>:<col>`), type and body, the
  duration; no ignored test at all; flaky and rerun elements, which the board's `junit` codec ignores.
- **The board's live and record paths:** the live fill, the aborted record and the close each call the
  `crucible-events` reader by name; the open run's total is the stream's `run-start` total, else the run start's own
  (`runs.total`).

## Design

- **§S1 — a `nextest` record stream codec.** The board decodes `nextest` streams (nextest's `libtest-json-plus`,
  message-format version 0.1) as a record stream codec: it joins `codecs.test` and `codecs.stream` in health, the
  stream route accepts it, and the close decodes it.
- **§S2 — one line reader per record codec.** Each record stream codec reads a held stream line by line into the
  board's one test-end shape. The live fill, an aborted run's record and the close read through the run's codec,
  never a named codec. `crucible-events` reads as it does today.
- **§S3 — how a nextest line reads.**
  - A test result (`ok`, `failed`, `ignored`) is one test: `ok` passes, `failed` fails, `ignored` is pending (user
    ruling 2026-11-06). `started` lines and suite result lines are not tests, and a suite line's figures are never
    read as counts.
  - Its name is the path after `$`, with a retry suffix `#<n>` removed. Its duration is `exec_time` in milliseconds.
  - Its suite is its test binary's id, which is JUnit's classname (`<crate>` for a lib, `<crate>::bin/<name>` for a
    bin, `<crate>::<name>` for an integration test), resolved as §S7 states.
  - A failure's message is the first of these found in its `stdout`: the line `thread '<the test's path>' (<tid>)
    panicked at <location>:` (the test's own thread, cut before the trailing colon); a line starting `note: test did
    not panic as expected`; the first line starting `thread '`, cut the same way; the first non-blank line. With no
    `stdout`, it is the line's `reason` (a timeout's `time limit exceeded`). Its body is `stdout` (or `reason`); it
    carries no type.
  - A line that is not JSON, or JSON of no known shape, is undecodable.
- **§S4 — the live view.** An open nextest run's live state counts each result as it lands, its current file being
  the result's suite, and each failure joins the live failures with its message. Its total is the run's listed total
  (§S7), else the run start's, plus the pending results seen (an ignored test is outside the listed total); 0 is no
  total.
- **§S5 — the record and its check.** At the close the held stream is the run's record: one suite node per suite in
  first-seen order, one leaf per result in stream order. The run is stored flagged incomplete, with each reason, when:
  - its passed and failed tests differ from its total (the listed total, else the start's) when that total is above
    0 ("the run listed N tests, the stream holds M"); a total of 0, or none, is not checked;
  - a result's binary cannot be resolved to one test binary (§S7), naming it;
  - it holds an undecodable line;
  - it was cut at `ingest_body_bytes`.
  An aborted nextest run keeps its decoded record, flagged.
- **§S6 — nothing else changes:** `crucible-events` streams, the `junit` codec (rust runs filed as JUnit still decode as
  today), the stream route's batch rules, the live view's shape and the clients.
- **§S7 — an open run takes its test list** (user ruling 2026-11-06: the client supplies the binary ids). nextest's
  stream names a result `<crate>::<binary name>$<path>`, and a crate's lib, bin and integration test can share one
  binary name; `cargo nextest list --message-format json` names each test's binary by its id.
  - `POST /api/v2/runs/<runId>/tests {projectKey, agentId, codec: "nextest-list", data}` gives an open run the list,
    as nextest wrote it, once. The caller and run rules are the stream route's; the body is bounded by
    `ingest_body_bytes` (413); `data` that is not a nextest list is a 400; a second list is a 409; a settled run is
    a 409. Every refusal stores nothing.
  - The run's listed total is the list's tests whose `filter-match` is `matches`; it replaces the start's total.
  - A result resolves to the listed binary of its crate and binary name whose tests hold its path. With no list, or
    when no such binary or more than one holds it, the binary's kind from the stream's suite lines (kept per
    `<crate>::<binary name>` between batches) gives the id; when that key names more than one kind or none, the
    suite is `<crate>::<binary name>` and §S5 flags the run.

## Acceptance criteria

The fixtures are streams, lists and JUnit reports captured from real nextest 0.9.130 runs of scratch workspaces, kept
under the test tree with the commands that wrote them.
- [ ] **AC1 (§S1).** A stream batch with codec `nextest` is accepted on an open run (200); health lists `nextest` in
  `codecs.test` and `codecs.stream`; a run whose first batch fixed `nextest` refuses a `crucible-events` batch (400),
  as for any stream.
- [ ] **AC2 (§S2).** `fillRunLive`, `abortedStreamRecord` and the close each read a held stream through its run's
  codec; a test drives each of the three with a `nextest` run and with a `crucible-events` run.
- [ ] **AC3 (§S3, §S5, §S7 — the record equals JUnit's).** For each captured run, with its list posted, the record the
  board stores from the stream has the same suites, test names, statuses, passed and failed counts and failure
  messages as the board's `junit` decoding of the JUnit report nextest wrote in the same run, and durations within
  one millisecond. The runs: all pass; a failure; a lib, a bin and an integration target with distinct names; a
  crate whose lib, bin and integration test share its name; a panic in a spawned thread; a `#[should_panic]` test
  that does not panic; a test returning `Err`; a flaky test under retries. Ignored tests are pending leaves where the
  stream names them, and JUnit has none. Exempt, each named in its test: a timeout's message (JUnit's timeout
  failure has none); and, for a test failing every retried attempt, its thread id in the message and its duration
  (JUnit keeps the first attempt, the stream the last).
- [ ] **AC4 (§S3).** A retried test's `#<n>` suffix is gone from its name; a timeout's failure message is its reason;
  a test whose `started` line has no result is not a test; a suite line's repeated or miscounted figures change
  nothing.
- [ ] **AC5 (§S4).** An open nextest run with a listed total of 6, whose stream lands in two batches (the second holding
  a binary's suite line, its tests and one `ignored` result), reads after each batch: `completed`, `passed`, `failed`,
  `pending`, the total (6, then 7 once the ignored result lands) and the current file (the latest result's suite),
  and each failure in the live failures with its message, in order.
- [ ] **AC6 (§S5).** A nextest run whose passed and failed tests differ from its total is stored flagged with a reason
  naming both figures; one with an unresolvable binary, an undecodable line, or cut, is flagged naming each; one
  that matches is not flagged; one with a total of 0, or none, is not checked against one; an aborted one keeps its
  record, flagged.
- [ ] **AC7 (§S7).** The test list route: an open run takes one list (200) and its listed total; a second is a 409, a
  settled run's a 409, a body past `ingest_body_bytes` a 413, data that is not a nextest list a 400, an unknown run
  or another agent's a 400, each storing nothing. With a list, the same-name crate's results land in its three
  suites; without one, they land in one suite `<crate>::<name>` and the run is flagged naming it.
- [ ] **AC8 (§S6).** The tests that pin health's codec lists and the registry's keys are re-pinned to add `nextest`
  (`health-lists-the-record-stream-codecs`, `health-names-the-codecs-it-decodes`,
  `view-codecs-live-in-their-own-registry`, `gate-milestone-scope-and-suites`, `codec-registry`, and the python
  harness's `HEALTH_CODECS`); every other existing test passes unchanged.

## Non-goals

- The rust client streaming, its total, its declaration and the JUnit path's removal: CR-CRU-233.
- `cargo test` without nextest.
