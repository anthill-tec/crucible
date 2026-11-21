"""§S1 — A GATE STATES WHICH RELEASE IT GATES: retired at insert when its
release has already shipped.

The feature: a gate posted through a client with `--release <label>` naming
a release the board has already recorded is retired at insert, and one whose
label no release has is not. No fake can prove it: insert-time retirement is
a property of the store's own gate-insert transaction, which consults the
recorded releases, so a scripted board could only answer what the test told
it to.

This module reaches the release-retirement mechanism THROUGH a client: the
pair is driven against a real scratch board (`RealBoard`,
`tests/client/real_board.py`: a server on a free port with a temp DB — never
the live board). The flag surface and the wire shape, which need no board,
are `test_gate_names_the_release_it_gates_without_a_board`.

Invocation:
    python3 -m unittest tests.client.integration.test_gate_names_the_release_it_gates
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client import TEST_INSTALL_CLIENTS
from tests.client.client_fleet_envelope_census_helpers import (
    declare_and_require_board,
)
from tests.client.real_board import RealBoard

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
}

RELEASE_FLAG = "--release"

# The env keys the fleet's `context` block reads. Cleared everywhere below so
# an ambient orchestrator session can never colour a payload asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _http(base, path, payload=None, method=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which IS the assertion subject for a refusal."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _register(base, key, agent_id, role, cycle_id=None):
    """Register one agent on the scratch board. A gate POST requires a LIVE
    registered caller, and a TDD role requires a cycle binding — which is also
    what puts the posted gate on the cycle-anchored feed the retirement test
    reads it back from."""
    body = {"projectKey": key, "agentId": agent_id, "status": "online",
            "role": role,
            "identity": {"displayName": agent_id, "source": "manual"}}
    if cycle_id is not None:
        body["cycleId"] = cycle_id
    answer = _http(base, "/api/v2/agents/register", body)
    assert answer.get("ok"), f"register failed for {agent_id}: {answer!r}"
    return answer


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — the retirement mechanism, reached through a client
# ═══════════════════════════════════════════════════════════════════════════


class ReleaseStampedGateIsRetiredOnInsertTest(unittest.TestCase):
    """§S1's last criterion, and the only one no mock can hold: a gate posted
    with a release the board has ALREADY recorded comes back retired.

    Insert-time retirement lives in the store's own gate-insert path, which
    consults the recorded releases — so it is observable only against a real
    store. The unretired sibling in the same test is what proves the marker
    came from the release MATCH and not from the flag merely being present.

    The two gates are read back off the cycle-anchored feed rather than the
    recent-events feed, deliberately: the live feed EXCLUDES retired gates, so
    reading them there would answer the question with an absence."""

    RELEASED = "7.7.7"
    UNRELEASED = "8.8.8"
    ORCHESTRATOR = "gate-release-e2e-orchestrator"
    GATE_AGENT = "gate-release-e2e-agent"
    FIXTURE_CR = "CR-G1-1"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="gate-release-e2e-")
        cls._board = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "insert-time retirement is a property of the real store: "
                "without `bun` there is no server to hold it. A missing "
                "toolchain, not a passing assertion.")
        cls._board = RealBoard(bun, "gate-release-e2e")
        cls.base = cls._board.base
        cls.key = cls._board.key
        try:
            cls._boot()
        except BaseException:
            # A board booted and then abandoned by a FAILING setUpClass is
            # never torn down (`tearDownClass` does not run when `setUpClass`
            # raises), and an orphaned server holds its port for as long as it
            # lives. Stop it on the way out, whatever went wrong.
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
        _register(cls.base, cls.key, cls.ORCHESTRATOR, "ORCHESTRATOR")

        # A plan with one ACTIVE cycle, so the gate poster can register BOUND
        # and its gates land on that cycle's anchored feed.
        filed = _http(cls.base, f"/api/v2/projects/{cls.key}/plans",
                      {"cr": cls.FIXTURE_CR, "cycles": [{"label": "solo"}],
                       "agentId": cls.ORCHESTRATOR})
        cls.cycle_id = filed["cycles"][0]["id"]
        activated = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/plans/{filed['planId']}/cycles/{cls.cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        _register(cls.base, cls.key, cls.GATE_AGENT, "RED", cycle_id=cls.cycle_id)

        # The release the board has ALREADY shipped. Its counterpart label is
        # deliberately never recorded.
        recorded = _http(cls.base, "/api/v2/milestones",
                         {"projectKey": cls.key, "agentId": cls.ORCHESTRATOR,
                          "type": "release", "label": cls.RELEASED})
        assert recorded.get("ok"), f"release milestone failed: {recorded!r}"

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={cls.key}\n")

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        """Stop the scratch board, from teardown OR from a setUpClass that
        failed after booting it. Idempotent, so both callers may run."""
        board = getattr(cls, "_board", None)
        if board is None:
            return
        cls._board = None
        board.close()

    def _post_gate_through_the_client(self, release):
        # CR-CRU-139 §S2 — the scratch board is declared in the fixture's own
        # project file, and the interlock refuses the spawn unless the client
        # would really resolve it: a gate report is a WRITE, and a drive that
        # merely stopped steering would land it on the shipped default.
        declare_and_require_board(self.project_dir, self.base,
                                  "bun-crucible.py gate-report")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        return subprocess.run(
            [sys.executable, str(CLIENT_FILES["bun"]), "gate-report",
             "--outcome", "passed", "--steps", "review:passed",
             "--intent", f"gate for {release}", "--agent", self.GATE_AGENT,
             RELEASE_FLAG, release, "--project-dir", self.project_dir],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def _gates_by_version(self):
        feed = _http(self.base,
                     f"/api/v2/events?project={self.key}&cycleId={self.cycle_id}")
        return {event.get("version"): event
                for event in feed.get("events", [])
                if event.get("kind") == "gate"}

    def test_a_gate_naming_an_already_recorded_release_comes_back_retired(self):
        for release in (self.RELEASED, self.UNRELEASED):
            run = self._post_gate_through_the_client(release)
            self.assertEqual(
                run.returncode, 0,
                f"the client must post a gate naming release {release!r}; "
                f"exit={run.returncode} stdout={run.stdout.strip()[:400]!r} "
                f"stderr={run.stderr.strip()[:400]!r}")

        gates = self._gates_by_version()
        self.assertEqual(
            sorted(gates), sorted([self.RELEASED, self.UNRELEASED]),
            f"both gates must be on the board, each carrying its OWN release "
            f"— and exactly two of them; got {gates!r}")

        retired = gates[self.RELEASED]
        live = gates[self.UNRELEASED]
        self.assertIsInstance(
            retired.get("retiredAt"), int,
            f"a gate whose release has already shipped is retired AT INSERT, "
            f"the marker carrying the moment it happened; got {retired!r}")
        self.assertNotIn(
            "retiredAt", live,
            f"a gate whose release is not recorded is a release UNDER WAY and "
            f"stays live — which is what proves the marker above came from "
            f"the release match and not from the flag being present; got "
            f"{live!r}")

        stored = _http(self.base, f"/api/v2/events/{retired['id']}").get("event", {})
        self.assertEqual(
            (stored.get("version"), type(stored.get("retiredAt"))),
            (self.RELEASED, int),
            f"the stored event itself carries both facts, so the retirement "
            f"is durable rather than a projection of the feed; got {stored!r}")


if __name__ == "__main__":
    unittest.main()
