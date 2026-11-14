// The bun doc tests stay green across the next release: once a new
// `## [Unreleased]` is written above the release that records their features,
// holding none of its entries, every check that a feature IS recorded still
// finds it in the real entries below.
//
// The changelog these checks read is the repo's own CHANGELOG.md with this
// section written above its first release heading:
//
//     ## [Unreleased]
//
//     ### Added
//
//     - **A later feature.** Nothing from 0.4.0.
//
// Each doc test reads its changelog through `changelogText()` of
// tests/helpers/changelog-section.ts, which reads the file named by
// `DOC_TESTS_CHANGELOG` when that variable is set and the repo's CHANGELOG.md
// when it is not. The doc test is run whole, as it is written, by a child
// `bun test` with the variable pointed at the text; none of its checks is
// copied here.
//  - On a changelog that records nothing, exactly its RECORDED checks fail:
//    each one reads the changelog it is pointed at, and every check that
//    reads the changelog is classified.
//  - On the next release's changelog, every RECORDED check passes.
// The classification, check by check, is RECORDED below and in
// tests/client/changelog_check_kinds.py; no bun doc test has an ABSENT check.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./helpers/changelog-section.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_CHANGELOG = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");

/** The variable naming the changelog file the doc tests read. */
const SEAM = "DOC_TESTS_CHANGELOG";

const LATER_FEATURE = "- **A later feature.** Nothing from 0.4.0.";
const LATER_RELEASE = ["## [Unreleased]", "", "### Added", "", LATER_FEATURE, "", ""].join("\n");

/** A changelog with no release section at all. */
const RECORDS_NOTHING = "# Changelog\n";

/** Each bun doc test's RECORDED checks, as `innermost describe › test title`. */
const RECORDED: Record<string, string[]> = {
  "docs-describe-lint-records": [
    "the CHANGELOG records lint records › its Unreleased section has an entry naming lint records",
  ],
  "coverage-file-table-docs": [
    "the changelog's unreleased section states the per-file coverage › it names the read of a run's coverage files",
    "the changelog's unreleased section states the per-file coverage › it names the two keys the ingest answer gains",
    "the changelog's unreleased section states the per-file coverage › it says the board keeps a run's coverage file by file and shows it",
  ],
  "coverage-outside-the-runs-tree-docs": [
    "the documents say a run's coverage keeps only the files inside its tree › the changelog's unreleased section says a coverage file outside the run's tree is not kept",
    "the passages the rule is written into are there to be read › the changelog has an unreleased section that speaks of coverage files",
  ],
  "release-flow-names-the-release-notes-verb": [
    "the CHANGELOG's unreleased section says what the release-notes verb does › an unreleased entry names release-notes, --format markdown and --date, and says each line carries a title and an id",
    "the CHANGELOG's unreleased section says what the release-notes verb does › the changelog has an unreleased section with entries to read",
  ],
};

/** The real changelog with the next release's `[Unreleased]` on top. */
function theNextRelease(): string {
  const lines = REAL_CHANGELOG.split("\n");
  const at = lines.findIndex((line) => line.startsWith("## ["));
  return [...lines.slice(0, at), ...LATER_RELEASE.split("\n").slice(0, -1), ...lines.slice(at)].join("\n");
}

const decodeXmlOnce = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** A classname's escaping depth differs between runners: decode to a fixpoint. */
function decodeXml(value: string): string {
  let decoded = value;
  let next = decodeXmlOnce(decoded);
  while (next !== decoded) {
    decoded = next;
    next = decodeXmlOnce(decoded);
  }
  return decoded;
}

interface ChildRun {
  exitCode: number | null;
  ran: string[];
  failed: string[];
  stderrTail: string;
}

/** Runs one doc test whole in a child `bun test`, its changelog pointed at `text`. */
function runDocTest(stem: string, text: string): ChildRun {
  const scratch = mkdtempSync(join(tmpdir(), "doc-tests-next-release-"));
  try {
    const changelog = join(scratch, "CHANGELOG.md");
    const report = join(scratch, "report.junit.xml");
    writeFileSync(changelog, text);
    const child = Bun.spawnSync({
      cmd: ["bun", "test", "--reporter=junit", "--reporter-outfile", report, join(REPO_ROOT, "tests", `${stem}.test.ts`)],
      cwd: REPO_ROOT,
      env: { ...process.env, [SEAM]: changelog },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 100_000,
    });
    let xml = "";
    try {
      xml = readFileSync(report, "utf8");
    } catch {
      xml = "";
    }
    const ran: string[] = [];
    const failed: string[] = [];
    for (const [, attrs = "", , body = ""] of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = decodeXmlOnce(/(?:^|\s)name="([^"]*)"/.exec(attrs)?.[1] ?? "");
      const describeName = decodeXml(/(?:^|\s)classname="([^"]*)"/.exec(attrs)?.[1] ?? "").split(" > ")[0]?.trim() ?? "";
      const key = `${describeName} › ${name}`;
      ran.push(key);
      if (/<(failure|error)\b/.test(body)) failed.push(key);
    }
    return {
      exitCode: child.exitCode,
      ran,
      failed,
      stderrTail: child.stderr.toString().trimEnd().split("\n").slice(-8).join("\n"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("the next release's changelog", () => {
  test("its section being written holds only the later feature", () => {
    expect(changelogSection(theNextRelease()).trim()).toBe(`### Added\n\n${LATER_FEATURE}`);
  });

  test("every real release sits whole below the later one", () => {
    const built = theNextRelease();
    const at = REAL_CHANGELOG.indexOf("\n## [") + 1;
    expect(built.endsWith(REAL_CHANGELOG.slice(at))).toBe(true);
    expect(built.split("## [Unreleased]").length - 1).toBe(1);
    expect(built.length).toBe(REAL_CHANGELOG.length + LATER_RELEASE.length);
  });
});

describe("the child run reads each doc test's report", () => {
  // On the real changelog of this branch every RECORDED check runs, under the
  // name classified above, and passes: the names this file waits for are the
  // names the child's report gives.
  test(
    "on the real changelog every recorded check of every bun doc test runs under its classified name and passes",
    () => {
      for (const [stem, recorded] of Object.entries(RECORDED)) {
        const real = runDocTest(stem, REAL_CHANGELOG);
        expect({ stem, notRun: recorded.filter((check) => !real.ran.includes(check)) }).toEqual({ stem, notRun: [] });
        expect({ stem, failed: real.failed }).toEqual({ stem, failed: [] });
      }
    },
    240_000,
  );
});

describe("every bun doc test finds its recorded features across the next release", () => {
  for (const [stem, recorded] of Object.entries(RECORDED)) {
    test(
      `${stem}: on a changelog recording nothing exactly its recorded checks fail, and on the next release's changelog every one passes`,
      () => {
        const nothing = runDocTest(stem, RECORDS_NOTHING);
        expect(nothing.ran.length, `${stem} ran in the child: ${nothing.stderrTail}`).toBeGreaterThan(0);
        expect(
          [...nothing.failed].sort(),
          `${stem}: on a changelog recording nothing, the checks that fail are exactly the RECORDED ones (read through ${SEAM})`,
        ).toEqual([...recorded].sort());

        const next = runDocTest(stem, theNextRelease());
        expect(recorded.filter((check) => !next.ran.includes(check)), `${stem}: every RECORDED check ran`).toEqual([]);
        expect(
          recorded.filter((check) => next.failed.includes(check)),
          `${stem}: a check that a feature is recorded fails once the next release's section is written above it`,
        ).toEqual([]);
      },
      240_000,
    );
  }
});
