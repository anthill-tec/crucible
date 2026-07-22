"""CR-CRU-009 §S2 — the discovery manifest (`crucible-clients.json`).

The manifest is the Model-B pre-flight contract: a stable-schema JSON document
mapping each of the five client stacks to its installed `*-crucible.py` path,
carrying a version and the STATUS-CONTRACT reference. `write_manifest` OVERWRITES
(never appends) so re-running install converges on a single document, and
`run_manifest_stage` reports `converged` when the on-disk JSON already
byte-matches what a fresh build would write.
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
