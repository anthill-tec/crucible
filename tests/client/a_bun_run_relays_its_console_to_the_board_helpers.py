"""The helpers of `test_a_bun_run_relays_its_console_to_the_board.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import time
from typing import Any

from tests.client.live_run_harness import RecordingBoard, START, STREAM_CODEC


VIEW_CODEC = "bun-console"


class ConsoleBoard(RecordingBoard):
    """`RecordingBoard` as a board built with §S1 answers a bun client.

    - `view`: health lists `bun-console` under `codecs.view` (False: the
      health of a board that has no view registry, unchanged).
    - A `bun-console` batch is held exactly as the stand-in holds a stream
      (offsets, overlap, gap, `stream_limit`); any other codec on the stream
      route is a 400.
    - `refuse_stream`: every batch is answered with that `(status, error)`
      instead, with the board's `held` (0) beside it.
    - `open_no_run`: `/api/v2/runs/start` answers `ok` with no `runId`."""

    def __init__(self, view=True, refuse_stream=None, open_no_run=False, **options):
        super().__init__(**options)
        self.refuse_stream = refuse_stream
        self.open_no_run = open_no_run
        if view:
            health = self.default_health()
            health["codecs"]["view"] = [VIEW_CODEC]
            self.script_health(health)
        board = self
        server: Any = self._httpd
        base: Any = server.RequestHandlerClass

        class _OpensNoRun(base):
            def do_POST(self):
                if self.path == START and board.open_no_run:
                    body = self._body()
                    with board._lock:
                        board.events.append((time.time(), "POST", self.path, body))
                    self._reply({"ok": True, "changed": False})
                    return
                base.do_POST(self)

        server.RequestHandlerClass = _OpensNoRun

    def _append_stream(self, run_id, body):
        if self.refuse_stream is not None:
            status, error = self.refuse_stream
            return status, {"ok": False, "error": error, "held": 0}
        body = dict(body) if isinstance(body, dict) else {}
        if body.get("codec") != VIEW_CODEC:
            return 400, {"ok": False, "error": "not a codec this board holds — nothing stored"}
        body["codec"] = STREAM_CODEC
        return super()._append_stream(run_id, body)
