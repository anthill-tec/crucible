"""An `integration/sim` entry's gates: every one needs the simulator, so every
one is skipped. No entry of the committed `crucible.toml` declares this
directory; a test that needs it declares it in its own copy."""

import pytest


def test_the_transient_run_settles_the_rail():
    pytest.skip("simulator not installed")


def test_the_ac_sweep_keeps_the_filter_corner():
    pytest.skip("simulator not installed")
