// The changelog's release sections, for the doc tests that check them.
//
// A doc test asks the changelog one of two things, and each has its reader:
//  - `changelogEntries` — the bodies of every `## [` section, joined:
//    `[Unreleased]` and every dated `## [X.Y.Z] - YYYY-MM-DD` section. A check
//    that a feature IS recorded reads it, so it finds the feature wherever its
//    release sits, even once the next release's section is written above it.
//  - `changelogSection` — the section being written: the body of the topmost
//    `## [` section, `[Unreleased]` on `develop` and the release's own dated
//    section on a release branch and on `master`. A check that stale wording
//    is ABSENT reads it, so an old release's record of its day never fails it.
//
// A section's body runs from the line after its heading to the next `## [`
// heading. The link block after the last heading — the `[x]: `
// link-definition lines at the file's foot — belongs to no section; a
// link-definition line inside a section, with an entry after it, is that
// section's own line.
//
// `changelogText` is the changelog the doc tests read: the file named by
// `DOC_TESTS_CHANGELOG` when that variable is set, else the repo's
// CHANGELOG.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECTION_HEADING = "## [";
const LINK_DEFINITION = /^\[[^\]]+\]: /;
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Each `## [` section's body, topmost first, its heading line excluded and
// the link block at the foot left out.
function sectionBodies(text: string): string[] {
  const lines = text.split("\n");
  const headings = lines.flatMap((line, index) => (line.startsWith(SECTION_HEADING) ? [index] : []));
  if (headings.length === 0) return [];
  let foot = lines.length;
  for (let index = lines.length - 1; index > headings[headings.length - 1]!; index -= 1) {
    if (LINK_DEFINITION.test(lines[index]!)) foot = index;
    else if (lines[index]!.trim() !== "") break;
  }
  const ends = [...headings.slice(1), foot];
  return headings.map((start, at) => lines.slice(start + 1, ends[at]).join("\n"));
}

// The body of the changelog's topmost `## [` section, its heading line
// excluded; "" when the text has no such heading.
export function changelogSection(text: string): string {
  return sectionBodies(text)[0] ?? "";
}

// The bodies of every `## [` section of the changelog, joined, topmost first:
// the heading lines, the preamble above the first heading and the link block
// at the foot excluded; "" when the text has no such heading.
export function changelogEntries(text: string): string {
  return sectionBodies(text).join("\n");
}

// The changelog the doc tests read: the file named by `DOC_TESTS_CHANGELOG`
// when that variable is set, else the repo's CHANGELOG.md.
export function changelogText(): string {
  const named = process.env.DOC_TESTS_CHANGELOG;
  return readFileSync(named ? named : join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}
