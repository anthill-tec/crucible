// Citations into source code must name the CONSTRUCT they cite — a function,
// constant, type or selector — never a line number. A line drifts the moment
// the file it points into grows or shrinks; a symbol does not. This file is
// the standing guard: it scans the in-scope trees for exactly the three ways
// a citation goes stale, and it proves each of those three checks fires (and
// that a correct citation does not) before it ever asks the real tree a
// question.
//
// THE THREE DEFECTS, in the order the checker looks for them:
//   1. a `path:line` (or `path:line-line`) citation into a source file —
//      forbidden outright, regardless of whether the line still lands
//      anywhere sensible;
//   2. a citation naming a source path that resolves to no file in the
//      repository;
//   3. a citation naming a backticked identifier that does not occur, as a
//      whole word, in the file it is cited against.
//
// THE CHECKER IS A PURE FUNCTION OVER TEXT (`findCitationViolations`): given
// a file's text and a small `RepoAccess` (resolve a path, read a resolved
// path's content), it returns the violations in that text and touches no
// filesystem itself. The self-tests below hand it an in-memory `RepoAccess`
// built from a literal map, so the three defects and the one non-defect are
// each proven without touching a real file. The tree check at the bottom
// hands the SAME function a real, filesystem-backed `RepoAccess` — one
// function, two worlds.
//
// SCOPE, as a single declared list (`IN_SCOPE_TREES`) rather than scattered
// conditionals, so a later cycle extends coverage by appending one entry —
// this cycle's list stops short of the test tree on purpose. `node_modules`,
// `__pycache__` and the vendored third-party bundle under `public/vendor`
// are never walked: none of them is this project's prose.
//
// PATH RESOLUTION, for a citation that names a bare filename or a partial
// path rather than a full repo-relative one: a path resolves if it matches
// exactly one file in the repository, either by exact repo-relative equality
// or by that file's path ending in `/<the given reference>`. Zero matches is
// "no file that exists" (defect 2); MORE than one match is refused, not
// guessed — an ambiguous reference is reported as unresolved with its own
// reason, because picking one of several candidates silently would hide the
// exact drift this guard exists to catch.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".py", ".sh", ".css", ".html", ".toml"];
const SCANNED_EXTENSIONS = [...SOURCE_EXTENSIONS, ".md"];

// One declared list. Appending "tests" here is the whole diff a later cycle
// needs to widen coverage onto the test tree; `docs/changes` (a spec
// describes the tree it was written against) and the rest of the repository
// stay out by simply never being named.
const IN_SCOPE_TREES = ["src", "public", "clients", "crucible_axi", "scripts", "bin", "docs/research"];

const SOURCE_EXT_ALTERNATION = SOURCE_EXTENSIONS.map((e) => e.slice(1)).join("|");

// Defect 1: a path ending in a source extension, directly followed by a
// colon and one or two dash-joined line numbers, with nothing sitting
// between the extension and the colon.
const PATH_LINE_RE = new RegExp(
  String.raw`[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:${SOURCE_EXT_ALTERNATION}):\d+(?:-\d+)?`,
  "g",
);

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
    if (isExempt(citingFile, cite, exempt)) continue;
    violations.push({
      citingFile,
      cite,
      reason: "path:line citation into a source file (must cite by symbol, never by line)",
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

  return violations;
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
    const text = "The seam is `plantedSymbol` (fixtures/does-not-exist.ts).";
    const violations = findCitationViolations("planted-doc.md", text, fakeRepo({}), []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: "`plantedSymbol` (fixtures/does-not-exist.ts)",
        reason: 'cited path "fixtures/does-not-exist.ts" names no file that exists',
      },
    ]);
  });

  test("fires when the backticked identifier does not occur in its cited file", () => {
    const repo = fakeRepo({ "fixtures/real.ts": "export function actualSymbol() {}\n" });
    const text = "The seam is `missingSymbol` (fixtures/real.ts).";
    const violations = findCitationViolations("planted-doc.md", text, repo, []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: "`missingSymbol` (fixtures/real.ts)",
        reason: "backticked identifier `missingSymbol` does not occur in fixtures/real.ts",
      },
    ]);
  });

  test("does NOT fire on a correct by-symbol citation, parenthesised form", () => {
    const repo = fakeRepo({ "fixtures/real.ts": "export function actualSymbol() {}\n" });
    const text = "The seam is `actualSymbol` (fixtures/real.ts).";
    expect(findCitationViolations("planted-doc.md", text, repo, [])).toEqual([]);
  });

  test("does NOT fire on a correct by-symbol citation, the `in` connective", () => {
    const repo = fakeRepo({ "scripts/release.sh": "plan_merge_map() {\n  :\n}\n" });
    const text = "`plan_merge_map` in `scripts/release.sh` builds the table.";
    expect(findCitationViolations("planted-doc.md", text, repo, [])).toEqual([]);
  });

  test("treats an ambiguous bare-filename cite as unresolved, never guessed", () => {
    const repo = fakeRepo({
      "fixtures/a/shared.ts": "export function sharedSymbol() {}\n",
      "fixtures/b/shared.ts": "export function sharedSymbol() {}\n",
    });
    const text = "The seam is `sharedSymbol` (shared.ts).";
    const violations = findCitationViolations("planted-doc.md", text, repo, []);
    expect(violations).toEqual([
      {
        citingFile: "planted-doc.md",
        cite: "`sharedSymbol` (shared.ts)",
        reason: 'cited path "shared.ts" is ambiguous (matches more than one file)',
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

// ---------------------------------------------------------------------------
// The tree check: the same checker, against the real repository.
// ---------------------------------------------------------------------------

// EXEMPT FIXTURE DATA — strings that only look like citations (test fixture
// bodies, not prose pointing anywhere). Declared, not inferred: each entry
// names its exact citing file, its exact string, and why. None is needed for
// the trees in scope this cycle; the mechanism is proven above and left
// ready for the tree this guard's scope grows onto next.
const EXEMPT_FIXTURES: ExemptFixture[] = [];

function listAllRepoFiles(): string[] {
  const out: string[] = [];
  const skipDirNames = new Set(["node_modules", ".git", "__pycache__"]);
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

test("the in-scope trees carry no path:line citation, no citation of a missing file, and no citation of an identifier absent from its file", () => {
  const allRelPaths = listAllRepoFiles();
  const repo = realRepo(allRelPaths);
  const scannedFiles = allRelPaths.filter((p) => inScope(p) && SCANNED_EXTENSIONS.includes(extname(p))).sort();

  const violations: Violation[] = [];
  for (const relPath of scannedFiles) {
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    violations.push(...findCitationViolations(relPath, text, repo, EXEMPT_FIXTURES));
  }
  violations.sort((a, b) => a.citingFile.localeCompare(b.citingFile) || a.cite.localeCompare(b.cite));

  // The worklist GREEN rewrites from, one entry per line, so a failure here
  // prints exactly what needs to change and nothing else.
  const worklist = violations.map((v) => `${v.citingFile} \u00b7 ${v.cite} \u00b7 ${v.reason}`);
  expect(worklist).toEqual([]);
});
