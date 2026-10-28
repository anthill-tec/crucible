"""No composed gate is green on a failed runner.

bun's `pre-merge-gate` is the fleet's composed gate: it runs bun's own
whole-suite regression (which covers every bun-owned declared suite), and it
dispatches every declared suite another stack owns to that stack's client as
a separate process, then reports them all in ONE envelope with the totals of
every run. A runner that exits non-zero over a report that records only
passes is a failed run: the board adds its `runner / exit <n>` case, and the
gate that composed the run is not green.

`ComposedGateOverAFailedRunnerTest`, against a REAL scratch board
(`tests/client/real_board.py`), drives the real `clients/bun-crucible.py
pre-merge-gate` as a subprocess over a project whose `package.json` declares a
bun-owned suite (`test:unit`) and a python-owned one (`test:client`, whose
script invokes the real `clients/python-crucible.py regression`):

  * the bun whole-suite runner exits 1 over a passing-only report — the gate
    exits non-zero, its envelope is `ok: false`, its totals and the covered
    suite's row carry the board's added case, and the stored run holds it;
  * the dispatched python suite's runner exits 1 over a passing-only report
    while bun's run is clean — the same, attributed to `test:client`;
  * both runners exit 0 over clean reports — the gate is green, exits 0, and
    no run carries a `runner` suite (nothing else changes).

Each fake runner reads its OWN exit variable (`FAKE_BUN_EXIT`,
`FAKE_PYTHON_EXIT`), so one drive can fail one stack's runner and not the
other's.

Invocation:
    python3 -m unittest tests.client.test_no_composed_gate_is_green_on_a_failed_runner -v
"""

import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 180

BUN_SUITE = "test:unit"
PYTHON_SUITE = "test:client"

BUN_FILE = "math.test.ts"
BUN_CASE = "adds two numbers"
PYTHON_CLASS = "gate_probe.GateProbeCase"
PYTHON_CASE = "test_the_python_suite_passes"

GATE_SUITE_FAILED = "gate-suite-failed"

# Keys that would let the shell running this suite decide what either client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "FAKE_BUN_EXIT", "FAKE_PYTHON_EXIT")

# A fake `bun`: writes one passing JUnit case wherever `--reporter-outfile=`
# points, then exits FAKE_BUN_EXIT.
_FAKE_BUN = r'''
import os
import sys

FILE, CASE = ''' + repr((BUN_FILE, BUN_CASE)) + r'''

junit = None
for arg in sys.argv[1:]:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
sys.stdout.write(FILE + ":\n(pass) " + CASE + " [0.02ms]\n\n 1 pass\n 0 fail\n")
sys.stdout.flush()
if junit:
    directory = os.path.dirname(junit)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(junit, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="1" failures="0">'
            '<testsuite name="%s" file="%s" tests="1" failures="0">'
            '<testcase name="%s" classname="" time="0.00002" file="%s"/>'
            '</testsuite></testsuites>' % (FILE, FILE, CASE, FILE))
sys.exit(int(os.environ.get("FAKE_BUN_EXIT", "0")))
'''

# A fake interpreter for the python client: run as the suite (`... -o <dir>`),
# it writes one passing JUnit case into the `-o` directory, then exits
# FAKE_PYTHON_EXIT. A coverage.py probe (`-c <script>`) answers that the
# project declares its source.
_FAKE_PYTHON = r'''
import os
import sys

CLASS, CASE = ''' + repr((PYTHON_CLASS, PYTHON_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
outdir = None
for i, arg in enumerate(argv):
    if arg == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]
sys.stderr.write("%s (%s.%s) ... ok\n" % (CASE, CLASS, CASE))
sys.stderr.write("\n----------------------------------------------------------------------\n"
                 "Ran 1 test in 0.001s\n\nOK\n")
sys.stderr.flush()
if outdir:
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "TEST-%s.xml" % CLASS), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<testsuite name="%s" tests="1" errors="0" failures="0" '
                     'skipped="0"><testcase classname="%s" name="%s" '
                     'time="0.001"></testcase></testsuite>\n' % (CLASS, CLASS, CASE))
sys.exit(int(os.environ.get("FAKE_PYTHON_EXIT", "0")))
'''


def _executable(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)
    return path


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-3000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")


_BOARD: RealBoard | None = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the board that adds the runner's case is a REAL server, and "
            "without `bun` there is none to boot — a missing toolchain, not "
            "a passing assertion")
    _BOARD = RealBoard(bun, "composed-gate-runner-exit-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class ComposedGateOverAFailedRunnerTest(unittest.TestCase):
    """The gate's exit, its envelope and the runs it filed, for a composed
    gate one of whose runners exited non-zero over a passing-only report."""

    def setUp(self):
        board = _BOARD
        if board is None:
            self.fail("the module's real board was never booted")
        self.board = board
        self.project = new_scratch("composed-gate-runner-exit-")
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        Path(self.project, "tests").mkdir()
        self.fake_bun = _executable(os.path.join(self.project, "fake_bun.py"),
                                    _FAKE_BUN)
        self.fake_python = _executable(
            os.path.join(self.project, "fake_python.py"), _FAKE_PYTHON)
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(PYTHON_CLIENT), "regression",
            "--project-dir", self.project, "--python", self.fake_python,
            "--reports", "py-reports"))
        Path(self.project, "package.json").write_text(json.dumps({
            "name": "composed-gate-runner-exit", "private": True,
            "scripts": {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite},
        }, indent=2))
        self.board.install(self.project)

    # -- the drive -----------------------------------------------------------

    def drive_gate(self, agent, *, bun_exit, python_exit):
        env = scrubbed_env(None)
        for key in _SCRUBBED:
            env.pop(key, None)
        env["FAKE_BUN_EXIT"] = str(bun_exit)
        env["FAKE_PYTHON_EXIT"] = str(python_exit)
        cmd = [sys.executable, str(BUN_CLIENT), "pre-merge-gate",
               "--agent", agent, "--project-dir", self.project,
               "--package-dir", self.project, "--bun", self.fake_bun,
               "--reports", "reports", "--skip-check"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def gate_envelope(self, result):
        """The gate's own envelope: the LAST `axi:` document on stdout naming
        `pre-merge-gate`."""
        out = result.stdout or ""
        starts = [i for i in range(len(out))
                  if out.startswith("axi:", i) and (i == 0 or out[i - 1] == "\n")]
        for start in reversed(starts):
            try:
                decoded = TOON.decode(out[start:])
            except ValueError:
                continue
            axi = decoded.get("axi") if isinstance(decoded, dict) else None
            if isinstance(axi, dict) and axi.get("verb") == "pre-merge-gate":
                return axi
        self.fail(f"the gate put no `pre-merge-gate` envelope on stdout; "
                  f"{_diagnostics(result)}")

    def stored_runs(self, agent, result, expected):
        events = self.board.test_events(agent)
        self.assertEqual(
            len(events), expected,
            f"the gate files exactly {expected} test run(s) for its agent; "
            f"events={events!r} {_diagnostics(result)}")
        return [self.board.event(e["id"]) for e in events]

    @staticmethod
    def run_marked(runs, mark):
        return [run for run in runs if mark in repr(run.get("tree"))]

    @staticmethod
    def runner_suites(run):
        return [s for s in (run.get("tree") or []) if s.get("name") == "runner"]

    def assert_runner_case(self, run, code):
        runner = self.runner_suites(run)
        self.assertEqual(len(runner), 1,
                         f"exactly one `runner` suite; tree={run.get('tree')!r}")
        children = runner[0].get("children") or []
        self.assertEqual(len(children), 1, f"runner suite={runner[0]!r}")
        case = children[0]
        self.assertEqual(case.get("name"), f"exit {code}", f"case={case!r}")
        self.assertEqual(case.get("status"), "fail", f"case={case!r}")
        self.assertEqual(
            (case.get("failure") or {}).get("message"),
            f"the runner exited {code} but its report records no failure",
            f"case={case!r}")

    def assert_counts(self, counts, *, total, passed, failed, where):
        self.assertEqual(
            (counts.get("total"), counts.get("passed"), counts.get("failed")),
            (total, passed, failed),
            f"{where} counts (total, passed, failed); got {counts!r}")

    @staticmethod
    def suite_row(envelope, suite):
        rows = [r for r in (envelope.get("suites") or [])
                if isinstance(r, dict) and r.get("suite") == suite]
        return rows[0] if len(rows) == 1 else {"rows": envelope.get("suites")}

    @staticmethod
    def failed_warnings(envelope):
        return [w for w in (envelope.get("warnings") or [])
                if isinstance(w, dict) and w.get("code") == GATE_SUITE_FAILED]

    # -- the bun-owned suite: the whole-suite runner fails ------------------

    def test_a_gate_whose_bun_runner_exits_1_over_a_passing_report_is_not_green(self):
        agent = "composed-gate-bun-runner-exit"
        result = self.drive_gate(agent, bun_exit=1, python_exit=0)
        self.assertNotEqual(result.returncode, 0,
                            f"a gate one of whose runners exited 1 never exits "
                            f"green; {_diagnostics(result)}")
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        # bun: 1 pass + the board's runner case; python: 1 pass.
        self.assert_counts(envelope.get("run") or {}, total=3, passed=2,
                           failed=1, where="the gate's run")
        row = self.suite_row(envelope, BUN_SUITE)
        self.assertIn("coveredBy", row,
                      f"the bun-owned suite is covered by the whole-suite run; "
                      f"row={row!r}")
        self.assert_counts(row, total=2, passed=1, failed=1,
                           where=f"the `{BUN_SUITE}` row's")
        failed = self.failed_warnings(envelope)
        self.assertEqual(len(failed), 1,
                         f"exactly one failed-suite warning; "
                         f"warnings={envelope.get('warnings')!r}")
        self.assertIn(f"`{BUN_SUITE}`", failed[0].get("detail") or "",
                      f"the warning names the suite the failed run covered; "
                      f"warning={failed[0]!r}")
        runs = self.stored_runs(agent, result, 2)
        bun_runs = self.run_marked(runs, BUN_CASE)
        self.assertEqual(len(bun_runs), 1, f"runs={runs!r}")
        self.assert_runner_case(bun_runs[0], 1)
        self.assert_counts(bun_runs[0].get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored bun run's")
        python_runs = self.run_marked(runs, PYTHON_CASE)
        self.assertEqual(len(python_runs), 1, f"runs={runs!r}")
        self.assertEqual(self.runner_suites(python_runs[0]), [],
                         "the clean python run gets no `runner` suite")

    # -- the dispatched python-owned suite: its runner fails ----------------

    def test_a_gate_whose_dispatched_python_runner_exits_1_over_a_passing_report_is_not_green(self):
        agent = "composed-gate-python-runner-exit"
        result = self.drive_gate(agent, bun_exit=0, python_exit=1)
        self.assertNotEqual(result.returncode, 0,
                            f"a gate whose dispatched suite's runner exited 1 "
                            f"never exits green; {_diagnostics(result)}")
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        # bun: 1 pass; python: 1 pass + the board's runner case.
        self.assert_counts(envelope.get("run") or {}, total=3, passed=2,
                           failed=1, where="the gate's run")
        row = self.suite_row(envelope, PYTHON_SUITE)
        self.assertEqual(row.get("stack"), "python", f"row={row!r}")
        self.assert_counts(row, total=2, passed=1, failed=1,
                           where=f"the `{PYTHON_SUITE}` row's")
        failed = self.failed_warnings(envelope)
        self.assertEqual(len(failed), 1,
                         f"exactly one failed-suite warning; "
                         f"warnings={envelope.get('warnings')!r}")
        self.assertIn(f"`{PYTHON_SUITE}`", failed[0].get("detail") or "",
                      f"the warning names the dispatched suite; "
                      f"warning={failed[0]!r}")
        runs = self.stored_runs(agent, result, 2)
        python_runs = self.run_marked(runs, PYTHON_CASE)
        self.assertEqual(len(python_runs), 1, f"runs={runs!r}")
        self.assert_runner_case(python_runs[0], 1)
        self.assert_counts(python_runs[0].get("summary") or {}, total=2,
                           passed=1, failed=1, where="the stored python run's")
        bun_runs = self.run_marked(runs, BUN_CASE)
        self.assertEqual(len(bun_runs), 1, f"runs={runs!r}")
        self.assertEqual(self.runner_suites(bun_runs[0]), [],
                         "the clean bun run gets no `runner` suite")

    # -- nothing else changes ----------------------------------------------

    def test_a_gate_whose_runners_both_exit_0_over_clean_reports_is_green(self):
        agent = "composed-gate-clean"
        result = self.drive_gate(agent, bun_exit=0, python_exit=0)
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assert_counts(envelope.get("run") or {}, total=2, passed=2,
                           failed=0, where="the gate's run")
        self.assertEqual(self.failed_warnings(envelope), [],
                         f"warnings={envelope.get('warnings')!r}")
        runs = self.stored_runs(agent, result, 2)
        for run in runs:
            self.assertEqual(self.runner_suites(run), [],
                             f"a clean runner adds no `runner` suite; "
                             f"tree={run.get('tree')!r}")
            self.assert_counts(run.get("summary") or {}, total=1, passed=1,
                               failed=0, where="a stored run's")


if __name__ == "__main__":
    unittest.main()
