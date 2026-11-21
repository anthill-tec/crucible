"""CR-CRU-170 §S2/AC2 — a bun declared-tier target that exits 1 and writes no
report closes the run it opened itself: the client posts
`/api/v2/runs/<id>/abort` for that run, at once, with a reason naming the
report it never got, and leaves no run of its own open — beside the
five-client subprocess-harness coverage in
`test_a_client_aborts_a_run_it_cannot_file.py`.

The declared target is run by the real `bun` (a `test:regression` script that
exits 1); the board is a recording stand-in (`RecordingBoard`) that opens and
aborts runs as the server does, and what the client sent is read off its
request log. The board's half — an abort with a reason settles the run
`aborted` with that reason and takes it out of `openRuns` — is held in bun by
`tests/integration/run-self-abort.test.ts` ("A aborts the run A opened, with a
reason: 2xx; the run row is aborted with that reason …") and
`tests/integration/run-lifecycle-read-surface.test.ts`.

Invocation:
    python3 -m unittest tests.client.integration.test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client import TEST_INSTALL_CLIENTS
from tests.client.live_run_harness import (
    INGEST_PATHS,
    START,
    RecordingBoard,
    install_project,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

AGENT = "bun-declared-target-abort-e2e"
PROJECT_KEY = "bun-abort-e2e-key"


class BunDeclaredTargetExitWithoutReportAbortsItsRunEndToEndTest(unittest.TestCase):
    """AC2's client half: "a bun declared target that exits without a report
    leaves the run `aborted` with its reason" — the client aborts the run it
    opened, with its reason, and files no result for it."""

    def setUp(self):
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the declared target is run by the real `bun`: without it "
                "there is no declared target to run. A missing toolchain, "
                "not a passing assertion.")
        self.bun = bun
        self._tmpdir = tempfile.mkdtemp(prefix="bun-abort-e2e-")
        self.addCleanup(shutil.rmtree, self._tmpdir, ignore_errors=True)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.package_dir = os.path.join(self._tmpdir, "package")
        os.makedirs(self.package_dir)
        install_project(self.package_dir, self.board.url, PROJECT_KEY,
                        "bun-abort-e2e")
        # A declared `test:regression` target that exits 1 and writes NO
        # report at all — §S2's table row 1, bun's declared-tier body
        # (`cmd_regression`). `bun run <script>` forwards trailing argv to a
        # plain shell-command script untouched (`exit 1` ignores the
        # `--reporter=junit --reporter-outfile=...` flags this client
        # appends under the flag-mechanism default), so the declared target
        # really does exit 1 having written nothing, exactly as a starved
        # real suite would.
        Path(self.package_dir, "package.json").write_text(json.dumps({
            "name": "bun-abort-e2e-fixture",
            "scripts": {"test:regression": "exit 1"},
        }), encoding="utf-8")

    def _drive_regression(self):
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        return subprocess.run(
            [sys.executable, str(BUN_CLIENT_PATH), "regression",
             "--bun", self.bun, "--project-dir", self.package_dir,
             "--package-dir", self.package_dir, "--reports", "reports",
             "--agent", AGENT],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120, check=False)

    def test_the_run_is_aborted_with_the_clients_reason_and_no_run_is_left_open(self):
        run = self._drive_regression()
        self.assertNotEqual(
            run.returncode, 0,
            f"a declared target that writes no report must still fail; "
            f"stdout={run.stdout.strip()[:800]!r} "
            f"stderr={run.stderr.strip()[-2000:]!r}")

        posts = self.board.posts()
        starts = [b for p, b in posts if p == START]
        self.assertEqual(
            len(starts), 1,
            f"the regression opens exactly one run; "
            f"posts={[p for p, _ in posts]!r}")
        self.assertEqual(
            ((starts[0] or {}).get("agentId"), (starts[0] or {}).get("tier")),
            (AGENT, "regression"),
            f"the run is opened under its agent and the `regression` tier; "
            f"got {starts[0]!r}")

        opened = self.board.run_ids_opened()
        aborts = self.board.aborts()
        self.assertEqual(
            [p for p, _ in aborts], [f"/api/v2/runs/{r}/abort" for r in opened],
            f"the client must close the run it opened itself — exactly one "
            f"abort, for that run, so no run of this agent's is left open; "
            f"opened={opened!r} aborts={aborts!r}")
        body = aborts[0][1] if aborts else {}
        self.assertEqual(
            (body or {}).get("agentId"), AGENT,
            f"the abort is the opening agent's own; got {body!r}")
        reason = (body or {}).get("reason") or ""
        self.assertIn(
            "junit.xml", reason,
            f"the abort reason must name what the declared target never "
            f"wrote; got reason={reason!r}")

        filed = [p for p, b in posts if p in INGEST_PATHS
                 and isinstance(b, dict) and b.get("runId") in opened]
        self.assertEqual(
            filed, [],
            f"the starved run is aborted, never filed as a result; "
            f"posts={[p for p, _ in posts]!r}")


if __name__ == "__main__":
    unittest.main()
