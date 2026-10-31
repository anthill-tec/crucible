"""The committed unittest fixture project, run through the python runner.

`tests/fixtures/unittest-project` is a real unittest project whose
`expected.json` freezes xmlrunner 4.0.0's report of its cases, read the way
the board reads it (see the README beside it). This module runs a scratch copy
of it through `clients/subtest_runner.py` as a subprocess, reads the Crucible
event stream the runner writes to the file `CRUCIBLE_STREAM` names (CR-CRU-224
§S1), and normalises and digests what it reads exactly as `expected.json` was
normalised and digested, so a comparison sees only what both sides state.

Not a test module: it holds no `TestCase`.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import new_scratch, scrubbed_env

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "unittest-project"
RUNNER = REPO_ROOT / "clients" / "subtest_runner.py"
EXPECTED_PATH = FIXTURE / "expected.json"

# The interpreter running this suite: the repo's `.venv` one, the runner's own.
PYTHON = sys.executable

# The interpreter's stdlib directory, the parent of `unittest`'s package dir:
# the `<stdlib>` of `expected.json`'s normalisation.
STDLIB = os.path.dirname(os.path.dirname(unittest.__file__))

DISCOVER_ALL = ["discover", "-s", "tests", "-p", "test_*.py", "-v"]
DISCOVER_WITNESSES = ["discover", "-s", "tests", "-p", "test_witness.py", "-v"]

WITNESS_DIR_VAR = "UNITTEST_PROJECT_WITNESS_DIR"
WITNESS_STREAM_VAR = "UNITTEST_PROJECT_WITNESS_STREAM"
STREAM_VAR = "CRUCIBLE_STREAM"

RUN_TIMEOUT = 120

_FRAME = re.compile(r'File "([^"]+)", line (\d+), in (.+)')


def expected():
    """The frozen record, read fresh."""
    return json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))


def copy_fixture(prefix):
    """A scratch copy of the fixture's package and tests (never its README or
    `expected.json`), removed when this process exits. Answers the copy's
    root."""
    scratch = new_scratch(prefix)
    project = Path(scratch, "project")
    shutil.copytree(FIXTURE, project, ignore=shutil.ignore_patterns(
        "__pycache__", "expected.json", "README.md"))
    return project


def runner_env(stream=None, **extra):
    """The runner's environment: this process's own, scrubbed, with no
    `CRUCIBLE_STREAM` and no witness variable inherited (a streamed client
    run of this very suite sets one), no bytecode written into the copy, and
    UTF-8 consoles. `stream` names the stream file when given."""
    env = scrubbed_env(None)
    for key in (STREAM_VAR, WITNESS_DIR_VAR, WITNESS_STREAM_VAR):
        env.pop(key, None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    if stream is not None:
        env[STREAM_VAR] = str(stream)
    env.update({k: str(v) for k, v in extra.items()})
    return env


def run_runner(cwd, args, env, flags=(), preexec_fn=None):
    """`<python> [flags] clients/subtest_runner.py <args>` in `cwd`."""
    return subprocess.run(
        [PYTHON, *flags, str(RUNNER), *args], cwd=str(cwd), env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=RUN_TIMEOUT, check=False, preexec_fn=preexec_fn)


def output_of(result):
    return (result.stdout or "") + (result.stderr or "")


def stream_text(path):
    """The stream file's text, or None when there is no such file."""
    path = Path(path)
    if not path.is_file():
        return None
    return path.read_bytes().decode("utf-8", "replace")


def stream_lines(text):
    """The stream's lines, each with its newline, blank lines dropped."""
    return [line for line in text.splitlines(keepends=True) if line.strip()]


def events_of(text):
    """Every stream line read as JSON."""
    return [json.loads(line) for line in stream_lines(text)]


def normalise(text, project):
    """`expected.json`'s path normalisation: the copy's root (and its real
    path) to `<project>`, the stdlib dir to `<stdlib>`."""
    if text is None:
        return None
    project = str(project)
    for root in sorted({project, os.path.realpath(project)}, key=len, reverse=True):
        text = text.replace(root, "<project>")
    for root in sorted({STDLIB, os.path.realpath(STDLIB)}, key=len, reverse=True):
        text = text.replace(root, "<stdlib>")
    return text


def digest(failure, project):
    """A failure's stable digest, as `expected.json` keeps it: the board's
    message rule (the trimmed message, else the trace's first non-blank
    line) cut to its first line; the type; the trace's first and last
    non-blank lines; and its frames in the project's own files."""
    message = (normalise(failure.get("message"), project) or "").strip()
    trace = (normalise(failure.get("trace"), project) or "").strip()
    lines = [line.strip() for line in trace.split("\n") if line.strip()]
    if not message and lines:
        message = lines[0]
    return {
        "message": message.split("\n")[0] if message else None,
        "type": failure.get("type") or None,
        "traceHead": lines[0] if lines else None,
        "traceTail": lines[-1] if lines else None,
        "frames": [[p, int(n), fn] for p, n, fn in _FRAME.findall(trace)
                   if p.startswith("<project>/")],
    }


def is_duration(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and value >= 0)


def console_description(case_id):
    """The description unittest's verbose console prints for a counted case
    of this id: `<method> (<test id>)`, then a subtest's own description; an
    error holder's id is its description already."""
    base, _, rest = case_id.partition(" ")
    if "." not in base:
        return case_id
    method = base.rsplit(".", 1)[1]
    described = f"{method} ({base})"
    return f"{described} {rest}" if rest else described


class FixtureRun:
    """One run of a scratch copy of the whole fixture through the runner,
    streamed, with its witnesses recording."""

    def __init__(self, prefix):
        self.project = copy_fixture(prefix)
        scratch = self.project.parent
        self.stream = scratch / "crucible-events.ndjson"
        self.witness_dir = scratch / "witness"
        self.witness_dir.mkdir()
        env = runner_env(self.stream, **{WITNESS_DIR_VAR: self.witness_dir,
                                         WITNESS_STREAM_VAR: self.stream})
        self.result = run_runner(self.project, DISCOVER_ALL, env)

    @property
    def output(self):
        return output_of(self.result)

    def witness(self, name):
        path = self.witness_dir / f"{name}.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
