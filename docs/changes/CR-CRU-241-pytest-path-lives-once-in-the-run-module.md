# CR-CRU-241 — the python client's pytest path lives once in the shared run module

**Status:** COMPLETED (shipped 2026-11-27 on develop)
**Type:** maintenance
**Priority:** high. The eda client (CR-CRU-242) calls this path.
**Depends on:** CR-CRU-196
**Labels:** clients, python, shared-modules
**Wave:** 9 (0.5.0) · **Points:** 5
**Design reference:** CR-CRU-197 (the pytest path and its outcomes); CR-CRU-224/225 (the shared run module)
**Revised** 2026-11-27 after gap analysis: the size and citation pins it re-recorded were deleted by the
2026-11-22 test cull, its source-shape checks become behaviour tests and review, and the lift covers the whole
pytest path (user rulings).

## Context

`clients/python-crucible.py` holds the fleet's only pytest path:

- the argv;
- the console narration;
- the passing-subtest watch;
- the exit-code classification;
- the import probe;
- the JUnit report lookup, the stale-report wipe and the no-report wording.

The eda client (CR-CRU-242) runs pytest too. Both clients call one copy, which lives in
`clients/_crucible_run.py` beside the rest of the run pipeline. `_crucible_axi.py` re-exports every
top-level run-module name through `_reexport_run_module`, so a client reaches it as `_axi().<name>`.

## Scope

- **Lift, do not wrap.** Each pytest-specific piece moves to `_crucible_run.py`, with its name made public
  (no leading underscore).
- **What stays in python:**
  - the runner choice (`_declared_runner`, `_resolve_runner`, `--runner`) and its help text;
  - the unittest path, including the CR-CRU-224 stream relay, which runs only under unittest;
  - `_FallbackWatch` and `_PYTEST`, which the python tests construct;
  - `_runner_label`, `_no_report_artifact` and `_wipe`, which choose between the runners and now call the shared
    pieces for pytest's part;
  - python's wording of its refusals and warnings.
- **Behaviour is unchanged.** Every argv, narration count, warning, exit and refusal is byte-identical to today's.
  The coverage and `--hermetic` prefixes still wrap the argv after it is built, so `pytest_command` keeps the
  interpreter as argv[0].
- **No CR id travels with the lifted code.** The lifted docstrings state behaviour only.

### §S1 — the shared names

`_crucible_run.py` gains these names, each defined once. None of them is defined in `clients/` today, so no
re-export is shadowed.

| Name | What it is (moved from `python-crucible.py`) |
| --- | --- |
| `JUNIT_REPORT_GLOB` | `"TEST-*.xml"` (the literal in `_report_paths`, `_produced_xml`, `_wipe`, `_no_report_artifact`, `cmd_auto_ingest`) |
| `PYTEST_JUNIT_FILE` | `"TEST-pytest.xml"` (`_pytest_args`) |
| `pytest_command(python, reports_dir, selection, *, pattern=None)` | `[python, "-m", "pytest", "-v", "-o", "junit_family=xunit1", "-o", "junit_suite_name=pytest", "--junitxml=<reports_dir>/TEST-pytest.xml"]`, then `-o python_files=<pattern>` when a pattern is given, then `selection` (`_pytest_args`, `_suite_cmd`) |
| `PytestProgress` | the selected-total and verdict-line recogniser (`_PytestProgress`, `_PYTEST_COLLECTED_LINE`, `_PYTEST_SELECTED`, `_PYTEST_VERDICT_LINE`) |
| `pytest_reports_passing_subtest(line)`, `PYTEST_SUBTESTS_UNCOUNTED_DETAIL` | the passing-subtest sign and its detail (`_PYTEST_SUBTESTS_PASSED`, `_PYTEST_SUBTESTS_DETAIL`) |
| `PYTEST_RUNNER_FAILURES`, `pytest_failed_as_runner(returncode)` | exits 3 and 4 (`_PYTEST_RUNNER_FAILURES`, `_pytest_failed_as_runner`). It reads the exit only; the caller decides that the runner is pytest. |
| `pytest_error_line(output)` | pytest's last `ERROR:` / `INTERNALERROR` / conftest line, or `None` (`_PYTEST_ERROR_LINE`, `_pytest_error_line`) |
| `PYTEST_PROBE_TIMEOUT_S`, `pytest_importable(python, cwd)` | the import probe, `[python, "-c", "import pytest"]` in `cwd`: `True` when it imports, `False` when it cannot or the interpreter cannot start, and `None` when it does not answer within the timeout (`_PYTEST_PROBE_TIMEOUT_S`, `_imports_pytest`) |
| `junit_report_paths(reports_dir)`, `produced_junit(reports_dir)` | the sorted `TEST-*.xml` paths, and whether any exists (`_report_paths`, `_produced_xml`) |
| `wipe_junit_reports(reports_dir)` | removes the stale `TEST-*.xml` files a run is about to rewrite, and nothing else (the JUnit half of `_wipe`) |
| `PYTEST_NO_REPORT_TEXT`, `pytest_no_report_subject(verb)` | the fallback text when pytest wrote no JUnit and printed nothing, and `"<verb> under pytest"` (`_no_xml_errors_text`'s pytest branch, `_no_report_subject`) |

The selection rule moves with `pytest_command`:

- with node ids, `selection` is those ids and no pattern is passed;
- otherwise the caller passes its start dir, if any, as `selection`, and its pattern, if any.

**The probe's timeout is new shared behaviour, not a move** (ruling 2026-11-27). Today `_imports_pytest` raises
python's refusal itself on a timeout. The shared probe answers `None`, and python's `_resolve_runner` raises the
same refusal, byte-identical, naming the timeout the probe actually used (the run module's
`PYTEST_PROBE_TIMEOUT_S`; the re-export copies values, so a rebinding on `_axi()` would not reach the probe).

### §S2 — python's call sites

Each of these python functions calls the shared name in place of its own copy:

1. `_suite_cmd`: `pytest_command`.
2. `_narrator`: `PytestProgress`.
3. `_FallbackWatch.observe`: `pytest_reports_passing_subtest`.
4. `_FallbackWatch.warnings`: `PYTEST_SUBTESTS_UNCOUNTED_DETAIL`.
5. `_resolve_runner`: `pytest_importable`, raising today's refusals on `False` and on `None`.
6. `_test_run`: `produced_junit`, `junit_report_paths`, and `pytest_failed_as_runner` behind its own pytest check.
7. `_regression_run`: the same three, the same way.
8. `cmd_auto_ingest`: `produced_junit`, `junit_report_paths`.
9. `_no_xml_errors_text`: `PYTEST_NO_REPORT_TEXT`.
10. `_no_report_warning`: `pytest_error_line`.
11. `_no_report_subject`, `_no_report_artifact`, `_wipe`: `pytest_no_report_subject`, `JUNIT_REPORT_GLOB`,
    `wipe_junit_reports`.

## Acceptance criteria

- [ ] **AC1 — the shared names reach the clients.** Each §S1 name is a top-level name of
  `clients/_crucible_run.py`, and `_axi().<name>` is the same object (the existing
  `tests/client/integration/test_the_run_pipeline_lives_in_its_own_shared_module.py` covers every run-module
  name and passes unedited).
- [ ] **AC2 — each lifted piece behaves as python's did** (unit tests on the run module, no process):
  - `pytest_command`'s argv for node ids, a start dir alone, a start dir with a pattern, and neither, pinned as
    literals;
  - `PytestProgress` reads the selected total from a collected line (with and without deselection) and
    recognises the verdict line;
  - `pytest_reports_passing_subtest` and `PYTEST_SUBTESTS_UNCOUNTED_DETAIL`;
  - `pytest_failed_as_runner` is true for 3 and 4 and false for 0, 1, 2, 5 and a signal exit;
  - `pytest_error_line` answers the last matching line, and `None` when there is none;
  - `junit_report_paths` is sorted, `produced_junit` answers for an empty, missing and populated directory, and
    `wipe_junit_reports` removes only `TEST-*.xml` files;
  - `pytest_no_report_subject("regression")` and `PYTEST_NO_REPORT_TEXT` read as today.
- [ ] **AC3 — python's argv is unchanged.** `_suite_cmd(python, "pytest", …)` returns, for the same four cases,
  the same lists as before the lift, pinned as literals.
- [ ] **AC4 — the probe's three answers** (integration: real interpreters): `pytest_importable` answers `True`
  for this repo's `[dev]` interpreter, `False` for a scratch venv built `--without-pip`, and `None` for a stub
  interpreter that sleeps past a run-module `PYTEST_PROBE_TIMEOUT_S` patched small. The probe's argv stays
  `[python, "-c", "import pytest"]`, which `test_a_pytest_gate_probes_pytest_once.py` recognises.
- [ ] **AC5 — python's refusals are worded as before.** Through the client, the `False` refusal (with its
  `(from <source>)`) and the timeout refusal read exactly as today, pinned as text; the timeout refusal names the
  patched timeout. (No test pins either text today.)
- [ ] **AC6 — a unittest exit 3 or 4 is not a pytest runner failure.** A unittest run exiting 3 or 4 is filed as
  it is today, not as pytest's runner failure.
- [ ] **AC7 — python's pytest behaviour holds.** These suites pass with no edit to their assertions:
  - the fixture suites that run real pytest on `tests/fixtures/pytest-project/` —
    `test_a_pytest_run_narrates_and_names_its_runner.py`,
    `test_a_pytest_run_discloses_its_uncounted_subtests.py`,
    `test_a_pytest_run_files_each_exit_by_what_pytest_reported.py`,
    `test_a_pytest_run_takes_node_ids_and_the_projects_discovery.py`,
    `test_a_pytest_project_runs_on_every_running_verb.py` and `test_a_pytest_gate_probes_pytest_once.py`;
  - `test_python_runner_is_declared_by_the_project.py`, `test_python_client_text_names_the_runner_that_ran.py`,
    `test_python_running_verb_help_names_the_runner.py` and `test_xmlrunner_has_left_the_python_client.py`
    (all `tests/client/integration/`);
  - `tests/client/unit/test_the_clients_agree_with_the_declaration_schema.py`.

**Reviewed, not tested** (VERIFY checks these by reading; source text is not tested):

- each §S1 name is defined once, in `_crucible_run.py`, and `python-crucible.py` keeps no copy of any piece it
  moved from (`_pytest_args`, `_PytestProgress`, `_PYTEST_COLLECTED_LINE`, `_PYTEST_SELECTED`,
  `_PYTEST_VERDICT_LINE`, `_PYTEST_SUBTESTS_PASSED`, `_PYTEST_SUBTESTS_DETAIL`, `_PYTEST_RUNNER_FAILURES`,
  `_PYTEST_ERROR_LINE`, `_PYTEST_PROBE_TIMEOUT_S`, `_pytest_failed_as_runner`, `_pytest_error_line`,
  `_imports_pytest`, `_report_paths`, `_produced_xml`), while `_FallbackWatch` and `_PYTEST` stay;
- `_crucible_run.py` still imports only the standard library;
- the lifted code carries no CR id.

## Test plan

| What | Tier | ACs |
| --- | --- | --- |
| The lifted functions and constants on the run module | python client unit (`tests/client/unit`) | AC2 |
| `_suite_cmd`'s argv, four cases | python client unit | AC3 |
| The probe on real interpreters; the refusals through the client; unittest exit 3/4 | python client integration (`tests/client/integration`) | AC4–AC6 |
| The existing re-export and pytest-fixture suites, unedited | python client integration / unit | AC1, AC7 |

## Estimated size

5 points. About 140 lines move, eleven call sites change, and two new test files pin the lifted pieces, the
argv, the probe and the refusals.

## Risk

- **A name collision would be silent.** `_reexport_run_module` skips a name the core already defines. No §S1 name
  is defined in `clients/` today; VERIFY re-checks.
- **The timeout wording could drift.** Python's timeout refusal is untested today; AC5 pins it before and after.
- **A unittest exit could be misread.** `pytest_failed_as_runner` no longer sees the runner; AC6 guards it.

## Non-goals

- Changing any pytest behaviour, argv, warning, exit or refusal.
- Lifting the unittest path, the runner choice or the stream relay.
- Re-introducing the line-budget, `RUN_LINE_LIMIT` or citation pins the 2026-11-22 test cull deleted.
- The eda client (CR-CRU-242), whose AC11 (an AST caller count) and AC12 (`SHARED_MODULE_LINE_BUDGETS`) are stale
  in the same way and are settled at its own gap analysis.

## Close-out (2026-11-27)

Plan 280.

- **Gap analysis:** the named suites were green at 329/0 and the six real-pytest suites at 90/0 before any change.
  Four user rulings followed: drop the pins the test cull deleted; replace the source-shape checks with behaviour
  tests and review; lift the whole pytest path, including the pieces the spec had missed; and let the shared probe
  answer `None` on a timeout, with python's wording pinned.
- **Cycle 1039, RED/GREEN (§S1):** 34 failing unit tests plus 5 pins of python's argv. Every §S1 name was added to
  `clients/_crucible_run.py` (153 lines), standard library only, re-exported with no collision.
- **Cycle 1040, RED/GREEN (§S2):** 25 integration tests on real interpreters: 1 failed for the spec's reason (the
  timeout refusal) and 24 pinned behaviour. python's eleven call sites use the shared names, and every moved copy
  was deleted (+57 / −160).
- **Cycle 1041, VERIFY:** PASS, with no must-fix finding, one should-fix finding for CR-CRU-242 (the outcome routing
  stays in python), and six notes. The runner guard was confirmed by reading.
- **Cycle 1042, FIX (user-chosen notes):** a public `pytest_probe_timeout()` replaces the reach into the core's
  private `_RUN`; `_is_junit_report` matches `JUNIT_REPORT_GLOB`; a stale test docstring was reworded.
- **Pre-merge gate (cycle 1042):** 13,779 passed and 0 failed in about 25 minutes. By suite: bun 5,170, python
  unit 2,787, python integration 5,822.
- **Carried to CR-CRU-242's gap analysis:** the outcome routing and the subtest watch's composition stay in python.
