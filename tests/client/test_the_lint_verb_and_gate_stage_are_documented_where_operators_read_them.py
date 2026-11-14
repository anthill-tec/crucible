"""The `lint` verb and the gate's lint stage are described where an operator
reads them: every client's `--help`, the shipped `clients/crucible.toml`, the
PRD's lint-records section (4.5.1), the RUNBOOK's Lint section, the CHANGELOG's
`[Unreleased]` section, and the next steps an envelope names.

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
- **The shipped `clients/crucible.toml`** documents `[lint]` in a commented
  block naming `command`, `format` and `name`, and declares no `[lint]` table
  (a guard).
- **The PRD's section 4.5.1** names the table and its fields, the rust and go
  defaults, the `not-declared` skip with its `lint-not-declared` warning, each
  client's stage order, and the install fallback; it no longer says "each
  project declares its linter in its client config".
- **The RUNBOOK** has a `## Lint` section naming the table, the defaults, the
  gate's stage and its `--skip-lint`, the install fallback, and the table a
  checkout of this repo adds to its own `crucible.toml`.
- **The CHANGELOG's `[Unreleased]`** has an entry naming the `lint` verb in
  every client, and the rust gate's mapping: `stage: "lint"`,
  `lint-gate-abort`, and `--skip-clippy` kept as an alias of `--skip-lint`.
- **Next steps.** `HELP_STEPS["check"]` names `lint` as a step, since a gate
  runs lint after check; a clean `lint` names the tests as its next step and
  a failing one names `lint` again, each as a runnable verb, as every other
  `help[]` step is.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them
"""

import re
import shutil
import tomllib
import unittest
from pathlib import Path

from tests.client.lint_verb_harness import LintDriveMixin, lint_table
from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _make_project_dir,
    drive_verb,
)
from tests.client.test_every_clients_help_names_where_its_board_comes_from import (
    _top_level_helps,
    normalise,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
PRD = REPO_ROOT / "docs" / "research" / "PRD-crucible-v2.md"
RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}

#: Text between two stages of one stated order: anything but a sentence end
#: (a period followed by whitespace), so `coverage.py` does not end it.
_SAME_SENTENCE = r"(?:[^.]|\.(?=\S))*?"

_LINT = r"\blint\b"
_TESTS = r"(?:\btests?\b|regression)"

#: Each client's gate order, as the stages it names in turn.
STAGE_ORDER = {
    "python": (r"\bcheck\b", _LINT, _TESTS),
    "bun": (r"\bcheck\b", _LINT, _TESTS),
    "arduino": (r"\bcompile\b", _LINT, _TESTS),
    "rust": (_LINT, r"regression"),
    "go": (_LINT, _TESTS),
    "mvn": (_LINT, r"\bdocker"),
}

#: How a document names each client.
CLIENT_NAMES = {
    "python": r"(?i)\bpython\b",
    "bun": r"(?i)\bbun\b",
    "arduino": r"(?i)\barduino\b",
    "rust": r"(?i)\brust\b",
    "go": r"(?i)\bgo\b",
    "mvn": r"(?i)\b(?:maven|mvn)\b",
}

#: The table a checkout of this repo adds to its own `crucible.toml`.
CHECKOUT_COMMAND = (r'command\s*=\s*\[\s*"ruff",\s*"check",\s*"--output-format",\s*'
                    r'"concise",\s*"clients",\s*"crucible_axi",\s*"tests"\s*\]')
CHECKOUT_FORMAT = r'format\s*=\s*"ruff"'

RUST_DEFAULT = r"cargo clippy\s+--workspace"
GO_DEFAULT = r"go vet \./\.\.\."

#: The one sentence the PRD's lint section said before the table existed.
RETIRED_PRD_SENTENCE = "each project declares its linter in its client config"

#: The fields of the table, as a document names them.
TABLE_FIELDS = {
    "command": r"`command`|\bcommand\s*=",
    "format": r"`format`|\bformat\s*=",
    "name": r"`name`|\bname\s*=",
}


def stage_order_pattern(client):
    """One regex: the client's stages in order, all in one sentence."""
    return re.compile("(?i)" + _SAME_SENTENCE.join(STAGE_ORDER[client]))


def flat(text):
    return re.sub(r"\s+", " ", text or "").strip()


def sentences(text):
    return [s for s in re.split(r"(?<=\.)\s+", flat(text)) if s]


def segments(text):
    """A document's lines (a table row is one) and its sentences."""
    return [line for line in (text or "").splitlines() if line.strip()] + sentences(text)


def section(text, heading, level):
    """From the first heading of `level` matching `heading` to the next
    heading of that level or higher; empty when there is none."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines)
                  if re.match(rf"^#{{{level}}} ", line) and re.search(heading, line)),
                 None)
    if start is None:
        return ""
    end = next((i for i in range(start + 1, len(lines))
                if re.match(rf"^#{{1,{level}}} ", lines[i])), len(lines))
    return "\n".join(lines[start:end])


def unreleased(text):
    parts = text.split("## [Unreleased]", 1)
    if len(parts) < 2:
        return ""
    return re.split(r"(?m)^## \[", parts[1], maxsplit=1)[0]


def bullets(text):
    """Each top-level bullet with its sub-bullets, as one string."""
    return [b for b in re.split(r"\n(?=- )", text) if b.lstrip().startswith("- ")]


def install_fallback_named(text):
    """A sentence or line that names the install's `[lint]` replacing a
    stack's default."""
    return [s for s in segments(text)
            if re.search(r"(?i)\binstall", s) and re.search(r"(?i)\bdefault", s)
            and re.search(r"(?i)inherit|replac|instead|overrid|whatever", s)]


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
        for client_key, script_path in CLIENT_FILES.items():
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
        for client_key, completed in self.helps.items():
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
        missing = [c for c in CLIENT_FILES if "--skip-lint" not in self.gate_help(c)]
        self.assertEqual(missing, [], "every gate's help names --skip-lint")

    def test_every_gates_help_states_its_own_stage_order_with_lint(self):
        offenders = {}
        for client_key in CLIENT_FILES:
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
        for client_key in CLIENT_FILES:
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


class TheShippedConfigDocumentsTheLintTableTest(unittest.TestCase):
    """The shipped `crucible.toml` documents `[lint]` in a commented block and
    declares none."""

    def setUp(self):
        self.text = SHIPPED_TOML.read_text(encoding="utf-8")

    def commented_block(self):
        """The run of comment lines holding a commented `[lint]` header."""
        lines = self.text.splitlines()
        header = next((i for i, line in enumerate(lines)
                       if re.match(r"^#\s*\[lint\]\s*(?:#.*)?$", line)), None)
        if header is None:
            return ""
        start = header
        while start > 0 and lines[start - 1].lstrip().startswith("#"):
            start -= 1
        end = header
        while end + 1 < len(lines) and lines[end + 1].lstrip().startswith("#"):
            end += 1
        return "\n".join(lines[start:end + 1])

    def test_a_commented_block_names_the_lint_table_and_its_three_fields(self):
        block = self.commented_block()
        self.assertTrue(block, "the shipped file carries a commented `[lint]` block")
        missing = [f for f in ("command", "format", "name")
                   if not re.search(rf"\b{f}\b", block)]
        self.assertEqual(missing, [], f"the commented block names each field; block={block!r}")

    def test_the_shipped_file_declares_no_lint_table(self):
        parsed = tomllib.loads(self.text)
        self.assertNotIn("lint", parsed, "the shipped file declares no [lint] table")


class ThePrdsLintSectionDescribesTheClientsLintTest(unittest.TestCase):
    """Section 4.5.1 says what the clients do."""

    def setUp(self):
        self.prd = PRD.read_text(encoding="utf-8")
        self.section = section(self.prd, r"^#### 4\.5\.1 ", 4)
        self.assertTrue(self.section, "the PRD has section 4.5.1")

    def test_it_names_the_table_and_its_fields(self):
        self.assertIn("[lint]", self.section)
        missing = [f for f, p in TABLE_FIELDS.items() if not re.search(p, self.section)]
        self.assertEqual(missing, [], "it names command, format and name")

    def test_it_names_the_rust_and_go_defaults(self):
        self.assertRegex(flat(self.section), RUST_DEFAULT)
        self.assertRegex(flat(self.section), GO_DEFAULT)

    def test_it_names_the_not_declared_skip_and_its_warning(self):
        self.assertRegex(self.section, r"(?<![\w-])not-declared",
                         "the `skipped: not-declared` answer")
        self.assertIn("lint-not-declared", self.section, "the gate's warning")

    def test_it_states_each_clients_stage_order(self):
        missing = []
        for client_key in STAGE_ORDER:
            name = CLIENT_NAMES[client_key]
            order = stage_order_pattern(client_key)
            if not any(re.search(name, s) and order.search(s) for s in segments(self.section)):
                missing.append(client_key)
        self.assertEqual(missing, [],
                         "a line or sentence names each client with its stages in order")

    def test_it_names_the_install_fallback(self):
        self.assertTrue(install_fallback_named(self.section),
                        "it says an install's [lint] replaces a stack's default")

    def test_the_retired_sentence_is_gone(self):
        self.assertNotIn(RETIRED_PRD_SENTENCE, flat(self.prd).lower())


class TheRunbooksLintSectionTest(unittest.TestCase):
    """The RUNBOOK's `## Lint` section."""

    def setUp(self):
        self.section = section(RUNBOOK.read_text(encoding="utf-8"), r"^## Lint\b", 2)

    def test_the_runbook_has_a_lint_section(self):
        self.assertTrue(self.section, "the RUNBOOK has a `## Lint` section")

    def test_it_names_the_table_and_its_fields(self):
        self.assertIn("[lint]", self.section)
        missing = [f for f, p in TABLE_FIELDS.items() if not re.search(p, self.section)]
        self.assertEqual(missing, [], "it names command, format and name")

    def test_it_names_the_rust_and_go_defaults(self):
        self.assertRegex(flat(self.section), RUST_DEFAULT)
        self.assertRegex(flat(self.section), GO_DEFAULT)

    def test_it_names_the_gates_lint_stage_and_its_skip_flag(self):
        self.assertRegex(self.section, r"(?i)\bgate\b|pre-merge-gate")
        self.assertIn("--skip-lint", self.section)

    def test_it_warns_of_the_install_fallback(self):
        self.assertTrue(install_fallback_named(self.section),
                        "it says an install's [lint] replaces a stack's default")

    def test_it_names_the_table_a_checkout_adds_to_its_own_file(self):
        self.assertRegex(self.section, r"(?i)\bcheckout\b")
        self.assertRegex(self.section, CHECKOUT_COMMAND)
        self.assertRegex(self.section, CHECKOUT_FORMAT)


class TheChangelogNamesTheLintVerbAndTheRustMappingTest(unittest.TestCase):
    """The CHANGELOG's `[Unreleased]` section."""

    def setUp(self):
        self.body = unreleased(CHANGELOG.read_text(encoding="utf-8"))
        self.assertTrue(self.body, "the CHANGELOG has an [Unreleased] section")

    def test_an_entry_names_the_lint_verb_in_every_client(self):
        found = [b for b in bullets(self.body)
                 if "`lint`" in b and re.search(r"(?i)\bverb\b", b)
                 and re.search(r"(?i)\b(?:every|each|all(?: six)?)\b[^.]{0,30}\bclients?\b", b)]
        self.assertEqual(len(found), 1,
                         "one entry names the `lint` verb in every client")

    def test_it_maps_the_rust_gates_stage_to_lint(self):
        self.assertRegex(self.body, r'stage:\s*"lint"')

    def test_it_maps_the_rust_gates_abort_warning_to_lint_gate_abort(self):
        self.assertIn("lint-gate-abort", self.body)

    def test_it_keeps_skip_clippy_as_an_alias_of_skip_lint(self):
        found = [s for s in segments(self.body)
                 if "--skip-clippy" in s and "--skip-lint" in s
                 and re.search(r"(?i)\balias\b", s)]
        self.assertTrue(found, "a line or sentence says --skip-clippy stays an alias of --skip-lint")


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
