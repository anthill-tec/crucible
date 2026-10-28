"""A test's own console line never takes a load error away from its file.

The bun client reads its captured console for each `<path>:` file header
followed by one or more `# Unhandled error between tests` blocks, and adds one
failing case per such file — in the suite for THAT file (a new suite named by
the path when the report has none), case `?`. bun's console is the runner's
output and the tests' own output on one stream: a test that writes a
flush-left `results:` line with `console.log` puts that line between its
file's header and the file's error block. That line is the test's output, not
a file header — the case still lands in the file's own suite, and no suite is
made up from the console line.

The console texts here are bun 1.4.2's own output, captured from a scratch
run of two files — one whose test logs `results:` then passes and whose
`afterAll` rejects, one that logs `results:` at import and then throws — in
both wire forms (plain under `NO_COLOR=1`, ANSI under `FORCE_COLOR=1`), with
the scratch directory replaced by `/work/pkg/`. They are read by the client's
own `_parse_load_errors` and `_add_load_error_cases` (clients/bun-crucible.py),
loaded by path; no runner and no board are involved.

Invocation:
    python3 -m unittest tests.client.test_bun_load_error_reading_skips_a_tests_own_console_lines -v
"""

import copy
import unittest

from tests.client.live_run_harness import load_client

LOGS_THEN_REJECTS = "b_logs.test.ts"
LOGS_THEN_THROWS = "c_logs_at_import.test.ts"
CONSOLE_LINE = "results"

PLAIN_CONSOLE = (
    "bun test v1.4.2 (744846f84)\n"
    "\n"
    "b_logs.test.ts:\n"
    "results:\n"
    "(pass) logs then passes [0.03ms]\n"
    "\n"
    "# Unhandled error between tests\n"
    "-------------------------------\n"
    '1 | import { test, expect, afterAll } from "bun:test";\n'
    '2 | test("logs then passes", () => { console.log("results:"); expect(1).toBe(1); });\n'
    '3 | afterAll(() => { Promise.reject(new Error("rejected after the log")); });\n'
    "                                        ^\n"
    "error: rejected after the log\n"
    "      at <anonymous> (/work/pkg/b_logs.test.ts:3:37)\n"
    "-------------------------------\n"
    "\n"
    "\n"
    "c_logs_at_import.test.ts:\n"
    "results:\n"
    "\n"
    "# Unhandled error between tests\n"
    "-------------------------------\n"
    '1 | import { test } from "bun:test";\n'
    '2 | console.log("results:");\n'
    '3 | throw new Error("boom after a console line");\n'
    "              ^\n"
    "error: boom after a console line\n"
    "      at /work/pkg/c_logs_at_import.test.ts:3:11\n"
    "-------------------------------\n"
    "\n"
    "\n"
    " 1 pass\n"
    " 1 fail\n"
    " 2 errors\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 2 files. [2.00ms]\n"
)

ANSI_CONSOLE = (
    '\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.4.2 (744846f84)\x1b[0m\n'
    '\x1b[0m\n'
    'b_logs.test.ts:\n'
    'results:\n'
    '\x1b[0m\x1b[32m\u2713\x1b[0m\x1b[0m\x1b[1m logs then passes\x1b[0m \x1b[0m\x1b[2m[0.04ms\x1b[0m\x1b[2m]\x1b[0m\n'
    '\x1b[0m\n'
    '\x1b[1m\x1b[2m#\x1b[0m \x1b[31m\x1b[1mUnhandled error\x1b[0m\x1b[2m between tests\x1b[0m\n'
    '\x1b[2m-------------------------------\x1b[0m\n'
    '\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { test, expect, afterAll } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m"bun:test"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n'
    '\x1b[0m\x1b[1m2 |\x1b[0m test(\x1b[0m\x1b[32m"logs then passes"\x1b[0m, () => { console\x1b[0m\x1b[3m\x1b[1m.log\x1b[0m(\x1b[0m\x1b[32m"results:"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n'
    '\x1b[0m\x1b[1m3 |\x1b[0m afterAll(() => { Promise\x1b[0m\x1b[3m\x1b[1m.reject\x1b[0m(\x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m"rejected after the log"\x1b[0m))\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n'
    '                                        \x1b[31m\x1b[1m^\x1b[0m\n'
    '\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mrejected after the log\x1b[0m\n'
    '\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/work/pkg/\x1b[0m\x1b[36mb_logs.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m3\x1b[0m\x1b[2m:\x1b[33m37\x1b[0m\x1b[2m)\x1b[0m\n'
    '\x1b[0m\x1b[2m-------------------------------\x1b[0m\n'
    '\n'
    '\x1b[0m\n'
    'c_logs_at_import.test.ts:\n'
    'results:\n'
    '\x1b[0m\n'
    '\x1b[1m\x1b[2m#\x1b[0m \x1b[31m\x1b[1mUnhandled error\x1b[0m\x1b[2m between tests\x1b[0m\n'
    '\x1b[2m-------------------------------\x1b[0m\n'
    '\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m"bun:test"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n'
    '\x1b[0m\x1b[1m2 |\x1b[0m console\x1b[0m\x1b[3m\x1b[1m.log\x1b[0m(\x1b[0m\x1b[32m"results:"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n'
    '\x1b[0m\x1b[1m3 |\x1b[0m \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m"boom after a console line"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n'
    '              \x1b[31m\x1b[1m^\x1b[0m\n'
    '\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mboom after a console line\x1b[0m\n'
    '\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[36m\x1b[2m/work/pkg/\x1b[0m\x1b[36mc_logs_at_import.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m3\x1b[0m\x1b[2m:\x1b[33m11\x1b[0m\n'
    '\x1b[0m\x1b[2m-------------------------------\x1b[0m\n'
    '\n'
    '\n'
    '\x1b[0m\x1b[32m 1 pass\x1b[0m\n'
    '\x1b[0m\x1b[31m 1 fail\x1b[0m\n'
    ' \x1b[0m\x1b[31m2 errors\x1b[0m\n'
    ' 1 expect() calls\n'
    'Ran 2 tests across 2 files. \x1b[0m\x1b[2m[\x1b[1m2.00ms\x1b[0m\x1b[2m]\x1b[0m\n'
)

# The same shape in a nested package path, with a different console word: a
# test under `tests/unit/` that prints `done:` before its file's error block.
NESTED_PLAIN_CONSOLE = (
    "bun test v1.4.2 (744846f84)\n"
    "\n"
    "tests/unit/d_nested.test.ts:\n"
    "done:\n"
    "(pass) prints done [0.02ms]\n"
    "\n"
    "# Unhandled error between tests\n"
    "-------------------------------\n"
    "error: rejected in a nested file\n"
    "      at <anonymous> (/work/pkg/tests/unit/d_nested.test.ts:3:37)\n"
    "-------------------------------\n"
    "\n"
    " 1 pass\n"
    " 0 fail\n"
    " 1 error\n"
    "Ran 1 test across 1 file. [2.00ms]\n"
)

_CLIENT = load_client("bun-crucible.py")


def _report_tree():
    """The tree bun's JUnit report gives the client for the captured run: the
    passing case of the file whose test ran, and no suite for the file that
    threw at import."""
    return [{"name": LOGS_THEN_REJECTS, "status": "pass", "children": [
        {"name": "logs then passes", "status": "pass", "duration_ms": 0}]}]


def _block_text(blocks):
    return "\n".join("\n".join(block) for block in blocks)


class _Forms:
    """A holder, so the loader never collects the base class itself."""

    class ConsoleLineCase(unittest.TestCase):
        """One wire form; the subclasses read each captured console."""

        CONSOLE = ""

        def test_each_error_block_is_read_under_its_own_file_not_the_console_line(self):
            errors = _CLIENT._parse_load_errors(self.CONSOLE)
            self.assertEqual(
                list(errors), [LOGS_THEN_REJECTS, LOGS_THEN_THROWS],
                f"each block is read under the file whose header it follows — "
                f"a test's own `{CONSOLE_LINE}:` line is not a file header; "
                f"read files={list(errors)!r}")
            self.assertNotIn(CONSOLE_LINE, errors,
                             "no file is made up from a test's console line")
            self.assertEqual(len(errors[LOGS_THEN_REJECTS]), 1,
                             f"blocks={errors[LOGS_THEN_REJECTS]!r}")
            self.assertEqual(len(errors[LOGS_THEN_THROWS]), 1,
                             f"blocks={errors[LOGS_THEN_THROWS]!r}")
            self.assertIn("error: rejected after the log",
                          _block_text(errors[LOGS_THEN_REJECTS]))
            self.assertNotIn("boom after a console line",
                             _block_text(errors[LOGS_THEN_REJECTS]),
                             "a file's blocks hold only its own error")
            self.assertIn("error: boom after a console line",
                          _block_text(errors[LOGS_THEN_THROWS]))
            self.assertNotIn("rejected after the log",
                             _block_text(errors[LOGS_THEN_THROWS]),
                             "a file's blocks hold only its own error")

        def test_each_case_lands_in_its_own_files_suite_and_no_suite_is_made_up(self):
            tree = _report_tree()
            summary = {"total": 1, "passed": 1, "failed": 0, "pending": 0}
            added = _CLIENT._add_load_error_cases(tree, summary, self.CONSOLE)

            self.assertEqual(
                [s.get("name") for s in tree], [LOGS_THEN_REJECTS, LOGS_THEN_THROWS],
                f"the suites are the two files' own — none named after a "
                f"test's `{CONSOLE_LINE}:` line; tree={tree!r}")
            self.assertEqual([s for s in tree if s.get("name") == CONSOLE_LINE], [],
                             f"no suite is made up from a console line; tree={tree!r}")

            ran = tree[0]
            self.assertEqual(
                [(c.get("name"), c.get("status")) for c in ran.get("children") or []],
                [("logs then passes", "pass"), ("?", "fail")],
                f"the case joins the suite the report already holds; suite={ran!r}")
            self.assertEqual(ran.get("status"), "fail", f"suite={ran!r}")
            self.assertEqual(ran["children"][1]["failure"]["message"],
                             "rejected after the log")

            threw = tree[1]
            self.assertEqual(
                [(c.get("name"), c.get("status")) for c in threw.get("children") or []],
                [("?", "fail")], f"suite={threw!r}")
            self.assertEqual(threw["children"][0]["failure"]["message"],
                             "boom after a console line")
            self.assertNotIn("rejected after the log",
                             threw["children"][0]["failure"].get("trace") or "",
                             "a file's trace holds only its own block")

            self.assertEqual(added, 1,
                             "exactly one file had no suite before — the one "
                             "that threw at import")
            self.assertEqual(summary, {"total": 3, "passed": 1, "failed": 2,
                                       "pending": 0},
                             "one failing case per file, counted once each")


class ConsoleLineInThePlainConsoleTest(_Forms.ConsoleLineCase):
    """bun's plain wire form: `NO_COLOR=1`."""

    CONSOLE = PLAIN_CONSOLE


class ConsoleLineInTheAnsiConsoleTest(_Forms.ConsoleLineCase):
    """bun's ANSI wire form: `FORCE_COLOR=1`."""

    CONSOLE = ANSI_CONSOLE


class ConsoleLineInANestedFileTest(unittest.TestCase):
    """A file under a sub-directory, whose test prints `done:`."""

    def test_a_nested_files_case_lands_in_its_suite_not_under_the_console_word(self):
        path = "tests/unit/d_nested.test.ts"
        tree = [{"name": path, "status": "pass", "children": [
            {"name": "prints done", "status": "pass", "duration_ms": 0}]}]
        pristine = copy.deepcopy(tree)
        summary = {"total": 1, "passed": 1, "failed": 0, "pending": 0}
        added = _CLIENT._add_load_error_cases(tree, summary, NESTED_PLAIN_CONSOLE)
        self.assertEqual([s.get("name") for s in tree], [path],
                         f"no `done` suite is made up; tree={tree!r}")
        self.assertEqual(
            [(c.get("name"), c.get("status")) for c in tree[0].get("children") or []],
            [(c["name"], c["status"]) for c in pristine[0]["children"]] + [("?", "fail")],
            f"suite={tree[0]!r}")
        self.assertEqual(tree[0]["children"][1]["failure"]["message"],
                         "rejected in a nested file")
        self.assertEqual(added, 0, "the file's suite already existed")
        self.assertEqual(summary, {"total": 2, "passed": 1, "failed": 1, "pending": 0})


if __name__ == "__main__":
    unittest.main()
