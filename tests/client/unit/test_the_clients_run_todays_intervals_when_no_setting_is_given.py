"""With no setting given, every client runs today's intervals.

Each value is observed on running production code, through mocks on a client
loaded from the suite's test install — never read from source:

  - the relay's halt event, and the stream tick's, are waited on for 2.0 s;
  - the narrator posts nothing for a completion 1.999 s after the first, and
    posts one exactly 2.0 s after it;
  - each of the six clients' `_get` hands `urlopen` `timeout=10`;
  - the gate-run ladder sleeps 0.4 s between wakes and polls 2.0 s apart.

Unit tier: no process, no socket, no real-time wait — the clock, the events
and the threads are fakes (`tests/client/client_interval_fakes.py`).
"""

import unittest
from unittest import mock

from tests.client import load_client
from tests.client.client_interval_fakes import (
    FakeClock,
    ProcessUntil,
    UrlopenResponse,
    fake_threading,
)

CLIENT_NAMES = ("arduino-crucible.py", "bun-crucible.py", "eda-crucible.py",
                "go-crucible.py", "mvn-crucible.py", "python-crucible.py",
                "rust-crucible.py")
BOARD = "http://127.0.0.1:9"
STATUS_PATH = "/api/v2/health"


def _run_module(client):
    return client._axi()._RUN


def _start_relay_recording_its_waits(client, tmpdir="/nonexistent-relay-dir"):
    """Start the shared relay of `client` with recording events and a
    synchronous thread; answers every wait timeout its events recorded."""
    run = _run_module(client)
    events = []
    with mock.patch.object(run, "threading", fake_threading(events)):
        relay = client._axi().StreamRelay(
            lambda path, payload, timeout=None: {"ok": True, "held": 0},
            "interval-key", "interval-agent", "run-interval-1",
            f"{tmpdir}/stream.jsonl", "crucible-events", None)
        relay.start()
    return [w for e in events for w in e.waits]


def _start_ticks_recording_their_waits(client):
    run = _run_module(client)
    events = []
    with mock.patch.object(run, "threading", fake_threading(events)):
        ticks = client._axi().StreamTicks(lambda message: None,
                                          "/nonexistent-ticks-dir/stream.jsonl")
        ticks.start()
    return [w for e in events for w in e.waits]


class TheRelayAndTheStreamTickWaitTwoSecondsTest(unittest.TestCase):

    def setUp(self):
        self.client = load_client("python-crucible.py")

    def test_the_relays_halt_event_is_waited_on_for_two_seconds(self):
        waits = _start_relay_recording_its_waits(self.client)
        self.assertEqual(waits, [2.0],
                         "one wake of the relay's thread waits its 2.0 s tick on "
                         "the halt event, and nothing else is waited on")

    def test_the_stream_ticks_halt_event_is_waited_on_for_two_seconds(self):
        waits = _start_ticks_recording_their_waits(self.client)
        self.assertEqual(waits, [2.0],
                         "one wake of the stream tick's thread waits 2.0 s")


class TheNarratorThrottlesAtTwoSecondsTest(unittest.TestCase):

    def setUp(self):
        self.client = load_client("python-crucible.py")
        self.clock = FakeClock()
        patcher = mock.patch.object(_run_module(self.client), "time", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.posts = []

    def narrator(self):
        return self.client._axi().RunNarrator(self.posts.append, lambda line: True)

    def test_a_completion_at_1_999_s_posts_nothing_and_one_at_2_0_s_posts(self):
        narrator = self.narrator()
        narrator.observe("first completion")
        self.clock.advance(1.999)
        narrator.observe("second completion")
        self.assertEqual(self.posts, [],
                         "1.999 s after the first completion is inside the throttle")
        self.clock.advance(0.001)
        narrator.observe("third completion")
        self.assertEqual(self.posts, ["running 3"],
                         "2.0 s after the first completion the throttle lets one "
                         "update through, carrying the count so far")

    def test_after_a_post_the_next_needs_another_two_seconds(self):
        narrator = self.narrator()
        narrator.observe("first")
        self.clock.advance(2.0)
        narrator.observe("second")
        self.clock.advance(1.999)
        narrator.observe("third")
        self.assertEqual(self.posts, ["running 2"])
        self.clock.advance(0.001)
        narrator.observe("fourth")
        self.assertEqual(self.posts, ["running 2", "running 4"])


class EachClientsReadIsBoundedAtTenSecondsTest(unittest.TestCase):

    def test_each_clients_get_hands_urlopen_a_ten_second_timeout(self):
        for name in CLIENT_NAMES:
            with self.subTest(client=name):
                client = load_client(name)
                with mock.patch.object(client, "_base_url", return_value=BOARD), \
                        mock.patch("urllib.request.urlopen",
                                   return_value=UrlopenResponse()) as urlopen:
                    answer = client._get(STATUS_PATH)
                self.assertEqual(answer, {"ok": True})
                self.assertEqual(urlopen.call_count, 1)
                request = urlopen.call_args.args[0]
                self.assertEqual(request.full_url, BOARD + STATUS_PATH)
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(urlopen.call_args.kwargs, {"timeout": 10},
                                 f"{name}: the read path is bounded at 10 s")


class TheGateRunLadderPollsTwoSecondsApartTest(unittest.TestCase):

    def setUp(self):
        self.client = load_client("python-crucible.py")
        self.axi = self.client._axi()
        self.clock = FakeClock(start=0.0)
        self.polled_at = []

        def poll(no_mistakes_path):
            self.polled_at.append(self.clock.monotonic())
            return None

        for name, value in (("time", self.clock), ("poll_axi_snapshot", poll)):
            patcher = mock.patch.object(self.axi, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def drive(self, ends_at):
        return self.axi.stream_axi_ladder(
            ProcessUntil(self.clock, ends_at), "/nonexistent/no-mistakes",
            "pin the ladder's cadence", "/nonexistent-project", "interval-agent",
            {}, ops=None)

    def test_the_ladder_sleeps_0_4_s_and_polls_2_0_s_apart(self):
        posted = self.drive(ends_at=5.0)
        self.assertIs(posted, False, "no snapshot decoded, so no interim gate")
        self.assertEqual(set(self.clock.sleeps), {0.4},
                         f"every wake sleeps 0.4 s; sleeps={self.clock.sleeps!r}")
        self.assertEqual(len(self.clock.sleeps), 13,
                         "a 5.0 s run wakes every 0.4 s: 13 sleeps")
        self.assertEqual(self.polled_at, [0.0, 2.0, 4.0],
                         "the tool is asked at the start and then every 2.0 s")


if __name__ == "__main__":
    unittest.main()
