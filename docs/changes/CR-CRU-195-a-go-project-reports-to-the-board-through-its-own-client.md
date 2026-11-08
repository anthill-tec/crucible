# CR-CRU-195 — a Go project reports to the board through its own client

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-200,
CR-CRU-238 · **Status** PENDING — filed 2026-10-18 (Model B request, user ruling: its own CR in
0.4.0, decoded on the server after CR-CRU-152); made exact at gap analysis 2026-11-08 (user ruling
2026-11-08: split, compile errors and coverage move to CR-CRU-239) · Pre-review: due — 13 points
and a user ruling

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
- **The run's total is the top-level tests.** Before the run, the client posts the test list from
  `go test -list . -json` to the open run. Go cannot list subtests before they run, so the total
  counts top-level tests; subtests join the run as they are reported.
- **Tiers are a separate CR.** Declared tiers and the gate's composition over them are CR-CRU-196.
  Here every tier verb runs the module untagged, under the tier the verb states.
- **Compile errors and coverage are CR-CRU-239** (split at gap analysis).

## Scope

### §S1 — `go-crucible.py`, with the fleet's surface

The same verbs as the rest of the fleet: register, unregister, test, the tier verbs, regression,
pre-merge-gate and the plan verbs, through the shared `_crucible_axi` and `_crucible_run` modules,
with the same envelopes. A targeted `test --run <regex>` passes Go's own `-run`. `check` and
coverage are CR-CRU-239's.

### §S2 — the `go-test` stream codec

A server stream codec reads `go test -json` lines (`Action` `start`, `run`, `pause`, `cont`, `output`,
`pass`, `fail`, `skip`, and `build-output` / `build-fail` on Go ≥ 1.24):

- each test's pass, fail or skip becomes a case under its package;
- a failure carries its message and `file:line`, from the test's `error` output lines
  (an indented `file.go:LINE: message`); a skip carries its reason from the same form;
- a package-level `fail` with no failing test (a panic, a build failure, a `TestMain` exit) is a
  failure of the package, never a passing run;
- the codec is listed under `codecs.stream` in the board's health.

### §S3 — subtests

`t.Run` subtests (`Test/sub`, nested `Test/a/b`) are counted, pass or fail, with the rule CR-CRU-189
sets for python: a parent whose subtests were recorded is not counted again for its own pass, and a
parent that fails beyond its failing subtests is still a failure.

### §S4 — the module dir

A module dir is resolved from `--module-dir`, then `GO_CRUCIBLE_MODULE_DIR`, then the project's
`crucible.toml` `[go] module_dir`, then the nearest `go.mod` at or above the working directory. The
run executes there and its packages are `./...` of that module.

### §S5 — the declaration schema names Go

`[go] module_dir` is a stack table, so `crucible-declaration.schema.json` gains a `go` stack and
moves to `version` 2: its location, the stack table (a run-time `path`: a directory holding `go.mod`),
its shape and parse rules (a `crucible.toml` that does not parse declares nothing for it, as for
`[python] runner`), no `[targets]` entry, and `go-test` as its reserved framework.

### §S6 — the fleet carries it

The installer lays the client down, the manifest names it under `go`, and every closed list of the
fleet's stacks and files names it: the manifest's client stacks, the installer's fleet files, and
the census, manifest-contract, envelope and schema tests.

## Acceptance criteria

- [ ] **AC1 — a Go run reaches the board.** `go-crucible.py test --agent <id>` on a real Go module
  opens a streaming run whose stored counts equal `go test`'s own, decoded by `go-test`.
- [ ] **AC2 — subtests are counted.** A module with passing and failing `t.Run` subtests, nested
  included, is stored with every subtest counted, and a failing subtest fails its run.
- [ ] **AC3 — failures and skips carry their detail.** A failing test's message and `file:line`, and
  a skipped test's reason, are on the stored run. A package that fails with no failing test fails the
  run.
- [ ] **AC4 — one test by name.** `test --run <regex>` runs only the matching tests.
- [ ] **AC5 — the total is posted first.** The open run's total, before any test reports, equals the
  module's top-level test count from `go test -list`.
- [ ] **AC6 — two modules.** In a project with two `go.mod`s, each module is run when named by flag,
  environment variable or `crucible.toml`, and the nearest `go.mod` when none is.
- [ ] **AC7 — the schema names Go.** The declaration schema is `version` 2 with a `go` stack, and the
  agreement test drives the go client's module-dir check with entries generated from it.
- [ ] **AC8 — the fleet carries it.** `crucible-axi install` lays the client down, the manifest names
  it under `go`, and the verb census holds for it.
- [ ] **AC9 — every envelope is the fleet's.** Each verb's envelope passes the fleet's envelope
  contract tests.
- [ ] **AC10 — the docs follow.** CHANGELOG `[Unreleased]` "Stack declaration changes" names schema
  version 2 and the `go` stack; README and RUNBOOK name the Go client.

## Non-goals

- Compile errors (`go build`, `go vet`) and coverage: CR-CRU-239.
- Declared tiers and their gate composition: CR-CRU-196.
- A skill bundle or stack reference. Skills are Model B's in full (CR-CRU-042).
- Third-party runners such as gotestsum.
