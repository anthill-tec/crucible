"""CR-CRU-175 cycle 1 (§S0-§S2, AC1-AC2) RED tests — the `queue` verb shows
each CR's place in the plan.

Today `cmd_queue`/`build_queue_rows` (clients/_crucible_axi.py) publish ONLY
six columns per row -- `cr`, `wave`, `status`, `planId`, `title`,
`lifecycle` -- even though the board's own `listQueue` read (src/store.ts)
already publishes `seq`, `release`, `points` and `dependsOn` on every entry
(Gap analysis DRIFT-1). `queue` (python-crucible.py's subparser) carries no
`--fields`/`--full` flag at all.

§S1/AC1 settles the fix (Gap analysis DRIFT-1/DRIFT-4, non-blocking --
accepted): `build_queue_rows` WIDENS to carry `release`, `seq`, `points`
(null when unpointed) and `dependsOn` (space-separated ids, "" -- never
null -- when none) after the six existing keys; `queue` gains `--fields`
(ADDITIVE, the §S10 rule `select_status_fields` already uses: requested
columns land after the base six, in the REQUESTED order) and `--full`
(every column); the default six-column table is byte-for-byte unchanged.

§S2/AC2 (DRIFT-2/DRIFT-3) settles: rows stay in the board's published
order, never re-sorted client-side; when the place-in-plan columns are
asked for, a row placed before one of its dependencies (the SAME rule the
roadmap page's `roadmapLateDeps` already applies, public/app.js) carries a
`warning` cell naming it ("" otherwise -- never null, never omitted) and
the envelope's `warnings[]` carries one `{code: "before-its-dependency",
detail}` entry per such row.

Two test shapes, per the RED-agent brief:

1. `BuildQueueRowsCarriesPlaceInPlanColumnsTest` -- a PURE unit suite
   driving `build_queue_rows` directly (fleet precedent:
   test_queue_rows_carry_title_and_lifecycle.py's own `BuildQueueRows...`
   class), asserting the four new keys' values, order and null/"" rules,
   and that the six existing keys are untouched.

2. The `queue` verb end-to-end through `python-crucible.py` (a real
   in-process `main()` call, the fleet's established stub idiom --
   `tests/client/test_queue_reads_merged_crs_by_type.py`'s
   `_QueueReadHarness`), decoding stdout with `clients/toon.py`'s OWN
   decoder. `QueueFieldsAddPlaceInPlanColumnsTest` covers AC1;
   `QueueWarnsWhenARowPrecedesItsDependencyTest` covers AC2.

RED today: every `--fields`/`--full` drive below fails at `code == 0`
(argparse rejects the unknown flag with exit 2, since `queue` declares
neither yet); the PURE suite fails on `KeyError`/`AssertionError` against
`build_queue_rows`'s current four-key-short rows.

Invocation:
    python3 -m unittest tests.client.test_queue_place_in_plan_columns
"""

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

PROJECT_KEY = "cr175-c1-queue-key"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
            "CRUCIBLE_PROJECT_NAME")


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with sys.argv patched -> (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["client"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def _entry(cr, *, wave="4", status="PENDING", plan_id=None, title=None,
           lifecycle=None, depends_on=(), release=None, seq=1, points=None):
    """One queue entry exactly as `GET .../queue` (`listQueue`, src/store.ts)
    publishes it: `dependsOn` is ALWAYS a key (possibly `[]`); `seq` is
    ALWAYS a key; `title`/`lifecycle`/`release`/`points`/`planId` are
    present only when the server would include them (optional TS fields),
    so a fixture that wants one ABSENT just never passes it."""
    entry = {"cr": cr, "wave": wave, "status": status,
             "dependsOn": list(depends_on), "seq": seq}
    if plan_id is not None:
        entry["planId"] = plan_id
    if title is not None:
        entry["title"] = title
    if lifecycle is not None:
        entry["lifecycle"] = lifecycle
    if release is not None:
        entry["release"] = release
    if points is not None:
        entry["points"] = points
    return entry


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — PURE unit tests on `build_queue_rows`
# ═══════════════════════════════════════════════════════════════════════════

class BuildQueueRowsCarriesPlaceInPlanColumnsTest(unittest.TestCase):
    """§S1/AC1 (Gap analysis DRIFT-1: "`build_queue_rows` widens") -- every
    row gains `release`, `seq`, `points`, `dependsOn` AFTER the six existing
    keys, uniform and scalar (the function's own documented contract: every
    row round-trips as a TOON table). `release`/`points` are null when the
    entry declares none; `dependsOn` is the space-joined id string (DRIFT-4),
    "" -- never null -- when the entry has no dependencies."""

    def setUp(self):
        self.axi = _load_module(
            AXI_MODULE_PATH, "cr175_c1_build_queue_rows_pure")

    def test_full_row_gains_release_seq_points_dependson_after_the_six_existing_keys(self):
        entry = _entry("PLACE-1", wave="4", status="PENDING",
                        title="needs scheduling", depends_on=["PLACE-0"],
                        release="9.9.9", seq=11, points=5)

        row = self.axi.build_queue_rows([entry])[0]

        self.assertEqual(
            list(row.keys()),
            ["cr", "wave", "status", "planId", "title", "lifecycle",
             "release", "seq", "points", "dependsOn"],
            f"the widened row must keep the six existing keys first, then "
            f"release, seq, points, dependsOn in that order; got "
            f"{list(row.keys())!r}")
        self.assertEqual(row["release"], "9.9.9", f"got {row!r}")
        self.assertEqual(row["seq"], 11, f"got {row!r}")
        self.assertEqual(row["points"], 5, f"got {row!r}")
        self.assertEqual(
            row["dependsOn"], "PLACE-0",
            f"a single dependency must publish as its bare id, a scalar "
            f"cell; got {row!r}")

    def test_release_is_null_when_the_entry_declares_no_release(self):
        entry = _entry("PLACE-2", seq=4)
        self.assertNotIn("release", entry, "fixture bug: entry must carry "
                                           "no release key at all")

        row = self.axi.build_queue_rows([entry])[0]

        self.assertIn("release", row, f"got {row!r}")
        self.assertIsNone(row["release"], f"got {row!r}")

    def test_points_is_null_when_the_cr_was_never_pointed(self):
        entry = _entry("PLACE-3", seq=5)
        self.assertNotIn("points", entry, "fixture bug: entry must carry "
                                          "no points key at all")

        row = self.axi.build_queue_rows([entry])[0]

        self.assertIn("points", row, f"got {row!r}")
        self.assertIsNone(
            row["points"], f"an unpointed cr must publish points=None, "
                           f"never 0 or an invented default; got {row!r}")

    def test_points_is_the_declared_integer_when_pointed(self):
        entry = _entry("PLACE-4", seq=6, points=8)

        row = self.axi.build_queue_rows([entry])[0]

        self.assertEqual(row["points"], 8, f"got {row!r}")

    def test_dependson_is_space_joined_ids_with_multiple_dependencies(self):
        entry = _entry("PLACE-5", seq=7, depends_on=["CR-A", "CR-B"])

        row = self.axi.build_queue_rows([entry])[0]

        self.assertEqual(
            row["dependsOn"], "CR-A CR-B",
            f"DRIFT-4: dependsOn joins as the fleet's other list cells do "
            f"-- space-separated ids; got {row!r}")

    def test_dependson_is_empty_string_never_null_when_the_entry_has_no_dependencies(self):
        entry = _entry("PLACE-6", seq=8, depends_on=[])

        row = self.axi.build_queue_rows([entry])[0]

        self.assertIn("dependsOn", row, f"got {row!r}")
        self.assertEqual(
            row["dependsOn"], "",
            f"DRIFT-4: an empty dependsOn must publish as the empty "
            f"string -- never null and never an omitted key; got {row!r}")

    def test_the_six_existing_keys_keep_their_today_values_while_the_row_also_gains_the_new_ones(self):
        entry = _entry("PLACE-7", wave="2", status="IN_PROGRESS",
                        plan_id=42, title="already tracked", seq=9,
                        depends_on=["CR-X"], release="1.0.0", points=3)

        row = self.axi.build_queue_rows([entry])[0]

        self.assertEqual(
            (row["cr"], row["wave"], row["status"], row["planId"],
             row["title"], row["lifecycle"]),
            ("PLACE-7", "2", "IN_PROGRESS", 42, "already tracked", None),
            f"the existing six keys must keep their TODAY values, "
            f"untouched by the four new columns; got {row!r}")
        self.assertIn("release", row, f"got {row!r}")
        self.assertIn("seq", row, f"got {row!r}")
        self.assertIn("points", row, f"got {row!r}")
        self.assertIn("dependsOn", row, f"got {row!r}")
        self.assertEqual(
            (row["release"], row["seq"], row["points"], row["dependsOn"]),
            ("1.0.0", 9, 3, "CR-X"),
            f"the four new columns must carry this entry's own values "
            f"alongside the untouched six; got {row!r}")

    def test_rows_stay_a_uniform_ten_key_set_whether_or_not_an_entry_carries_the_optional_fields(self):
        entries = [
            _entry("PLACE-8", seq=1, release="3.0.0", points=2,
                   depends_on=["PLACE-7-DEP"]),
            _entry("PLACE-9", seq=2),
        ]

        rows = self.axi.build_queue_rows(entries)

        key_sets = [frozenset(r.keys()) for r in rows]
        self.assertEqual(
            len(set(key_sets)), 1,
            f"every row must carry the IDENTICAL key set regardless of "
            f"which optional fields the source entry declared; got "
            f"{[sorted(ks) for ks in key_sets]!r}")
        self.assertEqual(
            key_sets[0],
            frozenset({"cr", "wave", "status", "planId", "title",
                      "lifecycle", "release", "seq", "points", "dependsOn"}),
            f"the uniform key set must be the full ten columns, even for "
            f"the entry declaring none of the optional ones; got "
            f"{sorted(key_sets[0])!r}")


# ═══════════════════════════════════════════════════════════════════════════
# the `queue` verb end-to-end, driven in-process (fleet stub idiom)
# ═══════════════════════════════════════════════════════════════════════════

class _QueueFieldsHarness(unittest.TestCase):
    """Drives the REAL `queue` verb (`python-crucible.py`, a genuine
    in-process `main()` call) with a stubbed `_get`/`_post`/`_patch` --
    `tests/client/test_queue_reads_merged_crs_by_type.py`'s established
    idiom. No live server and no live board are touched."""

    def setUp(self):
        self.module = _load_module(
            CLIENT_PATH, f"cr175_c1_queue_client_{id(self)}")
        self.toon = _load_module(
            TOON_PATH, f"cr175_c1_queue_toon_{id(self)}")
        self.tmpdir = tempfile.mkdtemp(prefix="cr175-c1-queue-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write("CRUCIBLE_PROJECT_NAME=cr175-c1-queue-project\n")
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

    def drive(self, entries, extra_argv=None, milestones_response=None):
        """Run `queue [extra_argv...]` -> (code, decoded axi, stdout, stderr)."""
        queue_response = {"ok": True, "entries": entries,
                          "totalCount": len(entries)}
        milestones_response = (milestones_response if milestones_response
                               is not None else
                               {"ok": True, "milestones": [], "totalCount": 0})

        def fake_get(path, *args, **kwargs):
            return queue_response if path.startswith(QUEUE_PATH) else milestones_response

        argv = ["queue", "--project-dir", self.tmpdir] + list(extra_argv or [])
        with mock.patch.object(self.module, "_get", side_effect=fake_get,
                               create=True), \
                mock.patch.object(self.module, "_post", return_value={"ok": True},
                                  create=True), \
                mock.patch.object(self.module, "_patch", return_value=None,
                                  create=True):
            code, out, err = _run_main(self.module, argv)
        return code, self.decode(out), out, err

    def decode(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIsInstance(
            decoded, dict,
            f"stdout must decode as a TOON document; got {stdout_text!r}")
        self.assertIn(
            "axi", decoded,
            f"stdout must carry the fleet's TOON-AXI envelope; got "
            f"{stdout_text!r}")
        return decoded["axi"]

    def before_dep_warnings(self, axi):
        return [w for w in (axi.get("warnings") or [])
                if w.get("code") == "before-its-dependency"]


class QueueFieldsAddPlaceInPlanColumnsTest(_QueueFieldsHarness):
    """AC1 -- `--fields release,seq,points,dependsOn` (and `--full`) ADD
    those four columns AFTER today's six default ones, in the REQUESTED
    order, uniform and primitive; unrequested, the table stays exactly
    today's six. RED today: `queue` has no `--fields`/`--full` flag."""

    def test_default_stays_six_columns_while_fields_request_adds_the_place_in_plan_extras(self):
        entries = [
            _entry("FIELDS-1", wave="4", status="PENDING",
                   title="wants its place in the plan shown",
                   depends_on=["FIELDS-0"], release="9.9.9", seq=11,
                   points=5),
            _entry("FIELDS-2", wave="4", status="PENDING", seq=12),
        ]

        code_default, axi_default, _out, err_default = self.drive(entries)
        self.assertEqual(
            code_default, 0,
            f"a plain `queue` run must still succeed; got exit "
            f"{code_default}, stderr={err_default!r}")
        default_row = axi_default.get("queue")[0]
        self.assertEqual(
            set(default_row.keys()),
            {"cr", "wave", "status", "planId", "title", "lifecycle"},
            f"with no --fields/--full the table must stay EXACTLY today's "
            f"six columns; got {default_row!r}")

        code, axi, out, err = self.drive(
            entries, extra_argv=["--fields", "release,seq,points,dependsOn"])

        self.assertEqual(
            code, 0,
            f"`queue --fields release,seq,points,dependsOn` must succeed; "
            f"got exit {code}, stderr={err!r}, stdout={out!r}")
        rows = axi.get("queue")
        self.assertEqual(len(rows), 2, f"got {rows!r}")
        row1, row2 = rows
        self.assertEqual(
            list(row1.keys()),
            ["cr", "wave", "status", "planId", "title", "lifecycle",
             "release", "seq", "points", "dependsOn", "warning"],
            f"the four requested columns must land AFTER the six default "
            f"ones, in release/seq/points/dependsOn order; got "
            f"{list(row1.keys())!r}")
        self.assertEqual(
            frozenset(row1.keys()), frozenset(row2.keys()),
            f"both rows must carry the SAME key set even though row2 "
            f"declares no release/points/dependencies; got {rows!r}")
        self.assertEqual(row1["release"], "9.9.9", f"got {row1!r}")
        self.assertEqual(row1["seq"], 11, f"got {row1!r}")
        self.assertEqual(row1["points"], 5, f"got {row1!r}")
        self.assertEqual(row1["dependsOn"], "FIELDS-0", f"got {row1!r}")
        self.assertIsNone(row2["release"], f"got {row2!r}")
        self.assertIsNone(row2["points"], f"got {row2!r}")
        self.assertEqual(
            row2["dependsOn"], "",
            f"a cr with no dependencies must publish an empty string, "
            f"never null; got {row2!r}")

    def test_full_flag_adds_the_same_four_place_in_plan_columns(self):
        entries = [
            _entry("FULL-1", wave="5", status="PENDING",
                   title="checked with --full", depends_on=["FULL-0"],
                   release="9.9.9", seq=21, points=2),
        ]

        code, axi, out, err = self.drive(entries, extra_argv=["--full"])

        self.assertEqual(
            code, 0,
            f"`queue --full` must succeed; got exit {code}, "
            f"stderr={err!r}, stdout={out!r}")
        row = axi.get("queue")[0]
        self.assertEqual(
            list(row.keys()),
            ["cr", "wave", "status", "planId", "title", "lifecycle",
             "release", "seq", "points", "dependsOn", "warning"],
            f"--full must carry every column including the four "
            f"place-in-plan ones; got {list(row.keys())!r}")
        self.assertEqual(row["release"], "9.9.9", f"got {row!r}")
        self.assertEqual(row["seq"], 21, f"got {row!r}")
        self.assertEqual(row["points"], 2, f"got {row!r}")
        self.assertEqual(row["dependsOn"], "FULL-0", f"got {row!r}")

    def test_fields_request_adds_only_the_requested_subset_in_the_requested_order(self):
        entries = [
            _entry("SUBSET-1", wave="6", status="PENDING",
                   depends_on=["SUBSET-0"], release="2.0.0", seq=31,
                   points=13),
        ]

        code, axi, out, err = self.drive(
            entries, extra_argv=["--fields", "points,release"])

        self.assertEqual(
            code, 0,
            f"`queue --fields points,release` must succeed; got exit "
            f"{code}, stderr={err!r}, stdout={out!r}")
        row = axi.get("queue")[0]
        self.assertEqual(
            list(row.keys()),
            ["cr", "wave", "status", "planId", "title", "lifecycle",
             "points", "release", "warning"],
            f"--fields ADDS exactly the requested columns, in the "
            f"REQUESTED order, after the six default ones -- never all "
            f"four, never reordered to the canonical release/seq/points/"
            f"dependsOn order; got {list(row.keys())!r}")
        self.assertNotIn("seq", row, f"got {row!r}")
        self.assertNotIn("dependsOn", row, f"got {row!r}")


class QueueWarnsWhenARowPrecedesItsDependencyTest(_QueueFieldsHarness):
    """AC2 -- rows stay in the board's published order (never re-sorted);
    when the place-in-plan columns are asked for, a row placed before one
    of its dependencies carries a `warning` cell naming it, and the
    envelope's `warnings[]` carries one structured {code:
    "before-its-dependency", detail} entry per such row (Gap analysis
    DRIFT-3). RED today: `queue` computes no such thing at all -- there is
    no `warning` key and no such warning code, and --fields/--full do not
    even exist yet."""

    def test_a_row_before_its_dependency_carries_a_warning_cell_and_a_structured_warning(self):
        entries = [
            _entry("CR-SEQ-DEPENDENT", wave="3", status="PENDING", seq=1,
                   depends_on=["CR-SEQ-BASE"]),
            _entry("CR-SEQ-BASE", wave="3", status="COMPLETED", seq=2,
                   plan_id=77),
        ]

        code, axi, out, err = self.drive(
            entries, extra_argv=["--fields", "release,seq,points,dependsOn"])

        self.assertEqual(
            code, 0, f"got exit {code}, stderr={err!r}, stdout={out!r}")
        rows = axi.get("queue")
        dependent_row, base_row = rows[0], rows[1]
        self.assertIn("warning", dependent_row, f"got {dependent_row!r}")
        self.assertIn(
            "before its dependency", dependent_row["warning"],
            f"a row placed before its dependency must name the fact; got "
            f"{dependent_row!r}")
        self.assertIn(
            "CR-SEQ-BASE", dependent_row["warning"],
            f"the warning cell must name the offending dependency's id; "
            f"got {dependent_row!r}")
        self.assertEqual(
            base_row.get("warning"), "",
            f"a row with no late dependency must carry an EMPTY warning "
            f"cell -- never null, never omitted; got {base_row!r}")

        structured = self.before_dep_warnings(axi)
        self.assertEqual(
            len(structured), 1,
            f"exactly one envelope warning for the one offending row; got "
            f"{axi.get('warnings')!r}")
        detail = structured[0].get("detail", "")
        self.assertIn("CR-SEQ-DEPENDENT", detail, f"got {structured!r}")
        self.assertIn("CR-SEQ-BASE", detail, f"got {structured!r}")

    def test_the_cr_cru_171_incident_shape_a_pending_cr_sent_above_the_merged_cr_it_depends_on(self):
        """Gap analysis AC2 -- "the shape of the CR-CRU-171 sequencing
        incident (pending CRs sent above merged ones)": a PENDING cr's row
        sits ABOVE the already-merged cr it depends on."""
        entries = [
            _entry("CR-171-PENDING", wave="7", status="PENDING", seq=1,
                   depends_on=["CR-171-MERGED"]),
            _entry("CR-171-MERGED", wave="7", status="COMPLETED", seq=2,
                   plan_id=900),
        ]

        code, axi, out, err = self.drive(entries, extra_argv=["--full"])

        self.assertEqual(code, 0, f"got exit {code}, stderr={err!r}")
        pending_row = axi.get("queue")[0]
        self.assertEqual(
            pending_row.get("cr"), "CR-171-PENDING",
            f"the published order must stay the board's order, never "
            f"re-sorted -- the pending cr still sits first; got "
            f"{axi.get('queue')!r}")
        self.assertIn(
            "CR-171-MERGED", pending_row.get("warning") or "",
            f"a pending cr sent above the merged cr it depends on must "
            f"carry a warning naming it; got {pending_row!r}")
        codes = [w.get("code") for w in self.before_dep_warnings(axi)]
        self.assertIn(
            "before-its-dependency", codes,
            f"got {axi.get('warnings')!r}")

    def test_no_warning_when_every_dependency_already_precedes_its_row(self):
        entries = [
            _entry("CR-OK-BASE", wave="3", status="COMPLETED", seq=1,
                   plan_id=5),
            _entry("CR-OK-DEPENDENT", wave="3", status="PENDING", seq=2,
                   depends_on=["CR-OK-BASE"]),
        ]

        code, axi, out, err = self.drive(
            entries, extra_argv=["--fields", "release,seq,points,dependsOn"])

        self.assertEqual(code, 0, f"got exit {code}, stderr={err!r}")
        rows = axi.get("queue")
        for row in rows:
            self.assertEqual(
                row.get("warning"), "",
                f"no row here is placed before its dependency; every "
                f"warning cell must be empty; got {rows!r}")
        self.assertEqual(
            self.before_dep_warnings(axi), [],
            f"got {axi.get('warnings')!r}")

    def test_default_run_computes_no_warning_at_all_even_with_the_same_ordering_defect(self):
        """AC1's default-six-columns guarantee and AC2's gating together:
        the SAME entries that trigger a warning under --full must show no
        `warning` key and no before-its-dependency entry when neither
        --fields nor --full is given -- the dependency check is tied to
        asking for the place-in-plan columns, never ambient."""
        entries = [
            _entry("CR-GATE-DEPENDENT", wave="3", status="PENDING", seq=1,
                   depends_on=["CR-GATE-BASE"]),
            _entry("CR-GATE-BASE", wave="3", status="COMPLETED", seq=2,
                   plan_id=12),
        ]

        code_default, axi_default, _out, err_default = self.drive(entries)
        self.assertEqual(code_default, 0, f"got {err_default!r}")
        for row in axi_default.get("queue"):
            self.assertNotIn(
                "warning", row,
                f"the default six-column table must carry no `warning` "
                f"key at all; got {row!r}")
        self.assertEqual(
            self.before_dep_warnings(axi_default), [],
            f"got {axi_default.get('warnings')!r}")

        code_full, axi_full, out_full, err_full = self.drive(
            entries, extra_argv=["--full"])
        self.assertEqual(
            code_full, 0,
            f"the SAME ordering defect must surface once the "
            f"place-in-plan columns are asked for; got exit {code_full}, "
            f"stderr={err_full!r}, stdout={out_full!r}")
        offending = [r for r in axi_full.get("queue") if r.get("warning")]
        self.assertTrue(
            offending,
            f"expected at least one non-empty warning cell with --full; "
            f"got {axi_full.get('queue')!r}")


if __name__ == "__main__":
    unittest.main()
