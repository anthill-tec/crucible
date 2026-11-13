"""The fixtures the `project-create` suites share: a recording double of the
board's project, agent and metadata routes, a scratch copy of the client
fleet that can only ever reach that double, and one subprocess drive of a
client's `project-create`.

Not a test module: it holds no `TestCase`.

THE BOARD DOUBLE answers each route the verb uses the way `src/v2.ts` does,
with the status codes and error texts read from that file:

- `POST /api/v2/projects` -- `handleProjectCreate`: a non-UUID `key` is
  400 "key must be a UUID"; a key the board holds (archived or not) is
  200 `{ok, changed: false, project}`; an empty `name` is 400
  "name is required"; otherwise 200 `{ok, changed: true, project}`.
- `GET /api/v2/projects[?archived=true]` -- `handleProjectsList`: the
  archived projects only with `archived=true`, else the live ones.
- `GET /api/v2/agents[?project=<key>]` -- `handleAgentsList`: the rows, of
  one project when `project` is given.
- `POST /api/v2/agents/register` -- `handleAgentTouch`: `requireProject`
  first (400 "projectKey must be a UUID", 404 "unknown project: <key>",
  404 "project is archived: <key>", each with its `help`), then 400
  "agentId is required", then the role rule, then an upsert that keeps a
  stored cycle binding the body does not name.
- `POST /api/v2/agents/unregister` -- recorded and answered `{ok}`; the verb
  must never send it.
- `GET|PATCH /api/v2/projects/<key>/metadata` -- `handleProjectMetadataGet`
  and `handleProjectMetadataPatch`: `requireProject`, then (PATCH) the
  `requireOrchestrator` 409s ("agent <id> is not registered with this
  project — refused", "agent <id> carries role <r> — a project metadata
  write requires ORCHESTRATOR"), then the merge.

Any route may be scripted to refuse instead (`refuse(route, status, body)`).

THE SCRATCH FLEET is a copy of `clients/` whose own `crucible.toml`, and the
install's beside it, declare the double. A client run from it resolves the
double whether or not the verb binds `--project-dir`, so no drive here can
reach the checkout's board or the shipped default (the production install).
"""

import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import uuid
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    declare_and_require_board,
    declare_board,
    install_project_limits,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TOON_PATH = CLIENTS_DIR / "toon.py"
PROJECT_MODULE_PATH = CLIENTS_DIR / "_crucible_project.py"

CLIENT_SCRIPTS = {
    "python": "python-crucible.py",
    "bun": "bun-crucible.py",
    "rust": "rust-crucible.py",
    "mvn": "mvn-crucible.py",
    "arduino": "arduino-crucible.py",
    "go": "go-crucible.py",
}

VERB = "project-create"

#: The verb's help line, as the spec gives it.
PROJECT_CREATE_HELP = ("Create this project on the board, or find it, by its "
                       "token; print its key (`--write-env` writes it to .env).")

#: The envelope's `help` on every outcome the spec states it for.
ENVELOPE_HELP = ["register --agent <id> --role ORCHESTRATOR", "project-meta"]

#: The fields every `project-create` envelope carries beside the fleet's own.
ENVELOPE_FIELDS = ("projectKey", "created", "source", "name", "metadata",
                   "envWritten", "help")

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

# `src/hints.ts` -- the `help` the board attaches to `requireProject`'s refusals.
UNKNOWN_PROJECT_HELP = [
    "GET /api/v2/projects — list registered projects and their keys",
    "POST /api/v2/projects {name} — register a new project (key auto-generated)",
]
ARCHIVED_PROJECT_HELP = [
    "this project is archived — agent calls are rejected and never resurrect it",
    "POST /api/v2/projects/<key>/unarchive — explicitly restore the project first",
    "GET /api/v2/projects?archived=true — list archived projects",
]
REGISTERED_HELP = [
    "POST /api/v2/runs {projectKey, agentId, codec, data} — ingest a test run",
    "GET /api/v2/agents?project=<key> — list agents with computed liveness",
]

_AGENT_ROLES = ("RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report")
_METADATA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

#: Environment a drive never inherits: the workflow lane, any project or agent
#: identity, and the retired board channels.
_STRIPPED_ENV = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                 "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
                 "CRUCIBLE_URL", "CRUCIBLE_BASE", "AGENT_ID",
                 "PY_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                 "RUST_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_PROJECT_DIR",
                 "ARDUINO_CRUCIBLE_PROJECT_DIR", "GO_CRUCIBLE_PROJECT_DIR")


def is_uuid(value):
    return isinstance(value, str) and bool(_UUID_RE.match(value))


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_TOON = None


def decode_envelope(stdout_text):
    """The `axi` object a drive printed, or None when stdout holds none."""
    global _TOON
    if _TOON is None:
        _TOON = load_module(TOON_PATH, "project_create_toon")
    text = (stdout_text or "").strip()
    if not text:
        return None
    try:
        decoded = _TOON.decode(text)
    except Exception:  # noqa: BLE001 -- an undecodable stdout is "no envelope"
        return None
    if not isinstance(decoded, dict) or not isinstance(decoded.get("axi"), dict):
        return None
    return decoded["axi"]


def key_for_token(token):
    """The key the spec derives from `token`, computed by the module's own
    public function (the one use the suites make of it)."""
    module = load_module(PROJECT_MODULE_PATH, "project_create_key_oracle")
    return module.project_key_for_token(token)


def closed_port_url():
    """A loopback address nothing listens on: bound, read and released."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"http://127.0.0.1:{port}"


class BoardDouble:
    """A recording, scriptable double of the board's project-create routes."""

    def __init__(self):
        self.reset()
        double = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _answer(self, status, body):
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode()) if raw else None
                except ValueError:
                    body = {"<unparsed>": raw.decode(errors="replace")}
                with double.lock:
                    double.requests.append((self.command, self.path, body))
                    status, answer = double.route(self.command, self.path, body)
                self._answer(status, answer)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _serve

            def log_message(self, format, *args):  # noqa: A002 -- the base's own name
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    # ── state ────────────────────────────────────────────────────────────

    def reset(self):
        self.lock = getattr(self, "lock", None) or threading.Lock()
        self.requests = []
        self.projects = {}
        self.agents = []
        self.refusals = {}

    def add_project(self, key, name="existing", archived=False, metadata=None,
                    type_="backend", sut_root=""):
        self.projects[key] = {"key": key, "name": name, "type": type_,
                              "sutRoot": sut_root, "archived": archived,
                              "metadata": dict(metadata or {})}

    def add_agent(self, project_key, agent_id, role, bound_cycle_id=None):
        row = {"agentId": agent_id, "projectKey": project_key,
               "status": "online", "message": "", "role": role,
               "identity": {"displayName": agent_id, "source": "manual"},
               "firstSeen": 1, "lastSeen": 1, "liveness": "online"}
        if bound_cycle_id is not None:
            row["boundCycleId"] = bound_cycle_id
        self.agents.append(row)
        return row

    def refuse(self, route, status, body):
        """Script `route` ("create", "register" or "patch") to answer
        `status`/`body` instead of the board's own logic."""
        self.refusals[route] = (status, body)

    # ── what the drive sent ──────────────────────────────────────────────

    def sent(self, method, path_prefix=None, path=None):
        return [r for r in self.requests
                if r[0] == method
                and (path is None or r[1] == path)
                and (path_prefix is None or r[1].startswith(path_prefix))]

    def creates(self):
        return self.sent("POST", path="/api/v2/projects")

    def registers(self):
        return self.sent("POST", path="/api/v2/agents/register")

    def unregisters(self):
        return self.sent("POST", path="/api/v2/agents/unregister")

    def patches(self):
        return [r for r in self.requests
                if r[0] == "PATCH" and r[1].endswith("/metadata")]

    def writes(self):
        return [r for r in self.requests if r[0] != "GET"]

    def project_rows(self, key):
        return [p for p in self.projects.values() if p["key"] == key]

    # ── the routes ───────────────────────────────────────────────────────

    @staticmethod
    def _project_view(project):
        return {k: v for k, v in project.items() if k not in ("archived", "metadata")}

    def _require_project(self, key):
        if not is_uuid(key):
            return (400, {"ok": False, "error": "projectKey must be a UUID",
                          "help": list(UNKNOWN_PROJECT_HELP)})
        project = self.projects.get(key)
        if project is None:
            return (404, {"ok": False, "error": f"unknown project: {key}",
                          "help": list(UNKNOWN_PROJECT_HELP)})
        if project["archived"]:
            return (404, {"ok": False, "error": f"project is archived: {key}",
                          "help": list(ARCHIVED_PROJECT_HELP)})
        return None

    def route(self, method, raw_path, body):
        parsed = urllib.parse.urlsplit(raw_path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        segments = [s for s in path.split("/") if s]
        if method == "POST" and path == "/api/v2/projects":
            return self._create(body)
        if method == "GET" and path == "/api/v2/projects":
            archived = query.get("archived", [""])[0] == "true"
            return (200, {"ok": True, "projects": [
                self._project_view(p) for p in self.projects.values()
                if p["archived"] == archived]})
        if method == "GET" and path == "/api/v2/agents":
            project = query.get("project", [None])[0]
            return (200, {"ok": True, "agents": [
                dict(a) for a in self.agents
                if project is None or a["projectKey"] == project]})
        if method == "POST" and path == "/api/v2/agents/register":
            return self._register(body)
        if method == "POST" and path == "/api/v2/agents/unregister":
            return (200, {"ok": True, "changed": True})
        if (len(segments) == 5 and segments[:3] == ["api", "v2", "projects"]
                and segments[4] == "metadata"):
            if method == "GET":
                refused = self._require_project(segments[3])
                if refused:
                    return refused
                return (200, {"ok": True,
                              "metadata": dict(self.projects[segments[3]]["metadata"])})
            if method == "PATCH":
                return self._patch(segments[3], body)
        return (404, {"ok": False, "error": f"no route for {method} {path}"})

    def _create(self, body):
        if "create" in self.refusals:
            return self.refusals["create"]
        if not isinstance(body, dict):
            return (400, {"ok": False, "error": "malformed JSON body"})
        key = body.get("key")
        if key is not None:
            if not is_uuid(key):
                return (400, {"ok": False, "error": "key must be a UUID"})
            if key in self.projects:
                return (200, {"ok": True, "changed": False,
                              "project": self._project_view(self.projects[key])})
        else:
            key = str(uuid.uuid4())
        name = body.get("name")
        if not isinstance(name, str) or not name:
            return (400, {"ok": False, "error": "name is required"})
        type_ = "frontend" if body.get("type") == "frontend" else "backend"
        sut_root = body.get("sutRoot")
        if not isinstance(sut_root, str):
            sut_root = ""
        self.add_project(key, name=name, type_=type_, sut_root=sut_root)
        return (200, {"ok": True, "changed": True,
                      "project": self._project_view(self.projects[key])})

    def _register(self, body):
        if "register" in self.refusals:
            return self.refusals["register"]
        if not isinstance(body, dict):
            return (400, {"ok": False, "error": "malformed JSON body"})
        refused = self._require_project(body.get("projectKey"))
        if refused:
            return refused
        agent_id = body.get("agentId")
        if not isinstance(agent_id, str) or not agent_id:
            return (400, {"ok": False, "error": "agentId is required"})
        role = body.get("role")
        if role not in _AGENT_ROLES:
            return (400, {"ok": False, "error": (
                "role is required and must be one of RED | GREEN | FIX | "
                f"VERIFY | ORCHESTRATOR | report (got {json.dumps(role)})")})
        if role in ("RED", "GREEN", "FIX", "VERIFY") and body.get("cycleId") is None:
            return (409, {"ok": False, "error": (
                f"role {role} requires a cycle binding — register with "
                "--cycle <cycleId>")})
        key = body["projectKey"]
        existing = [a for a in self.agents
                    if a["projectKey"] == key and a["agentId"] == agent_id]
        if existing:
            row = existing[0]
            row["role"] = role
            if body.get("cycleId") is not None:
                row["boundCycleId"] = body["cycleId"]
            changed = False
        else:
            row = self.add_agent(key, agent_id, role, body.get("cycleId"))
            changed = True
        if isinstance(body.get("identity"), dict):
            row["identity"] = dict(body["identity"])
        return (200, {"ok": True, "changed": changed, "help": list(REGISTERED_HELP)})

    def _patch(self, key, body):
        refused = self._require_project(key)
        if refused:
            return refused
        if "patch" in self.refusals:
            return self.refusals["patch"]
        if not isinstance(body, dict):
            return (400, {"ok": False, "error": "malformed JSON body"})
        agent_id = body.get("agentId")
        rows = [a for a in self.agents
                if a["projectKey"] == key and a["agentId"] == agent_id]
        if not rows:
            return (409, {"ok": False, "error": (
                f"agent {agent_id} is not registered with this project — refused")})
        role = rows[0].get("role")
        if role != "ORCHESTRATOR":
            return (409, {"ok": False, "error": (
                f"agent {agent_id} carries role {role} — a project metadata "
                "write requires ORCHESTRATOR")})
        set_ = body.get("set") or {}
        for meta_key in set_:
            if not _METADATA_KEY_RE.match(meta_key):
                return (400, {"ok": False, "error": (
                    f"set key {json.dumps(meta_key)} is not an "
                    "environment-variable name")})
        metadata = self.projects[key]["metadata"]
        before = dict(metadata)
        metadata.update(set_)
        for meta_key in body.get("unset") or []:
            metadata.pop(meta_key, None)
        return (200, {"ok": True, "metadata": dict(metadata),
                      "changed": metadata != before})

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


#: The ports of the checkout's dev board and the shipped default (the
#: production install). No scratch fleet ever declares either.
PRODUCTION_BOARD_PORTS = (3849, 3850)


def _refuse_production_board(url):
    if urllib.parse.urlsplit(url).port in PRODUCTION_BOARD_PORTS:
        raise RuntimeError(
            f"refusing a scratch fleet that declares {url!r}: that is the dev "
            "board or the production install")


class ScratchFleet:
    """A copy of `clients/` whose own and install configuration both declare
    `board_url`, checked in process before any drive.

    With `install_board_url` (a dead loopback port), the fleet's own and
    install configuration declare THAT instead, so only a project dir's own
    `crucible.toml` can lead a drive to the double at `board_url`. Neither
    address may be the dev board's or the production install's."""

    def __init__(self, board_url, install_board_url=None):
        self.board_url = board_url
        self.fleet_board_url = install_board_url or board_url
        _refuse_production_board(board_url)
        _refuse_production_board(self.fleet_board_url)
        self.root = Path(tempfile.mkdtemp(prefix="project-create-fleet-"))
        self.clients = self.root / "clients"
        shutil.copytree(CLIENTS_DIR, self.clients,
                        ignore=shutil.ignore_patterns("__pycache__"))
        declare_board(self.clients / "crucible.toml", self.fleet_board_url)
        declare_board(self.root / "crucible.toml", self.fleet_board_url)
        resolved = self.resolves(None)
        if resolved != self.fleet_board_url:
            self.close()
            raise RuntimeError(
                f"the scratch fleet resolves {resolved!r}, not the declared "
                f"{self.fleet_board_url!r}; refusing to drive a client that "
                "would post elsewhere")

    def resolves(self, project_dir):
        """The board this fleet's own shared module resolves with
        `project_dir` bound (None: no project dir), asked in process."""
        axi = load_module(self.clients / "_crucible_axi.py",
                          f"project_create_fleet_{id(self)}")
        axi.bind_project_dir(None if project_dir is None else str(project_dir))
        try:
            return axi.resolve_base_url()
        finally:
            axi.bind_project_dir(None)

    def script(self, client="python"):
        return self.clients / CLIENT_SCRIPTS[client]

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


def make_project_dir(board_url, env_bytes=None):
    """A temp project root holding the project's `crucible.toml` (declaring
    `board_url`) and, when `env_bytes` is given, a `.env` of exactly those
    bytes."""
    root = Path(tempfile.mkdtemp(prefix="project-create-root-"))
    install_project_limits(root)
    declare_and_require_board(root, board_url, "project-create")
    if env_bytes is not None:
        (root / ".env").write_bytes(env_bytes)
    return root


def drive(fleet, project_dir, *extra, client="python", agent="orch-1",
          name="Widget Works", token="widget-works",  # noqa: S107 -- a project token, not a secret
          project_dir_arg=None,
          cwd=None, with_project_dir=True):
    """One `project-create` run of `client` from `fleet`, as a subprocess.

    `extra` is appended after the standard flags. `agent=None` omits
    `--agent`; `name`/`token` of None omit those flags. Returns
    `(CompletedProcess, axi)`, `axi` being `{}` when stdout holds no
    envelope."""
    argv = [sys.executable, str(fleet.script(client)), VERB]
    if with_project_dir:
        argv += ["--project-dir",
                 str(project_dir if project_dir_arg is None else project_dir_arg)]
    if name is not None:
        argv += ["--name", name]
    if token is not None:
        # One argv item, so a token that begins with '-' reaches the verb.
        argv += [f"--token={token}"]
    if agent is not None:
        argv += ["--agent", agent]
    argv += list(extra)
    env = {k: v for k, v in os.environ.items() if k not in _STRIPPED_ENV}
    result = subprocess.run(
        argv, cwd=str(cwd or Path(project_dir).parent), env=env,
        capture_output=True, text=True, timeout=120)
    axi: dict = decode_envelope(result.stdout) or {}
    return result, axi


class BoardDoubleMixin:
    """One board double and one scratch fleet per test class, the double's
    state cleared before each test, and a temp project root per call of
    `project_root`. Mixed into a `unittest.TestCase`."""

    board: BoardDouble
    fleet: ScratchFleet

    @classmethod
    def setUpClass(cls):
        super().setUpClass()  # type: ignore[misc]
        cls.board = BoardDouble()
        try:
            cls.fleet = ScratchFleet(cls.board.base_url)
        except BaseException:
            cls.board.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.fleet.close()
        cls.board.close()
        super().tearDownClass()  # type: ignore[misc]

    def setUp(self):
        super().setUp()  # type: ignore[misc]
        self.board.reset()

    def project_root(self, env_bytes=None):
        root = make_project_dir(self.board.base_url, env_bytes)
        self.addCleanup(shutil.rmtree, root, True)  # type: ignore[attr-defined]
        return root

    def run_verb(self, root, *extra, **kwargs):
        return drive(self.fleet, root, *extra, **kwargs)


def names_code(axi, code):
    """Whether the envelope names the refusal `code`, in its `error` or as a
    warning's `code`."""
    if not isinstance(axi, dict):
        return False
    if code in str(axi.get("error") or ""):
        return True
    return any(isinstance(w, dict) and w.get("code") == code
               for w in axi.get("warnings") or [])


def key_bearing_values(method, raw_path, body):
    """Every project key a request carries: the `<key>` of a
    `/api/v2/projects/<key>/…` path, a `project=` query value, and a body's
    `key` / `projectKey`. A value present but empty is returned as ''."""
    found = []
    parsed = urllib.parse.urlsplit(raw_path)
    segments = parsed.path.split("/")
    if (len(segments) > 4 and segments[1:4] == ["api", "v2", "projects"]):
        found.append(("path", segments[4]))
    for value in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get(
            "project", []):
        found.append(("query", value))
    if isinstance(body, dict):
        for field in ("key", "projectKey"):
            if field in body:
                found.append((f"body.{field}", body[field]))
    return found


def empty_or_malformed_keys(requests):
    """The (request, where, value) of every key that is empty or not a UUID."""
    bad = []
    for method, path, body in requests:
        for where, value in key_bearing_values(method, path, body):
            if not is_uuid(value):
                bad.append(((method, path), where, value))
    return bad
