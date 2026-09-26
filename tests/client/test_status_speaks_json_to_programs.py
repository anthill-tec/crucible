# RED note: `_FormatFlagTestBase`/`_FormatJsonMatchesToonTests`/etc. are a plain
# multiple-inheritance MIXIN group (test_cr022_points_declaration.py's own
# shape, itself citing test_cr091_roadmap_verbs.py) -- deliberately NOT
# inheriting unittest.TestCase individually so discovery never collects the
# abstract halves. A static checker cannot see the attributes each mixin
# borrows from its siblings until they are combined in the five concrete
# unittest.TestCase subclasses below, where they are real; this repo-wide,
# established pattern is the reason for the pragma.
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false
"""RED — §S8/AC11: `status --format json` (and its alias `plans --format json`)
must write exactly one JSON object to stdout whose keys and values equal the
`axi` object of the SAME invocation run with `--format toon`, on all four
exit paths (work in flight, none open, never filed, unavailable), in each of
the five stack clients. `--format toon` and no flag stay today's TOON output;
any other `--format` value is refused by ARGUMENT PARSING (argparse
`choices`), never accepted or refused downstream. The `status`/`plans` help
text and each client's `cmd_status` docstring must name the open plans,
`filed` and `--format`, and no longer describe the unfiltered plan list.

RED-phase note (verified by reading the argparse wiring in all five clients):
none of the five `status`/`plans` subparsers defines a `--format` argument
today, so EVERY invocation below that passes `--format <anything>` fails at
`parse_args()` with an "unrecognized arguments: --format ..." `SystemExit(2)`
— a real RED (the flag does not exist), not a typo or import error. The one
exception is the bare no-flag drive, which already succeeds today (today's
TOON behaviour is unchanged by this cycle) — noted per-test below.

Harness convention copied from the sibling fleet harnesses in this
directory: real `argparse` dispatch via `module.main()` with `sys.argv`
patched, the module's own `_get` transport seam mocked so the live server is
never touched, and the module's own lazily-loaded TOON codec (`_toon()`) used
to decode the TOON side of each comparison — never a second, independently
loaded codec that could silently drift from what the client itself uses.
"""

import ast
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
from tests.client.test_cr054_fleet_inventory import (
    CLIENT_FILES,
    _status_verb_registration,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

# The env keys the fleet's `context` block reads — cleared per-test so an
# ambient orchestrator session can never colour an envelope this file
# compares (the fleet's own established precaution).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

# The per-client `$<X>_CRUCIBLE_PROJECT_DIR` env var each client's own
# `--project-dir` resolver falls back to (confirmed by reading each
# resolver) — used ONLY by the dashboard test below, which drives the
# no-argument path where `--project-dir` cannot be passed at all.
PROJECT_DIR_ENV_VAR = {
    "python": "PY_CRUCIBLE_PROJECT_DIR",
    "bun": "BUN_CRUCIBLE_PROJECT_DIR",
    "rust": "RUST_CRUCIBLE_PROJECT_DIR",
    "mvn": "MVN_CRUCIBLE_PROJECT_DIR",
    "arduino": "ARDUINO_CRUCIBLE_PROJECT_DIR",
}


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


def _plans_response(plans, *, last_closed_cr=None, filed=0):
    """Every `GET .../plans` response carries the two server-published,
    project-wide facts (`lastClosedCr`/`filed`) alongside `plans`."""
    return {"ok": True, "plans": plans, "lastClosedCr": last_closed_cr, "filed": filed}


# §S4/§S5 — the four exit paths AC11 names, as fixed `_get` return values.
_WORK_IN_FLIGHT = _plans_response(
    [{"planId": "plan-1", "cr": "CR-T-100", "wave": "3", "status": "open", "cycles": []}],
    last_closed_cr="CR-T-050", filed=3)
_NONE_OPEN = _plans_response([], last_closed_cr="CR-T-060", filed=4)
_NEVER_FILED = _plans_response([], last_closed_cr=None, filed=0)
_UNAVAILABLE = {"ok": False, "error": "connection failed"}

BOARD_STATES = {
    "work-in-flight": _WORK_IN_FLIGHT,
    "none-open": _NONE_OPEN,
    "never-filed": _NEVER_FILED,
    "unavailable": _UNAVAILABLE,
}

_ENVELOPE_KEYS = ("verb", "ok", "tier", "plans", "lastClosedCr", "count", "filed",
                  "help", "context", "warnings")

# The verbatim help-text fragment every one of the five clients advertises
# TODAY (confirmed by reading all five `status`/`plans` `add_parser(help=...)`
# calls) -- it describes reading "the plan queue" as a whole, with no mention
# of the open-only filter, `filed`, or `--format`. AC11 requires it gone.
_STALE_HELP_FRAGMENT = "Read the plan queue (GET …/plans) as a TOON-AXI table"

# The verbatim `cmd_status` docstring fragment every one of the five clients
# carries TODAY (confirmed by reading all five delegators): it describes the
# read as returning "the queue" -- the unfiltered plan list -- with no
# mention of "open", `filed`, or `--format`.
_STALE_DOCSTRING_FRAGMENT = "and return the queue as a uniform-table"


def _client_cmd_status_docstring(path):
    """The top-level `cmd_status` function's own docstring in `path` (the
    client's thin delegator, never the shared module's implementation),
    via `ast` -- mirrors the extraction the AC7 inventory test uses for the
    same function."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "cmd_status":
            return ast.get_docstring(node)
    return None


class _FormatFlagTestBase:
    """A plain MIXIN (no `unittest.TestCase` here) -- only the five concrete
    per-client classes below inherit `unittest.TestCase`, so discovery never
    collects this abstract half on its own."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                    f"cr150_c3_format_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr150-c3-format-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write("CRUCIBLE_PROJECT_KEY=cr150-c3-status-format\n")
            fh.write("CRUCIBLE_PROJECT_NAME=cr150-c3-status-format\n")
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

    def drive(self, verb, extra_argv, response):
        argv = [verb] + list(extra_argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", return_value=response):
            return _run_main(self.module, argv)

    def decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"{self.CLIENT}: --format toon stdout must still TOON-decode as an "
            f"'axi' envelope; got {stdout_text!r}")
        return decoded["axi"]


class _FormatJsonMatchesToonTests:
    """§S8/AC11 -- the core contract."""

    def test_format_json_object_equals_the_toon_axi_object_on_every_verb_and_board(self):
        for verb in ("status", "plans"):
            for label, response in BOARD_STATES.items():
                with self.subTest(client=self.CLIENT, verb=verb, board=label):
                    toon_code, toon_out, toon_err = self.drive(
                        verb, ["--format", "toon"], response)
                    json_code, json_out, json_err = self.drive(
                        verb, ["--format", "json"], response)

                    self.assertEqual(
                        toon_code, json_code,
                        f"{self.CLIENT}/{verb}/{label}: --format toon and "
                        f"--format json must exit with the SAME code (exit "
                        f"codes are unchanged by §S8); toon={toon_code} "
                        f"json={json_code}")
                    self.assertEqual(
                        toon_err, json_err,
                        f"{self.CLIENT}/{verb}/{label}: the stderr line must "
                        f"be unchanged between --format toon and --format "
                        f"json; toon_err={toon_err!r} json_err={json_err!r}")

                    toon_axi = self.decode_toon_axi(toon_out)

                    self.assertTrue(
                        json_out.lstrip().startswith("{"),
                        f"{self.CLIENT}/{verb}/{label}: --format json must "
                        f"write a JSON OBJECT on stdout; got {json_out!r}")
                    json_obj = json.loads(json_out)
                    self.assertIsInstance(
                        json_obj, dict,
                        f"{self.CLIENT}/{verb}/{label}: the parsed JSON must "
                        f"be a single object, not a list/scalar; got "
                        f"{json_obj!r}")

                    self.assertEqual(
                        json_obj, toon_axi,
                        f"{self.CLIENT}/{verb}/{label}: --format json must "
                        f"write ONE JSON object whose keys and values equal "
                        f"the same invocation's --format toon `axi` object; "
                        f"toon={toon_axi!r} json={json_obj!r}")
                    self.assertNotIn(
                        "axi", json_obj,
                        f"{self.CLIENT}/{verb}/{label}: the JSON object must "
                        f"be the UNWRAPPED axi object, never re-wrapped "
                        f"under an 'axi' key; got {json_obj!r}")

    def test_format_json_carries_every_envelope_key_with_exact_values(self):
        """A positive, exact-value check independent of the toon round-trip
        above -- proves the comparison isn't vacuously true because BOTH
        sides came back empty/malformed."""
        code, out, err = self.drive("status", ["--format", "json"], _WORK_IN_FLIGHT)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        obj = json.loads(out)
        for key in _ENVELOPE_KEYS:
            self.assertIn(
                key, obj,
                f"{self.CLIENT}: --format json must carry {key!r}; got "
                f"{sorted(obj)!r}")
        self.assertEqual(obj["verb"], "status")
        self.assertIs(obj["ok"], True)
        self.assertEqual(len(obj["plans"]), 1)
        self.assertEqual(obj["plans"][0].get("cr"), "CR-T-100")
        self.assertEqual(obj["lastClosedCr"], "CR-T-050")
        self.assertEqual(obj["filed"], 3)
        self.assertEqual(obj["count"], 1)
        self.assertEqual(obj["warnings"], [])

    def test_format_json_on_the_unavailable_degrade_carries_filed_null(self):
        """§S5 -- the degrade's ONE added field, `filed: null`, must survive
        into the JSON side identically to the TOON side."""
        code, out, err = self.drive("status", ["--format", "json"], _UNAVAILABLE)
        self.assertEqual(code, 0, f"{self.CLIENT}: stdout={out!r} stderr={err!r}")
        obj = json.loads(out)
        self.assertIs(obj["ok"], True)
        self.assertIsNone(obj["lastClosedCr"])
        self.assertIsNone(obj["filed"])
        codes = [w.get("code") for w in obj.get("warnings", [])]
        self.assertIn("status-unavailable", codes, f"got {obj!r}")


class _NoFormatFlagStillToonTests:
    """§S8 -- "no flag produces today's TOON output". EXPECTED TO PASS
    already: no new flag is involved, so this is today's existing
    behaviour, pinned here as the AC11 baseline the json path is compared
    against."""

    def test_no_format_flag_still_produces_todays_toon_envelope(self):
        code, out, err = self.drive("status", [], _WORK_IN_FLIGHT)
        self.assertEqual(
            code, 0, f"{self.CLIENT}: bare status must still succeed; "
            f"stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertEqual(axi.get("verb"), "status")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("filed"), 3)
        self.assertEqual(axi.get("lastClosedCr"), "CR-T-050")


class _BadFormatValueRefusedTests:
    """§S8/AC11 -- "a value other than toon or json is refused by argument
    parsing". Distinguished from "the flag itself doesn't exist yet" (which
    ALSO exits 2 today, for the wrong reason) by requiring argparse's own
    `choices` refusal wording, naming both accepted values."""

    def test_format_value_other_than_toon_or_json_is_refused_by_argument_parsing(self):
        for verb in ("status", "plans"):
            with self.subTest(client=self.CLIENT, verb=verb):
                code, out, err = self.drive(verb, ["--format", "xml"], _WORK_IN_FLIGHT)
                self.assertEqual(
                    code, 2,
                    f"{self.CLIENT}/{verb}: an unrecognised --format value "
                    f"must be refused by ARGUMENT PARSING (exit 2); "
                    f"stdout={out!r} stderr={err!r}")
                self.assertEqual(
                    out, "",
                    f"{self.CLIENT}/{verb}: a usage refusal must write "
                    f"nothing to stdout; got {out!r}")
                lowered = err.lower()
                self.assertIn(
                    "invalid choice", lowered,
                    f"{self.CLIENT}/{verb}: the refusal must be argparse's "
                    f"CHOICES mechanism (an 'invalid choice' message), not "
                    f"merely an 'unrecognized arguments' error for a "
                    f"--format flag that does not exist at all yet; "
                    f"stderr={err!r}")
                self.assertIn(
                    "toon", lowered,
                    f"{self.CLIENT}/{verb}: the refusal must name the "
                    f"accepted values; stderr={err!r}")
                self.assertIn(
                    "json", lowered,
                    f"{self.CLIENT}/{verb}: the refusal must name the "
                    f"accepted values; stderr={err!r}")


class _AllFormatFlagTests(_FormatJsonMatchesToonTests, _NoFormatFlagStillToonTests,
                           _BadFormatValueRefusedTests, _FormatFlagTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonStatusFormatFlagTest(_AllFormatFlagTests, unittest.TestCase):
    CLIENT = "python"


class BunStatusFormatFlagTest(_AllFormatFlagTests, unittest.TestCase):
    CLIENT = "bun"


class RustStatusFormatFlagTest(_AllFormatFlagTests, unittest.TestCase):
    CLIENT = "rust"


class MvnStatusFormatFlagTest(_AllFormatFlagTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoStatusFormatFlagTest(_AllFormatFlagTests, unittest.TestCase):
    CLIENT = "arduino"


# ═══════════════════════════════════════════════════════════════════════════
# §S8/AC11 — help text + `cmd_status` docstring: name the open plans, `filed`
# and `--format`; no longer describe the unfiltered plan list.
# ═══════════════════════════════════════════════════════════════════════════


class Ac11StatusVerbHelpTest(unittest.TestCase):

    def test_every_client_help_no_longer_describes_the_unfiltered_plan_list(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            names, help_text = _status_verb_registration(path)
            self.assertIsNotNone(
                names, f"{client}: no status/plans add_parser(help=...) "
                f"found -- the extraction found nothing to check")
            help_str = str(help_text) if help_text else ""
            if _STALE_HELP_FRAGMENT in help_str:
                offenders[client] = help_str
        self.assertEqual(
            offenders, {},
            f"§S8/AC11 -- the status/plans help text must no longer "
            f"describe the unfiltered plan list read verbatim; still "
            f"present in: {offenders!r}")

    def test_every_client_help_names_open_plans_filed_and_format(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            _names, help_text = _status_verb_registration(path)
            help_str = str(help_text) if help_text else ""
            squeezed = " ".join(help_str.split()).lower()
            missing = [term for term in ("open", "filed", "format") if term not in squeezed]
            if missing:
                offenders[client] = (missing, help_str)
        self.assertEqual(
            offenders, {},
            f"§S8/AC11 -- every client's status/plans help must name the "
            f"open plans, `filed` and `--format`: {offenders!r}")


class Ac11CmdStatusDocstringTest(unittest.TestCase):

    def test_every_client_cmd_status_docstring_no_longer_describes_the_unfiltered_queue(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            doc = _client_cmd_status_docstring(path)
            self.assertIsNotNone(
                doc, f"{client}: cmd_status defines no docstring at all")
            squeezed = " ".join(doc.split()).lower()
            if _STALE_DOCSTRING_FRAGMENT in squeezed:
                offenders[client] = doc
        self.assertEqual(
            offenders, {},
            f"§S8/AC11 -- each client's cmd_status docstring must no "
            f"longer describe returning the unfiltered plan queue "
            f"verbatim; still present in: {offenders!r}")

    def test_every_client_cmd_status_docstring_names_open_plans_filed_and_format(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            doc = _client_cmd_status_docstring(path)
            squeezed = " ".join((doc or "").split()).lower()
            missing = [term for term in ("open", "filed", "format") if term not in squeezed]
            if missing:
                offenders[client] = (missing, doc)
        self.assertEqual(
            offenders, {},
            f"§S8/AC11 -- each client's cmd_status docstring must name the "
            f"open plans, `filed` and `--format`: {offenders!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S8 — "the no-argument dashboard does not take the flag."
# ═══════════════════════════════════════════════════════════════════════════


class Ac11DashboardOffersNoFormatFlagTest(unittest.TestCase):

    def test_status_namespace_carries_no_format_attribute(self):
        axi = _load_module(AXI_MODULE_PATH, "cr150_c3_axi_dashboard_under_test")
        ns = axi.status_namespace()
        self.assertFalse(
            hasattr(ns, "format"),
            f"§S8 -- the no-argument dashboard's forwarded Namespace must "
            f"NOT carry a `format` field (the dashboard is not offered the "
            f"flag); got {vars(ns)!r}")

    def test_every_client_dashboard_still_emits_toon_never_json(self):
        for client, path in CLIENT_FILES.items():
            with self.subTest(client=client):
                module = _load_module(path, f"cr150_c3_dashboard_{client}_under_test")
                env_var = PROJECT_DIR_ENV_VAR[client]
                tmpdir = tempfile.mkdtemp(prefix=f"cr150-c3-dash-{client}-")
                saved_env = {k: os.environ.get(k) for k in ENV_KEYS + (env_var,)}
                try:
                    with open(os.path.join(tmpdir, ".env"), "w") as fh:
                        fh.write("CRUCIBLE_PROJECT_KEY=cr150-c3-status-dashboard\n")
                        fh.write("CRUCIBLE_PROJECT_NAME=cr150-c3-status-dashboard\n")
                    install_project_limits(tmpdir)
                    for k in ENV_KEYS:
                        os.environ.pop(k, None)
                    os.environ[env_var] = tmpdir
                    with mock.patch.object(module, "_get", return_value=_WORK_IN_FLIGHT):
                        code, out, err = _run_main(module, [])
                    self.assertEqual(
                        code, 0,
                        f"{client}: bare (no-argument) dashboard invocation "
                        f"must succeed; stderr={err!r}")
                    decoded = module._toon().decode(out)
                    self.assertIn(
                        "axi", decoded,
                        f"{client}: the dashboard's stdout must still "
                        f"TOON-decode as an axi envelope (never bare JSON, "
                        f"since it is offered no --format flag); got "
                        f"{out!r}")
                finally:
                    for k, v in saved_env.items():
                        if v is None:
                            os.environ.pop(k, None)
                        else:
                            os.environ[k] = v
                    shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
