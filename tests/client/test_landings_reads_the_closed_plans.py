# RED — §S9/AC13: `landings`, a new read-only verb in EACH of the five
# clients, issues EXACTLY ONE read, `GET …/plans?status=closed`, and returns
# one row per closed plan, IN THE SERVER'S ORDER, each `{cr, mergeCommit}`
# (`mergeCommit` is the commit the plan RECORDED — `merge.commit`, per the
# spec's own wording — or `null` for a plan closed WITHOUT a merge commit.
# Confirmed by reading `Store.toPlan`/`deriveCommitBoundary`, src/store.ts:
# a closed plan that recorded a merge commit carries BOTH `merge: {commit}`
# (the plan's own recorded field) AND the derived `commitBoundary:
# {mergeCommit, closedAt}` with the SAME sha (measured on the dev board,
# `GET …/plans?status=closed`); a plan closed WITHOUT one carries NEITHER
# key at all — never a `merge`/`commitBoundary` holding `null`). It takes
# `--format {toon,json}` exactly as §S8 defines it for `status` (one JSON
# object equal to the same invocation's `--format toon` `axi` object). A
# failed read degrades the same way `status` does: `ok:true`, `landings:
# []`, a `landings-unavailable` warning, exit 0.
#
# Spec: the "status shows the work in flight" change doc under
# docs/changes/, §S9,
# AC13. User ruling 2026-09-26 (option C, superseding an earlier
# `queue.mergeCommit` design this CR briefly RED-tested and then reverted):
# the release ceremony's landing-commit source is the CLOSED PLANS, read
# directly through this new verb — `queue` stays completely unchanged.
#
# RED today (confirmed by reading all five clients' argparse wiring and
# clients/_crucible_axi.py): no client defines a `landings` subcommand at
# all, so every drive below fails argparse's own subcommand dispatch with
# `SystemExit(2)` ("invalid choice: 'landings'") — never reaching `_get` —
# which is why every assertion after the exit-code check fails for the
# right reason (the verb does not exist yet), not a typo or a fixture bug.
#
# Harness: the exact `_FormatFlagTestBase`/`_run_main`/`install_project_limits`
# idiom from tests/client/test_status_speaks_json_to_programs.py (module
# loaded fresh per client, `.env` + limits installed in a tmpdir, `sys.argv`
# patched, `module.main()` driven for real) — extended here to CAPTURE the
# mocked `_get`'s call args (not just its return value), because AC13 also
# requires asserting the EXACT requested path, the one thing the JSON-format
# mixin in that sibling file never needed to check.
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import install_project_limits
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

REPO_ROOT = Path(__file__).resolve().parents[2]

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

PROJECT_KEY = "cr150-c9-landings"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched -> (code, stdout, stderr)."""
    full_argv = ["client"] + argv
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


# §S9/AC13 — a plan CLOSED WITH a merge commit: the server's `toPlan`
# (src/store.ts) carries BOTH the plan's own recorded `merge: {commit}` AND
# the derived `commitBoundary: {mergeCommit, closedAt}`, the SAME sha in
# both — measured on the dev board (`GET …/plans?status=closed`, a real
# closed plan). `mergeCommit` on the landings row is the commit the plan
# RECORDED (`merge.commit`, per the spec's wording), so this fixture must
# carry `merge` for a GREEN that reads it correctly to pass, and carries
# `commitBoundary` too so a GREEN cannot be told apart from one that
# (wrongly) reads the derived field instead.
CLOSED_WITH_MERGE = {
    "planId": "plan-c9-merged", "cr": "CR-T-LAND-MERGED", "wave": "1",
    "status": "closed", "cycles": [],
    "merge": {"commit": "c9landing-merge-001"},
    "commitBoundary": {"mergeCommit": "c9landing-merge-001", "closedAt": 1_700_000_000_000},
}

# §S9/AC13 — a plan CLOSED WITHOUT a merge commit: NEITHER `merge` NOR
# `commitBoundary` at all (`toPlan` omits `merge` when `row.merge_commit` is
# null, and `deriveCommitBoundary` returns undefined — hence `toPlan` omits
# `commitBoundary` too — when `plan.merge` is undefined).
CLOSED_WITHOUT_MERGE = {
    "planId": "plan-c9-bare", "cr": "CR-T-LAND-BARE", "wave": "1",
    "status": "closed", "cycles": [],
}

# The fake server response to `GET …/plans?status=closed` — ALREADY narrowed
# to the two closed plans (the aborted/open plans the AC13 board also holds
# never reach the client at all; that server-side filtering is AC1's job,
# proved in tests/plans-status-filter.test.ts, not re-proved here). This
# file's job is solely: does the client ask for `?status=closed`, and does it
# turn exactly this response into the right rows.
_CLOSED_BOARD = {"ok": True, "plans": [CLOSED_WITH_MERGE, CLOSED_WITHOUT_MERGE]}

_UNAVAILABLE = {"ok": False, "error": "connection failed"}

_EXPECTED_ROWS = [
    {"cr": "CR-T-LAND-MERGED", "mergeCommit": "c9landing-merge-001"},
    {"cr": "CR-T-LAND-BARE", "mergeCommit": None},
]


class _LandingsContractTestBase:
    """A plain MIXIN (no `unittest.TestCase` here) — only the five concrete
    per-client classes below inherit `unittest.TestCase`, so discovery never
    collects this abstract half on its own (the established fleet idiom,
    test_status_speaks_json_to_programs.py's own `_FormatFlagTestBase`)."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                    f"cr150_c9_landings_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr150-c9-landings-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write(f"CRUCIBLE_PROJECT_NAME={PROJECT_KEY}\n")
        install_project_limits(self.tmpdir)
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

    def drive(self, extra_argv, response):
        """Drives `landings` with `_get` mocked, RETURNING the mock so a
        test can inspect exactly what path(s) it was called with — the one
        thing the JSON-format mixin in the sibling status file never needed
        (it only ever checked the mocked RETURN value)."""
        argv = ["landings"] + list(extra_argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", return_value=response) as mock_get:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, mock_get

    def decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"{self.CLIENT}: --format toon stdout must still TOON-decode as "
            f"an 'axi' envelope; got {stdout_text!r}")
        return decoded["axi"]


class LandingsContractTests:
    """§S9/AC13 — the core per-client contract."""

    def test_issues_exactly_one_read_to_the_status_closed_filtered_path(self):
        code, out, err, mock_get = self.drive([], _CLOSED_BOARD)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `landings` must exist and succeed against a "
            f"reachable board; stdout={out!r} stderr={err!r} (RED: the verb "
            f"is not wired into argparse yet)")
        self.assertEqual(
            mock_get.call_count, 1,
            f"{self.CLIENT}: landings must issue EXACTLY one read; got "
            f"{mock_get.call_args_list!r}")
        called_path = mock_get.call_args[0][0]
        self.assertEqual(
            called_path, f"/api/v2/projects/{PROJECT_KEY}/plans?status=closed",
            f"{self.CLIENT}: the one read must carry the status=closed "
            f"filter (§S9); got {called_path!r}")

    def test_rows_are_exactly_the_two_closed_plans_in_server_order_with_null_for_the_bare_one(self):
        code, out, err, _mock_get = self.drive([], _CLOSED_BOARD)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        rows = axi.get("landings")
        self.assertEqual(
            rows, _EXPECTED_ROWS,
            f"{self.CLIENT}: rows must be EXACTLY the server's two closed "
            f"plans, in the server's order, each {{cr, mergeCommit}}, with "
            f"null for the plan that recorded none; got {rows!r}")

    def test_format_json_writes_one_object_equal_to_the_toon_axi_object(self):
        toon_code, toon_out, toon_err, _tmg = self.drive(["--format", "toon"], _CLOSED_BOARD)
        json_code, json_out, json_err, _jmg = self.drive(["--format", "json"], _CLOSED_BOARD)

        self.assertEqual(
            toon_code, json_code,
            f"{self.CLIENT}: --format toon and --format json must exit with "
            f"the SAME code; toon={toon_code} json={json_code}")
        self.assertEqual(
            toon_err, json_err,
            f"{self.CLIENT}: stderr must be unchanged between --format toon "
            f"and --format json; toon_err={toon_err!r} json_err={json_err!r}")

        toon_axi = self.decode_toon_axi(toon_out)

        self.assertTrue(
            json_out.lstrip().startswith("{"),
            f"{self.CLIENT}: --format json must write a JSON OBJECT on "
            f"stdout; got {json_out!r}")
        json_obj = json.loads(json_out)
        self.assertIsInstance(
            json_obj, dict,
            f"{self.CLIENT}: the parsed JSON must be a single object, not a "
            f"list/scalar; got {json_obj!r}")
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: --format json must write ONE JSON object whose "
            f"keys and values equal the same invocation's --format toon "
            f"'axi' object; toon={toon_axi!r} json={json_obj!r}")
        self.assertNotIn(
            "axi", json_obj,
            f"{self.CLIENT}: the JSON object must be the UNWRAPPED axi "
            f"object, never re-wrapped under an 'axi' key; got {json_obj!r}")
        self.assertEqual(
            json_obj.get("landings"), _EXPECTED_ROWS,
            f"{self.CLIENT}: --format json's 'landings' rows must equal the "
            f"same two closed plans; got {json_obj!r}")

    def test_a_failed_read_degrades_to_ok_true_empty_landings_and_a_warning_code(self):
        code, out, err, mock_get = self.drive([], _UNAVAILABLE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: a failed board read must still exit 0 (the "
            f"tolerant AXI degrade, mirroring `status`); stdout={out!r} "
            f"stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), True,
            f"{self.CLIENT}: the degrade must be ok:true; got {axi!r}")
        self.assertEqual(
            axi.get("landings"), [],
            f"{self.CLIENT}: the degrade must carry landings:[]; got {axi!r}")
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn(
            "landings-unavailable", codes,
            f"{self.CLIENT}: the degrade must carry a 'landings-unavailable' "
            f"warning code; got warnings={axi.get('warnings')!r}")


class _AllLandingsTests(LandingsContractTests, _LandingsContractTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonLandingsTest(_AllLandingsTests, unittest.TestCase):
    CLIENT = "python"


class BunLandingsTest(_AllLandingsTests, unittest.TestCase):
    CLIENT = "bun"


class RustLandingsTest(_AllLandingsTests, unittest.TestCase):
    CLIENT = "rust"


class MvnLandingsTest(_AllLandingsTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoLandingsTest(_AllLandingsTests, unittest.TestCase):
    CLIENT = "arduino"
