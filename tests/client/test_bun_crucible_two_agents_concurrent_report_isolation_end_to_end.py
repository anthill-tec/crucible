"""AC8 (wiring) — two agents running `clients/bun-crucible.py`'s `test` verb
(`cmd_test`) against ONE real, ephemeral board, in ONE project, AT THE SAME
TIME, each filing their OWN results with distinct counts.

The per-agent isolation itself (`run_reports_dir` / `reports_dir_is_agents_own`,
`clients/_crucible_axi.py`; `_reports_dir` / `_wipe` / `_junit_path`,
`clients/bun-crucible.py::cmd_test`) already landed on this branch — this file
is filed anyway because AC8 asks for proof of the WIRING: a genuine live
subprocess pair, started together and overlapping for real, against a real
board (`bun run src/server.ts`), read back over the board's own HTTP
(`eventBrief`, `handleEventsList`, `src/v2.ts`), not a mocked transport.
**The main test below is expected to PASS on first run.**

Non-vacuity (the second test in this file): the concurrent proof alone cannot
show that its PASS depends on the isolation rather than on the harness being
too weak to notice a clash. So the second test forces both agents onto ONE
EXPLICIT `--reports` directory — which `run_reports_dir` honours verbatim,
bypassing the per-agent default entirely — and shows this reproduces exactly
the clobber the isolation exists to prevent: agent-alpha's own evidence is
overwritten by agent-bravo's run, byte for byte. That test is ALSO expected to
PASS (it pins existing, already-implemented `--reports` semantics), and its
passing is what proves the first test's PASS is not a foregone conclusion of
the fixture — it is contingent on `run_reports_dir` actually nesting by
`--agent` when no `--reports` is given.

Overlap technique: the fake `bun` executable each subprocess is pointed at
blocks on a SHARED FILESYSTEM BARRIER before it derives or writes anything —
it drops its own marker file, then polls for its peer's marker with a bounded
timeout, exiting loudly (code 3) if the peer never shows up. Two `bun test`
invocations can only both cross that barrier if they are genuinely running at
the same time, so a regression that serialised the two client subprocesses
(accidentally or otherwise) would surface as a hard, named failure here
rather than a silently-passing test.

Each agent's OWN counts are derived from a REAL, DIFFERENTLY-SIZED test
source file the fake `bun` is pointed at via `--tests` (3 tests for
agent-alpha, 7 for agent-bravo, one of them a planted `test.failing(...)`) —
not from two independently-set environment variables — so a bug that fed one
agent's `--tests` argument to the wrong process, or that let one run's file
read bleed into the other's, changes the asserted counts, not just a label.

Follows the scratch-board idiom from
`test_status_verb_shows_open_plans_end_to_end.py` /
`test_queue_rows_carry_title_and_lifecycle.py`: a `bun run src/server.ts` on a
free port with a throwaway `mkdtemp` store (never :3850/:3849, never a live
project), the board declared through `declare_and_require_board`
(`test_client_fleet_envelope_census.py`), driven as genuine
`python3 clients/bun-crucible.py` subprocesses.

Invocation:
    python3 -m unittest tests.client.test_bun_crucible_two_agents_concurrent_report_isolation_end_to_end
"""

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import declare_and_require_board

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"

# The env keys cleared before every subprocess drive so an ambient
# orchestrator session can never colour the run under test (the idiom every
# live-subprocess harness in this directory shares).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_BUN",
            "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

BARRIER_TIMEOUT_EXIT_CODE = 3

# Two REAL, differently-sized fixture test sources. agent-alpha's carries 3
# passing cases; agent-bravo's carries 7 (6 passing + 1 planted
# `test.failing(...)`), so the two agents' counts differ on every axis
# (total, passed, failed) — not merely "a" vs "b" labels.
AGENT_A_SOURCE = (
    'test("alpha adds numbers", () => {});\n'
    'test("alpha subtracts numbers", () => {});\n'
    'test("alpha multiplies numbers", () => {});\n'
)
AGENT_B_SOURCE = (
    'test("bravo case one", () => {});\n'
    'test("bravo case two", () => {});\n'
    'test("bravo case three", () => {});\n'
    'test("bravo case four", () => {});\n'
    'test("bravo case five", () => {});\n'
    'test("bravo case six", () => {});\n'
    'test.failing("bravo known bug", () => {});\n'
)

# A fake `bun` that answers ONLY the `test` invocation `cmd_test`
# (clients/bun-crucible.py) builds via `_bun_test_cmd`/`_bun_test_report_flags`:
# `bun test --timeout <ms> [targets...] --reporter=junit
# --reporter-outfile=<path>`. Real bun/playwright is never touched.
#
# Overlap barrier (only engaged when FAKE_BUN_BARRIER_DIR is set — the
# sequential non-vacuity proof below omits it and runs solo): drop this run's
# own marker, then poll for the peer's, bounded, so two runs that never
# actually overlapped fail LOUDLY (exit 3) instead of quietly.
#
# The reported counts are derived from the REAL content of the file(s) named
# on the command line (`targets`) — never from an env-var payload — a
# `(?:test|it)(?:\.(?:only|failing|skip|todo|serial|concurrent|each))*\(`
# call-site scan mirroring the shape `_TEST_DECL` (clients/bun-crucible.py)
# already recognises, restricted here to the two markers this fixture uses:
# a bare `test("name"` (passing) and `test.failing("name"` (failing).
_FAKE_BUN_TEMPLATE = r'''#!PYTHON_EXE
import os
import re
import sys
import time

argv = sys.argv[1:]
if argv[:1] != ["test"]:
    sys.exit(1)

outfile = None
targets = []
i = 1
while i < len(argv):
    tok = argv[i]
    if tok == "--timeout":
        i += 2
        continue
    if tok.startswith("--reporter-outfile="):
        outfile = tok.split("=", 1)[1]
        i += 1
        continue
    if tok.startswith("--reporter=") or tok.startswith("--coverage"):
        i += 1
        continue
    targets.append(tok)
    i += 1

barrier_dir = os.environ.get("FAKE_BUN_BARRIER_DIR")
if barrier_dir:
    own_tag = os.environ["FAKE_BUN_OWN_TAG"]
    peer_tag = os.environ["FAKE_BUN_PEER_TAG"]
    own_marker = os.path.join(barrier_dir, own_tag + ".ready")
    peer_marker = os.path.join(barrier_dir, peer_tag + ".ready")
    with open(own_marker, "w") as fh:
        fh.write(repr(time.time()))
    deadline = time.time() + 20.0
    while not os.path.exists(peer_marker):
        if time.time() > deadline:
            sys.stderr.write(
                "fake-bun: peer marker never appeared -- no real overlap\n")
            sys.exit(3)
        time.sleep(0.02)

passed_names = []
failed_names = []
for path in targets:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    for name in re.findall(r'^test\("([^"]+)"', text, re.M):
        passed_names.append(name)
    for name in re.findall(r'^test\.failing\("([^"]+)"', text, re.M):
        failed_names.append(name)

total = len(passed_names) + len(failed_names)
parts = []
for name in passed_names:
    parts.append(
        '<testcase name="%s" classname="fixture" time="0.001"></testcase>' % name)
for name in failed_names:
    parts.append(
        '<testcase name="%s" classname="fixture" time="0.001">'
        '<failure message="planted">planted failure</failure></testcase>' % name)
xml = (
    '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
    '<testsuite name="fixture" tests="%d" failures="%d">%s</testsuite>'
    '</testsuites>' % (total, len(failed_names), "".join(parts)))

if outfile:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = outfile + ".tmp"
    with open(tmp_path, "w") as fh:
        fh.write(xml)
    os.replace(tmp_path, outfile)

sys.exit(1 if failed_names else 0)
'''

def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port

def _declare_listener(store_dir, port, host="127.0.0.1"):
    """Declare the scratch server's OWN listener (never the live board's
    :3850/:3849) where the server reads it."""
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")

def _guarded_urlopen(request_or_url, timeout):
    """`urllib.request.urlopen` restricted to plain `http://` -- every target
    in this file is a scratch board this class itself just declared on
    `127.0.0.1`, never a caller-supplied URL, but the scheme is still checked
    explicitly rather than trusted implicitly."""
    url = (request_or_url.full_url if isinstance(request_or_url, urllib.request.Request)
           else request_or_url)
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme != "http":
        raise ValueError(f"refusing to open a non-http(s) URL: {url!r}")
    return urllib.request.urlopen(request_or_url, timeout=timeout)  # noqa: S310

def _http(base, path, payload=None, method=None):
    import json
    if urllib.parse.urlsplit(base).scheme != "http":
        raise ValueError(f"refusing to target a non-http(s) base URL: {base!r}")
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310 -- scheme validated above
        base + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with _guarded_urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())

def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with "
                               f"{proc.returncode}")
        try:
            with _guarded_urlopen(base + "/api/v2/health", timeout=2):
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")

class TwoConcurrentAgentsFileTheirOwnReportsEndToEndTest(unittest.TestCase):
    """AC8 — the real `test` verb (`clients/bun-crucible.py::cmd_test`, genuine
    subprocesses) driven twice, concurrently, by two different `--agent`
    identities against ONE ephemeral board, in ONE project directory."""

    AGENT_ALPHA = "e2e-concurrent-agent-alpha"
    AGENT_BRAVO = "e2e-concurrent-agent-bravo"
    SHARED_AGENT_ALPHA = "e2e-shared-reports-agent-alpha"
    SHARED_AGENT_BRAVO = "e2e-shared-reports-agent-bravo"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="bun-two-agents-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "two agents filing their OWN results on a real board is a "
                "property of the real server AND the real bun binary "
                "running it: without `bun` there is no scratch board to "
                "drive. A missing toolchain, not a passing assertion.")
        cls.bun = bun
        port = _free_port()
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ,
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._boot()
        except BaseException:
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects",
                        {"name": "bun-two-agents-e2e"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.key = project["project"]["key"]

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir, exist_ok=True)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        # CR-CRU-139 §S2's board-declaration interlock, shared across every
        # client: refuses to spawn a drive that would not really resolve
        # THIS scratch board, so a drive can never silently fall back onto
        # the shipped default (production, on this machine).
        declare_and_require_board(cls.project_dir, cls.base, "bun-crucible.py")

        cls.fake_bun = os.path.join(cls._tmpdir, "fake_bun.py")
        Path(cls.fake_bun).write_text(
            _FAKE_BUN_TEMPLATE.replace("PYTHON_EXE", sys.executable))
        os.chmod(cls.fake_bun, 0o700)

        Path(cls.project_dir, "agent_a.test.ts").write_text(AGENT_A_SOURCE)
        Path(cls.project_dir, "agent_b.test.ts").write_text(AGENT_B_SOURCE)

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

    def _spawn(self, agent, test_file, reports=None, barrier_dir=None,
              own_tag=None, peer_tag=None):
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        if barrier_dir:
            assert own_tag is not None and peer_tag is not None, (
                "own_tag/peer_tag are required whenever barrier_dir is given")
            env["FAKE_BUN_BARRIER_DIR"] = barrier_dir
            env["FAKE_BUN_OWN_TAG"] = own_tag
            env["FAKE_BUN_PEER_TAG"] = peer_tag
        argv = [sys.executable, str(BUN_CLIENT_PATH), "test",
               "--bun", self.fake_bun,
               "--project-dir", self.project_dir,
               "--package-dir", self.project_dir,
               "--tests", test_file,
               "--agent", agent]
        if reports:
            argv += ["--reports", reports]
        return subprocess.Popen(argv, cwd=str(REPO_ROOT), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)

    def _events_for(self, agent_id):
        """The board's OWN record of this agent's FILED RUN(s), read back over
        its real GET route (`handleEventsList` -> `eventBrief`, `src/v2.ts`) —
        never the client's own stdout, so a client that ingested the WRONG
        summary is caught here, not merely a client that printed one. Filtered
        to `kind == "test"`: the SAME feed also carries this agent's
        lifecycle `registered`/`unregistered` events from the gated bracket's
        opening heartbeat and closing silent removal (`_open_gate_identity` /
        `_close_gate_identity`, clients/bun-crucible.py), which are real
        board rows for this agentId too but carry no run counts at all."""
        answer = _http(self.base,
                       f"/api/v2/events?project={self.key}&limit=100")
        self.assertTrue(answer.get("ok"), f"events fetch failed: {answer!r}")
        return [e for e in answer.get("events", [])
               if e.get("agentId") == agent_id and e.get("kind") != "lifecycle"]

    def test_two_agents_running_concurrently_each_file_their_own_distinct_results(self):
        """AC8 — driven as two genuine `bun-crucible.py test --agent` subprocesses
        started together (Popen, not run()) and forced to overlap for real by
        the fake `bun`'s own filesystem barrier. Each reads its OWN,
        differently-sized test file and ingests through the real gated
        bracket (`_open_gate_identity` -> `_ingest_parsed` ->
        `_close_gate_identity`, clients/bun-crucible.py::cmd_test) against the
        real board. Expected to PASS: the per-agent isolation this proves end
        to end already landed."""
        barrier_dir = tempfile.mkdtemp(dir=self._tmpdir)

        proc_alpha = self._spawn(
            agent=self.AGENT_ALPHA, test_file="agent_a.test.ts",
            barrier_dir=barrier_dir, own_tag="alpha", peer_tag="bravo")
        proc_bravo = self._spawn(
            agent=self.AGENT_BRAVO, test_file="agent_b.test.ts",
            barrier_dir=barrier_dir, own_tag="bravo", peer_tag="alpha")

        try:
            out_alpha, err_alpha = proc_alpha.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            proc_alpha.kill()
            proc_bravo.kill()
            raise
        try:
            out_bravo, err_bravo = proc_bravo.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            proc_bravo.kill()
            raise

        # The barrier is the OVERLAP proof: either subprocess would exit 3
        # (loudly, naming "no real overlap") if it never saw its peer's
        # marker within the bound — a regression that serialised the two
        # runs (so one had already finished, or never started, by the time
        # the other reached the barrier) fails HERE, not silently.
        self.assertNotEqual(
            proc_alpha.returncode, BARRIER_TIMEOUT_EXIT_CODE,
            f"agent-alpha's fake bun never observed agent-bravo running "
            f"concurrently: stderr={err_alpha!r}")
        self.assertNotEqual(
            proc_bravo.returncode, BARRIER_TIMEOUT_EXIT_CODE,
            f"agent-bravo's fake bun never observed agent-alpha running "
            f"concurrently: stderr={err_bravo!r}")
        alpha_marker = os.path.join(barrier_dir, "alpha.ready")
        bravo_marker = os.path.join(barrier_dir, "bravo.ready")
        self.assertTrue(os.path.exists(alpha_marker), "agent-alpha's own "
                        "barrier marker must exist -- it crosses the "
                        "barrier before writing any report")
        self.assertTrue(os.path.exists(bravo_marker), "agent-bravo's own "
                        "barrier marker must exist -- it crosses the "
                        "barrier before writing any report")
        self.assertLess(
            abs(os.path.getmtime(alpha_marker) - os.path.getmtime(bravo_marker)),
            15.0,
            "the two runs' barrier markers should land within the same "
            "short window if they were really started together")

        # agent-alpha: 3 real passing cases, 0 failures.
        self.assertEqual(
            proc_alpha.returncode, 0,
            f"agent-alpha's run has no planted failures and must succeed; "
            f"stdout={out_alpha!r} stderr={err_alpha!r}")
        # agent-bravo: 6 passing + 1 planted `test.failing(...)` -> the run
        # itself exits non-zero even though the ingest succeeds (`cmd_test`
        # returns 1 whenever `summary["failed"] > 0`).
        self.assertEqual(
            proc_bravo.returncode, 1,
            f"agent-bravo's run carries ONE planted failure and must report "
            f"it via a non-zero exit; stdout={out_bravo!r} stderr={err_bravo!r}")

        # The board's OWN record of each agent's run — distinct counts, on
        # every axis, attributed to the RIGHT agent.
        alpha_events = self._events_for(self.AGENT_ALPHA)
        bravo_events = self._events_for(self.AGENT_BRAVO)
        self.assertEqual(
            len(alpha_events), 1,
            f"expected exactly one filed run for agent-alpha; got "
            f"{alpha_events!r}")
        self.assertEqual(
            len(bravo_events), 1,
            f"expected exactly one filed run for agent-bravo; got "
            f"{bravo_events!r}")
        alpha_event, bravo_event = alpha_events[0], bravo_events[0]
        self.assertEqual(
            (alpha_event["total"], alpha_event["passed"], alpha_event["failed"]),
            (3, 3, 0),
            f"agent-alpha's filed run must carry EXACTLY its own 3 passing "
            f"cases, never agent-bravo's; got {alpha_event!r}")
        self.assertEqual(
            (bravo_event["total"], bravo_event["passed"], bravo_event["failed"]),
            (7, 6, 1),
            f"agent-bravo's filed run must carry EXACTLY its own 7 cases "
            f"(6 passed, 1 planted failure), never agent-alpha's; got "
            f"{bravo_event!r}")

        # Each agent's own `test-reports/<agent>/` on disk — never the
        # other's, never the shared top level (`run_reports_dir`,
        # clients/_crucible_axi.py).
        alpha_junit = os.path.join(
            self.project_dir, "test-reports", self.AGENT_ALPHA, "junit.xml")
        bravo_junit = os.path.join(
            self.project_dir, "test-reports", self.AGENT_BRAVO, "junit.xml")
        self.assertTrue(os.path.exists(alpha_junit), f"expected {alpha_junit}")
        self.assertTrue(os.path.exists(bravo_junit), f"expected {bravo_junit}")
        with open(alpha_junit) as fh:
            alpha_xml = fh.read()
        with open(bravo_junit) as fh:
            bravo_xml = fh.read()
        self.assertIn('tests="3"', alpha_xml)
        self.assertNotIn("bravo", alpha_xml,
                         "agent-alpha's own report must never carry "
                         "agent-bravo's testcase names")
        self.assertIn('tests="7"', bravo_xml)
        self.assertNotIn("alpha", bravo_xml,
                         "agent-bravo's own report must never carry "
                         "agent-alpha's testcase names")
        shared_top_junit = os.path.join(
            self.project_dir, "test-reports", "junit.xml")
        self.assertFalse(
            os.path.exists(shared_top_junit),
            "no report may land directly in the SHARED test-reports/ top "
            "level when every run named an --agent")

    def test_forcing_a_shared_reports_dir_reproduces_the_clobber_isolation_prevents(self):
        """Non-vacuity proof for the test above. `run_reports_dir`
        (clients/_crucible_axi.py) honours an EXPLICIT `--reports` verbatim
        for EVERY agent — that is existing, correct behaviour (an explicit
        `--reports` is used as given) — so pointing both agents at the SAME
        literal directory bypasses the per-agent nesting entirely and
        reproduces exactly the clobber this AC's isolation exists to
        prevent: agent-alpha's own evidence is overwritten, byte for byte, by
        agent-bravo's run. Deliberately SEQUENTIAL (no barrier): the point
        made here does not need concurrency — an explicit shared `--reports`
        clobbers even one run after another, which is the whole reason the
        per-agent DEFAULT (proved above) matters. Expected to PASS: this pins
        `--reports`'s already-shipped verbatim semantics."""
        shared_reports = "shared-reports-for-both-agents"
        shared_dir = os.path.join(self.project_dir, shared_reports)

        proc_alpha = self._spawn(
            agent=self.SHARED_AGENT_ALPHA, test_file="agent_a.test.ts",
            reports=shared_reports)
        out_alpha, err_alpha = proc_alpha.communicate(timeout=40)
        self.assertEqual(
            proc_alpha.returncode, 0,
            f"agent-alpha's solo run must succeed; stdout={out_alpha!r} "
            f"stderr={err_alpha!r}")

        shared_junit = os.path.join(shared_dir, "junit.xml")
        with open(shared_junit) as fh:
            after_alpha = fh.read()
        self.assertIn('tests="3"', after_alpha,
                      "agent-alpha's own 3 cases must be there right after "
                      "its own run")

        alpha_events_before = self._events_for(self.SHARED_AGENT_ALPHA)
        self.assertEqual(len(alpha_events_before), 1)
        self.assertEqual(
            (alpha_events_before[0]["total"], alpha_events_before[0]["failed"]),
            (3, 0))

        # agent-bravo reuses the SAME literal --reports directory next.
        proc_bravo = self._spawn(
            agent=self.SHARED_AGENT_BRAVO, test_file="agent_b.test.ts",
            reports=shared_reports)
        out_bravo, err_bravo = proc_bravo.communicate(timeout=40)
        self.assertEqual(
            proc_bravo.returncode, 1,
            f"agent-bravo's solo run carries its own planted failure; "
            f"stdout={out_bravo!r} stderr={err_bravo!r}")

        # THE CLOBBER: reading the SAME literal path now answers with
        # agent-bravo's content ONLY — agent-alpha's own evidence, filed
        # moments earlier, is gone. Nothing scopes this path by --agent: an
        # explicit --reports is the identical string for both calls.
        with open(shared_junit) as fh:
            after_bravo = fh.read()
        self.assertNotIn(
            'tests="3"', after_bravo,
            "agent-alpha's own report must have survived if isolation held "
            "here too -- it did NOT, because an explicit --reports is "
            "shared verbatim across agents (run_reports_dir, "
            "clients/_crucible_axi.py)")
        self.assertIn('tests="7"', after_bravo)
        self.assertNotIn(
            "alpha", after_bravo,
            "agent-alpha's OWN testcase names must be gone from the shared "
            "file once agent-bravo's run reused the same literal path -- "
            "proof this is a real OVERWRITE, not an append")

        # Neither agent got a per-agent subdirectory when --reports was
        # given explicitly.
        self.assertFalse(os.path.isdir(
            os.path.join(self.project_dir, "test-reports",
                        self.SHARED_AGENT_ALPHA)))
        self.assertFalse(os.path.isdir(
            os.path.join(self.project_dir, "test-reports",
                        self.SHARED_AGENT_BRAVO)))

if __name__ == "__main__":
    unittest.main()
