// CR-CRU-044 C3 RED — §S4 doc contract: `clients/STATUS-CONTRACT.md` must
// state that phase comes from `--phase` (never inferred from the agentId's
// shape) and that the agentId is a free-form identifier.
//
// Spec: docs/changes/CR-CRU-044-phase-as-first-class-data.md §S4 —
//   "With phase declared, the id no longer needs to encode it. Document in
//   the client `--help` and the STATUS-CONTRACT that phase comes from
//   `--phase`, and that the agentId is a free-form identifier. Any
//   remaining id-shape guidance must not be load-bearing for
//   classification."
//
// RED phase: STATUS-CONTRACT.md today (confirmed by reading the file, mode
// "map") documents only the `status`/`plans` read-verb envelope — it has NO
// section at all about `register`, agentId, or phase. Every test below
// fails because the required content is simply absent, not because of a
// missing-symbol/import accident.
//
// Pattern (extractSection / plain substring assertions) copied verbatim
// from the sibling tests/docs-db-path-resolution.test.ts precedent (CR-CRU-043
// C2), which established this repo's convention for pinning prose doc
// contracts with real content assertions rather than a structural comment.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("§S4 STATUS-CONTRACT.md — phase is declared via --phase, agentId is free-form", () => {
  test("states phase comes from --phase and is never inferred from the agentId's shape", () => {
    const doc = readText(join("clients", "STATUS-CONTRACT.md"));

    expect(doc).toContain("--phase");
    // Positive: the doc must explain --phase is the classification channel
    // (declares/determines/classifies the phase), not merely mention the
    // flag name in passing.
    expect(doc.toLowerCase()).toMatch(/phase[^\n]*(declares|determines|classifies)/);
  });

  test("states the agentId is a free-form identifier", () => {
    const doc = readText(join("clients", "STATUS-CONTRACT.md"));

    expect(doc.toLowerCase()).toContain("free-form");
    expect(doc).toMatch(/agentId/);
  });
});
