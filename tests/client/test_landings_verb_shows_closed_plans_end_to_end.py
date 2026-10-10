"""RED test — §S9/AC15: end to end against a real, ephemeral board, the
`landings` verb, run as a real client subprocess, returns exactly the
closed plans the server's own `GET …/plans?status=closed` returns, with
their merge commits.

Follows the `status` verb's own end-to-end idiom
(`test_status_verb_shows_open_plans_end_to_end.py`, itself following
`test_queue_rows_carry_title_and_lifecycle.py`): a scratch `bun run
src/server.ts` on a free port with a throwaway `mkdtemp` store (never
:3850/:3849, never a live project), the board built through real HTTP
routes, the verb driven as a genuine `python-crucible.py` subprocess, its
TOON stdout decoded with `clients/toon.py`'s own decoder.

RED today: no client defines a `landings` subcommand at all (confirmed by
reading every client's argparse wiring and clients/_crucible_axi.py), so
the subprocess exits 2 with argparse's "invalid choice: 'landings'" and
`_run_landings` below fails at its own `returncode == 0` assertion, never
reaching the row comparison — the verb does not exist yet, not a fixture
bug.

Invocation:
    python3 -m unittest tests.client.test_landings_verb_shows_closed_plans_end_to_end
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
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (  # noqa: E402
    declare_and_require_board,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
PYTHON_CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

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
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _require_http_scheme(url):
    """Refuses anything but http(s) before it ever reaches urlopen — the
    scratch server's own base URL is always `http://127.0.0.1:<port>` (built
    by `_free_port`/setUpClass), never operator input, but this keeps
    `urlopen` itself provably scoped to the schemes this suite ever uses."""
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"refusing a non-http(s) URL scheme: {url!r}")
    return url


def _http(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310
        _require_http_scheme(base + path), data=data,
        method=method or ("POST" if data is not None else "GET"),
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
            with urllib.request.urlopen(_require_http_scheme(base + "/api/v2/health"), timeout=2):  # noqa: S310
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


class LandingsVerbShowsClosedPlansEndToEndTest(unittest.TestCase):
    """§S9/AC15 — the real `landings` verb (`clients/python-crucible.py`, a
    genuine subprocess) driven against an EPHEMERAL board holding one plan
    CLOSED WITH a merge commit, one plan CLOSED WITHOUT a merge commit, one
    ABORTED plan and one OPEN plan.

    Non-vacuity: the fixture board carries FOUR plans of three different
    outcomes (closed-with-merge, closed-without-merge, aborted) plus an
    open one still in flight; a `landings` that returned every plan
    regardless of status, or a client that dropped/miscounted the
    commit-less closed plan, fails the row-set/order/mergeCommit
    assertions below. The server's own `?status=closed` read is fetched
    over HTTP as the comparison target — never hardcoded — so the proof is
    against the real board, not the fixture's intent."""

    ORCHESTRATOR = "landings-e2e-orchestrator"
    CLOSED_MERGED_CR = "CR-T-LAND-E2E-MERGED"
    CLOSED_BARE_CR = "CR-T-LAND-E2E-BARE"
    ABORTED_CR = "CR-T-LAND-E2E-ABORTED"
    OPEN_CR = "CR-T-LAND-E2E-OPEN"
    WAVE = "1"
    MERGE_COMMIT = "e2e-landing-sha-1"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="landings-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the closed/aborted/open board is a property of the REAL "
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
    def _seal_cycle(cls, plan_id, cycle_id):
        for status in ("active", "done"):
            moved = _http(
                cls.base,
                f"/api/v2/projects/{cls.key}/plans/{plan_id}/cycles/{cycle_id}",
                {"status": status, "agentId": cls.ORCHESTRATOR}, method="PATCH")
            assert moved.get("ok"), f"cycle {status} failed: {moved!r}"

    @classmethod
    def _close_plan(cls, plan_id, commit):
        """Closes an already-sealed plan: WITH a merge commit when `commit`
        is not None (a `merge` key in the PATCH body), and WITHOUT one (no
        `merge` key at all) when `commit` is None — the exact
        `seedClosedPlan` idiom tests/release-provenance.test.ts uses for
        its own commit-less `UNPLACEABLE_CR` fixture."""
        body: dict = {"status": "closed", "agentId": cls.ORCHESTRATOR}
        if commit is not None:
            body["merge"] = {"commit": commit}
        closed = _http(cls.base, f"/api/v2/projects/{cls.key}/plans/{plan_id}",
                       body, method="PATCH")
        assert closed.get("ok"), f"closing plan {plan_id} failed: {closed!r}"

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "landings-e2e"})
        cls.key = project["project"]["key"]
        _register(cls.base, cls.key, cls.ORCHESTRATOR, "ORCHESTRATOR")

        merged_filed = cls._file_plan(cls.CLOSED_MERGED_CR)
        cls._seal_cycle(merged_filed["planId"], merged_filed["cycles"][0]["id"])
        cls._close_plan(merged_filed["planId"], cls.MERGE_COMMIT)

        bare_filed = cls._file_plan(cls.CLOSED_BARE_CR)
        cls._seal_cycle(bare_filed["planId"], bare_filed["cycles"][0]["id"])
        cls._close_plan(bare_filed["planId"], None)

        aborted_plan_id = cls._file_plan(cls.ABORTED_CR)["planId"]
        aborted = _http(
            cls.base, f"/api/v2/projects/{cls.key}/plans/{aborted_plan_id}/abort",
            {"userApproved": True, "agentId": cls.ORCHESTRATOR,
             # CR-CRU-165 S2b -- an abort now requires a recorded reason,
             # cause and spec reference; this fixture's abort is not the
             # subject under test, so it simply supplies them to keep
             # succeeding under the new server contract.
             "reason": "fixture: retiring this plan to exercise the aborted/closed/open split",
             "cause": "gap-analysis", "specRef": "fixture §1"})
        assert aborted.get("ok"), f"aborting the plan failed: {aborted!r}"

        cls._file_plan(cls.OPEN_CR)  # stays open — never activated/closed

        # The server's OWN closed-plans read, over HTTP — the comparison
        # target for the client subprocess below, never a hardcoded guess.
        cls.server_closed = _http(
            cls.base, f"/api/v2/projects/{cls.key}/plans?status=closed")
        server_closed_crs = sorted(
            p.get("cr") for p in cls.server_closed.get("plans", []))
        assert server_closed_crs == sorted(
            [cls.CLOSED_MERGED_CR, cls.CLOSED_BARE_CR]), (
            f"fixture sanity: expected exactly the two closed CRs on the "
            f"server's own ?status=closed read, got {cls.server_closed!r}")

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(TOON_PATH, "landings_e2e_toon")

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

    def _expected_rows(self):
        """The two closed plans, IN THE SERVER'S OWN ORDER, each reduced to
        {cr, mergeCommit} \u2014 mergeCommit is the commit the plan RECORDED
        (`merge.commit`, per the spec's own wording), read directly off the
        server's response rather than via the derived `commitBoundary` field
        (which happens to carry the same sha today, but is not what the spec
        defines `mergeCommit` as). The comparison target the client's rows
        are checked against, built from the SAME server response used for
        fixture sanity above, never a second hardcoded guess."""
        rows = []
        for plan in self.server_closed.get("plans", []):
            merge = plan.get("merge") or {}
            rows.append({"cr": plan.get("cr"),
                         "mergeCommit": merge.get("commit")})
        return rows

    def _run_landings(self, extra_args=()):
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        run = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "landings",
             "--project-dir", self.project_dir, *extra_args],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        self.assertEqual(
            run.returncode, 0,
            f"the `landings` verb must succeed against the ephemeral board; "
            f"exit={run.returncode} stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r} (RED: the verb is not "
            f"wired into argparse yet)")
        return run.stdout

    def test_toon_landings_rows_equal_the_servers_own_closed_plans_read_with_merge_commits(self):
        stdout = self._run_landings()
        decoded = self.toon.decode(stdout)
        self.assertIn(
            "axi", decoded,
            f"`landings` must answer with a TOON-AXI envelope; got "
            f"stdout={stdout!r}")
        axi = decoded["axi"]

        rows = axi.get("landings")
        self.assertIsInstance(
            rows, list,
            f"the `landings` field must decode as a list of rows; got "
            f"{rows!r} from stdout={stdout!r}")
        expected = self._expected_rows()
        self.assertEqual(
            rows, expected,
            f"landings rows must equal EXACTLY the server's own "
            f"?status=closed read (reduced to cr/mergeCommit, in the "
            f"server's order) — the aborted and open plans this board "
            f"also holds must never appear; got {rows!r} expected {expected!r}")
        merged_row = next((r for r in rows if r.get("cr") == self.CLOSED_MERGED_CR), None)
        assert merged_row is not None, f"got rows={rows!r}"
        self.assertEqual(
            merged_row.get("mergeCommit"), self.MERGE_COMMIT,
            f"the merged CR's row must carry its real merge commit; got "
            f"{merged_row!r}")
        bare_row = next((r for r in rows if r.get("cr") == self.CLOSED_BARE_CR), None)
        assert bare_row is not None, f"got rows={rows!r}"
        self.assertIsNone(
            bare_row.get("mergeCommit"),
            f"the commit-less CR's row must carry mergeCommit=None; got "
            f"{bare_row!r}")

    def test_json_format_landings_rows_equal_the_servers_own_closed_plans_read_with_merge_commits(self):
        stdout = self._run_landings(extra_args=("--format", "json"))
        parsed = json.loads(stdout)
        self.assertIsInstance(
            parsed, dict,
            f"--format json must write exactly one JSON object; got "
            f"stdout={stdout!r}")
        rows = parsed.get("landings")
        expected = self._expected_rows()
        self.assertEqual(
            rows, expected,
            f"the parsed object's `landings` must equal EXACTLY the "
            f"server's own ?status=closed read; got {rows!r} expected "
            f"{expected!r}")


if __name__ == "__main__":
    unittest.main()
