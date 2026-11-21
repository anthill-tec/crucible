"""What the suite's offline wheel build needs, in one place.

The three modules that build the real `crucible-axi` wheel
(`test_crucible_axi_wheel_packaging`, `test_shipped_limits_ship_as_package_data`
and `test_cr046_uv_env_gate`) build it with

    [sys.executable, "-m", "build", "--wheel", "--no-isolation", ...]

so no isolated build environment downloads the backend: the suite's own
interpreter must import the frontend and the backend `pyproject.toml` names,
all from the `dev` extra. Each builder asks `build_modules_gap()` before it
builds, and fails with its answer rather than skipping.
"""

import importlib.util
import sys

# The frontend (`build`) and the backend `pyproject.toml` names (`hatchling`,
# `hatch_vcs`), all from the `dev` extra.
BUILD_MODULES = ("build", "hatchling", "hatch_vcs")


def build_modules_gap():
    """None when the suite's interpreter can import every `BUILD_MODULES`
    entry, else the failure naming the missing ones and the `dev` extra.
    An in-process probe: no interpreter is spawned."""
    missing = [name for name in BUILD_MODULES if importlib.util.find_spec(name) is None]
    if not missing:
        return None
    return (f"the suite's interpreter ({sys.executable}) cannot import "
            f"{', '.join(missing)}; the wheel is built offline with it "
            "(`--no-isolation`). Remedy: install the `dev` extra, "
            "`uv pip install --python .venv/bin/python -e '.[dev]'`.")
