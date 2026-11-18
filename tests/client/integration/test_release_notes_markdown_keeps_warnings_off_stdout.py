"""Under `--format markdown`, `release-notes` keeps stdout for the section
alone: a warning the envelope would carry goes to stderr instead.

The warning is a real limit disclosure: the project's own `crucible.toml`
declares a `value` below its limit's shipped minimum, so every envelope the
project's clients emit carries a `limit-configuration` warning. Calibration
proves it — the existing `history` verb, run from the same project
directory, carries that warning in its envelope. A markdown draft then
prints exactly the section on stdout, and the warning's code on stderr.
"""

import unittest

from tests.client import release_notes_board as rn

LABEL = "1.3.0"
SHIPPED_AT = rn.utc_epoch(2026, 2, 10, 8, 15)
CR = "WARNED-CHANGE"
TITLE = "A change shipped under a refused limit"
EXPECTED_SECTION = rn.expected_section(LABEL, "2026-02-10",
                                       [f"- {TITLE} ({CR})"])
LIMIT_CODE = "limit-configuration"

_BOARD = None
_PROJECT_DIR = None


def setUpModule():
    global _BOARD, _PROJECT_DIR
    _BOARD = rn.start_board("release-notes-warnings")
    try:
        project = rn.SeededProject(_BOARD, "release-notes-warnings")
        project.propose(LABEL)
        project.declare(CR, "as queued", LABEL)
        project.land(CR, TITLE)
        project.ship(LABEL, SHIPPED_AT, [CR])
        rn.write_refused_limit(project.project_dir)
        _PROJECT_DIR = project.project_dir
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


def _codes(axi):
    return [w.get("code") for w in (axi or {}).get("warnings") or []
            if isinstance(w, dict)]


class ReleaseNotesMarkdownKeepsWarningsOffStdoutTest(unittest.TestCase):

    def project_dir(self):
        assert _PROJECT_DIR is not None
        return _PROJECT_DIR

    def test_calibration_the_project_really_owes_a_limit_disclosure(self):
        run = rn.run_client("python", self.project_dir(), verb="history")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        self.assertIn(LIMIT_CODE, _codes(rn.decode_toon_envelope(run.stdout)),
                      f"the fixture's refused limit is disclosed in an "
                      f"envelope:\n{rn.describe(run)}")

    def test_markdown_prints_the_section_alone_and_the_warning_on_stderr(self):
        run = rn.run_client("python", self.project_dir(), "--release", LABEL,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0,
                         f"(today the verb does not exist)\n{rn.describe(run)}")
        self.assertEqual(run.stdout, EXPECTED_SECTION,
                         "stdout is exactly the section, with no warning in it")
        self.assertIn(LIMIT_CODE, run.stderr,
                      f"the warning goes to stderr; got {run.stderr!r}")

    def test_the_toon_envelope_carries_the_same_warning(self):
        run = rn.run_client("python", self.project_dir(), "--release", LABEL)
        self.assertEqual(run.returncode, 0,
                         f"(today the verb does not exist)\n{rn.describe(run)}")
        axi = rn.decode_toon_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        self.assertEqual((axi or {}).get("verb"), "release-notes")
        self.assertIn(LIMIT_CODE, _codes(axi))


if __name__ == "__main__":
    unittest.main()
