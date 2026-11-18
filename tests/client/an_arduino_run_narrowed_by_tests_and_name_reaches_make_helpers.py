"""The helpers of `test_an_arduino_run_narrowed_by_tests_and_name_reaches_make.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, load_toon, new_scratch, scrubbed_env


TOON = load_toon()

ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"

TIMEOUT = 120

NATIVE_DIR = "tests/native"

RUNS_INGEST = "/api/v2/runs"

# Keys that would let the shell running this suite steer or identify the
# client, plus the two narrowing variables, which a test sets only on purpose.
_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID", "TESTS", "TEST_NAME")

#: The fixture project's test files and their test functions.
CATALOGUE = (
    ("test_a", "test_stall_detected"),
    ("test_a", "test_init"),
    ("test_b", "test_limit_clamped"),
    ("test_b", "test_reset"),
    ("test_c", "test_stall_recovery"),
    ("test_c", "test_speed"),
)

# The stand-in for the native test binaries a Makefile runs. Its first
# argument is the make target that ran it.
_FAKE_NATIVE = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
target = sys.argv[1] if len(sys.argv) > 1 else "?"
tests = os.environ.get("TESTS")
names = os.environ.get("TEST_NAME")
with open(os.path.join(here, "make_runs.jsonl"), "a") as handle:
    handle.write(json.dumps({
        "target": target,
        "tests_present": "TESTS" in os.environ, "tests": tests,
        "test_name_present": "TEST_NAME" in os.environ, "test_name": names,
    }) + "\n")
with open(os.path.join(here, "catalogue.json")) as handle:
    catalogue = json.load(handle)

selected = []
for stem, name in catalogue:
    if tests is not None and stem not in tests.split():
        continue
    if names is not None:
        elements = [e.split("*", 1)[0] for e in names.split(",")]
        if not any(e in name or e in stem for e in elements):
            continue
    selected.append((stem, name))

for line, (stem, name) in enumerate(selected, start=10):
    sys.stdout.write("test/%s.c:%d:%s:PASS\n" % (stem, line, name))
sys.stdout.write("-----------------------\n%d Tests 0 Failures 0 Ignored\nOK\n"
                 % len(selected))
sys.stdout.flush()

reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)
if selected:
    suites = []
    for stem in sorted({s for s, _ in selected}):
        cases = [n for s, n in selected if s == stem]
        suites.append(
            '<testsuite name="%s" tests="%d" failures="0">%s</testsuite>'
            % (stem, len(cases), "".join(
                '<testcase classname="%s" name="%s" time="0.001"/>' % (stem, n)
                for n in cases)))
    body = "<testsuites>%s</testsuites>" % "".join(suites)
else:
    body = '<testsuite name="native" tests="0" failures="0"></testsuite>'
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?>' + body)
sys.exit(0)
'''


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def sent_case_count(body):
    """The `<testcase>` elements across the reports a `/api/v2/runs` body
    carries inline as `data`: the cases the run was filed with."""
    return sum(1 for text in (body or {}).get("data") or []
               for _ in ET.fromstring(text).iter("testcase"))  # noqa: S314 - a report the test's own stand-in wrote


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={(result.stdout or '')[:1500]!r} "
            f"stderr={(result.stderr or '')[-2000:]!r}")


class _NarrowingProject:
    """A scratch firmware project whose Makefile runs the stand-in native
    binaries, driven through the real client."""

    VERB = ""

    def make_project(self, *, declare_integration=False, catalogue=CATALOGUE):
        self.project = new_scratch("arduino-narrowed-run-")
        self.addCleanup(shutil.rmtree, self.project, True)  # type: ignore[attr-defined]
        self.native_dir = os.path.join(self.project, *NATIVE_DIR.split("/"))
        os.makedirs(self.native_dir)
        Path(self.native_dir, "run_native.py").write_text(_FAKE_NATIVE)
        Path(self.native_dir, "catalogue.json").write_text(
            json.dumps([list(case) for case in catalogue]))
        targets = ["junit"] + (["junit-integration"] if declare_integration else [])
        Path(self.native_dir, "Makefile").write_text(
            ".PHONY: " + " ".join(targets) + "\n" + "".join(
                f"{t}:\n\t{sys.executable} run_native.py {t}\n" for t in targets))

    def drive(self, verb, *extra, agent=None, client_env=None):
        env = scrubbed_env()
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update(client_env or {})
        cmd = [sys.executable, str(ARDUINO_CLIENT), verb,
               "--project-dir", self.project, "--dir", NATIVE_DIR,
               *(["--agent", agent] if agent else []), *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def make_runs(self):
        """Every `make` run the stand-in recorded, in order."""
        path = Path(self.native_dir, "make_runs.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()
                if line.strip()]

    def the_one_make_run(self, result):
        runs = self.make_runs()
        self.assertEqual(  # type: ignore[attr-defined]
            len(runs), 1,
            f"`make` runs exactly once for one {self.VERB or 'verb'} run; "
            f"recorded runs={runs!r} {_diagnostics(result)}")
        return runs[0] if runs else {}

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is one TOON envelope; {_diagnostics(result)}")
        return envelope or {}

    def assert_saw_neither(self, record, result):
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("tests_present"), record.get("test_name_present")),
            (False, False),
            f"`make` runs with neither TESTS nor TEST_NAME in its environment "
            f"unless the client's own flag set it; recorded={record!r} "
            f"{_diagnostics(result)}")
