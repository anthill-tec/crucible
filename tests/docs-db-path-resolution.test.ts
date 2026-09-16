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
import { RETIRED_CONNECTION_ENV } from "./helpers/server-limits-fixture.ts";

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

  // RE-SUBJECTED 2026-09-17 by CR-CRU-139 C4 (§S4), not deleted. The rule this
  // test has always pinned is "the environment-variable table an operator
  // reads lists the variables the server really is configured by, and
  // `CRUCIBLE_DB` is one of them" (CR-CRU-043 §S4). That rule still holds; its
  // SUBJECT moved. It used to LOCATE the table by `CRUCIBLE_PORT` and require
  // `CRUCIBLE_PORT`/`CRUCIBLE_HOST` beside `CRUCIBLE_DB` — and since C1 the
  // server reads neither (`src/server.ts:158`), so the old form required the
  // RUNBOOK to keep documenting two dead knobs, and the C4 retirement guard
  // (tests/docs-runbook-documents-every-limit.test.ts) reports the very rows
  // it demanded as "presented as a configuration table row". Two guards
  // demanding opposite things about one line is why the re-subject happens in
  // the cycle that retires them rather than after it.
  //
  // The table is now located by `CRUCIBLE_DB` — this file's own subject, and a
  // variable that is still read (`src/server.ts:66`) — and its membership is
  // pinned in BOTH directions, which the old form never did: the two
  // environment-resolved survivors are present, and no retired connection
  // variable is.
  test("the environment-variable table lists the variables that are still read, and no retired one", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const table = extractTableContaining(runbook, "CRUCIBLE_DB");

    // §S3 — the two that genuinely precede configuration discovery: the store
    // path is how the server FINDS its file, the project key is identity.
    expect(table).toContain("CRUCIBLE_DB");
    expect(table).toContain("CRUCIBLE_PROJECT_KEY");

    // …and the connection is NOT an environment variable any more. Read off
    // the one shared retirement vocabulary rather than spelled here, so a
    // fifth retirement is covered by this guard the day it lands.
    const survivors = RETIRED_CONNECTION_ENV.filter((name) => table.includes(name));
    expect(
      survivors,
      `the RUNBOOK's environment-variable table still offers ${JSON.stringify(survivors)} as a ` +
        `way to configure the server. Nothing reads them: the listener is \`[server]\` in the ` +
        `server's own crucible.toml and the board is \`[client] url\` in the project's.`,
    ).toEqual([]);
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
