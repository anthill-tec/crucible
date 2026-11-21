"""§S9/AC15: the `landings` verb, run as a real client subprocess, returns
exactly the closed plans the server's `GET …/plans?status=closed` returns,
with their merge commits.

Follows the `status` verb's own end-to-end idiom
(`test_status_verb_shows_open_plans_end_to_end.py`): a fake board
(`RecordingBoard`) answers the closed-plans read in the server's own shape,
the verb is driven as a genuine `python-crucible.py` subprocess, its TOON
stdout decoded with `clients/toon.py`'s own decoder.

The answer is what the real board gives for a project holding one plan
closed WITH a merge commit, one closed WITHOUT one, one ABORTED and one OPEN:
the two closed plans only, the merged one carrying `merge.commit` and the
commit-less one no `merge` key at all. That server half is held in bun by
`plans-status-filter.test.ts` ("?status=closed returns EXACTLY the two
closed plans …") and `closed-plans-read-carries-merge-and-title-verbatim
.test.ts` ("a plan closed with a merge commit carries it, and one closed
without a merge carries no merge key at all"). This suite keeps the client's
half: one read of `?status=closed` (the request log), and one
`{cr, mergeCommit}` row per answered plan, in the answer's order.

Invocation:
    python3 -m unittest tests.client.integration.test_landings_verb_shows_closed_plans_end_to_end
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import (  # noqa: E402
    declare_and_require_board,
)
from tests.client.live_run_harness import RecordingBoard
from tests.client import TEST_INSTALL_CLIENTS

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
PYTHON_CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LandingsVerbShowsClosedPlansEndToEndTest(unittest.TestCase):
    """§S9/AC15 — the real `landings` verb (`clients/python-crucible.py`, a
    genuine subprocess) driven against a fake board answering the closed
    plans of a project holding one plan CLOSED WITH a merge commit, one
    plan CLOSED WITHOUT a merge commit, one ABORTED plan and one OPEN plan.

    Non-vacuity: a client that dropped or miscounted the commit-less
    closed plan, read the commit from anywhere but `merge.commit`, or asked
    for any plans but the closed ones fails the row-set/order/mergeCommit
    or request-log assertions below. The comparison target is the answer
    the board gave, reduced as the spec reduces it."""

    ORCHESTRATOR = "landings-e2e-orchestrator"
    CLOSED_MERGED_CR = "CR-T-LAND-E2E-MERGED"
    CLOSED_BARE_CR = "CR-T-LAND-E2E-BARE"
    ABORTED_CR = "CR-T-LAND-E2E-ABORTED"
    OPEN_CR = "CR-T-LAND-E2E-OPEN"
    WAVE = "1"
    MERGE_COMMIT = "e2e-landing-sha-1"

    @classmethod
    def _closed_plan(cls, plan_id, cr, closed_at, commit):
        """One closed plan as `?status=closed` lists it: its sealed cycle and
        its `closedAt`, and a `merge` key only when it was closed WITH a
        merge commit."""
        plan = {"planId": plan_id, "projectKey": cls.key, "cr": cr,
                "wave": cls.WAVE, "status": "closed",
                "cycles": [{"id": plan_id * 10, "label": "solo",
                            "kind": "red-green", "status": "done",
                            "activatedAt": closed_at - 500,
                            "doneAt": closed_at - 100}],
                "closedAt": closed_at}
        if commit is not None:
            plan["merge"] = {"commit": commit}
        return plan

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="landings-e2e-")
        cls.board = RecordingBoard()
        cls.base = cls.board.url
        cls.key = str(uuid.uuid4())
        cls.closed_path = f"/api/v2/projects/{cls.key}/plans?status=closed"
        now_ms = int(time.time() * 1000)
        # The server's closed-plans answer: the two closed plans only, the
        # aborted and open ones (plans 3 and 4) excluded by the server.
        cls.server_closed = {
            "ok": True,
            "plans": [cls._closed_plan(1, cls.CLOSED_MERGED_CR, now_ms - 2000,
                                       cls.MERGE_COMMIT),
                      cls._closed_plan(2, cls.CLOSED_BARE_CR, now_ms - 1000,
                                       None)],
            "lastClosedCr": cls.CLOSED_BARE_CR, "filed": 4}
        cls.board.answer("GET", cls.closed_path, cls.server_closed)

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(TOON_PATH, "landings_e2e_toon")

    @classmethod
    def tearDownClass(cls):
        cls.board.close()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _expected_rows(self):
        """The two closed plans, IN THE SERVER'S OWN ORDER, each reduced to
        {cr, mergeCommit} \u2014 mergeCommit is the commit the plan RECORDED
        (`merge.commit`, per the spec's own wording), read directly off the
        server's response rather than via the derived `commitBoundary` field
        (which happens to carry the same sha today, but is not what the spec
        defines `mergeCommit` as). The comparison target the client's rows
        are checked against, built from the SAME answer the board gives,
        never a second hardcoded guess."""
        rows = []
        for plan in self.server_closed.get("plans", []):
            merge = plan.get("merge") or {}
            rows.append({"cr": plan.get("cr"),
                         "mergeCommit": merge.get("commit")})
        return rows

    def _run_landings(self, extra_args=()):
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        before = len(self.board.events)
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        run = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "landings",
             "--project-dir", self.project_dir, *extra_args],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        self.assertEqual(
            run.returncode, 0,
            f"the `landings` verb must succeed against the fake board; "
            f"exit={run.returncode} stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        plan_reads = [path for _, method, path, _ in self.board.events[before:]
                      if method == "GET" and "/plans" in path]
        self.assertEqual(
            plan_reads, [self.closed_path],
            f"`landings` reads the plans once, asking the server for the "
            f"CLOSED ones only (`?status=closed`); got {plan_reads!r}")
        return run.stdout

    def test_toon_landings_rows_equal_the_servers_own_closed_plans_read_with_merge_commits(self):
        stdout = self._run_landings()
        decoded = self.toon.decode(stdout)
        self.assertIn(
            "axi", decoded,
            f"`landings` must answer with a TOON-AXI envelope; got "
            f"stdout={stdout!r}")
        axi = decoded["axi"]

        rows = axi.get("landings")
        self.assertIsInstance(
            rows, list,
            f"the `landings` field must decode as a list of rows; got "
            f"{rows!r} from stdout={stdout!r}")
        expected = self._expected_rows()
        self.assertEqual(
            rows, expected,
            f"landings rows must equal EXACTLY the server's own "
            f"?status=closed read (reduced to cr/mergeCommit, in the "
            f"server's order) — the aborted and open plans this board "
            f"also holds must never appear; got {rows!r} expected {expected!r}")
        merged_row = next((r for r in rows if r.get("cr") == self.CLOSED_MERGED_CR), None)
        assert merged_row is not None, f"got rows={rows!r}"
        self.assertEqual(
            merged_row.get("mergeCommit"), self.MERGE_COMMIT,
            f"the merged CR's row must carry its real merge commit; got "
            f"{merged_row!r}")
        bare_row = next((r for r in rows if r.get("cr") == self.CLOSED_BARE_CR), None)
        assert bare_row is not None, f"got rows={rows!r}"
        self.assertIsNone(
            bare_row.get("mergeCommit"),
            f"the commit-less CR's row must carry mergeCommit=None; got "
            f"{bare_row!r}")

    def test_json_format_landings_rows_equal_the_servers_own_closed_plans_read_with_merge_commits(self):
        stdout = self._run_landings(extra_args=("--format", "json"))
        parsed = json.loads(stdout)
        self.assertIsInstance(
            parsed, dict,
            f"--format json must write exactly one JSON object; got "
            f"stdout={stdout!r}")
        rows = parsed.get("landings")
        expected = self._expected_rows()
        self.assertEqual(
            rows, expected,
            f"the parsed object's `landings` must equal EXACTLY the "
            f"server's own ?status=closed read; got {rows!r} expected "
            f"{expected!r}")


if __name__ == "__main__":
    unittest.main()
