"""A project's own verbs the client fleet shares, and the project key and the
`.env` reader and writer beside them.

The `project-meta` verb reads and writes a project's metadata map. The
project key is derived from the project's token (`project_key_for_token`), and
`read_env_project_key` / `write_env_project_key` are the one reader and the
one writer of a project's `.env` key line.

No client loads this module. The core, `_crucible_axi.py`, loads it by file
path from its own directory, eagerly, under a name derived from its own
(`f"{__name__}_project"`), so each client's core instance gets a project
module of its own, and re-exports every name it defines: a client reaches
`_axi().cmd_project_meta` and `_axi().add_project_meta_args`. Once loaded,
the core binds `_core` to a live view of its own namespace, and every core
name this module uses (the status emitter, the server-failure readers, the
`--format` flag) is read through that view at call time, so a test that
patches a core name reaches the code here. A call between two functions of
this module resolves here.

It imports only the standard library.
"""

import argparse
import pathlib
import re
import typing
import uuid

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run. Every core
#: name is read through it at call time, never copied.
_core: typing.Any = None


# ── `project-meta`: a project's metadata map, read and written ──────────────

PROJECT_META_VERB = "project-meta"


def project_metadata_path(project_key):
    """`…/projects/<key>/metadata`, the one route the verb reads (GET)
    and writes (PATCH)."""
    return f"/api/v2/projects/{project_key}/metadata"


def parse_meta_set(raw):
    """The argparse `type=` for one `--set K=V` (PURE): split on the
    FIRST `=`, so a value may itself hold `=` and commas. A value with no `=`,
    or an empty key, is refused HERE — by argument parsing, before any request
    — rather than sent for the server to refuse."""
    key, sep, value = raw.partition("=")
    if not sep:
        raise argparse.ArgumentTypeError(
            f"--set {raw!r} has no '=': write it as KEY=VALUE")
    if not key:
        raise argparse.ArgumentTypeError(
            f"--set {raw!r} has an empty key before the '=': write it as KEY=VALUE")
    return key, value


def add_project_meta_args(parser):
    """The `--set`/`--unset`/`--format` flags of `project-meta`,
    registered here so the five clients cannot drift into five flag surfaces.
    Each client adds its own `--agent` and project-dir flags, as for every
    other verb."""
    parser.add_argument(
        "--set", dest="meta_set", action="append", type=parse_meta_set,
        default=None, metavar="KEY=VALUE",
        help="Set one key (split on the FIRST '='); repeatable. A write: "
             "requires --agent.")
    parser.add_argument(
        "--unset", dest="meta_unset", action="append", default=None,
        metavar="KEY",
        help="Remove one key; repeatable. A write: requires --agent.")
    _core.add_status_format_arg(parser)


def project_meta_refusal_fields(resp, base_url):
    """The result fields of a refused or failed `project-meta` request
    (PURE): the server's own `help[]` carried verbatim (whether the transport
    handed back the parsed body or flattened it into `error`), the server's
    error as the detail, and the reachability step when the call never
    landed."""
    resp = resp or {}
    parsed = _core.server_failure_body(resp) or {}
    steps = resp.get("help")
    if isinstance(steps, list) and steps:
        help_steps = [str(s) for s in steps]
    else:
        help_steps = (_core.server_failure_help(resp)
                      or [(f"check the Crucible server is running / reachable "
                           f"at {base_url}"), PROJECT_META_VERB])
    return {"error": parsed.get("error") or resp.get("error"),
            "help": help_steps}


def cmd_project_meta(args, project_dir, ops):
    """A project's metadata map (a copy of its .env facts).

    With no `--set`/`--unset` it READS: exactly one `GET …/metadata`, no
    `--agent`. With any, it WRITES: the identity is resolved FIRST (a hard stop
    precedes any request), then exactly one `PATCH …/metadata` carrying
    `{agentId, set, unset}`; the envelope adds the server's `changed`. Unlike
    `status`/`landings`, a refused or failed request never degrades: it is
    ok:false with the server's `help[]` and a non-zero exit. `--format` picks
    the encoding exactly as for `status`."""
    emit = _core._status_emitter(args, ops)
    pairs = getattr(args, "meta_set", None) or []
    unset = list(getattr(args, "meta_unset", None) or [])
    write = bool(pairs or unset)
    agent_id = ops.agent_id(args) if write else None
    path = project_metadata_path(ops.project_key(project_dir))
    if write:
        body = {"agentId": agent_id}
        if pairs:
            body["set"] = dict(pairs)
        if unset:
            body["unset"] = unset
        resp = ops.patch(path, body) or {}
    else:
        resp = ops.get(path) or {}
    context = ops.context(project_dir, agent_id=agent_id)
    if not resp.get("ok"):
        fields = project_meta_refusal_fields(resp, ops.base_url)
        emit(PROJECT_META_VERB, False, fields, context, [],
             f"project-meta: ok=False error={fields['error']}")
        return 1
    metadata = resp.get("metadata") or {}
    fields = {"metadata": metadata}
    if write:
        fields["changed"] = bool(resp.get("changed", False))
    fields["help"] = [PROJECT_META_VERB]
    emit(PROJECT_META_VERB, True, fields, context, [],
         f"project-meta: ok=True keys={len(metadata)}"
         + (f" changed={fields['changed']}" if write else ""))
    return 0


# ── The project key, and the `.env` reader and writer ───────────────────────

#: The fixed namespace a project's key is derived under. A constant, never
#: drawn at import, so a token gives the same key in every process.
PROJECT_KEY_NAMESPACE = uuid.UUID("5c7e2a91-3d4b-4f86-a0e2-9b1d6c8f4a37")

#: The `.env` variable a project's key is held in.
_ENV_KEY_NAME = "CRUCIBLE_PROJECT_KEY"


def project_key_for_token(token):
    """The project key a token names (PURE): the uuid5 of `token` under
    `PROJECT_KEY_NAMESPACE`, in its canonical text. Equal tokens give equal
    keys, so the board's own key idempotence returns the same project."""
    return str(uuid.uuid5(PROJECT_KEY_NAMESPACE, token))


def _env_path(root):
    return pathlib.Path(root) / ".env"


def _key_line_value(line):
    """The value of `line` when it is a key line, else None. `line` is one
    line's text, its `\\r` already dropped. A key line's stripped text does
    not start with `#`, and its text before the first `=`, stripped, is the
    key's name; its value is the text after that `=`, stripped."""
    if line.strip().startswith("#"):
        return None
    name, sep, value = line.partition("=")
    if not sep or name.strip() != _ENV_KEY_NAME:
        return None
    return value.strip()


def _last_key_line(lines):
    """The index and value of the last key line of `lines` (split on `\\n`,
    each possibly ending in `\\r`), or `(None, None)` when there is none."""
    found = (None, None)
    for index, line in enumerate(lines):
        value = _key_line_value(line.removesuffix("\r"))
        if value is not None:
            found = (index, value)
    return found


def read_env_project_key(root):
    """The project key `<root>/.env` holds, or None (no file, no key line, or
    an empty value). The last key line counts; quotes are kept. Reading never
    creates or changes the file."""
    path = _env_path(root)
    if not path.is_file():
        return None
    _index, value = _last_key_line(path.read_bytes().decode("utf-8").split("\n"))
    return value or None


def write_env_project_key(root, key):
    """Write `CRUCIBLE_PROJECT_KEY=<key>` into `<root>/.env`, keeping every
    other byte. Answers `"already-set"` (the file untouched) when the last key
    line holds a value, else `"written"`.

    The last key line, when its value is empty, is replaced whole and keeps
    its own line ending. With no key line the line is appended with the
    file's first line ending (`\\n` when it has none), after adding that
    ending when the file does not end in one. A missing `.env` is created
    holding the line and a `\\n`."""
    path = _env_path(root)
    line = f"{_ENV_KEY_NAME}={key}"
    if not path.is_file():
        path.write_bytes(f"{line}\n".encode())
        return "written"
    text = path.read_bytes().decode("utf-8")
    lines = text.split("\n")
    index, value = _last_key_line(lines)
    if value:
        return "already-set"
    if index is not None:
        carriage = "\r" if lines[index].endswith("\r") else ""
        lines[index] = line + carriage
        path.write_bytes("\n".join(lines).encode())
        return "written"
    first = text.find("\n")
    ending = "\r\n" if first > 0 and text[first - 1] == "\r" else "\n"
    if text and not text.endswith("\n"):
        text += ending
    path.write_bytes(f"{text}{line}{ending}".encode())
    return "written"

# ── `project-create`: a project registers itself on the board ───────────────

PROJECT_CREATE_VERB = "project-create"

PROJECT_KEY_UNKNOWN_CODE = "project-key-unknown"
PROJECT_KEY_ARCHIVED_CODE = "project-key-archived"
PROJECT_KEY_MALFORMED_CODE = "project-key-malformed"
PROJECT_ARCHIVED_CODE = "project-archived"
AGENT_ROLE_CONFLICT_CODE = "agent-role-conflict"

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_ACRONYM_RE = re.compile(r"[A-Z][A-Z0-9]*")
_META_KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*")
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
# pi-lens-ignore: S105 — a metadata key's name, not a secret
_TOKEN_META_KEY = "PROJECT_TOKEN"
_ACRONYM_META_KEY = "PROJECT_ACRONYM"
_ORCHESTRATOR = "ORCHESTRATOR"

#: The next move a refusal of the verb's own arguments names.
_USAGE_STEP = (f"{PROJECT_CREATE_VERB} --project-dir <root> --name <display name> "
               "--token <token> --agent <id>")

class _Stopped(Exception):
    """`project-create` stopped short: `code` names the refusal (None for a
    request the board refused or never answered), `detail` is the envelope's
    `error` and `help` its next steps."""

    def __init__(self, code, detail, help_steps):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.help = list(help_steps)

def add_project_create_args(parser):
    """The flags of `project-create`, registered here so the six clients
    cannot drift into six flag surfaces. `--agent` is not argparse-required:
    the fleet's identity hard stop answers its absence."""
    parser.add_argument(
        "--project-dir", dest="project_dir", required=True,
        help="The project's root: the directory whose .env holds (or will "
             "hold) its key. Required; never resolved from the cwd or git.")
    parser.add_argument("--name", help="The project's display name on the board.")
    parser.add_argument(
        "--token",
        help="The project's token (lowercase letters, digits and '-'); its "
             "key is derived from it, so a re-run finds the same project.")
    parser.add_argument(
        "--agent",
        help="Agent id — REQUIRED: registered as the project's ORCHESTRATOR "
             "to seed its metadata.")
    parser.add_argument(
        "--acronym", help="The project's acronym (uppercase), seeded as "
                          "PROJECT_ACRONYM.")
    parser.add_argument(
        "--type", dest="project_type", choices=("backend", "frontend"),
        default="backend", help="The project's type (default: backend).")
    parser.add_argument(
        "--set", dest="meta_set", action="append", type=parse_meta_set,
        default=None, metavar="KEY=VALUE",
        help="Seed one more metadata key (split on the FIRST '='); repeatable.")
    parser.add_argument(
        "--write-env", dest="write_env", action="store_true",
        help="Write the key into <root>/.env when its key line is empty or "
             "missing; a key already set is never replaced.")

def cmd_project_create(args, project_dir, ops):
    """Create this project on the board, or find it, by its token, then
    register `--agent` as its ORCHESTRATOR and seed its metadata.

    The order is fixed: the arguments and `.env` are refused before any
    request; a UUID key in `.env` is used when the board knows it, else the
    token's key is created (an archived one refused); the agent is registered
    unless it is on the project under another role or bound to a cycle; one
    metadata PATCH seeds the token, the acronym and each `--set`; and
    `--write-env` writes the key last. The key is never read through
    `ops.project_key` or `ops.context`, so no request carries an empty key.

    A refusal or a failure is `ok: false` with exit 1. One after the project
    is settled still carries its key and still honours `--write-env`, unless
    it is the role conflict, which writes nothing."""
    agent_id = ops.agent_id(args)
    root = str(project_dir)
    fields = {"projectKey": None, "created": False, "source": None,
              "name": None, "metadata": None, "envWritten": "not-asked"}
    try:
        key = _settle_project(args, root, ops, fields)
    except _Stopped as stop:
        return _emit_project_create(ops, fields, agent_id, stop)
    try:
        _seed_project(args, root, key, agent_id, ops, fields)
    except _Stopped as stop:
        if stop.code != AGENT_ROLE_CONFLICT_CODE:
            fields["envWritten"] = _env_written(args, root, key)
        return _emit_project_create(ops, fields, agent_id, stop)
    fields["envWritten"] = _env_written(args, root, key)
    return _emit_project_create(ops, fields, agent_id)

def _settle_project(args, root, ops, fields):
    """Refuse the arguments, then find the project by the `.env` key or
    create it by the token's. Answers the key; raises `_Stopped`."""
    _refuse_arguments(args, root)
    _core.bind_project_dir(root)
    env_key = read_env_project_key(root)
    if env_key is not None and not _UUID_RE.fullmatch(env_key):
        raise _Stopped(
            PROJECT_KEY_MALFORMED_CODE,
            f"{root}/.env holds CRUCIBLE_PROJECT_KEY={env_key}, which is not "
            "a UUID; project-create never replaces a key already set",
            [("write the project's UUID key into .env, or empty its "
              "CRUCIBLE_PROJECT_KEY line to create the token's project")])
    if env_key is not None:
        fields.update(projectKey=env_key, source="env")
        _find_by_env_key(env_key, ops)
        return env_key
    key = project_key_for_token(args.token)
    fields.update(projectKey=key, source="token")
    _create_by_token(args, root, key, ops, fields)
    return key

def _refuse_arguments(args, root):
    """The refusals that precede any request: the root, the name, the
    token, the acronym and each `--set` key."""
    acronym = args.acronym
    if not pathlib.Path(root).is_dir():
        _refuse_usage(f"--project-dir {root} is not a directory")
    if not args.name:
        _refuse_usage("--name is empty: the project needs a display name")
    if not _TOKEN_RE.fullmatch(args.token or ""):
        _refuse_usage(f"--token {args.token!r} is not lowercase letters, digits "
                      "and '-', starting with a letter or digit")
    if acronym is not None and not _ACRONYM_RE.fullmatch(acronym):
        _refuse_usage(f"--acronym {acronym!r} is not an uppercase letter "
                      "followed by uppercase letters or digits")
    for meta_key, value in args.meta_set or []:
        if not _META_KEY_RE.fullmatch(meta_key):
            _refuse_usage(f"--set key {meta_key!r} is not an environment-variable "
                          "name (uppercase letters, digits and '_')")
        if meta_key == _ENV_KEY_NAME:
            _refuse_usage(f"--set {_ENV_KEY_NAME} is refused: the key is the "
                          "board's, never seeded")
        if meta_key == _TOKEN_META_KEY and value != args.token:
            _refuse_usage(f"--set {_TOKEN_META_KEY}={value} differs from --token "
                          f"{args.token}")
        if (meta_key == _ACRONYM_META_KEY and acronym is not None
                and value != acronym):
            _refuse_usage(f"--set {_ACRONYM_META_KEY}={value} differs from "
                          f"--acronym {acronym}")

def _refuse_usage(detail):
    raise _Stopped(None, detail, [_USAGE_STEP])

def _find_by_env_key(key, ops):
    """The `.env` key's project, read by its metadata: known, or refused as
    unknown or archived."""
    resp = ops.get(project_metadata_path(key)) or {}
    if resp.get("ok"):
        return
    error = str((_core.server_failure_body(resp) or {}).get("error") or "")
    if error.startswith("unknown project:"):
        raise _Stopped(
            PROJECT_KEY_UNKNOWN_CODE,
            f"the board at {_core.resolve_base_url()} holds no project under "
            f"the key {key} that .env holds; project-create never replaces a "
            "key already set",
            [("write the key of a project the board holds into .env, or "
              "empty its CRUCIBLE_PROJECT_KEY line to create the token's "
              "project")])
    if error.startswith("project is archived:"):
        raise _Stopped(
            PROJECT_KEY_ARCHIVED_CODE,
            f"the project under the key {key} that .env holds is archived",
            _board_failure(resp).help)
    raise _board_failure(resp)

def _create_by_token(args, root, key, ops, fields):
    """Create the token's project, unless an archived project holds its key.
    `created` is the board's `changed`, and `name` its stored name."""
    listed = ops.get("/api/v2/projects?archived=true") or {}
    if not listed.get("ok"):
        raise _board_failure(listed)
    if any(p.get("key") == key for p in listed.get("projects") or []):
        raise _Stopped(
            PROJECT_ARCHIVED_CODE,
            f"the token's project, key {key}, is archived on the board",
            [(f"POST /api/v2/projects/{key}/unarchive — restore the project, "
              f"then re-run {PROJECT_CREATE_VERB}")])
    resp = ops.post("/api/v2/projects", {
        "key": key, "name": args.name, "type": args.project_type,
        "sutRoot": root}) or {}
    if not resp.get("ok"):
        raise _board_failure(resp)
    fields["created"] = bool(resp.get("changed"))
    fields["name"] = (resp.get("project") or {}).get("name")

def _seed_project(args, root, key, agent_id, ops, fields):
    """Register `agent_id` as the project's ORCHESTRATOR, unless it is there
    under another role or bound to a cycle, then send the one metadata
    PATCH. `metadata` is the board's map after it."""
    listed = ops.get(f"/api/v2/agents?project={key}") or {}
    if not listed.get("ok"):
        raise _board_failure(listed)
    for row in listed.get("agents") or []:
        if row.get("agentId") == agent_id:
            _refuse_role_conflict(agent_id, row)
    resp = ops.post("/api/v2/agents/register", {
        "agentId": agent_id, "projectKey": key, "status": "online",
        "message": "Registering the project", "role": _ORCHESTRATOR,
        "identity": {"displayName": agent_id, "source": "claude-md",
                     "repoPath": root}}) or {}
    if not resp.get("ok"):
        raise _board_failure(resp)
    seed = {_TOKEN_META_KEY: args.token}
    if args.acronym is not None:
        seed[_ACRONYM_META_KEY] = args.acronym
    seed.update(args.meta_set or [])
    resp = ops.patch(project_metadata_path(key),
                     {"agentId": agent_id, "set": seed}) or {}
    if not resp.get("ok"):
        raise _board_failure(resp)
    fields["metadata"] = resp.get("metadata") or {}

def _refuse_role_conflict(agent_id, row):
    """Refuse an agent already on the project under another role, or bound
    to a cycle, naming its role and its cycle."""
    role = row.get("role")
    cycle = row.get("boundCycleId")
    if role == _ORCHESTRATOR and cycle is None:
        return
    held = f"role {role}" if cycle is None else f"role {role}, bound to cycle {cycle}"
    raise _Stopped(
        AGENT_ROLE_CONFLICT_CODE,
        f"agent {agent_id} is already on this project under {held}; it is not "
        "re-registered as ORCHESTRATOR, and nothing is changed",
        [("re-run with an --agent that is not on the project, or with this "
          "agent once its registration has ended")])

def _board_failure(resp):
    """The `_Stopped` of a request the board refused or never answered: its
    own error and help, or the reachability step."""
    parsed = _core.server_failure_body(resp) or {}
    steps = resp.get("help")
    if isinstance(steps, list) and steps:
        help_steps = [str(s) for s in steps]
    else:
        help_steps = (_core.server_failure_help(resp)
                      or [(f"check the Crucible server is running / reachable "
                           f"at {_core.resolve_base_url()}"), PROJECT_CREATE_VERB])
    return _Stopped(None, parsed.get("error") or resp.get("error")
                    or "the board refused the request", help_steps)

def _env_written(args, root, key):
    """`--write-env`'s outcome: the writer's answer, or `not-asked`."""
    if not args.write_env:
        return "not-asked"
    return write_env_project_key(root, key)

def _emit_project_create(ops, fields, agent_id, stop=None):
    """Emit the verb's envelope and answer its exit code. The context is
    built from the key once one is known, and is empty before."""
    key = fields["projectKey"]
    context = _core.axi_context(key, agent_id=agent_id) if key else {}
    ok = stop is None
    result = dict(fields)
    warnings = []
    if stop is None:
        result["help"] = list(_core.HELP_STEPS[PROJECT_CREATE_VERB])
    else:
        result["error"] = stop.detail
        result["help"] = stop.help
        if stop.code:
            warnings.append({"code": stop.code, "detail": stop.detail})
    ops.emit(PROJECT_CREATE_VERB, ok, result, context, warnings,
             f"{PROJECT_CREATE_VERB}: ok={ok} key={key} created={fields['created']}")
    return 0 if ok else 1
