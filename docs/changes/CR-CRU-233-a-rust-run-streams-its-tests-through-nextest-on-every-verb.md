# CR-CRU-233 — a rust run streams its tests through nextest on every verb

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-202 · **Status** PENDING · Pre-review:
due — 13 points; the gap analysis needed user rulings
- **Filed 2026-11-06**, split from CR-CRU-202 at its gap analysis (user ruling): CR-CRU-202 keeps the board's `nextest`
  codec; this CR takes the rust client's half.
- **Gap analysis 2026-11-07** (user rulings): an undeclared rust project streams by default; the rust table is
  `[targets.<nextest profile>]` in `crucible.toml`, in bun's `crucible.targets` vocabulary, which is the one
  vocabulary for every stack (rust implements it here; other stacks adopt it in their own CRs); the minimum nextest is
  0.9.130, the version the board's decoder is proven against; one CR at 13 points, not split.

## Problem

- **The rust client files a report written at exit.** Each of its four test-running bodies runs nextest and files the
  JUnit report nextest writes when the run ends; the live view is a count read from nextest's human lines.
- **The board decodes nextest's stream** (CR-CRU-202), and the DN rules a structured stream the run's record (user
  ruling 2026-10-20, re-affirmed 2026-11-06), so the JUnit path goes.

## What the gap analysis measured

All measurements were taken on a nai-shaped scratch workspace with cargo-nextest 0.9.130 and cargo-llvm-cov 0.8.4. The
workspace has several crates, a feature-gated test, and a docker-tier binary excluded by the `ci` profile's
`default-filter` and selected by an `e2e` profile.
- **The stream.** `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1 cargo nextest run --message-format libtest-json-plus
  --message-format-version 0.1` writes the stream to stdout and the human output to stderr. Each result line lands as
  its test finishes: the first at 0.06 s, a 1.5 s test at 1.56 s.
- **The list.** `cargo nextest list --message-format json`, with the run's own profile, filter, features and selection,
  holds exactly the run's results:
  - `-P ci`: 17 matches and 1 ignored, against 18 results streamed (11 ok, 6 failed, 1 ignored);
  - with `--features`: 18 matches;
  - a binary excluded by a `default-filter` is listed with no tests;
  - on nai (CR-CRU-202): 1434 matches, 0.77 s once built.
- **A compile error stops at the list.** `nextest list` builds, and on a compile error it exits 101 with empty stdout
  and the rustc errors on stderr.
- **Coverage in one build.** Under the environment `cargo llvm-cov show-env` prints, `nextest list` builds the
  instrumented tree and `nextest run` reuses it, compiling nothing. `cargo llvm-cov report --failure-mode all --lcov`
  then writes the lcov even though tests failed.
- **The format is experimental.** It shipped in nextest 0.9.66; the board's decoder is proven only against 0.9.130's
  output.
- **The bodies and their verbs:**
  - `cmd_test`: `test`, `unit`, `integration`, `e2e`;
  - `cmd_regression_ingest`: `regression-ingest` (per crate, with coverage);
  - `_smoke_test`: `smoke-test` and `docker-e2e-gate` (profile `e2e`, with docker);
  - `cmd_workspace_regression`: `workspace-regression` and `regression` (each with or without `--coverage`), and
    `pre-merge-gate` after its clippy step.
  - `auto-ingest` runs no tests: it files the JUnit report that a nextest run outside the client left.
- **The shared run module reads only `crucible-events`.**
  - `run_streamed` merges stdout and stderr.
  - The stream counting behind a run's narration, its closing `ran N/M`, and its ran-nothing and zero-discovery rules
    reads `crucible-events` events only.
  - The relay itself sends a file's lines whatever their codec.
- **The tests.** 47 files under `tests/client` drive the rust client through the shared fake cargo
  (`live_run_harness.py`), which writes JUnit today.

## Design

- **§S1 — every test-running verb streams.**
  - Each of the four bodies runs `cargo nextest run` with the stream on (the variable and the two flags above).
  - It relays the runner's stdout to the open run with codec `nextest`, and closes the run from the stream.
  - The runner's stderr (cargo's and nextest's human output) is echoed and logged as today, and is not part of the
    stream.
  - A coverage verb runs its list and its run under `cargo llvm-cov show-env`'s environment, then writes the lcov
    with `cargo llvm-cov report --failure-mode all --lcov`. The lcov stays the run's final coverage report, filed as
    `lcov`, whether or not tests failed.
  - What each verb cleans, selects and gates stays as it is today.
- **§S2 — the list before the run.**
  - Before the run, the client runs `cargo nextest list --message-format json`, with the run's own profile, filter,
    features and crate and target selection, under the coverage environment for a coverage verb.
  - It posts the list's stdout, as nextest wrote it, to the open run: `POST /api/v2/runs/<runId>/tests`, codec
    `nextest-list`, before the run starts.
  - The board takes the run's total and each test's binary id from the list; the client reads no total from it.
  - A list that exits non-zero is the build failing. Its stderr is filed as a compile failure closing the run, and no
    run follows.
- **§S3 — the declaration.**
  - A rust project declares its runs in `crucible.toml` as `[targets.<nextest profile>]`, in bun's
    `crucible.targets` vocabulary: `framework = "nextest"` and `stream = { codec = "nextest", path = "stdout" }`.
    `path = "stdout"` is a new value, meaning the runner's stdout.
  - A run uses the entry of the profile it runs. A profile with no entry, or a project with no `crucible.toml`, runs
    exactly as if it declared that entry.
  - An entry is refused before anything is run or opened, naming `targets.<profile>` and the field at fault, when:
    - it names another `framework`, `codec` or `path`;
    - it declares a `junit`, `console` or `coverage`. A rust run's record is its stream, and its coverage follows the
      verb.
  - A run is also refused before anything runs when the board's health does not list `nextest` under
    `codecs.stream`.
  - This table shape is the one vocabulary every stack uses, and the shipped `crucible.toml` documents it.
- **§S4 — an unsupported nextest is refused.** Before anything builds, the client reads `cargo nextest --version`.
  Below 0.9.130, or when the version cannot be read, the verb is refused: no run is opened and cargo runs nothing, and
  the refusal names 0.9.130 and the version found.
- **§S5 — the JUnit path goes from the streamed verbs.**
  - The four bodies no longer read or file nextest's JUnit report, and the JUnit-only paths they used go: the stale
    report cleaning, the report lookup, and the `cargo check --tests` fallback.
  - A profile may still configure JUnit, and nextest still writes it; the client ignores it.
  - `auto-ingest` keeps filing the JUnit report an outside run left, since that run has no stream.
- **§S6 — the shared stream count reads the run's codec.**
  - The count behind a streamed run's narration ticks, its closing `ran N/M`, and its ran-nothing and zero-discovery
    rules reads the run's codec.
  - `crucible-events` reads exactly as today.
  - For `nextest`, each test result line (`ok`, `failed`, `ignored`) is one result, `ok` and `failed` ran, and the
    total is the list's.
- **§S7 — nothing else changes:**
  - the board;
  - `check`, `clippy`, `workspace-clippy`, docker up and down, the gate lock and the disk guard;
  - the bun and python clients' behaviour;
  - the `lcov` codec.

## Acceptance criteria

The real-runner ACs run the real client, real cargo-nextest 0.9.130 and a real board on a scratch rust workspace
committed under the test tree. The workspace has several crates, a slow test, a failing test, an ignored test, a
feature-gated test, and a profile with a `default-filter`. Each AC is built in its own scratch copy and target dir;
none touches the repository's tree.
- [ ] **AC1 (§S1, real).** For each of `test`, `regression-ingest`, `smoke-test` and `workspace-regression
  --coverage`:
  - while a slow test is still running, the open run on the board already holds at least one decoded result and fewer
    than its total;
  - every stream batch carries codec `nextest`;
  - the run closes from its stream with the workspace's passed, failed and pending counts.
- [ ] **AC2 (§S2, real).** In each AC1 run, the list is posted before the first stream batch, and the open run's total
  equals the list's matching tests. This holds under:
  - the profile's `default-filter`;
  - `--features`;
  - a crate selection;
  - an `-E` filter;
  - `--lib` and `--tests`.

  A coverage run compiles nothing in its run step and files its lcov although a test failed.
- [ ] **AC3 (§S5, real — the stored result equals JUnit's).** For each AC1 run, the record the board stores equals the
  board's `junit` decoding of the JUnit report nextest wrote in the same run. Equal means the same suites, test names,
  statuses, passed and failed counts and failure messages, with CR-CRU-202 AC3's exemptions. No verb of the four
  bodies posts a `junit` ingest.
- [ ] **AC4 (§S4).** A cargo-nextest reporting 0.9.129, and one whose version cannot be read, are each refused on every
  verb of the four bodies. No run is opened, cargo builds and lists nothing, and the `ok: false` envelope names 0.9.130
  and the version found.
- [ ] **AC5 (§S3).** These stream as declared:
  - a project with no `crucible.toml`;
  - a project whose `crucible.toml` has no entry for the run's profile;
  - a project declaring the exact entry.

  An entry naming another `framework`, `codec` or `path`, or declaring `junit`, `console` or `coverage`, is refused
  before anything runs, naming `targets.<profile>` and the field. A board whose health does not list `nextest` under
  `codecs.stream` is refused before anything runs.
- [ ] **AC6 (§S2, §S6 — each state).** On the fake cargo, for every verb of the four bodies:
  - a compile error at the list files a compile failure closing the run, and no run step follows;
  - a list with no matching test and a stream with no result is ran nothing;
  - an interrupted run is aborted, keeping its decoded record;
  - a stream cut after a `started` line is stored flagged incomplete;
  - the narration's closing `ran N/M` counts the stream's results against the listed total.
- [ ] **AC7 (§S6).** The bun and python clients' streamed runs count, narrate and close exactly as before. Their
  existing tests pass unchanged.
- [ ] **AC8 (§S5).**
  - The shared fake cargo writes the stream and the list.
  - The tests that pinned the rust client's JUnit filing on the four bodies are re-pinned to the stream.
  - `auto-ingest`'s JUnit tests stay.
  - Every other existing test passes unchanged.
- [ ] **AC9 (§S3).** The shipped `crucible.toml` documents the `[targets.<profile>]` table: its fields, the rust entry,
  the default for an undeclared profile, and that bun's `crucible.targets` uses the same vocabulary. The rust client's
  help names the table and the minimum nextest.

## Non-goals

- The board's codec (CR-CRU-202).
- `cargo test` without nextest.
- The python, maven and arduino clients reading the table. Each adopts it in its own CR.
- Model B's scaffold and Crucible's installer writing the declaration (queued to Model B as a contract request).
- `auto-ingest`, which files the JUnit report a run outside the client left.
