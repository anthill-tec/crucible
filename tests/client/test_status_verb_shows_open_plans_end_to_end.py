"""RED tests — the `status` verb's wiring against a real board carrying open,
closed and aborted plans (AC10/AC12 end-to-end proofs).

AC10 — end to end against a real, ephemeral board holding open, closed and
aborted plans: the `status` verb's envelope has the open plans as rows, and
`filed`/`lastClosedCr` equal the server's values. No stubbed transport.

AC12 — AC10's end-to-end run is repeated with `--format json`, and the
parsed object carries the open plans as `plans`, and the server's `filed`
and `lastClosedCr`.

Both are WIRING proofs over behaviour that already landed on this branch
(the server-side `?status=` filter, the two published project facts, and
`cmd_status` reading them through verbatim) — they are expected to PASS
today. What makes them non-vacuous is that the fixture board really holds a
CLOSED plan (a merge commit, so `closedAt` is set) and an ABORTED plan
alongside two OPEN ones: a stub that returned every plan regardless of
status, or a client that recomputed `filed`/`lastClosedCr` instead of
reading the server's own values, fails the assertions below. The
server-side facts are read back over its own HTTP `GET …/plans` response,
never hardcoded, so the comparison is against the real board, not the
fixture's intent.

Follows the `queue` verb's own end-to-end idiom
(`test_queue_rows_carry_title_and_lifecycle.py`): a scratch
`bun run src/server.ts` on a free port with a throwaway `mkdtemp` store
(never :3850/:3849, never a live project), the board built through real
HTTP routes, the verb driven as a genuine `python-crucible.py` subprocess,
its TOON stdout decoded with `clients/toon.py`'s own decoder.

Invocation:
    python3 -m unittest tests.client.test_status_verb_shows_open_plans_end_to_end
"""

import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (  # noqa: E402
    declare_and_require_board,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
PYTHON_CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

# The env keys the fleet's `context` block reads — cleared before every
# subprocess drive so an ambient orchestrator session can never colour the
# envelope under test (the same idiom the queue end-to-end suite uses).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    """Declare the scratch server's OWN listener (never the live board's
    :3850/:3849) where the server reads it — the `crucible.toml` beside the
    database it is pointed at."""
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _http(base, path, payload=None, method=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which is the assertion subject for a
    refusal."""
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
            raise RuntimeError(f"scratch server exited early with "
                               f"{proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):  # noqa: S310
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")


def _register(base, key, agent_id, role):
    body = {"projectKey": key, "agentId": agent_id, "status": "online",
            "role": role, "identity": {"displayName": agent_id, "source": "manual"}}
    answer = _http(base, "/api/v2/agents/register", body)
    assert answer.get("ok"), f"register failed for {agent_id}: {answer!r}"
    return answer


class StatusVerbShowsOpenPlansEndToEndTest(unittest.TestCase):
    """AC10/AC12 — the real `status` verb (`clients/python-crucible.py`, a
    genuine subprocess) driven against an EPHEMERAL board holding TWO open
    plans, one CLOSED plan (with a merge commit, so `closedAt` is set) and
    one ABORTED plan.

    RED-agent note: AC1-AC7 (the server-side `?status=` filter and the two
    published project facts) and the shared `cmd_status` (AC4-AC6) already
    landed on this branch — these two tests are expected to PASS on first
    run. They are filed anyway because the wiring itself (a live
    subprocess against a live server, decoded both as TOON and as JSON) is
    what AC10/AC12 actually require proof of, and the fixture asserts its
    own sanity (four plans filed, one demonstrably closed) so a future
    regression that made the board vacuous — e.g. all four plans staying
    open — would be caught here too."""

    ORCHESTRATOR = "status-e2e-orchestrator"
    OPEN_CR_1 = "CR-T-STATUS-OPEN-1"
    OPEN_CR_2 = "CR-T-STATUS-OPEN-2"
    CLOSED_CR = "CR-T-STATUS-CLOSED"
    ABORTED_CR = "CR-T-STATUS-ABORTED"
    WAVE = "1"
    MERGE_COMMIT = "c0ffee1"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="status-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the open/closed/aborted board is a property of the REAL "
                "store: without `bun` there is no server to hold it. A "
                "missing toolchain, not a passing assertion.")
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
            # A child spawned and then abandoned by a FAILING setUpClass is
            # never torn down (tearDownClass does not run), and an orphaned
            # server holds its port for as long as it lives.
            cls._stop_server()
            raise

    @classmethod
    def _file_plan(cls, cr):
        filed = _http(cls.base, f"/api/v2/projects/{cls.key}/plans",
                      {"cr": cr, "wave": cls.WAVE,
                       "cycles": [{"label": "solo"}],
                       "agentId": cls.ORCHESTRATOR})
        assert filed.get("ok"), f"plan-file failed for {cr}: {filed!r}"
        return filed

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "status-e2e"})
        cls.key = project["project"]["key"]
        _register(cls.base, cls.key, cls.ORCHESTRATOR, "ORCHESTRATOR")

        cls.open_plan_1 = cls._file_plan(cls.OPEN_CR_1)["planId"]
        cls.open_plan_2 = cls._file_plan(cls.OPEN_CR_2)["planId"]
        closed_filed = cls._file_plan(cls.CLOSED_CR)
        closed_plan_id = closed_filed["planId"]
        aborted_plan_id = cls._file_plan(cls.ABORTED_CR)["planId"]

        # A plan closes only with every cycle in a TERMINAL state — activate
        # then complete the closed plan's own cycle before the PATCH below.
        closed_cycle_id = closed_filed["cycles"][0]["id"]
        activated = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/plans/{closed_plan_id}/cycles/{closed_cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        completed = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/plans/{closed_plan_id}/cycles/{closed_cycle_id}",
            {"status": "done", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert completed.get("ok"), f"cycle completion failed: {completed!r}"

        closed = _http(
            cls.base, f"/api/v2/projects/{cls.key}/plans/{closed_plan_id}",
            {"status": "closed", "merge": {"commit": cls.MERGE_COMMIT},
             "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert closed.get("ok"), f"closing the plan failed: {closed!r}"

        aborted = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/plans/{aborted_plan_id}/abort",
            {"userApproved": True, "agentId": cls.ORCHESTRATOR,
             # CR-CRU-165 S2b -- an abort now requires a recorded reason,
             # cause and spec reference; this fixture's abort is not the
             # subject under test, so it simply supplies them to keep
             # succeeding under the new server contract.
             "reason": "fixture: retiring this plan to exercise the aborted/closed/open split",
             "cause": "gap-analysis", "specRef": "fixture §1"})
        assert aborted.get("ok"), f"aborting the plan failed: {aborted!r}"

        # The server's OWN facts, read back over HTTP — this is what the
        # test assertions compare the client's output against, never a
        # hardcoded guess. Asserted here too (fixture sanity): if the board
        # does not really carry 4 filed plans with the closed one as the
        # last-closed CR, the end-to-end proof below would be vacuous.
        cls.server_facts = _http(cls.base, f"/api/v2/projects/{cls.key}/plans")
        assert cls.server_facts.get("filed") == 4, (
            f"fixture sanity: expected 4 filed plans on the scratch board, "
            f"got {cls.server_facts!r}")
        assert cls.server_facts.get("lastClosedCr") == cls.CLOSED_CR, (
            f"fixture sanity: expected lastClosedCr={cls.CLOSED_CR!r}, "
            f"got {cls.server_facts!r}")
        cls.server_open = _http(
            cls.base, f"/api/v2/projects/{cls.key}/plans?status=open")
        assert sorted(p.get("cr") for p in cls.server_open.get("plans", [])) \
            == sorted([cls.OPEN_CR_1, cls.OPEN_CR_2]), (
            f"fixture sanity: expected exactly the two open CRs on the "
            f"server's own ?status=open read, got {cls.server_open!r}")

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(TOON_PATH, "status_e2e_toon")

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        """Stop the scratch server, from teardown OR from a setUpClass that
        failed after spawning it. Idempotent, so both callers may run."""
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    def _run_status(self, extra_args=()):
        # the board is declared in the fixture's OWN project file, and
        # the interlock refuses the spawn unless the client would really
        # really resolve it — this read must land on the SCRATCH board,
        # never the shipped default (which on this machine is production).
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        run = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "status",
             "--project-dir", self.project_dir, *extra_args],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        self.assertEqual(
            run.returncode, 0,
            f"the `status` verb must succeed against the ephemeral board; "
            f"exit={run.returncode} stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        return run.stdout

    def test_ac10_toon_status_carries_only_the_open_plans_and_the_servers_facts(self):
        """AC10 — the `status` verb's envelope has the open plans as rows,
        and `filed`/`lastClosedCr` equal the server's values."""
        stdout = self._run_status()
        decoded = self.toon.decode(stdout)
        self.assertIn(
            "axi", decoded,
            f"`status` must answer with a TOON-AXI envelope; got "
            f"stdout={stdout!r}")
        axi = decoded["axi"]

        rows = axi.get("plans")
        self.assertIsInstance(
            rows, list,
            f"the `plans` field must decode as a list of rows; got "
            f"{rows!r} from stdout={stdout!r}")
        row_crs = sorted(r.get("cr") for r in rows)
        self.assertEqual(
            row_crs, sorted([self.OPEN_CR_1, self.OPEN_CR_2]),
            f"status rows must be EXACTLY the two open plans — the closed "
            f"and aborted plans this board also holds must never appear "
            f"as rows; got {rows!r}")
        self.assertEqual(
            axi.get("count"), 2,
            f"count must equal the number of open-plan rows; got {axi!r}")
        self.assertEqual(
            axi.get("filed"), self.server_facts.get("filed"),
            f"filed must equal the server's OWN total plan count "
            f"({self.server_facts.get('filed')!r}), read over HTTP — "
            f"not a client-recomputed value; got {axi!r}")
        self.assertEqual(
            axi.get("lastClosedCr"), self.server_facts.get("lastClosedCr"),
            f"lastClosedCr must equal the server's own value "
            f"({self.server_facts.get('lastClosedCr')!r}); got {axi!r}")

    def test_ac12_json_format_carries_the_open_plans_and_the_servers_facts(self):
        """AC12 — AC10's end-to-end run repeated with `--format json`; the
        parsed object carries the open plans as `plans`, and the server's
        `filed`/`lastClosedCr`."""
        stdout = self._run_status(extra_args=("--format", "json"))
        parsed = json.loads(stdout)
        self.assertIsInstance(
            parsed, dict,
            f"--format json must write exactly one JSON object; got "
            f"stdout={stdout!r}")
        row_crs = sorted(r.get("cr") for r in parsed.get("plans", []))
        self.assertEqual(
            row_crs, sorted([self.OPEN_CR_1, self.OPEN_CR_2]),
            f"the parsed object's `plans` must be EXACTLY the two open "
            f"plans — the closed and aborted plans must never appear; got "
            f"{parsed!r}")
        self.assertEqual(
            parsed.get("count"), 2,
            f"the parsed count must equal the number of open-plan rows; "
            f"got {parsed!r}")
        self.assertEqual(
            parsed.get("filed"), self.server_facts.get("filed"),
            f"the parsed filed must equal the server's own value "
            f"({self.server_facts.get('filed')!r}); got {parsed!r}")
        self.assertEqual(
            parsed.get("lastClosedCr"), self.server_facts.get("lastClosedCr"),
            f"the parsed lastClosedCr must equal the server's own value "
            f"({self.server_facts.get('lastClosedCr')!r}); got {parsed!r}")


if __name__ == "__main__":
    unittest.main()
