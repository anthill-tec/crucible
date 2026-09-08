"""CR-CRU-111 — what a tier VERB contracts to do: state its own tier on the
wire (AC2), and keep every flag it had before it was migrated onto the shared
registration (AC16).

Two acceptance criteria, both found UNASSERTED at VERIFY and both closed here
at cycle 385. They share a file because they are the two halves of one
question — what a caller gets when it invokes a tier verb — and because they
share one harness.

  * **AC2** — "the tier a run is stamped with is the tier the caller stated,
    asserted on the POST body the client sends (`payload["tier"]`) for each of
    the six values."
  * **AC16** — "AC5's flag retention is asserted for all EIGHT migrated verbs,
    not four, by comparing each verb's resolved argparse option set before and
    after rather than by driving a chosen flag."

HOW "BEFORE" IS OBTAINED, and why it is NOT a base ref — repaired at
CR-CRU-112 cycle 388, which is the CR that found this file red on a branch
nobody had touched it from:

  This file originally read "before" as `git show develop:<file>`. That
  comparison SELF-INVALIDATES on merge: the moment CR-CRU-111 merged into
  `develop`, the base ref and the working tree became the same thing, the
  derivation returned all THIRTY of today's tier verbs instead of the eight
  that existed before the migration, and every comparison became a tautology
  (`test_the_migrated_verbs_are_the_eight_the_base_ref_shipped` and
  `test_the_verbs_the_base_ref_did_not_have_are_not_counted_as_migrated` both
  failed, and the one in between silently measured nothing).

  "Before" is a HISTORICAL FACT, so it is recorded as one:
  `MIGRATED_VERB_OPTIONS` below is a named, dated snapshot — the eight verbs'
  resolved option sets as `develop`@`d804286` shipped them, the pre-migration
  commit AC5 enumerated on, read off those clients' own parsers on 2026-09-08.
  It cannot rot when a branch merges, and it is the same guarantee: a verb that
  answers to fewer flags than that fails, whatever the branch topology is
  today. DO NOT reintroduce a base-ref read here.

WHAT VERIFY MEASURED, because both ACs exist for a measured reason and not a
suspicion:

  AC2 had NO test referencing it at all, and could not have had a complete
  one: only five of the six values were observable on the wire, because `bdd`
  was absent from every client's `funcs` map, so no invocation could produce
  `"tier": "bdd"`. That was the visible end of §S6's missing half. Cycle 384
  built declaration detection, `bdd` became producible through a declared
  target (AC14c), and the sixth value became assertable — which is why this
  file could not have been written earlier.

  AC5's flag-retention half drove ONE chosen flag on four of the eight
  migrated verbs. Unasserted: mvn `unit`, mvn `e2e`, mvn `regression`, bun
  `regression`, and arduino `regression`'s `--coverage`. Driving a chosen flag
  also answers the wrong question — it proves that flag survived, not that the
  verb's SURFACE did.

RED or PIN, stated per test, because a suite that does not say which of its
members were born green is a suite whose colour means nothing:

  PIN  all six `…OnTheWireTest` classes and `SixTierValuesOnTheWireTest`
         (AC2). Every value reaches the wire today: cycles 379-384 wired the
         split cells, the earned verbs and the declared targets. What was
         missing was the assertion, and specifically the assertion that the
         SET is the whole vocabulary — five of six passing is exactly the
         state VERIFY found and could not detect.
  PIN  `MigratedVerbFlagRetentionTest` (AC16), all eight comparisons plus the
         derived count. "VERIFY measured 0 of 8 lost anything, so this AC pins
         a property that holds today; it exists because four of the eight were
         unasserted and a later migration would not be caught."

HOW THE EIGHT ARE FOUND, and why they are not a frozen list: AC5 defines them
as "EVERY pre-existing verb whose name is already a tier", so this file DERIVES
them — the subparser choices of each client as it stands on `develop`,
intersected with the six-value mirror. That returns exactly eight across four
clients, `rust` contributing none, which is AC5's own enumeration reproduced by
measurement. A ninth such verb appearing on `develop` joins the comparison with
no edit here; the count is asserted so it cannot silently become seven.

AND WHY THE OPTION SET IS READ FROM ARGPARSE, not from `--help`: the RESOLVED
set is what `parents=` and `add_args=` compose into the verb's parser, and help
TEXT also contains prose. A flag named in a sentence that was reworded by this
CR would read as a lost flag; a flag silently dropped from a parser whose help
still mentions it would read as retained. So the root parser is captured at its
`parse_args` call and the verb's `option_strings` are read off its actions —
the same object argparse itself matches against.

HARNESS: cycle 384's `test_client_tier_declaration_detection.py`, adopted whole
and through ITS instance of cycle 379's modality harness, so this file shares
one set of fake toolchains rather than standing up a second. Only NON-test
names are taken: importing one of its TestCases would run that cycle's suite a
second time under this module. AC2's declared cells reuse that file's own
declaration fixtures rather than building new ones — `module` on rust's
`.config/nextest.toml` profile and `bdd` on bun's `package.json` script are
literally the cells cycle 384 proved detectable.

Invocation:
    python3 -m pytest tests/client/test_client_tier_verb_contract.py -q
Fallback:
    python3 tests/client/test_client_tier_verb_contract.py
"""

import argparse
import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
DECLARATION_PATH = Path(__file__).resolve().parent / "test_client_tier_declaration_detection.py"

# AC16's "BEFORE", as a named and dated FACT rather than a branch that moves:
# the resolved option set of each of the eight pre-existing tier-named verbs as
# `develop`@`d804286` shipped them — the commit AC5 enumerated on, which is the
# first parent of CR-CRU-111's merge — read off those clients' own parsers on
# 2026-09-08 by the same `_option_strings` measurement this file makes today.
#
# A snapshot and NOT `git show <ref>:<file>`, repaired at CR-CRU-112 cycle 388:
# a base-ref comparison self-invalidates the moment the branch under
# measurement merges into the base, because the base and the tree become the
# same thing and every comparison becomes a tautology. See the module docstring.
# A NINTH pre-existing tier verb cannot appear now — "pre-existing" is a closed
# historical set — so this table is complete by construction.
MIGRATED_VERB_OPTIONS = {
    ("arduino", "regression"): (
        "--agent", "--coverage", "--cycle", "--dir", "--help",
        "--project-dir", "-h",
    ),
    ("arduino", "unit"): (
        "--agent", "--cycle", "--dir", "--help", "--project-dir", "-h",
    ),
    ("bun", "regression"): (
        "--agent", "--bun", "--coverage", "--cycle", "--help", "--log",
        "--no-lifecycle", "--package-dir", "--project-dir", "--reports", "-h",
    ),
    ("mvn", "e2e"): (
        "--agent", "--also-make", "--compose-file", "--failsafe-only",
        "--help", "--log", "--maven-dir", "--module", "--native", "--no-wait",
        "--profile", "--project-dir", "--system-prop", "--update-snapshots",
        "--with-docker", "-h",
    ),
    ("mvn", "module"): (
        "--agent", "--also-make", "--help", "--log", "--maven-dir",
        "--module", "--native", "--profile", "--project-dir", "--system-prop",
        "--update-snapshots", "-h",
    ),
    ("mvn", "regression"): (
        "--agent", "--also-make", "--coverage-profile", "--cycle", "--goal",
        "--help", "--log", "--maven-dir", "--module", "--native", "--profile",
        "--project-dir", "--system-prop", "--update-snapshots", "-h",
    ),
    ("mvn", "unit"): (
        "--agent", "--also-make", "--help", "--log", "--maven-dir",
        "--module", "--native", "--profile", "--project-dir", "--system-prop",
        "--test", "--update-snapshots", "-h",
    ),
    ("python", "regression"): (
        "--agent", "--cov-source", "--coverage", "--cycle", "--help", "--log",
        "--pattern", "--project-dir", "--python", "--reports", "--start-dir",
        "-h",
    ),
}


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 384's file, and THROUGH it cycle 379's modality harness — taking the
# modality file directly would build a SECOND scratch bin of fake toolchains
# and a second `_BIN_DIR`, and the fixtures below would then reference the
# wrong one.
_DECL = _load_module(DECLARATION_PATH, "cr111_c9_declaration_harness")

_BunDeclarationCase = _DECL._BunDeclarationCase
_RustDeclarationCase = _DECL._RustDeclarationCase
_MvnModalityCase = _DECL._MvnModalityCase

# The harness's own probe agent id, taken rather than re-spelled: the drive's
# `ingest_payloads` reads the POST bodies carrying THIS id, so a second
# constant here would silently make every assertion measure nothing.
AGENT = _DECL.AGENT
TIER_VOCABULARY = _DECL.TIER_VOCABULARY
DECLARED_CELLS = _DECL.DECLARED_CELLS


def setUpModule():
    _DECL.setUpModule()


def tearDownModule():
    _DECL.tearDownModule()


_PARSER_LOADS = {}


def _root_parser(client):
    """The client's ROOT argparse parser, captured at the moment it parses.

    `main()` builds the parser inline — there is no `build_parser()` seam in
    any client and inventing one would be production code this cycle may not
    write — so `parse_args` is spied on and the bound `self` kept. The verb is
    never dispatched: capturing the parser is the whole measurement."""
    key = client
    if key in _PARSER_LOADS:
        return _PARSER_LOADS[key]
    module = _load_module(CLIENTS_DIR / f"{client}-crucible.py",
                          f"cr111_c9_head_{client}")
    captured = {}

    def spy(self, args=None, namespace=None):
        captured.setdefault("root", self)
        raise SystemExit(0)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", spy), \
            mock.patch.object(sys, "argv", [f"{client}-crucible.py", "status"]), \
            contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()):
        try:
            module.main()
        except SystemExit:
            pass
    root = captured.get("root")
    assert root is not None, f"{client}-crucible.py never parsed its arguments"
    _PARSER_LOADS[key] = root
    return root


def _verb_parsers(client):
    root = _root_parser(client)
    for action in root._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action.choices
    return {}


def _option_strings(client, verb):
    """The RESOLVED option set of one verb AS IT STANDS: every option string
    argparse itself would match, `parents=` and `add_args=` already composed
    in. The snapshot above was taken by this same reading of the pre-migration
    clients, so the two sides of the comparison are measured alike."""
    parser = _verb_parsers(client)[verb]
    return frozenset(option for action in parser._actions
                     for option in action.option_strings)


def _migrated_tier_verbs():
    """AC5's eight — "EVERY pre-existing verb whose name is already a tier",
    read off the snapshot that records what those verbs were."""
    return tuple(sorted(MIGRATED_VERB_OPTIONS))


# ── AC2: each of the six values, on the wire ───────────────────────────────


class _TierOnTheWire:
    """The one measurement every AC2 case makes: drive a REAL invocation and
    read `payload["tier"]` off the POST body it produced."""

    TIER = ""
    INVOCATION = ""
    METHOD = ""

    def observe(self):
        """`{tier values this invocation put on the wire}`. Separate from the
        test method so `SixTierValuesOnTheWireTest` can drive all six and
        assert the SET, rather than trusting six independent tests to have
        covered the vocabulary between them."""
        raise NotImplementedError

    def tiers_on_the_wire(self, drive):
        self.assertNotEqual(
            drive.code, 2,
            f"AC2 — {self.INVOCATION}: argparse refused this invocation, so "
            f"nothing about the tier was measured: {drive.err[-500:]!r}")
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC2 — {self.INVOCATION}: nothing was ingested, so this drive "
            f"observed no tier at all. posted={[p for p, _ in drive.calls]!r} "
            f"exit={drive.code} stderr={drive.err[-1000:]!r}")
        return {payload.get("tier") for payload in payloads}

    def assertStatedOnTheWire(self):
        observed = self.observe()
        self.assertEqual(
            observed, {self.TIER},
            f"AC2 — {self.INVOCATION}: the caller stated {self.TIER!r}, so "
            f"every ingest this run produced must carry that tier and no "
            f"other; the wire carried {sorted(t for t in observed if t)!r}"
            f"{' plus an unstated ingest' if None in observed else ''}.")


class UnitOnTheWireTest(_MvnModalityCase, _TierOnTheWire):
    """AC2, `unit` — PIN. Driven through a TOOLCHAIN-SPLIT cell: maven's
    unscoped surefire run is the split its own lifecycle already makes, so
    nothing is declared and the tier comes from the verb."""

    TIER = "unit"
    INVOCATION = "mvn unit (surefire, a toolchain-split cell)"
    METHOD = "test_a_surefire_unit_run_states_unit_on_the_wire"

    def observe(self):
        self.write_reports()
        return self.tiers_on_the_wire(self.drive(self.mvn_argv("unit")))

    def test_a_surefire_unit_run_states_unit_on_the_wire(self):
        self.assertStatedOnTheWire()


class IntegrationOnTheWireTest(_MvnModalityCase, _TierOnTheWire):
    """AC2, `integration` — PIN. Maven's failsafe half, §S3's split cell."""

    TIER = "integration"
    INVOCATION = "mvn integration (failsafe, a toolchain-split cell)"
    METHOD = "test_a_failsafe_integration_run_states_integration_on_the_wire"

    def observe(self):
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        return self.tiers_on_the_wire(self.drive(self.mvn_argv("integration")))

    def test_a_failsafe_integration_run_states_integration_on_the_wire(self):
        self.assertStatedOnTheWire()


class E2eOnTheWireTest(_MvnModalityCase, _TierOnTheWire):
    """AC2, `e2e` — PIN. `mvn clean verify`, the phase failsafe's IT run binds
    to; a split cell and one of the two verbs whose tier was always earned."""

    TIER = "e2e"
    INVOCATION = "mvn e2e (failsafe IT, a toolchain-split cell)"
    METHOD = "test_a_failsafe_it_run_states_e2e_on_the_wire"

    def observe(self):
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        return self.tiers_on_the_wire(self.drive(self.mvn_argv("e2e")))

    def test_a_failsafe_it_run_states_e2e_on_the_wire(self):
        self.assertStatedOnTheWire()


class RegressionOnTheWireTest(_MvnModalityCase, _TierOnTheWire):
    """AC2, `regression` — PIN. The other verb whose own NAME is the tier, so
    §S2 leaves its stamp EARNED and standing."""

    TIER = "regression"
    INVOCATION = "mvn regression (the verb whose name is the tier)"
    METHOD = "test_a_regression_run_states_regression_on_the_wire"

    def observe(self):
        self.write_reports()
        return self.tiers_on_the_wire(self.drive(self.mvn_argv("regression")))

    def test_a_regression_run_states_regression_on_the_wire(self):
        self.assertStatedOnTheWire()


class ModuleOnTheWireTest(_RustDeclarationCase, _TierOnTheWire):
    """AC2, `module` — PIN. A DECLARED cell: "Cargo describes no MODULE
    boundary", so rust's `module` is declared as a `.config/nextest.toml`
    profile and RUN through it (AC14, cycle 384). The fixture is that cycle's
    own, not a new one."""

    TIER = "module"
    INVOCATION = "rust module (a DECLARED `.config/nextest.toml` profile)"
    METHOD = "test_a_declared_nextest_profile_states_module_on_the_wire"

    def observe(self):
        extra = self.declare(self.TIER)
        return self.tiers_on_the_wire(self.drive(self.run_argv(self.TIER, extra)))

    def test_a_declared_nextest_profile_states_module_on_the_wire(self):
        self.assertStatedOnTheWire()


class BddOnTheWireTest(_BunDeclarationCase, _TierOnTheWire):
    """AC2, `bdd` — PIN, and the value this whole AC waited on. It was
    unobservable at VERIFY: "only five of the six values could be observed on
    the wire, because `bdd` is absent from every client's `funcs` map — so no
    invocation could produce `"tier": "bdd"`". A declared `package.json`
    script is what makes the sixth value producible (AC14c)."""

    TIER = "bdd"
    INVOCATION = "bun bdd (a DECLARED `package.json` script)"
    METHOD = "test_a_declared_package_json_script_states_bdd_on_the_wire"

    def observe(self):
        extra = self.declare(self.TIER)
        return self.tiers_on_the_wire(self.drive(self.run_argv(self.TIER, extra)))

    def test_a_declared_package_json_script_states_bdd_on_the_wire(self):
        self.assertStatedOnTheWire()


_AC2_CASES = (UnitOnTheWireTest, ModuleOnTheWireTest, IntegrationOnTheWireTest,
              E2eOnTheWireTest, RegressionOnTheWireTest, BddOnTheWireTest)
TIER_DRIVES = {case.TIER: case for case in _AC2_CASES}


class SixTierValuesOnTheWireTest(unittest.TestCase):
    """AC2's set, OBSERVED — "for each of the six values".

    Six independent passing tests do not make this assertion: five of six is
    exactly the state VERIFY found, and every one of those five was green. So
    the six drives are run here as well, their observed tiers unioned, and the
    union compared against the vocabulary the fleet's own mirror declares. A
    missing value fails; a seventh value appearing in the mirror with no drive
    behind it fails; a run that put a different tier on the wire fails in its
    own class above."""

    def test_the_six_drives_cover_exactly_the_vocabulary_the_mirror_declares(self):
        self.assertEqual(
            set(TIER_DRIVES), set(TIER_VOCABULARY),
            "every `Tier` value must have an invocation behind it in this "
            "file, and no invocation may claim a value the mirror does not "
            "declare")
        self.assertEqual(
            len(_AC2_CASES), len(TIER_DRIVES),
            "two cases claiming the same tier would collapse in the registry "
            "and quietly leave a value undriven")
        for case in _AC2_CASES:
            self.assertTrue(
                hasattr(case, case.METHOD),
                f"{case.__name__}.METHOD names {case.METHOD!r}, which does not "
                f"exist — the aggregate below would drive a fixture no test "
                f"runs")

    def test_every_one_of_the_six_values_reaches_the_wire(self):
        observed = set()
        for tier, case_class in sorted(TIER_DRIVES.items()):
            case = case_class(case_class.METHOD)
            case.setUp()
            try:
                observed |= case.observe()
            finally:
                case.tearDown()
        self.assertEqual(
            observed, set(TIER_VOCABULARY),
            f"AC2 — the six invocations this file drives must put exactly the "
            f"six `Tier` values on the wire, one each. They put "
            f"{sorted(t for t in observed if t)!r}"
            f"{' and one ingest with NO tier' if None in observed else ''}. "
            f"Missing: {sorted(set(TIER_VOCABULARY) - observed)!r}; "
            f"unexpected: {sorted(t for t in observed - set(TIER_VOCABULARY) if t)!r}.")


# ── AC16: the eight migrated verbs keep every flag ─────────────────────────


class MigratedVerbFlagRetentionTest(unittest.TestCase):
    """AC16 — PIN, all eight. "EVERY pre-existing verb whose name is already a
    tier keeps its behaviour and its own flags after migrating onto the shared
    registration" (AC5), asserted as a SURFACE comparison rather than by
    driving one chosen flag: `arduino regression` keeping `--coverage` says
    nothing about `--dir`, and mvn `unit` was never asked about anything.

    The comparison is one-directional on purpose. A migrated verb may GAIN
    options — the shared registrar adds some, and §S6 ruling 4 requires the
    declared cells to accept their sibling's flags — but it may lose none.
    "a flag lost in the migration fails this AC"."""

    def test_the_migrated_verbs_are_the_eight_the_snapshot_records(self):
        """AC16's count — "Eight verbs across four clients; `rust` is the only
        client with no collision"."""
        migrated = _migrated_tier_verbs()
        self.assertEqual(
            len(migrated), 8,
            f"AC5 enumerated eight pre-existing tier-named verbs and the "
            f"snapshot records {len(migrated)}: {list(migrated)!r}. "
            f"`MIGRATED_VERB_OPTIONS` is a closed historical set — an entry "
            f"added or dropped there rewrites what 'before' means.")
        self.assertEqual(
            sorted({client for client, _verb in migrated}),
            ["arduino", "bun", "mvn", "python"],
            "the four clients with a tier-named verb before the migration; "
            "`rust` is the one with no collision")

    def test_no_migrated_verb_lost_an_option_in_the_migration(self):
        losses = {}
        for client, verb in _migrated_tier_verbs():
            with self.subTest(client=client, verb=verb):
                before = frozenset(MIGRATED_VERB_OPTIONS[(client, verb)])
                after = _option_strings(client, verb)
                self.assertTrue(
                    before,
                    f"AC16 — {client} {verb}: the snapshot records no options "
                    f"at all for this verb, so this comparison would pass "
                    f"against anything")
                lost = sorted(before - after)
                if lost:
                    losses[f"{client} {verb}"] = lost
                self.assertEqual(
                    lost, [],
                    f"AC16 — {client} {verb} lost {lost!r} in the migration "
                    f"onto the shared tier registration. AC5: 'everything "
                    f"stack-specific rides the `parents=`/`add_args=` "
                    f"injection'; a verb that answers to fewer flags than it "
                    f"did has had its behaviour changed by a levelling that "
                    f"was supposed to preserve it. It kept "
                    f"{sorted(before & after)!r}.")
        self.assertEqual(losses, {})

    def test_the_verbs_that_did_not_exist_before_are_not_counted_as_migrated(self):
        """The instrument's own bound, and the reason the snapshot replaced a
        base ref. All six tier verbs exist in all five clients NOW, so a
        "before" that reads the working tree — which is exactly what a base ref
        BECOMES once the branch it names has merged — reports thirty 'migrated'
        verbs, twenty-two of which never existed to lose a flag, and every
        comparison above becomes a tautology."""
        migrated = set(_migrated_tier_verbs())
        here_now = {(client, verb)
                    for client in sorted(p.name[: -len("-crucible.py")]
                                         for p in CLIENTS_DIR.glob("*-crucible.py"))
                    for verb in sorted(set(_verb_parsers(client))
                                       & TIER_VOCABULARY)}
        self.assertTrue(
            migrated < here_now,
            f"the migrated set must be a STRICT subset of today's tier verbs: "
            f"the CR adds cells that did not exist before. migrated="
            f"{sorted(migrated)!r} today={len(here_now)} cells")
        self.assertEqual(
            sorted(migrated - here_now), [],
            "a verb the snapshot records and that is absent today was not "
            "migrated, it was deleted")


if __name__ == "__main__":
    unittest.main()
