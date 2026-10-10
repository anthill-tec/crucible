"""CR-CRU-176 §S1/AC1 — a gate is running only while the run that posts it is
alive: `gate-run` and `gate-respond` (`drive_axi_run`, shared by all five
clients) must post every snapshot — interim AND seal — under a RUN IDENTITY
of their own (the caller's id with a `·gate·<run>` suffix, `<run>` the
no-mistakes run id's first 8 characters), opened BEFORE the first snapshot, heartbeated on the poll loop's own cadence while the run is driven,
and removed on EVERY exit: a seal, a held (unsealed) run, a refusal, or an
interrupt. The caller's own registration is never touched.

Ground truth, measured directly against `clients/_crucible_axi.py` on this
branch: `drive_axi_run` posts every gate under the CALLER's bare `agent_id`
(`ops.post_gate(project_dir, agent_id, gate, ...)` — both inside
`stream_axi_ladder`'s interim loop and at the final seal) and never calls
`open_gate_identity`/`close_gate_identity`/`gated_run` at all — that bracket
exists (CR-CRU-056) but is wired ONLY into the test/regression/pre-merge-gate
verbs, never into `cmd_gate_run`/`cmd_gate_respond`. So every assertion below
that a posted gate's `agentId` carries the run identity, that identity is
opened before the first snapshot, heartbeated repeatedly, or removed on any
exit, fails against the CURRENT fleet — never on an import/fixture error.

Driven the same way the sibling fleet harness does
(`test_a_gate_posted_by_the_fleet_carries_its_run_and_release.py`): the REAL
argparse `main()` of each of the five clients, against a fake `no-mistakes`
on PATH answering `axi status`/`axi run`/`axi respond` from scripted TOON
snapshot files, with every `POST` the drive makes recorded (not just the
gates, as the sibling file does — this file needs every agent-lifecycle POST
too). The interrupt coverage drives a REAL subprocess against a real
`RecordingBoard` HTTP stand-in (`tests/client/live_run_harness.py`), the same
harness `test_a_client_aborts_a_run_it_cannot_file.py` uses for its own
SIGINT/SIGTERM coverage.

Invocation:
    python3 -m pytest tests/client/test_a_gate_is_running_only_while_its_run_is_driven_or_held.py -q
Fallback:
    python3 tests/client/test_a_gate_is_running_only_while_its_run_is_driven_or_held.py
"""

import copy
import itertools
import math
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    new_scratch,
    scrubbed_env,
)
from tests.client.test_a_gate_posted_by_the_fleet_carries_its_run_and_release import (
    _FAKE_NO_MISTAKES_BODY,
    ENV_KEYS,
    _load_module,
    _run_main,
)
from tests.client.test_client_fleet_envelope_census import install_project_limits
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

GATES_PATH = "/api/v2/gates"
HEARTBEAT_PATH = "/api/v2/agents/heartbeat"
UNREGISTER_PATH = "/api/v2/agents/unregister"
GATE_DECISIONS_PATH = "/api/v2/gate-decisions"

_COUNTER = itertools.count()

# A run identity is the caller's own id with this exact suffix and the run it
# drives: `<caller>·gate·<run>`, `<run>` being the first 8 characters of the
# no-mistakes run id (re-pin approved by the orchestrator — user ruling
# 2026-10-08: one identity per run). U+00B7 MIDDLE DOT, never a hyphen or a
# plain dot.
_GATE_SUFFIX = "\u00b7gate"


def _run_identity(caller, run_id):
    return f"{caller}{_GATE_SUFFIX}\u00b7{run_id[:8]}"


def _fixture(run_id, branch, head, step_name, *, held=False):
    """A two-step ladder: `intent` always completed, the second step either
    `running` (a normal in-flight tick) or `awaiting_approval` (a held
    decision). The FINAL snapshot carries a top-level `outcome` only when
    sealing; a held run's final snapshot resolves nothing at all — the exact
    shape `drive_axi_run` reads as "the run is still in flight"."""
    live = (
        'run:\n'
        f'  id: "{run_id}"\n'
        f'  branch: {branch}\n'
        '  status: running\n'
        f'  head: {head}\n'
        '  findings: 0\n'
        '  steps[2]{step,status,findings,duration_ms}:\n'
        '    intent,completed,0,10\n'
        f'    {step_name},running,0,500\n'
    )
    if held:
        final = (
            'run:\n'
            f'  id: "{run_id}"\n'
            f'  branch: {branch}\n'
            '  status: awaiting_approval\n'
            f'  head: {head}\n'
            '  findings: 0\n'
            '  steps[2]{step,status,findings,duration_ms}:\n'
            '    intent,completed,0,10\n'
            f'    {step_name},awaiting_approval,0,500\n'
        )
    else:
        final = (
            'run:\n'
            f'  id: "{run_id}"\n'
            f'  branch: {branch}\n'
            '  status: completed\n'
            f'  head: {head}\n'
            '  findings: 0\n'
            '  steps[2]{step,status,findings,duration_ms}:\n'
            '    intent,completed,0,10\n'
            f'    {step_name},completed,0,900\n'
            'outcome: passed\n'
        )
    return live, final


class _Drive:
    __slots__ = ("code", "out", "err", "posts")

    def __init__(self, code, out, err, posts):
        self.code, self.out, self.err, self.posts = code, out, err, posts


def _drive_all(client_key, client_path, argv_tail, live_snapshot, final_snapshot,
               run_seconds):
    """Drive one client's real `main()` against the fake `no-mistakes` above,
    recording EVERY `POST` the drive makes — gates, heartbeats, registers,
    unregisters alike — in wire order. Mirrors the sibling fleet harness's
    own `_drive`, generalised past the gates-only filter that file applies."""
    cache_key = f"gate_identity_{client_key}_{next(_COUNTER)}"
    module = _load_module(client_path, cache_key)
    tmpdir = tempfile.mkdtemp(prefix="gate-identity-")
    fake_bin_dir = tempfile.mkdtemp(prefix="gate-identity-bin-")
    state_dir = tempfile.mkdtemp(prefix="gate-identity-state-")
    saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
    saved_path = os.environ.get("PATH", "")
    try:
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY=gate-identity-{client_key}-key\n")
            f.write(f"CRUCIBLE_PROJECT_NAME=gate-identity-{client_key}\n")
        install_project_limits(tmpdir)
        for k in ENV_KEYS:
            os.environ.pop(k, None)

        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, os.stat(fake_path).st_mode
                 | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        live_file = os.path.join(state_dir, "live.toon")
        final_file = os.path.join(state_dir, "final.toon")
        with open(live_file, "w") as f:
            f.write(live_snapshot)
        with open(final_file, "w") as f:
            f.write(final_snapshot)

        os.environ["PATH"] = fake_bin_dir + os.pathsep + saved_path
        os.environ["GATE_FLEET_FAKE_LIVE_FILE"] = live_file
        os.environ["GATE_FLEET_FAKE_FINAL_FILE"] = final_file
        os.environ["GATE_FLEET_FAKE_RUN_SECONDS"] = str(run_seconds)

        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            if path == UNREGISTER_PATH:
                return {"ok": True, "changed": True}
            return {"ok": True, "changed": True, "decision": "gate-identity-dec"}

        with mock.patch.object(module, "_post", side_effect=fake_post, create=True):
            argv = argv_tail + ["--project-dir", tmpdir]
            code, out, err = _run_main(module, argv)
    finally:
        os.environ["PATH"] = saved_path
        for k in ("GATE_FLEET_FAKE_LIVE_FILE", "GATE_FLEET_FAKE_FINAL_FILE",
                  "GATE_FLEET_FAKE_RUN_SECONDS"):
            os.environ.pop(k, None)
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)
        shutil.rmtree(tmpdir, ignore_errors=True)

    return _Drive(code, out, err, posted)


def _gate_posts(posts):
    return [p for path, p in posts if path == GATES_PATH]


def _interim_gate_posts(posts):
    return [p for p in _gate_posts(posts) if "push" not in p.get("gate", {})]


def _seal_gate_posts(posts):
    return [p for p in _gate_posts(posts) if "push" in p.get("gate", {})]


def _heartbeats_for(posts, identity):
    return [p for path, p in posts
            if path == HEARTBEAT_PATH and isinstance(p, dict)
            and p.get("agentId") == identity]


def _removals_for(posts, identity):
    return [p for path, p in posts
            if path == UNREGISTER_PATH and isinstance(p, dict)
            and p.get("agentId") == identity]


def _any_post_for(posts, agent_id):
    """Every POST (any path) whose body names `agent_id` — used to prove the
    CALLER's own bare id is never touched by the run-identity bracket."""
    return [(path, p) for path, p in posts
            if isinstance(p, dict) and p.get("agentId") == agent_id]


def _wire_index(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


# The poll cadence `stream_axi_ladder` uses, read off the shared module
# itself rather than hard-coded here — the dispatch's own instruction (use
# the client's own cadence constants, not a wall-clock guess).
def _cadence(module):
    return module._axi()._GATE_POLL_CADENCE_S


# ═══════════════════════════════════════════════════════════════════════════
# A — gate-run: every posted snapshot carries the run identity, opened before
# the first one, heartbeated repeatedly while driving, removed once sealed.
# ═══════════════════════════════════════════════════════════════════════════

class AGateRunPostsEverySnapshotUnderItsOwnRunIdentityTest(unittest.TestCase):

    CALLER = "gate-identity-caller-run"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.run_ids = {}
        cls.cadence = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"gate-identity-run-{key}-001"
            cls.run_ids[key] = run_id
            branch = f"feature/gate-identity-{key}"
            head = "cafe1001"
            module = _load_module(path, f"gate_identity_cadence_probe_{key}_{next(_COUNTER)}")
            cadence = _cadence(module)
            cls.cadence[key] = cadence
            # Long enough to cross the cadence boundary at least once (so a
            # heartbeat tied to the poll loop fires more than at open), short
            # enough to keep the whole suite fast.
            run_seconds = cadence + 1.2
            live, final = _fixture(run_id, branch, head, "review")
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-run", "--intent", "drive the run identity", "--agent",
                 cls.CALLER],
                live, final, run_seconds)

    def test_the_fleet_this_cr_wires_is_exactly_five_clients(self):
        self.assertEqual(
            set(self.drives), {"bun", "python", "mvn", "rust", "arduino"},
            f"AC1 names five clients; got {sorted(self.drives)!r}")

    def test_every_clients_posted_gates_carry_the_run_identity_not_the_callers(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            interim = _interim_gate_posts(drive.posts)
            seal = _seal_gate_posts(drive.posts)
            if len(interim) != 1 or len(seal) != 1:
                offenders[key] = (f"expected one interim + one seal gate POST, "
                                  f"got interim={len(interim)} seal={len(seal)}; "
                                  f"posts={drive.posts!r}")
                continue
            bad = [p.get("agentId") for p in (interim[0], seal[0])
                   if p.get("agentId") != identity]
            if bad:
                offenders[key] = (f"expected every posted gate's agentId to be "
                                  f"{identity!r} (never the caller {self.CALLER!r}); "
                                  f"got interim.agentId={interim[0].get('agentId')!r} "
                                  f"seal.agentId={seal[0].get('agentId')!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_open_the_run_identity_before_the_first_gate_post(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            hb_idx = _wire_index(
                drive.posts,
                lambda p, b, ident=identity: p == HEARTBEAT_PATH
                and isinstance(b, dict) and b.get("agentId") == ident)
            gate_idx = _wire_index(drive.posts, lambda p, b: p == GATES_PATH)
            if hb_idx is None:
                offenders[key] = (f"no heartbeat ever opened the run identity "
                                  f"{identity!r}; posts={drive.posts!r}")
                continue
            if gate_idx is None:
                offenders[key] = f"no gate was ever posted; posts={drive.posts!r}"
                continue
            if not (hb_idx < gate_idx):
                offenders[key] = (f"the run identity must be opened BEFORE the "
                                  f"first gate snapshot; heartbeat at wire index "
                                  f"{hb_idx}, first gate at {gate_idx}")
                continue
            opener = drive.posts[hb_idx][1]
            if opener.get("status") != "online":
                offenders[key] = f"opening heartbeat status: got {opener.get('status')!r}"
            if opener.get("identity", {}).get("displayName") != identity:
                offenders[key] = (f"opening heartbeat identity.displayName: got "
                                  f"{opener.get('identity', {}).get('displayName')!r}, "
                                  f"want {identity!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_heartbeat_the_run_identity_repeatedly_while_driving(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            hbs = _heartbeats_for(drive.posts, identity)
            cadence = self.cadence[key]
            run_seconds = cadence + 1.2
            upper = math.ceil(run_seconds / cadence) + 2
            if not (2 <= len(hbs) <= upper):
                offenders[key] = (f"expected 2..{upper} heartbeats for the run "
                                  f"identity over a {run_seconds}s run at a "
                                  f"{cadence}s cadence (more than the ONE opening "
                                  f"touch, proving repetition, but bounded so a "
                                  f"runaway loop would fail too); got {len(hbs)}: "
                                  f"{hbs!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_remove_the_run_identity_exactly_once_after_the_seal(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            removals = _removals_for(drive.posts, identity)
            seal_idx = _wire_index(
                drive.posts, lambda p, b: p == GATES_PATH
                and isinstance(b, dict) and "push" in b.get("gate", {}))
            removal_idx = _wire_index(
                drive.posts, lambda p, b, ident=identity: p == UNREGISTER_PATH
                and isinstance(b, dict) and b.get("agentId") == ident)
            if len(removals) != 1:
                offenders[key] = (f"expected exactly one removal for the run "
                                  f"identity, got {len(removals)}: {removals!r}")
                continue
            if removals[0].get("silent") is not True:
                offenders[key] = f"removal must be silent=True; got {removals[0]!r}"
                continue
            if seal_idx is None or removal_idx is None or not (seal_idx < removal_idx):
                offenders[key] = (f"removal must come AFTER the seal; seal at "
                                  f"{seal_idx!r}, removal at {removal_idx!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_never_touch_the_callers_own_registration(self):
        offenders = {}
        for key, drive in self.drives.items():
            caller_posts = _any_post_for(drive.posts, self.CALLER)
            if caller_posts:
                offenders[key] = (f"no POST of any kind may name the caller's "
                                  f"bare id {self.CALLER!r} directly \u2014 only "
                                  f"the run identity may be opened/heartbeated/"
                                  f"removed; got {caller_posts!r}")
        self.assertEqual(offenders, {}, repr(offenders))


# ═══════════════════════════════════════════════════════════════════════════
# B — a held (unsealed) run still removes its run identity on exit.
# ═══════════════════════════════════════════════════════════════════════════

class AHeldGateRunStillRemovesItsRunIdentityTest(unittest.TestCase):

    CALLER = "gate-identity-caller-held"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.run_ids = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"gate-identity-held-{key}-001"
            cls.run_ids[key] = run_id
            branch = f"feature/gate-identity-held-{key}"
            head = "cafe1002"
            live, final = _fixture(run_id, branch, head, "review", held=True)
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-run", "--intent", "drive a held run", "--agent", cls.CALLER],
                live, final, "1.0")

    def test_every_clients_leave_the_run_unsealed(self):
        """Premise check: the fixture really produces a held exit (no seal,
        non-zero code) \u2014 otherwise the removal test below would prove nothing
        about the HELD path specifically."""
        offenders = {}
        for key, drive in self.drives.items():
            if drive.code == 0:
                offenders[key] = "expected a non-zero exit for a held run; got 0"
                continue
            if _seal_gate_posts(drive.posts):
                offenders[key] = (f"expected NO sealing gate POST for a held "
                                  f"run; got {_seal_gate_posts(drive.posts)!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_remove_the_run_identity_after_a_held_exit(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            removals = _removals_for(drive.posts, identity)
            if len(removals) != 1:
                offenders[key] = (f"a held (unsealed) run must still remove its "
                                  f"run identity exactly once; got "
                                  f"{len(removals)}: {removals!r}; "
                                  f"posts={drive.posts!r}")
        self.assertEqual(offenders, {}, repr(offenders))


# ═══════════════════════════════════════════════════════════════════════════
# C — a refused run (no parseable final snapshot) still removes its run
# identity on exit.
# ═══════════════════════════════════════════════════════════════════════════

class ARefusedGateRunStillRemovesItsRunIdentityTest(unittest.TestCase):

    CALLER = "gate-identity-caller-refused"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.run_ids = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"gate-identity-refused-{key}-001"
            cls.run_ids[key] = run_id
            branch = f"feature/gate-identity-refused-{key}"
            head = "cafe1003"
            live, _unused_final = _fixture(run_id, branch, head, "review")
            # An EMPTY final snapshot: no-mistakes answered with nothing
            # parseable, the refusal path `drive_axi_run` already reports.
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-run", "--intent", "drive a refused run", "--agent",
                 cls.CALLER],
                live, "", "1.0")

    def test_every_clients_report_the_refusal(self):
        offenders = {}
        for key, drive in self.drives.items():
            if drive.code == 0:
                offenders[key] = "expected a non-zero exit for a refused run"
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_remove_the_run_identity_after_a_refused_exit(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            removals = _removals_for(drive.posts, identity)
            if len(removals) != 1:
                offenders[key] = (f"a refused run must still remove its run "
                                  f"identity exactly once; got {len(removals)}: "
                                  f"{removals!r}; posts={drive.posts!r}")
        self.assertEqual(offenders, {}, repr(offenders))


# ═══════════════════════════════════════════════════════════════════════════
# D — gate-respond shares drive_axi_run, so it carries the SAME run identity
# contract: posted gates, open-before-first, removal on a sealed exit.
# ═══════════════════════════════════════════════════════════════════════════

class AGateRespondDrivesUnderTheRunIdentityTest(unittest.TestCase):

    CALLER = "gate-identity-caller-respond"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.run_ids = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"gate-identity-respond-{key}-001"
            cls.run_ids[key] = run_id
            branch = f"feature/gate-identity-respond-{key}"
            head = "cafe1004"
            live, final = _fixture(run_id, branch, head, "fix")
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-respond", "--action", "approve", "--agent", cls.CALLER],
                live, final, "1.0")

    def test_every_clients_posted_gates_carry_the_run_identity(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            interim = _interim_gate_posts(drive.posts)
            seal = _seal_gate_posts(drive.posts)
            if len(interim) != 1 or len(seal) != 1:
                offenders[key] = (f"expected one interim + one seal gate POST, "
                                  f"got interim={len(interim)} seal={len(seal)}; "
                                  f"posts={drive.posts!r}")
                continue
            bad = [p.get("agentId") for p in (interim[0], seal[0])
                   if p.get("agentId") != identity]
            if bad:
                offenders[key] = (f"gate-respond's posted gates must carry the "
                                  f"run identity too (it shares drive_axi_run "
                                  f"with gate-run); got "
                                  f"interim.agentId={interim[0].get('agentId')!r} "
                                  f"seal.agentId={seal[0].get('agentId')!r}, "
                                  f"want {identity!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_remove_the_run_identity_after_a_sealed_respond(self):
        offenders = {}
        for key, drive in self.drives.items():
            identity = _run_identity(self.CALLER, self.run_ids[key])
            removals = _removals_for(drive.posts, identity)
            if len(removals) != 1:
                offenders[key] = (f"expected exactly one removal for the run "
                                  f"identity after gate-respond sealed; got "
                                  f"{len(removals)}: {removals!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_never_touch_the_callers_own_registration(self):
        """Gate snapshots and lifecycle calls never name the caller's bare id.
        The ONE exception is the recorded decision: a decision is made by the
        CALLER, not by the run, so `/api/v2/gate-decisions` keeps
        `agentId = <caller>` (orchestrator ruling, CR-CRU-176 cycle 631)."""
        offenders = {}
        for key, drive in self.drives.items():
            caller_posts = [(path, p) for path, p in
                            _any_post_for(drive.posts, self.CALLER)
                            if path != GATE_DECISIONS_PATH]
            if caller_posts:
                offenders[key] = (f"no POST may name the caller's bare id "
                                  f"{self.CALLER!r} directly; got {caller_posts!r}")
                continue
            decisions = [p for path, p in drive.posts
                         if path == GATE_DECISIONS_PATH]
            if [p.get("agentId") for p in decisions] != [self.CALLER]:
                offenders[key] = (f"the recorded decision must stay the "
                                  f"caller's ({self.CALLER!r}); got "
                                  f"{decisions!r}")
        self.assertEqual(offenders, {}, repr(offenders))


# ═══════════════════════════════════════════════════════════════════════════
# E — SIGINT/SIGTERM mid-run still removes the run identity, driven as a REAL
# subprocess against a real RecordingBoard (the same harness the fleet's
# existing signal-exit coverage uses).
# ═══════════════════════════════════════════════════════════════════════════

AGENT = "gate-identity-signal-caller"
PROJECT_KEY = "gate-identity-signal-key"
PROJECT_NAME = "gate-identity-signal-firmware"
SIGNAL_RUN_ID = "gate-identity-signal-run-1"


def _wait_for_any_post(board, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if board.posts():
            return True
        time.sleep(0.05)
    return False


class AnInterruptedGateRunStillRemovesItsRunIdentityTest(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("gate-identity-signal-")
        self.bin_dir = new_scratch("gate-identity-signal-bin-")
        self.state_dir = new_scratch("gate-identity-signal-state-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

        fake_path = os.path.join(self.bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, os.stat(fake_path).st_mode
                 | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        self.live_file = os.path.join(self.state_dir, "live.toon")
        self.final_file = os.path.join(self.state_dir, "final.toon")
        live, final = _fixture(SIGNAL_RUN_ID,
                               "feature/gate-identity-signal", "cafe1005",
                               "review")
        with open(self.live_file, "w") as f:
            f.write(live)
        with open(self.final_file, "w") as f:
            f.write(final)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)
        shutil.rmtree(self.state_dir, ignore_errors=True)

    def _env(self):
        # A LONG fake-tool run (the client's own poll loop, not this test,
        # decides the real cadence) \u2014 long enough that a signal lands mid-run
        # every time, whatever this host's scheduling looks like.
        return scrubbed_env(
            self.bin_dir, GATE_FLEET_FAKE_LIVE_FILE=self.live_file,
            GATE_FLEET_FAKE_FINAL_FILE=self.final_file,
            GATE_FLEET_FAKE_RUN_SECONDS="25")

    def _signal_one_client(self, client_name, argv_tail, signum):
        identity = _run_identity(AGENT, SIGNAL_RUN_ID)
        cmd = [sys.executable, str(CLIENTS / client_name)] + argv_tail + [
            "--project-dir", self.project]
        proc = subprocess.Popen(cmd, cwd=self.project, env=self._env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            reached = _wait_for_any_post(self.board)
            self.assertTrue(
                reached,
                f"the run never reached the board at all (no POST within the "
                f"wait window) \u2014 stderr so far unavailable while still blocked "
                f"for {client_name}")
            proc.send_signal(signum)
            try:
                proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

        removals = _removals_for(self.board.posts(), identity)
        self.assertEqual(
            len(removals), 1,
            f"{client_name}: a {signal.Signals(signum).name}'d gate-run must "
            f"still remove its run identity ({identity!r}); got "
            f"{len(removals)} removal(s): {removals!r}; "
            f"all posts={self.board.posts()!r}")
        self.assertIs(removals[0].get("silent"), True,
                      f"{client_name}: removal must be silent=True; "
                      f"got {removals[0]!r}")

    def _each_client_each_signal(self, make_argv):
        for key, path in CLIENT_FILES.items():
            client_name = path.name
            for signum in (signal.SIGINT, signal.SIGTERM):
                with self.subTest(client=key, signal=signal.Signals(signum).name):
                    self.board.close()
                    self.board = RecordingBoard()
                    install_project(self.project, self.board.url, PROJECT_KEY,
                                    PROJECT_NAME)
                    self._signal_one_client(client_name, make_argv(), signum)

    def test_every_clients_gate_run_removes_its_run_identity_on_interrupt(self):
        self._each_client_each_signal(
            lambda: ["gate-run", "--intent", "interrupt the run identity",
                     "--agent", AGENT])

    def test_every_clients_gate_run_removes_its_run_identity_when_interrupted_while_opening_it(self):
        """CR-CRU-180 \u00a7S1 (diagnosis 3) \u2014 the window a slow runner widens:
        the board has RECORDED the run identity's opening heartbeat (so the
        identity exists on the board) but the client has not yet READ the
        answer when the signal lands. The interrupt must not orphan the
        identity the board already holds: the drive finishes opening it, then
        abandons and removes it. The board withholds that one answer until the
        signal has been sent, so the window is hit on every host."""
        identity = _run_identity(AGENT, SIGNAL_RUN_ID)
        argv_tail = ["gate-run", "--intent", "interrupt the opening",
                     "--agent", AGENT]
        for key, path in CLIENT_FILES.items():
            for signum in (signal.SIGINT, signal.SIGTERM):
                with self.subTest(client=key, signal=signal.Signals(signum).name):
                    self.board.close()
                    self.board = RecordingBoard()
                    install_project(self.project, self.board.url, PROJECT_KEY,
                                    PROJECT_NAME)
                    self.board.hold_next_reply(HEARTBEAT_PATH)
                    cmd = [sys.executable, str(CLIENTS / path.name)] + argv_tail + [
                        "--project-dir", self.project]
                    proc = subprocess.Popen(cmd, cwd=self.project, env=self._env(),
                                            stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, text=True)
                    try:
                        self.assertTrue(
                            _wait_for_any_post(self.board),
                            f"{key}: the run never reached the board at all")
                        first_path, first_body = self.board.posts()[0]
                        self.assertEqual(
                            (first_path, first_body.get("agentId")),
                            (HEARTBEAT_PATH, identity),
                            f"{key}: the first POST must be the run identity's "
                            f"opening heartbeat; got {self.board.posts()!r}")
                        proc.send_signal(signum)
                        self.board.release_held()
                        try:
                            _out, err = proc.communicate(timeout=20)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            _out, err = proc.communicate(timeout=10)
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait()
                    removals = _removals_for(self.board.posts(), identity)
                    self.assertEqual(
                        len(removals), 1,
                        f"{key}: a {signal.Signals(signum).name} landing while "
                        f"the run identity's opening heartbeat was in flight "
                        f"must still remove {identity!r}; got {len(removals)} "
                        f"removal(s); exit={proc.returncode}; stderr={err!r}; "
                        f"all posts={self.board.posts()!r}")
                    self.assertIs(removals[0].get("silent"), True,
                                  f"{key}: removal must be silent=True; "
                                  f"got {removals[0]!r}")
                    self.assertEqual(
                        proc.returncode, 128 + signum,
                        f"{key}: the interrupted drive exits on 128+signum; "
                        f"got {proc.returncode}; stderr={err!r}")


if __name__ == "__main__":
    unittest.main()
