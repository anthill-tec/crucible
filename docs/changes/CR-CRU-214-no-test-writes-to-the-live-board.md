# CR-CRU-214 — no test writes to the live board

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-28 (plan 213, cycles 771–774, gate 8959/0: bun 4176/0, python 4783/0); filed 2026-10-28
(found 2026-10-28 behind CR-CRU-213; user ruling: a patch CR into 0.4.0, sequenced next; settled at gap
analysis and the spec pre-review)

## Problem

`tests/client/test_cr040_coverage_tooling.py`'s `CovSourceDefaultTest` checks the `--cov-source` default
by running the python client's real `main()` with `regression` and `pre-merge-gate --agent
cr040-red-probe`, with the verb's handler mocked. But the shared dispatch wrapper (`run_verb` in
`clients/_crucible_axi.py`) posts a gate's outcome milestone **after** the handler returns, and the
client resolves its project as `--project-dir`, else `$<STACK>_CRUCIBLE_PROJECT_DIR`, else **the git
repo of the working directory** (`_resolve_project_dir` in the python, bun, mvn and rust clients; arduino's
`_project_dir` takes the working directory itself, with no git step) — this repo, whose `.env` and
`crucible.toml` name the live Crucible project on the dev board. So every run that includes
`test_cr040_coverage_tooling` — every pre-merge gate, and any full client-suite run — registers
`cr040-red-probe` in the live project and files an unlabelled `pre-merge-gate` milestone there (the
`regression` case posts nothing; only the gate verb's tail does).

Measured on the dev board 2026-10-28: since 2026-10-14 (CR-CRU-188, which added that post), 83
`cr040-red-probe` lifecycle records and 77 stray `pre-merge-gate` milestones in the live project; no other
test identity writes there. The hole is general — any client test that omits `--project-dir` reaches the
live board — and nothing guards it: CR-CRU-188 guards the live **store**, not the live **board**.

Measured at gap analysis: the whole python client suite run with all five `<STACK>_CRUCIBLE_PROJECT_DIR`
variables pointed at an empty directory passes (unittest `Ran 3225 tests … OK`), and the live board
gained nothing in that run — no test depends on the repo root being its project.

## Design (settled at gap analysis and the spec pre-review)

- **The client suite runs isolated.** On import, the `tests/client` package points each of the five
  `<STACK>_CRUCIBLE_PROJECT_DIR` variables (`PY_`, `BUN_`, `MVN_`, `RUST_`, `ARDUINO_`) at one fresh,
  empty directory for the suite's process, overriding any inherited value, and removes it at exit — reusing
  the scratch pattern `new_scratch` already follows (`tests/client/live_run_harness.py`: `mkdtemp` plus an
  `atexit` cleanup). The setup is idempotent within a process (a marker it sets itself), so a second import
  of the package under another name keeps the one directory. The suite runs in a subprocess the running
  client starts with a copy of its environment, so the override reaches every test and every client a test
  starts that inherits the environment, and never the client running the suite (it resolved its project
  before starting it). Discovery (`-s tests/client -t .`) and targeted runs (`tests.client.<module>`) both
  import the package. A test that forgets to steer then finds no project (`_project_key` exits before any
  network call) and posts nothing, instead of writing to the live board. A test that steers —
  `--project-dir`, or its own variable in a subprocess's environment — is unaffected.
- **The guarantee's scope.** The isolation covers inherited resolution. A test that removes a
  `<STACK>_CRUCIBLE_PROJECT_DIR` from its environment takes responsibility for steering, by `--project-dir`
  or by a working directory outside the repo — the existing tests that scrub these variables do so (they
  change to a temporary directory) and are left as they are.
- **The `--cov-source` default is read by parsing only**, through the seam
  `test_client_tier_verb_contract` already uses (`_root_parser`: spying on `parse_args`; the verb is never
  dispatched); the test's docstring stops advertising a run as a script.
- **A standing guard** proves the isolation holds; its RED run (on a tree without the isolation, where
  resolution answers the repo root) is the proof that it catches its own absence.

## Steps

### §S1 — the client suite cannot reach the live project

The package-level isolation, and the guard (AC1; AC3 at the gate).

### §S2 — the `--cov-source` default is read without dispatching

`CovSourceDefaultTest` parses only (AC2).

## Acceptance criteria

- [x] **AC1** In the client suite's process, each of the five `<STACK>_CRUCIBLE_PROJECT_DIR` variables
  names one existing directory holding no `.env` and no `crucible.toml`; and each client's resolution with
  no `--project-dir` — `_resolve_project_dir(None)` in the python, bun, mvn and rust clients,
  `_project_dir(args)` with no `--project-dir` in arduino — answers that directory, not the repo root (for
  arduino: not the working directory). The test unbinds the shared module afterwards
  (`addCleanup(module.bind_project_dir, None)`, as tests already do). It fails on today's tree, where the
  variables are unset and resolution answers the repo root — its RED run is the proof that the guard
  catches its own absence.
- [x] **AC2** The `--cov-source` default is read from the `--cov-source` action of the `regression` and
  `pre-merge-gate` subparsers on the root parser captured through `_root_parser`'s seam, and is unset for
  both; `run_verb` and the two handlers receive no call (asserted with a mock); the `cr040-red-probe`
  identity no longer appears in the file.
- [x] **AC3 (checked at the pre-merge gate)** The gate's run writes no test identity into the project the
  repo's `.env` names: `GET /api/v2/events?project=<key>` and `GET /api/v2/projects/<key>/milestones`, read
  from the gate's start, hold no record carrying `cr040-red-probe` or any other agent-id literal used in
  `tests/client`; their `pre-merge-gate` milestones are exactly the gate's own, under the runner's
  `--agent`; and no agent registers in that window other than the runner and agents already active before
  it started.

- *Recorded at merge.* AC3 checked over the gate's window: the live project held only the gate's own two
  runs and its milestone — none of the 112 agent-id literals in `tests/client`, no registration. Rulings:
  arduino's resolver exits on the isolation directory (no `.env`), which counts as answering it; the
  isolation reuses an inherited marker (`CRUCIBLE_CLIENT_SUITE_ISOLATION_DIR`), only its creator removes
  the directory; §S2 was a test-only cycle, its fail-first shown by a mutant run without `--agent` (by
  design, so a failing mutant never reaches the board). VERIFY's V1: the package is imported — and the
  isolation applied — under `-s tests/client -t .`, dotted `tests.client.<module>` targets and `-s tests`,
  not under `-s tests/client` without `-t .`, where the guard fails closed; stated in the package
  docstring (`a2728f4`). Deferred: the python client has no top-level-directory flag for discovery.

## Non-goals

- The bun suite: the board shows no bun test identity in the live project, and the bun tests that start a
  client from the repo root are read-only (`--help` surfaces, a `python -c` probe, and `runScript` with a
  temporary working directory and a test server).
- A client test module run as a script (`python3 tests/client/<module>.py`): it does not import the
  package, so it is not isolated.
- The existing tests that scrub these variables: they steer by working directory already.
- The stray records already written: since CR-CRU-213 they are not drawn as runs, and they stay as history
  rather than being deleted from the live store.
- The CR-CRU-188 rule that a gate test opens no live store (already guarded).

## Release notes

- The client suite no longer writes to the live board: a `--cov-source` test had registered an agent and
  filed a stray gate milestone in the project on every full run. The suite now runs with its project
  resolution pointed away from the repo, so a test that forgets to steer reaches no board.
