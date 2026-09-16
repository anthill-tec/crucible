"""RED — `next` ANNOUNCES the wave boundary it just crossed, and the
announcement expires by itself.

Covers §S2 alone. §S1's flag surface, §S3's lane-vs-wave split and §S4's
envelope are asserted by the sibling suite
(`test_next_lane_carries_release_and_wave.py`) and nothing here re-states them;
the two vocabulary bounds are the deliberate exception, because THIS cycle adds
a statement to the answer and a statement that arrived as a fourth reason or a
fifth trigger kind would be a different change.

WHAT IS DRIVEN. Every behavioural assertion runs the real `cmd_next` over a
real queue payload through the real emitter — the sibling suite's idiom — so an
assertion fails only when the BEHAVIOUR is absent, never because the resolver's
internal parameter names moved.

THE KEY THE ANNOUNCEMENT RIDES, named once here because the spec fixes the FACT
and not its spelling. §S2 says the answer "says so alongside its decision", so
the statement is a FIELD of the answer, not prose in the human line: a reader
parsing the envelope must be able to act on it without reading English. This
file fixes that field as `waveCompleted`, carrying the PREDECESSOR's label
verbatim, and asserts its ABSENCE by key rather than by string search so an
expired announcement cannot hide inside a help step.

THE FIRST WAVE HAS NO PREDECESSOR, and the spec does not say what a crossing
means there. "The predecessor is complete" is read as a claim about a
predecessor that EXISTS: a resolved wave that is first in the published order
has none, so nothing completed and nothing is announced. That reading is
asserted below rather than left implicit — the alternative (announcing over an
empty predecessor) would state a completion no read proves.

FIXTURE IDS carry a namespace no project owns and none matches the tripwire's
CR-literal shape, so no assertion here names a real board row.
"""

import contextlib
import importlib.util
import io
import os
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

PROJECT_KEY = "next-boundary-key"
BASE_URL = "http://127.0.0.1:0"

# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# The field the boundary statement rides (see the module docstring).
ANNOUNCEMENT = "waveCompleted"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(CLIENTS_DIR / "_crucible_axi.py", "next_boundary_axi_under_test")
TOON = _load(CLIENTS_DIR / "toon.py", "next_boundary_toon")


# ═══════════════════════════════════════════════════════════════════════════
# Fixtures — the wire shape the queue read publishes
# ═══════════════════════════════════════════════════════════════════════════

PREDECESSOR_WAVE = "5"
RESOLVED_WAVE = "6"


def _entry(cr, seq, status="PENDING", wave=RESOLVED_WAVE, release=None,
           track=None, depends_on=(), lifecycle=None):
    """One queue entry, in the sibling suite's shape: `release`, `track` and
    `lifecycle` are OMITTED when not declared, exactly as the server omits
    them, and `wave` is always published."""
    entry = {"cr": cr, "wave": wave, "dependsOn": list(depends_on),
             "status": status, "seq": seq}
    if release is not None:
        entry["release"] = release
    if track is not None:
        entry["track"] = track
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    return entry


def _dead(state, by):
    """A declared-dead disposition. A dead CR is not blocked work — it is not
    work — so it leaves the actionable set exactly as a landed one does, which
    is what makes a wave holding only corpses FINISHED for this predicate."""
    return {"state": state, "by": by}


def _with_status(entries, cr, status):
    """The same board with ONE row's status changed and nothing else touched —
    the instrument of the expiry pair, so the two states cannot drift into two
    different boards that differ in more than the landing under test."""
    return tuple(dict(e, status=status) if e["cr"] == cr else e
                 for e in entries)


def _published_tracks(entries):
    """What the queue read publishes BESIDE its entries: the sorted distinct
    non-blank TRIMMED `track` values — the server's own rule, taken from the
    sibling suite rather than re-worded."""
    return sorted({(e.get("track") or "").strip() for e in entries
                   if (e.get("track") or "").strip()})


def _queue(*entries):
    return {"ok": True, "entries": list(entries),
            "tracks": _published_tracks(entries)}


# ── the crossing itself ───────────────────────────────────────────────────
#
# Wave 5 is COMPLETE the way the live board's wave 5 is complete: every entry
# landed except one declared dead. Wave 6 holds two actionable CRs and NOTHING
# landed — the state that exists for exactly as long as it takes the new wave's
# first CR to merge.
BOUNDARY_JUST_CROSSED = (
    _entry("CR-A5-1", 5001, status="COMPLETED", wave=PREDECESSOR_WAVE),
    _entry("CR-A5-2", 5002, status="COMPLETED", wave=PREDECESSOR_WAVE),
    _entry("CR-A5-3", 5003, wave=PREDECESSOR_WAVE,
           lifecycle=_dead("VOID", "CR-A5-1")),
    _entry("CR-B6-1", 6001),
    _entry("CR-B6-2", 6002),
)

# The SAME board one merge later: the new wave has landed its first CR.
BOUNDARY_ALREADY_CROSSED = _with_status(
    BOUNDARY_JUST_CROSSED, "CR-B6-1", "COMPLETED")

# The crossing, held at the two other exits of the answer.
HOLD_AT_THE_BOUNDARY = BOUNDARY_JUST_CROSSED[:3] + (
    _entry("CR-M6-1", 6001, status="IN_PROGRESS"),
    _entry("CR-M6-2", 6002),
)
DRAINED_LANE_AT_THE_BOUNDARY = BOUNDARY_JUST_CROSSED[:3] + (
    _entry("CR-M6-3", 6001, track="track-1",
           lifecycle=_dead("VOID", "CR-M6-4")),
    _entry("CR-M6-4", 6002, track="track-2"),
)

# The resolved wave is FIRST in the published order — there is no predecessor
# to have completed.
FIRST_WAVE_ON_THE_BOARD = (
    _entry("CR-N1-1", 101, wave="1"),
    _entry("CR-N1-2", 102, wave="1"),
)

# ── the discriminating fixture: labels that do NOT sort into their order ──
#
# Published: `06` (complete), then `10` (complete), then `9` (the resolved
# wave). Three readings, three different predecessors, so the assertion can
# tell them apart:
#   published order   → `10`   (the nearest distinct label BEFORE wave 9's
#                              first row — the ruled reading)
#   integer parse     → `06`   (6 is the largest wave below 9)
#   seq re-derivation → `06`   (602 is the largest seq below 901)
# The `seq` values are deliberately not monotonic in the published order for
# the same reason: a reader re-deriving the sequence answers `06` too.
ORDER_DEFYING_LABELS = (
    _entry("CR-C6-1", 601, status="COMPLETED", wave="06"),
    _entry("CR-C6-2", 602, status="COMPLETED", wave="06"),
    _entry("CR-D1-1", 1001, status="COMPLETED", wave="10"),
    _entry("CR-D1-2", 1002, status="COMPLETED", wave="10"),
    _entry("CR-E9-1", 901, wave="9"),
    _entry("CR-E9-2", 902, wave="9"),
)
PUBLISHED_PREDECESSOR = "10"
PARSED_PREDECESSOR = "06"

# ── DRAINED's help[] names the move that opens the NEXT wave ──────────────
#
# A zero-padded label and a non-numeric one, because `help[]` must carry the
# LABEL as data: a parsed number renders `07` as `7`, and `beta` not at all.
ZERO_PADDED_NEXT_WAVE = (
    _entry("CR-F6-1", 601, status="COMPLETED", wave="06"),
    _entry("CR-F6-2", 602, wave="06", lifecycle=_dead("VOID", "CR-F6-1")),
    _entry("CR-G7-1", 701, wave="07"),
)
NON_NUMERIC_NEXT_WAVE = (
    _entry("CR-J1-1", 101, status="COMPLETED", wave="alpha"),
    _entry("CR-K2-1", 201, wave="beta"),
)

# A wave holding one VOID and one SUPERSEDED CR and no PENDING one — dead CRs
# are FINISHED for this predicate, which is what lets a wave like the live
# board's wave 5 count as a completed predecessor at all.
WAVE_OF_CORPSES = (
    _entry("CR-P6-1", 601, wave="06", lifecycle=_dead("VOID", "CR-P6-2")),
    _entry("CR-P6-2", 602, wave="06",
           lifecycle=_dead("SUPERSEDED", "CR-P6-1")),
    _entry("CR-Q7-1", 701, wave="07"),
)

# ── the front cr of the resolved wave is BLOCKED, and a later wave is not ──
#
# Wave 5 is complete, wave 6's FRONT cr waits on an unmerged dependency inside
# its own wave, and wave 7 holds a cr that could be started this minute. The
# answer must stay on the wave it resolved: the work waiting in wave 7 is work
# the write-side scope guard refuses a plan for, so a reader that scanned on
# for something startable would send an orchestrator at a wave the server has
# not opened.
BLOCKED_FRONT_OF_THE_RESOLVED_WAVE = BOUNDARY_JUST_CROSSED[:3] + (
    _entry("CR-S6-1", 6001, depends_on=("CR-S6-2",)),
    _entry("CR-S6-2", 6002),
    _entry("CR-T7-1", 7001, wave="7"),
)
STARTABLE_LATER_WAVE = "7"

# ── the announcement is scoped to the CONTAINER asked about ───────────────
#
# Wave 5 holds a landed cr declaring the release and an actionable cr
# declaring none; wave 6 holds an actionable cr in the release. Asked about
# the release, wave 5 is finished WITHIN it and wave 6 is the resolved wave;
# asked about the board, wave 5 IS the resolved wave and nothing crossed at
# all. One board, two containers, two answers that are each true of the
# question that was put.
IN_SCOPE_RELEASE = "0.2.0"
RELEASE_SCOPED_CROSSING = (
    _entry("CR-V5-1", 5001, status="COMPLETED", wave=PREDECESSOR_WAVE,
           release=IN_SCOPE_RELEASE),
    _entry("CR-V5-2", 5002, wave=PREDECESSOR_WAVE),
    _entry("CR-W6-1", 6001, release=IN_SCOPE_RELEASE),
)


# ═══════════════════════════════════════════════════════════════════════════
# The `cmd_next` harness — the real ClientOps, the real emitter
# ═══════════════════════════════════════════════════════════════════════════


class _RecordingOps:
    """A real `ClientOps` whose transport records every call. Built from the
    actual class so a signature change breaks here loudly instead of being
    absorbed by a duck-typed stub, and `emit` is the REAL emitter so the
    envelope this file reads is the one an orchestrator would receive."""

    def __init__(self, queue_response):
        self.queue_response = queue_response
        self.gets = []
        self.writes = []
        self.ops = AXI.ClientOps(
            get=self._get,
            post=self._write("POST"),
            patch=self._write("PATCH"),
            emit=AXI.emit_axi,
            context=self._context,
            agent_id=self._agent_id,
            project_key=lambda project_dir: PROJECT_KEY,
            plans_path=lambda project_dir: f"/api/v2/projects/{PROJECT_KEY}/plans",
            open_plans=lambda project_dir: [],
            resolve_plan=lambda *a, **kw: None,
            post_gate=self._write("POST-GATE"),
            post_milestone=self._write("POST-MILESTONE"),
            base_url=BASE_URL)

    def _get(self, path):
        self.gets.append(path)
        return self.queue_response

    def _write(self, method):
        def _recorded(*args, **kwargs):
            self.writes.append((method, args, kwargs))
            return {"ok": True}
        return _recorded

    def _context(self, project_dir, **kwargs):
        return AXI.axi_context(PROJECT_KEY, **kwargs)

    def _agent_id(self, args):
        return "should-never-be-asked"


def _args(**overrides):
    """The Namespace `next`'s subparser produces. No `agent` key: the verb
    writes nothing, and a Namespace carrying one would hide its absence."""
    values = {"project_dir": None, "track": None, "release": None,
              "wave": None}
    values.update(overrides)
    return Namespace(**values)


class _NextTestBase(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)

    def drive(self, entries, **flags):
        """Run the real `cmd_next` over `entries` → (fields, stderr, code)."""
        recorder = _RecordingOps(_queue(*entries))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = AXI.cmd_next(_args(**flags), "/fake/dir", recorder.ops)
        return TOON.decode(out.getvalue())["axi"], err.getvalue().strip(), code

    def fields(self, entries, **flags):
        return self.drive(entries, **flags)[0]

    def announcement(self, entries, **flags):
        """The boundary statement the answer carries, or `None` when it carries
        none. Read by KEY: an announcement that expired must be ABSENT from
        the envelope, not merely unmentioned in some prose."""
        return self.fields(entries, **flags).get(ANNOUNCEMENT)


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the crossing is announced, and the announcement expires
# ═══════════════════════════════════════════════════════════════════════════


class BoundaryAnnouncementTest(_NextTestBase):
    """§S2 — when the resolved wave's predecessor is complete AND the resolved
    wave holds no landed entry yet, the crossing has just happened and the
    answer says so ALONGSIDE its decision. Today the same call answers `NEXT`
    and says nothing: the orchestrator learns a wave ended only by noticing
    the answer names a different wave."""

    def test_a_crossing_states_the_predecessor_completed_beside_its_decision(self):
        fields = self.fields(BOUNDARY_JUST_CROSSED)
        self.assertEqual(
            {"decision": fields.get("decision"), "cr": fields.get("cr"),
             "wave": fields.get("wave"),
             ANNOUNCEMENT: fields.get(ANNOUNCEMENT)},
            {"decision": "NEXT", "cr": "CR-B6-1", "wave": RESOLVED_WAVE,
             ANNOUNCEMENT: PREDECESSOR_WAVE},
            "the decision is unchanged — the front actionable CR of the "
            "resolved wave — and the answer ALSO states that the predecessor "
            "wave completed, which is the fact this read already proves")

    def test_the_announcement_expires_when_the_new_wave_lands_its_first_cr(self):
        """§S2 — it stops being said the moment the new wave's first CR lands,
        so it cannot become permanent noise and needs no state on either side.
        BOTH states are asserted over ONE fixture pair differing in exactly one
        row's status, so a reading that never announces and a reading that
        announces forever both fail here."""
        self.assertEqual(
            {"just crossed": self.announcement(BOUNDARY_JUST_CROSSED),
             "first cr landed": self.announcement(BOUNDARY_ALREADY_CROSSED)},
            {"just crossed": PREDECESSOR_WAVE, "first cr landed": None},
            "one landed entry in the resolved wave ends the announcement")

    def test_the_expired_board_still_answers_next_on_the_front_actionable_cr(self):
        """The expiry removes the STATEMENT and nothing else — the decision on
        the same board is still the front actionable CR of the resolved wave.
        Passes today and must keep passing: it is the bound on the change."""
        fields = self.fields(BOUNDARY_ALREADY_CROSSED)
        self.assertEqual(
            (fields.get("decision"), fields.get("cr"), fields.get("wave")),
            ("NEXT", "CR-B6-2", RESOLVED_WAVE))
        self.assertNotIn(
            ANNOUNCEMENT, fields,
            "absence is asserted by KEY: a statement demoted into a help "
            "step or a prose line would still be the permanent noise §S2 "
            "forbids")


class PredecessorIsThePreviousPublishedLabelTest(_NextTestBase):
    """§S2, ruled at cycle 399 — the PREDECESSOR is the previous distinct wave
    LABEL in the PUBLISHED order. Waves are strings on the wire, so the reader
    takes the nearest distinct `wave` value appearing before the resolved
    wave's first row and never parses, sorts or arithmetics its way there."""

    def test_the_fixture_labels_really_do_not_sort_into_their_published_order(self):
        """The instrument, asserted rather than promised: if these two readings
        ever agreed, the criterion below would pass for the wrong reason."""
        published, seen = [], set()
        for entry in ORDER_DEFYING_LABELS:
            if entry["wave"] not in seen:
                seen.add(entry["wave"])
                published.append(entry["wave"])
        self.assertEqual(published, ["06", "10", "9"])
        self.assertEqual(sorted(published, key=int), ["06", "9", "10"])
        self.assertNotEqual(
            published, sorted(published, key=int),
            "the fixture only discriminates while its labels disagree with "
            "their own numeric order")

    def test_the_predecessor_is_the_previous_distinct_label_in_published_order(self):
        fields = self.fields(ORDER_DEFYING_LABELS)
        self.assertEqual(
            {"wave": fields.get("wave"),
             ANNOUNCEMENT: fields.get(ANNOUNCEMENT)},
            {"wave": "9", ANNOUNCEMENT: PUBLISHED_PREDECESSOR},
            "the resolved wave is the wave of the first actionable row in the "
            "published order, and its predecessor is the label published "
            "immediately before it")
        self.assertNotEqual(
            fields.get(ANNOUNCEMENT), PARSED_PREDECESSOR,
            "a reader that parsed the labels as integers — or re-derived the "
            "order from `seq` — would name this wave instead, which is "
            "exactly the re-derivation the read side may not do")


class AnnouncementRidesEveryDecisionTest(_NextTestBase):
    """§S2 — the crossing is a fact about the RESOLVED WAVE, not about the
    decision, so it rides every exit of the answer. A statement that only
    `NEXT` carries would go unsaid on precisely the boards where a reader is
    most likely to be waiting for a boundary."""

    BOARDS = {
        "NEXT": (BOUNDARY_JUST_CROSSED, {}),
        "HOLD": (HOLD_AT_THE_BOUNDARY, {}),
        "DRAINED": (DRAINED_LANE_AT_THE_BOUNDARY, {"track": "1"}),
    }

    def test_each_board_really_produces_the_decision_it_is_named_for(self):
        """Non-vacuity first: three boards that all answered `NEXT` would make
        the criterion below a single assertion wearing three hats. Passes
        today and must keep passing."""
        decisions = {name: self.fields(entries, **flags).get("decision")
                     for name, (entries, flags) in self.BOARDS.items()}
        self.assertEqual(
            decisions,
            {"NEXT": "NEXT", "HOLD": "HOLD", "DRAINED": "DRAINED"})

    def test_every_decision_states_the_predecessor_completed(self):
        stated = {name: self.announcement(entries, **flags)
                  for name, (entries, flags) in self.BOARDS.items()}
        self.assertEqual(
            stated,
            {"NEXT": PREDECESSOR_WAVE, "HOLD": PREDECESSOR_WAVE,
             "DRAINED": PREDECESSOR_WAVE},
            "one read, one decision, plus the fact that read already proves — "
            "on all three answers")


class DrainedHelpCarriesTheNextWaveLabelTest(_NextTestBase):
    """§S2 — `DRAINED`'s `help[]` names the move that opens the next wave and
    carries that wave's LABEL as DATA, not prose. The label is taken verbatim
    from the published order, which is what makes a zero-padded or non-numeric
    wave reachable at all — `DRAINED`'s help today spells a `<n>` placeholder
    the caller has to fill in by reading the board itself."""

    def _steps_naming(self, entries, label, **flags):
        fields, _stderr, code = self.drive(entries, **flags)
        self.assertEqual(
            (fields.get("decision"), fields.get("reason"), code),
            ("DRAINED", "wave-complete", 0),
            f"the board must really drain before its help can be read — and a "
            f"finished wave is an ANSWER, so the verb exits 0 rather than "
            f"reporting the end of a wave as a failure: {fields!r}")
        return [step for step in fields["help"] if f"--wave {label}" in step]

    def test_a_zero_padded_next_wave_label_rides_the_help_verbatim(self):
        named = self._steps_naming(ZERO_PADDED_NEXT_WAVE, "07", wave="06")
        self.assertNotEqual(
            named, [],
            "the move that opens the next wave must carry its LABEL: `07` is "
            "the label the queue published, and a step spelling `<n>` leaves "
            "the reader to re-derive it")
        parsed = self._steps_naming(ZERO_PADDED_NEXT_WAVE, "7", wave="06")
        self.assertEqual(
            parsed, [],
            "as DATA, not as a parsed number: `7` and `07` are two waves, and "
            "a help step naming `7` would open a wave nothing declares")

    def test_a_non_numeric_next_wave_label_needs_no_special_case(self):
        named = self._steps_naming(NON_NUMERIC_NEXT_WAVE, "beta", wave="alpha")
        self.assertNotEqual(
            named, [],
            "waves are strings on the wire: a label that no arithmetic can "
            "reach is still the next wave, and the verbatim rule reaches it "
            "without a case of its own")


class TheFirstWaveHasNoPredecessorTest(_NextTestBase):
    """§S2, read narrowly and stated (see the module docstring): a resolved
    wave that is FIRST in the published order has no predecessor, so nothing
    completed and nothing is announced. Passes today and must keep passing —
    it bounds the change against announcing a completion no read proves."""

    def test_the_earliest_published_wave_announces_no_completed_predecessor(self):
        fields = self.fields(FIRST_WAVE_ON_THE_BOARD)
        self.assertEqual(
            (fields.get("decision"), fields.get("cr"), fields.get("wave")),
            ("NEXT", "CR-N1-1", "1"))
        self.assertNotIn(
            ANNOUNCEMENT, fields,
            "a wave with nothing published before it crossed no boundary, "
            "however little of it has landed")


class TheAnnouncementIsScopedToTheContainerAskedAboutTest(_NextTestBase):
    """§S2, ruled at cycle 401 — the crossing is announced ABOUT THE CONTAINER
    the caller asked about. A release-scoped question is answered about that
    release and nothing else, so `--release` states that the predecessor
    completed WITHIN it even while that same wave still holds an actionable
    entry declaring no release: the narrowing §S1 already applies to
    membership, and the standing non-goal that release-less work is invisible
    to a release-scoped view. Asserted as a PAIR on ONE board, because the
    unscoped reading would make the announcement report on work the caller
    explicitly excluded."""

    def test_a_release_scoped_answer_announces_the_crossing_within_that_release(self):
        fields = self.fields(RELEASE_SCOPED_CROSSING, release=IN_SCOPE_RELEASE)
        self.assertEqual(
            {"decision": fields.get("decision"), "cr": fields.get("cr"),
             "wave": fields.get("wave"), "release": fields.get("release"),
             ANNOUNCEMENT: fields.get(ANNOUNCEMENT)},
            {"decision": "NEXT", "cr": "CR-W6-1", "wave": RESOLVED_WAVE,
             "release": IN_SCOPE_RELEASE, ANNOUNCEMENT: PREDECESSOR_WAVE},
            "inside the release asked about, the predecessor holds nothing "
            "actionable — and the envelope names that release beside the "
            "statement, so the claim reads as the scoped one it is")

    def test_the_same_board_unscoped_answers_the_release_less_row_and_announces_nothing(self):
        fields = self.fields(RELEASE_SCOPED_CROSSING)
        self.assertEqual(
            (fields.get("decision"), fields.get("cr"), fields.get("wave")),
            ("NEXT", "CR-V5-2", PREDECESSOR_WAVE),
            "with no container declared, the actionable release-less row is "
            "the answer and the wave holding it is the resolved one")
        self.assertNotIn(
            ANNOUNCEMENT, fields,
            "that wave is plainly unfinished once nothing narrows the "
            "question, so the unscoped answer announces no crossing at all")


# ═══════════════════════════════════════════════════════════════════════════
# The boundary answers that already ship — the bound on this change
# ═══════════════════════════════════════════════════════════════════════════


class AskingAboutACompleteWaveTest(_NextTestBase):
    """§S2 — `next --wave <n>` against a wave whose every entry is landed or
    dead is the only way to ask the question directly, and it answers about
    THAT wave. Passes today (cycle 399) and must keep passing."""

    def test_an_explicit_complete_wave_answers_drained_wave_complete_for_it(self):
        fields = self.fields(BOUNDARY_JUST_CROSSED, wave=PREDECESSOR_WAVE)
        self.assertEqual(
            (fields.get("decision"), fields.get("reason"),
             fields.get("wave")),
            ("DRAINED", "wave-complete", PREDECESSOR_WAVE),
            "the wave asked about is the wave answered about, even while a "
            "later wave holds all the actionable work")

    def test_a_wave_holding_only_corpses_is_complete(self):
        """Dead CRs are FINISHED for this predicate — the rule the predecessor
        test leans on, asserted on its own so the crossing above cannot be the
        only thing proving it."""
        fields = self.fields(WAVE_OF_CORPSES, wave="06")
        self.assertEqual(
            (fields.get("decision"), fields.get("reason"),
             fields.get("wave")),
            ("DRAINED", "wave-complete", "06"))


class ABlockedFrontCrHoldsItsOwnWaveTest(_NextTestBase):
    """§S2 — a wave whose FRONT cr is `PENDING` behind an unmerged `dependsOn`
    still answers `HOLD` on THAT cr, with the cause it is waiting on. The
    reader states what the lane is stuck behind; it does not scan on into the
    next wave for something startable, because that work is work the
    write-side scope guard refuses a plan for."""

    def test_the_later_wave_really_holds_startable_work(self):
        """Non-vacuity first: with nothing actionable waiting in the later wave
        the criterion below would pass against a reader that scans wherever it
        likes. Asked about that wave directly, this board answers `NEXT`."""
        fields = self.fields(BLOCKED_FRONT_OF_THE_RESOLVED_WAVE,
                             wave=STARTABLE_LATER_WAVE)
        self.assertEqual(
            (fields.get("decision"), fields.get("cr")), ("NEXT", "CR-T7-1"))

    def test_a_blocked_front_cr_holds_its_own_wave_rather_than_scanning_on(self):
        fields = self.fields(BLOCKED_FRONT_OF_THE_RESOLVED_WAVE)
        self.assertEqual(
            {"decision": fields.get("decision"), "cr": fields.get("cr"),
             "wave": fields.get("wave"),
             "kind": (fields.get("trigger") or {}).get("kind")},
            {"decision": "HOLD", "cr": "CR-S6-1", "wave": RESOLVED_WAVE,
             "kind": "dependency"},
            "the front cr of the resolved wave is blocked, so the answer "
            "names THAT cr and the dependency it waits on — an answer naming "
            "the startable cr of the next wave would offer work the server "
            "has not opened")


class EmptyDeclaredContainerTest(_NextTestBase):
    """§S2, ruled at cycle 399 — a declared container that selects NO row has
    completed nothing. It cannot be `no-roadmap` (the queue is not empty) and
    must not be `wave-complete`. Passes today and must keep passing: the
    announcement must not turn an empty container into a crossing."""

    def _answers(self):
        return {
            "--wave 99": self.fields(BOUNDARY_JUST_CROSSED, wave="99"),
            "--release 9.9.9": self.fields(BOUNDARY_JUST_CROSSED,
                                           release="9.9.9"),
        }

    def test_an_empty_container_announces_no_crossing(self):
        """The announcement must not turn an empty container into a crossing:
        a container nothing declares has no first row to stand behind, so
        there is no predecessor of it to have completed. Read by KEY, the way
        every other absence in this file is read."""
        self.assertEqual(
            [flag for flag, f in self._answers().items() if ANNOUNCEMENT in f],
            [],
            "a container holding no work completed nothing, so nothing "
            "crossed into it either")

    def test_a_container_selecting_no_row_is_awaiting_assignment(self):
        answers = self._answers()
        self.assertEqual(
            {flag: (f.get("decision"), f.get("reason"))
             for flag, f in answers.items()},
            {"--wave 99": ("DRAINED", "awaiting-assignment"),
             "--release 9.9.9": ("DRAINED", "awaiting-assignment")},
            "an empty container holds no work to have finished")
        self.assertEqual(
            [flag for flag, f in answers.items()
             if f.get("reason") == "wave-complete"], [],
            "nothing was declared there, so nothing completed there")


class DecisionVocabularyIsUnchangedTest(unittest.TestCase):
    """§S2 adds a STATEMENT to the answer, never a fourth reason or a fifth
    trigger kind. Asserted by length AND by value, because a set comparison
    alone survives a new member arriving beside a deleted one. Passes today
    and must keep passing — this is the bound on the change."""

    def test_the_three_drained_reasons_are_still_the_whole_vocabulary(self):
        self.assertEqual(len(AXI.DRAINED_REASONS), 3)
        self.assertEqual(
            AXI.DRAINED_REASONS,
            ("wave-complete", "awaiting-assignment", "no-roadmap"))

    def test_the_four_hold_trigger_kinds_are_still_the_whole_vocabulary(self):
        self.assertEqual(len(AXI.HOLD_TRIGGER_KINDS), 4)
        self.assertEqual(
            AXI.HOLD_TRIGGER_KINDS,
            ("in-flight", "dead-dependency", "dependency",
             "unknown-dependency"))


if __name__ == "__main__":
    unittest.main()
