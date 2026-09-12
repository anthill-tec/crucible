"""CR-CRU-127 — a filed cycle declares its kind.

`plan-file` cannot say what KIND a cycle is, so every cycle it files is stored
`red-green` (`parseCycleInput`'s default, `src/v2.ts:1368-1369`). The defect
demonstrated itself while this CR was being filed: plan 136's cycle 442 is the
VERIFY cycle and is stored `red-green`, because `cmd_plan_file` hard-codes
`"cycles": [{"label": label} for label in labels]` (`clients/_crucible_axi.py`)
— the kind is not merely unset, it is UNEXPRESSIBLE.

What this module pins, against the spec
(`docs/changes/CR-CRU-127-a-filed-cycle-declares-its-kind.md`, as AMENDED
2026-09-13 — the CLI-only ruling and the new §S4a):

  §S1  a repeatable `--cycle-kind` pairs with the repeatable `--cycle` BY
       POSITION; a count mismatch is refused before any POST, naming both
       counts; the flag carries NO argparse `choices=`, so an unrecognised
       kind reaches the ROUTE and surfaces the SERVER's refusal.
  §S2  one shared registrar declares it; five clients delegate; the printed
       help is one wording across the fleet, and the client count is asserted.
  §S3  the request body carries `kind` per cycle entry.
  §S4  a cycle with NO kind is refused CLIENT-SIDE — and the ROUTE stays
       PERMISSIVE, which is a REGRESSION PIN here, not an omission.
  §S4a `--cycles` (the legacy comma-split form) is REFUSED for filing, with a
       `help[]` handing back the `--cycle` + `--cycle-kind` form. The flag
       stays DECLARED so the refusal is a structured envelope rather than
       argparse's bare `unrecognized arguments`.
  §S6  the help NAMES all three kinds — the ONLY discoverable copy of the
       vocabulary, precisely because §S1 omits `choices=` — and BOTH
       suggested-invocation templates teach a command the mandate ACCEPTS.

WHERE THE REFUSAL ENVELOPES ARE ASSERTED, and why not here. The two new
refusals (absent kind, count mismatch) and §S4a's legacy refusal join the
EXISTING refusal shape rather than inventing a second one, so they are
asserted through `_assert_structured_refusal` where it already lives:
`test_crucible_axi_shared.py` for the shared verb, and
`test_bun_crucible_axi_conventions.py` for one client's real argparse +
`run_verb` dispatch (§S6's AC that the AXI suite's per-verb `help[]` coverage
is EXTENDED to the new refusals rather than left asserting only the old
surface). This module owns what those two cannot see: the fleet census, the
printed vocabulary, the positional pairing on the wire, the STORED kinds, and
the two templates.

THE TEMPLATE TEST IS BEHAVIOURAL, not a string match. §S6's AC says both
templates "must teach an invocation that the new mandate ACCEPTS". So each
template is SPLIT, its `<placeholders>` substituted, and the result DRIVEN
through a real client: a template that teaches a refused command fails on the
refusal, not on a regex.

FINDINGS recorded by RED, not guessed around:

  F1. §S6's regression AC says
      `test_plan_file_help_suggests_the_cycle_activate_placeholder_template`
      passes BYTE-UNCHANGED. It cannot: that test files with `--cycles "a,b"`
      (`test_bun_crucible_axi_conventions.py:508`), the exact form §S4a now
      REFUSES. The two ACs were written in the same amendment and contradict.
      Resolved by §S5's own rule — the INVOCATION is migrated, the ASSERTION
      (`cycle-activate <id>` in a successful filing's `help[]`) is untouched —
      which preserves the AC's substance. Recorded rather than silently
      chosen.

  F2. §S4's AC "`--cycles` remains accepted by every OTHER verb that takes it,
      if any" is VACUOUS as written: MEASURED, no other verb takes it. Every
      client declares `--cycles` exactly once, on `plan-file`
      (arduino:1281, bun:2196, mvn:2184, python:1563, rust:2803). The
      criterion's INTENT — "the closure is scoped ... not a fleet-wide
      retirement" — is asserted as that census instead
      (`LegacyCyclesFlagStaysDeclaredAndScopedTest`).

  F3. §S5's "the migrated caller count is asserted" is NOT assertable as a
      static census over the test tree: the refusal tests must pass an
      UNPAIRED `--cycle` and a bare `--cycles` on purpose, so any text/AST
      count of call sites needs an allowlist that its own negative tests
      break. The fleet half of the count IS asserted here (five clients, five
      delegations reaching ONE registrar); the caller half is enforced at
      RUNTIME instead — an un-migrated caller now FAILS, which is strictly
      stronger than a count, and is what §S5's second AC ("the python client
      suites are green") measures.

Tier: INTEGRATION. This module spawns client subprocesses and a real server
built from this repo's own source.

RED, measured against `e5d6275`: no client declares `--cycle-kind`, so every
surface/census test fails, every wire test dies in argparse with
`unrecognized arguments: --cycle-kind`, and both templates spell an invocation
that carries no kind at all. The ONE test that PASSES on arrival is the
permissive-route pin (§S4) — deliberately, because no server file is touched
by this CR and the pin exists to prove it.

Invocation:
    python3 -m unittest tests.client.test_plan_file_declares_each_cycle_kind
"""

import ast
import copy
import shlex
import unittest
from unittest import mock

from tests.client.test_cycle_add_targets_the_plan_it_means import (
    _ScratchBoardTestBase,
)
from tests.client.test_plan_file_names_the_release_it_plans import (
    AXI_MODULE,
    CLIENT_FILES,
    CLIENTS,
    EXPECTED_CLIENT_COUNT,
    PLANS_PATH_SUFFIX,
    VERB,
    _PlanFileWireTestBase,
    _drive_plan_file_help,
    _flags_declared_directly_on,
    _functions_handed_the_parser,
    _http,
    _load_module_by_path,
    _plan_file_parser_names,
    _run_main,
    _shared_functions_declaring,
)
from tests.client import test_plan_file_names_the_release_it_plans as _release_suite

# The flag this CR adds, and the two it must sit beside without disturbing.
KIND_FLAG = "--cycle-kind"
REPEATABLE_FLAG = "--cycle"
LEGACY_FLAG = "--cycles"
# Declared by every client on `plan-file` TODAY — the non-vacuity anchor, so a
# help that failed to print can never read as "the flag is simply absent".
ANCHOR_FLAG = "--cr"

# `CYCLE_KINDS`, src/v2.ts:1337 — the server's vocabulary, which §S1 keeps OUT
# of the fleet (no `choices=`) and §S6 therefore requires the help to teach.
CYCLE_KINDS = ("red-green", "verify", "fix")

# The two kinds the pairing criteria use, in an order that is NOT alphabetical
# (`fix` < `verify`): a pairing that sorts, and a pairing that reverses, both
# produce (fix, verify) and therefore both FAIL. Two IDENTICAL kinds, or two in
# ascending order, would let either bug pass.
FIRST_LABEL, FIRST_KIND = "the verify sweep", "verify"
SECOND_LABEL, SECOND_KIND = "the follow-up repair", "fix"

AXI = _load_module_by_path(AXI_MODULE, "plan_file_cycle_kind_axi")


def setUpModule():
    # The printed-help driver is the release suite's, cache and all; it needs
    # that suite's module fixture, so it is ENTERED rather than re-created.
    _release_suite.setUpModule()


def tearDownModule():
    _release_suite.tearDownModule()


def _flag_help_block(help_stdout, flag):
    """The printed options entry for `flag`, continuation lines joined and
    whitespace-normalised — the sibling suite's `_release_help_block`,
    generalised to a flag argument because this CR asserts the copy of a
    DIFFERENT flag through the same rule."""
    lines = help_stdout.splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith(flag):
            block = [line.strip()]
            for following in lines[index + 1:]:
                if not following.strip() or following.strip().startswith("-"):
                    break
                block.append(following.strip())
            return " ".join(" ".join(block).split())
    return ""


# ═══════════════════════════════════════════════════════════════════════════
# §S2 + §S6 — the printed surface, in every client that ships the verb
# ═══════════════════════════════════════════════════════════════════════════


class PlanFileDeclaresTheCycleKindFlagInEveryClientTest(unittest.TestCase):
    """§S2/AC2 — "asserted by driving all five real `plan-file --help`
    subprocesses, not by reading source", and §S6/AC1 on the same surface."""

    def setUp(self):
        self.surfaces = {client: _drive_plan_file_help(client)
                         for client in CLIENTS}
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in self.surfaces.items()
                     if ANCHOR_FLAG not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `{VERB} --help` carrying the "
            f"already-declared {ANCHOR_FLAG}; these did not: {unprinted!r}")

    def test_every_client_prints_the_cycle_kind_flag_in_its_plan_file_help(self):
        missing = sorted(c for c, r in self.surfaces.items()
                         if KIND_FLAG not in r.stdout)
        self.assertEqual(
            missing, [],
            f"§S2 — an orchestrator on ANY stack must be able to declare what "
            f"kind of work each filed cycle is; `{VERB}` declares no "
            f"{KIND_FLAG} in: {missing!r}")
        self.assertEqual(
            len(self.surfaces), EXPECTED_CLIENT_COUNT,
            f"§S2/AC3 — the count of clients driven is itself asserted, so a "
            f"sixth stack cannot be added silently and a fleet claim cannot be "
            f"proven on a collection of one; drove {sorted(self.surfaces)!r}")

    def test_the_cycle_kind_flag_reads_identically_in_all_five_printed_helps(self):
        """§S2/AC2's DRY half on the SURFACE: ONE declaration site cannot word
        itself five ways, and five independent edits drift — which is exactly
        the state `--cycle` itself is in and which this CR must not repeat."""
        wordings = {c: _flag_help_block(r.stdout, KIND_FLAG)
                    for c, r in self.surfaces.items()}
        self.assertNotEqual(
            set(wordings.values()), {""},
            f"the flag must actually be PRINTED, not identically absent: an "
            f"empty block in all five is the RED state, not agreement; got "
            f"{wordings!r}")
        self.assertEqual(
            len(set(wordings.values())), 1,
            f"`{VERB} {KIND_FLAG}` must read identically in every client — it "
            f"is ONE declaration; got {wordings!r}")

    def test_the_cycle_kind_help_names_all_three_kinds_in_every_client(self):
        """§S6/AC1 — load-bearing, not cosmetic. §S1 omits `choices=` so the
        server keeps sole ownership of `CYCLE_KINDS`; that REMOVES the only
        other place an agent could read the vocabulary, leaving `--help` as
        the sole surface that can teach it. An agent who must discover the
        kinds by being refused is the context loss AXI principle 10 exists to
        prevent."""
        offenders = {}
        for client, result in sorted(self.surfaces.items()):
            block = _flag_help_block(result.stdout, KIND_FLAG)
            absent = [kind for kind in CYCLE_KINDS if kind not in block]
            if absent:
                offenders[client] = f"missing {absent} :: {block!r}"
        self.assertEqual(
            offenders, {},
            f"{KIND_FLAG}'s help must NAME {list(CYCLE_KINDS)} — with no "
            f"argparse `choices=` there is nowhere else for a calling agent to "
            f"read them; offenders: {offenders}")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 + §S1/AC5 — the ONE declaration site, read from the AST
# ═══════════════════════════════════════════════════════════════════════════


def _shared_add_argument_call(flag):
    """The `add_argument(flag, ...)` node in the SHARED module, or None — read
    from the parsed tree so a flag named in a docstring or a help string can
    never be mistaken for a declaration."""
    for node in ast.walk(ast.parse(AXI_MODULE.read_text())):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == flag):
            return node
    return None


class OneSharedRegistrarDeclaresTheCycleKindFlagTest(unittest.TestCase):
    """§S2/AC1 — "declared at exactly ONE shared registrar call site; no client
    declares it in its own source", as a property of the parsed source. The
    readers are CR-CRU-121's and CR-CRU-124's, reused.

    `--cycle` itself is hand-rolled five times (the pre-existing parity gap
    this CR measures and deliberately leaves alone); the NEW flag must not
    repeat it."""

    def setUp(self):
        self.parsers = {client: _plan_file_parser_names(path)
                        for client, path in CLIENT_FILES.items()}
        # Non-vacuity: every client really does bind a `plan-file` subparser,
        # so "declares nothing on it" cannot be true for the boring reason.
        empty = sorted(c for c, names in self.parsers.items() if not names)
        self.assertEqual(
            empty, [],
            f"every client must bind a `{VERB}` subparser for this census to "
            f"mean anything; found none in: {empty!r}")

    def test_no_client_declares_the_cycle_kind_flag_in_its_own_plan_file_block(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            flags = _flags_declared_directly_on(path, self.parsers[client])
            self.assertIn(
                ANCHOR_FLAG, flags,
                f"non-vacuity: {client} must be seen declaring {ANCHOR_FLAG} "
                f"on its `{VERB}` parser, or this reader found nothing at all")
            if KIND_FLAG in flags:
                offenders[client] = sorted(flags)
        self.assertEqual(
            offenders, {},
            f"§S2 — {KIND_FLAG} is declared ONCE, in the shared module; a "
            f"client spelling its own copy is the five-way drift "
            f"`--cycle` already suffers; offenders: {offenders!r}")

    def test_exactly_one_shared_function_declares_the_cycle_kind_flag(self):
        declaring = _shared_functions_declaring(KIND_FLAG)
        self.assertEqual(
            len(declaring), 1,
            f"§S2 — EXACTLY ONE shared registrar declares {KIND_FLAG}; a "
            f"second one is a second wording waiting to drift; got "
            f"{sorted(declaring)!r}")

    def test_every_client_reaches_that_one_registrar_from_its_plan_file(self):
        declaring = _shared_functions_declaring(KIND_FLAG)
        unreached = {}
        for client, path in CLIENT_FILES.items():
            handed = _functions_handed_the_parser(path, self.parsers[client])
            if not (declaring & handed):
                unreached[client] = sorted(handed)
        self.assertEqual(
            unreached, {},
            f"every client's `{VERB}` subparser must be handed to the shared "
            f"{sorted(declaring)!r}; these never reach it: {unreached!r}")
        self.assertEqual(
            len(CLIENT_FILES), EXPECTED_CLIENT_COUNT,
            f"§S2/AC3 — the census asserts the client count itself; covered "
            f"{sorted(CLIENT_FILES)!r}")

    def test_the_shared_declaration_is_repeatable_and_carries_no_choices(self):
        """§S1/AC5 — "declared with no `choices=`, asserted against the client
        source, so the vocabulary cannot be copied into the fleet". The
        vocabulary belongs to the server: with `choices=` an unknown kind dies
        as an argparse exit and the fleet holds a SECOND copy of `CYCLE_KINDS`
        that drifts the day the server grows a fourth.

        The repeatability half is asserted in the same place because it is the
        same call: §S1's grammar is a REPEATABLE flag paired by position, and
        a non-appending declaration silently keeps only the last kind."""
        call = _shared_add_argument_call(KIND_FLAG)
        self.assertIsNotNone(
            call,
            f"the shared module must declare {KIND_FLAG} through "
            f"`add_argument` — without it every rule here is vacuous")
        keywords = {kw.arg: kw.value for kw in call.keywords}
        self.assertNotIn(
            "choices", keywords,
            f"§S1 — {KIND_FLAG} takes NO `choices=`: the vocabulary is the "
            f"server's, and an unrecognised kind must surface as the ROUTE's "
            f"own refusal, not an argparse exit; got {sorted(keywords)!r}")
        action = keywords.get("action")
        declared_action = getattr(action, "value", None)
        self.assertEqual(
            declared_action, "append",
            f"§S1 — the kind is declared once PER CYCLE, so the flag must "
            f"append; a scalar declaration silently keeps only the last one "
            f"and files every other cycle under it; got "
            f"action={declared_action!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S4/AC4 — the closure is SCOPED to plan-file's filing path (finding F2)
# ═══════════════════════════════════════════════════════════════════════════


def _all_declared_flag_sites(path, flag):
    """Every `<parser>.add_argument(flag, ...)` in a client, with the variable
    it was declared on — so "which verbs take this flag" is answerable."""
    sites = []
    for node in ast.walk(ast.parse(path.read_text())):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"
                and isinstance(node.func.value, ast.Name)
                and node.args and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == flag):
            sites.append(node.func.value.id)
    return sites


class LegacyCyclesFlagStaysDeclaredAndScopedTest(unittest.TestCase):
    """§S4/AC4 — "`--cycles` remains accepted by every OTHER verb that takes
    it, if any — the closure is scoped to `plan-file`'s filing path and is not
    a fleet-wide retirement of the flag."

    MEASURED (finding F2): no other verb takes it. So the criterion's SUBSTANCE
    is asserted instead — the flag stays DECLARED, on `plan-file` only.

    The declaration is load-bearing for §S4a, not vestigial: a REFUSAL needs
    the flag to PARSE. Delete it and `--cycles "a,b"` becomes argparse's bare
    `unrecognized arguments` — exit 2 with EMPTY stdout, no envelope and no
    `help[]`, which is the AXI principle 6 violation §S4a exists to avoid.

    Passes today and must keep passing: it is the guard against GREEN
    implementing "refuse `--cycles`" by deleting the flag."""

    def test_every_client_still_declares_the_legacy_flag_on_plan_file_only(self):
        parsers = {client: _plan_file_parser_names(path)
                   for client, path in CLIENT_FILES.items()}
        offenders = {}
        for client, path in CLIENT_FILES.items():
            sites = _all_declared_flag_sites(path, LEGACY_FLAG)
            on_plan_file = [name for name in sites if name in parsers[client]]
            elsewhere = [name for name in sites if name not in parsers[client]]
            if len(on_plan_file) != 1 or elsewhere:
                offenders[client] = {"plan-file": on_plan_file,
                                     "other verbs": elsewhere}
        self.assertEqual(
            offenders, {},
            f"{LEGACY_FLAG} must stay DECLARED exactly once per client, on "
            f"`{VERB}` — §S4a REFUSES it for filing, and a refusal needs the "
            f"flag to parse or the caller gets argparse's bare usage error "
            f"instead of an envelope; and the closure is scoped to this verb, "
            f"not a fleet-wide retirement; offenders: {offenders!r}")
        self.assertEqual(
            len(CLIENT_FILES), EXPECTED_CLIENT_COUNT,
            f"the census covers the whole fleet; covered "
            f"{sorted(CLIENT_FILES)!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S1 + §S3 — the body, and the position the kind pairs with
# ═══════════════════════════════════════════════════════════════════════════


class _CycleKindWireTestBase(_PlanFileWireTestBase):
    """The release suite's wire harness, with the cycle flags moved OUT of the
    fixed argv so each test declares its own — that is the subject here."""

    PROJECT_KEY = "plan-file-cycle-kind-wire-key"
    AGENT = "plan-file-cycle-kind-wire-agent"
    CR = "CR-127-WIRE"
    TITLE = "the wire under test"
    WAVE = "6"

    def drive(self, *extra):
        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True, "planId": 1, "cr": self.CR, "status": "open",
                    "cycles": [{"label": FIRST_LABEL, "id": 7},
                               {"label": SECOND_LABEL, "id": 8}]}

        argv = [VERB, "--cr", self.CR, "--title", self.TITLE,
                "--wave", self.WAVE, "--agent", self.AGENT,
                "--project-dir", self.tmpdir] + list(extra)
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, [p for path, p in posted
                                if path.endswith(PLANS_PATH_SUFFIX)]


class PlanFileBodyCarriesTheKindDeclaredAtEachPositionTest(_CycleKindWireTestBase):
    """§S3 ("the request body carries `kind` per cycle entry, asserted on the
    recorded payload") and §S1/AC2 ("the Nth kind pairs with the Nth cycle")."""

    def test_the_nth_kind_rides_the_nth_cycle_entry_in_the_order_declared(self):
        """The kinds are DIFFERENT and in NON-alphabetical order, so the three
        plausible pairing bugs each fail here: a sort and a reversal both
        yield (fix, verify), and one kind applied to every cycle yields
        (verify, verify)."""
        payload = self.the_one_plan_file_payload(
            REPEATABLE_FLAG, FIRST_LABEL, KIND_FLAG, FIRST_KIND,
            REPEATABLE_FLAG, SECOND_LABEL, KIND_FLAG, SECOND_KIND)

        self.assertEqual(
            payload.get("cycles"),
            [{"label": FIRST_LABEL, "kind": FIRST_KIND},
             {"label": SECOND_LABEL, "kind": SECOND_KIND}],
            f"§S1/§S3 — each cycle entry carries the kind declared at ITS "
            f"position, in the authored order (cycles activate in ascending "
            f"order, so the order is load-bearing data, not presentation); "
            f"got {payload!r}")

    def test_the_kind_is_the_only_field_the_body_gains(self):
        """BOUND — the flag ADDS a per-cycle field and re-homes nothing. A
        top-level `kind`, or a client-invented default landing anywhere else,
        files a plan whose shape the route never agreed to."""
        payload = self.the_one_plan_file_payload(
            REPEATABLE_FLAG, FIRST_LABEL, KIND_FLAG, FIRST_KIND)

        self.assertEqual(
            payload,
            {"cr": self.CR, "agentId": self.AGENT,
             "cycles": [{"label": FIRST_LABEL, "kind": FIRST_KIND}],
             "title": self.TITLE, "wave": self.WAVE,
             "orchestrator": self.AGENT},
            f"§S3 — the body is today's body with a `kind` inside each cycle "
            f"entry and NOTHING else moved; got {payload!r}")

    def test_a_kind_the_client_cannot_recognise_is_sent_verbatim_to_the_route(self):
        """§S1/AC4's client half — with no `choices=`, an unknown kind is NOT
        the client's to judge: it travels verbatim so the SERVER's own refusal
        is what the caller reads. (The route half is asserted end to end.)"""
        payload = self.the_one_plan_file_payload(
            REPEATABLE_FLAG, FIRST_LABEL, KIND_FLAG, "smoke")

        self.assertEqual(
            payload.get("cycles"), [{"label": FIRST_LABEL, "kind": "smoke"}],
            f"the client never invents, normalises or vetoes a kind — "
            f"`CYCLE_KINDS` is the server's and the fleet holds no copy; got "
            f"{payload!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S6/AC6 — BOTH suggested-invocation templates teach a command the mandate
#           ACCEPTS. Driven, not regex-matched.
# ═══════════════════════════════════════════════════════════════════════════

# Every placeholder a template is allowed to spell, and the concrete value it
# stands for. A template inventing a placeholder that is NOT here fails the
# substitution rather than being silently pasted through as a literal.
_PLACEHOLDERS = {
    "<CR-id>": "CR-127-TEMPLATE",
    "<brief>": "a plan",
    "<c1>": FIRST_LABEL,
    "<c2>": SECOND_LABEL,
    "<kind>": FIRST_KIND,
    "<k1>": FIRST_KIND,
    "<k2>": SECOND_KIND,
    "<agentId>": "template-agent",
}


class SuggestedInvocationTemplatesTeachTheMandatedFormTest(_CycleKindWireTestBase):
    """§S6/AC6 (gap analysis DRIFT-1) — the template exists TWICE, so repairing
    either alone is the half-migration §S5 exists to prevent:

      1. `CYCLE_FLAG_TEMPLATE` (`clients/_crucible_axi.py:1241-1242`), consumed
         by three refusal `help[]` lists;
      2. `_next_start_help`'s own hand-built step string (`:1855-1856`) — the
         literal command an orchestrator copies to START a CR. It is what this
         board handed the orchestrator for CR-CRU-127 itself.

    Both are asserted by DRIVING them: a template is only correct if the
    command it teaches is one the mandate accepts, and a string assertion
    cannot tell the difference between a template that files and one that is
    refused."""

    PROJECT_KEY = "plan-file-cycle-kind-template-key"
    CR = "CR-127-TEMPLATE"

    def _drive_template(self, template):
        tokens = shlex.split(template)
        self.assertEqual(
            tokens[0], VERB,
            f"the template must be a `{VERB}` invocation; got {template!r}")
        unknown = sorted({t for t in tokens
                          if t.startswith("<") and t.endswith(">")
                          and t not in _PLACEHOLDERS})
        self.assertEqual(
            unknown, [],
            f"the template spells placeholders this test cannot substitute, "
            f"so it cannot be proven runnable: {unknown!r} in {template!r}")
        argv = [_PLACEHOLDERS.get(t, t) for t in tokens[1:]]
        # The template names its own --cr/--agent; the harness supplies only
        # what a template never carries.
        argv += ["--project-dir", self.tmpdir]
        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True, "planId": 1, "cr": self.CR, "status": "open",
                    "cycles": [{"label": FIRST_LABEL, "id": 7}]}

        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, [VERB] + argv)
        return code, out, err, [p for path, p in posted
                                if path.endswith(PLANS_PATH_SUFFIX)]

    def _assert_template_files_kinded_cycles(self, template, *, source):
        self.assertNotIn(
            LEGACY_FLAG, template,
            f"{source}: the template must not hand back the legacy "
            f"comma-split form §S4a refuses; got {template!r}")
        code, out, err, payloads = self._drive_template(template)
        self.assertEqual(
            code, 0,
            f"{source}: the template must teach a command the mandate "
            f"ACCEPTS — an orchestrator pastes this verbatim, and a template "
            f"that is refused turns contextual disclosure into a dead end; "
            f"{template!r} exited {code} with stdout={out.strip()[:600]!r} "
            f"stderr={err.strip()[:600]!r}")
        self.assertEqual(
            len(payloads), 1,
            f"{source}: exactly one plans POST; got {payloads!r}")
        cycles = payloads[0].get("cycles") or []
        self.assertTrue(
            cycles and all(c.get("kind") for c in cycles),
            f"{source}: every cycle the template files must carry a declared "
            f"kind — a template that merely SURVIVES the mandate while filing "
            f"one kindless cycle teaches the defect; got {payloads[0]!r}")
        return cycles

    def test_the_shared_refusal_template_files_a_plan_under_the_mandate(self):
        cycles = self._assert_template_files_kinded_cycles(
            AXI.CYCLE_FLAG_TEMPLATE, source="CYCLE_FLAG_TEMPLATE")
        self.assertGreaterEqual(
            len(cycles), 2,
            f"the template's whole job is to teach the REPETITION — one "
            f"`{REPEATABLE_FLAG}`/`{KIND_FLAG}` pair teaches a one-cycle plan; "
            f"got {cycles!r}")

    def test_the_next_start_template_files_a_plan_under_the_mandate(self):
        steps = AXI._next_start_help({"cr": self.CR, "wave": self.WAVE})
        self.assertTrue(
            steps,
            "`next`'s start help must be a non-empty help[] — an empty one "
            "makes every rule here vacuous")
        cycles = self._assert_template_files_kinded_cycles(
            steps[0], source="_next_start_help")
        self.assertGreaterEqual(
            len(cycles), 2,
            f"the START template teaches the shape of a whole plan; got "
            f"{cycles!r}")

    def test_both_templates_teach_the_same_form(self):
        """DRIFT-1's actual finding: the template exists twice. Two templates
        that both pass the mandate but teach DIFFERENT invocations is the
        drift a shared constant exists to prevent — and the duplicate is
        hand-built, so nothing structural stops it."""
        start = AXI._next_start_help({"cr": self.CR, "wave": self.WAVE})[0]
        for flag in (REPEATABLE_FLAG, KIND_FLAG):
            with self.subTest(flag=flag):
                shared_count = shlex.split(AXI.CYCLE_FLAG_TEMPLATE).count(flag)
                # NON-VACUITY: two templates that both spell a flag ZERO times
                # agree perfectly and teach nothing. The mandated form carries
                # a `--cycle`/`--cycle-kind` PAIR per cycle, at least twice.
                self.assertGreaterEqual(
                    shared_count, 2,
                    f"the mandated form repeats `{flag}` once per cycle, so "
                    f"both templates must spell it at least twice; "
                    f"CYCLE_FLAG_TEMPLATE={AXI.CYCLE_FLAG_TEMPLATE!r}")
                self.assertEqual(
                    shared_count,
                    shlex.split(start).count(flag),
                    f"both suggested-invocation templates must teach the same "
                    f"form; `{flag}` appears a different number of times in "
                    f"CYCLE_FLAG_TEMPLATE={AXI.CYCLE_FLAG_TEMPLATE!r} and in "
                    f"_next_start_help={start!r}")


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — what gets STORED, read back from a real board
# ═══════════════════════════════════════════════════════════════════════════
#
# §S1's first AC says the kinds are read back FROM THE STORE, never from the
# POST response: a response echoing the kind proves the route parsed it, not
# that the board now records the right kind of work. The scratch-board harness
# is CR-CRU-124's, inherited rather than re-invented.


class FiledCyclesAreStoredWithTheKindsTheyDeclaredTest(_ScratchBoardTestBase):

    ORCHESTRATOR = "cr-127-e2e-orchestrator"
    CR = "CR-127-E2E-KINDS"
    UNKNOWN_CR = "CR-127-E2E-UNKNOWN-KIND"
    PERMISSIVE_CR = "CR-127-E2E-ROUTE-STAYS-PERMISSIVE"

    def _file(self, cr, *cycle_argv):
        return self._client(
            VERB, "--cr", cr, "--title", f"{cr} under test",
            "--wave", self.WAVE, *cycle_argv,
            "--agent", self.ORCHESTRATOR, "--project-dir", self.project_dir)

    @staticmethod
    def _ordered_pairs(plan):
        """The plan's cycles as an ORDERED list of (label, kind) — a dict keyed
        by label would lose exactly the property §S1/AC2 is about."""
        return [(c.get("label"), c.get("kind"))
                for c in plan.get("cycles") or []]

    def test_two_declared_kinds_are_stored_against_the_cycles_they_were_paired_with(self):
        """§S1/AC1 + AC2 — the criterion this whole CR exists for. Cycle 442 of
        this CR's OWN plan is a verify cycle stored `red-green`; after this,
        the kinds a caller declares are the kinds the board holds."""
        filed = self._file(
            self.CR,
            REPEATABLE_FLAG, FIRST_LABEL, KIND_FLAG, FIRST_KIND,
            REPEATABLE_FLAG, SECOND_LABEL, KIND_FLAG, SECOND_KIND)
        self.assertEqual(
            filed.returncode, 0,
            f"filing two kinded cycles must succeed; "
            f"stdout={filed.stdout.strip()[:600]!r} "
            f"stderr={filed.stderr.strip()[:600]!r}")

        pairs = self._ordered_pairs(self._plan_for(self.CR))
        self.assertEqual(
            pairs,
            [(FIRST_LABEL, FIRST_KIND), (SECOND_LABEL, SECOND_KIND)],
            f"the STORE must hold the Nth declared kind against the Nth "
            f"declared cycle, in the authored order — the kinds are DIFFERENT "
            f"and non-alphabetical, so a pairing that sorts or reverses lands "
            f"on {[(SECOND_LABEL, SECOND_KIND), (FIRST_LABEL, FIRST_KIND)]!r} "
            f"and fails here; got {pairs!r}")

    def test_an_unrecognised_kind_is_refused_by_the_route_and_stores_nothing(self):
        """§S1/AC4 — the flag carries no `choices=`, so `smoke` must travel to
        the ROUTE and come back as the SERVER's own refusal. An argparse exit
        would mean the fleet had grown a second copy of `CYCLE_KINDS`."""
        refused = self._file(
            self.UNKNOWN_CR,
            REPEATABLE_FLAG, FIRST_LABEL, KIND_FLAG, "smoke")
        combined = refused.stdout + refused.stderr

        self.assertNotEqual(
            refused.returncode, 0,
            f"an unrecognised kind must be refused; "
            f"stdout={refused.stdout.strip()[:600]!r}")
        for argparse_noise in ("invalid choice", "unrecognized arguments"):
            self.assertNotIn(
                argparse_noise, combined,
                f"§S1 — argparse must NOT reject the kind: the vocabulary is "
                f"the server's, and a client-side `choices=` is a second copy "
                f"of CYCLE_KINDS that drifts; got {combined[:600]!r}")
        self.assertNotIn(
            "Traceback (most recent call last)", combined,
            f"the refusal is structured, never a traceback; got "
            f"{combined[:600]!r}")

        decoded = self.toon.decode(refused.stdout)
        self.assertIn(
            "axi", decoded,
            f"the server's refusal must reach the caller as a TOON-AXI "
            f"envelope on stdout; got {refused.stdout!r}")
        self.assertIs(
            decoded["axi"].get("ok"), False,
            f"the refusal is ok:false, not a silently dropped cycle; got "
            f"{decoded['axi']!r}")
        self.assertIn(
            "invalid kind", combined,
            f"the caller must read the ROUTE's own words — `parseCycleInput` "
            f"names the offending field; got {combined[:600]!r}")

        stored = [p for p in self._plans() if p.get("cr") == self.UNKNOWN_CR]
        self.assertEqual(
            stored, [],
            f"a refused kind stores NOTHING — no plan, no cycle; got "
            f"{stored!r}")

    def test_a_kindless_cycle_posted_straight_to_the_route_still_stores_red_green(self):
        """§S4's REGRESSION PIN, and the whole point of the 2026-09-13 CLI-only
        ruling: the mandate is CLIENT-SIDE, so `POST …/plans` stays PERMISSIVE
        and `parseCycleInput` keeps its `red-green` default. NO server file is
        touched by this CR.

        PASSES ON ARRIVAL, deliberately. It is what proves the omission was a
        decision rather than an oversight — and it is the test that fails the
        day someone "finishes the job" by tightening the route, which would
        silently retire CR-CRU-124 §S4/AC3 through the SHARED `parseCycleInput`
        (`src/v2.ts:1359`, also called by `handleCycleAppend` at `:1551`).

        The residue is recorded in the spec's non-goals: anything that is not
        one of the five clients can still file a kindless cycle."""
        filed = _http(
            self.base, f"/api/v2/projects/{self.key}/plans",
            {"cr": self.PERMISSIVE_CR, "title": "filed straight at the route",
             "wave": self.WAVE, "agentId": self.ORCHESTRATOR,
             "cycles": [{"label": "a cycle carrying no kind"}]})
        self.assertIs(
            filed.get("ok"), True,
            f"the route must still ACCEPT a cycle entry with no `kind` — the "
            f"enforcement this CR adds is client-side ONLY; got {filed!r}")

        pairs = self._ordered_pairs(self._plan_for(self.PERMISSIVE_CR))
        self.assertEqual(
            pairs, [("a cycle carrying no kind", "red-green")],
            f"the route's own default (`parseCycleInput`, src/v2.ts:1368-1369) "
            f"must still apply and still be `red-green`; got {pairs!r}")


if __name__ == "__main__":
    unittest.main()
