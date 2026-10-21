// The release runbook (RELEASING.md) and `scripts/release.sh --help` name the
// preflight guards `finish` runs, in the order `cmd_finish` runs them.
//
// `finish X.Y.Z` runs, in order: the ceremony identity guard
// (`guard_agent_identity`), the release-notes guard (`guard_release_notes` —
// the version's committed, dated `## [X.Y.Z] - YYYY-MM-DD` section of
// CHANGELOG.md), then the manifest alignment (`align_manifest_version`), then
// the manifest and tag-prefix checks (`guard_manifest_version`,
// `guard_tag_prefix`). The documentation must say so:
//
//   - RELEASING.md's finish step carries a guard table naming identity, notes,
//     then the manifest / tag-prefix checks, each row with a failure and a
//     remedy; the notes row's remedy is writing + committing the dated
//     CHANGELOG.md section; the prose no longer counts "two" guards.
//   - RELEASING.md's release-notes step says `finish` refuses without them.
//   - No text in RELEASING.md still claims `finish`'s FIRST preflight is the
//     manifest check (the identity guard runs first now).
//   - `release.sh --help` (its `usage()`) and the script's header comment name
//     the notes guard and list the guards in the order `finish` runs them.
//
// ANTI-DRIFT: the expected order is DERIVED from `cmd_finish`'s source (the
// order of its `guard_*` / `align_manifest_version` calls), so the docs are
// compared with the code, not with a hand-written list that could rot.
//
// Assertions match stable TOKENS, never whole sentences, so a reworded but
// correct runbook still passes. But a guard must be NAMED, not merely
// MENTIONED: a guard table row is identified by its guard cell alone, and a
// --help / header clause by the guard's own name (identity, notes, manifest /
// align package.json, tag prefix), never by an incidental keyword such as
// CHANGELOG.md, --agent, $CRUCIBLE_AGENT or versiontag, which a row or clause
// can still carry after it has stopped naming its guard.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");
const RELEASING_MD = join(REPO_ROOT, "RELEASING.md");

type Category = "identity" | "notes" | "manifest" | "tagprefix";

// Each guard's NAME: the words that say which guard a row or clause is.
// Deliberately excludes the incidental vocabulary a guard's failure or remedy
// mentions (CHANGELOG.md, --agent, $CRUCIBLE_AGENT, gitflow.prefix.versiontag):
// mentioning the changelog does not name the notes guard. Matched against
// whitespace-collapsed text, so a name wrapped across lines still counts.
const GUARD_NAMES: Record<Category, RegExp> = {
  identity: /\bidentity\b/i,
  notes: /\bnotes\b/i,
  manifest: /\bmanifest\b|\balign\s+package\.json\b/i,
  tagprefix: /\btag[- ]prefix\b/i,
};

/** `text` with every run of whitespace collapsed to one space. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}
const ALL_CATEGORIES: Category[] = ["identity", "notes", "manifest", "tagprefix"];

// What each call in `cmd_finish` is a guard FOR. The alignment is the manifest
// step too: it and the manifest check sit together, between notes and tag
// prefix, so consecutive duplicates collapse.
const CALL_CATEGORY: Record<string, Category> = {
  guard_agent_identity: "identity",
  guard_release_notes: "notes",
  align_manifest_version: "manifest",
  guard_manifest_version: "manifest",
  guard_tag_prefix: "tagprefix",
};

function readReleasing(): string {
  return readFileSync(RELEASING_MD, "utf8");
}

function readReleaseSh(): string {
  return readFileSync(RELEASE_SH, "utf8");
}

function collapse<T>(xs: T[]): T[] {
  return xs.filter((x, i) => i === 0 || xs[i - 1] !== x);
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

function splitRow(line: string): string[] {
  const PIPE = "\u0000";
  return line
    .replace(/\\\|/g, PIPE)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.replaceAll(PIPE, "|").trim());
}

/** The body rows of the first markdown table in `section` whose header's first cell says "Guard". */
function guardTableRows(section: string): string[][] {
  const lines = section.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = splitRow(lines[i]);
    if (!/guard/i.test(header[0] ?? "")) continue;
    if (!/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      rows.push(splitRow(lines[j]));
    }
    return rows;
  }
  return [];
}

/** The guards a cell NAMES. */
function namedIn(cell: string): Category[] {
  const flat = flatten(cell);
  return ALL_CATEGORIES.filter((c) => GUARD_NAMES[c].test(flat));
}

/** A table row's guard: the ONE guard its guard cell names, never inferred from the failure or remedy cells. */
function rowCategory(row: string[]): Category | undefined {
  const hits = namedIn(row[0] ?? "");
  return hits.length === 1 ? hits[0] : undefined;
}

/** The guards `text` NAMES, ordered by their first naming; unnamed ones are omitted. */
function orderOfFirstMention(text: string): Category[] {
  const flat = flatten(text);
  return ALL_CATEGORIES.map((c) => ({ c, at: flat.search(GUARD_NAMES[c]) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.c);
}

/** The guard calls `cmd_finish` makes, in source order (comments ignored). */
function finishCallOrder(): string[] {
  const src = readReleaseSh();
  const start = src.indexOf("\ncmd_finish() {");
  if (start < 0) throw new Error("release.sh defines no cmd_finish()");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  const calls: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(guard_[A-Za-z0-9_]+|align_manifest_version)\b/);
    if (m) calls.push(m[1]);
  }
  return calls;
}

/** `cmd_finish`'s guard order as categories — throws on a call this file does not know. */
function finishCategoryOrder(): Category[] {
  const calls = finishCallOrder();
  if (calls.length === 0) throw new Error("cmd_finish makes no guard_* / align_manifest_version call");
  const unmapped = calls.filter((c) => !(c in CALL_CATEGORY));
  if (unmapped.length > 0) throw new Error(`cmd_finish calls an unmapped guard: ${unmapped.join(", ")}`);
  return collapse(calls.map((c) => CALL_CATEGORY[c]));
}

/** `release.sh --help`'s stdout, and its exit code. */
function runHelp(): { stdout: string; exitCode: number } {
  const res = Bun.spawnSync({ cmd: [RELEASE_SH, "--help"], cwd: REPO_ROOT });
  return { stdout: res.stdout.toString(), exitCode: res.exitCode };
}

/** The `finish <X.Y.Z>` entry of the help: from its line to the next subcommand entry. */
function helpFinishEntry(help: string): string {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => /^\s{2}finish\s+<X\.Y\.Z>/.test(l));
  if (start < 0) throw new Error("release.sh --help has no `finish <X.Y.Z>` entry");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The script header comment's `finish <X.Y.Z>` entry (the leading `#` block, before `set -euo`). */
function headerFinishEntry(): string {
  const src = readReleaseSh();
  const headerEnd = src.indexOf("\nset -euo pipefail");
  const header = src.slice(0, headerEnd < 0 ? src.length : headerEnd);
  const lines = header.split("\n").map((l) => l.replace(/^#\s?/, ""));
  const start = lines.findIndex((l) => /^\s{2}finish\s+<X\.Y\.Z>/.test(l));
  if (start < 0) throw new Error("release.sh's header comment has no `finish <X.Y.Z>` entry");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{2}[a-z]/.test(lines[i]) || /^\S/.test(lines[i]) || lines[i].trim() === "") {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("release runbook: finish's guard table", () => {
  test("the finish step's guard table lists identity, notes, then the manifest and tag-prefix checks", () => {
    const finish = runbookStep(readReleasing(), /\bFinish\b/);
    const rows = guardTableRows(finish);
    expect(rows.map(rowCategory)).toEqual(["identity", "notes", "manifest", "tagprefix"]);
  });

  test("every guard row in the finish step's table carries a failure and a remedy", () => {
    const rows = guardTableRows(runbookStep(readReleasing(), /\bFinish\b/));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.length).toBeGreaterThanOrEqual(3);
      expect(row[1]).toMatch(/\S/);
      expect(row[2]).toMatch(/\S/);
    }
  });

  test("each row's guard cell names exactly its own guard, so the notes row's guard cell names the notes guard", () => {
    const rows = guardTableRows(runbookStep(readReleasing(), /\bFinish\b/));
    expect(rows.map((r) => namedIn(r[0] ?? ""))).toEqual([["identity"], ["notes"], ["manifest"], ["tagprefix"]]);
  });

  test("the notes row's remedy is writing and committing the dated CHANGELOG.md section", () => {
    const rows = guardTableRows(runbookStep(readReleasing(), /\bFinish\b/));
    const notesRows = rows.filter((r) => rowCategory(r) === "notes");
    expect(notesRows.length).toBe(1);
    const remedy = notesRows[0][2] ?? "";
    expect(remedy).toContain("CHANGELOG.md");
    expect(remedy).toMatch(/##\s*\[X\.Y\.Z\]\s*-\s*YYYY-MM-DD/);
    expect(remedy).toMatch(/commit/i);
  });

  test("the runbook no longer counts two preflight guards", () => {
    const doc = readReleasing();
    expect(doc).not.toMatch(/\btwo\s+preflight\s+guards\b/i);
    expect(doc).not.toMatch(/\btwo\s+guards\b/i);
  });
});

describe("release runbook: the release-notes step", () => {
  test("the write-the-release-notes step says finish refuses a release whose notes are not committed and dated", () => {
    const step = runbookStep(readReleasing(), /release notes/i);
    const paragraphs = step.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " "));
    const saysFinishRefuses = paragraphs.filter(
      (p) =>
        /`?finish`?/.test(p) &&
        /\b(refus\w*|abort\w*|will not|won't|stops?)\b/i.test(p) &&
        /\bcommit\w*/i.test(p) &&
        /\b(dated|undated|date)\b|YYYY-MM-DD/i.test(p),
    );
    expect(saysFinishRefuses.length).toBeGreaterThanOrEqual(1);
  });
});

describe("release runbook: the first preflight is not the manifest check", () => {
  test("no sentence of the runbook calls the manifest check finish's first preflight", () => {
    const flat = readReleasing().replace(/\s+/g, " ");
    const sentences = flat.split(/(?<=[.!?])\s+/);
    const stale = sentences.filter(
      (s) => /\bfirst\s+(preflight|guard|check)\b/i.test(s) && /manifest|package\.json|set-version/i.test(s),
    );
    expect(stale).toEqual([]);
  });
});

describe("release.sh --help: the finish entry", () => {
  test("--help exits 0 and its finish entry names the notes guard", () => {
    const { stdout, exitCode } = runHelp();
    expect(exitCode).toBe(0);
    expect(namedIn(helpFinishEntry(stdout))).toContain("notes");
  });

  test("--help's finish entry names every guard by name, not merely by a keyword it mentions", () => {
    expect(namedIn(helpFinishEntry(runHelp().stdout))).toEqual(["identity", "notes", "manifest", "tagprefix"]);
  });

  test("--help's finish entry lists identity before notes before the manifest alignment before the tag prefix", () => {
    const entry = helpFinishEntry(runHelp().stdout);
    expect(orderOfFirstMention(entry)).toEqual(["identity", "notes", "manifest", "tagprefix"]);
  });
});

describe("release guard order: the docs match cmd_finish", () => {
  test("--help's finish entry presents the guards in cmd_finish's order", () => {
    const entry = helpFinishEntry(runHelp().stdout);
    expect(orderOfFirstMention(entry)).toEqual(finishCategoryOrder());
  });

  test("RELEASING.md's guard table presents the guards in cmd_finish's order", () => {
    const rows = guardTableRows(runbookStep(readReleasing(), /\bFinish\b/));
    expect(collapse(rows.map(rowCategory))).toEqual(finishCategoryOrder());
  });

  test("release.sh's header comment presents the finish guards in cmd_finish's order", () => {
    expect(orderOfFirstMention(headerFinishEntry())).toEqual(finishCategoryOrder());
  });
});
