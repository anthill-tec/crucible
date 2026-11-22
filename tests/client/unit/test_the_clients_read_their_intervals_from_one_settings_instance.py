"""The clients read their intervals from one mutable settings instance.

The run module holds ONE settings instance, which the shared core re-exports
by identity, so a client's `_axi().SETTINGS` is the very object the relay,
the stream tick, the narrator, the gate-run ladder and every client's `_get`
read. It holds today's values. A reader reads its attribute at the point of
use — the relay and the stream tick when they wake, the narrator when it is
built, `_get` when it is called — so an attribute set on the instance
reaches code built before it was set (and the narrator keeps what it read).
An explicit `min_seconds` or `timeout` still wins over the setting.

The old module constants are gone, so a test that still patches one fails
loudly instead of silently patching nothing.

Unit tier: no process, no socket, no real-time wait — the clock, the events
and the threads are fakes (`tests/client/client_interval_fakes.py`). Every
attribute a test sets is restored in its cleanup.
"""

import unittest
from unittest import mock

from tests.client import load_client
from tests.client.client_cadence_settings import DEFAULTS, short_settings
from tests.client.client_interval_fakes import (
    FakeClock,
    ProcessUntil,
    UrlopenResponse,
    fake_threading,
)

CLIENT_NAMES = ("arduino-crucible.py", "bun-crucible.py", "go-crucible.py",
                "mvn-crucible.py", "python-crucible.py", "rust-crucible.py")
BOARD = "http://127.0.0.1:9"
STATUS_PATH = "/api/v2/health"


class OneSettingsInstanceHoldsTodaysValuesTest(unittest.TestCase):

    def test_the_core_re_exports_the_run_modules_settings_instance_by_identity(self):
        for name in CLIENT_NAMES:
            with self.subTest(client=name):
                axi = load_client(name)._axi()
                self.assertIs(axi.SETTINGS, axi._RUN.SETTINGS,
                              "the core's SETTINGS is the run module's own instance")

    def test_the_settings_instance_holds_todays_intervals(self):
        settings = load_client("python-crucible.py")._axi().SETTINGS
        self.assertEqual({name: getattr(settings, name) for name in DEFAULTS},
                         {"relay_seconds": 2.0, "narrator_seconds": 2.0,
                          "gate_poll_cadence_seconds": 2.0,
                          "gate_poll_tick_seconds": 0.4,
                          "read_timeout_seconds": 10})

    def test_a_value_set_through_the_core_is_the_value_the_run_module_sees(self):
        client = load_client("python-crucible.py")
        short_settings(self, client, relay_seconds=0.25)
        self.assertEqual(client._axi()._RUN.SETTINGS.relay_seconds, 0.25,
                         "the instance is mutated in place, never rebound")


class TheOldConstantsAreGoneTest(unittest.TestCase):

    def setUp(self):
        self.axi = load_client("python-crucible.py")._axi()

    def test_patching_the_relay_constant_fails_loudly(self):
        for module, label in ((self.axi._RUN, "run module"), (self.axi, "core")):
            with self.subTest(module=label), self.assertRaises(AttributeError), \
                    mock.patch.object(module, "RELAY_SECONDS", 60.0):
                pass

    def test_patching_the_gate_poll_constants_fails_loudly(self):
        for name in ("_GATE_POLL_CADENCE_S", "_GATE_POLL_TICK_S"):
            with self.subTest(name=name), self.assertRaises(AttributeError), \
                    mock.patch.object(self.axi, name, 0.5):
                pass


class TheRelayAndTheStreamTickReadTheirTickWhenTheyWakeTest(unittest.TestCase):

    def setUp(self):
        self.client = load_client("python-crucible.py")
        self.run = self.client._axi()._RUN

    def test_a_relay_built_before_its_tick_is_set_waits_the_tick_set(self):
        events = []
        with mock.patch.object(self.run, "threading", fake_threading(events)):
            relay = self.client._axi().StreamRelay(
                lambda path, payload, timeout=None: {"ok": True, "held": 0},
                "settings-key", "settings-agent", "run-settings-1",
                "/nonexistent-relay-dir/stream.jsonl", "crucible-events", None)
            short_settings(self, self.client, relay_seconds=0.25)
            relay.start()
        self.assertEqual([w for e in events for w in e.waits], [0.25])

    def test_a_stream_tick_built_before_its_tick_is_set_waits_the_tick_set(self):
        events = []
        with mock.patch.object(self.run, "threading", fake_threading(events)):
            ticks = self.client._axi().StreamTicks(lambda message: None,
                                                   "/nonexistent-ticks-dir/stream.jsonl")
            short_settings(self, self.client, relay_seconds=0.3)
            ticks.start()
        self.assertEqual([w for e in events for w in e.waits], [0.3])


class TheNarratorReadsItsThrottleWhenBuiltTest(unittest.TestCase):

    def setUp(self):
        self.client = load_client("python-crucible.py")
        self.clock = FakeClock()
        patcher = mock.patch.object(self.client._axi()._RUN, "time", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.posts = []

    def completions_at(self, narrator, *offsets):
        """Observe one completion at each offset (seconds after the first)."""
        start = self.clock.monotonic()
        for offset in offsets:
            self.clock.advance(start + offset - self.clock.monotonic())
            narrator.observe("one completion")

    def test_a_narrator_built_with_no_throttle_uses_the_setting(self):
        short_settings(self, self.client, narrator_seconds=0.5)
        narrator = self.client._axi().RunNarrator(self.posts.append, lambda line: True)
        self.completions_at(narrator, 0.0, 0.499)
        self.assertEqual(self.posts, [], "0.499 s is inside a 0.5 s throttle")
        self.completions_at(narrator, 0.001)
        self.assertEqual(self.posts, ["running 3"], "0.5 s lets one update through")

    def test_a_narrator_given_none_uses_the_setting(self):
        short_settings(self, self.client, narrator_seconds=0.5)
        narrator = self.client._axi().RunNarrator(self.posts.append, lambda line: True,
                                                  min_seconds=None)
        self.completions_at(narrator, 0.0, 0.5)
        self.assertEqual(self.posts, ["running 2"])

    def test_the_narrator_keeps_the_throttle_it_read_when_it_was_built(self):
        settings = short_settings(self, self.client, narrator_seconds=0.5)
        narrator = self.client._axi().RunNarrator(self.posts.append, lambda line: True)
        settings.narrator_seconds = 2.0
        self.completions_at(narrator, 0.0, 0.5)
        self.assertEqual(self.posts, ["running 2"],
                         "the throttle is read when the narrator is built")

    def test_an_explicit_throttle_wins_over_the_setting(self):
        short_settings(self, self.client, narrator_seconds=0.5)
        narrator = self.client._axi().RunNarrator(self.posts.append, lambda line: True,
                                                  min_seconds=3.0)
        self.completions_at(narrator, 0.0, 0.5, 2.999)
        self.assertEqual(self.posts, [], "the explicit 3.0 s throttle holds")
        self.completions_at(narrator, 0.001)
        self.assertEqual(self.posts, ["running 4"])


class EachClientsReadTimeoutIsTheSettingWhenCalledTest(unittest.TestCase):

    def get_timeout(self, client, *args, **kwargs):
        with mock.patch.object(client, "_base_url", return_value=BOARD), \
                mock.patch("urllib.request.urlopen",
                           return_value=UrlopenResponse()) as urlopen:
            self.assertEqual(client._get(STATUS_PATH, *args, **kwargs), {"ok": True})
        self.assertEqual(urlopen.call_count, 1)
        return urlopen.call_args.kwargs.get("timeout")

    def test_each_clients_get_reads_the_read_timeout_setting_when_called(self):
        for name in CLIENT_NAMES:
            with self.subTest(client=name):
                client = load_client(name)
                short_settings(self, client, read_timeout_seconds=1.5)
                self.assertEqual(self.get_timeout(client), 1.5)

    def test_each_clients_get_reads_a_setting_changed_between_calls(self):
        for name in CLIENT_NAMES:
            with self.subTest(client=name):
                client = load_client(name)
                settings = short_settings(self, client, read_timeout_seconds=1.5)
                self.assertEqual(self.get_timeout(client), 1.5)
                settings.read_timeout_seconds = 4.0
                self.assertEqual(self.get_timeout(client), 4.0)

    def test_an_explicit_timeout_wins_over_the_setting(self):
        client = load_client("python-crucible.py")
        short_settings(self, client, read_timeout_seconds=1.5)
        self.assertEqual(self.get_timeout(client, timeout=3), 3)


class TheGateRunLadderReadsItsCadenceAndTickTest(unittest.TestCase):

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

    def test_the_ladder_sleeps_the_tick_and_polls_the_cadence_set(self):
        short_settings(self, self.client, gate_poll_cadence_seconds=0.5,
                       gate_poll_tick_seconds=0.1)
        self.axi.stream_axi_ladder(
            ProcessUntil(self.clock, 1.2), "/nonexistent/no-mistakes",
            "read the ladder's cadence", "/nonexistent-project", "settings-agent",
            {}, ops=None)
        self.assertEqual(set(self.clock.sleeps), {0.1},
                         f"every wake sleeps 0.1 s; sleeps={self.clock.sleeps!r}")
        self.assertEqual(len(self.clock.sleeps), 12)
        self.assertEqual(self.polled_at, [0.0, 0.5, 1.0])


if __name__ == "__main__":
    unittest.main()
