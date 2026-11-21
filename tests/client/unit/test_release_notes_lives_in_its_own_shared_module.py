"""The `release-notes` verb lives in its own shared module, beside the core.

The core, `clients/_crucible_axi.py`, stands close to its line guard, so the
verb is written in a sibling module, `clients/_crucible_release.py`, which the
core loads by file path from its own directory (as it loads the run pipeline)
and whose names reach the clients through the core. Pinned here as files
only — the module's own names are its author's:

- the module exists beside the core and holds the verb;
- the core itself names no `release-notes` verb: it is not written there.

The load itself is pinned by the install suite (a copied core will not start
without its copied module) and the module's cleanliness by the run-pipeline
module's ruff and standard-library checks.
"""

import unittest

from tests.client import release_notes_board as rn


class ReleaseNotesLivesInItsOwnSharedModuleTest(unittest.TestCase):

    def test_the_release_notes_module_sits_beside_the_core_and_holds_the_verb(self):
        self.assertTrue(
            rn.RELEASE_MODULE.is_file(),
            f"the verb's module {rn.RELEASE_MODULE.name} sits beside "
            f"{rn.CORE_MODULE.name} in {rn.CLIENTS_DIR}")
        self.assertIn("release-notes",
                      rn.RELEASE_MODULE.read_text(encoding="utf-8"),
                      "the module holds the `release-notes` verb")

    def test_the_core_does_not_write_the_release_notes_verb(self):
        self.assertNotIn(
            "release-notes", rn.CORE_MODULE.read_text(encoding="utf-8"),
            f"{rn.CORE_MODULE.name} names no `release-notes` verb: the verb "
            f"is written in {rn.RELEASE_MODULE.name}, not in the core")


if __name__ == "__main__":
    unittest.main()
