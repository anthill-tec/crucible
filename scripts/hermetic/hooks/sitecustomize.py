"""The python dependency hook of a hermetic unit run.

On PYTHONPATH (this directory), it is loaded by every python process of the
run and records each real dependency a test takes: a spawned process, a
socket connect or bind, a wait on the clock (a sleep, or a timed
Condition/Event wait, thread join, queue get, select or asyncio sleep), and an
open of a watched file. It records only; it never raises into the test.

One tab-separated line per event, appended to $HERMETIC_EVENTS (an absolute
path; the hook creates the file when it loads, so an empty log still proves
the hook ran):

    <charge>\t<event>\t<detail>\t<where>

<charge> is the running test's file (and id) set by tagging_runner.py in
$HERMETIC_TEST, else the test file found on the stack (a class or module
fixture), else `-`. <where> is the top stack frame outside this hook, plus the
recording process's pid. Lines are de-duplicated per process.

$HERMETIC_WATCH: os.pathsep-joined files whose every open is recorded
(event `open-watched`).
"""

import os
import sys

_LOG = os.environ.get("HERMETIC_EVENTS")


def _install(log: str) -> None:
    seen: set[tuple[str, str, str]] = set()
    here = os.path.abspath(__file__)
    watched = {os.path.realpath(p)
               for p in os.environ.get("HERMETIC_WATCH", "").split(os.pathsep) if p}

    def charge_and_frame() -> tuple[str, str]:
        frame = sys._getframe(1)
        while frame is not None and os.path.abspath(frame.f_code.co_filename) == here:
            frame = frame.f_back
        where = f"{frame.f_code.co_filename}:{frame.f_lineno}" if frame else "?"
        test = os.environ.get("HERMETIC_TEST", "-")
        if test != "-":
            return test, where
        # class and module fixtures run outside startTest: name the test file
        # from the stack instead
        while frame is not None:
            name = frame.f_code.co_filename
            if "/tests/" in name and os.path.basename(name).startswith("test_"):
                return os.path.relpath(name), where
            frame = frame.f_back
        return "-", where

    def write(event: str, detail: str) -> None:
        charge, where = charge_and_frame()
        key = (charge, event, detail)
        if key in seen:
            return
        seen.add(key)
        try:
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(f"{charge}\t{event}\t{detail}\t{where} pid={os.getpid()}\n")
        except OSError as exc:
            sys.stderr.write(f"hermetic hook: cannot record to {log}: {exc}\n")

    def words_of(argv: object) -> str:
        if isinstance(argv, (list, tuple)):
            words = [a.decode(errors="replace") if isinstance(a, bytes) else os.fspath(a)
                     for a in argv[:3]]
        else:
            words = [str(argv)[:120]]
        return " ".join(os.path.basename(w) if i == 0 else w for i, w in enumerate(words))[:160]

    def address_of(addr: object) -> str:
        if isinstance(addr, tuple) and len(addr) >= 2:
            port = addr[1]
            return f"{addr[0]}:{'ephemeral' if port == 0 else port}"
        return str(addr)[:120]

    def hook(event: str, args: tuple) -> None:
        if event == "subprocess.Popen":
            write("spawn", words_of(args[1]))
        elif event in ("os.posix_spawn", "os.exec"):
            write("spawn", os.path.basename(os.fsdecode(args[0]))[:120])
        elif event == "os.spawn":
            # (mode, path, args, env)
            write("spawn", os.path.basename(os.fsdecode(args[1]))[:120])
        elif event == "os.system":
            write("spawn", os.fsdecode(args[0])[:120])
        elif event == "socket.connect":
            write("connect", address_of(args[1]))
        elif event == "socket.bind":
            write("bind", address_of(args[1]))
        elif event == "time.sleep":
            # a zero sleep is a yield, not a wait on the clock
            if not (isinstance(args[0], (int, float)) and args[0] <= 0):
                write("wait", "time.sleep")
        elif event == "open" and watched:
            path = args[0]
            # The event carries no dir_fd: a relative path may be relative to
            # an open directory, so only an absolute path is attributed.
            if isinstance(path, (str, bytes)) and os.path.isabs(os.fsdecode(path)):
                real = os.path.realpath(os.fsdecode(path))
                if real in watched:
                    write("open-watched", real)

    def timed(value: object) -> bool:
        return isinstance(value, (int, float)) and value > 0

    def wrap_wait(owner: object, attr: str, label: str, pick) -> None:
        orig = getattr(owner, attr, None)
        if orig is None:
            return

        def wrapper(*a, **k):
            if timed(pick(a, k)):
                write("wait", label)
            return orig(*a, **k)

        setattr(owner, attr, wrapper)

    import asyncio
    import queue
    import select
    import threading

    try:
        with open(log, "a", encoding="utf-8"):
            pass
    except OSError as exc:
        sys.stderr.write(f"hermetic hook: cannot create {log}: {exc}\n")
    sys.addaudithook(hook)
    wrap_wait(threading.Condition, "wait", "Condition.wait",
              lambda a, k: k.get("timeout", a[1] if len(a) > 1 else None))
    wrap_wait(threading.Thread, "join", "Thread.join",
              lambda a, k: k.get("timeout", a[1] if len(a) > 1 else None))
    wrap_wait(queue.Queue, "get", "Queue.get",
              lambda a, k: k.get("timeout", a[2] if len(a) > 2 else None)
              if k.get("block", a[1] if len(a) > 1 else True) else None)
    wrap_wait(select, "select", "select",
              lambda a, k: k.get("timeout", a[3] if len(a) > 3 else None))
    wrap_wait(asyncio, "sleep", "asyncio.sleep",
              lambda a, k: k.get("delay", a[0] if a else None))


if _LOG:
    _install(_LOG)
