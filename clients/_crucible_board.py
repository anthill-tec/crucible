"""The board a client posts to, and the refusal when no board is declared.

A client reads its board from `[client] url`: the bound project's
`crucible.toml`, then the install's (the chain the core's
`_project_config_candidates` walks). The first file that declares a non-empty
string `url` wins, and a file without one -- absent, not parsing, or naming no
`url` -- is passed over. There is no last resort: when no file of the chain
declares a board, `resolve_base_url` raises `BoardUndeclared`, a typed hard
stop that names every file of the chain and why each was passed over, and
`run_verb` turns it into one `ok: false` envelope. No request is sent.

The board is resolved at the point of use, never cached and never at import:
a verb that sends nothing resolves nothing, so it runs with no board declared,
and a verb given a different project dir posts to that project's board.

No client loads this module. The core, `_crucible_axi.py`, loads it by file
path from its own directory, under a name derived from its own, and
re-exports every name it defines, so a client reaches
`_axi().resolve_base_url`. Every core name used here is read through `_core`,
a live view of the core's namespace bound at load time, so a patch of the
core's install dir or project dir is seen.

It imports only the standard library.
"""

import os
import sys
import tomllib
import typing

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run.
_core: typing.Any = None

#: The table a board is declared in, and its one field. Spelled here rather
#: than at each read so the file's schema is stated once.
CLIENT_TABLE = "client"
CLIENT_BOARD_FIELD = "url"

#: Why a file of the chain was passed over, as the refusal says it.
BOARD_FILE_ABSENT = "is absent"
BOARD_FILE_UNPARSEABLE = "does not parse"
BOARD_FILE_NO_URL = f"declares no `[{CLIENT_TABLE}] {CLIENT_BOARD_FIELD}`"

#: The code of the hard stop's stderr line.
BOARD_UNDECLARED_CODE = "board-undeclared"

#: Where the board's address is read from, in the order `resolve_base_url`
#: walks it. The transport's connection-failure and timeout messages carry it,
#: so an operator facing an unreachable board learns which key to correct.
BOARD_SOURCE = (f"the address is `[{CLIENT_TABLE}] {CLIENT_BOARD_FIELD}` from "
                "the project's crucible.toml, then the install's; with neither "
                "declaring one the client refuses")

#: The ONE text every client appends to its top-level `--help` description:
#: the key the board is read from, the order of the chain, and the rule
#: `resolve_base_url` resolves it by.
BOARD_CONFIGURATION_HELP = (
    f"Board: every verb posts to `[{CLIENT_TABLE}] {CLIENT_BOARD_FIELD}`, read "
    "from the project's crucible.toml,\n"
    "then the install's. The first file that declares a non-empty one wins; "
    "a file\n"
    "without one (or that does not parse) is passed over. A verb that must "
    "reach the\n"
    "board refuses when no file declares one; the installer writes the "
    "install's.")

#: The two fixes the refusal's `help` names.
BOARD_UNDECLARED_HELP = (
    "re-run the installer (`crucible-axi install`), which writes the "
    f"install's `[{CLIENT_TABLE}] {CLIENT_BOARD_FIELD}`",
    f"or declare `[{CLIENT_TABLE}] {CLIENT_BOARD_FIELD} = "
    "\"http://<host>:<port>\"` in the project's crucible.toml")


class BoardUndeclared(Exception):
    """Raised when no file of the chain declares a board. `chain` holds each
    file with why it was passed over, in precedence order; `detail` names
    them, and `help` the two fixes."""

    def __init__(self, chain):
        self.chain = list(chain)
        passed_over = ", then ".join(f"{_shown(path)} {reason}"
                                     for path, reason in self.chain)
        self.detail = ("no board declared, so nothing was sent. The client "
                       "reads the board from the project's crucible.toml, "
                       f"then the install's: {passed_over}")
        self.help = list(BOARD_UNDECLARED_HELP)
        super().__init__(self.detail)


def emit_board_undeclared_hard_stop(verb, refusal, context=None):
    """Emit the `ok:false` envelope (stdout) plus the human error line
    (stderr) for a client with no board declared, and return the non-zero
    exit code. Nothing is sent from this path."""
    _core.emit_axi(verb or "unknown", False,
                   {"error": refusal.detail, "help": refusal.help},
                   context or {}, [],
                   legacy_line=f"error: {BOARD_UNDECLARED_CODE} \u2014 {refusal.detail}")
    return 1


def report_board_undeclared(refusal):
    """Print the refusal's error line on stderr alone, for a path whose
    envelope was already emitted (a finished gate's outcome tail)."""
    print(f"error: {BOARD_UNDECLARED_CODE} \u2014 {refusal.detail}", file=sys.stderr)


#: How a message about an unrecorded run names the board when none is declared.
NO_BOARD_DECLARED = "no board (none is declared)"


def board_address(base_url):
    """`base_url`, or what it answers when it is a resolver; with no board
    declared, `NO_BOARD_DECLARED`, so a run that sent nothing can still say
    why it was not recorded."""
    if not callable(base_url):
        return base_url
    try:
        return base_url()
    except BoardUndeclared:
        return NO_BOARD_DECLARED


def resolve_base_url():
    """The board this client posts to, at the point of use: the first file of
    the chain -- the project's, then the install's -- that declares a
    non-empty string `[client] url`.

    Never cached, for the reason every limit is re-read: the project dir a
    verb resolved is bound before its first request, and a verb given a
    different project must post to that project's board.

    A file never raises here: an absent, unparseable or board-less file is
    passed over. With no file declaring a board this raises `BoardUndeclared`,
    naming each file and why it was passed over."""
    chain = []
    for path in _core._project_config_candidates():
        url, reason = _board_declaration(path)
        if url:
            return url
        chain.append((path, reason))
    raise BoardUndeclared(chain)


def _board_declaration(path):
    """`(url, None)` for the stripped non-empty string `[client] url` the file
    at `path` declares, else `(None, why it is passed over)`."""
    try:
        with open(path, "rb") as fh:
            table = tomllib.load(fh).get(CLIENT_TABLE)
    except (FileNotFoundError, NotADirectoryError):
        return None, BOARD_FILE_ABSENT
    except OSError as exc:
        return None, f"cannot be read ({exc.strerror or type(exc).__name__})"
    except ValueError:  # ValueError covers TOMLDecodeError.
        return None, BOARD_FILE_UNPARSEABLE
    url = table.get(CLIENT_BOARD_FIELD) if isinstance(table, dict) else None
    url = url.strip() if isinstance(url, str) else ""
    return (url, None) if url else (None, BOARD_FILE_NO_URL)


def _declared_board(path):
    """The stripped non-empty string `[client] url` the file at `path`
    declares, or None when it is absent, does not parse, or declares none."""
    return _board_declaration(path)[0]


def _machine_board():
    """The machine's own board: the install file's usable `[client] url`, or
    None when the install declares none."""
    return _declared_board(os.path.join(_core._INSTALL_DIR, _core._SHIPPED_DATA_FILENAME))


def _shown(path):
    """`path` as an operator reads it: home-abbreviated."""
    path = str(path)
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path
