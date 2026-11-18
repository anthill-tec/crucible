"""A rust run streams REAL nextest to a REAL board, end to end.

The real `clients/rust-crucible.py`, real cargo-nextest (0.9.130 or later),
real cargo-llvm-cov and a real board (`bun run src/server.ts` on a free port
with a throwaway store), against the scratch workspace committed at
`tests/fixtures/nextest/workspace` (with `nxpass` and `nx-targets` from
`tests/fixtures/nextest/crates` copied in): several crates, a test that runs
for at least three relay cycles (`nxlive::slow`), a failing test in two
crates, an ignored test in two crates, a feature-gated test
(`nxlive/e2e`), and a docker-tier binary (`e2e_dock`) every run's profile
excludes by its `default-filter`.

The workspace is copied to /tmp and built there, in its own target
directory, once for the module: every run below shares that build, in the
order the coverage checks need (the coverage run first, then a plain run).
Nothing builds in the repository's tree.

What the client sends is read on its way to the board through a recording
proxy; what cargo was asked, and what each cargo call printed on stderr,
through a `cargo` shim first on `PATH` that hands every call to the real
cargo; and what the board holds, from the board itself.

  - while the slow test is still running, the open run holds at least one
    decoded result and fewer than its total;
  - every stream batch carries codec `nextest`; the run states framework
    `nextest`; it closes from its stream with the workspace's passed, failed
    and pending counts, every listed test run despite the failures;
  - the list is posted before the first stream batch, and the open run's
    total is the list's matching tests, under the profile's `default-filter`,
    with `--features`, for a crate selection, an `-E` filter, `--lib`,
    `--tests` and `--test <name>`;
  - a coverage run's run step compiles nothing and files its lcov although a
    test failed; a plain run after it compiles its crates again, and no
    `.profraw` lies outside the coverage target directory;
  - the record the board stores equals the board's `junit` decoding of the
    JUnit report the same nextest run wrote (the same suites, tests,
    statuses, passed and failed counts and failure messages; an ignored test
    is a pending leaf JUnit does not have); no verb posts a `junit` ingest,
    and an `auto-ingest` straight after files nothing.

A missing toolchain FAILS every test here, naming what is missing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_rust_run_streams_real_nextest_end_to_end
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    install_project,
    load_toon,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "nextest"
RUST_CLIENT = CLIENTS / "rust-crucible.py"
TOON = load_toon()
MIN_NEXTEST = (0, 9, 130)
RUN_TIMEOUT = 600
LIVE_POLL_SECONDS = 0.25
COVERAGE_TARGET = os.path.join("target", "llvm-cov-target")

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
             "RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE",
             "NEXTEST_EXPERIMENTAL_LIBTEST_JSON", "NEXTEST_PROFILE",
             "LLVM_PROFILE_FILE", "CARGO_LLVM_COV", "RUSTC_WRAPPER",
             "CARGO_BUILD_TARGET_DIR")

# The runs, in the order they are made, each with the counts the workspace's
# design gives it: matching tests (the list's total), passed, failed and
# pending (ignored) tests. `live` marks a run that selects the slow test.
RUNS = (
    ("workspace-regression", ("workspace-regression", "--features", "nxlive/e2e",
                              "--min-free-g", "0", "--keep-target"),
     {"matches": 12, "passed": 10, "failed": 2, "pending": 2, "live": True,
      "coverage": True}),
    ("test", ("test", "--crate", "nxlive", "--features", "e2e"),
     {"matches": 4, "passed": 3, "failed": 1, "pending": 1, "live": True}),
    ("regression-ingest", ("regression-ingest", "--crates", "nxlive,nxpass"),
     {"matches": 6, "passed": 5, "failed": 1, "pending": 1, "live": True,
      "coverage": True}),
    ("smoke-test", ("smoke-test", "--features", "nxlive/e2e"),
     {"matches": 12, "passed": 10, "failed": 2, "pending": 2, "live": True}),
    ("test -p", ("test", "--crate", "nxpass"),
     {"matches": 3, "passed": 3, "failed": 0, "pending": 0}),
    ("test -E", ("test", "--crate", "nx-targets", "--filter", "test(/doubles/)"),
     {"matches": 3, "passed": 2, "failed": 1, "pending": 0}),
    ("unit --lib", ("unit",),
     {"matches": 7, "passed": 5, "failed": 2, "pending": 2}),
    ("integration --tests", ("integration", "--crate", "nxpass"),
     {"matches": 3, "passed": 3, "failed": 0, "pending": 0}),
    ("integration --test", ("integration", "--test", "it"),
     {"matches": 2, "passed": 2, "failed": 0, "pending": 0}),
)
AC1_RUNS = ("workspace-regression", "test", "regression-ingest", "smoke-test")
COVERAGE_RUNS = ("workspace-regression", "regression-ingest")

# A `cargo` shim: every call is handed to the real cargo with stdout
# inherited (the stream reaches the client untouched), stderr echoed and kept
# per call, and after a `nextest run` each JUnit report it wrote or rewrote
# copied aside. One JSON record per call in $CARGO_SHIM_DIR/calls.jsonl.
_SHIM = r'''
import glob, json, os, shutil, subprocess, sys, time
real = os.environ["CARGO_SHIM_REAL"]
log_dir = os.environ["CARGO_SHIM_DIR"]
argv = sys.argv[1:]
seq = "%d-%d" % (time.time_ns(), os.getpid())
err_path = os.path.join(log_dir, seq + ".stderr")
started = time.time()
root = os.environ["CARGO_SHIM_PROJECT"]
def reports():
    found = {}
    for path in glob.glob(os.path.join(root, "**", "junit.xml"), recursive=True):
        found[path] = os.stat(path).st_mtime_ns
    return found
before = reports() if argv[:2] == ["nextest", "run"] else {}
proc = subprocess.Popen([real] + argv, stderr=subprocess.PIPE)
with open(err_path, "wb") as kept:
    for line in proc.stderr:
        sys.stderr.buffer.write(line)
        sys.stderr.buffer.flush()
        kept.write(line)
code = proc.wait()
junit = []
if argv[:2] == ["nextest", "run"]:
    for path, written in sorted(reports().items()):
        if before.get(path) != written:
            kept_junit = os.path.join(log_dir, seq + "-" + str(len(junit)) + ".junit.xml")
            shutil.copyfile(path, kept_junit)
            junit.append(kept_junit)
env = {k: os.environ.get(k) for k in ("CARGO_TARGET_DIR", "CARGO_LLVM_COV",
       "LLVM_PROFILE_FILE", "NEXTEST_EXPERIMENTAL_LIBTEST_JSON")}
with open(os.path.join(log_dir, "calls.jsonl"), "a") as handle:
    handle.write(json.dumps({"argv": argv, "started": started, "ended": time.time(),
                             "exit": code, "stderr": err_path, "junit": junit,
                             "env": env}) + "\n")
sys.exit(code)
'''


def _version_tuple(text):
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in found.groups()) if found else None


def _toolchain_gap():
    """What is missing to run these tests, or None."""
    missing = []
    if shutil.which("bun") is None:
        missing.append("bun (the real board is `bun run src/server.ts`)")
    cargo = shutil.which("cargo")
    if cargo is None:
        return "; ".join(missing + ["cargo"])
    nextest = subprocess.run([cargo, "nextest", "--version"], capture_output=True,
                             text=True, check=False)
    version = _version_tuple(nextest.stdout) if nextest.returncode == 0 else None
    if version is None or version < MIN_NEXTEST:
        missing.append(f"cargo-nextest 0.9.130 or later (found: "
                       f"{(nextest.stdout or nextest.stderr).strip()[:80] or 'none'})")
    llvm_cov = subprocess.run([cargo, "llvm-cov", "--version"], capture_output=True,
                              text=True, check=False)
    if llvm_cov.returncode != 0:
        missing.append("cargo-llvm-cov")
    return "; ".join(missing) or None


class _Run:
    """One drive and everything observed of it."""

    def __init__(self, label, agent):
        self.label = label
        self.agent = agent
        self.result: subprocess.CompletedProcess | None = None
        self.seconds = 0.0
        self.records = []
        self.calls = []
        self.samples = []
        self.run_id = None

    def where(self):
        result = self.result
        if result is None:
            return f"{self.label}: never driven"
        return (f"{self.label}: exit={result.returncode} stdout={result.stdout[-1200:]!r} "
                f"stderr={result.stderr[-1500:]!r}")

    def posts(self, suffix):
        return [r for r in self.records if r["method"] == "POST" and r["path"].endswith(suffix)]

    def stream_batches(self):
        return [r for r in self.records if r["method"] == "POST"
                and re.match(r"^/api/v2/runs/[^/]+/stream$", r["path"])]

    def list_posts(self):
        return [r for r in self.records if r["method"] == "POST"
                and re.match(r"^/api/v2/runs/[^/]+/tests$", r["path"])]

    def closes(self):
        return [r for r in self.records if r["method"] == "POST" and r["path"] == "/api/v2/runs"]

    def calls_of(self, *head):
        return [c for c in self.calls if c["argv"][:len(head)] == list(head)]


_MODULE = {}


def _register(agent, project, env):
    registered = subprocess.run(
        [sys.executable, str(RUST_CLIENT), "register", "--agent", agent, "--role",
         "report", "--project-dir", project], cwd=project, env=env,
        capture_output=True, text=True, timeout=60, check=False)
    if registered.returncode != 0:
        raise RuntimeError(f"register {agent} failed: {registered.stdout[-500:]!r}")


JUNIT_ORACLE = "real-nextest-junit-oracle"


def _drive(label, verb_argv, *, project, env, proxy, board, shim_dir, marker_dir=None):
    agent = "real-nextest-" + re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    run = _Run(label, agent)
    _register(agent, project, env)
    calls_file = os.path.join(shim_dir, "calls.jsonl")
    calls_before = len(Path(calls_file).read_text().splitlines()) if os.path.exists(calls_file) else 0
    start = proxy.count()
    drive_env = dict(env)
    if marker_dir:
        os.makedirs(marker_dir, exist_ok=True)
        drive_env["NXLIVE_MARKER_DIR"] = marker_dir
    began = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(RUST_CLIENT), *verb_argv, "--agent", agent,
         "--project-dir", project], cwd=project, env=drive_env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder = {}
    reader = threading.Thread(target=lambda: holder.update(out=proc.communicate(timeout=RUN_TIMEOUT)))
    reader.start()
    while reader.is_alive():
        if run.run_id is None:
            for record in proxy.since(start):
                if record["path"] == "/api/v2/runs/start" and isinstance(record["answer"], dict):
                    run.run_id = record["answer"].get("runId")
        if run.run_id is not None:
            live = board.http(f"/api/v2/runs/{run.run_id}/live")
            run.samples.append({
                "started": bool(marker_dir) and os.path.exists(os.path.join(marker_dir, "started")),
                "finished": bool(marker_dir) and os.path.exists(os.path.join(marker_dir, "finished")),
                "live": live})
        reader.join(LIVE_POLL_SECONDS)
    stdout, stderr = holder.get("out", ("", ""))
    run.result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
    run.seconds = time.time() - began
    run.records = proxy.since(start)
    if os.path.exists(calls_file):
        run.calls = [json.loads(line) for line in
                     Path(calls_file).read_text().splitlines()[calls_before:]]
    return run


def setUpModule():
    gap = _toolchain_gap()
    if gap:
        _MODULE["gap"] = f"the real-runner tests need: {gap}"
        return
    began = time.time()
    scratch = tempfile.mkdtemp(prefix="crucible-real-nextest-")
    _MODULE["scratch"] = scratch
    project = os.path.join(scratch, "workspace")
    shutil.copytree(FIXTURES / "workspace", project)
    for crate in ("nxpass", "nx-targets"):
        shutil.copytree(FIXTURES / "crates" / crate, os.path.join(project, "crates", crate),
                        ignore=shutil.ignore_patterns("target", "Cargo.lock"))
    board = RealBoard(shutil.which("bun"), "real-nextest-runs", proxy=True)
    _MODULE["board"] = board
    proxy = board.proxy
    _MODULE["proxy"] = proxy
    install_project(project, proxy.url, board.key, board.name)
    shim_dir = os.path.join(scratch, "shim")
    bin_dir = os.path.join(scratch, "bin")
    os.makedirs(shim_dir)
    os.makedirs(bin_dir)
    shim = Path(bin_dir, "cargo")
    shim.write_text("#!" + sys.executable + "\n" + _SHIM)
    os.chmod(shim, stat.S_IRWXU)
    env = scrubbed_env(bin_dir, CARGO_SHIM_REAL=shutil.which("cargo"),
                       CARGO_SHIM_DIR=shim_dir, CARGO_SHIM_PROJECT=project,
                       CARGO_TARGET_DIR=os.path.join(project, "target"))
    for key in _SCRUBBED:
        env.pop(key, None)
    _MODULE.update(project=project, env=env, shim_dir=shim_dir)
    _register(JUNIT_ORACLE, project, env)
    runs = {}
    for label, verb_argv, expected in RUNS:
        marker_dir = os.path.join(scratch, "marks", label.replace(" ", "_")) if expected.get("live") else None
        runs[label] = _drive(label, verb_argv, project=project, env=env, proxy=proxy,
                             board=board, shim_dir=shim_dir, marker_dir=marker_dir)
        if label == "test":
            # Straight after the plain run: what a coverage run's instrumented
            # build left outside its own target directory, and what an
            # outside-run `auto-ingest` files.
            coverage_dir = os.path.join(project, COVERAGE_TARGET)
            _MODULE["stray_profraw"] = sorted(
                os.path.relpath(path, project)
                for path in Path(project).rglob("*.profraw")
                if not str(path).startswith(coverage_dir + os.sep))
            _MODULE["auto_ingest"] = _drive(
                "auto-ingest", ("auto-ingest", "--crate", "nxlive"), project=project,
                env=env, proxy=proxy, board=board, shim_dir=shim_dir)
    _MODULE["runs"] = runs
    _MODULE["seconds"] = time.time() - began
    print(f"[real-nextest] module built and drove every run in {_MODULE['seconds']:.1f}s: "
          + ", ".join(f"{r.label}={r.seconds:.1f}s" for r in runs.values()), file=sys.stderr)


def tearDownModule():
    proxy = _MODULE.pop("proxy", None)
    if proxy is not None:
        proxy.close()
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()
    scratch = _MODULE.pop("scratch", None)
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)


def _rows(tree):
    return sorted(((suite.get("name"), leaf.get("name"), leaf.get("status"),
                    (leaf.get("failure") or {}).get("message"))
                   for suite in tree or [] for leaf in suite.get("children") or []),
                  key=lambda row: (str(row[0]), str(row[1])))


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


class _RealRunCase(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        gap = _MODULE.get("gap")
        if gap:
            self.fail(gap)
        if "runs" not in _MODULE:
            self.fail("the module's real runs were never made")
        self.runs = _MODULE["runs"]
        self.board = _MODULE["board"]

    def stored(self, run):
        events = self.board.test_events(run.agent)
        self.assertEqual(len(events), 1,
                         f"one run is stored for {run.agent}; events={len(events)} {run.where()}")
        return self.board.event(events[0]["id"])

    def list_total(self, run):
        posts = run.list_posts()
        self.assertEqual(len(posts), 1, f"one test list is posted; {run.where()}")
        answer = posts[0]["answer"] or {}
        self.assertEqual(posts[0]["status"], 200, f"the board took the list: {answer!r}")
        return posts[0], answer.get("total")


class TheOpenRunFillsLiveFromTheStreamTest(_RealRunCase):

    def test_while_the_slow_test_runs_the_open_run_holds_some_but_not_all_results(self):
        for label in AC1_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                running = [s for s in run.samples if s["started"] and not s["finished"]]
                self.assertGreaterEqual(len(running), 4,
                                        f"the board was read while the slow test ran; "
                                        f"samples={len(run.samples)} {run.where()}")
                during = [s for s in running if (s["live"] or {}).get("state") == "open"]
                self.assertGreaterEqual(len(during), 1,
                                        f"the open run had a live state while the slow test "
                                        f"ran; last read={running[-1]['live']!r}")
                partial = [s["live"]["live"] for s in during
                           if 1 <= (s["live"].get("live") or {}).get("completed", 0)
                           < ((s["live"].get("live") or {}).get("total") or 0)]
                self.assertGreaterEqual(
                    len(partial), 1,
                    f"while the slow test ran, the open run held at least one decoded "
                    f"result and fewer than its total; last live="
                    f"{during[-1]['live'].get('live') if during else None!r}")

    def test_every_stream_batch_carries_codec_nextest(self):
        for label in AC1_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                batches = run.stream_batches()
                self.assertGreaterEqual(len(batches), 2,
                                        f"the slow test spans several batches; {run.where()}")
                self.assertEqual({(b["body"] or {}).get("codec") for b in batches}, {"nextest"},
                                 run.where())

    def test_the_run_states_framework_nextest(self):
        for label in AC1_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                starts = run.posts("/api/v2/runs/start")
                self.assertEqual([(s["body"] or {}).get("framework") for s in starts],
                                 ["nextest"], run.where())
                self.assertEqual(self.stored(run).get("framework"), "nextest", run.where())

    def test_the_run_closes_from_its_stream_with_the_workspaces_counts(self):
        for label in AC1_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                expected = next(e for lbl, _a, e in RUNS if lbl == label)
                closes = run.closes()
                self.assertEqual([(c["body"] or {}).get("codec") for c in closes], ["nextest"],
                                 f"one close, from the stream; {run.where()}")
                summary = self.stored(run).get("summary") or {}
                self.assertEqual(
                    {k: summary.get(k) for k in ("passed", "failed", "pending")},
                    {k: expected[k] for k in ("passed", "failed", "pending")},
                    f"the stored counts are the workspace's; {run.where()}")
                self.assertEqual(summary.get("passed", 0) + summary.get("failed", 0),
                                 expected["matches"],
                                 f"every listed test ran despite the failures; {run.where()}")
                self.assertNotEqual(run.result.returncode if run.result else None, 0,
                                    f"a run with failures exits non-zero; {run.where()}")


class TheListComesFirstAndGivesTheTotalTest(_RealRunCase):

    def test_the_list_is_posted_before_the_first_stream_batch(self):
        for label, _argv, _expected in RUNS:
            with self.subTest(run=label):
                run = self.runs[label]
                posted, _total = self.list_total(run)
                batches = run.stream_batches()
                self.assertGreaterEqual(len(batches), 1, run.where())
                self.assertLess(posted["at"], batches[0]["at"], run.where())
                self.assertLess(run.records.index(posted), run.records.index(batches[0]),
                                run.where())

    def test_the_open_runs_total_is_the_lists_matching_tests_for_every_selection(self):
        for label, _argv, expected in RUNS:
            with self.subTest(run=label):
                run = self.runs[label]
                posted, total = self.list_total(run)
                listed = json.loads((posted["body"] or {}).get("data") or "{}")
                matches = [(binary, name)
                           for binary, suite in (listed.get("rust-suites") or {}).items()
                           for name, case in (suite.get("testcases") or {}).items()
                           if (case.get("filter-match") or {}).get("status") == "matches"]
                self.assertEqual(len(matches), expected["matches"],
                                 f"the list selects what the run selects; matches={matches!r}")
                self.assertEqual(total, expected["matches"],
                                 f"the board's total is the list's; {run.where()}")
                self.assertEqual([m for m in matches if "e2e_dock" in m[0]], [],
                                 "the profile's default-filter excludes the docker tier")

    def test_no_stored_record_holds_the_docker_tier_the_default_filter_excludes(self):
        for label, _argv, _expected in RUNS:
            with self.subTest(run=label):
                run = self.runs[label]
                tree = self.stored(run).get("tree") or []
                self.assertEqual([s.get("name") for s in tree if "e2e_dock" in str(s.get("name"))],
                                 [], run.where())


class ACoverageRunBuildsOnceInItsOwnTargetTest(_RealRunCase):

    def test_a_coverage_runs_run_step_compiles_nothing_and_files_its_lcov_though_a_test_failed(self):
        for label in COVERAGE_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                steps = run.calls_of("nextest", "run")
                self.assertEqual(len(steps), 1, f"one run step; calls="
                                 f"{[c['argv'][:3] for c in run.calls]!r} {run.where()}")
                printed = Path(steps[0]["stderr"]).read_text(errors="replace")
                compiled = [line for line in printed.splitlines()
                            if re.match(r"^\s*Compiling ", line)]
                self.assertEqual(compiled, [], f"the run step reuses the list's build; {run.where()}")
                self.assertIn("Starting", printed, "the run step's stderr is nextest's own")
                close = (run.closes() or [{}])[0].get("body") or {}
                coverage = close.get("coverage") or {}
                self.assertEqual(coverage.get("codec"), "lcov", run.where())
                data = coverage.get("data")
                text = "".join(data) if isinstance(data, list) else str(data or "")
                self.assertIn("SF:", text, f"the lcov holds source files; {run.where()}")
                self.assertGreater((self.stored(run).get("summary") or {}).get("failed", 0), 0,
                                   "a test failed in the coverage run")

    def test_a_plain_run_after_a_coverage_run_compiles_its_crates_again(self):
        run = self.runs["test"]
        printed = "".join(Path(c["stderr"]).read_text(errors="replace")
                          for c in run.calls if c["argv"][:1] == ["nextest"])
        self.assertRegex(printed, r"(?m)^\s*Compiling nxlive ",
                         f"the plain run builds outside the instrumented tree; {run.where()}")

    def test_no_profraw_lies_outside_the_coverage_target_directory(self):
        self.assertEqual(_MODULE.get("stray_profraw"), [],
                         "the instrumented build's profiles stay in target/llvm-cov-target")


class TheStoredRecordEqualsJUnitsTest(_RealRunCase):

    def junit_record(self, run):
        steps = run.calls_of("nextest", "run")
        self.assertEqual(len(steps), 1, run.where())
        reports = steps[0]["junit"]
        self.assertEqual(len(reports), 1, f"the run wrote one JUnit report; {reports!r}")
        filed = self.board.http("/api/v2/runs", {
            "projectKey": self.board.key, "agentId": JUNIT_ORACLE, "codec": "junit",
            "stack": "rust", "data": [Path(reports[0]).read_text()]})
        self.assertTrue(filed.get("ok"), f"the board decoded the JUnit report: {filed!r}")
        return self.board.event(filed["event"])

    def test_the_stored_record_equals_the_boards_junit_decoding_of_the_same_runs_report(self):
        for label in AC1_RUNS:
            with self.subTest(verb=label):
                run = self.runs[label]
                streamed = self.stored(run)
                junit = self.junit_record(run)
                ran = [row for row in _rows(streamed.get("tree")) if row[2] != "pending"]
                pending = [row for row in _rows(streamed.get("tree")) if row[2] == "pending"]
                self.assertEqual(ran, _rows(junit.get("tree")),
                                 "the same suites, tests, statuses and failure messages")
                self.assertEqual(sorted({r[0] for r in _rows(streamed.get("tree"))}),
                                 sorted({r[0] for r in _rows(junit.get("tree"))}),
                                 "the same suites")
                self.assertEqual(len(pending), next(e for lbl, _a, e in RUNS
                                                    if lbl == label)["pending"],
                                 "each ignored test is a pending leaf JUnit does not have")
                for key in ("passed", "failed"):
                    self.assertEqual((streamed.get("summary") or {}).get(key),
                                     (junit.get("summary") or {}).get(key), key)

    def test_no_verb_posts_a_junit_ingest(self):
        for label, _argv, _expected in RUNS:
            with self.subTest(run=label):
                run = self.runs[label]
                junit = [r["path"] for r in run.records if r["method"] == "POST"
                         and (r["body"] or {}).get("codec") == "junit"]
                self.assertEqual(junit, [], f"no POST carries codec junit; {run.label}")

    def test_an_auto_ingest_straight_after_a_streamed_run_files_nothing(self):
        run = _MODULE.get("auto_ingest")
        if not isinstance(run, _Run):
            self.fail("auto-ingest was never driven")
        filed = [r["path"] for r in run.records if r["method"] == "POST"
                 and r["path"] in ("/api/v2/runs", "/api/v2/runs/parsed", "/api/v2/runs/start")]
        self.assertEqual(filed, [], run.where())
        self.assertEqual(self.board.test_events(run.agent), [], run.where())
        self.assertEqual(len(self.board.test_events(self.runs["test"].agent)), 1,
                         "the streamed run stays the one stored record")


if __name__ == "__main__":
    unittest.main()
