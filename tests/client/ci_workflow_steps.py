"""CI's test steps, read out of `.github/workflows/release.yml` as the shell
runs them.

The fixture guards (`test_*_fixture_stays_out_of_this_repos_suite*.py`) read
which directories CI's test steps collect. Since CR-CRU-263 those steps run
through the hermetic wrapper, `scripts/hermetic/run.sh <log-dir> -- <command>`,
the unit tiers with their dependency hooks, so a step is read as a COMMAND:
every `run:` value (a plain scalar or a `|` block) with its line continuations
joined and its shell comments dropped, then split into the wrapper and the
command it runs. No YAML parser: the standard library has none, and the suite
adds no dependency for one.
"""

import re
import shlex
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"

_RUN_KEY = re.compile(r"^(\s*)(?:-\s+)?run:\s*(.*)$")
_WRAPPED = re.compile(r"^scripts/hermetic/run\.sh\s+(.+?)\s+--\s+(.+)$")
_BUN_TEST = re.compile(r"(?:^|\s)((?:\S*/)?bun\s+test(?:\s.*)?)$")
_PYTHON_SUITE = re.compile(
    r"(?:^|\s)(\S*python3?\s+(?:-m\s+unittest\s+discover|scripts/hermetic/tagging_runner\.py)(?:\s.*)?)$")

#: The `bun test` flags whose value is a separate token and never a path.
_BUN_VALUE_FLAGS = ("--timeout", "--preload")


def _indent(line):
    return len(line) - len(line.lstrip())


def _logical_commands(lines):
    """The commands a shell script's lines run: continuations joined, blank
    lines and `#` comment lines dropped."""
    commands, pending = [], ""
    for line in lines:
        text = line.strip()
        if not pending and (not text or text.startswith("#")):
            continue
        if text.endswith("\\"):
            pending += text[:-1].strip() + " "
            continue
        commands.append(" ".join((pending + text).split()))
        pending = ""
    if pending.strip():
        commands.append(" ".join(pending.split()))
    return commands


def _folded(lines):
    """A `>` block's lines as YAML folds them: each run of non-blank lines
    becomes one line, joined with spaces."""
    folded, paragraph = [], []
    for line in [*lines, ""]:
        if line.strip():
            paragraph.append(line.strip())
        elif paragraph:
            folded.append(" ".join(paragraph))
            paragraph = []
    return folded


def run_commands():
    """Every command a `run:` value of the workflow runs, in file order."""
    lines = CI_WORKFLOW.read_text().splitlines()
    commands, index = [], 0
    while index < len(lines):
        match = _RUN_KEY.match(lines[index])
        index += 1
        if not match:
            continue
        value = match.group(2).strip()
        if value[:1] in ("|", ">"):
            indent, body = len(match.group(1)), []
            while index < len(lines) and (
                    not lines[index].strip() or _indent(lines[index]) > indent):
                body.append(lines[index])
                index += 1
            commands.extend(_logical_commands(
                _folded(body) if value.startswith(">") else body))
        else:
            commands.extend(_logical_commands([re.sub(r"\s+#.*$", "", value)]))
    return commands


def unwrapped(command):
    """`(wrapped, inner)`: whether `command` runs through the hermetic wrapper,
    and the command the wrapper runs (or `command` itself)."""
    match = _WRAPPED.match(command)
    return (True, match.group(2)) if match else (False, command)


def bun_test_steps():
    """CI's `bun test` commands, in file order, each as `(wrapped, bun test
    ...)`: whatever precedes `bun test` inside the wrapper (an `env`
    assignment) is not part of what bun collects."""
    steps = []
    for command in run_commands():
        wrapped, inner = unwrapped(command)
        match = _BUN_TEST.search(inner)
        if match:
            steps.append((wrapped, match.group(1)))
    return steps


def bun_tier_paths():
    """Each CI `bun test` step's path arguments, in step order: the tokens
    after `bun test`, less the flags and the values `--timeout` and
    `--preload` carry."""
    tiers = []
    for _wrapped, command in bun_test_steps():
        paths, skip_value = [], False
        for arg in shlex.split(command)[2:]:
            if skip_value:
                skip_value = False
            elif arg in _BUN_VALUE_FLAGS:
                skip_value = True
            elif not arg.startswith("-"):
                paths.append(arg)
        tiers.append(paths)
    return tiers


def python_suite_steps():
    """CI's python suite commands, in file order, each as `(wrapped,
    <interpreter> ...)`: a `-m unittest discover`, or the hermetic tagging
    runner, whatever interpreter runs it."""
    steps = []
    for command in run_commands():
        wrapped, inner = unwrapped(command)
        match = _PYTHON_SUITE.search(inner)
        if match:
            steps.append((wrapped, match.group(1)))
    return steps


def python_start_dir(command):
    """The start directory a python suite command discovers: the `-s` of a
    `unittest discover`, or the tagging runner's one argument (the runner
    discovers it with `-t .` itself). None when it names neither."""
    args = shlex.split(command)
    if "-s" in args[:-1]:
        return args[args.index("-s") + 1]
    for position, arg in enumerate(args[:-1]):
        if arg.endswith("scripts/hermetic/tagging_runner.py"):
            return args[position + 1]
    return None
