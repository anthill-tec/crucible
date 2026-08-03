// CR-CRU-053 §S2/§S4/§S4b — guard against retired-mirror source-claims +
// dangling references to test files that no longer exist on disk (RED).
//
// Spec: docs/changes/CR-CRU-053-retired-mirror-references.md
//   §S4: add ONE guard, on the tests/docs-registration-binding.test.ts
//   precedent, asserting every surviving `~/.claude/scripts` reference in
//   tests/ and docs/ is a do-NOT-use warning, never a presentation of the
//   mirror as the client source.
//   §S2: no docstring in tests/ may still cite the deleted
//   test_bun_crucible_context.py as a live sibling harness.
//   §S4b (AMENDED mid-execution 2026-08-03): GREEN found two more instances
//   of the same defect class in tests/client/test_bun_crucible_gates.py — a
//   dangling `test_toon.py` citation (renamed by CR-046) and a present-tense
//   claim that the home `~/.claude/scripts` mirror is synced at all. The §S2
//   guard is GENERALISED accordingly: from "no docstring cites
//   test_bun_crucible_context.py" to "no docstring/comment under tests/
//   cites a test_*.py/*.test.ts filename that does not exist on disk" — a
//   guard hardcoded to one dead filename would have missed this one. A
//   second, new guard pins the mirror-sync claim directly.
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

  test("the classifier does not mistake an unrelated negation for a disclaimer (a synthetic near-miss reproducing the exact shape)", () => {
    // SYNTHETIC fixture, deliberately NOT the real tests/clients-bun-
    // crucible.test.ts prose the previous version of this test pinned.
    // That was wrong, not merely stylistically: the real occurrence this
    // test pinned is EXACTLY the one §S1 corrects (it's the first of the
    // three traps test 1, above, asserts down to zero) — so the moment
    // GREEN does its job, "the real occurrence classifies as trap" and
    // "zero traps survive" (test 1) become mutually exclusive assertions
    // about the SAME line. The test was unsatisfiable alongside test 1
    // from the moment §S1 landed, which also means it was never "BORN RED
    // today" as it claimed — pre-fix the occurrence WAS a trap, so this
    // test was BORN GREEN, pinning the DEFECT (a live-source claim) rather
    // than the discrimination REQUIREMENT (that an unrelated negation must
    // not be mistaken for a disclaimer). Its stated reason for using real
    // text — "so a future change to the classifier constants is caught
    // here even if the underlying prose eventually moves" — is a
    // legitimate goal, just achieved the wrong way: pinning mutable prose
    // (prose this very CR deletes) inside a guard is what made it
    // self-defeating. A synthetic fixture achieves the same goal (it still
    // fails if the 30/45-char classifier constants in `classify()` above
    // change) without depending on prose content this CR is actively
    // correcting.
    //
    // The fixture reproduces the exact near-miss SHAPE measured on this
    // branch: an unrelated "does not exist" sits ~55 chars upstream of a
    // `~/.claude/scripts/...` mention (outside the 30-char pre-window, so
    // it must NOT register as a disclaimer), and a "LIVE" liveness token
    // sits a handful of words immediately before the match (inside the
    // 30-char pre-window, so it MUST register as a live claim) — the same
    // geometry as the real near-miss, built from a filename
    // (`fixture-probe.py`) that will never collide with anything real.
    const SYNTHETIC_NEAR_MISS =
      "The fixture-probe.py helper does not exist on this branch (only the LIVE " +
      "copy at ~/.claude/scripts/fixture-probe.py stands in for it).";
    const match = /\.claude\/scripts/.exec(SYNTHETIC_NEAR_MISS);
    expect(match).not.toBeNull();
    const index = match!.index;
    // Confirms the exact near-miss shape this rule is designed against:
    // an unrelated "does not exist" sits upstream of the match.
    expect(SYNTHETIC_NEAR_MISS.slice(Math.max(0, index - 60), index)).toMatch(/does not exist/);
    expect(classify(SYNTHETIC_NEAR_MISS, index, match![0].length)).toBe("trap");
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

// §S4b generalisation of the §S2 guard: a check hardcoded to one dead
// filename (`test_bun_crucible_context.py`) missed the SECOND dangling
// citation GREEN found in the very file it was fixing
// (tests/client/test_bun_crucible_gates.py's `test_toon.py` mention, renamed
// by CR-046). The generalised rule: no docstring/comment under `tests/` may
// cite a `test_*.py` or `*.test.ts` filename that does not exist on disk.
//
// SECOND FIXUP (2026-08-03) — the first generalisation above went RED on
// ~15 sites tree-wide, most of them legitimate: CR-CRU-053's own Non-goals
// exclude "other stale CR-era narration not involving the mirror" from this
// CR's scope, so a LITERAL whole-tree rule contradicted the CR it serves.
// The fix mirrors the §S4 mirror guard's own WARNING/TRAP/HISTORY
// three-way classification above — not every dangling citation is the SAME
// defect. One narrated, in the citing file itself, as retired/renamed is
// exactly the "preserve RED-phase history, labelled as history" pattern §S1
// mandates (legal, carved out below). One cited in the PRESENT TENSE as a
// live sibling/convention/fixture source, with NOTHING marking it as gone,
// is the real defect this guard exists to catch (illegal, stays flagged).
//
// Discrimination rule (implemented by isHistoryCitation, below the citable-
// text extractor it reuses): HISTORY iff the citing FILE's own extracted
// docstring/comment text — never raw source, so a fixture/string literal
// coincidentally near a keyword can never legalize a citation — contains a
// retirement/rename keyword (retired/retirement/archived/archival/archive/
// renam(ed/ing)/"ceases to exist"/deleted/removed/superseded) within 80
// chars of ANY occurrence of the cited filename; otherwise LIVE.
//
// Critically, this is evaluated PER CITING FILE, never per dead-filename
// globally — a name that some OTHER file correctly narrates as retired
// does NOT legalize a DIFFERENT file's undisclosed live citation of that
// SAME dead name. Concretely: tests/agent-role.test.ts explicitly says
// "tests/phase-role.test.ts is retired (its subject ceases to exist)" —
// legal, in that file. But tests/f13-fidelity.test.ts:46 cites the exact
// same dead name in a "Reused, unchanged testids: ... tests/phase-role.
// test.ts" list, and carries NO retirement narration of its own anywhere
// in that file — it stays flagged. The previous fixup's report that
// ingest-routes.test.ts / v1-sections.test.ts / phase-role.test.ts /
// shim-projects-agents.test.ts / agent-phase.test.ts / docs-agent-phase-
// channel.test.ts / shim-ingest-events.test.ts / toon.test.ts were "all
// self-narrated as history" was checked BY HAND for this fixup and found
// FALSE for several sites sharing those dead names in OTHER files (full
// per-site table in this run's final report) — the carve-out below is
// built from that verification, not from trusting the prior claim.
//
// The 80-char window was derived by measuring every genuine retirement/
// rename narration on this branch (verified via a throwaway scan before
// writing this file): the closest sits 8 chars away ("moved to tests/
// archive/v1-sections.test.ts on shim retirement" — "archive" 8 chars
// before the match), the farthest measured is 40 chars ("fleet-wide
// phase->role rename reaches this file too (was tests/agent-phase.
// test.ts)" — "rename" 40 chars before the match); every genuine LIVE
// citation carries NO such keyword anywhere in its citing file at all, so
// no window size in the tested range misclassifies either direction.
//
// Net effect: this guard now stays RED on 9 genuinely LIVE citations (11
// hits — two files cite their dead name twice each), not only the 2 named
// in the mirror-fixup dispatch:
//   tests/client/test_bun_crucible_gates.py:48          -> test_toon.py
//   tests/client/test_crucible_axi_shared.py:22         -> test_toon.py
//   tests/client/test_cr046_official_toon_roundtrip.py:2 -> test_toon.py
//   tests/e2e/steps/harness.ts:216 (x2 occurrences)      -> ingest-routes.test.ts
//   tests/v2-runs-events.test.ts:72 (x2 occurrences)     -> ingest-routes.test.ts
//   tests/f13-fidelity.test.ts:46                        -> phase-role.test.ts
//   tests/agent-lifecycle.test.ts:13                     -> shim-projects-agents.test.ts
//   tests/plans.test.ts:6                                -> shim-ingest-events.test.ts
//   tests/toon-conformance.test.ts:6                     -> toon.test.ts
// GREEN's scope for this guard is therefore all 9 sites above, not only the
// 2 the dispatch anticipated — flagged here as a finding, not silently
// narrowed to make a smaller number look tidy.

// Joins prose lines the way a reader would: a normal line break becomes a
// space, but a line ending in a bare hyphen (a mid-word wrap, e.g.
// "workflow-" / "tab.test.ts" split across two `//`/`#`/` * ` comment
// lines) is joined with NO separator so the wrapped filename reassembles
// correctly instead of shearing off its prefix.
function joinWrapped(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (out.endsWith("-")) out += line;
    else if (out.length > 0) out += ` ${line}`;
    else out = line;
  }
  return out;
}

// Lexes a Python source file's STRING-LITERAL layer (not its grammar — no
// parser, no AST) and returns every triple-quoted literal that stands ALONE
// at statement position, i.e. nothing but whitespace and an optional string
// prefix (`r`/`b`/`u`/`f`) sits between the start of its line and the opening
// quote. That shape IS the docstring form, at every level Python allows one:
// module, class, function, async function, and nested/inner function. It is a
// structural rule, not a keyword heuristic — no "looks like a def above it"
// guessing is involved.
//
// The lexer exists because a line-oriented regex cannot tell an OPENING quote
// from a `"""` sitting inside another string or after a `#`. Walking the
// text once, consuming `#`-to-EOL runs and whole string literals (honouring
// backslash escapes, which suppress a closing quote in raw and non-raw
// strings alike), makes that determination exact.
//
// What statement position deliberately EXCLUDES is the fixture shape this
// extractor exists to keep out: `FIXTURE = """<testsuite name="toon.test.ts"/>"""`
// and `f("""...""")` both carry non-whitespace before the quote on their line,
// so neither is ever mistaken for prose.
//
// Only TRIPLE-quoted literals are collected. Python does permit a docstring
// written with a single- or double-quoted literal (`def f():` / `    "doc"`),
// and such a docstring is NOT scanned — deliberately, not by oversight: at
// statement position a plain `"..."` is indistinguishable from a wrapped
// argument or list element (`parser.add_argument(\n  "--foo",\n  "help",\n)`),
// so collecting them would drag argv and fixture literals back in. There are
// zero non-triple-quoted docstrings under `tests/` today (verified against a
// throwaway `ast.get_docstring` walk of all 48 modules), and that same walk
// confirmed this lexer captures 412 of 412 real docstrings with zero extra
// blocks — but a future one written in that form would evade this scan.
function pythonStatementStrings(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = ++i;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch !== '"' && ch !== "'") {
      i++;
      continue;
    }
    const triple = text.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    const statementPosition = /^\s*(?:[rRbBuUfF]{0,2})$/.test(text.slice(lineStart, i));
    const bodyStart = i + quote.length;
    let j = bodyStart;
    let terminated = false;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text.startsWith(quote, j)) {
        terminated = true;
        break;
      }
      // An unterminated single-quoted literal cannot span a newline — bail
      // rather than swallowing the rest of the file as one string.
      if (!triple && text[j] === "\n") break;
      j++;
    }
    const bodyEnd = Math.min(j, text.length);
    if (triple && statementPosition && terminated) out.push(text.slice(bodyStart, bodyEnd));
    const consumedEnd = terminated ? bodyEnd + quote.length : bodyEnd;
    const lastNewline = text.slice(i, consumedEnd).lastIndexOf("\n");
    if (lastNewline !== -1) lineStart = i + lastNewline + 1;
    i = Math.max(consumedEnd, i + 1);
  }
  return out;
}

// Extracts ONLY docstring/comment prose from a file — never string literals
// (fixture JUnit XML bodies, argv arrays, tmp-file names written by a test)
// — so a fixture like `<testsuite name="toon.test.ts">` or a dynamically
// written `test_probe.py` never counts as a "citation". For `.py` files:
// every docstring — module, class AND function (see pythonStatementStrings
// above for how they are identified, and for the one docstring form it
// deliberately does not cover) — plus every `#` line comment. For `.ts`
// files: every `/* ... */` block (JSDoc marker lines stripped) plus every
// `//` line comment.
//
// FUNCTION/CLASS docstrings were added in the CR-CRU-053 C2 fix round. The
// previous version read only the module docstring (the file's very first
// statement), which made every function and class docstring in the tree
// invisible to this guard — and two real dangling `test_toon.py` citations
// were in fact living in function docstrings
// (test_cr046_official_toon_roundtrip.py's `_load_toon_module`,
// test_crucible_axi_shared.py's `_load_axi_module`, both since narrated as
// history). VERIFY caught those by hand, not by this scan. Closing the gap
// beat documenting it because the fix needed no Python parser and no
// heuristic — just an exact lexical rule — and it reclassified nothing:
// measured across `tests/` immediately before and after, the (file, cited
// name, verdict) set is IDENTICAL, 0 live both sides, history 24 -> 26 (the
// two function-docstring occurrences above, newly visible, both correctly
// carved out as history by their own retirement narration).
function extractCitableText(relPath: string, text: string): string {
  if (relPath.endsWith(".py")) {
    const docstrings = pythonStatementStrings(text)
      .map((body) => joinWrapped(body.split("\n").map((l) => l.trim())))
      .join("\n");
    const lineComments = joinWrapped(
      text
        .split("\n")
        .filter((line) => line.trim().startsWith("#"))
        .map((line) => line.trim().replace(/^#+\s?/, "")),
    );
    return `${docstrings}\n${lineComments}`;
  }
  const blockComments = (text.match(/\/\*[\s\S]*?\*\//g) ?? [])
    .map((block) =>
      joinWrapped(
        block
          .replace(/^\/\*\*?/, "")
          .replace(/\*\/$/, "")
          .split("\n")
          .map((l) => l.trim().replace(/^\*\s?/, "")),
      ),
    )
    .join("\n");
  const lineComments = joinWrapped(
    (text.match(/\/\/[^\n]*/g) ?? []).map((line) => line.replace(/^\/\/\s?/, "")),
  );
  return `${blockComments}\n${lineComments}`;
}

// Matches a bare `test_*.py` module name or a `*.test.ts` file name (basename
// only — a leading `tests/...` path prefix, if any, is naturally excluded
// because `/` is not in the allowed character class).
const DEAD_FILE_PATTERN = /\b(test_[A-Za-z0-9_]+\.py|[A-Za-z0-9][A-Za-z0-9_.-]*\.test\.ts)\b/g;

// HISTORY-vs-LIVE classifier for dangling citations — see the discrimination
// rule spelled out in the comment block above. Operates on the SAME
// extracted citable text scanDanglingFileCitations already computes for the
// file, never raw source, so a fixture/string literal coincidentally near a
// keyword can never legalize a citation.
const HISTORY_WINDOW = 80;
const RETIREMENT_SIGNAL =
  /\b(retired|retirement|archived|archival|archive|renam\w*|ceases\s+to\s+exist|deleted|removed|superseded)\b/gi;

function isHistoryCitation(citableText: string, cited: string): boolean {
  let searchFrom = 0;
  while (true) {
    const found = citableText.indexOf(cited, searchFrom);
    if (found === -1) return false;
    const windowStart = Math.max(0, found - HISTORY_WINDOW);
    const windowEnd = Math.min(citableText.length, found + cited.length + HISTORY_WINDOW);
    const window = citableText.slice(windowStart, windowEnd);
    RETIREMENT_SIGNAL.lastIndex = 0;
    if (RETIREMENT_SIGNAL.test(window)) return true;
    searchFrom = found + cited.length;
  }
}

interface DanglingCitation {
  relPath: string;
  line: number;
  cited: string;
  verdict: "live" | "history";
}

function scanDanglingFileCitations(): DanglingCitation[] {
  const existing = new Set(
    listFiles("tests", [".py", ".ts"]).map((abs) => abs.split("/").pop() as string),
  );
  const files = listFiles("tests", [".ts", ".py"]).filter(
    (abs) => abs.slice(REPO_ROOT.length + 1) !== SELF_REL_PATH,
  );
  const hits: DanglingCitation[] = [];
  for (const abs of files) {
    const text = readFileSync(abs, "utf8");
    const relPath = abs.slice(REPO_ROOT.length + 1);
    const citable = extractCitableText(relPath, text);
    for (const m of citable.matchAll(DEAD_FILE_PATTERN)) {
      const cited = m[0];
      if (existing.has(cited)) continue;
      // Best-effort line lookup on the RAW text for provenance only (this
      // file's own convention: re-derived, do not trust it blindly) — a
      // literal search first, falling back to the citation's tail (the
      // wrapped case, where the full name never appears contiguous in the
      // raw source because a real newline sits inside it).
      let idx = text.indexOf(cited);
      if (idx === -1) idx = text.indexOf(cited.slice(-Math.min(12, cited.length)));
      const line = idx === -1 ? -1 : text.slice(0, idx).split("\n").length;
      const verdict: "live" | "history" = isHistoryCitation(citable, cited) ? "history" : "live";
      hits.push({ relPath, line, cited, verdict });
    }
  }
  return hits;
}

describe("§S2/§S4b guard — no docstring/comment in tests/ cites a test_*.py or *.test.ts filename that does not exist on disk", () => {
  test("zero LIVE dangling test-file citations survive anywhere under tests/ (history-narrated citations are carved out, live ones are not)", () => {
    // WHAT "ANYWHERE" MEANS — the honest scope of this claim, so a reader
    // never has to infer it from the extractor's implementation. The scan
    // covers, for every file under `tests/`:
    //   .py  — every docstring (module, class, function, async, nested) plus
    //          every `#` line comment;
    //   .ts  — every `/* ... */` block plus every `//` line comment.
    // It deliberately does NOT read string literals (fixture XML bodies,
    // argv arrays, tmp filenames a test writes), and the one prose form it
    // cannot see is a Python docstring written with a non-triple-quoted
    // literal — see pythonStatementStrings above for why that exclusion is
    // load-bearing rather than an oversight. Zero such docstrings exist
    // under `tests/` today.
    //
    // THIRD FIXUP (2026-08-03) — the PREVIOUS version of this guard asserted
    // `expect(liveSorted).toEqual([ ...11 entries... ])`: an EQUALS-the-
    // current-state snapshot, which is exactly the wrong shape for a
    // guard — it passed today (pinning the defect) and would have gone RED
    // the moment GREEN fixed even one site (backwards: a passing test
    // breaking as bugs get fixed). The CONTRACT this guard exists to
    // enforce is "zero live dangling citations survive", full stop — so the
    // assertion is `toEqual([])`, never a literal snapshot of what's
    // currently broken. Any future edit to this test must preserve that
    // shape; re-introducing an equals-current-state list is the same bug a
    // third time.
    //
    // BORN RED today: 11 live hits across 9 files (two files cite their dead
    // name twice each) — re-derived by hand, per the discrimination-rule
    // comment block above:
    //   tests/agent-lifecycle.test.ts:13                     -> shim-projects-agents.test.ts
    //   tests/client/test_bun_crucible_gates.py:48           -> test_toon.py
    //   tests/client/test_cr046_official_toon_roundtrip.py:2 -> test_toon.py
    //   tests/client/test_crucible_axi_shared.py:22          -> test_toon.py
    //   tests/e2e/steps/harness.ts:216 (x2 occurrences)      -> ingest-routes.test.ts
    //   tests/f13-fidelity.test.ts:46                        -> phase-role.test.ts
    //   tests/plans.test.ts:6                                -> shim-ingest-events.test.ts
    //   tests/toon-conformance.test.ts:6                     -> toon.test.ts
    //   tests/v2-runs-events.test.ts:72 (x2 occurrences)     -> ingest-routes.test.ts
    // This test goes GREEN only once GREEN has fixed every one of those 11
    // sites (rewording, deleting, or narrating each as history) — not
    // before, and not partially.
    const survivors = scanDanglingFileCitations();
    const live = survivors.filter((s) => s.verdict === "live");

    // Formatted, not the raw object array: on failure a reader sees each
    // surviving site as `relPath:line -> cited`, exactly the shape GREEN
    // needs to work through the remaining list.
    const liveFormatted = live
      .map((s) => `${s.relPath}:${s.line} -> ${s.cited}`)
      .sort();

    // THE CONTRACT: none survive.
    expect(liveFormatted).toEqual([]);
  });

  test("history-narrated dangling citations are correctly carved out as legal, and the carve-out is not vacuously swallowing everything (sanity)", () => {
    // Guards against two failure modes at once: (a) a broken classifier
    // that never fires (every citation would land in the "live" bucket
    // above, making the previous test over-broad again — the exact defect
    // this fixup exists to correct); (b) a classifier so loose it swallows
    // genuinely live citations too (every hit would be "history", making
    // the previous test vacuously pass with an empty live set). BORN GREEN
    // today; stays green after this fixup lands, and would catch either
    // regression above.
    const survivors = scanDanglingFileCitations();
    const history = survivors.filter((s) => s.verdict === "history");

    // At least the two model examples verified by hand: an explicit
    // "is retired (... ceases to exist)" narration (agent-role.test.ts) and
    // an explicit "moved to tests/archive/... on shim retirement" narration
    // (codec-parsepath.test.ts), both citing dead names that STAY live
    // elsewhere in the tree (proving the carve-out is per-FILE, not
    // per-dead-name).
    expect(
      history.some(
        (h) => h.relPath === join("tests", "agent-role.test.ts") && h.cited === "phase-role.test.ts",
      ),
    ).toBe(true);
    expect(
      history.some(
        (h) => h.relPath === join("tests", "codec-parsepath.test.ts") && h.cited === "v1-sections.test.ts",
      ),
    ).toBe(true);
    // Bound: history hits exist but do not swallow the whole survivor set —
    // the live set asserted above (11 hits) must remain non-empty alongside
    // these.
    expect(history.length).toBeGreaterThanOrEqual(7);
    expect(survivors.length).toBe(history.length + survivors.filter((s) => s.verdict === "live").length);
  });

  test("the file test_bun_crucible_context.py does not exist on disk (confirms the deletion the danglers point at)", () => {
    // BORN GREEN — sanity check that the premise of the guard above is
    // real: the file really was deleted (2026-08-01, per Scope), not
    // merely renamed to something the scan above would miss.
    let exists = true;
    try {
      statSync(join(REPO_ROOT, "tests", "client", "test_bun_crucible_context.py"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("no present-tense claim that the home ~/.claude/scripts mirror is synced survives in test_bun_crucible_gates.py (§S4b)", () => {
    // Location RE-DERIVED at execution time (2026-08-03): lines 46-47 of
    // tests/client/test_bun_crucible_gates.py's module docstring today
    // (NOT the original spec's `:47` alone — do not trust it, re-grep).
    // BORN RED today: the docstring reads "...only the in-repo `clients/`
    // directory has `toon.py` sitting next to `bun-crucible.py` today (the
    // home mirror is not yet re-synced past the C4 GREEN commit)" —
    // present tense, implying the mirror IS synced, however lagging. That
    // is false under the standing delivery model (§S3 of this CR): the
    // mirror is retired, no install step syncs it, full stop. GREEN's
    // §S4b fix (reword to state the mirror is retired, not "not yet
    // re-synced") is what turns this green.
    const gates = readText(join("tests", "client", "test_bun_crucible_gates.py"));
    expect(gates).not.toMatch(/mirror\s+is\s+(?:not\s+yet\s+)?re-synced/i);
    expect(gates).not.toMatch(/mirror\s+is\s+(?:currently\s+|already\s+)?synced/i);
  });
});
