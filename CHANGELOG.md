# Changelog

All notable changes to Crucible — the `@anthill-tec/crucible-server` npm package and the
`crucible-axi` PyPI package, which are released together under one version — are recorded here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section is
also the body of its [GitHub Release](https://github.com/anthill-tec/crucible/releases).
Releases before 0.3.0 are described only on GitHub Releases.

## [Unreleased]

### Upgrading

- **A gate whose only run fails now answers `ok: false`.** A `pre-merge-gate` on a project that
  declares no suites runs one whole-suite regression, and that run's envelope is the gate's answer.
  When that run fails, the gate now answers `ok: false` with a `gate-suite-failed` warning, in every
  client, as a gate that composes declared suites already did. Its exit and its help are unchanged.
  A stack file that reads the gate's exit sees no difference; one that reads `ok` now sees the
  failure. A lone run that is filed with no counts now also answers `ok: false`, with a
  `gate-suite-unreported` warning, while its exit stays 0.

### Added

- **A gate runs the project's declared unit check.** A project may declare a `[unit-check]` table in its
  `crucible.toml` (`command`, a non-empty list of non-empty strings, and an optional `name`). Every client's
  `pre-merge-gate` runs it right after its lint stage, in lint's directory, with the gate's environment
  unchanged. A non-zero exit stops the gate at `stage: unit-check` with a `unit-check-gate-abort` warning, the
  command's output on stderr, and no regression run. With no table the gate goes on, warning
  `unit-check-not-declared`; `--skip-unit-check` skips the stage, and a malformed table is refused, naming the
  file and the field. Crucible's own new `scripts/hermetic/unit-check.sh [bun|python]...` runs each unit tier
  with its recording hooks and judges the logs with `unit-verdict.py`; CI now runs that script for each tier,
  so the local gate can check the unit tiers as CI does. CI also pins uv at 0.13.9, and every e2e scenario's
  page drops its routes at teardown, so a route mock still fetching can no longer fail a scenario that
  passed. The RUNBOOK has a new "Unit check" section.
- **A run can be hermetic, behind a tripwire.** Every client takes `--hermetic` on its six tier verbs,
  `test` and `pre-merge-gate`. The flag runs the test runner in an unprivileged Linux user and network namespace:
  only `lo` is up, every capability is dropped, `HOME` is empty, the `XDG_*` and operator registry variables are
  unset, and `DOCKER_HOST` points nowhere. A tripwire guards the board ports: the project's and the install's
  `[client] url` port, the shipped `default_board_port` 3849, and any `[hermetic] tripwires`. Each connection it
  catches is filed on the run as a leak record, naming the endpoint, the port and, when the runner names it, the test.
  The record adds a failing `tripwire` suite, so the run goes red, and the envelope carries `leaks` and exits
  non-zero.

  `[hermetic] allow_env` passes extra variables through, and a malformed `[hermetic]` table is refused, naming the
  file and the field. Under `pre-merge-gate --hermetic`, `[unit-check]` and every test suite run hermetically, and
  `check` and `[lint]` do not. `--hermetic` is Linux-only. Without `unshare`, `setpriv` and `ip`, or when the kernel
  refuses the namespace, it is refused before anything runs or is filed. Maven refuses `--with-docker --hermetic`.

  The wrapper ships with the client fleet as `clients/_crucible_hermetic.py`, with `clients/_crucible_tripwire.py`.
  It also runs board-free, which is how CI now runs its hermetic steps. It replaces `scripts/hermetic/run.sh` and
  `scripts/hermetic/tripwire.py`, which are removed. The RUNBOOK has a new "Hermetic runs" section.

### Changed

- **The python client's pytest path lives once, in the shared run module.** The pytest argv, its console
  progress, the passing-subtest sign, the exit classification, the import probe, the JUnit report lookup and
  wipe, and the no-report wording are now public names of `clients/_crucible_run.py`, which every client reaches.
  The python client calls them, and its behaviour is unchanged: the same argv, narration, warnings, exits and
  refusals. The probe now answers a timeout itself, and `pytest_probe_timeout()` names the timeout it used.

- **A run repeated back-to-back on the active cycle folds into one chip.** In the Workflow tab's Now pane,
  the active cycle's line folds consecutive settled runs by one agent with equal passed, failed and total figures
  into one chip, `<agent> <passed>/<total> ×<n> <time>`, so a re-run no longer reads as a duplicate. The chip is
  the latest run: its id, colour and click, with `<time>` its clock time (dated when it is from another UTC day).
  Back-to-back aborted runs by one agent fold the same way (`aborted ×<n> <time>`), and an aborted run never
  folds with a finished one. A run that differs breaks the fold, running entries never fold, and a run that
  repeats nothing is drawn as before. The earlier runs stay reachable through the cycle's `→ Runs` badge.

- **A multi-track project's waves always show their track.** A project whose queue declares more than one
  track, in any release, status or lifecycle, now lanes every wave on the roadmap by its own CRs' tracks. A
  wave on one track draws that one lane, and its header reads `· 1 track`. A CR that declares no track in such a
  project carries a `no track` marker in place of its `deps` annotation, because it falls to Mainline until it
  is given one. The table's `track` column shows in such a project too, for any release that declares a track.
  A project declaring one track or none is unchanged.

- **A rust tier verb runs the tests its kind names.** The rust client's `unit` now runs the lib, bin and
  proc-macro tests (`-E "kind(lib) | kind(bin) | kind(proc-macro)"`), and `integration` only the `tests/`
  targets (`-E "kind(test)"`), instead of `--lib` and `--tests`. A declared `[profile.unit]` or
  `[profile.integration]` is run instead, and an explicit `--profile` against it is refused. An undeclared tier
  runs `--profile`, else a declared `ci`, else nextest's `default`; an undeclared `--profile` and an unparseable
  `.config/nextest.toml` are refused. A selection that lists no test is refused with `tier-selection-empty`.
  **`e2e` is now declared-only and loses `--profile`:** it runs only with `[profile.e2e]` declared, answers
  `tier-run-undeclared` otherwise, and `e2e --profile <p>` is now an argparse error (exit 2). The RUNBOOK has a
  new "Rust tier verbs" section.
- **A maven tier verb runs the tests its plugin names.** The maven client's `integration` now runs
  `mvn clean verify -Dtest='!*' -Dsurefire.failIfNoSpecifiedTests=false` and files only failsafe's reports,
  instead of `clean integration-test` filing surefire's too; a `--system-prop` setting `test` on it is refused.
  A `pom.xml` profile whose id is the tier now takes the verb over (`clean test -P<tier>` for `unit` and
  `module`, `clean verify -P<tier>` for the rest) and files every report its run wrote. **`e2e` is now
  declared-only, and `module` needs `--module` or a declared profile:** otherwise each answers
  `tier-run-undeclared`. `e2e --failsafe-only` files only the reports its run wrote. A `--profile` on a declared
  tier, or naming an id no project `pom.xml` and no `~/.m2/settings.xml` declares, is refused before Maven runs
  (`?id`, `!id`, `-id` and `+id` pass through). A selection that ran no test is refused with `tier-selection-empty`: the run
  is aborted, and no compile record is filed. A tier run with no `--agent` now sends Maven's console to
  stderr, so stdout carries only an envelope. The gate's row for a declared profile says the profile was not
  activated. The RUNBOOK has a new "Maven tier verbs" section.
- **An arduino tier verb runs host or target tests by its tier.** The arduino client's `integration` now runs
  `make junit` in `tests/sim` and `e2e` in `tests/hil`, beside `unit` in `tests/native`, instead of refusing
  without a declared target. A `junit-<tier>` target declared in `tests/native/Makefile` runs instead, on `unit`
  too, and `--dir` names another directory whose Makefile alone is read. `integration` and `e2e` with neither a
  place nor a declaration answer `tier-run-undeclared`, naming both. **A `unit`, `integration` or `e2e` run whose
  reports hold no case, or only skipped ones, is now refused** with `tier-selection-empty` and files nothing; a
  narrowed `unit` run that matched nothing takes this refusal too. `regression` and the gate are unchanged. Rust's,
  maven's and arduino's tier-run refusals share one helper. The RUNBOOK has a new "Arduino tier verbs" section.
- **The source package carries only what builds the wheel.** The `crucible-axi` sdist now holds the
  `crucible_axi` package and the client fleet, plus the project metadata (`pyproject.toml`, the
  README, the licence and this changelog), instead of the whole repository. The wheel built from it
  is unchanged. The package's PyPI page now shows the README as its description.

### Fixed

- **A gate drive no longer hangs on the tool's own output.** `gate-run` and `gate-respond` no
  longer hang when no-mistakes prints more than 64 KiB. Its output is read once it exits, and its
  snapshot is sealed and relayed as before, whatever its size.
- **Agents seen in the same millisecond now list newest-registered first.** The agent list put
  agents last seen in the same millisecond oldest-registered first, or in agent-id order within one
  project, although it lists every other agent most recently seen first. Such agents now list newest-registered
  first. A heartbeat does not move an agent in this order. The project list, the open-run list and
  the stale-run sweep also keep a fixed order now when two rows share a millisecond: the order they
  were written in.

## [0.4.0] - 2026-11-21

### Upgrading

- **Re-run `crucible-axi install` after upgrading.** It fills two settings an older install never wrote,
  and never overwrites a value already set:
  - the install's `crucible.toml` gains `[client] url`, built from the port the board already listens on,
    so the clients reach the board through configuration. A client whose project and install name no
    board refuses rather than posting anywhere;
  - the server's own settings file gains `[server] port`, the port that server already boots on (no
    new port is probed).

  The install output lists each file it `filled`, and each it left alone under `notFilled` with the
  reason. An install with no local server has no port to build the url from: declare
  `[client] url = "http://<host>:<port>"` in its `crucible.toml`. The install output warns under
  `boardUndeclared`, naming the file and the key, whenever it leaves no board declared.
- **The rust gate's lint step is renamed.** A stack file or script that reads the rust
  `pre-merge-gate` envelope now sees `stage: "lint"` instead of `"clippy"`, and the warning
  `lint-gate-abort` instead of `clippy-gate-abort`. `--skip-clippy` still works, as an alias of
  `--skip-lint`.
- **Every gate runs a lint stage.** A project with no `[lint]` table, and no default for its stack,
  gets a `lint-not-declared` warning and its gate goes on; declare the project's linter in a
  `[lint]` table of its `crucible.toml` to lint it.
- **Python 3.14 is now the floor.** `crucible-axi` requires Python 3.14 or later; 0.3.0 required
  3.10. uv keeps a tool environment's interpreter across an upgrade, so the install one-liner
  rebuilds an environment that runs an older Python on 3.14, and says so first, naming the Python
  it ran. To upgrade by hand, run `uv tool install --upgrade crucible-axi --python 3.14`.
- **The store migrates from schema v20 to v25.** The first 0.4.0 boot upgrades a 0.3.0 store.
  Before migrating, it writes a recovery copy beside the store, `crucible.db.pre-upgrade-<epoch>`,
  and the boot log names the migration and the backup. A store written by a newer build is refused
  rather than touched.
- **Ingests are bounded by two new server limits.** Both live in the server's own `crucible.toml`,
  beside its database.
  - `ingest_body_bytes`, by default `134217728` (128 MiB), bounds an ingest's request body and a
    run's whole test stream. A larger body, or a stream batch that would pass it, is refused with a
    JSON 413 naming the limit. `GET /api/health` advertises it under `limits`, and the clients
    refuse an oversized body before sending it.
  - `raw_output_chars`, by default `2000000`, bounds the captured runner output a run stores.
    Longer output keeps its first and last halves around a line naming how much was cut. A server
    with no operator file now cuts output that 0.3.0 stored whole.
- **`regression` measures coverage only when asked.** Every client's `regression` runs the whole
  suite as the `regression` tier without coverage unless `--coverage` is given. Without it, maven
  applies no coverage profile and sends no `jacoco.csv`, and rust runs nextest with no
  `cargo llvm-cov` and no `cargo clean`. A coverage-only flag given without `--coverage`
  (`--coverage-profile`, `--lcov-output`, `--keep-target`, `--cov-source`) is refused. The
  `pre-merge-gate` is unchanged.

### Added

- **A Go project reports through its own client.** `go-crucible.py` joins the fleet as its sixth
  client: the install lays it down beside the other five, and the manifest lists it under
  `clients.go`. It runs the toolchain's own `go test -json`, needs go 1.24 or later on `PATH`, and
  streams every test run to the board's `go-test` codec, its total counted first with
  `go test -list`. `test` runs one module; `regression` and `pre-merge-gate` run every module under
  the project dir into one run. Its compile, coverage and tiers are described below, and its
  declaration under "Stack declaration changes".
- **An open run shows its tests as they finish.** A client streams its runner's results to the run
  it opened, through `POST /api/v2/runs/<runId>/stream`, in throttled batches as it is written. The
  board holds each batch it acknowledges, so a restart loses none, and fills the run's live state
  as the batches land.
  - `GET /api/health` gains `codecs.stream`, the codecs whose stream is a run's record
    (`crucible-events`, `go-test`, `nextest`), and `codecs.view`, the codecs that only fill the live
    view (`bun-console`, `surefire-console`).
  - A record stream is decoded into the run at its close, and no final test report is read. The
    `crucible-events` shape is newline-delimited JSON: a `run-start`, one `test-end` per test and a
    `run-end` with the runner's totals. A run whose tests disagree with its `run-end`, that has no
    `run-end`, holds lines that cannot be decoded or was cut at `ingest_body_bytes` is stored
    flagged incomplete. An aborted streamed run keeps the tests it streamed.
  - The Runs tab's running card shows a progress bar, done of total, the current file, the
    failures so far and the timer. It opens a live drill-in at `/run/<runId>` that lists each
    failure as it happens and becomes the run's own page when the run settles. The agent's card
    reads `running N/M · <file>` from the same state, which `GET /api/v2/runs/<runId>/live` serves.
  - Each stack's runner streams. Python's own unittest runner, `subtest_runner.py`, writes the
    stream: the python client no longer uses xmlrunner, and `unittest-xml-reporting` leaves the
    `dev` extras. A pytest run keeps its JUnit report. bun relays `bun test`'s console to the
    `bun-console` view codec and keeps its JUnit report as the record. Vitest and Playwright stream
    through the shipped reporters. rust streams through nextest, arduino through its native
    harness, maven shows its surefire console live, and go streams `go test -json` (see "Stack
    declaration changes").
- **The install ships Vitest and Playwright reporters.** `reporters/vitest-crucible.ts` and
  `reporters/playwright-crucible.ts` land under `<target-dir>/clients/`. The bun client names that
  directory to a run in `CRUCIBLE_REPORTERS`, so a project's Vitest or Playwright config adds the
  reporter from it without naming a machine path. The reporter writes the `crucible-events` stream
  to the file `CRUCIBLE_STREAM` names, and a script declares it in its `crucible.targets` entry
  with `"stream": {"codec": "crucible-events", "path": "env:CRUCIBLE_STREAM"}`.
  - A Vitest run states no total up front, so its live view shows a count with no total.
  - The Playwright reporter files one test per scenario and browser, from its last attempt, with
    its Gherkin steps under it, so a BDD run is counted by scenario, not by step.
- **The board decodes every stack's reports.** Every client sends its runner's own reports to
  `POST /api/v2/runs` and parses nothing itself: its JUnit or stream, its coverage report (`lcov`,
  `jacoco` or `go-coverprofile`) and its captured output, inline. The stored run names the codec
  that decoded it, and every figure a client prints is the board's answer.
  - `data` may be one report or a list of them, merged into one run. A report that cannot be
    decoded is skipped with a warning, and coverage that cannot be decoded is dropped with one.
  - No client posts to `/api/v2/runs/parsed` any more.

- **Every client has a `lint` verb.** `python`, `bun`, `rust`, `go`, `mvn` and `arduino-crucible.py lint
  [--agent ID] [--cycle N]` run the linter a project declares in a `[lint]` table of its `crucible.toml`
  (`command`, a list; optional `format` and `name`) and, with `--agent`, file its output on the compile
  route as a lint record carrying `lint`, `format` and `runnerExit`. The linter's exit is the verdict.
  - The table resolves as `[gate]` does: the project's file, then the install's. A project with no file
    of its own inherits an install-wide `[lint]`, which replaces its stack's default.
  - The defaults: rust runs `cargo clippy --workspace --all-targets --all-features -- -D warnings`, go
    runs `go vet ./...` in each module. Other stacks have none, and answer `skipped: not-declared`.
  - Each `pre-merge-gate` gains a fail-fast lint stage in its own order: python and bun `check` → lint
    → tests, arduino `compile` → lint → tests, rust lint → regression, go lint → its regression run,
    maven lint → docker-up. A failing lint stops the gate with `lint-gate-abort`; nothing declared
    goes on with a `lint-not-declared` warning; `--skip-lint` skips the stage.
  - `runs` and `run` word a lint record as `lint` and its tool; its brief keeps `kind: "compile"`.
  - `check`'s next step names `lint`; a clean lint's names `test`, a failing one's `lint` again.
  - The shipped `crucible.toml` documents `[lint]` in a commented block and declares none.

- **A lint finding reaches the board as a marked compile record.** A linter's run posts to
  `POST /api/v2/runs/compile` with `lint: "<tool>"` and the linter's `runnerExit`, and is stored as a
  lint record: a compile event carrying its linter's name, with no new kind, route or column.
  - The linter's exit is the verdict: a clean exit with no output is filed clean, and a non-zero exit
    whose output records no error gains one synthetic error naming the exit. A lint record answers
    `LINT FAILED — N errors, M warnings` or `LINT OK — M warnings`.
  - Two decoders, `ruff` and `clippy`, and the hint aliases `go vet` and `clang-tidy`. On a lint post
    stating its exit, gcc's no-error fallback to raw is off, so clang-tidy warnings are decoded.
  - The Compile tab draws a Lint group beside the Compile group, each headed with its count. A lint
    card names its tool, carries a broom glyph and reads `N lint errors` (`1 lint error` for one) or
    `lint clean`; its drill-in is headed `<tool> lint` and shows each finding's rule code.
  - `/api/v2/status` gains `lastLint`, and `lastCompile` never holds a lint record. The projects
    rollup gains `lastEventNotLint`, so a project's status line reads as if lint records did not
    exist. Lint records count toward retention as compile records do.
- **A run's coverage is kept and shown file by file.** The board keeps each file of a green run's
  coverage report with the run: its name, its lines and, where the report states them, its
  functions. The Coverage tab lists the files of the project's latest green coverage run beneath
  its totals, least covered first, and a test run's own page shows one coverage line above its
  test tree that unfolds the same table. A run of more than 50 files opens on its first 50, with
  one `show all` control.
  - An `lcov` file is an `SF:` record and a `go-coverprofile` file is a file of the profile's
    blocks, with lines only. A `jacoco` file is a class, since the CSV names no source file.
  - A row shows the name without the directories every file of the run shares. A name too long
    for its cell is cut on the left, and the row's hover title is the whole name. On touch media
    the name is shown whole and wrapped instead.
  - `GET /api/v2/events/<id>?depth=coverage` reads a run's files without its tree or its raw
    output: `coverageFileCount`, `coverageFiles` and `coverageRoot` inside `event`. `&files=<n>`
    answers only the first `n` files. `?depth=suites` carries `coverageFileCount` when the run has
    files.
  - The answer of `POST /api/v2/runs` gains `coverageFileCount` and `coverageFiles` (the first 10
    files) in its `run` block when the run kept files.
  - A failing run keeps no coverage and so no files. A run filed before this change, or through
    `/api/v2/runs/parsed`, has totals only, and the board says `no per-file coverage for this run`.
  - A run's coverage keeps only the files inside the run's tree. A file whose name climbs out of
    the run's tree, such as `../../tmp/x/c.mjs`, is not kept, and the run's `lines` and `functions`
    totals are the sums the report states, less the counters of the files left out, each percent
    taken from what remains. An absolute name is kept. A report whose every file lies outside the
    run's tree keeps no coverage, with one `coverage-dropped` warning.
- **A coverage run's envelope names its least covered files.** Every stack's run that kept coverage
  states a `coverage` block in its envelope: `lines` and `functions`, the run's percents
  (`functions` absent for a run with no functions axis), then `event`, the run's id, `fileCount`,
  how many files the run has, `moreFiles`, how many of them are not listed, and `files`, its 10
  least covered files, least covered first.
  - A row of `files` is `file`, `linesPercent`, `linesCovered`, `linesTotal`, `functionsPercent`,
    `functionsCovered` and `functionsTotal`. The three function keys are null for a file with no
    functions axis. Every figure is the board's own.
  - A run whose answer carries no files states `lines` and `functions` alone. A run that kept no
    coverage states no block.
  - `run <event-id> --files <n>|all` lists a stored run's files in the same block, after
    `failingTests`: the `n` least covered, 10 by default, or every file with `all`. A value that
    is neither is refused before any request, exit 2. A run without files prints as before, and
    a file list that cannot be read refuses the verb.
  - A gate composed of several runs states `coverageRuns`: one row per run whose envelope carried
    a block, in the order the runs ran. A row is `suite`, the whole-suite label or the suite's
    target, `stack`, then the block's own keys. The key is absent when no run carried a block,
    and the gate states no total across its runs. A gate that is one run alone prints that run's
    envelope, with its `coverage`.
- **`test` runs the script a bun project marks.** A `crucible.targets` entry marked `"test": true` is
  the script every `test` runs, with the files and `--name` passed on in the flag its framework takes
  (`-t` for `bun-test` and `vitest`, `--grep` for `playwright` and `playwright-bdd`). The run carries
  the entry's framework. With no files, `test` runs the whole script. With no entry marked, `test`
  runs `bun test`, as before.
- **The bun gate runs every declared framework.** `pre-merge-gate` runs each `test:` script whose
  entry names a framework other than `bun-test` (Vitest, Playwright) as a suite of its own, filed under
  the tier its name names, with its own row, counts and outcome, and its counts in the gate's totals.
  Before this, such a target was reported as covered by `bun test` without running.
  - The whole `bun test` run is skipped only when the package declares at least one bun suite and
    every bun suite, excluded ones included, runs under another framework. The envelope's
    `wholeSuite` field then says so.
  - `--suites <target>` on a non-`bun-test` target runs only that target.
  - These suites measure no coverage, and the gate warns of none.
  - The other stacks' gates are unchanged.
- **The Go client compiles and measures coverage.** `check` runs `go build ./...` in the module
  `test` resolves; `check --tests` compiles every package and test file instead, running no test and
  no vet check. With `--agent`, a failing compile is filed as one compile run of format `go`; a clean
  one files nothing. `--coverage` on `test` and `regression` writes each module's coverprofile in the
  run's own reports dir and sends them all with the run's close, codec `go-coverprofile`.
  - Go coverage is statement coverage, stored on the run's `lines` axis: covered statements over all
    statements, a block listed more than once counted once. The run has no functions axis.
  - The client adds no `-coverpkg`. A project that wants it sets `GOFLAGS=-coverpkg=./...`, which
    every `go` command the client runs inherits.
  - A `--coverage` run is refused before it opens when the board's health does not list
    `go-coverprofile`. When a module's profile was not written, the run is closed with no coverage
    and a `coverage-not-measured` warning naming the module.
- **A Go project declares its tiers by build tag.** The Go client's tier verbs, `unit`, `module`,
  `integration`, `e2e` and `bdd`, run a tier the project declares with `//go:build <tier>` in a
  `_test.go` file that declares a test. A tier verb runs only the tests its tag adds, never an
  untagged test, into one run filed under its tier. A tier no module declares is refused, and so is a
  tier test whose name is also declared in a test file the untagged build compiles, since `-run`
  cannot select it alone. `regression` runs the untagged tests and then every declared tier's tests,
  in one run. The `pre-merge-gate` runs each declared tier as a suite with its own row, filed under
  that tier, beside the `untagged` row, the whole run, filed under `regression`; `e2e` is listed and
  excluded.
  - The Go client's `check --tests` also compiles each declared tier's test files under its tag
    (`-tags <tier>`). Every compile runs, and the failing ones are filed as one compile run, each
    error once.
  - The Go client's `unit` run carries the `unit-run-wall-exceeds-cpu` warning when it spends its
    wall time waiting, as the other clients' `unit` runs do.
- **A Go run ticks its progress.** While the relay lands no batch, a Go run posts `running N/M`,
  with N its top-level test results so far and M its listed total (`running N` when its listing
  failed), as every other stack does. Subtests are not counted. Under a gated run, the ticks are
  observed by the run's gated identity.
- **A release's notes are drafted from the board.** Every client's `release-notes --release <label>`
  drafts the release's `CHANGELOG.md` section: its `## [<label>] - YYYY-MM-DD` heading, then one
  `### Changed` line per CR the release completed, each carrying the CR's title and its id, in the
  order the CRs landed. The lines are a draft, to be edited and sorted into their groups before the
  notes are committed.
  - `--format markdown` prints the section alone, ready to paste. Under `toon`, the default, and
    `json`, the envelope carries the section as `lines`, with `release`, `state`, `date` and
    `count`.
  - The heading's date is the UTC day the release shipped, else today's UTC date.
    `--date YYYY-MM-DD` sets it.
  - A title is the CR's latest merged plan's, else its queue entry's, and is written on one line.
    A CR with neither is its id alone.
  - The verb only reads the board and takes no `--agent`.
- **A project registers itself on the board.** Every client's `project-create --project-dir <root>
  --name <name> --token <token> --agent <id>` creates the project, or finds it, and prints its key.
  The key is derived from the token, so a re-run with the same token answers the same project with
  `created: false`, whatever its `--name`. A UUID key already in the project's `.env` is used and
  never replaced; one the board does not know, or whose project is archived, is refused.
  - `--project-dir` is required: the verb never looks for the root in the working directory or git.
  - The same call registers `--agent` as the project's ORCHESTRATOR and seeds its metadata:
    `PROJECT_TOKEN`, `PROJECT_ACRONYM` (with `--acronym`) and each `--set KEY=VALUE`.
  - `--write-env` writes `CRUCIBLE_PROJECT_KEY=<key>` into `<root>/.env` when its key line is
    empty or missing, keeping every other byte. Without it, `.env` is never written.
- **`runs` and `run` read stored runs back.** Every client's `runs --cycle <id>` or
  `runs --release <label>` lists that cycle's or release's stored test and compile runs, newest
  first, a compile row with its errors and warnings and a test row with its counts.
  `run <event-id>` shows one run of the client's own project, with its failing tests. Both only
  read the board and take no `--agent`.
- **The python client runs a pytest project.** `[python] runner = "pytest"` in the project's own
  `crucible.toml` (or `"unittest"`, the default) chooses the runner for `test`, `regression`, the
  tier verbs and `pre-merge-gate`, and `--runner <name>` overrides it for one call. A value that is
  neither name, or `pytest` with an interpreter that cannot import it, is refused before anything
  is posted. A pytest collection error is filed as a failed test. A run whose passing subtests
  pytest left uncounted carries a `subtests-uncounted` warning.
- **An arduino agent can run only its own native tests.** `test` and `unit` take
  `--tests <stem> …`, handed to `make` as `TESTS`, and `--name <names>`, handed to `make` as
  `TEST_NAME` for Unity's `-f`. Ill-formed input is refused with `narrowing-refused` before
  anything reaches the board. The tier verbs, `regression`, `auto-ingest` and the gate never
  narrow.
- **A scoped re-run after a red gate can close the CR.** `pre-merge-gate --suites <targets>` runs
  only the named declared suites. Each gate milestone records its `scope` (`full` or `scoped`) and
  one `suites` entry per suite it ran, with its outcome, counts and failing tests, and
  `GET /api/health` states `milestones: {gate: ["scope", "suites"]}`. `cr-close` judges suite by
  suite: the latest full gate is the base, and a later result for one of its suites replaces that
  suite's. Every envelope also states `events`, the ids of the runs the call filed.
- **The arduino stack's compile errors are decoded.** The board gains a `gcc` compile codec for
  GCC and g++ diagnostics and both linker shapes of `undefined reference`, and the arduino client
  names it on its compile ingest. A `note:` belongs to the diagnostic above it. A `gcc` report with
  no error falls back to the raw report, so a failed build never reads clean. The Compile pane
  omits a missing line or column instead of printing `undefined`.

### Changed

- **A client with no board declared refuses.** A client whose project and install `crucible.toml`
  name no `[client] url` now refuses every verb that must reach the board, with one envelope naming
  each file and why it was passed over, instead of posting to the server's packaged port. The
  shipped `clients/crucible.toml` declares no board; the installer writes the install's. An install
  with no local server must declare `[client] url = "http://<host>:<port>"`. An upgraded install whose
  file never named a board has none until `crucible-axi install` is re-run, which fills it from the
  local server's port. A verb that sends nothing still runs, and every client's `--help` ends with a
  "Board:" paragraph naming where its board comes from.
- **The `junit` readings follow the framework.** pytest's grouping by classname applies to a run of
  framework `pytest` whose report holds one suite named `pytest`, and bun's console reading to a run
  of framework `bun-test`, whatever the run's stack. A close that states no framework reads under the
  one its run was started with. A run that states none (any client older than 0.4.0) gets neither
  reading.
- **The python client states its runner as the framework.** Every run `test`, `regression` and each
  `pre-merge-gate` tier file states `pytest` or `unittest`. `auto-ingest`, which runs nothing, states
  the runner `[python] runner` declares in the project's `crucible.toml`, else `unittest`.
- **The store migrates to schema v25.** The runs filed through the `playwright` codec move to
  framework `playwright-bdd`, in the shape the stream stores: a suite per feature and browser, a case
  per scenario, its steps under it. They are recounted by scenario, not by step, so a run whose
  scenario failed with no failing step turns red. Each keeps `codec` `playwright` as the record of
  how it was filed. A suite's `feature` is now set only on a `playwright-bdd` run.
  - Days already folded into the rollups keep their step counts.
- **The specification view is chosen by framework.** The run detail opens a test run of framework
  `playwright-bdd` as feature → scenario → step, whatever its codec.
- **A bun project's `regression` and gate run the script it marks.** On a project whose
  `crucible.targets` entry is marked `"test": true`, `regression` and the `pre-merge-gate`'s
  whole-suite step run that script in place of `bun test`, filed under `regression`, and a full gate
  never skips that run. The gate runs every other declared bun suite on its own, whatever its
  framework, and records only the marked script's suite as covered by the whole-suite run. Coverage
  flags go only to a `bun-test` entry with `junit: flag` (or a script with no entry); any other
  script run with `--coverage` carries one `coverage-not-measured` warning. An unmarked project runs
  as before.
- **A client finds its board in the install when its project names none.** A client takes
  `[client] url` from the first `crucible.toml` that declares a non-empty one: the project's, then
  the install's. A file without one, or one that does not parse, is passed over, and when neither
  declares one the client refuses. Before this, a project file without `[client]` sent every verb to
  the server's packaged port and the install's file was never read. The limits and `[gate] skip`
  keep the first file that parses. An envelope names `context.board` only when the board differs
  from the install's declared `url`, or always when the install declares none.
- **A re-install fills in the connection an older install never wrote, keeping the live port.** An
  existing server `crucible.toml` with no `[server] port` gains the port its server boots on today,
  the template's own `port`, with no probe. An existing install `crucible.toml` with no `[client] url`
  gains the board url built from that port. Only an absent key is filled; a value already set, in
  any form, is never overwritten. The `[manifest]` stage names each file it filled with its key and
  value under `filled`, and each file it could not safely touch with the reason under `notFilled`.
  The range is probed only for a server file the install lays down fresh.
- **The project's ruff rule set is pinned.** `pyproject.toml` declares `[tool.ruff.lint]` with
  `select = ["E4", "E7", "E9", "F"]`, so `ruff check` reads the same rules on every machine, and
  `ruff` joins the `dev` optional dependencies (`pip install '.[dev]'`). `clients`, `crucible_axi`
  and `tests` pass it clean. The installer's own tests now declare only ephemeral ports in the
  server templates they provision, never one in the shipped 3800–3899 window.
- **No project is anyone's default.** `[bun] package_dir` and `[python] runner` are read from the
  project's own `crucible.toml` only, never the install's. The bun client's `integrations/pi`
  fallback is gone: the package dir is `--package-dir`, then `$BUN_CRUCIBLE_PACKAGE_DIR`, then
  `[bun] package_dir`, then the project root. A declared package dir that holds no `package.json`
  is refused before anything is posted.
- **No client creates a project.** The arduino client no longer registers the key its `.env`
  names, so a run under a key no project holds is refused by every client. The envelope carries the
  board's `unknown project: <key>`, its `help[]` on registering a project, and a warning naming the
  `.env` the key was read from. The arduino client no longer reads `CRUCIBLE_PROJECT_NAME`.
- **`finish` refuses a release with no notes.** `scripts/release.sh finish` reads the version's
  `CHANGELOG.md` section as committed at the release branch's HEAD, through
  `scripts/release-notes.sh`, the extractor the release workflow also uses. It refuses, before it
  writes anything, when the section is missing or empty or its heading carries no date. Its
  provenance report reads the queue through `queue --format json`, which every client now accepts,
  and no longer lists voided CRs as work that never landed.
- **A gate files a python suite under the tier its start directory names.** When a gate's python
  suite is a `python -m unittest discover -s <dir>` script whose `<dir>` ends in a tier the gate
  covers (`unit`, `integration`, …), the gate runs it as that tier's verb, so the board shows its
  run as that tier. Any other start directory still runs as `regression`.
- **The suites declare their tiers by directory.** `test:client` is replaced by `test:client-unit`
  and `test:client-integration` (`tests/client/<tier>`), and `test:unit` / `test:integration` run
  `./tests/unit` and `./tests/integration` by path. The source-text classifier
  `scripts/test-targets.ts` is gone; a test's tier is the directory that holds it.
- **The client suite runs offline from its own caches.** Run `scripts/provision-test-caches.sh` once,
  online, to fill the suite's maven repository under `.cache/test-suite/`; the suite fills its go
  and uv caches there itself. The `dev` extra now also carries `hatchling` and `hatch-vcs`, so the
  suite builds its wheels with `--no-isolation`.

### Removed

- **⚠ The bun client's older declaration keys are refused.** A `package.json` declaring
  `crucible.reportPath`, `crucible.rawReport` or `crucible.testScript` is refused by `test`,
  `regression`, every tier verb and `pre-merge-gate`, before anything is filed. Declare
  `crucible.targets` instead:
  - `crucible.reportPath.<script>` becomes the entry's `junit` (`flag` or `env:<VAR>`);
  - `crucible.rawReport` becomes the entry's `stream`;
  - `crucible.testScript` becomes `"test": true` on the script's entry.
- **⚠ The `playwright` codec.** The board no longer accepts Playwright's JSON report: a
  `POST /api/v2/runs` naming `codec: "playwright"` is refused with 400 `unknown codec: playwright`,
  and nothing is stored. `GET /api/health` no longer lists `playwright` under `codecs.test`, which
  now lists `crucible-events`, `go-test`, `junit` and `nextest`. A
  Playwright run files through the shipped reporter's `crucible-events` stream instead.

### Fixed

- **A filed lint run is named in its envelope's `events`.** `lint --agent` lists the board's event
  for its run in `events`, as every verb that files a run does; `events` stays empty when nothing
  was filed.
- **The Runs tab stays responsive while a run streams.** A streamed batch updates only the running
  cards, which sit in a container of their own; the timeline of settled runs is no longer rebuilt
  and re-styled on every batch. The timeline's rows skip their style and layout while off screen.
  The same holds on the home timeline.
  - A run card's agent id wider than the card now ends in an ellipsis inside the card.
  - The dashboard no longer loads the Tailwind browser runtime. What it generated (its theme
    variables, base reset and two utilities) is served as a static, vendored stylesheet
    (`/vendor/tailwind-4.2.4.css`) linked after the dashboard's own, so a class name entering the
    page no longer rewrites a stylesheet. The page looks as before.
- **A run keeps the stack it was made on.** Every client states its stack on every ingest, and the
  board carries a run's start stack and tier onto the event that closes it. A closing ingest whose
  stack, tier or framework differs from its start's is refused with 400, and nothing is written.
  `stack` now comes back on the events list and every brief, not only on the detail read.
- **Every python subtest is counted, pass or fail.** A unittest run counts each passing subtest as
  its own case, so a suite's total no longer shrinks when its subtests pass.
- **A python project's coverage config decides what is measured.** With no `--cov-source`, the
  python client reads the project's own coverage.py configuration. When it declares what to
  measure, the run passes no `--source`; when it declares nothing, the run measures the project
  root and warns `coverage-source-undeclared`. An earlier run's coverage data is erased first, so
  it is never merged into the next run.
- **An interrupted run leaves nothing behind.** A SIGINT or SIGTERM anywhere in a test verb's run
  removes the agent's run identity, aborts the opened run and exits 128 plus the signal number, with
  one envelope naming the signal. A signal during the ingest lets the ingest finish first, so the
  results the runner earned are kept.
  - An interrupted runner's whole process tree is taken down, so a server it started no longer
    outlives it.
  - The bun client gives every test runner it spawns a run-scoped `TMPDIR` and removes it when the
    runner exits.
  - A runner that exits non-zero with an empty report is a failure, never a `total: 0` run.
- **A runner that failed is never filed as green.** Every client sends its runner's exit code with
  each test ingest as `runnerExit`. When it is non-zero and the report records no failure, the
  board adds one failing case, suite `runner`, case `exit <n>`. A verb exits non-zero whenever its
  runner did or its run has a failure, and each bun test file that fails to load is a failing case.
- **A bun test run refuses an entry that names no test.** `bun-crucible.py test --tests` reads its
  entries as paths relative to the package directory. When one names nothing that exists
  (`tests-not-found`) or names a file that is not a test (`tests-not-a-test-file`), nothing runs,
  no run is opened, and one envelope lists the refused entries; before, bun read a missing entry as
  a file-name filter that matched nothing and ran the rest green. The entries reach `bun test` as
  `./` paths, so an entry no longer also selects other files whose path contains it. A script the
  `crucible.targets` table marks as `test` still receives the entries unchanged, as its runner's
  filters.
- **A python run through a symlinked install imports the project's own modules.** When the
  install's `clients` directory is a symlink, the python runner still puts the working directory
  first on the module search path, so a project's tests import its own modules (CR-CRU-260).
- **A rust project outside git takes no gate lock.** The rust gate lock is no longer placed in the
  parent directory of a project outside git, where every such project shared it. Such a run goes
  on unlocked and says so on stderr.
- **A dropped connection is answered.** When the board resets or drops a connection mid-request, a
  client answers `connection lost: …` naming the board instead of failing with a traceback. It
  reports the run as it reports one an unreachable board never took, and tries to abort the open
  run: `run-aborted` when the board takes the abort, `run-left-open` when it cannot reach the board
  either, and a warning that the board may hold the run when it was already settled.
- **A gate decision and a release are reported as they happened.** `gate-respond` judges a decision
  by whether the step it answered moved on, so a decision no-mistakes accepted is recorded and
  reported as accepted even when the wait ran out. A held run's report names the reattaching
  command, `gate-run --intent "<intent>"`. A gate snapshot posted with no release keeps the release
  of the run's earlier snapshots, and `history --release` tells a planned release the project holds
  from an unknown one.
- **Board fixes.**
  - On a phone, a tap on a history cycle line opens its runs: `→ Runs` sits only in the expanded
    runs there, and on a touch screen the pill has a target of at least 44 px wherever it shows.
  - A milestone, gate or compile result is never drawn as a run chip on a cycle line, the collapsed
    cue counts only test runs, and an aborted run's chip reads `aborted`. The project's status line
    reads its newest test run or compile result, never a `0/0` milestone.
  - The run detail's failure jump counts the failures not yet opened (`▸ 1 more failure`), its first
    press opens the first failure, and once every failure has been opened it reads
    `▸ failure k of N`.
  - An agent's card follows its streaming run's live counts from the first batch.
  - An agent's card keeps a long running file inside it: the count stays whole and the path is cut
    from its start, with the whole path as its hover title.
  - A tombstoned agent's runtime is never negative.

### Stack declaration changes

The stack declaration schema:

- **The installer ships `crucible-declaration.schema.json`, version 3.** It lands beside the clients
  at `<target-dir>/clients/crucible-declaration.schema.json` (`~/.crucible/clients/` by default).
  An upgrade overwrites it; an uninstall leaves it, like every fleet file.
- **The manifest lists it.** `crucible-clients.json` gains `declaration_schema: {path, version}`,
  the version read from the packaged copy. A packaged schema that is missing, is not JSON or has no
  integer `version` fails the install fail-fast, naming its path.
- **The writer rule.** A declaration writer writes only the stacks and fields it knows. It warns
  when the schema's `version` is newer than the one it was built for. It never removes a field it
  does not know. With no schema installed it writes nothing it cannot check.
- **Version 2 adds the `go` stack.** `crucible-declaration.schema.json` gains a `go` stack, which
  reads no `[targets]` entry and declares only its `[go] module_dir` table.
- **Version 3 exempts the marked entry from the bun gate's key rule.** The bun `entry.key.gate`
  descriptor gains `"marked": "exempt"`, and the bun `marker` descriptor gains
  `"read_by": ["test", "regression", "pre-merge-gate"]`: `test`, `regression` and the gate read
  the marked entry. A reader computing the gate rule from version 2 would refuse it.

For the bun stack (`package.json`'s `crucible` block):

- **Refused keys.** `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` are refused,
  with or without `crucible.targets`, by every verb and by `pre-merge-gate` before its tsc step. The
  refusal (`declaration-refused`) names each key and what replaces it, exits non-zero and files
  nothing.
  - `reportPath.<script>` becomes `crucible.targets.<script>.junit`.
  - `rawReport` becomes `crucible.targets.<script>.stream`.
  - `testScript` becomes `crucible.targets.<script>.test: true`.
- **The `"test": true` marker.** `test`, `regression` and the gate (`pre-merge-gate`) read the
  marker; the tier verbs ignore it.
  - Each of them refuses it when two entries carry it, when it is anything but `true` (an unmarked
    entry omits the field, so `false` is refused too), or when the marked script is missing from
    `scripts` or has an empty body. The gate refuses before its tsc step, posting nothing.
  - The gate also refuses, before its tsc step, a marked entry whose own entry is refused, and a
    marked entry whose key names a tier the gate excludes (`test:e2e`), which `regression` runs.
  - `--name` is passed as `-t` to `bun-test` and `vitest`, and as `--grep` to `playwright` and
    `playwright-bdd`.
- **The gate.**
  - `pre-merge-gate` runs each non-`bun-test` target as its own suite.
  - It refuses a non-`bun-test` entry whose key is not a `test:` script, or is a `test:` key with
    no script of that name in `scripts`, because it could not otherwise run it. The marked entry is
    exempt: it is the gate's whole-suite run.
- **Playwright's JSON report.** A Playwright config needs no `json` reporter: the client no longer
  points one (`PLAYWRIGHT_JSON_OUTPUT_NAME`) into a stream run's reports dir, and the board no longer
  reads it. Remove the `json` reporter from the config. The `junit` reporter stays, still pointed by
  `PLAYWRIGHT_JUNIT_OUTPUT_NAME`.
- **Model B surfaces to reword.** The `block-direct-bun-test` hook and the bun agent templates name
  `crucible.testScript` and `crucible.reportPath`. They should name the `crucible.targets` entry's
  `"test": true` marker and its `junit` instead.

For the python stack (`crucible.toml`):

- **`auto-ingest` reads `[python] runner`.** It states that runner as the run's framework, so a
  pytest project that files through `auto-ingest` declares `[python] runner = "pytest"`. With nothing
  declared, its runs state `unittest` and get no pytest grouping. A declared value that is neither
  `pytest` nor `unittest` is refused, with an envelope and nothing posted, as the running verbs
  refuse it. `auto-ingest` takes no `--runner` and does not check that pytest imports.

For the rust stack (`crucible.toml` and `.config/nextest.toml`):

- **Every run streams through nextest.** With an agent, `test`, `unit`, `integration`, `e2e`,
  `regression-ingest`, `smoke-test`, `docker-e2e-gate`, `workspace-regression`, `regression` and
  `pre-merge-gate` list their tests, run them with nextest's `libtest-json-plus` stream on, and the
  board files the run from that stream. They no longer file nextest's JUnit report; `auto-ingest`
  still does.
- **The `[targets.<profile>]` table.** A project declares its runs in its own `crucible.toml`, keyed
  by nextest profile, with bun's `crucible.targets` vocabulary. The rust entry is
  `framework = "nextest"` with `stream = { codec = "nextest", path = "stdout" }`. Undeclared
  profiles (no entry, or no `crucible.toml`) stream by default as if they declared it. Another
  stack's entry (one naming another stack's framework, `go-test` included) is now skipped rather
  than refused. Any other entry, or a project file that does not parse, is refused before anything
  runs. The install's file
  never declares.
- **The standard profiles.** A scaffold sets up `default` and `ci` (every test but the docker tier)
  and `e2e` (the docker tier alone, run by `docker-e2e-gate`) in `.config/nextest.toml`. A declared
  tier profile no longer needs a `junit` table.
- **The minimum nextest.** cargo-nextest 0.9.130 or later is required; an older one, or one whose
  version cannot be read, is refused before anything runs.
- **`--ignore-run-fail` is retired.** `workspace-regression` and `regression` refuse it: a coverage
  run now always writes its lcov with `cargo llvm-cov report --failure-mode all`.
- **A board that lists no `nextest` under `codecs.stream`** refuses the run before anything runs.
- **The gate's clippy step is its lint stage.** `pre-merge-gate` runs `lint` first, whose rust default
  is the same workspace clippy command, so a project with no `[lint]` lints as before. A declared
  `[lint]` replaces it. Model B's stack files read the gate's envelope; the mapping:

  | Before | After |
  |---|---|
  | `stage: "clippy"` | `stage: "lint"` |
  | `errors`, `lints` | `errors`, `lints` (unchanged), null when the board refuses the lint post |
  | `clippy-gate-abort` | `lint-gate-abort`, the same in every client |
  | `--skip-clippy` | `--skip-lint`; `--skip-clippy` stays as its alias |
  | `CARGO_BUILD_JOBS` env | unchanged |

  `clippy` and `workspace-clippy` keep their arguments; their records now carry `lint: "clippy"`,
  and a failing `clippy` exits non-zero.

For the arduino stack (`crucible.toml` and the native `Makefile`):

- **A declared target streams its tests.** A project declares a native run in its own
  `crucible.toml`, keyed by native dir (`--dir`, relative to `--project-dir`) joined by `/` to the
  make target: `[targets."tests/native/junit"]` with `framework = "arduino-native"` and
  `stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }`. Every field is required;
  `junit`, `console` and `coverage` are refused, as is a project file that does not parse. Another
  stack's entry is skipped, and `go-test` now joins that skip set: a `go-test` entry, refused before,
  is skipped. An undeclared target runs as before.
- **The `CRUCIBLE_STREAM` make contract.** On a declared run with an agent, `make` is handed
  `CRUCIBLE_STREAM`, the absolute `<REPORTS_DIR>/crucible-events.ndjson`, emptied first. The
  harness appends one `test-end` line per test as it ends (`pass`, `fail` or `pending`), in one
  write, flushing after each line. It writes no `run-start` and no `run-end`: the client appends the
  `run-end` from the run's `TEST-*.xml`, which the harness still writes. When the variable is unset,
  the harness writes nothing.
- **A board that lists no `crucible-events` under `codecs.stream`**, or no `lcov` for a coverage
  run, refuses a declared run before anything runs.
- **Model B surfaces to update.** Native harness templates adopt the stream; Crucible ships none.

For the maven stack (`crucible.toml`):

- **The `[targets.<tier>]` table.** A project declares a tier's console in its own `crucible.toml`,
  keyed by the client's tier vocabulary (`unit`, `module`, `integration`, `e2e`, `bdd`,
  `regression`; `test` reads `unit`, and `pre-merge-gate` reads `regression`). The maven entry is
  `framework = "surefire"` with `console = "surefire-console"`. Both fields are required; `junit`,
  `stream` and `coverage` are refused, as is a project file that does not parse, before any board
  call, `docker-up` or maven. Another stack's entry is skipped, and `go-test` now joins that skip
  set: a `go-test` entry, refused before, is skipped. A tier with no entry runs as before.
- **The `surefire-console` view codec.** A declared console is read on the board by the
  `surefire-console` view codec. A board whose health lists no `surefire-console` under
  `codecs.view` refuses a declared run before anything runs; a health that cannot be read refuses
  nothing.

For the go stack (`crucible.toml`):

- **The `[go] module_dir` table.** A project may declare the directory holding its `go.mod` as
  `[go] module_dir = "<dir>"`, relative to the project dir. `test` reads it after `--module-dir`,
  `GO_CRUCIBLE_MODULE_DIR` and the nearest `go.mod` at or above the working directory. A project
  file that does not parse declares nothing. `regression` and `pre-merge-gate` read no declaration:
  they run every module under the project dir (skipping `vendor`, `testdata`, `node_modules` and
  hidden dirs) into one run.
- **`TestMain` runs twice per run.** The `go test -list` that counts the run's total builds and
  starts every test binary once more, so a package's `TestMain` runs twice: once for the list and
  once for the run. A `TestMain` with side effects should tolerate that.
- **Below Go 1.27 the board reads the text form.** That form cannot tell a `t.Log` line from a
  `t.Error` line. So a test's log lines are carried in its failure message, and a parent's own
  error beside a failing subtest is carried by the subtest's failure, not counted as its own case.

## [0.3.0] - 2026-10-10

38 change requests (wave 7).

### Upgrading

- **The store migrates itself.** The first 0.3.0 boot upgrades a 0.2.x store from schema v13 to
  v20. Before migrating, it writes a recovery copy beside the store,
  `crucible.db.pre-upgrade-<epoch>`. Each step runs in its own transaction, and the boot log
  names the migration and the backup. A store written by a newer build is refused rather than
  touched.
- After upgrading the `crucible-axi` package, run `crucible-axi install` to lay the clients down
  again.

### Added

- **Workflow is two panes: Now and History.**
  - Now shows the work in flight, including a running gate as a live run whose held step reads
    "awaiting your decision".
  - History is told by release, with waves folded inside each release. It shows only the past,
    with a count of what is still pending.
  - A cycle's recorded change sits beneath its line.
- **A gate's decisions are recorded** beneath its step ladder, and a sealed gate summarises them
  in History.
- **Responsive layout.** The phone band is one column with nothing hidden, the tablet band stacks
  the pane while the main column stays, and every tab (Roadmap, Workflow, Runs, Coverage, Compile,
  BDD) reads at both sizes.
- **Analytics.** SCRUM velocity in the Project band, read per day or per week; a release burndown
  that fills its pane and draws the projection; velocity and the forecast follow the release so
  far.
- **BDD.** The tab is an index of runs, with one Gherkin renderer that reads as a specification.
  The e2e suite reaches the board with its scenarios intact.
- **Clients:**
  - `queue --fields` shows each CR's place in the plan, with a `warning` column; `--full` shows
    every column.
  - A new `history` verb, in all five clients, lists releases with their CRs and what is pending.
  - Test runs are filed per cycle with `--cycle`, and release verification under its release with
    `--release`.
  - A project can declare the gate steps it never runs in `crucible.toml` `[gate]`, so `gate-run`
    no longer needs `--skip` on every call.
- **A project carries its own metadata,** mirrored from the project's own settings.

### Changed

- **⚠ The connection is configuration now, not environment.**
  - `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are no longer read. The server takes its listener from
    the `[server]` table of the `crucible.toml` beside its database, falling back to the shipped
    default (`127.0.0.1:3849`).
  - The clients no longer read `$CRUCIBLE_URL` (or arduino's `$CRUCIBLE_BASE`). They take the
    board from the project's `crucible.toml` `[client]` table.
  - If you set any of these variables, move the value into the file.
- **`status`** shows the work in flight, not the project's history.
- **Plans** grow only by fix cycles, and a skipped cycle is recorded as a failure.
- **Storage and reads.** A run's detail is stored as rows, not JSON text. A list read loads no
  run's detail, and a plan read is cheap enough that analytics need no cache.
- **Release process.** Every push to a `release/**` or `hotfix/**` branch is the TestPyPI and npm
  dry-run rehearsal (`scripts/release.sh checkpoint` only re-runs one), and a rehearsal is
  versioned as the release it rehearses (`0.3.0.devN`, not `0.2.3.devN`).

### Fixed

- **The board:**
  - The agent card tells the truth about the agent.
  - A heat-strip click brings its test into view.
  - A voided CR's row is struck through and names its state.
  - The phone Compile pane no longer collapses.
  - The history cycle row is clickable where it looks clickable.
  - The Projects manager drawer fits its width, and each setting says what it does.
  - A run's detail stays responsive while agents are running.
- **The clients:**
  - Interrupting `gate-run` (SIGINT/SIGTERM) always removes its run identity from the board, even
    when the signal lands while the identity is still being opened.
  - A closed output pipe (`| head`) no longer leaves a run open.
  - Each test run keeps its reports to itself, and a run nothing will file is closed at once.
- **CI passes on a clean runner again:**
  - the client tests no longer read a developer's configuration;
  - the e2e drive counts the phone feature once per browser engine;
  - the WebKit phone tap is engine-neutral.

[0.4.0]: https://github.com/anthill-tec/crucible/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/anthill-tec/crucible/compare/0.2.2...0.3.0
