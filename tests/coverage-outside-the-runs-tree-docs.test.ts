// The documents say that a run's coverage keeps only the files inside the
// run's tree, and the tests of that rule name no change request.
//
// Facts are pinned, never whole sentences. Each document is read at the
// passage that already speaks of a run's coverage files, and that passage
// must say that a file inside, or outside, the run's tree is what is kept, or
// is not:
//  - the changelog's unreleased section;
//  - the runbook, where it says how a run's coverage files are kept;
//  - the product document's section on the codec translation layer.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts: string[]): string => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** The changelog's `[Unreleased]` section: from its heading to the next release heading. */
function unreleased(): string {
  const changelog = read("CHANGELOG.md");
  const start = changelog.indexOf("## [Unreleased]");
  if (start === -1) throw new Error("CHANGELOG.md has no [Unreleased] section");
  const next = changelog.indexOf("\n## [", start + 1);
  return next === -1 ? changelog.slice(start) : changelog.slice(start, next);
}

/** The product document's section on the codec translation layer: from its heading to the next heading of its level. */
function codecTranslationLayer(): string {
  const prd = read("docs", "research", "PRD-crucible-v2.md");
  const heading = /^### [^\n]*codec translation layer[^\n]*$/m.exec(prd);
  if (heading === null) throw new Error("PRD-crucible-v2.md has no section on the codec translation layer");
  const from = heading.index + heading[0].length;
  const next = prd.slice(from).search(/^#{1,3} /m);
  return next === -1 ? prd.slice(from) : prd.slice(from, from + next);
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

/** A block places a file by the run's tree: inside it, outside it, or out of it. */
const BY_THE_RUNS_TREE = /\b(?:inside|outside|out of)\b(?:\s+\S+){0,4}?\s+tree\b/i;

/** The blocks of `text` on coverage files that say which side of the run's tree a kept file is on. */
function blocksOnFilesByTheTree(text: string): string[] {
  return blocksAboutCoverageFiles(text).filter((block) => BY_THE_RUNS_TREE.test(block));
}

describe("the documents say a run's coverage keeps only the files inside its tree", () => {
  test("the changelog's unreleased section says a coverage file outside the run's tree is not kept", () => {
    expect(
      blocksOnFilesByTheTree(unreleased()).length,
      "an unreleased entry on coverage files placing a file inside or outside the run's tree",
    ).toBeGreaterThanOrEqual(1);
  });

  test("the runbook, where it says how a run's coverage files are kept, says a file outside the run's tree is not kept", () => {
    expect(
      blocksOnFilesByTheTree(read("docs", "RUNBOOK.md")).length,
      "a runbook block on coverage files placing a file inside or outside the run's tree",
    ).toBeGreaterThanOrEqual(1);
  });

  test("the product document's codec translation layer says a coverage file outside the run's tree is not kept", () => {
    expect(
      blocksOnFilesByTheTree(codecTranslationLayer()).length,
      "a block of the codec translation layer on coverage files placing a file inside or outside the run's tree",
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("the passages the rule is written into are there to be read", () => {
  test("the changelog has an unreleased section that speaks of coverage files", () => {
    expect(blocksAboutCoverageFiles(unreleased()).length).toBeGreaterThanOrEqual(1);
  });

  test("the runbook speaks of how a run's coverage files are kept", () => {
    const kept = blocksAboutCoverageFiles(read("docs", "RUNBOOK.md")).filter((block) => /\bkeeps?\b|\bkept\b/i.test(block));
    expect(kept.length).toBeGreaterThanOrEqual(1);
  });

  test("the product document's codec translation layer names the three coverage codecs beside their files", () => {
    const naming = blocksAboutCoverageFiles(codecTranslationLayer()).filter(
      (block) => /lcov/.test(block) && /jacoco/.test(block) && /go-coverprofile/.test(block),
    );
    expect(naming.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the tests of the rule, and the decoder it is written in, name no change request", () => {
  // Any project's change-request id, and the section mark a specification
  // cites its parts by.
  const CHANGE_REQUEST = /CR-[A-Z]{2,}-\d+|\u00a7/;

  const FILES = [
    "tests/a-runs-coverage-keeps-only-the-files-inside-its-tree.test.ts",
    "tests/run-ingest-leaves-out-coverage-files-outside-the-runs-tree.test.ts",
    "tests/coverage-outside-the-runs-tree-docs.test.ts",
    "src/codecs/coverage.ts",
  ];

  test("no file carries a change-request id or a section mark", () => {
    const carrying = FILES.filter((file) => {
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} exists`).toBe(true);
      return CHANGE_REQUEST.test(read(file));
    });
    expect(carrying).toEqual([]);
  });
});
