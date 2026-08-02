// CR-CRU-044 C3 RED (original) — §S4 doc contract: `clients/STATUS-CONTRACT.md`
// must state that phase comes from `--phase` (never inferred from the
// agentId's shape) and that the agentId is a free-form identifier.
//
// CR-CRU-059 C3 RED (this update) — §S0 renamed the ontology-contradicting
// `phase` field to `role` fleet-wide (DN-model-b-language.md §1: RED/GREEN/
// VERIFY/FIX are ROLES; phase is merely the scope they act in). The clients
// already speak `--role` (verified live: `python3 clients/bun-crucible.py
// register --help` on this branch shows `--role`, not `--phase`), but
// `clients/STATUS-CONTRACT.md` — the versioned contract Model-B's generated
// hook pins — still documents the superseded `--phase` flag in six places and
// never mentions `--role` at all (grep-verified before writing this file: zero
// matches for `--role\b` in STATUS-CONTRACT.md; `--phase` appears at lines
// 104, 108, 110, 113, 116, 142, 146). Renamed this file from
// docs-agent-phase-channel.test.ts -> docs-agent-role-channel.test.ts (git mv)
// because its subject is now the ROLE channel doc contract, not phase.
//
// This CR also folds §S1 (identity.source enum validation) onto the SAME
// route — STATUS-CONTRACT.md documents `identity.source` nowhere either
// (zero matches for `--source`, `claude-md`, `package-json`, `git-repo`
// verified before writing this file), so its doc contract belongs here too.
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

const STATUS_CONTRACT_PATH = join("clients", "STATUS-CONTRACT.md");

describe("§S0 STATUS-CONTRACT.md — role is declared via --role, agentId is free-form (CR-CRU-059 rename)", () => {
  test("states role comes from --role and is never inferred from the agentId's shape", () => {
    // BORN RED — "--role" does not appear anywhere in the file today (grep-
    // verified: zero matches for `--role\b`); the classification-channel
    // sentence still names "--phase".
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc).toContain("--role");
    // Positive: the doc must explain --role is the classification channel
    // (declares/determines/classifies the role), not merely mention the
    // flag name in passing.
    expect(doc.toLowerCase()).toMatch(/role[^\n]*(declares|determines|classifies)/);
  });

  test("no longer documents the superseded --phase flag anywhere (§S0 clean rename, no alias)", () => {
    // BORN RED — today's file uses "--phase" at six sites (the classification
    // sentence, the "required on register" bullet + its enum-value clause,
    // the "--phase report" example, the "--phase RED" id-shape example, and
    // the two cycle-binding-section mentions "--phase one of" / "--phase
    // ORCHESTRATOR and --phase report"). §S0's compatibility ruling is a
    // CLEAN BREAK — no phase alias, no dual-key handling — so the doc must
    // not keep advertising the retired flag either.
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc).not.toMatch(/--phase\b/);
  });

  test("states the agentId is a free-form identifier (regression guard — unaffected by the rename)", () => {
    // BORN GREEN today (present already) — pinned so a careless rewrite of
    // the surrounding paragraph doesn't drop this unrelated, still-true
    // sentence while swapping phase for role.
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc.toLowerCase()).toContain("free-form");
    expect(doc).toMatch(/agentId/);
  });
});

describe("§S1 STATUS-CONTRACT.md — the identity.source enum contract is documented (CR-CRU-059)", () => {
  test("documents the --source flag and the exact four-member enum", () => {
    // BORN RED — "--source" and every enum member are absent from the file
    // today (grep-verified: zero matches for "--source", "claude-md",
    // "package-json", "git-repo" anywhere in STATUS-CONTRACT.md).
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc).toContain("--source");
    expect(doc).toContain("claude-md");
    expect(doc).toContain("package-json");
    expect(doc).toContain("git-repo");
    expect(doc).toContain("manual");
  });

  test("states an out-of-enum source is refused by the server with a 409", () => {
    // BORN RED — the file says nothing today about the server enforcing (or
    // even possessing) a source enumeration, since it never mentions
    // `identity.source` at all yet.
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc).toMatch(/source[\s\S]{0,160}(409)/i);
    expect(doc).toMatch(/source[\s\S]{0,160}(refus|reject)/i);
  });

  test("an absent source is documented as staying legal (this CR does not make it required)", () => {
    // BORN RED — absent today; §S1's own scope explicitly rejects wrong
    // values without making the field required, and the doc must say so or
    // Model-B's skills could over-tighten client behaviour.
    const doc = readText(STATUS_CONTRACT_PATH);

    expect(doc.toLowerCase()).toMatch(/source[\s\S]{0,160}(optional|not required|absent)/i);
  });
});
