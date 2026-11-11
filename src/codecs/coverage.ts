// Coverage codecs: each reads one coverage report text into summed counters
// and the files those counters came from, and several texts are summed as one
// before the axes are built. A text that carries none of its codec's records
// is undecodable and throws.
import type { Coverage, CoverageAxis, CoverageFile } from "../types.ts";

/** One axis's summed counters, before its percent is computed. */
interface Counts {
  total: number;
  covered: number;
}

/**
 * One file a coverage text states, under the name the text writes: its own
 * lines counters, and its functions counters when the format states any. A
 * text may state one name more than once; `decodeCoverageWithFiles` joins them.
 */
interface FileCounts {
  path: string;
  lines: Counts;
  functions?: Counts;
}

/** What a coverage codec reads from one text: per-axis counters, and the text's files. */
interface CoverageCounts {
  lines: Counts;
  functions?: Counts;
  branches?: Counts;
  files: FileCounts[];
}

export interface CoverageCodec {
  /** Reads one text's counters and files; throws when the text carries none of the codec's records. */
  read(text: string): CoverageCounts;
}

/**
 * A coverage axis's percent: the double `covered / total * 100` rounded to
 * one decimal by its exact decimal value, ties to even — the result Python's
 * `round(x, 1)` gives — and 0 when `total` is 0.
 *
 * `toFixed` already rounds the double's exact value; it differs from Python
 * only on an exact tie, which it breaks upward. A double is an exact tie at
 * one decimal only when its fraction is .25 or .75 (no other hundredths
 * ending in 5 is representable), i.e. when `x * 4` — exact in binary — is an
 * odd integer; there the even tenth is taken.
 */
export function coveragePercent(covered: number, total: number): number {
  if (total === 0) return 0;
  const x = (covered / total) * 100;
  const quarters = x * 4;
  if (Number.isInteger(quarters) && quarters % 2 === 1) {
    const below = Math.floor(x * 10);
    return (below % 2 === 0 ? below : below + 1) / 10;
  }
  return Number(x.toFixed(1));
}

function axis(counts: Counts): CoverageAxis {
  return {
    total: counts.total,
    covered: counts.covered,
    percent: coveragePercent(counts.covered, counts.total),
  };
}

/** A counter field as an integer; an empty field is 0. */
function integer(field: string, what: string): number {
  const trimmed = field.trim();
  if (trimmed.length === 0) return 0;
  if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(`${what} is not an integer: '${trimmed}'`);
  return Number.parseInt(trimmed, 10);
}

/**
 * lcov: `LF`/`LH` sum into lines, `FNF`/`FNH` into functions; branches are not
 * read. Each `SF:` record is a file, named as the record writes it, holding
 * the counters stated up to its `end_of_record`.
 */
const lcov: CoverageCodec = {
  read(text: string): CoverageCounts {
    const lines: Counts = { total: 0, covered: 0 };
    const functions: Counts = { total: 0, covered: 0 };
    const files: FileCounts[] = [];
    let record: Required<FileCounts> | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        record = {
          path: line.slice(3),
          lines: { total: 0, covered: 0 },
          functions: { total: 0, covered: 0 },
        };
        files.push(record);
      } else if (line === "end_of_record") {
        record = undefined;
      } else if (line.startsWith("LF:")) {
        const count = integer(line.slice(3), "LF");
        lines.total += count;
        if (record !== undefined) record.lines.total += count;
      } else if (line.startsWith("LH:")) {
        const count = integer(line.slice(3), "LH");
        lines.covered += count;
        if (record !== undefined) record.lines.covered += count;
      } else if (line.startsWith("FNF:")) {
        const count = integer(line.slice(4), "FNF");
        functions.total += count;
        if (record !== undefined) record.functions.total += count;
      } else if (line.startsWith("FNH:")) {
        const count = integer(line.slice(4), "FNH");
        functions.covered += count;
        if (record !== undefined) record.functions.covered += count;
      }
    }
    if (files.length === 0) throw new Error("no SF: record");
    return { lines, functions, files };
  },
};

/** One CSV row's fields, honouring double-quoted fields. */
function csvFields(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

const JACOCO_AXES = {
  lines: ["LINE_MISSED", "LINE_COVERED"],
  functions: ["METHOD_MISSED", "METHOD_COVERED"],
  branches: ["BRANCH_MISSED", "BRANCH_COVERED"],
} as const;

/**
 * jacoco: the CSV's `LINE_*`, `METHOD_*` and `BRANCH_*` columns sum into lines,
 * functions and branches. Each row is a file with the row's lines and
 * functions: the CSV names a class and no source file, so the file is named
 * `PACKAGE.CLASS`, or `CLASS` alone when `PACKAGE` is empty.
 */
const jacoco: CoverageCodec = {
  read(text: string): CoverageCounts {
    const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
    const header = rows.length > 0 ? csvFields(rows[0]!) : [];
    const column = (name: string): number => header.indexOf(name);
    const missing = Object.values(JACOCO_AXES)
      .flat()
      .filter((name) => column(name) < 0);
    if (missing.length > 0) throw new Error(`no header row with ${missing.join(", ")}`);
    const counts: Required<CoverageCounts> = {
      lines: { total: 0, covered: 0 },
      functions: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
      files: [],
    };
    for (const row of rows.slice(1)) {
      const fields = csvFields(row);
      const named = (name: string): string => (column(name) < 0 ? "" : (fields[column(name)] ?? ""));
      const pkg = named("PACKAGE");
      const file: Required<FileCounts> & { branches: Counts } = {
        path: pkg.length > 0 ? `${pkg}.${named("CLASS")}` : named("CLASS"),
        lines: { total: 0, covered: 0 },
        functions: { total: 0, covered: 0 },
        branches: { total: 0, covered: 0 },
      };
      for (const [name, [missedColumn, coveredColumn]] of Object.entries(JACOCO_AXES)) {
        const missed = integer(fields[column(missedColumn)] ?? "", missedColumn);
        const covered = integer(fields[column(coveredColumn)] ?? "", coveredColumn);
        for (const target of [counts, file]) {
          const sum = target[name as keyof typeof JACOCO_AXES];
          sum.covered += covered;
          sum.total += missed + covered;
        }
      }
      // Branches are not kept per file.
      counts.files.push({ path: file.path, lines: file.lines, functions: file.functions });
    }
    return counts;
  },
};

/** A coverprofile block line: `file:startLine.startCol,endLine.endCol numStmt count`. */
const GO_BLOCK = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/;

/**
 * go-coverprofile: statement coverage on the lines axis, each block weighted by
 * its statement count. A block listed more than once (`-coverpkg` lists it once
 * per test package) counts once, covered if any copy counted. A profile states
 * no functions and no branches. Each distinct file of the blocks is a file,
 * named by the block's text before its span, holding its blocks' statements.
 */
const goCoverprofile: CoverageCodec = {
  read(text: string): CoverageCounts {
    const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
    if (rows.length === 0 || !/^mode: (set|count|atomic)$/.test(rows[0]!)) {
      throw new Error("no mode: line");
    }
    const blocks = new Map<string, { file: string; statements: number; covered: boolean }>();
    for (const row of rows.slice(1)) {
      const match = GO_BLOCK.exec(row);
      if (match === null) throw new Error(`not a coverprofile block: '${row}'`);
      const [, file, span, statements, count] = match;
      const block = `${file!}:${span!}`;
      const seen = blocks.get(block);
      const covered = Number.parseInt(count!, 10) > 0;
      if (seen === undefined) {
        blocks.set(block, { file: file!, statements: Number.parseInt(statements!, 10), covered });
      } else seen.covered ||= covered;
    }
    const lines: Counts = { total: 0, covered: 0 };
    const files = new Map<string, FileCounts>();
    for (const { file, statements, covered } of blocks.values()) {
      let held = files.get(file);
      if (held === undefined) {
        held = { path: file, lines: { total: 0, covered: 0 } };
        files.set(file, held);
      }
      for (const sum of [lines, held.lines]) {
        sum.total += statements;
        if (covered) sum.covered += statements;
      }
    }
    return { lines, files: [...files.values()] };
  },
};

export const coverageCodecs: Map<string, CoverageCodec> = new Map<string, CoverageCodec>([
  ["lcov", lcov],
  ["jacoco", jacoco],
  ["go-coverprofile", goCoverprofile],
]);

/** Adds an optional axis's counters into the sum, opening the axis when only the addend carries it. */
function addAxis(sum: Counts | undefined, counts: Counts | undefined): Counts | undefined {
  if (counts === undefined) return sum;
  if (sum === undefined) return { ...counts };
  return { total: sum.total + counts.total, covered: sum.covered + counts.covered };
}

/** Several texts of one codec summed as ONE coverage object; throws on the first undecodable text. */
export function decodeCoverage(codec: CoverageCodec, texts: string[]): Coverage {
  return decodeCoverageWithFiles(codec, texts).coverage;
}

/**
 * Several texts of one codec as ONE coverage object and the files it came
 * from; throws on the first undecodable text. A name stated more than once,
 * in one text or in several, is one file whose counters are added, in the
 * order the names first appear. A file whose functions total is 0, or
 * unstated, has no functions axis.
 */
export function decodeCoverageWithFiles(
  codec: CoverageCodec,
  texts: string[],
): { coverage: Coverage; files: CoverageFile[] } {
  let sum: Omit<CoverageCounts, "files"> | undefined;
  const joined = new Map<string, FileCounts>();
  for (const text of texts) {
    const { files, ...counts } = codec.read(text);
    for (const file of files) {
      const held = joined.get(file.path);
      if (held === undefined) {
        joined.set(file.path, {
          path: file.path,
          lines: { ...file.lines },
          ...(file.functions !== undefined ? { functions: { ...file.functions } } : {}),
        });
        continue;
      }
      held.lines.total += file.lines.total;
      held.lines.covered += file.lines.covered;
      const functions = addAxis(held.functions, file.functions);
      if (functions !== undefined) held.functions = functions;
    }
    if (sum === undefined) {
      sum = counts;
      continue;
    }
    sum.lines.total += counts.lines.total;
    sum.lines.covered += counts.lines.covered;
    sum.functions = addAxis(sum.functions, counts.functions);
    sum.branches = addAxis(sum.branches, counts.branches);
  }
  if (sum === undefined) throw new Error("no coverage text");
  return {
    coverage: {
      lines: axis(sum.lines),
      ...(sum.functions !== undefined ? { functions: axis(sum.functions) } : {}),
      ...(sum.branches !== undefined ? { branches: axis(sum.branches) } : {}),
    },
    files: [...joined.values()].map((file) => ({
      path: file.path,
      lines: axis(file.lines),
      ...(file.functions !== undefined && file.functions.total > 0
        ? { functions: axis(file.functions) }
        : {}),
    })),
  };
}
