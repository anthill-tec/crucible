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


class AutoAttachToActiveCycleTest(_BaseAutoAttachTest):
    """§S9 core: WORKFLOW_CYCLE_ID unset -> the ingested run auto-attaches
    to the open plan's single ACTIVE cycle, both in the printed envelope's
    `context.cycleId` AND in the actual POSTed server payload -- an attached
    run must never merely look attached in the envelope while the server
    record itself stays orphaned."""

    ACTIVE_CYCLE_ID = 909

    def _active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": self.ACTIVE_CYCLE_ID, "status": "active"},
                        {"id": 900, "status": "done"}]},
        ])

    def test_test_verb_auto_attaches_run_to_the_single_active_cycle_when_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_test_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True)
        context = axi.get("context")
        self.assertEqual(context.get("cycleId"), self.ACTIVE_CYCLE_ID)
        self.assertEqual(axi.get("warnings"), [],
                          "an attached run must not ALSO carry a no-cycle-id warning")

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertEqual(
            payload.get("context", {}).get("cycleId"), self.ACTIVE_CYCLE_ID,
            "the SERVER-recorded run context must carry the resolved active "
            "cycle id, not just the printed envelope",
        )

    def test_regression_verb_auto_attaches_run_to_the_single_active_cycle_when_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_regression_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(context.get("cycleId"), self.ACTIVE_CYCLE_ID)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), self.ACTIVE_CYCLE_ID)

    def test_auto_ingest_verb_auto_attaches_run_to_the_single_active_cycle_when_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_auto_ingest_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(context.get("cycleId"), self.ACTIVE_CYCLE_ID)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), self.ACTIVE_CYCLE_ID)

    def test_source_never_reads_workflow_cycle_id_env_var(self):
        occurrences = SCRIPT_PATH.read_text().count("WORKFLOW_CYCLE_ID")
        self.assertEqual(
            occurrences, 0,
            f"bun-crucible.py must not reference WORKFLOW_CYCLE_ID anywhere "
            f"(CR-CRU-036 §S1 removes it -- the server's active cycle is the "
            f"single source of truth); found {occurrences} occurrence(s)",
        )

    def test_setting_workflow_cycle_id_env_has_no_effect_on_test_verb_attachment(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID=51 must NOT override the
        server-resolved active cycle -- the env var is no longer read at
        all, so the SERVER active cycle id wins even though it differs."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_test_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(
            context.get("cycleId"), self.ACTIVE_CYCLE_ID,
            "WORKFLOW_CYCLE_ID=51 must NOT override the server-resolved "
            f"active cycle ({self.ACTIVE_CYCLE_ID})",
        )
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), self.ACTIVE_CYCLE_ID)


class NoActiveCycleHardErrorTest(_BaseAutoAttachTest):
    """CR-CRU-036 §S1 corrected §S9: WORKFLOW_CYCLE_ID unset + an OPEN plan
    definitively carrying NO active cycle -> WARN + WITHHOLD (ok:false,
    `warnings[]` `no-active-cycle`, no POST, non-zero exit), never a silent
    cycleId=NONE orphan. No open plan AT ALL, or a plans-fetch failure, is
    the TOLERANT case (the verb proceeds) -- NOT a withhold, which SUPERSEDES
    the CR-CRU-030 interim behavior that (wrongly) withheld both."""

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _no_plans_at_all(self):
        return _open_plans_response([])

    def _plans_fetch_failure(self):
        return {"ok": False, "error": "connection failed: mock plans-fetch failure"}

    def _assert_warns_and_withholds(self, code, out, err, post_mock):
        self.assertNotEqual(code, 0,
                             "a withhold must exit non-zero, never a silent orphan")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        warnings_list = axi.get("warnings", [])
        codes = [w.get("code") for w in warnings_list]
        self.assertIn(
            "no-active-cycle", codes,
            f"the ok:false envelope on STDOUT must carry a no-active-cycle "
            f"warning; got warnings={warnings_list!r}")
        warning_details = " ".join(w.get("detail", "") for w in warnings_list).lower()
        self.assertIn("activate", warning_details)
        self.assertIn("no active cycle", err.lower())

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNone(
            ingest_call,
            "the run must NEVER be POSTed as a silent orphan (cycleId=NONE) "
            "when there is no active cycle to attach it to",
        )

    def _assert_tolerated(self, code, out, post_mock):
        self.assertEqual(code, 0, f"the tolerant path must proceed; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-active-cycle", codes)
        self.assertIsNotNone(
            _post_call_for_path(post_mock, "/api/v2/runs/parsed"),
            "the tolerant path must still post the run",
        )

    def test_test_verb_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_test_verb()
        self._assert_warns_and_withholds(code, out, err, post_mock)

    def test_test_verb_proceeds_when_no_open_plans_at_all(self):
        """CR-CRU-036 §S1 tolerant path: a lightweight project with no open
        plan must NOT withhold -- this SUPERSEDES the CR-CRU-030 interim
        assertion that this scenario hard-errored."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_plans_at_all()):
            code, out, _err = self._run_test_verb()
        self._assert_tolerated(code, out, post_mock)

    def test_test_verb_proceeds_when_plans_fetch_fails(self):
        """CR-CRU-036 §S1 tolerant path: a plans-fetch failure (infra hiccup
        / non-UUID key 400) is NOT proof of "no active cycle" -- proceeds."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._plans_fetch_failure()):
            code, out, _err = self._run_test_verb()
        self._assert_tolerated(code, out, post_mock)

    def test_regression_verb_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_regression_verb()
        self._assert_warns_and_withholds(code, out, err, post_mock)

    def test_regression_verb_proceeds_when_no_open_plans_at_all(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_plans_at_all()):
            code, out, _err = self._run_regression_verb()
        self._assert_tolerated(code, out, post_mock)

    def test_auto_ingest_verb_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_auto_ingest_verb()
        self._assert_warns_and_withholds(code, out, err, post_mock)

    def test_auto_ingest_verb_proceeds_when_no_open_plans_at_all(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_plans_at_all()):
            code, out, _err = self._run_auto_ingest_verb()
        self._assert_tolerated(code, out, post_mock)

    def test_auto_ingest_verb_proceeds_when_plans_fetch_fails(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._plans_fetch_failure()):
            code, out, _err = self._run_auto_ingest_verb()
        self._assert_tolerated(code, out, post_mock)


class RegisterHardErrorTest(_BaseAutoAttachTest):
    """CR-CRU-030 C2 (cycle 84) -- §S9's HARD ERROR text names `register`
    explicitly alongside the ingest verbs (spec lines 195/263: "No active
    cycle ... is a HARD ERROR on `register`/ingest"), but `cmd_register`
    (`clients/bun-crucible.py` ~L355) never checks -- confirmed by reading the
    function directly: it POSTs unconditionally with no `_get`/plans lookup
    at all. An agent that registers before any cycle is active must fail
    loudly (never come online against an untracked plan), mirroring the
    ingest hard-error contract `NoActiveCycleHardErrorTest` above already
    pins for test/regression/auto-ingest."""

    ACTIVE_CYCLE_ID = 909

    def _active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": self.ACTIVE_CYCLE_ID, "status": "active"},
                        {"id": 900, "status": "done"}]},
        ])

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _no_plans_at_all(self):
        return _open_plans_response([])

    def _run_register(self, agent="CR-CRU-030-C2-register-test"):
        return _run_main(self.module, [
            "register", "--agent", agent, "--project-dir", self.tmpdir,
        ])

    def _plans_fetch_failure(self):
        return {"ok": False, "error": "connection failed: mock plans-fetch failure"}

    def test_register_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, _err = self._run_register()

        self.assertNotEqual(
            code, 0, "no active cycle -- register must withhold with a non-zero exit")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        warnings_list = axi.get("warnings", [])
        codes = [w.get("code") for w in warnings_list]
        self.assertIn(
            "no-active-cycle", codes,
            f"the ok:false envelope on STDOUT must carry a no-active-cycle "
            f"warning; got warnings={warnings_list!r}")

        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNone(
            register_call,
            "the register POST must NOT fire when there is no active cycle to attach to",
        )

    def test_register_proceeds_when_no_open_plans_at_all(self):
        """CR-CRU-036 §S1 tolerant path: a lightweight project with no open
        plan must NOT withhold -- this SUPERSEDES the CR-CRU-030 interim
        assertion that this scenario hard-errored."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_plans_at_all()):
            code, out, _err = self._run_register()

        self.assertEqual(code, 0, f"no open plan at all must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call, "the tolerant path must still register")

    def test_register_proceeds_when_plans_fetch_fails(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._plans_fetch_failure()):
            code, out, _err = self._run_register()

        self.assertEqual(code, 0, f"a plans-fetch failure must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call)

    def test_register_succeeds_when_active_cycle_present_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, _err = self._run_register()

        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(
            register_call, "an active cycle is present -- register must actually POST")

    def test_setting_workflow_cycle_id_env_has_no_effect_on_register_withhold(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID=51 must NOT rescue a register
        against an open plan with no active cycle -- the env var is dead."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, _err = self._run_register()

        self.assertNotEqual(
            code, 0,
            "WORKFLOW_CYCLE_ID must have NO effect -- the withhold still fires; "
            f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNone(register_call)


if __name__ == "__main__":
    unittest.main()
