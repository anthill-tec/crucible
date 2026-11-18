"""The helpers of `test_cr046_uv_env_gate.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# The suite's own uv cache, kept between runs under the git-ignored
# `<repo>/.cache/test-suite/`: every `uv` child uses it, never the operator's.
SUITE_UV_CACHE = REPO_ROOT / ".cache" / "test-suite" / "uv"

def _uv_env():
    """The environment every `uv` child runs in: ours, with the suite's own
    uv cache."""
    env = dict(os.environ)
    env["UV_CACHE_DIR"] = str(SUITE_UV_CACHE)
    return env

def _sanitized_env():
    """Environment for a `uv run` invocation that must resolve PURELY from
    the script's own PEP 723 metadata: strip `PYTHONPATH` (would leak repo
    modules onto `sys.path`) and `VIRTUAL_ENV` (would make `uv run` reuse an
    ambient venv's site-packages instead of building its own isolated
    resolution) so the gate reflects a machine with only `crucible-axi` +
    uv installed, not this test process's own tooling. `uv` resolves into the
    suite's own cache."""
    env = _uv_env()
    env.pop("PYTHONPATH", None)
    env.pop("VIRTUAL_ENV", None)
    return env
