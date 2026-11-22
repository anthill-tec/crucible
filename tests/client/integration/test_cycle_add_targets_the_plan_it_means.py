"""CR-CRU-124 — `cycle-add` cannot target the plan it means.

Four defects, all client-side, pinned here in the four shapes the spec's
acceptance criteria name (docs/changes/CR-CRU-124-cycle-add-cannot-target-the-
plan-it-means.md):

- **§S1** `resolve_single_plan` (`clients/_crucible_axi.py`) filters by
  `open_only`, then by `cr`, then demands exactly one candidate. `cycle-add`
  passes `open_only=False`, so a CR carrying an ABORTED plan beside its OPEN
  one yields two candidates → `"ambiguous"` → no POST. Since abort +
  re-`plan-file` is the sanctioned recovery path, any CR that has ever been
  aborted can never receive a cycle through the client again. Asserted on the
  PURE resolver (the exact shape that refused on 2026-09-12) and again at the
  end of the client, where the POST either fires or does not.
- **§S2** the ambiguity branch of `resolve_plan_or_emit`
  (`clients/_crucible_axi.py`) rebuilds its
  candidate list filtered by `open_only` ONLY — never by `cr` — so it
  enumerates every plan on the board and then tells the caller to pass the flag
  they already passed. The live failure printed all 113. `cmd_cr_close`
  (`clients/_crucible_axi.py`) already filters by `args.cr` first; the
  shared helper must behave like the one correct call site.
- **§S3** there is no `--plan <id>` escape, even though the route takes the
  plan id in its path and needs no resolution at all.
- **§S4** `cmd_cycle_add` (`clients/_crucible_axi.py`) POSTs
  `{label, agentId}` and nothing else, while the route has ALWAYS accepted
  `kind`: `parseCycleInput` (`src/v2.ts`) reads `{label, kind?}`, validates against
  `CYCLE_KINDS` and defaults to `red-green` when omitted. So every verify and
  fix cycle ever filed through this verb is stored as `red-green`. NO server
  change is needed or wanted. The §S4 criteria are asserted here on what the
  real client sends to a fake board and relays from its answers; the STORED
  plan read back is the server's half, held in bun
  (`cycle-append-route-stores-and-refuses-kinds.test.ts`).

RED, measured against the fleet today (2026-09-12): no client declares `--plan`
or `--kind` anywhere (`argparse` answers `unrecognized arguments` and exits 2),
`resolve_single_plan` has no open-plan preference, and the ambiguity message is
unscoped. The four regression-pin criteria (a lone closed plan still resolving
and still being POSTed, two OPEN plans staying ambiguous, the cr-ABSENT message
wording, and the no-`--kind` body shape) PASS today and must keep passing: they
are the "byte-identical for every existing caller" half of the spec.

Harnesses are REUSED, never re-invented: the `cycle-add` drive + envelope
fixture from `test_bun_crucible_cycle_add.py` (CR-CRU-030 §S4), and the fleet
census + scratch-board idioms from `test_plan_file_names_the_release_it_plans.py`
(CR-CRU-121 §S2, the CR whose `add_plan_file_release_arg` registrar §S3/§S4 say
to mirror).

ESCALATION (recorded, not guessed):

  E1. §S1 words the new rule as "applied only after the existing `cr` filter
      leaves more than one candidate". With `cr` ABSENT that filter is a no-op,
      so the spec does not say whether an open-plan preference fires for a
      caller who passed no `--cr` at all. Every fixture here is deliberately
      INVARIANT to that reading: the §S1 criteria all supply `cr`, and §S2's
      cr-absent wording pin uses TWO OPEN plans, which is ambiguous under
      either reading. Neither behaviour is asserted, because neither is
      specified.

  E2. §S3's second and third criteria cannot both be read strictly: a client
      cannot know that a `--plan` names a plan whose `cr` DIFFERS without
      reading the plan board. The criteria are asserted exactly as worded —
      "NO plans GET" for `--plan` alone (where nothing needs resolving), and
      "refused with ok:false and NO POST" for `--plan --cr`, with no claim
      about reads on that path.

Tier: INTEGRATION. This module spawns client subprocesses and a real server
built from this repo's own source; the pure-resolver and wire classes are unit
work, but the run as a whole takes process and server dependencies.

Invocation:
    python3 -m unittest tests.client.integration.test_cycle_add_targets_the_plan_it_means
"""

import ast
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from tests.client.client_fleet_envelope_census_helpers import (  # noqa: E402
    declare_and_require_board,
)
from tests.client.unit.test_bun_crucible_cycle_add import _BaseCycleAddTest
from tests.client.bun_crucible_cycle_add_helpers import _plans_response, _run_main
from tests.client.plan_file_names_the_release_it_plans_helpers import (
    AXI_MODULE,
    EXPECTED_CLIENT_COUNT,
    REPO_ROOT,
    _UNREACHABLE_CRUCIBLE_URL,
    _functions_handed_the_parser,
    _shared_functions_declaring,
)
from tests.client.live_run_harness import RecordingBoard
from tests.client.plan_file_names_the_release_it_plans_helpers import (
    CLIENT_FILES,
    CLIENTS,
    CLIENTS_DIR,
    ENV_KEYS,
    _load_module_by_path,
)

VERB = "cycle-add"
PLAN_FLAG = "--plan"
KIND_FLAG = "--kind"
# The flag every client declares on `cycle-add` TODAY — the non-vacuity anchor,
# and a flag this CR keeps (the whole defect is about honouring it).
ANCHOR_FLAG = "--cr"

AXI = _load_module_by_path(AXI_MODULE, "cycle_add_plan_target_axi")

THE_CR = "CR-CRU-124"
# The live 2026-09-12 board: 113 plans, and the caller had passed --cr.
LIVE_BOARD_SIZE = 113
MATCHING_PLANS = 3

CYCLE_KINDS = ("red-green", "verify", "fix")


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — an unambiguous OPEN plan resolves even beside terminal siblings
# ═══════════════════════════════════════════════════════════════════════════


def _plan(plan_id, cr, status):
    return {"planId": plan_id, "cr": cr, "status": status, "cycles": []}


class OpenPlanResolvesBesideTerminalSiblingsTest(unittest.TestCase):
    """§S1 on the PURE resolver — `resolve_single_plan` is where the live
    refusal happened, and it takes no I/O, so the four criteria are weighed
    directly on the function the spec names."""

    def test_the_open_plan_wins_over_an_aborted_sibling_of_the_same_cr(self):
        """§S1/AC1 — the exact shape that refused on 2026-09-12."""
        aborted = _plan("plan-131", THE_CR, "aborted")
        live = _plan("plan-132", THE_CR, "open")

        plan, reason = AXI.resolve_single_plan(
            [aborted, live], cr=THE_CR, open_only=False)

        self.assertIsNone(
            reason,
            f"a CR carrying ONE open plan beside an aborted one is not "
            f"ambiguous — abort + re-plan-file is the sanctioned recovery "
            f"path, and refusing here is what made every recovered CR "
            f"unable to receive a cycle; got reason={reason!r}")
        self.assertIs(
            plan, live,
            f"the OPEN plan is the target — the aborted sibling is settled "
            f"history; got {plan!r}")

    def test_two_terminal_candidates_with_no_open_sibling_stay_ambiguous(self):
        """§S1/AC2 (regression pin) — zero open candidates keeps today's
        behaviour: the SERVER owns terminal-plan rejection, and with two of
        them the client still cannot say which one was meant."""
        candidates = [_plan("plan-90", THE_CR, "aborted"),
                      _plan("plan-91", THE_CR, "closed")]

        plan, reason = AXI.resolve_single_plan(
            candidates, cr=THE_CR, open_only=False)

        self.assertEqual(
            (plan, reason), (None, "ambiguous"),
            f"two terminal candidates and no open one is a real ambiguity: "
            f"picking either would be a guess; got {(plan, reason)!r}")

    def test_two_open_candidates_stay_ambiguous(self):
        """§S1/AC3 (regression pin) — the new rule fires on EXACTLY one open
        candidate. Two live plans is a real ambiguity and must stay one."""
        candidates = [_plan("plan-92", THE_CR, "open"),
                      _plan("plan-93", THE_CR, "open")]

        plan, reason = AXI.resolve_single_plan(
            candidates, cr=THE_CR, open_only=False)

        self.assertEqual(
            (plan, reason), (None, "ambiguous"),
            f"two OPEN plans for one cr must never resolve to whichever came "
            f"first out of the store; got {(plan, reason)!r}")

    def test_a_lone_closed_plan_still_resolves_to_itself(self):
        """§S1/AC4 (regression pin) — the docstring's stated contract: the
        client pre-filters NOTHING. A single closed plan resolves, and the
        server is left to reject the append."""
        closed = _plan("plan-94", THE_CR, "closed")

        plan, reason = AXI.resolve_single_plan(
            [closed], cr=THE_CR, open_only=False)

        self.assertEqual(
            (plan, reason), (closed, None),
            f"a lone closed plan is still the target — pre-rejecting it "
            f"client-side is exactly what the resolver's docstring forbids; "
            f"got {(plan, reason)!r}")

    def test_the_open_only_verbs_are_untouched_by_the_new_rule(self):
        """Risk section — §S1 changes a rule `checkpoint` and `abort` share.
        They pass `open_only=True`, so the new preference cannot fire for
        them: with the terminal siblings already filtered out, two open plans
        stay ambiguous and one open plan beside an aborted one still
        resolves."""
        two_live = [_plan("plan-95", THE_CR, "aborted"),
                    _plan("plan-96", THE_CR, "open"),
                    _plan("plan-97", THE_CR, "open")]

        plan, reason = AXI.resolve_single_plan(
            two_live, cr=THE_CR, open_only=True)
        self.assertEqual(
            (plan, reason), (None, "ambiguous"),
            f"`checkpoint`/`abort` restrict to open plans first; two of them "
            f"is still ambiguous; got {(plan, reason)!r}")

        one_live = [_plan("plan-98", THE_CR, "aborted"),
                    _plan("plan-99", THE_CR, "open")]
        plan, reason = AXI.resolve_single_plan(
            one_live, cr=THE_CR, open_only=True)
        self.assertEqual(
            (plan, reason), (one_live[1], None),
            f"an open plan beside an aborted one is what `checkpoint`/`abort` "
            f"already resolve today; got {(plan, reason)!r}")


class CycleAddReachesThePostForARecoveredCrTest(_BaseCycleAddTest):
    """§S1/AC1 + AC4 at the END of the client — a resolution rule that returns
    the right plan but never reaches the wire fixes nothing, and the AC4 pin
    says the lone closed plan is "still POSTed", which only the transport can
    answer."""

    PROJECT_KEY = "cycle-add-open-preference-key"

    def test_a_cr_whose_sibling_plan_was_aborted_still_gets_its_cycle(self):
        plans = _plans_response([
            _plan("plan-131", THE_CR, "aborted"),
            _plan("plan-132", THE_CR, "open"),
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=True,
                                   extra={"changed": True, "id": 432,
                                          "label": "verify", "kind": "verify",
                                          "status": "pending"})):
            code, out, err = _run_main(self.module, [
                VERB, "verify", "--cr", THE_CR, "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(
            len(post_calls), 1,
            f"exactly ONE cycle POST — the live failure posted nothing at "
            f"all; got {post_calls!r}")
        path, _payload = post_calls[0]
        self.assertTrue(
            path.endswith("/plans/plan-132/cycles"),
            f"the cycle belongs to the OPEN plan; got path={path!r}")
        self.assertNotIn(
            "plan-131", path,
            f"the aborted sibling must never receive the append; got "
            f"path={path!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True, f"got {axi!r}")
        self.assertEqual(axi.get("id"), 432, f"got {axi!r}")

    def test_a_lone_closed_plan_is_still_handed_to_the_server(self):
        """§S1/AC4 (regression pin) — the POST fires and the SERVER's refusal
        is what surfaces, not a client-side pre-filter."""
        plans = _plans_response([_plan("plan-94", THE_CR, "closed")])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=False,
                                   error="plan 94 is closed — cannot append cycles")):
            code, out, err = _run_main(self.module, [
                VERB, "rework", "--cr", THE_CR, "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(
            len(post_calls), 1,
            f"a lone closed plan is still POSTed to; got {post_calls!r}")
        self.assertTrue(post_calls[0][0].endswith("/plans/plan-94/cycles"),
                        f"got path={post_calls[0][0]!r}")
        self.assertNotEqual(code, 0, f"stdout={out!r}")
        self.assertIs(self._decode_axi(out).get("ok"), False)


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — an ambiguity message names only the candidates it means
# ═══════════════════════════════════════════════════════════════════════════
#
# Weighed on `resolve_plan_or_emit` directly: the message is composed there and
# handed to the caller's emitter as the human line, so the emitter seam is
# where it can be read verbatim.


def _board_of_113_plans(cr):
    """The live 2026-09-12 board's SIZE, with exactly three plans carrying the
    cr the caller named — two open and the aborted one that made the CR
    unresolvable in the first place. The matching plans sit in the MIDDLE of
    the list, so a message that merely truncates the board cannot pass for one
    that filtered it."""
    mine = [
        _plan("mine-open-1", cr, "open"),
        _plan("mine-aborted", cr, "aborted"),
        _plan("mine-open-2", cr, "open"),
    ]
    others = [
        _plan(f"other-{index}", f"CR-CRU-{index:03d}",
              "open" if index % 3 else "closed")
        for index in range(1, LIVE_BOARD_SIZE - MATCHING_PLANS + 1)
    ]
    return others[:55] + mine + others[55:]


class _AmbiguityMessageTestBase(unittest.TestCase):

    PLANS_PATH = "/api/v2/projects/cycle-add-ambiguity-key/plans"

    def _ambiguity_message(self, plans, cr, open_only=False):
        captured = {}

        def emit_fn(verb, ok, fields, context, warnings, legacy=None):
            captured.update(verb=verb, ok=ok, legacy=legacy)

        plan, rc = AXI.resolve_plan_or_emit(
            VERB, cr, {"label": "verify the slice"}, open_only,
            lambda path: {"ok": True, "plans": plans}, self.PLANS_PATH,
            emit_fn, dict)

        self.assertEqual(
            (plan, rc), (None, 1),
            f"fixture sanity: this board must be AMBIGUOUS for cr={cr!r}, "
            f"otherwise there is no message to weigh; got {(plan, rc)!r}")
        self.assertIs(captured.get("ok"), False,
                      f"the refusal is an ok:false envelope; got {captured!r}")
        self.assertIsInstance(
            captured.get("legacy"), str,
            f"the human line is what names the candidates; got {captured!r}")
        return captured["legacy"]


class AmbiguityMessageNamesOnlyTheNamedCrTest(_AmbiguityMessageTestBase):

    def setUp(self):
        self.board = _board_of_113_plans(THE_CR)
        self.assertEqual(
            len(self.board), LIVE_BOARD_SIZE,
            "fixture sanity: the live board that produced the failure held "
            f"{LIVE_BOARD_SIZE} plans; got {len(self.board)}")
        self.mine = [p for p in self.board if p["cr"] == THE_CR]
        self.assertEqual(len(self.mine), MATCHING_PLANS, "fixture sanity")

    def test_the_message_names_exactly_the_plans_of_the_cr_that_was_passed(self):
        """§S2/AC1 — 113 plans on the board, 3 carrying the cr; the message
        names those 3 and never all 113."""
        message = self._ambiguity_message(self.board, THE_CR)

        named = [p["planId"] for p in self.mine
                 if f"(plan {p['planId']})" in message]
        self.assertEqual(
            sorted(named), sorted(p["planId"] for p in self.mine),
            f"every plan of the named cr must appear — the caller has to be "
            f"able to tell them apart; got {message!r}")

        leaked = [p["planId"] for p in self.board
                  if p["cr"] != THE_CR and f"(plan {p['planId']})" in message]
        self.assertEqual(
            leaked, [],
            f"a plan belonging to ANOTHER cr is noise the caller cannot act "
            f"on — the live message printed all 113; leaked: {leaked!r}")
        self.assertEqual(
            message.count("(plan "), MATCHING_PLANS,
            f"exactly {MATCHING_PLANS} candidates are named; got {message!r}")
        self.assertNotIn(
            str(LIVE_BOARD_SIZE), message,
            f"the COUNT the message states is the count of candidates it "
            f"means, not the size of the board; got {message!r}")
        self.assertIn(
            f"{MATCHING_PLANS} plans", message,
            f"the message states how many candidates it is choosing between; "
            f"got {message!r}")

    def test_the_message_stops_demanding_the_flag_the_caller_already_passed(self):
        """§S2/AC2 — with `cr` supplied the message names the `--plan` escape
        instead of re-demanding `--cr`."""
        message = self._ambiguity_message(self.board, THE_CR)

        self.assertNotIn(
            "Pass --cr", message,
            f"telling a caller who passed --cr to pass --cr is the defect "
            f"itself; got {message!r}")
        self.assertIn(
            PLAN_FLAG, message,
            f"the only remaining escape is naming the plan directly "
            f"({PLAN_FLAG} <id>) — a refusal with no way forward leaves the "
            f"orchestrator posting the route by hand, which is what happened "
            f"on 2026-09-12; got {message!r}")


class AmbiguityMessageWithoutACrIsUnchangedTest(_AmbiguityMessageTestBase):
    """§S2/AC3 (regression pin) — the cr-ABSENT path is correct today and its
    wording is pinned VERBATIM. Two OPEN plans, so the fixture is ambiguous
    under either reading of §S1's new rule (see ESCALATION E1)."""

    def test_a_caller_who_passed_no_cr_still_reads_todays_wording(self):
        board = [_plan("plan-70", "CR-CRU-070", "open"),
                 _plan("plan-71", "CR-CRU-071", "open")]

        message = self._ambiguity_message(board, None)

        self.assertEqual(
            message,
            "[crucible] ERROR: 2 plans — ambiguous cycle-add. "
            "Pass --cr to pick one of: CR-CRU-070 (plan plan-70), "
            "CR-CRU-071 (plan plan-71)",
            f"a caller who named no cr HAS no narrower set and --cr IS the "
            f"right instruction: this path must read exactly as it does "
            f"today; got {message!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S3/§S4 — the fleet census: ONE registrar, five clients
# ═══════════════════════════════════════════════════════════════════════════
#
# `cycle-add` has NO shared registrar today — all five clients hand-roll their
# own subparser (arduino:1305, bun:2244, mvn:2219, python:1609, rust:2849), the
# situation `plan-file` was in before CR-CRU-121 §S2. So the census asserts the
# PROPERTY the criteria name: the printed flag in every client, zero per-client
# declarations, and exactly ONE declaring function in the shared module for
# BOTH flags.

_PROJECT_DIR = None
_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="cycle-add-target-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=cycle-add-target-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=cycle-add-target-surface-project\n")
    # CR-CRU-139 §S2 — the board is DECLARED in the project file the help
    # drives run against, never exported. A `--help` never reaches the wire;
    # one that somehow did refuses instantly instead of touching a live board.
    declare_and_require_board(_PROJECT_DIR, _UNREACHABLE_CRUCIBLE_URL,
                              "a help drive")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_cycle_add_help(client):
    """A genuine subprocess dispatch of a real client script's own
    `cycle-add --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        # COLUMNS is PINNED (added 2026-09-13, CR-CRU-127 C2 FIX) for the same
        # reason the sibling `plan-file` driver pins it, stated there in full:
        # argparse wraps with `textwrap`'s `break_on_hyphens=True`, so an
        # unpinned width can split `red-green` across a line boundary and the
        # kind-naming assertion below would read `red- green`. A fixed wide
        # terminal removes the wrap; a `"- " -> "-"` rewrite would hide a real
        # one.
        env["COLUMNS"] = "200"
        _HELP_CACHE[client] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), VERB, "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[client]


def _flag_help_block(help_stdout, flag):
    """The `flag` entry of a printed options section with its continuation
    lines, whitespace-normalised — the WORDING five clients must share when
    ONE site declares the flag."""
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


class CycleAddDeclaresBothFlagsInEveryClientTest(unittest.TestCase):
    """§S3/AC1 + §S4/AC4 — the printed surface, per client, as a real
    subprocess: five separate facts, any one of which can be forgotten
    silently."""

    def setUp(self):
        self.surfaces = {client: _drive_cycle_add_help(client)
                         for client in CLIENTS}
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in self.surfaces.items()
                     if ANCHOR_FLAG not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"non-vacuity: every client must print its own `{VERB} --help` "
            f"carrying the already-declared {ANCHOR_FLAG}; these did not: "
            f"{unprinted!r}")

    def test_every_client_prints_both_new_flags_on_cycle_add(self):
        for flag in (PLAN_FLAG, KIND_FLAG):
            missing = sorted(c for c, r in self.surfaces.items()
                             if flag not in r.stdout)
            self.assertEqual(
                missing, [],
                f"an orchestrator on ANY stack must be able to name the plan "
                f"it means and the kind of cycle it is adding; `{VERB}` "
                f"declares no {flag} in: {missing!r}")
        self.assertEqual(
            len(self.surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(self.surfaces)!r}")

    def test_both_flags_read_identically_in_all_five_printed_helps(self):
        """The DRY half on the SURFACE: one declaration site cannot word itself
        five ways, and five independent edits drift."""
        for flag in (PLAN_FLAG, KIND_FLAG):
            wordings = {c: _flag_help_block(r.stdout, flag)
                        for c, r in self.surfaces.items()}
            self.assertNotEqual(
                set(wordings.values()), {""},
                f"{flag} must actually be PRINTED, not identically absent: an "
                f"empty block in all five is the RED state, not agreement; "
                f"got {wordings!r}")
            self.assertEqual(
                len(set(wordings.values())), 1,
                f"`{VERB} {flag}` must read identically in every client — it "
                f"is ONE declaration; got {wordings!r}")

    def test_the_kind_help_names_the_three_kinds_the_route_accepts(self):
        """§S4 — the flag's whole value is that a caller can pick the right
        kind; a help entry that names no vocabulary sends them to the source.
        The three are `parseCycleInput`'s own set (`CYCLE_KINDS` in src/v2.ts)."""
        for client, result in self.surfaces.items():
            block = _flag_help_block(result.stdout, KIND_FLAG)
            unnamed = [kind for kind in CYCLE_KINDS if kind not in block]
            self.assertEqual(
                unnamed, [],
                f"{client}'s {KIND_FLAG} help must name the kinds the route "
                f"accepts ({', '.join(CYCLE_KINDS)}); missing {unnamed!r} in "
                f"{block!r}")


def _cycle_add_parser_names(path):
    """The variable name(s) a client binds its `cycle-add` subparser to — read
    from the AST, so a verb named in a docstring or a help string can never be
    mistaken for a registration."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Assign):
            continue
        call = node.value
        if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "add_parser" and call.args
                and isinstance(call.args[0], ast.Constant)
                and call.args[0].value == VERB):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def _add_argument_flags(path):
    """Every flag literal a file declares through ANY `add_argument("--x", …)`
    call — the whole-file count that answers "does this client declare this
    flag anywhere at all?"."""
    flags = []
    for node in ast.walk(ast.parse(path.read_text())):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument" and node.args
                and isinstance(node.args[0], ast.Constant)):
            flags.append(node.args[0].value)
    return flags


class OneSharedRegistrarDeclaresBothFlagsTest(unittest.TestCase):
    """§S3/AC1 + §S4/AC4 — "declared at ONE shared registrar call site (count
    the declaration sites, assert exactly one)", as a property of the parsed
    source: zero declarations across the five clients, exactly one declaring
    function in the shared module, and the SAME function for both flags."""

    def setUp(self):
        self.parsers = {c: _cycle_add_parser_names(p)
                        for c, p in CLIENT_FILES.items()}

    def test_no_client_declares_either_flag_anywhere_in_its_own_source(self):
        for flag in (PLAN_FLAG, KIND_FLAG):
            offenders = {}
            for client, path in CLIENT_FILES.items():
                declared = _add_argument_flags(path)
                # Fixture sanity in the same read: the anchor IS declared by
                # every client today, so an empty list would mean the reader
                # missed the file rather than that the client is clean.
                self.assertIn(
                    ANCHOR_FLAG, declared,
                    f"fixture sanity: {path.name} declares {ANCHOR_FLAG}; the "
                    f"AST reader found {sorted(set(declared))!r}")
                count = declared.count(flag)
                if count:
                    offenders[client] = count
            self.assertEqual(
                offenders, {},
                f"{flag} must be declared ONCE, in a shared site — a client "
                f"that hand-rolls it is one of the five independent edits "
                f"§S3 forbids; offenders: {offenders!r}")

    def test_every_client_reaches_that_one_registrar_from_its_cycle_add(self):
        declaring = _shared_functions_declaring(PLAN_FLAG)
        unreached = {}
        for client, path in CLIENT_FILES.items():
            parsers = self.parsers[client]
            self.assertTrue(
                parsers,
                f"fixture sanity: {path.name} registers a `{VERB}` subparser "
                f"and binds it to a name")
            # No fixture-sanity on `handed` being non-empty: the arduino/rust
            # clients build their `cycle-add` parser with `parents=[common]`
            # and hand it to nothing at all today, so an empty set is the
            # honest reading of the tree, not a reader failure.
            handed = _functions_handed_the_parser(path, parsers)
            if not (handed & declaring):
                unreached[client] = sorted(handed)
        self.assertEqual(
            unreached, {},
            f"every client must reach {PLAN_FLAG}/{KIND_FLAG} by handing its "
            f"`{VERB}` subparser to a function DEFINED IN {AXI_MODULE.name} "
            f"(directly, or through one client-local delegator — the fleet's "
            f"own `_add_*_arg` idiom). Shared functions declaring it today: "
            f"{sorted(declaring)!r}; clients reaching none of them: "
            f"{unreached!r}")

    def test_the_census_covered_all_five_clients(self):
        self.assertEqual(
            len(CLIENT_FILES), EXPECTED_CLIENT_COUNT,
            f"a fleet-wide claim proven on a collection of one is the exact "
            f"defect this guards; censused {sorted(CLIENT_FILES)!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 — the wire: `--plan` skips resolution entirely
# ═══════════════════════════════════════════════════════════════════════════


class CycleAddPlanFlagSkipsResolutionTest(_BaseCycleAddTest):

    PROJECT_KEY = "cycle-add-plan-flag-key"

    def test_the_plan_flag_posts_to_that_plan_without_reading_the_board(self):
        """§S3/AC2 — the route takes the plan id in its path, so there is
        nothing to resolve: NO plans GET is issued (counted), and the POST
        targets the named plan. The board the mock would have returned
        resolves to a DIFFERENT plan, so a client that read it anyway is
        caught by the path as well as by the count."""
        gets = []

        def counting_get(path):
            gets.append(path)
            return _plans_response([_plan("plan-999", "CR-CRU-999", "open")])

        post_calls = []
        with mock.patch.object(self.module, "_get", side_effect=counting_get), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=True,
                                   extra={"changed": True, "id": 433,
                                          "label": "verify", "kind": "red-green",
                                          "status": "pending"})):
            code, out, err = _run_main(self.module, [
                VERB, "verify", PLAN_FLAG, "132", "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(
            gets, [],
            f"a caller who NAMED the plan needs no resolution — reading the "
            f"board is what put the verb at the mercy of the ambiguity in the "
            f"first place; got {len(gets)} GET(s): {gets!r}")
        self.assertEqual(len(post_calls), 1, f"got {post_calls!r}")
        path, payload = post_calls[0]
        self.assertTrue(
            path.endswith("/plans/132/cycles"),
            f"the POST targets the NAMED plan; got path={path!r}")
        self.assertNotIn(
            "plan-999", path,
            f"the board's own plan must not leak into the path; got "
            f"path={path!r}")
        self.assertEqual(
            payload.get("label"), "verify",
            f"the label still rides the body; got {payload!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True, f"got {axi!r}")
        self.assertEqual(axi.get("id"), 433, f"got {axi!r}")

    def test_a_plan_flag_contradicting_the_named_cr_is_refused_before_posting(self):
        """§S3/AC3 — `--plan` naming a plan whose `cr` DIFFERS from the `--cr`
        given is refused client-side, and nothing is appended."""
        plans = _plans_response([
            _plan("132", THE_CR, "open"),
            _plan("130", "CR-CRU-122", "open"),
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(post_calls)):
            code, out, err = _run_main(self.module, [
                VERB, "verify", PLAN_FLAG, "132", "--cr", "CR-CRU-122",
                "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(
            post_calls, [],
            f"two contradicting targets is a caller error, and appending a "
            f"cycle to the WRONG plan is unrecoverable history; got "
            f"{post_calls!r}")
        self.assertNotEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), VERB, f"got {axi!r}")
        self.assertIs(axi.get("ok"), False, f"got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S4 — the body: no `--kind` means no `kind` field
# ═══════════════════════════════════════════════════════════════════════════


class CycleAddBodyWithoutAKindIsUnchangedTest(_BaseCycleAddTest):
    """§S4/AC3 (regression pin) — "today's behaviour byte-identical for every
    existing caller", measured on the REQUEST BODY: an omitted `--kind` must
    leave the field out entirely so the server's own default applies
    (the omitted-kind branch of `parseCycleInput` in src/v2.ts), never send
    a client-chosen `red-green`."""

    PROJECT_KEY = "cycle-add-default-kind-key"

    def test_no_kind_flag_sends_the_body_the_verb_has_always_sent(self):
        plans = _plans_response([_plan("plan-132", THE_CR, "open")])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=True,
                                   extra={"changed": True, "id": 434,
                                          "label": "rework", "kind": "red-green",
                                          "status": "pending"})):
            code, out, err = _run_main(self.module, [
                VERB, "rework", "--cr", THE_CR, "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(post_calls), 1, f"got {post_calls!r}")
        _path, payload = post_calls[0]
        self.assertNotIn(
            "kind", payload,
            f"a caller who named no kind sends no kind — the DEFAULT is the "
            f"server's to apply; got {payload!r}")
        self.assertEqual(
            payload, {"label": "rework", "agentId": "test-agent"},
            f"the body an existing caller sends must be unchanged by this CR; "
            f"got {payload!r}")


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — the client against a fake board, the store's half in bun
# ═══════════════════════════════════════════════════════════════════════════
#
# The real `python-crucible.py`, a genuine subprocess, against a fake board
# (`RecordingBoard`) that answers the plans read and each cycle append in the
# server's own shapes (`handleCycleAppend`, src/v2.ts), its refusal of an
# unknown kind included. What the client SENT is read off the request log.
# What the STORE then holds — the appended cycle read back with its kind
# beside the untouched filed one, an unknown kind refused 400 storing
# nothing, the append landing on a re-filed open plan while its aborted
# sibling keeps exactly its own cycle, a fix needing its verify done — is the
# server's half, held in bun by
# `tests/unit/cycle-append-route-stores-and-refuses-kinds.test.ts` and
# `cycle-add-fix-only.test.ts`.

#: The server's refusal of a kind `parseCycleInput` (src/v2.ts) does not know.
_INVALID_KIND = "invalid kind: {kind} (expected red-green | verify | fix)"


class _ScratchBoardTestBase(unittest.TestCase):

    ORCHESTRATOR = "cycle-add-target-e2e-orchestrator"
    WAVE = "6"

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="cycle-add-target-e2e-")
        self.addCleanup(shutil.rmtree, self._tmpdir, True)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.base = self.board.url
        self.key = str(uuid.uuid4())
        self.plans_path = f"/api/v2/projects/{self.key}/plans"
        self._ids = iter(range(9001, 9100))
        self.project_dir = os.path.join(self._tmpdir, "project")
        os.makedirs(self.project_dir)
        Path(self.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.key}\n")
        self.toon = _load_module_by_path(CLIENTS_DIR / "toon.py",
                                         "cycle_add_target_e2e_toon")

    def _client(self, *argv):
        # CR-CRU-139 §S2 — the fake board is declared in the fixture's own
        # project file, and the interlock refuses the spawn unless the client
        # would really resolve it: these verbs WRITE, and a drive that merely
        # stopped steering would write to another board instead.
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        return subprocess.run(
            [sys.executable, str(CLIENT_FILES["python"])] + list(argv),
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def _filed_plan(self, plan_id, cr, label, status="open"):
        """A plan as `GET …/plans` lists it: its one filed red-green cycle."""
        return {"planId": plan_id, "projectKey": self.key, "cr": cr,
                "title": f"{cr} under test", "wave": self.WAVE,
                "status": status,
                "cycles": [{"id": plan_id * 10, "label": label,
                            "kind": "red-green", "status": "pending"}]}

    def _board_holds(self, *plans):
        """Answer the plans read (every plan, whatever its status) with
        `plans`, and the `filed`/`lastClosedCr` the server computes."""
        self.board.answer("GET", self.plans_path,
                          {"ok": True, "plans": list(plans),
                           "lastClosedCr": None, "filed": len(plans)})

    def _answer_append(self, plan_id, cr, label, kind):
        """Answer the next append to `plan_id` as the server does: the new
        cycle, the plan's cr, and — for a recorded change, any kind but
        `fix` — the process-failure warning; an unknown kind is refused 400
        with `parseCycleInput`'s own wording."""
        path = f"{self.plans_path}/{plan_id}/cycles"
        if kind not in CYCLE_KINDS:
            self.board.answer("POST", path,
                              {"ok": False,
                               "error": _INVALID_KIND.format(kind=kind),
                               "help": ["cycle-add <label> --kind red-green|verify|fix"]},
                              status=400, times=1)
            return
        self.board.answer("POST", path,
                          {"ok": True, "changed": True, "id": next(self._ids),
                           "label": label, "kind": kind, "status": "pending",
                           "cr": cr},
                          times=1)

    def _cycle_add(self, label, *extra):
        return self._client(
            VERB, label, "--agent", self.ORCHESTRATOR,
            "--project-dir", self.project_dir, *extra)

    def _appends(self):
        """Every cycle append the client posted, as `(planId, body)`, in
        wire order."""
        prefix = f"{self.plans_path}/"
        return [(int(p[len(prefix):].split("/")[0]), b)
                for p, b in self.board.posts()
                if p.startswith(prefix) and p.endswith("/cycles")]

    def _writes_beside_appends(self):
        """Every write to the project's plans that is not a cycle append."""
        return [p for p, _ in self.board.posts()
                if p.startswith(self.plans_path) and not p.endswith("/cycles")]


class AddedCycleIsStoredWithTheKindItDeclaredTest(_ScratchBoardTestBase):
    """§S4/AC1 + AC2 — the client sends the kind it was given, to the plan it
    resolved, and relays the server's refusal of a kind the route does not
    know. The read back from the STORE is the server's half (bun,
    `cycle-append-route-stores-and-refuses-kinds.test.ts`)."""

    CR = "CR-124-E2E-KIND"

    def test_a_verify_cycle_reads_as_verify_when_the_plan_is_read_back(self):
        plan_id = 41
        self._board_holds(self._filed_plan(plan_id, self.CR, "the red-green cycle"))
        self._answer_append(plan_id, self.CR, "the verify cycle", "verify")

        # CR-CRU-165 §S1 -- appending a VERIFY cycle to a filed plan is now
        # a recorded plan change (only a FIX append needs nothing more); this
        # fixture's SUBJECT is the stored kind, not the guard, so it supplies
        # the three fields to keep reaching the assertions below.
        run = self._cycle_add("the verify cycle", "--cr", self.CR,
                              KIND_FLAG, "verify",
                              "--reason", "round-trip coverage for this kind",
                              "--cause", "gap-analysis",
                              "--spec-ref", "design note §S4")
        self.assertEqual(
            run.returncode, 0,
            f"`{VERB} {KIND_FLAG} verify` must succeed; "
            f"stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")

        appends = self._appends()
        self.assertEqual(
            [(planned, body.get("label"), body.get("kind"))
             for planned, body in appends],
            [(plan_id, "the verify cycle", "verify")],
            f"exactly one cycle is appended, to the plan `--cr` resolved, "
            f"carrying the KIND it was given — the board's record of what "
            f"kind of work ran starts here; got {appends!r}")
        self.assertEqual(
            self._writes_beside_appends(), [],
            "the plan's existing cycle is untouched: nothing else is written")

    def test_every_declared_kind_round_trips_and_an_unknown_one_is_refused(self):
        plan_id = 42
        cr = f"{self.CR}-ROUNDTRIP"
        self._board_holds(self._filed_plan(plan_id, cr, "the filed cycle"))

        for kind in CYCLE_KINDS:
            self._answer_append(plan_id, cr, f"appended {kind}", kind)
            extra = ()
            if kind != "fix":
                # CR-CRU-165 §S1 -- every kind but `fix` is now a recorded
                # plan change (the FIX exception is the ONLY unrecorded
                # append); this round trip's subject is the stored KIND, so
                # it supplies the three fields to keep reaching the server.
                extra = ("--reason", f"round-trip coverage for {kind}",
                         "--cause", "gap-analysis",
                         "--spec-ref", "design note §S4")
            run = self._cycle_add(f"appended {kind}", PLAN_FLAG, str(plan_id),
                                  KIND_FLAG, kind, *extra)
            self.assertEqual(
                run.returncode, 0,
                f"`{KIND_FLAG} {kind}` is one of the route's own kinds and "
                f"must be accepted; stdout={run.stdout.strip()[:600]!r} "
                f"stderr={run.stderr.strip()[:600]!r}")
            decoded = self.toon.decode(run.stdout)
            self.assertIsNotNone(
                decoded["axi"].get("id"),
                f"the appended cycle's id rides the envelope; got {decoded!r}")

        sent = {body.get("label"): body.get("kind")
                for planned, body in self._appends() if planned == plan_id}
        self.assertEqual(
            {label: sent.get(label) for label in
             (f"appended {kind}" for kind in CYCLE_KINDS)},
            {f"appended {kind}": kind for kind in CYCLE_KINDS},
            f"each declared kind must be sent as ITSELF, to the named plan; "
            f"got {self._appends()!r}")

        self._answer_append(plan_id, cr, "appended smoke", "smoke")
        refused = self._cycle_add("appended smoke", PLAN_FLAG, str(plan_id),
                                  KIND_FLAG, "smoke",
                                  # carries the change record so it clears
                                  # the client's local guard and reaches the
                                  # server's own kind check
                                  "--reason", "round-trip coverage for smoke",
                                  "--cause", "gap-analysis",
                                  "--spec-ref", "design note \u00a7S4")
        self.assertNotEqual(
            refused.returncode, 0,
            f"an unrecognised kind is refused by the server's existing "
            f"parseCycleInput and must surface as a non-zero exit; "
            f"stdout={refused.stdout.strip()[:600]!r}")
        decoded = self.toon.decode(refused.stdout)
        self.assertIn("axi", decoded,
                      f"the refusal is still a TOON-AXI envelope; got "
                      f"{refused.stdout!r}")
        self.assertIs(
            decoded["axi"].get("ok"), False,
            f"the server's refusal must reach the caller as ok:false, not as "
            f"a silently dropped cycle; got {decoded['axi']!r}")
        self.assertIn(
            "invalid kind", (refused.stdout + refused.stderr),
            f"the caller must be told WHICH field the server refused; got "
            f"stdout={refused.stdout.strip()[:600]!r} "
            f"stderr={refused.stderr.strip()[:600]!r}")

        appends = self._appends()
        self.assertEqual(
            [body.get("kind") for _planned, body in appends],
            [*CYCLE_KINDS, "smoke"],
            f"one append per accepted kind, then the one the server refused "
            f"— never retried, never sent as another kind; got {appends!r}")
        self.assertEqual(
            self._writes_beside_appends(), [],
            "nothing but the appends is written")


class PlanFlagAddsACycleToARecoveredCrTest(_ScratchBoardTestBase):
    """§S3/AC4 — the live 2026-09-12 case, end to end: a CR whose earlier plan
    was ABORTED (the sanctioned recovery path) and re-filed, receiving the
    cycle the client refused to add."""

    CR = "CR-124-E2E-ABORTED-SIBLING"

    def test_the_named_plan_receives_the_cycle_despite_the_aborted_sibling(self):
        # The board holds the CR's first plan ABORTED (the terminal sibling
        # the live failure tripped over) and its re-filed plan open.
        aborted_id, live_id = 51, 52
        self._board_holds(
            self._filed_plan(aborted_id, self.CR, "the abandoned cycle",
                             status="aborted"),
            self._filed_plan(live_id, self.CR, "the recovered cycle"))
        self._answer_append(live_id, self.CR,
                            "the cycle the client could not add", "verify")

        # CR-CRU-165 §S1 -- a VERIFY append is a recorded plan change too
        # now; this test's subject is the --plan escape from the ambiguity,
        # not the guard, so it supplies the three fields to keep reaching the
        # assertions below.
        run = self._cycle_add("the cycle the client could not add",
                              PLAN_FLAG, str(live_id), KIND_FLAG, "verify",
                              "--reason", "a spec change added a verify pass here",
                              "--cause", "gap-analysis",
                              "--spec-ref", "design note §S1")
        self.assertEqual(
            run.returncode, 0,
            f"naming the plan directly is the escape from an ambiguity the "
            f"caller cannot otherwise resolve; stdout="
            f"{run.stdout.strip()[:600]!r} stderr="
            f"{run.stderr.strip()[:600]!r}")

        appends = self._appends()
        self.assertEqual(
            [(planned, body.get("label"), body.get("kind"))
             for planned, body in appends],
            [(live_id, "the cycle the client could not add", "verify")],
            f"the cycle is sent to the plan that was NAMED, with the kind it "
            f"declared, and exactly once; got {appends!r}")
        self.assertNotIn(
            aborted_id, [planned for planned, _ in appends],
            "the aborted sibling is settled history and is sent nothing")
        self.assertEqual(
            self._writes_beside_appends(), [],
            "nothing but the one append is written")


if __name__ == "__main__":
    unittest.main()
