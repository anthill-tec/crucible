"""CR-CRU-054 §S1 -- the client fleet function inventory, encoded as data.

The full classification narrative (per-client differences named, DRIFTED verdicts)
lives in docs/research/DN-client-fleet-inventory.md; THIS module is the
machine-readable fixture the DN promises: the classification as sets of names, plus
tests asserting the inventory matches REALITY on today's tree. It is NOT a test of
future behaviour -- §S2 will change these bodies, and this fixture will need
updating alongside that move (the same way any other characterisation test does).

RED-vs-analysis note: this is an S1 (analysis-only) cycle -- no production code was
moved to produce this file. Every test below passes TODAY, against the client fleet
exactly as it stands after CR-CRU-056/057 (2026-08-02). That is the point: the
fixture is falsifiable NOW (it would fail if the classification named a function
that doesn't exist in all five clients, or double-counted one), and it is what
CR-CRU-054 §S3's drift guard builds on directly.

Method mirrors the DN: `ast.parse` extracts every top-level-or-nested
FunctionDef/AsyncFunctionDef name per client (never grep/eyeball) so a definition
list can never silently miss a nested def.
"""

import ast
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}


def _defined_function_names(path):
    """Every FunctionDef/AsyncFunctionDef name defined anywhere in `path`
    (top-level or nested), via ast.parse -- returns a dict name -> occurrence
    count so a caller can also detect an accidental duplicate top-level def."""
    tree = ast.parse(path.read_text(), filename=str(path))
    counts = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            counts[node.name] = counts.get(node.name, 0) + 1
    return counts


def _defined_in_every_client(name):
    """True iff `name` is defined (>=1 occurrence) in ALL FIVE clients."""
    return all(name in _ALL_CLIENT_FUNCTION_NAMES[client] for client in CLIENT_FILES)


_ALL_CLIENT_FUNCTION_NAMES = {
    client: _defined_function_names(path) for client, path in CLIENT_FILES.items()
}


# ---------------------------------------------------------------------------
# THE CLASSIFICATION (CR-CRU-054 SS1's deliverable, as data)
#
# Full per-name evidence + correctness verdicts: docs/research/DN-client-fleet-
# inventory.md. Re-measured 2026-08-02 per docs/changes/CR-CRU-054-client-fleet-
# dry.md's "The 42, as they stand today" list.
# ---------------------------------------------------------------------------

# The 42 functions the CR spec names as defined in all five clients.
THE_42 = frozenset({
    "_abbrev_home", "_add_gate_cycle_arg", "_agent_id", "_axi", "_axi_context",
    "_close_gate_identity", "cmd_abort", "cmd_auto_ingest", "cmd_check",
    "cmd_checkpoint", "cmd_cr_close", "cmd_cycle_activate", "cmd_cycle_add",
    "cmd_cycle_done", "cmd_dashboard", "cmd_gate_report", "cmd_gate_run",
    "cmd_milestone", "cmd_plan_file", "cmd_pre_merge_gate", "cmd_register",
    "cmd_status", "cmd_stop", "cmd_test", "cmd_unregister", "_cycle_transition",
    "_emit_axi", "_get", "main", "_open_gate_identity", "_open_plans", "_patch",
    "_plans_path", "_post", "_post_gate", "_post_milestone", "_project_key",
    "_remove_agent_silent", "_request", "_resolve_plan_or_emit", "_run_context",
    "_toon",
})

# SHARED (27) -- byte-equivalent OBSERVABLE behaviour; differences found are
# limited to docstring/comment wording or a never-externally-visible internal
# loader-cache label (_axi/_toon's importlib spec_from_file_location name).
SHARED = frozenset({
    "_abbrev_home", "_add_gate_cycle_arg", "_agent_id", "_axi", "_axi_context",
    "cmd_abort", "cmd_checkpoint", "cmd_cr_close", "cmd_cycle_activate",
    "cmd_cycle_add", "cmd_cycle_done", "cmd_gate_report", "cmd_gate_run",
    "cmd_status", "cmd_stop", "_cycle_transition", "_emit_axi", "_get",
    "_open_plans", "_patch", "_plans_path", "_post", "_post_gate",
    "_post_milestone", "_resolve_plan_or_emit", "_run_context", "_toon",
})

# PARAMETERISED (1) -- same shape, a named per-client constant/argument set.
PARAMETERISED = frozenset({
    "cmd_dashboard",
})

# GENUINELY PER-CLIENT (6) -- real runner/toolchain differences, justified in
# the DN (line-count variance alone is 4-452 lines across this set).
GENUINELY_PER_CLIENT = frozenset({
    "cmd_auto_ingest", "cmd_check", "cmd_pre_merge_gate", "cmd_test", "main",
    "_project_key",
})

# DRIFTED (8) -- bodies that SHOULD be identical but are not; a latent defect
# category the CR spec's own two-bucket scheme has no name for. See the DN's
# S4 section for the exact per-client difference + correctness verdict on
# each of these eight names.
DRIFTED = frozenset({
    "cmd_milestone", "cmd_plan_file", "cmd_unregister", "cmd_register",
    "_open_gate_identity", "_remove_agent_silent", "_request",
    "_close_gate_identity",
})

ALL_CATEGORIES = (SHARED, PARAMETERISED, GENUINELY_PER_CLIENT, DRIFTED)
CATEGORY_NAMES = ("SHARED", "PARAMETERISED", "GENUINELY_PER_CLIENT", "DRIFTED")


class FleetInventoryPartitionTest(unittest.TestCase):
    """The classification must be a true PARTITION of THE_42: every name in
    exactly one category, nothing left over, nothing invented."""

    def test_the_42_has_exactly_42_names(self):
        self.assertEqual(
            len(THE_42), 42,
            f"THE_42 must contain exactly 42 names (the CR's own count); "
            f"got {len(THE_42)}")

    def test_category_counts_match_the_dn(self):
        self.assertEqual(len(SHARED), 27, "SHARED must have 27 names (DN count)")
        self.assertEqual(len(PARAMETERISED), 1, "PARAMETERISED must have 1 name (DN count)")
        self.assertEqual(len(GENUINELY_PER_CLIENT), 6,
                         "GENUINELY_PER_CLIENT must have 6 names (DN count)")
        self.assertEqual(len(DRIFTED), 8, "DRIFTED must have 8 names (DN count)")

    def test_every_category_is_a_subset_of_the_42(self):
        for category, label in zip(ALL_CATEGORIES, CATEGORY_NAMES):
            extra = category - THE_42
            self.assertEqual(
                extra, frozenset(),
                f"{label} names {extra!r} are not in THE_42 -- the classification "
                f"must only ever categorise names the CR spec actually lists")

    def test_no_name_appears_in_two_categories(self):
        seen = {}
        offenders = []
        for category, label in zip(ALL_CATEGORIES, CATEGORY_NAMES):
            for name in category:
                if name in seen:
                    offenders.append((name, seen[name], label))
                seen[name] = label
        self.assertEqual(
            offenders, [],
            f"a name must be classified EXACTLY once; found in two categories: "
            f"{offenders!r}")

    def test_the_four_categories_union_to_exactly_the_42(self):
        union = SHARED | PARAMETERISED | GENUINELY_PER_CLIENT | DRIFTED
        self.assertEqual(
            union, THE_42,
            f"SHARED | PARAMETERISED | GENUINELY_PER_CLIENT | DRIFTED must equal "
            f"THE_42 exactly (a true partition) -- missing: {THE_42 - union!r}, "
            f"extra: {union - THE_42!r}")

    def test_the_four_categories_are_pairwise_disjoint(self):
        for i, (cat_a, label_a) in enumerate(zip(ALL_CATEGORIES, CATEGORY_NAMES)):
            for cat_b, label_b in list(zip(ALL_CATEGORIES, CATEGORY_NAMES))[i + 1:]:
                overlap = cat_a & cat_b
                self.assertEqual(
                    overlap, frozenset(),
                    f"{label_a} and {label_b} must be disjoint; overlap: {overlap!r}")


class FleetInventoryMatchesRealityTest(unittest.TestCase):
    """Every classified name must actually be defined, in all five clients,
    on TODAY's tree -- this is what makes the fixture falsifiable rather than
    a static list nobody re-checks."""

    def test_every_name_in_the_42_is_defined_in_all_five_clients(self):
        missing = {
            name: [c for c in CLIENT_FILES if name not in _ALL_CLIENT_FUNCTION_NAMES[c]]
            for name in THE_42
        }
        missing = {k: v for k, v in missing.items() if v}
        self.assertEqual(
            missing, {},
            f"every name in THE_42 must be defined in ALL FIVE clients; "
            f"missing from: {missing!r}")

    def test_every_shared_name_is_defined_in_all_five_clients(self):
        for name in SHARED:
            self.assertTrue(
                _defined_in_every_client(name),
                f"SHARED name {name!r} must be defined in all five clients")

    def test_every_parameterised_name_is_defined_in_all_five_clients(self):
        for name in PARAMETERISED:
            self.assertTrue(
                _defined_in_every_client(name),
                f"PARAMETERISED name {name!r} must be defined in all five clients")

    def test_every_genuinely_per_client_name_is_defined_in_all_five_clients(self):
        """Per the CR's own definition, GENUINELY PER-CLIENT still means
        the NAME is shared fleet-wide (all five expose the same verb) --
        only the BODY is legitimately different, never the name's presence."""
        for name in GENUINELY_PER_CLIENT:
            self.assertTrue(
                _defined_in_every_client(name),
                f"GENUINELY_PER_CLIENT name {name!r} must still be defined "
                f"in all five clients (only its BODY is per-client)")

    def test_every_drifted_name_is_defined_in_all_five_clients(self):
        for name in DRIFTED:
            self.assertTrue(
                _defined_in_every_client(name),
                f"DRIFTED name {name!r} must be defined in all five clients "
                f"(drift is a difference in an otherwise-shared function, not "
                f"an absence)")

    def test_no_client_defines_a_the_42_name_more_than_once_at_top_level(self):
        """A duplicate top-level def (e.g. an accidental copy-paste inside the
        same file) would silently make the SECOND definition win at import
        time -- confirm every name resolves to exactly one occurrence."""
        offenders = []
        for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items():
            for name in THE_42:
                occurrences = counts.get(name, 0)
                if occurrences > 1:
                    offenders.append(f"{client}:{name} ({occurrences}x)")
        self.assertEqual(
            offenders, [],
            f"no THE_42 name may be defined more than once in a single client "
            f"file; found {offenders!r}")


class DriftedFindingsAreStillPresentTest(unittest.TestCase):
    """The DRIFTED category is only meaningful if the documented divergence
    still exists on today's tree -- this is the fixture's falsifiability for
    §4 specifically: if a later cycle fixes one of these without updating this
    module, the corresponding test below would need to flip, which is exactly
    the signal CR-CRU-054 §S3's drift guard is meant to generalise.

    CONVENTION (running score): each of the 8 DRIFTED entries below stays a
    "still present" pin until the cycle that lifts it. At that point the
    entry's test flips from asserting the divergence survives to asserting
    the correction is RESOLVED -- one locus, no client carrying a private
    reimplementation -- per §S4's carve-out (a re-pointed test, never a
    silently deleted one). `_request` flipped in C2 (see
    `test_request_empty_body_guard_now_resolved_uniformly_via_crucible_axi`
    below); the other 7 remain "still present" until their own lift cycles."""

    def _body_after_signature(self, path, name):
        """Return the function body text (signature line stripped, first
        occurrence) for `name` in `path`, or None if not found."""
        text = path.read_text()
        tree = ast.parse(text, filename=str(path))
        lines = text.splitlines(keepends=True)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                raw = "".join(lines[node.lineno - 1:node.end_lineno])
                body_lines = raw.splitlines()
                depth = 0
                sig_end = 0
                for i, line in enumerate(body_lines):
                    depth += line.count("(") - line.count(")")
                    if depth <= 0 and line.rstrip().endswith(":"):
                        sig_end = i
                        break
                return "\n".join(body_lines[sig_end + 1:])
        return None

    def test_cmd_milestone_bun_still_omits_stderr_redirect_unlike_the_other_four(self):
        bun_body = self._body_after_signature(CLIENT_FILES["bun"], "cmd_milestone")
        rust_body = self._body_after_signature(CLIENT_FILES["rust"], "cmd_milestone")
        self.assertNotIn(
            "file=sys.stderr", bun_body,
            "this drift is documented as bun's cmd_milestone NOT redirecting "
            "its legacy print to stderr -- if this now fails, bun has been "
            "fixed and the DN + this fixture need updating, not silencing")
        self.assertIn(
            "file=sys.stderr", rust_body,
            "rust's cmd_milestone is documented as correctly redirecting to stderr")

    def test_cmd_plan_file_bun_still_never_carries_cr_in_its_context(self):
        bun_body = self._body_after_signature(CLIENT_FILES["bun"], "cmd_plan_file")
        mvn_body = self._body_after_signature(CLIENT_FILES["mvn"], "cmd_plan_file")
        self.assertNotIn(
            "_axi_context(project_dir, agent_id=agent_id, cr=", bun_body,
            "documented drift: bun's cmd_plan_file never passes cr= to "
            "_axi_context on either the failure or success path")
        self.assertIn(
            "_axi_context(project_dir, agent_id=agent_id, cr=args.cr)", mvn_body,
            "mvn is documented as carrying cr= on its FAILURE-path envelope too")

    def test_cmd_unregister_and_register_still_split_on_argparse_required_true(self):
        bun_source = CLIENT_FILES["bun"].read_text()
        arduino_source = CLIENT_FILES["arduino"].read_text()
        # bun's unregister/register subparsers still hard-require --agent at
        # the argparse level (bypassing the shared runtime hard-stop).
        self.assertIn('r.add_argument("--agent", required=True', bun_source)
        self.assertIn('u.add_argument("--agent", required=True)', bun_source)
        # arduino's common parser leaves --agent optional; enforcement is
        # the runtime require_agent_id() path (via _agent_id()).
        self.assertIn(
            'common.add_argument("--agent",', arduino_source,
            "arduino's --agent must still be declared on the shared 'common' "
            "parser (no required=True) -- enforcement happens at runtime")

    def test_open_gate_identity_mvn_still_the_lone_explicit_source_override(self):
        mvn_body = self._body_after_signature(CLIENT_FILES["mvn"], "_open_gate_identity")
        bun_body = self._body_after_signature(CLIENT_FILES["bun"], "_open_gate_identity")
        self.assertIn(
            'source="openclaw"', mvn_body,
            "documented drift: mvn is the only client passing an explicit "
            "source override to identity.open_payload() in _open_gate_identity")
        self.assertNotIn(
            'source="openclaw"', bun_body,
            "bun is documented as taking GatedRunIdentity's default source "
            "(claude-md) rather than overriding it")

    def test_remove_agent_silent_bun_still_lacks_the_try_except_the_others_added(self):
        bun_body = self._body_after_signature(CLIENT_FILES["bun"], "_remove_agent_silent")
        python_body = self._body_after_signature(CLIENT_FILES["python"], "_remove_agent_silent")
        self.assertNotIn(
            "except Exception:", bun_body,
            "documented drift: bun's _remove_agent_silent has no try/except "
            "safety net (a raised exception here can crash a gated run's cleanup)")
        self.assertIn(
            "except Exception:", python_body,
            "python (and rust/mvn/arduino) are documented as swallowing the "
            "exception -- best-effort cleanup")

    def test_close_gate_identity_bun_still_reports_the_actual_post_outcome(self):
        bun_body = self._body_after_signature(CLIENT_FILES["bun"], "_close_gate_identity")
        rust_body = self._body_after_signature(CLIENT_FILES["rust"], "_close_gate_identity")
        self.assertIn(
            "cleanup_resp = _remove_agent_silent", bun_body,
            "documented: bun captures _remove_agent_silent's return value and "
            "reports its real ok= outcome")
        self.assertNotIn(
            "cleanup_resp = _remove_agent_silent", rust_body,
            "documented drift: rust (and mvn/python/arduino) discard the "
            "return value and print a FIXED 'removed' message unconditionally")

    def test_request_empty_body_guard_now_resolved_uniformly_via_crucible_axi(self):
        """RESOLVED in C2 (§S2b): the empty-body guard that only arduino used
        to carry now lives in EXACTLY ONE locus -- `_crucible_axi.
        http_request` -- and no client keeps a private reimplementation of
        it. This is the flip named in the class docstring's running-score
        convention; it replaces the "still present" pin this test used to
        make (that pin was only ever true while arduino held a private copy)."""
        axi_path = CLIENTS_DIR / "_crucible_axi.py"
        axi_body = self._body_after_signature(axi_path, "http_request")
        self.assertIn(
            'json.loads(body) if body else {"ok": True}', axi_body,
            "the empty-body guard must live in _crucible_axi.http_request, "
            "the fleet's single transport locus (C1 DN §4 finding #7)")
        for client in CLIENT_FILES:
            client_body = self._body_after_signature(CLIENT_FILES[client], "_request")
            self.assertNotIn(
                "json.loads", client_body,
                f"{client}'s _request must be a thin delegator to "
                f"_crucible_axi.http_request -- no client (arduino included) "
                f"may carry its own json.loads(...) reimplementation of the "
                f"empty-body guard; that private copy is exactly the drift "
                f"CR-CRU-054 §S2b resolved")
            self.assertIn(
                ".http_request(", client_body,
                f"{client}'s _request must delegate to the shared "
                f"http_request(...) rather than reimplementing the transport")


if __name__ == "__main__":
    unittest.main()
