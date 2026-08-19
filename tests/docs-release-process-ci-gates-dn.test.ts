// CR-CRU-062 — the DN must record that CI now owns the bun/python/e2e gates
// (RED).
//
// Spec: docs/changes/CR-CRU-062-ci-runs-the-gates.md
//   AC: "`DN-release-process.md` §3 Step 4 is updated to say which gates CI
//   now owns versus which stay local."
//   Dispatch brief: "Update it to say which gates CI owns versus which stay
//   local — and note that the publish jobs are now `needs:`-gated on all
//   three, so a failed suite blocks a publish by construction."
//
// Follows the docs-*.test.ts substance-over-prose precedent (see
// docs-project-delete-cascade-dn.test.ts): every assertion targets a
// LOAD-BEARING FACT via a bounded proximity window anchored on real,
// currently-existing text — never a single pinned sentence — so a
// legitimate rewording of the DN's prose does not break this guard, only a
// substantively missing fact does. Calibration verified against the real
// file (grep, see below): none of "CI" (as a standalone word), "needs", or
// "local"/"locally" appear anywhere inside today's Step 4 section, so none
// of the assertions below can false-pass against unrelated pre-existing
// text.
//
// RED phase: DN-release-process.md §3 Step 4 ("FULL-STACK TEST") today
// describes bun/python/e2e as things the OPERATOR runs on the release
// branch ("bun regression with coverage" / "python regression with
// coverage" / "`bun run test:e2e`" as a manual bullet list, gated only by
// "Gate: all three green. Any failure ends the release.") — with zero
// mention of CI, zero mention of `needs`, and zero mention of what stays
// local. Every substantive assertion below is expected to FAIL until GREEN
// rewrites the section.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const DN_PATH = join("docs", "research", "DN-release-process.md");

// Slices from the Step 4 heading through the start of the next step's
// heading, so the window covers exactly the section body a reader sees
// under "FULL-STACK TEST" — regardless of how much GREEN lengthens or
// shortens it. Returns "" (never throws) when either anchor is missing, so
// downstream assertions fail as ASSERTIONS, not as a crash.
function extractStep4(dn: string): string {
  const start = dn.indexOf("FULL-STACK TEST");
  if (start === -1) return "";
  const end = dn.indexOf("### Step 5", start);
  if (end === -1) return "";
  return dn.slice(start, end);
}

describe("§3 Step 4 (FULL-STACK TEST) records that CI now owns the bun/python/e2e gates", () => {
  test("Step 4 explicitly attributes the gates to CI (the word 'CI' appears in the section)", () => {
    // BORN RED — grep-verified: the standalone word "CI" does not appear
    // anywhere inside today's Step 4 section (it describes only "the
    // release branch" and "bun regression with coverage" etc.).
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    expect(step4.length).toBeGreaterThan(0);
    expect(step4).toMatch(/\bCI\b/);
  });

  test("Step 4 ties 'CI' to actually RUNNING/OWNING the suites, not a passing mention", () => {
    // BORN RED — no "CI" mention exists at all today (previous test), so
    // this co-occurrence check cannot possibly pass against unrelated text
    // either. Loose word-based proximity (not a pinned sentence) so a
    // reworded but substantively equivalent statement still passes: "CI now
    // runs...", "...now run in CI", "CI owns the bun/python/e2e suites",
    // etc. all satisfy it.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    const ciRunsGates =
      /\bCI\b[\s\S]{0,250}\b(run|runs|running|execut\w*|own\w*)\b/i.test(step4) ||
      /\b(run|runs|running|execut\w*|own\w*)\b[\s\S]{0,250}\bCI\b/i.test(step4);
    expect(ciRunsGates).toBe(true);
  });

  test("Step 4 still names all three suites (bun, python, e2e) in the CI-owned context", () => {
    // BORN GREEN on the bare word-presence today (the current bullet list
    // already names bun/python/e2e as manual steps) but pinned here anyway
    // as a sanity bound: a rewrite that drops one of the three suites while
    // adding CI language would still be a defect, and the sibling assertion
    // above (CI-runs-gates) does not by itself guarantee all three survive.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    expect(step4).toMatch(/\bbun\b/i);
    expect(step4).toMatch(/\bpython\b/i);
    expect(step4).toMatch(/e2e/i);
  });

  test("Step 4 notes the publish jobs are `needs:`-gated on the three test jobs", () => {
    // BORN RED — grep-verified: "needs" does not appear anywhere inside
    // today's Step 4 section.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    expect(step4).toMatch(/needs/i);
  });

  test("Step 4 states a failed suite blocks a publish by construction (substance: 'blocks'/'prevents' near 'publish', not exact prose)", () => {
    // BORN RED — grep-verified: neither "block" nor "publish" appears
    // anywhere inside today's Step 4 section (today's gate language is
    // "Gate: all three green. Any failure ends the release." — about the
    // release process generically, never naming a publish job or a
    // structural block). Bounded proximity window, not a pinned sentence,
    // so "a failing suite blocks publish-pypi/publish-npm by construction",
    // "publishing cannot proceed on a commit whose tests failed", etc. all
    // satisfy it.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    const blocksPublish =
      /\b(block\w*|prevent\w*|refus\w*|cannot\s+proceed)\b[\s\S]{0,200}\bpublish\w*/i.test(step4) ||
      /\bpublish\w*[\s\S]{0,200}\b(block\w*|prevent\w*|refus\w*|cannot\s+proceed)\b/i.test(step4);
    expect(blocksPublish).toBe(true);
  });

  test("Step 4 (or its immediate context) says which gates stay LOCAL, not just which move to CI", () => {
    // BORN RED — grep-verified: neither "local" nor "locally" appears
    // anywhere inside today's Step 4 section. The AC is explicit that the
    // DN must say which gates CI owns VERSUS which stay local — a rewrite
    // that only adds CI language without contrasting what remains
    // operator-run would satisfy every assertion above while still missing
    // this one, which is why it is asserted separately rather than folded
    // into the CI-ownership check.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    expect(step4).toMatch(/\blocal(ly)?\b/i);
  });
});

describe("§3 Step 4 edit — neighbour anchors survive (guard tests, born green)", () => {
  test("the Step 3 (INTEGRITY GATE) and Step 5 (PACKAGE, AND TEST THE PACKAGE) headings are untouched", () => {
    // BORN GREEN today; guards against a sloppy rewrite of Step 4 bleeding
    // into its neighbours' headings.
    const dn = readText(DN_PATH);
    expect(dn).toContain("### Step 3 — INTEGRITY GATE");
    expect(dn).toContain("### Step 5 — PACKAGE, AND TEST THE PACKAGE");
  });

  test("Step 4 still carries an explicit Gate: line (the release-blocking condition is not removed, only re-attributed)", () => {
    // BORN GREEN today ("**Gate:** all three green. Any failure ends the
    // release."); guards against GREEN deleting the gate condition outright
    // while adding CI language, rather than re-describing it.
    const dn = readText(DN_PATH);
    const step4 = extractStep4(dn);
    expect(step4).toMatch(/\*\*Gate:\*\*/);
  });
});
