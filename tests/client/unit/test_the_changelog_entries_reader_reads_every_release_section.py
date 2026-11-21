"""The changelog-entries reader answers every release section's body, so a
check that a feature IS recorded finds it wherever its release sits.

  * The bodies of `[Unreleased]` and of every dated `## [X.Y.Z] - YYYY-MM-DD`
    section are all answered, each with its sub-headings.
  * The `## [` heading lines are not, and neither is the preamble above the
    first heading.
  * The link block at the file's foot, after the last heading, is not part of
    any section.
  * A link-definition line inside a section is that section's own line, and
    what follows it in the section is answered too.
  * A changelog with no `## [` heading answers an empty string, so a doc test
    reading through it fails on its own assertion.

Proved on small changelogs written here, never on the repo's CHANGELOG.md.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_changelog_entries_reader_reads_every_release_section
"""

import unittest

from tests.client.changelog_section import changelog_entries

PREAMBLE = (
    "# Changelog\n"
    "\n"
    "All notable changes to this project are documented in this file.\n"
    "\n"
)

LINK_BLOCK = (
    "[Unreleased]: https://example.invalid/compare/v0.4.0...HEAD\n"
    "[0.4.0]: https://example.invalid/compare/v0.3.0...v0.4.0\n"
    "[0.3.0]: https://example.invalid/releases/tag/v0.3.0\n"
)

UNRELEASED_ABOVE_TWO_RELEASES = PREAMBLE + (
    "## [Unreleased]\n"
    "\n"
    "### Added\n"
    "\n"
    "- the unreleased entry names `alpha`\n"
    "\n"
    "## [0.4.0] - 2026-11-14\n"
    "\n"
    "### Added\n"
    "\n"
    "- the newer release's entry names `beta`\n"
    "\n"
    "## [0.3.0] - 2026-10-10\n"
    "\n"
    "### Fixed\n"
    "\n"
    "- the older release's entry names `omega`\n"
    "\n"
) + LINK_BLOCK


class EveryReleaseSectionIsAnsweredTest(unittest.TestCase):

    def test_the_unreleased_body_and_both_dated_bodies_below_it_are_all_answered(self):
        entries = changelog_entries(UNRELEASED_ABOVE_TWO_RELEASES)
        self.assertIn("- the unreleased entry names `alpha`", entries)
        self.assertIn("- the newer release's entry names `beta`", entries)
        self.assertIn("- the older release's entry names `omega`", entries)

    def test_each_sections_sub_headings_are_kept(self):
        entries = changelog_entries(UNRELEASED_ABOVE_TWO_RELEASES)
        self.assertEqual(entries.count("### Added"), 2,
                         "the `### Added` of `[Unreleased]` and of `[0.4.0]`")
        self.assertEqual(entries.count("### Fixed"), 1, "the `### Fixed` of `[0.3.0]`")

    def test_the_heading_lines_and_the_preamble_are_not_answered(self):
        entries = changelog_entries(UNRELEASED_ABOVE_TWO_RELEASES)
        self.assertNotIn("## [", entries)
        self.assertNotIn("2026-11-14", entries)
        self.assertNotIn("2026-10-10", entries)
        self.assertNotIn("# Changelog", entries)
        self.assertNotIn("All notable changes", entries)


class TheLinkBlockAtTheFootIsNotASectionsTest(unittest.TestCase):

    def test_the_link_block_after_the_last_heading_is_left_out(self):
        entries = changelog_entries(UNRELEASED_ABOVE_TWO_RELEASES)
        self.assertIn("- the older release's entry names `omega`", entries)
        self.assertNotIn("example.invalid", entries)
        self.assertNotIn("[0.3.0]: ", entries)
        self.assertNotIn("[Unreleased]: ", entries)

    def test_a_link_definition_inside_a_section_stays_in_that_section(self):
        text = PREAMBLE + (
            "## [Unreleased]\n"
            "\n"
            "- the unreleased entry cites [the guide][guide]\n"
            "\n"
            "[guide]: https://guide.invalid/unreleased\n"
            "\n"
            "- after the unreleased link, an entry names `alpha`\n"
            "\n"
            "## [0.3.0] - 2026-10-10\n"
            "\n"
            "- the release cites [its notes][notes]\n"
            "\n"
            "[notes]: https://notes.invalid/0.3.0\n"
            "\n"
            "- after the release's link, an entry names `omega`\n"
            "\n"
        ) + LINK_BLOCK
        entries = changelog_entries(text)
        self.assertIn("[guide]: https://guide.invalid/unreleased", entries)
        self.assertIn("- after the unreleased link, an entry names `alpha`", entries)
        self.assertIn("[notes]: https://notes.invalid/0.3.0", entries,
                      "a link line inside the last section is not the link block at the foot")
        self.assertIn("- after the release's link, an entry names `omega`", entries)
        self.assertNotIn("example.invalid", entries)


class NoSectionAnswersEmptyTest(unittest.TestCase):

    def test_a_changelog_with_no_release_heading_answers_an_empty_string(self):
        self.assertEqual(changelog_entries(PREAMBLE + "### Added\n\n- `alpha`\n"), "")

    def test_an_empty_changelog_answers_an_empty_string(self):
        self.assertEqual(changelog_entries(""), "")


if __name__ == "__main__":
    unittest.main()
