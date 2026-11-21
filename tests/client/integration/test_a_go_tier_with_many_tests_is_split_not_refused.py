"""A go tier with many tests is split across invocations, not refused.

A package's tier names ride `go test -run '^(<names>)$'`. One regex over 3000
long names is larger than Linux's 128 KiB per-argument limit
(`MAX_ARG_STRLEN`), so `go` could not even be exec'd. The client splits a
package's names across several invocations, each `-run` under a byte budget
well below that limit, every invocation into the ONE run.

The module is generated in the test's own scratch project: package `many`
with 3000 `integration`-tagged tests whose names make one regex about 170 KB.
The real go client runs it through the recording `go` shim of
`go_client_harness` (which records each call's argv and execs the real `go`)
against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_tier_with_many_tests_is_split_not_refused
"""

import os
import re
import unittest

from tests.client.go_client_harness import GoProject, flag_value, go_toolchain_gap
from tests.client.go_tier_harness import (
    ARG_LIMIT_BYTES,
    drive_tier,
    envelope,
    go_test_calls,
    held_terminals,
    starts,
    where,
)

MANY = 3000
MODULE = "example.com/manytier"
PACKAGE = f"{MODULE}/many"
NAMES = [f"TestGeneratedIntegrationCaseNumber{i:04d}PaddedSoTheRegexGrowsLong"
         for i in range(MANY)]
#: The shape of a `-run` the spec states: `^(<name>|<name>|…)$`.
_RUN_SHAPE = re.compile(r"^\^\((.*)\)\$$")


def _write_many_module(root):
    os.makedirs(os.path.join(root, "many"), exist_ok=True)
    with open(os.path.join(root, "go.mod"), "w", encoding="utf-8") as fh:
        fh.write(f"module {MODULE}\n\ngo 1.24\n")
    with open(os.path.join(root, "many", "many.go"), "w", encoding="utf-8") as fh:
        fh.write("package many\n")
    with open(os.path.join(root, "many", "unit_test.go"), "w", encoding="utf-8") as fh:
        fh.write('package many\n\nimport "testing"\n\nfunc TestUntaggedNeverInTheTier(t *testing.T) {}\n')
    body = "".join(f"func {name}(t *testing.T) {{}}\n" for name in NAMES)
    with open(os.path.join(root, "many", "many_integ_test.go"), "w", encoding="utf-8") as fh:
        fh.write('//go:build integration\n\npackage many\n\nimport "testing"\n\n' + body)


class ATierWithManyTestsIsSplitNotRefusedTest(unittest.TestCase):
    maxDiff = 3000
    drives = []

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")
        if not type(self).drives:
            p = GoProject(self, fixture=None)
            _write_many_module(p.dir)
            p.board.script_run(passed=MANY)
            type(self).drives.append((p, drive_tier(p, "integration", timeout=600)))
        self.p, self.result = type(self).drives[0]
        self.ctx = where(self.p, self.result)[-2500:]

    def test_one_run_opens_with_start_total_3000(self):
        opened = starts(self.p)
        self.assertEqual(len(opened), 1, f"exactly one run; {self.ctx}")
        start = opened[0] if opened else {}
        self.assertEqual(start.get("tier"), "integration", f"{start!r}")
        self.assertEqual(start.get("total"), MANY, f"{start!r}")

    def test_all_3000_tests_are_filed_into_the_one_run_and_it_passes(self):
        filed = held_terminals(self.p)
        self.assertEqual(len(filed), MANY, f"3000 terminal events reach the board; {self.ctx}")
        self.assertEqual(sorted(test for _pkg, test, _a in filed), sorted(NAMES),
                         f"each generated test once, and no untagged one; {self.ctx}")
        self.assertEqual({(pkg, action) for pkg, _t, action in filed}, {(PACKAGE, "pass")},
                         self.ctx)
        self.assertEqual(len(self.p.closes()), 1, f"one close; {self.ctx}")
        self.assertIs((envelope(self.result.stdout) or {}).get("ok"), True, self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)

    def test_no_run_argument_reaches_the_per_argument_limit(self):
        whole = "^(" + "|".join(NAMES) + ")$"
        self.assertGreater(len(whole.encode()), ARG_LIMIT_BYTES,
                           "fixture sanity: one regex over every name needs a split")
        calls = go_test_calls(self.p)
        self.assertGreaterEqual(len(calls), 2,
                                f"the names are split over several invocations; {self.ctx}")
        selected = []
        for call in calls:
            run = flag_value(call["argv"], "-run")
            self.assertIsNotNone(run, f"each invocation selects by -run: {call['argv'][:6]!r}")
            self.assertLess(len((run or "").encode()), ARG_LIMIT_BYTES,
                            f"a -run of {len((run or '').encode())} bytes")
            self.assertEqual(flag_value(call["argv"], "-tags"), "integration",
                             call["argv"][:6])
            shape = _RUN_SHAPE.match(run or "")
            self.assertIsNotNone(shape, f"-run is ^(<names>)$: {(run or '')[:80]!r}")
            if shape:
                selected.extend(shape.group(1).split("|"))
        self.assertEqual(sorted(selected), sorted(NAMES),
                         "the invocations together select every name exactly once")


if __name__ == "__main__":
    unittest.main()
