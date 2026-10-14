"""RED — the gate-measures-the-code change's §S2, the SECOND of its two
cycles ("the gate milestone and the close"): the first paragraph read for this
cycle is "Each `pre-merge-gate`
ends by posting one milestone…" through "A red gate stops the close" — the
four acceptance criteria "The gate records its outcome", "A red gate refuses
the close", "An accepted failure is recorded" and "A green gate closes as
today". The sibling run-attribution paragraph ("An unattributed run is
refused") is the OTHER §S2 cycle (already landed —
`tests/client/test_an_unattributed_run_is_refused_while_a_cycle_is_active.py`)
and is out of this file's scope.

Driven against a REAL, ephemeral `bun run src/server.ts` board (never
:3850/:3849), exactly the idiom
`test_an_unattributed_run_is_refused_while_a_cycle_is_active.py` already
established for this change. Each of the five clients' `pre-merge-gate`/`cr-close`
is driven as a genuine OS subprocess, argv built from each client's OWN real
argparse (`test_client_fleet_envelope_census.py`'s
`enumerate_verbs`/`build_argv`), toolchains stubbed by small fake executables
(cargo/mvn/bun) or by writing the native JUnit the fixture itself produces
(arduino) or by real Python test files (python — `py_compile` + `xmlrunner`
need no stub at all).

RED phase — TODAY, none of this exists:
  * `pre-merge-gate` never posts a `pre-merge-gate` milestone at all (grepped:
    no client calls `post_milestone(..., "pre-merge-gate", ...)` anywhere), so
    every milestone-presence assertion below starts from an EMPTY list.
  * the milestone type `pre-merge-gate` is neither SEEDED nor RESERVED
    (`src/store.ts` — `SEEDED_MILESTONE_TYPES`/`RESERVED_MILESTONE_TYPES`), so
    even a manual POST of one is refused 400 today.
  * `cr-close` (`cmd_cr_close`, `clients/_crucible_axi.py`) never reads a gate
    result at all — it closes an OPEN plan unconditionally — so every
    refusal case below instead SUCCEEDS today (closes the plan), and
    `--accept-failing-gate` is not a recognised flag on any of the five
    clients' argparse at all (an unrecognised-argument exit, not an AXI
    envelope).

ESCALATION — the change's own spec prose names WHAT a `pre-merge-gate`
milestone carries ("the CR, the outcome, the counts, the failing tests, the
head commit") but never the wire shape: no spec document pins field names for
a fact that does not exist in the schema yet (`recordMilestoneEvent`'s `meta`
is a closed set:
label/commit/context/releasedAt/crs/packages/targetAt/deliveredAt/
repairProvenance — none of "outcome"/"passed"/"failed"/"failingTests"). This
file commits to ONE concrete, defensible contract so the acceptance criteria
are assertable rather than vacuous, and states it here for the GREEN agent
(and the orchestrator, who should confirm or correct it before GREEN lands):

  pre-merge-gate milestone (POST /api/v2/milestones, type="pre-merge-gate"):
    label          = the CR the gated cycle's plan belongs to (the existing
                     field — the same one `cr-merged` already uses for a CR
                     id, same precedent)
    commit         = the repo's HEAD commit sha at gate time (the existing
                     `commit` field — same precedent)
    context.cycleId = the `--cycle <id>` the gate ran under (the existing
                     context-attach seam every ingest already uses)
    outcome        = the literal string "pass" or "fail" (NEW)
    passed, failed = the suite's counts, matching `RunSummary`'s own
                     `passed`/`failed` naming (`src/types.ts`) (NEW)
    failingTests   = array of failing test identifiers, PRESENT only when
                     `failed > 0` (never an empty array on a pass) (NEW)

  `cr-close`'s refusal/acceptance is asserted on OBSERVABLE STATE (the plan's
  `status`/`merge` read back over HTTP, exit code, `ok`) and on substrings of
  its own printed output (stdout TOON envelope + stderr legacy line combined)
  for the "naming the run, its failed count and the failing tests" / "a help
  entry naming pre-merge-gate" requirements — deliberately NOT pinned to an
  exact new JSON field there, since the CLI's "naming" is itself prose, not a
  wire contract.

  `cr-close --accept-failing-gate "<reason>"`: the plan's `merge` object
  carries the reason under `acceptedFailingGateReason` (extending the
  existing `merge: {commit}` shape — NEW key), the `cr-merged` milestone
  carries it under the same key name (NEW), and `GET …/history`'s JSON (for
  the release/workflow this CR belongs to) contains the reason STRING
  somewhere in its structure — asserted by a whole-document substring search
  rather than a pinned path, because exactly which `HistoryWorkflow`/
  `HistoryRelease` field surfaces it is undecided.

No CR-shaped literal is used anywhere (fixture CRs are lowercase,
`gate-fixture-<client>-<case>`, which cannot match `CR-[A-Z]+-[0-9]+`).

Invocation:
    python3 -m unittest tests.client.test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close -v
"""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

CLIENT_KEYS = ("bun", "python", "rust", "mvn", "arduino")

# The one failing test identifier every client's FAIL fixture carries, so a
# milestone's `failingTests` can be checked for a REAL, specific value rather
# than "the list is non-empty".
FAILING_TEST_MARKER = "gate_fixture_known_failure"
PASSING_TEST_NAME = "alpha_behaviour_passes"

_JUNIT_PASS_ONE = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="gate-fixture" tests="1" failures="0" errors="0">'
    f'<testcase classname="gate_fixture" name="{PASSING_TEST_NAME}" time="0.001"/>'
    '</testsuite></testsuites>'
)

_JUNIT_FAIL_ONE_OF_TWO = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="gate-fixture" tests="2" failures="1" errors="0">'
    f'<testcase classname="gate_fixture" name="{PASSING_TEST_NAME}" time="0.001"/>'
    f'<testcase classname="gate_fixture" name="{FAILING_TEST_MARKER}" time="0.001">'
    '<failure message="assertion violated: expected 2 got 3">AssertionError</failure>'
    '</testcase></testsuite></testsuites>'
)

_SUREFIRE_PASS_ONE = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="GateFixtureTest" tests="1" failures="0" errors="0">'
    f'<testcase classname="GateFixtureTest" name="{PASSING_TEST_NAME}" time="0.001"/>'
    '</testsuite>'
)

_SUREFIRE_FAIL_ONE_OF_TWO = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="GateFixtureTest" tests="2" failures="1" errors="0">'
    f'<testcase classname="GateFixtureTest" name="{PASSING_TEST_NAME}" time="0.001"/>'
    f'<testcase classname="GateFixtureTest" name="{FAILING_TEST_MARKER}" time="0.001">'
    '<failure message="assertion violated: expected 2 got 3">AssertionError</failure>'
    '</testcase></testsuite>'
)

_LCOV_ONE = "SF:detector.src\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"

# ── fake `bun`/`cargo`/`mvn` — a FAILING variant beside the census module's
# PASSING ones, toggled by OVERWRITING the one relevant file in a copy of its
# `_build_fake_bin_dir()` output (every other fake tool in that dir stays the
# PASSING stock one — only the suite-producing step must fail). ──────────────

_FAIL_BUN_BODY = f'''#!/usr/bin/env python3
import os
import sys

argv = sys.argv[1:]
JUNIT = {_JUNIT_FAIL_ONE_OF_TWO!r}
LCOV = {_LCOV_ONE!r}

if argv and argv[0] == "test":
    outfile = None
    coverage_dir = None
    for tok in argv:
        if tok.startswith("--reporter-outfile="):
            outfile = tok.split("=", 1)[1]
        elif tok.startswith("--coverage-dir="):
            coverage_dir = tok.split("=", 1)[1]
    if outfile:
        parent = os.path.dirname(outfile)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(outfile, "w") as f:
            f.write(JUNIT)
    if coverage_dir:
        os.makedirs(coverage_dir, exist_ok=True)
        with open(os.path.join(coverage_dir, "lcov.info"), "w") as f:
            f.write(LCOV)
sys.exit(0)
'''

_FAIL_CARGO_BODY = f'''#!/usr/bin/env python3
import os
import sys

argv = sys.argv[1:]
JUNIT = {_JUNIT_FAIL_ONE_OF_TWO!r}
LCOV = {_LCOV_ONE!r}

if "nextest" in argv:
    profile = "ci"
    if "-P" in argv:
        profile = argv[argv.index("-P") + 1]
    junit_dir = os.path.join("target", "nextest", profile)
    os.makedirs(junit_dir, exist_ok=True)
    with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
        f.write(JUNIT)
    if "--lcov" in argv:
        out_path = "target/lcov.info"
        if "--output-path" in argv:
            out_path = argv[argv.index("--output-path") + 1]
        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out_path, "w") as f:
            f.write(LCOV)
sys.exit(0)
'''

_FAIL_MVN_BODY = f'''#!/usr/bin/env python3
import os
import sys

JUNIT = {_SUREFIRE_FAIL_ONE_OF_TWO!r}
for kind in ("surefire", "failsafe"):
    prefix = "-D" + kind + ".reportsDirectory="
    d = next((a[len(prefix):] for a in sys.argv[1:] if a.startswith(prefix)),
             os.path.join("target", kind + "-reports"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "TEST-GateFixtureTest.xml"), "w") as f:
        f.write(JUNIT)
sys.exit(0)
'''

_PY_TEST_PASS = (
    "import unittest\n\n\n"
    "class GateFixtureTest(unittest.TestCase):\n"
    f"    def test_{PASSING_TEST_NAME}(self):\n"
    "        self.assertEqual(1, 1)\n"
)

_PY_TEST_FAIL = (
    "import unittest\n\n\n"
    "class GateFixtureTest(unittest.TestCase):\n"
    f"    def test_{PASSING_TEST_NAME}(self):\n"
    "        self.assertEqual(1, 1)\n\n"
    f"    def test_{FAILING_TEST_MARKER}(self):\n"
    "        self.assertEqual(2, 3)\n"
)


# arduino's fake `make`: exits 0 and writes NO report. The census module's
# stock fake `make` writes its own passing `TEST-DetectorProbe.xml` on every
# `make junit`, which the arduino client sums beside the fixture's own report,
# so it is replaced in BOTH arduino bin dirs: the only report the gate reads is
# the one `_write_native_fixture` wrote.
_SILENT_MAKE_BODY = "#!/usr/bin/env python3\nimport sys\n\nsys.exit(0)\n"


def _overwrite_fake_tool(bin_dir, name, body):
    path = Path(bin_dir) / name
    path.write_text(body)
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _fail_bin_dir_for(client_key):
    """A copy of the census module's standard PASSING fake-tool dir, with the
    ONE tool that produces this client's suite result overwritten to report a
    failure. `arduino`'s native suite result comes from a JUnit file THIS test
    writes directly into the project fixture (`_write_native_fixture`), never
    from `make`/`arduino-cli`, so its `make` is silenced instead
    (`_SILENT_MAKE_BODY`)."""
    bin_dir = _build_fake_bin_dir()
    if client_key == "arduino":
        _overwrite_fake_tool(bin_dir, "make", _SILENT_MAKE_BODY)
    if client_key == "bun":
        _overwrite_fake_tool(bin_dir, "bun", _FAIL_BUN_BODY)
    elif client_key == "rust":
        _overwrite_fake_tool(bin_dir, "cargo", _FAIL_CARGO_BODY)
    elif client_key == "mvn":
        _overwrite_fake_tool(bin_dir, "mvn", _FAIL_MVN_BODY)
    return bin_dir


def _git_commit_fixture(project_dir):
    """`git init` + one commit over the whole fixture tree, so the project
    directory has a real, independently-verifiable HEAD commit for the
    milestone's `commit` field to be checked against — a fresh `tempfile`
    tree is NOT a git repo by default, and the CR's own "head commit" wording
    demands one that is."""
    def run(*args):
        return subprocess.run(
            ["git", *args], cwd=str(project_dir), capture_output=True, text=True,
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}, check=True)

    run("init", "-q", "-b", "main")
    run("config", "user.email", "gate-fixture@example.invalid")
    run("config", "user.name", "Gate Fixture")
    run("add", "-A")
    run("commit", "-q", "--no-gpg-sign", "-m", "gate fixture baseline")
    return run("rev-parse", "HEAD").stdout.strip()


def _write_native_fixture(project_dir, outcome):
    """arduino's own suite-result seam: a pre-written `tests/native/reports/
    TEST-*.xml` (+ a minimal lcov), exactly the idiom
    `clients-python-arduino-crucible.test.ts`'s pre-merge-gate fixtures use —
    the fake `make`/`arduino-cli` on PATH never produce the result
    themselves, they only need to exit 0."""
    reports_dir = Path(project_dir) / "tests" / "native" / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    body = _JUNIT_PASS_ONE if outcome == "pass" else _JUNIT_FAIL_ONE_OF_TWO
    (reports_dir / "TEST-GateFixtureNative.xml").write_text(body)
    coverage_dir = Path(project_dir) / "tests" / "native" / "coverage"
    coverage_dir.mkdir(parents=True, exist_ok=True)
    (coverage_dir / "lcov.info").write_text(_LCOV_ONE)


def _free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _call(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):  # noqa: S310
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")


class TheGateRecordsItsOutcomeAndARedGateStopsTheCloseTest(unittest.TestCase):
    """One shared live board; one project PER CLIENT, each carrying four
    independent plans (`pass`, `fail`, `none`, `accept`) so no test method
    mutates state another test method reads — every assertion below is
    reachable regardless of which subset of this file's tests is run."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="gate-milestone-e2e-")
        cls._proc = None
        cls._scratch_dirs = []
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "a real pre-merge-gate / cr-close round trip needs a real "
                "server to post and read milestones against: without `bun` "
                "there is no board to boot. A missing toolchain, not a "
                "passing assertion.")
        port = _free_port()
        assert port not in (3850, 3849), (
            f"fixture sanity: the OS handed back a reserved port {port}")
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            _await_server(cls.base, cls._proc)
            cls.toon = _load_toon_module()
            cls.fixtures = {}
            for client_key in CLIENT_KEYS:
                cls.fixtures[client_key] = cls._build_client_fixture(client_key)
        except BaseException:
            cls._cleanup_scratch()
            cls._stop_server()
            raise

    @classmethod
    def _cleanup_scratch(cls):
        for d in cls._scratch_dirs:
            shutil.rmtree(d, ignore_errors=True)
        cls._scratch_dirs = []

    @classmethod
    def tearDownClass(cls):
        cls._cleanup_scratch()
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

    @classmethod
    def _http(cls, path, payload=None, method=None):
        return _call(cls.base, path, payload, method)

    # ── per-client fixture construction ─────────────────────────────────────

    @classmethod
    def _project_dir(cls, client_key, project_key, label):
        d = _make_project_dir(client_key)
        cls._scratch_dirs.append(d)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append(f"CRUCIBLE_PROJECT_NAME=gate-fixture-{label}\n")
        (d / ".env").write_text("".join(env_lines))
        if client_key == "python":
            (d / "tests" / "test_probe.py").unlink(missing_ok=True)
        return d

    @classmethod
    def _plan(cls, project_key, orchestrator, cr_label):
        """File a one-cycle plan and transition that cycle straight to `done`
        — `cr-close` refuses ANY plan carrying a non-terminal cycle (an
        already-established, unrelated guard), unconditionally of gate state,
        so every fixture plan here must already be past that guard before
        this file's OWN gate-close assertions can be exercised cleanly."""
        filed = cls._http(f"/api/v2/projects/{project_key}/plans",
                          {"cr": cr_label, "cycles": [{"label": "solo"}],
                           "agentId": orchestrator})
        assert filed.get("ok"), f"plan-file failed for {cr_label!r}: {filed!r}"
        plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
        cycle_path = f"/api/v2/projects/{project_key}/plans/{plan_id}/cycles/{cycle_id}"
        active = cls._http(cycle_path, {"status": "active", "agentId": orchestrator},
                           method="PATCH")
        assert active.get("ok"), f"cycle-activate failed for {cr_label!r}: {active!r}"
        done = cls._http(cycle_path, {"status": "done", "agentId": orchestrator},
                         method="PATCH")
        assert done.get("ok"), f"cycle-done failed for {cr_label!r}: {done!r}"
        return plan_id, cycle_id

    @classmethod
    def _drive_pre_merge_gate(cls, client_key, project_dir, agent_id, cycle_id,
                              bin_dir, extra_argv=()):
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        argv = build_argv("pre-merge-gate", verbs["pre-merge-gate"], project_dir)
        argv = argv + ["--agent", agent_id, "--cycle", str(cycle_id)] + list(extra_argv)
        result = drive_verb(script_path, argv, project_dir, bin_dir, timeout=120,
                            board=cls.base)
        emits, axi = classify_envelope(result.stdout, cls.toon)
        return result, emits, axi or {}

    @classmethod
    def _build_client_fixture(cls, client_key):
        """One project for this client, carrying four plans (`pass`/`fail`/
        `none`/`accept`) and the driven `pre-merge-gate` result for each of
        the three that ran one (`none` never runs a gate at all — AC "A CR
        with no recorded pre-merge-gate result")."""
        project = cls._http("/api/v2/projects", {"name": f"gate-milestone-{client_key}"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        key = project["project"]["key"]
        orchestrator = f"gate-fixture-{client_key}-orchestrator"
        reg = cls._http("/api/v2/agents/register",
                        {"projectKey": key, "agentId": orchestrator, "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"

        pass_bin = _build_fake_bin_dir()
        if client_key == "arduino":
            _overwrite_fake_tool(pass_bin, "make", _SILENT_MAKE_BODY)
        cls._scratch_dirs.append(pass_bin)
        fail_bin = _fail_bin_dir_for(client_key)
        cls._scratch_dirs.append(fail_bin)
        extra = ["--skip-clippy", "--min-free-g", "1"] if client_key == "rust" else []

        fixture = {"key": key, "orchestrator": orchestrator, "cases": {}}
        for case, outcome in (("pass", "pass"), ("fail", "fail"), ("accept", "fail")):
            cr_label = f"gate-fixture-{client_key}-{case}"
            plan_id, cycle_id = cls._plan(key, orchestrator, cr_label)
            project_dir = cls._project_dir(client_key, key, f"{client_key}-{case}")
            if client_key == "python":
                (project_dir / "tests" / "test_gate_fixture.py").write_text(
                    _PY_TEST_PASS if outcome == "pass" else _PY_TEST_FAIL)
            if client_key == "arduino":
                _write_native_fixture(project_dir, outcome)
            head_sha = _git_commit_fixture(project_dir)
            bin_dir = pass_bin if outcome == "pass" else fail_bin
            agent_id = f"gate-fixture-{client_key}-{case}-agent"
            result, emits, axi = cls._drive_pre_merge_gate(
                client_key, project_dir, agent_id, cycle_id, bin_dir, extra)
            fixture["cases"][case] = {
                "cr": cr_label, "plan_id": plan_id, "cycle_id": cycle_id,
                "project_dir": project_dir, "head_sha": head_sha,
                "outcome": outcome, "result": result, "emits": emits, "axi": axi,
            }
        # The fourth plan: filed, but NO pre-merge-gate ever ran against it.
        none_cr = f"gate-fixture-{client_key}-none"
        none_plan_id, none_cycle_id = cls._plan(key, orchestrator, none_cr)
        fixture["cases"]["none"] = {
            "cr": none_cr, "plan_id": none_plan_id, "cycle_id": none_cycle_id,
        }
        return fixture

    # ── read helpers ─────────────────────────────────────────────────────────

    def _milestones(self, project_key, mtype):
        read = self._http(f"/api/v2/projects/{project_key}/milestones?type={mtype}")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        return read.get("milestones") or []

    def _milestones_for_cr(self, project_key, mtype, cr_label):
        return [m for m in self._milestones(project_key, mtype) if m.get("label") == cr_label]

    def _plan_record(self, project_key, plan_id):
        read = self._http(f"/api/v2/projects/{project_key}/plans")
        self.assertTrue(read.get("ok"), f"plans read failed: {read!r}")
        for plan in read.get("plans", []):
            if plan.get("planId") == plan_id:
                return plan
        raise AssertionError(f"plan {plan_id} not found in {read!r}")

    def _drive_cr_close(self, client_key, project_key, project_dir, agent_id, cr_label,
                        commit="deadbeef0001", extra_argv=()):
        # The plan PATCH `cr-close` issues requires a LIVE registered caller
        # (refused 409 otherwise, before cr-close's own plan-resolution logic
        # ever runs) -- unlike `pre-merge-gate`'s own gated bracket, `cr-close`
        # opens no identity of its own.
        reg = self._http("/api/v2/agents/register",
                         {"projectKey": project_key, "agentId": agent_id,
                          "role": "ORCHESTRATOR"})
        self.assertTrue(reg.get("ok"), f"close-agent registration failed: {reg!r}")
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        argv = build_argv("cr-close", verbs["cr-close"], project_dir)
        argv = argv + ["--agent", agent_id, "--commit", commit, "--cr", cr_label] + list(extra_argv)
        result = drive_verb(script_path, argv, project_dir, _build_fake_bin_dir(),
                            timeout=60, board=self.base)
        emits, axi = classify_envelope(result.stdout, self.toon)
        combined_text = (result.stdout or "") + "\n" + (result.stderr or "")
        return result, emits, (axi or {}), combined_text

    # ── AC "The gate records its outcome" — a PASSING run ───────────────────

    def test_pre_merge_gate_posts_exactly_one_milestone_on_a_passing_run_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["pass"]
                key = self.fixtures[client_key]["key"]
                self.assertEqual(
                    case["result"].returncode, 0,
                    f"{client_key}: a PASSING fake suite must leave pre-merge-gate "
                    f"itself exiting 0; stdout={case['result'].stdout.strip()[:800]!r} "
                    f"stderr={case['result'].stderr.strip()[-2000:]!r}")
                records = self._milestones_for_cr(key, "pre-merge-gate", case["cr"])
                self.assertEqual(
                    len(records), 1,
                    f"{client_key}: a passing pre-merge-gate --cycle "
                    f"{case['cycle_id']} must post EXACTLY ONE pre-merge-gate "
                    f"milestone for {case['cr']!r}; got {len(records)}: {records!r}")
                record = records[0]
                self.assertEqual(
                    (record.get("context") or {}).get("cycleId"), case["cycle_id"],
                    f"{client_key}: the milestone must be filed under the cycle the "
                    f"gate ran under ({case['cycle_id']}); got {record!r}")
                self.assertEqual(
                    record.get("label"), case["cr"],
                    f"{client_key}: the milestone must carry the CR the gated "
                    f"cycle's plan belongs to ({case['cr']!r}); got {record!r}")
                self.assertEqual(
                    record.get("commit"), case["head_sha"],
                    f"{client_key}: the milestone must carry the repo's HEAD "
                    f"commit at gate time ({case['head_sha']!r}); got {record!r}")
                self.assertEqual(
                    record.get("outcome"), "pass",
                    f"{client_key}: a passing gate's milestone outcome must be "
                    f"'pass'; got {record!r}")
                self.assertEqual(
                    record.get("passed"), 1,
                    f"{client_key}: the passing fixture ran exactly one passing "
                    f"test; got passed={record.get('passed')!r} in {record!r}")
                self.assertEqual(
                    record.get("failed"), 0,
                    f"{client_key}: a passing gate's milestone must carry "
                    f"failed=0; got {record!r}")
                self.assertNotIn(
                    "failingTests", record,
                    f"{client_key}: a passing gate's milestone must carry NO "
                    f"failingTests key at all (nothing failed); got {record!r}")

    # ── AC "The gate records its outcome" — a FAILING run ───────────────────

    def test_pre_merge_gate_posts_exactly_one_milestone_on_a_failing_run_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["fail"]
                key = self.fixtures[client_key]["key"]
                records = self._milestones_for_cr(key, "pre-merge-gate", case["cr"])
                self.assertEqual(
                    len(records), 1,
                    f"{client_key}: a failing pre-merge-gate --cycle "
                    f"{case['cycle_id']} must STILL post EXACTLY ONE "
                    f"pre-merge-gate milestone for {case['cr']!r} ('it posts it "
                    f"on a failing gate too'); got {len(records)}: {records!r}")
                record = records[0]
                self.assertEqual(
                    (record.get("context") or {}).get("cycleId"), case["cycle_id"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("label"), case["cr"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("commit"), case["head_sha"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("outcome"), "fail",
                    f"{client_key}: a failing gate's milestone outcome must be "
                    f"'fail'; got {record!r}")
                self.assertEqual(
                    record.get("passed"), 1,
                    f"{client_key}: the failing fixture ran one passing test "
                    f"beside the failing one; got {record!r}")
                self.assertEqual(
                    record.get("failed"), 1,
                    f"{client_key}: the failing fixture ran exactly one failing "
                    f"test; got {record!r}")
                failing_tests = record.get("failingTests")
                self.assertIsInstance(
                    failing_tests, list,
                    f"{client_key}: a failing gate's milestone must carry a "
                    f"failingTests LIST; got {record!r}")
                self.assertTrue(
                    any(FAILING_TEST_MARKER in str(t) for t in failing_tests),
                    f"{client_key}: failingTests must name the REAL failing "
                    f"test ({FAILING_TEST_MARKER!r}), not a placeholder; got "
                    f"failingTests={failing_tests!r}")

    # ── AC "A red gate refuses the close" — last gate FAILED ────────────────

    def test_cr_close_refuses_when_the_last_gate_failed_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["fail"]
                key = self.fixtures[client_key]["key"]
                result, emits, axi, text = self._drive_cr_close(
                    client_key, key, case["project_dir"],
                    f"gate-fixture-{client_key}-fail-close-agent", case["cr"])
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR whose last pre-merge-gate "
                    f"FAILED must exit non-zero; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "open",
                    f"{client_key}: a refused cr-close must close NOTHING — "
                    f"the plan must still be 'open'; got plan={plan!r}")
                self.assertIn(
                    "1", text,
                    f"{client_key}: the refusal must name the failed count "
                    f"(1); got combined output={text[:2000]!r}")
                self.assertIn(
                    FAILING_TEST_MARKER, text,
                    f"{client_key}: the refusal must name the failing test; "
                    f"got combined output={text[:2000]!r}")

    # ── AC "A red gate refuses the close" — NO gate result at all ───────────

    def test_cr_close_refuses_when_no_gate_result_exists_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                none_case = self.fixtures[client_key]["cases"]["none"]
                pass_case = self.fixtures[client_key]["cases"]["pass"]
                key = self.fixtures[client_key]["key"]
                records = self._milestones_for_cr(key, "pre-merge-gate", none_case["cr"])
                self.assertEqual(
                    records, [],
                    f"{client_key}: fixture sanity — {none_case['cr']!r} must "
                    f"carry NO pre-merge-gate milestone at all; got {records!r}")
                # Reuse the PASSING case's own project directory as the driving
                # client's cwd — this plan's close is about `none_case`'s CR,
                # resolved by `--cr`, and needs no toolchain of its own.
                result, emits, axi, text = self._drive_cr_close(
                    client_key, key, pass_case["project_dir"],
                    f"gate-fixture-{client_key}-none-close-agent", none_case["cr"])
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR with NO recorded "
                    f"pre-merge-gate result must exit non-zero; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(key, none_case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "open",
                    f"{client_key}: closes nothing; got plan={plan!r}")
                self.assertTrue(
                    emits, f"{client_key}: the refusal must still decode as "
                    f"one TOON axi: envelope; got stdout={result.stdout!r}")
                help_text = " ".join(str(h) for h in (axi.get("help") or []))
                self.assertIn(
                    "pre-merge-gate", help_text,
                    f"{client_key}: the refusal's help[] must name "
                    f"pre-merge-gate; got help={axi.get('help')!r}")

    # ── AC "A green gate closes as today" (GUARD — expected to pass today) ──

    def test_cr_close_closes_normally_when_the_last_gate_passed_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["pass"]
                key = self.fixtures[client_key]["key"]
                commit = "c105ed00d001"
                result, emits, axi, text = self._drive_cr_close(
                    client_key, key, case["project_dir"],
                    f"gate-fixture-{client_key}-pass-close-agent", case["cr"],
                    commit=commit)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR whose last pre-merge-gate "
                    f"PASSED must close exactly as it does today; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "closed",
                    f"{client_key}: got plan={plan!r}")
                self.assertEqual(
                    (plan.get("merge") or {}).get("commit"), commit,
                    f"{client_key}: got plan={plan!r}")
                merged = self._milestones_for_cr(key, "cr-merged", case["cr"])
                self.assertEqual(
                    len(merged), 1,
                    f"{client_key}: a successful close still posts exactly one "
                    f"cr-merged milestone; got {merged!r}")

    # ── AC "An accepted failure is recorded" ────────────────────────────────

    def test_cr_close_accept_failing_gate_records_the_reason_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["accept"]
                key = self.fixtures[client_key]["key"]
                reason = f"accepted-known-flake-{client_key}-gate-fixture"
                commit = "accceeed0002"
                result, emits, axi, text = self._drive_cr_close(
                    client_key, key, case["project_dir"],
                    f"gate-fixture-{client_key}-accept-close-agent", case["cr"],
                    commit=commit, extra_argv=["--accept-failing-gate", reason])
                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close --accept-failing-gate on a CR "
                    f"whose last gate FAILED must still close it; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "closed",
                    f"{client_key}: got plan={plan!r}")
                self.assertEqual(
                    (plan.get("merge") or {}).get("acceptedFailingGateReason"), reason,
                    f"{client_key}: the plan's merge record must carry the "
                    f"EXACT reason the caller gave; got plan={plan!r}")
                merged = self._milestones_for_cr(key, "cr-merged", case["cr"])
                self.assertEqual(
                    len(merged), 1,
                    f"{client_key}: got {merged!r}")
                self.assertEqual(
                    merged[0].get("acceptedFailingGateReason"), reason,
                    f"{client_key}: the cr-merged milestone must carry the "
                    f"same reason; got {merged[0]!r}")
                history = self._http(f"/api/v2/projects/{key}/history")
                self.assertTrue(
                    history.get("ok"), f"{client_key}: history read failed: {history!r}")
                self.assertIn(
                    reason, json.dumps(history),
                    f"{client_key}: the project's History must carry the "
                    f"accepted-failing-gate reason {reason!r} SOMEWHERE in its "
                    f"structure; got history={history!r}")


if __name__ == "__main__":
    unittest.main()
