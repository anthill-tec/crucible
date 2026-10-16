# CR-CRU-192 — a project's coverage config decides what is measured

**Type** fix (patch CR) · **Points** 3 (filed at 3 on 2026-10-16; 5 at gap analysis; 3 after the
spec pre-review dropped the combine step, the same day) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-16 (Model B request, user ruling: a patch CR in 0.4.0, next
after CR-CRU-189)

## Problem

Raised by Model B (2026-10-15): its pre-merge gate needs to measure its package and its scripts,
most of which its tests run as subprocesses. Its coverage reached the board empty.

1. **The client's source overrides the project's.** `regression` and `pre-merge-gate` default
   `--cov-source` to `crucible_axi,clients`, and the run always passes it to `coverage run` as
   `--source`. A command-line `--source` overrides a project's own `[tool.coverage.run] source`, so
   a project's coverage configuration never takes effect. A run in any other project measures
   Crucible's package names, collects no data, and `coverage lcov` then fails: the client warns
   "coverage lcov unavailable" and the run's coverage is dropped. That is the warning Model B saw.
2. **Stale data is merged into the next run.** Measuring subprocesses (`[run] patch =
   ["subprocess"]`) makes every process write a suffixed parallel data file. coverage.py 7.14 and
   later combine those files when they report, so `coverage lcov` counts a subprocess's lines
   without a separate `coverage combine`. They combine whatever parallel files sit beside the data
   file, though, and the client never erases them, either at the project root or in an agent's own
   reports directory (its wipe clears only `TEST-*.xml`). An earlier run's files are merged into the
   next run's coverage. `coverage erase` removes the suffixed files only when the project's config is
   itself parallel.

With the source left to coverage.py, a project that declares none would have coverage.py measure
everything outside the Python installation, Crucible's installed runner among it (measured
2026-10-16).

## Steps

### §S1 — the project's coverage configuration decides the source

When no `--cov-source` is given, the python client reads coverage.py's effective configuration
before the run, with the run's own interpreter (`_resolve_python`), in the run's working directory
(the project root) and with the run's environment, through coverage.py's own API rather than by
parsing its printed output. It reads `[tool.coverage.run]` in `pyproject.toml`, `.coveragerc`,
`setup.cfg` or `tox.ini`, and honours `COVERAGE_RCFILE` and `COVERAGE_FILE`, exactly as
`coverage run` will.

- **It declares what to measure** (a non-empty `source`, `source_pkgs`, `source_dirs` or `include`):
  the coverage run passes no `--source`, and coverage.py measures what the project declared.
- **It declares none:** the coverage run passes `--source <project root>`, the root as an absolute
  path. The project's own files are measured, its test files among them. A virtual environment
  inside the root is not measured, being third-party code, and neither is a Crucible runner
  installed outside it. Every envelope the run produces carries `{code:
  "coverage-source-undeclared", detail}`: the green ingest and every failure envelope. The detail
  names both remedies, `[tool.coverage.run] source` and `--cov-source`.
- **The configuration cannot be read** (the interpreter has no coverage.py, or the read fails): the
  run goes ahead as if a source were declared, passing no `--source`. Its own failure is reported as
  today, for example a missing coverage.py naming `No module named coverage`, and no
  `coverage-source-undeclared` warning is carried.

A given `--cov-source` is passed as `--source`, as today, and the configuration is not consulted for
the source (§S2 still resolves the data file). Both
verbs' help says what happens when it is omitted, and that subprocess coverage needs coverage.py
7.14 or later.

This repo declares its own source by adding `source = ["crucible_axi", "clients"]` under
`[tool.coverage.run]` in its `pyproject.toml`, so its gate measures exactly what it measures today, the runner shipped in
`clients/` included as Crucible's own code.

### §S2 — stale coverage data is erased before the run

Before the coverage run, the client erases the earlier data for the data file the run will write,
suffixed parallel files included, whether or not the project's config is parallel. The data file is
the run's `--data-file` when it has one (an agent's own reports directory), and otherwise the file
coverage.py resolves itself (`COVERAGE_FILE`, else `[run] data_file`, else `.coverage` in the
project root). `regression --coverage` and `pre-merge-gate` both do this, whether or not `--cov-source` is given.
A failed erase never fails the run. A failed configuration read or erase prints one stderr line
naming its cause (the error's type, or the first line coverage.py printed), never the client's own
probe source. No other step is added to
the report: coverage.py combines the run's parallel files when `coverage lcov` reports.

Any coverage command the client runs besides the run itself prints no `[crucible] running:` line,
so that line still names the suite's own command.

## Acceptance criteria

- [ ] **The project's source is measured.** Through the real python client, with no
      `--cov-source`, a project whose `pyproject.toml` declares `[tool.coverage.run] source`
      reports coverage of that source only, and the run's command carries no `--source`, through
      `regression --coverage` and through `pre-merge-gate`. The same holds for a source declared in
      `.coveragerc`, for one declared as `source_pkgs`, and for an `include`.
- [ ] **An undeclared source measures the project.** With no `--cov-source` and nothing declared,
      the run passes `--source <absolute project root>`, under a relative `--project-dir` too. The project's code and tests are measured,
      a virtual environment inside the root is not, and neither is the runner installed outside it.
      The green envelope and every failure envelope (red, zero-discovery, no-report, ran-nothing and
      an interrupted run's) carry `{code: "coverage-source-undeclared",
      detail}`, the detail naming `[tool.coverage.run] source` and `--cov-source`, through
      `regression --coverage` and through `pre-merge-gate`. With a declared source, or
      `--cov-source` given, no such warning.
- [ ] **An unreadable configuration does not stop the run.** With no coverage.py in the project's
      interpreter, `regression --coverage` and `pre-merge-gate` report today's cause, naming
      `No module named coverage`, with no `coverage-source-undeclared` warning.
- [ ] **A given source still wins.** With `--cov-source` given, `regression --coverage` and
      `pre-merge-gate` pass it as `--source`, as today.
- [ ] **This repo's gate is unchanged.** This repo's resolved coverage configuration declares exactly
      `crucible_axi` and `clients` as its source, and its python `pre-merge-gate` command carries no
      `--source`.
- [ ] **Subprocess coverage is reported.** Through the real python client, a project configured with
      `[run] patch = ["subprocess"]`, whose test runs a measured script as a subprocess, ingests a
      coverage object on the board that includes the script's lines, with no "coverage lcov
      unavailable" warning. Checked through `regression --coverage` and `pre-merge-gate`, with and
      without the run's own reports directory.
- [ ] **Stale data is not merged.** Two coverage runs in a row, the first leaving suffixed parallel
      files, report only the second run's coverage: at the project root, in an agent's own reports
      directory, and when the second run's config is not parallel.
- [ ] **The data file is coverage.py's.** The erase follows the run's `--data-file`, else
      `COVERAGE_FILE`, else `[run] data_file`, else `.coverage`, each relative to the project root,
      with and without `--cov-source`.
- [ ] **A failure names its cause.** A configuration read that times out, and an erase that fails,
      each print one stderr line naming the cause, never the probe's source.
- [ ] **One data file is unchanged.** A run that writes a single, unsuffixed data file reports the
      same coverage it does today.
- [ ] **Help is true.** Both verbs' `--cov-source` help says what happens when it is omitted, and that
      subprocess coverage needs coverage.py 7.14 or later.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## Known limit

A project with `[run] concurrency = multiprocessing` and no declared source is refused by
`coverage run` when `--source` is given on the command line. It must declare its source in its
config, as `coverage-source-undeclared` already tells it to.

## How it is worked

On a feature branch: RED, GREEN in the python client, then VERIFY. Existing tests that change with
§S1, each edit needing approval and going in its own commit:

- `CovSourceDefaultTest`, both methods, in `tests/client/test_cr040_coverage_tooling.py`, which pin
  the `crucible_axi,clients` default.
- The fake `coverage/__main__.py` in `tests/clients-python-arduino-crucible.test.ts`, only if it
  must answer the configuration read: today it exits 0 with no output for every command but `run`
  and `lcov`.

Model B hears of the change in the 0.4.0 release notes.
