"""RED — CR-CRU-095 C1 (client half): `resolve_next` consumes the PUBLISHED order.

Spec: docs/changes/CR-CRU-095-seq-scales-collide.md §S1, AC6/AC6a/AC6b
Server half of the same cycle: tests/queue-canonical-order.test.ts

WHAT THIS FILE COVERS. §S1 makes the SERVER publish one canonical order —
the sort key `(wave number, release version with an undeclared release last
within its wave, seq)`. That fix alone does not fix `next`, and this file is
the proof-shaped statement of why.

    `resolve_next` does `lane = sorted(lane, key=_lane_order)`
    (clients/_crucible_axi.py:1510), and `_lane_order` returns `(0, seq)`
    (:1301-1308).

It RE-SORTS BY THE SEQ VALUE, discarding the position the server published. Run
unchanged against a canonically ordered payload of the live board's 94 rows, its
`actionable[0]` is still `CR-CRU-015` at seq 62 — AC7's forbidden answer. So the
CR's original claim that "`resolve_next` needs no change at all" was wrong, and
AC6 as first written ("the client stays UNCHANGED") made AC7 unsatisfiable. Both
were amended: the re-sort is DELETED and the lane is taken in the order the
server published — CR-091 AC18's principle ("a reader does not re-derive order")
applied to the client, with zero comparators in the client.

Covered here: AC6 (published-order consumption, no ordering left in the client)
and AC6a (a seq-less row keeps its published position AND still warns).
Deliberately NOT here: the server key (the bun file above), `queue_tracks`,
track scoping §S3, and the HOLD/DRAINED logic — AC6 keeps all of those
unchanged, so this file asserts on the ORDER ONLY and re-asserts nothing that
tests/client/test_cr092_next_decision_resolver.py already owns.

AC6b — the regression list, MEASURED not guessed. Modelling the GREEN (patching
`_lane_order` to a constant key, so Python's stable sort preserves the published
order) and running the whole CR-092 suite leaves 75 of 77 tests passing. Exactly
two assert the seq re-sort itself, and GREEN amends them:

    LaneOrderTest.test_the_lane_is_ordered_by_the_published_seq
        (tests/client/test_cr092_next_decision_resolver.py:1324) — feeds a
        deliberately SCRAMBLED response [seq 30, 10, 20] and asserts the pick is
        the seq-10 row. Its subject becomes "the lane arrives ordered and the
        resolver consumes position 0"; its §S4 intent ("`next` never re-orders
        the lane") is what AC6 finally makes true.

    LaneOrderTest.test_an_entry_with_no_seq_is_surfaced_rather_than_positioned
        (:1336) — publishes the seq-less row FIRST and asserts the pick is the
        seq-10 row, i.e. that the seq-less row was moved LAST. AC6a inverts the
        pick half (the row keeps its published position) and keeps the warning
        half verbatim: `missing-seq` still fires and still names the cr.

Neither is modified here — naming them is this cycle's contract (AC6b).

RED expectation: every test below fails on the ORDER — the resolver answers the
low-seq row where the published order named another. No test here touches
`clients/`; the module is loaded read-only, exactly as the CR-092 suite loads it.

Invocation:
    python3 -m pytest tests/client/test_cr095_next_consumes_published_order.py -q
"""

import ast
import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr095_axi_under_test")


# ═══════════════════════════════════════════════════════════════════════════
# Fixtures — the wire shape `Store.listQueue` publishes, ALREADY in the
# canonical order §S1 makes it publish (src/store.ts:3465-3498)
# ═══════════════════════════════════════════════════════════════════════════


def _entry(cr, seq, status="PENDING", wave="5", release=None, lifecycle=None):
    """One `GET …/queue` entry, following the CR-092 fixture's rule:
    `release`/`lifecycle` are OMITTED when not declared, exactly as the server
    omits them, so a resolver that defaults them is caught rather than
    humoured. `seq` is published on every row (CR-091 §S2) — the one fixture
    below that omits it is AC6a's, and it omits it on purpose."""
    entry = {"cr": cr, "wave": wave, "dependsOn": [], "status": status,
             "seq": seq}
    if release is not None:
        entry["release"] = release
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    return entry


def _live_board_canonical():
    """The live board's mixture (read 2026-09-02), in the order §S1 publishes:
    wave 5's declared 0.2.0 block, then the deferred UNDECLARED wave-6 rows
    whose positional seq values are two orders of magnitude lower.

    `dependsOn` is empty on every row on purpose. AC7's premise is "both
    PENDING with deps satisfied", and dependency triggers are CR-092's subject
    — leaving them out keeps a failure here attributable to the ORDER alone."""
    return [
        _entry("CR-CRU-096", 5023, release="0.2.0"),
        _entry("CR-CRU-079", 5024, release="0.2.0"),
        _entry("CR-CRU-085", 5025, release="0.2.0"),
        _entry("CR-CRU-015", 62, wave="6"),
        _entry("CR-CRU-018", 64, wave="6"),
        _entry("CR-CRU-022", 65, wave="6"),
    ]


class _NextTestBase(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)

    def resolve(self, entries, track=None):
        return AXI.resolve_next(entries, track=track)

    def fields(self, entries, track=None):
        _ok, _code, fields, _warnings = self.resolve(entries, track=track)
        return fields


# ═══════════════════════════════════════════════════════════════════════════
# AC6 — the published order IS the order
# ═══════════════════════════════════════════════════════════════════════════


class PublishedOrderIsConsumedTest(_NextTestBase):
    """AC6 — `actionable[0]` is the first actionable row IN THE ORDER THE
    SERVER PUBLISHED. Today `sorted(lane, key=_lane_order)` re-derives the
    order from the seq VALUE, which is the reader-side derivation CR-091 AC18
    deleted from `buildRoadmapGraph` — the same defect, one layer out."""

    def test_the_live_boards_canonical_payload_answers_a_020_cr_not_cru_015(self):
        """AC6 + AC7 — THE REPRODUCTION, at the client boundary. Handed the
        live board's rows in canonical order, the verb must answer the active
        release. Today it answers CR-CRU-015 at seq 62, because 62 < 5023."""
        entries = _live_board_canonical()

        fields = self.fields(entries)

        self.assertEqual(
            fields.get("cr"), "CR-CRU-096",
            f"the published order names CR-CRU-096 first; the resolver "
            f"answered {fields.get('cr')!r} at seq {fields.get('seq')!r}, "
            f"which is the seq-value re-sort, not the published position")
        self.assertEqual(fields.get("seq"), 5023)

    def test_the_lane_is_taken_in_published_position_not_seq_value_order(self):
        """AC6, minimal — two rows whose published order DISAGREES with their
        seq order. Position decides; the value is carried, never consulted."""
        entries = [_entry("CR-PUBLISHED-FIRST", 5001, release="0.2.0"),
                   _entry("CR-PUBLISHED-SECOND", 62, wave="6")]

        fields = self.fields(entries)

        self.assertEqual(fields.get("cr"), "CR-PUBLISHED-FIRST")
        self.assertEqual(fields.get("seq"), 5001)

    def test_a_non_actionable_row_is_skipped_without_reordering_the_lane(self):
        """AC6 — "first ACTIONABLE in published order" is not "lowest seq".
        The two rows the oracle must skip are published FIRST, and skipping
        them must not promote a lower-seq row from further down the lane."""
        entries = [
            _entry("CR-DONE", 5001, status="COMPLETED", release="0.2.0"),
            _entry("CR-VOIDED", 5002, release="0.2.0",
                   lifecycle={"state": "VOID", "reason": "not happening"}),
            _entry("CR-THE-ANSWER", 5003, release="0.2.0"),
            _entry("CR-DEFERRED", 62, wave="6"),
        ]

        fields = self.fields(entries)

        self.assertEqual(
            fields.get("cr"), "CR-THE-ANSWER",
            "a COMPLETED row and a VOID row are skipped on the two axes "
            "(`_is_actionable`); the next PUBLISHED row is the answer, not the "
            "lowest-seq one")

    def test_resolve_next_no_longer_orders_anything(self):
        """AC6 — "the client contains ZERO comparators". `resolve_next` sorted
        exactly one thing, the lane, so the guard is that it now sorts nothing:
        no `sorted(...)` and no `.sort(...)` in its body. Structural on purpose
        and narrow on purpose — the CR-092 suite sets the precedent for an AST
        guard (:1424-1442), and a behavioural test cannot distinguish "consumes
        the published order" from "re-sorts by a key that happens to agree"."""
        source = AXI_MODULE_PATH.read_text(encoding="utf-8")
        functions = [node for node in ast.parse(source).body
                     if isinstance(node, ast.FunctionDef)
                     and node.name == "resolve_next"]
        self.assertEqual(len(functions), 1,
                         "`resolve_next` lands ONCE in the shared module")

        sorts = []
        for node in ast.walk(functions[0]):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name) and node.func.id == "sorted":
                sorts.append(f"sorted() at line {node.lineno}")
            if isinstance(node.func, ast.Attribute) and node.func.attr == "sort":
                sorts.append(f".sort() at line {node.lineno}")
        self.assertEqual(
            sorts, [],
            f"`resolve_next` still orders the lane itself: {sorts} — §S1 makes "
            f"the SERVER the single source of ordering truth, and a reader "
            f"that re-sorts is what CR-091 AC18 outlawed")


# ═══════════════════════════════════════════════════════════════════════════
# AC6a — a seq-less row: warned about, never repositioned
# ═══════════════════════════════════════════════════════════════════════════


class SeqlessRowKeepsItsPublishedPositionTest(_NextTestBase):
    """AC6a — the `missing-seq` warning is UNCHANGED, and the row it names
    keeps the position the server gave it.

    This deliberately supersedes the pick half of
    `LaneOrderTest.test_an_entry_with_no_seq_is_surfaced_rather_than_positioned`
    (AC6b): that test asserts the seq-less row is moved LAST, which is
    `_lane_order`'s `(1, 0)` branch — vestigial once the client stops ordering.
    The WARNING half is unchanged and re-asserted here, so nothing is lost."""

    def _seqless_lane(self):
        return [{"cr": "CR-NOSEQ", "wave": "5", "dependsOn": [],
                 "status": "PENDING"},
                _entry("CR-OK", 10)]

    def test_a_row_published_without_seq_keeps_its_published_position(self):
        entries = self._seqless_lane()

        fields = self.fields(entries)

        self.assertEqual(
            fields.get("cr"), "CR-NOSEQ",
            "the server published CR-NOSEQ first, so it is first — moving it "
            "last is the client deciding an order, which AC6 removes")

    def test_the_missing_seq_warning_still_fires_and_names_the_cr(self):
        entries = self._seqless_lane()

        _ok, code, _fields, warnings = self.resolve(entries)

        codes = [warning.get("code") for warning in warnings]
        self.assertIn(
            "missing-seq", codes,
            f"AC6a keeps the warning: 091 publishes `seq` on every entry, so "
            f"an absent one stays a defect to surface; got {warnings!r}")
        self.assertIn("CR-NOSEQ",
                      " ".join(w.get("detail", "") for w in warnings))
        self.assertEqual(code, 0, "a warning never changes the exit code")


if __name__ == "__main__":
    unittest.main()
