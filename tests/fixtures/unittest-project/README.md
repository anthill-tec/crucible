# unittest-project — a real unittest project for the python runner's stream

A small package (`pkg/`) and a `tests/` dir of `test_*.py` modules. The python
client's tests run it from a scratch copy, through `clients/subtest_runner.py`,
and compare what the runner reports with `expected.json` (CR-CRU-224 AC1 and
AC2).

It stays out of this repo's own suites: neither `tests/fixtures/` nor this
directory, nor its `tests/` dir, holds an `__init__.py`, so unittest discovery
started at `tests` or `tests/client` never descends into it.

The test methods carry comments, never docstrings: unittest prints a test's
docstring beside its name, which would change the console.

## The cases

Discovery runs the modules in name order, and each class's methods in name
order. CR-CRU-189's counting rule turns the 20 tests `countTestCases()` finds
into 28 counted cases.

| Module | Case | Outcome |
|---|---|---|
| `test_class_setup.py` | `AHealthyNeighbourTest.test_runs_before_the_broken_class` | pass; it sorts first, so it runs before the broken class |
| | `BrokenSetUpClassTest.setUpClass` raises `ConnectionError` | one error holder, `setUpClass (test_class_setup.BrokenSetUpClassTest)`, suite `unittest.suite._ErrorHolder`; `test_never_runs` never runs |
| `test_non_ascii.py` | `test_grüße_aus_dem_café` | fail, with a message holding two-, three- and four-byte characters |
| | `test_ñandú_läuft` | pass, under a non-ASCII name |
| `test_subtest_shapes.py` | `test_body_fails_after_its_subtests_pass` | two passing subtests, each a case, and the parent's own failure, a case of its own |
| | `test_every_subtest_passes` | three passing subtests, each a case; the parent is not one |
| | `test_expected_failure_with_subtests` | under `@expectedFailure`: one case, as a whole |
| | `test_nested_subtests` | four innermost subtests (one fails), each a case; the enclosing subtests are not |
| | `test_one_subtest_fails` | one failing and one passing subtest, each a case |
| `test_unimportable.py` | the module fails to load (`ModuleNotFoundError`) | one case, `test_unimportable`, suite `unittest.loader._FailedTest` |
| `test_verdicts.py` | `TearDownFailureTest.test_body_passes_but_teardown_fails` | its tearDown raises: an error |
| | `VerdictsTest.test_adds_two_numbers` | pass |
| | `VerdictsTest.test_adds_with_a_wrong_expectation` | fail (an assertion) |
| | `VerdictsTest.test_divides_by_zero` | error, raised inside `pkg/arith.py` |
| | `VerdictsTest.test_is_expected_to_fail` | expected failure |
| | `VerdictsTest.test_is_skipped` | skip |
| | `VerdictsTest.test_succeeds_unexpectedly` | unexpected success |
| `test_witness.py` | three witnesses, all passing | see below |

**The witnesses** sort last, so they run after every other case. With
`UNITTEST_PROJECT_WITNESS_DIR` set, each writes `<method>.json` there:

- `test_first_look_at_the_stream` and `test_second_look_at_the_stream` record
  the text of the file `UNITTEST_PROJECT_WITNESS_STREAM` names. That is the
  stream file, named again under a variable the runner leaves alone.
- `test_records_its_environment` records whether `CRUCIBLE_STREAM` is in its
  own environment.

With neither variable set, as when `expected.json` was frozen, they record
nothing and pass.

## How `expected.json` was produced

It was frozen on 2026-10-31 at `fd92ea6`, before xmlrunner left the python
client, from xmlrunner's report of these same cases, read the way the board
reads it. The tools were Python 3.14.8 (the repo's `.venv`) and
unittest-xml-reporting (xmlrunner) 4.0.0.

1. The fixture was copied to a scratch dir under `/tmp`, without
   `expected.json` and this README.
2. In that copy, with `CRUCIBLE_STREAM` and the witness variables unset and
   `PYTHONDONTWRITEBYTECODE=1`, the runner of that commit ran:
   `<repo>/.venv/bin/python <repo>/clients/subtest_runner.py discover -s tests -p 'test_*.py' -o <reports> -v`.
   It exited 1 and wrote eight `TEST-*.xml` files, one per test class.
3. `countTestCases()` came from
   `unittest.defaultTestLoader.discover('tests', 'test_*.py').countTestCases()`,
   run in the copy with the same interpreter: 20.
4. A scratch board (`tests/client/real_board.py`) took the reports as the
   python client sent them: `POST /api/v2/runs` with `codec: "junit"`,
   `stack: "python"`, and the report texts as `data`. The stored run was read
   back through `GET /api/v2/events/<id>`. That stored run gives each case's
   `name`, `suite` and `status` and its failure, the `tree`, the `summary`
   and the distinct-file count (`fileCount`, from the ingest answer).
5. Each case's `id` and `file` are not kept in the board's tree, so they came
   from the reports themselves:
   - `id` is the testcase's `classname` and `name` joined by `.`, or the
     `name` alone when `classname` is empty (the error holder);
   - `file` is the testcase's `file` attribute.

**What it records:**
- `exitCode` (1);
- `countTestCases` (20);
- `caseCount` (28);
- `summary` and `fileCount`;
- `files`;
- `cases`: one per counted case, sorted by `id`, each with its `id`, `name`,
  `suite`, `file`, `status` and, for a failing case, its `failure`;
- `tree`: the board's stored tree, its suites sorted by name, each suite's
  cases sorted by name, durations removed.

xmlrunner orders a suite's cases by outcome, not by run order, so both
comparisons key a case by its suite and name and ignore order.

**Normalised:**
- the scratch copy's absolute root, and its real path, became `<project>`;
- the interpreter's stdlib directory (the parent of `unittest`'s package
  directory) became `<stdlib>`;
- the suite names lost xmlrunner's `-<timestamp>` suffix (14 digits);
- each failure is kept as its stable digest, not its full text:
  - `message`: the board's message rule (the trimmed message, else the
    trace's first non-blank line), cut to its first line;
  - `type`;
  - `traceHead` and `traceTail`: the trace's first and last non-blank lines;
  - `frames`: the trace's frames in the project's own files, as
    `[path, line, function]`.

  Full traces carry the interpreter's own stdlib positions and caret lines,
  which change across Python releases. The digest does not. A comparison
  applies the same normalisation and digest to the run it checks.

**What xmlrunner recorded, kept as found:**
- an expected failure is a `<skipped>` testcase, so the board stores it
  `pending`;
- an unexpected success is an error of type `UnexpectedSuccess` with
  xmlrunner's own message and no trace;
- a `setUpClass` error holder carries the file of the test started before it.
  That is why `AHealthyNeighbourTest` sorts ahead of the broken class: the
  holder's `file` is then the broken class's own module;
- a load error's `file` is unittest's own `loader` module, outside the
  project, so it stays absolute (normalised to `<stdlib>`).

The fixture's sources are frozen along with `expected.json`: the `frames` name
positions inside them. Any edit to a fixture source makes `expected.json`
stale, and it can no longer be refrozen from xmlrunner.
