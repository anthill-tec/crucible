# Changelog

All notable changes to Crucible — the `@anthill-tec/crucible-server` npm package and the
`crucible-axi` PyPI package, which are released together under one version — are recorded here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section is
also the body of its [GitHub Release](https://github.com/anthill-tec/crucible/releases).
Releases before 0.3.0 are described only on GitHub Releases.

## [Unreleased]

### Added

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

### Changed

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
  and nothing is stored. `GET /api/health` lists `codecs.test` as `crucible-events` and `junit`. A
  Playwright run files through the shipped reporter's `crucible-events` stream instead.

### Fixed

- **The Runs tab stays responsive while a run streams.** A streamed batch updates only the running
  cards, which sit in a container of their own; the timeline of settled runs is no longer rebuilt
  and re-styled on every batch. The timeline's rows skip their style and layout while off screen.
  The same holds on the home timeline.
  - A run card's agent id wider than the card now ends in an ellipsis inside the card.
  - The dashboard no longer loads the Tailwind browser runtime. What it generated (its theme
    variables, base reset and two utilities) is served as a static, vendored stylesheet
    (`/vendor/tailwind-4.2.4.css`) linked after the dashboard's own, so a class name entering the
    page no longer rewrites a stylesheet. The page looks as before.

### Stack declaration changes

The stack declaration schema:

- **The installer ships `crucible-declaration.schema.json`, version 2.** It lands beside the clients
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

For the bun stack (`package.json`'s `crucible` block):

- **Refused keys.** `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` are refused,
  with or without `crucible.targets`, by every verb and by `pre-merge-gate` before its tsc step. The
  refusal (`declaration-refused`) names each key and what replaces it, exits non-zero and files
  nothing.
  - `reportPath.<script>` becomes `crucible.targets.<script>.junit`.
  - `rawReport` becomes `crucible.targets.<script>.stream`.
  - `testScript` becomes `crucible.targets.<script>.test: true`.
- **The `"test": true` marker.** Only `test` reads the marker; the tier verbs and the gate ignore it.
  - It is refused when two entries carry it, when it is anything but `true` (an unmarked entry omits
    the field, so `false` is refused too), or when the marked script is missing from `scripts` or has
    an empty body.
  - `--name` is passed as `-t` to `bun-test` and `vitest`, and as `--grep` to `playwright` and
    `playwright-bdd`.
- **The gate.**
  - `pre-merge-gate` runs each non-`bun-test` target as its own suite.
  - It refuses a non-`bun-test` entry whose key is not a `test:` script, or is a `test:` key with
    no script of that name in `scripts`, because it could not otherwise run it.
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

[Unreleased]: https://github.com/anthill-tec/crucible/compare/0.3.0...HEAD
[0.3.0]: https://github.com/anthill-tec/crucible/compare/0.2.2...0.3.0
