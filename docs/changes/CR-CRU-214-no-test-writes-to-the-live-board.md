# CR-CRU-214 — no test writes to the live board

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(found 2026-10-28 behind CR-CRU-213; user ruling: a patch CR into 0.4.0, sequenced next; settled at gap
analysis)

## Problem

`tests/client/test_cr040_coverage_tooling.py`'s `CovSourceDefaultTest` checks the `--cov-source` default
by running the python client's real `main()` with `regression` and `pre-merge-gate --agent
cr040-red-probe`, with the verb's handler mocked. But the shared dispatch wrapper (`run_verb` in
`clients/_crucible_axi.py`) posts a gate's outcome milestone **after** the handler returns, and the
client resolves its project as `--project-dir`, else `$<STACK>_CRUCIBLE_PROJECT_DIR`, else **the git
repo of the working directory** — this repo, whose `.env` and `crucible.toml` name the live Crucible
project on the dev board. So every full python run (every pre-merge gate and every VERIFY run) registers
`cr040-red-probe` in the live project and files an unlabelled `pre-merge-gate` milestone there.

Measured on the dev board 2026-10-28: since 2026-10-14 (CR-CRU-188, which added that post), 83
`cr040-red-probe` lifecycle records and 77 stray `pre-merge-gate` milestones in the live project; no other
test identity writes there. The hole is general — any client test that omits `--project-dir` reaches the
live board — and nothing guards it: CR-CRU-188 guards the live **store**, not the live **board**.

Measured at gap analysis: the whole python client suite run with all five `<STACK>_CRUCIBLE_PROJECT_DIR`
variables pointed at an empty directory passes (unittest `Ran 3225 tests … OK`), and the live board
gained nothing in that run — no test depends on the repo root being its project.

## Design (settled at gap analysis)

- **The client suite runs isolated.** On import, the `tests/client` package points each of the five
  `<STACK>_CRUCIBLE_PROJECT_DIR` variables (`PY_`, `BUN_`, `MVN_`, `RUST_`, `ARDUINO_`) at one fresh,
  empty directory for the suite's process, overriding any inherited value, and removes it at exit. A test
  that forgets to steer then finds no project and posts nothing, instead of writing to the live board. A
  test that steers — `--project-dir`, or its own variable in a subprocess's environment — is unaffected.
  Discovery (`-s tests/client -t .`) and targeted runs (`tests.client.<module>`) both import the package.
- **The `--cov-source` default is read by parsing only**, through the seam
  `test_client_tier_verb_contract` already uses (spying on `parse_args`; the verb is never dispatched).
- **A standing guard** proves the isolation holds.

## Steps

### §S1 — the client suite cannot reach the live project

The package-level isolation, and the guard (AC1, AC3).

### §S2 — the `--cov-source` default is read without dispatching

`CovSourceDefaultTest` parses only (AC2).

## Acceptance criteria

- [ ] **AC1** In the client suite's process, each of the five `<STACK>_CRUCIBLE_PROJECT_DIR` variables
  names one existing directory holding no `.env` and no `crucible.toml`, and each client's project
  resolution with no `--project-dir` answers that directory, not the repo root (a standing test).
- [ ] **AC2** The `--cov-source` default checks still hold for `regression` and `pre-merge-gate`, and
  dispatch no verb.
- [ ] **AC3** With the isolation removed (a mutant run, nothing ingested), AC1's test fails — the guard
  catches its own absence.
- [ ] **AC4 (checked at VERIFY and at the gate)** A full python client-suite run leaves no record from any
  test identity in the project the repo's `.env` names: the board's events and milestones for that
  project, from the run's start, hold only the runner's own.

## Non-goals

- The bun suite: the board shows no bun test identity in the live project.
- The stray records already written: since CR-CRU-213 they are not drawn as runs, and they stay as history
  rather than being deleted from the live store.
- The CR-CRU-188 rule that a gate test opens no live store (already guarded).

## Release notes

- The client suite no longer writes to the live board: a `--cov-source` test had registered an agent and
  filed a stray gate milestone in the project on every full run. The suite now runs with its project
  resolution pointed away from the repo, so a test that forgets to steer reaches no board.
