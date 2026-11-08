# CR-CRU-195 — a Go project reports to the board through its own client

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-200,
CR-CRU-238 · **Status** PENDING — filed 2026-10-18 (Model B request, user ruling: its own CR in
0.4.0, decoded on the server after CR-CRU-152); made exact at gap analysis 2026-11-08 (user rulings
2026-11-08: split, compile errors and coverage move to CR-CRU-239; the total from `go test -list`;
no tier verbs before CR-CRU-196; the gate covers every module; the module you are in comes before
`crucible.toml`) · Pre-review: ran — 13 points and user rulings (findings F1–F16, all folded)

## Problem

Raised by Model B (2026-10-18). Model B is adding Go as a generated stack (CR-MDB-080, their release
1.1.0). Model B ships no client, so that stack waits on Crucible's. The motivating project is a
Go 1.26 backend with two `go.mod` modules, tested with `testing` plus testify, beside a Bun
frontend (`PROJECT_STACKS=go,bun`).

Crucible's fleet has five clients (bun, python, mvn, rust, arduino) and none for Go. A Go project
cannot register, run, ingest or gate through the board.

## Design (settled with the user, 2026-10-18; made exact 2026-11-08)

- **Decoded on the server.** The client sends Go's own output to a server codec, the direction
  CR-CRU-152 sets for every stack. The stored run names the codec that decoded it.
- **The runner is the toolchain's own.** `go test -json`; no third-party runner is required.
- **Always a stream.** `go test -json` is Go's native, stable stream (DN-crucible-live-test-progress).
  Every Go test run is an open run that streams its tests through a `go-test` stream codec, as a rust
  run streams through `nextest` (CR-CRU-233). There is no declared-or-not switch: Go reads no
  `[targets]` entry.
- **The total comes from `go test -list` (user ruling).** Before the run, the client runs
  `go test -list <re> -json` with the run's own selection (the same packages, and in CR-CRU-196 the
  same `-tags`), counts the names it prints, and states the count as the run-start total, as the DN
  says a runner's own total is carried. There is no server list route.
  - The count is the listed `Test*`, `Fuzz*` and `Example*` names. `Benchmark*` names and the
    package summary lines (`ok …`, `? … [no test files]`) are not counted. An `Example` with no
    `// Output:` is neither listed nor run.
  - `<re>` is `.` with no `--run`, and the top-level element of `--run` (before its first unbracketed
    `/`) with one.
  - Go cannot list subtests, so the total counts top-level tests and climbs as subtests report.
  - The list builds and starts every test binary, so **a package's `TestMain` runs twice** per run.
    The user accepted this cost; the release notes tell Model B.
  - A list that exits non-zero still gives the names it printed. A list that cannot be read gives no
    total, with a warning; the run goes on.
- **Tiers are a separate CR (user ruling).** The Go client has no tier verbs until CR-CRU-196
  declares tiers by build tag, as the python client has none. Nothing is filed under a tier it did not
  declare.
- **The gate covers every module (user ruling).** `go test ./...` cannot span two modules, so
  `regression` and `pre-merge-gate` find every `go.mod` under the project dir (skipping `vendor`,
  `testdata`, `node_modules` and hidden dirs) and run each module's `./...` into the one run. `test`
  runs one resolved module.
- **The Go floor is 1.24**, the first with `build-output` / `build-fail` under `-json`. Go 1.27 adds
  `OutputType`; the codec uses it when present and reads the text form otherwise, so a Go 1.26
  toolchain (Model B's project) decodes the same. Below 1.24 the client refuses, naming the version.
- **Compile errors and coverage are CR-CRU-239** (split at gap analysis).

## Scope

### §S1 — `go-crucible.py`, with the fleet's surface

The fleet's verbs, without tier verbs: register, unregister, test, regression, pre-merge-gate and the
plan verbs, through the shared `_crucible_axi` and `_crucible_run` modules, with the same envelopes.
A targeted `test --run <regex>` passes Go's own `-run`. `check` and coverage are CR-CRU-239's. The
start total is counted in the go client, so `_crucible_run.py` and its budget do not move.

### §S2 — the `go-test` stream codec

A server stream codec reads `go test -json` lines (`Action` `start`, `run`, `pause`, `cont`, `output`,
`pass`, `fail`, `skip`, `bench`, and `build-output` / `build-fail`). It never requires `Time` (a
cached result omits it). It is listed under `codecs.stream` in the board's health.

- **Cases.** Each terminal `pass` / `fail` / `skip` event that carries a `Test` is a case under its
  package, less each parent §S3 drops. A skip is stored as `pending`, as every codec stores one.
- **A failure's message** is its `error` line and the `error-continue` lines after it (read by
  `OutputType` where present, else by the indented `file.go:LINE:` form and its continuation
  indent). With none, the message is the test's untyped output, which covers a panic and a failing
  example. Testify's multi-line `Error Trace:` / `Error:` blocks are kept whole.
- **`file:line`** comes from the first `error` line, or else the first stack frame naming a
  `_test.go`. `file` is the package dir joined to the file's basename.
- **A skip's reason** is the last `file.go:LINE:` output line before its `--- SKIP` frame.
- **Package failures.** A package-level `fail` with no failing test is one failing case under the
  package, named for it, and never a passing run. Its message is the `build-output` lines whose
  `ImportPath` equals its `FailedBuild`, or else the package's own output. The shapes: a build failure
  (`FailedBuild`), a panic outside a test or in a subtest (the rest of the package never runs), a
  `TestMain` exit, and `[setup failed]`.
- **No test files** (`? pkg [no test files]`, a package `skip` with no `Test`) adds no case.
- **Incomplete.** A listed top-level name that never reaches a terminal event, for itself or a
  subtest, gives the run an `incomplete` reason naming it.
- **`--run` matching nothing** is a run of 0 tests that passes, with a warning naming the regex.

### §S3 — subtests

`t.Run` subtests (`Test/sub`, nested `Test/a/b`) are counted, pass or fail, with the rule CR-CRU-189
sets for python:

- a parent's `pass` is dropped once any subtest was recorded;
- a parent's `fail` is its own failing case when it printed its own `error` output, or when none of
  its recorded subtests failed (`t.Fail()` after passing subtests); otherwise it is dropped, its
  failing subtests carrying the failure.

### §S4 — the module dir

A module dir is resolved, relative to the project dir, from:

1. `--module-dir`;
2. `GO_CRUCIBLE_MODULE_DIR`;
3. the nearest `go.mod` at or above the working directory, never above the project dir;
4. the project's `crucible.toml` `[go] module_dir` (a `crucible.toml` that does not parse declares
   nothing, as for `[python] runner`).

A named dir with no `go.mod`, or no module found at all, is refused with the fleet's envelope, naming
the ways to declare one. The `go` binary is the one on `PATH`.

### §S5 — the declaration schema names Go

`[go] module_dir` is a stack table, so `crucible-declaration.schema.json` gains a `go` stack and moves
to `version` 2: its location, the stack table (a run-time `path`: a directory holding `go.mod`), its
parse rule, no `[targets]` entry, and `go-test` as its reserved framework.

### §S6 — the fleet carries it

The installer lays the client down, the manifest names it under `go`, and every closed list of the
fleet's stacks and files names it: the manifest's client stacks, the installer's fleet files, and
the census, manifest-contract, envelope and schema tests.

## Acceptance criteria

- [ ] **AC1 — a Go run reaches the board.** `go-crucible.py test --agent <id>` on a real Go module
  opens a streaming run decoded by `go-test`. Its cases equal the terminal `pass` / `fail` / `skip`
  events carrying a `Test` in `go test -json`, less the parents §S3 drops; passed, failed and pending
  split the same way.
- [ ] **AC2 — subtests are counted.** A module with passing and failing `t.Run` subtests, nested
  included, is stored with every subtest counted, and a failing subtest fails its run. A parent that
  fails on its own (its own `error` output, or `t.Fail()` after passing subtests) is its own failure.
- [ ] **AC3 — failures, skips and package failures carry their detail.** On captured real output
  (Go 1.27 with `OutputType`, and the text form without it): a failure's message (multi-line and
  testify included) and `file:line`; a skip's reason; a panic's message; a build failure, a `TestMain`
  exit, a panic in a subtest and `[setup failed]`, each a failing case under its package; a package
  with no test files adding nothing.
- [ ] **AC4 — one test by name.** `test --run <regex>` runs only the matching tests, a regex naming a
  subtest included; a regex matching nothing is a passing run of 0 tests with a warning.
- [ ] **AC5 — the total comes from the list.** The run-start total equals the listed `Test*`, `Fuzz*`
  and `Example*` names of the run's selection, benchmarks excluded, with and without `--run`. A listed
  name that never reports leaves the run `incomplete`, naming it. A list that cannot be read starts
  the run with no total and a warning.
- [ ] **AC6 — the module dir.** In a project with two `go.mod`s, `test` runs the module named by flag
  or environment variable, else the one the working directory is in, else `[go] module_dir`; a dir
  with no `go.mod`, or no module at all, is refused.
- [ ] **AC7 — the gate covers every module.** `regression` and `pre-merge-gate` in a two-module
  project run both modules into one run, skipping `vendor`, `testdata`, `node_modules` and hidden
  dirs.
- [ ] **AC8 — no tier verbs.** The go client offers no `unit`, `integration` or `e2e` verb; the verb
  census records that.
- [ ] **AC9 — the schema names Go.** The declaration schema is `version` 2 with a `go` stack, and the
  agreement test drives the go client's module-dir check with entries generated from it.
- [ ] **AC10 — the fleet carries it.** `crucible-axi install` lays the client down, the manifest names
  it under `go`, the board's health lists `go-test` under `codecs.stream`, and every fleet envelope
  contract holds for it.
- [ ] **AC11 — the Go floor.** Below Go 1.24 the client refuses before running, naming the version.
- [ ] **AC12 — the docs follow.** CHANGELOG `[Unreleased]` "Stack declaration changes" names schema
  version 2 and the `go` stack, and states that `TestMain` runs twice per run; README and RUNBOOK
  name the Go client.

## Non-goals

- Compile errors (`go build`, `go vet`) and coverage: CR-CRU-239.
- Declared tiers, their verbs and their gate composition: CR-CRU-196.
- A server route for a go test list.
- A skill bundle or stack reference. Skills are Model B's in full (CR-CRU-042).
- Third-party runners such as gotestsum.
