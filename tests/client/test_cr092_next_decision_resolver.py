"""RED — CR-CRU-092 C1: the `next` decision resolver, in the shared module.

Spec: docs/changes/CR-CRU-092-next-validates-the-sequence.md
Model of record: docs/research/DN-crucible-wave-track-release.md
                 §"Reading the lane during execution"

WHAT THIS FILE COVERS. C1 lands the VERB and its resolver ONCE, in
`clients/_crucible_axi.py` (the CR-CRU-054 DRY rule). The five per-client
`sub.add_parser("next", …)` registrations and the AXI census extension are C2,
so nothing here drives a client's `main()`; every test below drives the shared
resolver and the shared `cmd_next` directly — the same division
`tests/client/test_cr084_release_packages.py` draws for `cmd_milestone`.

Covered: AC1–AC10, AC13, AC14, AC16, AC17, AC18. Deliberately NOT covered here:
AC11's grep half is included (it is one assertion and §S5 calls it absolute),
but AC12 (five-client `--help`) and AC15 (the two existing fleet harnesses) are
C2's, and `--fields` (P2) rides with AC15 rather than being invented here.

THE API THIS RED PINS, and why each piece exists:

    canonical_track(value) -> "track-<n>" | None
        §S3/AC18. `next` performs no write, so no server round-trip exists to
        normalise its `--track`. Without this the fleet would answer `2`
        differently on the read path (`next`) and the write path
        (`wave-sequence`), which is the exact inconsistency the fleet standard
        exists to prevent. Mirrors `normalizeTrack` (src/store.ts:338-341).

    queue_tracks(entries) -> [str]
        §S3. The sorted distinct non-null STORED `track` values. `len > 1` is
        the whole definition of "multi-track"; the list is echoed as stored,
        never re-spelled to the caller's spelling.

    resolve_next(entries, track=None) -> (ok, code, fields, warnings)
        The pure resolver: one queue read in, one decision out. A tuple, like
        the module's existing `resolve_single_plan`. `code` is the process exit
        code so the three DECISIONS (all answers) can share `0` while the §S3
        refusal carries `2` from the same function.

    cmd_next(args, project_dir, ops) -> int
        The I/O half: one GET, `ops.emit`, the exit code. Read-only, so it
        takes no `--agent` and never touches `ops.agent_id` (AC10).

AC18's cross-implementation half is BEHAVIOURAL, not a source-text guard.
`TrackCanonicalisationAgreesWithTheServerTest` boots a scratch server (free
port, `mkdtemp` DB — never the live instance, never the shared project), drives
each accepted spelling through the real `wave-sequence` write path, reads the
stored value back off `GET …/queue` and compares it with `canonical_track`. An
earlier draft asserted on `normalizeTrack`'s SOURCE TEXT; that was replaced,
because a source guard breaks on a harmless refactor and still passes if the
regex is right but the logic around it changed. Requires `bun`, and says so
rather than skipping quietly into a green tick.

RED expectation (measured 2026-08-28 against the C1 pre-implementation tree):
`clients/_crucible_axi.py` defines none of the four names — a `\bnext\b` scan
of the fleet returns only prose and one `next()` builtin (spec §S1) — so every
test that reaches the SUT fails with AttributeError. That is the missing
contract, not a broken harness. The tests that DO pass in RED are the fixture
guards (`_status_only_pick`, `_status_only_dep_kind` and the §S5 grep): they
assert facts about the FIXTURES and the tree, and their passing is what proves
the AC16/AC17 fixtures genuinely discriminate rather than being tautologies.

Invocation:
    python3 -m pytest tests/client/test_cr092_next_decision_resolver.py -q
"""

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import subprocess
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

PROJECT_KEY = "cr092-next-key"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"
BASE_URL = "http://127.0.0.1:0"

# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

LANDED = ("COMPLETED", "COMPLETED_UNTRACKED")


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr092_axi_under_test")
TOON = _load(TOON_PATH, "cr092_toon")


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
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AssertionError(
                f"the scratch server exited during boot with code "
                f"{proc.returncode}")
        try:
            _http(base, "/api/v2")
            return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"the scratch server never came up at {base}")


# ═══════════════════════════════════════════════════════════════════════════
# Fixtures — the wire shape `Store.listQueue` publishes (src/store.ts:3480-3497)
# ═══════════════════════════════════════════════════════════════════════════


def _entry(cr, seq, status="PENDING", wave="5", release=None, track=None,
           depends_on=(), lifecycle=None):
    """One `GET …/queue` entry. `release`/`track`/`lifecycle` are OMITTED when
    not declared — exactly as the server omits them (the null-omits-the-key
    idiom), so a resolver that defaults them is caught rather than humoured."""
    entry = {"cr": cr, "wave": wave, "dependsOn": list(depends_on),
             "status": status, "seq": seq}
    if release is not None:
        entry["release"] = release
    if track is not None:
        entry["track"] = track
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    return entry


def _void(reason="not happening"):
    return {"state": "VOID", "reason": reason}


def _superseded(by):
    return {"state": "SUPERSEDED", "by": by}


def _status_only_pick(entries):
    """The PRE-FIX resolver AC16 exists to defeat: lowest-`seq` `PENDING`, with
    no second axis. Kept in the test file, never in the SUT — its job is to
    prove each AC16/AC17 fixture actually discriminates, so those ACs rest on a
    demonstrated wrong answer rather than on an assertion nobody could fail."""
    ordered = sorted(entries, key=lambda e: e["seq"])
    for entry in ordered:
        if entry.get("status") == "PENDING":
            return entry
    return None


def _status_only_dep_kind(dep_entry):
    """The status-only classification of a blocking dependency: unmerged and
    therefore, on that axis alone, an ordinary `dependency` that waiting
    clears. AC17 is the proof that this answer is wrong for a dead CR."""
    return "dependency" if dep_entry.get("status") not in LANDED else None


def _trigger_crs(trigger):
    """Every CR id a trigger names, whichever shape carries it."""
    if not isinstance(trigger, dict):
        return []
    named = []
    if trigger.get("cr"):
        named.append(trigger["cr"])
    for row in trigger.get("blockedBy") or []:
        if isinstance(row, dict) and row.get("cr"):
            named.append(row["cr"])
    return named


# ═══════════════════════════════════════════════════════════════════════════
# The `cmd_next` harness — the real ClientOps, the real emitter
# ═══════════════════════════════════════════════════════════════════════════


class _RecordingOps:
    """A real `ClientOps` whose transport records every call. Built from the
    actual class so a signature change breaks here loudly instead of being
    absorbed by a duck-typed stub (the `test_cr084_release_packages` idiom).

    `emit` is the REAL `emit_axi`: AC9 asserts byte-identical stdout and AC13
    asserts the envelope decodes as TOON, and neither is provable against a
    capturing fake.
    """

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
    """The Namespace `next`'s subparser produces. `--track` is the ONLY verb
    flag (§S3) — there is deliberately no `agent` key, because AC10 forbids the
    flag and a Namespace carrying one would hide its absence."""
    values = {"project_dir": None, "track": None}
    values.update(overrides)
    return Namespace(**values)


def _queue(*entries):
    return {"ok": True, "entries": list(entries)}


class _NextTestBase(unittest.TestCase):

    def setUp(self):
        # The fleet's `context` block reads these; an ambient orchestrator
        # session would otherwise colour envelopes this file asserts on.
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)

    # ── the pure resolver ────────────────────────────────────────────────
    def resolve(self, entries, track=None):
        return AXI.resolve_next(entries, track=track)

    def fields(self, entries, track=None):
        _ok, _code, fields, _warnings = self.resolve(entries, track=track)
        return fields

    # ── the I/O verb ─────────────────────────────────────────────────────
    def drive(self, queue_response, **arg_overrides):
        """Run the real `cmd_next` → (code, stdout, stderr, decoded_axi, ops)."""
        recorder = _RecordingOps(queue_response)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = AXI.cmd_next(_args(**arg_overrides), "/fake/dir", recorder.ops)
        decoded = TOON.decode(out.getvalue())
        return code, out.getvalue(), err.getvalue(), decoded["axi"], recorder


# ═══════════════════════════════════════════════════════════════════════════
# §S3 / AC18 — the shared read-side track canonicaliser
# ═══════════════════════════════════════════════════════════════════════════


class CanonicalTrackTest(_NextTestBase):
    """AC18 — `next --track` must accept every spelling `wave-sequence --track`
    accepts. 091 normalises SERVER-side; `next` writes nothing, so the shared
    client helper is the only place the same rule can live on the read path."""

    ACCEPTED = {
        "2": "track-2",
        "track-2": "track-2",
        "Track 2": "track-2",
        "TRACK-2": "track-2",
        "  2  ": "track-2",
        "track-02": "track-2",     # Number("02") === 2 — leading zeros collapse
        "1": "track-1",
        "track-11": "track-11",
    }

    REFUSED = ("", "track", "lane", "Track N", "   ")

    def test_every_spelling_091_accepts_maps_to_the_stored_canonical_form(self):
        for spelling, expected in sorted(self.ACCEPTED.items()):
            with self.subTest(spelling=spelling):
                self.assertEqual(
                    AXI.canonical_track(spelling), expected,
                    f"--track {spelling!r} must canonicalise to {expected!r} — "
                    f"091 stores the PRD's locked `track-<n>` wire format and "
                    f"accepts this spelling at the CLI, so a read-side match "
                    f"that refuses it splits one flag into two behaviours")

    def test_a_value_carrying_no_integer_is_refused_by_name(self):
        for spelling in self.REFUSED:
            with self.subTest(spelling=spelling):
                self.assertIsNone(
                    AXI.canonical_track(spelling),
                    f"{spelling!r} names no lane; `normalizeTrack` returns null "
                    f"for it (src/store.ts:338-341) so the helper must too, "
                    f"rather than inventing a track")

    def test_no_value_at_all_is_refused_rather_than_defaulted(self):
        self.assertIsNone(AXI.canonical_track(None))


# ═══════════════════════════════════════════════════════════════════════════
# AC18's CROSS-IMPLEMENTATION half — behavioural, against a real server
# ═══════════════════════════════════════════════════════════════════════════


class TrackCanonicalisationAgreesWithTheServerTest(unittest.TestCase):
    """AC18 — "for each accepted spelling, the value `wave-sequence` causes the
    server to store equals the value the shared Python helper produces".

    Asserted BEHAVIOURALLY, not by reading `normalizeTrack`'s source: a
    source-text guard breaks on a harmless refactor and still passes if the
    regex is right but the logic around it changed. So this class boots a
    SCRATCH server (free port, `mkdtemp` DB — never the live instance, never
    the shared project), drives each accepted spelling through the REAL write
    path `wave-sequence` posts to, reads the stored value back off
    `GET …/queue`, and compares it with `canonical_track`.

    The failure mode it exists to prevent is concrete: two callers writing `2`
    and `track-2` producing TWO lanes for one track. The last test closes the
    loop by feeding the server's own stored entries back into `resolve_next`.
    """

    RELEASE = "9.9.9"
    AGENT = "cr092-c1-track-probe"
    # Every spelling CR-CRU-091's `--track` documents, plus the two the shared
    # rule implies (a leading zero, and surrounding whitespace).
    SPELLINGS = ("2", "track-2", "Track 2", "track-02", "  2  ")
    # A SECOND lane, so the multi-track path is exercised against values the
    # server actually stored rather than against hand-written fixtures.
    OTHER_TRACK = "3"
    REFUSED = ("", "lane", "track", "Track N")

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="cr092-scratch-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "AC18's cross-implementation half is NOT proven without `bun`: "
                "it needs the real server's normalizeTrack on the write path. "
                "This is a missing toolchain, not a passing assertion.")
        port = _free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_PORT": str(port),
                 "CRUCIBLE_HOST": "127.0.0.1",
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "cr092-scratch"})
        cls.key = project["project"]["key"]
        _http(cls.base, "/api/v2/agents/register",
              {"agentId": cls.AGENT, "projectKey": cls.key, "status": "online",
               "role": "ORCHESTRATOR",
               "identity": {"displayName": cls.AGENT, "source": "manual"}})
        _http(cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
              {"label": cls.RELEASE, "agentId": cls.AGENT})

        # One cr per spelling, each in its OWN wave, so every declaration is a
        # complete `wave-sequence` call over the whole wave (§S4) rather than a
        # partial re-send.
        cls.stored = {}
        cls.declared = []
        for index, spelling in enumerate(cls.SPELLINGS, start=1):
            cls.declared.append((f"CR-TRK-{index:03d}", str(index), spelling))
        cls.declared.append(("CR-TRK-OTHER", "9", cls.OTHER_TRACK))
        for cr, wave, spelling in cls.declared:
            cls._declare(cr, wave, spelling)

        entries = _http(cls.base, f"/api/v2/projects/{cls.key}/queue")["entries"]
        cls.entries = entries
        by_cr = {e["cr"]: e for e in entries}
        for cr, _wave, spelling in cls.declared[:len(cls.SPELLINGS)]:
            cls.stored[spelling] = by_cr[cr].get("track")
        cls.other_stored = by_cr["CR-TRK-OTHER"].get("track")

    @classmethod
    def _declare(cls, cr, wave, track):
        planned = _http(cls.base, f"/api/v2/projects/{cls.key}/queue/plan",
                        {"cr": cr, "title": "track probe",
                         "release": cls.RELEASE, "wave": wave,
                         "agentId": cls.AGENT})
        assert planned.get("ok"), f"cr-plan failed for {cr}: {planned!r}"
        sequenced = _http(
            cls.base, f"/api/v2/projects/{cls.key}/queue/sequence",
            {"release": cls.RELEASE, "wave": wave, "crs": [cr],
             "track": track, "agentId": cls.AGENT})
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

    def test_the_server_stores_exactly_what_the_helper_produces(self):
        """AC18's core: write path and read path, one rule. A divergence
        between `normalizeTrack` (TypeScript) and `canonical_track` (Python)
        fails HERE."""
        for spelling in self.SPELLINGS:
            with self.subTest(spelling=spelling):
                self.assertEqual(
                    self.stored[spelling], AXI.canonical_track(spelling),
                    f"the server stored {self.stored[spelling]!r} for "
                    f"--track {spelling!r} while the client helper produces "
                    f"{AXI.canonical_track(spelling)!r} — one flag, one "
                    f"project, two answers")

    def test_every_spelling_lands_in_ONE_lane_not_five(self):
        """The failure §S2's normalisation exists to prevent, asserted on real
        stored data: five spellings of one track must not become five lanes."""
        self.assertEqual(
            len(set(self.stored.values())), 1,
            f"the five spellings stored {sorted(set(self.stored.values()))!r}")
        self.assertEqual(set(self.stored.values()), {"track-2"})

    def test_the_live_track_list_is_what_the_server_holds(self):
        """`queue_tracks` reads the SERVER's canonical values, so the refusal
        list §S3 emits is the roadmap's own vocabulary."""
        self.assertEqual(self.other_stored, AXI.canonical_track(self.OTHER_TRACK))
        self.assertEqual(AXI.queue_tracks(self.entries), ["track-2", "track-3"])

    def test_the_server_refuses_exactly_what_the_helper_refuses(self):
        """The other half of one rule: a value naming no lane is refused by
        BOTH sides. A helper that quietly invented a track here would send
        `next` hunting a lane `wave-sequence` would never create."""
        for spelling in self.REFUSED:
            with self.subTest(spelling=spelling):
                refused = _http(
                    self.base, f"/api/v2/projects/{self.key}/queue/sequence",
                    {"release": self.RELEASE, "wave": "1",
                     "crs": ["CR-TRK-001"], "track": spelling,
                     "agentId": self.AGENT})
                self.assertIs(refused.get("ok"), False,
                              f"the server accepted --track {spelling!r}")
                self.assertIsNone(
                    AXI.canonical_track(spelling),
                    f"the server refuses {spelling!r} but the helper "
                    f"canonicalised it to "
                    f"{AXI.canonical_track(spelling)!r}")

    def test_next_resolves_every_spelling_against_the_stored_lane(self):
        """The loop closed end to end: the entries the SERVER published, fed to
        the resolver, reached by every spelling `wave-sequence` accepts — and
        `tracks[]` never echoes the caller's spelling back."""
        answers = []
        for spelling in self.SPELLINGS:
            ok, code, fields, _warnings = AXI.resolve_next(
                self.entries, track=spelling)
            with self.subTest(spelling=spelling):
                self.assertIs(ok, True)
                self.assertEqual(code, 0)
                self.assertEqual(fields.get("decision"), "NEXT")
                self.assertEqual(fields.get("track"), "track-2")
                self.assertNotIn("tracks", fields)
            answers.append(fields)
        self.assertEqual(
            [a["cr"] for a in answers], [answers[0]["cr"]] * len(answers),
            f"every spelling must reach the same lane; got {answers!r}")

    def test_the_other_lane_is_reachable_by_its_own_spelling(self):
        """Multi-track, against real stored values: `--track 3` answers about
        track-3, never track-2."""
        fields = AXI.resolve_next(self.entries, track="Track 3")[2]
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-TRK-OTHER")
        self.assertEqual(fields.get("track"), "track-3")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 / AC7 / AC8 — track scoping is conditional on the data
# ═══════════════════════════════════════════════════════════════════════════


TWO_TRACK_LANE = (
    _entry("CR-CRU-100", 10, track="track-1"),
    _entry("CR-CRU-200", 20, track="track-2"),
)


class TrackScopingTest(_NextTestBase):

    def test_tracks_are_the_sorted_distinct_non_null_stored_values(self):
        entries = [_entry("CR-A", 10, track="track-2"),
                   _entry("CR-B", 20, track="track-1"),
                   _entry("CR-C", 30),
                   _entry("CR-D", 40, track="track-2")]
        self.assertEqual(AXI.queue_tracks(entries), ["track-1", "track-2"])

    def test_multi_track_without_the_flag_refuses_and_never_picks_a_lane(self):
        """AC7 — `ok=false`, `needs=["track"]`, the live list, exit 2, and NO
        `decision` key. An envelope carrying a decision fails this AC."""
        ok, code, fields, _warnings = self.resolve(list(TWO_TRACK_LANE))
        self.assertIs(ok, False)
        self.assertEqual(code, 2)
        self.assertEqual(fields.get("needs"), ["track"])
        self.assertEqual(fields.get("tracks"), ["track-1", "track-2"])
        self.assertNotIn(
            "decision", fields,
            "a refusal that also answers has picked a lane — §S3: 'it never "
            "picks a lane'")

    def test_the_refusal_carries_totalCount_for_its_only_list(self):
        """§S6 P4 — `totalCount` on `tracks[]`, the verb's one list."""
        fields = self.fields(list(TWO_TRACK_LANE))
        self.assertEqual(fields.get("totalCount"), len(fields["tracks"]))

    def test_a_track_outside_the_live_list_is_refused_with_that_list(self):
        """AC8's second half — an unknown `--track` in a multi-track fixture
        exits 2 and names what IS live."""
        ok, code, fields, _warnings = self.resolve(
            list(TWO_TRACK_LANE), track="9")
        self.assertIs(ok, False)
        self.assertEqual(code, 2)
        self.assertEqual(fields.get("needs"), ["track"])
        self.assertEqual(fields.get("tracks"), ["track-1", "track-2"])
        self.assertNotIn("decision", fields)

    def test_a_track_naming_no_integer_is_refused_rather_than_matched(self):
        ok, code, fields, _warnings = self.resolve(
            list(TWO_TRACK_LANE), track="lane")
        self.assertIs(ok, False)
        self.assertEqual(code, 2)
        self.assertEqual(fields.get("needs"), ["track"])

    def test_every_accepted_spelling_resolves_the_same_lane(self):
        """AC18 — `2`, `track-2` and `Track 2` all reach track-2's lane and
        return the SAME decision. `tracks[]` never appears once a lane is
        resolved, so the caller's spelling can never be echoed back."""
        answers = [self.fields(list(TWO_TRACK_LANE), track=spelling)
                   for spelling in ("2", "track-2", "Track 2")]
        for spelling, fields in zip(("2", "track-2", "Track 2"), answers):
            with self.subTest(spelling=spelling):
                self.assertEqual(fields.get("decision"), "NEXT")
                self.assertEqual(fields.get("cr"), "CR-CRU-200")
                self.assertNotIn("tracks", fields)
                self.assertNotIn("needs", fields)
        self.assertEqual(answers[0], answers[1])
        self.assertEqual(answers[1], answers[2])

    def test_tracks_echo_the_stored_value_never_the_callers_spelling(self):
        """AC18 — the refusal list is what the SERVER holds. A resolver that
        canonicalised the list would be re-spelling data it does not own."""
        entries = [_entry("CR-A", 10, track="track-1"),
                   _entry("CR-B", 20, track="2")]
        fields = self.fields(entries)
        self.assertEqual(
            fields.get("tracks"), ["2", "track-1"],
            "`tracks[]` echoes STORED values — a legacy un-normalised row is a "
            "fact about the roadmap, not something the read path may rewrite")

    def test_a_non_canonical_stored_track_still_matches_a_canonical_flag(self):
        """The other side of the same coin: matching is on the CANONICAL form,
        so `--track 2` reaches a row stored (legacy) as bare `2`."""
        entries = [_entry("CR-A", 10, track="track-1"),
                   _entry("CR-B", 20, track="2")]
        fields = self.fields(entries, track="track-2")
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-B")

    def test_single_track_answers_bare_and_never_rides_tracks(self):
        """AC8 — every entry on one track: no flag, exit 0, a decision,
        `needs` absent and NO `tracks` key."""
        entries = [_entry("CR-A", 10, track="track-1"),
                   _entry("CR-B", 20, track="track-1")]
        ok, code, fields, _warnings = self.resolve(entries)
        self.assertIs(ok, True)
        self.assertEqual(code, 0)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-A")
        self.assertNotIn("needs", fields)
        self.assertNotIn(
            "tracks", fields,
            "§S3: with one track the flag 'is never PROMPTED FOR' and the "
            "envelope never rides `tracks`")

    def test_no_track_declared_anywhere_answers_bare_too(self):
        """AC8's second fixture — a project that has declared no track at all
        is the SAME shape on the wire as a one-track project, and must give
        the same answer rather than a silent `needs=[track]`."""
        entries = [_entry("CR-A", 10), _entry("CR-B", 20)]
        ok, code, fields, _warnings = self.resolve(entries)
        self.assertIs(ok, True)
        self.assertEqual(code, 0)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertNotIn("needs", fields)
        self.assertNotIn("tracks", fields)


# ═══════════════════════════════════════════════════════════════════════════
# §S2 / AC1 / AC2 / AC14 — NEXT
# ═══════════════════════════════════════════════════════════════════════════


class NextDecisionTest(_NextTestBase):

    def test_next_names_the_cr_and_its_published_seq(self):
        """AC1 — `seq` is the integer the read published. The lane's first
        entry has `seq` 10, so an index-derived `seq` (0) fails here."""
        entries = [_entry("CR-CRU-100", 10), _entry("CR-CRU-101", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-CRU-100")
        self.assertEqual(
            fields.get("seq"), 10,
            "the published seq, verbatim — CR-091 C4 deleted the array-index "
            "derivation and §S2 forbids reintroducing it")

    def test_a_landed_dependency_does_not_block(self):
        for status in LANDED:
            with self.subTest(status=status):
                entries = [_entry("CR-DEP", 10, status=status),
                           _entry("CR-CRU-100", 20, depends_on=["CR-DEP"])]
                fields = self.fields(entries)
                self.assertEqual(fields.get("decision"), "NEXT")
                self.assertEqual(fields.get("cr"), "CR-CRU-100")

    def test_next_carries_the_concrete_start_call(self):
        """AC2 — `help[0]` contains `plan-file --cr <that cr>` with the
        entry's OWN wave. An empty help[], or a canned HELP_STEPS string,
        fails."""
        entries = [_entry("CR-CRU-100", 10, wave="7")]
        fields = self.fields(entries)
        help_steps = fields.get("help")
        self.assertTrue(help_steps, "every decision derives a non-empty help[]")
        self.assertIn("plan-file --cr CR-CRU-100", help_steps[0])
        self.assertIn("--wave 7", help_steps[0])

    def test_next_gets_no_entry_in_the_canned_help_table(self):
        """§S6 — `help[]` is STATE-DERIVED per decision (CR-CRU-048's rule at
        `clients/_crucible_axi.py:710-714`), so `next` must be absent from
        `HELP_STEPS` entirely rather than carrying a canned line."""
        self.assertNotIn("next", AXI.HELP_STEPS)

    def test_declared_fields_are_echoed_verbatim_and_absences_omitted(self):
        """AC14 — seq [10,20,30], `release` on only some entries, `track` on
        only some. The named entry declares NEITHER, so both keys must be
        ABSENT, never defaulted, never index-derived."""
        entries = [_entry("CR-BARE", 10, wave="5"),
                   _entry("CR-REL", 20, wave="5", release="0.2.0"),
                   _entry("CR-TRK", 30, wave="5", track="track-1")]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-BARE")
        self.assertEqual(fields.get("seq"), 10)
        self.assertEqual(fields.get("wave"), "5")
        self.assertNotIn(
            "release", fields,
            "the entry declares no release; a null or a borrowed neighbour's "
            "value would both be fabrication")
        self.assertNotIn("track", fields)

    def test_declared_release_and_track_ride_the_answer_verbatim(self):
        """AC14's positive half, on the same fixture shape."""
        entries = [_entry("CR-DECLARED", 10, wave="5", release="0.2.0",
                          track="track-1"),
                   _entry("CR-BARE", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("cr"), "CR-DECLARED")
        self.assertEqual(fields.get("release"), "0.2.0")
        self.assertEqual(fields.get("track"), "track-1")
        self.assertEqual(fields.get("seq"), 10)
        self.assertEqual(fields.get("wave"), "5")

    def test_seq_is_never_substituted_by_the_wave_or_the_cr_id(self):
        """AC14 — the three near-misses a re-derivation would produce."""
        entries = [_entry("CR-CRU-100", 30, wave="5")]
        fields = self.fields(entries)
        self.assertEqual(fields.get("seq"), 30)
        self.assertNotEqual(fields.get("seq"), 0)
        self.assertNotEqual(fields.get("seq"), "5")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 / AC3 / AC4 / AC5 / AC17 — HOLD and its four triggers
# ═══════════════════════════════════════════════════════════════════════════


# One fixture per trigger kind, as `(entries, track, held_cr)`.
#
# The `dependency` fixture is deliberately CROSS-TRACK, and that is a finding
# rather than a convenience: a blocker sitting in the SAME lane at a lower
# `seq` is itself the lowest-`seq` actionable entry, so the honest answer there
# is `NEXT` on the blocker — the lane is not blocked, it simply starts one CR
# earlier. An ordinary `dependency` HOLD therefore requires a blocker the lane
# cannot start on its own behalf, which is exactly the cross-track case
# CR-CRU-091's `track` metadata creates.
HOLD_FIXTURES = {
    "in-flight": ([_entry("CR-RUNNING", 10, status="IN_PROGRESS"),
                   _entry("CR-WAITING", 20)], None, "CR-WAITING"),
    "dependency": ([_entry("CR-DEP", 10, track="track-2", status="PENDING"),
                    _entry("CR-TARGET", 20, track="track-1",
                           depends_on=["CR-DEP"])], "track-1", "CR-TARGET"),
    "unknown-dependency": ([_entry("CR-TARGET", 10,
                                   depends_on=["CR-GHOST"])], None,
                           "CR-TARGET"),
    "dead-dependency": ([_entry("CR-DEAD", 10, lifecycle=_void()),
                         _entry("CR-TARGET", 20, depends_on=["CR-DEAD"])],
                        None, "CR-TARGET"),
}


class HoldDecisionTest(_NextTestBase):

    def hold(self, kind):
        entries, track, held = HOLD_FIXTURES[kind]
        return self.fields(entries, track=track), held

    def test_every_hold_names_a_kind_and_at_least_one_cr(self):
        """AC3 — a `HOLD` with `trigger` absent, null, empty, or naming no CR
        fails. `trigger` is a required object on every HOLD, never prose."""
        for expected_kind in sorted(HOLD_FIXTURES):
            with self.subTest(kind=expected_kind):
                fields, _held = self.hold(expected_kind)
                self.assertEqual(fields.get("decision"), "HOLD")
                trigger = fields.get("trigger")
                self.assertIsInstance(
                    trigger, dict,
                    f"HOLD must carry a structured trigger; got {trigger!r}")
                self.assertEqual(trigger.get("kind"), expected_kind)
                self.assertTrue(
                    _trigger_crs(trigger),
                    f"the trigger must NAME the blocking CR; got {trigger!r}")

    def test_the_four_kinds_are_the_declared_vocabulary(self):
        """§S2 — exactly one `kind`, drawn from the DN's four."""
        self.assertEqual(sorted(HOLD_FIXTURES), sorted(AXI.HOLD_TRIGGER_KINDS))

    def test_every_hold_carries_the_held_entry_and_its_seq(self):
        """§S2's table — HOLD carries `cr` and `seq`: the entry that is stuck,
        not merely the cause."""
        for kind in sorted(HOLD_FIXTURES):
            with self.subTest(kind=kind):
                fields, held = self.hold(kind)
                self.assertEqual(fields.get("cr"), held)
                self.assertIsInstance(fields.get("seq"), int)

    def test_every_hold_derives_a_help_that_clears_its_trigger(self):
        """§S6 — the move that clears the NAMED trigger, then `next` again."""
        for kind in sorted(HOLD_FIXTURES):
            with self.subTest(kind=kind):
                help_steps = self.hold(kind)[0].get("help")
                self.assertTrue(help_steps)
                self.assertEqual(
                    help_steps[-1], "next",
                    "the last step is always re-asking — the HOLD is a "
                    "transient state the orchestrator re-checks")

    def test_in_flight_names_the_occupying_cr(self):
        """AC4(a)."""
        trigger = self.hold("in-flight")[0].get("trigger")
        self.assertEqual(trigger.get("kind"), "in-flight")
        self.assertEqual(trigger.get("cr"), "CR-RUNNING")

    def test_dependency_names_each_blocker_with_its_live_status(self):
        """AC4(b) — the blocking CR AND the status it currently reads."""
        trigger = self.hold("dependency")[0].get("trigger")
        self.assertEqual(trigger.get("kind"), "dependency")
        self.assertEqual(trigger.get("blockedBy"),
                         [{"cr": "CR-DEP", "status": "PENDING"}])

    def test_dependency_lists_every_live_blocker_not_just_the_first(self):
        """"Carries EACH blocking CR id with its live status" — a trigger
        naming only the first blocker under-reports the wait."""
        entries = [_entry("CR-D1", 10, track="track-2", status="PENDING"),
                   _entry("CR-D2", 20, track="track-2", status="PENDING"),
                   _entry("CR-TARGET", 30, track="track-1",
                          depends_on=["CR-D1", "CR-D2"])]
        trigger = self.fields(entries, track="1").get("trigger")
        self.assertEqual(trigger.get("kind"), "dependency")
        self.assertEqual(
            trigger.get("blockedBy"),
            [{"cr": "CR-D1", "status": "PENDING"},
             {"cr": "CR-D2", "status": "PENDING"}])

    def test_unknown_dependency_names_the_dep_and_rides_a_warning(self):
        """AC4(c) — a dep the queue does not hold cannot be shown landed, so it
        HOLDS; §12 says it is reported, never rejected, and carries a
        STRUCTURED warning alongside."""
        ok, code, fields, warnings = self.resolve(
            HOLD_FIXTURES["unknown-dependency"][0])
        self.assertIs(ok, True)
        self.assertEqual(code, 0)
        self.assertEqual(fields["trigger"].get("kind"), "unknown-dependency")
        self.assertEqual(fields["trigger"].get("cr"), "CR-GHOST")
        codes = [w.get("code") for w in warnings]
        self.assertIn(
            "unknown-dependency", codes,
            f"the unknown dep rides a structured warning; got {warnings!r}")
        detail = next(w["detail"] for w in warnings
                      if w["code"] == "unknown-dependency")
        self.assertIn("CR-GHOST", detail)

    def test_occupancy_is_evaluated_before_the_dependency_axis(self):
        """AC4's last sentence — fixture (a) with a blocked dependency ALSO
        present returns `in-flight`: an occupied lane holds everything behind
        it, so the occupancy check runs first."""
        entries = [_entry("CR-RUNNING", 10, status="IN_PROGRESS"),
                   _entry("CR-DEP", 20, status="PENDING"),
                   _entry("CR-WAITING", 30, depends_on=["CR-DEP"])]
        trigger = self.fields(entries).get("trigger")
        self.assertEqual(trigger.get("kind"), "in-flight")
        self.assertEqual(trigger.get("cr"), "CR-RUNNING")

    def test_hold_is_never_a_skip(self):
        """AC5 — lane = [A seq 1 PENDING deps:[Z], B seq 2 PENDING deps:[]],
        Z unmerged and OUTSIDE the lane. The answer is HOLD on A. Naming B, or
        any NEXT, fails."""
        entries = [_entry("CR-Z", 5, track="track-2", status="PENDING"),
                   _entry("CR-A", 1, track="track-1", depends_on=["CR-Z"]),
                   _entry("CR-B", 2, track="track-1")]
        fields = self.fields(entries, track="1")
        self.assertEqual(
            fields.get("decision"), "HOLD",
            "§S4: `next` validates, it does not correct — scanning past a "
            "blocked entry would be Crucible substituting a sequence of its own")
        self.assertEqual(fields.get("cr"), "CR-A")
        self.assertEqual(fields.get("seq"), 1)

    # ── AC17: dead-dependency, the gap-analysis finding ──────────────────

    def test_the_ac17_fixture_would_read_as_a_plain_dependency_on_status_alone(self):
        """AC17's proof obligation: the fixture must DISCRIMINATE. A VOID CR
        with no plan reads `status: "PENDING"` (CR-091 §S2 — `deriveQueueStatus`
        cannot see `lifecycle`, by signature), so a status-only classifier calls
        it an ordinary `dependency` that waiting clears. It never does."""
        dead = HOLD_FIXTURES["dead-dependency"][0][0]
        self.assertEqual(dead["status"], "PENDING")
        self.assertEqual(_status_only_dep_kind(dead), "dependency")

    def test_a_void_dependency_reports_dead_dependency(self):
        """AC17 — `kind="dead-dependency"` carrying the dep and its
        `lifecycle.state`. A `HOLD` reporting `dependency` fails: `dependency`
        promises waiting resolves it, and waiting on a voided CR never does."""
        fields = self.fields(HOLD_FIXTURES["dead-dependency"][0])
        trigger = fields.get("trigger")
        self.assertEqual(trigger.get("kind"), "dead-dependency")
        self.assertEqual(trigger.get("cr"), "CR-DEAD")
        self.assertEqual(trigger.get("state"), "VOID")

    def test_a_superseded_dependency_also_carries_its_successor(self):
        """AC17 — with `CR-A` SUPERSEDED the trigger also carries its `by`, so
        the orchestrator can re-point `dependsOn` at the successor."""
        entries = [_entry("CR-DEAD", 10, lifecycle=_superseded("CR-NEW")),
                   _entry("CR-TARGET", 20, depends_on=["CR-DEAD"])]
        trigger = self.fields(entries).get("trigger")
        self.assertEqual(trigger.get("kind"), "dead-dependency")
        self.assertEqual(trigger.get("cr"), "CR-DEAD")
        self.assertEqual(trigger.get("state"), "SUPERSEDED")
        self.assertEqual(trigger.get("by"), "CR-NEW")

    def test_a_void_dependency_omits_by_rather_than_nulling_it(self):
        trigger = self.fields(HOLD_FIXTURES["dead-dependency"][0]).get("trigger")
        self.assertNotIn(
            "by", trigger,
            "a VOID CR has no successor; a null `by` would invite a re-point "
            "at nothing")

    def test_dead_dependency_outranks_a_live_one(self):
        """The evaluation order §S2 fixes: a lane blocked by BOTH a live and a
        dead dep reports the dead one, because that is the blocker waiting
        will never clear."""
        entries = [_entry("CR-LIVE", 10, track="track-2", status="PENDING"),
                   _entry("CR-DEAD", 20, track="track-2", lifecycle=_void()),
                   _entry("CR-TARGET", 30, track="track-1",
                          depends_on=["CR-LIVE", "CR-DEAD"])]
        trigger = self.fields(entries, track="1").get("trigger")
        self.assertEqual(trigger.get("kind"), "dead-dependency")
        self.assertEqual(trigger.get("cr"), "CR-DEAD")

    def test_a_dependency_that_landed_before_it_was_superseded_does_not_block(self):
        """`landed` is decided on the status axis FIRST: a dep that COMPLETED
        did the work, whatever lifecycle note was filed afterwards. Only an
        UNLANDED dead dep is a dead dependency."""
        entries = [_entry("CR-DONE", 10, status="COMPLETED",
                          lifecycle=_superseded("CR-NEW")),
                   _entry("CR-TARGET", 20, depends_on=["CR-DONE"])]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-TARGET")

    def test_dependencies_are_resolved_across_the_whole_queue_not_one_lane(self):
        """A cross-track dependency still blocks — the lane scopes the
        CANDIDATE set, never the dependency lookup."""
        entries = [_entry("CR-OTHER", 10, track="track-1", status="PENDING"),
                   _entry("CR-TARGET", 20, track="track-2",
                          depends_on=["CR-OTHER"])]
        fields = self.fields(entries, track="2")
        self.assertEqual(fields.get("decision"), "HOLD")
        self.assertEqual(fields.get("cr"), "CR-TARGET")
        self.assertEqual(fields["trigger"].get("kind"), "dependency")

    def test_occupancy_is_scoped_to_the_lane(self):
        """The mirror of the rule above: another TRACK's in-flight CR does not
        occupy this lane."""
        entries = [_entry("CR-OTHER", 10, track="track-1",
                          status="IN_PROGRESS"),
                   _entry("CR-TARGET", 20, track="track-2")]
        fields = self.fields(entries, track="track-2")
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-TARGET")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 / AC6 / AC16 — DRAINED, and the dead-CR axis
# ═══════════════════════════════════════════════════════════════════════════


class DrainedDecisionTest(_NextTestBase):

    def test_no_entries_at_all_is_no_roadmap(self):
        """AC6 — the queue read returned zero entries."""
        ok, code, fields, _warnings = self.resolve([])
        self.assertIs(ok, True)
        self.assertEqual(code, 0)
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "no-roadmap")
        self.assertTrue(fields.get("help"))

    def test_a_queue_with_no_entries_in_the_lane_is_awaiting_assignment(self):
        """AC6 — the queue is non-empty but the LANE holds no entries. §S3's
        'no track is declared yet' case: entries exist, none carries the track
        the caller asked for, so there is nothing to answer about — and that
        is an ANSWER, not a refusal (§S3 never prompts below two tracks)."""
        entries = [_entry("CR-A", 10, track="track-1"),
                   _entry("CR-B", 20, track="track-1")]
        ok, code, fields, _warnings = self.resolve(entries, track="9")
        self.assertIs(ok, True)
        self.assertEqual(code, 0)
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "awaiting-assignment")
        self.assertTrue(fields.get("help"))
        self.assertNotIn("needs", fields)

    def test_a_lane_whose_work_all_landed_is_wave_complete(self):
        """AC6 — all lane entries landed."""
        entries = [_entry("CR-A", 10, status="COMPLETED"),
                   _entry("CR-B", 20, status="COMPLETED_UNTRACKED")]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "wave-complete")
        self.assertTrue(fields.get("help"))

    def test_drained_never_answers_with_a_bare_empty_list_or_a_null_cr(self):
        """AC6/P5 — `DRAINED` is the definitive empty state: a decision with a
        reason, never a blank and never a null `cr` standing in for one."""
        for entries in ([], [_entry("CR-A", 10, status="COMPLETED")]):
            with self.subTest(entries=len(entries)):
                fields = self.fields(entries)
                self.assertIn(
                    fields.get("reason"),
                    ("wave-complete", "awaiting-assignment", "no-roadmap"))
                self.assertIsNone(fields.get("cr"))
                self.assertNotIn("cr", fields)

    # ── AC16: the second axis ────────────────────────────────────────────

    def test_the_ac16_fixture_would_offer_the_dead_cr_on_status_alone(self):
        """AC16's proof obligation. `deriveQueueStatus` cannot see `lifecycle`
        (CR-091 §S2, by signature), so the VOID entry reads `PENDING` and a
        status-only resolver returns it as the next thing to build — work its
        author explicitly recorded as not happening."""
        entries = [_entry("CR-DEAD", 10, lifecycle=_void()),
                   _entry("CR-ALIVE", 20)]
        picked = _status_only_pick(entries)
        self.assertEqual(
            picked["cr"], "CR-DEAD",
            "if this fails the fixture no longer discriminates and AC16 is "
            "asserting nothing")

    def test_a_void_entry_is_never_offered_as_the_next_work(self):
        """AC16 — `NEXT` names the SECOND entry, never the voided one."""
        entries = [_entry("CR-DEAD", 10, lifecycle=_void()),
                   _entry("CR-ALIVE", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-ALIVE")
        self.assertEqual(fields.get("seq"), 20)

    def test_a_superseded_entry_behaves_identically(self):
        """AC16 — same fixture with `SUPERSEDED` (carrying `by`)."""
        entries = [_entry("CR-DEAD", 10, lifecycle=_superseded("CR-ALIVE")),
                   _entry("CR-ALIVE", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "NEXT")
        self.assertEqual(fields.get("cr"), "CR-ALIVE")

    def test_skipping_a_dead_entry_is_not_skipping_a_blocked_one(self):
        """§S2's load-bearing distinction, asserted as a pair: the DEAD entry
        is passed over (it is not work), while a BLOCKED one in the same lane
        still stops the answer dead."""
        entries = [_entry("CR-DEAD", 10, track="track-1", lifecycle=_void()),
                   _entry("CR-BLOCKER", 20, track="track-2", status="PENDING"),
                   _entry("CR-BLOCKED", 30, track="track-1",
                          depends_on=["CR-BLOCKER"])]
        fields = self.fields(entries, track="1")
        self.assertEqual(fields.get("decision"), "HOLD")
        self.assertEqual(fields.get("cr"), "CR-BLOCKED")
        self.assertEqual(fields["trigger"].get("kind"), "dependency")

    def test_a_lane_of_nothing_but_corpses_drains_and_names_them(self):
        """AC16 — with EVERY remaining entry dead the answer is `DRAINED` with
        `reason="wave-complete"` and a `help[]` NAMING the dead CRs, so the
        state is legible rather than mysterious. Never `NEXT` on a corpse and
        never a blank."""
        entries = [_entry("CR-DEAD-1", 10, lifecycle=_void()),
                   _entry("CR-DEAD-2", 20, lifecycle=_superseded("CR-NEW")),
                   _entry("CR-DONE", 30, status="COMPLETED")]
        fields = self.fields(entries)
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "wave-complete")
        joined = " | ".join(fields.get("help") or [])
        self.assertIn("CR-DEAD-1", joined)
        self.assertIn("CR-DEAD-2", joined)

    def test_a_lane_that_merely_finished_does_not_name_phantom_corpses(self):
        """The other half: with nothing dead, the help[] has no dead-CR line to
        write, so it must not manufacture one."""
        entries = [_entry("CR-DONE", 10, status="COMPLETED")]
        joined = " | ".join(self.fields(entries).get("help") or [])
        self.assertNotIn("declared dead", joined)


# ═══════════════════════════════════════════════════════════════════════════
# §S4 / §S6 / AC9 / AC10 / AC13 — the verb: envelope, exit codes, oracle
# ═══════════════════════════════════════════════════════════════════════════


class NextVerbEnvelopeTest(_NextTestBase):

    LANE = (_entry("CR-CRU-100", 10, wave="5"),)

    def test_the_envelope_is_a_toon_axi_with_verb_next_on_stdout(self):
        """AC13 — every path emits through `emit_axi`, so stdout parses as a
        TOON `axi` envelope with `verb="next"` and the human line lands on
        stderr ONLY."""
        code, stdout, stderr, axi, _ops = self.drive(_queue(*self.LANE))
        self.assertEqual(code, 0)
        self.assertEqual(axi.get("verb"), "next")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertIn("projectKey", axi.get("context") or {})
        self.assertNotIn("axi:", stderr)
        self.assertIn("next:", stderr)
        self.assertTrue(stdout.startswith("axi:"))

    def test_the_verb_reads_the_queue_and_nothing_else(self):
        _code, _out, _err, _axi, ops = self.drive(_queue(*self.LANE))
        self.assertEqual(ops.gets, [QUEUE_PATH])

    def test_all_three_decisions_exit_zero(self):
        """§S1 — the harness's 0/2/3 split is NOT adopted; all three decisions
        are ANSWERS, so all three exit 0 (`clients/STATUS-CONTRACT.md:65-68`)."""
        hold_entries, hold_track, _held = HOLD_FIXTURES["dependency"]
        cases = {
            "NEXT": (_queue(*self.LANE), None),
            "HOLD": (_queue(*hold_entries), hold_track),
            "DRAINED": (_queue(), None),
        }
        for expected, (response, track) in sorted(cases.items()):
            with self.subTest(decision=expected):
                code, _out, _err, axi, _ops = self.drive(response, track=track)
                self.assertEqual(code, 0)
                self.assertEqual(axi.get("decision"), expected)
                self.assertIs(axi.get("ok"), True)

    def test_the_multi_track_refusal_exits_two_through_stdout(self):
        """AC7/AC13 + P6 — usage exits 2 and the refusal is a STRUCTURED
        envelope on stdout, never prose on stderr."""
        code, stdout, _err, axi, _ops = self.drive(_queue(*TWO_TRACK_LANE))
        self.assertEqual(code, 2)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("needs"), ["track"])
        self.assertEqual(axi.get("tracks"), ["track-1", "track-2"])
        self.assertEqual(axi.get("totalCount"), 2)
        self.assertNotIn("decision", axi)
        self.assertTrue(stdout.startswith("axi:"))

    def test_a_failed_queue_read_exits_one_and_is_never_drained(self):
        """AC13 — a queue GET that returns non-ok exits **1** with `ok=false`, a
        structured warning naming the read failure, and NO `decision` key. An
        unreadable roadmap and an empty one are different facts."""
        code, _out, _err, axi, _ops = self.drive(
            {"ok": False, "error": "connection refused"})
        self.assertEqual(code, 1)
        self.assertIs(axi.get("ok"), False)
        self.assertNotIn(
            "decision", axi,
            "a failed read reported as DRAINED fails AC13 — it would tell the "
            "orchestrator the roadmap is empty when it is merely unreadable")
        warnings = axi.get("warnings") or []
        self.assertTrue(warnings, "the read failure must be NAMED")
        self.assertIn("connection refused",
                      " ".join(w.get("detail", "") for w in warnings))

    def test_a_failed_read_still_derives_a_help(self):
        _code, _out, _err, axi, _ops = self.drive(
            {"ok": False, "error": "connection refused"})
        self.assertTrue(axi.get("help"))
        self.assertIn(BASE_URL, " ".join(axi["help"]))

    def test_two_consecutive_invocations_are_byte_identical(self):
        """AC9 — the oracle is idempotent: there is no timestamp in the result
        fields, so identical input yields identical stdout."""
        first = self.drive(_queue(*self.LANE))[1]
        second = self.drive(_queue(*self.LANE))[1]
        self.assertEqual(first, second)
        self.assertNotEqual(first, "")

    def test_the_verb_issues_zero_non_get_requests(self):
        """AC9 — asking does not claim, lock, reserve or advance anything. A
        single POST/PATCH/PUT fails this AC."""
        for _ in range(2):
            _code, _out, _err, _axi, ops = self.drive(_queue(*self.LANE))
            self.assertEqual(
                ops.writes, [],
                f"§S4: `next` is read-only; got {ops.writes!r}")

    def test_the_queue_is_unchanged_after_asking(self):
        """AC9's second half — re-reading the queue afterwards yields an
        unchanged entry set: same ids, same seq, same status."""
        response = _queue(*self.LANE)
        before = [dict(e) for e in response["entries"]]
        self.drive(response)
        self.drive(response)
        self.assertEqual(response["entries"], before)

    def test_the_verb_never_asks_for_an_agent_identity(self):
        """AC10 — read-only, so no `--agent` and no identity gate: the args
        Namespace carries no `agent` at all and `ops.agent_id` is never
        consulted, so the verb can never route through
        `emit_agent_identity_hard_stop`."""
        _code, _out, _err, axi, ops = self.drive(_queue(*self.LANE))
        self.assertEqual(ops.agent_id_calls, 0)
        self.assertNotIn("agentId", axi.get("context") or {})

    def test_the_verb_survives_run_verb_without_an_identity(self):
        """AC10 — driven through the fleet's `run_verb` dispatch with no
        identity anywhere, `next` still answers rather than hard-stopping."""
        recorder = _RecordingOps(_queue(*self.LANE))
        args = _args()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = AXI.run_verb(
                lambda a: AXI.cmd_next(a, "/fake/dir", recorder.ops), args)
        self.assertEqual(code, 0)
        self.assertEqual(TOON.decode(out.getvalue())["axi"].get("decision"),
                         "NEXT")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the published `seq` is the order; a missing one is a defect to surface
# ═══════════════════════════════════════════════════════════════════════════


class LaneOrderTest(_NextTestBase):

    def test_the_lane_is_ordered_by_the_published_seq(self):
        """§S4 — `next` never re-orders the lane. The response arrives in the
        server's `ORDER BY seq ASC`; a scrambled response is still resolved by
        the DECLARED seq, not by arrival position."""
        entries = [_entry("CR-THIRD", 30), _entry("CR-FIRST", 10),
                   _entry("CR-SECOND", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("cr"), "CR-FIRST")
        self.assertEqual(fields.get("seq"), 10)

    def test_an_entry_with_no_seq_is_surfaced_rather_than_positioned(self):
        """§S2 — "091 publishes `seq` on every entry, so an entry without one
        is a defect to surface, not a hole to fill with a position." The
        resolver must not silently substitute the array index."""
        entries = [{"cr": "CR-NOSEQ", "wave": "5", "dependsOn": [],
                    "status": "PENDING"},
                   _entry("CR-OK", 10)]
        _ok, _code, fields, warnings = self.resolve(entries)
        codes = [w.get("code") for w in warnings]
        self.assertIn(
            "missing-seq", codes,
            f"the defect must be NAMED in a structured warning; got "
            f"{warnings!r}")
        self.assertIn("CR-NOSEQ",
                      " ".join(w.get("detail", "") for w in warnings))
        self.assertEqual(
            fields.get("cr"), "CR-OK",
            "an entry with no declared position cannot be the lowest-seq one; "
            "giving it index 0 would be exactly the derivation §S2 forbids")


# ═══════════════════════════════════════════════════════════════════════════
# §S5 — the harness DB is untouched, and the verb lands ONCE
# ═══════════════════════════════════════════════════════════════════════════


class HarnessIsolationTest(unittest.TestCase):
    """§S5 (absolute) — no code path in `clients/` may open, read, import or
    shell out to the harness ChangeSet DB. No fallback, no cross-check."""

    FORBIDDEN = ("schedule_db", ".wf-schedule.db", ".nai-schedule.db",
                 "next_for_track", "worktree-flow")

    def test_no_client_reaches_for_the_harness_lane_plan(self):
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*.py")):
            text = path.read_text(encoding="utf-8", errors="replace")
            hits = [token for token in self.FORBIDDEN if token in text]
            if hits:
                offenders[path.name] = hits
        self.assertEqual(
            offenders, {},
            f"§S5: the two `next`s are never reconciled — a disagreement is a "
            f"real signal and is left visible; got {offenders!r}")


class ResolverLandsOnceTest(unittest.TestCase):
    """CR-CRU-054's DRY rule, applied to this CR's own surface: the resolver
    lives in the shared module and NO client re-implements it. C2 wires five
    thin subparsers that delegate; a `def cmd_next` in a client would be the
    five-copy drift the lift exists to prevent."""

    SHARED_SYMBOLS = ("canonical_track", "queue_tracks", "resolve_next",
                      "cmd_next")

    def test_the_shared_module_owns_every_resolver_symbol(self):
        for name in self.SHARED_SYMBOLS:
            with self.subTest(symbol=name):
                self.assertTrue(
                    callable(getattr(AXI, name, None)),
                    f"`{name}` must live in clients/_crucible_axi.py")

    def test_no_client_defines_its_own_resolver(self):
        pattern = re.compile(
            r"^def (canonical_track|queue_tracks|resolve_next|cmd_next)\b",
            re.M)
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*-crucible.py")):
            found = pattern.findall(path.read_text(encoding="utf-8"))
            if found:
                offenders[path.name] = found
        self.assertEqual(offenders, {}, f"resolver duplicated: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
