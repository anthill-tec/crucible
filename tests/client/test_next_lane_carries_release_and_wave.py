"""RED — the `next` lane carries its RELEASE and its WAVE, and a drained lane
is not a complete wave.

Covers §S1 (the two new flags and the wave predicate), §S3 (lane vs wave), §S4
(the envelope names the container it answered for) and the two agreement
criteria the wave-scope guard's shipped constraint added. §S2's boundary
ANNOUNCEMENT is deliberately out of scope here and belongs to the next cycle;
nothing in this file asserts on it.

WHAT IS DRIVEN, AND WHY IT IS THE VERB AND NOT THE RESOLVER. Every behavioural
assertion below runs the real `cmd_next` over a real queue payload through the
real emitter, exactly as the sibling resolver suites do. That is not merely
idiom: the two new dimensions arrive as `--release` and `--wave`, whose
argparse dests are fixed by their own spelling, so a test driven through the
verb cannot fail because GREEN chose a different internal parameter name for
the resolver. It fails only when the BEHAVIOUR is absent.

FIXTURE IDS carry a namespace no project owns, and none of them matches the
tripwire's own CR-literal shape, so no assertion in this file names a real
board row.

THE ONE PLACE THIS FILE READS AN AC NARROWLY, stated rather than implied. §S1
requires the wave predicate's result to be byte-identical for `--track 1`,
`--track 2` and NO track. On a project publishing two lanes, a bare no-track
call is the shipped §S3 usage refusal — it carries no decision at all, and
lifting that refusal is not this CR's business. The third leg is therefore
taken over the SAME wave axis with the track dimension removed: same waves,
same statuses, same published order, no `track` on any row. That is precisely
the claim the AC makes — the track dimension must not participate — and it
still discriminates, because today the tracked and untracked readings of one
wave disagree.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from argparse import Namespace
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# §S1's own words: the flags are asserted PER CLIENT and the count of clients
# asserted is itself asserted. A loop over a list is satisfied by a list of
# one, which is the specific defect this constant exists to prevent.
EXPECTED_CLIENT_COUNT = 5

PROJECT_KEY = "next-lane-key"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"
BASE_URL = "http://127.0.0.1:0"

# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# Nothing listens on port 1 without root — the fleet's own help-drive idiom.
# `--help` never reaches the wire, but a drive that somehow did must refuse
# instantly rather than touch a live board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "next_lane_axi_under_test")
TOON = _load(TOON_PATH, "next_lane_toon")


# ═══════════════════════════════════════════════════════════════════════════
# The scratch board — a real server on a free port, for the agreement alone
# ═══════════════════════════════════════════════════════════════════════════
#
# The sibling resolver suite's idiom, taken rather than re-invented: a server
# of this repo's own source, a free port and a `mkdtemp` DB — never the live
# instance and never the shared project.


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _http(base, path, payload=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which IS the assertion subject for a refusal."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method="POST" if data else "GET",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=30.0):
    """Block until the scratch server answers its orientation route, or fail
    naming the boot that never happened — never silently proceed against a
    port nothing is listening on."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise AssertionError(
                f"the scratch server exited before it was ready "
                f"(exit {proc.returncode})")
        try:
            _http(base, "/api/v2")
            return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"the scratch server never became ready at {base}")


# ═══════════════════════════════════════════════════════════════════════════
# Fixtures — the wire shape the queue read publishes
# ═══════════════════════════════════════════════════════════════════════════

# The wave every single-wave fixture below lives in, named once so a test that
# asserts the resolved wave and a fixture that declares it cannot drift.
WAVE = "6"


def _entry(cr, seq, status="PENDING", wave=WAVE, release=None, track=None,
           depends_on=(), lifecycle=None):
    """One queue entry. `release`/`track`/`lifecycle` are OMITTED when not
    declared — exactly as the server omits them — so a reader that defaults
    them is caught rather than humoured. `wave` is always present, because the
    server always publishes it, and the empty string is a REAL published value
    (the write-side guard's own un-waved row)."""
    entry = {"cr": cr, "wave": wave, "dependsOn": list(depends_on),
             "status": status, "seq": seq}
    if release is not None:
        entry["release"] = release
    if track is not None:
        entry["track"] = track
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    return entry


def _untracked(entries):
    """The same rows with the TRACK dimension removed and nothing else touched
    — the third leg of the wave-predicate identity (see the module docstring).
    Order, seq, wave, status and release are carried through verbatim."""
    return tuple({k: v for k, v in e.items() if k != "track"} for e in entries)


def _published_tracks(entries):
    """What the queue read publishes BESIDE its entries: the sorted distinct
    non-blank TRIMMED `track` values. One spelling of the server's rule, taken
    from the sibling resolver suite rather than re-worded, so the two harnesses
    cannot drift into two ideas of what the read publishes."""
    return sorted({(e.get("track") or "").strip() for e in entries
                   if (e.get("track") or "").strip()})


def _queue(*entries):
    return {"ok": True, "entries": list(entries),
            "tracks": _published_tracks(entries)}


# ── §S3's reusable instrument: ONE wave, INCOMPLETE, two lanes ─────────────
#
# track-1's whole half has landed; track-2 still holds actionable work, so the
# WAVE is demonstrably unfinished while the LANE is empty. That is the exact
# arrangement in which the shipped resolver answers a membership question
# ("this wave is complete") from a scheduling filter, and it is the arrangement
# both §S3 criteria are read over — one from each lane, so the second proves
# the first was not a wave completion after all.
TWO_TRACK_INCOMPLETE_WAVE = (
    _entry("CR-L6-1", 6001, status="COMPLETED", track="track-1"),
    _entry("CR-L6-2", 6002, status="COMPLETED", track="track-1"),
    _entry("CR-L6-3", 6003, track="track-2"),
    _entry("CR-L6-4", 6004, track="track-2"),
)


def _decision_fixtures(track=None, release=None):
    """One single-wave fixture per DECISION, keyed by the decision it produces,
    so the envelope criteria are asserted across all three answers rather than
    on whichever one a single fixture happens to give.

      NEXT     one actionable row.
      HOLD     an occupied lane ahead of an actionable row (`in-flight`).
      DRAINED  nothing actionable in the lane at all.
    """
    common = {"wave": WAVE, "track": track, "release": release}
    return {
        "NEXT": (_entry("CR-N1-1", 6001, **common),),
        "HOLD": (_entry("CR-H1-1", 6001, status="IN_PROGRESS", **common),
                 _entry("CR-H2-1", 6002, **common)),
        "DRAINED": (_entry("CR-X1-1", 6001, status="COMPLETED", **common),),
    }


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
        self.writes = []          # every non-GET the verb attempts
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
        self.agent_id_calls += 1
        return "should-never-be-asked"


def _args(**overrides):
    """The Namespace `next`'s subparser produces once it declares all three
    lane flags. There is deliberately no `agent` key: the verb writes nothing,
    and a Namespace carrying one would hide its absence."""
    values = {"project_dir": None, "track": None, "release": None, "wave": None}
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
        """Run the real `cmd_next` over `entries` → (fields, stderr, code).

        The RECORDER stays on the case as `self.recorder`: what the verb asked
        the server for is a fact about the drive that just happened, and the
        round-trip criterion is asserted on it."""
        recorder = _RecordingOps(_queue(*entries))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = AXI.cmd_next(_args(**flags), "/fake/dir", recorder.ops)
        self.recorder = recorder
        fields = TOON.decode(out.getvalue())["axi"]
        return fields, err.getvalue().strip(), code

    def fields(self, entries, **flags):
        return self.drive(entries, **flags)[0]


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — the flag surface
# ═══════════════════════════════════════════════════════════════════════════


def _next_subparser():
    """The REAL `next` subparser, built by the shared registrar every client
    calls — never a transcription of it."""
    parser = argparse.ArgumentParser(prog="crucible")
    sub = parser.add_subparsers(dest="cmd")
    AXI.add_next_verb(sub, lambda *a, **kw: 0)
    return parser, sub.choices["next"]


def _parse_next(argv):
    """`(namespace, argparse-error)` for `next <argv>`. argparse exits the
    process on an unknown flag, so the error is CAPTURED and returned: a
    missing flag must read as `unrecognized arguments`, not as a test that
    died before it could assert."""
    parser, _ = _next_subparser()
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            return parser.parse_args(["next"] + list(argv)), None
        except SystemExit:
            return None, err.getvalue().strip()


class NextFlagSurfaceTest(unittest.TestCase):
    """§S1 — `next` gains `--release` and `--wave` alongside `--track`, all
    three declared by the ONE shared registrar, and the verb still writes
    nothing."""

    def test_next_accepts_release_wave_and_track_and_carries_them_verbatim(self):
        args, error = _parse_next(["--release", "0.2.0", "--wave", "6",
                                   "--track", "2"])
        self.assertIsNone(
            error,
            f"`next` must declare --release, --wave and --track; argparse "
            f"refused the call instead: {error}")
        self.assertEqual(args.release, "0.2.0")
        self.assertEqual(args.wave, "6")
        self.assertEqual(args.track, "2")

    def test_next_help_lists_all_three_lane_flags(self):
        _parser, nx = _next_subparser()
        help_text = nx.format_help()
        missing = [flag for flag in ("--release", "--wave", "--track")
                   if flag not in help_text]
        self.assertEqual(
            missing, [],
            f"the printed help for `next` must list every lane flag it "
            f"accepts; absent: {missing!r}")

    def test_next_still_declares_no_agent_flag(self):
        """The verb is an oracle: it performs no write and claims nothing, so
        the two new dimensions must not arrive alongside an identity. Passes
        today and must keep passing — this is the bound on the change, not the
        change."""
        _parser, nx = _next_subparser()
        self.assertNotIn("--agent", nx.format_help())
        args, error = _parse_next(["--agent", "someone"])
        self.assertIsNone(args)
        self.assertIn("--agent", error or "")


# ── the same surface, in every client that ships it ────────────────────────

_PROJECT_DIR = None
_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="next-lane-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=next-lane-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=next-lane-surface-project\n")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_next_help(client):
    """A genuine subprocess dispatch of the real client script's own
    `next --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = os.environ.copy()
        env["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
        env["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL
        _HELP_CACHE[client] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), "next", "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[client]


class FleetNextFlagSurfaceTest(unittest.TestCase):
    """§S1 — all five clients expose `--release` and `--wave` on `next`,
    asserted per client by driving each client's own printed help, with the
    number of clients driven asserted alongside."""

    def test_every_client_prints_release_and_wave_in_its_next_help(self):
        surfaces = {client: _drive_next_help(client) for client in CLIENTS}

        # Non-vacuity FIRST: a drive that failed to run at all would report
        # every flag missing for a harness reason. `--track` is declared today
        # by the same registrar, so its presence proves the help was really
        # printed and read.
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in surfaces.items()
                     if "--track" not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `next --help`; these did not: "
            f"{unprinted!r}")

        missing = {c: [f for f in ("--release", "--wave") if f not in r.stdout]
                   for c, r in surfaces.items()}
        missing = {c: flags for c, flags in missing.items() if flags}
        self.assertEqual(
            missing, {},
            f"`next` takes its lane from the ONE shared registrar, so every "
            f"client must print both new flags; missing: {missing!r}")

        self.assertEqual(len(CLIENT_FILES), EXPECTED_CLIENT_COUNT)
        self.assertEqual(
            len(surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(surfaces)!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — the wave predicate reads `wave` and nothing else
# ═══════════════════════════════════════════════════════════════════════════


class WavePredicateIgnoresTrackTest(_NextTestBase):
    """§S1 — a wave is a container of CRs; a track is how they are ordered and
    scheduled. Over ONE wave split across two lanes, the wave question must get
    ONE answer whichever lane asks it."""

    def _verdict(self, entries, **flags):
        """The wave predicate's OBSERVABLE result: the wave the answer resolved,
        and whether that wave was called complete. Two values, because a
        reading that names the right wave and still calls it finished is the
        very confusion under test."""
        fields = self.fields(entries, **flags)
        return (fields.get("wave"), fields.get("reason") == "wave-complete")

    def test_the_wave_verdict_is_identical_from_either_lane_and_with_no_track(self):
        verdicts = {
            "--track 1": self._verdict(TWO_TRACK_INCOMPLETE_WAVE, track="1"),
            "--track 2": self._verdict(TWO_TRACK_INCOMPLETE_WAVE, track="2"),
            "no track": self._verdict(_untracked(TWO_TRACK_INCOMPLETE_WAVE)),
        }
        self.assertEqual(
            verdicts,
            {"--track 1": (WAVE, False),
             "--track 2": (WAVE, False),
             "no track": (WAVE, False)},
            "the wave predicate reads `wave` alone, so one wave holding "
            "actionable work must read as that same unfinished wave from "
            "either lane and from no lane at all")


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — the flags NARROW, and neither is coerced
# ═══════════════════════════════════════════════════════════════════════════

# Three waves, and the FIRST actionable row in the published order is not in
# the one being asked about — so an answer that names wave 6 can only have come
# from the flag.
WAVES_5_6_7 = (
    _entry("CR-L5-1", 5001, wave="5"),
    _entry("CR-L6-9", 6001, wave="6"),
    _entry("CR-L7-1", 7001, wave="7"),
)

# A wave whose rows are split between a DECLARED release and an unset one, the
# unset row published first. This is the live shape, not a hypothetical: the
# board's current wave holds both kinds side by side.
RELEASE_MIXED_WAVE = (
    _entry("CR-U1-1", 6001),
    _entry("CR-D2-1", 6002, release="0.2.0"),
)

# Two waves whose labels differ ONLY by a leading zero, and two releases whose
# labels differ only by a leading `v`. An integer parse or a label
# normalisation on the way in collapses each pair; a verbatim match does not.
VERBATIM_WAVE_LABELS = (
    _entry("CR-L6-1", 6001, wave="6"),
    _entry("CR-Z1-1", 6002, wave="06"),
)
VERBATIM_RELEASE_LABELS = (
    _entry("CR-R1-1", 6001, release="0.2.0"),
    _entry("CR-R2-1", 6002, release="v0.2.0"),
)


class LaneFlagsNarrowTheAnswerTest(_NextTestBase):

    def test_an_explicit_wave_answers_about_that_wave_alone(self):
        fields = self.fields(WAVES_5_6_7, wave="6")
        self.assertEqual(fields.get("wave"), "6")
        self.assertEqual(fields.get("cr"), "CR-L6-9")
        self.assertNotIn(
            fields.get("cr"), ("CR-L5-1", "CR-L7-1"),
            "an explicit wave is the resolved wave, so neither the earlier "
            "wave still holding actionable work nor the later one may be "
            "answered about")

    def test_a_release_scope_excludes_an_entry_whose_release_is_unset(self):
        fields = self.fields(RELEASE_MIXED_WAVE, release="0.2.0")
        self.assertEqual(fields.get("cr"), "CR-D2-1")
        self.assertEqual(fields.get("release"), "0.2.0")
        self.assertNotEqual(
            fields.get("cr"), "CR-U1-1",
            "membership is DECLARED, never inferred: a row with no release "
            "is not in one, however early it sits in the published order")


class LaneFlagsAreNotCoercedTest(_NextTestBase):

    def test_a_wave_label_is_matched_verbatim_and_never_parsed_as_an_integer(self):
        fields = self.fields(VERBATIM_WAVE_LABELS, wave="06")
        self.assertEqual(
            fields.get("wave"), "06",
            "nothing is COERCED on the way in: `06` and `6` are two labels, "
            "and an integer parse would merge them")
        self.assertEqual(fields.get("cr"), "CR-Z1-1")

    def test_a_release_label_is_matched_verbatim_and_never_normalised(self):
        fields = self.fields(VERBATIM_RELEASE_LABELS, release="v0.2.0")
        self.assertEqual(fields.get("release"), "v0.2.0")
        self.assertEqual(
            fields.get("cr"), "CR-R2-1",
            "a `v` prefix is part of the label, not decoration to strip")


# A wave holding two rows at ONE seq. The authoring verb keys on
# (release, wave) while the seq block keys on the wave alone, so a duplicate
# inside a wave is a shape the live board really produces — and a fixture that
# assumed uniqueness would pass for the wrong reason.
DUPLICATE_SEQ_WAVE = (
    _entry("CR-P1-1", 6001),
    _entry("CR-P2-1", 6001),
)


class DuplicateSeqWithinAWaveTest(_NextTestBase):
    """§S1 — no assertion may depend on `seq` being unique within a wave.
    Asserted rather than promised: the answer over a wave holding two rows at
    one position is the row the SERVER published first. Passes today and must
    keep passing."""

    def test_a_duplicated_seq_resolves_to_the_row_published_first(self):
        fields = self.fields(DUPLICATE_SEQ_WAVE)
        self.assertEqual(fields.get("cr"), "CR-P1-1")
        self.assertEqual(fields.get("seq"), 6001)
        self.assertNotEqual(
            fields.get("cr"), "CR-P2-1",
            "the published order is the order — a reader breaking a seq tie "
            "by any rule of its own is re-deriving the sequence")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 — a drained lane is not a complete wave
# ═══════════════════════════════════════════════════════════════════════════


class DrainedLaneIsNotACompleteWaveTest(_NextTestBase):

    def test_a_fully_landed_lane_inside_an_unfinished_wave_is_awaiting_assignment(self):
        """§S3 — `wave-complete` is reserved for the WAVE being finished,
        independent of how many tracks it was scheduled across. A lane with
        nothing scheduled has the reason that already means exactly that."""
        fields = self.fields(TWO_TRACK_INCOMPLETE_WAVE, track="1")
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "awaiting-assignment")
        self.assertNotEqual(
            fields.get("reason"), "wave-complete",
            "a track whose rows have all landed makes no claim about the "
            "wave: a sibling lane still holds actionable work")

    def test_the_sibling_lane_proves_the_wave_was_genuinely_incomplete(self):
        """§S3 — the same fixture from the other lane. Passes today and must
        keep passing: without it the criterion above could be satisfied by a
        wave that really was finished."""
        fields = self.fields(TWO_TRACK_INCOMPLETE_WAVE, track="2")
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-L6-3")


# ═══════════════════════════════════════════════════════════════════════════
# §S4 — the answer states which container it answered for
# ═══════════════════════════════════════════════════════════════════════════


class EnvelopeNamesTheResolvedContainerTest(_NextTestBase):

    def test_every_decision_carries_the_resolved_wave(self):
        waves = {decision: self.fields(entries).get("wave")
                 for decision, entries in _decision_fixtures().items()}
        self.assertEqual(
            waves, {"NEXT": WAVE, "HOLD": WAVE, "DRAINED": WAVE},
            "a reader must be able to tell which container an answer is "
            "about rather than inferring it from the CR that came back — "
            "which a HOLD or a DRAINED does not even name")

    def test_every_decision_carries_the_release_when_one_is_in_scope(self):
        fixtures = _decision_fixtures(release="0.2.0")
        releases = {decision: self.fields(entries, release="0.2.0").get("release")
                    for decision, entries in fixtures.items()}
        self.assertEqual(
            releases,
            {"NEXT": "0.2.0", "HOLD": "0.2.0", "DRAINED": "0.2.0"})

    def test_every_decision_carries_the_track_when_more_than_one_is_declared(self):
        sibling = _entry("CR-S1-1", 6100, track="track-1")
        fixtures = _decision_fixtures(track="track-2")
        tracks = {
            decision: self.fields((sibling,) + entries, track="2").get("track")
            for decision, entries in fixtures.items()}
        self.assertEqual(
            tracks,
            {"NEXT": "track-2", "HOLD": "track-2", "DRAINED": "track-2"})

    def test_no_decision_carries_a_track_when_only_one_is_declared(self):
        """§S4 — `track` rides the envelope only when the project declares MORE
        THAN ONE lane. A single-lane project's rows may still carry a stored
        track, and echoing it would tell a reader a lane was resolved when none
        was."""
        fixtures = _decision_fixtures(track="track-1")
        carried = {decision: self.fields(entries).get("track")
                   for decision, entries in fixtures.items()}
        self.assertEqual(
            carried, {"NEXT": None, "HOLD": None, "DRAINED": None},
            "one declared lane is no lane to choose between, so no answer "
            "about it names one")


# The wave must be STATED, not merely present somewhere in the line: this
# accepts either of the two spellings the human channel already uses for a
# labelled value, and nothing else.
_WAVE_STATED = re.compile(rf"wave[= ]{WAVE}\b")


class LegacyLineStatesTheWaveTest(_NextTestBase):
    """§S4 — the one-line human summary states the wave for all three
    decisions. The stderr channel is where an orchestrator reads the answer
    when it is not parsing the envelope, and an answer that names no container
    there is the silent crossing in prose."""

    def test_each_decision_line_states_the_wave_it_answered_for(self):
        lines = {decision: self.drive(entries)[1]
                 for decision, entries in _decision_fixtures().items()}
        silent = {decision: line for decision, line in lines.items()
                  if not _WAVE_STATED.search(line)}
        self.assertEqual(
            silent, {},
            f"every decision's legacy line must state its wave; these did "
            f"not: {silent!r}")


# ═══════════════════════════════════════════════════════════════════════════
# Integration — the new dimensions cost no extra round-trip
# ═══════════════════════════════════════════════════════════════════════════


class BothNewDimensionsRideTheOneReadTest(_NextTestBase):
    """Integration — `GET …/queue` is read exactly ONCE per invocation, with
    both new dimensions supplied. The criterion is asserted by COUNTING the
    requests the verb made, because narrowing is a question about the payload
    already in hand: a reader that asked the server to narrow for it would
    answer identically and cost a round-trip per dimension."""

    def test_a_drive_supplying_both_new_dimensions_reads_the_queue_once(self):
        fields = self.fields(RELEASE_MIXED_WAVE, release="0.2.0", wave=WAVE)
        self.assertEqual(
            fields.get("cr"), "CR-D2-1",
            "the drive must really resolve an answer through both flags, or "
            "an empty request log would pass for the wrong reason")
        self.assertEqual(
            self.recorder.gets, [QUEUE_PATH],
            f"one question, one read: the verb asked for "
            f"{self.recorder.gets!r}")


# ═══════════════════════════════════════════════════════════════════════════
# Agreement with the shipped wave-scope guard
# ═══════════════════════════════════════════════════════════════════════════

# A row whose `wave` is the empty string, sitting FIRST in the published order
# — the position at which a reader resolving "the wave of the first actionable
# entry" would adopt it. The write-side guard skips exactly this row when it
# derives the permitted wave, so a reader that adopted it would offer work the
# server then refuses.
WAVELESS_ROW_FIRST = (
    _entry("CR-B0-1", 60, wave=""),
    _entry("CR-L6-1", 6002, wave="6"),
)


class WavelessEntryNeverResolvesTheWaveTest(_NextTestBase):

    def test_a_waveless_row_first_in_the_published_order_resolves_no_wave(self):
        fields = self.fields(WAVELESS_ROW_FIRST)
        self.assertEqual(fields.get("wave"), "6")
        self.assertNotEqual(
            fields.get("wave"), "",
            "an un-waved row is in no wave, so it cannot be the wave an "
            "answer is about")
        self.assertNotEqual(
            fields.get("cr"), "CR-B0-1",
            "and an answer resolved for a wave may not name a CR outside it "
            "— the guard would refuse the plan filed for it")


# ── the answer is work the write side ACCEPTS ─────────────────────────────
#
# Two waves, both holding actionable work, declared through the server's own
# write path. A reader that scanned past the front wave would name the later
# cr — precisely the plan the wave-scope guard refuses — so this board can
# tell a reader that agrees with the write side from one that does not.
AGREEMENT_AGENT = "next-lane-agreement-probe"
AGREEMENT_RELEASE = "9.9.9"
FRONT_WAVE = "1"
LATER_WAVE = "2"
FRONT_CR = "CR-Y1-1"
LATER_CR = "CR-Y2-1"
# The two codes the wave scope declares. A refusal carrying neither would mean
# something else stopped the write, and the non-vacuity guard below would be
# reading the wrong failure.
REFUSAL_CODES = ("already-active", "out-of-order")


class NextsAnswerIsAPlanTheWriteSideAcceptsTest(unittest.TestCase):
    """Agreement — the cr `next` names with no flags is one whose `plan-file`
    the shipped wave-scope guard ACCEPTS.

    BOTH verbs are driven on ONE board, as the real client subprocesses an
    orchestrator actually runs, because the two halves sit on opposite sides
    of the wire: the reader picks a cr out of the queue it read, and the
    server decides whether a plan for that cr may be filed. Nothing short of
    filing it can tell the two apart — and a reader offering work the server
    then refuses is worse than one that says nothing at all."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="next-lane-agreement-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the agreement is NOT proven without `bun`: it needs the real "
                "server's wave-scope guard on the write path. That is a "
                "missing toolchain, not a passing assertion.")
        port = _free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_PORT": str(port),
                 "CRUCIBLE_HOST": "127.0.0.1",
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects",
                        {"name": "next-lane-agreement"})
        cls.key = project["project"]["key"]
        _http(cls.base, "/api/v2/agents/register",
              {"agentId": AGREEMENT_AGENT, "projectKey": cls.key,
               "status": "online", "role": "ORCHESTRATOR",
               "identity": {"displayName": AGREEMENT_AGENT,
                            "source": "manual"}})
        # CR-CRU-118 §S4 -- the route refuses a proposal naming no target
        # date. Nothing here is about the date; the fixture needs the release
        # to be a plannable target at all, so it declares one plausible date.
        _http(cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
              {"label": AGREEMENT_RELEASE, "agentId": AGREEMENT_AGENT,
               "targetAt": 1788220800})  # 2026-09-01T00:00:00Z
        for cr, wave in ((FRONT_CR, FRONT_WAVE), (LATER_CR, LATER_WAVE)):
            cls._declare(cr, wave)

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")

    @classmethod
    def _declare(cls, cr, wave):
        planned = _http(cls.base, f"/api/v2/projects/{cls.key}/queue/plan",
                        {"cr": cr, "title": "agreement probe",
                         "release": AGREEMENT_RELEASE, "wave": wave,
                         "agentId": AGREEMENT_AGENT})
        assert planned.get("ok"), f"cr-plan failed for {cr}: {planned!r}"
        sequenced = _http(
            cls.base, f"/api/v2/projects/{cls.key}/queue/sequence",
            {"release": AGREEMENT_RELEASE, "wave": wave, "crs": [cr],
             "agentId": AGREEMENT_AGENT})
        assert sequenced.get("ok"), f"wave-sequence failed for {cr}: {sequenced!r}"

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "_proc", None) is not None:
            cls._proc.terminate()
            try:
                cls._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls._proc.kill()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _client(self, argv):
        """One real client dispatch against the scratch board → (exit code,
        envelope). The orchestrator's own surface, and the only place the two
        verbs meet."""
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["CRUCIBLE_URL"] = self.base
        proc = subprocess.run(
            [sys.executable, str(CLIENT_FILES["bun"]), *argv,
             "--project-dir", self.project_dir],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        decoded = TOON.decode(proc.stdout)
        self.assertIn(
            "axi", decoded,
            f"every client dispatch answers with an envelope; {argv!r} gave "
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}")
        return proc.returncode, decoded["axi"]

    def test_the_cr_next_names_is_one_whose_plan_the_guard_accepts(self):
        code, answer = self._client(["next"])
        self.assertEqual(
            (code, answer.get("decision")), (0, "NEXT"),
            f"the board must really offer work before the agreement can be "
            f"tested; got {answer!r}")

        # Non-vacuity: the guard has to be LIVE on this board, or accepting a
        # plan below would prove nothing. Filing for the later wave — the
        # answer a reader scanning past the front would have given — is
        # refused, with a code the wave scope declares.
        refused_code, refused = self._client(
            ["plan-file", "--cr", LATER_CR, "--title", "the later wave",
             "--cycle", "c1", "--wave", LATER_WAVE,
             "--agent", AGREEMENT_AGENT])
        self.assertEqual(
            (refused_code != 0, refused.get("ok")), (True, False),
            f"a plan for a wave the guard has not opened must be refused; "
            f"got {refused!r}")
        self.assertIn(
            refused.get("code"), REFUSAL_CODES,
            f"and refused BY THE WAVE SCOPE, not by something else: "
            f"{refused!r}")

        filed_code, filed = self._client(
            ["plan-file", "--cr", answer.get("cr"),
             "--title", "the cr next named",
             "--cycle", "c1", "--wave", answer.get("wave"),
             "--agent", AGREEMENT_AGENT])
        self.assertEqual(
            (filed_code, filed.get("ok"), filed.get("code")),
            (0, True, None),
            f"the cr `next` named is work the write side accepts: a plan for "
            f"it files cleanly, carrying no refusal code at all. Got "
            f"{filed!r} for the answer {answer!r}")


if __name__ == "__main__":
    unittest.main()
