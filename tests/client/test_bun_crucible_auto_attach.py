"""CR-CRU-030 C1 — §S9 auto-attach ingests to the ACTIVE cycle (no
hand-passed `WORKFLOW_CYCLE_ID`), scoped to `clients/bun-crucible.py` (the
reference client for this slice; the other four clients land in a later
CR-CRU-030 slice per the gap-analysis build sequence).

Contract pinned VERBATIM from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md §S9:
    "The ingest verbs (test/regression/auto-ingest) resolve the cycle to
    attach to FROM THE SERVER, not solely from the WORKFLOW_CYCLE_ID env var.
    When the env var is unset, the client resolves the open plan ... then
    reads its cycles via the existing GET /api/v2/projects/<key>/plans, then
    attaches the run to the plan's single status:"active" cycle ... No
    active cycle (all cycles terminal, or none activated -> the query yields
    none) is a HARD ERROR on register/ingest ("no active cycle - activate
    one first"), never a silent orphan ... An explicit WORKFLOW_CYCLE_ID
    still overrides the auto-resolution."

RED phase: today `_cycle_id_and_warnings` (bun-crucible.py ~L1129) only ever
reads WORKFLOW_CYCLE_ID from env; when unset it emits a soft `no-cycle-id`
WARNING and proceeds with an explicit-null cycleId (confirmed by reading the
source) -- it never attaches from the active cycle, and never hard-errors.
Every test below exercises behavior that does not exist yet: real
behavioral RED, not a missing-symbol accident.

Per project convention (see test_bun_crucible_toon_envelope.py /
test_bun_crucible_lifecycle.py): the live Crucible server on :3849 is NEVER
touched by this suite -- every sibling client test file in this directory
mocks the module's `_post`/`_get`/`_patch` HTTP transport seam instead
(explicitly to avoid dogfood-project pollution), and `bun test` itself is
replaced by a tiny fake executable (`--bun`) that copies a fixture JUnit XML
to `--reporter-outfile=`. This file follows the identical technique, reusing
the SAME open-plan/cycle GET-response fixture shape the sibling
`NoCycleIdWarningTest`/`IngestEnvelopeTest` classes already use.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_auto_attach.py -q
Fallback:
    python3 tests/client/test_bun_crucible_auto_attach.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

PASS_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="toon.test.ts" tests="1" failures="0">
<testcase name="passes" time="0.001"></testcase>
</testsuite>
</testsuites>
"""

# A tiny fake `bun` executable -- ignores all args except `--reporter-outfile=`,
# to which it copies FAKE_BUN_JUNIT_CONTENT verbatim, then exits with
# FAKE_BUN_EXIT_CODE. Identical technique to test_bun_crucible_toon_envelope.py.
FAKE_BUN_SCRIPT_TEMPLATE = """#!{python}
import os
import sys

outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]

content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)

sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""


def _load_bun_crucible_module():
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_autoattach", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched to `argv`. Returns
    (exit_code, stdout, stderr). Only SystemExit is caught -- any OTHER
    exception propagates so unittest reports it as an ERROR (still a valid
    RED signal)."""
    full_argv = ["bun-crucible.py"] + argv
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


def _open_plans_response(plans):
    return {"ok": True, "plans": plans}


def _post_call_for_path(post_mock, path):
    """The first recorded `_post(path, payload)` call matching `path`
    exactly, as a `unittest.mock.call` object, or None. Needed because
    --agent ingest verbs also POST agent-heartbeat/unregister calls through
    the SAME mocked `_post` seam -- the ingest POST is not necessarily the
    only (or last) call recorded."""
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


class _BaseAutoAttachTest(unittest.TestCase):
    PROJECT_KEY = "test-key-auto-attach"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-autoattach-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o755)
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got stdout={stdout_text!r}")
        return decoded["axi"]

    def _run_test_verb(self, agent="CR-CRU-030-C1-autoattach-test"):
        return _run_main(self.module, [
            "test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
            "--package-dir", self.tmpdir, "--reports", "reports", "--agent", agent,
        ])

    def _run_regression_verb(self, agent="CR-CRU-030-C1-autoattach-regression"):
        return _run_main(self.module, [
            "regression", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
            "--package-dir", self.tmpdir, "--reports", "reports", "--agent", agent,
        ])

    def _write_auto_ingest_junit(self):
        reports_dir = os.path.join(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "junit.xml"), "w") as f:
            f.write(PASS_JUNIT_XML)

    def _run_auto_ingest_verb(self, agent="CR-CRU-030-C1-autoattach-auto"):
        self._write_auto_ingest_junit()
        return _run_main(self.module, [
            "auto-ingest", "--agent", agent, "--project-dir", self.tmpdir,
            "--package-dir", self.tmpdir, "--reports", "reports",
        ])


class ClientSourceGrepSweepTest(_BaseAutoAttachTest):
    """CR-CRU-056 §S3/§S3c — replaces the WORKFLOW_CYCLE_ID pin this class
    used to carry as part of AutoAttachToActiveCycleTest, plus adds the
    grep-sweep AC bullet: "resolve_attach_cycle and resolve_active_cycle_id
    are gone from clients/ ... and no server route selects a cycle the
    caller did not bind or explicitly send." """

    def test_source_never_reads_workflow_cycle_id_env_var(self):
        occurrences = SCRIPT_PATH.read_text().count("WORKFLOW_CYCLE_ID")
        self.assertEqual(
            occurrences, 0,
            f"bun-crucible.py must not reference WORKFLOW_CYCLE_ID anywhere "
            f"(CR-CRU-036 §S1 removes it -- the server's active cycle is the "
            f"single source of truth); found {occurrences} occurrence(s)",
        )

    def test_source_contains_no_client_side_cycle_resolver_references(self):
        text = SCRIPT_PATH.read_text()
        for banned in ("resolve_attach_cycle", "resolve_active_cycle_id"):
            self.assertNotIn(
                banned, text,
                f"bun-crucible.py must not reference {banned} -- CR-CRU-056 "
                f"§S3 deletes the client-side attach resolver entirely "
                f"(attachment is server-stamped from the register binding)")


class RegisterCycleBindingWireTest(_BaseAutoAttachTest):
    """CR-CRU-056 §S1/§S2/§S4 — `register --cycle <id>` rides the wire as
    `cycleId` verbatim; omitting it omits the key (never a fabricated
    default); a server refusal (409, unbound TDD phase / stale binding /
    unknown-pending-done cycle / closed plan) is surfaced faithfully
    (ok:false, the server's message, non-zero exit) -- this supersedes
    AutoAttachToActiveCycleTest's auto-attach pins, which exercised the now
    -deleted client-side plans lookup."""

    def test_register_cycle_flag_sends_cycleid_in_register_payload(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--phase", "RED", "--agent", "CR-CRU-056-bound",
                "--cycle", "149", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call, "register must actually POST")
        self.assertEqual(
            register_call[0][1].get("cycleId"), 149,
            "the --cycle flag must ride the register body as cycleId verbatim")

    def test_register_without_cycle_flag_omits_cycleid_key(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--phase", "report", "--agent", "CR-CRU-056-unbound",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call)
        self.assertNotIn(
            "cycleId", register_call[0][1],
            "no --cycle supplied -- the client must not fabricate a cycleId key")

    def test_register_409_refusal_envelope_surfaced_faithfully(self):
        server_message = "phase RED requires a cycle binding — register with --cycle <cycleId>"
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": server_message}) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--phase", "RED", "--agent", "CR-CRU-056-refused",
                "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0, "a 409 refusal must exit non-zero")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(
            axi.get("error"), server_message,
            "the server's refusal message must be passed through faithfully")
        self.assertIsNotNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))


class IngestNeverResolvesClientSideCycleTest(_BaseAutoAttachTest):
    """CR-CRU-056 §S3 — attachment is the SERVER's job now: `test`,
    `regression` and `auto-ingest` must never even attempt a plans lookup
    (`_get`) before ingesting, and the context they build/send must carry no
    cycleId key at all (a bound agent's run is stamped from its registered
    binding server-side)."""

    def test_test_verb_never_calls_get_and_sends_no_resolved_cycle(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get") as get_mock:
            code, out, _err = self._run_test_verb()
        self.assertEqual(code, 0, f"stdout={out!r}")
        get_mock.assert_not_called()
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertNotIn("cycleId", ingest_call[0][1].get("context", {}) or {})
        axi = self._decode_axi(out)
        self.assertNotIn("cycleId", axi.get("context", {}))

    def test_regression_verb_never_calls_get_and_sends_no_resolved_cycle(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get") as get_mock:
            code, out, _err = self._run_regression_verb()
        self.assertEqual(code, 0, f"stdout={out!r}")
        get_mock.assert_not_called()
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        self.assertNotIn("cycleId", ingest_call[0][1].get("context", {}) or {})

    def test_auto_ingest_verb_never_calls_get_and_sends_no_resolved_cycle(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get") as get_mock:
            code, out, _err = self._run_auto_ingest_verb()
        self.assertEqual(code, 0, f"stdout={out!r}")
        get_mock.assert_not_called()
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        self.assertNotIn("cycleId", ingest_call[0][1].get("context", {}) or {})


class RawCaptureInParsedPayloadTest(_BaseAutoAttachTest):
    """CR-CRU-038 §S2b -- `_run_logged` already captures the wrapped bun
    test runner's combined stdout+stderr (used today for §S2c
    failure-marrying, `_marry_failures(tree, result.stdout)`); that SAME
    captured output must ALSO flow into the /api/v2/runs/parsed payload as
    `raw` so a real ingested run carries real output for the run-detail
    raw-toggle to reveal. Fails today -- `_ingest_parsed` never builds a
    `raw` key, regardless of what `_run_logged` captured."""

    ACTIVE_CYCLE_ID = 910
    RAW_MARKER = "BUN_RAW_CAPTURE_MARKER_9182"

    FAKE_BUN_SCRIPT_WITH_STDOUT_TEMPLATE = """#!{python}
import os
import sys

outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]

content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)

print("{marker}")
sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""

    def setUp(self):
        super().setUp()
        with open(self.fake_bun, "w") as f:
            f.write(self.FAKE_BUN_SCRIPT_WITH_STDOUT_TEMPLATE.format(
                python=sys.executable, marker=self.RAW_MARKER))
        os.chmod(self.fake_bun, 0o755)

    def _active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": self.ACTIVE_CYCLE_ID, "status": "active"},
                        {"id": self.ACTIVE_CYCLE_ID - 1, "status": "done"}]},
        ])

    def test_test_verb_includes_captured_runner_output_as_raw_in_parsed_payload(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_test_verb()

        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertIn(
            self.RAW_MARKER, payload.get("raw") or "",
            f"the real captured bun-test runner output must flow into the "
            f"parsed ingest payload's `raw` field; got payload keys={sorted(payload)!r}",
        )


class BoundRegistrationServerStampedAttachTest(_BaseAutoAttachTest):
    """CR-CRU-056 §S1/§S2/§S3 smoke chain — supersedes NoActiveCycleHardErrorTest
    and RegisterHardErrorTest wholesale: the client-side plans lookup (and
    warn+withhold flow) those classes pinned no longer exists at all -- a
    bound TDD agent cannot hit "no active cycle" any more because
    REGISTRATION validates the binding up front (§S1), not the ingest.

    Drives bun-crucible.py's real CLI dispatch end-to-end (plan-file →
    cycle-activate → register --cycle → test-ingest) against a STATEFUL fake
    server modelling exactly the piece of the real server this CR changed
    (a plan's cycles, an agent's registered `boundCycleId`, and events
    stamped from that binding) -- the same real-flow-not-mocks technique
    test_bun_crucible_gates.py already uses in this directory (a `side_effect`
    function with real state, not a single canned `return_value`). The live
    :3849 server is never touched by this suite (project convention)."""

    def test_plan_activate_register_bound_ingest_chain_stamps_event_from_binding(self):
        state = {
            "plans": {
                "plan-1": {"planId": "plan-1", "cr": "CR-CRU-056", "status": "open",
                           "cycles": [{"id": 501, "status": "pending"}]},
            },
            "agents": {},
            "ingest_payloads": [],
            "events": [],
        }

        def fake_get(path):
            if path.endswith("/plans"):
                return {"ok": True, "plans": list(state["plans"].values())}
            return {"ok": False, "error": f"unhandled GET {path}"}

        def fake_patch(path, payload):
            for plan in state["plans"].values():
                for cycle in plan["cycles"]:
                    if path.endswith(f"/cycles/{cycle['id']}"):
                        cycle["status"] = payload.get("status", cycle["status"])
                        return {"ok": True}
            return {"ok": False, "error": f"cycle not found for PATCH {path}"}

        def fake_post(path, payload):
            if path == "/api/v2/agents/register":
                cycle_id = payload.get("cycleId")
                if cycle_id is not None:
                    active_ids = {
                        c["id"] for p in state["plans"].values() if p["status"] == "open"
                        for c in p["cycles"] if c["status"] == "active"
                    }
                    if cycle_id not in active_ids:
                        return {"ok": False, "error": f"cycle {cycle_id} is not active"}
                state["agents"][payload["agentId"]] = {"boundCycleId": cycle_id}
                return {"ok": True}
            if path in ("/api/v2/agents/heartbeat", "/api/v2/agents/unregister"):
                return {"ok": True}
            if path == "/api/v2/runs/parsed":
                state["ingest_payloads"].append(payload)
                bound = state["agents"].get(payload["agentId"], {}).get("boundCycleId")
                # SERVER-STAMPING: the real server ignores any client-sent
                # cycleId entirely and stamps the event from the agent's row
                # -- modelled here by reading the binding straight from
                # `state["agents"]`, never from `payload`.
                state["events"].append({"agentId": payload["agentId"], "cycleId": bound})
                return {"ok": True}
            return {"ok": False, "error": f"unhandled POST {path}"}

        with mock.patch.object(self.module, "_get", side_effect=fake_get), \
             mock.patch.object(self.module, "_patch", side_effect=fake_patch), \
             mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, _err = _run_main(self.module, [
                "cycle-activate", "501", "--project-dir", self.tmpdir,
            ])
            self.assertEqual(code, 0, f"cycle-activate stdout={out!r}")

            code, out, _err = _run_main(self.module, [
                "register", "--phase", "RED", "--agent", "CR-CRU-056-smoke",
                "--cycle", "501", "--project-dir", self.tmpdir,
            ])
            self.assertEqual(code, 0, f"register stdout={out!r}")

            code, out, _err = self._run_test_verb(agent="CR-CRU-056-smoke")
            self.assertEqual(code, 0, f"test stdout={out!r}")

        self.assertEqual(
            state["agents"]["CR-CRU-056-smoke"]["boundCycleId"], 501,
            "the agent row must carry the binding declared at register time")
        self.assertEqual(len(state["events"]), 1)
        self.assertNotIn(
            "cycleId", state["ingest_payloads"][0].get("context", {}) or {},
            "the client must send no client-resolved cycleId at ingest time")
        self.assertEqual(
            state["events"][0]["cycleId"], 501,
            "the server-stamped event context must equal the agent's "
            "registered binding, end to end through the real CLI dispatch")

    def test_register_refused_when_cycle_is_not_active_and_agent_row_not_created(self):
        """The other half of the chain: a binding the server refuses (here,
        a cycle still PENDING, never activated) must not register the
        agent at all -- no partial/ghost row, no ingest ever possible under
        that id."""
        state = {
            "plans": {
                "plan-1": {"planId": "plan-1", "cr": "CR-CRU-056", "status": "open",
                           "cycles": [{"id": 777, "status": "pending"}]},
            },
            "agents": {},
        }

        def fake_post(path, payload):
            if path == "/api/v2/agents/register":
                cycle_id = payload.get("cycleId")
                active_ids = {
                    c["id"] for p in state["plans"].values() if p["status"] == "open"
                    for c in p["cycles"] if c["status"] == "active"
                }
                if cycle_id not in active_ids:
                    return {"ok": False, "error": f"cycle {cycle_id} is pending, not active"}
                state["agents"][payload["agentId"]] = {"boundCycleId": cycle_id}
                return {"ok": True}
            return {"ok": False, "error": f"unhandled POST {path}"}

        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, _err = _run_main(self.module, [
                "register", "--phase", "RED", "--agent", "CR-CRU-056-refused",
                "--cycle", "777", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, f"a refused binding must exit non-zero; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        self.assertNotIn(
            "CR-CRU-056-refused", state["agents"],
            "a refused registration must never create the agent row")


if __name__ == "__main__":
    unittest.main()
