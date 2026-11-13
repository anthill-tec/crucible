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
