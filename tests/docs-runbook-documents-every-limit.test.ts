// CR-CRU-131 §S1b — `docs/RUNBOOK.md` documents every limit, and its figures
// are CHECKED against the shipped data rather than transcribed from it.
//
// ── Why a guard and not a proofread ───────────────────────────────────────
//
// Prose that drifts from the data it describes is how `src/hints.ts` came to
// omit `release` for a month (CR-CRU-130 §S5), and a docs table is the easiest
// place in this CR for that to recur: six limits, four documented fields each,
// two owning files, and nothing but a reader's attention between them. So
// nothing below is transcribed. Every name, description, recommendation and
// bound is READ, at test time, from the two shipped data files — the one
// beside the server's resolver and the one beside the clients' — and the
// RUNBOOK is measured against what they say. A seventh limit added to the data
// and not to the document fails here on the day it is added; a limit removed
// from the data and left in the document fails too, because the row COUNT is
// asserted as well as the names.
//
// ── The document shape this guard requires ────────────────────────────────
//
// One markdown table per OWNING FILE, in the RUNBOOK's existing operator-table
// convention (the `CRUCIBLE_PORT` environment table is the precedent):
//
//   ### … `src/crucible.toml` …        <- the heading, or the prose between it
//                                         and the table, cites EXACTLY ONE
//                                         shipped data file. That citation IS
//                                         the ownership statement, so no row
//                                         has to repeat it.
//   | Limit | Description | Recommended | Min | Max |
//   |---|---|---|---|---|
//   | `<name>` | <the shipped description, VERBATIM> | <recommended> | <min> | <max> |
//
// The FIRST column names the limit; the other columns are found BY HEADER
// NAME, so their order is the author's to choose. A figure cell may carry a
// gloss AFTER the number ("1800000 (30 minutes)"): the first integer in the
// cell is the documented figure.
//
// ── Non-vacuity: the parser has a CONTROL ─────────────────────────────────
//
// A docs guard's failure mode is finding nothing and passing everything. So
// the parser is exercised against a synthetic document built FROM the real
// declarations: one row correct in every field, one row with a deliberately
// wrong `min` and a paraphrased description, and one declared limit left out
// entirely — and the control asserts it reports exactly the second and the
// third and says nothing whatever about the first. The retired-variable scan
// carries the same shape (C2's precedent, tests/limits-have-no-environment-
// layer.ts), with one document presenting a retired name as live configuration
// and one recording it as retired.
//
// ── What is READ FROM CODE rather than believed ───────────────────────────
//
//   the kinds retention may evict   `RETENTION_DISPOSABLE_KINDS` (src/store.ts)
//   the kinds it may NOT            the `RunEvent.kind` union (src/types.ts)
//                                   MINUS the disposable set
//   the limit names                 the two shipped files, cross-checked
//                                   against `SERVER_LIMIT_NAMES` and the
//                                   clients' `CLIENT_LIMIT_NAMES`
//   the retired variables           `RETIRED_LIMIT_ENV` — the ONE list
//                                   (tests/helpers/server-limits-fixture.ts),
//                                   so a fourth retirement is one line there
//   the uncapped-fleet disclosure   `retentionDisclosure()`'s own words, taken
//                                   from a real call rather than quoted
//   which limits `--full` defeats   the shipped `description`s that say so
//
// That last one is a MEASURED correction. `--full` reaches
// `truncate_field_chars` (`truncate_field(value, full=…)`) and
// `roadmap_list_rows` (`truncate_rows(rows, full=…)`); it does NOT reach
// `error_detail_chars`, which is composed at warning time and takes no `full`
// argument at all (clients/_crucible_axi.py:1388). A document promising
// `--full` over all three would be wrong about the software, so the set is
// DERIVED from the descriptions and the false claim is forbidden.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Every document this file parses other than the RUNBOOK is a string built in
// memory; nothing is written anywhere. The only Store is ":memory:", opened
// solely so the boot disclosure can be OBSERVED rather than quoted, and
// `CRUCIBLE_DB` is pointed at a fresh OS tmpdir only so the config path
// resolves beside it — no database is opened there. `data/crucible.db` is
// never touched, `data/crucible.toml` is never read or written, and nothing
// here talks to the running board.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETENTION_DISPOSABLE_KINDS, Store } from "../src/store.ts";
import { retentionDisclosure } from "../src/server.ts";
import { SERVER_LIMIT_NAMES } from "../src/limits.ts";
import {
  RETIRED_LIMIT_ENV,
  restoreServerLimitsFixture,
  seedProject,
  serverConfigDir,
} from "./helpers/server-limits-fixture.ts";
import { REPO_ROOT, listFiles } from "./helpers/source-scan.ts";

afterEach(restoreServerLimitsFixture);

const RUNBOOK = "docs/RUNBOOK.md";
const CLIENT_MODULE = "clients/_crucible_axi.py";

/**
 * The two shipped declaration files, as PATHS — the only two things this file
 * names about the limits, and neither is a figure. Each ships beside the
 * resolver that reads it: `src/limits.ts` for the server's, `_crucible_axi.py`
 * for the clients'. Their CONTENTS are read, never assumed, and the guard
 * below proves the pair is complete by comparing the names they declare with
 * the two resolvers' own name lists.
 */
const SHIPPED_DATA = ["src/crucible.toml", "clients/crucible.toml"] as const;

const FIGURES = ["recommended", "min", "max"] as const;
type Figure = (typeof FIGURES)[number];

interface Declared {
  readonly name: string;
  /** The shipped file that DECLARES it — this limit's owner, by construction. */
  readonly file: string;
  readonly description: string;
  readonly recommended: number;
  readonly min: number;
  readonly max: number;
}

function text(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function figureOf(limit: Declared, field: Figure): number {
  return field === "recommended" ? limit.recommended : field === "min" ? limit.min : limit.max;
}

/** Every `[limits.<name>]` table in one shipped file, as data. */
function declarationsIn(file: string): Declared[] {
  const parsed = Bun.TOML.parse(text(file)) as { limits?: unknown };
  const tables = parsed.limits;
  if (typeof tables !== "object" || tables === null) {
    throw new Error(
      `CR-CRU-131 §S1b: ${file} declares no \`[limits.*]\` tables. It is one of the two files ` +
        `this guard measures the RUNBOOK against; with nothing in it every documentation ` +
        `assertion below would pass vacuously.`,
    );
  }
  return Object.entries(tables as Record<string, unknown>).map(([name, table]) => {
    const t = typeof table === "object" && table !== null ? (table as Record<string, unknown>) : {};
    const num = (field: Figure): number => {
      const raw = t[field];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(
          `CR-CRU-131 §S1b: ${file} declares no numeric \`${field}\` for \`${name}\`, so there is ` +
            `nothing for the RUNBOOK's figure to be checked against.`,
        );
      }
      return raw;
    };
    if (typeof t.description !== "string" || t.description === "") {
      throw new Error(
        `CR-CRU-131 §S1b: ${file} describes \`${name}\` with no sentence, so the documented ` +
          `description has no source to match.`,
      );
    }
    return {
      name,
      file,
      description: t.description,
      recommended: num("recommended"),
      min: num("min"),
      max: num("max"),
    };
  });
}

function declaredLimits(): Declared[] {
  return SHIPPED_DATA.flatMap(declarationsIn);
}

/**
 * The CLIENT's limit names, parsed out of the clients' own module — the same
 * trick tests/shipped-limits-ship-as-package-data.test.ts plays, for the same
 * reason: a second hand-maintained name list in a second language is the copy
 * this CR family has already been bitten by.
 */
function clientLimitNames(): string[] {
  const match = /CLIENT_LIMIT_NAMES\s*=\s*\(([^)]*)\)/.exec(text(CLIENT_MODULE));
  if (match === null) {
    throw new Error(
      `CR-CRU-131 §S1b: ${CLIENT_MODULE} no longer declares CLIENT_LIMIT_NAMES. It is the single ` +
        `list of the limits a CLIENT enforces; this guard reads it so the RUNBOOK's coverage is ` +
        `measured against the software rather than against a list typed into a test.`,
    );
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

// ── The RUNBOOK, as tables ─────────────────────────────────────────────────

interface DocRow {
  readonly limit: string;
  readonly line: number;
  readonly columns: readonly string[];
  readonly cells: Readonly<Record<string, string>>;
  /** The shipped data file the row's TABLE is introduced by, when exactly one is. */
  readonly owner: string | null;
}

interface LimitsTable {
  /** The heading line plus everything between it and the table — the table's introduction. */
  readonly context: string;
  readonly owner: string | null;
  readonly columns: readonly string[];
  readonly rows: readonly DocRow[];
  readonly line: number;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** A limit NAME as a document writes it — backticks and bold are typography. */
function bareName(cell: string): string {
  return cell.replace(/[`*]/g, "").trim();
}

/**
 * The documented figure in a cell: the FIRST integer, with digit-grouping
 * separators removed, so `1_800_000`, `1,800,000` and `1800000 (30 minutes)`
 * all read as the same number and a wrong one still reads as wrong.
 */
function firstInteger(cell: string): number | null {
  const grouped = cell.replace(/`/g, "").replace(/(\d)[_,](?=\d)/g, "$1");
  const match = /-?\d+/.exec(grouped);
  return match === null ? null : Number(match[0]);
}

function columnFor(columns: readonly string[], want: RegExp): string | null {
  return columns.find((column) => want.test(column)) ?? null;
}

/**
 * Every LIMITS table in a markdown document, with the file each is introduced
 * by. A table is a limits table when its header names all three figures — the
 * shape no other table in this document has.
 */
function limitsTables(md: string): LimitsTable[] {
  const lines = md.split("\n");
  const out: LimitsTable[] = [];
  let headingAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      headingAt = i;
      continue;
    }
    if (!lines[i]!.trimStart().startsWith("|")) continue;
    const start = i;
    let end = i;
    while (end < lines.length && lines[end]!.trimStart().startsWith("|")) end += 1;
    const block = lines.slice(start, end);
    i = end - 1;
    if (block.length < 3) continue;
    const columns = cellsOf(block[0]!).map((column) => column.toLowerCase());
    if (!FIGURES.every((figure) => columns.some((column) => column.includes(figure)))) continue;
    const context = lines.slice(headingAt, start).join("\n");
    const cited = SHIPPED_DATA.filter((file) => context.includes(file));
    const owner = cited.length === 1 ? cited[0]! : null;
    const rows: DocRow[] = [];
    for (let r = 1; r < block.length; r += 1) {
      const raw = block[r]!;
      if (/^[\s|:-]+$/.test(raw)) continue; // the header separator
      const cells = cellsOf(raw);
      if (cells.every((cell) => cell === "")) continue;
      const byColumn: Record<string, string> = {};
      columns.forEach((column, index) => {
        byColumn[column] = cells[index] ?? "";
      });
      rows.push({
        limit: bareName(cells[0] ?? ""),
        line: start + r + 1,
        columns,
        cells: byColumn,
        owner,
      });
    }
    out.push({ context, owner, columns, rows, line: start + 1 });
  }
  return out;
}

function allRows(tables: readonly LimitsTable[]): DocRow[] {
  return tables.flatMap((table) => [...table.rows]);
}

function rowsFor(tables: readonly LimitsTable[], name: string): DocRow[] {
  return allRows(tables).filter((row) => row.limit === name);
}

// ── The three reports: coverage, figures, descriptions, ownership ──────────

/** A limit with no row, a limit with two, and a row naming nothing declared. */
function coverageReport(tables: readonly LimitsTable[], declared: readonly Declared[]): string[] {
  const out: string[] = [];
  for (const limit of declared) {
    const rows = rowsFor(tables, limit.name);
    if (rows.length === 0) {
      out.push(`${limit.name}: no documented row (declared in ${limit.file})`);
    } else if (rows.length > 1) {
      out.push(
        `${limit.name}: ${String(rows.length)} documented rows (lines ` +
          `${rows.map((row) => String(row.line)).join(", ")}), expected exactly one`,
      );
    }
  }
  const names = new Set(declared.map((limit) => limit.name));
  for (const row of allRows(tables)) {
    if (!names.has(row.limit)) {
      out.push(
        `${row.limit}: documented at line ${String(row.line)} but declared by neither ` +
          `${SHIPPED_DATA.join(" nor ")}`,
      );
    }
  }
  return out;
}

function figureReport(tables: readonly LimitsTable[], declared: readonly Declared[]): string[] {
  const out: string[] = [];
  for (const limit of declared) {
    const rows = rowsFor(tables, limit.name);
    if (rows.length !== 1) {
      out.push(`${limit.name}: no documented row (declared in ${limit.file})`);
      continue;
    }
    const row = rows[0]!;
    for (const field of FIGURES) {
      const declaredValue = figureOf(limit, field);
      const column = columnFor(row.columns, new RegExp(field));
      if (column === null) {
        out.push(`${limit.name}.${field}: no \`${field}\` column; ${limit.file} declares ${String(declaredValue)}`);
        continue;
      }
      const documented = firstInteger(row.cells[column] ?? "");
      if (documented === null) {
        out.push(
          `${limit.name}.${field}: documents no figure (cell ` +
            `${JSON.stringify(row.cells[column] ?? "")}); ${limit.file} declares ${String(declaredValue)}`,
        );
      } else if (documented !== declaredValue) {
        out.push(
          `${limit.name}.${field}: documented as ${String(documented)}; ${limit.file} declares ` +
            `${String(declaredValue)}`,
        );
      }
    }
  }
  return out;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The documented description must be the limit's OWN — the same one-datum rule
 * as the figures. A paraphrase is named as a paraphrase rather than accepted
 * for being non-empty.
 */
function descriptionReport(tables: readonly LimitsTable[], declared: readonly Declared[]): string[] {
  const out: string[] = [];
  for (const limit of declared) {
    const rows = rowsFor(tables, limit.name);
    if (rows.length === 0) {
      // Reported here TOO, not delegated: a report that fell silent on an
      // undocumented limit would make this whole check pass on a document
      // that describes nothing, which is the vacuity a docs guard dies of.
      out.push(`${limit.name}: no documented row (declared in ${limit.file})`);
      continue;
    }
    if (rows.length > 1) continue; // coverageReport owns the duplicate
    const row = rows[0]!;
    const column = columnFor(row.columns, /description|meaning/);
    if (column === null) {
      out.push(`${limit.name}: no description column in its table`);
      continue;
    }
    const documented = collapse(row.cells[column] ?? "");
    const source = collapse(limit.description);
    if (documented === "") {
      out.push(`${limit.name}: documents no description; ${limit.file} describes it as ${JSON.stringify(source)}`);
    } else if (!documented.includes(source)) {
      out.push(
        `${limit.name}: PARAPHRASED — documented as ${JSON.stringify(documented)}; ${limit.file} ` +
          `describes it as ${JSON.stringify(source)}`,
      );
    }
  }
  return out;
}

/** Ownership is structural: a row sits under the table introduced by the file that declares it. */
function ownershipReport(tables: readonly LimitsTable[], declared: readonly Declared[]): string[] {
  const out: string[] = [];
  for (const limit of declared) {
    const rows = rowsFor(tables, limit.name);
    if (rows.length === 0) {
      // Same reason as descriptionReport: silence here is a pass on a document
      // that states no ownership at all.
      out.push(`${limit.name}: no documented row (declared in ${limit.file})`);
      continue;
    }
    if (rows.length > 1) continue; // coverageReport owns the duplicate
    const owner = rows[0]!.owner;
    if (owner === null) {
      out.push(
        `${limit.name}: its table names no owning file — the heading and the prose above it must ` +
          `cite exactly one of ${SHIPPED_DATA.join(" / ")}, and ${limit.file} declares this limit`,
      );
    } else if (owner !== limit.file) {
      out.push(`${limit.name}: documented as owned by ${owner}; ${limit.file} declares it`);
    }
  }
  return out;
}

function report(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join("\n");
}

// ── Prose scanners ─────────────────────────────────────────────────────────

/**
 * The document's PROSE as sentences, tables excluded — the figures live in the
 * tables and are checked there, so a scanner that read them too would report a
 * row of numbers as a claim.
 */
function sentencesOf(md: string): string[] {
  return md
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("|"))
    .join("\n")
    .split(/\n\s*\n|(?<=[.;:])\s+/)
    .map(collapse)
    .filter((sentence) => sentence.length > 0);
}

/** A sentence that DENIES something is not a claim of it. */
const DENIAL = /never|not |no longer|cannot|neither|nor |exempt|immune|surviv|unreachable|record|own table|out of reach/i;

/**
 * Sentences claiming `subject` of a name — the name, one of the claim words,
 * and no denial. The shape both the retention-kinds check and the `--full`
 * check need, so they cannot drift into two scanners.
 */
function claimsAbout(sentences: readonly string[], name: string, claim: RegExp): string[] {
  return sentences.filter(
    (sentence) => sentence.includes(name) && claim.test(sentence) && !DENIAL.test(sentence),
  );
}

/**
 * Sentences that SAY SOMETHING about a name, denial or not — what the positive
 * half needs. `test` and `compile` are documented as folded "before deletion,
 * so their aggregate contribution survives pruning", which is retention
 * governing them and is stated with a word the denial filter (rightly) treats
 * as a denial. The two halves therefore ask different questions and use
 * different scanners.
 */
function mentionsAbout(sentences: readonly string[], name: string, claim: RegExp): string[] {
  return sentences.filter((sentence) => sentence.includes(name) && claim.test(sentence));
}

/**
 * A retired variable presented as LIVE configuration: a row in one of the
 * document's tables, or a shell example assigning it. Being mentioned as
 * retired is REQUIRED; being shown as usable is the defect.
 */
function liveConfigurationOffenders(md: string, names: readonly string[]): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  lines.forEach((line, index) => {
    for (const name of names) {
      if (!line.includes(name)) continue;
      if (line.trimStart().startsWith("|")) {
        out.push(`${name}: presented as a configuration table row at line ${String(index + 1)}`);
      } else if (new RegExp(`(^|[\\s"'\`])(export\\s+)?${name}=`).test(line)) {
        out.push(`${name}: shown being SET at line ${String(index + 1)} — ${collapse(line)}`);
      }
    }
  });
  return out;
}

/** A retired variable the document never records as retired. */
function retirementReport(md: string, names: readonly string[]): string[] {
  const sentences = sentencesOf(md);
  const out: string[] = [];
  for (const name of names) {
    const mentions = sentences.filter((sentence) => sentence.includes(name));
    if (mentions.length === 0) {
      out.push(`$${name}: not mentioned at all — an operator who learned it from the source is never told it is gone`);
      continue;
    }
    if (!mentions.some((sentence) => /retired|no longer|removed|gone/i.test(sentence))) {
      out.push(
        `$${name}: mentioned but never recorded as RETIRED — ${JSON.stringify(mentions[0]!.slice(0, 120))}`,
      );
    }
  }
  return out;
}

/** The complete event-kind vocabulary, read off the store's own row type. */
function eventKinds(): string[] {
  const match = /interface RunEvent\b[\s\S]*?\bkind:\s*([^;]+);/.exec(text("src/types.ts"));
  if (match === null) {
    throw new Error(
      "CR-CRU-131 §S1b: src/types.ts no longer declares the `RunEvent.kind` union. The kinds " +
        "retention may NOT evict are computed as that union minus the disposable set, so without " +
        "it the stale-kind-list check would have nothing to be wrong about.",
    );
  }
  const kinds = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (kinds.length === 0) throw new Error("CR-CRU-131 §S1b: the `RunEvent.kind` union is empty.");
  return kinds;
}

// ═══════════════════════════════════════════════════════════════════════════
// The instruments, before anything is measured with them
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-131 §S1b — the guard's own instruments", () => {
  test(
    "GUARD — the limits are read from the two shipped files and the pair is COMPLETE: the names " +
      "they declare are exactly the names the server's and the clients' resolvers enforce",
    () => {
      const declared = declaredLimits();
      expect(declared.length).toBeGreaterThan(0);
      const fromData = declared.map((limit) => limit.name).sort();
      const fromSeams = [...SERVER_LIMIT_NAMES, ...clientLimitNames()].sort();
      expect(fromData).toEqual(fromSeams);
      // …and each file declares the limits ITS OWN process enforces, which is
      // what makes "which file owns it" derivable instead of a mapping typed
      // into this test.
      const serverDeclared = declared.filter((limit) => limit.file === SHIPPED_DATA[0]);
      const clientDeclared = declared.filter((limit) => limit.file === SHIPPED_DATA[1]);
      expect(serverDeclared.map((limit) => limit.name).sort()).toEqual([...SERVER_LIMIT_NAMES].sort());
      expect(clientDeclared.map((limit) => limit.name).sort()).toEqual(clientLimitNames().sort());
    },
  );

  test(
    "CONTROL — the parser reads a figure that IS present and correct, REJECTS a deliberately " +
      "wrong one naming the limit and the field, catches a paraphrased description, and reports " +
      "an undocumented limit as missing",
    () => {
      const declared = declaredLimits();
      const correct = declared[0]!;
      const wrong = declared[1]!;
      const absent = declared[2]!;
      expect([correct.file, wrong.file, absent.file]).toEqual([correct.file, correct.file, correct.file]);

      const synthetic = [
        `### Limits declared in \`${correct.file}\``,
        "",
        "| Limit | Description | Recommended | Min | Max |",
        "|---|---|---|---|---|",
        `| \`${correct.name}\` | ${correct.description} | ${String(correct.recommended)} | ${String(correct.min)} | ${String(correct.max)} |`,
        `| \`${wrong.name}\` | ${wrong.description.slice(0, 12)} | ${String(wrong.recommended)} | ${String(wrong.min + 1)} | ${String(wrong.max)} |`,
        "",
      ].join("\n");

      const tables = limitsTables(synthetic);
      expect(tables.length).toBe(1);
      expect(tables[0]!.owner).toBe(correct.file);
      expect(tables[0]!.rows.map((row) => row.limit)).toEqual([correct.name, wrong.name]);

      const figures = figureReport(tables, declared);
      // The correct row: nothing at all is said about it.
      expect(figures.filter((line) => line.startsWith(`${correct.name}.`))).toEqual([]);
      // The wrong one: caught, by limit and field, with both numbers.
      expect(figures.filter((line) => line.startsWith(`${wrong.name}.`))).toEqual([
        `${wrong.name}.min: documented as ${String(wrong.min + 1)}; ${wrong.file} declares ${String(wrong.min)}`,
      ]);
      // The absent one: reported MISSING rather than silently passing.
      expect(figures).toContain(`${absent.name}: no documented row (declared in ${absent.file})`);
      expect(coverageReport(tables, declared)).toContain(
        `${absent.name}: no documented row (declared in ${absent.file})`,
      );

      const descriptions = descriptionReport(tables, declared);
      expect(descriptions.filter((line) => line.startsWith(`${correct.name}:`))).toEqual([]);
      expect(descriptions.filter((line) => line.startsWith(`${wrong.name}:`)).length).toBe(1);
      expect(descriptions.find((line) => line.startsWith(`${wrong.name}:`))).toContain("PARAPHRASED");

      // Ownership: the row's owner is the file the heading cites, and a table
      // introduced by the OTHER file would misplace the same row.
      expect(ownershipReport(tables, declared).filter((line) => line.startsWith(`${correct.name}:`))).toEqual([]);
      const misplaced = limitsTables(synthetic.replace(correct.file, SHIPPED_DATA[1]));
      expect(ownershipReport(misplaced, declared)).toContain(
        `${correct.name}: documented as owned by ${SHIPPED_DATA[1]}; ${correct.file} declares it`,
      );
    },
  );

  test(
    "CONTROL — the retired-variable scan catches a name presented as live configuration (a table " +
      "row, a shell example) and passes a name recorded as retired",
    () => {
      const name = RETIRED_LIMIT_ENV[0]!;
      const live = [
        "## Environment variables",
        "",
        "| Env var | Default | Meaning |",
        "|---------|---------|---------|",
        `| \`${name}\` | \`100\` | events kept per project |`,
        "",
        "```sh",
        `${name}=5000 crucible-axi serve`,
        "```",
      ].join("\n");
      const offenders = liveConfigurationOffenders(live, RETIRED_LIMIT_ENV);
      expect(offenders.length).toBe(2);
      expect(offenders[0]).toContain("configuration table row");
      expect(offenders[1]).toContain("shown being SET");

      const recorded = [
        "## Limits",
        "",
        ...RETIRED_LIMIT_ENV.map(
          (retired) =>
            `- \`$${retired}\` is RETIRED and no longer read; declare the limit in \`crucible.toml\` instead.`,
        ),
      ].join("\n");
      expect(liveConfigurationOffenders(recorded, RETIRED_LIMIT_ENV)).toEqual([]);
      expect(retirementReport(recorded, RETIRED_LIMIT_ENV)).toEqual([]);
      // …and a document that merely NAMES one without saying it is gone fails.
      expect(retirementReport(`Set \`${name}\` to bound the store.`, [name]).length).toBe(1);
      expect(retirementReport("Nothing here.", [name])[0]).toContain("not mentioned at all");
    },
  );

  test(
    "CONTROL — the claim scanner reports a kind said to flow through retention and spares one " +
      "said to be a record retention cannot reach",
    () => {
      const claimed = sentencesOf(
        "- all other kinds (`lifecycle`, `gate`, `milestone`, …) flow through retention but " +
          "contribute nothing to rollups — they are simply pruned.",
      );
      expect(claimsAbout(claimed, "gate", /retention|prun|evict|cap/i).length).toBe(1);
      const spared = sentencesOf(
        "Gates and milestones are records in tables of their own, so retention cannot reach them " +
          "and they are never pruned.",
      );
      expect(claimsAbout(spared, "gate", /retention|prun|evict|cap/i)).toEqual([]);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — the RUNBOOK, measured
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-131 §S1b — docs/RUNBOOK.md documents every limit", () => {
  test("every declared limit has exactly one documented row, and the document has no others", () => {
    const declared = declaredLimits();
    const tables = limitsTables(text(RUNBOOK));
    const offenders = coverageReport(tables, declared);
    expect(report(offenders)).toBe("");
    // The COUNT as well as the names: a limit deleted from the data and left
    // in the document is the same drift from the other direction.
    expect(allRows(tables).length).toBe(declared.length);
  });

  test("every documented recommended/min/max AGREES with the file that declares it", () => {
    const offenders = figureReport(limitsTables(text(RUNBOOK)), declaredLimits());
    expect(report(offenders)).toBe("");
  });

  test("every documented description is the limit's OWN, not a paraphrase of it", () => {
    const offenders = descriptionReport(limitsTables(text(RUNBOOK)), declaredLimits());
    expect(report(offenders)).toBe("");
  });

  test("every limit is documented under the file that OWNS it", () => {
    const offenders = ownershipReport(limitsTables(text(RUNBOOK)), declaredLimits());
    expect(report(offenders)).toBe("");
  });

  test(
    "the OWNERSHIP SPLIT is stated: the server's limits are configured beside its database, the " +
      "project's in the project directory, and the document says what to do when the board is on " +
      "another machine",
    () => {
      const declared = declaredLimits();
      const fileOf = (name: string): string => declared.find((limit) => limit.name === name)!.file;
      const serverFile = fileOf(SERVER_LIMIT_NAMES[0]!);
      const clientFile = fileOf(clientLimitNames()[0]!);
      const tables = limitsTables(text(RUNBOOK));
      const serverTable = tables.find((table) => table.owner === serverFile);
      const clientTable = tables.find((table) => table.owner === clientFile);
      expect(
        serverTable === undefined ? `no table introduced by ${serverFile}` : "found",
      ).toBe("found");
      expect(
        clientTable === undefined ? `no table introduced by ${clientFile}` : "found",
      ).toBe("found");
      // Each side sends the operator to ITS OWN location, and to no other: an
      // operator holding only the RUNBOOK must not go looking for a display
      // width on the server.
      expect(/database/i.test(serverTable!.context)).toBe(true);
      expect(/project director/i.test(clientTable!.context)).toBe(true);
      expect(/project director/i.test(serverTable!.context)).toBe(false);
      expect(/beside the (server'?s?( own)? )?database/i.test(clientTable!.context)).toBe(false);
      expect(/another machine|a different machine|separate machine|not on the same machine|remote host/i.test(text(RUNBOOK))).toBe(true);
    },
  );
});

describe("CR-CRU-131 §S1b — the retired variables are recorded as RETIRED", () => {
  test("every retired variable is named and told to be gone", () => {
    // The set comes from the ONE declaration (the fixture), so a fourth
    // retirement is covered by this document the day it lands.
    expect(RETIRED_LIMIT_ENV.length).toBeGreaterThan(0);
    expect(report(retirementReport(text(RUNBOOK), RETIRED_LIMIT_ENV))).toBe("");
  });

  test("and none of them is presented anywhere as live configuration", () => {
    expect(report(liveConfigurationOffenders(text(RUNBOOK), RETIRED_LIMIT_ENV))).toBe("");
  });
});

describe("CR-CRU-131 §S1b — the retention section describes the software that exists", () => {
  test("the constant and the fallback CR-CRU-129 deleted are gone from the document", () => {
    const md = collapse(text(RUNBOOK));
    expect(md).not.toContain("DEFAULT_RETENTION = 100");
    expect(md).not.toContain("retention ?? 100");
    // Derived, not remembered: the symbol is absent from the server's source,
    // so a document naming it documents something that does not exist.
    const inSource = listFiles("src", [".ts"]).filter((file) =>
      readFileSync(file, "utf8").includes("DEFAULT_RETENTION"),
    );
    expect(inSource).toEqual([]);
    expect(md).not.toContain("DEFAULT_RETENTION");
  });

  test(
    "the kinds retention governs are the store's disposable set, and no RECORD kind is claimed " +
      "to flow through it",
    () => {
      const md = text(RUNBOOK);
      const sentences = sentencesOf(md);
      const disposable = [...RETENTION_DISPOSABLE_KINDS];
      const records = eventKinds().filter((kind) => !RETENTION_DISPOSABLE_KINDS.has(kind));
      expect(disposable.length).toBeGreaterThan(0);
      expect(records.length).toBeGreaterThan(0);

      const undocumented = disposable.filter(
        (kind) => mentionsAbout(sentences, kind, /retention|prun|evict|cap/i).length === 0,
      );
      expect(report(undocumented.map((kind) => `${kind}: retention governs it, the document does not say so`))).toBe("");

      const misclaimed = records.flatMap((kind) =>
        claimsAbout(sentences, kind, /retention|prun|evict|cap/i).map(
          (sentence) => `${kind}: claimed to flow through retention — ${sentence.slice(0, 140)}`,
        ),
      );
      expect(report(misclaimed)).toBe("");
    },
  );
});

describe("CR-CRU-131 §S1b — the PRECEDENCE an operator has to know is documented", () => {
  test("a project's own `retention` overrides the fleet cap in the file", () => {
    const overrides = sentencesOf(text(RUNBOOK)).filter(
      (sentence) =>
        /retention/i.test(sentence) &&
        /crucible\.toml|\[limits\.retention\]/i.test(sentence) &&
        /override|wins|takes precedence|beats|ahead of/i.test(sentence),
    );
    expect(
      overrides.length === 0
        ? "the document nowhere states that a project's own `retention` beats the file's cap"
        : "stated",
    ).toBe("stated");
  });

  test("clearing a project's `retention` falls back to the file rather than to zero", () => {
    const clears = sentencesOf(text(RUNBOOK)).filter(
      (sentence) =>
        /retention/i.test(sentence) &&
        /null|clear/i.test(sentence) &&
        /fall|back to|reverts/i.test(sentence),
    );
    expect(
      clears.length === 0
        ? "the document nowhere states that clearing a project's `retention` falls back to the file"
        : "stated",
    ).toBe("stated");
  });

  test(
    "with no file there is NO cap, in the boot disclosure's own words, and the document says it " +
      "NAMES the uncapped projects",
    () => {
      // The instrument is the software's, not a phrase typed here: a scratch
      // config directory with no `crucible.toml`, a ":memory:" store, and one
      // project that declares no cap of its own.
      serverConfigDir();
      const store = new Store(":memory:");
      const uncapped = "runbook-uncapped-project";
      seedProject(store, uncapped);
      const disclosure = retentionDisclosure(store);
      expect(disclosure === null ? "no disclosure — the instrument is empty" : "disclosed").toBe(
        "disclosed",
      );
      expect(disclosure!).toContain(uncapped);
      const phrase = /WARNING:\s*(.+?)\s+for \d+ project/.exec(disclosure!)?.[1];
      expect(phrase === undefined ? disclosure! : phrase).not.toBe(disclosure!);

      const md = collapse(text(RUNBOOK)).toLowerCase();
      expect(md).toContain(phrase!.toLowerCase());
      expect(/nam(e|es|ing) (the |every |each )?(uncapped|unbounded)/i.test(collapse(text(RUNBOOK)))).toBe(true);
    },
  );

  test("`--full` is documented for the display limits it actually defeats, and for no others", () => {
    const declared = declaredLimits();
    // Which limits `--full` reaches is the DATA's statement, not this test's:
    // the shipped description of a limit `--full` defeats says so.
    const defeated = declared.filter((limit) => limit.description.includes("--full"));
    const untouched = declared.filter((limit) => !limit.description.includes("--full"));
    expect(defeated.length).toBeGreaterThan(0);
    expect(untouched.length).toBeGreaterThan(0);

    const sentences = sentencesOf(text(RUNBOOK)).filter((sentence) => sentence.includes("--full"));
    const missing = defeated.filter((limit) => !sentences.some((s) => s.includes(limit.name)));
    expect(
      report(missing.map((limit) => `${limit.name}: \`--full\` defeats it per invocation, the document does not say so`)),
    ).toBe("");

    const overclaimed = untouched.flatMap((limit) =>
      claimsAbout(sentences, limit.name, /--full/).map(
        (sentence) => `${limit.name}: \`--full\` does not reach it — ${sentence.slice(0, 140)}`,
      ),
    );
    expect(report(overclaimed)).toBe("");
  });
});
