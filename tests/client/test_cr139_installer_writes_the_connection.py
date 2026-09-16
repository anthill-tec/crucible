"""CR-CRU-139 §S1a -- the INSTALLER discovers the connection and WRITES it.

Today nothing decides which port a Crucible listens on except an export. The
installer lays two operator-editable `crucible.toml` files down (CR-CRU-138 §S2
beside the database, §S4 beside the fleet) and writes no connection into either,
so a machine that already carries a production instance can only be told about
the second one through `$CRUCIBLE_PORT` -- the exact environment layer this CR
retires. §S1a closes that: the install PROBES the range the server's own file
declares, takes the first port it can BIND, and writes that one value into the
server file's `[server]` table and the fleet's `[client] url`.

-- What each class asserts ------------------------------------------------

`TheInstallWritesTheResolvedConnectionIntoTheFilesItLaysDownTest` -- the write,
asserted by READING the files a real install left behind (never the installer's
own output envelope): the server file names the probed port, the client file's
`[client] url` names the SAME one, and the chosen port lies inside the bounds
THAT FILE declares (CR-CRU-134's derivation rule -- the expectation is read back
off the file, never retyped).

`TheProbeBindsRatherThanConnectsTest` -- both shapes of the same rule, because
only the pair distinguishes a bind from a connect: a LISTENER on the first port
of the range makes the install take the next (a connect-based probe passes this
too), and a socket BOUND BUT NOT LISTENING makes it take the next as well (a
connect-based probe hands out that port, because nothing answers).

`TheRangeIsReadFromTheResolvedServerConfigFileTest` -- the range is DATA, not a
constant in the installer: a template declaring its own two bounds gets an
install that probes THOSE, outside the shipped 3800-3899 window entirely. This
is also what makes exhaustion testable without occupying a hundred real ports,
and it is why no test in this file binds anything in the shipped window -- a
development board is live in it while these tests run.

`RangeExhaustionStopsTheInstallAndAsksTest` -- exhaustion PROMPTS (interactive),
naming the range and what occupies it; a NON-interactive run cannot prompt so it
fails definitively with the SAME message; and neither ever drifts outside the
range or falls back to the shipped default.

`AConfiguredPortIsNeverReProbedTest` -- a re-install USES the port the file
already names, even while an instance is listening on it. Renumbering a running
instance orphans every client whose file names the old port.

`TheManifestRecordsTheBytesTheInstallWroteTest` -- the ruling that makes the
write safe. `_operator_config_is_untouched` (crucible_axi/install.py:1300-1326)
compares a file the install AUTHORED against the `[manifest]` stage's recording
of what it wrote, not against the shipped template: without that, every machine
that ever probed a port would read as operator-edited forever and CR-CRU-138
§S2/§S3's purge convergence would go false with no operator involved. A file
with NO recording (an older install, or one placed by hand) still falls back to
the template comparison, so the fail-safe direction is unchanged.

`TheUnitCarriesNoListenerEnvironmentTest` -- `_unit_environment()`
(install.py:863-879) stops forwarding `CRUCIBLE_PORT`/`CRUCIBLE_HOST`; the unit
boots the server and the server reads its own file. `CRUCIBLE_DB` STAYS (§S3 --
the store path is how the server FINDS that file, so it precedes it).

HOW EACH FAILS IF THE CODE DOES NOTHING (this is a RED suite):

  * `src/crucible.toml` declares no `[server]` table at all, so the shipped-range
    test fails on the missing table.
  * The install copies its two templates verbatim and writes no connection into
    either, so every write/probe/range assertion fails reading a file with no
    `[server] port` and no `[client] url`.
  * Nothing probes, so nothing can be exhausted: the exhaustion tests fail on an
    install that cheerfully succeeds with every port in its declared range
    occupied, prompting nobody.
  * `[manifest]` records nothing, so the recording tests fail -- (1) and the
    convergence regression fail because a file with a probed port written into
    it cannot even be produced yet.
  * `_unit_environment()` still forwards all three variables, so the unit test
    fails naming the two that must be gone.

Safety -- this suite runs a REAL installer and binds REAL sockets:

One `tempfile.mkdtemp` root per test holds the scratch `$HOME`,
`$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$BUN_INSTALL`, `$CRUCIBLE_DB` and the
`--target-dir`; `setUp` ASSERTS that the store directory the installer computes
falls inside that root before any test writes a byte. `[server]` (which really
runs `bun add -g`) and `[unit]` (which really drives `systemctl --user`) are
stubbed in both directions; `[fleet]`, `[manifest]`, `[config]` and `[store]`
run for real -- that is the point. Every port this file binds is one it CLAIMED
itself from the kernel's ephemeral range and holds for the duration of the test:
no test binds, probes or frees a port in the shipped 3800-3899 window, which is
occupied by a live development board on this workstation.

Invocation:
    python3 -m unittest tests.client.test_cr139_installer_writes_the_connection -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import contextlib
import difflib
import importlib
import io
import json
import os
import shutil
import socket
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_NAME = "crucible.toml"

#: The two shipped templates, in the checkout. The SERVER's is the one whose
#: `[server]` table declares the range; the installer copies it out of the
#: PROVISIONED package (`_provisioned_server_config_source()`), which is what
#: lets a test declare its own bounds without an environment knob.
SHIPPED_SERVER_DATA = REPO_ROOT / "src" / CONFIG_NAME
SHIPPED_CLIENT_DATA = REPO_ROOT / "clients" / CONFIG_NAME

#: The `[server]` table §S1 adds, and the flat keys it carries -- agreed with
#: the §S1 (server-side) suite so one GREEN satisfies both files.
SERVER_TABLE = "server"
HOST_KEY = "host"
PORT_KEY = "port"
RANGE_MIN_KEY = "port_range_min"
RANGE_MAX_KEY = "port_range_max"

#: The `[client]` table §S2 adds to the fleet's own file, and the key the
#: install writes the SAME resolved listener into, so one install's two files
#: cannot disagree.
CLIENT_TABLE = "client"
URL_KEY = "url"

#: §S1a: "a hundred ports in the 3000s around the `3849` this project has
#: always used". Pinned here ONCE, as the shipped declaration's own value --
#: every other expectation in this file is read back off a file.
SHIPPED_RANGE_MIN = 3800
SHIPPED_RANGE_MAX = 3899

#: What the fixture's own provisioned template declares as its `port` while the
#: shipped file does not yet carry a `[server]` table to read one from. It is
#: deliberately OUTSIDE every narrow range this file declares, so "the install
#: fell back to the shipped default" is distinguishable from "the install
#: probed".
_TEMPLATE_DEFAULT_PORT = 3849

LOOPBACK = "127.0.0.1"

#: Words that describe a port being unavailable -- the prompt must say what
#: OCCUPIES the range, not merely restate the bounds.
_OCCUPANCY_WORDS = ("occupi", "in use", "bound", "taken", "busy", "listening",
                    "unavailable")


# ===========================================================================
# Reading facts off real files
# ===========================================================================

def _tables(path):
    """The parsed TOML document at `path`, or `{}` when it is absent or does
    not parse -- stdlib `tomllib`, so every expectation below is a fact about
    the FILE rather than about a string a test just wrote."""
    try:
        with open(path, "rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _table(path, name):
    table = _tables(path).get(name)
    return table if isinstance(table, dict) else {}


def _declared_range(path):
    """`(min, max)` as the file at `path` declares them, or `(None, None)`.

    CR-CRU-134's rule: a test asserting "inside the range" reads the bounds
    back off the file the installer resolved, never off a retyped pair.
    """
    table = _table(path, SERVER_TABLE)
    return table.get(RANGE_MIN_KEY), table.get(RANGE_MAX_KEY)


def _url_port(url):
    try:
        return urlsplit(url).port
    except ValueError:
        return None


def _normalized(text):
    """Whitespace-collapsed text, so a message compared across two renderings
    (a terminal prompt, a TOON envelope's warning detail) is compared on its
    words rather than on where each one happened to wrap."""
    return " ".join(str(text).split())


def _longest_common_fragment(first, second):
    first, second = _normalized(first), _normalized(second)
    match = difflib.SequenceMatcher(
        None, first, second, autojunk=False).find_longest_match(
            0, len(first), 0, len(second))
    return first[match.a:match.a + match.size]


# ===========================================================================
# Ports this suite OWNS -- never a number out of the shipped window
# ===========================================================================

def _claim_consecutive_ports(count, attempts=64):
    """`count` CONSECUTIVE loopback ports, claimed from the kernel and then
    released.

    A range is a span, so a test that declares one needs adjacent numbers; the
    kernel hands out ephemeral ports one at a time, so the span is found by
    asking for a base and then binding its neighbours. Everything here stays in
    the EPHEMERAL range: the shipped 3800-3899 window carries a live board on a
    development workstation, and this suite must never bind, free or renumber
    anything in it.
    """
    for _attempt in range(attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((LOOPBACK, 0))
            base = probe.getsockname()[1]
        if base + count - 1 > 65535:
            continue
        held = []
        for offset in range(count):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock.bind((LOOPBACK, base + offset))
            except OSError:
                sock.close()
                break
            held.append(sock)
        ports = [base + offset for offset in range(len(held))]
        for sock in held:
            sock.close()
        if len(ports) == count:
            return ports
    raise AssertionError(
        "could not claim %d consecutive free loopback ports in %d attempts -- "
        "this suite refuses to fall back to a hardcoded window, because the "
        "shipped 3800-3899 one carries a live board" % (count, attempts))


def _without_server_table(text):
    """`text` with any `[server]` table removed, stripped on TABLE-HEADER
    boundaries (the header, up to the next header of any depth).

    §S1 now SHIPS a `[server]` table in `src/crucible.toml`, and this fixture
    needs its OWN bounds in the provisioned template -- that is the whole point
    of `TheRangeIsReadFromTheResolvedServerConfigFileTest`: the installer must
    probe the range the RESOLVED file declares rather than a constant. So the
    template REPLACES the shipped table instead of appending a second one,
    which is not merely untidy but invalid TOML (`Cannot declare ('server',)
    twice`) and would leave every read-back helper below answering `{}`.

    Boundaries rather than a truncate because the shipped table sits BEFORE the
    `[limits.*]` tables: cutting to the end of the file would silently drop the
    limit declarations and leave this suite testing a template that no longer
    resembles the product.
    """
    kept, skipping = [], False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped == "[%s]" % (SERVER_TABLE,):
            skipping = True
            continue
        if skipping:
            if stripped.startswith("[") and stripped.endswith("]"):
                skipping = False
            else:
                continue
        kept.append(line)
    return "\n".join(kept)


def _server_table_text(*, host, port, range_min, range_max):
    """A `[server]` table for a provisioned template, in the shipped file's own
    commented style, REPLACING the shipped one (see `_without_server_table`);
    the KEYS are the ones the §S1 suite pins, so one GREEN satisfies both."""
    return (
        "\n[server]\n"
        "# The address this server binds. Loopback keeps a board private to\n"
        "# the machine that runs it.\n"
        "host = \"%s\"\n"
        "# The port this server listens on. The INSTALLER writes this value,\n"
        "# probed out of the range below; an operator may edit it afterwards.\n"
        "port = %d\n"
        "# The range this project may occupy. The install probes it, takes the\n"
        "# first port it can BIND, and never drifts outside these bounds.\n"
        "%s = %d\n"
        "%s = %d\n"
        % (host, port, RANGE_MIN_KEY, range_min, RANGE_MAX_KEY, range_max))


class _TtyStdin(io.StringIO):
    """A stdin that claims to be a terminal -- the seam the installer's existing
    interactive/non-interactive split reads (`cli._stdin_is_interactive` asks
    `sys.stdin.isatty()`, which is how the destructive-purge prompt already
    decides whether it may ask)."""

    def isatty(self):
        return True


def _stub_stage(name):
    """A stage runner that does nothing and reports a converged row -- the
    shape `run_install`/`run_uninstall` expect from a real one."""

    def _runner(target_dir, _switch=False, **_kwargs):
        return {"path": os.path.join(target_dir, name), "converged": True}

    return _runner


# ===========================================================================
# The sandbox every case below inherits
# ===========================================================================

class _InstallerConnectionCase(unittest.TestCase):
    """One tmp root holding the scratch `$HOME`, `$XDG_DATA_HOME`,
    `$XDG_CONFIG_HOME`, `$BUN_INSTALL`, `$CRUCIBLE_DB` and the `--target-dir`.
    `[server]` and `[unit]` are ALWAYS stubbed, in both directions; `[fleet]`,
    `[manifest]`, `[config]` and `[store]` are REAL."""

    def setUp(self):
        environment = mock.patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)

        self.root = tempfile.mkdtemp(prefix="cr139-install-connection-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

        self.fake_home = os.path.join(self.root, "home")
        self.xdg_data = os.path.join(self.root, "xdg-data")
        self.xdg_config = os.path.join(self.root, "xdg-config")
        self.bun_root = os.path.join(self.root, "bun")
        self.target_dir = os.path.join(self.root, "target")
        for directory in (self.fake_home, self.xdg_data, self.xdg_config,
                          self.bun_root):
            os.makedirs(directory, exist_ok=True)

        os.environ.update({
            "HOME": self.fake_home,
            "XDG_DATA_HOME": self.xdg_data,
            "XDG_CONFIG_HOME": self.xdg_config,
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_NO_SERVICE": "1",
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        })
        for retired in ("CRUCIBLE_PORT", "CRUCIBLE_HOST"):
            os.environ.pop(retired, None)

        self.install = importlib.import_module("crucible_axi.install")
        self.manifest = importlib.import_module("crucible_axi.manifest")
        self.cli = importlib.import_module("crucible_axi.cli")

        self.store_dir = self.install.store_dir()
        os.environ["CRUCIBLE_DB"] = os.path.join(self.store_dir, "crucible.db")
        self.server_config = os.path.join(self.store_dir, CONFIG_NAME)
        self.install_config = os.path.join(self.target_dir, CONFIG_NAME)
        self.template = None

        # The sandbox's own contract, asserted rather than assumed: this suite
        # runs a REAL installer, so the directory it computes for the server's
        # store must be inside the root that teardown removes.
        self.assertEqual(
            self.root, os.path.commonpath([self.root, self.store_dir]),
            "fixture sanity: the installer's store directory (%s) must fall "
            "inside this test's own root (%s) -- a real install runs here"
            % (self.store_dir, self.root))

    # -- ports this test owns ----------------------------------------------

    def consecutive_ports(self, count):
        return _claim_consecutive_ports(count)

    def occupy(self, port, listening=True):
        """Hold `port` for the rest of the test. `listening=False` is the case a
        CONNECT-based probe gets wrong: the port is taken, but nothing answers
        a connection to it."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((LOOPBACK, port))
        if listening:
            sock.listen(1)
        self.addCleanup(sock.close)
        return sock

    # -- the machine the install runs on ------------------------------------

    def provision_server(self, *, range_min=None, range_max=None,
                         host=LOOPBACK, port=_TEMPLATE_DEFAULT_PORT):
        """Make the server PROVISIONED LOCALLY, as the installer's own probe
        answers that question, and give its packaged `src/crucible.toml` the
        `[server]` table whose bounds this test wants probed.

        `_provisioned_server_config_source()` is where an install reads that
        template from, which is §S1a's whole point: the range is read from the
        RESOLVED server config file, so a test declares its own two bounds in a
        file instead of exporting a knob this CR is retiring.
        """
        if range_min is None or range_max is None:
            range_min, range_max = SHIPPED_RANGE_MIN, SHIPPED_RANGE_MAX
        package = self.install._provisioned_server_package_dir()
        os.makedirs(os.path.join(package, "src"), exist_ok=True)
        text = _without_server_table(
            SHIPPED_SERVER_DATA.read_text(encoding="utf-8"))
        text += _server_table_text(host=host, port=port, range_min=range_min,
                                   range_max=range_max)
        try:
            tomllib.loads(text)
        except tomllib.TOMLDecodeError as error:
            self.fail(
                "fixture sanity: the provisioned template this test composed "
                "does not PARSE (%s), so every bound and port below would be "
                "read back as absent rather than wrong. The shipped %s and "
                "`_server_table_text` must compose into one valid document"
                % (error, SHIPPED_SERVER_DATA))
        self.template = os.path.join(package, "src", CONFIG_NAME)
        Path(self.template).write_text(text, encoding="utf-8")
        Path(package, "package.json").write_text(
            json.dumps({"name": self.install.SERVER_NPM_PACKAGE,
                        "version": "0.0.0-sandbox"}) + "\n", encoding="utf-8")
        binary = self.install._provisioned_server_bin_path()
        os.makedirs(os.path.dirname(binary), exist_ok=True)
        Path(binary).write_text("#!/usr/bin/env node\n", encoding="utf-8")
        os.chmod(binary, 0o755)
        self.assertEqual(
            self.template, self.install._provisioned_server_config_source(),
            "fixture sanity: the installer must resolve ITS OWN template at "
            "%s -- that file is the one whose `[server]` table declares the "
            "range this test wants probed" % (self.template,))
        return package

    def declare_range(self, width=2, **kwargs):
        """Claim `width` consecutive ports and declare exactly them as the range
        in the provisioned template. Returns the ports, low first."""
        ports = self.consecutive_ports(width)
        self.provision_server(range_min=ports[0], range_max=ports[-1], **kwargs)
        return ports

    # -- driving the REAL entry points --------------------------------------

    def _stubs(self, table):
        return {name: _stub_stage(name)
                for name in ("server", "unit") if name in table}

    def run_install(self, force=False):
        """The real staged install; `(ok, stages, warnings)` verbatim, for the
        tests that assert on a FAILING one."""
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             self._stubs(self.install.DEFAULT_STAGE_RUNNERS)):
            return self.install.run_install(
                self.target_dir, force=force, no_service=True,
                no_bun_bootstrap=True)

    def install_once(self, force=False):
        ok, stages, warnings = self.run_install(force=force)
        self.assertTrue(
            ok, "the install must succeed before anything it wrote can be "
                "asserted; warnings=%r stages=%r" % (warnings, stages))
        return stages

    def cli_install(self, stdin):
        """`crucible-axi install` through the REAL console-script entry point,
        with `stdin` deciding whether an operator is there to be asked.

        Driven through the CLI rather than through `run_install` because the
        prompt is the installer's existing interactive/non-interactive split
        (`cli._resolve_purge` is the shipped instance of it) and this suite must
        not care WHICH of the two modules grows the question.
        """
        out, err = io.StringIO(), io.StringIO()
        asked = mock.Mock(return_value="")
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             self._stubs(self.install.DEFAULT_STAGE_RUNNERS)), \
                mock.patch.object(sys, "stdin", stdin), \
                mock.patch("builtins.input", asked), \
                contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            code = self.cli.main(["install", "--target-dir", self.target_dir])
        return code, out.getvalue() + err.getvalue(), asked

    def run_uninstall(self, purge=True):
        with mock.patch.dict(
                self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_uninstall(
                self.target_dir, purge=purge)
        self.assertTrue(
            ok, "the uninstall must run to completion; warnings=%r stages=%r"
               % (warnings, stages))
        return stages

    def reset_written_state(self):
        """Everything an install WROTE, removed -- the provisioned server (and
        so the template declaring the range) left exactly where it was. Lets one
        test run the same exhausted install twice, once per interactivity."""
        shutil.rmtree(self.store_dir, ignore_errors=True)
        shutil.rmtree(self.target_dir, ignore_errors=True)

    # -- observations -------------------------------------------------------

    def stage_row(self, stages, name):
        rows = [stage for stage in stages if stage.get("name") == name]
        self.assertEqual(
            1, len(rows),
            "exactly one `[%s]` stage row is owed; got %r" % (name, stages))
        return rows[0]

    def require_server_config(self):
        self.assertTrue(
            os.path.isfile(self.server_config),
            "§S1a: an install that provisioned the server must lay the "
            "server's operator-editable `%s` down beside its database, at %s; "
            "the store holds %r"
            % (CONFIG_NAME, self.server_config,
               sorted(os.listdir(self.store_dir))
               if os.path.isdir(self.store_dir) else None))
        return self.server_config

    def written_listener(self):
        """The port the install WROTE into the server's own file -- read back
        off that file, which is the only thing the server will ever consult."""
        self.require_server_config()
        table = _table(self.server_config, SERVER_TABLE)
        port = table.get(PORT_KEY)
        self.assertIsInstance(
            port, int,
            "§S1a: the install must write the listener it resolved into the "
            "`[%s] %s` of the file it lays down at %s -- an operator does not "
            "hand-edit a fresh install, and no process may need "
            "`$CRUCIBLE_PORT` to be told where to listen. That file's `[%s]` "
            "table is %r"
            % (SERVER_TABLE, PORT_KEY, self.server_config, SERVER_TABLE,
               table))
        return port

    def written_url(self):
        """The board URL the install wrote into the operator-editable CLIENT
        file it lays down at the target dir.

        That file, and deliberately not `<target-dir>/clients/crucible.toml`:
        the fleet copy is package DATA, replaced wholesale on every upgrade and
        byte-identical to the distribution's own (CR-CRU-138 §S4). A per-machine
        URL belongs in the file an operator owns and a purge protects.
        """
        self.assertTrue(
            os.path.isfile(self.install_config),
            "fixture sanity: `[manifest]` lays the operator-editable `%s` down "
            "at %s" % (CONFIG_NAME, self.target_dir))
        table = _table(self.install_config, CLIENT_TABLE)
        url = table.get(URL_KEY)
        self.assertIsInstance(
            url, str,
            "§S1a: the install must write the board URL into the `[%s] %s` of "
            "the client file it lays down at %s, from the SAME resolved value "
            "it wrote into the server's file -- so one install's two files "
            "cannot disagree about which board this machine talks to. That "
            "file's `[%s]` table is %r"
            % (CLIENT_TABLE, URL_KEY, self.install_config, CLIENT_TABLE,
               table))
        return url

    def ports_named_in_written_files(self):
        """Every port the install left behind in a file it laid down."""
        named = {}
        port = _table(self.server_config, SERVER_TABLE).get(PORT_KEY)
        if isinstance(port, int):
            named[self.server_config] = port
        url = _table(self.install_config, CLIENT_TABLE).get(URL_KEY)
        if isinstance(url, str) and _url_port(url) is not None:
            named[self.install_config] = _url_port(url)
        return named


# ===========================================================================
# The write itself
# ===========================================================================

class TheInstallWritesTheResolvedConnectionIntoTheFilesItLaysDownTest(
        _InstallerConnectionCase):

    def test_the_install_writes_the_probed_listener_into_the_server_files_own_table(self):
        """AC: `crucible-axi install` WRITES the connection into the files it
        lays down -- asserted by running a real install into a temp target and
        READING the resulting file, never by reading the installer's own output
        envelope (an envelope can claim a write that never landed).
        """
        ports = self.declare_range(width=2)

        self.install_once()

        self.assertEqual(
            ports[0], self.written_listener(),
            "§S1a: the install probes the declared range %r and takes the "
            "FIRST port it can BIND -- both were free, so it is the low bound. "
            "%s declares %r"
            % (ports, self.server_config,
               _table(self.server_config, SERVER_TABLE)))
        self.assertEqual(
            LOOPBACK, _table(self.server_config, SERVER_TABLE).get(HOST_KEY),
            "§S1: the file carries the bind address it was laid down with -- "
            "the listener is one datum (host AND port) in one file; got %r"
            % (_table(self.server_config, SERVER_TABLE),))

    def test_the_client_files_url_names_the_same_listener_the_server_file_declares(self):
        """AC: the fleet's `[client] url` is written from the SAME resolved
        value, so one install's two files cannot disagree. Asserted by reading
        BOTH files after a real install."""
        self.declare_range(width=2)

        self.install_once()

        listener = self.written_listener()
        url = self.written_url()
        self.assertEqual(
            "http", urlsplit(url).scheme,
            "the board URL must be a real http URL a client can post to; got "
            "%r" % (url,))
        self.assertTrue(
            urlsplit(url).hostname,
            "the board URL must name a host; got %r" % (url,))
        self.assertEqual(
            listener, _url_port(url),
            "§S1a: the two files this install wrote name DIFFERENT ports -- "
            "the server listens on %d (%s) while every client laid down beside "
            "it would post to %r (%s). One resolved value, written twice, is "
            "the whole point of letting the installer set it"
            % (listener, self.server_config, url, self.install_config))

    def test_the_chosen_port_lies_inside_the_range_that_file_itself_declares(self):
        """AC: the chosen port lies inside the declared range -- asserted
        against the FILE's own bounds (CR-CRU-134's derivation rule), never a
        retyped pair of numbers."""
        self.declare_range(width=3)

        self.install_once()

        listener = self.written_listener()
        low, high = _declared_range(self.server_config)
        self.assertIsInstance(
            low, int,
            "§S1a: the file the install lays down must still DECLARE the range "
            "it was probed out of -- `%s`/`%s` are what a later re-install and "
            "a reading operator both consult. `[%s]` is %r in %s"
            % (RANGE_MIN_KEY, RANGE_MAX_KEY, SERVER_TABLE,
               _table(self.server_config, SERVER_TABLE), self.server_config))
        self.assertIsInstance(high, int)
        self.assertTrue(
            low <= listener <= high,
            "§S1a: the install took %d, outside the range %d-%d that very file "
            "declares. It never drifts outside the bounds it read"
            % (listener, low, high))


class TheShippedServerFileDeclaresTheRangeThisProjectMayOccupyTest(
        unittest.TestCase):
    """The shipped declaration itself -- read off the checkout's own
    `src/crucible.toml`, with no install and no socket: this is the file every
    fresh install on every machine probes out of."""

    def test_the_shipped_server_table_declares_the_range_and_a_default_inside_it(self):
        table = _table(SHIPPED_SERVER_DATA, SERVER_TABLE)
        self.assertTrue(
            table,
            "§S1a: %s must declare a `[%s]` table -- the range this project "
            "may occupy is READ WHERE IT IS SET, never taken from a constant "
            "in the installer. The file declares %r"
            % (SHIPPED_SERVER_DATA, SERVER_TABLE,
               sorted(_tables(SHIPPED_SERVER_DATA))))
        self.assertEqual(
            SHIPPED_RANGE_MIN, table.get(RANGE_MIN_KEY),
            "§S1a: the declared range is 3800-3899, a hundred ports in the "
            "3000s around the 3849 this project has always used; got %r"
            % (table,))
        self.assertEqual(
            SHIPPED_RANGE_MAX, table.get(RANGE_MAX_KEY),
            "§S1a: the declared range is 3800-3899; got %r" % (table,))
        port = table.get(PORT_KEY)
        self.assertIsInstance(
            port, int,
            "§S1: the `[%s]` table carries `%s` as well as the bounds; got %r"
            % (SERVER_TABLE, PORT_KEY, table))
        self.assertTrue(
            SHIPPED_RANGE_MIN <= port <= SHIPPED_RANGE_MAX,
            "the shipped default listener must itself lie inside the range "
            "this project declares it may occupy; got %r" % (table,))


# ===========================================================================
# The probe BINDS
# ===========================================================================

class TheProbeBindsRatherThanConnectsTest(_InstallerConnectionCase):
    """Both shapes, because only the pair distinguishes the two probes: a
    connect-based probe passes the listener case and FAILS the bound-but-silent
    one, handing out a port another service has already reserved."""

    def test_a_listener_on_the_first_port_of_the_range_makes_the_install_take_the_next(self):
        ports = self.declare_range(width=2)
        self.occupy(ports[0], listening=True)

        self.install_once()

        listener = self.written_listener()
        self.assertNotEqual(
            ports[0], listener,
            "§S1a: a live listener holds %d, so the install must not hand that "
            "port to a second server -- two instances on one port is the "
            "failure this probe exists to prevent" % (ports[0],))
        self.assertEqual(
            ports[1], listener,
            "§S1a: with the range's first port occupied the install takes the "
            "NEXT one (%d); it wrote %d" % (ports[1], listener))

    def test_a_socket_bound_but_not_listening_is_skipped_exactly_as_a_listener_is(self):
        """The case that tells a BIND probe from a CONNECT probe. Nothing
        answers a connection to this port, so a refused-connection probe reads
        it as free -- and hands out a port whose owner is mid-startup."""
        ports = self.declare_range(width=2)
        self.occupy(ports[0], listening=False)

        self.install_once()

        listener = self.written_listener()
        self.assertNotEqual(
            ports[0], listener,
            "§S1a: %d is BOUND (by a socket that is not yet listening), so it "
            "is not this install's to take. A refused connection proves only "
            "that nothing is listening RIGHT NOW; binding proves the port is "
            "ours -- this assertion is the difference between the two probes"
            % (ports[0],))
        self.assertEqual(
            ports[1], listener,
            "§S1a: the install must take the next bindable port (%d); it wrote "
            "%d" % (ports[1], listener))


# ===========================================================================
# The range is DATA
# ===========================================================================

class TheRangeIsReadFromTheResolvedServerConfigFileTest(
        _InstallerConnectionCase):

    def test_the_install_probes_the_bounds_the_resolved_file_declares_not_a_constant(self):
        """AC: the range is read from the RESOLVED server config file, not from
        a constant in the installer -- a test that declares different bounds in
        that file gets an install that probes THOSE. Without this, exhaustion
        could only be tested by occupying a hundred real ports, or through an
        environment knob of exactly the kind this CR retires."""
        ports = self.declare_range(width=2)

        self.install_once()

        listener = self.written_listener()
        self.assertIn(
            listener, ports,
            "§S1a: the template this install resolved (%s) declares %d-%d, so "
            "the probe must run over THOSE bounds; the install wrote %d"
            % (self.template, ports[0], ports[-1], listener))
        self.assertFalse(
            SHIPPED_RANGE_MIN <= listener <= SHIPPED_RANGE_MAX,
            "§S1a: the install landed on %d, inside the SHIPPED %d-%d window, "
            "while the file it resolved declared %d-%d. The range is read "
            "where it is set; a constant in the installer cannot be narrowed "
            "by an operator and cannot be tested at all"
            % (listener, SHIPPED_RANGE_MIN, SHIPPED_RANGE_MAX, ports[0],
               ports[-1]))


# ===========================================================================
# Exhaustion STOPS the install and ASKS
# ===========================================================================

class RangeExhaustionStopsTheInstallAndAsksTest(_InstallerConnectionCase):

    def exhausted_range(self, width=2):
        ports = self.declare_range(width=width)
        for port in ports:
            self.occupy(port, listening=True)
        return ports

    def prompt_text(self, asked):
        return " ".join(str(argument) for call in asked.call_args_list
                        for argument in call.args)

    def test_exhaustion_prompts_the_operator_naming_the_range_and_what_occupies_it(self):
        """AC: exhaustion STOPS the install and PROMPTS -- exactly as the
        installer already prompts before a destructive purge. An operator told
        only "install failed" cannot act; one told which range was probed and
        what holds it can free a port or declare another range.
        """
        ports = self.exhausted_range()

        _code, output, asked = self.cli_install(stdin=_TtyStdin())

        self.assertTrue(
            asked.called,
            "§S1a: every port of the declared range %r is occupied, so the "
            "install must HALT AND ASK rather than pick something. It "
            "prompted nobody; output=%r" % (ports, output))
        prompt = _normalized(self.prompt_text(asked))
        for port in ports:
            self.assertIn(
                str(port), prompt,
                "§S1a: the prompt must NAME the range and what occupies it -- "
                "port %d is missing from it. prompt=%r" % (port, prompt))
        self.assertTrue(
            any(word in prompt.lower() for word in _OCCUPANCY_WORDS),
            "§S1a: the prompt must say what OCCUPIES the range, not merely "
            "restate its bounds (%r says none of %r)"
            % (prompt, list(_OCCUPANCY_WORDS)))

    def test_a_non_interactive_run_fails_definitively_with_the_same_message(self):
        """AC: a NON-interactive run cannot prompt, so exhaustion fails it
        definitively with the SAME message -- the installer's existing
        interactive/non-interactive split, unchanged. Automation must never
        hang on a question, and must never be told less than an operator is.
        """
        ports = self.exhausted_range()

        _code, interactive_output, asked = self.cli_install(stdin=_TtyStdin())
        self.assertTrue(
            asked.called,
            "§S1a: the interactive half of this contract must prompt on an "
            "exhausted range %r before the non-interactive half can be "
            "compared against it -- there is no message to share yet. "
            "output=%r" % (ports, interactive_output))
        prompt = self.prompt_text(asked)
        self.reset_written_state()

        code, output, never_asked = self.cli_install(stdin=io.StringIO())

        self.assertFalse(
            never_asked.called,
            "§S1a: a non-interactive run must never prompt -- automation would "
            "hang on the question. It asked %r"
            % (never_asked.call_args_list,))
        self.assertEqual(
            1, code,
            "§S1a: exhaustion fails a non-interactive install DEFINITIVELY; it "
            "exited %r. output=%r" % (code, output))
        shared = _longest_common_fragment(prompt, output)
        self.assertTrue(
            len(shared) >= 40 and all(str(port) in shared for port in ports),
            "§S1a: the non-interactive failure must carry the SAME message the "
            "operator would have been prompted with. The longest fragment the "
            "two share is %r (%d chars), which does not name the range %r.\n"
            "prompt=%r\nfailure=%r"
            % (shared, len(shared), ports, _normalized(prompt),
               _normalized(output)))

    def test_exhaustion_never_drifts_outside_the_range_or_falls_back_to_the_default(self):
        """AC: it never drifts outside the range and never falls back to the
        shipped default -- a silent fallback is how two instances end up on one
        port, which is the exact failure this CR exists to prevent."""
        ports = self.exhausted_range()
        default = _table(self.template, SERVER_TABLE)[PORT_KEY]

        ok, _stages, warnings = self.run_install()

        self.assertFalse(
            ok, "§S1a: with every port of %r occupied there is nothing to "
                "install onto; the install must STOP rather than report "
                "success. warnings=%r" % (ports, warnings))
        for path, port in self.ports_named_in_written_files().items():
            self.assertIn(
                port, ports,
                "§S1a: the stopped install left %s naming port %d, outside the "
                "declared range %r. A file left behind naming a port the "
                "install could not bind IS the silent fallback -- the next "
                "boot listens there" % (path, port, ports))
            self.assertNotEqual(
                default, port,
                "§S1a: the install fell back to the shipped default (%d) after "
                "exhausting %r, and wrote it into %s" % (default, ports, path))


# ===========================================================================
# A configured port is never re-probed
# ===========================================================================

class AConfiguredPortIsNeverReProbedTest(_InstallerConnectionCase):

    def test_a_reinstall_uses_the_port_the_file_already_names_even_while_it_is_in_use(self):
        """AC: a RE-INSTALL never re-probes. Renumbering a running instance
        orphans every client whose own file names the old port, so the one
        state where re-probing looks tempting -- the port is busy, because OUR
        server is serving on it -- is precisely where it is wrong."""
        ports = self.declare_range(width=2)
        self.install_once()
        configured = self.written_listener()
        before = Path(self.server_config).read_bytes()
        url_before = self.written_url()
        self.occupy(configured, listening=True)

        self.install_once(force=True)

        self.assertEqual(
            configured, self.written_listener(),
            "§S1a: the file already named %d and an instance is listening on "
            "it, so the re-install must USE it. It renumbered to %d, orphaning "
            "every client whose file names the old port (this range is %r)"
            % (configured, self.written_listener(), ports))
        self.assertEqual(
            before, Path(self.server_config).read_bytes(),
            "§S1a: a configured file is not rewritten by a re-install -- "
            "probing happens on a FRESH install, where there is nothing to "
            "honour")
        self.assertEqual(
            url_before, self.written_url(),
            "§S1a: the client file must keep naming the same board across a "
            "re-install, for the same reason the server file does")


# ===========================================================================
# The manifest records what the install wrote
# ===========================================================================

class TheManifestRecordsTheBytesTheInstallWroteTest(_InstallerConnectionCase):
    """`_operator_config_is_untouched` decides "did the OPERATOR change this?"
    Writing a probed port in makes every installed file differ from its template
    forever, so without a recording the install's own value would be
    indistinguishable from an operator's edit."""

    EDIT_MARKER = "\n# an operator was here\n"

    def edit(self, path):
        Path(path).write_text(
            Path(path).read_text(encoding="utf-8") + self.EDIT_MARKER,
            encoding="utf-8")

    def config_row(self, stages):
        return self.stage_row(stages, "config")

    def require_the_install_authored_it(self):
        """The state this whole ruling is about: the file the install laid down
        is no longer its TEMPLATE, because the install wrote a probed port into
        it. Judged against the template those bytes read as an operator's edit,
        which is exactly why the `[manifest]` stage must record what it wrote.
        """
        listener = self.written_listener()
        self.assertNotEqual(
            Path(self.template).read_bytes(),
            Path(self.server_config).read_bytes(),
            "§S1a: the install must have written its probed listener (%r) into "
            "%s, so that file necessarily DIFFERS from the template it was "
            "copied from. A file still byte-identical to its template is a "
            "machine where nothing was discovered, and the recording this test "
            "is about would have nothing to record"
            % (listener, self.server_config))
        return listener

    def test_a_file_the_install_wrote_a_probed_port_into_is_purged_as_untouched(self):
        """(1) -- the file the install authored reads as UNTOUCHED, so
        `uninstall --purge` removes it and nothing is retained for a reason no
        operator caused."""
        self.declare_range(width=2)
        self.install_once()
        listener = self.require_the_install_authored_it()

        stages = self.run_uninstall(purge=True)

        self.assertFalse(
            os.path.exists(self.server_config),
            "§S1a: the install itself wrote %d into %s, so those bytes are the "
            "INSTALL's and `--purge` removes them like any other artifact. "
            "Comparing an authored file against the shipped TEMPLATE makes "
            "every machine that ever probed a port look operator-edited "
            "forever" % (listener, self.server_config))
        self.assertFalse(
            os.path.exists(self.install_config),
            "§S1a: the client file the install wrote a `[%s] %s` into is the "
            "install's own too, and `--purge` removes it"
            % (CLIENT_TABLE, URL_KEY))
        row = self.config_row(stages)
        self.assertNotIn(
            "retained", row,
            "§S1a: nothing was retained -- both operator files were exactly "
            "what the install put there. The `[config]` row says %r" % (row,))

    def test_an_operator_edit_after_the_install_is_retained_by_purge_with_its_reason(self):
        """(2) -- an operator's later edit still diverges from the recording, is
        still preserved, and is still reported with the existing reason
        sentence. The rule's MEANING is unchanged; only its baseline moved."""
        self.declare_range(width=2)
        self.install_once()
        self.require_the_install_authored_it()
        self.edit(self.server_config)

        stages = self.run_uninstall(purge=True)

        self.assertTrue(
            os.path.isfile(self.server_config),
            "§S1a: the operator edited %s after the install wrote it, so the "
            "file is DATA and survives `--purge`" % (self.server_config,))
        self.assertIn(
            self.EDIT_MARKER.strip(),
            Path(self.server_config).read_text(encoding="utf-8"),
            "the file that survived is not the operator's -- their edit is "
            "gone, which is a silent overwrite wearing a survival's clothes")
        row = self.config_row(stages)
        self.assertTrue(
            row.get("retained"),
            "§S1a: a purge that KEPT something must say so; row=%r" % (row,))
        self.assertIn(
            "edits", row.get("reason", ""),
            "§S1a: the existing reason sentence is what an operator reads -- "
            "'it carries edits, and an operator's configuration is data rather "
            "than a replaceable artifact'; row=%r" % (row,))

    def test_a_file_with_no_recording_still_falls_back_to_the_template_comparison(self):
        """(3) -- an older install, or a file placed by hand: there is no
        recording to compare against, so the TEMPLATE comparison still decides
        and the fail-safe direction is unchanged. Both halves, because a
        fallback answering "untouched" for everything would delete an operator's
        file, and one answering "touched" for everything would make the
        protection unobservable.
        """
        self.provision_server()
        os.makedirs(self.store_dir, exist_ok=True)
        shutil.copyfile(self.template, self.server_config)

        self.run_uninstall(purge=True)

        self.assertFalse(
            os.path.exists(self.server_config),
            "§S1a: no `[manifest]` recording exists for this hand-placed file, "
            "so the comparison falls back to the shipped template -- and the "
            "file is byte-identical to it, so `--purge` removes it exactly as "
            "it did before this CR")

        os.makedirs(self.store_dir, exist_ok=True)
        shutil.copyfile(self.template, self.server_config)
        self.edit(self.server_config)

        stages = self.run_uninstall(purge=True)

        self.assertTrue(
            os.path.isfile(self.server_config),
            "§S1a: with no recording and bytes that differ from the template, "
            "the file is unprovable-as-ours and therefore KEPT -- the "
            "fail-safe direction this CR must not disturb")
        self.assertTrue(
            self.config_row(stages).get("retained"),
            "the purge kept a file and must say so")

    def test_purge_convergence_still_holds_on_a_machine_that_probed_a_port(self):
        """CR-CRU-138 §S2/§S3's convergence, on a machine that probed -- the
        regression the recording exists to prevent. Without it every installed
        file reads as operator-edited forever, `[config]` takes the retention
        branch on every machine, `[store]` keeps the directory it should empty,
        and a second purge never converges."""
        self.declare_range(width=2)
        self.install_once()
        self.written_listener()
        self.written_url()

        first = self.run_uninstall(purge=True)
        second = self.run_uninstall(purge=True)

        for name in ("config", "store"):
            row = self.stage_row(first, name)
            self.assertNotIn(
                "retained", row,
                "§S1a: `[%s]` retained something on a machine whose files the "
                "INSTALL itself wrote -- no operator was involved, so nothing "
                "is owed protection. row=%r" % (name, row))
        self.assertFalse(
            os.path.isdir(self.store_dir) and os.listdir(self.store_dir),
            "§S1a: `--purge` empties the store on a machine that probed a "
            "port, exactly as on one that did not; %s still holds %r"
            % (self.store_dir,
               sorted(os.listdir(self.store_dir))
               if os.path.isdir(self.store_dir) else []))
        for row in second:
            self.assertTrue(
                row.get("converged"),
                "§S1a: a SECOND purge must converge on every stage -- there is "
                "nothing left to remove. row=%r of %r" % (row, second))


# ===========================================================================
# Nothing else needs to know the port -- including the service
# ===========================================================================

class TheUnitCarriesNoListenerEnvironmentTest(_InstallerConnectionCase):

    def assignments(self, text):
        found = {}
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("Environment="):
                continue
            payload = stripped.split("=", 1)[1].strip().strip('"').strip("'")
            if "=" not in payload:
                continue
            name, value = payload.split("=", 1)
            found[name.strip()] = value.strip().strip('"').strip("'")
        return found

    def test_the_rendered_unit_forwards_the_store_and_carries_no_listener_variables(self):
        """AC: `_unit_environment()` (install.py:863-879) no longer forwards
        `CRUCIBLE_PORT`/`CRUCIBLE_HOST`; `CRUCIBLE_DB` keeps being forwarded
        (§S3 -- the store path is how the server FINDS its file, so it precedes
        configuration discovery). The unit boots the server, the server reads
        its own `crucible.toml`, and it binds what the install wrote there.
        """
        self.provision_server()
        db_path = os.path.join(self.store_dir, "crucible.db")
        os.environ.update({
            self.install.SERVER_HOST_ENV_VAR: "127.0.0.5",
            self.install.SERVER_PORT_ENV_VAR: "4711",
            self.install.SERVER_DB_ENV_VAR: db_path,
        })

        text = self.install._render_user_unit()

        found = self.assignments(text)
        self.assertEqual(
            db_path, found.get(self.install.SERVER_DB_ENV_VAR),
            "§S3: a `--user` unit inherits nothing, so what it NEEDS it must "
            "carry -- and it still needs the store path. assignments=%r"
            % (found,))
        for retired in (self.install.SERVER_PORT_ENV_VAR,
                        self.install.SERVER_HOST_ENV_VAR):
            self.assertNotIn(
                retired, found,
                "§S1a: the unit must carry NO %s -- it only ever carried it "
                "because the server had no file to read, and a retired "
                "variable that silently still works is worse than either "
                "state. assignments=%r" % (retired, found))
            self.assertNotIn(
                "Environment=%s" % (retired,), text,
                "§S1a: %s must not appear in the unit at all -- neither with a "
                "value nor as the empty assignment the unit's own inverse case "
                "already forbids. unit=%r" % (retired, text))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
