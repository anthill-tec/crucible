"""CR-CRU-009 §S2 — the `crucible-axi` console-script entry point.

`main` parses the `install` and `serve` subcommands. `install` drives
`install.run_install` and emits EXACTLY ONE TOON-AXI envelope on stdout
(`verb`, `ok`, `stages[]{name,path}`, `warnings[]`, `help[]`) via the fleet's
shared envelope machinery (`clients/_crucible_axi.py` + `clients/toon.py`) so
the format matches the `*-crucible.py` clients; exit 0 on ok, 1 otherwise.
`serve` runs the provisioned server in the foreground and returns its exit code
verbatim (CR-CRU-066 §S3), leaving stdout to the server itself.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
import sys

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
    p_install.add_argument(
        "--no-bun-bootstrap",
        action="store_true",
        help="fail the install instead of bootstrapping Bun when it is absent "
             f"(same as {install.BUN_NO_BOOTSTRAP_ENV_VAR}=1)",
    )

    p_serve = sub.add_parser(
        "serve",
        help="run the provisioned Crucible server in the foreground",
    )
    p_serve.add_argument(
        "--host",
        default=None,
        help="host the server binds "
             f"(overrides ${install.SERVER_HOST_ENV_VAR})",
    )
    p_serve.add_argument(
        "--port",
        type=int,
        default=None,
        help="port the server binds "
             f"(overrides ${install.SERVER_PORT_ENV_VAR})",
    )
    return parser


def cmd_install(args) -> int:
    ok, stages, warnings = install.run_install(
        args.target_dir, force=args.force,
        no_bun_bootstrap=args.no_bun_bootstrap)
    axi = _load_client_module("_crucible_axi")
    # The `[server]` stage reports the ABSOLUTE Bun it resolved (CR-CRU-066
    # §S2); it rides along in that stage's envelope row so the operator can see
    # exactly which Bun provisioned the server.
    stage_fields = []
    for stage in stages:
        fields = {"name": stage["name"], "path": stage["path"]}
        if stage.get("bun"):
            fields["bun"] = stage["bun"]
        stage_fields.append(fields)
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


def cmd_serve(args) -> int:
    """Run the server in the FOREGROUND and return its exit code (§S3 AC5).

    Blocking is CORRECT here — that is the whole point of splitting the run out
    of `install`. The child is launched by absolute path with an EXPLICITLY
    composed environment (`$CRUCIBLE_HOST`/`$CRUCIBLE_PORT`, the `--host`/
    `--port` flags overriding them), and its exit code is propagated verbatim
    so a shell — and the follow-up systemd `--user` unit — sees the real
    failure. No envelope is emitted: stdout belongs to the server. A launch that
    cannot be RESOLVED (no provisioned bin and no usable Bun) is definitive —
    the remedy on stderr, exit 1 — never a traceback.

    Two exit-status translations keep the foreground contract honest:

    * `KeyboardInterrupt` -> 130 (AC5a). RUNBOOK documents Ctrl-C as THE stop
      gesture, and a foreground SIGINT is delivered to the whole process group,
      so the parent raises out of `subprocess.run` too. Catching it here is what
      keeps a `Ctrl-C` from printing a Python stack trace at the operator.
    * a NEGATIVE returncode -> `128 - returncode` (AC5b). `CompletedProcess`
      reports a signalled child as `-N` (`-15` SIGTERM, `-9` SIGKILL), and the
      console script's `sys.exit(-15)` would mask to OS status 241. Translating
      to the conventional `128+N` (143 / 137) is what lets a supervisor tell
      the server was signalled. A positive code passes through verbatim.
    """
    try:
        argv = install.server_launch_argv()
    except RuntimeError as exc:
        print(f"crucible-axi serve: {exc}", file=sys.stderr)
        return 1
    env = os.environ.copy()
    if args.host is not None:
        env[install.SERVER_HOST_ENV_VAR] = args.host
    if args.port is not None:
        env[install.SERVER_PORT_ENV_VAR] = str(args.port)
    try:
        returncode = subprocess.run(argv, env=env).returncode
    except KeyboardInterrupt:
        return 130
    return returncode if returncode >= 0 else 128 - returncode


_COMMANDS = {
    "install": cmd_install,
    "serve": cmd_serve,
}


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    handler = _COMMANDS.get(args.command)
    if handler is None:
        parser.print_help()
        return 1
    return handler(args)
