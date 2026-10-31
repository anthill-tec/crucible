"""xmlrunner has left the python client (CR-CRU-224 §S4, AC11).

Each rule is a checker over text, proved on synthetic text (a violation and a
clean case) before it is run on the real file:

- no file under `clients/` or `crucible_axi/` imports, runs or names
  xmlrunner, outside a `#` comment recording its removal;
- `pyproject.toml` lists no `unittest-xml-reporting`, and its comments name
  neither it nor xmlrunner;
- the python client's help for a unittest run names no xmlrunner;
- the unittest `subtests-uncounted` warning and the runner's fallback signal
  are gone (pytest's warning stays);
- PRD §4.4, the DN client-fleet inventory's `cmd_test` row, the live-progress
  DN's declaration paragraph and `tests/fixtures/reports/README.md` read as
  §S4 states.
"""

import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"
PACKAGE = REPO_ROOT / "crucible_axi"
PYPROJECT = REPO_ROOT / "pyproject.toml"
PRD = REPO_ROOT / "docs" / "research" / "PRD-crucible-v2.md"
INVENTORY = REPO_ROOT / "docs" / "research" / "DN-client-fleet-inventory.md"
LIVE_DN = REPO_ROOT / "docs" / "research" / "DN-crucible-live-test-progress.md"
REPORTS_README = REPO_ROOT / "tests" / "fixtures" / "reports" / "README.md"

TEXT_SUFFIXES = {".py", ".toml", ".md", ".txt", ".json", ".sh", ".cfg", ".ini", ".service"}

#: What a comment recording xmlrunner's removal says.
REMOVAL_WORDS = re.compile(r"\b(removed|no longer|retired|dropped|left)\b", re.IGNORECASE)
XMLRUNNER = re.compile(r"xmlrunner", re.IGNORECASE)
#: The change the fixtures README must name as the one xmlrunner left with.
REMOVING_CHANGE = "CR-CRU-224"


def xmlrunner_mentions(text):
    """Every line of `text` naming xmlrunner other than a `#` comment that
    records its removal, as `(line number, line)`."""
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        if not XMLRUNNER.search(line):
            continue
        stripped = line.strip()
        if stripped.startswith("#") and REMOVAL_WORDS.search(stripped):
            continue
        found.append((number, stripped))
    return found


def shipped_text_files():
    for root in (CLIENTS, PACKAGE):
        for path in sorted(root.rglob("*")):
            if "__pycache__" in path.parts or not path.is_file():
                continue
            if path.suffix in TEXT_SUFFIXES:
                yield path


def pyproject_names_the_reporter(text):
    """Lines of a pyproject naming the JUnit reporter package or xmlrunner."""
    return [line.strip() for line in text.splitlines()
            if re.search(r"unittest-xml-reporting|xmlrunner", line, re.IGNORECASE)]


def section(text, heading_prefix):
    """The markdown section whose heading starts with `heading_prefix`, up to
    the next heading of the same or a higher level. None when absent."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        match = re.match(r"^(#+)\s+(.*)$", line)
        if match and match.group(2).startswith(heading_prefix):
            level = len(match.group(1))
            body = []
            for later in lines[i + 1:]:
                nxt = re.match(r"^(#+)\s", later)
                if nxt and len(nxt.group(1)) <= level:
                    break
                body.append(later)
            return "\n".join(body)
    return None


def names_the_unittest_stream(text):
    """Whether `text` says python unittest's record is the `crucible-events`
    stream: both named within one paragraph."""
    for paragraph in re.split(r"\n\s*\n", text or ""):
        if re.search(r"unittest", paragraph, re.IGNORECASE) and "crucible-events" in paragraph:
            return True
    return False


def cmd_test_row(text):
    rows = [line for line in text.splitlines() if line.startswith("| `cmd_test`")]
    return rows[0] if rows else None


def records_no_unittest_declaration(text):
    """Whether `text` records that python unittest declares no stream."""
    return re.search(r"unittest.{0,240}?(declares no|needs no|no stream declaration)",
                     text or "", re.IGNORECASE | re.DOTALL) is not None


def readme_records_the_frozen_fixture(text):
    """Whether the README's `python/xmlrunner/` paragraph records that the
    fixture stays frozen for the `junit` codec and `auto-ingest`, made before
    CR-CRU-224 by a runner that no longer writes JUnit."""
    for paragraph in re.split(r"\n\s*\n", text):
        if "python/xmlrunner/" not in paragraph:
            continue
        if (re.search(r"\bfrozen\b", paragraph, re.IGNORECASE)
                and "auto-ingest" in paragraph and "junit" in paragraph
                and REMOVING_CHANGE in paragraph
                and re.search(r"no longer writes JUnit", paragraph, re.IGNORECASE)):
            return True
    return False


class NoShippedFileNamesXmlrunnerTest(unittest.TestCase):

    def test_the_mention_checker_allows_only_a_comment_recording_the_removal(self):
        synthetic = ("import xmlrunner\n"
                     '"""Runs unittest through xmlrunner."""\n'
                     "# xmlrunner left the client with CR-CRU-224\n"
                     "# runs xmlrunner's entry point\n"
                     "cmd = [python, '-m', 'xmlrunner']\n"
                     "plain = 1\n")
        self.assertEqual([n for n, _l in xmlrunner_mentions(synthetic)], [1, 2, 4, 5])
        self.assertEqual(xmlrunner_mentions("# xmlrunner was removed\nx = 1\n"), [])

    def test_no_file_under_clients_or_crucible_axi_names_xmlrunner(self):
        offenders = {}
        for path in shipped_text_files():
            found = xmlrunner_mentions(path.read_text(encoding="utf-8", errors="replace"))
            if found:
                offenders[str(path.relative_to(REPO_ROOT))] = found
        self.assertEqual(offenders, {},
                         "xmlrunner leaves the python client and its install (§S4)")


class PyprojectDropsTheReporterTest(unittest.TestCase):

    def test_the_pyproject_checker_finds_the_package_and_its_comment(self):
        synthetic = ('dev = ["coverage==7.17.0", "unittest-xml-reporting==4.0.0"]\n'
                     "# the client runs `python -m xmlrunner`\n"
                     'other = ["ruff"]\n')
        self.assertEqual(len(pyproject_names_the_reporter(synthetic)), 2)
        self.assertEqual(pyproject_names_the_reporter('dev = ["coverage==7.17.0"]\n'), [])

    def test_pyproject_lists_no_unittest_xml_reporting_and_names_none(self):
        self.assertEqual(pyproject_names_the_reporter(PYPROJECT.read_text(encoding="utf-8")), [])


class TheClientsHelpAndWarningsDropXmlrunnerTest(unittest.TestCase):

    VERBS = ("test", "unit", "regression", "pre-merge-gate")

    def test_the_help_of_every_unittest_running_verb_names_no_xmlrunner(self):
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / "python-crucible.py"), verb, "--help"],
                    capture_output=True, text=True, timeout=60, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("xmlrunner", result.stdout.lower(), result.stdout)

    def test_a_unittest_run_no_longer_warns_subtests_uncounted(self):
        client = load_client("python-crucible.py")
        fallback_line = ("[subtest-runner] subtests-uncounted: xmlrunner offers no "
                         "result class to extend (xmlrunner version: 4.0.0)\n")
        watch = client._FallbackWatch(None, client._UNITTEST)
        watch.observe(fallback_line)
        watch.observe("test_one (tests.test_x.Case.test_one) ... ok\n")
        self.assertEqual(watch.warnings(), [],
                         "the unittest subtests-uncounted warning is removed")

    def test_a_pytest_run_still_warns_subtests_uncounted(self):
        client = load_client("python-crucible.py")
        watch = client._FallbackWatch(None, client._PYTEST)
        watch.observe("tests/test_x.py::test_loop [i=0] SUBPASSED\n")
        self.assertEqual([w["code"] for w in watch.warnings()], ["subtests-uncounted"])

    def test_the_runner_and_the_client_name_no_fallback_signal(self):
        runner = (CLIENTS / "subtest_runner.py").read_text(encoding="utf-8")
        client = (CLIENTS / "python-crucible.py").read_text(encoding="utf-8")
        self.assertFalse("FALLBACK_SIGNAL" in runner,
                         "subtest_runner.py still defines its fallback signal")
        self.assertFalse("_FALLBACK_SIGNAL_LINE" in client,
                         "python-crucible.py still reads the fallback signal")


class TheDesignRecordReadsAsSection4StatesTest(unittest.TestCase):

    def test_the_document_checkers_tell_the_new_record_from_the_old(self):
        old_prd = ("### 4.4 Test ingest\n\nEvery runner writes JUnit (`xmlrunner`, surefire).\n"
                   "### 4.5 Compile ingest\n")
        new_prd = ("### 4.4 Test ingest\n\nA python unittest run streams its record in "
                   "`crucible-events`; pytest keeps JUnit.\n### 4.5 Compile ingest\n")
        self.assertFalse(names_the_unittest_stream(section(old_prd, "4.4")))
        self.assertTrue(names_the_unittest_stream(section(new_prd, "4.4")))
        self.assertIsNone(section(new_prd, "9.9"))
        self.assertTrue(records_no_unittest_declaration(
            "Python unittest declares no stream: its runner is Crucible's own."))
        self.assertFalse(records_no_unittest_declaration("A bun project declares one table."))
        self.assertTrue(readme_records_the_frozen_fixture(
            "**python/xmlrunner/** stays frozen for the `junit` codec and `auto-ingest`; "
            f"it was produced before {REMOVING_CHANGE} by a runner that no longer writes JUnit."))
        self.assertFalse(readme_records_the_frozen_fixture(
            "**python/xmlrunner/** — a `pkg` package run through xmlrunner."))

    def test_prd_section_4_4_names_the_stream_for_python_unittest(self):
        body = section(PRD.read_text(encoding="utf-8"), "4.4")
        self.assertIsNotNone(body, "PRD §4.4 exists")
        self.assertTrue(names_the_unittest_stream(body),
                        "PRD §4.4 names the crucible-events stream for python unittest")

    def test_the_fleet_inventory_names_the_stream_for_python_unittest(self):
        row = cmd_test_row(INVENTORY.read_text(encoding="utf-8"))
        self.assertIsNotNone(row, "the inventory has its `cmd_test` row")
        self.assertNotIn("xmlrunner", row or "")
        self.assertIn("stream", row or "")

    def test_the_live_progress_dn_records_that_python_unittest_declares_no_stream(self):
        body = section(LIVE_DN.read_text(encoding="utf-8"), "Declaration")
        self.assertIsNotNone(body, "the DN's declaration paragraph exists")
        self.assertTrue(records_no_unittest_declaration(body),
                        "the declaration paragraph records python unittest's exception")

    def test_the_reports_readme_records_the_frozen_xmlrunner_fixture(self):
        self.assertTrue(readme_records_the_frozen_fixture(
            REPORTS_README.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
