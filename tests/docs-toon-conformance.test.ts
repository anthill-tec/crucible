// CR-CRU-046 C4 — §S5 + §S5b docs-assertion tests (RED).
//
// Spec: docs/changes/CR-CRU-046-toon-conformance.md
//   §S5  — docs/research/DN-crucible-toon-subset.md is RETIRED, not deleted: the
//          normative "our fleet's private subset is the wire spec" framing must
//          be replaced by a short statement that Crucible speaks TOON per the
//          OFFICIAL spec (spec home + both pinned implementations:
//          `@toon-format/toon` w/ version, and `clients/toon.py` as our
//          conformant port validated against it), a REMAINING historical note
//          on why the subset existed, and the §S2 revisit pin (adopt PyPI
//          `toon-format` once a working release ships).
//   §S5b — docs/research/PRD-crucible-v2.md's resolved-note (line ~446) drops
//          the superseded "pin the documented subset" clause and replaces it
//          with the 2026-07-28 reversal, leaving neighbouring resolved-note
//          entries (`tier`, `playwright`, retention 100) untouched.
//   §S3 (invocation sweep) — no doc under docs/RUNBOOK.md, docs/research/, or
//          AGENTS.md (if it exists) may present `python3 clients/<x>-crucible.py`
//          as THE documented invocation; the documented way is `uv run`.
//
// RED phase: this branch (through C3) has not touched either doc for this
// cycle. The DN still opens with its private wire-spec-authority claim and
// carries zero mention of the official spec/libraries; the PRD resolved-note
// still records the superseded subset decision verbatim. Every assertion
// below is expected to FAIL for one of those reasons, EXCEPT the file-exists,
// PRD-neighbour-anchor, and invocation-sweep tests, which guard the edit
// rather than drive it (see per-test comments for the honest born-state).
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// Slices the PRD's trailing "(Resolved 2026-07-14: ...)" parenthetical block —
// it is the last content in the file, so there is no next heading to bound it
// against; take everything from its opening marker to EOF.
function extractResolvedNote(md: string): string {
  const marker = "(Resolved 2026-07-14:";
  const idx = md.indexOf(marker);
  if (idx === -1) {
    throw new Error(`resolved-note block not found (marker: "${marker}")`);
  }
  return md.slice(idx);
}

const DN_PATH = join("docs", "research", "DN-crucible-toon-subset.md");
const PRD_PATH = join("docs", "research", "PRD-crucible-v2.md");

// ---------------------------------------------------------------------------
// §S5 — docs/research/DN-crucible-toon-subset.md (retired, not deleted)
// ---------------------------------------------------------------------------

describe("§S5 DN — the subset DN is retired in place, not deleted", () => {
  test("the file still exists (CR-005/CR-030/storyboard all reference it)", () => {
    // BORN GREEN — the CR is explicit "do not delete the file"; this guards
    // against GREEN reaching for `rm` as the "retire" mechanism.
    expect(existsSync(join(REPO_ROOT, DN_PATH))).toBe(true);
  });

  test("states Crucible speaks TOON per the official spec: spec home + @toon-format/toon w/ version", () => {
    // BORN RED — the current DN never mentions the official spec or any
    // third-party library; it is entirely the hand-rolled subset write-up.
    const dn = readText(DN_PATH);

    // Spec home — either the canonical domain or the GitHub org string the CR
    // itself cites ("the official TOON spec + implementations
    // (github.com/toon-format)").
    expect(dn).toMatch(/toonformat\.dev|toon-format/i);

    // The npm-side pinned implementation, with its ACTUAL pinned version (read
    // from package.json so this test doesn't rot the moment the pin bumps).
    const pkg = JSON.parse(readText("package.json")) as {
      dependencies?: Record<string, string>;
    };
    const rawVersion = pkg.dependencies?.["@toon-format/toon"];
    expect(rawVersion).toBeTruthy();
    const pinnedVersion = (rawVersion as string).replace(/^[\^~]/, "");

    expect(dn).toContain("@toon-format/toon");
    expect(dn).toContain(pinnedVersion);
  });

  test("states clients/toon.py is our conformant port, validated against the official library", () => {
    // BORN RED — no such statement exists in the current DN.
    const dn = readText(DN_PATH);

    expect(dn).toMatch(/clients\/toon\.py|`toon\.py`/);
    expect(dn).toMatch(/conformant|validated/i);
  });

  test("the subset-normative framing is gone: wire-spec-authority claim no longer present", () => {
    // BORN RED — this EXACT claim is the file's opening sentence today:
    // "This document IS the wire spec for the TOON responses emitted by
    // `src/toon.ts`". It is the load-bearing normative-authority phrase the
    // CR says must disappear once the official spec, not this doc, is the
    // wire contract.
    const dn = readText(DN_PATH);
    expect(dn).not.toMatch(/wire spec for the TOON responses/i);
  });

  test("the subset-normative framing is gone: 'subset ... is pinned' claim no longer present", () => {
    // BORN RED — today's text: "The subset has exactly FOUR constructs. It is
    // pinned: producer and consumers are both our fleet ...". This is the
    // doc's normative pin claim (self-scoped to "our fleet only", which
    // contradicts adopting an external spec as the contract) — must go.
    const dn = readText(DN_PATH);
    expect(dn).not.toMatch(/It is pinned:\s*\n?\s*producer and consumers are both our fleet/i);
  });

  test("the subset-normative framing is gone: the already-fired revisit trigger sentence no longer present", () => {
    // BORN RED — today's text ends the opening paragraph with "revisit only
    // if third-party TOON tooling arrives." That trigger has now FIRED (per
    // the CR's own Context: "It has, in 8 languages") so keeping this exact
    // still-pending phrasing would misrepresent the current state; it must be
    // replaced by the historical note + the forward-looking §S2 revisit pin
    // (checked separately below).
    const dn = readText(DN_PATH);
    expect(dn).not.toMatch(/revisit only if third-party TOON\s*\n?\s*tooling arrives/i);
  });

  test("a historical note on why the subset existed is preserved", () => {
    // BORN RED — the current DN carries no "why" framing at all, only the
    // construct rules themselves; GREEN must ADD a historical note (not just
    // delete the normative claims), per the CR: "keep the historical note
    // about why a subset existed."
    const dn = readText(DN_PATH);
    expect(dn).toMatch(/\b(originally|historically|previously|used to|when (this|the) subset was)\b/i);
  });

  test("records the §S2 revisit pin: adopt PyPI toon-format once a working release ships", () => {
    // BORN RED — absent entirely today.
    const dn = readText(DN_PATH);
    expect(dn).toMatch(/PyPI/i);
    expect(dn).toMatch(/toon-format/i);
    expect(dn).toMatch(/ships a working release|working release ships|once (a )?working release/i);
  });
});

// ---------------------------------------------------------------------------
// §S5b — docs/research/PRD-crucible-v2.md resolved-note reversal
// ---------------------------------------------------------------------------

describe("§S5b PRD — resolved-note records the 2026-07-28 TOON reversal", () => {
  test("the superseded 'pin the documented subset' clause is gone", () => {
    // BORN RED — this is the EXACT current clause (PRD-crucible-v2.md:446-448):
    // "TOON: pin the documented Crucible subset rather than vendoring the
    // reference serializer — both producer and consumers are our own fleet."
    const prd = readText(PRD_PATH);
    const note = extractResolvedNote(prd);
    expect(note).not.toMatch(
      /pin the\s*\n?\s*documented Crucible subset rather than vendoring the reference serializer/i,
    );
  });

  test("a replacement clause records the reversal: official TOON, the spec is the contract", () => {
    // BORN RED — absent today; only the superseded clause is present.
    const prd = readText(PRD_PATH);
    const note = extractResolvedNote(prd);
    expect(note).toMatch(/official TOON/i);
    expect(note).toMatch(/spec is the contract/i);
  });

  test("surrounding resolved-note entries are untouched by the edit", () => {
    // BORN GREEN — these anchor phrases are present in the CURRENT file
    // (tier/playwright/retention entries preceding the TOON clause); this
    // guards against a sloppy GREEN edit eating its neighbours while
    // rewriting the TOON clause.
    const prd = readText(PRD_PATH);
    const note = extractResolvedNote(prd);
    expect(note).toMatch(/`tier`\s*\n?\s*explicitly/);
    expect(note).toMatch(/`playwright`\s*\n?\s*codec/);
    expect(note).toMatch(/retention:\s*100/);
  });
});

// ---------------------------------------------------------------------------
// Invocation sweep — `python3 clients/<x>-crucible.py` must not remain as THE
// documented invocation anywhere in scope (docs/RUNBOOK.md, docs/research/,
// AGENTS.md if present); the documented way is `uv run` (§S3).
// ---------------------------------------------------------------------------

describe("invocation sweep — no doc presents python3 as the documented client invocation", () => {
  // Enumeration performed by hand before writing this test (2026-08-01):
  //   - docs/RUNBOOK.md:        zero mentions of any *-crucible.py client at
  //                             all (it documents the SERVER only: start/stop/
  //                             health/env vars) — nothing to pin.
  //   - docs/research/*.md:     `bun-crucible.py` / `rust-crucible.py` / etc.
  //                             appear only as bare script-name references in
  //                             prose/tables (DN-crucible-api-reconstruction.md,
  //                             PRD-crucible-v2.md) — never prefixed with
  //                             `python3` as a runnable invocation — nothing
  //                             to pin.
  //   - AGENTS.md:              does not exist in this repo.
  //   - The ONLY `python3 ...crucible.py` invocation string anywhere under
  //     docs/ lives in docs/changes/CR-CRU-003-v1-shim.md:65, an historical
  //     CR-file AC, explicitly excluded from this sweep's scope per the
  //     dispatch brief.
  // Honest finding: the in-scope enumeration is EMPTY — none of the three
  // scoped locations genuinely present the python3 invocation today, so this
  // is a GUARD test (BORN GREEN), not a driving RED test: it protects against
  // a future/careless edit re-introducing the stale invocation while the DN/
  // PRD docs are being rewritten in this same cycle.
  const invocationPattern = /python3\s+(clients\/)?[\w-]*crucible\.py/i;

  test("docs/RUNBOOK.md does not present a python3 client invocation", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    expect(runbook).not.toMatch(invocationPattern);
  });

  test("docs/research/DN-crucible-toon-subset.md does not present a python3 client invocation", () => {
    const dn = readText(DN_PATH);
    expect(dn).not.toMatch(invocationPattern);
  });

  test("docs/research/PRD-crucible-v2.md does not present a python3 client invocation", () => {
    const prd = readText(PRD_PATH);
    expect(prd).not.toMatch(invocationPattern);
  });

  test("docs/research/DN-crucible-api-reconstruction.md does not present a python3 client invocation", () => {
    const dn = readText(join("docs", "research", "DN-crucible-api-reconstruction.md"));
    expect(dn).not.toMatch(invocationPattern);
  });

  test("AGENTS.md, if present, does not present a python3 client invocation", () => {
    const agentsPath = join(REPO_ROOT, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      // No AGENTS.md in this repo today — nothing to sweep. Assert the
      // non-existence explicitly so this test still exercises something
      // observable rather than vacuously no-op-ing.
      expect(existsSync(agentsPath)).toBe(false);
      return;
    }
    const agents = readFileSync(agentsPath, "utf8");
    expect(agents).not.toMatch(invocationPattern);
  });
});
