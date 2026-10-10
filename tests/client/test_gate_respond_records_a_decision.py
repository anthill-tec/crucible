"""`gate-respond` records a decision on the board (§G4/§G5 server contract,
AC2 client half, AC3, AC5, G6), and shares its streaming/sealing mechanics
with `gate-run` rather than re-implementing them (G1, AC7's shared-runner
half).

Ground truth, measured directly from `clients/_crucible_axi.py` before this
slice: `cmd_gate_run` is the ONLY axi-proxy command (there is no
`cmd_gate_respond`), and nothing in the module ever POSTs to
`/api/v2/gate-decisions` -- the only outbound POST paths touched anywhere in
the gate machinery are `/api/v2/gates` (`post_gate`) and
`/api/v2/milestones` (`post_milestone`). Every test below therefore fails
today because the client never reaches the new endpoint at all (`gate-respond`
isn't even argparse-registered -- confirmed by the sibling
`test_gate_respond_argv_and_flag_surface.py`), not because of a server-side
mismatch.

The server-side contract this file's POST assertions are pinned against
(`handleGateDecisions`, measured by reading it directly): a decision rides as
`POST /api/v2/gate-decisions` with body `{projectKey, agentId, context?,
decision: {runId, action, step?, findings?, addedFinding?, instructions?,
reason?}}`, where `decision.runId` is REQUIRED -- a non-empty string, 400
without it -- and answers `201 {ok, changed, decision: <id>}`. `findings`
must be an array of finding-id STRINGS (400 if not) and `addedFinding` must
be ONE JSON object (400 if it is a string or an array) -- so the client must
SPLIT the `--findings` CLI string into an id list and PARSE the `--add-finding`
JSON string into an object before it reaches this POST, even though both
travel to `no-mistakes axi respond` itself as raw, unparsed strings (proven
separately by the sibling argv file).

HOW "accepted" vs "refused" is told apart here (G6 vs AC5), derived from two
hard facts rather than guessed: (1) `decision.runId` is SERVER-REQUIRED, so a
`no-mistakes` snapshot that names no `run.id` at all cannot produce a POSTable
decision in the first place; (2) the fleet's own established "wait elapsed"
shape (seen in the sibling run-in-flight/never-sealed harnesses) is a FULL
run snapshot (a `run:` block, `run.id`, a ladder) that ALSO carries a
no-mistakes `error:` line (e.g. "wait of 8m0s elapsed while driving the
run") -- so an `error` field alone cannot be the refusal signal, or G6's own
"an elapsed wait is not a failed run" would be unreachable. The discriminator
this file therefore uses is: a snapshot carrying a `run.id` is ACCEPTED (its
decision posts, outcome resolved or not -- G6); a snapshot with NO `run.id`
at all (a parse failure, or a bare error with no run touched) is REFUSED (AC5)
and posts nothing.

Module-loading, the fake-no-mistakes-on-PATH idiom and `_run_main` are the
same REPO_ROOT-relative, by-file-path convention every sibling harness in
this directory already uses. The configurable fake tool here (one script,
behaviour driven by two env-var-pointed files written per test) generalizes
the sibling "immediate single snapshot" fakes to cover `axi run` AND
`axi respond` from the ONE process, which the shared-locus test needs to
drive both verbs through one client in one test.

Invocation:
    python3 -m pytest tests/client/test_gate_respond_records_a_decision.py -q
Fallback:
    python3 tests/client/test_gate_respond_records_a_decision.py
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
CLIENTS_DIR = REPO_ROOT / "clients"
BUN_CLIENT = CLIENTS_DIR / "bun-crucible.py"

GATE_DECISIONS_PATH = "/api/v2/gate-decisions"
GATES_PATH = "/api/v2/gates"


def _load_module_by_path(path, cache_key):
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_bun_module(cache_key):
    return _load_module_by_path(BUN_CLIENT, cache_key)


def _run_main(module, argv):
    full_argv = [str(BUN_CLIENT)] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
         contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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


def _assert_verb_recognized(testcase, err):
    testcase.assertNotIn(
        "invalid choice", err,
        f"gate-respond must be a registered subcommand: {err!r}")
    testcase.assertNotIn(
        "unrecognized arguments", err,
        f"gate-respond's own flags must be recognized: {err!r}")


# ---------------------------------------------------------------------------
# A CONFIGURABLE fake `no-mistakes`: behaviour (stdout text, exit code) is
# read from two files whose paths come in through env vars, set fresh per
# test/per call via `_set_snapshot`/`_set_refusal` below. Handles `axi run`,
# `axi respond` and `axi status` from the SAME process, so one test can drive
# both `gate-run` and `gate-respond` through the one fake tool.
# ---------------------------------------------------------------------------

_FAKE_NO_MISTAKES_BODY = '''
import os
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "respond", "status"):
    stdout_path = os.environ.get("GATE_RESPOND_FAKE_STDOUT_FILE")
    exit_path = os.environ.get("GATE_RESPOND_FAKE_EXIT_FILE")
    text = ""
    if stdout_path and os.path.exists(stdout_path):
        with open(stdout_path) as f:
            text = f.read()
    code = 0
    if exit_path and os.path.exists(exit_path):
        with open(exit_path) as f:
            code = int(f.read().strip() or "0")
    if text:
        sys.stdout.write(text)
    sys.exit(code)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''


class _ConfigurableFakeNoMistakesMixin:
    def _install_fake_no_mistakes(self):
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="gate-respond-decision-fake-nm-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, 0o700)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.fake_state_dir = tempfile.mkdtemp(prefix="gate-respond-decision-fake-state-")
        self.stdout_file = os.path.join(self.fake_state_dir, "stdout.txt")
        self.exit_file = os.path.join(self.fake_state_dir, "exit.txt")
        os.environ["GATE_RESPOND_FAKE_STDOUT_FILE"] = self.stdout_file
        os.environ["GATE_RESPOND_FAKE_EXIT_FILE"] = self.exit_file

    def _teardown_fake_no_mistakes(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_RESPOND_FAKE_STDOUT_FILE", None)
        os.environ.pop("GATE_RESPOND_FAKE_EXIT_FILE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.fake_state_dir, ignore_errors=True)

    def _set_snapshot(self, text, exit_code=0):
        with open(self.stdout_file, "w") as f:
            f.write(text)
        with open(self.exit_file, "w") as f:
            f.write(str(exit_code))


def _fake_post(calls, gate_decision_id="dec-test-001"):
    def _post(path, payload):
        calls.append((path, copy.deepcopy(payload)))
        if path == GATE_DECISIONS_PATH:
            return {"ok": True, "changed": True, "decision": gate_decision_id}
        return {"ok": True}
    return _post


# ── Fixture snapshots ────────────────────────────────────────────────────

# ACCEPTED, resolved: a normal completed run, outcome `passed`.
_ACCEPTED_RESOLVED_SNAPSHOT = (
    'run:\n'
    '  id: "accepted-resolved-run-001"\n'
    '  branch: gate-respond-decision-marker\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    fix,completed,0,10\n'
    'outcome: passed\n'
)

# ACCEPTED, G6 "wait elapsed": a full run snapshot (run.id present, a ladder
# with an UNRESOLVED step) carrying no-mistakes' own "wait elapsed" error --
# the exact shape the fleet's sibling held-run fixtures already establish for
# `gate-run`'s own bounded-wait return. No top-level `outcome` key.
_WAIT_ELAPSED_SNAPSHOT = (
    'run:\n'
    '  id: "wait-elapsed-run-099"\n'
    '  branch: gate-respond-wait-elapsed-marker\n'
    '  status: running\n'
    '  head: def5678\n'
    '  findings: 1\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    fix,running,1,500\n'
    'error: wait of 3m0s elapsed while driving the run\n'
)

# REFUSED: a bare no-mistakes error envelope -- no `run` key at all, so there
# is no run id a decision could even be keyed by.
_ERROR_ENVELOPE_SNAPSHOT = (
    'error: unknown finding id referenced in --findings: f9\n'
)


class GateRespondBaseHarness(_ConfigurableFakeNoMistakesMixin, unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")
    PROJECT_KEY = "test-key-gate-respond-decision"

    def setUp(self):
        self._install_fake_no_mistakes()
        self.module = _load_bun_module(
            f"gate_respond_decision_{self._testMethodName}_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="gate-respond-decision-")
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
        self._teardown_fake_no_mistakes()

    def _base_argv(self, **extra):
        argv = ["gate-respond", "--agent", "test-agent", "--project-dir", self.tmpdir]
        for flag, value in extra.items():
            argv += [f"--{flag.replace('_', '-')}", value]
        return argv

    def _decision_calls(self, calls):
        return [c for c in calls if c[0] == GATE_DECISIONS_PATH]

    def _gate_calls(self, calls):
        return [c for c in calls if c[0] == GATES_PATH]


# ---------------------------------------------------------------------------
# AC2 (client half) -- an accepted respond posts EXACTLY one decision,
# carrying the action and the EXACT finding ids, keyed by the snapshot's own
# run id.
# ---------------------------------------------------------------------------

class GateRespondPostsExactlyOneDecisionTest(GateRespondBaseHarness):

    def test_accepted_respond_posts_one_decision_with_the_action_and_exact_finding_ids(self):
        self._set_snapshot(_ACCEPTED_RESOLVED_SNAPSHOT, 0)
        calls = []
        argv = self._base_argv(action="fix", findings="finding-7,finding-12")
        with mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):
            code, out, err = _run_main(self.module, argv)

        _assert_verb_recognized(self, err)
        decision_calls = self._decision_calls(calls)
        self.assertEqual(
            len(decision_calls), 1,
            f"an accepted respond must post EXACTLY one gate-decision event, "
            f"got {len(decision_calls)}: {decision_calls} "
            f"(code={code} stdout={out!r} stderr={err!r})")
        payload = decision_calls[0][1]
        self.assertEqual(payload.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(payload.get("agentId"), "test-agent")
        decision = payload.get("decision") or {}
        self.assertEqual(
            decision.get("runId"), "accepted-resolved-run-001",
            f"decision.runId must be taken from the no-mistakes snapshot's "
            f"own run.id, got decision={decision!r}")
        self.assertEqual(decision.get("action"), "fix")
        self.assertEqual(
            decision.get("findings"), ["finding-7", "finding-12"],
            f"decision.findings must be the EXACT finding ids selected, as a "
            f"real list (not the raw comma string), got {decision!r}")

    def test_decision_carries_added_finding_as_a_parsed_object_and_the_optional_text_fields(self):
        self._set_snapshot(_ACCEPTED_RESOLVED_SNAPSHOT, 0)
        calls = []
        add_finding_json = '{"title": "missing null check", "severity": "high"}'
        argv = self._base_argv(
            action="fix", findings="f1",
            add_finding=add_finding_json,
            instructions="patch validate() before merging",
            reason="flaky under load, approved by lead",
            step="test",
        )
        with mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):
            code, out, err = _run_main(self.module, argv)

        _assert_verb_recognized(self, err)
        decision_calls = self._decision_calls(calls)
        self.assertEqual(
            len(decision_calls), 1,
            f"expected exactly one decision POST, got {decision_calls} "
            f"(code={code} stdout={out!r} stderr={err!r})")
        decision = decision_calls[0][1].get("decision") or {}
        self.assertEqual(
            decision.get("addedFinding"), {"title": "missing null check", "severity": "high"},
            f"decision.addedFinding must be the PARSED JSON object (the server "
            f"400s a string/array), got {decision.get('addedFinding')!r}")
        self.assertEqual(decision.get("instructions"), "patch validate() before merging")
        self.assertEqual(decision.get("reason"), "flaky under load, approved by lead")
        self.assertEqual(decision.get("step"), "test")


# ---------------------------------------------------------------------------
# AC3 + AC7 (shared-runner half) -- `gate-respond` reaches the SAME
# `stream_axi_ladder`/`gate_from_axi` functions `gate-run` uses, proven by
# driving BOTH verbs through one client and watching the SAME wrapped
# callables get invoked for each -- not source text, not a re-implemented
# copy with the same name.
# ---------------------------------------------------------------------------

class GateRespondReusesGateRunSharedCodeTest(GateRespondBaseHarness):

    def test_gate_respond_calls_the_same_stream_axi_ladder_and_gate_from_axi_gate_run_uses(self):
        axi_mod = self.module._axi()
        calls = []

        with mock.patch.object(axi_mod, "stream_axi_ladder",
                               wraps=axi_mod.stream_axi_ladder) as ladder_spy, \
             mock.patch.object(axi_mod, "gate_from_axi",
                               wraps=axi_mod.gate_from_axi) as seal_spy, \
             mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):

            self._set_snapshot(_ACCEPTED_RESOLVED_SNAPSHOT, 0)
            run_code, _run_out, run_err = _run_main(self.module, [
                "gate-run", "--intent", "verify the refactor",
                "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])
            self.assertEqual(run_code, 0,
                             f"sanity: gate-run must succeed first; stderr={run_err!r}")
            ladder_calls_after_run = ladder_spy.call_count
            seal_calls_after_run = seal_spy.call_count
            self.assertGreaterEqual(
                seal_calls_after_run, 1,
                "sanity check failed: gate-run itself never reached gate_from_axi")

            self._set_snapshot(_ACCEPTED_RESOLVED_SNAPSHOT, 0)
            respond_argv = self._base_argv(action="approve")
            respond_code, respond_out, respond_err = _run_main(self.module, respond_argv)

        _assert_verb_recognized(self, respond_err)
        self.assertEqual(
            seal_spy.call_count, seal_calls_after_run + 1,
            f"gate-respond must seal its final gate through the SAME shared "
            f"gate_from_axi gate-run uses, not a re-implemented copy -- "
            f"call_count stayed at {seal_spy.call_count} after gate-respond "
            f"(code={respond_code} stdout={respond_out!r} stderr={respond_err!r})")
        self.assertGreaterEqual(
            ladder_spy.call_count, ladder_calls_after_run + 1,
            f"gate-respond must stream its ladder through the SAME shared "
            f"stream_axi_ladder gate-run uses -- call_count did not increase "
            f"(stderr={respond_err!r})")


# ---------------------------------------------------------------------------
# AC5 -- a refused respond is reported, and posts no decision.
# ---------------------------------------------------------------------------

class GateRespondRefusedPostsNoDecisionTest(GateRespondBaseHarness):

    def test_a_no_mistakes_error_envelope_with_no_run_posts_no_decision_and_is_reported(self):
        self._set_snapshot(_ERROR_ENVELOPE_SNAPSHOT, 0)
        calls = []
        argv = self._base_argv(action="fix")
        with mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):
            code, out, err = _run_main(self.module, argv)

        _assert_verb_recognized(self, err)
        self.assertNotEqual(
            code, 0,
            f"a respond refused by no-mistakes (an error envelope with no run "
            f"touched) must be REPORTED as a failure, got code=0 "
            f"stdout={out!r} stderr={err!r}")
        decision_calls = self._decision_calls(calls)
        self.assertEqual(
            decision_calls, [],
            f"a refused respond must post NO decision, got {decision_calls}")

    def test_a_non_zero_exit_with_no_snapshot_posts_no_decision_and_is_reported(self):
        self._set_snapshot("", 1)
        calls = []
        argv = self._base_argv(action="approve")
        with mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):
            code, out, err = _run_main(self.module, argv)

        _assert_verb_recognized(self, err)
        self.assertNotEqual(
            code, 0,
            f"a non-zero exit with no parseable snapshot must be REPORTED as "
            f"a failure, got code=0 stdout={out!r} stderr={err!r}")
        decision_calls = self._decision_calls(calls)
        self.assertEqual(
            decision_calls, [],
            f"a refused respond must post NO decision, got {decision_calls}")


# ---------------------------------------------------------------------------
# G6 -- an accepted respond whose wait elapses still posts its decision (an
# elapsed wait is not a failed run).
# ---------------------------------------------------------------------------

class GateRespondWaitElapsedStillPostsDecisionTest(GateRespondBaseHarness):

    def test_an_accepted_respond_whose_wait_elapses_still_posts_exactly_one_decision(self):
        self._set_snapshot(_WAIT_ELAPSED_SNAPSHOT, 0)
        calls = []
        argv = self._base_argv(action="approve")
        with mock.patch.object(self.module, "_post", side_effect=_fake_post(calls)):
            code, out, err = _run_main(self.module, argv)

        _assert_verb_recognized(self, err)
        decision_calls = self._decision_calls(calls)
        self.assertEqual(
            len(decision_calls), 1,
            f"an accepted respond whose wait elapses (no resolved outcome, "
            f"but a real run.id and ladder) must still record its decision -- "
            f"an elapsed wait is not a failed run (G6); got {decision_calls} "
            f"(code={code} stdout={out!r} stderr={err!r})")
        decision = decision_calls[0][1].get("decision") or {}
        self.assertEqual(decision.get("runId"), "wait-elapsed-run-099")
        self.assertEqual(decision.get("action"), "approve")
        # Consistent with how `gate-run` itself treats an unresolved run (the
        # same shared sealing code, AC3): no OUTCOME was reached, so no FINAL
        # gate is sealed for this exit -- the decision is its own record and
        # does not ride on a seal that never happened.
        gate_calls = self._gate_calls(calls)
        self.assertEqual(
            gate_calls, [],
            f"an unresolved run must seal no final gate (the same rule "
            f"gate-run itself follows) -- got {gate_calls}")


# ---------------------------------------------------------------------------
# A malformed `--add-finding` is refused BEFORE no-mistakes is launched: the
# board could not record the decision, so the tool is never asked to take it.
# `cmd_gate_respond` is called directly with a recording ops stand-in, and
# `subprocess.Popen` is patched so a launch of any kind is observed, not run.
# ---------------------------------------------------------------------------

class _RecordingOps:
    """The subset of `ClientOps` `cmd_gate_respond` reaches before a launch:
    the agent id, the envelope context, the envelope itself -- and the POSTs,
    recorded so a refusal that still reached the board is caught."""

    def __init__(self):
        self.emit_calls = []
        self.post_calls = []

    def agent_id(self, _args):
        return "add-finding-refusal-agent"

    def context(self, project_dir, agent_id=None):
        return {"projectDir": project_dir, "agentId": agent_id}

    def emit(self, verb, ok, fields, context, warnings, legacy):
        self.emit_calls.append({"verb": verb, "ok": ok,
                                "fields": copy.deepcopy(fields),
                                "legacy": legacy})

    def post(self, path, payload):
        self.post_calls.append((path, copy.deepcopy(payload)))
        return {"ok": True}

    def post_gate(self, *args, **kwargs):
        self.post_calls.append((GATES_PATH, (args, kwargs)))
        return {"ok": True}

    def project_key(self, _project_dir):
        return "add-finding-refusal-project"


class _RespondArgs:
    """Exactly the attributes `gate_respond_argv`/`gate_decision_body` read."""

    def __init__(self, add_finding, action="fix"):
        self.action = action
        self.findings = None
        self.add_finding = add_finding
        self.instructions = None
        self.reason = None
        self.step = None
        self.wait = None
        self.agent = "add-finding-refusal-agent"


class GateRespondMalformedAddFindingRefusedBeforeLaunchTest(unittest.TestCase):

    def setUp(self):
        bun = _load_bun_module(
            f"gate_respond_add_finding_{self._testMethodName}_under_test")
        self.axi = bun._axi()
        self.project_dir = tempfile.mkdtemp(prefix="gate-respond-add-finding-")

    def tearDown(self):
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def _assert_refused_before_launch(self, add_finding):
        ops = _RecordingOps()
        with mock.patch.object(self.axi.subprocess, "Popen") as popen, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()) as err:
            code = self.axi.cmd_gate_respond(
                _RespondArgs(add_finding), self.project_dir,
                "/nonexistent/no-mistakes", ops)

        self.assertEqual(
            code, 1,
            f"a malformed --add-finding {add_finding!r} must exit 1, got "
            f"{code} (stderr={err.getvalue()!r})")
        self.assertEqual(
            popen.call_count, 0,
            f"no-mistakes must never be launched for a malformed "
            f"--add-finding {add_finding!r}; Popen was called with "
            f"{popen.call_args_list}")
        self.assertEqual(
            len(ops.emit_calls), 1,
            f"the refusal must emit exactly one envelope, got {ops.emit_calls}")
        emitted = ops.emit_calls[0]
        self.assertEqual(emitted["verb"], "gate-respond")
        self.assertIs(
            emitted["ok"], False,
            f"the refusal's envelope must be ok=False, got {emitted!r}")
        self.assertIn("--add-finding", emitted["legacy"],
                      f"the refusal must name the flag it refused, got {emitted!r}")
        self.assertEqual(
            ops.post_calls, [],
            f"a refused respond must reach the board with nothing, got "
            f"{ops.post_calls}")

    def test_an_add_finding_that_is_not_json_is_refused_before_no_mistakes_launches(self):
        self._assert_refused_before_launch("{not json")

    def test_an_add_finding_whose_json_is_not_an_object_is_refused_before_no_mistakes_launches(self):
        for value in ('["a", "b"]', '"a bare string"', "42", "null"):
            with self.subTest(add_finding=value):
                self._assert_refused_before_launch(value)


# ---------------------------------------------------------------------------
# A respond's gate events carry the intent `respond: <action>` -- the intent
# `cmd_gate_respond` hands the shared runner, which both streams the interim
# ladder under it and seals the final gate with it.
# ---------------------------------------------------------------------------

class GateRespondGateEventsCarryRespondIntentTest(GateRespondBaseHarness):

    def test_a_respond_streams_and_seals_its_gate_events_under_the_respond_action_intent(self):
        axi_mod = self.module._axi()
        for action in ("fix", "approve"):
            with self.subTest(action=action):
                self._set_snapshot(_ACCEPTED_RESOLVED_SNAPSHOT, 0)
                calls = []
                with mock.patch.object(axi_mod, "drive_axi_run",
                                       wraps=axi_mod.drive_axi_run) as runner_spy, \
                     mock.patch.object(axi_mod, "stream_axi_ladder",
                                       wraps=axi_mod.stream_axi_ladder) as ladder_spy, \
                     mock.patch.object(self.module, "_post",
                                       side_effect=_fake_post(calls)):
                    code, out, err = _run_main(self.module,
                                               self._base_argv(action=action))

                _assert_verb_recognized(self, err)
                expected = f"respond: {action}"
                self.assertEqual(runner_spy.call_count, 1,
                                 f"gate-respond must drive the shared runner "
                                 f"once (stderr={err!r})")
                self.assertEqual(
                    runner_spy.call_args.args[2], expected,
                    f"the runner's intent must be {expected!r}, got "
                    f"{runner_spy.call_args!r}")
                self.assertEqual(ladder_spy.call_count, 1)
                self.assertEqual(
                    ladder_spy.call_args.args[2], expected,
                    f"interim ladder gates must stream under {expected!r}, got "
                    f"{ladder_spy.call_args!r}")
                gate_calls = self._gate_calls(calls)
                self.assertGreaterEqual(
                    len(gate_calls), 1,
                    f"a resolved respond must seal a gate (code={code} "
                    f"stdout={out!r} stderr={err!r})")
                for _path, payload in gate_calls:
                    self.assertEqual(
                        (payload.get("gate") or {}).get("intent"), expected,
                        f"every gate event a respond posts must carry intent "
                        f"{expected!r}, got {payload!r}")


if __name__ == "__main__":
    unittest.main()
