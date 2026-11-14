"""The changelog section being written, for the doc tests that check it.

The section being written is the changelog's topmost `## [` section:
`[Unreleased]` on `develop`, the release's own `## [X.Y.Z] - YYYY-MM-DD` on a
release branch and on `master`. Its body runs from the line after that
heading to the next `## [` heading or the first `[x]: ` link-definition line,
whichever comes first.
"""

import re

_SECTION_HEADING = "## ["
_LINK_DEFINITION = re.compile(r"^\[[^\]]+\]: ")

def changelog_section(text: str) -> str:
    """The body of the changelog's topmost `## [` section, its heading line
    excluded; `""` when the text has no such heading."""
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines)
                  if line.startswith(_SECTION_HEADING)), None)
    if start is None:
        return ""
    body = []
    for line in lines[start + 1:]:
        if line.startswith(_SECTION_HEADING) or _LINK_DEFINITION.match(line):
            break
        body.append(line)
    return "".join(body)
