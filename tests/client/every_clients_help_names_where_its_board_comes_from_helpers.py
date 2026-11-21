"""The helpers of `test_every_clients_help_names_where_its_board_comes_from.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import re
import shutil
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _make_project_dir,
    drive_verb,
)


_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}


def normalise(text):
    """Whitespace-insensitive form of a help text: every run of whitespace is
    one space, and a hyphen argparse broke a line on is re-joined. Applied to
    BOTH sides of every containment check, so a text re-wrapped by argparse
    still matches the text it was wrapped from."""
    collapsed = re.sub(r"\s+", " ", text or "")
    return re.sub(r"-\s+", "-", collapsed).strip()


_HELP_CACHE = None


def _top_level_helps():
    """Each client's real top-level `--help`, driven once per test run."""
    global _HELP_CACHE
    if _HELP_CACHE is not None:
        return _HELP_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    helps = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                helps[client_key] = drive_verb(
                    script_path, ["--help"], project_dir, fake_bin_dir,
                    extra_env=_HELP_ENV)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _HELP_CACHE = helps
    return helps
