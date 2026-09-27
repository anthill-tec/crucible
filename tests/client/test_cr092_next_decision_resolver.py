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
        exists to prevent. Mirrors `normalizeTrack` (src/store.ts).

    queue_tracks(queue) -> [str]
        §S3, as CR-CRU-108 §S2 leaves it: the tracks the queue READ published
        (`declaredTracks` in src/store.ts), NOT a set the client derives.
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


import importlib.util
import json
import os
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

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr092_axi_under_test")


# ═══════════════════════════════════════════════════════════════════════════
# CR-CRU-098 C3 — this file's resolver tests moved with the resolver
# ═══════════════════════════════════════════════════════════════════════════
#
# The docstring above describes the CR-CRU-092 suite as it stood. CR-CRU-098
# moved the decision resolver to the server (src/next.ts, `GET …/next`) and
# deleted it from the client (AC10), so every test here that reached it was
# classified (docs/changes/CR-CRU-098-test-classification.md) and deleted, with
# the fixtures and the `cmd_next` harness only those tests used. A comment
# stands where each class stood, naming where it went. Two classes stay:
# `HarnessIsolationTest`, which never reached the resolver, unedited, and
# `TrackCanonicalisationAgreesWithTheServerTest`, restored below because the
# client's `canonical_track` mirror survives (§S4, corrected at C3).

# CanonicalTrackTest (3) — PORTED: tests/next-resolver.test.ts, "every spelling
# 091 accepts resolves the same lane" (the standalone `canonical_track` is gone,
# so its spellings are asserted on the resolver's own surface).

# TrackCanonicalisationAgreesWithTheServerTest (5) — KEPT (CR-CRU-098 §S4,
# corrected at C3): the client↔server track mirror survives, so its
# agreement test stands here.

def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    """Declare the scratch server's listener where the server READS it
    (CR-CRU-139 §S1a): the `crucible.toml` beside the database it is pointed
    at, which is exactly where `serverConfigPath()` looks --
    `dirname(store)/crucible.toml`.

    `$CRUCIBLE_PORT` is RETIRED, so a spawner that still exported it would boot
    SILENTLY on the shipped default 3849 -- the port a production install owns
    -- instead of on the free port this fixture allocated.
    """
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


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


def _refuse_write(*args, **kwargs):
    raise AssertionError(f"`next` is read-only and attempted a write: {args!r}")


def _next_through_the_client(base, key, track):
    """`(ok, code, fields)` from the REAL shared `cmd_next`, reading the
    scratch server's `GET …/next` over a real socket (CR-CRU-098 §S3) — the
    drive the deleted client `resolve_next` used to stand in for. The envelope
    is captured at the emitter seam, so nothing is printed."""
    emitted = []

    def _emit(verb, ok, fields, context, warnings, legacy_line=None):
        emitted.append((ok, fields))

    ops = AXI.ClientOps(
        get=lambda path: AXI.http_request(base, "GET", path, timeout=15),
        post=_refuse_write, patch=_refuse_write, emit=_emit,
        context=lambda project_dir, **kwargs: AXI.axi_context(key, **kwargs),
        agent_id=_refuse_write,
        project_key=lambda project_dir: key,
        plans_path=lambda project_dir: f"/api/v2/projects/{key}/plans",
        open_plans=lambda project_dir: [],
        resolve_plan=lambda *args, **kwargs: None,
        post_gate=_refuse_write, post_milestone=_refuse_write, base_url=base)
    code = AXI.cmd_next(
        Namespace(project_dir=None, track=track, release=None, wave=None,
                  fields=None), None, ops)
    assert len(emitted) == 1, f"`next` must emit ONE envelope: {emitted!r}"
    ok, fields = emitted[0]
    return ok, code, fields


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
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ,
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._boot()
        except BaseException:
            # A child spawned and then abandoned by a FAILING setUpClass is
            # never torn down (`tearDownClass` does not run when `setUpClass`
            # raises), and an orphaned server holds its port for as long as it
            # lives. Kill it on the way out, whatever went wrong.
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
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
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        """Stop the scratch server, from teardown OR from a setUpClass that
        failed after spawning it. Idempotent, so both callers may run."""
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

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


# TrackScopingTest (9) — PORTED: tests/next-resolver.test.ts, "multi-track
# refusal never picks a lane" and "every spelling 091 accepts ...".

# NextDecisionTest (7) — PORTED: tests/next-resolver.test.ts, "NEXT names the cr
# and its published seq, verbatim".

# HoldDecisionTest (18) — PORTED: tests/next-resolver.test.ts, "HOLD's four
# trigger kinds".

# DrainedDecisionTest (11) — PORTED: tests/next-resolver.test.ts, "DRAINED's
# three reasons".

# NextVerbEnvelopeTest (15) — KEPT (adapted to AC8/AC9):
# tests/client/test_cr098_next_verb_reads_the_route.py.

# LaneOrderTest (2) — PORTED: tests/next-resolver.test.ts, "resolveNext consumes
# the PUBLISHED order, never re-sorts by seq value".


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


# ResolverLandsOnceTest (2) — KEPT (rewritten for AC10/AC11):
# tests/client/test_cr098_resolver_lands_on_the_server.py.

# NextBlockCitationsTest (2) — RETIRED under CR-CRU-098 §S4: it checked the
# `path:line` citations inside the client's `next` block. That block is now the
# verb and its presentation only; the line citations into the client resolver
# it guarded are gone with the resolver.

# PublishedTrackFactTest (9) and PublishedTrackFactIsWiredTest (1) — RETIRED
# under CR-CRU-098 §S4: they held the client to READING the queue's published
# track fact and refusing a read that omitted it (`queue_tracks`,
# `QueueTrackFactUnpublished`). On the server the resolver reads the declared
# tracks directly, so an unpublished track fact cannot arise.


if __name__ == "__main__":
    unittest.main()
