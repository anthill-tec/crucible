// Coverage codecs: each reads one coverage report text into summed counters,
// and several texts are summed as one before the axes are built. A text that
// carries none of its codec's records is undecodable and throws.
import type { Coverage, CoverageAxis } from "../types.ts";

/** One axis's summed counters, before its percent is computed. */
interface Counts {
  total: number;
  covered: number;
}

/** What a coverage codec reads from one text: per-axis counters. */
interface CoverageCounts {
  lines: Counts;
  functions: Counts;
  branches?: Counts;
}

export interface CoverageCodec {
  /** Reads one text's counters; throws when the text carries none of the codec's records. */
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

/** lcov: `LF`/`LH` sum into lines, `FNF`/`FNH` into functions; branches are not read. */
const lcov: CoverageCodec = {
  read(text: string): CoverageCounts {
    const lines: Counts = { total: 0, covered: 0 };
    const functions: Counts = { total: 0, covered: 0 };
    let sourceFiles = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("SF:")) sourceFiles++;
      else if (line.startsWith("LF:")) lines.total += integer(line.slice(3), "LF");
      else if (line.startsWith("LH:")) lines.covered += integer(line.slice(3), "LH");
      else if (line.startsWith("FNF:")) functions.total += integer(line.slice(4), "FNF");
      else if (line.startsWith("FNH:")) functions.covered += integer(line.slice(4), "FNH");
    }
    if (sourceFiles === 0) throw new Error("no SF: record");
    return { lines, functions };
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

/** jacoco: the CSV's `LINE_*`, `METHOD_*` and `BRANCH_*` columns sum into lines, functions and branches. */
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
    };
    for (const row of rows.slice(1)) {
      const fields = csvFields(row);
      for (const [name, [missedColumn, coveredColumn]] of Object.entries(JACOCO_AXES)) {
        const missed = integer(fields[column(missedColumn)] ?? "", missedColumn);
        const covered = integer(fields[column(coveredColumn)] ?? "", coveredColumn);
        const target = counts[name as keyof typeof JACOCO_AXES];
        target.covered += covered;
        target.total += missed + covered;
      }
    }
    return counts;
  },
};

export const coverageCodecs: Map<string, CoverageCodec> = new Map<string, CoverageCodec>([
  ["lcov", lcov],
  ["jacoco", jacoco],
]);

/** Several texts of one codec summed as ONE coverage object; throws on the first undecodable text. */
export function decodeCoverage(codec: CoverageCodec, texts: string[]): Coverage {
  let sum: CoverageCounts | undefined;
  for (const text of texts) {
    const counts = codec.read(text);
    if (sum === undefined) {
      sum = counts;
      continue;
    }
    sum.lines.total += counts.lines.total;
    sum.lines.covered += counts.lines.covered;
    sum.functions.total += counts.functions.total;
    sum.functions.covered += counts.functions.covered;
    if (sum.branches !== undefined && counts.branches !== undefined) {
      sum.branches.total += counts.branches.total;
      sum.branches.covered += counts.branches.covered;
    }
  }
  if (sum === undefined) throw new Error("no coverage text");
  return {
    lines: axis(sum.lines),
    functions: axis(sum.functions),
    ...(sum.branches !== undefined ? { branches: axis(sum.branches) } : {}),
  };
}
