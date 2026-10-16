# CR-CRU-192 — a project's coverage config decides what is measured, and parallel data is combined

**Type** fix (patch CR) · **Points** 5 (filed at 3 on 2026-10-16; 5 at gap analysis, the same day) · **Wave** 8 (0.4.0) · **Depends
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
3. **Stale parallel data would be merged.** A run without its own reports directory keeps
   coverage.py's data at the project root, which the client never clears. Parallel files an earlier
   run left there would be combined into the next run's coverage.

With the source left to coverage.py, a project that declares none would have coverage.py measure
everything outside the Python installation, Crucible's installed runner among it (measured
2026-10-16).

## Steps

### §S1 — the project's coverage configuration decides the source

When no `--cov-source` is given, the python client reads coverage.py's effective configuration with
the project's interpreter in the project root (`coverage debug config`). That covers every file
coverage.py reads: `[tool.coverage.run]` in `pyproject.toml`, `.coveragerc`, `setup.cfg` and
`tox.ini`.

- **It declares a source** (`source`, `source_pkgs` or `source_dirs`): the coverage run passes no
  `--source`, and coverage.py measures what the project declared.
- **It declares none:** the coverage run passes `--source <project root>`, so the project's own files
  are measured and Crucible's runner never is. Every envelope that run produces carries
  `{code: "coverage-source-undeclared", detail}`, the detail naming how to declare a source
  (`[tool.coverage.run] source`, or `--cov-source`).

A given `--cov-source` is passed as `--source`, as today, and the configuration is not read. Both
verbs' help says what happens when it is omitted.

This repo declares its own source, `crucible_axi` and `clients`, under `[tool.coverage.run]` in
`pyproject.toml`, so its gate measures what it measures today, the runner shipped in `clients/`
included as Crucible's own code.

### §S2 — stale data is erased, and parallel data is combined before the report

Before the coverage run, the client erases coverage.py's earlier data for the run's data file (the
same `--data-file` the run writes, or coverage.py's default location when the run has none), parallel
files included. After the run and before `coverage lcov`, it runs `coverage combine` over that data
file whenever the run left suffixed parallel data files beside it. lcov then reads the combined data.
A run that wrote a single data file is reported as today. `regression --coverage` and
`pre-merge-gate` both do this.

## Acceptance criteria

- [ ] **The project's source is measured.** Through the real python client's `regression --coverage`,
      with no `--cov-source`, a project whose `pyproject.toml` declares `[tool.coverage.run] source`
      reports coverage of that source only, and the run's command carries no `--source`. The same
      holds for a project declaring its source in `.coveragerc` instead.
- [ ] **An undeclared source measures the project.** With no `--cov-source` and no declared source,
      the run passes `--source <project root>`, Crucible's runner is not in the measured files, and
      the envelope carries `{code: "coverage-source-undeclared", detail}`, through `regression` and
      through `pre-merge-gate`. With a declared source, or `--cov-source` given, no such warning.
- [ ] **A given source still wins.** With `--cov-source` given, `regression` and `pre-merge-gate`
      pass it as `--source`, as today.
- [ ] **This repo's gate is unchanged.** This repo's `pyproject.toml` declares `crucible_axi` and
      `clients` under `[tool.coverage.run] source`, and its python `pre-merge-gate` measures the same
      files it does today.
- [ ] **Subprocess coverage is reported.** Through the real python client, a project configured with
      `[run] patch = ["subprocess"]`, whose test runs a measured script as a subprocess, ingests a
      coverage object on the board, and that coverage includes the script's lines. No "coverage
      lcov unavailable" warning is printed. Checked through `regression --coverage` and
      `pre-merge-gate`, with and without the run's own reports directory.
- [ ] **Stale data is not merged.** Two coverage runs in a row from the project root, the first
      leaving parallel data files, report only the second run's coverage.
- [ ] **One data file is unchanged.** A run that writes a single, unsuffixed data file reports the
      same coverage it does today.
- [ ] **Help is true.** Both verbs' `--cov-source` help says what happens when it is omitted.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED, GREEN in the python client, then VERIFY. The existing test that pins
the `crucible_axi,clients` default (`CovSourceDefaultTest`, both methods, in
`tests/client/test_cr040_coverage_tooling.py`) changes with the contract (§S1); that edit needs
approval and goes in its own commit. Model B hears of it in the 0.4.0 release notes.
