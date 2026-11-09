// An oracle for Go coverprofile figures, read from the profile text alone and
// independent of the board's codec: covered statements over all statements,
// each block (`<file>:<start>,<end>`) counted once however many times the
// profile lists it, and covered when any of its copies has a count above 0.
// Also reads the captured `go tool cover -func` total, Go's own figure.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "go-coverprofile");

/** A captured file under `tests/fixtures/go-coverprofile/`, read as text. */
export function goCoverFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export interface ProfileFigure {
  /** Distinct blocks. */
  blocks: number;
  /** Block lines the profile holds, repeats included. */
  listed: number;
  total: number;
  covered: number;
}

/** The deduplicated statement figure of one profile text. */
export function profileFigure(text: string): ProfileFigure {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (!lines[0]?.startsWith("mode: ")) throw new Error("oracle: the profile has no mode line");
  const seen = new Map<string, { stmts: number; covered: boolean }>();
  for (const line of lines.slice(1)) {
    const match = /^(.+:\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    if (match === null) throw new Error(`oracle: not a block line: ${line}`);
    const [, block, stmts, count] = match as unknown as [string, string, string, string];
    const prior = seen.get(block);
    const covered = Number(count) > 0 || (prior?.covered ?? false);
    seen.set(block, { stmts: Number(stmts), covered });
  }
  let total = 0;
  let covered = 0;
  for (const block of seen.values()) {
    total += block.stmts;
    if (block.covered) covered += block.stmts;
  }
  return { blocks: seen.size, listed: lines.length - 1, total, covered };
}

/** The `total: (statements) N%` figure of a captured `go tool cover -func` output. */
export function coverFuncTotal(text: string): number {
  const match = /^total:\s+\(statements\)\s+([\d.]+)%$/m.exec(text);
  if (match === null) throw new Error("oracle: no total line in the cover -func output");
  return Number(match[1]);
}
