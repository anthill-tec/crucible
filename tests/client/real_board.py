"""A real, throwaway Crucible board for client end-to-end tests.

Boots `bun run src/server.ts` on an OS-assigned free port (never the live
3850/3849, never the installer probe's 39877) over a `mkdtemp` store, creates
one project over HTTP and reads the board's own answers back — the same idiom
`test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end.py`
uses, lifted so more than one suite can stand a board up without copying it.

Not a test module: it holds no `TestCase`. Every reader here compares the
board's stored run (its `summary` and `tree`) — the outcome a client run
actually filed.

A board built with `proxy=True` stands a `RecordingProxy` in front of
itself: the client is pointed at the proxy, which forwards every request to
the board and logs it. A `RecordingProxy` can also stand in front of any
board URL on its own.
"""

import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
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


# What `RecordingProxy`'s `intercept` hook returns to close the connection
# with no reply at all.
DROP = object()


class _ProxyServer(http.server.ThreadingHTTPServer):
    # A hook may stop the listener from a handler thread: the server must not
    # wait on that thread when it closes.
    daemon_threads = True
    block_on_close = False


class RecordingProxy:
    """A loopback HTTP proxy to `upstream` that forwards every request and
    logs it, in arrival order, as `{arrived, method, path, body}` (`body` the
    decoded JSON, or None), completed when it is answered with `status`, the
    decoded `answer` and `at`, the time the answer came back.

    Two optional hooks, set at construction or as attributes later:
    `intercept(method, path, body)` runs before forwarding (`body` the raw
    bytes, or None) and returns None to forward, `(status, payload bytes)` to
    answer instead, or `DROP` to close the connection with no reply;
    `after(method, path, status)` runs once a forwarded request is answered
    by the board, before the proxy relays it. `stop_listening()` closes the
    listener at once, so its address refuses every connection."""

    def __init__(self, upstream, intercept=None, after=None, timeout=60):
        self.upstream = upstream
        self.intercept = intercept
        self.after = after
        self.timeout = timeout
        self.records = []
        self._taken = 0
        self._lock = threading.Lock()
        self._stopped = threading.Event()
        proxy = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _relay(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else None
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                record = {"arrived": time.time(), "method": self.command,
                          "path": self.path, "body": body}
                with proxy._lock:
                    proxy.records.append(record)
                hook = proxy.intercept
                answered = hook(self.command, self.path, raw) if hook else None
                if answered is DROP:
                    self.close_connection = True
                    return
                if answered is None:
                    status, payload = proxy.forward(self.command, self.path, raw)
                    if proxy.after is not None:
                        proxy.after(self.command, self.path, status)
                else:
                    status, payload = answered
                try:
                    decoded = json.loads(payload)
                except ValueError:
                    decoded = None
                with proxy._lock:
                    record.update(at=time.time(), status=status, answer=decoded)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _relay

            def log_message(self, format, *args):  # noqa: A002 -- the base's own name
                return None

        for _ in range(20):
            server = _ProxyServer(("127.0.0.1", 0), _Handler)
            if server.server_address[1] not in _RESERVED_PORTS:
                break
            server.server_close()
        else:
            raise RuntimeError("no free proxy port outside the reserved ones")
        self._server = server
        self.url = f"http://127.0.0.1:{server.server_address[1]}"
        # The address a client is pointed at, under `RealBoard`'s name for it.
        self.base = self.url
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()

    def forward(self, method, path, body):
        """`(status, payload bytes)` of the board's answer to one request."""
        request = urllib.request.Request(  # noqa: S310 - scheme checked
            _require_http_scheme(self.upstream + path), data=body, method=method,
            headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as answer:  # noqa: S310
                return answer.status, answer.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    @property
    def requests(self):
        """Every request so far, `(method, path)`, in arrival order."""
        with self._lock:
            return [(r["method"], r["path"]) for r in self.records]

    def count(self):
        with self._lock:
            return len(self.records)

    def since(self, start):
        """The records from index `start` on."""
        with self._lock:
            return list(self.records[start:])

    def taken(self):
        """The requests `(method, path)` recorded since the last `taken()`,
        and a fresh record from here on."""
        with self._lock:
            taken = [(r["method"], r["path"]) for r in self.records[self._taken:]]
            self._taken = len(self.records)
        return taken

    def stop_listening(self):
        """Close the listener: safe from a handler thread, since the serving
        loop (on its own thread) is stopped first and the socket closed after
        it. Idempotent."""
        if self._stopped.is_set():
            return
        self._stopped.set()
        self._server.shutdown()
        self._server.server_close()

    def close(self):
        self.stop_listening()
        self._thread.join(timeout=10)


class RealBoard:
    """One scratch board process and the one project it holds. With `proxy`,
    a `RecordingProxy` in front of it (`self.proxy`), and `self.url`, where a
    client is pointed, is the proxy's address; otherwise it is `self.base`."""

    def __init__(self, bun, name, proxy=False):
        self.bun = bun
        self.tmpdir = tempfile.mkdtemp(prefix="real-board-")
        self.proc = None
        self.proxy = None
        port = _free_port()
        self.base = f"http://127.0.0.1:{port}"
        self.url = self.base
        Path(self.tmpdir, "crucible.toml").write_text(
            f'[server]\nhost = "127.0.0.1"\nport = {port}\n', encoding="utf-8")
        self.proc = subprocess.Popen(
            [bun, "run", "--no-env-file", "src/server.ts"], cwd=str(REPO_ROOT),
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
            if proxy:
                self.proxy = RecordingProxy(self.base)
                self.url = self.proxy.url
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
        """Point a scratch project's own configuration at this board (through
        its proxy, when it has one)."""
        install_project(project_dir, self.url, self.key, self.name)

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
        proxy, self.proxy = self.proxy, None
        if proxy is not None:
            proxy.close()
        proc, self.proc = self.proc, None
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        shutil.rmtree(self.tmpdir, ignore_errors=True)
