"""A copied client is laid out as an install.

The core derives its install dir from its OWN location: the parent of the
directory it sits in (`_INSTALL_DIR`, clients/_crucible_axi.py). A copy laid
out flat in a scratch directory therefore takes that directory's PARENT as its
install, and reads whatever `crucible.toml` sits there -- under the system
temp dir, a file no test owns and any other process may plant. A copy under
`<install>/clients/` takes `<install>` instead, which the test owns.

The danger itself is pinned here, in process, against a parent this test
plants.

Every test here is unit: files written and modules loaded in process. No
process is spawned, no socket is opened, nothing waits on real time.
"""

import importlib.util
import itertools
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.client import CLIENT_SOURCE_DIR

CLIENTS_DIR = CLIENT_SOURCE_DIR
CONFIG_NAME = "crucible.toml"
CLIENTS_DIRNAME = "clients"

#: The board a planted parent declares. Never contacted: every check here
#: resolves the address and stops.
PLANTED_BOARD = "http://127.0.0.1:1"
PLANTED_CONFIG = f'[client]\nurl = "{PLANTED_BOARD}"\n'

_COUNTER = itertools.count()


def _core_fleet():
    """The files the core loads by path from its own directory, plus the
    package data it reads beside itself: every `_crucible_*.py`, the TOON
    codec and the shipped `crucible.toml`."""
    return (sorted(CLIENTS_DIR.glob("_crucible_*.py"))
            + [CLIENTS_DIR / "toon.py", CLIENTS_DIR / CONFIG_NAME])


def _copy_core_into(directory):
    """Copy the core's fleet into `directory`; answer the copied core."""
    directory.mkdir(parents=True, exist_ok=True)
    for source in _core_fleet():
        shutil.copyfile(source, directory / source.name)
    return directory / "_crucible_axi.py"


def _load_core(path):
    """Load the core at `path` in process, under a name of its own, so no
    other test's copy is reused and nothing lands in `sys.modules`."""
    spec = importlib.util.spec_from_file_location(
        f"copied_client_core_{next(_COUNTER)}", str(path))
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _real(path):
    return os.path.realpath(str(path))


def _planted_parent(test):
    """A parent directory `test` owns, holding a `crucible.toml` that declares
    `PLANTED_BOARD`; removed when the test ends."""
    parent = Path(tempfile.mkdtemp(prefix="copied-client-parent-"))
    test.addCleanup(shutil.rmtree, parent, ignore_errors=True)
    (parent / CONFIG_NAME).write_text(PLANTED_CONFIG, encoding="utf-8")
    return parent


# ── the danger, pinned ──────────────────────────────────────────────────────


class ACopiedCoreTakesTheDirectoryAboveItsOwnAsItsInstallTest(unittest.TestCase):
    """Where a copy is laid out decides which `crucible.toml` it reads."""

    def setUp(self):
        self.parent = _planted_parent(self)

    def test_a_flat_copy_takes_the_parent_it_was_copied_into_and_reads_the_board_planted_there(self):
        core = _load_core(_copy_core_into(self.parent / "flat"))

        self.assertEqual(
            _real(self.parent), _real(core._INSTALL_DIR),
            "a core copied flat into <parent>/flat/ takes <parent> as its install")
        self.assertEqual(
            [_real(self.parent / CONFIG_NAME)],
            [_real(path) for path in core._project_config_candidates()],
            "with no project bound, the planted parent's file is the whole chain")
        self.assertEqual(
            PLANTED_BOARD, core.resolve_base_url(),
            "the flat copy reads the board a file it does not own declares")

    def test_a_copy_under_an_install_clients_directory_takes_that_install_and_never_reads_the_planted_parent(self):
        install = self.parent / "install"
        core = _load_core(_copy_core_into(install / CLIENTS_DIRNAME))

        self.assertEqual(
            _real(install), _real(core._INSTALL_DIR),
            "a core under <install>/clients/ takes <install> as its install")
        chain = [_real(path) for path in core._project_config_candidates()]
        self.assertEqual([_real(install / CONFIG_NAME)], chain)
        self.assertNotIn(_real(self.parent / CONFIG_NAME), chain)

        with self.assertRaises(core.BoardUndeclared) as refused:
            core.resolve_base_url()
        self.assertEqual(
            [(_real(install / CONFIG_NAME), core._BOARD.BOARD_FILE_ABSENT)],
            [(_real(path), reason) for path, reason in refused.exception.chain],
            "the refusal names the install's own absent file and nothing above it")
        self.assertNotIn(PLANTED_BOARD, refused.exception.detail)
        self.assertNotIn(str(self.parent / CONFIG_NAME), refused.exception.detail)


if __name__ == "__main__":
    unittest.main()
