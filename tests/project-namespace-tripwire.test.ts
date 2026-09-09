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
import {
  balancedEnd,
  extractCitableText,
  joinWrapped,
  jsLiveCode,
  listFiles,
  REPO_ROOT,
  unnestedEnd,
} from "./helpers/source-scan";

// The one pattern, used by all four dimensions (AC2 printed help, AC3
// `public/` strings, AC3a client runtime strings, AC7 test assertions).
// Namespace-agnostic (AC7):
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

// THE OTHER HALF OF THAT KIND, AND THIS ONE IS CODED — the MESSAGE argument
// of an `expect(` call. Ruled 2026-09-07, at CR-CRU-109's merge gate
// (CR-CRU-109 §S3/AC10), when this checker reported that CR's four AC8 cap
// guards and two live-board probes as literals asserted on a real project.
//
// The ROLE is identical to the thrown diagnostic above: bun's API defines
// the second parameter of `expect` as the failure message, so it is the test
// telling a maintainer WHICH CONTRACT IT WAS CHECKING when it broke. It is
// never compared against a product value and never rendered to any project's
// user. What it does NOT share is the CONSTRUCTION — a `throw` sits outside
// every assertion span and so needs no code, while bun puts the identical
// diagnostic INSIDE the span. The exemption therefore follows the role, not
// the syntax carrying it, and this half is written down precisely because it
// cannot be spared by construction.
//
// THE BOUNDARY, narrow on purpose; every clause is planted as a case in the
// AC10 self-tests below rather than asserted here:
//   • the FIRST argument stays reportable — it is the actual value, which is
//     a product value;
//   • `toThrow(` / `toThrowError(` arguments stay reportable — they sit
//     outside `expect`'s own parens, where `balancedEnd` stops. That is the
//     case the block above named as its reason for refusing an exemption
//     keyed on `new Error(`, so it is the case that must keep failing;
//   • a callback beginning inside the call ENDS the span, exactly as it ends
//     a title's;
//   • the span stops at the SECOND top-level comma, so anything past the
//     message — a third argument, if a shape ever permits one — is not a
//     message. The same clause is what makes the trailing comma of the real
//     multi-line shape safe.
// The span is the whole ARGUMENT, not the first string literal in it, for
// the reason `titleSpans` states above: the real messages are concatenated
// chunks and interpolated templates (`"... (CR-CRU-109 §S1) ..." + "..."`,
// `` `... ${capOf()} ...` ``), and stopping at the first closing quote would
// leave the rest of the same message looking like live code.
//
// The walk runs over `jsLiveCode`, whose offsets ARE the raw file's: a comma,
// paren or quote inside a string or a comment is blanked before it is
// counted, so a message reading `", so its "` cannot be mistaken for an
// argument boundary and an `expect(` quoted in a comment opens no span over
// the code beneath it — the same protection `proseMask` gives the assertion
// openers. A `${...}` substitution stays live and balanced, so
// `${JSON.stringify(declared)}` is walked as the code it is. Where the walk
// is unsure it ends the span EARLY and the tripwire OVER-reports, loudly, in
// the file that wrote the message — never a silent hole.
//
// Python has no such parameter (`assert x, "msg"` is a statement whose second
// operand IS the message, but no client test writes one and Python's opener
// is a different branch of `assertionSpans`), so the exemption is scoped to
// the branch it was ruled for.
function expectMessageSpans(relPath: string, text: string): Span[] {
  if (relPath.endsWith(".py")) return [];
  const live = jsLiveCode(text);
  const spans: Span[] = [];
  for (const m of live.matchAll(/\bexpect\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = balancedEnd(live, open);
    const commas: number[] = [];
    let depth = 0;
    for (let i = open; i < close; i++) {
      const c = live[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) commas.push(i);
    }
    if (commas.length === 0) continue;
    const start = commas[0]! + 1;
    const callback = /=>|\bfunction\s*\(/.exec(live.slice(open, close));
    const end = Math.min(commas[1] ?? close - 1, callback === null ? close : open + callback.index);
    if (end > start) spans.push([start, end]);
  }
  return spans;
}

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
  "CR-DT": "roadmap-drill-through fixtures — the rows and plans a landing chooses between",
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
    spans.push([start, unnestedEnd(text, start, ";")]);
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
  const exempt = [
    ...titleSpans(text),
    ...expectMessageSpans(relPath, text),
    ...exemptConstantSpans(relPath, text),
  ];
  return classifyOccurrences(relPath, text)
    .filter((o) => !o.isProse)
    .filter((o) => SYNTHETIC_NAMESPACES[o.id.replace(/-\d+$/, "")] === undefined)
    .filter((o) => foreign === undefined || !o.id.startsWith(`${foreign.namespace}-`))
    .filter((o) => spanContains(assertions, o.index))
    .filter((o) => !spanContains(exempt, o.index))
    .map((o) => ({ relPath, line: o.line, id: o.id }));
}

// AC3's checker, and AC3a's — ONE checker for both shipped trees, because
// the rule is identical: `public/` ships to every project's browser and
// `clients/` ships the prose of every AXI envelope, so ANY occurrence
// outside a comment is a leak, asserted or not, and no synthetic allow-list
// applies — invented ids have no business in shipped text either. A second
// checker for the second tree would be a second place for the rule to drift.
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

// COLLECTED SYNCHRONOUSLY, DELIBERATELY (CR-CRU-110 §S2). After a file has
// driven Chromium through playwright in the same bun process, one child of a
// CONCURRENTLY spawned batch has its stderr pipe torn down without its reader
// promise settling and without the child being reaped, so
// `new Response(proc.stderr).text()` never resolves and this test reached its
// cap whenever the browser suite ran immediately before it — the runner's
// bookkeeping, not this repo's; `Bun.spawnSync` is the shape measured immune.
// The cost is stated, not hidden: ~12s for all 168 surfaces against the
// unchanged 180s cap, where the concurrent path cost ~3.1s. Concurrency was
// never the assertion; a result that does not depend on what ran before it is.
// Pinned to bun 1.3.14 (0d9b296a) — a runner upgrade re-opens the question.
function collectHelpSurfaces(): HelpSurface[] {
  const run = (client: string, args: string[]): { text: string; exitCode: number } => {
    const proc = Bun.spawnSync({
      cmd: ["python3", join(REPO_ROOT, "clients", client), ...args],
      cwd: REPO_ROOT,
      // COLUMNS pins argparse's wrap width so the surface is deterministic
      // across terminals and CI.
      env: { ...process.env, COLUMNS: "200" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { text: `${proc.stdout.toString()}${proc.stderr.toString()}`, exitCode: proc.exitCode };
  };

  const surfaces: HelpSurface[] = [];
  for (const client of CLIENTS) {
    const root = run(client, ["--help"]);
    surfaces.push({ client, verb: "<root>", ...root });
    // The verb list comes from argparse's own choices group in the usage
    // line, so a verb added tomorrow is covered without editing this file.
    // Whitespace is squeezed out because the usage line wraps.
    const choices = /\{([^}]*)\}/.exec(root.text);
    const verbs = (choices?.[1] ?? "")
      .replace(/\s+/g, "")
      .split(",")
      .filter((v) => /^[a-z0-9][a-z0-9-]*$/.test(v));
    for (const verb of verbs) surfaces.push({ client, verb, ...run(client, [verb, "--help"]) });
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
  // The `public/` self-test, now carrying the classifier's HARD cases as
  // well as the easy one. The first two lines are the easy shape (a bare
  // string, the comment on its own line); the last two are a `//` that is
  // NOT a comment — inside a URL and inside a regex literal. Before C4 both
  // read as provenance and were dropped from AC3, AC3a AND AC7, all three of
  // which filter on `!isProse`, so the whole class "any shipped string
  // containing a URL, a path or a regex beside a CR id" was invisible.
  publicSurface: [
    "// CR-QQQ-1 §S2 — provenance for the block below.",
    'const empty = "No BDD results yet — see CR-QQQ-2 for the plan.";',
    'const link = "http://board.example/roadmap/CR-QQQ-9";',
    'const r = /a\\/\\//; const s = "CR-QQQ-6";',
  ].join("\n"),
  publicLeaks: ["CR-QQQ-2", "CR-QQQ-9", "CR-QQQ-6"],
  // The same two hard cases as STANDALONE probes of the lifted classifier
  // itself, not of a checker built on it. They are separate entries because
  // the claim is different: above, "the checker reports the leak"; here,
  // "`extractCitableText` does not call this prose". That second claim is
  // the one tests/docs-retired-mirror-references.test.ts also rests on, so
  // it is pinned on the helper rather than only through this file.
  urlProbe: 'const u = "http://board/CR-QQQ-9";',
  regexProbe: 'const r = /a\\/\\//; const s = "CR-QQQ-6";',
  commentProbe: "// CR-QQQ-1 §S2 — a real line comment stays prose.",
  commentProbeProse: ["CR-QQQ-1"],
  // AC3a's self-test input — a client's RUNTIME warning, in Python: the
  // provenance `#` comment above it is exempt, the `detail` string the user
  // reads in the AXI envelope is not. Python needs its own planted case
  // because the classifier lexes `.py` by a different branch (docstrings and
  // `#` runs) than the `.js`/`.ts` one above.
  clientRuntime: [
    "# CR-QQQ-4 §S2 — the roadmap declares a seq on every entry.",
    "def _missing_seq_warning(crs):",
    '    """CR-QQQ-5 §S1 — the structured warning, docstring exempt."""',
    '    return {"code": "missing-seq",',
    '            "detail": f"no seq for {crs} — CR-QQQ-8 declares one on every entry"}',
  ].join("\n"),
  clientRuntimeLeaks: ["CR-QQQ-8"],
  wrappedHelp: [
    "  --repair-provenance   Rewrite the run's provenance; a mismatch is REFUSED (§S4, CR-",
    "                        QQQ-3 §S2).",
  ].join("\n"),
  wrappedLeaks: ["CR-QQQ-3"],
  neutralHelp: "  --cr CR   CR id, e.g. the id your project uses.",
  foreignPlanted: 'test("x", () => { expect(a).toBe("CR-NAI-203"); expect(b).toBe("CR-ZZZ-8"); });',
  foreignLeaks: ["CR-ZZZ-8"],
  foreignNamespace: "CR-NAI",
  // AC10's self-test inputs (CR-CRU-109 §S3, ruled 2026-09-07) — the message
  // exemption above and each boundary that keeps it narrow, planted as source
  // text and fed to the same pure checker. One DISTINCT id per case, so a
  // regression names the case that broke rather than moving a count; the
  // shapes are the real ones the ruling was made about (a concatenated
  // message with a trailing comma, an interpolated one carrying live
  // substitutions). `CR-ZZZ` names no project and is deliberately NOT in
  // SYNTHETIC_NAMESPACES — listing it would make every case below pass
  // vacuously.
  expectMessageConcatenated: [
    "expect(",
    "  typeof value,",
    '  "the fixture exports no numeric CAP — CR-ZZZ-11 §S1 has no single " +',
    '    "definition for this suite to read (CR-ZZZ-12)",',
    '  ).toBe("number");',
  ].join("\n"),
  expectMessageConcatenatedLeaks: [],
  expectMessageInterpolated:
    "expect(four.length, `no DRAWN row renders ${BARE.length} ids in the capped bare form " +
    "(CR-ZZZ-13) — this board reads ${JSON.stringify(declared)}, so its box is not the case ` +\n" +
    "  `the figure is stated against`).toBeGreaterThan(0);",
  expectMessageInterpolatedLeaks: [],
  expectOrdinaryAssertion: 'expect(row.cr).toBe("CR-ZZZ-14");',
  expectOrdinaryAssertionLeaks: ["CR-ZZZ-14"],
  expectThrownContract: [
    'expect(() => load()).toThrow(new Error("CR-ZZZ-15 is absent from the published order"));',
    'expect(() => load()).toThrowError("CR-ZZZ-16 is absent from the published order");',
  ].join("\n"),
  expectThrownContractLeaks: ["CR-ZZZ-15", "CR-ZZZ-16"],
  expectFirstArgument: 'expect("CR-ZZZ-17", "the actual value is a product value").toBe(cr);',
  expectFirstArgumentLeaks: ["CR-ZZZ-17"],
  expectCallbackInsideCall:
    'expect(() => load("CR-ZZZ-18"), "a callback begins inside — CR-ZZZ-19").toThrow();',
  expectCallbackInsideCallLeaks: ["CR-ZZZ-18", "CR-ZZZ-19"],
  expectThirdArgument: 'expect(v, "the message — CR-ZZZ-20", "past the message — CR-ZZZ-21").toBe(1);',
  expectThirdArgumentLeaks: ["CR-ZZZ-21"],
};

describe("CR-CRU-097 §S2/AC2 — no help string any client PRINTS names a project's CR namespace", () => {
  test(
    "every verb's --help and every client's root help, driven for real, print no CR namespace literal",
    () => {
      const surfaces = collectHelpSurfaces();

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

  test("the public/ checker reports a planted literal in a string, in a URL and beside a regex, and spares the comment above them", () => {
    const leaks = userVisibleLiterals("public/probe.js", SYNTHETIC_TRIPWIRE_FIXTURE.publicSurface);
    expect(leaks.map((l) => l.id)).toEqual(SYNTHETIC_TRIPWIRE_FIXTURE.publicLeaks);
  });
});

// THE CLASSIFIER'S OWN CONTRACT, pinned here because every dimension above
// filters on `!isProse` and therefore inherits it. The lift (§S6) moved
// `extractCitableText` out of tests/docs-retired-mirror-references.test.ts
// unchanged — including a defect: the TS/JS branch found line comments with
// `/\/\/[^\n]*/g` over the RAW file, so it could not tell a comment from a
// `//` inside a string literal or a regex literal. `"http://…/CR-X-1"`
// classified as PROSE, which made a whole class of shipped string — any one
// carrying a URL, a path or a regex beside a CR id — invisible to AC3, AC3a
// and AC7 alike. Nothing was red on the day it was found (`public/` live
// count was 0), and that is exactly why it is pinned: the CR's durability
// claim is that a future leak fails on the day it is WRITTEN, and this class
// would have passed silently.
//
// Stated as a property of the pure function, not of a checker built on it,
// because tests/docs-retired-mirror-references.test.ts rests on the same
// function and reads no CR ids at all.
describe("CR-CRU-097 §S6 — the lifted classifier tells a comment from a `//` inside a string or a regex", () => {
  const proseIds = (relPath: string, text: string): string[] =>
    extractCitableText(relPath, text).match(CR_LITERAL) ?? [];

  test("a CR id inside a URL in a shipped string is NOT prose", () => {
    expect(proseIds("public/probe.js", SYNTHETIC_TRIPWIRE_FIXTURE.urlProbe)).toEqual([]);
  });

  test("a CR id in a string after a regex literal containing `//` is NOT prose", () => {
    expect(proseIds("public/probe.js", SYNTHETIC_TRIPWIRE_FIXTURE.regexProbe)).toEqual([]);
  });

  test("a real line comment is still prose — the fix narrows nothing it should keep", () => {
    expect(proseIds("public/probe.js", SYNTHETIC_TRIPWIRE_FIXTURE.commentProbe)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.commentProbeProse,
    );
  });
});

describe("CR-CRU-097 AC3a — no runtime string a client EMITS names a CR", () => {
  // THE FOURTH LEAKING SURFACE. §S6 required "no CR literal in a
  // user-visible string in public/ OR clients/", but the shipped tripwire
  // reached `clients/` only through AC2 (what --help PRINTS) and `public/`
  // only through AC3 (browser strings). A warning `detail` or an error
  // message assembled at runtime is reached by NEITHER, and two were live:
  // bun-crucible's `run-left-open` named an unshipped CR of OURS to every
  // project, and `_crucible_axi.py`'s `missing-seq` did the same from the
  // SHARED module, so all five clients emitted it. A §S clause with no AC is
  // a wish (CR-CRU-078's lesson); this is that AC.
  //
  // The rule is AC3's, applied to the other shipped tree, so it reuses AC3's
  // checker rather than growing a fourth: any occurrence at a LIVE-CODE
  // position is a leak, because there is no way to tell from the source
  // whether a given string is rendered today, and the envelope is assembled
  // from many of them. Provenance comments and docstrings stay exempt
  // through the same classifier.
  //
  // `.md` is exempt BY KIND, not by pattern: `clients/STATUS-CONTRACT.md`
  // holds 10 references and markdown has no comment syntax, so documentation
  // prose reads as live code to any classifier. The extension list states
  // that exemption; it is not a silent omission.
  // KNOWN BLIND SPOT, narrated because the sibling guard narrates its own
  // analogous one (re-verify, 2026-09-03). `pythonStatementStrings` treats ANY
  // triple-quoted literal whose opening quote is preceded only by whitespace
  // (plus an optional r/b/u/f prefix) as a docstring. So a MULTI-LINE runtime
  // message written as a parenthesised continuation, or as a dict value
  // beginning on its own line, lands in the exempt set:
  //   extractCitableText("clients/probe.py",
  //     'def f():\n    msg = (\n        """user message CR-YYY-1"""\n    )')
  // returns CR-YYY-1 as PROSE, while the same text as an f-string is correctly
  // live. Nothing leaks today and the shape is unused: for all seven
  // clients/*.py this lexer's docstring count equals Python's own
  // `ast.get_docstring` count (8/58/73/80/64/86/128). But AC3a's claim is
  // DURABILITY — a future leak must fail on the day it is written — and a
  // multi-line warning detail written that way would pass silently, which is
  // exactly the class C4 closed on the TS/JS side. Tightening the lexer to
  // require the literal be the first statement of a def/class/module would
  // close it; that is deferred rather than done here because this helper is
  // SHARED with tests/docs-retired-mirror-references.test.ts, whose contract
  // rests on the same function, and a change there is not this cycle's to make.
  test("no CR literal sits at a live-code position in any client", () => {
    const files = listFiles("clients", [".py"]);
    // Non-vacuity: the five clients plus the shared module and the TOON
    // codec. A walker that silently returned nothing would pass otherwise.
    expect(files.length).toBeGreaterThanOrEqual(CLIENTS.length + 2);
    const leaks = files.flatMap((abs) => {
      const relPath = abs.slice(REPO_ROOT.length + 1);
      return userVisibleLiterals(relPath, readFileSync(abs, "utf8"));
    });
    expect(leaks).toEqual([]);
  });

  test("the checker reports a literal in a client's warning detail and spares its comment and docstring", () => {
    const leaks = userVisibleLiterals("clients/probe.py", SYNTHETIC_TRIPWIRE_FIXTURE.clientRuntime);
    expect(leaks.map((l) => l.id)).toEqual(SYNTHETIC_TRIPWIRE_FIXTURE.clientRuntimeLeaks);
  });
});

// AC8 — THE PROVENANCE COUNT, MEASURED WITH THE CLASSIFIER AND PINNED.
//
// AC8 lived only in spec prose until C4: it asserted that design lineage
// survives this CR, and nothing checked it. Worse, its figures were twice
// mis-measured — first as RAW grep totals rather than prose positions, then
// with `/CR-CRU-\d+/` where AC7's own pattern is namespace-agnostic. The
// `clients/` tree is the only one where that second slip is visible, because
// it is the only one carrying a foreign namespace (`CR-NAI-*`/`CR-SAN-*`
// provenance, mostly in rust-crucible.py); `src/` and `public/` reproduce
// identically under either pattern, which is exactly why the mismatch went
// unnoticed on two of three figures.
//
// The quantity is therefore fixed here as: matches of CR_LITERAL — the SAME
// pattern every dimension above uses — in the positions `extractCitableText`
// reports as prose, per tree, excluding `__pycache__` (listFiles does that).
//
// BOTH FIGURES ARE RECORDED because one cannot be both: C3 legitimately ADDS
// provenance comments (§S2 moved five citations out of `help=` strings into
// adjacent `#` comments) and C4 adds four more (the two runtime strings of
// AC3a, whose lineage moved to their comments). Only the HEAD figure is
// ASSERTED. The baseline is stated, not computed, and deliberately so: it
// was obtained by classifying `git ls-tree -r develop` + `git show
// develop:<path>` for each file of each tree (2026-09-03, develop at the
// merge-base of this branch), and asserting it live would rot the moment
// this branch merges — `develop` would then BE this tree and the baseline
// would silently become the HEAD figure, which is the exact class of
// self-satisfying assertion this CR exists to remove.
//
// Under `/CR-CRU-\d+/` instead, for the record: develop `clients/` is 588
// and HEAD is 605. Note the collision that makes this worth spelling out —
// develop's namespace-agnostic `clients/` count is 601, the very number the
// spec once reported as HEAD's `CR-CRU-`-only count. Two different
// measurements of two different trees happened to coincide.
// UPDATED 2026-09-03 by CR-CRU-099, twice. `src/` HEAD moves 512 -> 524 -> 525.
// Cycle 320 wired `release`/`track`/`lifecycle` through `handleQueuePost` and
// taught `replaceQueue`'s defaulting the release axis (+12 citations naming
// CR-CRU-099, CR-CRU-091 and CR-CRU-095); cycle 323 added the §S3 caller gate
// (+1, the `CR-CRU-099 §S3/AC9` doc comment). Every one is prose on a `//` or
// ` *` line, none in a string — verified against the diff, not assumed. The
// `develop` baseline is UNCHANGED at 512 and stays the floor: a tree may gain
// lineage, never shed it. Raising HEAD is the maintenance this table exists to
// require; raising `develop` to match would be the self-satisfying assertion
// the paragraph above forbids.
// UPDATED 2026-09-04 by CR-CRU-102 §S1. `public/` HEAD moves 379 -> 388.
// Cycle 331 replaced the annotation slot's full-id decision with the
// data-derived rule, and the +9 is that reasoning written down where a reader
// of the code will meet it: `public/app.js` +3 (the rewritten zone-2 slot
// comment and zone 3's chip, both naming CR-CRU-102 and the CR-CRU-096 AC13a
// ruling they supersede in EFFECT), `public/app-logic.mjs` +5 (the
// `bareDependencyId` doc comment, which carries the AC13a/AC29 reconciliation
// because that is what explains the rule's shape) and `public/app-logic.d.mts`
// +1 (the declaration's own citation). Every one is prose on a `//` or ` * `
// line, none in a string — verified by measuring `git show develop:<path>`
// against the working tree file by file, not assumed. The `develop` baseline
// is UNCHANGED at 378 and stays the floor.
// UPDATED 2026-09-04 by CR-CRU-103 §S1/§S2. `public/` HEAD moves 388 -> 390.
// C1 gave the delivered card and the spine terminal their own stylesheet
// blocks, and each opens with the citation that explains why the geometry is
// what it is: `public/styles.css` +2 (the `/* CR-CRU-103 §S2/AC4 … .term */`
// and `/* CR-CRU-103 §S1/AC1/AC1a/AC2 … .delivered */` block headers). Both
// are prose on a `/* */` comment line, neither is in a string — measured by
// classifying `git show develop:<path>` against the working tree file by
// file, which attributes the whole +2 to that ONE file and leaves the other
// nine `public/` files at their develop counts. The branch's other new prose
// (the AC7/AC1a reasoning comments in
// `tests/roadmap-visual-grammar.test.ts`) moves NOTHING here: `tests/` is not
// one of the three tracked trees, so it is invisible to this measure by
// construction. `src/` and `clients/` are untouched by this CR and re-measure
// at their recorded 525 and 619. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors.
// UPDATED 2026-09-04 by CR-CRU-104 §S1. `src/` HEAD moves 525 -> 538. C1
// replaced the bulk queue post's ad-hoc membership handling with the ONE gate
// `cr-plan` and `wave-sequence` also reach, and the +13 is that decision
// written where a reader of the code will meet it: `src/v2.ts` +12 (the
// migration-door narration on `handleQueuePost` and the per-entry membership
// and `lifecycle`-shape comments, which cite CR-CRU-091 and CR-CRU-099
// alongside this CR because they name the rules being unified) and
// `src/store.ts` +1 (`TRACK_LANE_RULE`'s own JSDoc, the lane rule as one
// string). Both are prose on `//` or ` * ` lines, neither is in a string —
// measured by classifying `git show develop:<path>` against the working tree
// file by file with this file's own `extractCitableText`, which attributes
// the whole +13 to those TWO files and leaves the other eight `src/` files at
// their develop counts. `public/` and `clients/` are untouched by this CR and
// re-measure at their recorded 390 and 619. The `develop` baselines are
// UNCHANGED at 512/378/601 and stay the floors — a floor never moves, in
// either direction, for a re-pin.
// RE-PINNED 2026-09-04 by CR-CRU-104's VERIFY round. `src/` HEAD moves
// 538 -> 541, all three in `src/v2.ts`: the membership gate now owns the
// SHAPE of a declaration as well as its meaning (the migration door coerced a
// non-string release with `String()` and stored the label the coercion
// produced, which `cr-plan` type-refuses), and the +3 is that decision
// written where a reader of the code will meet it — `MembershipDeclaration`'s
// doc comment, `RELEASE_REQUIRED`'s (the one sentence both doors now answer)
// and the gate's own shape-before-meaning comment. Measured with THIS file's
// `extractCitableText` file by file against `git show develop:<path>`: 7
// citations added and 4 removed on `//`/` * ` lines of that one file, none in
// a string, so `src/v2.ts` moves 175 -> 178 over develop's 163 while the
// other nine `src/` files stay at their develop counts. `public/` and
// `clients/` are untouched and re-measure at 390 and 619. The `develop`
// baselines are UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-04 by CR-CRU-106 §S1/§S2/§S2a. `src/` HEAD moves 541 -> 549
// and `clients/` 619 -> 627. C1 gave the DEPENDENCY axis its own verb, and the
// citations are the reasoning written where a reader of the code will meet it:
// `src/v2.ts` +7 (`handleCrDepends`'s doc comment, the corrected
// `refuseDependencyCycle` precondition, both cycle callers' comments, the
// prospective-graph note, the route and `V2Body`'s new field), `src/store.ts`
// +1 (`declareQueueDependencies`' JSDoc — the second writer of
// `depends_on_json`), `clients/_crucible_axi.py` +5 (the `cr-depends` section
// header, its path helper, the ask, the state-derived help and its registrar)
// and `clients/python-crucible.py` +3 (the delegator and its registrar call).
// Measured with THIS file's `extractCitableText` file by file against
// `git show develop:<path>`, which attributes the whole +16 to those FOUR
// files and leaves every other file of both trees at its develop count; every
// citation is prose on a `//`, ` * ` or docstring line, none in a string.
// `public/` is untouched by this CR and re-measures at 390. The `develop`
// baselines are UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-04 by CR-CRU-106 §S2b + fleet parity (C2). `src/` HEAD moves
// 549 -> 550 and `clients/` 627 -> 639. `src/hints.ts` +1: the cycle remedy's
// doc comment, which now says why the hint stopped naming the migration door.
// `clients/` +12 is the same +3 C1 gave `python-crucible.py`, landed in each
// of the other four (`arduino-` 84 -> 87, `bun-` 119 -> 122, `mvn-` 107 ->
// 110, `rust-` 100 -> 103): the `cr-depends` delegator's docstring and the
// registrar call's comment, which names the frozen five it stays out of.
// Measured with THIS file's `extractCitableText` file by file against
// `git show HEAD:<path>`; `src/v2.ts`, `python-crucible.py` and
// `_crucible_axi.py` re-measure at their C1 counts (the AC9 comment in
// `handleCrDepends` cites AC9/§S7 by section, not by CR literal). Every
// citation is prose on a `//`, ` * `, `#` or docstring line, none in a
// string. `public/` is untouched and re-measures at 390. The `develop`
// baselines are UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-05 by CR-CRU-079 §S1 (C1). `public/` HEAD moves 390 -> 400,
// all of it `public/app.js` +10 (196 -> 206): the Roadmap tab became the one
// ROUTED workspace tab, and the reasoning is written where the code is met —
// `navigate()`'s ONE RULE comment now names its carved exception (CR-CRU-079,
// CR-CRU-021), the `roadmapTabFollows`/`selectWorkspaceTab` helpers open
// with their citations, the tab strip, the 🗺 chip (CR-CRU-014 superseded
// by CR-CRU-079), the row drill comment (CR-CRU-078 §S7 wording superseded)
// and `roadmapDrillIn` each name the CR that changed them. Every one is
// prose on a `//` line, none in a string — measured by classifying `git show
// HEAD:<path>` against the working tree file by file with this file's own
// `extractCitableText`; `public/app-logic.mjs` re-measures at 79 and the
// other eight `public/` files are untouched. `src/` and `clients/` are
// untouched and re-measure at 550 and 639. The `develop` baselines are
// UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-05 by CR-CRU-079 §S2 (C2). `public/` HEAD moves 400 -> 405,
// all of it `public/app.js` +5 (206 -> 211): the row drill-through now
// carries its CR as hoisted addressed state and the Workflow pane lands on
// it, and each piece of that plumbing names the CR where the code is met —
// the `roadmapDrillTargets` holder comment (which also cites CR-CRU-020
// §S1.3 for why an open plan lands on its active root), `revealDrillTarget`,
// `crRootProps`, the `LensCrGroup` mark and `WorkflowBackToRoadmap`, less
// the §S1 pointer the rewritten holder comment absorbed. Every one is prose
// on a `//` line, none in a string (the `← roadmap` chip text carries no
// id) — measured by classifying `git show HEAD:<path>` against the working
// tree file by file with this file's own `extractCitableText`; the other
// nine `public/` files are untouched. `src/` and `clients/` are untouched
// and re-measure at 550 and 639. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors.
// UPDATED 2026-09-06 by CR-CRU-085 §S1/§S2/§S3. `public/` HEAD moves 405 ->
// 423 (+18), all of it the laned wave box's own lineage in the four files
// the CR touched, written where a reader of the code will meet it:
// `public/app.js` +7 (211 -> 218) — the header's THIRD segment (§S1/AC8),
// the `div.lanes` grid (§S2/AC1/AC5), the implicit-solo-lane body (§S3/AC9)
// and the two AC2/AC6 notes stating that an UNLANED body is exactly the flat
// list CR-CRU-078/CR-CRU-096 already draw (one of those lines names BOTH,
// which is why six added lines are seven occurrences); `public/app-logic.mjs`
// +5 (79 -> 84) — `focusedReleaseView`'s lane partition (§S2/AC1/AC4/AC7,
// citing CR-CRU-091 §S2's declared `track` wire field, and stating that
// CR-CRU-096's cap and roll-up are untouched) and its `soloRows` remainder
// (§S3/AC9, CR-CRU-078's flat list); `public/app-logic.d.mts` +4 (48 -> 52)
// — the JSDoc on the box's `lanes`, on `soloRows` and on the
// `FocusedReleaseWaveLane` shape itself; `public/styles.css` +2 (67 -> 69) —
// the `.lanes` grid block (§S2/AC5) and the lane's ROW CELL, which keeps
// CR-CRU-096 AC8's ONE CR PER FULL-WIDTH ROW ontology rather than restating
// it. Every one is prose on a `//`, `/* ` or ` * ` line, none in a string
// (the lane label renders a track id, which carries no CR literal); the
// other six `public/` files — the five vendor bundles and `index.html` —
// are untouched at 0.
// Measured by classifying `git show 1f5498c:<path>` — the BRANCH CUT, not
// `HEAD`, because this CR is already committed on the branch and the working
// tree equals `HEAD` — against the working tree file by file with this
// file's own `extractCitableText`. The +18 decomposes exactly into the four
// per-file deltas above (7 + 5 + 4 + 2) and every other `public/` file
// re-measures at its branch-cut count. `src/` and `clients/` are untouched
// and re-measure at 550 and 639. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors.
// UPDATED 2026-09-06 by CR-CRU-093 §S2/§S3/§S4. `public/` HEAD moves 423 ->
// 431 (+8), all of it the collapsible rail's own lineage in the two files
// the CR touched, written where a reader of the code will meet it:
// `public/app.js` +5 (218 -> 223) — the §S3 note on the collapsed flag being
// keyed OUTSIDE the render tree (holder, rev, predicate, toggle), which also
// names CR-CRU-077 as the bug a mount-local flag reproduces when the shell
// re-renders on every SSE frame — that one line is why FOUR added
// `CR-CRU-093` occurrences are five (CR-CRU-077 goes 2 -> 3); the §S4/AC5
// persistence note, stating that the preference is read in `main`'s body
// BEFORE the first render so no expanded flash paints, with AC6's closed-set
// guard; the §S2/AC9 note that the collapsed modifier composes INTO
// `greyed()`'s reactive closure rather than replacing it; and the §S2 note
// that the pane title now heads a ROW carrying the collapse control.
// `public/styles.css` +3 (69 -> 72) — the three §S2 blocks the CR added: the
// `.app-pane-head` header row that puts the control ON the pane, the
// §S2/AC1 collapsed GRID COLUMN narrowing to the 34px sliver (carrying
// design §14.1's measured 1.351× gain against AC1's 1.30× floor), and the
// title's stand-down, stated beside and after the rule it modifies. Every
// one is prose on a `//` or `/* ` line, none in a string (the sliver renders
// `Project · Vitals` and the toggle an `aria-label`, neither carrying a CR
// literal); `public/app-logic.mjs` and `public/app-logic.d.mts` re-measure
// UNCHANGED at 84 and 52, and the other six `public/` files — the five
// vendor bundles and `index.html` — are untouched at 0.
// Measured by classifying `git show 6932ea1:<path>` — the BRANCH CUT
// (develop's head, merged in at c0d52bf), not `HEAD`, because this CR is
// already committed on the branch and the working tree equals `HEAD`, and
// NOT `1f5498c`, which is CR-CRU-085's cut and predates that CR's own +18 —
// against the working tree file by file with this file's own
// `extractCitableText`. The +8 decomposes exactly into the two per-file
// deltas above (5 + 3), every other `public/` file re-measures at its
// branch-cut count, and the branch cut itself re-measures at the recorded
// 423. `src/` and `clients/` are untouched and re-measure at 550 and 639.
// The `develop` baselines are UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-07 by CR-CRU-109 §S1/AC10. `public/` HEAD moves 431 -> 435
// (+4), which is the whole of this CR's production diff's prose: the display
// cap got a name, and each of the four places that name is met carries the
// reason it exists — `public/app-logic.mjs` +1 (84 -> 85, the
// `DEPENDENCY_ANNOTATION_CAP` block comment stating what a row STATES before
// it counts the rest), `public/app-logic.d.mts` +1 (52 -> 53, the
// declaration's own citation) and `public/app.js` +2 (223 -> 225, the
// annotation builder's cap comment and the note that the cap bounds the TEXT
// and nothing else, so `deps` still carries every declared id — CR-CRU-102
// AC3's rule, unmoved). Every one is prose on a `//` or ` * ` line, none in a
// string (the rendered remainder is a `+N` token carrying no CR literal) —
// measured with THIS file's own `extractCitableText` over the working tree,
// which attributes the whole +4 to those THREE files and leaves
// `public/styles.css` at 72 and the other six `public/` files at 0;
// `git diff develop..HEAD -- public/` shows those same four added citation
// lines and no removed one. `src/` and `clients/` are untouched by this CR
// and re-measure at 550 and 639.
// GROWTH IS THE DIRECTION THE RULE PERMITS — "never below its develop
// baseline" is the standing half of the claim and only the equality pin is
// re-recorded, exactly as CR-CRU-093 re-recorded 405 -> 431. The `develop`
// baselines are UNCHANGED at 512/378/601 and stay the floors.
// UPDATED 2026-09-07 by CR-CRU-094 §S1. `src/` HEAD moves 550 -> 556 (+6),
// all of it the cycle binding's own lineage in the three files the CR
// touched, written where a reader of the code will meet it: `src/store.ts`
// +4 (243 -> 247) — the `EventRow.cycle_id` field (stating that the column is
// DERIVED at insert and NULL on every pre-094 row), the appended migration
// body's `apply` (why an ALTER and not a rebuild, and why history is left
// NULL), the `createBaseTables` DDL line (so a fresh store and the end of the
// chain agree and the retrofit never runs) and `insertEvent`'s note that the
// column is derived at the ONE row-insert seam from the context the ONE
// ingest seam stamped, plus `toEvent`'s note that the projection is served
// from the COLUMN rather than re-derived from the blob — those last two are
// two lines and two occurrences, and the body's `description:` string
// (`CR-094`) and the DDL's own `--` line inside the template literal are NOT
// among them, the first because CR_LITERAL requires two-or-more capitals in
// the project segment and the second because a template literal is a string;
// `src/types.ts` +1 (49 -> 50) — `RunEvent.cycleId`'s JSDoc, stating the key
// is ABSENT rather than null when a run carries no cycle; `src/v2.ts` +1
// (185 -> 186) — `eventBrief`'s note that the top-level key sits BESIDE an
// untouched `context`, which §S1 keeps authoritative for the frontend.
// Measured by classifying `git show 97deaa8:<path>` — the RED commit this
// CR's implementation builds on, not `HEAD`, because the implementation is
// already committed and the working tree equals `HEAD` — against the working
// tree file by file with this file's own `extractCitableText`; the +6
// decomposes exactly into the three per-file deltas above (4 + 1 + 1) and
// every other `src/` file re-measures unchanged. `public/` and `clients/` are
// untouched by this CR and re-measure at 435 and 639.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin is
// re-recorded, exactly as CR-CRU-093 re-recorded 405 -> 431 and CR-CRU-109
// 431 -> 435 for `public/`. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors.
// UPDATED 2026-09-07 by CR-CRU-094 §S2/§S3. TWO heads move: `src/` 556 -> 560
// (+4) and `clients/` 639 -> 642 (+3). Seven citation lines, one per new
// comment block, each written where a reader of the code will meet the fact
// it explains. `src/store.ts` +2 (247 -> 249) — `recordLifecycleEvent`'s note
// that the cycle is carried TOP-LEVEL and never as a `context`, because a
// cycle's RUNS are selected through `context.cycleId`, and `insertEvent`'s
// note that the lifecycle record is the second source the one row-insert seam
// derives the column from, the run-bearing constructors still stamping
// `context` alone; `src/v2.ts` +2 (186 -> 188) — the register route's note
// that the binding validated one statement earlier is what the registration
// event records, and the unregister route's note that the binding joins
// firstSeen/role in the SAME pre-deletion snapshot. `clients/` is the §S3
// half: `clients/_crucible_axi.py` +1 (120 -> 121) — the pre-flight section
// header, stating that the binding is READ from the board and never inferred
// from a missing local `--cycle`; `clients/bun-crucible.py` +2 (122 -> 124) —
// the `cmd_test` and `cmd_regression` call sites, each stating that the check
// runs while `--cycle` can still be supplied and is best-effort. Measured by
// classifying `git show c5e9f27:<path>` — the RED commit this cycle's
// implementation builds on — against the working tree file by file with this
// file's own `extractCitableText`; the +4 and the +3 decompose exactly into
// the per-file deltas above (2 + 2 and 1 + 2) and every other `src/` and
// `clients/` file re-measures unchanged. `public/` is untouched by this cycle
// and re-measures at 435 — §S2 touches no rendering and §S3 no frontend.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pins are
// re-recorded, as CR-CRU-093 re-recorded 405 -> 431, CR-CRU-109 431 -> 435
// and CR-CRU-094 §S1 550 -> 556. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors.
// UPDATED 2026-09-07 by CR-CRU-094 §S3's fleet roll-out. `clients/` HEAD moves
// 642 -> 672 (+30). §S3 landed as a pin on ONE client and one pair of call
// sites; the roll-out gave the pre-flight to all five clients and to every
// ingesting verb, and the +30 is one CR literal per added prose line — 30
// lines added, NONE removed, so the net delta and the added-line count are the
// same number, which is the cheapest form this table's arithmetic ever takes.
// Per client: `clients/bun-crucible.py` +4 (124 -> 128), `python-crucible.py`
// +7 (96 -> 103), `mvn-crucible.py` +7 (110 -> 117), `rust-crucible.py` +6
// (103 -> 109) and `arduino-crucible.py` +6 (87 -> 93). Every one is a `#`
// seam comment stating why the pre-flight sits at THAT call site (before the
// runner spawns, while `--cycle` can still be supplied, and in the
// envelope-owning caller rather than the shared helper) or a docstring line
// documenting the new `warnings` / `preflight_warnings` parameter that carries
// the finding into the envelope; none is in a string. 27 of the 30 name
// CR-CRU-094 §S3 and the other 3 name CR-CRU-058 §S1 from INSIDE those same
// §S3 blocks — the emit-free step-form rule is what fixes where the seam may
// go, so the comment that explains the placement has to cite it.
// `clients/_crucible_axi.py` re-measures UNCHANGED at 121 even though the
// commit touches it: its whole diff is a line-number re-pin inside an existing
// docstring, which moves no citation. `clients/toon.py` stays at 1.
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show 663a1c5:<path>` — the commit before the roll-out, not
// `develop`, because the 642 being replaced is this CR's own §S2/§S3 figure —
// file by file; the +30 decomposes exactly into the five per-client deltas
// above (4 + 7 + 7 + 6 + 6) and 663a1c5 itself re-measures at the recorded
// 642. `src/` and `public/` are untouched by the roll-out and re-measure at
// 560 and 435.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin is
// re-recorded, as CR-CRU-093 re-recorded 405 -> 431 and CR-CRU-109 431 -> 435
// for `public/`, and as this CR itself re-recorded `src/` 550 -> 556 and
// 556 -> 560 and `clients/` 639 -> 642. The `develop` baselines are UNCHANGED
// at 512/378/601 and stay the floors — a floor never moves for a re-pin.
// UPDATED 2026-09-07 by CR-CRU-075 §S1. `clients/` HEAD moves 672 -> 687
// (+15). §S1 gave `queue-file` the shared registrar every other fleet-wide
// verb has had since CR-CRU-091, and each added citation line is a seam
// comment saying where the verb is registered from now. 15 lines added, NONE
// removed, so the net delta and the added-line count are again the same
// number. Per file: `clients/_crucible_axi.py` +4 (121 -> 125) — the
// `add_queue_file_verb` docstring's own opening line, its note that
// CR-CRU-014 §S2 put the parse and the full-replace POST in this module and
// left the SUBPARSER per-client (the defect §S1 closes), and two §S1/AC2
// lines on the failure paths, one stating that an `ok:false` envelope still
// carries `help[]` and one that the parse names the offending CR in `error`;
// `arduino-crucible.py`, `bun-crucible.py`, `mvn-crucible.py` and
// `rust-crucible.py` +2 each (93 -> 95, 128 -> 130, 117 -> 119, 109 -> 111) —
// one module-level `one thin delegator` section header and one `main()`
// call-site comment apiece; `python-crucible.py` +3 (103 -> 106) — the one
// client that already had a `cmd_queue_file`, so it gains no delegator header
// and instead carries a three-line call-site comment recording that the
// subparser it hand-rolled from CR-CRU-014 §S2 is exactly what let one verb
// work on one stack and be `invalid choice` on the other four.
// `clients/toon.py` stays at 1. Every one is a `#` comment or a docstring
// line, none in a string. §S2 is TESTS ONLY and moves no count in any of the
// three trees.
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show d425048:<path>` — the commit before §S1, not `develop`,
// because the 672 being replaced is CR-CRU-094 §S3's roll-out figure — file
// by file; the +15 decomposes exactly into the six per-file deltas above
// (4 + 2 + 2 + 2 + 3 + 2), and d425048 itself re-measures at the recorded
// 672. `src/` and `public/` are untouched by this CR and re-measure at 560
// and 435.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin is
// re-recorded, as CR-CRU-093 re-recorded 405 -> 431, CR-CRU-109 431 -> 435
// for `public/`, and CR-CRU-094 `src/` 550 -> 556 and 556 -> 560 and
// `clients/` 639 -> 642. The `develop` baselines are UNCHANGED at
// 512/378/601 and stay the floors — a floor never moves for a re-pin.
// UPDATED 2026-09-07 by CR-CRU-107 §S1/§S2. `clients/` HEAD moves 687 -> 691
// (+4). §S1 put the ONE rule that resolves a plan's cycle labels in the shared
// module and §S2 gave `plan-file` its second hard stop, and each added
// citation line records which clause a seam belongs to. 4 lines added, NONE
// removed, so the net delta and the added-line count are again the same
// number. The whole +4 lands in ONE file: `clients/_crucible_axi.py` +4
// (125 -> 129) — the `§S2` section header for the cycle-selection hard stop,
// the line in its converter docstring naming the unresolvable cycle list, the
// `plan_file_cycle_labels` docstring's own opening line, and the call-site
// comment in `cmd_plan_file` recording that the list comes from exactly one
// flag and that the refusal stays BEFORE the POST. Every one is a `#` comment
// or a docstring line, none in a string. The other six `clients/` files
// re-measure UNCHANGED (`arduino` 95, `bun` 130, `mvn` 119, `python` 106,
// `rust` 111, `toon` 1): §S1's per-client work is the argparse DECLARATION,
// which carries no citation, and this cycle's own §S2 close-out (the empty
// `--cycle` refusal and the `<c1>`/`<c2>` template) cites its clauses without
// naming the CR, so it moves no count either — measured, not assumed.
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show 474db5d:<path>` — this CR's branch point, not `develop`,
// because the 687 being replaced is CR-CRU-075 §S1's figure — file by file;
// the +4 is exactly the four `CR-CRU-107` prose lines the branch added to
// `_crucible_axi.py`, and 474db5d itself re-measures at the recorded 687.
// `src/` and `public/` are untouched by this CR and re-measure at 560 and 435.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin is
// re-recorded, as CR-CRU-093 re-recorded 405 -> 431 and CR-CRU-109 431 -> 435
// for `public/`, CR-CRU-094 `src/` 550 -> 556 and 556 -> 560 and `clients/`
// 639 -> 642, and CR-CRU-075 `clients/` 672 -> 687. The `develop` baselines
// are UNCHANGED at 512/378/601 and stay the floors — a floor never moves for
// a re-pin.
// UPDATED 2026-09-07 by CR-CRU-108 §S1/§S2. `src/` HEAD moves 560 -> 563 and
// `clients/` 691 -> 694, +3 each. The whole +6 lands in three files, all of
// them files this CR's own §S1/§S2 edited, and every added line is a
// `/** */` docblock line or a `#` docstring line — none is a string literal,
// so the prose-only classifier and a raw literal count agree on all six.
//
// `src/` 560 -> 563. `src/store.ts` +2 (255 -> 257): `declaredTracks`'
// docblock opens `CR-CRU-108 §S1/AC1 — the DECLARED tracks over a set of queue
// entries`, and its closing sentence names `the divergence CR-CRU-108
// removes`. `src/v2.ts` +1 (188 -> 189): `handleQueueGet`'s comment recording
// that `CR-CRU-108 §S1/AC1 — the reply also STATES the project's declared
// tracks`. No other `src/` file moves: §S1 added ONE call site and changed no
// other prose.
//
// `clients/` 691 -> 694. All three in `clients/_crucible_axi.py` (129 -> 132):
// `QueueTrackFactUnpublished`'s docstring (`CR-CRU-108 §S2 — raised when a
// queue READ states no track fact`), `queue_tracks`' docstring recording that
// the deleted set-comprehension was `a second copy of the rule CR-CRU-108
// deleted`, and `resolve_next`'s parameter docstring stating that `tracks` is
// the list the queue read PUBLISHED. The other six `clients/` files
// re-measure UNCHANGED — §S2 is a change to the SHARED module only, and the
// five `*-crucible.py` clients each carry nothing but a thin `cmd_next`
// delegator that this CR never touched (verified: one caller repo-wide).
//
// `public/` is UNCHANGED at 435: §S3 pinned the browser's predicate from the
// test side and edited no shipped browser prose.
//
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show develop:<path>`, file by file, at the END of the cycle —
// after the FIX commits, so the figure is final rather than re-recorded twice.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin moves, as
// CR-CRU-093 re-recorded `public/` 405 -> 431, CR-CRU-109 431 -> 435,
// CR-CRU-094 `src/` 550 -> 556 and 556 -> 560, and CR-CRU-075 `clients/`
// 672 -> 687 (then CR-CRU-107 687 -> 691). The `develop` baselines are
// UNCHANGED at 512/378/601 and stay the floors — a floor never moves for a
// re-pin.
// UPDATED 2026-09-08 by CR-CRU-111 §S6/AC9 — the ONE deliberate re-record
// this CR planned for at gap analysis. `clients/` HEAD moves 694 -> 747,
// +53, and `src/` and `public/` do not move at all: this CR edits nothing
// under `src/` or `public/`, and both re-measure at the recorded 563 and 435.
//
// The re-pin is ONE cycle of its own, and that is the whole reason it exists
// as a cycle: this CR adds provenance prose to all five `*-crucible.py`
// clients AND to the shared `_crucible_axi.py`, so the equality pin
// necessarily moved in every one of the five implementation cycles
// (377-381). Re-recording it once at the END, after those cycles are
// committed, costs one approval instead of five.
//
// `clients/` 694 -> 747. The +53 decomposes exactly into six per-file deltas,
// with the seventh file flat:
//   `clients/rust-crucible.py`     111 -> 122  (+11)
//   `clients/python-crucible.py`   106 -> 116  (+10)
//   `clients/mvn-crucible.py`      119 -> 129  (+10)
//   `clients/_crucible_axi.py`     132 -> 140   (+8)
//   `clients/bun-crucible.py`      130 -> 137   (+7)
//   `clients/arduino-crucible.py`   95 -> 102   (+7)
//   `clients/toon.py`                1 ->   1   (+0)
// That shape is the one the CR predicted: the five clients each gain the
// prose of the tier VERBS §S1 added plus the modality and envelope-tier prose
// of §S3-§S5, and the shared module gains the tier registrar's own.
// `clients/toon.py` is a pure serializer this CR never touched.
//
// Every one of the +53 is PROSE, and that is measured rather than asserted:
// AC3a's checker ("no CR literal sits at a live-code position in any client")
// passes over the same working tree in the same run, so no added citation
// sits in a string literal — each is a `#` comment or a docstring line.
//
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show develop:<path>`, file by file, at the END of the CR —
// after all five implementation cycles are committed, so the figure is final
// rather than re-recorded twice.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin moves, as
// CR-CRU-094 re-recorded `src/` 550 -> 556 and 556 -> 560, CR-CRU-075
// `clients/` 672 -> 687 and CR-CRU-107 687 -> 691. The `develop` baselines
// are UNCHANGED at 512/378/601 and stay the floors — a floor never moves for
// a re-pin, least of all for the largest re-pin the table has recorded.
// UPDATED 2026-09-09 by CR-CRU-112 §S1/§S2 — the ONE re-record this CR needs.
// `clients/` HEAD moves 747 -> 785, +38, and `src/` and `public/` do not move
// at all: this CR edits nothing under either tree, and both re-measure at the
// recorded 563 and 435.
//
// The +38 decomposes exactly into six per-file deltas, with the seventh file
// flat:
//   `clients/_crucible_axi.py`     140 -> 151  (+11)
//   `clients/bun-crucible.py`      137 -> 144   (+7)
//   `clients/python-crucible.py`   116 -> 122   (+6)
//   `clients/mvn-crucible.py`      129 -> 135   (+6)
//   `clients/arduino-crucible.py`  102 -> 106   (+4)
//   `clients/rust-crucible.py`     122 -> 126   (+4)
//   `clients/toon.py`                1 ->   1   (+0)
// That shape is the one the CR predicted: the gate's composition, its suite
// vocabulary and its warning codes are declared ONCE in the shared module,
// which is why it carries the largest delta, and each of the five clients
// gains the prose of its own enumeration and dispatch hooks plus the
// additive-gate scope §S1/§S2 wires into it. `clients/toon.py` is a pure
// serializer this CR never touched.
//
// A re-pin is not a licence to EMIT, and the two halves are measured in the
// SAME run: AC3a's checker ("no CR literal sits at a live-code position in any
// client") passes over this very working tree, so every one of the 38 is a `#`
// comment or a docstring line. The gate's `e2e` exclusion reason — a string
// this CR added and the gate EMITS into `suites[].excluded` — names the DN's
// open question and no CR id for exactly that reason.
//
// Measured with THIS file's own `extractCitableText` over the working tree
// against `git show develop:<path>`, file by file, at the END of the cycle —
// after the FIX commits, so the figure is final rather than re-recorded twice.
// GROWTH IS THE DIRECTION THE RULE PERMITS — only the equality pin moves, as
// CR-CRU-094 re-recorded `src/` 550 -> 556 and 556 -> 560, CR-CRU-075
// `clients/` 672 -> 687, CR-CRU-107 687 -> 691 and CR-CRU-111 694 -> 747. The
// `develop` baselines are UNCHANGED at 512/378/601 and stay the floors — a
// floor never moves for a re-pin.
// UPDATED 2026-09-09 by CR-CRU-116 — the CR's own close-out step, planned
// rather than escalated, landing in the same commit as its last prose change
// because the cycle after this one is VERIFY and read-only. TWO trees move and
// they move for DIFFERENT cycles of the one CR; `clients/` does not move at all
// and re-measures at the recorded 785.
//
// `src/` HEAD moves 563 -> 573, +10 — §S1/§S2/§S3's wave-scope guard (cycle
// 393). The three files the sections were scoped to, and no others:
//   `src/store.ts`            251 -> 259  (+8)   the guard and its refusals
//   `src/v2.ts`               189 -> 190  (+1)   the plans-POST wiring
//   `src/hints.ts`             39 ->  40  (+1)   the help line
//
// `public/` HEAD moves 435 -> 436, +1 — §S4's per-wave `active` (cycle 394):
//   `public/app-logic.mjs`     85 ->  86  (+1)
//   `public/app.js`           225 -> 225  (+0)
//   `public/app-logic.d.mts`   53 ->  53  (+0)
// That +1 is the SUPERSESSION itself. `focusedReleaseView`'s retired comment
// (`const active = kind === "proposed"`) cited CR-CRU-096 once; its replacement
// cites CR-CRU-116 §S4 AND names the CR-CRU-096 AC1 reading it retires, so one
// citation becomes two — the pin measures provenance, and provenance growing at
// a direction change is the rule working. The renderer's `data-active` comment
// and the `FocusedReleaseWave.active` JSDoc each SWAPPED CR-CRU-096 for
// CR-CRU-116, which is why both files are flat. Every one of the six is prose
// on a `//` or ` * ` line, none in a string.
//
// RECORDED BECAUSE IT COST SOMETHING: the `src/` half of this re-record was
// due at the end of cycle 393 and was missed, because that cycle was verified
// by running the two suites it edited and not this guard — which is a THIRD
// file, and the only one that measures a tree rather than a behaviour. A cycle
// that adds prose to a guarded tree runs this file before it is called done.
// UPDATED 2026-09-09 by CR-CRU-116's FIX round (cycle 396), which CORRECTS the
// note above: `clients/` does move after all. VERIFY found the plans route's
// refusal arriving at an orchestrator stripped of the two fields that make it
// actionable — the client emitted only `cr` on a failed `plan-file`, so §S3's
// `help[]` and the `already-active` / `out-of-order` `code` survived in the
// legacy stderr line alone, which is the one channel a machine caller does not
// read. Fixing that is a prose change in a guarded tree, so it re-records here
// in its own commit rather than leaving the head stale for a second time.
//
// `clients/` HEAD moves 785 -> 789, +4, all of it `_crucible_axi.py`
// (151 -> 155) and nothing in the five stack clients, which delegate:
//   `server_failure_body`   +2   the ONE parse of the server's refusal, and
//                                the §S9 division that says why the client
//                                lifts the fields rather than deriving them
//   `server_failure_code`   +1   why a transport failure gets no invented code
//   `cmd_plan_file`         +1   the failure branch that now forwards both
// All four are prose on a `#` or docstring line, none in a string. `src/` and
// `public/` are untouched by this commit and re-measure at 573 and 436. The
// `develop` baselines are UNCHANGED at 512/378/601 and stay the floors.
const PROSE_CITATIONS: Record<string, { exts: string[]; develop: number; head: number }> = {
  src: { exts: [".ts", ".mts", ".js", ".mjs"], develop: 512, head: 573 },
  public: { exts: [".js", ".mjs", ".mts", ".css", ".html"], develop: 378, head: 436 },
  clients: { exts: [".py"], develop: 601, head: 789 },
};

describe("CR-CRU-097 AC8 — provenance is intact, measured with the classifier that defines it", () => {
  test("each tree's prose citation count is the recorded HEAD figure, and never below its develop baseline", () => {
    const measured: Record<string, number> = {};
    for (const [tree, entry] of Object.entries(PROSE_CITATIONS)) {
      const files = listFiles(tree, entry.exts);
      // Non-vacuity: `clients/` is the smallest of the three at 7 files. A
      // walker that silently returned nothing would otherwise report 0 and
      // fail loudly only by luck.
      expect(files.length).toBeGreaterThanOrEqual(7);
      measured[tree] = files.reduce((total, abs) => {
        const relPath = abs.slice(REPO_ROOT.length + 1);
        const prose = extractCitableText(relPath, readFileSync(abs, "utf8"));
        return total + (prose.match(CR_LITERAL) ?? []).length;
      }, 0);
    }

    expect(measured).toEqual({
      src: PROSE_CITATIONS.src.head,
      public: PROSE_CITATIONS.public.head,
      clients: PROSE_CITATIONS.clients.head,
    });

    // "Provenance is INTACT" is the directional half of the claim, and it is
    // about the measurement, not about the table: a tree may gain lineage,
    // never shed it.
    for (const [tree, entry] of Object.entries(PROSE_CITATIONS)) {
      expect(measured[tree]).toBeGreaterThanOrEqual(entry.develop);
    }
  });
});

describe("CR-CRU-097 AC7/AC7a — no test asserts on a project CR literal outside a named, dated snapshot", () => {
  test("the three files §S5 rewrote assert on nothing but synthetic ids", () => {
    // §S3's board replicas, BY NAME — the rule assertions now run on
    // synthetic rows and the one reproduction lives in the dated constant.
    //
    // CORRECTED in C4. This list previously named
    // `queue-defaulted-seq-scope.test.ts`, which this CR never touched and
    // which appears in no §S clause, and OMITTED
    // `queue-registration.test.ts` — §S5's LARGEST conversion (80 real refs
    // down to 16). RE-CORRECTED after re-verify: this comment first said "13",
    // a figure carried verbatim from C2's commit message that no measure of
    // the file yields. `git show develop:tests/queue-registration.test.ts`
    // holds 80 matches of /CR-[A-Z]{2,}-\d+/; C2's own commit and HEAD both
    // hold 16 (7 distinct ids over 16 lines, 2 at non-prose positions). A
    // comment written to correct one untrue claim had shipped with its own —
    // the stated-and-unreproducible figure AC8 exists to eliminate.
    // The consequence was that the biggest rewrite was pinned
    // only by the residue-ceiling test below, which is strictly weaker: an
    // entry added to PRE_CR_ASSERTION_RESIDUE would legally re-admit real
    // board ids into its assertions, which is precisely what the by-name pin
    // exists to forbid.
    //
    // `queue-defaulted-seq-scope.test.ts` needs no pin of its own and gets
    // none: it is absent from PRE_CR_ASSERTION_RESIDUE, and an absent file
    // must be at ZERO by that test's own rule, so it is already covered by
    // the stronger half of the ceiling. Inventing a second assertion for an
    // untouched file would add no guarantee.
    for (const rel of [
      join("tests", "queue-canonical-order.test.ts"),
      join("tests", "queue-default-into-wave-block.test.ts"),
      join("tests", "queue-registration.test.ts"),
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

// AC10's PROOF, on this file's own planted fixture rather than on the four
// suites the ruling was made about: a checker that stopped reporting them
// because it stopped reporting anything would look identical from those
// files. Each case is its own test naming its own reason, and each carries
// its own planted id, so a leak is identifiable rather than a count.
//
// The FOURTH case AC10 lists — a `describe`/`test` title carrying a
// real-shaped id stays exempt — is already proven and is NOT duplicated
// here: `"the tripwire FIRES on a planted literal, and on nothing that is
// exempt by kind or by name"` (this file, in the AC7/AC7a describe above)
// runs the checker over a fixture whose FIRST line is
// `describe("CR-ZZZ-1 — ...")` and asserts the leak set is exactly
// `["CR-ZZZ-3"]`. Title handling is untouched by this CR, and a second test
// of it would pin the same fixture twice.
describe("CR-CRU-109 §S3/AC10 — an expect() message is a diagnostic, and the boundary that keeps it narrow", () => {
  const planted = (source: string): string[] =>
    assertedLiterals(join("tests", "synthetic-probe.ts"), source).map((l) => l.id);

  test("a real-shaped id in a CONCATENATED expect() message is not reported", () => {
    // The shape the ruling was made about: chunks joined with `+`, a trailing
    // comma after the last one. Both planted ids sit past the first closing
    // quote, so a span that stopped there would still report the second.
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectMessageConcatenated)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectMessageConcatenatedLeaks,
    );
  });

  test("a real-shaped id in an INTERPOLATED expect() message is not reported", () => {
    // The other real shape: template chunks carrying `${...}` substitutions,
    // one of them a call with its own parens, and a comma inside the prose —
    // the argument boundary must be read from live code, not from raw text.
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectMessageInterpolated)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectMessageInterpolatedLeaks,
    );
  });

  test("the same id in ordinary assertion position IS still reported — the exemption is narrow, not a file-level pass", () => {
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectOrdinaryAssertion)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectOrdinaryAssertionLeaks,
    );
  });

  test("an expected error message IS still reported, through toThrow and toThrowError alike", () => {
    // The case the thrown-diagnostic ruling named as its reason for refusing
    // an exemption keyed on `new Error(`: inside an assertion that string is
    // the product's own contract. Both matchers are planted because both take
    // the argument OUTSIDE `expect`'s parens, which is the property that
    // spares them; a rule keyed on a matcher NAME would have to list them.
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectThrownContract)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectThrownContractLeaks,
    );
  });

  test("expect()'s FIRST argument stays reportable — the actual value is a product value", () => {
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectFirstArgument)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectFirstArgumentLeaks,
    );
  });

  test("a callback beginning inside the call ends the span, so BOTH its ids are reported", () => {
    // The boundary AC10 states, and the direction of error it chooses: the
    // message of `expect(() => f("CR-..."), "...")` is over-reported rather
    // than guessed at, loudly, in the file that wrote it.
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectCallbackInsideCall)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectCallbackInsideCallLeaks,
    );
  });

  test("the span ends at the second top-level comma, so nothing past the message is a message", () => {
    // Bun's `expect` takes two arguments, so this shape is planted as TEXT
    // and never compiled — it pins the RULE, and the rule is what makes the
    // trailing comma of the concatenated case above safe.
    expect(planted(SYNTHETIC_TRIPWIRE_FIXTURE.expectThirdArgument)).toEqual(
      SYNTHETIC_TRIPWIRE_FIXTURE.expectThirdArgumentLeaks,
    );
  });
});
