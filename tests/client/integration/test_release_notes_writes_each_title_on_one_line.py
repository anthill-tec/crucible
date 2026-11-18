"""A title is written on one line: each run of whitespace in it — a newline, a
tab, a run of spaces — is one space, so a title can never break the section
(a newline followed by `## [...]` would otherwise open a second heading inside
the draft).

Driven through `python-crucible.py` (the one shared code path) against a real,
throwaway board: three CRs landed in one shipped release, the middle one's
landing plan titled with an embedded newline, a tab and a run of spaces (the
board's plan route takes any string as a title, and the fixture checks it
holds this one verbatim).
"""

import unittest

from tests.client import release_notes_board as rn

LABEL = "8.0.0"
SHIPPED_AT = rn.utc_epoch(2026, 7, 21, 8, 45)
SHIPPED_DATE = "2026-07-21"

FIRST, WRAPPED, LAST = "ONELINE-FIRST", "ONELINE-WRAPPED", "ONELINE-LAST"
FIRST_TITLE = "First landed"
WRAPPED_TITLE = "Wrapped   title\twith a tab\n## [9.9.9] - 2020-01-01"
WRAPPED_WRITTEN = "Wrapped title with a tab ## [9.9.9] - 2020-01-01"
LAST_TITLE = "Last landed"

EXPECTED_LINES = [
    f"- {FIRST_TITLE} ({FIRST})",
    f"- {WRAPPED_WRITTEN} ({WRAPPED})",
    f"- {LAST_TITLE} ({LAST})",
]

_BOARD = None
_PROJECT = None


def _closed_plans(project):
    answer = rn.board_http(project.base,
                           f"/api/v2/projects/{project.key}/plans?status=closed")
    if not isinstance(answer, dict) or not answer.get("ok"):
        raise RuntimeError(f"fixture: reading the closed plans failed: {answer!r}")
    return answer.get("plans") or []


def _seed(project):
    project.propose(LABEL)
    project.declare(FIRST, "first, as queued", LABEL)
    project.declare(WRAPPED, "wrapped, as queued", LABEL)
    project.declare(LAST, "last, as queued", LABEL)
    project.land(FIRST, FIRST_TITLE)
    project.land(WRAPPED, WRAPPED_TITLE)
    project.land(LAST, LAST_TITLE)
    rn.require_strictly_later(project, FIRST, WRAPPED)
    rn.require_strictly_later(project, WRAPPED, LAST)
    project.ship(LABEL, SHIPPED_AT, [FIRST, WRAPPED, LAST])

    plans = {plan.get("cr"): plan for plan in _closed_plans(project)}
    if plans.get(WRAPPED, {}).get("title") != WRAPPED_TITLE:
        raise RuntimeError(f"fixture: {WRAPPED}'s plan must hold its title "
                           f"verbatim; the board holds {plans.get(WRAPPED)!r}")
    row = project.history_row(LABEL) or {}
    if row.get("state") != "shipped" \
            or sorted(project.history_crs(LABEL)) != sorted([FIRST, WRAPPED, LAST]):
        raise RuntimeError(f"fixture: {LABEL} must be shipped and complete "
                           f"all three CRs: {row!r}")


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-one-line-title")
    if _BOARD is None:
        raise unittest.SkipTest(
            "a plan's title is a property of the REAL store: without `bun` "
            "there is no board to hold it")
    try:
        _PROJECT = rn.SeededProject(_BOARD, "release-notes-one-line-title")
        _seed(_PROJECT)
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesWritesEachTitleOnOneLineTest(unittest.TestCase):
    """A title's whitespace runs are each one space."""

    def run_draft(self, fmt):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", fmt)
        self.assertEqual(run.returncode, 0, rn.describe(run))
        return run

    def test_a_title_with_a_newline_tab_and_spaces_is_one_line_in_the_section(self):
        self.assertEqual(
            self.run_draft("markdown").stdout,
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES),
            "the wrapped title's newline, tab and run of spaces are each one "
            "space: the section keeps one heading and three lines")

    def test_a_title_with_a_newline_opens_no_second_heading(self):
        lines = self.run_draft("markdown").stdout.splitlines()
        self.assertEqual([line for line in lines if line.startswith("## ")],
                         [f"## [{LABEL}] - {SHIPPED_DATE}"],
                         "exactly one heading: the title's own text stays on "
                         "its CR's line")
        self.assertEqual([line for line in lines if WRAPPED in line],
                         [f"- {WRAPPED_WRITTEN} ({WRAPPED})"])

    def test_the_envelope_carries_the_one_line_title(self):
        axi = rn.decode_json_envelope(self.run_draft("json").stdout)
        self.assertIsInstance(axi, dict)
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        self.assertEqual(axi.get("count"), 3)
        self.assertEqual(
            axi.get("lines"),
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES).splitlines())


if __name__ == "__main__":
    unittest.main()
