// CR-CRU-056 C4 — §S4b PRD sync docs-assertion tests (RED).
//
// Spec: docs/changes/CR-CRU-056-ambiguous-auto-attach-throws.md §S4b
//   The PRD (docs/research/PRD-crucible-v2.md) still documents the superseded
//   "agents attach context.cycleId" / server-guesses-the-active-cycle model
//   and carries CR-CRU-036 drift (`WORKFLOW_CYCLE_ID` mentions that CR-036
//   removed from the system but never from the PRD). GREEN must rewrite the
//   superseded clause(s) to the registration-binding model: agents (TDD
//   phases) register BOUND to a cycle; the server VALIDATES the binding and
//   STAMPS attachment on ingest; there is no client-side "guess the active
//   cycle" resolution anywhere, and no `WORKFLOW_CYCLE_ID` reference.
//
// ESCALATION (documented per sub-agent-procedure "when in doubt"):
//   The CR's own §S4b text cites TWO drift sites verbatim: `:278` ("attach
//   `context.cycleId`") and `:285` ("clients auto-attach it"). Having read
//   the real file (PRD-crucible-v2.md:260-370) before writing a single
//   assertion, the `:285` phrase is NOT about cycle attachment at all — it
//   is the **track** auto-attach sentence: "Model-B track operators register
//   `track` with the CR's plan (clients auto-attach it from `WORKFLOW_ROLE`)".
//   That mechanism (track inferred from $WORKFLOW_ROLE) is untouched by
//   CR-CRU-056, which is scoped to CYCLE binding at registration, not track
//   derivation. A grep for "auto-attach" across the whole PRD (see below)
//   turns up exactly one hit — this same line 285 — so there is no second,
//   cycle-flavoured "auto-attach" sentence hiding elsewhere that the CR could
//   have meant instead. The dispatch brief itself independently lists "the
//   track-registration sentence at ~:285" as a NEIGHBOUR ANCHOR that must
//   survive byte-identical (its own point 1.d) — directly contradicting its
//   point 1.a's claim that the very same line's phrase "must be gone". Rather
//   than write a RED assertion that would (if honoured by GREEN) incorrectly
//   gut an unrelated, still-true sentence, this file treats PRD:285 as a
//   PRESERVED NEIGHBOUR (per point 1.d, and per independent verification),
//   and drives the real superseded-clause rewrite off PRD:278 + the
//   WORKFLOW_CYCLE_ID sweep instead. Flagging this rather than silently
//   picking a side.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const PRD_PATH = join("docs", "research", "PRD-crucible-v2.md");
const RUNBOOK_PATH = join("docs", "RUNBOOK.md");
const STATUS_CONTRACT_PATH = join("clients", "STATUS-CONTRACT.md");

// Slices out the "Run timeline" bullet's cycle/attach sub-paragraph (from the
// "RED→GREEN transition marker" locked-round callout down to, but excluding,
// the "Coverage" bullet that follows it) so assertions target the real
// cycle/attach prose rather than the whole 448-line PRD.
function extractCycleAttachParagraph(md: string): string {
  const startMarker = "RED→GREEN transition marker";
  const endMarker = "- **Coverage**";
  const startIdx = md.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`start marker not found: "${startMarker}"`);
  }
  const endIdx = md.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`end marker not found: "${endMarker}"`);
  }
  return md.slice(startIdx, endIdx);
}

// §S4b(a+b) — the superseded "agents attach context.cycleId" clause (PRD:278)
// is replaced by the registration-binding model; WORKFLOW_CYCLE_ID drift
// (PRD:292, :358) is swept from the whole document.

describe("§S4b PRD — superseded cycle-attach clause replaced by the registration-binding model", () => {
  test("the 'Agents attach context.cycleId' clause (PRD:278) is gone", () => {
    // BORN RED — today's exact text (PRD-crucible-v2.md:277-278): "...(a GREEN
    // run alone never closes anything). Agents attach `context.cycleId`; the
    // timeline renders the plan inline...". This describes agents freely
    // attaching a cycleId with no registration-time validation — the model
    // CR-CRU-056 §S1-§S3 replaces.
    const prd = readText(PRD_PATH);
    const para = extractCycleAttachParagraph(prd);
    expect(para).not.toMatch(/Agents\s+attach `context\.cycleId`/);
  });

  test("replacement text describes agents registering BOUND to a cycle", () => {
    // BORN RED — absent today; the paragraph never uses "register" or
    // "bound" in connection with a cycle anywhere in this section.
    const prd = readText(PRD_PATH);
    const para = extractCycleAttachParagraph(prd);
    expect(para).toMatch(/regist(er|ration)[\s\S]{0,80}bound[\s\S]{0,40}cycle/i);
  });

  test("replacement text describes the SERVER stamping/validating the attachment, not client resolution", () => {
    // BORN RED — absent today; nothing in the current paragraph attributes
    // the attach decision to the server, and CR-CRU-056 explicitly deletes
    // client-side "guess the active cycle" resolution.
    const prd = readText(PRD_PATH);
    const para = extractCycleAttachParagraph(prd);
    expect(para).toMatch(/server[\s\S]{0,40}(stamp|validat)/i);
  });

  test("no stale WORKFLOW_CYCLE_ID reference survives anywhere in the PRD", () => {
    // BORN RED — CR-CRU-036 (2026-07-22) removed WORKFLOW_CYCLE_ID from the
    // system, but the PRD still names it twice (PRD:292 in the workflow-state
    // env-var list, PRD:358 in the "all in v0.1.0" fleet-verb summary). Both
    // must be gone — a single whole-document sweep catches either surviving.
    const prd = readText(PRD_PATH);
    expect(prd).not.toMatch(/WORKFLOW_CYCLE_ID/);
  });
});

describe("§S4b PRD — neighbour anchors survive the edit byte-identical (guard tests)", () => {
  test("the still-true WORKFLOW_ROLE/WORKFLOW_WAVE/WORKFLOW_CYCLE + CRUCIBLE_* prefix distinction survives, minus WORKFLOW_CYCLE_ID", () => {
    // BORN GREEN today (all these tokens are present now); stays green after
    // a correct edit that removes ONLY `WORKFLOW_CYCLE_ID` from the list —
    // guards against GREEN over-deleting the whole env-var sentence.
    const prd = readText(PRD_PATH);
    expect(prd).toContain("`WORKFLOW_ROLE`");
    expect(prd).toContain("`WORKFLOW_WAVE`");
    expect(prd).toContain("`WORKFLOW_CYCLE`,");
    expect(prd).toMatch(/`CRUCIBLE_\*`\s*\n?\s*prefix is reserved for Crucible's own configuration/);
  });

  test("the track-registration sentence (PRD:284-286) survives — it is untouched by this CR (see file-header ESCALATION)", () => {
    // BORN GREEN — see the ESCALATION comment at the top of this file: this
    // exact phrase describes TRACK auto-attach from $WORKFLOW_ROLE, a
    // mechanism CR-CRU-056 does not touch (it is scoped to cycle binding).
    // Pinned here as a preserved neighbour, not a driving assertion.
    const prd = readText(PRD_PATH);
    expect(prd).toContain("track operators register `track` with the CR's plan");
    expect(prd).toContain("clients auto-attach it");
    expect(prd).toMatch(/from `WORKFLOW_ROLE`/);
  });

  test("the Workflow-tab description (PRD:~334) survives", () => {
    // BORN GREEN — unrelated content near the edit site; guards against a
    // sloppy edit eating past the cycle-attach paragraph's boundary.
    const prd = readText(PRD_PATH);
    expect(prd).toContain("dedicated **Workflow tab**");
  });

  test("the fleet plan-verb list (PRD:~357-358) survives, minus WORKFLOW_CYCLE_ID", () => {
    // BORN GREEN today for the verb list itself; the WORKFLOW_CYCLE_ID
    // removal is asserted separately above (whole-doc sweep) — this guards
    // the verb list surviving that same edit.
    const prd = readText(PRD_PATH);
    expect(prd).toContain("plan-file / cycle-activate / cycle-done / cr-close");
  });
});

// §S4b(2) — the registration contract itself (§S1/§S2/§S3b of the CR) is
// documented in the PRD: TDD phases register bound, ORCHESTRATOR/report may
// register unbound, unregistered callers are refused on workflow verbs +
// ingest. Entirely absent from the PRD today (verified: zero matches for
// "unregistered", "refused", "ORCHESTRATOR...unbound" anywhere in the file).

describe("§S4b PRD — the registration-binding contract is documented", () => {
  test("TDD-phase agents (RED/GREEN/FIX/VERIFY) must register bound to an active cycle", () => {
    // BORN RED — no such statement exists anywhere in the PRD today.
    const prd = readText(PRD_PATH);
    expect(prd).toMatch(/RED\s*\|\s*GREEN\s*\|\s*FIX\s*\|\s*VERIFY/);
    expect(prd).toMatch(/regist(er|ration)[\s\S]{0,100}bound[\s\S]{0,60}cycle/i);
  });

  test("ORCHESTRATOR and report may register unbound", () => {
    // BORN RED — absent today.
    const prd = readText(PRD_PATH);
    expect(prd).toMatch(/ORCHESTRATOR[\s\S]{0,60}(and|\/)[\s\S]{0,20}report[\s\S]{0,60}unbound/i);
  });

  test("unregistered callers are refused on workflow verbs and ingest", () => {
    // BORN RED — absent today (zero matches for "unregistered" in the whole
    // PRD, verified before writing this test).
    const prd = readText(PRD_PATH);
    expect(prd).toMatch(/unregistered[\s\S]{0,100}(refused|409)/i);
  });
});

// §S4b(3) — docs/RUNBOOK.md: born-green boundary pin.
//
// Enumeration performed by hand (2026-08-01) before writing this test: the
// only "agent"-adjacent mention anywhere in RUNBOOK.md is the Health section's
// "counts of projects/agents/events" (RUNBOOK.md:108) — a health-payload field
// name, not client/registration operation. There is no mention of `--agent`,
// `--cycle`, `register`, or any `*-crucible.py` client invocation anywhere in
// the file (grep-verified: only the single health-payload hit). RUNBOOK.md
// documents the SERVER (start/stop/db-path/corruption/retention/health/env
// vars) exclusively — this matches CR-046 C4's prior finding for the same
// file. Honest finding: nothing in RUNBOOK.md drives a §S4b rewrite, so this
// is a GUARD (BORN GREEN), pinning the boundary rather than driving an edit.

describe("RUNBOOK.md — client/registration operation boundary (born-green pin)", () => {
  test("does not document --agent, --cycle, register, or any *-crucible.py client invocation", () => {
    const runbook = readText(RUNBOOK_PATH);
    expect(runbook).not.toMatch(/--agent\b/);
    expect(runbook).not.toMatch(/--cycle\b/);
    expect(runbook).not.toMatch(/\bregister\b/i);
    expect(runbook).not.toMatch(/[\w-]*crucible\.py/i);
  });

  test("the one 'agent' mention in the file is the health-payload field name, not client operation", () => {
    const runbook = readText(RUNBOOK_PATH);
    expect(runbook).toContain("counts of projects/agents/events");
  });
});

// §S4b(4) — clients/STATUS-CONTRACT.md: the CR-035/CR-044 versioned register
// contract does not yet mention the §S1/§S2 cycle-binding requirement at all
// (verified: zero matches for "--cycle", "unbound", "bound to" in the file
// today — the file's only `cycleId` mention is the pre-existing, unrelated
// envelope `context.cycleId` field description). Since this file already
// documents `register`'s identity/phase contract in the same rigor (the
// "Agent identity and phase" / "declared, never fabricated" sections), the
// cycle-binding requirement belongs here too.

describe("STATUS-CONTRACT.md — the §S1/§S2 cycle-binding registration contract is documented", () => {
  test("documents the --cycle registration flag and its binding validation", () => {
    // BORN RED — "--cycle" does not appear anywhere in the file today.
    const doc = readText(STATUS_CONTRACT_PATH);
    expect(doc).toContain("--cycle");
    expect(doc).toMatch(/bound/i);
    expect(doc).toMatch(/409/);
  });

  test("documents TDD phases require the binding while ORCHESTRATOR/report may register unbound", () => {
    // BORN RED — no "cycle" mention follows the RED|GREEN|FIX|VERIFY
    // enumeration anywhere in the file today (the enumeration itself already
    // exists, for --phase — this asserts the NEW cycle-binding fact next to
    // it, not the pre-existing phase enumeration).
    const doc = readText(STATUS_CONTRACT_PATH);
    expect(doc).toMatch(/RED\s*\|\s*GREEN\s*\|\s*FIX\s*\|\s*VERIFY[\s\S]{0,200}cycle/i);
    expect(doc).toMatch(/ORCHESTRATOR[\s\S]{0,60}(and|\/)[\s\S]{0,20}report[\s\S]{0,60}unbound/i);
  });

  test("the pre-existing 'declared, never fabricated' agent-identity framing survives (neighbour anchor)", () => {
    // BORN GREEN — this exact sentence exists today (CR-CRU-044 §S5); guards
    // against a sloppy rewrite gutting the surrounding identity contract
    // while adding the cycle-binding section.
    const doc = readText(STATUS_CONTRACT_PATH);
    expect(doc).toContain("An agent identity is **declared with `--agent` or the verb FAILS**");
  });
});
