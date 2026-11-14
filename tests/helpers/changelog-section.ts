// The changelog section being written, for the doc tests that check it.
//
// The section being written is the changelog's topmost `## [` section:
// `[Unreleased]` on `develop`, the release's own `## [X.Y.Z] - YYYY-MM-DD` on
// a release branch and on `master`. Its body runs from the line after that
// heading to the next `## [` heading or the first `[x]: ` link-definition
// line, whichever comes first.

const SECTION_HEADING = "## [";
const LINK_DEFINITION = /^\[[^\]]+\]: /;

// The body of the changelog's topmost `## [` section, its heading line
// excluded; "" when the text has no such heading.
export function changelogSection(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(SECTION_HEADING));
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith(SECTION_HEADING) || LINK_DEFINITION.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}
