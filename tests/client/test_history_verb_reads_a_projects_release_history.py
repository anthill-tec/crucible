"""RED test — CR-CRU-175 §S4/AC4: an agent reads a project's history through
its client. Today NO client defines a `history` subcommand at all (confirmed
by reading all five clients' argparse wiring and clients/_crucible_axi.py —
no `cmd_history`, no `history` parser anywhere in the fleet); every drive
below fails argparse's own subcommand dispatch with `SystemExit(2)`
("invalid choice: 'history'"), never reaching `_get` at all — the verb does
not exist yet, not a fixture bug.

Spec (docs/changes/CR-CRU-175-the-queue-verb-shows-each-crs-place-in-the-plan.md
§S4): every client gains a `history` verb over `GET
/api/v2/projects/<key>/history` (CR-CRU-173/177's read — its wire shape is
pinned by tests/history-by-release-read.test.ts): one TOON envelope, default
columns `release`, `state`, `shippedAt`, `tag`, `crs` (completed count),
`pending` (pendingCount), `target`; `--fields` ADDS `waves`, `gateRuns`,
`lastGate`, `verified`, `packages`; `--full` prints every column; `--release
<label>` narrows to one release and lists ITS gate runs as the table
(`outcome`, `stopStep`, `fixRounds`, `duration`, `pushedCommit`, `eventId`,
`retired`); an unknown project or release is a refusal with `help[]`. A read
verb: no `--agent` required (no drive below ever passes one).

── Decisions this file makes, binding for GREEN (the spec leaves exact wire
   cell shapes/exit codes open; RED's call, stated here rather than guessed
   at) ──────────────────────────────────────────────────────────────────

  * The envelope's row list rides under the verb's own name, `history`
    (the fleet's established convention — `queue` carries `queue`,
    `landings` carries `landings`), in BOTH shapes: the per-release summary
    table AND the `--release`-narrowed gate-run table.
  * `waves` cell: space-separated `wave:count` pairs (DRIFT-4's established
    list-in-cell convention, and the spec's own literal example `8:3`),
    latest-first (the release's own `waves` order) — `count` is the
    wave's completed CR count (`len(wave.crs)`, HistoryRelease's own
    completed-only field, never invented arithmetic). Fixtures below give
    every wave `pendingCount: 0` so this is unambiguous regardless of
    whether a GREEN happened to also fold pending in — any reasonable
    reading agrees at 0.
  * `packages` cell: `registry:name:version` entries, comma-separated — the
    OUTPUT mirror of `release_packages`'s own INPUT grammar
    (`clients/_crucible_axi.py`), "" (never null) when the release's
    workflow carries none.
  * `lastGate` cell: `"<outcome> · <stopStep>"` when the release's one gate
    run carries a `stopStep`, else just `"<outcome>"`; null when the
    release holds no gate run at all. Fixtures below give each release at
    most ONE gate run so "last" is unambiguous under any ordering rule.
  * `gateRuns` cell: the COUNT of the release's own workflow's gate runs
    (`len(workflows[0].gateRuns)` — HistoryRelease publishes exactly one
    workflow entry per the server's own documented contract).
  * `verified` cell: `workflows[0].verificationRuns`, verbatim.
  * An unknown project (the server's `GET …/history` 404s "unknown
    project: <key>") or an unknown `--release <label>` (no release in the
    read names it) is a REFUSAL: `ok: false`, exit **1** (the fleet's own
    refusal-exit convention — `cmd_release_propose`/`cmd_cr_plan` on a
    non-ok server read, `clients/_crucible_axi.py`), `help` a non-empty
    list, and the error naming the bad input.
  * Harness: `test_landings_reads_the_closed_plans.py`'s own idiom for a
    brand-new read-only verb across the fleet — `_get` mocked per client
    (no live server, no RecordingBoard: `RecordingBoard.do_GET`,
    tests/client/live_run_harness.py, answers no `/history` route and
    extending shared run-lifecycle test infra is out of this RED's scope),
    stdout decoded with the client's own `module._toon()`.

Invocation:
    python3 -m unittest tests.client.test_history_verb_reads_a_projects_release_history
"""
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

PROJECT_KEY = "cr175-c3-history"
HISTORY_PATH = f"/api/v2/projects/{PROJECT_KEY}/history"


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


# ── fixture: GET …/history's own wire shape (tests/history-by-release-read.test.ts) ──

SHIPPED_GATE_RUN = {
    "runId": "run-hist-1", "outcome": "FAIL", "stopStep": "lint",
    "fixRounds": 1, "durationMs": 45000, "pushedCommit": "deadbeef1",
    "eventId": "evt-hist-1", "retired": False,
}

SHIPPED_RELEASE = {
    "labels": ["9.9.9"], "state": "shipped", "shippedAt": 1700000000,
    "tag": "v9.9.9", "commit": "aaaaaaaaaaaa", "crCount": 3, "pendingCount": 0,
    "waves": [{"wave": "8", "crs": ["CR-H-1", "CR-H-2", "CR-H-3"], "pendingCount": 0}],
    "workflows": [{
        "label": "9.9.9", "gateRuns": [SHIPPED_GATE_RUN], "verificationRuns": 2,
        "packages": [{"registry": "npm", "name": "@fixture/crucible-history", "version": "0.2.0"}],
    }],
}

UNSHIPPED_RELEASE = {
    "labels": ["9.9.8"], "state": "in progress", "targetAt": 1800000000,
    "crCount": 1, "pendingCount": 2,
    "waves": [{"wave": "7", "crs": ["CR-H-4"], "pendingCount": 2}],
    "workflows": [{"label": "9.9.8", "gateRuns": [], "verificationRuns": 0}],
}

HISTORY_RESPONSE = {"ok": True, "releases": [SHIPPED_RELEASE, UNSHIPPED_RELEASE]}

UNKNOWN_PROJECT_RESPONSE = {
    "ok": False,
    "error": f"HTTP 404: unknown project: {PROJECT_KEY}",
}

DEFAULT_COLUMNS = ("release", "state", "shippedAt", "tag", "crs", "pending", "target")
EXTRA_COLUMNS = ("waves", "gateRuns", "lastGate", "verified", "packages")

EXPECTED_DEFAULT_ROWS = [
    {"release": "9.9.9", "state": "shipped", "shippedAt": 1700000000,
     "tag": "v9.9.9", "crs": 3, "pending": 0, "target": None},
    {"release": "9.9.8", "state": "in progress", "shippedAt": None,
     "tag": None, "crs": 1, "pending": 2, "target": 1800000000},
]

EXPECTED_EXTRA_CELLS = [
    {"waves": "8:3", "gateRuns": 1, "lastGate": "FAIL · lint", "verified": 2,
     "packages": "npm:@fixture/crucible-history:0.2.0"},
    {"waves": "7:1", "gateRuns": 0, "lastGate": None, "verified": 0,
     "packages": ""},
]

EXPECTED_GATE_RUN_COLUMNS = ("outcome", "stopStep", "fixRounds", "duration",
                             "pushedCommit", "eventId", "retired")

EXPECTED_SHIPPED_GATE_ROW = {
    "outcome": "FAIL", "stopStep": "lint", "fixRounds": 1, "duration": 45000,
    "pushedCommit": "deadbeef1", "eventId": "evt-hist-1", "retired": False,
}


class _HistoryContractTestBase:
    """A plain MIXIN (no `unittest.TestCase` here) — only the five concrete
    per-client classes below inherit `unittest.TestCase`, so discovery never
    collects this abstract half on its own (the established fleet idiom,
    `test_landings_reads_the_closed_plans.py`'s own `_LandingsContractTestBase`)."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(
            CLIENT_FILES[self.CLIENT], f"cr175_c3_history_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr175-c3-history-{self.CLIENT}-")
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
        """Drives `history` with `_get` mocked, RETURNING the mock so a test
        can inspect exactly what path it was called with."""
        argv = ["history"] + list(extra_argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", return_value=response) as mock_get:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, mock_get

    def decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"{self.CLIENT}: stdout must TOON-decode as an 'axi' envelope; "
            f"got {stdout_text!r}")
        return decoded["axi"]


class HistoryContractTests:
    """CR-CRU-175 §S4/AC4 — the core per-client contract."""

    def test_issues_exactly_one_read_to_the_history_path_no_agent_required(self):
        code, out, err, mock_get = self.drive([], HISTORY_RESPONSE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `history` must exist and succeed against a "
            f"reachable board with NO --agent flag given; stdout={out!r} "
            f"stderr={err!r} (RED: the verb is not wired into argparse yet)")
        self.assertEqual(
            mock_get.call_count, 1,
            f"{self.CLIENT}: history must issue EXACTLY one read; got "
            f"{mock_get.call_args_list!r}")
        called_path = mock_get.call_args[0][0]
        self.assertEqual(
            called_path, HISTORY_PATH,
            f"{self.CLIENT}: the one read must hit GET …/history; got "
            f"{called_path!r}")

    def test_default_table_is_exactly_the_seven_release_told_columns_in_order(self):
        code, out, err, _mg = self.drive([], HISTORY_RESPONSE)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        rows = axi.get("history")
        self.assertIsInstance(
            rows, list,
            f"{self.CLIENT}: the 'history' field must decode as a list of "
            f"rows; got {rows!r} from stdout={out!r}")
        self.assertEqual(
            len(rows), 2,
            f"{self.CLIENT}: one row per release the server returned; got "
            f"{rows!r}")
        for row in rows:
            self.assertEqual(
                list(row.keys()), list(DEFAULT_COLUMNS),
                f"{self.CLIENT}: with no --fields/--full the default table "
                f"must be EXACTLY release,state,shippedAt,tag,crs,pending,"
                f"target, in that order; got {list(row.keys())!r}")
        self.assertEqual(
            rows, EXPECTED_DEFAULT_ROWS,
            f"{self.CLIENT}: default rows must equal the server's own "
            f"releases, IN THE SERVER'S OWN ORDER (never re-sorted), with "
            f"shippedAt/tag/target null when the release never declared "
            f"them; got {rows!r} expected {EXPECTED_DEFAULT_ROWS!r}")

    def test_fields_adds_the_five_extra_columns_after_the_default_seven_in_requested_order(self):
        code, out, err, _mg = self.drive(
            ["--fields", "waves,gateRuns,lastGate,verified,packages"],
            HISTORY_RESPONSE)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        rows = axi.get("history")
        self.assertEqual(
            list(rows[0].keys()), list(DEFAULT_COLUMNS) + list(EXTRA_COLUMNS),
            f"{self.CLIENT}: --fields must ADD the requested columns AFTER "
            f"the default seven, in the requested order; got "
            f"{list(rows[0].keys())!r}")
        for row, expected_default, expected_extra in zip(
                rows, EXPECTED_DEFAULT_ROWS, EXPECTED_EXTRA_CELLS, strict=True):
            for key, value in expected_default.items():
                self.assertEqual(
                    row.get(key), value,
                    f"{self.CLIENT}: the default columns must keep their "
                    f"values with --fields present; got row={row!r}")
            for key, value in expected_extra.items():
                self.assertEqual(
                    row.get(key), value,
                    f"{self.CLIENT}: extra column {key!r} must carry its "
                    f"documented cell value; got row={row!r} (this file's "
                    f"own wire-shape decisions are stated at module top)")

    def test_full_prints_every_column_untruncated(self):
        code, out, err, _mg = self.drive(["--full"], HISTORY_RESPONSE)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        rows = axi.get("history")
        self.assertEqual(
            list(rows[0].keys()), list(DEFAULT_COLUMNS) + list(EXTRA_COLUMNS),
            f"{self.CLIENT}: --full must print EVERY column — the default "
            f"seven plus all five extras; got {list(rows[0].keys())!r}")
        self.assertEqual(
            rows[0].get("packages"), "npm:@fixture/crucible-history:0.2.0",
            f"{self.CLIENT}: --full must not truncate a package cell; got "
            f"row={rows[0]!r}")

    def test_release_flag_narrows_to_one_release_and_lists_its_gate_runs(self):
        code, out, err, mock_get = self.drive(["--release", "9.9.9"], HISTORY_RESPONSE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `--release 9.9.9` names a real release in the "
            f"read; must succeed; stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        rows = axi.get("history")
        self.assertEqual(
            len(rows), 1,
            f"{self.CLIENT}: the narrowed table must hold exactly the "
            f"named release's OWN gate runs — one here; got {rows!r}")
        self.assertEqual(
            list(rows[0].keys()), list(EXPECTED_GATE_RUN_COLUMNS),
            f"{self.CLIENT}: the narrowed table's columns must be EXACTLY "
            f"outcome,stopStep,fixRounds,duration,pushedCommit,eventId,"
            f"retired; got {list(rows[0].keys())!r}")
        self.assertEqual(
            rows[0], EXPECTED_SHIPPED_GATE_ROW,
            f"{self.CLIENT}: the one gate-run row must equal the release's "
            f"real gate run, verbatim; got {rows[0]!r}")

    def test_release_flag_on_a_release_with_no_gate_runs_answers_an_empty_table_not_a_refusal(self):
        code, out, err, _mg = self.drive(["--release", "9.9.8"], HISTORY_RESPONSE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `9.9.8` is a REAL release that simply holds no "
            f"gate run yet — this is not a refusal; stdout={out!r} "
            f"stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), True,
            f"{self.CLIENT}: a gate-run-less real release must still "
            f"answer ok:true; got {axi!r}")
        self.assertEqual(
            axi.get("history"), [],
            f"{self.CLIENT}: and an EMPTY gate-run table — never a "
            f"fabricated row; got {axi.get('history')!r}")

    def test_an_unknown_release_label_is_refused_with_help(self):
        code, out, err, _mg = self.drive(["--release", "42.0.0"], HISTORY_RESPONSE)
        self.assertEqual(
            code, 1,
            f"{self.CLIENT}: an unknown --release must be a REFUSAL, exit "
            f"1 (the fleet's own non-ok-read exit convention); stdout="
            f"{out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: ok must be false on the refusal; got {axi!r}")
        help_steps = axi.get("help")
        self.assertIsInstance(
            help_steps, list,
            f"{self.CLIENT}: the refusal must carry a help[] list; got "
            f"{axi!r}")
        self.assertGreater(
            len(help_steps), 0,
            f"{self.CLIENT}: help[] must be non-empty on a refusal; got "
            f"{axi!r}")
        self.assertIn(
            "42.0.0", str(axi.get("error") or ""),
            f"{self.CLIENT}: the refusal must NAME the unknown release it "
            f"refused; got error={axi.get('error')!r}")

    def test_an_unknown_project_is_refused_with_help(self):
        code, out, err, _mg = self.drive([], UNKNOWN_PROJECT_RESPONSE)
        self.assertEqual(
            code, 1,
            f"{self.CLIENT}: an unknown project must be a REFUSAL, exit 1; "
            f"stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: ok must be false when the server's own "
            f"GET …/history 404s; got {axi!r}")
        self.assertEqual(
            axi.get("history"), None,
            f"{self.CLIENT}: a project-unknown refusal must carry no "
            f"fabricated history rows — never [] standing in for 'nothing "
            f"to report' alongside ok:false, and never a row list at all; "
            f"got {axi!r}")
        help_steps = axi.get("help")
        self.assertIsInstance(
            help_steps, list,
            f"{self.CLIENT}: the refusal must carry a help[] list; got "
            f"{axi!r}")
        self.assertGreater(
            len(help_steps), 0,
            f"{self.CLIENT}: help[] must be non-empty on a refusal; got "
            f"{axi!r}")

    def test_format_json_writes_one_object_equal_to_the_toon_axi_object(self):
        toon_code, toon_out, toon_err, _tmg = self.drive(["--format", "toon"], HISTORY_RESPONSE)
        json_code, json_out, json_err, _jmg = self.drive(["--format", "json"], HISTORY_RESPONSE)

        self.assertEqual(
            toon_code, json_code,
            f"{self.CLIENT}: --format toon and --format json must exit "
            f"with the SAME code; toon={toon_code} json={json_code}")

        toon_axi = self.decode_toon_axi(toon_out)

        self.assertTrue(
            json_out.lstrip().startswith("{"),
            f"{self.CLIENT}: --format json must write a JSON OBJECT on "
            f"stdout; got {json_out!r}")
        json_obj = json.loads(json_out)
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: --format json must write ONE JSON object "
            f"equal to the same invocation's --format toon 'axi' object; "
            f"toon={toon_axi!r} json={json_obj!r}")
        self.assertEqual(
            json_obj.get("history"), EXPECTED_DEFAULT_ROWS,
            f"{self.CLIENT}: --format json's 'history' rows must equal the "
            f"same default rows; got {json_obj!r}")


class _AllHistoryTests(HistoryContractTests, _HistoryContractTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonHistoryTest(_AllHistoryTests, unittest.TestCase):
    CLIENT = "python"


class BunHistoryTest(_AllHistoryTests, unittest.TestCase):
    CLIENT = "bun"


class RustHistoryTest(_AllHistoryTests, unittest.TestCase):
    CLIENT = "rust"


class MvnHistoryTest(_AllHistoryTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoHistoryTest(_AllHistoryTests, unittest.TestCase):
    CLIENT = "arduino"


if __name__ == "__main__":
    unittest.main()
