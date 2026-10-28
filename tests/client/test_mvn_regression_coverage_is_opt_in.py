"""maven's `regression` measures coverage only when `--coverage` is given.

  * Coverage-free by default — `regression` without `--coverage`, over an
    all-green build whose project `.env` names a coverage profile
    (`CRUCIBLE_COVERAGE_PROFILE`) and whose build writes
    `target/jacoco-report/jacoco.csv`, runs maven with no `-P` profile at
    all, collects no JaCoCo, prints no "no jacoco.csv found" warning, and
    files a `regression` run whose `/api/v2/runs/parsed` body carries no
    `coverage` key. The fixture is green on purpose: a run with a failure
    already withholds JaCoCo, so a red fixture would prove nothing.

  * Coverage when asked — `regression --coverage` keeps the coverage run:
    the profile from `--coverage-profile`, else the `.env`'s
    `CRUCIBLE_COVERAGE_PROFILE`, else no `-P` with the build's own
    `jacoco.csv` collected; either way the run's JaCoCo totals ride the
    ingest.

  * The gate still measures coverage — `pre-merge-gate` on a green build
    files the run's JaCoCo coverage under the `.env` profile, because its
    regression asks for coverage explicitly.

  * The refusal — `regression --coverage-profile X` without `--coverage` is
    the typed `coverage-flag-refused` hard stop, the verb's first act: one
    `ok:false` envelope naming `--coverage-profile` and that it applies only
    with `--coverage`, `help[]` saying to add `--coverage` or drop the flag,
    a non-zero exit, no request of any kind to the board, nothing written
    into the project, and neither maven nor docker launched. It runs with
    `--agent` and no `--cycle` against a board reporting an active cycle,
    the same board state the shared refusal's own suite uses, so a check
    placed after the board is consulted surfaces as a request.

Every case drives the real `clients/mvn-crucible.py` as a subprocess over a
scratch project in the temp directory, steered only by that project's own
`crucible.toml` `[client] url` and `--project-dir`. maven and docker are
recording stand-ins on PATH (the project has no `mvnw`): every launch appends
its tool name and argv to a record file beside them, outside the project.
The fake `mvn` writes one passing JUnit case into each reports directory the
client named and, like a build running the quarkus-jacoco extension, writes
`target/jacoco-report/jacoco.csv` with known totals.

Invocation:
    python3 -m unittest tests.client.test_mvn_regression_coverage_is_opt_in -v
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.test_regression_coverage_is_one_shared_opt_in_switch import (
    ActiveCycleBoard,
)

TOON = load_toon()
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
TIMEOUT = 120

PARSED_INGEST = "/api/v2/runs/parsed"
REFUSED_CODE = "coverage-flag-refused"
UNATTRIBUTED_CODE = "unattributed-run-refused"
MISSING_JACOCO_WARNING = "no jacoco.csv found"
# What the client prints to stderr each time it collects a JaCoCo csv.
JACOCO_COLLECTED = "[crucible] jacoco:"

# Test data: the coverage profile a fixture's `.env` names, and the one a
# test hands to `--coverage-profile`.
ENV_PROFILE = "jacoco-from-dotenv"
FLAG_PROFILE = "jacoco-from-flag"

# The JaCoCo totals the fake build writes (one csv row): lines 8/10,
# methods 4/5, branches 6/10.
EXPECTED_COVERAGE = {"lines": (10, 8), "functions": (5, 4), "branches": (10, 6)}

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "CRUCIBLE_COVERAGE_PROFILE", "MVN_CRUCIBLE_PROJECT_DIR",
             "MVN_CRUCIBLE_MAVEN_DIR", "MVN_CRUCIBLE_COMPOSE_FILE")

# The recording `mvn`. Every launch appends {"tool", "argv"} to
# `runner_launches.jsonl` beside it. `test-compile` (the client's compile
# fallback) is a clean build. Any other invocation is a green test run: one
# passing case into each reports directory the client named
# (`-D<plugin>.reportsDirectory=<dir>`), and the quarkus-jacoco extension's
# `target/jacoco-report/jacoco.csv` under the working directory.
_RECORDING_MVN = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "runner_launches.jsonl"), "a") as handle:
    handle.write(json.dumps({"tool": "mvn", "argv": args}) + "\n")
if "test-compile" in args:
    sys.stdout.write("[INFO] BUILD SUCCESS\n")
    sys.exit(0)
reports = []
for arg in args:
    for plugin in ("surefire", "failsafe"):
        flag = "-D%s.reportsDirectory=" % plugin
        if arg.startswith(flag):
            reports.append((plugin, arg[len(flag):]))
reports = reports or [("surefire", os.path.join("target", "surefire-reports"))]
for plugin, directory in reports:
    name = "com.acme.Coverage%sTest" % plugin.capitalize()
    sys.stdout.write("[INFO] Running %s\n" % name)
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, "TEST-%s.xml" % name), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<testsuite name="%s" tests="1" failures="0" errors="0" '
                     'skipped="0"><testcase name="adds" classname="%s" '
                     'time="0.001"></testcase></testsuite>\n' % (name, name))
jacoco = os.path.join("target", "jacoco-report")
os.makedirs(jacoco, exist_ok=True)
with open(os.path.join(jacoco, "jacoco.csv"), "w") as handle:
    handle.write("GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,"
                 "BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED,"
                 "COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,"
                 "METHOD_COVERED\n"
                 "acme,com.acme,Adder,3,17,4,6,2,8,1,5,1,4\n")
sys.stdout.write("[INFO] BUILD SUCCESS\n")
sys.exit(0)
'''

# The recording `docker`: appends its launch and exits 0, so a gate's compose
# bring-up and teardown never reach the host's real docker.
_RECORDING_DOCKER = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "runner_launches.jsonl"), "a") as handle:
    handle.write(json.dumps({"tool": "docker", "argv": sys.argv[1:]}) + "\n")
sys.exit(0)
'''


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _envelope_count(stdout):
    return len(re.findall(r"(?m)^axi:", stdout or ""))


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={(result.stdout or '')[:1500]!r} "
            f"stderr={(result.stderr or '')[-2500:]!r}")


def _plain(text):
    """Lower-cased, backticks dropped, whitespace collapsed."""
    return " ".join(str(text).replace("`", "").lower().split())


def _profiles(argv):
    """Every maven profile an argv activates: the value after each `-P`, and
    the glued `-P<name>` form."""
    found = []
    for index, arg in enumerate(argv):
        if arg == "-P":
            found.append(argv[index + 1] if index + 1 < len(argv) else None)
        elif arg.startswith("-P") and len(arg) > 2:
            found.append(arg[2:])
    return found


def _tree(project):
    """Every path under the project, relative to it."""
    return sorted(str(p.relative_to(project)) for p in Path(project).rglob("*"))


class _MavenProject:
    """A scratch maven project whose `mvn` and `docker` are the recording
    stand-ins on PATH, driven through the real client."""

    def make_project(self, board_url, project_key, env_profile=None):
        self.project = new_scratch("mvn-regression-coverage-")
        self.bin_dir = new_scratch("mvn-regression-coverage-bin-")
        self.addCleanup(shutil.rmtree, self.project, True)  # type: ignore[attr-defined]
        self.addCleanup(shutil.rmtree, self.bin_dir, True)  # type: ignore[attr-defined]
        _write_script(os.path.join(self.bin_dir, "mvn"), _RECORDING_MVN)
        _write_script(os.path.join(self.bin_dir, "docker"), _RECORDING_DOCKER)
        install_project(self.project, board_url, project_key)
        if env_profile is not None:
            with open(os.path.join(self.project, ".env"), "a") as handle:
                handle.write(f"CRUCIBLE_COVERAGE_PROFILE={env_profile}\n")

    def drive(self, verb, *extra, agent):
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        cmd = [sys.executable, str(MVN_CLIENT), verb, "--agent", agent,
               "--project-dir", self.project, *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def launches(self, tool=None):
        """Every recorded runner launch, in order — `[(tool, argv), ...]`."""
        path = Path(self.bin_dir, "runner_launches.jsonl")
        if not path.exists():
            return []
        records = [json.loads(line) for line in path.read_text().splitlines()
                   if line.strip()]
        return [(r["tool"], r["argv"]) for r in records
                if tool is None or r["tool"] == tool]

    def the_one_test_build(self, result):
        """The argv of the one maven launch that ran the suite (any launch
        other than the compile fallback's `test-compile`)."""
        builds = [argv for _, argv in self.launches("mvn")
                  if "test-compile" not in argv]
        self.assertEqual(  # type: ignore[attr-defined]
            len(builds), 1,
            f"maven runs the suite exactly once; launches={self.launches()!r} "
            f"{_diagnostics(result)}")
        return builds[0] if builds else []

    def the_one_ingest(self, board, result):
        ingests = [(p, b) for p, b in board.posts() if p in INGEST_PATHS]
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"exactly one ingest; paths={[p for p, _ in board.posts()]!r} "
            f"{_diagnostics(result)}")
        path, body = ingests[0] if ingests else (None, {})
        self.assertEqual(path, PARSED_INGEST,  # type: ignore[attr-defined]
                         f"the regression files through {PARSED_INGEST}; "
                         f"{_diagnostics(result)}")
        return body if isinstance(body, dict) else {}

    def assert_green_run_with_jacoco_written(self, result):
        """The fixture's preconditions held: the run exited 0, its envelope
        counts no failure, and the build wrote the quarkus-jacoco csv."""
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         f"an all-green run exits 0; {_diagnostics(result)}")
        run = (_envelope(result.stdout) or {}).get("run") or {}
        self.assertEqual(  # type: ignore[attr-defined]
            run.get("failed"), 0,
            f"the run is all-green, so a coverage-free result is not the "
            f"failing-run withhold; run={run!r} {_diagnostics(result)}")
        self.assertTrue(  # type: ignore[attr-defined]
            Path(self.project, "target", "jacoco-report", "jacoco.csv").is_file(),
            f"the build wrote target/jacoco-report/jacoco.csv; "
            f"{_diagnostics(result)}")

    def assert_carries_the_builds_coverage(self, body):
        coverage = body.get("coverage")
        self.assertIsInstance(coverage, dict,  # type: ignore[attr-defined]
                              f"the ingest carries the run's JaCoCo coverage; "
                              f"body={body!r}")
        got = {metric: ((coverage or {}).get(metric) or {}).get("total")
               for metric in EXPECTED_COVERAGE}
        got_covered = {metric: ((coverage or {}).get(metric) or {}).get("covered")
                       for metric in EXPECTED_COVERAGE}
        self.assertEqual(  # type: ignore[attr-defined]
            (got, got_covered),
            ({m: t for m, (t, _) in EXPECTED_COVERAGE.items()},
             {m: c for m, (_, c) in EXPECTED_COVERAGE.items()}),
            f"the coverage is the build's own jacoco.csv totals; "
            f"coverage={coverage!r}")


# ── without `--coverage`: no profile, no JaCoCo ─────────────────────────────

class MavenRegressionWithoutCoverageIsCoverageFreeTest(_MavenProject,
                                                       unittest.TestCase):
    """`regression` without `--coverage` over an all-green build whose `.env`
    names a coverage profile and whose build writes jacoco.csv."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "mvn-regression-coverage-free",
                          env_profile=ENV_PROFILE)

    def test_regression_without_coverage_runs_maven_with_no_coverage_profile(self):
        result = self.drive("regression", agent="mvn-regression-no-profile")
        self.assert_green_run_with_jacoco_written(result)
        argv = self.the_one_test_build(result)
        self.assertEqual(
            _profiles(argv), [],
            f"without --coverage no profile is applied — not the .env's "
            f"CRUCIBLE_COVERAGE_PROFILE, nor any other; argv={argv!r}")

    def test_regression_without_coverage_files_a_regression_run_with_no_coverage_key(self):
        result = self.drive("regression", agent="mvn-regression-no-jacoco")
        self.assert_green_run_with_jacoco_written(result)
        body = self.the_one_ingest(self.board, result)
        self.assertEqual(body.get("tier"), "regression",
                         f"a regression run is filed; body={body!r}")
        self.assertNotIn(
            "coverage", body,
            f"without --coverage the build's jacoco.csv is never sent; "
            f"body={body!r}")
        self.assertNotIn(
            JACOCO_COLLECTED, result.stderr or "",
            f"without --coverage no jacoco.csv is collected; "
            f"{_diagnostics(result)}")
        self.assertNotIn(
            MISSING_JACOCO_WARNING, result.stderr or "",
            f"a run that measures no coverage does not warn about a missing "
            f"jacoco.csv; {_diagnostics(result)}")


# ── with `--coverage`: the profile, else the .env's, else none ─────────────

class MavenRegressionWithCoverageTest(_MavenProject, unittest.TestCase):
    """`regression --coverage` applies the coverage profile it resolves and
    files the build's JaCoCo coverage."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

    def assert_coverage_run(self, result, profiles):
        self.assertNotIn(REFUSED_CODE,
                         (result.stdout or "") + (result.stderr or ""),
                         _diagnostics(result))
        self.assert_green_run_with_jacoco_written(result)
        argv = self.the_one_test_build(result)
        self.assertEqual(_profiles(argv), profiles,
                         f"the coverage run activates exactly {profiles!r}; "
                         f"argv={argv!r}")
        body = self.the_one_ingest(self.board, result)
        self.assertEqual(body.get("tier"), "regression",
                         f"a regression run is filed; body={body!r}")
        self.assert_carries_the_builds_coverage(body)

    def test_coverage_with_coverage_profile_runs_that_profile_over_the_dotenv_one(self):
        self.make_project(self.board.url, "mvn-regression-coverage-flag",
                          env_profile=ENV_PROFILE)
        result = self.drive("regression", "--coverage",
                            "--coverage-profile", FLAG_PROFILE,
                            agent="mvn-regression-coverage-flag")
        self.assert_coverage_run(result, [FLAG_PROFILE])

    def test_coverage_without_a_flag_runs_the_dotenv_coverage_profile(self):
        self.make_project(self.board.url, "mvn-regression-coverage-dotenv",
                          env_profile=ENV_PROFILE)
        result = self.drive("regression", "--coverage",
                            agent="mvn-regression-coverage-dotenv")
        self.assert_coverage_run(result, [ENV_PROFILE])

    def test_coverage_with_no_profile_anywhere_runs_without_one_and_sends_the_builds_own_jacoco(self):
        self.make_project(self.board.url, "mvn-regression-coverage-builds-own")
        result = self.drive("regression", "--coverage",
                            agent="mvn-regression-coverage-builds-own")
        # The ingest's coverage is the build's own jacoco.csv totals: it was
        # collected with no profile applied.
        self.assert_coverage_run(result, [])


# ── the gate still measures coverage ───────────────────────────────────────

class MavenPreMergeGateFilesCoverageTest(_MavenProject, unittest.TestCase):
    """`pre-merge-gate` on a green build files the run's JaCoCo coverage: its
    regression asks for coverage explicitly."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "mvn-gate-coverage",
                          env_profile=ENV_PROFILE)

    def test_guard_pre_merge_gate_on_a_green_build_files_jacoco_coverage_under_the_dotenv_profile(self):
        """GUARD — holds today; it fails if the gate's regression stops asking
        for coverage once `regression` is coverage-free by default."""
        result = self.drive("pre-merge-gate", agent="mvn-gate-coverage")
        self.assert_green_run_with_jacoco_written(result)
        argv = self.the_one_test_build(result)
        self.assertEqual(_profiles(argv), [ENV_PROFILE],
                         f"the gate's coverage run applies the .env profile; "
                         f"argv={argv!r}")
        body = self.the_one_ingest(self.board, result)
        self.assertEqual(body.get("tier"), "regression",
                         f"the gate files a regression run; body={body!r}")
        self.assert_carries_the_builds_coverage(body)


# ── `--coverage-profile` without `--coverage` is refused ───────────────────

class MavenCoverageProfileWithoutCoverageIsRefusedTest(_MavenProject,
                                                       unittest.TestCase):
    """`regression --coverage-profile X` without `--coverage` is the typed
    `coverage-flag-refused` hard stop, decided before anything else."""

    def setUp(self):
        self.board = ActiveCycleBoard()
        self.addCleanup(self.board.close)
        # The project key must not spell the refusal's code: the envelope's
        # context carries it, and the code is looked for in both streams.
        self.make_project(self.board.url, "mvn-coverage-profile-alone",
                          env_profile=ENV_PROFILE)

    def test_coverage_profile_without_coverage_is_refused_before_anything_runs(self):
        before = _tree(self.project)
        result = self.drive("regression", "--coverage-profile", FLAG_PROFILE,
                            agent="mvn-coverage-profile-refused")
        streams = (result.stdout or "") + (result.stderr or "")
        self.assertIn(
            REFUSED_CODE, streams,
            f"--coverage-profile without --coverage is the typed "
            f"{REFUSED_CODE} hard stop; {_diagnostics(result)}")
        self.assertNotIn(
            UNATTRIBUTED_CODE, streams,
            f"the coverage-flag refusal is the verb's first act; "
            f"{_diagnostics(result)}")
        self.assertEqual(_envelope_count(result.stdout), 1,
                         f"exactly one envelope; {_diagnostics(result)}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(
            (envelope.get("verb"), envelope.get("ok")), ("regression", False),
            f"an ok:false regression envelope; envelope={envelope!r}")
        error = _plain(envelope.get("error") or "")
        self.assertIn("--coverage-profile", error,
                      f"error names the refused flag; envelope={envelope!r}")
        self.assertIn("only with --coverage", error,
                      f"error says the flag applies only with --coverage; "
                      f"envelope={envelope!r}")
        help_steps = envelope.get("help")
        self.assertIsInstance(help_steps, list,
                              f"the refusal states help[]; envelope={envelope!r}")
        help_text = _plain(" ".join(str(h) for h in (help_steps or [])))
        self.assertIn("add --coverage", help_text,
                      f"help[] says to add --coverage; help={help_steps!r}")
        self.assertIn("drop", help_text,
                      f"help[] says to drop the flag; help={help_steps!r}")
        self.assertNotEqual(result.returncode, 0,
                            f"a refusal exits non-zero; {_diagnostics(result)}")
        self.assertEqual(
            self.board.seen(), [],
            f"refused before anything reaches the board — no GET, no "
            f"heartbeat, no run start, no ingest; {_diagnostics(result)}")
        self.assertEqual(
            self.launches(), [],
            f"neither maven nor docker is launched; {_diagnostics(result)}")
        self.assertEqual(
            _tree(self.project), before,
            f"nothing is written into the project — no reports, no target; "
            f"{_diagnostics(result)}")

    def test_guard_a_plain_regression_on_this_board_is_the_unattributed_refusal(self):
        """GUARD — the stand-in's active cycle is what makes the refusal
        ordering observable: a `regression` with no `--cycle` against it
        consults the board (so this board does see a client that asks it) and
        is the unattributed-run refusal, and maven never runs."""
        result = self.drive("regression", agent="mvn-coverage-profile-guard")
        self.assertIn(UNATTRIBUTED_CODE, result.stderr or "",
                      f"an unbound run with no --cycle while cycle "
                      f"{ActiveCycleBoard.ACTIVE_CYCLE_ID} is active is "
                      f"refused; {_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0, _diagnostics(result))
        self.assertNotEqual(self.board.seen(), [],
                            f"the stand-in board records the client's "
                            f"requests; {_diagnostics(result)}")
        self.assertEqual(self.launches(), [],
                         f"maven never runs; {_diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
