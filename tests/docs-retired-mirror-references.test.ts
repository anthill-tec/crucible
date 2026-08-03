// CR-CRU-053 §S2/§S4 — guard against retired-mirror source-claims + dangling
// references to the deleted test_bun_crucible_context.py (RED).
//
// Spec: docs/changes/CR-CRU-053-retired-mirror-references.md
//   §S4: add ONE guard, on the tests/docs-registration-binding.test.ts
//   precedent, asserting every surviving `~/.claude/scripts` reference in
//   tests/ and docs/ is a do-NOT-use warning, never a presentation of the
//   mirror as the client source.
//   §S2: no docstring in tests/ may still cite the deleted
//   test_bun_crucible_context.py as a live sibling harness.
//
// RE-DERIVED at execution time (2026-08-03), per the CR's own lesson that a
// location recorded in prose decays — do not trust the table below, it is
// provenance for THIS run, re-grep before trusting it again:
//
//   TRAP (must currently fail — presents the mirror as the live client
//   source, not merely named/warned-against):
//     tests/clients-bun-crucible.test.ts:11
//     tests/clients-python-arduino-crucible.test.ts:13
//     docs/research/DN-crucible-api-reconstruction.md:206
//
//   WARNING (do-NOT-use — legal, must NOT be flagged, must NOT be swept up
//   by GREEN's fix per §S5):
//     tests/clients-rust-mvn-crucible.test.ts:14   (already fixed, CR-050)
//     tests/client/test_bun_crucible_lifecycle.py:54
//     tests/client/test_bun_crucible_lifecycle.py:144
//     tests/client/test_bun_crucible_gates.py:42
//
//   HISTORY (names the mirror as the v1 evidence source — true history, not
//   a live claim — legal, must NOT be flagged):
//     docs/research/DN-crucible-api-reconstruction.md:10
//
// DISCRIMINATION RULE (this IS the contract GREEN + VERIFY depend on):
//
// A bare "does this line/paragraph contain the path" check cannot tell a
// do-not-use warning from a source-of-truth claim, because an UNRELATED
// negation can sit in the very same sentence as a TRAP mention. Concretely,
// tests/clients-bun-crucible.test.ts:11 reads (paraphrased): "`clients/
// bun-crucible.py` does NOT exist yet on this branch (only `~/.claude/
// scripts/bun-crucible.py`, the LIVE v1 script, exists...)" — the "not"
// negates `clients/bun-crucible.py` EXISTING, not the mirror claim, yet it
// sits ~49 characters upstream of the mirror path in the same paragraph. A
// paragraph-scoped "contains a negation" check would misclassify this TRAP
// as a warning.
//
// So classification is PROXIMITY-scoped around the exact match offset, not
// paragraph-scoped, using character windows measured against every live
// instance on disk today (see the table above):
//   * WARNING — a disclaimer token (`not`/`never`/`don't`/`do not`) appears
//     within 30 chars immediately BEFORE the match, or a disclaimer token
//     (`not`/`never`/`retired`, case-insensitive) appears within 45 chars
//     immediately AFTER it. Measured distances today: the genuine
//     disclaimers sit 10-24 chars before the match ("NOT the `~/...`",
//     "not the deployed `~/...`") or ~30-40 chars after it ("mirror is
//     RETIRED: do NOT run it"). The false-negation case above sits ~49
//     chars before the match — outside the 30-char pre-window — so it is
//     correctly NOT treated as a disclaimer.
//   * TRAP — (no disclaimer found) AND a liveness token (`live`, case
//     insensitive) appears within 30 chars before the match or 45 chars
//     after it. All three known traps carry "LIVE"/"live" within a handful
//     of words of the path (either immediately before it, as in "the LIVE
//     v1 script, exists", or immediately before it as "the live `~/...`
//     copies sync via...").
//   * HISTORY — neither signal fires. DN:10 simply names the mirror as
//     where the v1 evidence was found ("the per-stack ingest scripts
//     (`~/.claude/scripts/*-crucible.py`)") with no liveness claim and no
//     disclaimer nearby — legal, left alone, per the CR's own §S3 carve-out.
//
// The 30/45-char windows were derived by measuring the actual byte distance
// from each real disclaimer/liveness token to its mirror-path match on this
// branch (verified via a throwaway scan before writing this file) — they
// are not arbitrary constants tuned to make the assertions pass.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

// This guard file itself quotes the exact trap/warning strings (in comments,
// for provenance) — excluded from its own scans below so it does not
// pollute its own results.
const SELF_REL_PATH = join("tests", "docs-retired-mirror-references.test.ts");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// Recursively lists files under `relDir` (repo-root relative) whose
// extension is in `exts`, skipping __pycache__ — stale `.pyc` bodies of
// deleted/renamed test modules (test_bun_crucible_context.py,
// test_toon.py) still embed their old docstrings verbatim and would
// produce phantom hits; the CR's own Context section names this exact
// trap ("10 extra hits... polluted this very enumeration").
function listFiles(relDir: string, exts: string[]): string[] {
  const abs = join(REPO_ROOT, relDir);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__pycache__" || entry === "node_modules" || entry === ".git") {
        continue;
      }
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (exts.includes(extname(entry))) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

type Verdict = "warning" | "trap" | "history";

interface MirrorHit {
  relPath: string;
  line: number;
  verdict: Verdict;
  snippet: string;
}

// Mirrors the CR's own audit command: `grep -rna '\.claude/scripts' tests/ docs/`.
const MIRROR_PATTERN = /\.claude\/scripts/g;

function classify(text: string, index: number, matchLength: number): Verdict {
  const pre30 = text.slice(Math.max(0, index - 30), index);
  const post45 = text.slice(index + matchLength, Math.min(text.length, index + matchLength + 45));

  const disclaimer = /\b(not|never|don't|do not)\b/i.test(pre30) || /\b(not|never|retired)\b/i.test(post45);
  if (disclaimer) return "warning";

  const liveClaim = /\blive\b/i.test(pre30) || /\blive\b/i.test(post45);
  if (liveClaim) return "trap";

  return "history";
}

// Scoped to `tests/` (all .ts + .py) and `docs/research/` (the LIVING
// reference docs — PRD/DN/RUNBOOK-class material). `docs/changes/` (the CR
// archive) is deliberately EXCLUDED: CR documents are point-in-time change
// requests describing what was true when filed — an immutable audit trail,
// never retroactively corrected — which is exactly why CR-CRU-053's own
// Non-goals list "other stale CR-era narration" as out of scope, and why
// its own Context/§S3 enumeration never once names a docs/changes/*.md
// file as something to fix. This mirrors the established precedent in
// tests/docs-registration-binding.test.ts, which targets PRD/RUNBOOK/
// STATUS-CONTRACT (living docs) and never the CR archive.
function scanMirrorMentions(): MirrorHit[] {
  const files = [
    ...listFiles("tests", [".ts", ".py"]),
    ...listFiles(join("docs", "research"), [".md"]),
  ].filter((abs) => abs.slice(REPO_ROOT.length + 1) !== SELF_REL_PATH);
  const hits: MirrorHit[] = [];
  for (const abs of files) {
    const text = readFileSync(abs, "utf8");
    const relPath = abs.slice(REPO_ROOT.length + 1);
    for (const m of text.matchAll(MIRROR_PATTERN)) {
      const index = m.index ?? 0;
      const verdict = classify(text, index, m[0].length);
      const line = text.slice(0, index).split("\n").length;
      hits.push({
        relPath,
        line,
        verdict,
        snippet: text
          .slice(Math.max(0, index - 40), index + 60)
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
  }
  return hits;
}

describe("§S4 guard — every surviving ~/.claude/scripts reference is a do-not-use warning, never a source claim", () => {
  test("scanning tests/ and docs/research/ finds zero mentions that present the mirror as the live client source", () => {
    // BORN RED — today this finds exactly 3 "trap" mentions:
    //   tests/clients-bun-crucible.test.ts:11 ("the LIVE v1 script, ...exists")
    //   tests/clients-python-arduino-crucible.test.ts:13 ("the LIVE v1 scripts... exist — copied into clients/")
    //   docs/research/DN-crucible-api-reconstruction.md:206 ("the live `~/.claude/scripts/` copies sync via...")
    // GREEN's §S1/§S3 correction (rewriting these three to state the
    // in-repo clients/ are the source of truth and the mirror is retired)
    // is what turns this green — not touching this test.
    const hits = scanMirrorMentions();
    const traps = hits.filter((h) => h.verdict === "trap");
    expect(traps).toEqual([]);
  });

  test("at least one genuine do-not-use warning and one legitimate history mention survive the scan (sanity — the scan is not vacuously empty)", () => {
    // Guards against a broken scan silently finding zero total mentions
    // (e.g. a wrong glob) and the "traps===[]" assertion above passing for
    // the wrong reason. BORN GREEN today and stays green after GREEN's fix.
    const hits = scanMirrorMentions();
    expect(hits.some((h) => h.verdict === "warning")).toBe(true);
    expect(hits.some((h) => h.verdict === "history")).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(6);
  });

  test("the classifier does not mistake an unrelated negation for a disclaimer (the exact near-miss on this branch)", () => {
    // Pins the discrimination rule directly against the real, currently
    // in-scope near-miss text, rather than a synthetic string, so a future
    // change to the classifier constants is caught here even if the
    // underlying prose in clients-bun-crucible.test.ts eventually moves.
    // BORN RED today (this occurrence classifies as "trap", not "warning").
    const text = readText(join("tests", "clients-bun-crucible.test.ts"));
    const match = /\.claude\/scripts/.exec(text);
    expect(match).not.toBeNull();
    const index = match!.index;
    // Confirms the exact near-miss shape this rule is designed against:
    // an unrelated "does not exist" sits upstream of the match.
    expect(text.slice(Math.max(0, index - 60), index)).toMatch(/does not exist/);
    expect(classify(text, index, match![0].length)).toBe("trap");
  });

  test("the reinforcing do-not-use warnings are not swept up by the fix (§S5 — preserved, not deleted)", () => {
    // BORN GREEN today; stays green after GREEN's §S1 edit. Guards against
    // an overzealous blanket fix deleting or rewording the THREE references
    // that correctly warn against the mirror (§S5 of the CR: "must not be
    // swept up in a blanket edit").
    const lifecycle = readText(join("tests", "client", "test_bun_crucible_lifecycle.py"));
    const gates = readText(join("tests", "client", "test_bun_crucible_gates.py"));
    const rustMvn = readText(join("tests", "clients-rust-mvn-crucible.test.ts"));

    expect(lifecycle).toMatch(/OWN,\s*not the deployed `~\/\.claude\/scripts` mirror/);
    expect(gates).toMatch(/NOT the `~\/\.claude\/scripts` mirror/);
    expect(rustMvn).toMatch(/`~\/\.claude\/scripts\/\*\.py` mirror is RETIRED: do NOT run it/);
  });

  test("DN:10's v1-evidence-source mention stays legal history, untouched (§S3 carve-out)", () => {
    // BORN GREEN today; stays green after GREEN's §S3 edit to DN:206. Guards
    // against GREEN over-correcting DN:10 (true history) while fixing
    // DN:206 (the live trap) — the CR is explicit: "Leave DN:10 alone."
    const dn = readText(join("docs", "research", "DN-crucible-api-reconstruction.md"));
    expect(dn).toContain("the per-stack ingest\nscripts (`~/.claude/scripts/*-crucible.py`)");
  });
});

describe("§S2 guard — no docstring in tests/ cites the deleted test_bun_crucible_context.py as a live sibling harness", () => {
  test("zero references to test_bun_crucible_context.py survive anywhere under tests/", () => {
    // BORN RED — today this finds exactly 3 dangling references:
    //   tests/client/test_bun_crucible_gates.py:43
    //     ("sibling harnesses (test_bun_crucible_lifecycle.py / test_bun_crucible_context.py)")
    //   tests/client/test_bun_crucible_lifecycle.py:72
    //     ("this repo has never made a live-server call (test_bun_crucible_context.py is...")
    //   tests/client/test_bun_crucible_lifecycle.py:78
    //     ("Invocation (matches test_bun_crucible_context.py's documented convention)")
    // GREEN's §S2 fix (re-point or relabel each) is what turns this green.
    const files = listFiles("tests", [".ts", ".py"]).filter(
      (abs) => abs.slice(REPO_ROOT.length + 1) !== SELF_REL_PATH,
    );
    const survivors: { relPath: string; line: number }[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf8");
      const relPath = abs.slice(REPO_ROOT.length + 1);
      for (const m of text.matchAll(/test_bun_crucible_context\.py/g)) {
        const index = m.index ?? 0;
        const line = text.slice(0, index).split("\n").length;
        survivors.push({ relPath, line });
      }
    }
    expect(survivors).toEqual([]);
  });

  test("the file test_bun_crucible_context.py does not exist on disk (confirms the deletion the danglers point at)", () => {
    // BORN GREEN — sanity check that the premise of the guard above is
    // real: the file really was deleted (2026-08-01, per Scope), not
    // merely renamed to something the grep above would miss.
    let exists = true;
    try {
      statSync(join(REPO_ROOT, "tests", "client", "test_bun_crucible_context.py"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
