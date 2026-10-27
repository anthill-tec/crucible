# Real reports, one set per stack

Each directory holds what a stack's runner wrote on a real run of a small scratch
project with passing, failing and skipped cases, invoked the way that stack's
client invokes it (`clients/<stack>-crucible.py`). Beside the reports,
`expected.json` holds that client's own parse of them, frozen by
`freeze-client-parse.py` (it imports each client by path and calls its parser
functions; rerun it with `python3 tests/fixtures/reports/freeze-client-parse.py`).
`expected.json` also names its inputs: the report files in the order the client
reads them, the coverage files and their codec, and for bun the console.

`tests/real-stack-reports-decode-on-the-board.test.ts` sends each set to
`POST /api/v2/runs` and compares the board's decode with the frozen parse.

The scratch projects lived outside the repository and are not kept; only their
output is. Every report is the runner's own bytes except for the neutral-path
rewrites listed under each stack.

## Tool versions

| Stack | Runner | Coverage |
|---|---|---|
| bun | bun 1.4.2 (`bun test --reporter=junit`) | bun 1.4.2 (`--coverage-reporter=lcov`) |
| python (xmlrunner) | Python 3.14.8, unittest-xml-reporting 4.0.0 through `clients/subtest_runner.py` | coverage.py 7.17.0 (`coverage run`, `coverage lcov`) |
| python (pytest) | Python 3.14.8, pytest 9.1.1 | coverage.py 7.17.0 |
| mvn | Apache Maven 3.9.9, JDK 25.0.1, JUnit Jupiter 5.13.4, maven-surefire-plugin 3.5.4, maven-failsafe-plugin 3.5.4 | jacoco-maven-plugin 0.8.14 |
| rust | cargo 1.97.1, cargo-nextest 0.9.130 | cargo-llvm-cov 0.8.4 |
| arduino | g++ (GCC) 16.2.1, GNU Make 4.4.1, a native harness (below) | gcovr 8.7 (`--lcov`) |

## How each set was produced

**bun/** — two test files (a nested `describe`, a `test.skip`, a `test.todo`, an
assertion failure, a thrown `Error`, a thrown plain object, a timeout, and a
case that spins for 2.7 ms):
`bun test --timeout 30000 tests/math.test.ts tests/text.test.ts --reporter=junit --reporter-outfile=junit.xml --coverage --coverage-reporter=lcov --coverage-dir=cov`,
stdout and stderr captured together into `console.txt` (the client's `raw`).
bun 1.4.2 writes each failure's `message` attribute (or its text) into the
JUnit report, so none of these failures is bare.
Rewritten: the testsuite `hostname` attribute to `host`; the scratch project's
absolute path in `console.txt` to `/project/`.

**python/xmlrunner/** — a `pkg` package and three `tests/test_*.py` modules (a
failure, an error, `skip`, `skipIf`, passing subtests):
`python3 -m coverage run --source pkg --data-file=.coverage clients/subtest_runner.py discover -s tests -p 'test_*.py' -o <reports> -v`,
then `python3 -m coverage lcov --data-file=.coverage -o lcov.info`. One
`TEST-*.xml` per test class.
Rewritten: the scratch project's absolute path in the tracebacks to `/project/`.

**python/pytest/** — the same package, two pytest modules (module-level tests
and test classes, a failure, an error, `skip`, `xfail`, a parametrized test):
`python3 -m coverage run --source pkg --data-file=.coverage-pytest -m pytest -v -o junit_family=xunit1 --junitxml=TEST-pytest.xml -p no:cacheprovider ptests`,
then `coverage lcov`. One report, one suite named `pytest`.
Rewritten: the testsuite `hostname` attribute to `host`; the scratch project's
absolute path to `/project/`.

**mvn/** — a two-module reactor (`core`, `app`): surefire tests in both (an
assertion failure, an error, `@Disabled`, a failed assumption, a `@Nested`
class, a parameterized test, and a `@TestFactory` that generates no tests, whose
report holds no testcase) and a failsafe `GreeterIT` in `app` with one failure;
surefire's `testFailureIgnore` set so the reactor reaches failsafe and JaCoCo's
`report` (bound to `post-integration-test`):
`mvn -o -B clean verify`. The reports and the CSVs keep the reactor's layout
(`<module>/target/surefire-reports/`, `<module>/target/failsafe-reports/`,
`<module>/target/site/jacoco/jacoco.csv`), which is where the maven client reads
them from (`_report_dirs`, `_collect_jacoco`).
Rewritten: each report's `<properties>` block (the JVM's system properties,
which name the machine and its user) to an empty `<properties/>`.

**rust/** — one crate: unit tests in `src/lib.rs` (an assertion failure, a
`should_panic`, an `#[ignore]`) and integration tests `tests/parity.rs` (a
failure, a 2.7 ms spin), `tests/divide.rs` and `tests/pending.rs` (`#[ignore]`
only), with a `ci` nextest profile writing `junit.xml`:
`cargo llvm-cov --failure-mode all nextest --lcov --output-path target/lcov.info -P ci --ignore-run-fail`.
The run skipped three ignored tests; nextest 0.9.130 writes no testcase for an
ignored test, so the report holds passing and failing cases only.
Rewritten: the `SF:` path in `lcov.info` to `/project/`.

**arduino/** — a native host harness in the shape the arduino client reads: a
small Unity-style C++ header (`Unity`'s `file:line:name:PASS|FAIL|IGNORE` verdict
lines on stdout) and a `Makefile` whose `junit` target builds one binary per
test source — the ring-buffer test twice, once per board capacity
(`test_ring_uno`, `test_ring_esp32`) — runs each, and leaves one
`TEST-<binary>.xml` per binary in `$(REPORTS_DIR)`; with `COVERAGE_DIR` set it
builds with `--coverage` and writes `$(COVERAGE_DIR)/lcov.info` with gcovr:
`REPORTS_DIR=<reports> COVERAGE_DIR=<cov> make junit`. Failures, ignored tests
and a 2.7 ms spin are in the run.
Rewritten: the `SF:` paths in `lcov.info` to `/project/`.
