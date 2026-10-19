# CR-CRU-197 — the python client runs a pytest project

**Type** feature · **Points** 5 (set at the CR-CRU-190 gap analysis, 2026-10-19) · **Wave** 8 (0.4.0)
· **Depends on** — · **Status** PENDING — filed 2026-10-19 (split from CR-CRU-190 at its gap
analysis, user ruling)

## Problem

Requested by Model B (Sandesh #1446). `python-crucible.py` drives `unittest` only, through
`xmlrunner`. A pytest project has no client form for its runs, so its agents cannot run or ingest
through the board, and Model B lists it as a known client gap.

## Scope

### §S1 — a runner choice on the running verbs

`test` and `regression` gain `--runner {unittest,pytest}`, default `unittest`, so nothing changes for
today's projects. With `pytest`, the client runs `pytest --junitxml=<report>` and ingests that report
exactly as it ingests `xmlrunner`'s, through the same run lifecycle, interrupt trap, temp-root and
ran-nothing exits as the `unittest` path.

### §S2 — help says so

Each verb's `--help` names the runner choice and what the chosen interpreter must have installed
for it.

## Acceptance criteria

- [ ] **Pytest runs.** `python-crucible.py test --runner pytest` and `regression --runner pytest` run
      a pytest fixture project and file its pass and fail counts.
- [ ] **Every exit path holds.** On the pytest path, a ran-nothing run is aborted with its warning,
      and a SIGTERM leaves the run aborted and one envelope, as on the `unittest` path.
- [ ] **No change by default.** Without `--runner`, every existing python test passes unchanged.
- [ ] **Help names it.** `test --help` and `regression --help` name `--runner`, its default, and
      that the interpreter must have pytest for it.

## Non-goals

- Coverage of a pytest run beyond what `--coverage` already measures through coverage.py.
- Pytest for `pre-merge-gate`.
