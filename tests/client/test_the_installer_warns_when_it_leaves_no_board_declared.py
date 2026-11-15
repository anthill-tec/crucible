"""The installer says when it leaves this machine with no board declared.

A client whose project and install both name no board refuses. The install's
`crucible.toml` at `<target>` is where the installer writes `[client] url`,
and it writes one only when a listener was resolved, meaning a server is
provisioned on this machine. Three ways leave that file declaring no board:

* a fresh install with no local server (the plan has no `source`), so the
  freshly laid file carries no `[client]` table;
* an upgrade of an install whose file never had a url, again with no server,
  so the fill never runs and the file is left as it is;
* a fill the stage refused (`notFilled` for `[client] url`), so the file
  still declares none.

In each case the `[manifest]` stage result and the install's `[manifest]` row
carry `boardUndeclared: {"path": <absolute path of that file>, "key": "[client] url"}`,
the same `{path, key}` shape and absolute-path rule as a `notFilled` entry. The
install envelope's `help` also gains a line that names the file and the key to
declare there. A file that ends declaring a non-empty url gets neither. An
empty `url = ""` declares no board, so it warns.

Every test here is a UNIT test. The stage runs in process against a temporary
target dir and a server-config PLAN the test builds. The plan's listener is
plain data, so no port is ever bound or probed. The other stages are doubles.
`$HOME` and the XDG and Bun variables point inside the test's own temporary
root. The vendored envelope module is pointed at an empty install dir of that
root, so the checkout's own `crucible.toml` is never read.
"""

import contextlib
import importlib.util
import io
import os
import pwd
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from crucible_axi import cli, install, manifest
from tests.client import client_script

CONFIG_NAME = "crucible.toml"
URL_KEY_LABEL = "[client] url"
WARNING_FIELD = "boardUndeclared"

#: A listener port well outside the shipped 3800-3899 window. It is only a
#: number in a plan; nothing binds or probes it.
LISTENER_HOST = "127.0.0.1"
LISTENER_PORT = 47123
LISTENER_URL = f"http://{LISTENER_HOST}:{LISTENER_PORT}"

#: The operator's real home, from the password database. Compared against
#: only; nothing under it is opened.
REAL_HOME = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)

#: An older install's client file: limits only, no `[client]` table.
OLDER_INSTALL_FILE = (
    b"# laid down before the installer wrote a board\n"
    b"[limits.truncate_field_chars]\n"
    b"value = 400\n"
)

#: A file that declares a board.
DECLARED_URL = "http://board.example.test:47999"
DECLARED_INSTALL_FILE = (
    b"[limits.truncate_field_chars]\n"
    b"value = 400\n"
    b"\n"
    b"[client]\n"
    b'url = "' + DECLARED_URL.encode() + b'"\n'
)

#: A project-style file whose `[client] url` is present but empty.
EMPTY_URL_INSTALL_FILE = (
    b"[limits.truncate_field_chars]\n"
    b"value = 400\n"
    b"\n"
    b"[client]\n"
    b'url = ""\n'
)

#: A file whose `[client] url` is present but only whitespace. The client
#: strips the url it reads, so it finds no board here and refuses.
WHITESPACE_URL_INSTALL_FILE = (
    b"[limits.truncate_field_chars]\n"
    b"value = 400\n"
    b"\n"
    b"[client]\n"
    b'url = "   "\n'
)

#: The client's shared module in this checkout, loaded in process only to ask
#: whether IT finds a board in a file; its install dir is always patched.
CLIENT_CORE = client_script("_crucible_axi.py")

#: A file in which `client` is a string, not a table, so the fill refuses it.
CLIENT_NOT_A_TABLE_FILE = b'client = "not a table"\n'

#: A file that does not parse as TOML, so the fill refuses it.
UNPARSEABLE_FILE = b"[limits\nthis is not toml = = =\n"


def _stub_stage(target_dir, force):
    """A stage double: reports a path and converges, doing nothing."""
    return {"path": os.path.join(target_dir, "stub"), "converged": True}


def _board_url(host, port):
    return f"http://{host}:{port}"


def _declared_url(path):
    """The `[client] url` the file at `path` declares, or None."""
    import tomllib

    try:
        document = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    client = document.get("client")
    if not isinstance(client, dict):
        return None
    return client.get("url")


class _NoBoardCase(unittest.TestCase):
    """A temporary root holding the sandboxed `$HOME` and XDG/Bun dirs, the
    install target, the server's store and an empty install dir for the
    vendored envelope module."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="installer-no-board-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.fake_home = os.path.join(self.root, "home")
        self.xdg_data = os.path.join(self.root, "xdg-data")
        self.xdg_config = os.path.join(self.root, "xdg-config")
        self.bun_root = os.path.join(self.root, "bun")
        self.store = os.path.join(self.root, "store")
        self.client_install_dir = os.path.join(self.root, "client-install")
        for directory in (self.fake_home, self.xdg_data, self.xdg_config,
                          self.bun_root, self.store, self.client_install_dir):
            os.makedirs(directory)
        environment = mock.patch.dict(os.environ, {
            "HOME": self.fake_home,
            "XDG_DATA_HOME": self.xdg_data,
            "XDG_CONFIG_HOME": self.xdg_config,
            "BUN_INSTALL": self.bun_root,
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.assertNotEqual(
            REAL_HOME, os.path.realpath(os.environ["HOME"]),
            "fixture sanity: the test must never run in the operator's home")
        # The target sits beside the sandboxed home, not under it, so a path
        # an operator reads is the absolute path whether or not it is
        # abbreviated.
        self.target = os.path.join(self.root, "target")
        os.makedirs(self.target)
        self.client_file = os.path.join(self.target, CONFIG_NAME)
        self.server_file = os.path.join(self.store, CONFIG_NAME)
        self.server_template = os.path.join(self.root, "server-template.toml")
        Path(self.server_template).write_text(
            f'[server]\nhost = "{LISTENER_HOST}"\n', encoding="utf-8")

    # -- plans ---------------------------------------------------------------

    def plan_without_server(self):
        """What `server_config_plan` answers on a machine with no server."""
        return {"path": self.server_file, "source": None,
                "reason": "no Crucible server is provisioned on this machine"}

    def plan_with_listener(self):
        """What `server_config_plan` answers on a machine with a server."""
        return {"path": self.server_file, "source": self.server_template,
                "reason": None,
                "listener": {"host": LISTENER_HOST, "port": LISTENER_PORT,
                             "url": LISTENER_URL},
                "board_url": _board_url}

    # -- fixtures ------------------------------------------------------------

    def place_client_file(self, data):
        Path(self.client_file).write_bytes(data)

    def run_stage(self, plan):
        return manifest.run_manifest_stage(self.target, server_config=plan)

    def expected_warning(self):
        return {"path": self.client_file, "key": URL_KEY_LABEL}

    def assert_warns(self, result):
        self.assertEqual(
            self.expected_warning(), result.get(WARNING_FIELD),
            f"a client file that ends declaring no `[client] url` must be "
            f"named, with its key, under `{WARNING_FIELD}`; the stage result "
            f"was {result!r}")

    def assert_does_not_warn(self, result):
        self.assertNotIn(
            WARNING_FIELD, result,
            f"a client file that ends declaring a url owes no "
            f"`{WARNING_FIELD}`; the stage result was {result!r}")


# ===========================================================================
# The `[manifest]` stage result
# ===========================================================================


class TheManifestStageWarnsWhenTheClientFileEndsWithNoBoardTest(_NoBoardCase):

    def test_a_fresh_install_with_no_local_server_warns_naming_the_laid_down_file_and_the_key(self):
        result = self.run_stage(self.plan_without_server())

        self.assertTrue(
            os.path.isfile(self.client_file),
            "fixture sanity: the stage lays the client file down")
        self.assertIsNone(
            _declared_url(self.client_file),
            "fixture sanity: with no listener the laid-down file declares no "
            "url")
        self.assert_warns(result)
        self.assertTrue(
            os.path.isabs(result[WARNING_FIELD]["path"]),
            "the warning names the file by its absolute path, as a "
            "`notFilled` entry does")

    def test_an_upgrade_with_no_local_server_warns_and_leaves_the_file_untouched(self):
        self.place_client_file(OLDER_INSTALL_FILE)

        result = self.run_stage(self.plan_without_server())

        self.assertEqual(
            OLDER_INSTALL_FILE, Path(self.client_file).read_bytes(),
            "an upgrade with no listener writes nothing into the operator's "
            "file")
        self.assert_warns(result)
        self.assertNotIn("filled", result,
                         "nothing was filled, so no `filled` entry is owed")

    def test_a_fill_refused_because_client_is_not_a_table_still_warns(self):
        self.place_client_file(CLIENT_NOT_A_TABLE_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            CLIENT_NOT_A_TABLE_FILE, Path(self.client_file).read_bytes(),
            "fixture sanity: a refused fill leaves the file as it was")
        refused = [entry for entry in result.get("notFilled", [])
                   if entry.get("path") == self.client_file]
        self.assertEqual(
            1, len(refused),
            f"fixture sanity: the url fill is refused as `notFilled`; the "
            f"stage result was {result!r}")
        self.assertEqual(URL_KEY_LABEL, refused[0]["key"])
        self.assert_warns(result)

    def test_a_fill_refused_because_the_file_does_not_parse_still_warns(self):
        self.place_client_file(UNPARSEABLE_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            UNPARSEABLE_FILE, Path(self.client_file).read_bytes(),
            "fixture sanity: a refused fill leaves the file as it was")
        self.assertIn(
            self.client_file,
            [entry.get("path") for entry in result.get("notFilled", [])],
            f"fixture sanity: the url fill is refused as `notFilled`; the "
            f"stage result was {result!r}")
        self.assert_warns(result)

    def test_an_empty_url_declares_no_board_and_warns_with_no_local_server(self):
        self.place_client_file(EMPTY_URL_INSTALL_FILE)

        result = self.run_stage(self.plan_without_server())

        self.assertEqual(EMPTY_URL_INSTALL_FILE,
                         Path(self.client_file).read_bytes())
        self.assert_warns(result)

    def test_an_empty_url_is_left_alone_by_the_fill_and_still_warns(self):
        self.place_client_file(EMPTY_URL_INSTALL_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            EMPTY_URL_INSTALL_FILE, Path(self.client_file).read_bytes(),
            "fixture sanity: a present key, even an empty one, is the "
            "operator's and is never filled")
        self.assert_warns(result)

    def assert_the_client_refuses_the_file(self):
        """The client, reading the stage's file as its install's with no
        project bound, finds no board and refuses: the case the warning is
        for."""
        spec = importlib.util.spec_from_file_location(
            f"installer_no_board_client_{id(self)}", CLIENT_CORE)
        assert spec is not None and spec.loader is not None
        core: Any = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(core)
        core.bind_project_dir(None)
        with (mock.patch.object(core, "_INSTALL_DIR", self.target),
              self.assertRaises(core.BoardUndeclared,
                                msg="fixture sanity: the client finds no "
                                    "board in a whitespace-only url")):
            core.resolve_base_url()

    def test_a_whitespace_only_url_declares_no_board_and_warns_with_no_local_server(self):
        """The client refuses a whitespace-only url, so the stage warns as it
        does for an empty one."""
        self.place_client_file(WHITESPACE_URL_INSTALL_FILE)

        result = self.run_stage(self.plan_without_server())

        self.assertEqual(WHITESPACE_URL_INSTALL_FILE,
                         Path(self.client_file).read_bytes())
        self.assert_the_client_refuses_the_file()
        self.assert_warns(result)

    def test_a_whitespace_only_url_is_left_alone_by_the_fill_and_still_warns(self):
        """A present key is the operator's and is never filled, so a
        whitespace-only url stays, and the client still refuses it."""
        self.place_client_file(WHITESPACE_URL_INSTALL_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            WHITESPACE_URL_INSTALL_FILE, Path(self.client_file).read_bytes(),
            "fixture sanity: a present key is the operator's and is never "
            "filled")
        self.assert_the_client_refuses_the_file()
        self.assert_warns(result)


class TheManifestStageDoesNotWarnWhenTheClientFileDeclaresABoardTest(_NoBoardCase):

    def test_a_fresh_install_with_a_listener_writes_the_url_and_does_not_warn(self):
        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            LISTENER_URL, _declared_url(self.client_file),
            "fixture sanity: a fresh install with a listener writes its url")
        self.assert_does_not_warn(result)

    def test_an_upgrade_whose_file_gets_the_listener_url_filled_does_not_warn(self):
        self.place_client_file(OLDER_INSTALL_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            LISTENER_URL, _declared_url(self.client_file),
            "fixture sanity: the fill writes the listener's url")
        self.assert_does_not_warn(result)

    def test_an_existing_file_declaring_a_url_does_not_warn_with_no_local_server(self):
        self.place_client_file(DECLARED_INSTALL_FILE)

        result = self.run_stage(self.plan_without_server())

        self.assertEqual(DECLARED_INSTALL_FILE,
                         Path(self.client_file).read_bytes())
        self.assert_does_not_warn(result)

    def test_an_existing_file_declaring_a_url_does_not_warn_with_a_listener(self):
        self.place_client_file(DECLARED_INSTALL_FILE)

        result = self.run_stage(self.plan_with_listener())

        self.assertEqual(
            DECLARED_URL, _declared_url(self.client_file),
            "fixture sanity: a declared url is never overwritten")
        self.assert_does_not_warn(result)


# ===========================================================================
# The install's `[manifest]` row and its envelope
# ===========================================================================


class TheInstallRowAndEnvelopeNameTheUndeclaredBoardTest(_NoBoardCase):
    """Through `run_install`'s stage loop and `crucible-axi install`'s
    envelope, with the `[server]`, `[fleet]` and `[unit]` stages replaced by
    doubles and the real `[manifest]` stage handed the test's plan."""

    def stage_runners(self):
        return {
            install.SERVER_STAGE_NAME: _stub_stage,
            "fleet": _stub_stage,
            "manifest": manifest.run_manifest_stage,
            "unit": _stub_stage,
        }

    def manifest_row(self, stages):
        rows = [stage for stage in stages if stage["name"] == "manifest"]
        self.assertEqual(1, len(rows),
                         f"exactly one `[manifest]` row; the stages were "
                         f"{stages!r}")
        return rows[0]

    def run_install(self, plan):
        with mock.patch.object(install, "server_config_plan",
                               return_value=plan):
            ok, stages, warnings = install.run_install(
                self.target, stage_runners=self.stage_runners(),
                no_service=True)
        self.assertTrue(ok, f"fixture sanity: the install succeeds; the "
                            f"warnings were {warnings!r}")
        return stages

    def cli_install(self, plan):
        """Drive `crucible-axi install` in process; answer the
        `result_fields` the envelope was emitted with, and the printed
        envelope."""
        emitted = []
        load = cli._load_client_module
        client_install_dir = self.client_install_dir

        def load_isolated(name):
            module: Any = load(name)
            # The vendored module takes its own install dir from where its
            # file is: this checkout's root. Point it at an empty dir of this
            # test's root so no operator file is read.
            module._INSTALL_DIR = client_install_dir
            original_emit = module.emit_axi

            def recording_emit(*args, **kwargs):
                emitted.append(kwargs.get("result_fields"))
                return original_emit(*args, **kwargs)

            module.emit_axi = recording_emit
            return module

        buffer = io.StringIO()
        with (mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                              self.stage_runners()),
              mock.patch.object(install, "server_config_plan",
                                return_value=plan),
              mock.patch.object(cli, "_load_client_module", load_isolated),
              mock.patch.object(cli, "_stdin_is_interactive",
                                return_value=False),
              contextlib.redirect_stdout(buffer)):
            code = cli.main(["install", "--target-dir", self.target,
                             "--no-service"])
        printed = buffer.getvalue()
        self.assertEqual(0, code, f"fixture sanity: the install succeeds; "
                                  f"it printed {printed!r}")
        self.assertEqual(1, len(emitted),
                         "the install emits exactly one envelope")
        return emitted[0], printed

    def help_lines_naming_the_file(self, help_lines):
        return [line for line in help_lines
                if isinstance(line, str) and self.client_file in line]

    def test_the_install_row_of_a_fresh_install_with_no_local_server_carries_the_warning(self):
        stages = self.run_install(self.plan_without_server())

        row = self.manifest_row(stages)
        self.assertEqual(
            self.expected_warning(), row.get(WARNING_FIELD),
            f"the install's `[manifest]` row carries the stage's "
            f"`{WARNING_FIELD}` with the ABSOLUTE path; the row was {row!r}")

    def test_the_install_row_of_an_upgrade_with_no_local_server_carries_the_warning(self):
        self.place_client_file(OLDER_INSTALL_FILE)

        stages = self.run_install(self.plan_without_server())

        self.assertEqual(OLDER_INSTALL_FILE,
                         Path(self.client_file).read_bytes())
        row = self.manifest_row(stages)
        self.assertEqual(self.expected_warning(), row.get(WARNING_FIELD),
                         f"the row was {row!r}")

    def test_the_install_row_of_an_install_that_declares_a_board_carries_no_warning(self):
        stages = self.run_install(self.plan_with_listener())

        self.assertEqual(LISTENER_URL, _declared_url(self.client_file))
        row = self.manifest_row(stages)
        self.assertNotIn(WARNING_FIELD, row, f"the row was {row!r}")

    def test_the_envelope_help_names_the_file_and_the_key_when_no_board_is_declared(self):
        fields, printed = self.cli_install(self.plan_without_server())

        lines = self.help_lines_naming_the_file(fields.get("help", []))
        self.assertEqual(
            1, len(lines),
            f"exactly one help line names the client file "
            f"{self.client_file}; the help was {fields.get('help')!r}")
        self.assertIn(
            URL_KEY_LABEL, lines[0],
            f"the help line says to declare `{URL_KEY_LABEL}` in that file; "
            f"it was {lines[0]!r}")
        self.assertIn(self.client_file, printed,
                      "the printed envelope names the client file")

    def test_the_envelope_manifest_row_names_the_file_and_the_key_when_no_board_is_declared(self):
        fields, _printed = self.cli_install(self.plan_without_server())

        rows = [row for row in fields.get("stages", [])
                if row.get("name") == "manifest"]
        self.assertEqual(1, len(rows), f"the stages were {fields!r}")
        warning = rows[0].get(WARNING_FIELD)
        self.assertIsInstance(
            warning, dict,
            f"the printed `[manifest]` row carries `{WARNING_FIELD}`; the "
            f"row was {rows[0]!r}")
        assert isinstance(warning, dict)
        self.assertEqual(URL_KEY_LABEL, warning.get("key"))
        self.assertEqual(self.client_file, warning.get("path"))

    def test_the_envelope_names_no_undeclared_board_when_the_install_writes_the_url(self):
        fields, printed = self.cli_install(self.plan_with_listener())

        self.assertEqual(LISTENER_URL, _declared_url(self.client_file),
                         "fixture sanity: the install wrote the url")
        self.assertEqual(
            [], [line for line in fields.get("help", [])
                 if isinstance(line, str) and URL_KEY_LABEL in line],
            f"no help line asks for a url the file already declares; the "
            f"help was {fields.get('help')!r}")
        self.assertEqual(
            [], self.help_lines_naming_the_file(fields.get("help", [])),
            "no help line names the client file")
        for row in fields.get("stages", []):
            self.assertNotIn(WARNING_FIELD, row, f"the row was {row!r}")
        self.assertNotIn(WARNING_FIELD, printed)

    def test_the_envelope_names_no_undeclared_board_when_an_existing_file_declares_one(self):
        self.place_client_file(DECLARED_INSTALL_FILE)

        fields, printed = self.cli_install(self.plan_without_server())

        self.assertEqual(DECLARED_INSTALL_FILE,
                         Path(self.client_file).read_bytes())
        self.assertEqual(
            [], self.help_lines_naming_the_file(fields.get("help", [])),
            f"the help was {fields.get('help')!r}")
        self.assertNotIn(WARNING_FIELD, printed)


if __name__ == "__main__":
    unittest.main()
