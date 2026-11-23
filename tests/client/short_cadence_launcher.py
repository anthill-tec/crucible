# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Run one client as its own process on short cadences — a test-only launcher.

A test that drives a REAL client as an OS process cannot reach the client's
timers: the relay and stream tick, the narrator throttle, the gate-run poll
cadence and tick, and the board read timeout are fixed for the life of the
process. This launcher is spawned in the client's place:

    <python> tests/client/short_cadence_launcher.py \\
        [--relay-seconds S] [--narrator-seconds S] \\
        [--gate-poll-cadence-seconds S] [--gate-poll-tick-seconds S] \\
        [--read-timeout-seconds S] \\
        <client path> [verb args...]

It loads the EXACT client file it is handed — the path the harness already
spawns, in the suite's test install — never the repository's `clients/`, and
never a path with its links resolved, so the client derives its install from
where it was spawned, exactly as it does when spawned directly. Then it:

  - sets `sys.argv` to `[client path, *verb args]` and `sys.path[0]` to the
    client's directory, as running the client directly would;
  - sets each value it was given as an ATTRIBUTE of the client's one mutable
    settings instance, `module._axi().SETTINGS`, which it never rebinds; a
    client without that instance, or without that attribute, is an error
    that ends the run loudly, never a value silently dropped;
  - calls `module.main()` on the main thread. It catches nothing and installs
    no signal handler, so the client's exit code, its envelopes and its
    signal handling — `128 + SIGINT` included — are the client's own.

Each value must be at or above the safe minimum the suite allows for that
interval; a shorter one is refused before the client is loaded.

Like every client, it opens with an inline script-metadata header (`# ///
script`, standard library only), so `uv run` runs it as a standalone script:
no project is built and no network is needed, as in a hermetic run.

The launcher imports nothing from `tests.client` (it runs with the client's
directory, not the suite's, on its path), and its file name does not start
with `test_`, so test discovery never collects it. Nothing in production
reads it: it exists only for the suite.
"""

import argparse
import importlib.util
import os
import sys

#: Each option: (flag, the settings attribute it sets, its safe minimum).
SETTINGS_OPTIONS = (
    ("--relay-seconds", "relay_seconds", 0.2),
    ("--narrator-seconds", "narrator_seconds", 0.2),
    ("--gate-poll-cadence-seconds", "gate_poll_cadence_seconds", 0.3),
    ("--gate-poll-tick-seconds", "gate_poll_tick_seconds", 0.05),
    ("--read-timeout-seconds", "read_timeout_seconds", 1.0),
)

#: The name the client is loaded under: never `__main__`, so its own
#: `if __name__ == "__main__": main()` does not run while it loads.
CLIENT_MODULE_NAME = "crucible_client_under_short_cadences"


def parse(argv):
    """`(settings, client path, verb args)` from the launcher's own argv."""
    parser = argparse.ArgumentParser(
        prog="short_cadence_launcher.py",
        description="Run one client on short cadences (test-only).")
    for flag, attribute, _minimum in SETTINGS_OPTIONS:
        parser.add_argument(flag, dest=attribute, type=float, default=None)
    parser.add_argument("client")
    parser.add_argument("verb_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    settings = {}
    for flag, attribute, minimum in SETTINGS_OPTIONS:
        value = getattr(args, attribute)
        if value is None:
            continue
        if value < minimum:
            parser.error(f"{flag} {value} is below the safe minimum {minimum}")
        settings[attribute] = value
    return settings, args.client, list(args.verb_args)


def load(client_path):
    """The client module at exactly `client_path` (made absolute, links kept)."""
    spec = importlib.util.spec_from_file_location(CLIENT_MODULE_NAME, client_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load the client {client_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[CLIENT_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def apply(module, settings):
    """Set each value as an attribute of the client's one settings instance."""
    instance = module._axi().SETTINGS
    for attribute, value in settings.items():
        if not hasattr(instance, attribute):
            raise AttributeError(
                f"the client's settings have no {attribute!r}: {instance!r}")
        setattr(instance, attribute, value)


def main(argv=None):
    settings, client, verb_args = parse(sys.argv[1:] if argv is None else argv)
    client_path = os.path.abspath(client)
    sys.argv = [client_path, *verb_args]
    sys.path[0] = os.path.dirname(client_path)
    module = load(client_path)
    apply(module, settings)
    return module.main()


if __name__ == "__main__":
    main()
