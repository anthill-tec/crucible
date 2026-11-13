"""A re-install fills in the connection an older install never wrote, and
never overwrites one that is there.

An install laid down before the installer learnt to write the connection
left an operator-editable `crucible.toml` at the target dir with limits and
no `[client]` table, and a server file beside the database with no
`[server] port`. Every later install leaves those files alone, because laying
a file down never overwrites it. The clients of such a machine reach their
board only through the shipped literal, and the installer's own answer about
the board can disagree with the port the server boots on.

The rule pinned here:

* the `[manifest]` stage fills an ABSENT key -- `[client] url` in the install
  file, `[server] port` in the server file -- and nothing else. Every other
  byte of the file is kept, a CRLF file stays CRLF, and a key present with any
  value (empty, mistyped) is the operator's;
* a server file that exists and names no port takes the TEMPLATE's
  `[server] port`, the port that server boots on today. It is never
  re-probed, so the proof holds while that port is occupied;
* a file the fill cannot safely touch (it does not parse, it is a directory,
  the written file would not re-parse) is left byte-identical and reported
  under `notFilled`, and the install still succeeds;
* a fill makes the stage `converged: false` and is reported under
  `filled: [{path, key, value}]`; a second install changes nothing;
* a filled file is recorded as the install's own only when its bytes before
  the fill matched the install record; any other stays the operator's, and
  `uninstall --purge` keeps it.

Every case runs the REAL `[fleet]`, `[manifest]`, `[config]` and `[store]`
stages inside the sandbox `_InstallerConnectionCase` builds: a throwaway
`$HOME`, `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$BUN_INSTALL` and
`$CRUCIBLE_DB`, with `[server]` and `[unit]` stubbed. No service is
installed, and every port these tests declare or occupy is an ephemeral one
claimed from the kernel -- never the shipped window.
"""

import contextlib
import hashlib
import io
import os
import pwd
import re
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import load_toon
from tests.client.test_cr139_installer_writes_the_connection import (
    CLIENT_TABLE,
    LOOPBACK,
    PORT_KEY,
    SERVER_TABLE,
    URL_KEY,
    _InstallerConnectionCase,
    _table,
)

#: The operator's real home, read off the password database rather than off
#: `$HOME` (which the sandbox replaces). Nothing under it is ever opened: it
#: is only compared against, so a test can prove it is NOT installing there.
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir

#: An install `crucible.toml` in the shape an install laid down before the
#: installer wrote a board into it: commented limits, and no `[client]` table.
LIMITS_ONLY_INSTALL_FILE = (
    "# Crucible CLIENT limits -- the file you edit.\n"
    "#\n"
    "# Laid down by an install that wrote no board into it.\n"
    "\n"
    "[limits.truncate_field_chars]\n"
    "description = \"Visible characters of a long text field.\"\n"
    "recommended = 200\n"
    "min = 20\n"
    "max = 4000\n"
    "\n"
    "[limits.roadmap_list_rows]\n"
    "description = \"Rows of a roadmap list emitted before it is truncated.\"\n"
    "recommended = 20\n"
    "min = 5\n"
    "max = 500\n"
)

#: A server file that exists and names no port: limits only.
PORTLESS_SERVER_FILE = (
    "# placed by an older install: limits only, and no connection at all\n"
    "[limits.roadmap_list_rows]\n"
    "value = 5\n"
)


def _server_file_naming(port):
    """A server file that already names its listener."""
    return (
        "# an operator's server file, naming its own listener\n"
        "[server]\n"
        f"host = \"{LOOPBACK}\"\n"
        f"port = {port:d}\n"
        "\n"
        "[limits.roadmap_list_rows]\n"
        "value = 5\n")


def _url(port):
    """The board URL a client posts to for a loopback listener on `port`."""
    return f"http://{LOOPBACK}:{port:d}"


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _parses(data):
    try:
        tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return False
    return True


class _FillCase(_InstallerConnectionCase):
    """The installer sandbox, plus the files an older install left behind."""

    def setUp(self):
        super().setUp()
        self.assertNotEqual(
            os.path.realpath(REAL_HOME), os.path.realpath(os.environ["HOME"]),
            "fixture sanity: an install under test must never run in the "
            "operator's real home")
        self.assertEqual(
            self.fake_home, os.environ["HOME"],
            "fixture sanity: the sandbox must pin $HOME itself")

    # -- the machine ------------------------------------------------------

    def provision(self):
        """Provision a server whose template declares a two-port range and a
        `port` OUTSIDE it, all ephemeral. A probe answers the range's first
        port; only the template's own `port` is the live one."""
        ports = self.consecutive_ports(3)
        self.provision_server(range_min=ports[0], range_max=ports[1],
                              port=ports[2])
        self.probed_port = ports[0]
        self.template_port = ports[2]
        self.assertEqual(
            self.template_port, _table(self.template, SERVER_TABLE).get(PORT_KEY),
            "fixture sanity: the provisioned template must declare its port")
        return self.template_port

    def other_port(self):
        """One more ephemeral port, distinct from every port the template
        declares."""
        taken = {self.probed_port, self.probed_port + 1, self.template_port}
        for _attempt in range(16):
            port = self.consecutive_ports(1)[0]
            if port not in taken:
                return port
        self.fail(f"fixture sanity: could not claim a port distinct from {sorted(taken)!r}")

    def place(self, path, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_bytes(data)
        return data

    def place_install_file(self, data=LIMITS_ONLY_INSTALL_FILE):
        return self.place(self.install_config, data)

    def place_server_file(self, data):
        return self.place(self.server_config, data)

    # -- the stage row ----------------------------------------------------

    def manifest_row(self, stages):
        return self.stage_row(stages, "manifest")

    def entries(self, row, field):
        entries = row.get(field)
        if entries is None:
            return []
        self.assertIsInstance(
            entries, list,
            f"`{field}` on the [manifest] stage row is a list of {{path, key, ...}}; "
            f"got {entries!r}")
        return entries

    def entries_for(self, row, field, path):
        return [entry for entry in self.entries(row, field)
                if isinstance(entry, dict) and entry.get("path") == path]

    def assert_names_key(self, entry, table, key):
        self.assertIn(
            entry.get("key"), (key, f"{table}.{key}",
                               f"[{table}] {key}"),
            f"the entry must name the key it is about, `{key}` of `[{table}]`; got {entry!r}")

    def single_entry(self, row, field, path, table, key):
        entries = self.entries_for(row, field, path)
        self.assertEqual(
            1, len(entries),
            f"exactly one `{field}` entry must name {path}; the [manifest] row is {row!r}")
        self.assert_names_key(entries[0], table, key)
        return entries[0]


# ===========================================================================
# The install file gains the board it never had
# ===========================================================================

class AReinstallFillsAMissingClientUrlTest(_FillCase):

    def test_an_install_file_with_limits_and_no_client_table_gains_the_listener_url_under_its_comment_block(self):
        """An existing install file with limits and no `[client]` gains
        `[client] url = <listener url>` under the commented block a fresh file
        gets. Every byte it had before is kept, as its prefix."""
        self.provision()
        named = self.other_port()
        server_before = self.place_server_file(_server_file_naming(named))
        before = self.place_install_file()

        self.install_once()

        after = Path(self.install_config).read_bytes()
        self.assertEqual(
            _url(named), _table(self.install_config, CLIENT_TABLE).get(URL_KEY),
            "an install file that declares no `[client] url` must gain the "
            "url of the listener the install resolved, {}; the file now reads "
            "{!r}".format(_url(named), after.decode("utf-8")))
        self.assertEqual(
            before, after[:len(before)],
            "every byte the operator's file had must be kept: the fill only "
            "appends. The file now reads {!r}".format(after.decode("utf-8")))
        added = after[len(before):].decode("utf-8")
        block = self.manifest._CLIENT_TABLE_BLOCK
        self.assertTrue(
            added.lstrip("\n").startswith(block.lstrip("\n")),
            "the `[client]` table must arrive under the same commented block "
            f"a freshly laid-down file gets, {block!r}; the fill appended {added!r}")
        self.assertEqual(
            {CLIENT_TABLE: {URL_KEY: _url(named)}}, tomllib.loads(added),
            "the fill must append the `[client]` table and nothing else; it "
            f"appended {added!r}")
        self.assertEqual(
            server_before, Path(self.server_config).read_bytes(),
            "a server file that already names its port is not touched")

    def test_the_run_that_fills_reports_the_file_key_and_value_and_does_not_converge(self):
        """The filling run's `[manifest]` stage is `converged: false` and its
        row names the file, the key and the value under `filled`.

        Staged so the fill is the ONLY thing the run writes: a first install
        lays everything down and publishes the manifest, then the install
        file is put back in the shape an older install left it in."""
        self.provision()
        self.install_once()
        listener = self.written_listener()
        before = self.place_install_file()

        stages = self.install_once()

        row = self.manifest_row(stages)
        entry = self.single_entry(row, "filled", self.install_config,
                                  CLIENT_TABLE, URL_KEY)
        self.assertEqual(
            _url(listener), entry.get("value"),
            f"the `filled` entry must name the value written; got {entry!r}")
        self.assertIs(
            False, row.get("converged"),
            "a run that filled a file wrote something, so its [manifest] "
            f"stage must not report convergence; the row is {row!r}")
        self.assertNotEqual(
            before, Path(self.install_config).read_bytes(),
            "the run reported a fill, so the file must have changed")
        self.assertEqual(
            [], self.entries(row, "notFilled"),
            "nothing was refused, so no `notFilled` entry is owed; the row is "
            f"{row!r}")

    def test_a_second_install_changes_nothing_and_converges(self):
        """Once filled, a re-install finds the key present: the file is
        byte-identical, the stage converges, and `filled` is absent."""
        self.provision()
        self.install_once()
        self.place_install_file()
        first = self.manifest_row(self.install_once())
        self.assertEqual(
            1, len(self.entries_for(first, "filled", self.install_config)),
            "the run after the file lost its `[client]` table must fill it; "
            f"its [manifest] row is {first!r}")
        filled = Path(self.install_config).read_bytes()
        server_filled = Path(self.server_config).read_bytes()

        row = self.manifest_row(self.install_once())

        self.assertEqual(
            filled, Path(self.install_config).read_bytes(),
            "a second install must not touch a file whose `url` is now there")
        self.assertEqual(
            server_filled, Path(self.server_config).read_bytes(),
            "a second install must not touch the server file either")
        self.assertIs(
            True, row.get("converged"),
            f"a second install that wrote nothing must converge; the row is {row!r}")
        self.assertNotIn(
            "filled", row,
            f"`filled` is omitted when nothing was filled; the row is {row!r}")
        self.assertNotIn(
            "notFilled", row,
            f"`notFilled` is omitted when nothing was refused; the row is {row!r}")

    def test_a_crlf_install_file_stays_crlf_after_the_fill(self):
        """A file with CRLF line endings keeps them: its own bytes are kept
        as the prefix, and nothing the fill adds ends a line with a bare LF."""
        self.provision()
        named = self.other_port()
        self.place_server_file(_server_file_naming(named))
        before = self.place_install_file(
            LIMITS_ONLY_INSTALL_FILE.replace("\n", "\r\n"))

        self.install_once()

        after = Path(self.install_config).read_bytes()
        self.assertEqual(
            _url(named), _table(self.install_config, CLIENT_TABLE).get(URL_KEY),
            f"the CRLF install file must be filled like any other; it reads {after!r}")
        self.assertEqual(
            before, after[:len(before)],
            "every CRLF byte the operator's file had must be kept; the file "
            f"now reads {after!r}")
        self.assertIsNone(
            re.search(rb"(?<!\r)\n", after),
            "a CRLF file must stay CRLF: the filled file carries a bare LF; "
            f"it reads {after!r}")


# ===========================================================================
# What the fill cannot safely touch is left alone, and said
# ===========================================================================

class AFileTheFillCannotSafelyTouchIsReportedNotFilledTest(_FillCase):

    def install_and_expect_not_filled(self):
        stages = self.install_once()
        row = self.manifest_row(stages)
        entry = self.single_entry(row, "notFilled", self.install_config,
                                  CLIENT_TABLE, URL_KEY)
        reason = entry.get("reason")
        self.assertIsInstance(
            reason, str, f"a `notFilled` entry names its reason; got {entry!r}")
        self.assertTrue(
            str(reason).strip(),
            f"a `notFilled` entry names its reason; got {entry!r}")
        self.assertEqual(
            [], self.entries_for(row, "filled", self.install_config),
            "a file reported as not filled must not also be reported filled; "
            f"the row is {row!r}")
        return row

    def test_an_install_file_that_does_not_parse_is_left_byte_identical_and_reported(self):
        self.provision()
        self.place_server_file(_server_file_naming(self.other_port()))
        before = self.place_install_file(
            LIMITS_ONLY_INSTALL_FILE + "\n[limits.error_detail_chars\nmin = 1\n")
        self.assertFalse(_parses(before),
                         "fixture sanity: this install file must not parse")

        self.install_and_expect_not_filled()

        self.assertEqual(
            before, Path(self.install_config).read_bytes(),
            "a file that does not parse is not the fill's to touch")

    def test_a_directory_at_the_install_file_path_is_left_alone_and_reported(self):
        self.provision()
        self.place_server_file(_server_file_naming(self.other_port()))
        os.makedirs(self.install_config)
        inside = os.path.join(self.install_config, "kept")
        Path(inside).write_bytes(b"an operator's own file\n")

        self.install_and_expect_not_filled()

        self.assertTrue(
            os.path.isdir(self.install_config),
            "a directory at the install file's path must stay a directory")
        self.assertEqual(
            ["kept"], sorted(os.listdir(self.install_config)),
            "nothing may be written into a directory at the install file's "
            "path")
        self.assertEqual(b"an operator's own file\n",
                         Path(inside).read_bytes())

    def test_a_fill_that_would_not_reparse_is_undone_and_reported(self):
        """A `[client]  # note` header parses, but the line rewriter does not
        recognise it, so a fill would append a second `[client]` table. The
        written file no longer parses, so the original bytes come back."""
        self.provision()
        self.place_server_file(_server_file_naming(self.other_port()))
        before = self.place_install_file(
            LIMITS_ONLY_INSTALL_FILE + "\n[client]  # note\n")
        self.assertTrue(_parses(before),
                        "fixture sanity: this install file must parse")
        self.assertNotIn(
            URL_KEY, _table(self.install_config, CLIENT_TABLE),
            "fixture sanity: its `[client]` table must declare no url")

        self.install_and_expect_not_filled()

        self.assertEqual(
            before, Path(self.install_config).read_bytes(),
            "a fill whose written file would not re-parse must restore the "
            "original bytes")


# ===========================================================================
# A key present in any form is the operator's
# ===========================================================================

class ASetUrlIsNeverOverwrittenTest(_FillCase):
    """Each case is a run that DID fill (the port-less server file gains the
    template's port), so the url left alone is a rule and not an installer
    that filled nothing."""

    def assert_url_left_alone_while_the_server_port_is_filled(self, url_line):
        self.provision()
        self.place_server_file(PORTLESS_SERVER_FILE)
        before = self.place_install_file(
            LIMITS_ONLY_INSTALL_FILE + "\n[client]\n" + url_line + "\n")
        self.assertIn(URL_KEY, _table(self.install_config, CLIENT_TABLE),
                      "fixture sanity: the install file must declare a url")

        stages = self.install_once()

        row = self.manifest_row(stages)
        self.assertEqual(
            before, Path(self.install_config).read_bytes(),
            "a `url` present in the install file is the operator's, whatever "
            "its value, and must be byte-identical after install")
        self.assertEqual(
            [], self.entries_for(row, "filled", self.install_config),
            f"a present `url` is not filled; the row is {row!r}")
        self.assertEqual(
            self.template_port,
            _table(self.server_config, SERVER_TABLE).get(PORT_KEY),
            "the same run must fill the port-less server file with the "
            f"template's port {self.template_port:d}; it reads "
            f"{Path(self.server_config).read_text(encoding='utf-8')!r}")

    def test_a_declared_url_is_byte_identical_after_an_install_that_filled_the_server_port(self):
        self.assert_url_left_alone_while_the_server_port_is_filled(
            'url = "http://board.example.invalid:4321"')

    def test_an_empty_url_is_left_alone(self):
        self.assert_url_left_alone_while_the_server_port_is_filled('url = ""')

    def test_a_non_string_url_is_left_alone(self):
        self.assert_url_left_alone_while_the_server_port_is_filled('url = 4321')


# ===========================================================================
# The live port is kept
# ===========================================================================

class TheLivePortIsKeptTest(_FillCase):

    def test_a_server_file_naming_no_port_takes_the_templates_port_even_while_it_is_occupied(self):
        """The template's `port` is the port the server boots on today. It is
        written without a probe: this test holds that port with a listening
        socket of its own, which a probe would skip for the next one."""
        ports = self.consecutive_ports(2)
        self.provision_server(range_min=ports[0], range_max=ports[1],
                              port=ports[0])
        self.occupy(ports[0], listening=True)
        server_before = self.place_server_file(PORTLESS_SERVER_FILE)
        self.place_install_file()

        stages = self.install_once()

        server_after = Path(self.server_config).read_bytes()
        self.assertEqual(
            ports[0], _table(self.server_config, SERVER_TABLE).get(PORT_KEY),
            "a server file that names no port must get the template's port "
            f"{ports[0]:d}, the one its server boots on, with no probe -- a "
            f"probe skips it because it is occupied, and lands on "
            f"{ports[1]:d}. The file reads {server_after.decode('utf-8')!r}")
        self.assertEqual(
            server_before, server_after[:len(server_before)],
            "every byte the server file had must be kept; it reads "
            f"{server_after.decode('utf-8')!r}")
        self.assertEqual(
            _url(ports[0]),
            _table(self.install_config, CLIENT_TABLE).get(URL_KEY),
            "the install file's url must name the same port the server file "
            "now names")
        row = self.manifest_row(stages)
        entry = self.single_entry(row, "filled", self.server_config,
                                  SERVER_TABLE, PORT_KEY)
        self.assertIn(
            entry.get("value"), (ports[0], str(ports[0])),
            f"the output must name the port written, {ports[0]:d}; got "
            f"{entry!r}")
        url_entry = self.single_entry(row, "filled", self.install_config,
                                      CLIENT_TABLE, URL_KEY)
        self.assertEqual(_url(ports[0]), url_entry.get("value"))

    def test_a_template_declaring_no_port_gives_no_listener_and_fills_nothing(self):
        self.provision()
        template = Path(str(self.template))
        text = template.read_text(encoding="utf-8")
        stripped = re.sub(rf"(?m)^{PORT_KEY} = \d+\n", "", text)
        template.write_text(stripped, encoding="utf-8")
        self.assertNotIn(
            PORT_KEY, _table(self.template, SERVER_TABLE),
            "fixture sanity: the template must declare no port")
        server_before = self.place_server_file(PORTLESS_SERVER_FILE)
        install_before = self.place_install_file()

        plan = self.install.server_config_plan()
        self.assertNotIn(
            "listener", plan,
            "a server file naming no port takes the template's port, and a "
            "template naming none gives no listener at all -- never a probed "
            f"one; the plan is {plan!r}")

        stages = self.install_once()

        self.assertEqual(server_before, Path(self.server_config).read_bytes(),
                         "with no listener, the server file is not filled")
        self.assertEqual(install_before,
                         Path(self.install_config).read_bytes(),
                         "with no listener, the install file is not filled")
        self.assertNotIn("filled", self.manifest_row(stages))

    def test_a_mistyped_port_string_is_left_as_it_is(self):
        """`port = "3850"` is present, so it is the operator's: the file is
        byte-identical after install and no fill names it. Nothing here binds
        or probes that number -- it is a string in a scratch file."""
        self.provision()
        before = self.place_server_file(
            "[server]\nport = \"3850\"\n\n[limits.roadmap_list_rows]\n"
            "value = 5\n")

        stages = self.install_once()

        self.assertEqual(
            before, Path(self.server_config).read_bytes(),
            "a `port` present with a mistyped value is the operator's and "
            "must be left as it is")
        self.assertEqual(
            [], self.entries_for(self.manifest_row(stages), "filled",
                                 self.server_config),
            "a present `port` is never reported filled")


# ===========================================================================
# A `serve --port` that lands first wins
# ===========================================================================

class AServeThatLandsFirstWinsTest(_FillCase):
    """The race window is between the read that decides the listener and the
    stage's write. The seam is `install.server_config_plan`, the call that
    reads the server file and hands its decision to `[manifest]`: right after
    it returns, `write_listener_settings` -- what `crucible-axi serve --port`
    runs -- writes a port of its own into the same file."""

    def test_a_port_written_after_the_plan_read_the_file_is_not_overwritten(self):
        self.provision()
        self.place_server_file(PORTLESS_SERVER_FILE)
        served = self.other_port()
        real_plan = self.install.server_config_plan
        seen = {}

        def plan_then_serve():
            plan = real_plan()
            seen["listener"] = plan.get("listener")
            self.install.write_listener_settings(port=served)
            seen["raced"] = Path(self.server_config).read_bytes()
            return plan

        with mock.patch.object(self.install, "server_config_plan",
                               plan_then_serve):
            stages = self.install_once()

        self.assertIn("raced", seen,
                      "fixture sanity: the race must have been staged")
        self.assertEqual(
            self.template_port, (seen["listener"] or {}).get("port"),
            "the plan read a port-less server file, so it must have decided "
            f"the template's port {self.template_port:d} -- the value the "
            "stage would write if it did not look again; it decided "
            f"{seen['listener']!r}")
        self.assertEqual(
            served, _table(self.server_config, SERVER_TABLE).get(PORT_KEY),
            "the port `serve --port` wrote after the plan read the file must "
            "win; the file reads "
            f"{Path(self.server_config).read_text(encoding='utf-8')!r}")
        self.assertEqual(
            seen["raced"], Path(self.server_config).read_bytes(),
            "the stage must re-read the file and write only while the key is "
            "still absent, so the file is exactly what `serve` left")
        self.assertEqual(
            [], self.entries_for(self.manifest_row(stages), "filled",
                                 self.server_config),
            "a fill that was skipped is not reported as filled")


# ===========================================================================
# The install record
# ===========================================================================

class AFilledFileIsRecordedOnlyWhenItWasTheInstallsOwnTest(_FillCase):

    def recorded(self):
        return self.manifest.recorded_config_digests(self.target_dir)

    def config_row(self, stages):
        return self.stage_row(stages, "config")

    def fill_install_file_over(self, record):
        """Place the limits-only install file, record `record` for it (or
        nothing), install, and return the bytes after the fill."""
        self.provision()
        named = self.other_port()
        self.place_server_file(_server_file_naming(named))
        before = self.place_install_file()
        self.assertTrue(os.path.isdir(self.target_dir),
                        "fixture sanity: the target dir holds the record")
        if record is not None:
            self.manifest.record_configs(self.target_dir,
                                         {self.install_config: record(before)})
        self.install_once()
        after = Path(self.install_config).read_bytes()
        self.assertEqual(
            _url(named), _table(self.install_config, CLIENT_TABLE).get(URL_KEY),
            "the install file must be filled before its record can be asked "
            f"about; it reads {after.decode('utf-8')!r}")
        return after

    def test_a_filled_install_file_that_matched_its_record_is_re_recorded_and_purged(self):
        after = self.fill_install_file_over(lambda before: before)

        self.assertEqual(
            _digest(after), self.recorded().get(self.install_config),
            "the file was the install's own and unedited, so its new bytes "
            f"must be recorded; the record is {self.recorded()!r}")
        self.run_uninstall(purge=True)
        self.assertFalse(
            os.path.lexists(self.install_config),
            "a re-recorded file is still the install's own, so a purge "
            "removes it")

    def test_a_filled_server_file_that_matched_its_record_is_re_recorded_and_purged(self):
        self.provision()
        before = self.place_server_file(PORTLESS_SERVER_FILE)
        os.makedirs(self.target_dir, exist_ok=True)
        self.manifest.record_configs(self.target_dir,
                                     {self.server_config: before})

        self.install_once()

        after = Path(self.server_config).read_bytes()
        self.assertEqual(
            self.template_port,
            _table(self.server_config, SERVER_TABLE).get(PORT_KEY),
            "the port-less server file must be filled with the template's "
            f"port; it reads {after.decode('utf-8')!r}")
        self.assertEqual(
            _digest(after), self.recorded().get(self.server_config),
            "the server file was the install's own and unedited, so its new "
            f"bytes must be recorded; the record is {self.recorded()!r}")
        self.run_uninstall(purge=True)
        self.assertFalse(
            os.path.lexists(self.server_config),
            "a re-recorded server file is still the install's own, so a "
            "purge removes it")

    def test_a_filled_file_with_no_record_is_not_recorded_and_purge_keeps_it(self):
        after = self.fill_install_file_over(None)

        self.assertNotIn(
            self.install_config, self.recorded(),
            "a file the install has no record of is the operator's, filled or "
            f"not; the record is {self.recorded()!r}")
        stages = self.run_uninstall(purge=True)
        self.assertEqual(
            after, Path(self.install_config).read_bytes(),
            "`uninstall --purge` must keep the operator's filled file")
        self.assertTrue(self.config_row(stages).get("retained"),
                        "a purge that kept a file says so")

    def test_a_filled_file_whose_record_did_not_match_is_not_re_recorded_and_purge_keeps_it(self):
        earlier = b"the bytes an earlier install laid down\n"
        after = self.fill_install_file_over(lambda _before: earlier)

        self.assertNotEqual(
            _digest(after), self.recorded().get(self.install_config),
            "the file had been edited since the install recorded it, so it "
            "is the operator's and its filled bytes must not be recorded")
        stages = self.run_uninstall(purge=True)
        self.assertEqual(
            after, Path(self.install_config).read_bytes(),
            "`uninstall --purge` must keep the operator's filled file")
        self.assertTrue(self.config_row(stages).get("retained"),
                        "a purge that kept a file says so")


# ===========================================================================
# The real install output
# ===========================================================================

class TheInstallOutputNamesWhatItFilledTest(_FillCase):

    def test_crucible_axi_install_names_each_filled_file_its_key_and_its_value(self):
        """`crucible-axi install --no-service` through the real console entry
        point, in the sandbox: its envelope's [manifest] row names the filled
        install file with its key and url, and the filled server file with
        its key and port."""
        self.provision()
        self.place_server_file(PORTLESS_SERVER_FILE)
        self.place_install_file()
        self.assertNotEqual(
            os.path.realpath(REAL_HOME), os.path.realpath(os.environ["HOME"]),
            "the CLI must not run in the operator's real home")
        self.assertEqual(
            os.path.realpath(self.root),
            os.path.commonpath([os.path.realpath(self.root),
                                os.path.realpath(os.environ["HOME"])]),
            "the CLI's $HOME must be inside this test's own root")

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             self._stubs(self.install.DEFAULT_STAGE_RUNNERS)), \
                mock.patch("sys.stdin", io.StringIO("")), \
                contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            code = self.cli.main(["install", "--target-dir", self.target_dir,
                                  "--no-service"])

        self.assertEqual(
            0, code,
            f"the install must succeed; stdout={out.getvalue()!r} "
            f"stderr={err.getvalue()!r}")
        envelope = load_toon().decode(out.getvalue())["axi"]
        rows = [stage for stage in envelope.get("stages", [])
                if isinstance(stage, dict) and stage.get("name") == "manifest"]
        self.assertEqual(1, len(rows), f"one [manifest] row; got {envelope!r}")
        row = rows[0]
        url_entry = self.single_entry(row, "filled", self.install_config,
                                      CLIENT_TABLE, URL_KEY)
        self.assertEqual(
            _url(self.template_port), url_entry.get("value"),
            "the output must name the url written into the install file; the "
            f"envelope reads {out.getvalue()!r}")
        port_entry = self.single_entry(row, "filled", self.server_config,
                                       SERVER_TABLE, PORT_KEY)
        self.assertIn(
            port_entry.get("value"), (self.template_port,
                                      str(self.template_port)),
            "the output must name the port written into the server file; the "
            f"envelope reads {out.getvalue()!r}")


if __name__ == "__main__":
    unittest.main()
