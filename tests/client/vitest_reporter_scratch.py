"""A scratch copy of the committed Vitest fixture, run on the REAL Vitest with
the shipped Crucible reporter handed in the way the bun client hands it.

Shared by the Vitest reporter's test modules (it is not itself a test module:
no `test_*.py` discovery collects it).

Interface choices these tests drive (the reporter and the fixture's config are
GREEN's to write; this is the contract they are driven through):

* **How the reporter is reached.** The runner's environment carries
  `CRUCIBLE_REPORTERS`, the DIRECTORY holding `vitest-crucible.ts` (the client
  computes it as its own install's `reporters/`). The fixture's
  `vitest.config.ts` adds `<CRUCIBLE_REPORTERS>/vitest-crucible.ts` to Vitest's
  `test.reporters` when -- and only when -- that variable is set, beside the
  reporters it already adds. The tests set the variable and nothing else: they
  never edit the scratch copy's config.
* **Where the reporter writes.** The reporter reads the file path from the
  environment variable `CRUCIBLE_STREAM` itself; the config passes it no
  option. The tests point it at a file that does not exist yet, inside a
  directory that does, and read that file back.
* **How Vitest runs.** Through the fixture's own declared script
  (`bun run test:vitest`, which is `bun --bun vitest run`), with any file
  filter appended, from the scratch copy. The scratch copy's `node_modules` is
  a directory of links to this repo's installed packages, so no network install
  is needed and Vitest's caches stay in the copy -- the same mechanism
  `test_bun_declared_test_script_runs_the_projects_runner` uses.

The extra test files the reporter tests need (a describe chain, skips, a todo,
a module that fails to load) are written into the scratch copy only, never into
the committed fixture, so the fixture's own test files stay exactly the ones
this repo's suite already keeps out of its bun discovery.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env

REPORTERS_DIR = REPO_ROOT / "clients" / "reporters"
REPORTER_NAME = "vitest-crucible.ts"
REPORTER = REPORTERS_DIR / REPORTER_NAME
VITEST_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "vitest-project"
REPO_NODE_MODULES = REPO_ROOT / "node_modules"
VITEST_SCRIPT = "test:vitest"
STREAM_VAR = "CRUCIBLE_STREAM"
REPORTERS_VAR = "CRUCIBLE_REPORTERS"
FIXTURE_JUNIT_VAR = "FIXTURE_JUNIT_PATH"
STREAM_FILE_NAME = "crucible-events.ndjson"
TIMEOUT = 180

# The committed fixture's own tests: three files, five tests, one failing.
FIXTURE_PASSING_CASE = "a passing case"
FIXTURE_FAILING_CASE = "a deliberately failing case"
FIXTURE_RUNTIME_CASE = "vitest runs on the bun runtime"
FIXTURE_ALPHA = "alpha matches the filter"
FIXTURE_BETA = "beta stays out of the filter"
FIXTURE_MIXED_FILE = "pass-and-fail.vitest.ts"

# The keys and value rules the board's `crucible-events` codec (`readEvent` in
# src/codecs/crucible-events.ts) applies to one parsed line.
_STATUSES = ("pass", "fail", "pending")


def require_vitest_toolchain(case):
    """The real `bun` and this repo's installed Vitest; returns bun's path."""
    bun = shutil.which("bun")
    case.assertIsNotNone(bun, "this proof needs the real `bun` on PATH: Vitest runs on it")
    case.assertTrue(
        (REPO_NODE_MODULES / "vitest" / "package.json").is_file(),
        "this proof needs this repo's dev dependencies installed (`bun install`): "
        "the fixture runs the real Vitest")
    case.assertTrue((VITEST_FIXTURE / "vitest.config.ts").is_file(),
                    f"the committed Vitest fixture is missing: {VITEST_FIXTURE}")
    return bun


def link_repo_node_modules(project):
    """A `node_modules` DIRECTORY of links to this repo's installed packages,
    so Vite's `.vite-temp` lands inside the copy, never in this repo."""
    target = Path(project, "node_modules")
    target.mkdir()
    for entry in REPO_NODE_MODULES.iterdir():
        if entry.name.startswith(".") and entry.name != ".bin":
            continue
        os.symlink(entry, target / entry.name)


def scratch_fixture(prefix, extra_files=None):
    """A scratch copy of the committed fixture, its `node_modules` linked, with
    `extra_files` ({name: source}) written beside the fixture's own tests.
    Returns `(scratch_root, project)`; the caller removes `scratch_root`."""
    scratch = new_scratch(prefix)
    project = os.path.join(scratch, "project")
    shutil.copytree(VITEST_FIXTURE, project)
    link_repo_node_modules(project)
    for name, source in (extra_files or {}).items():
        Path(project, name).write_text(source)
    return scratch, project


def run_fixture_vitest(bun, project, reporters_dir, stream_path, *file_filters):
    """`bun run test:vitest [filters…]` in the scratch copy.

    `reporters_dir` and `stream_path` set `CRUCIBLE_REPORTERS` and
    `CRUCIBLE_STREAM`; `None` leaves the variable UNSET (an inherited value is
    always removed first, as is the fixture's own JUnit variable)."""
    env = scrubbed_env(None, NO_COLOR="1", FORCE_COLOR="0")
    for key in (REPORTERS_VAR, STREAM_VAR, FIXTURE_JUNIT_VAR):
        env.pop(key, None)
    if reporters_dir is not None:
        env[REPORTERS_VAR] = str(reporters_dir)
    if stream_path is not None:
        env[STREAM_VAR] = str(stream_path)
    return subprocess.run([bun, "run", VITEST_SCRIPT, *file_filters], cwd=project,
                          env=env, capture_output=True, text=True, timeout=TIMEOUT,
                          check=False)


def diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-2500:]!r} "
            f"stderr={result.stderr[-2500:]!r}")


def stream_events(case, stream_path, result):
    """The stream file's lines, each parsed: fails the test, naming the run,
    when the file is absent or a line is not one complete JSON object."""
    case.assertTrue(
        os.path.isfile(stream_path),
        f"the reporter wrote no stream at {STREAM_VAR}={stream_path}: with "
        f"{REPORTERS_VAR} set, the fixture's config must add the shipped reporter "
        f"({REPORTER}) and the reporter must write the file {STREAM_VAR} names; "
        f"{diagnostics(result)}")
    text = Path(stream_path).read_text()
    case.assertTrue(text.endswith("\n"),
                    f"every stream line is written whole, newline-terminated; "
                    f"tail={text[-300:]!r}")
    events = []
    for number, line in enumerate(text.split("\n")[:-1], start=1):
        try:
            parsed = json.loads(line)
        except ValueError as error:
            raise case.failureException(
                f"stream line {number} is not one complete JSON value "
                f"({error}): {line!r}") from error
        case.assertIsInstance(parsed, dict, f"stream line {number} is not a JSON object: {line!r}")
        events.append(parsed)
    return events


def codec_rejection(fields):
    """Why the board's `crucible-events` `readEvent` would read this parsed
    line as undecodable or unknown, or None when it reads it as a known event."""
    kind = fields.get("event")
    if kind == "run-start":
        total = fields.get("total")
        if total is not None and not _is_count(total):
            return f"run-start total {total!r} is not a count"
        return None
    if kind == "test-end":
        if not isinstance(fields.get("name"), str):
            return "test-end has no string `name`"
        if fields.get("status") not in _STATUSES:
            return f"test-end status {fields.get('status')!r} is not one of {_STATUSES}"
        for key in ("id", "suite", "file"):
            if key in fields and not isinstance(fields[key], str):
                return f"test-end `{key}` is not a string"
        if "duration_ms" in fields and not _is_duration(fields["duration_ms"]):
            return f"test-end duration_ms {fields['duration_ms']!r} is not a duration"
        if "failure" in fields:
            failure = fields["failure"]
            if not isinstance(failure, dict):
                return "test-end failure is not an object"
            for key in ("message", "type", "trace"):
                if key in failure and not isinstance(failure[key], str):
                    return f"test-end failure.{key} is not a string"
        return None
    if kind == "run-end":
        for key in ("total", "passed", "failed", "pending"):
            if not _is_count(fields.get(key)):
                return f"run-end `{key}` {fields.get(key)!r} is not a count"
        if "duration_ms" in fields and not _is_duration(fields["duration_ms"]):
            return f"run-end duration_ms {fields['duration_ms']!r} is not a duration"
        return None
    if isinstance(kind, str):
        return f"event kind {kind!r} is one no codec knows"
    return "line has no string `event`"


def _is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_duration(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and value >= 0 and value == value and value != float("inf"))
