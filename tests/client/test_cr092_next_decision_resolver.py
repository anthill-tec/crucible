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
        exists to prevent. Mirrors `normalizeTrack` (src/store.ts:362-365).

    queue_tracks(queue) -> [str]
        §S3, as CR-CRU-108 §S2 leaves it: the tracks the queue READ published
        (`declaredTracks`, src/store.ts:393), NOT a set the client derives.
        `len > 1` is still the whole definition of "multi-track", and the
        values are still echoed as stored rather than re-spelled — the rule
        simply has one home now, on the server that owns the normalisation.

    resolve_next(entries, track=None, tracks=[str]) -> (ok, code, fields, warnings)
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

import ast
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


def _published_tracks(entries):
    """CR-CRU-108 §S1/AC1 — what `GET …/queue` publishes BESIDE its entries:
    the sorted distinct non-blank TRIMMED `track` values (`declaredTracks`,
    src/store.ts:380, called from `handleQueueGet`).

    One spelling of the server's rule, copied verbatim from the sibling
    `tests/client/test_client_fleet_envelope_census.py` rather than re-worded,
    so the two harnesses cannot drift into two ideas of what the read
    publishes."""
    return sorted({(e.get("track") or "").strip() for e in entries
                   if (e.get("track") or "").strip()})


def _queue(*entries):
    return {"ok": True, "entries": list(entries),
            "tracks": _published_tracks(entries)}


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
        # CR-CRU-108 §S2 — the published list is the track fact, so the pure
        # resolver is GIVEN it rather than deriving one. Every fixture in this
        # file classifies identically under both rules (AC5), so no assertion
        # below changes meaning; the whitespace/padding cases that DO change
        # are AC5b's and live in `PublishedTrackFactTest`.
        return AXI.resolve_next(entries, track=track,
                                tracks=_published_tracks(entries))

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
                    f"for it (src/store.ts:362-365) so the helper must too, "
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
        # CR-CRU-118 §S4 -- the route refuses a proposal naming no target
        # date. Nothing here is about the date; the fixture needs the release
        # to be a plannable target at all, so it declares one plausible date.
        _http(cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
              {"label": cls.RELEASE, "agentId": cls.AGENT,
               "targetAt": 1788220800})  # 2026-09-01T00:00:00Z

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

    # CR-CRU-108 §S2/AC4 — `test_the_live_track_list_is_what_the_server_holds`
    # was deleted here: it called `queue_tracks(<entries>)` and pinned the
    # distinct-set computation this CR RETIRES. Its live-data claim survives
    # behaviourally in `test_the_answer_is_about_the_lane_asked_for_never_a_
    # siblings` below, which asks for the second stored lane by its own
    # spelling and gets an answer about THAT lane.

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
                self.entries, track=spelling,
                tracks=_published_tracks(self.entries))
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

    def test_the_answer_is_about_the_lane_asked_for_never_a_siblings(self):
        """Multi-track, against real stored values: `--track 3` answers about
        track-3, never track-2.

        WHICH answer that is moved with CR-CRU-114 §S1/§S3. Every cr in this
        fixture sits in its OWN wave, and the wave predicate reads `wave`
        alone, so the resolved wave is the first actionable row's — track-2's.
        track-3 holds nothing there, and a lane with nothing scheduled inside
        an unfinished wave is `awaiting-assignment`. Naming `CR-TRK-OTHER`
        instead would walk into a later wave — the silent crossing this CR
        exists to end, and work whose `plan-file` the wave-scope guard would
        refuse. The claim under test is unchanged: the answer is ABOUT the
        lane asked for, and never track-2's."""
        fields = AXI.resolve_next(self.entries, track="Track 3",
                                  tracks=_published_tracks(self.entries))[2]
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "awaiting-assignment")
        self.assertEqual(fields.get("track"), "track-3")
        self.assertNotIn(
            "cr", fields,
            "a drained lane names no cr — least of all the other lane's")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 / AC7 / AC8 — track scoping is conditional on the data
# ═══════════════════════════════════════════════════════════════════════════


TWO_TRACK_LANE = (
    _entry("CR-CRU-100", 10, track="track-1"),
    _entry("CR-CRU-200", 20, track="track-2"),
)


class TrackScopingTest(_NextTestBase):

    # CR-CRU-108 §S2/AC4 — `test_tracks_are_the_sorted_distinct_non_null_
    # stored_values` was deleted here: it asserted the client's OWN
    # distinct-set computation, which is the mechanism this CR deletes. The
    # published-list behaviour it used to stand for is covered by
    # `PublishedTrackFactTest`, over a payload whose entries and whose
    # published `tracks` disagree.

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
        """AC14's positive half, on the same fixture shape.

        The TRACK half moved with CR-CRU-114 §S4 and is re-pinned here rather
        than re-worded around: `track` rides an answer only when the project
        declares MORE THAN ONE lane, because one declared lane is no lane to
        choose between and echoing the row's stored value would tell a reader
        a lane was resolved when none was. Its positive half is asserted where
        it is now true —
        `TrackCanonicalisationAgreesWithTheServerTest.test_next_resolves_every_spelling_against_the_stored_lane`,
        over two published lanes. The RELEASE half is untouched: a declared
        release still rides its own answer verbatim, and an absent one is
        still omitted (the test above)."""
        entries = [_entry("CR-DECLARED", 10, wave="5", release="0.2.0",
                          track="track-1"),
                   _entry("CR-BARE", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("cr"), "CR-DECLARED")
        self.assertEqual(fields.get("release"), "0.2.0")
        self.assertNotIn(
            "track", fields,
            "this queue publishes ONE lane, so no lane was resolved: a stored "
            "track echoed here would name a container the answer never chose")
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

# §S2 — one fixture per DRAINED reason, keyed BY the reason, so
# `DRAINED_REASONS` is asserted in both directions rather than restated as an
# inline tuple. The mirror of `HOLD_FIXTURES` and its
# `test_the_four_kinds_are_the_declared_vocabulary`.
DRAINED_FIXTURES = {
    # The queue read returned zero entries.
    "no-roadmap": ((), None),
    # Entries exist; none carries the lane asked for, so the lane is empty.
    "awaiting-assignment": ((_entry("CR-A", 10, track="track-1"),), "2"),
    # The lane held work and all of it landed.
    "wave-complete": ((_entry("CR-A", 10, status="COMPLETED"),), None),
}


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
                self.assertIn(fields.get("reason"), AXI.DRAINED_REASONS)
                self.assertIsNone(fields.get("cr"))
                self.assertNotIn("cr", fields)

    def test_the_three_reasons_are_the_declared_vocabulary(self):
        """§S2 — `DRAINED_REASONS` is the enum, not a comment. Asserted BOTH
        ways, so a fourth reason can never be added in one place only: every
        reason a fixture actually produces is IN the constant, and every reason
        the constant declares is REACHABLE by a fixture. Exactly the guard
        `HOLD_TRIGGER_KINDS` gets from
        `test_the_four_kinds_are_the_declared_vocabulary`, and what makes the
        constant's own docstring ("the enum is one list rather than string
        literals scattered downstream") true rather than aspirational."""
        produced = {}
        for reason, (entries, track) in sorted(DRAINED_FIXTURES.items()):
            with self.subTest(reason=reason):
                fields = self.fields(list(entries), track=track)
                self.assertEqual(fields.get("decision"), "DRAINED")
                produced[reason] = fields.get("reason")
        self.assertEqual(
            produced, {reason: reason for reason in DRAINED_FIXTURES},
            "each fixture must produce the reason it is keyed by")
        self.assertEqual(sorted(DRAINED_FIXTURES),
                         sorted(AXI.DRAINED_REASONS))

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

    def test_the_refusal_is_structurally_exempt_from_the_fields_projection(self):
        """§S3 + §S6 P2 — a projection narrows a RECORD, and §S3's refusal
        carries none, so `--fields` must leave it WHOLE: `needs`, the live
        `tracks[]`, its `totalCount` and the state-derived `help[]` all
        survive and the exit stays 2.

        Not cosmetic: an agent that habitually passes `--fields` would
        otherwise receive an EMPTY refusal body — no reason, no candidate
        lanes, no next step — defeating P4 (`totalCount` on the verb's only
        list), P9 (state-derived `help[]`) and §S3's whole point, which is
        that the verb refuses INFORMATIVELY rather than guessing a lane.

        Measured over several flag values AND against the unflagged run, so
        the exemption is STRUCTURAL — keyed on there being no record — rather
        than a special case for one spelling."""
        plain = self.drive(_queue(*TWO_TRACK_LANE))[1]
        for spelling in ("decision", "cr,seq", "tracks", "needs", "help"):
            with self.subTest(fields=spelling):
                code, stdout, _err, axi, _ops = self.drive(
                    _queue(*TWO_TRACK_LANE), fields=spelling)
                self.assertEqual(code, 2)
                self.assertIs(axi.get("ok"), False)
                self.assertEqual(axi.get("needs"), ["track"])
                self.assertEqual(axi.get("tracks"), ["track-1", "track-2"])
                self.assertEqual(axi.get("totalCount"), 2)
                self.assertTrue(axi.get("help"))
                self.assertNotIn("decision", axi)
                self.assertEqual(
                    stdout, plain,
                    "the refusal must be byte-identical with and without "
                    "--fields; anything else is the projection reaching the "
                    "refusal scaffolding")

    def test_fields_still_narrows_a_real_decision(self):
        """P2's other half — the exemption is the REFUSAL's alone. A decision
        is still narrowed, so "stop projecting" is not a passing fix."""
        _code, _out, _err, axi, _ops = self.drive(
            _queue(*self.LANE), fields="decision,cr")
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-CRU-100")
        for dropped in ("seq", "wave", "help"):
            self.assertNotIn(dropped, axi)

    def test_the_context_carries_the_lane_the_answer_resolved(self):
        """§S6 P7 — "the `context` block carries the resolved lane". The block
        `axi_context` builds reads `$WORKFLOW_ROLE`, which is the DECLARED
        lane, so a session declaring track-1 while asking `--track 2` would
        otherwise emit an answer ABOUT track-2 stamped track-1: an agent
        reading `context.track` is then misled by its own envelope."""
        os.environ["WORKFLOW_ROLE"] = "track-1"
        _code, _out, _err, axi, _ops = self.drive(
            _queue(*TWO_TRACK_LANE), track="2")
        self.assertEqual(axi.get("cr"), "CR-CRU-200")
        self.assertEqual(
            (axi.get("context") or {}).get("track"), "track-2",
            "context.track must name the lane RESOLVED, never the lane the "
            "session merely declared")

    def test_nothing_resolved_leaves_the_declared_lane_standing(self):
        """P7's other half. A bare invocation scoped no lane — the answer
        covers the queue as published — and §S3's refusal scoped none BY
        DEFINITION, because refusing is precisely not picking a lane. With no
        resolved lane to carry, the declaration is the only track fact
        available and must not be dropped."""
        os.environ["WORKFLOW_ROLE"] = "track-1"
        bare = self.drive(_queue(*self.LANE))[3]
        self.assertEqual((bare.get("context") or {}).get("track"), "track-1")
        refusal = self.drive(_queue(*TWO_TRACK_LANE))[3]
        self.assertEqual((refusal.get("context") or {}).get("track"),
                         "track-1")

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
# §S2 — the PUBLISHED order is the order; a missing `seq` is a defect to surface
# ═══════════════════════════════════════════════════════════════════════════


class LaneOrderTest(_NextTestBase):

    def test_the_lane_is_ordered_by_the_published_seq(self):
        """§S4 — `next` never re-orders the lane. CR-CRU-095 §S1/AC6 made that
        literally true: the server publishes ONE canonical order and the
        resolver consumes position 0 of it. A deliberately scrambled response
        [seq 30, 10, 20] is therefore answered by its FIRST published row —
        re-sorting it by the seq VALUE would be the reader-side derivation
        CR-091 AC18 outlawed."""
        entries = [_entry("CR-THIRD", 30), _entry("CR-FIRST", 10),
                   _entry("CR-SECOND", 20)]
        fields = self.fields(entries)
        self.assertEqual(fields.get("cr"), "CR-THIRD")
        self.assertEqual(fields.get("seq"), 30)

    def test_an_entry_with_no_seq_is_surfaced_rather_than_positioned(self):
        """§S2 — "091 publishes `seq` on every entry, so an entry without one
        is a defect to surface, not a hole to fill with a position." The
        resolver must not silently substitute the array index — and, since
        CR-CRU-095 AC6a, must not MOVE the row either: it keeps the position
        the server published, so published first it is picked first."""
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
            fields.get("cr"), "CR-NOSEQ",
            "the server published CR-NOSEQ first, so it is first; moving it "
            "last is the client deciding an order, which CR-CRU-095 AC6 "
            "removes — the warning above is how the defect is surfaced")


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
    lives in the shared module and NO client re-implements it.

    C2 correction (2026-08-28): C1 wrote this class expecting `def cmd_next`
    to be absent from every client too. That was wrong about the fleet's
    established shape, not about the rule. CR-CRU-091 C3 (`8908cc0`) settled
    the registration pattern: the ENTRY POINT is a per-client `def cmd_<verb>`
    that supplies that client's own `_resolve_project_dir`/`_project_dir` and
    `_ops()` and does nothing else, because a shared registrar's
    `set_defaults(func=...)` needs a client-bound callable. So `cmd_next`
    moves out of the forbidden list and into a STRONGER assertion below: it
    must exist in all five clients AND be a single delegating call. The three
    PURE resolver symbols stay forbidden outright — those a client has no
    reason to spell at all."""

    SHARED_SYMBOLS = ("canonical_track", "queue_tracks", "resolve_next",
                      "cmd_next")

    # The pure resolver: a client that spells any of these has copied logic.
    FORBIDDEN_IN_CLIENTS = ("canonical_track", "queue_tracks", "resolve_next")

    def test_the_shared_module_owns_every_resolver_symbol(self):
        for name in self.SHARED_SYMBOLS:
            with self.subTest(symbol=name):
                self.assertTrue(
                    callable(getattr(AXI, name, None)),
                    f"`{name}` must live in clients/_crucible_axi.py")

    def test_no_client_defines_its_own_resolver(self):
        """The pure resolver is forbidden in a client, and the ONE entry point
        a client does own must be THIN: exactly one statement, delegating to
        `_axi().cmd_next(...)`. That is a tighter guard than C1's blanket ban,
        which a client could satisfy while carrying a second copy of the
        decision logic under any other name."""
        forbidden = re.compile(
            r"^def (" + "|".join(self.FORBIDDEN_IN_CLIENTS) + r")\b", re.M)
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*-crucible.py")):
            source = path.read_text(encoding="utf-8")
            copied = forbidden.findall(source)
            if copied:
                offenders[path.name] = f"resolver copied: {copied!r}"
                continue
            body = [node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef)
                    and node.name == "cmd_next"]
            if len(body) != 1:
                offenders[path.name] = f"{len(body)} `cmd_next` definitions"
                continue
            statements = [s for s in body[0].body
                          if not (isinstance(s, ast.Expr)
                                  and isinstance(s.value, ast.Constant))]
            delegates = (
                len(statements) == 1
                and isinstance(statements[0], ast.Return)
                and isinstance(statements[0].value, ast.Call)
                and isinstance(statements[0].value.func, ast.Attribute)
                and statements[0].value.func.attr == "cmd_next")
            if not delegates:
                offenders[path.name] = (
                    f"`cmd_next` is not a single delegating call: "
                    f"{ast.dump(body[0])[:160]}")
        self.assertEqual(
            offenders, {},
            f"the decision resolver lands ONCE and each client contributes a "
            f"thin delegator only: {offenders!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S6 — the `path:line` citations the block's docstrings carry
# ═══════════════════════════════════════════════════════════════════════════


def _next_block_source():
    """The `next` code block, LOCATED rather than hardcoded: from its own
    CR-CRU-092 banner to the last line of `cmd_next`. Hardcoding the bounds
    here would go stale exactly the way the citation this guard caught did."""
    text = AXI_MODULE_PATH.read_text(encoding="utf-8")
    lines = text.splitlines()
    banners = [n for n, line in enumerate(lines, 1)
               if line.startswith("# ── CR-CRU-092")]
    assert len(banners) == 1, f"expected ONE CR-CRU-092 banner: {banners!r}"
    end = next(node.end_lineno for node in ast.parse(text).body
               if isinstance(node, ast.FunctionDef)
               and node.name == "cmd_next")
    return "\n".join(lines[banners[0] - 1:end])


_CITATION_RE = re.compile(r"[\w./-]+\.(?:ts|py|md):\d+(?:-\d+)?")


class NextBlockCitationsTest(unittest.TestCase):
    """Every `path:line` citation the `next` block's docstrings carry, checked
    against the TARGET FILE instead of trusted.

    C2's own subparser registrations shifted `clients/python-crucible.py`
    downwards, so `_next_start_help`'s citation for plan-file's flags came to
    point at the `pre-merge-gate` block's `--cov-source` line. A drifted
    citation is worse than no citation: it sends the next reader to the wrong
    construct with full confidence.

    A source-text guard is the right shape HERE (unlike AC18's, which this
    file deliberately made behavioural): a citation IS a claim about source
    coordinates, so there is nothing else to measure. Each entry brackets the
    construct — a token that must sit on the FIRST cited line and one that
    must sit on the LAST — because a range that merely CONTAINS the construct
    somewhere is exactly the drift that shipped."""

    # (citing site, cited path, first, last, head token, tail token)
    CITATIONS = (
        ("the §S1 exit-code rule", "clients/STATUS-CONTRACT.md", 65, 68,
         "## Terminal states (all exit 0)", "all exit 0:"),
        # Re-pinned 2026-09-03 (CR-CRU-099 C1): §S1's release-axis widening
        # added +61 lines to replaceQueue, above this construct, drifting it
        # 3925 -> 3961. Same rule as the entry below — the CR that shifted the
        # file is the CR that re-pins it, and this guard is the only thing in
        # the repo that caught the drift.
        # Re-pinned 2026-09-07 (CR-CRU-094 C4), 3961 -> 4073. This drift is
        # INHERITED, not ours: the entry already fails identically on
        # `develop`, verified by running this suite in a throwaway `develop`
        # worktree, so some CR between 099 and this branch's cut shifted
        # `src/store.ts` above `deriveQueueStatus` and did not re-pin. It is
        # fixed here opportunistically because the entry below had to move
        # anyway and a one-line re-record while already in the table is
        # cheaper than a second visit — NOT because CR-CRU-094 caused it. The
        # reason it survived on `develop` at all is that no merge gate runs
        # this suite; that gap is recorded separately as a candidate CR.
        # Re-pinned 2026-09-07 (CR-CRU-108 §S1), 4073 -> 4098. This drift IS
        # ours and it is the ordinary case: §S1 inserted `declaredTracks` (25
        # lines, src/store.ts:364-388 — 364 is the opening `/**` and 388 the
        # blank that separates the block) ABOVE `deriveQueueStatus`, moving it
        # down by exactly that much. The CR that shifted the file re-pins it.
        # NOTE (RED commit): the production comment this row mirrors —
        # `clients/_crucible_axi.py:1418` — still spells 4073, so
        # `test_the_table_covers_every_citation_the_block_carries` is RED
        # between this commit and §S2's cutover, which moves the block's
        # citation to match. Split across two commits because the client file
        # is held by the cutover; the split is deliberate, not a defect.
        # Re-pinned 2026-09-09 (CR-CRU-116 §S1), 4098 -> 4256. This drift IS
        # ours and it is the ordinary case: §S1 extracted the ONE in-flight
        # rule into `Store.queueStatusOf` and put `waveScopeRefusal` and
        # `queueStatuses` ABOVE `deriveQueueStatus`, moving it down by exactly
        # that much. The CR that shifted the file re-pins it — and this guard
        # is the only thing in the repo that caught it, because it lives in
        # the PYTHON suite that no bun-side run reaches.
        # Re-pinned 2026-09-12 (CR-CRU-119 GREEN), 4267 -> 4294: the seq-cause
        # split added citation lines above `deriveQueueStatus` in
        # src/store.ts. The drift IS ours, and this guard is the only thing
        # in the repo that caught it, because it lives in the PYTHON suite
        # that no bun-side run reaches.
        # Re-pinned 2026-09-12 (CR-CRU-121 GREEN), 4294 -> 4349: composing
        # cr-plan's queue write into `plan-file` added 55 lines ABOVE
        # `deriveQueueStatus` in src/store.ts, moving it down by exactly that
        # much. The drift IS ours and it is the ordinary case: the CR that
        # shifted the file re-pins it — and this guard is once again the only
        # thing in the repo that caught it, because it lives in the PYTHON
        # suite that no bun-side run reaches.
        # Re-pinned 2026-09-12 (CR-CRU-126 FIX), 4349 -> 4411: this CR inserted
        # in TWO places ABOVE `deriveQueueStatus` in src/store.ts — the
        # `idx_events_project_cycle` declaration inside `createBaseTables` and
        # the appended `MIGRATIONS` backfill body — moving it down 62 lines.
        # The drift IS ours and it is the ordinary case: the CR that shifted
        # the file re-pins it, and the CR's own gap analysis (DRIFT-9)
        # predicted exactly this row. The new number was LOCATED at HEAD, not
        # computed from the old one plus a delta. The three sibling entries
        # were re-measured at both ends in the same pass and none had moved.
        ("LANDED_STATUSES", "src/store.ts", 4411, 4411,
         "private deriveQueueStatus(", "private deriveQueueStatus("),
        # Re-pinned 2026-09-12 (CR-CRU-119 GREEN), 349-352 -> 362-365: the
        # QueueSeqReport/preservedSeq additions and the seq-cause split
        # inserted comment and code lines above `normalizeTrack` in
        # src/store.ts. The CR that shifted the file re-pins it.
        ("canonical_track", "src/store.ts", 362, 365,
         "export function normalizeTrack(", "}"),
        # Re-pinned 2026-09-03 (CR-CRU-097 C4): §S2's citation moves added
        # lines above this block, drifting it 1349-1362 -> 1370-1384. This is
        # the guard doing its job — the CR that shifted the file is the CR
        # that re-pins it.
        # Re-pinned 2026-09-07 (CR-CRU-094 §S3): wiring the pre-flight
        # attribution check into this client's `test`/`regression`/
        # `auto-ingest`/`check` verbs added lines above this block, drifting
        # it 1370-1384 -> 1422-1436. Same rule, same guard.
        # Re-pinned 2026-09-07 (CR-CRU-107 §S1): the repeatable `--cycle` flag
        # was declared INSIDE this very block, moving its tail two lines down,
        # 1422-1436 -> 1422-1438. The narrowest possible drift — the CR that
        # shifted the construct is the CR that re-pins it.
        # Re-pinned 2026-09-08 (CR-CRU-111 §S1): the tier registration added
        # `_add_regression_tier_args` and the shared `add_tier_verbs` call
        # ABOVE this block, drifting it 1422-1438 -> 1437-1453. Same rule,
        # same guard: the CR that shifted the file re-pins it.
        # Re-pinned 2026-09-08 (CR-CRU-111 §S2): stripping the unearned tier
        # stamp rewrote `cmd_test`/`cmd_auto_ingest`/`_ingest_compile` ABOVE
        # this block (their docstrings and comments now state what the client
        # does NOT claim), drifting it 1437-1453 -> 1452-1468. Same rule, same
        # guard, third time: the CR that shifted the file re-pins it.
        # Re-pinned 2026-09-08 (CR-CRU-111 §S3): AC6a's refusal now NAMES this
        # stack's declaration surface, and the constant carrying it plus the
        # registrar's `declares=` argument sit ABOVE this block, drifting it
        # 1452-1468 -> 1463-1479. Same rule, same guard, fourth time.
        # Re-pinned 2026-09-08 (CR-CRU-111 §S4): the wall-vs-CPU bracket around
        # `cmd_test`'s runner child (AC6b) and the warning it hands the ingest
        # envelope sit ABOVE this block, drifting it 1463-1479 -> 1471-1487.
        # Same rule, same guard, fifth time: the CR that shifted the file
        # re-pins it.
        # Re-pinned 2026-09-08 (CR-CRU-111 §S6): the DECLARED-cell detection
        # seam — this stack's declared-cell flag adder, its READ of the
        # discovery declaration and its RUN — sits ABOVE this block, drifting
        # it 1471-1487 -> 1526-1542. Same rule, same guard, sixth time.
        # Re-pinned 2026-09-08 (CR-CRU-112 §S1): this client's `_STACK`, the
        # `stack` key on its ingest and its gate's composition over the
        # declared suites all sit ABOVE this block, drifting it
        # 1526-1542 -> 1552-1568. Same rule, same guard, seventh time.
        # Re-pinned 2026-09-10 (CR-CRU-115 cycle 407): cycle 403 added
        # `--release` to BOTH gate subparsers, and the three lines it put in
        # `pre-merge-gate`'s block sit ABOVE this one, drifting it
        # 1552-1568 -> 1555-1571 (measured at both ends, not inferred from the
        # shift). Same rule, same guard, eighth time — and the first time the
        # drift reached a merge gate, because CR-CRU-115 never dispatched this
        # suite; the gate caught what the dispatch list missed.
        # Re-pinned 2026-09-12 (CR-CRU-121 GREEN): the shared
        # `add_plan_file_release_arg(pf)` delegation — the one line that gives
        # `plan-file` the release argument it composes cr-plan's queue write
        # from — was declared INSIDE this very block, moving its tail one line
        # down, 1555-1571 -> 1555-1572 (measured at both ends, not inferred
        # from the shift; the head is unchanged). The narrowest possible
        # drift, ninth time — the CR that shifted the construct re-pins it.
        # Re-pinned 2026-09-13 (CR-CRU-127 GREEN): TWO changes INSIDE this
        # very block, both of them the kind mandate's — the shared
        # `add_plan_file_cycle_kind_arg(pf)` delegation (one line, beside the
        # `--cycle` it pairs with) and `--cycles`' own help, rewritten to say
        # it is REFUSED for filing (§S4a) and wrapped over four lines instead
        # of two. Tail 1572 -> 1576, head unchanged, measured at both ends
        # after the last edit rather than inferred from the shift. Tenth time
        # — the CR that shifted the construct re-pins it.
        # Re-pinned 2026-09-13 (CR-CRU-128 GREEN): §S1 gave `auto-ingest`'s
        # `--agent` the nominated description, four lines ABOVE this block,
        # drifting it 1555-1576 -> 1559-1580. Measured at BOTH ends after the
        # last production edit, not inferred from the shift. Eleventh time —
        # the CR that shifted the file re-pins it. Worth recording: CR-CRU-128's
        # own census anchors on (source, scope, flag) precisely to avoid this
        # rot; this row is the only line-pinned guard left in the repo.
        ("_next_start_help", "clients/python-crucible.py", 1559, 1580,
         'sub.add_parser("plan-file"', "set_defaults(func=cmd_plan_file)"),
    )

    def test_every_citation_still_brackets_the_construct_it_claims(self):
        offenders = {}
        for who, rel, first, last, head, tail in self.CITATIONS:
            lines = (REPO_ROOT / rel).read_text(
                encoding="utf-8").splitlines()
            cited = f"{rel}:{first}" + ("" if last == first else f"-{last}")
            if head not in lines[first - 1]:
                offenders[who] = (f"{cited} opens on {lines[first - 1]!r}, "
                                  f"not {head!r}")
            elif tail not in lines[last - 1]:
                offenders[who] = (f"{cited} closes on {lines[last - 1]!r}, "
                                  f"not {tail!r}")
        self.assertEqual(
            offenders, {},
            f"a docstring citation must name the construct it points at: "
            f"{offenders!r}")

    def test_the_table_covers_every_citation_the_block_carries(self):
        """The other half: this table cannot silently stop covering one. Every
        `path:line` the block spells must be declared above, so a citation
        added without verification fails here rather than rotting quietly."""
        declared = {
            f"{rel}:{first}" + ("" if last == first else f"-{last}")
            for _who, rel, first, last, _head, _tail in self.CITATIONS}
        self.assertEqual(
            set(_CITATION_RE.findall(_next_block_source())), declared,
            "every citation in the `next` block is verified, and the table "
            "declares no citation the block does not carry")


# ═══════════════════════════════════════════════════════════════════════════
# CR-CRU-108 §S2 — the client READS the published track fact
#
# RED (2026-09-07). §S1 shipped on this branch: `GET …/queue` now publishes
# `tracks` — the sorted distinct non-blank values, TRIMMED (`declaredTracks`,
# src/store.ts:380, called from `handleQueueGet`, src/v2.ts:1848). §S2 makes
# the fleet READ that list instead of re-deriving one, and the reason is
# measured rather than aesthetic: `queue_tracks` filters on TRUTHINESS and
# never trims, so over the fixture AC6 names the two rules answer FOUR tracks
# and TWO (measured 2026-09-07).
#
# Every behavioural test below drives the PAYLOAD rather than grepping the
# SUT: a queue read whose `entries` and whose published `tracks` DISAGREE is
# the one instrument a client that still recomputes cannot pass, and it is
# driven in BOTH directions — a published list that NARROWS the answer to one
# lane, and one that WIDENS it to two. The second is the CR's stated risk:
# "a queue read that fails or omits `tracks` must not silently make a
# multi-track project look single-track".
# ═══════════════════════════════════════════════════════════════════════════


def _published_queue(entries, tracks):
    """The §S1 queue read: the entries AND the track list the server DECLARED.

    `tracks` is passed EXPLICITLY, never derived here — a fixture that
    computed the list would be running the very rule under test and could
    never disagree with the entries, which is precisely the disagreement these
    tests need."""
    return {"ok": True, "entries": list(entries), "tracks": list(tracks)}


# The fixture AC6 names, in the shape the read publishes it. The `null` row is
# spelled literally (the server OMITS a null `track`, so `_entry` cannot carry
# one) beside the absent-key row, because AC6 names both cases.
#
# Every id this section authors reads `CR-Q108-*`, never `CR-CRU-*`:
# CR-CRU-097 AC7 forbids a test asserting on the project's own namespace, and
# these ids ARE asserted on (the answer `next` returns is the id it picked).
# The `CR-CRU-*` ids elsewhere in this file predate that rule and are pinned
# by its dated residue table.
CR108_DIVERGENT_ENTRIES = (
    {**_entry("CR-Q108-600", 10), "track": None},
    _entry("CR-Q108-601", 20),
    _entry("CR-Q108-602", 30, track=""),
    _entry("CR-Q108-603", 40, track="   "),
    _entry("CR-Q108-604", 50, track="2"),
    _entry("CR-Q108-605", 60, track="track-2"),
    _entry("CR-Q108-606", 70, track=" track-2 "),
)

# What §S1 publishes over it: blank-dropped, TRIMMED, distinct, sorted — TWO
# lanes, with the legacy `"2"` echoed as stored rather than re-spelled (AC2).
CR108_PUBLISHED_TRACKS = ["2", "track-2"]


def _truthy_untrimmed_tracks(entries):
    """The PRE-CUTOVER client rule §S2 deletes, kept in the TEST file and never
    in the SUT — the `_status_only_pick` idiom. Its job is to prove the fixture
    above genuinely DIVIDES the two rules, so AC4/AC5b rest on a demonstrated
    wrong answer rather than on an assertion nobody could fail."""
    return sorted({e.get("track") for e in entries or [] if e.get("track")})


def _published_tracks_reads(path):
    """AC8 — every read of the published `tracks` KEY in `path`, as
    `(receiver, expression)`: `resp.get("tracks")`, `queue["tracks"]`. A dict
    LITERAL that writes the key is not a read, so the resolver building its own
    refusal is not counted, and reads off the `fields` dict the resolver itself
    built (`_next_legacy_line`) are the producer inspecting its own envelope
    rather than a caller consuming the server's fact — the caller filter below
    excludes them by receiver."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    reads = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get" and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "tracks"):
            reads.append((ast.unparse(node.func.value), ast.unparse(node)))
        elif (isinstance(node, ast.Subscript)
              and isinstance(node.slice, ast.Constant)
              and node.slice.value == "tracks"
              and isinstance(node.ctx, ast.Load)):
            reads.append((ast.unparse(node.value), ast.unparse(node)))
    return reads


class PublishedTrackFactTest(_NextTestBase):
    """§S2/AC4 — `queue_tracks` stops computing and starts reading. Asserted
    BEHAVIOURALLY, through the real `cmd_next` over a real payload: the source
    guard is AC4's second half and lives with the fleet's other source sweeps
    (`tests/client/test_cr054_fleet_inventory.py`)."""

    # Two lanes by BOTH rules — the disagreement is supplied by the published
    # list, so the entries can never be the reason a test here passes.
    TWO_LANE_ENTRIES = (_entry("CR-Q108-610", 10, track="track-1"),
                        _entry("CR-Q108-611", 20, track="track-2"))

    def test_the_fixture_genuinely_divides_the_two_rules(self):
        """Non-vacuity for everything below (the CR's own measurement,
        2026-09-07). If these two lists ever agreed, every assertion in this
        class would pass against a client that never changed."""
        old = _truthy_untrimmed_tracks(CR108_DIVERGENT_ENTRIES)
        self.assertEqual(old, ["   ", " track-2 ", "2", "track-2"])
        self.assertEqual(CR108_PUBLISHED_TRACKS, ["2", "track-2"])
        self.assertNotEqual(
            old, CR108_PUBLISHED_TRACKS,
            "the AC6 fixture must divide the pre-cutover client rule from the "
            "published one, or AC4/AC5b measure nothing")

    def test_the_refusal_lists_the_published_tracks_never_a_recomputed_set(self):
        """AC4 — the refusal's `tracks[]` is the list the READ published. A
        client still deriving its own answers FOUR lanes over this payload,
        two of which are a whitespace-only string and a padded duplicate."""
        code, _out, _err, axi, _ops = self.drive(
            _published_queue(CR108_DIVERGENT_ENTRIES, CR108_PUBLISHED_TRACKS))
        self.assertEqual(code, 2)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("needs"), ["track"])
        self.assertEqual(
            axi.get("tracks"), CR108_PUBLISHED_TRACKS,
            "AC4 — `tracks[]` is what the queue read published, not what the "
            "client re-derived from the entries beside it")
        self.assertEqual(
            axi.get("totalCount"), len(CR108_PUBLISHED_TRACKS),
            "§S6 P4 — the count is of the PUBLISHED list, so a caller is never "
            "told there are four lanes to choose between")
        self.assertNotIn("decision", axi)

    def test_a_published_single_track_answers_where_the_entries_read_as_two(self):
        """AC4, the narrowing direction. The payload is the INSTRUMENT: its
        entries carry two lanes and its published list carries one, so a
        client that recomputes refuses and a client that reads answers. Only
        the second is §S2's cutover."""
        code, _out, _err, axi, _ops = self.drive(
            _published_queue(self.TWO_LANE_ENTRIES, ["track-1"]))
        self.assertEqual(
            code, 0,
            "AC4 — the published list declares ONE lane, so `next` owes an "
            "answer; exit 2 is the client re-deriving the fact it was given")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-Q108-610")
        self.assertNotIn("needs", axi)
        self.assertNotIn("tracks", axi)

    def test_a_published_two_track_list_refuses_where_the_entries_read_as_one(self):
        """AC4, the widening direction — and the CR's stated RISK: a read whose
        `tracks` says two lanes must never be quietly narrowed to one by a
        client re-deriving from the entries, because that lets the scheduling
        oracle pick a lane design §11 forbids it to pick."""
        entries = (_entry("CR-Q108-620", 10, track="track-1"),
                   _entry("CR-Q108-621", 20, track="track-1"))
        published = ["track-1", "track-2"]
        code, _out, _err, axi, _ops = self.drive(
            _published_queue(entries, published))
        self.assertEqual(
            code, 2,
            "AC4/Risk — the published list declares TWO lanes; answering "
            "anyway is `next` picking a lane it was never told it could")
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("needs"), ["track"])
        self.assertEqual(axi.get("tracks"), published)
        self.assertEqual(axi.get("totalCount"), 2)
        self.assertNotIn("decision", axi)

    def test_a_read_that_states_no_track_fact_stops_instead_of_degrading(self):
        """THE CR's RISK, driven end to end through the real `cmd_next`: "a
        queue read that fails or omits `tracks` must not silently make a
        multi-track project look single-track". A project that LOOKS
        single-track gets an ANSWER, and that answer is `next` picking a lane
        design §11 forbids it to pick.

        Three ways a read can fail to state the fact -- the key absent, the
        key present and null, the key present and not a list -- and ONE
        required outcome for all three, because the client cannot tell them
        apart and must not try. The degrade this forbids is one character
        wide: `resp.get("tracks") or []` sees zero declared lanes, skips the
        refusal and names a CR, with every other test in this file green."""
        self.assertEqual(
            _truthy_untrimmed_tracks(self.TWO_LANE_ENTRIES),
            ["track-1", "track-2"],
            "non-vacuity: these entries must read as TWO lanes under any "
            "derivation, or the narrowing this test forbids could not happen")
        for shape, published in (("key-absent", {}),
                                 ("explicit-null", {"tracks": None}),
                                 ("not-a-list", {"tracks": "track-1"})):
            with self.subTest(shape=shape):
                code, _out, _err, axi, ops = self.drive(
                    {"ok": True, "entries": list(self.TWO_LANE_ENTRIES),
                     **published})
                # The assertion that matters: the two-lane queue is never
                # narrowed to one. A decision here -- ANY decision -- is the
                # Risk realised, whatever the exit code says.
                self.assertNotIn(
                    "decision", axi,
                    "Risk -- a two-lane queue whose read published no track "
                    "fact was answered anyway; that is `next` picking a lane "
                    "out of a set nobody published")
                self.assertNotIn(
                    "cr", axi,
                    "Risk -- no CR is named either: naming one IS the lane "
                    "choice, whether or not a `decision` key rides beside it")
                self.assertEqual(
                    code, 1,
                    "an unusable read exits 1, like the failed read it sits "
                    "beside -- never 0 (an answer) and never 2 (a lane "
                    "prompt, which tells the caller a flag would fix it)")
                self.assertIs(axi.get("ok"), False)
                self.assertIn(
                    "queue-track-fact-unpublished",
                    [w.get("code") for w in (axi.get("warnings") or [])],
                    f"the refusal must be NAMED in a structured warning, not "
                    f"left to prose; got {axi.get('warnings')!r}")
                self.assertTrue(
                    axi.get("help"),
                    "the refusal owes the caller the way out (upgrade the "
                    "server, then re-run)")
                self.assertEqual(
                    ops.writes, [],
                    "`next` is read-only, and a refusal is not an exception "
                    "to that")

    def test_a_whitespace_only_second_value_is_not_a_second_track(self):
        """AC5b — THE behaviour change this CR makes, asserted as a change. A
        queue declaring `"   "` beside `"2"` is multi-track to `next` TODAY (it
        refuses without `--track`) and is SINGLE-track after: the server's rule
        is the one that survives, and whitespace is not a lane."""
        entries = (_entry("CR-Q108-630", 10, track="   "),
                   _entry("CR-Q108-631", 20, track="2"))
        code, _out, _err, axi, _ops = self.drive(
            _published_queue(entries, ["2"]))
        self.assertEqual(
            code, 0,
            "AC5b — `\"   \"` is not a declared lane, so this queue is "
            "single-track and `next` answers rather than refusing")
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-Q108-630")
        self.assertNotIn(
            "needs", axi,
            "AC5b — a single-track queue never prompts for `--track`")
        self.assertNotIn("tracks", axi)

    def test_a_padded_value_collapses_into_the_track_it_pads(self):
        """AC5b's second half — `" track-2 "` beside `"track-2"` is ONE track,
        not two. Identity is the TRIMMED value (§S1), so preserving the padding
        would draw the second lane `normalizeTrack` exists to prevent."""
        entries = (_entry("CR-Q108-640", 10, track=" track-2 "),
                   _entry("CR-Q108-641", 20, track="track-2"))
        code, _out, _err, axi, _ops = self.drive(
            _published_queue(entries, ["track-2"]))
        self.assertEqual(
            code, 0,
            "AC5b — a padded value and the value it pads are ONE lane, so "
            "this queue is single-track")
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("cr"), "CR-Q108-640")
        self.assertNotIn("needs", axi)
        self.assertNotIn("tracks", axi)

    def test_the_fields_projection_can_still_select_the_published_tracks(self):
        """AC3's client half — there is no `?fields=` on the wire, so the only
        projection is `next_projection`/`select_row_fields`. `tracks` must stay
        SELECTABLE through it, carrying the PUBLISHED value; the refusal's
        structural exemption (§S6 P2) is what keeps the rest of the scaffolding
        beside it."""
        payload = _published_queue(CR108_DIVERGENT_ENTRIES,
                                   CR108_PUBLISHED_TRACKS)
        for spelling in ("tracks", "tracks,totalCount", "needs,tracks"):
            with self.subTest(fields=spelling):
                code, _out, _err, axi, _ops = self.drive(
                    payload, fields=spelling)
                self.assertEqual(code, 2)
                self.assertEqual(
                    axi.get("tracks"), CR108_PUBLISHED_TRACKS,
                    "AC3 — a projection selecting `tracks` gets the list the "
                    "server published")
                self.assertEqual(axi.get("totalCount"),
                                 len(CR108_PUBLISHED_TRACKS))
                self.assertEqual(axi.get("needs"), ["track"])
                self.assertTrue(axi.get("help"))

    def test_a_projection_omitting_tracks_narrows_without_moving_the_decision(self):
        """AC3's second half — narrowing is a PRINTING concern: the same
        payload must yield the same decision with and without `--fields`, and
        the unrequested keys must be gone."""
        payload = _published_queue(self.TWO_LANE_ENTRIES, ["track-1"])
        whole = self.drive(payload)[3]
        code, _out, _err, axi, _ops = self.drive(payload, fields="decision,cr")
        self.assertEqual(
            code, 0,
            "AC3 — the projection may not change the decision, and the "
            "published list declares ONE lane, so the decision is an answer")
        self.assertEqual(axi.get("decision"), "NEXT")
        self.assertEqual(axi.get("decision"), whole.get("decision"))
        self.assertEqual(axi.get("cr"), whole.get("cr"))
        for dropped in ("seq", "wave", "help"):
            self.assertNotIn(
                dropped, axi,
                f"a projection omitting `{dropped}` must narrow it away")


class PublishedTrackFactIsWiredTest(unittest.TestCase):
    """AC8 — integration, not stub. `handleQueueGet` produces the list (the
    server half is pinned by the bun suite); the fleet half is that at least
    one NON-TEST caller in `clients/_crucible_axi.py` actually READS it. Zero
    non-test callers means the field is unwired and the CR is incomplete."""

    def test_a_non_test_caller_reads_the_published_tracks_field(self):
        reads = _published_tracks_reads(AXI_MODULE_PATH)
        self.assertTrue(
            reads,
            "non-vacuity: the scan found no `tracks` key read of ANY kind in "
            "clients/_crucible_axi.py, so a passing verdict below would mean "
            "the scanner is broken rather than the field wired")
        consumers = [expr for receiver, expr in reads if receiver != "fields"]
        self.assertTrue(
            consumers,
            f"AC8 — no caller in clients/_crucible_axi.py reads the published "
            f"`tracks`: the only reads are off the refusal dict the resolver "
            f"itself built ({[e for _r, e in reads]!r}), which is the producer "
            f"inspecting its own envelope. Zero non-test callers means the "
            f"field is unwired.")


if __name__ == "__main__":
    unittest.main()
