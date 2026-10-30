"""Every client's help says a `regression` run measures coverage only when
`--coverage` asks for it.

Each of the five clients' `regression` runs the whole suite coverage-free
unless `--coverage` is given. The help has to say so, in four places:

  * the `regression` line of the ROOT `--help` listing — the one-line summary
    an operator reads before choosing a verb — says coverage is opt-in (it
    names `--coverage`, or calls the run coverage-free / coverage opt-in), and
    no longer describes the run as a coverage run outright (maven's
    "`mvn clean verify` with JaCoCo coverage", rust's "workspace coverage
    regression (`cargo llvm-cov nextest --workspace`)");
  * maven's root DESCRIPTION no longer lists "full regression with JaCoCo" as
    an unconditional tier;
  * the help of each coverage-only flag on `regression` — maven's
    `--coverage-profile` (and wherever the root or `regression` help names
    `CRUCIBLE_COVERAGE_PROFILE`), python's `--cov-source`, rust's
    `--lcov-output`, `--ignore-run-fail` and `--keep-target` — says the flag
    applies only with `--coverage`;
  * bun's and python's `pre-merge-gate` help no longer claims to be "the only
    coverage path" — `regression --coverage` is one too.

GREEN-GUARDS (already true, pinned so they stay true): every client's
`regression --help` lists `--coverage` with the one shared sentence (the run
is coverage-free without it); rust's three coverage-only flags already say
they apply only with `--coverage`; bun's, python's and arduino's root
`regression` lines already name `--coverage`.

How the help is read. The root listing line, the description and each flag's
help are read off the client's REAL argparse parser, captured at its
`parse_args` call by the `_root_parser` spy seam that
`tests/client/test_client_tier_verb_contract.py` uses — a root listing line is
the `help=` of the verb's pseudo-action in the sub-parsers action, so no
assertion depends on how argparse wraps a line. The printed root `--help` is
also read from each client run as a subprocess in a scratch `/tmp` cwd
(`--help` needs no board and resolves no project), and checked for the stale
claims with whitespace and backticks normalised.

Assertions test MEANING words, never exact prose: a correct rewording passes.

Invocation:
    python3 -m unittest tests.client.test_every_clients_help_says_regression_coverage_is_opt_in -v
"""

import argparse
import contextlib
import importlib.util
import io
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
CLIENTS = ("bun", "python", "mvn", "rust", "arduino")

# `--coverage` as a WHOLE flag — `--coverage-profile` must not count as a
# mention of the switch.
_COVERAGE_SWITCH = r"--coverage(?![\w-])"

# A text says coverage is opt-in when it names the switch, or calls the run
# coverage-free / coverage opt-in in words.
_OPT_IN = re.compile(
    _COVERAGE_SWITCH
    + r"|coverage-free|coverage free|opt-in|opt in|without coverage")

# A flag's help says it applies only with the switch: "only with --coverage",
# "applies only when --coverage is given", "requires --coverage", "needs
# --coverage", "refused/ignored without --coverage".
_ONLY_WITH_COVERAGE = re.compile(
    r"\bonly\b[^.;]{0,40}?" + _COVERAGE_SWITCH
    + r"|\brequires?\s+" + _COVERAGE_SWITCH
    + r"|\bneeds?\s+" + _COVERAGE_SWITCH
    + r"|\b(?:refused|ignored|rejected)\s+without\s+" + _COVERAGE_SWITCH
    + r"|\bwithout\s+" + _COVERAGE_SWITCH + r"[^.;]{0,30}?\b(?:refused|ignored|rejected)\b")

# Exclusivity claims that `regression --coverage` made untrue.
_EXCLUSIVE_COVERAGE_CLAIMS = ("only coverage path", "coverage is reserved for this gate")


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PARSERS = {}


def _root_parser(client):
    """The client's ROOT argparse parser, captured at the moment it parses.

    Mirrors `_root_parser` in `test_client_tier_verb_contract`: `main()` builds
    the parser inline, so `parse_args` is spied on, the bound `self` kept, and
    `SystemExit` raised before any verb is dispatched."""
    if client in _PARSERS:
        return _PARSERS[client]
    module = _load_module(CLIENTS_DIR / f"{client}-crucible.py",
                          f"{client}_crucible_under_test_coverage_opt_in_help")
    captured = {}

    def spy(self, args=None, namespace=None):
        captured.setdefault("root", self)
        raise SystemExit(0)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", spy), \
            mock.patch.object(sys, "argv", [f"{client}-crucible.py", "status"]), \
            contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()), \
            contextlib.suppress(SystemExit):
        module.main()
    root = captured.get("root")
    assert root is not None, f"{client}-crucible.py never parsed its arguments"
    _PARSERS[client] = root
    return root


def _subparsers_action(client):
    for action in _root_parser(client)._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action
    raise AssertionError(f"{client}-crucible.py's root parser carries no verbs")


def _root_line(client, verb):
    """The verb's one-line summary in the ROOT `--help` listing — the `help=`
    given to `add_parser`, held on the sub-parsers action's pseudo-action."""
    for pseudo in _subparsers_action(client)._choices_actions:
        if pseudo.dest == verb:
            return pseudo.help or ""
    raise AssertionError(f"{client}-crucible.py lists no {verb!r} in its root help")


def _verb_parser(client, verb):
    parser = _subparsers_action(client).choices.get(verb)
    assert parser is not None, f"{client}-crucible.py carries no {verb!r} verb"
    return parser


def _flag_help(client, verb, flag):
    for action in _verb_parser(client, verb)._actions:
        if flag in action.option_strings:
            return action.help or ""
    raise AssertionError(f"{client}-crucible.py {verb!r} carries no {flag} option")


def _verb_help_texts(client, verb):
    """Every help text a `<verb> --help` prints: the verb's description and
    epilog, and each option's help."""
    parser = _verb_parser(client, verb)
    texts = [parser.description or "", parser.epilog or ""]
    texts.extend(action.help or "" for action in parser._actions)
    return [text for text in texts if text]


def _plain(text):
    """Lower-cased, backticks dropped, whitespace runs collapsed — a phrase is
    found whether or not it was typeset or wrapped."""
    return " ".join((text or "").replace("`", "").lower().split())


def _says_opt_in(text):
    return _OPT_IN.search(_plain(text)) is not None


def _says_only_with_coverage(text):
    return _ONLY_WITH_COVERAGE.search(_plain(text)) is not None


def _unqualified(text, phrase, window=60):
    """True when `phrase` occurs in `text` with no opt-in marker within
    `window` characters either side — the phrase stated unconditionally."""
    plain = _plain(text)
    start = plain.find(phrase)
    while start != -1:
        around = plain[max(0, start - window): start + len(phrase) + window]
        if not _says_opt_in(around):
            return True
        start = plain.find(phrase, start + 1)
    return False


_PRINTED = {}


def _printed_root_help(client):
    """`<client>-crucible.py --help` as the real client prints it."""
    if client in _PRINTED:
        return _PRINTED[client]
    scratch = tempfile.mkdtemp(prefix=f"{client}-coverage-opt-in-help-", dir="/tmp")
    try:
        result = subprocess.run(
            [sys.executable, str(CLIENTS_DIR / f"{client}-crucible.py"), "--help"],
            cwd=scratch, capture_output=True, text=True, timeout=60, check=False)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    assert result.returncode == 0, (
        f"`{client}-crucible.py --help` exited {result.returncode}; "
        f"stderr={result.stderr[-2000:]!r}")
    _PRINTED[client] = result.stdout
    return result.stdout


class RootRegressionLineSaysCoverageIsOptInTest(unittest.TestCase):
    """The `regression` line of each client's root `--help` listing says
    coverage is opt-in, and no longer calls the run a coverage run outright."""

    def _assert_opt_in(self, client):
        line = _root_line(client, "regression")
        self.assertTrue(
            _says_opt_in(line),
            f"{client}'s root `regression` line does not say coverage is "
            f"opt-in (no --coverage / coverage-free / opt-in): {line!r}")

    def test_maven_root_regression_line_says_coverage_is_opt_in(self):
        self._assert_opt_in("mvn")

    def test_maven_root_regression_line_no_longer_runs_with_jacoco_coverage_unconditionally(self):
        line = _root_line("mvn", "regression")
        self.assertFalse(
            _unqualified(line, "with jacoco coverage"),
            f"maven's root `regression` line still runs 'with JaCoCo coverage' "
            f"unconditionally: {line!r}")

    def test_rust_root_regression_line_says_coverage_is_opt_in(self):
        self._assert_opt_in("rust")

    def test_rust_root_regression_line_no_longer_describes_the_run_as_llvm_cov(self):
        line = _root_line("rust", "regression")
        self.assertFalse(
            _unqualified(line, "cargo llvm-cov nextest --workspace"),
            f"rust's root `regression` line still describes the run as "
            f"`cargo llvm-cov nextest --workspace` unconditionally: {line!r}")
        self.assertFalse(
            _unqualified(line, "workspace coverage regression"),
            f"rust's root `regression` line still calls the run the workspace "
            f"coverage regression unconditionally: {line!r}")

    def test_bun_root_regression_line_says_coverage_is_opt_in_guard(self):
        """GREEN-GUARD: bun's line already names --coverage."""
        self._assert_opt_in("bun")
        self.assertNotIn("only coverage path", _plain(_root_line("bun", "regression")))

    def test_python_root_regression_line_says_coverage_is_opt_in_guard(self):
        """GREEN-GUARD: python's line already names --coverage."""
        self._assert_opt_in("python")
        self.assertNotIn("only coverage path", _plain(_root_line("python", "regression")))

    def test_arduino_root_regression_line_says_coverage_is_opt_in_guard(self):
        """GREEN-GUARD: arduino's line already names --coverage."""
        self._assert_opt_in("arduino")


class MavenDescriptionSaysCoverageIsOptInTest(unittest.TestCase):
    """maven's root description no longer lists a JaCoCo regression as an
    unconditional tier."""

    def test_maven_description_no_longer_lists_full_regression_with_jacoco_unconditionally(self):
        description = _root_parser("mvn").description or ""
        self.assertFalse(
            _unqualified(description, "regression with jacoco"),
            "maven's root description still lists 'full regression with "
            "JaCoCo' with no word that coverage is opt-in")

    def test_maven_description_that_names_jacoco_says_coverage_is_opt_in(self):
        description = _root_parser("mvn").description or ""
        self.assertIn("jacoco", _plain(description),
                      "maven's root description should still name its coverage tool")
        self.assertTrue(
            _says_opt_in(description),
            "maven's root description names JaCoCo but never says coverage "
            "is opt-in (no --coverage / coverage-free / opt-in)")


class CoverageOnlyFlagHelpSaysItNeedsCoverageTest(unittest.TestCase):
    """Each coverage-only flag on `regression` says it applies only with
    `--coverage`."""

    def _assert_only_with_coverage(self, client, flag):
        text = _flag_help(client, "regression", flag)
        self.assertTrue(
            _says_only_with_coverage(text),
            f"{client} `regression {flag}` help does not say it applies only "
            f"with --coverage: {text!r}")

    def test_maven_regression_coverage_profile_help_says_only_with_coverage(self):
        self._assert_only_with_coverage("mvn", "--coverage-profile")

    def test_maven_coverage_profile_variable_is_named_only_alongside_only_with_coverage(self):
        """Wherever maven's root help or `regression --help` names
        CRUCIBLE_COVERAGE_PROFILE, that text says it applies only with
        --coverage."""
        root = _root_parser("mvn")
        texts = [root.description or "", root.epilog or "",
                 _root_line("mvn", "regression")]
        texts.extend(_verb_help_texts("mvn", "regression"))
        mentions = [text for text in texts if "crucible_coverage_profile" in _plain(text)]
        unqualified = [text for text in mentions if not _says_only_with_coverage(text)]
        self.assertEqual(
            unqualified, [],
            "maven's help names CRUCIBLE_COVERAGE_PROFILE without saying it "
            "applies only with --coverage")

    def test_python_regression_cov_source_help_says_only_with_coverage(self):
        self._assert_only_with_coverage("python", "--cov-source")

    def test_rust_regression_lcov_output_help_says_only_with_coverage_guard(self):
        """GREEN-GUARD: already true."""
        self._assert_only_with_coverage("rust", "--lcov-output")

    def test_rust_regression_ignore_run_fail_help_says_only_with_coverage_guard(self):
        """GREEN-GUARD: already true."""
        self._assert_only_with_coverage("rust", "--ignore-run-fail")

    def test_rust_regression_keep_target_help_says_only_with_coverage_guard(self):
        """GREEN-GUARD: already true."""
        self._assert_only_with_coverage("rust", "--keep-target")


class PreMergeGateHelpDropsTheOnlyCoveragePathClaimTest(unittest.TestCase):
    """bun's and python's `pre-merge-gate` no longer claim to be the only
    coverage path — `regression --coverage` is one too."""

    def _assert_no_exclusivity_claim(self, client):
        texts = [_root_line(client, "pre-merge-gate")]
        texts.extend(_verb_help_texts(client, "pre-merge-gate"))
        for text in texts:
            for claim in _EXCLUSIVE_COVERAGE_CLAIMS:
                self.assertNotIn(
                    claim, _plain(text),
                    f"{client}'s pre-merge-gate help still claims {claim!r}: {text!r}")

    def test_bun_pre_merge_gate_help_no_longer_claims_the_only_coverage_path(self):
        self._assert_no_exclusivity_claim("bun")

    def test_python_pre_merge_gate_help_no_longer_claims_the_only_coverage_path(self):
        self._assert_no_exclusivity_claim("python")


class RegressionHelpListsTheSharedCoverageSwitchTest(unittest.TestCase):
    """GREEN-GUARD: each client's `regression --help` lists `--coverage` with
    the one shared sentence — the run is coverage-free without it."""

    @classmethod
    def setUpClass(cls):
        shared = _load_module(CLIENTS_DIR / "_crucible_axi.py",
                              "crucible_axi_under_test_coverage_opt_in_help")
        cls.shared_sentence = shared.REGRESSION_COVERAGE_HELP

    def _assert_shared_sentence(self, client):
        self.assertIn("coverage-free", _plain(self.shared_sentence))
        self.assertIn("without it", _plain(self.shared_sentence))
        text = _flag_help(client, "regression", "--coverage")
        self.assertIn(self.shared_sentence, text,
                      f"{client} `regression --coverage` help does not carry the "
                      f"shared coverage sentence: {text!r}")

    def test_bun_regression_help_lists_coverage_with_the_shared_sentence_guard(self):
        self._assert_shared_sentence("bun")

    def test_python_regression_help_lists_coverage_with_the_shared_sentence_guard(self):
        self._assert_shared_sentence("python")

    def test_maven_regression_help_lists_coverage_with_the_shared_sentence_guard(self):
        self._assert_shared_sentence("mvn")

    def test_rust_regression_help_lists_coverage_with_the_shared_sentence_guard(self):
        self._assert_shared_sentence("rust")

    def test_arduino_regression_help_lists_coverage_with_the_shared_sentence_guard(self):
        self._assert_shared_sentence("arduino")


class PrintedRootHelpCarriesNoStaleCoverageClaimTest(unittest.TestCase):
    """The root `--help` each real client prints carries none of the stale
    coverage claims."""

    def _assert_no_only_coverage_path(self, client):
        # assertFalse, not assertNotIn: a failure names the claim, never the
        # whole printed help.
        self.assertFalse(
            "only coverage path" in _plain(_printed_root_help(client)),
            f"{client}'s printed root help still claims 'the only coverage path'")

    def test_printed_bun_root_help_no_longer_claims_the_only_coverage_path(self):
        self._assert_no_only_coverage_path("bun")

    def test_printed_python_root_help_no_longer_claims_the_only_coverage_path(self):
        self._assert_no_only_coverage_path("python")

    def test_printed_maven_root_help_no_longer_states_jacoco_regression_unconditionally(self):
        printed = _printed_root_help("mvn")
        self.assertFalse(
            _unqualified(printed, "full regression with jacoco", window=40),
            "maven's printed root help still lists 'full regression with JaCoCo' "
            "unconditionally")
        self.assertFalse(
            _unqualified(printed, "mvn clean verify with jacoco coverage", window=40),
            "maven's printed root help still runs regression 'with JaCoCo "
            "coverage' unconditionally")

    def test_printed_rust_root_help_no_longer_calls_regression_the_coverage_regression(self):
        # "runs the ..." — `workspace-regression`'s own line ("Full workspace
        # coverage regression") is unchanged and must not be caught.
        printed = _printed_root_help("rust")
        self.assertFalse(
            _unqualified(printed, "runs the workspace coverage regression", window=40),
            "rust's printed root help still calls regression the workspace "
            "coverage regression unconditionally")


PARSED_ROUTE = "/api/v2/runs/parsed"
RUNS_ROUTE = "/api/v2/runs"


class TheLcovCoverageSentenceHoldsOnEitherRouteTest(unittest.TestCase):
    """The shared lcov `--coverage` sentence (bun's and arduino's
    `regression`) says the coverage "is filed with its results" and names no
    route: bun sends its reports to /api/v2/runs while arduino still posts to
    the parsed route, and the one sentence holds for both."""

    def _assert_route_neutral(self, client):
        text = _plain(_flag_help(client, "regression", "--coverage"))
        self.assertIn("lcov", text, f"{client}: {text!r}")
        self.assertIn("is filed with its results", text,
                      f"{client} `regression --coverage` help: {text!r}")
        self.assertNotIn(PARSED_ROUTE, text,
                         f"{client} `regression --coverage` help names a "
                         f"route: {text!r}")

    def test_bun_regression_coverage_help_says_the_coverage_is_filed_with_its_results(self):
        self._assert_route_neutral("bun")

    def test_arduino_regression_coverage_help_says_the_coverage_is_filed_with_its_results(self):
        self._assert_route_neutral("arduino")


class BunPrintedHelpNamesTheRouteItsReportsTakeTest(unittest.TestCase):
    """bun sends every report to /api/v2/runs for the board to decode, so
    neither its printed help nor its module docstring says a report is
    parsed by the client and posted to /api/v2/runs/parsed."""

    def test_no_printed_bun_help_names_the_parsed_route(self):
        root = _root_parser("bun")
        texts = {"<root>": [root.description or "", root.epilog or ""]}
        for verb in _subparsers_action("bun").choices:
            texts[verb] = _verb_help_texts("bun", verb)
        naming = sorted(verb for verb, found in texts.items()
                        if any(PARSED_ROUTE in text for text in found))
        self.assertEqual(naming, [],
                         f"bun's printed help names {PARSED_ROUTE} in: {naming}")

    def test_the_bun_module_docstring_names_the_runs_route_and_not_the_parsed_one(self):
        module = _load_module(CLIENTS_DIR / "bun-crucible.py",
                              "bun_crucible_docstring_route_under_test")
        doc = module.__doc__ or ""
        self.assertNotIn(PARSED_ROUTE, doc,
                         "the bun client's docstring still says it posts to "
                         "the parsed route")
        self.assertIn(RUNS_ROUTE, doc,
                      "the bun client's docstring names the route its reports "
                      "take")


class PythonPrintedHelpNamesTheRouteItsReportsTakeTest(unittest.TestCase):
    """python sends every report to /api/v2/runs for the board to decode, so
    neither its printed help, its `regression --coverage` sentence
    (`REGRESSION_COVERAGE_PY_HELP`) nor its module docstring says a report
    is posted to /api/v2/runs/parsed."""

    def test_no_printed_python_help_names_the_parsed_route(self):
        root = _root_parser("python")
        texts = {"<root>": [root.description or "", root.epilog or ""]}
        for verb in _subparsers_action("python").choices:
            texts[verb] = _verb_help_texts("python", verb)
        naming = sorted(verb for verb, found in texts.items()
                        if any(PARSED_ROUTE in text for text in found))
        self.assertEqual(naming, [],
                         f"python's printed help names {PARSED_ROUTE} in: {naming}")

    def test_the_python_regression_coverage_help_names_the_runs_route(self):
        text = _plain(_flag_help("python", "regression", "--coverage"))
        self.assertIn("coverage.py", text, f"{text!r}")
        self.assertNotIn(PARSED_ROUTE, text,
                         f"python `regression --coverage` help names the parsed "
                         f"route: {text!r}")
        self.assertIn(RUNS_ROUTE, text,
                      f"python `regression --coverage` help names the route its "
                      f"coverage takes: {text!r}")

    def test_the_python_module_docstring_names_the_runs_route_and_not_the_parsed_one(self):
        module = _load_module(CLIENTS_DIR / "python-crucible.py",
                              "python_crucible_docstring_route_under_test")
        doc = module.__doc__ or ""
        self.assertNotIn(PARSED_ROUTE, doc,
                         "the python client's docstring still says it posts to "
                         "the parsed route")
        self.assertIn(RUNS_ROUTE, doc,
                      "the python client's docstring names the route its reports "
                      "take")


# Phrases that state a green-only coverage rule: the maven client sends its
# JaCoCo CSVs on every coverage run, and the board discards a red run's.
_GREEN_ONLY_COVERAGE = ("no failure", "known-green")


class MavenPrintedHelpNamesTheRouteItsReportsTakeTest(unittest.TestCase):
    """maven sends every report and every JaCoCo CSV to /api/v2/runs for the
    board to decode, on a red run as on a green one, so neither its printed
    help nor its module docstring names /api/v2/runs/parsed, and no printed
    help says coverage is collected only from a run with no failure."""

    def _printed_texts(self):
        root = _root_parser("mvn")
        texts = {"<root>": [root.description or "", root.epilog or ""]}
        for pseudo in _subparsers_action("mvn")._choices_actions:
            texts["<root>"].append(pseudo.help or "")
        for verb in _subparsers_action("mvn").choices:
            texts[verb] = _verb_help_texts("mvn", verb)
        return texts

    def test_no_printed_maven_help_names_the_parsed_route(self):
        naming = sorted(verb for verb, found in self._printed_texts().items()
                        if any(PARSED_ROUTE in text for text in found))
        self.assertEqual(naming, [],
                         f"maven's printed help names {PARSED_ROUTE} in: {naming}")

    def test_no_printed_maven_help_states_a_green_only_coverage_rule(self):
        stating = sorted(
            (verb, phrase) for verb, found in self._printed_texts().items()
            for phrase in _GREEN_ONLY_COVERAGE
            if any(phrase in _plain(text) for text in found))
        self.assertEqual(stating, [],
                         f"maven's printed help states a green-only coverage "
                         f"rule in: {stating}")

    def test_the_maven_regression_and_auto_ingest_coverage_help_names_jacoco(self):
        for verb in ("regression", "auto-ingest"):
            with self.subTest(verb=verb):
                text = _plain(_flag_help("mvn", verb, "--coverage"))
                self.assertIn("jacoco", text, f"{verb}: {text!r}")

    def test_the_maven_module_docstring_names_the_runs_route_and_not_the_parsed_one(self):
        module = _load_module(CLIENTS_DIR / "mvn-crucible.py",
                              "mvn_crucible_docstring_route_under_test")
        doc = module.__doc__ or ""
        self.assertNotIn(PARSED_ROUTE, doc,
                         "the maven client's docstring still says it posts to "
                         "the parsed route")
        self.assertIn(RUNS_ROUTE, doc,
                      "the maven client's docstring names the route its reports "
                      "take")


# Phrases that say coverage is published on a failing run: the rust client
# sends its lcov on every coverage run, and the board discards a red run's.
_PUBLISHED_ON_FAILURE = ("published even on", "published on failure",
                         "published on a failing")


class RustPrintedHelpNamesTheRouteItsReportsTakeTest(unittest.TestCase):
    """rust sends its nextest report and its lcov to /api/v2/runs for the
    board to decode, on a red run as on a green one, so neither its printed
    help nor its module docstring names /api/v2/runs/parsed, and no printed
    help says coverage is published on a failing run."""

    def _printed_texts(self):
        root = _root_parser("rust")
        texts = {"<root>": [root.description or "", root.epilog or ""]}
        for pseudo in _subparsers_action("rust")._choices_actions:
            texts["<root>"].append(pseudo.help or "")
        for verb in _subparsers_action("rust").choices:
            texts[verb] = _verb_help_texts("rust", verb)
        return texts

    def test_no_printed_rust_help_names_the_parsed_route(self):
        naming = sorted(verb for verb, found in self._printed_texts().items()
                        if any(PARSED_ROUTE in text for text in found))
        self.assertEqual(naming, [],
                         f"rust's printed help names {PARSED_ROUTE} in: {naming}")

    def test_no_printed_rust_help_says_coverage_is_published_on_a_failing_run(self):
        stating = sorted(
            (verb, phrase) for verb, found in self._printed_texts().items()
            for phrase in _PUBLISHED_ON_FAILURE
            if any(phrase in _plain(text) for text in found))
        self.assertEqual(stating, [],
                         f"rust's printed help says coverage is published on a "
                         f"failing run in: {stating}")

    def test_the_rust_module_docstring_names_the_runs_route_and_not_the_parsed_one(self):
        module = _load_module(CLIENTS_DIR / "rust-crucible.py",
                              "rust_crucible_docstring_route_under_test")
        doc = module.__doc__ or ""
        self.assertNotIn(PARSED_ROUTE, doc,
                         "the rust client's docstring still says it posts to "
                         "the parsed route")
        self.assertIn(RUNS_ROUTE, doc,
                      "the rust client's docstring names the route its reports "
                      "take")


if __name__ == "__main__":
    unittest.main()
