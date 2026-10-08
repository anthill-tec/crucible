"""CR-CRU-172 §S0, AC1 — `gate-run` and `gate-respond` (which shares
`drive_axi_run`) post gates carrying `gate.run`, and `gate-run`'s interim
POST carries the run's `--release` as `version`, on EVERY client the fleet
wires: bun, python, mvn, rust, arduino.

Ground truth, measured directly: `clients/_crucible_axi.py`'s `gate_from_axi`
never writes a `run` key onto the gate object it returns (see the sibling
`test_a_gate_says_which_run_it_is.py`), and `stream_axi_ladder`'s interim
POST (`ops.post_gate(project_dir, agent_id, gate, context or None)`) never
passes `release` through at all — the seal already does
(`ops.post_gate(project_dir, agent_id, final_gate, context or None,
release)`), so only the interim half of the release stamp is broken. Every
one of the five clients dispatches BOTH verbs through this one shared
implementation (`cmd_gate_run`/`cmd_gate_respond` -> `_axi().cmd_gate_run`/
`_axi().cmd_gate_respond` -> `drive_axi_run`), so this file drives the REAL
argparse entry point of each client script in turn — never the shared
module directly — against a fake `no-mistakes` on PATH, recording every
`POST /api/v2/gates` body the drive produces.

RED phase: every `gate.run` assertion below fails on EVERY client today,
because `gate_from_axi` builds none; the interim `version` assertion fails
on every client too, because `stream_axi_ladder` passes no release through.

Invocation:
    python3 -m pytest tests/client/test_a_gate_posted_by_the_fleet_carries_its_run_and_release.py -q
Fallback:
    python3 tests/client/test_a_gate_posted_by_the_fleet_carries_its_run_and_release.py
"""

import contextlib
import copy
import importlib.util
import io
import itertools
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_cr054_fleet_inventory import CLIENT_FILES
from tests.client.test_client_fleet_envelope_census import install_project_limits

GATES_PATH = "/api/v2/gates"

# The env keys the fleet's own `context` block reads, cleared for every drive
# so an ambient orchestrator session can never colour a gate asserted on here
# (the sibling `test_a_run_in_flight_streams_its_ladder.py`'s own list).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# Longer than the FIRST poll (which fires immediately, before the cadence
# clock has ever ticked) but short enough that only that one poll lands
# before the proxied process resolves — the same one-cadence-window shape
# the sibling per-client harnesses (`test_python_crucible_axi.py`'s
# `PythonCrucibleLiveInFlightLadderTest`) already establish.
_RUN_SECONDS = "1.0"

_COUNTER = itertools.count()


def _load_module(path, cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()`."""
    stdout, stderr = io.StringIO(), io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", ["client.py"] + argv), mock.patch.dict(os.environ):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


# A fake `no-mistakes` answering `axi status` with whatever its LIVE file
# currently holds (the ladder as it looks while the run is still going), and
# `axi run`/`axi respond` with its FINAL file's content after one run cycle
# — generalising the sibling per-client "live ladder" fakes
# (`test_python_crucible_axi.py`'s `_FAKE_NO_MISTAKES_LIVE_LADDER_BODY`) to
# cover `axi respond` too, since `gate-respond` drives the SAME
# `stream_axi_ladder`/`drive_axi_run` body `gate-run` does.
_FAKE_NO_MISTAKES_BODY = '''
import os
import sys
import time

argv = sys.argv[1:]
live_path = os.environ.get("GATE_FLEET_FAKE_LIVE_FILE")
final_path = os.environ.get("GATE_FLEET_FAKE_FINAL_FILE")
run_seconds = float(os.environ.get("GATE_FLEET_FAKE_RUN_SECONDS", "1.0"))


def _read(path):
    if path and os.path.exists(path):
        with open(path) as f:
            return f.read()
    return ""


if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    sys.stdout.write(_read(live_path))
    sys.exit(0)
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "respond"):
    time.sleep(run_seconds)
    sys.stdout.write(_read(final_path))
    sys.exit(0)
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''


class _Drive:
    __slots__ = ("code", "out", "err", "posts")

    def __init__(self, code, out, err, posts):
        self.code, self.out, self.err, self.posts = code, out, err, posts


def _fixture(run_id, branch, head, step_name):
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


def _drive(client_key, client_path, argv_tail, live_snapshot, final_snapshot):
    """Drive one client's real `main()` against the fake tool above and
    return every `POST /api/v2/gates` body the drive produced."""
    cache_key = f"fleet_gate_identity_{client_key}_{next(_COUNTER)}"
    module = _load_module(client_path, cache_key)
    tmpdir = tempfile.mkdtemp(prefix="fleet-gate-identity-")
    fake_bin_dir = tempfile.mkdtemp(prefix="fleet-gate-identity-bin-")
    state_dir = tempfile.mkdtemp(prefix="fleet-gate-identity-state-")
    saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
    saved_path = os.environ.get("PATH", "")
    try:
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY=fleet-gate-identity-{client_key}-key\n")
            f.write(f"CRUCIBLE_PROJECT_NAME=fleet-gate-identity-{client_key}\n")
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
        os.environ["GATE_FLEET_FAKE_RUN_SECONDS"] = _RUN_SECONDS

        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True, "changed": True, "decision": "fleet-gate-identity-dec"}

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

    gates = [p for path, p in posted if path == GATES_PATH]
    return _Drive(code, out, err, gates)


def _interim_posts(posts):
    """The POSTs that are NOT the sealing one — the sibling streaming
    harness's own rule: a seal is the only gate carrying the commit it
    gated (`push`)."""
    return [p for p in posts if "push" not in p.get("gate", {})]


def _seal_posts(posts):
    return [p for p in posts if "push" in p.get("gate", {})]


def _expected_run(run_id, branch, head):
    return {"id": run_id, "branch": branch, "head": head}


class AGateRunDriveCarriesItsRunAndReleaseAcrossTheFleetTest(unittest.TestCase):
    """AC1 — `gate-run`'s interim and sealing gates both carry `gate.run`,
    and the interim one is stamped with `--release` as `version` too, in
    EVERY one of the five clients."""

    RELEASE = "9.9.9-fleet-gate-run"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.expected = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"fleet-gate-run-{key}-001"
            branch = f"feature/fleet-gate-run-{key}"
            head = "cafe0001"
            live, final = _fixture(run_id, branch, head, "review")
            cls.expected[key] = _expected_run(run_id, branch, head)
            cls.drives[key] = _drive(
                key, path,
                ["gate-run", "--intent", "stream the fleet ladder", "--agent",
                 "fleet-gate-identity-agent", "--release", cls.RELEASE],
                live, final)

    def test_the_fleet_this_cr_wires_is_exactly_five_clients(self):
        self.assertEqual(
            len(self.drives), 5,
            "AC1 names five clients -- bun, python, mvn, rust, arduino -- and "
            "the caller count is itself part of what this cycle pins; got "
            + repr(sorted(self.drives)))
        self.assertEqual(
            set(self.drives), {"bun", "python", "mvn", "rust", "arduino"},
            "got " + repr(sorted(self.drives)))

    def test_every_clients_interim_gate_carries_the_runs_identity_and_release(self):
        self.assertEqual(len(self.drives), 5, "premise: see the caller-count test")
        offenders = {}
        for key, drive in self.drives.items():
            interim = _interim_posts(drive.posts)
            if len(interim) != 1:
                offenders[key] = (f"expected exactly one interim gate POST, got "
                                  f"{len(interim)}: {drive.posts!r} (code={drive.code} "
                                  f"stderr={drive.err.strip()[:300]!r})")
                continue
            got_run = interim[0].get("gate", {}).get("run")
            if got_run != self.expected[key]:
                offenders[key] = (f"interim gate.run: got {got_run!r}, want "
                                  f"{self.expected[key]!r}")
                continue
            got_version = interim[0].get("version")
            if got_version != self.RELEASE:
                offenders[key] = (f"interim version: got {got_version!r}, want "
                                  f"{self.RELEASE!r} (post={interim[0]!r})")
        self.assertEqual(
            offenders, {},
            "every client's gate-run interim POST must carry `gate.run` "
            "(the snapshot's own run.id/branch/head) AND the run's "
            "`--release` as top-level `version`, exactly as the seal already "
            "does -- offenders: " + repr(offenders))

    def test_every_clients_seal_carries_the_runs_identity_and_release(self):
        self.assertEqual(len(self.drives), 5, "premise: see the caller-count test")
        offenders = {}
        for key, drive in self.drives.items():
            seal = _seal_posts(drive.posts)
            if len(seal) != 1:
                offenders[key] = (f"expected exactly one sealing gate POST, got "
                                  f"{len(seal)}: {drive.posts!r} (code={drive.code} "
                                  f"stderr={drive.err.strip()[:300]!r})")
                continue
            got_run = seal[0].get("gate", {}).get("run")
            if got_run != self.expected[key]:
                offenders[key] = (f"seal gate.run: got {got_run!r}, want "
                                  f"{self.expected[key]!r}")
                continue
            got_version = seal[0].get("version")
            if got_version != self.RELEASE:
                offenders[key] = (f"seal version: got {got_version!r}, want "
                                  f"{self.RELEASE!r} (post={seal[0]!r})")
        self.assertEqual(
            offenders, {},
            "every client's gate-run seal must ALSO carry `gate.run`, beside "
            "the top-level `version` it already carries -- offenders: "
            + repr(offenders))


class AnInterimGateWithNoReleaseGivenAcrossTheFleetTest(unittest.TestCase):
    """AC1 — the interim POST carries NO `version` when no `--release` was
    given, in EVERY client; proved alongside `gate.run` so the test cannot
    pass against today's gate.run-less stub by accident (the no-version
    behaviour alone is unchanged by this CR and would pass vacuously)."""

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.expected = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"fleet-gate-run-norelease-{key}-001"
            branch = f"feature/fleet-gate-run-norelease-{key}"
            head = "beef0002"
            live, final = _fixture(run_id, branch, head, "review")
            cls.expected[key] = _expected_run(run_id, branch, head)
            cls.drives[key] = _drive(
                key, path,
                ["gate-run", "--intent", "stream the fleet ladder without a release",
                 "--agent", "fleet-gate-identity-agent"],
                live, final)

    def test_every_clients_interim_gate_carries_its_identity_but_no_version(self):
        self.assertEqual(
            len(self.drives), 5,
            "premise: all five clients must have driven; got "
            + repr(sorted(self.drives)))
        offenders = {}
        for key, drive in self.drives.items():
            interim = _interim_posts(drive.posts)
            if len(interim) != 1:
                offenders[key] = (f"expected exactly one interim gate POST, got "
                                  f"{len(interim)}: {drive.posts!r} (code={drive.code} "
                                  f"stderr={drive.err.strip()[:300]!r})")
                continue
            got_run = interim[0].get("gate", {}).get("run")
            if got_run != self.expected[key]:
                offenders[key] = (f"interim gate.run: got {got_run!r}, want "
                                  f"{self.expected[key]!r}")
                continue
            if "version" in interim[0]:
                offenders[key] = (f"interim POST carries `version` ="
                                  f"{interim[0].get('version')!r} with NO --release "
                                  f"given -- post={interim[0]!r}")
        self.assertEqual(
            offenders, {},
            "with no --release given, every client's gate-run interim POST "
            "must still carry `gate.run` but carry NO top-level `version` "
            "key at all -- offenders: " + repr(offenders))


class AGateRespondDriveCarriesItsRunAcrossTheFleetTest(unittest.TestCase):
    """AC1 — `gate-respond` shares `drive_axi_run` with `gate-run`, so its
    interim and sealing gates must ALSO carry `gate.run`, in EVERY client.
    `gate-respond` declares no `--release` flag, so no version assertion
    applies to it."""

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.expected = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"fleet-gate-respond-{key}-001"
            branch = f"feature/fleet-gate-respond-{key}"
            head = "dec1de03"
            live, final = _fixture(run_id, branch, head, "fix")
            cls.expected[key] = _expected_run(run_id, branch, head)
            cls.drives[key] = _drive(
                key, path,
                ["gate-respond", "--action", "approve", "--agent",
                 "fleet-gate-identity-agent"],
                live, final)

    def test_every_clients_gate_respond_posts_carry_the_runs_identity(self):
        self.assertEqual(
            len(self.drives), 5,
            "premise: all five clients must have driven; got "
            + repr(sorted(self.drives)))
        offenders = {}
        for key, drive in self.drives.items():
            reasons = []
            interim = _interim_posts(drive.posts)
            seal = _seal_posts(drive.posts)
            if len(interim) != 1:
                reasons.append(f"expected one interim POST, got {len(interim)}")
            elif interim[0].get("gate", {}).get("run") != self.expected[key]:
                reasons.append("interim gate.run: got "
                               + repr(interim[0].get("gate", {}).get("run")))
            if len(seal) != 1:
                reasons.append(f"expected one sealing POST, got {len(seal)}")
            elif seal[0].get("gate", {}).get("run") != self.expected[key]:
                reasons.append("seal gate.run: got "
                               + repr(seal[0].get("gate", {}).get("run")))
            if reasons:
                offenders[key] = ("; ".join(reasons)
                                  + f" (posts={drive.posts!r} code={drive.code} "
                                  f"stderr={drive.err.strip()[:300]!r})")
        self.assertEqual(
            offenders, {},
            "gate-respond drives the SAME stream_axi_ladder/gate_from_axi "
            "gate-run uses, so its posted gates must carry `gate.run` too "
            "-- offenders: " + repr(offenders))


if __name__ == "__main__":
    unittest.main()
