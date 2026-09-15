// CR-CRU-066 §S4 / AC6 — the DOCUMENTED CLI surface covers every verb the
// shipped `crucible-axi` console script actually dispatches.
//
// Spec: docs/changes/CR-CRU-066-install-provisions-not-runs-plus-serve.md
// §S4 + AC6.
//
// RELOCATED here by CR-CRU-132 §S4 (2026-09-15), unchanged. This block used to
// live at the foot of the now-deleted `tests/cli-axi.test.ts`, retired whole
// with the BUN fleet CLI (`cli/crucible-axi.ts`) its other describe covered.
// CR-CRU-132 §S4 retires that bun CLI outright — never published to npm,
// invoked by nothing, every verb redundant — and deleted its test file whole.
// These three tests were only ever
// co-located with it by the filename collision CR-CRU-066's own scope note
// called out: `install`/`serve` are verbs of the PYTHON console script
// (`[project.scripts] crucible-axi = "crucible_axi.cli:main"`, the one
// docs/RUNBOOK.md documents and operators actually run), NOT of the retired bun
// CLI. Their SUBJECT is untouched by that retirement, so the guard moves rather
// than dies — the same carve-out CR-CRU-132 §S2 makes for the `help[]` hints in
// `tests/axi-negotiation.test.ts`.
//
// What it guards: the documented command surface must cover every verb the
// shipped CLI dispatches — derived from the real `_COMMANDS` table in
// `crucible_axi/cli.py` rather than hardcoded, so the docs cannot drift from
// the code again (CR-CRU-066's whole failure mode).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The verbs the shipped `crucible-axi` console script really dispatches,
 * parsed out of `crucible_axi/cli.py`'s `_COMMANDS` table — the single source
 * of truth for the CLI's verb surface.
 */
function shippedCrucibleAxiVerbs(): string[] {
  const source = readFileSync(
    join(import.meta.dir, "..", "crucible_axi", "cli.py"),
    "utf8",
  );
  const table = source.match(/^_COMMANDS\s*=\s*\{([\s\S]*?)^\}/m);
  if (table === null) return [];
  return [...table[1].matchAll(/"([a-z][a-z0-9-]*)"\s*:/g)].map((m) => m[1]);
}

describe("CR-CRU-066 §S4/AC6 documented CLI surface vs the shipped verb table", () => {
  test("`crucible_axi/cli.py` dispatches both `install` and `serve` (guards the parse)", () => {
    const verbs = shippedCrucibleAxiVerbs();
    expect(verbs).toContain("install");
    expect(verbs).toContain("serve");
  });

  test("README documents `crucible-axi <verb>` for EVERY dispatched verb", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    const verbs = shippedCrucibleAxiVerbs();
    expect(verbs.length).toBeGreaterThan(0);

    const undocumented = verbs.filter((verb) => !readme.includes(`crucible-axi ${verb}`));
    expect(undocumented).toEqual([]);
  });

  test("docs/RUNBOOK.md documents the run verb (`serve`) it tells operators to use", () => {
    const runbook = readFileSync(
      join(import.meta.dir, "..", "docs", "RUNBOOK.md"),
      "utf8",
    );
    expect(shippedCrucibleAxiVerbs()).toContain("serve");
    expect(runbook).toContain("crucible-axi serve");
  });
});
