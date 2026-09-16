"""CR-CRU-111 §S1 — the tier VERB surface, the ONE vocabulary, and the flag
that was never implemented.

Four acceptance criteria live here, and they are the four this cycle owns:

  * **AC1** — each of the six `Tier` values (`unit`, `module`, `integration`,
    `e2e`, `regression`, `bdd`) is an invocable VERB in EACH of the five
    clients, "asserted by driving every client's own `--help` and then the verb
    itself, not by reading source". So every assertion below comes from a real
    subprocess dispatch of the real client script; nothing here greps a client
    for `add_parser("unit")`.
  * **AC4** — the tier surface is registered from ONE place, and the
    registrar-parity check COUNTS the call sites over the five files rather
    than comparing them to a frozen list.
  * **AC10** — the vocabulary is mirrored ONCE on the client side, and the
    mirror cannot drift: the guard parses the `Tier` union out of
    `src/types.ts` and asserts the mirror equals it set for set.
  * **AC11** — the `--tier` flag CR-CRU-008's contract named and no client ever
    implemented is retired explicitly.

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
  RED  `TierRegistrarSingleLocusTest` (both) — `clients/_crucible_axi.py` has
         no tier registrar at all, so the derived count over the five client
         files is 0, not 5.
  RED  `TierVocabularyMirrorDriftGuardTest.
         test_the_client_side_mirror_equals_the_tier_union_set_for_set` — the
         client side holds NO copy of the vocabulary today; the six values
         exist only as scattered `tier="..."` keyword literals, which is
         exactly the shape AC10 replaces with one mirror.
  PIN  `TierVocabularyMirrorDriftGuardTest.
         test_the_vocabulary_this_guard_reads_is_the_tier_union_of_src_types_ts`
         and `..._no_client_file_carries_a_second_copy_...` — both pass today
         (the union parses; no client holds a copy because no client holds
         ANY copy). They are the two BOUNDS on the drift guard: without the
         first, the guard could compare a mirror against an empty parse and
         call it equal; without the second, AC10's single-mirror rule would be
         satisfied by six mirrors as long as one of them lived in the shared
         module.
  PIN  `TierVerbSurfaceFleetParityTest.
         test_a_seventh_name_is_still_argparse_invalid_choice_in_every_client`
         — passes today. It is the negative bound on "the six values AND NO
         OTHERS" (§S1) and the non-vacuity proof for the drive above it: it
         shows this harness can SEE an argparse refusal, so "no refusals" is a
         measurement rather than a blind spot.
  PIN  `RetiredTierFlagTest` — passes today, and its docstring says so. AC11
         is a REGRESSION PIN, never a RED: `add_argument("--tier` returns zero
         across `clients/` today and the AC's own words are "as today". It
         exists because CR-CRU-008's contract named a flag that was never
         implemented in any client, and the retirement has to be recorded
         somewhere a future reader of that contract will trip over.

STYLE, and where it comes from: `tests/client/test_cr054_verb_surface_lift.py`
(real argparse dispatch, per-client offender dicts) and
`tests/client/test_client_fleet_envelope_census.py` (drive the client as a
genuine subprocess; DERIVE the surface instead of freezing a list). No
assertion below compares against a hand-written expectation of what a client
currently exposes.

ESCALATIONS recorded at the time of writing (see the report for the full text):

  1. AC4 does not NAME the shared registrar. This file pins `add_tier_verbs`,
     chosen by the fleet's own convention — a MULTI-verb registrar takes the
     plural `add_<surface>_verbs` (`add_roadmap_verbs`), a one-verb registrar
     the singular (`add_next_verb`, `add_cr_depends_verb`, `add_queue_file_verb`).
     Six verbs is the plural case. If GREEN spells it otherwise the two AC4
     tests fail on the NAME, which is a naming disagreement, not a defect.
  2. AC10 does not NAME the mirror either, so the guard DERIVES it: any
     collection literal in `clients/_crucible_axi.py` holding two or more of
     the six values IS the mirror, whatever it is called. That is deliberate —
     the guard has to survive GREEN's naming choice.
  3. §S1 names only mvn's `unit`/`module`/`e2e` as verbs that migrate, but
     `regression` already exists as a full-suite verb in FOUR clients (bun,
     mvn, python, arduino) and `unit` in TWO (mvn, arduino). Those collisions
     are reported, not resolved here: this file asserts the AC's own
     requirement (the six names answer) and says nothing about whose
     behaviour a colliding name must keep.

Invocation:
    python3 -m pytest tests/client/test_client_tier_surface.py -q
Fallback:
    python3 tests/client/test_client_tier_surface.py
"""

import ast
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TYPES_TS_PATH = REPO_ROOT / "src" / "types.ts"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# AC1's own words: "Five assertions and the client count asserted". The count is
# a CONSTANT here and is compared against the number of clients each test
# actually DROVE, so a loop that silently shrank to one client fails -- that is
# the specific defect AC1 exists to prevent ("the client exposes the verbs" is
# satisfiable by one client).
EXPECTED_CLIENT_COUNT = 5

# The six, spelled as AC1 spells them. This literal is not the source of truth:
# `TierVocabularyMirrorDriftGuardTest` below asserts it equals the `Tier` union
# parsed out of `src/types.ts`, so a seventh server-side value makes THIS list
# fail rather than quietly narrowing every assertion in the file.
TIER_VERBS = ("unit", "module", "integration", "e2e", "regression", "bdd")
TIER_VOCABULARY = frozenset(TIER_VERBS)

# A name that is NOT a tier, for AC1's "a seventh name is `invalid choice`"
# half. Deliberately not `smoke`: rust ships `smoke-test`, and a bound that
# could be confused with a real verb is not a bound.
NOT_A_TIER_VERB = "acceptance"

# AC4's shared registration, by the fleet's plural multi-verb convention. See
# ESCALATION 1 in the module docstring.
TIER_REGISTRAR = "add_tier_verbs"

# AC11's literal, in both quote styles argparse callers use in this repo.
RETIRED_TIER_FLAG_SPELLINGS = ('add_argument("--tier', "add_argument('--tier")
# The non-vacuity probe for the same scan: a flag that IS declared fleet-wide,
# so "zero hits for --tier" cannot be a scanner that read nothing.
_SCAN_PROBE_SPELLINGS = ('add_argument("--agent', "add_argument('--agent")

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


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


_HELP_CACHE = {}


def _drive(client, argv):
    """A genuine subprocess dispatch of the real client script -- the census's
    `drive_verb` idiom, minus its fake-toolchain bin dir, which no `--help`
    drive can reach (argparse prints and exits before any verb body runs)."""
    env = os.environ.copy()
    env["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
    env["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL  # arduino's 2nd-choice var
    return subprocess.run(
        [sys.executable, str(CLIENT_FILES[client])] + list(argv),
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


def _load_module_by_path(path, cache_key):
    """The fleet's own `_axi()`/`_toon()` loader idiom, as every sibling test in
    this directory uses it."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _registrar_call_lines(path, name):
    """Every line in `path` that CALLS `name` -- as `_axi().<name>(...)`, as a
    bare `<name>(...)`, or through any other attribute access.

    Derived from the AST rather than by grep, and returned as a LIST of lines
    rather than a boolean, so AC4's "the registrar-parity check counts the call
    sites" is a real count: a client with none and a client with two are two
    different findings. Mirrors `_single_verb_registrar_delegator` in the
    sibling `test_cr054_fleet_inventory.py`, which reads the same call shape
    for `add_next_verb` / `add_cr_depends_verb` / `add_queue_file_verb`."""
    lines = []
    for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == name:
            lines.append(node.lineno)
        elif isinstance(func, ast.Name) and func.id == name:
            lines.append(node.lineno)
    return sorted(lines)


class TierRegistrarSingleLocusTest(unittest.TestCase):
    """AC4 -- the tier surface is registered from ONE place for every client
    that runs tests, and the parity check COUNTS the call sites over the five
    files instead of comparing them to a frozen list.

    The shape asserted is the one the fleet already has (§S1: "registered from
    one place in `clients/_crucible_axi.py` beside the other fleet-wide verb
    surfaces") -- `add_roadmap_verbs` (:3406) for a multi-verb surface,
    `add_next_verb` (:3501) / `add_cr_depends_verb` (:3368) /
    `add_queue_file_verb` (:3545) for single verbs. Six verbs is the multi-verb
    case, so this asserts the plural spelling. See ESCALATION 1."""

    def test_the_shared_module_exports_the_tier_registrar(self):
        axi = _load_module_by_path(AXI_MODULE_PATH, "cr111_axi_under_test")
        registrar = getattr(axi, TIER_REGISTRAR, None)
        self.assertTrue(
            callable(registrar),
            f"clients/_crucible_axi.py must export "
            f"`{TIER_REGISTRAR}(sub, funcs, *, parents=(), add_args=())` -- "
            f"the multi-verb registrar shape `add_roadmap_verbs` already uses "
            f"-- so the six tier subparsers are built ONCE rather than "
            f"hand-rolled in five clients (§S1); got {registrar!r}")

    def test_every_client_invokes_the_shared_tier_registrar_exactly_once(self):
        """CR-CRU-111 AC4 -- every client wires the SHARED tier registrar, and
        wires it exactly once; the count is derived by scanning the five
        files, never compared to a frozen list."""
        sites = {client: _registrar_call_lines(path, TIER_REGISTRAR)
                 for client, path in CLIENT_FILES.items()}

        # The count AC4 asks for, DERIVED by scanning the five files -- never a
        # frozen list of expected call sites.
        derived_total = sum(len(lines) for lines in sites.values())
        wired = sorted(client for client, lines in sites.items() if lines)
        duplicated = {client: lines for client, lines in sites.items()
                      if len(lines) > 1}

        self.assertEqual(
            len(sites), EXPECTED_CLIENT_COUNT,
            f"AC4 names all {EXPECTED_CLIENT_COUNT} clients; scanned "
            f"{sorted(sites)!r}")
        self.assertEqual(
            duplicated, {},
            f"AC4 -- ONE place: a client may call "
            f"`_crucible_axi.{TIER_REGISTRAR}` once, not once per tier "
            f"(client -> call lines): {duplicated!r}")
        self.assertEqual(
            wired, sorted(CLIENTS),
            f"`_crucible_axi.{TIER_REGISTRAR}` must be "
            f"invoked by EACH of the five clients; unwired: "
            f"{sorted(set(CLIENTS) - set(wired))!r}")
        self.assertEqual(
            derived_total, EXPECTED_CLIENT_COUNT,
            f"AC4's derived count -- exactly one "
            f"`{TIER_REGISTRAR}(...)` call site per client, "
            f"{EXPECTED_CLIENT_COUNT} in total across "
            f"{sorted(CLIENT_FILES)!r}; counted {derived_total} "
            f"(client -> lines: {sites!r})")


_TIER_UNION_RE = re.compile(r"export\s+type\s+Tier\s*=\s*([^;]+);", re.S)


def _tier_union_from_types_ts():
    """The `Tier` union of `src/types.ts`, parsed by SYMBOL.

    AC10's guard reads the server's vocabulary at TEST time (a test may read
    `src/`; a client may not -- an installed wheel has no `src/` to read). It
    is anchored on `export type Tier =` rather than on a line number, so an
    edit anywhere above it cannot silently move the guard onto another
    declaration.

    Returns `None` when the symbol is absent -- distinct from an empty union,
    and asserted as such below."""
    match = _TIER_UNION_RE.search(TYPES_TS_PATH.read_text())
    if match is None:
        return None
    return frozenset(re.findall(r'"([^"]*)"', match.group(1)))


def _string_collection_literals(path):
    """Every literal COLLECTION of strings in `path`: list/tuple/set literals
    whose elements are all string constants, and dict literals whose keys are.

    Both shapes count, because both are a vocabulary: `TIERS = ("unit", ...)`
    and `TIERS = {"unit": "...", ...}` mirror the union equally well, and a
    guard that only recognised one of them would be a guard GREEN could walk
    around by choosing the other. Returns `(lineno, frozenset(values))`."""
    found = []
    for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            elements = node.elts
        elif isinstance(node, ast.Dict):
            elements = [key for key in node.keys if key is not None]
        else:
            continue
        if not elements:
            continue
        if not all(isinstance(e, ast.Constant) and isinstance(e.value, str)
                   for e in elements):
            continue
        found.append((node.lineno, frozenset(e.value for e in elements)))
    return found


def _tier_mirrors(path):
    """Every string collection in `path` that is a COPY of the tier vocabulary:
    two or more of the six values together in one literal.

    Two, not six, on purpose. A copy that has DRIFTED (five of the six, or the
    six plus a seventh) is exactly what AC10's guard exists to catch, and a
    detector keyed on the complete set would go blind at precisely the moment
    it matters. One tier word alone is not a vocabulary -- `HELP_STEPS`
    (`clients/_crucible_axi.py:621`) legitimately keys `"regression"` beside
    non-tier verbs -- so the threshold is two."""
    return [(lineno, values) for lineno, values in _string_collection_literals(path)
            if len(values & TIER_VOCABULARY) >= 2]


class TierVocabularyMirrorDriftGuardTest(unittest.TestCase):
    """AC10 -- the vocabulary is mirrored ONCE on the client side, and the
    mirror cannot drift from `src/types.ts`.

    The pattern is the project's own: `canonical_track`
    (`clients/_crucible_axi.py:1434`) mirrors `normalizeTrack`
    (`src/store.ts:362-365`) and is "held to one rule by assertion (AC18), not
    by comment". This is that assertion for the tier vocabulary.

    The mirror is DERIVED, never named: any collection literal in the shared
    module carrying two or more of the six IS the mirror, whatever GREEN calls
    it (ESCALATION 2)."""

    def test_the_vocabulary_this_guard_reads_is_the_tier_union_of_src_types_ts(self):
        """PASSES TODAY -- the BOUND on the guard below, not a RED.

        Without it, a `Tier` union that stopped parsing would leave the drift
        guard comparing a mirror against an empty set and reporting agreement.
        It also ties this file's own `TIER_VERBS` literal to the server's
        declaration, so a seventh server-side value fails HERE rather than
        quietly narrowing every assertion in the file."""
        union = _tier_union_from_types_ts()
        self.assertIsNotNone(
            union,
            f"`export type Tier = ...;` must be parseable out of "
            f"{TYPES_TS_PATH} -- the drift guard's source of truth")
        self.assertEqual(
            set(union), set(TIER_VOCABULARY),
            f"the `Tier` union in src/types.ts and this suite's own "
            f"vocabulary must be the same set; src/types.ts says "
            f"{sorted(union)!r}, this suite says {sorted(TIER_VOCABULARY)!r}")

    def test_the_client_side_mirror_equals_the_tier_union_set_for_set(self):
        """CR-CRU-111 AC10 -- the tier vocabulary is mirrored on the client
        side in exactly ONE place, and that mirror equals the `Tier` union of
        `src/types.ts` set for set."""
        union = _tier_union_from_types_ts()
        self.assertIsNotNone(union, "`Tier` must parse out of src/types.ts")

        mirrors = _tier_mirrors(AXI_MODULE_PATH)
        self.assertEqual(
            len(mirrors), 1,
            f"the tier vocabulary must live in exactly ONE "
            f"place on the client side: a single mirror in "
            f"clients/_crucible_axi.py carrying a provenance comment naming "
            f"`Tier` in src/types.ts. Found {len(mirrors)} collection "
            f"literal(s) holding two or more of {sorted(TIER_VOCABULARY)!r} "
            f"(line -> values): "
            f"{[(line, sorted(values)) for line, values in mirrors]!r}")

        _, mirrored = mirrors[0]
        self.assertEqual(
            set(mirrored), set(union),
            f"AC10's DRIFT GUARD -- the client-side mirror "
            f"(clients/_crucible_axi.py:{mirrors[0][0]}) must equal the "
            f"`Tier` union of src/types.ts set for set; mirror has "
            f"{sorted(mirrored)!r}, src/types.ts declares {sorted(union)!r}")

    def test_no_client_file_carries_a_second_copy_of_the_tier_vocabulary(self):
        """CR-CRU-111 AC10, PASSES TODAY -- the second BOUND, and the half of
        AC10 that says what is FORBIDDEN: "a SECOND mirror: no per-client copy
        of the six values".

        It is green now only because no client holds ANY copy; it turns RED the
        moment GREEN hand-rolls `choices=("unit", ..., "bdd")` in a client
        alongside the shared registrar -- which is the exact drift §S1 is
        written to prevent, and which the single-mirror assertion above cannot
        see (it reads the shared module alone)."""
        offenders = {}
        for client, path in CLIENT_FILES.items():
            mirrors = _tier_mirrors(path)
            if mirrors:
                offenders[client] = [(line, sorted(values))
                                     for line, values in mirrors]
        self.assertEqual(
            len(CLIENT_FILES), EXPECTED_CLIENT_COUNT,
            f"all {EXPECTED_CLIENT_COUNT} clients must be scanned for a "
            f"second copy; scanned {sorted(CLIENT_FILES)!r}")
        self.assertEqual(
            offenders, {},
            f"what is FORBIDDEN is a SECOND mirror. These "
            f"clients carry their own copy of the tier vocabulary instead of "
            f"taking it from clients/_crucible_axi.py: {offenders!r}")


class RetiredTierFlagTest(unittest.TestCase):
    """AC11 -- the `--tier` FLAG stays retired.

    THIS TEST PASSES TODAY AND IS EXPECTED TO. It is a REGRESSION PIN, not a
    RED, and saying so is the point: `add_argument("--tier` returns zero across
    `clients/` right now, and AC11's own words are "as today". CR-CRU-008's
    contract named a `--tier` flag that NO client ever implemented; this CR
    settles that question the other way -- the tier is a VERB (§S1) -- so the
    flag must not appear later as a plausible-looking second spelling of the
    same fact. The pin is where that decision is recorded in executable form.

    A RED cycle that quietly shipped this as though it were failing would be
    claiming work it did not do, which is why the colour is declared here and
    in the module docstring rather than left for a reader to infer."""

    def _scan_clients(self, spellings):
        hits = {}
        scanned = 0
        for path in sorted(CLIENTS_DIR.rglob("*")):
            if not path.is_file():
                continue
            try:
                text = path.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            scanned += 1
            for lineno, line in enumerate(text.splitlines(), start=1):
                if any(spelling in line for spelling in spellings):
                    hits.setdefault(
                        str(path.relative_to(REPO_ROOT)), []).append(lineno)
        return scanned, hits

    def test_the_never_implemented_tier_flag_appears_in_no_client(self):
        """CR-CRU-111 AC11 -- the `--tier` flag CR-CRU-008's contract named,
        and no client ever implemented, stays RETIRED: this CR settles that
        question the other way, so the flag must not reappear as a second
        spelling of the tier VERB."""
        scanned, hits = self._scan_clients(RETIRED_TIER_FLAG_SPELLINGS)

        # Non-vacuity: the SAME scan must find a flag that IS declared, or
        # "zero hits" would only prove the scanner read nothing.
        probe_scanned, probe_hits = self._scan_clients(_SCAN_PROBE_SPELLINGS)
        self.assertEqual(scanned, probe_scanned)
        self.assertGreaterEqual(
            len(probe_hits), EXPECTED_CLIENT_COUNT,
            f"the scan must SEE real `add_argument(...)` declarations before "
            f"its silence about `--tier` means anything; the probe found "
            f"`--agent` in only {sorted(probe_hits)!r}")

        self.assertEqual(
            hits, {},
            f"the `--tier` flag is RETIRED: the tier is a VERB (§S1), so "
            f"`add_argument(\"--tier` must return zero across clients/. "
            f"Found: {hits!r}")


if __name__ == "__main__":
    unittest.main()
