"""The helpers of `test_the_declaration_schema_is_documented.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import re
from pathlib import Path

from tests.client.changelog_section import changelog_entries


REPO_ROOT = Path(__file__).resolve().parents[2]

CHANGELOG = REPO_ROOT / "CHANGELOG.md"

README = REPO_ROOT / "README.md"

RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"

SCHEMA_NAME = "crucible-declaration.schema.json"


def _stack_declaration_sections(text):
    """Every `### Stack declaration changes` subsection of the changelog's
    release sections, newest first, each up to the next `### ` heading: one
    release's own."""
    return re.findall(r"(?ms)^### Stack declaration changes\n(.*?)(?=^### |\Z)",
                      changelog_entries(text))


def _stack_part(section, *names):
    """The paragraph(s) for one stack: from its `For the <stack> stack` line to
    the next `For the ` line."""
    alternatives = "|".join(re.escape(name) for name in names)
    found = re.search(rf"(?ms)^For the (?:{alternatives}) stack.*?(?=^For the |\Z)", section)
    return found.group(0) if found else ""


def _schema_part(section):
    """From the line that first names the schema file to the next `For the `
    line, or to the end of the section."""
    at = section.find(SCHEMA_NAME)
    if at < 0:
        return ""
    start = section.rfind("\n", 0, at) + 1
    following = re.compile(r"(?m)^For the ").search(section, at)
    return section[start:following.start() if following else len(section)]


def _stack_parts(sections, *names):
    """One stack's parts, each read within its own subsection, joined."""
    return "\n".join(part for part in (_stack_part(s, *names) for s in sections) if part)


def _schema_parts(sections):
    """The schema parts, each read within its own subsection, joined."""
    return "\n".join(part for part in map(_schema_part, sections) if part)


def _blocks(text):
    """Paragraphs and top-level bullets, each as one string."""
    return [block for block in re.split(r"\n\s*\n|\n(?=- )", text) if block.strip()]
