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
            f"SS3's 'gap not to repeat' -- `queue-file` reaches python "
            f"only, so all five roadmap verbs reach all five clients; "
            f"missing from: {missing!r}")

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


if __name__ == "__main__":
    unittest.main()
