// The documents say what the board now keeps and shows of a run's coverage,
// file by file, and the tests of that feature name no change request.
//
// Facts are pinned, never whole sentences:
//  - the changelog, in whichever release section records it, names the read
//    of a run's files (`?depth=coverage`) and the two keys the ingest answer
//    gains (`coverageFileCount`, `coverageFiles`);
//  - the product document names the per-file list in its run schema table, the
//    same read, the two keys beside what `/runs` adds to its answer, and the
//    file table;
//  - the runbook says a run's coverage files leave with the run by retention,
//    that the ingest answer names 10 of them and that the board's table opens
//    on 50.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntries, changelogText } from "../helpers/changelog-section.ts";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (...parts: string[]): string => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** The changelog's entries: the bodies of every release section. */
function recorded(): string {
  const entries = changelogEntries(changelogText());
  if (entries === "") throw new Error("coverage-file-table-docs: the changelog has no entries to read");
  return entries;
}

/** A document's blocks: its text cut at blank lines and at each list item. */
function blocksOf(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*[-*] )/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0);
}

/** The blocks of `text` that speak of coverage files. */
function blocksAboutCoverageFiles(text: string): string[] {
  return blocksOf(text).filter((block) => /coverage/i.test(block) && /\bfiles?\b/i.test(block));
}

describe("the changelog's unreleased section states the per-file coverage", () => {
  test("it names the read of a run's coverage files", () => {
    expect(recorded()).toContain("?depth=coverage");
  });

  test("it names the two keys the ingest answer gains", () => {
    expect(recorded()).toContain("coverageFileCount");
    expect(recorded()).toContain("coverageFiles");
  });

  test("it says the board keeps a run's coverage file by file and shows it", () => {
    const blocks = blocksAboutCoverageFiles(recorded()).filter(
      (block) => /\bkeeps?\b|\bkept\b|\bstores?\b|\bstored\b/i.test(block) && /\bshows?\b|\bshown\b|\blists?\b|\blisted\b|\btable\b/i.test(block),
    );
    expect(blocks.length, "an entry of the changelog saying coverage files are kept and shown").toBeGreaterThanOrEqual(1);
  });
});

describe("the product document states the per-file coverage", () => {
  const prd = (): string => read("docs", "research", "PRD-crucible-v2.md");

  test("its run schema table names the per-file list", () => {
    const rows = prd()
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"));
    const coverageRow = rows.filter((line) => line.trimStart().startsWith("| `coverage` |"));
    expect(coverageRow, "the run schema's coverage row").toHaveLength(1);
    // The list is named in the coverage row itself, or in a row of its own.
    const naming = rows.filter(
      (line) => line.includes("coverageFiles") || (line === coverageRow[0] && /\bfiles?\b/i.test(line)),
    );
    expect(naming.length, "a run schema row naming the per-file list").toBeGreaterThanOrEqual(1);
  });

  test("it names the read of a run's coverage files", () => {
    expect(prd()).toContain("?depth=coverage");
  });

  test("where it says what /runs adds to its answer, it names the two keys", () => {
    const blocks = blocksOf(prd()).filter(
      (block) => block.includes("/runs") && block.includes("coverageFileCount") && block.includes("coverageFiles"),
    );
    expect(blocks.length, "a block naming /runs, coverageFileCount and coverageFiles").toBeGreaterThanOrEqual(1);
  });

  test("its coverage codecs text says what a file is for each codec", () => {
    const blocks = blocksOf(prd()).filter(
      (block) => /lcov/.test(block) && /jacoco/.test(block) && /go-coverprofile/.test(block),
    );
    // What differs between them is what the page has to say: a JaCoCo report
    // names a class and no source file.
    const naming = blocks.filter((block) => /\bfiles?\b/i.test(block) && /\bclass(es)?\b/i.test(block));
    expect(naming.length, "a block on the three coverage codecs saying what a file is, the class included").toBeGreaterThanOrEqual(1);
  });

  test("it names the file table on the Coverage tab and on a run's page", () => {
    const blocks = blocksAboutCoverageFiles(prd());
    expect(blocks.filter((block) => /Coverage tab/.test(block)).length, "a block on coverage files naming the Coverage tab").toBeGreaterThanOrEqual(1);
    expect(
      blocks.filter((block) => /run's (own )?page|run page|run detail|drill-in/i.test(block)).length,
      "a block on coverage files naming the run's page",
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("the runbook states how a run's coverage files are kept", () => {
  const blocks = (): string[] => blocksAboutCoverageFiles(read("docs", "RUNBOOK.md"));

  test("it says the files leave with the run by retention", () => {
    const leaving = blocks().filter((block) => /retention/i.test(block) && /\bruns?\b/i.test(block));
    expect(leaving.length, "a block on coverage files naming retention and the run").toBeGreaterThanOrEqual(1);
  });

  test("it says the ingest answer names 10 files", () => {
    const naming = blocks().filter((block) => /\b10\b/.test(block) && /answer/i.test(block));
    expect(naming.length, "a block on coverage files stating the answer's 10").toBeGreaterThanOrEqual(1);
  });

  test("it says the board's table opens on 50 files", () => {
    const opening = blocks().filter((block) => /\b50\b/.test(block));
    expect(opening.length, "a block on coverage files stating the table's 50").toBeGreaterThanOrEqual(1);
  });
});

describe("the per-file coverage view's tests name no change request", () => {
  // Any project's change-request id, and the section mark a specification
  // cites its parts by.
  const CHANGE_REQUEST = /CR-[A-Z]{2,}-\d+|§/;

  /** The files this view's tests are written in, whole. */
  const WHOLE_FILES = [
    "tests/integration/coverage-file-table-docs.test.ts",
    "tests/integration/coverage-tab-lists-a-runs-files.test.ts",
    "tests/integration/run-page-folds-its-coverage-files.test.ts",
    "tests/helpers/coverage-files-view.ts",
    "tests/e2e/steps/coverage-file-table.steps.ts",
    "tests/e2e/features/coverage-file-table-keeps-a-long-names-end-in-view.feature",
  ];

  test("no file written for it carries a change-request id or a section mark", () => {
    const carrying = WHOLE_FILES.filter((file) => {
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} exists`).toBe(true);
      // This file's own pattern is the one place the shape is spelled, and it
      // is a pattern, not an id: the line that declares it is left out.
      const text = read(file)
        .split("\n")
        .filter((line) => !line.includes("const CHANGE_REQUEST ="))
        .join("\n");
      return CHANGE_REQUEST.test(text);
    });
    expect(carrying).toEqual([]);
  });

  test("its phone scenarios carry no change-request id or section mark", () => {
    const feature = read("tests", "e2e", "features", "mobile-viewport-responsive.feature");
    // A scenario runs from its title to the next one; the comment lines that
    // lead into the next scenario are that scenario's, not this one's.
    const scenarios = feature
      .split(/\n(?=\s*Scenario)/)
      .filter((block) => /^\s*Scenario[^\n]*coverage file/.test(block))
      .map((block) => block.replace(/(?:\n\s*(?:#[^\n]*)?)+$/, ""));
    expect(scenarios.length, "the phone feature holds this view's scenarios").toBe(3);
    expect(scenarios.filter((block) => CHANGE_REQUEST.test(block))).toEqual([]);
  });
});
