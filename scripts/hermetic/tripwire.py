"""The board-port tripwire of a hermetic run.

Listens on 127.0.0.1 and ::1, ports 3849 and 3850, INSIDE the run's isolated
network namespace (never on a host network). Every connection is a hit: it is
logged at accept() — the time, the port, the peer address and, when /proc
names it, the peer's pid, cwd and command line — then its first request line
is logged, and it is answered 503 and closed.

Output (stdout, line-buffered):

    tripwire listening 127.0.0.1:3849 [::1]:3849 127.0.0.1:3850 [::1]:3850
    HIT <time> port=<port> peer=<addr> pid=<pid> cwd=<cwd> cmd=<cmdline>
        | <first request line>
    tripwire drained <n> handler(s); stopped

The banner is printed only once all four sockets listen. On SIGTERM it stops
accepting, waits for every in-flight handler, then exits 0.

Exit codes: 0 stopped by SIGTERM after draining; 1 a socket could not bind;
3 a listening socket failed while the run was in progress.

Usage: python3 -I tripwire.py
"""

import os
import signal
import socket
import sys
import threading
import time

PORTS = (3849, 3850)
HOSTS = ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1"))
RECV_TIMEOUT_S = 2.0
RESPONSE = (b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n"
            b"Connection: close\r\n\r\n")

_out_lock = threading.Lock()
_handlers_lock = threading.Lock()
_handlers: list[threading.Thread] = []
_stopping = threading.Event()


def _emit(text: str) -> None:
    with _out_lock:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()


def _stamp() -> str:
    now = time.time()
    return time.strftime("%H:%M:%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}"


def _label(family: int, host: str, port: int) -> str:
    return f"[{host}]:{port}" if family == socket.AF_INET6 else f"{host}:{port}"


def _socket_inode(peer_port: int, server_port: int) -> str | None:
    """The inode of the CLIENT end of a connection: the socket whose local port
    is the peer's port and whose remote port is the tripwire's."""
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="ascii") as fh:
                next(fh, None)
                for line in fh:
                    parts = line.split()
                    local = int(parts[1].rsplit(":", 1)[1], 16)
                    remote = int(parts[2].rsplit(":", 1)[1], 16)
                    if local == peer_port and remote == server_port:
                        return parts[9]
        except OSError:
            continue
    return None


def _process_of_inode(inode: str) -> tuple[str, str, str] | None:
    target = f"socket:[{inode}]"
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                if os.readlink(f"/proc/{pid}/fd/{fd}") != target:
                    continue
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    cmd = fh.read().replace(b"\0", b" ").decode(errors="replace").strip()
                return pid, os.readlink(f"/proc/{pid}/cwd"), cmd[:400]
        except OSError:
            continue
    return None


def _handle(conn: socket.socket, peer: tuple, port: int) -> None:
    with conn:
        found = None
        inode = _socket_inode(peer[1], port)
        if inode is not None:
            found = _process_of_inode(inode)
        pid, cwd, cmd = found if found else ("?", "?", "?")
        _emit(f"HIT {_stamp()} port={port} peer={peer[0]}:{peer[1]} pid={pid} cwd={cwd} cmd={cmd}")
        conn.settimeout(RECV_TIMEOUT_S)
        try:
            data = conn.recv(600)
        except OSError as exc:
            data = b""
            _emit(f"    | (no request line: {exc})")
        if data:
            first = data.decode(errors="replace").split("\n", 1)[0].rstrip("\r")
            _emit(f"    | {first}")
        try:
            conn.sendall(RESPONSE)
        except OSError as exc:
            _emit(f"    | (503 not delivered: {exc})")


def _accept_loop(sock: socket.socket, label: str, port: int) -> None:
    while True:
        try:
            conn, peer = sock.accept()
        except OSError as exc:
            if _stopping.is_set():
                return
            _emit(f"tripwire: {label} failed: {exc}")
            sys.stdout.flush()
            os._exit(3)
        worker = threading.Thread(target=_handle, args=(conn, peer, port))
        with _handlers_lock:
            _handlers.append(worker)
        worker.start()


def _bind_all() -> list[tuple[socket.socket, str, int]]:
    bound = []
    for port in PORTS:
        for family, host in HOSTS:
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
                print(f"tripwire: cannot listen on {label}: {exc}", file=sys.stderr, flush=True)
                sys.exit(1)
            bound.append((sock, label, port))
    return bound


def main() -> int:
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: stop.set())
    bound = _bind_all()
    for sock, label, port in bound:
        threading.Thread(target=_accept_loop, args=(sock, label, port), daemon=True).start()
    _emit("tripwire listening " + " ".join(label for _sock, label, _port in bound))
    stop.wait()
    _stopping.set()
    for listener in bound:
        listener[0].close()
    with _handlers_lock:
        pending = list(_handlers)
    for worker in pending:
        worker.join()
    _emit(f"tripwire drained {len(pending)} handler(s); stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
