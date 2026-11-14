"""The changelog-section reader answers the section being written: the
changelog's topmost `## [...]` section, whatever its label.

  * On `develop` the topmost section is `## [Unreleased]`; on a release
    branch and on `master` it is the release's own `## [X.Y.Z] - YYYY-MM-DD`.
    The reader answers that topmost section, never one below it.
  * The section runs to the next `## [` heading, or to the link block at the
    file's foot (`[0.4.0]: https://…`), whichever comes first.
  * A `### Added` sub-heading belongs to the section it sits in.
  * A changelog with no `## [` heading has no section: the reader answers an
    empty string, so a doc test reading through it fails on its own
    assertion.

Proved on small changelogs written here, never on the repo's CHANGELOG.md.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_changelog_section_reader_reads_the_topmost_section
"""

import unittest

from tests.client.changelog_section import changelog_section

PREAMBLE = (
    "# Changelog\n"
    "\n"
    "All notable changes to this project are documented in this file.\n"
    "\n"
)

DEVELOP = PREAMBLE + (
    "## [Unreleased]\n"
    "\n"
    "- the unreleased entry names `alpha`\n"
    "\n"
    "## [0.3.0] - 2026-10-10\n"
    "\n"
    "- the released entry names `omega`\n"
)

RELEASE_BRANCH = PREAMBLE + (
    "## [0.4.0] - 2026-11-14\n"
    "\n"
    "- the release's entry names `alpha`\n"
    "\n"
    "## [0.3.0] - 2026-10-10\n"
    "\n"
    "- the older release's entry names `omega`\n"
)

LAST_SECTION_THEN_LINKS = PREAMBLE + (
    "## [0.4.0] - 2026-11-14\n"
    "\n"
    "- the only release's entry names `alpha`\n"
    "\n"
    "[0.4.0]: https://example.invalid/compare/v0.3.0...v0.4.0\n"
    "[0.3.0]: https://example.invalid/releases/tag/v0.3.0\n"
)

WITH_SUB_HEADINGS = PREAMBLE + (
    "## [Unreleased]\n"
    "\n"
    "### Added\n"
    "\n"
    "- an added entry names `alpha`\n"
    "\n"
    "### Fixed\n"
    "\n"
    "- a fixed entry names `beta`\n"
    "\n"
    "## [0.3.0] - 2026-10-10\n"
    "\n"
    "### Added\n"
    "\n"
    "- an older added entry names `omega`\n"
)


class TheTopmostSectionIsTheOneBeingWrittenTest(unittest.TestCase):

    def test_an_unreleased_topmost_section_answers_its_body_and_nothing_of_the_release_below(self):
        section = changelog_section(DEVELOP)
        self.assertIn("- the unreleased entry names `alpha`", section)
        self.assertNotIn("omega", section)
        self.assertNotIn("## [0.3.0]", section)
        self.assertNotIn("All notable changes", section)

    def test_a_dated_release_topmost_with_no_unreleased_answers_that_release_body(self):
        section = changelog_section(RELEASE_BRANCH)
        self.assertIn("- the release's entry names `alpha`", section)
        self.assertNotIn("omega", section)
        self.assertNotIn("## [0.3.0]", section)
        self.assertNotIn("All notable changes", section)

    def test_an_empty_unreleased_topmost_section_never_falls_through_to_the_release_below(self):
        text = PREAMBLE + (
            "## [Unreleased]\n"
            "\n"
            "## [0.3.0] - 2026-10-10\n"
            "\n"
            "- the released entry names `omega`\n"
        )
        section = changelog_section(text)
        self.assertNotIn("omega", section)
        self.assertNotIn("## [0.3.0]", section)


class TheSectionEndsWhereItShouldTest(unittest.TestCase):

    def test_the_last_section_stops_before_the_link_block_at_the_foot(self):
        section = changelog_section(LAST_SECTION_THEN_LINKS)
        self.assertIn("- the only release's entry names `alpha`", section)
        self.assertNotIn("[0.4.0]: https://", section)
        self.assertNotIn("[0.3.0]: https://", section)
        self.assertNotIn("example.invalid", section)

    def test_an_unreleased_section_alone_stops_before_the_link_block_at_the_foot(self):
        text = PREAMBLE + (
            "## [Unreleased]\n"
            "\n"
            "- the unreleased entry names `alpha`\n"
            "\n"
            "[Unreleased]: https://example.invalid/compare/v0.3.0...HEAD\n"
        )
        section = changelog_section(text)
        self.assertIn("- the unreleased entry names `alpha`", section)
        self.assertNotIn("example.invalid", section)

    def test_a_link_definition_inside_the_section_does_not_end_it(self):
        # Only the link block after the last heading ends a section; a link
        # line an entry cites stays in the section it sits in.
        text = PREAMBLE + (
            "## [Unreleased]\n"
            "\n"
            "- the unreleased entry cites [the guide][guide]\n"
            "\n"
            "[guide]: https://guide.invalid/unreleased\n"
            "\n"
            "- after the link, an entry names `alpha`\n"
            "\n"
            "## [0.3.0] - 2026-10-10\n"
            "\n"
            "- the released entry names `omega`\n"
            "\n"
            "[Unreleased]: https://example.invalid/compare/v0.3.0...HEAD\n"
        )
        section = changelog_section(text)
        self.assertIn("[guide]: https://guide.invalid/unreleased", section)
        self.assertIn("- after the link, an entry names `alpha`", section)
        self.assertNotIn("omega", section)
        self.assertNotIn("example.invalid", section)

    def test_a_sub_heading_stays_inside_the_section(self):
        section = changelog_section(WITH_SUB_HEADINGS)
        self.assertIn("### Added", section)
        self.assertIn("- an added entry names `alpha`", section)
        self.assertIn("### Fixed", section)
        self.assertIn("- a fixed entry names `beta`", section)
        self.assertNotIn("omega", section)
        self.assertEqual(section.count("### Added"), 1,
                         "only the topmost section's own `### Added`")


class NoSectionAnswersEmptyTest(unittest.TestCase):

    def test_a_changelog_with_no_release_heading_answers_an_empty_string(self):
        self.assertEqual(changelog_section(PREAMBLE + "### Added\n\n- `alpha`\n"), "")

    def test_an_empty_changelog_answers_an_empty_string(self):
        self.assertEqual(changelog_section(""), "")


if __name__ == "__main__":
    unittest.main()
