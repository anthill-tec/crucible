"""CR-CRU-147 §S3 RED tests — queue rows carry title and a nullable lifecycle
column (Ruling 3, gap-analysis box: "queue rows use a null column, not an
omitted key").

Today `build_queue_rows` (clients/_crucible_axi.py) emits ONLY
`{cr, wave, status, planId}` per row. §S3's two ACs require every row to gain
two more keys:

  - `title`  — the entry's title, verbatim (null when the entry has none,
    same idiom `planId` already uses).
  - `lifecycle` — the DEAD entry's lifecycle STATE string (`VOID` or
    `SUPERSEDED`), never the whole lifecycle object and never the reason or
    successor folded in; null for a live entry (no `lifecycle` key at all).
    Never an invented state.

The existing four keys keep their names, order and values (§S3's second AC):
this is an ADDITIVE change to the row shape, not a replacement, and the Risk
box is explicit that `status` stays the DERIVED value even for a dead row —
lifecycle is a second axis, never folded into it.

Two test shapes, per the RED-agent brief:

1. `BuildQueueRowsCarriesTitleAndLifecycleTest` — a PURE unit suite driving
   `build_queue_rows` directly with hand-built entries (live / VOID /
   SUPERSEDED), asserting the new keys' values, the untouched old four, key
   ORDER, and that mixed entries still produce a uniform key set.

2. `QueueVerbCarriesTitleAndLifecycleEndToEndTest` — the real `queue` verb
   (python-crucible.py, a genuine subprocess) driven against an ephemeral
   board (free port, scratch `bun run src/server.ts`, mkdtemp DB — never the
   live instance) holding one live CR, one voided CR and one superseded CR.
   The verb's TOON stdout is decoded with `clients/toon.py`'s OWN decoder
   (never a third-party one), and the decoded table's header (= every row's
   shared key set), per-row title/lifecycle, and the dead rows' still-DERIVED
   `status` are all asserted.

RED today (measured against `build_queue_rows` in
`clients/_crucible_axi.py`): every row `build_queue_rows` returns carries ONLY `cr`/`wave`/`status`/`planId` —
`row["title"]`/`row["lifecycle"]` raise `KeyError` on every row, in every
test below, including through the real `queue` verb's own decoded output.

Invocation:
    python3 -m unittest tests.client.test_queue_rows_carry_title_and_lifecycle
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
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
PYTHON_CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

# The env keys the fleet's `context` block reads — cleared before every
# subprocess drive so an ambient orchestrator session can never colour the
# envelope under test (the same idiom `test_plan_file_names_the_release_it_
# plans.py` uses).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom (mirrors `_load_module_by_path` in
    `test_plan_file_names_the_release_it_plans.py`)."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ═══════════════════════════════════════════════════════════════════════════
# §S3 — PURE unit tests on `build_queue_rows`
# ═══════════════════════════════════════════════════════════════════════════


class BuildQueueRowsCarriesTitleAndLifecycleTest(unittest.TestCase):
    """§S3/Ruling 3 — `build_queue_rows` gains `title` and `lifecycle` on
    EVERY row: `title` is the entry's own title (null when absent, the same
    idiom `planId` already uses for "no plan"), `lifecycle` is the dead
    entry's lifecycle STATE string (`VOID`/`SUPERSEDED`), null for a live
    entry — never an invented state. The existing four keys
    (`cr, wave, status, planId`) keep their names, order and values, and the
    two new keys land after them so every row stays a uniform TOON table
    (CR-081).

    Every assertion below reads `row["title"]`/`row["lifecycle"]` by
    subscript, deliberately NOT `.get()`, so a stub that forgot either key
    fails LOUDLY (`KeyError`) instead of silently reading None and passing
    the null-column assertions for the wrong reason."""

    def setUp(self):
        self.axi = _load_module_by_path(
            AXI_MODULE_PATH, "cr147_c2_build_queue_rows_pure")

    def _live_entry(self, cr="CR-LIVE-1", wave="2", status="PENDING",
                     plan_id=None, title="a live cr"):
        entry = {"cr": cr, "wave": wave, "status": status}  # type: dict
        if plan_id is not None:
            entry["planId"] = plan_id
        if title is not None:
            entry["title"] = title
        return entry

    def _dead_entry(self, cr, state, title="a dead cr", **extra_lifecycle):
        entry = self._live_entry(cr=cr, title=title)
        entry["lifecycle"] = {"state": state, **extra_lifecycle}
        return entry

    def test_row_carries_the_entrys_title_verbatim(self):
        entry = self._live_entry(title="fix the frobnicator")
        rows = self.axi.build_queue_rows([entry])

        self.assertEqual(
            rows[0]["title"], "fix the frobnicator",
            f"row must carry the entry's own title verbatim; got {rows[0]!r}")

    def test_row_title_is_null_when_the_entry_has_no_title(self):
        entry = self._live_entry(title=None)  # type: ignore[arg-type]
        self.assertNotIn("title", entry, "fixture bug: this entry must "
                                          "carry no title key at all")
        rows = self.axi.build_queue_rows([entry])

        self.assertIn(
            "title", rows[0],
            f"a title-less entry's row must still carry the `title` KEY "
            f"(a null COLUMN, per Ruling 3 — never an omitted key); got "
            f"{rows[0]!r}")
        self.assertIsNone(
            rows[0]["title"],
            f"a title-less entry's row must carry title=None; got "
            f"{rows[0]!r}")

    def test_row_lifecycle_is_the_state_string_for_a_void_entry(self):
        entry = self._dead_entry("CR-VOID-1", "VOID", reason="obsolete")
        rows = self.axi.build_queue_rows([entry])

        self.assertEqual(
            rows[0]["lifecycle"], "VOID",
            f"a VOID entry's row must carry lifecycle='VOID' exactly (the "
            f"STATE string, never the whole lifecycle object or its "
            f"reason); got {rows[0]!r}")

    def test_row_lifecycle_is_the_state_string_for_a_superseded_entry(self):
        entry = self._dead_entry("CR-SUP-1", "SUPERSEDED", by="CR-SUP-2")
        rows = self.axi.build_queue_rows([entry])

        self.assertEqual(
            rows[0]["lifecycle"], "SUPERSEDED",
            f"a SUPERSEDED entry's row must carry lifecycle='SUPERSEDED' "
            f"exactly — the successor ('by') must never fold into this "
            f"cell; got {rows[0]!r}")

    def test_row_lifecycle_is_exactly_none_for_a_live_entry_with_no_lifecycle_key(self):
        entry = self._live_entry()
        self.assertNotIn("lifecycle", entry, "fixture bug: this entry must "
                                              "carry no lifecycle key at all")
        rows = self.axi.build_queue_rows([entry])

        self.assertIn(
            "lifecycle", rows[0],
            f"a live entry's row must still carry the `lifecycle` KEY (a "
            f"null column, per Ruling 3); got {rows[0]!r}")
        self.assertIsNone(
            rows[0]["lifecycle"],
            f"a live entry (no `lifecycle` key at all) must produce "
            f"lifecycle=None on its row — never an invented state such as "
            f"'LIVE' or the derived status; got {rows[0]!r}")

    def test_existing_four_keys_keep_their_names_order_and_values(self):
        entry = self._dead_entry("CR-VOID-2", "VOID")
        entry["wave"] = "7"
        entry["status"] = "PENDING"
        entry.pop("planId", None)
        rows = self.axi.build_queue_rows([entry])
        row = rows[0]

        first_four = list(row.keys())[:4]
        self.assertEqual(
            first_four, ["cr", "wave", "status", "planId"],
            f"the first four keys must still be cr, wave, status, planId, "
            f"in that order; got {list(row.keys())!r}")
        self.assertEqual(
            (row["cr"], row["wave"], row["status"], row["planId"]),
            ("CR-VOID-2", "7", "PENDING", None),
            f"the existing four keys must keep their TODAY values, "
            f"untouched by the two new columns; got {row!r}")
        remaining = list(row.keys())[4:]
        self.assertEqual(
            remaining, ["title", "lifecycle", "release", "seq", "points",
                        "dependsOn"],
            f"title and lifecycle must land AFTER the existing four keys, "
            f"in that order (title then lifecycle); got "
            f"{list(row.keys())!r}")

    def test_rows_stay_a_uniform_table_across_live_void_and_superseded_entries(self):
        entries = [
            self._live_entry(cr="CR-LIVE-2"),
            self._dead_entry("CR-VOID-3", "VOID"),
            self._dead_entry("CR-SUP-2", "SUPERSEDED", by="CR-SUP-3"),
        ]
        rows = self.axi.build_queue_rows(entries)

        self.assertEqual(len(rows), 3, f"expected exactly 3 rows, got "
                                       f"{rows!r}")
        key_sets = [frozenset(row.keys()) for row in rows]
        self.assertEqual(
            len(set(key_sets)), 1,
            f"every row must carry the IDENTICAL key set (a uniform TOON "
            f"table, CR-081) whether the entry is live, VOID or "
            f"SUPERSEDED; got {[sorted(ks) for ks in key_sets]!r}")
        self.assertEqual(
            key_sets[0],
            frozenset({"cr", "wave", "status", "planId", "title",
                      "lifecycle", "release", "seq", "points",
                      "dependsOn"}),
            f"the uniform key set must be exactly cr/wave/status/planId/"
            f"title/lifecycle; got {sorted(key_sets[0])!r}")

        by_cr = {row["cr"]: row["lifecycle"] for row in rows}
        self.assertEqual(
            by_cr,
            {"CR-LIVE-2": None, "CR-VOID-3": "VOID",
             "CR-SUP-2": "SUPERSEDED"},
            f"lifecycle must read null/VOID/SUPERSEDED per entry, never "
            f"mixed up across rows; got {by_cr!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S3 — the `queue` verb end-to-end, wired through a real ephemeral board
# ═══════════════════════════════════════════════════════════════════════════

RELEASE_LABEL = "9.9.9"
# CR-CRU-118 §S4 — a proposal declares the date it aims at; nothing here is
# ABOUT that date, the fixture just needs a plannable target.
FIXTURE_TARGET_AT = 1_788_220_800  # 2026-09-01T00:00:00Z


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
        base + path, data=data, method=method or ("POST" if data else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
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
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")


class QueueVerbCarriesTitleAndLifecycleEndToEndTest(unittest.TestCase):
    """§S3 end-to-end (both ACs, "wire the call path") — the REAL `queue`
    verb (`clients/python-crucible.py`, a genuine subprocess, never a stub)
    driven against an EPHEMERAL board (free port, scratch
    `bun run src/server.ts`, mkdtemp DB — never :3850/:3849, never a live
    project) holding one live CR, one VOID CR and one SUPERSEDED CR. The
    verb's TOON stdout is decoded with `clients/toon.py`'s OWN decoder (never
    a third-party one), and the decoded table's header — every row's shared
    key set — plus each row's title/lifecycle and the dead rows' still-
    DERIVED `status` are asserted.

    RED today: `cmd_queue` -> `build_queue_rows` emits only
    `cr,wave,status,planId` per row, so the decoded rows' shared key set is
    `{cr,wave,status,planId}` — missing `title`/`lifecycle` entirely — and
    every row-level `row.get("title")`/`row.get("lifecycle")` assertion below
    fails against real board data, not a hand-built fixture."""

    ORCHESTRATOR = "cr147-c2-queue-e2e-orchestrator"
    LIVE_CR = "CR-Q147-LIVE"
    VOID_CR = "CR-Q147-VOID"
    SUPERSEDED_CR = "CR-Q147-SUPERSEDED"
    SUCCESSOR_CR = "CR-Q147-SUCCESSOR"
    WAVE = "1"
    LIVE_TITLE = "the live cr keeps working"
    VOID_TITLE = "the voided cr is abandoned"
    SUPERSEDED_TITLE = "the superseded cr moved on"
    VOID_REASON = "duplicated by another effort"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="cr147-c2-queue-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the queue row's title/lifecycle columns are a property of "
                "the REAL board's stored entries: without `bun` there is no "
                "server to hold them. A missing toolchain, not a passing "
                "assertion.")
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
    def _boot(cls):
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects",
                        {"name": "cr147-c2-queue-e2e"})
        cls.key = project["project"]["key"]
        registered = _http(
            cls.base, "/api/v2/agents/register",
            {"projectKey": cls.key, "agentId": cls.ORCHESTRATOR,
             "role": "ORCHESTRATOR"})
        assert registered.get("ok"), (
            f"orchestrator registration failed: {registered!r}")
        proposed = _http(
            cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
            {"agentId": cls.ORCHESTRATOR, "label": RELEASE_LABEL,
             "targetAt": FIXTURE_TARGET_AT})
        assert proposed.get("ok"), f"release proposal failed: {proposed!r}"

        for cr, title in ((cls.LIVE_CR, cls.LIVE_TITLE),
                          (cls.VOID_CR, cls.VOID_TITLE),
                          (cls.SUPERSEDED_CR, cls.SUPERSEDED_TITLE)):
            planned = _http(
                cls.base, f"/api/v2/projects/{cls.key}/queue/plan",
                {"cr": cr, "title": title, "release": RELEASE_LABEL,
                 "wave": cls.WAVE, "agentId": cls.ORCHESTRATOR})
            assert planned.get("ok"), f"cr-plan failed for {cr}: {planned!r}"

        voided = _http(
            cls.base, f"/api/v2/projects/{cls.key}/queue/{cls.VOID_CR}/void",
            {"reason": cls.VOID_REASON, "agentId": cls.ORCHESTRATOR})
        assert voided.get("ok"), f"cr-void failed: {voided!r}"

        superseded = _http(
            cls.base,
            f"/api/v2/projects/{cls.key}/queue/{cls.SUPERSEDED_CR}/supersede",
            {"by": cls.SUCCESSOR_CR, "agentId": cls.ORCHESTRATOR})
        assert superseded.get("ok"), f"cr-supersede failed: {superseded!r}"

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(
            TOON_PATH, "cr147_c2_queue_e2e_toon")

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

    def _run_queue_verb(self):
        # CR-CRU-139 §S2 — the board is declared in the fixture's OWN project
        # file, and the interlock refuses the spawn unless the client would
        # really resolve it — this read must land on the SCRATCH board, never
        # the shipped default (which on this machine is production).
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        run = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT_PATH), "queue",
             "--project-dir", self.project_dir],
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)
        self.assertEqual(
            run.returncode, 0,
            f"the `queue` verb must succeed against the ephemeral board; "
            f"exit={run.returncode} stdout={run.stdout.strip()[:600]!r} "
            f"stderr={run.stderr.strip()[:600]!r}")
        decoded = self.toon.decode(run.stdout)
        self.assertIn(
            "axi", decoded,
            f"`queue` must answer with a TOON-AXI envelope; got "
            f"stdout={run.stdout!r}")
        rows = decoded["axi"].get("queue")
        self.assertIsInstance(
            rows, list,
            f"the `queue` field must decode as a list of rows; got "
            f"{rows!r} from stdout={run.stdout!r}")
        return rows

    def test_queue_verb_header_and_rows_carry_title_and_lifecycle_end_to_end(self):
        rows = self._run_queue_verb()
        by_cr = {row.get("cr"): row for row in rows}

        for cr in (self.LIVE_CR, self.VOID_CR, self.SUPERSEDED_CR):
            self.assertIn(
                cr, by_cr,
                f"the ephemeral board's {cr} must appear in the decoded "
                f"`queue` rows; got crs={sorted(k for k in by_cr if k)!r}")

        # §S3/AC1 — the table's header IS every row's shared key set (a
        # uniform TOON table round-trips that way); a table with two
        # different key sets across rows never decodes as one construct.
        key_sets = {frozenset(row.keys()) for row in rows}
        self.assertEqual(
            len(key_sets), 1,
            f"the decoded `queue` rows must round-trip as a UNIFORM TOON "
            f"table — every row the same key set; got "
            f"{[sorted(ks) for ks in key_sets]!r}")
        self.assertEqual(
            key_sets.pop(),
            frozenset({"cr", "wave", "status", "planId", "title",
                      "lifecycle"}),
            f"the `queue` table header must be exactly "
            f"cr,wave,status,planId,title,lifecycle; got rows={rows!r}")

        live_row = by_cr[self.LIVE_CR]
        void_row = by_cr[self.VOID_CR]
        superseded_row = by_cr[self.SUPERSEDED_CR]

        # §S3/AC1 — title, verbatim per row.
        self.assertEqual(
            live_row.get("title"), self.LIVE_TITLE,
            f"the live cr's row must carry its board title verbatim; got "
            f"{live_row!r}")
        self.assertEqual(
            void_row.get("title"), self.VOID_TITLE,
            f"the voided cr's row must still carry its title (the record "
            f"survives — §S1); got {void_row!r}")
        self.assertEqual(
            superseded_row.get("title"), self.SUPERSEDED_TITLE,
            f"the superseded cr's row must still carry its title; got "
            f"{superseded_row!r}")

        # §S3/AC1/Ruling 3 — lifecycle: null for the live row, the exact
        # state for the dead rows, never an invented value.
        self.assertIsNone(
            live_row.get("lifecycle"),
            f"the live cr's row must carry lifecycle=None; got "
            f"{live_row!r}")
        self.assertEqual(
            void_row.get("lifecycle"), "VOID",
            f"the voided cr's row must carry lifecycle='VOID'; got "
            f"{void_row!r}")
        self.assertEqual(
            superseded_row.get("lifecycle"), "SUPERSEDED",
            f"the superseded cr's row must carry lifecycle='SUPERSEDED' "
            f"(the successor never folds into this cell); got "
            f"{superseded_row!r}")

        # §S3/AC2 + Risk box — the dead rows' `status` field stays the
        # DERIVED value; lifecycle is a second axis and must never replace
        # it. Neither dead cr has an open plan, so the derived status is
        # PENDING, same as the live cr's.
        self.assertEqual(
            void_row.get("status"), "PENDING",
            f"a VOID cr's `status` FIELD must stay the DERIVED value "
            f"(PENDING, no open plan) — lifecycle must never replace it; "
            f"got {void_row!r}")
        self.assertEqual(
            superseded_row.get("status"), "PENDING",
            f"a SUPERSEDED cr's `status` FIELD must stay the DERIVED value "
            f"(PENDING, no open plan) — lifecycle must never replace it; "
            f"got {superseded_row!r}")

        # §S3/AC2 — the existing keys keep their today values, untouched.
        self.assertEqual(
            (live_row.get("wave"), live_row.get("status")),
            (self.WAVE, "PENDING"),
            f"the live row's existing `wave`/`status` fields must be "
            f"untouched by the new columns; got {live_row!r}")


if __name__ == "__main__":
    unittest.main()
