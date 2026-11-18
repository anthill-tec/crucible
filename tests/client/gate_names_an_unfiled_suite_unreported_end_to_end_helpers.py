"""The helpers of `test_gate_names_an_unfiled_suite_unreported_end_to_end.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""




_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR",
             "PYTHON_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL", "PYTEST_ADDOPTS",
             "COVERAGE_RCFILE", "COVERAGE_PROCESS_START",
             "RUST_CRUCIBLE_PROJECT_DIR", "CARGO_TARGET_DIR")

# A passing run in each runner's report shape: a gate that filed it would be
# green, so a gate that is not green is so for the unfiled run alone.
GREEN_BUN_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="1" failures="0">\n'
    '  <testsuite name="tests/green.test.ts" file="tests/green.test.ts" '
    'tests="1" failures="0">\n'
    '    <testcase name="passes" classname="green" time="0.001" '
    'file="tests/green.test.ts" />\n'
    '  </testsuite>\n'
    '</testsuites>\n')

GREEN_PYTHON_STREAM = (
    '{"event": "run-start", "total": 1}\n'
    '{"event": "test-end", "id": "test_green.GreenTest.test_passes", '
    '"name": "test_passes", "suite": "test_green.GreenTest", '
    '"file": "tests/test_green.py", "status": "pass", "duration_ms": 1}\n'
    '{"event": "run-end", "total": 1, "passed": 1, "failed": 0, '
    '"pending": 0, "duration_ms": 1}\n')

GREEN_LCOV = ("TN:\nSF:src/green.ts\nFNF:1\nFNH:1\nDA:1,1\nDA:2,1\n"
              "LF:2\nLH:2\nend_of_record\n")

# The fake runners' shared tail: the cut this runner was told to make, as a
# GET of the proxy's control path, made while the suite is still running.
_CUT = r'''
cut = os.environ.get(CUT_VAR)
if cut:
    urllib.request.urlopen(cut, timeout=60).read()
'''

# `bun test`'s stand-in: GREEN_BUN_JUNIT to `--reporter-outfile=`, GREEN_LCOV
# to `<--coverage-dir>/lcov.info` under `--coverage`, the cut FAKE_BUN_CUT
# names, exit 0.
_FAKE_BUN = r'''
import os
import sys
import urllib.request

CUT_VAR = "FAKE_BUN_CUT"
JUNIT, LCOV = ''' + repr((GREEN_BUN_JUNIT, GREEN_LCOV)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
junit = coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
sys.stdout.write("tests/green.test.ts:\n(pass) green > passes [0.01ms]\n")
sys.stdout.flush()
if junit:
    write(junit, JUNIT)
if "--coverage" in argv and coverage_dir:
    write(os.path.join(coverage_dir, "lcov.info"), LCOV)
''' + _CUT + r'''
sys.exit(0)
'''

# The python interpreter's stand-in: `-c <probe>` answers `true`; `-m coverage
# lcov ... -o <file>` writes GREEN_LCOV there; a suite run (the subtest runner
# under `coverage run`) writes GREEN_PYTHON_STREAM to the file
# `CRUCIBLE_STREAM` names, taking the variable out of its own environment
# first (CR-CRU-224 §S1), records that path to the file
# FAKE_PYTHON_STREAM_CAPTURE names, makes the cut FAKE_PYTHON_CUT names, and
# exits 0. It writes no JUnit.
_FAKE_PYTHON = r'''
import os
import sys
import urllib.request

CUT_VAR = "FAKE_PYTHON_CUT"
STREAM, LCOV = ''' + repr((GREEN_PYTHON_STREAM, GREEN_LCOV)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
if argv[:3] == ["-m", "coverage", "lcov"]:
    write(argv[argv.index("-o") + 1], LCOV)
    sys.exit(0)
stream = os.environ.pop("CRUCIBLE_STREAM", None)
capture = os.environ.get("FAKE_PYTHON_STREAM_CAPTURE")
if capture:
    write(capture, stream or "")
if stream:
    write(stream, STREAM)
sys.stderr.write("test_passes (test_green.GreenTest.test_passes) ... ok\n")
sys.stdout.write("fake python ran\n")
sys.stdout.flush()
''' + _CUT + r'''
sys.exit(0)
'''
