# CR-CRU-195 — a Go project reports to the board through its own client

**Type** feature · **Points** 13 (provisional, set at filing 2026-10-18; the estimate is revisited at
gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-200 · **Status** PENDING — filed
2026-10-18 (Model B request, user ruling: its own CR in 0.4.0, decoded on the server after
CR-CRU-152)

## Problem

Raised by Model B (2026-10-18). Model B is adding Go as a generated stack (CR-MDB-080, their release
1.1.0). Model B ships no client, so that stack waits on Crucible's. The motivating project is a
Go 1.26 backend with two `go.mod` modules, tested with `testing` plus testify, beside a Bun
frontend (`PROJECT_STACKS=go,bun`).

Crucible's fleet has five clients (bun, python, mvn, rust, arduino) and none for Go. A Go project
cannot register, run, ingest or gate through the board.

## Design (settled with the user, 2026-10-18)

- **Decoded on the server.** The client sends Go's own output to server codecs, the direction
  CR-CRU-152 sets for every stack: a test codec for `go test -json` and a compile codec for
  `go build` and `go vet` diagnostics. This CR therefore follows CR-CRU-152 and uses the raw-report
  path it settles. The stored event names the codec that decoded it.
- **The runner is the toolchain's own.** `go test -json`; no third-party runner is required.
- **Tiers are a separate CR.** Declared tiers and the gate's composition over them are
  CR-CRU-196. This CR's verbs run what they are asked to, under the tier the verb states.

## Scope

### §S1 — `go-crucible.py`, with the fleet's surface

The same verbs as the rest of the fleet: register, unregister, test, the tier verbs, regression,
check, pre-merge-gate and the plan verbs, through the shared `_crucible_axi` module, with the same
envelopes. A targeted `test` can run one test by name (`-run`).

### §S2 — test results

Each test's pass, fail or skip, with the failure's message and location and the skip's reason.
Subtests (`t.Run`) are counted, pass or fail, as CR-CRU-189 counts python's.

### §S3 — compile errors

`go build` and `go vet` failures become compile-error records, file, line, column and message.

### §S4 — coverage

Go's coverprofile becomes the coverage the board ingests, by the route CR-CRU-152 settles for
coverage.

### §S5 — more than one module

A module dir is resolved from a flag, then an environment variable, then the project's
`crucible.toml`, then the nearest `go.mod` above the working directory.

### §S6 — the fleet carries it

The installer lays the client down, the fleet manifest names it under `go`, and the census and
manifest-contract tests cover it like the other five.

## Acceptance criteria

- [ ] **A Go run reaches the board.** `go-crucible.py test --agent <id>` on a real Go module ingests
      a run whose counts equal `go test`'s own, stored under the Go test codec's name.
- [ ] **Subtests are counted.** A module with passing and failing `t.Run` subtests is ingested with
      every subtest counted, and a failing subtest fails its run.
- [ ] **Failures and skips carry their detail.** A failing test's message and `file:line`, and a
      skipped test's reason, are on the stored run.
- [ ] **One test by name.** `test --run <name>` runs only the named test.
- [ ] **Compile errors are records.** A module that does not build, and one `go vet` rejects, are
      each ingested as compile errors with file, line and message.
- [ ] **Coverage is ingested.** A coverage run stores the module's line coverage, equal to
      `go tool cover -func`'s total.
- [ ] **Two modules.** In a project with two `go.mod`s, each module is run when named by flag,
      environment variable or `crucible.toml`, and the nearest `go.mod` when none is.
- [ ] **The fleet carries it.** `crucible-axi install` lays the client down and the manifest names
      it under `go`. The verb census holds for it.
- [ ] **Every envelope is the fleet's.** Each verb's envelope passes the fleet's envelope contract
      tests.

## Non-goals

- Declared tiers and their gate composition: CR-CRU-196.
- A skill bundle or stack reference. Skills are Model B's in full (CR-CRU-042).
- Third-party runners such as gotestsum.

**Live stream (2026-10-20).** A go run streams its tests through `go test -json`, decoded on the
board, as the stream CR-CRU-200 lands (`DN-crucible-live-test-progress.md`).
