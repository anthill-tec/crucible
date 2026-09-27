"""RED — CR-CRU-098 C1: the resolver lands on the SERVER; the shared module
keeps only the thin per-client delegator.

Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md §S3, AC10/AC11
Classification: docs/changes/CR-CRU-098-test-classification.md

Adapts `ResolverLandsOnceTest` (tests/client/test_cr092_next_decision_resolver.py,
KEPT-but-rewritten per the classification table): its
`test_the_shared_module_owns_every_resolver_symbol` asserted the OPPOSITE of
what AC10 now requires (that `canonical_track`/`queue_tracks`/`resolve_next`
ARE callable in the shared module) — that assertion is now WRONG and is
superseded outright rather than weakened; `test_no_client_defines_its_own_
resolver`'s delegating-`cmd_next` shape is UNCHANGED and re-asserted here with
AC10's full symbol list.

RED expectation: today `clients/_crucible_axi.py` still defines every one of
AC10's listed symbols (they are the live resolver behind `cmd_next`) — the
absence test below fails by listing every symbol still present. The five
clients' `cmd_next` delegators are UNCHANGED by this cycle and pass already
(kept, matching the CR-092 precedent of fixture/structural guards that pass
immediately by design — see that file's own RED docstring).

Invocation:
    python3 -m pytest tests/client/test_cr098_resolver_lands_on_the_server.py -q
"""

import ast
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

# AC10 — verbatim. `LANDED_STATUSES` carries no "(unless another verb uses
# it)" exemption here: measured today (grep), its only two call sites are
# both INSIDE the resolver block being deleted (`_next_trigger`,
# `_boundary_announcement`) — no other verb reads it.
AC10_REMOVED_SYMBOLS = (
    "LANDED_STATUSES",
    "QueueTrackFactUnpublished",
    "queue_tracks",
    "_entry_seq",
    "_is_actionable",
    "_dead_entries",
    "_dead_phrase",
    "_next_start_help",
    "_hold_help",
    "_drained_help",
    "_next_trigger",
    "_lane_fields",
    "_announced_fields",
    "_next_answer",
    "_drained_answer",
    "_wave_of_the_lane",
    "_previous_published_wave",
    "_next_published_wave",
    "_boundary_announcement",
    "resolve_next",
    # `canonical_track` STAYS (§S4/AC10, corrected at C3, spec a018e0f): it is
    # `next_context`'s stamp canonicaliser, which the answer cannot supply in
    # a single-track project.
)


def _module_level_names(source: str) -> set:
    """Every name a module-level `def`/`class`/assignment introduces. `ast`,
    not a regex — a docstring mentioning `canonical_track` by name must never
    count as a definition."""
    tree = ast.parse(source, filename=str(AXI_MODULE_PATH))
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


class AC10SharedModuleShedsTheResolverTest(unittest.TestCase):
    """AC10 — none of the listed names has a definition left in
    `clients/_crucible_axi.py`; the resolver moved to `src/next.ts` and the
    route, and the shared module keeps only `cmd_next` (the thin GET + emit)."""

    def test_none_of_ac10s_symbols_is_defined_at_module_level(self):
        source = AXI_MODULE_PATH.read_text(encoding="utf-8")
        present = sorted(AC10_REMOVED_SYMBOLS_still_defined
                         for AC10_REMOVED_SYMBOLS_still_defined in AC10_REMOVED_SYMBOLS
                         if AC10_REMOVED_SYMBOLS_still_defined in _module_level_names(source))
        self.assertEqual(
            present, [],
            f"AC10: these symbols still have a definition in "
            f"clients/_crucible_axi.py and must not \u2014 the resolver moved to "
            f"the server: {present!r}")

    def test_cmd_next_still_lands_exactly_once_in_the_shared_module(self):
        """The ONE symbol AC10 does NOT remove: `cmd_next` (the I/O half) stays
        shared, callable, and singular."""
        source = AXI_MODULE_PATH.read_text(encoding="utf-8")
        defs = [node for node in ast.parse(source).body
                if isinstance(node, ast.FunctionDef) and node.name == "cmd_next"]
        self.assertEqual(
            len(defs), 1,
            "cmd_next must land exactly once in the shared module (the "
            "fleet's DRY rule \u2014 see docstring above)")


class AC11NoClientDefinesItsOwnResolverTest(unittest.TestCase):
    """AC11 — all five clients reach `next` through the ONE shared `cmd_next`;
    none defines its own copy of any AC10 symbol, and each client's own
    `cmd_next` is a single delegating call (the shape CR-CRU-091 C3 settled)."""

    def test_no_client_spells_a_forbidden_resolver_symbol_or_a_fat_cmd_next(self):
        forbidden = re.compile(
            r"^def (" + "|".join(re.escape(name) for name in AC10_REMOVED_SYMBOLS) + r")\b",
            re.M)
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*-crucible.py")):
            source = path.read_text(encoding="utf-8")
            copied = forbidden.findall(source)
            if copied:
                offenders[path.name] = f"resolver copied: {copied!r}"
                continue
            body = [node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef) and node.name == "cmd_next"]
            if len(body) != 1:
                offenders[path.name] = f"{len(body)} `cmd_next` definitions"
                continue
            statements = [s for s in body[0].body
                          if not (isinstance(s, ast.Expr)
                                  and isinstance(s.value, ast.Constant))]
            delegates = (
                len(statements) == 1
                and isinstance(statements[0], ast.Return)
                and isinstance(statements[0].value, ast.Call)
                and isinstance(statements[0].value.func, ast.Attribute)
                and statements[0].value.func.attr == "cmd_next")
            if not delegates:
                offenders[path.name] = (
                    f"`cmd_next` is not a single delegating call: "
                    f"{ast.dump(body[0])[:160]}")
        self.assertEqual(
            offenders, {},
            f"the decision resolver lands ONCE (on the server, post-CR-098) "
            f"and each client contributes a thin delegator only: {offenders!r}")

    def test_the_fixture_genuinely_finds_at_least_one_client_crucible_py(self):
        """Non-vacuity: if the glob found nothing, the test above would pass
        against an EMPTY offenders dict for the wrong reason."""
        clients = sorted(CLIENTS_DIR.glob("*-crucible.py"))
        self.assertGreaterEqual(
            len(clients), 5,
            f"expected the five fleet clients; found {[c.name for c in clients]!r}")


if __name__ == "__main__":
    unittest.main()
