"""rust's `regression` measures coverage only when `--coverage` is given.

  * Coverage-free by default — `regression` without `--coverage` lists the
    whole workspace's tests and runs them under plain nextest, exactly
    `cargo nextest run --workspace [--all-features | --features X]
    -P <profile> --no-fail-fast` with nextest's stream on
    (`--message-format libtest-json-plus --message-format-version 0.1`): no
    `cargo llvm-cov`, no `cargo clean` (neither before the run nor as a
    post-run reclaim). It closes the run from that stream through
    `/api/v2/runs` as a `regression` run whose envelope states the board's
    `files` and whose close carries no `coverage` key, and it does so under
    `--cycle` and under `--release` alike.

  * Leftover reports — a junit an earlier or another run left under
    `target/nextest/<profile>/` is never filed as this run's: a run whose
    stream holds no line files nothing.

  * The disk guard — an `--all-features` run is still guarded by
    `--min-free-g`: free space below the floor refuses the run before cargo
    builds anything, and a floor below the free space lets it proceed.

  * Coverage when asked — `regression --coverage`: `cargo clean`, then the
    list and the streamed run under `cargo llvm-cov show-env`'s environment,
    then `cargo llvm-cov report --failure-mode all --lcov` writing the lcov,
    its text sent as the close's `coverage: {codec: "lcov", data}`, and the
    post-run reclaim; `--lcov-output` and `--keep-target` take effect with
    it.

  * The refusals — `--lcov-output X` and `--keep-target`, each without
    `--coverage`, are the typed `coverage-flag-refused` hard stop, the verb's
    first act: one `ok:false` envelope naming the flag and that it applies
    only with `--coverage`, `help[]` saying to add `--coverage` or drop the
    flag, a non-zero exit, no request of any kind to the board, no cargo
    launched (`cargo clean` included), and the gate lock never reached. The
    retired `--ignore-run-fail` is refused as early, its envelope naming the
    flag and the lcov now always written. Each runs with `--agent` and
    no `--cycle` against a board reporting an active cycle, and over a
    project whose gate lock is held by a live cargo-like process — so a check
    placed after the board is consulted surfaces as a request (or the
    unattributed-run refusal), and one placed after the lock surfaces as the
    gate-locked refusal.

Every case drives the real `clients/rust-crucible.py` as a subprocess over a
scratch project in the temp directory, steered only by that project's own
`crucible.toml` `[client] url` and `--project-dir`. `cargo` and `df` are
stand-ins on PATH. The recording `cargo` answers `nextest --version` (which
builds and runs nothing, so it is not recorded), then appends every other
launch's argv to a record file beside it, outside the project; a streamed
run's calls are answered by `tests/client/fake_nextest.py`: the list and the
stream of three passing cases over two test binaries, `llvm-cov show-env`,
and `llvm-cov report` writing EXPECTED_LCOV_TEXT. With FAKE_NO_REPORT=1 the
run writes no stream line. Its `clean` is a recorded no-op. The `df`
stand-in reports a fixed free figure for `/home`.

Invocation:
    python3 -m unittest tests.client.integration.test_rust_regression_coverage_is_opt_in -v
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import unittest
from pathlib import Path

from tests.client.fake_nextest import held_results
from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    RecordingBoard,
    board_health,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.integration.test_regression_coverage_is_one_shared_opt_in_switch import (
    ActiveCycleBoard,
)

TOON = load_toon()
RUST_CLIENT = CLIENTS / "rust-crucible.py"
TIMEOUT = 120

RUNS_INGEST = "/api/v2/runs"
PARSED_INGEST = "/api/v2/runs/parsed"
REFUSED_CODE = "coverage-flag-refused"
UNATTRIBUTED_CODE = "unattributed-run-refused"
GATE_LOCK_FILE = "nai-gate.lock"

# Test data: the release a release run is filed under, the cycle a bound run
# names, and the feature set a `--features` run selects.
RELEASE = "0.4.0"
CYCLE = 7
FEATURES = "alpha,beta"

# What the recording cargo's suite run reports: three passing cases over two
# test binaries (two distinct `classname`s), so `files` is 2. The board the
# drives file to answers the ingest with that run (`_answering_board`): the
# envelope's figures are the board's.
EXPECTED_TOTAL = 3
EXPECTED_FILES = 2
# The lcov the recording cargo writes when llvm-cov names `--output-path`,
# byte for byte: the coverage report the ingest sends.
EXPECTED_LCOV_TEXT = "SF:src/lib.rs\nFNF:2\nFNH:1\nLF:10\nLH:8\nend_of_record\n"

# The free figure the `df` stand-in reports for `/home` by default — far
# above the client's default floor, so no run here is refused for disk unless
# a test lowers it.
PLENTY_FREE_G = 5000

# A test case only a STALE report holds: its name on the wire means a report
# from an earlier run was read as this one's.
STALE_CASE = "left_from_an_earlier_run"
# A test case only a report ANOTHER run wrote moments ago holds: its name on
# the wire means that run's report was filed as this one's.
ANOTHER_RUNS_CASE = "written_by_another_run"
# The warning code of a run that wrote no report of its own.
NO_REPORT_CODE = "no-test-reports"

# Keys that would let the shell running this suite decide where the client
# looks or how it files: scrubbed from every drive.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "RUST_CRUCIBLE_PROJECT_DIR", "CARGO_TARGET_DIR",
             "FAKE_NO_REPORT")

# The recording `cargo`. Every launch appends its argv to `cargo_launches.jsonl`
# beside it. `clean` and `cache` are recorded no-ops. Any run naming `nextest`
# (plain `nextest run`, or `llvm-cov … nextest`) prints nextest's own lines
# and, unless FAKE_NO_REPORT=1, writes the profile's junit under the working
# directory and the lcov at `--output-path` when one is named.
_RECORDING_CARGO = r'''
import json
import os
import sys

sys.path.insert(0, ''' + repr(str(Path(__file__).resolve().parents[1])) + r''')
import fake_nextest

args = sys.argv[1:]
if args[:2] in (["nextest", "--version"], ["nextest", "-V"]):
    sys.exit(fake_nextest.preliminary(args, []))
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "cargo_launches.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
os.environ["FAKE_LCOV"] = ''' + repr(EXPECTED_LCOV_TEXT) + r'''
if os.environ.get("FAKE_NO_REPORT") == "1":
    os.environ["FAKE_STREAM_SILENT"] = "1"
cases = [fake_nextest.case(name, crate="probe-crate", binary=binary, kind="test")
         for binary, name in (("alpha", "adds"), ("alpha", "subtracts"),
                              ("beta", "multiplies"))]
code = fake_nextest.preliminary(args, cases)
if code is None:
    code = fake_nextest.streamed_run(args, cases)
sys.exit(0 if code is None else code)
'''


def _answering_board():
    """A RecordingBoard that answers the ingest with the recording cargo's
    suite run: three passing cases over two test binaries."""
    board = RecordingBoard()
    board.script_run(passed=EXPECTED_TOTAL, total=EXPECTED_TOTAL,
                     files=EXPECTED_FILES)
    return board


def _write_script(path, body, interpreter=None):
    Path(path).write_text("#!" + (interpreter or sys.executable) + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _write_df(bin_dir, free_g):
    """The `df` stand-in: `/home` has exactly `free_g` GB free."""
    _write_script(os.path.join(bin_dir, "df"),
                  'echo "Filesystem 1G-blocks Used Available Use% Mounted on"\n'
                  f'echo "/dev/fake 9999G 1G {free_g}G 1% /home"\n',
                  interpreter="/bin/sh")


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


def _tree(project):
    """Every path under the project (its `.git` aside), relative to it."""
    return sorted(str(p.relative_to(project)) for p in Path(project).rglob("*")
                  if ".git" not in p.relative_to(project).parts)


def _plain_nextest(*selection, profile="ci"):
    """The coverage-free run's argv after `cargo`, its stream flags aside."""
    return ["nextest", "run", "--workspace", *selection,
            "-P", profile, "--no-fail-fast"]


# The flag pairs that turn nextest's stream on, wherever the run places them.
_STREAM_PAIRS = (("--message-format", "libtest-json-plus"),
                 ("--message-format-version", "0.1"))


def _without_pairs(argv, pairs):
    """`(argv with each of `pairs` removed, the pairs that were found)`."""
    rest, found, i = [], [], 0
    while i < len(argv):
        pair = tuple(argv[i:i + 2])
        if pair in pairs:
            found.append(pair)
            i += 2
            continue
        rest.append(argv[i])
        i += 1
    return rest, found


def _plain_streamed(argv):
    """A streamed run's argv with its stream flags aside, or None when it
    does not carry both of them."""
    rest, found = _without_pairs(argv, _STREAM_PAIRS)
    return rest if sorted(found) == sorted(_STREAM_PAIRS) else None


def _listed_selection(argv):
    """A `nextest list` launch's selection, its json format aside, sorted;
    None when it is not a json list."""
    if argv[:2] != ["nextest", "list"]:
        return None
    rest, found = _without_pairs(argv[2:], (("--message-format", "json"),))
    return sorted(rest) if found else None


class _RustProject:
    """A scratch cargo project whose `cargo` and `df` are stand-ins on PATH,
    driven through the real client."""

    def make_project(self, board_url, project_key, free_g=PLENTY_FREE_G):
        self.project = new_scratch("rust-regression-coverage-")
        self.bin_dir = new_scratch("rust-regression-coverage-bin-")
        self.addCleanup(shutil.rmtree, self.project, True)  # type: ignore[attr-defined]
        self.addCleanup(shutil.rmtree, self.bin_dir, True)  # type: ignore[attr-defined]
        _write_script(os.path.join(self.bin_dir, "cargo"), _RECORDING_CARGO)
        _write_df(self.bin_dir, free_g)
        install_project(self.project, board_url, project_key)

    def drive(self, *extra, agent, **env_extra):
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update({k: str(v) for k, v in env_extra.items()})
        cmd = [sys.executable, str(RUST_CLIENT), "regression", "--agent", agent,
               "--project-dir", self.project, *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def launches(self):
        """Every recorded cargo launch's argv (after `cargo`), in order: every
        launch but the version read, which builds and runs nothing."""
        path = Path(self.bin_dir, "cargo_launches.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()
                if line.strip()]

    def assert_lists_then_runs_plain_nextest(self, result, *selection, profile="ci"):
        """The run's cargo launches are exactly two: the json list of the
        run's own selection, then plain nextest over the workspace with its
        stream on — no llvm-cov, no cargo clean before or after."""
        launches = self.launches()
        where = f"launches={launches!r} {_diagnostics(result)}"
        self.assertEqual(len(launches), 2, where)  # type: ignore[attr-defined]
        listed, ran = (launches + [[], []])[:2]
        self.assertEqual(  # type: ignore[attr-defined]
            _listed_selection(listed),
            sorted(["--workspace", *selection, "-P", profile]),
            f"first the json list of the run's own selection; {where}")
        self.assertEqual(  # type: ignore[attr-defined]
            _plain_streamed(ran), _plain_nextest(*selection, profile=profile),
            f"then plain nextest over the workspace, its stream on; {where}")

    def plant_stale_junit(self, profile, age_s=3600, case=STALE_CASE):
        """A junit another run left for `profile`, `age_s` seconds old (an
        hour by default), holding `case` — a case no run of this suite
        writes."""
        directory = Path(self.project, "target", "nextest", profile)
        directory.mkdir(parents=True, exist_ok=True)
        junit = directory / "junit.xml"
        junit.write_text(
            '<?xml version="1.0"?><testsuites><testsuite name="stale" '
            f'tests="1" failures="0"><testcase name="{case}" '
            'classname="stale-crate::old" time="0.001"></testcase>'
            '</testsuite></testsuites>')
        then = time.time() - age_s
        os.utime(junit, (then, then))
        return junit

    def ingests(self, board):
        return [(p, b) for p, b in board.posts() if p in INGEST_PATHS]

    def the_one_ingest(self, board, result):
        ingests = self.ingests(board)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"exactly one ingest; paths={[p for p, _ in board.posts()]!r} "
            f"{_diagnostics(result)}")
        path, body = ingests[0] if ingests else (None, {})
        self.assertEqual(path, RUNS_INGEST,  # type: ignore[attr-defined]
                         f"the regression files through {RUNS_INGEST}, never "
                         f"{PARSED_INGEST}; {_diagnostics(result)}")
        return body if isinstance(body, dict) else {}

    def assert_coverage_free_regression_filed(self, board, result):
        """The run exited 0 and filed one coverage-free `regression` run
        through the runs route, its envelope stating the board's `files`.
        Returns the ingest body."""
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         f"an all-green run exits 0; {_diagnostics(result)}")
        self.assertEqual(_envelope_count(result.stdout), 1,  # type: ignore[attr-defined]
                         f"exactly one envelope; {_diagnostics(result)}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(  # type: ignore[attr-defined]
            (envelope.get("verb"), envelope.get("ok")), ("regression", True),
            f"an ok:true regression envelope; envelope={envelope!r}")
        run = envelope.get("run") or {}
        self.assertEqual(  # type: ignore[attr-defined]
            (run.get("total"), run.get("failed"), run.get("files")),
            (EXPECTED_TOTAL, 0, EXPECTED_FILES),
            f"the envelope's run states the board's answer: the suite's three "
            f"cases over two binaries, files included; run={run!r}")
        self.assertNotIn("coverage", envelope,  # type: ignore[attr-defined]
                         f"a coverage-free run states no coverage; "
                         f"envelope={envelope!r}")
        body = self.the_one_ingest(board, result)
        self.assertEqual(body.get("tier"), "regression",  # type: ignore[attr-defined]
                         f"a regression run is filed; body={body!r}")
        self.assertNotIn("coverage", body,  # type: ignore[attr-defined]
                         f"without --coverage the ingest carries no coverage; "
                         f"body={body!r}")
        self.assertNotIn("summary", body,  # type: ignore[attr-defined]
                         f"the client sends no parse of its own; body={body!r}")
        self.assertEqual(  # type: ignore[attr-defined]
            (body.get("codec"), "data" in body), ("nextest", False),
            f"the run is closed from its nextest stream, carrying no report; "
            f"body={body!r}")
        held = held_results(board.held_stream(body.get("runId") or ""))
        self.assertEqual(  # type: ignore[attr-defined]
            (held["ok"], held["failed"]), (EXPECTED_TOTAL, 0),
            f"the stream the board holds is this run's own; held={held!r}")
        return body


# ── without `--coverage`: plain nextest, no llvm-cov, no cargo clean ──────

class RustRegressionWithoutCoverageRunsPlainNextestTest(_RustProject,
                                                        unittest.TestCase):
    """`regression` without `--coverage` runs the whole workspace under plain
    nextest and files a coverage-free `regression` run."""

    def setUp(self):
        self.board = _answering_board()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "rust-regression-coverage-free")

    def test_regression_without_coverage_runs_only_plain_nextest_over_the_workspace(self):
        result = self.drive(agent="rust-regression-plain")
        self.assert_lists_then_runs_plain_nextest(result)

    def test_regression_without_coverage_files_a_regression_run_with_files_and_no_coverage_key(self):
        result = self.drive(agent="rust-regression-plain-filed")
        self.assert_coverage_free_regression_filed(self.board, result)

    def test_regression_with_features_passes_that_feature_set_to_plain_nextest(self):
        result = self.drive("--features", FEATURES,
                            agent="rust-regression-plain-features")
        self.assert_lists_then_runs_plain_nextest(result, "--features", FEATURES)
        self.assert_coverage_free_regression_filed(self.board, result)

    def test_regression_with_a_named_profile_runs_plain_nextest_under_it(self):
        result = self.drive("--profile", "nightly",
                            agent="rust-regression-plain-profile")
        self.assert_lists_then_runs_plain_nextest(result, profile="nightly")
        self.assert_coverage_free_regression_filed(self.board, result)

    def test_regression_without_coverage_under_cycle_binds_the_run_and_stays_coverage_free(self):
        result = self.drive("--cycle", str(CYCLE),
                            agent="rust-regression-plain-cycle")
        self.assert_lists_then_runs_plain_nextest(result)
        self.assert_coverage_free_regression_filed(self.board, result)
        bound = [b for p, b in self.board.posts()
                 if p.endswith("/agents/heartbeat") and isinstance(b, dict)
                 and b.get("cycleId") == CYCLE]
        self.assertEqual(
            len(bound), 1,
            f"the gated identity's opening heartbeat carries the cycle, once; "
            f"posts={[p for p, _ in self.board.posts()]!r} "
            f"{_diagnostics(result)}")

    def test_regression_without_coverage_under_release_files_the_release_and_stays_coverage_free(self):
        result = self.drive("--release", RELEASE,
                            agent="rust-regression-plain-release")
        self.assert_lists_then_runs_plain_nextest(result)
        body = self.assert_coverage_free_regression_filed(self.board, result)
        self.assertEqual(body.get("release"), RELEASE,
                         f"the ingest is filed under the release; body={body!r}")


# ── a stale report is never this run's ──────────────────────────────────────

class RustRegressionWithoutCoverageClearsStaleJunitTest(_RustProject,
                                                        unittest.TestCase):
    """With no `cargo clean`, a junit an earlier run left for the profile is
    never read as this run's. The suite run here writes no stream line, so a
    run that read the stale report would file it."""

    def setUp(self):
        self.board = _answering_board()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "rust-regression-stale-junit")

    def assert_stale_report_not_read(self, result, stale):
        wire = json.dumps([b for _, b in self.board.posts()])
        self.assertNotIn(
            STALE_CASE, wire,
            f"an earlier run's junit is never filed as this run's; "
            f"{_diagnostics(result)}")
        self.assertEqual(
            self.ingests(self.board), [],
            f"a run that wrote no junit files nothing; "
            f"{_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0,
                            f"a run with no report of its own is a failure; "
                            f"{_diagnostics(result)}")
        self.assertNotIn(["clean"], self.launches(),
                         f"nothing runs a cargo clean; "
                         f"launches={self.launches()!r}")

    def test_stale_junit_for_the_default_profile_is_never_filed_as_this_runs(self):
        stale = self.plant_stale_junit("ci")
        result = self.drive(agent="rust-regression-stale-ci", FAKE_NO_REPORT="1")
        self.assert_stale_report_not_read(result, stale)

    def test_stale_junit_for_a_named_profile_is_never_filed_as_this_runs(self):
        stale = self.plant_stale_junit("nightly")
        result = self.drive("--profile", "nightly",
                            agent="rust-regression-stale-named",
                            FAKE_NO_REPORT="1")
        self.assert_stale_report_not_read(result, stale)


# ── a report another run wrote moments ago is never this run's ─────────

class RustRegressionFilesOnlyItsOwnReportTest(_RustProject, unittest.TestCase):
    """A junit another run wrote seconds before this one started is not this
    run's report. A plain `regression` whose suite run writes no stream line
    takes the no-report path: it files nothing, aborts the run it opened and
    exits non-zero, and it leaves the other run's report where that run wrote
    it."""

    # Seconds old: a report as fresh as this run's own would be.
    AGE_S = 5

    def setUp(self):
        self.board = _answering_board()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "rust-regression-own-report")

    def test_a_report_another_run_wrote_seconds_ago_is_never_filed(self):
        planted = self.plant_stale_junit("ci", age_s=self.AGE_S,
                                         case=ANOTHER_RUNS_CASE)
        result = self.drive(agent="rust-regression-own-report",
                            FAKE_NO_REPORT="1")
        wire = json.dumps([b for _, b in self.board.posts()])
        self.assertNotIn(
            ANOTHER_RUNS_CASE, wire,
            f"a report another run wrote is never filed as this run's; "
            f"{_diagnostics(result)}")
        self.assertEqual(
            self.ingests(self.board), [],
            f"a run that wrote no junit of its own files nothing; "
            f"{_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0,
                            f"a run with no report of its own is a failure; "
                            f"{_diagnostics(result)}")
        self.assertEqual(_envelope_count(result.stdout), 1,
                         f"exactly one envelope; {_diagnostics(result)}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(
            (envelope.get("verb"), envelope.get("ok")), ("regression", False),
            f"an ok:false regression envelope; envelope={envelope!r}")
        codes = [w.get("code") for w in envelope.get("warnings") or []
                 if isinstance(w, dict)]
        self.assertIn(NO_REPORT_CODE, codes,
                      f"the run takes the no-report path; envelope={envelope!r}")
        self.assertEqual(
            len(self.board.aborts()), 1,
            f"the run it opened is aborted, once; "
            f"posts={[p for p, _ in self.board.posts()]!r} "
            f"{_diagnostics(result)}")
        self.assertTrue(
            planted.exists(),
            f"the other run's report stays where that run wrote it; "
            f"{_diagnostics(result)}")


# ── the disk guard on an `--all-features` build ────────────────────────────

class RustRegressionWithoutCoverageKeepsTheDiskGuardTest(_RustProject,
                                                         unittest.TestCase):
    """A coverage-free `--all-features` run is guarded by `--min-free-g`."""

    FREE_G = 20

    def setUp(self):
        self.board = _answering_board()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "rust-regression-disk-guard",
                          free_g=self.FREE_G)

    def test_all_features_run_below_the_floor_is_refused_before_cargo_builds(self):
        result = self.drive("--all-features", "--min-free-g", "50",
                            "--cycle", str(CYCLE),
                            agent="rust-regression-disk-refused")
        self.assertEqual(result.returncode, 2,
                         f"the disk guard refuses with exit 2; "
                         f"{_diagnostics(result)}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(
            (envelope.get("verb"), envelope.get("ok")), ("regression", False),
            f"an ok:false regression envelope; envelope={envelope!r}")
        self.assertEqual(
            [argv for argv in self.launches() if argv[:1] != ["cache"]], [],
            f"nothing but the guard's own cache reclaim is launched — no "
            f"nextest, no llvm-cov, no cargo clean; "
            f"launches={self.launches()!r} {_diagnostics(result)}")
        self.assertEqual(self.board.posts(), [],
                         f"a run refused before it starts posts nothing; "
                         f"{_diagnostics(result)}")

    def test_run_without_all_features_below_the_floor_is_not_guarded(self):
        result = self.drive("--min-free-g", "50",
                            agent="rust-regression-disk-unguarded")
        # A coverage-free run without --all-features is not disk-heavy, so
        # free space below the floor still lists and runs plain nextest.
        self.assert_lists_then_runs_plain_nextest(result)
        self.assert_coverage_free_regression_filed(self.board, result)

    def test_all_features_run_with_the_floor_below_free_space_runs_plain_nextest(self):
        result = self.drive("--all-features", "--min-free-g", "10",
                            agent="rust-regression-disk-proceeds")
        self.assert_lists_then_runs_plain_nextest(result, "--all-features")
        self.assertEqual(
            [_plain_streamed(argv) for argv in self.launches()[1:]],
            [_plain_nextest("--all-features")],
            f"a floor below the free space lets the --all-features run "
            f"proceed under plain nextest; {_diagnostics(result)}")
        self.assert_coverage_free_regression_filed(self.board, result)


# ── with `--coverage`: today's coverage run ────────────────────────────────

class RustRegressionWithCoverageTest(_RustProject, unittest.TestCase):
    """`regression --coverage` cleans, lists and streams its run under
    llvm-cov's environment, writes the lcov with `llvm-cov report`, files it
    as the close's coverage and reclaims."""

    def setUp(self):
        self.board = _answering_board()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "rust-regression-coverage")

    def assert_carries_the_lcov(self, result):
        self.assertNotIn(REFUSED_CODE,
                         (result.stdout or "") + (result.stderr or ""),
                         _diagnostics(result))
        self.assertEqual(result.returncode, 0,
                         f"an all-green coverage run exits 0; "
                         f"{_diagnostics(result)}")
        body = self.the_one_ingest(self.board, result)
        self.assertEqual(body.get("tier"), "regression",
                         f"a regression run is filed; body={body!r}")
        self.assertEqual(
            body.get("coverage"), {"codec": "lcov", "data": [EXPECTED_LCOV_TEXT]},
            f"the ingest sends the run's own lcov text as its coverage report; "
            f"body={body!r}")

    def assert_coverage_launches(self, result, reclaim, lcov_output="target/lcov.info"):
        """cargo clean; `llvm-cov show-env`; the json list and the streamed
        plain nextest run of the workspace; `llvm-cov report --failure-mode
        all --lcov`; and the post-run reclaim when `reclaim`. Clearing old
        profiles with `llvm-cov clean` may come between them. No launch runs
        the tests under `llvm-cov nextest`."""
        launches = [argv for argv in self.launches() if argv[:2] != ["llvm-cov", "clean"]]
        where = f"launches={self.launches()!r} {_diagnostics(result)}"
        expected = [["clean"], ["llvm-cov", "show-env"], ["nextest", "list"],
                    ["nextest", "run"], ["llvm-cov", "report"]] + (
            [["clean"]] if reclaim else [])
        self.assertEqual([argv[:1] if argv[:1] == ["clean"] else argv[:2]
                          for argv in launches], expected, where)
        if launches[:1] != [["clean"]] or len(launches) != len(expected):
            return
        self.assertEqual(_listed_selection(launches[2]),
                         sorted(["--workspace", "-P", "ci"]), where)
        self.assertEqual(_plain_streamed(launches[3]), _plain_nextest(), where)
        report = launches[4]
        self.assertIn("--lcov", report, where)
        self.assertEqual(_without_pairs(report, (("--failure-mode", "all"),))[1],
                         [("--failure-mode", "all")], where)
        self.assertEqual(_without_pairs(report, (("--output-path", lcov_output),))[1],
                         [("--output-path", lcov_output)],
                         f"the report writes the lcov at {lcov_output}; {where}")
        self.assertFalse(any(argv[:1] == ["llvm-cov"] and "nextest" in argv
                             for argv in self.launches()), where)

    def test_coverage_cleans_runs_llvm_cov_nextest_and_reclaims(self):
        result = self.drive("--coverage", agent="rust-regression-coverage-run")
        self.assert_coverage_launches(result, reclaim=True)
        self.assert_carries_the_lcov(result)

    def test_coverage_with_lcov_output_and_keep_target_writes_there_and_keeps_target(self):
        custom = "target/cov/custom.info"
        result = self.drive("--coverage", "--lcov-output", custom,
                            "--keep-target",
                            agent="rust-regression-coverage-flags")
        # With --coverage, --lcov-output names where the report writes the
        # lcov, and --keep-target skips the post-run reclaim.
        self.assert_coverage_launches(result, reclaim=False, lcov_output=custom)
        self.assert_carries_the_lcov(result)


# ── a coverage-only flag without `--coverage` is refused ───────────────────

class RustCoverageOnlyFlagWithoutCoverageIsRefusedTest(_RustProject,
                                                       unittest.TestCase):
    """`--lcov-output` and `--keep-target` without `--coverage` are the
    typed `coverage-flag-refused` hard stop, decided before the board, the
    gate lock or cargo; the retired `--ignore-run-fail` is refused as early."""

    def setUp(self):
        # A board whose health lists `nextest` under `codecs.stream`, so a run
        # that gets past the board's health reaches the gate lock.
        self.board = ActiveCycleBoard(health=board_health())
        self.addCleanup(self.board.close)
        # The project key must not spell the refusal's code: the envelope's
        # context carries it, and the code is looked for in both streams.
        self.make_project(self.board.url, "rust-refusal-fixture")
        self._hold_gate_lock()

    def _hold_gate_lock(self):
        """A LIVE holder the client recognises as a gate runner: the project
        is a git repo (so the lock resolves to its root) and the lock names a
        running process whose command line says `cargo`."""
        subprocess.run(["git", "init", "-q", self.project], check=True,
                       capture_output=True)
        holder = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)", "cargo"])

        def _stop():
            holder.terminate()
            holder.wait(timeout=10)
        self.addCleanup(_stop)
        self.lock = Path(self.project, GATE_LOCK_FILE)
        self.lock.write_text(f"owner=someone-else\ncr=\npid={holder.pid}\n"
                             f"epoch={int(time.time())}\n")
        self.lock_text = self.lock.read_text()

    def assert_refused_before_anything_runs(self, flag, *argv):
        before = _tree(self.project)
        result = self.drive(*argv, agent="rust-flag-alone-agent")
        streams = (result.stdout or "") + (result.stderr or "")
        self.assertIn(
            REFUSED_CODE, streams,
            f"{flag} without --coverage is the typed {REFUSED_CODE} hard "
            f"stop; {_diagnostics(result)}")
        envelope = self.assert_one_refusal_and_nothing_ran(result, before)
        error = _plain(envelope.get("error") or "")
        self.assertIn(flag, error,
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

    def assert_one_refusal_and_nothing_ran(self, result, before):
        """One ok:false `regression` envelope, a non-zero exit that is not
        the gate-locked one, and nothing reached: no board request, no cargo
        launch, the held lock untouched, nothing written into the project.
        Returns the envelope."""
        streams = (result.stdout or "") + (result.stderr or "")
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
        self.assertNotEqual(result.returncode, 0,
                            f"a refusal exits non-zero; {_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 75,
                            f"the refusal comes before the gate lock, so it is "
                            f"never the gate-locked exit; {_diagnostics(result)}")
        self.assertEqual(
            self.board.seen(), [],
            f"refused before anything reaches the board — no GET, no "
            f"heartbeat, no run start, no ingest; {_diagnostics(result)}")
        self.assertEqual(
            self.launches(), [],
            f"no cargo is launched — no clean, no nextest, no llvm-cov; "
            f"{_diagnostics(result)}")
        self.assertEqual(
            self.lock.read_text(), self.lock_text,
            f"the gate lock is never reached: the held lock is untouched; "
            f"{_diagnostics(result)}")
        self.assertEqual(
            _tree(self.project), before,
            f"nothing is written into the project — no lock, no reports, no "
            f"target; {_diagnostics(result)}")
        return envelope

    def test_lcov_output_without_coverage_is_refused_before_anything_runs(self):
        self.assert_refused_before_anything_runs(
            "--lcov-output", "--lcov-output", "target/cov/custom.info")

    def test_ignore_run_fail_without_coverage_is_refused_before_anything_runs(self):
        """The retired flag is refused whether or not `--coverage` is given:
        the refusal names it and says the lcov is now always written, and
        never tells the caller to add `--coverage`."""
        before = _tree(self.project)
        result = self.drive("--ignore-run-fail", agent="rust-flag-alone-agent")
        envelope = self.assert_one_refusal_and_nothing_ran(result, before)
        said = _plain(" ".join([str(envelope.get("error") or "")]
                               + [str(h) for h in envelope.get("help") or []]))
        self.assertIn("--ignore-run-fail", said,
                      f"the refusal names the retired flag; envelope={envelope!r}")
        self.assertIn("lcov", said,
                      f"the refusal says the lcov is now always written; "
                      f"envelope={envelope!r}")
        self.assertNotIn("add --coverage", said,
                         f"--coverage does not make a retired flag valid; "
                         f"envelope={envelope!r}")

    def test_keep_target_without_coverage_is_refused_before_anything_runs(self):
        self.assert_refused_before_anything_runs(
            "--keep-target", "--keep-target")

    def test_guard_a_plain_regression_on_this_board_is_the_unattributed_refusal(self):
        """GUARD — the stand-in's active cycle is what makes the refusal
        ordering observable: a `regression` with no `--cycle` against it
        consults the board (so this board does see a client that asks it) and
        is the unattributed-run refusal, and cargo never runs."""
        result = self.drive(agent="rust-flag-guard-agent")
        self.assertIn(UNATTRIBUTED_CODE, result.stderr or "",
                      f"an unbound run with no --cycle while cycle "
                      f"{ActiveCycleBoard.ACTIVE_CYCLE_ID} is active is "
                      f"refused; {_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0, _diagnostics(result))
        self.assertNotEqual(self.board.seen(), [],
                            f"the stand-in board records the client's "
                            f"requests; {_diagnostics(result)}")
        self.assertEqual(self.launches(), [],
                         f"cargo never runs; {_diagnostics(result)}")

    def test_guard_a_plain_regression_bound_to_the_cycle_is_refused_by_the_held_gate_lock(self):
        """GUARD — the held lock is what makes "the gate lock is never
        reached" observable: a coverage-free `regression` bound to the active
        cycle gets past the board and is refused by the lock (exit 75), and
        cargo never runs. It also pins that the coverage-free run still takes
        the gate lock."""
        result = self.drive("--cycle", str(ActiveCycleBoard.ACTIVE_CYCLE_ID),
                            agent="rust-flag-lock-guard-agent")
        self.assertEqual(result.returncode, 75,
                         f"a held gate lock refuses the run with exit 75; "
                         f"{_diagnostics(result)}")
        self.assertEqual(self.launches(), [],
                         f"cargo never runs; {_diagnostics(result)}")
        self.assertEqual(self.lock.read_text(), self.lock_text,
                         f"the holder's lock is left as it was; "
                         f"{_diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
