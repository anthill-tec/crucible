"""Shared fixtures for the go client's gate and `regression` over declared tiers.

A Go project declares a tier with a build tag. When a module declares one, the
go gate's declared suites are `untagged` (the untagged `go test -json ./...` of
every module, which is the gate's whole run, filed under `regression`) and one
suite per declared tier, each run as a suite of its own, under its own tier,
holding only that tier's tests; `e2e` is listed and excluded. `regression` is
ONE run under `regression` holding the untagged tests and then every declared
tier's tests, and with `--coverage` it sends ONE `go-coverprofile` text, the
block-wise union of every invocation's profile.

These helpers drive the REAL go client, the real `go` behind the recording
shim of `go_client_harness`, against `GoGateBoard`: a `RecordingBoard` whose
health states that it records a gate's scope and suites and decodes
`go-coverprofile`, and whose close answer counts the run from the go-test
stream it holds for that run, so each of the gate's runs has counts of its
own.

Not a test module: it holds no `TestCase`.
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from tests.client.go_client_harness import (
    PROJECT_KEY,
    RUNS,
    START,
    TIMEOUT,
    GoProject,
    copy_fixture,
    go_events,
    toolchain_env,
)
from tests.client.live_run_harness import RecordingBoard, install_project, load_client

AXI = load_client("_crucible_axi.py")
MILESTONES = "/api/v2/milestones"
GATE_VERB = "pre-merge-gate"
COVERAGE_CODEC = "go-coverprofile"
#: How the shared composition names the row the whole go run covers.
WHOLE_GO_SUITE = AXI.whole_suite_label("go")
#: The reason every stack's gate lists `e2e` excluded.
E2E_EXCLUDED = AXI.GATE_UNCOVERED_TIERS["e2e"]
GO_CLIENT_FILE = "go-crucible.py"

#: The `tiers` fixture's package, and the tests the gate fixture adds to it.
TIERS_PKG = "example.com/tiers/tiers"
BDD_TEST = "TestBdd"
E2E_TEST = "TestE2e"
_BDD_FILE = ("//go:build bdd\n\npackage tiers\n\nimport \"testing\"\n\n"
             "func TestBdd(t *testing.T) {\n\tif Answer() != 42 {\n"
             "\t\tt.Fatal(\"bdd\")\n\t}\n}\n")
_E2E_FILE = ("//go:build e2e\n\npackage tiers\n\nimport \"testing\"\n\n"
             "func TestE2e(t *testing.T) {\n\tif Answer() != 42 {\n"
             "\t\tt.Fatal(\"e2e\")\n\t}\n}\n")
_FAILING_INTEG_FILE = ("//go:build integration\n\npackage tiers\n\n"
                       "import \"testing\"\n\nfunc TestInteg(t *testing.T) {\n"
                       "\tt.Fatal(\"the integration fixture fails\")\n}\n")

#: The `tier-coverage` fixture: one package whose untagged test and whose
#: `integration` test cover different statements.
COVERAGE_FIXTURE = "tier-coverage"
COVERAGE_PKG = "example.com/tiercov/cov"
COVERAGE_INTEG_TEST = "TestIntegCov"


class GoGateBoard(RecordingBoard):
    """A `RecordingBoard` whose health states `milestones.gate` (scope and
    suites) and lists `go-coverprofile`, and whose `/api/v2/runs` close is
    answered with an event id of its own and the counts of the go-test stream
    it holds for the closed run: the top-level tests' terminal events, so
    each run of a composed gate reports what it ran."""

    def __init__(self, **options):
        super().__init__(**options)
        with self._lock:
            health = self._health_answer()
        health["milestones"] = {"gate": ["scope", "suites"]}
        health["codecs"]["coverage"] = [*health["codecs"]["coverage"], COVERAGE_CODEC]
        self.script_health(health)
        board = self
        server: Any = self._httpd
        base: Any = server.RequestHandlerClass
        self._event_seq = 0

        class _Counting(base):
            def do_POST(self):
                if self.path != RUNS:
                    base.do_POST(self)
                    return
                body = self._body()
                with board._lock:
                    board.events.append((time.time(), "POST", self.path, body))
                    board._event_seq += 1
                    event = board._event_seq
                self._reply({"ok": True, "changed": True, "event": event,
                             "run": board.counts_of(body)})

        server.RequestHandlerClass = _Counting

    def counts_of(self, body):
        run_id = str((body or {}).get("runId")) if isinstance(body, dict) else ""
        statuses = [event["Action"] for event in go_events(self.held_stream(run_id))
                    if event.get("Action") in ("pass", "fail", "skip")
                    and event.get("Test") and "/" not in event["Test"]]
        passed, failed = statuses.count("pass"), statuses.count("fail")
        pending = statuses.count("skip")
        return {"passed": passed, "failed": failed, "pending": pending,
                "total": passed + failed + pending}


def gate_project(case, fixture="tiers"):
    """A scratch copy of `tests/fixtures/go-client/<fixture>` on its own
    `GoGateBoard`, the recording `go` shim first on PATH."""
    p = GoProject(case, fixture=fixture)
    p.board.close()
    p.board = GoGateBoard()
    case.addCleanup(p.board.close)
    install_project(p.dir, p.board.url, PROJECT_KEY)
    return p


def declare_bdd_and_e2e(p):
    """The `tiers` module plus a `bdd` tag and an `e2e` tag: `TestBdd` and
    `TestE2e`, each in a file of its own tag."""
    package = Path(p.dir, "tiers")
    (package / "bdd_test.go").write_text(_BDD_FILE, encoding="utf-8")
    (package / "e2e_test.go").write_text(_E2E_FILE, encoding="utf-8")


def fail_the_integration_test(p):
    """Rewrite the `integration` file so its `TestInteg` fails."""
    Path(p.dir, "tiers", "integ_test.go").write_text(_FAILING_INTEG_FILE,
                                                     encoding="utf-8")


def declare_no_tier(p):
    """Remove the `integration` file, so the module declares no tier: the
    `!integration` file alone adds no test under any tag."""
    Path(p.dir, "tiers", "integ_test.go").unlink()


def opened_runs(p):
    """`[(run id, start body)]` in opening order: the board numbers the runs
    it opens `run-live-1`, `run-live-2`, ..."""
    return [(f"run-live-{index}", body)
            for index, body in enumerate(
                (b for path, b in p.posts() if path == START), start=1)]


def runs_by_tier(p):
    """`{start tier: [run id, ...]}` of every run opened."""
    by_tier: dict = {}
    for run_id, body in opened_runs(p):
        by_tier.setdefault(body.get("tier"), []).append(run_id)
    return by_tier


def closes_by_run(p):
    """`{run id: [close body, ...]}` of every `/api/v2/runs` close."""
    by_run = {}
    for path, body in p.posts():
        if path == RUNS and isinstance(body, dict):
            by_run.setdefault(body.get("runId"), []).append(body)
    return by_run


def held_tests(p, run_id):
    """`(Package, Test, Action)` of each top-level terminal test event the
    board holds for `run_id`, in order."""
    return [(e.get("Package"), e["Test"], e["Action"])
            for e in go_events(p.board.held_stream(run_id))
            if e.get("Action") in ("pass", "fail", "skip")
            and e.get("Test") and "/" not in e["Test"]]


def gate_milestones(p):
    return [b for path, b in p.posts()
            if path == MILESTONES and isinstance(b, dict) and b.get("type") == GATE_VERB]


def rows_by_suite(axi):
    """The envelope's `suites[]` rows, keyed by `suite`."""
    rows = (axi or {}).get("suites")
    return {str(row.get("suite")): row for row in rows or [] if isinstance(row, dict)}


def entries_by_target(milestone):
    return {str(entry.get("target")): entry
            for entry in (milestone or {}).get("suites") or []
            if isinstance(entry, dict)}


def profile_blocks(text):
    """`{block: (statements, covered)}` of one coverprofile text: each block
    `file:start,end`, covered when its count is not zero."""
    blocks = {}
    for line in (text or "").splitlines()[1:]:
        if not line.strip():
            continue
        key, statements, count = line.rsplit(" ", 2)
        weight, hit = blocks.get(key, (int(statements), False))
        blocks[key] = (weight, hit or int(count) > 0)
    return blocks


def union_blocks(texts):
    """The block-wise union of several coverprofile texts: a block covered
    when any text covered it."""
    union = {}
    for text in texts:
        for key, (weight, hit) in profile_blocks(text).items():
            known = union.get(key, (weight, False))
            union[key] = (weight, known[1] or hit)
    return union


def statements(blocks):
    """`(total, covered)` statements of `{block: (statements, covered)}`."""
    return (sum(weight for weight, _hit in blocks.values()),
            sum(weight for weight, hit in blocks.values() if hit))


def oracle_profiles(scratch):
    """The two profiles of the coverage fixture, written by the real `go` in
    a copy of it under `scratch`: the untagged `./...` and the `integration`
    invocation of its one tier test. Answers `(untagged, integration)`."""
    module = copy_fixture(COVERAGE_FIXTURE, os.path.join(scratch, "oracle"))
    go = shutil.which("go")
    if go is None:
        raise AssertionError("go is not on PATH")
    untagged = os.path.join(scratch, "untagged.out")
    tagged = os.path.join(scratch, "integration.out")
    for argv in (["test", f"-coverprofile={untagged}", "./..."],
                 ["test", "-tags", "integration", "-run", f"^({COVERAGE_INTEG_TEST})$",
                  f"-coverprofile={tagged}", COVERAGE_PKG]):
        ran = subprocess.run([go, *argv], cwd=module, env=toolchain_env(),
                             capture_output=True, text=True, check=False,
                             timeout=TIMEOUT)
        if ran.returncode != 0:
            raise AssertionError(f"oracle `go {' '.join(argv)}` failed: "
                                 f"{ran.stdout[-800:]} {ran.stderr[-800:]}")
    return (Path(untagged).read_text(encoding="utf-8"),
            Path(tagged).read_text(encoding="utf-8"))


def describe(p, result):
    return (f"starts={json.dumps([b for _r, b in opened_runs(p)])[:1200]} "
            f"go calls={[c['argv'][:7] for c in p.calls()]!r} "
            f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
            f"stderr={result.stderr[-1200:]!r}")


__all__ = [
    "AXI", "BDD_TEST", "COVERAGE_CODEC", "COVERAGE_FIXTURE", "COVERAGE_INTEG_TEST",
    "COVERAGE_PKG", "E2E_EXCLUDED", "E2E_TEST", "GATE_VERB", "GO_CLIENT_FILE",
    "GoGateBoard", "MILESTONES", "TIERS_PKG", "WHOLE_GO_SUITE", "closes_by_run",
    "declare_bdd_and_e2e", "declare_no_tier", "describe", "entries_by_target",
    "fail_the_integration_test", "gate_milestones", "gate_project", "held_tests",
    "opened_runs", "oracle_profiles", "profile_blocks", "rows_by_suite",
    "runs_by_tier", "statements", "union_blocks",
]
