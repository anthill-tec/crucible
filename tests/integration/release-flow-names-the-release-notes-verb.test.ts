// The release flow names the client verb that drafts a release's notes from
// the board, and the docs say what it does.
//
// The verb is `release-notes --release <label> --format markdown`: it prints a
// release's `## [<label>] - <YYYY-MM-DD>` section, each line a completed
// change request's title and id. The places that send an operator to write
// the notes name it as the way to start the section:
//  - RELEASING.md's "Write the release notes" step;
//  - the notes line of RELEASING.md's "Release at a glance" block;
//  - the changelog, in whichever release section records it, which names the
//    verb, its `--format markdown` and `--date`, and what each line carries.
// (The notes guard's refusal in scripts/release.sh names it too; that is
// driven for real beside the guard's other refusals, in
// tests/integration/release-notes-guard.test.ts.)
//
// Facts are pinned by containment of their fragments, never by whole
// sentences, and each passage is read whitespace-collapsed so a wrapped line
// still counts.
//
// Hygiene: the lines this branch adds under clients/, src/ and scripts/ —
// diffed from where it left `develop` — carry no change-request id, no section
// mark and no acceptance-criterion number; and neither does the shared module
// the verb lives in, nor this file.
import { describe, expect, test } from "bun:test";
import { CLIENT_SOURCE_DIR } from "../helpers/test-install.ts";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntries, changelogText } from "../helpers/changelog-section.ts";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (...parts: string[]): string => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** The verb's own name, never the `release-notes.sh` extractor beside release.sh. */
const VERB_NAME = /release-notes(?!\.sh)/;
/** The verb as the flow names it, and the format that makes it a changelog section. */
const DRAFT_VERB = "release-notes --release";
const DRAFT_FORMAT = "--format markdown";

/** `text` with every run of whitespace collapsed to one space. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The fragments `text` (whitespace-collapsed) is missing, of the verb and its markdown format. */
function missingDraftCommand(text: string): string[] {
  const flat = flatten(text);
  return [DRAFT_VERB, DRAFT_FORMAT].filter((fragment) => !flat.includes(fragment));
}

// ---------------------------------------------------------------------------
// RELEASING.md
// ---------------------------------------------------------------------------

/** A level-2 section of `doc`: from its `## <title>` heading to the next `## ` heading. */
function level2Section(doc: string, title: RegExp): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && title.test(l));
  if (start < 0) throw new Error(`RELEASING.md has no section headed ${title}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** A numbered step of "Cutting a release": from its `**N. Title` line to the next numbered step. */
function runbookStep(doc: string, title: RegExp): string {
  const lines = doc.split("\n");
  const stepLine = /^(?:\*\*|#+\s*)\d+\.\s/;
  const start = lines.findIndex((l) => stepLine.test(l) && title.test(l));
  if (start < 0) throw new Error(`RELEASING.md has no numbered step matching ${title}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (stepLine.test(lines[i]) || /^---\s*$/.test(lines[i]) || /^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The lines of the first fenced code block in `section`. */
function firstFencedBlock(section: string): string[] {
  const lines = section.split("\n");
  const open = lines.findIndex((l) => /^```/.test(l));
  if (open < 0) throw new Error("the section has no fenced code block");
  const close = lines.findIndex((l, i) => i > open && /^```/.test(l));
  if (close < 0) throw new Error("the section's fenced code block is never closed");
  return lines.slice(open + 1, close);
}

/**
 * The notes line of the "Release at a glance" block: from the block's first
 * line that speaks of the notes up to the `scripts/release.sh finish` line
 * that follows it, so a notes line wrapped onto a continuation still counts.
 */
function atAGlanceNotesLine(): string {
  const block = firstFencedBlock(level2Section(read("RELEASING.md"), /Release at a glance/i));
  const start = block.findIndex((l) => /notes/i.test(l));
  if (start < 0) throw new Error('the "Release at a glance" block has no line about the release notes');
  const finish = block.findIndex((l, i) => i > start && /^\s*scripts\/release\.sh\s+finish\b/.test(l));
  return block.slice(start, finish < 0 ? block.length : finish).join("\n");
}

describe("RELEASING.md names the release-notes verb where it sends the operator to write the notes", () => {
  test("the write-the-release-notes step names release-notes --release with --format markdown", () => {
    const step = runbookStep(read("RELEASING.md"), /release notes/i);
    expect(missingDraftCommand(step)).toEqual([]);
  });

  test("the notes line of the release-at-a-glance block names release-notes --release with --format markdown", () => {
    expect(missingDraftCommand(atAGlanceNotesLine())).toEqual([]);
  });

  test("the at-a-glance notes line sits before the finish command, so the draft comes before finish", () => {
    const block = firstFencedBlock(level2Section(read("RELEASING.md"), /Release at a glance/i));
    const notes = block.findIndex((l) => /notes/i.test(l));
    const finish = block.findIndex((l) => /^\s*scripts\/release\.sh\s+finish\b/.test(l));
    expect(notes).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(notes);
  });
});

// ---------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------

/** The changelog's entries: the bodies of every release section. */
function recorded(): string {
  const entries = changelogEntries(changelogText());
  if (entries === "") throw new Error("the changelog has no entries to read");
  return entries;
}

/** The section's entries: each top-level list item with its nested items and continuations, whitespace-collapsed. */
function entriesOf(section: string): string[] {
  return section
    .split(/\n(?=- )|\n(?=#)/)
    .map((entry) => flatten(entry).trim())
    .filter((entry) => entry.length > 0);
}

/** What the changelog entry on the verb must say, each by a stable fragment. */
const ENTRY_FACTS: ReadonlyArray<readonly [string, (entry: string) => boolean]> = [
  ["names the release-notes verb", (e) => VERB_NAME.test(e)],
  ["names --format markdown", (e) => e.includes(DRAFT_FORMAT)],
  ["names --date", (e) => e.includes("--date")],
  ["says a line carries a title", (e) => /\btitles?\b/i.test(e)],
  ["says a line carries an id", (e) => /\bids?\b/i.test(e)],
];

function missingFacts(entry: string): string[] {
  return ENTRY_FACTS.filter(([, holds]) => !holds(entry)).map(([fact]) => fact);
}

describe("the CHANGELOG's unreleased section says what the release-notes verb does", () => {
  test("an unreleased entry names release-notes, --format markdown and --date, and says each line carries a title and an id", () => {
    const entries = entriesOf(recorded()).filter((e) => VERB_NAME.test(e));
    // The entry closest to complete, so a failure lists only what it lacks.
    const best = entries
      .map((entry) => ({ entry, missing: missingFacts(entry) }))
      .sort((a, b) => a.missing.length - b.missing.length)[0];
    expect(best?.missing ?? ["no entry of the changelog names the release-notes verb"]).toEqual([]);
  });

  test("the changelog has an unreleased section with entries to read", () => {
    expect(entriesOf(recorded()).filter((e) => e.startsWith("- ")).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

/** A change-request id of any project, a section mark, or an acceptance-criterion number. */
const CITATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["change-request id", /CR-[A-Z]{2,}-\d+/],
  ["section mark", /\u00a7/],
  ["acceptance-criterion number", /\bAC-?\d+/],
];

/** Every citation in `text`, each as the token it is written as (a section mark with the part it marks). */
const CITATION_TOKEN = /CR-[A-Z]{2,}-\d+|\u00a7[\w./-]*|\bAC-?\d+[a-z]?/g;

/** The kinds of citation `text` carries. */
function citationsIn(text: string): string[] {
  return CITATIONS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

/**
 * The citations a unified diff ADDS, per file: a token counted on its `+`
 * lines more often than on its `-` lines. A line rewritten or rewrapped with
 * the citation it already carried adds nothing; a new one is reported as
 * `<file>: <token> (+n)`.
 */
function netAddedCitations(diff: string): string[] {
  const perFile = new Map<string, Map<string, number>>();
  let file = "";
  const bump = (token: string, by: number): void => {
    const counts = perFile.get(file) ?? new Map<string, number>();
    counts.set(token, (counts.get(token) ?? 0) + by);
    perFile.set(file, counts);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const sign = line.startsWith("+") ? 1 : line.startsWith("-") ? -1 : 0;
    if (sign === 0) continue;
    for (const token of line.slice(1).match(CITATION_TOKEN) ?? []) bump(token, sign);
  }
  const added: string[] = [];
  for (const [name, counts] of perFile) {
    for (const [token, net] of counts) if (net > 0) added.push(`${name}: ${token} (+${net})`);
  }
  return added;
}

function git(args: string[]): { stdout: string; exitCode: number; stderr: string } {
  const res = Bun.spawnSync({ cmd: ["git", ...args], cwd: REPO_ROOT });
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), exitCode: res.exitCode };
}

/**
 * Where this branch left `develop`: of the local branch and its remote-tracking
 * copy, the fork point nearest HEAD (a stale ref must not widen the branch's additions).
 */
function forkPoint(): string {
  let best: { base: string; ahead: number } | undefined;
  for (const ref of ["develop", "origin/develop"]) {
    const res = git(["merge-base", ref, "HEAD"]);
    if (res.exitCode !== 0) continue;
    const base = res.stdout.trim();
    const count = git(["rev-list", "--count", `${base}..HEAD`]);
    if (count.exitCode !== 0) continue;
    const ahead = Number(count.stdout.trim());
    if (best === undefined || ahead < best.ahead) best = { base, ahead };
  }
  if (best === undefined) throw new Error("neither develop nor origin/develop is reachable, so the branch's added lines cannot be read");
  return best.base;
}

// The client tree, named through the test install helper's client source
// constant: this file reads client source, it never builds its own path.
const CLIENT_TREE = path.relative(REPO_ROOT, CLIENT_SOURCE_DIR);
const CLASSIFIED_TREES = [CLIENT_TREE, "src", "scripts"];

/**
 * The working tree's diff under the classified trees since the fork point, in
 * unified form; a file not yet tracked is written in as added whole.
 */
function branchDiff(): string {
  const base = forkPoint();
  const diff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--", ...CLASSIFIED_TREES]);
  if (diff.exitCode !== 0) throw new Error(`git diff from ${base} failed: ${diff.stderr}`);
  const parts = [diff.stdout];
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...CLASSIFIED_TREES]);
  for (const file of untracked.stdout.split("\n").filter((f) => f.length > 0 && !f.includes("__pycache__"))) {
    parts.push(`+++ b/${file}\n${read(file).split("\n").map((l) => `+${l}`).join("\n")}`);
  }
  return parts.join("\n");
}

describe("what the branch adds under clients, src and scripts cites no change request", () => {
  test("the lines the branch adds under clients/, src/ and scripts/ add no change-request id, section mark or acceptance-criterion number", () => {
    expect(netAddedCitations(branchDiff())).toEqual([]);
  });

  test("a diff that rewraps a line with the citation it already carried adds no citation", () => {
    const rewrap = [
      "+++ b/clients/demo.py",
      `-    """\u00a7S4 — the refusal: ok:false, the error naming the bad`,
      "-    input.\"\"\"",
      `+    """\u00a7S4 — the refusal, under its own name: ok:false, the`,
      "+    error naming the bad input.\"\"\"",
    ].join("\n");
    expect(netAddedCitations(rewrap)).toEqual([]);
  });

  test("a diff that adds a comment citing a change request, a section and a criterion reports each, by file", () => {
    const added = [
      "+++ b/scripts/demo.sh",
      `+# the notes guard (${"CR"}-ABC-${12}, \u00a7S4, ${"AC"}${9})`,
      "+++ b/src/demo.ts",
      "+// nothing cited here",
    ].join("\n");
    expect(netAddedCitations(added)).toEqual([
      `scripts/demo.sh: ${"CR"}-ABC-${12} (+1)`,
      "scripts/demo.sh: \u00a7S4 (+1)",
      `scripts/demo.sh: ${"AC"}${9} (+1)`,
    ]);
  });

  test("the release-notes module and this file carry no change-request id, section mark or acceptance-criterion number", () => {
    const files = [path.join(CLIENT_TREE, "_crucible_release.py"), "tests/integration/release-flow-names-the-release-notes-verb.test.ts"];
    const carrying = files.filter((file) => {
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} exists`).toBe(true);
      return citationsIn(read(file)).length > 0;
    });
    expect(carrying).toEqual([]);
  });

  test("the citation patterns catch what they are for", () => {
    // Built from parts, so this file carries none of them itself.
    expect(citationsIn(`see ${"CR"}-ABC-${123}`)).toEqual(["change-request id"]);
    expect(citationsIn("per \u00a7S4")).toEqual(["section mark"]);
    expect(citationsIn(`as ${"AC"}${9} asks`)).toEqual(["acceptance-criterion number"]);
    expect(citationsIn("release-notes --release 0.4.0 --format markdown")).toEqual([]);
  });
});
