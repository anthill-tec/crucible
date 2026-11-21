"""A bun `test` run hands `bun test` its `--tests` entries as paths.

`bun test` reads a bare argument as a FILTER on file names (a substring
match) and a `./`-prefixed one as a PATH. On a plain `bun test` run (no
`crucible.targets` entry marked `"test": true`) the client therefore hands a
relative entry that does not start with `./` or `../` to bun as `./<entry>`,
and an entry starting with `./` or `../`, or an absolute one, exactly as
given. bun then never widens an entry to the other files whose path contains
it: a `test --tests` entry naming one scratch file, beside a sibling file in a
subdirectory whose path contains its name, runs the named file alone.

── Tier ──────────────────────────────────────────────────────────────────────

INTEGRATION. Every test spawns the real `bun-crucible.py` from the test
install as an OS subprocess on a scratch package it owns, with no `--agent`
(nothing is filed). The argv is read from a recording fake `bun` (the one
`test_bun_test_name_filter` records with); the files a run selects are read
from the JUnit report the REAL `bun` on PATH writes.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import declare_and_require_board
from tests.client.integration.test_bun_test_name_filter import (
    _FAKE_BUN_BODY,
    _client_env,
)
from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    load_client,
    new_scratch,
)

BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120

_TEST_SOURCE = '''import {{ expect, test }} from "bun:test";

test("{name}", () => {{
  expect(1).toBe(1);
}});
'''


def _write_test(path, name):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_TEST_SOURCE.format(name=name), encoding="utf-8")


def _write_package(directory, name):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "package.json").write_text(json.dumps({"name": name}), encoding="utf-8")


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-2000:]!r} "
            f"stderr={result.stderr[-2500:]!r}")


class EntriesReachBunAsPathsTest(unittest.TestCase):
    """The `bun test` argv, read from a recording fake `bun`: a bare relative
    entry as `./<entry>`; `./x`, `../x` and an absolute entry as given."""

    def setUp(self):
        self.project = Path(new_scratch("tests-as-paths-argv-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        declare_and_require_board(self.project, self.board.url,
                                  label="the bun client")
        (self.project / ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=tests-as-paths-fixture-key\n", encoding="utf-8")
        # The package is a sub-directory, so `../x` names a file outside it.
        self.package = self.project / "pkg"
        _write_package(self.package, "tests-as-paths-fixture")
        _write_test(self.package / "bare.test.ts", "bare")
        _write_test(self.package / "dotted.test.ts", "dotted")
        _write_test(self.project / "up.test.ts", "up")
        _write_test(self.package / "absolute.test.ts", "absolute")
        self.absolute = str(self.package / "absolute.test.ts")
        self.bun_log = self.project / "bun-calls.jsonl"
        self.fake_bun = self.project / "fake_bun.py"
        self.fake_bun.write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY,
                                 encoding="utf-8")
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        self.timeout_ms = str(load_client("bun-crucible.py").DEFAULT_TEST_TIMEOUT_MS)

    def drive(self, *tests):
        cmd = [sys.executable, str(BUN_CLIENT), "test",
               "--project-dir", str(self.project), "--package-dir", str(self.package),
               "--bun", str(self.fake_bun), "--reports", "reports", "--tests", *tests]
        return subprocess.run(cmd, cwd=str(self.project),
                              env=_client_env(FAKE_BUN_LOG=str(self.bun_log)),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def entries_bun_received(self, result):
        """The entries of the one `bun test` call: the arguments between the
        timeout and the report flags."""
        calls = []
        if self.bun_log.exists():
            calls = [json.loads(line)
                     for line in self.bun_log.read_text(encoding="utf-8").splitlines()
                     if line.strip()]
        self.assertEqual(len(calls), 1,
                         f"`test` spawns bun exactly once; calls={calls!r} "
                         f"{_diagnostics(result)}")
        argv = calls[0] if calls else []
        self.assertEqual(argv[:3], ["test", "--timeout", self.timeout_ms],
                         f"argv={argv!r}")
        self.assertEqual(argv[-2], "--reporter=junit", f"argv={argv!r}")
        self.assertRegex(argv[-1], r"^--reporter-outfile=.+junit\.xml$", f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        return argv[3:-2]

    def test_a_bare_relative_entry_reaches_bun_as_a_dot_slash_path(self):
        result = self.drive("bare.test.ts")
        self.assertEqual(self.entries_bun_received(result), ["./bare.test.ts"],
                         _diagnostics(result))
        self.assertIn("./bare.test.ts", result.stderr,
                      f"the printed `running:` line shows the `./` form; "
                      f"{_diagnostics(result)}")

    def test_dot_slash_dot_dot_and_absolute_entries_reach_bun_exactly_as_given(self):
        given = ["./dotted.test.ts", "../up.test.ts", self.absolute]
        result = self.drive(*given)
        self.assertEqual(self.entries_bun_received(result), given,
                         f"an entry already in path form is never prefixed again; "
                         f"{_diagnostics(result)}")

    def test_every_entry_form_reaches_bun_in_its_path_form_and_in_order(self):
        result = self.drive("bare.test.ts", "./dotted.test.ts", "../up.test.ts",
                            self.absolute)
        self.assertEqual(
            self.entries_bun_received(result),
            ["./bare.test.ts", "./dotted.test.ts", "../up.test.ts", self.absolute],
            _diagnostics(result))


class EntriesRunExactlyTheirFilesTest(unittest.TestCase):
    """With the REAL `bun`: a `test --tests` entry naming one scratch file,
    beside a sibling file in a subdirectory whose path contains its name, runs
    the named file alone, read from the JUnit report bun wrote."""

    def setUp(self):
        self.real_bun = shutil.which("bun")
        self.assertIsNotNone(
            self.real_bun,
            "this proof needs the real `bun` on PATH: which files ran is what "
            "bun's own JUnit report says")
        self.package = Path(new_scratch("tests-as-paths-real-"))
        self.addCleanup(shutil.rmtree, self.package, True)
        _write_package(self.package, "tests-as-paths-real-fixture")
        _write_test(self.package / "a.test.ts", "a runs")
        _write_test(self.package / "sub" / "xa.test.ts", "xa runs")

    def test_an_entry_runs_its_own_file_and_never_a_file_whose_path_contains_it(self):
        cmd = [sys.executable, str(BUN_CLIENT), "test",
               "--project-dir", str(self.package), "--package-dir", str(self.package),
               "--bun", self.real_bun, "--reports", "reports", "--tests", "a.test.ts"]
        result = subprocess.run(cmd, cwd=str(self.package), env=_client_env(),
                                capture_output=True, text=True, timeout=TIMEOUT,
                                check=False)
        junit = self.package / "reports" / "junit.xml"
        self.assertTrue(junit.is_file(), f"bun wrote its report; {_diagnostics(result)}")
        root = ET.parse(junit).getroot()  # noqa: S314 - own scratch report
        files = sorted(suite.get("file") or suite.get("name") or ""
                       for suite in root.iter("testsuite"))
        self.assertEqual(files, ["a.test.ts"],
                         f"the run covers `a.test.ts` alone, never `sub/xa.test.ts`; "
                         f"{_diagnostics(result)}")
        cases = [case.get("name") for case in root.iter("testcase")]
        self.assertEqual(cases, ["a runs"], _diagnostics(result))
        self.assertEqual(result.returncode, 0, _diagnostics(result))


if __name__ == "__main__":
    unittest.main()
