"""The clients' interval settings, as the suite sets them.

Every client reads its intervals from ONE mutable settings instance, which its
shared core re-exports by identity: `client._axi().SETTINGS`. A test sets
attributes on that instance and never rebinds the name. This module holds the
suite's side of that:

  - `DEFAULTS`: the value of each setting when nothing is set;
  - `SHORT`: the shortest value the suite allows for each, which a converted
    test runs on unless it needs a longer one;
  - `short_settings(test, module, **values)`: set values on an in-process
    client's settings, restoring each in the test's cleanup;
  - `launcher_command(client, *verb_args, **values)`: the argv that spawns a
    client as its own process on short settings, through the test-only
    launcher (`short_cadence_launcher.py`), in place of
    `[sys.executable, client, *verb_args]`.

Holds no `TestCase` and no test.
"""

import sys
from pathlib import Path

#: The test-only launcher, run by path.
LAUNCHER = Path(__file__).resolve().parent / "short_cadence_launcher.py"

#: Each setting's value when nothing is set: today's production intervals.
DEFAULTS = {
    "relay_seconds": 2.0,
    "narrator_seconds": 2.0,
    "gate_poll_cadence_seconds": 2.0,
    "gate_poll_tick_seconds": 0.4,
    "read_timeout_seconds": 10,
}

#: The shortest value the suite allows for each setting.
SHORT = {
    "relay_seconds": 0.2,
    "narrator_seconds": 0.2,
    "gate_poll_cadence_seconds": 0.3,
    "gate_poll_tick_seconds": 0.05,
    "read_timeout_seconds": 1.0,
}

#: The launcher flag that sets each setting.
LAUNCHER_FLAGS = {name: "--" + name.replace("_", "-") for name in DEFAULTS}

#: The relay and stream tick and the narrator throttle a converted relay test
#: runs on, and how far below the production tick that is.
SHORT_RELAY = {"relay_seconds": SHORT["relay_seconds"],
               "narrator_seconds": SHORT["narrator_seconds"]}
RELAY_SCALE = SHORT["relay_seconds"] / DEFAULTS["relay_seconds"]


def settings_of(module):
    """The one settings instance a loaded client reads its intervals from."""
    return module._axi().SETTINGS


def short_settings(test, module, **values):
    """Set `values` on `module`'s settings instance (never rebinding it), and
    restore each previous value in `test`'s cleanup. Answers the instance."""
    instance = settings_of(module)
    for name, value in values.items():
        if name not in DEFAULTS:
            raise KeyError(f"no such client setting: {name!r}")
        test.addCleanup(setattr, instance, name, getattr(instance, name))
        setattr(instance, name, value)
    return instance


def launcher_flags(**values):
    """The launcher's own flags for `values`."""
    flags = []
    for name, value in values.items():
        if name not in LAUNCHER_FLAGS:
            raise KeyError(f"no such client setting: {name!r}")
        flags += [LAUNCHER_FLAGS[name], repr(float(value))]
    return flags


def launcher_command(client, *verb_args, python=None, **values):
    """The argv that runs `client` (the exact path a harness spawns) with
    `verb_args` through the launcher, on the settings `values`."""
    return [python or sys.executable, str(LAUNCHER), *launcher_flags(**values),
            str(client), *[str(a) for a in verb_args]]
