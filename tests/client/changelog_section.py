"""The changelog's release sections, for the doc tests that check them.

A doc test asks the changelog one of two things, and each has its reader:

  * `changelog_entries` — the bodies of every `## [` section, joined:
    `[Unreleased]` and every dated `## [X.Y.Z] - YYYY-MM-DD` section. A check
    that a feature IS recorded reads it, so it finds the feature wherever its
    release sits, even once the next release's section is written above it.
  * `changelog_section` — the section being written: the body of the
    topmost `## [` section, `[Unreleased]` on `develop` and the release's own
    dated section on a release branch and on `master`. A check that stale
    wording is ABSENT reads it, so an old release's record of its day never
    fails it.

A section's body runs from the line after its heading to the next `## [`
heading. The link block after the last heading — the `[x]: ` link-definition
lines at the file's foot — belongs to no section; a link-definition line
inside a section, with an entry after it, is that section's own line.
"""

import re

_SECTION_HEADING = "## ["
_LINK_DEFINITION = re.compile(r"^\[[^\]]+\]: ")


def _section_bodies(text):
    """Each `## [` section's body, topmost first, its heading line excluded
    and the link block at the foot left out."""
    lines = text.splitlines(keepends=True)
    headings = [i for i, line in enumerate(lines) if line.startswith(_SECTION_HEADING)]
    if not headings:
        return []
    foot = len(lines)
    for index in range(len(lines) - 1, headings[-1], -1):
        if _LINK_DEFINITION.match(lines[index]):
            foot = index
        elif lines[index].strip():
            break
    ends = [*headings[1:], foot]
    return ["".join(lines[start + 1:end]) for start, end in zip(headings, ends, strict=True)]


def changelog_section(text: str) -> str:
    """The body of the changelog's topmost `## [` section, its heading line
    excluded; `""` when the text has no such heading."""
    bodies = _section_bodies(text)
    return bodies[0] if bodies else ""


def changelog_entries(text: str) -> str:
    """The bodies of every `## [` section of the changelog, joined, topmost
    first: the heading lines, the preamble above the first heading and the
    link block at the foot excluded; `""` when the text has no such
    heading."""
    return "".join(_section_bodies(text))
