"""A go tier verb refuses what it cannot run before any `go test` runs, in the
declared order, each as an `ok: false` envelope and never a traceback.

The order a go tier verb checks:

  1. an unattributed run while a cycle is active (before the toolchain is
     touched at all);
  2. no `go` on PATH, or a `go` below the 1.24 floor;
  3. no module under the project dir;
  then the declaration probe (`go list` only), then
  4. a board that does not decode `go-test`, before any run opens.

Where two causes hold at once, the earlier one is the one named, which is how
the order is observed. Every tier verb (`unit`, `module`, `integration`,
`e2e`, `bdd`) is refused while a cycle is active, before the toolchain is
touched.

Driven with the real go client and the recording `go` shim of
`go_client_harness` (the real `go` behind it, or a version it states) against
a `RecordingBoard`; the module is `tests/fixtures/go-client/tiers`, which
declares `integration`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_tier_verb_refuses_before_running_in_order
"""

import os
import unittest

from tests.client.go_client_harness import GoProject, go_toolchain_gap
from tests.client.go_tier_harness import (
    UNATTRIBUTED_CODE,
    UNDECLARED_CODE,
    drive_tier,
    envelope,
    go_subcommands,
    go_test_calls,
    said,
    starts,
    tier_project,
    where,
)
from tests.client.live_run_harness import new_scratch

DONE_CYCLE = 9030
ACTIVE_CYCLE = 9031
DECLARED_TIERS = ("unit", "module", "integration", "e2e", "bdd")


class _RefusalCase(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def assert_refused(self, p, result, verb):
        ctx = where(p, result)
        self.assertNotEqual(result.returncode, 0, f"refused; {ctx}")
        self.assertNotIn("Traceback", result.stderr, f"never a traceback; {ctx}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {ctx}")
        self.assertEqual(result.stdout.count("axi:"), 1, f"exactly one envelope; {ctx}")
        self.assertEqual((axi or {}).get("verb"), verb, ctx)
        self.assertIs((axi or {}).get("ok"), False, ctx)
        self.assertEqual(go_test_calls(p), [], f"no `go test` runs; {ctx}")
        self.assertEqual(starts(p), [], f"no run opens; {ctx}")
        return axi or {}

    @staticmethod
    def empty_path():
        """A PATH holding no `go` at all."""
        empty = os.path.join(new_scratch("go-no-toolchain-"), "bin")
        os.makedirs(empty, exist_ok=True)
        return empty


class AnUnattributedTierRunIsRefusedFirstTest(_RefusalCase):

    def active_cycle_project(self, fixture="tiers"):
        p = tier_project(self, fixture)
        p.board.refuse_cycle_binding(DONE_CYCLE, ACTIVE_CYCLE)
        return p

    def assert_unattributed(self, p, result, verb):
        axi = self.assert_refused(p, result, verb)
        ctx = where(p, result)
        self.assertIn(UNATTRIBUTED_CODE, result.stderr, ctx)
        self.assertIn(f"--cycle {ACTIVE_CYCLE}", " ".join(str(h) for h in axi.get("help") or []),
                      f"help names the active cycle; {axi!r}")
        self.assertEqual(p.calls(), [], f"the toolchain is never touched; {ctx}")

    def test_integration_is_refused_before_the_toolchain_is_asked(self):
        p = self.active_cycle_project()
        self.assert_unattributed(p, drive_tier(p, "integration"), "integration")

    def test_every_tier_verb_is_refused_while_a_cycle_is_active(self):
        for tier in DECLARED_TIERS:
            with self.subTest(tier=tier):
                p = self.active_cycle_project()
                self.assert_unattributed(p, drive_tier(p, tier), tier)

    def test_unattributed_is_named_before_a_missing_toolchain(self):
        p = self.active_cycle_project()
        result = drive_tier(p, "integration", PATH=self.empty_path())
        self.assert_unattributed(p, result, "integration")


class ATierVerbWithNoUsableGoIsRefusedTest(_RefusalCase):

    def test_no_go_on_path_is_refused_naming_the_toolchain_before_the_module(self):
        # No module either: the toolchain refusal comes first.
        p = GoProject(self, fixture=None)
        result = drive_tier(p, "integration", PATH=self.empty_path())
        axi = self.assert_refused(p, result, "integration")
        words = said(axi)
        self.assertIn("PATH", words, f"the refusal names the missing toolchain; {words!r}")
        self.assertNotIn("no go module", words, f"not the module refusal; {words!r}")
        self.assertNotIn(UNDECLARED_CODE, result.stderr, where(p, result))

    def test_a_go_below_the_floor_is_refused_before_any_go_list(self):
        p = tier_project(self, "tiers")
        result = drive_tier(p, "integration", GO_SHIM_VERSION="go1.23.4", GO_SHIM_FAKE_ONLY="1")
        axi = self.assert_refused(p, result, "integration")
        words = said(axi)
        self.assertIn("1.23.4", words, f"names the version found; {words!r}")
        self.assertIn("1.24", words, f"names the floor; {words!r}")
        self.assertEqual(set(go_subcommands(p)) - {"version", "env"}, set(),
                         f"go is only asked its version; {where(p, result)}")
        self.assertNotIn(UNDECLARED_CODE, result.stderr, where(p, result))


class ATierVerbWithNoModuleIsRefusedTest(_RefusalCase):

    def test_no_module_is_refused_as_no_module_and_not_as_an_undeclared_tier(self):
        p = GoProject(self, fixture=None)
        result = drive_tier(p, "integration")
        axi = self.assert_refused(p, result, "integration")
        ctx = where(p, result)
        self.assertIn("module", said(axi), f"the refusal names the missing module; {ctx}")
        self.assertNotIn(UNDECLARED_CODE, result.stderr,
                         f"no module is not an undeclared tier; {ctx}")
        self.assertEqual(set(go_subcommands(p)) - {"version", "env"}, set(),
                         f"nothing is listed or run; {ctx}")


class ATierVerbOnABoardThatDoesNotDecodeGoTestIsRefusedTest(_RefusalCase):

    def test_a_board_without_go_test_is_refused_before_any_run_opens(self):
        p = tier_project(self, "tiers")
        health = p.board.default_health()
        for kind in ("test", "stream"):
            health["codecs"][kind] = [c for c in health["codecs"][kind] if c != "go-test"]
        p.board.script_health(health)
        result = drive_tier(p, "integration")
        axi = self.assert_refused(p, result, "integration")
        self.assertIn("go-test", said(axi), f"names the codec; {where(p, result)}")
        self.assertNotIn(UNDECLARED_CODE, result.stderr, where(p, result))


if __name__ == "__main__":
    unittest.main()
