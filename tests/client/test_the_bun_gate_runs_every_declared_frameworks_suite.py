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
- a non-`bun-test` table entry whose key is not a `test:` script is refused by
  the gate, naming the entry;
- `--suites <vitest target>` runs only that target; `--suites <bun-test
  target>` runs the whole suite and no Vitest suite;
- the Vitest suite's run requests no coverage and adds no
  `coverage-not-measured` warning, while the whole-suite run keeps its
  coverage;
- a `"test"` marker on a table entry changes nothing in the gate: only `test`
  reads it.

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


# ── the `test` marker is ignored by the gate ────────────────────────────────

class TheTestMarkerChangesNothingInTheGateTest(_GateFrameworksCase):

    def shape(self, drive):
        """What the gate ran and reported: its exit, ok, rows, the argv of
        every spawn and the framework and tier of every filed run."""
        envelope = self.envelope(drive)
        return {"exit": drive.returncode, "ok": envelope.get("ok"),
                "rows": self.rows(drive),
                "spawns": sorted(json.dumps(s.get("argv")) for s in self.spawns()),
                "filed": sorted((b.get("framework"), b.get("tier")) for b in self.ingests())}

    def test_a_marked_vitest_entry_gates_exactly_as_the_unmarked_one(self):
        """The same project gated with `test:vitest` unmarked and then marked
        `"test": true`: identical runs and rows, the Vitest suite run in
        both."""
        self.declare_bun_and_vitest()
        unmarked = self.gate()
        self.assert_ran_once_by_its_own_script(unmarked, VITEST_TARGET)
        before = self.shape(unmarked)
        self.forget()
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": True})
        marked = self.gate()
        self.assert_ran_once_by_its_own_script(marked, VITEST_TARGET)
        self.assertEqual(self.shape(marked), before, marked.diag())

    def test_two_marked_entries_do_not_stop_the_gate(self):
        """Both entries marked (which `test` refuses): the gate runs the whole
        suite and the Vitest suite and is ok."""
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": True},
                                    bun_entry={**BUN_TEST_ENTRY, "test": True})
        drive = self.gate()
        self.assertEqual(len(self.whole_suite_spawns()), 1, f"spawns={self.spawns()!r}")
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())

    def test_a_marker_that_is_not_true_does_not_stop_the_gate(self):
        """`"test": false` (which `test` refuses): the gate runs the Vitest
        suite and is ok."""
        self.declare_bun_and_vitest({**VITEST_JUNIT_ENV_ENTRY, "test": False})
        drive = self.gate()
        self.assert_ran_once_by_its_own_script(drive, VITEST_TARGET)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())


if __name__ == "__main__":
    unittest.main()
