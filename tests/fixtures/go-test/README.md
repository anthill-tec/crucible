# Captured `go test -json` runs

Each `.jsonl` here is what a real `go test -json` wrote (stdout only), with
**go1.27.3 linux/amd64** — a toolchain that writes `OutputType` on every
output line. The modules they ran on are kept under `testdata/` (Go skips a
`testdata` directory, and so does a Go client's module search), so a fixture can
be re-captured.

The text form an older toolchain writes (Go 1.24–1.26: the same lines, no
`OutputType` field) is not stored: the tests derive it from each fixture by
deleting `OutputType` from every line (`textFormOf` in
`tests/helpers/go-test-harness.ts`). The `Output` text is identical across the
two versions.

The commands below restate how each run was captured (at spec pre-review,
except `bench.jsonl` and `bench-action.jsonl`, captured with the RED tests,
and `logs.jsonl`, captured with the text-form ruling's tests).

| File | Command (from the module dir) | What it holds |
|---|---|---|
| `pa.jsonl` | `go test -json ./pa ./pex` (in `testdata/mod`) | a pass; a multi-line failure (`error` + `error-continue`) followed by a `t.Log` line; skips; nested subtests (`TestSubs/nest/deep_bad`); a parent failing on its own after a passing subtest; a parent passing over passing subtests; parallel `pause`/`cont`; a fuzz seed; a passing and a failing example; a second package (`pex`) |
| `pa.verbose` | `go test -v ./pa ./pex` | the same run without `-json` |
| `buildfail-mixed.jsonl` | `go test -json ./...` (in `testdata/mod`, captured before `pa/a.go` and `pex/e.go` declared the examples' identifiers, and before `psubpanic`/`pbench` existed) | `build-output`/`build-fail` and `FailedBuild` (`pa`, `pex`, `pbuild`), a panic in a top-level test (`ppanic`), a `TestMain` exiting 3 (`pmain`), no test files (`pnotest`), a passing package (`pb`) |
| `all.verbose` | `go test -v ./...`, same tree as `buildfail-mixed.jsonl` | that run without `-json` |
| `subpanic.jsonl` | `go test -json ./psubpanic` | a panic in a subtest: the subtest fails with no output, the panic lines carry the parent's `Test`, the rest of the package never runs |
| `failnomsg.jsonl` | `go test -json -run TestFailNoMsg ./psubpanic` | a parent's `t.Fail()` with no message after a passing subtest |
| `testify.jsonl` | `go test -json ./...` (in `testdata/tfy`, testify v1.10.0) | testify's `assert`/`require` blocks: an empty `error` line, the message in `error-continue` lines |
| `setup-failed.jsonl` | `go test -json ./...` (in `testdata/twomod`, a dir holding two modules and no `go.mod`) | `[setup failed]` for the pattern `./...` |
| `run-sub.jsonl` | `go test -json -run 'TestSubs/bad' ./pa` | `-run` naming a subtest |
| `nomatch.jsonl` | `go test -json -run TestNothing ./pb` | `-run` matching nothing |
| `cached.jsonl` | `go test -json ./pb`, twice | two runs, each a cached result (`(cached)`) |
| `bench.jsonl` | `go test -json -run 'TestPass$' -bench . -benchtime 2x ./pbench` | a test and two benchmarks (one logging): benchmarks reach no terminal event |
| `logs.jsonl` | `go test -json -count=1 ./plog` (in `testdata/mod`) | `t.Log` beside `t.Error`, where the text form cannot tell them apart: a parent that logs and then has a failing subtest; `t.Log("step one"); t.Error("boom")`; a parent with its own `t.Error` and a failing subtest |
| `bench-action.jsonl` | `go tool test2json -p example.com/mod/pbench < testdata/bench-action.test` | a `bench` action, from Go's own test2json golden input (`src/cmd/internal/test2json/testdata/bench.test`); it carries no `Time` |
