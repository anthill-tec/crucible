"""A rust gated run outside git takes no gate lock, and says so.

The gate-lock contract (Model B `contracts/gate-lock.md`, "Lock path
derivation") gives a project outside git no lock at all: `_gate_lock_path`
"has NO `/tmp` fallback — it returns `None` and the run proceeds UNLOCKED",
because "a non-git checkout must not silently share a lock with an unrelated
tree". A repository keeps the lock every worktree of it shares: the parent of
the common git directory, joined with `nai-gate.lock`.

  * Outside git, no lock path — for a directory that is not a git repository
    (under a private scratch parent, with `GIT_DIR`, `GIT_COMMON_DIR` and
    `GIT_WORK_TREE` removed, and `git rev-parse --git-common-dir` shown to
    fail there first) `_gate_lock_path` is `None`, for two such directories
    under one parent alike. The older-git fallback that turned the project
    directory itself into the "common directory" — and so put the lock in its
    PARENT — is gone: git is asked once, with `--path-format=absolute`.

  * A repository is unchanged — `git init` and a `git worktree add` linked
    worktree of it resolve the same `<main repo root>/nai-gate.lock`, and the
    function stays self-contained (only `os` and `subprocess`), because Model
    B's derivation-equality gate extracts its body and runs it alone.

  * A run outside git takes no lock and leaves nothing — `workspace-regression`
    driven IN-PROCESS from a non-git project files its run, and afterwards no
    `nai-gate.lock` exists in the project or its parent, `_HELD_GATE_LOCK` is
    `None`, and none of the process's SIGTERM/SIGINT/SIGHUP handlers is
    `_gate_lock_signal`.

  * The unlocked run says so — that run's stderr carries ONE line saying it
    takes no gate lock because no git repository was resolved; a run in a git
    repository carries no such line.

Every directory lives under a private `tempfile.mkdtemp` parent, never `/tmp`
itself, so a lock today's code drops in a project's parent lands somewhere
only this suite owns; nothing here creates or deletes `/tmp/nai-gate.lock`.
The in-process drive talks to a `RecordingBoard` the project's own
`crucible.toml` declares (interlocked, so no drive reaches a live board), with
a stand-in `cargo` on PATH that writes its nextest report and lcov during the
run. Each drive saves and restores the process's three signal handlers, the
module's `_HELD_GATE_LOCK` and its atexit hook, so it leaks nothing.

Invocation:
    python3 -m unittest tests.client.test_a_rust_gated_run_outside_git_takes_no_lock -v
"""

import ast
import atexit
import builtins
import contextlib
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    ENV_KEYS_TO_SCRUB,
    RecordingBoard,
    load_client,
)
from tests.client.test_client_fleet_envelope_census import (
    declare_and_require_board,
)

RUST_CLIENT = CLIENTS / "rust-crucible.py"
GATE_LOCK_FILE = "nai-gate.lock"
PARSED_INGEST = "/api/v2/runs/parsed"
PROJECT_KEY = "rust-gate-lock-outside-git-key"
AGENT = "rust-gate-lock-outside-git-agent"

# The git variables that would point `git -C <dir>` at some other repository
# than the one `<dir>` is (or is not) in: removed for every test here.
_GIT_ENV = ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE")

# Everything else that would let the shell running this suite steer where the
# client looks or how it files.
_SCRUBBED = _GIT_ENV + ENV_KEYS_TO_SCRUB + (
    "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
    "CRUCIBLE_BASE", "AGENT_ID", "RUST_CRUCIBLE_PROJECT_DIR",
    "CARGO_TARGET_DIR", "CARGO_BUILD_JOBS")

_GATE_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)

# What the stand-in `cargo` reports for a nextest run: three passing cases
# over two test binaries, so a filed run with exactly these counts can only
# have read the report the stand-in wrote during THIS run.
_CASES = (("probe-crate::alpha", "adds"), ("probe-crate::alpha", "subtracts"),
          ("probe-crate::beta", "multiplies"))

# The stand-in `cargo`: `clean` and anything without `nextest` is a no-op;
# a run naming `nextest` (here `llvm-cov … nextest`) writes the profile's
# junit under the working directory and, when given `--output-path`, an lcov
# there — the shape `_RECORDING_CARGO` in
# test_rust_regression_coverage_is_opt_in.py has.
_FAKE_CARGO = r'''
import os
import sys

args = sys.argv[1:]
if "nextest" not in args:
    sys.exit(0)
profile = "default"
lcov = None
for i, a in enumerate(args):
    if a == "-P" and i + 1 < len(args):
        profile = args[i + 1]
    if a == "--output-path" and i + 1 < len(args):
        lcov = args[i + 1]
cases = %r
junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
os.makedirs(junit_dir, exist_ok=True)
with open(os.path.join(junit_dir, "junit.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?><testsuites><testsuite name="probe" '
                 'tests="%%d" failures="0">%%s</testsuite></testsuites>'
                 %% (len(cases), "".join(
                     '<testcase name="%%s" classname="%%s" time="0.001">'
                     '</testcase>' %% (n, c) for c, n in cases)))
if lcov:
    target = lcov if os.path.isabs(lcov) else os.path.join(os.getcwd(), lcov)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w") as handle:
        handle.write("SF:src/lib.rs\nFNF:2\nFNH:1\nLF:10\nLH:8\nend_of_record\n")
sys.exit(0)
''' % (_CASES,)

# The recording `git`: appends its argv to `git_launches.jsonl` beside it,
# then becomes the real git, so what `_gate_lock_path` asks git is observable
# whatever subprocess call it is made through.
_RECORDING_GIT = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "git_launches.jsonl"), "a") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\n")
os.execv(%r, [%r] + sys.argv[1:])
'''


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _private_parent(case, prefix):
    """A private scratch parent (never `/tmp` itself), its real path, removed
    when the test ends."""
    parent = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
    case.addCleanup(shutil.rmtree, parent, True)
    return parent


def _git(*args):
    """Run git with no hooks, no signing and a fixed identity; raise on
    failure (a fixture that cannot build its repository is a fixture bug)."""
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
         "-c", "user.name=gate-lock-fixture",
         "-c", "user.email=gate-lock-fixture@example.invalid", *args],
        check=True, capture_output=True, text=True)


def _no_lock_lines(stderr):
    """The stderr lines that say the run takes no gate lock because no git
    repository was resolved — matched by meaning, not by exact prose."""
    return [line for line in (stderr or "").splitlines()
            if "no gate lock" in line.lower() and "git" in line.lower()]


# ── the self-containment checker, proved on synthetic sources first ──────

_ALLOWED_MODULES = frozenset({"os", "subprocess"})
_BUILTINS = frozenset(dir(builtins))


def _function_def(source, name):
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"no top-level `def {name}` in the source")


def _outside_names(source, name, allowed=_ALLOWED_MODULES):
    """Every name `def <name>` reads that it does not bind itself and that is
    neither a builtin nor one of `allowed`, plus every module it imports that
    is not in `allowed` — the names its body could not be run alone without.
    Sorted, so a violation's message is stable."""
    func = _function_def(source, name)
    bound = set()
    args = func.args
    for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs,
                args.vararg, args.kwarg):
        if arg is not None:
            bound.add(arg.arg)
    outside = set()
    for node in ast.walk(func):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            module = getattr(node, "module", None)
            for alias in node.names:
                root = (module or alias.name).split(".")[0]
                if root not in allowed:
                    outside.add(root)
                bound.add((alias.asname or alias.name).split(".")[0])
    for node in ast.walk(func):
        if (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                and node.id not in bound and node.id not in _BUILTINS
                and node.id not in allowed):
            outside.add(node.id)
    return sorted(outside)


_SYNTHETIC_CLEAN = '''
def _gate_lock_path(project_dir):
    try:
        gcd = subprocess.run(["git", "-C", project_dir, "rev-parse",
                              "--path-format=absolute", "--git-common-dir"],
                             capture_output=True, text=True).stdout.strip()
    except Exception as exc:
        del exc
        return None
    return os.path.join(os.path.dirname(gcd), "nai-gate.lock") if gcd else None
'''

_SYNTHETIC_READS_MODULE_GLOBALS = '''
def _gate_lock_path(project_dir):
    gcd = _git_common_dir(project_dir)
    return os.path.join(re.sub("x", "", gcd), LOCK_NAME)
'''

_SYNTHETIC_IMPORTS_ANOTHER_MODULE = '''
def _gate_lock_path(project_dir):
    import shlex
    from pathlib import Path
    return str(Path(project_dir) / shlex.quote("nai-gate.lock"))
'''


class TheSelfContainmentCheckerIsProvedOnSyntheticSourcesTest(unittest.TestCase):
    """The checker AC2's "only `os` and `subprocess`" pin is built from,
    proved both ways on text this test builds — never on today's tree."""

    def test_a_body_using_only_os_subprocess_builtins_and_its_own_locals_is_clean(self):
        self.assertEqual(
            _outside_names(_SYNTHETIC_CLEAN, "_gate_lock_path"), [],
            "a body that reads only os, subprocess, builtins, its parameter "
            "and its own locals needs nothing from outside it")

    def test_a_body_reading_module_globals_and_another_module_is_flagged(self):
        self.assertEqual(
            _outside_names(_SYNTHETIC_READS_MODULE_GLOBALS, "_gate_lock_path"),
            ["LOCK_NAME", "_git_common_dir", "re"],
            "a helper, a module constant and a module other than os and "
            "subprocess are each a name the body cannot run alone without")

    def test_a_body_importing_a_module_other_than_os_or_subprocess_is_flagged(self):
        self.assertEqual(
            _outside_names(_SYNTHETIC_IMPORTS_ANOTHER_MODULE, "_gate_lock_path"),
            ["pathlib", "shlex"],
            "an import of anything but os or subprocess inside the body is "
            "a use of that module")


# ── AC1 / AC2: what `_gate_lock_path` resolves ────────────────────────────


class _GitFreeEnvironment(unittest.TestCase):
    """The client loaded fresh, and the environment stripped of the git
    variables that would redirect `git -C <dir>`, for the whole test."""

    def setUp(self):
        self.module = load_client("rust-crucible.py")
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in _GIT_ENV:
            os.environ.pop(key, None)

    def assert_outside_git(self, directory):
        probe = subprocess.run(["git", "-C", directory, "rev-parse",
                                "--git-common-dir"],
                               capture_output=True, text=True, check=False)
        self.assertNotEqual(
            probe.returncode, 0,
            f"fixture: {directory} must not be inside any git repository for "
            f"this test to measure anything; git said "
            f"stdout={probe.stdout!r} stderr={probe.stderr!r}")


class OutsideGitTheGateLockPathIsNoneTest(_GitFreeEnvironment):
    """AC1 — a directory that is not a git repository has no lock path."""

    def test_a_directory_outside_git_has_no_gate_lock_path(self):
        parent = _private_parent(self, "rust-gate-lock-nongit-")
        project = os.path.join(parent, "project")
        os.mkdir(project)
        self.assert_outside_git(project)
        self.assertIsNone(
            self.module._gate_lock_path(project),
            f"AC1 — outside git there is no lock path: the contract's "
            f"`_gate_lock_path` has no fallback and returns None; a path in "
            f"the project's parent ({os.path.join(parent, GATE_LOCK_FILE)}) "
            f"is a lock shared with every unrelated tree beside it")

    def test_two_directories_outside_git_under_one_parent_both_have_no_gate_lock_path(self):
        parent = _private_parent(self, "rust-gate-lock-nongit-pair-")
        first = os.path.join(parent, "first")
        second = os.path.join(parent, "second")
        os.mkdir(first)
        os.mkdir(second)
        self.assert_outside_git(first)
        self.assert_outside_git(second)
        resolved = (self.module._gate_lock_path(first),
                    self.module._gate_lock_path(second))
        self.assertEqual(
            resolved, (None, None),
            f"AC1 — two non-git directories under one parent both have no "
            f"lock path, so neither shares a lock with the other; "
            f"resolved={resolved!r}")

    def test_outside_git_the_lock_path_asks_git_once_with_path_format_absolute(self):
        """§S1 — the older-git fallback is deleted: `_gate_lock_path` asks
        `git rev-parse --path-format=absolute --git-common-dir` and nothing
        else, so outside git there is no second, plain `--git-common-dir`
        call whose empty answer became the project directory."""
        parent = _private_parent(self, "rust-gate-lock-one-git-call-")
        project = os.path.join(parent, "project")
        os.mkdir(project)
        self.assert_outside_git(project)
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git, "fixture: git must be on PATH")
        bin_dir = os.path.join(parent, "bin")
        os.mkdir(bin_dir)
        _write_script(os.path.join(bin_dir, "git"),
                      _RECORDING_GIT % (real_git, real_git))
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
        resolved = self.module._gate_lock_path(project)
        record = Path(bin_dir, "git_launches.jsonl")
        launches = ([json.loads(line) for line in record.read_text().splitlines()
                     if line.strip()] if record.exists() else [])
        self.assertEqual(
            len(launches), 1,
            f"§S1 — git is asked exactly once; launches={launches!r} "
            f"resolved={resolved!r}")
        self.assertIn("--path-format=absolute", launches[0],
                      f"§S1 — the one call is the absolute-path form; "
                      f"launches={launches!r}")
        self.assertIn("--git-common-dir", launches[0],
                      f"§S1 — the one call asks for the common git dir; "
                      f"launches={launches!r}")
        self.assertIsNone(resolved, f"AC1 — no lock path; resolved={resolved!r}")


class InARepositoryTheGateLockPathIsUnchangedTest(_GitFreeEnvironment):
    """AC2 — a repository, and a linked worktree of it, resolve the parent of
    the common git directory joined with `nai-gate.lock`. Regression pins:
    these hold today and must hold after the change."""

    def test_a_git_init_repository_locks_beside_its_common_git_dir(self):
        parent = _private_parent(self, "rust-gate-lock-repo-")
        repo = os.path.join(parent, "repo")
        _git("init", "-q", repo)
        # `git init` makes `<repo>/.git` the common dir; its parent is `repo`.
        self.assertEqual(
            self.module._gate_lock_path(repo),
            os.path.join(repo, GATE_LOCK_FILE),
            "AC2 — a repository's lock is dirname(<abs common dir>)/"
            "nai-gate.lock, i.e. its root")

    def test_a_linked_worktree_shares_its_main_repositorys_gate_lock(self):
        parent = _private_parent(self, "rust-gate-lock-worktree-")
        repo = os.path.join(parent, "repo")
        linked = os.path.join(parent, "linked")
        _git("init", "-q", repo)
        _git("-C", repo, "commit", "-q", "--allow-empty", "-m", "fixture")
        _git("-C", repo, "worktree", "add", "-q", "--detach", linked)
        main_lock = self.module._gate_lock_path(repo)
        self.assertEqual(
            main_lock, os.path.join(repo, GATE_LOCK_FILE),
            "AC2 — the main repository's lock is at its root")
        self.assertEqual(
            self.module._gate_lock_path(linked), main_lock,
            "AC2 — a linked worktree resolves the SAME lock as its main "
            "repository, so every worktree of one repository shares one lock")

    def test_the_gate_lock_path_body_uses_only_os_and_subprocess(self):
        """AC2 — `_gate_lock_path` stays self-contained, because Model B's
        derivation-equality gate extracts its body and runs it alone; the
        checker is proved on synthetic sources above."""
        source = RUST_CLIENT.read_text()
        self.assertEqual(
            _outside_names(source, "_gate_lock_path"), [],
            "AC2 — `_gate_lock_path` reads nothing but os, subprocess, "
            "builtins and its own locals")


# ── AC3 / AC4: a gated run, driven in-process ─────────────────────────────


class _InProcessGatedRun(unittest.TestCase):
    """A scratch project under a private parent, a `RecordingBoard` its own
    `crucible.toml` declares, a stand-in `cargo` on PATH, and
    `workspace-regression` driven through the client's real `main()` in this
    process with real file descriptors for stdout/stderr (the run hands the
    nextest child the client's own stream).

    Leaks nothing: the process's SIGTERM/SIGINT/SIGHUP handlers are restored,
    the module's held lock is released (removing a lock it created, which can
    only lie inside the private parent) and its atexit hook unregistered, and
    the environment is restored."""

    def setUp(self):
        self.module = load_client("rust-crucible.py")
        saved = {sig: signal.getsignal(sig) for sig in _GATE_SIGNALS}

        def _restore_signals():
            for sig, handler in saved.items():
                signal.signal(sig, handler)
        self.addCleanup(_restore_signals)

        def _release_module_lock():
            self.module._release_gate_lock()
            atexit.unregister(self.module._release_gate_lock)
        self.addCleanup(_release_module_lock)

        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in _SCRUBBED:
            os.environ.pop(key, None)

        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

        self.parent = _private_parent(self, "rust-gate-lock-run-")
        self.project = os.path.join(self.parent, "project")
        os.mkdir(self.project)
        Path(self.project, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        declare_and_require_board(self.project, self.board.url,
                                  "rust-crucible.py")

        self.bin_dir = os.path.realpath(
            tempfile.mkdtemp(prefix="rust-gate-lock-run-bin-"))
        self.addCleanup(shutil.rmtree, self.bin_dir, True)
        _write_script(os.path.join(self.bin_dir, "cargo"), _FAKE_CARGO)
        os.environ["PATH"] = self.bin_dir + os.pathsep + os.environ.get("PATH", "")

    def drive_workspace_regression(self):
        """`workspace-regression` through `main()`; returns
        `(exit, stdout, stderr)`. Only SystemExit is caught."""
        argv = ["rust-crucible.py", "workspace-regression", "--agent", AGENT,
                "--project-dir", self.project, "--min-free-g", "0"]
        out_path = os.path.join(self.bin_dir, "drive-stdout.txt")
        err_path = os.path.join(self.bin_dir, "drive-stderr.txt")
        with open(out_path, "w") as out, open(err_path, "w") as err:
            with mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                try:
                    rc = self.module.main()
                    code = rc if isinstance(rc, int) else 0
                except SystemExit as exc:
                    code = (exc.code if isinstance(exc.code, int)
                            else (0 if exc.code is None else 1))
        return code, Path(out_path).read_text(), Path(err_path).read_text()

    def assert_the_run_filed(self, code, stdout, stderr):
        ingests = [(p, b) for p, b in self.board.posts() if p == PARSED_INGEST]
        diagnostics = (f"exit={code} posts={[p for p, _ in self.board.posts()]!r} "
                       f"stdout={stdout[-1500:]!r} stderr={stderr[-2500:]!r}")
        self.assertEqual(len(ingests), 1,
                         f"exactly one ingest to {PARSED_INGEST}; {diagnostics}")
        body = ingests[0][1] if isinstance(ingests[0][1], dict) else {}
        self.assertEqual(body.get("agentId"), AGENT,
                         f"the ingest is this run's own; body={body!r}")
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("total"), summary.get("passed"), summary.get("failed")),
            (len(_CASES), len(_CASES), 0),
            f"the filed run carries the report the stand-in cargo wrote during "
            f"the run; summary={summary!r}")
        self.assertEqual(code, 0, f"an all-green run exits 0; {diagnostics}")


class ARustGatedRunOutsideGitTakesNoLockTest(_InProcessGatedRun):
    """AC3 and AC4 — the run from a non-git project."""

    def setUp(self):
        super().setUp()
        probe = subprocess.run(["git", "-C", self.project, "rev-parse",
                                "--git-common-dir"],
                               capture_output=True, text=True, check=False)
        self.assertNotEqual(
            probe.returncode, 0,
            f"fixture: {self.project} must not be inside any git repository; "
            f"git said stdout={probe.stdout!r} stderr={probe.stderr!r}")

    def test_a_workspace_regression_outside_git_files_its_run_and_leaves_no_lock_behind(self):
        code, stdout, stderr = self.drive_workspace_regression()
        self.assert_the_run_filed(code, stdout, stderr)
        left = [path for path in (os.path.join(self.project, GATE_LOCK_FILE),
                                  os.path.join(self.parent, GATE_LOCK_FILE))
                if os.path.exists(path)]
        self.assertEqual(
            left, [],
            f"AC3 — a run outside git takes no lock: no {GATE_LOCK_FILE} in "
            f"the project or its parent; found {left!r}")
        self.assertIsNone(
            self.module._HELD_GATE_LOCK,
            f"AC3 — the process holds no gate lock after a run outside git; "
            f"_HELD_GATE_LOCK={self.module._HELD_GATE_LOCK!r}")
        installed = [signal.Signals(sig).name for sig in _GATE_SIGNALS
                     if signal.getsignal(sig) is self.module._gate_lock_signal]
        self.assertEqual(
            installed, [],
            f"AC3 — a run outside git installs no gate-lock signal handler "
            f"in the process; _gate_lock_signal is the handler for "
            f"{installed!r}")

    def test_a_workspace_regression_outside_git_says_once_on_stderr_it_takes_no_gate_lock(self):
        code, stdout, stderr = self.drive_workspace_regression()
        self.assert_the_run_filed(code, stdout, stderr)
        lines = _no_lock_lines(stderr)
        self.assertEqual(
            len(lines), 1,
            f"AC4 — the unlocked run says so in ONE stderr line: it takes no "
            f"gate lock because no git repository was resolved; "
            f"matching={lines!r} stderr={stderr[-2500:]!r}")
        self.assertNotIn(
            "gate lock created", stderr,
            f"AC3/AC4 — a run outside git creates no gate lock; "
            f"stderr={stderr[-2500:]!r}")


class ARustGatedRunInARepositoryStillLocksSilentlyTest(_InProcessGatedRun):
    """AC4's other half — a run in a git repository takes its lock and carries
    no "no gate lock" line. A regression pin: it holds today."""

    def setUp(self):
        super().setUp()
        _git("init", "-q", self.project)

    def test_a_workspace_regression_in_a_git_repository_carries_no_unlocked_line(self):
        code, stdout, stderr = self.drive_workspace_regression()
        self.assert_the_run_filed(code, stdout, stderr)
        self.assertEqual(
            self.module._HELD_GATE_LOCK,
            os.path.join(self.project, GATE_LOCK_FILE),
            f"a run in a repository still takes its lock at the repository "
            f"root; stderr={stderr[-2500:]!r}")
        self.assertEqual(
            _no_lock_lines(stderr), [],
            f"AC4 — a run in a git repository carries no 'no gate lock' line; "
            f"stderr={stderr[-2500:]!r}")


if __name__ == "__main__":
    unittest.main()
