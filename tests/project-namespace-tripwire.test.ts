// CR-CRU-097 §S6 — THE NAMESPACE TRIPWIRE.
//
// Crucible runs against ANY project. Three surfaces had quietly learned our
// own backlog: the BDD empty state (§S1, fixed in C1), the CLI help lines
// (§S2, fixed here in C3), and the regression fixtures that replicated our
// live board (§S3, fixed in C2). Every gate was green through all of it —
// nothing looked. This file looks.
//
// THE PATTERN IS NAMESPACE-AGNOSTIC ON PURPOSE: `CR-[A-Z]{2,}-\d+`, never
// `CR-CRU-`. §S2 measured why — `rust-crucible.py` taught `CR-NAI-203`, a
// DIFFERENT project's namespace, so a criterion naming our own literal would
// have shipped green over it. The defect class is "some real project's ids",
// not "our ids". Every carve-out below is therefore expressed as a KIND or a
// NAME with its reason stated here in the code; none of them is a hole
// widened in the regex, because a regex hole is indistinguishable from a gap
// in the tripwire (AC7a).
//
// IT EXTENDS, IT DOES NOT REINVENT. The tree walker and the
// comment-vs-live-text classifier come from tests/helpers/source-scan.ts,
// lifted out of tests/docs-retired-mirror-references.test.ts, which proved
// them. CR-CRU-096's C1 fix round exists because a hand-rolled stripper
// (`animatingSelectors`) never stripped comments, so a provenance comment
// leaked into a selector string and a test asserted on it. A tripwire whose
// whole correctness rests on "comments are exempt" reuses the proven
// classifier or it is worthless.
//
// HOW AN OCCURRENCE IS CLASSIFIED AS COMMENT-OR-NOT, exactly, with no second
// stripper: every match in a file is replaced by a unique alphanumeric
// sentinel, the WHOLE substituted file is run through `extractCitableText`
// ONCE, and an occurrence is prose iff its sentinel comes back out. That is
// the lifted classifier answering per-occurrence — a round trip, not a
// re-derivation. It also inherits the classifier's one documented blind spot
// (a single-quoted Python docstring), which no file in this repo uses.
//
// WHY AC2 IS MEASURED BY DRIVING THE CLI AND NOT BY READING SOURCE — a
// finding, measured 2026-09-03, that makes source-reading provably
// insufficient: four clients pass `description=__doc__` to argparse, so the
// MODULE DOCSTRING is printed as the root help. The same bytes are
// simultaneously provenance (exempt, AC8) and rendered user-visible text (in
// scope, AC2). No classifier can separate those two roles, because the role
// is decided at the argparse call site, not in the text. Only the printed
// surface can be judged, so this file spawns all five clients and reads what
// they actually PRINT — 159 (client, verb) surfaces, root help included.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCitableText, joinWrapped, listFiles, REPO_ROOT } from "./helpers/source-scan";

// The one pattern, used by all three dimensions. Namespace-agnostic (AC7):
// two-or-more capitals for the project segment, digits for the number. It
// matches OUR ids, another project's ids, and a test's invented ids alike —
// telling those apart is the job of the reasoned carve-outs below, never of
// this regex.
const CR_LITERAL = /CR-[A-Z]{2,}-\d+/g;

const CLIENTS = [
  "arduino-crucible.py",
  "bun-crucible.py",
  "mvn-crucible.py",
  "python-crucible.py",
  "rust-crucible.py",
] as const;

interface Occurrence {
  id: string;
  index: number;
  line: number;
  isProse: boolean;
}

// PROSE MASK — the one place comment-vs-live-text is decided, for ANY set of
// positions in a file, by sentinel round trip through the lifted
// `extractCitableText`: each position is replaced by a unique alphanumeric
// sentinel, the whole substituted file is classified ONCE, and a position is
// prose iff its sentinel comes back out. Used for CR literals AND for the
// `expect(` / `assert` openers that delimit an assertion, so an `expect(`
// quoted inside a comment can never open a span over live code.
//
// The sentinel is bare alphanumerics: it survives `joinWrapped`'s
// hyphen-splice rule and carries no quote, `#` or `*` that could change how
// the classifier lexes the file around it.
function proseMask(relPath: string, text: string, hits: { index: number; length: number }[]): boolean[] {
  if (hits.length === 0) return [];
  let substituted = "";
  let cursor = 0;
  hits.forEach((h, i) => {
    substituted += `${text.slice(cursor, h.index)}CRMARK${i}END`;
    cursor = h.index + h.length;
  });
  substituted += text.slice(cursor);
  const citable = extractCitableText(relPath, substituted);
  return hits.map((_, i) => citable.includes(`CRMARK${i}END`));
}

function classifyOccurrences(relPath: string, text: string): Occurrence[] {
  const raw: { id: string; index: number; length: number }[] = [];
  for (const m of text.matchAll(CR_LITERAL)) {
    raw.push({ id: m[0], index: m.index ?? 0, length: m[0].length });
  }
  const prose = proseMask(relPath, text, raw);
  return raw.map((r, i) => ({
    id: r.id,
    index: r.index,
    line: text.slice(0, r.index).split("\n").length,
    isProse: prose[i],
  }));
}

type Span = [number, number];

function spanContains(spans: Span[], index: number): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

// Walks from `from` to the end of the balanced bracket group it opens.
function balancedEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  let opened = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      opened = true;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (opened && depth <= 0) return i + 1;
    } else if (c === ";" && depth <= 0 && opened) {
      return i;
    }
    i++;
  }
  return text.length;
}

// Walks from `from` to the end of the STATEMENT it opens, so a matcher
// chained after the closing paren stays inside the span —
// `expect(v).toBe("CR-X-1")` puts the literal in the matcher, not in
// `expect`'s own arguments, and a group-balanced walk would stop one call
// too early and see nothing. Bails at the enclosing block's closer so an
// unterminated statement can never swallow the rest of the file.
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return i;
    } else if (c === ";" && depth === 0) return i;
  }
  return text.length;
}

// EXEMPT BY KIND #1 — a `describe()` / `test()` / `it()` TITLE that cites the
// CR the test belongs to. This is the repo's established convention for
// design lineage: hundreds of titles across tests/ read
// "CR-CRU-0NN §S4/AC12 — ...", six of them in the very files §S5 rewrote. A
// title names the DESIGN the test defends; it is not a value the product
// must produce, and stripping it would erase the lineage AC8 protects
// everywhere else.
// The span is the whole title ARGUMENT, not the first string literal in it:
// a long title is written as concatenated chunks
// (`"a CR the store never held ... " + "wave block (CR-CRU-095 §S3/AC12 ...)"`)
// and stopping at the first closing quote would leave the rest of the same
// title looking like live code. The title always ends where the callback
// begins, so the span runs from the call's `(` to the first `=>` /
// `function (` inside it, clamped to the call's own closing paren. A comma
// is NOT used as the boundary because titles contain commas; if a title ever
// contained a literal `=>` the span would end early and the tripwire would
// OVER-report — a loud failure in the file that wrote it, never a silent
// hole, which is the direction of error a tripwire must choose.
function titleSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(/\b(?:describe|test|it)(?:\.\w+)?\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = balancedEnd(text, open);
    const callback = /=>|\bfunction\s*\(/.exec(text.slice(open, close));
    spans.push([open, callback === null ? close : open + callback.index]);
  }
  return spans;
}

// RULED, NOT CODED — a test's own DIAGNOSTIC failure message.
// tests/queue-canonical-order.test.ts:138 throws
// `CR-CRU-095: ${cr} is absent from the published order`, and
// tests/roadmap-registration-store.test.ts:194 has the same shape. Both are
// EXEMPT, and the argument is: a thrown diagnostic is the test telling a
// maintainer WHICH CONTRACT IT WAS CHECKING when it broke. It is never
// compared against a product value, never rendered to a user of any project,
// and it decays harmlessly — if CR-CRU-095's ordering rule is replaced the
// message misleads nobody who has the stack trace. It is a provenance
// comment wearing a string's clothes because `throw` needs one. §S6's
// exemption is written for "comments and docstrings" and so does not
// literally reach it; this is that exemption extended to the identical case,
// stated openly.
//
// It needs NO code, and deliberately gets none: a thrown diagnostic sits
// outside every assertion span by construction, so the scope rule below
// already spares it. An exemption keyed on `new Error(` would have been
// worse than redundant — inside an assertion, `new Error("CR-X-1 ...")` is
// almost always the EXPECTED error of a product call
// (`expect(fn).toThrow(new Error(...))`), which is a product contract and
// must stay reportable.

// EXEMPT BY NAME — the named constants that are ALLOWED to hold real ids,
// each with the reason it is allowed. AC5's dated reproduction is the whole
// point of the mechanism: a defect that only reproduces on the arrangement
// the board actually had may keep those rows, in ONE named, dated constant,
// asserting the reproduction and never a rule.
const EXEMPT_CONSTANTS: Record<string, { file: string; reason: string }> = {
  BOARD_SNAPSHOT_2026_09_02: {
    file: join("tests", "queue-canonical-order.test.ts"),
    reason:
      "AC5's dated reproduction — this project's own board as it stood on 2026-09-02, " +
      "frozen so CR-CRU-095's defect keeps reproducing. The rules around it run on synthetic ids.",
  },
  SYNTHETIC_TRIPWIRE_FIXTURE: {
    file: join("tests", "project-namespace-tripwire.test.ts"),
    reason:
      "This file's own non-vacuity fixture (AC7's self-test): source text with literals PLANTED " +
      "in it, fed to the checkers as a pure function so the tripwire can be proven to fire " +
      "without editing a real file. The planted namespaces name no project that exists.",
  },
};

function exemptConstantSpans(relPath: string, text: string): Span[] {
  const spans: Span[] = [];
  for (const [name, entry] of Object.entries(EXEMPT_CONSTANTS)) {
    if (entry.file !== relPath) continue;
    for (const m of text.matchAll(new RegExp(`(?:^|\\b)${name}\\s*[:=]`, "g"))) {
      const start = m.index ?? 0;
      spans.push([start, balancedEnd(text, start)]);
    }
  }
  return spans;
}

// EXEMPT BY KIND #3 — namespaces the suite INVENTS. A synthetic id is the
// remedy §S5/AC4 prescribes, so a tripwire that flagged one would forbid the
// fix. Deny-by-default: a namespace is synthetic only if it is listed HERE,
// so a real project's namespace arriving tomorrow (`CR-XYZ-7`) is caught
// without this file being touched. Enumerated 2026-09-03 by scanning every
// assertion in tests/; each entry was read at its use site to confirm the
// ids are authored by the test that consumes them.
const SYNTHETIC_NAMESPACES: Record<string, string> = {
  "CR-AAA": "test_crucible_axi_shared.py — two-agent warning fixture",
  "CR-AUTH": "cycle/plan fixtures for an authored-but-unplanned CR",
  "CR-AUTHORED": "§S5's synthetic wave-block rows (AC4's remedy)",
  "CR-BBB": "test_crucible_axi_shared.py — the second agent of the pair",
  "CR-DEAD": "next-resolver fixture for a CR that no longer exists",
  "CR-DECLARED": "§S5's synthetic declaration-order rows (AC4's remedy)",
  "CR-DEFERRED": "§S5's synthetic wave-6 rows (AC4's remedy)",
  "CR-DRIFT": "e2e agent-identity fixture",
  "CR-GW": "workflow gate-widget fixture",
  "CR-NEW": "§S5's synthetic newly-planned rows (AC4's remedy)",
  "CR-NT": "f13 fidelity fixture — a no-title CR",
  "CR-ORD": "workflow-history ordering fixture",
  "CR-PLANLESS": "home-marker fixture — a run with no plan",
  "CR-RM": "roadmap-pane fixtures",
  "CR-SHIPPED": "§S5's synthetic completed rows (AC4's remedy)",
  "CR-SOLO": "f13 fidelity fixture — a single-CR workflow",
};

// EXEMPT BY NAME (AC7a) — the four files whose fixtures hold ANOTHER
// project's real ids. They are carved out by name, never by a regex that
// quietly excludes them, and the reason is that they cannot decay the way
// our own ids do: our board cannot move `CR-NAI-*`, and decay through our
// own authoring is the mechanism §S3 objects to. Churning four otherwise
// untouched files would also contradict CR-CRU-096's own finding that a
// REPRODUCTION may use real data. Counts measured 2026-09-03. The tripwire
// still covers them namespace-agnostically for any NEW namespace: only the
// listed one is carved out per file.
const FOREIGN_FIXTURE_FILES: Record<string, { namespace: string; refs: number }> = {
  [join("tests", "f13-fidelity.test.ts")]: { namespace: "CR-NAI", refs: 21 },
  [join("tests", "milestone-merge-rows.test.ts")]: { namespace: "CR-NAI", refs: 18 },
  [join("tests", "gate-milestone-server.test.ts")]: { namespace: "CR-NAI", refs: 10 },
  [join("tests", "client", "test_bun_crucible_gates.py")]: { namespace: "CR-NAI", refs: 4 },
};

// An assertion, for the purposes of §S6's "no test file ... asserts on one":
// the statement an `expect(...)` chain spans (so both `expect("CR-X-1")` and
// `expect(v).toBe("CR-X-1")` are inside it), or, in Python, the `assert` /
// `self.assertX(...)` line. Fixture SETUP is deliberately not an assertion —
// see the residue finding below for what that leaves uncovered and why this
// file states it instead of implying it.
// Openers quoted inside a comment or docstring are dropped through the same
// prose mask: a narrated `// expect(...)` would otherwise open a span over
// the live code beneath it and make the tripwire report fixture setup as an
// assertion.
function assertionSpans(relPath: string, text: string): Span[] {
  const opener = relPath.endsWith(".py")
    ? /(?:assert\b|self\.assert[A-Za-z]*\()/g
    : /\bexpect\(/g;
  const openers: { index: number; length: number }[] = [];
  for (const m of text.matchAll(opener)) openers.push({ index: m.index ?? 0, length: m[0].length });
  const prose = proseMask(relPath, text, openers);
  const spans: Span[] = [];
  openers.forEach((o, i) => {
    if (prose[i]) return;
    if (relPath.endsWith(".py")) {
      // Python's assertion is a statement: it runs to the end of its LOGICAL
      // line, so a bare `assert x in y` ends at the newline while a wrapped
      // `self.assertEqual(\n  ...,\n)` ends at the newline that closes its
      // brackets. A bracket-only walk would run to end-of-file on the bare
      // form, which opens no bracket at all.
      const lineStart = text.lastIndexOf("\n", o.index) + 1;
      let depth = 0;
      let j = o.index;
      while (j < text.length) {
        const c = text[j];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "\n" && depth <= 0) break;
        j++;
      }
      spans.push([lineStart, j]);
      return;
    }
    const start = o.index + o.length - 1;
    spans.push([start, statementEnd(text, start)]);
  });
  return spans;
}

export interface Leak {
  relPath: string;
  line: number;
  id: string;
}

// AC7's checker, as a PURE FUNCTION of (path, text) so the self-test can
// plant a literal without touching a real file.
function assertedLiterals(relPath: string, text: string): Leak[] {
  const foreign = FOREIGN_FIXTURE_FILES[relPath];
  const assertions = assertionSpans(relPath, text);
  const exempt = [...titleSpans(text), ...exemptConstantSpans(relPath, text)];
  return classifyOccurrences(relPath, text)
    .filter((o) => !o.isProse)
    .filter((o) => SYNTHETIC_NAMESPACES[o.id.replace(/-\d+$/, "")] === undefined)
    .filter((o) => foreign === undefined || !o.id.startsWith(`${foreign.namespace}-`))
    .filter((o) => spanContains(assertions, o.index))
    .filter((o) => !spanContains(exempt, o.index))
    .map((o) => ({ relPath, line: o.line, id: o.id }));
}

// AC3's checker. `public/` ships to every project's browser, so the rule is
// harder there: ANY occurrence outside a comment is a leak, asserted or not,
// and no synthetic allow-list applies — invented ids have no business in
// shipped UI text either.
function userVisibleLiterals(relPath: string, text: string): Leak[] {
  return classifyOccurrences(relPath, text)
    .filter((o) => !o.isProse)
    .map((o) => ({ relPath, line: o.line, id: o.id }));
}

// AC2's checker. `joinWrapped` (the same lifted helper) is applied FIRST and
// is load-bearing, not decoration: argparse hard-wraps help text at the
// terminal width, and it wraps after a hyphen — so a leak can reach the user
// as "CR-CRU-" on one line and "086" on the next, which a line-wise regex
// would never see. The spawn also pins COLUMNS, so the two defences are
// independent.
function printedLiterals(text: string): string[] {
  return joinWrapped(text.split("\n").map((l) => l.trim())).match(CR_LITERAL) ?? [];
}

interface HelpSurface {
  client: string;
  verb: string;
  text: string;
  exitCode: number;
}

async function collectHelpSurfaces(): Promise<HelpSurface[]> {
  const run = async (client: string, args: string[]): Promise<{ text: string; exitCode: number }> => {
    const proc = Bun.spawn({
      cmd: ["python3", join(REPO_ROOT, "clients", client), ...args],
      cwd: REPO_ROOT,
      // COLUMNS pins argparse's wrap width so the surface is deterministic
      // across terminals and CI.
      env: { ...process.env, COLUMNS: "200" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { text: `${out}${err}`, exitCode: await proc.exited };
  };

  const surfaces: HelpSurface[] = [];
  for (const client of CLIENTS) {
    const root = await run(client, ["--help"]);
    surfaces.push({ client, verb: "<root>", ...root });
    // The verb list comes from argparse's own choices group in the usage
    // line, so a verb added tomorrow is covered without editing this file.
    // Whitespace is squeezed out because the usage line wraps.
    const choices = /\{([^}]*)\}/.exec(root.text);
    const verbs = (choices?.[1] ?? "")
      .replace(/\s+/g, "")
      .split(",")
      .filter((v) => /^[a-z0-9][a-z0-9-]*$/.test(v));
    const batchSize = 8;
    for (let i = 0; i < verbs.length; i += batchSize) {
      const batch = await Promise.all(
        verbs.slice(i, i + batchSize).map(async (verb) => ({ verb, ...(await run(client, [verb, "--help"])) })),
      );
      for (const b of batch) surfaces.push({ client, ...b });
    }
  }
  return surfaces;
}

// THE RESIDUE THIS CR DOES NOT TOUCH — pinned, enumerated, dated, never
// implied. Measured 2026-09-03 by this file's own checker: 220 real-namespace
// literals sit in assertions across these 41 files. Not one is in
// CR-CRU-097's scope — §S3 named three files (all now at zero) and AC7a four
// more (carved out above); these 41 are a pre-existing instance of the SAME
// class, found by building the tripwire. Churning 41 unrelated files from
// inside a tripwire CR is exactly the scope creep §S5 refused, so they are
// recorded here instead of edited, and reported as a finding.
//
// Pinned as a CEILING, not a target: a file may shrink freely, it may not
// grow, and a file absent from this table must be at ZERO. That is the
// forward guarantee — a new test asserting on a real project's CR id fails
// here, in the file that introduced it, on the day it is written.
const PRE_CR_ASSERTION_RESIDUE: Record<string, number> = {
  [join("tests", "agent-role.test.ts")]: 1,
  [join("tests", "ci-toolchain-provisioning.test.ts")]: 1,
  [join("tests", "client", "test_arduino_crucible_axi.py")]: 9,
  [join("tests", "client", "test_bun_crucible_auto_attach.py")]: 4,
  [join("tests", "client", "test_bun_crucible_cycle_add.py")]: 1,
  [join("tests", "client", "test_bun_crucible_lifecycle.py")]: 2,
  [join("tests", "client", "test_bun_crucible_toon_envelope.py")]: 4,
  [join("tests", "client", "test_bun_crucible_wave.py")]: 6,
  [join("tests", "client", "test_client_fleet_envelope_census.py")]: 5,
  [join("tests", "client", "test_cr017_client_lifecycle.py")]: 1,
  [join("tests", "client", "test_cr051_files_count_parity.py")]: 3,
  [join("tests", "client", "test_cr051_rust_files_count.py")]: 1,
  [join("tests", "client", "test_cr054_axi_context_lift.py")]: 5,
  [join("tests", "client", "test_cr054_drift_guard.py")]: 10,
  [join("tests", "client", "test_cr054_fleet_inventory.py")]: 14,
  [join("tests", "client", "test_cr054_verb_surface_lift.py")]: 7,
  [join("tests", "client", "test_cr069_uninstall.py")]: 1,
  [join("tests", "client", "test_cr070_systemd_unit.py")]: 6,
  [join("tests", "client", "test_cr071_upgrade_gate_and_restart.py")]: 13,
  [join("tests", "client", "test_cr084_release_packages.py")]: 3,
  [join("tests", "client", "test_cr087_console_failure_attribution.py")]: 1,
  [join("tests", "client", "test_cr091_roadmap_verbs.py")]: 7,
  [join("tests", "client", "test_cr092_next_decision_resolver.py")]: 8,
  [join("tests", "client", "test_cr095_next_consumes_published_order.py")]: 2,
  [join("tests", "client", "test_crucible_axi_shared.py")]: 3,
  [join("tests", "client", "test_crucible_axi_stages.py")]: 8,
  [join("tests", "client", "test_crucible_axi_wheel_packaging.py")]: 1,
  [join("tests", "client", "test_mvn_crucible_axi.py")]: 10,
  [join("tests", "client", "test_python_crucible_axi.py")]: 9,
  [join("tests", "client", "test_queue_file_verb.py")]: 23,
  [join("tests", "client", "test_rust_crucible_axi.py")]: 9,
  [join("tests", "cr009-release-bundle.test.ts")]: 1,
  [join("tests", "docs-project-delete-cascade-dn.test.ts")]: 1,
  [join("tests", "e2e", "teardown-contracts", "ephemeral.contract.ts")]: 1,
  [join("tests", "release-provenance.test.ts")]: 7,
  [join("tests", "releases.test.ts")]: 2,
  [join("tests", "roadmap-registration-routes.test.ts")]: 8,
  [join("tests", "roadmap-registration-store.test.ts")]: 5,
  [join("tests", "roadmap-release-focus.test.ts")]: 11,
  [join("tests", "storyboard-fidelity.test.ts")]: 3,
  [join("tests", "workflow-history-refinements.test.ts")]: 3,
};

// Source text with literals PLANTED in it — AC7's self-test input, plus the
// id each checker must report. Every namespace here (`CR-ZZZ`, `CR-QQQ`)
// belongs to no project and appears nowhere else in the repo, and the WHOLE
// constant — inputs and expected ids alike — is carved out by name in
// EXEMPT_CONSTANTS. The expected ids live in here rather than inline in the
// assertions below for exactly that reason: an expectation spelling
// `toEqual(["CR-ZZZ-3"])` in a test body would be a literal asserted outside
// a named constant, i.e. this file failing its own rule.
const SYNTHETIC_TRIPWIRE_FIXTURE = {
  asserted: [
    'describe("CR-ZZZ-1 — the title cites the CR this test defends", () => {',
    '  test("a planted literal in an assertion is a leak", () => {',
    "    // CR-ZZZ-2 in a provenance comment is exempt.",
    '    expect(row.cr).toBe("CR-ZZZ-3");',
    '    expect(other.cr).toBe("CR-NEW-9");',
    "    if (at === -1) throw new Error(`CR-ZZZ-4: ${cr} is absent`);",
    '    const label = "CR-ZZZ-5";',
    "  });",
    "});",
  ].join("\n"),
  assertedLeaks: ["CR-ZZZ-3"],
  publicSurface: [
    "// CR-QQQ-1 §S2 — provenance for the block below.",
    'const empty = "No BDD results yet — see CR-QQQ-2 for the plan.";',
  ].join("\n"),
  publicLeaks: ["CR-QQQ-2"],
  wrappedHelp: [
    "  --repair-provenance   Rewrite the run's provenance; a mismatch is REFUSED (§S4, CR-",
    "                        QQQ-3 §S2).",
  ].join("\n"),
  wrappedLeaks: ["CR-QQQ-3"],
  neutralHelp: "  --cr CR   CR id, e.g. the id your project uses.",
  foreignPlanted: 'test("x", () => { expect(a).toBe("CR-NAI-203"); expect(b).toBe("CR-ZZZ-8"); });',
  foreignLeaks: ["CR-ZZZ-8"],
  foreignNamespace: "CR-NAI",
};

describe("CR-CRU-097 §S2/AC2 — no help string any client PRINTS names a project's CR namespace", () => {
  test(
    "every verb's --help and every client's root help, driven for real, print no CR namespace literal",
    async () => {
      const surfaces = await collectHelpSurfaces();

      // NON-VACUITY FIRST. A green built on a mis-parsed verb list would be
      // worthless, and the parse is the only fragile step: it reads
      // argparse's choices group out of the usage line.
      expect(surfaces.filter((s) => s.verb === "<root>")).toHaveLength(CLIENTS.length);
      expect(surfaces.length).toBeGreaterThanOrEqual(150);
      for (const client of CLIENTS) {
        expect(surfaces.filter((s) => s.client === client && s.verb !== "<root>").length).toBeGreaterThanOrEqual(25);
      }
      expect(surfaces.filter((s) => s.exitCode !== 0 || s.text.trim().length === 0)).toEqual([]);

      const leaks = surfaces
        .map((s) => ({ surface: `${s.client} ${s.verb}`, ids: [...new Set(printedLiterals(s.text))].sort() }))
        .filter((s) => s.ids.length > 0);
      expect(leaks).toEqual([]);
    },
    180_000,
  );

  test("the printed-help checker sees a literal argparse wrapped across two lines", () => {
    // Proves the joinWrapped defence rather than assuming it: this is the
    // exact shape argparse produces when a help line breaks after a hyphen.
    expect(printedLiterals(SYNTHETIC_TRIPWIRE_FIXTURE.wrappedHelp)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.wrappedLeaks,
    );
    expect(printedLiterals(SYNTHETIC_TRIPWIRE_FIXTURE.neutralHelp)).toEqual([]);
  });
});

describe("CR-CRU-097 AC3 — no user-visible string in public/ names a CR", () => {
  test("every occurrence in public/ is provenance, not shipped text", () => {
    const files = listFiles("public", [".js", ".mjs", ".mts", ".css", ".html"]);
    expect(files.length).toBeGreaterThanOrEqual(5);
    const leaks = files.flatMap((abs) => {
      const relPath = abs.slice(REPO_ROOT.length + 1);
      return userVisibleLiterals(relPath, readFileSync(abs, "utf8"));
    });
    expect(leaks).toEqual([]);
  });

  test("the public/ checker reports a planted literal in a string and spares the comment above it", () => {
    const leaks = userVisibleLiterals("public/probe.js", SYNTHETIC_TRIPWIRE_FIXTURE.publicSurface);
    expect(leaks.map((l) => l.id)).toEqual(SYNTHETIC_TRIPWIRE_FIXTURE.publicLeaks);
  });
});

describe("CR-CRU-097 AC7/AC7a — no test asserts on a project CR literal outside a named, dated snapshot", () => {
  test("the three files §S5 rewrote assert on nothing but synthetic ids", () => {
    // §S3's board replicas, by name: the rule assertions now run on
    // synthetic rows and the one reproduction lives in the dated constant.
    for (const rel of [
      join("tests", "queue-canonical-order.test.ts"),
      join("tests", "queue-default-into-wave-block.test.ts"),
      join("tests", "queue-defaulted-seq-scope.test.ts"),
    ]) {
      expect(assertedLiterals(rel, readFileSync(join(REPO_ROOT, rel), "utf8"))).toEqual([]);
    }
  });

  test("no file under tests/ exceeds its pinned residue, and an unlisted file holds none", () => {
    const overruns: { relPath: string; found: number; pinned: number }[] = [];
    for (const abs of listFiles("tests", [".ts", ".py"])) {
      const relPath = abs.slice(REPO_ROOT.length + 1);
      const found = assertedLiterals(relPath, readFileSync(abs, "utf8")).length;
      const pinned = PRE_CR_ASSERTION_RESIDUE[relPath] ?? 0;
      if (found > pinned) overruns.push({ relPath, found, pinned });
    }
    expect(overruns).toEqual([]);
  });

  test("the tripwire FIRES on a planted literal, and on nothing that is exempt by kind or by name", () => {
    // AC7's own self-test. The fixture holds six planted literals: an
    // asserted string (a leak), a describe title, a provenance comment, a
    // thrown diagnostic, a synthetic namespace, and a bare local assigned
    // outside any assertion. Exactly one is a leak.
    const leaks = assertedLiterals("tests/synthetic-probe.ts", SYNTHETIC_TRIPWIRE_FIXTURE.asserted);
    expect(leaks.map((l) => l.id)).toEqual(SYNTHETIC_TRIPWIRE_FIXTURE.assertedLeaks);
  });

  test("AC7a's four foreign-fixture files are carved out by name, and only for the namespace they hold", () => {
    // The carve-out is not a blanket pass: each file is exempt for
    // `CR-NAI-*` only, so one of our ids appearing there still fails. Proven
    // by planting one, rather than asserting the table's own contents.
    const rel = join("tests", "f13-fidelity.test.ts");
    expect(FOREIGN_FIXTURE_FILES[rel].namespace).toBe(SYNTHETIC_TRIPWIRE_FIXTURE.foreignNamespace);
    expect(
      assertedLiterals(rel, SYNTHETIC_TRIPWIRE_FIXTURE.foreignPlanted).map((l) => l.id),
    ).toEqual(SYNTHETIC_TRIPWIRE_FIXTURE.foreignLeaks);
  });
});
