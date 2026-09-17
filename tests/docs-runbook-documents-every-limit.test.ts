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
import { RETENTION_DISPOSABLE_KINDS, SCHEMA_VERSION, Store } from "../src/store.ts";
import { retentionDisclosure } from "../src/server.ts";
import { SERVER_LIMIT_NAMES } from "../src/limits.ts";
import {
  RETIRED_CONNECTION_ENV,
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

/**
 * The DECLARATION of the constant CR-CRU-129 deleted, matched by its GRAMMAR.
 *
 * This was `readFileSync(file).includes("DEFAULT_RETENTION")`, which tested
 * "the name never appears anywhere in `src`" — a different and strictly worse
 * claim than "the symbol is gone", and one the source refutes for the best
 * possible reason. `src/limits.ts:5`, `src/server.ts:301` and `src/types.ts:31`
 * each name the constant inside a sentence explaining that it was DELETED and
 * why (it was a number one author chose, reachable by nobody, and it evicted
 * every release this project had ever shipped). Prose recording a deletion is
 * EVIDENCE OF COMPLIANCE, not a violation of it — the distinction
 * tests/limits-have-no-environment-layer.test.ts:348-351 already draws for
 * `docs/`, and `src` differs from a document only in ADDITIONALLY containing
 * declarations. So the declaration is what is matched, and the lineage stays.
 * (Ruled 2026-09-14; the fifth proxy this CR retires.)
 */
const DELETED_CONSTANT = /\b(?:export\s+)?(?:const|let|var)\s+DEFAULT_RETENTION\b/;

/**
 * The deleted constant NAMED in prose — the document's half of the same rule.
 *
 * By WORD, because the two scans this file used to run could not tell one
 * symbol from another: `CRUCIBLE_DEFAULT_RETENTION` is a RETIRED environment
 * variable, a different thing entirely, and a substring scan for the constant
 * reads it as the constant. Since §S1b REQUIRES the document to name that
 * variable, the substring form was jointly unsatisfiable with the
 * retired-variables suite. `_` is a word character, so `\b` spares the variable
 * by GRAMMAR rather than by an exception list the next shared suffix reopens.
 */
const DELETED_CONSTANT_NAMED = /\bDEFAULT_RETENTION\b/;

/** Whether one source TEXT declares it — the instrument the control drives. */
function declaresDeletedConstant(source: string): boolean {
  return DELETED_CONSTANT.test(source);
}

/** The `src` files that DECLARE the deleted constant. Any at all is the defect. */
function sourceDeclaringDeletedConstant(): string[] {
  return listFiles("src", [".ts"]).filter((file) =>
    declaresDeletedConstant(readFileSync(file, "utf8")),
  );
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

  test(
    "CONTROL — the deleted-constant scan matches the DECLARATION: a planted `const " +
      "DEFAULT_RETENTION` is CAUGHT, and the same name inside prose recording its deletion is " +
      "not reported",
    () => {
      // Both halves, because a narrowing with only the negative half is
      // indistinguishable from a weakening, and the next reader could not tell
      // which was approved.
      expect(declaresDeletedConstant("const DEFAULT_RETENTION = 100;")).toBe(true);
      expect(declaresDeletedConstant("export const DEFAULT_RETENTION = 5000;")).toBe(true);
      expect(declaresDeletedConstant("let DEFAULT_RETENTION = 100;")).toBe(true);
      // The three real sites, quoted as they stand: a deletion's own obituary.
      expect(
        declaresDeletedConstant("// The rule was EARNED. `DEFAULT_RETENTION = 100` was a number"),
      ).toBe(false);
      expect(
        declaresDeletedConstant(" * Deleting `DEFAULT_RETENTION = 100` made retention opt-in,"),
      ).toBe(false);
      expect(
        declaresDeletedConstant("   * `DEFAULT_RETENTION`, deleted by that section: on 2026-09-13"),
      ).toBe(false);
      // Non-vacuity: the scanner is pointed at a tree that DOES carry the name,
      // so a filter that matched nothing at all would not read as a pass here.
      expect(
        listFiles("src", [".ts"]).filter((file) =>
          readFileSync(file, "utf8").includes("DEFAULT_RETENTION"),
        ).length,
      ).toBeGreaterThan(0);
    },
  );

  test(
    "CONTROL — the DOCUMENT scan is by word too: a line naming the deleted constant is CAUGHT, " +
      "and the retirement record for `$CRUCIBLE_DEFAULT_RETENTION` is not reported",
    () => {
      const named = DELETED_CONSTANT_NAMED;
      expect(named.test("The default cap is `DEFAULT_RETENTION = 100` events per project.")).toBe(
        true,
      );
      expect(named.test("it replaces the default for that project (DEFAULT_RETENTION).")).toBe(true);
      // The bullet §S1b REQUIRES the document to carry. Spared by GRAMMAR — `_`
      // is a word character, so there is no boundary before `DEFAULT` here —
      // not by an exception the next shared suffix would have to be added to.
      expect(
        named.test(
          "- `$CRUCIBLE_DEFAULT_RETENTION` is RETIRED and no longer read; declare a " +
            "`[limits.retention]` table in the server's file instead.",
        ),
      ).toBe(false);
      // …and the two halves meet on the real document: it names the variable
      // and does not name the constant.
      expect(text(RUNBOOK)).toContain("CRUCIBLE_DEFAULT_RETENTION");
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

// ═══════════════════════════════════════════════════════════════════════════
// CR-CRU-139 §S4 — the connection is documented as CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
//
// The same two instruments, pointed at the second retirement. Nothing here is
// a new doc-as-data mechanism: `retirementReport` and
// `liveConfigurationOffenders` already encode the rule this needs — being
// named as retired is REQUIRED, being shown as a table row or in an assignment
// is the defect — and the RUNBOOK already has the section and the sentence
// form ("### Retired environment variables", `docs/RUNBOOK.md:220-231`).
//
// Why this cycle and not later: `docs/RUNBOOK.md:232` states that
// `CRUCIBLE_PORT` is "untouched and still read", which `src/server.ts:158`
// contradicts in so many words, and `:520`/`:526`/`:530` hand an operator a
// table row and two runnable examples for a variable the server stopped
// reading in C1. An operator who follows them gets a board on the default
// port and nothing telling them why — the silent failure this CR exists to
// remove, reached through the documentation instead of the code.

/**
 * The lines of one top-level table of a toml document — walked rather than
 * matched, because a bounded-repetition regex over a 100-line file is both
 * slower and wrong at the last table (which no `^\[` follows).
 */
function tomlTable(lines: readonly string[], table: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trimStart().startsWith("["));
  return end === -1 ? rest : rest.slice(0, end);
}

/** One scalar field of one top-level table, read from a shipped toml. */
function tomlField(relPath: string, table: string, field: string): string {
  const body = tomlTable(text(relPath).split("\n"), table);
  if (body.length === 0) {
    throw new Error(`CR-CRU-139 §S4: ${relPath} declares no [${table}] table.`);
  }
  const assignment = new RegExp(`^${field}\\s*=\\s*("([^"]*)"|\\S+)\\s*$`);
  for (const line of body) {
    const value = assignment.exec(line);
    if (value !== null) return value[2] ?? value[1]!;
  }
  throw new Error(`CR-CRU-139 §S4: ${relPath}'s [${table}] table declares no \`${field}\`.`);
}

describe("CR-CRU-139 §S4 — the retired CONNECTION variables are recorded as RETIRED", () => {
  test("every connection variable the code stopped reading is named and told to be gone", () => {
    expect(RETIRED_CONNECTION_ENV.length).toBeGreaterThan(0);
    expect(report(retirementReport(text(RUNBOOK), RETIRED_CONNECTION_ENV))).toBe("");
  });

  test("and none of them is presented anywhere as live configuration", () => {
    expect(report(liveConfigurationOffenders(text(RUNBOOK), RETIRED_CONNECTION_ENV))).toBe("");
  });

  test(
    "the environment section is reduced to the variables that genuinely remain environment-" +
      "resolved, and claims nothing about the ones that do not",
    () => {
      const md = collapse(text(RUNBOOK));
      // The §S3 pair, still true and still documented — the reduction is a
      // reduction, not a deletion.
      expect(md).toContain("CRUCIBLE_DB");
      expect(md).toContain("CRUCIBLE_PROJECT_KEY");
      // The exact stale claim at `docs/RUNBOOK.md:232`, by its own words. A
      // negative on the sentence rather than on the name, because the name
      // must survive in the retirement record two paragraphs above it.
      expect(md).not.toMatch(/`CRUCIBLE_DB`,\s*`CRUCIBLE_PORT`\s*and\s*`CRUCIBLE_PROJECT_KEY`\s*are untouched/);
    },
  );

  test("`--host` / `--port` are documented as WRITING the file, not as a per-run twin of an export", () => {
    const md = collapse(text(RUNBOOK));
    // Wrong in KIND, not only in name: `crucible-axi serve --host/--port`
    // WRITES the listener into the server's own `crucible.toml` and then boots
    // it (`crucible_axi/cli.py:368-375`, `crucible_axi/install.py:559`). A
    // document calling that an alias for an export teaches a model in which
    // the setting evaporates with the shell — which is the confusion this CR
    // exists to end, so the stale framing is forbidden by its own words.
    expect(md).not.toContain("the same two knobs as per-run flags");
    const flagSentences = sentencesOf(text(RUNBOOK)).filter((sentence) =>
      sentence.includes("--port"),
    );
    expect(flagSentences.length).toBeGreaterThan(0);
    expect(
      flagSentences.filter((sentence) => /writ(e|es|ten|ing)/i.test(sentence)),
      `the RUNBOOK mentions \`--port\` in ${String(flagSentences.length)} sentence(s), none of ` +
        `which says the flag WRITES the configuration file: ${JSON.stringify(flagSentences)}`,
    ).not.toEqual([]);
  });

  test("dev-beside-production is shown as a pair of FILE declarations — the listener and the board", () => {
    // The two tables an operator edits to stand a second instance beside a
    // production one, both shown as declarations rather than as exports. The
    // `liveConfigurationOffenders` test above already forbids the export form;
    // this is its positive half, because a document can satisfy a negative by
    // saying nothing at all. Read as TOML TABLES out of the document, by the
    // same walker the shipped files are read with — so a `[client]` mentioned
    // in a sentence cannot stand in for one an operator can copy.
    const lines = text(RUNBOOK).split("\n");
    expect(
      tomlTable(lines, "server").filter((line) => /^port\s*=/.test(line)),
      "the RUNBOOK shows no `[server]` table declaring a `port` — an operator standing a second " +
        "instance beside a production one has nothing to copy.",
    ).not.toEqual([]);
    expect(
      tomlTable(lines, "client").filter((line) => /^url\s*=/.test(line)),
      "the RUNBOOK shows no `[client]` table declaring a `url` — the listener moved into a file " +
        "and the clients' target did not follow it into the documentation.",
    ).not.toEqual([]);
  });
});

describe("CR-CRU-139 §S4 — the connection figures are READ from the shipped files", () => {
  test("the listener default and the board the document states are the ones the shipped tomls declare", () => {
    const md = text(RUNBOOK);
    const host = tomlField(SHIPPED_DATA[0], "server", "host");
    const port = tomlField(SHIPPED_DATA[0], "server", "port");
    const board = tomlField(SHIPPED_DATA[1], "client", "url");

    // CR-CRU-134's rule, applied to the connection: the figure a reader meets
    // in the document and the figure the code falls back to are one datum, so
    // the document is checked against the FILE and this test spells neither.
    expect(md).toContain(host);
    expect(md).toContain(port);
    expect(md).toContain(board);

    // The half that carries the weight: EVERY connection value the document
    // SHOWS an operator — a `[server] port` to copy, a `[client] url` to copy —
    // is checked against the range the server's own file declares. A document
    // may show a figure other than the shipped default (the two-instance case
    // is the whole point), but it may not show one this project is not allowed
    // to occupy, and it may not show none at all: an operator told how to move
    // the listener and not where the clients post has one side of a two-sided
    // setting.
    const lines = md.split("\n");
    const shown = [
      ...tomlTable(lines, "server")
        .map((line) => /^port\s*=\s*(\d+)/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => Number(match[1])),
      ...tomlTable(lines, "client")
        .map((line) => /^url\s*=\s*"[^"]*:(\d+)"/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => Number(match[1])),
    ];
    expect(
      shown.length,
      `the RUNBOOK shows no connection value an operator can copy — no \`[server] port\` and no ` +
        `\`[client] url\`. The listener and the board are declared at ${SHIPPED_DATA[0]} and ` +
        `${SHIPPED_DATA[1]}; a document that moves a setting into a file without showing the ` +
        `declaration has moved it out of reach instead.`,
    ).toBeGreaterThanOrEqual(2);

    // The BOUND, so a rewrite cannot satisfy the positive half by printing one
    // derived figure beside three invented ones. `[server] port_range_min` /
    // `_max` is the one datum saying which ports this project may occupy, and
    // the installer probes exactly that range — so a documented example on a
    // port outside it teaches an instance the installer would never produce.
    const min = Number(tomlField(SHIPPED_DATA[0], "server", "port_range_min"));
    const max = Number(tomlField(SHIPPED_DATA[0], "server", "port_range_max"));
    expect(min).toBeLessThanOrEqual(Number(port));
    expect(Number(port)).toBeLessThanOrEqual(max);
    expect(shown.filter((figure) => figure < min || figure > max)).toEqual([]);

    // …and the same bound over the PROSE, where a figure needs no table to be
    // copied: every four-digit figure in the 3000s this document prints is a
    // port here, so a 3849 left behind after the range moves is caught rather
    // than inherited by the reader who copied it.
    const strays = [...md.matchAll(/\b3\d{3}\b/g)]
      .map((match) => Number(match[0]))
      .filter((figure) => figure < min || figure > max);
    expect(strays).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CR-CRU-139 §S3 — the file a reader edits says why two settings are NOT in it
// ═══════════════════════════════════════════════════════════════════════════
//
// §S3 promised this and nothing shipped it: `grep` across both shipped tomls
// finds ONE mention of either surviving variable (`src/crucible.toml:16`), and
// that line explains where the OPERATOR's file is found — not why the store
// path may not move into it. So a reader who has just learned that the
// listener lives in this file has nothing telling them the store and the
// project key do not, and the obvious next CR "finishes the job" by moving a
// value that cannot move.
//
// 🚨 DEVIATION FROM THE SPEC TEXT, recorded rather than taken silently. §S3
// says "both shipped `crucible.toml` files state that explicitly", which reads
// as both files explaining both variables. Asserted here as EACH FILE
// EXPLAINING THE ONE ITS OWN PROCESS READS: the server reads `CRUCIBLE_DB` and
// never `CRUCIBLE_PROJECT_KEY`; the clients read the project key out of their
// `.env` and never the store path. Requiring each file to explain the other's
// variable would put an explanation where the datum is inert, and this repo
// already forbids exactly that in the file under test —
// `clients/crucible.toml:40-41`: "documentation must not teach a knob that
// provably does nothing where it sits". The ownership split is the same one
// that decides which limits each file declares.

/**
 * The environment-resolved datum each shipped file's OWN process reads, and
 * the reason that datum cannot become a line in the file.
 */
const SURVIVING_ENV: ReadonlyArray<{ file: string; name: string; why: RegExp }> = [
  // src/server.ts:66 — the store path is how the server FINDS the file, so it
  // is answered before any file can be read.
  { file: SHIPPED_DATA[0], name: "CRUCIBLE_DB", why: /before|precede|finds?|found|discover/i },
  // clients/*-crucible.py — identity, read from the project `.env`.
  { file: SHIPPED_DATA[1], name: "CRUCIBLE_PROJECT_KEY", why: /identit|\.env|who\b|precede|before/i },
];

describe("CR-CRU-139 §S3 — each shipped file says why its surviving variable stays in the environment", () => {
  for (const { file, name, why } of SURVIVING_ENV) {
    test(`${file} names ${name} and says why it cannot move into the file`, () => {
      const sentences = sentencesOf(text(file));
      const mentions = sentences.filter((sentence) => sentence.includes(name));
      expect(
        mentions,
        `${file} never names ${name}. A reader who has just found \`[server] port\` / ` +
          `\`[client] url\` in this file is left to conclude that every Crucible setting belongs ` +
          `here — which is how a later CR "finishes the job" by moving a value that precedes the ` +
          `file's own discovery.`,
      ).not.toEqual([]);
      expect(
        mentions.filter((sentence) => why.test(sentence)),
        `${file} names ${name} but never says WHY it stays in the environment: ` +
          `${JSON.stringify(mentions)}`,
      ).not.toEqual([]);
    });
  }

  test("and neither shipped file offers a retired connection variable as a setting", () => {
    for (const file of SHIPPED_DATA) {
      expect(report(liveConfigurationOffenders(text(file), RETIRED_CONNECTION_ENV))).toBe("");
    }
  });
});

describe("CR-CRU-131 §S1b — the retention section describes the software that exists", () => {
  test("the constant and the fallback CR-CRU-129 deleted are gone from the document", () => {
    const md = collapse(text(RUNBOOK));
    expect(md).not.toContain("DEFAULT_RETENTION = 100");
    expect(md).not.toContain("retention ?? 100");
    // Derived, not remembered: the server's source DECLARES no such constant,
    // so a document naming it documents something that does not exist. Matched
    // by the declaration GRAMMAR — see DELETED_CONSTANT for why the name
    // appearing in lineage prose is compliance rather than a violation.
    expect(sourceDeclaringDeletedConstant()).toEqual([]);
    // The document must not name the deleted CONSTANT — by WORD, not by
    // substring. `not.toContain("DEFAULT_RETENTION")` could not distinguish two
    // DIFFERENT symbols: the deleted server constant, and the retired
    // environment variable `CRUCIBLE_DEFAULT_RETENTION`, which merely shares a
    // suffix and which the retired-variables suite above REQUIRES this document
    // to name (§S1b — an operator who learned it from the source has to be told
    // it is gone). The two assertions were jointly unsatisfiable: no document
    // can name the variable without carrying the constant's characters. `_` is
    // a word character, so `\b` spares the variable by GRAMMAR rather than by
    // an exception list that the next shared suffix would reopen.
    expect(md).not.toMatch(DELETED_CONSTANT_NAMED);
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

// ═══════════════════════════════════════════════════════════════════════════
// CR-CRU-134 — the SCHEMA figures this document prints are derived too
// ═══════════════════════════════════════════════════════════════════════════
//
// ── Why this sits in this file ────────────────────────────────────────────
//
// The defect is the one §S1b above was written for, one section over: a number
// that lives in code, retyped into prose, with nothing asserting the two agree.
// The store's schema version had moved eight migrations past the figure the
// RUNBOOK's health-payload and boot-banner examples print. This file is the
// only one in the tree that parses `docs/RUNBOOK.md` as structured data, so the
// schema figures are measured HERE, by the walker that already reads this
// document, rather than by a second walker that would have to be kept in step
// with it (CR-CRU-134 §S1, AC6).
//
// ── What is READ FROM CODE rather than believed ───────────────────────────
//
//   the current schema version   `SCHEMA_VERSION` (src/store.ts), CROSS-CHECKED
//                                against what a real `Store` ends up carrying
//                                in `PRAGMA user_version` — so the guard cannot
//                                measure the document against a version no
//                                store is ever at
//   the versions the document    parsed out of the examples themselves: the
//   claims                       health payload's `schemaVersion` field and the
//                                boot banner's `schema` figure
//
// Not one figure is written down here. The guard's own source is scanned for a
// transcribed one (AC3), which is why every synthetic document below builds its
// versions by interpolation.
//
// ── Why the migration banner is measured SEPARATELY ───────────────────────
//
// `src/server.ts` prints the migration banner as `v<from> -> v<to>`, and `to`
// is always the boot's target — the current version. `from` is whatever the
// store was at, so it is the one version in this document that CANNOT be
// current, and a scanner that read it as a claim about today's schema would
// report a correct example as wrong. So the arrow line is excluded from the
// figure scan and answers to its own report, which asks the question §S2
// actually asks: does this describe a migration the code can perform? It
// passes when the banner arrives at the current version — or when the example
// is MARKED as an illustration, the CR's explicit second branch, in which case
// the guard knows it is one and checks no version in it.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Unchanged from above: every document other than the RUNBOOK is a string built
// in memory, and the only Store opened is `":memory:"`.

/** This guard's own source — scanned for a transcribed figure (AC3). */
const GUARD = "tests/docs-runbook-documents-every-limit.test.ts";

/**
 * What an UNVERSIONED store reads as. `PRAGMA user_version` defaults to zero,
 * and a store carrying it predates versioning entirely (src/store.ts) — it is
 * the ABSENCE of a version rather than a figure that can drift, so it cannot go
 * stale the way a schema figure can. It is named rather than written into the
 * synthetic banners below so that those carry no schema digit at all and the
 * transcription scan can stay absolute.
 */
const UNVERSIONED = 0;

/**
 * The version a store actually ends up at: a real `Store`, migrated, asked for
 * the version it is carrying. `SCHEMA_VERSION` is the DECLARATION; this is the
 * OBSERVATION, and the guard requires both so that a declaration the migration
 * chain does not actually reach could not silently become the document's
 * target.
 */
function observedSchemaVersion(): number {
  // A scratch config directory, for the same reason the retention disclosure
  // test takes one: the resolver looks beside the store, and nothing here may
  // read or write the real one.
  serverConfigDir();
  return new Store(":memory:").schemaVersion;
}

interface SchemaFigure {
  /** Which EXAMPLE stated it — named in the offender line so a failure is actionable. */
  readonly kind: string;
  readonly line: number;
  readonly version: number;
  readonly text: string;
}

/** The migration banner, by the grammar `src/server.ts` prints it in. */
const MIGRATION_BANNER = /migrated store schema v(\d+)\s*->\s*v(\d+)/;

/**
 * The two shapes this document states the CURRENT version in. Both must be
 * present: the report says so when one is missing, because a document that
 * stopped showing an example would otherwise make this guard pass by having
 * nothing left to measure.
 */
const SCHEMA_FIGURE_FORMS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "the health payload's `schemaVersion`", pattern: /"schemaVersion"\s*:\s*(\d+)/g },
  { kind: "the boot banner's `schema` figure", pattern: /schema v(\d+)/g },
];

function schemaFigures(md: string): SchemaFigure[] {
  const out: SchemaFigure[] = [];
  md.split("\n").forEach((line, index) => {
    // The arrow line states a FROM version that is deliberately not current.
    if (MIGRATION_BANNER.test(line)) return;
    for (const form of SCHEMA_FIGURE_FORMS) {
      for (const match of line.matchAll(form.pattern)) {
        out.push({
          kind: form.kind,
          line: index + 1,
          version: Number(match[1]),
          text: collapse(line),
        });
      }
    }
  });
  return out;
}

/** Every documented current-version figure that is not the store's own. */
function schemaFigureReport(md: string, current: number): string[] {
  const figures = schemaFigures(md);
  const out: string[] = [];
  for (const form of SCHEMA_FIGURE_FORMS) {
    if (!figures.some((figure) => figure.kind === form.kind)) {
      out.push(
        `${form.kind}: the document shows no such example at all — with none there is nothing ` +
          `for this guard to measure, so a green result would be an empty walk`,
      );
    }
  }
  for (const figure of figures) {
    if (figure.version !== current) {
      out.push(
        `${figure.kind}: documented as v${String(figure.version)} at line ${String(figure.line)}; ` +
          `a store carries v${String(current)} — ${figure.text.slice(0, 120)}`,
      );
    }
  }
  return out;
}

interface MigrationExample {
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** Whether its section says the versions in it are an illustration. */
  readonly marked: boolean;
}

/** An example the document presents as an illustration rather than as a reading. */
const ILLUSTRATION = /illustrat|for example only|example versions|not (a )?(real|live|current) version/i;

/** Everything from the last heading above a line down to the line itself. */
function contextBefore(lines: readonly string[], index: number): string {
  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  return lines.slice(start, index + 1).join("\n");
}

function migrationExamples(md: string): MigrationExample[] {
  const lines = md.split("\n");
  const out: MigrationExample[] = [];
  lines.forEach((line, index) => {
    const match = MIGRATION_BANNER.exec(line);
    if (match === null) return;
    out.push({
      line: index + 1,
      from: Number(match[1]),
      to: Number(match[2]),
      text: collapse(line),
      marked: ILLUSTRATION.test(contextBefore(lines, index)),
    });
  });
  return out;
}

/**
 * The migration example, measured against the migration the code can perform:
 * a boot migrates to its TARGET, which is the current version, and migrations
 * only ever run forward. An example marked as an illustration is spared — the
 * CR's second branch — and the absence of any example at all is reported, so
 * deleting the banner is not a way to pass.
 */
function migrationExampleReport(md: string, current: number): string[] {
  const examples = migrationExamples(md);
  const out: string[] = [];
  if (examples.length === 0) {
    out.push(
      "the document shows no migration banner at all — an operator reading one off their own " +
        "console has nothing to match it against, and this guard has nothing to measure",
    );
  }
  for (const example of examples) {
    if (example.marked) continue;
    if (example.to !== current) {
      out.push(
        `the migration banner at line ${String(example.line)} arrives at v${String(example.to)}; ` +
          `a boot migrates to its TARGET, which is v${String(current)}, so this is a path the ` +
          `code cannot take — state the version it reaches, or mark the example as an ` +
          `illustration — ${example.text.slice(0, 120)}`,
      );
    }
    if (example.from >= example.to) {
      out.push(
        `the migration banner at line ${String(example.line)} runs from v${String(example.from)} ` +
          `to v${String(example.to)}; a migration only ever runs forward`,
      );
    }
  }
  return out;
}

describe("CR-CRU-134 §S1 — the schema guard's own instruments", () => {
  test(
    "GUARD — the version is READ from the software twice, the declaration and a real store's " +
      "own, and this guard's source transcribes no figure at all",
    () => {
      // The declaration and the observation. A `SCHEMA_VERSION` the migration
      // chain did not actually reach would make every assertion below measure
      // the document against a version no store is ever at.
      expect(SCHEMA_VERSION).toBeGreaterThan(0);
      expect(observedSchemaVersion()).toBe(SCHEMA_VERSION);

      // AC3 — no figure is transcribed into the guard. Every synthetic document
      // below builds its versions by interpolation, so a literal one appearing
      // here would be exactly the copy this CR exists to forbid.
      const source = text(GUARD);
      expect(source).toContain("migrationExampleReport"); // the file this names
      const transcribed = source
        .split("\n")
        .map((line, index) => ({ line, at: index + 1 }))
        .filter(
          ({ line }) =>
            /schema v\d/.test(line) ||
            /"schemaVersion"\s*:\s*\d/.test(line) ||
            /v\d+\s*->\s*v\d+/.test(line),
        )
        .map(({ line, at }) => `line ${String(at)}: ${collapse(line).slice(0, 120)}`);
      expect(report(transcribed)).toBe("");
    },
  );

  test(
    "CONTROL — figures that ARE the store's own are passed in silence, a stale one is caught by " +
      "example and line, and a document showing none is reported rather than passed",
    () => {
      const current = SCHEMA_VERSION;
      const correct = [
        "## Schema versions and migration",
        "",
        "```sh",
        `# → {"store":{"path":"…","rule":"cwd-data","schemaVersion":${String(current)},"migration":null}}`,
        "```",
        "",
        "```",
        `[crucible] store /path/to/crucible.db (rule: cwd-data, schema v${String(current)})`,
        `[crucible] migrated store schema v${String(UNVERSIONED)} -> v${String(current)}`,
        "```",
      ].join("\n");
      // A document that agrees: nothing whatever is said about it.
      expect(schemaFigureReport(correct, current)).toEqual([]);
      expect(migrationExampleReport(correct, current)).toEqual([]);
      // …and both examples were actually FOUND, so that silence is agreement
      // rather than a scan that matched nothing.
      expect(schemaFigures(correct).map((figure) => figure.kind).sort()).toEqual(
        SCHEMA_FIGURE_FORMS.map((form) => form.kind).sort(),
      );

      // One figure moved, everything else identical: caught, named, and the
      // correct example beside it is still passed in silence.
      const stale = correct.replace(
        `"schemaVersion":${String(current)}`,
        `"schemaVersion":${String(current - 1)}`,
      );
      const offenders = schemaFigureReport(stale, current);
      expect(offenders.length).toBe(1);
      expect(offenders[0]).toContain("the health payload's `schemaVersion`");
      expect(offenders[0]).toContain(`v${String(current - 1)}`);
      expect(offenders[0]).toContain(`v${String(current)}`);
      expect(offenders.filter((line) => line.includes("boot banner"))).toEqual([]);

      // A document that shows no example at all does not pass: both forms are
      // reported missing, and so is the migration banner.
      const silent = [
        "## Schema versions and migration",
        "",
        "The store carries its schema version in `PRAGMA user_version`.",
      ].join("\n");
      expect(schemaFigureReport(silent, current).length).toBe(SCHEMA_FIGURE_FORMS.length);
      expect(migrationExampleReport(silent, current).length).toBe(1);
    },
  );

  test(
    "CONTROL — a migration banner that arrives where no boot can is CAUGHT, the same banner is " +
      "spared once its section marks it an illustration, and a backwards one is caught too",
    () => {
      const current = SCHEMA_VERSION;
      const documentOf = (intro: string, from: number, to: number): string =>
        [
          "## Schema versions and migration",
          "",
          intro,
          "",
          "```",
          `[crucible] migrated store schema v${String(from)} -> v${String(to)}`,
          "```",
        ].join("\n");
      const plain = "The startup lines look like this:";
      const marked = "The versions below are illustrative — they are not read from a live store:";

      // Arrives at a version no boot migrates to: caught, naming both.
      const stale = migrationExampleReport(documentOf(plain, UNVERSIONED, current - 1), current);
      expect(stale.length).toBe(1);
      expect(stale[0]).toContain(`v${String(current - 1)}`);
      expect(stale[0]).toContain(`v${String(current)}`);

      // The SAME banner, one sentence different: spared, because the guard is
      // told it is an illustration. The marker is the only variable here.
      expect(migrationExampleReport(documentOf(marked, UNVERSIONED, current - 1), current)).toEqual([]);

      // A banner that arrives at the current version needs no marker at all.
      expect(migrationExampleReport(documentOf(plain, UNVERSIONED, current), current)).toEqual([]);

      // Backwards is caught on its own account, not as a version mismatch.
      const backwards = migrationExampleReport(documentOf(plain, current, current), current);
      expect(backwards.length).toBe(1);
      expect(backwards[0]).toContain("only ever runs forward");
    },
  );
});

describe("CR-CRU-134 §S1 — docs/RUNBOOK.md's schema figures are the store's own", () => {
  test("every documented current-version figure is the version a store actually carries", () => {
    const current = observedSchemaVersion();
    expect(current).toBe(SCHEMA_VERSION);
    expect(report(schemaFigureReport(text(RUNBOOK), current))).toBe("");
  });
});

describe("CR-CRU-134 §S2 — the migration example describes a migration that exists", () => {
  test("the documented banner arrives where a boot arrives, or says it is an illustration", () => {
    expect(report(migrationExampleReport(text(RUNBOOK), observedSchemaVersion()))).toBe("");
  });
});
