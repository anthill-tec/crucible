// The coverage-percent oracle: Python's `round(covered / total * 100, 1)` (0
// when total is 0) for every 0 <= covered <= total < 1500, as the clients
// round a coverage axis today. Written by
// tests/fixtures/coverage-percent-oracle.gen.py into
// tests/fixtures/coverage-percent-oracle.json (encoding described there); this
// module decodes it and REFUSES a table whose bytes or extent are not the ones
// the generator wrote, so a test can never pass against a truncated oracle.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

interface OracleFile {
  totalBelow: number;
  pairs: number;
  sha256: string;
  data: string;
}

export interface CoveragePercentOracle {
  /** Every total in the table is below this. */
  totalBelow: number;
  /** How many (covered, total) pairs the table holds. */
  pairs: number;
  /** Python's answer for one pair, in tenths of a percent. */
  tenths(covered: number, total: number): number;
  /** Python's answer for one pair, as the percent number. */
  percent(covered: number, total: number): number;
}

function rowStart(total: number): number {
  return (total * (total + 1)) / 2;
}

export function loadCoveragePercentOracle(): CoveragePercentOracle {
  const file = JSON.parse(
    readFileSync(new URL("../fixtures/coverage-percent-oracle.json", import.meta.url), "utf8"),
  ) as OracleFile;
  const stream = gunzipSync(Buffer.from(file.data, "base64"));
  const digest = createHash("sha256").update(stream).digest("hex");
  if (digest !== file.sha256) {
    throw new Error("coverage-percent oracle: decoded bytes do not match the generator's sha256");
  }
  const expectedPairs = rowStart(file.totalBelow);
  if (file.pairs !== expectedPairs) {
    throw new Error(`coverage-percent oracle: ${file.pairs} pairs, expected ${expectedPairs}`);
  }

  const table = new Uint16Array(expectedPairs);
  let offset = 0;
  let index = 0;
  for (let total = 0; total < file.totalBelow; total++) {
    let previous = 0;
    for (let covered = 0; covered <= total; covered++) {
      let delta = 0;
      let shift = 0;
      for (;;) {
        const byte = stream[offset++];
        if (byte === undefined) throw new Error("coverage-percent oracle: stream ends early");
        delta += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      previous += delta;
      table[index++] = previous;
    }
  }
  if (offset !== stream.length) {
    throw new Error("coverage-percent oracle: trailing bytes after the last pair");
  }

  const tenths = (covered: number, total: number): number => {
    if (!(total >= 0 && total < file.totalBelow && covered >= 0 && covered <= total)) {
      throw new Error(`coverage-percent oracle: (${covered}, ${total}) is outside the table`);
    }
    return table[rowStart(total) + covered]!;
  };
  return {
    totalBelow: file.totalBelow,
    pairs: expectedPairs,
    tenths,
    percent: (covered, total) => tenths(covered, total) / 10,
  };
}
