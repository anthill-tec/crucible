"""CR-CRU-164 §S1 (client half) + AC1 — end-to-end proof, against a REAL
ephemeral `src/server.ts` (never :3850/:3849/39877): a release DECLARED by
planning a CR into it (§S1: "A release is declared when the project's
roadmap knows it: a CR planned into it"), then `bun-crucible.py regression
--release <it>` against a fake bun that writes a junit report, then
`GET /api/v2/events?project=…&release=<it>` answers that run.

Follows the same real-server idiom every other end-to-end suite here uses
(`test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end.py`,
`test_queue_rows_carry_title_and_lifecycle.py`): a scratch `bun run
src/server.ts` on a free port (never 3850/3849/39877) with a throwaway
`mkdtemp` store, a real project created over HTTP, `bun-crucible.py` driven
as a genuine subprocess against it, and the board's OWN
`GET /api/v2/events` read as the comparison target.

Both server-side pieces this test needs (`resolveReleaseAttach`'s declared-
release acceptance on `/api/v2/runs/start` + the three ingest routes, and
`handleEventsList`'s `?release=` branch) are ALREADY on this branch (C1,
6057c8d) — read directly from `src/v2.ts`. This test is RED for the ONE gap
C2 exists to close: `bun-crucible.py regression` has no `--release` flag at
all yet, so the drive below never reaches the server's already-built side —
argparse rejects it first.

Invocation:
    python3 -m unittest tests.client.test_bun_regression_declares_its_release_end_to_end -v
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import install_project, write_fake_bun

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

AGENT = "bun-release-run-e2e"
ORCHESTRATOR = "bun-release-run-e2e-orchestrator"
RELEASE_CR = "CR-RELEASE-RUN-E2E-FIXTURE"
RELEASE_LABEL = "7.7.7"
RELEASE_WAVE = "1"


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _require_http_scheme(url):
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"refusing a non-http(s) URL scheme: {url!r}")
    return url


def _http(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310
        _require_http_scheme(base + path), data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(  # noqa: S310
                    _require_http_scheme(base + "/api/v2/health"), timeout=2):
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")


class BunRegressionDeclaresItsReleaseEndToEndTest(unittest.TestCase):
    """AC1's real-server criterion: a release declared on the roadmap, a
    `bun-crucible.py regression --release <it>` run against it, and that run
    answered back by `GET /api/v2/events?project=…&release=<it>`."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="bun-release-run-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the real board this test files a release run ON is a "
                "property of a REAL server: without `bun` there is neither "
                "a server to boot nor a fake runner to execute. A missing "
                "toolchain, not a passing assertion.")
        cls.bun = bun
        port = _free_port()
        # Never the live dev ports, and never the harness's own fixed probe
        # port (tests/client/test_cr139_installer_writes_the_connection.py
        # reserves 39877) — an OS-assigned free port is neither by
        # construction.
        assert port not in (3850, 3849, 39877), (
            f"fixture sanity: the OS handed back a reserved port {port}")
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ,
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._boot()
        except BaseException:
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)
        project = _http(cls.base, "/api/v2/projects",
                        {"name": "bun-release-run-e2e"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.key = project["project"]["key"]

        # §S1: "A release is declared when the project's roadmap knows it: a
        # CR planned into it" — register an ORCHESTRATOR, then `cr-plan` a
        # throwaway CR into RELEASE_LABEL (the exact `cr-plan` body shape
        # pinned in test_cr091_roadmap_verbs.py: {cr, release, wave, title,
        # agentId}).
        registered = _http(
            cls.base, "/api/v2/agents/register",
            {"projectKey": cls.key, "agentId": ORCHESTRATOR,
             "role": "ORCHESTRATOR"})
        assert registered.get("ok"), (
            f"orchestrator registration failed: {registered!r}")
        proposed = _http(
            cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
            {"agentId": ORCHESTRATOR, "label": RELEASE_LABEL,
             "targetAt": int(time.time()) + 86400})
        assert proposed.get("ok"), f"release proposal failed: {proposed!r}"
        planned = _http(
            cls.base, f"/api/v2/projects/{cls.key}/queue/plan",
            {"cr": RELEASE_CR, "title": "release-run e2e fixture CR",
             "release": RELEASE_LABEL, "wave": RELEASE_WAVE,
             "agentId": ORCHESTRATOR})
        assert planned.get("ok"), f"cr-plan failed: {planned!r}"

        cls.package_dir = os.path.join(cls._tmpdir, "package")
        os.makedirs(cls.package_dir)
        install_project(cls.package_dir, cls.base, cls.key, "bun-release-run-e2e")
        cls.fake_bun = write_fake_bun(cls.package_dir, 1)

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

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
            timeout=120)

    def test_the_release_run_is_answered_by_the_by_release_events_read(self):
        run = self._drive_regression()
        self.assertEqual(
            run.returncode, 0,
            f"a green `regression --release {RELEASE_LABEL}` against a "
            f"DECLARED release must exit 0; "
            f"stdout={run.stdout.strip()[:800]!r} "
            f"stderr={run.stderr.strip()[-2000:]!r}")

        read = _http(self.base,
                     f"/api/v2/events?project={self.key}&release={RELEASE_LABEL}")
        self.assertTrue(read.get("ok"), f"by-release events read failed: {read!r}")

        events = [e for e in (read.get("events") or []) if e.get("agentId") == AGENT]
        self.assertEqual(
            len(events), 1,
            f"GET /api/v2/events?project=…&release={RELEASE_LABEL} must "
            f"answer exactly the one run this agent filed under that "
            f"release; events={read.get('events')!r}")
        self.assertEqual(
            events[0].get("release"), RELEASE_LABEL,
            f"the answered event must itself carry the release it was "
            f"found under; got {events[0]!r}")
        self.assertEqual(
            events[0].get("tier"), "regression",
            f"the event must carry the `regression` tier the verb was "
            f"invoked under; got {events[0]!r}")

        # Negative bound: a read for a DIFFERENT, never-declared release
        # label must answer NOTHING for this agent (an unknown label is 200
        # with an empty set, per `handleEventsList`) — proving the filter is
        # real and not merely "every event, regardless of ?release=".
        other = _http(self.base,
                      f"/api/v2/events?project={self.key}&release=0.0.1-nonexistent")
        self.assertTrue(other.get("ok"), f"by-release events read failed: {other!r}")
        other_events = [e for e in (other.get("events") or []) if e.get("agentId") == AGENT]
        self.assertEqual(
            other_events, [],
            f"an undeclared/unrelated release label must answer NO events "
            f"for this agent; got {other_events!r}")


if __name__ == "__main__":
    unittest.main()
