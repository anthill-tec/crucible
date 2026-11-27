"""The fixtures the `lint` verb suites share: a recording double of the
board's compile route, a scratch copy of the client fleet that can only ever
reach that double, a fake linter that records what it was run with, a project
maker that writes a `[lint]` table, and one subprocess drive of a client verb.

Not a test module: it holds no `TestCase`.

THE BOARD DOUBLE answers the routes a `lint` drive uses:

- `POST /api/v2/runs/compile` -- the compile route a lint run is filed on. It
  answers as `handleCompileIngest` does for a lint post (`src/v2.ts`): `ok`,
  the stored `event`, and the decoded `errors` and `warnings` counts. A test
  scripts the counts it answers with (`answer_counts`) or a refusal
  (`refuse_compile`, e.g. 400 or 413). Unscripted, it refuses a lint post
  whose `runnerExit` is not a non-negative integer with the board's own 400
  (`refuseBadRunnerExit`), before anything is counted.
- the health routes -- the health a board that decodes the clients' reports
  answers (`live_run_harness.board_health`).
- `GET /api/v2/agents?...` -- an empty agent list, so the gated-run pre-flight
  finds nothing to warn about.
- every other read answers `ok` with nothing in it; every other write `ok`.

Every request is recorded in wire order with its parsed body.

THE FAKE LINTER is one python program written under any name (`ruff`,
`cargo`, `go`, `python`, ...). Each call appends one JSON line to the file
`$FAKE_LINT_LOG` names: the name it was called by, its argv, its working
directory and the `CARGO_BUILD_JOBS` it saw. What it prints and how it exits
come from a JSON script: `.fake-lint.json` in its working directory when one is
there, else the file `$FAKE_LINT_SCRIPT` names, else nothing and exit 0. A
script is `{"chunks": [["out"|"err", text], ...], "exit": n}`; each chunk is
written to its stream and flushed before the next, so a merged capture keeps
their order. A script with `"signal": n` kills the linter with that signal
once its chunks are written, as a linter the system stopped dies. As `go` it also answers the toolchain probes (`go env GOVERSION`,
`go version`) the go client makes.

No drive ever reaches the dev board (:3850), the production install (:3849)
or any port from 3800 to 3899: the double binds an ephemeral loopback port and
refuses one in that range, and the scratch fleet refuses to declare one.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from pathlib import Path

from tests.client.live_run_harness import HEALTH_PATHS, board_health
from tests.client.project_create_harness import (
    CLIENT_SCRIPTS,
    ScratchFleet,
    closed_port_url,
    decode_envelope,
)
from tests.client.client_fleet_envelope_census_helpers import (
    _build_fake_bin_dir,
    declare_and_require_board,
    install_project_limits,
)
from tests.client import TEST_INSTALL_CLIENTS

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = TEST_INSTALL_CLIENTS

#: The six clients with a `lint` verb, in a fixed order; each client's stack
#: is its key. eda is excluded: it has no `lint` verb, and its gate runs no
#: lint stage, so neither the lint verb's contract nor the lint-order one
#: applies to it yet.
CLIENTS = ("python", "bun", "rust", "mvn", "arduino", "go")

COMPILE_ROUTE = "/api/v2/runs/compile"

PROJECT_KEY = "4f1c2a9e-lint-verb-fixture-project"
PROJECT_NAME = "lint-verb-fixture-project"
AGENT = "lint-verb-fixture-agent"
CYCLE = 7

#: The event id the double answers a filed lint post with, unless scripted.
DEFAULT_EVENT = "evt-lint-fixture-0001"

#: The ports no drive may reach: the dev board, the production install and
#: every port beside them.
FORBIDDEN_PORTS = range(3800, 3900)

#: Environment a drive never inherits: the workflow lane, any project or agent
#: identity, the retired board channels, the project-dir overrides, the build
#: parallelism the rust default sets itself, and the fake linter's own script.
STRIPPED_ENV = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
                "CRUCIBLE_URL", "CRUCIBLE_BASE", "AGENT_ID", "AGENT",
                "PY_CRUCIBLE_PYTHON", "REPORTS_DIR", "COVERAGE_DIR",
                "PY_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                "BUN_CRUCIBLE_PACKAGE_DIR", "RUST_CRUCIBLE_PROJECT_DIR",
                "MVN_CRUCIBLE_PROJECT_DIR", "ARDUINO_CRUCIBLE_PROJECT_DIR",
                "GO_CRUCIBLE_PROJECT_DIR", "CARGO_BUILD_JOBS",
                "FAKE_LINT_LOG", "FAKE_LINT_SCRIPT")


# ── the board double ─────────────────────────────────────────────────────────

#: The board's refusal of a run ingest whose `runnerExit` is not an integer
#: at or above 0 (`refuseBadRunnerExit`, `src/v2.ts`).
BAD_RUNNER_EXIT = "runnerExit must be a non-negative integer — run NOT stored"


def _valid_runner_exit(body):
    """An absent `runnerExit`, or an integer (never a bool) at or above 0."""
    if "runnerExit" not in body:
        return True
    value = body["runnerExit"]
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


class LintBoard:
    """A recording double of the board's compile route and the reads a lint
    drive makes, on an ephemeral loopback port."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()
        double = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode()) if raw else None
                except ValueError:
                    body = {"<unparsed>": raw.decode(errors="replace")}
                with double.lock:
                    double.requests.append((self.command, self.path, body))
                    status, answer = double.route(self.command, self.path)
                encoded = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _serve

            def log_message(self, format, *args):  # noqa: A002 -- the base's own name
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        port = self._httpd.server_address[1]
        if port in FORBIDDEN_PORTS:
            self._httpd.server_close()
            raise RuntimeError(f"the double bound {port}, inside the board range")
        self.base_url = f"http://127.0.0.1:{port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def reset(self):
        with self.lock:
            self.requests = []
            self.counts = (0, 0)
            self.event = DEFAULT_EVENT
            self.refusal = None

    def answer_counts(self, errors, warnings, event=DEFAULT_EVENT):
        """Answer the next lint posts with these decoded counts and event."""
        with self.lock:
            self.counts = (errors, warnings)
            self.event = event

    def refuse_compile(self, status, error):
        """Answer every compile post with `status` and `error`."""
        with self.lock:
            self.refusal = (status, error)

    def route(self, method, path):
        split = urllib.parse.urlsplit(path)
        if method == "GET":
            if split.path in HEALTH_PATHS:
                return 200, board_health()
            if split.path.startswith("/api/v2/agents"):
                return 200, {"ok": True, "agents": []}
            if "/plans" in split.path:
                return 200, {"ok": True, "plans": []}
            return 200, {"ok": True}
        if split.path == COMPILE_ROUTE:
            if self.refusal is not None:
                status, error = self.refusal
                return status, {"ok": False, "error": error}
            body = self.requests[-1][2] if self.requests else None
            if (isinstance(body, dict) and "lint" in body
                    and not _valid_runner_exit(body)):
                return 400, {"ok": False, "error": BAD_RUNNER_EXIT}
            errors, warnings = self.counts
            verdict = (f"LINT FAILED — {errors} errors, {warnings} warnings"
                       if errors else f"LINT OK — {warnings} warnings")
            return 200, {"ok": True, "changed": True, "event": self.event,
                         "errors": errors, "warnings": warnings,
                         "verdict": verdict}
        return 200, {"ok": True, "changed": True}

    def writes(self):
        """Every request that was not a read, as `(method, path, body)`."""
        with self.lock:
            return [r for r in self.requests if r[0] != "GET"]

    def compile_posts(self):
        """The body of every POST to the compile route, in wire order."""
        with self.lock:
            return [body for method, path, body in self.requests
                    if method == "POST"
                    and urllib.parse.urlsplit(path).path == COMPILE_ROUTE]

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


# ── the fake linter ─────────────────────────────────────────────────────────

_FAKE_LINTER_BODY = r'''
import json
import os
import signal
import sys

argv = sys.argv[1:]
log = os.environ.get("FAKE_LINT_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "tool": os.path.basename(sys.argv[0]),
            "argv": argv,
            "cwd": os.getcwd(),
            "env": {"CARGO_BUILD_JOBS": os.environ.get("CARGO_BUILD_JOBS")},
        }) + "\n")
if os.path.basename(sys.argv[0]) == "go":
    if argv[:2] == ["env", "GOVERSION"]:
        print("go1.27.3")
        sys.exit(0)
    if argv[:1] == ["version"]:
        print("go version go1.27.3 linux/amd64")
        sys.exit(0)
local = os.path.join(os.getcwd(), ".fake-lint.json")
named = os.environ.get("FAKE_LINT_SCRIPT")
script = {"chunks": [], "exit": 0}
if os.path.isfile(local):
    with open(local, encoding="utf-8") as handle:
        script = json.load(handle)
elif named:
    with open(named, encoding="utf-8") as handle:
        script = json.load(handle)
for stream, text in script.get("chunks", []):
    target = sys.stdout if stream == "out" else sys.stderr
    target.write(text)
    target.flush()
if script.get("signal"):
    signal.signal(script["signal"], signal.SIG_DFL)
    os.kill(os.getpid(), script["signal"])
sys.exit(script.get("exit", 0))
'''


def write_fake_linter(directory, name):
    """Write the fake linter as `<directory>/<name>`, executable; returns its
    path."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(f"#!{sys.executable}\n{_FAKE_LINTER_BODY}", encoding="utf-8")
    path.chmod(0o755)
    return path


def write_script(path, chunks=(), exit_code=0, kill_signal=None):
    """Write a fake-linter script at `path`: `chunks` is a sequence of
    `(stream, text)` pairs, `stream` being `out` or `err`. With
    `kill_signal`, the linter kills itself with that signal after its chunks
    instead of exiting."""
    script = {"chunks": [list(c) for c in chunks], "exit": exit_code}
    if kill_signal is not None:
        script["signal"] = int(kill_signal)
    Path(path).write_text(json.dumps(script), encoding="utf-8")
    return Path(path)


def read_log(path):
    """Every call the fake linter recorded at `path`, in call order."""
    path = Path(path)
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


# ── the declaration ─────────────────────────────────────────────────────────

def lint_table(command, format=None, name=None):  # noqa: A002 -- the field's own name
    """A `[lint]` table as TOML text. Strings and lists are written as JSON,
    which is valid TOML for them."""
    lines = ["", "[lint]", f"command = {json.dumps(command)}"]
    if format is not None:
        lines.append(f"format = {json.dumps(format)}")
    if name is not None:
        lines.append(f"name = {json.dumps(name)}")
    return "\n".join(lines) + "\n"


def append_table(config_path, text):
    """Append `text` (one or more TOML tables) to the file at `config_path`."""
    path = Path(config_path)
    existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    path.write_text(existing.rstrip("\n") + "\n" + text, encoding="utf-8")
    return path


def make_project(board_url, table_text=None, with_config=True):
    """A temp project root: a `.env` naming the fixture project, and -- unless
    `with_config` is False -- its own `crucible.toml` (the shipped limits,
    `[client]` declaring `board_url`, then `table_text` appended)."""
    root = Path(tempfile.mkdtemp(prefix="lint-verb-project-"))
    (root / ".env").write_text(
        f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\nCRUCIBLE_PROJECT_NAME={PROJECT_NAME}\n",
        encoding="utf-8")
    if with_config:
        install_project_limits(root)
        declare_and_require_board(root, board_url, "a lint drive")
        if table_text:
            append_table(root / "crucible.toml", table_text)
    return root


def declared_source(project_root):
    """The `declared` value a project's own `crucible.toml` is named by."""
    return f"declared:{Path(project_root) / 'crucible.toml'}"


# ── the drive ───────────────────────────────────────────────────────────────

def drive(fleet, client, project_dir, *argv, verb="lint", bin_dirs=(),
          env=None, cwd=None):
    """One `<verb> --project-dir <project_dir> <argv...>` run of `client` from
    `fleet`, as a subprocess, with `bin_dirs` in front of PATH and `env`
    added. Returns `(CompletedProcess, axi)`, `axi` being `{}` when stdout
    holds no envelope."""
    command = [sys.executable, str(fleet.script(client)), verb,
               "--project-dir", str(project_dir), *argv]
    full_env = {k: v for k, v in os.environ.items() if k not in STRIPPED_ENV}
    full_env["PATH"] = os.pathsep.join(
        [str(d) for d in bin_dirs] + [full_env.get("PATH", "")])
    full_env.update(env or {})
    result = subprocess.run(
        command, cwd=str(cwd or tempfile.gettempdir()), env=full_env,
        capture_output=True, text=True, timeout=120, check=False)
    return result, decode_envelope(result.stdout) or {}


def warning_codes(axi):
    """The `code` of every structured warning an envelope carries."""
    return [w.get("code") for w in axi.get("warnings") or [] if isinstance(w, dict)]


class LintDriveMixin:
    """One board double and one scratch fleet per test class, the double's
    state cleared before each test, a scratch dir per test holding the fake
    linter's bin dir, its log and its script, and the census's fake
    toolchains behind them on PATH so no real `cargo`, `go`, `mvn`, `bun` or
    `arduino-cli` is ever run. Mixed into a `unittest.TestCase`."""

    board: LintBoard
    fleet: ScratchFleet

    @classmethod
    def setUpClass(cls):
        super().setUpClass()  # type: ignore[misc]
        cls.board = LintBoard()
        try:
            cls.fleet = ScratchFleet(cls.board.base_url)
        except BaseException:
            cls.board.close()
            raise
        cls.toolchain_bin = _build_fake_bin_dir()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.toolchain_bin, ignore_errors=True)
        cls.fleet.close()
        cls.board.close()
        super().tearDownClass()  # type: ignore[misc]

    def setUp(self):
        super().setUp()  # type: ignore[misc]
        self.board.reset()
        self.scratch = Path(tempfile.mkdtemp(prefix="lint-verb-scratch-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)  # type: ignore[attr-defined]
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        self.log = self.scratch / "lint-calls.jsonl"
        self.script = self.scratch / "lint-script.json"
        write_script(self.script)

    def project(self, table_text=None, with_config=True, board_url=None):
        root = make_project(board_url or self.board.base_url, table_text,
                            with_config)
        self.addCleanup(shutil.rmtree, root, True)  # type: ignore[attr-defined]
        return root

    def fake(self, name, directory=None):
        return write_fake_linter(directory or self.bin, name)

    def say(self, chunks=(), exit_code=0, kill_signal=None):
        """Script what the fake linter prints and how it exits (or, with
        `kill_signal`, the signal it dies by)."""
        write_script(self.script, chunks, exit_code, kill_signal)

    def calls(self, tool=None):
        return [c for c in read_log(self.log) if tool is None or c["tool"] == tool]

    def run_client(self, client, project_dir, *argv, verb="lint", env=None,
                   cwd=None):
        full_env = {"FAKE_LINT_LOG": str(self.log),
                    "FAKE_LINT_SCRIPT": str(self.script)}
        full_env.update(env or {})
        return drive(self.fleet, client, project_dir, *argv, verb=verb,
                     bin_dirs=(self.bin, self.toolchain_bin), env=full_env,
                     cwd=cwd or self.scratch)

    def filed(self, client, project_dir, *argv, **kwargs):
        """A drive with `--agent AGENT --cycle CYCLE`."""
        return self.run_client(client, project_dir, "--agent", AGENT,
                               "--cycle", str(CYCLE), *argv, **kwargs)

    def one_compile_post(self, result, axi):
        posts = self.board.compile_posts()
        self.assertEqual(  # type: ignore[attr-defined]
            len(posts), 1,
            f"exactly one post on the compile route; got {posts!r}\n"
            f"envelope={axi!r}\nstderr={result.stderr[-2000:]}")
        return posts[0]


__all__ = [
    "AGENT", "BAD_RUNNER_EXIT", "CLIENTS", "CLIENT_SCRIPTS", "COMPILE_ROUTE", "CYCLE",
    "DEFAULT_EVENT", "LintBoard", "LintDriveMixin", "PROJECT_KEY",
    "append_table", "closed_port_url", "declared_source", "drive",
    "lint_table", "make_project", "read_log", "warning_codes",
    "write_fake_linter", "write_script",
]
