// Citations into source code must name the CONSTRUCT they cite — a function,
// constant, type or selector — never a line number. A line drifts the moment
// the file it points into grows or shrinks; a symbol does not. This file is
// the standing guard: it scans the in-scope trees for exactly the five ways
// a citation goes stale, and it proves each of those five checks fires (and
// that a correct citation does not) before it ever asks the real tree a
// question.
//
// THE FIVE DEFECTS, in the order the checker looks for them:
//   1. a `path:line` (or `path:line-line`) citation into a source file —
//      forbidden outright, regardless of whether the line still lands
//      anywhere sensible;
//   1b. a BARE line reference with no path at all — a colon with nothing but
//      whitespace, `(`, `,`, a backtick or the start of the line before it,
//      and one or more digits (optionally a dash and more digits) right
//      after it, naming a line with no file in sight. AC8 forbids "a line
//      citation", not "a path:line citation": dropping the path and keeping
//      the number is still a line citation, and a rewrite that names a
//      construct in parens while leaving the OLD line number behind — or a
//      list that trails off `, :NNN, :NNN` after the first fully-named cite
//      — produces exactly this shape. Neither `PATH_LINE_RE` above (needs a
//      path immediately before the colon) nor `BY_SYMBOL_RE` below (needs a
//      path inside the parens) matches a bare colon, so this is its own
//      rule. The trigger set is narrow ON PURPOSE: a host and its port, a
//      clock reading, a ratio, a URL, a YAML/TOON `key: value` pair and a
//      synthetic id's own sub-index all have a DIGIT or a LETTER sitting
//      directly before the colon, never whitespace, `(`, `,`, a backtick or
//      nothing — so none of them fire. Two specific numbers this project's
//      OWN prose spells the identical bare-colon way, for an unrelated
//      reason — its two protected, never-touched ports — are excluded by
//      exact value rather than by widening the trigger; see
//      `KNOWN_PORT_BARE_NUMBERS` below for why a syntactic rule alone cannot
//      tell those two apart from a line reference, and the narrowest honest
//      fix is an enumerated exception, not a smarter regex;
//   2. a citation naming a source path that resolves to no file in the
//      repository;
//   3. a citation naming a backticked identifier that does not occur, as a
//      whole word, in the file it is cited against.
//   4. a WORD-FORM line citation (VERIFY finding, cycle 540; AC8 widened) —
//      a path glued to `LNN`, GitHub's own `~LNN`/`~LNN-MM` line-permalink
//      shorthand, or the word form `line NN`/`lines NN-MM`/`~line NN`, each
//      still a pointer at a line rather than a construct. See
//      `PATH_ADJACENT_L_RE`, `TILDE_L_RE` and `WORD_LINE_RE` below for the
//      three notations, and `nearbySourcePathMention` for why the tilde and
//      word forms fire only near a named source file, never on ordinary
//      prose that happens to contain the word "line" and a number.
//
// THE CHECKER IS A PURE FUNCTION OVER TEXT (`findCitationViolations`): given
// a file's text and a small `RepoAccess` (resolve a path, read a resolved
// path's content), it returns the violations in that text and touches no
// filesystem itself. The self-tests below hand it an in-memory `RepoAccess`
// built from a literal map, so the four defects and the one non-defect are
// each proven without touching a real file. The tree check at the bottom
// hands the SAME function a real, filesystem-backed `RepoAccess` — one
// function, two worlds.
//
// SCOPE, as a single declared list (`IN_SCOPE_TREES`) rather than scattered
// conditionals, so a later cycle extends coverage by appending one entry.
// This cycle appends "tests" — the whole diff needed to widen coverage onto
// the test tree, as promised. Two carve-outs stay OUT, each its own reasoned
// mechanism rather than a widened regex: `docs/changes` (a spec describes
// the tree it was written against) stays un-named, same as before; the
// dated history notes inside `tests/project-namespace-tripwire.test.ts` are
// named IN scope — the file sits under `tests/`, like every other test — but
// have their exact LINE RANGES excluded before the checker ever sees the
// text, because not every citation in that file is a dated note (two are
// ordinary, undated design-rationale prose and stay reportable). See
// `OUT_OF_SCOPE_LINE_RANGES` below for the ranges and the reasoning. The rest
// of the repository stays out by simply never being named. `node_modules`,
// `.git`, `__pycache__` and the vendored third-party bundle under
// `public/vendor` are never walked: none of them is this project's prose.
// Neither are `.venv`, `coverage`, `test-reports` and `.features-gen` — a
// project's own regenerated build/tooling output, never authored, and (in
// `.venv`'s case) a second, pip-installed COPY of every client that would
// otherwise manufacture a false ambiguity for a bare filename (see the PATH
// RESOLUTION note below).
//
// PATH RESOLUTION, for a citation that names a bare filename or a partial
// path rather than a full repo-relative one: a path resolves if it matches
// exactly one file in the repository, either by exact repo-relative equality
// or by that file's path ending in `/<the given reference>`. Zero matches is
// "no file that exists" (defect 2); MORE than one match is refused, not
// guessed — an ambiguous reference is reported as unresolved with its own
// reason, because picking one of several candidates silently would hide the
// exact drift this guard exists to catch. This is exactly what `.venv` did
// before it was excluded: this repository's own `.venv` carries a
// pip-installed copy of `crucible_axi`, including every client under
// `clients/`, so resolving a bare client filename against the FULL tree
// found two files with the same name and refused as ambiguous — a false
// refusal over a file nobody authored twice, proven wrong by a self-test
// below run against the real repository.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".py", ".sh", ".css", ".html", ".toml"];
const SCANNED_EXTENSIONS = [...SOURCE_EXTENSIONS, ".md"];

// One declared list — see the file header for what each entry means and why
// the two carve-outs (`docs/changes`, the tripwire's dated notes) are
// handled the way they are rather than by widening this list's absence.
const IN_SCOPE_TREES = ["src", "public", "clients", "crucible_axi", "scripts", "bin", "docs/research", "tests"];

const SOURCE_EXT_ALTERNATION = SOURCE_EXTENSIONS.map((e) => e.slice(1)).join("|");

// Defect 1: a path ending in a source extension, directly followed by a
// colon and one or two dash-joined line numbers, with nothing sitting
// between the extension and the colon. Two carve-outs apply AFTER the
// match, in the checker below rather than in the pattern — the same
// discipline BARE_LINE_RE's own two carve-outs follow, for the same
// reason (both need to look past the match, which the pattern itself
// cannot express without risking a silently shortened match):
//   • a `:N:M` shape right after the match — a second bare colon-plus-
//     digits — is the SAME stack-trace position defect 1b excludes: line,
//     then column, captured verbatim from a real test run, never a
//     citation. `run-detail.spec.ts:14:3` names a column, not a second
//     line, and is never reported;
//   • a path ROOTED at `tmp/` never names a repository file — it names a
//     scratch fixture location a test creates under a temp directory and
//     deletes. An absolute `/tmp/...` loses its leading `/` to this
//     pattern's own match start (`[A-Za-z0-9_]` never allows `/` as its
//     first character), so both spellings land here as `tmp/...` and both
//     are excluded. A `tmp/` directory anywhere OTHER than the path's own
//     root — `fixtures/tmp/real.ts`, say — is not this carve-out and stays
//     reportable. Proven against the real tree by a self-test below: this
//     repository has no top-level `tmp/` directory, so the carve-out can
//     never quietly hide a genuine citation.
const PATH_LINE_RE = new RegExp(
  String.raw`[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:${SOURCE_EXT_ALTERNATION}):\d+(?:-\d+)?`,
  "g",
);

// Defect 1b (see the file header): a bare line reference, no path anywhere
// near it. The lookbehind IS the whole rule — everything that must NOT fire
// has a digit or a letter sitting directly before its colon; everything this
// cycle found that SHOULD fire has whitespace, `(`, `,`, a backtick or the
// start of a line instead. Two further, narrower carve-outs apply AFTER the
// match, in code rather than in the pattern, because both need to look at
// what comes right after the digits, which a lookbehind cannot express
// without inviting exactly the kind of backtracking that would silently
// shorten a real match to a wrong, shorter one instead of refusing it:
//   • a `:N:M` shape — a second bare colon-plus-digits immediately after the
//     first — describes a STACK-TRACE POSITION (line, then column), not a
//     citation, and is never reported, however the first colon sits;
//   • a number of five digits or more is never a line reference: no in-scope
//     file is anywhere near that long (proven by a self-test that measures
//     the real tree, so it fails loudly the day one is), and this project's
//     prose uses exactly this shorthand for a high, throwaway port instead.
const BARE_LINE_RE = /(?<=^|[\s(,`]):\d+(?:-\d+)?/gm;

// No in-scope file is this long, so a bare number at or past this threshold
// is a port or similar, never a line. Checked against the real tree by a
// self-test below, so a file crossing it fails the self-test loudly rather
// than silently teaching the guard to ignore a real citation.
const BARE_LINE_IMPLAUSIBLE_THRESHOLD = 10000;

// This project's own two protected, never-touched ports, spelled throughout
// its prose as this exact bare-colon shorthand for a reason that has nothing
// to do with citing a line — a syntactic rule alone cannot tell "the board
// on this port" from "the code at this line" apart, so the fix is an
// enumerated exception on the two known values, not a cleverer pattern. Any
// OTHER number in the identical shape is still a line reference and still
// fires — proven below.
const KNOWN_PORT_BARE_NUMBERS = new Set(["3849", "3850"]);

// The BY-SYMBOL shape this CR's rewrite produces: a backticked identifier
// immediately followed either by a parenthesised path or by `in <path>`, the
// path itself optionally backtick-wrapped. Both connectives are in active
// use in this repository's own prose. A path captured here never contains a
// colon, so a citation that still carries a line number is left for
// `PATH_LINE_RE` above to catch — defects 1 and 2/3 are never double-counted
// against the same occurrence.
const IDENT_TOKEN = String.raw`\`([A-Za-z_$][\w$]*)\``;
const PATH_TOKEN = String.raw`\`?([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:${SOURCE_EXT_ALTERNATION}))\`?`;
const BY_SYMBOL_RE = new RegExp(`${IDENT_TOKEN}\\s*(?:\\(\\s*${PATH_TOKEN}\\s*\\)|\\bin\\s+${PATH_TOKEN})`, "g");

// Defect 4 (VERIFY finding, cycle 540; user ruling 2026-09-27; AC8 widened):
// a WORD-FORM line citation into a source file — the two colon notations
// above (a path immediately followed by a colon and a number, or that same
// bare colon-plus-number with no path in sight) are not the only shape a
// line pointer takes. Three notations, each its own pattern rather than one
// "smarter" regex, the same discipline PATH_LINE_RE/BARE_LINE_RE already
// follow (numbers below spelled `NNN`/`MMM`, never a real digit, for the
// same reason `BARE_LINE_RE`'s own comment spells its example `:NNN`, so
// this file's OWN explanatory prose never becomes a citation the tree check
// then reports against itself):
//   • a bare `LNNN`/`LNNN-MMM` GLUED directly onto a source path with no
//     tilde (`PATH_ADJACENT_L_RE`) — reported only when the path sits
//     immediately before it, since a lone `LNNN` with nothing naming a file
//     anywhere near it is not distinguishable from an arbitrary label;
//   • the `~LNNN`/`~LNNN-MMM` tilde-line shorthand (`TILDE_L_RE`), GitHub's
//     own line-permalink notation;
//   • the word form `line NN` / `lines NN-MM` / `~line NN` (`WORD_LINE_RE`).
// The tilde form and the word form are each reported ONLY when a source
// path or a backticked source-file construct sits somewhere in the SAME
// SENTENCE, itself bounded by the SAME PARAGRAPH (`nearbySourcePathMention`/
// `paragraphRanges`/`sentenceRangeWithin` below) — the same "adjacent to a
// named file" requirement `PATH_LINE_RE` and `BY_SYMBOL_RE` apply
// structurally, expressed here as a proximity check because the word form's
// grammar does not glue the path and the number together.
//
// A PARAGRAPH, not a fixed character window: a real citing comment routinely
// names the file ONCE and then lists several tilde-line markers afterward —
// this project's own dom-settle helper's timer-audit comment names one
// source file once and then lists a dozen such markers, several hundred
// characters past that one mention. A fixed radius short enough to avoid
// false positives elsewhere would silently miss most of that list, and a
// radius long enough to reach it would just as silently start pairing an
// UNRELATED path with an unrelated word-line marker hundreds of characters
// away in the next paragraph. A paragraph boundary is content the author
// already drew, not a number this checker invents, so it is the one width
// that scales with the real prose instead of guessing at it. A paragraph is
// delimited by a line that is blank, or blank apart from a lone comment
// leader (`//`, `#`, `/*`, `*/`, `*`, `<!--`, `-->`) with nothing else on
// it — the exact shape this repository's own multi-line comments already
// use as an in-comment paragraph break.
//
// Without a paragraph check at all, ordinary prose that merely contains the
// word "line" next to a number — a bare count with no unit named at all, or
// a count that PRECEDES the word ("line" never matched by a pattern that
// requires digits AFTER it) — would never even reach the check, and a
// sentence naming a line of some UNRELATED thing (an output stream, not a
// source file), with no file named anywhere in the same paragraph, is
// excluded BY the check. Two further carve-outs apply to the word form
// specifically, checked in code after the match, never by widening the
// pattern:
//   • a line number inside a SPEC RECORD (an acceptance criterion, spelled
//     "<record> AC line NN" in this project's own prose) names a position
//     in a document, not source — excluded whenever "AC" sits directly
//     before "line";
//   • a captured runtime stack trace — Python's own `File "mod.py", line
//     NN, in fn` shape — names a STACK POSITION, not an authored citation,
//     whatever happens to sit nearby — excluded whenever the text right
//     after the digits continues `, in `.

// A line that is blank, or blank apart from a single comment leader, marks a
// PARAGRAPH BOUNDARY (see the comment above). Anchored with `^`/`$` and run
// with the `m` flag, one test per line.
const PARAGRAPH_BREAK_LINE_RE = /^[ \t]*(?:\/\/|#|\/\*|\*\/|\*|<!--|-->)?[ \t]*$/;

// Splits TEXT into [start, end) character ranges, one per paragraph — a
// maximal run of lines that are NOT paragraph-boundary lines. Blank/leader
// lines themselves belong to no paragraph.
function paragraphRanges(text: string): [number, number][] {
  const lines = text.split("\n");
  const ranges: [number, number][] = [];
  let paraStart: number | null = null;
  let charIndex = 0;
  for (const line of lines) {
    const lineStart = charIndex;
    if (PARAGRAPH_BREAK_LINE_RE.test(line)) {
      if (paraStart !== null) {
        ranges.push([paraStart, lineStart]);
        paraStart = null;
      }
    } else if (paraStart === null) {
      paraStart = lineStart;
    }
    charIndex = lineStart + line.length + 1;
  }
  if (paraStart !== null) ranges.push([paraStart, text.length]);
  return ranges;
}

const PATH_ADJACENT_L_RE = new RegExp(
  String.raw`[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:${SOURCE_EXT_ALTERNATION})[:\s]+L\d+(?:-\d+)?`,
  "g",
);

const TILDE_L_RE = /~L\d+(?:-\d+)?/g;

const WORD_LINE_RE = /~?\blines?\b\s+\d+(?:-\d+)?/g;

// Not a citation pattern itself — used only to decide whether text SURROUNDING
// a tilde/word-form match is "about" a source file at all. No `g` flag: each
// call is a fresh, stateless `.test()`.
const SOURCE_PATH_MENTION_RE = new RegExp(
  String.raw`[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:${SOURCE_EXT_ALTERNATION})`,
);

// A DOCS-RECORD mention: a `docs/changes/` path, or any path ending in
// `.md`. Never a SOURCE file per `SOURCE_EXTENSIONS` (`.md` is deliberately
// absent from that list) — the same reasoning `docs/changes/` is carved out
// of §S4 entirely, generalised to any `.md` record (a design note under
// `docs/research/` describing a fixture's provenance is exactly as much a
// RECORD, not a pointer, as a `docs/changes/` spec is).
const DOCS_MENTION_RE = /\bdocs\/changes\/[A-Za-z0-9_.\/-]*|\b[A-Za-z0-9_][A-Za-z0-9_.\/-]*\.md\b/g;

// Which kind of file ("source" or "docs") is named CLOSEST BEFORE
// `matchStartInParagraph`, within one paragraph's own text — or `null` if no
// path of either kind precedes the match at all. NEAREST PRECEDING, never
// nearest in either direction and never "anywhere in the paragraph": this is
// the fix for two real defects VERIFY's hand-check found this cycle in the
// first (any-mention-anywhere) design:
//   • a paragraph that opens by naming a source file ONCE, then lists one
//     word-line marker per SENTENCE afterward (a bulleted "current code
//     facts" comment, one bullet — one sentence — per marker) still
//     resolves each later marker back to that SAME opening mention, because
//     nothing else names a file in between; a check scoped to the marker's
//     own SENTENCE would lose every marker after the first;
//   • a paragraph whose FIRST sentence cites a spec record ("see the table
//     at line NN of that doc", naming a `docs/changes/*.md` or research
//     `.md` file) and whose SECOND, unrelated sentence happens to name a
//     real source file resolves the first sentence's marker against the
//     record it actually follows, never against the source file that comes
//     LATER — a check that also looked FORWARD, or that ignored order and
//     just took whichever mention was closest by raw character count, could
//     still pick the wrong one.
// A paragraph boundary still bounds the search (see the file header) so an
// EARLIER paragraph's file never governs a later, unrelated one.
function nearestPrecedingMentionType(paragraphText: string, matchStartInParagraph: number): "source" | "docs" | null {
  let bestPos = -1;
  let bestType: "source" | "docs" | null = null;
  const scan = (re: RegExp, type: "source" | "docs") => {
    for (const m of paragraphText.matchAll(re)) {
      const pos = m.index ?? 0;
      if (pos < matchStartInParagraph && pos > bestPos) {
        bestPos = pos;
        bestType = type;
      }
    }
  };
  scan(new RegExp(SOURCE_PATH_MENTION_RE.source, "g"), "source");
  scan(DOCS_MENTION_RE, "docs");
  return bestType;
}

function nearbySourcePathMention(paragraphs: readonly [number, number][], text: string, matchStart: number): boolean {
  for (const [start, end] of paragraphs) {
    if (matchStart < start || matchStart >= end) continue;
    return nearestPrecedingMentionType(text.slice(start, end), matchStart - start) === "source";
  }
  return false;
}
const WORD_FORM_LINE_REASON = "word-form line citation into a source file (must cite by symbol, never by line)";

export interface Violation {
  citingFile: string;
  cite: string;
  reason: string;
}

export interface ExemptFixture {
  citingFile: string;
  text: string;
  reason: string;
}

export interface RepoAccess {
  resolve(pathRef: string): { path: string | null; ambiguous: boolean };
  read(relPath: string): string;
}

// The one path-resolution rule (see the file header), usable against either
// a literal in-memory file map or a real repository listing.
export function resolveSourcePath(
  ref: string,
  knownPaths: readonly string[],
): { path: string | null; ambiguous: boolean } {
  const norm = ref.replace(/\\/g, "/");
  if (knownPaths.includes(norm)) return { path: norm, ambiguous: false };
  const suffix = `/${norm}`;
  const matches = knownPaths.filter((p) => p.endsWith(suffix));
  if (matches.length === 1) return { path: matches[0]!, ambiguous: false };
  if (matches.length > 1) return { path: null, ambiguous: true };
  return { path: null, ambiguous: false };
}

function isExempt(citingFile: string, cite: string, exempt: readonly ExemptFixture[]): boolean {
  return exempt.some((e) => e.citingFile === citingFile && e.text === cite);
}

// THE CHECKER. Pure over its inputs: no import of `node:fs` appears in this
// function, and `repo` is the only door to anything outside `text` itself.
export function findCitationViolations(
  citingFile: string,
  text: string,
  repo: RepoAccess,
  exempt: readonly ExemptFixture[],
): Violation[] {
  const violations: Violation[] = [];

  for (const m of text.matchAll(PATH_LINE_RE)) {
    const cite = m[0];
    // A `:N:M` shape right after this match is a stack-trace position, not
    // a citation (see the PATH_LINE_RE comment above) 
    // checked on the ORIGINAL text right after the match, the same way
    // BARE_LINE_RE checks its own trailing `:M` below.
    const pathAfterMatch = text.slice((m.index ?? 0) + cite.length, (m.index ?? 0) + cite.length + 8);
    if (/^:\d/.test(pathAfterMatch)) continue;
    // A path rooted at `tmp/` names a scratch fixture location, never a
    // file this repository tracks (see the PATH_LINE_RE comment above).
    if (cite.startsWith("tmp/")) continue;
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({
      citingFile,
      cite,
      reason: "path:line citation into a source file (must cite by symbol, never by line)",
    });
  }

  for (const m of text.matchAll(BARE_LINE_RE)) {
    const cite = m[0];
    // A `:N:M` shape is a stack-trace line:column position, not a citation 
    // checked on the ORIGINAL text right after the match, never by widening
    // the pattern itself (see the file header for why a lookbehind-only
    // version of this check would risk silently shortening the match).
    const afterMatch = text.slice((m.index ?? 0) + cite.length, (m.index ?? 0) + cite.length + 8);
    if (/^:\d/.test(afterMatch)) continue;
    const digitGroups = cite.slice(1).split("-");
    if (digitGroups.some((d) => Number(d) >= BARE_LINE_IMPLAUSIBLE_THRESHOLD)) continue;
    if (KNOWN_PORT_BARE_NUMBERS.has(digitGroups[0]!)) continue;
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({
      citingFile,
      cite,
      reason: "bare line reference with no path (still a line citation, never a construct)",
    });
  }

  for (const m of text.matchAll(BY_SYMBOL_RE)) {
    const identifier = m[1]!;
    const pathRef = (m[2] ?? m[3])!;
    const cite = m[0];
    if (isExempt(citingFile, cite, exempt)) continue;
    const { path: resolved, ambiguous } = repo.resolve(pathRef);
    if (resolved === null) {
      violations.push({
        citingFile,
        cite,
        reason: ambiguous
          ? `cited path "${pathRef}" is ambiguous (matches more than one file)`
          : `cited path "${pathRef}" names no file that exists`,
      });
      continue;
    }
    const wordRe = new RegExp(`\\b${identifier.replace(/[$]/g, "\\$")}\\b`);
    if (!wordRe.test(repo.read(resolved))) {
      violations.push({
        citingFile,
        cite,
        reason: `backticked identifier \`${identifier}\` does not occur in ${resolved}`,
      });
    }
  }

  for (const m of text.matchAll(PATH_ADJACENT_L_RE)) {
    const cite = m[0];
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({ citingFile, cite, reason: WORD_FORM_LINE_REASON });
  }

  const paragraphs = paragraphRanges(text);

  for (const m of text.matchAll(TILDE_L_RE)) {
    const cite = m[0];
    const matchStart = m.index ?? 0;
    if (!nearbySourcePathMention(paragraphs, text, matchStart)) continue;
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({ citingFile, cite, reason: WORD_FORM_LINE_REASON });
  }

  for (const m of text.matchAll(WORD_LINE_RE)) {
    const cite = m[0];
    const matchStart = m.index ?? 0;
    const matchEnd = matchStart + cite.length;
    // "AC line 267": a spec-record reference (an acceptance criterion), not
    // a pointer into source (see the file header).
    const beforeMatch = text.slice(Math.max(0, matchStart - 6), matchStart);
    if (/\bAC\s*$/.test(beforeMatch)) continue;
    // A captured Python traceback: `File "mod.py", line 42, in fn` (see the
    // file header).
    const afterMatch = text.slice(matchEnd, matchEnd + 8);
    if (/^,\s*in\b/.test(afterMatch)) continue;
    if (!nearbySourcePathMention(paragraphs, text, matchStart)) continue;
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({ citingFile, cite, reason: WORD_FORM_LINE_REASON });
  }

  return violations;
}

// OUT OF SCOPE BY RANGE, not by name — the dated history notes inside
// tests/project-namespace-tripwire.test.ts (§S4's own carve-out). That file
// is IN scope (it lives under `tests/`), but §S4 excludes its dated notes
// specifically, not the whole file, and this file's citations are NOT all
// dated: an undated "RULED, NOT CODED" design-rationale comment cites two
// real test files by path:line, and it is ordinary prose, not a record —
// checked, and named by no marker below, so it stays reportable. What IS
// excluded are the file's dated notes: a "namespaces the suite invents"
// rationale built up by dated additions, three small dated annotations
// threaded through a residue table's entries, and one long dated ledger
// tracking a citation-count contract over time.
//
// RANGES ARE ANCHORED TO CONTENT, NEVER TO A LINE NUMBER, because a line
// number IS exactly the drift this CR removes: the AC9 close-out re-pin this
// CR owes edits prose inside tests/project-namespace-tripwire.test.ts, which
// would shift every line after it, silently widening or narrowing a numeric
// range without anyone noticing. Each entry below names a `startMarker` and
// an `endMarker` — unique substrings of the file, resolved to line numbers
// at RUN TIME by `resolveOutOfScopeRanges` — so a marker that stops being
// unique (edited into two copies, or edited away entirely) makes resolution
// THROW rather than silently keep working over the wrong lines (proven by a
// self-test below, on synthetic text, and by a self-test that every declared
// marker still resolves to exactly one occurrence in the real file).
// `startMarker` is drawn from the dated note's own opening line, with any CR
// literal left out (kept out of THIS file's own text on purpose); `endMarker`
// is drawn from the STABLE object-map entry or declaration that immediately
// follows the note — code a citation rewrite never touches — so the range
// runs from the marked start line up to, but not including, the marked end
// line. Each range was read end to end and verified to hold NOT ONE
// non-comment, non-blank line — confirmed again by a self-test below — so
// blanking it removes prose and nothing any test depends on. Blanking the
// TEXT before the checker ever sees it (rather than special-casing the
// citingFile inside the pure function, or listing every individual dated
// string in `EXEMPT_FIXTURES`) keeps `findCitationViolations` ignorant of
// this one file's carve-out and keeps the exemption mechanism itself honest:
// this is a scope decision about a RANGE of one file, never a claim that any
// one string is fixture data.
interface OutOfScopeRange {
  startMarker: string;
  endMarker: string;
  reason: string;
}

const OUT_OF_SCOPE_RANGES: Record<string, OutOfScopeRange[]> = {
  "tests/project-namespace-tripwire.test.ts": [
    {
      startMarker: "namespaces the suite INVENTS",
      endMarker: "const SYNTHETIC_NAMESPACES",
      reason:
        "the dated construction history of the synthetic-namespace allow-list, built up entry by " +
        "entry across several dated additions; a record of when and why, not a pointer.",
    },
    {
      startMarker: "the FIRST entry this table has taken",
      endMarker: "test_cycle_add_targets_the_plan_it_means.py",
      reason: "a dated annotation on one residue-table entry, explaining what it counts and why.",
    },
    {
      startMarker: "close-out (cycle 527). FOUR literals,",
      endMarker: "test_queue_rows_carry_title_and_lifecycle.py",
      reason: "a second dated residue-table annotation, same reason.",
    },
    {
      startMarker: "close-out (cycle 527), 11 -> 12. The C4",
      endMarker: "roadmap-release-focus.test.ts",
      reason: "a third dated residue-table annotation, same reason.",
    },
    {
      startMarker: "close-out (cycle 527). ONE literal, from",
      endMarker: "roadmap-wave-rows.test.ts",
      reason: "a fourth dated residue-table annotation, same reason.",
    },
    {
      startMarker: "THE PROVENANCE COUNT, MEASURED WITH THE CLASSIFIER AND PINNED",
      endMarker: "const PROSE_CITATIONS",
      reason:
        "the long dated ledger tracking the shipped-code/design-note citation count across every " +
        "CR that touched it — a history of counts, not a pointer into any one of them.",
    },
  ],
};

function countOccurrences(text: string, marker: string): number {
  if (marker.length === 0) return 0;
  return text.split(marker).length - 1;
}

function lineNumberOfIndex(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Resolves each declared {startMarker, endMarker} pair against TEXT to a
// [startLine, endLine] pair, inclusive of the start marker's own line and
// EXCLUSIVE of the end marker's own line (the end marker names the first
// line of live code or the next declaration AFTER the blanked prose, never a
// line inside it). THROWS if either marker resolves to zero or more than one
// occurrence — a disappearing or duplicated marker fails the run loudly,
// never silently widening or dropping the exemption.
function resolveOutOfScopeRanges(text: string, declared: readonly OutOfScopeRange[]): [number, number][] {
  return declared.map(({ startMarker, endMarker }) => {
    const startCount = countOccurrences(text, startMarker);
    const endCount = countOccurrences(text, endMarker);
    if (startCount !== 1 || endCount !== 1) {
      throw new Error(
        "out-of-scope range marker did not resolve to exactly one occurrence each: " +
          `start=${JSON.stringify(startMarker)} (${startCount} occurrence(s)), ` +
          `end=${JSON.stringify(endMarker)} (${endCount} occurrence(s))`,
      );
    }
    const startLine = lineNumberOfIndex(text, text.indexOf(startMarker));
    const endLine = lineNumberOfIndex(text, text.indexOf(endMarker)) - 1;
    return [startLine, endLine];
  });
}

// Blanks a resolved set of [startLine, endLine] ranges (inclusive) out of
// TEXT, line by line. Factored out of `withOutOfScopeRangesBlanked` so a
// self-test can exercise the SAME blanking step directly, against synthetic
// ranges it resolves itself, without needing a real file's relPath key in
// `OUT_OF_SCOPE_RANGES`.
function blankRanges(text: string, ranges: readonly [number, number][]): string {
  const lines = text.split("\n");
  for (const [startLine, endLine] of ranges) {
    for (let ln = startLine; ln <= endLine; ln++) {
      const idx = ln - 1;
      if (idx >= 0 && idx < lines.length) lines[idx] = "";
    }
  }
  return lines.join("\n");
}

function withOutOfScopeRangesBlanked(relPath: string, text: string): string {
  const declared = OUT_OF_SCOPE_RANGES[relPath];
  if (!declared) return text;
  const ranges = resolveOutOfScopeRanges(text, declared);
  return blankRanges(text, ranges);
}

// ---------------------------------------------------------------------------
// Self-tests (AC10): the checker proven against literal, in-memory worlds —
// never a real file — before it is trusted against the repository below.
// ---------------------------------------------------------------------------

function fakeRepo(files: Record<string, string>): RepoAccess {
  const knownPaths = Object.keys(files);
  return {
    resolve: (ref) => resolveSourcePath(ref, knownPaths),
    read: (relPath) => files[relPath] ?? "",
  };
}

describe("the citation checker", () => {
  test("fires on a planted path:line citation into a source file", () => {
    // Built from pieces at runtime so the raw text of THIS file never
    // itself spells a contiguous path:line citation.
    const citation = ["fixtures/planted", ".ts", ":", "42"].join("");
    const text = `The dispatcher's shape is described at ${citation}, roughly.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: citation,
        reason: "path:line citation into a source file (must cite by symbol, never by line)",
      },
    ]);
  });

  test("fires on a planted path:line-range citation into a source file", () => {
    const citation = ["fixtures/planted", ".py", ":", "10", "-", "20"].join("");
    const text = `See ${citation} for the retry loop.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.cite).toBe(citation);
    expect(violations[0]!.reason).toContain("path:line citation");
  });

  test("fires when a by-symbol citation names a file that resolves to nothing", () => {
    // Built from pieces (see the file header) so this self-test's own
    // by-symbol shape never becomes a live citation once "tests" joins
    // `IN_SCOPE_TREES` — the SAME reason the path:line self-tests above
    // already build their citations from pieces.
    const missingPath = ["fixtures/does-not", "-exist", ".ts"].join("");
    const cite = ["`plantedSymbol`", " (", missingPath, ")"].join("");
    const text = `The seam is ${cite}.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite,
        reason: `cited path "${missingPath}" names no file that exists`,
      },
    ]);
  });

  test("fires when the backticked identifier does not occur in its cited file", () => {
    const fixturePath = ["fixtures/real", ".ts"].join("");
    const repo = fakeRepo({ [fixturePath]: "export function actualSymbol() {}\n" });
    const cite = ["`missingSymbol`", " (", fixturePath, ")"].join("");
    const text = `The seam is ${cite}.`;
    const violations = findCitationViolations("planted-doc.md", text, repo, []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite,
        reason: `backticked identifier \`missingSymbol\` does not occur in ${fixturePath}`,
      },
    ]);
  });

  test("does NOT fire on a correct by-symbol citation, parenthesised form", () => {
    const fixturePath = ["fixtures/real", ".ts"].join("");
    const repo = fakeRepo({ [fixturePath]: "export function actualSymbol() {}\n" });
    const text = `The seam is ${["`actualSymbol`", " (", fixturePath, ")"].join("")}.`;
    expect(findCitationViolations("planted-doc.md", text, repo, [])).toEqual([]);
  });

  test("does NOT fire on a correct by-symbol citation, the `in` connective", () => {
    const repo = fakeRepo({ "scripts/release.sh": "plan_merge_map() {\n  :\n}\n" });
    const text = "`plan_merge_map` in `scripts/release.sh` builds the table.";
    expect(findCitationViolations("planted-doc.md", text, repo, [])).toEqual([]);
  });

  test("treats an ambiguous bare-filename cite as unresolved, never guessed", () => {
    const bareName = ["shared", ".ts"].join("");
    const repo = fakeRepo({
      [`fixtures/a/${bareName}`]: "export function sharedSymbol() {}\n",
      [`fixtures/b/${bareName}`]: "export function sharedSymbol() {}\n",
    });
    const cite = ["`sharedSymbol`", " (", bareName, ")"].join("");
    const text = `The seam is ${cite}.`;
    const violations = findCitationViolations("planted-doc.md", text, repo, []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite,
        reason: `cited path "${bareName}" is ambiguous (matches more than one file)`,
      },
    ]);
  });

  test("a declared fixture-data exemption suppresses its exact string in its exact file only", () => {
    const citation = ["fixtures/fixture", ".ts", ":", "10"].join("");
    const exempt: ExemptFixture[] = [
      { citingFile: "planted-doc.md", text: citation, reason: "test fixture data, not a citation" },
    ];
    const suppressed = findCitationViolations(
      "planted-doc.md",
      `The parser test asserts on the literal string "${citation}".`,
      fakeRepo({}),
      exempt,
    );
    expect(suppressed).toEqual([]);

    // The SAME string in a DIFFERENT file is not covered by that entry — the
    // exemption is keyed on (file, text), never on text alone.
    const stillFires = findCitationViolations(
      "other-doc.md",
      `The parser test asserts on the literal string "${citation}".`,
      fakeRepo({}),
      exempt,
    );
    expect(stillFires).toHaveLength(1);
  });
});

describe("the citation checker — bare line references (defect 1b)", () => {
  test("fires on a bare line reference sitting alone in parens, backtick-wrapped", () => {
    // Built from pieces: a rewrite that named the construct but left the OLD
    // line number behind in parens, backtick-wrapped, exactly the shape a
    // half-finished by-symbol rewrite produces.
    const bareCite = [":", "690"].join("");
    const parenthesised = ["(", "`", bareCite, "`", ")"].join("");
    const text = `\`numericLabelCompare\` already reads the same digit out of a label ${parenthesised}, elsewhere in the module.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: bareCite,
        reason: "bare line reference with no path (still a line citation, never a construct)",
      },
    ]);
  });

  test("fires on a bare line-range reference trailing after a comma, continuing a citation named earlier in the sentence", () => {
    const namedCite = ["fixtures/planted", ".ts", ":", "318"].join("");
    const trailingBare = [":", "915", "-", "920"].join("");
    const text = `Five new citations name the change: ${namedCite}, ${trailingBare} and one more.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: namedCite,
        reason: "path:line citation into a source file (must cite by symbol, never by line)",
      },
      {
        citingFile: "planted-doc.md",
        cite: trailingBare,
        reason: "bare line reference with no path (still a line citation, never a construct)",
      },
    ]);
  });

  test("fires on a bare line reference at the very start of a comment fragment", () => {
    const bareCite = [":", "1848"].join("");
    const text = `${bareCite} is a MEMBERSHIP claim, not a scheduling one.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: bareCite,
        reason: "bare line reference with no path (still a line citation, never a construct)",
      },
    ]);
  });

  test("does NOT fire on a host:port pair", () => {
    const text = "The board binds 127.0.0.1:3850 for local development.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a bare hostname:port pair", () => {
    const text = "A client that reaches for localhost:3849 is talking to the wrong instance.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a clock time", () => {
    const text = "The cycle rolled over at 12:30, well before the deadline.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a clock time carrying seconds", () => {
    const text = "The run finished at 09:05:00, a few minutes early.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a synthetic id's own sub-index", () => {
    const text = "CR-T-001:2 is the second ruling the fixture cites, not a line.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a URL carrying an explicit port", () => {
    const text = "The dashboard is documented at http://example.com:8080/dashboard in the runbook.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a YAML/TOON `key: value` pair, even when the value is numeric", () => {
    const text = "wave: 7\ntrack: 3\n";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on this project's own two protected ports, even in the exact bare-colon shorthand its prose uses", () => {
    const text = [
      "Never touch the board on ",
      [":", "3849"].join(""),
      " or the dev board on ",
      [":", "3850"].join(""),
      ", even from a fixture.",
    ].join("");
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("a THIRD number in the identical bare-colon shorthand is still reported — the port exclusion is two exact values, not a blanket pass", () => {
    const bareCite = [":", "3851"].join("");
    const text = `A third board would sit on ${bareCite}, in the same shorthand.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: bareCite,
        reason: "bare line reference with no path (still a line citation, never a construct)",
      },
    ]);
  });

  test("does NOT fire on a :N:M line:column form, even when the FIRST colon sits in an otherwise-triggering position", () => {
    const stackPosition = ["(", ":", "15", ":", "3", ")"].join("");
    const text = `the captured fixture trace reads ${stackPosition} verbatim`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a :N:M form even when the range form (:N-M) precedes the column", () => {
    const stackPosition = [":", "1306", "-", "1310", ":", "4"].join("");
    const text = `, ${stackPosition} in the trace`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a bare number at or past the implausible-line threshold, the shape this project uses for a throwaway high port", () => {
    const bareCite = [":", "48231"].join("");
    const text = `the seam under test tries to connect to ${bareCite} and is refused`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("a number just UNDER the implausible-line threshold is still reported — the cutoff is a real boundary, not a blanket pass on big numbers", () => {
    const bareCite = [":", "9999"].join("");
    const text = `the construct in question sits at ${bareCite}, still a plausible line`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: bareCite,
        reason: "bare line reference with no path (still a line citation, never a construct)",
      },
    ]);
  });
});

describe("the citation checker — path:line citations (defect 1): stack-trace positions and tmp/ fixtures", () => {
  test("does NOT fire on a path:line:col stack-trace position, even into a real source extension", () => {
    const stackPosition = ["run-detail", ".spec.ts", ":", "14", ":", "3"].join("");
    const text = `the captured fixture trace reads "at ${stackPosition}" verbatim`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("a path:line WITHOUT a trailing :col is still reported — the stack-trace exclusion needs an actual column, not just a second colon anywhere later", () => {
    const citation = ["fixtures/planted", ".ts", ":", "14"].join("");
    const text = `the trace reads ${citation} and stops there, no column follows`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: citation,
        reason: "path:line citation into a source file (must cite by symbol, never by line)",
      },
    ]);
  });

  test("does NOT fire on a path rooted at tmp/, a scratch fixture location no repo file ever occupies", () => {
    const citation = ["tmp/bun-fixture/sample", ".test.ts", ":", "2"].join("");
    const text = `the captured transcript names ${citation} for its throwaway fixture`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on an absolute /tmp/ path — the same scratch root, spelled with its leading slash", () => {
    const citation = ["/tmp/bun-fixture/sample", ".test.ts", ":", "2"].join("");
    const text = `the captured transcript names ${citation} for its throwaway fixture`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("a tmp/ directory NOT at the path's root is still reported — the carve-out is a ROOT carve-out, not a directory-name pass anywhere in the path", () => {
    const citation = ["fixtures/tmp/real", ".ts", ":", "5"].join("");
    const text = `the trace reads ${citation} and stops there`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: citation,
        reason: "path:line citation into a source file (must cite by symbol, never by line)",
      },
    ]);
  });
});

describe("the citation checker — word-form line references (defect 4, VERIFY cycle 540)", () => {
  test("fires on a tilde-line marker glued directly onto a source path, `path ~L123`", () => {
    const path = ["fixtures/planted", ".ts"].join("");
    const marker = ["~L", "123"].join("");
    const text = `The retry loop lives at ${path} ${marker}, past the guard clause.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      { citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON },
    ]);
  });

  test("fires on a tilde-line RANGE, `~L123-130`, sitting in a sentence that names a source file elsewhere", () => {
    const path = ["handler", ".ts"].join("");
    const marker = ["~L", "123", "-", "130"].join("");
    const text = `\`handleEventDelete\` inside \`${path}\` still needs a look, ${marker} closely.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      { citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON },
    ]);
  });

  test("fires on a bare `L123` (no tilde) right after a source path", () => {
    const path = ["fixtures/planted", ".ts"].join("");
    const marker = ["L", "123"].join("");
    const cite = `${path} ${marker}`;
    const text = `See ${cite} for the loop.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([{ citingFile: "planted-doc.md", cite, reason: WORD_FORM_LINE_REASON }]);
  });

  test("fires on the tilde word form, `~line 45`, in a sentence naming a backticked construct of a source file", () => {
    const path = ["citations", ".ts"].join("");
    const marker = ["~line", " ", "45"].join("");
    const text = `The construct sits inside \`${path}\`; watch ${marker} there.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      { citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON },
    ]);
  });

  test("fires on the plain word form, `line 91`, adjacent to a source path", () => {
    const path = ["fixtures/example", ".ts"].join("");
    const marker = ["line", " ", "91"].join("");
    const text = `The guard clause in ${path} starts around ${marker}, according to the note.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      { citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON },
    ]);
  });

  test("fires on the plural range word form, `lines 12-20`, used as a pointer into a source file", () => {
    const path = ["fixtures/example", ".py"].join("");
    const marker = ["lines", " ", "12", "-", "20"].join("");
    const text = `The retry loop spans ${path} ${marker}, roughly.`;
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      { citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON },
    ]);
  });

  test("does NOT fire on a line number inside a spec record, `AC line 267`, even beside a named source path", () => {
    const path = ["fixtures/example", ".ts"].join("");
    const acLine = ["AC", " ", "line", " ", "267"].join("");
    const text = `${["CR-CRU", "-030"].join("")}'s ${acLine} still names ${path} the same way it always has.`;
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a captured Python traceback line, `File \"mod.py\", line 42, in fn`", () => {
    const text = 'the captured failure reads File "mod.py", line 42, in some_function verbatim';
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on ordinary prose that says \"one line\" — no number follows the word at all", () => {
    const text = "The diff is one line, nothing more.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on \"line 3 of the output\" inside fixture text with no source file named anywhere close by", () => {
    const text = "The captured transcript's assertion checks that line 3 of the output reads the retry count.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on a \"10-line cap\" — the number precedes the word, never matched by a pattern needing digits AFTER it", () => {
    const text = "The changelog entry enforces a 10-line cap on any single bullet.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("does NOT fire on \"a 2-line diff\" — same reason, the number precedes the word", () => {
    const text = "The rewrite produced a 2-line diff for that file.";
    expect(findCitationViolations("planted-doc.md", text, fakeRepo({}), [])).toEqual([]);
  });

  test("fires on EVERY marker in a paragraph that names its source file ONCE, up front, then lists one marker per sentence", () => {
    // Stands in for this project's own "Current code facts" bulleted-comment
    // style: the file is named once, in a colon-terminated intro, and every
    // bullet AFTER it is its own separate sentence with no repeat mention —
    // proves the context check reaches back across sentence boundaries
    // WITHIN one paragraph, not just within the marker's own sentence.
    const path = ["public/app", ".js"].join("");
    const m1 = ["~L", "49"].join("");
    const m2 = ["~L", "84", "-", "86"].join("");
    const m3 = ["~L", "134"].join("");
    const text = [
      `Current code facts (verified against ${path} on this branch):`,
      `  - navigate() (${m1}) sets state.route with NO clear, NO fetch.`,
      `  - the popstate handler (${m2}) is EVEN THINNER: no reset either.`,
      `  - refetchPlans() (${m3}) early-returns off-workspace.`,
    ].join("\n");
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations.map((v) => v.cite)).toEqual([m1, m2, m3]);
  });

  test("does NOT fire on a word-line marker whose NEAREST preceding mention is a spec record, even though an unrelated source file is named later in the SAME paragraph", () => {
    // Stands in for a real false positive VERIFY's hand-check found this
    // cycle: a citation into a docs/changes record (out of scope per §S4)
    // sat in the paragraph's FIRST sentence, and an unrelated source file
    // happened to be named in its SECOND sentence — an any-mention-anywhere-
    // in-paragraph check fired on the record's own line number.
    const docsPath = ["docs/changes/CR-FIXTURE", "-999-planted", ".md"].join("");
    const marker = ["line", " ", "91"].join("");
    const sourcePath = ["fixtures/unrelated", ".ts"].join("");
    const text = [
      `Contract pinned verbatim from ${docsPath} (see the table at ${marker} of that doc).`,
      `The seam lives in ${sourcePath} and is unrelated to that record.`,
    ].join(" ");
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([]);
  });

  test("a word-line marker still fires when the NEAREST preceding mention in the same paragraph genuinely IS a source file, even after a docs-record mention earlier in that paragraph", () => {
    const docsPath = ["docs/changes/CR-FIXTURE", "-999-planted", ".md"].join("");
    const sourcePath = ["fixtures/real", ".ts"].join("");
    const marker = ["line", " ", "91"].join("");
    const text = [
      `Contract pinned verbatim from ${docsPath}, unrelated to what follows.`,
      `The retry loop lives in ${sourcePath}; see ${marker} for the guard.`,
    ].join(" ");
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([{ citingFile: "planted-doc.md", cite: marker, reason: WORD_FORM_LINE_REASON }]);
  });
});

describe("word-form line references — real-world cases closed this cycle", () => {
  test("the real dom-settle helper's twelve app.js timer citations are ALL caught, not just the ones textually adjacent to the one `app.js` mention", () => {
    const relPath = "tests/helpers/dom-settle.ts";
    const allRelPaths = listAllRepoFiles();
    const repo = realRepo(allRelPaths);
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const wordFormHits = findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES).filter((v) =>
      v.reason.includes("word-form line citation"),
    );
    expect(wordFormHits).toHaveLength(12);
  });

  test("the real rust-crucible role-flag test's spec-record line reference produces no word-form violation, even beside its own real source-path mentions", () => {
    const relPath = "tests/client/test_rust_crucible_role_flag_required.py";
    const allRelPaths = listAllRepoFiles();
    const repo = realRepo(allRelPaths);
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const wordFormHits = findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES).filter(
      (v) => v.reason.includes("word-form line citation") && v.cite.includes("91"),
    );
    expect(wordFormHits).toEqual([]);
  });
});

describe("bare line references — real-world false positives, closed this cycle", () => {
  test("the real teardown-contract's throwaway high port produces no bare-line violation", () => {
    const relPath = "tests/e2e/teardown-contracts/non-ephemeral.contract.ts";
    const allRelPaths = listAllRepoFiles();
    const repo = realRepo(allRelPaths);
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const bareLineHits = findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES).filter((v) =>
      v.reason.includes("bare line reference"),
    );
    expect(bareLineHits).toEqual([]);
  });

  test("the real failure-detail fixture's line:column stack positions produce no bare-line violation", () => {
    const relPath = "tests/client/test_cr088_failure_detail_names_its_leaf.py";
    const allRelPaths = listAllRepoFiles();
    const repo = realRepo(allRelPaths);
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const bareLineHits = findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES).filter((v) =>
      v.reason.includes("bare line reference"),
    );
    expect(bareLineHits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tree check: the same checker, against the real repository.
// ---------------------------------------------------------------------------

// EXEMPT FIXTURE DATA — strings that only look like citations (test fixture
// bodies, not prose pointing anywhere). Declared, not inferred: each entry
// names its exact citing file, its exact string, and why. Every `text` is
// built from pieces (`.join("")`), never written as a contiguous literal, so
// this declaration list itself never spells a `path:line` shape for the tree
// check below to then flag in ITS OWN file.
//
// A cite of a test file SINCE DELETED is the opposite of this — real prose
// naming a real (if now-gone) file at a real line, stale rather than
// invented — and does NOT belong here: it stays a violation for the rewrite
// to name a successor or remove the sentence. Three mock Playwright
// failure-trace fixtures whose invented FILENAME happens to match a spec
// file this project once had and no longer does were checked against git
// history for exactly this reason and left OFF this list on purpose: their
// syntactic shape is indistinguishable from the entries below, and the
// distinction — an invented filename vs. a real file's former name — can
// only be made by hand, which is why this list is declared and exhaustive
// rather than pattern-matched.
//
// Two further candidates the branch-cut census also flagged were checked and
// are likewise NOT listed here, because they are not fixture data either:
// a citation into a real, still-existing test file (mangled by a line-wrap
// mid-filename, but still a genuine stale path:line, not invented text), and
// a citation into a real third-party type-declaration file by path:line
// (naming a real file outside this repository's own trees, but still a line
// citation the guard exists to forbid, not a parser's test input). Both stay
// in the worklist below, and a THIRD category also lives in this same list,
// for the same reason `docs/changes/` stays out of scope entirely (S4): a
// citation that only EXISTS because it is a verbatim quote of a
// `docs/changes/` record is that same record, not a pointer, wherever the
// quote happens to be copied to -- the roadmap type-scale guard's bare line
// numbers, each a word-for-word quote of a `TYPE_SCALE.row` field lifted
// from CR-CRU-103's own Correction table, and the AC2 quote in
// `test_cr097_cr_help_namespace_neutral.py`, once restored to the exact
// wording CR-CRU-097's own spec states.
const EXEMPT_FIXTURES: ExemptFixture[] = [
  {
    citingFile: "tests/playwright-codec.test.ts",
    text: ["file", ".ts", ":", "10"].join(""),
    reason:
      "an invented mock Playwright failure `stack` string the frame-condensation test asserts on " +
      "verbatim; the file is invented and never exists on disk.",
  },
  {
    citingFile: "tests/drill-in.test.ts",
    text: ["file", ".ts", ":", "10"].join(""),
    reason: "the same invented mock stack frame, asserted on by the failure-detail drill-in test.",
  },
  {
    citingFile: "tests/drill-in.test.ts",
    text: ["file", ".ts", ":", "9"].join(""),
    reason: "a second invented mock stack frame (a different fixture case) in the same file.",
  },
  {
    citingFile: "tests/drill-in.test.ts",
    text: ["file", ".ts", ":", "12"].join(""),
    reason: "a third invented mock stack frame (a third fixture case) in the same file.",
  },
  {
    citingFile: "tests/ingest-no-implicit-agents.test.ts",
    text: ["src/x", ".ts", ":", "1"].join(""),
    reason:
      "a synthetic tsc-shaped compiler-error payload posted to the compile-ingest endpoint under " +
      "test; the file is invented for the fixture and never exists.",
  },
  {
    citingFile: "tests/client/test_cr088_failure_detail_names_its_leaf.py",
    text: ["d", ".test.ts", ":", "7"].join(""),
    reason:
      "a captured real `bun test` failure transcript, printed against a throwaway fixture file the " +
      "test itself writes into an mkdtemp replica and deletes; the parser test asserts on this exact " +
      "frame text, not on the fixture file continuing to exist.",
  },
  {
    citingFile: "tests/client/test_cr088_failure_detail_names_its_leaf.py",
    text: ["d", ".test.ts", ":", "11"].join(""),
    reason: "the same throwaway-fixture transcript's second frame.",
  },
  {
    citingFile: "tests/client/test_cr088_failure_detail_names_its_leaf.py",
    text: ["d", ".test.ts", ":", "15"].join(""),
    reason: "the same throwaway-fixture transcript's third frame.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "76"].join(""),
    reason:
      "a verbatim quote of CR-CRU-103's own Correction table -- the CR row entry, mono 11px -- copied " +
      "into `TYPE_SCALE`'s `row:` field so a failure names the table entry (see the comment above " +
      "`TYPE_SCALE`); the same record-not-pointer reasoning `docs/changes/` is carved out for " +
      "entirely -- the line number is quoted from the SPEC's own page, not a pointer into this " +
      "repository's source tree.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "72"].join(""),
    reason: "the same Correction table, its wave-header row (mono 10px uppercase), quoted the same way.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "81"].join(""),
    reason:
      "the same Correction table's row-annotation entry, quoted twice in `TYPE_SCALE` (once for the " +
      "status leaf, once for the annotation leaf) -- one entry covers both occurrences, since the " +
      "exemption is keyed on the exact string, not a count.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "120"].join(""),
    reason: "the same Correction table, its pointer row (mono 9.5px, centred), quoted the same way.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "100"].join(""),
    reason: "the same Correction table, its status-pill row (mono 10px, bordered), quoted the same way.",
  },
  {
    citingFile: "tests/roadmap-visual-grammar.test.ts",
    text: [":", "97"].join(""),
    reason: "the same Correction table, its zone-3-cells row (mono 11.5px), quoted the same way.",
  },
  {
    citingFile: "tests/client/test_cr097_cr_help_namespace_neutral.py",
    text: ["rust-crucible.py", ":", "2413"].join(""),
    reason:
      "the AC2 verbatim quote from CR-CRU-097's own spec (`docs/changes/CR-CRU-097-project-" +
      "independence-is-not-asserted.md`), which names the fifth client's file and line INSIDE the " +
      "quoted sentence itself, exactly as the spec's own AC2 text does; a GREEN agent dropped the " +
      "line number while rewriting this file's OTHER, non-quoted citations, breaking the quote's " +
      "fidelity, and it is restored verbatim rather than left broken -- the same record-not-pointer " +
      "reasoning `docs/changes/` is carved out for entirely, since a verbatim quote of that record is " +
      "that record, wherever it is copied to.",
  },
];

function listAllRepoFiles(): string[] {
  const out: string[] = [];
  // See the PATH RESOLUTION note in the file header: dependency/VCS trees
  // plus a project's own regenerated build/tooling output, none of it ever
  // this project's authored prose, none of it ever a candidate to resolve a
  // citation against.
  const skipDirNames = new Set([
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "coverage",
    "test-reports",
    ".features-gen",
  ]);
  const walk = (absDir: string, relDir: string) => {
    for (const entry of readdirSync(absDir)) {
      if (skipDirNames.has(entry)) continue;
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      // The vendored third-party bundle: not this project's prose.
      if (relPath === "public/vendor") continue;
      const absPath = join(absDir, entry);
      const st = statSync(absPath);
      if (st.isDirectory()) walk(absPath, relPath);
      else out.push(relPath);
    }
  };
  walk(REPO_ROOT, "");
  return out;
}

function realRepo(allRelPaths: readonly string[]): RepoAccess {
  return {
    resolve: (ref) => resolveSourcePath(ref, allRelPaths),
    read: (relPath) => readFileSync(join(REPO_ROOT, relPath), "utf8"),
  };
}

function inScope(relPath: string): boolean {
  return IN_SCOPE_TREES.some((tree) => relPath === tree || relPath.startsWith(`${tree}/`));
}

describe("scope carve-outs (§S4/§S5)", () => {
  test("path resolution ignores .venv/, so a bare client filename resolves uniquely despite the pip-installed copy", () => {
    const allRelPaths = listAllRepoFiles();
    expect(allRelPaths.some((p) => p === ".venv" || p.startsWith(".venv/"))).toBe(false);
    expect(allRelPaths.some((p) => p === "coverage" || p.startsWith("coverage/"))).toBe(false);
    expect(allRelPaths.some((p) => p === "test-reports" || p.startsWith("test-reports/"))).toBe(false);
    expect(allRelPaths.some((p) => p === ".features-gen" || p.startsWith(".features-gen/"))).toBe(false);
    expect(resolveSourcePath("rust-crucible.py", allRelPaths)).toEqual({
      path: "clients/rust-crucible.py",
      ambiguous: false,
    });
  });

  test("a file with no declared out-of-scope range is returned unchanged by the blanking step", () => {
    const text = ["one", "two", "three", "four", "five"].join("\n");
    expect(withOutOfScopeRangesBlanked("fixtures/unranged.ts", text)).toBe(text);
  });

  test("every declared out-of-scope range for the tripwire file holds no live code — comments and blank lines only", () => {
    const relPath = "tests/project-namespace-tripwire.test.ts";
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const ranges = resolveOutOfScopeRanges(text, OUT_OF_SCOPE_RANGES[relPath]!);
    const lines = text.split("\n");
    const nonCommentLines: string[] = [];
    for (const [startLine, endLine] of ranges) {
      for (let ln = startLine; ln <= endLine; ln++) {
        const t = (lines[ln - 1] ?? "").trim();
        if (t.length > 0 && !t.startsWith("//")) nonCommentLines.push(`${ln}: ${t}`);
      }
    }
    expect(nonCommentLines).toEqual([]);
  });

  test("each declared out-of-scope marker resolves to exactly one occurrence in the real file it is declared for", () => {
    const relPath = "tests/project-namespace-tripwire.test.ts";
    const declared = OUT_OF_SCOPE_RANGES[relPath]!;
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    let ranges: [number, number][] = [];
    expect(() => {
      ranges = resolveOutOfScopeRanges(text, declared);
    }).not.toThrow();
    expect(ranges).toHaveLength(declared.length);
  });

  test("a start or end marker that occurs ZERO times fails loudly, rather than silently dropping the exemption", () => {
    const declared: OutOfScopeRange[] = [
      {
        startMarker: ["a phrase that appears ", "nowhere in this sample"].join(""),
        endMarker: "const SAMPLE_DECL",
        reason: "synthetic — proves the fail-loud path",
      },
    ];
    const text = "const SAMPLE_DECL = 1;\n";
    expect(() => resolveOutOfScopeRanges(text, declared)).toThrow();
  });

  test("a start or end marker that occurs MORE THAN ONCE fails loudly, rather than silently guessing which one", () => {
    const declared: OutOfScopeRange[] = [
      {
        startMarker: "REPEATED MARKER",
        endMarker: "const SAMPLE_DECL",
        reason: "synthetic — proves the fail-loud path",
      },
    ];
    const text = "REPEATED MARKER\nsome unrelated line\nREPEATED MARKER\nconst SAMPLE_DECL = 1;\n";
    expect(() => resolveOutOfScopeRanges(text, declared)).toThrow();
  });

  test("no in-scope file is 10,000 lines or longer, so the bare-line implausible-number cutoff never mistakes a real line for noise", () => {
    const allRelPaths = listAllRepoFiles();
    const scannedFiles = allRelPaths.filter((p) => inScope(p) && SCANNED_EXTENSIONS.includes(extname(p)));
    const tooLong = scannedFiles
      .map((p) => ({ file: p, lines: readFileSync(join(REPO_ROOT, p), "utf8").split("\n").length }))
      .filter((f) => f.lines >= BARE_LINE_IMPLAUSIBLE_THRESHOLD);
    expect(tooLong).toEqual([]);
  });

  test("the repository has no top-level tmp/ directory, so the tmp/-root carve-out can never quietly hide a real citation", () => {
    const allRelPaths = listAllRepoFiles();
    expect(allRelPaths.some((p) => p === "tmp" || p.startsWith("tmp/"))).toBe(false);
  });

  test("proves the range carve-out on SYNTHETIC text: a dated note inside a content-anchored range is blanked before the checker ever sees it, while an undated cite outside the range stays reportable", () => {
    // Stands in for the tripwire file's own out-of-scope ranges (§S4's
    // carve-out), but on invented text this file fully controls, so the
    // property survives the day the tripwire's own two undated citations
    // are finally rewritten (as they now have been) instead of pinning to
    // whatever the real file happens to still contain.
    const relPath = "fixtures/synthetic-tripwire.test.ts";
    const undatedCite = ["fixtures/undated", ".ts", ":", "9"].join("");
    const datedCite = ["fixtures/dated", ".ts", ":", "5"].join("");
    const text = [
      `// RULED, NOT CODED: ordinary design-rationale prose, undated, citing ${undatedCite} directly.`,
      `// dated note (cycle 1). Adds a synthetic allow-list entry, citing ${datedCite} for provenance.`,
      "const STABLE_DECL = 1;",
    ].join("\n");
    const declared: OutOfScopeRange[] = [
      {
        startMarker: "dated note (cycle 1).",
        endMarker: "const STABLE_DECL",
        reason: "synthetic \u2014 stands in for one of the tripwire file's own dated-note ranges",
      },
    ];

    // Without the carve-out, BOTH cites fire — proving the range is doing
    // real work rather than the property holding vacuously.
    const rawViolations = findCitationViolations(relPath, text, fakeRepo({}), []);
    expect(rawViolations).toHaveLength(2);

    const ranges = resolveOutOfScopeRanges(text, declared);
    const blankedText = blankRanges(text, ranges);
    const violations = findCitationViolations(relPath, blankedText, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: relPath,
        cite: undatedCite,
        reason: "path:line citation into a source file (must cite by symbol, never by line)",
      },
    ]);
  });
});

test("the in-scope trees carry no path:line citation, no bare line reference, no citation of a missing file, and no citation of an identifier absent from its file", () => {
  const allRelPaths = listAllRepoFiles();
  const repo = realRepo(allRelPaths);
  const scannedFiles = allRelPaths.filter((p) => inScope(p) && SCANNED_EXTENSIONS.includes(extname(p))).sort();

  const violations: Violation[] = [];
  for (const relPath of scannedFiles) {
    const text = withOutOfScopeRangesBlanked(relPath, readFileSync(join(REPO_ROOT, relPath), "utf8"));
    violations.push(...findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES));
  }
  violations.sort((a, b) => a.citingFile.localeCompare(b.citingFile) || a.cite.localeCompare(b.cite));

  // The worklist GREEN rewrites from, one entry per line, so a failure here
  // prints exactly what needs to change and nothing else.
  const worklist = violations.map((v) => `${v.citingFile} \u00b7 ${v.cite} \u00b7 ${v.reason}`);
  expect(worklist).toEqual([]);
});
