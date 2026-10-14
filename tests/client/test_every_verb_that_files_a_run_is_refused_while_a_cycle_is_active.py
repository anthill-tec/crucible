"""Every verb that files a run, or a compile or lint result, refuses an
unattributed run while the project has an active cycle — before anything is
run or filed.

The sibling suite (`test_an_unattributed_run_is_refused_while_a_cycle_is_active.py`)
proves the refusal for `test` and `pre-merge-gate`. This one proves it for the
rest of the fleet's filing verbs: `regression`, the tier verbs, `check`,
`compile`, `auto-ingest`, rust's `smoke-test`, `docker-e2e-gate`, `clippy`,
`workspace-clippy`, `workspace-regression` and `regression-ingest`, and each
`pre-merge-gate`'s own first step (the compile, typecheck or clippy step a
gate runs before its suites).

Each case drives the real client as an OS subprocess against a real,
ephemeral `bun run src/server.ts` board (never :3850/:3849) carrying one
active cycle. The agent is registered on that board bound to no cycle. Every
fake toolchain records each invocation in its bin directory, and every
compile, typecheck and lint step is made to FAIL, so a step that ran would
file a compile or lint result. Three properties are read back:

  * refused: non-zero exit, an `ok:false` envelope whose `help[]` names
    `--cycle <the active id>`, NO toolchain invocation, and NO event filed by
    the agent;
  * the control: the same failing drives on a project with NO active cycle
    DO file, so the fixture is one that would file;
  * `--cycle <id>`: every verb the refusal covers accepts the flag (a census
    over each client's own argparse), and a verb given it files its result
    under that cycle.
"""

import json as _json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _await_server,
    _call,
    _declare_listener,
    _free_port,
)
from tests.client.test_client_fleet_envelope_census import (
    _FAKE_TOOLS,
    CLIENT_FILES,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

REFUSED_CODE = "unattributed-run-refused"
TIERS = ("unit", "module", "integration", "e2e", "bdd")

# Every verb, fleet-wide, that files a run or a compile/lint result. A client
# covers the ones its own argparse registers.
FILING_VERBS = (("test", "regression") + TIERS
                + ("check", "compile", "auto-ingest", "pre-merge-gate",
                   "smoke-test", "docker-e2e-gate", "clippy", "workspace-clippy",
                   "workspace-regression", "regression-ingest"))

# The verbs whose run files a compile or lint result, or files a run, in the
# fixture below: the "would FAIL and file" proof. Tier and regression verbs are
# proved refused by the refusal itself (its code and help naming the active
# cycle), which only the pre-flight raises.
STEP_VERBS = {
    "python": ("check", "auto-ingest", "pre-merge-gate"),
    "bun": ("check", "auto-ingest", "pre-merge-gate"),
    "mvn": ("check", "compile", "auto-ingest", "pre-merge-gate"),
    "rust": ("check", "auto-ingest", "clippy", "workspace-clippy",
             "pre-merge-gate", "smoke-test", "docker-e2e-gate", "regression"),
    "arduino": ("check", "compile", "auto-ingest", "pre-merge-gate"),
}

INVOCATION_LOG = "invocations.log"

# Inserted after each fake tool's shebang: one line per invocation, in the
# tool's own bin directory, so a drive can be asked whether anything ran.
_LOG_SNIPPET = (
    "import os as _o, sys as _s\n"
    "with open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), "
    f"{INVOCATION_LOG!r}), 'a') as _f:\n"
    "    _f.write(_o.path.basename(_s.argv[0]) + ' ' + ' '.join(_s.argv[1:]) + '\\n')\n"
)

# Each compile, typecheck and lint step FAILS with its tool's own error shape;
# every other invocation keeps the stock fake's behaviour.
_FAIL_SNIPPETS = {
    "cargo": (
        "if 'clippy' in _s.argv[1:] or _s.argv[1:2] == ['check']:\n"
        "    _s.stderr.write('error[E0425]: cannot find value `undeclared` in this scope\\n'\n"
        "                    ' --> src/lib.rs:1:1\\n')\n"
        "    _s.exit(101)\n"),
    "bun": (
        "if _s.argv[1:3] == ['x', 'tsc']:\n"
        "    _s.stdout.write(\"src/probe.ts(1,1): error TS2304: Cannot find name 'undeclared'.\\n\")\n"
        "    _s.exit(2)\n"),
    "mvn": (
        "if 'test-compile' in _s.argv[1:]:\n"
        "    _s.stdout.write('[ERROR] /src/main/java/Probe.java:[1,1] cannot find symbol\\n')\n"
        "    _s.exit(1)\n"),
    "arduino-cli": (
        "if 'compile' in _s.argv[1:]:\n"
        "    _s.stdout.write(\"probe.ino:1:1: error: 'undeclared' was not declared in this scope\\n\")\n"
        "    _s.exit(1)\n"),
}

_PYTHON_WRAPPER = "python-recorded"

_JUNIT_ONE_GREEN = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="Probe" tests="1" failures="0" errors="0">'
    '<testcase classname="Probe" name="probe" time="0.001"/>'
    '</testsuite>'
)

SEEDED_REPORTS = "seeded-reports"


def _build_recording_bin_dir():
    """The stock fakes, each recording its invocations, with every compile,
    typecheck and lint step failing — plus a recorded python that runs the
    real interpreter, for the python client."""
    bin_dir = Path(tempfile.mkdtemp(prefix="every-verb-refused-bin-"))
    for name, body in _FAKE_TOOLS.items():
        shebang, rest = body.split("\n", 1)
        path = bin_dir / name
        path.write_text(shebang + "\n" + _LOG_SNIPPET
                        + _FAIL_SNIPPETS.get(name, "") + rest)
        path.chmod(0o755)
    wrapper = bin_dir / _PYTHON_WRAPPER
    wrapper.write_text(
        "#!/usr/bin/env python3\n" + _LOG_SNIPPET
        + f"_o.execv({sys.executable!r}, [{sys.executable!r}] + _s.argv[1:])\n")
    wrapper.chmod(0o755)
    return bin_dir


def _invocations(bin_dir):
    log = Path(bin_dir) / INVOCATION_LOG
    return log.read_text().splitlines() if log.exists() else []


def _seed(client_key, verb, project_dir):
    """What a drive needs beyond the census's project: a declared target for a
    tier verb, a report for an ingest-only verb, a source that does not
    compile for python's py_compile step. Returns the extra argv."""
    d = Path(project_dir)
    extra = []
    if client_key == "python":
        (d / "app").mkdir(exist_ok=True)
        (d / "app" / "broken.py").write_text("def broken(:\n")
        if verb in TIERS:
            extra += ["--start-dir", "tests"]
    if verb in TIERS:
        if client_key == "bun":
            (d / "package.json").write_text(_json.dumps(
                {"name": "probe", "scripts": {f"test:{verb}": "bun test"}}))
        elif client_key == "mvn":
            (d / "pom.xml").write_text(
                f"<project><profiles><profile><id>{verb}</id></profile>"
                f"</profiles></project>")
        elif client_key == "rust":
            (d / ".config").mkdir(exist_ok=True)
            (d / ".config" / "nextest.toml").write_text(
                f'[profile.{verb}]\n\n[profile.{verb}.junit]\npath = "junit.xml"\n')
        elif client_key == "arduino":
            (d / "tests" / "native" / "Makefile").write_text(f"junit-{verb}:\n\t@true\n")
    if verb == "auto-ingest" and client_key in ("python", "bun", "arduino"):
        reports = d / SEEDED_REPORTS
        reports.mkdir(exist_ok=True)
        name = "junit.xml" if client_key == "bun" else "TEST-Probe.xml"
        (reports / name).write_text(_JUNIT_ONE_GREEN)
        extra += ["--reports", str(reports)]
    return extra


def _filing_verbs(client_key):
    verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
    return {v: verbs[v] for v in FILING_VERBS if v in verbs}


def _accepts(subparser, flag):
    return any(flag in action.option_strings for action in subparser._actions)


class EveryRefusableVerbAcceptsCycleTest(unittest.TestCase):
    """The refusal's first lever is `re-run with --cycle <id>`, so every verb
    the refusal covers must accept `--cycle` — read off each client's own
    argparse, never a hand-kept list of flags."""

    def test_every_verb_the_refusal_covers_accepts_cycle(self):
        for client_key in sorted(CLIENT_FILES):
            for verb, subparser in sorted(_filing_verbs(client_key).items()):
                with self.subTest(client=client_key, verb=verb):
                    self.assertTrue(
                        _accepts(subparser, "--cycle"),
                        f"{client_key} {verb}: files a run or a compile/lint "
                        f"result, so the refusal can name `--cycle <id>` to "
                        f"it — and its parser does not accept --cycle")


class EveryVerbThatFilesARunIsRefusedTest(unittest.TestCase):
    """The AC "Every verb that files a run", for all five clients, against one
    live board: a project with one ACTIVE cycle, and a sibling with none."""

    ORCHESTRATOR = "every-verb-refusal-orchestrator"
    PLANTED_CR = "CR-T-EVERY-VERB-REFUSAL"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="every-verb-refusal-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "an ACTIVE cycle is a property of a REAL store: without `bun` "
                "there is no server to carry one.")
        port = _free_port()
        assert port not in (3850, 3849), f"fixture sanity: reserved port {port}"
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._boot()
        except BaseException:
            cls._stop_server()
            shutil.rmtree(cls._tmpdir, ignore_errors=True)
            raise

    @classmethod
    def _http(cls, path, payload=None, method=None):
        return _call(cls.base, path, payload, method)

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)
        cls.toon = _load_toon_module()
        project = cls._http("/api/v2/projects", {"name": "every-verb-refusal-active"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.active_key = project["project"]["key"]
        reg = cls._http("/api/v2/agents/register",
                        {"projectKey": cls.active_key, "agentId": cls.ORCHESTRATOR,
                         "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = cls._http(f"/api/v2/projects/{cls.active_key}/plans",
                          {"cr": cls.PLANTED_CR, "cycles": [{"label": "solo"}],
                           "agentId": cls.ORCHESTRATOR})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        cycle_id = filed["cycles"][0]["id"]
        activated = cls._http(
            f"/api/v2/projects/{cls.active_key}/plans/{filed['planId']}/cycles/{cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        cls.active_cycle_id = cycle_id
        no_active = cls._http("/api/v2/projects", {"name": "every-verb-refusal-no-active"})
        assert no_active.get("ok"), f"project creation failed: {no_active!r}"
        cls.no_active_key = no_active["project"]["key"]

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ── drive + read helpers ────────────────────────────────────────────────

    def _register_unbound(self, project_key, agent_id):
        reg = self._http("/api/v2/agents/register",
                         {"projectKey": project_key, "agentId": agent_id,
                          "role": "report"})
        self.assertTrue(reg.get("ok"), f"unbound registration failed: {reg!r}")
        self.assertIsNone(
            (reg.get("agent") or {}).get("boundCycleId"),
            f"fixture sanity: {agent_id} must be bound to no cycle; got {reg!r}")

    def _drive(self, client_key, verb, agent_id, project_key, extra_argv=()):
        bin_dir = _build_recording_bin_dir()
        self.addCleanup(shutil.rmtree, bin_dir, True)
        project_dir = _make_project_dir(client_key)
        self.addCleanup(shutil.rmtree, project_dir, True)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=every-verb-refusal-project\n")
        (project_dir / ".env").write_text("".join(env_lines))
        seeded = _seed(client_key, verb, project_dir)
        self._register_unbound(project_key, agent_id)
        subparser = _filing_verbs(client_key)[verb]
        # Flags ahead of the census argv's trailing positionals (bun's tier
        # passthrough); its own placeholder agent is replaced by this one.
        census = build_argv(verb, subparser, project_dir)[1:]
        census[census.index("--agent") + 1] = agent_id
        argv = [verb] + seeded + list(extra_argv) + census
        result = drive_verb(
            CLIENT_FILES[client_key], argv, project_dir, bin_dir, timeout=120,
            board=self.base,
            extra_env={"PY_CRUCIBLE_PYTHON": str(bin_dir / _PYTHON_WRAPPER)})
        emits, axi = classify_envelope(result.stdout, self.toon)
        return result, emits, axi or {}, _invocations(bin_dir), subparser

    def _filed_by(self, project_key, agent_id):
        """Every event the agent filed other than its identity's own lifecycle
        touches: the runs, compile and lint results a refusal must prevent."""
        read = self._http(f"/api/v2/events?project={project_key}")
        self.assertTrue(read.get("ok"), f"events read failed: {read!r}")
        return [e for e in (read.get("events") or [])
                if e.get("agentId") == agent_id and e.get("kind") != "lifecycle"]

    @staticmethod
    def _agent_id(prefix, client_key, verb):
        return f"{prefix}-{client_key}-{verb}"

    @staticmethod
    def _transcript(result):
        return (f"exit={result.returncode} stdout={result.stdout.strip()[:800]!r} "
                f"stderr={result.stderr.strip()[-1500:]!r}")

    # ── the refusal ─────────────────────────────────────────────────────────

    def test_every_filing_verb_is_refused_before_anything_runs_or_files(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in sorted(_filing_verbs(client_key)):
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("refused", client_key, verb)
                    result, emits, axi, ran, subparser = self._drive(
                        client_key, verb, agent_id, self.active_key)
                    self.assertNotEqual(
                        result.returncode, 0,
                        f"{client_key} {verb}: an unbound run with no --cycle "
                        f"while cycle {self.active_cycle_id} is active must "
                        f"exit non-zero; {self._transcript(result)}")
                    self.assertIn(
                        REFUSED_CODE, result.stderr,
                        f"{client_key} {verb}: the exit must be the "
                        f"{REFUSED_CODE} refusal, not some other failure; "
                        f"{self._transcript(result)}")
                    self.assertTrue(emits, f"{client_key} {verb}: no envelope; "
                                           f"{self._transcript(result)}")
                    self.assertIs(axi.get("ok"), False, f"{client_key} {verb}: {axi!r}")
                    help_text = " ".join(str(h) for h in (axi.get("help") or []))
                    self.assertIn(
                        f"--cycle {self.active_cycle_id}", help_text,
                        f"{client_key} {verb}: help[] must name --cycle "
                        f"{self.active_cycle_id}; got {axi.get('help')!r}")
                    if "--release" in help_text:
                        self.assertTrue(
                            _accepts(subparser, "--release"),
                            f"{client_key} {verb}: help[] names --release, "
                            f"which this verb does not accept; got "
                            f"{axi.get('help')!r}")
                    self.assertEqual(
                        ran, [],
                        f"{client_key} {verb}: refused before anything is run "
                        f"— yet the toolchain was invoked: {ran!r}")
                    filed = self._filed_by(self.active_key, agent_id)
                    self.assertEqual(
                        filed, [],
                        f"{client_key} {verb}: a refused run files nothing; "
                        f"got {filed!r}")

    # ── the control: the same failing steps DO file with no active cycle ──

    def test_each_failing_step_files_when_no_cycle_is_active(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in STEP_VERBS[client_key]:
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("control", client_key, verb)
                    result, _emits, _axi, ran, _sub = self._drive(
                        client_key, verb, agent_id, self.no_active_key)
                    self.assertNotIn(REFUSED_CODE, result.stderr,
                                     self._transcript(result))
                    if verb != "auto-ingest":  # ingests reports it finds
                        self.assertTrue(
                            ran, f"{client_key} {verb}: with no active cycle "
                                 f"the toolchain must run; "
                                 f"{self._transcript(result)}")
                    self.assertTrue(
                        self._filed_by(self.no_active_key, agent_id),
                        f"{client_key} {verb}: with no active cycle this drive "
                        f"must FILE a result — otherwise the refusal case "
                        f"proves nothing; {self._transcript(result)}")

    # ── --cycle files the result under that cycle ───────────────────────────

    def test_cycle_flag_files_the_result_under_that_cycle(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in STEP_VERBS[client_key]:
                if verb == "pre-merge-gate":
                    continue  # proven by the sibling suite's --cycle guard
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("bound", client_key, verb)
                    result, _emits, _axi, _ran, _sub = self._drive(
                        client_key, verb, agent_id, self.active_key,
                        extra_argv=["--cycle", str(self.active_cycle_id)])
                    self.assertNotIn(REFUSED_CODE, result.stderr,
                                     self._transcript(result))
                    filed = self._filed_by(self.active_key, agent_id)
                    self.assertTrue(
                        filed, f"{client_key} {verb}: --cycle must still file; "
                               f"{self._transcript(result)}")
                    for event in filed:
                        self.assertEqual(
                            (event.get("context") or {}).get("cycleId"),
                            self.active_cycle_id,
                            f"{client_key} {verb}: filed with --cycle "
                            f"{self.active_cycle_id}, so stored under it; "
                            f"got {event!r}")


if __name__ == "__main__":
    unittest.main()
