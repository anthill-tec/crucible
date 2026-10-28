"""A real, throwaway Crucible board for client end-to-end tests.

Boots `bun run src/server.ts` on an OS-assigned free port (never the live
3850/3849, never the installer probe's 39877) over a `mkdtemp` store, creates
one project over HTTP and reads the board's own answers back — the same idiom
`test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end.py`
uses, lifted so more than one suite can stand a board up without copying it.

Not a test module: it holds no `TestCase`. Every reader here compares the
board's stored run (its `summary` and `tree`) — the outcome a client run
actually filed.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import install_project

REPO_ROOT = Path(__file__).resolve().parents[2]

_RESERVED_PORTS = (3850, 3849, 39877)


def _free_port():
    for _ in range(20):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        if port not in _RESERVED_PORTS:
            return port
    raise RuntimeError("no free port outside the reserved ones")


def _require_http_scheme(url):
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"refusing a non-http(s) URL scheme: {url!r}")
    return url


class RealBoard:
    """One scratch board process and the one project it holds."""

    def __init__(self, bun, name):
        self.bun = bun
        self.tmpdir = tempfile.mkdtemp(prefix="real-board-")
        self.proc = None
        port = _free_port()
        self.base = f"http://127.0.0.1:{port}"
        Path(self.tmpdir, "crucible.toml").write_text(
            f'[server]\nhost = "127.0.0.1"\nport = {port}\n', encoding="utf-8")
        self.proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ,
                 "CRUCIBLE_DB": os.path.join(self.tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self._await()
            project = self.http("/api/v2/projects", {"name": name})
            if not project.get("ok"):
                raise RuntimeError(f"project creation failed: {project!r}")
            self.key = project["project"]["key"]
            self.name = name
        except BaseException:
            self.close()
            raise

    def _await(self, timeout=60):
        proc = self.proc
        if proc is None:
            raise RuntimeError("scratch server was never started")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"scratch server exited early with {proc.returncode}")
            try:
                with urllib.request.urlopen(  # noqa: S310
                        _require_http_scheme(self.base + "/api/v2/health"),
                        timeout=2):
                    return
            except (OSError, urllib.error.URLError):
                time.sleep(0.2)
        raise RuntimeError(f"scratch server never became reachable at {self.base}")

    def http(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(  # noqa: S310
            _require_http_scheme(self.base + path), data=data,
            method="POST" if data is not None else "GET",
            headers={"content-type": "application/json",
                     "accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            return json.loads(exc.read().decode())

    def install(self, project_dir):
        """Point a scratch project's own configuration at this board."""
        install_project(project_dir, self.base, self.key, self.name)

    def test_events(self, agent_id):
        """Every `test` event this agent filed, newest first, as the list
        endpoint answers them."""
        read = self.http(f"/api/v2/events?project={self.key}&limit=200")
        if not read.get("ok"):
            raise AssertionError(f"events read failed: {read!r}")
        return [e for e in (read.get("events") or [])
                if e.get("agentId") == agent_id and e.get("kind") == "test"]

    def event(self, event_id):
        """The one stored event, tree included."""
        read = self.http(f"/api/v2/events/{event_id}")
        if not read.get("ok"):
            raise AssertionError(f"event read failed: {read!r}")
        return read["event"]

    def close(self):
        proc, self.proc = self.proc, None
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        shutil.rmtree(self.tmpdir, ignore_errors=True)
