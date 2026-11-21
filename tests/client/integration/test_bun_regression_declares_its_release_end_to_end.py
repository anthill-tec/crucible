"""CR-CRU-164 §S1 (client half) + AC1 — `bun-crucible.py regression
--release <it>` against a fake bun that writes a junit report files its run
under that release: the run it opens and the run it files both carry the
release label and the `regression` tier, and no other label rides any request.

The board is a recording stand-in (`RecordingBoard`) that opens the run as the
server does; what the client sent is read off its request log. The board's
half — a declared release accepted on `/api/v2/runs/start`
(`resolveReleaseAttach`) and `GET /api/v2/events?project=…&release=<it>`
answering exactly that release's runs, an unknown label answering an empty set
(`handleEventsList`) — is held in bun by
`tests/integration/events-by-release.test.ts` ("answers exactly one release's
events, newest first, …" and "an unknown/undeclared release label answers 200
with an EMPTY list …").

Invocation:
    python3 -m unittest tests.client.integration.test_bun_regression_declares_its_release_end_to_end -v
"""

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
    write_fake_bun,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

AGENT = "bun-release-run-e2e"
PROJECT_KEY = "bun-release-run-e2e-key"
RELEASE_LABEL = "7.7.7"


class BunRegressionDeclaresItsReleaseEndToEndTest(unittest.TestCase):
    """AC1's client half: a `bun-crucible.py regression --release <it>` run
    opens and files its run under that release, at the `regression` tier."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="bun-release-run-e2e-")
        self.addCleanup(shutil.rmtree, self._tmpdir, ignore_errors=True)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.package_dir = os.path.join(self._tmpdir, "package")
        os.makedirs(self.package_dir)
        install_project(self.package_dir, self.board.url, PROJECT_KEY,
                        "bun-release-run-e2e")
        self.fake_bun = write_fake_bun(self.package_dir, 1)

    def _drive_regression(self):
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["FAKE_TOTAL"] = "1"
        return subprocess.run(
            [sys.executable, str(BUN_CLIENT_PATH), "regression",
             "--release", RELEASE_LABEL,
             "--bun", self.fake_bun, "--project-dir", self.package_dir,
             "--package-dir", self.package_dir, "--reports", "reports",
             "--agent", AGENT],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120, check=False)

    def test_the_release_run_is_answered_by_the_by_release_events_read(self):
        run = self._drive_regression()
        self.assertEqual(
            run.returncode, 0,
            f"a green `regression --release {RELEASE_LABEL}` against a "
            f"board that opens its run must exit 0; "
            f"stdout={run.stdout.strip()[:800]!r} "
            f"stderr={run.stderr.strip()[-2000:]!r}")

        posts = self.board.posts()
        starts = [b for p, b in posts if p == START]
        self.assertEqual(
            len(starts), 1,
            f"the regression opens exactly one run; "
            f"posts={[p for p, _ in posts]!r}")
        start = starts[0] or {}
        self.assertEqual(
            (start.get("agentId"), start.get("release"), start.get("tier")),
            (AGENT, RELEASE_LABEL, "regression"),
            f"the run is opened under its agent, the release it declared and "
            f"the `regression` tier the verb was invoked under; got {start!r}")

        ingests = [b for p, b in posts if p in INGEST_PATHS
                   and isinstance(b, dict) and b.get("agentId") == AGENT]
        self.assertEqual(
            len(ingests), 1,
            f"exactly the one run this agent filed; "
            f"posts={[p for p, _ in posts]!r}")
        self.assertEqual(
            ingests[0].get("release"), RELEASE_LABEL,
            f"the run filed carries the release it was run under; "
            f"keys={sorted(ingests[0])!r}")
        self.assertEqual(
            ingests[0].get("runId"), "run-live-1",
            "the run filed is the run the regression opened")

        # Negative bound: no request names any other release label — the
        # label is the one the verb was given, not a default or a guess.
        others = [(p, b.get("release")) for p, b in posts
                  if isinstance(b, dict) and "release" in b
                  and b.get("release") != RELEASE_LABEL]
        self.assertEqual(
            others, [],
            f"no request carries a release other than {RELEASE_LABEL}; "
            f"got {others!r}")


if __name__ == "__main__":
    unittest.main()
