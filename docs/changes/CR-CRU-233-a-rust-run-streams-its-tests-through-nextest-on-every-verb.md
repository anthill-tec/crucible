# CR-CRU-233 — a rust run streams its tests through nextest on every verb

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-202 · **Status** PENDING · Pre-review:
ran — 13 points; the gap analysis needed user rulings
- **Filed 2026-11-06**, split from CR-CRU-202 at its gap analysis (user ruling): CR-CRU-202 keeps the board's `nextest`
  codec; this CR takes the rust client's half.
- **Gap analysis 2026-11-07** (user rulings):
  - an undeclared rust project streams by default;
  - the rust table is `[targets.<nextest profile>]` in `crucible.toml`, in bun's `crucible.targets` vocabulary, which
    is the one vocabulary for every stack (rust implements it here; other stacks adopt it in their own CRs);
  - the minimum nextest is 0.9.130, the version the board's decoder is proven against;
  - it stays one CR at 13 points, not split.
- **Pre-review 2026-11-07** (`CR-CRU-233-SPEC-REVIEW`, fifteen findings, all folded; user rulings on four):
  - streamed verbs always run `--no-fail-fast` (§S1);
  - a list the board refuses warns and the run goes on (§S2);
  - `--ignore-run-fail` retires (§S1);
  - the real-runner tests live in `test:client` and require the rust toolchain (ACs).

  On approval (user, 2026-11-07), the standard rust profiles were added. They follow nai's backend pattern: `default`
  (ad hoc, excluding the docker tier), `ci` (the gate's run, the same exclusion) and `e2e` (only the docker tier). They
  are the profiles Model B's scaffold sets up in the table, documented in the shipped `crucible.toml` and in the
  release note's "Stack declaration changes" (AC9). Another profile is not refused; it runs with the default entry.

  Also folded:
  - coverage gets its own target dir and clears old profiles (§S1);
  - the stream variable is forced (§S1);
  - the shared run path gains a stdout split, and every caller is named (§S6);
  - the client's total is the board's answer (§S2);
  - a declared tier needs no JUnit (§S5);
  - `auto-ingest` can't refile a streamed run (§S5);
  - the refusal order (§S4);
  - runs without an agent (§S1);
  - AC2's variants are mapped to the verbs that take them;
  - the narrator and fake cargo are re-pinned (AC8);
  - the framework travels with the run, and only the project's own file declares (§S1, §S3).

## Problem

- **The rust client files a report written at exit.** Each of its four test-running bodies runs nextest and files the
  JUnit report nextest writes when the run ends. The live view is a count read from nextest's human lines.
- **The board decodes nextest's stream** (CR-CRU-202), and the DN rules a structured stream the run's record (user
  ruling 2026-10-20, re-affirmed 2026-11-06), so the JUnit path goes.

## What the gap analysis measured

All measurements were taken on a nai-shaped scratch workspace with cargo-nextest 0.9.130 and cargo-llvm-cov 0.8.4. It
has several crates, a feature-gated test, and a docker-tier binary that the `ci` profile's `default-filter` excludes and
an `e2e` profile selects.
- **The stream.** `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1 cargo nextest run --message-format libtest-json-plus
  --message-format-version 0.1` writes the stream to stdout and the human output to stderr.
  - Each result line lands as its test finishes: the first at 0.06 s, a 1.5 s test at 1.56 s.
  - With the variable at `0`, nextest exits 95 with empty stdout.
  - A fail-fast run stops after its first failure: the list held 5 tests, the stream 1 `started` and 1 `failed`.
- **The list.** `cargo nextest list --message-format json`, given the run's own profile, filter, features and
  selection, holds exactly the run's results.
  - `-P ci`: 17 matches and 1 ignored, against 18 results streamed (11 ok, 6 failed, 1 ignored).
  - With `--features`: 18 matches.
  - A binary that a `default-filter` excludes is listed with no tests.
  - On nai (CR-CRU-202): 1434 matches, in 0.77 s once built.
  - On a compile error, `nextest list` exits 101 with empty stdout and the rustc errors on stderr.
- **Coverage in one build.** Under `cargo llvm-cov show-env`'s environment, `nextest list` builds the instrumented tree,
  `nextest run` reuses it with nothing compiled, and `cargo llvm-cov report --failure-mode all --lcov` writes the lcov
  even when tests failed. The environment points the build at `target/` itself; today's `cargo llvm-cov nextest` keeps
  it in `target/llvm-cov-target`. After an instrumented build, a plain `nextest run` reuses the instrumented binaries
  and writes `.profraw` files into the crate's source directory (pre-review).
- **The format is experimental.** It shipped in nextest 0.9.66. The board's decoder is proven only against 0.9.130's
  output.
- **The bodies and their verbs:**
  - `cmd_test`: `test`, `unit`, `integration`, `e2e`;
  - `cmd_regression_ingest`: `regression-ingest`, per crate, with coverage;
  - `_smoke_test`: `smoke-test`, and `docker-e2e-gate` (profile `e2e`, with docker);
  - `cmd_workspace_regression`: `workspace-regression` and `regression`, each with or without `--coverage`, and
    `pre-merge-gate` after its clippy step;
  - `auto-ingest` runs no tests: it files the JUnit report that a nextest run outside the client left.
- **The shared run module.**
  - `run_streamed` merges stdout into stderr. The mvn, arduino, bun, python and rust clients all call it.
  - `StreamRelay` follows a file by path.
  - The stream counting behind narration, the closing `ran N/M`, and the ran-nothing and zero-discovery rules reads
    `crucible-events` events only.
- **The tests.** About 70 files under `tests/client` drive the rust client or the shared fake cargo
  (`live_run_harness.py`'s `FAKE_CARGO`), and 29 of them mention JUnit.

## Design

- **§S1 — every test-running verb streams.**
  - **The run.** With an agent, each of the four bodies runs `cargo nextest run --no-fail-fast` with the stream on: the
    client sets `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1` whatever the environment holds, and passes the two flags. It
    relays the runner's stdout to the open run with codec `nextest`, and closes the run from the stream.
  - **The framework.** The run states `framework: "nextest"` on its start and its close (PRD §4.4, the DN's
    declaration).
  - **stderr.** The runner's stderr, which is cargo's and nextest's human output, is echoed and logged as today. It is
    not part of the stream.
  - **Coverage runs.**
    - A coverage verb runs its list and its run under `cargo llvm-cov show-env`'s environment. The instrumented build
      gets its own target directory, as today's (`target/llvm-cov-target`), so a later plain run never reuses
      instrumented binaries.
    - Profiles left by an earlier run are cleared before the list, so no old `.profraw` is merged.
    - The lcov is then written with `cargo llvm-cov report --failure-mode all --lcov` and filed as `lcov`, whether or
      not tests failed. The verb's exit follows the tests.
  - **`--ignore-run-fail` retires** (user ruling). The verbs that accepted it refuse it, saying that the lcov is now
    always written.
  - **Unchanged.** What each verb cleans, selects and gates otherwise stays as it is.
  - **Without an agent.** A verb opens no run, as today. It runs `cargo nextest run` without the stream and without a
    list, with nextest's human output on the terminal, and files nothing.
- **§S2 — the list before the run.**
  - **The list.** Before the run, the client runs `cargo nextest list --message-format json` with the run's own
    profile, filter, features and crate and target selection, under the coverage environment for a coverage verb.
  - **The post.** It posts the list's stdout, as nextest wrote it, to the open run before the run starts: `POST
    /api/v2/runs/<runId>/tests`, codec `nextest-list`.
  - **The total.** The board takes the run's total and each test's binary id from the list. The client's narration
    total is the `total` the board answers; the client counts nothing in the list.
  - **A list that exits non-zero** means the build failed. Its stderr is filed as a compile failure closing the run,
    and no run follows.
  - **A list the board refuses** (400, 409, 413, or unreachable): the run goes on and streams (user ruling). The board
    falls back as CR-CRU-202 rules (no completeness check, and binary kinds taken from the stream), and the envelope
    warns that the list was not taken, and why.
- **§S3 — the declaration.**
  - **The table.** A rust project declares its runs in its own `crucible.toml` as `[targets.<nextest profile>]`, in
    bun's `crucible.targets` vocabulary: `framework = "nextest"` and `stream = { codec = "nextest", path = "stdout" }`.
    `path = "stdout"` is a new value, meaning the runner's stdout.
  - **Which file.** Only the project's own `crucible.toml` declares. The install's file never does.
  - **The default.** A run uses the entry for the profile it runs. A profile with no entry, or a project with no
    `crucible.toml`, runs exactly as if it declared that entry.
  - **Refused before anything runs:**
    - a project file that does not parse;
    - an entry naming another `framework`, `codec` or `path`, or declaring `junit`, `console` or `coverage` (a rust
      run's record is its stream, and its coverage follows the verb). The refusal names `targets.<profile>` and the
      field at fault;
    - a board whose health does not list `nextest` under `codecs.stream`.
  - **Documentation.** The shipped `crucible.toml` documents the table as the one vocabulary every stack uses. It also
    names the standard rust profiles a scaffold sets up: `default`, `ci` and `e2e`, each with what it selects.
- **§S4 — an unsupported nextest is refused.**
  - **The check.** With an agent, the client reads `cargo nextest --version` before anything else runs. Below 0.9.130,
    or when the version cannot be read, the verb is refused, naming 0.9.130 and the version found.
  - **Order.** That refusal, and §S3's, come before:
    - `pre-merge-gate`'s clippy step;
    - `docker-e2e-gate`'s docker up;
    - the gate lock;
    - the disk guard;
    - any `cargo clean`, build or list.

    No run is opened.
- **§S5 — the JUnit path goes from the streamed verbs.**
  - **What goes.** The four bodies no longer read or file nextest's JUnit report. Their JUnit-only paths go: the
    report lookup, the stale-report cleaning, and the `cargo check --tests` fallback.
  - **A declared tier no longer needs JUnit.** A declared tier is a profile `.config/nextest.toml` defines, with or
    without a `junit` table, both for the tier verbs and for the scoped `pre-merge-gate`.
  - **Leftover reports.** A profile may still configure JUnit, and nextest still writes it. A streamed run moves that
    report out of `target/nextest/<profile>/`, as a run does today, so `auto-ingest` never files a run already
    streamed.
  - **`auto-ingest` is unchanged.** It keeps filing the JUnit report an outside run left, and keeps its stale-report
    cleaning.
- **§S6 — the shared run path carries a stdout stream.**
  - **The split.** `run_streamed` gains a way to write the runner's stdout to a file, which the relay follows, while
    stderr is echoed and logged as today.
  - **Raw and log.** For a split run, the run's raw capture and its `--log` hold the stderr.
  - **Counting.** The stream count behind a streamed run's narration ticks, its closing `ran N/M`, and its ran-nothing
    and zero-discovery rules reads the run's codec. `crucible-events` reads exactly as today. For `nextest`, each test
    result line (`ok`, `failed`, `ignored`) is one result, and `ok` and `failed` ran.
  - **Retired.** The rust client's human-line narrator is retired for streamed runs.
  - **Callers.** Every caller of `run_streamed`, `start_stream_relay`, `StreamTicks`, `stream_counts` and
    `close_streamed_run` (the bun, python, mvn, arduino and rust clients) behaves exactly as before unless it asks for
    the split.
- **§S7 — nothing else changes:**
  - the board;
  - `check`, `clippy` and `workspace-clippy`;
  - docker up and down, the gate lock and the disk guard;
  - the bun, python, mvn and arduino clients' behaviour;
  - the `lcov` codec.

## Acceptance criteria

**Where the real-runner tests run.** AC1–AC3 are python tests in `tests/client`, run by the gate's `test:client` suite
(user ruling). They run the real client, real cargo-nextest and cargo-llvm-cov, and a real board, against one small
scratch rust workspace committed under the test tree. That workspace has several crates; a test that runs for at
least three relay cycles; a failing test; an ignored test; a feature-gated test; and a profile with a
`default-filter`.

**How they build.** The workspace is copied to `/tmp` and built there once, in its own target directory, and the build
is shared by these tests. Nothing builds in the repository's tree.

**A missing toolchain fails them.** A missing cargo-nextest (0.9.130 or later) or cargo-llvm-cov fails these tests,
naming what is missing. It never skips them.
- [ ] **AC1 (§S1, real).** For each of `test`, `regression-ingest`, `smoke-test` and `workspace-regression
  --coverage`:
  - while the slow test is still running, the open run on the board holds at least one decoded result and fewer than
    its total;
  - every stream batch carries codec `nextest`;
  - the run states `framework: "nextest"`;
  - the run closes from its stream with the workspace's passed, failed and pending counts, every listed test run
    despite the failure.
- [ ] **AC2 (§S2, real).** In each AC1 run, the list is posted before the first stream batch, and the open run's total
  equals the list's matching tests. In particular:
  - under the profile's `default-filter` (every verb);
  - with `--features` (`test`, `smoke-test`, `workspace-regression`);
  - for a crate selection (`test -p`, `regression-ingest`);
  - with an `-E` filter (`test`);
  - with `--lib` (`unit`), `--tests` and `--test <name>` (`integration`).

  For coverage runs:
  - a coverage run's run step prints no `Compiling` line and files its lcov even though a test failed;
  - after it, a plain `test` run compiles its crates again, and no `*.profraw` file exists outside the coverage
    target directory.
- [ ] **AC3 (§S5, real — the stored result equals JUnit's).** For each AC1 run, the record the board stores equals the
  board's `junit` decoding of the JUnit report nextest wrote in the same run. Equal means:
  - the same suites, test names, statuses, passed and failed counts, and failure messages, with CR-CRU-202 AC3's
    exemptions.

  Also:
  - no verb of the four bodies posts a `junit` ingest;
  - an `auto-ingest` run straight after files nothing.
- [ ] **AC4 (§S4).** A cargo-nextest reporting 0.9.129, and one whose version cannot be read, are each refused on every
  verb of the four bodies. In each case:
  - no run is opened;
  - cargo cleans, builds and lists nothing;
  - `pre-merge-gate` runs no clippy and `docker-e2e-gate` brings no docker up;
  - no gate lock is taken;
  - the `ok: false` envelope names 0.9.130 and the version found.
- [ ] **AC5 (§S3).**
  - **These stream as declared:**
    - a project with no `crucible.toml`;
    - a project whose `crucible.toml` has no entry for the run's profile;
    - a project declaring the exact entry;
    - a project whose install-level `crucible.toml` declares a different entry (it is ignored).
  - **Each of these is refused,** with the same nothing-run guarantees as AC4:
    - an entry naming another `framework`, `codec` or `path` (the refusal names `targets.<profile>` and the field);
    - an entry declaring `junit`, `console` or `coverage` (the same);
    - a project `crucible.toml` that does not parse;
    - a board whose health does not list `nextest` under `codecs.stream`.
  - **JUnit no longer declares a tier.** A tier profile with no `junit` table counts as declared, for the tier verbs and
    for the scoped `pre-merge-gate`.
- [ ] **AC6 (§S1, §S2, §S6 — each state).** On the fake cargo, for every verb of the four bodies:
  - **Compile error at the list.** A compile failure is filed, closing the run; no run step follows.
  - **List refused or unreachable.** A list the board refuses (each of 400, 409 and 413), or a board unreachable for
    the list, lets the run stream on with a warning naming the refusal.
  - **Ran nothing.** A list with no matching test and a stream with no result counts as having run nothing.
  - **No stream line.** A run that exits non-zero with no stream line after a successful list is a no-report failure,
    never a compile failure.
  - **The stream switch.** `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=0` set in the environment still streams (the client sets
    the variable to `1`).
  - **Interrupted.** An interrupted run is aborted, keeping its decoded record.
  - **Cut short.** A stream cut after a `started` line is stored flagged incomplete.
  - **Fail-fast.** The run passes `--no-fail-fast`.
  - **Narration.** The closing `ran N/M` counts the stream's results against the board's listed total.
  - **`--ignore-run-fail`.** It is refused on each verb that accepted it.
  - **Without an agent.** A run with no agent posts nothing, lists nothing and runs without the stream.
- [ ] **AC7 (§S6).** The bun, python, mvn and arduino clients' runs count, narrate, log and close exactly as before, and
  their existing tests pass unchanged.
- [ ] **AC8 (§S5, §S6).** The shared fake cargo answers:
  - `nextest --version`;
  - `nextest list`;
  - `llvm-cov show-env`;
  - `llvm-cov report`;
  - the streamed `nextest run`.

  These tests are re-pinned to the stream: those that pinned the rust client's JUnit filing on the four bodies, its
  human-line narration, `--ignore-run-fail`, and the JUnit requirement of a declared tier. `auto-ingest`'s JUnit tests
  stay. Every other existing test passes unchanged.
- [ ] **AC9 (§S3).** The shipped `crucible.toml` documents the `[targets.<profile>]` table:
  - its fields;
  - the rust entry;
  - that only a project's own file declares;
  - the default for an undeclared profile;
  - that bun's `crucible.targets` uses the same vocabulary;
  - the standard rust profiles `default`, `ci` and `e2e`, and what each selects.

  The rust client's help names the table and the minimum nextest. The CHANGELOG's `[Unreleased]` entry carries a
  "Stack declaration changes" section, the part Model B reads in the release note. That section names:
  - the `[targets.<profile>]` table;
  - the rust entry;
  - the standard profiles;
  - that undeclared profiles stream by default;
  - the minimum nextest;
  - the retirement of `--ignore-run-fail`.

## Non-goals

- The board's codec (CR-CRU-202).
- `cargo test` without nextest.
- The python, maven and arduino clients reading the table. Each adopts it in its own CR.
- Model B's scaffold and Crucible's installer writing the declaration (queued to Model B as a contract request).
- `auto-ingest`, which files the JUnit report of a run made outside the client.
