"""The helpers of `test_a_gate_milestone_carries_each_suite_result.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import os
import stat
import sys
from pathlib import Path


BUN_SUITE = "test:unit"

PYTHON_SUITE = "test:client"

EXCLUDED_SUITE = "test:e2e"

BUN_FILE = "math.test.ts"

BUN_CASE = "adds two numbers"

BUN_FAILING_CASE = "subtracts two numbers on purpose wrongly"

PYTHON_CLASS = "gate_probe.GateProbeCase"

PYTHON_CASE = "test_the_python_suite_passes"

PYTHON_FAILING_CASE = "test_the_python_suite_fails_on_purpose"

# A fake `bun`. `bun x tsc …` (the gate's step 0) fails with a tsc error when
# FAKE_TSC_FAIL=1; `bun test …` writes one passing JUnit case — plus one
# failing case, and exits 1, when FAKE_BUN_FAIL=1.
_FAKE_BUN = r'''
import os
import sys

FILE, CASE, FAILING = ''' + repr((BUN_FILE, BUN_CASE, BUN_FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:2] == ["x", "tsc"]:
    if os.environ.get("FAKE_TSC_FAIL") == "1":
        sys.stdout.write("src/probe.ts(1,1): error TS2304: Cannot find name 'undeclared'.\n")
        sys.exit(2)
    sys.exit(0)
fail = os.environ.get("FAKE_BUN_FAIL") == "1"
junit = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
cases = '<testcase name="%s" classname="" time="0.00002" file="%s"/>' % (CASE, FILE)
if fail:
    cases += ('<testcase name="%s" classname="" time="0.00002" file="%s">'
              '<failure message="expected 1 received 2" type="AssertionError"/>'
              '</testcase>' % (FAILING, FILE))
total, failures = (2, 1) if fail else (1, 0)
if junit:
    directory = os.path.dirname(junit)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(junit, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="%d" failures="%d">'
            '<testsuite name="%s" file="%s" tests="%d" failures="%d">%s'
            '</testsuite></testsuites>' % (total, failures, FILE, FILE, total, failures, cases))
sys.exit(1 if fail else 0)
'''

# The python stand-in — a fake interpreter for the python client, run as the suite, writes one
# passing case, plus one failing case (and exits 1) when FAKE_PYTHON_FAIL=1,
# as a Crucible event stream to the file `CRUCIBLE_STREAM` names, taking the
# variable out of its own environment first, and writes no JUnit (CR-CRU-224
# section S1). It records the `CRUCIBLE_STREAM` it was handed to the file
# FAKE_PYTHON_STREAM_CAPTURE names. A coverage.py probe (`-c <script>`)
# answers true.
_FAKE_PYTHON = r'''
import json
import os
import sys

CLASS, CASE, FAILING = ''' + repr((PYTHON_CLASS, PYTHON_CASE, PYTHON_FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
fail = os.environ.get("FAKE_PYTHON_FAIL") == "1"
stream = os.environ.pop("CRUCIBLE_STREAM", None)
capture = os.environ.get("FAKE_PYTHON_STREAM_CAPTURE")
if capture:
    with open(capture, "w") as handle:
        handle.write(stream or "")
file = CLASS.split(".")[0] + ".py"
cases = [dict(event="test-end", id=CLASS + "." + CASE, name=CASE, suite=CLASS,
              file=file, status="pass", duration_ms=1)]
if fail:
    cases.append(dict(event="test-end", id=CLASS + "." + FAILING, name=FAILING,
                      suite=CLASS, file=file, status="fail", duration_ms=1,
                      failure=dict(message="2 != 3", type="AssertionError",
                                   trace="AssertionError: 2 != 3")))
total, failures = (2, 1) if fail else (1, 0)
sys.stderr.write("Ran %d test(s)\n\n%s\n" % (total, "FAILED (failures=1)" if fail else "OK"))
sys.stderr.flush()
if stream:
    with open(stream, "w", encoding="utf-8") as handle:
        for event in ([dict(event="run-start", total=total)] + cases
                      + [dict(event="run-end", total=total, passed=total - failures,
                              failed=failures, pending=0, duration_ms=1)]):
            handle.write(json.dumps(event) + "\n")
            handle.flush()
sys.exit(1 if fail else 0)
'''


def _executable(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)
    return path
