"""Fixtures for the `release-notes` suites: a real, throwaway board seeded
through its own routes, one project per scenario, the six clients driven as
genuine subprocesses, and a capturing proxy that records every request a
client makes (and can answer one chosen read with an error).

Not a test module: it holds no `TestCase`.

The board is `tests/client/real_board.py`'s `RealBoard` (a scratch `bun run
src/server.ts` on a free port over a `mkdtemp` store, never :3849/:3850). A
scenario's history is built the way the board really builds one:

- a release is PROPOSED (`…/release-proposals`), its CRs are DECLARED in it
  (`…/queue/plan`, which records each CR's queue title);
- a CR LANDS when a plan filed for it (`…/plans`, with or without a title) has
  its cycle sealed and is closed with a merge commit — the server stamps
  `closedAt` itself, so landing order is the order the closes are made;
- a release SHIPS through the python client's own `milestone --type release
  … --released-at <epoch> --crs <ids>`, the very path `scripts/release.sh`
  (`emit_release_milestone`) records a ship with.

Every project directory declares its board in its own `crucible.toml` and is
checked by `declare_and_require_board`, so no drive can resolve the shipped
default board.
"""

import contextlib
import datetime
import http.server as http_server
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import install_project, scrubbed_env
from tests.client.real_board import REPO_ROOT, RealBoard, _require_http_scheme  # noqa: F401 -- REPO_ROOT is re-exported to the release-notes modules
from tests.client.test_client_fleet_envelope_census import (
    declare_and_require_board,
)
from tests.client import TEST_INSTALL_CLIENTS

CLIENTS_DIR = TEST_INSTALL_CLIENTS
TOON_PATH = CLIENTS_DIR / "toon.py"
RELEASE_MODULE = CLIENTS_DIR / "_crucible_release.py"
CORE_MODULE = CLIENTS_DIR / "_crucible_axi.py"

VERB = "release-notes"

#: The six clients that reach the verb, keyed as the fleet keys them.
CLIENT_FILES = {
    "bun": "bun-crucible.py",
    "python": "python-crucible.py",
    "rust": "rust-crucible.py",
    "mvn": "mvn-crucible.py",
    "arduino": "arduino-crucible.py",
    "go": "go-crucible.py",
}

ORCHESTRATOR = "release-notes-fixture-orchestrator"

#: A commit-shaped id for every merge and every ship the fixtures record.
FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567"

#: The usage form a usage refusal names.
USAGE_FORM = "release-notes --release <label>"

#: The help a held label's refusal carries, verbatim.
HELD_LABEL_HELP = "queue --fields release,seq,points,dependsOn"

#: What the stub answers a failed read with: its own error, and its own help.
STUB_ERROR = "stub-board-refused-this-read"
STUB_HELP = "stub-board-help: retry the read once the board answers"

#: Environment keys a drive must never inherit from the developer's shell.
_EXTRA_SCRUB = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_AGENT",
                "WORKFLOW_RELEASE")

_RESERVED_PORTS = (3850, 3849, 39877)


# ── dates and the expected section ──────────────────────────────────────────

def utc_date(epoch_seconds):
    """The UTC calendar date of an epoch-seconds instant, `YYYY-MM-DD`."""
    return datetime.datetime.fromtimestamp(
        epoch_seconds, tz=datetime.timezone.utc).strftime("%Y-%m-%d")


def today_utc():
    """Today's UTC date, `YYYY-MM-DD`."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def utc_epoch(year, month, day, hour=0, minute=0):
    """Epoch seconds of a UTC wall-clock instant."""
    return int(datetime.datetime(year, month, day, hour, minute,
                                 tzinfo=datetime.timezone.utc).timestamp())


def expected_section(label, date, cr_lines):
    """The section exactly as the spec writes it, ending in one newline: the
    dated heading, then — only when there is a line — a blank line, the
    `### Changed` group, a blank line and one `- …` line per completed CR."""
    text = f"## [{label}] - {date}\n"
    if cr_lines:
        text += "\n### Changed\n\n" + "".join(f"{line}\n" for line in cr_lines)
    return text


# ── HTTP ────────────────────────────────────────────────────────────────────

def board_http(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310
        _require_http_scheme(base + path), data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json",
                 "accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _require(answer, what):
    if not isinstance(answer, dict) or not answer.get("ok"):
        raise RuntimeError(f"fixture: {what} failed: {answer!r}")
    return answer


# ── the board and its projects ──────────────────────────────────────────────

def start_board(name):
    """A real scratch board, or `None` when there is no `bun` to run one."""
    bun = shutil.which("bun")
    if bun is None:
        return None
    return RealBoard(bun, name)


class SeededProject:
    """One project on a real board, its orchestrator registered, and a
    project directory whose own configuration resolves that board."""

    def __init__(self, board, name):
        self.board = board
        self.base = board.base
        self.name = name
        created = _require(board.http("/api/v2/projects", {"name": name}),
                           f"creating project {name}")
        self.key = created["project"]["key"]
        _require(board_http(self.base, "/api/v2/agents/register",
                      {"projectKey": self.key, "agentId": ORCHESTRATOR,
                       "status": "online", "role": "ORCHESTRATOR",
                       "identity": {"displayName": ORCHESTRATOR,
                                    "source": "manual"}}),
                 f"registering the orchestrator on {name}")
        self.project_dir = self.dir_through(self.base)

    def dir_through(self, base):
        """A fresh project directory for this project whose configuration
        resolves `base` (the board itself, or a proxy in front of it)."""
        project_dir = tempfile.mkdtemp(prefix="release-notes-project-",
                                       dir=self.board.tmpdir)
        install_project(project_dir, base, self.key, self.name)
        declare_and_require_board(project_dir, base, "the release-notes fixture")
        return project_dir

    # -- the roadmap --------------------------------------------------------

    def propose(self, label):
        _require(board_http(self.base,
                      f"/api/v2/projects/{self.key}/release-proposals",
                      {"label": label, "agentId": ORCHESTRATOR,
                       "targetAt": utc_epoch(2027, 6, 1)}),
                 f"proposing {label}")

    def declare(self, cr, title, release, wave="1"):
        """Declare `cr` in `release` with its queue title."""
        _require(board_http(self.base, f"/api/v2/projects/{self.key}/queue/plan",
                      {"cr": cr, "title": title, "release": release,
                       "wave": wave, "agentId": ORCHESTRATOR}),
                 f"declaring {cr} in {release}")

    # -- landing ------------------------------------------------------------

    def land(self, cr, title=None, wave="1", merged=True):
        """File a plan for `cr` (titled when `title` is given), seal its one
        cycle and close it with a merge commit: the CR lands now.

        With `merged=False` the plan is closed WITHOUT a merge — the board's
        plan route takes `merge` as optional, so this is a close the board
        really records — and the CR does not land by it."""
        body = {"cr": cr, "wave": wave, "cycles": [{"label": "solo"}],
                "agentId": ORCHESTRATOR}
        if title is not None:
            body["title"] = title
        filed = _require(board_http(self.base, f"/api/v2/projects/{self.key}/plans",
                              body), f"filing a plan for {cr}")
        plan_id = filed["planId"]
        cycle_id = filed["cycles"][0]["id"]
        for status in ("active", "done"):
            _require(board_http(self.base,
                          f"/api/v2/projects/{self.key}/plans/{plan_id}"
                          f"/cycles/{cycle_id}",
                          {"status": status, "agentId": ORCHESTRATOR},
                          method="PATCH"),
                     f"moving {cr}'s cycle to {status}")
        close: dict[str, object] = {"status": "closed", "agentId": ORCHESTRATOR}
        if merged:
            close["merge"] = {"commit": FIXTURE_COMMIT}
        _require(board_http(self.base, f"/api/v2/projects/{self.key}/plans/{plan_id}",
                      close, method="PATCH"),
                 f"closing {cr}'s plan")
        return plan_id

    # -- shipping -----------------------------------------------------------

    def ship(self, label, released_at, crs=()):
        """Record the ship through the python client's `milestone` verb."""
        argv = [sys.executable, str(CLIENTS_DIR / "python-crucible.py"),
                "milestone", "--type", "release", "--label", label,
                "--commit", FIXTURE_COMMIT, "--agent", ORCHESTRATOR,
                "--released-at", str(released_at)]
        if crs:
            argv += ["--crs", ",".join(crs)]
        argv += ["--project-dir", self.project_dir]
        run = subprocess.run(argv, cwd=self.project_dir, env=drive_env(),
                             capture_output=True, text=True, timeout=120,
                             check=False)
        if run.returncode != 0:
            raise RuntimeError(
                f"fixture: shipping {label} failed: exit={run.returncode} "
                f"stdout={run.stdout!r} stderr={run.stderr!r}")

    # -- the board's own answers --------------------------------------------

    def history_row(self, label):
        """The board's own history row for `label`, or None."""
        answer = _require(board_http(self.base,
                               f"/api/v2/projects/{self.key}/history"),
                          "reading the history")
        for row in answer.get("releases") or []:
            if label in (row.get("labels") or []):
                return row
        return None

    def history_crs(self, label):
        """The CRs the board's history row for `label` counts completed, in
        the order the row lists them."""
        row = self.history_row(label) or {}
        return [cr for wave in row.get("waves") or []
                for cr in wave.get("crs") or []]

    def closed_at(self):
        """Every closed plan's `(cr, closedAt)`, as the board answers them."""
        answer = _require(
            board_http(self.base, f"/api/v2/projects/{self.key}/plans?status=closed"),
            "reading the closed plans")
        return [(plan.get("cr"), plan.get("closedAt"))
                for plan in answer.get("plans") or []]


def require_strictly_later(project, earlier_cr, later_cr):
    """Fixture sanity: `later_cr`'s latest close is strictly after
    `earlier_cr`'s latest close, as the board recorded them."""
    latest = {}
    for cr, at in project.closed_at():
        if at is not None:
            latest[cr] = max(at, latest.get(cr, at))
    if not latest.get(earlier_cr) or not latest.get(later_cr) \
            or latest[earlier_cr] >= latest[later_cr]:
        raise RuntimeError(
            f"fixture: {later_cr} must close strictly after {earlier_cr}; "
            f"the board recorded {latest!r}")


# ── driving a client ────────────────────────────────────────────────────────

def drive_env():
    env = scrubbed_env()
    for key in _EXTRA_SCRUB:
        env.pop(key, None)
    return env


def run_client(client, project_dir, *argv, verb=VERB):
    """Run `<client> <verb> <argv…> --project-dir <dir>` as the operator
    does: a genuine subprocess, from the project directory."""
    return subprocess.run(
        [sys.executable, str(CLIENTS_DIR / CLIENT_FILES[client]), verb,
         *argv, "--project-dir", project_dir],
        cwd=project_dir, env=drive_env(), capture_output=True, text=True,
        timeout=120, check=False)


def describe(run):
    return (f"exit={run.returncode}\n  stdout={run.stdout[:1500]!r}\n"
            f"  stderr={run.stderr[:1500]!r}")


_TOON = None


def toon():
    global _TOON
    if _TOON is None:
        spec = importlib.util.spec_from_file_location("release_notes_toon",
                                                      TOON_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load {TOON_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TOON = module
    return _TOON


def decode_toon_envelope(stdout):
    """The `axi` object of a TOON envelope, or None when stdout holds none."""
    if not stdout.strip():
        return None
    try:
        decoded = toon().decode(stdout)
    except Exception:  # not an envelope at all: the caller reports stdout
        return None
    axi = decoded.get("axi") if isinstance(decoded, dict) else None
    return axi if isinstance(axi, dict) else None


def decode_json_envelope(stdout):
    """The one JSON object `--format json` writes, or None."""
    try:
        parsed = json.loads(stdout)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def envelope_text(axi, exclude=("context", "verb")):
    """Every string an envelope carries outside `exclude`, joined, so wording
    is checked wherever the envelope states it."""
    parts = []

    def walk(value):
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for key, value in (axi or {}).items():
        if key not in exclude:
            walk(value)
    return "\n".join(parts)


def stderr_lines(run):
    return [line for line in run.stderr.splitlines() if line.strip()]


# ── the capturing proxy ─────────────────────────────────────────────────────

class CapturingProxy:
    """An HTTP proxy in front of a board: it records every request
    `(method, path-with-query)` in arrival order and relays it, except a read
    `fail_on` matches, which it answers 500 with the stub's own error and
    help instead of reaching the board."""

    def __init__(self, upstream, fail_on=None):
        self.upstream = upstream
        self.fail_on = fail_on
        self.requests = []
        self._lock = threading.Lock()
        proxy = self

        class Handler(http_server.BaseHTTPRequestHandler):
            def _relay(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else None
                with proxy._lock:
                    proxy.requests.append((self.command, self.path))
                if proxy.fail_on is not None and proxy.fail_on(self.command,
                                                               self.path):
                    status = 500
                    payload = json.dumps({"ok": False, "error": STUB_ERROR,
                                          "help": [STUB_HELP]}).encode()
                else:
                    request = urllib.request.Request(  # noqa: S310
                        _require_http_scheme(proxy.upstream + self.path),
                        data=body, method=self.command,
                        headers={"content-type": "application/json"})
                    try:
                        with urllib.request.urlopen(request, timeout=20) as answer:  # noqa: S310
                            status, payload = answer.status, answer.read()
                    except urllib.error.HTTPError as exc:
                        status, payload = exc.code, exc.read()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _relay

            def log_message(self, format, *args):  # noqa: A002 -- the base's own name
                return None

        for _ in range(20):
            server = http_server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            if server.server_address[1] not in _RESERVED_PORTS:
                break
            server.server_close()
        else:
            raise RuntimeError("no free proxy port outside the reserved ones")
        self.server = server
        self.base = f"http://127.0.0.1:{server.server_address[1]}"
        self.thread = threading.Thread(target=server.serve_forever, daemon=True)
        self.thread.start()

    def taken(self):
        """The requests recorded so far, and a fresh record from here on."""
        with self._lock:
            taken, self.requests = self.requests, []
        return taken

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)


def split_request(path):
    """`(route, query)` of a recorded request path."""
    parts = urllib.parse.urlsplit(path)
    return parts.path, urllib.parse.parse_qs(parts.query)


def read_name(project_key, method, path):
    """Which of the reads a recorded request is: `history`, `closed plans`,
    `queue`, `release proposals` — or None for any other request."""
    if method != "GET":
        return None
    route, query = split_request(path)
    prefix = f"/api/v2/projects/{project_key}"
    if route == f"{prefix}/history" and not query:
        return "history"
    if route == f"{prefix}/plans" and query == {"status": ["closed"]}:
        return "closed plans"
    if route == f"{prefix}/queue" and not query:
        return "queue"
    if route == f"{prefix}/release-proposals" and not query:
        return "release proposals"
    return None


def fail_read(project_key, name):
    """A `fail_on` predicate that fails exactly the read called `name`."""
    return lambda method, path: read_name(project_key, method, path) == name


def write_refused_limit(project_dir):
    """Declare an illegal `value` (below the shipped minimum) for one client
    limit in the project's own `crucible.toml`, so every envelope driven from
    it owes a `limit-configuration` disclosure."""
    config = Path(project_dir) / "crucible.toml"
    text = config.read_text(encoding="utf-8")
    config.write_text("[limits.truncate_field_chars]\nvalue = 1\n\n" + text
                      if "[limits.truncate_field_chars]" not in text
                      else text.replace("[limits.truncate_field_chars]",
                                        "[limits.truncate_field_chars]\nvalue = 1",
                                        1),
                      encoding="utf-8")


def close_quietly(*things):
    for thing in things:
        if thing is not None:
            # Teardown: never mask the test's own failure.
            with contextlib.suppress(Exception):
                thing.close()


def scratch_dir(prefix):
    return tempfile.mkdtemp(prefix=prefix)


def remove_dir(path):
    shutil.rmtree(path, ignore_errors=True)

