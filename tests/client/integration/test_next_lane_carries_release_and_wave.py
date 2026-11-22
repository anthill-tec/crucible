"""The client's `next` agrees with the server's write side.

The feature: the work `next` offers is work the server's write side accepts
(the wave-scope guard on `plan-file`), and every `--track` spelling the client
canonicalises is the lane the server's `normalizeTrack` stores and refuses
alike. No fake can prove it: both halves sit on opposite sides of the wire —
the server's guard, its normalisation and its own `GET …/next` decide — and a
scripted board would simply be hard-coded to agree with the client.

Two classes, each on its own scratch board (`RealBoard`,
`tests/client/real_board.py`: a server of this repo's own source on a free
port over a `mkdtemp` DB — never the live instance, never the shared project):

  * `NextsAnswerIsAPlanTheWriteSideAcceptsTest` — the cr `next` names is one
    whose `plan-file` the guard accepts, and a later wave is refused.
  * `TrackCanonicalisationAgreesWithTheServerTest` — merged from
    `test_cr092_next_decision_resolver` (CR-CRU-092 AC18's
    cross-implementation half, kept by CR-CRU-098 §S4): `canonical_track`
    and the server's `normalizeTrack` store, refuse and resolve alike.

The `next` flag surface, the five clients' printed help and the harness-DB
source scan, which need no board, are
`test_next_lane_carries_release_and_wave_without_a_board`.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client import TEST_INSTALL_CLIENTS
from tests.client.client_fleet_envelope_census_helpers import (
    declare_and_require_board,
)
from tests.client.next_lane_carries_release_and_wave_helpers import (
    AXI,
    _next_through_the_client,
)
from tests.client.real_board import RealBoard

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
TOON_PATH = CLIENTS_DIR / "toon.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
}

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


TOON = _load(TOON_PATH, "next_lane_toon")


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
        cls._board = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the agreement is NOT proven without `bun`: it needs the real "
                "server's wave-scope guard on the write path. That is a "
                "missing toolchain, not a passing assertion.")
        cls._board = RealBoard(bun, "next-lane-agreement")
        cls.base = cls._board.base
        cls.key = cls._board.key
        try:
            cls._boot()
        except BaseException:
            # A board booted and then abandoned by a FAILING setUpClass is
            # never torn down (`tearDownClass` does not run when `setUpClass`
            # raises), and an orphaned server holds its port for as long as it
            # lives. Stop it on the way out, whatever went wrong.
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
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
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        """Stop the scratch board, from teardown OR from a setUpClass that
        failed after booting it. Idempotent, so both callers may run."""
        board = getattr(cls, "_board", None)
        if board is None:
            return
        cls._board = None
        board.close()

    def _client(self, argv):
        """One real client dispatch against the scratch board → (exit code,
        envelope). The orchestrator's own surface, and the only place the two
        verbs meet."""
        # CR-CRU-139 §S2 — the scratch board is declared in the fixture's own
        # project file, and the interlock refuses the spawn unless the client
        # would really resolve it: a drive that merely stopped steering would
        # reach the shipped default instead, which is a live board here.
        declare_and_require_board(self.project_dir, self.base,
                                  "bun-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
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
             "--cycle", "c1", "--cycle-kind", "red-green", "--wave", LATER_WAVE,
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
             "--cycle", "c1", "--cycle-kind", "red-green", "--wave", answer.get("wave"),
             "--agent", AGREEMENT_AGENT])
        self.assertEqual(
            (filed_code, filed.get("ok"), filed.get("code")),
            (0, True, None),
            f"the cr `next` named is work the write side accepts: a plan for "
            f"it files cleanly, carrying no refusal code at all. Got "
            f"{filed!r} for the answer {answer!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC18's CROSS-IMPLEMENTATION half — behavioural, against a real server
# ═══════════════════════════════════════════════════════════════════════════
#
# Merged from `test_cr092_next_decision_resolver` (CR-CRU-092 C1), with the
# notes that stood where its other classes stood. CR-CRU-098 moved the
# decision resolver to the server (src/next.ts, `GET …/next`) and deleted it
# from the client (AC10), so every test there that reached it was classified
# (docs/changes/CR-CRU-098-test-classification.md) and deleted:
#
# CanonicalTrackTest (3) — PORTED: tests/unit/next-resolver.test.ts, "every spelling
# 091 accepts resolves the same lane" (the standalone `canonical_track` is gone,
# so its spellings are asserted on the resolver's own surface).
#
# TrackScopingTest (9) — PORTED: tests/unit/next-resolver.test.ts, "multi-track
# refusal never picks a lane" and "every spelling 091 accepts ...".
#
# NextDecisionTest (7) — PORTED: tests/unit/next-resolver.test.ts, "NEXT names the cr
# and its published seq, verbatim".
#
# HoldDecisionTest (18) — PORTED: tests/unit/next-resolver.test.ts, "HOLD's four
# trigger kinds".
#
# DrainedDecisionTest (11) — PORTED: tests/unit/next-resolver.test.ts, "DRAINED's
# three reasons".
#
# NextVerbEnvelopeTest (15) — KEPT (adapted to AC8/AC9):
# tests/client/unit/test_cr098_next_verb_reads_the_route.py.
#
# LaneOrderTest (2) — PORTED: tests/unit/next-resolver.test.ts, "resolveNext consumes
# the PUBLISHED order, never re-sorts by seq value".
#
# ResolverLandsOnceTest (2) — KEPT (rewritten for AC10/AC11):
# since deleted with the other source-shape guards.
#
# NextBlockCitationsTest (2) — RETIRED under CR-CRU-098 §S4: it checked the
# `path:line` citations inside the client's `next` block. That block is now the
# verb and its presentation only; the line citations into the client resolver
# it guarded are gone with the resolver.
#
# PublishedTrackFactTest (9) and PublishedTrackFactIsWiredTest (1) — RETIRED
# under CR-CRU-098 §S4: they held the client to READING the queue's published
# track fact and refusing a read that omitted it (`queue_tracks`,
# `QueueTrackFactUnpublished`). On the server the resolver reads the declared
# tracks directly, so an unpublished track fact cannot arise.
#
# HarnessIsolationTest, which never reached the resolver, is unedited in
# `test_next_lane_carries_release_and_wave_without_a_board` (it needs no board).
#
# TrackCanonicalisationAgreesWithTheServerTest (5) — KEPT (CR-CRU-098 §S4,
# corrected at C3): the client↔server track mirror survives, so its
# agreement test stands here.


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
    and `track-2` producing TWO lanes for one track. The last two tests close
    the loop through the client's own `next` verb, which since CR-CRU-098 asks
    the scratch server's `GET …/next` for the decision over what it stored.

    CR-CRU-098 C3 — KEPT, not retired (§S4, corrected at C3): `canonical_track`
    survives as `next_context`'s stamp canonicaliser, so the client↔server
    mirror survives and so does this test of it. Its two `resolve_next` drives
    moved from the deleted client resolver onto `cmd_next` against the same
    scratch server; every assertion is unchanged.
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
        cls._board = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "AC18's cross-implementation half is NOT proven without `bun`: "
                "it needs the real server's normalizeTrack on the write path. "
                "This is a missing toolchain, not a passing assertion.")
        cls._board = RealBoard(bun, "cr092-scratch")
        cls.base = cls._board.base
        cls.key = cls._board.key
        try:
            cls._boot()
        except BaseException:
            # A board booted and then abandoned by a FAILING setUpClass is
            # never torn down (`tearDownClass` does not run when `setUpClass`
            # raises), and an orphaned server holds its port for as long as it
            # lives. Stop it on the way out, whatever went wrong.
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
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
        cls._stop_server()

    @classmethod
    def _stop_server(cls):
        """Stop the scratch board, from teardown OR from a setUpClass that
        failed after booting it. Idempotent, so both callers may run."""
        board = getattr(cls, "_board", None)
        if board is None:
            return
        cls._board = None
        board.close()

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
            ok, code, fields = _next_through_the_client(
                self.base, self.key, spelling)
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
        fields = _next_through_the_client(self.base, self.key, "Track 3")[2]
        self.assertEqual(fields.get("decision"), "DRAINED")
        self.assertEqual(fields.get("reason"), "awaiting-assignment")
        self.assertEqual(fields.get("track"), "track-3")
        self.assertNotIn(
            "cr", fields,
            "a drained lane names no cr — least of all the other lane's")


if __name__ == "__main__":
    unittest.main()
