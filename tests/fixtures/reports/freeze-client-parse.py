#!/usr/bin/env python3
"""Freeze each stack client's own parse of the real reports beside them.

For every fixture directory under `tests/fixtures/reports/` this writes an
`expected.json` holding what that stack's client computes from the fixture
TODAY, by calling the client's own parser functions (each client module is
imported by path from `clients/`; nothing here re-implements a parse):

  arduino  `_parse_junit` per `TEST-*.xml`, aggregated as the native-test run
           body aggregates them + `_collect_lcov`

Each `expected.json` also names its inputs — the report files in the order the
client reads them and the coverage files and their codec — so a test can send
the same texts to the board in the same order.

bun, python, mvn and rust are not frozen here any more: their clients send
the runner's reports to the board and parse none of them (CR-CRU-204, and the
maven and rust clients after it), so there is no client parse left to freeze.
`bun/expected.json`, the two `python/*/expected.json`, `mvn/expected.json` and
`rust/expected.json` stay as they were frozen at CR-CRU-152's base, the record
of what those clients computed before the board took the parse.

Run from anywhere: `python3 tests/fixtures/reports/freeze-client-parse.py`.
"""

import glob
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
CLIENTS = os.path.join(REPO, "clients")


def _client(stack):
    """Import `clients/<stack>-crucible.py` by path."""
    path = os.path.join(CLIENTS, f"{stack}-crucible.py")
    spec = importlib.util.spec_from_file_location(f"{stack}_crucible_frozen", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load the {stack} client from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, CLIENTS)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(CLIENTS)
    return module


def _rel(fixture_dir, paths):
    return [os.path.relpath(p, fixture_dir).replace(os.sep, "/") for p in paths]


def _write(fixture_dir, document):
    with open(os.path.join(fixture_dir, "expected.json"), "w") as f:
        json.dump(document, f, indent=2, ensure_ascii=False)
        f.write("\n")


def freeze_arduino():
    arduino = _client("arduino")
    d = os.path.join(HERE, "arduino")
    reports = sorted(glob.glob(os.path.join(d, "reports", "TEST-*.xml")))
    # The native-test run body's aggregation, as it stands in the client.
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    files = 0
    for junit in reports:
        s, t, f = arduino._parse_junit(junit)
        for k in ("total", "passed", "failed", "pending"):
            summary[k] += s[k]
        files += f
        tree.extend(t)
    coverage = arduino._collect_lcov(os.path.join(d, "lcov.info"))
    _write(d, {
        "stack": "arduino",
        "reports": _rel(d, reports),
        "coverage": {"codec": "lcov", "reports": ["lcov.info"]},
        "client": {"summary": summary, "tree": tree, "files": files,
                   "coverage": coverage},
    })


def main():
    freeze_arduino()


if __name__ == "__main__":
    main()
