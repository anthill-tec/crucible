"""The helpers of `test_bun_client_printed_help_names_no_project.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import re


def normalise(text):
    """Whitespace-insensitive help text: every run of whitespace is one space
    and a hyphen argparse broke a line on is re-joined."""
    collapsed = re.sub(r"\s+", " ", text or "")
    return re.sub(r"-\s+", "-", collapsed).strip()


def option_help(help_text, option):
    """The printed help entry of `option` in an argparse help: from the line
    that introduces it to the next line that introduces another option or a
    section, normalised. Empty when the option is not printed."""
    lines = help_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if start is None:
            if re.match(rf"{re.escape(option)}(\s|,|$)", stripped):
                start = index
            continue
        if stripped.startswith("-") and line.startswith("  ") and not line.startswith(" " * 6):
            return normalise("\n".join(lines[start:index]))
        if line and not line.startswith(" "):
            return normalise("\n".join(lines[start:index]))
    return normalise("\n".join(lines[start:])) if start is not None else ""
