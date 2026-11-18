"""The helpers of `test_bun_regression_runs_the_marked_target.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import importlib.util
from tests.client.bun_targets_harness import BUN_CLIENT


def _load_bun_client():
    """The bun client loaded as a module, for its own `bun test` builder."""
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_regression_marked_target", BUN_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
