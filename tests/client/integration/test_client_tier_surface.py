"""CR-CRU-111 §S1 — the tier VERB surface, the ONE vocabulary, and the flag
that was never implemented.

One acceptance criterion lives here:

  * **AC1** — each of the six `Tier` values (`unit`, `module`, `integration`,
    `e2e`, `regression`, `bdd`) is an invocable VERB in EACH of the five
    clients, "asserted by driving every client's own `--help` and then the verb
    itself, not by reading source". So every assertion below comes from a real
    subprocess dispatch of the real client script; nothing here greps a client
    for `add_parser("unit")`.

What is RED here, and what is a PIN — stated honestly, per test, because a
suite that does not say which of its members were born green is a suite whose
colour means nothing (measured on `feature/CR-CRU-111` @ `develop`+0,
2026-09-08):

  RED  `TierVerbSurfaceFleetParityTest`
         `test_every_client_root_help_prints_all_six_tier_verbs_...` — today
         mvn prints four of the six (`unit`, `module`, `e2e`, `regression`),
         arduino two (`unit`, `regression`), bun and python one (`regression`),
         rust none.
         `test_every_tier_verb_answers_its_own_help_in_every_client` — the
         same gap, seen from argparse's own refusal.
  PIN  `TierVerbSurfaceFleetParityTest.
         test_a_seventh_name_is_still_argparse_invalid_choice_in_every_client`
         — passes today. It is the negative bound on "the six values AND NO
         OTHERS" (§S1) and the non-vacuity proof for the drive above it: it
         shows this harness can SEE an argparse refusal, so "no refusals" is a
         measurement rather than a blind spot.

STYLE, and where it comes from: `tests/client/unit/test_cr054_verb_surface_lift.py`
(real argparse dispatch, per-client offender dicts) and
`tests/client/integration/test_client_fleet_envelope_census.py` (drive the client as a
genuine subprocess; DERIVE the surface instead of freezing a list). No
assertion below compares against a hand-written expectation of what a client
currently exposes.

ESCALATION recorded at the time of writing (see the report for the full text):

  §S1 names only mvn's `unit`/`module`/`e2e` as verbs that migrate, but
     `regression` already exists as a full-suite verb in FOUR clients (bun,
     mvn, python, arduino) and `unit` in TWO (mvn, arduino). Those collisions
     are reported, not resolved here: this file asserts the AC's own
     requirement (the six names answer) and says nothing about whose
     behaviour a colliding name must keep.

Invocation:
    python3 -m pytest tests/client/integration/test_client_tier_surface.py -q
Fallback:
    python3 tests/client/integration/test_client_tier_surface.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client import CLIENT_SOURCE_DIR, client_script
from tests.client.client_fleet_envelope_census_helpers import (  # noqa: E402
    declare_and_require_board,
)

# The fleet's client table (the SOURCE paths and the asserted client count)
# lives in `client_tier_surface_helpers`, so a suite that reuses it imports no
# test module. A spawn or a load goes through `client_script`, the test install.
from tests.client.client_tier_surface_helpers import (  # noqa: E402
    CLIENT_FILES,
    EXPECTED_CLIENT_COUNT,
    TIER_VERBS,
)

CLIENTS_DIR = CLIENT_SOURCE_DIR

CLIENTS = tuple(CLIENT_FILES)

TIER_VOCABULARY = frozenset(TIER_VERBS)

# A name that is NOT a tier, for AC1's "a seventh name is `invalid choice`"
# half. Deliberately not `smoke`: rust ships `smoke-test`, and a bound that
# could be confused with a real verb is not a bound.
NOT_A_TIER_VERB = "acceptance"

# Nothing listens on port 1 without root -- the census's own idiom. `--help`
# never reaches the wire, but a drive that somehow did must refuse instantly
# rather than touch the live :3849 board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"

_PROJECT_DIR = None


def setUpModule():
    """One throwaway project fixture for every drive in this file: a `.env`
    carrying the two keys the fleet reads (`CRUCIBLE_PROJECT_NAME` is
    arduino's), so no drive can fail for a fixture reason and be mistaken for
    a tier finding."""
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="cr111-tier-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=cr111-tier-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=cr111-tier-surface-project\n")
    # CR-CRU-139 §S2 — the unreachable board is DECLARED in the project file
    # these drives run against, never exported. A `--help` never reaches the
    # wire; one that somehow did refuses instantly rather than touching a live
    # board.
    declare_and_require_board(_PROJECT_DIR, _UNREACHABLE_CRUCIBLE_URL,
                              "a help drive")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


_HELP_CACHE = {}


def _drive(client, argv):
    """A genuine subprocess dispatch of the real client script -- the census's
    `drive_verb` idiom, minus its fake-toolchain bin dir, which no `--help`
    drive can reach (argparse prints and exits before any verb body runs)."""
    env = os.environ.copy()
    return subprocess.run(
        [sys.executable, str(client_script(CLIENT_FILES[client].name))] + list(argv),
        cwd=_PROJECT_DIR, env=env, capture_output=True, text=True, timeout=60)


def _drive_help(client, *verb):
    """`<client> [verb] --help`, cached per (client, verb) for this process --
    the ~35 drives below are shared across the test methods, exactly as
    `_get_census()` shares its own."""
    key = (client, verb)
    if key not in _HELP_CACHE:
        _HELP_CACHE[key] = _drive(client, list(verb) + ["--help"])
    return _HELP_CACHE[key]


def _argparse_choices_group(help_text):
    """The verb names argparse ITSELF printed in the subparser choices group of
    a root `--help` -- the `{register,unregister,...}` metavar block. No client
    sets a `metavar` on `add_subparsers` (checked), so argparse prints the real
    registered names, and the block is the first brace pair in the output
    (the usage line). Argparse wraps long blocks with newlines and indentation
    but never with a brace, so the split survives the wrap.

    Returns `()` when no group is present, which is itself a finding."""
    match = re.search(r"\{([^{}]*)\}", help_text or "")
    if match is None:
        return ()
    return tuple(name.strip() for name in match.group(1).split(",")
                 if name.strip())


class TierVerbSurfaceFleetParityTest(unittest.TestCase):
    """AC1 -- the six `Tier` values are invocable VERBS in all five clients,
    proven by driving each client's own `--help` and then each verb itself.

    Two separate facts, because they fail for two different reasons: a verb can
    be registered and undocumented (absent from the choices group) or
    documented and unregistered. Both are asserted, and the number of CLIENTS
    exercised is asserted alongside them -- an assertion that loops over a list
    is satisfied by a list of one."""

    def test_every_client_root_help_prints_all_six_tier_verbs_in_its_choices_group(self):
        """CR-CRU-111 §S1/AC1 -- the six `Tier` values are VERBS in every
        client's own argparse choices group, read from the root `--help` each
        client really prints."""
        groups = {client: _argparse_choices_group(_drive_help(client).stdout)
                  for client in CLIENTS}

        # Non-vacuity FIRST: an empty/unparsed group would make the missing-set
        # below read as "everything missing" for a harness reason. `register`
        # is in every client's surface (CR-CRU-054), so its presence proves the
        # parse read a REAL choices group.
        unparsed = {client: _drive_help(client).returncode
                    for client, group in groups.items()
                    if "register" not in group}
        self.assertEqual(
            unparsed, {},
            f"the root `--help` choices group could not be read for these "
            f"clients (no `register` in the parsed group) -- fix the harness "
            f"before reading any tier verdict below: {unparsed!r}")

        self.assertEqual(
            len(groups), EXPECTED_CLIENT_COUNT,
            f"AC1 is a FLEET requirement: all {EXPECTED_CLIENT_COUNT} clients "
            f"must be driven, got {sorted(groups)!r}")

        missing = {client: sorted(TIER_VOCABULARY.difference(group))
                   for client, group in groups.items()
                   if TIER_VOCABULARY.difference(group)}
        self.assertEqual(
            missing, {},
            f"every one of {list(TIER_VERBS)!r} must "
            f"appear in EACH client's own argparse choices group; these "
            f"clients print fewer (client -> tiers absent from its root "
            f"help): {missing!r}")

    def test_every_tier_verb_answers_its_own_help_in_every_client(self):
        """CR-CRU-111 §S1/AC1 -- `<client> <tier> --help` is answered by
        argparse in every one of the (client, tier) pairs, never refused."""
        refusals = {}
        exercised = set()
        for client in CLIENTS:
            for verb in TIER_VERBS:
                exercised.add((client, verb))
                result = _drive_help(client, verb)
                combined = (result.stdout or "") + (result.stderr or "")
                if "invalid choice" in combined:
                    refusals[f"{client}:{verb}"] = "argparse: invalid choice"
                elif result.returncode != 0:
                    refusals[f"{client}:{verb}"] = (
                        f"exit {result.returncode}: "
                        f"{combined.strip().splitlines()[-1:] or ['<silent>']}")

        self.assertEqual(
            len({client for client, _ in exercised}), EXPECTED_CLIENT_COUNT,
            f"AC1's client count: {EXPECTED_CLIENT_COUNT} clients must have "
            f"been driven, drove "
            f"{sorted({client for client, _ in exercised})!r}")
        self.assertEqual(
            len(exercised), EXPECTED_CLIENT_COUNT * len(TIER_VERBS),
            f"AC1 is {EXPECTED_CLIENT_COUNT} clients x {len(TIER_VERBS)} "
            f"tiers = {EXPECTED_CLIENT_COUNT * len(TIER_VERBS)} invocations; "
            f"drove {len(exercised)}")
        self.assertEqual(
            refusals, {},
            f"`<client> <tier> --help` must be answered "
            f"by argparse in every (client, tier) pair, never refused: "
            f"{refusals!r}")

    def test_a_seventh_name_is_still_argparse_invalid_choice_in_every_client(self):
        """AC1's negative half -- "A seventh name is `invalid choice` from
        argparse's own refusal" -- and §S1's "the six values of `Tier` and no
        others".

        PASSES TODAY (no client registers `acceptance`): it is a BOUND, not a
        RED. It earns its place twice over -- it stops the sibling test above
        from being satisfied by a client that accepts every name, and it is
        that test's non-vacuity proof, showing this harness can actually SEE an
        argparse refusal."""
        accepted = {}
        for client in CLIENTS:
            result = _drive_help(client, NOT_A_TIER_VERB)
            combined = (result.stdout or "") + (result.stderr or "")
            if result.returncode == 0 or "invalid choice" not in combined:
                accepted[client] = f"exit {result.returncode}"
        self.assertEqual(
            len(CLIENTS), EXPECTED_CLIENT_COUNT,
            f"the bound must cover all {EXPECTED_CLIENT_COUNT} clients")
        self.assertEqual(
            accepted, {},
            f"§S1 -- the tier verb set is the six values of `Tier` AND NO "
            f"OTHERS; these clients answered the non-tier verb "
            f"{NOT_A_TIER_VERB!r} instead of refusing it: {accepted!r}")


if __name__ == "__main__":
    unittest.main()
