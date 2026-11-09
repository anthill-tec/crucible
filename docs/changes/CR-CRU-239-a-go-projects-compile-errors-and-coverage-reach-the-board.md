# CR-CRU-239 — a Go project's compile errors and coverage reach the board

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status**
DONE — merged 2026-11-09 (`bd0d6f5f`) · Pre-review: ran — a user ruling at gap analysis (findings
F1–F11, all folded)

## Problem

CR-CRU-195 brings a Go project's test results to the board. Two of Go's outputs still have no
decoder:

- `go build` prints `path:LINE:COL: message` under `# package` headers, with no `error:` keyword. The
  board's compile codecs do not recognise it and store it as raw text.
- Go's coverprofile (`mode: set|count|atomic`, then `file:start.col,end.col numStmt count`) has no
  coverage codec.

## Design

- **Decoded on the server** (CR-CRU-152): a `go` compile format and a `go-coverprofile` coverage
  codec, each named on the stored record.
- **`check` compiles; it does not lint (user ruling 2026-11-09).** `check` runs `go build ./...`;
  `check --tests` compiles every package and every test file instead, without running a test and
  without the vet checks `go test` runs by default. `go vet` is Go's linter: it is the Go `lint`
  verb of CR-CRU-199, which keeps its rule that a lint finding never fails `check`.
- **Coverage is statement coverage, read from the profile:** covered statements over all statements
  across the profile's blocks, each block weighted by its statement count. A block listed more than
  once (`-coverpkg` lists each block once per test package) counts once, covered if any copy is. This
  is `go test`'s `coverage: N% of statements` figure. `go tool cover -func`'s total can differ: it
  reads the sources and counts only statements inside declared functions, which a server holding
  only the profile cannot do. The figure is stored on the run's `lines` axis; a coverprofile states
  no functions, so the run has no functions axis.

## Scope

### §S1 — the `go` compile format

`go build` diagnostics, and the test compile's, become compile-error records. Measured on Go 1.27.3:

- A diagnostic line is `path:LINE:COL: message`, or `path:LINE: message` with no column (a `go.mod`
  error). The path is as Go prints it, relative to the module dir or absolute.
- A tab-indented line after a diagnostic continues it and is appended to its message (an interface
  mismatch's `have`/`want`, a missing module's `go get` hint).
- Not diagnostics: package headers (`# pkg`, `# [pkg]`, `# pkg [pkg.test]`), `go:` lines, the test
  compile's `ok`, `?` and `FAIL` lines, and the `too many errors` line Go prints after its tenth
  error.
- Every diagnostic is an `error`: Go prints no warnings.
- The package is not stored: the stored diagnostic has no package field, and the path locates it.
- **A failure with no positioned diagnostic is still a failure.** Go's load-stage failures (an
  import cycle, two packages in one directory) print no `path:LINE` line. A `go` report holding no
  diagnostic is stored as ONE message-only error whose message is the report's lines that are not
  headers, `go:`, `ok`, `?` or `FAIL` lines, so its error count is 1 and the compile is never shown as
  clean. When no line is left (a failure Go reports only on `go:` lines, such as
  `go: updates to go.mod needed`), the message is the `go:` lines (added at VERIFY 2026-11-09).
- The format is named by the hint `go` (alias `golang`), which the client always sends. Without a
  hint, a report is read as `go` only when a line starts with `<file>.go:LINE:COL:` and a space, and
  only after every existing format has been tried. A board older than this CR stores a `go` report
  raw; that is accepted, since a failing `check` still exits non-zero on the agent's side.

### §S2 — the `go-coverprofile` codec

A coverprofile becomes the run's coverage total: statements on the `lines` axis, no functions axis.
The coverage codec interface makes the functions axis optional, as the stored coverage, the board
and the client already do. A text with a `mode:` line and no block (a module of types and constants
only) decodes to 0 of 0 statements, so it never drops the other modules' coverage. A text with no
`mode:` line, or with a malformed block line, is undecodable.

### §S3 — the client's verbs

- **`check`** runs `go build ./...` in the module `test` resolves (flag, `GO_CRUCIBLE_MODULE_DIR`,
  nearest `go.mod`, `[go] module_dir`). **`check --tests`** runs `go test -count=1 -vet=off -run '^$'
  -exec <a no-op> ./...` there instead: it compiles every package, test files included, runs no test
  binary (`TestMain` does not run) and runs no vet check. As in every client, a failing `check` with
  `--agent` files its output as a compile run with format `go`; a clean one files nothing.
- **`--coverage`** on `test` and `regression` adds `-coverprofile` per module and sends each
  module's profile with the run's close, codec `go-coverprofile`. `regression` carries it because the
  board's coverage panel reads the latest green regression. The client adds no `-coverpkg`; a project
  that wants it sets `GOFLAGS=-coverpkg=./...`, which every `go` command the client runs inherits. A
  `--coverage` run is refused before it opens when the board's health does not list
  `go-coverprofile`; a profile that was not written closes the run with no coverage and a warning.
- **The PRD follows:** `docs/research/PRD-crucible-v2.md`'s run schema makes `functions` optional,
  and its coverage codec list adds `go-coverprofile`, with Go's statement coverage on `lines`.

## Acceptance criteria

- [x] **AC1 — compile errors are records.** On captured Go output, each diagnostic is one error
  record with its file, line, column and message, and no header, `go:`, `ok`, `?`, `FAIL` or
  `too many errors` line is one. The captures: a `go build` of several packages with more than ten
  errors; an interface mismatch whose `have`/`want` lines land in its message; a `go.mod` error
  (no column); and an import cycle, stored as one message-only error.
- [x] **AC2 — `check` files them.** On real modules: `go-crucible.py check --agent <id>` on a module
  that does not build files one compile run of format `go`; `check --tests` on a module whose only
  error is in a test file does the same, its `TestMain` does not run, and a non-test error is filed
  once; a module whose only finding is a vet finding passes `check --tests` and files nothing; a
  clean `check` files nothing.
- [x] **AC3 — coverage is ingested.** `regression --coverage` on a real project of two modules, one
  of them types and constants only, stores the run's coverage with no functions axis, its `lines`
  total and covered equal to the covered and all statements of the profiles the run wrote, counted
  as §Design counts them. On a captured `-coverpkg=./...` profile the codec counts each repeated
  block once, and on a captured profile of a package with no package-level function literal its
  percent equals `go tool cover -func`'s total.
- [x] **AC4 — a board without the codec is refused.** A `--coverage` run against a board whose health
  does not list `go-coverprofile` is refused before a run opens, naming the codec.
- [x] **AC5 — the docs follow.** CHANGELOG, README and RUNBOOK name `check`, `check --tests` and
  `--coverage` for Go; the CHANGELOG states that Go coverage is statement coverage on the lines axis
  and that `GOFLAGS` carries `-coverpkg`; the PRD carries the §S3 amendment.

## Non-goals

- `go vet` and third-party linters (staticcheck, golangci-lint): CR-CRU-199's Go `lint` verb.
- Declared tiers: CR-CRU-196, which also brings its tiers' build tags to `check --tests`, so a
  tagged test file is compiled there.
- Coverage file by file: CR-CRU-193.
- Coverage in `pre-merge-gate`.
- Checking several modules in one `check`.
- A compile-format list in health.

**Done 2026-11-09.** Merged `bd0d6f5f` (plan 244: U1 898, U2 899, U3 900, VERIFY 901 CHANGES, FIX
902 for B1 and Sug1, then two gate findings). The board reads Go's compile format: each diagnostic is
one error, and a report of only `go:` lines (with their tab-indented continuations) keeps them as
the message. `go-crucible.py check` compiles a module and `check --tests` compiles its tests too
(`-count=1 -run ^$` with a no-op `-exec`); both refuse an unattributed run before the Go floor check
touches the toolchain, and `go vet` stays with CR-CRU-199's `lint`. `test` and `regression` take
`--coverage`: `GOFLAGS` carries `-coverpkg`, the `go-coverprofile` codec counts statements, a
function list is optional, and a module with no profile closes the run with no coverage and a
`coverage-not-measured` warning. A board without the codec refuses the run. Full gate: bun 5106/0;
the python client suite, red on 2 tests, re-gated scoped at 7360/0.
