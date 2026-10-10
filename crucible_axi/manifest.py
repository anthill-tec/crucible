"""CR-CRU-009 §S2 — the discovery manifest (`crucible-clients.json`).

The manifest is the Model-B pre-flight contract: a stable-schema JSON document
mapping each of the five client stacks to its installed `*-crucible.py` path,
carrying a version and the STATUS-CONTRACT reference. `write_manifest` OVERWRITES
(never appends) so re-running install converges on a single document, and
`run_manifest_stage` reports `converged` when the on-disk JSON already
byte-matches what a fresh build would write.

CR-CRU-090 §S2 also makes this module the home of `source_clients_dir()` — THE
single resolver for the SOURCE client-fleet directory, which both
`crucible_axi/cli.py` (loading the shared envelope/codec by path) and
`install.run_fleet_stage` (copying the packaged fleet files) call. It lives HERE
because `cli` imports `install`, so `install` importing `cli` back would be
circular; `manifest` is imported by both, so neither has to import the other.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

# The five client stacks that ship a `*-crucible.py` client — exactly these,
# no extras (a clientless stack such as vscode must NOT appear here).
CLIENT_STACKS = ("bun", "python", "rust", "mvn", "arduino")

MANIFEST_FILENAME = "crucible-clients.json"

# CR-CRU-139 §S1a — where the install RECORDS what it wrote into each
# operator-editable file it authored. INTERNAL state, deliberately not a key in
# `crucible-clients.json`: that document is the published consumer contract
# (its top-level key set is pinned as an exact set), and a record of our own
# bytes is not something any consumer of it should read. Hidden, JSON, and
# removed by the same `--purge` that removes the files it describes.
INSTALL_RECORD_FILENAME = ".crucible-install-record.json"

# The record's one top-level key: `{"authored": {<abs path>: <sha256 hex>}}`.
RECORD_AUTHORED_KEY = "authored"

# CR-CRU-131 §S1c — the operator-editable configuration the installer LAYS DOWN
# at `<target-dir>`, beside the manifest that declares it.
#
# It is a byte copy of the client fleet's OWN shipped `crucible.toml` (package
# data beside the fleet, `source_clients_dir()`), so the file an operator edits
# and the declarations the fleet falls back to are ONE datum rather than a
# template that can drift from the numbers the code actually uses. It arrives
# commented, carrying each limit's description, recommendation and supportable
# range: an install that only ships defaults gives the operator nothing to
# edit, and a checkout-only file gives an installed deployment nothing to read.
CONFIG_FILENAME = "crucible.toml"

# CR-CRU-139 §S1a — the TOML vocabulary of the two configuration files this
# module lays down, declared ONCE. `install` READS the server's declarations
# (the listener and the range it may be probed out of) and this module WRITES
# the resolved answer back into the files it wrote; a table or key name spelled
# in both modules is one rename away from an installer that reads `[server]`
# and writes `[servers]` with nothing saying so.
SERVER_TABLE = "server"
SERVER_HOST_KEY = "host"
SERVER_PORT_KEY = "port"
SERVER_PORT_RANGE_MIN_KEY = "port_range_min"
SERVER_PORT_RANGE_MAX_KEY = "port_range_max"
CLIENT_TABLE = "client"
CLIENT_URL_KEY = "url"

# The commented block the `[client]` table arrives as when the install writes
# the board URL into a file whose template does not declare one. The operator's
# file is DOCUMENTATION as much as it is configuration (the whole reason the
# shipped templates are commented), so a table appended to it carries its own
# sentence rather than landing as a bare key nobody can interpret.
_CLIENT_TABLE_BLOCK = """
# ── The BOARD this project reports to (CR-CRU-139 §S1a) ─────────────────
#
# The installer wrote this URL from the port it PROBED for the server it
# provisioned here, so the board this machine's clients post to and the port
# that machine's server listens on are one decision recorded twice. Edit it to
# point this install at another board; a re-install never overwrites it.
"""

# CR-CRU-090 §S2 — the two candidates for the SOURCE client fleet, derived from
# this package's own location: the repo checkout's `clients/` beside the
# package, then the wheel's force-included `crucible_axi/clients` package data.
_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIENTS_CANDIDATES = (
    os.path.join(os.path.dirname(_HERE), "clients"),   # source checkout (repo root)
    os.path.join(_HERE, "clients"),                    # installed package data
)


def source_clients_dir() -> str:
    """The SOURCE client-fleet directory — THE single locus (CR-CRU-090 §S2).

    Returns the first existing candidate (source checkout first, installed
    package data second), falling back to the source-checkout candidate so a
    failure names the location an operator expects rather than an opaque
    interpreter-internal package path.

    Both consumers — `cli._load_client_module` and `install.run_fleet_stage` —
    call THIS function; neither keeps a private candidate list. The resolution
    is done at CALL time so an operator's on-disk layout (and a test's patch of
    this attribute) is always the one observed.
    """
    for candidate in _CLIENTS_CANDIDATES:
        if os.path.isdir(candidate):
            return candidate
    return _CLIENTS_CANDIDATES[0]


def operator_config_path(install_dir: str) -> str:
    """The operator-editable configuration under `install_dir` — the path the
    manifest publishes as `config` and the one `uninstall` reasons about."""
    return os.path.join(install_dir, CONFIG_FILENAME)


def shipped_config_path() -> str:
    """The SOURCE of that configuration: this package's own shipped limit
    declarations, which travel beside the fleet in the same package data.

    Resolved from `_CLIENTS_CANDIDATES` DIRECTLY rather than through
    `source_clients_dir()`, and the distinction is real rather than stylistic:
    that function answers "where is the SOURCE FLEET" — the packaged files
    `install.run_fleet_stage` copies — while this is the package's own data,
    consumed by a different stage and laid down at a different path. Pointing
    the fleet source elsewhere must not decide where the shipped declarations
    come from. Both derive from the one candidate list, so neither can drift.
    """
    for candidate in _CLIENTS_CANDIDATES:
        path = os.path.join(candidate, CONFIG_FILENAME)
        if os.path.isfile(path):
            return path
    return os.path.join(_CLIENTS_CANDIDATES[0], CONFIG_FILENAME)


def lay_down_config(source: str, destination: str) -> bool:
    """Copy an operator-editable configuration template to `destination`, and
    report whether this call WROTE it.

    NEVER overwrites — not even under `--force`, which is the one place this
    stage departs from the fleet's re-copy semantics and does so deliberately:
    an artifact is replaceable, an operator's configuration is DATA, and an
    upgrade that resets configuration is the defect §S1c exists to prevent.
    A missing SOURCE fails definitively with the path named, exactly as the
    fleet stage fails, rather than leaving a deployment with nothing to read.

    THE single lay-down (CR-CRU-138 §S2): the client's file at `<target-dir>`
    and the server's beside its own database are the same rule applied to two
    destinations, so a change to what "lay an operator's file down" means
    cannot reach one of them and miss the other.
    """
    if os.path.lexists(destination):
        return False
    if not os.path.isfile(source):
        raise FileNotFoundError(
            f"packaged limit defaults missing at source: {source}")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    Path(destination).write_bytes(Path(source).read_bytes())
    return True


def lay_down_operator_config(target_dir: str) -> bool:
    """Lay the CLIENT fleet's operator-editable `crucible.toml` down under
    `target_dir`, from this package's own shipped declarations, and report
    whether this call WROTE it."""
    return lay_down_config(shipped_config_path(),
                           operator_config_path(target_dir))


# ---------------------------------------------------------------------------
# CR-CRU-139 §S1a — writing a resolved value into a file we just laid down,
# and RECORDING that we wrote it.
# ---------------------------------------------------------------------------


def _toml_literal(value) -> str:
    """`value` as a TOML scalar. Integers bare, everything else a basic string
    with the two characters TOML's basic strings cannot carry raw escaped."""
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def _assigns(line: str, key: str) -> bool:
    """Whether `line` is a live (uncommented) assignment to `key`."""
    stripped = line.strip()
    if stripped.startswith("#") or "=" not in stripped:
        return False
    return stripped.split("=", 1)[0].strip() == key


def _table_body(lines: list[str], table: str) -> tuple[int, int] | None:
    """The `[start, end)` line range of `table`'s body, or None when the
    document declares no such table. The body ends at the next table header of
    any depth, so a `[limits.retention]` below `[server]` closes it."""
    header = f"[{table}]"
    start = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if start is None:
            if stripped == header:
                start = index + 1
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            return start, index
    return (start, len(lines)) if start is not None else None


def apply_setting(path: str, table: str, key: str, value, block: str = "") -> bytes:
    """Set `table`'s `key` to `value` in the TOML file at `path`; return the
    bytes now on disk.

    A LINE rewrite rather than a re-serialization, and that is the point: these
    files are documentation as much as they are configuration — every key sits
    under the commented paragraph explaining it — and a round-trip through a
    TOML emitter would hand the operator back a file with every one of those
    paragraphs gone. Only the assignment moves.

    An absent key is appended to its table; an absent TABLE is appended to the
    document, preceded by `block` (its own commented introduction) so a key an
    operator did not write still arrives explained.
    """
    text = Path(path).read_text(encoding="utf-8")
    assignment = f"{key} = {_toml_literal(value)}"
    lines = text.split("\n")
    body = _table_body(lines, table)
    if body is None:
        separator = "" if text.endswith("\n") else "\n"
        text = f"{text}{separator}{block}[{table}]\n{assignment}\n"
    else:
        start, end = body
        for index in range(start, end):
            if _assigns(lines[index], key):
                lines[index] = assignment
                break
        else:
            insert = end
            while insert > start and not lines[insert - 1].strip():
                insert -= 1
            lines.insert(insert, assignment)
        text = "\n".join(lines)
    Path(path).write_text(text, encoding="utf-8")
    return text.encode("utf-8")


def install_record_path(target_dir: str) -> str:
    """Where the install records the bytes it authored, under `target_dir`."""
    return os.path.join(target_dir, INSTALL_RECORD_FILENAME)


def config_digest(data: bytes) -> str:
    """The recording of one file's contents — a SHA-256 of the bytes.

    A digest rather than a copy: the question it answers is only ever "is this
    still exactly what we wrote?", and keeping a second copy of an operator's
    configuration around would be a file nobody asked for and a second place
    for it to be read from by mistake.
    """
    return hashlib.sha256(data).hexdigest()


def recorded_config_digests(target_dir: str) -> dict:
    """What the install recorded writing, as `{<abs path>: <digest>}`.

    `{}` for an install that predates the record, for a hand-placed file, and
    for a record that cannot be read — all three mean the same thing (we cannot
    prove we wrote this), and the caller's fall-back to the shipped template is
    the fail-safe direction CR-CRU-131 §S1c set.
    """
    try:
        with open(install_record_path(target_dir), encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return {}
    authored = record.get(RECORD_AUTHORED_KEY)
    if not isinstance(authored, dict):
        return {}
    return {path: digest for path, digest in authored.items()
            if isinstance(path, str) and isinstance(digest, str)}


def record_configs(target_dir: str, authored: dict) -> str | None:
    """MERGE `{<path>: <bytes>}` into the install record; return its path, or
    None when there was nothing to record.

    Merged rather than overwritten because a re-install authors only the files
    it actually wrote this time: a run that laid nothing down must not erase the
    provenance of what an earlier run did lay down, or `--purge` would start
    retaining files no operator ever touched.
    """
    if not authored:
        return None
    recorded = recorded_config_digests(target_dir)
    recorded.update({path: config_digest(data)
                     for path, data in authored.items()})
    path = install_record_path(target_dir)
    Path(path).write_text(
        json.dumps({RECORD_AUTHORED_KEY: recorded}, indent=2, sort_keys=True)
        + "\n", encoding="utf-8")
    return path


def _package_version() -> str:
    """The installed `crucible-axi` version, or a dev placeholder when the
    package is not installed (running from the source checkout in C1)."""
    try:
        return importlib.metadata.version("crucible-axi")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0+dev"


def build_manifest(install_dir: str, server_config: str | None = None) -> dict:
    """Build the discovery manifest for clients laid down under `install_dir`.

    Returns a dict with the top-level keys `version`, `clients`, `status`,
    `config` and `shipped_config`, plus `server_config` when the install laid
    the server's file down. `clients` maps each of the five stacks to its
    installed client path under `install_dir`; `status` references the
    STATUS-CONTRACT; `config` is the operator-editable configuration the
    install laid down (CR-CRU-131 §S1c — a file the installer WRITES belongs
    here like everything else it lays down, or automation cannot discover the
    file it is meant to edit). `config` names the ARTIFACT, not its payload:
    limits are what happens to be in that file today, and anything that
    legitimately joins it later costs no consumer a rename.

    CR-CRU-138 §S4 — `shipped_config` is the FLEET's own copy of the
    distribution's declarations, beside the module that reads them. It is
    package data rather than configuration, so it keeps a key of its own: one
    file doing both jobs is precisely the aliasing that made an operator's
    edits redefine the build's recommendations, and made an ordinary purge
    leave every client verb raising.

    CR-CRU-138 §S2 — `server_config` is the SERVER's operator-editable file,
    beside the server's own database. It is declared ONLY when a path is
    given, which is only when the install really wrote one: a board on another
    host owns that file, and publishing a path nothing here wrote would be the
    dangling-path defect CR-CRU-090 closed. Its absence is therefore a fact
    about this machine, not an omission.
    """
    clients_dir = os.path.join(install_dir, "clients")
    clients = {
        stack: os.path.join(clients_dir, f"{stack}-crucible.py")
        for stack in CLIENT_STACKS
    }
    document = {
        "version": _package_version(),
        "clients": clients,
        "status": os.path.join(clients_dir, "STATUS-CONTRACT.md"),
        "config": operator_config_path(install_dir),
        "shipped_config": os.path.join(clients_dir, CONFIG_FILENAME),
    }
    if server_config:
        document["server_config"] = server_config
    return document


def _serialize(manifest_dict: dict) -> str:
    """The single, deterministic on-disk serialization of a manifest — so a
    read-compare on a second run byte-matches a fresh build (idempotency)."""
    return json.dumps(manifest_dict, indent=2, sort_keys=True) + "\n"


def write_manifest(target_dir: str, manifest_dict: dict) -> str:
    """Write `crucible-clients.json` into `target_dir` (OVERWRITE, single JSON
    document — never append) and return the written path."""
    path = os.path.join(target_dir, MANIFEST_FILENAME)
    Path(path).write_text(_serialize(manifest_dict), encoding="utf-8")
    return path


def run_manifest_stage(target_dir: str, force: bool = False,
                       server_config: dict | None = None) -> dict:
    """The default `manifest` stage runner: lay the operator's configuration
    down, then (re)write the discovery manifest that declares it.

    The laydown happens HERE, inside the stage that publishes it, for the same
    reason `[fleet]` precedes `[manifest]`: a manifest may only publish paths
    that already exist, and the two artifacts this stage owns both sit directly
    at `<target-dir>`. The stage ordering is therefore unchanged (CR-CRU-131
    §S1c).

    `converged` is False when either artifact is freshly written (no prior
    file, or a changed document) and True only when the configuration was
    already there AND an identical manifest already sits on disk — the AC's
    "re-running converges (no duplicate installs)" signal.

    CR-CRU-138 §S2 — the SERVER's operator-editable configuration is laid down
    HERE too, for the same reason the client's is: this is the stage that owns
    configuration lay-down and the one that publishes what was written. It
    lands beside the server's own database rather than under `target_dir`, so
    `server_config` arrives as a PLAN computed by the caller
    (`install.server_config_plan()` — `{"path", "source", "reason"}`); this
    module never resolves the server's store itself, which is what keeps it
    free of an import back into `install`. A plan with no `source` means no
    server is provisioned on this machine: nothing is written, nothing is
    declared, and the stage REPORTS the reason as `server_config` in its
    result so the install output states it. A missing plan (an older caller,
    or a stage double) leaves the behaviour exactly as it was.

    CR-CRU-139 §S1a — the plan may also carry the RESOLVED `listener`, which
    this stage writes into BOTH files it lays down: the port into the server's
    `[server]` table and the same value's URL into the client's `[client]`
    one, so one install's two files cannot disagree about which board this
    machine talks to. Only a file this call actually LAID DOWN is written to:
    `lay_down_config` never overwrites, and a configured listener is never
    renumbered by a re-install.

    Every file it authored is RECORDED (`record_configs`), because the write
    above makes an installed file differ from its template forever: without the
    recording the install's own value would be indistinguishable from an
    operator's edit, and `uninstall --purge` would take the retention branch on
    every machine that ever probed a port.
    """
    listener = (server_config or {}).get("listener")
    authored: dict = {}
    wrote_config = lay_down_operator_config(target_dir)
    if wrote_config:
        client_config = operator_config_path(target_dir)
        if listener:
            apply_setting(client_config, CLIENT_TABLE, CLIENT_URL_KEY,
                          listener["url"], block=_CLIENT_TABLE_BLOCK)
        authored[client_config] = Path(client_config).read_bytes()
    server_report: dict | None = None
    if server_config is not None:
        source = server_config.get("source")
        if source:
            written = server_config["path"]
            if lay_down_config(source, written):
                wrote_config = True
                if listener:
                    apply_setting(written, SERVER_TABLE, SERVER_PORT_KEY,
                                  listener["port"])
                authored[written] = Path(written).read_bytes()
            server_report = {"path": written, "reason": None}
        else:
            server_report = {"path": None,
                             "reason": server_config.get("reason")}
    record_configs(target_dir, authored)
    manifest = build_manifest(
        target_dir,
        server_config=server_report["path"] if server_report else None)
    path = os.path.join(target_dir, MANIFEST_FILENAME)
    fresh = _serialize(manifest)
    converged = (
        not force
        and not wrote_config
        and os.path.exists(path)
        and Path(path).read_text(encoding="utf-8") == fresh
    )
    write_manifest(target_dir, manifest)
    result = {"path": path, "converged": converged}
    if server_report is not None:
        result["server_config"] = server_report
    return result
