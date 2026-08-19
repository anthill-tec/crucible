"""CR-CRU-054 §S3 -- the drift guard.

The CR's own words: "Add a test asserting no function name is defined in
more than one client unless it is on an explicit, justified per-client
allow-list (the §S1 GENUINELY-PER-CLIENT set). Without this the fleet
re-diverges the first time someone copies a helper, and the whole exercise
is undone by attrition." This module is that test, plus the analyser it
runs on and the proof that the analyser actually bites.

FILE PLACEMENT -- a NEW file, not an extension of
`test_cr054_fleet_inventory.py`. That module is the CLASSIFICATION fixture
(the §S1 deliverable: names as data, partition tests, per-name reality
checks). This module is the ENFORCEMENT mechanism §S3 asks for: a
regression guard that must keep working long after the classification
narrative stops being read. Bundling them would mix "here is what the fleet
looks like today" with "this must never regress" in one file; splitting
them means the drift guard can be pointed at, and reasoned about,
independently -- including being handed synthetic sources it has never seen
(the requirement 3 proof below). The classification data itself is not
re-derived here -- it is loaded from `test_cr054_fleet_inventory.py` by path
(the SAME `importlib.util.spec_from_file_location` idiom this directory's
other cr054 tests already use to load a CLIENT module), so the two files
can never silently drift apart from each other.

SCOPE DECISION -- this guard's BLOCKING assertion covers THE_42, the CR's
own fully classified inventory (docs/research/DN-client-fleet-inventory.md),
not every duplicated name across the whole fleet. A full-fleet sweep (this
module's analyser CAN be pointed at the whole fleet -- that generality is
exactly what requirement 3 needs) finds roughly two dozen MORE duplicated
names outside THE_42 (docker-compose helpers shared by rust/mvn,
`_parse_junit`/`cmd_compile`/`cmd_unit` shared by mvn/arduino,
`_emit_ingest_axi`-family helpers, `_read_env`, `_run_logged`, ...) that
this CR's own DN never inventoried or classified. Guarding those here would
mean inventing GENUINELY-PER-CLIENT verdicts for names nobody has read the
five bodies of yet -- exactly the "scope absorption" this CR's own Risk
section warns against doing unilaterally. That is real, separately-scoped
backlog for a follow-up inventory cycle, not silently swallowed: it is
reported in the RED agent's run notes, not asserted on here.

Four requirements, four things below:
  1. `NoUnjustifiedDuplicateFunctionsTest` -- the core assertion.
  2. `AllowListIsBoundedAndJustifiedTest` -- the allow-list can't become a
     dumping ground: it must equal the DN's GENUINELY-PER-CLIENT set plus
     the two bootstrap-loader exceptions, nothing more, and every entry
     must carry a real reason.
  3. `DriftGuardAnalyserProofTest` -- the analyser, pointed at synthetic
     in-memory sources, both catches a reintroduced duplicate and does NOT
     flag a legitimate thin delegator.
  4. `DriftGuardCatchesReintroducedDuplicateOnScratchFilesTest` -- the same
     proof again, on-disk, via real client files copied into a tempdir
     (never `clients/` itself) with a duplicate appended.
"""

import ast
import importlib.util
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}


def _load_module_by_path(path, cache_key):
    """Load a module by file path -- mirrors the fleet's own `_axi()`/
    `_toon()` loader pattern, and the SAME idiom this directory's other
    cr054 test files already use to load a CLIENT module. Used here to load
    a SIBLING TEST module (the classification fixture) instead."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_FLEET_INVENTORY = _load_module_by_path(
    Path(__file__).resolve().parent / "test_cr054_fleet_inventory.py",
    "cr054_drift_guard_fleet_inventory_under_test")

THE_42 = _FLEET_INVENTORY.THE_42
SHARED = _FLEET_INVENTORY.SHARED
PARAMETERISED = _FLEET_INVENTORY.PARAMETERISED
GENUINELY_PER_CLIENT = _FLEET_INVENTORY.GENUINELY_PER_CLIENT
DRIFTED = _FLEET_INVENTORY.DRIFTED


# THE ANALYSER -- generic on purpose: every function below takes a bag of
# already-parsed sources (or raw source text) and answers its question the
# same way whether the sources are the five real clients or a synthetic
# fixture nobody has ever seen. Requirement 3's proof depends on this never
# being hardcoded to `CLIENT_FILES`.

DELEGATION_MARKERS = ("_axi().", ".http_request(")


def _function_defs(source_text, filename="<source>"):
    """name -> ast.FunctionDef/AsyncFunctionDef, TOP-LEVEL only, for one
    source string. Top-level (not `ast.walk`) on purpose: a duplicate
    NESTED closure of the same name is not the drift this guard is about --
    "no client retains a private copy" is a statement about the client
    module's own public/module-level surface."""
    tree = ast.parse(source_text, filename=filename)
    return {n.name: n for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def _strip_docstring(body):
    if (body and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)):
        return body[1:]
    return body


def _is_print_statement(stmt):
    return (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Name)
            and stmt.value.func.id == "print")


def is_thin_delegator(name, funcs, _seen=frozenset()):
    """True iff `funcs[name]`'s body -- docstring and any bare `print(...)`
    logging calls aside -- is a SINGLE statement that either:
      (a) calls through to the shared module directly: its unparsed source
          contains one of DELEGATION_MARKERS (the fleet's own established
          `_axi().something(...)` convention), or
      (b) calls another LOCAL, bare-name function that is ITSELF a thin
          delegator by this same rule (one level of local-wrapper
          indirection per hop, e.g. `_post` -> `_request` ->
          `_axi().http_request(...)`, or `cmd_cycle_activate` ->
          `_cycle_transition` -> `_axi().cycle_transition(...)`).
    `_seen` guards a theoretical call cycle from recursing forever.

    This is the reusable primitive requirement 3 needs: point it at ANY
    `funcs` mapping (a real client's top-level defs, or two lines of
    synthetic source parsed on the fly) and it answers the same question
    the same way -- it has no special-cased knowledge of `clients/`.
    """
    if name not in funcs or name in _seen:
        return False
    body = _strip_docstring(funcs[name].body)
    core = [s for s in body if not _is_print_statement(s)]
    if len(core) != 1:
        return False
    stmt = core[0]
    if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Call):
        call = stmt.value
    elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        call = stmt.value
    else:
        return False
    if any(marker in ast.unparse(call) for marker in DELEGATION_MARKERS):
        return True
    func = call.func
    if isinstance(func, ast.Name):
        return is_thin_delegator(func.id, funcs, _seen | {name})
    return False


def duplicated_function_names(per_source_funcs):
    """{name: [source_key, ...]} for every name defined (top-level) in two
    or more of the given sources. `per_source_funcs` is
    `{source_key: {name: FunctionDef}}` -- the same shape whether the
    sources are the five real clients or a synthetic fixture set, so this
    generalises exactly like `is_thin_delegator` does."""
    seen = defaultdict(list)
    for source_key, funcs in per_source_funcs.items():
        for name in funcs:
            seen[name].append(source_key)
    return {name: keys for name, keys in seen.items() if len(keys) >= 2}


# THE FLEET, TODAY -- parsed once, top-level only.
_CLIENT_SOURCES = {c: p.read_text() for c, p in CLIENT_FILES.items()}
_CLIENT_FUNCS = {
    c: _function_defs(src, filename=str(CLIENT_FILES[c]))
    for c, src in _CLIENT_SOURCES.items()
}


# THE ALLOW-LIST -- requirement 2. EXACTLY the DN's §S1 GENUINELY-PER-CLIENT
# set (the CR's own words: "the §S1 GENUINELY-PER-CLIENT set"), plus two
# bootstrap-loader exceptions the DN documents but doesn't file under that
# heading (see the two entries' own comments below for why they still
# belong here). `AllowListIsBoundedAndJustifiedTest` enforces both halves
# of that sentence: the KEY SET is bounded, and every VALUE is a real
# justification, not a placeholder.
ALLOW_LIST = {
    # -- DN §3, verbatim reasoning --
    "cmd_auto_ingest": (
        "13-38 lines across the fleet: junit-if-present vs `cargo check` "
        "stderr vs coverage-tool invocation -- the exact per-toolchain "
        "fallback chain named in the CR's own Non-goals (DN §3)."),
    "cmd_check": (
        "compile/lint-gate invocation is 100% toolchain-specific (tsc, "
        "py_compile, cargo check, mvn compile, arduino-cli via arduino's "
        "own _compile_gate tier helper -- arduino's cmd_check is a 4-line "
        "delegator to it) (DN §3)."),
    "cmd_pre_merge_gate": (
        "confirmed by full-body read: mvn runs a docker-up/regression/"
        "docker-down bracket; rust runs a workspace clippy gate then "
        "cmd_workspace_regression; bun/python/arduino run a check-then-"
        "regression pair shaped by that stack's OWN cmd_check/cmd_regression "
        "signature. No shared shape survives past 'fail-fast pre-step, then "
        "regression' (DN §3)."),
    "cmd_test": (
        "4-75 lines: bun test vs pytest/unittest+xmlrunner vs cargo-nextest "
        "vs maven surefire vs arduino's native-tier delegator (DN §3)."),
    "main": (
        "183-452 lines: argparse subcommand wiring is inherently "
        "per-toolchain -- different flag sets per verb per stack (DN §3)."),
    "_project_key": (
        "arduino delegates to its own _load_env(pd), which ALSO reads "
        "CRUCIBLE_PROJECT_NAME for arduino's unique self-registration "
        "bootstrap (POST /api/projects/add, DN-crucible-api-reconstruction."
        "md §4); the other four are a strict single-key .env-only read "
        "with sys.exit on absence. Real divergence tied to a "
        "responsibility outside this CR's 42 (DN §3)."),
    # -- outside the DN §3 table, but the SAME bootstrap constraint the CR's
    # own §S2 binding constraint states applies: "clients/*-crucible.py are
    # vendored into consumer repos and load _crucible_axi.py by file path" --
    # `_axi`/`_toon` ARE that per-client loading shim, so they structurally
    # CANNOT delegate to the module they load. DN §1 already classifies
    # them SHARED and notes "the ONLY per-client-varying token is the
    # importlib.util.spec_from_file_location cache-key STRING", requiring
    # it be "derived from __name__, not a hardcoded per-client string" --
    # verified true on today's tree (every client's cache key is
    # f'{__name__}_axi_shared' / f'{__name__}_toon', not a literal), so the
    # duplication that remains is exactly the bootstrap shim the binding
    # constraint requires, not drift.
    "_axi": (
        "the shared-module loader itself (importlib.util."
        "spec_from_file_location) -- cannot delegate to the module it "
        "loads; the CR's own §S2 binding constraint requires every client "
        "to carry this shim locally (DN §1)."),
    "_toon": (
        "the toon-codec loader itself -- same bootstrap constraint as "
        "_axi, same DN §1 note."),
}


class NoUnjustifiedDuplicateFunctionsTest(unittest.TestCase):
    """The core §S3 assertion, scoped to THE_42 (see module docstring's
    SCOPE DECISION): every name in THE_42 that is duplicated across clients
    must be EITHER a thin delegator in every client that defines it, OR on
    ALLOW_LIST. Anything else is exactly the attrition the CR's own §S3
    prose warns about -- a private per-client copy that survived (or crept
    back into) the lift.
    """

    def test_every_the_42_duplicate_is_a_delegator_or_on_the_allow_list(self):
        offenders = {}
        for name in sorted(THE_42):
            defining_clients = [c for c in CLIENT_FILES if name in _CLIENT_FUNCS[c]]
            if len(defining_clients) < 2:
                continue  # not a fleet-wide duplicate; not this test's concern
            if name in ALLOW_LIST:
                continue
            non_delegators = [
                c for c in defining_clients
                if not is_thin_delegator(name, _CLIENT_FUNCS[c])
            ]
            if non_delegators:
                offenders[name] = non_delegators
        self.assertEqual(
            offenders, {},
            "CR-CRU-054 §S3 drift guard: the following THE_42 names are "
            "duplicated across clients but are NEITHER thin delegators to "
            "_crucible_axi NOR on the justified ALLOW_LIST -- each is "
            "REMAINING LIFT BACKLOG (a private per-client copy CR-CRU-054's "
            "own §S2/§S2b consolidation has not yet retired), not a defect "
            "in this guard: " + repr(offenders))

    def test_the_already_lifted_shared_and_parameterised_names_are_confirmed_delegators(self):
        """Positive control: every SHARED/PARAMETERISED name that is NOT a
        bootstrap loader must be found as a delegator in EVERY client
        today. This guards the opposite failure mode from the test above --
        an analyser that (by some future edit) stops recognising the
        fleet's own `_axi()....` convention would make THIS test fail
        loudly, rather than letting the offenders test above silently
        over-report or under-report."""
        confirmed = (SHARED | PARAMETERISED) - {"_axi", "_toon"}
        not_confirmed = {}
        for name in sorted(confirmed):
            bad_clients = [
                c for c in CLIENT_FILES
                if name in _CLIENT_FUNCS[c]
                and not is_thin_delegator(name, _CLIENT_FUNCS[c])
            ]
            if bad_clients:
                not_confirmed[name] = bad_clients
        self.assertEqual(
            not_confirmed, {},
            "the analyser must confirm every already-lifted SHARED/"
            "PARAMETERISED name as a delegator in every client; a miss "
            "here means the DETECTOR regressed, not the fleet: "
            + repr(not_confirmed))


class AllowListIsBoundedAndJustifiedTest(unittest.TestCase):
    """The allow-list is only meaningful if it can't quietly grow: bound it
    to EXACTLY the DN's classified per-client set (plus the two documented
    bootstrap exceptions), and require every entry to carry a real reason."""

    def test_allow_list_keys_are_exactly_the_dn_set_plus_the_bootstrap_loaders(self):
        self.assertEqual(
            set(ALLOW_LIST), GENUINELY_PER_CLIENT | {"_axi", "_toon"},
            "ALLOW_LIST must be EXACTLY the DN's §S1 GENUINELY-PER-CLIENT "
            "set plus the two bootstrap loaders (_axi, _toon) -- anything "
            "else added here is the scope creep this guard exists to "
            "prevent, not permit")

    def test_every_allow_list_entry_carries_a_real_justification(self):
        for name, reason in ALLOW_LIST.items():
            self.assertIsInstance(reason, str)
            self.assertGreaterEqual(
                len(reason), 20,
                f"{name}'s allow-list entry must carry an actual one-line "
                f"justification tied to the DN, not a placeholder: "
                f"{reason!r}")


class DriftGuardAnalyserProofTest(unittest.TestCase):
    """AC: 'The §S3 drift guard fails when a duplicate is reintroduced --
    proven by adding one temporarily.' This is the pure, in-memory half of
    that proof: the SAME analyser used above (`_function_defs` /
    `duplicated_function_names` / `is_thin_delegator`), pointed at
    SYNTHETIC source strings it has never seen, so the detection logic
    itself -- not just today's fleet snapshot -- is what is under test."""

    def test_a_reintroduced_non_delegator_duplicate_is_flagged(self):
        source = (
            "def _totally_new_copy_pasted_helper(payload):\n"
            "    cleaned = {}\n"
            "    for key, value in payload.items():\n"
            "        if value is not None:\n"
            "            cleaned[key] = value\n"
            "    return cleaned\n"
        )
        funcs = {
            "synthetic_client_a": _function_defs(source, "synthetic_a.py"),
            "synthetic_client_b": _function_defs(source, "synthetic_b.py"),
        }
        dups = duplicated_function_names(funcs)
        self.assertIn(
            "_totally_new_copy_pasted_helper", dups,
            "the analyser must find a function name copy-pasted into two "
            "synthetic sources")
        offenders = [
            c for c in dups["_totally_new_copy_pasted_helper"]
            if not is_thin_delegator("_totally_new_copy_pasted_helper", funcs[c])
        ]
        self.assertEqual(
            sorted(offenders), ["synthetic_client_a", "synthetic_client_b"],
            "a duplicated, non-delegator, non-allow-listed synthetic "
            "function must be flagged in BOTH synthetic copies -- exactly "
            "the shape a real copy-pasted helper takes, and exactly what "
            "CR-CRU-054 §S3's AC requires the guard to catch")

    def test_a_reintroduced_thin_delegator_duplicate_is_not_flagged(self):
        """Negative control on the same synthetic shape: a duplicated name
        whose body genuinely IS a thin `_axi()....` delegator in every copy
        must NOT be flagged -- otherwise the guard would reject the very
        lift pattern CR-CRU-054 §S2 established as correct."""
        source = "def _thin(x):\n    return _axi().something(x)\n"
        funcs = {
            "synthetic_client_a": _function_defs(source, "synthetic_a.py"),
            "synthetic_client_b": _function_defs(source, "synthetic_b.py"),
        }
        dups = duplicated_function_names(funcs)
        self.assertIn("_thin", dups)
        offenders = [
            c for c in dups["_thin"]
            if not is_thin_delegator("_thin", funcs[c])
        ]
        self.assertEqual(
            offenders, [],
            "a duplicated name whose body is a thin _axi()... delegator in "
            "every copy must NOT be flagged as drift")


class DriftGuardCatchesReintroducedDuplicateOnScratchFilesTest(unittest.TestCase):
    """The second half of the 'proven by adding one temporarily' AC: the
    SAME proof again, but on-disk, against REAL client files copied into a
    tempdir (never `clients/` itself) with a duplicate appended -- so the
    proof covers the analyser being pointed at an actual file on disk, not
    only bare strings held in memory."""

    REINTRODUCED_DUPLICATE_SOURCE = (
        "\n\n"
        "def _scratch_reintroduced_helper(payload):\n"
        "    \"\"\"Exactly the shape a careless copy-paste would take: real\n"
        "    conditional logic, no delegation to the shared module.\"\"\"\n"
        "    cleaned = {}\n"
        "    for key, value in payload.items():\n"
        "        if value is not None:\n"
        "            cleaned[key] = value\n"
        "    return cleaned\n"
    )

    def test_reintroducing_a_duplicate_on_two_scratch_client_copies_is_flagged(self):
        with tempfile.TemporaryDirectory(prefix="cr054-s3-drift-guard-proof-") as tmp:
            tmp_path = Path(tmp)
            scratch_bun = tmp_path / "scratch-bun-crucible.py"
            scratch_rust = tmp_path / "scratch-rust-crucible.py"
            scratch_bun.write_text(
                CLIENT_FILES["bun"].read_text() + self.REINTRODUCED_DUPLICATE_SOURCE)
            scratch_rust.write_text(
                CLIENT_FILES["rust"].read_text() + self.REINTRODUCED_DUPLICATE_SOURCE)

            # Never touched the real files -- confirm it.
            self.assertNotIn(
                "_scratch_reintroduced_helper", CLIENT_FILES["bun"].read_text(),
                "the proof must never mutate the real client file")
            self.assertNotIn(
                "_scratch_reintroduced_helper", CLIENT_FILES["rust"].read_text(),
                "the proof must never mutate the real client file")

            scratch_funcs = {
                "scratch-bun": _function_defs(scratch_bun.read_text(), str(scratch_bun)),
                "scratch-rust": _function_defs(scratch_rust.read_text(), str(scratch_rust)),
            }
            dups = duplicated_function_names(scratch_funcs)
            self.assertIn(
                "_scratch_reintroduced_helper", dups,
                "the analyser must find the reintroduced duplicate across "
                "the two on-disk scratch client copies")
            offenders = [
                c for c in dups["_scratch_reintroduced_helper"]
                if not is_thin_delegator("_scratch_reintroduced_helper",
                                          scratch_funcs[c])
                and "_scratch_reintroduced_helper" not in ALLOW_LIST
            ]
            self.assertEqual(
                sorted(offenders), ["scratch-bun", "scratch-rust"],
                "the §S3 drift guard must flag a reintroduced duplicate on "
                "BOTH scratch copies -- this is the AC's proof: 'the guard "
                "fails when a duplicate is reintroduced', reproduced here "
                f"on real (scratch-copied) client files: offenders="
                f"{offenders!r}")


# ---------------------------------------------------------------------------
# CR-CRU-064 §S5 — the no-report helper is DEFINED ONCE.
#
# The CR's Context measured the drift this guard closes: rust owns
# `_no_junit_help(verb)` (`rust-crucible.py:360`, consumed at :900/:1396/:1523)
# and mvn inlines the `no-test-reports` warning dict inside
# `_emit_compile_fallback_axi` (`mvn-crucible.py:894-909`) -- two local
# implementations of ONE fleet concept, the CR-CRU-054 drift class, while the
# shared module carries no no-report helper at all. AC3 requires the local
# definition GONE and both clients emitting through
# `no_report_help`/`no_report_warning`.
#
# `_emit_compile_fallback_axi` deliberately SURVIVES: it is an emitter, not a
# help/warning builder, and becomes a thin caller sourcing its `help[]` and
# `warnings[]` from the shared pair. What may not survive is a client-local
# DEFINITION of the text or the warning code.
# ---------------------------------------------------------------------------

BANNED_LOCAL_NO_REPORT_HELPERS = ("_no_junit_help",)
SHARED_NO_REPORT_HELPERS = ("no_report_help", "no_report_warning")
NO_REPORT_WARNING_CODE = "no-test-reports"
NO_REPORT_HELP_PROSE = ("produced no junit.xml", "produced no surefire reports")


class NoClientDefinesItsOwnNoReportHelperTest(unittest.TestCase):
    """CR-CRU-064 §S5/AC3 + AC9 — no client defines its own no-report
    help/envelope helper; the shared module is the only definition.

    RED today by construction: rust still defines `_no_junit_help` and mvn
    still inlines the `no-test-reports` literal."""

    def _non_shared_client_sources(self):
        """Every `clients/*.py` EXCEPT the shared module itself -- the shared
        module is where all of this is supposed to live."""
        return {path.name: path.read_text()
                for path in sorted(CLIENTS_DIR.glob("*.py"))
                if path.name != AXI_MODULE_PATH.name}

    def test_no_client_defines_a_local_no_report_help_builder(self):
        offenders = {}
        for client, funcs in sorted(_CLIENT_FUNCS.items()):
            for banned in BANNED_LOCAL_NO_REPORT_HELPERS:
                if banned in funcs:
                    offenders.setdefault(client, []).append(banned)
        self.assertEqual(
            offenders, {},
            f"CR-CRU-064 AC3: no client may define its own no-report help "
            f"builder -- {BANNED_LOCAL_NO_REPORT_HELPERS} belong in "
            f"clients/_crucible_axi.py as no_report_help/no_report_warning "
            f"and nowhere else; local definitions found: {offenders!r}")

    def test_the_no_test_reports_warning_code_literal_lives_only_in_the_shared_module(self):
        """The warning CODE is the half that catches mvn: it is inlined at
        `mvn-crucible.py:905` rather than sourced from the shared builder, so
        the code string is a second, hand-copied definition."""
        offenders = sorted(
            name for name, src in self._non_shared_client_sources().items()
            if NO_REPORT_WARNING_CODE in src)
        self.assertEqual(
            offenders, [],
            f"CR-CRU-064 AC3: the {NO_REPORT_WARNING_CODE!r} literal must "
            f"appear ONLY in clients/{AXI_MODULE_PATH.name} (built by "
            f"no_report_warning); clients still spelling it themselves: "
            f"{offenders!r}")

    def test_no_client_spells_its_own_no_report_help_prose(self):
        """The help TEXT is the other copied half -- rust's 'produced no
        junit.xml' and mvn's 'produced no surefire reports' are two hand-written
        renderings of one sentence, which `no_report_help(verb, artifact)`
        parameterises."""
        offenders = {}
        for name, src in self._non_shared_client_sources().items():
            found = [prose for prose in NO_REPORT_HELP_PROSE if prose in src]
            if found:
                offenders[name] = found
        self.assertEqual(
            offenders, {},
            f"CR-CRU-064 AC3: the no-report help prose must be produced by "
            f"the shared no_report_help(verb, artifact), never spelled out in "
            f"a client; still hand-written in: {offenders!r}")

    def test_rust_and_mvn_emit_through_the_shared_no_report_helpers(self):
        """The positive half of the cutover (AC3): deleting the local copies
        is only correct if those sites now SOURCE the shared pair -- otherwise
        the guard could be satisfied by deleting the behaviour."""
        missing = {}
        for client in ("rust", "mvn"):
            source = CLIENT_FILES[client].read_text()
            absent = [h for h in SHARED_NO_REPORT_HELPERS if h not in source]
            if absent:
                missing[client] = absent
        self.assertEqual(
            missing, {},
            f"CR-CRU-064 AC3: rust (:900/:1396/:1523) and mvn's compile/"
            f"no-reports path must emit through the shared "
            f"{SHARED_NO_REPORT_HELPERS} -- a clean cutover, no aliases; "
            f"clients not referencing them: {missing!r}")


# ---------------------------------------------------------------------------
# CR-CRU-065 §S3 — the guard EXTENDS, it does not fork.
#
# C1 gave `no_report_warning(..., cause=None)` an override so a stack can
# SELECT the informative fragment; C2 makes mvn pass one via a pure
# `_select_maven_no_report_cause`. The risk the CR names: an override is a
# door to per-stack drift. §S3's rule draws the line — SELECTION may live in a
# client, COMPOSITION may not. The composition is everything that made the
# helper shared: the untruncated prefix, the `NO_REPORT_DETAIL_MAX` bound, and
# the `; last output line: ` joiner. A client may compute a plain cause
# STRING; it may never re-derive the envelope around it.
# ---------------------------------------------------------------------------

# The distinctive signatures of `no_report_warning`'s composition. A client
# holding any of these is re-implementing the shared envelope, not selecting a
# cause. (` · ` is deliberately NOT a marker: it is a plain string joiner a
# selector legitimately uses, and mvn's progress narrator already spells it.)
NO_REPORT_COMPOSITION_MARKERS = (
    "; last output line: ",
    "NO_REPORT_DETAIL_MAX",
    "before writing a report",
)

MVN_CAUSE_SELECTOR = "_select_maven_no_report_cause"


def _composition_markers_in(source_text):
    """Generic (requirement-3 style): the composition markers present in ANY
    source text, real client or synthetic fixture."""
    return [m for m in NO_REPORT_COMPOSITION_MARKERS if m in source_text]


class NoClientReimplementsNoReportCompositionTest(unittest.TestCase):
    """CR-CRU-065 §S3 — no client re-implements the no-report envelope
    composition; a client may hold a SELECTOR that produces a plain cause
    string, but the prefix/bound/joiner stay only in the shared module.

    RED today by construction: mvn does not yet expose the selector (§S2), so
    the positive `selection is allowed AND has landed` clause cannot hold."""

    def _non_shared_client_sources(self):
        return {path.name: path.read_text()
                for path in sorted(CLIENTS_DIR.glob("*.py"))
                if path.name != AXI_MODULE_PATH.name}

    def test_selection_may_be_local_but_composition_stays_shared(self):
        # The analyser has teeth AND is discriminating: a scratch client that
        # re-derives the composition is flagged; a scratch client that holds
        # ONLY a selector returning a plain cause string is not.
        reimplements_composition = (
            "def no_report_warning(verb, artifact, exit_code, output):\n"
            "    prefix = f'{verb} produced no {artifact} — the runner exited '\\\n"
            "             f'{exit_code} before writing a report'\n"
            "    joiner = '; last output line: '\n"
            "    room = NO_REPORT_DETAIL_MAX - len(prefix) - len(joiner)\n"
            "    return {'code': 'no-test-reports', 'detail': prefix + joiner + output[:room]}\n"
        )
        selector_only = (
            "def _select_maven_no_report_cause(output):\n"
            "    frag = []\n"
            "    for line in output.splitlines():\n"
            "        if line.startswith('[ERROR]') and ':[' in line:\n"
            "            frag.append(line)\n"
            "    return ' · '.join(frag[:3]) or None\n"
        )
        self.assertNotEqual(
            _composition_markers_in(reimplements_composition), [],
            "the §S3 guard must FLAG a client that re-implements the "
            "prefix/bound/joiner composition")
        self.assertEqual(
            _composition_markers_in(selector_only), [],
            "the §S3 guard must ALLOW a client that only SELECTS a plain "
            "cause string (a selector is not composition)")

        # The real fleet: the composition markers live ONLY in the shared
        # module -- no non-shared client re-derives the envelope.
        offenders = {name: found
                     for name, found in
                     ((n, _composition_markers_in(s))
                      for n, s in self._non_shared_client_sources().items())
                     if found}
        self.assertEqual(
            offenders, {},
            f"CR-CRU-065 §S3: the no-report envelope composition "
            f"({NO_REPORT_COMPOSITION_MARKERS}) must live ONLY in "
            f"clients/{AXI_MODULE_PATH.name}; clients re-implementing it: "
            f"{offenders!r}")

        # And the positive half (RED driver): mvn's SELECTION has landed as a
        # pure selector, and it does so WITHOUT dragging the composition into
        # the client -- selection local, composition shared.
        mvn_src = CLIENT_FILES["mvn"].read_text()
        self.assertIn(
            MVN_CAUSE_SELECTOR, mvn_src,
            f"CR-CRU-065 §S2/§S3: mvn must hold its own pure "
            f"{MVN_CAUSE_SELECTOR}(output) selector")
        self.assertEqual(
            _composition_markers_in(mvn_src), [],
            f"CR-CRU-065 §S3: mvn may SELECT a cause but must NOT re-implement "
            f"the composition; markers found in mvn: "
            f"{_composition_markers_in(mvn_src)!r}")


if __name__ == "__main__":
    unittest.main()
