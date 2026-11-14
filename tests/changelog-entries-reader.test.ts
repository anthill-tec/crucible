// The changelog-entries reader answers every release section's body, so a
// check that a feature IS recorded finds it wherever its release sits.
//  - The bodies of `[Unreleased]` and of every dated `## [X.Y.Z] - YYYY-MM-DD`
//    section are all answered, each with its sub-headings.
//  - The `## [` heading lines are not, and neither is the preamble above the
//    first heading.
//  - The link block at the file's foot, after the last heading, is not part of
//    any section.
//  - A link-definition line inside a section is that section's own line, and
//    what follows it in the section is answered too.
//  - A changelog with no `## [` heading answers an empty string, so a doc test
//    reading through it fails on its own assertion.
// Proved on small changelogs written here, never on the repo's CHANGELOG.md.
import { describe, expect, test } from "bun:test";
import { changelogEntries } from "./helpers/changelog-section.ts";

const PREAMBLE = [
  "# Changelog",
  "",
  "All notable changes to this project are documented in this file.",
  "",
  "",
].join("\n");

const LINK_BLOCK = [
  "[Unreleased]: https://example.invalid/compare/v0.4.0...HEAD",
  "[0.4.0]: https://example.invalid/compare/v0.3.0...v0.4.0",
  "[0.3.0]: https://example.invalid/releases/tag/v0.3.0",
  "",
].join("\n");

const UNRELEASED_ABOVE_TWO_RELEASES = PREAMBLE + [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- the unreleased entry names `alpha`",
  "",
  "## [0.4.0] - 2026-11-14",
  "",
  "### Added",
  "",
  "- the newer release's entry names `beta`",
  "",
  "## [0.3.0] - 2026-10-10",
  "",
  "### Fixed",
  "",
  "- the older release's entry names `omega`",
  "",
  "",
].join("\n") + LINK_BLOCK;

const count = (text: string, part: string): number => text.split(part).length - 1;

describe("every release section is answered", () => {
  test("the unreleased body and both dated bodies below it are all answered", () => {
    const entries = changelogEntries(UNRELEASED_ABOVE_TWO_RELEASES);
    expect(entries).toContain("- the unreleased entry names `alpha`");
    expect(entries).toContain("- the newer release's entry names `beta`");
    expect(entries).toContain("- the older release's entry names `omega`");
  });

  test("each section's sub-headings are kept", () => {
    const entries = changelogEntries(UNRELEASED_ABOVE_TWO_RELEASES);
    expect(count(entries, "### Added"), "the `### Added` of `[Unreleased]` and of `[0.4.0]`").toBe(2);
    expect(count(entries, "### Fixed"), "the `### Fixed` of `[0.3.0]`").toBe(1);
  });

  test("the heading lines and the preamble are not answered", () => {
    const entries = changelogEntries(UNRELEASED_ABOVE_TWO_RELEASES);
    expect(entries).not.toContain("## [");
    expect(entries).not.toContain("2026-11-14");
    expect(entries).not.toContain("2026-10-10");
    expect(entries).not.toContain("# Changelog");
    expect(entries).not.toContain("All notable changes");
  });
});

describe("the link block at the foot is not a section's", () => {
  test("the link block after the last heading is left out", () => {
    const entries = changelogEntries(UNRELEASED_ABOVE_TWO_RELEASES);
    expect(entries).toContain("- the older release's entry names `omega`");
    expect(entries).not.toContain("example.invalid");
    expect(entries).not.toContain("[0.3.0]: ");
    expect(entries).not.toContain("[Unreleased]: ");
  });

  test("a link definition inside a section stays in that section", () => {
    const text = PREAMBLE + [
      "## [Unreleased]",
      "",
      "- the unreleased entry cites [the guide][guide]",
      "",
      "[guide]: https://guide.invalid/unreleased",
      "",
      "- after the unreleased link, an entry names `alpha`",
      "",
      "## [0.3.0] - 2026-10-10",
      "",
      "- the release cites [its notes][notes]",
      "",
      "[notes]: https://notes.invalid/0.3.0",
      "",
      "- after the release's link, an entry names `omega`",
      "",
      "",
    ].join("\n") + LINK_BLOCK;
    const entries = changelogEntries(text);
    expect(entries).toContain("[guide]: https://guide.invalid/unreleased");
    expect(entries).toContain("- after the unreleased link, an entry names `alpha`");
    expect(entries, "a link line inside the last section is not the link block at the foot").toContain(
      "[notes]: https://notes.invalid/0.3.0",
    );
    expect(entries).toContain("- after the release's link, an entry names `omega`");
    expect(entries).not.toContain("example.invalid");
  });
});

describe("no section answers empty", () => {
  test("a changelog with no release heading answers an empty string", () => {
    expect(changelogEntries(PREAMBLE + "### Added\n\n- `alpha`\n")).toBe("");
  });

  test("an empty changelog answers an empty string", () => {
    expect(changelogEntries("")).toBe("");
  });
});
