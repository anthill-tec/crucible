"""A client parses none of its runner's reports.

The board decodes every report a client sends (`POST /api/v2/runs`), so a
client module defines no JUnit parse, no lcov summation, no console parse and
no classname grouping. It keeps only the counts it needs before any ingest,
and the scan exempts only those: `junit_testcase_count` and
`junit_non_skipped_count` ("ran nothing" and bun's filter check) in either
client, and in the bun client alone `_raw_report_result_count` (a Playwright
report's result count, until that report retires). The python client has no
raw report, so its scan exempts the two JUnit counts and nothing else.

The scan reads a module's syntax tree, never its text, so a docstring or a
comment that names a report shape is not a parse:

  * JUnit parse — a call of an XML parser (`ET.parse`, `ET.fromstring`,
    `ET.iterparse`, `ElementTree.parse`, `minidom.parse(String)`), or a walk of
    a report's elements (`.iter`/`.find`/`.findall`/`.iterfind` of `testcase`,
    `testsuite`, `failure`, `error`, `skipped`);
  * classname grouping — the `classname` attribute named anywhere;
  * lcov summation — an lcov record named (`LF:`, `LH:`, `FNF:`, `FNH:`,
    `BRF:`, `BRH:`, `DA:`, `SF:`, `end_of_record`);
  * console parse — the shapes bun's console failure reading matches: the
    `# Unhandled error between tests` header, a pattern selecting failing
    result lines alone (`(?:✗|\\(fail\\))`), the source echo gutter of a test
    declaration, and the caret line under it. The live narration's own
    completion pattern, which counts passing and failing lines alike, is a
    stream reader and not a parse.

The checker is proved on synthetic sources (a violation of each kind, an
exempt count, and a clean client) before it is pointed at a real module.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_a_client_parses_no_report
"""

import ast
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"

EXEMPT = ("junit_testcase_count", "junit_non_skipped_count",
          "_raw_report_result_count")
# The python client's exemptions: the two JUnit counts, never bun's raw one.
PYTHON_EXEMPT = ("junit_testcase_count", "junit_non_skipped_count")

XML_MODULES = ("ET", "ElementTree", "etree", "minidom")
XML_PARSERS = ("parse", "fromstring", "iterparse", "XML", "parseString")
ELEMENT_WALKS = ("iter", "find", "findall", "iterfind")
JUNIT_ELEMENTS = ("testcase", "testsuite", "failure", "error", "skipped")
LCOV_RECORDS = ("LF:", "LH:", "FNF:", "FNH:", "BRF:", "BRH:", "DA:", "SF:")
CONSOLE_MARKERS = (
    "Unhandled error between tests",
    r"(?:✗|\(fail\))",
    r"\s*\|\s*(?:test|it)",
    r"^\s*\^\s*$",
)

JUNIT, CLASSNAME, LCOV, CONSOLE = ("JUnit parse", "classname grouping",
                                   "lcov summation", "console parse")


def _docstring_nodes(tree):
    return {id(node.value) for node in ast.walk(tree)
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)}


def _findings_in(node, owner, docstrings):
    found = []
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            target = n.func.value
            base = (target.id if isinstance(target, ast.Name)
                    else target.attr if isinstance(target, ast.Attribute) else None)
            if n.func.attr in XML_PARSERS and base in XML_MODULES:
                found.append((owner, JUNIT, f"{base}.{n.func.attr}"))
            if (n.func.attr in ELEMENT_WALKS and n.args
                    and isinstance(n.args[0], ast.Constant)
                    and n.args[0].value in JUNIT_ELEMENTS):
                found.append((owner, JUNIT, f".{n.func.attr}({n.args[0].value!r})"))
        if (isinstance(n, ast.Constant) and isinstance(n.value, str)
                and id(n) not in docstrings):
            text = n.value
            if text == "classname":
                found.append((owner, CLASSNAME, "classname"))
            if text.startswith(LCOV_RECORDS) or text == "end_of_record":
                found.append((owner, LCOV, text))
            for marker in CONSOLE_MARKERS:
                if marker in text:
                    found.append((owner, CONSOLE, marker))
    return found


def report_parse_findings(source, exempt=EXEMPT):
    """`[(owner, kind, marker)]` — every report parse `source` holds, its owner
    the top-level function (or `<module>`) holding it; the `exempt` counts are
    not read."""
    tree = ast.parse(source)
    docstrings = _docstring_nodes(tree)
    found = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in exempt:
                continue
            found += _findings_in(node, node.name, docstrings)
        elif isinstance(node, ast.ClassDef):
            found += _findings_in(node, node.name, docstrings)
        else:
            found += _findings_in(node, "<module>", docstrings)
    return sorted(set(found))


def _lines(findings):
    return "\n".join(f"  {owner}: {kind} ({marker})" for owner, kind, marker in findings)


_CLEAN_CLIENT = textwrap.dedent(r'''
    """A client that names JUnit, lcov, `classname` and `(fail)` lines only in
    its docstrings, as prose."""
    import json
    import re
    import xml.etree.ElementTree as ET

    _COMPLETION_LINE = re.compile(r"^(?:[✓✗]|\((?:pass|fail)\))\s")
    LCOV_FILE = "lcov.info"


    def junit_testcase_count(paths):
        return sum(1 for p in paths for _ in ET.parse(p).getroot().iter("testcase"))


    def junit_non_skipped_count(paths):
        return sum(1 for p in paths for c in ET.parse(p).getroot().iter("testcase")
                   if c.find("skipped") is None)


    def _raw_report_result_count(raw_report):
        with open(raw_report["path"]) as handle:
            return len(json.load(handle).get("suites") or [])


    def _send(paths, lcov_dir):
        """Sends the JUnit report and its lcov; parses neither."""
        texts = [open(p).read() for p in paths]
        return {"codec": "junit", "data": texts,
                "coverage": {"codec": "lcov", "data": [lcov_dir + "/" + LCOV_FILE]}}
''')

_VIOLATING_CLIENT = textwrap.dedent(r'''
    import re
    import xml.etree.ElementTree as ET
    from xml.dom import minidom

    _FAIL_LINE = re.compile(r"^" + r"(?:✗|\(fail\))" + r"\s+(?P<name>.*)$")
    _ECHO = re.compile(r"^\s*\d+\s*\|\s*(?:test|it)\s*\(")
    _CARET = re.compile(r"^\s*\^\s*$")
    _UNHANDLED = "# Unhandled error between tests"


    def _parse_junit(path):
        root = ET.parse(path).getroot()
        return [case.get("name") for case in root.iter("testcase")]


    def _parse_text(text):
        return minidom.parseString(text)


    def _group(cases):
        groups = {}
        for case in cases:
            groups.setdefault(case.get("classname"), []).append(case)
        return groups


    def _sum_lcov(path):
        lf = lh = 0
        for line in open(path):
            if line.startswith("LF:"):
                lf += int(line[3:])
            elif line.startswith("LH:"):
                lh += int(line[3:])
        return lh, lf
''')


class TheReportParseScanIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_a_clean_client_with_only_the_exempt_counts_has_no_finding(self):
        self.assertEqual(report_parse_findings(_CLEAN_CLIENT), [],
                         _lines(report_parse_findings(_CLEAN_CLIENT)))

    def test_every_kind_of_parse_in_a_violating_client_is_found(self):
        findings = report_parse_findings(_VIOLATING_CLIENT)
        self.assertEqual(
            findings,
            sorted([
                ("<module>", CONSOLE, r"(?:✗|\(fail\))"),
                ("<module>", CONSOLE, r"\s*\|\s*(?:test|it)"),
                ("<module>", CONSOLE, r"^\s*\^\s*$"),
                ("<module>", CONSOLE, "Unhandled error between tests"),
                ("_parse_junit", JUNIT, "ET.parse"),
                ("_parse_junit", JUNIT, ".iter('testcase')"),
                ("_parse_text", JUNIT, "minidom.parseString"),
                ("_group", CLASSNAME, "classname"),
                ("_sum_lcov", LCOV, "LF:"),
                ("_sum_lcov", LCOV, "LH:"),
            ]),
            _lines(findings))

    def test_only_the_three_named_counts_are_exempt(self):
        # The same body under another name is a parse.
        renamed = _CLEAN_CLIENT.replace("def junit_testcase_count",
                                        "def _count_cases")
        self.assertEqual(
            report_parse_findings(renamed),
            [("_count_cases", JUNIT, ".iter('testcase')"),
             ("_count_cases", JUNIT, "ET.parse")],
            _lines(report_parse_findings(renamed)))

    def test_the_python_exemptions_are_the_two_junit_counts_alone(self):
        # Under the python client's exemptions bun's raw-report count is a
        # parse like any other function; the two JUnit counts stay exempt.
        self.assertEqual(
            [kind for owner, kind, _marker
             in report_parse_findings(_CLEAN_CLIENT, PYTHON_EXEMPT)
             if owner != "_raw_report_result_count"],
            [], _lines(report_parse_findings(_CLEAN_CLIENT, PYTHON_EXEMPT)))
        violating = _CLEAN_CLIENT.replace(
            "def _raw_report_result_count(raw_report):\n"
            "    with open(raw_report[\"path\"]) as handle:\n"
            "        return len(json.load(handle).get(\"suites\") or [])",
            "def _raw_report_result_count(path):\n"
            "    return len(list(ET.parse(path).getroot().iter(\"testcase\")))")
        self.assertNotEqual(violating, _CLEAN_CLIENT, "fixture -- the body was replaced")
        self.assertEqual(
            report_parse_findings(violating, PYTHON_EXEMPT),
            [("_raw_report_result_count", JUNIT, ".iter('testcase')"),
             ("_raw_report_result_count", JUNIT, "ET.parse")],
            _lines(report_parse_findings(violating, PYTHON_EXEMPT)))
        self.assertEqual(report_parse_findings(violating), [],
                         "under bun's exemptions the same function is exempt")


class TheBunClientParsesNoReportTest(unittest.TestCase):

    def test_the_bun_client_module_defines_no_report_parse(self):
        findings = report_parse_findings(
            (CLIENTS / "bun-crucible.py").read_text(encoding="utf-8"))
        self.assertEqual(
            findings, [],
            "the bun client parses none of its runner's reports; found:\n"
            + _lines(findings))


class ThePythonClientParsesNoReportTest(unittest.TestCase):

    def test_the_python_client_module_defines_no_report_parse(self):
        """No JUnit parse, no lcov summation and no classname grouping in
        `python-crucible.py`: only the two shared JUnit counts it calls are
        exempt, and they live in the shared module."""
        findings = report_parse_findings(
            (CLIENTS / "python-crucible.py").read_text(encoding="utf-8"),
            PYTHON_EXEMPT)
        self.assertEqual(
            findings, [],
            "the python client parses none of its runner's reports; found:\n"
            + _lines(findings))


if __name__ == "__main__":
    unittest.main()
