"""The helpers of `test_regression_coverage_is_one_shared_opt_in_switch.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import http.server
import json
import threading
from tests.client.live_run_harness import START


class ActiveCycleBoard:
    """A loopback stand-in board that records EVERY request (GET and POST)
    and answers that the project has one active cycle while the agent asking
    is bound to none — the board state that makes an unbound run with no
    `--cycle` the unattributed-run refusal.

    `health`, when given, is answered whole on the health routes; without it
    they answer a bare `{ok: true}` like every other unscripted read."""

    ACTIVE_CYCLE_ID = 4242
    HEALTH_PATHS = ("/api/health", "/api/v2/health")

    def __init__(self, health=None):
        self.health = health
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _reply(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with board._lock:
                    board.requests.append(("GET", self.path))
                if board.health is not None and self.path in board.HEALTH_PATHS:
                    self._reply(board.health)
                elif "/plans" in self.path:
                    self._reply({"ok": True, "plans": [{
                        "id": 1, "status": "open",
                        "cycles": [{"id": board.ACTIVE_CYCLE_ID,
                                    "status": "active"}]}]})
                elif "/agents" in self.path:
                    self._reply({"ok": True, "agents": []})
                else:
                    self._reply({"ok": True})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                with board._lock:
                    board.requests.append(("POST", self.path))
                if self.path == START:
                    self._reply({"ok": True, "changed": True,
                                 "runId": "run-active-cycle-1"})
                else:
                    self._reply({"ok": True, "changed": True})

            def do_PATCH(self):
                self.do_POST()

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def seen(self):
        with self._lock:
            return list(self.requests)

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
