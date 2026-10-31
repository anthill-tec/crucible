"""The shared stream relay (CR-CRU-224 §S2, AC4): `StreamRelay` in the run
module the client fleet shares (`clients/_crucible_run.py`), re-exported by the
core (`clients/_crucible_axi.py`) as every run-module name is.

`StreamRelay(post_fn, project_key, agent_id, run_id, path, codec, batch_limit)`
follows the stream file at `path` and sends what was written since the board's
last acknowledgement, in batches, to `POST /api/v2/runs/<runId>/stream`. It is
driven here through its post function alone: `FakeStreamBoard` answers as the
client's transport (`http_request`) answers the real board's stream route
(`handleRunStream`, src/v2.ts) — a 200 `{ok, runId, held}`; a refusal as
`{ok: False, error: "HTTP <status>: <body>"}` with the body's `held` carried
beside it when the board sent one; an unreachable board or a timeout as the
transport's own `connection failed:` / `request timed out` errors.

Where the relay's tick is timed, the run module's `RELAY_SECONDS` (and, for
the bounded join, `RELAY_POST_TIMEOUT_SECONDS`) is patched small: the relay
reads both at run time from the run module.

`finish(deadline_seconds)` answers the board's confirmed `held` and whether
sending stopped and why. The spec names no shape for that answer, so these
tests read it through `held_of` / `stopped_of`, which accept a `(held,
stopped)` pair, a mapping with `held` and `stopped`, or an object with those
attributes; `stopped` is falsy when sending never stopped, else a text naming
why (the board's status).
"""

import ast
import contextlib
import io
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_run.py"

AXI = load_client("_crucible_axi.py")
RUN = AXI._RUN

PROJECT_KEY = "relay-project-key"
AGENT = "relay-agent"
RUN_ID = "run-relay-1"
STREAM_PATH = f"/api/v2/runs/{RUN_ID}/stream"
CODEC = "crucible-events"
BODY_KEYS = {"projectKey", "agentId", "codec", "from", "data"}

FAST_TICK = 0.02
WAIT_SECONDS = 10.0
REPLACEMENT_CHARACTER = "\N{REPLACEMENT CHARACTER}"

# Three stream lines; the middle one far longer than a small batch, its text
# mixing one-, two-, three- and four-byte UTF-8 characters.
LONG_NAME = "case é€𝄞 " * 60
STREAM_TEXT = (
    json.dumps({"event": "run-start", "total": 1}) + "\n"
    + json.dumps({"event": "test-end", "name": LONG_NAME, "status": "pass"}) + "\n"
    + json.dumps({"event": "run-end", "total": 1, "passed": 1, "failed": 0,
                  "pending": 0}) + "\n")


def body_size(payload):
    """The request body's size as `json.dumps` sends it."""
    return len(json.dumps(payload).encode())


def http_refusal(status, marker, held=None):
    """The transport's answer to a non-200 from the stream route."""
    answer = {"ok": False,
              "error": f"HTTP {status}: " + json.dumps({"ok": False, "error": marker})}
    if held is not None:
        answer["held"] = held
    return answer


def unreachable(marker):
    return {"ok": False, "error": f"connection failed: [Errno 111] {marker} "
                                  f"(is Crucible running at http://127.0.0.1:9?)"}


def timed_out(marker):
    return {"ok": False, "error": f"request timed out after 5s ({marker})"}


def held_of(answer):
    if isinstance(answer, tuple):
        return answer[0]
    if isinstance(answer, dict):
        return answer["held"]
    return answer.held


def stopped_of(answer):
    if isinstance(answer, tuple):
        return answer[1]
    if isinstance(answer, dict):
        return answer["stopped"]
    return answer.stopped


def wait_until(predicate, timeout=WAIT_SECONDS):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class FakeStreamBoard:
    """The relay's `post_fn`: holds the stream as the board's
    `appendRunStream` does (a gap or a differing overlap a 409 carrying
    `held`, a total past `limit` a 413 carrying `held`), unless the next
    answer is scripted (`script`: an answer, or a callable taking the payload
    and answering). Records every post with its payload, its timeout, its
    body's size and the test's `phase` when it arrived."""

    def __init__(self, limit=10 ** 12, held=b""):
        self.held = bytearray(held)
        self.limit = limit
        self.posts = []
        self.script = []
        self.phase = "run"
        self.always: object = None
        self.block_first: threading.Event | None = None
        self._lock = threading.Lock()

    def __call__(self, path, payload, *args, **kwargs):
        timeout = kwargs.get("timeout", args[0] if args else None)
        with self._lock:
            first = not self.posts
            self.posts.append({"path": path, "payload": json.loads(json.dumps(payload)),
                               "timeout": timeout, "size": body_size(payload),
                               "phase": self.phase})
            scripted = self.script.pop(0) if self.script else self.always
        if first and self.block_first is not None:
            self.block_first.wait(timeout=30)
        if scripted is not None:
            if callable(scripted):
                return scripted(payload)
            return json.loads(json.dumps(scripted))
        return self._append(payload)

    def _append(self, payload):
        incoming = payload["data"].encode("utf-8")
        start = payload["from"]
        with self._lock:
            size = len(self.held)
            if start > size:
                return http_refusal(409, "gap", held=size)
            overlap = min(size - start, len(incoming))
            if bytes(self.held[start:start + overlap]) != incoming[:overlap]:
                return http_refusal(409, "overlap", held=size)
            if start + len(incoming) > self.limit:
                return http_refusal(413, "cut", held=size)
            self.held.extend(incoming[overlap:])
            return {"ok": True, "runId": RUN_ID, "held": len(self.held)}

    def held_bytes(self):
        with self._lock:
            return bytes(self.held)

    def data_posts(self, phase=None):
        with self._lock:
            return [p for p in self.posts if p["payload"].get("data")
                    and (phase is None or p["phase"] == phase)]

    def all_posts(self):
        with self._lock:
            return list(self.posts)


class RelayTestCase(unittest.TestCase):
    """A scratch stream file per test, and the relay over it."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="stream-relay-")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        self.path = Path(self.tmpdir, "crucible-events.ndjson")
        self.path.write_bytes(b"")
        self.threads_before = set(threading.enumerate())

    def append(self, data):
        with open(self.path, "ab") as handle:
            handle.write(data if isinstance(data, bytes) else data.encode("utf-8"))
            handle.flush()

    def relay(self, board, batch_limit: int | None = 10 ** 9):
        return AXI.StreamRelay(board, PROJECT_KEY, AGENT, RUN_ID, str(self.path),
                               CODEC, batch_limit)

    def fast_ticks(self):
        patcher = mock.patch.object(RUN, "RELAY_SECONDS", FAST_TICK)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_relay(self, board, batch_limit: int | None = 10 ** 9, deadline=10.0):
        """start, then finish: the relay over a file already written. Answers
        `(finish's answer, stderr)`."""
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board, batch_limit)
            relay.start()
            answer = relay.finish(deadline)
        return answer, err.getvalue()

    def assert_bodies_are_the_relays(self, board):
        for post in board.all_posts():
            self.assertEqual(post["path"], STREAM_PATH, post)
            payload = post["payload"]
            self.assertEqual(set(payload), BODY_KEYS,
                             f"a batch's body is {{projectKey, agentId, codec, from, "
                             f"data}} and nothing else; got {sorted(payload)}")
            self.assertEqual((payload["projectKey"], payload["agentId"], payload["codec"]),
                             (PROJECT_KEY, AGENT, CODEC), payload)


class TheRelayCutsAtTheLastWholeCharacterTest(RelayTestCase):
    """§S2 Cutting (P2): batches end at the last complete UTF-8 character, each
    encoded body within `batch_limit`; a line longer than a batch spans
    batches."""

    def test_every_body_stays_within_the_batch_limit_and_a_long_line_spans_batches(self):
        self.append(STREAM_TEXT)
        board = FakeStreamBoard()
        limit = 400
        answer, _err = self.run_relay(board, batch_limit=limit)
        whole = STREAM_TEXT.encode("utf-8")
        self.assertEqual(board.held_bytes(), whole,
                         "the board ends holding the stream file, byte for byte")
        self.assertEqual(held_of(answer), len(whole))
        self.assertFalse(stopped_of(answer), f"nothing stopped the relay: {answer!r}")
        self.assert_bodies_are_the_relays(board)
        sent = board.data_posts()
        self.assertGreaterEqual(len(sent), 3, "the long line cannot fit one 400-byte batch")
        self.assertLessEqual(len(sent), len(whole), "no batch is empty of data")
        position = 0
        for post in sent:
            payload = post["payload"]
            self.assertLessEqual(post["size"], limit,
                                 f"an encoded body passed batch_limit {limit}: {post['size']}")
            self.assertNotIn(REPLACEMENT_CHARACTER, payload["data"],
                             "a batch was cut inside a character")
            self.assertEqual(payload["from"], position,
                             "each batch starts at the bytes the board holds")
            position += len(payload["data"].encode("utf-8"))
        self.assertTrue(any(not p["payload"]["data"].endswith("\n") for p in sent),
                        "a line longer than a batch spans batches, so some batch "
                        "ends mid-line")

    def test_a_character_still_being_written_is_held_back_until_it_is_whole(self):
        self.fast_ticks()
        head = json.dumps({"event": "run-start", "total": 1}) + "\ncaf"
        euro = "€".encode()
        self.append(head.encode("utf-8") + euro[:2])
        board = FakeStreamBoard()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            reached = wait_until(lambda: board.held_bytes() == head.encode("utf-8"))
            time.sleep(10 * FAST_TICK)
            held_while_partial = board.held_bytes()
            self.append(euro[2:] + b"\n")
            answer = relay.finish(10.0)
        self.assertTrue(reached, f"the relay sends up to the last whole character "
                                 f"while the runner works; the board held "
                                 f"{board.held_bytes()!r}")
        self.assertEqual(held_while_partial, head.encode("utf-8"),
                         "the two bytes of a character not yet whole are never sent")
        whole = head.encode("utf-8") + euro + b"\n"
        self.assertEqual(board.held_bytes(), whole)
        self.assertEqual(held_of(answer), len(whole))
        for post in board.data_posts():
            self.assertNotIn(REPLACEMENT_CHARACTER, post["payload"]["data"])

    def test_the_default_batch_limit_applies_when_health_gives_none(self):
        self.assertEqual(RUN.RELAY_DEFAULT_BATCH_BYTES, 1024 * 1024,
                         "the default is the shipped minimum of ingest_body_bytes, 1 MiB")
        line = json.dumps({"event": "test-end", "name": "n" * 500, "status": "pass"}) + "\n"
        text = line * (1536 * 1024 // len(line))
        self.append(text)
        board = FakeStreamBoard()
        answer, _err = self.run_relay(board, batch_limit=None)
        self.assertEqual(board.held_bytes(), text.encode("utf-8"))
        self.assertEqual(held_of(answer), len(text.encode("utf-8")))
        sent = board.data_posts()
        self.assertGreaterEqual(len(sent), 2, "1.5 MiB cannot go in one 1 MiB batch")
        self.assertLessEqual(len(sent), 4, "a 1.5 MiB stream needs two or three batches")
        for post in sent:
            self.assertLessEqual(post["size"], 1024 * 1024)


class TheBoardsAnswerMovesTheRelayTest(RelayTestCase):
    """§S2: a 200's or a 409's `held` moves the next `from`; a 413 carrying
    `held` stops all further sending."""

    def test_a_200s_held_becomes_the_next_from(self):
        self.append(STREAM_TEXT)
        whole = STREAM_TEXT.encode("utf-8")
        board = FakeStreamBoard()

        def acknowledge_seven(_payload):
            board.held[:] = whole[:7]
            return {"ok": True, "runId": RUN_ID, "held": 7}
        board.script.append(acknowledge_seven)
        answer, _err = self.run_relay(board)
        sent = board.data_posts()
        self.assertGreaterEqual(len(sent), 2, sent)
        self.assertEqual(sent[0]["payload"]["from"], 0)
        self.assertEqual(sent[1]["payload"]["from"], 7,
                         "the 200's held (7) is the next batch's from")
        self.assertEqual(sent[1]["payload"]["data"].encode("utf-8"), whole[7:])
        self.assertEqual(board.held_bytes(), whole)
        self.assertEqual(held_of(answer), len(whole))

    def test_a_409s_held_becomes_the_next_from(self):
        self.append(STREAM_TEXT)
        whole = STREAM_TEXT.encode("utf-8")
        board = FakeStreamBoard(held=whole[:12])
        board.script.append(http_refusal(409, "a batch from 0 differs", held=12))
        answer, _err = self.run_relay(board)
        sent = board.data_posts()
        self.assertGreaterEqual(len(sent), 2, sent)
        self.assertEqual(sent[1]["payload"]["from"], 12,
                         "the relay resends from the 409's held")
        self.assertEqual(sent[1]["payload"]["data"].encode("utf-8"), whole[12:])
        self.assertEqual(board.held_bytes(), whole)
        self.assertEqual(held_of(answer), len(whole))
        self.assertFalse(stopped_of(answer))

    def test_a_413_carrying_held_stops_all_further_sending(self):
        self.fast_ticks()
        self.append(STREAM_TEXT)
        board = FakeStreamBoard()
        board.script.append(http_refusal(413, "the stream would pass ingest_body_bytes", held=0))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            wait_until(lambda: len(board.data_posts()) >= 1)
            for _ in range(5):
                self.append(STREAM_TEXT)
                time.sleep(4 * FAST_TICK)
            answer = relay.finish(2.0)
        self.assertEqual(len(board.data_posts()), 1,
                         "after a 413 carrying held nothing more is sent, finish included")
        self.assertEqual(board.held_bytes(), b"")
        self.assertEqual(held_of(answer), 0)
        self.assertIn("413", str(stopped_of(answer)),
                      f"finish answers that sending stopped, and why: {answer!r}")


class EveryOtherRefusalStopsTheRelayTest(RelayTestCase):
    """§S2: a 400, a 404, a 409 without `held` (a settled run, an unregistered
    caller) and a 413 without `held` stop all further sending, said once on
    stderr."""

    REFUSALS = (
        (400, "zz-400-a-malformed-batch"),
        (404, "zz-404-unknown-project"),
        (409, "zz-409-run-already-ended-a-settled-run-takes-no-stream"),
        (409, "zz-409-agent-is-not-registered"),
        (413, "zz-413-request-body-exceeds-ingest_body_bytes"),
    )

    def test_each_refusal_without_held_stops_sending_and_is_said_once(self):
        self.fast_ticks()
        for status, marker in self.REFUSALS:
            with self.subTest(status=status, marker=marker):
                self.path.write_bytes(STREAM_TEXT.encode("utf-8"))
                board = FakeStreamBoard()
                board.script.append(http_refusal(status, marker))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    relay = self.relay(board)
                    relay.start()
                    wait_until(lambda b=board: len(b.data_posts()) >= 1)
                    for _ in range(5):
                        self.append(STREAM_TEXT)
                        time.sleep(4 * FAST_TICK)
                    answer = relay.finish(2.0)
                self.assertEqual(len(board.data_posts()), 1,
                                 f"a {status} without held stops all further sending")
                said = [line for line in err.getvalue().splitlines() if marker in line]
                self.assertEqual(len(said), 1,
                                 f"the refusal is said once on stderr, naming the "
                                 f"board's error; stderr={err.getvalue()!r}")
                self.assertIn(str(status), str(stopped_of(answer)),
                              f"finish answers why sending stopped: {answer!r}")
                self.assertEqual(held_of(answer), 0)


class TheRelayRetriesWhatTheBoardCouldNotTakeTest(RelayTestCase):
    """§S2: an unreachable board, a timeout or a 5xx is retried on the next
    tick, said once on stderr, and never fatal to the run."""

    FAILURES = (
        ("unreachable", unreachable("zz-unreachable-marker"), "zz-unreachable-marker"),
        ("timeout", timed_out("zz-timeout-marker"), "zz-timeout-marker"),
        ("5xx", http_refusal(503, "zz-5xx-marker"), "zz-5xx-marker"),
    )

    def test_unreachable_timeout_and_5xx_are_retried_said_once_and_never_raised(self):
        self.fast_ticks()
        for kind, failure, marker in self.FAILURES:
            with self.subTest(kind=kind):
                self.path.write_bytes(STREAM_TEXT.encode("utf-8"))
                whole = STREAM_TEXT.encode("utf-8")
                board = FakeStreamBoard()
                board.script.extend([failure, failure, failure])
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    relay = self.relay(board)
                    relay.start()
                    delivered = wait_until(
                        lambda b=board, w=whole: b.held_bytes() == w)
                    answer = relay.finish(5.0)
                self.assertTrue(delivered, f"{kind}: the batch is retried on the next "
                                           f"tick until the board takes it")
                self.assertGreaterEqual(len(board.data_posts()), 4)
                said = [line for line in err.getvalue().splitlines() if marker in line]
                self.assertEqual(len(said), 1, f"{kind}: said once; stderr={err.getvalue()!r}")
                self.assertEqual(held_of(answer), len(whole))
                self.assertFalse(stopped_of(answer), f"{kind}: a retry never stops the relay")

    def test_finish_sends_the_batches_refused_while_the_run_worked(self):
        self.fast_ticks()
        self.append(STREAM_TEXT)
        whole = STREAM_TEXT.encode("utf-8")
        board = FakeStreamBoard()

        def unavailable_while_running(payload):
            if board.phase == "run":
                return http_refusal(503, "zz-busy")
            return board._append(payload)
        board.always = unavailable_while_running
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            wait_until(lambda: len(board.data_posts()) >= 2)
            board.phase = "finish"
            answer = relay.finish(5.0)
        self.assertGreaterEqual(len(board.data_posts("run")), 2,
                                "the run's ticks were refused")
        self.assertGreaterEqual(len(board.data_posts("finish")), 1,
                                "finish sends what was never acknowledged")
        self.assertEqual(board.held_bytes(), whole)
        self.assertEqual(held_of(answer), len(whole))

    def test_finish_tries_a_batch_at_most_its_finish_attempts(self):
        self.append(STREAM_TEXT)
        board = FakeStreamBoard()
        board.always = http_refusal(503, "zz-down")
        patcher = mock.patch.object(RUN, "RELAY_SECONDS", 60.0)
        patcher.start()
        self.addCleanup(patcher.stop)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            time.sleep(0.2)
            board.phase = "finish"
            answer = relay.finish(20.0)
        attempts = RUN.RELAY_FINISH_ATTEMPTS
        self.assertEqual(len(board.data_posts("finish")), attempts,
                         f"finish tries one batch up to RELAY_FINISH_ATTEMPTS "
                         f"({attempts}) times")
        self.assertEqual(held_of(answer), 0)


class FinishStopsJoinsSendsAndConfirmsTest(RelayTestCase):
    """§S2 `finish(deadline_seconds)`: stops and joins the thread, bounded;
    sends what was never acknowledged; confirms `held` with an empty batch;
    answers that `held`. Every post carries `RELAY_POST_TIMEOUT_SECONDS`."""

    def test_finish_confirms_the_boards_held_with_an_empty_batch(self):
        self.append(STREAM_TEXT)
        whole = STREAM_TEXT.encode("utf-8")
        board = FakeStreamBoard()
        answer, _err = self.run_relay(board)
        last = board.all_posts()[-1]["payload"]
        self.assertEqual(last["data"], "", "the last post is the empty confirming batch")
        self.assertEqual(last["from"], len(whole), "it is sent at from: held")
        self.assertEqual(held_of(answer), len(whole))
        self.assertFalse(stopped_of(answer))
        self.assert_bodies_are_the_relays(board)

    def test_every_post_carries_the_relays_post_timeout(self):
        self.append(STREAM_TEXT)
        board = FakeStreamBoard()
        self.run_relay(board)
        timeouts = {post["timeout"] for post in board.all_posts()}
        self.assertEqual(timeouts, {RUN.RELAY_POST_TIMEOUT_SECONDS},
                         "each post is made with RELAY_POST_TIMEOUT_SECONDS")

    def test_the_relay_sends_while_the_runner_works(self):
        self.fast_ticks()
        first = json.dumps({"event": "run-start", "total": 2}) + "\n"
        second = json.dumps({"event": "test-end", "name": "a", "status": "pass"}) + "\n"
        self.append(first)
        board = FakeStreamBoard()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            saw_first = wait_until(lambda: board.held_bytes() == first.encode())
            self.append(second)
            saw_second = wait_until(lambda: board.held_bytes() == (first + second).encode())
            board.phase = "finish"
            relay.finish(5.0)
        self.assertTrue(saw_first, "the first line reaches the board before finish")
        self.assertTrue(saw_second, "a line written later reaches it on a later tick")
        self.assertEqual([p["payload"]["from"] for p in board.data_posts("run")],
                         [0, len(first.encode())])

    def test_finish_returns_within_its_bound_while_a_post_hangs(self):
        self.fast_ticks()
        patcher = mock.patch.object(RUN, "RELAY_POST_TIMEOUT_SECONDS", 0.3)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.append(STREAM_TEXT)
        whole = STREAM_TEXT.encode("utf-8")
        board = FakeStreamBoard()
        release = threading.Event()
        board.block_first = release
        self.addCleanup(release.set)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            self.assertTrue(wait_until(lambda: len(board.all_posts()) >= 1))
            began = time.monotonic()
            answer = relay.finish(1.0)
            elapsed = time.monotonic() - began
        release.set()
        self.assertLess(elapsed, 0.3 + 1.0 + 1.0,
                        f"the join is bounded by the post timeout and the sends by "
                        f"the deadline; finish took {elapsed:.2f}s")
        self.assertEqual(board.held_bytes(), whole,
                         "finish sent the batch the hung post never had acknowledged")
        self.assertEqual(held_of(answer), len(whole))

    def test_the_relays_thread_is_stopped_once_finish_returns(self):
        self.fast_ticks()
        self.append(STREAM_TEXT)
        board = FakeStreamBoard()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            relay = self.relay(board)
            relay.start()
            started = [t for t in threading.enumerate()
                       if t not in self.threads_before and t.is_alive()]
            relay.finish(5.0)
        self.assertEqual(len(started), 1, f"start runs one background thread: {started!r}")
        self.assertTrue(wait_until(lambda: not started[0].is_alive(), timeout=2.0),
                        "finish stops the relay's thread")


def _module_assignments(source, name):
    return [node for node in ast.parse(source).body
            if isinstance(node, (ast.Assign, ast.AnnAssign))
            and any(isinstance(t, ast.Name) and t.id == name
                    for t in (node.targets if isinstance(node, ast.Assign) else [node.target]))]


def _relay_class(source):
    found = [node for node in ast.walk(ast.parse(source))
             if isinstance(node, ast.ClassDef) and node.name == "StreamRelay"]
    return found[0] if found else None


def spelled_constant_values(source, values):
    """The numeric literals inside `StreamRelay` whose value is one of
    `values` (0 and 1 aside): a relay constant spelled where its name belongs.
    None when the source holds no `StreamRelay`."""
    relay = _relay_class(source)
    if relay is None:
        return None
    wanted = {v for v in values if v not in (0, 1)}
    return [node.value for node in ast.walk(relay)
            if isinstance(node, ast.Constant) and not isinstance(node.value, bool)
            and isinstance(node.value, (int, float)) and node.value in wanted]


#: What reading an event would take: a JSON parse, or an event kind's name.
_EVENT_NAMES = ("run-start", "test-end", "run-end")
_PARSE_CALLS = ("loads", "load", "JSONDecoder", "raw_decode")


def event_reads(source):
    """What inside `StreamRelay` reads the stream's events: a JSON parse, an
    event kind's name, or the `event` key. None when the source holds no
    `StreamRelay`."""
    relay = _relay_class(source)
    if relay is None:
        return None
    found = []
    for node in ast.walk(relay):
        if isinstance(node, ast.Call):
            func = node.func
            name = (func.attr if isinstance(func, ast.Attribute)
                    else func.id if isinstance(func, ast.Name) else None)
            if name in _PARSE_CALLS:
                found.append(f"call {name}")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in _EVENT_NAMES or node.value == "event":
                found.append(f"names {node.value!r}")
    return found


SYNTHETIC_RELAY_THAT_COUNTS = '''
import json
class StreamRelay:
    def _tick(self, text):
        for line in text.splitlines():
            if json.loads(line).get("event") == "test-end":
                self.count += 1
        time.sleep(2.0)
'''

SYNTHETIC_RELAY_THAT_FORWARDS = '''
import json
RELAY_SECONDS = 2.0
class StreamRelay:
    def _tick(self, text):
        body = json.dumps({"data": text, "from": self.held})
        self._post(body, timeout=RELAY_POST_TIMEOUT_SECONDS)
        self._stop.wait(RELAY_SECONDS)
        return 0
'''


class TheRelaysConstantsAreNamedTest(unittest.TestCase):
    """AC4: `RELAY_SECONDS`, `RELAY_POST_TIMEOUT_SECONDS`, `RELAY_FINISH_ATTEMPTS`
    and `RELAY_DEFAULT_BATCH_BYTES` are each one named constant."""

    NAMES = ("RELAY_SECONDS", "RELAY_POST_TIMEOUT_SECONDS", "RELAY_FINISH_ATTEMPTS",
             "RELAY_DEFAULT_BATCH_BYTES")

    def test_the_four_relay_constants_carry_their_values(self):
        self.assertEqual(RUN.RELAY_SECONDS, 2.0, "P3: the board's LIVE_FRAME_MS")
        self.assertEqual(RUN.RELAY_DEFAULT_BATCH_BYTES, 1024 * 1024)
        timeout = RUN.RELAY_POST_TIMEOUT_SECONDS
        self.assertTrue(isinstance(timeout, (int, float)) and not isinstance(timeout, bool)
                        and timeout > 0, f"a post timeout in seconds: {timeout!r}")
        attempts = RUN.RELAY_FINISH_ATTEMPTS
        self.assertTrue(isinstance(attempts, int) and not isinstance(attempts, bool)
                        and attempts >= 1, f"a count of tries: {attempts!r}")
        self.assertIs(AXI.StreamRelay, RUN.StreamRelay,
                      "the core re-exports the relay as it does every run-module name")

    def test_each_constant_is_assigned_once_in_the_run_module(self):
        source = RUN_MODULE_PATH.read_text(encoding="utf-8")
        for name in self.NAMES:
            with self.subTest(name=name):
                self.assertEqual(len(_module_assignments(source, name)), 1,
                                 f"{name} is one module-level constant of _crucible_run.py")

    def test_the_spelled_value_checker_tells_a_spelled_value_from_a_name(self):
        self.assertEqual(spelled_constant_values(SYNTHETIC_RELAY_THAT_COUNTS, (2.0, 5)), [2.0])
        self.assertEqual(spelled_constant_values(SYNTHETIC_RELAY_THAT_FORWARDS, (2.0, 5)), [])
        self.assertIsNone(spelled_constant_values("x = 2.0\n", (2.0,)))

    def test_the_relay_spells_no_constants_value(self):
        source = RUN_MODULE_PATH.read_text(encoding="utf-8")
        values = [getattr(RUN, name) for name in self.NAMES]
        self.assertEqual(spelled_constant_values(source, values), [],
                         "StreamRelay reads its bounds through the named constants")


class TheRelayDecodesNothingTest(unittest.TestCase):
    """§S2: the relay decodes and counts nothing — counting tests is the
    client's job."""

    def test_the_event_read_checker_flags_a_parse_and_passes_a_forwarder(self):
        flagged = event_reads(SYNTHETIC_RELAY_THAT_COUNTS) or []
        self.assertIn("call loads", flagged)
        self.assertIn("names 'test-end'", flagged)
        self.assertIn("names 'event'", flagged)
        self.assertEqual(event_reads(SYNTHETIC_RELAY_THAT_FORWARDS), [])
        self.assertIsNone(event_reads("def f():\n    return 1\n"))

    def test_the_shared_relay_reads_no_event(self):
        source = RUN_MODULE_PATH.read_text(encoding="utf-8")
        self.assertEqual(event_reads(source), [],
                         "StreamRelay exists in _crucible_run.py and parses no event")


if __name__ == "__main__":
    unittest.main()
