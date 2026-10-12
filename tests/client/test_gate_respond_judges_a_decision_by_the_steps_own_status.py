"""§S1 of the gate-decision/release change request: an ACCEPTED decision is
recorded and reported as accepted, even when the tool's own respond answer
names no run at all (a wait that elapsed mid-drive), and a HELD exit of
either axi-proxy verb points its caller at the reattach command.

GROUND TRUTH, measured directly against `clients/_crucible_axi.py` on this
branch. `cmd_gate_respond` never reads `no-mistakes axi status` before
launching `axi respond` -- there is no such call anywhere in the module.
`gate_decision_recorder` (its `on_final` hook) decides ACCEPTED vs REFUSED
from the RESPOND ANSWER's own `run.id` alone (`axi_run_id(decoded)`): a
snapshot that names no run is read as a flat refusal, so

  * no decision ever reaches `/api/v2/gate-decisions` for an answer that
    names no run, even when the step it answered has plainly moved past
    `awaiting_approval` by the time the caller can look again;
  * the envelope it reports carries `decision: none` and `inFlight: false`
    (the REFUSED branch hard-codes `held=False` when it builds
    `gate_run_result_fields`), never the recorded decision id or a true
    in-flight flag;
  * `--step` is never read off anything but `args.step` -- there is no
    status read to default it from, so an omitted `--step` simply never
    reaches the decision body at all.

Separately, `unsealed_run_report` (the HELD report every axi-proxy exit that
sealed nothing goes through) names exactly one next move today --
`AXI_REATTACH_HELP = "inspect with \\`axi status\\` and reattach"` -- which
never names the command that actually reattaches a held run
(`gate-run --intent "<intent>"`) or the release the drive was given.

Every assertion below therefore fails against TODAY's tree for one of the
reasons named above, never on an import or fixture error: the fake tool
below is a plain, already-supported two-subcommand stand-in
(`axi status` / `axi run` / `axi respond`), on PATH exactly like every
sibling fleet harness in this directory.

Driven the same way the sibling fleet harnesses drive a verb: the REAL
argparse `main()` of each of the five clients, against a fake `no-mistakes`
answering from scripted TOON snapshot files, with `_post` and `_emit_axi`
patched on the loaded module so both the wire traffic and the envelope a
caller sees are recorded.

Invocation:
    python3 -m pytest tests/client/test_gate_respond_judges_a_decision_by_the_steps_own_status.py -q
Fallback:
    python3 tests/client/test_gate_respond_judges_a_decision_by_the_steps_own_status.py
"""

import contextlib
import copy
import importlib.util
import io
import itertools
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path
from unittest import mock

from tests.client.test_cr054_fleet_inventory import CLIENT_FILES
from tests.client.test_client_fleet_envelope_census import install_project_limits

REPO_ROOT = Path(__file__).resolve().parents[2]

GATES_PATH = "/api/v2/gates"
GATE_DECISIONS_PATH = "/api/v2/gate-decisions"

# The env keys the fleet's own `context` block reads, cleared for every drive
# so an ambient orchestrator session can never colour a result asserted on
# here -- the established rule every sibling gate harness in this directory
# applies the same way.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

_COUNTER = itertools.count()

_Drive = namedtuple("Drive", "code out err posts decisions gates envelopes")


def _load_module(path, cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client.py"] + argv), mock.patch.dict(os.environ), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as e:
            code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


# A fake `no-mistakes` whose `axi status` answer flips the moment `axi run`/
# `axi respond` is LAUNCHED (a marker file written at the very top of that
# subcommand, before anything else) -- so a status read issued BEFORE the
# drive starts sees the PRE file (the step still awaiting approval) and every
# status read issued once the drive is under way, whether a poll mid-run or
# one more read after the process exits, sees the POST file (the step as it
# looks afterwards). `axi run`/`axi respond` themselves always answer from the
# RESPOND file -- the tool's own terminal answer -- after a short sleep, long
# enough that the launch has visibly happened before anything reads status
# again.
_FAKE_NO_MISTAKES_BODY = '''
import os
import sys
import time

argv = sys.argv[1:]

def _read(path):
    if path and os.path.exists(path):
        with open(path) as f:
            return f.read()
    return ""

marker = os.environ.get("GATE_JUDGE_FAKE_MARKER_FILE")
pre_file = os.environ.get("GATE_JUDGE_FAKE_PRE_FILE")
post_file = os.environ.get("GATE_JUDGE_FAKE_POST_FILE")
final_file = os.environ.get("GATE_JUDGE_FAKE_FINAL_FILE")
run_seconds = float(os.environ.get("GATE_JUDGE_FAKE_RUN_SECONDS", "0.05"))

if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    if marker and os.path.exists(marker):
        sys.stdout.write(_read(post_file))
    else:
        sys.stdout.write(_read(pre_file))
    sys.exit(0)
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "respond"):
    if marker:
        with open(marker, "w") as f:
            f.write("1")
    time.sleep(run_seconds)
    sys.stdout.write(_read(final_file))
    sys.exit(0)
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''


def _drive(client_key, client_path, argv_tail, pre_snapshot, post_snapshot,
           final_snapshot, run_seconds=0.2):
    """Drive one client's REAL `main()` against the fake tool above, with
    `_post` and `_emit_axi` patched on the loaded module so both the wire and
    the envelope are captured."""
    cache_key = f"gate_judge_{client_key}_{next(_COUNTER)}"
    module = _load_module(client_path, cache_key)
    tmpdir = tempfile.mkdtemp(prefix="gate-judge-")
    fake_bin_dir = tempfile.mkdtemp(prefix="gate-judge-bin-")
    state_dir = tempfile.mkdtemp(prefix="gate-judge-state-")
    saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
    saved_path = os.environ.get("PATH", "")
    try:
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY=gate-judge-{client_key}-key\n")
            f.write(f"CRUCIBLE_PROJECT_NAME=gate-judge-{client_key}\n")
        install_project_limits(tmpdir)
        for k in ENV_KEYS:
            os.environ.pop(k, None)

        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, os.stat(fake_path).st_mode
                 | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        pre_file = os.path.join(state_dir, "pre.toon")
        post_file = os.path.join(state_dir, "post.toon")
        final_file = os.path.join(state_dir, "final.toon")
        marker_file = os.path.join(state_dir, "respond-launched.marker")
        with open(pre_file, "w") as f:
            f.write(pre_snapshot)
        with open(post_file, "w") as f:
            f.write(post_snapshot)
        with open(final_file, "w") as f:
            f.write(final_snapshot)

        os.environ["PATH"] = fake_bin_dir + os.pathsep + saved_path
        os.environ["GATE_JUDGE_FAKE_PRE_FILE"] = pre_file
        os.environ["GATE_JUDGE_FAKE_POST_FILE"] = post_file
        os.environ["GATE_JUDGE_FAKE_FINAL_FILE"] = final_file
        os.environ["GATE_JUDGE_FAKE_MARKER_FILE"] = marker_file
        os.environ["GATE_JUDGE_FAKE_RUN_SECONDS"] = str(run_seconds)

        posted = []
        envelopes = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            if path == GATE_DECISIONS_PATH:
                return {"ok": True, "changed": True,
                        "decision": f"gate-judge-dec-{client_key}-{next(_COUNTER)}"}
            return {"ok": True, "changed": True}

        def fake_emit(verb, ok, result_fields, context, warnings, legacy_line=None):
            envelopes.append({"verb": verb, "ok": ok,
                              "fields": copy.deepcopy(result_fields),
                              "legacy": legacy_line})

        with mock.patch.object(module, "_post", side_effect=fake_post, create=True), \
             mock.patch.object(module, "_emit_axi", side_effect=fake_emit, create=True):
            argv = argv_tail + ["--project-dir", tmpdir]
            code, out, err = _run_main(module, argv)
    finally:
        os.environ["PATH"] = saved_path
        for k in ("GATE_JUDGE_FAKE_PRE_FILE", "GATE_JUDGE_FAKE_POST_FILE",
                  "GATE_JUDGE_FAKE_FINAL_FILE", "GATE_JUDGE_FAKE_MARKER_FILE",
                  "GATE_JUDGE_FAKE_RUN_SECONDS"):
            os.environ.pop(k, None)
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)
        shutil.rmtree(tmpdir, ignore_errors=True)

    decisions = [p for path, p in posted if path == GATE_DECISIONS_PATH]
    gates = [p for path, p in posted if path == GATES_PATH]
    return _Drive(code, out, err, posted, decisions, gates, envelopes)


def _the_one_envelope(drive, verb):
    mine = [e for e in drive.envelopes if e["verb"] == verb]
    assert len(mine) == 1, (
        f"{verb} must emit exactly ONE envelope on every exit path; got "
        f"{[e['verb'] for e in drive.envelopes]!r} (exit={drive.code!r}, "
        f"stderr={drive.err.strip()[:400]!r})")
    return mine[0]


def _told(drive, envelope):
    """Everything a caller is told on the verb's own account: stderr plus the
    legacy one-liner plus the envelope's own fields."""
    return "\n".join([drive.err, envelope["legacy"] or "",
                      json.dumps(envelope["fields"], default=str)])


# ════════════════════════════════════════════════════════════════════════════
# Fixtures -- a two-step ladder (`intent` always completed, `review` the step
# awaiting approval), and how it looks after an accepted respond moves it on
# to `test`, or after a refused one leaves it exactly where it was.
# ════════════════════════════════════════════════════════════════════════════

def _awaiting_review_snapshot(run_id, branch, head):
    return (
        'run:\n'
        f'  id: "{run_id}"\n'
        f'  branch: {branch}\n'
        '  status: awaiting_approval\n'
        f'  head: {head}\n'
        '  findings: 0\n'
        '  steps[2]{step,status,findings,duration_ms}:\n'
        '    intent,completed,0,10\n'
        '    review,awaiting_approval,0,500\n'
    )


def _review_completed_test_running_snapshot(run_id, branch, head):
    return (
        'run:\n'
        f'  id: "{run_id}"\n'
        f'  branch: {branch}\n'
        '  status: running\n'
        f'  head: {head}\n'
        '  findings: 0\n'
        '  steps[3]{step,status,findings,duration_ms}:\n'
        '    intent,completed,0,10\n'
        '    review,completed,0,500\n'
        '    test,running,0,100\n'
    )


# The respond's OWN terminal answer when its `--wait` elapses mid-drive: no
# `run:` block at all -- the exact shape the problem this spec answers
# describes (no-mistakes answering an elapsed wait with a snapshot that names
# no run).
_ELAPSED_WAIT_ANSWER = "error: wait of 8m0s elapsed while driving the run\n"

# The respond's OWN terminal answer for a genuine refusal -- also run-less, on
# the wire indistinguishable from the elapsed-wait answer above (which is
# exactly why the step's OWN status, not the respond answer, is what tells
# the two apart).
_REFUSED_ANSWER = "error: --reason is required to answer review with this action\n"


class _FleetJudgeMixin:
    """One drive per client, built once per test class in `setUpClass`, for
    one scripted scenario -- the fleet's own `setUpClass`-memoized-drives
    idiom (`test_a_gate_is_running_only_while_its_run_is_driven_or_held.py`).

    A plain mixin, NOT a `unittest.TestCase` itself: `_pre_post_final` is
    abstract, so if this class were collected as a test case on its own
    account (every concrete scenario below subclasses it ALONGSIDE
    `TestCase`), `setUpClass` would raise `NotImplementedError` as a bogus
    error that names no scenario's own result."""

    ACTION = "approve"
    STEP = "review"  # None to omit --step entirely

    @classmethod
    def _argv(cls, caller):
        argv = ["gate-respond", "--action", cls.ACTION, "--agent", caller]
        if cls.STEP is not None:
            argv += ["--step", cls.STEP]
        return argv

    @classmethod
    def _pre_post_final(cls, run_id, branch, head):
        raise NotImplementedError

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        cls.run_ids = {}
        for key, path in CLIENT_FILES.items():
            run_id = f"{cls.__name__.lower()}-{key}-run-001"
            branch = f"feature/{cls.__name__.lower()}-{key}"
            head = "cafe4004"
            cls.run_ids[key] = run_id
            pre, post, final = cls._pre_post_final(run_id, branch, head)
            caller = f"{cls.__name__.lower()}-caller-{key}"
            cls.drives[key] = _drive(key, path, cls._argv(caller),
                                     pre, post, final)

    def test_the_fleet_this_scenario_wires_is_exactly_five_clients(self):
        self.assertEqual(
            set(self.drives), {"bun", "python", "mvn", "rust", "arduino"},
            f"this scenario names five clients; got {sorted(self.drives)!r}")


# ────────────────────────────────────────────────────────────────────────────
# AC — Accepted after an elapsed wait: `--step` given explicitly.
# ────────────────────────────────────────────────────────────────────────────

class AnAcceptedDecisionAfterAnElapsedWaitIsRecordedAcrossTheFleetTest(
        _FleetJudgeMixin, unittest.TestCase):

    ACTION = "approve"
    STEP = "review"

    @classmethod
    def _pre_post_final(cls, run_id, branch, head):
        return (_awaiting_review_snapshot(run_id, branch, head),
                _review_completed_test_running_snapshot(run_id, branch, head),
                _ELAPSED_WAIT_ANSWER)

    def test_every_clients_board_holds_exactly_one_decision_for_the_awaited_run_and_step(self):
        offenders = {}
        for key, drive in self.drives.items():
            if len(drive.decisions) != 1:
                offenders[key] = (f"expected exactly one gate-decision POST, "
                                  f"got {len(drive.decisions)}: {drive.decisions!r}")
                continue
            decision = drive.decisions[0].get("decision") or {}
            if decision.get("runId") != self.run_ids[key]:
                offenders[key] = (f"decision.runId must be the run the status "
                                  f"read named BEFORE the respond (the respond's "
                                  f"own answer names no run at all), got "
                                  f"{decision.get('runId')!r}, want "
                                  f"{self.run_ids[key]!r}")
                continue
            if decision.get("step") != "review":
                offenders[key] = (f"decision.step must be 'review', the step "
                                  f"that was awaiting approval, got "
                                  f"{decision.get('step')!r}")
                continue
            if decision.get("action") != "approve":
                offenders[key] = (f"decision.action must be the respond's own "
                                  f"action 'approve', got {decision.get('action')!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_envelope_names_the_recorded_decision_and_says_in_flight(self):
        offenders = {}
        for key, drive in self.drives.items():
            envelope = _the_one_envelope(drive, "gate-respond")
            decision_id = envelope["fields"].get("decision")
            if not decision_id or decision_id == "none":
                offenders[key] = (f"envelope.decision must name the recorded "
                                  f"decision id, got {decision_id!r}")
                continue
            if envelope["fields"].get("inFlight") is not True:
                offenders[key] = (f"envelope.inFlight must be True -- the run "
                                  f"is still going after an accepted decision -- "
                                  f"got {envelope['fields'].get('inFlight')!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_exit_is_the_held_exit_and_nothing_is_sealed(self):
        offenders = {}
        for key, drive in self.drives.items():
            if drive.code == 0:
                offenders[key] = "exit must be non-zero (nothing was sealed)"
                continue
            seals = [g for g in drive.gates if "push" in g.get("gate", {})]
            if seals:
                offenders[key] = f"no gate must be SEALED, got {seals!r}"
        self.assertEqual(offenders, {}, repr(offenders))


# ────────────────────────────────────────────────────────────────────────────
# AC — `--step` omitted: the recorded step still comes from the pre-respond
# status read.
# ────────────────────────────────────────────────────────────────────────────

class AnOmittedStepIsTakenFromTheStatusReadBeforeTheRespondAcrossTheFleetTest(
        _FleetJudgeMixin, unittest.TestCase):

    ACTION = "approve"
    STEP = None  # no --step on the argv at all

    @classmethod
    def _pre_post_final(cls, run_id, branch, head):
        return (_awaiting_review_snapshot(run_id, branch, head),
                _review_completed_test_running_snapshot(run_id, branch, head),
                _ELAPSED_WAIT_ANSWER)

    def test_every_clients_recorded_decision_names_review_though_step_was_never_given(self):
        offenders = {}
        for key, drive in self.drives.items():
            if len(drive.decisions) != 1:
                offenders[key] = (f"expected exactly one gate-decision POST "
                                  f"even with --step omitted, got "
                                  f"{len(drive.decisions)}: {drive.decisions!r}")
                continue
            decision = drive.decisions[0].get("decision") or {}
            if decision.get("step") != "review":
                offenders[key] = (f"decision.step must default to 'review' -- "
                                  f"the step the PRE-respond status read named "
                                  f"as awaiting approval -- got "
                                  f"{decision.get('step')!r}")
        self.assertEqual(offenders, {}, repr(offenders))


# ────────────────────────────────────────────────────────────────────────────
# AC — Refused: the status read after the respond still shows `review`
# awaiting approval, so nothing is recorded.
# ────────────────────────────────────────────────────────────────────────────

class ARefusedDecisionPostsNothingAcrossTheFleetTest(
        _FleetJudgeMixin, unittest.TestCase):

    ACTION = "approve"
    STEP = "review"

    @classmethod
    def _pre_post_final(cls, run_id, branch, head):
        still_awaiting = _awaiting_review_snapshot(run_id, branch, head)
        return still_awaiting, still_awaiting, _REFUSED_ANSWER

    def test_every_clients_board_holds_no_decision(self):
        offenders = {}
        for key, drive in self.drives.items():
            if drive.decisions:
                offenders[key] = (f"a refusal must post NO decision, got "
                                  f"{drive.decisions!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_envelope_names_no_decision(self):
        offenders = {}
        for key, drive in self.drives.items():
            envelope = _the_one_envelope(drive, "gate-respond")
            if envelope["fields"].get("decision") != "none":
                offenders[key] = (f"envelope.decision must be 'none' on a "
                                  f"refusal, got "
                                  f"{envelope['fields'].get('decision')!r}")
        self.assertEqual(offenders, {}, repr(offenders))

    def test_every_clients_exit_is_non_zero(self):
        offenders = {}
        for key, drive in self.drives.items():
            if drive.code == 0:
                offenders[key] = f"a refused respond must exit non-zero, got {drive.code!r}"
        self.assertEqual(offenders, {}, repr(offenders))


# ────────────────────────────────────────────────────────────────────────────
# AC — Held report: the reattach command is named, with the release when the
# drive was given one.
# ────────────────────────────────────────────────────────────────────────────

class AHeldExitNamesTheReattachCommandTest(unittest.TestCase):
    """Driven on one client (bun) -- the AC does not repeat "for EACH of the
    five clients" the way the three ACs above do, and `drive_axi_run` /
    `unsealed_run_report` are the ONE shared body every client's gate-run and
    gate-respond already call (pinned directly by the sibling
    `GateRespondReusesGateRunSharedCodeTest`), so one client proves the
    reattach text for both verbs."""

    CLIENT_KEY = "bun"
    CLIENT_PATH = CLIENT_FILES["bun"]

    def _held_reattach_line(self, drive):
        """The stderr line that is supposed to carry the reattach move --
        found by its known prefix, so a test failure names a MISSING line
        rather than an empty haystack."""
        for line in drive.err.splitlines():
            is_candidate = "NOT SEALED" in line or line.startswith(f"{self._verb}: ")
            if is_candidate and ("reattach" in line or "inspect" in line or "gate-run" in line):
                return line
        return ""

    def test_a_held_gate_run_names_gate_run_intent_and_the_release_it_was_given(self):
        self._verb = "gate-run"
        run_id = "held-reattach-gate-run-001"
        branch = "feature/held-reattach-gate-run"
        snapshot = _awaiting_review_snapshot(run_id, branch, "cafe5005") + \
            "error: wait of 8m0s elapsed while driving the run\n"
        argv = ["gate-run", "--intent", "verify the reattach help",
                "--agent", "held-reattach-caller", "--release", "0.4.0"]
        drive = _drive(self.CLIENT_KEY, self.CLIENT_PATH, argv,
                      snapshot, snapshot, snapshot)
        envelope = _the_one_envelope(drive, "gate-run")
        told = _told(drive, envelope)
        self.assertNotEqual(drive.code, 0, "a held gate-run exit must be non-zero")
        self.assertIn(
            "gate-run --intent", told,
            f"a held exit's help must name the reattach command "
            f"`gate-run --intent`, so the caller is told the exact move that "
            f"resumes the run (today's text names only `axi status`); caller "
            f"was told {told!r}")
        self.assertIn(
            "--release 0.4.0", told,
            f"the drive was given --release 0.4.0, so the reattach help must "
            f"repeat it; caller was told {told!r}")

    def test_a_held_gate_respond_names_gate_run_intent_without_inventing_a_release(self):
        self._verb = "gate-respond"
        run_id = "held-reattach-gate-respond-001"
        branch = "feature/held-reattach-gate-respond"
        head = "cafe6006"
        pre = _awaiting_review_snapshot(run_id, branch, head)
        post = _review_completed_test_running_snapshot(run_id, branch, head)
        argv = ["gate-respond", "--action", "approve", "--step", "review",
                "--agent", "held-reattach-caller"]
        drive = _drive(self.CLIENT_KEY, self.CLIENT_PATH, argv,
                      pre, post, _ELAPSED_WAIT_ANSWER)
        envelope = _the_one_envelope(drive, "gate-respond")
        told = _told(drive, envelope)
        self.assertNotEqual(drive.code, 0, "a held gate-respond exit must be non-zero")
        self.assertIn(
            "gate-run --intent", told,
            f"gate-respond's own held exit reattaches the SAME run through "
            f"`gate-run --intent`, not through a respond flag -- the caller "
            f"must be told that command; caller was told {told!r}")
        reattach_lines = [ln for ln in told.splitlines() if "gate-run --intent" in ln]
        self.assertTrue(reattach_lines, f"no line named the reattach command "
                                        f"at all; caller was told {told!r}")
        self.assertNotIn(
            "--release", reattach_lines[0],
            f"gate-respond's own drive was given no release, so the reattach "
            f"line must not invent one; got {reattach_lines[0]!r}")


if __name__ == "__main__":
    unittest.main()
