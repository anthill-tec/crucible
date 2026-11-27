"""Shared fixtures for the tests that drive the eda client on a REAL eda project.

The project is a scratch copy of the committed `tests/fixtures/eda-project`
(its own `pytest.ini` names its test files `check_*.py`, which this repo's own
discovery never collects), never the checkout's copy. Its `crucible.toml`
declares three eda entries (`unit` over `tests/unit`, `integration/net` over
`tests/integ`, `e2e` over `tests/bench`); its `hardware/` sub-project declares
its own. The committed tree names no board and holds no `.env`: each scratch
copy is pointed at a `RecordingBoard` on loopback and given the `.env` its
case needs, so no live board is ever touched and no project key is committed.

The client is `clients/eda-crucible.py`, spawned from the suite's test install
(`tests.client.client_script`) as an OS subprocess, in an environment scrubbed
of every variable that would steer its project, its interpreter or its pytest.
The interpreter it is handed is never this suite's own `sys.executable`:

* a RECORDING interpreter is an executable script (`#!<suite python>`) that
  appends one JSON line per invocation to its own log -- the argv it was
  spawned with (its first element is the path the client spawned), its
  working directory, and whether `QT_QPA_PLATFORM`, `DISPLAY` and
  `WAYLAND_DISPLAY` are set and to what -- then hands the call to the suite's
  interpreter, which has pytest. Built with `answer_probe=1`, it answers the
  import probe (`-c "import pytest"`) with exit 1 instead, so the client takes
  it for an interpreter without pytest and refuses before any run;
* a PYTEST-LESS interpreter is a scratch venv built `--without-pip`.

Not a test module: it holds no `TestCase`.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from tests.client import client_script
from tests.client.client_fleet_envelope_census_helpers import declare_board
from tests.client.live_run_harness import (
    REPO_ROOT,
    RecordingBoard,
    load_toon,
    scrubbed_env,
)

TOON = load_toon()
EDA_CLIENT = client_script("eda-crucible.py")
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "eda-project"
AGENT = "eda-project-fixture-agent"
PROJECT_KEY = "eda-project-fixture-key"
FRAMEWORK = "eda-pytest"
TIMEOUT = 120
VENV_BUILD_TIMEOUT = 120
PROBE_ARGV = ["-c", "import pytest"]
#: The client's own steering variables: its interpreter and its project dir.
PYTHON_VAR = "EDA_CRUCIBLE_PYTHON"
PROJECT_DIR_VAR = "EDA_CRUCIBLE_PROJECT_DIR"
#: The shared refusal codes the human error line on stderr carries.
DECLARATION_REFUSED_CODE = "declaration-refused"
TIER_RUN_UNDECLARED_CODE = "tier-run-undeclared"
#: The headless variables a pytest child's environment is checked for.
WATCHED_ENV = ("QT_QPA_PLATFORM", "DISPLAY", "WAYLAND_DISPLAY")

# Every variable that, inherited from the shell running this suite, would
# steer the client or its children away from what a test states.
_SCRUBBED = (PYTHON_VAR, PROJECT_DIR_VAR, "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
             "CRUCIBLE_AGENT_ID", "PYTEST_ADDOPTS", "PYTEST_PLUGINS",
             "GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES",
             *WATCHED_ENV)

_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

ANSWER_PROBE = {answer_probe!r}
with open({log!r}, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({{
        "argv": sys.argv,
        "cwd": os.getcwd(),
        "env": {{name: os.environ.get(name) for name in {watched!r}}},
        "set": {{name: name in os.environ for name in {watched!r}}},
    }}) + "\\n")
if ANSWER_PROBE is not None and sys.argv[1:] == {probe!r}:
    sys.exit(ANSWER_PROBE)
os.execv({real!r}, [{real!r}, *sys.argv[1:]])
'''


def real_dir(path):
    """`path` with every symlink resolved, so the paths a test states are the
    ones a client that resolves its own (`git`, `os.getcwd`) reports."""
    return os.path.realpath(path)


def scratch(case, prefix):
    """A fresh real temp dir removed when `case` (a TestCase or its class)
    finishes."""
    path = real_dir(tempfile.mkdtemp(prefix=prefix))
    cleanup = case.addClassCleanup if isinstance(case, type) else case.addCleanup
    cleanup(shutil.rmtree, path, ignore_errors=True)
    return path


class RecordingInterpreter:
    """A recording interpreter at `path` writing to its own log."""

    def __init__(self, path, answer_probe=None):
        self.path = str(path)
        self.log = f"{self.path}.calls.jsonl"
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.path).write_text(_RECORDING_INTERPRETER.format(
            real=sys.executable, log=self.log, watched=WATCHED_ENV,
            answer_probe=answer_probe, probe=PROBE_ARGV), encoding="utf-8")
        os.chmod(self.path, 0o700)

    def calls(self):
        """Every recorded invocation, in order."""
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def probe_calls(self):
        return [c for c in self.calls() if c["argv"][1:] == PROBE_ARGV]

    def pytest_calls(self):
        return [c for c in self.calls() if is_pytest_argv(c["argv"])]

    def spawned_as(self, call):
        """The interpreter path a recorded call was spawned as, resolved
        against the call's working directory."""
        return real_dir(os.path.join(call["cwd"], call["argv"][0]))


def is_pytest_argv(argv):
    """Whether `argv` runs pytest (`<python> -m pytest …`)."""
    return any(argv[i:i + 2] == ["-m", "pytest"] for i in range(len(argv)))


def pytestless_python(case):
    """The interpreter of a scratch venv built `--without-pip`, which provably
    cannot import pytest; removed when `case` finishes."""
    root = scratch(case, "eda-bare-venv-")
    venv_dir = os.path.join(root, "venv")
    built = subprocess.run([sys.executable, "-m", "venv", "--without-pip", venv_dir],
                           capture_output=True, text=True,
                           timeout=VENV_BUILD_TIMEOUT, check=False)
    if built.returncode != 0:
        raise RuntimeError(f"could not build the pytest-less venv: {built.stderr[-1500:]!r}")
    python = os.path.join(venv_dir, "bin", "python")
    found = subprocess.run([python, "-c", "import pytest"], capture_output=True,
                           text=True, timeout=VENV_BUILD_TIMEOUT, check=False)
    if found.returncode == 0:
        raise RuntimeError(f"fixture broken: {python} imports pytest")
    return python


def raised_limits_table():
    """The `crucible.toml` lines a scratch project adds beside its board: a
    raised display limit, so a refusal naming a long scratch path is not cut
    before the words under test."""
    return "\n[limits.truncate_field_chars]\nvalue = 4000\n"


class EdaProject:
    """One scratch copy of the fixture (`self.dir`) on its own
    `RecordingBoard`. With `key`, `.env` carries the project key."""

    def __init__(self, case, key=True, board=None):
        self.case = case
        self.root = scratch(case, "eda-project-")
        self.dir = os.path.join(self.root, "project")
        shutil.copytree(FIXTURE, self.dir,
                        ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
        if board is None:
            board = RecordingBoard()
            case.addCleanup(board.close)
        self.board = board
        self.point_at_board(self.dir)
        if key:
            self.write_key(self.dir)

    # ── the project's files ────────────────────────────────────────────────
    @property
    def toml(self):
        return os.path.join(self.dir, "crucible.toml")

    def path(self, rel):
        return os.path.join(self.dir, rel)

    def point_at_board(self, project_dir):
        """Name this project's board, and raise its display limit, in
        `project_dir`'s own `crucible.toml` (created when absent)."""
        config = Path(project_dir, "crucible.toml")
        declare_board(config, self.board.url)
        with open(config, "a", encoding="utf-8") as handle:
            handle.write(raised_limits_table())

    def write_key(self, project_dir, key=PROJECT_KEY):
        Path(project_dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={key}\n",
                                             encoding="utf-8")

    def declare(self, text, project_dir=None):
        """Append `text` (TOML tables) to `project_dir`'s `crucible.toml`."""
        with open(os.path.join(project_dir or self.dir, "crucible.toml"), "a",
                  encoding="utf-8") as handle:
            handle.write("\n" + text.strip("\n") + "\n")

    def declare_only_the_board(self, project_dir=None):
        """Replace `project_dir`'s `crucible.toml` with one that names the
        board and declares no entry at all."""
        project_dir = project_dir or self.dir
        os.remove(os.path.join(project_dir, "crucible.toml"))
        self.point_at_board(project_dir)

    # ── the drive ──────────────────────────────────────────────────────────
    def env(self, **extra):
        env = scrubbed_env()
        for name in _SCRUBBED:
            env.pop(name, None)
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def drive(self, verb, *argv, cwd=None, project_dir=None, python=None,
              agent=AGENT, client=None, env=None, timeout=TIMEOUT):
        """Spawn the eda client's `verb` with `argv`. `project_dir` defaults
        to this copy (False: no `--project-dir` at all); `python`, when
        given, is passed as `--python`."""
        cmd = [sys.executable, str(client or EDA_CLIENT), verb, *argv]
        if agent:
            cmd += ["--agent", agent]
        if project_dir is not False:
            cmd += ["--project-dir", project_dir or self.dir]
        if python is not None:
            cmd += ["--python", str(python)]
        return subprocess.run(cmd, cwd=cwd or self.dir,
                              env=env if env is not None else self.env(),
                              capture_output=True, text=True, timeout=timeout,
                              check=False)

    # ── what the board was sent ────────────────────────────────────────────
    def posts(self):
        return self.board.posts()

    def run_route_posts(self):
        """Every POST that opens, streams or files a run."""
        return [p for p, _b in self.posts() if p.startswith("/api/v2/runs")]


def envelope(stdout):
    """The `axi` block of the client's one TOON envelope, or None."""
    try:
        decoded = TOON.decode(stdout or "")
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def said(axi):
    """Everything an envelope says in words: its error, help and warnings."""
    axi = axi or {}
    help_steps = axi.get("help") or []
    if isinstance(help_steps, str):
        help_steps = [help_steps]
    warnings = [json.dumps(w) if not isinstance(w, str) else w
                for w in (axi.get("warnings") or [])]
    return " ".join([str(axi.get("error") or "")] + [str(s) for s in help_steps]
                    + warnings)


def diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-2000:]!r} "
            f"stderr={result.stderr[-2000:]!r}")
