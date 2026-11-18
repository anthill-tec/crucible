"""A client finds its board in the install when its project names none.

The board a client posts to is `[client] url`, read from a chain of
`crucible.toml` files: the bound project directory's, then the install's. The
chain is resolved BY TABLE for the board: the first file that DECLARES a
non-empty string `url` wins, and a file that is absent, does not parse, has no
`[client]` table, or whose `url` is missing, empty, whitespace or not a string
is PASSED OVER. When neither file declares one there is no last resort: the
resolver refuses, and the distribution's own data file is never read for a
board even when it declares one.

The limits keep their own rule: the first file that parses decides them,
whether or not it holds a `[limits]` table. A project file that names no board
falls through for the board and still shadows the install for the limits.

`context.board` keys off the machine's own board: an envelope names the
resolved board only when it differs from the install's declared `url`; when
the install declares none, a project-declared board is always named.

── How each half is proven ──────────────────────────────────────────────────

`TheBoardChainPassesOverAFileThatNamesNoBoardTest` and
`TheContextNamesTheBoardOnlyWhenItIsNotTheMachinesOwnTest` are in process: the
shared module is loaded from a SCRATCH FLEET (`_scratch_fleet`), a copy of
`clients/` under a temp root, so the module's own location makes that temp root
its INSTALL dir and `<root>/clients/crucible.toml` its shipped data. Every
file is therefore a temp file this suite writes; no socket is opened. The
scratch shipped data declares a stand-in board, so a resolver that still read
it would answer that stand-in and be caught.

`AVerbFromAProjectThatNamesNoBoardPostsToTheInstallsBoardTest` drives the real
`status` verb of every client as a subprocess from such a scratch fleet, with
two recording boards standing in for the install's board and the shipped one.
Before any drive the scratch module is asked, in process, which board it would
resolve, and a drive is refused unless the answer is one of those two boards.

── Safety ───────────────────────────────────────────────────────────────────

No layer names the dev board or the production install. The class that
leaves the shipped data file as the distribution ships it asks the module in
process, and makes no request.
"""

import os
import shutil
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from tests.client.a_clients_board_is_its_projects_configuration_helpers import (
    CONFIG_NAME,
    _argv_for,
    _RecordingBoard,
    _scratch_fleet,
    _summarise,
    drive,
)
from tests.client.integration.test_client_fleet_envelope_census import BoardInterlockCase
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _load_toon_module,
    _make_project_dir,
    declare_board,
)

#: In-process addresses only: these name no listener and no request is made to
#: them. Each layer gets its own so the answer says which layer decided.
INSTALL_BOARD = "http://127.0.0.1:47101"
PROJECT_BOARD = "http://127.0.0.1:47102"
SHIPPED_STAND_IN = "http://127.0.0.1:47103"
OTHER_BOARD = "http://127.0.0.1:47104"

#: The ports of the checkout's dev board and the production install. No layer
#: this suite writes names either, and no drive is made that resolves either.
PRODUCTION_BOARD_PORTS = (3849, 3850)

#: What every Model B project's own file declares: a gate skip and nothing else.
GATE_ONLY = '[gate]\nskip = ["pr"]\n'

#: A project file for each shape the chain passes over for the board. Each
#: parses (bar the last) and none declares a usable `url`.
PASSED_OVER_PROJECT_FILES = {
    "no client table": GATE_ONLY,
    "a client table with no url":
        GATE_ONLY + '\n[client]\nnote = "this project names no board"\n',
    "an empty url": GATE_ONLY + '\n[client]\nurl = ""\n',
    "a whitespace url": GATE_ONLY + '\n[client]\nurl = "   "\n',
    "an integer url": GATE_ONLY + "\n[client]\nurl = 3851\n",
    "a boolean url": GATE_ONLY + "\n[client]\nurl = true\n",
    "an array url": GATE_ONLY + f'\n[client]\nurl = ["{PROJECT_BOARD}"]\n',
}

#: A project file that does not parse: an unclosed table header.
UNPARSEABLE = f'[client\nurl = "{PROJECT_BOARD}"\n'

#: A limit the install sets inside its range, so the file that decides the
#: limits is visible in the number that resolves.
LIMIT_NAME = "truncate_field_chars"
INSTALL_LIMIT_VALUE = 300


def _install_text(url=None, limit_value=None):
    """An install `crucible.toml`: optionally a limit, optionally a board."""
    parts = []
    if limit_value is not None:
        parts.append(f"[limits.{LIMIT_NAME}]\nvalue = {limit_value}\n")
    if url is not None:
        parts.append(f'[client]\nurl = "{url}"\n')
    return "\n".join(parts) if parts else "# an install that declares nothing\n"


def _blank_workflow_env():
    """`axi_context` reads WORKFLOW_WAVE and WORKFLOW_ROLE; the session that
    launched the suite may export both."""
    return mock.patch.dict(os.environ, {"WORKFLOW_WAVE": "", "WORKFLOW_ROLE": ""})


class _ScratchChainCase(unittest.TestCase):
    """A scratch fleet whose three layers this test writes, and a temp project
    dir. The shared module is loaded fresh from the scratch copy per test, so
    its install dir is the scratch root and its shipped data the scratch copy.
    """

    #: The shipped declaration the scratch copy is rewritten to; None leaves
    #: the distribution's own value in place.
    SHIPPED = SHIPPED_STAND_IN

    _loads = 0

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="board-fall-through-install-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        _scripts, self.shipped_config, self.install_config = _scratch_fleet(self.root)
        if self.SHIPPED is not None:
            declare_board(self.shipped_config, self.SHIPPED)
        self.project_dir = Path(tempfile.mkdtemp(prefix="board-fall-through-project-"))
        self.addCleanup(shutil.rmtree, self.project_dir, True)
        self.project_config = self.project_dir / CONFIG_NAME
        type(self)._loads += 1
        self.axi = _load_module(
            self.root / "clients" / "_crucible_axi.py",
            f"board_fall_through_{type(self).__name__}_{type(self)._loads}")
        self.addCleanup(self.axi.bind_project_dir, None)

    def write_install(self, text):
        self.install_config.write_text(text, encoding="utf-8")

    def write_project(self, text):
        self.project_config.write_text(text, encoding="utf-8")

    def resolve(self, bind_project=True):
        """The board the scratch module resolves with the temp project dir
        bound (`bind_project=False` binds none)."""
        self.axi.bind_project_dir(str(self.project_dir) if bind_project else None)
        try:
            return self.axi.resolve_base_url()
        finally:
            self.axi.bind_project_dir(None)

    def outcome(self):
        """`"refused"` when the resolver refuses with the no-board hard stop
        (a direct `Exception` subclass, never an `OSError` or `ValueError`),
        else what it answered or raised."""
        try:
            return self.resolve()
        except AssertionError:
            raise
        except Exception as exc:  # noqa: BLE001 -- the refusal's type is GREEN's to name
            if isinstance(exc, (OSError, ValueError)) or type(exc).__bases__ != (Exception,):
                return f"raised {exc!r}"
            return "refused"

    def context(self, project_key="probe-project-key"):
        self.axi.bind_project_dir(str(self.project_dir))
        try:
            with _blank_workflow_env():
                return self.axi.axi_context(project_key, agent_id="probe-agent")
        finally:
            self.axi.bind_project_dir(None)


class TheBoardChainPassesOverAFileThatNamesNoBoardTest(_ScratchChainCase):
    """The board resolves from the first file that DECLARES a non-empty
    string `[client] url`: the project's, then the install's. In process, over
    no socket."""

    def test_a_project_file_declaring_only_a_gate_skip_resolves_the_installs_board(self):
        """Every Model B project's file: it parses and names no board, so it
        is passed over for the install's. Fails today because the first file
        that parses wins, so the shipped declaration is answered."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(GATE_ONLY)

        resolved = self.resolve()

        self.assertEqual(
            resolved, INSTALL_BOARD,
            f"a project file declaring only `[gate] skip` must be passed over "
            f"for the install's `[client] url`; resolved {resolved!r} "
            f"(shipped stand-in is {SHIPPED_STAND_IN!r})")
        self.assertNotEqual(resolved, SHIPPED_STAND_IN)

    def test_every_project_file_that_names_no_usable_url_is_passed_over_for_the_installs(self):
        """No `[client]` table, a table without `url`, an empty, whitespace,
        integer, boolean or array `url`: each is passed over. Fails today:
        each of these files parses, so it wins and the shipped declaration is
        answered."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        answers = {}
        for case, text in PASSED_OVER_PROJECT_FILES.items():
            self.write_project(text)
            answers[case] = self.resolve()
        wrong = {case: got for case, got in answers.items() if got != INSTALL_BOARD}
        self.assertEqual(
            wrong, {},
            f"each project file that declares no non-empty string `url` must "
            f"fall through to the install's {INSTALL_BOARD!r}; these resolved "
            f"elsewhere: {wrong!r}")

    def test_a_project_file_that_does_not_parse_is_passed_over_for_the_installs(self):
        """A regression pin: a malformed project file already falls through.
        It must keep doing so under the by-table rule, and must not raise."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(UNPARSEABLE)
        self.assertEqual(self.resolve(), INSTALL_BOARD)

    def test_a_project_with_no_file_resolves_the_installs_board(self):
        """A regression pin: no project file at all falls through to the
        install's."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.assertFalse(self.project_config.exists())
        self.assertEqual(self.resolve(), INSTALL_BOARD)

    def test_with_no_project_dir_bound_the_installs_board_resolves(self):
        """A regression pin: an operator outside any project has the install's
        file only."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.assertEqual(self.resolve(bind_project=False), INSTALL_BOARD)

    def test_the_installs_url_is_answered_stripped_when_the_project_names_none(self):
        """The value answered is the declared one, stripped. Fails today: the
        project file wins and the shipped declaration is answered."""
        self.write_install(_install_text(url=f"  {INSTALL_BOARD}  "))
        self.write_project(GATE_ONLY)
        self.assertEqual(self.resolve(), INSTALL_BOARD)

    def test_the_projects_own_url_wins_over_the_installs(self):
        """A regression pin: with both files declaring a `url`, the project's
        is used, stripped."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(GATE_ONLY + f'\n[client]\nurl = " {PROJECT_BOARD} "\n')
        self.assertEqual(self.resolve(), PROJECT_BOARD)

    def test_an_install_file_that_names_no_usable_url_leaves_no_board_and_refuses(self):
        """Neither file declares a usable `url`, so the resolver refuses --
        for every shape the install's own file can take -- and never answers
        the shipped data's board. Fails today: the shipped declaration is the
        last resort and is answered."""
        self.write_project(GATE_ONLY)
        install_shapes = {
            "limits only": _install_text(limit_value=INSTALL_LIMIT_VALUE),
            "an empty url": '[client]\nurl = ""\n',
            "a whitespace url": '[client]\nurl = "  "\n',
            "an integer url": "[client]\nurl = 3851\n",
            "a client table with no url": '[client]\nnote = "none"\n',
            "a file that does not parse": "[client\n",
        }
        answers = {}
        for case, text in install_shapes.items():
            self.write_install(text)
            answers[case] = self.outcome()
        self.install_config.unlink()
        answers["no install file"] = self.outcome()
        wrong = {case: got for case, got in answers.items() if got != "refused"}
        self.assertEqual(
            wrong, {},
            f"with neither file declaring a usable `url` the resolver refuses "
            f"(a direct Exception subclass, never an OSError or ValueError) "
            f"instead of answering the shipped data's {SHIPPED_STAND_IN!r}; "
            f"these did not: {wrong!r}")

    def test_the_board_is_reread_at_the_point_of_use_after_the_install_changes(self):
        """Never cached: an edit to the install's file is the next answer.
        Fails today: the project file wins, so neither install value is ever
        answered."""
        self.write_project(GATE_ONLY)
        self.write_install(_install_text(url=INSTALL_BOARD))
        first = self.resolve()
        self.write_install(_install_text(url=OTHER_BOARD))
        second = self.resolve()
        self.assertEqual((first, second), (INSTALL_BOARD, OTHER_BOARD))

    def test_a_project_file_that_names_no_board_still_decides_the_limits(self):
        """The two rules side by side. The project file parses and holds
        neither `[client]` nor `[limits]`: the board falls through to the
        install's, while the limits stay the project file's (so the shipped
        recommendation, not the install's `value`). Fails today on the board:
        the shipped declaration is answered."""
        self.write_install(_install_text(url=INSTALL_BOARD,
                                         limit_value=INSTALL_LIMIT_VALUE))
        recommended = self.axi.shipped_limits()[LIMIT_NAME]["recommended"]
        self.assertNotEqual(recommended, INSTALL_LIMIT_VALUE,
                            "fixture sanity: the install's value must differ "
                            "from the shipped recommendation")

        # Fixture proof: with no project file, the install decides the limit.
        self.axi.bind_project_dir(str(self.project_dir))
        try:
            self.assertEqual(self.axi.resolve_limit(LIMIT_NAME), INSTALL_LIMIT_VALUE)
        finally:
            self.axi.bind_project_dir(None)

        self.write_project(GATE_ONLY)
        board = self.resolve()
        self.axi.bind_project_dir(str(self.project_dir))
        try:
            limit = self.axi.resolve_limit(LIMIT_NAME)
            config_path = self.axi.project_config_path()
        finally:
            self.axi.bind_project_dir(None)

        self.assertEqual(
            {"board": board, "limit": limit, "limitsFrom": config_path},
            {"board": INSTALL_BOARD, "limit": recommended,
             "limitsFrom": str(self.project_config)},
            "the board falls through to the install's file while the limits "
            "keep the first file that parses -- the project's")


class TheDistributionShipsNoLastResortBoardTest(_ScratchChainCase):
    """With neither file declaring a board, nothing is answered. The scratch
    copy keeps the distribution's own data file as it ships; the module is
    asked in process and nothing is sent anywhere."""

    SHIPPED = None

    def test_with_neither_file_declaring_a_url_the_resolver_refuses(self):
        """Fails today: the shipped address is the last resort and is
        answered."""
        self.write_install(_install_text(limit_value=INSTALL_LIMIT_VALUE))
        self.write_project(GATE_ONLY)
        self.assertEqual(self.outcome(), "refused")

    def test_the_shared_module_offers_no_shipped_board(self):
        """Fails today: `shipped_board` is the last resort's reader."""
        self.assertFalse(hasattr(self.axi, "shipped_board"))

    def test_with_no_board_declared_the_context_omits_the_board_and_does_not_raise(self):
        """A pin: the refusal's own envelope is built with this context, so
        building it never raises, and it names no board."""
        self.write_install(_install_text(limit_value=INSTALL_LIMIT_VALUE))
        self.write_project(GATE_ONLY)
        context = self.context()
        self.assertNotIn("board", context)
        self.assertEqual(context.get("projectKey"), "probe-project-key")


class TheContextNamesTheBoardOnlyWhenItIsNotTheMachinesOwnTest(_ScratchChainCase):
    """`context.board` is named only when the resolved board differs from the
    install's declared `url`; when the install declares none, a
    project-declared board is always named. In process, `axi_context` over no
    socket."""

    def test_a_verb_resolving_the_installs_url_through_its_project_names_no_board(self):
        """The project declares the install's own board. Fails today: the
        board is compared with the shipped declaration, differs, and is named."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(f'[client]\nurl = "{INSTALL_BOARD}"\n')
        self.assertEqual(self.resolve(), INSTALL_BOARD)

        context = self.context()

        self.assertNotIn(
            "board", context,
            f"the resolved board is the install's own declared `url`, so the "
            f"envelope must not name it; got {context!r}")
        self.assertEqual(context.get("projectKey"), "probe-project-key")
        self.assertEqual(context.get("agentId"), "probe-agent")

    def test_a_verb_falling_through_to_the_installs_url_names_no_board(self):
        """The project names none and the install's board resolves. Fails
        today at the resolution: the shipped declaration is answered."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(GATE_ONLY)
        self.assertEqual(self.resolve(), INSTALL_BOARD,
                         "the project names no board, so the install's resolves")
        context = self.context()
        self.assertNotIn("board", context, f"got {context!r}")
        self.assertEqual(context.get("projectKey"), "probe-project-key")

    def test_a_project_naming_the_shipped_address_names_it_when_the_install_declares_another(self):
        """The install declares its own board, the project declares the
        shipped one: that is another board than the machine's own, so it is
        named. Fails today: it equals the shipped declaration and is omitted."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(f'[client]\nurl = "{SHIPPED_STAND_IN}"\n')
        self.assertEqual(self.resolve(), SHIPPED_STAND_IN)

        context = self.context()

        self.assertEqual(
            context.get("board"), SHIPPED_STAND_IN,
            f"the project's board differs from the install's declared "
            f"{INSTALL_BOARD!r}, so the envelope must name it; got {context!r}")

    def test_a_project_naming_a_third_board_names_it_when_the_install_declares_one(self):
        """A regression pin: a board that is neither the install's nor the
        shipped one is always named."""
        self.write_install(_install_text(url=INSTALL_BOARD))
        self.write_project(f'[client]\nurl = "{OTHER_BOARD}"\n')
        self.assertEqual(self.context().get("board"), OTHER_BOARD)

    def test_with_no_install_url_every_project_declared_board_is_named(self):
        """With no `url` in the install's file there is no machine's own board
        to omit, so the project's board is named -- the shipped data's value
        included. Fails today: the shipped declaration is omitted."""
        self.write_install(_install_text(limit_value=INSTALL_LIMIT_VALUE))
        self.write_project(f'[client]\nurl = "{SHIPPED_STAND_IN}"\n')
        self.assertEqual(self.context().get("board"), SHIPPED_STAND_IN)

        self.write_project(f'[client]\nurl = "{OTHER_BOARD}"\n')
        self.assertEqual(self.context().get("board"), OTHER_BOARD)

    def test_an_install_url_that_is_not_usable_counts_as_none_for_the_context(self):
        """An install whose `url` is empty declares none, so the project's
        board is named -- even the shipped data's value. Fails today: the
        comparison falls back to the shipped declaration and omits it."""
        self.write_install('[client]\nurl = ""\n')
        self.write_project(f'[client]\nurl = "{SHIPPED_STAND_IN}"\n')
        self.assertEqual(self.context().get("board"), SHIPPED_STAND_IN)

        self.write_project(f'[client]\nurl = "{OTHER_BOARD}"\n')
        self.assertEqual(self.context().get("board"), OTHER_BOARD)


# ── End to end: the real clients, against recording boards ───────────────────

#: The read verb every client carries; it writes nothing to a board.
VERB = "status"

#: The three project files each client is driven from, and what each must do.
#:   names-none       -- only a gate skip: posts to the install's board, names
#:                       no `context.board` (it is the machine's own board).
#:   names-installs   -- declares the install's board: posts there, names none.
#:   names-shipped    -- declares the shipped stand-in, which differs from the
#:                       install's declared board: posts there and names it.
CASES = ("names-none", "names-installs", "names-shipped")

_E2E = None


def _guard(axi_path, project_dir, allowed):
    """`(resolved, reason)`: the board the scratch module would resolve for
    `project_dir`, asked in process, and a refusal reason unless it is one of
    the recording boards this fixture listens on."""
    axi = _load_module(axi_path, f"board_fall_through_guard_{id(project_dir)}")
    axi.bind_project_dir(str(project_dir))
    try:
        resolved = axi.resolve_base_url()
    except Exception as exc:  # noqa: BLE001 -- a resolver that raises is not driven
        return None, f"resolve_base_url() raised {exc!r}"
    finally:
        axi.bind_project_dir(None)
    if urllib.parse.urlsplit(resolved).port in PRODUCTION_BOARD_PORTS:
        return resolved, f"it would resolve {resolved!r}, a production port"
    if resolved not in allowed:
        return resolved, (f"it would resolve {resolved!r}, which no recording "
                          f"board of this fixture listens on")
    return resolved, None


def _e2e_drives():
    """One `status` drive per client per case, from one scratch fleet whose
    install declares the `install` recording board and whose shipped data
    declares the `shipped` one. Built once per module."""
    global _E2E
    if _E2E is not None:
        return _E2E
    fake_bin_dir = _build_fake_bin_dir()
    root = Path(tempfile.mkdtemp(prefix="board-fall-through-fleet-"))
    boards = {"install": _RecordingBoard("install"),
              "shipped": _RecordingBoard("shipped")}
    allowed = {board.url for board in boards.values()}
    drives = {case: {} for case in CASES}
    try:
        scripts, shipped_config, install_config = _scratch_fleet(root)
        declare_board(shipped_config, boards["shipped"].url)
        install_config.write_text(
            _install_text(url=boards["install"].url,
                          limit_value=INSTALL_LIMIT_VALUE), encoding="utf-8")
        axi_path = Path(shipped_config).parent / "_crucible_axi.py"
        project_files = {
            "names-none": GATE_ONLY,
            "names-installs": GATE_ONLY + f'\n[client]\nurl = "{boards["install"].url}"\n',
            "names-shipped": GATE_ONLY + f'\n[client]\nurl = "{boards["shipped"].url}"\n',
        }
        for client, script_path in scripts.items():
            project_dir = _make_project_dir(client)
            try:
                for case in CASES:
                    (Path(project_dir) / CONFIG_NAME).write_text(
                        project_files[case], encoding="utf-8")
                    record = {"result": None, "blocked": None, "resolved": None,
                              "recorded": {name: [] for name in boards}}
                    drives[case][client] = record
                    resolved, reason = _guard(axi_path, project_dir, allowed)
                    record["resolved"] = resolved
                    if reason:
                        record["blocked"] = reason
                        continue
                    marks = {name: board.mark() for name, board in boards.items()}
                    result, _ = drive(script_path, _argv_for(VERB, project_dir),
                                      project_dir, fake_bin_dir)
                    record["result"] = result
                    record["recorded"] = {name: board.since(marks[name])
                                          for name, board in boards.items()}
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        for board in boards.values():
            board.close()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _E2E = {"drives": drives,
            "urls": {name: board.url for name, board in boards.items()}}
    return _E2E


class AVerbFromAProjectThatNamesNoBoardPostsToTheInstallsBoardTest(BoardInterlockCase):
    """End to end: every client's real `status`, as a subprocess, from a
    scratch fleet whose install declares one recording board and whose shipped
    data declares another."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.e2e = _e2e_drives()
        cls.toon = _load_toon_module()

    def _context(self, client, record):
        result = record["result"]
        decoded = self.toon.decode(result.stdout)
        self.assertIsInstance(
            decoded, dict,
            f"{client} `{VERB}` emitted no decodable envelope: {_summarise(result)}")
        self.assertIn("axi", decoded)
        context = decoded["axi"].get("context")
        self.assertIsInstance(context, dict,
                              f"{client} `{VERB}` envelope has no context: {decoded!r}")
        self.assertIn("projectKey", context)
        return context

    def _assert_posted_only_to(self, client, case, layer):
        record = self.driven(f"{client}-crucible.py {VERB} [{case}]",
                             self.e2e["drives"][case][client])
        recorded = record["recorded"]
        self.assertNotEqual(
            recorded[layer], [],
            f"{client}-crucible.py {VERB} from a project that {case} must post "
            f"to the {layer} board ({self.e2e['urls'][layer]}); it resolved "
            f"{record['resolved']!r} and that board recorded nothing. "
            f"{_summarise(record['result'])}")
        others = {name: rows for name, rows in recorded.items()
                  if name != layer and rows}
        self.assertEqual(
            others, {},
            f"{client}-crucible.py {VERB} [{case}] also reached another board: "
            f"{others!r}")
        return record

    def test_every_client_from_a_gate_only_project_posts_to_the_installs_board(self):
        """Fails today: the project file wins with no `[client]`, so every
        client posts to the shipped board instead."""
        drives = self.e2e["drives"]["names-none"]
        self.assertEqual(sorted(drives), sorted(CLIENT_FILES))
        for client in sorted(drives):
            with self.subTest(client=client):
                record = self._assert_posted_only_to(client, "names-none", "install")
                context = self._context(client, record)
                self.assertNotIn(
                    "board", context,
                    f"{client} resolved the install's own declared board, so "
                    f"its envelope names none; got {context!r}")

    def test_every_client_declaring_the_installs_board_names_no_board(self):
        """Fails today: the install's board differs from the shipped one, so
        every envelope names it."""
        drives = self.e2e["drives"]["names-installs"]
        self.assertEqual(sorted(drives), sorted(CLIENT_FILES))
        for client in sorted(drives):
            with self.subTest(client=client):
                record = self._assert_posted_only_to(client, "names-installs", "install")
                context = self._context(client, record)
                self.assertNotIn(
                    "board", context,
                    f"{client} resolved the install's own declared board "
                    f"{self.e2e['urls']['install']!r}, so its envelope names "
                    f"none; got {context!r}")

    def test_every_client_declaring_another_board_than_the_installs_names_it(self):
        """The project declares the shipped board, which is not the install's.
        Fails today: it equals the shipped declaration, so it is omitted."""
        drives = self.e2e["drives"]["names-shipped"]
        self.assertEqual(sorted(drives), sorted(CLIENT_FILES))
        for client in sorted(drives):
            with self.subTest(client=client):
                record = self._assert_posted_only_to(client, "names-shipped", "shipped")
                context = self._context(client, record)
                self.assertEqual(
                    context.get("board"), self.e2e["urls"]["shipped"],
                    f"{client} posted to a board that is not the install's "
                    f"declared one, so its envelope must name it; got {context!r}")


if __name__ == "__main__":
    unittest.main()
