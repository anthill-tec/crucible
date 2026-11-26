"""Shared hermetic runner and configuration for Crucible clients.

Runs a test command inside an unprivileged Linux user and network namespace
(loopback `lo` only, no external route, all capabilities dropped), with an
empty `$HOME`, scrubbed operator environment (`XDG_*` and operator registry
variables unset), `DOCKER_HOST=unix:///nonexistent`, and the loopback tripwire
(`_crucible_tripwire.py`) listening on every configured board port and extra
tripwire endpoint.

Loaded by `_crucible_axi.py` as a sibling module and re-exported on the core
namespace, and also executable directly as a board-free standalone CLI:

    python3 clients/_crucible_hermetic.py --log-dir <dir> [--port 3849 ...] -- <cmd...>

Exit codes (standalone CLI):
  0   clean run and child exited 0
  N   clean run and child exited N
  90  invalid usage
  91  required tool missing on PATH
  92  kernel refused unprivileged user+network namespace
  93  loopback or capability-drop setup failed
  94  tripwire banner did not report every requested socket
  95  tripwire exited unexpectedly during the run
  99  tripwire recorded one or more outbound connection hits

Stdlib only.
"""

# pi-lens-ignore: I001 — pi-lens ruff has no target-version, filing stdlib `tomllib` as third-party
from __future__ import annotations  # noqa: I001

import argparse
import ipaddress
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import typing
from urllib.parse import urlparse

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run. None when
#: executed directly as a standalone CLI.
_core: typing.Any = None

HERMETIC_TABLE = "hermetic"
HERMETIC_FLAG = "--hermetic"
CURRENT_TEST_FILE_VAR = "CRUCIBLE_CURRENT_TEST_FILE"

HERMETIC_EXIT_USAGE = 90
HERMETIC_EXIT_MISSING = 91
HERMETIC_EXIT_NAMESPACE = 92
HERMETIC_EXIT_NETWORK = 93
HERMETIC_EXIT_BANNER = 94
HERMETIC_EXIT_TRIPWIRE_DIED = 95
HERMETIC_EXIT_HIT = 99

_BANNER_WAIT_SECONDS = 10.0
_BANNER_POLL_SECONDS = 0.05

XDG_VARS = (
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
)

OPERATOR_REGISTRY_VARS = (
    "CRUCIBLE_PROJECT_KEY",
    "CRUCIBLE_PROJECT_NAME",
    "WORKFLOW_ORCHESTRATOR",
    "SANDESH_PROJECT",
    "SANDESH_ADDRESS",
    "PROJECT_TOKEN",
    "PROJECT_STACKS",
    "KNOWLEDGE_CATEGORY",
)

STANDARD_TOOLCHAIN_VARS = (
    "PLAYWRIGHT_BROWSERS_PATH",
    "RUSTUP_HOME",
    "CARGO_HOME",
    "ARDUINO_DIRECTORIES_DATA",
    "GOROOT",
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
)

REQUIRED_HERMETIC_TOOLS = ("unshare", "setpriv", "ip")

_HERMETIC_FLAG_HELP = (
    "Run tests inside an unprivileged Linux user and network namespace "
    "(loopback only, all capabilities dropped, empty HOME, scrubbed env) "
    "behind the loopback tripwire."
)

# Per-invocation tripwire leaks recorded by `HermeticWrap`; reset at the start
# of every verb dispatch (`forget_hermetic_leaks`) so no invocation inherits an
# earlier run's leaks in the same process.
_recorded_leaks: list[dict[str, typing.Any]] = []


class HermeticRefused(Exception):
    """Typed hard stop raised when `--hermetic` cannot run or `[hermetic]`
    configuration is invalid."""

    def __init__(self, code: str, detail: str, help_steps: list[str] | tuple[str, ...]):
        self.code = code
        self.detail = detail
        self.help = list(help_steps)
        super().__init__(detail)


def add_hermetic_arg(parser: argparse.ArgumentParser) -> None:
    """Register `--hermetic` on a test, tier, or gate subparser."""
    parser.add_argument(
        HERMETIC_FLAG,
        dest="hermetic",
        action="store_true",
        default=False,
        help=_HERMETIC_FLAG_HELP,
    )


def emit_hermetic_refused_hard_stop(
    verb: str | None,
    refusal: HermeticRefused,
    context: dict[str, typing.Any] | None = None,
) -> int:
    """Emit the `ok:false` envelope (stdout) plus human error line (stderr)
    for a hermetic preflight or configuration refusal."""
    _core.emit_axi(
        verb or "unknown",
        False,
        {"error": refusal.detail, "help": list(refusal.help)},
        context or {},
        [],
        legacy_line=f"error: {refusal.code} — {refusal.detail}",
    )
    return 1


def forget_hermetic_leaks() -> None:
    """Clear per-invocation recorded tripwire leaks."""
    _recorded_leaks.clear()


def note_hermetic_leaks(leaks: list[dict[str, typing.Any]]) -> None:
    """Record tripwire leaks observed during the active invocation."""
    for item in leaks:
        if isinstance(item, dict) and item.get("endpoint") and item.get("port"):
            _recorded_leaks.append(dict(item))


def current_hermetic_leaks() -> list[dict[str, typing.Any]]:
    """Return a copy of the tripwire leaks recorded for the active invocation."""
    return [dict(item) for item in _recorded_leaks]


def _is_valid_port(value: typing.Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


def _parse_endpoint_string(spec: str) -> tuple[str, int]:
    """Parse `'127.0.0.1:6379'` or `'[::1]:6380'` into `(canonical_host, port)`."""
    text = spec.strip()
    if text.startswith("["):
        if "]:" not in text:
            raise ValueError(f"invalid IPv6 host:port {spec!r}")
        host_raw, port_s = text[1:].rsplit("]:", 1)
    elif ":" in text:
        host_raw, port_s = text.rsplit(":", 1)
    else:
        raise ValueError(f"expected `host:port` or `[::1]:port`, got {spec!r}")
    if not host_raw or not port_s.isdigit():
        raise ValueError(f"invalid host:port {spec!r}")
    addr = ipaddress.ip_address(host_raw)
    port = int(port_s)
    if not (1 <= port <= 65535):
        raise ValueError(f"port {port} out of range 1..65535 in {spec!r}")
    return str(addr), port


def _format_endpoint(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def _shipped_toml_path() -> str:
    if _core is not None:
        return _core.shipped_data_path()
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "crucible.toml")


def _config_candidates(
    project_dir: str | None = None,
    install_dir: str | None = None,
) -> tuple[str, ...]:
    if project_dir is None and _core is not None:
        project_dir = _core._PROJECT_DIR
    if install_dir is None and _core is not None:
        install_dir = _core._INSTALL_DIR
    candidates: list[str] = []
    if project_dir:
        candidates.append(os.path.join(str(project_dir), "crucible.toml"))
    if install_dir:
        inst_path = os.path.join(str(install_dir), "crucible.toml")
        if inst_path not in candidates:
            candidates.append(inst_path)
    return tuple(candidates)


def _read_toml_file(path: str) -> dict[str, typing.Any] | None:
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except (OSError, ValueError):
        return None


def _config_refusal(path: str, field: str, reason: str) -> HermeticRefused:
    return HermeticRefused(
        code="hermetic-config-invalid",
        detail=f"{path} declares an invalid [{HERMETIC_TABLE}] `{field}`: {reason}",
        help_steps=[
            f"fix `[{HERMETIC_TABLE}] {field}` in {path}",
            "example: tripwires = [5432, \"127.0.0.1:6379\"], allow_env = [\"MY_CACHE\"]",
        ],
    )


def _validate_hermetic_table(path: str, table: typing.Any) -> dict[str, typing.Any]:
    if not isinstance(table, dict):
        raise _config_refusal(path, HERMETIC_TABLE, f"expected a table, got {table!r}")
    out: dict[str, typing.Any] = {}
    if "tripwires" in table:
        raw_tw = table["tripwires"]
        if not isinstance(raw_tw, list):
            raise _config_refusal(path, "tripwires", f"expected a list, got {raw_tw!r}")
        validated_tw: list[int | str] = []
        for entry in raw_tw:
            if _is_valid_port(entry):
                validated_tw.append(entry)
            elif isinstance(entry, str):
                try:
                    _parse_endpoint_string(entry)
                except ValueError as exc:
                    raise _config_refusal(path, "tripwires", str(exc)) from exc
                validated_tw.append(entry)
            else:
                raise _config_refusal(
                    path,
                    "tripwires",
                    f"entry {entry!r} must be an integer port (1..65535) or `host:port` string",
                )
        out["tripwires"] = validated_tw
    if "allow_env" in table:
        raw_env = table["allow_env"]
        if not isinstance(raw_env, list):
            raise _config_refusal(path, "allow_env", f"expected a list, got {raw_env!r}")
        validated_env: list[str] = []
        for entry in raw_env:
            if not isinstance(entry, str) or not entry.strip():
                raise _config_refusal(
                    path,
                    "allow_env",
                    f"entry {entry!r} must be a non-empty environment variable name",
                )
            validated_env.append(entry)
        out["allow_env"] = validated_env
    if "default_board_port" in table:
        raw_port = table["default_board_port"]
        if not _is_valid_port(raw_port):
            raise _config_refusal(
                path,
                "default_board_port",
                f"expected an integer port in 1..65535, got {raw_port!r}",
            )
        out["default_board_port"] = raw_port
    return out


def _shipped_default_board_port() -> int:
    shipped = _shipped_toml_path()
    parsed = _read_toml_file(shipped)
    if isinstance(parsed, dict) and HERMETIC_TABLE in parsed:
        validated = _validate_hermetic_table(shipped, parsed[HERMETIC_TABLE])
        if "default_board_port" in validated:
            return int(validated["default_board_port"])
    raise HermeticRefused(
        code="hermetic-config-invalid",
        detail=f"{shipped} does not declare `[{HERMETIC_TABLE}] default_board_port`",
        help_steps=[f"ensure {shipped} declares `[{HERMETIC_TABLE}] default_board_port = 3849`"],
    )


def resolve_hermetic_config(
    *,
    project_dir: str | None = None,
    install_dir: str | None = None,
) -> dict[str, typing.Any]:
    """Resolve `[hermetic]` configuration across project -> install -> shipped
    defaults. Raises `HermeticRefused` naming the file and field on any
    malformed `[hermetic]` declaration."""
    tripwires: list[int | str] | None = None
    allow_env: list[str] | None = None
    default_board_port: int | None = None

    for path in _config_candidates(project_dir, install_dir):
        parsed = _read_toml_file(path)
        if not isinstance(parsed, dict) or HERMETIC_TABLE not in parsed:
            continue
        validated = _validate_hermetic_table(path, parsed[HERMETIC_TABLE])
        if tripwires is None and "tripwires" in validated:
            tripwires = validated["tripwires"]
        if allow_env is None and "allow_env" in validated:
            allow_env = validated["allow_env"]
        if default_board_port is None and "default_board_port" in validated:
            default_board_port = int(validated["default_board_port"])

    if default_board_port is None:
        default_board_port = _shipped_default_board_port()

    return {
        "tripwires": list(tripwires) if tripwires is not None else [],
        "allow_env": list(allow_env) if allow_env is not None else [],
        "default_board_port": default_board_port,
    }


def _client_url_port(path: str) -> int | None:
    parsed = _read_toml_file(path)
    if not isinstance(parsed, dict):
        return None
    client = parsed.get("client")
    if not isinstance(client, dict):
        return None
    url = client.get("url")
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        port = urlparse(url.strip()).port
    except ValueError:
        return None
    return port if _is_valid_port(port) else None


def resolve_tripwire_endpoints(
    *,
    project_dir: str | None = None,
    install_dir: str | None = None,
) -> list[tuple[str, int]]:
    """Return the deduplicated list of `(host, port)` loopback endpoints to
    guard: the union of the project's `[client] url` port, the install's
    `[client] url` port, the shipped/configured `default_board_port`, and any
    extra `[hermetic] tripwires`."""
    cfg = resolve_hermetic_config(project_dir=project_dir, install_dir=install_dir)
    seen: set[tuple[str, int]] = set()
    endpoints: list[tuple[str, int]] = []

    def _add_dual_port(port: int) -> None:
        for host in ("127.0.0.1", "::1"):
            item = (host, port)
            if item not in seen:
                seen.add(item)
                endpoints.append(item)

    for path in _config_candidates(project_dir, install_dir):
        port = _client_url_port(path)
        if port is not None:
            _add_dual_port(port)

    _add_dual_port(int(cfg["default_board_port"]))

    for entry in cfg["tripwires"]:
        if isinstance(entry, int):
            _add_dual_port(entry)
        else:
            host, port = _parse_endpoint_string(entry)
            item = (host, port)
            if item not in seen:
                seen.add(item)
                endpoints.append(item)

    return endpoints


def _toolchain_refusal(detail: str) -> HermeticRefused:
    return HermeticRefused(
        code="hermetic-toolchain-unavailable",
        detail=detail,
        help_steps=[
            "set the toolchain variable yourself (for example GOROOT) before "
            "running with --hermetic",
            "or run without --hermetic",
        ],
    )


def apply_toolchain_defaults(
    environ: typing.Mapping[str, str], cwd: str
) -> dict[str, str]:
    """The toolchain defaults every hermetic run gets, client and standalone
    alike, as the retired `scripts/hermetic/run.sh` exported them before
    redirecting `HOME`: the Playwright, Rust and Arduino stores keep pointing
    at the ORIGINAL home, Go resolves `GOROOT` from `go env` when `go` is on
    `PATH`, and keeps its path and caches in the working tree `cwd`'s
    `.cache/test-suite`. A value already set is kept. Returns a new dict;
    raises `HermeticRefused` when `HOME` is unset or `go env GOROOT` fails."""
    env = dict(environ)
    home = env.get("HOME")
    if not home:
        raise _toolchain_refusal("HOME is not set")
    suite_cache = os.path.join(cwd, ".cache", "test-suite")
    defaults = {
        "PLAYWRIGHT_BROWSERS_PATH": os.path.join(home, ".cache", "ms-playwright"),
        "RUSTUP_HOME": os.path.join(home, ".rustup"),
        "CARGO_HOME": os.path.join(home, ".cargo"),
        "ARDUINO_DIRECTORIES_DATA": os.path.join(home, ".arduino15"),
        "GOPATH": os.path.join(suite_cache, "go"),
        "GOMODCACHE": os.path.join(suite_cache, "go-mod"),
        "GOCACHE": os.path.join(suite_cache, "go-build"),
    }
    for key, value in defaults.items():
        if not env.get(key):
            env[key] = value
    go = shutil.which("go", path=env.get("PATH"))
    if not env.get("GOROOT") and go is not None:
        probe = subprocess.run(
            [go, "env", "GOROOT"], capture_output=True, text=True, check=False
        )
        if probe.returncode != 0 or not probe.stdout.strip():
            raise _toolchain_refusal(
                f"`go env GOROOT` failed: {probe.stderr.strip() or f'exit {probe.returncode}'}"
            )
        env["GOROOT"] = probe.stdout.strip()
    return env


def build_isolated_env(
    base_env: typing.Mapping[str, str],
    iso_home: str,
    *,
    allow_env: typing.Iterable[str] = (),
    current_test_file: str | None = None,
) -> dict[str, str]:
    """Return a fresh environment dict for a hermetic child process without
    mutating `base_env`."""
    env = dict(base_env)
    for key in XDG_VARS:
        env.pop(key, None)
    for key in OPERATOR_REGISTRY_VARS:
        env.pop(key, None)
    for key in allow_env:
        if key in base_env:
            env[key] = base_env[key]
    for key in STANDARD_TOOLCHAIN_VARS:
        if key in base_env:
            env[key] = base_env[key]
    env["HOME"] = str(iso_home)
    env["DOCKER_HOST"] = "unix:///nonexistent"
    if current_test_file is not None:
        env[CURRENT_TEST_FILE_VAR] = str(current_test_file)
    else:
        env.pop(CURRENT_TEST_FILE_VAR, None)
    return env


def check_hermetic_available() -> None:
    """Verify Linux platform, required namespace tools, and unprivileged
    user+network namespace creation. Raises `HermeticRefused` otherwise."""
    if not sys.platform.startswith("linux"):
        raise HermeticRefused(
            code="hermetic-unsupported-platform",
            detail=(
                f"--hermetic requires Linux user and network namespaces "
                f"(current platform: {sys.platform})"
            ),
            help_steps=[
                "run without --hermetic on this host",
                "or run --hermetic on a Linux host or Linux CI runner",
            ],
        )
    for tool in REQUIRED_HERMETIC_TOOLS:
        if shutil.which(tool) is None:
            raise HermeticRefused(
                code="hermetic-missing-tool",
                detail=f"--hermetic requires `{tool}` on PATH, which was not found",
                help_steps=[
                    f"install the package providing `{tool}` (util-linux / iproute2)",
                    "or run without --hermetic",
                ],
            )
    probe = subprocess.run(
        ["unshare", "--map-current-user", "--keep-caps", "-n", "true"],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        reason = (probe.stderr or probe.stdout or "").strip() or f"exit {probe.returncode}"
        raise HermeticRefused(
            code="hermetic-userns-refused",
            detail=(
                f"--hermetic could not create an unprivileged user+network "
                f"namespace: {reason}"
            ),
            help_steps=[
                "on Ubuntu 24.04+, enable unprivileged user namespaces: "
                "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
                "or run without --hermetic",
            ],
        )


def prepare_hermetic_run(
    *,
    project_dir: str | None = None,
    install_dir: str | None = None,
) -> tuple[dict[str, typing.Any], list[tuple[str, int]]]:
    """Run all hermetic preflight checks and resolve config + endpoints before
    any board run is opened or subprocess is started."""
    check_hermetic_available()
    cfg = resolve_hermetic_config(project_dir=project_dir, install_dir=install_dir)
    endpoints = resolve_tripwire_endpoints(
        project_dir=project_dir, install_dir=install_dir
    )
    return cfg, endpoints


def refuse_hermetic_with_docker(args: typing.Any) -> None:
    """Refuse `--with-docker` together with `--hermetic`: a hermetic run
    neutralises `DOCKER_HOST` and has no route off loopback, so the pair is
    contradictory and is refused before Docker or any runner starts."""
    if getattr(args, "hermetic", False) and getattr(args, "with_docker", False):
        raise HermeticRefused(
            code="hermetic-incompatible-flags",
            detail=(
                "--with-docker and --hermetic cannot be combined: hermetic runs "
                "neutralize DOCKER_HOST and isolate the network namespace"
            ),
            help_steps=[
                "run `e2e --with-docker` without `--hermetic` for Docker-backed tests",
                "or run `e2e --hermetic` without `--with-docker` for isolated loopback-only tests",
            ],
        )


def hermetic_preflight(args: typing.Any, project_dir: str | None = None) -> None:
    """The dispatch-time check every `--hermetic` verb passes before anything
    runs or is opened on the board: contradictory flags first, then the
    `[hermetic]` declarations and the platform/tool/kernel availability.
    Raises `HermeticRefused`; a verb without `--hermetic` is untouched."""
    if not getattr(args, "hermetic", False):
        return
    refuse_hermetic_with_docker(args)
    prepare_hermetic_run(project_dir=project_dir)


def _replay_log(path: str, stream: typing.TextIO) -> None:
    """Copy a tripwire log onto `stream`, naming the log when it cannot be
    read rather than dropping the reason silently."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            stream.write(fh.read())
    except OSError as exc:
        stream.write(f"hermetic: cannot read {path}: {exc}\n")
    stream.flush()


def _read_leaks_file(path: str) -> list[dict[str, typing.Any]]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


class HermeticWrap:
    """Context manager that wraps a runner `(cmd, env)` in the hermetic
    namespace + tripwire when `enabled=True`, and collects recorded leaks on
    exit."""

    def __init__(
        self,
        cmd: list[str],
        env: typing.Mapping[str, str],
        *,
        enabled: bool = False,
        project_dir: str | None = None,
        install_dir: str | None = None,
        record: bool = True,
    ):
        self._orig_cmd = list(cmd)
        self._orig_env = dict(env)
        self.enabled = bool(enabled)
        self._project_dir = project_dir
        self._install_dir = install_dir
        self._record = record
        self._log_dir: str | None = None
        self.cmd: list[str] = list(cmd)
        self.env: dict[str, str] = dict(env)
        self.leaks: list[dict[str, typing.Any]] = []

    def __enter__(self) -> HermeticWrap:
        if not self.enabled:
            return self
        cfg, endpoints = prepare_hermetic_run(
            project_dir=self._project_dir,
            install_dir=self._install_dir,
        )
        # The toolchain stores are resolved against the ORIGINAL home, before
        # the runner's `HOME` is redirected (the same defaults the standalone
        # CLI applies).
        base_env = apply_toolchain_defaults(self._orig_env, self._working_tree())
        log_dir = tempfile.mkdtemp(prefix="crucible-hermetic-")
        self._log_dir = log_dir
        iso_home = os.path.join(log_dir, "home")
        os.makedirs(iso_home, exist_ok=True)
        current_test_file = os.path.join(log_dir, "current-test.txt")
        self.env = build_isolated_env(
            base_env,
            iso_home,
            allow_env=cfg["allow_env"],
            current_test_file=current_test_file,
        )
        self_path = os.path.abspath(__file__)
        wrapped = [
            sys.executable,
            self_path,
            "--log-dir",
            log_dir,
            "--quiet",
            "--env-ready",
            "--current-test-file",
            current_test_file,
        ]
        for host, port in endpoints:
            wrapped.extend(["--endpoint", _format_endpoint(host, port)])
        wrapped.append("--")
        wrapped.extend(self._orig_cmd)
        self.cmd = wrapped
        return self

    def _working_tree(self) -> str:
        """The working tree the runner runs in: the project's directory."""
        project_dir = self._project_dir
        if project_dir is None and _core is not None:
            project_dir = _core._PROJECT_DIR
        return os.path.abspath(project_dir or os.getcwd())

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        if self._log_dir is None:
            return
        try:
            leaks_path = os.path.join(self._log_dir, "leaks.json")
            self.leaks = _read_leaks_file(leaks_path)
            if self._record and self.leaks:
                note_hermetic_leaks(self.leaks)
        finally:
            shutil.rmtree(self._log_dir, ignore_errors=True)
            self._log_dir = None


def hermetic_wrap(
    cmd: list[str],
    env: typing.Mapping[str, str],
    *,
    enabled: bool = False,
    project_dir: str | None = None,
    install_dir: str | None = None,
    record: bool = True,
) -> HermeticWrap:
    """Factory for `HermeticWrap`."""
    return HermeticWrap(
        cmd,
        env,
        enabled=enabled,
        project_dir=project_dir,
        install_dir=install_dir,
        record=record,
    )


# ── Standalone CLI (board-free hermetic launcher) ────────────────────────────


def _print_preamble() -> None:
    """What the command's own process sees, printed before it runs: the
    namespace's addresses and routes, the identity, and the effective and
    bounding capability sets."""
    for label, cmd in (
        ("ip -o addr", ["ip", "-o", "addr"]),
        ("ip route", ["ip", "route"]),
        ("ip -6 route", ["ip", "-6", "route"]),
        ("id", ["id"]),
    ):
        print(f"hermetic: {label}", flush=True)
        subprocess.run(cmd, check=False)
    print("hermetic: capabilities", flush=True)
    with open("/proc/self/status", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith(("CapEff:", "CapBnd:")):
                print(line.rstrip("\n"), flush=True)
    print(
        f"hermetic: HOME={os.environ.get('HOME', '')} "
        f"DOCKER_HOST={os.environ.get('DOCKER_HOST', '')}",
        flush=True,
    )


def _run_forwarding_signals(command: list[str]) -> int:
    """Run `command`, forwarding SIGTERM and SIGINT to it, and return its
    exit status once it has exited."""
    child = subprocess.Popen(command)

    def _forward(signum: int, _frame: typing.Any) -> None:
        if child.poll() is None:
            child.send_signal(signum)

    previous = {
        sig: signal.signal(sig, _forward) for sig in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        return child.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _setup_failure(code: int, message: str) -> int:
    print(f"hermetic: SETUP FAILURE (exit {code}): {message}", file=sys.stderr, flush=True)
    return code


def _parse_cli_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    if "--" in argv:
        idx = argv.index("--")
        own_argv = argv[:idx]
        command = argv[idx + 1 :]
    else:
        own_argv = argv
        command = []
    parser = argparse.ArgumentParser(
        prog="_crucible_hermetic.py",
        description="Run a command inside an unprivileged Linux user+network namespace behind the loopback tripwire.",
    )
    parser.add_argument("--log-dir", required=True, help="Directory for tripwire.log, leaks.json, and isolated home/")
    parser.add_argument(
        "--port",
        action="append",
        type=int,
        default=[],
        help="Loopback port to guard on 127.0.0.1 and ::1; repeatable.",
    )
    parser.add_argument(
        "--endpoint",
        action="append",
        default=[],
        help="Explicit loopback endpoint (`127.0.0.1:PORT` or `[::1]:PORT`); repeatable.",
    )
    parser.add_argument(
        "--allow-env",
        action="append",
        default=[],
        help="Extra environment variable name to pass through; repeatable.",
    )
    parser.add_argument(
        "--current-test-file",
        default=None,
        help="Optional file path where a runner publishes the currently running test id.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        default=False,
        help="Suppress hermetic preamble and verdict banners on stdout.",
    )
    parser.add_argument(
        "--env-ready",
        action="store_true",
        default=False,
        help=argparse.SUPPRESS,
    )
    ns = parser.parse_args(own_argv)
    return ns, command


def _cli_endpoints(args: argparse.Namespace) -> list[str]:
    seen: set[tuple[str, int]] = set()
    formatted: list[str] = []

    def _add(host: str, port: int) -> None:
        item = (host, port)
        if item not in seen:
            seen.add(item)
            formatted.append(_format_endpoint(host, port))

    for port in args.port:
        if not _is_valid_port(port):
            raise ValueError(f"invalid port {port!r}")
        _add("127.0.0.1", port)
        _add("::1", port)
    for spec in args.endpoint:
        host, port = _parse_endpoint_string(spec)
        _add(host, port)
    if not formatted:
        for host, port in resolve_tripwire_endpoints():
            _add(host, port)
    return formatted


def _wait_for_tripwire_banner(
    proc: subprocess.Popen,
    log_path: str,
    expected_sockets: list[str],
) -> tuple[bool, str]:
    deadline = time.monotonic() + _BANNER_WAIT_SECONDS
    banner = ""
    while time.monotonic() < deadline:
        try:
            with open(log_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("tripwire listening "):
                        banner = line.strip()
                        break
        except FileNotFoundError:
            # The tripwire has not created its log yet: poll again.
            banner = ""
        if banner:
            break
        if proc.poll() is not None:
            break
        time.sleep(_BANNER_POLL_SECONDS)
    if not banner:
        return False, "the tripwire exited or timed out before printing its listening banner"
    padded = f" {banner} "
    for sock in expected_sockets:
        if f" {sock} " not in padded:
            return False, f"the tripwire banner did not name {sock}"
    return True, banner


def _run_dropped_stage(
    args: argparse.Namespace,
    command: list[str],
    endpoints: list[str],
) -> int:
    os.environ.pop("HERMETIC_STAGE", None)
    log_dir = os.path.abspath(args.log_dir)
    tripwire_log = os.path.join(log_dir, "tripwire.log")
    leaks_json = os.path.join(log_dir, "leaks.json")
    tripwire_script = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "_crucible_tripwire.py"
    )
    trip_env = dict(os.environ)
    for var in ("PYTHONPATH", "HERMETIC_EVENTS", "HERMETIC_TEST"):
        trip_env.pop(var, None)

    trip_cmd = [sys.executable, "-I", tripwire_script, "--leaks-json", leaks_json]
    if args.current_test_file:
        trip_cmd.extend(["--current-test-file", args.current_test_file])
    for ep in endpoints:
        trip_cmd.extend(["--endpoint", ep])

    with open(tripwire_log, "w", encoding="utf-8") as log_fh:
        trip_proc = subprocess.Popen(
            trip_cmd,
            env=trip_env,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
        )

    ok_banner, banner_or_err = _wait_for_tripwire_banner(
        trip_proc, tripwire_log, endpoints
    )
    if not ok_banner:
        if trip_proc.poll() is None:
            trip_proc.terminate()
            try:
                trip_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                trip_proc.kill()
        _replay_log(tripwire_log, sys.stderr)
        return _setup_failure(HERMETIC_EXIT_BANNER, banner_or_err)

    if not args.quiet:
        _print_preamble()
        print(f"hermetic: {banner_or_err}", flush=True)
        print(f"hermetic: running {' '.join(command)}", flush=True)

    child_status = _run_forwarding_signals(command)
    if not args.quiet:
        print(f"hermetic: the command exited {child_status}", flush=True)

    if trip_proc.poll() is not None:
        _replay_log(tripwire_log, sys.stderr)
        return _setup_failure(
            HERMETIC_EXIT_TRIPWIRE_DIED, "the tripwire died during the run"
        )

    trip_proc.send_signal(signal.SIGTERM)
    trip_status = trip_proc.wait(timeout=10)
    if trip_status != 0:
        _replay_log(tripwire_log, sys.stderr)
        return _setup_failure(
            HERMETIC_EXIT_TRIPWIRE_DIED,
            f"the tripwire exited {trip_status} instead of draining",
        )

    leaks = _read_leaks_file(leaks_json)
    if leaks:
        if not args.quiet:
            print(
                f"hermetic: VERDICT HIT — {len(leaks)} connection(s) to a guarded port:",
                flush=True,
            )
            _replay_log(tripwire_log, sys.stdout)
        return HERMETIC_EXIT_HIT

    if not args.quiet:
        print(
            f"hermetic: VERDICT clean — no tripwire hit; the command's status is {child_status}",
            flush=True,
        )
    return child_status


def main(argv: list[str] | None = None) -> int:
    raw_argv = sys.argv[1:] if argv is None else list(argv)
    try:
        args, command = _parse_cli_args(raw_argv)
    except SystemExit as exc:
        return HERMETIC_EXIT_USAGE if exc.code != 0 else 0
    if not command:
        print(
            "usage: _crucible_hermetic.py --log-dir <dir> [--port PORT ...] -- <command...>",
            file=sys.stderr,
        )
        return HERMETIC_EXIT_USAGE

    try:
        endpoints = _cli_endpoints(args)
    except (ValueError, HermeticRefused) as exc:
        return _setup_failure(HERMETIC_EXIT_USAGE, str(exc))

    stage = os.environ.get("HERMETIC_STAGE", "")
    self_path = os.path.abspath(__file__)

    if stage == "":
        if not sys.platform.startswith("linux"):
            return _setup_failure(
                HERMETIC_EXIT_MISSING,
                f"hermetic runs need Linux namespaces (platform: {sys.platform})",
            )
        for tool in REQUIRED_HERMETIC_TOOLS:
            if shutil.which(tool) is None:
                return _setup_failure(
                    HERMETIC_EXIT_MISSING, f"`{tool}` is not on PATH"
                )
        try:
            log_dir = os.path.abspath(args.log_dir)
            os.makedirs(log_dir, exist_ok=True)
        except OSError as exc:
            return _setup_failure(
                HERMETIC_EXIT_USAGE, f"cannot create log dir {args.log_dir}: {exc}"
            )

        if args.env_ready:
            child_env = dict(os.environ)
        else:
            iso_home = os.path.join(log_dir, "home")
            shutil.rmtree(iso_home, ignore_errors=True)
            os.makedirs(iso_home, exist_ok=True)
            try:
                base_env = apply_toolchain_defaults(os.environ, os.getcwd())
            except HermeticRefused as exc:
                return _setup_failure(HERMETIC_EXIT_MISSING, exc.detail)
            child_env = build_isolated_env(
                base_env,
                iso_home,
                allow_env=args.allow_env,
                current_test_file=args.current_test_file,
            )

        probe = subprocess.run(
            ["unshare", "--map-current-user", "--keep-caps", "-n", "true"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode != 0:
            err = (probe.stderr or probe.stdout or "").strip()
            return _setup_failure(
                HERMETIC_EXIT_NAMESPACE,
                f"the kernel refused an unprivileged network namespace: {err}",
            )

        child_env["HERMETIC_STAGE"] = "namespace"
        # Replaced, not spawned: a signal sent to this process reaches the
        # namespace's own process, which forwards it to the command.
        # pi-lens-ignore: S606 — a fixed argv vector (no shell), as the retired wrapper's `exec`
        os.execvpe(
            "unshare",
            [
                "unshare",
                "--map-current-user",
                "--keep-caps",
                "-n",
                sys.executable,
                self_path,
                *raw_argv,
            ],
            child_env,
        )

    if stage == "namespace":
        lo = subprocess.run(["ip", "link", "set", "lo", "up"], check=False)
        if lo.returncode != 0:
            return _setup_failure(HERMETIC_EXIT_NETWORK, "cannot bring lo up")
        cap_probe = subprocess.run(
            [
                "setpriv",
                "--ambient-caps",
                "-all",
                "--inh-caps",
                "-all",
                "--bounding-set",
                "-all",
                "--no-new-privs",
                "true",
            ],
            check=False,
        )
        if cap_probe.returncode != 0:
            return _setup_failure(
                HERMETIC_EXIT_NETWORK, "setpriv cannot drop capabilities"
            )
        next_env = dict(os.environ)
        next_env["HERMETIC_STAGE"] = "dropped"
        # pi-lens-ignore: S606 — a fixed argv vector (no shell), as the retired wrapper's `exec`
        os.execvpe(
            "setpriv",
            [
                "setpriv",
                "--ambient-caps",
                "-all",
                "--inh-caps",
                "-all",
                "--bounding-set",
                "-all",
                "--no-new-privs",
                sys.executable,
                self_path,
                *raw_argv,
            ],
            next_env,
        )

    if stage == "dropped":
        return _run_dropped_stage(args, command, endpoints)

    return _setup_failure(HERMETIC_EXIT_USAGE, f"unknown HERMETIC_STAGE={stage!r}")


if __name__ == "__main__":
    sys.exit(main())
