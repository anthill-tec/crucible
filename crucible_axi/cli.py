"""CR-CRU-009 §S2 — the `crucible-axi` console-script entry point.

`main` parses the `install` subcommand, drives `install.run_install`, and emits
EXACTLY ONE TOON-AXI envelope on stdout (`verb`, `ok`, `stages[]{name,path}`,
`warnings[]`, `help[]`) via the fleet's shared envelope machinery
(`clients/_crucible_axi.py` + `clients/toon.py`) so the format matches the
`*-crucible.py` clients. Exit 0 on ok, 1 otherwise.
"""

from __future__ import annotations

import argparse
import importlib.util
import os

from crucible_axi import install

# The client fleet (envelope + TOON codec) lives beside the package in the
# source checkout, and is force-included as package data when installed.
_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIENTS_CANDIDATES = (
    os.path.join(os.path.dirname(_HERE), "clients"),   # source checkout (repo root)
    os.path.join(_HERE, "clients"),                    # installed package data
)


def _clients_dir() -> str:
    for candidate in _CLIENTS_CANDIDATES:
        if os.path.isdir(candidate):
            return candidate
    return _CLIENTS_CANDIDATES[0]


def _load_client_module(name: str):
    """Load a sibling `clients/<name>.py` module by file path (the hyphenated
    clients are not importable as normal module names, so the shared envelope
    module is vendored by path exactly as the clients load it)."""
    path = os.path.join(_clients_dir(), f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"crucible_axi_vendored_{name}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load client module at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="crucible-axi",
        description="Crucible install orchestrator.",
    )
    sub = parser.add_subparsers(dest="command")
    p_install = sub.add_parser("install", help="stage the Crucible install")
    p_install.add_argument(
        "--target-dir",
        default=os.path.expanduser("~/.crucible"),
        help="directory the client fleet + manifest are laid down under",
    )
    p_install.add_argument(
        "--force",
        action="store_true",
        help="re-run every stage even when already converged",
    )
    return parser


def cmd_install(args) -> int:
    ok, stages, warnings = install.run_install(args.target_dir, force=args.force)
    axi = _load_client_module("_crucible_axi")
    stage_fields = [{"name": s["name"], "path": s["path"]} for s in stages]
    result_fields = {
        "stages": stage_fields,
        "help": ["status"],
    }
    axi.emit_axi(
        verb="install",
        ok=ok,
        result_fields=result_fields,
        context={},
        warnings=warnings,
    )
    return 0 if ok else 1


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "install":
        return cmd_install(args)
    parser.print_help()
    return 1
