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

import importlib.metadata
import json
import os
from pathlib import Path

# The five client stacks that ship a `*-crucible.py` client — exactly these,
# no extras (a clientless stack such as vscode must NOT appear here).
CLIENT_STACKS = ("bun", "python", "rust", "mvn", "arduino")

MANIFEST_FILENAME = "crucible-clients.json"

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
    """
    wrote_config = lay_down_operator_config(target_dir)
    server_report: dict | None = None
    if server_config is not None:
        source = server_config.get("source")
        if source:
            written = server_config["path"]
            if lay_down_config(source, written):
                wrote_config = True
            server_report = {"path": written, "reason": None}
        else:
            server_report = {"path": None,
                             "reason": server_config.get("reason")}
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
