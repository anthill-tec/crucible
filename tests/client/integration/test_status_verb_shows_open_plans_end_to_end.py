"""The `status` verb's wiring against a board carrying open, closed and
aborted plans (AC10/AC12 end-to-end proofs).

AC10 — the `status` verb's envelope has the open plans as rows, and
`filed`/`lastClosedCr` equal the server's values. No stubbed transport: the
verb is a genuine `python-crucible.py` subprocess reading over HTTP.

AC12 — AC10's run is repeated with `--format json`, and the parsed object
carries the open plans as `plans`, and the server's `filed` and
`lastClosedCr`.

The board is a fake (`RecordingBoard`) whose `GET …/plans?status=open`
answers, in the server's own shape, what the real board answers for a
project holding two OPEN plans, one CLOSED plan (with a merge commit) and one
ABORTED plan: the two open plans, `filed: 4` and `lastClosedCr` the closed
CR. That the server filters by `?status=` and computes `filed`/`lastClosedCr`
over every plan is the server's half, held in bun by
`plans-status-filter.test.ts` ("on the mixed board, unfiltered / ?status=open
/ ?cr=<cr> ALL carry filed:4 and lastClosedCr = …" and "?status=open returns
EXACTLY the one open plan …"). This suite keeps the client's half: it asks
for the open plans only (the request log), shows the answer's plans as rows,
and passes `filed`/`lastClosedCr` through verbatim — `filed` (4) differs
from the row count (2) and `lastClosedCr` names no row, so a client that
recomputed either fails.

Invocation:
    python3 -m unittest tests.client.integration.test_status_verb_shows_open_plans_end_to_end
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
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

# The env keys the fleet's `context` block reads — cleared before every
# subprocess drive so an ambient orchestrator session can never colour the
# envelope under test (the same idiom the queue end-to-end suite uses).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StatusVerbShowsOpenPlansEndToEndTest(unittest.TestCase):
    """AC10/AC12 — the real `status` verb (`clients/python-crucible.py`, a
    genuine subprocess) driven against a fake board answering the open plans
    of a project that holds TWO open plans, one CLOSED plan and one ABORTED
    plan."""

    ORCHESTRATOR = "status-e2e-orchestrator"
    OPEN_CR_1 = "CR-T-STATUS-OPEN-1"
    OPEN_CR_2 = "CR-T-STATUS-OPEN-2"
    CLOSED_CR = "CR-T-STATUS-CLOSED"
    ABORTED_CR = "CR-T-STATUS-ABORTED"
    WAVE = "1"

    @classmethod
    def _open_plan(cls, plan_id, cr):
        return {"planId": plan_id, "projectKey": cls.key, "cr": cr,
                "wave": cls.WAVE, "status": "open", "orchestrator": cls.ORCHESTRATOR,
                "cycles": [{"id": plan_id * 10, "label": "solo",
                            "kind": "red-green", "status": "pending"}]}

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="status-e2e-")
        cls.board = RecordingBoard()
        cls.base = cls.board.url
        cls.key = str(uuid.uuid4())
        cls.open_path = f"/api/v2/projects/{cls.key}/plans?status=open"
        # The server's OWN facts for this project: four plans filed (two
        # open, one closed, one aborted), the closed one the last closed.
        cls.server_facts = {"ok": True,
                            "plans": [cls._open_plan(1, cls.OPEN_CR_1),
                                      cls._open_plan(2, cls.OPEN_CR_2)],
                            "lastClosedCr": cls.CLOSED_CR, "filed": 4}
        cls.board.answer("GET", cls.open_path, cls.server_facts)

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(TOON_PATH, "status_e2e_toon")

    @classmethod
    def tearDownClass(cls):
        cls.board.close()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _run_status(self, extra_args=()):
        # the board is declared in the fixture's OWN project file, and
        # the interlock refuses the spawn unless the client would really
        # really resolve it — this read must land on the fake board,
        # never the shipped default (which on this machine is production).
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        before = len(self.board.events)
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        run = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "status",
             "--project-dir", self.project_dir, *extra_args],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        self.assertEqual(
            run.returncode, 0,
            f"the `status` verb must succeed against the fake board; "
            f"exit={run.returncode} stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        plan_reads = [path for _, method, path, _ in self.board.events[before:]
                      if method == "GET" and "/plans" in path]
        self.assertEqual(
            plan_reads, [self.open_path],
            f"`status` reads the plans once, asking the server for the OPEN "
            f"ones only (`?status=open`), never every plan to filter "
            f"itself; got {plan_reads!r}")
        return run.stdout

    def test_ac10_toon_status_carries_only_the_open_plans_and_the_servers_facts(self):
        """AC10 — the `status` verb's envelope has the open plans as rows,
        and `filed`/`lastClosedCr` equal the server's values."""
        stdout = self._run_status()
        decoded = self.toon.decode(stdout)
        self.assertIn(
            "axi", decoded,
            f"`status` must answer with a TOON-AXI envelope; got "
            f"stdout={stdout!r}")
        axi = decoded["axi"]

        rows = axi.get("plans")
        self.assertIsInstance(
            rows, list,
            f"the `plans` field must decode as a list of rows; got "
            f"{rows!r} from stdout={stdout!r}")
        row_crs = sorted(r.get("cr") for r in rows)
        self.assertEqual(
            row_crs, sorted([self.OPEN_CR_1, self.OPEN_CR_2]),
            f"status rows must be EXACTLY the two open plans — the closed "
            f"and aborted plans this project also holds must never appear "
            f"as rows; got {rows!r}")
        self.assertEqual(
            axi.get("count"), 2,
            f"count must equal the number of open-plan rows; got {axi!r}")
        self.assertEqual(
            axi.get("filed"), self.server_facts.get("filed"),
            f"filed must equal the server's OWN total plan count "
            f"({self.server_facts.get('filed')!r}), read over HTTP — "
            f"not a client-recomputed value; got {axi!r}")
        self.assertEqual(
            axi.get("lastClosedCr"), self.server_facts.get("lastClosedCr"),
            f"lastClosedCr must equal the server's own value "
            f"({self.server_facts.get('lastClosedCr')!r}); got {axi!r}")

    def test_ac12_json_format_carries_the_open_plans_and_the_servers_facts(self):
        """AC12 — AC10's end-to-end run repeated with `--format json`; the
        parsed object carries the open plans as `plans`, and the server's
        `filed`/`lastClosedCr`."""
        stdout = self._run_status(extra_args=("--format", "json"))
        parsed = json.loads(stdout)
        self.assertIsInstance(
            parsed, dict,
            f"--format json must write exactly one JSON object; got "
            f"stdout={stdout!r}")
        row_crs = sorted(r.get("cr") for r in parsed.get("plans", []))
        self.assertEqual(
            row_crs, sorted([self.OPEN_CR_1, self.OPEN_CR_2]),
            f"the parsed object's `plans` must be EXACTLY the two open "
            f"plans — the closed and aborted plans must never appear; got "
            f"{parsed!r}")
        self.assertEqual(
            parsed.get("count"), 2,
            f"the parsed count must equal the number of open-plan rows; "
            f"got {parsed!r}")
        self.assertEqual(
            parsed.get("filed"), self.server_facts.get("filed"),
            f"the parsed filed must equal the server's own value "
            f"({self.server_facts.get('filed')!r}); got {parsed!r}")
        self.assertEqual(
            parsed.get("lastClosedCr"), self.server_facts.get("lastClosedCr"),
            f"the parsed lastClosedCr must equal the server's own value "
            f"({self.server_facts.get('lastClosedCr')!r}); got {parsed!r}")


if __name__ == "__main__":
    unittest.main()
