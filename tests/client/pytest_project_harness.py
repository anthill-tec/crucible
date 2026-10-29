"""Shared fixture for the tests that drive the python client on a REAL pytest
project.

The project is a scratch copy of the committed `tests/fixtures/pytest-project`
(its own `pytest.ini` names its test files `check_*.py`; three tests: one
passes, one fails, one is skipped), never the checkout's copy. Its `.env`
carries a project key and its own `crucible.toml` points the client at a
`RecordingBoard` on loopback, so no live board is ever touched. The client is
`clients/python-crucible.py`, driven as an OS subprocess with this suite's own
interpreter, which has pytest and coverage.py (both in the `[dev]` extras).

What a run filed is read from the board: the one `/api/v2/runs` body the
client sends -- its `codec`, the runner's JUnit report texts inline as
`data`, its lcov `coverage` report, its tier -- and the AXI envelope on the
client's stdout. The client parses none of those reports: the board decodes
them. So the counts, leaves and groups below are read by THIS harness from
the report texts the body carried, the way the board's `junit` codec reads
them (a suite pytest names `pytest` grouped by each case's `classname`, any
other suite one node), proving the runner's own report reached the board.
"""

import importlib.util
import json
import xml.etree.ElementTree as ET
import os
import shutil
import subprocess
import sys
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    REPO_ROOT,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "pytest-project"
TOON = load_toon()
TIMEOUT = 180
AGENT = "pytest-project-fixture-agent"
PROJECT_KEY = "pytest-project-fixture-key"
RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"

# Variables that, inherited from the shell running this suite, would decide
# the client's interpreter or project, or change what pytest/coverage.py run.
_INHERITED_KEYS = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR", "PYTEST_ADDOPTS",
                   "PYTEST_PLUGINS", "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

# The fixture's three tests, as the tree files them: grouped by `classname`,
# the module for a module-level test, the module and class for a test in a
# class.
FIXTURE_GROUPS = {
    "check_outcomes": [("test_it_fails", "fail"), ("test_it_passes", "pass")],
    "check_skipped.TestSkipped": [("test_it_is_skipped", "pending")],
}


def require_pytest_and_coverage():
    """These proofs run a real pytest under the client: they FAIL, never skip,
    when this suite's interpreter cannot import pytest or coverage.py."""
    missing = [name for name in ("pytest", "coverage")
               if importlib.util.find_spec(name) is None]
    if missing:
        raise AssertionError(
            f"{', '.join(missing)} must be importable by this suite's interpreter "
            f"(the [dev] extras); these proofs run a real pytest under the client")


def config_text(board_url, runner=None):
    """A whole `crucible.toml` for the scratch project: the recording board,
    a raised display limit, and the runner declaration when one is given."""
    text = (f"[client]\nurl = {json.dumps(board_url)}\n\n"
            "[limits.truncate_field_chars]\nvalue = 4000\n")
    if runner is not None:
        text += f"\n[python]\nrunner = {json.dumps(runner)}\n"
    return text


class ScratchProject:
    """One scratch project and the board it files to."""

    def __init__(self, prefix, from_fixture=True):
        self.root = new_scratch(prefix)
        self.dir = os.path.join(self.root, "project")
        if from_fixture:
            shutil.copytree(FIXTURE, self.dir,
                            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
        else:
            os.makedirs(self.dir)
        Path(self.dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        self.board = RecordingBoard()

    def close(self):
        self.board.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def declare(self, runner=None):
        Path(self.dir, "crucible.toml").write_text(config_text(self.board.url, runner))

    def write(self, rel, text):
        path = Path(self.dir, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def drive(self, argv):
        env = scrubbed_env(None)
        for key in _INHERITED_KEYS:
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), *argv,
               "--python", sys.executable, "--project-dir", self.dir]
        return subprocess.run(cmd, cwd=self.dir, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def runs_ingests(self):
        """Every body sent to `/api/v2/runs` (a run's report ingest)."""
        return [body for path, body in self.board.posts() if path == RUNS]

    def parsed_ingests(self):
        """Every body sent to the client-parsed route, which no python run
        uses any more."""
        return [body for path, body in self.board.posts() if path == PARSED]

    def compile_ingests(self):
        return [body for path, body in self.board.posts() if path == COMPILE]


def diag(result):
    return (f"exit={result.returncode} stdout={result.stdout[-2000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")


def envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def sent_cases(body):
    """Every `<testcase>` of the JUnit report texts a `/api/v2/runs` body
    carried as `data`, as `(group, name, status, file)`: `group` is the
    case's `classname` in a suite named `pytest`, else its suite's name;
    `status` is `fail` (a failure or error), `pending` (skipped) or `pass`."""
    cases = []
    for text in (body or {}).get("data") or []:
        root = ET.fromstring(text)  # noqa: S314 - the report this test's own run wrote
        suites = list(root.iter("testsuite")) or [root]
        for suite in suites:
            suite_name = suite.get("name", "?")
            for case in suite.findall("testcase"):
                group = (case.get("classname") or suite_name
                         if suite_name == "pytest" else suite_name)
                if case.find("failure") is not None or case.find("error") is not None:
                    status = "fail"
                elif case.find("skipped") is not None:
                    status = "pending"
                else:
                    status = "pass"
                cases.append((group, case.get("name"), status, case.get("file")))
    return cases


def suite_names(body):
    """The `<testsuite>` names of the report texts a body carried."""
    names = []
    for text in (body or {}).get("data") or []:
        root = ET.fromstring(text)  # noqa: S314 - the report this test's own run wrote
        names += [suite.get("name") for suite in (list(root.iter("testsuite")) or [root])]
    return names


def tree_groups(body):
    """`{group: sorted [(leaf name, leaf status)]}` over the report texts a
    `/api/v2/runs` body carried (`sent_cases`)."""
    groups = {}
    for group, name, status, _file in sent_cases(body):
        groups.setdefault(group, []).append((name, status))
    return {name: sorted(leaves) for name, leaves in groups.items()}


def leaves(body):
    """Every leaf `(name, status)` in the reports a body carried, sorted."""
    return sorted((name, status) for _g, name, status, _f in sent_cases(body))


def counts(body):
    """`{total, passed, failed, pending}` over the reports a body carried."""
    statuses = [status for _g, _n, status, _f in sent_cases(body)]
    return {"total": len(statuses), "passed": statuses.count("pass"),
            "failed": statuses.count("fail"), "pending": statuses.count("pending")}


def sent_files(body):
    """The distinct `file=` the reports a body carried stamp on their cases."""
    return {file for _g, _n, _s, file in sent_cases(body) if file}


def lcov_lines(body):
    """`(lines found, lines hit)` summed over the lcov report texts a body
    carried as `coverage.data`, or None when it carried no lcov report."""
    coverage = (body or {}).get("coverage")
    if not isinstance(coverage, dict) or coverage.get("codec") != "lcov":
        return None
    found = hit = 0
    for text in coverage.get("data") or []:
        for line in text.splitlines():
            if line.startswith("LF:"):
                found += int(line[3:])
            elif line.startswith("LH:"):
                hit += int(line[3:])
    return found, hit
