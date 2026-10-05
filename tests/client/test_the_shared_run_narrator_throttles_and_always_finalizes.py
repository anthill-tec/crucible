"""Unit test of the C1 shared narrator this CR asks `_crucible_axi.py` to
carry — referred to here, and only here, by its assumed name `RunNarrator`
(a new symbol; no client currently imports anything of the kind). Every
other RED file in this cycle drives the real clients end to end and asserts
behaviour only; this file is the one place that talks to the shared
narrator directly, to pin its throttle and final-post contract precisely
and cheaply (no subprocess, no HTTP).

Mode 1 RED: `_crucible_axi.RunNarrator` does not exist yet (confirmed:
grepping clients/_crucible_axi.py for "class RunNarrator" has no hit), so
every test below fails at `AttributeError: module ... has no attribute
'RunNarrator'` when it tries to construct one — a missing-SUT-symbol
failure, which the sub-agent procedure counts as valid RED.

Assumed contract (chosen here, not pinned anywhere else; the sibling
integration tests drive the real clients black-box and do not reference
this class at all, per AC3/AC5's "test behaviour, not source text"):

    RunNarrator(post, recognise, total=0, min_seconds=2.0, min_completions=10)
        post(message: str) -> None        — a heartbeat poster; the narrator
                                             swallows any exception it raises
                                             (best-effort, CR-CRU-008's
                                             original throttle contract).
        recognise(line: str) -> bool | tuple[bool, str | None]
                                           — True/False (plain) when `line`
                                             is/isn't one completed
                                             test/class, with NO label
                                             change; OR a `(completed,
                                             label)` pair when the stack
                                             also knows its current
                                             file/class (bun does) —
                                             `label` (when not None)
                                             REPLACES the narrator's stored
                                             current label, whether or not
                                             THIS line counted as a
                                             completion (bun's real
                                             file-header line sets the
                                             label on a NON-completion
                                             line, ahead of the completion
                                             lines that follow it).
        total                              — a static int, OR a zero-arg
                                             callable returning the current
                                             best-known total (mirrors mvn's
                                             existing `_xml_total` closure).
                                             <= 0 (static or returned) means
                                             "unknown" (G3): the wire message
                                             drops the denominator.

    .observe(line)   — feed one line of the runner's output. Every
                       'running N[/M]' heartbeat APPENDS " · <label>" when a
                       label is currently known (F19 state 1: `running
                       1843/2936 · roadmap.test.ts`, the approved visual
                       contract, storyboard F19 .lavish/crucible-v2-design.html).
    .finish()        — UNCONDITIONALLY posts the final count `ran M/M`,
                       with NO label suffix even when one is known (F19
                       state 2: `ran 2936/2936`, no trailing file/class) —
                       M = the resolved total, or the completed count when
                       the total was never known. This is the exact
                       guarantee AC4/§S1 need: "whatever the throttle last
                       allowed" must still include "nothing at all".

Both proofs per the sub-agent procedure: (1) each assertion fails today for
the stated reason (the symbol does not exist — a real missing-SUT-symbol
RED, not a typo); (2) a `RunNarrator` implementing the contract above, as
specified, passes every assertion here — the throttle test's exact tick
count (the 10th `observe()`, never earlier/later), the known/unknown total
formatting split pinned verbatim from the CR's own G3 prose, the F19-exact
label suffix on `running` updates and its absence on the final `ran M/M`,
and the unconditional `finish()` (tested BOTH with and without any prior
post ever having crossed the throttle).
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"


def _load_axi_module():
    spec = importlib.util.spec_from_file_location(
        "crucible_axi_under_test_for_shared_narrator", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _always_completes(_line):
    return True


class SharedRunNarratorThrottleTest(unittest.TestCase):
    """The throttle half of the contract: an update fires only once >=10
    completions have accumulated since the last POSTED one (this file never
    waits 2 real seconds, so only the completion-count arm of the OR is
    exercised — the sibling integration tests' fast, sleep-free fixtures
    rely on exactly this same arm)."""

    def setUp(self):
        self.axi = _load_axi_module()
        self.posted = []

    def test_ten_completions_land_the_first_update_not_nine(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=0, min_seconds=999.0,
                                        min_completions=10)
        for _ in range(9):
            narrator.observe("a completed line\n")
        self.assertEqual(
            self.posted, [],
            f"nine completions must not yet cross the >=10 threshold; "
            f"posted={self.posted!r}")
        narrator.observe("a completed line\n")
        self.assertEqual(
            self.posted, ["running 10"],
            f"the TENTH completion must post exactly once, with an "
            f"UNKNOWN total (none was given) reading the bare G3 shape "
            f"'running N', no denominator; posted={self.posted!r}")

    def test_a_non_matching_line_never_counts_as_a_completion(self):
        def _recognise(line):
            return line.strip() == "MATCH"

        narrator = self.axi.RunNarrator(self.posted.append, _recognise,
                                        total=0, min_seconds=999.0,
                                        min_completions=3)
        for _ in range(3):
            narrator.observe("not a completion\n")
        self.assertEqual(
            self.posted, [],
            f"lines the recogniser rejects must never advance the count; "
            f"posted={self.posted!r}")
        for _ in range(3):
            narrator.observe("MATCH\n")
        self.assertEqual(
            self.posted, ["running 3"],
            f"exactly 3 REAL completions must cross the threshold=3; "
            f"posted={self.posted!r}")

    def test_known_total_message_includes_the_denominator(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=5, min_seconds=999.0,
                                        min_completions=2)
        narrator.observe("x\n")
        narrator.observe("x\n")
        self.assertEqual(
            self.posted, ["running 2/5"],
            f"a KNOWN total (5, given upfront) must appear as the "
            f"denominator -- 'running N/M', per G3; posted={self.posted!r}")

    def test_a_dynamic_total_callable_is_resolved_at_each_tick(self):
        state = {"total": 0}
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=lambda: state["total"],
                                        min_seconds=999.0, min_completions=1)
        state["total"] = 7
        narrator.observe("x\n")
        self.assertEqual(
            self.posted, ["running 1/7"],
            f"a CALLABLE total (mirroring mvn's own `_xml_total` closure) "
            f"must be re-resolved at the moment of the tick, not cached "
            f"from construction; posted={self.posted!r}")

    def test_the_second_update_waits_for_ten_more_completions_not_time(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=0, min_seconds=999.0,
                                        min_completions=10)
        for _ in range(10):
            narrator.observe("x\n")
        self.assertEqual(len(self.posted), 1, f"posted={self.posted!r}")
        for _ in range(9):
            narrator.observe("x\n")
        self.assertEqual(
            len(self.posted), 1,
            f"9 more completions (19 total, 9 since the last post) must "
            f"NOT cross the >=10-since-last-post threshold; "
            f"posted={self.posted!r}")
        narrator.observe("x\n")
        self.assertEqual(
            self.posted, ["running 10", "running 20"],
            f"the 20th completion (10 since the last post) must post "
            f"again; posted={self.posted!r}")


class SharedRunNarratorFinalPostTest(unittest.TestCase):
    """AC4/§S1 at the unit level: `finish()` is UNCONDITIONAL."""

    def setUp(self):
        self.axi = _load_axi_module()
        self.posted = []

    def test_finish_posts_the_final_count_even_when_the_last_completion_was_throttled(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=12, min_seconds=999.0,
                                        min_completions=10)
        for _ in range(12):
            narrator.observe("x\n")
        self.assertEqual(
            self.posted, ["running 10/12"],
            f"only the 10th completion crosses the throttle; the last two "
            f"(#11, #12) land INSIDE the window and post nothing of their "
            f"own; posted={self.posted!r}")
        narrator.finish()
        self.assertEqual(
            self.posted, ["running 10/12", "ran 12/12"],
            f"finish() must land the TRUE final count regardless of what "
            f"the throttle last allowed; posted={self.posted!r}")

    def test_finish_still_posts_when_no_update_ever_crossed_the_throttle(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=0, min_seconds=999.0,
                                        min_completions=10)
        for _ in range(3):
            narrator.observe("x\n")
        self.assertEqual(
            self.posted, [],
            f"3 completions never cross the >=10 threshold -- nothing "
            f"should have posted yet; posted={self.posted!r}")
        narrator.finish()
        self.assertEqual(
            self.posted, ["ran 3/3"],
            f"§S1: 'the client posts the final count ... whatever the "
            f"throttle last allowed' -- even when that is NOTHING, "
            f"finish() must still land the final 'ran N/N' "
            f"(total was never known, so M collapses to the true N); "
            f"posted={self.posted!r}")

    def test_finish_resolves_a_dynamic_total_at_the_moment_it_is_called(self):
        state = {"total": 9}
        narrator = self.axi.RunNarrator(self.posted.append, _always_completes,
                                        total=lambda: state["total"],
                                        min_seconds=999.0, min_completions=99)
        for _ in range(9):
            narrator.observe("x\n")
        self.assertEqual(self.posted, [], f"posted={self.posted!r}")
        state["total"] = 9  # the true total, resolved only now (mirrors
                            # mvn's xml-report count finally catching up)
        narrator.finish()
        self.assertEqual(
            self.posted, ["ran 9/9"],
            f"finish() must resolve a CALLABLE total at call time, not "
            f"from a value captured at construction; posted={self.posted!r}")

    def test_a_label_set_on_a_non_completion_line_persists_onto_later_running_updates(self):
        """F19 state 1 -- `running 1843/2936 \u00b7 roadmap.test.ts`: the label
        comes from a line that does NOT itself count as a completion (bun's
        own file-header line, e.g. `roadmap.test.ts:`), and must still be
        attached to the completion lines that follow it."""
        def _recognise(line):
            text = line.strip()
            if text == "HEADER":
                return (False, "roadmap.test.ts")
            return True  # plain bool style: a real completion, no label change

        narrator = self.axi.RunNarrator(self.posted.append, _recognise,
                                        total=2936, min_seconds=999.0,
                                        min_completions=1)
        narrator.observe("HEADER\n")
        self.assertEqual(
            self.posted, [],
            f"a header line carries no completion of its own; "
            f"posted={self.posted!r}")
        narrator.observe("x\n")
        self.assertEqual(
            self.posted, ["running 1/2936 \u00b7 roadmap.test.ts"],
            f"F19 state 1's exact shape: the label set by the (non-"
            f"completion) header line must be appended to the very next "
            f"'running N/M' heartbeat; posted={self.posted!r}")

    def test_the_final_post_never_carries_the_current_file_label(self):
        """F19 state 2 -- `ran 2936/2936`: NO trailing file/class, even
        though a label was known throughout the run."""
        def _recognise(_line):
            return (True, "roadmap.test.ts")

        narrator = self.axi.RunNarrator(self.posted.append, _recognise,
                                        total=2, min_seconds=999.0,
                                        min_completions=1)
        narrator.observe("x\n")
        narrator.observe("x\n")
        self.assertEqual(
            self.posted,
            ["running 1/2 \u00b7 roadmap.test.ts", "running 2/2 \u00b7 roadmap.test.ts"],
            f"both running updates must carry the known label; "
            f"posted={self.posted!r}")
        narrator.finish()
        self.assertEqual(
            self.posted[-1], "ran 2/2",
            f"F19 state 2's exact shape has NO ' \u00b7 <label>' suffix, "
            f"unlike every 'running' update before it; got "
            f"{self.posted[-1]!r}")

    def test_a_failing_post_during_observe_never_raises_out_of_the_wrapped_run(self):
        """Narration is best-effort (CR-CRU-008's original contract, carried
        over unchanged): a transport hiccup must never fail the suite it is
        merely reporting progress on."""
        def _raising_post(_message):
            raise ConnectionError("board unreachable")

        narrator = self.axi.RunNarrator(_raising_post, _always_completes,
                                        total=0, min_seconds=999.0,
                                        min_completions=1)
        try:
            narrator.observe("x\n")
            narrator.finish()
        except Exception as exc:  # pragma: no cover - this IS the failure
            self.fail(
                f"a failing post() must never propagate out of observe()/"
                f"finish() and abort the wrapped run; raised {exc!r}")


if __name__ == "__main__":
    unittest.main()
