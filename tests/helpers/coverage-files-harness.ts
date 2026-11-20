// What the per-file coverage suites share:
//
//  - an ORACLE that reads a coverage text into its files, written here from
//    the report formats alone and independent of the board's codecs: an lcov
//    text's `SF:` records, a JaCoCo CSV's rows, a Go coverprofile's blocks;
//  - the order a run's files are kept in, stated once;
//  - the ingest of a report with a coverage block, single-shot and as the
//    close of a streamed run, over real HTTP on an in-memory board;
//  - the reading of the `run_coverage_files` table. The table's column names
//    other than `event_id` (the column every run-detail table is deleted by)
//    are DISCOVERED from one probe row whose every value is distinct, so no
//    name the board has not committed to is assumed here.
//  - a run of twelve files, the reads of a stored run
//    (`GET /api/v2/events/<id>` under any query), and a log of the statements
//    the store's connection runs during a read, with the rows each hands back.
//
// Safety: every server binds port 0 on ":memory:".
import { expect, spyOn } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coveragePercent } from "../../src/codecs/coverage.ts";
import type { Store } from "../../src/store.ts";
import {
  bootOn,
  eventLine,
  openRun,
  postJson,
  readyProject,
  send,
  sendBatch,
  STREAM_CODEC,
  type Answer,
  type Booted,
} from "./run-stream-harness.ts";

// ── The shapes ──────────────────────────────────────────────────────────────

export interface Axis {
  total: number;
  covered: number;
  percent: number;
}

/** One file of a run's coverage: its name, its lines, and its functions when it has any. */
export interface CoverageFile {
  path: string;
  lines: Axis;
  functions?: Axis;
}

export type CoverageCodecName = "lcov" | "jacoco" | "go-coverprofile";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** A file under `tests/fixtures/`, read as text. */
export function fixtureText(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf8");
}

// ── The oracle ──────────────────────────────────────────────────────────────

interface Counters {
  total: number;
  covered: number;
}

interface FileCounters {
  lines: Counters;
  functions: Counters;
}

type FileTable = Map<string, FileCounters>;

function entry(table: FileTable, path: string): FileCounters {
  let held = table.get(path);
  if (held === undefined) {
    held = { lines: { total: 0, covered: 0 }, functions: { total: 0, covered: 0 } };
    table.set(path, held);
  }
  return held;
}

function count(field: string, what: string): number {
  if (!/^\d+$/.test(field)) throw new Error(`oracle: ${what} is not a count: '${field}'`);
  return Number(field);
}

/** lcov: each `SF:` record's own `LF`/`LH` and `FNF`/`FNH`, under the name the record writes. */
function readLcov(text: string, table: FileTable): void {
  let current: FileCounters | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = entry(table, line.slice(3));
    } else if (line === "end_of_record") {
      current = undefined;
    } else if (current !== undefined) {
      if (line.startsWith("LF:")) current.lines.total += count(line.slice(3), "LF");
      else if (line.startsWith("LH:")) current.lines.covered += count(line.slice(3), "LH");
      else if (line.startsWith("FNF:")) current.functions.total += count(line.slice(4), "FNF");
      else if (line.startsWith("FNH:")) current.functions.covered += count(line.slice(4), "FNH");
    }
  }
}

/** JaCoCo CSV: each row's `LINE_*` and `METHOD_*`, under `PACKAGE.CLASS`, or `CLASS` alone when `PACKAGE` is empty. */
function readJacoco(text: string, table: FileTable): void {
  if (text.includes('"')) throw new Error("oracle: a quoted CSV field is not read here");
  const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
  const header = (rows[0] ?? "").split(",");
  const column = (name: string): number => {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`oracle: the CSV has no ${name} column`);
    return at;
  };
  for (const row of rows.slice(1)) {
    const fields = row.split(",");
    const field = (name: string): string => fields[column(name)] ?? "";
    const pkg = field("PACKAGE");
    const file = entry(table, pkg.length > 0 ? `${pkg}.${field("CLASS")}` : field("CLASS"));
    const lineCovered = count(field("LINE_COVERED"), "LINE_COVERED");
    const methodCovered = count(field("METHOD_COVERED"), "METHOD_COVERED");
    file.lines.total += count(field("LINE_MISSED"), "LINE_MISSED") + lineCovered;
    file.lines.covered += lineCovered;
    file.functions.total += count(field("METHOD_MISSED"), "METHOD_MISSED") + methodCovered;
    file.functions.covered += methodCovered;
  }
}

/**
 * Go coverprofile: each block's statements under the text before its
 * `:startLine.startCol,endLine.endCol`. Within one profile a block listed
 * more than once counts once, covered when any copy has a count above 0.
 */
function readGoProfile(text: string, table: FileTable): void {
  const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
  if (!(rows[0] ?? "").startsWith("mode: ")) throw new Error("oracle: the profile has no mode line");
  const blocks = new Map<string, { file: string; statements: number; covered: boolean }>();
  for (const row of rows.slice(1)) {
    const match = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(row);
    if (match === null) throw new Error(`oracle: not a block line: ${row}`);
    const [, file, span, statements, hits] = match as unknown as [string, string, string, string, string];
    const key = `${file}:${span}`;
    const seen = blocks.get(key);
    const covered = Number(hits) > 0 || (seen?.covered ?? false);
    blocks.set(key, { file, statements: Number(statements), covered });
  }
  for (const block of blocks.values()) {
    const file = entry(table, block.file);
    file.lines.total += block.statements;
    if (block.covered) file.lines.covered += block.statements;
  }
}

const READERS: Record<CoverageCodecName, (text: string, table: FileTable) => void> = {
  lcov: readLcov,
  jacoco: readJacoco,
  "go-coverprofile": readGoProfile,
};

function axis(counters: Counters): Axis {
  return { ...counters, percent: coveragePercent(counters.covered, counters.total) };
}

/** One file as a run answers it: no `functions` key when its functions total is 0. */
export function coverageFile(path: string, lines: Counters, functions?: Counters): CoverageFile {
  return {
    path,
    lines: axis(lines),
    ...(functions !== undefined && functions.total > 0 ? { functions: axis(functions) } : {}),
  };
}

/**
 * The files of one run's coverage texts, read by the oracle: a name stated
 * more than once, in one text or in several, is ONE file whose counters are
 * added. In the order the names first appear, which is not the kept order.
 */
export function oracleFiles(codec: CoverageCodecName, texts: readonly string[]): CoverageFile[] {
  const table: FileTable = new Map();
  for (const text of texts) READERS[codec](text, table);
  return [...table.entries()].map(([path, held]) => coverageFile(path, held.lines, held.functions));
}

// ── The kept order ──────────────────────────────────────────────────────────

/** Names compared by code unit, as SQLite's BINARY collation compares them: `B.ts` before `a.ts`. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order a run's files are kept in: lowest rounded lines percent first,
 * then most uncovered lines first, then name ascending by code unit; a file
 * with no lines after every file that has lines.
 */
export function inKeptOrder(files: readonly CoverageFile[]): CoverageFile[] {
  const uncovered = (file: CoverageFile): number => file.lines.total - file.lines.covered;
  const ranked = (a: CoverageFile, b: CoverageFile): number =>
    a.lines.percent - b.lines.percent || uncovered(b) - uncovered(a) || byCodeUnit(a.path, b.path);
  return [
    ...files.filter((file) => file.lines.total > 0).sort(ranked),
    ...files.filter((file) => file.lines.total === 0).sort(ranked),
  ];
}

/** The files by name, for a comparison that does not depend on their order. */
export function byPath<T extends { path: string }>(files: readonly T[] | undefined): T[] | undefined {
  return files === undefined ? undefined : [...files].sort((a, b) => byCodeUnit(a.path, b.path));
}

// ── Texts ───────────────────────────────────────────────────────────────────

export interface LcovRecord {
  path: string;
  /** `LF`/`LH`; a record given neither states no line counters. */
  lf?: number;
  lh?: number;
  /** `FNF`/`FNH`; a record given neither states no function counters. */
  fnf?: number;
  fnh?: number;
}

/** An lcov text of the given records, each `SF:` … `end_of_record`. */
export function lcovText(records: readonly LcovRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    lines.push(`SF:${record.path}`);
    if (record.fnf !== undefined) lines.push(`FNF:${record.fnf}`);
    if (record.fnh !== undefined) lines.push(`FNH:${record.fnh}`);
    if (record.lf !== undefined) lines.push(`LF:${record.lf}`);
    if (record.lh !== undefined) lines.push(`LH:${record.lh}`);
    lines.push("end_of_record");
  }
  return `${lines.join("\n")}\n`;
}

/** 2 passed. */
export const PASSING_REPORT = [
  '<testsuite name="Green" tests="2">',
  '<testcase name="g1" time="0.01"/>',
  '<testcase name="g2" time="0.02"/>',
  "</testsuite>",
].join("\n");

/** 1 passed, 1 failed. */
export const FAILING_REPORT = [
  '<testsuite name="Red" tests="2">',
  '<testcase name="r1" time="0.01"/>',
  '<testcase name="r2" time="0.02"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

/** A stream of two passing tests, closed by its `run-end`. */
export const GREEN_STREAM =
  eventLine({ event: "run-start", total: 2 }) +
  eventLine({ event: "test-end", id: "t1", name: "adds", suite: "math", file: "math.test.ts", status: "pass", duration_ms: 2 }) +
  eventLine({ event: "test-end", id: "t2", name: "subtracts", suite: "math", file: "math.test.ts", status: "pass", duration_ms: 2 }) +
  eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 4 });

// ── Ingests ─────────────────────────────────────────────────────────────────

/** A single-shot `POST /api/v2/runs` of a junit report, with the coverage block when one is given. */
export function ingestRun(
  handle: Booted,
  projectKey: string,
  agentId: string,
  coverage?: unknown,
  report: string = PASSING_REPORT,
): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", {
    projectKey,
    agentId,
    codec: "junit",
    data: report,
    ...(coverage !== undefined ? { coverage } : {}),
  });
}

/** A run opened, streamed green and closed through `POST /api/v2/runs`, the coverage block sent with the close. */
export async function closeStreamedRun(
  handle: Booted,
  projectKey: string,
  agentId: string,
  coverage?: unknown,
): Promise<Answer> {
  const runId = await openRun(handle, projectKey, agentId, { stack: "bun", tier: "unit" });
  const batch = await sendBatch(handle, runId, { projectKey, agentId, from: 0, data: GREEN_STREAM });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  return postJson(handle, "/api/v2/runs", {
    projectKey,
    agentId,
    runId,
    codec: STREAM_CODEC,
    ...(coverage !== undefined ? { coverage } : {}),
  });
}

/** The id of the event an accepted ingest stored. */
export function eventIdOf(answer: Answer): string {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(typeof answer.body.event, "the ingest must answer the event it stored").toBe("string");
  return answer.body.event as string;
}

/** The `run` block of an ingest's answer. */
export function runBlockOf(answer: Answer): Record<string, unknown> {
  expect(typeof answer.body.run, JSON.stringify(answer.body)).toBe("object");
  return answer.body.run as Record<string, unknown>;
}

// ── The table ───────────────────────────────────────────────────────────────

export const FILES_TABLE = "run_coverage_files";

export function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

export function hasFilesTable(db: Database): boolean {
  const row = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(FILES_TABLE);
  return (row?.n ?? 0) === 1;
}

function requireFilesTable(db: Database): void {
  expect(hasFilesTable(db), `the store must hold a ${FILES_TABLE} table`).toBe(true);
}

/** How many file rows the store holds for one run. */
export function fileRowCount(db: Database, eventId: string): number {
  requireFilesTable(db);
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM run_coverage_files WHERE event_id = ?`).get(eventId)?.n ?? -1;
}

/** How many file rows the store holds in all. */
export function fileRowTotal(db: Database): number {
  requireFilesTable(db);
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM run_coverage_files`).get()?.n ?? -1;
}

/** One run's file rows as the table holds them, each a JSON text, sorted: a fingerprint that needs no column name. */
export function fileRowFingerprint(db: Database, eventId: string): string[] {
  requireFilesTable(db);
  return db
    .query<Record<string, unknown>, [string]>(`SELECT * FROM run_coverage_files WHERE event_id = ?`)
    .all(eventId)
    .map((row) => JSON.stringify(row))
    .sort();
}

/** A reading of one run's file rows that never fails by itself: the rows' fingerprint, or "no table" on a store without the table. */
export type HeldFileRows = string[] | "no table";

/** One run's file rows as held right now, read before a removal so that the removal itself is exercised either way. */
export function heldFileRows(db: Database, eventId: string): HeldFileRows {
  if (!hasFilesTable(db)) return "no table";
  return fileRowFingerprint(db, eventId);
}

/** How many rows each reading holds. */
export function heldCounts(...held: HeldFileRows[]): Array<number | "no table"> {
  return held.map((rows) => (rows === "no table" ? rows : rows.length));
}

/** The table's columns, each named for what it holds. */
export interface FileColumns {
  position: string;
  path: string;
  linesTotal: string;
  linesCovered: string;
  functionsTotal: string;
  functionsCovered: string;
  /** Every column of the table, as declared. */
  all: string[];
  /** The probe's one row, as the table holds it. */
  probeRow: Record<string, unknown>;
}

/** The probe run's one file: every counter differs from every other, and from any position. */
export const PROBE_FILE = { path: "probe/only-here.ts", lf: 41, lh: 30, fnf: 7, fnh: 5 } as const;

async function probeFileColumns(): Promise<FileColumns> {
  const handle = bootOn();
  try {
    const agentId = "column-probe";
    const key = await readyProject(handle, [agentId], "column-probe");
    const eventId = eventIdOf(await ingestRun(handle, key, agentId, { codec: "lcov", data: lcovText([PROBE_FILE]) }));
    const db = dbOf(handle.store);
    requireFilesTable(db);
    const rows = db
      .query<Record<string, unknown>, [string]>(`SELECT * FROM run_coverage_files WHERE event_id = ?`)
      .all(eventId);
    expect(rows.length, "a run of one file stores one file row").toBe(1);
    const probeRow = rows[0]!;
    const all = Object.keys(probeRow);
    const holding = (value: unknown, what: string): string => {
      const columns = all.filter((column) => probeRow[column] === value);
      expect(columns.length, `exactly one column holds the file's ${what} (${String(value)}); the row is ${JSON.stringify(probeRow)}`).toBe(1);
      return columns[0]!;
    };
    const named = {
      path: holding(PROBE_FILE.path, "name"),
      linesTotal: holding(PROBE_FILE.lf, "lines total"),
      linesCovered: holding(PROBE_FILE.lh, "lines covered"),
      functionsTotal: holding(PROBE_FILE.fnf, "functions total"),
      functionsCovered: holding(PROBE_FILE.fnh, "functions covered"),
    };
    expect(probeRow.event_id, "the row names its run in event_id").toBe(eventId);
    const rest = all.filter((column) => column !== "event_id" && !Object.values(named).includes(column));
    expect(rest.length, `one column is left to hold the file's position; the row is ${JSON.stringify(probeRow)}`).toBe(1);
    expect(Number.isInteger(probeRow[rest[0]!]), "the file's position is an integer").toBe(true);
    return { ...named, position: rest[0]!, all, probeRow };
  } finally {
    handle.stop();
  }
}

let discovered: Promise<FileColumns> | undefined;

/** The table's columns by what they hold, discovered once from a probe run on a board of its own. */
export function fileColumns(): Promise<FileColumns> {
  discovered ??= probeFileColumns();
  return discovered;
}

/** One file row, read by what each column holds. */
export interface StoredFile {
  path: string;
  linesTotal: number;
  linesCovered: number;
  functionsTotal: number | null;
  functionsCovered: number | null;
}

/** The row a file is stored as: its counters, and NULL functions counters when it has no functions axis. */
export function storedFileOf(file: CoverageFile): StoredFile {
  return {
    path: file.path,
    linesTotal: file.lines.total,
    linesCovered: file.lines.covered,
    functionsTotal: file.functions?.total ?? null,
    functionsCovered: file.functions?.covered ?? null,
  };
}

/** One run's file rows in the order of their stored position. */
export async function storedFiles(db: Database, eventId: string): Promise<StoredFile[]> {
  const columns = await fileColumns();
  requireFilesTable(db);
  // Ordered here, by the value each row holds as its position: no column name is written into a statement.
  const positionOf = (row: Record<string, unknown>): number => row[columns.position] as number;
  const rows = db
    .query<Record<string, unknown>, [string]>(`SELECT * FROM run_coverage_files WHERE event_id = ?`)
    .all(eventId)
    .sort((a, b) => positionOf(a) - positionOf(b));
  const positions = rows.map(positionOf);
  expect(positions.every((position) => Number.isInteger(position)), `each position is an integer: ${JSON.stringify(positions)}`).toBe(true);
  expect(new Set(positions).size, `each file of a run has a position of its own: ${JSON.stringify(positions)}`).toBe(rows.length);
  return rows.map((row) => ({
    path: row[columns.path] as string,
    linesTotal: row[columns.linesTotal] as number,
    linesCovered: row[columns.linesCovered] as number,
    functionsTotal: row[columns.functionsTotal] as number | null,
    functionsCovered: row[columns.functionsCovered] as number | null,
  }));
}

// ── A run of twelve files ───────────────────────────────────────────────────

/** The directory every file of the twelve-file run shares. */
export const TWELVE_ROOT = "/home/dev/app/src/";

/**
 * Twelve files of 100 lines each, written in no order. The six least covered
 * sit one directory deeper (`lib/`) than the rest, so the directory the first
 * few share is not the directory the whole run shares; the other six state
 * functions.
 */
export const TWELVE_RECORDS: LcovRecord[] = [57, 3, 91, 22, 78, 40, 100, 0, 64, 15, 86, 33].map((hit, index) => ({
  path: `${TWELVE_ROOT}${index % 2 === 1 ? "lib/" : ""}f${String(index).padStart(2, "0")}.ts`,
  lf: 100,
  lh: hit,
  ...(index % 2 === 0 ? { fnf: 4, fnh: index % 4 === 0 ? 4 : 1 } : {}),
}));

export const TWELVE_BLOCK = { codec: "lcov", data: lcovText(TWELVE_RECORDS) };

/** The twelve as a read answers them, least covered first, written out by hand. */
export const TWELVE_FILES: CoverageFile[] = [
  { path: "/home/dev/app/src/lib/f07.ts", lines: { total: 100, covered: 0, percent: 0 } },
  { path: "/home/dev/app/src/lib/f01.ts", lines: { total: 100, covered: 3, percent: 3 } },
  { path: "/home/dev/app/src/lib/f09.ts", lines: { total: 100, covered: 15, percent: 15 } },
  { path: "/home/dev/app/src/lib/f03.ts", lines: { total: 100, covered: 22, percent: 22 } },
  { path: "/home/dev/app/src/lib/f11.ts", lines: { total: 100, covered: 33, percent: 33 } },
  { path: "/home/dev/app/src/lib/f05.ts", lines: { total: 100, covered: 40, percent: 40 } },
  { path: "/home/dev/app/src/f00.ts", lines: { total: 100, covered: 57, percent: 57 }, functions: { total: 4, covered: 4, percent: 100 } },
  { path: "/home/dev/app/src/f08.ts", lines: { total: 100, covered: 64, percent: 64 }, functions: { total: 4, covered: 4, percent: 100 } },
  { path: "/home/dev/app/src/f04.ts", lines: { total: 100, covered: 78, percent: 78 }, functions: { total: 4, covered: 4, percent: 100 } },
  { path: "/home/dev/app/src/f10.ts", lines: { total: 100, covered: 86, percent: 86 }, functions: { total: 4, covered: 1, percent: 25 } },
  { path: "/home/dev/app/src/f02.ts", lines: { total: 100, covered: 91, percent: 91 }, functions: { total: 4, covered: 1, percent: 25 } },
  { path: "/home/dev/app/src/f06.ts", lines: { total: 100, covered: 100, percent: 100 }, functions: { total: 4, covered: 1, percent: 25 } },
];

/** The twelve-file run's totals, as its `coverage` states them. */
export const TWELVE_TOTALS = {
  lines: { total: 1200, covered: 589, percent: 49.1 },
  functions: { total: 24, covered: 15, percent: 62.5 },
};

// ── The reads ───────────────────────────────────────────────────────────────

/** The three keys a read of a run's files adds to its `event`. */
export const FILE_READ_KEYS = ["coverageFileCount", "coverageFiles", "coverageRoot"] as const;

/** Which of the three file keys `event` carries, sorted. */
export function fileReadKeysOf(event: Record<string, unknown>): string[] {
  return FILE_READ_KEYS.filter((key) => key in event).sort();
}

/** A GET answered with whatever status the board gives it (served or in
 *  process): the status and the JSON body. */
export async function getAnswer(handle: Booted, route: string): Promise<Answer> {
  const res = await send(handle, route);
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { unparsed: text };
  }
  return { status: res.status, body: parsed };
}

/** The `event` of `GET /api/v2/events/<id><query>`, which must answer 200. */
export async function eventRead(handle: Booted, eventId: string, query = ""): Promise<Record<string, unknown>> {
  const route = `/api/v2/events/${eventId}${query}`;
  const answer = await getAnswer(handle, route);
  expect(answer.status, `GET ${route}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(200);
  expect(typeof answer.body.event, `GET ${route} answers an event`).toBe("object");
  return answer.body.event as Record<string, unknown>;
}

/** `value` without `keys`. */
export function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

// ── The query log ───────────────────────────────────────────────────────────

export interface QueryRecord {
  sql: string;
  /** The rows the statement handed back: each row of an `.all()`, `.values()` or `.iterate()`, the one row of a `.get()` that found one. */
  handed: unknown[];
}

/**
 * Every statement the store's own connection runs while `body` runs, with the
 * rows it handed back: the query-log instrumentation of the bounded-read
 * suites, keeping the rows themselves beside their count.
 */
export async function recordQueries(store: Store, body: () => Promise<unknown>): Promise<QueryRecord[]> {
  const db = dbOf(store);
  const query = db.query.bind(db);
  const records: QueryRecord[] = [];
  const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
    const stmt = query(sql) as Statement;
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "all" || prop === "values") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            records.push({ sql, handed: [...out] });
            return out;
          };
        }
        if (prop === "iterate") {
          return (...args: unknown[]) => {
            const out = [...(value as (...a: unknown[]) => Iterable<unknown>).apply(target, args)];
            records.push({ sql, handed: out });
            return out[Symbol.iterator]();
          };
        }
        if (prop === "get") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            records.push({ sql, handed: out !== null && out !== undefined ? [out] : [] });
            return out;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }) as typeof db.query);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return records;
}

/** The statements that name the files table, wherever in their text. */
export function filesTableStatements(records: readonly QueryRecord[]): QueryRecord[] {
  return records.filter((record) => /\brun_coverage_files\b/i.test(record.sql));
}

/** Whether a statement's text calls an aggregate function. */
export function callsAnAggregate(sql: string): boolean {
  return /\b(?:COUNT|MIN|MAX|SUM|TOTAL)\s*\(/i.test(sql);
}

/**
 * Whether a handed-back row is one of `files`' rows: it holds a file's name
 * beside that file's lines total. A count or a least-and-greatest-name
 * aggregate holds no lines total, so it is not one; `files` must be a run
 * whose file count is no file's lines total (the twelve-file run: 12, and 100).
 */
export function isFileRow(row: unknown, files: readonly CoverageFile[]): boolean {
  const values: unknown[] = Array.isArray(row)
    ? row
    : typeof row === "object" && row !== null
      ? Object.values(row)
      : [row];
  return files.some((file) => values.includes(file.path) && values.includes(file.lines.total));
}

/** What a read asked of the files table: its statements there, the file rows they handed back, and the other rows. */
export interface FilesTableUse {
  statements: QueryRecord[];
  fileRows: number;
  otherRows: number;
  /** The statements that handed back no file row. */
  rowless: QueryRecord[];
}

export function filesTableUse(records: readonly QueryRecord[], files: readonly CoverageFile[]): FilesTableUse {
  const statements = filesTableStatements(records);
  const handed = statements.flatMap((statement) => statement.handed);
  const fileRows = handed.filter((row) => isFileRow(row, files)).length;
  return {
    statements,
    fileRows,
    otherRows: handed.length - fileRows,
    rowless: statements.filter((statement) => !statement.handed.some((row) => isFileRow(row, files))),
  };
}

/** How many rows the statements reading `FROM <table>` handed back, counted as the bounded-read suites count them. */
export function rowsHandedFrom(records: readonly QueryRecord[], table: string): number {
  const reads = new RegExp(`\\bFROM\\s+${table}\\b`, "i");
  return records.filter((record) => reads.test(record.sql)).reduce((sum, record) => sum + record.handed.length, 0);
}

/** Every row the statements handed back, as one JSON text: what a search for a value that must not be read looks in. */
export function handedText(records: readonly QueryRecord[]): string {
  return JSON.stringify(records.map((record) => record.handed));
}
