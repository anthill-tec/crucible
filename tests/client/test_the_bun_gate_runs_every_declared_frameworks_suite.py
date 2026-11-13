"""The bun client's `pre-merge-gate` runs every declared framework's suite.

A bun project's `test:` scripts each carry a framework: the one its
`crucible.targets` entry names, else `bun-test`. The gate covers a `bun-test`
target by its whole-suite `bun test` run, as before. A target of any other
framework (Vitest here) is run by the gate as a suite of its own, in the gate's
own process, through the client's own declared-script run: never dispatched to
a sibling client, never reported covered by a run that did not collect it.

What is pinned:
- the Vitest target is run once, by its own script, with the gate's reports
  dir, and is never dispatched;
- its `suites[]` row carries its own counts and outcome and `client` naming
  the bun client, and no `coveredBy`; its counts are in the gate's totals;
- its run is filed under the tier its name names, else `regression`;
- a passing Vitest suite leaves the gate ok, a failing one makes it not ok;
- the `bun-test` target's row is still `coveredBy` the whole-suite run;
- a project whose own-stack targets are all non-`bun-test` skips the
  whole-suite `bun test`, and the envelope says so;
- a package that declares no bun suite at all (its one `test:` script is
  python-owned) still runs the whole-suite `bun test`;
- an excluded `bun-test` suite counts: a Vitest `test:unit` beside a
  `bun-test` `test:e2e` runs the whole-suite `bun test` AND the Vitest suite;
- a non-`bun-test` table entry whose key is not a `test:` script is refused by
  the gate, naming the entry; so is one keyed `test:` with no script of that
  name in `scripts`;
- `--suites <vitest target>` runs only that target; `--suites <bun-test
  target>` runs the whole suite and no Vitest suite;
- the Vitest suite's run requests no coverage and adds no
  `coverage-not-measured` warning, while the whole-suite run keeps its
  coverage;
- on a project that marks an entry `"test": true`, the gate's whole-suite
  run is that marked script, run once, and never `bun test`; every other
  declared suite runs as a suite of its own;
- a marker `test` refuses (two marked entries; a marker that is not `true`)
  refuses the gate before its tsc step: a non-zero exit, ONE `target-refused`
  envelope under `pre-merge-gate`, nothing spawned and nothing posted.

Every test drives the REAL `clients/bun-crucible.py` as an OS subprocess
(`TargetsCase`, tests/client/bun_targets_harness.py) with a fake `bun` that
answers both the whole-suite `bun test` and `bun run <script>`, against
`DecodingBoard`: the harness's `TargetsBoard`, answering each run's ingest
with the counts of the report it was sent, so each suite's counts are its own.

Interface choices (the spec leaves these open; GREEN is asked to use them):
- The skipped whole-suite run is said in the gate's envelope (any field or
  warning): the envelope's text names it as skipped (`skipped`, beside `bun
  test` or `whole bun suite`).
- The gate's refusal of an off-template entry is an `ok: false` envelope on
  stdout naming the entry's key; nothing runs.

TIER: integration (a TCP listener and spawned client processes).
"""

import json
import re
import shutil
import sys
import time
import unittest
from typing import Any

from tests.client.bun_targets_harness import (
    JUNIT_VAR,
    STREAM_PATH_DECLARATION,
    TABLE,
    TargetsBoard,
    TargetsCase,
)
from tests.client.live_run_harness import STREAM_CODEC

GATE = "pre-merge-gate"
RUNS = "/api/v2/runs"
BUN_CLIENT_NAME = "bun-crucible.py"
WHOLE_SUITE_LABEL = "the whole bun suite this gate ran"
COVERAGE_NOT_MEASURED = "coverage-not-measured"
SUITE_FAILED = "gate-suite-failed"

BUN_TARGET = "test:client"
VITEST_TARGET = "test:vitest"
VITEST_UNIT_TARGET = "test:unit"

# What the fake `bun` reports: the whole-suite `bun test` collects three
# cases, every `bun run <script>` two, so each suite's counts are its own.
WHOLE_SUITE_CASES = 3
SCRIPT_CASES = 2

VITEST_JUNIT_ENV_ENTRY = {"framework": "vitest", "junit": f"env:{JUNIT_VAR}"}
VITEST_JUNIT_FLAG_ENTRY = {"framework": "vitest", "junit": "flag"}
VITEST_STREAM_ENTRY = {"framework": "vitest",
                       "stream": {"codec": STREAM_CODEC,
                                  "path": STREAM_PATH_DECLARATION}}
BUN_TEST_ENTRY = {"framework": "bun-test", "junit": "flag"}

# A stand-in `bun`. It records every spawn (argv and the report variables it
# was handed), then answers:
# - `x tsc`: a clean typecheck;
# - `bun test ...` (the whole suite): WHOLE cases;
# - `bun run <script> ...`: SCRIPT cases;
# a run named in FAKE_FAILING (the script name, or `bun test` for the whole
# suite) fails its last case and exits 1. It writes a JUnit report to
# `--reporter-outfile=` or FIXTURE_JUNIT_PATH, a crucible-events stream to
# CRUCIBLE_STREAM, and an lcov report under `--coverage-dir=`.
FAKE_GATE_BUN = r'''
import json
import os
import sys

WATCHED = ("CRUCIBLE_STREAM", "FIXTURE_JUNIT_PATH")
argv = sys.argv[1:]
log = os.environ.get("FAKE_SPAWN_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": argv,
                                 "env": {k: os.environ.get(k) for k in WATCHED}}) + "\n")

if argv[:2] == ["x", "tsc"]:
    sys.exit(0)

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

if argv[:1] == ["run"]:
    name, cases = argv[1], int(os.environ.get("FAKE_SCRIPT_CASES", "2"))
else:
    name, cases = "bun test", int(os.environ.get("FAKE_WHOLE_CASES", "3"))
failing = name in os.environ.get("FAKE_FAILING", "").split(",")
slug = name.replace(":", "_").replace(" ", "_")
statuses = ["pass"] * cases
if failing:
    statuses[-1] = "fail"
print("%s.test.ts:" % slug)
for i, status in enumerate(statuses, 1):
    print("(%s) %s > case_%d [0.01ms]" % (status, slug, i))
sys.stdout.flush()

stream = os.environ.get("CRUCIBLE_STREAM")
if stream:
    events = [{"event": "run-start", "total": cases}]
    events += [{"event": "test-end", "id": "%s.test.ts#case_%d" % (slug, i),
                "name": "case_%d" % i, "suite": slug, "file": "%s.test.ts" % slug,
                "status": status, "duration_ms": 1}
               for i, status in enumerate(statuses, 1)]
    events.append({"event": "run-end", "total": cases,
                   "passed": statuses.count("pass"),
                   "failed": statuses.count("fail"), "pending": 0,
                   "duration_ms": 3})
    write(stream, "".join(json.dumps(event) + "\n" for event in events))

junit = os.environ.get("FIXTURE_JUNIT_PATH")
coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
if junit:
    cases_xml = "".join(
        '<testcase name="case_%d" classname="%s" file="%s.test.ts" time="0.001">%s'
        '</testcase>' % (i, slug, slug,
                         '<failure message="planted">planted</failure>'
                         if status == "fail" else "")
        for i, status in enumerate(statuses, 1))
    write(junit, '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>'
                 '<testsuite name="%s.test.ts" tests="%d" failures="%d">%s'
                 '</testsuite></testsuites>\n'
                 % (slug, cases, statuses.count("fail"), cases_xml))
if coverage_dir:
    write(os.path.join(coverage_dir, "lcov.info"), os.environ["FAKE_LCOV"])
sys.exit(1 if failing else 0)
'''

PYTHON_TARGET = "test:client"
PYTHON_CLIENT_SPAWN = "python-crucible.py"
PYTHON_SUITE_CASES = 1

# A stand-in python client, named as the real one so a script invoking it is
# python-owned and dispatched to it as declared. It records its spawn (its
# argv headed by its own name) and prints a passing `regression` envelope.
FAKE_PYTHON_CLIENT = r'''
import json
import os
import sys

log = os.environ.get("FAKE_SPAWN_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": ["python-crucible.py"] + sys.argv[1:],
                                 "env": {}}) + "\n")
print("axi:\n  verb: regression\n  ok: true\n  run:\n    passed: 1\n"
      "    failed: 0\n    pending: 0\n    total: 1")
sys.exit(0)
'''

_TESTCASE = re.compile(r"<testcase\b")
_FAILURE = re.compile(r"<failure\b")


class DecodingBoard(TargetsBoard):
    """`TargetsBoard` whose `/api/v2/runs` answers each run with the counts of
    what it was sent: a JUnit ingest by its `<testcase>`/`<failure>` elements,
    a stream close by the stream it holds for the run. Its health states that
    it records a gate's scope and suites (`milestones.gate`)."""

    def __init__(self, **options):
        super().__init__(**options)
        # `TargetsBoard`'s own scripted health (its `codecs` lists), plus the
        # gate record.
        with self._lock:
            health = self._health_answer()
        health["milestones"] = {"gate": ["scope", "suites"]}
        self.script_health(health)
        board = self
        server: Any = self._httpd
        base: Any = server.RequestHandlerClass
        self._event_seq = 0

        class _Decoding(base):
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

        server.RequestHandlerClass = _Decoding

    def counts_of(self, body):
        body = body if isinstance(body, dict) else {}
        data = body.get("data")
        if isinstance(data, list) and data:
            text = "".join(part for part in data if isinstance(part, str))
            total, failed = len(_TESTCASE.findall(text)), len(_FAILURE.findall(text))
        else:
            statuses = []
            for line in self.held_stream(str(body.get("runId"))).splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and event.get("event") == "test-end":
                    statuses.append(event.get("status"))
            total, failed = len(statuses), statuses.count("fail")
        return {"passed": total - failed, "failed": failed, "pending": 0,
                "total": total}


class _GateFrameworksCase(TargetsCase):
    """A scratch bun package driven through `pre-merge-gate` with the fake
    `bun` above, against a `DecodingBoard`."""

    def setUp(self):
        super().setUp()
        self.fake.write_text(f"#!{sys.executable}\n" + FAKE_GATE_BUN, encoding="utf-8")
        self.use_board(DecodingBoard())

    # ── fixtures ────────────────────────────────────────────────────────────

    def declare_bun_and_vitest(self, vitest_entry=None, vitest_target=VITEST_TARGET,
                               bun_entry=None):
        """`test:client` (a `bun-test` target) beside a Vitest target."""
        targets = {vitest_target: dict(vitest_entry or VITEST_JUNIT_ENV_ENTRY)}
        if bun_entry is not None:
            targets[BUN_TARGET] = dict(bun_entry)
        self.declare({BUN_TARGET: "bun test tests", vitest_target: "vitest run"},
                     {"targets": targets})

    # ── drive ───────────────────────────────────────────────────────────────

    def gate(self, *flags, **fake):
        return self.drive(GATE, "--skip-check", *flags, **fake)

    def scoped_gate(self, *suites, **fake):
        return self.gate("--suites", ",".join(suites), "--cycle", "7", **fake)

    def forget(self):
        """Forget every spawn and request so far, for a second drive."""
        self.spawn_log.unlink(missing_ok=True)
        with self.board._lock:
            self.board.events.clear()
        shutil.rmtree(self.reports, ignore_errors=True)

    # ── reading ─────────────────────────────────────────────────────────────

    def script_spawns(self, script):
        return [s for s in self.spawns() if s.get("argv", [])[:2] == ["run", script]]

    def whole_suite_spawns(self):
        return [s for s in self.spawns() if s.get("argv", [])[:1] == ["test"]]

    def python_client_spawns(self):
        return [s for s in self.spawns()
                if s.get("argv", [])[:1] == [PYTHON_CLIENT_SPAWN]]

    def ingests(self):
        return [b for b in self.posts_to(RUNS) if isinstance(b, dict)]

    def ingests_of(self, framework):
        return [b for b in self.ingests() if b.get("framework") == framework]

    def rows(self, drive):
        suites = self.envelope(drive).get("suites")
        return suites if isinstance(suites, list) else []

    def row(self, drive, suite):
        found = [r for r in self.rows(drive) if isinstance(r, dict) and r.get("suite") == suite]
        self.assertEqual(len(found), 1,
                         f"exactly one suites[] row for {suite!r}; rows={self.rows(drive)!r}; "
                         f"{drive.diag()}")
        return found[0] if found else {}

    def warnings(self, drive):
        warnings = self.envelope(drive).get("warnings")
        return [w for w in warnings or [] if isinstance(w, dict)]

    def assert_ran_once_by_its_own_script(self, drive, script):
        spawns = self.script_spawns(script)
        self.assertEqual(len(spawns), 1,
                         f"the gate runs `{script}` exactly once, by its own script; "
                         f"spawns={self.spawns()!r}; {drive.diag()}")


# ── AC3: the gate runs a Vitest target as its own suite ─────────────────────

class TheGateRunsAVitestTargetAsItsOwnSuiteTest(_GateFrameworksCase):
    """`test:client` (bun-test) beside `test:vitest` (Vitest), gated in full."""

    def setUp(self):
        super().setUp()
        self.declare_bun_and_vitest()

    def test_the_vitest_target_runs_once_in_the_gates_process_and_is_never_dispatched(self):
        """The Vitest script is spawned once, by the bun client's own run (the
        gate's reports dir carries its JUnit path), and never dispatched."""
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        spawn = (self.script_spawns(VITEST_TARGET) or [{}])[0]
        junit = (spawn.get("env") or {}).get(JUNIT_VAR) or ""
        self.assertTrue(junit.startswith(str(self.reports)),
                        f"the Vitest run reports into the gate's own reports dir "
                        f"{self.reports}; spawn={spawn!r}")
        self.assertNotIn(f"dispatching `{VITEST_TARGET}`", drive.stderr,
                         f"a Vitest target is never dispatched; {drive.diag()}")
        undispatchable = [w for w in self.warnings(drive)
                          if w.get("code") == "gate-suite-undispatchable"]
        self.assertEqual(undispatchable, [], f"{drive.diag()}")

    def test_the_vitest_row_carries_its_own_counts_outcome_and_the_bun_client(self):
        """The Vitest row is its own run's: 2 passed of 2, `pass`, `client`
        naming the bun client, and no `coveredBy`."""
        drive = self.gate()
        row = self.row(drive, VITEST_TARGET)
        self.assertNotIn("coveredBy", row, f"row={row!r}")
        self.assertEqual(row.get("client"), BUN_CLIENT_NAME, f"row={row!r}")
        self.assertEqual(row.get("stack"), "bun", f"row={row!r}")
        self.assertIs(row.get("gated"), True, f"row={row!r}")
        self.assertEqual((row.get("passed"), row.get("failed"), row.get("total")),
                         (SCRIPT_CASES, 0, SCRIPT_CASES), f"row={row!r}")
        self.assertEqual(row.get("outcome"), "pass", f"row={row!r}")

    def test_the_gate_totals_add_the_vitest_suites_counts_to_the_whole_suites(self):
        """The gate's `run` totals are the whole suite's 3 plus the Vitest
        suite's 2."""
        drive = self.gate()
        run = self.envelope(drive).get("run") or {}
        expected = WHOLE_SUITE_CASES + SCRIPT_CASES
        self.assertEqual((run.get("passed"), run.get("failed"), run.get("total")),
                         (expected, 0, expected), f"run={run!r}; {drive.diag()}")

    def test_the_bun_test_target_is_still_covered_by_the_whole_suite_run_and_the_vitest_one_is_not(self):
        """`test:client` is `coveredBy` the whole-suite run with its counts;
        the whole suite is spawned once, and the Vitest row is not
        `coveredBy` it."""
        drive = self.gate()
        self.assertEqual(len(self.whole_suite_spawns()), 1,
                         f"the whole suite runs once; spawns={self.spawns()!r}")
        bun_row = self.row(drive, BUN_TARGET)
        self.assertEqual(bun_row.get("coveredBy"), WHOLE_SUITE_LABEL, f"row={bun_row!r}")
        self.assertEqual((bun_row.get("passed"), bun_row.get("total")),
                         (WHOLE_SUITE_CASES, WHOLE_SUITE_CASES), f"row={bun_row!r}")
        vitest_row = self.row(drive, VITEST_TARGET)
        self.assertNotIn("coveredBy", vitest_row, f"row={vitest_row!r}")

    def test_a_passing_vitest_suite_leaves_the_gate_ok(self):
        """Both suites pass: the gate exits 0 and is ok, the Vitest suite
        having run."""
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())

    def test_a_failing_vitest_suite_makes_the_gate_not_ok_and_is_named(self):
        """The Vitest suite fails one case: the gate exits non-zero and is not
        ok, the Vitest row is `fail` with 1 failed of 2, a `gate-suite-failed`
        warning names it, and the whole suite's row still passes."""
        drive = self.gate(FAKE_FAILING=VITEST_TARGET)
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), False, drive.diag())
        row = self.row(drive, VITEST_TARGET)
        self.assertEqual((row.get("outcome"), row.get("passed"), row.get("failed")),
                         ("fail", SCRIPT_CASES - 1, 1), f"row={row!r}")
        named = [w for w in self.warnings(drive)
                 if w.get("code") == SUITE_FAILED and VITEST_TARGET in str(w.get("detail"))]
        self.assertEqual(len(named), 1,
                         f"one gate-suite-failed warning names {VITEST_TARGET}; "
                         f"warnings={self.warnings(drive)!r}")
        self.assertEqual(self.row(drive, BUN_TARGET).get("outcome"), "pass", drive.diag())

    def test_an_e2e_target_stays_excluded_whatever_its_framework(self):
        """A Vitest target named `test:e2e` is listed excluded and never run,
        while `test:vitest` runs."""
        self.declare({BUN_TARGET: "bun test tests", VITEST_TARGET: "vitest run",
                      "test:e2e": "vitest run e2e"},
                     {"targets": {VITEST_TARGET: dict(VITEST_JUNIT_ENV_ENTRY),
                                  "test:e2e": dict(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assertEqual(self.script_spawns("test:e2e"), [],
                         f"the e2e target is never run; spawns={self.spawns()!r}")
        row = self.row(drive, "test:e2e")
        self.assertIs(row.get("gated"), False, f"row={row!r}")
        self.assertTrue(row.get("excluded"), f"row={row!r}")


class AVitestSuitesRunIsFiledUnderTheTierItsNameNamesTest(_GateFrameworksCase):
    """The tier a Vitest suite's run is filed under is the tier its name
    names, else `regression`; the whole suite stays `regression`."""

    def filed_tiers(self, drive):
        vitest = self.ingests_of("vitest")
        self.assertEqual(len(vitest), 1,
                         f"exactly one Vitest run is filed; ingests={self.ingests()!r}; "
                         f"{drive.diag()}")
        whole = self.ingests_of("bun-test")
        self.assertEqual(len(whole), 1, f"ingests={self.ingests()!r}")
        return ((vitest or [{}])[0].get("tier"), (whole or [{}])[0].get("tier"))

    def test_a_vitest_target_named_test_unit_is_filed_under_unit(self):
        """`test:unit` (Vitest) is filed under `unit`."""
        self.declare_bun_and_vitest(vitest_target=VITEST_UNIT_TARGET)
        drive = self.gate()
        self.assertEqual(self.filed_tiers(drive), ("unit", "regression"), drive.diag())

    def test_a_vitest_target_naming_no_tier_is_filed_under_regression(self):
        """`test:vitest` names no tier, so its run is filed under
        `regression`."""
        self.declare_bun_and_vitest()
        drive = self.gate()
        self.assertEqual(self.filed_tiers(drive), ("regression", "regression"),
                         drive.diag())


class AProjectWhoseBunTargetsAreAllNonBunTestSkipsTheWholeSuiteTest(_GateFrameworksCase):
    """Two Vitest targets and no `bun-test` one: the whole-suite `bun test`
    is skipped, and the envelope says so."""

    def setUp(self):
        super().setUp()
        self.declare({VITEST_UNIT_TARGET: "vitest run unit", VITEST_TARGET: "vitest run"},
                     {"targets": {VITEST_UNIT_TARGET: dict(VITEST_JUNIT_ENV_ENTRY),
                                  VITEST_TARGET: dict(VITEST_JUNIT_ENV_ENTRY)}})

    def test_the_whole_suite_bun_test_is_not_run_and_each_vitest_target_is(self):
        """No whole-suite spawn; each Vitest script spawned once."""
        drive = self.gate()
        self.assertEqual(self.whole_suite_spawns(), [],
                         f"the whole suite is skipped; spawns={self.spawns()!r}")
        self.assert_ran_once_by_its_own_script(drive, VITEST_UNIT_TARGET)
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)

    def test_the_envelope_says_the_whole_suite_was_skipped_and_the_gate_is_ok(self):
        """The ok envelope names the whole bun suite as skipped."""
        drive = self.gate()
        self.assertEqual(drive.returncode, 0, drive.diag())
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), True, drive.diag())
        said = json.dumps(envelope).lower()
        self.assertIn("skipped", said, f"envelope={envelope!r}")
        self.assertTrue("bun test" in said or "whole bun suite" in said,
                        f"the skip names the whole-suite run; envelope={envelope!r}")

    def test_the_gate_totals_are_the_vitest_suites_alone(self):
        """Totals: 2 + 2, no whole-suite counts."""
        drive = self.gate()
        run = self.envelope(drive).get("run") or {}
        self.assertEqual((run.get("passed"), run.get("total")),
                         (2 * SCRIPT_CASES, 2 * SCRIPT_CASES), f"run={run!r}; {drive.diag()}")


class APackageDeclaringNoBunSuiteStillRunsTheWholeSuiteTest(_GateFrameworksCase):
    """The package's one `test:` script is python-owned (it invokes the
    python client), so it declares no bun suite: the skip needs at least one
    bun suite, and the whole-suite `bun test` runs."""

    def setUp(self):
        super().setUp()
        client = self.scratch / PYTHON_CLIENT_SPAWN
        client.write_text(FAKE_PYTHON_CLIENT, encoding="utf-8")
        self.declare({PYTHON_TARGET: f"{sys.executable} {client} regression"})

    def test_the_whole_suite_bun_test_runs_beside_the_dispatched_python_suite(self):
        """The whole suite is spawned once, the python suite is dispatched
        once to the python client, the envelope says no skip, and the gate
        is ok with both runs' counts."""
        drive = self.gate()
        self.assertEqual(len(self.whole_suite_spawns()), 1,
                         f"the whole bun suite runs; spawns={self.spawns()!r}; "
                         f"{drive.diag()}")
        self.assertEqual(len(self.python_client_spawns()), 1,
                         f"the python suite is dispatched once; "
                         f"spawns={self.spawns()!r}; {drive.diag()}")
        envelope = self.envelope(drive)
        self.assertNotIn("wholeSuite", envelope, f"envelope={envelope!r}")
        self.assertEqual(self.row(drive, PYTHON_TARGET).get("stack"), "python",
                         drive.diag())
        run = envelope.get("run") or {}
        expected = WHOLE_SUITE_CASES + PYTHON_SUITE_CASES
        self.assertEqual((run.get("passed"), run.get("total")), (expected, expected),
                         f"run={run!r}; {drive.diag()}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(envelope.get("ok"), True, drive.diag())


class AnExcludedBunTestSuiteKeepsTheWholeSuiteRunningTest(_GateFrameworksCase):
    """A Vitest `test:unit` beside a `bun-test` `test:e2e`: the excluded e2e
    suite is a declared bun suite under `bun-test`, so the whole-suite
    `bun test` runs, and the Vitest suite runs as its own suite."""

    def setUp(self):
        super().setUp()
        self.declare({VITEST_UNIT_TARGET: "vitest run", "test:e2e": "bun test e2e"},
                     {"targets": {VITEST_UNIT_TARGET: dict(VITEST_JUNIT_ENV_ENTRY),
                                  "test:e2e": dict(BUN_TEST_ENTRY)}})

    def test_the_whole_suite_runs_and_the_vitest_suite_runs_as_its_own(self):
        """The whole suite is spawned once and the envelope says no skip; the
        Vitest script runs once, its row its own (no `coveredBy`, its own
        counts); the e2e target is never run and is listed excluded."""
        drive = self.gate()
        self.assertEqual(len(self.whole_suite_spawns()), 1,
                         f"the whole bun suite runs; spawns={self.spawns()!r}; "
                         f"{drive.diag()}")
        envelope = self.envelope(drive)
        self.assertNotIn("wholeSuite", envelope, f"envelope={envelope!r}")
        self.assert_ran_once_by_its_own_script(drive, VITEST_UNIT_TARGET)
        row = self.row(drive, VITEST_UNIT_TARGET)
        self.assertNotIn("coveredBy", row, f"row={row!r}")
        self.assertEqual((row.get("passed"), row.get("total"), row.get("outcome")),
                         (SCRIPT_CASES, SCRIPT_CASES, "pass"), f"row={row!r}")
        self.assertEqual(self.script_spawns("test:e2e"), [],
                         f"the e2e target is never run; spawns={self.spawns()!r}")
        self.assertIs(self.row(drive, "test:e2e").get("gated"), False, drive.diag())
        run = envelope.get("run") or {}
        expected = WHOLE_SUITE_CASES + SCRIPT_CASES
        self.assertEqual((run.get("passed"), run.get("total")), (expected, expected),
                         f"run={run!r}; {drive.diag()}")
        self.assertIs(envelope.get("ok"), True, drive.diag())


class ANonBunTestEntryThatIsNotATestScriptIsRefusedByTheGateTest(_GateFrameworksCase):

    def test_the_gate_refuses_naming_the_entry_and_runs_nothing(self):
        """A Vitest entry keyed `e2e:browser` (not a `test:` script): the gate
        exits non-zero with an `ok: false` envelope naming `e2e:browser`, and
        no suite runs or is filed."""
        self.declare({BUN_TARGET: "bun test tests", "e2e:browser": "vitest run browser"},
                     {"targets": {"e2e:browser": dict(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("e2e:browser", json.dumps(envelope), f"envelope={envelope!r}")
        self.assertEqual(self.spawns(), [],
                         f"a refused gate runs no suite; spawns={self.spawns()!r}")
        self.assertEqual(self.ingests(), [], f"a refused gate files no run; {drive.diag()}")

    def test_a_test_keyed_entry_with_no_script_is_refused_naming_it(self):
        """A Vitest entry keyed `test:browser` with no `test:browser` script:
        the gate enumerates scripts, so it could not see the entry. The gate
        exits non-zero with an `ok: false` envelope naming `test:browser`,
        and no suite runs or is filed."""
        self.declare({BUN_TARGET: "bun test tests"},
                     {"targets": {"test:browser": dict(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("test:browser", json.dumps(envelope), f"envelope={envelope!r}")
        self.assertEqual(self.spawns(), [],
                         f"a refused gate runs no suite; spawns={self.spawns()!r}")
        self.assertEqual(self.ingests(), [], f"a refused gate files no run; {drive.diag()}")


# ── AC4: scoping and coverage ───────────────────────────────────────────────

class AGateScopedByFrameworkRunsOnlyWhatItNamesTest(_GateFrameworksCase):

    def setUp(self):
        super().setUp()
        self.declare_bun_and_vitest()

    def test_naming_the_vitest_target_runs_only_that_target(self):
        """`--suites test:vitest`: the Vitest script runs once, the whole suite
        never, and the only row is the Vitest one."""
        drive = self.scoped_gate(VITEST_TARGET)
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assertEqual(self.whole_suite_spawns(), [],
                         f"the whole suite is not run; spawns={self.spawns()!r}")
        self.assertEqual([r.get("suite") for r in self.rows(drive)], [VITEST_TARGET],
                         drive.diag())
        self.assertEqual(self.envelope(drive).get("scope"), "scoped", drive.diag())

    def test_naming_the_bun_test_target_runs_the_whole_suite_and_no_vitest_suite(self):
        """`--suites test:client`: the whole suite runs once, the Vitest
        script never, and the only row is `test:client`, covered by it."""
        drive = self.scoped_gate(BUN_TARGET)
        self.assertEqual(len(self.whole_suite_spawns()), 1,
                         f"spawns={self.spawns()!r}; {drive.diag()}")
        self.assertEqual(self.script_spawns(VITEST_TARGET), [],
                         f"no Vitest suite runs; spawns={self.spawns()!r}")
        self.assertEqual([r.get("suite") for r in self.rows(drive)], [BUN_TARGET],
                         drive.diag())
        self.assertEqual(self.row(drive, BUN_TARGET).get("coveredBy"), WHOLE_SUITE_LABEL)


class TheGateRequestsNoCoverageForAVitestSuiteTest(_GateFrameworksCase):

    def assert_no_coverage_not_measured_warning(self, drive):
        named = [w for w in self.warnings(drive) if w.get("code") == COVERAGE_NOT_MEASURED]
        self.assertEqual(named, [],
                         f"no coverage-not-measured warning; warnings={self.warnings(drive)!r}")

    def test_a_flag_reporting_vitest_target_is_handed_no_coverage_flags(self):
        """Under `junit: flag` a coverage request would ride the argv: the
        Vitest spawn carries no `--coverage*`, the whole suite's still does."""
        self.declare_bun_and_vitest(VITEST_JUNIT_FLAG_ENTRY)
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        argv = (self.script_spawns(VITEST_TARGET) or [{}])[0].get("argv") or []
        self.assertEqual([a for a in argv if a.startswith("--coverage")], [],
                         f"argv={argv!r}")
        whole = (self.whole_suite_spawns() or [{}])[0].get("argv") or []
        self.assertIn("--coverage", whole, f"the whole suite keeps its coverage; argv={whole!r}")

    def test_the_vitest_suites_filed_run_carries_no_coverage(self):
        """The Vitest ingest has no `coverage`; the whole suite's has lcov."""
        self.declare_bun_and_vitest(VITEST_JUNIT_FLAG_ENTRY)
        drive = self.gate()
        vitest = self.ingests_of("vitest")
        self.assertEqual(len(vitest), 1, f"ingests={self.ingests()!r}; {drive.diag()}")
        self.assertNotIn("coverage", (vitest or [{}])[0], f"ingest={vitest!r}")
        whole = self.ingests_of("bun-test")
        self.assertEqual(((whole or [{}])[0].get("coverage") or {}).get("codec"), "lcov",
                         f"ingests={self.ingests()!r}")

    def test_an_env_reporting_vitest_target_adds_no_coverage_not_measured_warning(self):
        """Under `junit: env:<VAR>` the Vitest suite runs and the gate carries
        no `coverage-not-measured` warning."""
        self.declare_bun_and_vitest(VITEST_JUNIT_ENV_ENTRY)
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assert_no_coverage_not_measured_warning(drive)

    def test_a_streaming_vitest_target_adds_no_coverage_not_measured_warning(self):
        """A `stream` Vitest entry runs, is filed with its own counts, and the
        gate carries no `coverage-not-measured` warning."""
        self.declare_bun_and_vitest(VITEST_STREAM_ENTRY)
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        row = self.row(drive, VITEST_TARGET)
        self.assertEqual((row.get("passed"), row.get("total")), (SCRIPT_CASES, SCRIPT_CASES),
                         f"row={row!r}; {drive.diag()}")
        self.assert_no_coverage_not_measured_warning(drive)


# ── the gate reads the `test` marker ────────────────────────────────────────

TARGET_REFUSED = "target-refused"


def assert_gate_refused_before_its_tsc_step(case, drive, *named):
    """A gate refused on its `crucible.targets` before its tsc step: a
    non-zero exit, nothing posted, nothing spawned (the tsc step included),
    and ONE `ok: false` envelope under `pre-merge-gate` carrying exactly one
    `target-refused` warning whose detail names each of `named`. Returns that
    detail."""
    case.assertNotEqual(drive.returncode, 0, f"a refused gate exits non-zero; {drive.diag()}")
    case.assertEqual(case.spawns(), [],
                     f"the refusal comes before the tsc step, so nothing is spawned; "
                     f"{drive.diag()}")
    case.assertEqual(case.board.posts(), [],
                     f"a refused gate posts nothing; {drive.diag()}")
    envelope = case.envelope(drive)
    case.assertEqual((envelope.get("verb"), envelope.get("ok")), (GATE, False),
                     f"the refusal is the gate's own ok:false envelope; envelope={envelope!r}")
    refused = [w for w in envelope.get("warnings") or []
               if isinstance(w, dict) and w.get("code") == TARGET_REFUSED]
    case.assertEqual(len(refused), 1,
                     f"exactly one {TARGET_REFUSED} warning; envelope={envelope!r}")
    detail = str((refused or [{}])[0].get("detail"))
    for name in named:
        case.assertIn(name, detail, f"the refusal names {name!r}; detail={detail!r}")
    return detail


def assert_gate_refused_with_tests_detail(case, drive, *named):
    """A gate refused on its marker before its tsc step (as above), whose
    `target-refused` detail EQUALS the one `test` gives for the same
    package."""
    gate_detail = assert_gate_refused_before_its_tsc_step(case, drive, *named)
    test_drive = case.drive("test")
    case.assertNotEqual(test_drive.returncode, 0, test_drive.diag())
    envelope = case.envelope(test_drive)
    case.assertEqual((envelope.get("verb"), envelope.get("ok")), ("test", False),
                     f"envelope={envelope!r}")
    refused = [w.get("detail") for w in envelope.get("warnings") or []
               if isinstance(w, dict) and w.get("code") == TARGET_REFUSED]
    case.assertEqual(len(refused), 1,
                     f"`test` gives one {TARGET_REFUSED} warning; envelope={envelope!r}")
    case.assertEqual(gate_detail, (refused or [None])[0],
                     f"the gate refuses with test's detail for the same package; "
                     f"gate={drive.diag()} test={test_drive.diag()}")


class TheGateRunsTheMarkedEntryAndRefusesABadMarkerTest(_GateFrameworksCase):

    def test_a_marked_vitest_entry_is_the_whole_suite_run_and_the_bun_test_target_runs_on_its_own(self):
        """`test:vitest` marked `"test": true` beside an unentried
        `test:client`: the marked script runs exactly once, as the whole-suite
        run, and its row is covered by that run; `bun test` never runs;
        `test:client` runs once by its own script, its row its own."""
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": True})
        drive = self.gate()
        self.assertEqual(self.whole_suite_spawns(), [],
                         f"a marked project's gate never runs `bun test`; "
                         f"spawns={self.spawns()!r}; {drive.diag()}")
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assert_ran_once_by_its_own_script(drive, BUN_TARGET)
        marked_row = self.row(drive, VITEST_TARGET)
        self.assertIsInstance(marked_row.get("coveredBy"), str, f"row={marked_row!r}")
        self.assertEqual((marked_row.get("passed"), marked_row.get("total")),
                         (SCRIPT_CASES, SCRIPT_CASES), f"row={marked_row!r}")
        own_row = self.row(drive, BUN_TARGET)
        self.assertNotIn("coveredBy", own_row, f"row={own_row!r}")
        self.assertEqual(own_row.get("client"), BUN_CLIENT_NAME, f"row={own_row!r}")
        self.assertEqual((own_row.get("passed"), own_row.get("total"), own_row.get("outcome")),
                         (SCRIPT_CASES, SCRIPT_CASES, "pass"), f"row={own_row!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())

    def test_two_marked_entries_refuse_the_gate_before_its_tsc_step(self):
        """Both entries marked (which `test` refuses): the gate refuses,
        naming `crucible.targets` and both entries, before its tsc step, with
        `test`'s detail."""
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": True},
                                    bun_entry={**BUN_TEST_ENTRY, "test": True})
        drive = self.drive(GATE)
        assert_gate_refused_with_tests_detail(self, drive, TABLE, VITEST_TARGET, BUN_TARGET)

    def test_a_marker_of_false_refuses_the_gate_before_its_tsc_step(self):
        """`"test": false` (which `test` refuses): the gate refuses, naming
        `crucible.targets` and the entry, before its tsc step, with `test`'s
        detail."""
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": False})
        drive = self.drive(GATE)
        assert_gate_refused_with_tests_detail(self, drive, TABLE, VITEST_TARGET)


if __name__ == "__main__":
    unittest.main()
