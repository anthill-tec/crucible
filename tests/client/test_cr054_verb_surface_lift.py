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

  EXPLICITLY NOT PINNED, flagged for the orchestrator (matches the dispatch
  brief's own instruction not to choose):
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

    def _make_project_dir(self):
        tmpdir = tempfile.mkdtemp(prefix="cr054-c4-verb-surface-")
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=cr054-c4-key\n")
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
                    rc = module.cmd_status(_make_args(project_dir="/fake/dir"))
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
                    rc = module.cmd_status(_make_args(project_dir="/fake/dir"))
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
                        mock.patch.object(module, "_project_key", return_value="pk"), \
                        mock.patch.object(module, "_post", side_effect=fake_post), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    rc = module.cmd_stop(_make_args(project_dir="/fake/dir"))
                self.assertEqual(rc, 0)
                self.assertEqual(len(calls), 1)
                path, payload = calls[0]
                self.assertEqual(path, "/api/v2/projects/pk/stop")
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
                    rc = module.cmd_checkpoint(_make_args(project_dir="/fake/dir", cr=None))
                self.assertEqual(rc, 0)
                resolve_mock.assert_called_once_with(
                    "checkpoint", "/fake/dir", None, mock.ANY, open_only=True)
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
                        project_dir="/fake/dir", cr=None, user_approved=False))
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
                        project_dir="/fake/dir", cr=None, label="C5"))
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
                        project_dir="/fake/dir", cr=None, commit="abc123"))
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
                        project_dir="/fake/dir", cr=None, commit="abc123"))
                self.assertEqual(rc, 0)
                patch_path, patch_payload = patch_mock.call_args.args
                self.assertEqual(patch_path, "/api/v2/projects/pk/plans/3")
                self.assertEqual(
                    patch_payload,
                    {"status": "closed", "merge": {"commit": "abc123"},
                     "agentId": "A1"})
                self.assertTrue(emit_mock.call_args.args[1])
                ms_mock.assert_called_once_with(
                    "/fake/dir", "A1", "cr-merged", label="CR-CRU-054",
                    commit="abc123", context=mock.ANY)


# ---------------------------------------------------------------------------
# NEEDS-LIFT -- gate + milestone POST helpers, the gate-run/gate-report verbs,
# and the shared `--cycle` argparse binding.
# ---------------------------------------------------------------------------


class GateAndMilestoneHelpersSingleLocusTest(unittest.TestCase):
    """`_post_gate`, `_post_milestone`, `_add_gate_cycle_arg`, `cmd_gate_report`
    and `cmd_gate_run` are byte-identical across all five clients today
    (confirmed by reading every body -- only bun's private
    `_PREFER_GATE_RUN_WARNING`/`_HELP_STEPS` dict access and arduino's
    `_project_dir(args)` differ, matching DN §1's own note)."""

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
                        project_dir="/fake/dir", outcome="passed",
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
                        project_dir="/fake/dir", outcome="passed",
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
                        project_dir="/fake/dir", intent="verify"))
                self.assertEqual(
                    rc, 1,
                    f"{client}-crucible.py's cmd_gate_run must still refuse "
                    f"(non-zero) when `no-mistakes` is not on PATH, after "
                    f"delegating")


# ---------------------------------------------------------------------------
# NEEDS-LIFT -- the cycle-transition orchestration behind cmd_cycle_activate /
# cmd_cycle_done (both already thin dispatchers -- see module docstring).
# ---------------------------------------------------------------------------


class CycleTransitionSingleLocusTest(unittest.TestCase):
    """`_cycle_transition`'s real plan-scan + PATCH orchestration is
    byte-identical across all five clients today. `cmd_cycle_activate`/
    `cmd_cycle_done` are already-trivial 1-line dispatchers to this name (no
    test for either -- see module docstring) whose bodies will not change
    even after this lift."""

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
                        _make_args(project_dir="/fake/dir", cycle_id=999), "active")
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
                        _make_args(project_dir="/fake/dir", cycle_id=160), "done")
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
        marker = "file=sys.stderr"
        offenders = [c for c in CLIENTS
                     if marker not in (_function_source_segment(
                         CLIENT_FILES[c], "cmd_milestone") or "")]
        self.assertEqual(
            offenders, [],
            f"the following clients' cmd_milestone omits `file=sys.stderr` "
            f"on its legacy print -- DN §4 finding #1 (bun is the known "
            f"drift; the fix must land here): {offenders!r}")

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
                self.assertEqual(
                    out.getvalue(), "",
                    f"{client}-crucible.py's cmd_milestone must NOT write "
                    f"its legacy line to STDOUT -- got {out.getvalue()!r} "
                    f"(this is DN §4 finding #1's exact defect: a caller "
                    f"parsing stdout as a machine channel gets a corrupted "
                    f"stream mixed with a prose line)")


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
                            phase="RED", cycle=None))
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
                        ["register", "--phase", "RED",
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


if __name__ == "__main__":
    unittest.main()
