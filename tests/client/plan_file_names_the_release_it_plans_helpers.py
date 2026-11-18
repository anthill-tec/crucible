"""The plain helpers of `test_plan_file_names_the_release_it_plans.py`, lifted
out of that test module so a suite importing them does not import a test
module (CR-CRU-261).

Holds no `TestCase` and no test: the fleet's client scripts, the env keys a
drive clears, a by-path module loader and the in-process `main()` driver.
"""

import contextlib
import importlib.util
import io
import os
import sys
from unittest import mock

from tests.client import TEST_INSTALL_CLIENTS

CLIENTS_DIR = TEST_INSTALL_CLIENTS

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# The env keys the fleet's `context` block reads. Cleared in every drive so an
# ambient orchestrator session can never colour an envelope asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom. A missing file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()` with `sys.argv`
    patched → (exit code, stdout, stderr). Only SystemExit is caught, so an
    argparse refusal arrives as a normal non-zero exit while any OTHER
    exception still surfaces as an ERROR rather than being swallowed."""
    stdout, stderr = io.StringIO(), io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", ["client.py"] + list(argv)), mock.patch.dict(os.environ):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()
