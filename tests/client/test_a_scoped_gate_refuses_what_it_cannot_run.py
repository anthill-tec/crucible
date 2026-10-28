"""A gate scoped to named suites refuses, before anything runs, what it cannot
run as asked.

`pre-merge-gate --suites <targets>` is checked FIRST — before the
unattributed-run refusal and before the gate's first step — by one shared
check, and refused whole as a typed hard stop: an `ok:false` envelope carrying
an `error` that names the cause and a `help[]`, a non-zero exit, nothing run,
nothing filed (no run, compile or lint result) and no `pre-merge-gate`
milestone. It refuses, on every one of the five clients:

  * a board that does not state that it records a gate's scope and suites;
  * a target the project does not declare, or declares excluded — the
    declared targets named so the caller can pick one;
  * a list with an empty, padded or repeated item;
  * `--suites` beside `--release`;
  * a gate no cycle resolves for (no `--cycle`, and the agent bound to none).

python's surface cannot enumerate a project's declaration, so python refuses
EVERY `--suites` as a project that declares no suites.

Each case drives the real client as an OS subprocess. Every toolchain is a
fake that records its invocations, and every compile, typecheck and lint step
is made to FAIL, so a gate that got as far as its first step would both leave
an invocation behind and file a compile or lint result. The board is a REAL
scratch board (`tests/client/real_board.py`), which states the capability, for
every case but the capability one, which runs against a recording stand-in
whose health answer states nothing.

A rejection by argparse (an unrecognised `--suites`) also runs nothing, so
every case asserts the TYPED refusal — the envelope and the cause it names —
which an argparse exit does not give.

Invocation:
    python3 -m unittest tests.client.test_a_scoped_gate_refuses_what_it_cannot_run -v
"""

import json
import re
import shlex
import shutil
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import RecordingBoard
from tests.client.real_board import RealBoard
from tests.client.test_a_gate_milestone_carries_each_suite_result import (
    BUN_SUITE,
    EXCLUDED_SUITE,
    PYTHON_SUITE,
)
from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _call,
)
from tests.client.test_client_fleet_envelope_census import (
    _UNREACHABLE_CRUCIBLE_URL,
    CLIENT_FILES,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    drive_verb,
)
from tests.client.test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active import (
    _PYTHON_WRAPPER,
    _build_recording_bin_dir,
    _invocations,
    _seed,
)

GATE_VERB = "pre-merge-gate"
SUITES_FLAG = "--suites"
TIMEOUT = 120

#: Per client: the gated targets its fixture declares, the one it declares
#: excluded, and one it does not declare. python declares nothing; its
#: "targets" are names a caller might try.
TARGETS = {
    "bun": {"gated": (BUN_SUITE, PYTHON_SUITE), "excluded": EXCLUDED_SUITE,
            "undeclared": "test:nowhere"},
    "mvn": {"gated": ("unit", "integration"), "excluded": "e2e",
            "undeclared": "module"},
    "rust": {"gated": ("unit", "integration"), "excluded": "e2e",
             "undeclared": "module"},
    "arduino": {"gated": ("junit-unit", "junit-integration"),
                "excluded": "junit-e2e", "undeclared": "junit-module"},
    "python": {"gated": ("tests/unit", "tests/integration"), "excluded": None,
               "undeclared": "tests/nowhere"},
}

#: How a refusal names a project that declares no suites (python, always).
DECLARES_NO_SUITES = (r"declares? no\b|no (declared |gate )*suites?|"
                      r"declare[sd]? none|none (are |is )?declared|"
                      r"nothing (is )?declared")

def _named(text, target):
    """True when `target` appears in `text` as a whole name — `unit` is not
    found inside `junit-unit`."""
    return re.search(r"(?<![\w/:.-])" + re.escape(target) + r"(?![\w/:.-])",
                     text) is not None

def _declare(client_key, project_dir):
    """The stack's own declaration of its two gated targets and the excluded
    one."""
    d = Path(project_dir)
    if client_key == "bun":
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(CLIENT_FILES["python"]), "regression",
            "--project-dir", str(d)))
        (d / "package.json").write_text(json.dumps({
            "name": "scoped-gate-refusal", "private": True,
            "scripts": {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite,
                        EXCLUDED_SUITE: "bunx bddgen && bunx playwright test"}}))
    elif client_key == "mvn":
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
    elif client_key == "python":
        # A source that does not compile: a gate whose step 0 ran would file
        # a compile result.
        _seed("python", GATE_VERB, d)

def _client_argv(client_key, project_dir, bin_dir):
    """The flags each client's gate needs beyond `--agent` and the project."""
    if client_key == "bun":
        return ["--package-dir", str(project_dir), "--reports", "reports"]
    if client_key == "rust":
        return ["--min-free-g", "1"]
    if client_key == "python":
        return ["--python", str(Path(bin_dir) / _PYTHON_WRAPPER)]
    return []

_BOARD = None

def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "nothing filed and no milestone posted are read back from a REAL "
            "board, and without `bun` there is none to boot — a missing "
            "toolchain, not a passing assertion")
    _BOARD = RealBoard(bun, "scoped-gate-refusals")

def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None

class _AScopedGateRefusal(unittest.TestCase):
    """The refusal cases for ONE client, each its own test. The client's
    project on the real board carries one plan whose cycle is done (so no
    cycle is ACTIVE, and the unattributed-run refusal cannot stand in for the
    no-cycle one)."""

    CLIENT: str = ""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        cls.toon = _load_toon_module()
        project = cls.board.http("/api/v2/projects",
                                 {"name": f"scoped-gate-refusals-{cls.CLIENT}"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.key = project["project"]["key"]
        orchestrator = f"scoped-refusal-{cls.CLIENT}-orchestrator"
        reg = cls.board.http("/api/v2/agents/register",
                             {"projectKey": cls.key, "agentId": orchestrator,
                              "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = cls.board.http(f"/api/v2/projects/{cls.key}/plans",
                               {"cr": f"scoped-refusal-{cls.CLIENT}-plan",
                                "cycles": [{"label": "solo"}],
                                "agentId": orchestrator})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id, cls.cycle_id = filed["planId"], filed["cycles"][0]["id"]
        path = f"/api/v2/projects/{cls.key}/plans/{plan_id}/cycles/{cls.cycle_id}"
        for status in ("active", "done"):
            moved = _call(cls.board.base, path,
                          {"status": status, "agentId": orchestrator},
                          method="PATCH")
            assert moved.get("ok"), f"cycle {status} failed: {moved!r}"

    # ── drive + read ────────────────────────────────────────────────────────

    def _gate_milestones(self):
        read = self.board.http(
            f"/api/v2/projects/{self.key}/milestones?type={GATE_VERB}")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        return read.get("milestones") or []

    def _filed_by(self, agent_id):
        """Every event the agent filed beyond its identity's lifecycle: the
        runs, compile and lint results a refusal must prevent."""
        read = self.board.http(f"/api/v2/events?project={self.key}&limit=500")
        self.assertTrue(read.get("ok"), f"events read failed: {read!r}")
        return [e for e in (read.get("events") or [])
                if e.get("agentId") == agent_id and e.get("kind") != "lifecycle"]

    def _drive(self, case, suites, *, cycle=True, release=None, board=None,
               key=None):
        agent = f"scoped-refusal-{self.CLIENT}-{case}"
        bin_dir = _build_recording_bin_dir()
        self.addCleanup(shutil.rmtree, bin_dir, True)
        project_dir = _make_project_dir(self.CLIENT)
        self.addCleanup(shutil.rmtree, project_dir, True)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={key or self.key}\n"]
        if self.CLIENT == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=scoped-gate-refusals\n")
        (project_dir / ".env").write_text("".join(env_lines))
        _declare(self.CLIENT, project_dir)
        argv = ([GATE_VERB, "--agent", agent, "--project-dir", str(project_dir)]
                + _client_argv(self.CLIENT, project_dir, bin_dir)
                + [SUITES_FLAG, suites])
        if cycle:
            argv += ["--cycle", str(self.cycle_id)]
        if release:
            argv += ["--release", release]
        result = drive_verb(CLIENT_FILES[self.CLIENT], argv, project_dir, bin_dir,
                            timeout=TIMEOUT, board=board or self.board.base)
        _emits, axi = classify_envelope(result.stdout, self.toon)
        return agent, result, axi or {}, _invocations(bin_dir)

    @staticmethod
    def _transcript(result):
        return (f"exit={result.returncode} stdout={(result.stdout or '')[:1200]!r} "
                f"stderr={(result.stderr or '')[-1500:]!r}")

    def assertTypedRefusal(self, result, axi):
        """The refusal is the typed hard stop: a non-zero exit and ONE
        `ok:false` `pre-merge-gate` envelope carrying an error and help, and
        naming no filed event. Returns the error and help as one text."""
        self.assertEqual(
            (axi.get("verb"), axi.get("ok")), (GATE_VERB, False),
            f"{self.CLIENT}: a refused --suites is a typed hard stop — an "
            f"ok:false `{GATE_VERB}` envelope, not an argparse rejection or a "
            f"run; {self._transcript(result)}")
        self.assertNotEqual(result.returncode, 0,
                            f"{self.CLIENT}: a refusal exits non-zero; "
                            f"{self._transcript(result)}")
        error = axi.get("error")
        self.assertIsInstance(error, str, f"the refusal states an error; axi={axi!r}")
        self.assertTrue((error or "").strip(), f"axi={axi!r}")
        help_ = axi.get("help")
        self.assertIsInstance(help_, list, f"the refusal states help; axi={axi!r}")
        self.assertTrue(help_, f"axi={axi!r}")
        self.assertEqual(axi.get("events"), [],
                         f"{self.CLIENT}: a refusal filed nothing, so its "
                         f"envelope names no event; axi={axi!r}")
        return " ".join([str(error)] + [str(h) for h in (help_ or [])])

    def assertNothingRanOrFiled(self, agent, ran, milestones_before, result):
        self.assertEqual(
            ran, [],
            f"{self.CLIENT}: refused before anything runs — no toolchain was "
            f"invoked (step 0 included); {self._transcript(result)}")
        self.assertEqual(
            self._filed_by(agent), [],
            f"{self.CLIENT}: refused before anything is filed — no run, compile "
            f"or lint result")
        self.assertEqual(
            len(self._gate_milestones()), milestones_before,
            f"{self.CLIENT}: a refused gate posts no `{GATE_VERB}` milestone")

    def assertCause(self, text, pattern, what):
        """The error or help names the cause. python refuses every --suites
        as declaring none, so for python that reading is the cause too."""
        if self.CLIENT == "python":
            pattern = f"(?:{pattern})|(?:{DECLARES_NO_SUITES})"
        self.assertRegex(text.lower(), pattern,
                         f"{self.CLIENT}: the refusal names its cause ({what}); "
                         f"error+help={text!r}")

    def _refused(self, case, suites, **drive):
        before = len(self._gate_milestones())
        agent, result, axi, ran = self._drive(case, suites, **drive)
        text = self.assertTypedRefusal(result, axi)
        self.assertNothingRanOrFiled(agent, ran, before, result)
        return text

    # ── the causes ──────────────────────────────────────────────────────────

    @property
    def targets(self):
        return TARGETS[self.CLIENT]

    def test_an_undeclared_target_is_refused_naming_the_declared_targets(self):
        undeclared = self.targets["undeclared"]
        text = self._refused("undeclared", undeclared)
        if self.CLIENT == "python":
            self.assertRegex(
                text.lower(), DECLARES_NO_SUITES,
                f"python: every --suites is refused as a project that declares "
                f"no suites; error+help={text!r}")
            return
        self.assertTrue(_named(text, undeclared),
                        f"{self.CLIENT}: the refusal names the target it "
                        f"refused ({undeclared!r}); error+help={text!r}")
        for target in self.targets["gated"]:
            self.assertTrue(_named(text, target),
                            f"{self.CLIENT}: the refusal names the declared "
                            f"target {target!r} the caller can name instead; "
                            f"error+help={text!r}")

    def test_an_excluded_target_is_refused_naming_the_declared_targets(self):
        excluded = self.targets["excluded"]
        if excluded is None:
            # python declares nothing, so nothing is excluded: the case is the
            # undeclared one above. Asserted so the method is never vacuous.
            self.assertEqual(self.CLIENT, "python")
            text = self._refused("excluded", "tests/e2e")
            self.assertRegex(text.lower(), DECLARES_NO_SUITES,
                             f"python: error+help={text!r}")
            return
        text = self._refused("excluded", excluded)
        self.assertCause(text, r"exclu", "the target is declared excluded")
        self.assertTrue(_named(text, excluded),
                        f"{self.CLIENT}: the refusal names the excluded target "
                        f"{excluded!r}; error+help={text!r}")
        for target in self.targets["gated"]:
            self.assertTrue(_named(text, target),
                            f"{self.CLIENT}: the refusal names the declared "
                            f"target {target!r}; error+help={text!r}")

    def test_a_list_with_an_empty_item_is_refused(self):
        first, second = self.targets["gated"]
        text = self._refused("empty-item", f"{first},,{second}")
        self.assertCause(text, r"empty", "an empty item")

    def test_a_list_with_a_padded_item_is_refused(self):
        first, second = self.targets["gated"]
        text = self._refused("padded-item", f"{first}, {second}")
        self.assertCause(text, r"pad|space|whitespace|blank",
                         "a padded item")

    def test_a_list_with_a_repeated_item_is_refused(self):
        first, _second = self.targets["gated"]
        text = self._refused("repeated-item", f"{first},{first}")
        self.assertCause(text, r"repeat|twice|more than once|duplicate",
                         "a repeated item")
        if self.CLIENT != "python":
            self.assertTrue(_named(text, first),
                            f"{self.CLIENT}: the refusal names the repeated "
                            f"target {first!r}; error+help={text!r}")

    def test_suites_beside_release_is_refused(self):
        first, _second = self.targets["gated"]
        text = self._refused("with-release", first, release="0.0.0-scoped")
        self.assertCause(text, r"--release", "--suites with --release")

    def test_a_gate_no_cycle_resolves_for_is_refused(self):
        first, _second = self.targets["gated"]
        text = self._refused("no-cycle", first, cycle=False)
        self.assertCause(text, r"--cycle", "no --cycle and no binding")

    def test_a_board_that_does_not_state_the_capability_is_refused(self):
        """The stand-in board answers its health with no `milestones.gate`,
        so it cannot be shown to record a gate's scope and suites."""
        first, _second = self.targets["gated"]
        stand_in = RecordingBoard()
        self.addCleanup(stand_in.close)
        agent, result, axi, ran = self._drive(
            "no-capability", first, board=stand_in.url,
            key="scoped-gate-no-capability-key")
        text = self.assertTypedRefusal(result, axi)
        self.assertCause(text, r"board", "the board does not state the capability")
        self.assertEqual(ran, [], f"{self.CLIENT}: nothing ran; "
                                  f"{self._transcript(result)}")
        filed = [p for p, _body in stand_in.posts()
                 if p.startswith("/api/v2/runs") or "milestones" in p
                 or "/gates" in p]
        self.assertEqual(filed, [],
                         f"{self.CLIENT}: nothing was filed and no milestone "
                         f"posted to the board; agent={agent}")

    def test_a_board_whose_health_goes_unanswered_is_refused_naming_that(self):
        """No board listens at the declared address, so its /api/health is
        never answered: the refusal says the health could not be read, with
        the transport's error, rather than that the board lacks the
        capability."""
        first, _second = self.targets["gated"]
        _agent, result, axi, ran = self._drive(
            "no-answer", first, board=_UNREACHABLE_CRUCIBLE_URL,
            key="scoped-gate-no-answer-key")
        text = self.assertTypedRefusal(result, axi)
        self.assertEqual(ran, [], f"{self.CLIENT}: nothing ran; "
                                  f"{self._transcript(result)}")
        if self.CLIENT == "python":
            self.assertRegex(text.lower(), DECLARES_NO_SUITES,
                             f"python: error+help={text!r}")
            return
        self.assertCause(text, r"health could not be read",
                         "the board's health went unanswered")
        self.assertIn("connection failed", text,
                      f"{self.CLIENT}: the refusal carries the transport's "
                      f"error; error+help={text!r}")
        self.assertNotRegex(
            text, r"does not state",
            f"{self.CLIENT}: an unanswered board is not one that lacks the "
            f"capability; error+help={text!r}")

class BunRefusesAScopedGateItCannotRunTest(_AScopedGateRefusal):
    CLIENT = "bun"

class MavenRefusesAScopedGateItCannotRunTest(_AScopedGateRefusal):
    CLIENT = "mvn"

class RustRefusesAScopedGateItCannotRunTest(_AScopedGateRefusal):
    CLIENT = "rust"

class ArduinoRefusesAScopedGateItCannotRunTest(_AScopedGateRefusal):
    CLIENT = "arduino"

class PythonRefusesEveryScopedGateTest(_AScopedGateRefusal):
    CLIENT = "python"

# The abstract refusal is no test of its own: only its five clients run.
del _AScopedGateRefusal

if __name__ == "__main__":
    unittest.main()
