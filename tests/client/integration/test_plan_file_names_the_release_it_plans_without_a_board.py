"""CR-CRU-121 §S2 (fleet half) — `plan-file` gains `--release`, in ALL FIVE
clients, and the client count itself is asserted.

The route half lives in `tests/integration/plans.test.ts`: a `plan-file` carrying a
`release` performs the same queue write `cr-plan` performs, atomically with
the plan file. This file is the SURFACE half — an orchestrator on any stack
must be able to declare that release when it opens the cycle plan, which is
the whole failure CR-CRU-121 was born from (CR-CRU-120 ran a full RED phase
off a plan whose CR was on no roadmap at all).

What is asserted, and why in these three shapes:

1. **The printed help, per client, as a real subprocess.** Five separate
   facts, any one of which can be forgotten silently. The already-declared
   `--cr` is the non-vacuity anchor: a `--help` drive that failed to run at
   all would report the NEW flag missing for a harness reason and would look
   identical to the defect under test.
2. **The ONE declaration site, read from the AST.** The criterion is "added
   at the ONE shared registrar call site — not five independent edits", so a
   client that hand-rolls `pf.add_argument("--release", …)` in its own
   `plan-file` block FAILS even when its printed help is perfect.
3. **The wire.** A flag that parses and never reaches the POST body
   registers nothing. The whole round trip against a real board, which a
   POST body alone cannot prove until the QUEUE is read back, is the
   live-board module `test_plan_file_names_the_release_it_plans`.

No board here. Integration: the help drives start the client processes.

RED, measured against the fleet today (2026-09-12): no client declares
`--release` on `plan-file` — `argparse` answers `unrecognized arguments:
--release` and exits 2 — and `cmd_plan_file` builds its payload with no
`release` key at all (`cmd_plan_file` in `clients/_crucible_axi.py`). The pass-side class
below pins what the addition must NOT disturb, and passes today.

ESCALATION (recorded, not guessed — see this file's report):

  E1. §S2 says the flag is "added via the ONE shared registrar line in
      `clients/_crucible_axi.py` (the same architecture CR-CRU-118 §S5 used)".
      `plan-file` HAS no shared registrar: all five clients hand-roll their
      own `pf = sub.add_parser("plan-file", …)` block plus its flags
      (arduino:1271, bun:2188, mvn:2176, python:1555, rust:2795). So the
      criterion cannot be met by adding a line to something that exists — a
      shared declaration site for `plan-file`'s arguments has to be CREATED
      first. `SharedRegistrarDeclaresTheReleaseFlagTest` therefore asserts the
      PROPERTY the criterion names (one shared declaration, reached by every
      client, zero per-client declarations) rather than a line number in a
      registrar that does not exist. The size estimate ("S") does not account
      for that refactor.

Invocation:
    python3 -m unittest tests.client.integration.test_plan_file_names_the_release_it_plans_without_a_board
"""

import unittest

from tests.client.plan_file_names_the_release_it_plans_helpers import (
    AXI_MODULE,
    CLIENT_FILES,
    CLIENTS,
    EXPECTED_CLIENT_COUNT,
    VERB,
    _drive_plan_file_help,
    _flags_declared_directly_on,
    _functions_handed_the_parser,
    _plan_file_parser_names,
    _PlanFileWireTestBase,
    _shared_functions_declaring,
    setUpModule,  # noqa: F401 -- the module fixture unittest looks up by name
    tearDownModule,  # noqa: F401 -- the module fixture unittest looks up by name
)

RELEASE_FLAG = "--release"
# A flag every client declares on `plan-file` TODAY — the non-vacuity anchor.
ANCHOR_FLAG = "--cr"


# The label under test, and one no normaliser can leave alone by accident: a
# pre-release suffix must arrive on the wire byte-for-byte.
RELEASE_LABEL = "0.2.0"
VERBATIM_LABEL = "9.9.9-rc.1"


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the printed surface, in every client that ships the verb
# ═══════════════════════════════════════════════════════════════════════════


def _release_help_block(help_stdout):
    """The `--release` entry of a printed options section, with its
    continuation lines, whitespace-normalised — the WORDING five clients must
    share when one site declares the flag."""
    lines = help_stdout.splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith(RELEASE_FLAG):
            block = [line.strip()]
            for following in lines[index + 1:]:
                if not following.strip() or following.strip().startswith("-"):
                    break
                block.append(following.strip())
            return " ".join(" ".join(block).split())
    return ""


class PlanFileDeclaresTheReleaseFlagInEveryClientTest(unittest.TestCase):
    """§S2/AC1 — every client's `plan-file` LISTS `--release`, proven by driving
    that client's own printed help as a real subprocess."""

    def setUp(self):
        self.surfaces = {client: _drive_plan_file_help(client) for client in CLIENTS}
        # Non-vacuity FIRST — `--cr` is declared TODAY by every client, so its
        # presence proves the help was really printed and read.
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in self.surfaces.items() if ANCHOR_FLAG not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `{VERB} --help` carrying the "
            f"already-declared {ANCHOR_FLAG}; these did not: {unprinted!r}")

    def test_every_client_prints_the_release_flag_in_its_plan_file_help(self):
        missing = sorted(c for c, r in self.surfaces.items()
                         if RELEASE_FLAG not in r.stdout)
        self.assertEqual(
            missing, [],
            f"an orchestrator on ANY stack must be able to name the release it "
            f"is opening a cycle plan for — a plan filed for a cr that sits on "
            f"no roadmap is the failure this flag exists to prevent; `{VERB}` "
            f"declares no {RELEASE_FLAG} in: {missing!r}")

        self.assertEqual(
            len(self.surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(self.surfaces)!r}")

    def test_the_release_flag_reads_identically_in_all_five_printed_helps(self):
        """§S2/AC1's DRY half, measured on the SURFACE: one declaration site
        cannot word itself five ways. Five independent edits drift — and the
        drift is exactly what makes a fleet flag feel unreliable."""
        wordings = {c: _release_help_block(r.stdout) for c, r in self.surfaces.items()}
        self.assertEqual(
            len(set(wordings.values())), 1,
            f"`{VERB} {RELEASE_FLAG}` must read identically in every client — "
            f"it is ONE declaration; got {wordings!r}")
        self.assertNotEqual(
            set(wordings.values()), {""},
            f"the flag must actually be PRINTED, not identically absent: an "
            f"empty block in all five is the RED state, not agreement; got "
            f"{wordings!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the ONE declaration site, read from the AST
# ═══════════════════════════════════════════════════════════════════════════
#
# The readers are deliberately tiny and local: they answer "which variable is
# this client's plan-file subparser, what flags does the client declare ON it,
# and what does it hand that variable to?" — read from the parsed tree, so a
# flag named in a docstring or a help string can never be mistaken for a
# declaration.


class SharedRegistrarDeclaresTheReleaseFlagTest(unittest.TestCase):
    """§S2/AC1 — "added at the ONE shared registrar call site, not five
    independent edits", as a property of the parsed source.

    See ESCALATION E1 in this module's docstring: `plan-file` has no shared
    registrar today, so the criterion is asserted as the PROPERTY it names —
    zero per-client declarations of the flag, and every client's plan-file
    subparser handed to a shared declaration site."""

    def setUp(self):
        self.parsers = {c: _plan_file_parser_names(p) for c, p in CLIENT_FILES.items()}
        unfound = sorted(c for c, names in self.parsers.items() if not names)
        self.assertEqual(
            unfound, [],
            f"fixture sanity: every client registers a `{VERB}` subparser and "
            f"binds it to a name; could not find one in: {unfound!r}")

    def test_no_client_declares_the_release_flag_in_its_own_plan_file_block(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            flags = _flags_declared_directly_on(path, self.parsers[client])
            # Fixture sanity in the same read: the anchor IS declared per
            # client today, so an empty set would mean the reader missed the
            # block rather than that the client is clean.
            self.assertIn(
                ANCHOR_FLAG, flags,
                f"fixture sanity: {path.name} declares {ANCHOR_FLAG} on its "
                f"own `{VERB}` parser; the AST reader found {sorted(flags)!r}")
            if RELEASE_FLAG in flags:
                offenders[client] = sorted(flags)
        self.assertEqual(
            offenders, {},
            f"{RELEASE_FLAG} must be declared ONCE, in a shared site — a "
            f"client that hand-rolls it in its own `{VERB}` block is one of "
            f"the five independent edits §S2 forbids; offenders: {offenders!r}")

    def test_every_client_hands_its_plan_file_parser_to_the_shared_declaration(self):
        declaring = _shared_functions_declaring(RELEASE_FLAG)
        unreached = {}
        for client, path in CLIENT_FILES.items():
            handed = _functions_handed_the_parser(path, self.parsers[client])
            if not (handed & declaring):
                unreached[client] = sorted(handed)
        self.assertEqual(
            unreached, {},
            f"every client must reach {RELEASE_FLAG} by handing its `{VERB}` "
            f"subparser to a function DEFINED IN {AXI_MODULE.name} that "
            f"declares the flag (directly, or through one client-local "
            f"delegator — the fleet's own `_add_*_arg` idiom). Shared "
            f"functions declaring it today: {sorted(declaring)!r}; clients "
            f"that reach none of them: {unreached!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the wire: the declared release reaches the POST body
# ═══════════════════════════════════════════════════════════════════════════
#
# Recorded at the TRANSPORT seam (`_post`) by `_PlanFileWireTestBase`
# (plan_file_names_the_release_it_plans_helpers).


class PlanFileCarriesTheDeclaredReleaseTest(_PlanFileWireTestBase):

    def test_the_declared_release_rides_the_plan_file_body_as_its_own_field(self):
        payload = self.the_one_plan_file_payload(RELEASE_FLAG, RELEASE_LABEL)

        self.assertEqual(
            payload.get("release"), RELEASE_LABEL,
            f"the release must ride as the body's own top-level `release` — "
            f"the field the route reads to perform cr-plan's queue write; got "
            f"{payload!r}")
        # BOUND — the flag ADDS a field; it re-homes none of the existing ones.
        self.assertEqual(
            (payload.get("cr"), payload.get("title"), payload.get("wave"),
             payload.get("agentId"), payload.get("cycles")),
            (self.CR, "the wire under test", "6", self.AGENT,
             [{"label": "red-green", "kind": "red-green"}]),
            f"every field plan-file already sends must arrive unchanged beside "
            f"the new one; got {payload!r}")

    def test_a_label_the_client_cannot_recognise_is_sent_verbatim(self):
        payload = self.the_one_plan_file_payload(RELEASE_FLAG, VERBATIM_LABEL)

        self.assertEqual(
            payload.get("release"), VERBATIM_LABEL,
            f"the label travels VERBATIM — the client never normalises a "
            f"pre-release suffix, strips a prefix, or otherwise rewrites what "
            f"the caller declared (§S9 puts no business rule in a client); got "
            f"{payload.get('release')!r}")


class TodaysPlanFileBodySurvivesTest(_PlanFileWireTestBase):
    """The measurement behind the word "additive": every test here passes
    BEFORE the `--release` flag exists and must pass after it.

    CR-CRU-127 amends the BASELINE the word "additive" is measured against —
    a filed cycle now carries its kind — so the body pinned below states that
    contract. `--release`'s own additivity, which is what this class is for,
    is unchanged and still asserted the same way."""

    def test_without_a_release_the_body_carries_no_release_key_at_all(self):
        payload = self.the_one_plan_file_payload()

        self.assertNotIn(
            "release", payload,
            f"a plan filed without a release makes no roadmap claim: the key "
            f"is ABSENT, never null and never empty — the route branches on "
            f"its presence, and a fabricated value would register the CR into "
            f"a release nobody declared; got {payload!r}")

    def test_the_release_less_body_carries_only_the_cr_its_cycles_and_its_wave(self):
        """Was `test_the_body_plan_file_sends_today_is_unchanged`. REWRITTEN by
        CR-CRU-127 §S5 rather than deleted or re-pinned to whatever the code
        now emits: the criterion it states — a client that names no release
        sends a body carrying no release and nothing invented — is unchanged;
        the body it is measured against gains the per-cycle `kind` the kind
        mandate requires."""
        payload = self.the_one_plan_file_payload()

        self.assertEqual(
            payload,
            {"cr": self.CR, "agentId": self.AGENT,
             "cycles": [{"label": "red-green", "kind": "red-green"}],
             "title": "the wire under test",
             "wave": "6", "orchestrator": self.AGENT},
            f"the release-less body is composed of exactly the fields the "
            f"caller declared — the backward-compatibility constraint this "
            f"change makes explicit: a client that names no release must "
            f"invent nothing; got {payload!r}")



if __name__ == "__main__":
    unittest.main()
