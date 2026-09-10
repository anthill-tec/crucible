"""A STEP STATUS NOBODY GAVE IS NOT A GREEN ONE (CR-CRU-117 §S2).

THE DEFECT, MEASURED ON THIS TREE. `map_axi_step_status` ends in

    }.get(status, status or "passed")

so a status the table does not name passes through VERBATIM — which is right,
and is the behaviour cycle 409 shipped (`pending` reaches the board as
`pending` rather than being dropped) — but an EMPTY or ABSENT status becomes
`passed`. A verdict is manufactured out of silence.

Measured before this file was written, straight through `gate_from_axi`: a
nine-row snapshot whose `steps[9]{step,findings,duration_ms}` header carries no
`status` column at all — nine rows, not one word about any of them — produces a
ladder of NINE `passed` steps. That is a fully green ladder posted to the board
for a run about whose steps the tool said nothing whatsoever.

This is the same green bias CR-CRU-115 removed one level up, in
`sealed_outcome`: "a value nobody understands must not become green, and the
absence of a failure is not a verdict". It survived HERE, in the mapper
`gate_from_axi` calls for every step of every ladder — so the fix one level up
is defeated by the level below it, on the very ladder that fix left visible.

WHAT THIS FILE PINS.

  * an EMPTY (`""`) status does not map to `passed`, and neither does an ABSENT
    one (`None` — the shape a snapshot whose tabular header omits the `status`
    column really decodes to);
  * silence does not become any OTHER verdict either. `failed` would be a lie
    in the opposite direction, `skipped` claims a decision the tool never
    reported, `running` claims work in progress. Nothing the tool did not say
    may be put in its mouth;
  * an unrecognised but NAMED status still passes through verbatim — `pending`
    above all, the value the real tool emits for every unrun step and the one
    cycle 409's shipped criterion ("`pending` is represented rather than
    dropped") depends on. A fix that funnels everything unknown into a single
    sentinel would satisfy this file's first bullet and break that one, so
    both directions are asserted here;
  * the four recognised statuses keep their exact mappings — the pass-side
    bound that stops a fix quietly re-tabling the vocabulary;
  * and all of it AT THE LADDER LEVEL, through `gate_from_axi`, because the
    ladder is what actually reaches the board. A pure-function test alone
    would leave the real path unpinned.

THE VALUE CHOSEN FOR SILENCE, AND WHY (CR-CRU-117 cycle 410). The acceptance
criterion states a prohibition — never `passed` — and not a replacement, so the
replacement is a decision this cycle makes explicitly, in one named constant
below, rather than leaving it implied by an assertion. `unknown` is chosen
because:

  * it is TRUE. The snapshot carried no status for that row; `unknown` says
    exactly that and claims nothing further. Every other candidate asserts
    something the tool did not report;
  * it is not one of the mapped values, so it can never be confused with a
    status the tool DID give, and it is not one of the server's four gate
    outcomes, so it cannot be misread as a verdict on the run;
  * it survives the wire. `handleGates` (`src/v2.ts`) validates `intent`,
    `outcome` and steps-is-an-array — it does NOT validate step statuses, so
    the value reaches the store verbatim; and the board renders a step status
    as its own text (`public/app.js`'s `gate-step-row` prints `s.status`), so
    a reader sees the word `unknown` rather than a blank or a false tick.

If the orchestrator prefers a different word, it is `UNKNOWN_STATUS` below and
nothing else changes: the prohibition tests bound the behaviour without naming
it, and only the exact-value tests read the constant.

THE FIXTURES are the sibling suites' captured nine-row shape
(`no-mistakes` v1.70.1, captured on this machine 2026-09-10 — the version both
`test_a_run_still_going_is_never_sealed.py` and
`test_a_run_in_flight_streams_its_ladder.py` name), carrying one deliberate
mutation each: a blanked status cell, or a header with no status column. Both
are driven through the client's OWN TOON reader, so nothing here asserts on a
shape the decoder would not really produce.

Invocation:
    python3 -m unittest tests.client.test_a_step_status_nobody_gave_is_not_green
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

INTENT = "map the ladder honestly"

# THE CHOICE, named once. See the module docstring for the reasoning; this is
# the only line to edit if the orchestrator redirects the value.
UNKNOWN_STATUS = "unknown"

# The mapping table as it stands, and as it must still stand after the fix.
# Read off `map_axi_step_status` — the pass-side bound.
RECOGNISED_MAPPINGS = (
    ("completed", "passed"),
    ("skipped", "skipped"),
    ("failed", "failed"),
    ("running", "running"),
)

# Every status that ASSERTS SOMETHING about a step. A row the snapshot said
# nothing about may carry none of them: `passed` is the defect, and the other
# three are the same defect wearing a different coat.
MANUFACTURED_VERDICTS = ("passed", "failed", "skipped", "running")

# The statuses the real tool emits that the table does NOT name. Each must
# survive verbatim — `pending` is the load-bearing one (cycle 409's shipped
# ladder criterion), the other two are states the 2026-09-09 held run sat in
# and are named in the sibling suite's fixtures.
UNRECOGNISED_BUT_NAMED = ("pending", "awaiting_approval", "fixing")

# The nine rows the tool really emits, in order.
TOOL_VERSION = "1.70.1"
SNAPSHOT_HEAD = "a5ad0134"
STEP_NAMES = ("intent", "rebase", "review", "test", "document", "lint",
              "push", "pr", "ci")

_RUN_HEAD = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: running\n'
    '  head: ' + SNAPSHOT_HEAD + '\n'
    '  head_sha: a5ad01346d028653be14854f1573562d8769d4b0\n'
    '  findings: 0\n'
)

# THE LIVE LADDER with ONE CELL BLANKED: `test` reached the wire with an empty
# status. Every other row is the captured shape, so the blanked cell is the
# only thing any assertion below can be turning on.
_BLANK_CELL_ROWS = (
    ("intent", "completed"),
    ("rebase", "completed"),
    ("review", "running"),
    ("test", ""),
    ("document", "pending"),
    ("lint", "pending"),
    ("push", "pending"),
    ("pr", "pending"),
    ("ci", "pending"),
)

_BLANK_CELL_SNAPSHOT = (
    _RUN_HEAD
    + '  steps[9]{step,status,findings,duration_ms}:\n'
    + ''.join('    ' + n + ',' + s + ',0,0\n' for n, s in _BLANK_CELL_ROWS))

# THE STATUS-FREE LADDER: the tabular header omits the `status` field entirely,
# so every decoded row is `{"step": ..., "findings": ..., "duration_ms": ...}`
# and `s.get("status")` is None nine times over. This is the shape that today
# produces a ladder of nine `passed` steps out of a snapshot that said nothing
# about any of them — the defect at its widest.
_STATUS_FREE_SNAPSHOT = (
    _RUN_HEAD
    + '  steps[9]{step,findings,duration_ms}:\n'
    + ''.join('    ' + n + ',0,0\n' for n in STEP_NAMES))

# THE SEALING SHAPE with one blank cell: every row `completed` except `lint`,
# whose status is empty, and the run's own resolved `outcome`. A seal is the
# gate a human reads as the verdict on the whole run, so a ladder under it that
# reads all-green must have EARNED every green row.
_SEALING_ROWS = tuple(
    (n, "" if n == "lint" else "completed") for n in STEP_NAMES)

_SEALING_BLANK_CELL_SNAPSHOT = (
    _RUN_HEAD.replace("  status: running\n", "  status: completed\n")
    + '  steps[9]{step,status,findings,duration_ms}:\n'
    + ''.join('    ' + n + ',' + s + ',0,0\n' for n, s in _SEALING_ROWS)
    + 'outcome: passed\n')

# THE SEALING SHAPE with a blank cell and NO terminus: the same ladder without
# the `outcome` line. `sealed_outcome` answers None for it (no resolved
# outcome, no failed step), which is the honest hold — and the fix to the
# mapper must not disturb that in either direction.
_SEALING_BLANK_CELL_NO_OUTCOME_SNAPSHOT = (
    _SEALING_BLANK_CELL_SNAPSHOT.replace("outcome: passed\n", ""))


def _load_module(path, name):
    """Load the shared module by file path — the fleet harness idiom. A missing
    file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AXI = _load_module(AXI_MODULE_PATH, "axi_under_test_step_status")


# ═════════════════════════════════════════════════════════════════════════════
# THE MAPPER ITSELF
# ═════════════════════════════════════════════════════════════════════════════


class AStatusTheSnapshotNeverGaveIsNotGreenTest(unittest.TestCase):
    """§S2 — the criterion itself, on the function that decides it."""

    def test_an_empty_step_status_does_not_map_to_passed(self):
        self.assertNotEqual(
            _AXI.map_axi_step_status(""), "passed",
            "an EMPTY status is the tool saying nothing about the step, and "
            "`status or \"passed\"` turns that silence into a green row on a "
            "gate a human reads as evidence — the same green bias that was "
            "already removed from `sealed_outcome` one level up (this "
            "module's docstring names the cycle that removed it)")

    def test_a_missing_step_status_does_not_map_to_passed(self):
        self.assertNotEqual(
            _AXI.map_axi_step_status(None), "passed",
            "an ABSENT status (what `s.get(\"status\")` returns when the "
            "snapshot's tabular header carries no `status` field) is not a "
            "pass: nothing was reported about the step at all")

    def test_an_empty_step_status_maps_to_the_named_unknown_status(self):
        self.assertEqual(
            _AXI.map_axi_step_status(""), UNKNOWN_STATUS,
            "silence is reported as silence: " + repr(UNKNOWN_STATUS) + " is "
            "true, is in neither the step vocabulary nor the server's gate "
            "outcomes, and reaches the board verbatim (`handleGates` does not "
            "validate step statuses; the ladder renders the word)")

    def test_a_missing_step_status_maps_to_the_named_unknown_status(self):
        self.assertEqual(
            _AXI.map_axi_step_status(None), UNKNOWN_STATUS,
            "a missing status and an empty one are the same fact — no status "
            "was reported — and must reach the board as the same word, or a "
            "reader has to know which wire shape produced their ladder")

    def test_silence_never_becomes_any_verdict_the_tool_did_not_report(self):
        """The bound. `passed` is the defect; `failed` is the same defect — an
        assertion made up out of no information — pointing the other way, and
        `skipped`/`running` each claim something the snapshot never said."""
        for absent in ("", None):
            with self.subTest(status=absent):
                mapped = _AXI.map_axi_step_status(absent)
                self.assertNotIn(
                    mapped, MANUFACTURED_VERDICTS,
                    "a row the snapshot said nothing about may carry none of "
                    + repr(MANUFACTURED_VERDICTS) + ": each one states a fact "
                    "about the step that nobody reported; got " + repr(mapped))
                self.assertIsInstance(
                    mapped, str,
                    "the ladder's `status` is rendered as text on the board, "
                    "so it must be a string, never None; got " + repr(mapped))
                self.assertTrue(
                    mapped.strip(),
                    "an empty or blank status would reach the board as a gap "
                    "in the ladder, which reads as a rendering bug rather "
                    "than as the fact that nothing was reported; got "
                    + repr(mapped))


class AnUnrecognisedButNamedStatusSurvivesVerbatimTest(unittest.TestCase):
    """PASS-SIDE — cycle 409's shipped behaviour, which the fix must not cost.

    A status the table does not name still SAYS something: the tool reported
    it. Passing it through verbatim is what puts `pending` on an in-flight
    ladder instead of dropping the row, and a fix that mapped everything
    unknown to one sentinel would satisfy the criterion above while breaking
    the criterion this class defends."""

    def test_pending_still_passes_through_verbatim(self):
        self.assertEqual(
            _AXI.map_axi_step_status("pending"), "pending",
            "`pending` is what the real tool emits for every unrun step, and "
            "cycle 409 shipped the criterion that an in-flight ladder carries "
            "all nine names with `pending` REPRESENTED rather than dropped — "
            "it must not be folded into the unknown-status sentinel")

    def test_every_named_status_the_table_does_not_list_survives_verbatim(self):
        for status in UNRECOGNISED_BUT_NAMED:
            with self.subTest(status=status):
                self.assertEqual(
                    _AXI.map_axi_step_status(status), status,
                    "a status the tool NAMED is information, however "
                    "unfamiliar: it reaches the board as itself, so a reader "
                    "sees what the run really reported")
                self.assertNotEqual(
                    _AXI.map_axi_step_status(status), UNKNOWN_STATUS,
                    "a named status is not an unknown one: collapsing "
                    + repr(status) + " into " + repr(UNKNOWN_STATUS)
                    + " would destroy the very fact the ladder exists to "
                    "carry")


class TheRecognisedStatusesKeepTheirMappingsTest(unittest.TestCase):
    """PASS-SIDE — the four the table names. These pass before the fix and must
    pass after it: narrowing the fallback may not re-table the vocabulary."""

    def test_the_four_recognised_statuses_map_exactly_as_they_do_today(self):
        for raw, expected in RECOGNISED_MAPPINGS:
            with self.subTest(status=raw):
                self.assertEqual(
                    _AXI.map_axi_step_status(raw), expected,
                    "the recognised table is untouched by this change: "
                    + repr(raw) + " maps to " + repr(expected))

    def test_completed_is_the_only_status_that_earns_passed(self):
        """`passed` on a ladder means ONE thing: the tool said `completed`.
        Bounded here so no future fallback can widen the green set again."""
        greens = [raw for raw in
                  ["completed", "skipped", "failed", "running", "", None]
                  + list(UNRECOGNISED_BUT_NAMED)
                  if _AXI.map_axi_step_status(raw) == "passed"]
        self.assertEqual(
            greens, ["completed"],
            "exactly one input may produce a `passed` step — the one that "
            "reports the step finished; got " + repr(greens))


# ═════════════════════════════════════════════════════════════════════════════
# THE LADDER — what actually reaches the board
# ═════════════════════════════════════════════════════════════════════════════


class _LadderTestBase(unittest.TestCase):

    def ladder(self, snapshot, final=False):
        """Decode a snapshot through the client's OWN TOON reader and take the
        gate it builds. The decode and the row count are asserted first: a
        fixture that stopped parsing, or a ladder that lost rows, would fail
        the tests below for a reason that is not the defect under test."""
        decoded = _AXI._decode_axi_snapshot(snapshot)
        self.assertIsInstance(
            decoded, dict,
            "harness: the fixture must decode through the client's own TOON "
            "reader before anything can be asserted about the ladder it "
            "produces; got " + repr(decoded))
        gate, nsteps = _AXI.gate_from_axi(decoded, INTENT, final=final)
        self.assertEqual(
            nsteps, 9,
            "harness: the real tool (v" + TOOL_VERSION + ") always emits NINE "
            "rows and every assertion here is about what is inferred from "
            "them; got " + repr(nsteps))
        return gate

    def statuses(self, gate):
        return [s["status"] for s in gate["steps"]]

    def status_of(self, gate, name):
        rows = [s for s in gate["steps"] if s["name"] == name]
        self.assertEqual(
            len(rows), 1,
            "harness: exactly one " + repr(name) + " row on the ladder; got "
            + repr(gate["steps"]))
        return rows[0]["status"]


class ALadderGreensNoStepTheSnapshotLeftBlankTest(_LadderTestBase):
    """§S2 at the level that reaches the board: `gate_from_axi` calls the
    mapper for every row of every ladder, so the defect is posted, not
    hypothetical."""

    def test_an_in_flight_ladder_does_not_green_the_row_with_a_blank_status(self):
        gate = self.ladder(_BLANK_CELL_SNAPSHOT)
        self.assertEqual(
            self.status_of(gate, "test"), UNKNOWN_STATUS,
            "the snapshot carried an empty status for `test`, so the posted "
            "ladder says so — today it says `passed`, which is a green step "
            "invented by the client and attributed to the run")

    def test_a_blank_status_row_leaves_every_other_row_exactly_as_reported(self):
        """The bound: repairing the blank row may not disturb the eight rows
        around it, which are the captured live ladder."""
        gate = self.ladder(_BLANK_CELL_SNAPSHOT)
        self.assertEqual(
            [(s["name"], s["status"]) for s in gate["steps"]
             if s["name"] != "test"],
            [("intent", "passed"), ("rebase", "passed"), ("review", "running"),
             ("document", "pending"), ("lint", "pending"), ("push", "pending"),
             ("pr", "pending"), ("ci", "pending")],
            "the eight reported rows are untouched: two finished, one "
            "running, five still `pending` and REPRESENTED as such")

    def test_a_ladder_with_no_status_column_at_all_posts_no_passed_step(self):
        """The defect at its widest, measured on this tree before the fix: a
        snapshot whose tabular header omits `status` entirely reaches the
        board as NINE `passed` steps — a complete green ladder built out of a
        snapshot that reported nothing about any step."""
        gate = self.ladder(_STATUS_FREE_SNAPSHOT)
        self.assertNotIn(
            "passed", self.statuses(gate),
            "not one green row may be manufactured from a snapshot that named "
            "no statuses at all; got " + repr(gate["steps"]))
        self.assertEqual(
            self.statuses(gate), [UNKNOWN_STATUS] * 9,
            "every row reports the same fact — the snapshot said nothing "
            "about it — and the nine names are still carried, because WHICH "
            "steps went unreported is itself the evidence")

    def test_a_ladder_still_names_every_step_it_could_not_report_a_status_for(self):
        """Anti-vacuity: a fix that DROPPED the unreported rows would satisfy
        "no `passed` step" by deleting the evidence."""
        gate = self.ladder(_STATUS_FREE_SNAPSHOT)
        self.assertEqual(
            [s["name"] for s in gate["steps"]], list(STEP_NAMES),
            "all nine names, in the tool's own order: a row is not repaired "
            "by being removed")


class ASealsLadderDoesNotReadAllGreenOnSilenceTest(_LadderTestBase):
    """§S2 on the SEAL path. A seal is the gate a human reads as the verdict on
    the finished run, so a ladder under it that reads all-green must have
    earned every green row.

    SCOPE. The criterion is about the MAPPER, so what is pinned here is the
    LADDER. The run's own resolved `outcome` is `sealed_outcome`'s business
    (CR-CRU-115), and a blank step status is not a failed one — `any_failed`
    is set from the RAW status before mapping, so silence must not turn a seal
    `failed` either. Both directions are bounded below; no new sealing
    semantics are invented here."""

    def test_a_seal_whose_ladder_has_a_blank_status_is_not_all_green(self):
        gate = self.ladder(_SEALING_BLANK_CELL_SNAPSHOT, final=True)
        self.assertNotEqual(
            set(self.statuses(gate)), {"passed"},
            "eight rows were reported `completed` and one reported nothing: a "
            "seal whose ladder reads as nine-for-nine green is claiming "
            "evidence the run never produced; got " + repr(gate["steps"]))
        self.assertEqual(
            self.status_of(gate, "lint"), UNKNOWN_STATUS,
            "the one unreported row says so by name, so a reader can see "
            "WHICH step the seal has no evidence for")

    def test_a_seal_still_carries_the_runs_own_resolved_outcome(self):
        """PASS-SIDE bound, one direction: the mapper does not reach up and
        change the verdict. The run resolved `passed` and says so."""
        gate = self.ladder(_SEALING_BLANK_CELL_SNAPSHOT, final=True)
        self.assertEqual(
            gate.get("outcome"), "passed",
            "the run's OWN terminus is `sealed_outcome`'s decision and is "
            "untouched by this change; got " + repr(gate))

    def test_a_blank_status_does_not_seal_the_run_failed(self):
        """PASS-SIDE bound, the other direction: `any_failed` is read from the
        RAW status, so an unreported step is not a failure either. A fix that
        mapped silence to `failed` would turn every held run's seal red."""
        gate = self.ladder(_SEALING_BLANK_CELL_NO_OUTCOME_SNAPSHOT, final=True)
        self.assertNotIn(
            "outcome", gate,
            "no resolved outcome and no failed step is a run that reached no "
            "terminus: the seal carries NO outcome key at all — not `passed` "
            "(the bias) and not `failed` (silence read as breakage); got "
            + repr(gate))
        self.assertNotIn(
            "failed", self.statuses(gate),
            "and no row is marked failed either: the tool reported no "
            "failure; got " + repr(gate["steps"]))


if __name__ == "__main__":
    unittest.main()
