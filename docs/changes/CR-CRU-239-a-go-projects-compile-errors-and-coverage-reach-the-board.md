# CR-CRU-239 — a Go project's compile errors and coverage reach the board

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status**
PENDING — filed 2026-11-08, split from CR-CRU-195 at its gap analysis (user ruling 2026-11-08); made
exact at gap analysis 2026-11-09 (user ruling 2026-11-09: `check` compiles only, `go vet` is Go's
linter under CR-CRU-199) · Pre-review: due — a user ruling at gap analysis

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
- **`check` compiles; it does not lint (user ruling 2026-11-09).** `check` runs `go build ./...`,
  and with `--tests` also compiles every test file without running a test. `go vet` is Go's linter:
  it is the Go `lint` verb of CR-CRU-199, which keeps its rule that a lint finding never fails
  `check`.
- **Coverage is statement coverage, as Go counts it:** covered statements over all statements, each
  block weighted by its statement count, so the total equals `go tool cover -func`'s. A block listed
  more than once (`-coverpkg` lists each block once per test package) counts once, covered if any
  copy is. It is stored on the run's `lines` axis; a coverprofile states no functions, so the run
  has no functions axis.

## Scope

### §S1 — the `go` compile format

`go build` diagnostics, and the test-file compile's, become compile-error records with file, line,
column and message. Measured on Go 1.27.3:

- A diagnostic line is `path:LINE:COL: message`, or `path:LINE: message` with no column (a `go.mod`
  error). The path is as Go prints it, relative to the module dir or absolute.
- Not diagnostics: package headers (`# pkg`, `# pkg [pkg.test]`), `go:` lines, the test compile's
  `ok`, `?` and `FAIL` lines, and the `too many errors` line Go prints after its tenth error.
- Every diagnostic is an `error`: Go prints no warnings.
- The package is not stored: the stored diagnostic has no package field, and the path locates it.
- A report holding no diagnostic falls back to raw, as gcc's does, so a failed build is never shown
  as clean.
- The format is named by the hint `go` (alias `golang`), which the client always sends. Without a
  hint, a report is read as `go` only when a line starts with `<file>.go:LINE:COL:` and a space, and only after
  every existing format has been tried.

### §S2 — the `go-coverprofile` codec

A coverprofile becomes the run's coverage total: statements on the `lines` axis, no functions axis.
The coverage codec interface makes the functions axis optional, as the stored coverage, the board
and the client already do. A text with no `mode:` line, or with no block, is undecodable.

### §S3 — the client's verbs

- **`check`** runs `go build ./...` in the module `test` resolves (flag, `GO_CRUCIBLE_MODULE_DIR`,
  nearest `go.mod`, `[go] module_dir`); `--tests` adds `go test -count=1 -run '^$' -exec <a no-op>
  ./...`, which compiles every test package and runs no test binary (`TestMain` does not run). As in
  every client, a failing `check` with `--agent` files its output as a compile run with format `go`;
  a clean one files nothing.
- **`--coverage`** on `test` and `regression` adds `-coverprofile` per module and sends each
  module's profile with the run's close, codec `go-coverprofile`. `regression` carries it because the
  board's coverage panel reads the latest green regression. A `--coverage` run is refused before it
  opens when the board's health does not list `go-coverprofile`; a profile that was not written
  closes the run with no coverage and a warning.

## Acceptance criteria

- [ ] **AC1 — compile errors are records.** On captured `go build` output from a module that does
  not build (several packages, more than ten errors, a `go.mod` error), each diagnostic is one error
  record with its file, line, column (none for `go.mod`) and message, and no header, `go:` or
  `too many errors` line is one. A report with no diagnostic is stored raw.
- [ ] **AC2 — `check` files them.** `go-crucible.py check --agent <id>` on a real module that does
  not build files one compile run of format `go`; `check --tests` on a module whose only error is in a
  test file does the same, and its `TestMain` does not run; a clean `check` files nothing.
- [ ] **AC3 — coverage is ingested.** `regression --coverage` on a real two-module project stores the
  run's coverage with no functions axis, its `lines` percent equal to `go tool cover -func`'s total
  over the same profiles, including a profile written under `-coverpkg=./...`.
- [ ] **AC4 — a board without the codec is refused.** A `--coverage` run against a board whose health
  does not list `go-coverprofile` is refused before a run opens, naming the codec.
- [ ] **AC5 — the docs follow.** CHANGELOG, README and RUNBOOK name `check`, `check --tests` and
  `--coverage` for Go, and the CHANGELOG states that Go coverage is statement coverage on the lines
  axis.

## Non-goals

- `go vet` and third-party linters (staticcheck, golangci-lint): CR-CRU-199's Go `lint` verb.
- Declared tiers: CR-CRU-196.
- Coverage file by file: CR-CRU-193.
- Coverage in `pre-merge-gate`.
- Checking several modules in one `check`.
