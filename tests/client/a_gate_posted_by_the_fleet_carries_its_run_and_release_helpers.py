"""The helpers of `test_a_gate_posted_by_the_fleet_carries_its_run_and_release.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import contextlib
import importlib.util
import io
import os
import sys
from unittest import mock


# The env keys the fleet's own `context` block reads, cleared for every drive
# so an ambient orchestrator session can never colour a gate asserted on here
# (the sibling `test_a_run_in_flight_streams_its_ladder.py`'s own list).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


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
