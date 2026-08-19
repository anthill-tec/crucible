// CR-CRU-052 §S6 — the DN must record the new cascading-project-delete
// primitive (RED).
//
// Spec: docs/changes/CR-CRU-052-project-teardown.md §S6
//   docs/research/DN-crucible-api-reconstruction.md:206-215 is ACTIVE and
//   normative. It currently states v2's posture as "an immutable audit log
//   with per-project, double-gated single-event deletion
//   (`DELETE /api/v2/events/<id>`, CR-CRU-008 §S4)" — the LAST sentence in the
//   file (215 lines total, verified). That posture does not contemplate the
//   cascading `DELETE /api/v2/projects/<key>` this CR ships. GREEN must record
//   the new primitive: the route, that it cascades to events/agents/plans/
//   plan_cycles/rollups in one transaction, that it is double-gated (archived
//   first -> 403, `userApproved: true` -> 409), and that archive remains the
//   reversible operation while delete is the irreversible one (the
//   CR-CRU-012 §S1b distinction this CR's Non-goals explicitly preserves).
//
// Calibration (substance over prose, per dispatch brief):
//   Every assertion below targets a LOAD-BEARING FACT (the route string, the
//   five cascaded table names, the two gate conditions with their exact
//   status codes, the archive-vs-delete distinction) using bounded
//   `[\s\S]{0,N}` proximity windows rather than one long pinned sentence.
//   That survives GREEN choosing to extend the existing paragraph in place OR
//   append a new subsection after it (the anchor sentence is the file's last
//   line today, so either shape lands the new text at-or-after the anchor).
//   It would NOT survive GREEN merely restating unrelated prose elsewhere in
//   the doc, because every fact is required to co-occur within a window
//   anchored on the actual route/sentence under test — verified against the
//   real file (grep, see below) that none of these terms (403, 409,
//   userApproved, cascad*, plan_cycles, rollups, reversible/irreversible)
//   appear anywhere in the DN today, so a false-pass via an unrelated
//   pre-existing mention is not possible.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const DN_PATH = join("docs", "research", "DN-crucible-api-reconstruction.md");

// Slices a window around the new route's mention so cascade/gate facts are
// asserted IN CONTEXT rather than anywhere in the 215-line document. Returns
// "" (not a throw) when the route isn't documented yet, so downstream
// assertions fail as ASSERTIONS rather than as an uncaught error — the
// dispatch brief requires the guard fail on an assertion, not a crash.
function extractProjectDeleteContext(dn: string): string {
  const idx = dn.indexOf("/api/v2/projects/<key>");
  if (idx === -1) {
    return "";
  }
  const start = Math.max(0, idx - 200);
  return dn.slice(start, idx + 1200);
}

// Slices from the pre-existing "single-event deletion" sentence (today's
// LAST sentence in the file, confirmed at DN:214-215) through the end of the
// document, so the "not left standing unqualified" guard checks exactly the
// text a reader encounters continuing past that sentence — whether GREEN
// qualifies it in place or appends a new subsection after it.
function extractOldPostureTail(dn: string): string {
  const anchor = "single-event deletion";
  const idx = dn.indexOf(anchor);
  if (idx === -1) {
    return "";
  }
  const start = Math.max(0, idx - 200);
  return dn.slice(start);
}

describe("§S6 DN — the new cascading project-delete primitive is recorded", () => {
  test("states DELETE /api/v2/projects/<key> as a lifecycle primitive", () => {
    // BORN RED — verified by grep: "/api/v2/projects" and "DELETE /api"
    // (any case) do not appear anywhere in the DN today; the only existing
    // `DELETE` route documented is `/api/v2/events/<id>` (DN:215).
    const dn = readText(DN_PATH);
    expect(dn).toMatch(/`?DELETE\s+\/api\/v2\/projects\/<key>`?/);
  });

  test("states the cascade covers events, agents, plans, plan_cycles and rollups in one transaction", () => {
    // BORN RED — none of "plan_cycles" or "rollups" appear anywhere in the DN
    // today (grep-verified), so this cannot false-pass against unrelated text.
    const dn = readText(DN_PATH);
    const ctx = extractProjectDeleteContext(dn);
    expect(ctx).toMatch(/\bevents\b/);
    expect(ctx).toMatch(/\bagents\b/);
    expect(ctx).toMatch(/\bplans\b/);
    expect(ctx).toMatch(/\bplan_cycles\b/);
    expect(ctx).toMatch(/\brollups\b/);
    expect(ctx).toMatch(/one\s+transaction/i);
  });

  test("states the archived-first gate: a non-archived project is refused with 403", () => {
    // BORN RED — "403" does not appear anywhere in the DN today (grep-
    // verified), so co-occurrence with "archiv*" here cannot be accidental.
    const dn = readText(DN_PATH);
    const ctx = extractProjectDeleteContext(dn);
    expect(ctx).toMatch(/archiv\w*/i);
    expect(ctx).toMatch(/403/);
  });

  test("states the userApproved gate: an unconfirmed delete is refused with 409", () => {
    // BORN RED — neither "userApproved" nor "409" appear anywhere in the DN
    // today (grep-verified).
    const dn = readText(DN_PATH);
    const ctx = extractProjectDeleteContext(dn);
    expect(ctx).toMatch(/userApproved/);
    expect(ctx).toMatch(/409/);
  });

  test("preserves the archive-is-reversible / delete-is-irreversible distinction (CR-CRU-012 §S1b, this CR's Non-goal)", () => {
    // BORN RED — "reversible"/"irreversible" do not appear anywhere in the DN
    // today (grep-verified). Loose word-based match (not a pinned sentence)
    // so a reworded but substantively equivalent statement still passes.
    const dn = readText(DN_PATH);
    const ctx = extractProjectDeleteContext(dn);
    expect(ctx).toMatch(/archiv\w*[\s\S]{0,120}revers\w*/i);
    expect(ctx).toMatch(/delet\w*[\s\S]{0,120}irrevers\w*/i);
  });
});

describe("§S6 DN — the old single-event-deletion posture no longer stands unqualified", () => {
  test("a reader continuing past the 'single-event deletion' sentence finds the cascading project delete acknowledged", () => {
    // BORN RED today: the "single-event deletion" sentence (DN:214-215) is
    // the LAST sentence in the 215-line file, so the tail from that anchor
    // to EOF is currently ~50 characters and contains nothing about project
    // deletion. A reader stopping there would wrongly conclude single-event
    // deletion is still the only deletion primitive in the system.
    const dn = readText(DN_PATH);
    const tail = extractOldPostureTail(dn);
    expect(tail).toMatch(
      /DELETE\s+\/api\/v2\/projects\/<key>|cascad\w*[\s\S]{0,80}project/i,
    );
  });
});

describe("§S6 DN — neighbour anchors survive the edit (guard tests, born green)", () => {
  test("the 'immutable audit log' framing survives", () => {
    // BORN GREEN today (DN:213-214: "v2's posture is an immutable audit log
    // with per-project..."); guards against a sloppy rewrite deleting the
    // whole framing sentence while adding the new primitive.
    const dn = readText(DN_PATH);
    expect(dn).toContain("immutable audit log");
  });

  test("the pre-existing single-event route citation survives", () => {
    // BORN GREEN today (DN:215); the new cascading route is additive, not a
    // replacement — the single-event route/citation must still be documented.
    const dn = readText(DN_PATH);
    expect(dn).toContain("`DELETE /api/v2/events/<id>`");
    expect(dn).toContain("CR-CRU-008 §S4");
  });
});
