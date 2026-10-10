"""RED test — §S4/AC8: `project-meta`'s wiring end to end against a real,
ephemeral board — no stubbed transport.

A registered ORCHESTRATOR writes through the real `python-crucible.py
project-meta` subprocess (a `set` of two keys, then an `unset` of one, then
a THIRD identical write to prove `changed: false` on a no-op). A second,
independent `project-meta` read — decoded as TOON and re-run with
`--format json` — returns the same map. `GET /api/v2/projects/<key>/metadata`
and the project's own `metadata` field on `GET /api/v2/projects`, both read
directly over HTTP, carry the identical map. A `report`-role caller's write
is refused (ok:false, non-zero exit, the server's `help[]`), and the map is
proved unchanged afterwards against the real (non-empty) map, not a vacuous
`{}`.

RED-agent note: the server-side route (§S1-§S3) and the shared client verb
(§S4/AC5-AC7) already landed on this branch — these tests are wiring proofs
and are expected to PASS on first run. Non-vacuity: the fixture asserts its
own sanity (the map really holds `PROJECT_TOKEN` after the writes, and
`PROJECT_STACKS` is really gone after the unset) so a stub client, a
transport that silently drops the write, or a server that ignores its own
role check would all be caught here rather than passing on an empty map by
accident.

Follows the `status` verb's own end-to-end idiom
(`test_status_verb_shows_open_plans_end_to_end.py`, itself following
`test_queue_rows_carry_title_and_lifecycle.py`): a scratch `bun run
src/server.ts` on a free port with a throwaway `mkdtemp` store (never
:3850/:3849, never a live project), the board built through real HTTP
routes, the verb driven as a genuine `python-crucible.py` subprocess, its
TOON stdout decoded with `clients/toon.py`'s own decoder.

Invocation:
    python3 -m unittest tests.client.test_project_meta_verb_wires_write_read_and_refusal_end_to_end
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
    request = urllib.request.Request(
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


class ProjectMetaVerbWiresWriteReadAndRefusalEndToEndTest(unittest.TestCase):
    """§S4/AC8 — the real `project-meta` verb (`clients/python-crucible.py`,
    a genuine subprocess) driven against an EPHEMERAL board: an ORCHESTRATOR
    writes, unsets, and repeats the unset (a no-op); a `report`-role write
    is refused. All writes below happen ONCE, in `setUpClass`/`_boot`, in
    the exact sequence the contract describes; the test methods only READ
    (over the client subprocess or direct HTTP) and assert, so they may run
    in any order without perturbing each other's fixtures."""

    ORCHESTRATOR = "project-meta-e2e-orchestrator"
    REPORTER = "project-meta-e2e-reporter"

    MAP_AFTER_FIRST_WRITE = {"PROJECT_TOKEN": "demo", "PROJECT_STACKS": "bun,python"}
    MAP_AFTER_UNSET = {"PROJECT_TOKEN": "demo"}

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="project-meta-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the metadata wiring is a property of the REAL store and "
                "the REAL server-side role check: without `bun` there is "
                "no server to hold either. A missing toolchain, not a "
                "passing assertion.")
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
    def _run_project_meta(cls, extra_args):
        """One `project-meta` subprocess drive, against the scratch board's
        own declared listener — never asserting on the outcome itself (both
        the successful orchestrator writes and the refused reporter write go
        through this one seam; callers decide what a given drive should
        prove)."""
        declare_and_require_board(cls.project_dir, cls.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        return subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "project-meta",
             "--project-dir", cls.project_dir, *extra_args],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "project-meta-e2e"})
        cls.key = project["project"]["key"]
        _register(cls.base, cls.key, cls.ORCHESTRATOR, "ORCHESTRATOR")
        _register(cls.base, cls.key, cls.REPORTER, "report")

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(TOON_PATH, "project_meta_e2e_toon")

        # Step 2 of the contract — an ORCHESTRATOR write: `set` two keys.
        cls.write1 = cls._run_project_meta(
            ["--set", "PROJECT_TOKEN=demo", "--set", "PROJECT_STACKS=bun,python",
             "--agent", cls.ORCHESTRATOR])
        assert cls.write1.returncode == 0, (
            f"the orchestrator's first metadata write must succeed against "
            f"the ephemeral board; exit={cls.write1.returncode} "
            f"stdout={cls.write1.stdout.strip()[:600]!r} "
            f"stderr={cls.write1.stderr.strip()[:600]!r}")

        # Step 3 — unset ONE key in a second write.
        cls.write2 = cls._run_project_meta(
            ["--unset", "PROJECT_STACKS", "--agent", cls.ORCHESTRATOR])
        assert cls.write2.returncode == 0, (
            f"the orchestrator's unset write must succeed; "
            f"exit={cls.write2.returncode} "
            f"stdout={cls.write2.stdout.strip()[:600]!r} "
            f"stderr={cls.write2.stderr.strip()[:600]!r}")

        # Step 3 — a THIRD, identical write: the key is already gone, so
        # this is a no-op (`changed: false`).
        cls.write3 = cls._run_project_meta(
            ["--unset", "PROJECT_STACKS", "--agent", cls.ORCHESTRATOR])
        assert cls.write3.returncode == 0, (
            f"the third (identical, no-op) write must still succeed; "
            f"exit={cls.write3.returncode} "
            f"stdout={cls.write3.stdout.strip()[:600]!r} "
            f"stderr={cls.write3.stderr.strip()[:600]!r}")

        # Step 5 — a `report`-role caller's write must be refused, AFTER the
        # orchestrator's writes, so the "unchanged afterwards" comparison in
        # the dedicated test method is against the real, non-empty map this
        # fixture built above (never a vacuous `{}`). Not asserted on here —
        # the refusal itself is what a dedicated test method proves.
        cls.reporter_write_attempt = cls._run_project_meta(
            ["--set", "PROJECT_ACRONYM=SHOULDNOTWRITE", "--agent", cls.REPORTER])

        # Fixture sanity — the server's OWN metadata read, over HTTP, read
        # here so a later regression that left the map vacuous (`{}`) or
        # never actually persisted `PROJECT_TOKEN` fails at fixture setup
        # rather than silently passing a weakened assertion below.
        cls.server_metadata_after_writes = _http(
            cls.base, f"/api/v2/projects/{cls.key}/metadata")
        assert cls.server_metadata_after_writes.get("metadata") == cls.MAP_AFTER_UNSET, (
            f"fixture sanity: expected the board's own metadata to be "
            f"{cls.MAP_AFTER_UNSET!r} after the orchestrator's writes, got "
            f"{cls.server_metadata_after_writes!r}")

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

    def _decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"`project-meta` must answer with a TOON-AXI envelope; got "
            f"stdout={stdout_text!r}")
        return decoded["axi"]

    def test_first_write_sets_both_keys_and_reports_changed_true(self):
        axi = self._decode_toon_axi(self.write1.stdout)
        self.assertIs(
            axi.get("ok"), True,
            f"a successful orchestrator write must be ok:true; got {axi!r}")
        self.assertIs(
            axi.get("changed"), True,
            f"setting two previously-absent keys must report changed:true; "
            f"got {axi!r}")
        self.assertEqual(
            axi.get("metadata"), self.MAP_AFTER_FIRST_WRITE,
            f"the envelope's metadata must be exactly the map as written; "
            f"got {axi.get('metadata')!r}")

    def test_second_write_unsets_one_key_and_reports_changed_true(self):
        axi = self._decode_toon_axi(self.write2.stdout)
        self.assertIs(
            axi.get("ok"), True,
            f"the orchestrator's unset write must be ok:true; got {axi!r}")
        self.assertIs(
            axi.get("changed"), True,
            f"removing a key that was present must report changed:true; "
            f"got {axi!r}")
        self.assertEqual(
            axi.get("metadata"), self.MAP_AFTER_UNSET,
            f"PROJECT_STACKS must be gone and PROJECT_TOKEN untouched; got "
            f"{axi.get('metadata')!r}")

    def test_third_identical_write_reports_changed_false(self):
        axi = self._decode_toon_axi(self.write3.stdout)
        self.assertIs(
            axi.get("ok"), True,
            f"a no-op write is still a successful request (ok:true); got "
            f"{axi!r}")
        self.assertIs(
            axi.get("changed"), False,
            f"unsetting an already-absent key must report changed:false — "
            f"a stub that always reports changed:true would fail here; "
            f"got {axi!r}")
        self.assertEqual(
            axi.get("metadata"), self.MAP_AFTER_UNSET,
            f"a no-op write must leave the map exactly as it was; got "
            f"{axi.get('metadata')!r}")

    def test_toon_read_after_the_writes_returns_the_final_map(self):
        run = self._run_project_meta([])
        self.assertEqual(
            run.returncode, 0,
            f"a bare `project-meta` read must succeed against the "
            f"ephemeral board; exit={run.returncode} "
            f"stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        axi = self._decode_toon_axi(run.stdout)
        self.assertNotIn(
            "changed", axi,
            f"a READ envelope must carry no `changed` key; got {axi!r}")
        self.assertEqual(
            axi.get("metadata"), self.MAP_AFTER_UNSET,
            f"an INDEPENDENT second read must return exactly the map the "
            f"writes left behind — a client that only echoed its own "
            f"write's response (rather than issuing a fresh GET) would "
            f"still pass a same-process check, but this is a SEPARATE "
            f"subprocess; got {axi.get('metadata')!r}")

    def test_json_format_read_after_the_writes_returns_the_same_map(self):
        run = self._run_project_meta(["--format", "json"])
        self.assertEqual(
            run.returncode, 0,
            f"the `--format json` read must succeed against the ephemeral "
            f"board; exit={run.returncode} "
            f"stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        self.assertTrue(
            run.stdout.lstrip().startswith("{"),
            f"--format json must write a JSON object on stdout; got "
            f"{run.stdout!r}")
        parsed = json.loads(run.stdout)
        self.assertIsInstance(
            parsed, dict,
            f"the parsed JSON must be a single object; got {parsed!r}")
        self.assertEqual(
            parsed.get("metadata"), self.MAP_AFTER_UNSET,
            f"--format json must report the SAME map as the TOON read; "
            f"got {parsed.get('metadata')!r}")

    def test_http_metadata_route_and_projects_list_carry_the_written_map(self):
        metadata_resp = _http(
            self.base, f"/api/v2/projects/{self.key}/metadata")
        self.assertIs(
            metadata_resp.get("ok"), True,
            f"GET .../metadata must answer ok:true; got {metadata_resp!r}")
        self.assertEqual(
            metadata_resp.get("metadata"), self.MAP_AFTER_UNSET,
            f"GET .../metadata must carry exactly the map the client "
            f"wrote and read; got {metadata_resp.get('metadata')!r}")

        projects_resp = _http(self.base, "/api/v2/projects")
        self.assertIs(
            projects_resp.get("ok"), True,
            f"GET /api/v2/projects must answer ok:true; got {projects_resp!r}")
        project_row = next(
            (p for p in projects_resp.get("projects", []) if p.get("key") == self.key),
            None)
        self.assertIsNotNone(
            project_row,
            f"the scratch project must appear in GET /api/v2/projects; got "
            f"{projects_resp!r}")
        assert project_row is not None  # narrows for the static checker; proved above
        self.assertEqual(
            project_row.get("metadata"), self.MAP_AFTER_UNSET,
            f"the project record's own `metadata` field must equal the "
            f"same map — a project list that never joined metadata in "
            f"would leave this key absent or `{{}}`; got "
            f"{project_row.get('metadata')!r}")

    def test_report_role_write_is_refused_and_metadata_stays_unchanged(self):
        run = self.reporter_write_attempt
        self.assertNotEqual(
            run.returncode, 0,
            f"a `report`-role caller's write must exit non-zero; "
            f"stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        axi = self._decode_toon_axi(run.stdout)
        self.assertIs(
            axi.get("ok"), False,
            f"a `report`-role caller's write must be ok:false — the real "
            f"server-side role check reaching the client's envelope, not a "
            f"client-side guess; got {axi!r}")
        help_steps = axi.get("help")
        self.assertIsInstance(
            help_steps, list,
            f"the refusal must carry the server's own `help[]`; got "
            f"{axi!r}")
        self.assertGreater(
            len(help_steps), 0,
            f"the refusal's help[] must be non-empty; got {axi!r}")

        # The map after the refused write must equal the SAME, non-empty
        # map the orchestrator's writes left — proving the refusal both
        # wrote nothing AND that this is not a vacuous "unchanged {}" that
        # would pass even if metadata could never be written at all.
        metadata_resp = _http(
            self.base, f"/api/v2/projects/{self.key}/metadata")
        self.assertEqual(
            metadata_resp.get("metadata"), self.MAP_AFTER_UNSET,
            f"the reporter's refused write must leave the map exactly as "
            f"the orchestrator's writes left it; got "
            f"{metadata_resp.get('metadata')!r}")
        self.assertNotIn(
            "PROJECT_ACRONYM", metadata_resp.get("metadata", {}),
            f"the reporter's refused `set` must never have reached the "
            f"store; got {metadata_resp.get('metadata')!r}")


if __name__ == "__main__":
    unittest.main()
