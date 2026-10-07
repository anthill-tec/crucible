"""CR-CRU-170 \u00a7S2/AC2 RED \u2014 end to end, against a REAL ephemeral
`src/server.ts` (never :3850/:3849): a bun declared-tier target that exits 1
and writes no report leaves the run `aborted` with the client's own reason
on the board, and no run open \u2014 the one AC2 explicitly asks be checked
against a real server, beside the five-client subprocess-harness coverage in
`test_a_client_aborts_a_run_it_cannot_file.py`.

Follows the same real-server idiom every other end-to-end suite here uses
(`test_landings_verb_shows_closed_plans_end_to_end.py`, itself following
`test_queue_rows_carry_title_and_lifecycle.py`): a scratch `bun run
src/server.ts` on a free port (never 3850/3849/39877) with a throwaway
`mkdtemp` store, a real project created over HTTP, `bun-crucible.py`
driven as a genuine subprocess against it, and the board's OWN
`GET /api/v2/events` read as the comparison target.

RED today: `clients/bun-crucible.py`'s declared-tier no-report exit
(`cmd_regression`, the branch that runs when `os.path.exists(ingest_path)`
is False) only ever appends `_run_left_open_warning` \u2014 it posts nothing to
`/api/v2/runs/<id>/abort` (confirmed by reading that branch and every call
site of the abort route, which is empty outside `src/v2.ts`'s own
`handleRunAbort`). So the run this test drives is left OPEN on the real
board (visible in its `openRuns`, no `status: "aborted"` event for it) until
the server's own sweep eventually catches it \u2014 never AT ONCE, which is
exactly what this test's assertions require and the current fleet cannot
give it.

Invocation:
    python3 -m unittest tests.client.test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end
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

from tests.client.live_run_harness import install_project

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

AGENT = "bun-declared-target-abort-e2e"


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


class BunDeclaredTargetExitWithoutReportAbortsItsRunEndToEndTest(unittest.TestCase):
    """AC2's own real-server criterion: "a bun declared target that exits
    without a report leaves the run `aborted` with its reason on the
    board"."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="bun-abort-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the real board this test aborts a run ON is a property of "
                "a REAL server: without `bun` there is neither a server to "
                "boot nor a declared target to run. A missing toolchain, "
                "not a passing assertion.")
        cls.bun = bun
        port = _free_port()
        # Never the live dev ports, and never the harness's own fixed probe
        # port (tests/client/test_cr139_installer_writes_the_connection.py
        # reserves 39877) \u2014 an OS-assigned free port is neither by
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
        project = _http(cls.base, "/api/v2/projects", {"name": "bun-abort-e2e"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.key = project["project"]["key"]

        cls.package_dir = os.path.join(cls._tmpdir, "package")
        os.makedirs(cls.package_dir)
        install_project(cls.package_dir, cls.base, cls.key, "bun-abort-e2e")
        # A declared `test:regression` target that exits 1 and writes NO
        # report at all \u2014 \u00a7S2's table row 1, bun's declared-tier body
        # (`cmd_regression`). `bun run <script>` forwards trailing argv to a
        # plain shell-command script untouched (`exit 1` ignores the
        # `--reporter=junit --reporter-outfile=...` flags this client
        # appends under the flag-mechanism default), so the declared target
        # really does exit 1 having written nothing, exactly as a starved
        # real suite would.
        Path(cls.package_dir, "package.json").write_text(json.dumps({
            "name": "bun-abort-e2e-fixture",
            "scripts": {"test:regression": "exit 1"},
        }), encoding="utf-8")

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
        return subprocess.run(
            [sys.executable, str(BUN_CLIENT_PATH), "regression",
             "--bun", self.bun, "--project-dir", self.package_dir,
             "--package-dir", self.package_dir, "--reports", "reports",
             "--agent", AGENT],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def test_the_run_is_aborted_with_the_clients_reason_and_no_run_is_left_open(self):
        run = self._drive_regression()
        self.assertNotEqual(
            run.returncode, 0,
            f"a declared target that writes no report must still fail; "
            f"stdout={run.stdout.strip()[:800]!r} "
            f"stderr={run.stderr.strip()[-2000:]!r}")

        read = _http(self.base, f"/api/v2/events?project={self.key}&limit=50")
        self.assertTrue(read.get("ok"), f"events read failed: {read!r}")

        open_runs = read.get("openRuns") or []
        this_agent_open = [r for r in open_runs if r.get("agentId") == AGENT]
        self.assertEqual(
            this_agent_open, [],
            f"the client must have closed the run it opened itself \u2014 NO "
            f"run of this agent's may still show as open on the real "
            f"board; openRuns={open_runs!r}")

        events = [e for e in (read.get("events") or []) if e.get("agentId") == AGENT]
        aborted = [e for e in events if e.get("status") == "aborted"]
        self.assertEqual(
            len(aborted), 1,
            f"exactly one event for this agent must be settled `aborted` "
            f"\u2014 the run the declared target opened and then starved; "
            f"events={events!r}")
        self.assertEqual(
            aborted[0].get("tier"), "regression",
            f"the aborted run must carry the `regression` tier it was "
            f"opened under; got {aborted[0]!r}")
        reason = aborted[0].get("abortReason") or ""
        self.assertIn(
            "junit.xml", reason,
            f"the abort reason must name what the declared target never "
            f"wrote; got abortReason={reason!r}")


if __name__ == "__main__":
    unittest.main()
