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
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (  # noqa: E402
    declare_and_require_board,
)

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
    # CR-CRU-139 §S2 — the board is DECLARED in the project file the help
    # drives run against, never exported. A `--help` never reaches the wire;
    # one that somehow did refuses instantly instead of touching a live board.
    declare_and_require_board(_PROJECT_DIR, _UNREACHABLE_CRUCIBLE_URL,
                              "a help drive")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_next_help(client):
    """A genuine subprocess dispatch of the real client script's own
    `next --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = os.environ.copy()
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


# CR-CRU-098 C3 — the thirteen in-process `cmd_next` tests that stood here were
# deleted (docs/changes/CR-CRU-098-test-classification.md). The resolver they
# drove moved to the server, so the eleven PORTED ones live in
# tests/next-resolver.test.ts ("wave/release lane details" group):
#   WavePredicateIgnoresTrackTest, LaneFlagsNarrowTheAnswerTest (2),
#   LaneFlagsAreNotCoercedTest (2), DuplicateSeqWithinAWaveTest,
#   DrainedLaneIsNotACompleteWaveTest (2), EnvelopeNamesTheResolvedContainerTest
#   (4), WavelessEntryNeverResolvesTheWaveTest;
# and the two KEPT ones — LegacyLineStatesTheWaveTest and
# BothNewDimensionsRideTheOneReadTest — in
# tests/client/test_cr098_next_verb_reads_the_route.py.


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


if __name__ == "__main__":
    unittest.main()
