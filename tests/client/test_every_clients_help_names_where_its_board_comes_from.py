"""Every client's help names where the board it posts to comes from.

The board a client posts to is `[client] url` in `crucible.toml`, resolved from
the project's file, then the install's, then the shipped one -- and the FIRST
file that exists and parses wins, whether or not it holds a `[client]` table.
So a project file with no `[client] url` falls straight through to the shipped
address, while a malformed one falls through to the next file. None of that is
visible to an operator today: no client's `--help` prints it, and the shared
transport's connection-failure and timeout messages name only the address.

What this file pins:

`EveryClientsTopLevelHelpNamesTheBoardConfigurationTest`
    For EACH of the five clients, the top-level `--help` -- produced by running
    the real client script as a subprocess, the way the fleet census drives it
    (`drive_verb` in `test_client_fleet_envelope_census.py`) -- carries, in its
    DESCRIPTION, the `[client] url` key, the project -> install -> shipped
    order and the fall-through rule. And all five carry it from ONE text held
    by the shared client module (`clients/_crucible_axi.py`), never five hand
    copies.

`TheTransportsFailureMessagesNameTheBoardConfigurationTest`
    The shared transport (`http_request` in `clients/_crucible_axi.py`) is
    driven for real: once against a port nothing listens on (a refused
    connection) and once against a listener that accepts and never answers (a
    read-phase timeout). Both failure messages name `[client] url` and the
    resolution order, and both still name the address they tried.

Wording is pinned only as far as the requirement fixes it: the literal key
`[client] url`, the three layers in their precedence order, and the words that
state the fall-through rule (the first file that parses, a file WITHOUT the key,
a MALFORMED file falling THROUGH). Whitespace is normalised on both sides
because two clients let argparse re-wrap their description.
"""

import ast
import re
import shutil
import socket
import unittest
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _make_project_dir,
    drive_verb,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

#: The configuration key the board is declared under, exactly as an operator
#: writes it in `crucible.toml`.
CLIENT_URL_KEY = "[client] url"

#: The three layers of the resolution chain, in precedence order.
RESOLUTION_ORDER = ("project", "install", "shipped")

#: The words that state the fall-through rule: the FIRST file that exists and
#: PARSES wins, so a project file WITHOUT the key uses the shipped address,
#: while a MALFORMED one falls THROUGH to the next file.
FALL_THROUGH_TERMS = ("first", "parses", "without", "malformed", "through")

#: A port nothing listens on without root: loopback refuses it instantly.
UNREACHABLE_BOARD = "http://127.0.0.1:1"

#: A deliberately short read bound for the timeout drive.
SHORT_TIMEOUT = 0.3

_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}


def normalise(text):
    """Whitespace-insensitive form of a help text: every run of whitespace is
    one space, and a hyphen argparse broke a line on is re-joined. Applied to
    BOTH sides of every containment check, so a text re-wrapped by argparse
    still matches the text it was wrapped from."""
    collapsed = re.sub(r"\s+", " ", text or "")
    return re.sub(r"-\s+", "-", collapsed).strip()


def names_layers_in_order(text):
    """True iff `text` names the project, then the install, then the shipped
    layer -- each found AFTER the one before it."""
    lowered = text.lower()
    position = -1
    for layer in RESOLUTION_ORDER:
        position = lowered.find(layer, position + 1)
        if position < 0:
            return False
    return True


def missing_fall_through_terms(text):
    lowered = text.lower()
    return [term for term in FALL_THROUGH_TERMS if term not in lowered]


def help_description(stdout):
    """The DESCRIPTION section of an argparse top-level help: after the usage
    block (which ends at the first blank line and lists every verb, `next`
    included) and before the `positional arguments:` heading."""
    after_usage = stdout.split("\n\n", 1)[1] if "\n\n" in stdout else ""
    return after_usage.split("positional arguments:", 1)[0]


_DOCSTRING_OWNERS = (ast.Module, ast.ClassDef, ast.FunctionDef,
                     ast.AsyncFunctionDef)


def hand_copied_key_literals(source):
    """Every NON-docstring string literal in a client's source that spells the
    `[client] url` key -- the shape a hand copy of the shared help text takes.
    Module, class and function docstrings are not help text and are skipped."""
    tree = ast.parse(source)
    docstrings = set()
    for parent in ast.walk(tree):
        if not isinstance(parent, _DOCSTRING_OWNERS) or not parent.body:
            continue
        first = parent.body[0]
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            docstrings.add(id(first.value))
    found = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings
                and CLIENT_URL_KEY in node.value):
            found.append(node.value)
    return found


_HELP_CACHE = None


def _top_level_helps():
    """Each client's real top-level `--help`, driven once per test run."""
    global _HELP_CACHE
    if _HELP_CACHE is not None:
        return _HELP_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    helps = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                helps[client_key] = drive_verb(
                    script_path, ["--help"], project_dir, fake_bin_dir,
                    extra_env=_HELP_ENV)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _HELP_CACHE = helps
    return helps


def _load_axi():
    return _load_module(AXI_MODULE_PATH, "board_configuration_help_axi")


class EveryClientsTopLevelHelpNamesTheBoardConfigurationTest(unittest.TestCase):
    """The top-level `--help` of arduino, bun, mvn, python and rust each says
    which file the board comes from and how the chain falls through."""

    @classmethod
    def setUpClass(cls):
        cls.helps = _top_level_helps()
        cls.axi = _load_axi()

    def description_of(self, client_key):
        completed = self.helps[client_key]
        self.assertEqual(
            completed.returncode, 0,
            f"{client_key} --help must exit 0; stderr={completed.stderr!r}")
        self.assertIn(
            "usage:", completed.stdout,
            f"{client_key} --help printed no usage; stdout={completed.stdout!r}")
        return normalise(help_description(completed.stdout))

    def test_every_clients_top_level_help_names_the_client_url_key(self):
        self.assertEqual(
            sorted(self.helps), ["arduino", "bun", "mvn", "python", "rust"],
            "the help census must cover exactly the five clients")
        offenders = {}
        for client_key in CLIENT_FILES:
            description = self.description_of(client_key)
            if CLIENT_URL_KEY not in description:
                offenders[client_key] = description
        self.assertEqual(
            offenders, {},
            f"the top-level --help description must name `{CLIENT_URL_KEY}`, "
            f"the key the board is read from; missing in: {offenders!r}")

    def test_every_clients_top_level_help_names_project_then_install_then_shipped(self):
        offenders = {}
        for client_key in CLIENT_FILES:
            description = self.description_of(client_key)
            if (CLIENT_URL_KEY not in description
                    or not names_layers_in_order(description)):
                offenders[client_key] = description
        self.assertEqual(
            offenders, {},
            "the top-level --help description must name the board's key and "
            "its resolution order -- the project's crucible.toml, then the "
            f"install's, then the shipped one; it does not in: {offenders!r}")

    def test_every_clients_top_level_help_states_the_fall_through_rule(self):
        offenders = {}
        for client_key in CLIENT_FILES:
            description = self.description_of(client_key)
            missing = missing_fall_through_terms(description)
            if CLIENT_URL_KEY not in description or missing:
                offenders[client_key] = {"missing": missing,
                                         "description": description}
        self.assertEqual(
            offenders, {},
            "the top-level --help description must state that the first "
            "file that exists and parses wins -- a project file without "
            f"`{CLIENT_URL_KEY}` uses the shipped address, a malformed one "
            f"falls through to the next file; it does not in: {offenders!r}")

    def test_all_five_carry_one_shared_text_held_by_the_shared_module(self):
        shared_texts = {
            name: value for name, value in vars(self.axi).items()
            if not name.startswith("__") and isinstance(value, str)
            and CLIENT_URL_KEY in value}
        descriptions = {c: self.description_of(c) for c in CLIENT_FILES}
        carried_by_all = {
            name: value for name, value in shared_texts.items()
            if all(normalise(value) in d for d in descriptions.values())}
        self.assertTrue(
            carried_by_all,
            "the shared client module must hold ONE text naming "
            f"`{CLIENT_URL_KEY}` that every client's top-level --help carries "
            f"whole; module-level texts naming the key: {sorted(shared_texts)!r}"
            f", carried by all five: none")
        complete = {
            name for name, value in carried_by_all.items()
            if names_layers_in_order(normalise(value))
            and not missing_fall_through_terms(normalise(value))}
        self.assertTrue(
            complete,
            "the shared text every client carries must itself name the order "
            "and the fall-through rule, not leave them to per-client copies; "
            f"carried texts: {carried_by_all!r}")
        copies = {}
        for client_key, script_path in CLIENT_FILES.items():
            literals = hand_copied_key_literals(script_path.read_text())
            if literals:
                copies[client_key] = literals
        self.assertEqual(
            copies, {},
            "no client may hold its own copy of the configuration help; "
            f"string literals naming `{CLIENT_URL_KEY}` found in: {copies!r}")


class TheTransportsFailureMessagesNameTheBoardConfigurationTest(unittest.TestCase):
    """The shared transport's connection-failure and timeout messages say
    where the address they tried came from."""

    def setUp(self):
        self.axi = _load_axi()

    def refused_connection_error(self):
        result = self.axi.http_request(UNREACHABLE_BOARD, "GET",
                                       "/api/v2/health", timeout=2)
        self.assertEqual(result.get("ok"), False,
                         f"a refused connection must be ok:false; got {result!r}")
        error = result.get("error", "")
        self.assertTrue(
            error.startswith("connection failed:"),
            f"a refused connection is reported as a connection failure; "
            f"got {error!r}")
        self.assertIn(UNREACHABLE_BOARD, error,
                      "the message must still name the address it tried")
        return error

    def timed_out_error(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        board = f"http://127.0.0.1:{listener.getsockname()[1]}"
        result = self.axi.http_request(board, "GET", "/api/v2/health",
                                       timeout=SHORT_TIMEOUT)
        self.assertEqual(result.get("ok"), False,
                         f"a timed-out request must be ok:false; got {result!r}")
        error = result.get("error", "")
        self.assertTrue(
            error.startswith(f"request timed out after {SHORT_TIMEOUT}s"),
            f"a board that accepts and never answers is reported as a "
            f"timeout naming its bound; got {error!r}")
        self.assertIn(board, error,
                      "the message must still name the address it tried")
        return error

    def test_a_refused_connection_message_names_the_client_url_key(self):
        error = self.refused_connection_error()
        self.assertIn(
            CLIENT_URL_KEY, error,
            f"the connection-failure message must name `{CLIENT_URL_KEY}`, "
            f"the key the address was read from; got {error!r}")

    def test_a_refused_connection_message_names_project_then_install_then_shipped(self):
        error = self.refused_connection_error()
        self.assertTrue(
            CLIENT_URL_KEY in error and names_layers_in_order(error),
            "the connection-failure message must name the key and the order "
            "it resolves in -- project, then install, then shipped; "
            f"got {error!r}")

    def test_a_timed_out_request_message_names_the_client_url_key(self):
        error = self.timed_out_error()
        self.assertIn(
            CLIENT_URL_KEY, error,
            f"the timeout message must name `{CLIENT_URL_KEY}`, the key the "
            f"address was read from; got {error!r}")

    def test_a_timed_out_request_message_names_project_then_install_then_shipped(self):
        error = self.timed_out_error()
        self.assertTrue(
            CLIENT_URL_KEY in error and names_layers_in_order(error),
            "the timeout message must name the key and the order it resolves "
            f"in -- project, then install, then shipped; got {error!r}")


if __name__ == "__main__":
    unittest.main()
