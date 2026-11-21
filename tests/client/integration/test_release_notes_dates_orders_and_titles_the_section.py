"""How `release-notes` dates its heading and orders and titles its lines,
driven through `python-crucible.py` (the one shared code path) against a fake
board (`release_notes_board`'s seeder) — one project per scenario, so no scenario's CRs reach
another's release.

The heading date:

- a release that has not shipped — work in progress (some CRs completed, one
  pending) or a release whose every CR completed but whose ship was never
  recorded — is headed with today's UTC date (taken just before and just after
  the call; either is accepted), and only its completed CRs are listed;
- `--date YYYY-MM-DD` heads the section with that date, shipped or not;
- a release that shipped and completed no CR is its dated heading alone, and
  the verb still exits 0.

The lines (one shipped release):

- a CR landed by two closed plans of different titles is ONE line, placed at
  its latest close and titled by that plan;
- a CR the release completed with no closed plan at all (the shipped record
  names it) takes its queue title and follows every planned CR, even though
  the history row lists it first;
- a CR with neither a plan title nor a queue title is its id alone.
"""

import time
import unittest

from tests.client import release_notes_board as rn

IN_PROGRESS = "2.0.0"
UNRECORDED = "3.0.0"
SHIPPED_EMPTY = "4.0.0"
SHIPPED_EMPTY_AT = rn.utc_epoch(2026, 1, 31, 23, 45)
EDGES = "5.0.0"
PINNED_DATE = "2026-12-01"

#: The work-in-progress release: two landed (bravo before alpha), one pending.
WIP_ALPHA, WIP_BRAVO, WIP_PENDING = "WIP-ALPHA", "WIP-BRAVO", "WIP-PENDING"
WIP_LINES = ["- Bravo landed first (WIP-BRAVO)",
             "- Alpha landed second (WIP-ALPHA)"]
UNRECORDED_CR = "UNRECORDED-ONLY"
UNRECORDED_LINES = ["- Every change landed (UNRECORDED-ONLY)"]

#: The edge cases' release.
QUEUED_ONLY = "EDGE-QUEUED-ONLY"
PLANNED_ONCE = "EDGE-PLANNED-ONCE"
PLANNED_TWICE = "EDGE-PLANNED-TWICE"
UNTITLED = "EDGE-UNTITLED"
QUEUED_ONLY_TITLE = "Queued only, never planned"
TWICE_FIRST_TITLE = "Planned twice, first title"
TWICE_LATEST_TITLE = "Planned twice, latest title"

_BOARD = None
_PROJECTS = {}
_EDGES_SHIPPED_AT = None


def _seed_in_progress(project):
    project.propose(IN_PROGRESS)
    project.declare(WIP_ALPHA, "alpha as queued", IN_PROGRESS)
    project.declare(WIP_BRAVO, "bravo as queued", IN_PROGRESS)
    project.declare(WIP_PENDING, "pending as queued", IN_PROGRESS)
    project.land(WIP_BRAVO, "Bravo landed first")
    project.land(WIP_ALPHA, "Alpha landed second")
    rn.require_strictly_later(project, WIP_BRAVO, WIP_ALPHA)
    row = project.history_row(IN_PROGRESS) or {}
    if row.get("state") != "in progress" or row.get("pendingCount") != 1:
        raise RuntimeError(f"fixture: {IN_PROGRESS} must be in progress with "
                           f"one pending CR: {row!r}")


def _seed_unrecorded(project):
    project.propose(UNRECORDED)
    project.declare(UNRECORDED_CR, "as queued", UNRECORDED)
    project.land(UNRECORDED_CR, "Every change landed")
    row = project.history_row(UNRECORDED) or {}
    if row.get("state") != "ship not recorded":
        raise RuntimeError(f"fixture: {UNRECORDED} must read `ship not "
                           f"recorded`: {row!r}")


def _seed_shipped_empty(project):
    project.ship(SHIPPED_EMPTY, SHIPPED_EMPTY_AT)
    row = project.history_row(SHIPPED_EMPTY) or {}
    if row.get("state") != "shipped" or row.get("crCount") != 0:
        raise RuntimeError(f"fixture: {SHIPPED_EMPTY} must be shipped with no "
                           f"completed CR: {row!r}")


def _seed_edges(project):
    global _EDGES_SHIPPED_AT
    project.propose(EDGES)
    project.declare(QUEUED_ONLY, QUEUED_ONLY_TITLE, EDGES)
    project.declare(PLANNED_ONCE, "planned once, as queued", EDGES)
    project.declare(PLANNED_TWICE, "planned twice, as queued", EDGES)
    project.land(PLANNED_TWICE, TWICE_FIRST_TITLE)
    project.land(PLANNED_ONCE, "Planned once")
    # Never declared in the queue and filed without a title: the board places
    # it in the release that ships after it landed.
    project.land(UNTITLED)
    project.land(PLANNED_TWICE, TWICE_LATEST_TITLE)
    rn.require_strictly_later(project, PLANNED_ONCE, UNTITLED)
    rn.require_strictly_later(project, UNTITLED, PLANNED_TWICE)
    _EDGES_SHIPPED_AT = int(time.time()) + 2
    project.ship(EDGES, _EDGES_SHIPPED_AT,
                 [QUEUED_ONLY, PLANNED_ONCE, PLANNED_TWICE])
    listed = project.history_crs(EDGES)
    if sorted(listed) != sorted([QUEUED_ONLY, PLANNED_ONCE, PLANNED_TWICE,
                                 UNTITLED]) or listed[0] != QUEUED_ONLY:
        raise RuntimeError(f"fixture: the history row for {EDGES} must list "
                           f"all four CRs, the queued-only one first; got "
                           f"{listed!r}")


def setUpModule():
    global _BOARD
    _BOARD = rn.start_board("release-notes-dates-orders-titles")
    try:
        for name, seed in (("in-progress", _seed_in_progress),
                           ("unrecorded", _seed_unrecorded),
                           ("shipped-empty", _seed_shipped_empty),
                           ("edges", _seed_edges)):
            project = rn.SeededProject(_BOARD, f"release-notes-{name}")
            seed(project)
            _PROJECTS[name] = project
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


def _drive(name, *argv):
    return rn.run_client("python", _PROJECTS[name].project_dir, *argv)


class ReleaseNotesHeadingDateTest(unittest.TestCase):
    """The heading's date, and which CRs an unfinished release lists."""

    def assert_today_section(self, name, label, lines, argv=()):
        before = rn.today_utc()
        run = _drive(name, "--release", label, "--format", "markdown", *argv)
        after = rn.today_utc()
        self.assertEqual(run.returncode, 0,
                         f"`release-notes --release {label}` must exit 0 "
                         f"(today the verb does not exist):\n"
                         f"{rn.describe(run)}")
        accepted = {rn.expected_section(label, before, lines),
                    rn.expected_section(label, after, lines)}
        self.assertIn(run.stdout, accepted,
                      "an unshipped release is headed with today's UTC date "
                      "and lists only its completed CRs, in landing order")

    def test_an_unshipped_release_is_headed_today_and_lists_only_its_completed_crs(self):
        self.assert_today_section("in-progress", IN_PROGRESS, WIP_LINES)

    def test_a_release_whose_ship_was_never_recorded_is_headed_today(self):
        self.assert_today_section("unrecorded", UNRECORDED, UNRECORDED_LINES)

    def test_an_unshipped_releases_envelope_states_its_state_and_todays_date(self):
        before = rn.today_utc()
        run = _drive("in-progress", "--release", IN_PROGRESS, "--format", "json")
        after = rn.today_utc()
        self.assertEqual(run.returncode, 0, rn.describe(run))
        axi = rn.decode_json_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        assert axi is not None
        self.assertEqual(axi.get("state"), "in progress")
        self.assertIn(axi.get("date"), {before, after})
        self.assertEqual(axi.get("count"), 2,
                         "the pending CR is not counted")
        self.assertEqual(
            axi.get("lines"),
            rn.expected_section(IN_PROGRESS, axi.get("date"),
                                WIP_LINES).splitlines())

    def test_date_flag_heads_an_unshipped_release_with_that_date(self):
        run = _drive("in-progress", "--release", IN_PROGRESS,
                     "--date", PINNED_DATE, "--format", "markdown")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        self.assertEqual(
            run.stdout, rn.expected_section(IN_PROGRESS, PINNED_DATE, WIP_LINES))
        self.assertTrue(run.stdout.startswith(
            f"## [{IN_PROGRESS}] - {PINNED_DATE}\n"))

    def test_date_flag_wins_over_a_shipped_releases_ship_date(self):
        run = _drive("shipped-empty", "--release", SHIPPED_EMPTY,
                     "--date", PINNED_DATE, "--format", "markdown")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        self.assertEqual(run.stdout, f"## [{SHIPPED_EMPTY}] - {PINNED_DATE}\n")

    def test_a_shipped_release_with_no_completed_cr_is_its_dated_heading_alone(self):
        run = _drive("shipped-empty", "--release", SHIPPED_EMPTY,
                     "--format", "markdown")
        self.assertEqual(run.returncode, 0,
                         f"a shipped release with no completed CR is not a "
                         f"refusal:\n{rn.describe(run)}")
        self.assertEqual(run.stdout, "## [4.0.0] - 2026-01-31\n",
                         "the UTC ship date heads it, with no `### Changed` "
                         "group under it")

    def test_a_shipped_release_with_no_completed_cr_counts_zero_lines(self):
        run = _drive("shipped-empty", "--release", SHIPPED_EMPTY)
        self.assertEqual(run.returncode, 0, rn.describe(run))
        axi = rn.decode_toon_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        self.assertEqual(axi.get("state"), "shipped")
        self.assertEqual(axi.get("date"), "2026-01-31")
        self.assertEqual(axi.get("count"), 0)
        self.assertEqual(axi.get("lines"), ["## [4.0.0] - 2026-01-31"])


class ReleaseNotesLineEdgeCasesTest(unittest.TestCase):
    """Ordering and titling where a CR's plans are not one-to-one."""

    def expected(self):
        assert _EDGES_SHIPPED_AT is not None
        return rn.expected_section(EDGES, rn.utc_date(_EDGES_SHIPPED_AT), [
            f"- Planned once ({PLANNED_ONCE})",
            f"- {UNTITLED}",
            f"- {TWICE_LATEST_TITLE} ({PLANNED_TWICE})",
            f"- {QUEUED_ONLY_TITLE} ({QUEUED_ONLY})",
        ])

    def draft(self):
        run = _drive("edges", "--release", EDGES, "--format", "markdown")
        self.assertEqual(run.returncode, 0,
                         f"`release-notes --release {EDGES}` must exit 0 "
                         f"(today the verb does not exist):\n"
                         f"{rn.describe(run)}")
        return run.stdout

    def test_the_whole_section_orders_by_latest_close_then_unplanned(self):
        self.assertEqual(self.draft(), self.expected())

    def test_a_cr_closed_twice_is_one_line_with_its_latest_plans_title(self):
        stdout = self.draft()
        twice = [line for line in stdout.splitlines() if PLANNED_TWICE in line]
        self.assertEqual(twice, [f"- {TWICE_LATEST_TITLE} ({PLANNED_TWICE})"])
        self.assertNotIn(TWICE_FIRST_TITLE, stdout)

    def test_a_cr_with_no_closed_plan_takes_its_queue_title_and_comes_last(self):
        lines = [line for line in self.draft().splitlines()
                 if line.startswith("- ")]
        self.assertEqual(len(lines), 4, f"one line per completed CR: {lines!r}")
        self.assertEqual(lines[-1], f"- {QUEUED_ONLY_TITLE} ({QUEUED_ONLY})")

    def test_a_cr_with_neither_title_is_its_id_alone(self):
        lines = self.draft().splitlines()
        self.assertIn(f"- {UNTITLED}", lines)
        self.assertEqual(
            [line for line in lines if UNTITLED in line], [f"- {UNTITLED}"])


if __name__ == "__main__":
    unittest.main()
