"""The helpers of `test_a_gate_is_running_only_while_its_run_is_driven_or_held.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import copy
import itertools
import os
import shutil
import stat
import sys
import tempfile
from unittest import mock

from tests.client.a_gate_posted_by_the_fleet_carries_its_run_and_release_helpers import (
    ENV_KEYS,
    _FAKE_NO_MISTAKES_BODY,
    _load_module,
    _run_main,
)
from tests.client.client_fleet_envelope_census_helpers import install_project_limits


GATES_PATH = "/api/v2/gates"

HEARTBEAT_PATH = "/api/v2/agents/heartbeat"

UNREGISTER_PATH = "/api/v2/agents/unregister"

GATE_DECISIONS_PATH = "/api/v2/gate-decisions"

_COUNTER = itertools.count()


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
               run_seconds, settings=None):
    """Drive one client's real `main()` against the fake `no-mistakes` above,
    recording EVERY `POST` the drive makes — gates, heartbeats, registers,
    unregisters alike — in wire order. Mirrors the sibling fleet harness's
    own `_drive`, generalised past the gates-only filter that file applies.

    `settings`, when given, maps client setting names to the values the
    drive sets on the loaded client's own settings instance
    (`module._axi().SETTINGS`) before it runs, restoring each after it."""
    cache_key = f"gate_identity_{client_key}_{next(_COUNTER)}"
    module = _load_module(client_path, cache_key)
    instance = module._axi().SETTINGS if settings else None
    saved_settings = {name: getattr(instance, name) for name in (settings or {})}
    for name, value in (settings or {}).items():
        setattr(instance, name, value)
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
        for name, value in saved_settings.items():
            setattr(instance, name, value)
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
