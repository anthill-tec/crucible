"""CR-CRU-030 C1 — §S1 shared envelope module `clients/_crucible_axi.py`.

Contract pinned VERBATIM from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md §S1:
    "Factor the envelope builder into a NEW shared module
    `clients/_crucible_axi.py` (the five clients do NOT currently share code
    -- each standalone client duplicates its own lifecycle/.env/context
    helpers; `_emit_axi`/`_axi_context` exist only in `bun-crucible.py`).
    This CR introduces the shared module and all five clients import it, so
    all five emit an identical envelope."
And the envelope schema itself:
    axi:
      verb: <name>
      ok: <bool>
      <verb-specific result fields>
      context: { projectKey, agentId?, cycleId?, wave, cr, track?, orchestrator? }
      warnings[]{code,detail}

RED phase: `clients/_crucible_axi.py` does not exist yet (confirmed by `ls
clients/`). Every test below that loads it fails via FileNotFoundError raised
by `exec_module()` -- a missing-SUT-module error, valid RED (same convention
as the since-retired `test_toon.py` -- retired by CR-CRU-046 C2 (`987b331`),
successor `test_cr046_official_toon_roundtrip.py` -- which deliberately did NOT
skip a missing module: the raise itself is the RED signal). `bun-crucible.py`
also does not
yet reference `_crucible_axi` anywhere (confirmed by reading the source --
`_emit_axi`/`_axi_context` are still standalone local functions at
~L1099/~L1079), so the wiring tests below fail too, and will keep failing
until bun-crucible.py's `_axi_context` is made to DELEGATE to (produce
identical output to) the shared module's `axi_context`, and its `_emit_axi`
similarly delegates to `emit_axi`.

This RED slice pins the exact shared-module API GREEN must build:
    AXI_UNSET                                    sentinel object
    emit_axi(verb, ok, result_fields, context,
             warnings, legacy_line=None)          -> None (writes stdout/stderr)
    axi_context(project_key, agent_id=None,
                cr=None, cycle_id=AXI_UNSET)      -> dict (the §S1 context)
    resolve_active_cycle_id(plans)                -> int | None (pure; `plans`
                                                      is the `plans` list from
                                                      a GET .../plans response)
`axi_context` takes an already-resolved `project_key` STRING (not a
project_dir) -- `.env`/project-dir resolution stays client-specific (out of
this CR's §S1 scope, which only extracts the envelope + context builders),
so the shared module cannot own filesystem resolution. This is why the
bun-wiring test below checks OUTPUT EQUALITY (bun's `_axi_context(project_dir,
...)` resolving the same project_key must yield an IDENTICAL dict to
`axi_context(project_key, ...)`), not object identity, while `emit_axi` (whose
signature needs no such adaptation) is checked for byte-identical STDOUT
output directly.

Invocation:
    python3 -m pytest tests/client/test_crucible_axi_shared.py -q
Fallback:
    python3 tests/client/test_crucible_axi_shared.py
"""

import contextlib
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
BUN_SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"


def _load_axi_module():
    """Load clients/_crucible_axi.py by file path. Deliberately does NOT skip
    when the file is missing -- a FileNotFoundError from exec_module() during
    RED is the expected failure (same convention as the retired test_toon.py,
    successor `test_cr046_official_toon_roundtrip.py`)."""
    spec = importlib.util.spec_from_file_location(
        "crucible_axi_under_test", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_bun_crucible_module():
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_axi_shared", BUN_SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_toon_module():
    spec = importlib.util.spec_from_file_location(
        "toon_under_test_for_axi_shared", TOON_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SharedAxiEmitEnvelopeTest(unittest.TestCase):
    """`emit_axi` must write a §S1-schema TOON envelope on stdout and route
    the legacy human-readable line to stderr only."""

    def test_emit_axi_prints_toon_decodable_envelope_with_verb_ok_and_result_fields(self):
        axi_mod = _load_axi_module()
        toon = _load_toon_module()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi(
                "register", True, {"agent": "CR-X-1"},
                {"projectKey": "proj-k", "agentId": "CR-X-1"}, [],
            )
        decoded = toon.decode(stdout.getvalue())
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got stdout={stdout.getvalue()!r}")
        axi = decoded["axi"]
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("agent"), "CR-X-1")
        context = axi.get("context")
        self.assertEqual(context.get("projectKey"), "proj-k")
        self.assertEqual(context.get("agentId"), "CR-X-1")
        self.assertEqual(axi.get("warnings"), [])

    def test_emit_axi_ok_false_envelope_reflects_the_supplied_ok_value(self):
        axi_mod = _load_axi_module()
        toon = _load_toon_module()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("plan-file", False, {"cr": "CR-BAD"},
                              {"projectKey": "proj-k"}, [])
        decoded = toon.decode(stdout.getvalue())
        axi = decoded["axi"]
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), False)

    def test_emit_axi_writes_legacy_line_to_stderr_not_stdout(self):
        axi_mod = _load_axi_module()
        stdout, stderr = io.StringIO(), io.StringIO()
        legacy = "unregister: ok=True agent=CR-X-2"
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            axi_mod.emit_axi("unregister", True, {"agent": "CR-X-2"},
                              {"projectKey": "proj-k"}, [], legacy_line=legacy)
        self.assertIn(legacy, stderr.getvalue())
        self.assertNotIn(legacy, stdout.getvalue())

    def test_emit_axi_carries_warnings_array_verbatim_into_the_envelope(self):
        axi_mod = _load_axi_module()
        toon = _load_toon_module()
        warnings = [{"code": "no-wave", "detail": "WORKFLOW_WAVE unset for CR-Q"}]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("plan-file", True, {"cr": "CR-Q"},
                              {"projectKey": "proj-k"}, warnings)
        decoded = toon.decode(stdout.getvalue())
        axi = decoded["axi"]
        self.assertEqual(axi.get("warnings"), warnings)


class SharedAxiContextTest(unittest.TestCase):
    """`axi_context` builds the §S1 `context` dict from an explicit
    project_key + optional agent_id/cr/cycle_id, and env (WORKFLOW_WAVE,
    WORKFLOW_ROLE) -- absent keys OMITTED, an explicit `cycle_id=None` kept
    as an EXPLICIT null (never silently dropped, per §S3)."""

    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE")

    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_axi_context_always_includes_project_key(self):
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context("proj-k")
        self.assertEqual(ctx.get("projectKey"), "proj-k")

    def test_axi_context_omits_cycle_id_key_when_left_at_default_sentinel(self):
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context("proj-k")
        self.assertNotIn("cycleId", ctx)

    def test_axi_context_emits_explicit_null_cycle_id_when_supplied_as_none(self):
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context("proj-k", agent_id="A1", cr="CR-Y", cycle_id=None)
        self.assertEqual(ctx.get("projectKey"), "proj-k")
        self.assertEqual(ctx.get("agentId"), "A1")
        self.assertEqual(ctx.get("cr"), "CR-Y")
        self.assertIn("cycleId", ctx,
                       "an unresolved classifying field must be an EXPLICIT "
                       "null key, never silently dropped (§S3)")
        self.assertIsNone(ctx.get("cycleId"))

    def test_axi_context_carries_a_concrete_cycle_id_when_supplied(self):
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context("proj-k", cycle_id=909)
        self.assertEqual(ctx.get("cycleId"), 909)

    def test_axi_context_includes_wave_and_track_from_env(self):
        axi_mod = _load_axi_module()
        os.environ["WORKFLOW_WAVE"] = "4"
        os.environ["WORKFLOW_ROLE"] = "Track 2"
        ctx = axi_mod.axi_context("proj-k")
        self.assertEqual(str(ctx.get("wave")), "4")
        self.assertEqual(ctx.get("track"), "Track 2")

    def test_axi_context_omits_wave_and_track_when_env_unset(self):
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context("proj-k")
        self.assertNotIn("wave", ctx)
        self.assertNotIn("track", ctx)


class SharedAxiCycleResolverRetiredTest(unittest.TestCase):
    """CR-CRU-056 §S3/§S3c — the §S9-era client-side attach resolver
    (`resolve_attach_cycle`/`resolve_active_cycle_id`, PURE functions the
    shared module used to export) is DELETED wholesale: the server has never
    resolved a cycle for a caller and the client stops guessing too.
    Attachment is now the AGENT ROW's job (§S1 register --cycle binding,
    server-stamped at ingest). This class supersedes
    SharedAxiResolveActiveCycleTest -- the pins there exercised a function
    that no longer exists, so they are retired (not adapted) in favour of a
    grep-sweep proving the retirement is total across the fleet, per the CR
    AC: "resolve_attach_cycle and resolve_active_cycle_id are gone from
    clients/ (grep-sweep-asserted)"."""

    BANNED_NAMES = ("resolve_attach_cycle", "resolve_active_cycle_id")

    def test_shared_axi_module_no_longer_exports_the_active_cycle_resolver(self):
        axi_mod = _load_axi_module()
        for banned in self.BANNED_NAMES:
            self.assertFalse(
                hasattr(axi_mod, banned),
                f"clients/_crucible_axi.py must no longer export {banned} -- "
                f"CR-CRU-056 §S3 deletes the client-side attach resolver")

    def test_no_python_client_file_calls_the_retired_resolver_names(self):
        """Grep-sweep across every `clients/*.py` file (not just the shared
        module) -- the AC requires the retirement to be total across the
        fleet, since each of the five clients used to call these functions
        at two sites apiece (§S3c). Scoped to actual CODE references (a
        call, or dotted access) on non-comment lines -- a `# CR-CRU-056 ...`
        explanatory comment naming the retired functions for historical
        context is documentation, not a live reference, and stays legal."""
        clients_dir = REPO_ROOT / "clients"
        offenders = []
        for py_file in sorted(clients_dir.glob("*.py")):
            for lineno, line in enumerate(py_file.read_text().splitlines(), start=1):
                code_part = line.split("#", 1)[0]
                for banned in self.BANNED_NAMES:
                    if banned + "(" in code_part or "." + banned in code_part:
                        offenders.append(f"{py_file.name}:{lineno}: {banned}")
        self.assertEqual(
            offenders, [],
            f"no file under clients/ may CALL the retired client-side attach "
            f"resolver any more; found {offenders!r}")


class SharedAxiEchoedCycleIdTest(unittest.TestCase):
    """CR-CRU-056 C5 (VERIFY fix round) -- `echoed_cycle_id` reads the cycle
    the SERVER reports it attached an ingest to, out of the ingest response's
    `context.cycleId` echo, so the client envelope can surface where the run
    landed without a second `GET /api/v2/events`.

    It is a PURE READ of the server's answer -- NOT a revival of the
    client-side attach resolver deleted in §S3 (no plans fetch, no
    active-cycle picking, no env var). Absence maps to `AXI_UNSET` so
    `axi_context` OMITS the key rather than fabricating a null or a guess."""

    def test_returns_the_integer_cycle_id_the_server_echoed(self):
        axi_mod = _load_axi_module()
        self.assertEqual(
            axi_mod.echoed_cycle_id({"ok": True, "context": {"cycleId": 152}}), 152)

    def test_returns_the_unset_sentinel_when_the_response_carries_no_context(self):
        axi_mod = _load_axi_module()
        self.assertIs(axi_mod.echoed_cycle_id({"ok": True}), axi_mod.AXI_UNSET)

    def test_returns_the_unset_sentinel_when_the_context_carries_no_cycle_id(self):
        axi_mod = _load_axi_module()
        self.assertIs(
            axi_mod.echoed_cycle_id({"ok": True, "context": {"projectKey": "k"}}),
            axi_mod.AXI_UNSET)

    def test_returns_the_unset_sentinel_for_a_non_integer_or_null_cycle_id(self):
        axi_mod = _load_axi_module()
        for bogus in (None, "152", 1.5, True, {"id": 152}):
            self.assertIs(
                axi_mod.echoed_cycle_id({"ok": True, "context": {"cycleId": bogus}}),
                axi_mod.AXI_UNSET,
                f"a non-integer cycleId echo ({bogus!r}) must never be surfaced "
                f"as a cycle id")

    def test_tolerates_a_malformed_or_missing_response_without_raising(self):
        axi_mod = _load_axi_module()
        for bogus in (None, "boom", [], {"context": "not-a-dict"}):
            self.assertIs(axi_mod.echoed_cycle_id(bogus), axi_mod.AXI_UNSET)

    def test_feeds_axi_context_so_the_envelope_carries_the_server_reported_cycle(self):
        """End of the wire: the helper's output drops straight into
        `axi_context(cycle_id=...)` -- present -> the key appears with the
        server's id; absent -> the key is omitted entirely."""
        axi_mod = _load_axi_module()
        ctx = axi_mod.axi_context(
            "proj-k", agent_id="A1",
            cycle_id=axi_mod.echoed_cycle_id({"ok": True, "context": {"cycleId": 152}}))
        self.assertEqual(ctx.get("cycleId"), 152)
        bare = axi_mod.axi_context(
            "proj-k", agent_id="A1", cycle_id=axi_mod.echoed_cycle_id({"ok": True}))
        self.assertNotIn("cycleId", bare)


class FleetIngestEnvelopeEchoesServerCycleTest(unittest.TestCase):
    """CR-CRU-056 C5 -- the echo is a FLEET property, not a bun-only one: each
    of the five clients' ingest-envelope emitter must feed
    `echoed_cycle_id(resp)` into its `_axi_context(...)` call, so every stack
    prints the cycle the server reported. Grep-sweep in the style of
    `SharedAxiCycleResolverRetiredTest` (the AC pattern for fleet-wide
    uniformity)."""

    CLIENTS = ("bun-crucible.py", "python-crucible.py", "rust-crucible.py",
               "mvn-crucible.py", "arduino-crucible.py")

    def test_every_client_feeds_the_server_echo_into_its_ingest_envelope_context(self):
        missing = []
        for name in self.CLIENTS:
            source = (REPO_ROOT / "clients" / name).read_text()
            if "cycle_id=_axi().echoed_cycle_id(resp)" not in source:
                missing.append(name)
        self.assertEqual(
            missing, [],
            f"every client's ingest envelope must surface the SERVER-reported "
            f"cycle (echoed_cycle_id(resp) -> _axi_context(cycle_id=...)); "
            f"missing in {missing!r}")


class SharedGatedRunIdentityTest(unittest.TestCase):
    """CR-CRU-056 (C5, VERIFY fix round) -- `GatedRunIdentity`, the shared
    ownership half of the gated-run lifecycle bracket.

    CR-CRU-021 §S5's anti-ghost cleanup removes the agent row a GATED RUN
    created. Once §S1 stored the cycle binding ON that row, an UNCONDITIONAL
    cleanup started destroying CALLER-owned registrations: observed live on
    :3849 (2026-08-01), `vidushi` registered bound to cycle 152, a
    `python-crucible.py regression --agent vidushi` ingested stamped 152 and
    then ran its cleanup, and the immediately following `bun-crucible.py
    regression --agent vidushi` landed with NO cycle. These pin the purpose
    preserved / reach corrected split, at the PURE level (no I/O)."""

    def test_open_payload_omits_cycle_id_when_no_cycle_was_supplied(self):
        axi_mod = _load_axi_module()
        payload = axi_mod.GatedRunIdentity("A1").open_payload("proj-k")
        self.assertEqual(payload["agentId"], "A1")
        self.assertEqual(payload["projectKey"], "proj-k")
        # An ABSENT key is what preserves a pre-registered caller's binding
        # (the server's §S1 touch-never-blanks contract). A fabricated
        # null/0 would be a client-side resolution -- deleted in C2.
        self.assertNotIn("cycleId", payload)
        # A gated verb declares no phase; re-declaring one would BLANK the
        # phase a pre-registered caller registered with (CR-CRU-044 §S1(a)).
        self.assertNotIn("phase", payload)

    def test_open_payload_carries_an_explicit_cycle_binding_verbatim(self):
        axi_mod = _load_axi_module()
        payload = axi_mod.GatedRunIdentity("A1", 152).open_payload("proj-k")
        self.assertEqual(payload["cycleId"], 152,
                         "--cycle on a gated verb must ride the opening "
                         "heartbeat verbatim for the SERVER to validate")

    def test_route_is_the_phase_optional_heartbeat_never_register(self):
        axi_mod = _load_axi_module()
        self.assertEqual(axi_mod.GatedRunIdentity("A1").PATH,
                         "/api/v2/agents/heartbeat")

    def test_a_row_that_pre_existed_is_never_claimed_by_the_run(self):
        axi_mod = _load_axi_module()
        identity = axi_mod.GatedRunIdentity("A1")
        identity.observe({"ok": True, "changed": False})
        self.assertFalse(
            identity.should_remove,
            "the bracket must not remove an identity it did not create -- "
            "that is the caller's registration, and its cycle binding")

    def test_a_row_this_run_created_is_claimed_for_cleanup(self):
        axi_mod = _load_axi_module()
        identity = axi_mod.GatedRunIdentity("A1")
        identity.observe({"ok": True, "changed": True})
        self.assertTrue(identity.should_remove,
                        "the CR-CRU-021 §S5 anti-ghost purpose is preserved: "
                        "a run-created row is still torn down")

    def test_ownership_is_sticky_across_later_narration_ticks(self):
        """A run that CREATED the row keeps ownership even though every
        following narration tick reports `changed: false` -- otherwise a
        long run would abandon the ghost it planted."""
        axi_mod = _load_axi_module()
        identity = axi_mod.GatedRunIdentity("A1")
        identity.observe({"ok": True, "changed": True})
        identity.observe({"ok": True, "changed": False})
        identity.observe({"ok": True, "changed": False})
        self.assertTrue(identity.should_remove)

    def test_a_tick_that_re_creates_a_pruned_row_transfers_ownership(self):
        """The inverse: the caller's row existed at open but was PRUNED
        mid-run and a narration tick re-created it -- that new row is this
        run's ghost to remove."""
        axi_mod = _load_axi_module()
        identity = axi_mod.GatedRunIdentity("A1")
        identity.observe({"ok": True, "changed": False})
        self.assertFalse(identity.should_remove)
        identity.observe({"ok": True, "changed": True})
        self.assertTrue(identity.should_remove)

    def test_a_refused_or_unreachable_open_claims_nothing(self):
        """A 409 (invalid binding) or a connection failure carries no
        `changed: true`, so the bracket cleans up nothing it cannot show it
        created -- never a `.get("changed")`-truthy accident."""
        axi_mod = _load_axi_module()
        for resp in ({"ok": False, "error": "HTTP 409: bad binding"},
                     {"ok": False, "error": "connection failed"},
                     {"ok": True},
                     {"ok": True, "changed": "yes"},
                     None):
            identity = axi_mod.GatedRunIdentity("A1")
            identity.observe(resp)
            self.assertFalse(identity.should_remove,
                             f"a response of {resp!r} must not claim ownership")

    def test_observe_returns_its_response_so_it_can_wrap_a_narration_call(self):
        axi_mod = _load_axi_module()
        identity = axi_mod.GatedRunIdentity("A1")
        resp = {"ok": True, "changed": True}
        self.assertIs(identity.observe(resp), resp)

    def test_skipped_cleanup_line_names_the_agent_and_says_why(self):
        """AXI self-explanation: an operator must be able to see the caller's
        registration was deliberately LEFT STANDING, not silently forgotten."""
        axi_mod = _load_axi_module()
        line = axi_mod.gate_identity_skipped_line("vidushi")
        self.assertIn("vidushi", line)
        self.assertIn("cleanup", line.lower())
        self.assertIn("pre-existed", line)

    def test_a_refused_open_is_not_reported_as_a_pre_existing_registration(self):
        """The two no-removal cases must never be reported as each other: a
        REFUSED opening touch means no row was ever created, and claiming the
        identity "pre-existed (registered by its caller)" would be a false
        statement about the board's state."""
        axi_mod = _load_axi_module()
        line = axi_mod.gate_identity_skipped_line("vidushi", confirmed=False)
        self.assertIn("vidushi", line)
        self.assertNotIn("pre-existed", line)
        self.assertIn("never established an identity", line)

    def test_confirmed_tracks_whether_the_server_accepted_the_touch(self):
        axi_mod = _load_axi_module()
        accepted = axi_mod.GatedRunIdentity("A1")
        accepted.observe({"ok": True, "changed": False})
        self.assertTrue(accepted.confirmed)
        refused = axi_mod.GatedRunIdentity("A1")
        refused.observe({"ok": False, "error": "HTTP 409: unknown cycleId: 999"})
        self.assertFalse(refused.confirmed)
        self.assertFalse(refused.should_remove)

    def test_refused_open_line_names_the_agent_and_the_server_error(self):
        """A 409 on an invalid `--cycle` must not be swallowed: without this
        the only symptom is the ingest's downstream refusal, which names the
        registration but never the binding that was actually rejected."""
        axi_mod = _load_axi_module()
        line = axi_mod.gate_identity_open_failed_line(
            "vidushi", "HTTP 409: bound cycle 152 is done")
        self.assertIn("vidushi", line)
        self.assertIn("HTTP 409: bound cycle 152 is done", line)
        self.assertIn("--cycle", line)


class FleetGatedRunOwnsOnlyWhatItCreatedTest(unittest.TestCase):
    """CR-CRU-056 (C5) -- the corrected bracket is a FLEET property, not a
    bun-only one: no client may call `_remove_agent_silent` unconditionally
    any more. Grep-sweep in the style of `SharedAxiCycleResolverRetiredTest`
    (the established AC pattern for fleet-wide uniformity)."""

    CLIENTS = ("bun-crucible.py", "python-crucible.py", "rust-crucible.py",
               "mvn-crucible.py", "arduino-crucible.py")

    def test_every_client_routes_its_gated_cleanup_through_the_ownership_gate(self):
        missing = []
        for name in self.CLIENTS:
            source = (REPO_ROOT / "clients" / name).read_text()
            if ("_open_gate_identity" not in source
                    or "_close_gate_identity" not in source):
                missing.append(name)
        self.assertEqual(
            missing, [],
            f"every client's gated run must OPEN its identity and close it "
            f"through the ownership gate (_open_gate_identity / "
            f"_close_gate_identity); missing in {missing!r}")

    def test_no_client_calls_the_silent_removal_outside_the_ownership_gate(self):
        """The silent removal may be reached ONLY from `_close_gate_identity`
        (which asks `should_remove` first) or from its own definition -- a
        stray direct call in a `finally` is the exact defect this fixes."""
        offenders = []
        for name in self.CLIENTS:
            source = (REPO_ROOT / "clients" / name).read_text()
            in_close_gate = False
            for lineno, line in enumerate(source.splitlines(), start=1):
                stripped = line.strip()
                if stripped.startswith("def "):
                    in_close_gate = stripped.startswith("def _close_gate_identity")
                    if stripped.startswith("def _remove_agent_silent"):
                        in_close_gate = True   # its own definition line
                        continue
                code_part = line.split("#", 1)[0]
                if "_remove_agent_silent(" in code_part and not in_close_gate:
                    offenders.append(f"{name}:{lineno}: {stripped}")
        self.assertEqual(
            offenders, [],
            f"the gated-run silent removal must be reached only through the "
            f"ownership gate -- an unconditional call destroys a caller's "
            f"registration and its cycle binding; found {offenders!r}")

    def test_every_client_exposes_cycle_on_its_gated_verbs(self):
        missing = []
        for name in self.CLIENTS:
            source = (REPO_ROOT / "clients" / name).read_text()
            if "_add_gate_cycle_arg" not in source:
                missing.append(name)
        self.assertEqual(
            missing, [],
            f"every client's gated verbs must accept --cycle for the "
            f"register-inside-the-run case (§S4); missing in {missing!r}")


class BunCrucibleImportsSharedAxiModuleTest(unittest.TestCase):
    """§S1 regression guard: bun-crucible.py must be wired to the new shared
    module, not keep a standalone duplicate implementation, so extraction is
    behavior-preserving (byte-identical envelopes)."""

    def test_bun_crucible_source_references_the_shared_axi_module(self):
        source = BUN_SCRIPT_PATH.read_text()
        self.assertIn(
            "_crucible_axi", source,
            "bun-crucible.py must import from the new shared "
            "clients/_crucible_axi.py module (§S1) rather than keep a "
            "standalone duplicate envelope implementation",
        )

    def test_bun_emit_axi_produces_byte_identical_stdout_to_the_shared_emit_axi(self):
        axi_mod = _load_axi_module()
        bun_mod = _load_bun_crucible_module()
        call_args = ("register", True, {"agent": "CR-X-9"},
                     {"projectKey": "k9", "agentId": "CR-X-9"}, [])

        bun_out = io.StringIO()
        with contextlib.redirect_stdout(bun_out):
            bun_mod._emit_axi(*call_args)

        shared_out = io.StringIO()
        with contextlib.redirect_stdout(shared_out):
            axi_mod.emit_axi(*call_args)

        self.assertEqual(
            bun_out.getvalue(), shared_out.getvalue(),
            "bun-crucible.py's _emit_axi must produce BYTE-IDENTICAL stdout "
            "to the shared clients/_crucible_axi.py emit_axi() -- the "
            "extraction must be behavior-preserving",
        )

    def test_bun_axi_context_produces_identical_output_to_the_shared_axi_context(self):
        axi_mod = _load_axi_module()
        bun_mod = _load_bun_crucible_module()
        tmpdir = tempfile.mkdtemp(prefix="bun-crucible-axi-shared-")
        saved_env = {k: os.environ.get(k) for k in ("WORKFLOW_WAVE", "WORKFLOW_ROLE")}
        try:
            with open(os.path.join(tmpdir, ".env"), "w") as f:
                f.write("CRUCIBLE_PROJECT_KEY=shared-key-42\n")
            for k in saved_env:
                os.environ.pop(k, None)
            os.environ["WORKFLOW_WAVE"] = "4"

            bun_ctx = bun_mod._axi_context(tmpdir, agent_id="A1", cr="CR-Z", cycle_id=99)
            shared_ctx = axi_mod.axi_context(
                "shared-key-42", agent_id="A1", cr="CR-Z", cycle_id=99)
        finally:
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(tmpdir, ignore_errors=True)

        self.assertEqual(
            bun_ctx, shared_ctx,
            "bun-crucible.py's _axi_context(project_dir, ...) must produce "
            "output IDENTICAL to the shared clients/_crucible_axi.py "
            "axi_context(project_key, ...) for the same resolved project_key "
            "-- the byte-identical-envelope regression guard (§S1)",
        )


# ── CR-CRU-037 §S2 -- `no_title_warning` builder (mirrors `no_wave_warning`) ─


class SharedAxiNoTitleWarningTest(unittest.TestCase):
    """CR-CRU-037 §S2 -- a `plan-file` invoked without a resolvable title
    (`--title` unset) must carry a `no-title` warning -- envelope `warnings[]`
    `{code:"no-title", detail:"..."}` naming the CR being filed, mirroring the
    §S3 `no_wave_warning` builder pinned above (line 297) so all five clients
    share one source of truth for the warning text.

    RED: `clients/_crucible_axi.py` does not define `no_title_warning` at all
    (confirmed by reading the module source) -- calling it below raises an
    AttributeError, a valid missing-SUT-symbol RED."""

    def test_no_title_warning_returns_no_title_code_and_detail_naming_the_cr(self):
        axi_mod = _load_axi_module()
        warning = axi_mod.no_title_warning("CR-CRU-090")
        self.assertEqual(warning.get("code"), "no-title",
                          f"no_title_warning must return code='no-title'; got {warning!r}")
        self.assertIn("CR-CRU-090", warning.get("detail", ""),
                      f"the no-title warning detail must NAME the CR being filed; "
                      f"got {warning!r}")

    def test_no_title_warning_detail_names_the_specific_cr_supplied(self):
        axi_mod = _load_axi_module()
        warning_a = axi_mod.no_title_warning("CR-AAA-001")
        warning_b = axi_mod.no_title_warning("CR-BBB-002")
        self.assertIn("CR-AAA-001", warning_a.get("detail", ""))
        self.assertIn("CR-BBB-002", warning_b.get("detail", ""))
        self.assertNotIn("CR-BBB-002", warning_a.get("detail", ""),
                          "the detail must name ONLY the CR it was built for, "
                          "not a different CR")


STATUS_CONTRACT_PATH = REPO_ROOT / "clients" / "STATUS-CONTRACT.md"


class StatusContractDocTest(unittest.TestCase):
    """CR-CRU-035 §S2 -- a versioned `status` envelope contract doc must live
    WITH the clients (`clients/STATUS-CONTRACT.md`) so it ships and versions
    with the code Model-B's generated session-start hook invokes.

    RED: `clients/STATUS-CONTRACT.md` does not exist yet (confirmed by `ls
    clients/`) -- reading it below raises FileNotFoundError, a valid
    missing-SUT-doc RED (same convention as the missing-module RED above)."""

    def _read_contract(self):
        self.assertTrue(
            STATUS_CONTRACT_PATH.exists(),
            f"§S2 requires a versioned status contract doc committed at "
            f"{STATUS_CONTRACT_PATH} (alongside the clients), so Model-B's "
            f"generated hook can pin a version -- file does not exist")
        return STATUS_CONTRACT_PATH.read_text()

    def test_contract_doc_exists_and_documents_the_core_envelope_fields(self):
        text = self._read_contract()
        for field in ("ok", "context", "warnings", "plans", "lastRunCr"):
            self.assertIn(
                field, text,
                f"the contract doc must name the top-level envelope field "
                f"{field!r}; it is part of the §S2-pinned shape")
        for row_field in ("cr", "wave", "status", "activeCycleId"):
            self.assertIn(
                row_field, text,
                f"the contract doc must name the plans[] row field "
                f"{row_field!r} (the §S6 base row schema)")

    def test_contract_doc_names_the_active_cycle_id_and_label(self):
        text = self._read_contract().lower()
        self.assertIn(
            "active cycle", text,
            "the contract doc must document the single status:\"active\" "
            "cycle (id + label) the plans[] row carries")
        self.assertIn(
            "label", text,
            "the contract doc must document the active cycle's label field, "
            "not just its id")

    def test_contract_doc_carries_a_version_string(self):
        text = self._read_contract()
        self.assertTrue(
            re.search(r"version[^\n]{0,40}\d", text, re.IGNORECASE),
            f"the contract doc must assign the envelope a VERSION string "
            f"(so Model-B's hook can pin what it renders); no "
            f"'version ... <digit>' pattern found in {STATUS_CONTRACT_PATH}")

    def test_contract_doc_documents_the_tolerant_status_unavailable_degrade_shape(self):
        text = self._read_contract()
        self.assertIn(
            "status-unavailable", text,
            "the contract doc must note the §S1 tolerant-degrade shape -- a "
            "hook getting ok:true + warnings[] status-unavailable renders "
            "'board unavailable', never fails")
        normalized = text.lower().replace(" ", "").replace("`", "")
        self.assertIn(
            "ok:true", normalized,
            "the contract doc must show the tolerant-degrade envelope is "
            "ok:true (a definitive data-state, never a command failure)")

    def test_contract_doc_names_axi_principles_satisfied_by_fields_and_behavior(self):
        text = self._read_contract()
        self.assertIn(
            "principle", text.lower(),
            "the contract doc must name the AXI principles (axi.md) each "
            "field/behavior satisfies, per §S2's explicit requirement")


# ---------------------------------------------------------------------------
# CR-CRU-064 §S1 (C1) — the ONE shared no-report envelope pair.
#
# Contract pinned from
# docs/changes/CR-CRU-064-toolchain-starved-runs-emit-no-envelope.md §S1
# (AC1/AC2) and the C1 dispatch note that resolved its signature collision
# (a caller-composed `detail` cannot carry the AC2 invariant -- it would push
# the exit-code/last-line/truncation rule into all seven call sites, which is
# precisely the duplication C1 deletes, so the CAUSE reaches the helper):
#
#     no_report_help(verb, artifact, remedy=None)        -> list[str]
#     no_report_warning(verb, artifact, exit_code, output) -> dict
#
# Shape follows `gate_step_abort_help` / `gate_step_abort_warning` (:722-740):
# PURE, no I/O, `help[]` ends with "status", warning is {code, detail}.
#
# These are also the FIRST assertions rust's `_no_junit_help` (:360) and mvn's
# inline `no-test-reports` warning (`_emit_compile_fallback_axi` :894-909) have
# ever had -- CR-CRU-064's Risk note measured both as currently UNGUARDED --
# so both artifact flavours ("junit.xml", "surefire reports") are asserted
# here: the C1 re-point must not silently change what those two clients emit.
#
# RED: `clients/_crucible_axi.py` defines neither name (confirmed by reading
# the module) -- every call below raises AttributeError, a valid
# missing-SUT-symbol RED, the same convention as
# `SharedAxiNoTitleWarningTest` above.
# ---------------------------------------------------------------------------

ARTIFACTS = ("junit.xml", "surefire reports")


class SharedAxiNoReportHelpTest(unittest.TestCase):
    """AC1 — `no_report_help(verb, artifact, remedy=None)` returns the
    state-derived next step for a run that produced NO report at all: read the
    runner's own output, then re-run. A `list[str]` whose final element is
    `"status"`, as every `help[]` in the fleet is."""

    def test_no_report_help_is_a_list_of_strings_whose_last_step_is_status(self):
        axi_mod = _load_axi_module()
        for artifact in ARTIFACTS:
            steps = axi_mod.no_report_help("regression", artifact)
            self.assertIsInstance(
                steps, list,
                f"no_report_help must return a list[str] help[] (the §S1 "
                f"shape of gate_step_abort_help); got {steps!r}")
            for step in steps:
                self.assertIsInstance(
                    step, str,
                    f"every help[] element must be a string; got {steps!r}")
                self.assertTrue(
                    step.strip(),
                    f"no help[] step may be blank -- a blank next action is "
                    f"not an action; got {steps!r}")
            self.assertEqual(
                steps[-1], "status",
                f"AC1: no_report_help's FINAL element must be exactly "
                f"'status', as every help[] in the fleet ends; got {steps!r}")

    def test_no_report_help_first_step_names_the_missing_artifact_and_the_verb(self):
        """The first action must be self-explaining: WHICH verb produced no
        report, and WHICH artifact was expected -- substrings, never a canned
        per-verb sentence (CR-CRU-058 §S2)."""
        axi_mod = _load_axi_module()
        for verb, artifact in (("regression", "junit.xml"),
                               ("pre-merge-gate", "junit.xml"),
                               ("unit", "surefire reports"),
                               ("module", "surefire reports")):
            first = axi_mod.no_report_help(verb, artifact)[0]
            self.assertIn(
                artifact, first,
                f"AC1: the first help step must NAME the artifact that was "
                f"never produced ({artifact!r}); got {first!r}")
            self.assertIn(
                verb, first,
                f"AC1: the first help step must NAME the verb whose run "
                f"produced nothing ({verb!r}), never a canned string; "
                f"got {first!r}")

    def test_no_report_help_puts_an_explicit_remedy_ahead_of_the_rerun_step(self):
        """§S1 — `remedy` is the step's OWN concrete fix (the shape
        `gate_step_abort_help` established): it must come BEFORE re-running,
        because re-running before applying it just reproduces the starvation."""
        axi_mod = _load_axi_module()
        remedy = "install unittest-xml-reporting into the interpreter under test"
        steps = axi_mod.no_report_help("regression", "junit.xml", remedy)
        remedy_indexes = [i for i, s in enumerate(steps) if remedy in s]
        self.assertTrue(
            remedy_indexes,
            f"the supplied remedy must appear in help[]; got {steps!r}")
        rerun_indexes = [i for i, s in enumerate(steps) if "re-run" in s]
        self.assertTrue(
            rerun_indexes,
            f"help[] must still carry a re-run step alongside the remedy; "
            f"got {steps!r}")
        self.assertLess(
            remedy_indexes[0], rerun_indexes[0],
            f"AC1: the remedy must be ordered AHEAD of the re-run step -- "
            f"re-running before applying it reproduces the same starved run; "
            f"got {steps!r}")
        self.assertEqual(
            steps[-1], "status",
            f"the remedy variant must still end with 'status'; got {steps!r}")


class SharedAxiNoReportWarningTest(unittest.TestCase):
    """AC1/AC2 — `no_report_warning(verb, artifact, exit_code, output)` is
    exactly `{"code": "no-test-reports", "detail": ...}` (mvn's existing code
    string, reused VERBATIM -- a lift, not a rename), whose `detail` carries
    the machine-readable cause: the runner's exit code and the last non-empty
    line of the captured output, so `No module named 'xmlrunner'` reaches the
    consumer instead of an exit code and empty stdout."""

    # The measured signature from CR-CRU-063 (run 31726344668): the child dies
    # before writing any TEST-*.xml, and the ONLY evidence of why is the tail
    # of the capture. Trailing blank lines are deliberate -- "last non-empty
    # line", not "last line".
    STARVED_CAPTURE = (
        "Traceback (most recent call last):\n"
        "  File \"/usr/lib/python3.13/runpy.py\", line 198, in _run_module_as_main\n"
        "    return _run_code(code, main_globals, None,\n"
        "  File \"/usr/lib/python3.13/runpy.py\", line 88, in _run_code\n"
        "    exec(code, run_globals)\n"
        "ModuleNotFoundError: No module named 'xmlrunner'\n"
        "\n"
        "   \n"
    )

    def test_no_report_warning_code_is_exactly_the_existing_no_test_reports(self):
        axi_mod = _load_axi_module()
        for artifact in ARTIFACTS:
            warning = axi_mod.no_report_warning(
                "regression", artifact, 1, self.STARVED_CAPTURE)
            self.assertEqual(
                warning.get("code"), "no-test-reports",
                f"AC1: the code must be EXACTLY 'no-test-reports' -- mvn's "
                f"existing string, reused verbatim, never renamed; "
                f"got {warning!r}")
            self.assertEqual(
                set(warning), {"code", "detail"},
                f"the warning is the fleet's {{code, detail}} pair and nothing "
                f"else (the shape of gate_step_abort_warning); got {warning!r}")

    def test_detail_names_the_runner_exit_code_and_the_last_non_empty_line(self):
        axi_mod = _load_axi_module()
        for artifact in ARTIFACTS:
            detail = axi_mod.no_report_warning(
                "regression", artifact, 9, self.STARVED_CAPTURE)["detail"]
            self.assertTrue(
                re.search(r"(?<!\d)9(?!\d)", detail),
                f"AC2: the detail must name the RUNNER'S EXIT CODE (9) -- the "
                f"first machine-readable fact about a starved run; "
                f"got {detail!r}")
            self.assertIn(
                "ModuleNotFoundError: No module named 'xmlrunner'", detail,
                f"AC2: the detail must carry the LAST NON-EMPTY line of the "
                f"capture (trailing blank/whitespace lines skipped), which is "
                f"the cause line; got {detail!r}")
            self.assertNotIn(
                "_run_module_as_main", detail,
                f"AC2 says the LAST non-empty line, not the whole capture -- "
                f"the traceback head must not be dumped into the warning; "
                f"got {detail!r}")
            self.assertIn(
                artifact, detail,
                f"the detail must name the artifact that was never produced "
                f"({artifact!r}); got {detail!r}")
            self.assertIn(
                "regression", detail,
                f"the detail must name the verb whose run produced nothing; "
                f"got {detail!r}")

    def test_the_xmlrunner_cause_substring_survives_into_the_detail(self):
        """AC2's named example, asserted on its own: a run starved of
        `xmlrunner` produces a detail containing `No module named
        'xmlrunner'`. This is the whole point of the CR -- today the consumer
        gets exit 1 and empty stdout."""
        axi_mod = _load_axi_module()
        detail = axi_mod.no_report_warning(
            "pre-merge-gate", "junit.xml", 1, self.STARVED_CAPTURE)["detail"]
        self.assertIn(
            "No module named 'xmlrunner'", detail,
            f"AC2: the starved-toolchain cause must reach the consumer "
            f"verbatim; got {detail!r}")

    def test_detail_is_bounded_at_500_characters_and_keeps_the_causing_tail(self):
        """AC2 — a 5,000-character capture is truncated to a detail of at most
        500 characters, and the truncation keeps the TAIL (the cause), not the
        head: a bound that dropped the last line would bound away the only
        machine-readable fact the warning exists to carry."""
        axi_mod = _load_axi_module()
        cause = "ModuleNotFoundError: No module named 'xmlrunner'"
        long_capture = ("HEADOFCAPTUREMARKER " + "x" * 4940 + " " + cause)
        self.assertGreaterEqual(
            len(long_capture), 5000,
            "fixture guard: the capture under test must really be ~5,000 "
            "characters, otherwise the bound is never exercised")
        for artifact in ARTIFACTS:
            detail = axi_mod.no_report_warning(
                "regression", artifact, 2, long_capture)["detail"]
            self.assertLessEqual(
                len(detail), 500,
                f"AC2: the detail must be bounded at 500 characters; "
                f"got len={len(detail)}")
            self.assertIn(
                cause, detail,
                f"AC2: truncation must keep the TAIL of the capture -- the "
                f"cause line is the payload; got {detail!r}")
            self.assertNotIn(
                "HEADOFCAPTUREMARKER", detail,
                f"AC2: truncation must drop the HEAD, not the tail -- keeping "
                f"the head would bound away the cause; got {detail!r}")
            self.assertTrue(
                re.search(r"(?<!\d)2(?!\d)", detail),
                f"the helper-composed prefix (verb, artifact, exit code) is "
                f"never truncated, so the exit code survives a 5,000-character "
                f"capture; got {detail!r}")
            self.assertIn(
                artifact, detail,
                f"the artifact named in the prefix must survive truncation; "
                f"got {detail!r}")

    def test_a_blank_capture_still_names_the_exit_code_and_is_never_empty(self):
        """A runner can die with nothing on stdout/stderr at all. The detail
        must still say what happened -- an empty detail is not merely useless,
        the compile endpoint 400s on an empty string."""
        axi_mod = _load_axi_module()
        for blank in ("", "   ", "\n\n", "  \n\t\n   \n"):
            for artifact in ARTIFACTS:
                detail = axi_mod.no_report_warning(
                    "regression", artifact, 127, blank)["detail"]
                self.assertTrue(
                    detail and detail.strip(),
                    f"a blank capture ({blank!r}) must NOT yield an empty "
                    f"detail -- the ingest endpoint rejects it; "
                    f"got {detail!r}")
                self.assertIn(
                    "127", detail,
                    f"AC2: with no captured output at all, the exit code is "
                    f"the only fact left and MUST be named; got {detail!r}")
                self.assertIn(
                    artifact, detail,
                    f"a blank capture must still name the missing artifact; "
                    f"got {detail!r}")
                self.assertNotIn(
                    "None", detail,
                    f"a blank capture must not leak a stringified None into "
                    f"the detail; got {detail!r}")


if __name__ == "__main__":
    unittest.main()
