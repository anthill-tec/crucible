"""The `lint` verb and the gate's lint stage are described where an operator
reads them: every client's `--help` and the next steps an envelope names.

What this file pins, phrase by phrase (never whole sentences, so the wording
stays the writer's):

- **Each client's help.**
  - The top-level `--help` lists the `lint` verb, its line naming the `[lint]`
    table (a guard: the verb shipped with its help).
  - `pre-merge-gate --help` names `--skip-lint` (a guard) and, in one
    sentence, the client's own stage order: python and bun `check` -> lint ->
    the tests, arduino `compile` -> lint -> the tests, rust lint -> regression,
    go lint -> the tests, maven lint -> docker.
  - The gate's line in the top-level `--help` (bun's description lists it
    too) states that same order with lint in it, so no summary still says
    `check -> regression`.
  - Rust's gate names its lint stage, never a "fail-fast clippy" step or a
    "clippy step", and names `--skip-clippy` as an alias.
- **Next steps.** `HELP_STEPS["check"]` names `lint` as a step, since a gate
  runs lint after check; a clean `lint` names the tests as its next step and
  a failing one names `lint` again, each as a runnable verb, as every other
  `help[]` step is.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them
"""

import re
import shutil
import unittest

from tests.client.lint_verb_harness import LintDriveMixin, lint_table
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _make_project_dir,
    drive_verb,
)
from tests.client.every_clients_help_names_where_its_board_comes_from_helpers import (
    _top_level_helps,
    normalise,
)
from tests.client import client_script

AXI_MODULE_PATH = client_script("_crucible_axi.py")

_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}

#: Text between two stages of one stated order: anything but a sentence end
#: (a period followed by whitespace), so `coverage.py` does not end it.
_SAME_SENTENCE = r"(?:[^.]|\.(?=\S))*?"

_LINT = r"\blint\b"
_TESTS = r"(?:\btests?\b|regression)"

#: The clients whose help this file reads for a lint verb and a lint stage:
#: the whole fleet but eda, which is excluded because it has no `lint` verb
#: and its `pre-merge-gate` runs no lint stage yet, so its help has neither to
#: describe. Its top-level help is still driven, as every client's is.
LINT_CLIENTS = {key: path for key, path in CLIENT_FILES.items() if key != "eda"}

#: Each client's gate order, as the stages it names in turn.
STAGE_ORDER = {
    "python": (r"\bcheck\b", _LINT, _TESTS),
    "bun": (r"\bcheck\b", _LINT, _TESTS),
    "arduino": (r"\bcompile\b", _LINT, _TESTS),
    "rust": (_LINT, r"regression"),
    "go": (_LINT, _TESTS),
    "mvn": (_LINT, r"\bdocker"),
}


def stage_order_pattern(client):
    """One regex: the client's stages in order, all in one sentence."""
    return re.compile("(?i)" + _SAME_SENTENCE.join(STAGE_ORDER[client]))


def gate_entries(help_stdout):
    """Every `pre-merge-gate` entry a top-level help lists (argparse's verb
    list, and a hand-written verb list in a description), each with its
    continuation lines, as one normalised string."""
    lines = help_stdout.splitlines()
    entries = []
    for index, line in enumerate(lines):
        if not re.match(r"^\s{1,6}pre-merge-gate(?:\s{2,}\S|\s*$)", line):
            continue
        entry = [line]
        for follow in lines[index + 1:]:
            if follow.strip() and re.match(r"^\s{12,}\S", follow):
                entry.append(follow)
            else:
                break
        entries.append(normalise("\n".join(entry)))
    return entries


def after_usage(help_stdout):
    """A verb's help without its usage block, which lists every flag name."""
    return help_stdout.split("\n\n", 1)[1] if "\n\n" in help_stdout else ""


_GATE_HELP_CACHE = None


def _gate_helps():
    """Each client's real `pre-merge-gate --help`, driven once per run."""
    global _GATE_HELP_CACHE
    if _GATE_HELP_CACHE is not None:
        return _GATE_HELP_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    helps = {}
    try:
        for client_key, script_path in LINT_CLIENTS.items():
            project_dir = _make_project_dir(client_key)
            try:
                helps[client_key] = drive_verb(
                    script_path, ["pre-merge-gate", "--help"], project_dir,
                    fake_bin_dir, extra_env=_HELP_ENV)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _GATE_HELP_CACHE = helps
    return helps


class EveryClientsHelpNamesTheLintVerbTest(unittest.TestCase):
    """The top-level `--help` lists `lint`, and says it runs the `[lint]`
    table. A guard: the verb shipped with its help."""

    @classmethod
    def setUpClass(cls):
        cls.helps = _top_level_helps()

    def test_every_clients_top_level_help_lists_the_lint_verb_naming_its_table(self):
        self.assertEqual(sorted(self.helps), sorted(CLIENT_FILES))
        offenders = {}
        for client_key in LINT_CLIENTS:
            completed = self.helps[client_key]
            self.assertEqual(completed.returncode, 0, f"{client_key}: {completed.stderr!r}")
            entry = re.search(r"(?m)^\s{1,6}lint\s{2,}(.*)$", completed.stdout)
            if entry is None or "[lint]" not in entry.group(1):
                offenders[client_key] = entry.group(0) if entry else None
        self.assertEqual(offenders, {},
                         "each --help lists `lint`, its line naming the [lint] table")


class EveryGatesHelpNamesItsLintStageTest(unittest.TestCase):
    """`pre-merge-gate --help` names `--skip-lint` and the client's own stage
    order, and the gate's line in the top-level help states that order."""

    @classmethod
    def setUpClass(cls):
        cls.gate = _gate_helps()
        cls.top = _top_level_helps()

    def gate_help(self, client_key):
        completed = self.gate[client_key]
        self.assertEqual(completed.returncode, 0,
                         f"{client_key} pre-merge-gate --help: {completed.stderr!r}")
        return completed.stdout

    def test_every_gates_help_names_skip_lint(self):
        missing = [c for c in LINT_CLIENTS if "--skip-lint" not in self.gate_help(c)]
        self.assertEqual(missing, [], "every gate's help names --skip-lint")

    def test_every_gates_help_states_its_own_stage_order_with_lint(self):
        offenders = {}
        for client_key in LINT_CLIENTS:
            text = normalise(after_usage(self.gate_help(client_key)))
            if not stage_order_pattern(client_key).search(text):
                offenders[client_key] = STAGE_ORDER[client_key]
        self.assertEqual(
            offenders, {},
            "each `pre-merge-gate --help` states, in one sentence, its own "
            "stage order with lint in it; missing (client: stages in order): "
            f"{offenders!r}")

    def test_the_gates_line_in_every_top_level_help_states_the_order_with_lint(self):
        offenders = {}
        for client_key in LINT_CLIENTS:
            entries = gate_entries(self.top[client_key].stdout)
            wrong = [e for e in entries if not stage_order_pattern(client_key).search(e)]
            if not entries or wrong:
                offenders[client_key] = entries
        self.assertEqual(
            offenders, {},
            "every `pre-merge-gate` line a top-level --help lists states the "
            f"gate's order with lint in it; lines that do not: {offenders!r}")

    def test_the_rust_gates_help_names_a_lint_stage_and_no_clippy_step(self):
        retired = re.compile(r"(?i)fail-fast clippy|clippy step")
        texts = [normalise(after_usage(self.gate_help("rust")))]
        texts += gate_entries(self.top["rust"].stdout)
        self.assertEqual([t for t in texts if retired.search(t)], [],
                         "the rust gate's first stage is its lint stage, not a clippy step")

    def test_the_rust_gates_help_names_skip_clippy_as_an_alias(self):
        text = normalise(after_usage(self.gate_help("rust")))
        self.assertIn("--skip-clippy", text)
        self.assertRegex(
            text,
            rf"(?i)--skip-clippy{_SAME_SENTENCE}\balias\b|\balias\b{_SAME_SENTENCE}--skip-clippy",
            "rust's gate help says --skip-clippy is an alias of --skip-lint")


class TheNextStepsNameLintTest(LintDriveMixin, unittest.TestCase):
    """`check`'s next step is lint where a gate runs lint next; a clean lint's
    next step is the tests, and a failing lint's is lint again, each a
    runnable verb as every other `help[]` step is."""

    RUFF = "lint-words-ruff"

    def setUp(self):
        super().setUp()
        self.fake(self.RUFF)
        self.root = self.project(lint_table([self.RUFF, "check", "."], format="ruff"))

    def help_steps(self, exit_code):
        self.say((("out", "app/a.py:1:1: F401 `os` imported but unused\n"),)
                 if exit_code else (), exit_code=exit_code)
        result, axi = self.run_client("python", self.root)
        self.assertEqual((axi.get("verb"), axi.get("exit")), ("lint", exit_code),
                         f"stdout={result.stdout!r} stderr={result.stderr[-2000:]}")
        return axi.get("help") or []

    def test_the_check_step_names_lint(self):
        steps = _load_module(AXI_MODULE_PATH, "lint_words_axi").HELP_STEPS["check"]
        self.assertTrue([s for s in steps if re.match(r"lint\b", s)],
                        f"HELP_STEPS['check'] names the lint verb as a step; got {steps!r}")

    def test_a_clean_lint_names_the_test_verb_as_its_next_step(self):
        steps = self.help_steps(0)
        self.assertTrue([s for s in steps if re.match(r"test\b", s)],
                        f"a clean lint's help names `test` as a step; got {steps!r}")

    def test_a_failing_lint_names_lint_again_as_its_next_step(self):
        steps = self.help_steps(1)
        self.assertTrue([s for s in steps if re.match(r"lint\b", s)],
                        f"a failing lint's help names `lint` as a step; got {steps!r}")


if __name__ == "__main__":
    unittest.main()
