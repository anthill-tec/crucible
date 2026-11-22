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

The README wraps its lines by hand, so a link's text or target may wrap onto
the next line, and so may an inline code span. The scan reads each paragraph
of prose as one block, line breaks kept, and reports each target at the line
where its match starts.

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
#: A code span; it may wrap across the lines of its paragraph.
INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1", re.DOTALL)

#: `[t](u)`, `[t](u "title")`, `[t](<u>)` and, with a leading `!`, images.
INLINE_LINK = re.compile(
    r"(!?)\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)"
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
#: `[label]: u`, up to three spaces of indent, at the start of any line.
REFERENCE_DEFINITION = re.compile(r"^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)", re.MULTILINE)
#: `href=` and `src=` in any quoting.
HTML_ATTRIBUTE = re.compile(r"""\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
                            re.IGNORECASE)
#: `<u>`: no space, no angle bracket inside.
ANGLE = re.compile(r"<([^<>\s]+)>")
HTML_TAG = re.compile(r"^/?[A-Za-z][A-Za-z0-9-]*/?$")
EMAIL = re.compile(r"^[^@/\s]+@[^@/\s]+\.[^@/\s]+$")


def _blank_inline_code(block):
    """The block with each inline code span, a wrapped one included, blanked
    to spaces; its line breaks stay, so an offset still maps to its line."""
    return INLINE_CODE.sub(lambda span: re.sub(r"[^\n]", " ", span.group(0)), block)


def prose_blocks(text):
    """(first line number, block) for every paragraph of prose: a run of
    non-blank lines outside a fenced code block, joined with its line breaks,
    with its inline code spans blanked."""
    fence = None
    first, lines = 0, []

    def flush():
        if lines:
            yield first, _blank_inline_code("\n".join(lines))
            lines.clear()

    for number, line in enumerate(text.splitlines(), start=1):
        opened = FENCE.match(line)
        if fence is None and opened:
            yield from flush()
            fence = opened.group(1)
            continue
        if fence is not None:
            closing = FENCE.match(line)
            if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= len(fence) \
                    and not line.strip()[len(closing.group(1)):].strip():
                fence = None
            continue
        if not line.strip():
            yield from flush()
            continue
        if not lines:
            first = number
        lines.append(line)
    yield from flush()


def link_targets(text):
    """(line number, form, target) for every link target in the markdown's
    prose, in every form the README may use, a wrapped link included. The
    line number is the line the link starts on."""
    found = []
    for first, block in prose_blocks(text):
        def line_of(match, first=first, block=block):
            return first + block.count("\n", 0, match.start())

        for match in INLINE_LINK.finditer(block):
            form = "image" if match.group(1) else "inline link"
            found.append((line_of(match), form, match.group(2).strip("<>")))
        for match in REFERENCE_DEFINITION.finditer(block):
            found.append((line_of(match), "reference definition", match.group(1).strip("<>")))
        for match in HTML_ATTRIBUTE.finditer(block):
            value = next(v for v in match.group(2, 3, 4) if v is not None)
            found.append((line_of(match), f"HTML {match.group(1).lower()}=", value))
        for match in ANGLE.finditer(block):
            inner = match.group(1)
            if HTML_TAG.match(inner) or EMAIL.match(inner) or "=" in inner:
                continue
            found.append((line_of(match), "autolink", inner))
    return sorted(found, key=lambda item: item[0])


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

    def test_the_scan_reads_wrapped_links_and_skips_code(self):
        text = ("Read [the\n"
                "runbook](docs/RUNBOOK.md) first.\n"
                "\n"
                "See [the guide](\n"
                "  docs/GUIDE.md) too.\n"
                "\n"
                "```sh\n"
                "[fenced](docs/FENCED.md)\n"
                "```\n"
                "\n"
                "A span `wraps [code\n"
                "](docs/CODE.md)` here.\n")
        self.assertEqual(
            link_targets(text),
            [(1, "inline link", "docs/RUNBOOK.md"),
             (4, "inline link", "docs/GUIDE.md")],
            "a link whose text or target wraps is found on the line it starts on; "
            "a link in a fenced block or in a wrapped inline code span is skipped")


if __name__ == "__main__":
    unittest.main()
