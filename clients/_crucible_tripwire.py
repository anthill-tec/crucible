"""Loopback tripwire for a hermetic run.

Listens on the requested loopback sockets INSIDE a run's isolated network
namespace (never on a host network). Every connection is a leak hit: it is
logged at accept() — the time, port, peer address, active test name (when
the runner publishes one via `--current-test-file`), and, when `/proc` names
it, the peer's pid, cwd, and command line — then its first request line is
logged, and it is answered HTTP 503 and closed.

Output (stdout, line-buffered):

    tripwire listening 127.0.0.1:3849 [::1]:3849 ...
    HIT <time> port=<port> peer=<addr> pid=<pid> cwd=<cwd> cmd=<cmdline>
        | <first request line>
    tripwire drained <n> handler(s); stopped

The banner is printed only once every socket listens. On SIGTERM it stops
accepting, waits for every in-flight handler, writes `--leaks-json` when
requested, and exits 0.

Exit codes:
  0  stopped by SIGTERM after draining
  1  a socket could not bind
  2  invalid command-line arguments
  3  a listening socket failed while the run was in progress

Stdlib only.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import signal
import socket
import sys
import threading
import time

RECV_TIMEOUT_S = 2.0
RESPONSE = (
    b"HTTP/1.1 503 Service Unavailable\r\n"
    b"Content-Length: 0\r\n"
    b"Connection: close\r\n\r\n"
)

_out_lock = threading.Lock()
_handlers_lock = threading.Lock()
_handlers: list[threading.Thread] = []
_leaks_lock = threading.Lock()
_leaks: list[dict[str, object]] = []
_stopping = threading.Event()


def _emit(text: str) -> None:
    with _out_lock:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()


def _stamp() -> str:
    now = time.time()
    return (
        time.strftime("%H:%M:%S", time.localtime(now))
        + f".{int(now * 1000) % 1000:03d}"
    )


def _label(family: int, host: str, port: int) -> str:
    return f"[{host}]:{port}" if family == socket.AF_INET6 else f"{host}:{port}"


def _parse_endpoint(spec: str) -> tuple[int, str, int]:
    """Parse `'127.0.0.1:3849'` or `'[::1]:3849'` into `(family, host, port)`."""
    text = spec.strip()
    if text.startswith("["):
        if "]:" not in text:
            raise ValueError(f"invalid IPv6 endpoint {spec!r}")
        host, port_s = text[1:].rsplit("]:", 1)
    elif ":" in text:
        host, port_s = text.rsplit(":", 1)
    else:
        raise ValueError(f"invalid endpoint {spec!r}")
    addr = ipaddress.ip_address(host)
    port = int(port_s)
    if port < 1 or port > 65535:
        raise ValueError(f"port out of range in {spec!r}")
    family = socket.AF_INET6 if addr.version == 6 else socket.AF_INET
    return family, str(addr), port


#: The variables a runner names its running test in, in the order read.
_TEST_ENV_VARS = ("CRUCIBLE_CURRENT_TEST", "PYTEST_CURRENT_TEST")
#: pytest's phase suffix on `PYTEST_CURRENT_TEST`, dropped from the name.
_PYTEST_PHASES = (" (call)", " (setup)", " (teardown)")


def _read_current_test(path: str | None) -> str:
    """The test id the runner published in `path`; empty when none is
    published or the file cannot be read (a hit is still logged, without a
    test name)."""
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _test_from_environ(pid: str) -> str:
    """The running test the peer process names in its environment
    (`CRUCIBLE_CURRENT_TEST`, else `PYTEST_CURRENT_TEST` without pytest's
    phase suffix); empty when it names none or `/proc` cannot be read.
    `/proc/<pid>/environ` is the environment the process STARTED with, so a
    test that runs in the runner's own process is named by the current-test
    file instead."""
    try:
        with open(f"/proc/{pid}/environ", "rb") as fh:
            raw = fh.read()
    except OSError:
        return ""
    found: dict[str, str] = {}
    for entry in raw.split(b"\0"):
        key, sep, value = entry.decode(errors="replace").partition("=")
        if sep and key in _TEST_ENV_VARS and value.strip():
            found[key] = value.strip()
    for key in _TEST_ENV_VARS:
        name = found.get(key, "")
        for phase in _PYTEST_PHASES:
            if name.endswith(phase):
                name = name[: -len(phase)]
                break
        if name:
            return name
    return ""


def _socket_inode(peer_port: int, server_port: int) -> str | None:
    """Return the inode of the CLIENT end of a connection whose local port is
    `peer_port` and whose remote port is `server_port`."""
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="ascii") as fh:
                next(fh, None)
                for line in fh:
                    parts = line.split()
                    if len(parts) < 10:
                        continue
                    local = int(parts[1].rsplit(":", 1)[1], 16)
                    remote = int(parts[2].rsplit(":", 1)[1], 16)
                    if local == peer_port and remote == server_port:
                        return parts[9]
        except OSError:
            continue
    return None


def _process_of_inode(inode: str) -> tuple[str, str, str] | None:
    target = f"socket:[{inode}]"
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None
    for pid in filter(str.isdigit, entries):
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                if os.readlink(f"/proc/{pid}/fd/{fd}") != target:
                    continue
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    cmd = (
                        fh.read()
                        .replace(b"\0", b" ")
                        .decode(errors="replace")
                        .strip()
                    )
                return pid, os.readlink(f"/proc/{pid}/cwd"), cmd[:400]
        except OSError:
            continue
    return None


def _handle(
    conn: socket.socket,
    peer: tuple,
    label: str,
    port: int,
    current_test_file: str | None,
) -> None:
    with conn:
        found = None
        inode = _socket_inode(peer[1], port)
        if inode is not None:
            found = _process_of_inode(inode)
        pid, cwd, cmd = found if found else ("?", "?", "?")
        test_name = (_test_from_environ(pid) if pid != "?" else "") or (
            _read_current_test(current_test_file))
        suffix = f" test={test_name}" if test_name else ""
        _emit(
            f"HIT {_stamp()} port={port} peer={peer[0]}:{peer[1]} "
            f"pid={pid} cwd={cwd} cmd={cmd}{suffix}"
        )
        conn.settimeout(RECV_TIMEOUT_S)
        first_line = ""
        try:
            data = conn.recv(600)
        except OSError as exc:
            data = b""
            _emit(f"    | (no request line: {exc})")
        if data:
            first_line = data.decode(errors="replace").split("\n", 1)[0].rstrip("\r")
            _emit(f"    | {first_line}")
        try:
            conn.sendall(RESPONSE)
        except OSError as exc:
            _emit(f"    | (503 not delivered: {exc})")

        record: dict[str, object] = {"endpoint": label, "port": port}
        if test_name:
            record["test"] = test_name
        if pid and pid != "?":
            record["pid"] = pid
        if cmd and cmd != "?":
            record["cmd"] = cmd
        if first_line:
            record["request"] = first_line
        with _leaks_lock:
            _leaks.append(record)


def _accept_loop(
    sock: socket.socket,
    label: str,
    port: int,
    current_test_file: str | None,
) -> None:
    while True:
        try:
            conn, peer = sock.accept()
        except OSError as exc:
            if _stopping.is_set():
                return
            _emit(f"tripwire: {label} failed: {exc}")
            sys.stdout.flush()
            os._exit(3)
        worker = threading.Thread(
            target=_handle,
            args=(conn, peer, label, port, current_test_file),
        )
        with _handlers_lock:
            _handlers.append(worker)
        worker.start()


def _bind_all(
    endpoints: list[tuple[int, str, int]],
) -> list[tuple[socket.socket, str, int]]:
    bound: list[tuple[socket.socket, str, int]] = []
    for family, host, port in endpoints:
        label = _label(family, host, port)
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            sock.bind((host, port))
            sock.listen(64)
        except OSError as exc:
            sock.close()
            for opened, _lbl, _p in bound:
                opened.close()
            print(
                f"tripwire: cannot listen on {label}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            sys.exit(1)
        bound.append((sock, label, port))
    return bound


def _write_leaks_json(path: str | None) -> None:
    if not path:
        return
    with _leaks_lock:
        payload = list(_leaks)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
        fh.flush()
    os.replace(tmp_path, path)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="_crucible_tripwire.py",
        description="Loopback tripwire for a hermetic run.",
    )
    parser.add_argument(
        "--endpoint",
        action="append",
        default=[],
        help="Loopback endpoint to bind (`127.0.0.1:PORT` or `[::1]:PORT`); repeatable.",
    )
    parser.add_argument(
        "--port",
        action="append",
        type=int,
        default=[],
        help="Loopback port to bind on both 127.0.0.1 and ::1; repeatable.",
    )
    parser.add_argument(
        "--leaks-json",
        default=None,
        help="Optional path to write recorded leak JSON on shutdown.",
    )
    parser.add_argument(
        "--current-test-file",
        default=None,
        help="Optional file containing the currently running test id.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    seen: set[tuple[int, str, int]] = set()
    endpoints: list[tuple[int, str, int]] = []
    for port in args.port:
        if port < 1 or port > 65535:
            print(f"tripwire: invalid port {port}", file=sys.stderr, flush=True)
            return 2
        for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            item = (family, host, port)
            if item not in seen:
                seen.add(item)
                endpoints.append(item)
    for spec in args.endpoint:
        try:
            item = _parse_endpoint(spec)
        except ValueError as exc:
            print(f"tripwire: {exc}", file=sys.stderr, flush=True)
            return 2
        if item not in seen:
            seen.add(item)
            endpoints.append(item)
    if not endpoints:
        print("tripwire: at least one --endpoint or --port is required", file=sys.stderr, flush=True)
        return 2

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: stop.set())
    signal.signal(signal.SIGINT, lambda _signum, _frame: stop.set())
    bound = _bind_all(endpoints)
    for sock, label, port in bound:
        threading.Thread(
            target=_accept_loop,
            args=(sock, label, port, args.current_test_file),
            daemon=True,
        ).start()
    _emit("tripwire listening " + " ".join(label for _sock, label, _port in bound))
    stop.wait()
    _stopping.set()
    for listener in bound:
        listener[0].close()
    with _handlers_lock:
        pending = list(_handlers)
    for worker in pending:
        worker.join()
    _write_leaks_json(args.leaks_json)
    _emit(f"tripwire drained {len(pending)} handler(s); stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
