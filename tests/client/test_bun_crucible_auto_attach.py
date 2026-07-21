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

    # NOTE: an "explicit WORKFLOW_CYCLE_ID overrides auto-resolution" case was
    # deliberately NOT added here -- the existing `_run_context()`/
    # `_cycle_id_and_warnings()` short-circuit already treats an explicit
    # WORKFLOW_CYCLE_ID as authoritative today (before this CR), so any such
    # test passes unchanged against current code (not real RED; a no-op
    # GREEN already satisfies it). That AC bullet is already covered as a
    # regression guard by the PRE-EXISTING
    # `IngestEnvelopeTest.test_test_command_emits_toon_envelope_with_run_summary_and_cycleid_context`
    # in test_bun_crucible_toon_envelope.py, which pins WORKFLOW_CYCLE_ID=51
    # -> context.cycleId==51 and must keep passing unmodified through GREEN.


class NoActiveCycleHardErrorTest(_BaseAutoAttachTest):
    """§S9 hard-error: WORKFLOW_CYCLE_ID unset + no active cycle to attach
    to (all terminal, or no plans at all) -> a HARD ERROR, never a silent
    cycleId=NONE orphan. This SUPERSEDES the old soft `no-cycle-id`
    warn-and-proceed behavior for exactly this scenario (§S9 spec text)."""

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _no_plans_at_all(self):
        return _open_plans_response([])

    def _assert_hard_error(self, code, out, err, post_mock):
        self.assertNotEqual(code, 0,
                             "a hard error must exit non-zero, never a silent orphan")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        warnings_list = axi.get("warnings", [])
        warning_details = " ".join(w.get("detail", "") for w in warnings_list).lower()
        self.assertIn(
            "no active cycle", warning_details,
            f"the ok:false envelope on STDOUT must carry a 'no active cycle' "
            f"message; got warnings={warnings_list!r}")
        self.assertIn("activate one first", warning_details)
        self.assertIn("no active cycle", err.lower())

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNone(
            ingest_call,
            "the run must NEVER be POSTed as a silent orphan (cycleId=NONE) "
            "when there is no active cycle to attach it to",
        )

    def test_test_verb_hard_errors_when_no_active_cycle_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_test_verb()
        self._assert_hard_error(code, out, err, post_mock)

    def test_test_verb_hard_errors_when_no_open_plans_at_all(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_plans_at_all()):
            code, out, err = self._run_test_verb()
        self._assert_hard_error(code, out, err, post_mock)

    def test_regression_verb_hard_errors_when_no_active_cycle_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_regression_verb()
        self._assert_hard_error(code, out, err, post_mock)

    def test_auto_ingest_verb_hard_errors_when_no_active_cycle_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_auto_ingest_verb()
        self._assert_hard_error(code, out, err, post_mock)


if __name__ == "__main__":
    unittest.main()
