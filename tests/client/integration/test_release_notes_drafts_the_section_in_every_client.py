"""`release-notes --release <label>` drafts a release's CHANGELOG section from
the board, in each of the six clients.

One real, throwaway board holds a SHIPPED release with three completed CRs,
declared in one order (alpha, bravo, charlie — the order the history row lists
them) and landed in another (charlie, alpha, bravo). The release ships at
23:30 UTC, so a heading dated in any timezone east of UTC would show the next
day. Each client is run as a genuine subprocess, as the operator runs it:

- `--format markdown` prints exactly the section, ending in one newline: the
  label and the UTC ship date in the heading, `### Changed`, then one line per
  CR — its latest closed plan's title and its id — in landing order;
- the default TOON envelope and the `--format json` object carry
  `verb: release-notes`, the release, its state, the heading date, the line
  count, the same section as `lines` and a non-empty `help`.

Each plan's title differs from the CR's queue title, so a draft that took the
queue's title where the board holds a closed plan's is caught.
"""

import unittest

from tests.client import release_notes_board as rn

LABEL = "1.4.0"
SHIPPED_AT = rn.utc_epoch(2026, 3, 14, 23, 30)
SHIP_DATE = "2026-03-14"

ALPHA, BRAVO, CHARLIE = "NOTE-ALPHA", "NOTE-BRAVO", "NOTE-CHARLIE"
DECLARED = ((ALPHA, "alpha as it was queued"),
            (BRAVO, "bravo as it was queued"),
            (CHARLIE, "charlie as it was queued"))
#: Landing order, and each CR's closed plan's title.
LANDED = ((CHARLIE, "Charlie lands first"),
          (ALPHA, "Alpha lands second"),
          (BRAVO, "Bravo lands third"))

EXPECTED_LINES = [f"- {title} ({cr})" for cr, title in LANDED]
EXPECTED_SECTION = rn.expected_section(LABEL, SHIP_DATE, EXPECTED_LINES)
ENVELOPE_KEYS = ("verb", "release", "state", "date", "count", "lines", "help")

_BOARD = None
_PROJECT = None


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-every-client")
    if _BOARD is None:
        raise unittest.SkipTest(
            "the shipped release is a property of the REAL store: without "
            "`bun` there is no board to hold it")
    try:
        project = rn.SeededProject(_BOARD, "release-notes-every-client")
        project.propose(LABEL)
        for cr, queued_title in DECLARED:
            project.declare(cr, queued_title, LABEL)
        for cr, plan_title in LANDED:
            project.land(cr, plan_title)
        project.ship(LABEL, SHIPPED_AT, [cr for cr, _ in DECLARED])
        rn.require_strictly_later(project, CHARLIE, ALPHA)
        rn.require_strictly_later(project, ALPHA, BRAVO)
        row = project.history_row(LABEL) or {}
        if row.get("state") != "shipped" or row.get("shippedAt") != SHIPPED_AT:
            raise RuntimeError(f"fixture: {LABEL} is not shipped at "
                               f"{SHIPPED_AT}: {row!r}")
        if project.history_crs(LABEL) != [ALPHA, BRAVO, CHARLIE]:
            raise RuntimeError(
                f"fixture: the history row must list the CRs in their "
                f"declared order, which differs from their landing order; "
                f"got {project.history_crs(LABEL)!r}")
        _PROJECT = project
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class _Contract:
    """Holds the contract out of the loader's reach: only the six
    module-level subclasses below, each naming its client, are collected."""

    class ReleaseNotesDraft(unittest.TestCase):
        """The draft, for one client."""

        CLIENT = ""

        def drive(self, *argv):
            assert _PROJECT is not None
            return rn.run_client(self.CLIENT, _PROJECT.project_dir,
                                 "--release", LABEL, *argv)

        def assert_envelope(self, axi, run):
            self.assertIsInstance(
                axi, dict,
                f"{self.CLIENT}: `release-notes` must answer with an envelope "
                f"on stdout (today the verb does not exist):\n"
                f"{rn.describe(run)}")
            for key in ENVELOPE_KEYS:
                self.assertIn(key, axi, f"{self.CLIENT}: the envelope carries "
                                        f"`{key}`; got {axi!r}")
            self.assertEqual(axi["verb"], "release-notes")
            self.assertIs(axi.get("ok"), True, f"got {axi!r}")
            self.assertEqual(axi["release"], LABEL)
            self.assertEqual(axi["state"], "shipped")
            self.assertEqual(axi["date"], SHIP_DATE,
                             "the heading date is the UTC date of the ship")
            self.assertEqual(axi["count"], 3)
            self.assertEqual(axi["lines"], EXPECTED_SECTION.splitlines(),
                             "`lines` is the section, one string per line")
            self.assertIsInstance(axi["help"], list)
            self.assertTrue(axi["help"], "help is non-empty")

        def test_markdown_prints_exactly_the_section_in_landing_order(self):
            run = self.drive("--format", "markdown")
            self.assertEqual(
                run.returncode, 0,
                f"{self.CLIENT}: `release-notes --format markdown` must exit 0 "
                f"(today the verb does not exist):\n{rn.describe(run)}")
            self.assertEqual(
                run.stdout, EXPECTED_SECTION,
                f"{self.CLIENT}: stdout is exactly the section — the UTC ship "
                f"date, `### Changed`, and the closed plans' titles in landing "
                f"order (charlie, alpha, bravo), never the declared order")
            lines = rn.stderr_lines(run)
            self.assertTrue(
                lines and lines[0].startswith("release-notes:"),
                f"{self.CLIENT}: the human line goes to stderr; got "
                f"{run.stderr!r}")

        def test_default_toon_envelope_carries_the_same_section_as_lines(self):
            run = self.drive()
            self.assertEqual(run.returncode, 0, rn.describe(run))
            self.assert_envelope(rn.decode_toon_envelope(run.stdout), run)

        def test_json_object_carries_the_same_section_as_lines(self):
            run = self.drive("--format", "json")
            self.assertEqual(run.returncode, 0, rn.describe(run))
            self.assert_envelope(rn.decode_json_envelope(run.stdout), run)


class BunReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "bun"


class PythonReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "python"


class RustReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "rust"


class MvnReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "mvn"


class ArduinoReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "arduino"


class GoReleaseNotesDraftTest(_Contract.ReleaseNotesDraft):
    CLIENT = "go"


if __name__ == "__main__":
    unittest.main()
