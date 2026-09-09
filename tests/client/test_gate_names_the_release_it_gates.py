"""§S1 — A GATE STATES WHICH RELEASE IT GATES.

`gate-run` and `gate-report` accept `--release <label>` and post it as the
event's `version`: the server's existing first-class field, a SIBLING of
`gate` and never a key inside it. The flag is OPTIONAL — a gate on a feature
branch gates no release — so omitting it must leave today's payload shape
byte-identical, and supplying it must send the label VERBATIM: the client
never invents, normalises or derives a release label from a branch name.

WHY THE ABSENT CASE IS ASSERTED BY KEY ABSENCE, not by an empty value: the
server takes `version` only when it is a non-empty string, and the store
exempts a gate carrying one from pruning until its release ships. A client
that started sending `version: null` would post a key the server drops and
the reader cannot act on; one that sent an empty string would make every gate
look release-bound. Both are silent, and neither is caught by a test that
only checks the value is falsy.

RED here (the wire and the surface do not exist yet), PASS-SIDE below it (the
shape that must survive the addition). The pass-side half is not decoration:
the field being added rides in the same payload as `context`, built by the
same composer that assembles `gate`, so the tests pinning the untouched parts
are what make "additive" a measured claim rather than an intention.

The end-to-end test reaches the release-retirement mechanism THROUGH a client
for the first time: a gate whose `--release` names an already-recorded
release is retired at insert, and one whose label no release has is not.
That pair is driven against a real server on a free port with a temp DB —
never the live board — because insert-time retirement is a property of the
store's own transaction and no mock can hold it.

Invocation:
    python3 -m unittest tests.client.test_gate_names_the_release_it_gates
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# The criterion asserts the flag PER CLIENT *and* asserts the count of clients
# it drove. A loop over a collection is satisfied by a collection of one, and
# a fleet-wide claim proven on one client is the exact defect this constant
# exists to prevent.
EXPECTED_CLIENT_COUNT = 5

# The two verbs that gain the flag, each paired with a flag it ALREADY
# declares in all five clients. The existing flag is the non-vacuity anchor:
# a `--help` drive that failed to run at all would report the NEW flag missing
# for a harness reason, and would look identical to the defect under test.
GATE_VERBS = {"gate-run": "--intent", "gate-report": "--outcome"}

RELEASE_FLAG = "--release"
GATES_PATH = "/api/v2/gates"

# The label of the release a gate gates, and one no client can recognise — a
# pre-release with a suffix a normaliser would rewrite and a prefix-stripper
# would leave alone. It must arrive on the wire byte-for-byte.
RELEASE_LABEL = "0.2.0"
UNRECOGNISED_LABEL = "9.9.9-rc.1"

# The env keys the fleet's `context` block reads. Cleared everywhere below so
# an ambient orchestrator session can never colour a payload asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# Nothing listens on port 1 without root — the fleet's own help-drive idiom.
# `--help` never reaches the wire, but a drive that somehow did must refuse
# instantly rather than touch a live board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"


def _load_client(name, module_name):
    """Load a hyphenated client script by path — the fleet harness idiom."""
    path = CLIENT_FILES[name]
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()` with `sys.argv`
    patched. Returns (exit code, stdout, stderr). Only SystemExit is caught,
    so an argparse refusal arrives as a normal non-zero exit while any OTHER
    exception still surfaces as an ERROR rather than being swallowed."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client.py"] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


# ═══════════════════════════════════════════════════════════════════════════
# The scratch board — a real server on a free port, for the end-to-end alone
# ═══════════════════════════════════════════════════════════════════════════
#
# The sibling resolver suite's idiom, taken rather than re-invented: a server
# built from this repo's own source, a free port and a `mkdtemp` DB — never
# the live instance and never the shared project.


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _http(base, path, payload=None, method=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which IS the assertion subject for a refusal."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=30.0):
    """Block until the scratch server answers its orientation route, or fail
    naming the boot that never happened — never silently proceed against a
    port nothing is listening on."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise AssertionError(
                f"the scratch server exited before it was ready "
                f"(exit {proc.returncode})")
        try:
            _http(base, "/api/v2")
            return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"the scratch server never became ready at {base}")


def _register(base, key, agent_id, role, cycle_id=None):
    """Register one agent on the scratch board. A gate POST requires a LIVE
    registered caller, and a TDD role requires a cycle binding — which is also
    what puts the posted gate on the cycle-anchored feed the retirement test
    reads it back from."""
    body = {"projectKey": key, "agentId": agent_id, "status": "online",
            "role": role,
            "identity": {"displayName": agent_id, "source": "manual"}}
    if cycle_id is not None:
        body["cycleId"] = cycle_id
    answer = _http(base, "/api/v2/agents/register", body)
    assert answer.get("ok"), f"register failed for {agent_id}: {answer!r}"
    return answer


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — the flag surface, in every client that ships the verbs
# ═══════════════════════════════════════════════════════════════════════════

_PROJECT_DIR = None
_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="gate-release-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=gate-release-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=gate-release-surface-project\n")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_gate_help(client, verb):
    """A genuine subprocess dispatch of a real client script's own
    `<verb> --help`, cached per (client, verb) for this process."""
    if (client, verb) not in _HELP_CACHE:
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
        env["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL
        _HELP_CACHE[(client, verb)] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), verb, "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[(client, verb)]


class FleetGateReleaseFlagSurfaceTest(unittest.TestCase):
    """§S1 — both gate verbs LIST `--release`, in all five clients, proven by
    driving each client's own printed help as a real subprocess.

    Each client hand-rolls its own gate subparser block, so "the fleet has the
    flag" is five separate facts and any one of them can be forgotten
    silently. The printed help is the only surface that answers per client
    without the test re-deriving how that client builds its parser."""

    def _assert_help_lists_the_release_flag(self, verb):
        anchor = GATE_VERBS[verb]
        surfaces = {client: _drive_gate_help(client, verb) for client in CLIENTS}

        # Non-vacuity FIRST — the anchor flag is declared TODAY by every
        # client, so its presence proves the help was really printed and read.
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in surfaces.items() if anchor not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `{verb} --help` carrying the "
            f"already-declared {anchor}; these did not: {unprinted!r}")

        missing = sorted(c for c, r in surfaces.items()
                         if RELEASE_FLAG not in r.stdout)
        self.assertEqual(
            missing, [],
            f"`{verb}` must declare {RELEASE_FLAG} in EVERY client — a gate "
            f"that cannot name its release can never be retired by one; "
            f"missing from: {missing!r}")

        self.assertEqual(len(CLIENT_FILES), EXPECTED_CLIENT_COUNT)
        self.assertEqual(
            len(surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(surfaces)!r}")

    def test_every_client_lists_release_in_its_gate_run_help(self):
        self._assert_help_lists_the_release_flag("gate-run")

    def test_every_client_lists_release_in_its_gate_report_help(self):
        self._assert_help_lists_the_release_flag("gate-report")


# ═══════════════════════════════════════════════════════════════════════════
# The wire recorder — the REAL payload, taken at the transport seam
# ═══════════════════════════════════════════════════════════════════════════
#
# The transport is patched rather than the client's own gate delegator,
# deliberately: the payload is composed by the shared builder BELOW that
# delegator, so recording at the delegator would assert on the client's
# arguments and not on the bytes the server receives. The whole criterion is
# about where the release sits in that object, which only the transport seam
# can answer.


class _GateWireTestBase(unittest.TestCase):

    PROJECT_KEY = "gate-release-wire-key"
    AGENT = "gate-release-wire-agent"

    def setUp(self):
        self.module = _load_client("bun", "gate_release_client_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="gate-release-wire-")
        (Path(self.tmpdir) / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, argv):
        """One client dispatch with the transport recorded → (code, stdout,
        stderr, the payloads that reached the gates route)."""
        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True}

        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, [p for path, p in posted if path == GATES_PATH]

    def report_argv(self, *extra):
        return ["gate-report", "--outcome", "passed", "--commit", "abc1234",
                "--steps", "review:passed,test:passed",
                "--agent", self.AGENT, "--project-dir", self.tmpdir] + list(extra)

    def the_one_gate_payload(self, argv):
        """Drive `argv` and return the SINGLE payload that reached the gates
        route. The count is asserted, not assumed: a verb that refused its
        flags posts nothing, and a body read off an empty list would fail as
        an IndexError naming neither the verb nor its refusal."""
        code, _out, err, payloads = self.drive(argv)
        self.assertEqual(
            len(payloads), 1,
            f"exactly ONE gate POST must reach {GATES_PATH} for {argv!r}; got "
            f"{len(payloads)} (exit={code}, stderr={err.strip()[:400]!r})")
        return payloads[0]


# ── RED — the release rides the wire ──────────────────────────────────────


class GateReportCarriesTheReleaseTest(_GateWireTestBase):

    def test_the_release_rides_as_a_top_level_version_beside_the_gate(self):
        payload = self.the_one_gate_payload(
            self.report_argv(RELEASE_FLAG, RELEASE_LABEL))

        self.assertEqual(
            payload.get("version"), RELEASE_LABEL,
            f"the release must ride as the event's own top-level `version` — "
            f"the field the server stores first-class and retires by; got "
            f"{payload!r}")
        self.assertNotIn(
            "version", payload.get("gate", {}),
            f"the release is a SIBLING of `gate`, never a key inside it: the "
            f"server reads the top-level field and would never see one buried "
            f"in the gate object; got gate={payload.get('gate')!r}")

    def test_a_label_the_client_cannot_recognise_is_sent_verbatim(self):
        payload = self.the_one_gate_payload(
            self.report_argv(RELEASE_FLAG, UNRECOGNISED_LABEL))

        self.assertEqual(
            payload.get("version"), UNRECOGNISED_LABEL,
            f"the label travels VERBATIM — the client never normalises a "
            f"pre-release suffix, strips a prefix, or otherwise rewrites what "
            f"the caller declared; got {payload.get('version')!r}")


# ── RED — the same, for the verb that seals a proxied run ─────────────────

# One RESOLVED nine-step snapshot, the shape `axi status` / `axi run` really
# emit at the end of a run: `status: completed` and a top-level `outcome`, so
# the proxy has nothing in flight to post an interim for and seals exactly
# once. The gate under assertion is that single final seal.
_RESOLVED_SNAPSHOT = (
    'run:\n'
    '  id: "gate-release-run-1"\n'
    '  branch: gate-release-branch\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    '    rebase,completed,0,10\n'
    '    review,completed,0,10\n'
    '    test,completed,0,10\n'
    '    document,completed,0,10\n'
    '    lint,completed,0,10\n'
    '    push,completed,0,10\n'
    '    pr,skipped,0,10\n'
    '    ci,skipped,0,10\n'
    'outcome: passed\n'
)

_FAKE_NO_MISTAKES_BODY = '''
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    sys.stdout.write({snap!r})
    sys.exit(0)
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
sys.exit(1)
'''.format(snap=_RESOLVED_SNAPSHOT)


class GateRunCarriesTheReleaseTest(_GateWireTestBase):

    def setUp(self):
        super().setUp()
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="gate-release-fake-bin-")
        fake = Path(self.fake_bin_dir) / "no-mistakes"
        fake.write_text(f"#!{sys.executable}\n" + _FAKE_NO_MISTAKES_BODY)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        super().tearDown()

    def test_the_sealing_gate_of_a_proxied_run_names_the_release_it_gated(self):
        payload = self.the_one_gate_payload(
            ["gate-run", "--intent", "ship the release",
             "--agent", self.AGENT, "--project-dir", self.tmpdir,
             RELEASE_FLAG, RELEASE_LABEL])

        self.assertEqual(
            payload.get("version"), RELEASE_LABEL,
            f"the gate that SEALS a proxied run is the release workflow's "
            f"tracked trace, so it is the one that most needs to name its "
            f"release; got {payload!r}")
        self.assertNotIn(
            "version", payload.get("gate", {}),
            f"the release is a SIBLING of `gate` on this verb too; got "
            f"gate={payload.get('gate')!r}")
        # Bound: the seal itself is untouched — the flag adds a field, it does
        # not change what the run resolved to.
        self.assertEqual(
            payload.get("gate", {}).get("outcome"), "passed",
            f"the sealed outcome still comes from the run's own resolved "
            f"outcome; got gate={payload.get('gate')!r}")


# ═══════════════════════════════════════════════════════════════════════════
# PASS-SIDE — the shape the new field must not disturb
# ═══════════════════════════════════════════════════════════════════════════


class TodaysGatePayloadSurvivesTest(_GateWireTestBase):
    """Every test in this class passes BEFORE the flag exists and must pass
    after it. They are the measurement behind the word "additive"."""

    def test_without_a_release_the_payload_carries_no_version_key_at_all(self):
        payload = self.the_one_gate_payload(self.report_argv())

        self.assertNotIn(
            "version", payload,
            f"a gate on a feature branch gates no release: the key is ABSENT, "
            f"never null and never empty — a gate carrying a release is "
            f"exempt from pruning until one retires it, so a fabricated value "
            f"would live forever; got {payload!r}")

    def test_the_fleet_context_still_rides_exactly_as_it_does_today(self):
        os.environ["WORKFLOW_WAVE"] = "6"
        os.environ["WORKFLOW_ROLE"] = "Track 2"
        with_env = self.the_one_gate_payload(self.report_argv())
        self.assertEqual(
            with_env.get("context"), {"wave": "6", "track": "Track 2"},
            f"the auto-context must ride unchanged beside the new field; got "
            f"{with_env!r}")

        os.environ.pop("WORKFLOW_WAVE")
        os.environ.pop("WORKFLOW_ROLE")
        without_env = self.the_one_gate_payload(self.report_argv())
        self.assertNotIn(
            "context", without_env,
            f"an empty context is OMITTED, never sent as an empty object — "
            f"the same absent-key rule the release itself follows; got "
            f"{without_env!r}")

    def test_the_gate_object_keeps_its_shape(self):
        payload = self.the_one_gate_payload(self.report_argv())

        self.assertEqual(
            payload.get("gate"),
            {"intent": "passed gate", "outcome": "passed",
             "steps": [{"name": "review", "status": "passed"},
                       {"name": "test", "status": "passed"}],
             "push": {"commit": "abc1234"}},
            f"the gate object is composed exactly as it is today — intent, "
            f"outcome, steps and push, and nothing else: the release is a "
            f"sibling of this object, so no key of it may move or appear; "
            f"got {payload.get('gate')!r}")
        self.assertEqual(
            payload.get("agentId"), self.AGENT,
            f"the identity the gate is posted under is untouched; got {payload!r}")
        self.assertEqual(
            payload.get("projectKey"), self.PROJECT_KEY,
            f"the project the gate is posted to is untouched; got {payload!r}")

    def test_gate_report_still_raises_its_prefer_gate_run_discouragement(self):
        code, out, err, payloads = self.drive(self.report_argv())

        self.assertEqual((code, len(payloads)), (0, 1),
                         f"the ordinary report path still posts and succeeds; "
                         f"stderr={err.strip()[:400]!r}")
        self.assertIn(
            "prefer-gate-run", err,
            f"the discouragement is a property of USING this verb at all, and "
            f"is unaffected by any flag it gained; stderr={err!r}")
        self.assertIn(
            "prefer-gate-run", out,
            f"the same warning rides the machine envelope, not stderr alone; "
            f"stdout={out!r}")


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — the retirement mechanism, reached through a client
# ═══════════════════════════════════════════════════════════════════════════


class ReleaseStampedGateIsRetiredOnInsertTest(unittest.TestCase):
    """§S1's last criterion, and the only one no mock can hold: a gate posted
    with a release the board has ALREADY recorded comes back retired.

    Insert-time retirement lives in the store's own gate-insert path, which
    consults the recorded releases — so it is observable only against a real
    store. The unretired sibling in the same test is what proves the marker
    came from the release MATCH and not from the flag merely being present.

    The two gates are read back off the cycle-anchored feed rather than the
    recent-events feed, deliberately: the live feed EXCLUDES retired gates, so
    reading them there would answer the question with an absence."""

    RELEASED = "7.7.7"
    UNRELEASED = "8.8.8"
    ORCHESTRATOR = "gate-release-e2e-orchestrator"
    GATE_AGENT = "gate-release-e2e-agent"
    FIXTURE_CR = "CR-G1-1"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="gate-release-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "insert-time retirement is a property of the real store: "
                "without `bun` there is no server to hold it. A missing "
                "toolchain, not a passing assertion.")
        port = _free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_PORT": str(port),
                 "CRUCIBLE_HOST": "127.0.0.1",
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "gate-release-e2e"})
        cls.key = project["project"]["key"]
        _register(cls.base, cls.key, cls.ORCHESTRATOR, "ORCHESTRATOR")

        # A plan with one ACTIVE cycle, so the gate poster can register BOUND
        # and its gates land on that cycle's anchored feed.
        filed = _http(cls.base, f"/api/v2/projects/{cls.key}/plans",
                      {"cr": cls.FIXTURE_CR, "cycles": [{"label": "solo"}],
                       "agentId": cls.ORCHESTRATOR})
        cls.cycle_id = filed["cycles"][0]["id"]
        activated = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/plans/{filed['planId']}/cycles/{cls.cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        _register(cls.base, cls.key, cls.GATE_AGENT, "RED", cycle_id=cls.cycle_id)

        # The release the board has ALREADY shipped. Its counterpart label is
        # deliberately never recorded.
        recorded = _http(cls.base, "/api/v2/milestones",
                         {"projectKey": cls.key, "agentId": cls.ORCHESTRATOR,
                          "type": "release", "label": cls.RELEASED})
        assert recorded.get("ok"), f"release milestone failed: {recorded!r}"

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={cls.key}\n")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "_proc", None) is not None:
            cls._proc.terminate()
            try:
                cls._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls._proc.kill()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _post_gate_through_the_client(self, release):
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["CRUCIBLE_URL"] = self.base
        return subprocess.run(
            [sys.executable, str(CLIENT_FILES["bun"]), "gate-report",
             "--outcome", "passed", "--steps", "review:passed",
             "--intent", f"gate for {release}", "--agent", self.GATE_AGENT,
             RELEASE_FLAG, release, "--project-dir", self.project_dir],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def _gates_by_version(self):
        feed = _http(self.base,
                     f"/api/v2/events?project={self.key}&cycleId={self.cycle_id}")
        return {event.get("version"): event
                for event in feed.get("events", [])
                if event.get("kind") == "gate"}

    def test_a_gate_naming_an_already_recorded_release_comes_back_retired(self):
        for release in (self.RELEASED, self.UNRELEASED):
            run = self._post_gate_through_the_client(release)
            self.assertEqual(
                run.returncode, 0,
                f"the client must post a gate naming release {release!r}; "
                f"exit={run.returncode} stdout={run.stdout.strip()[:400]!r} "
                f"stderr={run.stderr.strip()[:400]!r}")

        gates = self._gates_by_version()
        self.assertEqual(
            sorted(gates), sorted([self.RELEASED, self.UNRELEASED]),
            f"both gates must be on the board, each carrying its OWN release "
            f"— and exactly two of them; got {gates!r}")

        retired = gates[self.RELEASED]
        live = gates[self.UNRELEASED]
        self.assertIsInstance(
            retired.get("retiredAt"), int,
            f"a gate whose release has already shipped is retired AT INSERT, "
            f"the marker carrying the moment it happened; got {retired!r}")
        self.assertNotIn(
            "retiredAt", live,
            f"a gate whose release is not recorded is a release UNDER WAY and "
            f"stays live — which is what proves the marker above came from "
            f"the release match and not from the flag being present; got "
            f"{live!r}")

        stored = _http(self.base, f"/api/v2/events/{retired['id']}").get("event", {})
        self.assertEqual(
            (stored.get("version"), type(stored.get("retiredAt"))),
            (self.RELEASED, int),
            f"the stored event itself carries both facts, so the retirement "
            f"is durable rather than a projection of the feed; got {stored!r}")


if __name__ == "__main__":
    unittest.main()
