"""Witnesses: passing tests that record, from inside the run, what they see.

This module sorts last, so its tests run after every other case. Each one
writes ``<name>.json`` into the directory ``UNITTEST_PROJECT_WITNESS_DIR``
names:

* ``test_first_look_at_the_stream`` and ``test_second_look_at_the_stream``
  record the text of the file ``UNITTEST_PROJECT_WITNESS_STREAM`` names (the
  stream file, named again under a variable the runner leaves alone), or
  ``null`` when it cannot be read;
* ``test_records_its_environment`` records whether ``CRUCIBLE_STREAM`` is in
  its own environment, and its value.

Both variables are read when each test runs. With them unset -- as when
``expected.json`` was frozen -- each test records nothing and passes.
"""
import json
import os
import unittest

_WITNESS_DIR = "UNITTEST_PROJECT_WITNESS_DIR"
_WITNESS_STREAM = "UNITTEST_PROJECT_WITNESS_STREAM"


def _record(name, fields):
    directory = os.environ.get(_WITNESS_DIR)
    if not directory:
        return
    with open(os.path.join(directory, f"{name}.json"), "w", encoding="utf-8") as handle:
        json.dump(fields, handle)


def _stream_so_far():
    path = os.environ.get(_WITNESS_STREAM)
    if not path:
        return None
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return None


class WitnessTest(unittest.TestCase):

    def test_first_look_at_the_stream(self):
        _record("test_first_look_at_the_stream", {"stream": _stream_so_far()})

    def test_records_its_environment(self):
        _record("test_records_its_environment", {
            "present": "CRUCIBLE_STREAM" in os.environ,
            "value": os.environ.get("CRUCIBLE_STREAM"),
        })

    def test_second_look_at_the_stream(self):
        _record("test_second_look_at_the_stream", {"stream": _stream_so_far()})


if __name__ == "__main__":
    unittest.main()
