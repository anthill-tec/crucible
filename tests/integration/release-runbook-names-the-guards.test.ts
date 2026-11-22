// `scripts/release.sh --help` names the preflight guards `finish` runs, in the
// order `cmd_finish` runs them.
//
// `finish X.Y.Z` runs, in order: the ceremony identity guard
// (`guard_agent_identity`), the release-notes guard (`guard_release_notes` —
// the version's committed, dated `## [X.Y.Z] - YYYY-MM-DD` section of
// CHANGELOG.md), then the manifest alignment (`align_manifest_version`), then
// the manifest and tag-prefix checks (`guard_manifest_version`,
// `guard_tag_prefix`). `release.sh --help` (its `usage()`) must name the notes
// guard and list the guards in the order `finish` runs them.
//
// ANTI-DRIFT: the expected order is DERIVED from `cmd_finish`'s source (the
// order of its `guard_*` / `align_manifest_version` calls), so the help is
// compared with the code, not with a hand-written list that could rot.
//
// Assertions match stable TOKENS, never whole sentences. But a guard must be
// NAMED, not merely MENTIONED: a --help clause names a guard by the guard's own
// name (identity, notes, manifest / align package.json, tag prefix), never by
// an incidental keyword such as CHANGELOG.md, --agent, $CRUCIBLE_AGENT or
// versiontag, which a clause can still carry after it has stopped naming its
// guard.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

type Category = "identity" | "notes" | "manifest" | "tagprefix";

// Each guard's NAME: the words that say which guard a clause is.
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

function readReleaseSh(): string {
  return readFileSync(RELEASE_SH, "utf8");
}

function collapse<T>(xs: T[]): T[] {
  return xs.filter((x, i) => i === 0 || xs[i - 1] !== x);
}

/** The guards a clause NAMES. */
function namedIn(cell: string): Category[] {
  const flat = flatten(cell);
  return ALL_CATEGORIES.filter((c) => GUARD_NAMES[c].test(flat));
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

describe("release guard order: the help matches cmd_finish", () => {
  test("--help's finish entry presents the guards in cmd_finish's order", () => {
    const entry = helpFinishEntry(runHelp().stdout);
    expect(orderOfFirstMention(entry)).toEqual(finishCategoryOrder());
  });
});
