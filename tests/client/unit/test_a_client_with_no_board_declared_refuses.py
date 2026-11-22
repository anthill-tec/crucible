"""A client with no board declared refuses before it contacts a board or runs
anything.

A client reads its board from `[client] url`: the bound project's
`crucible.toml`, then the install's. The first file that declares a non-empty
`url` wins and a file without one is passed over. When NO file in that chain
declares one, there is no last resort any more: the client refuses. The
refusal is a typed hard stop (a direct `Exception` subclass, never an
`OSError` or a `ValueError`), converted into ONE `ok: false` envelope with a
non-zero exit. Its error names every file of the chain in precedence order,
home-abbreviated, each with why it was passed over (absent, no `[client] url`,
does not parse). Its `help` names the two fixes: re-run the installer, or
declare `[client] url` in the project's `crucible.toml`. No request is sent.

The board is resolved at FIRST USE and refused at FIRST CONTACT, so the
pre-flight a run makes before it spawns anything is that first contact: a
`lint --agent` or `pre-merge-gate --agent` with no board refuses before a
linter, a runner or a compile is spawned, and the gate records no outcome.

What this module also holds: the chain still resolves when a file DOES declare
a board (a project-declared board counts for `project-create`, which binds its
project dir first), the shipped data declares no board and the core offers no
shipped board, and no client code or string literal spells the server's
packaged port.

── Tier ──────────────────────────────────────────────────────────────────────

UNIT, every class. Each client is loaded IN PROCESS from the checkout and its
shared module's `_INSTALL_DIR` is patched to a scratch directory this module
owns, so the operator's own root `crucible.toml` is never read. The transport
is a recording fake of `urllib.request.urlopen` (no socket) and every spawn
goes through a recording fake of `subprocess.Popen` (no process). Nothing here
binds a port, opens a socket or starts a process.
"""

import argparse
import ast
import contextlib
import importlib.util
import io
import itertools
import os
import re
import shutil
import sys
import tempfile
import tomllib
import unittest
import urllib.error
from pathlib import Path
from unittest import mock
from tests.client import CLIENT_SOURCE_DIR, TEST_INSTALL_CLIENTS

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
AXI_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"
SHIPPED_CONFIG = CLIENT_SOURCE_DIR / "crucible.toml"
CONFIG_NAME = "crucible.toml"

CLIENT_FILES = {
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "go": CLIENTS_DIR / "go-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
}

#: The key a board is declared under, exactly as an operator writes it.
CLIENT_URL_KEY = "[client] url"

#: The server's packaged port. No client may spell it: a client that knows
#: it is a client that can fall back to it.
PACKAGED_PORT = "3849"

PROJECT_KEY = "6f1c3a52-0d0e-4c41-9a51-1f2b3c4d5e6f"
AGENT = "no-board-agent"

#: In-process addresses only. The recording transport answers every request,
#: so nothing is ever sent to them; none is in the 3800-3899 window.
PROJECT_BOARD = "http://127.0.0.1:47302"
INSTALL_BOARD = "http://127.0.0.1:47303"

#: The file shapes the chain passes over.
GATE_ONLY = '[gate]\nskip = ["pr"]\n'
NO_URL_TABLE = '[client]\nnote = "this file names no board"\n'
EMPTY_URL = '[client]\nurl = ""\n'
UNPARSEABLE = f'[client\nurl = "{PROJECT_BOARD}"\n'

#: Why a file was passed over, as the refusal must say it.
ABSENT = "absent"
NO_URL = "no url"
DOES_NOT_PARSE = "does not parse"
REASON_PATTERNS = {
    ABSENT: re.compile(r"\babsent\b", re.IGNORECASE),
    NO_URL: re.compile(r"\bno\s+`?(?:\[client\]\s*)?url\b", re.IGNORECASE),
    DOES_NOT_PARSE: re.compile(r"\bdoes\s+not\s+parse\b", re.IGNORECASE),
}

#: The help the shared dispatch gives an `OSError`/`ValueError` that escaped a
#: verb. The no-board refusal carries its own help, so seeing this one means
#: the refusal was one of those two types.
ESCAPED_FAILURE_HELP = "fix the cause this error names, then re-run the verb"

#: Environment a drive must not inherit from the session that launched it.
SCRUBBED_ENV = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                "WORKFLOW_CYCLE", "CRUCIBLE_URL", "CRUCIBLE_BASE",
                "PY_CRUCIBLE_PYTHON", "BUN_CRUCIBLE_PACKAGE_DIR",
                "GO_CRUCIBLE_MODULE_DIR", "AGENT_ID", "CRUCIBLE_STREAM")

_LOADS = itertools.count()


def _load_module(path, label):
    spec = importlib.util.spec_from_file_location(
        f"no_board_{label}_{next(_LOADS)}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_TOON = None


def _toon():
    global _TOON
    if _TOON is None:
        _TOON = _load_module(TOON_PATH, "toon")
    return _TOON


def shown(path):
    """`path` as an operator reads it in a message: home-abbreviated."""
    path = str(path)
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


class RecordingTransport:
    """A fake `urllib.request.urlopen`: records `(method, url)` and answers
    nothing, the way an unreachable board does. No socket is opened."""

    def __init__(self):
        self.requests = []

    def __call__(self, request, *args, **kwargs):
        self.requests.append((request.get_method(), request.full_url))
        raise urllib.error.URLError("the recording transport answers nothing")


class RecordingSpawns:
    """A fake `subprocess.Popen`: records the argv of every spawn and starts
    nothing, failing as a missing executable would."""

    def __init__(self):
        self.argvs = []

    def __call__(self, args, *rest, **kwargs):
        argv = [args] if isinstance(args, (str, bytes, os.PathLike)) else list(args)
        self.argvs.append([str(a) for a in argv])
        raise FileNotFoundError(2, "the recording spawn seam starts nothing",
                                str(argv[0]) if argv else "")

    def work(self):
        """Every spawn that is not git: the shared run context asks git for
        the branch and commit, and that is not the work a verb runs."""
        return [argv for argv in self.argvs
                if argv and os.path.basename(argv[0]) != "git"]


class Drive:
    """One in-process `main()` of a client: what it printed and returned,
    anything that escaped it, and what the two recording seams saw."""

    def __init__(self, client, argv):
        self.client = client
        self.argv = argv
        self.code: int | None = None
        self.out = ""
        self.err = ""
        self.escaped: BaseException | None = None
        self.transport = RecordingTransport()
        self.spawns = RecordingSpawns()

    @property
    def envelope_count(self):
        return sum(1 for line in self.out.splitlines() if line == "axi:")

    def axi(self):
        decoded = _toon().decode(self.out)
        return decoded.get("axi") if isinstance(decoded, dict) else None

    def summary(self):
        return (f"{self.client} {' '.join(self.argv)}: exit={self.code!r} "
                f"escaped={self.escaped!r} requests={self.transport.requests!r} "
                f"spawns={self.spawns.argvs!r} stdout={self.out[-1500:]!r} "
                f"stderr={self.err[-800:]!r}")


def run_client(client, argv, install_dir):
    """Load `client` fresh from the checkout and run its `main()` with
    `argv`, its shared module's install dir patched to `install_dir`, the
    transport and the spawn seam recorded, stdout and stderr captured."""
    drive = Drive(client, argv)
    module = _load_module(CLIENT_FILES[client], client)
    axi = module._axi()
    out, err = io.StringIO(), io.StringIO()
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ))
        for name in SCRUBBED_ENV:
            os.environ.pop(name, None)
        stack.enter_context(mock.patch.object(axi, "_INSTALL_DIR", str(install_dir)))
        stack.enter_context(mock.patch("urllib.request.urlopen", drive.transport))
        stack.enter_context(mock.patch("subprocess.Popen", drive.spawns))
        stack.enter_context(mock.patch.object(
            sys, "argv", [str(CLIENT_FILES[client])] + list(argv)))
        stack.enter_context(contextlib.redirect_stdout(out))
        stack.enter_context(contextlib.redirect_stderr(err))
        try:
            module.main()
            drive.code = 0
        except SystemExit as exit_:
            drive.code = (0 if exit_.code is None else
                          exit_.code if isinstance(exit_.code, int) else 1)
        except Exception as exc:  # noqa: BLE001 -- an escape is the finding
            drive.escaped = exc
        finally:
            axi.bind_project_dir(None)
    drive.out, drive.err = out.getvalue(), err.getvalue()
    return drive


def raised_by(test, resolve):
    """The exception `resolve()` raises; fails `test` when it answers. An
    assertion of the test's own is never mistaken for the refusal."""
    try:
        answered = resolve()
    except AssertionError:
        raise
    except Exception as exc:  # noqa: BLE001 -- the refusal's type is GREEN's to name
        return exc
    test.fail(f"with no board declared nothing may be answered; got {answered!r}")


def write_env(project_dir):
    (Path(project_dir) / ".env").write_text(
        f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n"
        "CRUCIBLE_PROJECT_NAME=no-board-fixture\n", encoding="utf-8")


class _ScratchDirsCase(unittest.TestCase):
    """A temp project dir holding a `.env`, and a temp install dir, both
    removed after the test."""

    def setUp(self):
        self.project_dir = Path(tempfile.mkdtemp(prefix="no-board-project-"))
        self.addCleanup(shutil.rmtree, self.project_dir, True)
        self.install_dir = Path(tempfile.mkdtemp(prefix="no-board-install-"))
        self.addCleanup(shutil.rmtree, self.install_dir, True)
        write_env(self.project_dir)
        self.project_config = self.project_dir / CONFIG_NAME
        self.install_config = self.install_dir / CONFIG_NAME

    def assert_board_refusal(self, drive, chain):
        """`drive` refused for want of a board: non-zero, nothing escaped,
        exactly one `ok: false` envelope, no request sent; the error names
        each `(path, reason)` of `chain` once, in that order, each with its
        reason; the help names the installer and the key; and it is not the
        conversion an `OSError`/`ValueError` gets."""
        self.assertIsNone(drive.escaped, f"nothing may escape main(): {drive.summary()}")
        self.assertNotEqual(drive.code, 0, f"the refusal exits non-zero: {drive.summary()}")
        self.assertEqual(drive.transport.requests, [],
                         f"no request may be sent with no board declared: {drive.summary()}")
        self.assertEqual(drive.envelope_count, 1,
                         f"exactly one envelope: {drive.summary()}")
        axi = drive.axi()
        self.assertIsInstance(axi, dict, drive.summary())
        self.assertIs(axi.get("ok"), False, drive.summary())
        error = str(axi.get("error") or "")
        help_text = " ".join(str(step) for step in (axi.get("help") or []))
        self.assert_names_the_chain(error, chain)
        self.assertNotIn(ESCAPED_FAILURE_HELP, help_text,
                         f"the refusal is not an OSError/ValueError escape: {drive.summary()}")
        self.assertIsNone(re.match(r"(OSError|ValueError|RuntimeError|\w*Error):", error),
                          f"the error is the refusal's own text, not an exception's: {error!r}")
        self.assert_names_both_fixes(help_text)

    def assert_names_the_chain(self, error, chain):
        positions = []
        for path, _reason in chain:
            text = shown(path)
            self.assertEqual(error.count(text), 1,
                             f"the error names {text} exactly once: {error!r}")
            positions.append(error.index(text))
        self.assertEqual(positions, sorted(positions),
                         f"the files are named in precedence order {[shown(p) for p, _ in chain]}: "
                         f"{error!r}")
        for index, (path, reason) in enumerate(chain):
            start = positions[index] + len(shown(path))
            end = positions[index + 1] if index + 1 < len(chain) else len(error)
            segment = error[start:end]
            self.assertRegex(segment, REASON_PATTERNS[reason],
                             f"{shown(path)} is said to be passed over as {reason!r}: {error!r}")
            if index + 1 < len(chain):
                for other, pattern in REASON_PATTERNS.items():
                    if other != reason:
                        self.assertNotRegex(
                            segment, pattern,
                            f"{shown(path)} is passed over as {reason!r}, not "
                            f"{other!r}: {error!r}")

    def assert_names_both_fixes(self, help_text):
        self.assertRegex(help_text, re.compile(r"installer|crucible-axi install", re.IGNORECASE),
                         f"the help names re-running the installer: {help_text!r}")
        self.assertIn(CLIENT_URL_KEY, help_text,
                      f"the help names declaring `{CLIENT_URL_KEY}`: {help_text!r}")


class AStatusWithNoBoardDeclaredRefusesBeforeAnyRequestTest(_ScratchDirsCase):
    """Every client's `status`, in process, with no file of the chain
    declaring a board."""

    def status(self, client, install_dir=None):
        return run_client(client, ["status", "--project-dir", str(self.project_dir)],
                          install_dir or self.install_dir)

    def test_every_client_names_an_unparseable_project_file_then_an_install_naming_no_board(self):
        """A file that does not parse and an install naming no board leave
        no board: the refusal names both, and no request is sent."""
        self.project_config.write_text(UNPARSEABLE, encoding="utf-8")
        self.install_config.write_text(GATE_ONLY, encoding="utf-8")
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                self.assert_board_refusal(
                    self.status(client),
                    [(self.project_config, DOES_NOT_PARSE), (self.install_config, NO_URL)])

    def test_every_client_names_an_absent_project_file_then_an_install_whose_client_table_has_no_url(self):
        """An absent project file and a `[client]` table with no url leave no
        board: the refusal names both, and no request is sent."""
        self.install_config.write_text(NO_URL_TABLE, encoding="utf-8")
        self.assertFalse(self.project_config.exists())
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                self.assert_board_refusal(
                    self.status(client),
                    [(self.project_config, ABSENT), (self.install_config, NO_URL)])

    def test_every_client_names_a_project_file_naming_no_board_then_an_absent_install_file(self):
        """A project file naming no board and an absent install file leave no
        board: the refusal names both, and no request is sent."""
        self.project_config.write_text(GATE_ONLY, encoding="utf-8")
        self.assertFalse(self.install_config.exists())
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                self.assert_board_refusal(
                    self.status(client),
                    [(self.project_config, NO_URL), (self.install_config, ABSENT)])

    def test_a_client_run_inside_its_own_install_names_the_one_file_once(self):
        """The project dir IS the install dir, so the chain is one file, and
        the refusal names it once."""
        self.project_config.write_text(GATE_ONLY, encoding="utf-8")
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                self.assert_board_refusal(
                    self.status(client, install_dir=self.project_dir),
                    [(self.project_config, NO_URL)])


class TheCoreRefusesWithNoProjectBoundTest(_ScratchDirsCase):
    """The shared resolver itself, with no project dir bound: the chain is the
    install's file alone."""

    def setUp(self):
        super().setUp()
        self.axi = _load_module(AXI_PATH, "core")
        self.axi.bind_project_dir(None)
        patch = mock.patch.object(self.axi, "_INSTALL_DIR", str(self.install_dir))
        patch.start()
        self.addCleanup(patch.stop)

    def refusal(self):
        return raised_by(self, self.axi.resolve_base_url)

    def test_the_refusal_names_only_the_absent_install_file(self):
        """With no project bound, the chain is the install's file alone."""
        exc = self.refusal()
        message = str(exc)
        self.assertIn(shown(self.install_config), message)
        self.assertRegex(message, REASON_PATTERNS[ABSENT])
        self.assertNotIn(shown(self.project_config), message,
                         "no project is bound, so no project file is in the chain")

    def test_the_refusal_is_a_direct_exception_subclass_never_an_os_or_value_error(self):
        """The refusal is never an `OSError` or a `ValueError`: those are what
        the courtesy catches and the generic conversion swallow."""
        self.install_config.write_text(EMPTY_URL, encoding="utf-8")
        exc = self.refusal()
        self.assertNotIsInstance(exc, (OSError, ValueError))
        self.assertEqual(type(exc).__bases__, (Exception,),
                         f"{type(exc).__name__} must subclass Exception directly")

    def test_run_verb_turns_the_refusal_into_one_failed_envelope_naming_both_fixes(self):
        """`run_verb` converts the refusal into one `ok: false` envelope that
        carries the refusal's own help, never the escaped-failure help."""
        self.install_config.write_text(NO_URL_TABLE, encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.axi.run_verb(lambda _args: self.axi.resolve_base_url(),
                                     argparse.Namespace(cmd="status", project_dir=None))
        stdout = out.getvalue()
        self.assertIsInstance(code, int, f"run_verb answers an exit code; got {code!r}")
        self.assertNotEqual(code, 0)
        self.assertEqual(sum(1 for line in stdout.splitlines() if line == "axi:"), 1,
                         f"one envelope: {stdout!r}")
        axi = _toon().decode(stdout)["axi"]
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("verb"), "status")
        help_text = " ".join(str(step) for step in axi.get("help") or [])
        self.assertNotIn(ESCAPED_FAILURE_HELP, help_text)
        self.assert_names_both_fixes(help_text)
        self.assert_names_the_chain(str(axi.get("error")), [(self.install_config, NO_URL)])

    def test_the_envelope_context_omits_the_board_and_does_not_raise(self):
        """A pin: building the context of the refusal's own envelope must not
        raise, and with no board declared it names none."""
        context = self.axi.axi_context(PROJECT_KEY, agent_id=AGENT)
        self.assertNotIn("board", context)
        self.assertEqual(context.get("projectKey"), PROJECT_KEY)
        self.assertEqual(context.get("agentId"), AGENT)

    def test_a_project_declared_board_is_named_when_the_install_declares_none(self):
        """With no install url there is nothing for a project's board to be
        the machine's own, so it is always named."""
        shipped = tomllib.loads(SHIPPED_CONFIG.read_text(encoding="utf-8")).get("client", {})
        declared = (shipped.get("url") if isinstance(shipped, dict) else None) or PROJECT_BOARD
        self.project_config.write_text(f'[client]\nurl = "{declared}"\n', encoding="utf-8")
        self.axi.bind_project_dir(str(self.project_dir))
        try:
            context = self.axi.axi_context(PROJECT_KEY)
        finally:
            self.axi.bind_project_dir(None)
        self.assertEqual(context.get("board"), declared,
                         f"the project's board is named when the install declares none: {context!r}")


class TheChainStillResolvesADeclaredBoardTest(_ScratchDirsCase):
    """A declared board still resolves, and only a declared one."""

    def setUp(self):
        super().setUp()
        self.axi = _load_module(AXI_PATH, "chain")
        patch = mock.patch.object(self.axi, "_INSTALL_DIR", str(self.install_dir))
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.axi.bind_project_dir, None)

    def resolve(self):
        self.axi.bind_project_dir(str(self.project_dir))
        return self.axi.resolve_base_url()

    def test_the_projects_url_wins_over_the_installs(self):
        """A pin."""
        self.install_config.write_text(f'[client]\nurl = "{INSTALL_BOARD}"\n', encoding="utf-8")
        self.project_config.write_text(f'[client]\nurl = "{PROJECT_BOARD}"\n', encoding="utf-8")
        self.assertEqual(self.resolve(), PROJECT_BOARD)

    def test_the_installs_url_is_used_when_the_project_declares_none(self):
        """A pin."""
        self.install_config.write_text(f'[client]\nurl = "{INSTALL_BOARD}"\n', encoding="utf-8")
        self.project_config.write_text(GATE_ONLY, encoding="utf-8")
        self.assertEqual(self.resolve(), INSTALL_BOARD)

    def test_an_unparseable_or_empty_url_project_file_is_passed_over_for_the_installs(self):
        """A pin."""
        self.install_config.write_text(f'[client]\nurl = "{INSTALL_BOARD}"\n', encoding="utf-8")
        for text in (UNPARSEABLE, EMPTY_URL):
            with self.subTest(project_file=text):
                self.project_config.write_text(text, encoding="utf-8")
                self.assertEqual(self.resolve(), INSTALL_BOARD)

    def test_an_empty_install_url_under_a_project_naming_none_refuses(self):
        """An empty install url declares no board, so with a project naming
        none the resolver refuses."""
        self.install_config.write_text(EMPTY_URL, encoding="utf-8")
        self.project_config.write_text(GATE_ONLY, encoding="utf-8")
        exc = raised_by(self, self.resolve)
        self.assertNotIsInstance(exc, (OSError, ValueError))
        self.assertIn(shown(self.install_config), str(exc))


class ProjectCreateResolvesTheProjectsOwnBoardTest(_ScratchDirsCase):
    """`project-create` binds its project dir before it resolves the board, so
    the project's declaration counts even when the install declares none."""

    def test_every_client_sends_project_create_to_the_board_the_project_declares(self):
        """A pin: today each request resolves the board after the bind. A
        board resolved when the ops are built, before the bind, would refuse
        here or post elsewhere."""
        self.project_config.write_text(f'[client]\nurl = "{PROJECT_BOARD}"\n', encoding="utf-8")
        self.install_config.write_text(GATE_ONLY, encoding="utf-8")
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(
                    client,
                    ["project-create", "--project-dir", str(self.project_dir),
                     "--name", "No Board Fixture", "--token=no-board-fixture",
                     "--agent", AGENT],
                    self.install_dir)
                self.assertIsNone(drive.escaped, drive.summary())
                self.assertNotEqual(drive.transport.requests, [],
                                    f"project-create asks the board: {drive.summary()}")
                elsewhere = [url for _method, url in drive.transport.requests
                             if not url.startswith(PROJECT_BOARD + "/")]
                self.assertEqual(elsewhere, [],
                                 f"every request goes to the project's board: {drive.summary()}")
                self.assertEqual(drive.envelope_count, 1, drive.summary())


class NoShippedBoardRemainsTest(unittest.TestCase):
    """The distribution declares no board and spells no packaged port."""

    def test_the_shipped_configuration_declares_no_client_url(self):
        """The shipped data names no board: the installer writes the
        install's."""
        parsed = tomllib.loads(SHIPPED_CONFIG.read_text(encoding="utf-8"))
        table = parsed.get("client")
        url = table.get("url") if isinstance(table, dict) else None
        self.assertIsNone(url, f"{SHIPPED_CONFIG} declares `{CLIENT_URL_KEY} = {url!r}`")

    def test_the_shared_module_offers_no_shipped_board(self):
        """The core offers no shipped board to fall back to."""
        axi = _load_module(AXI_PATH, "no_shipped_board")
        self.assertFalse(hasattr(axi, "shipped_board"),
                         "the core must no longer offer `shipped_board`")

    def test_no_client_code_or_string_literal_spells_the_packaged_port(self):
        """No client spells the server's packaged port. Comments are not
        code or string literals and are not read here; every Python string
        literal (docstrings included) and every numeric literal is, and the
        reporters' and the schema's text outside `//` comment lines."""
        offenders = []
        for path in sorted(CLIENT_SOURCE_DIR.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and (
                        (isinstance(node.value, str) and PACKAGED_PORT in node.value)
                        or (isinstance(node.value, int) and str(node.value) == PACKAGED_PORT)):
                    offenders.append(f"{path.relative_to(REPO_ROOT)} line {node.lineno}")
        for path in sorted(itertools.chain(CLIENT_SOURCE_DIR.rglob("*.ts"), CLIENT_SOURCE_DIR.rglob("*.json"))):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if PACKAGED_PORT in line and not line.lstrip().startswith(("//", "*", "/*")):
                    offenders.append(f"{path.relative_to(REPO_ROOT)} line {number}")
        self.assertEqual(offenders, [],
                         f"no client code or string literal may spell {PACKAGED_PORT}")


class AVerbThatNeedsNoBoardStillRunsTest(unittest.TestCase):
    """`--help` resolves no board on any client."""

    def test_every_clients_help_exits_zero_and_sends_nothing_with_no_board_declared(self):
        """A pin."""
        install_dir = Path(tempfile.mkdtemp(prefix="no-board-help-install-"))
        self.addCleanup(shutil.rmtree, install_dir, True)
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(client, ["--help"], install_dir)
                self.assertIsNone(drive.escaped, drive.summary())
                self.assertEqual(drive.code, 0, drive.summary())
                self.assertIn("usage:", drive.out)
                self.assertEqual(drive.transport.requests, [], drive.summary())
                self.assertEqual(drive.spawns.work(), [], drive.summary())


#: A linter declared by its own argv, so a spawn of it is recognisable.
LINTER_MARKER = "no-board-marker-linter"
LINT_TABLE = (f'[lint]\ncommand = ["{sys.executable}", "-c", '
              f'"print(\'{LINTER_MARKER}\')"]\nname = "{LINTER_MARKER}"\n')

PROBE_TEST = (
    "import unittest\n\n\n"
    "class ProbeTest(unittest.TestCase):\n"
    "    def test_probe(self):\n"
    "        self.assertTrue(True)\n")


class ABoardReachingRunRefusesBeforeItSpawnsAnythingTest(_ScratchDirsCase):
    """With no board declared, a run whose first board contact is the
    pre-flight refuses at that contact: before a linter, a runner or a
    compile is spawned, and with no outcome recorded."""

    def setUp(self):
        super().setUp()
        self.project_config.write_text(LINT_TABLE, encoding="utf-8")
        (self.project_dir / "package.json").write_text('{"name": "no-board-fixture"}\n')
        tests = self.project_dir / "tests"
        tests.mkdir()
        (tests / "__init__.py").write_text("")
        (tests / "test_probe.py").write_text(PROBE_TEST)
        (tests / "native").mkdir()
        (self.project_dir / "go.mod").write_text("module example.com/noboard\n\ngo 1.24\n")
        self.assertFalse(self.install_config.exists())

    def chain(self):
        return [(self.project_config, NO_URL), (self.install_config, ABSENT)]

    def test_lint_with_an_agent_refuses_before_the_declared_linter_is_spawned_on_every_client(self):
        """The pre-flight is the run's first board contact, so the refusal
        comes before the linter is spawned and nothing is posted."""
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(
                    client, ["lint", "--agent", AGENT, "--project-dir", str(self.project_dir)],
                    self.install_dir)
                linted = [argv for argv in drive.spawns.argvs
                          if any(LINTER_MARKER in part for part in argv)]
                self.assertEqual(linted, [], f"the linter must not be spawned: {drive.summary()}")
                self.assertEqual(drive.spawns.work(), [], drive.summary())
                self.assert_board_refusal(drive, self.chain())

    def test_pre_merge_gate_with_an_agent_refuses_before_any_work_and_records_no_outcome(self):
        """The gate's first board contact refuses, so no compile or runner is
        spawned and no outcome milestone is posted."""
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(
                    client,
                    ["pre-merge-gate", "--agent", AGENT, "--project-dir", str(self.project_dir)],
                    self.install_dir)
                self.assert_refused_before_any_work(drive)

    # -- `--cycle` given: the run is attributed, and it still refuses first ----

    def assert_refused_before_any_work(self, drive):
        """No linter, runner, compile or docker spawned, no outcome posted,
        and the board refusal naming the chain."""
        self.assertEqual(drive.spawns.work(), [],
                         f"no linter, runner, compile or docker may be spawned: {drive.summary()}")
        outcomes = [url for method, url in drive.transport.requests if method != "GET"]
        self.assertEqual(outcomes, [], f"no outcome may be recorded: {drive.summary()}")
        self.assert_board_refusal(drive, self.chain())

    def test_lint_with_an_agent_and_a_cycle_refuses_before_the_declared_linter_is_spawned_on_every_client(self):
        """A `--cycle` attributes the run, so the pre-flight has no binding to
        ask about; it is still the run's first board contact, and with no
        board declared it refuses there, before the linter is spawned."""
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(
                    client,
                    ["lint", "--agent", AGENT, "--cycle", "1",
                     "--project-dir", str(self.project_dir)],
                    self.install_dir)
                linted = [argv for argv in drive.spawns.argvs
                          if any(LINTER_MARKER in part for part in argv)]
                self.assertEqual(linted, [], f"the linter must not be spawned: {drive.summary()}")
                self.assert_refused_before_any_work(drive)

    def test_pre_merge_gate_with_an_agent_and_a_cycle_refuses_before_any_work_and_records_no_outcome(self):
        """A `--cycle` attributes the gate; with no board declared it still
        refuses before its compile, linter or runner, and records nothing."""
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                drive = run_client(
                    client,
                    ["pre-merge-gate", "--agent", AGENT, "--cycle", "1",
                     "--project-dir", str(self.project_dir)],
                    self.install_dir)
                self.assert_refused_before_any_work(drive)

    def test_mvn_compile_with_an_agent_and_a_cycle_refuses_before_maven_is_spawned(self):
        """`compile --agent` files its build output, so its pre-flight is its
        first board contact; with `--cycle` and no board declared it refuses
        before maven is spawned."""
        drive = run_client(
            "mvn",
            ["compile", "--agent", AGENT, "--cycle", "1", "--project-dir", str(self.project_dir)],
            self.install_dir)
        maven = [argv for argv in drive.spawns.argvs
                 if argv and os.path.basename(argv[0]) in ("mvn", "mvnw")]
        self.assertEqual(maven, [], f"maven must not be spawned: {drive.summary()}")
        self.assert_refused_before_any_work(drive)

    def test_mvn_e2e_with_docker_an_agent_and_a_cycle_refuses_before_docker_is_spawned(self):
        """`e2e --with-docker --agent` refuses an unattributable run before it
        touches docker; with `--cycle` and no board declared it refuses at the
        same point, so neither docker nor maven is spawned."""
        drive = run_client(
            "mvn",
            ["e2e", "--with-docker", "--agent", AGENT, "--cycle", "1",
             "--project-dir", str(self.project_dir)],
            self.install_dir)
        docker = [argv for argv in drive.spawns.argvs
                  if argv and os.path.basename(argv[0]) == "docker"]
        self.assertEqual(docker, [], f"docker must not be spawned: {drive.summary()}")
        self.assert_refused_before_any_work(drive)


class RecordingGet:
    """A fake of a client's `_get`: records every path asked and answers as
    a board that refused the read, so a refusal can only come from the
    resolver, never from this answer."""

    def __init__(self):
        self.paths = []

    def __call__(self, path, *args, **kwargs):
        self.paths.append(path)
        return {"ok": False, "error": "the recording get answers nothing"}


class ThePreflightRefusesBeforeItAsksTheBoardTest(_ScratchDirsCase):
    """The shared pre-flight every board-reaching run makes before it spawns
    anything. With an agent it is the run's first board contact, so with no
    board declared it refuses there, before it asks the board anything, even
    when `--cycle` or a context `cycleId` already attributes the run. A run
    with no agent reaches no board, and the pre-flight stays quiet."""

    #: The two ways a run arrives attributed to a cycle.
    ATTRIBUTED = {
        "--cycle": {"cycle_id": 1},
        "context cycleId": {"context": {"cycleId": 1}},
    }

    def setUp(self):
        super().setUp()
        self.axi = _load_module(AXI_PATH, "preflight")
        self.axi.bind_project_dir(None)
        patch = mock.patch.object(self.axi, "_INSTALL_DIR", str(self.install_dir))
        patch.start()
        self.addCleanup(patch.stop)
        self.assertFalse(self.install_config.exists())

    def preflight(self, get, agent_id, **attribution):
        return self.axi.preflight_cycle_warnings(get, PROJECT_KEY, agent_id,
                                                 stream=io.StringIO(), **attribution)

    def refuse(self, get, agent_id, **attribution):
        return self.axi.refuse_unattributed_run(get, PROJECT_KEY, agent_id, **attribution)

    def assert_refuses_before_asking(self, call):
        for form, attribution in self.ATTRIBUTED.items():
            with self.subTest(attributed_by=form):
                get = RecordingGet()
                with self.assertRaises(self.axi.BoardUndeclared) as caught:
                    call(get, AGENT, **attribution)
                self.assertEqual(get.paths, [],
                                 "the refusal comes before the board is asked anything")
                self.assertIn(shown(self.install_config), str(caught.exception))
                self.assertRegex(str(caught.exception), REASON_PATTERNS[ABSENT])

    def test_the_preflight_with_an_agent_and_an_attributed_run_refuses_before_asking_the_board(self):
        self.assert_refuses_before_asking(self.preflight)

    def test_refuse_unattributed_run_with_an_agent_and_an_attributed_run_refuses_before_asking_the_board(self):
        self.assert_refuses_before_asking(self.refuse)

    def test_with_no_agent_the_preflight_and_its_refusal_half_stay_quiet_and_ask_nothing(self):
        """A run with no agent sends nothing, so it resolves no board."""
        for form, attribution in {"unattributed": {}, **self.ATTRIBUTED}.items():
            with self.subTest(attributed_by=form):
                get = RecordingGet()
                self.assertEqual(self.preflight(get, None, **attribution), [])
                self.assertIsNone(self.refuse(get, None, **attribution))
                self.assertEqual(get.paths, [], "no agent, nothing asked")

    def test_with_a_board_declared_an_attributed_run_passes_the_preflight_with_no_warning(self):
        """The refusal is for no board declared, never for an attributed run."""
        self.install_config.write_text(f'[client]\nurl = "{INSTALL_BOARD}"\n', encoding="utf-8")
        for form, attribution in self.ATTRIBUTED.items():
            with self.subTest(attributed_by=form):
                get = RecordingGet()
                self.assertEqual(self.preflight(get, AGENT, **attribution), [])
                self.assertIsNone(self.refuse(get, AGENT, **attribution))


if __name__ == "__main__":
    unittest.main()
