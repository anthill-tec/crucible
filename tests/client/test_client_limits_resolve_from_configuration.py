"""CR-CRU-131 §S1/§S1b — the CLIENT's limits are CONFIGURATION, resolved from
the PROJECT's `crucible.toml` at the point of use.

The rule (PRD §4.13, user ruling 2026-09-14): a limit is configuration, never a
constant compiled into source. Three of the six live on this side of the wire,
and all five clients reach them on every call:

    truncate_field_chars   clients/_crucible_axi.py:516 -> used at :519
    error_detail_chars     clients/_crucible_axi.py:1045 -> used at :1106, :1119
    roadmap_list_rows      clients/_crucible_axi.py:3563 -> used at :3720

The server's three (`run_abandon_ms`, `project_inactive_ms`, `retention`) are
NOT here and must not be. A limit is owned by the process that ENFORCES it: a
client resolves a PROJECT DIRECTORY and its `.env` and then posts over HTTP,
while the server resolves its own database and may be installed on another
machine entirely. Neither process reads the other's file. The server's half
lives in tests/server-limits-are-configuration.test.ts.

── The seam this file is written against ──────────────────────────────────

Built ONCE in `clients/_crucible_axi.py`, where all five clients inherit it
(the shared-module discipline CR-CRU-030 established), and shaped to mirror the
server's `src/limits.ts` one-for-one -- one schema, one loader shape, two
locations:

    CLIENT_LIMIT_NAMES                  -> tuple[str, ...]
    bind_project_dir(project_dir)       -> None
    project_config_path()               -> str   (<project dir>/crucible.toml)
    shipped_limits()                    -> dict[str, dict]   (package data)
    resolve_limit(name)                 -> int
    limit_disclosures()                 -> list[str]
    limit_disclosure_warnings()         -> list[dict]  (envelope warnings[])

What is in EFFECT is read through `resolve_limit` -- the number a limit RUNS at
-- and disclosed through `limit_disclosures`. There is deliberately no third
"effective declarations" surface beside them: it had no consumer on either side
of the wire, and an API kept warm on the chance is an API nothing keeps honest.

`bind_project_dir` rather than a `project_dir=` parameter threaded through
`truncate_field` / `truncate_rows` / `no_report_warning`, for the reason this
module's own scope boundary already states (clients/_crucible_axi.py:16-19):
project-dir resolution stays CLIENT-specific and arrives ALREADY RESOLVED. The
client resolves its root exactly once, hands it over, and the pure formatters
keep their pure signatures.

`shipped_limits()` is the PACKAGE DATA table -- the last resort, readable
without the operator's file being present or even valid, which is what makes
"no literal in source" reachable (§S1c) rather than aspirational.

── The four fields are DOCUMENTATION; `value` is the operator's setting ────

`description`, `recommended`, `min` and `max` are IMMUTABLE documentation. The
operator's own choice is a SEPARATE, OPTIONAL `value` in the same table: with
no `value` the limit resolves to `recommended`, with one it resolves to
`value`, range-checked against the `min`/`max` sitting beside it.

An operator who instead overwrote `recommended` in place would destroy, in the
very file they read, the record of what we recommend -- and would then be one
upgrade away from not knowing whether the number in front of them is ours or
theirs. That is why a test below asserts that setting a `value` leaves
`recommended` reading as the SHIPPED recommendation: it is the assertion that
stops a later simplification back to editing in place.

The widen/narrow proof is unaffected by the split, and that is the point: the
value and the bound that judges it still live in ONE table, so widening `max`
there can still make a previously-refused `value` resolve.

── Read at the POINT OF USE ───────────────────────────────────────────────

The no-restart tests below EDIT the file between two calls and assert the
second differs. Each asserts the FIRST call's behaviour before the edit, so
"it changed" is a claim about the edit and not about the fixture. A loader that
parsed the table once at import time -- the easiest way to satisfy every other
test here and lose the contract later -- fails exactly there.

That this is a real failure mode and not a theoretical one was MEASURED on the
server side of the same CR, 2026-09-14, bun 1.3.14: `(await
import(p)).default…recommended` returned 1800000 both BEFORE and AFTER the file
was rewritten to 999, while a re-read of the same path saw 999. The module
graph caches; a file read does not. Python's equivalent trap is one line
shorter and already in the tree -- `TRUNCATE_LIMIT`, `NO_REPORT_DETAIL_MAX` and
`ROADMAP_LIST_LIMIT` are bound as DEFAULT ARGUMENT values at def time, which is
the same cache with an even earlier expiry.

── Why the seam is reached per test, never at module scope ────────────────

`_load_module_by_path` runs a FRESH copy of the shared module per test and
`_seam()` raises a named error for each missing member. A single module-scope
import would collapse 29 contracts into one collection error that tells GREEN
nothing about which of them it has satisfied; this way each test fails on its
own and says what it wanted. It also keeps one test's `bind_project_dir` out of
the next one's state.

── No test pins a limit VALUE (PRD §4.13, user ruling) ────────────────────

Nothing below spells 200, 500 or 20. Every expectation is derived from the
declaration READ BACK off the table the operator edits; a test that hardcodes
the limit it checks freezes the same defect from the other side. The only
numbers written out are arithmetic on values read back (`min - 1`, `max + 1`),
which is what a boundary test is.

── What is RED here and what is a GREEN-GUARD ─────────────────────────────

Measured on release/0.2.0, 2026-09-14 (python 1852 tests, 1851 pass, 1 pending,
0 fail):

  RED   every test in every class below. `clients/_crucible_axi.py` exports no
        `shipped_limits`, no `resolve_limit`, no `bind_project_dir` and no
        `limit_disclosures`; the three limits are module constants
        (`TRUNCATE_LIMIT`, `NO_REPORT_DETAIL_MAX`, `ROADMAP_LIST_LIMIT`) bound
        as DEFAULT ARGUMENT VALUES at function-definition time, which is the
        strongest form of the cache this CR forbids. Each test fails naming the
        seam member it wanted.
  GUARD `--full` still defeats the TWO display WIDTHS -- `truncate_field_chars`
        (asserted at `TruncateFieldCharsResolutionTest
        .test_the_operators_value_decides_the_cut_and_no_value_falls_to_recommended`)
        and `roadmap_list_rows` (`RoadmapListRowsResolutionTest
        .test_the_operators_value_decides_the_list_length_and_no_value_falls_to_recommended`).
        Two guards, because there are two: `no_report_warning` takes no `full`
        parameter at HEAD and took none before this CR, so `error_detail_chars`
        was never defeatable that way and this CR preserved that exactly. (An
        earlier draft of this docstring, and of the AC it repeated, claimed all
        three; both are corrected.) The two pass today and must keep passing: a
        per-invocation escape hatch is not a substitute for a configured
        default, and a configured default is not a substitute for it.

Invocation:
    python3 -m pytest tests/client/test_client_limits_resolve_from_configuration.py -q
Fallback:
    python3 tests/client/test_client_limits_resolve_from_configuration.py
"""

import ast
import contextlib
import importlib.util
import io
import itertools
import json
import os
import shutil
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
BUN_CLIENT_PATH = CLIENTS_DIR / "bun-crucible.py"
#: The fleet's OWN TOON decoder, so an envelope a real run emitted is read the
#: way its consumers read it rather than pattern-matched out of stdout.
TOON_MODULE_PATH = CLIENTS_DIR / "toon.py"

#: The four fields §S1b requires of every limit -- DOCUMENTATION, all of it.
#: A vocabulary, not a limit. `value` is deliberately NOT one of them: it is
#: the operator's own setting, optional, and absent from every shipped
#: declaration.
DECLARED_FIELDS = ("description", "recommended", "min", "max")

#: The three limits a CLIENT enforces, by their OWN names -- not
#: transliterations of the retired constants. A key spelled
#: `no_report_detail_max` would carry an accident of the old source into the
#: file an operator reads.
#:
#: Written out because this is the VOCABULARY under test (the same reasoning
#: tests/retention-disposable-kinds.test.ts gives for writing out its disposable
#: kinds): a completeness check compared against a set derived from the thing it
#: is checking would assert nothing.
CLIENT_LIMITS = ("truncate_field_chars", "error_detail_chars", "roadmap_list_rows")

#: The three the SERVER enforces. Here only so the ownership NEGATIVE can name
#: one; a client must never resolve any of them.
SERVER_LIMITS = ("run_abandon_ms", "project_inactive_ms", "retention")

#: The env vars that are NOT limits and stay untouched by this CR -- bootstrap
#: and identity, answerable before any file can be found (PRD §4.13).
_RETIRED_LIMIT_ENV = ("CRUCIBLE_DEFAULT_RETENTION", "CRUCIBLE_RUN_ABANDON_MS")

_COUNTER = itertools.count()


def _load_module_by_path(path, cache_key):
    """The fleet's own `_axi()`/`_toon()` loader idiom, as every sibling test in
    this directory uses it. A FRESH module object per call, which is what keeps
    one test's `bind_project_dir` out of the next one's state."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive a client's REAL entry point and capture both streams (the sibling
    convention, e.g. tests/client/test_bun_crucible_axi_conventions.py:153)."""
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


def _seam(axi, name):
    """One member of the loader seam, or a failure that says what is missing and
    why it has to be reachable from outside."""
    found = getattr(axi, name, None)
    if found is None:
        raise AssertionError(
            "CR-CRU-131 §S1: clients/_crucible_axi.py exports no `%s`. The client's three "
            "display limits must resolve through ONE seam in the shared module -- all five "
            "clients inherit it -- not from the module constants TRUNCATE_LIMIT (:516), "
            "NO_REPORT_DETAIL_MAX (:1045) and ROADMAP_LIST_LIMIT (:3563), each of which is "
            "currently bound as a DEFAULT ARGUMENT at definition time and so can never see an "
            "operator's edit." % (name,))
    return found


def _toml(tables):
    """Render `[limits.<name>]` tables -- the shape an operator meets: four
    fields of documentation, and their own `value` only where they set one."""
    out = []
    for name, d in tables.items():
        block = ("[limits.%s]\n"
                 "description = %s\n"
                 "recommended = %d\n"
                 "min = %d\n"
                 "max = %d\n" % (name, json.dumps(d["description"]),
                                 d["recommended"], d["min"], d["max"]))
        if d.get("value") is not None:
            block += "value = %d\n" % d["value"]
        out.append(block)
    return "\n".join(out)


def _document_only(shipped, minimum=None, maximum=None):
    """The same limit as the operator finds it BEFORE touching anything: four
    fields of documentation and no `value` at all. This is what an installed,
    unedited `crucible.toml` holds, and a limit must resolve to `recommended`
    from it. `min`/`max` may be re-stated so the widen/narrow tests can move
    the bound a value is judged against; no test ever writes a bound the
    shipped table did not supply."""
    return {
        "description": shipped["description"],
        "recommended": shipped["recommended"],
        "min": shipped["min"] if minimum is None else minimum,
        "max": shipped["max"] if maximum is None else maximum,
    }


def _declare(shipped, value, minimum=None, maximum=None):
    """The operator's file for ONE limit they HAVE set: the shipped
    documentation carried through VERBATIM -- `description` and `recommended`
    untouched -- plus their own `value` beside it.

    `recommended` is never overwritten here, and that is deliberate: this
    helper is the only way a test configures anything, so no test CAN
    accidentally express the in-place edit the schema exists to prevent."""
    declaration = _document_only(shipped, minimum, maximum)
    declaration["value"] = value
    return declaration


class _ClientLimitsTestCase(unittest.TestCase):
    """A project directory with a `.env` (the file a client already reads to
    find its key), a SEPARATE directory standing in for the server's own
    configuration, and a freshly-executed copy of the shared module."""

    PROJECT_KEY = "019f6228-63a7-7000-b3d4-000000000131"

    def setUp(self):
        self.project_dir = tempfile.mkdtemp(prefix="crucible-project-limits-")
        (Path(self.project_dir) / ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=%s\n" % self.PROJECT_KEY)
        # A directory the CLIENT has no business reading. On a real deployment
        # it is on another machine; here it merely is not the project dir.
        self.server_dir = tempfile.mkdtemp(prefix="crucible-server-limits-")

        self._saved_env = {k: os.environ.get(k)
                           for k in _RETIRED_LIMIT_ENV + ("CRUCIBLE_DB",
                                                          "BUN_CRUCIBLE_PROJECT_DIR")}
        for k in _RETIRED_LIMIT_ENV:
            os.environ.pop(k, None)
        os.environ["CRUCIBLE_DB"] = os.path.join(self.server_dir, "crucible.db")

        self.axi = _load_module_by_path(
            AXI_MODULE_PATH, "crucible_axi_limits_%d" % next(_COUNTER))
        _seam(self.axi, "bind_project_dir")(self.project_dir)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.project_dir, ignore_errors=True)
        shutil.rmtree(self.server_dir, ignore_errors=True)

    # -- fixtures -----------------------------------------------------------

    def shipped(self, name):
        table = _seam(self.axi, "shipped_limits")()
        self.assertIn(name, table,
                      "the shipped defaults declare no `%s`" % name)
        return table[name]

    def write_project_config(self, tables, directory=None):
        target = Path(directory or self.project_dir) / "crucible.toml"
        target.write_text(_toml(tables))
        return str(target)

    def write_raw(self, text, directory=None):
        target = Path(directory or self.project_dir) / "crucible.toml"
        target.write_text(text)
        return str(target)

    def refusal_for(self, name):
        for line in _seam(self.axi, "limit_disclosures")():
            if name in line:
                return line
        return None

    # -- the three observable behaviours ------------------------------------

    def visible_width(self, sample=None):
        """How many characters of a long text field survive `truncate_field`.
        Observed on the OUTPUT, never read off a constant. The default probe is
        sized off the limit's own declared CEILING, so it stays longer than any
        width the declaration can admit -- a fixed-length probe would silently
        stop cutting the day someone widened `max` past it."""
        text = sample or ("x" * (self.shipped("truncate_field_chars")["max"] + 1_000))
        result = self.axi.truncate_field(text)
        self.assertNotEqual(result, text,
                            "a field longer than any supportable width must be cut")
        return len(result.split(" (truncated,")[0])

    def detail_length(self, output):
        warning = self.axi.no_report_warning("regression", "junit.xml", 1, output)
        return len(warning["detail"])

    def visible_rows(self, count):
        rows = [{"cr": "CR-SHIPPED-%03d" % i} for i in range(count)]
        return len(self.axi.truncate_rows(rows))


# ===========================================================================
# §S1b -- the schema is complete and self-describing
# ===========================================================================

class ClientLimitSchemaTest(_ClientLimitsTestCase):
    """RED, all four: `shipped_limits` does not exist, so there is no table to
    read. If GREEN shipped the loader but only some of the declarations, the
    completeness test names exactly which limit is undocumented."""

    def test_each_limit_is_a_table_declaring_description_recommended_min_and_max(self):
        table = _seam(self.axi, "shipped_limits")()
        missing = []
        for name in CLIENT_LIMITS:
            declaration = table.get(name)
            if declaration is None:
                missing.append("%s: no [limits.%s] table at all" % (name, name))
                continue
            missing.extend("%s.%s" % (name, f)
                           for f in DECLARED_FIELDS if f not in declaration)
        self.assertEqual([], missing,
                         "§S1b: every limit declares FOUR things, not one number: %r"
                         % (missing,))

        for name in CLIENT_LIMITS:
            d = table[name]
            self.assertIsInstance(d["description"], str,
                                  "%s.description must be text" % name)
            for field in ("recommended", "min", "max"):
                self.assertIsInstance(
                    d[field], int,
                    "%s.%s must be a whole number -- a bound that is a string is a "
                    "bound nothing can enforce" % (name, field))

    def test_the_table_declares_exactly_the_limits_a_client_enforces(self):
        """A seventh limit added without its documentation fails HERE, on the day
        it is written, rather than shipping undocumented. Both directions:
        undocumented-but-enforced is the defect this CR exists to prevent, and
        documented-but-unenforced is a bound nothing checks, which is the other
        one."""
        names = _seam(self.axi, "CLIENT_LIMIT_NAMES")
        self.assertEqual(sorted(CLIENT_LIMITS), sorted(names))
        self.assertEqual(sorted(CLIENT_LIMITS),
                         sorted(_seam(self.axi, "shipped_limits")().keys()))

    def test_each_recommended_lies_inside_that_limits_own_declared_range(self):
        for name in CLIENT_LIMITS:
            d = self.shipped(name)
            self.assertLess(d["min"], d["max"],
                            "%s: min must be below max, or the range admits nothing" % name)
            self.assertGreaterEqual(d["recommended"], d["min"],
                                    "%s: the shipped value must satisfy its own floor" % name)
            self.assertLessEqual(d["recommended"], d["max"],
                                 "%s: the shipped value must satisfy its own ceiling" % name)

    def test_each_description_is_a_sentence_not_a_bare_echo_of_its_key(self):
        """The rule CR-CRU-128 §S3.2 established for flag help, reused rather
        than re-invented: `--no-wait` described as \"no wait\" teaches nothing
        the flag's own spelling did not, and `roadmap_list_rows` described as
        \"roadmap list rows\" teaches nothing the key did not. Same squash,
        same verdict."""
        import re

        def squash(text):
            return re.sub(r"[^a-z0-9]", "", text.lower())

        empty, echoes = [], []
        for name in CLIENT_LIMITS:
            description = str(self.shipped(name).get("description", ""))
            if not description.strip():
                empty.append(name)
            elif squash(description) == squash(name):
                echoes.append("%s: %s" % (name, description))
        self.assertEqual([], empty, "description present but empty: %r" % (empty,))
        self.assertEqual([], echoes,
                         "description repeats the limit's own key: %r" % (echoes,))

    def test_a_shipped_declaration_carries_no_value_of_its_own(self):
        """The four fields are DOCUMENTATION, not a setting. A `value` in the
        shipped table would be us configuring the operator's install on their
        behalf -- which is the defect one layer up from the one this CR
        deletes."""
        table = _seam(self.axi, "shipped_limits")()
        preset = [name for name in CLIENT_LIMITS
                  if table.get(name, {}).get("value") is not None]
        self.assertEqual([], preset)

    def test_setting_a_value_leaves_recommended_reading_as_the_shipped_recommendation(self):
        """The assertion that stops a later simplification back to editing
        `recommended` in place. An operator who overwrote it would destroy, in
        the very file they read, the record of what we recommend -- and would
        be one upgrade away from not knowing whose number is in front of
        them."""
        resolve = _seam(self.axi, "resolve_limit")
        shipped_table = _seam(self.axi, "shipped_limits")

        for name in CLIENT_LIMITS:
            shipped = self.shipped(name)
            chosen = shipped["min"]
            self.assertNotEqual(
                chosen, shipped["recommended"],
                "%s: pick a value distinguishable from the recommendation" % name)
            file = self.write_project_config({name: _declare(shipped, chosen)})

            # What the operator READS back out of their own file.
            with open(file, "rb") as fh:
                parsed = tomllib.load(fh)["limits"][name]
            self.assertEqual(shipped["recommended"], parsed["recommended"],
                             "%s: the documentation was overwritten" % name)
            self.assertEqual(chosen, parsed["value"])

            # …and what the LOADER says, with the operator's file now in place,
            # says the same: the shipped documentation still reads as ours,
            # because the file laid a `value` beside it rather than over it…
            self.assertEqual(shipped["recommended"],
                             shipped_table()[name]["recommended"])
            self.assertIsNone(shipped_table()[name].get("value"))
            # …while the limit actually RUNS at the operator's number.
            self.assertEqual(chosen, resolve(name))


# ===========================================================================
# §S1 -- each limit resolves FROM THE FILE, at the point of use
# ===========================================================================

class TruncateFieldCharsResolutionTest(_ClientLimitsTestCase):

    def test_the_operators_value_decides_the_cut_and_no_value_falls_to_recommended(self):
        """RED. `truncate_field` binds `limit=TRUNCATE_LIMIT` as a default
        argument (clients/_crucible_axi.py:519), so the configured file changes
        nothing and the cut lands on the compiled number."""
        shipped = self.shipped("truncate_field_chars")
        width = shipped["min"]
        self.assertLess(width, shipped["recommended"],
                        "the two halves below must be distinguishable")
        self.write_project_config({"truncate_field_chars": _declare(shipped, width)})

        self.assertEqual(width, self.visible_width())

        # NEGATIVE -- content that was never cut carries no fabricated hint,
        # so a truncator that always truncated would fail here.
        short = "y" * (width - 1)
        self.assertEqual(short, self.axi.truncate_field(short))

        # GUARD -- `--full` still defeats the limit per invocation.
        long_text = "z" * (width + 500)
        self.assertEqual(long_text, self.axi.truncate_field(long_text, full=True))

        # THE OTHER WAY -- the same limit as an operator finds it before
        # touching anything: four fields of documentation, no `value`.
        self.write_project_config({"truncate_field_chars": _document_only(shipped)})
        self.assertEqual(shipped["recommended"], self.visible_width())

    def test_editing_the_file_moves_the_cut_on_the_next_call_with_no_restart(self):
        """RED, and the one contract easiest to satisfy accidentally and lose
        later: a loader that parses the table once at import -- or, as today,
        binds it as a default argument -- passes every other test in this file
        and fails only here."""
        shipped = self.shipped("truncate_field_chars")
        tight, loose = shipped["min"], shipped["max"]
        self.assertLess(tight, loose)

        # FIRST call's behaviour, asserted BEFORE the edit.
        self.write_project_config({"truncate_field_chars": _declare(shipped, tight)})
        self.assertEqual(tight, self.visible_width())

        # The operator edits the file. Nothing restarts, nothing is re-imported.
        self.write_project_config({"truncate_field_chars": _declare(shipped, loose)})
        sample = "x" * (loose + 500)
        self.assertEqual(loose, self.visible_width(sample))


class ErrorDetailCharsResolutionTest(_ClientLimitsTestCase):

    LONG = "ModuleNotFoundError: No module named 'xmlrunner' " + ("q" * 40_000)

    def test_the_operators_value_bounds_the_failure_detail_and_no_value_falls_to_recommended(self):
        """RED. `no_report_warning` sizes its cause fragment off
        NO_REPORT_DETAIL_MAX (clients/_crucible_axi.py:1106, :1119), a module
        constant, so the configured file changes nothing."""
        shipped = self.shipped("error_detail_chars")
        bound = shipped["min"]
        self.assertLess(bound, shipped["recommended"],
                        "the two halves below must be distinguishable")
        self.write_project_config({"error_detail_chars": _declare(shipped, bound)})

        detail = self.axi.no_report_warning("regression", "junit.xml", 1, self.LONG)["detail"]
        self.assertLessEqual(
            len(detail), bound,
            "§S1b: a limit's own floor must be wide enough for the envelope it bounds; "
            "a floor under which the composed detail cannot fit is not a supportable floor")
        # NEGATIVE -- bounded, not emptied: the cause still reaches the consumer.
        self.assertIn("regression", detail)
        self.assertIn("1", detail)

        # THE OTHER WAY -- documentation only, no `value`.
        self.write_project_config({"error_detail_chars": _document_only(shipped)})
        wider = self.detail_length(self.LONG)
        self.assertLessEqual(wider, shipped["recommended"])
        self.assertGreater(wider, bound)

    def test_editing_the_file_moves_the_bound_on_the_next_call_with_no_restart(self):
        shipped = self.shipped("error_detail_chars")
        tight = shipped["min"]
        loose = min(shipped["max"], tight * 4)
        self.assertGreater(loose, tight,
                           "the declaration must admit two distinguishable bounds")

        self.write_project_config({"error_detail_chars": _declare(shipped, tight)})
        before = self.detail_length(self.LONG)
        self.assertLessEqual(before, tight)

        self.write_project_config({"error_detail_chars": _declare(shipped, loose)})
        after = self.detail_length(self.LONG)

        self.assertLessEqual(after, loose)
        self.assertGreater(
            after, tight,
            "under a CACHED table the detail would still be bounded by the old value")


class RoadmapListRowsResolutionTest(_ClientLimitsTestCase):

    def test_the_operators_value_decides_the_list_length_and_no_value_falls_to_recommended(self):
        """RED. `truncate_rows` binds `limit=ROADMAP_LIST_LIMIT` as a default
        argument (clients/_crucible_axi.py:3722)."""
        shipped = self.shipped("roadmap_list_rows")
        rows = shipped["min"]
        self.assertLess(rows, shipped["recommended"],
                        "the two halves below must be distinguishable")
        self.write_project_config({"roadmap_list_rows": _declare(shipped, rows)})

        self.assertEqual(rows, self.visible_rows(rows + 5))

        # NEGATIVE -- a list already inside the limit is returned whole.
        self.assertEqual(rows - 1, self.visible_rows(rows - 1))

        # GUARD -- `--full` still emits the list whole.
        whole = [{"cr": "CR-SHIPPED-%03d" % i} for i in range(rows + 5)]
        self.assertEqual(rows + 5, len(self.axi.truncate_rows(whole, full=True)))

        # THE OTHER WAY -- documentation only, no `value`.
        self.write_project_config({"roadmap_list_rows": _document_only(shipped)})
        self.assertEqual(shipped["recommended"],
                         self.visible_rows(shipped["recommended"] + 5))

    def test_editing_the_file_moves_the_length_on_the_next_call_with_no_restart(self):
        shipped = self.shipped("roadmap_list_rows")
        tight = shipped["min"]
        loose = min(shipped["max"], tight + 7)
        self.assertGreater(loose, tight)

        self.write_project_config({"roadmap_list_rows": _declare(shipped, tight)})
        self.assertEqual(tight, self.visible_rows(loose + 5))

        self.write_project_config({"roadmap_list_rows": _declare(shipped, loose)})
        self.assertEqual(loose, self.visible_rows(loose + 5))

    def test_configuring_one_limit_changes_only_the_behaviour_it_names(self):
        """RED. One setting must not be wired to another's site. Moving the
        roadmap length across its whole range leaves the field width alone, and
        the CONTROL proves the width is movable at all -- without it, a
        truncator that ignored configuration entirely would satisfy the first
        half."""
        rows = self.shipped("roadmap_list_rows")
        chars = self.shipped("truncate_field_chars")

        self.write_project_config({
            "roadmap_list_rows": _declare(rows, rows["min"]),
            "truncate_field_chars": _declare(chars, chars["min"]),
        })
        self.assertEqual(chars["min"], self.visible_width())

        self.write_project_config({
            "roadmap_list_rows": _declare(rows, rows["max"]),
            "truncate_field_chars": _declare(chars, chars["min"]),
        })
        self.assertEqual(chars["min"], self.visible_width())

        # CONTROL.
        self.write_project_config({
            "roadmap_list_rows": _declare(rows, rows["max"]),
            "truncate_field_chars": _declare(chars, chars["max"]),
        })
        self.assertEqual(chars["max"], self.visible_width("x" * (chars["max"] + 500)))


# ===========================================================================
# §S1 -- an UNCONFIGURED limit resolves to its SHIPPED DEFAULT, not to unbounded
# ===========================================================================

class UnconfiguredClientLimitTest(_ClientLimitsTestCase):
    """Observed as BEHAVIOUR, never as a value read back: the expectation is
    derived from the shipped declaration and what is asserted is what the client
    DOES. Unbounded-by-default would print every field in full and the whole
    roadmap on every call, for every agent, and call it honesty -- these three
    exist to protect the reader's context (CR-CRU-131 Context)."""

    def test_field_truncation_runs_at_its_shipped_recommendation_when_nothing_is_configured(self):
        self.assertFalse((Path(self.project_dir) / "crucible.toml").exists())
        self.assertEqual(self.shipped("truncate_field_chars")["recommended"],
                         self.visible_width())

    def test_error_detail_truncation_runs_at_its_shipped_recommendation(self):
        self.assertFalse((Path(self.project_dir) / "crucible.toml").exists())
        bound = self.shipped("error_detail_chars")["recommended"]
        self.assertLessEqual(self.detail_length("boom " + "q" * 40_000), bound)

    def test_the_roadmap_list_runs_at_its_shipped_recommendation_and_is_not_unbounded(self):
        self.assertFalse((Path(self.project_dir) / "crucible.toml").exists())
        rows = self.shipped("roadmap_list_rows")["recommended"]
        self.assertEqual(rows, self.visible_rows(rows + 40))


# ===========================================================================
# §S1b -- the RANGE is enforced, from the same table that documents it
# ===========================================================================

class ClientLimitRangeTest(_ClientLimitsTestCase):

    def _both_ends_of_both_bounds(self, name):
        shipped = self.shipped(name)
        resolve = _seam(self.axi, "resolve_limit")

        for legal in (shipped["min"], shipped["max"]):
            self.write_project_config({name: _declare(shipped, legal)})
            self.assertEqual(
                legal, resolve(name),
                "%s: %d is inside its own declared range and must resolve" % (name, legal))
            self.assertIsNone(
                self.refusal_for(name),
                "%s: %d is legal -- nothing may be disclosed about it" % (name, legal))

        for illegal in (shipped["min"] - 1, shipped["max"] + 1):
            self.write_project_config({name: _declare(shipped, illegal)})
            resolved = resolve(name)

            self.assertNotEqual(illegal, resolved,
                                "%s: %d must be refused, not used" % (name, illegal))
            clamped = shipped["min"] if illegal < shipped["min"] else shipped["max"]
            self.assertNotEqual(
                clamped, resolved,
                "%s: a refusal must not silently CLAMP to the bound it crossed -- a clamp "
                "leaves the operator's stated intent and the running behaviour different "
                "with nothing saying so" % name)
            self.assertEqual(shipped["recommended"], resolved,
                             "%s: a refusal falls back to the documented recommendation" % name)

            message = self.refusal_for(name)
            self.assertIsNotNone(message,
                                 "%s: %d was refused in SILENCE" % (name, illegal))
            for token in (illegal, shipped["min"], shipped["max"], shipped["recommended"]):
                self.assertIn(str(token), message,
                              "the refusal must name the limit, the offending value, the "
                              "range and the recommended setting")
            self.assertIn(name, message)

    def test_truncate_field_chars_refuses_below_min_and_above_max(self):
        self._both_ends_of_both_bounds("truncate_field_chars")

    def test_error_detail_chars_refuses_below_min_and_above_max(self):
        self._both_ends_of_both_bounds("error_detail_chars")

    def test_roadmap_list_rows_refuses_below_min_and_above_max(self):
        self._both_ends_of_both_bounds("roadmap_list_rows")

    def test_a_refused_width_leaves_the_cut_at_the_recommendation_not_at_the_bound(self):
        """The not-clamped claim, proved by what the client DOES rather than by
        what a resolver returns. A clamp to `min` and a fallback to
        `recommended` are distinguishable only by observing the cut."""
        shipped = self.shipped("truncate_field_chars")
        self.assertLess(shipped["min"], shipped["recommended"],
                        "a clamp and the fallback must be distinguishable")
        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, shipped["min"] - 1)})

        width = self.visible_width()
        self.assertNotEqual(shipped["min"], width, "the refusal was clamped to the floor")
        self.assertEqual(shipped["recommended"], width)
        self.assertIsNotNone(self.refusal_for("truncate_field_chars"))

    def test_widening_max_makes_a_previously_refused_value_resolve(self):
        """The file is the SOURCE of the bound, not a second copy of it. One
        field changes between the two halves -- `max` -- and the value the
        operator asked for is untouched."""
        shipped = self.shipped("truncate_field_chars")
        # A value ABOVE the recommendation, so narrowing `max` beneath it
        # leaves `recommended` -- the fallback -- still inside the range it
        # documents.
        value = shipped["max"]
        self.assertLess(shipped["recommended"], value,
                        "the value and the fallback must be distinguishable")
        resolve = _seam(self.axi, "resolve_limit")

        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, value, maximum=value - 1)})
        self.assertEqual(shipped["recommended"], resolve("truncate_field_chars"))
        self.assertEqual(shipped["recommended"], self.visible_width())
        self.assertIsNotNone(self.refusal_for("truncate_field_chars"))

        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, value, maximum=shipped["max"])})
        self.assertEqual(value, resolve("truncate_field_chars"))
        self.assertEqual(value, self.visible_width())
        self.assertIsNone(self.refusal_for("truncate_field_chars"))

    def test_narrowing_max_makes_a_previously_accepted_value_refuse(self):
        shipped = self.shipped("truncate_field_chars")
        value = shipped["max"]
        self.assertLess(shipped["recommended"], value)
        resolve = _seam(self.axi, "resolve_limit")

        self.write_project_config({"truncate_field_chars": _declare(shipped, value)})
        self.assertEqual(value, resolve("truncate_field_chars"))
        self.assertEqual(value, self.visible_width())

        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, value, maximum=value - 1)})
        self.assertEqual(shipped["recommended"], resolve("truncate_field_chars"))
        self.assertEqual(shipped["recommended"], self.visible_width())
        self.assertIsNotNone(self.refusal_for("truncate_field_chars"))


# ===========================================================================
# §S1b -- OWNERSHIP: a client reads the PROJECT's file and nobody else's
# ===========================================================================

class ClientLimitOwnershipTest(_ClientLimitsTestCase):

    def test_the_clients_crucible_toml_sits_beside_the_env_it_already_reads(self):
        self.assertTrue((Path(self.project_dir) / ".env").exists())
        self.assertEqual(os.path.join(self.project_dir, "crucible.toml"),
                         _seam(self.axi, "project_config_path")())

    def test_a_client_limit_configured_in_the_servers_file_has_no_effect_on_a_client(self):
        """The half that matters. The server and the clients are not necessarily
        on the same machine, and the server has no business dictating a display
        width to a machine it cannot see."""
        shipped = self.shipped("truncate_field_chars")
        value = shipped["min"]
        self.assertLess(value, shipped["recommended"])

        wrong_file = self.write_project_config(
            {"truncate_field_chars": _declare(shipped, value)}, directory=self.server_dir)

        # It really IS set -- in the wrong file. Parsed back off disk with
        # stdlib tomllib, so this is a fact about the FILE and not about the
        # string the test just wrote.
        with open(wrong_file, "rb") as fh:
            parsed = tomllib.load(fh)
        self.assertEqual(value, parsed["limits"]["truncate_field_chars"]["value"])

        # …and the client does not see it.
        self.assertEqual(shipped["recommended"], self.visible_width())

        # POSITIVE CONTROL -- the SAME declaration, in the PROJECT's file, does
        # move the cut. Without this the assertion above would pass against a
        # loader that read nothing at all.
        shutil.copyfile(wrong_file, os.path.join(self.project_dir, "crucible.toml"))
        self.assertEqual(value, self.visible_width())

    def test_a_server_limit_written_into_the_project_file_is_not_a_limit_a_client_resolves(self):
        shipped = self.shipped("truncate_field_chars")
        file = self.write_project_config({
            "truncate_field_chars": _declare(shipped, shipped["min"]),
            "run_abandon_ms": {
                "description": "Milliseconds an OPEN run may live before the sweep "
                               "abandons it.",
                "recommended": 60_000,
                "min": 1_000,
                "max": 86_400_000,
            },
        })
        with open(file, "rb") as fh:
            parsed = tomllib.load(fh)
        self.assertEqual(60_000, parsed["limits"]["run_abandon_ms"]["recommended"])

        resolve = _seam(self.axi, "resolve_limit")
        for server_limit in SERVER_LIMITS:
            self.assertNotIn(server_limit, _seam(self.axi, "CLIENT_LIMIT_NAMES"))
            with self.assertRaises(Exception, msg=(
                    "%s is enforced by the SERVER; a client must refuse to answer for it "
                    "rather than silently resolving a limit it does not own" % server_limit)):
                resolve(server_limit)

        # …and the foreign table does not disturb the limits the client DOES own.
        self.assertEqual(shipped["min"], self.visible_width())

    def test_with_no_server_file_reachable_every_client_limit_still_resolves(self):
        """The cross-machine case, which is the property the ownership split
        exists to guarantee: the board is on another host and its configuration
        directory simply is not on this filesystem."""
        shutil.rmtree(self.server_dir, ignore_errors=True)
        os.environ["CRUCIBLE_DB"] = os.path.join(
            self.server_dir, "no", "such", "place", "crucible.db")
        self.assertFalse(os.path.exists(self.server_dir))

        shipped = {name: self.shipped(name) for name in CLIENT_LIMITS}
        self.write_project_config(
            {name: _declare(d, d["min"]) for name, d in shipped.items()})

        resolve = _seam(self.axi, "resolve_limit")
        for name in CLIENT_LIMITS:
            self.assertEqual(shipped[name]["min"], resolve(name))
        self.assertEqual(shipped["truncate_field_chars"]["min"], self.visible_width())
        self.assertEqual(shipped["roadmap_list_rows"]["min"],
                         self.visible_rows(shipped["roadmap_list_rows"]["min"] + 5))

    def test_a_client_verb_still_formats_its_output_with_no_server_file_reachable(self):
        """Driven through the REAL entry point -- `bun-crucible.py status` with
        only the wire mocked -- because a limit that resolved in isolation but
        was never bound on the client's own boot path would be green here and
        unwired in production."""
        shutil.rmtree(self.server_dir, ignore_errors=True)
        os.environ["CRUCIBLE_DB"] = os.path.join(self.server_dir, "gone", "crucible.db")

        shipped = self.shipped("truncate_field_chars")
        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, shipped["min"])})

        client = _load_module_by_path(
            BUN_CLIENT_PATH, "bun_crucible_limits_%d" % next(_COUNTER))
        plans = {"ok": True, "plans": [
            {"planId": "plan-1", "cr": "CR-SHIPPED-001", "wave": "6",
             "status": "open", "cycles": []},
        ]}
        with mock.patch.object(client, "_get", return_value=plans):
            code, out, err = _run_main(
                client, ["status", "--project-dir", self.project_dir])

        self.assertEqual(0, code, "stdout=%r stderr=%r" % (out, err))
        self.assertIn("verb: status", out)

        # The verb's own run bound the PROJECT directory -- the real wiring,
        # not a test-only call to `bind_project_dir`.
        self.assertEqual(os.path.join(self.project_dir, "crucible.toml"),
                         client._axi().project_config_path())


# ===========================================================================
# §S1b -- degradation: an unreadable file is disclosed, never fatal
# ===========================================================================

class ClientLimitDegradationTest(_ClientLimitsTestCase):
    """With the environment layer retired there is nothing beneath the file, so
    `recommended` has to be reachable WITHOUT the file being valid: the loader
    carries the shipped table as its last resort and SAYS SO, in the shape
    CR-CRU-129's boot disclosure established (src/server.ts:311)."""

    def test_a_file_with_a_syntax_error_degrades_to_each_limits_own_recommendation(self):
        file = self.write_raw("[limits.truncate_field_chars\nrecommended = = 5\n")
        resolve = _seam(self.axi, "resolve_limit")

        for name in CLIENT_LIMITS:
            self.assertEqual(self.shipped(name)["recommended"], resolve(name))
        # …observed on the formatter itself, not only on the resolver.
        self.assertEqual(self.shipped("truncate_field_chars")["recommended"],
                         self.visible_width())

        self.assertIn(file, "\n".join(_seam(self.axi, "limit_disclosures")()),
                      "the disclosure must name WHICH file it could not read -- an operator "
                      "told only that 'a config file is broken', on a machine carrying two "
                      "of them, learns nothing")

    def test_an_absent_file_is_disclosed_by_path_and_every_limit_still_resolves(self):
        expected = os.path.join(self.project_dir, "crucible.toml")
        self.assertFalse(os.path.exists(expected))

        resolve = _seam(self.axi, "resolve_limit")
        for name in CLIENT_LIMITS:
            self.assertEqual(self.shipped(name)["recommended"], resolve(name))
        self.assertEqual(self.shipped("roadmap_list_rows")["recommended"],
                         self.visible_rows(self.shipped("roadmap_list_rows")["recommended"] + 9))

        self.assertIn(expected, "\n".join(_seam(self.axi, "limit_disclosures")()))


# ===========================================================================
# §S1 -- the seam is bound by EVERY client, not just the one with a test
# ===========================================================================

class _ProjectDirArg(str):
    """Both call conventions in the fleet, in one object.

    Four clients' project-dir resolvers take the `--project-dir` VALUE (a
    string); arduino's takes the parsed argparse NAMESPACE and reads
    `.project_dir` off it. A `str` carrying that attribute satisfies either,
    so the census below drives whichever convention a client adopts without a
    per-client table to keep in step -- which is the whole point of deriving
    the fleet rather than typing it."""

    @property
    def project_dir(self):
        return str(self)


def _client_scripts():
    """Every client in the fleet, DERIVED from the tree: `clients/*-crucible.py`.

    Typed out, this list is a sixth client's blind spot -- it would ship
    unmeasured until somebody remembered to add it here, which is precisely
    the failure the fleet census idiom exists to prevent. Globbed, a new client
    is asserted the day it lands."""
    return sorted(CLIENTS_DIR.glob("*-crucible.py"))


def _bind_project_dir_callers(path):
    """`(function names that call `bind_project_dir`, total call count)` for one
    client, read off its AST -- so a mention in a docstring or a comment counts
    for nothing and only a real call does."""
    tree = ast.parse(path.read_text())
    calls = [node for node in ast.walk(tree)
             if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute)
             and node.func.attr == "bind_project_dir"]
    callers = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if any(isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
               and c.func.attr == "bind_project_dir" for c in ast.walk(node)):
            callers.append(node.name)
    return callers, len(calls)


class ClientSeamIsBoundByEveryClientTest(_ClientLimitsTestCase):
    """"The client settings seam exists once in `clients/_crucible_axi.py` and
    all five clients resolve through it -- asserted as a caller count per
    client."

    All five DO bind it today. Only ONE of them was proved by a test, so
    deleting the bind from any of the other four would break that client's
    limit resolution -- every display width silently back on the shipped
    recommendation, every project `crucible.toml` unread -- with nothing going
    red. This class is that proof, for the fleet as the tree defines it.

    Both halves are here on purpose. The COUNT is the AC's own form and catches
    a second bind wired somewhere else (two binds is two answers to "which
    project am I in"). The BEHAVIOUR is what makes the count non-vacuous: a
    call sitting in a function nothing reaches would satisfy a source census
    and resolve nothing, so each client's own resolver is DRIVEN and the file
    it then reads is the one asserted.
    """

    def resolver_of(self, path):
        callers, total = _bind_project_dir_callers(path)
        self.assertEqual(
            1, total,
            "%s must bind the project root EXACTLY ONCE: zero binds leaves every "
            "limit on the shipped recommendation with the operator's file unread, "
            "and two is two answers to which project this client is working in "
            "(callers: %r)" % (path.name, callers))
        self.assertEqual(
            1, len(callers),
            "%s: the bind belongs to the ONE function that resolves the project "
            "root, on the client's own boot path (callers: %r)"
            % (path.name, callers))
        return callers[0]

    def test_the_fleet_is_derived_from_the_tree_and_is_not_empty(self):
        """Non-vacuity for every test below: a glob that matched nothing would
        make each of them iterate an empty fleet and pass having measured no
        client at all. FIVE is what the tree holds today; the assertion is a
        FLOOR rather than an equality, because a sixth client must be COVERED
        by the census when it lands, not rejected by it."""
        scripts = _client_scripts()
        self.assertGreaterEqual(
            len(scripts), 5,
            "the fleet is at least the five clients CR-CRU-054 consolidated; "
            "found %r" % ([p.name for p in scripts],))
        for expected in ("bun", "python", "rust", "mvn", "arduino"):
            self.assertIn("%s-crucible.py" % expected,
                          [p.name for p in scripts])

    def test_every_client_binds_the_project_root_exactly_once(self):
        offenders = {}
        for path in _client_scripts():
            callers, total = _bind_project_dir_callers(path)
            if total != 1 or len(callers) != 1:
                offenders[path.name] = "%d call(s) in %r" % (total, callers)
        self.assertEqual(
            {}, offenders,
            "§S1: every client resolves its project root through the ONE shared "
            "seam, once, on its own boot path: %r" % (offenders,))

    def test_driving_each_clients_own_resolver_binds_the_file_its_limits_read(self):
        """The behavioural half, per client: call the function the census just
        identified, then ask THAT client's copy of the shared module which file
        it now reads and what a limit configured there resolves to. A bind that
        existed in source but was never reached would pass the count and fail
        here."""
        shipped = self.shipped("truncate_field_chars")
        chosen = shipped["min"]
        self.assertNotEqual(chosen, shipped["recommended"],
                            "the configured value must be distinguishable")
        expected_file = self.write_project_config(
            {"truncate_field_chars": _declare(shipped, chosen)})

        offenders = {}
        for path in _client_scripts():
            resolver_name = self.resolver_of(path)
            client = _load_module_by_path(
                path, "%s_seam_%d" % (path.stem.replace("-", "_"), next(_COUNTER)))
            getattr(client, resolver_name)(_ProjectDirArg(self.project_dir))

            axi = client._axi()
            if axi.project_config_path() != expected_file:
                offenders[path.name] = (
                    "%s() left the module reading %r"
                    % (resolver_name, axi.project_config_path()))
                continue
            # …and the limit RESOLVES from that file, which is the behaviour the
            # bind exists for. A path that merely matched would still leave
            # every width on the recommendation.
            resolved = axi.resolve_limit("truncate_field_chars")
            if resolved != chosen:
                offenders[path.name] = (
                    "binds %s but resolves truncate_field_chars to %r, not the "
                    "configured %r" % (expected_file, resolved, chosen))
        self.assertEqual(
            {}, offenders,
            "§S1b: each client hands the shared module its ALREADY-RESOLVED "
            "project root, and the limits then resolve from that project's "
            "crucible.toml: %r" % (offenders,))


# ===========================================================================
# §S1b -- the disclosure REACHES the operator, on a real verb's envelope
# ===========================================================================

class ClientLimitDisclosureReachesTheEnvelopeTest(_ClientLimitsTestCase):
    """"A refused value is NOT silently clamped: after a refusal the running
    behaviour is the documented fallback AND the refusal was reported." The
    second half of that is a claim about REACHING somebody, and only a real
    invocation can make it.

    So every assertion below drives `bun-crucible.py` through its own `main()`
    with nothing but the wire mocked, and reads the `warnings[]` the run
    actually emitted. Calling `limit_disclosures()` and inspecting the list it
    returns would pass just as happily against a function with NO CALLERS AT
    ALL -- which is the state this class exists to make impossible, and the
    state the client half was in when VERIFY measured it.

    The envelope's `warnings[]` is the channel because it already exists,
    fleet-wide and generic (`{code, detail}`), and every consumer already
    renders it. The server discloses on the console it owns at boot; a client
    has no boot, so each invocation's envelope is its banner.
    """

    #: One open plan, so `status` has something real to render. The wire is the
    #: only thing mocked -- the verb, its formatting and its envelope are the
    #: production ones.
    PLANS = {"ok": True, "plans": [
        {"planId": "plan-1", "cr": "CR-SHIPPED-001", "wave": "6",
         "status": "open", "cycles": []},
    ]}

    def envelope_warnings(self, verb="status"):
        """The `warnings[]` a REAL run of `<verb>` emitted, decoded off the
        TOON envelope on stdout with the fleet's own decoder."""
        client = _load_module_by_path(
            BUN_CLIENT_PATH, "bun_crucible_disclosure_%d" % next(_COUNTER))
        with mock.patch.object(client, "_get", return_value=self.PLANS):
            code, out, err = _run_main(
                client, [verb, "--project-dir", self.project_dir])
        self.assertEqual(0, code, "stdout=%r stderr=%r" % (out, err))
        envelope = _load_module_by_path(
            TOON_MODULE_PATH, "crucible_toon_%d" % next(_COUNTER)).decode(out)
        self.assertIn("axi", envelope, "the verb emitted no envelope: %r" % (out,))
        return envelope["axi"].get("warnings") or []

    def disclosures_on_the_envelope(self, verb="status"):
        code = _seam(self.axi, "LIMIT_CONFIGURATION_CODE")
        return [w["detail"] for w in self.envelope_warnings(verb)
                if w.get("code") == code]

    def test_a_refused_value_is_reported_on_the_envelope_of_a_real_verb(self):
        shipped = self.shipped("truncate_field_chars")
        illegal = shipped["max"] + 1
        file = self.write_project_config(
            {"truncate_field_chars": _declare(shipped, illegal)})

        reported = self.disclosures_on_the_envelope()
        self.assertEqual(
            1, len(reported),
            "exactly one refusal was owed and the envelope carried %r" % (reported,))
        detail = reported[0]
        # WHICH limit, WHICH value, WHICH range, WHICH file -- an operator told
        # only that 'a config file is broken' learns nothing.
        self.assertIn("truncate_field_chars", detail)
        self.assertIn(str(illegal), detail)
        self.assertIn(str(shipped["min"]), detail)
        self.assertIn(str(shipped["max"]), detail)
        self.assertIn(str(shipped["recommended"]), detail)
        self.assertIn(file, detail)

        # …and the OTHER half of the same AC: the running behaviour after the
        # refusal is the documented fallback, never the illegal value and never
        # a clamp to the bound it crossed.
        self.assertEqual(shipped["recommended"], self.visible_width())

    def test_a_legal_file_leaves_the_envelope_silent(self):
        """The control. Without it a wiring that warned unconditionally -- or
        that appended the shipped table on every exit -- would satisfy every
        other test here, and an operator who had configured correctly would be
        warned about it forever."""
        for name in CLIENT_LIMITS:
            shipped = self.shipped(name)
            self.write_project_config({name: _declare(shipped, shipped["min"])})
            self.assertEqual([], self.disclosures_on_the_envelope(),
                             "%s was configured legally and was disclosed anyway" % name)

    def test_a_file_that_does_not_parse_is_reported_by_PATH_on_the_envelope(self):
        file = self.write_raw("[limits.truncate_field_chars\nrecommended = = 5\n")

        reported = self.disclosures_on_the_envelope()
        self.assertEqual(1, len(reported), reported)
        self.assertIn(file, reported[0],
                      "the disclosure must name WHICH file it could not read -- a machine "
                      "carries two crucible.toml files and the client owns exactly one")

    def test_an_absent_file_is_reported_by_PATH_on_the_envelope(self):
        expected = os.path.join(self.project_dir, "crucible.toml")
        self.assertFalse(os.path.exists(expected))

        reported = self.disclosures_on_the_envelope()
        self.assertEqual(1, len(reported), reported)
        self.assertIn(expected, reported[0])

    def test_the_disclosure_rides_every_verbs_envelope_not_one_wired_verb(self):
        """`emit_axi` is the one exit every verb of every client passes through,
        and that is where the disclosure is wired. A second verb proves the
        wiring is the shared exit rather than a line added to `status`."""
        shipped = self.shipped("roadmap_list_rows")
        file = self.write_project_config(
            {"roadmap_list_rows": _declare(shipped, shipped["min"] - 1)})

        for verb in ("status", "plans"):
            reported = self.disclosures_on_the_envelope(verb)
            self.assertEqual(1, len(reported), "%s: %r" % (verb, reported))
            self.assertIn("roadmap_list_rows", reported[0], verb)
            self.assertIn(file, reported[0], verb)

    def test_the_disclosure_is_appended_to_the_warnings_the_run_already_carried(self):
        """A disclosure that REPLACED the caller's findings would silence the
        pre-flight attribution warning, the no-report warning and every other
        `warnings[]` entry the fleet depends on. The run's own findings come
        first -- they were decided first -- and the disclosure follows."""
        shipped = self.shipped("truncate_field_chars")
        self.write_project_config(
            {"truncate_field_chars": _declare(shipped, shipped["max"] + 1)})

        carried = {"code": "caller-finding", "detail": "decided before the exit"}
        emit = _seam(self.axi, "emit_axi")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            emit("status", True, {}, {"projectKey": self.PROJECT_KEY}, [carried])
        warnings = _load_module_by_path(
            TOON_MODULE_PATH,
            "crucible_toon_%d" % next(_COUNTER)).decode(stdout.getvalue())["axi"]["warnings"]

        self.assertEqual(carried, warnings[0])
        self.assertEqual(2, len(warnings), warnings)
        self.assertEqual(_seam(self.axi, "LIMIT_CONFIGURATION_CODE"),
                         warnings[1]["code"])


if __name__ == "__main__":
    unittest.main()
