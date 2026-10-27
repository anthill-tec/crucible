#!/usr/bin/env python3
"""Freeze each stack client's own parse of the real reports beside them.

For every fixture directory under `tests/fixtures/reports/` this writes an
`expected.json` holding what that stack's client computes from the fixture
TODAY, by calling the client's own parser functions (each client module is
imported by path from `clients/`; nothing here re-implements a parse):

  bun      `_parse_junit_file` + `_marry_failures` (the console) + `_parse_lcov`
  python   `_parse_junit_dir` (`by_classname` for the pytest report, as the
           `test` verb runs it; `auto-ingest`'s ungrouped tree beside it) +
           `_collect_coverage` (fed the fixture's lcov)
  mvn      `_report_dirs` / `_dirs_with_xml` (surefire, then failsafe — the
           order the regression verb reads them) + `_parse_junit` +
           `_collect_jacoco` (the CSVs it selects under the fixture tree)
  rust     `_parse_junit` + `_parse_lcov`
  arduino  `_parse_junit` per `TEST-*.xml`, aggregated as the native-test run
           body aggregates them + `_collect_lcov`

Each `expected.json` also names its inputs — the report files in the order the
client reads them, the coverage files and their codec, and (bun) the console —
so a test can send the same texts to the board in the same order.

Run from anywhere: `python3 tests/fixtures/reports/freeze-client-parse.py`.
"""

import glob
import importlib.util
import json
import os
import shutil
import sys
import tempfile

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


def freeze_bun():
    bun = _client("bun")
    d = os.path.join(HERE, "bun")
    junit = os.path.join(d, "junit.xml")
    with open(os.path.join(d, "console.txt")) as f:
        console = f.read()
    summary, tree, files = bun._parse_junit_file(junit)
    bun._marry_failures(tree, console)
    coverage = bun._parse_lcov(os.path.join(d, "lcov.info"))
    _write(d, {
        "stack": "bun",
        "reports": ["junit.xml"],
        "coverage": {"codec": "lcov", "reports": ["lcov.info"]},
        "raw": "console.txt",
        "client": {"summary": summary, "tree": tree, "files": files,
                   "coverage": coverage},
    })


def _python_coverage(python_client, lcov_file):
    """`_collect_coverage` itself, fed the fixture's lcov: the `coverage lcov`
    step it spawns is replaced by a no-op command, so it reads the lcov the
    real run wrote, at the path it derives beside the data file."""
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copyfile(lcov_file, os.path.join(tmp, "coverage.lcov"))
        return python_client._collect_coverage(
            shutil.which("true"), tmp, dict(os.environ),
            data_file=os.path.join(tmp, ".coverage"))


def freeze_python():
    python = _client("python")
    for runner, by_classname in (("xmlrunner", False), ("pytest", True)):
        d = os.path.join(HERE, "python", runner)
        reports = sorted(glob.glob(os.path.join(d, "TEST-*.xml")))
        summary, tree, files = python._parse_junit_dir(d, by_classname=by_classname)
        coverage = _python_coverage(python, os.path.join(d, "lcov.info"))
        document = {
            "stack": "python",
            "reports": _rel(d, reports),
            "coverage": {"codec": "lcov", "reports": ["lcov.info"]},
            "client": {"summary": summary, "tree": tree, "files": files,
                       "coverage": coverage},
        }
        if by_classname:
            # `auto-ingest` reads the same directory without grouping.
            document["clientAutoIngestTree"] = python._parse_junit_dir(d)[1]
        _write(d, document)


def freeze_mvn():
    mvn = _client("mvn")
    d = os.path.join(HERE, "mvn")
    dirs = []
    for kind in ("surefire", "failsafe"):
        dirs += mvn._report_dirs(d, None, kind)
    dirs = mvn._dirs_with_xml(dirs)
    reports = []
    for report_dir in dirs:
        reports += sorted(glob.glob(os.path.join(report_dir, "TEST-*.xml")))
    summary, tree, files = mvn._parse_junit(dirs)
    coverage = mvn._collect_jacoco(d)
    csvs = sorted(set(glob.glob(os.path.join(d, "**", "target", "site", "jacoco", "jacoco.csv"),
                                recursive=True)))
    _write(d, {
        "stack": "mvn",
        "reports": _rel(d, reports),
        "coverage": {"codec": "jacoco", "reports": _rel(d, csvs)},
        "client": {"summary": summary, "tree": tree, "files": files,
                   "coverage": coverage},
    })


def freeze_rust():
    rust = _client("rust")
    d = os.path.join(HERE, "rust")
    summary, tree, files = rust._parse_junit(os.path.join(d, "junit.xml"))
    coverage = rust._parse_lcov(os.path.join(d, "lcov.info"))
    _write(d, {
        "stack": "rust",
        "reports": ["junit.xml"],
        "coverage": {"codec": "lcov", "reports": ["lcov.info"]},
        "client": {"summary": summary, "tree": tree, "files": len(files),
                   "coverage": coverage},
    })


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
    freeze_bun()
    freeze_python()
    freeze_mvn()
    freeze_rust()
    freeze_arduino()


if __name__ == "__main__":
    main()
