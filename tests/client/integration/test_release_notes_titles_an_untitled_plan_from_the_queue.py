"""A landed CR whose latest closed plan carries no title takes its queue title,
in its landing place — even when every CR the release completed has a closed
plan, so nothing else would send `release-notes` to the queue.

Driven through `python-crucible.py` (the one shared code path) against a real,
throwaway board: three CRs declared in one shipped release, each landed by a
closed plan, the middle one's plan filed with no title (the board's plan route
takes `title` as optional, so this is a state the board really holds).

- The title: the section is the three lines in landing order, the middle one
  titled from the queue, the other two from their plans.
- The reads, through a capturing proxy: the history, then the closed plans,
  then the queue — read because a completed CR lacks a titled closed plan. A
  release whose every closed plan is titled reads no queue; that half is
  already pinned by
  `ReleaseNotesReadsOnlyWhatItNamesTest.test_with_every_completed_cr_planned_it_reads_the_history_then_the_closed_plans`
  (tests/client/integration/test_release_notes_reads_only_what_it_names.py).
"""

import unittest

from tests.client import release_notes_board as rn
from tests.client.real_board import RecordingProxy

LABEL = "6.0.0"
SHIPPED_AT = rn.utc_epoch(2026, 5, 14, 16, 30)
SHIPPED_DATE = "2026-05-14"

FIRST, MIDDLE, LAST = "NOTITLE-FIRST", "NOTITLE-MIDDLE", "NOTITLE-LAST"
FIRST_PLAN_TITLE = "First landed, titled by its plan"
MIDDLE_QUEUE_TITLE = "Middle landed, titled only in the queue"
LAST_PLAN_TITLE = "Last landed, titled by its plan"

EXPECTED_LINES = [
    f"- {FIRST_PLAN_TITLE} ({FIRST})",
    f"- {MIDDLE_QUEUE_TITLE} ({MIDDLE})",
    f"- {LAST_PLAN_TITLE} ({LAST})",
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
    project.declare(MIDDLE, MIDDLE_QUEUE_TITLE, LABEL)
    project.declare(LAST, "last, as queued", LABEL)
    project.land(FIRST, FIRST_PLAN_TITLE)
    project.land(MIDDLE)  # filed with no title
    project.land(LAST, LAST_PLAN_TITLE)
    rn.require_strictly_later(project, FIRST, MIDDLE)
    rn.require_strictly_later(project, MIDDLE, LAST)
    project.ship(LABEL, SHIPPED_AT, [FIRST, MIDDLE, LAST])

    plans = {plan.get("cr"): plan for plan in _closed_plans(project)}
    if set(plans) != {FIRST, MIDDLE, LAST}:
        raise RuntimeError(f"fixture: one closed plan per CR expected; got "
                           f"{sorted(plans)!r}")
    if plans[MIDDLE].get("title"):
        raise RuntimeError(f"fixture: {MIDDLE}'s closed plan must carry no "
                           f"title; the board holds {plans[MIDDLE]!r}")
    if plans[FIRST].get("title") != FIRST_PLAN_TITLE \
            or plans[LAST].get("title") != LAST_PLAN_TITLE:
        raise RuntimeError(f"fixture: the outer plans must keep their titles; "
                           f"the board holds {plans!r}")
    row = project.history_row(LABEL) or {}
    if row.get("state") != "shipped" \
            or sorted(project.history_crs(LABEL)) != sorted([FIRST, MIDDLE, LAST]):
        raise RuntimeError(f"fixture: {LABEL} must be shipped and complete "
                           f"all three CRs: {row!r}")


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-untitled-plan")
    if _BOARD is None:
        raise unittest.SkipTest(
            "the plans and the queue are a property of the REAL store: "
            "without `bun` there is no board to hold them")
    try:
        _PROJECT = rn.SeededProject(_BOARD, "release-notes-untitled-plan")
        _seed(_PROJECT)
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesUntitledPlanTakesItsQueueTitleTest(unittest.TestCase):
    """The line of a CR whose latest closed plan has no title."""

    def draft(self):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        return run.stdout

    def test_an_untitled_plans_cr_takes_its_queue_title_in_its_landing_place(self):
        self.assertEqual(
            self.draft(),
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES),
            "the middle CR's plan has no title, so its line carries its queue "
            "title, between the two CRs that landed either side of it; the "
            "other two keep their plans' titles")

    def test_an_untitled_plans_cr_is_never_its_bare_id(self):
        lines = self.draft().splitlines()
        self.assertNotIn(f"- {MIDDLE}", lines,
                         "a CR with a queue title is never its id alone")
        self.assertEqual([line for line in lines if MIDDLE in line],
                         [f"- {MIDDLE_QUEUE_TITLE} ({MIDDLE})"])

    def test_the_envelope_carries_the_queue_titled_line(self):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", "json")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        axi = rn.decode_json_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        self.assertEqual(axi.get("count"), 3)
        self.assertEqual(
            axi.get("lines"),
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES).splitlines())


class ReleaseNotesUntitledPlanReadsTheQueueTest(unittest.TestCase):
    """An untitled closed plan is a reason to read the queue."""

    def setUp(self):
        self.proxies = []

    def tearDown(self):
        rn.close_quietly(*self.proxies)

    def test_an_untitled_closed_plan_adds_the_queue_read_after_the_closed_plans(self):
        assert _PROJECT is not None
        proxy = RecordingProxy(_PROJECT.base, timeout=rn.PROXY_TIMEOUT)
        self.proxies.append(proxy)
        project_dir = _PROJECT.dir_through(proxy.base)
        calibration = rn.run_client("python", project_dir, verb="history")
        self.assertEqual(calibration.returncode, 0, rn.describe(calibration))
        self.assertEqual(
            proxy.taken(),
            [("GET", f"/api/v2/projects/{_PROJECT.key}/history")],
            "calibration: the proxy records the `history` verb's one read and "
            "nothing else")

        run = rn.run_client("python", project_dir, "--release", LABEL,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        taken = proxy.taken()
        names = [rn.read_name(_PROJECT.key, method, path)
                 for method, path in taken]
        self.assertNotIn(
            None, names,
            f"every request is a GET of a read the verb names — no write, no "
            f"other route; recorded {taken!r}")
        self.assertEqual(
            names, ["history", "closed plans", "queue"],
            f"the queue is read, after the closed plans, because a completed "
            f"CR's latest closed plan carries no title; got {taken!r}")
        self.assertEqual(
            run.stdout, rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES),
            "the run through the proxy drafts the same section")


if __name__ == "__main__":
    unittest.main()
