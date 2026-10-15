# CR-CRU-192 — a project's coverage config decides what is measured, and parallel data is combined

**Type** fix (patch CR) · **Points** 3 (set at filing, 2026-10-16) · **Wave** 8 (0.4.0) · **Depends
on** — · **Status** PENDING — filed 2026-10-16 (Model B request, user ruling: a patch CR in 0.4.0,
next after CR-CRU-189)

## Problem

Raised by Model B (2026-10-15): its pre-merge gate needs to measure its package and its scripts,
most of which its tests run as subprocesses. Two defects in the python client stop that. Both were
confirmed on develop.

1. **The client's source overrides the project's.** `regression` and `pre-merge-gate` default
   `--cov-source` to `crucible_axi,clients`, and the run always passes it to `coverage run` as
   `--source`. A command-line `--source` overrides a project's own `[tool.coverage.run] source`, so
   a project's coverage configuration never takes effect, and a run in any other project measures
   Crucible's package names.
2. **Parallel data is never combined.** Measuring subprocesses needs coverage.py's
   `[run] patch = ["subprocess"]`, and that setting forces `parallel = True`. Every process then
   writes a suffixed data file. The client runs `coverage lcov` straight after the run, with no
   `coverage combine`, so lcov finds no unsuffixed data file. The client warns "coverage lcov
   unavailable" and the run's coverage is dropped.

## Steps

### §S1 — the project's coverage configuration decides the source

When no `--cov-source` is given, the python client's coverage run passes no `--source`, and
coverage.py's own configuration (`[tool.coverage.run]` in `pyproject.toml`, `.coveragerc`,
`setup.cfg` or `tox.ini`) decides what is measured. A given `--cov-source` is passed as `--source`,
as today. Both verbs' help says so.

This repo declares its own source, `crucible_axi` and `clients`, under `[tool.coverage.run]` in
`pyproject.toml`, so its gate measures what it measures today.

### §S2 — parallel data is combined before the report

After the coverage run and before `coverage lcov`, the client runs `coverage combine` over the
run's data file (the same `--data-file` the run wrote, or coverage.py's default location when the
run had none) whenever the run left suffixed parallel data files beside it. lcov then reads the
combined data. A run that wrote a single data file is reported as today.

## Acceptance criteria

- [ ] **The project's source is measured.** Through the real python client's `regression`, with no
      `--cov-source`, a project whose `pyproject.toml` declares `[tool.coverage.run] source` reports
      coverage of that source only, and the run's command carries no `--source`.
- [ ] **A given source still wins.** With `--cov-source` given, `regression` and `pre-merge-gate`
      pass it as `--source`, as today.
- [ ] **This repo's gate is unchanged.** This repo's `pyproject.toml` declares `crucible_axi` and
      `clients` under `[tool.coverage.run] source`, and its python `pre-merge-gate` measures the same
      files it does today.
- [ ] **Subprocess coverage is reported.** Through the real python client, a project configured with
      `[run] patch = ["subprocess"]`, whose test runs a measured script as a subprocess, ingests a
      coverage object on the board, and that coverage includes the script's lines. No "coverage
      lcov unavailable" warning is printed.
- [ ] **One data file is unchanged.** A run that writes a single, unsuffixed data file reports the
      same coverage it does today.
- [ ] **Help is true.** Both verbs' `--cov-source` help says what happens when it is omitted.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED, GREEN in the python client, then VERIFY. The existing test that pins
the `crucible_axi,clients` default changes with the contract (§S1); that edit needs approval and
goes in its own commit.
