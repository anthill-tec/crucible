"""CR-CRU-112 AC7 — the gate, proven against the REAL historical defect.

AC7, pinned verbatim from
`docs/changes/CR-CRU-112-the-gate-covers-every-declared-suite.md`:

    "this repo's own gate, driven end to end, reports the python suite beside
    the bun suite's, and the CR-CRU-107/108 regression is demonstrably caught:
    with the CR-CRU-108 `tracks` fix reverted in a scratch copy, the gate fails
    and names the python suite. **The figure is measured at implementation
    time, not quoted from this AC** ... Assert the suite is present and its
    counts attributed, never a literal total."

COLOUR: **PIN**, both halves, stated plainly rather than dressed up as RED.
MEASURED on `feature/CR-CRU-112` @ `125c4cb`: the composition cycles 388 and
389 shipped already dispatches the python-owned declared suite, so both halves
of this file are GREEN on arrival. That is the CORRECT outcome for AC7, and
saying so is the point: AC7 asks for no new mechanism, it asks that the shipped
one be proven against the defect that ACTUALLY escaped rather than against a
synthetic one. AC2 (`test_gate_suite_outcome_reporting.py`) already plants a
fabricated failing python test; what it cannot show is that the escape of
2026-09-08 would now be caught, because a fixture that invents its own failure
has already assumed the shape of the failure it is testing for. This file
plants the REAL one, and goes RED the day the gate stops dispatching the
python suite.

THE DEFECT, restored exactly. CR-CRU-108 §S2/AC4 published `tracks` beside
`entries` and made a queue read that omits the list a HARD STOP
(`queue-track-fact-unpublished`, `clients/_crucible_axi.py`). CR-CRU-107's AC8
test — `tests/client/test_plan_file_cycle_flag_help.py`, whose `_queue()` stub
published only `entries` — began failing the moment that hard stop landed.
**Both CRs shipped green**, because `pre-merge-gate` ran `bun test` and the
broken test is python: a suite the gate could not see is a suite the gate did
not gate. Running the python suite by hand on 2026-09-08 found it in 82 s.

BOTH HALVES ARE REQUIRED, and neither is decoration. A test that only showed
the gate FAILING would also pass on a gate that fails at everything — the
condition it claims to detect would be indistinguishable from a broken gate.
So the same scratch copy is driven twice through the same fixture, the ONLY
difference between the two drives being the presence of the fix:

  * `..._when_the_tracks_fix_is_reverted`  — gate exits non-zero, `ok:false`,
    `test:client` NAMED in `warnings[]`, and its row carries 1 failure;
  * `..._when_the_tracks_fix_is_in_place`  — gate exits 0, `ok:true`, and the
    SAME suite's row carries the same total with zero failures.

FAILING FOR THE ORIGINAL REASON, not a proxy. A reverted fix that made the
suite fail for some OTHER reason (an import error, a missing path, a stray
exception) would satisfy every envelope assertion above while proving nothing
about CR-CRU-107/108. So each half also reads the JUnit XML the DISPATCHED
python client actually produced and asserts WHICH test failed and WITH WHAT:
exactly `test_the_next_envelope_help_hands_back_the_repeatable_flag`, carrying
`queue-track-fact-unpublished`. That is the historical failure by name.

THE SCRATCH COPY, and why it is a copy. The reverted fix may exist ONLY in a
temporary directory — nothing here may leave the working tree modified — so
the real test file's SOURCE is read, transformed in memory, and written into
this test's own `tempfile.mkdtemp` fixture project. Two substitutions, both
asserted to have actually applied (a substitution that silently matched
nothing would leave this file asserting against a copy it never changed):

  1. `REPO_ROOT` is re-rooted at the real repository. The copied file computes
     it as `parents[2]`, which inside the fixture project resolves to the
     tmpdir and would make every client path missing — and that file's own
     `_load_module` raises `SkipTest` for a missing path, so an un-re-rooted
     copy would report a SKIP, i.e. a PASSING gate, which is the one outcome
     that must not be reachable by accident. Applied to BOTH halves, so it can
     never be what distinguishes them.
  2. THE FIX ITSELF — the `tracks` key removed from the stub's queue payload —
     applied to the reverted half ALONE. That single deletion is CR-CRU-108's
     regression, restored.

The repository's own file is asserted UNCHANGED after each drive.

COUNTS ARE DERIVED, NEVER FROZEN — AC7 says so in as many words, and the CR's
own history is the reason: the python suite was 1445 tests / 65 files when the
CR was filed and is larger now. The expected python-suite total here is
computed by parsing the copied file's test methods with `ast` and adding the
fixture's own probe, so a test added to CR-CRU-107's file moves this number
rather than breaking this one.

THE HARNESS is cycle 389's (`test_gate_suite_outcome_reporting.py`), adopted
whole and by name, which is itself cycle 388's fixture project, stub board and
real-`main()` gate drive. Only NON-test names are taken: importing one of its
TestCases would run that cycle's suite a second time under this module. The
live board on :3849 is never touched.

Invocation:
    python3 -m unittest tests.client.test_gate_catches_the_python_suite_regression
"""

import ast
import importlib.util
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

TESTS_CLIENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_CLIENT_DIR.parents[1]
OUTCOME_HARNESS_PATH = TESTS_CLIENT_DIR / "test_gate_suite_outcome_reporting.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 389's harness, adopted whole — and through it cycle 388's, so the
# fixture project, the stub board and the drive are loaded exactly once.
_OUTCOME = _load_module(OUTCOME_HARNESS_PATH, "cr112_c3_outcome_harness")
_GATE = _OUTCOME._GATE

BUN_SUITE = _GATE.BUN_SUITE
PYTHON_SUITE = _GATE.PYTHON_SUITE
_attributed_counts = _GATE._attributed_counts
_text = _GATE._text
_ok = _OUTCOME._ok
_warnings_text = _OUTCOME._warnings_text


def setUpModule():
    _GATE.setUpModule()


def tearDownModule():
    _GATE.tearDownModule()


# ── the historical defect, named ──────────────────────────────────────────

# CR-CRU-107's AC8 test — the file CR-CRU-108 broke, and the file this test
# copies. Read, never written.
HISTORICAL_TEST_PATH = TESTS_CLIENT_DIR / "test_plan_file_cycle_flag_help.py"

# CR-CRU-108's fix, as it stands in that file's `_queue()` stub today. Removing
# this exact text is the revert.
THE_TRACKS_FIX = '"tracks": [], '

# The copied file's own root computation, and what it becomes in the scratch
# copy so the copy can still find the clients it drives.
ROOT_LINE = "REPO_ROOT = Path(__file__).resolve().parents[2]"
ROOT_REPLACEMENT = "REPO_ROOT = Path(%r)" % str(REPO_ROOT)

# WHICH test failed and WITH WHAT, on 2026-09-08 and again here: the proof that
# the reverted copy fails for the ORIGINAL reason rather than for a proxy.
BROKEN_TEST = "test_the_next_envelope_help_hands_back_the_repeatable_flag"
HARD_STOP_CODE = "queue-track-fact-unpublished"


def _historical_test_count():
    """How many tests CR-CRU-107's file contributes, DERIVED by parsing it —
    AC7 forbids a frozen literal, and a test added to that file must move this
    number rather than break this one."""
    tree = ast.parse(HISTORICAL_TEST_PATH.read_text())
    return sum(1 for klass in ast.walk(tree)
               if isinstance(klass, ast.ClassDef)
               for node in klass.body
               if isinstance(node, ast.FunctionDef)
               and node.name.startswith("test"))


# The fixture's python-owned suite once the copy is planted beside cycle 388's
# own probe: everything CR-CRU-107's file runs, plus that one probe.
PYTHON_SUITE_TOTAL = _historical_test_count() + _GATE.PYTHON_SUITE_PASSED


class GateCatchesTheHistoricalPythonSuiteRegressionTest(_OUTCOME._OutcomeCase):
    """AC7 — PIN (both methods, measured green on `125c4cb`). The gate is driven
    twice over the same scratch copy of the test CR-CRU-108 broke: once with
    that CR's fix reverted, once with it in place. The first must fail the gate
    and NAME the python suite; the second must pass it. Neither half means
    anything without the other."""

    def plant_historical_test(self, revert_the_fix):
        """Write the SCRATCH COPY of CR-CRU-107's AC8 test into this test's own
        fixture project, re-rooted, and with CR-CRU-108's fix optionally
        reverted. The repository's copy is read and never written."""
        source = HISTORICAL_TEST_PATH.read_text()
        self.assertEqual(
            source.count(ROOT_LINE), 1,
            "the scratch copy is re-rooted by substituting %r, and that text "
            "occurs %d times in %s — a substitution matching nothing would "
            "leave this test asserting against a copy it never changed"
            % (ROOT_LINE, source.count(ROOT_LINE), HISTORICAL_TEST_PATH))
        self.assertEqual(
            source.count(THE_TRACKS_FIX), 1,
            "the fix is the published `tracks` list, spelled %r in %s's queue "
            "stub, and it occurs %d times — the reproduction reverts EXACTLY "
            "that, so a file no longer carrying it once cannot be reverted here"
            % (THE_TRACKS_FIX, HISTORICAL_TEST_PATH,
               source.count(THE_TRACKS_FIX)))

        scratch = source.replace(ROOT_LINE, ROOT_REPLACEMENT)
        if revert_the_fix:
            scratch = scratch.replace(THE_TRACKS_FIX, "")
            self.assertNotIn(
                THE_TRACKS_FIX, scratch,
                "the reverted scratch copy must publish no `tracks` list")
        else:
            self.assertIn(
                THE_TRACKS_FIX, scratch,
                "the unreverted scratch copy must still publish `tracks`")

        target = Path(self.tmpdir, "tests", "client", HISTORICAL_TEST_PATH.name)
        target.write_text(scratch)
        self.addCleanup(self.assertRepositoryCopyUntouched, source)
        return target

    def assertRepositoryCopyUntouched(self, source):
        """Nothing this test does may leave the working tree modified: the
        reverted fix exists in the tmpdir alone."""
        self.assertEqual(
            HISTORICAL_TEST_PATH.read_text(), source,
            "%s changed while AC7's reproduction ran — the reverted fix must "
            "exist ONLY in the scratch copy" % HISTORICAL_TEST_PATH)

    def python_suite_failures(self):
        """`(test name, text)` for every failure and error in the JUnit XML the
        DISPATCHED python client actually produced — read so that WHICH test
        failed and WITH WHAT is asserted, not merely that something did."""
        found = []
        for report in sorted(Path(self.tmpdir, "reports").glob("TEST-*.xml")):
            root = ET.parse(report).getroot()
            for case in root.iter("testcase"):
                for bad in list(case.findall("failure")) + list(case.findall("error")):
                    found.append((case.get("name") or "",
                                  (bad.get("message") or "") + (bad.text or "")))
        return found

    def assertPythonSuiteAttributed(self, envelope, passed, failed):
        """AC7 — 'the suite is present and its counts attributed'. The counts
        hang off the row NAMING the python suite, and the bun suite's own row
        keeps its honest counts either way: a gate answering with one pooled
        total would satisfy the verdict while telling a caller nothing about
        where to look."""
        counts = _attributed_counts(envelope, PYTHON_SUITE)
        self.assertIsNotNone(
            counts,
            "AC7 — no node of the gate's envelope NAMES the python suite `%s`, "
            "so the gate ran the bun suite alone and the historical escape is "
            "still open. envelope=%s" % (PYTHON_SUITE, _text(envelope)))
        self.assertEqual(
            (counts.get("passed"), counts.get("failed"), counts.get("total")),
            (passed, failed, PYTHON_SUITE_TOTAL),
            "AC7 — the row naming `%s` must carry ITS OWN counts: %d passed, "
            "%d failed of %d. got=%s envelope=%s"
            % (PYTHON_SUITE, passed, failed, PYTHON_SUITE_TOTAL, counts,
               _text(envelope)))
        bun_counts = _attributed_counts(envelope, BUN_SUITE) or {}
        self.assertEqual(
            bun_counts.get("passed"), _GATE.BUN_SUITE_PASSED,
            "AC7 — the bun suite's row must keep its own %d passing tests "
            "beside the python suite's; got=%s envelope=%s"
            % (_GATE.BUN_SUITE_PASSED, bun_counts, _text(envelope)))

    def test_the_gate_fails_and_names_the_python_suite_when_the_tracks_fix_is_reverted(self):
        """AC7's reproduction. With CR-CRU-108's `tracks` fix reverted in the
        scratch copy, the gate must FAIL and NAME `test:client` — the escape of
        2026-09-08, run through the gate this CR built."""
        self.plant_historical_test(revert_the_fix=True)
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC7")
        envelope = self.gate_envelope(drive)

        self.assertNotEqual(
            drive.code, 0,
            "AC7 — the historical regression is back in the python suite and "
            "the gate exited 0. That is precisely how the two changes named in "
            "this file's docstring both shipped green. envelope=%s"
            % _text(envelope))
        self.assertFalse(
            _ok(envelope),
            "AC7 — the reverted fix broke the python suite and the gate's "
            "envelope says ok=%r. envelope=%s"
            % (envelope.get("ok"), _text(envelope)))
        warnings = _warnings_text(envelope)
        self.assertIn(
            PYTHON_SUITE, warnings,
            "AC7 — the gate failed but never NAMES the python suite that "
            "failed, so a caller cannot tell which suite to look at. "
            "warnings=%s envelope=%s" % (warnings, _text(envelope)))
        self.assertPythonSuiteAttributed(envelope, PYTHON_SUITE_TOTAL - 1, 1)

        failures = self.python_suite_failures()
        self.assertEqual(
            [name for name, _ in failures], [BROKEN_TEST],
            "AC7 — the reverted copy must fail for the ORIGINAL reason: "
            "exactly `%s`, the AC8 test the `tracks` hard stop broke. A "
            "different failure would prove nothing about that escape. got=%s"
            % (BROKEN_TEST, [name for name, _ in failures]))
        self.assertIn(
            HARD_STOP_CODE, failures[0][1],
            "AC7 — `%s` must fail on the queue-track hard stop `%s`; a failure "
            "carrying any other reason is a proxy, not the historical defect. "
            "got=%s" % (BROKEN_TEST, HARD_STOP_CODE, failures[0][1][-2000:]))

    def test_the_gate_passes_and_names_the_python_suite_when_the_tracks_fix_is_in_place(self):
        """AC7's converse, and the half that gives the other one meaning: with
        CR-CRU-108's fix present, the SAME scratch copy through the SAME gate
        must PASS. Without this, the reproduction above would also pass on a
        gate that fails at everything."""
        self.plant_historical_test(revert_the_fix=False)
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC7 (converse)")
        envelope = self.gate_envelope(drive)

        self.assertEqual(
            drive.code, 0,
            "AC7 (converse) — with the `tracks` list published the python suite "
            "passes, so the gate must exit 0. A gate that fails here fails "
            "always, and the reproduction beside this test would mean nothing. "
            "envelope=%s stderr=%s" % (_text(envelope), drive.err[-2000:]))
        self.assertTrue(
            _ok(envelope),
            "AC7 (converse) — every declared suite passed and the gate's "
            "envelope says ok=%r. envelope=%s"
            % (envelope.get("ok"), _text(envelope)))
        self.assertPythonSuiteAttributed(envelope, PYTHON_SUITE_TOTAL, 0)
        self.assertEqual(
            self.python_suite_failures(), [],
            "AC7 (converse) — the unreverted scratch copy must produce a clean "
            "python suite; anything failing here is a fixture defect, not a "
            "finding about the gate")


if __name__ == "__main__":
    unittest.main()
