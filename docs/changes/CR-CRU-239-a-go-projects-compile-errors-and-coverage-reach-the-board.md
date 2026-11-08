# CR-CRU-239 — a Go project's compile errors and coverage reach the board

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status**
PENDING — filed 2026-11-08, split from CR-CRU-195 at its gap analysis (user ruling 2026-11-08)

## Problem

CR-CRU-195 brings a Go project's test results to the board. Two of Go's outputs still have no
decoder:

- `go build` and `go vet` print `./file.go:LINE:COL: message` under `# package` headers, with no
  `error:` keyword. The board's compile codecs do not recognise it and store it as raw text.
- Go's coverprofile (`mode: set|count|atomic`, then `file:start.col,end.col numStmt count`) has no
  coverage codec.

## Design

- **Decoded on the server** (CR-CRU-152): a `go` compile format and a `go-coverprofile` coverage
  codec, each named on the stored record.
- **Coverage is statement coverage, as Go counts it:** covered statements over all statements,
  each block weighted by its statement count, so the total equals `go tool cover -func`'s. A block
  listed more than once (several packages under `-coverpkg`) counts once, covered if any copy is.

## Scope

### §S1 — the `go` compile format

`go build` and `go vet` diagnostics become compile-error records with file, line, column and
message, under the package that reported them. A report with no diagnostic is never shown as clean.

### §S2 — the `go-coverprofile` codec

A coverprofile becomes the run's line coverage, per file and in total.

### §S3 — the client's verbs

`go-crucible.py check` runs `go build ./...` and `go vet ./...` and sends their output; a test run
with `--coverage` adds `-coverprofile` and sends the profile.

## Acceptance criteria

- [ ] **AC1 — compile errors are records.** A module that does not build, and one `go vet` rejects,
  are each ingested as compile errors with file, line, column and message.
- [ ] **AC2 — coverage is ingested.** A coverage run stores the module's coverage, its total equal
  to `go tool cover -func`'s.
- [ ] **AC3 — the docs follow.** CHANGELOG, README and RUNBOOK name `check` and `--coverage` for Go.

## Non-goals

- Declared tiers: CR-CRU-196.
- Third-party linters (staticcheck, golangci-lint).
