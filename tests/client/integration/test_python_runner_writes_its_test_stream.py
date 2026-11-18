"""The python runner writes the Crucible event stream (CR-CRU-224 §S1, AC1).

`clients/subtest_runner.py` runs plain `unittest` through a
`unittest.TextTestRunner`, with no xmlrunner. With `CRUCIBLE_STREAM` naming a
file, it writes one JSON object per line to it: a `run-start` carrying
`countTestCases()`, one `test-end` per case CR-CRU-189 counts, and a
`run-end` whose totals are the `test-end` counts. Each line is written with
`json.dumps`' default `ensure_ascii`, and flushed as it is written.

Every check here but one runs the REAL runner as a subprocess on a scratch
copy of the committed fixture `tests/fixtures/unittest-project` (or on a
scratch project this file writes), and asserts what the run observably did: the
stream file, the exit code, the console, and what the fixture's own witness
tests recorded from inside the run (`test_witness.py`, see the fixture's
README). The one exception drives the runner's result in process on a
stand-in clock, to pin how a duration is rounded. The stream's cases are
compared with `expected.json`, frozen from
xmlrunner 4.0.0's report of the same cases before xmlrunner was removed,
under the same path normalisation and failure digest.

Pins, which hold before §S1 lands:
- `test_the_fixture_run_exits_1` guards against a runner that answers 0 or 5
  for a run with failing cases.

Three rules this file pins beside the stream's shape:
- every `duration_ms` is a whole number of milliseconds, rounded half up as
  the board's JUnit reading rounds a duration (`toDurationMs`,
  src/codecs/junit.ts), so a streamed run's durations read as its JUnit
  record's did;
- a case's `file` is relative to the directory the runner was started in,
  even when the case ends while its test has moved the working directory
  elsewhere, as xmlrunner's report named it (it resolved every file once, at
  the end of the run);
- the runner takes unittest's own command line, so an `-o <dir>` (the
  reports option of the command line before CR-CRU-224) is refused as
  `python -m unittest` refuses it: argparse's usage error, exit 2, no test
  run.

Checker self-tests, which pass by design: the two synthetic-source tests of
`xmlrunner_imports` prove the import check both ways before it reads the
real runner's source.
"""

import ast
import importlib.util
import io
import json
import math
import re
import resource
import signal
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import new_scratch
from tests.client.unittest_project_fixture import (
    DISCOVER_ALL,
    DISCOVER_WITNESSES,
    PYTHON,
    RUNNER,
    STREAM_VAR,
    FixtureRun,
    console_description,
    copy_fixture,
    digest,
    events_of,
    expected,
    is_duration,
    normalise,
    output_of,
    run_runner,
    runner_env,
    stream_lines,
    stream_text,
)

# unittest's verbose verdict words, after a case's description and ` ... `.
VERDICT = r"(?:ok|FAIL|ERROR|skip(?:ped)?|expected failure|unexpected success)\b"

# The cap on the stream file's size in the failing-write run: the run-start
# line and a few test-end lines fit, the rest of the run's lines do not.
STREAM_SIZE_CAP = 700


def _verdict_lines(output, description):
    pattern = re.compile(rf"^\s*{re.escape(description)} \.\.\. {VERDICT}", re.MULTILINE)
    return pattern.findall(output)


def _test_ends(events):
    return [e for e in events if e.get("event") == "test-end"]


def _counts(test_ends):
    statuses = [e.get("status") for e in test_ends]
    return {"total": len(statuses), "passed": statuses.count("pass"),
            "failed": statuses.count("fail"), "pending": statuses.count("pending")}


class TheFixtureStreamHoldsEveryCountedCaseTest(unittest.TestCase):
    """One streamed run of the whole fixture, read whole."""

    @classmethod
    def setUpClass(cls):
        cls.run_ = FixtureRun("unittest-runner-stream-")
        cls.expected = expected()

    def _stream(self):
        text = stream_text(self.run_.stream)
        self.assertIsNotNone(
            text, f"the runner wrote no stream at {STREAM_VAR}; "
                  f"exit={self.run_.result.returncode} output tail={self.run_.output[-800:]!r}")
        assert text is not None
        return text

    def test_the_fixture_run_exits_1(self):
        # PIN: holds before §S1; guards against 0 or 5 for a failing run.
        self.assertEqual(self.run_.result.returncode, self.expected["exitCode"],
                         f"output={self.run_.output[-3000:]!r}")
        self.assertEqual(self.expected["exitCode"], 1)

    def test_every_line_is_one_ascii_json_object_ending_in_a_newline(self):
        text = self._stream()
        self.assertTrue(text.endswith("\n"), f"the last line is unterminated: {text[-200:]!r}")
        for line in stream_lines(text):
            self.assertTrue(line.isascii(),
                            f"a line is not ASCII, so not json.dumps' default ensure_ascii: {line!r}")
            event = json.loads(line)
            self.assertIsInstance(event, dict, line)
            self.assertIn(event.get("event"), ("run-start", "test-end", "run-end"), line)

    def test_the_stream_opens_with_one_run_start_carrying_count_test_cases(self):
        events = events_of(self._stream())
        starts = [e for e in events if e.get("event") == "run-start"]
        self.assertEqual(len(starts), 1, f"run-starts: {starts!r}")
        self.assertEqual(events[0].get("event"), "run-start", f"first event: {events[0]!r}")
        self.assertEqual(starts[0].get("total"), self.expected["countTestCases"])
        self.assertEqual(starts[0].get("total"), 20)

    def test_one_test_end_per_counted_case_with_the_fields_expected_json_freezes(self):
        ends = _test_ends(events_of(self._stream()))
        self.assertEqual(len(ends), self.expected["caseCount"],
                         f"test-end ids: {[e.get('id') for e in ends]!r}")
        by_id = {}
        for end in ends:
            self.assertNotIn(end.get("id"), by_id, f"the id {end.get('id')!r} is streamed twice")
            by_id[end.get("id")] = end
        want_ids = sorted(c["id"] for c in self.expected["cases"])
        self.assertEqual(sorted(by_id), want_ids)
        for case in self.expected["cases"]:
            end = by_id[case["id"]]
            with self.subTest(id=case["id"]):
                self.assertEqual(end.get("name"), case["name"])
                self.assertEqual(end.get("suite"), case["suite"])
                self.assertEqual(normalise(end.get("file"), self.run_.project), case["file"])
                self.assertEqual(end.get("status"), case["status"])
                self.assertTrue(is_duration(end.get("duration_ms")),
                                f"duration_ms must be a number >= 0: {end.get('duration_ms')!r}")
                if case["status"] == "fail":
                    self.assertIsInstance(end.get("failure"), dict, end)
                    self.assertEqual(digest(end["failure"], self.run_.project), case["failure"])
                else:
                    self.assertNotIn("failure", end,
                                     "only a failing case carries a failure; a skip's reason is none")

    def test_the_stream_closes_with_one_run_end_whose_totals_are_the_test_end_counts(self):
        events = events_of(self._stream())
        ends = [e for e in events if e.get("event") == "run-end"]
        self.assertEqual(len(ends), 1, f"run-ends: {ends!r}")
        self.assertEqual(events[-1].get("event"), "run-end", f"last event: {events[-1]!r}")
        run_end = ends[0]
        counts = _counts(_test_ends(events))
        stated = {k: run_end.get(k) for k in ("total", "passed", "failed", "pending")}
        self.assertEqual(stated, counts)
        self.assertEqual(stated, self.expected["summary"])
        self.assertTrue(is_duration(run_end.get("duration_ms")), run_end)

    def test_every_duration_the_stream_states_is_a_whole_number_of_milliseconds(self):
        events = events_of(self._stream())
        stated = [(e.get("event"), e.get("id"), e.get("duration_ms")) for e in events
                  if e.get("event") in ("test-end", "run-end")]
        self.assertEqual(len(stated), self.expected["caseCount"] + 1,
                         f"one duration per test-end and one for the run-end: {stated!r}")
        not_whole = [s for s in stated if type(s[2]) is not int or s[2] < 0]
        self.assertEqual(not_whole, [],
                         "every duration_ms is a whole number of milliseconds (an int "
                         ">= 0), as the JUnit reading of the same run stored it")

    def test_each_line_is_in_the_file_before_the_next_test_starts(self):
        lines = stream_lines(self._stream())
        for witness in ("test_first_look_at_the_stream", "test_second_look_at_the_stream"):
            with self.subTest(witness=witness):
                own_id = f"test_witness.WitnessTest.{witness}"
                own = [i for i, line in enumerate(lines) if json.loads(line).get("id") == own_id]
                self.assertEqual(len(own), 1, f"the witness {own_id} has no single test-end")
                seen = self.run_.witness(witness)
                self.assertIsNotNone(seen, f"the witness {witness} recorded nothing")
                assert seen is not None
                # Everything written before the witness started, and nothing more.
                self.assertEqual(seen["stream"], "".join(lines[:own[0]]))
        environment_end = next(i for i, line in enumerate(lines) if json.loads(line).get("id")
                               == "test_witness.WitnessTest.test_records_its_environment")
        second = self.run_.witness("test_second_look_at_the_stream")
        assert second is not None
        self.assertIn(lines[environment_end], second["stream"],
                      "the case just before the second look must already be in the file")

    def test_crucible_stream_is_gone_from_the_tests_own_environment(self):
        recorded = self.run_.witness("test_records_its_environment")
        self.assertIsNotNone(recorded, "the environment witness recorded nothing")
        self.assertEqual(recorded, {"present": False, "value": None})

    def test_the_console_prints_one_verdict_line_per_counted_case(self):
        output = self.run_.output
        wrong = {}
        for case in self.expected["cases"]:
            description = console_description(case["id"])
            found = len(_verdict_lines(output, description))
            if found != 1:
                wrong[description] = found
        self.assertEqual(wrong, {}, f"descriptions without exactly one verdict line "
                                    f"(count found); output tail={output[-1500:]!r}")
        every = re.findall(rf" \.\.\. {VERDICT}", output)
        self.assertEqual(len(every), self.expected["caseCount"], f"output tail={output[-1500:]!r}")


class TheRunnerExitsWithUnittestsOwnCodesTest(unittest.TestCase):
    """0 for a passing run, 5 when no test ran, 1 otherwise (the fixture's
    1 is pinned above)."""

    def test_a_selection_that_discovers_no_test_exits_5_and_streams_an_empty_run(self):
        project = copy_fixture("unittest-runner-no-test-")
        stream = project.parent / "crucible-events.ndjson"
        result = run_runner(project, ["discover", "-s", "tests", "-p", "no_such_module_*.py", "-v"],
                            runner_env(stream))
        self.assertEqual(result.returncode, 5, f"output={output_of(result)[-3000:]!r}")
        text = stream_text(stream)
        self.assertIsNotNone(text, f"no stream; output={output_of(result)[-3000:]!r}")
        assert text is not None
        events = events_of(text)
        self.assertEqual([e.get("event") for e in events], ["run-start", "run-end"])
        self.assertEqual(events[0].get("total"), 0)
        self.assertEqual({k: events[1].get(k) for k in ("total", "passed", "failed", "pending")},
                         {"total": 0, "passed": 0, "failed": 0, "pending": 0})

    def test_an_all_pass_discovery_exits_0_and_streams_three_passes(self):
        project = copy_fixture("unittest-runner-all-pass-")
        stream = project.parent / "crucible-events.ndjson"
        result = run_runner(project, DISCOVER_WITNESSES, runner_env(stream))
        self.assertEqual(result.returncode, 0, f"output={output_of(result)[-3000:]!r}")
        text = stream_text(stream)
        self.assertIsNotNone(text, f"no stream; output={output_of(result)[-3000:]!r}")
        assert text is not None
        events = events_of(text)
        ends = _test_ends(events)
        self.assertEqual(sorted(e.get("id") for e in ends), [
            "test_witness.WitnessTest.test_first_look_at_the_stream",
            "test_witness.WitnessTest.test_records_its_environment",
            "test_witness.WitnessTest.test_second_look_at_the_stream",
        ])
        self.assertEqual({e.get("status") for e in ends}, {"pass"})
        self.assertEqual(events[-1].get("event"), "run-end", f"last event: {events[-1]!r}")
        self.assertEqual({k: events[-1].get(k) for k in ("total", "passed", "failed", "pending")},
                         {"total": 3, "passed": 3, "failed": 0, "pending": 0})

    def test_dotted_targets_with_v_run_and_exit_0_on_an_all_pass_selection(self):
        project = copy_fixture("unittest-runner-dotted-")
        stream = project.parent / "crucible-events.ndjson"
        result = run_runner(project / "tests", ["test_witness.WitnessTest", "-v"],
                            runner_env(stream))
        self.assertEqual(result.returncode, 0, f"output={output_of(result)[-3000:]!r}")
        text = stream_text(stream)
        self.assertIsNotNone(text, f"no stream; output={output_of(result)[-3000:]!r}")
        assert text is not None
        ends = _test_ends(events_of(text))
        self.assertEqual(len(ends), 3, f"test-ends: {ends!r}")
        self.assertEqual({e.get("status") for e in ends}, {"pass"})


# The generated module's failure message holds a lone surrogate. It is
# written into the generated source as the Python escape (backslash, u,
# dc80), on purpose: the generated file stays ASCII, and the string the test
# raises holds the lone surrogate itself.
_SURROGATE_MODULE = (
    "import unittest\n\n\n"
    "class SurrogateTest(unittest.TestCase):\n\n"
    "    def test_fails_with_a_lone_surrogate(self):\n"
    "        self.fail('a lone surrogate \\udc80 here')\n"
)

# The message as the stream must carry it: the same Python escape, on purpose
# (a lone surrogate cannot be written as a real character).
_SURROGATE_MESSAGE = "a lone surrogate \udc80 here"


class TheStreamEncodesAnyTextTest(unittest.TestCase):

    def test_a_lone_surrogate_in_a_message_is_written_escaped_and_the_run_finishes(self):
        scratch = Path(new_scratch("unittest-runner-surrogate-"))
        (scratch / "tests").mkdir()
        (scratch / "tests" / "test_surrogate_message.py").write_text(_SURROGATE_MODULE,
                                                                    encoding="ascii")
        stream = scratch / "crucible-events.ndjson"
        result = run_runner(scratch, ["discover", "-s", "tests", "-p", "test_*.py", "-v"],
                            runner_env(stream))
        self.assertEqual(result.returncode, 1, f"output={output_of(result)[-3000:]!r}")
        raw = stream.read_bytes() if stream.is_file() else b""
        self.assertTrue(raw, f"no stream; output={output_of(result)[-3000:]!r}")
        self.assertTrue(raw.isascii(), "json.dumps' default ensure_ascii writes ASCII only")
        events = events_of(raw.decode("ascii"))
        ends = _test_ends(events)
        self.assertEqual(len(ends), 1, f"test-ends: {ends!r}")
        self.assertEqual(ends[0].get("status"), "fail")
        self.assertEqual(ends[0]["failure"].get("message"), _SURROGATE_MESSAGE)
        self.assertEqual(events[-1].get("event"), "run-end")
        self.assertEqual(events[-1].get("failed"), 1)


def _cap_file_size():
    """In the child, before exec: files it writes stop growing at the cap,
    and a write past it fails with an OSError instead of a signal."""
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    resource.setrlimit(resource.RLIMIT_FSIZE, (STREAM_SIZE_CAP, STREAM_SIZE_CAP))


class AFailedStreamWriteIsSaidOnceTest(unittest.TestCase):
    """An OSError on the stream is said once on stderr; the runner stops
    writing the stream and finishes the test run. The line saying it names
    the stream file's path or `CRUCIBLE_STREAM`."""

    @staticmethod
    def _saying_lines(stderr, stream):
        return [line for line in stderr.splitlines()
                if str(stream) in line or STREAM_VAR in line]

    def test_a_stream_path_that_is_a_directory_is_said_once_and_the_run_finishes(self):
        project = copy_fixture("unittest-runner-stream-dir-")
        stream = project.parent / "a-directory"
        stream.mkdir()
        result = run_runner(project, DISCOVER_WITNESSES, runner_env(stream))
        output = output_of(result)
        self.assertEqual(result.returncode, 0, f"output={output[-3000:]!r}")
        self.assertEqual(len(self._saying_lines(result.stderr, stream)), 1,
                         f"stderr={result.stderr[-3000:]!r}")
        self.assertEqual(len(re.findall(rf" \.\.\. {VERDICT}", output)), 3,
                         f"every witness still runs; output={output[-3000:]!r}")
        self.assertEqual(list(stream.iterdir()), [])

    def test_a_write_failing_mid_run_is_said_once_the_run_finishes_and_no_run_end_is_written(self):
        project = copy_fixture("unittest-runner-stream-cap-")
        stream = project.parent / "crucible-events.ndjson"
        result = run_runner(project, DISCOVER_ALL, runner_env(stream), preexec_fn=_cap_file_size)
        output = output_of(result)
        self.assertEqual(result.returncode, 1, f"output={output[-3000:]!r}")
        self.assertEqual(len(self._saying_lines(result.stderr, stream)), 1,
                         f"stderr={result.stderr[-3000:]!r}")
        last = console_description("test_witness.WitnessTest.test_second_look_at_the_stream")
        self.assertEqual(len(_verdict_lines(output, last)), 1,
                         f"the run goes on to its last case; output={output[-3000:]!r}")
        text = stream_text(stream)
        self.assertIsNotNone(text, "the stream file was opened before the cap was reached")
        assert text is not None
        self.assertEqual(json.loads(text.splitlines()[0]).get("event"), "run-start",
                         f"stream head: {text[:200]!r}")
        self.assertLessEqual(len(text.encode("utf-8")), STREAM_SIZE_CAP)
        self.assertNotIn("run-end", text, "a stream whose write failed has no run-end")


def xmlrunner_imports(source):
    """Every import of xmlrunner in `source`: an `import` / `from … import`
    of it or a submodule, or a dynamic import (`importlib.import_module`,
    `__import__`, `importlib.util.find_spec`, `runpy.run_module`) whose
    module name resolves -- from a literal, a module-level string constant,
    an f-string or a `+` of those -- to xmlrunner or a submodule. A name in
    a docstring, a comment or an unused string is not an import."""
    tree = ast.parse(source)
    constants = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = node.value.value

    def resolve(expr):
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value
        if isinstance(expr, ast.Name):
            return constants.get(expr.id)
        if isinstance(expr, ast.JoinedStr):
            parts = []
            for value in expr.values:
                part = (str(value.value) if isinstance(value, ast.Constant)
                        else resolve(value.value) if isinstance(value, ast.FormattedValue)
                        else None)
                if part is None:
                    return None
                parts.append(part)
            return "".join(parts)
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            left, right = resolve(expr.left), resolve(expr.right)
            return left + right if left is not None and right is not None else None
        return None

    def is_xmlrunner(dotted):
        return dotted.split(".")[0] == "xmlrunner"

    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [f"import {alias.name}" for alias in node.names if is_xmlrunner(alias.name)]
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and is_xmlrunner(node.module):
                found.append(f"from {node.module} import")
        elif isinstance(node, ast.Call) and node.args:
            func = node.func
            name = (func.attr if isinstance(func, ast.Attribute)
                    else func.id if isinstance(func, ast.Name) else None)
            if name in ("import_module", "__import__", "find_spec", "run_module"):
                target = resolve(node.args[0])
                if target is not None and is_xmlrunner(target):
                    found.append(f"{name}({target!r})")
    return found


_IMPORTING_SOURCES = {
    "import": "import xmlrunner\n",
    "import a submodule among others": "import os, xmlrunner.runner\n",
    "from import": "from xmlrunner.result import _XMLTestResult\n",
    "import_module literal": "import importlib\nimportlib.import_module('xmlrunner')\n",
    "import_module f-string of a constant": (
        "import importlib\n_X = 'xmlrunner'\nimportlib.import_module(f'{_X}.result')\n"),
    "__import__ concatenation": "__import__('xml' + 'runner')\n",
    "find_spec of a constant": (
        "import importlib.util\nNAME: str = 'xmlrunner'\nimportlib.util.find_spec(NAME)\n"),
    "run_module": "import runpy\nrunpy.run_module('xmlrunner', run_name='__main__')\n",
}

_CLEAN_SOURCES = {
    "plain unittest": "import unittest\nimport importlib\nimportlib.import_module('unittest')\n",
    "named in a docstring and a comment": (
        '"""xmlrunner left this runner (CR-CRU-224)."""\n# no xmlrunner here\nimport json\n'),
    "a different module sharing the prefix": "import xmlrunner_compat\n",
    "a relative import": "from .xmlrunner import thing\n",
    "an unresolvable dynamic name": "import importlib\nimportlib.import_module(name)\n",
}


class TheRunnerNeedsNoXmlrunnerTest(unittest.TestCase):

    def test_the_import_check_finds_every_xmlrunner_import_in_synthetic_sources(self):
        for label, source in _IMPORTING_SOURCES.items():
            with self.subTest(source=label):
                self.assertEqual(len(xmlrunner_imports(source)), 1, source)

    def test_the_import_check_finds_none_in_synthetic_sources_that_import_no_xmlrunner(self):
        for label, source in _CLEAN_SOURCES.items():
            with self.subTest(source=label):
                self.assertEqual(xmlrunner_imports(source), [], source)

    def test_the_runner_source_imports_no_xmlrunner(self):
        self.assertEqual(xmlrunner_imports(RUNNER.read_text(encoding="utf-8")), [])

    def test_the_runner_streams_the_fixture_under_an_interpreter_that_cannot_import_xmlrunner(self):
        # `-S` leaves out every site-packages dir, so the interpreter keeps
        # its stdlib (all the runner and the fixture use) and loses xmlrunner.
        probe = subprocess.run([PYTHON, "-S", "-c", "import xmlrunner"], capture_output=True,
                               text=True, timeout=60, check=False)
        self.assertNotEqual(probe.returncode, 0, "the interpreter under -S must not import xmlrunner")
        self.assertIn("No module named 'xmlrunner'", probe.stderr)
        project = copy_fixture("unittest-runner-no-xmlrunner-")
        stream = project.parent / "crucible-events.ndjson"
        result = run_runner(project, DISCOVER_ALL, runner_env(stream), flags=("-S",))
        output = output_of(result)
        self.assertEqual(result.returncode, 1, f"output={output[-3000:]!r}")
        text = stream_text(stream)
        self.assertIsNotNone(text, f"no stream; output={output[-3000:]!r}")
        assert text is not None
        events = events_of(text)
        want = expected()
        self.assertEqual(sorted(e.get("id") for e in _test_ends(events)),
                         sorted(c["id"] for c in want["cases"]))
        self.assertEqual(events[-1].get("event"), "run-end")
        self.assertEqual(events[-1].get("total"), want["caseCount"])


def _tree_files(root):
    return sorted(p.relative_to(root).as_posix() for p in Path(root).rglob("*")
                  if "__pycache__" not in p.parts)


class WithoutCrucibleStreamTheRunnerWritesNoStreamTest(unittest.TestCase):

    def test_a_run_without_crucible_stream_writes_no_file_and_still_runs_every_case(self):
        project = copy_fixture("unittest-runner-no-stream-")
        scratch = project.parent
        before = _tree_files(scratch)
        result = run_runner(project, DISCOVER_ALL, runner_env())
        output = output_of(result)
        self.assertEqual(result.returncode, 1, f"output={output[-3000:]!r}")
        self.assertEqual(_tree_files(scratch), before,
                         "with no CRUCIBLE_STREAM the runner writes no stream and no report")
        self.assertEqual(len(re.findall(rf" \.\.\. {VERDICT}", output)), expected()["caseCount"],
                         f"output={output[-4000:]!r}")


def _load_runner():
    """The runner module, loaded by path under a private name, for the
    in-process duration check."""
    spec = importlib.util.spec_from_file_location("subtest_runner_in_process", RUNNER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _junit_ms(milliseconds):
    """A duration in milliseconds rounded as the board's JUnit reading rounds
    one (`toDurationMs`, src/codecs/junit.ts: `Math.round`, a half rounded
    up)."""
    return math.floor(milliseconds + 0.5)


def _clocked_cases(clock):
    """Two cases whose bodies move `clock` (the stand-in `perf_counter`'s
    reading): one that takes 4.5 ms, and one whose single passing subtest
    ends 2.5 ms after its test started. Built in a function so discovery
    never collects them."""

    class Clocked(unittest.TestCase):

        def takes_four_and_a_half_ms(self):
            clock[0] = 0.0045

        def ends_a_subtest_after_two_and_a_half_ms(self):
            clock[0] = 0.0025
            with self.subTest(n=1):
                pass

    return Clocked("takes_four_and_a_half_ms"), Clocked("ends_a_subtest_after_two_and_a_half_ms")


class EveryDurationIsRoundedAsTheJunitReadingRoundsItTest(unittest.TestCase):
    """The runner's result, driven in process on a stand-in clock: a test's
    `addDuration` time, a subtest's time since its test started, and the
    run's time are each written as whole milliseconds, a half rounded up.
    Python's own `round` (a half to even) and truncation both write 4, 2 and
    12 here, where the JUnit reading stores 5, 3 and 13."""

    def test_each_duration_is_written_as_whole_milliseconds_rounded_half_up(self):
        runner = _load_runner()
        stream = Path(new_scratch("unittest-runner-durations-")) / "crucible-events.ndjson"
        clock = [0.0]
        plain, parent = _clocked_cases(clock)
        events = runner.EventStream(str(stream))
        result = runner.StreamingTestResult(io.StringIO(), True, 0)
        result.events = events
        result.total = 2
        with mock.patch.object(runner.time, "perf_counter", side_effect=lambda: clock[0]):
            result.startTestRun()
            plain.run(result)
            clock[0] = 0.0
            parent.run(result)
            clock[0] = 0.0125
            result.stopTestRun()
        events.close()
        written = events_of(stream_text(stream) or "")
        durations = [(e.get("event"), e.get("name"), e.get("duration_ms")) for e in written
                     if e.get("event") in ("test-end", "run-end")]
        self.assertEqual(durations, [
            ("test-end", "takes_four_and_a_half_ms", _junit_ms(4.5)),
            ("test-end", "ends_a_subtest_after_two_and_a_half_ms (n=1)", _junit_ms(2.5)),
            ("run-end", None, _junit_ms(12.5)),
        ], f"stream={written!r}")
        self.assertEqual([d[2] for d in durations], [5, 3, 13])
        self.assertEqual([type(d[2]) for d in durations], [int, int, int],
                         f"each duration_ms is an int, not a float: {durations!r}")


# A test that moves the working directory away (restoring it in a cleanup)
# and ends two subtests while it is away: one passes, one fails.
_MOVES_AWAY_MODULE = (
    "import os\n"
    "import shutil\n"
    "import tempfile\n"
    "import unittest\n\n\n"
    "class MovesAwayTest(unittest.TestCase):\n\n"
    "    def test_stays_where_the_run_started(self):\n"
    "        pass\n\n"
    "    def test_its_subtests_end_while_it_works_elsewhere(self):\n"
    "        elsewhere = tempfile.mkdtemp()\n"
    "        self.addCleanup(shutil.rmtree, elsewhere, True)\n"
    "        self.addCleanup(os.chdir, os.getcwd())\n"
    "        os.chdir(elsewhere)\n"
    "        with self.subTest(n=1):\n"
    "            pass\n"
    "        with self.subTest(n=2):\n"
    "            self.fail('a failing subtest, elsewhere')\n"
)


class ACaseFileIsRelativeToWhereTheRunStartedTest(unittest.TestCase):
    """A test that moves the working directory away still names its own
    module's file relative to the directory the runner was started in, for
    every case it ends, as xmlrunner's report named it. One file is one
    file: the board counts the distinct `file` values a stream states."""

    def test_subtests_ended_while_the_test_works_elsewhere_name_the_same_relative_file(self):
        scratch = Path(new_scratch("unittest-runner-moves-away-"))
        (scratch / "tests").mkdir()
        (scratch / "tests" / "test_moves_away.py").write_text(_MOVES_AWAY_MODULE,
                                                              encoding="ascii")
        stream = scratch / "crucible-events.ndjson"
        result = run_runner(scratch, ["discover", "-s", "tests", "-p", "test_*.py", "-v"],
                            runner_env(stream))
        self.assertEqual(result.returncode, 1, f"output={output_of(result)[-3000:]!r}")
        ends = _test_ends(events_of(stream_text(stream) or ""))
        files = {e.get("name"): e.get("file") for e in ends}
        self.assertEqual(files, {
            "test_stays_where_the_run_started": "tests/test_moves_away.py",
            "test_its_subtests_end_while_it_works_elsewhere (n=1)": "tests/test_moves_away.py",
            "test_its_subtests_end_while_it_works_elsewhere (n=2)": "tests/test_moves_away.py",
        }, f"test-ends: {ends!r}")
        self.assertEqual(len({e.get("file") for e in ends}), 1,
                         "one module is one distinct file in the stream")


class TheRunnerTakesUnittestsOwnCommandLineTest(unittest.TestCase):
    """`-o <reports>` is gone from the runner's command line. unittest's own
    command line (`unittest.main`'s argparse parsers, discover's and the
    dotted targets') knows no `-o`, so `python -m unittest` answers one with
    argparse's usage error, `unrecognized arguments: -o`, exit 2, before any
    test runs. The runner answers it the same way."""

    def _assert_refused_as_unittest_refuses_it(self, result, stream):
        output = output_of(result)
        self.assertEqual(result.returncode, 2,
                         f"argparse's usage error exits 2; output={output[-3000:]!r}")
        self.assertIn("error: unrecognized arguments: -o", result.stderr,
                      f"stderr={result.stderr[-3000:]!r}")
        self.assertEqual(re.findall(rf" \.\.\. {VERDICT}", output), [],
                         f"no test runs; output={output[-3000:]!r}")
        self.assertNotIn('"test-end"', stream_text(stream) or "",
                         "a refused command line streams no test")

    def test_discover_with_an_o_option_is_refused_as_unittest_refuses_it(self):
        project = copy_fixture("unittest-runner-o-discover-")
        stream = project.parent / "crucible-events.ndjson"
        reports = project.parent / "reports"
        result = run_runner(project, [*DISCOVER_WITNESSES, "-o", str(reports)],
                            runner_env(stream))
        self._assert_refused_as_unittest_refuses_it(result, stream)

    def test_dotted_targets_with_an_o_option_are_refused_as_unittest_refuses_them(self):
        project = copy_fixture("unittest-runner-o-dotted-")
        stream = project.parent / "crucible-events.ndjson"
        reports = project.parent / "reports"
        result = run_runner(project / "tests",
                            ["test_witness.WitnessTest", "-v", "-o", str(reports)],
                            runner_env(stream))
        self._assert_refused_as_unittest_refuses_it(result, stream)


if __name__ == "__main__":
    unittest.main()
