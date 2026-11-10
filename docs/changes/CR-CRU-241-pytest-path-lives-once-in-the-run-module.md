# CR-CRU-241 — the python client's pytest path lives once in the shared run module

**Status:** PENDING · Pre-review: due — user ruling
**Type:** maintenance
**Priority:** high. The eda client (CR-CRU-242) calls this path.
**Depends on:** CR-CRU-196
**Labels:** clients, python, shared-modules
**Phase:** design
**Design reference:** CR-CRU-197 (the pytest path and its outcomes); CR-CRU-224/225 (the shared run module)

## Context

`clients/python-crucible.py` holds the fleet's only pytest path:

- the argv;
- the console narration;
- the passing-subtest watch;
- the exit-code classification;
- the import probe;
- the JUnit report lookup.

The eda client (CR-CRU-242) runs pytest too. Both clients call one copy, which lives in
`clients/_crucible_run.py` beside the rest of the run pipeline. That module's size is pinned in three
tests, and `clients/` citations are counted by the namespace tripwire. Both pins move once, in this CR.

## Scope

- **Lift, do not wrap.** Each pytest-specific piece moves to `_crucible_run.py`, with its name made public
  (no leading underscore). `_crucible_axi.py` re-exports it unchanged through `_reexport_run_module`, so a
  client reaches it as `_axi().<name>`.
- **What stays in python:**
  - the runner choice (`_declared_runner`, `_resolve_runner`, `--runner`);
  - the unittest path;
  - `_FallbackWatch` and `_PYTEST`, which the python tests construct;
  - python's wording of its refusals and warnings.
- **Behaviour is unchanged.** Every argv, narration count, warning and exit is byte-identical to today's.
- **No CR id travels with the lifted code.** The lifted docstrings state behaviour only.

### §S1 — the shared names

`_crucible_run.py` gains these names, each defined once:

| Name | What it is (moved from) |
|---|---|
| `PYTEST_JUNIT_FILE` | `"TEST-pytest.xml"` (`_pytest_args`) |
| `pytest_command(python, reports_dir, selection, *, pattern=None)` | `[python, "-m", "pytest", "-v", "-o", "junit_family=xunit1", "-o", "junit_suite_name=pytest", "--junitxml=<reports_dir>/TEST-pytest.xml"]`, then `-o python_files=<pattern>` when a pattern is given, then `selection` (`_pytest_args`, `_suite_cmd`) |
| `PytestProgress` | the selected-total and verdict-line recogniser (`_PytestProgress`, `_PYTEST_COLLECTED_LINE`, `_PYTEST_SELECTED`, `_PYTEST_VERDICT_LINE`) |
| `pytest_reports_passing_subtest(line)`, `PYTEST_SUBTESTS_UNCOUNTED_DETAIL` | the passing-subtest sign and its detail (`_PYTEST_SUBTESTS_PASSED`, `_PYTEST_SUBTESTS_DETAIL`) |
| `PYTEST_RUNNER_FAILURES`, `pytest_failed_as_runner(returncode)` | exits 3 and 4 (`_PYTEST_RUNNER_FAILURES`, `_pytest_failed_as_runner`) |
| `pytest_error_line(output)` | pytest's last `ERROR:` / `INTERNALERROR` / conftest line (`_PYTEST_ERROR_LINE`, `_pytest_error_line`) |
| `PYTEST_PROBE_TIMEOUT_S`, `pytest_importable(python, cwd)` | the import probe, answering `True`, `False`, or `None` on a timeout (`_imports_pytest`) |
| `junit_report_paths(reports_dir)`, `produced_junit(reports_dir)` | the sorted `TEST-*.xml` paths, and whether any exists (`_report_paths`, `_produced_xml`) |
| `PYTEST_NO_REPORT_TEXT` | the fallback text when pytest wrote no JUnit and printed nothing (`_no_xml_errors_text`) |

The selection rule moves with `pytest_command`:

- with node ids, `selection` is those ids and no pattern is passed;
- otherwise the caller passes its start dir, if any, as `selection`, and its pattern, if any.

### §S2 — python's call sites

Each of these python functions calls the shared name in place of its own copy, and defines none of its
own:

1. `_suite_cmd`: `pytest_command`.
2. `_narrator`: `PytestProgress`.
3. `_FallbackWatch.observe`: `pytest_reports_passing_subtest`.
4. `_FallbackWatch.warnings`: `PYTEST_SUBTESTS_UNCOUNTED_DETAIL`.
5. `_resolve_runner`: `pytest_importable`. Python keeps its refusal wording, including for the timeout.
6. `_test_run`: `produced_junit`, `junit_report_paths`, `pytest_failed_as_runner`.
7. `_regression_run`: `produced_junit`, `junit_report_paths`, `pytest_failed_as_runner`.
8. `cmd_auto_ingest`: `produced_junit`, `junit_report_paths`.
9. `_no_xml_errors_text`: `PYTEST_NO_REPORT_TEXT`.
10. `_no_report_warning`: `pytest_error_line`.

### §S3 — the pins move once

- **`SHARED_MODULE_LINE_BUDGETS`** in these three files is re-recorded, for `_crucible_run.py`, to the
  module's newline count after the lift:
  - `tests/client/test_arduino_client_sends_its_runners_reports.py`;
  - `tests/client/test_mvn_client_sends_its_runners_reports.py`;
  - `tests/client/test_rust_client_sends_its_runners_reports.py`.

  `_crucible_axi.py` stays at 9160.
- **The namespace tripwire.** `PROSE_CITATIONS.clients.head` in `tests/project-namespace-tripwire.test.ts`
  is re-recorded once, at close-out, after the branch's last content edit. Its comment attributes the
  change per file, as the earlier re-records do.

## Acceptance criteria

- [ ] **AC1 — defined once.** Each name in §S1 is a top-level definition of `clients/_crucible_run.py`,
  exactly once. It is defined in neither `clients/python-crucible.py` nor `clients/_crucible_axi.py`.
  `_axi().<name>` is the same object as the run module's. No §S1 name was already defined by the core,
  so no re-export is shadowed.
- [ ] **AC2 — every call site.** An AST check of `clients/python-crucible.py` finds, in each of the ten
  functions of §S2, a call to (or a read of) the shared name listed for it.
  - The client defines none of `_pytest_args`, `_PytestProgress`, `_PYTEST_COLLECTED_LINE`,
    `_PYTEST_SELECTED`, `_PYTEST_VERDICT_LINE`, `_PYTEST_SUBTESTS_PASSED`, `_PYTEST_RUNNER_FAILURES`,
    `_PYTEST_ERROR_LINE`, `_pytest_failed_as_runner`, `_pytest_error_line`, `_imports_pytest`,
    `_report_paths` or `_produced_xml`.
  - `_FallbackWatch` and `_PYTEST` are still defined there.
- [ ] **AC3 — the argv is unchanged.** For each of these four cases, `_suite_cmd(python, "pytest", …)`
  returns the same list as before the lift, pinned as literals in the test:
  - node ids;
  - a start dir alone;
  - a start dir with a pattern;
  - neither.
- [ ] **AC4 — the probe's three answers.** `pytest_importable` answers:
  - `True` for an interpreter that imports pytest (this repo's own `[dev]` interpreter);
  - `False` for one that cannot (a scratch venv without pytest);
  - `None` for a stub interpreter that sleeps beyond a patched `PYTEST_PROBE_TIMEOUT_S`.

  Python's refusal on each `False` / `None` is worded as before (pinned text).
- [ ] **AC5 — python's pytest behaviour holds.** These python client suites pass with no edit to their
  assertions:
  - the pytest suites (`test_python_runner_is_declared_by_the_project.py`,
    `test_python_client_text_names_the_runner_that_ran.py`,
    `test_pytest_fixture_stays_out_of_this_repos_suite.py`);
  - `test_xmlrunner_has_left_the_python_client.py`, which constructs `client._FallbackWatch(None,
    client._PYTEST)`;
  - `test_the_clients_agree_with_the_declaration_schema.py`, which calls `python._resolve_runner`.

  A pytest run's narration counts, `subtests-uncounted` warning, and exit 3 / 4 / 5 outcomes are the same
  as before, on the committed pytest fixture.
- [ ] **AC6 — the pins.**
  - `SHARED_MODULE_LINE_BUDGETS["_crucible_run.py"]` is equal in all three pin files to the module's
    measured newline count, and `["_crucible_axi.py"]` is still 9160.
  - `_crucible_run.py` is under `RUN_LINE_LIMIT`, and still imports only the standard library
    (`test_the_run_pipeline_lives_in_its_own_shared_module.py` passes).
- [ ] **AC7 — the tripwire.**
  - `PROSE_CITATIONS.clients.head` equals the measured head at close-out, with a per-file attribution
    comment.
  - The lifted code in `_crucible_run.py` carries no CR id literal.
  - `src` and `public` re-measure at their recorded heads.

## Estimated size

5 points. About 120 lines move, ten call sites change, and three pin files plus one tripwire record are
re-recorded.

## Risk

- **A name collision would be silent.** `_reexport_run_module` skips a name the core already defines.
  AC1 guards this.
- **A patch target in a python test may name a moved symbol.** A grep of `tests/` for every symbol in
  AC2's list finds only the three suites AC5 keeps passing. RED re-runs that grep before cutting the
  branch.

## Non-goals

- Changing any pytest behaviour, argv, warning or exit.
- Lifting the unittest path or the runner choice.
- The eda client (CR-CRU-242).
