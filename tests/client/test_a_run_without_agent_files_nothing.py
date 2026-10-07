"""CR-CRU-171 §S1 (issue 1) — "an unfiled run files nothing": a suite verb
driven with no `--agent` must run the suite, POST nothing to the board at
all (no `/runs/start`, no ingest on `/api/v2/runs`, `/runs/parsed` or
`/runs/compile`, no abort), and exit with the runner's own code — exactly as
`bun test` already does. Measured at gap analysis: bun's `cmd_regression`
(shared by the bare `regression` verb, `pre-merge-gate`'s whole-suite step,
and every DECLARED-tier cell — `unit`/`module`/`integration`/`e2e`/`bdd`) has
no such guard at all: it ingests regardless of whether `--agent` was given.
The incident this reproduces (CR-CRU-170 C3 GREEN, cycle 597): `bun-crucible.py
e2e -- --grep "burndown"`, no `--agent`, ran 7/7 green and still POSTed the
board-decoded report; the board's 409 ("a registered caller is required")
turned a clean pass into `ok:false` exit 1.

Driven per client, against a real `RecordingBoard` HTTP stand-in
(`tests/client/live_run_harness.py`) and a fake runner that actually writes a
report, as a genuine OS subprocess — never the live :3849/:3850 server.

WHAT IS RED HERE, and why, read from the clients at HEAD of this branch:

  * bun's two DECLARED-tier rows (`unit`, flag mechanism; `e2e`, the RAW-report
    mechanism the real incident used) — `cmd_regression`'s `_ingest_parsed`/
    `_ingest_raw` calls carry no `if not args.agent` guard at all, so a passing,
    unfiled run still POSTs. RED on the "posts nothing" assertion.

THE EVIDENCE VERBS (user ruling 2026-10-08, §S1 amended 8df5ade): bun/python/
mvn's bare `regression` and `pre-merge-gate`, and rust's `regression` (tier
cell), `workspace-regression`, `smoke-test`, `regression-ingest` and
`pre-merge-gate` exist to file evidence, so they KEEP `--agent required=True`:
without it each is refused before the runner starts (the fake runner is never
invoked — its marker file stays absent), posts nothing, and exits non-zero
with a message naming `--agent`. Those classes pin that refusal.

PINS (pass today, read the same way): bun `test` already returns
`result.returncode` with no POST when `--agent` is absent (explicit per the
dispatch), and one already-correct verb per OTHER client — python `test`,
mvn `test`, rust `unit`, arduino `test` — all share a body that returns
before any ingest when unfiled (python/mvn/rust: `if not args.agent: return
result.returncode` verbatim in `cmd_test`/`_run_surefire_tier`/
`_run_failsafe_tier`; arduino's shared `_run_native_tests_body` has carried
this since CR-CRU-044 §S5 and applies it to EVERY verb that shares the body,
`regression` and `pre-merge-gate` included — arduino has no offender at all).

Both proofs, per test: today's failure names the defect (an extra POST —
never an import/fixture error), and a GREEN that adds the missing `if not
agent` guard to `cmd_regression`'s shared body (bun) satisfies every
assertion here, with no `required=True` relaxed anywhere.

Invocation:
    python3 -m unittest tests.client.test_a_run_without_agent_files_nothing -v
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    new_scratch,
    scrubbed_env,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)

TIMEOUT = 60

# The AC's own enumeration of "posts nothing": no /api/v2/runs/start, no
# ingest on /api/v2/runs, /runs/parsed or /runs/compile, no abort. A harmless
# idempotent /api/v2/projects upsert (arduino's own `_ensure_project`, fired
# on every verb regardless of --agent) is not a RUN post and is deliberately
# excluded, so these assertions track exactly what the AC names.
_RUN_FILING_PATHS = ("/api/v2/runs/start", "/api/v2/runs",
                     "/api/v2/runs/parsed", "/api/v2/runs/compile")


def _run_filing_posts(posts):
    return [(path, body) for path, body in posts
           if path in _RUN_FILING_PATHS
           or (path.startswith("/api/v2/runs/") and path.endswith("/abort"))]



def _write_executable(path, text):
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IRUSR)
    return path


# A fake `bun` FAITHFUL enough to carry both declared-tier mechanisms this
# file drives: `bun run <script>` dispatches to the script's own declared
# body (resolving a leading `bun` back to this same fake, so a flag-mechanism
# target's `"bun test"` body recurses correctly), and a plain `bun test
# [...] [--reporter-outfile=PATH]` writes a JUnit report of FAKE_TOTAL
# passing cases and exits FAKE_EXIT_CODE (default 0) — the GUARD's own two
# drives (pass, and a specific nonzero code) need nothing else.
_FAKE_BUN_BODY = """
import json
import os
import shlex
import subprocess
import sys

argv = sys.argv[1:]


def _write_junit(outfile, total):
    if not outfile:
        return
    cases = "".join(
        '<testcase name="case_%d" file="fixture.test.ts" time="0.001">'
        '</testcase>' % i for i in range(1, total + 1))
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
            '<testsuite name="fixture.test.ts" tests="%d" failures="0">%s'
            '</testsuite></testsuites>' % (total, cases))


if argv[:1] == ["run"] and len(argv) > 1:
    script = argv[1]
    try:
        with open(os.path.join(os.getcwd(), "package.json")) as handle:
            scripts = (json.load(handle) or {}).get("scripts") or {}
    except OSError:
        scripts = {}
    body = scripts.get(script)
    if body is None:
        sys.stderr.write('error: Script not found "%s"\\n' % script)
        sys.exit(1)
    extra = argv[2:]
    if extra[:1] == ["--"]:
        extra = extra[1:]
    command = " ".join([body] + [shlex.quote(a) for a in extra])
    if command.startswith("bun "):
        command = shlex.quote(sys.argv[0]) + command[3:]
    sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)

outfile = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
total = int(os.environ.get("FAKE_TOTAL", "1"))
_write_junit(outfile, total)
sys.exit(int(os.environ.get("FAKE_EXIT_CODE", "0")))
"""

# The leaf behind a RAW-report declared target (this repo's own `test:e2e`
# shape: `crucible.reportPath` names an env var for the client's own JUnit
# read, `crucible.rawReport` names a SECOND env var for the file the board
# decodes). Writes both and exits FAKE_EXIT_CODE.
_FAKE_RAW_LEAF_BODY = """
import os
import sys

total = int(os.environ.get("FAKE_TOTAL", "1"))
junit = os.environ.get("FAKE_JUNIT_PATH")
if junit:
    directory = os.path.dirname(junit)
    if directory:
        os.makedirs(directory, exist_ok=True)
    cases = "".join(
        '<testcase name="scenario_%d" time="0.001"></testcase>' % i
        for i in range(1, total + 1))
    with open(junit, "w") as handle:
        handle.write(
            '<?xml version="1.0"?><testsuites><testsuite name="e2e.feature" '
            'tests="%d" failures="0">%s</testsuite></testsuites>'
            % (total, cases))
raw = os.environ.get("FAKE_RAW_PATH")
if raw:
    directory = os.path.dirname(raw)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(raw, "w") as handle:
        handle.write('{"scenarios": %d}' % total)
sys.exit(int(os.environ.get("FAKE_EXIT_CODE", "0")))
"""


def _write_fake_bun(project_dir):
    return _write_executable(os.path.join(project_dir, "fake_bun.py"),
                             "#!" + sys.executable + "\n" + _FAKE_BUN_BODY)


def _write_fake_raw_leaf(project_dir):
    return _write_executable(os.path.join(project_dir, "fake_leaf.py"),
                             "#!" + sys.executable + "\n" + _FAKE_RAW_LEAF_BODY)


# The evidence verbs' refusal must happen BEFORE the runner starts. A fake
# runner proves it was never invoked by wrapping it: the wrapper writes a
# marker file and then execs the real fake, so an absent marker means the
# client never spawned the runner at all.
_MARKER_WRAPPER_BODY = """
import os
import sys

with open(%r, "w") as handle:
    handle.write(" ".join(sys.argv))
os.execv(%r, [%r] + sys.argv[1:])
"""

def _mark_runner(runner, marker):
    real = runner + ".real"
    os.rename(runner, real)
    _write_executable(runner, "#!" + sys.executable + "\n"
                      + _MARKER_WRAPPER_BODY % (marker, real, real))
    return runner

def _assert_refused_before_the_runner_starts(case, label, result, marker, posts):
    case.assertEqual(posts, [], f"{label}: got {posts!r}")
    case.assertFalse(
        os.path.exists(marker),
        f"{label}: an evidence verb run without --agent must be refused "
        f"BEFORE the runner starts \u2014 the fake runner was invoked; "
        f"stderr={result.stderr[-800:]!r}")
    case.assertNotEqual(
        result.returncode, 0,
        f"{label}: an unfiled evidence verb must exit non-zero; "
        f"stdout={result.stdout!r} stderr={result.stderr[-800:]!r}")
    case.assertIn(
        "--agent", result.stdout + result.stderr,
        f"{label}: the refusal must name --agent; stdout={result.stdout!r} "
        f"stderr={result.stderr[-800:]!r}")


class BunDeclaredTierVerbPostsNothingWhenUnfiledTest(unittest.TestCase):
    """RED — bun's declared-tier cells (`unit`/`module`/`integration`/`e2e`/
    `bdd`) all dispatch into `cmd_regression`'s `script=` branch, which carries
    NO `if not args.agent` guard: `_ingest_parsed`/`_ingest_raw` are called
    unconditionally. Two rows: the flag-mechanism default (`unit`, the
    ordinary case), and the RAW-report mechanism the real incident used
    (`e2e`, modelled byte-for-byte on this repo's own `package.json`
    `crucible.reportPath`/`crucible.rawReport` declarations for `test:e2e`)."""

    def setUp(self):
        self.project = new_scratch("cr171-declared-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, "cr171-declared-key")
        self.fake_bun = _write_fake_bun(self.project)
        self.fake_leaf = _write_fake_raw_leaf(self.project)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def _drive(self, verb):
        env = scrubbed_env(None, FAKE_TOTAL="4")
        cmd = [sys.executable, str(CLIENTS / "bun-crucible.py"), verb,
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_flag_mechanism_declared_unit_target_runs_the_suite_and_posts_nothing_when_unfiled(self):
        Path(self.project, "package.json").write_text(json.dumps(
            {"name": "cr171-fixture", "scripts": {"test:unit": "bun test"}}))
        result = self._drive("unit")
        self.assertEqual(
            result.returncode, 0,
            f"a passing unfiled declared target must exit with the runner's "
            f"own (0) code; stdout={result.stdout!r} "
            f"stderr={result.stderr[-1500:]!r}")
        posts = _run_filing_posts(self.board.posts())
        self.assertEqual(
            posts, [],
            f"an unfiled declared-tier run (flag mechanism) must post "
            f"NOTHING to the board — cmd_regression's `script` branch "
            f"ingests regardless of --agent; got {posts!r}")

    def test_raw_report_declared_e2e_target_runs_the_suite_and_posts_nothing_when_unfiled(self):
        Path(self.project, "package.json").write_text(json.dumps({
            "name": "cr171-fixture",
            "scripts": {"test:e2e": self.fake_leaf},
            "crucible": {
                "reportPath": {"test:e2e": "env:FAKE_JUNIT_PATH"},
                "rawReport": {"test:e2e": {"codec": "stub", "file": "stub.json",
                                           "path": "env:FAKE_RAW_PATH"}},
            },
        }))
        result = self._drive("e2e")
        self.assertEqual(
            result.returncode, 0,
            f"a passing unfiled declared target must exit with the runner's "
            f"own (0) code; stdout={result.stdout!r} "
            f"stderr={result.stderr[-1500:]!r}")
        posts = _run_filing_posts(self.board.posts())
        self.assertEqual(
            posts, [],
            f"THE INCIDENT (C3 GREEN, cycle 597): a declared "
            f"target with a RAW-report mechanism (bun's own test:e2e "
            f"shape) run unfiled still POSTs the decoded report, and the "
            f"real board's 409 turned a 4/4 pass into ok:false exit 1; "
            f"got {posts!r}")


class BunRegressionAndPreMergeGateRefuseAnUnfiledRunBeforeItStartsTest(unittest.TestCase):
    """PIN (user ruling 2026-10-08) — bun's evidence verbs `regression` and
    `pre-merge-gate` keep `--agent required=True` (`_add_regression_tier_args`
    and the `pre-merge-gate` subparser): run without it, each is refused
    before the runner starts, posts nothing, and exits non-zero naming
    `--agent`."""

    def setUp(self):
        self.project = new_scratch("cr171-bun-reg-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, "cr171-bun-reg-key")
        self.marker = os.path.join(self.project, "runner-was-invoked")
        self.fake_bun = _mark_runner(_write_fake_bun(self.project), self.marker)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def _drive(self, argv_tail):
        env = scrubbed_env(None, FAKE_TOTAL="3")
        cmd = [sys.executable, str(CLIENTS / "bun-crucible.py"), *argv_tail,
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_regression_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["regression"])
        _assert_refused_before_the_runner_starts(
            self, "regression", result, self.marker,
            _run_filing_posts(self.board.posts()))

    def test_pre_merge_gate_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["pre-merge-gate", "--skip-check"])
        _assert_refused_before_the_runner_starts(
            self, "pre-merge-gate", result, self.marker,
            _run_filing_posts(self.board.posts()))


class PythonRegressionAndPreMergeGateRefuseAnUnfiledRunBeforeItStartsTest(unittest.TestCase):
    """PIN (user ruling 2026-10-08) — python's evidence verbs `regression`
    and `pre-merge-gate` keep `--agent required=True`: run without it, each
    is refused before the runner starts, posts nothing, and exits non-zero
    naming `--agent`."""

    def setUp(self):
        self.project = new_scratch("cr171-py-reg-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, "cr171-py-reg-key")
        self.marker = os.path.join(self.project, "runner-was-invoked")
        self.fake_python = _mark_runner(write_fake_python(self.project),
                                        self.marker)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def _drive(self, argv_tail):
        env = scrubbed_env(None, FAKE_TOTAL="3")
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), *argv_tail,
               "--python", self.fake_python, "--project-dir", self.project,
               "--reports", "reports"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_regression_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["regression"])
        _assert_refused_before_the_runner_starts(
            self, "regression", result, self.marker,
            _run_filing_posts(self.board.posts()))

    def test_pre_merge_gate_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["pre-merge-gate", "--skip-check"])
        _assert_refused_before_the_runner_starts(
            self, "pre-merge-gate", result, self.marker,
            _run_filing_posts(self.board.posts()))


class MvnRegressionAndPreMergeGateRefuseAnUnfiledRunBeforeItStartsTest(unittest.TestCase):
    """PIN (user ruling 2026-10-08) — mvn's evidence verbs `regression` and
    `pre-merge-gate` keep `--agent required=True`: run without it, each is
    refused before the runner starts, posts nothing, and exits non-zero
    naming `--agent`."""

    def setUp(self):
        self.project = new_scratch("cr171-mvn-reg-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, "cr171-mvn-reg-key")
        self.marker = os.path.join(self.project, "runner-was-invoked")
        _mark_runner(write_fake_mvnw(self.project), self.marker)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def _drive(self, argv_tail):
        env = scrubbed_env(None, FAKE_TOTAL="3")
        cmd = [sys.executable, str(CLIENTS / "mvn-crucible.py"), *argv_tail,
               "--project-dir", self.project, "--reports", "reports"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_regression_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["regression"])
        _assert_refused_before_the_runner_starts(
            self, "regression", result, self.marker,
            _run_filing_posts(self.board.posts()))

    def test_pre_merge_gate_unfiled_is_refused_before_the_runner_starts(self):
        result = self._drive(["pre-merge-gate"])
        _assert_refused_before_the_runner_starts(
            self, "pre-merge-gate", result, self.marker,
            _run_filing_posts(self.board.posts()))


class RustRegressionFamilyRefusesAnUnfiledRunBeforeItStartsTest(unittest.TestCase):
    """PIN (user ruling 2026-10-08), table-driven — every rust evidence verb
    (`regression` the tier cell == `cmd_workspace_regression`,
    `workspace-regression`, `smoke-test`, `regression-ingest`, and
    `pre-merge-gate`) keeps `--agent required=True`: run without it, each is
    refused before the runner starts, posts nothing, and exits non-zero
    naming `--agent`."""

    VERBS = (
        ("regression", ("--min-free-g", "0", "--keep-target")),
        ("workspace-regression", ("--min-free-g", "0", "--keep-target")),
        ("smoke-test", ()),
        ("regression-ingest", ("--crates", "fake-crate")),
        ("pre-merge-gate", ()),
    )

    def setUp(self):
        self.project = new_scratch("cr171-rust-reg-")
        self.bin_dir = new_scratch("cr171-rust-reg-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, "cr171-rust-reg-key")
        self.marker = os.path.join(self.bin_dir, "runner-was-invoked")
        _mark_runner(write_fake_cargo(self.bin_dir), self.marker)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)

    def test_every_evidence_verb_is_refused_unfiled_before_the_runner_starts(self):
        for verb, extra in self.VERBS:
            with self.subTest(verb=verb):
                env = scrubbed_env(self.bin_dir, FAKE_TOTAL="3")
                cmd = [sys.executable, str(CLIENTS / "rust-crucible.py"), verb,
                       *extra, "--project-dir", self.project,
                       "--reports", "reports"]
                result = subprocess.run(cmd, cwd=self.project, env=env,
                                        capture_output=True, text=True,
                                        timeout=TIMEOUT)
                _assert_refused_before_the_runner_starts(
                    self, verb, result, self.marker,
                    _run_filing_posts(self.board.posts()))


class AClientsAlreadyGuardedSuiteVerbRunsUnfiledAndPostsNothingTest(unittest.TestCase):
    """PIN — passes today, no production code touched. bun `test` (explicit
    per the dispatch) plus one already-correct verb per OTHER client, proving
    the §S1 contract the RED tests above require is not new ground anywhere
    in the fleet: bun `test` already forwards the runner's own exit code
    (both a passing AND a specific nonzero one) with no POST when `--agent`
    is omitted, and python/mvn/rust/arduino's own equivalents already do the
    pass-case too."""

    def setUp(self):
        self.board = RecordingBoard()
        self._cleanup = []

    def tearDown(self):
        self.board.close()
        for directory in self._cleanup:
            shutil.rmtree(directory, ignore_errors=True)

    def _scratch(self, prefix):
        directory = new_scratch(prefix)
        self._cleanup.append(directory)
        return directory

    def test_bun_test_unfiled_runs_the_suite_posts_nothing_and_forwards_the_runners_own_exit_code(self):
        project = self._scratch("cr171-guard-bun-")
        install_project(project, self.board.url, "cr171-guard-bun-key")
        fake_bun = _write_fake_bun(project)
        cmd = [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
               "--bun", fake_bun, "--project-dir", project,
               "--package-dir", project, "--reports", "reports"]

        passing = subprocess.run(cmd, cwd=project,
                                 env=scrubbed_env(None, FAKE_TOTAL="3"),
                                 capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(
            passing.returncode, 0,
            f"a passing unfiled `test` must exit 0; "
            f"stderr={passing.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])

        failing = subprocess.run(
            cmd, cwd=project,
            env=scrubbed_env(None, FAKE_TOTAL="3", FAKE_EXIT_CODE="3"),
            capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(
            failing.returncode, 3,
            f"the RUNNER's own exit code must be forwarded verbatim, never "
            f"a fixed 0/1; stderr={failing.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])

    def test_python_test_unfiled_runs_the_suite_and_posts_nothing(self):
        project = self._scratch("cr171-guard-py-")
        install_project(project, self.board.url, "cr171-guard-py-key")
        fake_python = write_fake_python(project)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
               "--python", fake_python, "--project-dir", project,
               "--reports", "reports"]
        result = subprocess.run(cmd, cwd=project,
                                env=scrubbed_env(None, FAKE_TOTAL="3"),
                                capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])

    def test_mvn_test_unfiled_runs_the_suite_and_posts_nothing(self):
        project = self._scratch("cr171-guard-mvn-")
        install_project(project, self.board.url, "cr171-guard-mvn-key")
        write_fake_mvnw(project)
        cmd = [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
               "--project-dir", project, "--reports", "reports"]
        result = subprocess.run(cmd, cwd=project,
                                env=scrubbed_env(None, FAKE_TOTAL="3"),
                                capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])

    def test_rust_unit_unfiled_runs_the_suite_and_posts_nothing(self):
        project = self._scratch("cr171-guard-rust-")
        bin_dir = self._scratch("cr171-guard-rust-bin-")
        install_project(project, self.board.url, "cr171-guard-rust-key")
        write_fake_cargo(bin_dir)
        cmd = [sys.executable, str(CLIENTS / "rust-crucible.py"), "unit",
               "--project-dir", project, "--reports", "reports"]
        result = subprocess.run(cmd, cwd=project,
                                env=scrubbed_env(bin_dir, FAKE_TOTAL="3"),
                                capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])

    def test_arduino_test_unfiled_runs_the_suite_and_posts_nothing(self):
        project = self._scratch("cr171-guard-arduino-")
        install_project(project, self.board.url, "cr171-guard-arduino-key",
                        "cr171-guard-arduino-firmware")
        write_fake_native(project)
        cmd = [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
               "--dir", "tests/native", "--project-dir", project,
               "--reports", "reports"]
        result = subprocess.run(cmd, cwd=project,
                                env=scrubbed_env(None, FAKE_TOTAL="3"),
                                capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(
            result.returncode, 0,
            f"arduino derives 0/1 from the JUnit summary even when "
            f"unfiled; a run with no failures must exit 0; "
            f"stderr={result.stderr[-800:]!r}")
        self.assertEqual(_run_filing_posts(self.board.posts()), [])


if __name__ == "__main__":
    unittest.main()
