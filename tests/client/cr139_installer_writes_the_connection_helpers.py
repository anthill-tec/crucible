"""The helpers of `test_cr139_installer_writes_the_connection.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import socket
import tomllib


#: The `[server]` table §S1 adds, and the flat keys it carries -- agreed with
#: the §S1 (server-side) suite so one GREEN satisfies both files.
SERVER_TABLE = "server"

PORT_KEY = "port"

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

LOOPBACK = "127.0.0.1"


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
        # The kernel's ephemeral range does not overlap the shipped window by
        # default, but nothing guarantees it: a span that would touch the
        # window is skipped, never bound.
        if base <= SHIPPED_RANGE_MAX and base + count - 1 >= SHIPPED_RANGE_MIN:
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
