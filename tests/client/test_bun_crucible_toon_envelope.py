"""CR-CRU-013 cycle 51 — the bun-client TOON-AXI output slice (reference
implementation for the fleet-wide CR-CRU-030).

Contract pinned VERBATIM from docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md
§S1 (the envelope schema) + the `no-cycle-id` half of §S3 -- scoped to
`clients/bun-crucible.py` ONLY (the other four clients + `no-wave`/`--wave`/
backfill are CR-CRU-030, out of scope here).

§S1 verbatim schema:
    axi:
      verb: <name>
      ok: <bool>
      <verb-specific result fields>          # e.g. cycle, plan, agent, run{passed,total}, cycles[]
      context: { projectKey, agentId?, cycleId?, wave, cr, track?, orchestrator? }
      warnings[]{code,detail}
    "Human-readable stderr lines may remain for interactive use; stdout is the
    TOON AXI channel."

§S3 (no-cycle-id half) verbatim: "`no-cycle-id` -- `--agent` ingest with
`WORKFLOW_CYCLE_ID` unset while the open plan has an ACTIVE cycle, naming the
active cycle id."  "A field that would classify the record but resolves empty
is emitted as explicit null AND raises a `warnings[]` entry ... never silently
dropped."

RED phase: as of this writing `cmd_register`/`cmd_unregister`/`cmd_plan_file`/
`_cycle_transition`/`cmd_cr_close`/`_ingest_parsed` all `print()` a single
ad-hoc human-readable line straight to stdout (confirmed by reading
clients/bun-crucible.py) and never call `clients/toon.py`'s `encode()` at all
for these verbs (`_toon()` today is only ever `.decode()`d, for the no-mistakes
axi stream in `cmd_gate_run` -- see `bun-crucible.py:1127,1151`). Every test
below therefore fails: `toon.decode(stdout)` either raises (stdout is plain
text, not TOON) or yields a dict with no top-level "axi" key -- real
behavioral RED, not a missing-symbol accident. There is also no GET-plans
lookup anywhere in `cmd_test`/`cmd_regression`/`cmd_auto_ingest` today, so the
no-cycle-id warning tests fail identically (no `warnings` key is ever
produced).

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
`test_bun_crucible_gates.py` harness in this same directory -- REPO_ROOT-
relative load of `clients/bun-crucible.py` (the in-repo SOURCE OF TRUTH, CR-
CRU-008 Risk section), real `argparse` dispatch via `module.main()` with
`sys.argv` patched (so this file never has to guess internal Namespace `dest`
names), and mocking the module's `_post`/`_get`/`_patch` HTTP transport seams
-- this file's cycle-specific constraint requires the live server at :3849 is
NEVER touched (no dogfood pollution). `bun test` itself is never invoked
either: `--bun` points at a tiny fake executable (same technique as
`test_bun_crucible_lifecycle.py`) that copies a fixture JUnit XML to
`--reporter-outfile=`.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_toon_envelope.py -q
Fallback:
    python3 tests/client/test_bun_crucible_toon_envelope.py
"""

import contextlib
import copy
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

FAIL_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="toon.test.ts" tests="1" failures="1">
<testcase name="fails" time="0.001"><failure message="boom">boom trace</failure></testcase>
</testsuite>
</testsuites>
"""

# A tiny fake `bun` executable -- ignores all args except `--reporter-outfile=`,
# to which it copies FAKE_BUN_JUNIT_CONTENT verbatim, then exits with
# FAKE_BUN_EXIT_CODE. Identical technique to test_bun_crucible_lifecycle.py.
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
    """Load clients/bun-crucible.py by file path (hyphenated filename can't be
    `import`ed normally) -- same technique as the sibling client harnesses,
    pointed at the REPO copy (the SOURCE OF TRUTH, CR-CRU-008 Risk section)."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_toon", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched to `argv`. Returns
    (exit_code, stdout, stderr). Only SystemExit is caught -- any OTHER
    exception propagates so unittest reports it as an ERROR (still a valid RED
    signal)."""
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


class _BaseEnvelopeTest(unittest.TestCase):
    """Shared tmp-project-dir + WORKFLOW_* env isolation."""

    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-toon-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

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
                      f"'axi' key; got {decoded!r} from stdout={stdout_text!r}")
        return decoded["axi"]


# ── register / unregister ───────────────────────────────────────────────────


class RegisterUnregisterEnvelopeTest(_BaseEnvelopeTest):
    PROJECT_KEY = "test-key-toon-register"

    def test_register_emits_toon_envelope_and_moves_text_line_to_stderr(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "register", "--agent", "CR-X-1-RED", "--phase", "RED",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("agent"), "CR-X-1-RED")

        context = axi.get("context")
        self.assertIsInstance(context, dict)
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(context.get("agentId"), "CR-X-1-RED")

        self.assertEqual(axi.get("warnings"), [])

        # The former stdout line is now interactive-only, on stderr.
        legacy_line = "register: ok=True agent=CR-X-1-RED phase=RED source=claude-md"
        self.assertIn(legacy_line, err)
        # And it must be GONE from stdout -- stdout is the TOON channel only.
        self.assertNotIn(legacy_line, out)

    def test_register_failure_still_emits_ok_false_envelope(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": "boom"}):
            code, out, _err = _run_main(self.module, [
                "register", "--phase", "report", "--agent", "CR-X-2-RED", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), False)

    def test_unregister_emits_toon_envelope_and_moves_text_line_to_stderr(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "unregister", "--agent", "CR-X-1-RED", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "unregister")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("agent"), "CR-X-1-RED")
        context = axi.get("context")
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(context.get("agentId"), "CR-X-1-RED")

        legacy_line = "unregister: ok=True agent=CR-X-1-RED"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_unregister_failure_still_emits_ok_false_envelope(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": "boom"}):
            code, out, _err = _run_main(self.module, [
                "unregister", "--agent", "CR-X-2-RED", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)


# ── plan-file ────────────────────────────────────────────────────────────────


class PlanFileEnvelopeTest(_BaseEnvelopeTest):
    PROJECT_KEY = "test-key-toon-planfile"

    def test_plan_file_emits_toon_envelope_with_planid_cr_and_cycles_table(self):
        server_resp = {
            "ok": True, "planId": "plan-77", "cr": "CR-X",
            "cycles": [{"label": "a", "id": 101}, {"label": "b", "id": 102}],
        }
        with mock.patch.object(self.module, "_post", return_value=server_resp):
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-X", "--cycles", "a,b",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("planId"), "plan-77")
        self.assertEqual(axi.get("cr"), "CR-X")
        # The "never guess ids" contract must hold under TOON (AC 124): the
        # ASSIGNED numeric cycle ids stay machine-readable in the envelope.
        self.assertEqual(
            axi.get("cycles"),
            [{"label": "a", "id": 101}, {"label": "b", "id": 102}],
        )

        context = axi.get("context")
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)

        legacy_line = "plan-file: ok=True planId=plan-77 cr=CR-X cycles: a=101 b=102"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_plan_file_attaches_track_context_from_workflow_role(self):
        os.environ["WORKFLOW_ROLE"] = "Track 2"
        server_resp = {"ok": True, "planId": "plan-9", "cr": "CR-Y",
                        "cycles": [{"label": "a", "id": 201}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp):
            code, out, _err = _run_main(self.module, [
                "plan-file", "--cr", "CR-Y", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(context.get("track"), "Track 2")

    def test_plan_file_failure_still_emits_ok_false_envelope(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": "bad cr"}):
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-BAD", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), False)
        self.assertIn("bad cr", err)


# ── cycle-activate / cycle-done ─────────────────────────────────────────────


class CycleTransitionEnvelopeTest(_BaseEnvelopeTest):
    PROJECT_KEY = "test-key-toon-cycle"

    def _open_plan_with_cycle(self, cycle_id, plan_id="plan-9"):
        return _open_plans_response([
            {"planId": plan_id, "cr": "CR-Z", "status": "open",
             "cycles": [{"id": cycle_id, "status": "pending"}]},
        ])

    def test_cycle_activate_emits_toon_envelope_with_cycle_and_plan_fields(self):
        with mock.patch.object(self.module, "_get",
                                return_value=self._open_plan_with_cycle(55)), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "cycle-activate", "55", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("cycle"), 55)
        self.assertEqual(axi.get("plan"), "plan-9")

        legacy_line = "cycle-activate: ok=True cycle=55 plan=plan-9"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_cycle_done_emits_toon_envelope_with_cycle_and_plan_fields(self):
        with mock.patch.object(self.module, "_get",
                                return_value=self._open_plan_with_cycle(56)), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "cycle-done", "56", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-done")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("cycle"), 56)
        self.assertEqual(axi.get("plan"), "plan-9")

    def test_cycle_activate_unknown_cycle_still_emits_ok_false_envelope(self):
        with mock.patch.object(self.module, "_get",
                                return_value=_open_plans_response([])):
            code, out, err = _run_main(self.module, [
                "cycle-activate", "999", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), False)
        self.assertIn("999", err)


# ── cr-close ─────────────────────────────────────────────────────────────────


class CrCloseEnvelopeTest(_BaseEnvelopeTest):
    PROJECT_KEY = "test-key-toon-crclose"
    CR_ID = "CR-CRU-777"
    PLAN_ID = "plan-cr-cru-777"

    def _open_plan(self):
        return _open_plans_response([
            {"planId": self.PLAN_ID, "cr": self.CR_ID, "status": "open", "cycles": []},
        ])

    def test_cr_close_emits_toon_envelope_with_plan_cr_commit_and_wave_context(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        with mock.patch.object(self.module, "_get", return_value=self._open_plan()), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}), \
             mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "cr-close", "--commit", "abc1234", "--cr", self.CR_ID,
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cr-close")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plan"), self.PLAN_ID)
        self.assertEqual(axi.get("cr"), self.CR_ID)
        self.assertEqual(axi.get("commit"), "abc1234")

        context = axi.get("context")
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(context.get("cr"), self.CR_ID)
        self.assertEqual(str(context.get("wave")), "4")

        legacy_line = f"cr-close: ok=True plan={self.PLAN_ID} cr={self.CR_ID} commit=abc1234"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_cr_close_ambiguous_open_plans_still_emits_ok_false_envelope(self):
        two_open = _open_plans_response([
            {"planId": "plan-a", "cr": "CR-A", "status": "open", "cycles": []},
            {"planId": "plan-b", "cr": "CR-B", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=two_open):
            code, out, err = _run_main(self.module, [
                "cr-close", "--commit", "abc1234", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cr-close")
        self.assertIs(axi.get("ok"), False)


# ── test / regression / auto-ingest (+ no-cycle-id guard) ───────────────────


class IngestEnvelopeTest(_BaseEnvelopeTest):
    PROJECT_KEY = "test-key-toon-ingest"

    def setUp(self):
        super().setUp()
        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o755)

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-1", "cr": "CR-Q", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _active_cycle_plans(self, active_id=51):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-Q", "status": "open",
             "cycles": [{"id": active_id, "status": "active"},
                        {"id": active_id - 1, "status": "done"}]},
        ])

    def test_test_command_emits_toon_envelope_with_run_summary_and_cycleid_context(self):
        """CR-CRU-036 §S1 retarget: WORKFLOW_CYCLE_ID no longer exists -- the
        cycleId comes from the server's active cycle instead."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans(51)):
            code, out, err = _run_main(self.module, [
                "test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", "CR-CRU-013-C51-test",
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("failed"), 0)
        self.assertEqual(run.get("total"), 1)

        context = axi.get("context")
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(context.get("agentId"), "CR-CRU-013-C51-test")
        self.assertEqual(context.get("cycleId"), 51)
        self.assertIsInstance(context.get("cycleId"), int)

        self.assertEqual(axi.get("warnings"), [])

        # CR-CRU-050 §S2 — the plain stderr line now also carries `pending`, so
        # a line that omits a skip count can never be misread as summing.
        legacy_line = "ingest: ok=True passed=1 failed=0 pending=0 total=1"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_test_command_without_agent_emits_no_toon_envelope(self):
        """Nothing was ingested (no --agent), so there is nothing to report --
        the run's own plain output is unaffected, and NO TOON envelope (which
        would misleadingly imply an ingest happened) is printed."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        with mock.patch.object(self.module, "_post") as post_mock:
            code, out, _err = _run_main(self.module, [
                "test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
            ])

        self.assertEqual(code, 0)
        post_mock.assert_not_called()
        decoded = self.toon.decode(out) if out.strip() else {}
        self.assertNotIn(
            "axi", decoded,
            f"no ingest happened (no --agent), so no TOON envelope should be "
            f"printed at all (it would misleadingly imply one did); got out={out!r}",
        )

    def test_regression_command_emits_toon_envelope_with_run_summary(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans(51)):
            code, out, err = _run_main(self.module, [
                "regression", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", "CR-CRU-013-C51-regression",
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "regression")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run")
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("total"), 1)
        context = axi.get("context")
        self.assertEqual(context.get("agentId"), "CR-CRU-013-C51-regression")
        self.assertEqual(context.get("cycleId"), 51)

        # CR-CRU-050 §S2 — the plain stderr line now also carries `pending`, so
        # a line that omits a skip count can never be misread as summing.
        legacy_line = "ingest: ok=True passed=1 failed=0 pending=0 total=1"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)

    def test_auto_ingest_emits_toon_envelope_with_run_summary(self):
        """CR-CRU-036 §S1 retarget: an env-unset ingest with NO active cycle
        WARNS+WITHHOLDS (see test_bun_crucible_auto_attach.py), so this
        envelope/run-summary pin needs a resolvable cycle to reach the
        ok:True envelope it was written to verify -- a SERVER active cycle
        (never WORKFLOW_CYCLE_ID, which no longer exists) supplies it."""
        reports_dir = os.path.join(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "junit.xml"), "w") as f:
            f.write(PASS_JUNIT_XML)
        os.environ.pop("WORKFLOW_CYCLE_ID", None)

        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans(51)):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-013-C51-auto",
                "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
                "--reports", "reports",
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "auto-ingest")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run")
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("total"), 1)
        context = axi.get("context")
        self.assertEqual(context.get("agentId"), "CR-CRU-013-C51-auto")
        self.assertEqual(context.get("cycleId"), 51)

        # CR-CRU-050 §S2 — the plain stderr line now also carries `pending`, so
        # a line that omits a skip count can never be misread as summing.
        legacy_line = "ingest: ok=True passed=1 failed=0 pending=0 total=1"
        self.assertIn(legacy_line, err)
        self.assertNotIn(legacy_line, out)


class NoCycleIdWarningTest(_BaseEnvelopeTest):
    """§S3 (no-cycle-id half) -- the cycle-id orphan incident (5 CR-013 runs
    ingested with cycleId=null, with the plain-text output surfacing nothing)
    is exactly what this guard prevents."""

    PROJECT_KEY = "test-key-toon-nocycleid"
    ACTIVE_CYCLE_ID = 909

    def setUp(self):
        super().setUp()
        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o755)
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"

    def _active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-013", "status": "open",
             "cycles": [{"id": self.ACTIVE_CYCLE_ID, "status": "active"}]},
        ])

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-013", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _run_test_verb(self, agent="CR-CRU-013-C51-test"):
        return _run_main(self.module, [
            "test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
            "--package-dir", self.tmpdir, "--reports", "reports", "--agent", agent,
        ])

    def test_no_cycle_id_env_unset_with_active_cycle_auto_attaches_without_warning(self):
        """CR-CRU-030 §S9 SUPERSEDES the old soft no-cycle-id warn-and-proceed
        behavior pinned here originally: when WORKFLOW_CYCLE_ID is unset but
        the open plan has exactly one ACTIVE cycle, the ingest now
        AUTO-ATTACHES to it silently -- no cycleId=null orphan, no
        `no-cycle-id` warning on either channel."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, err = self._run_test_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)

        context = axi.get("context")
        self.assertEqual(context.get("cycleId"), self.ACTIVE_CYCLE_ID,
                          "the run must auto-attach to the plan's single "
                          "ACTIVE cycle when WORKFLOW_CYCLE_ID is unset")

        self.assertEqual(axi.get("warnings"), [],
                          "auto-attach succeeded -- no no-cycle-id warning should be emitted")
        self.assertNotIn("no-cycle-id", err)

    def test_setting_workflow_cycle_id_env_has_no_effect_when_active_cycle_present(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID no longer overrides anything --
        the server's active cycle (self.ACTIVE_CYCLE_ID) is attached even
        though the env var names a DIFFERENT id (51), proving it is ignored."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, err = self._run_test_verb()

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(
            context.get("cycleId"), self.ACTIVE_CYCLE_ID,
            "WORKFLOW_CYCLE_ID=51 must NOT override the server-resolved "
            f"active cycle ({self.ACTIVE_CYCLE_ID})",
        )
        self.assertEqual(axi.get("warnings"), [])
        self.assertNotIn("no-cycle-id", err)

    def test_no_active_cycle_at_all_warns_and_withholds(self):
        """CR-CRU-036 §S1 SUPERSEDES the old soft no-cycle-id warn-and-proceed
        behavior for exactly this scenario (no ACTIVE cycle at all, env
        unset): it is now a WARN + WITHHOLD (ok:false, non-zero exit, no
        POST), never a silent orphan. Full coverage of the §S1 corrected
        §S9 auto-attach/warn-withhold contract (test/regression/auto-ingest,
        the tolerant paths, and the exact stdout message) lives in
        tests/client/test_bun_crucible_auto_attach.py -- this method only
        pins that the OLD assertion here (code==0, warnings==[]) no longer
        holds."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=self._no_active_cycle_plans()):
            code, out, err = self._run_test_verb()

        self.assertNotEqual(code, 0,
                             "no ACTIVE cycle exists -- §S1 requires a WARN + "
                             "WITHHOLD, not a silent success")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        warnings_list = axi.get("warnings", [])
        codes = [w.get("code") for w in warnings_list]
        self.assertIn("no-active-cycle", codes)
        for call in post_mock.call_args_list:
            args, kwargs = call
            path = args[0] if args else kwargs.get("path")
            self.assertNotEqual(
                path, "/api/v2/runs/parsed",
                "the run must never be POSTed as a silent orphan when there "
                "is no active cycle to attach it to")

    def test_regression_also_auto_attaches_to_active_cycle_when_env_unset_no_warning(self):
        """CR-CRU-030 §S9 retarget of the `regression` sibling to the same
        auto-attach contract as the `test` verb above."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_get", return_value=self._active_cycle_plans()):
            code, out, err = _run_main(self.module, [
                "regression", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", "CR-CRU-013-C51-regression",
            ])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        context = axi.get("context")
        self.assertEqual(context.get("cycleId"), self.ACTIVE_CYCLE_ID,
                          "the run must auto-attach to the plan's single "
                          "ACTIVE cycle when WORKFLOW_CYCLE_ID is unset")
        self.assertEqual(axi.get("warnings"), [],
                          "auto-attach succeeded -- no no-cycle-id warning should be emitted")
        self.assertNotIn("no-cycle-id", err)


if __name__ == "__main__":
    unittest.main()
