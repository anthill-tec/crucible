"""The helpers of `test_cr054_verb_surface_lift.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import importlib.util


def _load_module_by_path(path, cache_key):
    """Load a module by file path, mirroring the fleet's own `_axi()`/`_toon()`
    loader pattern -- the same convention every existing client/shared-module
    test in this directory uses."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
