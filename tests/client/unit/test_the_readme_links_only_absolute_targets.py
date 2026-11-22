"""`README.md` links only absolute targets, so the package page that renders
it as the description resolves every link.

The README is the wheel's description, and the package index has neither the
repository's files nor its heading anchors. So no link in it may have a
relative target, in any of these forms:

- inline links, `[t](u)` and `[t](u "title")`;
- images, `![a](u)`;
- reference definitions, `[l]: u`;
- HTML `href=` and `src=` attributes;
- autolinks, `<u>`.

A target is relative when it has no URI scheme (`^[A-Za-z][A-Za-z0-9+.-]*:`).
A target that is only a `#fragment` counts as relative too. Text inside fenced
code blocks and inline code spans is skipped. In the angle-bracket form, an
HTML tag (`<details>`, `</a>`, `<project-dir>`) and an e-mail autolink are not
link targets.

A unit test: it reads the file in process.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_readme_links_only_absolute_targets
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
README = REPO_ROOT / "README.md"

SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")

#: `[t](u)`, `[t](u "title")`, `[t](<u>)` and, with a leading `!`, images.
INLINE_LINK = re.compile(
    r"(!?)\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)"
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
#: `[label]: u`, up to three spaces of indent.
REFERENCE_DEFINITION = re.compile(r"^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
#: `href=` and `src=` in any quoting.
HTML_ATTRIBUTE = re.compile(r"""\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
                            re.IGNORECASE)
#: `<u>`: no space, no angle bracket inside.
ANGLE = re.compile(r"<([^<>\s]+)>")
HTML_TAG = re.compile(r"^/?[A-Za-z][A-Za-z0-9-]*/?$")
EMAIL = re.compile(r"^[^@/\s]+@[^@/\s]+\.[^@/\s]+$")


def prose_lines(text):
    """(line number, line) for every line outside a fenced code block, with
    its inline code spans blanked."""
    fence = None
    for number, line in enumerate(text.splitlines(), start=1):
        opened = FENCE.match(line)
        if fence is None and opened:
            fence = opened.group(1)
            continue
        if fence is not None:
            closing = FENCE.match(line)
            if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= len(fence) \
                    and not line.strip()[len(closing.group(1)):].strip():
                fence = None
            continue
        yield number, INLINE_CODE.sub(lambda span: " " * len(span.group(0)), line)


def link_targets(text):
    """(line number, form, target) for every link target in the markdown's
    prose, in every form the README may use."""
    found = []
    for number, line in prose_lines(text):
        for match in INLINE_LINK.finditer(line):
            form = "image" if match.group(1) else "inline link"
            found.append((number, form, match.group(2).strip("<>")))
        definition = REFERENCE_DEFINITION.match(line)
        if definition:
            found.append((number, "reference definition", definition.group(1).strip("<>")))
        for match in HTML_ATTRIBUTE.finditer(line):
            value = next(v for v in match.group(2, 3, 4) if v is not None)
            found.append((number, f"HTML {match.group(1).lower()}=", value))
        for match in ANGLE.finditer(line):
            inner = match.group(1)
            if HTML_TAG.match(inner) or EMAIL.match(inner) or "=" in inner:
                continue
            found.append((number, "autolink", inner))
    return found


def is_relative(target):
    """True when the target has no URI scheme; a bare `#fragment` and an
    empty target are relative too."""
    return not SCHEME.match(target.strip())


class TheReadmeLinksOnlyAbsoluteTargetsTest(unittest.TestCase):

    def test_the_readme_has_no_relative_link_target_in_any_form(self):
        targets = link_targets(README.read_text(encoding="utf-8"))
        relative = [f"README.md line {number}: {form} -> {target!r}"
                    for number, form, target in targets if is_relative(target)]
        self.assertEqual(
            relative, [],
            "every link target in README.md is absolute (the package index renders "
            "the README with no repository files and no heading anchors); relative "
            "targets:\n" + "\n".join(relative))


if __name__ == "__main__":
    unittest.main()
