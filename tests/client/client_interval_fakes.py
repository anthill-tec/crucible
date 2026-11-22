"""In-process fakes that observe a loaded client's intervals without waiting.

  - `FakeClock`: a `time` stand-in whose `monotonic()` moves only when the
    code under test calls its `sleep(seconds)` (or the test calls `advance`),
    counted in whole microseconds so `t + 2.0 - t` is exactly 2.0. It records
    every sleep it was asked for.
  - `RecordingEvent`: a `threading.Event` stand-in that records every timeout
    `wait` was called with and answers True at once (as a set event does), so
    a `while not event.wait(tick)` loop records one tick and ends.
  - `SynchronousThread`: a `threading.Thread` stand-in whose `start()` runs
    its target on the calling thread, to its end.
  - `fake_threading(events)`: a `threading` stand-in for one module's globals:
    the real `Lock`, `SynchronousThread`, and an `Event` that appends each
    `RecordingEvent` it makes to `events`.
  - `UrlopenResponse`: a response double for a patched `urllib.request.urlopen`.
  - `ProcessUntil`: a `subprocess.Popen` stand-in whose `poll()` answers None
    until a `FakeClock` reaches `ends_at`, then 0.

Holds no `TestCase` and no test.
"""

import json
import threading
import types


class FakeClock:
    def __init__(self, start=1000.0):
        self._micros = round(start * 1_000_000)
        self.sleeps = []

    def monotonic(self):
        return self._micros / 1_000_000

    def time(self):
        return self.monotonic()

    def advance(self, seconds):
        self._micros += round(seconds * 1_000_000)

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.advance(seconds)


class RecordingEvent:
    def __init__(self):
        self.waits = []
        self._set = False

    def wait(self, timeout=None):
        self.waits.append(timeout)
        return True

    def set(self):
        self._set = True

    def clear(self):
        self._set = False

    def is_set(self):
        return self._set


class SynchronousThread:
    def __init__(self, group=None, target=None, name=None, args=(), kwargs=None,
                 daemon=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}
        self.name = name
        self.daemon = daemon
        self._ran = False

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)
        self._ran = True

    def join(self, timeout=None):
        return None

    def is_alive(self):
        return False


def fake_threading(events):
    """A `threading` namespace whose every `Event()` is a `RecordingEvent`
    appended to `events`, and whose `Thread` runs synchronously."""
    def make_event():
        event = RecordingEvent()
        events.append(event)
        return event

    return types.SimpleNamespace(Event=make_event, Thread=SynchronousThread,
                                 Lock=threading.Lock, RLock=threading.RLock)


class UrlopenResponse:
    def __init__(self, payload=None):
        self._body = json.dumps({"ok": True} if payload is None else payload).encode()

    def read(self):
        return self._body

    def close(self):
        return None


class ProcessUntil:
    def __init__(self, clock, ends_at):
        self._clock = clock
        self._ends_at = ends_at
        self.returncode = None

    def poll(self):
        if self._clock.monotonic() >= self._ends_at:
            self.returncode = 0
        return self.returncode
