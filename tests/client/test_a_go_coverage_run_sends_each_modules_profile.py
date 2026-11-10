"""A go `--coverage` run sends each module's coverprofile with its close.

`test --coverage` and `regression --coverage` add `-coverprofile` to each
module's `go test` call, the profile written in the run's own reports dir.
`test` sends its module's profile text with the run's close under the codec
`go-coverprofile`; `regression` merges every invocation's profile into ONE
`go-coverprofile` text first, a block covered when any profile covered it and
the `mode:` line written once. The client adds no `-coverpkg`: a project that wants it
sets `GOFLAGS=-coverpkg=./...`, which the client's `go` calls inherit. A
`--coverage` run against a board whose health does not list
`go-coverprofile` is refused before a run opens; a profile that was not
written closes the run with no coverage and a warning.

The project is `tests/fixtures/go-client/coverage-modules`:

  - `calc` (`example.com/calc`): package `calc` (three functions, two of
    them partly or never covered) and package `calc/use` (one function
    calling `calc`), three tests between them;
  - `types` (`example.com/types`): types and constants only, one test, so
    its profile is a bare `mode:` line.

Driven with the real `go` through the recording shim (`go_client_harness`)
against a `RecordingBoard`. A board that decodes the codec is one whose
scripted health lists `go-coverprofile` under `codecs.coverage`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_coverage_run_sends_each_modules_profile
"""

import os
import unittest
from collections import Counter
from pathlib import Path

from tests.client.go_client_harness import (
    AGENT,
    RUNS,
    STREAM_CODEC,
    GoProject,
    diagnostics,
    envelope,
    flag_value,
    go_toolchain_gap,
    said,
    warning_texts,
)

COVERAGE_CODEC = "go-coverprofile"
FIXTURE = "coverage-modules"
#: The tests `go test -list` names in each fixture module.
CALC_LISTED = 3
TYPES_LISTED = 1
#: The profile of a module with no statement: its mode line and no block.
BARE_PROFILE = "mode: set"


def _decoding_board(p):
    """Script `p`'s board to answer a health that lists `go-coverprofile`."""
    health = p.board.default_health()
    health["codecs"]["coverage"] = [*health["codecs"]["coverage"], COVERAGE_CODEC]
    p.board.script_health(health)


def _profile_path(call):
    """The `-coverprofile` a `go test` call named, resolved against the dir it
    ran in; None when it named none."""
    value = flag_value(call["argv"], "-coverprofile")
    if value is None:
        return None
    return os.path.realpath(os.path.join(call["cwd"], value))


def _own_reports_dir(p, agent=AGENT):
    return os.path.realpath(os.path.join(p.dir, "test-reports", agent))


def _names_coverpkg(argv):
    return [a for a in argv if a.startswith("-coverpkg")]


def _block_keys(profile):
    """Each block line's `file:start,end` of a coverprofile, in order."""
    return [line.split(" ", 1)[0] for line in profile.splitlines()[1:] if line.strip()]


def _union_blocks(profiles):
    """`{file:start,end: (statements, covered)}` over every profile: each
    block once, covered when any profile's count for it is not zero."""
    union = {}
    for profile in profiles:
        for line in profile.splitlines()[1:]:
            if not line.strip():
                continue
            key, statements, count = line.rsplit(" ", 2)
            weight, hit = union.get(key, (int(statements), False))
            union[key] = (weight, hit or int(count) > 0)
    return union


def _coverage_warnings(result):
    return [w for w in warning_texts(envelope(result.stdout)) if "coverage" in w.lower()]


class _CoverageDrive(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def assert_profile_in_own_dir(self, p, call, where):
        path = _profile_path(call)
        if path is None:
            self.fail(f"`go test` carries -coverprofile; argv={call['argv']} {where}")
        own = _own_reports_dir(p)
        self.assertEqual(os.path.commonpath([own, path]), own,
                         f"the profile {path} is written in the run's own reports dir "
                         f"{own}; {where}")
        self.assertTrue(os.path.isfile(path), f"the profile {path} was written; {where}")
        return Path(path).read_text(encoding="utf-8")


class ATestCoverageRunSendsItsModulesProfileTest(_CoverageDrive):
    """`test --coverage` in the `calc` module."""

    def setUp(self):
        super().setUp()
        self.p = GoProject(self, fixture=FIXTURE)
        _decoding_board(self.p)
        self.p.board.script_run(passed=CALC_LISTED)
        self.result = self.p.drive("--coverage", "--module-dir", "calc")
        self.where = diagnostics(self.result)

    def test_the_go_test_call_writes_one_coverprofile_in_the_runs_own_reports_dir(self):
        runs = self.p.run_calls()
        self.assertEqual(len(runs), 1, f"one `go test -json` call; {self.where}")
        argv = runs[0]["argv"] if runs else []
        self.assertEqual(len([a for a in argv if a.startswith("-coverprofile")]), 1,
                         f"exactly one -coverprofile; argv={argv}")
        if runs:
            text = self.assert_profile_in_own_dir(self.p, runs[0], self.where)
            self.assertTrue(text.startswith("mode: "), f"a coverprofile; {text[:200]!r}")
            self.assertIn("example.com/calc/calc.go:", text, "calc's blocks are profiled")

    def test_the_close_carries_the_profile_under_go_coverprofile(self):
        closes = self.p.closes()
        self.assertEqual([c.get("codec") for c in closes], [STREAM_CODEC],
                         f"the run is closed once, from its stream; {self.where}")
        runs = self.p.run_calls()
        path = _profile_path(runs[0]) if runs else None
        self.assertIsNotNone(path, f"`go test` carried -coverprofile; {self.where}")
        text = Path(path).read_text(encoding="utf-8") if path and os.path.isfile(path) else None
        self.assertEqual((closes[0] if closes else {}).get("coverage"),
                         {"codec": COVERAGE_CODEC, "data": [text]},
                         f"the close carries the module's profile text; {self.where}")

    def test_the_client_adds_no_coverpkg(self):
        for call in self.p.test_calls():
            self.assertEqual(_names_coverpkg(call["argv"]), [],
                             f"no -coverpkg from the client; argv={call['argv']}")
        self.assertEqual(self.result.returncode, 0, self.where)


class ARegressionCoverageRunSendsEveryModulesProfileTest(_CoverageDrive):
    """`regression --coverage` over both modules, `types` statement-free."""

    def setUp(self):
        super().setUp()
        self.p = GoProject(self, fixture=FIXTURE)
        _decoding_board(self.p)
        self.p.board.script_run(passed=CALC_LISTED + TYPES_LISTED)
        self.result = self.p.drive("--coverage", verb="regression")
        self.where = diagnostics(self.result)

    def module_of(self, call):
        return os.path.relpath(os.path.realpath(call["cwd"]), os.path.realpath(self.p.dir))

    def test_each_modules_go_test_call_writes_its_own_coverprofile(self):
        runs = self.p.run_calls()
        self.assertEqual(sorted(self.module_of(c) for c in runs), ["calc", "types"],
                         f"one `go test -json` per module; {self.where}")
        for call in runs:
            flags = [a for a in call["argv"] if a.startswith("-coverprofile")]
            self.assertEqual(len(flags), 1, f"one -coverprofile; argv={call['argv']}")
            self.assert_profile_in_own_dir(self.p, call, self.where)
        paths = [_profile_path(c) for c in runs]
        self.assertEqual(len(set(paths)), len(runs),
                         f"each module writes its own profile; {paths}")

    def test_the_close_carries_one_profile_the_union_of_both_modules_profiles(self):
        runs = self.p.run_calls()
        texts = {}
        for call in runs:
            path = _profile_path(call)
            if path and os.path.isfile(path):
                texts[self.module_of(call)] = Path(path).read_text(encoding="utf-8")
        self.assertEqual(sorted(texts), ["calc", "types"],
                         f"both modules wrote a profile; {self.where}")
        self.assertEqual(texts.get("types", "").strip(), BARE_PROFILE,
                         "the types-only module's profile is a bare mode line")
        closes = self.p.closes()
        self.assertEqual(len(closes), 1, f"one close; {self.where}")
        coverage = (closes[0] if closes else {}).get("coverage") or {}
        self.assertEqual(coverage.get("codec"), COVERAGE_CODEC, f"{coverage!r} {self.where}")
        data = coverage.get("data") or []
        self.assertEqual(len(data), 1,
                         f"ONE go-coverprofile text, never one per module; data={data!r} "
                         f"{self.where}")
        text = data[0] if data else ""
        self.assertEqual([line for line in text.splitlines() if line.startswith("mode:")],
                         [BARE_PROFILE], f"the mode line is written once; text={text!r}")
        self.assertTrue(text.startswith(BARE_PROFILE), f"text={text!r}")
        self.assertEqual(_union_blocks([text]), _union_blocks(texts.values()),
                         f"the one text is the union of both modules' profiles, the "
                         f"statement-free one adding no block; text={text!r} {self.where}")
        self.assertEqual(self.result.returncode, 0, self.where)


class ARunWithoutCoverageSendsNoProfileTest(_CoverageDrive):
    """A plain `test` and `regression`: no -coverprofile, no coverage."""

    def test_a_plain_test_run_passes_no_coverprofile_and_closes_with_no_coverage(self):
        p = GoProject(self, fixture=FIXTURE)
        p.board.script_run(passed=CALC_LISTED)
        result = p.drive("--module-dir", "calc")
        where = diagnostics(result)
        runs = p.run_calls()
        self.assertEqual(len(runs), 1, where)
        for call in p.test_calls():
            self.assertIsNone(flag_value(call["argv"], "-coverprofile"),
                              f"no -coverprofile without --coverage; argv={call['argv']}")
        closes = p.closes()
        self.assertEqual(len(closes), 1, where)
        self.assertNotIn("coverage", closes[0] if closes else {"coverage": None},
                         f"no coverage on the close; {where}")

    def test_a_plain_regression_passes_no_coverprofile_and_closes_with_no_coverage(self):
        p = GoProject(self, fixture=FIXTURE)
        p.board.script_run(passed=CALC_LISTED + TYPES_LISTED)
        result = p.drive(verb="regression")
        where = diagnostics(result)
        self.assertEqual(len(p.run_calls()), 2, where)
        for call in p.test_calls():
            self.assertIsNone(flag_value(call["argv"], "-coverprofile"),
                              f"no -coverprofile without --coverage; argv={call['argv']}")
        closes = p.closes()
        self.assertEqual(len(closes), 1, where)
        self.assertNotIn("coverage", closes[0] if closes else {"coverage": None},
                         f"no coverage on the close; {where}")


class GoflagsCarriesCoverpkgTest(_CoverageDrive):
    """`GOFLAGS=-coverpkg=./...` set by the project reaches `go test`."""

    def setUp(self):
        super().setUp()
        self.p = GoProject(self, fixture=FIXTURE)
        _decoding_board(self.p)
        self.p.board.script_run(passed=CALC_LISTED)
        self.result = self.p.drive("--coverage", "--module-dir", "calc",
                                   GOFLAGS="-coverpkg=./...")
        self.where = diagnostics(self.result)

    def test_the_go_test_call_inherits_coverpkg_so_its_profile_repeats_blocks(self):
        runs = self.p.run_calls()
        self.assertEqual(len(runs), 1, self.where)
        for call in self.p.test_calls():
            self.assertEqual(_names_coverpkg(call["argv"]), [],
                             f"the client itself adds no -coverpkg; argv={call['argv']}")
        if runs:
            text = self.assert_profile_in_own_dir(self.p, runs[0], self.where)
            repeated = [k for k, n in Counter(_block_keys(text)).items() if n > 1]
            self.assertTrue(repeated,
                            f"-coverpkg from GOFLAGS lists a block once per test package, "
                            f"so the profile repeats blocks; profile={text[:600]!r}")
            closes = self.p.closes()
            self.assertEqual([(c.get("coverage") or {}).get("data") for c in closes], [[text]],
                             f"the repeated-block profile is sent as written; {self.where}")

    def test_the_go_test_list_still_counts_the_runs_total(self):
        self.assertEqual([s.get("total") for s in self.p.starts()], [CALC_LISTED],
                         f"the run-start total is calc's listed tests under GOFLAGS; "
                         f"{self.where}")
        self.assertEqual(self.result.returncode, 0, self.where)


class ABoardThatDoesNotDecodeGoCoverprofileTest(_CoverageDrive):
    """The recording board's default health lists `jacoco` and `lcov` only."""

    def assert_refused_before_a_run_opens(self, p, result):
        where = diagnostics(result)
        self.assertEqual(p.starts(), [], f"no run opened; {where}")
        self.assertEqual([path for path, _b in p.posts() if path == RUNS], [],
                         f"nothing closed; {where}")
        self.assertEqual(p.run_calls(), [], f"no `go test -json` ran; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"the refusal is one envelope; {where}")
        self.assertIs((axi or {}).get("ok"), False, where)
        self.assertIn(COVERAGE_CODEC, said(axi), f"the refusal names the codec; {where}")
        self.assertNotEqual(result.returncode, 0, where)

    def test_a_test_coverage_run_is_refused_naming_go_coverprofile(self):
        p = GoProject(self, fixture=FIXTURE)
        result = p.drive("--coverage", "--module-dir", "calc")
        self.assert_refused_before_a_run_opens(p, result)

    def test_a_regression_coverage_run_is_refused_naming_go_coverprofile(self):
        p = GoProject(self, fixture=FIXTURE)
        result = p.drive("--coverage", verb="regression")
        self.assert_refused_before_a_run_opens(p, result)

    def test_a_run_without_coverage_on_that_board_is_not_refused(self):
        p = GoProject(self, fixture=FIXTURE)
        p.board.script_run(passed=CALC_LISTED)
        result = p.drive("--module-dir", "calc")
        where = diagnostics(result)
        self.assertEqual(len(p.starts()), 1, f"the run opened; {where}")
        self.assertEqual(len(p.closes()), 1, f"the run closed; {where}")
        self.assertNotIn(COVERAGE_CODEC, said(envelope(result.stdout)), where)
        self.assertEqual(result.returncode, 0, where)


class AProfileThatWasNotWrittenTest(_CoverageDrive):
    """A module (`badmod`, beside the fixture's two) whose go.mod does not
    parse: go stops before any package builds, so `-coverprofile` names a
    file go never writes."""

    def setUp(self):
        super().setUp()
        self.p = GoProject(self, fixture=FIXTURE)
        root = Path(self.p.dir) / "badmod"
        root.mkdir()
        (root / "go.mod").write_text("module example.com/badmod\n\ngo 1.24\n\nbogus directive\n",
                                     encoding="utf-8")
        (root / "p").mkdir()
        (root / "p" / "p_test.go").write_text(
            'package p\n\nimport "testing"\n\nfunc TestP(t *testing.T) {}\n', encoding="utf-8")
        _decoding_board(self.p)
        self.result = self.p.drive("--coverage", "--module-dir", "badmod")
        self.where = diagnostics(self.result)

    def test_the_run_closes_with_no_coverage(self):
        runs = self.p.run_calls()
        self.assertEqual(len(runs), 1, f"`go test -json` ran once; {self.where}")
        path = _profile_path(runs[0]) if runs else None
        self.assertIsNotNone(path, f"-coverprofile was asked for; {self.where}")
        self.assertFalse(path and os.path.exists(path),
                         f"go wrote no profile at {path}; {self.where}")
        closes = self.p.closes()
        self.assertEqual(len(closes), 1, f"the run is still closed; {self.where}")
        self.assertNotIn("coverage", closes[0] if closes else {"coverage": None},
                         f"the close carries no coverage; {self.where}")

    def test_the_envelope_warns_that_no_coverage_was_sent(self):
        self.assertEqual(len(self.p.closes()), 1, f"the run is closed; {self.where}")
        self.assertEqual(len(_coverage_warnings(self.result)), 1,
                         f"exactly one warning says the run carries no coverage; "
                         f"{self.where}")


if __name__ == "__main__":
    unittest.main()
