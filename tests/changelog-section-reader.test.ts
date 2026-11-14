// The changelog-section reader answers the section being written: the
// changelog's topmost `## [...]` section, whatever its label.
//  - On `develop` the topmost section is `## [Unreleased]`; on a release
//    branch and on `master` it is the release's own `## [X.Y.Z] - YYYY-MM-DD`.
//    The reader answers that topmost section, never one below it.
//  - The section runs to the next `## [` heading, or to the link block at the
//    file's foot (`[0.4.0]: https://…`), whichever comes first.
//  - A `### Added` sub-heading belongs to the section it sits in.
//  - A changelog with no `## [` heading has no section: the reader answers an
//    empty string, so a doc test reading through it fails on its own
//    assertion.
// Proved on small changelogs written here, never on the repo's CHANGELOG.md.
import { describe, expect, test } from "bun:test";
import { changelogSection } from "./helpers/changelog-section.ts";

const PREAMBLE = [
  "# Changelog",
  "",
  "All notable changes to this project are documented in this file.",
  "",
  "",
].join("\n");

const DEVELOP = PREAMBLE + [
  "## [Unreleased]",
  "",
  "- the unreleased entry names `alpha`",
  "",
  "## [0.3.0] - 2026-10-10",
  "",
  "- the released entry names `omega`",
  "",
].join("\n");

const RELEASE_BRANCH = PREAMBLE + [
  "## [0.4.0] - 2026-11-14",
  "",
  "- the release's entry names `alpha`",
  "",
  "## [0.3.0] - 2026-10-10",
  "",
  "- the older release's entry names `omega`",
  "",
].join("\n");

const LAST_SECTION_THEN_LINKS = PREAMBLE + [
  "## [0.4.0] - 2026-11-14",
  "",
  "- the only release's entry names `alpha`",
  "",
  "[0.4.0]: https://example.invalid/compare/v0.3.0...v0.4.0",
  "[0.3.0]: https://example.invalid/releases/tag/v0.3.0",
  "",
].join("\n");

const WITH_SUB_HEADINGS = PREAMBLE + [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- an added entry names `alpha`",
  "",
  "### Fixed",
  "",
  "- a fixed entry names `beta`",
  "",
  "## [0.3.0] - 2026-10-10",
  "",
  "### Added",
  "",
  "- an older added entry names `omega`",
  "",
].join("\n");

describe("the topmost section is the one being written", () => {
  test("an unreleased topmost section answers its body and nothing of the release below", () => {
    const section = changelogSection(DEVELOP);
    expect(section).toContain("- the unreleased entry names `alpha`");
    expect(section).not.toContain("omega");
    expect(section).not.toContain("## [0.3.0]");
    expect(section).not.toContain("All notable changes");
  });

  test("a dated release topmost with no unreleased answers that release's body", () => {
    const section = changelogSection(RELEASE_BRANCH);
    expect(section).toContain("- the release's entry names `alpha`");
    expect(section).not.toContain("omega");
    expect(section).not.toContain("## [0.3.0]");
    expect(section).not.toContain("All notable changes");
  });

  test("an empty unreleased topmost section never falls through to the release below", () => {
    const text = PREAMBLE + [
      "## [Unreleased]",
      "",
      "## [0.3.0] - 2026-10-10",
      "",
      "- the released entry names `omega`",
      "",
    ].join("\n");
    const section = changelogSection(text);
    expect(section).not.toContain("omega");
    expect(section).not.toContain("## [0.3.0]");
  });
});

describe("the section ends where it should", () => {
  test("the last section stops before the link block at the foot", () => {
    const section = changelogSection(LAST_SECTION_THEN_LINKS);
    expect(section).toContain("- the only release's entry names `alpha`");
    expect(section).not.toContain("[0.4.0]: https://");
    expect(section).not.toContain("[0.3.0]: https://");
    expect(section).not.toContain("example.invalid");
  });

  test("an unreleased section alone stops before the link block at the foot", () => {
    const text = PREAMBLE + [
      "## [Unreleased]",
      "",
      "- the unreleased entry names `alpha`",
      "",
      "[Unreleased]: https://example.invalid/compare/v0.3.0...HEAD",
      "",
    ].join("\n");
    const section = changelogSection(text);
    expect(section).toContain("- the unreleased entry names `alpha`");
    expect(section).not.toContain("example.invalid");
  });

  test("a sub-heading stays inside the section", () => {
    const section = changelogSection(WITH_SUB_HEADINGS);
    expect(section).toContain("### Added");
    expect(section).toContain("- an added entry names `alpha`");
    expect(section).toContain("### Fixed");
    expect(section).toContain("- a fixed entry names `beta`");
    expect(section).not.toContain("omega");
    expect(section.split("### Added").length - 1, "only the topmost section's own `### Added`").toBe(1);
  });
});

describe("no section answers empty", () => {
  test("a changelog with no release heading answers an empty string", () => {
    expect(changelogSection(PREAMBLE + "### Added\n\n- `alpha`\n")).toBe("");
  });

  test("an empty changelog answers an empty string", () => {
    expect(changelogSection("")).toBe("");
  });
});
