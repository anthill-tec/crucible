"""Shared fixtures for the real-subprocess live-run tests: a stand-in HTTP
board that records every request in wire order, a project installer that
points a client at it, fake runners for each stack, and two drivers — one
that proves the runner's output streams live (a marker printed before a
blocked test must reach stderr while the test is still blocked), one that
interrupts a run mid-suite with a signal.

Never the live :3849/:3850 Crucible server and never a real toolchain: every
runner here is a small python program speaking the real tool's output shape.
"""

import atexit
import contextlib
import http.server
import importlib.util
import json
import os
import platform
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from tests.client import CLIENT_SOURCE_DIR, TEST_INSTALL_CLIENTS

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = TEST_INSTALL_CLIENTS
SHIPPED_TOML = CLIENT_SOURCE_DIR / "crucible.toml"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE", "PY_CRUCIBLE_PYTHON", "REPORTS_DIR",
                     "COVERAGE_DIR", "CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT")

START = "/api/v2/runs/start"
INGEST_PATHS = ("/api/v2/runs", "/api/v2/runs/parsed", "/api/v2/runs/compile")

# The board's health, as a board that decodes the clients' reports states it:
# the codec names it decodes, the largest ingest body it reads, and its
# version. Both health routes answer it.
HEALTH_PATHS = ("/api/health", "/api/v2/health")
HEALTH_VERSION = "0.4.0"
HEALTH_CODECS = {"test": ["crucible-events", "go-test", "junit", "nextest"],
                 "coverage": ["jacoco", "lcov"],
                 "stream": ["crucible-events", "go-test", "nextest"]}
# The stream codec a python unittest run's record is written in (CR-CRU-224),
# and the open run's stream route a client relays it to (CR-CRU-200 §S2).
STREAM_CODEC = "crucible-events"
STREAM_ROUTE = re.compile(r"^/api/v2/runs/([^/]+)/stream$")
# The record stream nextest writes (`libtest-json-plus`), and every codec an
# open run's stream route takes: a run's first batch fixes its codec.
NEXTEST_STREAM_CODEC = "nextest"
# The stream `go test -json` writes, decoded on the board by `go-test`.
GO_TEST_STREAM_CODEC = "go-test"
STREAM_CODECS = (STREAM_CODEC, NEXTEST_STREAM_CODEC, GO_TEST_STREAM_CODEC)
# An open run's test list route, and the codec nextest's own list is posted
# under (`cargo nextest list --message-format json`).
TESTS_ROUTE = re.compile(r"^/api/v2/runs/([^/]+)/tests$")
TEST_LIST_CODEC = "nextest-list"
# The shipped recommendation for `ingest_body_bytes` (128 MiB).
DEFAULT_INGEST_BODY_BYTES = 128 * 1024 * 1024
# The `run` block `/api/v2/runs` answers with until a test scripts its own.
DEFAULT_RUN_BLOCK = {"total": 0, "passed": 0, "failed": 0}
# The ways `RecordingBoard.drop_next` can break a connection it has read.
DROP_SHAPES = ("close", "reset", "truncate", "truncate-error", "garble")

# The answer shapes of the board's reads, as `src/v2.ts` returns them with
# nothing held, for a test to hand to `RecordingBoard.answer` (filled in with
# its own rows). The board answers none of them unscripted.
# `handleProjectMilestones` -- `GET .../projects/<key>/milestones?type=`.
MILESTONES_ANSWER = {"ok": True, "milestones": [], "totalCount": 0}
# `handleEventsList` -- `GET /api/v2/events?project=` (newest first).
EVENTS_ANSWER = {"ok": True, "events": [], "openRuns": []}
# `handleQueueGet` -- `GET .../projects/<key>/queue`.
QUEUE_ANSWER = {"ok": True, "entries": [], "tracks": []}
# `handleProjectHistory` -- `GET .../projects/<key>/history`.
HISTORY_ANSWER = {"ok": True, "releases": [], "acceptedFailingGates": []}
# `handlePlansList` -- `GET .../projects/<key>/plans[?status=]`.
PLANS_ANSWER = {"ok": True, "plans": [], "lastClosedCr": None, "filed": 0}
# `handleProjectMetadataGet` -- `GET .../projects/<key>/metadata`.
METADATA_ANSWER = {"ok": True, "metadata": {}}
# `handleMilestones` -- `POST /api/v2/milestones`, a new record: 201 with
# the event id the store minted (see `milestone_posted`).
MILESTONE_POSTED_STATUS = 201


def milestone_posted(event_id):
    """`handleMilestones`' answer to a recorded milestone (`src/v2.ts`):
    `{ok, changed, event}`, given with `MILESTONE_POSTED_STATUS`."""
    return {"ok": True, "changed": True, "event": event_id}


def _health_codecs(stream_codec=True, nextest_stream=True):
    """A copy of `HEALTH_CODECS`, without the stream codec when the board is
    one that decodes no stream, and without `nextest` under `codecs.stream`
    when it is one that takes no nextest stream."""
    codecs = json.loads(json.dumps(HEALTH_CODECS))
    if not stream_codec:
        codecs["test"] = [name for name in codecs["test"] if name != STREAM_CODEC]
        codecs["stream"] = [name for name in codecs["stream"] if name != STREAM_CODEC]
    if not nextest_stream:
        codecs["stream"] = [name for name in codecs["stream"]
                            if name != NEXTEST_STREAM_CODEC]
    return codecs


def nextest_list_matches(text):
    """The tests a nextest list (`--message-format json`) matches: those whose
    `filter-match` is `matches`, as the board counts the listed total. None
    when `text` is not a nextest list."""
    try:
        listed = json.loads(text)
        suites = listed["rust-suites"]
        return sum(1 for suite in suites.values()
                   for case in (suite.get("testcases") or {}).values()
                   if (case.get("filter-match") or {}).get("status") == "matches")
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def board_health(ingest_body_bytes=DEFAULT_INGEST_BODY_BYTES, stream_codec=True):
    """The health a board that decodes the clients' reports answers: what
    `RecordingBoard` answers unscripted, for an in-process `_get` stub. With
    `stream_codec` False it is a board that decodes no `crucible-events`."""
    return {"ok": True, "status": "healthy", "version": HEALTH_VERSION,
            "codecs": _health_codecs(stream_codec),
            "limits": {"ingest_body_bytes": ingest_body_bytes}}


def get_answering_health(fallback=None):
    """A `_get` side effect for an in-process client drive: the board's health
    (`board_health`) on the health routes, and on every other read
    `fallback(path)` when it is callable, else `fallback` itself, else a
    tolerant failure."""
    def _get(path, timeout=10):
        if path in HEALTH_PATHS:
            return board_health()
        if callable(fallback):
            return fallback(path)
        return fallback if fallback is not None else {"ok": False,
                                                      "error": "mocked"}
    return _get


def load_toon():
    spec = importlib.util.spec_from_file_location("toon_for_live_run_tests",
                                                  CLIENTS / "toon.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_client(name):
    """Import one `clients/<name>-crucible.py` (or `_crucible_axi.py`) by path."""
    path = CLIENTS / name
    spec = importlib.util.spec_from_file_location(
        "live_run_" + name.replace("-", "_").replace(".", "_"), path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingBoard:
    """A real `ThreadingHTTPServer` on loopback that records every request in
    wire order with its receipt time, opens a run on `/api/v2/runs/start` and
    answers everything else `ok`.

    Health (`HEALTH_PATHS`) is answered as a board that decodes the clients'
    reports states it \u2014 `version`, `codecs` and `limits.ingest_body_bytes`
    (`ingest_body_bytes`, the shipped 128 MiB unless a test names its own) \u2014
    unless a test scripts another answer (`script_health`) or a failure
    (`fail_health`). `/api/v2/runs` answers with the `run` block a test
    scripts (`script_run`); the board decodes nothing it is sent.

    An open run's stream (`POST /api/v2/runs/<runId>/stream`) is held as the
    real board holds it (`appendRunStream`, src/run-stream.ts): a batch is
    appended at the UTF-8 byte offset its `from` states and answered `200
    {ok, runId, held}`; a gap or an overlap that differs from the held bytes
    is a 409 carrying `held`; a total past `stream_limit` (default
    `ingest_body_bytes`) is a 413 carrying `held`. `stream_codec=False` is a
    board whose health lists no `crucible-events`; `stream_route=False` is a
    board with no stream route at all (every batch a 404).

    A test sets the answer to any request by method and path (`answer`),
    refusals included, from the server's own shapes (`MILESTONES_ANSWER` and
    its siblings above); ids and timestamps it lists are minted as the store
    mints them (`mint_event_id`, `milestone_record`)."""

    def __init__(self, ingest_body_bytes=DEFAULT_INGEST_BODY_BYTES,
                 stream_codec=True, stream_route=True, stream_limit=None,
                 nextest_stream=True):
        self.nextest_stream = nextest_stream
        # Each open run's stream codec, fixed by its first batch, and its
        # test list (`/api/v2/runs/<runId>/tests`): the list's text, and the
        # scripted answer to the next list (a refusal status, or a total
        # that replaces the counted one). Default off.
        self._stream_codecs = {}
        self._lists = {}
        self._list_refusals = []
        self._list_total = None
        self.events = []  # [(received_at, method, path, body)]
        self.ingest_body_bytes = ingest_body_bytes
        self.stream_codec = stream_codec
        self.stream_route = stream_route
        self.stream_limit = (ingest_body_bytes if stream_limit is None
                             else stream_limit)
        # Each open run's held stream, as the UTF-8 bytes the board holds.
        self._streams = {}
        # Scripted health: a whole answer that replaces the default one, or a
        # non-200 failure `(status, error)`. Both default off.
        self._health_override = None
        self._health_failure = None
        # The `run` block `/api/v2/runs` answers with, and the `warnings[]` it
        # answers beside it (none until a test scripts them).
        self._run_block = dict(DEFAULT_RUN_BLOCK)
        self._run_warnings = None
        # The coverage files `/api/v2/runs` answers the run kept (none until a
        # test scripts them): see `script_coverage_files`.
        self._run_coverage_files = None
        self._lock = threading.Lock()
        self._run_seq = 0
        # CR-CRU-170 \u00a7S2 \u2014 scripted refusals, so a RED test can drive the real
        # abort-posting path both ways: the board answering the client's own
        # `POST .../abort` non-ok (board refuses the close), and the board
        # answering a runId-carrying ingest non-ok (the exit \u00a7S2's table calls
        # "the board refused the ingest that carried the runId"). Both default
        # to off \u2014 every pre-existing drive that never calls `refuse_next_abort`/
        # `refuse_ingest_for` sees the unchanged all-`ok` board.
        self._refuse_abort_remaining = 0
        self._refuse_abort_status = 409
        self._refuse_ingest_run_id = None
        self._refuse_ingest_remaining = 0
        self._refuse_ingest_status = 409
        # CR-CRU-171 \u00a7S2 \u2014 a scripted refusal of `/api/v2/runs/start` itself,
        # so a RED test can drive the client's existing `ReleaseRunRefused`
        # hard-stop (a release run that the board declines to open \u2014 an
        # undeclared release, or a release beside a cycle) against ANY
        # client/verb via a real subprocess, without needing a bespoke
        # in-process fake per stack. Default off, like the two above: every
        # pre-existing drive that never calls `refuse_next_start` sees the
        # unchanged always-opens board.
        self._refuse_start_remaining = 0
        self._refuse_start_error = "run refused"
        # CR-CRU-180 \u00a7S1 \u2014 a scripted HELD answer, so a RED test can land a
        # signal while the client is still waiting on one POST's answer (the
        # window a slow runner widens: the board has RECORDED the call, the
        # client has not yet READ its reply). Default off, like the scripted
        # refusals above.
        self._hold_path = None
        self._hold_released = threading.Event()
        # Scripted DROPPED connections: the next POST to a path (and, when a
        # stack is named, carrying that body `stack`) is recorded as usual and
        # then answered with a broken connection of one shape \u2014 see
        # `drop_next`. None by default, like the scripted refusals above.
        self._drops = []
        self._refuse_abort_error = "abort refused"
        # A scripted refusal of one cycle binding: None by default, like the
        # scripted refusals above. See `refuse_cycle_binding`.
        self._refused_binding = None
        self._active_cycle = None
        self._held_agents = set()
        # Answers a test set for a method and path (`answer`): newest first,
        # each `[method, path, prefix, status, body, remaining]`. None set by
        # default, so every request keeps the answer described above.
        self._answers = []
        # The store's event-id sequence (`mint_event_id`).
        self._event_seq = 0
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    return json.loads(raw.decode() or "null")
                except ValueError:
                    return None

            def _reply(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def _reply_status(self, status, payload):
                """A non-200 JSON reply \u2014 `urllib`'s client side raises `HTTPError`
                for it, which `_crucible_axi.http_request` turns into the real
                `{ok: False, error}` shape a genuine refusal (400/409) produces.
                Used only by the scripted-refusal branches below."""
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with board._lock:
                    board.events.append((time.time(), "GET", self.path, None))
                    health = board._health_answer()
                    failure = board._health_failure
                scripted = board._scripted_answer(self.command, self.path)
                if scripted is not None:
                    self._reply_status(*scripted)
                elif self.path in HEALTH_PATHS:
                    if failure is not None:
                        status, error = failure
                        self._reply_status(status, {"ok": False, "error": error})
                    else:
                        self._reply(health)
                elif "/plans" in self.path:
                    self._reply({"ok": True, "plans": board._open_plans()})
                else:
                    self._reply({"ok": True, "agents": []})

            def _drop_connection(self, shape):
                """Break this connection in one of `DROP_SHAPES`, after the
                request has been read in full."""
                if shape == "close":
                    self.close_connection = True
                elif shape == "reset":
                    # SO_LINGER 0 turns the close into a TCP reset.
                    self.connection.setsockopt(
                        socket.SOL_SOCKET, socket.SO_LINGER,
                        struct.pack("ii", 1, 0))
                    self.connection.close()
                elif shape in ("truncate", "truncate-error"):
                    body = json.dumps({"ok": True, "changed": True,
                                       "run": DEFAULT_RUN_BLOCK}).encode()
                    self.send_response(200 if shape == "truncate" else 500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body) + 64))
                    self.end_headers()
                    self.wfile.write(body[: len(body) // 2])
                    self.wfile.flush()
                    self.close_connection = True
                elif shape == "garble":
                    self.wfile.write(b"GARBLED STATUS\r\n\r\n")
                    self.wfile.flush()
                    self.close_connection = True
                else:
                    raise ValueError(f"unknown drop shape {shape!r}")

            def do_POST(self):
                body = self._body()
                with board._lock:
                    # Logged under the method it came in on: a PATCH (routed
                    # here by `do_PATCH`) is logged as a PATCH.
                    board.events.append((time.time(), self.command, self.path, body))
                    held = board._hold_path == self.path
                    if held:
                        board._hold_path = None
                    stack = body.get("stack") if isinstance(body, dict) else None
                    drop = next((d for d in board._drops if d[0] == self.path
                                 and d[2] in (None, stack)), None)
                    if drop is not None:
                        board._drops.remove(drop)
                if drop is not None:
                    self._drop_connection(drop[1])
                    return
                if held:
                    board._hold_released.wait(timeout=30)
                scripted = board._scripted_answer(self.command, self.path)
                if scripted is not None:
                    self._reply_status(*scripted)
                    return
                refused = board._caller_refusal(self.path, body)
                if refused is not None:
                    self._reply_status(*refused)
                    return
                listed = TESTS_ROUTE.match(self.path)
                streamed = STREAM_ROUTE.match(self.path)
                if listed is not None:
                    status, answer = board._take_list(
                        urllib.parse.unquote(listed.group(1)), body)
                    if status == 200:
                        self._reply(answer)
                    else:
                        self._reply_status(status, answer)
                elif streamed is not None:
                    status, answer = board._append_stream(
                        urllib.parse.unquote(streamed.group(1)), body)
                    if status == 200:
                        self._reply(answer)
                    else:
                        self._reply_status(status, answer)
                elif self.path == START:
                    refuse, error = False, None
                    with board._lock:
                        if board._refuse_start_remaining > 0:
                            board._refuse_start_remaining -= 1
                            refuse, error = True, board._refuse_start_error
                    if refuse:
                        self._reply({"ok": False, "error": error})
                        return
                    with board._lock:
                        board._run_seq += 1
                        run_id = f"run-live-{board._run_seq}"
                    self._reply({"ok": True, "changed": True, "runId": run_id,
                                 "startedAt": int(time.time() * 1000)})
                elif self.path.startswith("/api/v2/runs/") and self.path.endswith("/abort"):
                    refuse, status = False, 409
                    with board._lock:
                        if board._refuse_abort_remaining > 0:
                            board._refuse_abort_remaining -= 1
                            refuse, status = True, board._refuse_abort_status
                    if refuse:
                        self._reply_status(status, {"ok": False,
                                                    "error": board._refuse_abort_error})
                    else:
                        run_id = (body or {}).get("runId") if isinstance(body, dict) else None
                        reason = (body or {}).get("reason") if isinstance(body, dict) else None
                        self._reply({"ok": True, "changed": True, "runId": run_id,
                                     "status": "aborted", "reason": reason})
                elif self.path in INGEST_PATHS:
                    run_id = (body or {}).get("runId") if isinstance(body, dict) else None
                    refuse, status = False, 409
                    with board._lock:
                        if (board._refuse_ingest_run_id is not None
                                and run_id == board._refuse_ingest_run_id
                                and board._refuse_ingest_remaining > 0):
                            board._refuse_ingest_remaining -= 1
                            refuse, status = True, board._refuse_ingest_status
                    if refuse:
                        self._reply_status(status, {"ok": False, "error": "ingest refused"})
                    elif self.path == "/api/v2/runs":
                        with board._lock:
                            run_block = json.loads(json.dumps(board._run_block))
                            run_warnings = board._run_warnings
                            kept_files = board._run_coverage_files
                        answer = {"ok": True, "changed": True, "run": run_block}
                        if kept_files is not None:
                            answer = {"ok": True, "changed": True,
                                      "event": kept_files["event"], "run": run_block}
                            run_block["coverageFileCount"] = kept_files["count"]
                            run_block["coverageFiles"] = json.loads(
                                json.dumps(kept_files["files"]))
                        if run_warnings is not None:
                            answer["warnings"] = json.loads(json.dumps(run_warnings))
                        self._reply(answer)
                    else:
                        self._reply({"ok": True, "changed": True})
                else:
                    self._reply({"ok": True, "changed": True})

            def do_PATCH(self):
                self.do_POST()

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        # A short poll: `shutdown()` waits for the loop's next poll, so the
        # stock half-second poll made every `close()` wait up to 0.5 s.
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        kwargs={"poll_interval": 0.05}, daemon=True)
        self._thread.start()

    def close(self):
        self._hold_released.set()
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    def _health_answer(self):
        """The health answer as it stands (the caller holds the lock)."""
        if self._health_override is not None:
            return json.loads(json.dumps(self._health_override))
        return {"ok": True, "status": "healthy", "version": HEALTH_VERSION,
                "codecs": _health_codecs(self.stream_codec, self.nextest_stream),
                "limits": {"ingest_body_bytes": self.ingest_body_bytes}}

    def _take_list(self, run_id, body):
        """One test list, taken as the real board takes it (`handleRunTests`,
        src/v2.ts): codec `nextest-list` and a nextest list's text, once per
        run, answered `200 {ok, runId, total}` with the listed total (the
        matching tests). A scripted refusal answers its status instead and
        takes nothing. Returns `(status, answer)`."""
        body = body if isinstance(body, dict) else {}
        with self._lock:
            if self._list_refusals:
                status, error = self._list_refusals.pop(0)
                return status, {"ok": False, "error": error}
            if body.get("codec") != TEST_LIST_CODEC:
                return 400, {"ok": False, "error": (
                    f"codec {body.get('codec')!r} is not {TEST_LIST_CODEC} — "
                    f"nothing stored")}
            data = body.get("data")
            total = nextest_list_matches(data) if isinstance(data, str) else None
            if total is None:
                return 400, {"ok": False, "error": (
                    "data must be nextest's test list as its JSON text — "
                    "nothing stored")}
            if run_id in self._lists:
                return 409, {"ok": False, "error": (
                    f"run {run_id} already holds its test list — nothing stored")}
            self._lists[run_id] = data
            if self._list_total is not None:
                total = self._list_total
            return 200, {"ok": True, "runId": run_id, "total": total}

    def refuse_next_list(self, status, error=None):
        """Answer the next test list `status` (`{ok: False, error}`) and take
        nothing: 400 (not a list), 409 (a settled run, or a second list) or
        413 (past `ingest_body_bytes`). Each call scripts one more."""
        with self._lock:
            self._list_refusals.append(
                (status, error or f"the test list is refused ({status}) — "
                                  f"nothing stored"))

    def script_list_total(self, total):
        """Answer every test list taken from now on with this `total`, in
        place of the count of its matching tests."""
        with self._lock:
            self._list_total = total

    def list_posts(self):
        """`[(path, body), ...]` for every test list POST, in wire order."""
        return [(p, b) for p, b in self.posts() if TESTS_ROUTE.match(p)]

    def held_list(self, run_id):
        """The test list text the board took for `run_id`, or None."""
        with self._lock:
            return self._lists.get(run_id)

    def stream_codec_of(self, run_id):
        """The codec `run_id`'s first stream batch fixed, or None."""
        with self._lock:
            return self._stream_codecs.get(run_id)

    def _append_stream(self, run_id, body):
        """One stream batch, held as the real board holds it. Returns
        `(status, answer)`."""
        if not self.stream_route:
            return 404, {"ok": False, "error": f"no route: /api/v2/runs/{run_id}/stream"}
        body = body if isinstance(body, dict) else {}
        start, data = body.get("from"), body.get("data")
        if (isinstance(start, bool) or not isinstance(start, int) or start < 0
                or not isinstance(data, str)):
            return 400, {"ok": False, "error": "malformed stream batch — nothing stored"}
        codec = body.get("codec", STREAM_CODEC)
        if codec not in STREAM_CODECS:
            return 400, {"ok": False, "error": "not a stream codec — nothing stored"}
        incoming = data.encode("utf-8")
        with self._lock:
            fixed = self._stream_codecs.setdefault(run_id, codec)
            if fixed != codec:
                return 400, {"ok": False, "error": (
                    f"the run's stream is {fixed}, not {codec} — nothing stored")}
            held = self._streams.setdefault(run_id, bytearray())
            size = len(held)
            if start > size:
                return 409, {"ok": False, "held": size,
                             "error": f"a batch from {start} leaves a gap after the {size} bytes held"}
            overlap = min(size - start, len(incoming))
            if bytes(held[start:start + overlap]) != incoming[:overlap]:
                return 409, {"ok": False, "held": size,
                             "error": f"a batch from {start} differs from the bytes held across its overlap"}
            if start + len(incoming) > self.stream_limit:
                return 413, {"ok": False, "held": size,
                             "error": "the stream would pass ingest_body_bytes — the run's stream is marked cut"}
            held.extend(incoming[overlap:])
            return 200, {"ok": True, "runId": run_id, "held": len(held)}

    def held_stream(self, run_id):
        """The text the board holds as `run_id`'s stream (`""` for none)."""
        with self._lock:
            return bytes(self._streams.get(run_id, b"")).decode("utf-8")

    def stream_posts(self):
        """`[(path, body), ...]` for every stream batch, in wire order."""
        return [(p, b) for p, b in self.posts() if STREAM_ROUTE.match(p)]

    def default_health(self):
        """A copy of the health this board answers unscripted, for a test to
        alter and hand to `script_health` (drop `codecs`, drop `limits`, ...)."""
        with self._lock:
            override, self._health_override = self._health_override, None
            answer = self._health_answer()
            self._health_override = override
        return answer

    def script_health(self, health):
        """Answer both health routes with `health`, whole, from now on \u2014 an
        older board's health (no `codecs`), one with `codecs` but no `limits`,
        or one whose `version` a test names."""
        with self._lock:
            self._health_override = json.loads(json.dumps(health))
            self._health_failure = None

    def fail_health(self, status=503, error="health unavailable"):
        """Answer both health routes non-200 (`{ok: False, error}`, HTTP
        `status`) from now on: health that cannot be read, on a board that
        still answers every other route."""
        with self._lock:
            self._health_failure = (status, error)

    def script_run(self, passed=0, failed=0, pending=0, total=None, files=None,
                   coverage=None, warnings=None):
        """Answer `/api/v2/runs` with this `run` block from now on. `total`
        defaults to the sum of the three; `files` and `coverage` (the coverage
        the board kept, `{lines, functions}`) join the block only when given,
        and `warnings` (the board's own `[{code, detail}]`) joins the answer
        beside it only when given. The board decodes nothing: the answer is
        what the test scripted."""
        block = {"passed": passed, "failed": failed, "pending": pending,
                 "total": passed + failed + pending if total is None else total}
        if files is not None:
            block["files"] = files
        if coverage is not None:
            block["coverage"] = json.loads(json.dumps(coverage))
        with self._lock:
            self._run_block = block
            self._run_warnings = (None if warnings is None
                                  else json.loads(json.dumps(warnings)))

    def script_coverage_files(self, event, file_count, files):
        """Answer `/api/v2/runs` as a board that kept the run's coverage file
        by file, from now on: the run's id `event` at the answer's top level,
        and in the `run` block `script_run` scripted, `coverageFileCount`
        (`file_count`) and `coverageFiles` (`files`: the least covered ones,
        each `{path, lines, functions?}`, in the order given). Until a test
        calls this the answer carries none of the three, whatever `script_run`
        scripted. The board decodes nothing: the answer is what the test
        scripted."""
        with self._lock:
            self._run_coverage_files = {
                "event": event, "count": file_count,
                "files": json.loads(json.dumps(files))}

    def health_reads(self):
        """Every GET of a health route, in wire order."""
        with self._lock:
            return [p for _, m, p, _b in self.events
                    if m == "GET" and p in HEALTH_PATHS]

    def posts(self):
        """`[(path, body), ...]` for every POST and PATCH, in wire order --
        every write the board took; `patches()` keeps only the PATCHes."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events if m in ("POST", "PATCH")]

    def patches(self):
        """`[(path, body), ...]` for every PATCH, in wire order (a subset of
        `posts()`), so a test can assert a write came in as a PATCH."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events if m == "PATCH"]

    def aborts(self):
        """CR-CRU-170 \u00a7S2 \u2014 `[(path, body), ...]` for every `POST
        /api/v2/runs/<runId>/abort`, in wire order (a strict subset of
        `posts()`, filtered the same way the live-run tests already filter
        `paths` for `"abort" in p`)."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events
                   if m == "POST" and p.startswith("/api/v2/runs/") and p.endswith("/abort")]

    def drop_next(self, path, shape, stack=None):
        """Record the next `POST path` as usual, then break its connection
        instead of answering it, in one of `DROP_SHAPES`: `close` (closed
        after the request is read, no answer), `reset` (a TCP reset),
        `truncate` (a 200 whose body stops short of its `Content-Length`),
        `truncate-error` (the same, as a 500) or `garble` (a status line that
        is not HTTP). With `stack`, only a POST whose body carries that
        `stack` is dropped. Only the NEXT such call is dropped; each call
        scripts one more drop."""
        if shape not in DROP_SHAPES:
            raise ValueError(f"unknown drop shape {shape!r}")
        with self._lock:
            self._drops.append((path, shape, stack))

    def refuse_next_abort(self, times=1, status=409, error="abort refused"):
        """CR-CRU-170 \u00a7S2 \u2014 script the next `times` `POST .../abort` calls to
        answer non-ok (`{ok: False}`, HTTP `status`) instead of settling the
        run \u2014 the board REFUSING the client's own close, so a RED test can
        drive the `run-left-open` fallback the spec requires when the abort
        itself fails. The call is still recorded in `posts()`/`aborts()`
        exactly as a successful one would be."""
        with self._lock:
            self._refuse_abort_remaining = times
            self._refuse_abort_status = status
            self._refuse_abort_error = error

    def refuse_next_start(self, times=1, error="run refused"):
        """CR-CRU-171 \u00a7S2 \u2014 script the next `times` `POST /api/v2/runs/start`
        calls to answer `{ok: False, error}` (HTTP 200, the same shape the
        real server's `resolveReleaseAttach` 400 produces once `_post` decodes
        it) instead of opening a run \u2014 the board REFUSING to open the run at
        all, so a RED test can drive the client's existing `ReleaseRunRefused`
        hard-stop (CR-CRU-164 \u00a7S1: an undeclared release, or a release beside
        a cycle) for ANY client/verb via a real subprocess. The call is still
        recorded in `posts()` exactly as a successful one would be, and no
        `runId` is ever handed out for a refused call."""
        with self._lock:
            self._refuse_start_remaining = times
            self._refuse_start_error = error

    def refuse_cycle_binding(self, cycle_id, active_cycle_id):
        """Answer as a board whose project has `active_cycle_id` active and
        `cycle_id` done, from now on: a register or heartbeat binding
        `cycle_id` is refused 409 with the real board's words
        (`validateCycleBinding`, src/v2.ts) and touches no agent; the open
        plans read names both cycles; and, as the real board's
        `requireRegisteredCaller` does, every `/api/v2/runs` POST from an
        agent no accepted touch has registered is refused 409."""
        with self._lock:
            self._refused_binding = cycle_id
            self._active_cycle = active_cycle_id

    def binding_refusal_error(self):
        """The words a refused binding is answered with."""
        return (f"cycle {self._refused_binding} is done \u2014 bindings "
                f"require an ACTIVE cycle")

    def _open_plans(self):
        with self._lock:
            active, done = self._active_cycle, self._refused_binding
        if active is None:
            return []
        return [{"planId": 1, "cr": "CR-T-BINDING", "status": "open",
                 "cycles": [{"id": active, "status": "active"},
                            {"id": done, "status": "done"}]}]

    def _caller_refusal(self, path, body):
        """`(status, answer)` for a POST the scripted binding refusal
        refuses, or None (always None until `refuse_cycle_binding`)."""
        body = body if isinstance(body, dict) else {}
        agent = body.get("agentId")
        with self._lock:
            if self._refused_binding is None:
                return None
            if path in ("/api/v2/agents/register", "/api/v2/agents/heartbeat"):
                if body.get("cycleId") == self._refused_binding:
                    return 409, {"ok": False,
                                 "error": self.binding_refusal_error()}
                if agent:
                    self._held_agents.add(agent)
                return None
            if path.startswith("/api/v2/runs") and agent not in self._held_agents:
                return 409, {"ok": False, "error": (
                    f"agent {agent} is not registered with this project "
                    f"\u2014 refused")}
        return None

    def refuse_ingest_for(self, run_id, times=1, status=409):
        """CR-CRU-170 \u00a7S2 \u2014 script the next `times` ingest POSTs (any of
        `INGEST_PATHS`) that carry `runId == run_id` to answer non-ok \u2014 "the
        board refused the ingest that carried the runId", the third exit in
        \u00a7S2's table. An ingest for a DIFFERENT runId, or one carrying none, is
        answered exactly as the unscripted board answers it."""
        with self._lock:
            self._refuse_ingest_run_id = run_id
            self._refuse_ingest_remaining = times
            self._refuse_ingest_status = status

    def hold_next_reply(self, path):
        """CR-CRU-180 \u00a7S1 \u2014 record the next `POST path` as usual but withhold
        its answer until `release_held()` (or `close()`), so the client stays
        blocked on that call for exactly as long as the test needs. Only the
        NEXT such call is held; every other request is answered at once."""
        with self._lock:
            self._hold_released.clear()
            self._hold_path = path

    def release_held(self):
        """CR-CRU-180 \u00a7S1 \u2014 answer the call `hold_next_reply` withheld."""
        self._hold_released.set()

    def received_at(self, post_index):
        with self._lock:
            return [t for t, m, _p, _b in self.events
                    if m in ("POST", "PATCH")][post_index]

    def messages(self):
        """Every heartbeat message, in wire order."""
        return [b.get("message") for p, b in self.posts()
                if p.endswith("/agents/heartbeat") and isinstance(b, dict)
                and isinstance(b.get("message"), str)]

    def run_ids_opened(self):
        return [f"run-live-{i}" for i in range(1, self._run_seq + 1)]

    def answer(self, method, path, body, status=200, prefix=False, times=None):
        """Answer `method` (`GET`, `POST`, `PATCH`) on `path` with `status`
        and the JSON `body` (a copy, taken now) -- a refusal is a non-200
        status and its `{ok: False, error}` body. `path` is the request path
        with its query, matched exactly, or as a prefix when `prefix`. With
        `times` the answer is given for the next `times` such requests only;
        without, for every one. The answer set last wins; the request is
        still recorded, and a request no answer matches keeps the board's own
        answer."""
        if times is not None and times < 1:
            raise ValueError(f"times must be at least 1, not {times!r}")
        copied = json.loads(json.dumps(body))
        with self._lock:
            self._answers.insert(0, [method.upper(), path, prefix, status,
                                     copied, times])

    def _scripted_answer(self, method, path):
        """`(status, body)` of the answer set for this request, or None."""
        with self._lock:
            for entry in self._answers:
                verb, wanted, prefix, status, body, remaining = entry
                if verb != method:
                    continue
                if not (path.startswith(wanted) if prefix else path == wanted):
                    continue
                if remaining is not None:
                    entry[5] = remaining - 1
                    if entry[5] == 0:
                        self._answers.remove(entry)
                return status, json.loads(json.dumps(body))
        return None

    def mint_event_id(self, at_ms=None):
        """An event id as the store mints one (`Store.nextEventId`,
        src/store.ts): `evt-<ms>-<seq>`, `<ms>` the epoch milliseconds (now,
        or `at_ms`) and `<seq>` this board's own sequence, one higher on every
        call and never reset -- so ids minted within one millisecond differ
        only by a sequence that grows past two digits (`-100` after `-59`)."""
        at = int(time.time() * 1000) if at_ms is None else int(at_ms)
        with self._lock:
            self._event_seq += 1
            seq = self._event_seq
        return f"evt-{at}-{seq}"

    def milestone_record(self, project_key, agent_id, milestone_type, label,
                         at_ms=None, **fields):
        """One milestone as `handleProjectMilestones` lists it (`Store.toEvent`
        over a record `recordMilestoneEvent` wrote, src/store.ts): a minted
        `id` and its millisecond `timestamp`, the posting project and agent,
        `kind` `milestone`, `tier` `unit`, the `type` (`milestone_type`) and
        `label`, and any
        further `fields` (a gate's `outcome`, `scope`, `suites`, a `commit`)
        as given. For a test to list in `MILESTONES_ANSWER`."""
        at = int(time.time() * 1000) if at_ms is None else int(at_ms)
        record = {"id": self.mint_event_id(at), "projectKey": project_key,
                  "agentId": agent_id, "kind": "milestone", "tier": "unit",
                  "timestamp": at, "type": milestone_type, "label": label}
        record.update(json.loads(json.dumps(fields)))
        return record


def junit_sent(body):
    """The JUnit report texts a `/api/v2/runs` body carried as `data`, read
    as the board's `junit` codec reads them -- the client parses none of
    them: `{"summary": {total, passed, failed, pending}, "tree": [{name,
    status, children: [{name, status}]}]}`, one node per `<testsuite>`, or
    per `classname` within the one suite pytest names `pytest`. A case with a
    `<failure>` or `<error>` is `fail`, one with `<skipped>` `pending`, any
    other `pass`. `files` beside them counts the distinct sources the cases
    name -- each case's `file`, else its suite's `file`, else its
    `classname`, else its suite's name. None when the body is not a `junit`
    ingest."""
    if not isinstance(body, dict) or body.get("codec") != "junit":
        return None
    nodes = {}
    sources = set()
    for text in body.get("data") or []:
        root = ET.fromstring(text)  # noqa: S314 - a report a test's own run wrote
        for suite in list(root.iter("testsuite")) or [root]:
            suite_name = suite.get("name", "?")
            for case in suite.findall("testcase"):
                name = ((case.get("classname") or suite_name)
                        if suite_name == "pytest" else suite_name)
                if case.find("failure") is not None or case.find("error") is not None:
                    status = "fail"
                elif case.find("skipped") is not None:
                    status = "pending"
                else:
                    status = "pass"
                nodes.setdefault(name, []).append(
                    {"name": case.get("name", "?"), "status": status})
                sources.add(case.get("file") or suite.get("file")
                            or case.get("classname") or suite_name)
    tree = [{"name": name,
             "status": "fail" if any(c["status"] == "fail" for c in children) else "pass",
             "children": children} for name, children in nodes.items()]
    statuses = [c["status"] for children in nodes.values() for c in children]
    return {"summary": {"total": len(statuses), "passed": statuses.count("pass"),
                        "failed": statuses.count("fail"),
                        "pending": statuses.count("pending")},
            "tree": tree, "files": len(sources)}


def stream_sent(board, run_id="run-live-1"):
    """The stream `board` holds for `run_id`, read as the board's
    `crucible-events` codec counts it, in `junit_sent`'s shape: `{"summary":
    {total, passed, failed, pending}, "tree": [{name, status, children:
    [{name, status}]}], "files": <distinct files>}`, one node per `suite`.
    The client sends the stream as written and counts nothing itself."""
    nodes = {}
    files = set()
    for line in board.held_stream(run_id).splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") != "test-end":
            continue
        nodes.setdefault(event.get("suite") or "?", []).append(
            {"name": event.get("name", "?"), "status": event.get("status")})
        files.add(event.get("file") or event.get("suite") or "?")
    tree = [{"name": name,
             "status": "fail" if any(c["status"] == "fail" for c in children) else "pass",
             "children": children} for name, children in nodes.items()]
    statuses = [c["status"] for children in nodes.values() for c in children]
    return {"summary": {"total": len(statuses), "passed": statuses.count("pass"),
                        "failed": statuses.count("fail"),
                        "pending": statuses.count("pending")},
            "tree": tree, "files": len(files)}


class StreamingPost:
    """An in-process `_post` stand-in for a streamed unittest run
    (CR-CRU-224): opens a run on `/api/v2/runs/start`, holds each stream
    batch at the UTF-8 byte offset its `from` states and answers its `held`
    (a gap is a 409 carrying `held`), and answers `/api/v2/runs` with `run`
    when one is given. Takes the relay's post timeout as an optional third
    argument."""

    RUN_ID = "run-in-process-1"

    def __init__(self, run=None):
        self.run = run
        self.held = b""

    def __call__(self, path, payload, *_args, **_kwargs):
        if path == START:
            return {"ok": True, "changed": True, "runId": self.RUN_ID}
        if STREAM_ROUTE.match(path):
            data = payload["data"].encode("utf-8")
            start = payload["from"]
            if start > len(self.held):
                return {"ok": False, "error": "HTTP 409: a gap", "held": len(self.held)}
            if start + len(data) > len(self.held):
                self.held = self.held[:start] + data
            return {"ok": True, "runId": self.RUN_ID, "held": len(self.held)}
        if path == "/api/v2/runs" and self.run is not None:
            return {"ok": True, "changed": True, "run": dict(self.run)}
        return {"ok": True}

    def test_ends(self):
        """Every `test-end` event of the stream held, in order."""
        return [json.loads(line) for line in self.held.decode("utf-8").splitlines()
                if '"test-end"' in line]

    def summary(self):
        """`{total, passed, failed, pending}` over the stream held."""
        statuses = [e.get("status") for e in self.test_ends()]
        return {"total": len(statuses), "passed": statuses.count("pass"),
                "failed": statuses.count("fail"), "pending": statuses.count("pending")}


def first_index(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


def heartbeat_index(posts, message):
    return first_index(posts, lambda p, b: p.endswith("/agents/heartbeat")
                       and isinstance(b, dict) and b.get("message") == message)


#: A live `[client]` table, from its header line to the next live table
#: header line or the end of the file. Comments and array values carry
#: brackets, so the end is a whole header LINE, never the first `[`.
_LIVE_CLIENT_TABLE = re.compile(
    r"(?ms)^[ \t]*\[[ \t]*client[ \t]*\][ \t]*(?:#[^\n]*)?$"
    r".*?(?=^[ \t]*\[\[?[ \t]*[A-Za-z0-9_.\-]+[ \t]*\]\]?[ \t]*(?:#[^\n]*)?$|\Z)")


def project_toml_declaring(board_url):
    """The project `crucible.toml` a live-run fixture writes: the shipped
    file's limits and tables, with the project's OWN `[client]` table naming
    `board_url`. Any `[client]` table the shipped file carries is dropped
    first, so the text is right whether or not the distribution ships one, and
    the result is read back: a fixture whose project declares no board would
    fall through to whatever the install declares."""
    shipped = _LIVE_CLIENT_TABLE.sub("", SHIPPED_TOML.read_text()).rstrip("\n")
    text = f'{shipped}\n\n[client]\nurl = "{board_url}"\n'
    declared = tomllib.loads(text).get("client", {}).get("url")
    assert declared == board_url, (
        f"fixture broken: the project file declares {declared!r}, not "
        f"{board_url!r}")
    return text


def install_project(project_dir, board_url, project_key, project_name=None):
    with open(os.path.join(project_dir, ".env"), "w") as f:
        f.write(f"CRUCIBLE_PROJECT_KEY={project_key}\n")
        if project_name:
            f.write(f"CRUCIBLE_PROJECT_NAME={project_name}\n")
    with open(os.path.join(project_dir, "crucible.toml"), "w") as f:
        f.write(project_toml_declaring(board_url))


def scrubbed_env(path_prefix=None, **extra):
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    if path_prefix:
        env["PATH"] = path_prefix + os.pathsep + env.get("PATH", "")
    env.update({k: str(v) for k, v in extra.items()})
    return env


def _write_executable(path, text):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IRUSR)
    return path


# ── the shared fake-runner prologue: stamp, total, block-after, marker ──────

_PROLOGUE = """import os
import sys
import time

def _env_int(name, default):
    return int(os.environ.get(name, default))

stamp = os.environ.get("FAKE_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))
total = _env_int("FAKE_TOTAL", "1")
block_after = _env_int("FAKE_BLOCK_AFTER_INDEX", "0")
release_file = os.environ.get("FAKE_RELEASE_FILE")
marker = os.environ.get("FAKE_MARKER_LINE")
no_report = os.environ.get("FAKE_NO_REPORT") == "1"
# The ran-nothing fixture \u2014 a SECOND starvation shape: the runner writes a
# report that EXISTS but holds ZERO results (no testcases), with a
# caller-controlled exit code (default 1 \u2014 the \"exited non-zero\" shape \u00a7S4
# is about; a caller proving the UNCHANGED exit-0 pin sets FAKE_EXIT_CODE=0).
# Inert unless FAKE_ZERO_REPORT=1, so every pre-existing fake runner that
# never sets it is byte-for-byte unchanged.
zero_report = os.environ.get("FAKE_ZERO_REPORT") == "1"
zero_report_exit_code = _env_int("FAKE_EXIT_CODE", "1")

# \u00a7S3 fixture \u2014 a long-lived GRANDCHILD this runner starts on its own
# (never the client's direct child), to prove a group-kill reaches it. It
# writes its own pid to FAKE_GRANDCHILD_PIDFILE and sleeps; inert unless that
# var is set, so every pre-existing fake runner that never sets it is
# unchanged.
grandchild_pidfile = os.environ.get("FAKE_GRANDCHILD_PIDFILE")
if grandchild_pidfile:
    import subprocess as _gc_subprocess
    _gc_body = (
        "import os, sys, time\\n"
        "with open(sys.argv[1], 'w') as _gc_f:\\n"
        "    _gc_f.write(str(os.getpid()))\\n"
        "    _gc_f.flush()\\n"
        "time.sleep(120)\\n"
    )
    # stdio is explicitly DEVNULL \u2014 inheriting the runner's own stdout pipe
    # would hold it open past the runner's own exit (a SEPARATE, orthogonal
    # pipe-EOF hang), which is not this fixture's concern: it proves ONLY
    # that the process ITSELF (by pid) is gone, exactly what \u00a7S3 asks.
    _gc_subprocess.Popen([sys.executable, "-c", _gc_body, grandchild_pidfile],
                         stdin=_gc_subprocess.DEVNULL, stdout=_gc_subprocess.DEVNULL,
                         stderr=_gc_subprocess.DEVNULL)
    # The grandchild is LIVE (its pid on disk) before this runner goes on to
    # print anything, the signal marker included: a signal that lands on the
    # marker always finds the grandchild already running. Bounded.
    _gc_deadline = time.time() + 10
    while time.time() < _gc_deadline:
        try:
            with open(grandchild_pidfile) as _gc_f:
                if _gc_f.read().strip():
                    break
        except FileNotFoundError:
            pass
        time.sleep(0.02)

# \u00a7S3 fixture \u2014 a runner whose OUTPUT ends before the runner does: once its
# grandchild (if any) is live it closes its stdout and stderr, so the client
# reading them sees EOF while this runner is still running, writes its own
# pid to FAKE_CLOSE_OUTPUT_MARKER, and lingers FAKE_LINGER_SECONDS (bounded)
# before it exits. Inert unless that var is set.
close_output_marker = os.environ.get("FAKE_CLOSE_OUTPUT_MARKER")
if close_output_marker:
    sys.stdout.flush()
    sys.stderr.flush()
    os.close(1)
    os.close(2)
    with open(close_output_marker, "w") as _co_f:
        _co_f.write(str(os.getpid()))
    time.sleep(_env_int("FAKE_LINGER_SECONDS", "8"))
    os._exit(0)

# \u00a7S2 client-paragraph fixture \u2014 the TMPDIR this runner itself sees, and
# the TMPDIR a CHILD IT SPAWNS WITHOUT AN EXPLICIT ENV sees, both written to
# FAKE_TMPDIR_CAPTURE_FILE before any test case runs. Inert unless that var
# is set.
tmpdir_capture_file = os.environ.get("FAKE_TMPDIR_CAPTURE_FILE")
if tmpdir_capture_file:
    import subprocess as _tc_subprocess
    _tc_own = os.environ.get("TMPDIR", "")
    _tc_child = _tc_subprocess.run(
        [sys.executable, "-c",
         "import os, sys; sys.stdout.write(os.environ.get('TMPDIR', ''))"],
        capture_output=True, text=True)
    _tc_isdir = "1" if (_tc_own and os.path.isdir(_tc_own)) else "0"
    with open(tmpdir_capture_file, "w") as _tc_f:
        _tc_f.write(_tc_own + "\\n" + (_tc_child.stdout or "") + "\\n" + _tc_isdir)

def maybe_block(i, stream=sys.stdout):
    if i != block_after:
        return
    if marker:
        stream.write(marker + "\\n")
        stream.flush()
    deadline = time.time() + 15
    while release_file and not os.path.exists(release_file) and time.time() < deadline:
        time.sleep(0.02)
"""

FAKE_BUN = "#!{python}\n" + _PROLOGUE + """
outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]
# \u00a7S2 client-paragraph fixture \u2014 mark the LAST FAKE_FAIL_COUNT cases as
# failing (a real \"a failure\" run), instead of the always-clean suite below.
# 0 (the default) is byte-for-byte the pre-existing always-passing behaviour.
fail_count = _env_int("FAKE_FAIL_COUNT", "0")
if zero_report:
    if outfile and not no_report:
        d = os.path.dirname(outfile)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(outfile, "w") as f:
            f.write('<?xml version="1.0"?><testsuites><testsuite name="narration.test.ts" '
                    'tests="0" failures="0"></testsuite></testsuites>')
    sys.exit(zero_report_exit_code)
sys.stdout.write("narration.test.ts:\\n")
sys.stdout.flush()
cases = []
any_failed = False
for i in range(1, total + 1):
    maybe_block(i)
    if i > total - fail_count:
        any_failed = True
        sys.stdout.write("(fail) narration.test.ts > case_%d [0.01ms]\\n" % i)
        sys.stdout.flush()
        cases.append('<testcase name="case_%d" file="narration.test.ts" time="0.001">'
                     '<failure message="planted">planted failure</failure></testcase>' % i)
    else:
        sys.stdout.write("(pass) narration.test.ts > case_%d [0.01ms]\\n" % i)
        sys.stdout.flush()
        cases.append('<testcase name="case_%d" file="narration.test.ts" time="0.001"></testcase>' % i)
if outfile and not no_report:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write('<?xml version="1.0"?><testsuites><testsuite name="narration.test.ts" '
                'tests="%d" failures="%d">%s</testsuite></testsuites>' % (total, fail_count, "".join(cases)))
sys.exit(1 if any_failed else 0)
"""

FAKE_MVNW = "#!{python}\n" + _PROLOGUE + """
args = sys.argv[1:]
if "test-compile" in args:
    sys.stdout.write("[ERROR] Foo.java:[1,1] cannot find symbol\\n")
    sys.exit(1)
dirs = [a.split("=", 1)[1] for a in args
        if a.startswith("-Dsurefire.reportsDirectory=")]
dirs = dirs or [os.path.join("target", "surefire-reports")]
if zero_report:
    if not no_report:
        for d in dirs:
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "TEST-com.acme.LiveZeroTest.xml"), "w") as f:
                f.write('<?xml version="1.0"?><testsuite name="com.acme.LiveZeroTest" '
                        'tests="0" failures="0"></testsuite>')
    sys.stdout.write("[INFO] BUILD SUCCESS\\n")
    sys.exit(zero_report_exit_code)
classes = ["com.acme.LiveCase%dTest" % i for i in range(1, total + 1)]
if not no_report:
    for d in dirs:
        os.makedirs(d, exist_ok=True)
        for name in classes:
            with open(os.path.join(d, "TEST-%s.xml" % name), "w") as f:
                f.write('<?xml version="1.0"?><testsuite name="%s" tests="1" '
                        'failures="0"><testcase name="t" classname="%s" '
                        'time="0.001"/></testsuite>' % (name, name))
for i, name in enumerate(classes, 1):
    maybe_block(i)
    sys.stdout.write("[INFO] Running %s\\n" % name)
    sys.stdout.flush()
sys.stdout.write("[INFO] BUILD SUCCESS\\n")
sys.exit(0)
"""

# The python runner's stand-in. A unittest drive (CR-CRU-224) writes the
# Crucible event stream to the file `CRUCIBLE_STREAM` names, which it takes out
# of its own environment first, as `clients/subtest_runner.py` does: one
# `run-start` (`total` = FAKE_TOTAL), one `test-end` per counted case (with
# FAKE_SUBTESTS=k, k subtests per test, each its own case), one `run-end`
# (none with FAKE_NO_RUN_END=1; its total FAKE_RUN_END_TOTAL when set), each
# line flushed as it is written. A pytest drive (`--junitxml=<path>`) keeps
# its JUnit report. FAKE_FAIL_COUNT fails the last N tests (exit 1), and
# FAKE_QUIET=1 prints no verdict line. FAKE_ENV_CAPTURE=<path> records the
# `CRUCIBLE_STREAM` the runner was handed, before it takes it out.
# FAKE_DIE_AFTER_RUN_START=1 writes the `run-start` and then dies, exit 1,
# before any `test-end`: a runner that started its stream and crashed.
FAKE_PYTHON = "#!{python}\n" + _PROLOGUE + """
import json

env_capture = os.environ.get("FAKE_ENV_CAPTURE")
if env_capture:
    with open(env_capture, "w") as f:
        json.dump(dict(stream=os.environ.get("CRUCIBLE_STREAM"), argv=sys.argv[1:]), f)
argv = sys.argv[1:]
verbose = "-v" in argv
junitxml = None
for a in argv:
    if a.startswith("--junitxml="):
        junitxml = a.split("=", 1)[1]
stream_path = os.environ.pop("CRUCIBLE_STREAM", None)
fail_count = _env_int("FAKE_FAIL_COUNT", "0")
subtests = _env_int("FAKE_SUBTESTS", "0")
quiet = os.environ.get("FAKE_QUIET") == "1"
no_run_end = os.environ.get("FAKE_NO_RUN_END") == "1"
run_end_total = os.environ.get("FAKE_RUN_END_TOTAL")
stream = None
if junitxml is None and stream_path and not no_report:
    stream = open(stream_path, "w", encoding="utf-8")

def emit(**event):
    if stream is not None:
        stream.write(json.dumps(event) + "\\n")
        stream.flush()

def run_end(counted, passed, failed):
    if not no_run_end:
        emit(event="run-end",
             total=int(run_end_total) if run_end_total else counted,
             passed=passed, failed=failed, pending=0, duration_ms=1)
    if stream is not None:
        stream.close()

def write_junit(cases):
    if junitxml is None or no_report:
        return
    parent = os.path.dirname(junitxml)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(junitxml, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\\n<testsuites><testsuite '
                'name="pytest" tests="%d">%s</testsuite></testsuites>\\n'
                % (len(cases), "".join(cases)))

if os.environ.get("FAKE_ZERO_DISCOVERY") == "1":
    emit(event="run-start", total=0)
    run_end(0, 0, 0)
    sys.stderr.write("\\n----------------------------------------------------------------------\\n"
                     "Ran 0 tests in 0.000s\\n\\nNO TESTS RAN\\n")
    sys.exit(5)
if zero_report:
    emit(event="run-start", total=0)
    run_end(0, 0, 0)
    write_junit([])
    sys.exit(zero_report_exit_code)
emit(event="run-start", total=total)
if os.environ.get("FAKE_DIE_AFTER_RUN_START") == "1":
    if stream is not None:
        stream.close()
    sys.stderr.write("Traceback (most recent call last):\\n"
                     "RuntimeError: the runner died after its run-start\\n")
    sys.exit(1)
cases = []
counted = passed = failed = 0
for i in range(1, total + 1):
    maybe_block(i)
    fails = i > total - fail_count
    name = "test_case_%d" % i
    test_id = "fake_module.FakeCase." + name
    if verbose and not quiet:
        sys.stderr.write("%s (%s) ... %s\\n" % (name, test_id, "FAIL" if fails else "ok"))
        sys.stderr.flush()
    shapes = ([(test_id + " (i=%d)" % k, name + " (i=%d)" % k) for k in range(subtests)]
              or [(test_id, name)])
    for case_id, case_name in shapes:
        counted += 1
        event = dict(event="test-end", id=case_id, name=case_name,
                     suite="fake_module.FakeCase", file="fake_module.py",
                     status="fail" if fails else "pass", duration_ms=1)
        if fails:
            failed += 1
            event["failure"] = dict(
                message="planted failure", type="AssertionError",
                trace=('Traceback (most recent call last):\\n'
                       '  File "fake_module.py", line 1, in %s\\n'
                       'AssertionError: planted failure' % name))
        else:
            passed += 1
        emit(**event)
    failure = ('<failure message="planted failure">planted failure</failure>'
               if fails else "")
    cases.append('<testcase classname="fake_module.FakeCase" name="%s" '
                  'file="fake_module.py" time="0.001">%s</testcase>' % (name, failure))
run_end(counted, passed, failed)
write_junit(cases)
sys.exit(1 if failed else 0)
"""

# The streamed run's calls (`tests/client/fake_nextest.py`), answered before
# the prologue so its stamp, marker and grandchild belong to the run step: the
# fake's cases are FAKE_TOTAL tests `tests::case_<i>` (none for a zero
# report), each `ok`, or `failed` under FAKE_CARGO_VERDICT=FAIL. No brace
# appears here: `write_fake_cargo` formats the whole text.
_CARGO_NEXTEST_PRELUDE = (
    "import os\nimport sys\nsys.path.insert(0, " + repr(str(Path(__file__).resolve().parent))
    + ")\nimport fake_nextest\n" + """
_nx_status = "failed" if os.environ.get("FAKE_CARGO_VERDICT") == "FAIL" else "ok"
_nx_total = 0 if os.environ.get("FAKE_ZERO_REPORT") == "1" else int(os.environ.get("FAKE_TOTAL", "1"))
NEXTEST_CASES = [fake_nextest.case("tests::case_%d" % _nx_i, _nx_status)
                 for _nx_i in range(1, _nx_total + 1)]
_nx_code = fake_nextest.preliminary(sys.argv[1:], NEXTEST_CASES)
if _nx_code is not None:
    sys.exit(_nx_code)
""")

FAKE_CARGO = "#!{python}\n" + _CARGO_NEXTEST_PRELUDE + _PROLOGUE + """
args = sys.argv[1:]
fake_nextest.record_call(args)
if not args or args[0] in ("clean", "check", "cache"):
    sys.exit(0)
# A zero report streams no result and exits FAKE_EXIT_CODE; no report
# streams no line at all.
_nx_code = fake_nextest.streamed_run(
    args, NEXTEST_CASES, lambda i: maybe_block(i, sys.stderr),
    empty_exit=zero_report_exit_code if zero_report else None, silent=no_report)
if _nx_code is not None:
    sys.exit(_nx_code)
profile = "ci"
lcov = None
for i, a in enumerate(args):
    if a == "-P" and i + 1 < len(args):
        profile = args[i + 1]
    if a == "--output-path" and i + 1 < len(args):
        lcov = args[i + 1]
verdict = os.environ.get("FAKE_CARGO_VERDICT", "PASS")
if zero_report:
    if not no_report:
        junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
        os.makedirs(junit_dir, exist_ok=True)
        with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
            f.write('<?xml version="1.0"?><testsuites><testsuite name="fake-crate" '
                    'tests="0" failures="0"></testsuite></testsuites>')
    sys.exit(zero_report_exit_code)
sys.stdout.write("    Starting %d tests across 1 binary (run ID: deadbeef, nextest "
                 "profile: %s)\\n" % (total, profile))
sys.stdout.flush()
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    sys.stdout.write("        %s [   0.001s] fake-crate tests::case_%d\\n" % (verdict, i))
    sys.stdout.flush()
    cases.append('<testcase name="tests::case_%d" classname="fake-crate" '
                 'time="0.001"></testcase>' % i)
sys.stdout.write("------------\\n     Summary [   0.010s] %d tests run: %d passed, "
                 "0 skipped\\n" % (total, total))
sys.stdout.flush()
if not no_report:
    junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
    os.makedirs(junit_dir, exist_ok=True)
    with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
        f.write('<?xml version="1.0"?><testsuites><testsuite name="fake-crate" '
                'tests="%d" failures="0">%s</testsuite></testsuites>' % (total, "".join(cases)))
    if lcov:
        os.makedirs(os.path.dirname(os.path.join(os.getcwd(), lcov)) or ".", exist_ok=True)
        with open(os.path.join(os.getcwd(), lcov), "w") as f:
            f.write("SF:src/lib.rs\\nLF:1\\nLH:1\\nend_of_record\\n")
sys.exit(0)
"""

FAKE_NATIVE_RUNNER = _PROLOGUE + """
reports_dir = os.environ.get("REPORTS_DIR") or "reports"
if zero_report:
    if not no_report:
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as f:
            f.write('<?xml version="1.0"?><testsuite name="native" tests="0" failures="0"></testsuite>')
    sys.exit(zero_report_exit_code)
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    sys.stdout.write("test/test_main.c:%d:test_case_%d:PASS\\n" % (10 + i, i))
    sys.stdout.flush()
    cases.append('<testcase name="test_case_%d" classname="native" time="0.001"/>' % i)
sys.stdout.write("-----------------------\\n%d Tests 0 Failures 0 Ignored\\nOK\\n" % total)
sys.stdout.flush()
if not no_report:
    os.makedirs(reports_dir, exist_ok=True)
    with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as f:
        f.write('<?xml version="1.0"?><testsuite name="native" tests="%d" failures="0">'
                '%s</testsuite>' % (total, "".join(cases)))
sys.exit(0)
"""


def write_fake_bun(project_dir, n_declared):
    """The fake `bun`, plus `n_declared` real `test(...)` declarations so bun's
    prescan resolves a known total."""
    lines = "\n".join(f'test("case{i}", () => {{}});' for i in range(1, n_declared + 1))
    with open(os.path.join(project_dir, "narration.test.ts"), "w") as f:
        f.write(lines + "\n")
    return _write_executable(os.path.join(project_dir, "fake_bun.py"),
                             FAKE_BUN.format(python=sys.executable))


def write_fake_mvnw(maven_dir):
    return _write_executable(os.path.join(maven_dir, "mvnw"),
                             FAKE_MVNW.format(python=sys.executable))


def write_fake_python(project_dir):
    return _write_executable(os.path.join(project_dir, "fake_python.py"),
                             FAKE_PYTHON.format(python=sys.executable))


def write_fake_cargo(bin_dir):
    return _write_executable(os.path.join(bin_dir, "cargo"),
                             FAKE_CARGO.format(python=sys.executable))


# A `docker` stand-in for verbs that only LIST containers before their run
# (mvn `e2e`'s pre-run check): it prints nothing and exits 0, so a test never
# reaches the host's real docker.
FAKE_DOCKER = "#!{python}\nimport sys\nsys.exit(0)\n"


def write_fake_docker(bin_dir):
    return _write_executable(os.path.join(bin_dir, "docker"),
                             FAKE_DOCKER.format(python=sys.executable))


def write_fake_native(project_dir, sub="tests/native"):
    native_dir = os.path.join(project_dir, *sub.split("/"))
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, "run_native.py"), "w") as f:
        f.write(FAKE_NATIVE_RUNNER)
    with open(os.path.join(native_dir, "Makefile"), "w") as f:
        f.write(f"junit:\n\t{sys.executable} run_native.py\n")
    return native_dir


# ── drivers ─────────────────────────────────────────────────────────────────

def _read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def _wait_for(path, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in _read(path):
            return True
        time.sleep(0.02)
    return False


_RELEASE_SEQ = [0]


def _fresh_release_path(scratch):
    """A release-file path no earlier drive in this process has used (the
    file is created only to release the runner, never ahead of time)."""
    _RELEASE_SEQ[0] += 1
    return os.path.join(scratch, f"release-{os.getpid()}-{_RELEASE_SEQ[0]}")


class Drive:
    """The outcome of one client invocation."""

    def __init__(self, returncode, stdout, stderr, live_on_stderr, live_in_log):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.live_on_stderr = live_on_stderr
        self.live_in_log = live_in_log


def drive_live(cmd, cwd, env, scratch, marker, log_path=None, timeout=60):
    """Run `cmd` with its fake runner told to print `marker` and then block
    until released. While the runner is blocked, look for the marker on the
    client's stderr (and in `log_path`); then release it and wait."""
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker)
    env.setdefault("FAKE_BLOCK_AFTER_INDEX", "1")
    stderr_path = os.path.join(scratch, "client-stderr.txt")
    with open(stderr_path, "w") as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        try:
            live_on_stderr = _wait_for(stderr_path, marker, 10)
            live_in_log = (_wait_for(log_path, marker, 2)
                           if log_path and live_on_stderr else None)
            released_early = os.path.exists(release)
        finally:
            with open(release, "w") as f:
                f.write("go")
        stdout, _ = proc.communicate(timeout=timeout)
    return Drive(proc.returncode, stdout, _read(stderr_path),
                 live_on_stderr and not released_early,
                 live_in_log)


def drive_and_signal(cmd, cwd, env, scratch, signum, timeout=30,
                     pre_signal=None):
    """Run `cmd`, wait until its blocked runner's marker has reached the
    client's stderr (the client is reading the run, its run already open),
    then deliver `signum` to the CLIENT process. `pre_signal`, when given, is
    called once the marker is seen and BEFORE the signal is sent, so a caller
    can observe the live run first."""
    marker = "LIVE_RUN_SIGNAL_MARKER"
    # A fresh release file per drive: an earlier drive's release must never
    # unblock this one's runner before the signal lands.
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker,
               FAKE_BLOCK_AFTER_INDEX="1")
    stderr_path = os.path.join(scratch, "client-stderr.txt")
    with open(stderr_path, "w") as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        try:
            reached = _wait_for(stderr_path, marker, 15)
            if reached:
                if pre_signal is not None:
                    pre_signal()
                proc.send_signal(signum)
            stdout, _ = proc.communicate(timeout=timeout)
        finally:
            with open(release, "w") as f:
                f.write("go")
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    return reached, proc.returncode, stdout, _read(stderr_path)


def drive_and_close_stderr(cmd, cwd, env, scratch, timeout=30):
    """CR-CRU-175 \u00a7S3 \u2014 run `cmd`, wait until its blocked runner's marker has
    reached the client's REAL stderr PIPE (the client's own "run started"
    line and the runner's first lines already reached it \u2014 the run is
    genuinely open and in flight), then close THIS PROCESS'S READ END of that
    pipe WITHOUT reading any further \u2014 exactly what the reader of
    `cmd | head -N` leaves behind once it has its N lines \u2014 and only then
    release the runner, so every further echo the client's `run_streamed`
    attempts lands on an already-dead pipe.

    Returns `(reached, returncode, stdout, pre_close_lines)`: `stdout` is
    read from the UNTOUCHED stdout pipe (never closed here \u2014 this driver is
    the stderr half of \u00a7S3's pair), and `pre_close_lines` is everything read
    on stderr before it was closed (so a failed `reached` can explain
    itself)."""
    marker = "LIVE_RUN_PIPE_CLOSE_MARKER"
    # A fresh release file per drive: an earlier drive's release must never
    # unblock this one's runner before the pipe is closed.
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker,
               FAKE_BLOCK_AFTER_INDEX="1")
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    assert proc.stderr is not None  # stderr=PIPE always yields a stream
    lines = []
    reached = False
    try:
        for line in proc.stderr:
            lines.append(line)
            if marker in line:
                reached = True
                break
    finally:
        proc.stderr.close()
        # `communicate()` below must not try to read the pipe we just closed.
        proc.stderr = None
        with open(release, "w") as f:
            f.write("go")
    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, _ = proc.communicate()
    return reached, proc.returncode, stdout, lines


def new_scratch(prefix):
    """A fresh scratch directory that is removed when this process exits \u2014
    cleanly or on an uncaught error \u2014 whether or not the caller also
    removes it (a caller's own earlier removal makes this a no-op)."""
    scratch = tempfile.mkdtemp(prefix=prefix)
    atexit.register(shutil.rmtree, scratch, ignore_errors=True)
    return scratch


# \u2500\u2500 \u00a7S3 / \u00a7S2-client fixtures: a grandchild's pid, and process-tree checks \u2500\u2500

_GRANDCHILD_SEQ = [0]


def fresh_grandchild_pidfile(scratch):
    """A grandchild-pidfile path no earlier drive in this process has used."""
    _GRANDCHILD_SEQ[0] += 1
    return os.path.join(scratch, f"grandchild-{os.getpid()}-{_GRANDCHILD_SEQ[0]}.pid")


_CAPTURE_SEQ = [0]


def fresh_capture_path(scratch, name):
    """A capture-file path no earlier drive in this process has used."""
    _CAPTURE_SEQ[0] += 1
    return os.path.join(scratch, f"{name}-{os.getpid()}-{_CAPTURE_SEQ[0]}")


def wait_for_pidfile(path, timeout=15):
    """Poll for the grandchild's own pidfile and return the int pid it wrote,
    or None if it never appeared \u2014 the caller's own signal that the
    grandchild never actually started, which is a fixture failure, never a
    RED failure."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = _read(path).strip()
        if text:
            try:
                return int(text)
            except ValueError:
                pass
        time.sleep(0.02)
    return None


def pid_alive(pid):
    """Whether `pid` still names a live process \u2014 `os.kill(pid, 0)` sends no
    signal, only probes."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_pid_gone(pid, timeout=10):
    """Poll until `pid` is no longer alive, or the timeout passes \u2014 GREEN's
    own SIGTERM-then-SIGKILL grace needs a short window, never an instant
    check."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def kill_pid_if_alive(pid):
    """Best-effort SIGKILL cleanup for a grandchild this process's OWN test
    started on purpose \u2014 called from every test's `finally`/`tearDown`
    regardless of whether the assertion under test passed, so a RED failure
    (today's bug: the grandchild survives) never leaks a sleeping process
    past this test."""
    if pid is None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.kill(pid, signal.SIGKILL)


# The system-call numbers of `wait4` and `waitid`, by `platform.machine()`.
_WAIT_SYSCALLS_BY_MACHINE = {
    "x86_64": (61, 247),
    "aarch64": (260, 95),
}


def wait_until_waiting_on_a_child(pid, timeout=10):
    """Poll until process `pid`'s main thread is blocked waiting on a child,
    and return whether it got there within `timeout` seconds.

    A wait is recognised by the system call the process is blocked in: the
    first field of `/proc/<pid>/syscall` is the call's number, and the
    process is waiting once it is the `wait4` or `waitid` number for the
    machine's architecture (`platform.machine()`, looked up on every call):

        platform.machine()   wait4   waitid
        x86_64                  61      247
        aarch64                260       95

    While the first field is not a number (`running`) or is `-1`, the
    process is not waiting yet and polling continues; at the timeout False
    is returned.

    Where the state cannot be observed -- `/proc/<pid>/syscall` is absent or
    cannot be read (`PermissionError` or another `OSError`), or the
    architecture is not in the table -- a short fixed pause stands in for
    it, and True is returned."""
    wait_syscalls = _WAIT_SYSCALLS_BY_MACHINE.get(platform.machine())
    path = f"/proc/{pid}/syscall"
    if wait_syscalls is None or not os.path.exists(path):
        return _unobservable_wait_fallback()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(path) as f:
                fields = f.read().split()
        except OSError:
            return _unobservable_wait_fallback()
        if fields and fields[0].isdigit() and int(fields[0]) in wait_syscalls:
            return True
        time.sleep(0.02)
    return False


def _unobservable_wait_fallback():
    """The stand-in for a wait that cannot be observed: a short fixed pause,
    then True."""
    time.sleep(1)
    return True


def read_tmpdir_capture(path):
    """Decode a `FAKE_TMPDIR_CAPTURE_FILE`: `(own_tmpdir, child_tmpdir,
    isdir)`, the runner's own `TMPDIR`, the one a child it spawned WITHOUT
    an explicit `env` saw, and whether `own_tmpdir` actually existed as a
    directory at capture time (`"1"`/`"0"`). `(None, None, None)` when the
    file was never written (the runner never reached the capture point,
    which the caller's own assertion on it must fail loudly on, not
    silently)."""
    text = _read(path)
    if not text:
        return None, None, None
    lines = text.split("\n")
    own = lines[0] if len(lines) > 0 else ""
    child = lines[1] if len(lines) > 1 else ""
    isdir = lines[2] if len(lines) > 2 else ""
    return own, child, isdir


SIGNALS = (signal.SIGINT, signal.SIGTERM)
