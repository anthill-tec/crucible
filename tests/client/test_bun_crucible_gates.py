"""CR-CRU-013 §S4c/§S5 (cycle 48) — fleet gate/milestone verbs in
`clients/bun-crucible.py`: `gate-run` (the axi-PROXY wrapper), `gate-report`
(report-only), `milestone`, and the `cr-close` cr-merged hook.

Endpoint contracts pinned VERBATIM from docs/changes/CR-CRU-013-gate-events.md:

  §S1  POST /api/v2/gates
       {projectKey, agentId, context?{wave, track?},
        gate:{intent, outcome, steps:[{name, status, findings?, fixRounds?}],
              fixes?, push?:{commit, remote}, pr?}}
       outcome in {checks-passed, passed, failed, cancelled}.

  §S4b/§S4c POST /api/v2/milestones
       {projectKey, agentId, type, label?, context?{cr, wave, track}, commit?}
       type in {gap-analysis, design-review, stage-flip, custom, cr-merged}.

  §S4c cr-merged marker (AC 141, verbatim example):
       {type:"cr-merged", label:<CR id>, context:{cr, wave}, commit:<sha>}
       — sent by the `cr-close` verb automatically on a successful close.

  AC 147 (gate-report, verbatim): `bun-crucible.py gate-report --outcome passed
       --commit abc1234 --steps "review:passed,test:passed"` posts a valid gate
       with context.wave from WORKFLOW_WAVE; unset env -> no wave key.

  AC 148 (gate-run, verbatim): with a fake `no-mistakes` on PATH emitting a
       scripted TOON stream (steps completing over a few seconds),
       `bun-crucible.py gate-run --intent "..."` (a) posts >=1 INTERIM gate to
       /api/v2/gates before the final sealing post (throttled per §S2b) and
       (b) a final gate whose outcome matches the stream -- WITHOUT the caller
       issuing any POST itself; (c) the no-mistakes axi detail is still
       RELAYED to the caller (proxy role).

RED phase: `clients/bun-crucible.py` today (as of C4 GREEN) defines no
`cmd_gate_run`, `cmd_gate_report`, or `cmd_milestone` subcommands at all, and
`cmd_cr_close` does not emit any /api/v2/milestones POST. Every test below
therefore fails either at argparse dispatch (`gate-run`/`gate-report`/
`milestone` are not registered subcommands -> SystemExit(2) "invalid choice",
not the asserted 0) or on the cr-merged call-count assertion (0 calls found,
not 1) -- real behavioral RED, not a missing-symbol accident.

Module-loading convention: this file targets the REPO's `clients/` copy
directly (REPO_ROOT-relative), NOT the `~/.claude/scripts` mirror the older
sibling harnesses (test_bun_crucible_lifecycle.py / test_bun_crucible_context.py)
load from. Reason: `gate-report`/`gate-run` are speced to consume
`clients/toon.py` (§S5, C4) for TOON decoding, and only the in-repo `clients/`
directory has `toon.py` sitting next to `bun-crucible.py` today (the home
mirror is not yet re-synced past the C4 GREEN commit). This matches
test_toon.py's own REPO_ROOT-relative loading convention exactly.

HTTP isolation: per the dispatch's cycle-specific constraint, every test here
mocks the module's SAME single HTTP transport seams the sibling lifecycle
harness already established -- `_post`/`_get`/`_patch` -- so nothing here ever
touches the live server at :3849. `bun test`/`bun`/network are never invoked;
CLI dispatch goes through the REAL `argparse` parser via `module.main()` with
`sys.argv` patched, so this file never has to guess internal Namespace
attribute ('dest') names for the brand-new subcommands -- only the flag names
the CR text/AC give verbatim (--outcome, --commit, --steps, --type, --label,
--cr, --intent).

GATE-RUN WIRE CONTRACT (resolved 2026-07-18 via `no-mistakes axi ... --help`,
orchestrator correction -- supersedes an earlier single-stream assumption):
`axi run --intent "<goal>" [--yes]` BLOCKS and, once resolved, prints the
FINAL TOON snapshot; `axi status [--run ID]` is a SEPARATE one-shot poll that
returns the active/most-recent run's current detail WITHOUT disturbing it
(exactly the shape of tests/fixtures/no-mistakes-axi-status.toon); `axi
respond --action ...` answers an awaiting gate. There is no single streaming
call. gate-run must therefore: launch `axi run` in the background, POLL `axi
status` at the throttled §S2b cadence while it is in flight (posting
throttled INTERIM gates decoded via clients/toon.py), and POST the FINAL
sealing gate from `axi run`'s own resolved outcome when it exits -- all
without the caller issuing any POST itself, while relaying the axi detail to
the caller's own stdout (proxy role). The fake `no-mistakes` below implements
BOTH `axi run` (writes progressive snapshots to a shared state file over
~3 real seconds, then prints the final) and `axi status` (reads whatever is
currently in that state file, fast, no sleep). §S2b cadence is still assumed
to reuse the same >=2-second `_Narrator` constant (CR-CRU-008) since that is
the only concrete cadence value this codebase defines; this file's `--yes` /
ask-user proxy-decision path (`axi respond`) is intentionally NOT covered --
AC 148 does not exercise a genuine ask-user gate, so that path is out of
scope here.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_gates.py -q
Fallback:
    python3 tests/client/test_bun_crucible_gates.py
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"


def _load_bun_crucible_module():
    """Load clients/bun-crucible.py by file path (hyphenated filename can't be
    `import`ed normally) -- same technique as the sibling client harnesses,
    but pointed at the REPO copy (see module docstring for why)."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_gates", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched to `argv` (prefixed with a
    fake prog name). Returns (exit_code, captured_stdout, captured_stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal, not silently
    swallowed)."""
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


def _assert_subcommand_recognized(testcase, stderr):
    """A negative-path test that merely asserts `code != 0` would ALSO pass
    (vacuously) against today's RED baseline, where the subcommand doesn't
    exist at all and argparse itself rejects it with exit code 2. Guard every
    such test with this: it fails loudly while the verb is unregistered
    (`invalid choice`) and only stops failing once the real subcommand exists
    and is doing its OWN error handling."""
    testcase.assertNotIn(
        "invalid choice", stderr,
        f"the subcommand itself must be registered (argparse rejected it "
        f"outright, this is not the target error path yet): {stderr!r}",
    )


class _BaseClientVerbTest(unittest.TestCase):
    """Shared tmp-project-dir + WORKFLOW_* env isolation for the verb tests."""

    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-gates-")
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


# ---------------------------------------------------------------------------
# gate-report -- AC 147
# ---------------------------------------------------------------------------


class GateReportClientVerbTest(_BaseClientVerbTest):
    PROJECT_KEY = "test-key-gatereport"

    def _post_recorder(self, calls, ok=True, error=None):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": ok} if ok else {"ok": False, "error": error or "boom"}
        return fake_post

    def _base_argv(self, extra=None):
        argv = ["gate-report", "--outcome", "passed", "--commit", "abc1234",
                "--steps", "review:passed,test:passed", "--agent", "test-agent",
                "--project-dir", self.tmpdir]
        return argv + (extra or [])

    def test_gate_report_posts_valid_gate_with_wave_context_from_env(self):
        os.environ["WORKFLOW_WAVE"] = "3"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, _out, _err = _run_main(self.module, self._base_argv())

        self.assertEqual(code, 0)
        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        self.assertEqual(len(gate_calls), 1, f"expected exactly ONE gate POST, got {calls}")
        payload = gate_calls[0][1]
        self.assertEqual(payload.get("projectKey"), "test-key-gatereport")

        gate = payload.get("gate")
        self.assertIsInstance(gate, dict)
        self.assertEqual(gate.get("outcome"), "passed")
        self.assertEqual(
            gate.get("steps"),
            [{"name": "review", "status": "passed"}, {"name": "test", "status": "passed"}],
        )
        self.assertEqual(gate.get("push", {}).get("commit"), "abc1234")
        # gate.intent is REQUIRED server-side (400 if missing/empty) -- the
        # flags fallback path must still supply SOME non-empty intent string.
        self.assertIsInstance(gate.get("intent"), str)
        self.assertGreater(len(gate.get("intent") or ""), 0)

        context = payload.get("context") or {}
        self.assertEqual(str(context.get("wave")), "3")

    def test_gate_report_without_wave_env_omits_wave_key(self):
        os.environ.pop("WORKFLOW_WAVE", None)
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, _out, _err = _run_main(self.module, self._base_argv())

        self.assertEqual(code, 0)
        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        self.assertEqual(len(gate_calls), 1)
        context = gate_calls[0][1].get("context") or {}
        self.assertNotIn("wave", context,
                          f"context must NOT carry a wave key when WORKFLOW_WAVE is unset: {context}")

    def test_gate_report_attaches_track_from_workflow_role(self):
        # Dispatch text: "Both auto-attach context.wave from WORKFLOW_WAVE and
        # track from WORKFLOW_ROLE (established pattern)."
        os.environ["WORKFLOW_ROLE"] = "Track 2"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, _out, _err = _run_main(self.module, self._base_argv())

        self.assertEqual(code, 0)
        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        context = gate_calls[0][1].get("context") or {}
        self.assertEqual(context.get("track"), "Track 2")

    def test_gate_report_malformed_steps_flag_does_not_post_garbage(self):
        argv = ["gate-report", "--outcome", "passed", "--commit", "abc1234",
                "--steps", "not-a-valid-step-entry-missing-colon", "--agent", "test-agent",
                "--project-dir", self.tmpdir]
        calls = []
        code, err = 1, ""
        try:
            with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
                code, _out, err = _run_main(self.module, argv)
        except Exception:
            code = 1  # any raised exception also counts as "did not succeed"

        # A bare `code != 0` would ALSO pass while `gate-report` isn't a
        # registered subcommand at all (argparse exit 2) -- pin that this is
        # the malformed-input error path, not the not-yet-wired-up one.
        _assert_subcommand_recognized(self, err)
        self.assertNotEqual(code, 0,
                             "a malformed --steps entry must fail, not silently succeed")
        self.assertEqual(calls, [], "a malformed --steps entry must not result in a POST")

    def test_gate_report_surfaces_server_failure_as_nonzero_exit(self):
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._post_recorder(
                                    calls, ok=False, error="gate.outcome must be one of: ...")):
            code, _out, err = _run_main(self.module, self._base_argv())

        _assert_subcommand_recognized(self, err)
        self.assertNotEqual(code, 0,
                             "a failed POST (server 400) must surface as a non-zero exit")


# ---------------------------------------------------------------------------
# milestone -- §S4b / AC 149 (client half only; server validation is C1/out of
# scope for this Python-client cycle)
# ---------------------------------------------------------------------------


class MilestoneClientVerbTest(_BaseClientVerbTest):
    PROJECT_KEY = "test-key-milestone"

    def _post_recorder(self, calls, ok=True, error=None):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": ok} if ok else {"ok": False, "error": error or "boom"}
        return fake_post

    def test_milestone_posts_type_label_and_cr_context(self):
        calls = []
        argv = ["milestone", "--type", "gap-analysis", "--label", "CR-NAI-043 gap-analysis",
                "--cr", "CR-NAI-043", "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, _out, _err = _run_main(self.module, argv)

        self.assertEqual(code, 0)
        ms_calls = [c for c in calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ms_calls), 1, f"expected exactly ONE milestone POST, got {calls}")
        payload = ms_calls[0][1]
        self.assertEqual(payload.get("projectKey"), "test-key-milestone")
        self.assertEqual(payload.get("type"), "gap-analysis")
        self.assertEqual(payload.get("label"), "CR-NAI-043 gap-analysis")
        context = payload.get("context") or {}
        self.assertEqual(context.get("cr"), "CR-NAI-043")

    def test_milestone_without_cr_flag_omits_context_cr(self):
        calls = []
        argv = ["milestone", "--type", "stage-flip", "--label", "wave 3 -> gated",
                "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, _out, _err = _run_main(self.module, argv)

        self.assertEqual(code, 0)
        ms_calls = [c for c in calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ms_calls), 1)
        payload = ms_calls[0][1]
        self.assertEqual(payload.get("type"), "stage-flip")
        context = payload.get("context") or {}
        self.assertNotIn("cr", context,
                          f"omitted --cr must not fabricate a context.cr: {context}")

    def test_milestone_surfaces_server_failure_as_nonzero_exit(self):
        calls = []
        argv = ["milestone", "--type", "deploy", "--label", "bogus",
                "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post",
                                side_effect=self._post_recorder(
                                    calls, ok=False, error="type must be one of: ...")):
            code, _out, err = _run_main(self.module, argv)

        _assert_subcommand_recognized(self, err)
        self.assertNotEqual(code, 0,
                             "a failed POST (invalid type, server 400) must surface non-zero")


# ---------------------------------------------------------------------------
# cr-close cr-merged hook -- §S4c / AC 141 (client half)
# ---------------------------------------------------------------------------


class CrCloseCrMergedMilestoneHookTest(_BaseClientVerbTest):
    PROJECT_KEY = "test-key-crclose"
    CR_ID = "CR-CRU-999"
    PLAN_ID = "plan-cr-cru-999"

    def _get_recorder(self):
        def fake_get(path):
            return {"ok": True, "plans": [
                {"planId": self.PLAN_ID, "cr": self.CR_ID, "status": "open", "cycles": []},
            ]}
        return fake_get

    def test_cr_close_emits_cr_merged_milestone_on_successful_close(self):
        os.environ["WORKFLOW_WAVE"] = "2"
        post_calls = []

        def fake_post(path, payload):
            post_calls.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        def fake_patch(path, payload):
            return {"ok": True}

        argv = ["cr-close", "--commit", "abc1234", "--agent", "test-agent", "--cr", self.CR_ID,
                "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", side_effect=self._get_recorder()), \
             mock.patch.object(self.module, "_patch", side_effect=fake_patch), \
             mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, _out, _err = _run_main(self.module, argv)

        self.assertEqual(code, 0)
        ms_calls = [c for c in post_calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ms_calls), 1,
                          f"cr-close must emit exactly ONE cr-merged milestone POST, got {post_calls}")
        payload = ms_calls[0][1]
        self.assertEqual(payload.get("projectKey"), "test-key-crclose")
        self.assertEqual(payload.get("type"), "cr-merged")
        self.assertEqual(payload.get("label"), self.CR_ID)
        self.assertEqual(payload.get("commit"), "abc1234",
                          "the cr-merged commit must be the SAME sha passed via --commit")
        context = payload.get("context") or {}
        self.assertEqual(context.get("cr"), self.CR_ID)
        self.assertEqual(str(context.get("wave")), "2")

    def test_cr_close_emits_cr_merged_milestone_only_on_successful_close(self):
        """A bare 'no milestone on failure' check would ALSO pass vacuously
        today (the hook doesn't exist AT ALL yet, so nothing fires on either
        path). Pin both halves of the SAME invariant in one test: the failure
        path must emit ZERO milestones, and -- in the SAME test, so this
        cannot pass by simply never wiring the hook up -- the success path
        (already covered standalone above) must ALSO fire here, proving the
        zero-on-failure count is a genuine GUARD, not just permanent absence."""
        argv = ["cr-close", "--commit", "abc1234", "--agent", "test-agent", "--cr", self.CR_ID,
                "--project-dir", self.tmpdir]

        # -- failure half: PATCH close fails -> must NOT emit cr-merged --
        fail_calls = []

        def fake_post_during_failure(path, payload):
            fail_calls.append((path, payload))
            return {"ok": True}

        def fake_patch_fail(path, payload):
            return {"ok": False, "error": "boom"}

        with mock.patch.object(self.module, "_get", side_effect=self._get_recorder()), \
             mock.patch.object(self.module, "_patch", side_effect=fake_patch_fail), \
             mock.patch.object(self.module, "_post", side_effect=fake_post_during_failure):
            fail_code, _out, _err = _run_main(self.module, argv)

        self.assertNotEqual(fail_code, 0, "a FAILED close must surface non-zero")
        fail_ms_calls = [c for c in fail_calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(fail_ms_calls), 0,
                          "a FAILED close must NOT emit a cr-merged milestone "
                          f"(the CR is not actually merged): {fail_calls}")

        # -- success half, same test: proves the above zero-count is a real
        # guard and not just an unimplemented hook. --
        success_calls = []

        def fake_post_on_success(path, payload):
            success_calls.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        def fake_patch_ok(path, payload):
            return {"ok": True}

        with mock.patch.object(self.module, "_get", side_effect=self._get_recorder()), \
             mock.patch.object(self.module, "_patch", side_effect=fake_patch_ok), \
             mock.patch.object(self.module, "_post", side_effect=fake_post_on_success):
            ok_code, _out, _err = _run_main(self.module, argv)

        self.assertEqual(ok_code, 0)
        ok_ms_calls = [c for c in success_calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ok_ms_calls), 1,
                          f"a SUCCESSFUL close must emit exactly ONE cr-merged "
                          f"milestone, got {success_calls}")
        self.assertEqual(ok_ms_calls[0][1].get("type"), "cr-merged")


# ---------------------------------------------------------------------------
# gate-run -- the axi-PROXY wrapper. AC 148.
# ---------------------------------------------------------------------------

# A distinctive marker planted in every scripted TOON snapshot's `run.branch`
# field -- proves the axi detail was genuinely RELAYED to gate-run's own
# stdout (the caller/orchestrator's view), not swallowed behind a terse
# "ingest: ok=True" line.
_RELAY_MARKER = "gate-run-relay-marker-xyz123"

# Four progressive snapshots of a 9-step no-mistakes ladder. R1/R2/R3 are
# NOT resolved (no top-level `outcome`); FINAL is. Real elapsed time between
# R1 and R3 exceeds the >=2s §S2b cadence (CR-CRU-008 `_Narrator` default)
# so a correctly-throttled implementation has exactly one legitimate window
# to fire an INTERIM post before the unconditional final seal.
_SNAPSHOT_1 = (
    'run:\n'
    '  id: "gate-run-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[3]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
)
_SNAPSHOT_2 = (
    'run:\n'
    '  id: "gate-run-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: abc1234\n'
    '  findings: 1\n'
    '  steps[6]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
)
_SNAPSHOT_3 = (
    'run:\n'
    '  id: "gate-run-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: abc1234\n'
    '  findings: 1\n'
    '  steps[8]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
    '    push,completed,0,40\n'
    '    pr,skipped,0,10\n'
)
_SNAPSHOT_FINAL = (
    'run:\n'
    '  id: "gate-run-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 1\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
    '    push,completed,0,40\n'
    '    pr,skipped,0,10\n'
    '    ci,skipped,0,10\n'
    'outcome: passed\n'
)

# Real `no-mistakes axi` contract (confirmed via `no-mistakes axi ... --help`,
# per orchestrator correction 2026-07-18): `axi run --intent "<goal>" [--yes]`
# BLOCKS and, once resolved, prints the FINAL TOON snapshot. `axi status
# [--run ID]` is the separate ONE-SHOT poll target -- it returns whatever the
# active/most-recent run currently looks like, WITHOUT disturbing it (this is
# exactly the shape of tests/fixtures/no-mistakes-axi-status.toon). There is
# no single "streaming stdout" from one call; gate-run must launch `axi run`
# in the background and separately POLL `axi status` while it is in flight.
#
# The fake below is TWO behaviours in one script, dispatched on argv[0:2]:
#   `axi run`    -- writes progressive snapshots to a shared STATE_FILE (env
#                   GATE_RUN_FAKE_STATE) as steps complete over ~3 real
#                   seconds (comfortably past the >=2s §S2b cadence, CR-CRU-008
#                   `_Narrator` default -- the only concrete cadence constant
#                   this codebase defines), then prints the FINAL resolved
#                   TOON to its OWN stdout and exits -- mirroring axi run's
#                   real blocking-until-outcome behavior.
#   `axi status` -- reads whatever is CURRENTLY in STATE_FILE and prints it,
#                   fast, no sleep -- mirroring the real non-disturbing poll.
_FAKE_NO_MISTAKES_BODY = '''
import json
import os
import sys
import time

argv = sys.argv[1:]
state_file = os.environ.get("GATE_RUN_FAKE_STATE")


def _write_state(text):
    if state_file:
        with open(state_file, "w") as f:
            f.write(text)


if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "run":
    argv_file = os.environ.get("GATE_RUN_FAKE_ARGV_FILE")
    if argv_file:
        with open(argv_file, "w") as f:
            json.dump(argv, f)
    _write_state({s1!r})
    time.sleep(1.0)
    _write_state({s2!r})
    time.sleep(1.5)
    _write_state({s3!r})
    time.sleep(0.8)
    _write_state({sf!r})
    sys.stdout.write({sf!r})
    sys.exit(0)
elif len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    content = ""
    if state_file and os.path.exists(state_file):
        with open(state_file) as f:
            content = f.read()
    sys.stdout.write(content or {s1!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''.format(s1=_SNAPSHOT_1, s2=_SNAPSHOT_2, s3=_SNAPSHOT_3, sf=_SNAPSHOT_FINAL)


class GateRunAxiProxyTest(_BaseClientVerbTest):
    PROJECT_KEY = "test-key-gaterun"

    def setUp(self):
        super().setUp()
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.argv_file = os.path.join(self.tmpdir, "argv.json")
        self.state_file = os.path.join(self.tmpdir, "state.toon")
        os.environ["GATE_RUN_FAKE_ARGV_FILE"] = self.argv_file
        os.environ["GATE_RUN_FAKE_STATE"] = self.state_file

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_RUN_FAKE_ARGV_FILE", None)
        os.environ.pop("GATE_RUN_FAKE_STATE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        super().tearDown()

    def test_gate_run_polls_status_for_interim_gates_and_seals_final_from_run_outcome(self):
        """gate-run must (1) launch `axi run --intent ...` in the BACKGROUND
        (not block on it immediately), (2) POLL `axi status` at the throttled
        §S2b cadence WHILE it is in flight, decoding each snapshot via
        clients/toon.py and POSTing throttled INTERIM gates, (3) POST the
        FINAL sealing gate from `axi run`'s own resolved outcome once it
        exits, (4) do all of this WITHOUT the caller issuing any POST itself,
        and (5) still RELAY the axi detail to the caller's own stdout (proxy
        role)."""
        calls = []

        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        argv = ["gate-run", "--intent", "verify the auth flow refactor",
                "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, _err = _run_main(self.module, argv)

        self.assertEqual(code, 0)

        # (5) proxy role: the underlying axi detail must be genuinely
        # relayed to the CALLER's own stdout, not swallowed behind a terse
        # ingest confirmation line.
        self.assertIn(_RELAY_MARKER, out,
                       "gate-run must relay the no-mistakes axi detail to its "
                       "own stdout (proxy role) -- the caller must see it")

        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        # (2) + (3): at least one throttled interim (from an `axi status`
        # poll while the run was still in flight) BEFORE an unconditional
        # final seal (from `axi run`'s own resolved outcome). Upper bound is
        # generous (poll cadence is a GREEN implementation detail) but still
        # proves throttling isn't posting on every tick of a fast loop.
        self.assertGreaterEqual(len(gate_calls), 2,
                                 f"expected >=1 interim + 1 final gate POST, got {calls}")
        self.assertLessEqual(len(gate_calls), 5,
                              f"throttling must bound the poll-driven interim posts, got {calls}")
        # (4) the caller issues NO POST itself -- gate-run owns ALL plumbing,
        # and nothing besides /api/v2/gates should ever be hit here.
        self.assertEqual(calls, gate_calls,
                          "gate-run owns ALL Crucible plumbing -- the caller "
                          "must not have to issue any POST itself, and no "
                          "other endpoint should be hit")

        *interim, final = gate_calls
        self.assertGreaterEqual(len(interim), 1)

        final_gate = final[1].get("gate", {})
        self.assertEqual(final_gate.get("outcome"), "passed",
                          "the final gate's outcome must match `axi run`'s resolved outcome")
        self.assertEqual(len(final_gate.get("steps", [])), 9)
        final_names = [s.get("name") for s in final_gate.get("steps", [])]
        self.assertEqual(
            final_names,
            ["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"],
        )

        for path, payload in interim:
            interim_gate = payload.get("gate", {})
            # bound: an interim gate (from an `axi status` POLL while the
            # run was still in flight) must be a NOT-YET-COMPLETE ladder,
            # strictly fewer steps than the final's full 9.
            self.assertLess(len(interim_gate.get("steps", [])), 9,
                             f"an interim gate must be a PARTIAL snapshot, got {interim_gate}")
            self.assertIn(interim_gate.get("outcome"), ("checks-passed", "passed",
                                                          "failed", "cancelled"),
                           "gate.outcome is REQUIRED by the server and must be a valid "
                           "GATE_OUTCOMES member even for an interim snapshot")

        # --intent must flow down to the underlying `axi run` invocation
        # (NOT to `axi status`, which takes no --intent).
        self.assertTrue(os.path.exists(self.argv_file),
                         "no-mistakes `axi run` was never invoked")
        with open(self.argv_file) as f:
            proxied_argv = json.load(f)
        self.assertEqual(proxied_argv[:2], ["axi", "run"],
                          f"gate-run must invoke `no-mistakes axi run`, got argv={proxied_argv}")
        self.assertIn("verify the auth flow refactor", proxied_argv,
                      f"--intent must be passed down to `axi run`, got argv={proxied_argv}")

    def test_gate_run_missing_no_mistakes_executable_fails_cleanly(self):
        empty_bin = tempfile.mkdtemp(prefix="empty-path-")
        os.environ["PATH"] = empty_bin
        calls = []

        def fake_post(path, payload):
            calls.append((path, payload))
            return {"ok": True}

        try:
            argv = ["gate-run", "--intent", "test intent", "--project-dir", self.tmpdir]
            with mock.patch.object(self.module, "_post", side_effect=fake_post):
                code, _out, err = _run_main(self.module, argv)
        finally:
            shutil.rmtree(empty_bin, ignore_errors=True)

        _assert_subcommand_recognized(self, err)
        self.assertNotEqual(code, 0,
                             "gate-run must fail cleanly (non-zero exit) when "
                             "no-mistakes is not on PATH, not crash silently or return 0")
        self.assertEqual(calls, [],
                          "no gate should ever be posted when no-mistakes could not be invoked")


if __name__ == "__main__":
    unittest.main()
