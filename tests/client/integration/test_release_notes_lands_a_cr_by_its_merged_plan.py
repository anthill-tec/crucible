"""A CR lands by its latest closed plan that recorded a merge commit. A plan
closed without a merge is not a landing: it moves neither the CR's line nor
its title, and a CR whose only closed plan has no merge has no landing at all.

Driven through `python-crucible.py` (the one shared code path) against a real,
throwaway board, seeded through the board's own routes. The board's plan
route takes `merge` as optional, so a plan closed without one is a state the
board really holds; the fixture checks that it does, and that every CR here is
one the shipped release's history row counts completed.

The closes, in this order, each strictly after the one before:

1. ALPHA lands (merged), titled by its plan.
2. REPLANNED lands (merged) as "first title".
3. UNLANDED's only plan is closed WITHOUT a merge — titled, so a draft that
   took any closed plan would neither read the queue nor place it last.
4. BRAVO lands (merged), titled by its plan.
5. REPLANNED's later plan is closed WITHOUT a merge as "unmerged title".

The release names all four. The draft lists ALPHA, REPLANNED (its first,
merged title, in its merged place), BRAVO, then UNLANDED — plan-less, so it
takes its queue title and follows the landed ones.
"""

import unittest

from tests.client import release_notes_board as rn

LABEL = "7.0.0"
SHIPPED_AT = rn.utc_epoch(2026, 6, 9, 11, 15)
SHIPPED_DATE = "2026-06-09"

ALPHA, REPLANNED, UNLANDED, BRAVO = (
    "MERGED-ALPHA", "MERGED-REPLANNED", "MERGED-NONE", "MERGED-BRAVO")

ALPHA_TITLE = "Alpha landed, titled by its plan"
REPLANNED_FIRST_TITLE = "Replanned, first title"
REPLANNED_UNMERGED_TITLE = "Replanned, unmerged title"
UNLANDED_PLAN_TITLE = "Closed without a merge, titled by its plan"
UNLANDED_QUEUE_TITLE = "Never merged, titled in the queue"
BRAVO_TITLE = "Bravo landed, titled by its plan"

EXPECTED_LINES = [
    f"- {ALPHA_TITLE} ({ALPHA})",
    f"- {REPLANNED_FIRST_TITLE} ({REPLANNED})",
    f"- {BRAVO_TITLE} ({BRAVO})",
    f"- {UNLANDED_QUEUE_TITLE} ({UNLANDED})",
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
    project.declare(ALPHA, "alpha, as queued", LABEL)
    project.declare(REPLANNED, "replanned, as queued", LABEL)
    project.declare(UNLANDED, UNLANDED_QUEUE_TITLE, LABEL)
    project.declare(BRAVO, "bravo, as queued", LABEL)

    closes = [
        (project.land(ALPHA, ALPHA_TITLE), True),
        (project.land(REPLANNED, REPLANNED_FIRST_TITLE), True),
        (project.land(UNLANDED, UNLANDED_PLAN_TITLE, merged=False), False),
        (project.land(BRAVO, BRAVO_TITLE), True),
        (project.land(REPLANNED, REPLANNED_UNMERGED_TITLE, merged=False), False),
    ]
    project.ship(LABEL, SHIPPED_AT, [ALPHA, REPLANNED, UNLANDED, BRAVO])

    plans = {plan.get("planId"): plan for plan in _closed_plans(project)}
    if set(plans) != {plan_id for plan_id, _ in closes}:
        raise RuntimeError(f"fixture: five closed plans expected; the board "
                           f"holds {sorted(plans)!r}")
    previous = None
    for plan_id, merged in closes:
        plan = plans[plan_id]
        if bool(plan.get("merge")) != merged:
            raise RuntimeError(f"fixture: plan {plan_id} must be closed "
                               f"{'with' if merged else 'without'} a merge; "
                               f"the board holds {plan!r}")
        closed_at = plan.get("closedAt")
        if not isinstance(closed_at, int) or (previous is not None
                                              and closed_at <= previous):
            raise RuntimeError(f"fixture: each close must be strictly after "
                               f"the one before; the board holds {plans!r}")
        previous = closed_at

    row = project.history_row(LABEL) or {}
    if row.get("state") != "shipped" or sorted(project.history_crs(LABEL)) \
            != sorted([ALPHA, REPLANNED, UNLANDED, BRAVO]):
        raise RuntimeError(f"fixture: {LABEL} must be shipped and count all "
                           f"four CRs completed: {row!r}")


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-merged-landing")
    if _BOARD is None:
        raise unittest.SkipTest(
            "a plan's merge and close are a property of the REAL store: "
            "without `bun` there is no board to hold them")
    try:
        _PROJECT = rn.SeededProject(_BOARD, "release-notes-merged-landing")
        _seed(_PROJECT)
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesLandsACrByItsMergedPlanTest(unittest.TestCase):
    """The line and the place of a CR follow its latest merged plan."""

    def draft(self):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        return run.stdout

    def test_a_later_unmerged_close_moves_neither_the_line_nor_its_title(self):
        self.assertEqual(
            self.draft(),
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES),
            "the replanned CR keeps its merged plan's title in its merged "
            "place (between the two CRs that landed either side of it); its "
            "later plan, closed without a merge, is not a landing; the CR "
            "whose only closed plan has no merge has no landing, so it takes "
            "its queue title and follows the landed ones")

    def test_the_replanned_cr_is_one_line_with_its_merged_title(self):
        lines = self.draft().splitlines()
        self.assertEqual([line for line in lines if REPLANNED in line],
                         [f"- {REPLANNED_FIRST_TITLE} ({REPLANNED})"])
        self.assertNotIn(REPLANNED_UNMERGED_TITLE, "\n".join(lines),
                         "a plan closed without a merge lends no title")

    def test_a_cr_with_only_an_unmerged_close_takes_its_queue_title_last(self):
        lines = self.draft().splitlines()
        self.assertEqual(lines[-1], f"- {UNLANDED_QUEUE_TITLE} ({UNLANDED})",
                         "no landing plan: its queue title, after every "
                         "landed CR")
        self.assertNotIn(UNLANDED_PLAN_TITLE, "\n".join(lines),
                         "a plan closed without a merge lends no title")

    def test_the_envelope_carries_the_same_lines(self):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", "json")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        axi = rn.decode_json_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        self.assertEqual(axi.get("count"), 4)
        self.assertEqual(
            axi.get("lines"),
            rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES).splitlines())


class ReleaseNotesReadsTheQueueForAnUnmergedCloseTest(unittest.TestCase):
    """A completed CR with no landing plan is a reason to read the queue,
    even when every completed CR has a titled closed plan."""

    def setUp(self):
        self.proxies = []

    def tearDown(self):
        rn.close_quietly(*self.proxies)

    def test_a_cr_without_a_merged_plan_adds_the_queue_read_after_the_closed_plans(self):
        assert _PROJECT is not None
        proxy = rn.CapturingProxy(_PROJECT.base)
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
            f"CR's only closed plan recorded no merge; got {taken!r}")
        self.assertEqual(
            run.stdout, rn.expected_section(LABEL, SHIPPED_DATE, EXPECTED_LINES),
            "the run through the proxy drafts the same section")


if __name__ == "__main__":
    unittest.main()
