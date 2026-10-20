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

- `pytest --junitxml=<file>` writes one JUnit file. Its default family (`xunit2`) carries no `file=`
  attribute; `-o junit_family=xunit1` adds `file=` and `line=`.
- A collection error (a broken import) stops the run with exit 2 and writes JUnit holding one
  `<error>` test case for the module. unittest's import failure writes no XML at all, and the client
  files it as a compile record.
- A run that collects nothing exits 5 and writes JUnit with `tests="0"`.
- pytest runs unittest subtests, and its console reports them (`2 subtests passed`, `SUBFAILED`), but
  its JUnit records only the parent test; the subtests are not counted in it.
- `pytest -v` prints one line per test, `<nodeid> PASSED  [ 25%]`, after `collected N items`.

## Scope

### §S1 — the project declares its runner

A project declares `[python] runner = "pytest"` (or `"unittest"`) in its own `crucible.toml`, read
from the project's file only. `--runner {unittest,pytest}` on a running verb overrides it for that
call. With neither, the runner is `unittest`, so nothing changes for today's projects. A declared or
given value that is neither is refused before anything is posted to the board, with `ok: false`,
exit 1, naming the value and where it came from. The shipped `crucible.toml` documents the key and
declares no value.

### §S2 — every running verb follows it

`test`, `regression`, every tier verb and `pre-merge-gate` run the chosen runner. With pytest:

- the client runs `pytest -v -o junit_family=xunit1 --junitxml=<reports>/TEST-pytest.xml`, under the
  same run lifecycle, interrupt trap, temp root, narration and envelopes as the `unittest` path, and
  ingests the report through the same parse;
- `--tests` takes pytest node ids (`tests/test_x.py::Cls::test_y`);
- `--start-dir` and `--pattern` reach pytest (the path it is given, and `python_files`) only when the
  caller states them; otherwise the project's own pytest configuration decides discovery;
- `--coverage` and the gate run pytest under coverage.py (`coverage run -m pytest`);
- the narration counts pytest's per-test lines, against the total it states when collection ends.

### §S3 — a pytest run's outcomes mean what a unittest run's mean

- A collection error is filed as a compile record from the captured output, with the no-report
  envelope, exactly as a unittest import failure is (user ruling).
- A run that collects nothing is a run that ran nothing, as on the unittest path.
- An interpreter without pytest fails the same way an interpreter without `xmlrunner` does, and the
  envelope's help names the interpreter and that it needs pytest.
- A run whose output reports subtests carries the existing `subtests-uncounted` warning, since
  pytest's JUnit does not count them (user ruling).

### §S4 — help says so

Every running verb's `--help` names `--runner`, the `[python] runner` declaration, the default, and
that the interpreter must have pytest for it. `--tests`' help says it takes node ids under pytest.

### §S5 — this repo can run it

`pytest` joins the `[dev]` extras that CI installs, and a committed pytest fixture project is what
the tests run.

## Acceptance criteria

- [ ] **Declared, every verb.** With `[python] runner = "pytest"` in the project's `crucible.toml`,
      `test`, `regression`, a declared tier verb and `pre-merge-gate` each run pytest on the fixture
      project and file its counts: 1 passed, 1 failed, 1 pending for the fixture's three tests, with
      `files` counted per file. `pre-merge-gate` and `regression --coverage` file coverage measured
      by coverage.py.
- [ ] **The flag overrides.** `--runner unittest` on a pytest-declared project runs unittest, and
      `--runner pytest` on an undeclared project runs pytest.
- [ ] **A bad value is refused.** A declared or given runner that is neither `unittest` nor `pytest`
      is refused before anything is posted: `ok: false`, exit 1, naming the value and its source
      (`--runner` or `crucible.toml`).
- [ ] **Node ids and discovery.** `test --tests <nodeid>` runs exactly that test. With no
      `--start-dir`/`--pattern`, the fixture's own pytest configuration decides what runs; with them,
      they do.
- [ ] **Every exit path holds.** On the pytest path: a collection error files a compile record and
      the no-report envelope, `ok: false`, non-zero exit; a run that collects nothing is aborted with
      the ran-nothing warning; a SIGTERM leaves the run aborted and one envelope; an interpreter
      without pytest gives the no-report envelope whose help names the interpreter and pytest.
- [ ] **Subtests are disclosed.** A pytest run of a test with subtests carries `subtests-uncounted`;
      a pytest run without subtests does not.
- [ ] **Narration.** A pytest run's heartbeats count its completed tests against the collected total.
- [ ] **No change by default.** With no declaration and no flag, every existing python test passes
      unchanged.
- [ ] **Help names it.** Every running verb's `--help` names `--runner`, `[python] runner`, the
      `unittest` default and that the interpreter needs pytest; `--tests`' help names node ids.
- [ ] **This repo runs it.** `pytest` is in the `[dev]` extras, and the CI python job runs the pytest
      fixture tests.

## Non-goals

- Counting pytest subtests some other way (its console summary, a reportlog plugin).
- pytest plugins beyond what the project's own interpreter already has.
- The live test stream for pytest (CR-CRU-200 streams the python client's own unittest runner).
