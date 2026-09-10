"""A RUN IN FLIGHT STREAMS ITS LADDER TO THE BOARD (§S2).

THE DEFECT, MEASURED ON THIS TREE. `cmd_gate_run` guards its streaming interim
POST with `if in_flight and 0 < nsteps < 9`, where `nsteps` is the row count of
the decoded snapshot. The real tool always emits NINE rows — unrun steps carry
`pending` — so the guard is False for every real snapshot and NO INTERIM GATE
HAS EVER BEEN POSTED BY ANY CLIENT. A 45-minute pipeline sent the board
nothing, and the caller was told `postedGate: none` — which was true only by
accident.

WHAT THIS FILE PINS.

  * the guard tests TERMINALITY, not row count: a nine-row ladder carrying
    `pending` rows and no `outcome` key posts an interim gate, and a nine-row
    ladder that is `completed` with a resolved outcome posts none;
  * the interim gate is DISTINGUISHABLE from a seal — `gate.inFlight: true`
    inside the gate object (the mark cycle 408's two readers already exclude
    on) and NO top-level `version`, because a version-stamped gate is
    retention-protected and the seal restates the release anyway;
  * the ladder, not the clock, is the throttle. Ruled 2026-09-10: a POST fires
    only when the step ladder DIFFERS from the last one posted. At a 2 s
    cadence a 45-minute pipeline would otherwise post ~1350 gate events
    against 1842 on this whole board, while the ladder itself transitions at
    most nine times. The cadence is untouched (Non-goal) — the ladder check is
    an ADDITIONAL condition, so both throttles are asserted here by counting
    POSTs;
  * and the HUMAN channel says what the machine-readable envelope says. On the
    interim-then-hold path today's report is `NOT SEALED` plus the run's own
    error plus the reattach move — all true, and all leaving the impression
    the board is silent while an interim gate sits on it.

WHY THE FIXTURES ARE CAPTURED. A hand-written shape drifts into agreement with
the defect: that is exactly how a 3/6/8-row progression let a nine-row ladder
outrun the interim guard for a whole release. Every snapshot below is the shape
`no-mistakes axi status` really returns, and NAMES THE TOOL VERSION it came
from, so a future red run over a changed pipeline is diagnosable as a
tool-version change rather than a defect.

THE HARNESS is the sibling `test_a_run_still_going_is_never_sealed.py`'s, not a
new one: a real fake `no-mistakes` on PATH so `gate-run` launches, polls and
exits through its OWN subprocess path, with `_post` recorded at the TRANSPORT
seam (what the server would receive) and `_emit_axi` at the envelope seam (what
the caller is told).

Invocation:
    python3 -m unittest tests.client.test_a_run_in_flight_streams_its_ladder
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
INTENT = "stream the release run"

# The env keys the fleet's `context` block reads, cleared in every drive so an
# ambient orchestrator session can never colour an envelope asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# The bounded hold's own words, from the return documented for `axi run`'s
# `--wait` (default 8m), and the move the tool's help names for it.
HOLD_ERROR = "wait of 8m0s elapsed while driving the run"
REATTACH_MOVE = "axi status"

# The envelope vocabulary, spelled as the fleet spells it.
POSTED_GATE_FIELD = "postedGate"
OUTCOME_FIELD = "outcome"
IN_FLIGHT_FIELD = "inFlight"
INTERIM_GATE = "interim"
FINAL_GATE = "final"
# `none` is the fleet's word for "this exit did the thing ZERO times". That is
# the value under test in the envelope's `outcome` on a path where a gate IS on
# the board.
NO_GATE_POSTED = "none"

# The four values the server accepts for a gate outcome (`src/v2.ts`). Nothing
# was SEALED on the interim-then-hold path, so the envelope's `outcome` must
# not read as one of them either.
GATE_OUTCOMES = ("checks-passed", "passed", "failed", "cancelled")

# The outcome an INTERIM gate carries: no row has failed, and every gate must
# name one of the four legal values, so an in-flight ladder goes to the board as
# `checks-passed` — which is precisely why it must ALSO carry a mark saying it
# is not a verdict.
INTERIM_OUTCOME = "checks-passed"

# The MEANING the human channel has to carry on the interim-then-hold path: a
# caller reading only stderr must be able to tell that a gate reached the board.
# Any of these says it — the test names the FACT, not one sentence, because no
# criterion here is about wording.
BOARD_REACHED_TOKENS = ("interim", "posted a gate", "gate is on the board",
                        "gate already on the board", "already on the board",
                        "gate on the board")


# ═════════════════════════════════════════════════════════════════════════════
# THE FIXTURES — captured from the real tool, and each NAMING its tool version
# ═════════════════════════════════════════════════════════════════════════════
#
# TOOL VERSION: `no-mistakes` v1.70.1, captured on this machine 2026-09-10 —
# v1.72.0 was already published at capture time. The NINE-row ladder and its
# step NAMES are that version's pipeline. If the tool gains or loses a pipeline
# step, every nine-row assertion in this file goes red for a tool-version
# reason with no defect behind it, and a reader has to be able to tell which is
# which — hence this line rather than a bare fixture.
TOOL_VERSION = "1.70.1"

SNAPSHOT_HEAD = "a5ad0134"

# THE LIVE IN-FLIGHT SHAPE: nine rows, `review` still `running`, the six unrun
# steps carrying `pending`, `status: running`, and NO top-level `outcome` key.
# This is the exact shape the guard's row count reads as "already resolved".
_LIVE_IN_FLIGHT_SNAPSHOT = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: running\n'
    '  head: ' + SNAPSHOT_HEAD + '\n'
    '  head_sha: a5ad01346d028653be14854f1573562d8769d4b0\n'
    '  findings: 0\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,2\n'
    '    rebase,completed,0,1410\n'
    '    review,running,0,412006\n'
    '    test,pending,0,0\n'
    '    document,pending,0,0\n'
    '    lint,pending,0,0\n'
    '    push,pending,0,0\n'
    '    pr,pending,0,0\n'
    '    ci,pending,0,0\n'
)

# The ladder ADVANCED: `review` finished and `test` took over. Same nine rows,
# same names, one status changed — the smallest real transition there is, and
# the one the ladder-change throttle must not swallow.
_ADVANCED_IN_FLIGHT_SNAPSHOT = (
    _LIVE_IN_FLIGHT_SNAPSHOT
    .replace('    review,running,0,412006\n', '    review,completed,1,1222511\n')
    .replace('    test,pending,0,0\n', '    test,running,0,90210\n'))

# THE HELD RETURN: what `axi run` prints when its bounded `--wait` elapses — the
# live ladder above plus the tool's own error line. The run did not terminate,
# so this exit seals nothing; the poll loop has already put an interim ladder on
# the board, which is the whole subject of the envelope and report criteria.
_HELD_RETURN_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT + 'error: ' + HOLD_ERROR + '\n'

# THE SEALING SHAPE: the same nine rows, all `completed`, with the run's own
# resolved outcome. Terminal — nothing about it is in flight, so no interim gate
# may be posted for it however the guard is rewritten.
_RESOLVED_SNAPSHOT = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: completed\n'
    '  head: ' + SNAPSHOT_HEAD + '\n'
    '  head_sha: a5ad01346d028653be14854f1573562d8769d4b0\n'
    '  findings: 1\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,2\n'
    '    rebase,completed,0,1410\n'
    '    review,completed,1,1222511\n'
    '    test,completed,0,977426\n'
    '    document,completed,0,879816\n'
    '    lint,completed,0,6\n'
    '    push,completed,0,4374\n'
    '    pr,completed,0,752\n'
    '    ci,completed,0,715\n'
    'outcome: passed\n'
)

# THE SHORT LADDER, kept for ONE job: isolating the ladder-change throttle from
# the guard. Three rows already clear today's `0 < nsteps < 9`, so a drive that
# holds this ladder still posts on every cadence window TODAY — which makes the
# repeat-POST count the only thing its test can be failing on.
_SHORT_IN_FLIGHT_SNAPSHOT = (
    'run:\n'
    '  id: "01M2270SJ5PQW4KBBBV3XCPMM5"\n'
    '  branch: release/0.2.0\n'
    '  status: running\n'
    '  head: ' + SNAPSHOT_HEAD + '\n'
    '  findings: 0\n'
    '  steps[3]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,2\n'
    '    rebase,completed,0,1410\n'
    '    review,running,0,412006\n'
)

# The nine rows as the GATE must carry them: every name present, every status
# mapped, `pending` REPRESENTED rather than dropped or inferred green.
_EXPECTED_INTERIM_STEPS = [
    {"name": "intent", "status": "passed"},
    {"name": "rebase", "status": "passed"},
    {"name": "review", "status": "running"},
    {"name": "test", "status": "pending"},
    {"name": "document", "status": "pending"},
    {"name": "lint", "status": "pending"},
    {"name": "push", "status": "pending"},
    {"name": "pr", "status": "pending"},
    {"name": "ci", "status": "pending"},
]


# ═════════════════════════════════════════════════════════════════════════════
# THE PROXIED TOOL — a real executable on PATH, split by subcommand
# ═════════════════════════════════════════════════════════════════════════════
#
# `axi status` is a one-shot poll of a run in progress; `axi run` BLOCKS until
# the run resolves (or its `--wait` elapses) and only then prints its final
# snapshot. Every poll is LOGGED, so each drive can assert that the loop really
# polled before reading anything into a POST count — a drive whose run outran
# the loop would otherwise pass the "no interim" criteria vacuously.

_FAKE_STREAMING_BODY = '''
import os
import sys
import time

argv = sys.argv[1:]
poll_log = os.environ.get("GATE_RUN_FAKE_POLL_LOG")

if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    if poll_log:
        with open(poll_log, "a") as f:
            f.write("status\\n")
    sys.stdout.write({status_snap!r})
    sys.exit(0)
if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "run":
    time.sleep({run_seconds})
    sys.stdout.write({run_snap!r})
    sys.exit({exit_code})
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''

# The ADVANCING tool: the same split fake whose `axi status` answers with the
# EARLY ladder until `advance_after` seconds of the run have passed and the LATE
# one after that. Driven off the run's own start time rather than a poll count,
# because how often the loop polls is the implementation's business — the
# fixture must not encode it.
_FAKE_ADVANCING_BODY = '''
import os
import sys
import time

argv = sys.argv[1:]
poll_log = os.environ.get("GATE_RUN_FAKE_POLL_LOG")
start_file = os.environ.get("GATE_RUN_FAKE_START_FILE")

if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    if poll_log:
        with open(poll_log, "a") as f:
            f.write("status\\n")
    started = 0.0
    if start_file and os.path.exists(start_file):
        with open(start_file) as f:
            started = float(f.read().strip() or "0")
    elapsed = (time.time() - started) if started else 0.0
    if elapsed < {advance_after}:
        sys.stdout.write({early_snap!r})
    else:
        sys.stdout.write({late_snap!r})
    sys.exit(0)
if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "run":
    if start_file:
        with open(start_file, "w") as f:
            f.write(repr(time.time()))
    time.sleep({run_seconds})
    sys.stdout.write({run_snap!r})
    sys.exit({exit_code})
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''


def _load_module(path, name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom. A missing file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The shared module the client delegates to, loaded once. Used ONLY to state a
# fixture premise in the cadence drive below — `axi_ladder_identity` is the
# throttle's own definition of "a different ladder", so asserting the two
# fixtures differ BY IT is stronger than asserting their text differs.
_AXI = _load_module(AXI_MODULE_PATH, "axi_under_test_streams_its_ladder")


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


_Drive = namedtuple("_Drive", "code out err posts envelopes polls")


class _GateRunStreamTestBase(unittest.TestCase):
    """The sibling suite's transport-seam harness, one addition: the fake logs
    every `axi status` it answers, so a POST count is only ever read against a
    loop that demonstrably polled."""

    PROJECT_KEY = "streams-its-ladder-key"
    AGENT = "streams-its-ladder-agent"
    STATUS_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT
    # A bounded hold is NOT a failed run — the tool says so itself — so the
    # proxied process exits 0 in every drive below.
    TOOL_EXIT = 0
    # Shorter than the 2 s posting cadence: the whole drive is ONE cadence
    # window, which is what the cadence criterion counts POSTs across.
    RUN_SECONDS = 1.0

    def setUp(self):
        self.module = _load_module(BUN_CLIENT_PATH, "streams_its_ladder_client")
        self.tmpdir = tempfile.mkdtemp(prefix="streams-its-ladder-")
        (Path(self.tmpdir) / ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=" + self.PROJECT_KEY + "\n")
        self.poll_log = str(Path(self.tmpdir) / "axi-status-polls.log")
        self.start_file = str(Path(self.tmpdir) / "axi-run-start")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["GATE_RUN_FAKE_POLL_LOG"] = self.poll_log
        os.environ["GATE_RUN_FAKE_START_FILE"] = self.start_file
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="streams-its-ladder-fake-bin-")
        fake = Path(self.fake_bin_dir) / "no-mistakes"
        fake.write_text("#!" + sys.executable + "\n" + self.fake_tool_body())
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

    def fake_tool_body(self):
        return _FAKE_STREAMING_BODY.format(status_snap=self.STATUS_SNAPSHOT,
                                           run_snap=self.RUN_SNAPSHOT,
                                           run_seconds=self.RUN_SECONDS,
                                           exit_code=self.TOOL_EXIT)

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        os.environ.pop("GATE_RUN_FAKE_POLL_LOG", None)
        os.environ.pop("GATE_RUN_FAKE_START_FILE", None)
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, *extra):
        """One whole `gate-run` → its exit code, its streams, the gate POST
        BODIES that reached the wire, the envelopes it emitted, and how many
        times the proxied tool was polled."""
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
        polls = 0
        if os.path.exists(self.poll_log):
            with open(self.poll_log) as f:
                polls = len([line for line in f if line.strip()])
        return _Drive(code=code, out=out, err=err,
                      posts=[p for path, p in posted if path == GATES_PATH],
                      envelopes=envelopes, polls=polls)

    def assert_the_loop_polled(self, drive, at_least=1):
        """Premise for every POST count below: the loop really asked the tool.
        A drive whose run outran the poll loop would satisfy every "no interim
        gate" assertion without the guard having decided anything."""
        self.assertGreaterEqual(
            drive.polls, at_least,
            "harness: `gate-run` must have polled `axi status` at least "
            + repr(at_least) + " time(s) while the proxied run was in flight — "
            "a POST count read off a loop that never polled proves nothing; "
            "got " + repr(drive.polls) + " poll(s), exit " + repr(drive.code)
            + ", stderr " + repr(drive.err.strip()[:300]))

    def gates(self, drive):
        return [p.get("gate", {}) for p in drive.posts]

    def interim_posts(self, drive):
        """The POSTs that are NOT the sealing one. A seal is the gate built from
        `axi run`'s own return and is the only gate carrying the commit it
        gated, so it is identified by that rather than by position — position
        would make this helper agree with whatever order the code happens to
        use."""
        return [p for p in drive.posts if "push" not in p.get("gate", {})]

    def the_one_envelope(self, drive):
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

        STDOUT IS DELIBERATELY EXCLUDED — the proxy relays the tool's raw
        snapshot there, so searching it would let an assertion pass on text
        `gate-run` merely echoed rather than text it understood."""
        return "\n".join([drive.err, envelope["legacy"] or "",
                          json.dumps(envelope["fields"], default=str)])

    def the_human_channel(self, drive, envelope):
        """What a HUMAN reading the run's report sees: stderr and the legacy
        line ONLY. The machine-readable fields are excluded here on purpose —
        the criterion is that the human channel says it TOO, and including the
        fields would let `postedGate: interim` satisfy it."""
        return "\n".join([drive.err, envelope["legacy"] or ""])


# ── §S2 — the guard tests TERMINALITY, not row count ──────────────────────


class ANineRowLadderStillRunningReachesTheBoardTest(_GateRunStreamTestBase):
    """§S2's reversal, driven whole. `axi status` returns the shape a live run
    really emits — nine rows, `review` running, six `pending`, no `outcome` —
    and `axi run` then returns its bounded hold, so this drive posts an interim
    gate and seals nothing. Today it posts NOTHING: the row count alone closes
    the guard."""

    STATUS_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT

    def test_a_nine_row_ladder_with_pending_steps_posts_an_interim_gate(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            [g.get("outcome") for g in self.gates(drive)], [INTERIM_OUTCOME],
            "a run still going puts its ladder on the board: exactly ONE gate "
            "reaches the wire on this drive, the interim one, because the run "
            "then held and sealed nothing. The nine-row shape is what `axi "
            "status` ALWAYS returns (no-mistakes v" + TOOL_VERSION + "), so a "
            "guard reading the row count posts nothing for any real run; the "
            "bodies posted were " + repr(drive.posts))

    def test_the_interim_gate_carries_all_nine_names_with_their_mapped_statuses(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        interim = self.interim_posts(drive)
        self.assertEqual(
            len(interim), 1,
            "premise: one interim gate must have reached the wire before its "
            "ladder can be read; got " + repr(drive.posts))
        self.assertEqual(
            interim[0].get("gate", {}).get("steps"), _EXPECTED_INTERIM_STEPS,
            "the interim gate carries ALL NINE step names with their mapped "
            "statuses, in the tool's own order: `pending` is REPRESENTED, not "
            "dropped and not inferred green, because the ladder is the only "
            "evidence a reader has of where the run has actually got to; got "
            + repr(interim[0].get("gate", {}).get("steps")))

    def test_the_interim_gate_is_marked_in_flight_inside_the_gate_object(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        interim = self.interim_posts(drive)
        self.assertEqual(
            len(interim), 1,
            "premise: one interim gate must have reached the wire before its "
            "mark can be read; got " + repr(drive.posts))
        self.assertIs(
            interim[0].get("gate", {}).get(IN_FLIGHT_FIELD), True,
            "the interim gate carries `gate." + IN_FLIGHT_FIELD + ": true` — "
            "EXPLICIT data on the event, by key, never inferred from a step "
            "count or a missing `push`, both of which this very defect proved "
            "unreliable. It is the mark both readers already exclude on "
            "(`workflowLens`'s gated waves, `boundaryGate`'s primary zone), so "
            "an unmarked interim gate is a false green on the board the moment "
            "it is posted; got " + repr(interim[0]))

    def test_the_interim_gate_carries_no_version_key(self):
        drive = self.drive("--release", "0.2.0")
        self.assert_the_loop_polled(drive)
        interim = self.interim_posts(drive)
        self.assertEqual(
            len(interim), 1,
            "premise: one interim gate must have reached the wire before its "
            "keys can be read; got " + repr(drive.posts))
        self.assertNotIn(
            "version", interim[0],
            "an in-flight gate is NOT release-stamped, even when `--release` "
            "was given: a gate carrying `version` is retention-protected "
            "(LIVE_GATE, src/store.ts), so stamping every interim snapshot "
            "would leave a run's worth of unprunable gates behind for one "
            "release — and the SEAL restates the release anyway; got "
            + repr(interim[0]))

    def test_the_envelope_names_the_interim_gate_it_posted(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            [g.get("outcome") for g in self.gates(drive)], [INTERIM_OUTCOME],
            "premise: the field asserted below is only worth anything because "
            "a gate is really sitting on the board; got " + repr(drive.posts))
        envelope = self.the_one_envelope(drive)
        self.assertEqual(
            envelope["fields"].get(POSTED_GATE_FIELD), INTERIM_GATE,
            "the envelope NAMES the gate this exit posted, and on the nine-row "
            "path it posted an interim one: `" + NO_GATE_POSTED + "` states "
            "that the exit did the thing ZERO times, which is a "
            "machine-readable lie while its gate is on the board — in the very "
            "field an orchestrator branches on; got " + repr(envelope["fields"]))

    def test_the_human_report_says_a_gate_already_reached_the_board(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            [g.get("outcome") for g in self.gates(drive)], [INTERIM_OUTCOME],
            "premise: a gate must really be on the board before the report can "
            "be required to say so; got " + repr(drive.posts))
        told = self.the_human_channel(drive, self.the_one_envelope(drive))
        lowered = told.lower()
        self.assertTrue(
            any(token in lowered for token in BOARD_REACHED_TOKENS),
            "the HUMAN channel must say a gate already reached the board. "
            "Today it says `NOT SEALED`, names the run's own error and the "
            "reattach move — all true, and all leaving the impression the "
            "board is silent, with only the machine-readable `postedGate` to "
            "correct it. Any wording carrying the FACT satisfies this (one of "
            + repr(BOARD_REACHED_TOKENS) + "); the caller was told " + repr(told))

    def test_the_envelope_outcome_is_not_the_zero_times_word_while_a_gate_is_on_the_board(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            [g.get("outcome") for g in self.gates(drive)], [INTERIM_OUTCOME],
            "premise: a gate must really be on the board for the envelope's "
            "`outcome` to be ambiguous about it; got " + repr(drive.posts))
        fields = self.the_one_envelope(drive)["fields"]
        outcome = fields.get(OUTCOME_FIELD)
        self.assertTrue(
            isinstance(outcome, str) and outcome,
            "the envelope STATES an outcome as a value — an absent or empty "
            "one cannot be told from a client too old to have the field; got "
            + repr(fields))
        self.assertNotEqual(
            outcome, NO_GATE_POSTED,
            "`" + NO_GATE_POSTED + "` is this fleet's word for `this exit did "
            "the thing ZERO times`, and a reader who takes it to mean nothing "
            "about this run reached the board is wrong — an interim gate is "
            "sitting there. A reader must be able to conclude what happened "
            "from this field ALONE, without a second field correcting it; got "
            + repr(fields))
        self.assertNotIn(
            outcome, GATE_OUTCOMES,
            "and it must not read as a VERDICT either: nothing was sealed on "
            "this path, so any of the server's four gate outcomes here would "
            "claim a terminus the run never reached; got " + repr(fields))

    def test_the_interim_then_hold_report_still_names_the_error_and_the_reattach_move(self):
        """PASS-SIDE — the facts the hold's report already carries must SURVIVE
        the rewrite: saying a gate reached the board is an addition, not a
        replacement. A report that traded the run's own error for the new
        sentence would strand its caller exactly as the silence did."""
        drive = self.drive()
        told = self.what_the_caller_was_told(drive, self.the_one_envelope(drive))
        self.assertIn(
            HOLD_ERROR, told,
            "the snapshot's OWN error answers `did this run terminate?` and is "
            "already in hand; the caller was told " + repr(told))
        self.assertIn(
            REATTACH_MOVE, told,
            "and the tool's own next move (`" + REATTACH_MOVE + "`) is what "
            "resumes a held run; the caller was told " + repr(told))


class ASealingNineRowSnapshotIsNeverPostedAsInterimTest(_GateRunStreamTestBase):
    """§S2's other direction, and the reason the guard cannot simply be deleted:
    a nine-row ladder that is `completed` with a resolved outcome is TERMINAL.
    It reaches the board once, as the seal it is.

    PASS-SIDE today — the row-count guard happens to withhold it for the wrong
    reason — and load-bearing after the repair, because a guard rewritten to
    fire on "nine rows" rather than on "not terminal" would post a duplicate
    gate claiming to be in flight for every finished run."""

    STATUS_SNAPSHOT = _RESOLVED_SNAPSHOT
    RUN_SNAPSHOT = _RESOLVED_SNAPSHOT

    def test_a_resolved_nine_row_snapshot_posts_only_its_seal(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            self.interim_posts(drive), [],
            "a snapshot with nine `completed` rows and a resolved `outcome` is "
            "TERMINAL: there is nothing in flight to stream, so no interim "
            "gate is posted for it however the guard is rewritten; got "
            + repr(drive.posts))
        self.assertEqual(
            [(g.get("outcome"), g.get("push")) for g in self.gates(drive)],
            [("passed", {"commit": SNAPSHOT_HEAD})],
            "and the run still SEALS exactly once, naming the commit it gated — "
            "the narrowing must not cost a finished run its gate; got "
            + repr(drive.posts))

    def test_the_seal_carries_no_in_flight_mark(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            [g.get(IN_FLIGHT_FIELD) for g in self.gates(drive)], [None],
            "a SEAL is a verdict and carries no in-flight mark at all — the "
            "mark is what tells the two readers to ignore a gate, and a "
            "marked seal would silently un-gate the wave it just gated; got "
            + repr(drive.posts))
        self.assertEqual(
            self.the_one_envelope(drive)["fields"].get(POSTED_GATE_FIELD),
            FINAL_GATE,
            "and the envelope names it `" + FINAL_GATE + "`; got "
            + repr(self.the_one_envelope(drive)["fields"]))


# ── §S2 — the LADDER is the throttle, not the clock alone ──────────────────


class ALadderHeldAcrossCadenceWindowsIsPostedOnceTest(_GateRunStreamTestBase):
    """§S2's volume control, ruled 2026-09-10. The run sits at ONE step for five
    seconds — several 2 s cadence windows — and the board gets ONE gate.

    The arithmetic behind the ruling: at a 2 s cadence a 45-minute pipeline
    posts ~1350 gate events, against 1842 events on this whole board. The step
    ladder transitions at most nine times per run, so the ladder is the honest
    unit of change. The cadence itself is untouched (Non-goal) — this is an
    ADDITIONAL condition, which is why the assertion counts POSTs rather than
    reading a constant."""

    STATUS_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT
    # Five seconds spans three 2 s posting windows, so an unthrottled loop has
    # three chances to post the same unchanged ladder.
    RUN_SECONDS = 5.0

    def test_a_ladder_held_across_several_cadence_windows_posts_exactly_one_gate(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive, at_least=2)
        self.assertEqual(
            len(self.interim_posts(drive)), 1,
            "the same nine-row ladder — same names, same statuses, same absent "
            "`outcome` — answered every poll across several cadence windows, "
            "so exactly ONE interim gate belongs on the board: the second and "
            "third posts would restate a fact already recorded, and at run "
            "length they are what turns streaming into ~1350 events for one "
            "run; got " + repr(len(self.interim_posts(drive))) + " interim "
            "post(s): " + repr(drive.posts))


class AnUnchangedShortLadderIsNotRepostedEveryWindowTest(_GateRunStreamTestBase):
    """The ladder-change throttle, ISOLATED from the guard.

    A three-row ladder already clears today's `0 < nsteps < 9`, so this drive
    posts on EVERY cadence window on today's tree — which makes the repeat POSTs
    the only thing this test can fail on. Read beside the nine-row twin above,
    the pair separates the two defects: that one fails at zero posts (the guard
    never fires), this one fails at three (nothing dedups)."""

    STATUS_SNAPSHOT = _SHORT_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT
    RUN_SECONDS = 5.0

    def test_an_unchanged_ladder_is_posted_once_however_many_windows_open(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive, at_least=2)
        self.assertEqual(
            len(self.interim_posts(drive)), 1,
            "a POST fires on LADDER CHANGE, not on every cadence tick: this "
            "ladder never changed, so the board gets one gate no matter how "
            "many windows elapsed. More than one is the repeat traffic the "
            "ruling forbids; fewer is the guard withholding the stream "
            "altogether; got " + repr(len(self.interim_posts(drive)))
            + " interim post(s): " + repr(drive.posts))


class ALadderThatAdvancesIsPostedAgainTest(_GateRunStreamTestBase):
    """The anti-vacuity twin of the two throttle tests: a client that posted one
    interim gate per RUN and then went quiet would satisfy both of them and
    still stream nothing. The ladder moves — `review` completes, `test` starts —
    and the board is told."""

    STATUS_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT
    RUN_SECONDS = 5.0
    ADVANCE_AFTER = 3.0

    def fake_tool_body(self):
        return _FAKE_ADVANCING_BODY.format(
            early_snap=_LIVE_IN_FLIGHT_SNAPSHOT,
            late_snap=_ADVANCED_IN_FLIGHT_SNAPSHOT,
            advance_after=self.ADVANCE_AFTER,
            run_snap=self.RUN_SNAPSHOT,
            run_seconds=self.RUN_SECONDS,
            exit_code=self.TOOL_EXIT)

    def test_a_ladder_that_advanced_puts_the_new_ladder_on_the_board(self):
        drive = self.drive()
        self.assert_the_loop_polled(drive, at_least=2)
        interim = self.interim_posts(drive)
        self.assertEqual(
            len(interim), 2,
            "the ladder changed exactly ONCE during this run, so exactly TWO "
            "interim gates belong on the board — one per distinct ladder. One "
            "post means a client that streams a run's first snapshot and then "
            "goes silent; three means the dedup is not comparing ladders at "
            "all; got " + repr(len(interim)) + ": " + repr(drive.posts))
        self.assertEqual(
            [[s.get("status") for s in p.get("gate", {}).get("steps", [])][2:4]
             for p in interim],
            [["running", "pending"], ["passed", "running"]],
            "and the SECOND gate carries the ADVANCED ladder — `review` passed, "
            "`test` running — not a re-post of the first: streaming a stale "
            "snapshot twice would satisfy a bare count while telling the board "
            "nothing new; got " + repr(drive.posts))


class TwoLaddersInsideOneCadenceWindowPostOnceTest(_GateRunStreamTestBase):
    """§S2's CADENCE, discharged NON-VACUOUSLY.

    Every other drive in this file holds ONE ladder for its whole length, so
    the LADDER throttle alone accounts for each of their POST counts: delete
    the `(now - last_poll) >= _GATE_POLL_CADENCE_S` guard entirely and not one
    of them goes red. This drive separates the two throttles. The run is
    SHORTER than a single 2 s cadence window and its ladder ADVANCES inside
    that window, so the ladder check has nothing left to withhold and the
    cadence is the only thing that can: with it, the tool is asked once and one
    gate reaches the board; without it, the loop wakes on its 0.4 s tick, sees
    a ladder it has not posted, and posts a second time.

    THE POLL COUNT IS ASSERTED FOR ITS OWN SAKE, because it pins the repair the
    cadence needed. The poll clock used to be stamped only when a gate was
    POSTED (`last_post`), so a run that posted nothing left it `None` and
    `axi status` was spawned on every 0.4 s tick for the whole run — five
    subprocesses a second against a live pipeline. Stamping it on every POLL is
    what makes the window mean anything, and a drive shorter than one window
    may therefore ask the tool exactly once.

    Neither constant is read here: the criterion is the observable POST and
    poll counts of a real drive, and reading `_GATE_POLL_CADENCE_S` back would
    make this test agree with whatever the code happens to say."""

    STATUS_SNAPSHOT = _LIVE_IN_FLIGHT_SNAPSHOT
    RUN_SNAPSHOT = _HELD_RETURN_SNAPSHOT
    # 1.5 s against a 2 s cadence: the whole drive is ONE window, with half a
    # second of margin so a slow machine cannot open a second one.
    RUN_SECONDS = 1.5
    # ...and the ladder moves 0.4 s in — the same `review` completes / `test`
    # starts transition the sibling drives across five seconds, here well
    # inside the single window.
    ADVANCE_AFTER = 0.4

    def fake_tool_body(self):
        return _FAKE_ADVANCING_BODY.format(
            early_snap=_LIVE_IN_FLIGHT_SNAPSHOT,
            late_snap=_ADVANCED_IN_FLIGHT_SNAPSHOT,
            advance_after=self.ADVANCE_AFTER,
            run_snap=self.RUN_SNAPSHOT,
            run_seconds=self.RUN_SECONDS,
            exit_code=self.TOOL_EXIT)

    def test_two_different_ladders_inside_one_cadence_window_post_one_gate(self):
        early = _AXI._decode_axi_snapshot(_LIVE_IN_FLIGHT_SNAPSHOT)
        late = _AXI._decode_axi_snapshot(_ADVANCED_IN_FLIGHT_SNAPSHOT)
        self.assertNotEqual(
            _AXI.axi_ladder_identity(early), _AXI.axi_ladder_identity(late),
            "premise: the two snapshots this drive serves must be DIFFERENT "
            "ladders by the THROTTLE'S OWN definition — otherwise the ladder "
            "check would account for the single POST below and the cadence "
            "would once again be pinned by nothing; got "
            + repr(_AXI.axi_ladder_identity(early)))

        drive = self.drive()
        self.assert_the_loop_polled(drive)
        self.assertEqual(
            len(self.interim_posts(drive)), 1,
            "the board gets ONE gate for this window even though the ladder "
            "advanced inside it: the second ladder is real and different, so "
            "nothing but the cadence can withhold it, and the next window "
            "would have carried it had the run lasted that long. Two posts is "
            "the cadence gone; zero is the stream withheld altogether; got "
            + repr(len(self.interim_posts(drive))) + " interim post(s): "
            + repr(drive.posts))
        self.assertEqual(
            drive.polls, 1,
            "and a drive shorter than ONE cadence window asks the tool exactly "
            "once: the loop wakes on its own short tick, but only the cadence "
            "decides when a wake becomes a poll. More polls than this is the "
            "per-tick spawning a poll clock stamped on POSTS rather than on "
            "POLLS produced for every run that had nothing to post; got "
            + repr(drive.polls) + " poll(s) across a "
            + repr(self.RUN_SECONDS) + "s run, exit " + repr(drive.code))


if __name__ == "__main__":
    unittest.main()
