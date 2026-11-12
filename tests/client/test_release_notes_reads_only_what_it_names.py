"""`release-notes` is read-only and reads only what it needs, proved through a
capturing proxy in front of a real, throwaway board.

The verb issues `GET`s only, and only these, in this order: the project's
history, then its closed plans, then its queue — the queue only when a
completed CR has no closed plan to take its title from. The queue and the
release proposals are read on the refusal path, once the label is missing
from the history, to tell a held label from an unknown one. It writes
nothing.

Calibration: the proxy is first shown to record a known read exactly — the
existing `history` verb, through the same proxy, makes exactly one `GET` of
the history and nothing else — so a request list the verb is held to is the
client's own, not the proxy's.
"""

import unittest

from tests.client import release_notes_board as rn

ALL_PLANNED = "1.1.0"
ONE_UNPLANNED = "1.2.0"
UNKNOWN = "9.0.0"
SHIPPED_AT = rn.utc_epoch(2026, 4, 2, 9, 0)

_BOARD = None
_PROJECTS = {}


def _seed(project, label, planned, unplanned):
    project.propose(label)
    for cr in (*planned, *unplanned):
        project.declare(cr, f"{cr} as queued", label)
    for cr in planned:
        project.land(cr, f"{cr} landed")
    project.ship(label, SHIPPED_AT, [*planned, *unplanned])
    if sorted(project.history_crs(label)) != sorted([*planned, *unplanned]):
        raise RuntimeError(f"fixture: {label} must complete every CR: "
                           f"{project.history_row(label)!r}")


def setUpModule():
    global _BOARD
    _BOARD = rn.start_board("release-notes-reads")
    if _BOARD is None:
        raise unittest.SkipTest(
            "the reads are made of a REAL store: without `bun` there is no "
            "board to read")
    try:
        planned = rn.SeededProject(_BOARD, "release-notes-all-planned")
        _seed(planned, ALL_PLANNED, ("READ-PLANNED-1", "READ-PLANNED-2"), ())
        _PROJECTS["all-planned"] = planned
        unplanned = rn.SeededProject(_BOARD, "release-notes-one-unplanned")
        _seed(unplanned, ONE_UNPLANNED, ("READ-PLANNED-3",),
              ("READ-QUEUED-ONLY",))
        _PROJECTS["one-unplanned"] = unplanned
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesReadsOnlyWhatItNamesTest(unittest.TestCase):

    def setUp(self):
        self.proxies = []

    def tearDown(self):
        rn.close_quietly(*self.proxies)

    def through_proxy(self, name):
        project = _PROJECTS[name]
        proxy = rn.CapturingProxy(project.base)
        self.proxies.append(proxy)
        return project, proxy, project.dir_through(proxy.base)

    def calibrate(self, project, proxy, project_dir):
        run = rn.run_client("python", project_dir, verb="history")
        self.assertEqual(run.returncode, 0, rn.describe(run))
        self.assertEqual(
            proxy.taken(), [("GET", f"/api/v2/projects/{project.key}/history")],
            "calibration: the proxy records the `history` verb's one read and "
            "nothing else")

    def reads(self, project, proxy):
        taken = proxy.taken()
        names = [rn.read_name(project.key, method, path)
                 for method, path in taken]
        self.assertNotIn(
            None, names,
            f"every request is a GET of a read the verb names — no write, no "
            f"other route; recorded {taken!r}")
        return names, taken

    def test_with_every_completed_cr_planned_it_reads_the_history_then_the_closed_plans(self):
        project, proxy, project_dir = self.through_proxy("all-planned")
        self.calibrate(project, proxy, project_dir)
        run = rn.run_client("python", project_dir, "--release", ALL_PLANNED,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0,
                         f"(today the verb does not exist)\n{rn.describe(run)}")
        names, taken = self.reads(project, proxy)
        self.assertEqual(
            names, ["history", "closed plans"],
            f"the history, then the closed plans; no queue (every completed "
            f"CR has a closed plan) and no release proposals; got {taken!r}")

    def test_a_completed_cr_without_a_closed_plan_adds_the_queue_read_last(self):
        project, proxy, project_dir = self.through_proxy("one-unplanned")
        self.calibrate(project, proxy, project_dir)
        run = rn.run_client("python", project_dir, "--release", ONE_UNPLANNED)
        self.assertEqual(run.returncode, 0,
                         f"(today the verb does not exist)\n{rn.describe(run)}")
        names, taken = self.reads(project, proxy)
        self.assertEqual(
            names, ["history", "closed plans", "queue"],
            f"the queue is read, after the closed plans, because one "
            f"completed CR has no closed plan; got {taken!r}")

    def test_only_a_refusal_reads_the_queue_and_the_release_proposals(self):
        project, proxy, project_dir = self.through_proxy("all-planned")
        self.calibrate(project, proxy, project_dir)
        run = rn.run_client("python", project_dir, "--release", UNKNOWN,
                            "--format", "json")
        self.assertEqual(run.returncode, 1,
                         f"an unknown label is refused with exit 1 (today "
                         f"the verb does not exist)\n{rn.describe(run)}")
        axi = rn.decode_json_envelope(run.stdout)
        self.assertIsInstance(axi, dict, rn.describe(run))
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        names, taken = self.reads(project, proxy)
        self.assertEqual(
            names, ["history", "queue", "release proposals"],
            f"the history first, then the queue and the release proposals "
            f"to tell a held label from an unknown one — and never the "
            f"closed plans; got {taken!r}")


if __name__ == "__main__":
    unittest.main()
