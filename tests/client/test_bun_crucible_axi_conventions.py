"""CR-CRU-030 §S10-§S15 (cycle 83, C1 slice 3) -- the AXI-CLI conventions that
bring the fleet into full AXI-manifesto CLI compliance (https://axi.md),
pinned in `_crucible_axi.py` (shared) via the `bun-crucible.py` reference
client.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S10 -- "List/table verbs (§S6 `status`/`plans`, ...) return a MINIMAL
  default of 3-4 fields per item, with a `--fields <a,b,c>` flag to request
  more. The full field set stays reachable but is never the default (e.g.
  `status` defaults to `cr,wave,status,activeCycle[Id]`; `--fields` adds
  `mergeCommit,...,cycleCount`)."

  §S11 -- "Large text fields ... are truncated to a configurable limit in the
  envelope with a size hint `(truncated, <N> chars total -- use --full)`, and
  a `--full` flag emits the untruncated value."

  §S12 -- "Every list/table envelope carries a pre-computed `count` -- the
  TOTAL available ... Every verb that can return nothing emits an EXPLICIT
  zero-result envelope (`ok:true` + a definitive empty message ...), never
  empty stdout."

  §S13 -- "Errors are STRUCTURED and written to STDOUT as an `ok:false`
  envelope (carrying `warnings[]` + `help[]`), not only to human stderr ...
  Exit codes: `0` success, `1` error, `2` unknown/malformed flag. Mutating
  verbs are IDEMPOTENT where the server allows ... No verb prompts for
  interactive input."

  §S14 -- "Invoking a client with NO arguments returns the live board -- the
  §S6 `status` dashboard as a TOON-AXI envelope, NOT argparse help -- plus a
  one-line tool purpose and the executable path (with `~` for home)."

  §S15 -- "Every envelope carries a `help[]` array of concrete next-step
  command TEMPLATES -- fixed disambiguating flags carried forward, runtime
  values as placeholders (`<id>`/`<label>`/`<sha>`) ... E.g. after
  `plan-file`, `help[]` suggests `cycle-activate <id>`; after `cycle-done`,
  `cr-close --commit <sha>`."

Dispatch note (CR-CRU-030-C1-RED, slice 3): §S10-§S15 live in the SHARED
`_crucible_axi.py` module but this file pins them via `bun-crucible.py` (the
reference client) on REPRESENTATIVE verbs -- `status` (§S10/§S12),
`gate-report` (§S11 -- a genuinely large field: the server error/detail
string a failed gate POST can carry), `cycle-activate`/`register` (§S13),
no-args (§S14), and `plan-file`/`cycle-done` (§S15, asserting the EXACT
placeholder templates the CR spec itself gives as examples).

Two design choices this file PINS as the RED contract (the CR text does not
give exact numbers/strings, so this slice fixes them for GREEN to implement):
  - §S11's truncation limit is 200 chars of visible content before the hint
    suffix is appended (the CR gives no number; 200 is this slice's choice).
  - §S14's one-line purpose is the literal string `_DASHBOARD_PURPOSE_LINE`
    below (again, this slice's choice -- GREEN must print this exact line).
  - §S13/§S15's `help[]` entries are CLIENT-GENERATED static next-step
    strings (never parsed out of a server error body -- confirmed by reading
    `_request`: an HTTP error surfaces only as an opaque
    `{"ok": False, "error": "HTTP <code>: <body>"}` string; see
    test_bun_crucible_workflow_verbs.py's header note on this same point).

RED phase: `clients/bun-crucible.py` today has NO `--fields`/`--full` flags,
NO `count`/`help` envelope keys, and NO no-arg dashboard branch (a bare
invocation hits `sub = p.add_subparsers(dest="cmd", required=True)` and
argparse errors with `SystemExit(2)`) -- confirmed by reading `main()` and
every `cmd_*`/`_emit_axi`/`build_status_rows` call site directly. Every test
below is a real RED (missing flag -> `SystemExit(2)`, or a decoded envelope
missing the pinned key), not a typo.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
harnesses in this directory -- REPO_ROOT-relative load of
`clients/bun-crucible.py`, real `argparse` dispatch via `module.main()` with
`sys.argv` patched, and mocking the module's `_get`/`_post`/`_patch` HTTP
transport seams so the live server at :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_axi_conventions.py -q
Fallback:
    python3 tests/client/test_bun_crucible_axi_conventions.py
"""

import ast
import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# CR-CRU-075 §S1 — the fleet's established AST readers for "which verbs does
# this client register, and through what?", reused rather than re-derived.
from tests.client.test_cr054_fleet_inventory import (
    _add_parser_verb_names,
    _defined_function_names,
    _single_verb_registrar_delegator,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# CR-CRU-030 C2 (cycle 84) -- fixtures for HelpArrayCoverageTest's ingest-verb
# help[] tests below (test/regression need a fake `bun` executable, same
# technique as test_bun_crucible_auto_attach.py / test_bun_crucible_toon_envelope.py).
_HELP_COVERAGE_PASS_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="toon.test.ts" tests="1" failures="0">
<testcase name="passes" time="0.001"></testcase>
</testsuite>
</testsuites>
"""

_HELP_COVERAGE_FAKE_BUN_SCRIPT_TEMPLATE = """#!{python}
import os
import sys

outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]

content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)

sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""

# §S14 -- the exact one-line purpose string this slice pins (GREEN must print
# this verbatim as part of the no-arg dashboard's human-readable output).
_DASHBOARD_PURPOSE_LINE = (
    "bun-crucible.py -- Bun/TypeScript Crucible CLI "
    "(agent lifecycle, test/ingest, plan/cycle verbs)."
)


def _load_bun_crucible_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_axi_conv", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["bun-crucible.py"] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _plans_response(plans):
    return {"ok": True, "plans": plans}


class _BaseAxiConventionsTest(unittest.TestCase):
    PROJECT_KEY = "test-key-axi-conventions"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "BUN_CRUCIBLE_PROJECT_DIR")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-axi-conv-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got {decoded!r} from stdout={stdout_text!r}")
        return decoded["axi"]

    def _row_for_cr(self, rows, cr):
        matches = [r for r in rows if r.get("cr") == cr]
        self.assertEqual(len(matches), 1, f"expected exactly one row for cr={cr!r} in {rows!r}")
        return matches[0]


# ── §S10 -- minimal default schemas + --fields ──────────────────────────────


class MinimalDefaultFieldsTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-fields"

    def _two_plan_fixture(self):
        return _plans_response([
            {"planId": "plan-1", "cr": "CR-A", "wave": "3", "status": "open",
             "cycles": [{"id": 10, "label": "c1", "kind": "red-green", "status": "pending"},
                        {"id": 11, "label": "c2", "kind": "red-green", "status": "active"}]},
            {"planId": "plan-2", "cr": "CR-B", "wave": "2", "status": "closed",
             "cycles": [{"id": 20, "label": "c1", "kind": "red-green", "status": "done"}],
             "merge": {"commit": "deadbee"}, "closedAt": 1000},
        ])

    def test_status_default_rows_carry_only_the_minimal_four_field_set(self):
        with mock.patch.object(self.module, "_get", return_value=self._two_plan_fixture()):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        rows = axi.get("plans")
        self.assertIsInstance(rows, list)
        self.assertEqual(len(rows), 2)

        expected_keys = {"cr", "wave", "status", "activeCycleId"}
        for row in rows:
            self.assertEqual(
                set(row.keys()), expected_keys,
                f"§S10: the DEFAULT status row must carry ONLY the minimal "
                f"{sorted(expected_keys)} field set -- the full field set "
                f"(activeCycleLabel/mergeCommit) must NEVER be the default; "
                f"got keys={sorted(row.keys())} from row={row!r}"
            )

        row_a = self._row_for_cr(rows, "CR-A")
        self.assertEqual(str(row_a.get("wave")), "3")
        self.assertEqual(row_a.get("status"), "open")
        self.assertEqual(row_a.get("activeCycleId"), 11)

    def test_status_fields_flag_returns_the_requested_superset(self):
        with mock.patch.object(self.module, "_get", return_value=self._two_plan_fixture()):
            code, out, err = _run_main(
                self.module,
                ["status", "--fields", "mergeCommit,activeCycleLabel", "--project-dir", self.tmpdir],
            )

        self.assertEqual(code, 0, f"§S10: --fields must be a recognized flag on `status`, "
                                  f"returning the requested superset; stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        rows = axi.get("plans")
        self.assertIsInstance(rows, list)

        expected_keys = {"cr", "wave", "status", "activeCycleId", "mergeCommit", "activeCycleLabel"}
        for row in rows:
            self.assertEqual(
                set(row.keys()), expected_keys,
                f"§S10: --fields must ADD the requested columns to the minimal "
                f"base set (never replace it); got keys={sorted(row.keys())} from row={row!r}"
            )

        row_a = self._row_for_cr(rows, "CR-A")
        self.assertEqual(row_a.get("activeCycleLabel"), "c2")
        self.assertIsNone(row_a.get("mergeCommit"),
                           "an OPEN plan must not fabricate a mergeCommit even under --fields")

        row_b = self._row_for_cr(rows, "CR-B")
        self.assertEqual(row_b.get("mergeCommit"), "deadbee")
        self.assertIsNone(row_b.get("activeCycleLabel"),
                           "a CLOSED plan (no active cycle) must report activeCycleLabel as null")


# ── §S11 -- content truncation + --full ─────────────────────────────────────


class TruncationFullTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-truncation"

    # §S11: no exact limit is given by the CR -- this slice pins 200 visible
    # chars before the size-hint suffix as the RED contract GREEN must satisfy.
    _LONG_ERROR = "E" * 3000

    def _base_gate_report_argv(self, extra=None):
        argv = ["gate-report", "--outcome", "failed", "--commit", "sha1",
                "--steps", "test:failed", "--agent", "test-agent",
                "--project-dir", self.tmpdir]
        return argv + (extra or [])

    def test_gate_report_large_error_field_is_truncated_by_default_with_size_hint(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": self._LONG_ERROR}):
            code, out, err = _run_main(self.module, self._base_gate_report_argv())

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        error_field = axi.get("error")
        self.assertIsNotNone(
            error_field,
            f"§S11: a failed gate-report's envelope must carry the server error "
            f"detail as an `error` field (truncated by default); got axi={axi!r}"
        )
        self.assertTrue(error_field.startswith(self._LONG_ERROR[:200]),
                         f"truncated error must be a PREFIX of the original; got {error_field!r}")
        self.assertLess(len(error_field), len(self._LONG_ERROR),
                         "the default error field must be strictly shorter than the original "
                         "3000-char text -- real truncation must have occurred")
        self.assertIn(
            f"(truncated, {len(self._LONG_ERROR)} chars total — use --full)", error_field,
            f"§S11: the truncated value must carry the exact size hint naming the "
            f"TOTAL original char count; got {error_field!r}"
        )

    def test_gate_report_full_flag_emits_the_untruncated_error_value(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": self._LONG_ERROR}):
            code, out, err = _run_main(self.module, self._base_gate_report_argv(["--full"]))

        self.assertEqual(code, 1, f"§S11: --full must be a recognized flag; stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(
            axi.get("error"), self._LONG_ERROR,
            "§S11: --full must emit the EXACT untruncated error value, no hint suffix"
        )

    def test_gate_report_short_error_is_never_spuriously_truncated(self):
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": "boom"}):
            code, out, err = _run_main(self.module, self._base_gate_report_argv())

        self.assertEqual(code, 1)
        axi = self._decode_axi(out)
        self.assertEqual(
            axi.get("error"), "boom",
            "§S11: a SHORT error (well under the truncation limit) must be emitted "
            "verbatim -- no fabricated size-hint suffix on content that was never cut"
        )


# ── §S12 -- pre-computed aggregates + definitive empty states ──────────────


class AggregatesCountTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-count"

    def test_status_count_is_the_total_plans_returned(self):
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-A", "wave": "1", "status": "open", "cycles": []},
            {"planId": "plan-2", "cr": "CR-B", "wave": "2", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(
            axi.get("count"), 2,
            f"§S12: every list/table envelope must carry a pre-computed `count` "
            f"(the TOTAL available); got axi={axi!r}"
        )

    def test_status_empty_queue_count_is_zero_with_definitive_message(self):
        with mock.patch.object(self.module, "_get", return_value=_plans_response([])):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, "an empty queue is NOT an error -- must exit 0")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plans"), [])
        self.assertEqual(
            axi.get("count"), 0,
            f"§S12: a zero-result envelope must still carry an explicit `count: 0`, "
            f"never omit the field; got axi={axi!r}"
        )
        combined = (out + err).lower()
        self.assertIn("no plan", combined,
                      "an empty queue must carry a DEFINITIVE empty-state message")


# ── §S13 -- structured errors on stdout + exit codes + idempotency ─────────


class StructuredErrorsExitCodesIdempotencyTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-errors"

    def test_forced_error_stdout_exit_codes_and_idempotency_for_mutating_verbs(self):
        # (1) An UNKNOWN/malformed flag exits 2 -- argparse's own default
        # behaviour; documented here as part of the pinned exit-code contract
        # (this sub-check already holds today).
        code_bad_flag, _out_bad, _err_bad = _run_main(
            self.module, ["status", "--not-a-real-flag", "--project-dir", self.tmpdir]
        )
        self.assertEqual(code_bad_flag, 2,
                         "§S13: an unknown flag must exit 2")

        # (2) Re-running a mutating verb (`register`) CONVERGES -- no spurious
        # error on the second call (also already holds today: the client adds
        # no client-side guard against re-registration).
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code1, _out1, _err1 = _run_main(
                self.module, ["register", "--role", "report", "--agent", "CR-TEST-1", "--project-dir", self.tmpdir]
            )
            code2, _out2, _err2 = _run_main(
                self.module, ["register", "--role", "report", "--agent", "CR-TEST-1", "--project-dir", self.tmpdir]
            )
        self.assertEqual(code1, 0)
        self.assertEqual(code2, 0,
                         "§S13: re-running `register` must converge, never error spuriously")

        # (3) A FORCED error (unknown cycle id) prints an ok:false envelope on
        # STDOUT and exits 1 -- AND that envelope must carry a `help[]` array
        # (§S13's own text: the ok:false envelope carries `warnings[]` +
        # `help[]`) -- THIS is the new, currently-missing behaviour.
        open_plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-A", "status": "open",
             "cycles": [{"id": 10, "label": "c1", "kind": "red-green", "status": "pending"}]},
        ])
        with mock.patch.object(self.module, "_get", return_value=open_plans):
            code3, out3, err3 = _run_main(
                self.module, ["cycle-activate", "999", "--agent", "test-agent",
                              "--project-dir", self.tmpdir]
            )
        self.assertEqual(code3, 1, f"stdout={out3!r} stderr={err3!r}")
        axi3 = self._decode_axi(out3)
        self.assertIs(axi3.get("ok"), False)
        help_list = axi3.get("help") or []
        self.assertGreater(
            len(help_list), 0,
            f"§S13: a forced-error envelope must carry a non-empty `help[]` "
            f"array (a next-step suggestion), not just `warnings[]`; got axi={axi3!r}"
        )


# ── §S14 -- content-first: no-arg live dashboard + executable path ─────────


class ContentFirstNoArgsTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-dashboard"

    def test_no_args_prints_status_dashboard_purpose_and_path_not_argparse_help(self):
        os.environ["BUN_CRUCIBLE_PROJECT_DIR"] = self.tmpdir
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-DASH", "wave": "1", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, [])

        self.assertEqual(
            code, 0,
            f"§S14: a bare invocation (no args) must print the live status "
            f"dashboard, NOT argparse's required-subcommand error; "
            f"stdout={out!r} stderr={err!r}"
        )
        combined = out + err
        self.assertNotIn("usage:", combined.lower(),
                         "§S14: a bare invocation must NOT fall through to argparse help/usage")

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "status",
                         "§S14: the no-arg dashboard IS the §S6 status envelope")
        self.assertEqual(len(axi.get("plans", [])), 1)

        self.assertIn(
            _DASHBOARD_PURPOSE_LINE, combined,
            f"§S14: the no-arg invocation must print a one-line tool purpose; "
            f"expected {_DASHBOARD_PURPOSE_LINE!r} in combined output {combined!r}"
        )

        home = str(Path.home())
        script_str = str(SCRIPT_PATH)
        expected_path_display = (
            "~" + script_str[len(home):] if script_str.startswith(home) else script_str
        )
        self.assertIn(
            expected_path_display, combined,
            f"§S14: the no-arg invocation must print the executable path, "
            f"~-abbreviated when under the home dir; expected "
            f"{expected_path_display!r} in combined output {combined!r}"
        )


# ── §S15 -- contextual disclosure: per-verb help[] next-step templates ─────


class HelpNextStepTemplatesTest(_BaseAxiConventionsTest):
    PROJECT_KEY = "test-key-help"

    def test_plan_file_help_suggests_the_cycle_activate_placeholder_template(self):
        resp = {
            "ok": True, "planId": "plan-9", "cr": "CR-HELP",
            "cycles": [{"label": "a", "id": 101}, {"label": "b", "id": 102}],
        }
        with mock.patch.object(self.module, "_post", return_value=resp):
            code, out, err = _run_main(
                self.module,
                ["plan-file", "--cr", "CR-HELP", "--cycles", "a,b",
                 "--agent", "test-agent", "--project-dir", self.tmpdir],
            )

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        help_list = axi.get("help") or []
        self.assertIn(
            "cycle-activate <id>", help_list,
            f"§S15: plan-file's help[] must suggest the literal `cycle-activate <id>` "
            f"template (the CR's own verbatim example); got help={help_list!r}"
        )

    def test_cycle_done_help_suggests_the_cr_close_commit_placeholder_template(self):
        open_plans = _plans_response([
            {"planId": "plan-3", "cr": "CR-HELP2", "status": "open",
             "cycles": [{"id": 55, "label": "c1", "kind": "red-green", "status": "active"}]},
        ])
        with mock.patch.object(self.module, "_get", return_value=open_plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}):
            code, out, err = _run_main(
                self.module, ["cycle-done", "55", "--agent", "test-agent",
                              "--project-dir", self.tmpdir]
            )

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        help_list = axi.get("help") or []
        self.assertIn(
            "cr-close --commit <sha>", help_list,
            f"§S15: cycle-done's help[] must suggest the literal "
            f"`cr-close --commit <sha>` template (the CR's own verbatim example); "
            f"got help={help_list!r}"
        )


# ── §S15 gap coverage (CR-CRU-030 C2, cycle 84) -- "every envelope carries a
# help[] array", but only plan-file/cycle-activate/cycle-done do today
# (confirmed by reading every cmd_* / _emit_axi call site directly). This
# class extends coverage to the verbs still missing help[] entirely.


class HelpArrayCoverageTest(_BaseAxiConventionsTest):
    """§S15 verbatim: "Every envelope carries a `help[]` array of concrete
    next-step command TEMPLATES ... The envelope always names the sane next
    move, so the orchestrator cannot lose the process thread." Today
    `register`, `unregister`, `cycle-add`, `checkpoint`, `stop`, `abort`,
    `status`, `cr-close`, `check`, and the three ingest verbs (`test`/
    `regression`/`auto-ingest`) never set a `help` result field at all, so
    `axi.get("help")` is always None/absent for them -- a real behavioral
    RED (not a missing-symbol accident): each test below would still fail
    against a no-op stub that merely returns ok:True."""

    PROJECT_KEY = "test-key-help-coverage"

    def _open_plan(self, plan_id="plan-help", cr="CR-HELP", cycles=None):
        return _plans_response([
            {"planId": plan_id, "cr": cr, "status": "open", "cycles": cycles or []},
        ])

    def _help_list(self, out):
        axi = self._decode_axi(out)
        return axi, (axi.get("help") or [])

    def test_register_help_suggests_the_test_agent_placeholder_template(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "77"
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "register", "--role", "report", "--agent", "CR-HELP-1", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        _axi, help_list = self._help_list(out)
        self.assertIn(
            "test --agent <agentId>", help_list,
            f"§S15: register's help[] must suggest the next-step "
            f"`test --agent <agentId>` template; got help={help_list!r}"
        )

    def test_unregister_help_is_present_and_nonempty(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "unregister", "--agent", "CR-HELP-1", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: unregister's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_cycle_add_help_suggests_the_cycle_activate_placeholder_template(self):
        plans = self._open_plan(cycles=[])
        resp = {"ok": True, "id": 42, "label": "newlabel", "kind": "red-green",
                "status": "pending"}
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post", return_value=resp):
            code, out, err = _run_main(self.module, [
                "cycle-add", "newlabel", "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        _axi, help_list = self._help_list(out)
        self.assertIn(
            "cycle-activate <id>", help_list,
            f"§S15: cycle-add's help[] must suggest the `cycle-activate <id>` "
            f"template (the CR's own example); got help={help_list!r}"
        )

    def test_checkpoint_help_is_present_and_nonempty(self):
        plans = self._open_plan()
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               return_value={"ok": True, "changed": True}):
            code, out, err = _run_main(self.module, [
                "checkpoint", "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: checkpoint's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_stop_help_is_present_and_nonempty(self):
        with mock.patch.object(self.module, "_post",
                               return_value={"ok": True, "checkpointed": 1}):
            code, out, err = _run_main(self.module, [
                "stop", "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: stop's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_abort_help_is_present_and_nonempty(self):
        plans = self._open_plan()
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               return_value={"ok": True, "changed": True,
                                             "plan": {"planId": "plan-help",
                                                       "status": "aborted"}}):
            code, out, err = _run_main(self.module, [
                "abort", "--user-approved", "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: abort's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_status_help_is_present_and_nonempty(self):
        plans = self._open_plan()
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: status's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_cr_close_help_is_present_and_nonempty(self):
        plans = self._open_plan()
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}), \
             mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "cr-close", "--commit", "abc123", "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: cr-close's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def test_check_help_is_present_and_nonempty(self):
        result = subprocess.CompletedProcess(
            args=["bun", "x", "tsc", "--noEmit"], returncode=0, stdout="", stderr="")
        with mock.patch.object(self.module.subprocess, "run", return_value=result):
            code, out, err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: check's envelope must carry a non-empty help[]; got axi={axi!r}"
        )

    def _write_fake_bun(self):
        fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(fake_bun, "w") as f:
            f.write(_HELP_COVERAGE_FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(fake_bun, 0o755)
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _HELP_COVERAGE_PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        return fake_bun

    def test_test_verb_help_is_present_and_nonempty(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "77"
        fake_bun = self._write_fake_bun()
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "test", "--bun", fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", "CR-HELP-test",
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: the `test` ingest verb's envelope must carry a non-empty "
            f"help[]; got axi={axi!r}"
        )

    def test_regression_verb_help_is_present_and_nonempty(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "77"
        fake_bun = self._write_fake_bun()
        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "regression", "--bun", fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", "CR-HELP-regression",
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: the `regression` ingest verb's envelope must carry a "
            f"non-empty help[]; got axi={axi!r}"
        )

    def test_auto_ingest_verb_help_is_present_and_nonempty(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "77"
        reports_dir = os.path.join(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "junit.xml"), "w") as f:
            f.write(_HELP_COVERAGE_PASS_JUNIT_XML)

        with mock.patch.object(self.module, "_post", return_value={"ok": True}):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-HELP-auto",
                "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
                "--reports", "reports",
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi, help_list = self._help_list(out)
        self.assertGreater(
            len(help_list), 0,
            f"§S15: the `auto-ingest` verb's envelope must carry a non-empty "
            f"help[]; got axi={axi!r}"
        )


# ═══════════════════════════════════════════════════════════════════════════
# CR-CRU-075 §S1 (AC1/AC2/AC6) — `queue-file` reaches THIS client too
#
# CR-CRU-014 §S2 shipped `queue-file` on python-crucible.py alone. The shared
# `_crucible_axi.cmd_queue_file` / `parse_queue_table` were fleet-available
# from the start; only the verb SURFACE was not, so an orchestrator on any
# other stack gets argparse's `invalid choice: 'queue-file'` — a bare
# SystemExit(2) — where every other workflow verb answers with an envelope
# (AXI principle 6, CR-CRU-030 §S13).
#
# Asserted HERE, in this client's own suite, rather than as one fleet-wide set
# comparison: a five-for-five that fails must NAME the client that lost the
# verb, not report "expected 5, got 4". The shared registrar's own contract
# lives in `test_crucible_axi_shared.py`; the frozen inventory set and the
# derived registrar-parity sweep are §S2's, in
# `test_cr054_fleet_inventory.py`.
#
# The fixture's CR ids live in module constants and are never spelled inside
# an assertion (CR-CRU-097 §S1's residue rule), in a namespace this section
# invents so no board id can decay here.
# ═══════════════════════════════════════════════════════════════════════════

_QUEUE_FILE_ALPHA = "CR-QF-1"
_QUEUE_FILE_BETA = "CR-QF-2"

# Two rows exercising the parse's real conventions: an em-dash "depends on
# nothing" cell, a Wave cell with a parenthetical (`5 (0.2.0)` → `5`), and a
# bare dependency number normalised to a full id from its own row's namespace.
_QUEUE_FILE_TABLE = (
    "# Queue\n\n"
    "| CR | Title | Type | Status | Depends on | Wave |\n"
    "|---|---|---|---|---|---|\n"
    f"| [{_QUEUE_FILE_ALPHA}](alpha.md) | Alpha | patch | PENDING | — | 5 (0.2.0) |\n"
    f"| [{_QUEUE_FILE_BETA}](beta.md) | Beta | patch | PENDING | 1 | 6 |\n"
)

# The second row is missing its Wave cell (5 columns against the header's 6)
# — §S2's malformed row, which must fail LOUDLY and POST nothing.
_QUEUE_FILE_MALFORMED_TABLE = (
    "# Queue\n\n"
    "| CR | Title | Type | Status | Depends on | Wave |\n"
    "|---|---|---|---|---|---|\n"
    f"| [{_QUEUE_FILE_ALPHA}](alpha.md) | Alpha | patch | PENDING | — | 5 |\n"
    f"| [{_QUEUE_FILE_BETA}](beta.md) | Beta | patch | PENDING | 1 |\n"
)

# What the shared parser must make of `_QUEUE_FILE_TABLE`.
_QUEUE_FILE_ENTRIES = [
    {"cr": _QUEUE_FILE_ALPHA, "title": "Alpha", "wave": "5", "dependsOn": []},
    {"cr": _QUEUE_FILE_BETA, "title": "Beta", "wave": "6",
     "dependsOn": [_QUEUE_FILE_ALPHA]},
]


class BunCrucibleQueueFileVerbTest(_BaseAxiConventionsTest):
    """AC1/AC2 — what a caller on THIS client observes: the table is parsed,
    the whole set is POSTed once to §S1's full-replace endpoint, and BOTH
    failure paths answer with a structured `ok:false` envelope on stdout."""

    def _source(self, name, text):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def _queue_path(self):
        return f"/api/v2/projects/{self.PROJECT_KEY}/queue"

    def _run_queue_file(self, source, post_return=None):
        post_return = post_return if post_return is not None else {
            "ok": True, "unknownDependencies": []}
        argv = ["queue-file", "--project-dir", self.tmpdir,
                "--from-file", source]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                               create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=None,
                               create=True), \
             mock.patch.object(self.module, "_patch", return_value=None,
                               create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, patch_mock

    def _assert_structured_failure(self, code, out, err, post_mock, cause):
        """AC2, per client — AXI principle 6 (CR-CRU-030 §S13): a failure is a
        STRUCTURED envelope on STDOUT carrying a non-empty `help[]`, never a
        raw argparse usage error and never a traceback."""
        combined = out + err
        self.assertNotIn(
            "invalid choice", combined,
            f"{SCRIPT_PATH.name} must EXPOSE `queue-file` (§S1 fleet parity) — "
            f"argparse rejecting the subcommand is the bare SystemExit(2) AXI "
            f"principle 6 forbids; stdout={out!r} stderr={err!r}")
        self.assertNotIn(
            "Traceback (most recent call last)", combined,
            f"a failing `queue-file` must never surface a traceback; "
            f"stdout={out!r} stderr={err!r}")
        self.assertNotEqual(
            code, 0,
            f"a failed `queue-file` must exit non-zero (§S13); stdout={out!r}")
        self.assertEqual(
            post_mock.call_args_list, [],
            f"nothing may be POSTed when the source cannot be parsed or read "
            f"— a partial registration is a silent mis-registration; "
            f"calls={post_mock.call_args_list!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "queue-file")
        self.assertIs(
            axi.get("ok"), False,
            f"the failure envelope must carry ok:false; got {axi!r}")
        self.assertIn(
            cause, str(axi.get("error", "")),
            f"the envelope's `error` must NAME the cause so the failure is "
            f"actionable; got {axi!r}")
        help_steps = axi.get("help")
        self.assertIsInstance(
            help_steps, list,
            f"AXI principle 6 (§S13): an ok:false envelope carries "
            f"a `help[]` array of concrete next steps, on STDOUT; got {axi!r}")
        self.assertGreater(
            len(help_steps), 0,
            f"the `help[]` array must be NON-EMPTY — an empty one tells the "
            f"caller nothing; got {axi!r}")
        return axi

    def test_queue_file_parses_the_table_and_posts_the_whole_set_once_with_a_toon_envelope(self):
        source = self._source("queue.md", _QUEUE_FILE_TABLE)
        code, out, err, post_mock, patch_mock = self._run_queue_file(source)
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        queue_posts = [call for call in post_mock.call_args_list
                       if (call[0][0] if call[0] else None) == self._queue_path()]
        self.assertEqual(
            len(queue_posts), 1,
            f"§S1's `/queue` is a FULL REPLACE — `queue-file` POSTs the whole "
            f"set exactly ONCE to {self._queue_path()}; "
            f"calls={post_mock.call_args_list!r}")
        patch_mock.assert_not_called()
        self.assertEqual(
            queue_posts[0][0][1].get("entries"), _QUEUE_FILE_ENTRIES,
            f"the POST body must carry every parsed row verbatim — wave from "
            f"the Wave cell's leading integer, dependsOn normalised to full "
            f"ids; got {queue_posts[0][0][1]!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "queue-file")
        self.assertIs(axi.get("ok"), True, f"got {axi!r}")
        self.assertEqual(
            axi.get("context", {}).get("projectKey"), self.PROJECT_KEY,
            f"the envelope's context must name the project the set was "
            f"registered against; got {axi!r}")

    def test_queue_file_malformed_row_fails_loudly_with_a_structured_envelope(self):
        source = self._source("broken.md", _QUEUE_FILE_MALFORMED_TABLE)
        code, out, err, post_mock, _patch = self._run_queue_file(source)
        self._assert_structured_failure(
            code, out, err, post_mock, _QUEUE_FILE_BETA)

    def test_queue_file_unreadable_source_fails_with_a_structured_envelope(self):
        absent = os.path.join(self.tmpdir, "absent-queue.md")
        code, out, err, post_mock, _patch = self._run_queue_file(absent)
        self._assert_structured_failure(code, out, err, post_mock, absent)


class BunCrucibleQueueFileRegistrationTest(unittest.TestCase):
    """AC1 — HOW this client wires the verb, read from its AST so a name in a
    docstring or a help string can never be mistaken for a registration. The
    readers are `test_cr054_fleet_inventory.py`'s, reused."""

    def test_the_client_defines_one_cmd_queue_file_delegating_to_the_shared_implementation(self):
        """AC1's delegator and AC6's DRY half in one: a body longer than the
        single `return _axi().cmd_queue_file(...)` means the parse or the POST
        leaked back into a client."""
        counts = _defined_function_names(SCRIPT_PATH)
        self.assertEqual(
            counts.get("cmd_queue_file", 0), 1,
            f"{SCRIPT_PATH.name} must define `cmd_queue_file` exactly once "
            f"(§S1 fleet parity; a duplicate def would silently make the "
            f"SECOND one win at import time); defined "
            f"{counts.get('cmd_queue_file', 0)}x")
        node = next(n for n in ast.walk(ast.parse(SCRIPT_PATH.read_text()))
                    if isinstance(n, ast.FunctionDef)
                    and n.name == "cmd_queue_file")
        body = [stmt for stmt in node.body
                if not (isinstance(stmt, ast.Expr)
                        and isinstance(stmt.value, ast.Constant))]
        self.assertEqual(
            len(body), 1,
            f"the delegator is THIN — exactly one `return` (§S1 is wiring, not "
            f"a re-implementation); got {len(body)} statement(s)")
        self.assertIsInstance(
            body[0], ast.Return,
            f"the delegator's one statement must RETURN the shared verb's "
            f"exit code; got {ast.dump(body[0])!r}")
        self.assertIsInstance(
            body[0].value, ast.Call,
            f"the delegator must return a CALL into the shared module; "
            f"got {ast.dump(body[0])!r}")
        self.assertEqual(
            getattr(body[0].value.func, "attr", None), "cmd_queue_file",
            f"the delegator must call the SHARED "
            f"`_crucible_axi.cmd_queue_file`, never a local copy; "
            f"got {ast.dump(body[0].value.func)!r}")

    def test_the_client_registers_queue_file_through_the_shared_registrar(self):
        delegator = _single_verb_registrar_delegator(
            SCRIPT_PATH, "add_queue_file_verb")
        self.assertEqual(
            delegator, "cmd_queue_file",
            f"{SCRIPT_PATH.name} must register the verb by handing its OWN "
            f"delegator to the shared `_crucible_axi.add_queue_file_verb` — "
            f"the `add_next_verb` / `add_cr_depends_verb` shape; "
            f"got {delegator!r}")

    def test_the_client_hand_rolls_no_queue_file_subparser(self):
        """§S1's correction: one client built its own `add_parser` for this
        verb, which forks the flag surface the shared registrar exists to keep
        identical. After §S1 no client spells it — that one included."""
        self.assertNotIn(
            "queue-file", _add_parser_verb_names(SCRIPT_PATH),
            f"the `queue-file` subparser is built ONCE, by "
            f"`_crucible_axi.add_queue_file_verb`; {SCRIPT_PATH.name} spells "
            f"its own")


if __name__ == "__main__":
    unittest.main()
