"""A RUN THAT IS STILL GOING IS NEVER SEALED (§S3), AND THE ENVELOPE SAYS WHAT
WAS POSTED (§S4).

The release-gate change request's other half — the release a gate NAMES — is
pinned by the sibling `test_gate_names_the_release_it_gates.py`, whose
transport-seam harness this file reuses rather than re-invents: the payload is
recorded where the client's `_post` hands it to the wire, because the whole
question here is what the SERVER would have been told.

THE DEFECT, MEASURED ON THIS TREE. `gate_from_axi(decoded, intent, final=True)`
takes the run's own `outcome` only when it is already one of the four legal
values and otherwise falls back to `("failed" if any_failed else "passed")`.
That fallback is structurally biased green, because `pending`,
`awaiting_approval`, `running` and `fixing` are none of them `failed`:

  * a snapshot with NO `outcome` key at all seals `passed` — which is how the
    bounded hold of 2026-09-09 was sealed while its `review` step sat at
    `awaiting_approval` with four findings, the snapshot's own
    `error: wait of 8m0s elapsed while driving the run` never read, though it
    is the one fact that answers "did this run terminate?";
  * `passed-with-skips` — the value this project's release run really resolves
    today — is in NEITHER vocabulary, so it too falls through the fallback and
    becomes green BY ACCIDENT rather than by a decision anyone made.

WHAT THE TWO OUTCOME TESTS PROVE TOGETHER. `passed-with-skips` must seal
`passed` (its skips are already on the wire as `pr,skipped` / `ci,skipped`),
while an outcome in no pass family at all — here `reticulating` — must NOT.
That pair is the behavioural proof that the mapping became an explicit,
value-named pass family: under the absence-of-failure fallback both strings
seal `passed` identically, since neither is `failed`, so no fallback can pass
both tests at once.

WHY THE FIXTURES ARE CAPTURED, NOT WRITTEN. A hand-written shape drifts into
agreement with the defect — that is exactly how the nine-row ladder outran the
interim guard for a whole release. The resolved fixture below is the run block
and outcome of `no-mistakes axi status` on this machine, taken verbatim (its
`automatic_skips`, `shared_work` and `branch_sync` blocks are dropped, and
nothing else is touched: the sealing path reads only `run.steps`, `run.head`
and the top-level `outcome`). The hold fixture is that same captured ladder
carrying the documented bounded-hold return — no `outcome` key, `review` at
`awaiting_approval`, and the tool's own `error` string.

SCOPE. The interim POST and its `if in_flight and 0 < nsteps < 9` guard belong
to the follow-on change request and are untouched here: both fixtures carry the
real NINE rows, so the guard never fires and nothing in this file depends on
it. `interim` as an envelope value is likewise unproducible until that guard is
repaired, so it is not asserted — the envelope's gate statement is pinned on
its two reachable states, a seal and a hold.

Invocation:
    python3 -m unittest tests.client.test_a_run_still_going_is_never_sealed
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
from collections import namedtuple
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

GATES_PATH = "/api/v2/gates"
INTENT = "seal the release run"
RELEASE_LABEL = "0.2.0"

# The env keys the fleet's `context` block reads. Cleared in every drive below
# so an ambient orchestrator session can never colour an envelope asserted on
# here — the sibling suite's rule, for the same reason.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# The bounded hold's own words, from the return documented for `axi run`'s
# `--wait` (default 8m).
HOLD_ERROR = "wait of 8m0s elapsed while driving the run"

# THE REATTACH MOVE IS THE TOOL'S, NOT THIS FILE'S. Read off `no-mistakes axi
# run --help` on this machine: "--wait bounds this hold (default 8m) so an
# agent harness with a 10-minute tool cap gets a structured return instead of
# an unbounded hang. Elapsed wait is not a failed run: inspect with axi status
# and reattach." So the move a held caller is told to make is `axi status`;
# `axi respond` continues the gate once the caller has looked. Nothing here
# invents a command the tool does not name.
REATTACH_MOVE = "axi status"


# ════════════════════════════════════════════════════════════════════════════
# THE ENVELOPE'S §S4 VOCABULARY — named once, here
# ════════════════════════════════════════════════════════════════════════════
#
# §S4 says the envelope STATES the release it stamped "or states that none was
# stamped", and NAMES which gate it posted. A stated fact needs a value: a
# missing key states nothing, and a reader cannot tell it from a client too old
# to have the field. So both fields are always present, and the "nothing here"
# case is a word rather than an absence — the opposite rule to the gate
# PAYLOAD's `version`, which is omitted precisely because the server acts on
# its presence. Field spelling follows the envelope's own camelCase idiom
# (`cycleId`).
RELEASE_FIELD = "release"
NOTHING_STAMPED = "none"
POSTED_GATE_FIELD = "postedGate"
FINAL_GATE = "final"
NO_GATE_POSTED = "none"
IN_FLIGHT_FIELD = "inFlight"
# The run's OWN outcome string, carried beside the mapped one so a reader sees
# what the tool actually resolved — the fact the fallback destroys.
RAW_OUTCOME_FIELD = "rawOutcome"

RESOLVED_WITH_SKIPS = "passed-with-skips"
# An outcome no vocabulary has and none ever will: the point is a value the
# fleet does not understand, which must never become green.
UNRECOGNISED_OUTCOME = "reticulating"


# ════════════════════════════════════════════════════════════════════════════
# THE FIXTURES — captured from the real tool, on this machine
# ════════════════════════════════════════════════════════════════════════════

# `no-mistakes axi status` on this repository's own release run, 2026-09-10:
# nine rows, two of them genuinely `skipped`, and an outcome string in no
# vocabulary the fleet has.
_RESOLVED_SNAPSHOT = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: completed\n'
    '  head: a5ad0134\n'
    '  head_sha: a5ad01346d028653be14854f1573562d8769d4b0\n'
    '  findings: 1 info\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,2\n'
    '    rebase,completed,0,1410\n'
    '    review,completed,1,1222511\n'
    '    test,completed,0,977426\n'
    '    document,completed,0,879816\n'
    '    lint,completed,0,6\n'
    '    push,completed,0,4374\n'
    '    pr,skipped,0,752\n'
    '    ci,skipped,0,715\n'
    'outcome: ' + RESOLVED_WITH_SKIPS + '\n'
)

SNAPSHOT_HEAD = "a5ad0134"

# The BOUNDED HOLD: the captured ladder above, carrying the documented
# `--wait`-elapsed return instead of a terminus. Its facts are the ones the
# 2026-09-09 run really had — no `outcome` key at all, `review` still
# `awaiting_approval` with four findings, the unrun steps `pending`, and the
# tool's own `error` line. Nothing else about the shape is changed.
_HOLD_SNAPSHOT = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: running\n'
    '  head: a5ad0134\n'
    '  head_sha: a5ad01346d028653be14854f1573562d8769d4b0\n'
    '  findings: 4\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,2\n'
    '    rebase,completed,0,1410\n'
    '    review,awaiting_approval,4,1222511\n'
    '    test,pending,0,0\n'
    '    document,pending,0,0\n'
    '    lint,pending,0,0\n'
    '    push,pending,0,0\n'
    '    pr,pending,0,0\n'
    '    ci,pending,0,0\n'
    'error: ' + HOLD_ERROR + '\n'
)


def _resolved_as(outcome):
    """The captured resolved snapshot with its outcome line replaced — the ONE
    fact under test in each sealing case, changed on the real shape rather than
    written from scratch beside it."""
    return _RESOLVED_SNAPSHOT.replace(
        "outcome: " + RESOLVED_WITH_SKIPS, "outcome: " + outcome)


def _snapshot_with_unrun_steps_at(state):
    """The captured HOLD shape with every not-yet-finished row at `state`. The
    completed rows stay completed: a real held run has history behind it, and a
    ladder of nothing but one status would not be the shape the fallback reads.
    """
    return (_HOLD_SNAPSHOT
            .replace(",awaiting_approval,", "," + state + ",")
            .replace(",pending,", "," + state + ","))


# A run that FAILED is not a run that is still going: the failure is itself a
# resolved fact, so it seals even though the tool's snapshot carries no
# top-level outcome. The wait-elapsed line is dropped with it — a failed run is
# not a held one.
_FAILED_STEP_SNAPSHOT = (_HOLD_SNAPSHOT
                         .replace(",awaiting_approval,", ",failed,")
                         .replace("error: " + HOLD_ERROR + "\n", ""))


def _load_module(path, name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom. A missing file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AXI = _load_module(AXI_MODULE_PATH, "axi_under_test_never_sealed")


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()`. Only SystemExit
    is caught, so an argparse refusal arrives as a non-zero exit while any
    other exception still surfaces as an ERROR rather than being swallowed."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client.py"] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


# ════════════════════════════════════════════════════════════════════════════
# §S3 — the sealing decision itself, driven straight through `gate_from_axi`
# ════════════════════════════════════════════════════════════════════════════


class _SealingTestBase(unittest.TestCase):

    def seal(self, snapshot):
        """Decode a snapshot the way the proxy does and take the SEALING gate
        from it. The decode and the row count are asserted first: a fixture
        that stopped parsing, or a ladder that lost rows, would fail these
        tests for a reason that is not the defect under test."""
        decoded = _AXI._decode_axi_snapshot(snapshot)
        self.assertIsInstance(
            decoded, dict,
            "harness: the captured snapshot must decode through the client's "
            "own TOON reader before anything can be asserted about the seal "
            "it produces; got " + repr(decoded))
        gate, nsteps = _AXI.gate_from_axi(decoded, INTENT, final=True)
        self.assertEqual(
            nsteps, 9,
            "harness: the real tool always emits NINE rows and the whole "
            "defect lives in what is inferred from them; got " + repr(nsteps))
        return gate


class ARunWithNoResolvedOutcomeIsNeverSealedPassedTest(_SealingTestBase):
    """§S3 — a snapshot with NO `outcome` key seals nothing green, in every
    state an unfinished step can be in.

    Four states, four TESTS rather than four assertions in one method: a
    partial fix — one that special-cases `awaiting_approval` and leaves
    `pending` inferring green, say — then shows as two reds beside two greens
    instead of hiding behind the first assertion to fire.

    The bound is `passed` OR `checks-passed`, not `passed` alone: the
    renderer's `workflowLens` flips a wave to `gated` on either, from a set
    nothing ever removes from, so both are a false green and only the absence
    of a verdict is honest."""

    FALSE_GREENS = ("passed", "checks-passed")

    def outcome_with_unrun_steps_at(self, state):
        return self.seal(_snapshot_with_unrun_steps_at(state)).get("outcome")

    def test_a_run_whose_unrun_steps_are_pending_is_not_sealed_green(self):
        outcome = self.outcome_with_unrun_steps_at("pending")
        self.assertNotIn(
            outcome, self.FALSE_GREENS,
            "PENDING: a run whose steps have not been reached has not passed — "
            "the absence of a failure is not a verdict, and this is the exact "
            "state the nine-row ladder sits in while a run is still going; "
            "got " + repr(outcome))

    def test_a_run_whose_unrun_steps_are_running_is_not_sealed_green(self):
        outcome = self.outcome_with_unrun_steps_at("running")
        self.assertNotIn(
            outcome, self.FALSE_GREENS,
            "RUNNING: a step still executing cannot have produced a verdict; "
            "sealing here claims an outcome the run has not reached; "
            "got " + repr(outcome))

    def test_a_run_whose_unrun_steps_are_fixing_is_not_sealed_green(self):
        outcome = self.outcome_with_unrun_steps_at("fixing")
        self.assertNotIn(
            outcome, self.FALSE_GREENS,
            "FIXING: a run repairing its own findings is mid-flight by "
            "definition, and its findings are precisely what a green seal "
            "would hide; got " + repr(outcome))

    def test_a_run_whose_unrun_steps_are_awaiting_approval_is_not_sealed_green(self):
        outcome = self.outcome_with_unrun_steps_at("awaiting_approval")
        self.assertNotIn(
            outcome, self.FALSE_GREENS,
            "AWAITING_APPROVAL: the state the 2026-09-09 run was really in — "
            "held at review with four findings — when it was sealed green. "
            "A run waiting on a human decision has not decided; "
            "got " + repr(outcome))


class ARealVerdictStillSealsTest(_SealingTestBase):
    """PASS-SIDE — every test here passes BEFORE the fix and must pass after
    it. They are the measurement behind "the fix narrows the fallback without
    changing a real verdict": remove the green inference and these four are
    what must be left standing."""

    def test_a_resolved_passed_snapshot_still_seals_passed(self):
        self.assertEqual(
            self.seal(_resolved_as("passed")).get("outcome"), "passed",
            "a run that resolved `passed` seals `passed`: the run's OWN "
            "outcome is the verdict, and narrowing the fallback must not "
            "touch it")

    def test_a_failed_step_still_seals_failed(self):
        self.assertEqual(
            self.seal(_FAILED_STEP_SNAPSHOT).get("outcome"), "failed",
            "a FAILED step is a resolved fact, not a hold: a run that broke "
            "seals `failed` even though this snapshot carries no top-level "
            "outcome. Only the GREEN half of the fallback is the defect")

    def test_checks_passed_still_seals_verbatim(self):
        self.assertEqual(
            self.seal(_resolved_as("checks-passed")).get("outcome"),
            "checks-passed",
            "`checks-passed` is one of the four values the server accepts; a "
            "resolved one travels verbatim rather than being re-derived")

    def test_cancelled_still_seals_verbatim(self):
        self.assertEqual(
            self.seal(_resolved_as("cancelled")).get("outcome"), "cancelled",
            "`cancelled` is the fourth legal value, and the one a fallback "
            "keyed on failure would most easily lose: a cancelled run has no "
            "failed step, so the green inference would have called it passed")

    def test_the_seal_still_carries_the_snapshots_head_as_its_push_commit(self):
        gate = self.seal(_resolved_as("passed"))
        self.assertEqual(
            gate.get("push"), {"commit": SNAPSHOT_HEAD},
            "the sealing gate names the commit it gated, taken from the "
            "snapshot's own `head` — the link between a gate and the code it "
            "passed judgement on; got " + repr(gate.get("push")))


# ════════════════════════════════════════════════════════════════════════════
# THE DRIVE — a whole `gate-run`, recorded at the transport and envelope seams
# ════════════════════════════════════════════════════════════════════════════
#
# The proxied tool is a real executable on PATH — the fleet's fake-tool idiom —
# so `gate-run` launches, polls and seals through its OWN subprocess path
# rather than a harness that bypasses it. `_post` is recorded at the transport
# seam (what the SERVER would receive) and `_emit_axi` at the envelope seam
# (what the CALLER is told); both are read fresh from the module's globals by
# each client's `_ops()`, which is why patching the module attributes works.

_FAKE_NO_MISTAKES_BODY = '''
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    sys.stdout.write({snap!r})
    sys.exit({exit_code})
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''

_Drive = namedtuple("_Drive", "code out err gates envelopes")


class _GateRunDriveTestBase(unittest.TestCase):

    PROJECT_KEY = "never-sealed-wire-key"
    AGENT = "never-sealed-wire-agent"
    SNAPSHOT = _RESOLVED_SNAPSHOT
    # The bounded hold is NOT a failed run — the tool says so itself — so the
    # proxied process exits 0 in every case below. `gate-run`'s own exit code
    # therefore has to come from what it read, not from what it was handed.
    TOOL_EXIT = 0

    def setUp(self):
        self.module = _load_module(BUN_CLIENT_PATH, "never_sealed_client_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="never-sealed-")
        (Path(self.tmpdir) / ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=" + self.PROJECT_KEY + "\n")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="never-sealed-fake-bin-")
        fake = Path(self.fake_bin_dir) / "no-mistakes"
        fake.write_text(
            "#!" + sys.executable + "\n"
            + _FAKE_NO_MISTAKES_BODY.format(snap=self.SNAPSHOT,
                                            exit_code=self.TOOL_EXIT))
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, *extra):
        """One whole `gate-run` → its exit code, its streams, the gate payloads
        that reached the wire, and the envelopes it emitted."""
        posted = []
        envelopes = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        def fake_emit(verb, ok, result_fields, context, warnings, legacy_line=None):
            envelopes.append({"verb": verb, "ok": ok,
                              "fields": copy.deepcopy(result_fields),
                              "legacy": legacy_line})

        argv = ["gate-run", "--intent", INTENT, "--agent", self.AGENT,
                "--project-dir", self.tmpdir] + list(extra)
        with mock.patch.object(self.module, "_post", side_effect=fake_post), \
                mock.patch.object(self.module, "_emit_axi", side_effect=fake_emit):
            code, out, err = _run_main(self.module, argv)
        return _Drive(code=code, out=out, err=err,
                      gates=[p for path, p in posted if path == GATES_PATH],
                      envelopes=envelopes)

    def the_one_envelope(self, drive):
        """The SINGLE `gate-run` envelope of a drive. The count is asserted, not
        assumed: a verb that died before emitting would otherwise fail as an
        IndexError naming neither the verb nor its refusal."""
        mine = [e for e in drive.envelopes if e["verb"] == "gate-run"]
        self.assertEqual(
            len(mine), 1,
            "`gate-run` must emit exactly ONE envelope on every exit path; got "
            + repr([e["verb"] for e in drive.envelopes])
            + " (exit=" + repr(drive.code) + ", stderr="
            + repr(drive.err.strip()[:400]) + ")")
        return mine[0]

    def what_the_caller_was_told(self, drive, envelope):
        """Everything `gate-run` said to its caller ON ITS OWN ACCOUNT: stderr
        plus the human line plus the envelope's fields.

        STDOUT IS DELIBERATELY EXCLUDED. The proxy relays the tool's raw
        snapshot to stdout, and that snapshot already contains the hold's error
        line — searching it would let this assertion pass on text `gate-run`
        merely echoed rather than text it understood."""
        return "\n".join([drive.err, envelope["legacy"] or "",
                          json.dumps(envelope["fields"], default=str)])

    def sealed_outcomes(self, drive):
        return [p.get("gate", {}).get("outcome") for p in drive.gates]


# ── §S3 — the bounded hold, end to end ──────────────────────────────────


class ABoundedHoldIsReportedNotSealedTest(_GateRunDriveTestBase):
    """§S3 — the 2026-09-09 defect, driven whole: the tool returns its bounded
    hold, and `gate-run` must refuse to turn that into a verdict."""

    SNAPSHOT = _HOLD_SNAPSHOT

    def test_a_bounded_hold_posts_no_gate_claiming_the_run_passed(self):
        drive = self.drive()
        self.assertNotIn(
            "passed", self.sealed_outcomes(drive),
            "a held run must never reach the board as a PASSED gate — this is "
            "the false green that was recorded while the run sat at review, "
            "awaiting approval, with four findings; the bodies posted were "
            + repr(drive.gates))

    def test_a_bounded_hold_posts_no_gate_at_all(self):
        drive = self.drive()
        self.assertEqual(
            drive.gates, [],
            "every gate carries an outcome, so there is no shape in today's "
            "vocabulary that says `still going` without also claiming a "
            "verdict: a hold posts NOTHING until an in-flight gate has a shape "
            "the reader cannot mistake for one. Silence is the honest state; "
            "got " + repr(drive.gates))

    def test_a_bounded_hold_exits_non_zero(self):
        drive = self.drive()
        self.assertNotEqual(
            drive.code, 0,
            "the proxied tool exits 0 on a bounded hold — an elapsed wait is "
            "not a failed run — so `gate-run`'s own exit code is the only "
            "signal its CALLER gets that nothing was sealed; got exit "
            + repr(drive.code))

    def test_a_bounded_hold_names_the_runs_own_error_and_the_reattach_move(self):
        drive = self.drive()
        told = self.what_the_caller_was_told(drive, self.the_one_envelope(drive))
        self.assertIn(
            HOLD_ERROR, told,
            "the snapshot's OWN error is the fact that answers `did this run "
            "terminate?`, and it is already in hand — reporting a hold without "
            "it makes the caller re-derive what the tool already said; the "
            "caller was told " + repr(told))
        self.assertIn(
            REATTACH_MOVE, told,
            "a hold without a next move strands its caller: the tool's own "
            "help says an elapsed wait is inspected with `axi status` and "
            "reattached, so the report names that move; the caller was told "
            + repr(told))

    def test_the_hold_envelope_says_the_run_is_still_in_flight_and_is_not_ok(self):
        """§S4 — the hold half of the envelope contract."""
        envelope = self.the_one_envelope(self.drive())
        self.assertIs(
            envelope["ok"], False,
            "a run that was not sealed is not an ok exit: `ok` is the field an "
            "orchestrator branches on, and a true one here is the false green "
            "in envelope form; got " + repr(envelope))
        self.assertIs(
            envelope["fields"].get(IN_FLIGHT_FIELD), True,
            "the envelope must SAY the run is still in flight, in a field a "
            "reader can match on rather than a sentence it has to parse; got "
            + repr(envelope["fields"]))
        self.assertEqual(
            envelope["fields"].get(POSTED_GATE_FIELD), NO_GATE_POSTED,
            "a hold posts no gate, so the envelope names none — stated as a "
            "value, because a missing key is indistinguishable from a client "
            "too old to have the field; got " + repr(envelope["fields"]))


# ── §S3 — the two outcome families, which together kill the fallback ────────


class PassedWithSkipsSealsPassedByAnExplicitFamilyTest(_GateRunDriveTestBase):
    """§S3 — the outcome this release actually produced.

    `passed-with-skips` is in NEITHER vocabulary — not the server's four legal
    values, not the client tuple, not the renderer's gating rule — so sending
    it verbatim would 400. It maps to `passed`, and the skips it names are not
    lost: `pr,skipped` and `ci,skipped` are already on the wire in `steps[]`,
    and the envelope keeps the RAW string beside the mapped one.

    That raw statement is also what makes the mapping demonstrably a decision
    rather than an accident: the absence-of-failure fallback discards the
    original string entirely, having never looked at it."""

    SNAPSHOT = _RESOLVED_SNAPSHOT

    def test_passed_with_skips_seals_passed_and_the_envelope_keeps_the_raw_outcome(self):
        drive = self.drive()
        self.assertEqual(
            self.sealed_outcomes(drive), ["passed"],
            "a run that resolved `" + RESOLVED_WITH_SKIPS + "` passed: it "
            "seals exactly one gate, whose outcome is the pass family's "
            "canonical member; got " + repr(drive.gates))
        envelope = self.the_one_envelope(drive)
        self.assertEqual(
            envelope["fields"].get(RAW_OUTCOME_FIELD), RESOLVED_WITH_SKIPS,
            "the envelope reports what the RUN said, verbatim, beside what was "
            "posted — otherwise the mapping silently rewrites the only record "
            "of the tool's own answer, which is exactly what the fallback did; "
            "got " + repr(envelope["fields"]))


class AnOutcomeInNoPassFamilyIsNeverSealedGreenTest(_GateRunDriveTestBase):
    """§S3's last criterion — the fallback's real defect. A value the fleet does
    not understand must not become green.

    Read against the test above, this is the proof the mapping is an explicit
    pass-family table: under the absence-of-failure fallback both this snapshot
    and the `" + RESOLVED_WITH_SKIPS + "` one seal `passed` for the identical
    reason — neither string is `failed` — so no fallback can satisfy both."""

    SNAPSHOT = _resolved_as(UNRECOGNISED_OUTCOME)

    def test_an_unrecognised_outcome_is_never_sealed_as_passed(self):
        drive = self.drive()
        self.assertNotIn(
            "passed", self.sealed_outcomes(drive),
            "an outcome in no pass family is not a pass: the fleet cannot "
            "know what " + repr(UNRECOGNISED_OUTCOME) + " means, and turning "
            "what it does not understand into green is the fallback's whole "
            "defect; the bodies posted were " + repr(drive.gates))

    def test_an_unrecognised_outcome_leaves_the_run_unsealed_and_is_reported_verbatim(self):
        drive = self.drive()
        envelope = self.the_one_envelope(drive)
        self.assertEqual(
            envelope["fields"].get(RAW_OUTCOME_FIELD), UNRECOGNISED_OUTCOME,
            "the unknown value is reported VERBATIM — it is the only evidence "
            "of what the tool resolved, and a reader who has to act on it "
            "needs the string, not a substitute; got " + repr(envelope["fields"]))
        self.assertIs(
            envelope["ok"], False,
            "the run is treated as UNSEALED: nothing green was recorded, so "
            "the exit is not ok; got " + repr(envelope))
        self.assertEqual(
            envelope["fields"].get(POSTED_GATE_FIELD), NO_GATE_POSTED,
            "an unsealed run posts no gate, and the envelope names none; got "
            + repr(envelope["fields"]))


# ── §S4 — the seal half of the envelope contract ─────────────────────────


class TheSealEnvelopeSaysWhatWasPostedTest(_GateRunDriveTestBase):
    """§S4 — on a seal the envelope states the release it stamped (or that it
    stamped none) and names the gate it posted as `final`.

    `interim` is not asserted anywhere in this file: the interim POST is
    unreachable until the follow-on change request repairs its guard, so a
    fixture claiming that value could only pass by mocking the very call this
    work must not touch."""

    SNAPSHOT = _resolved_as("passed")

    def test_a_seal_states_the_release_it_stamped_and_names_the_final_gate(self):
        envelope = self.the_one_envelope(self.drive("--release", RELEASE_LABEL))
        self.assertEqual(
            envelope["fields"].get(RELEASE_FIELD), RELEASE_LABEL,
            "the envelope states the release this seal stamped, so a caller "
            "reading stdout knows which release the gate it just posted "
            "belongs to without re-fetching the event; got "
            + repr(envelope["fields"]))
        self.assertEqual(
            envelope["fields"].get(POSTED_GATE_FIELD), FINAL_GATE,
            "and it names WHICH gate was posted: a seal is `" + FINAL_GATE
            + "`; got " + repr(envelope["fields"]))

    def test_a_seal_with_no_release_states_that_none_was_stamped(self):
        envelope = self.the_one_envelope(self.drive())
        self.assertEqual(
            envelope["fields"].get(RELEASE_FIELD), NOTHING_STAMPED,
            "a gate on a feature branch gates no release, and the envelope "
            "SAYS so rather than staying silent: an absent field cannot be "
            "told apart from a client that never had one, while the PAYLOAD's "
            "`version` stays omitted because the server acts on its presence; "
            "got " + repr(envelope["fields"]))
        self.assertEqual(
            envelope["fields"].get(POSTED_GATE_FIELD), FINAL_GATE,
            "an unstamped run still SEALED, so the posted gate is still "
            "`" + FINAL_GATE + "`; got " + repr(envelope["fields"]))


class TodaysSealSurvivesTest(_GateRunDriveTestBase):
    """PASS-SIDE — the sealing path a real verdict takes, driven whole. These
    pass BEFORE the fix and must pass after it: refusing to seal a HELD run
    must not cost a finished one its gate."""

    SNAPSHOT = _resolved_as("passed")

    def test_a_resolved_passed_run_still_posts_exactly_one_sealing_gate(self):
        drive = self.drive()
        self.assertEqual(
            self.sealed_outcomes(drive), ["passed"],
            "exactly ONE gate, sealing `passed` — not zero (the refusal "
            "over-reaching into finished runs) and not two (the interim guard "
            "firing on a nine-row snapshot); got " + repr(drive.gates))

    def test_the_posted_seal_still_carries_the_commit_it_gated(self):
        drive = self.drive()
        self.assertEqual(
            [p.get("gate", {}).get("push") for p in drive.gates],
            [{"commit": SNAPSHOT_HEAD}],
            "the gate that reaches the wire names the commit it gated, taken "
            "from the snapshot's own head; got " + repr(drive.gates))

    def test_a_resolved_passed_run_still_exits_zero(self):
        self.assertEqual(
            self.drive().code, 0,
            "a run that resolved `passed` and posted its seal is a successful "
            "gate-run: the non-zero exit belongs to holds alone")


if __name__ == "__main__":
    unittest.main()
