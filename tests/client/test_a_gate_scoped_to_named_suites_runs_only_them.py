"""A gate scoped to named suites runs only them — and still runs as a gate.

`pre-merge-gate --suites <targets>` re-runs only the named declared suites
after a red gate. It runs its first step (the compile, typecheck or lint step
every gate runs) exactly as a full gate does, then:

  * naming only a DISPATCHED target (bun: a declared suite another stack's
    client owns) runs that suite and skips the bun whole-suite run, so no bun
    run is filed and the milestone names that one suite;
  * naming an OWN-STACK target runs the whole-suite run, which covers every
    own-stack declared target, so the milestone names them all — which is
    why on maven, rust and arduino (whose declarations carry no command and
    name no other stack) `--suites` always runs the whole suite.

Either way the milestone and the envelope state `scope: scoped`, and an
excluded declared target is never listed.

`--suites` is declared once, in the shared module, so all five clients'
`pre-merge-gate --help` list it with the same text.

Driven against a REAL scratch board (`tests/client/real_board.py`): each
client runs as an OS subprocess, every toolchain a small fake that records
each invocation, so "step 0 ran" and "the whole suite did not run" are read
off what was actually invoked, and "posted" is read off the board.

Invocation:
    python3 -m unittest tests.client.test_a_gate_scoped_to_named_suites_runs_only_them -v
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_toon, new_scratch, scrubbed_env
from tests.client.real_board import RealBoard
from tests.client.test_a_gate_milestone_carries_each_suite_result import (
    _FAKE_BUN,
    _FAKE_PYTHON,
    BUN_SUITE,
    EXCLUDED_SUITE,
    PYTHON_CASE,
    PYTHON_SUITE,
    _executable,
)
from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _call,
)
from tests.client.test_client_fleet_envelope_census import (
    _FAKE_TOOLS,
    CLIENT_FILES,
    _make_project_dir,
    drive_verb,
    enumerate_verbs,
)
from tests.client.test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active import (
    _LOG_SNIPPET,
    INVOCATION_LOG,
)
from tests.client.test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close import (
    _SILENT_MAKE_BODY,
    _write_native_fixture,
)

TOON = load_toon()
GATE_VERB = "pre-merge-gate"
SUITES_FLAG = "--suites"
TIMEOUT = 180

def _invocations(directory):
    log = Path(directory) / INVOCATION_LOG
    return log.read_text().splitlines() if log.exists() else []

def _invoked(lines, *shape):
    """The recorded invocations of `shape[0]` (the tool) whose arguments carry
    every word of `shape[1:]`."""
    tool, words = shape[0], shape[1:]
    found = []
    for line in lines:
        name, _, rest = line.partition(" ")
        argv = rest.split()
        if name == tool and all(word in argv for word in words):
            found.append(line)
    return found

def _gate_envelope(stdout):
    """The LAST `pre-merge-gate` envelope on stdout, or None."""
    out = stdout or ""
    for match in reversed(list(re.finditer(r"(?m)^axi:", out))):
        try:
            decoded = TOON.decode(out[match.start():])
        except ValueError:
            continue
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        if isinstance(axi, dict) and axi.get("verb") == GATE_VERB:
            return axi
    return None

def _transcript(result):
    return (f"exit={result.returncode} stdout={(result.stdout or '')[-2000:]!r} "
            f"stderr={(result.stderr or '')[-2500:]!r}")

_BOARD = None

def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "a scoped gate's milestone is read back from a REAL board, and "
            "without `bun` there is none to boot — a missing toolchain, not a "
            "passing assertion")
    _BOARD = RealBoard(bun, "scoped-gate-runs")

def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None

class _OnTheBoard(unittest.TestCase):
    """Plan filing and milestone/run reading against the module's board."""

    @classmethod
    def board(cls):
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        return _BOARD

    @classmethod
    def file_plan(cls, cr):
        """One plan, one cycle taken to done — the gate runs `--cycle <it>`,
        so its milestone carries this plan's CR as its label."""
        board = cls.board()
        orchestrator = f"{cr}-orchestrator"
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": board.key, "agentId": orchestrator,
                          "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = board.http(f"/api/v2/projects/{board.key}/plans",
                           {"cr": cr, "cycles": [{"label": "solo"}],
                            "agentId": orchestrator})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
        path = f"/api/v2/projects/{board.key}/plans/{plan_id}/cycles/{cycle_id}"
        for status in ("active", "done"):
            moved = _call(board.base, path,
                          {"status": status, "agentId": orchestrator},
                          method="PATCH")
            assert moved.get("ok"), f"cycle {status} failed: {moved!r}"
        return cycle_id

    def gate_milestone(self, cr, result):
        """The ONE `pre-merge-gate` milestone labelled `cr`."""
        board = self.board()
        read = board.http(
            f"/api/v2/projects/{board.key}/milestones?type={GATE_VERB}")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        mine = [m for m in read.get("milestones") or [] if m.get("label") == cr]
        self.assertEqual(
            len(mine), 1,
            f"the gate posts exactly one `{GATE_VERB}` milestone for {cr!r}; "
            f"got {mine!r}; {_transcript(result)}")
        return mine[0] if mine else {}

    def runs_filed_by(self, agent):
        """The test runs `agent` filed, read in full."""
        board = self.board()
        return [board.event(e["id"]) for e in board.test_events(agent)]

    def entry_targets(self, record):
        suites = record.get("suites")
        self.assertIsInstance(
            suites, list,
            f"the milestone carries `suites`, one entry per suite the gate "
            f"ran; record={record!r}")
        suites = suites if isinstance(suites, list) else []
        return sorted(str(e.get("target")) for e in suites if isinstance(e, dict))

# ── bun: a scoped gate naming only the dispatched suite ─────────────────────

class AScopedGateNamingOnlyTheDispatchedSuiteTest(_OnTheBoard):
    """bun's project declares a bun suite, a python suite another client owns
    and an excluded e2e suite. `--suites` names only the python suite: the
    gate runs its tsc step, then that suite — and NOT the bun whole suite."""

    CR = "scoped-gate-bun-dispatched-only"
    AGENT = "scoped-gate-bun-dispatched-agent"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        board = cls.board()
        cls.project = new_scratch("scoped-gate-bun-")
        Path(cls.project, "tests").mkdir()
        cls.fake_bun = _executable(os.path.join(cls.project, "fake_bun.py"),
                                   _LOG_SNIPPET + _FAKE_BUN)
        fake_python = _executable(os.path.join(cls.project, "fake_python.py"),
                                  _FAKE_PYTHON)
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(CLIENT_FILES["python"]), "regression",
            "--project-dir", cls.project, "--python", fake_python,
            "--reports", "py-reports"))
        Path(cls.project, "package.json").write_text(json.dumps({
            "name": "scoped-gate-bun", "private": True,
            "scripts": {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite,
                        EXCLUDED_SUITE: "bunx bddgen && bunx playwright test"}},
            indent=2))
        board.install(cls.project)
        cls.result, cls.ran = cls._drive(cls.CR, cls.AGENT,
                                         [SUITES_FLAG, PYTHON_SUITE])
        cls.full_result, cls.full_ran = cls._drive(f"{cls.CR}-full",
                                                   f"{cls.AGENT}-full", [])

    @classmethod
    def _drive(cls, cr, agent, extra):
        """One gate over the project under its own plan's cycle; returns the
        result and the bun invocations it made."""
        cycle_id = cls.file_plan(cr)
        log = Path(cls.project, INVOCATION_LOG)
        log.unlink(missing_ok=True)
        env = scrubbed_env(None)
        for key in ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                    "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
                    "PYTHON_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
                    "CRUCIBLE_PROJECT_KEY", "FAKE_BUN_FAIL", "FAKE_PYTHON_FAIL",
                    "FAKE_TSC_FAIL"):
            env.pop(key, None)
        # Step 0 is NOT skipped: the scoped gate runs it as every gate does.
        result = subprocess.run(
            [sys.executable, str(CLIENT_FILES["bun"]), GATE_VERB,
             "--agent", agent, "--project-dir", cls.project,
             "--package-dir", cls.project, "--bun", cls.fake_bun,
             "--reports", "reports", "--cycle", str(cycle_id)] + list(extra),
            cwd=cls.project, env=env, capture_output=True, text=True,
            timeout=TIMEOUT, check=False)
        return result, _invocations(cls.project)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.project, ignore_errors=True)
        super().tearDownClass()

    def test_the_scoped_gate_passes_on_a_passing_named_suite(self):
        self.assertEqual(
            self.result.returncode, 0,
            f"a scoped gate whose step 0 and named suite pass exits 0; "
            f"{_transcript(self.result)}")

    def test_the_same_project_gated_in_full_runs_the_bun_whole_suite_too(self):
        """GREEN-GUARD: the control — the same project gated in full runs the
        tsc step AND the bun whole suite, and records both gated suites, so
        the scoped drive's fixture is one where the whole suite would run."""
        ran = self.full_ran
        self.assertEqual(len(_invoked(ran, "fake_bun.py", "x", "tsc")), 1,
                         f"invocations={ran!r}; {_transcript(self.full_result)}")
        self.assertEqual(len(_invoked(ran, "fake_bun.py", "test")), 1,
                         f"invocations={ran!r}")
        record = self.gate_milestone(f"{self.CR}-full", self.full_result)
        self.assertEqual((record.get("outcome"), record.get("scope")),
                         ("pass", "full"), f"record={record!r}")
        self.assertEqual(self.entry_targets(record),
                         sorted([BUN_SUITE, PYTHON_SUITE]),
                         f"suites={record.get('suites')!r}")

    def test_the_scoped_gate_runs_the_tsc_step_and_never_the_bun_whole_suite(self):
        ran = self.ran
        self.assertEqual(
            len(_invoked(ran, "fake_bun.py", "x", "tsc")), 1,
            f"step 0 (the tsc typecheck) runs once on a scoped gate; "
            f"invocations={ran!r}; {_transcript(self.result)}")
        self.assertEqual(
            _invoked(ran, "fake_bun.py", "test"), [],
            f"naming only the dispatched suite skips the bun whole-suite run; "
            f"invocations={ran!r}")

    def test_only_the_named_suites_run_is_filed(self):
        runs = self.runs_filed_by(self.AGENT)
        self.assertEqual(
            len(runs), 1,
            f"exactly one run is filed — the dispatched python suite's — and "
            f"no bun run; runs={[(r.get('id'), r.get('summary')) for r in runs]!r}; "
            f"{_transcript(self.result)}")
        self.assertIn(PYTHON_CASE, repr(runs[0].get("tree")) if runs else "",
                      "the one filed run is the python suite's")

    def test_the_milestone_is_scoped_and_names_only_the_named_suite(self):
        record = self.gate_milestone(self.CR, self.result)
        self.assertEqual(record.get("outcome"), "pass", f"record={record!r}")
        self.assertEqual(record.get("scope"), "scoped",
                         f"a gate run with --suites is a scoped gate; "
                         f"record={record!r}")
        self.assertEqual(
            self.entry_targets(record), [PYTHON_SUITE],
            f"the scoped gate names only the suite it ran — not `{BUN_SUITE}`, "
            f"not the whole bun suite, not the excluded `{EXCLUDED_SUITE}`; "
            f"suites={record.get('suites')!r}")
        entry = (record.get("suites") or [{}])[0]
        self.assertEqual(
            (entry.get("outcome"), entry.get("passed"), entry.get("failed")),
            ("pass", 1, 0),
            f"the named suite's entry carries its own outcome and counts; "
            f"entry={entry!r}")
        self.assertEqual((record.get("passed"), record.get("failed")), (1, 0),
                         f"the gate's totals are the named suite's alone; "
                         f"record={record!r}")

    def test_the_gate_envelope_states_a_scoped_scope(self):
        envelope = _gate_envelope(self.result.stdout)
        self.assertIsNotNone(
            envelope, f"the gate puts a `{GATE_VERB}` envelope on stdout; "
                      f"{_transcript(self.result)}")
        self.assertEqual((envelope or {}).get("scope"), "scoped",
                         f"the envelope states the gate's scope; "
                         f"envelope={envelope!r}")

# ── maven, rust, arduino: a scoped gate runs the whole suite ────────────────

def _recording_bin_dir(client_key):
    """The census's passing fakes, each recording its invocations in its own
    bin directory. arduino's `make` writes no report (the gate reads the one
    the fixture wrote), as in the gate-outcome suite."""
    bin_dir = Path(tempfile.mkdtemp(prefix="scoped-gate-bin-"))
    bodies = dict(_FAKE_TOOLS)
    if client_key == "arduino":
        bodies["make"] = _SILENT_MAKE_BODY
    for name, body in bodies.items():
        shebang, rest = body.split("\n", 1)
        path = bin_dir / name
        path.write_text(shebang + "\n" + _LOG_SNIPPET + rest)
        path.chmod(0o755)
    return bin_dir

def _declare_own_stack_suites(client_key, project_dir):
    """Declare two gated targets and one excluded (e2e) target, each in the
    stack's own declaration surface."""
    d = Path(project_dir)
    if client_key == "mvn":
        profiles = "".join(f"<profile><id>{t}</id></profile>"
                           for t in ("unit", "integration", "e2e"))
        (d / "pom.xml").write_text(
            f"<project><profiles>{profiles}</profiles></project>")
    elif client_key == "rust":
        (d / ".config").mkdir(exist_ok=True)
        (d / ".config" / "nextest.toml").write_text("".join(
            f'[profile.{t}]\n\n[profile.{t}.junit]\npath = "junit.xml"\n\n'
            for t in ("unit", "integration", "e2e")))
    elif client_key == "arduino":
        (d / "tests" / "native" / "Makefile").write_text("".join(
            f"junit-{t}:\n\t@true\n" for t in ("unit", "integration", "e2e")))
        _write_native_fixture(d, "pass")

class _AScopedOwnStackGate(_OnTheBoard):
    """One project per stack declaring two gated targets and an excluded
    one; the gate is driven twice over it — scoped to ONE target, and (the
    control) in full."""

    CLIENT: str = ""
    #: The gated targets and the excluded one, as the stack names them.
    GATED: "tuple[str, ...]" = ("",)
    EXCLUDED: str = ""
    #: The step-0 invocation, and the whole-suite run's, as recorded: the
    #: tool's name, then the words its arguments carry.
    STEP_0: "tuple[str, ...]" = ("",)
    WHOLE_SUITE: "tuple[str, ...]" = ("",)
    EXTRA: "tuple[str, ...]" = ()

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.scoped = cls._drive("scoped", [SUITES_FLAG, cls.GATED[0]])
        cls.full = cls._drive("full", [])

    @classmethod
    def _drive(cls, name, extra):
        board = cls.board()
        cr = f"scoped-gate-{cls.CLIENT}-{name}"
        agent = f"{cr}-agent"
        project_dir = _make_project_dir(cls.CLIENT)
        bin_dir = _recording_bin_dir(cls.CLIENT)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={board.key}\n"]
        if cls.CLIENT == "arduino":
            env_lines.append(f"CRUCIBLE_PROJECT_NAME={board.name}\n")
        (project_dir / ".env").write_text("".join(env_lines))
        _declare_own_stack_suites(cls.CLIENT, project_dir)
        cycle_id = cls.file_plan(cr)
        argv = ([GATE_VERB, "--agent", agent, "--project-dir", str(project_dir),
                 "--cycle", str(cycle_id)] + list(cls.EXTRA) + list(extra))
        result = drive_verb(CLIENT_FILES[cls.CLIENT], argv, project_dir, bin_dir,
                            timeout=TIMEOUT, board=board.base)
        drive = {"cr": cr, "agent": agent, "result": result,
                 "ran": _invocations(bin_dir)}
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(bin_dir, ignore_errors=True)
        return drive

    def test_the_scoped_gate_passes(self):
        self.assertEqual(
            self.scoped["result"].returncode, 0,
            f"{self.CLIENT}: a scoped gate whose step 0 and suite pass exits 0; "
            f"{_transcript(self.scoped['result'])}")

    def test_the_scoped_gate_runs_step_0_and_the_whole_suite(self):
        ran = self.scoped["ran"]
        self.assertEqual(
            len(_invoked(ran, *self.STEP_0)), 1,
            f"{self.CLIENT}: step 0 ({' '.join(self.STEP_0)}) runs once on a "
            f"scoped gate; invocations={ran!r}; "
            f"{_transcript(self.scoped['result'])}")
        self.assertEqual(
            len(_invoked(ran, *self.WHOLE_SUITE)), 1,
            f"{self.CLIENT}: naming an own-stack target runs the whole suite "
            f"({' '.join(self.WHOLE_SUITE)}) once; invocations={ran!r}")
        runs = self.runs_filed_by(self.scoped["agent"])
        self.assertEqual(
            len(runs), 1,
            f"{self.CLIENT}: the scoped gate files the one whole-suite run; "
            f"runs={[(r.get('id'), r.get('summary')) for r in runs]!r}")

    def test_the_scoped_milestone_names_every_own_stack_declared_target(self):
        record = self.gate_milestone(self.scoped["cr"], self.scoped["result"])
        self.assertEqual(record.get("outcome"), "pass", f"record={record!r}")
        self.assertEqual(
            record.get("scope"), "scoped",
            f"{self.CLIENT}: a gate run with --suites is a scoped gate, even "
            f"though it ran the whole suite; record={record!r}")
        self.assertEqual(
            self.entry_targets(record), sorted(self.GATED),
            f"{self.CLIENT}: the whole-suite run covers every own-stack "
            f"declared target, so the scoped gate records them all — and not "
            f"the excluded `{self.EXCLUDED}`; suites={record.get('suites')!r}")
        for entry in record.get("suites") or []:
            self.assertEqual(
                (entry.get("outcome"), entry.get("failed"), entry.get("passed")),
                ("pass", 0, record.get("passed")),
                f"{self.CLIENT}: each covered target carries the whole-suite "
                f"run's outcome and counts; entry={entry!r} record={record!r}")

    def test_the_scoped_gate_envelope_states_a_scoped_scope(self):
        envelope = _gate_envelope(self.scoped["result"].stdout)
        self.assertIsNotNone(
            envelope, f"{self.CLIENT}: the gate puts a `{GATE_VERB}` envelope "
                      f"on stdout; {_transcript(self.scoped['result'])}")
        self.assertEqual((envelope or {}).get("scope"), "scoped",
                         f"{self.CLIENT}: the envelope states the gate's scope; "
                         f"envelope={envelope!r}")

    def test_the_same_project_gated_in_full_records_the_same_targets(self):
        """GREEN-GUARD: the control — the same declaration gated in full posts
        `scope: full` naming both gated targets, so the scoped drive's fixture
        is one whose whole-suite run covers them."""
        record = self.gate_milestone(self.full["cr"], self.full["result"])
        self.assertEqual((record.get("outcome"), record.get("scope")),
                         ("pass", "full"),
                         f"{self.CLIENT}: record={record!r}; "
                         f"{_transcript(self.full['result'])}")
        self.assertEqual(self.entry_targets(record), sorted(self.GATED),
                         f"{self.CLIENT}: suites={record.get('suites')!r}")
        for shape in (self.STEP_0, self.WHOLE_SUITE):
            self.assertEqual(len(_invoked(self.full["ran"], *shape)), 1,
                             f"{self.CLIENT}: {' '.join(shape)} runs once; "
                             f"invocations={self.full['ran']!r}")
        self.assertEqual(len(self.runs_filed_by(self.full["agent"])), 1,
                         f"{self.CLIENT}: the full gate files its one "
                         f"whole-suite run")

class AScopedMavenGateRunsTheWholeSuiteTest(_AScopedOwnStackGate):
    CLIENT = "mvn"
    GATED = ("unit", "integration")
    EXCLUDED = "e2e"
    STEP_0 = ("docker", "compose", "up")
    WHOLE_SUITE = ("mvn",)

class AScopedRustGateRunsTheWholeSuiteTest(_AScopedOwnStackGate):
    CLIENT = "rust"
    GATED = ("unit", "integration")
    EXCLUDED = "e2e"
    STEP_0 = ("cargo", "clippy")
    WHOLE_SUITE = ("cargo", "nextest")
    EXTRA = ("--min-free-g", "1")

class AScopedArduinoGateRunsTheWholeSuiteTest(_AScopedOwnStackGate):
    CLIENT = "arduino"
    GATED = ("junit-unit", "junit-integration")
    EXCLUDED = "junit-e2e"
    STEP_0 = ("arduino-cli", "compile")
    WHOLE_SUITE = ("make",)

# The abstract scenario is no test of its own: only its three stacks run.
del _AScopedOwnStackGate

# ── a bound agent: its registered cycle resolves the gate ───────────────────

class AScopedGateOfABoundAgentNeedsNoCycleFlagTest(_OnTheBoard):
    """An agent registered bound to the ACTIVE cycle runs `pre-merge-gate
    --suites <target>` with no `--cycle`: its binding is the cycle the gate
    belongs to, so the gate is not refused, runs, and posts a `scoped`
    milestone under that cycle's CR. Its own project on the board, so its
    active cycle is no other scenario's."""

    CLIENT = "mvn"
    CR = "scoped-gate-bound-agent"
    AGENT = "scoped-gate-bound-agent-verifier"
    TARGET = "unit"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        board = cls.board()
        project = board.http("/api/v2/projects", {"name": cls.CR})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.key = project["project"]["key"]
        orchestrator = f"{cls.CR}-orchestrator"
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": cls.key, "agentId": orchestrator,
                          "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = board.http(f"/api/v2/projects/{cls.key}/plans",
                           {"cr": cls.CR, "cycles": [{"label": "solo"}],
                            "agentId": orchestrator})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id, cls.cycle_id = filed["planId"], filed["cycles"][0]["id"]
        moved = _call(board.base,
                      f"/api/v2/projects/{cls.key}/plans/{plan_id}/cycles/"
                      f"{cls.cycle_id}",
                      {"status": "active", "agentId": orchestrator},
                      method="PATCH")
        assert moved.get("ok"), f"cycle active failed: {moved!r}"
        cls.project_dir = _make_project_dir(cls.CLIENT)
        cls.bin_dir = _recording_bin_dir(cls.CLIENT)
        (cls.project_dir / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        _declare_own_stack_suites(cls.CLIENT, cls.project_dir)
        project_flag = ["--project-dir", str(cls.project_dir)]
        cls.registered = drive_verb(
            CLIENT_FILES[cls.CLIENT],
            ["register", "--agent", cls.AGENT, "--role", "VERIFY",
             "--cycle", str(cls.cycle_id)] + project_flag,
            cls.project_dir, cls.bin_dir, timeout=TIMEOUT, board=board.base)
        cls.result = drive_verb(
            CLIENT_FILES[cls.CLIENT],
            [GATE_VERB, "--agent", cls.AGENT, SUITES_FLAG, cls.TARGET]
            + project_flag,
            cls.project_dir, cls.bin_dir, timeout=TIMEOUT, board=board.base)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.project_dir, ignore_errors=True)
        shutil.rmtree(cls.bin_dir, ignore_errors=True)
        super().tearDownClass()

    def test_the_agent_registered_bound_to_the_active_cycle(self):
        self.assertEqual(self.registered.returncode, 0,
                         f"the bound registration succeeded; "
                         f"{_transcript(self.registered)}")

    def test_the_scoped_gate_is_not_refused_and_passes(self):
        envelope = _gate_envelope(self.result.stdout) or {}
        self.assertNotIn(
            "error", envelope,
            f"a bound agent's scoped gate needs no --cycle, so it is not "
            f"refused; envelope={envelope!r}; {_transcript(self.result)}")
        self.assertEqual(
            (self.result.returncode, envelope.get("ok"), envelope.get("scope")),
            (0, True, "scoped"),
            f"the scoped gate ran and passed; {_transcript(self.result)}")

    def test_the_gate_posts_a_scoped_milestone_under_the_bound_cycle(self):
        read = self.board().http(
            f"/api/v2/projects/{self.key}/milestones?type={GATE_VERB}")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        mine = [m for m in read.get("milestones") or []
                if m.get("label") == self.CR]
        self.assertEqual(len(mine), 1,
                         f"the gate posts one `{GATE_VERB}` milestone under "
                         f"the bound cycle's CR; got {mine!r}; "
                         f"{_transcript(self.result)}")
        record = mine[0] if mine else {}
        self.assertEqual(
            (record.get("outcome"), record.get("scope"),
             (record.get("context") or {}).get("cycleId")),
            ("pass", "scoped", self.cycle_id),
            f"a passing scoped milestone under the cycle the agent is bound "
            f"to; record={record!r}")

# ── help: one shared declaration ────────────────────────────────────────────

class EveryGateListsTheSuitesFlagWithOneHelpTest(unittest.TestCase):
    """All five clients' `pre-merge-gate --help` list `--suites`, and the
    flag's help is the same in all five — the flag is declared once."""

    def _suites_action(self, client_key):
        verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
        found = [a for a in verbs[GATE_VERB]._actions
                 if SUITES_FLAG in a.option_strings]
        self.assertEqual(len(found), 1,
                         f"{client_key}: `{GATE_VERB}` declares `{SUITES_FLAG}` "
                         f"exactly once")
        return found[0] if found else None

    def test_every_clients_gate_help_lists_the_suites_flag(self):
        for client_key in sorted(CLIENT_FILES):
            with self.subTest(client=client_key):
                scratch = tempfile.mkdtemp(prefix="scoped-gate-help-")
                self.addCleanup(shutil.rmtree, scratch, True)
                result = subprocess.run(
                    [sys.executable, str(CLIENT_FILES[client_key]), GATE_VERB,
                     "--help"],
                    cwd=scratch, env=scrubbed_env(None), capture_output=True,
                    text=True, timeout=60, check=False)
                self.assertEqual(result.returncode, 0, _transcript(result))
                self.assertIn(SUITES_FLAG, result.stdout,
                              f"{client_key}: `{GATE_VERB} --help` lists "
                              f"`{SUITES_FLAG}`")
                action = self._suites_action(client_key)
                help_text = " ".join(str(getattr(action, "help", "") or "").split())
                self.assertTrue(help_text, f"{client_key}: `{SUITES_FLAG}` "
                                           f"carries help text")
                self.assertIn(help_text, " ".join(result.stdout.split()),
                              f"{client_key}: `--help` prints the flag's help")

    def test_the_suites_flag_reads_the_same_on_all_five_clients(self):
        declared = {}
        for client_key in sorted(CLIENT_FILES):
            action = self._suites_action(client_key)
            if action is not None:
                declared[client_key] = (action.help, action.metavar,
                                        action.dest, action.nargs)
        self.assertEqual(sorted(declared), sorted(CLIENT_FILES),
                         f"every client declares `{SUITES_FLAG}`; "
                         f"declared={declared!r}")
        self.assertEqual(
            len(set(declared.values())), 1,
            f"one shared declaration: `{SUITES_FLAG}`'s help, metavar, dest "
            f"and arity are identical on all five clients; declared={declared!r}")

if __name__ == "__main__":
    unittest.main()
