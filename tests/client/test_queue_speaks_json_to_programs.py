# The per-client classes below are a plain multiple-inheritance MIXIN group
# (the shape test_status_speaks_json_to_programs.py and
# test_landings_reads_the_closed_plans.py already use): only the five concrete
# subclasses inherit unittest.TestCase, so discovery never collects the
# abstract halves. A static checker cannot see the attributes each mixin
# borrows from its siblings until they are combined, hence the pragma.
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false
"""Every client's `queue` verb speaks JSON to programs: `--format {toon,json}`.

`queue` gains the same `--format` flag `status`, `plans` and `landings` carry
(`add_status_format_arg` / `_status_emitter`, clients/_crucible_axi.py):
`toon` is the default and today's output, unchanged; `json` writes ONE JSON
object -- the same axi envelope as the TOON one, unwrapped -- carrying the
same `queue` rows with the same columns (`cr, wave, status, planId, title,
lifecycle`, plus whatever `--fields`/`--full` select), `crMerged`, `count`
and the warnings. A program (the release ceremony's provenance report) then
reads the queue as data instead of splitting text rows, so a title holding a
comma or a double quote must survive the crossing exactly, and `lifecycle`
must arrive as `VOID` / `SUPERSEDED` / null.

What is RED today, read off the five clients' argparse wiring: the `queue`
subparser registers only `--fields`/`--full` (`add_queue_view_args`), so
every drive that passes `--format <anything>` is refused by `parse_args()`
with "unrecognized arguments" (exit 2, nothing on stdout) -- the flag does
not exist, which is the defect, not a harness error. The two drives with no
`--format` at all already succeed and are pinned here as the baseline the
JSON side is compared against.

Harness: the fleet idiom of the sibling `status`/`landings` suites -- each
client module loaded fresh by path, a tmpdir project with `.env` and the
shipped limit declarations (`install_project_limits`), `sys.argv` patched,
`module.main()` driven for real, the module's own `_get` transport seam
replaced by a path-routing stub (the stub-board idiom of
test_queue_reads_merged_crs_by_type.py) so no server is ever touched, and the
client's OWN TOON codec (`_toon()`) decoding the TOON side of every
comparison.

Fixture cr ids are drawn from the registered synthetic `CR-SHIPPED-*`
namespace -- never a real board id.
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from tests.client.test_client_fleet_envelope_census import install_project_limits
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

# The env keys the fleet's `context` block reads -- cleared per test so an
# ambient orchestrator session can never colour an envelope compared here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

PROJECT_KEY = "queue-json-fixture"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"

# A title a text-row reader would split wrongly: a comma AND double quotes.
VOID_TITLE = 'retire the "legacy" reader, then the path'
SUPERSEDED_TITLE = "the first design for the provenance read"
PENDING_TITLE = "the live work still waiting"

# The board's queue read, as `GET …/queue` publishes it: a VOID entry (whose
# title carries the comma and quotes), a SUPERSEDED entry, and a live PENDING
# entry with no lifecycle object at all. The SUPERSEDED entry depends on the
# PENDING one placed AFTER it, so the place-in-plan view carries a
# `before-its-dependency` warning the JSON side must carry too.
_QUEUE_ENTRIES = [
    {"cr": "CR-SHIPPED-1", "wave": "4", "status": "PENDING",
     "title": VOID_TITLE, "release": "9.9.9", "seq": 1, "points": 3,
     "dependsOn": [],
     "lifecycle": {"state": "VOID", "reason": "duplicated elsewhere"}},
    {"cr": "CR-SHIPPED-2", "wave": "4", "status": "PENDING",
     "title": SUPERSEDED_TITLE, "release": "9.9.9", "seq": 2, "points": 5,
     "dependsOn": ["CR-SHIPPED-3"],
     "lifecycle": {"state": "SUPERSEDED", "by": "CR-SHIPPED-3"}},
    {"cr": "CR-SHIPPED-3", "wave": "5", "status": "PENDING",
     "planId": "plan-queue-json-3", "title": PENDING_TITLE,
     "release": "9.9.9", "seq": 3, "points": 8, "dependsOn": []},
]
_QUEUE_RESPONSE = {"ok": True, "entries": _QUEUE_ENTRIES,
                   "totalCount": len(_QUEUE_ENTRIES)}

# The type-scoped cr-merged milestone read, answered out of order so the
# published sort is observable.
_MILESTONES_RESPONSE = {
    "ok": True,
    "milestones": [
        {"id": "evt-1", "type": "cr-merged", "label": "CR-SHIPPED-7",
         "timestamp": 1789000000000},
        {"id": "evt-2", "type": "cr-merged", "label": "CR-SHIPPED-5",
         "timestamp": 1789000000001},
    ],
    "totalCount": 2,
}

_UNREACHABLE = {"ok": False, "error": "connection refused"}

# The default table: exactly the six base columns, in order, values as the
# rows must carry them.
_EXPECTED_DEFAULT_ROWS = [
    {"cr": "CR-SHIPPED-1", "wave": "4", "status": "PENDING", "planId": None,
     "title": VOID_TITLE, "lifecycle": "VOID"},
    {"cr": "CR-SHIPPED-2", "wave": "4", "status": "PENDING", "planId": None,
     "title": SUPERSEDED_TITLE, "lifecycle": "SUPERSEDED"},
    {"cr": "CR-SHIPPED-3", "wave": "5", "status": "PENDING",
     "planId": "plan-queue-json-3", "title": PENDING_TITLE, "lifecycle": None},
]
_BASE_COLUMNS = ["cr", "wave", "status", "planId", "title", "lifecycle"]
_EXPECTED_CR_MERGED = ["CR-SHIPPED-5", "CR-SHIPPED-7"]


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched -> (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["client"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


class _QueueFormatTestBase:
    """A plain MIXIN -- only the five concrete per-client classes below
    inherit unittest.TestCase."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                   f"queue_json_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"queue-json-{self.CLIENT}-")
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

    def drive(self, extra_argv, queue_response=_QUEUE_RESPONSE,
              milestones_response=_MILESTONES_RESPONSE):
        """Run `queue` against the stub board -> (code, stdout, stderr,
        the GET paths the verb issued, in order)."""
        paths = []

        def fake_get(path, *args, **kwargs):
            paths.append(path)
            if path.startswith(QUEUE_PATH):
                return queue_response
            return milestones_response

        argv = ["queue"] + list(extra_argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", side_effect=fake_get):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, paths

    def decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIsInstance(
            decoded, dict,
            f"{self.CLIENT}: TOON stdout must decode as a document; got "
            f"{stdout_text!r}")
        self.assertIn(
            "axi", decoded,
            f"{self.CLIENT}: TOON stdout must carry the 'axi' envelope; got "
            f"{stdout_text!r}")
        return decoded["axi"]

    def decode_one_json_object(self, stdout_text):
        """The whole of stdout must be ONE JSON object -- `json.loads` over
        the full text refuses a second document or any trailing prose."""
        self.assertTrue(
            stdout_text.lstrip().startswith("{"),
            f"{self.CLIENT}: queue --format json must write a JSON object on "
            f"stdout; got {stdout_text!r}")
        obj = json.loads(stdout_text)
        self.assertIsInstance(
            obj, dict,
            f"{self.CLIENT}: the JSON must be a single object; got {obj!r}")
        self.assertNotIn(
            "axi", obj,
            f"{self.CLIENT}: the JSON object is the UNWRAPPED envelope, never "
            f"re-wrapped under 'axi'; got {obj!r}")
        return obj


class _QueueFormatFlagIsDeclaredTests:
    """The flag is part of the verb's surface, with exactly two encodings."""

    def test_queue_help_lists_format_with_toon_and_json(self):
        code, out, err, paths = self.drive(["--help"])
        self.assertEqual(code, 0, f"{self.CLIENT}: queue --help must exit 0; "
                                  f"stderr={err!r}")
        self.assertIn(
            "--format {toon,json}", out,
            f"{self.CLIENT}: queue --help must list `--format` with exactly "
            f"the choices toon and json; got {out!r}")
        self.assertEqual(paths, [], f"{self.CLIENT}: --help reads nothing")

    def test_queue_format_value_other_than_toon_or_json_is_refused_by_argument_parsing(self):
        code, out, err, paths = self.drive(["--format", "yaml"])
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: an unknown --format value must be a usage "
            f"refusal (exit 2); stdout={out!r} stderr={err!r}")
        self.assertEqual(out, "", f"{self.CLIENT}: a usage refusal writes "
                                  f"nothing to stdout; got {out!r}")
        self.assertEqual(paths, [], f"{self.CLIENT}: a refused invocation "
                                    f"must read nothing; got {paths!r}")
        lowered = err.lower()
        self.assertIn(
            "invalid choice", lowered,
            f"{self.CLIENT}: the refusal must be argparse's CHOICES mechanism "
            f"('invalid choice'), not 'unrecognized arguments' for a flag "
            f"that does not exist; stderr={err!r}")
        self.assertIn("toon", lowered, f"{self.CLIENT}: stderr={err!r}")
        self.assertIn("json", lowered, f"{self.CLIENT}: stderr={err!r}")


class _QueueFormatJsonCarriesTheRowsTests:
    """`--format json` carries the same envelope, rows and fields as TOON."""

    def test_format_json_prints_one_object_equal_to_the_toon_envelope(self):
        toon_code, toon_out, toon_err, toon_paths = self.drive([])
        json_code, json_out, json_err, json_paths = self.drive(["--format", "json"])

        self.assertEqual(
            json_code, 0,
            f"{self.CLIENT}: queue --format json must succeed; "
            f"stdout={json_out!r} stderr={json_err!r}")
        self.assertEqual(toon_code, json_code)
        self.assertEqual(
            toon_err, json_err,
            f"{self.CLIENT}: stderr must not change with the stdout encoding; "
            f"toon={toon_err!r} json={json_err!r}")
        self.assertEqual(
            json_paths, toon_paths,
            f"{self.CLIENT}: the JSON read must issue the same reads as the "
            f"TOON one; toon={toon_paths!r} json={json_paths!r}")

        toon_axi = self.decode_toon_axi(toon_out)
        json_obj = self.decode_one_json_object(json_out)
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: the JSON object must equal the TOON axi object "
            f"key for key; toon={toon_axi!r} json={json_obj!r}")

    def test_format_json_rows_carry_the_six_columns_with_exact_values(self):
        code, out, err, paths = self.drive(["--format", "json"])
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        obj = self.decode_one_json_object(out)

        self.assertEqual(obj.get("verb"), "queue")
        self.assertIs(obj.get("ok"), True)
        self.assertEqual(
            obj.get("queue"), _EXPECTED_DEFAULT_ROWS,
            f"{self.CLIENT}: the JSON rows must be the three entries with "
            f"their exact values -- the comma-and-quote title verbatim, "
            f"lifecycle VOID / SUPERSEDED / null; got {obj.get('queue')!r}")
        for row in obj["queue"]:
            self.assertEqual(
                list(row.keys()), _BASE_COLUMNS,
                f"{self.CLIENT}: every default row carries exactly the six "
                f"base columns, in order; got {row!r}")
        self.assertEqual(obj.get("crMerged"), _EXPECTED_CR_MERGED)
        self.assertEqual(obj.get("count"), 3)
        self.assertEqual(obj.get("warnings"), [],
                         f"{self.CLIENT}: a clean read carries no warnings; "
                         f"got {obj.get('warnings')!r}")
        self.assertEqual(
            len(paths), 2,
            f"{self.CLIENT}: the verb must issue exactly two reads; got "
            f"{paths!r}")
        self.assertTrue(paths[0].startswith(QUEUE_PATH),
                        f"{self.CLIENT}: first read is the queue; got {paths!r}")
        self.assertIn("cr-merged", paths[1],
                      f"{self.CLIENT}: second read names cr-merged; got {paths!r}")

    def test_format_json_title_with_comma_and_quotes_round_trips_exactly(self):
        code, out, err, _paths = self.drive(["--format", "json"])
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        obj = self.decode_one_json_object(out)
        void_rows = [r for r in obj.get("queue", []) if r.get("lifecycle") == "VOID"]
        self.assertEqual(
            len(void_rows), 1,
            f"{self.CLIENT}: exactly one VOID row; got {obj.get('queue')!r}")
        self.assertEqual(
            void_rows[0]["title"], VOID_TITLE,
            f"{self.CLIENT}: a title holding a comma and double quotes must "
            f"cross the JSON boundary byte-exact; got {void_rows[0]!r}")
        self.assertEqual(void_rows[0]["cr"], "CR-SHIPPED-1")

    def test_format_toon_prints_byte_identical_output_to_no_flag(self):
        bare_code, bare_out, bare_err, _bp = self.drive([])
        toon_code, toon_out, toon_err, _tp = self.drive(["--format", "toon"])
        self.assertEqual(
            toon_code, 0,
            f"{self.CLIENT}: queue --format toon must succeed; "
            f"stderr={toon_err!r}")
        self.assertEqual(bare_code, toon_code)
        self.assertEqual(
            toon_out, bare_out,
            f"{self.CLIENT}: `--format toon` is the default -- its stdout "
            f"must equal the no-flag stdout exactly")
        self.assertEqual(toon_err, bare_err)


class _QueueFormatJsonProjectionTests:
    """`--fields` and `--full` select the same columns in JSON as in TOON."""

    def _assert_projection_matches(self, view_argv, expected_columns):
        toon_code, toon_out, toon_err, _tp = self.drive(view_argv)
        json_code, json_out, json_err, _jp = self.drive(view_argv + ["--format", "json"])
        self.assertEqual(
            json_code, 0,
            f"{self.CLIENT}: queue {' '.join(view_argv)} --format json must "
            f"succeed; stdout={json_out!r} stderr={json_err!r}")
        self.assertEqual(toon_code, json_code)
        toon_axi = self.decode_toon_axi(toon_out)
        json_obj = self.decode_one_json_object(json_out)
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: {view_argv!r} -- the JSON object must equal the "
            f"TOON axi object; toon={toon_axi!r} json={json_obj!r}")
        rows = json_obj.get("queue") or []
        self.assertEqual(len(rows), 3, f"{self.CLIENT}: got {rows!r}")
        for row in rows:
            self.assertEqual(
                list(row.keys()), expected_columns,
                f"{self.CLIENT}: {view_argv!r} -- JSON row columns must be "
                f"exactly {expected_columns!r}; got {row!r}")
        return json_obj

    def test_format_json_with_fields_selects_the_same_columns_as_toon(self):
        obj = self._assert_projection_matches(
            ["--fields", "release,seq"],
            _BASE_COLUMNS + ["release", "seq", "warning"])
        self.assertEqual(
            [(r["release"], r["seq"]) for r in obj["queue"]],
            [("9.9.9", 1), ("9.9.9", 2), ("9.9.9", 3)],
            f"{self.CLIENT}: the selected columns carry their values; got "
            f"{obj['queue']!r}")

    def test_format_json_with_full_selects_every_column_and_carries_the_order_warning(self):
        obj = self._assert_projection_matches(
            ["--full"],
            _BASE_COLUMNS + ["release", "seq", "points", "dependsOn", "warning"])
        by_cr = {r["cr"]: r for r in obj["queue"]}
        self.assertEqual(by_cr["CR-SHIPPED-2"]["dependsOn"], "CR-SHIPPED-3")
        self.assertEqual(by_cr["CR-SHIPPED-2"]["warning"],
                         "before its dependency CR-SHIPPED-3")
        self.assertEqual(by_cr["CR-SHIPPED-1"]["warning"], "")
        self.assertEqual(by_cr["CR-SHIPPED-3"]["points"], 8)
        codes = [w.get("code") for w in obj.get("warnings") or []]
        self.assertEqual(
            codes, ["before-its-dependency"],
            f"{self.CLIENT}: exactly one order warning rides the JSON "
            f"envelope; got {obj.get('warnings')!r}")


class _QueueFormatJsonUnreachableBoardTests:
    """The tolerant degrade survives the JSON encoding."""

    def test_format_json_on_an_unreachable_board_exits_zero_with_an_empty_queue_and_a_warning(self):
        json_code, json_out, json_err, _jp = self.drive(
            ["--format", "json"], queue_response=_UNREACHABLE,
            milestones_response=_UNREACHABLE)
        self.assertEqual(
            json_code, 0,
            f"{self.CLIENT}: an unreachable board must not fail the read "
            f"under --format json; stdout={json_out!r} stderr={json_err!r}")
        obj = self.decode_one_json_object(json_out)
        self.assertIs(obj.get("ok"), True)
        self.assertEqual(obj.get("queue"), [])
        self.assertEqual(obj.get("count"), 0)
        self.assertEqual(obj.get("crMerged"), [])
        codes = [w.get("code") for w in obj.get("warnings") or []]
        self.assertIn(
            "queue-unavailable", codes,
            f"{self.CLIENT}: the unreachable queue must be NAMED in a "
            f"structured warning; got {obj.get('warnings')!r}")

        toon_code, toon_out, _te, _tp = self.drive(
            [], queue_response=_UNREACHABLE, milestones_response=_UNREACHABLE)
        self.assertEqual(toon_code, json_code)
        self.assertEqual(
            obj, self.decode_toon_axi(toon_out),
            f"{self.CLIENT}: the degraded JSON object must equal the degraded "
            f"TOON axi object")


class _QueueDefaultStaysToonTests:
    """No `--format`: today's TOON envelope, unchanged."""

    def test_no_format_flag_still_prints_the_toon_envelope(self):
        code, out, err, _paths = self.drive([])
        self.assertEqual(code, 0, f"{self.CLIENT}: stderr={err!r}")
        self.assertTrue(
            out.lstrip().startswith("axi:"),
            f"{self.CLIENT}: the default output is the TOON envelope, not "
            f"JSON; got {out!r}")
        axi = self.decode_toon_axi(out)
        self.assertEqual(axi.get("verb"), "queue")
        self.assertEqual(axi.get("queue"), _EXPECTED_DEFAULT_ROWS)
        self.assertEqual(axi.get("crMerged"), _EXPECTED_CR_MERGED)
        self.assertEqual(axi.get("count"), 3)


class _AllQueueFormatTests(_QueueFormatFlagIsDeclaredTests,
                           _QueueFormatJsonCarriesTheRowsTests,
                           _QueueFormatJsonProjectionTests,
                           _QueueFormatJsonUnreachableBoardTests,
                           _QueueDefaultStaysToonTests,
                           _QueueFormatTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonQueueSpeaksJsonTest(_AllQueueFormatTests, unittest.TestCase):
    CLIENT = "python"


class BunQueueSpeaksJsonTest(_AllQueueFormatTests, unittest.TestCase):
    CLIENT = "bun"


class RustQueueSpeaksJsonTest(_AllQueueFormatTests, unittest.TestCase):
    CLIENT = "rust"


class MvnQueueSpeaksJsonTest(_AllQueueFormatTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoQueueSpeaksJsonTest(_AllQueueFormatTests, unittest.TestCase):
    CLIENT = "arduino"


if __name__ == "__main__":
    unittest.main(verbosity=2)
