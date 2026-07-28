// CR-CRU-043 C2 — §S4 RUNBOOK + §S5 PRD doc-contract tests (RED).
//
// Spec: docs/changes/CR-CRU-043-installed-db-path.md
//   §S4 RUNBOOK — docs/RUNBOOK.md "Database path" section must state the
//       §S3 resolution order (explicit opts.dbPath > CRUCIBLE_DB > an
//       existing ./data/crucible.db (adopt-only) > the $XDG_DATA_HOME /
//       ~/.local/share default), list CRUCIBLE_DB in the env-var table
//       alongside CRUCIBLE_PORT/CRUCIBLE_HOST, and drop the stale
//       "relative to the working directory" claim (currently RUNBOOK.md:40).
//   §S5 PRD — docs/research/PRD-crucible-v2.md §2 storage paragraph
//       (currently PRD-crucible-v2.md:68) must stop naming a bare
//       `data/crucible.db` as THE store location and instead convey the
//       resolution order, while preserving the embedded bun:sqlite / WAL /
//       no-DB-server rationale (a user-approved design-surface edit, not
//       only a defect fix — GREEN must amend the paragraph, not gut it).
//
// RED phase: neither doc has been touched yet on this branch — RUNBOOK.md
// still carries the stale CWD-relative sentence and has no CRUCIBLE_DB
// knob documented anywhere; the PRD still states the bare literal path.
// Every test below is expected to FAIL for one of those reasons.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// Slices out one `## Heading` section (up to but excluding the next `## `
// heading, or end of doc) so assertions target the real "Database path"
// section rather than the whole file.
function extractSection(md: string, heading: string): string {
  const idx = md.indexOf(heading);
  if (idx === -1) {
    throw new Error(`heading not found: ${heading}`);
  }
  const rest = md.slice(idx + heading.length);
  const nextHeadingOffset = rest.search(/\n##\s/);
  return heading + (nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset));
}

// Finds the contiguous markdown-table block (consecutive `|`-led lines)
// containing `marker`, regardless of which heading it lives under — robust
// to GREEN renaming/merging the "Port / bind configuration" section.
function extractTableContaining(md: string, marker: string): string {
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => l.trim().startsWith("|") && l.includes(marker));
  if (idx === -1) {
    throw new Error(`no table row containing "${marker}" found`);
  }
  let start = idx;
  while (start > 0 && lines[start - 1].trim().startsWith("|")) start--;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1].trim().startsWith("|")) end++;
  return lines.slice(start, end + 1).join("\n");
}

// Slices out the PRD §2 "Persistence" bullet paragraph (up to the next `## `
// heading — "## 3 Domain model").
function extractPersistenceParagraph(md: string): string {
  const idx = md.indexOf("Persistence (decided");
  if (idx === -1) {
    throw new Error('"Persistence (decided ...)" paragraph not found in PRD §2');
  }
  const rest = md.slice(idx);
  const nextHeadingOffset = rest.search(/\n##\s/);
  return nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset);
}

// ---------------------------------------------------------------------------
// §S4 — docs/RUNBOOK.md
// ---------------------------------------------------------------------------

describe("§S4 RUNBOOK — database path resolution order", () => {
  test("Database path section states the four-rule resolution order, highest priority first", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const section = extractSection(runbook, "## Database path");

    // rule 1 — explicit opts.dbPath wins over everything.
    expect(section).toMatch(/explicit[^\n]*(path|dbPath)|opts\.dbPath/i);
    // rule 2 — CRUCIBLE_DB env override.
    expect(section).toContain("CRUCIBLE_DB");
    // rule 3 — an *existing* ./data/crucible.db is adopted, not created.
    expect(section).toMatch(/existing[^\n]*data\/crucible\.db|data\/crucible\.db[^\n]*existing/i);
    // rule 4 — the $XDG_DATA_HOME / ~/.local/share default.
    expect(section).toContain("XDG_DATA_HOME");
    expect(section).toContain(".local/share");

    // The rules must appear in priority order (first match wins), not just
    // present anywhere in the section — a shuffled or unordered mention
    // would still fail the acceptance criterion's "resolution order" intent.
    const idxExplicit = section.search(/explicit/i);
    const idxCrucibleDb = section.indexOf("CRUCIBLE_DB");
    const idxExisting = section.search(/existing/i);
    const idxXdg = section.indexOf("XDG_DATA_HOME");
    expect(idxExplicit).toBeGreaterThanOrEqual(0);
    expect(idxCrucibleDb).toBeGreaterThan(idxExplicit);
    expect(idxExisting).toBeGreaterThan(idxCrucibleDb);
    expect(idxXdg).toBeGreaterThan(idxExisting);
  });

  test("no longer claims the db path is relative to the working directory", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));

    // Load-bearing negative: the stale CWD-relative claim (RUNBOOK.md:40)
    // must be gone — a doc that keeps this statement is worse than one that
    // never made it, since it actively misleads once the server no longer
    // behaves this way.
    expect(runbook).not.toMatch(/relative to the working dir(ectory)?\b/i);
    // Paired positive: the doc now documents the CRUCIBLE_DB override that
    // supersedes the old CWD-relative behaviour.
    expect(runbook).toContain("CRUCIBLE_DB");
  });

  test("environment-variable table lists CRUCIBLE_DB alongside CRUCIBLE_PORT and CRUCIBLE_HOST", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const table = extractTableContaining(runbook, "CRUCIBLE_PORT");

    expect(table).toContain("CRUCIBLE_PORT");
    expect(table).toContain("CRUCIBLE_HOST");
    expect(table).toContain("CRUCIBLE_DB");
  });
});

// ---------------------------------------------------------------------------
// §S5 — docs/research/PRD-crucible-v2.md (design surface, user-approved)
// ---------------------------------------------------------------------------

describe("§S5 PRD — §2 storage paragraph moves with the code", () => {
  test("no longer names a bare data/crucible.db as THE store location; conveys the resolution order instead", () => {
    const prd = readText(join("docs", "research", "PRD-crucible-v2.md"));
    const para = extractPersistenceParagraph(prd);

    // Negative: the exact stale literal parenthetical (PRD-crucible-v2.md:68)
    // is gone.
    expect(para).not.toMatch(/\(WAL mode,\s*`data\/crucible\.db`\)/);
    // Positive: the paragraph now conveys the §S3 resolution order / XDG
    // default rather than one hardcoded path.
    expect(para).toMatch(/CRUCIBLE_DB/);
    expect(para).toMatch(/XDG_DATA_HOME/);
    expect(para).toContain(".local/share");
  });

  test("preserves the embedded bun:sqlite / WAL / no-DB-server rationale after the edit", () => {
    const prd = readText(join("docs", "research", "PRD-crucible-v2.md"));
    const para = extractPersistenceParagraph(prd);

    // Same enabling edit as the previous test (guards against GREEN leaving
    // the stale literal untouched) —
    expect(para).not.toMatch(/\(WAL mode,\s*`data\/crucible\.db`\)/);
    // — but this test's real job is to make it impossible for GREEN to
    // silently gut the surrounding rationale while fixing the path: the
    // design intent (embedded SQLite, WAL mode, no DB server) must survive.
    expect(para).toContain("bun:sqlite");
    expect(para).toMatch(/\bWAL\b/);
    expect(para).toMatch(/no DB server/i);
  });
});
