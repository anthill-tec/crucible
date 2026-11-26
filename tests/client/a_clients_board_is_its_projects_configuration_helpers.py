"""The plain helpers of `test_a_clients_board_is_its_projects_configuration.py`,
lifted out of that test module so a suite importing them does not import a test
module (CR-CRU-261).

Holds no `TestCase` and no test: the shared module's path, the configuration
file's name, the unreachable board, the recording live board, the scrubbed
subprocess drive, the argv builder, the scratch fleet and the failure summary.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import CLIENT_FILES
from tests.client.no_test_steers_a_client_by_a_retired_variable_helpers import RETIRED_VARIABLES
from tests.client import CLIENT_SOURCE_DIR, client_script

CLIENTS_DIR = CLIENT_SOURCE_DIR
AXI_MODULE_PATH = client_script("_crucible_axi.py")
CONFIG_NAME = "crucible.toml"


#: Nothing listens on port 1 without root, so a loopback call refuses instantly
#: rather than hanging (the census's own choice, same address).
UNREACHABLE_BOARD = "http://127.0.0.1:1"

AGENT = "cr139-c2-board-probe"

#: The verbs each drive family exercises. Chosen to cover both directions
#: across the shared transport rather than to enumerate the surface: a POST
#: write (`register`), its teardown (`unregister`), and the two read verbs that
#: GET a different collection each (`status` -> plans, `queue` -> the CR queue).
#: A base URL that resolved for one and not the other would be a per-verb
#: binding, which is exactly what §S2 forbids.


class _RecordingBoard:
    """A live board that ANSWERS like Crucible and records every request.

    Not a mock and not an unreachable port: the question each assertion asks is
    WHICH of several reachable boards a run landed on, and only a server that
    would have accepted the call can report that it never got one. Bound on
    port 0, so two or three of these coexist without assuming anything about
    the machine.
    """

    def __init__(self, label):
        self.label = label
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _record(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode() or "null")
                except ValueError:
                    body = None
                with board._lock:
                    board.requests.append((self.command, self.path, body))

            def _answer(self):
                encoded = json.dumps(_answer_for(self.path)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                self._record()
                self._answer()

            do_POST = do_GET
            do_PATCH = do_GET
            do_PUT = do_GET
            do_DELETE = do_GET

            def log_message(self, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                                      _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def mark(self):
        """The current request count -- the cursor a drive's slice starts at."""
        with self._lock:
            return len(self.requests)

    def since(self, mark):
        with self._lock:
            return list(self.requests[mark:])

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


def _answer_for(path):
    """A body plausible enough that no client crashes before it has finished
    the call. The assertions are about WHICH board was called, so the shapes are
    the minimum each read verb needs to reach its own envelope."""
    if path.endswith("/queue"):
        return {"ok": True, "entries": [], "tracks": []}
    if path.endswith("/plans"):
        return {"ok": True, "plans": []}
    if path.rstrip("/").endswith("/agents"):
        return {"ok": True, "agents": []}
    return {"ok": True, "changed": True,
            "run": {"total": 1, "passed": 1, "failed": 0, "pending": 0}}


def drive(script_path, argv, project_dir, fake_bin_dir, extra_env=None):
    """One genuine subprocess drive of a real client, with the four retired
    variables REMOVED from the inherited environment.

    The census's own `drive_verb` cannot be reused here: it EXPORTS
    `CRUCIBLE_URL`/`CRUCIBLE_BASE` to point every drive at an unreachable
    board, which is precisely the channel under test. Scrubbing rather than
    overwriting is what makes "with nothing exported" a fact about the drive
    instead of a claim in a docstring -- an ambient value in the orchestrator's
    own session would otherwise decide the outcome of this suite.
    """
    env = os.environ.copy()
    for name in RETIRED_VARIABLES:
        env.pop(name, None)
    env["ARDUINO_CLI"] = str(Path(fake_bin_dir) / "arduino-cli")
    env["PATH"] = str(fake_bin_dir) + os.pathsep + env.get("PATH", "")
    env["WORKFLOW_ROLE"] = ""
    env["WORKFLOW_WAVE"] = ""
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(
        [sys.executable, str(script_path)] + list(argv),
        cwd=str(project_dir), env=env, capture_output=True, text=True,
        timeout=60)
    exported = {name: env[name] for name in RETIRED_VARIABLES if name in env}
    return result, exported


def _argv_for(verb, project_dir):
    """The closest-to-normal-operation argv for `verb`: the project dir, plus
    every flag the fleet's own argparse makes REQUIRED (`--agent` on the write
    verbs, and `--role` on `register`). A missing required flag is refused by
    argparse before any verb function runs, which would make every board in
    this file correctly record nothing for a reason that has nothing to do with
    the criterion."""
    argv = [verb, "--project-dir", str(project_dir)]
    if verb in ("register", "unregister"):
        argv += ["--agent", AGENT]
    if verb == "register":
        argv += ["--role", "RED"]
    return argv


def _scratch_fleet(root):
    """The five clients plus the three modules and the package data they read,
    copied into `<root>/clients/` so `<root>` becomes the INSTALL dir the
    running module derives from its own location. The shared module reads its
    run pipeline (`_crucible_run.py`) by path from its own directory, so the
    run module travels with it.

    A module copied without its declarations can resolve nothing at all, which
    is why the shipped `crucible.toml` travels with it.
    """
    clients = Path(root) / "clients"
    clients.mkdir(parents=True)
    for name in ("_crucible_axi.py", "_crucible_run.py", "_crucible_release.py",
                 "_crucible_project.py", "_crucible_lint.py",
                 "_crucible_board.py", "_crucible_hermetic.py",
                 "_crucible_tripwire.py", "toon.py", CONFIG_NAME):
        shutil.copyfile(CLIENTS_DIR / name, clients / name)
    scripts = {}
    for client, script_path in CLIENT_FILES.items():
        target = clients / script_path.name
        shutil.copyfile(script_path, target)
        scripts[client] = target
    return scripts, clients / CONFIG_NAME, Path(root) / CONFIG_NAME


def _summarise(result):
    """The fragment of a failed drive worth putting in an assertion message:
    the exit code and the tail of each stream. A whole client envelope in a
    failure message buries the one line that explains it."""
    return (f"exit={result.returncode} stdout={result.stdout[-600:]!r} "
            f"stderr={result.stderr[-600:]!r}")
