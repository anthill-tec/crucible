# CR-CRU-197 — the python client runs a pytest project

**Type** feature · **Points** 8 (5 at filing; raised at gap analysis 2026-10-20 when the runner became
a project declaration every running verb follows) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-19 (split from CR-CRU-190 at its gap analysis, user ruling)

## Problem

Requested by Model B (Sandesh #1446); Valmik's electronics suites are pytest too (#1352).
`python-crucible.py` drives `unittest` only, through `xmlrunner`. A pytest project has no client form
for its runs, so its agents cannot run or ingest through the board and it cannot gate. Model B lists
it as a known client gap.

Measured on pytest 9.1.1, python 3.14:

- `pytest --junitxml=<file>` writes one JUnit file, as one `<testsuite name="pytest">`. Its default
  family (`xunit2`) carries no `file=`; `-o junit_family=xunit1` adds `file=` and `line=`.
- A collection error (a broken import) exits 2 and writes one test case for the module with
  `<error message="collection failure">`. A unittest import failure is written the same way by
  xmlrunner (`<error type="ImportError">`), and the client files it as one failed test.
- A run that collects nothing exits 5 and writes JUnit with `tests="0"`.
- Exit 4 (a usage error, a broken `conftest.py`, a node id or path that does not exist) and exit 3
  (an internal error, written as one test case named `internal`) are pytest failing as a runner, not
  test results.
- pytest runs unittest subtests and its native `subtests` fixture. A failing subtest is written as a
  failure on its parent test case; passing subtests are not written as test cases. The console says
  so (`N subtests passed`, `SUBPASSED(...)` lines).
- `pytest -v` prints `<nodeid> PASSED  [ 25%]` per test, after `collected N items`, or
  `collected N items / D deselected / S selected`.

## Design (settled with the user, 2026-10-20)

- The runner is a declaration of the project, `[python] runner` in its own `crucible.toml`; a
  `--runner` flag overrides it per call; no environment variable chooses it.
- Every running verb follows it: `test`, `regression`, the tier verbs, `pre-merge-gate`.
- A pytest collection error is filed as a failed test, as a unittest import failure already is.
- An interpreter without pytest is refused before anything is posted.
- A run whose subtests went uncounted says so.
- The check step that finds nothing to compile passes and says so (user ruling at VERIFY, 2026-10-20:
  the gate's `py_compile` step stopped a project with neither `app/` nor `tests/`).

## Scope

### §S1 — the project declares its runner

`[python] runner = "pytest"` (or `"unittest"`) in the project's own `crucible.toml` chooses the
runner, read from the project's file only: an install-level `crucible.toml` is never consulted, and a
file that is absent or does not parse declares nothing. `--runner <name>` on a running verb overrides
it for that call. With neither, the runner is `unittest`, so nothing changes for today's projects. A
declared or given value that is neither name is refused, and with `pytest` chosen an interpreter that
cannot import pytest is refused: both before anything is posted to the board (before the run's
opening heartbeat, and before the gate's check step), with `ok: false`, exit 1, naming the value and
its source, or the interpreter and that it needs pytest. `check` and `auto-ingest` take no
`--runner`. The shipped `crucible.toml` documents the key and declares no value.

### §S2 — every running verb follows it

`test`, `regression`, every tier verb and `pre-merge-gate` run the chosen runner. With pytest:

- the client runs `pytest -v -o junit_family=xunit1 --junitxml=<reports>/TEST-pytest.xml` under the
  same run lifecycle, interrupt trap, temp root, narration and envelopes as the `unittest` path, and
  ingests the report through the same parse; the run's tree groups tests by their `classname`
  (module, or module and class), not under one `pytest` node;
- `--tests` takes pytest node ids (`tests/test_x.py::Cls::test_y`), and with `--tests` given no
  start dir is passed, as on the `unittest` path;
- `--start-dir` and `--pattern` reach pytest (the path it is given, and `python_files`) only when the
  caller states them; otherwise the project's own pytest configuration decides discovery. On the
  `unittest` path the defaults stay `tests` and `test_*.py`;
- a tier verb's declaration stays its invocation (`--start-dir`, `--pattern`), as on `unittest`;
- `--coverage` and the gate run pytest under coverage.py (`coverage run -m pytest`);
- the narration counts pytest's per-test verdict lines (`PASSED`, `FAILED`, `SKIPPED`, `ERROR`,
  `XFAIL`, `XPASS`; never a `SUB…` line) against the selected total pytest states when collection
  ends.

### §S3 — a pytest run's outcomes

- Exit 0, 1 or 2: the JUnit report is the result. A collection error is one failed test, as a
  unittest import failure is (user ruling).
- Exit 5, nothing collected: the run ran nothing; it is aborted with the `no-test-reports` warning,
  and no compile record is filed.
- Exit 3 or 4: pytest failed as a runner. Whatever JUnit it wrote is not filed as tests; the captured
  output is filed as a compile record with the no-report envelope, whose warning carries pytest's own
  `ERROR:` or `INTERNALERROR` line.
- A run whose output reports passing subtests carries `subtests-uncounted`, with a detail that names
  pytest and says passing subtests are not counted (user ruling).
- Printed text names the runner that ran: the exit line, the no-report detail, the `--python` help.

### §S4 — help says so

Every running verb's `--help` names `--runner`, the `[python] runner` declaration, the `unittest`
default, and that the interpreter must have pytest for it; `--tests`' help says it takes node ids
under pytest; `--start-dir` and `--pattern` say that under pytest the project's configuration
decides unless they are given.

### §S4b — a check with nothing to compile passes and says so

`check`, and the gate's check step, compile whichever of their paths exist. When none exists they
compile nothing, pass, and the envelope carries a `check-compiled-nothing` warning naming the paths
looked for and `--paths`. A usage error from the compiler is never filed as a syntax error.

### §S5 — this repo can run it

`pytest` joins the `[dev]` extras that CI installs, with its demanders named. A committed pytest
fixture project (its own pytest configuration, with a `python_files` this repo's runs never match)
is copied to a scratch directory for every run, so nothing it writes lands in the checkout, and it
never runs as part of this repo's own suites. A test that needs pytest fails, never skips, when the
interpreter lacks it.

## Acceptance criteria

- [ ] **Declared, every verb.** With `[python] runner = "pytest"` in the project's `crucible.toml`,
      `test`, `regression`, a tier verb declared by `--start-dir` and `pre-merge-gate` each run pytest
      on the fixture and file its counts: 1 passed, 1 failed, 1 pending for its three tests, `files`
      counted per file, the tree grouped by `classname`. `pre-merge-gate` and `regression --coverage`
      file coverage measured by coverage.py.
- [ ] **The flag overrides.** `--runner unittest` on a pytest-declared project runs unittest;
      `--runner pytest` on an undeclared project runs pytest. An install-level `[python] runner` is
      ignored.
- [ ] **Refused before the board.** A runner value that is neither name (from `--runner` or from
      `crucible.toml`), and `pytest` with an interpreter that cannot import it, are each refused on
      `test`, `regression` and `pre-merge-gate` with `ok: false` and exit 1, naming the value and its
      source or the interpreter and pytest, with nothing posted to the board and nothing run.
- [ ] **Node ids and discovery.** `test --tests <nodeid>` runs exactly that test. With no
      `--start-dir`/`--pattern`, the fixture's own pytest configuration decides what runs; with them,
      they do. Without `--runner pytest`, `--start-dir` still defaults to `tests` and `--pattern` to
      `test_*.py`.
- [ ] **Every exit path holds.** On the pytest path: a collection error files one failed test; a run
      that collects nothing is aborted with `no-test-reports` and files no compile record; a
      nonexistent node id (exit 4), a broken `conftest.py` (exit 4) and an internal error (exit 3)
      each file a compile record with the no-report envelope whose warning carries pytest's error
      line, and file no tests; a SIGTERM leaves the run aborted and one envelope.
- [ ] **Subtests are disclosed.** A pytest run of a `unittest.subTest` test and of a native
      `subtests` test each carries `subtests-uncounted` with the pytest detail; a run without
      subtests does not.
- [ ] **Narration.** A pytest run's heartbeats count its completed tests (no `SUB…` line counted)
      against the selected total.
- [ ] **No change by default.** With no declaration and no flag, every existing python test passes
      unchanged.
- [ ] **Help names it.** Every running verb's `--help` names `--runner`, `[python] runner`, the
      `unittest` default and that the interpreter needs pytest; `--tests` names node ids;
      `--start-dir` and `--pattern` name the pytest rule. The root `--help` description and its
      `regression` line name both runners and `[python] runner`; a filed fallback text for a run
      that left no output names the runner that ran.
- [ ] **One probe per gate.** `pre-merge-gate` with pytest chosen checks the interpreter for pytest
      once, with a time bound, before its check step.
- [ ] **A check with nothing to compile passes.** On a project with neither `app/` nor `tests/`,
      `check` and `pre-merge-gate` compile nothing, file no compile record, carry
      `check-compiled-nothing` naming the paths looked for and `--paths`, and the gate goes on to run
      its suite; the unmodified pytest fixture gates.
- [ ] **This repo runs it.** `pytest` is in the `[dev]` extras; the fixture project runs only from a
      scratch copy, and none of its files is collected by this repo's python or bun runs.

## Non-goals

- Counting passing pytest subtests some other way (its console summary, a reportlog plugin).
- A pytest-native tier declaration (markers, `testpaths`).
- Per-test narration when a project's own pytest configuration lowers verbosity (`addopts = -q`).
- The live test stream for pytest (CR-CRU-200 streams the unittest runner; it lands after this CR).
