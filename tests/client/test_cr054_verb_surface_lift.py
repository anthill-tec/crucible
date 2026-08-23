"""CR-CRU-054 C4 -- verb-surface lift RED tests.

Pins this cycle's slice of the client-fleet lift
(docs/changes/CR-CRU-054-client-fleet-dry.md §S1b/§S2/§S2b) for the `cmd_*`
verb surface and its remaining helpers, per the dispatch brief's named list:

    cmd_register cmd_unregister cmd_status cmd_stop cmd_checkpoint cmd_abort
    cmd_milestone cmd_plan_file cmd_cycle_activate cmd_cycle_done
    cmd_cycle_add cmd_cr_close cmd_dashboard cmd_gate_report cmd_gate_run
    _cycle_transition _post_gate _post_milestone _remove_agent_silent
    _open_gate_identity _close_gate_identity _add_gate_cycle_arg main

Cross-checked against docs/research/DN-client-fleet-inventory.md §1/§2/§3/§4
before writing anything. §S1b's ALREADY-DELEGATED / NEEDS-LIFT split, applied
by reading all five bodies of each candidate (not trusting the DN's SHARED
label alone -- exactly C3's method):

  ALREADY-DELEGATED (2, no test here -- a "single locus" test on either would
  be born green, per the sub-agent RED discipline):
    * `cmd_cycle_activate`, `cmd_cycle_done` -- both are, TODAY, already
      1-line dispatchers (`return _cycle_transition(args, "active"/"done")`)
      byte-identical across all five clients. Unlike `_axi_context`/
      `_emit_axi`/`_agent_id` (C3's exclusions), these delegate to a LOCAL
      SIBLING function, not the shared module -- but the effect for THIS
      cycle's job is the same: there is no independent logic inside either
      name to move, and neither body will change even after `_cycle_transition`
      itself is lifted (it will still just call `_cycle_transition(args, ...)`
      -- see below). The REAL duplicated logic behind them is pinned directly
      as `_cycle_transition`.

  NEEDS-LIFT (12 -- confirmed by reading all five bodies; each has its FULL
  verb logic duplicated today, with only the already-noted cosmetic
  differences DN §1 documents: bun's private `_HELP_STEPS`/
  `_PREFER_GATE_RUN_WARNING` dict access vs. the other four's `_axi().HELP_STEPS`/
  `.PREFER_GATE_RUN_WARNING`, and arduino's `_project_dir(args)` vs. the other
  four's `_resolve_project_dir(args.project_dir)` -- a helper OUTSIDE the 42,
  noted here only because it means the shared lift must accept an
  already-resolved `project_dir`, per DN §1's own note):
    cmd_status, cmd_stop, cmd_checkpoint, cmd_abort, cmd_cycle_add,
    cmd_cr_close, cmd_gate_report, cmd_gate_run, _cycle_transition,
    _post_gate, _post_milestone, _add_gate_cycle_arg

  PARAMETERISED (1, DN §2 confirmed by reading all five bodies):
    cmd_dashboard -- mvn's own `cmd_status` takes an extra `maven_dir` field
    (its module-dir convention); the other four omit it. Lifts with the extra
    field as a per-client parameter, per DN §2's own description.

  DRIFTED -- corrected in THIS slice, per the dispatch brief's item 4 (four of
  the eight §S2b findings; confirmed against every client's actual body):
    * `cmd_milestone` -- bun's `print(...)` omits `file=sys.stderr` (DN §4
      finding #1); the other four are correct. Corrected: ALL FIVE write to
      stderr.
    * `cmd_plan_file` -- `context.cr` on the failure path is present ONLY in
      mvn/arduino today (bun omits `cr` on BOTH paths; rust/python omit it on
      the failure path only) (DN §4 finding #2). Corrected: ALL FIVE carry
      `context.cr` on BOTH the failure and success paths.
    * `cmd_register` / `cmd_unregister` -- bun/rust/mvn/python read `args.agent`
      directly (relying on argparse `required=True`, which bypasses the
      fleet's own §S5 AXI hard-stop envelope and emits a bare argparse usage
      error instead -- DN §4 finding #3); arduino already resolves the
      identity through `_agent_id(args)` (the shared, ALREADY-DELEGATED
      `require_agent_id` hard stop -- see `test_cr054_axi_context_lift.py`'s
      module docstring for that exclusion). Corrected: ALL FIVE resolve the
      identity through `_agent_id(args)`. The argparse-level
      `required=True` -> optional flip is a companion per-client edit inside
      `main` (GENUINELY PER-CLIENT, DN §3 -- not restructured by this lift),
      pinned here as an OBSERVABLE CLI-level behavioural correction (§S4's own
      language: "each correction gets a NEW test pinning the corrected
      behaviour"), exactly the idiom already established by
      `tests/client/test_bun_crucible_agent_identity_required.py` (real
      argparse dispatch via `module.main()`, `_post` mocked).
    * `_remove_agent_silent` / `_close_gate_identity` -- a paired defect (DN §4
      finding #6): bun's `_remove_agent_silent` has no exception guard (can
      crash the gate-closing bracket); rust/mvn/python/arduino's has the guard
      but discards the response, so `_close_gate_identity` reports a FIXED
      "removed" message unconditionally, even when the swallowed exception
      means nothing was removed. DN's own verdict: "no single client has this
      fully right... combine both: catch the exception AND still capture and
      report whether the call actually succeeded... e.g. a per-call try/except
      that captures `ok=` from the response when reachable and reports
      'attempted, outcome unknown' only on a genuine transport failure, never
      a blanket 'removed.'" Pinned here exactly to that combination.

  DRIFTED -- deferred by C4, RESOLVED in C5, given its BEHAVIOURAL proof in C6
  (the §S2b corrections #4/#5 below; see `IdentitySourceOnTheWireDriftCorrectionTest`
  at the foot of this file). C4 left the identity `source` split
  (`openclaw` -> `claude-md`) unpinned, per the dispatch brief; C5 corrected it
  fleet-wide but pinned it only with source-text/AST scans in
  `test_cr054_fleet_inventory.py` (`test_open_gate_identity_source_override_now_removed_fleet_wide`,
  `IdentitySourceEnumGuardTest`), which describe the SOURCE rather than the
  behaviour. The whole point of the correction is what reaches the SERVER, so
  C6 adds the missing half: every identity-payload-building site is invoked
  with the client's own `_post` mocked and the ACTUAL outgoing body asserted.
  The static scans stay -- a useful second net.

  EXPLICITLY NOT PINNED, flagged for the orchestrator (matches the dispatch
  brief's own instruction not to choose -- superseded by C5/C6, see above):
    * `_open_gate_identity`'s `source` label split (`openclaw` vs
      `claude-md`, DN §4 finding #4) -- the dispatch brief's item 5 says "pick
      one... do NOT choose. Pin nothing for it." No test below touches
      `_open_gate_identity`.
    * `cmd_register`'s SECOND, separate DN §4 finding #5 (the `_register_agent`
      delegator + `--source` flag strategy in bun/python vs. the hardcoded
      `source="openclaw"` inline-payload strategy in rust/mvn/arduino) is
      NOT in the dispatch brief's list of four corrections for this slice
      (only the §4 finding #3 missing-`--agent` bypass is named). Per the DN's
      own words this is "a PARAMETERISED-shaped difference... `_crucible_axi.py`
      must pick ONE" -- structurally identical in kind to the
      `_open_gate_identity` source-label deferral. Escalated here rather than
      decided unilaterally: no test below asserts which `source` strategy
      cmd_register's lift must keep.

  GENUINELY PER-CLIENT (excluded, DN §3 -- the dispatch brief listed `main` as
  a candidate to analyze, but the DN's own §3 classification, produced by C1
  reading all five `main` bodies, is explicit: "argparse subcommand wiring is
  inherently per-toolchain (different flag sets per verb per stack)". Per the
  AC Cross-Check rule the DN -- the CR's own normative §S1 classification
  deliverable -- wins; no test below asserts a single/shared definition for
  `main`, mirroring `test_cr054_http_core_lift.py`'s identical `_project_key`
  exclusion):
    main

Test design note (matching C2/C3's committed pattern) -- structural + functional
assertions are combined in one test per NEEDS-LIFT/PARAMETERISED name (a
"logic moved" assertion that fails today for the real reason, followed by a
"still works" functional assertion that only gets a chance to matter once the
structural half holds), so no test in this file is vacuously green before any
production change. The four DRIFTED corrections are behavioural-only (the
current, wrong behaviour already "works" in the sense of not crashing, so
their tests are purely functional, driven directly against each client's
current body) -- this is the deliberate §S4 carve-out: unlike the 13
lift-only names above, these tests are EXPECTED to change what four (or all
five, for the register/unregister argparse correction) clients emit.

No production code was moved to write this file. No client's own test file
was edited (§S4's unmodified-tests rule); an existing test pinning any of the
four corrected DEFECTS would need re-pointing, not silent edit -- checked
below (module docstring's "existing-test audit" section) and none found
pinning the DEFECTIVE shape of these four.

Existing-test audit (§S4 carve-out requires this be explicit): grepped
`tests/client/test_*_crucible_*.py` for `cmd_milestone`/`cmd_plan_file`/
`cmd_register`/`cmd_unregister`/`_remove_agent_silent`/`_close_gate_identity`
assertions that would break under the corrected behaviour --
`test_bun_crucible_agent_identity_required.py`'s milestone/gate tests assert
hard-stop behaviour with `--agent` already ABSENT (a scenario unaffected by
the register/unregister-specific argparse fix, since those tests target
`gate-report`/`gate-run`/`milestone`, not `register`/`unregister`); no test
anywhere asserts bun's `cmd_milestone` writes to stdout, or that
`cmd_plan_file`'s failure envelope omits `context.cr`, or that
`_close_gate_identity` unconditionally prints "removed". None found pinning
a defective shape -- nothing to re-point.

Invocation:
    python3 -m pytest tests/client/test_cr054_verb_surface_lift.py -q
Fallback:
    python3 tests/client/test_cr054_verb_surface_lift.py
"""

import argparse
import ast
import contextlib
import copy
import io
import os
import sys
import tempfile
import shutil
import unittest
import importlib.util
from pathlib import Path
from unittest import mock

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
CLIENTS = tuple(CLIENT_FILES)


def _load_module_by_path(path, cache_key):
    """Load a module by file path, mirroring the fleet's own `_axi()`/`_toon()`
    loader pattern -- the same convention every existing client/shared-module
    test in this directory uses."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(client):
    return _load_module_by_path(
        CLIENT_FILES[client], f"cr054_verb_surface_{client}_under_test")


def _function_source_segment(path, name):
    """AST-extract the exact source text of a top-level `def <name>` in
    `path` -- mirrors test_cr054_fleet_inventory.py's / the sibling C2/C3
    lift tests' method. Returns None if not defined as a top-level function."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    for node in tree.body:
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == name):
            return ast.get_source_segment(text, node)
    return None


def _clients_with_marker_in_function(name, marker):
    """Every client whose own top-level `def <name>` still contains `marker`
    literally -- i.e. still carries the REAL logic, not a delegator."""
    offenders = []
    for client, path in CLIENT_FILES.items():
        body = _function_source_segment(path, name)
        if body is not None and marker in body:
            offenders.append(client)
    return offenders


def _make_args(**kwargs):
    return argparse.Namespace(**kwargs)


def _run_main(module, argv):
    """Real argparse dispatch via `module.main()` -- the exact idiom
    established by test_bun_crucible_agent_identity_required.py (and its
    rust/mvn/python/arduino siblings) for proving a hard-stop is reached
    through the ACTUAL CLI entry point, not a hand-built call."""
    full_argv = ["crucible.py"] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


class _ProjectDirFixture:
    """A tmpdir with a valid `.env` so `_project_key`/arduino's `_load_env`
    resolve without crashing -- matches the sibling agent-identity tests'
    setUp exactly."""

    _PROJECT_KEY = "cr054-c4-key"

    def _make_project_dir(self):
        tmpdir = tempfile.mkdtemp(prefix="cr054-c4-verb-surface-")
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self._PROJECT_KEY}\n")
            f.write("CRUCIBLE_PROJECT_NAME=cr054-c4-project\n")
        return tmpdir


# ---------------------------------------------------------------------------
# NEEDS-LIFT -- the project/plan write-verbs + status read-verb.
# ---------------------------------------------------------------------------


class VerbSurfaceWriteVerbsSingleLocusTest(unittest.TestCase, _ProjectDirFixture):
    """`cmd_status`, `cmd_stop`, `cmd_checkpoint`, `cmd_abort`, `cmd_cycle_add`,
    `cmd_cr_close` each carry their FULL verb logic duplicated in all five
    clients today (confirmed by reading every body: bun-crucible.py's own
    private `_HELP_STEPS` dict access is the only client-specific token; the
    rest, including the URL paths, dict-literal shapes and error messages
    below, are byte-identical). Each combined test asserts the structural
    "no private copy" condition (what fails TODAY) then proves the client's
    own name still delegates correctly end-to-end."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_status_moves_out_of_every_client_and_still_works(self):
        marker = "status-unavailable"
        offenders = _clients_with_marker_in_function("cmd_status", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_status's REAL "
            f"unavailable-degrade logic in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_status's real logic after "
            "the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=f"{client}-plans-listed"):
                module = _load_client_module(client)
                plans_resp = {"ok": True, "plans": [
                    {"cr": "CR-CRU-054", "wave": "wave-4", "status": "open",
                     "activeCycleId": 7, "closedAt": None}]}
                with mock.patch.object(module, "_get", return_value=plans_resp) as get_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_status(_make_args(project_dir=self.tmpdir))
                self.assertEqual(rc, 0)
                get_mock.assert_called_once()
                emit_mock.assert_called_once()
                result_fields = emit_mock.call_args.args[2]
                self.assertEqual(
                    len(result_fields["plans"]), 1,
                    f"{client}-crucible.py's cmd_status must still emit "
                    f"exactly the plans GET returned")
                self.assertEqual(result_fields["count"], 1)

            with self.subTest(client=f"{client}-server-unreachable"):
                module = _load_client_module(client)
                with mock.patch.object(
                        module, "_get",
                        return_value={"ok": False, "error": "ECONNREFUSED"}), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_status(_make_args(project_dir=self.tmpdir))
                self.assertEqual(
                    rc, 0,
                    f"{client}-crucible.py's cmd_status must still degrade "
                    f"to ok:true (hook-safe) on a plans-fetch failure")
                ok_arg = emit_mock.call_args.args[1]
                self.assertTrue(ok_arg)
                warnings_arg = emit_mock.call_args.args[4]
                self.assertEqual(warnings_arg[0]["code"], "status-unavailable")
                self.assertIn("ECONNREFUSED", warnings_arg[0]["detail"])

    def test_stop_moves_out_of_every_client_and_still_works(self):
        marker = "checkpointed"
        offenders = _clients_with_marker_in_function("cmd_stop", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_stop's REAL "
            f"checkpointed-count reporting in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_stop's real logic after "
            "the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True, "checkpointed": 3}

                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_post", side_effect=fake_post), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_stop(_make_args(project_dir=self.tmpdir))
                self.assertEqual(rc, 0)
                self.assertEqual(len(calls), 1)
                path, payload = calls[0]
                self.assertEqual(
                    path, f"/api/v2/projects/{self._PROJECT_KEY}/stop",
                    f"{client}-crucible.py's cmd_stop must still resolve the "
                    f"REAL project key from the project dir's .env (no "
                    f"`_project_key` stub here -- this is the exact "
                    f".env->key->URL integration the fixture landmine used "
                    f"to hide)")
                self.assertEqual(
                    payload, {"agentId": "A1"},
                    f"{client}-crucible.py's cmd_stop must still send the "
                    f"resolved agentId in the stop POST body")
                result_fields = emit_mock.call_args.args[2]
                self.assertEqual(result_fields["checkpointed"], 3)

    def test_checkpoint_moves_out_of_every_client_and_still_works(self):
        marker = "planId']}/checkpoint"
        offenders = _clients_with_marker_in_function("cmd_checkpoint", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_checkpoint's REAL "
            f"checkpoint-POST logic in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_checkpoint's real logic "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True, "changed": True}

                plan = {"planId": 9, "cr": "CR-CRU-054", "status": "open"}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_resolve_plan_or_emit",
                            return_value=(plan, None)) as resolve_mock, \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(module, "_post", side_effect=fake_post), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_checkpoint(_make_args(project_dir=self.tmpdir, cr=None))
                self.assertEqual(rc, 0)
                resolve_mock.assert_called_once_with(
                    "checkpoint", self.tmpdir, None, mock.ANY, open_only=True)
                self.assertEqual(len(calls), 1)
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/projects/pk/plans/9/checkpoint")
                self.assertEqual(payload, {"agentId": "A1"})
                result_fields = emit_mock.call_args.args[2]
                self.assertEqual(result_fields["plan"], 9)
                self.assertEqual(result_fields["changed"], True)

    def test_abort_moves_out_of_every_client_and_still_works(self):
        marker = "planId']}/abort"
        offenders = _clients_with_marker_in_function("cmd_abort", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_abort's REAL abort-POST "
            f"logic in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_abort's real logic after "
            "the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": False, "error": "409 refused"}

                plan = {"planId": 4, "cr": "CR-CRU-054", "status": "open"}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_resolve_plan_or_emit", return_value=(plan, None)), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(module, "_post", side_effect=fake_post), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_abort(_make_args(
                        project_dir=self.tmpdir, cr=None, user_approved=False))
                self.assertEqual(
                    rc, 1,
                    f"{client}-crucible.py's cmd_abort must still surface a "
                    f"409 refusal as a non-zero exit")
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/projects/pk/plans/4/abort")
                self.assertEqual(
                    payload, {"userApproved": False, "agentId": "A1"},
                    f"{client}-crucible.py's cmd_abort must still send "
                    f"userApproved=False by default (never a silent no-op "
                    f"bypass of the server's discouraging 409)")
                ok_arg = emit_mock.call_args.args[1]
                self.assertFalse(ok_arg)

    def test_cycle_add_moves_out_of_every_client_and_still_works(self):
        marker = "planId']}/cycles\","
        offenders = _clients_with_marker_in_function("cmd_cycle_add", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_cycle_add's REAL "
            f"cycle-append POST logic in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_cycle_add's real logic "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True, "id": 55}

                plan = {"planId": 2, "cr": "CR-CRU-054", "status": "open"}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_resolve_plan_or_emit", return_value=(plan, None)), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(module, "_post", side_effect=fake_post), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_cycle_add(_make_args(
                        project_dir=self.tmpdir, cr=None, label="C5"))
                self.assertEqual(rc, 0)
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/projects/pk/plans/2/cycles")
                self.assertEqual(payload, {"label": "C5", "agentId": "A1"})
                result_fields = emit_mock.call_args.args[2]
                self.assertEqual(result_fields["id"], 55)
                self.assertEqual(result_fields["label"], "C5")

    def test_cr_close_moves_out_of_every_client_and_still_works(self):
        marker = '"status": "closed"'
        offenders = _clients_with_marker_in_function("cmd_cr_close", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_cr_close's REAL "
            f"close-PATCH logic in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_cr_close's real logic "
            "after the §S2 lift -- not present yet")

        # -- no open plan: ok:false, no milestone ever posted.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-no-open-plan"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_open_plans", return_value=[]), \
                        mock.patch.object(module, "_emit_axi") as emit_mock, \
                        mock.patch.object(module, "_post_milestone") as ms_mock:
                    rc = module.cmd_cr_close(_make_args(
                        project_dir=self.tmpdir, cr=None, commit="abc123"))
                self.assertEqual(rc, 1)
                self.assertFalse(emit_mock.call_args.args[1])
                ms_mock.assert_not_called()

        # -- successful close: PATCH sent, THEN a cr-merged milestone posted.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-success-posts-milestone"):
                module = _load_client_module(client)
                plan = {"planId": 3, "cr": "CR-CRU-054", "status": "open"}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_open_plans", return_value=[plan]), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(
                            module, "_patch",
                            return_value={"ok": True}) as patch_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock, \
                        mock.patch.object(
                            module, "_post_milestone",
                            return_value={"ok": True}) as ms_mock:
                    rc = module.cmd_cr_close(_make_args(
                        project_dir=self.tmpdir, cr=None, commit="abc123"))
                self.assertEqual(rc, 0)
                patch_path, patch_payload = patch_mock.call_args.args
                self.assertEqual(patch_path, "/api/v2/projects/pk/plans/3")
                self.assertEqual(
                    patch_payload,
                    {"status": "closed", "merge": {"commit": "abc123"},
                     "agentId": "A1"})
                self.assertTrue(emit_mock.call_args.args[1])
                ms_mock.assert_called_once_with(
                    self.tmpdir, "A1", "cr-merged", label="CR-CRU-054",
                    commit="abc123", context=mock.ANY)


# ---------------------------------------------------------------------------
# NEEDS-LIFT -- gate + milestone POST helpers, the gate-run/gate-report verbs,
# and the shared `--cycle` argparse binding.
# ---------------------------------------------------------------------------


class GateAndMilestoneHelpersSingleLocusTest(unittest.TestCase, _ProjectDirFixture):
    """`_post_gate`, `_post_milestone`, `_add_gate_cycle_arg`, `cmd_gate_report`
    and `cmd_gate_run` are byte-identical across all five clients today
    (confirmed by reading every body -- only bun's private
    `_PREFER_GATE_RUN_WARNING`/`_HELP_STEPS` dict access and arduino's
    `_project_dir(args)` differ, matching DN §1's own note)."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_post_gate_moves_out_of_every_client_and_still_works(self):
        marker = '"/api/v2/gates"'
        offenders = _clients_with_marker_in_function("_post_gate", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _post_gate's REAL endpoint "
            f"in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own _post_gate's real logic "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True}

                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(module, "_post", side_effect=fake_post):
                    resp = module._post_gate(
                        "/fake/dir", "A1", {"intent": "x", "outcome": "passed"},
                        {"cr": "CR-CRU-054"})
                self.assertEqual(resp, {"ok": True})
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/gates")
                self.assertEqual(
                    payload,
                    {"projectKey": "pk", "agentId": "A1",
                     "gate": {"intent": "x", "outcome": "passed"},
                     "context": {"cr": "CR-CRU-054"}},
                    f"{client}-crucible.py's _post_gate must still build "
                    f"the same gate payload (with context only when given) "
                    f"after delegating")

                # context omitted entirely when falsy -- never a bare {}.
                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(module, "_post", side_effect=fake_post):
                    module._post_gate("/fake/dir", "A1", {"intent": "x"})
                _, payload_no_context = calls[-1]
                self.assertNotIn(
                    "context", payload_no_context,
                    f"{client}-crucible.py's _post_gate must still OMIT "
                    f"'context' (never fabricate an empty dict) when none "
                    f"is given")

    def test_post_milestone_moves_out_of_every_client_and_still_works(self):
        marker = '"/api/v2/milestones"'
        offenders = _clients_with_marker_in_function("_post_milestone", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _post_milestone's REAL "
            f"endpoint in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own _post_milestone's real logic "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True}

                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(module, "_post", side_effect=fake_post):
                    module._post_milestone(
                        "/fake/dir", "A1", "cr-merged",
                        label="CR-CRU-054", commit="abc123", context=None)
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/milestones")
                self.assertEqual(
                    payload,
                    {"projectKey": "pk", "agentId": "A1", "type": "cr-merged",
                     "label": "CR-CRU-054", "commit": "abc123"},
                    f"{client}-crucible.py's _post_milestone must still omit "
                    f"'context' when None and include label/commit when "
                    f"given, after delegating")

    def test_add_gate_cycle_arg_moves_out_of_every_client_and_still_works(self):
        marker = 'p.add_argument("--cycle", type=int,'
        offenders = _clients_with_marker_in_function("_add_gate_cycle_arg", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _add_gate_cycle_arg's REAL "
            f"argparse binding in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own _add_gate_cycle_arg's real "
            "logic after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                parser = argparse.ArgumentParser()
                module._add_gate_cycle_arg(parser)
                parsed = parser.parse_args(["--cycle", "42"])
                self.assertEqual(
                    parsed.cycle, 42,
                    f"{client}-crucible.py's _add_gate_cycle_arg must still "
                    f"bind a typed int --cycle flag after delegating")
                parsed_absent = parser.parse_args([])
                self.assertIsNone(parsed_absent.cycle)

    def test_gate_report_moves_out_of_every_client_and_still_works(self):
        marker = '"outcome": args.outcome, "steps": steps}'
        offenders = _clients_with_marker_in_function("cmd_gate_report", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_gate_report's REAL gate "
            f"assembly logic in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_gate_report's real logic "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_post_gate",
                            return_value={"ok": True}) as gate_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_gate_report(_make_args(
                        project_dir=self.tmpdir, outcome="passed",
                        commit="abc123", steps="review:passed", intent=None,
                        full=False))
                self.assertEqual(rc, 0)
                gate_arg = gate_mock.call_args.args[2]
                self.assertEqual(gate_arg["outcome"], "passed")
                self.assertEqual(gate_arg["push"], {"commit": "abc123"})
                self.assertEqual(
                    gate_arg["steps"], [{"name": "review", "status": "passed"}])
                # the prefer-gate-run discouragement always rides the envelope.
                warnings_arg = emit_mock.call_args.args[4]
                self.assertTrue(
                    any(w.get("code") == "prefer-gate-run" for w in warnings_arg),
                    f"{client}-crucible.py's cmd_gate_report must still "
                    f"attach the prefer-gate-run warning after delegating")

            with self.subTest(client=f"{client}-malformed-steps"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_post_gate") as gate_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_gate_report(_make_args(
                        project_dir=self.tmpdir, outcome="passed",
                        commit=None, steps="not-a-valid-step", intent=None,
                        full=False))
                self.assertEqual(
                    rc, 1,
                    f"{client}-crucible.py's cmd_gate_report must still "
                    f"reject a malformed --steps entry with a non-zero exit")
                gate_mock.assert_not_called()
                self.assertFalse(emit_mock.call_args.args[1])

    def test_gate_run_moves_out_of_every_client_and_still_works(self):
        marker = "_GATE_POLL_CADENCE_S"
        offenders = _clients_with_marker_in_function("cmd_gate_run", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_gate_run's REAL polling "
            f"logic in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_gate_run's real polling "
            "logic after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "shutil") as shutil_mock:
                    shutil_mock.which.return_value = None
                    rc = module.cmd_gate_run(_make_args(
                        project_dir=self.tmpdir, intent="verify"))
                self.assertEqual(
                    rc, 1,
                    f"{client}-crucible.py's cmd_gate_run must still refuse "
                    f"(non-zero) when `no-mistakes` is not on PATH, after "
                    f"delegating")


# ---------------------------------------------------------------------------
# NEEDS-LIFT -- the cycle-transition orchestration behind cmd_cycle_activate /
# cmd_cycle_done (both already thin dispatchers -- see module docstring).
# ---------------------------------------------------------------------------


class CycleTransitionSingleLocusTest(unittest.TestCase, _ProjectDirFixture):
    """`_cycle_transition`'s real plan-scan + PATCH orchestration is
    byte-identical across all five clients today. `cmd_cycle_activate`/
    `cmd_cycle_done` are already-trivial 1-line dispatchers to this name (no
    test for either -- see module docstring) whose bodies will not change
    even after this lift."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_cycle_transition_moves_out_of_every_client_and_still_works(self):
        marker = "is not in any OPEN plan"
        offenders = _clients_with_marker_in_function("_cycle_transition", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _cycle_transition's REAL "
            f"plan-scan/PATCH logic in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own _cycle_transition's real "
            "logic after the §S2 lift -- not present yet")

        # -- cycle id not found in any open plan: ok:false, no PATCH sent.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-cycle-not-found"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_open_plans", return_value=[]), \
                        mock.patch.object(module, "_patch") as patch_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module._cycle_transition(
                        _make_args(project_dir=self.tmpdir, cycle_id=999), "active")
                self.assertEqual(rc, 1)
                patch_mock.assert_not_called()
                self.assertEqual(emit_mock.call_args.args[0], "cycle-activate")
                self.assertFalse(emit_mock.call_args.args[1])

        # -- cycle found: PATCH targets the OWNING plan's cycle sub-resource.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-cycle-found"):
                module = _load_client_module(client)
                plan = {"planId": 6, "cr": "CR-CRU-054",
                        "cycles": [{"id": 160, "label": "C4"}]}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_open_plans", return_value=[plan]), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(
                            module, "_patch",
                            return_value={"ok": True}) as patch_mock, \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module._cycle_transition(
                        _make_args(project_dir=self.tmpdir, cycle_id=160), "done")
                self.assertEqual(rc, 0)
                path, payload = patch_mock.call_args.args
                self.assertEqual(path, "/api/v2/projects/pk/plans/6/cycles/160")
                self.assertEqual(payload, {"status": "done", "agentId": "A1"})
                self.assertEqual(emit_mock.call_args.args[0], "cycle-done")


# ---------------------------------------------------------------------------
# PARAMETERISED -- cmd_dashboard (DN §2).
# ---------------------------------------------------------------------------


class DashboardParameterisedLiftTest(unittest.TestCase):
    """`cmd_dashboard` hand-builds the `argparse.Namespace(...)` it forwards
    to `cmd_status`; mvn's own `cmd_status` needs an extra `maven_dir=None`
    field (its module-dir convention) that the other four omit -- DN §2's
    PARAMETERISED case, confirmed by reading all five bodies."""

    def test_dashboard_namespace_construction_moves_out_of_every_client_and_still_works(self):
        marker = "argparse.Namespace("
        offenders = _clients_with_marker_in_function("cmd_dashboard", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still hand-build the cmd_status "
            f"Namespace inline in cmd_dashboard instead of delegating the "
            f"(parameterised) construction to clients/_crucible_axi.py: "
            f"{offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own the parameterised "
            "cmd_status-Namespace construction after the §S2 lift -- not "
            "present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                captured = {}

                def fake_cmd_status(ns, _captured=captured):
                    _captured["ns"] = ns
                    return 0

                with mock.patch.object(module, "cmd_status", side_effect=fake_cmd_status):
                    rc = module.cmd_dashboard()
                self.assertEqual(rc, 0)
                ns = captured["ns"]
                self.assertIsNone(ns.project_dir)
                self.assertIsNone(ns.fields)
                if client == "mvn":
                    self.assertTrue(
                        hasattr(ns, "maven_dir") and ns.maven_dir is None,
                        f"mvn-crucible.py's cmd_dashboard must still pass "
                        f"maven_dir=None (its own cmd_status's extra field) "
                        f"after the parameterised lift")
                else:
                    self.assertFalse(
                        hasattr(ns, "maven_dir"),
                        f"{client}-crucible.py's cmd_dashboard must NOT gain "
                        f"mvn's maven_dir field -- the lift is parameterised "
                        f"PER CLIENT, not a fleet-wide field addition")


# ---------------------------------------------------------------------------
# DRIFTED §S2b correction #1 -- cmd_milestone's legacy line to STDERR.
# ---------------------------------------------------------------------------


class MilestoneStderrDriftCorrectionTest(unittest.TestCase, _ProjectDirFixture):
    """DN §4 finding #1 / CR-CRU-054 §S2b: bun's `cmd_milestone` writes its
    legacy line to STDOUT (no `file=sys.stderr`); rust/mvn/python/arduino are
    already correct. The lift must give ALL FIVE clients the correct
    (stderr) behaviour -- bun is the ONLY one this test can fail against
    today."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_milestone_legacy_line_goes_to_stderr_not_stdout(self):
        """CR-CRU-054 §S2b (C5) lifted cmd_milestone into
        `_crucible_axi.cmd_milestone` -- the ONE locus that now owns the
        `file=sys.stderr` legacy print -- and every client is a thin
        delegator, so the marker no longer lives in any client's OWN
        top-level `cmd_milestone` body. Re-pointed to the fleet's established
        "moved out of every client and still works" shape (matches
        `VerbSurfaceWriteVerbsSingleLocusTest` above): falsifiable both ways
        -- fails if any client reintroduces a private copy of the print, and
        fails if `_crucible_axi.py` itself stops owning the marker."""
        marker = "file=sys.stderr"
        offenders = _clients_with_marker_in_function("cmd_milestone", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry cmd_milestone's own "
            f"`file=sys.stderr` print in their own source instead of "
            f"delegating to clients/_crucible_axi.py (CR-CRU-054 §S2b "
            f"lift): {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            marker, axi_source,
            "clients/_crucible_axi.py must own cmd_milestone's "
            "stderr-redirected legacy print after the §S2b lift -- DN §4 "
            "finding #1's correction must live in the fleet's single locus")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_post_milestone",
                            return_value={"ok": True}), \
                        contextlib.redirect_stdout(io.StringIO()) as out, \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    rc = module.cmd_milestone(_make_args(
                        project_dir=self.tmpdir, cr="CR-CRU-054",
                        type="stage-flip", label="wave 4", commit=None))
                self.assertEqual(rc, 0)
                self.assertIn(
                    "milestone: ok=True", err.getvalue(),
                    f"{client}-crucible.py's cmd_milestone must print its "
                    f"legacy line to STDERR (§S2b corrected behaviour)")
                # CR-CRU-058 §S1 re-point (§S4 re-point discipline: never
                # silently -- named here). This test's original assertion
                # was `out.getvalue() == ""`; that was a valid PROXY for DN
                # §4 finding #1's actual intent ("the legacy prose line must
                # never reach stdout") only while cmd_milestone emitted
                # NOTHING there at all. CR-CRU-058 C2 gave the shared
                # cmd_milestone a real §S1 envelope on stdout (it was
                # previously envelope-less fleet-wide -- see
                # test_client_fleet_envelope_census.py's
                # test_milestone_confirmed_enveloped_fleet_wide), so a bare
                # emptiness check would now fail for the RIGHT reason and
                # hide the real, still-true finding behind an unrelated
                # failure. Re-pointed to assert BOTH halves explicitly,
                # keeping the guard strictly STRONGER than before rather
                # than weaker: (a) the prose line specifically never reaches
                # stdout -- the original finding, preserved; (b) stdout
                # parses as a clean TOON envelope alone -- the new
                # legitimate occupant of that channel.
                self.assertNotIn(
                    "milestone: ok=", out.getvalue(),
                    f"{client}-crucible.py's cmd_milestone must NOT write "
                    f"its legacy 'milestone: ok=...' prose line to STDOUT "
                    f"-- got {out.getvalue()!r} (this is DN §4 finding #1's "
                    f"exact defect: a caller parsing stdout as a machine "
                    f"channel gets a corrupted stream mixed with a prose "
                    f"line)")
                toon = module._toon()
                decoded = toon.decode(out.getvalue())
                self.assertIn(
                    "axi", decoded,
                    f"{client}-crucible.py's cmd_milestone stdout must "
                    f"parse as a clean TOON envelope alone (CR-CRU-058 §S1) "
                    f"-- got {out.getvalue()!r}")
                self.assertEqual(
                    decoded["axi"]["verb"], "milestone",
                    f"{client}-crucible.py's cmd_milestone envelope must "
                    f"carry verb='milestone', got {decoded['axi']!r}")
                self.assertTrue(
                    decoded["axi"]["ok"],
                    f"{client}-crucible.py's cmd_milestone envelope must "
                    f"show ok=True for this successful post, got "
                    f"{decoded['axi']!r}")


# ---------------------------------------------------------------------------
# DRIFTED §S2b correction #2 -- cmd_plan_file's context.cr on BOTH paths.
# ---------------------------------------------------------------------------


class PlanFileContextCrDriftCorrectionTest(unittest.TestCase, _ProjectDirFixture):
    """DN §4 finding #2 / CR-CRU-054 §S2b: `context.cr` must be populated on
    BOTH the plan-resolution-failure path and the success path, for ALL FIVE
    clients (today: bun omits it on both; rust/python omit it on the failure
    path only; mvn/arduino are already correct on both)."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_context_cr_present_on_failure_path(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(
                            module, "_post",
                            return_value={"ok": False, "error": "server down"}), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(module, "_axi_context") as ctx_mock, \
                        mock.patch.object(module, "_emit_axi"):
                    rc = module.cmd_plan_file(_make_args(
                        project_dir=self.tmpdir, cr="CR-CRU-054",
                        cycles="C1", title="a title", wave="wave-4"))
                self.assertEqual(rc, 1)
                ctx_mock.assert_called_once()
                self.assertEqual(
                    ctx_mock.call_args.kwargs.get("cr"), "CR-CRU-054",
                    f"{client}-crucible.py's cmd_plan_file must carry "
                    f"context.cr on the FAILURE path (§S2b correction; DN §4 "
                    f"finding #2) -- got kwargs={ctx_mock.call_args.kwargs!r}")

    def test_context_cr_present_on_success_path(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                resp = {"ok": True, "planId": 11, "cr": "CR-CRU-054",
                        "cycles": [{"label": "C1", "id": 160}]}
                with mock.patch.object(module, "_agent_id", return_value="A1"), \
                        mock.patch.object(module, "_post", return_value=resp), \
                        mock.patch.object(module, "_plans_path", return_value="/api/v2/projects/pk/plans"), \
                        mock.patch.object(module, "_axi_context") as ctx_mock, \
                        mock.patch.object(module, "_emit_axi"):
                    rc = module.cmd_plan_file(_make_args(
                        project_dir=self.tmpdir, cr="CR-CRU-054",
                        cycles="C1", title="a title", wave="wave-4"))
                self.assertEqual(rc, 0)
                ctx_mock.assert_called_once()
                self.assertEqual(
                    ctx_mock.call_args.kwargs.get("cr"), "CR-CRU-054",
                    f"{client}-crucible.py's cmd_plan_file must carry "
                    f"context.cr on the SUCCESS path -- got "
                    f"kwargs={ctx_mock.call_args.kwargs!r}")


# ---------------------------------------------------------------------------
# DRIFTED §S2b correction #3 -- cmd_register/cmd_unregister's --agent hard
# stop via the AXI runtime resolver, not argparse `required=True`.
# ---------------------------------------------------------------------------


class RegisterUnregisterAgentHardStopDriftCorrectionTest(unittest.TestCase, _ProjectDirFixture):
    """DN §4 finding #3 / CR-CRU-054 §S2b: bun/rust/mvn/python's `cmd_register`/
    `cmd_unregister` read `args.agent` directly (relying on argparse
    `required=True`, which raises a bare usage error + prints NOTHING to
    stdout when `--agent` is missing -- bypassing the fleet's own §S5 AXI
    hard-stop envelope every OTHER mutating verb gets). arduino already
    resolves the identity through `_agent_id(args)` (the ALREADY-DELEGATED
    `require_agent_id` hard stop). The lift must give ALL FIVE clients
    arduino's pattern."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_register_resolves_identity_through_agent_id_not_raw_args_agent(self):
        marker = "args.agent"
        offenders = _clients_with_marker_in_function("cmd_register", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients' cmd_register still reads `args.agent` "
            f"directly instead of resolving through `_agent_id(args)` (DN §4 "
            f"finding #3 -- arduino is already correct): {offenders!r}")

    def test_unregister_resolves_identity_through_agent_id_not_raw_args_agent(self):
        marker = "args.agent"
        offenders = _clients_with_marker_in_function("cmd_unregister", marker)
        self.assertEqual(
            offenders, [],
            f"the following clients' cmd_unregister still reads "
            f"`args.agent` directly instead of resolving through "
            f"`_agent_id(args)` (DN §4 finding #3 -- arduino is already "
            f"correct): {offenders!r}")

    def test_register_missing_agent_raises_before_any_post_when_called_directly(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(p, pl, _c=calls):
                    _c.append((p, pl))
                    return {"ok": True}

                # `_register_agent` (bun/python's delegator, when present)
                # itself calls the module's own `_post` -- mocking `_post`
                # alone is enough to observe whether ANY POST was attempted,
                # through either call shape.
                with mock.patch.object(module, "_post", side_effect=fake_post):
                    with self.assertRaises(module._axi().AgentIdentityRequired):
                        module.cmd_register(_make_args(
                            agent=None, project_dir=self.tmpdir, message=None,
                            display_name=None, source="claude-md",
                            role="RED", cycle=None))
                self.assertEqual(
                    calls, [],
                    f"{client}-crucible.py's cmd_register must hard-stop "
                    f"BEFORE any POST when --agent is missing, got {calls}")

    def test_unregister_missing_agent_raises_before_any_post_when_called_directly(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, pl, _c=calls: (_c.append((p, pl)), {"ok": True})[1]):
                    with self.assertRaises(module._axi().AgentIdentityRequired):
                        module.cmd_unregister(_make_args(
                            agent=None, project_dir=self.tmpdir))
                self.assertEqual(
                    calls, [],
                    f"{client}-crucible.py's cmd_unregister must hard-stop "
                    f"BEFORE any POST when --agent is missing, got {calls}")

    def test_register_cli_with_no_agent_hard_stops_through_the_axi_envelope(self):
        """The full-CLI proof (mirrors test_bun_crucible_agent_identity_required.py's
        `_run_main` idiom exactly): today, bun/rust/mvn/python's argparse
        `--agent required=True` on the `register` subparser raises SystemExit(2)
        DIRECTLY from `parse_args()`, before `cmd_register`/`run_verb` ever
        runs -- stdout is EMPTY, and the ok:false §S1 envelope never appears
        (DN §4 finding #3's exact defect). arduino's `--agent` is already
        optional at the CLI (its `common` parser), so its `register` already
        reaches `run_verb`'s hard stop and prints a decodable envelope."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, pl, _c=calls: (_c.append((p, pl)), {"ok": True})[1]):
                    code, out, err = _run_main(
                        module,
                        ["register", "--role", "RED",
                         "--project-dir", self.tmpdir])
                self.assertNotEqual(
                    code, 0,
                    f"{client}-crucible.py's `register` with no --agent must "
                    f"still exit non-zero")
                agent_posts = [c for c in calls if "agents/register" in c[0]]
                self.assertEqual(
                    agent_posts, [],
                    f"{client}-crucible.py's `register` with no --agent must "
                    f"POST nothing to the agents/register endpoint, got "
                    f"{agent_posts}")
                toon = module._toon()
                decoded = toon.decode(out)
                self.assertIn(
                    "axi", decoded,
                    f"{client}-crucible.py's `register` with no --agent must "
                    f"still produce a decodable §S1 envelope on stdout "
                    f"(§S2b correction -- today this is EMPTY for "
                    f"bun/rust/mvn/python because argparse's own "
                    f"required=True usage error fires first), got out={out!r}")
                self.assertFalse(decoded["axi"]["ok"])
                self.assertEqual(decoded["axi"]["verb"], "register")

    def test_unregister_cli_with_no_agent_hard_stops_through_the_axi_envelope(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, pl, _c=calls: (_c.append((p, pl)), {"ok": True})[1]):
                    code, out, err = _run_main(
                        module, ["unregister", "--project-dir", self.tmpdir])
                self.assertNotEqual(code, 0)
                agent_posts = [c for c in calls if "agents/unregister" in c[0]]
                self.assertEqual(agent_posts, [])
                toon = module._toon()
                decoded = toon.decode(out)
                self.assertIn("axi", decoded,
                              f"{client}-crucible.py's `unregister` with no "
                              f"--agent must produce a decodable §S1 "
                              f"envelope on stdout, got out={out!r}")
                self.assertFalse(decoded["axi"]["ok"])
                self.assertEqual(decoded["axi"]["verb"], "unregister")


# ---------------------------------------------------------------------------
# DRIFTED §S2b correction #4 -- _remove_agent_silent / _close_gate_identity:
# the exception guard AND honest reporting, combined.
# ---------------------------------------------------------------------------


class RemoveAgentSilentCloseGateIdentityCombinedCorrectionTest(unittest.TestCase):
    """DN §4 finding #6 / CR-CRU-054 §S2b: "no single client has this fully
    right... combine both: catch the exception (rust/mvn/python/arduino's
    fix) AND still capture and report whether the call actually succeeded...
    reports 'attempted, outcome unknown' only on a genuine transport failure,
    never a blanket 'removed.'" Pinned to exactly that combination."""

    def test_remove_agent_silent_never_raises_on_transport_failure(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(
                            module, "_post",
                            side_effect=OSError("connection reset")):
                    try:
                        result = module._remove_agent_silent("/fake/dir", "A1")
                    except OSError:
                        self.fail(
                            f"{client}-crucible.py's _remove_agent_silent "
                            f"must never raise (DN §4 finding #6 -- bun's "
                            f"missing exception guard is the known defect)")
                self.assertIsNone(
                    result,
                    f"{client}-crucible.py's _remove_agent_silent must "
                    f"return a falsy/unknown-outcome sentinel (None) when "
                    f"the POST itself raises -- caller cannot claim success, "
                    f"got {result!r}")

    def test_remove_agent_silent_still_reports_the_real_outcome_when_reachable(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(
                            module, "_post",
                            return_value={"ok": False, "error": "not found"}):
                    result = module._remove_agent_silent("/fake/dir", "A1")
                self.assertEqual(
                    result, {"ok": False, "error": "not found"},
                    f"{client}-crucible.py's _remove_agent_silent must still "
                    f"return the REAL response when the POST is reachable "
                    f"(DN §4 finding #6 -- rust/mvn/python/arduino's current "
                    f"discard-the-result behaviour loses this), got "
                    f"{result!r}")

    def test_close_gate_identity_reports_the_real_ok_value_not_a_blanket_removed(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                identity = module._axi().GatedRunIdentity("A1")
                identity.created_here = True
                self.assertTrue(identity.should_remove)
                with mock.patch.object(
                        module, "_remove_agent_silent",
                        return_value={"ok": False}), \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    module._close_gate_identity("/fake/dir", identity)
                self.assertIn(
                    "ok=False", err.getvalue(),
                    f"{client}-crucible.py's _close_gate_identity must "
                    f"report the ACTUAL ok=False outcome, never claim "
                    f"'removed' unconditionally (DN §4 finding #6) -- got "
                    f"{err.getvalue()!r}")
                self.assertNotIn(
                    "removed (created by this run)", err.getvalue(),
                    f"{client}-crucible.py's _close_gate_identity must not "
                    f"print the fixed 'removed' message when the actual "
                    f"outcome was ok=False, got {err.getvalue()!r}")

    def test_close_gate_identity_reports_outcome_unknown_never_removed_on_exception(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                identity = module._axi().GatedRunIdentity("A1")
                identity.created_here = True
                with mock.patch.object(
                        module, "_remove_agent_silent", return_value=None), \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    module._close_gate_identity("/fake/dir", identity)
                self.assertNotIn(
                    "removed (created by this run)", err.getvalue(),
                    f"{client}-crucible.py's _close_gate_identity must NEVER "
                    f"claim 'removed' when the removal's outcome is unknown "
                    f"(a swallowed transport failure) -- this is DN §4 "
                    f"finding #6's exact defect (rust/mvn/python/arduino "
                    f"today print 'removed' unconditionally), got "
                    f"{err.getvalue()!r}")
                self.assertIn(
                    "unknown", err.getvalue(),
                    f"{client}-crucible.py's _close_gate_identity must "
                    f"report the outcome as unknown when the removal "
                    f"attempt's result is unavailable, got {err.getvalue()!r}")


# ---------------------------------------------------------------------------
# DRIFTED §S2b corrections #4 + #5 -- the identity `source` ON THE WIRE.
#
# C5 corrected `openclaw` -> `claude-md` fleet-wide, but the only proofs were
# source-text/AST scans (test_cr054_fleet_inventory.py). A scan cannot show
# what the SERVER receives -- which is the entire point of the correction. The
# class below invokes each payload-building path for real with that client's
# own `_post` mocked and asserts the ACTUAL outgoing body, so reverting the
# shared default (or reintroducing a per-client override) fails here even if
# someone teaches the scans to look elsewhere.
# ---------------------------------------------------------------------------


# The documented enum a client's identity.source must belong to (the same set
# test_cr054_fleet_inventory.py's IdentitySourceEnumGuardTest guards statically).
IDENTITY_SOURCE_ENUM = {"claude-md", "package-json", "git-repo", "manual"}
FLEET_IDENTITY_SOURCE = "claude-md"
# The pre-correction value (DN §4 findings #4/#5): outside the enum, and only
# ever survived because the server does not validate the field.
RETIRED_IDENTITY_SOURCE = "openclaw"


def _identity_payload_sites(path):
    """Every function in `path` -- top-level or method -- that BUILDS a dict
    literal carrying an `"identity"` key, i.e. every place an `identity.source`
    can reach the wire from. Used to prove the behavioural coverage below is
    EXHAUSTIVE: a new payload-building site anywhere in the fleet fails the
    completeness test rather than slipping in unexercised."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    sites = set()

    def visit(node, enclosing):
        for child in ast.iter_child_nodes(node):
            name = enclosing
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = child.name
            elif isinstance(child, ast.Dict):
                for key in child.keys:
                    if isinstance(key, ast.Constant) and key.value == "identity":
                        sites.add(enclosing)
            visit(child, name)

    visit(tree, None)
    sites.discard(None)
    return sites


# Every identity-payload-building site in the fleet, mapped to the test method
# below that drives it FOR REAL. Keep in step with the sweep above.
#   * `_crucible_axi.GatedRunIdentity.open_payload` -- driven through each
#     client's `_open_gate_identity` (test_gate_run_identity_open_...).
#   * `_crucible_axi.cmd_register`'s own inline payload -- rust/mvn/arduino's
#     register path (test_register_* below).
#   * bun/python's `_register_agent` -- the same three tests, via the
#     `register_fn` parameter their `cmd_register` passes.
#   * mvn's `_narrate_heartbeat` -- test_narration_heartbeat_... below (the
#     site VERIFY flagged: hardcoded, and never covered by a RED test).
COVERED_IDENTITY_PAYLOAD_SITES = {
    "_crucible_axi": {"open_payload", "cmd_register"},
    "bun": {"_register_agent"},
    "rust": set(),
    "mvn": {"_narrate_heartbeat"},
    "python": {"_register_agent"},
    "arduino": set(),
}


class IdentitySourceOnTheWireDriftCorrectionTest(unittest.TestCase, _ProjectDirFixture):
    """DN §4 findings #4 + #5 / CR-CRU-054 §S2b: `identity.source` must leave
    every client as the documented-enum `claude-md`, never the retired
    `openclaw`. Behavioural throughout -- each test invokes real code with the
    client's own `_post` mocked and inspects the payload that WOULD have gone
    to the server."""

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    @staticmethod
    def _recording_post(calls, resp=None):
        def fake_post(path, payload, _c=calls):
            _c.append((path, payload))
            return {"ok": True} if resp is None else resp
        return fake_post

    def _assert_wire_source(self, client, path, payload, expected, where):
        self.assertIn(
            "identity", payload,
            f"{client}-crucible.py's {where} must send an `identity` block "
            f"(POST {path}), got {payload!r}")
        actual = payload["identity"].get("source")
        self.assertEqual(
            actual, expected,
            f"{client}-crucible.py's {where} must put source={expected!r} on "
            f"the wire (DN §4 findings #4/#5 -- the correction exists for what "
            f"the SERVER receives, not for what the source text says), got "
            f"{actual!r} in {payload!r}")
        self.assertIn(
            actual, IDENTITY_SOURCE_ENUM,
            f"{client}-crucible.py's {where} sent an identity.source outside "
            f"the documented enum {sorted(IDENTITY_SOURCE_ENUM)!r}: {actual!r}")
        self.assertNotIn(
            RETIRED_IDENTITY_SOURCE, repr(payload),
            f"{client}-crucible.py's {where} must not carry the retired "
            f"{RETIRED_IDENTITY_SOURCE!r} label anywhere in its outgoing body, "
            f"got {payload!r}")

    def _register_posts(self, calls):
        """Only the agent-register/heartbeat POSTs -- arduino's `pre_register`
        project bootstrap also goes through `_post`."""
        return [c for c in calls
                if "agents/register" in c[0] or "agents/heartbeat" in c[0]]

    def test_gate_run_identity_open_sends_claude_md_on_the_wire(self):
        """`_open_gate_identity` -> `GatedRunIdentity.open_payload`: the site
        DN §4 finding #4 named (mvn used to override it to `openclaw`). Driven
        through each client's own delegator, so a reintroduced per-client
        override fails here too."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(module, "_post",
                                       side_effect=self._recording_post(calls)):
                    module._open_gate_identity(
                        self.tmpdir, "A1", None, "gated run starting")
                heartbeats = [c for c in calls if "agents/heartbeat" in c[0]]
                self.assertEqual(
                    len(heartbeats), 1,
                    f"{client}-crucible.py's _open_gate_identity must post "
                    f"exactly one role-optional heartbeat, got {calls!r}")
                path, payload = heartbeats[0]
                self._assert_wire_source(client, path, payload,
                                         FLEET_IDENTITY_SOURCE,
                                         "_open_gate_identity")

    def test_register_cli_sends_claude_md_identity_source_on_the_wire(self):
        """The full-CLI proof: real argparse dispatch through `main()`, so the
        subparser's own `--source` default is part of what is being asserted."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(module, "_post",
                                       side_effect=self._recording_post(calls)):
                    code, out, err = _run_main(
                        module,
                        ["register", "--agent", "A1", "--role", "RED",
                         "--project-dir", self.tmpdir])
                self.assertEqual(
                    code, 0,
                    f"{client}-crucible.py's `register` must succeed against "
                    f"an ok:true server, got code={code} out={out!r} err={err!r}")
                posts = self._register_posts(calls)
                self.assertEqual(
                    len(posts), 1,
                    f"{client}-crucible.py's `register` must post exactly one "
                    f"agent registration, got {posts!r}")
                path, payload = posts[0]
                self._assert_wire_source(client, path, payload,
                                         FLEET_IDENTITY_SOURCE,
                                         "`register` CLI")

    def test_register_without_a_source_arg_still_sends_the_fleet_default(self):
        """The shared `DEFAULT_IDENTITY_SOURCE` fallback, reached by calling
        `cmd_register` with a Namespace that carries NO `source` at all (the
        `getattr(args, "source", None) or DEFAULT_IDENTITY_SOURCE` branch the
        CLI default hides). This is the assertion that dies if the shared
        default is reverted."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(module, "_post",
                                       side_effect=self._recording_post(calls)), \
                        contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    module.cmd_register(_make_args(
                        agent="A1", project_dir=self.tmpdir, message=None,
                        display_name=None, role="RED", cycle=None))
                posts = self._register_posts(calls)
                self.assertEqual(
                    len(posts), 1,
                    f"{client}-crucible.py's cmd_register must post exactly "
                    f"one agent registration, got {posts!r}")
                path, payload = posts[0]
                self._assert_wire_source(client, path, payload,
                                         FLEET_IDENTITY_SOURCE,
                                         "cmd_register with no --source")

    def test_register_honours_an_explicit_source_override_on_the_wire(self):
        """The other half of finding #5's "configurable `--source` with a
        fleet-wide default, never a hardcoded value": a caller-supplied source
        must actually REACH the wire. Without this, the claude-md assertions
        above would pass equally well against a re-hardcoded literal."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []
                with mock.patch.object(module, "_post",
                                       side_effect=self._recording_post(calls)):
                    code, out, err = _run_main(
                        module,
                        ["register", "--agent", "A1", "--role", "RED",
                         "--source", "git-repo",
                         "--project-dir", self.tmpdir])
                self.assertEqual(code, 0, f"out={out!r} err={err!r}")
                posts = self._register_posts(calls)
                self.assertEqual(len(posts), 1, f"got {posts!r}")
                path, payload = posts[0]
                self._assert_wire_source(client, path, payload, "git-repo",
                                         "`register --source git-repo` CLI")

    def test_narration_heartbeat_sends_claude_md_on_the_wire(self):
        """mvn's `_narrate_heartbeat` -- the hardcoded payload site VERIFY
        flagged as never covered by a RED test (it is the exact function whose
        `openclaw` literal DN §4 recorded). Written fleet-wide so any client
        that grows a narration heartbeat is covered on arrival; the
        non-vacuity assertion below keeps the loop honest."""
        exercised = []
        for client in CLIENTS:
            module = _load_client_module(client)
            narrate = getattr(module, "_narrate_heartbeat", None)
            if narrate is None:
                continue
            with self.subTest(client=client):
                exercised.append(client)
                calls = []
                with mock.patch.object(module, "_post",
                                       side_effect=self._recording_post(calls)):
                    narrate(self.tmpdir, "A1", "running class 3/10")
                heartbeats = [c for c in calls if "agents/heartbeat" in c[0]]
                self.assertEqual(
                    len(heartbeats), 1,
                    f"{client}-crucible.py's _narrate_heartbeat must post one "
                    f"role-optional heartbeat, got {calls!r}")
                path, payload = heartbeats[0]
                self._assert_wire_source(client, path, payload,
                                         FLEET_IDENTITY_SOURCE,
                                         "_narrate_heartbeat")
        self.assertIn(
            "mvn", exercised,
            "mvn-crucible.py must still define _narrate_heartbeat -- it is the "
            "site DN §4 recorded the `openclaw` literal at; a loop that "
            "exercises nothing would make this test vacuous")

    def test_every_identity_payload_building_site_is_behaviourally_covered(self):
        """Completeness: the sweep of dict literals carrying an `"identity"`
        key must match exactly the set of sites the tests above drive. A NEW
        payload-building site fails here instead of shipping with only the
        static scans behind it -- the precise gap this class closes."""
        found = {"_crucible_axi": _identity_payload_sites(AXI_MODULE_PATH)}
        for client, path in CLIENT_FILES.items():
            found[client] = _identity_payload_sites(path)
        self.assertEqual(
            found, COVERED_IDENTITY_PAYLOAD_SITES,
            "the fleet's identity-payload-building sites no longer match the "
            "set exercised behaviourally by this class -- add a behavioural "
            "test for the new/moved site (and update "
            "COVERED_IDENTITY_PAYLOAD_SITES) rather than relying on the "
            "source-text scans in test_cr054_fleet_inventory.py")


# ---------------------------------------------------------------------------
# CR-CRU-084 §S1 -- the `--packages` flag, on all FIVE clients at once.
#
# WHY HERE. The `milestone` subparser is duplicated per client (arduino:1104,
# bun:1978, mvn:1959, python:1434, rust:2495), each with its OWN
# --released-at/--crs/--repair-provenance definitions, while `cmd_milestone`
# and `post_milestone` are shared. CR-CRU-080 added those three flags to all
# five and NO test anywhere pinned that they are all five: `grep -rn
# released_at tests/client` finds nothing (measured 2026-08-23). So a new
# release flag added to one client is invisible drift -- precisely what
# CR-CRU-075 exists to fix.
#
# This module is the fleet's VERB-SURFACE suite: it already loads all five
# clients, drives them through the REAL argparse entry point, and owns the one
# existing fleet-wide FLAG contract (`_add_gate_cycle_arg`'s --cycle, above).
# A per-client flag census therefore belongs next to it, not in a CR-084-named
# file that nobody re-reads when the sixth client is written.
#
# THE ARGUMENT FORMAT PINNED BELOW, and why:
#
#   --packages "pypi:crucible-axi:0.4.0,npm:@anthill-tec/crucible-server:0.4.0"
#
# ONE flag carrying a DELIMITED string, exactly as `--crs` does -- not a
# repeatable `--package`. That is the fleet's existing style for a computed
# multi-value provenance field, and it is what `emit_release_milestone`'s
# `provenance+=(--crs "$crs")` shape already builds: one array append, one
# `shown` concatenation, no loop.
#
# Entries are separated by `,` (as `--crs` separates CR ids); the three fields
# of an entry by `:`. That choice is what makes the round trip LOSSLESS for the
# real coordinates: `@anthill-tec/crucible-server` contains `@` and `/` -- both
# ordinary characters here -- and neither a PyPI name (`crucible-axi`), an npm
# name, nor a SemVer version may contain `:` or `,`, so splitting can never
# straddle a field. A `,`-only scheme could not express three fields; a `/`
# scheme would split the npm scope in half.
#
# Absent vs empty, mirroring `crs` (CR-CRU-084 §S3/AC4): the flag ABSENT means
# "this ceremony says nothing about packages" -> the key never reaches the
# wire; `--packages ""` means "this release declared NONE" -> an explicit empty
# list on the wire. Without the second, AC4's meaningful-empty state is not
# reachable from any client at all.
#
# RED expectation (measured 2026-08-23): no client declares --packages, so
# argparse exits 2 with "unrecognized arguments: --packages ..." for all five,
# and no client's `_post_milestone` accepts a `packages` kwarg (TypeError).
# ---------------------------------------------------------------------------


PYPI_PACKAGE = "crucible-axi"
NPM_PACKAGE = "@anthill-tec/crucible-server"


def _packages_flag_value(version):
    """The `--packages` string the ceremony hands a client for `version`."""
    return f"pypi:{PYPI_PACKAGE}:{version},npm:{NPM_PACKAGE}:{version}"


def _packages_payload(version):
    """The parsed form that same string must reach the wire as."""
    return [
        {"registry": "pypi", "name": PYPI_PACKAGE, "version": version},
        {"registry": "npm", "name": NPM_PACKAGE, "version": version},
    ]


class MilestonePackagesFlagFleetParityTest(unittest.TestCase, _ProjectDirFixture):
    """CR-CRU-084 §S1 -- `--packages` must exist, with the same dest and the
    same parsed shape, on ALL FIVE clients' `milestone` subparser, and the
    per-client `_post_milestone` wrapper must relay it to the shared builder.

    Behavioural, not a source grep: every assertion goes through the REAL
    argparse dispatch (`module.main()` with sys.argv patched), so it pins what
    an operator can actually type rather than what a line of source looks
    like."""

    VERSION = "0.4.0"
    COMMIT = "abc1234def5678abc1234def5678abc1234def56"

    def setUp(self):
        self.tmpdir = self._make_project_dir()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _argv(self, extra):
        return ["milestone", "--type", "release", "--label", self.VERSION,
                "--commit", self.COMMIT, "--agent", "release-ceremony-1",
                "--project-dir", self.tmpdir] + extra

    def _drive(self, module, extra):
        """Run the milestone verb with `_post` recorded, returning the single
        /api/v2/milestones payload."""
        calls = []

        def fake_post(path, payload, _calls=calls):
            _calls.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        with mock.patch.object(module, "_post", side_effect=fake_post):
            code, out, err = _run_main(module, self._argv(extra))
        return code, out, err, [p for path, p in calls
                                if path == "/api/v2/milestones"]

    def test_packages_flag_exists_with_the_same_shape_on_every_client(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                code, out, err = self._drive(
                    module, ["--packages", _packages_flag_value(self.VERSION)])[:3]
                # The flag must be RECOGNISED before anything else is meaningful:
                # argparse's own "unrecognized arguments" exit is the RED today.
                self.assertNotIn(
                    "unrecognized arguments", out + err,
                    f"{client}-crucible.py's milestone subparser must declare "
                    f"--packages -- the flag is defined per client (five "
                    f"copies), so adding it to one is the drift CR-CRU-075 "
                    f"exists to fix: {(out + err)!r}")
                self.assertEqual(
                    code, 0,
                    f"{client}: milestone --packages must succeed against a "
                    f"mocked transport; stdout={out!r} stderr={err!r}")

    def test_packages_reaches_the_wire_parsed_and_lossless_on_every_client(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                _code, out, err, posts = self._drive(
                    module, ["--packages", _packages_flag_value(self.VERSION)])
                self.assertEqual(
                    len(posts), 1,
                    f"{client}: expected exactly ONE milestone POST; "
                    f"stdout={out!r} stderr={err!r}")
                self.assertEqual(
                    posts[0].get("packages"), _packages_payload(self.VERSION),
                    f"{client}: --packages must reach the wire as one entry "
                    f"per artifact, each naming registry/name/version, in the "
                    f"order declared")
                # LOSSLESS: the npm scope survives the split byte for byte --
                # `@` and `/` are ordinary characters in this format, and the
                # delimiters (`,` and `:`) appear in no field.
                self.assertEqual(
                    posts[0]["packages"][1]["name"], NPM_PACKAGE,
                    f"{client}: the scoped npm name must round-trip exactly")

    def test_packages_absent_omits_the_key_and_empty_sends_an_empty_list(self):
        """CR-CRU-084 §S3/AC4 -- "declared none" and "said nothing" are two
        different facts, and both must be expressible from the CLI or the
        empty state AC4 makes meaningful is unreachable. Mirrors exactly how
        `crs` already distinguishes them on the wire."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)

                _c, out, err, absent = self._drive(module, [])
                self.assertEqual(len(absent), 1, f"{client}: {out!r} {err!r}")
                self.assertNotIn(
                    "packages", absent[0],
                    f"{client}: a milestone posted WITHOUT --packages must "
                    f"omit the key entirely -- never an invented empty list, "
                    f"which AC4 gives a different meaning")

                _c2, out2, err2, empty = self._drive(module, ["--packages", ""])
                self.assertNotIn("unrecognized arguments", out2 + err2)
                self.assertEqual(len(empty), 1, f"{client}: {out2!r} {err2!r}")
                self.assertEqual(
                    empty[0].get("packages"), [],
                    f"{client}: --packages \"\" must send an EXPLICIT empty "
                    f"list -- the release declared none (§S3), which is not "
                    f"the same as saying nothing")

    def test_post_milestone_relays_packages_in_every_client(self):
        """The per-client `_post_milestone` wrapper is a hand-written kwarg
        list (bun:1613-1624 and its four siblings), so `packages` has to be
        added to five signatures, not one. A client that keeps the flag but
        drops the kwarg would silently post a release with no packages."""
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, payload))
                    return {"ok": True}

                with mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(module, "_post", side_effect=fake_post):
                    module._post_milestone(
                        "/fake/dir", "A1", "release",
                        label=self.VERSION, commit=self.COMMIT,
                        packages=_packages_payload(self.VERSION))
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/milestones")
                self.assertEqual(
                    payload.get("packages"), _packages_payload(self.VERSION),
                    f"{client}-crucible.py's _post_milestone must relay a "
                    f"`packages` kwarg to the shared builder verbatim")



if __name__ == "__main__":
    unittest.main()
