"""RED — CR-CRU-098 C1 (client half): `next` becomes a THIN CONSUMER of the
published route.

Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md §S3, AC8/AC9
Classification: docs/changes/CR-CRU-098-test-classification.md

Adapts `NextVerbEnvelopeTest` (tests/client/test_cr092_next_decision_resolver.py,
KEPT per the classification table) onto the §S3 contract: `cmd_next` makes
EXACTLY ONE GET of `.../next` (never `.../queue` again), passing
`track`/`release`/`wave` as query parameters, and emits whatever the route
answers (§S3 — "passes its flags through, and emits what it receives"), never
re-deriving a decision itself. Also carries `LegacyLineStatesTheWaveTest` and
`BothNewDimensionsRideTheOneReadTest`, ported from
`test_next_lane_carries_release_and_wave.py` (KEPT — the human line and the
one-read-per-invocation guarantee are both presentation/transport facts about
the CLIENT, not the resolver).

QUERY-STRING SHAPE — asserted STRUCTURALLY, not by string order. AC8 requires
one GET of `.../next` with the flags "as query parameters"; it does not pin an
ORDER, so every assertion below parses the request with `urlsplit`/`parse_qsl`
and compares (a) the base path and (b) the PARAMS AS A DICT. Pinning a literal
ordered query string would be over-specification GREEN could only satisfy by
matching this file's arbitrary choice.

RED expectation: TODAY's `cmd_next` still issues its ONE `GET .../queue` (no
query string at all — clients/_crucible_axi.py:2924-2925) — every AC8 path
assertion below fails on that fact, which is the missing contract, not a
broken harness. The byte-identity halves (AC9) mostly hold TRIVIALLY even in
RED (this CR's own Non-goal: semantics are unchanged, and `resolve_next` is
still present and unmodified) — that is expected and correct: they pin the
target GREEN must keep hitting once the transport underneath changes, and each
test still fails overall on its bundled AC8 path assertion.

AC13 — every fixture is synthetic (`CR-NEXTPTR-*`, registered in
tests/project-namespace-tripwire.test.ts's SYNTHETIC_NAMESPACES).

Invocation:
    python3 -m pytest tests/client/test_cr098_next_verb_reads_the_route.py -q
"""

import contextlib
import importlib.util
import io
import os
import re
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qsl, urlsplit

from tests.client import cr098_next_oracle

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

PROJECT_KEY = "cr098-next-verb-key"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"
NEXT_PATH_BASE = f"/api/v2/projects/{PROJECT_KEY}/next"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr098_axi_under_test")
TOON = _load(TOON_PATH, "cr098_toon")


def _split_request(path):
    """AC8, parsed rather than pinned to one order: `(base_path, params_dict)`.
    `parse_qsl` — never a raw string compare — so a GREEN that emits
    `?wave=7&track=2` and one that emits `?track=2&wave=7` are the SAME
    request as far as this file is concerned."""
    parts = urlsplit(path)
    return parts.path, dict(parse_qsl(parts.query))


def _expected_params(track=None, release=None, wave=None):
    return {k: v for k, v in (("release", release), ("track", track), ("wave", wave))
            if v is not None}


def _entry(cr, seq, status="PENDING", wave="5", release=None, track=None,
           depends_on=(), lifecycle=None):
    entry = {"cr": cr, "wave": wave, "dependsOn": list(depends_on),
             "status": status, "seq": seq}
    if release is not None:
        entry["release"] = release
    if track is not None:
        entry["track"] = track
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    return entry


def _published_tracks(entries):
    return sorted({(e.get("track") or "").strip() for e in entries
                   if (e.get("track") or "").strip()})


def _queue(*entries):
    return {"ok": True, "entries": list(entries), "tracks": _published_tracks(entries)}


def _route_response(entries, track=None, release=None, wave=None):
    """The payload a GREEN `GET .../next` route publishes for this board —
    built from the FROZEN answers of the old client `resolve_next` (semantics
    unchanged, the CR's own Non-goals; frozen in
    tests/fixtures/cr098-next-oracle.json because AC10 deletes the function),
    wrapped as §S2 describes: the whole answer, `ok` and
    `warnings[]` included. The refusal ALSO carries an `error` string
    (`fail()`'s own first argument, src/v2.ts:191) that TODAY's client-computed
    refusal never had — proving GREEN's `cmd_next` must not blindly relay it
    into the envelope (AC9's byte-identity with today's refusal shape)."""
    tracks = _published_tracks(entries)
    scope = {k: v for k, v in (("track", track), ("release", release),
                               ("wave", wave)) if v is not None}
    ok, code, fields, warnings = cr098_next_oracle.RESOLVER(entries, tracks, scope)
    body = dict(fields)
    body["ok"] = ok
    body["warnings"] = warnings
    if not ok:
        body["error"] = "next --track <n> required" if "needs" in fields else "unreadable"
    return ok, code, body


class _RecordingOps:
    """Answers BOTH the old `.../queue` path (so today's still-unmodified
    `cmd_next` keeps computing a real decision — needed so the byte-identity
    half of AC9 says something meaningful RIGHT NOW) AND the new `.../next`
    path (what GREEN's `cmd_next` must ask for instead), matched by BASE PATH
    only — the query string's shape is the TEST's business, never the
    fixture's. `self.gets` records EVERY path asked, so AC8 is checked as the
    EXACT list, not merely 'contains'. Any THIRD base path is a bug in the
    test itself and raises loudly."""

    def __init__(self, entries, next_body):
        self.entries = entries
        self.next_body = next_body
        self.gets = []
        self.writes = []
        self.agent_id_calls = 0
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
            base_url="http://127.0.0.1:0")

    def _get(self, path):
        self.gets.append(path)
        base, _params = _split_request(path)
        if base == QUEUE_PATH:
            return _queue(*self.entries)
        if base == NEXT_PATH_BASE:
            return self.next_body
        raise AssertionError(
            f"cmd_next asked for an unexpected path: {path!r} (expected "
            f"either the RETIRING {QUEUE_PATH!r} or AC8's "
            f"{NEXT_PATH_BASE!r})")

    def _write(self, method):
        def _recorded(*args, **kwargs):
            self.writes.append((method, args, kwargs))
            return {"ok": True}
        return _recorded

    def _context(self, project_dir, **kwargs):
        return AXI.axi_context(PROJECT_KEY, **kwargs)

    def _agent_id(self, args):
        self.agent_id_calls += 1
        return "should-never-be-asked"


class _FailedReadOps(_RecordingOps):
    """AC9's failed-read scenario: BOTH paths answer the same transport
    failure shape (no `needs`, no decision fields at all), because the client
    cannot tell in advance which path a not-yet-migrated `cmd_next` will ask."""

    def _get(self, path):
        self.gets.append(path)
        return {"ok": False, "error": "connection refused"}


def _args(**overrides):
    values = {"project_dir": None, "track": None, "release": None, "wave": None,
              "fields": None}
    values.update(overrides)
    return Namespace(**values)


class _NextVerbTestBase(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)

    def drive(self, entries, **flags):
        track, release, wave = flags.get("track"), flags.get("release"), flags.get("wave")
        _ok, _code, body = _route_response(entries, track=track, release=release, wave=wave)
        recorder = _RecordingOps(entries, body)
        return self._run(recorder, **flags)

    def drive_failed(self, entries, **flags):
        recorder = _FailedReadOps(entries, {"ok": False, "error": "connection refused"})
        return self._run(recorder, **flags)

    def _run(self, recorder, **flags):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = AXI.cmd_next(_args(**flags), "/fake/dir", recorder.ops)
        decoded = TOON.decode(out.getvalue())
        return code, out.getvalue(), err.getvalue(), decoded["axi"], recorder

    def assertNextRequest(self, ops, track=None, release=None, wave=None):
        """AC8 — exactly one request, its BASE PATH the `.../next` route, and
        its query parameters the flags given, AS A SET, never an ordered
        string. Fails loudly (and separately) on each of the three ways
        TODAY's client still violates this: wrong base path, extra requests,
        or (today, always, since it never even reaches `.../next`) params
        that were never sent at all."""
        self.assertEqual(
            len(ops.gets), 1,
            f"AC8: exactly one GET; got {ops.gets!r}")
        base, params = _split_request(ops.gets[0])
        self.assertEqual(
            base, NEXT_PATH_BASE,
            f"AC8: `next` must read `.../next`, never `.../queue`; asked for "
            f"{ops.gets[0]!r}")
        self.assertEqual(
            params, _expected_params(track=track, release=release, wave=wave),
            f"AC8: the flags ride the GET as query parameters, no more and "
            f"no fewer; got {params!r}")


LANE = (_entry("CR-NEXTPTR-100", 10, wave="5"),)

TWO_TRACK_LANE = (
    _entry("CR-NEXTPTR-100", 10, wave="5", track="track-1"),
    _entry("CR-NEXTPTR-200", 20, wave="5", track="track-2"),
)

HOLD_FIXTURES = {
    "in-flight": ([_entry("CR-NEXTPTR-RUN", 10, status="IN_PROGRESS"),
                   _entry("CR-NEXTPTR-WAIT", 20)], {}),
    "dependency": ([_entry("CR-NEXTPTR-DEP", 10, track="track-2"),
                    _entry("CR-NEXTPTR-TARGET", 20, track="track-1",
                           depends_on=["CR-NEXTPTR-DEP"])], {"track": "track-1"}),
    "unknown-dependency": ([_entry("CR-NEXTPTR-TARGET", 10,
                                   depends_on=["CR-NEXTPTR-GHOST"])], {}),
    "dead-dependency": ([_entry("CR-NEXTPTR-DEAD", 10,
                                lifecycle={"state": "VOID", "reason": "x"}),
                         _entry("CR-NEXTPTR-TARGET", 20,
                               depends_on=["CR-NEXTPTR-DEAD"])], {}),
}

DRAINED_FIXTURES = {
    "no-roadmap": ((), {}),
    "awaiting-assignment": ((_entry("CR-NEXTPTR-A", 10, track="track-1"),), {"track": "9"}),
    "wave-complete": ((_entry("CR-NEXTPTR-A", 10, status="COMPLETED"),), {}),
}

# ═══════════════════════════════════════════════════════════════════════════
# AC8 — the ONE GET, .../next, flags as query parameters, never .../queue
# ═══════════════════════════════════════════════════════════════════════════


class NextReadsTheRouteTest(_NextVerbTestBase):

    def test_exactly_one_get_of_next_and_never_of_queue(self):
        _code, _out, _err, _axi, ops = self.drive(list(LANE))
        self.assertNextRequest(ops)

    def test_track_release_wave_ride_the_get_as_query_parameters(self):
        entries = [_entry("CR-NEXTPTR-100", 10, wave="7", release="0.2.0", track="track-2"),
                   _entry("CR-NEXTPTR-200", 20, wave="7", track="track-1")]
        _code, _out, _err, _axi, ops = self.drive(
            entries, track="2", release="0.2.0", wave="7")
        self.assertNextRequest(ops, track="2", release="0.2.0", wave="7")

    def test_no_flags_means_no_query_string_at_all(self):
        _code, _out, _err, _axi, ops = self.drive(list(LANE))
        self.assertNextRequest(ops)
        self.assertNotIn("?", ops.gets[0] if ops.gets else "")

    def test_a_drive_supplying_both_new_dimensions_reads_the_route_exactly_once(self):
        """Ported from `BothNewDimensionsRideTheOneReadTest` (test_next_lane_
        carries_release_and_wave.py) — narrowing is a question about the
        payload already in hand: a reader that asked the server to narrow for
        it would cost a round-trip per dimension. Both flags supplied at once
        still cost exactly one request."""
        entries = [_entry("CR-NEXTPTR-U1", 6001, wave="6"),
                   _entry("CR-NEXTPTR-D2", 6002, wave="6", release="0.2.0")]
        _code, _out, _err, axi, ops = self.drive(
            entries, release="0.2.0", wave="6")
        self.assertEqual(axi.get("cr"), "CR-NEXTPTR-D2")
        self.assertNextRequest(ops, release="0.2.0", wave="6")


# ═══════════════════════════════════════════════════════════════════════════
# AC9 — output is byte-identical to today's, across every outcome
# ═══════════════════════════════════════════════════════════════════════════


class NextOutputStaysByteIdenticalTest(_NextVerbTestBase):

    def test_next_exits_zero_with_todays_decision_fields(self):
        code, _out, _err, axi, ops = self.drive(list(LANE))
        self.assertEqual(code, 0)
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-NEXTPTR-100")
        self.assertEqual(axi.get("seq"), 10)
        self.assertNextRequest(ops)

    def test_every_hold_kind_exits_zero_and_carries_the_same_trigger_as_today(self):
        for kind, (entries, flags) in sorted(HOLD_FIXTURES.items()):
            with self.subTest(kind=kind):
                code, _out, _err, axi, ops = self.drive(entries, **flags)
                self.assertEqual(code, 0)
                self.assertEqual(axi.get("decision"), "HOLD")
                self.assertEqual(axi["trigger"].get("kind"), kind)
                self.assertNextRequest(ops, **flags)

    def test_every_drained_reason_exits_zero_and_never_carries_a_cr(self):
        for reason, (entries, flags) in sorted(DRAINED_FIXTURES.items()):
            with self.subTest(reason=reason):
                code, _out, _err, axi, ops = self.drive(list(entries), **flags)
                self.assertEqual(code, 0)
                self.assertEqual(axi.get("decision"), "DRAINED")
                self.assertEqual(axi.get("reason"), reason)
                self.assertNotIn("cr", axi)
                self.assertNextRequest(ops, **flags)

    def test_the_multitrack_refusal_exits_two_and_carries_no_error_or_ok_leak(self):
        code, stdout, _err, axi, ops = self.drive(list(TWO_TRACK_LANE))
        self.assertEqual(code, 2)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("needs"), ["track"])
        self.assertEqual(axi.get("tracks"), ["track-1", "track-2"])
        self.assertEqual(axi.get("totalCount"), 2)
        self.assertNotIn("decision", axi)
        self.assertNotIn(
            "error", axi,
            "AC9: today's refusal carries no bare `error` key at the axi "
            "envelope level — GREEN must not blindly relay the route's "
            "`fail()` wrapper string into the projected fields")
        self.assertTrue(stdout.startswith("axi:"))
        self.assertNextRequest(ops)

    def test_a_failed_read_exits_one_with_no_decision_key_and_a_named_warning(self):
        code, _out, _err, axi, ops = self.drive_failed(list(LANE))
        self.assertEqual(code, 1)
        self.assertIs(axi.get("ok"), False)
        self.assertNotIn("decision", axi)
        warnings = axi.get("warnings") or []
        self.assertTrue(warnings, "a failed read must be NAMED in a structured warning")
        self.assertIn("connection refused",
                      " ".join(w.get("detail", "") for w in warnings))
        # AC8 still applies to the failure path: the client must ask .../next
        # (or, TODAY, still .../queue) exactly once, never both.
        self.assertEqual(len(ops.gets), 1)

    def test_two_consecutive_invocations_are_byte_identical(self):
        first = self.drive(list(LANE))[1]
        second = self.drive(list(LANE))[1]
        self.assertEqual(first, second)
        self.assertNotEqual(first, "")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 — the presentation-only pieces `next` keeps: --fields, context, no
# --agent, and the human line (ported from LegacyLineStatesTheWaveTest,
# test_next_lane_carries_release_and_wave.py)
# ═══════════════════════════════════════════════════════════════════════════

_WAVE_STATED = re.compile(r"wave[= ](\S+)\b")


class NextPresentationLayerTest(_NextVerbTestBase):

    def test_fields_still_narrows_a_real_decision_but_never_the_refusal(self):
        code, _out, _err, axi, ops = self.drive(list(LANE), fields="decision,cr")
        self.assertEqual(code, 0)
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-NEXTPTR-100")
        for dropped in ("seq", "wave", "help"):
            self.assertNotIn(dropped, axi)
        self.assertNextRequest(ops)

        refusal_code, _out2, _err2, refusal_axi, _ops2 = self.drive(
            list(TWO_TRACK_LANE), fields="decision")
        self.assertEqual(refusal_code, 2)
        self.assertEqual(refusal_axi.get("needs"), ["track"])
        self.assertTrue(refusal_axi.get("help"))

    def test_the_context_carries_the_lane_the_answer_resolved(self):
        os.environ["WORKFLOW_ROLE"] = "track-1"
        _code, _out, _err, axi, ops = self.drive(list(TWO_TRACK_LANE), track="2")
        self.assertEqual(axi.get("cr"), "CR-NEXTPTR-200")
        self.assertEqual((axi.get("context") or {}).get("track"), "track-2")
        self.assertNextRequest(ops, track="2")

    def test_a_single_track_project_still_stamps_the_canonicalised_flag(self):
        """AC9's edge, pinned (CR-CRU-098 \u00a7S4, corrected at C3): in a
        SINGLE-track project the answer carries no `track` (AC4's lane-field
        rule), yet `next --track 2` has always stamped `context.track` with
        the canonicalised flag. A client that took the lane from the answer
        alone would let the session's declaration stand instead \u2014 a changed
        envelope for the same board. So `canonical_track` stays client-side."""
        os.environ["WORKFLOW_ROLE"] = "track-1"
        _code, _out, _err, axi, ops = self.drive(list(LANE), track="2")
        self.assertNotIn(
            "track", axi,
            "non-vacuity: a single-track answer carries no `track` field, or "
            "this is not the edge the stamp has to cover")
        self.assertEqual((axi.get("context") or {}).get("track"), "track-2")
        self.assertNextRequest(ops, track="2")

    def test_the_verb_never_asks_for_an_agent_identity(self):
        _code, _out, _err, axi, ops = self.drive(list(LANE))
        self.assertEqual(ops.agent_id_calls, 0)
        self.assertNotIn("agentId", axi.get("context") or {})

    def test_each_decision_line_states_the_wave_it_answered_for(self):
        """Ported from `LegacyLineStatesTheWaveTest` — the stderr channel is
        where an orchestrator reads the answer when it is not parsing the
        envelope, so a decision that names no container there is the silent
        crossing in prose. Stays client-side: `_next_legacy_line` is built
        from the PROJECTED fields, never re-derived from a second read."""
        wave = "6"
        boards = {
            "NEXT": [_entry("CR-NEXTPTR-N1", 6001, wave=wave)],
            "HOLD": [_entry("CR-NEXTPTR-H1", 6001, wave=wave, status="IN_PROGRESS"),
                    _entry("CR-NEXTPTR-H2", 6002, wave=wave)],
            "DRAINED": [_entry("CR-NEXTPTR-X1", 6001, wave=wave, status="COMPLETED")],
        }
        silent = {}
        for decision, entries in boards.items():
            _code, _out, stderr, axi, _ops = self.drive(entries)
            self.assertEqual(axi.get("decision"), decision)
            if not _WAVE_STATED.search(stderr):
                silent[decision] = stderr
        self.assertEqual(
            silent, {},
            f"every decision's legacy line must state its wave; these did "
            f"not: {silent!r}")


if __name__ == "__main__":
    unittest.main()
