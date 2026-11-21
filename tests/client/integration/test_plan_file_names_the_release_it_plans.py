"""CR-CRU-121 §S2 (fleet half) — `plan-file` with `--release` registers the CR
on the board's queue, read back through a client.

The feature: a `plan-file` carrying a `release` performs the queue write
`cr-plan` performs, atomically with the plan file, and the client's own
`queue` verb then shows the CR registered. No fake can prove it: the
registration is a side effect of the store's own plan-file transaction, seen
only when the board's queue is read back, so a scripted board would only
answer with the row the test wrote into it.

The route half lives in `tests/integration/plans.test.ts`. The printed help,
the one shared declaration site and the wire, which need no board, are
`test_plan_file_names_the_release_it_plans_without_a_board`. The board here
is `RealBoard` (`tests/client/real_board.py`): a server built from this
repo's own source, on a free port with a mkdtemp DB — never the live
instance, never the shared project.

ESCALATION (recorded, not guessed — see this file's report):

  E2. §S2's end-to-end criterion says the registration is confirmed "via a
      follow-up `queue` call". The `queue` verb's row projection
      (`_crucible_axi.build_queue_rows`) emits `cr`/`wave`/`status`/`planId`
      ONLY — it drops `release`, so no `queue` envelope can state which
      release a CR was registered into. The end-to-end below therefore takes
      the registration FACT from the client's own `queue` envelope (the row,
      its wave, its derived status and its plan link) and the RELEASE from the
      board's own `GET …/queue` in the same test. Adding `release` to
      `build_queue_rows` is a production-client change §S2 does not authorise,
      so it is escalated rather than assumed.

Invocation:
    python3 -m unittest tests.client.integration.test_plan_file_names_the_release_it_plans
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import (
    declare_and_require_board,
)
from tests.client.plan_file_names_the_release_it_plans_helpers import (
    CLIENT_FILES,
    CLIENTS_DIR,
    ENV_KEYS,
    REPO_ROOT,
    VERB,
    _http,
    _load_module_by_path,
)
from tests.client.real_board import RealBoard

RELEASE_FLAG = "--release"

# The label under test.
RELEASE_LABEL = "0.2.0"

# CR-CRU-118 §S4 — a proposal declares the date it aims at. Nothing here is
# ABOUT that date; the end-to-end needs a live proposal to exist at all.
FIXTURE_TARGET_AT = 1_788_220_800  # 2026-09-01T00:00:00Z


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — a client files a plan, and the board shows the CR registered
# ═══════════════════════════════════════════════════════════════════════════


class PlanFileRegistersTheCrOnTheBoardTest(unittest.TestCase):
    """§S2's end-to-end criterion — the python client drives `plan-file` with a
    release against a REAL board, and the CR comes back REGISTERED.

    The registration is read back through the client's own `queue` verb (the
    criterion's "follow-up queue call") and the release through the board's own
    `GET …/queue` in the same test — see ESCALATION E2: the `queue` envelope's
    row projection drops `release`, so no client call can state it today.

    The unregistered sibling in the same test is what proves the row came from
    the DECLARED release and not from filing a plan at all."""

    ORCHESTRATOR = "plan-file-release-e2e-orchestrator"
    WITH_RELEASE = "CR-121-E2E-DECLARED"
    WITHOUT_RELEASE = "CR-121-E2E-SILENT"
    WAVE = "6"
    TITLE = "filing a plan registers its release"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="plan-file-release-e2e-")
        cls._board = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the queue write is a property of the real store: without "
                "`bun` there is no server to hold it. A missing toolchain, "
                "not a passing assertion.")
        cls._board = RealBoard(bun, "plan-file-release-e2e")
        cls.base = cls._board.base
        cls.key = cls._board.key
        try:
            cls._boot()
        except BaseException:
            # A board booted and then abandoned by a FAILING setUpClass is
            # never torn down (`tearDownClass` does not run when `setUpClass`
            # raises), and an orphaned server holds its port for as long as it
            # lives. Stop it on the way out, whatever went wrong.
            cls._stop_server()
            raise

    @classmethod
    def _boot(cls):
        registered = _http(cls.base, "/api/v2/agents/register",
                           {"projectKey": cls.key, "agentId": cls.ORCHESTRATOR,
                            "role": "ORCHESTRATOR"})
        assert registered.get("ok"), f"orchestrator registration failed: {registered!r}"
        proposed = _http(cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
                         {"agentId": cls.ORCHESTRATOR, "label": RELEASE_LABEL,
                          "targetAt": FIXTURE_TARGET_AT})
        assert proposed.get("ok"), f"release proposal failed: {proposed!r}"

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(CLIENTS_DIR / "toon.py",
                                        "plan_file_release_e2e_toon")

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        """Stop the scratch board, from teardown OR from a setUpClass that
        failed after booting it. Idempotent, so both callers may run."""
        board = getattr(cls, "_board", None)
        if board is None:
            return
        cls._board = None
        board.close()

    def _client(self, *argv):
        # CR-CRU-139 §S2 — the scratch board is declared in the fixture's own
        # project file, and the interlock refuses the spawn unless the client
        # would really resolve it: these verbs WRITE, and a drive that merely
        # stopped steering would write to the shipped default instead.
        declare_and_require_board(self.project_dir, self.base,
                                  "python-crucible.py")
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        return subprocess.run(
            [sys.executable, str(CLIENT_FILES["python"])] + list(argv),
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def _file_plan(self, cr, *extra):
        return self._client(
            VERB, "--cr", cr, "--title", self.TITLE, "--wave", self.WAVE,
            # CR-CRU-127 §S5 — a filed cycle declares its kind, so the e2e
            # fixture declares one. (The label reads `red-green` too; it is
            # this suite's original fixture label, left alone.)
            "--cycle", "red-green", "--cycle-kind", "red-green",
            "--agent", self.ORCHESTRATOR,
            "--project-dir", self.project_dir, *extra)

    def _queue_rows_through_the_client(self):
        run = self._client("queue", "--project-dir", self.project_dir)
        self.assertEqual(
            run.returncode, 0,
            f"the follow-up `queue` read must succeed; exit={run.returncode} "
            f"stdout={run.stdout.strip()[:400]!r} stderr={run.stderr.strip()[:400]!r}")
        decoded = self.toon.decode(run.stdout)
        self.assertIn(
            "axi", decoded,
            f"`queue` must answer with a TOON-AXI envelope; got "
            f"stdout={run.stdout!r}")
        return {row.get("cr"): row for row in decoded["axi"].get("queue") or []}

    def _board_entries(self):
        body = _http(self.base, f"/api/v2/projects/{self.key}/queue")
        return {entry.get("cr"): entry for entry in body.get("entries") or []}

    def test_a_plan_filed_with_a_release_shows_the_cr_registered_on_the_board(self):
        declared = self._file_plan(self.WITH_RELEASE, RELEASE_FLAG, RELEASE_LABEL)
        self.assertEqual(
            declared.returncode, 0,
            f"the client must file a plan declaring release {RELEASE_LABEL!r}; "
            f"exit={declared.returncode} stdout={declared.stdout.strip()[:600]!r} "
            f"stderr={declared.stderr.strip()[:600]!r}")

        # The sibling that declares NO release — the control that proves the
        # registration below came from the DECLARATION and not from filing.
        silent = self._file_plan(self.WITHOUT_RELEASE)
        self.assertEqual(
            silent.returncode, 0,
            f"a release-less plan-file must still succeed (the backward-"
            f"compatibility constraint); exit={silent.returncode} "
            f"stderr={silent.stderr.strip()[:600]!r}")

        rows = self._queue_rows_through_the_client()
        self.assertIn(
            self.WITH_RELEASE, rows,
            f"the follow-up `queue` call must show the CR the plan declared a "
            f"release for — invisible here is invisible on every roadmap "
            f"surface, which is the whole defect; got {rows!r}")
        self.assertNotIn(
            self.WITHOUT_RELEASE, rows,
            f"a plan that declared NO release registers nothing: a row here "
            f"would mean the route registers on every file, not on the "
            f"declaration; got {rows!r}")

        registered = rows[self.WITH_RELEASE]
        self.assertEqual(
            (registered.get("wave"), registered.get("status")),
            (self.WAVE, "IN_PROGRESS"),
            f"the registered row carries the wave the caller declared and the "
            f"in-flight status its open plan confers; got {registered!r}")
        self.assertIsNotNone(
            registered.get("planId"),
            f"the row is linked to the plan the SAME call filed — a "
            f"registration that points at no plan is a second write that "
            f"merely looks like this one; got {registered!r}")

        # ESCALATION E2 — the release itself, from the board's own read: the
        # client's `queue` row projection does not carry it.
        entries = self._board_entries()
        self.assertEqual(
            (entries.get(self.WITH_RELEASE) or {}).get("release"), RELEASE_LABEL,
            f"the CR must be registered INTO the release the caller declared, "
            f"verbatim; got {entries!r}")
        self.assertEqual(
            (entries.get(self.WITH_RELEASE) or {}).get("title"), self.TITLE,
            f"the title the plan was filed with is the title the roadmap "
            f"shows; got {entries!r}")
        self.assertNotIn(
            self.WITHOUT_RELEASE, entries,
            f"the board agrees with the client read: the release-less plan "
            f"registered nothing; got {entries!r}")


if __name__ == "__main__":
    unittest.main()
