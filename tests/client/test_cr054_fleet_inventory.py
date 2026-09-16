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
import shutil
import tempfile
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

AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"


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

    def test_cmd_milestone_now_writes_to_stderr_fleet_wide(self):
        """RESOLVED (CR-CRU-054 §S2b, DN §4 finding #1): bun's cmd_milestone
        used to write its legacy line to stdout while the other four already
        redirected to stderr. C5 lifted cmd_milestone into
        `_crucible_axi.cmd_milestone` -- the ONE locus that now owns the
        stderr-redirected legacy print -- and every client is a thin
        delegator. Falsifiable both ways: fails if the shared implementation
        regresses off stderr (or off the actual 'milestone: ok=...' print),
        and fails if any client stops delegating and reintroduces a private
        copy of the print itself."""
        axi_body = self._body_after_signature(AXI_MODULE_PATH, "cmd_milestone")
        self.assertIn(
            'print(f"milestone: ok={ok}', axi_body,
            "_crucible_axi.cmd_milestone must still print the legacy "
            "'milestone: ok=...' line -- the fleet's single locus for it "
            "after the C5 lift")
        self.assertIn(
            "file=sys.stderr", axi_body,
            "_crucible_axi.cmd_milestone must write its legacy line to "
            "stderr (DN §4 finding #1, resolved in CR-CRU-054 §S2b)")
        for client in CLIENT_FILES:
            client_body = self._body_after_signature(CLIENT_FILES[client], "cmd_milestone")
            self.assertNotIn(
                'print(f"milestone: ok=', client_body,
                f"{client}'s cmd_milestone must be a thin delegator to "
                f"_crucible_axi.cmd_milestone -- no client (bun included) "
                f"may carry its own private copy of the legacy print; that "
                f"private copy is exactly the drift CR-CRU-054 §S2b resolved")
            self.assertIn(
                ".cmd_milestone(", client_body,
                f"{client}'s cmd_milestone must delegate to the shared "
                f"cmd_milestone(...) rather than reimplementing it")

    def test_cmd_plan_file_now_carries_cr_in_context_on_both_paths_fleet_wide(self):
        """RESOLVED (DN §4 finding #2): bun never passed cr= to _axi_context
        on either path; rust/python omitted it on the failure path only;
        mvn/arduino were already correct on both. C5 lifted cmd_plan_file
        into `_crucible_axi.cmd_plan_file`, which now carries context.cr on
        BOTH paths via `ops.context(...)`, and every client is a thin
        delegator. Falsifiable both ways: fails if the shared implementation
        drops cr= from either envelope, and fails if any client stops
        delegating and reintroduces a private `_axi_context(...)` call of
        its own."""
        axi_body = self._body_after_signature(AXI_MODULE_PATH, "cmd_plan_file")
        self.assertIn(
            "ops.context(project_dir, agent_id=agent_id, cr=args.cr)", axi_body,
            "_crucible_axi.cmd_plan_file must carry context.cr on the "
            "FAILURE path (DN §4 finding #2, resolved)")
        self.assertIn(
            'cr=resp.get("cr") or args.cr)', axi_body,
            "_crucible_axi.cmd_plan_file must carry context.cr on the "
            "SUCCESS path too (DN §4 finding #2, resolved)")
        for client in CLIENT_FILES:
            client_body = self._body_after_signature(CLIENT_FILES[client], "cmd_plan_file")
            self.assertNotIn(
                "_axi_context(", client_body,
                f"{client}'s cmd_plan_file must be a thin delegator to "
                f"_crucible_axi.cmd_plan_file -- no client may carry its "
                f"own private `_axi_context(...)` call; that private copy "
                f"is exactly the drift CR-CRU-054 §S2b resolved")
            self.assertIn(
                ".cmd_plan_file(", client_body,
                f"{client}'s cmd_plan_file must delegate to the shared "
                f"cmd_plan_file(...) rather than reimplementing it")

    def test_cmd_register_and_unregister_agent_flag_now_resolved_optional_fleet_wide(self):
        """RESOLVED (DN §4 finding #3): bun/rust/mvn/python used to
        argparse-`required=True` --agent on register/unregister (a bare
        argparse usage error, bypassing the fleet's §S5 AXI hard-stop
        envelope); arduino's shared `common` parser already left it optional,
        enforced at runtime via `_agent_id`/`require_agent_id`. All FIVE now
        match arduino's shape. Falsifiable both ways: fails if any of the
        four re-pins required=True, and fails if --agent stops being
        declared at all on any client (register/unregister or arduino's
        shared common parser)."""
        for client in ("bun", "rust", "mvn", "python"):
            source = CLIENT_FILES[client].read_text()
            self.assertNotIn(
                'r.add_argument("--agent", required=True', source,
                f"{client}'s register subparser must NOT argparse-require "
                f"--agent any more (DN §4 finding #3, resolved) -- the hard "
                f"stop belongs to the runtime _agent_id() path")
            self.assertNotIn(
                'u.add_argument("--agent", required=True)', source,
                f"{client}'s unregister subparser must NOT argparse-require "
                f"--agent any more (DN §4 finding #3, resolved)")
            self.assertIn(
                'r.add_argument("--agent",', source,
                f"{client}'s register subparser must still declare --agent "
                f"(just no longer required=True)")
            self.assertIn(
                'u.add_argument("--agent",', source,
                f"{client}'s unregister subparser must still declare --agent "
                f"(just no longer required=True)")
        arduino_source = CLIENT_FILES["arduino"].read_text()
        self.assertIn(
            'common.add_argument("--agent",', arduino_source,
            "arduino's --agent must still be declared on the shared "
            "'common' parser (no required=True) -- the shape the other "
            "four now match")

    def test_open_gate_identity_source_override_now_removed_fleet_wide(self):
        """RESOLVED: mvn's lone explicit source="openclaw" override in
        _open_gate_identity is gone -- all FIVE clients now take
        GatedRunIdentity.open_payload()'s own default ("claude-md"), so no
        client passes an explicit `source=` kwarg at all any more.
        Falsifiable both ways: fails if ANY client reintroduces an explicit
        source override (mvn's original defect resurfacing, on mvn or
        elsewhere), and fails if the shared default itself regresses away
        from claude-md."""
        for client in CLIENT_FILES:
            body = self._body_after_signature(CLIENT_FILES[client], "_open_gate_identity")
            self.assertNotIn(
                "source=", body,
                f"{client}'s _open_gate_identity must not pass an explicit "
                f"source= override any more (DN §4 finding #4, resolved) -- "
                f"mvn was the lone offender before this lift")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            'source="claude-md"', axi_source,
            "the shared GatedRunIdentity.open_payload() default source must "
            "still be claude-md -- the value every client now implicitly "
            "relies on by omitting an override")

    def test_remove_agent_silent_try_except_now_present_fleet_wide(self):
        """RESOLVED (DN §4 finding #6): bun's _remove_agent_silent used to
        have no exception guard (rust/mvn/python/arduino already did, but
        discarded the response). C5 lifted it into
        `_crucible_axi.remove_agent_silent`, which now owns the shared
        try/except(OSError, ValueError), returning None on a caught failure
        so close_gate_identity can report "outcome unknown" rather than
        crash or fabricate a fixed "removed"; every client is a thin
        delegator. Falsifiable both ways: fails if the shared guard is
        dropped or stops returning None on failure, and fails if any client
        stops delegating and reintroduces a private guard of its own."""
        axi_body = self._body_after_signature(AXI_MODULE_PATH, "remove_agent_silent")
        self.assertIn(
            "except (OSError, ValueError):", axi_body,
            "_crucible_axi.remove_agent_silent must guard the removal POST "
            "with the shared try/except (DN §4 finding #6, resolved)")
        self.assertIn(
            "return None", axi_body,
            "_crucible_axi.remove_agent_silent must return None on a "
            "caught failure -- the caller's signal to report the outcome "
            "as unknown rather than a blanket success")
        for client in CLIENT_FILES:
            client_body = self._body_after_signature(CLIENT_FILES[client], "_remove_agent_silent")
            self.assertNotIn(
                "except (OSError, ValueError):", client_body,
                f"{client}'s _remove_agent_silent must be a thin delegator "
                f"to _crucible_axi.remove_agent_silent -- no client (bun "
                f"included) may carry its own private try/except guard; "
                f"that private copy is exactly the drift CR-CRU-054 §S2b "
                f"resolved")
            self.assertIn(
                ".remove_agent_silent(", client_body,
                f"{client}'s _remove_agent_silent must delegate to the "
                f"shared remove_agent_silent(...) rather than "
                f"reimplementing it")

    def test_close_gate_identity_now_reports_the_real_post_outcome_fleet_wide(self):
        """RESOLVED (DN §4 finding #6): rust/mvn/python/arduino used to
        discard _remove_agent_silent's return value and print a FIXED
        "removed" message unconditionally (bun was the only one capturing
        and reporting the real outcome). C5 lifted it into
        `_crucible_axi.close_gate_identity`, which now captures
        `cleanup_resp` and reports ITS actual ok=/outcome-unknown state;
        every client is a thin delegator. Falsifiable both ways: fails if
        the shared implementation goes back to discarding the response (or
        stops building the cleanup line FROM that captured value), and
        fails if any client stops delegating and reintroduces a private
        capture of its own."""
        axi_body = self._body_after_signature(AXI_MODULE_PATH, "close_gate_identity")
        self.assertIn(
            "cleanup_resp = (remove_fn(project_dir, identity.agent_id)", axi_body,
            "_crucible_axi.close_gate_identity must capture the removal's "
            "return value into cleanup_resp (DN §4 finding #6, resolved) "
            "-- a discarded response is the original defect")
        self.assertIn(
            "gate_identity_cleanup_line(identity.agent_id, cleanup_resp)", axi_body,
            "_crucible_axi.close_gate_identity must build its report line "
            "FROM the captured cleanup_resp, never a fixed 'removed' "
            "string")
        for client in CLIENT_FILES:
            client_body = self._body_after_signature(CLIENT_FILES[client], "_close_gate_identity")
            self.assertNotIn(
                "cleanup_resp", client_body,
                f"{client}'s _close_gate_identity must be a thin delegator "
                f"to _crucible_axi.close_gate_identity -- no client may "
                f"carry its own private capture of the removal outcome; "
                f"that private copy is exactly the drift CR-CRU-054 §S2b "
                f"resolved")
            self.assertIn(
                ".close_gate_identity(", client_body,
                f"{client}'s _close_gate_identity must delegate to the "
                f"shared close_gate_identity(...) rather than "
                f"reimplementing it")

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


# ---------------------------------------------------------------------------
# CR-CRU-054 C4 FIX -- guard the untested `identity.source` correction.
#
# GREEN flagged that mvn:359's `_narrate_heartbeat` carried a hardcoded
# "openclaw" literal -- outside the documented enum {claude-md, package-json,
# git-repo, manual} -- that NO RED assertion in this cycle covered; the
# `test_open_gate_identity_source_override_now_removed_fleet_wide` fixture
# flip above is only incidental evidence for a DIFFERENT site
# (`_open_gate_identity`). This is the direct guard: every hardcoded
# `identity.source` literal, at every site across the fleet (and the shared
# `_crucible_axi.py`) that builds one, must be an enum member -- the check
# that would have caught the original "openclaw" defect outright.
# ---------------------------------------------------------------------------

IDENTITY_SOURCE_ENUM = frozenset(
    {"claude-md", "package-json", "git-repo", "manual"})


def _boolop_or_constant_strings(node):
    """String constants directly reachable from `node`, following `or`-chain
    BoolOps ONLY (e.g. `getattr(args, "source", None) or "claude-md"`) --
    deliberately does NOT descend into unrelated Call arguments (which would
    also surface an unrelated literal, like the "source" attribute-name
    string `getattr` itself takes)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.BoolOp):
        found = []
        for value in node.values:
            found.extend(_boolop_or_constant_strings(value))
        return found
    return []


def _identity_source_literals(path):
    """Every hardcoded STRING literal `path` ever assigns as an identity
    `source` -- a `{"source": <value>}` dict entry, a `source=` keyword
    argument, or a `source=` parameter default -- AST-walked (never grep) so
    a literal can never hide behind formatting or a helper wrapper."""
    tree = ast.parse(path.read_text(), filename=str(path))
    literals = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "source":
                    literals.extend(_boolop_or_constant_strings(value))
        elif isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == "source":
                    literals.extend(_boolop_or_constant_strings(kw.value))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            params = node.args.args[len(node.args.args) - len(node.args.defaults):]
            for param, default in zip(params, node.args.defaults):
                if param.arg == "source":
                    literals.extend(_boolop_or_constant_strings(default))
    return literals


class IdentitySourceEnumGuardTest(unittest.TestCase):
    """No client (nor the shared `_crucible_axi.py`) may hardcode
    `identity.source` outside the documented enum {claude-md, package-json,
    git-repo, manual} -- the guard the historical mvn `_narrate_heartbeat`
    "openclaw" literal (DN §4, now fixed) had no RED assertion covering."""

    def test_the_sweep_actually_finds_hardcoded_source_literals(self):
        """A guard that finds nothing is not a guard -- confirm the sweep
        picks up at least the known hardcoded sites (mvn's now-corrected
        `_narrate_heartbeat` literal and the shared `GatedRunIdentity.
        open_payload` default) BEFORE trusting the offenders check below;
        this would fail against a no-op/stubbed sweep, so the guard test
        itself can never pass vacuously."""
        mvn_literals = _identity_source_literals(CLIENT_FILES["mvn"])
        self.assertIn(
            "claude-md", mvn_literals,
            "the sweep must find mvn's _narrate_heartbeat hardcoded "
            "identity.source literal")
        axi_literals = _identity_source_literals(AXI_MODULE_PATH)
        self.assertIn(
            "claude-md", axi_literals,
            "the sweep must find _crucible_axi.GatedRunIdentity."
            "open_payload's default source= literal")

    def test_every_hardcoded_identity_source_literal_is_in_the_documented_enum(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            bad = [v for v in _identity_source_literals(path)
                   if v not in IDENTITY_SOURCE_ENUM]
            if bad:
                offenders[client] = bad
        axi_bad = [v for v in _identity_source_literals(AXI_MODULE_PATH)
                   if v not in IDENTITY_SOURCE_ENUM]
        if axi_bad:
            offenders["_crucible_axi"] = axi_bad
        self.assertEqual(
            offenders, {},
            f"the following files hardcode an identity.source literal "
            f"outside {sorted(IDENTITY_SOURCE_ENUM)!r} -- the exact "
            f"historical defect (mvn's _narrate_heartbeat 'openclaw') this "
            f"guard exists to catch: {offenders!r}")


# ---------------------------------------------------------------------------
# CR-CRU-091 SS3/SS10 (AC13/AC19) -- the five roadmap-registration verbs join
# the fleet inventory.
#
# THE_42 above is CR-CRU-054's OWN measurement, re-measured 2026-08-02, and
# its count is load-bearing for that CR's partition arithmetic (four category
# counts that must sum to it). CR-CRU-075 is the cycle that re-freezes ONE
# combined fleet count on the FINAL verb surface -- it is sequenced AFTER this
# CR precisely so the number moves once. So the five names CR-CRU-091 adds are
# frozen HERE as their own named set, checked by the SAME
# `_defined_in_every_client` / duplicate-definition machinery the historical
# set uses, and asserted DISJOINT from THE_42 so neither fixture can quietly
# absorb the other. Nothing in this section touches THE_42's count.
# ---------------------------------------------------------------------------

# The five shared-implementation delegators, one per verb, in every client.
CR091_ROADMAP_VERB_FUNCTIONS = frozenset({
    "cmd_release_propose", "cmd_cr_plan", "cmd_wave_sequence",
    "cmd_cr_supersede", "cmd_cr_void",
})

# The CLI verb names those functions are registered under (AC13 counts 5
# clients x 5 verbs = the 25 pairs AC19 conforms).
CR091_ROADMAP_VERBS = (
    "release-propose", "cr-plan", "wave-sequence", "cr-supersede", "cr-void",
)


def _add_parser_verb_names(path):
    """Every string literal a file passes as the FIRST positional argument of
    an `add_parser(...)` call -- the verb names that file registers. Read from
    the AST rather than by grep, so a name inside a docstring or a help string
    can never be mistaken for a registration."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "add_parser"):
            continue
        if node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            names.add(node.args[0].value)
    return names


def _roadmap_registrar_verbs(path):
    """The verb-name -> delegator mapping a file hands the SHARED registrar,
    read from the `add_roadmap_verbs(...)` call's dict literal. This is where
    a client's registration actually lives: SS9 puts the subparser bodies in
    `_crucible_axi.add_roadmap_verbs` so five clients cannot drift into five
    flag surfaces for one verb, and what stays per-client is exactly this
    mapping onto its own delegators."""
    mapping = {}
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute)
                and func.attr == "add_roadmap_verbs"):
            continue
        for arg in node.args:
            if not isinstance(arg, ast.Dict):
                continue
            for key, value in zip(arg.keys, arg.values):
                if isinstance(key, ast.Constant) and isinstance(value, ast.Name):
                    mapping[key.value] = value.id
    return mapping


_ALL_CLIENT_VERB_NAMES = {
    client: _add_parser_verb_names(path) for client, path in CLIENT_FILES.items()
}

_ALL_CLIENT_ROADMAP_REGISTRATIONS = {
    client: _roadmap_registrar_verbs(path)
    for client, path in CLIENT_FILES.items()
}


class Cr091RoadmapVerbInventoryTest(unittest.TestCase):
    """AC13 -- "the count of clients exposing each verb is 5, not the 1 that
    `queue-file` reaches today"."""

    def test_the_roadmap_set_holds_exactly_the_five_verbs(self):
        self.assertEqual(
            len(CR091_ROADMAP_VERB_FUNCTIONS), 5,
            f"CR-CRU-091 introduces exactly five verbs (SS3's table); got "
            f"{len(CR091_ROADMAP_VERB_FUNCTIONS)}")
        self.assertEqual(len(CR091_ROADMAP_VERBS), 5)

    def test_the_roadmap_set_is_disjoint_from_the_historical_42(self):
        overlap = CR091_ROADMAP_VERB_FUNCTIONS & THE_42
        self.assertEqual(
            overlap, frozenset(),
            f"the CR-CRU-091 set must not touch CR-CRU-054's frozen "
            f"measurement -- re-freezing ONE combined count is CR-CRU-075's, "
            f"sequenced after this CR so the number moves once; "
            f"overlap: {overlap!r}")

    def test_every_roadmap_verb_function_is_defined_in_all_five_clients(self):
        missing = {
            name: [c for c in CLIENT_FILES
                   if name not in _ALL_CLIENT_FUNCTION_NAMES[c]]
            for name in CR091_ROADMAP_VERB_FUNCTIONS
        }
        missing = {k: v for k, v in missing.items() if v}
        self.assertEqual(
            missing, {},
            f"SS3's 'gap not to repeat': all five roadmap verbs reach all "
            f"five clients, never some of them; missing from: {missing!r}")

    def test_no_client_defines_a_roadmap_verb_function_twice(self):
        offenders = []
        for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items():
            for name in CR091_ROADMAP_VERB_FUNCTIONS:
                if counts.get(name, 0) > 1:
                    offenders.append(f"{client}:{name} ({counts[name]}x)")
        self.assertEqual(
            offenders, [],
            f"a duplicate top-level def would silently make the SECOND "
            f"definition win at import time: {offenders!r}")

    def test_the_shared_registrar_registers_all_five_verb_names(self):
        """The subparser bodies live ONCE, so the verb NAMES are asserted
        where they are actually spelled -- the shared registrar."""
        registered = _add_parser_verb_names(AXI_MODULE_PATH)
        missing = [v for v in CR091_ROADMAP_VERBS if v not in registered]
        self.assertEqual(
            missing, [],
            f"`_crucible_axi.add_roadmap_verbs` must register every roadmap "
            f"verb name; missing: {missing!r}")

    def test_every_client_wires_all_five_verbs_to_its_own_delegators(self):
        """The 25 (verb x client) pairs AC13 counts, at the registration
        level: each client hands the shared registrar all five verb names,
        each mapped onto its OWN delegator. The LIVE argparse enumeration and
        envelope conformance for the same 25 pairs lives in the sibling
        `test_client_fleet_envelope_census.py` (AC19 names both harnesses)."""
        offenders = {}
        for client, mapping in _ALL_CLIENT_ROADMAP_REGISTRATIONS.items():
            absent = [v for v in CR091_ROADMAP_VERBS if v not in mapping]
            if absent:
                offenders[client] = f"unwired: {absent!r}"
                continue
            wrong = {v: mapping[v] for v in CR091_ROADMAP_VERBS
                     if mapping[v] not in CR091_ROADMAP_VERB_FUNCTIONS}
            if wrong:
                offenders[client] = f"wired to non-delegators: {wrong!r}"
        self.assertEqual(
            offenders, {},
            f"each client must wire every roadmap verb to its own delegator "
            f"(AC13 counts 5 clients x 5 verbs): {offenders!r}")

    def test_no_client_hand_rolls_a_roadmap_subparser(self):
        """SS9/CR-CRU-054 -- a client spelling its own `add_parser` for a
        roadmap verb has forked the flag surface the shared registrar exists
        to keep identical, even if the delegator behind it is still thin."""
        offenders = {}
        for client, registered in _ALL_CLIENT_VERB_NAMES.items():
            forked = [v for v in CR091_ROADMAP_VERBS if v in registered]
            if forked:
                offenders[client] = forked
        self.assertEqual(
            offenders, {},
            f"the roadmap subparsers are built ONCE, by "
            f"`_crucible_axi.add_roadmap_verbs`: {offenders!r}")

    def test_the_shared_module_holds_the_implementation_the_clients_delegate_to(self):
        """SS9 -- the five verbs land ONCE in `_crucible_axi.py`; a client
        holding its own copy is the CR-CRU-054 defect this CR must not
        reintroduce."""
        shared = _defined_function_names(AXI_MODULE_PATH)
        missing = sorted(n for n in CR091_ROADMAP_VERB_FUNCTIONS
                         if n not in shared)
        self.assertEqual(
            missing, [],
            f"the shared module must define every roadmap verb the clients "
            f"delegate to (SS3/SS9); missing: {missing!r}")

# ---------------------------------------------------------------------------
# CR-CRU-092 SS6 (AC12/AC15) -- `next` joins the fleet inventory.
#
# Same discipline as the CR-CRU-091 section above, for ONE verb: `next` is
# frozen as its OWN named set, asserted DISJOINT from both THE_42 and
# CR-CRU-091's set, and checked by the SAME `_defined_in_every_client` /
# duplicate-definition / hand-rolled-subparser machinery. CR-CRU-075 is still
# the cycle that collapses all three into one re-measured count (42 + 5 + 1 +
# `queue-file`'s parity), so nothing here touches THE_42's arithmetic.
#
# The frozen-set pattern held for a single verb without modification: the sets
# are containers, not counters, so a one-element set costs the same two
# assertions (size, disjointness) a five-element one does.
# ---------------------------------------------------------------------------

# The one shared-implementation delegator, in every client.
CR092_NEXT_VERB_FUNCTIONS = frozenset({"cmd_next"})

# The CLI verb name that function is registered under (AC12 counts 5 clients
# x 1 verb = the 5 pairs AC15 conforms).
CR092_NEXT_VERBS = ("next",)


def _single_verb_registrar_delegator(path, registrar):
    """The delegator a file hands a SHARED one-verb registrar
    (`add_next_verb(...)`, `add_cr_depends_verb(...)`), read from the call's
    second positional argument. A one-verb registrar takes a plain callable
    where `add_roadmap_verbs` takes a verb-name -> delegator dict -- the
    registration a client owns is still exactly this one name, read from the
    AST rather than by grep."""
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == registrar):
            continue
        if len(node.args) >= 2 and isinstance(node.args[1], ast.Name):
            return node.args[1].id
    return None


_ALL_CLIENT_NEXT_REGISTRATIONS = {
    client: _single_verb_registrar_delegator(path, "add_next_verb")
    for client, path in CLIENT_FILES.items()
}


class Cr092NextVerbInventoryTest(unittest.TestCase):
    """AC12 -- "the verb exists in all five clients ... and each is registered
    exactly once"; SS6 -- "`queue-file` is in 1 of 5; this verb must not repeat
    that gap"."""

    def test_the_next_set_holds_exactly_the_one_verb(self):
        self.assertEqual(
            len(CR092_NEXT_VERB_FUNCTIONS), 1,
            f"CR-CRU-092 introduces exactly one verb (SS2's three decisions "
            f"are one verb's answers, not three verbs); got "
            f"{len(CR092_NEXT_VERB_FUNCTIONS)}")
        self.assertEqual(len(CR092_NEXT_VERBS), 1)

    def test_the_next_set_is_disjoint_from_the_earlier_frozen_sets(self):
        """The renumbering happens ONCE, in CR-CRU-075. Until then each CR's
        additions are their own set and no fixture may quietly absorb
        another's."""
        for label, other in (("CR-CRU-054's THE_42", THE_42),
                             ("CR-CRU-091's roadmap set",
                              CR091_ROADMAP_VERB_FUNCTIONS)):
            with self.subTest(other=label):
                overlap = CR092_NEXT_VERB_FUNCTIONS & other
                self.assertEqual(
                    overlap, frozenset(),
                    f"the CR-CRU-092 set must not touch {label}; "
                    f"overlap: {overlap!r}")
        verb_overlap = set(CR092_NEXT_VERBS) & set(CR091_ROADMAP_VERBS)
        self.assertEqual(
            verb_overlap, set(),
            f"`next` is a new CLI verb name, not a rename of a roadmap one; "
            f"overlap: {verb_overlap!r}")

    def test_cmd_next_is_defined_in_all_five_clients(self):
        missing = {
            name: [c for c in CLIENT_FILES
                   if name not in _ALL_CLIENT_FUNCTION_NAMES[c]]
            for name in CR092_NEXT_VERB_FUNCTIONS
        }
        missing = {k: v for k, v in missing.items() if v}
        self.assertEqual(
            missing, {},
            f"SS6's 'gap not to repeat': `next` lands at parity ON ARRIVAL, "
            f"in all five clients; missing from: {missing!r}")

    def test_no_client_defines_cmd_next_twice(self):
        offenders = []
        for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items():
            for name in CR092_NEXT_VERB_FUNCTIONS:
                if counts.get(name, 0) > 1:
                    offenders.append(f"{client}:{name} ({counts[name]}x)")
        self.assertEqual(
            offenders, [],
            f"a duplicate top-level def would silently make the SECOND "
            f"definition win at import time: {offenders!r}")

    def test_the_shared_registrar_registers_the_next_verb_name(self):
        """The subparser body lives ONCE, so the verb NAME is asserted where
        it is actually spelled -- the shared registrar."""
        registered = _add_parser_verb_names(AXI_MODULE_PATH)
        missing = [v for v in CR092_NEXT_VERBS if v not in registered]
        self.assertEqual(
            missing, [],
            f"`_crucible_axi.add_next_verb` must register the verb name; "
            f"missing: {missing!r}")

    def test_every_client_wires_next_to_its_own_delegator(self):
        """The 5 (verb x client) pairs AC12 counts, at the registration level.
        The LIVE argparse enumeration and envelope conformance for the same 5
        pairs lives in the sibling `test_client_fleet_envelope_census.py`
        (AC15 names both harnesses)."""
        offenders = {}
        for client, delegator in _ALL_CLIENT_NEXT_REGISTRATIONS.items():
            if delegator is None:
                offenders[client] = "unwired: no add_next_verb(...) call"
            elif delegator not in CR092_NEXT_VERB_FUNCTIONS:
                offenders[client] = f"wired to a non-delegator: {delegator!r}"
        self.assertEqual(
            offenders, {},
            f"each client must wire `next` to its own delegator (AC12 counts "
            f"5 clients x 1 verb): {offenders!r}")

    def test_no_client_hand_rolls_the_next_subparser(self):
        """SS6/CR-CRU-054 -- a client spelling its own `add_parser("next")`
        has forked the flag surface the shared registrar exists to keep
        identical, even if the delegator behind it is still thin."""
        offenders = {}
        for client, registered in _ALL_CLIENT_VERB_NAMES.items():
            forked = [v for v in CR092_NEXT_VERBS if v in registered]
            if forked:
                offenders[client] = forked
        self.assertEqual(
            offenders, {},
            f"the `next` subparser is built ONCE, by "
            f"`_crucible_axi.add_next_verb`: {offenders!r}")

    def test_the_shared_module_holds_the_implementation_the_clients_delegate_to(self):
        """SS4/SS6 -- the decision resolver landed ONCE in `_crucible_axi.py`
        (CR-CRU-092 C1); a client holding its own copy is the CR-CRU-054
        defect this CR must not reintroduce."""
        shared = _defined_function_names(AXI_MODULE_PATH)
        missing = sorted(n for n in CR092_NEXT_VERB_FUNCTIONS
                         if n not in shared)
        self.assertEqual(
            missing, [],
            f"the shared module must define the verb the clients delegate "
            f"to (SS4/SS6); missing: {missing!r}")

# ---------------------------------------------------------------------------
# CR-CRU-106 SS1 -- `cr-depends` joins the fleet inventory.
#
# The same one-verb discipline as the CR-CRU-092 section above. Two things are
# this section's own. First, the verb has its OWN registrar
# (`add_cr_depends_verb`) rather than being a sixth entry in
# `add_roadmap_verbs`, because that registrar's contract is CR-CRU-091's
# FROZEN FIVE, asserted by name above -- so this section also asserts that no
# client smuggles `cr-depends` into the roadmap dict. Second, the verb reached
# python only when it first landed (cycle 1), which is precisely the
# `queue-file` shape CR-CRU-091 SS3 calls "the gap not to repeat"; cycle 2
# brings it to parity, and this section is what keeps it there.
# ---------------------------------------------------------------------------

# The one shared-implementation delegator, in every client.
CR106_DEPENDS_VERB_FUNCTIONS = frozenset({"cmd_cr_depends"})

# The CLI verb name that function is registered under (5 clients x 1 verb).
CR106_DEPENDS_VERBS = ("cr-depends",)

_ALL_CLIENT_DEPENDS_REGISTRATIONS = {
    client: _single_verb_registrar_delegator(path, "add_cr_depends_verb")
    for client, path in CLIENT_FILES.items()
}


class Cr106CrDependsVerbInventoryTest(unittest.TestCase):
    """CR-CRU-106 SS1 -- one verb, in all five clients, registered exactly
    once each, by its OWN registrar."""

    def test_the_depends_set_holds_exactly_the_one_verb(self):
        self.assertEqual(len(CR106_DEPENDS_VERB_FUNCTIONS), 1)
        self.assertEqual(len(CR106_DEPENDS_VERBS), 1)

    def test_the_depends_set_is_disjoint_from_every_earlier_frozen_set(self):
        """The renumbering happens ONCE, in the fleet-count re-freeze cycle;
        until then each CR's additions are their own set and no fixture may
        quietly absorb another's."""
        for label, other in (("THE_42", THE_42),
                             ("the roadmap set", CR091_ROADMAP_VERB_FUNCTIONS),
                             ("the next set", CR092_NEXT_VERB_FUNCTIONS)):
            with self.subTest(other=label):
                overlap = CR106_DEPENDS_VERB_FUNCTIONS & other
                self.assertEqual(
                    overlap, frozenset(),
                    f"the cr-depends set must not touch {label}; "
                    f"overlap: {overlap!r}")
        verb_overlap = set(CR106_DEPENDS_VERBS) & (
            set(CR091_ROADMAP_VERBS) | set(CR092_NEXT_VERBS))
        self.assertEqual(
            verb_overlap, set(),
            f"`cr-depends` is a new CLI verb name, not a rename; "
            f"overlap: {verb_overlap!r}")

    def test_cmd_cr_depends_is_defined_in_all_five_clients(self):
        missing = {
            name: [c for c in CLIENT_FILES
                   if name not in _ALL_CLIENT_FUNCTION_NAMES[c]]
            for name in CR106_DEPENDS_VERB_FUNCTIONS
        }
        missing = {k: v for k, v in missing.items() if v}
        self.assertEqual(
            missing, {},
            f"SS3's 'gap not to repeat' -- `cr-depends` reached python only "
            f"in cycle 1; it must land at parity; missing from: {missing!r}")

    def test_no_client_defines_cmd_cr_depends_twice(self):
        offenders = []
        for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items():
            for name in CR106_DEPENDS_VERB_FUNCTIONS:
                if counts.get(name, 0) > 1:
                    offenders.append(f"{client}:{name} ({counts[name]}x)")
        self.assertEqual(
            offenders, [],
            f"a duplicate top-level def would silently make the SECOND "
            f"definition win at import time: {offenders!r}")

    def test_the_shared_registrar_registers_the_depends_verb_name(self):
        registered = _add_parser_verb_names(AXI_MODULE_PATH)
        missing = [v for v in CR106_DEPENDS_VERBS if v not in registered]
        self.assertEqual(
            missing, [],
            f"`_crucible_axi.add_cr_depends_verb` must register the verb "
            f"name; missing: {missing!r}")

    def test_every_client_wires_cr_depends_to_its_own_delegator(self):
        """The 5 (verb x client) pairs, at the registration level. The LIVE
        argparse enumeration and envelope conformance for the same 5 pairs
        lives in the sibling `test_client_fleet_envelope_census.py`."""
        offenders = {}
        for client, delegator in _ALL_CLIENT_DEPENDS_REGISTRATIONS.items():
            if delegator is None:
                offenders[client] = "unwired: no add_cr_depends_verb(...) call"
            elif delegator not in CR106_DEPENDS_VERB_FUNCTIONS:
                offenders[client] = f"wired to a non-delegator: {delegator!r}"
        self.assertEqual(
            offenders, {},
            f"each client must wire `cr-depends` to its own delegator "
            f"(5 clients x 1 verb): {offenders!r}")

    def test_no_client_hand_rolls_the_cr_depends_subparser(self):
        offenders = {}
        for client, registered in _ALL_CLIENT_VERB_NAMES.items():
            forked = [v for v in CR106_DEPENDS_VERBS if v in registered]
            if forked:
                offenders[client] = forked
        self.assertEqual(
            offenders, {},
            f"the `cr-depends` subparser is built ONCE, by "
            f"`_crucible_axi.add_cr_depends_verb`: {offenders!r}")

    def test_no_client_smuggles_cr_depends_into_the_frozen_five(self):
        """The roadmap registrar's contract is CR-CRU-091's FROZEN FIVE. A
        client handing it a sixth `cr-depends` entry would either be ignored
        by the registrar (a silently unwired verb) or, if the registrar grew
        to accept it, would fork the count the fleet inventory freezes."""
        offenders = {
            client: sorted(set(mapping) & set(CR106_DEPENDS_VERBS))
            for client, mapping in _ALL_CLIENT_ROADMAP_REGISTRATIONS.items()
            if set(mapping) & set(CR106_DEPENDS_VERBS)
        }
        self.assertEqual(
            offenders, {},
            f"`cr-depends` has its OWN registrar; the roadmap dict stays the "
            f"frozen five: {offenders!r}")

    def test_the_shared_module_holds_the_implementation_the_clients_delegate_to(self):
        shared = _defined_function_names(AXI_MODULE_PATH)
        missing = sorted(n for n in CR106_DEPENDS_VERB_FUNCTIONS
                         if n not in shared)
        self.assertEqual(
            missing, [],
            f"the shared module must define the verb the clients delegate "
            f"to; missing: {missing!r}")



# ---------------------------------------------------------------------------
# CR-CRU-094 SS4 (AC7/AC8) -- the status field is renamed to state the fact it
# computes, fleet-wide, and the old name is GONE.
#
# This section is the PRESENCE half of AC8, in the harness AC8 names ("asserted
# by extending the two EXISTING harnesses ... rather than a parallel checker").
# The ENVELOPE half -- what the five clients actually emit on the wire, and
# what their live `--help` prints -- lives in the sibling
# `test_client_fleet_envelope_census.py`, exactly as the CR-CRU-091/092
# sections above split registration from conformance.
#
# What the field computes has never changed: the `cr` of the plan with the
# latest `closedAt` -- the last CR to close/merge. Only the NAME moves, from
# one that read as "the CR of the most recent run" (which the fleet does not
# compute anywhere) to one that traces to the column it sorts by. It is a
# CLEAN BREAK, not an alias: the CR-CRU-059 SS0 precedent for a fleet-wide
# rename is "no alias, no dual-key handling, no deprecation path".
# ---------------------------------------------------------------------------

# The shared computation, at its single locus, under its new name.
CR094_LAST_CLOSED_CR_FUNCTION = "last_closed_cr"

# The spellings the rename retires. A client still carrying either -- in code,
# in a docstring, or in help text -- is a client still advertising the field
# that lied, so a provenance note must DESCRIBE the old name rather than spell
# it, the same discipline the shipped-CR carve-out follows.
CR094_RETIRED_SPELLINGS = ("lastRunCr", "last_run_cr")


def _status_verb_registration(path):
    """The (verb names, help text) argparse advertises for the status/plans
    verb PAIR in `path`. All five clients register the pair with one loop
    (`for _name in ("status", "plans"): sub.add_parser(_name, help=...)`), so
    the extraction keys off that idiom rather than a line number: find the
    `for` whose iterable is a literal tuple naming `status`, and return its
    `add_parser(help=...)` constant. Returns (None, None) when a client stops
    using the shared idiom -- reported as a failure below, never as a silent
    pass on a surface that moved."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.For):
            continue
        try:
            names = ast.literal_eval(node.iter)
        except (ValueError, SyntaxError):
            continue
        if not isinstance(names, (tuple, list)) or "status" not in names:
            continue
        for call in ast.walk(node):
            if not (isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "add_parser"):
                continue
            for kw in call.keywords:
                if kw.arg == "help" and isinstance(kw.value, ast.Constant):
                    return tuple(names), kw.value.value
    return None, None


_ALL_CLIENT_STATUS_REGISTRATIONS = {
    client: _status_verb_registration(path)
    for client, path in CLIENT_FILES.items()
}


class Cr094LastClosedCrRenameInventoryTest(unittest.TestCase):
    """AC7 -- one renamed field, at one locus, advertised identically by all
    five clients, with the retired name present nowhere in the shipped fleet
    source."""

    def test_the_shared_module_computes_the_field_under_its_new_name(self):
        """The computation stays where it is (one locus the five clients
        delegate to); only its name moves."""
        shared = _defined_function_names(AXI_MODULE_PATH)
        self.assertIn(
            CR094_LAST_CLOSED_CR_FUNCTION, shared,
            f"the shared module must define the computation under the name "
            f"that states it; defined names lack "
            f"{CR094_LAST_CLOSED_CR_FUNCTION!r}")
        self.assertNotIn(
            "last_run_cr", shared,
            "the old function name must be GONE, not kept as a wrapper or an "
            "alias -- a second name for one computation is how the fleet ends "
            "up emitting both keys")

    def test_no_client_defines_the_renamed_computation_privately(self):
        """Fleet discipline: the clients delegate, they do not each carry a
        private copy of the computation under the new name."""
        offenders = [client for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items()
                     if CR094_LAST_CLOSED_CR_FUNCTION in counts]
        self.assertEqual(
            offenders, [],
            f"the computation lives ONCE, in the shared module; no client may "
            f"fork it under the new name: {offenders!r}")

    def test_the_retired_spellings_survive_nowhere_in_the_shipped_fleet_source(self):
        """The clean break, across the shared module and all five clients --
        which covers both per-client sites at once (the `cmd_status` docstring
        and the argparse help string), and any third the sweep would otherwise
        miss."""
        offenders = {}
        for label, path in [("_crucible_axi", AXI_MODULE_PATH)] + list(CLIENT_FILES.items()):
            text = path.read_text()
            hits = [s for s in CR094_RETIRED_SPELLINGS if s in text]
            if hits:
                offenders[label] = hits
        self.assertEqual(
            offenders, {},
            f"the retired spellings must appear NOWHERE in the shipped fleet "
            f"source -- not as a key, a function, an alias, or a docstring "
            f"mention: {offenders!r}")

    def test_every_client_registers_the_status_and_plans_pair_with_one_help_string(self):
        """Non-vacuity for the two help tests below: if this extraction found
        nothing, 'no client advertises the old wording' would be vacuously
        true in every client."""
        offenders = {}
        for client, (names, help_text) in _ALL_CLIENT_STATUS_REGISTRATIONS.items():
            if names is None or help_text is None:
                offenders[client] = "no status/plans add_parser(help=...) found"
            elif set(names) != {"status", "plans"}:
                offenders[client] = f"registers {names!r}, not the verb pair"
        self.assertEqual(
            offenders, {},
            f"every client must register the status verb and its plans alias "
            f"from one help string, or the help assertions below measure "
            f"nothing: {offenders!r}")

    def test_every_client_help_names_the_field_and_states_the_fact_it_computes(self):
        offenders = {}
        for client, (_names, help_text) in _ALL_CLIENT_STATUS_REGISTRATIONS.items():
            squeezed = " ".join((help_text or "").split()).lower()
            if "lastclosedcr" not in squeezed:
                offenders[client] = f"help does not name the field: {help_text!r}"
            elif "last cr to close" not in squeezed:
                offenders[client] = (
                    f"help does not state the fact computed: {help_text!r}")
        self.assertEqual(
            offenders, {},
            f"all five clients advertise this field; each must name it and "
            f"say what it is -- the last CR to close: {offenders!r}")

    def test_no_client_help_still_describes_the_field_as_the_most_recent_run(self):
        """The defect stated as a REJECTION, not only as a new expectation: a
        client left describing the CR of the most recent run keeps the
        misreading alive even where the envelope key is already correct."""
        offenders = {}
        for client, (_names, help_text) in _ALL_CLIENT_STATUS_REGISTRATIONS.items():
            squeezed = " ".join((help_text or "").split()).lower()
            stale = [phrase for phrase in ("lastruncr", "most recent run")
                     if phrase in squeezed]
            if stale:
                offenders[client] = stale
        self.assertEqual(
            offenders, {},
            f"no client's help may still carry the retired name or the 'most "
            f"recent run' reading: {offenders!r}")


# ---------------------------------------------------------------------------
# CR-CRU-075 SS2 -- `queue-file` joins the fleet inventory, and the inventory
# stops depending on somebody remembering to add the NEXT one.
#
# Two things land here and they are deliberately different in kind.
#
# FIRST, the per-CR set. `queue-file` is frozen exactly as CR-CRU-091 SS3,
# CR-CRU-092 SS6 and CR-CRU-106 SS1 froze theirs: its own named set, checked
# by the SAME `_defined_in_every_client` / duplicate-definition /
# shared-registrar / no-hand-rolled-subparser machinery, and disjoint from all
# four earlier sets. THE_42 and its four categories are NOT touched -- those
# are CR-CRU-054's own per-name drift VERDICTS, evidenced in
# docs/research/DN-client-fleet-inventory.md, and dropping a delegator nobody
# measured into one of them would assert a measurement nobody made.
#
# SECOND, and this is the part that closes the actual hole: a per-CR set still
# needs a human to write it, so the verb NOBODY freezes stays invisible --
# which is exactly how `queue-file` sat in 1 of 5 clients across three CRs that
# each cited it, by name, as the gap not to repeat. The derived check further
# down reads the shared module's REGISTRARS and requires every verb name they
# register to be wired in all five clients. It holds no list of verbs, so a
# verb added tomorrow is enforced the day it lands.
# ---------------------------------------------------------------------------

# The one shared-implementation delegator, in every client.
CR075_QUEUE_FILE_VERB_FUNCTIONS = frozenset({"cmd_queue_file"})

# The CLI verb name that function is registered under (5 clients x 1 verb).
CR075_QUEUE_FILE_VERBS = ("queue-file",)

# Every post-CR-054 frozen verb-function set, by the label its own section
# uses. The point of the tuple is that the sets stay FOUR: collapsing any two
# of them into one count is what the four sections each refused, and what the
# integrity test below now refuses in one place.
POST_CR054_VERB_FUNCTION_SETS = (
    ("the roadmap set", CR091_ROADMAP_VERB_FUNCTIONS),
    ("the next set", CR092_NEXT_VERB_FUNCTIONS),
    ("the cr-depends set", CR106_DEPENDS_VERB_FUNCTIONS),
    ("the queue-file set", CR075_QUEUE_FILE_VERB_FUNCTIONS),
)

POST_CR054_VERB_NAME_SETS = (
    ("the roadmap verbs", frozenset(CR091_ROADMAP_VERBS)),
    ("the next verb", frozenset(CR092_NEXT_VERBS)),
    ("the cr-depends verb", frozenset(CR106_DEPENDS_VERBS)),
    ("the queue-file verb", frozenset(CR075_QUEUE_FILE_VERBS)),
)


def _queue_file_registration_offenders(client_paths):
    """Which of `client_paths` fails to wire `queue-file` onto its OWN
    delegator through the shared registrar, and why.

    Lifted out of the assertion rather than inlined into it so the injection
    proof below drives the REAL check against a scratch fleet, instead of a
    second copy of the check that could pass while the shipped one does
    not."""
    offenders = {}
    for client, path in client_paths.items():
        delegator = _single_verb_registrar_delegator(path, "add_queue_file_verb")
        if delegator is None:
            offenders[client] = "unwired: no add_queue_file_verb(...) call"
        elif delegator not in CR075_QUEUE_FILE_VERB_FUNCTIONS:
            offenders[client] = f"wired to a non-delegator: {delegator!r}"
    return offenders


def _scratch_fleet(tmpdir):
    """Copies of the shared module and all five clients under `tmpdir`, for
    the injection proofs -- mirroring CR-CRU-054 SS3's own on-disk idiom
    (`test_cr054_drift_guard.py`'s scratch-file proof). The copies are only
    ever PARSED, never imported or run, so a mutation that breaks a runtime
    import is still a fair input to an AST checker. The real tree is never
    written to."""
    dest = Path(tmpdir) / "clients"
    dest.mkdir(parents=True)
    axi_copy = dest / AXI_MODULE_PATH.name
    shutil.copy(AXI_MODULE_PATH, axi_copy)
    clients = {}
    for client, path in CLIENT_FILES.items():
        clients[client] = dest / path.name
        shutil.copy(path, clients[client])
    return axi_copy, clients


def _node_span(text, node):
    """The absolute (start, end) offsets of `node` in `text`, from the AST's
    own line/column positions -- so an injection cuts exactly the expression
    the parser saw, never a regex's guess at it."""
    starts = [0]
    for line in text.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    return (starts[node.lineno - 1] + node.col_offset,
            starts[node.end_lineno - 1] + node.end_col_offset)


def _called_registrar_name(node):
    """The registrar a Call node names, whether the client spells it on the
    shared module (`_axi().add_x_verb(...)`) or as a bare import."""
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    return getattr(func, "id", None)


def _drop_registrar_call(path, registrar):
    """Delete one client's whole `registrar(...)` statement, in place, on a
    SCRATCH copy -- the shape of a client that never wired the verb."""
    text = path.read_text()
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        if _called_registrar_name(node.value) != registrar:
            continue
        start, end = _node_span(text, node)
        path.write_text(text[:start] + "pass" + text[end:])
        return True
    return False


def _drop_registrar_dict_entry(path, verb):
    """Delete ONE verb from a client's registrar dict, in place, on a SCRATCH
    copy -- the subtler shape: the client still calls the registrar, it just
    stopped handing it one of the verbs."""
    text = path.read_text()
    for node in ast.walk(ast.parse(text)):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values):
            if not (isinstance(key, ast.Constant) and key.value == verb):
                continue
            start, _ = _node_span(text, key)
            _, end = _node_span(text, value)
            path.write_text(text[:start] + text[end:].lstrip(", "))
            return True
    return False


def _wire_call_after(path, registrar, call_source):
    """Insert `call_source` immediately after a client's existing
    `registrar(...)` statement, at that statement's own indentation -- on a
    SCRATCH copy. This is how the four wired clients of the unnamed-verb proof
    are wired."""
    text = path.read_text()
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        if _called_registrar_name(node.value) != registrar:
            continue
        lines = text.splitlines(keepends=True)
        lines.insert(node.end_lineno, " " * node.col_offset + call_source + "\n")
        path.write_text("".join(lines))
        return True
    return False


def _bury_registrar_call_in_dead_code(path, registrar, *, shape):
    """Rewrite one client's `registrar(...)` statement, in place on a SCRATCH
    copy, into a registration that is still WRITTEN but can never RUN --
    `shape="dead function"` moves it into a module-level function nothing
    calls, `shape="if False"` leaves it where it is under a test that is never
    true. Both keep the file parseable and keep every character of the call,
    which is the point: only reachability changed."""
    text = path.read_text()
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        if _called_registrar_name(node.value) != registrar:
            continue
        indent = " " * node.col_offset
        call = ast.unparse(node)
        start, end = _node_span(text, node)
        if shape == "if False":
            path.write_text(text[:start] + "if False:\n" + indent + "    "
                            + call + text[end:])
        elif shape == "dead function":
            path.write_text(text[:start] + "pass" + text[end:]
                            + "\n\ndef _wiring_nothing_calls(sub, *funcs):\n"
                            + "    " + call + "\n")
        else:
            raise ValueError(f"unknown dead-code shape: {shape!r}")
        return True
    return False


def _hoist_registrar_call_to_module_level(path, registrar):
    """Move one client's `registrar(...)` statement out of `main()` and to the
    END of the module, in place on a SCRATCH copy -- the OTHER shape the rule
    accepts. A module body runs, so a registration written there is wired, and
    a rule that only ever looked inside `main()` would report this client as an
    offender."""
    text = path.read_text()
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        if _called_registrar_name(node.value) != registrar:
            continue
        call = ast.unparse(node)
        start, end = _node_span(text, node)
        path.write_text(text[:start] + "pass" + text[end:] + "\n" + call + "\n")
        return True
    return False


class Cr075QueueFileVerbInventoryTest(unittest.TestCase):
    """CR-CRU-075 SS2/AC3 -- one verb, in all five clients, registered exactly
    once each, by its OWN shared registrar.

    The verb this section freezes is the one the three sections above each
    named as the counter-example: `queue-file` shipped in CR-CRU-014 SS2 with
    its parse and its POST in the shared module and its SUBPARSER left
    per-client, so it was an envelope on python and argparse's `invalid
    choice` on the other four. SS1 wired it through `add_queue_file_verb`;
    this section is what keeps it there."""

    def test_the_queue_file_set_holds_exactly_the_one_verb(self):
        self.assertEqual(len(CR075_QUEUE_FILE_VERB_FUNCTIONS), 1)
        self.assertEqual(len(CR075_QUEUE_FILE_VERBS), 1)

    def test_the_queue_file_set_is_disjoint_from_every_earlier_frozen_set(self):
        """The per-CR sets stay per-CR. This CR adds a fourth one and a
        DERIVED check; it does not renumber, merge or absorb any of the
        three that precede it."""
        for label, other in (("THE_42", THE_42),
                             ("the roadmap set", CR091_ROADMAP_VERB_FUNCTIONS),
                             ("the next set", CR092_NEXT_VERB_FUNCTIONS),
                             ("the cr-depends set",
                              CR106_DEPENDS_VERB_FUNCTIONS)):
            with self.subTest(other=label):
                overlap = CR075_QUEUE_FILE_VERB_FUNCTIONS & other
                self.assertEqual(
                    overlap, frozenset(),
                    f"the queue-file set must not touch {label}; "
                    f"overlap: {overlap!r}")
        verb_overlap = set(CR075_QUEUE_FILE_VERBS) & (
            set(CR091_ROADMAP_VERBS) | set(CR092_NEXT_VERBS)
            | set(CR106_DEPENDS_VERBS))
        self.assertEqual(
            verb_overlap, set(),
            f"`queue-file` is CR-014's own CLI verb name, not a rename of a "
            f"later one; overlap: {verb_overlap!r}")

    def test_cmd_queue_file_is_defined_in_all_five_clients(self):
        missing = {
            name: [c for c in CLIENT_FILES
                   if name not in _ALL_CLIENT_FUNCTION_NAMES[c]]
            for name in CR075_QUEUE_FILE_VERB_FUNCTIONS
        }
        missing = {k: v for k, v in missing.items() if v}
        self.assertEqual(
            missing, {},
            f"the delegator the three sections above call 'the gap not to "
            f"repeat' must itself reach all five clients; missing from: "
            f"{missing!r}")

    def test_no_client_defines_cmd_queue_file_twice(self):
        offenders = []
        for client, counts in _ALL_CLIENT_FUNCTION_NAMES.items():
            for name in CR075_QUEUE_FILE_VERB_FUNCTIONS:
                if counts.get(name, 0) > 1:
                    offenders.append(f"{client}:{name} ({counts[name]}x)")
        self.assertEqual(
            offenders, [],
            f"a duplicate top-level def would silently make the SECOND "
            f"definition win at import time: {offenders!r}")

    def test_the_shared_registrar_registers_the_queue_file_verb_name(self):
        registered = _add_parser_verb_names(AXI_MODULE_PATH)
        missing = [v for v in CR075_QUEUE_FILE_VERBS if v not in registered]
        self.assertEqual(
            missing, [],
            f"`_crucible_axi.add_queue_file_verb` must register the verb "
            f"name; missing: {missing!r}")

    def test_every_client_wires_queue_file_to_its_own_delegator(self):
        """The 5 (verb x client) pairs, at the registration level. The LIVE
        argparse enumeration and envelope conformance for the same 5 pairs
        lives in the sibling `test_client_fleet_envelope_census.py`."""
        offenders = _queue_file_registration_offenders(CLIENT_FILES)
        self.assertEqual(
            offenders, {},
            f"each client must wire `queue-file` to its own delegator "
            f"(5 clients x 1 verb): {offenders!r}")

    def test_dropping_queue_file_from_one_client_fails_and_names_that_client(self):
        """AC3's own falsifiability clause -- \"Removing `queue-file` from any
        ONE client fails this\" -- proven by INJECTION on a scratch copy, not
        by construction: the assertion above is only worth its line if it
        actually fires, and a failure that does not NAME the client sends the
        next reader to all five."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            _axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _drop_registrar_call(clients["mvn"], "add_queue_file_verb"),
                "the injection found no registrar call to drop -- the proof "
                "below would then pass for the wrong reason")
            offenders = _queue_file_registration_offenders(clients)
        self.assertEqual(
            offenders,
            {"mvn": "unwired: no add_queue_file_verb(...) call"},
            f"the check must fire for the ONE client whose registration was "
            f"removed, name it, and clear the other four: {offenders!r}")

    def test_no_client_hand_rolls_the_queue_file_subparser(self):
        """The defect SS1 fixed, stated as a rejection: python owned its own
        `add_parser(\"queue-file\")` for the whole of CR-CRU-014's life, which
        is how one verb ended up with one client's flag surface and four
        clients' `invalid choice`."""
        offenders = {}
        for client, registered in _ALL_CLIENT_VERB_NAMES.items():
            forked = [v for v in CR075_QUEUE_FILE_VERBS if v in registered]
            if forked:
                offenders[client] = forked
        self.assertEqual(
            offenders, {},
            f"the `queue-file` subparser is built ONCE, by "
            f"`_crucible_axi.add_queue_file_verb`: {offenders!r}")

    def test_no_client_smuggles_queue_file_into_the_frozen_five(self):
        """Same rule the cr-depends section states: the roadmap registrar's
        contract is CR-CRU-091's frozen five, so a sixth entry is either
        silently unwired or a fork of the count that section freezes."""
        offenders = {
            client: sorted(set(mapping) & set(CR075_QUEUE_FILE_VERBS))
            for client, mapping in _ALL_CLIENT_ROADMAP_REGISTRATIONS.items()
            if set(mapping) & set(CR075_QUEUE_FILE_VERBS)
        }
        self.assertEqual(
            offenders, {},
            f"`queue-file` has its OWN registrar; the roadmap dict stays the "
            f"frozen five: {offenders!r}")

    def test_the_shared_module_holds_the_implementation_the_clients_delegate_to(self):
        shared = _defined_function_names(AXI_MODULE_PATH)
        missing = sorted(n for n in CR075_QUEUE_FILE_VERB_FUNCTIONS
                         if n not in shared)
        self.assertEqual(
            missing, [],
            f"the shared module must define the verb the clients delegate "
            f"to; missing: {missing!r}")


class Cr075FrozenSetIntegrityTest(unittest.TestCase):
    """AC3's second half, and the CR's own Non-goal: THE_42's count and its
    four measured categories are UNCHANGED by this CR, and no post-CR-054 set
    is collapsed into another.

    The partition arithmetic itself is asserted by `FleetInventoryPartitionTest`
    at the top of this file and is NOT restated here -- restating it would add
    a second place for one rule to drift. What this class adds is the fact
    that class cannot see: that the four sets which grew AFTER CR-CRU-054's
    measurement have stayed outside it, and outside each other."""

    def test_no_post_054_delegator_has_been_classified_into_a_measured_category(self):
        """A new delegator dropped into SHARED/PARAMETERISED/GENUINELY_PER_
        CLIENT/DRIFTED would claim one of CR-CRU-054's per-name drift
        verdicts for a name nobody measured -- and would do it while the
        partition tests above still passed, because those assert shape, not
        provenance."""
        strays = {}
        for label, verb_functions in POST_CR054_VERB_FUNCTION_SETS:
            for category, category_label in zip(ALL_CATEGORIES, CATEGORY_NAMES):
                overlap = verb_functions & category
                if overlap:
                    strays[f"{label} in {category_label}"] = sorted(overlap)
        self.assertEqual(
            strays, {},
            f"the four measured categories hold the original 42 measured "
            f"names and nothing else -- a verb that shipped later has no "
            f"measured drift verdict to be classified under: {strays!r}")

    def test_the_four_post_054_sets_never_collapse_into_one_another(self):
        """The renumbering that each of the three earlier sections deferred is
        not what this CR does: it adds a fourth set and a derived check. Two
        sets sharing a name would mean one had absorbed the other."""
        for sets in (POST_CR054_VERB_FUNCTION_SETS, POST_CR054_VERB_NAME_SETS):
            for i, (label_a, set_a) in enumerate(sets):
                for label_b, set_b in sets[i + 1:]:
                    with self.subTest(pair=f"{label_a} vs {label_b}"):
                        overlap = set_a & set_b
                        self.assertEqual(
                            overlap, frozenset(),
                            f"{label_a} and {label_b} must stay distinct "
                            f"frozen sets; overlap: {overlap!r}")


# ---------------------------------------------------------------------------
# CR-CRU-075 SS2/AC4 -- THE DERIVED GUARDRAIL: a shared registrar's verbs
# reach every client, with no frozen set to update.
#
# The four sections above are per-verb EVIDENCE, and each one exists because
# somebody wrote it. That is the hole: the verb nobody freezes is the verb
# nobody checks, and it stays uneven for as long as it takes the next reader
# to notice. So the rule below holds NO list of verbs and no count in any
# identifier. It reads `clients/_crucible_axi.py`, takes every top-level
# function that BUILDS subparsers as a shared registrar, takes the verb names
# each one registers, and requires all five clients to wire every one of them.
# A registrar added tomorrow is enforced the day it lands.
#
# Read from the AST, following `_add_parser_verb_names`' precedent: a
# registrar or a verb named in a docstring, a comment or a help string is
# prose, and prose registers nothing.
# ---------------------------------------------------------------------------

# TODAY's registrars, as the NON-VACUITY floor for the derived check -- never
# as its input. The check discovers its own registrars; this mapping only
# proves the discovery is not returning an empty dict, which would make the
# rule pass by finding nothing. Each entry reuses the frozen set its own
# section already asserts, so this is a cross-check between two derivations of
# the same fact rather than a fifth hand-written list.
CR075_REGISTRARS_TODAY = {
    "add_roadmap_verbs": frozenset(CR091_ROADMAP_VERBS),
    "add_next_verb": frozenset(CR092_NEXT_VERBS),
    "add_cr_depends_verb": frozenset(CR106_DEPENDS_VERBS),
    "add_queue_file_verb": frozenset(CR075_QUEUE_FILE_VERBS),
}


def _shared_registrar_verb_sets(axi_path):
    """`{registrar name: frozenset(verb names it registers)}` for every
    top-level function in the shared module that BUILDS subparsers.

    A shared registrar is defined by what it does, not by what it is called:
    any top-level function spelling `<something>.add_parser(\"<verb>\")` is
    one. Read from the AST for the same reason `_add_parser_verb_names` is --
    a name inside a docstring or a help string is prose, and this rule must
    not be satisfiable, or breakable, by wording."""
    registrars = {}
    for node in ast.parse(axi_path.read_text(), filename=str(axi_path)).body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        verbs = set()
        for inner in ast.walk(node):
            if not (isinstance(inner, ast.Call)
                    and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr == "add_parser"):
                continue
            if inner.args and isinstance(inner.args[0], ast.Constant) \
                    and isinstance(inner.args[0].value, str):
                verbs.add(inner.args[0].value)
        if verbs:
            registrars[node.name] = frozenset(verbs)
    return registrars


def _client_registrar_calls(client_path):
    """`{registrar name: set(verb names this client hands it)}` for every
    shared registrar a client calls. An empty set means the client called the
    registrar WITHOUT a verb-name dict -- the one-verb seam
    (`add_next_verb(sub, cmd_next)`), which wires that registrar's whole verb
    set. A dict-taking registrar (`add_roadmap_verbs`) is the case where a
    client can keep the call and still drop a verb, so its own keys are what
    it wired.

    Only a registration that can RUN counts, which is the whole difference
    between wiring a verb and writing one down. The scan reads registrar calls
    that are a STATEMENT at module level, or a statement of the module-level
    `main()`'s own body -- the shape every registrar call on the fleet has
    today: twenty of them, four registrars x five clients, each a bare call
    statement directly in that client's `main()`. A registration parked in a
    function nothing calls, or under a test that is never true, parses exactly
    like a real one and registers nothing; a reader that walked every
    `ast.Call` in the file would count it and report full parity for a client
    whose verb argparse has never heard of."""
    tree = ast.parse(client_path.read_text())
    reachable = list(tree.body)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                and node.name == "main":
            reachable.extend(node.body)
    calls = {}
    for statement in reachable:
        if not (isinstance(statement, ast.Expr)
                and isinstance(statement.value, ast.Call)):
            continue
        node = statement.value
        name = _called_registrar_name(node)
        if name is None or not name.startswith("add_"):
            continue
        keys = calls.setdefault(name, set())
        for arg in list(node.args) + [kw.value for kw in node.keywords]:
            if not isinstance(arg, ast.Dict):
                continue
            keys |= {k.value for k in arg.keys
                     if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    return calls


def _registrar_parity_offenders(axi_path, client_paths):
    """AC4's rule, as a pure function of (shared module, clients):
    `{client: {registrar: [verb names it does not wire]}}`, empty when every
    verb every shared registrar registers reaches every client.

    The constraint that follows, stated because it is otherwise only implied:
    PLACING A REGISTRAR IN THE SHARED MODULE IS WHAT MAKES A VERB FLEET-WIDE.
    `clients/_crucible_axi.py` is the fleet locus, so anything registered from
    there is owed by all five clients, and a registrar added there for a verb
    only one stack wants would be reported against the four that legitimately
    do not want it. That is the rule working, not failing: a client-specific
    verb keeps its own `add_parser` in its own client, and never acquires a
    shared registrar."""
    registrars = _shared_registrar_verb_sets(axi_path)
    offenders = {}
    for client, path in client_paths.items():
        calls = _client_registrar_calls(path)
        unwired = {}
        for registrar, verbs in registrars.items():
            if registrar not in calls:
                unwired[registrar] = sorted(verbs)
                continue
            handed = calls[registrar]
            missing = sorted(verbs - handed) if handed else []
            if missing:
                unwired[registrar] = missing
        if unwired:
            offenders[client] = unwired
    return offenders


# A registrar and a verb this CR never names, appended ONLY to a scratch
# tmpdir copy of the shared module. It is the whole point of AC4: the check
# must catch TOMORROW's verb, and the only way to show that is to introduce
# one the rule has never been told about.
_SCRATCH_REGISTRAR_SOURCE = '''

def add_widget_sync_verb(sub, func, *, parents=(), add_args=()):
    """A registrar that exists only inside a scratch tmpdir copy of this
    module, for the derived check's unnamed-verb proof."""
    wp = sub.add_parser("widget-sync", parents=list(parents),
                        help="scratch-only verb; never on the real fleet.")
    for adder in add_args:
        adder(wp)
    wp.set_defaults(func=func)
'''

# The wiring four of the five scratch clients get. The delegator name resolves
# to nothing in the copy, which does not matter and is worth saying: these
# copies are PARSED, never imported, so the check sees exactly what it would
# see in a real client that had wired the verb.
_SCRATCH_REGISTRAR_CALL = "_axi().add_widget_sync_verb(sub, cmd_widget_sync)"

# A registrar name and a verb name that appear in the scratch module as PROSE
# only -- a docstring naming a registrar, and a help string that quotes an
# `add_parser` call. Neither registers anything, and a grep-based reader would
# report both.
_SCRATCH_PROSE_SOURCE = '''

def add_prose_only_verb(sub, func):
    """Named like a registrar, registers nothing. A reader that counted this
    would be counting `add_parser("prose-only-verb")` inside a docstring."""
    return 'sub.add_parser("prose-only-verb")', func
'''


class Cr075SharedRegistrarParityTest(unittest.TestCase):
    """AC4 -- every verb name a shared registrar registers is wired in all
    five clients, with the registrar set READ from the shared module."""

    def test_the_registrar_set_is_discovered_from_the_module_and_is_not_empty(self):
        """NON-VACUITY, and it is the load-bearing test of this class: a
        discovery that found zero registrars would make the parity rule below
        pass while checking nothing at all. So the discovery is pinned against
        the four registrars that exist and the eight verbs they register --
        each verb set taken from the frozen set its own section asserts, so
        the two derivations must agree."""
        discovered = _shared_registrar_verb_sets(AXI_MODULE_PATH)
        self.assertNotEqual(
            discovered, {},
            "the derived check found NO shared registrar in the shared "
            "module -- the parity rule below would then be vacuously true")
        for registrar, verbs in CR075_REGISTRARS_TODAY.items():
            with self.subTest(registrar=registrar):
                self.assertEqual(
                    discovered.get(registrar), verbs,
                    f"{registrar} must be discovered registering exactly its "
                    f"own verbs; discovery says "
                    f"{discovered.get(registrar)!r}")
        known = set().union(*CR075_REGISTRARS_TODAY.values())
        found = set().union(*discovered.values())
        self.assertEqual(
            known - found, set(),
            f"every verb the four registrars register must be discovered; "
            f"discovery missed: {sorted(known - found)!r}")
        self.assertGreaterEqual(
            len(found), 8,
            f"the four registrars register eight verbs between them; "
            f"discovery found {len(found)}: {sorted(found)!r}")

    def test_a_registrar_and_a_verb_named_only_in_prose_are_not_discovered(self):
        """The AST half of the rule, proven rather than asserted about
        itself: a function whose only `add_parser` is inside a docstring and a
        returned string registers nothing, and must not enter the registrar
        set -- otherwise every client would owe a wiring for a verb that does
        not exist."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, _clients = _scratch_fleet(tmp)
            axi_copy.write_text(axi_copy.read_text() + _SCRATCH_PROSE_SOURCE)
            discovered = _shared_registrar_verb_sets(axi_copy)
        self.assertNotIn(
            "add_prose_only_verb", discovered,
            "a function that only NAMES add_parser in prose is not a "
            "registrar; discovery must read the call, not the text")
        self.assertNotIn(
            "prose-only-verb", set().union(*discovered.values()),
            "a verb name quoted inside a docstring or a returned string is "
            "not a registered verb")

    def test_every_verb_a_shared_registrar_registers_is_wired_in_all_five_clients(self):
        """THE RULE. No list, no count: whatever the shared module registers
        today is what all five clients owe today."""
        offenders = _registrar_parity_offenders(AXI_MODULE_PATH, CLIENT_FILES)
        self.assertEqual(
            offenders, {},
            f"every verb a shared registrar in `clients/_crucible_axi.py` "
            f"registers must be wired in ALL FIVE clients -- one verb wired "
            f"on one stack and absent on four is the defect this rule "
            f"exists to make impossible: {offenders!r}")

    def test_the_rule_names_the_client_and_the_verb_when_a_registration_is_dropped(self):
        """AC4 is explicit that this is \"proven by injection, not by
        construction\": the rule above is worth nothing unless it FIRES, and a
        failure that does not name both the client and the verb leaves the
        reader to diff five files."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _drop_registrar_call(clients["rust"], "add_queue_file_verb"),
                "the injection found no registrar call to drop")
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertEqual(
            offenders, {"rust": {"add_queue_file_verb": ["queue-file"]}},
            f"dropping ONE client's registration must fail the rule, name "
            f"that client, name that verb, and leave the other four clean: "
            f"{offenders!r}")

    def test_the_rule_fires_when_a_client_keeps_the_call_but_drops_one_verb(self):
        """The subtler shape, and the reason the reader looks at the dict keys
        rather than at the presence of the call: a client that still calls the
        multi-verb registrar, with one verb missing from the mapping it hands
        over, has an unregistered verb and an untouched call site."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _drop_registrar_dict_entry(clients["bun"], "cr-void"),
                "the injection found no registrar dict entry to drop")
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertEqual(
            offenders, {"bun": {"add_roadmap_verbs": ["cr-void"]}},
            f"a client that keeps the registrar call and drops one verb from "
            f"the mapping must still be named, with the verb it dropped: "
            f"{offenders!r}")

    def test_a_registration_in_a_function_nothing_calls_is_reported_unwired(self):
        """REACHABILITY, half one. A registrar call moved out of `main()` into
        a module-level function nothing calls still reads, greps and parses
        like a wiring, and registers nothing: that client's verb is argparse's
        `invalid choice`. The rule must count what can run, not what is
        written, so this client is named exactly as a client that never wired
        the verb at all."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _bury_registrar_call_in_dead_code(
                    clients["mvn"], "add_queue_file_verb",
                    shape="dead function"),
                "the injection found no registrar call to bury")
            buried = clients["mvn"].read_text()
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertIn(
            "add_queue_file_verb", buried,
            "the injection must leave the CALL in the file -- only its "
            "reachability may change, or this proves nothing")
        self.assertEqual(
            offenders, {"mvn": {"add_queue_file_verb": ["queue-file"]}},
            f"a registration parked in a function nothing calls registers "
            f"nothing, and must be reported as unwired against that client "
            f"and that verb: {offenders!r}")

    def test_a_registration_under_a_test_that_is_never_true_is_reported_unwired(self):
        """REACHABILITY, half two, and the cheaper way to fool a text-shaped
        reader: the call stays exactly where it belongs, inside `main()`,
        under `if False:`. Nothing about the call changed; it simply cannot
        execute, so the verb is not registered and the client owes it."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _bury_registrar_call_in_dead_code(
                    clients["python"], "add_queue_file_verb",
                    shape="if False"),
                "the injection found no registrar call to guard")
            guarded = clients["python"].read_text()
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertIn(
            "if False:", guarded,
            "the injection must actually have guarded the call")
        self.assertIn(
            "add_queue_file_verb", guarded,
            "the injection must leave the CALL in the file -- only its "
            "reachability may change, or this proves nothing")
        self.assertEqual(
            offenders, {"python": {"add_queue_file_verb": ["queue-file"]}},
            f"a registration under a test that is never true registers "
            f"nothing, and must be reported as unwired against that client "
            f"and that verb: {offenders!r}")

    def test_a_registration_at_module_level_is_wiring_and_is_not_reported(self):
        """The other side of the same rule, pinned so it cannot quietly
        narrow to `main()`-only: a module body RUNS. A client that registers
        the verb from a module-level statement has wired it, and reporting it
        would be a false positive -- the two tests above must be catching
        unreachability, not the absence of `main()`."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            self.assertTrue(
                _hoist_registrar_call_to_module_level(
                    clients["arduino"], "add_queue_file_verb"),
                "the injection found no registrar call to hoist")
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertEqual(
            offenders, {},
            f"a registrar call at module level can run, so it wires the "
            f"verb and no client may be reported: {offenders!r}")

    def test_a_registrar_this_cr_never_names_is_enforced_the_day_it_lands(self):
        """The whole point of deriving the rule instead of freezing a fifth
        set. A registrar and a verb that appear NOWHERE in this file, in any
        CR, or in the fleet are injected into a scratch shared module and
        wired into four of the five scratch clients; the rule must discover
        the verb by itself and name the fifth client."""
        with tempfile.TemporaryDirectory(prefix="cr075-scratch-") as tmp:
            axi_copy, clients = _scratch_fleet(tmp)
            axi_copy.write_text(axi_copy.read_text() + _SCRATCH_REGISTRAR_SOURCE)
            discovered = _shared_registrar_verb_sets(axi_copy)
            self.assertEqual(
                discovered.get("add_widget_sync_verb"),
                frozenset({"widget-sync"}),
                "the injected registrar must be discovered from the module, "
                "which is what makes the rule need no list of verbs")
            for client in ("bun", "rust", "mvn", "python"):
                self.assertTrue(
                    _wire_call_after(clients[client], "add_queue_file_verb",
                                     _SCRATCH_REGISTRAR_CALL),
                    f"the injection failed to wire {client}")
            offenders = _registrar_parity_offenders(axi_copy, clients)
        self.assertEqual(
            offenders, {"arduino": {"add_widget_sync_verb": ["widget-sync"]}},
            f"a verb no frozen set has ever heard of must be enforced on all "
            f"five clients the day its registrar lands, and the one client "
            f"that missed it must be named: {offenders!r}")


# ---------------------------------------------------------------------------
# CR-CRU-108 §S2/AC4 -- the fleet's own copy of the track rule is DELETED.
#
# The retired construct is a distinct-SET COMPUTATION over the entries'
# `track` values -- `sorted({e.get("track") for e in entries ...})` -- and the
# sweep is repo-wide over `clients/`, not one file, because `queue_tracks` is
# the shared delegator all five `*-crucible.py` clients reach: one cutover
# covers the fleet, and a client that grew a private copy would defeat it.
#
# The rule is AST-shaped rather than a text grep, and it keys on what a
# construct COLLECTS, for one reason that matters: `resolve_next`'s lane
# FILTER (`[e for e in entries if canonical_track(e.get("track")) == wanted]`)
# reads the same key and must SURVIVE §S2. A text grep for `e.get("track")`
# would demand deleting it; this reads what the construct collects, so it
# bans deriving the track LIST and leaves selecting a lane alone. Both halves
# are proven on synthetic sources below rather than asserted.
#
# THE SWEEP IS OVER THE RULE, NOT OVER ONE SYNTAX. AC4's sentence is that the
# re-derivation survives NOWHERE. A sweep that walked comprehensions only
# would be satisfied by the same rule spelled as a `for` loop with `set.add`
# or `list.append`, as `set(map(...))`, as a `filter` over a generator, or
# tucked inside a private helper -- five ways to put back exactly what §S2
# deleted with this file still green. Each of those shapes is swept, and each
# is driven through the sweep below as its own synthetic source, beside the
# lane-selecting shapes that must come back clean.
#
# WHERE THE COLLECT/TEST LINE IS DRAWN: the walk PRUNES at the positions that
# merely TEST the key -- a comprehension's `if` clauses, a `filter`
# predicate, a `sorted(key=...)` -- because those are the lane filter's own
# spellings. `filter(pred, entries)` collects ENTRIES; `filter(None, tracks)`
# collects tracks. One rule, read off the position rather than the name.
# ---------------------------------------------------------------------------

_CR108_RETIRED_TRACK_RULE = (
    'sorted({e.get("track") for e in entries or [] if e.get("track")})')

_CR108_SURVIVING_LANE_FILTER = (
    '[e for e in entries if canonical_track(e.get("track")) == wanted]')

# The retirement written every other way it could come back. Each source is a
# WHOLE module the sweep parses, so "hidden in a private helper" is a real
# case rather than an assertion about one: the walk is over the tree, and a
# shape that only reads as a re-derivation at module level would be missed.
_CR108_RETIRED_SHAPES = {
    "set-comprehension": (
        f"def queue_tracks(entries):\n"
        f"    return {_CR108_RETIRED_TRACK_RULE}\n"),
    "for-loop-with-set-add": (
        'def queue_tracks(entries):\n'
        '    lanes = set()\n'
        '    for e in entries or []:\n'
        '        if e.get("track"):\n'
        '            lanes.add(e.get("track"))\n'
        '    return sorted(lanes)\n'),
    "for-loop-with-list-append": (
        'def queue_tracks(entries):\n'
        '    lanes = []\n'
        '    for e in entries or []:\n'
        '        lanes.append(e["track"])\n'
        '    return sorted(set(lanes))\n'),
    "set-of-map": (
        'def queue_tracks(entries):\n'
        '    return sorted(set(map(lambda e: e.get("track"), entries or [])))'
        '\n'),
    "filter-over-a-generator": (
        'def queue_tracks(entries):\n'
        '    return sorted(set(filter(None,\n'
        '                             (e.get("track") for e in entries or []))'
        '))\n'),
    "private-helper": (
        'def _lanes(entries):\n'
        '    return {e["track"] for e in entries or [] if e["track"]}\n'
        '\n'
        'def queue_tracks(queue):\n'
        '    return sorted(_lanes(queue.get("entries")))\n'),
}

# The shapes that read the same key and MUST come back clean. Without these
# the widening above could be a text grep wearing an AST costume: every one of
# them SELECTS or ORDERS entries, and none of them derives the track list.
_CR108_SURVIVING_SHAPES = {
    "comprehension-lane-filter": (
        f"def resolve_next(entries, wanted):\n"
        f"    return {_CR108_SURVIVING_LANE_FILTER}\n"),
    "functional-lane-filter": (
        'def resolve_next(entries, wanted):\n'
        '    return list(filter(\n'
        '        lambda e: canonical_track(e.get("track")) == wanted,\n'
        '        entries))\n'),
    "for-loop-lane-filter": (
        'def resolve_next(entries, wanted):\n'
        '    lane = []\n'
        '    for e in entries or []:\n'
        '        if canonical_track(e.get("track")) == wanted:\n'
        '            lane.append(e)\n'
        '    return lane\n'),
    "sorted-keyed-on-the-track": (
        'def ordered(entries):\n'
        '    return sorted(entries, key=lambda e: e.get("track") or "")\n'),
    "single-entry-field-copy": (
        'def _next_fields(entry):\n'
        '    fields = {}\n'
        '    if entry.get("track"):\n'
        '        fields["track"] = entry["track"]\n'
        '    return fields\n'),
}


def _reads_track_key(node):
    """True iff `node` reads an entry's `track` key, either spelling."""
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get" and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "track"):
        return True
    return (isinstance(node, ast.Subscript)
            and isinstance(node.slice, ast.Constant)
            and node.slice.value == "track")


_COLLECTING_CALLS = ("set", "frozenset", "sorted", "map", "filter")


def _collects_track_values(node):
    """True iff evaluating `node` COLLECTS entries' `track` values.

    A walk that PRUNES at every position where the key is merely TESTED -- a
    comprehension's `if` clauses, a `filter` predicate, a call's keyword
    arguments (`sorted(key=...)`) -- because those are how the lane filter
    reads the same key, and it must survive."""
    if _reads_track_key(node):
        return True
    if isinstance(node, ast.Lambda):
        return _collects_track_values(node.body)
    if isinstance(node, (ast.SetComp, ast.ListComp, ast.GeneratorExp)):
        return _collects_track_values(node.elt)
    if isinstance(node, ast.DictComp):
        return (_collects_track_values(node.key)
                or _collects_track_values(node.value))
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id == "filter":
            # `filter(pred, xs)` yields whatever `xs` yields; the predicate is
            # a test, and testing the key is the lane filter's own shape.
            return (len(node.args) > 1
                    and _collects_track_values(node.args[1]))
        return any(_collects_track_values(arg) for arg in node.args)
    return any(_collects_track_values(child)
               for child in ast.iter_child_nodes(node))


def _accumulated_track_values(node):
    """The expressions a `for` loop ACCUMULATES -- every argument of an
    `.add(...)`/`.append(...)` call in its body. The imperative spelling of a
    comprehension, and the one a comprehension-only sweep would miss."""
    if not isinstance(node, (ast.For, ast.AsyncFor)):
        return []
    accumulated = []
    for sub in ast.walk(node):
        if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)
                and sub.func.attr in ("add", "append")):
            accumulated.extend(sub.args)
    return accumulated


def _track_set_computations(source, filename="<scratch>"):
    """Every construct in `source` that COLLECTS `track` values -- the
    distinct-set computation AC4 retires, in any of its spellings -- as its
    unparsed text. A construct that merely TESTS the key (the lane filter)
    collects the entry itself and is not matched.

    A match nested inside another match is dropped: `sorted({...})` is ONE
    re-derivation reported once, not the wrapper and its argument twice."""
    matched = []
    for node in ast.walk(ast.parse(source, filename=filename)):
        if isinstance(node, (ast.SetComp, ast.ListComp, ast.GeneratorExp,
                             ast.DictComp)):
            hit = _collects_track_values(node)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
              and node.func.id in _COLLECTING_CALLS):
            hit = _collects_track_values(node)
        else:
            hit = any(_collects_track_values(part)
                      for part in _accumulated_track_values(node))
        if hit:
            matched.append(node)
    nested = {id(sub) for node in matched for sub in ast.walk(node)
              if sub is not node}
    return [ast.unparse(node) for node in matched if id(node) not in nested]


class Cr108TrackRuleIsNotRederivedByTheFleetTest(unittest.TestCase):
    """AC4 -- `queue_tracks` contains no distinct-set computation: it reads the
    published `tracks`. The BEHAVIOURAL half (a payload whose entries and whose
    published list disagree) lives in
    `tests/client/test_cr092_next_decision_resolver.py`; this is the sweep that
    proves the deletion reached the whole fleet rather than one function."""

    def test_the_sweep_finds_the_retired_computation_in_every_shape(self):
        """Non-vacuity, half one, over the RULE rather than one syntax: after
        §S2 lands, a detector blind to any of these shapes would make the fleet
        verdict below pass for the wrong reason, and the shape it was blind to
        is the shape the re-derivation comes back as."""
        for shape, source in sorted(_CR108_RETIRED_SHAPES.items()):
            with self.subTest(shape=shape):
                found = _track_set_computations(source)
                self.assertEqual(
                    len(found), 1,
                    f"the sweep must report this re-derivation exactly ONCE "
                    f"-- a wrapper and its argument are one construct, not "
                    f"two; got {found!r}")

    def test_the_sweep_leaves_lane_selection_alone_in_every_shape(self):
        """Non-vacuity, half two -- and the reason this is AST-shaped. Every
        source here reads the `track` key and MUST survive §S2: three spell the
        lane filter `--track` needs, one orders entries BY the key, and one is
        the single-entry field copy `_next_fields` still makes. A sweep that
        flagged any of them would demand deleting working code, which is how a
        widened guard turns into a text grep."""
        for shape, source in sorted(_CR108_SURVIVING_SHAPES.items()):
            with self.subTest(shape=shape):
                found = _track_set_computations(source)
                self.assertEqual(
                    found, [],
                    f"reading the key is not deriving the track list: "
                    f"{found!r}")

    def test_no_file_in_clients_derives_the_track_list_itself(self):
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*.py")):
            found = _track_set_computations(
                path.read_text(encoding="utf-8"), filename=str(path))
            if found:
                offenders[path.name] = found
        self.assertEqual(
            offenders, {},
            f"AC4 -- the distinct-set computation over the entries' `track` "
            f"values must survive NOWHERE under clients/: the queue read "
            f"publishes that list and the fleet reads it. A second copy is "
            f"the divergence this CR removes -- measured 2026-09-07, the "
            f"client rule answered FOUR tracks where the server's answered "
            f"TWO. Still derived in: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
