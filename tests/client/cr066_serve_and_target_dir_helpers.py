"""The helpers of `test_cr066_serve_and_target_dir.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import contextlib
import importlib
import io
import sys
from pathlib import Path

from tests.client import install_clients_candidates


REPO_ROOT = Path(__file__).resolve().parents[2]


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    purging the whole `crucible_axi` package first so each test gets an
    independent import graph (and so `crucible_axi.cli` holds the same
    `crucible_axi.install` module object the `mock.patch` targets resolve to).
    Returns the imported modules in the order requested."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == "crucible_axi" or mod.startswith("crucible_axi."):
            del sys.modules[mod]
    modules = tuple(importlib.import_module(name) for name in module_names)
    # CR-CRU-260: the core `crucible_axi.cli` vendors takes the test install;
    # `tearDownModule` purges this generation, so the binding stays here.
    manifest = importlib.import_module("crucible_axi.manifest")
    manifest._CLIENTS_CANDIDATES = install_clients_candidates(manifest)
    return modules


def _run_cli(cli, argv):
    """Drive `cli.main(argv)` with stdout/stderr captured. Returns
    `(code, stdout, stderr)`; an argparse `SystemExit` is reported as its code
    (so a missing subcommand surfaces as an assertion about the CONTRACT, not
    as an opaque test error)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(argv)
        except SystemExit as exc:
            code = 0 if exc.code is None else exc.code
    return code, out.getvalue(), err.getvalue()


def tearDownModule():
    """Purge the `crucible_axi` generation bound to the test install, so no
    later module imports it."""
    for name in list(sys.modules):
        if name == "crucible_axi" or name.startswith("crucible_axi."):
            del sys.modules[name]
