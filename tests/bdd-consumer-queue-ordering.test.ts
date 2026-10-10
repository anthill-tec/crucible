// CR-CRU-015 §S4's queue criterion — "`docs/changes/README.md`'s CR-CRU-018
// row lists `015` among its dependencies, so the queue's own ordering carries
// the fact that CR-018's viewport evidence renders in this section."
//
// A RAIL, AND BORN GREEN. Measured on this branch: the CR-CRU-018 row already
// reads `015, 016, 093`. It is asserted anyway, and declared as such, for the
// reason §S4 gives: CR-018's own ACs are written ON this suite ("the existing
// desktop BDD scenarios re-run green with zero modification"), so the ordering
// is a fact the queue must keep carrying — and the queue is a hand-edited
// Markdown table, which is exactly the kind of record a later edit drops
// silently. The same precedent tests/queue-header-names-the-planned-release
// .test.ts sets for a one-fact guard over this file.
//
// The row is PARSED, never string-matched, so re-ordering the dependency list
// or re-wording the title cannot false-fail it.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE_PATH = path.join(REPO_ROOT, "docs/changes/README.md");

interface QueueRow {
  cr: string;
  dependsOn: string[];
}

/** The queue table as the `queue-file` verb reads it: a Markdown row per CR,
 *  whose first cell links the spec and whose `Depends on` cell is a
 *  comma-separated list of bare CR numbers. */
function parseQueue(markdown: string): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    const cr = /\[(CR-[A-Z]+-\d+)\]/.exec(cells[0] ?? "")?.[1];
    if (cr === undefined) continue;
    const dependsOn = (cells[4] ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d !== "" && d !== "—" && d !== "-");
    rows.push({ cr, dependsOn });
  }
  return rows;
}

describe("CR-CRU-015 §S4 — the queue carries CR-018's dependency on this CR (RAIL, born green)", () => {
  test("the CR-CRU-018 row lists 015 among its dependencies, and 015 is itself a queue row", () => {
    const rows = parseQueue(readFileSync(QUEUE_PATH, "utf8"));

    // Non-vacuity: the table really parsed. A README edit that broke the shape
    // would otherwise make every assertion below pass on an empty list.
    expect(rows.length).toBeGreaterThan(20);

    const cr018 = rows.find((r) => r.cr === "CR-CRU-018");
    expect(cr018).toBeDefined();
    expect(cr018!.dependsOn).toContain("015");

    // The dependency names a real row, not a number that went away — an
    // ordering fact is only a fact while both ends exist.
    expect(rows.some((r) => r.cr === "CR-CRU-015")).toBe(true);

    // BOUND — the row's other declared dependencies are untouched by this CR:
    // §S4 ADDS `015` to the list, it does not rewrite it.
    expect(cr018!.dependsOn).toContain("016");
    expect(cr018!.dependsOn).toContain("093");
  });
});
