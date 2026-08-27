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
`install.run_fleet_stage` (copying the eight fleet files) call. It lives HERE
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


def _package_version() -> str:
    """The installed `crucible-axi` version, or a dev placeholder when the
    package is not installed (running from the source checkout in C1)."""
    try:
        return importlib.metadata.version("crucible-axi")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0+dev"


def build_manifest(install_dir: str) -> dict:
    """Build the discovery manifest for clients laid down under `install_dir`.

    Returns a dict with EXACTLY the top-level keys `version`, `clients`,
    `status`. `clients` maps each of the five stacks to its installed client
    path under `install_dir`; `status` references the STATUS-CONTRACT.
    """
    clients_dir = os.path.join(install_dir, "clients")
    clients = {
        stack: os.path.join(clients_dir, f"{stack}-crucible.py")
        for stack in CLIENT_STACKS
    }
    return {
        "version": _package_version(),
        "clients": clients,
        "status": os.path.join(clients_dir, "STATUS-CONTRACT.md"),
    }


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


def run_manifest_stage(target_dir: str, force: bool = False) -> dict:
    """The default `manifest` stage runner: (re)write the discovery manifest.

    `converged` is False when the manifest is freshly written (no prior file or
    a changed document) and True only when an identical document already sits on
    disk — the AC's "re-running converges (no duplicate installs)" signal.
    """
    manifest = build_manifest(target_dir)
    path = os.path.join(target_dir, MANIFEST_FILENAME)
    fresh = _serialize(manifest)
    converged = (
        not force
        and os.path.exists(path)
        and Path(path).read_text(encoding="utf-8") == fresh
    )
    write_manifest(target_dir, manifest)
    return {"path": path, "converged": converged}
