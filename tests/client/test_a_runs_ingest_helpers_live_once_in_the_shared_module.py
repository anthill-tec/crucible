"""A run's ingest helpers live once, in the shared modules.

The shared modules (`clients/_crucible_axi.py`, the core every client loads,
and `clients/_crucible_run.py`, the run pipeline the core loads and
re-exports) hold the three pieces every client that reaches the shared ingest
needs, once:

  * `filed_run(resp)` (PURE) — the answer's `run` block, `{}` when the run was
    not filed;
  * `COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"`;
  * `coverage_not_measured_warning(where)` — the warning a `--coverage` run
    carries when it left no coverage report to send.

The bun and python clients keep no copy. A source scan of each asserts:

  * no definition of `_filed_run`, `_coverage_not_measured_warning` or
    `COVERAGE_NOT_MEASURED_CODE`, and no call of either function by its
    client-local name;
  * no string literal (a `Constant`, or a `JoinedStr`'s first part) that
    begins with `ingest: ` — the human ingest line is printed by
    `ingest_reports` itself (`auto-ingest: ok=False …` and
    `ingest compile (python): ok=…` are other lines and do not match);
  * bun's `cmd_regression` and python's `_regression_run` call
    `_axi().filed_run` / `_axi().coverage_not_measured_warning` where they
    called the client's own, and bun's and python's `_emit_ingest_axi` call
    the one run emitter, `_axi().emit_run_axi`, which reads `filed_run`;
  * `_file_reports`'s only statement besides an optional docstring is
    `return _axi().ingest_reports(...)`, with the arguments it passes today.

The rust and arduino clients file through the same seam: each keeps no copy
of the helpers, and its `_file_reports` is that one statement, passing the
shared ingest the same seams and keywords.

The scanner reads a module's syntax tree, never its text, and is proved on
synthetic sources (a client still holding its own copies, and one that reads
the shared module) before it is pointed at a real client.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_a_runs_ingest_helpers_live_once_in_the_shared_module
"""

import ast
import textwrap
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"

OWN_FUNCTIONS = ("_filed_run", "_coverage_not_measured_warning")
OWN_CONSTANT = "COVERAGE_NOT_MEASURED_CODE"
SHARED_FUNCTIONS = ("coverage_not_measured_warning", "emit_run_axi", "filed_run")
INGEST_LINE_PREFIX = "ingest: "

# Where each client called its own copies, and so where it now calls the
# shared ones: `{function: (the shared names it calls, sorted)}`.
CALL_SITES = {
    "bun-crucible.py": {
        "cmd_regression": ("coverage_not_measured_warning", "filed_run"),
        "_emit_ingest_axi": ("emit_run_axi",),
    },
    "python-crucible.py": {
        "_emit_ingest_axi": ("emit_run_axi",),
        "_regression_run": ("coverage_not_measured_warning", "filed_run"),
    },
}

# The arguments `_file_reports` passes the shared ingest today.
INGEST_POSITIONAL = ("_post", "_get")
INGEST_KEYWORDS = ("agent_id", "codec", "context", "coverage_codec",
                   "coverage_paths", "project_key", "raw", "release",
                   "report_paths", "run_id", "runner_exit", "stack", "tier")

DEFINITION, OWN_CALL, INGEST_LITERAL = ("definition", "own call",
                                        "ingest line literal")


def _is_axi_call(node, attr):
    """`node` is `_axi().<attr>(...)`."""
    return (isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == attr
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Name)
            and node.func.value.func.id == "_axi")


def _ingest_line_literals(tree):
    """Every string literal that begins with `ingest: `: a `Constant` outside
    any f-string, or the first part of a `JoinedStr`."""
    in_joined = {id(part) for node in ast.walk(tree)
                 if isinstance(node, ast.JoinedStr) for part in node.values}
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            first = node.values[0] if node.values else None
            if (isinstance(first, ast.Constant) and isinstance(first.value, str)
                    and first.value.startswith(INGEST_LINE_PREFIX)):
                found.append(first.value)
        elif (isinstance(node, ast.Constant) and isinstance(node.value, str)
              and id(node) not in in_joined
              and node.value.startswith(INGEST_LINE_PREFIX)):
            found.append(node.value)
    return found


def own_copy_findings(source):
    """`[(kind, name)]` — every copy of the shared ingest helpers `source`
    still holds for itself: a definition of one, a call of one by its
    client-local name, and a literal opening the human ingest line."""
    tree = ast.parse(source)
    found = []
    for node in ast.walk(tree):
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name in OWN_FUNCTIONS):
            found.append((DEFINITION, node.name))
        elif isinstance(node, ast.Assign):
            found += [(DEFINITION, target.id) for target in node.targets
                      if isinstance(target, ast.Name) and target.id == OWN_CONSTANT]
        elif (isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
              and node.target.id == OWN_CONSTANT):
            found.append((DEFINITION, OWN_CONSTANT))
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
              and node.func.id in OWN_FUNCTIONS):
            found.append((OWN_CALL, node.func.id))
    found += [(INGEST_LITERAL, text) for text in _ingest_line_literals(tree)]
    return sorted(set(found))


def _top_level_function(tree, name):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def shared_calls_in(source, function):
    """The shared helpers top-level `function` calls as `_axi().<name>(...)`,
    sorted; `None` when `source` defines no such function."""
    node = _top_level_function(ast.parse(source), function)
    if node is None:
        return None
    return tuple(sorted({name for n in ast.walk(node) for name in SHARED_FUNCTIONS
                         if _is_axi_call(n, name)}))


def _body_past_docstring(function):
    body = list(function.body)
    if (body and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)):
        body = body[1:]
    return body


def file_reports_findings(source):
    """`[]` when `_file_reports`'s body, past an optional docstring, is the one
    statement `return _axi().ingest_reports(...)`; else the first line of each
    statement it holds there (or why it cannot be read)."""
    function = _top_level_function(ast.parse(source), "_file_reports")
    if function is None:
        return ["<no _file_reports>"]
    body = _body_past_docstring(function)
    if (len(body) == 1 and isinstance(body[0], ast.Return)
            and _is_axi_call(body[0].value, "ingest_reports")):
        return []
    return [ast.unparse(stmt).splitlines()[0] for stmt in body]


def file_reports_ingest_arguments(source):
    """`(positional, keywords)` of the `_axi().ingest_reports(...)` call inside
    `_file_reports` — the positional ones by name, the keywords sorted — or
    `None` when it makes no such call."""
    function = _top_level_function(ast.parse(source), "_file_reports")
    if function is None:
        return None
    for node in ast.walk(function):
        if _is_axi_call(node, "ingest_reports"):
            positional = tuple(arg.id if isinstance(arg, ast.Name) else ast.unparse(arg)
                               for arg in node.args)
            return positional, tuple(sorted(kw.arg for kw in node.keywords))
    return None


def _lines(findings):
    return "\n".join(f"  {kind}: {name!r}" for kind, name in findings)


# A client still writing the ingest helpers for itself, as both did before
# the shared module held them.
_CLIENT_WITH_ITS_OWN_COPIES = textwrap.dedent(r'''
    import sys

    COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"

    def _file_reports(project_dir, agent_id, *, codec, report_paths):
        """Sends the reports and prints the human ingest line."""
        resp = _axi().ingest_reports(_post, _get, stack=_STACK, codec=codec,
                                     report_paths=report_paths)
        run = _filed_run(resp)
        print(f"ingest: ok={resp.get('ok')} codec={codec} "
              f"passed={run.get('passed')}", file=sys.stderr)
        return resp

    def _filed_run(resp):
        run = resp.get("run") if isinstance(resp, dict) else None
        return run if isinstance(run, dict) else {}

    def _coverage_not_measured_warning(where):
        return {"code": COVERAGE_NOT_MEASURED_CODE, "detail": where}

    def cmd_regression(args):
        resp = _file_reports(".", "agent", codec="junit", report_paths=[])
        warnings = [_coverage_not_measured_warning("no lcov")]
        return _filed_run(resp).get("failed"), warnings

    def _emit_ingest_axi(verb, resp):
        filed = _filed_run(resp)
        print("ingest: refused", file=sys.stderr)
        return filed
''')

# The same client reading the shared module: no copy, and only lines that
# are not the ingest line open with the word.
_CLIENT_READING_THE_SHARED_MODULE = textwrap.dedent(r'''
    """A client whose docstring says the ingest line is printed by
    `ingest_reports`, and that `_filed_run` moved."""
    import sys

    def _file_reports(project_dir, agent_id, *, codec, report_paths):
        """Sends the reports through the shared ingest."""
        return _axi().ingest_reports(_post, _get, stack=_STACK, codec=codec,
                                     report_paths=report_paths)

    def cmd_regression(args, verb):
        resp = _file_reports(".", "agent", codec="junit", report_paths=[])
        warnings = [_axi().coverage_not_measured_warning("no lcov")]
        print(f"auto-ingest: ok=False -- no TEST-*.xml in {args}", file=sys.stderr)
        print(f"{verb}ingest: is not the line's first part", file=sys.stderr)
        return _axi().filed_run(resp).get("failed"), warnings

    def _emit_ingest_axi(verb, resp):
        print(f"ingest compile (python): ok={resp.get('ok')}", file=sys.stderr)
        print("ingest:no-space is not the line", file=sys.stderr)
        return _axi().filed_run(resp)
''')


class TheOwnCopyScanIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_a_client_reading_the_shared_module_has_no_finding(self):
        findings = own_copy_findings(_CLIENT_READING_THE_SHARED_MODULE)
        self.assertEqual(findings, [], _lines(findings))

    def test_every_copy_in_a_client_holding_its_own_is_found(self):
        findings = own_copy_findings(_CLIENT_WITH_ITS_OWN_COPIES)
        self.assertEqual(
            findings,
            sorted([
                (DEFINITION, "COVERAGE_NOT_MEASURED_CODE"),
                (DEFINITION, "_filed_run"),
                (DEFINITION, "_coverage_not_measured_warning"),
                (OWN_CALL, "_filed_run"),
                (OWN_CALL, "_coverage_not_measured_warning"),
                (INGEST_LITERAL, "ingest: ok="),
                (INGEST_LITERAL, "ingest: refused"),
            ]),
            _lines(findings))

    def test_an_annotated_constant_and_a_plain_ingest_literal_are_found(self):
        source = textwrap.dedent('''
            COVERAGE_NOT_MEASURED_CODE: str = "coverage-not-measured"
            LINE = "ingest: ok=True"
        ''')
        self.assertEqual(
            own_copy_findings(source),
            [(DEFINITION, "COVERAGE_NOT_MEASURED_CODE"),
             (INGEST_LITERAL, "ingest: ok=True")])

    def test_the_shared_calls_are_read_per_function(self):
        self.assertEqual(
            shared_calls_in(_CLIENT_READING_THE_SHARED_MODULE, "cmd_regression"),
            ("coverage_not_measured_warning", "filed_run"))
        self.assertEqual(
            shared_calls_in(_CLIENT_READING_THE_SHARED_MODULE, "_emit_ingest_axi"),
            ("filed_run",))
        self.assertEqual(
            shared_calls_in(_CLIENT_WITH_ITS_OWN_COPIES, "cmd_regression"), (),
            "a call of the client's own copy is not a call of the shared one")
        self.assertIsNone(
            shared_calls_in(_CLIENT_READING_THE_SHARED_MODULE, "_regression_run"),
            "a function the source does not define is told apart from one "
            "that calls nothing shared")

    def test_a_shared_call_through_another_receiver_is_not_the_shared_one(self):
        source = textwrap.dedent('''
            def _emit_ingest_axi(verb, resp):
                return helpers.filed_run(resp), _axi.filed_run(resp)
        ''')
        self.assertEqual(shared_calls_in(source, "_emit_ingest_axi"), ())

    def test_a_file_reports_that_is_one_shared_call_has_no_finding(self):
        self.assertEqual(file_reports_findings(_CLIENT_READING_THE_SHARED_MODULE), [])

    def test_a_file_reports_that_also_prints_names_each_statement(self):
        self.assertEqual(
            file_reports_findings(_CLIENT_WITH_ITS_OWN_COPIES),
            ["resp = _axi().ingest_reports(_post, _get, stack=_STACK, "
             "codec=codec, report_paths=report_paths)",
             "run = _filed_run(resp)",
             "print(f\"ingest: ok={resp.get('ok')} codec={codec} "
             "passed={run.get('passed')}\", file=sys.stderr)",
             "return resp"])

    def test_a_file_reports_returning_another_call_or_none_is_a_finding(self):
        other_call = textwrap.dedent('''
            def _file_reports(project_dir):
                return _axi().post_ingest(_post, "/api/v2/runs", {})
        ''')
        self.assertEqual(file_reports_findings(other_call),
                         ['return _axi().post_ingest(_post, \'/api/v2/runs\', {})'])
        no_return = textwrap.dedent('''
            def _file_reports(project_dir):
                """Docstring only."""
                _axi().ingest_reports(_post, _get)
        ''')
        self.assertEqual(file_reports_findings(no_return),
                         ["_axi().ingest_reports(_post, _get)"])
        self.assertEqual(file_reports_findings("x = 1\n"), ["<no _file_reports>"])

    def test_the_ingest_call_arguments_are_read_by_name(self):
        self.assertEqual(
            file_reports_ingest_arguments(_CLIENT_READING_THE_SHARED_MODULE),
            (("_post", "_get"), ("codec", "report_paths", "stack")))
        self.assertIsNone(file_reports_ingest_arguments("x = 1\n"))


class _ClientScan:
    CLIENT = None  # the client module's file name

    def source(self):
        return (CLIENTS / self.CLIENT).read_text(encoding="utf-8")

    def test_the_client_keeps_no_copy_of_the_shared_ingest_helpers(self):
        findings = own_copy_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} reads the ingest helpers from the shared module and "
            f"leaves the ingest line to `ingest_reports`; found:\n" + _lines(findings))

    def test_each_former_call_site_reads_the_shared_helpers(self):
        source = self.source()
        for function, expected in CALL_SITES[self.CLIENT].items():
            with self.subTest(function=function):
                self.assertEqual(
                    shared_calls_in(source, function), expected,
                    f"{self.CLIENT} `{function}` calls "
                    f"{', '.join(f'_axi().{name}' for name in expected)} where it "
                    f"called the client's own")

    def test_file_reports_is_one_call_of_the_shared_ingest(self):
        findings = file_reports_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} `_file_reports` is `return _axi().ingest_reports(...)` "
            f"and nothing else; it holds:\n" + "\n".join(f"  {s}" for s in findings))

    def test_file_reports_passes_the_shared_ingest_the_arguments_it_passed_before(self):
        self.assertEqual(
            file_reports_ingest_arguments(self.source()),
            (INGEST_POSITIONAL, INGEST_KEYWORDS),
            f"{self.CLIENT} `_file_reports` passes `ingest_reports` the same "
            f"seams and keywords")


class TheBunClientReadsTheSharedIngestHelpersTest(_ClientScan, unittest.TestCase):
    CLIENT = "bun-crucible.py"


class ThePythonClientReadsTheSharedIngestHelpersTest(_ClientScan, unittest.TestCase):
    CLIENT = "python-crucible.py"


class TheRustClientFilesThroughOneSharedIngestCallTest(unittest.TestCase):
    """rust held no copy of the helpers to call in their place, so it has no
    former call site; its `_file_reports` is the one shared ingest call."""

    CLIENT = "rust-crucible.py"

    def source(self):
        return (CLIENTS / self.CLIENT).read_text(encoding="utf-8")

    def test_the_rust_client_keeps_no_copy_of_the_shared_ingest_helpers(self):
        findings = own_copy_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} reads the ingest helpers from the shared module and "
            f"leaves the ingest line to `ingest_reports`; found:\n" + _lines(findings))

    def test_rust_file_reports_is_one_call_of_the_shared_ingest(self):
        findings = file_reports_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} `_file_reports` is `return _axi().ingest_reports(...)` "
            f"and nothing else; it holds:\n" + "\n".join(f"  {s}" for s in findings))

    def test_rust_file_reports_passes_the_shared_ingest_the_fleets_seams_and_keywords(self):
        self.assertEqual(
            file_reports_ingest_arguments(self.source()),
            (INGEST_POSITIONAL, INGEST_KEYWORDS),
            f"{self.CLIENT} `_file_reports` passes `ingest_reports` the same "
            f"seams and keywords as the other clients' do")


class TheArduinoClientFilesThroughOneSharedIngestCallTest(unittest.TestCase):
    """arduino held no copy of the helpers to call in their place, so it has
    no former call site; its `_file_reports` is the one shared ingest call."""

    CLIENT = "arduino-crucible.py"

    def source(self):
        return (CLIENTS / self.CLIENT).read_text(encoding="utf-8")

    def test_the_arduino_client_keeps_no_copy_of_the_shared_ingest_helpers(self):
        findings = own_copy_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} reads the ingest helpers from the shared module and "
            f"leaves the ingest line to `ingest_reports`; found:\n" + _lines(findings))

    def test_arduino_file_reports_is_one_call_of_the_shared_ingest(self):
        findings = file_reports_findings(self.source())
        self.assertEqual(
            findings, [],
            f"{self.CLIENT} `_file_reports` is `return _axi().ingest_reports(...)` "
            f"and nothing else; it holds:\n" + "\n".join(f"  {s}" for s in findings))

    def test_arduino_file_reports_passes_the_shared_ingest_the_fleets_seams_and_keywords(self):
        self.assertEqual(
            file_reports_ingest_arguments(self.source()),
            (INGEST_POSITIONAL, INGEST_KEYWORDS),
            f"{self.CLIENT} `_file_reports` passes `ingest_reports` the same "
            f"seams and keywords as the other clients' do")


class TheSharedModuleDefinesTheIngestHelpersOnceTest(unittest.TestCase):
    """The shared modules define each helper at the top level, once between
    them, and each does what both clients' copies did."""

    SHARED_MODULES = ("_crucible_axi.py", "_crucible_run.py")

    def setUp(self):
        self.axi = load_client("_crucible_axi.py")

    def trees(self):
        trees = []
        for name in self.SHARED_MODULES:
            path = CLIENTS / name
            self.assertTrue(path.is_file(), f"the shared module {name} exists")
            trees.append(ast.parse(path.read_text(encoding="utf-8")))
        return trees

    def top_level_definitions(self, name):
        count = 0
        for tree in self.trees():
            for node in tree.body:
                if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node.name == name):
                    count += 1
                elif isinstance(node, ast.Assign):
                    count += sum(1 for t in node.targets
                                 if isinstance(t, ast.Name) and t.id == name)
        return count

    def test_each_helper_is_defined_once_at_the_top_level(self):
        for name in ("filed_run", "coverage_not_measured_warning", OWN_CONSTANT):
            with self.subTest(name=name):
                self.assertEqual(self.top_level_definitions(name), 1,
                                 f"the shared modules define `{name}` exactly "
                                 f"once between them")

    def test_the_coverage_not_measured_code_is_its_warning_code(self):
        self.assertEqual(self.axi.COVERAGE_NOT_MEASURED_CODE, "coverage-not-measured")

    def test_the_coverage_not_measured_warning_names_where_and_says_no_coverage_was_sent(self):
        self.assertEqual(
            self.axi.coverage_not_measured_warning("the runner wrote no lcov.info"),
            {"code": "coverage-not-measured",
             "detail": ("--coverage was requested, and the runner wrote no "
                        "lcov.info: no coverage report was sent, so this run "
                        "is filed with no coverage")})

    def test_the_warning_carries_its_where_and_nothing_else_varies(self):
        first = self.axi.coverage_not_measured_warning("alpha")
        second = self.axi.coverage_not_measured_warning("beta")
        self.assertEqual(sorted(first), ["code", "detail"])
        self.assertEqual(first["detail"].replace("alpha", "beta"), second["detail"])
        self.assertNotIn("alpha", second["detail"])

    def test_filed_run_is_the_answers_run_block(self):
        block = {"passed": 3, "failed": 1, "pending": 1, "total": 5, "files": 2}
        self.assertEqual(self.axi.filed_run({"ok": True, "event": "e", "run": block}),
                         block)

    def test_filed_run_is_empty_when_the_run_was_not_filed(self):
        for case, resp in (("refused", {"ok": False, "error": "nothing was sent"}),
                           ("run not a block", {"ok": True, "run": ["3", "1"]}),
                           ("run null", {"ok": True, "run": None}),
                           ("no answer", None),
                           ("answer not a dict", "HTTP 500")):
            with self.subTest(case=case):
                self.assertEqual(self.axi.filed_run(resp), {})


if __name__ == "__main__":
    unittest.main()
