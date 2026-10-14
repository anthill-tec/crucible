// The gate measures the code only. No test may construct the live
// `data/crucible.db` path and then COPY it, BACK IT UP (`sqlite3 .backup`,
// readonly or not) or OPEN it directly — not even behind an existsSync
// skip-guard. This file is the guard: it scans every test source file's
// LIVE code (comments blanked, strings kept — a file is free to NAME the
// path in prose without tripping this) for the live-store path being built
// from this checkout's own root (`process.cwd()` or `import.meta.dir`) and
// joined to `data/crucible.db`, then classifies every place that built
// identifier is handed to `copyFileSync`, to a `sqlite3 … .backup` command,
// or to `new Database(...)` / `Store.open(...)`.
//
// ── What it finds today, measured against this tree ──────────────────────
//
// Eight files build the live-store path and touch it this way:
//   copies:    commit-boundary-migrates-to-stored-columns.test.ts,
//              plan-reads-answer-byte-identically-dev-store-copy.test.ts,
//              release-live-total-matches-dev-store-queue.test.ts
//   backs up:  store-migration.test.ts, run-lifecycle.test.ts,
//              milestone-dates-migration.test.ts,
//              milestone-type-is-definable.test.ts,
//              release-unification-migration.test.ts
// A ninth file, commit-boundary-derivation.test.ts, was named alongside
// these in the problem write-up, but it builds no live-store path and calls
// neither form: its only connection to the live store is a comment stating
// that two fixture constants were measured ONCE, by hand, from a replica —
// the numbers are hard-coded and the file runs entirely against `:memory:`
// and mkdtemp scratch stores. This guard does not — and structurally cannot
// honestly — flag prose about a past, offline measurement as a present,
// executable access; it is not a tenth form to invent, and inventing one
// would make the guard fire on files that do nothing the gate needs to
// forbid. (Reported separately: it needs no fixture replacement.)
//
// ── Safety ─────────────────────────────────────────────────────────────────
// This file never builds the live-store path itself and never touches
// `data/crucible.db`. The three planted-violation fixtures below are
// written to an mkdtemp directory OUTSIDE `tests/`, as TEXT this guard's own
// scanner is handed directly — nothing plants a file bun's own runner would
// ever collect, and nothing here shells out to `sqlite3` or opens a
// `Database`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { jsInertSpans, listFiles, REPO_ROOT } from "./helpers/source-scan.ts";

/** This guard's own file name, excluded from the real-tree scan below — not
 *  because it is allowed to violate the rule, but because its planted-fixture
 *  TEXT (below) necessarily contains the very patterns it scans for, as data
 *  handed to the scanner rather than as code this file executes. */
const GUARD_FILE_BASENAME = "no-gate-test-reads-live-data.test.ts";

/** `text` with every comment run blanked (byte-for-byte offsets preserved)
 *  and every string literal's PROSE left standing — the mirror image of
 *  `jsLiveCode`, needed here because the pattern this guard hunts for lives
 *  inside string-literal arguments (`"data"`, `"crucible.db"`, `"sqlite3"`),
 *  which `jsLiveCode` would blank along with the comments. */
function blankCommentsOnly(text: string): string {
  const spans = jsInertSpans(text).filter((span) => span.kind !== "string");
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += text.slice(span.start, span.end).replace(/[^\n]/g, " ");
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Finds every `const NAME = join(process.cwd(), "data", "crucible.db")` (or
 * `path.join(import.meta.dir, "..", "data", "crucible.db")`, or the single
 * literal `"data/crucible.db"` in either base) declaration — the live-store
 * path, built from THIS CHECKOUT'S OWN ROOT, under whatever name a file gave
 * it. Deliberately narrow: a `join(someScratchDir, "data", "crucible.db")`
 * built under an unrelated fixture directory (several resolver tests do
 * exactly this, on purpose, to test resolution itself) is NOT the live
 * store and must not be flagged — only `process.cwd()`/`import.meta.dir`
 * name this checkout's own root.
 */
const LIVE_PATH_DECL =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+)?\s*=\s*(?:path\.)?join\(\s*(?:process\.cwd\(\)|import\.meta\.dir)\s*(?:,\s*["']\.\.["']\s*)*,\s*(?:["']data["']\s*,\s*["']crucible\.db["']|["']data\/crucible\.db["'])\s*\)\s*;/g;

function copyFormDetected(liveCode: string, name: string): boolean {
  return new RegExp(`\\bcopyFileSync\\(\\s*${name}\\b`).test(liveCode);
}

function openFormDetected(liveCode: string, name: string): boolean {
  return new RegExp(`(?:\\bnew\\s+Database\\(|\\bStore\\.open\\()\\s*${name}\\b`).test(liveCode);
}

/** `sqlite3 … .backup`, readonly or not: the identifier and `.backup` both
 *  land within the SAME command array, which always starts with the literal
 *  `"sqlite3"` — so every occurrence of that literal anchors the window this
 *  checks, rather than windowing around the identifier (which a file may use
 *  many times for unrelated reasons, e.g. `existsSync`/`statSync`). */
function backupFormDetected(liveCode: string, name: string): boolean {
  const nameRe = new RegExp(`\\b${name}\\b`);
  const sqliteLiteral = /["']sqlite3["']/g;
  let hit: RegExpExecArray | null;
  while ((hit = sqliteLiteral.exec(liveCode))) {
    const window = liveCode.slice(hit.index, hit.index + 300);
    if (nameRe.test(window) && window.includes(".backup")) return true;
  }
  return false;
}

/** The forms (sorted, deduplicated) found in one file's text: a subset of
 *  `["backs up", "copies", "opens"]`, empty when the file never builds the
 *  live-store path from this checkout's own root. */
function scanLiveStoreAccess(text: string): string[] {
  const liveCode = blankCommentsOnly(text);
  const names = new Set<string>();
  LIVE_PATH_DECL.lastIndex = 0;
  let decl: RegExpExecArray | null;
  while ((decl = LIVE_PATH_DECL.exec(liveCode))) names.add(decl[1]!);

  const forms = new Set<string>();
  for (const name of names) {
    if (copyFormDetected(liveCode, name)) forms.add("copies");
    if (backupFormDetected(liveCode, name)) forms.add("backs up");
    if (openFormDetected(liveCode, name)) forms.add("opens");
  }
  return [...forms].sort();
}

function realTreeViolations(): Array<{ file: string; forms: string[] }> {
  const out: Array<{ file: string; forms: string[] }> = [];
  for (const abs of listFiles("tests", [".ts"])) {
    const rel = relative(REPO_ROOT, abs);
    if (rel.endsWith(GUARD_FILE_BASENAME)) continue;
    const forms = scanLiveStoreAccess(readFileSync(abs, "utf8"));
    if (forms.length > 0) out.push({ file: rel, forms });
  }
  return out.sort((left, right) => left.file.localeCompare(right.file));
}

describe("no gate test reads live data: the guard allows none", () => {
  test("every test file that builds the live data/crucible.db path from this checkout's own root and touches it (copies, backs up or opens) is found and named, by file and by form", () => {
    expect(realTreeViolations()).toEqual([]);
  });

  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function plantFixtureText(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "live-store-guard-"));
    scratchDirs.push(dir);
    const file = join(dir, "planted.test.ts");
    writeFileSync(file, source, "utf8");
    return readFileSync(file, "utf8");
  }

  test("a planted copyFileSync of the live store is caught as the COPY form", () => {
    const planted = plantFixtureText(
      [
        'import { copyFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const live = join(process.cwd(), "data", "crucible.db");',
        'copyFileSync(live, "/tmp/live-store-guard-out.db");',
      ].join("\n"),
    );
    expect(scanLiveStoreAccess(planted)).toEqual(["copies"]);
  });

  test("a planted sqlite3 .backup of the live store is caught as the BACKUP form, both readonly and not", () => {
    const readonly = plantFixtureText(
      [
        'import { join } from "node:path";',
        'const live = join(process.cwd(), "data", "crucible.db");',
        "const taken = Bun.spawnSync([\"sqlite3\", \"-readonly\", live, `.backup '/tmp/live-store-guard-ro.db'`]);",
      ].join("\n"),
    );
    const notReadonly = plantFixtureText(
      [
        'import { join } from "node:path";',
        'const live = join(process.cwd(), "data", "crucible.db");',
        "const taken = Bun.spawnSync({ cmd: [\"sqlite3\", live, `.backup '/tmp/live-store-guard-rw.db'`] });",
      ].join("\n"),
    );
    expect(scanLiveStoreAccess(readonly)).toEqual(["backs up"]);
    expect(scanLiveStoreAccess(notReadonly)).toEqual(["backs up"]);
  });

  test("a planted direct open of the live store is caught as the OPEN form, via new Database() and via Store.open()", () => {
    const viaDatabase = plantFixtureText(
      [
        'import { Database } from "bun:sqlite";',
        'import { join } from "node:path";',
        'const live = join(process.cwd(), "data", "crucible.db");',
        "const db = new Database(live);",
      ].join("\n"),
    );
    const viaStoreOpen = plantFixtureText(
      [
        'import { Store } from "../src/store.ts";',
        'import { join } from "node:path";',
        'const live = join(process.cwd(), "data", "crucible.db");',
        "const store = Store.open(live);",
      ].join("\n"),
    );
    expect(scanLiveStoreAccess(viaDatabase)).toEqual(["opens"]);
    expect(scanLiveStoreAccess(viaStoreOpen)).toEqual(["opens"]);
  });

  test("a file that only NAMES data/crucible.db in prose, never building the path from this checkout's own root, is not flagged (no false positive)", () => {
    const planted = plantFixtureText(
      [
        "// This suite never touches data/crucible.db; see the one case that does.",
        'export const NOTE = "data/crucible.db is never opened here";',
      ].join("\n"),
    );
    expect(scanLiveStoreAccess(planted)).toEqual([]);
  });

  test("a join(scratchDir, \"data\", \"crucible.db\") built under an UNRELATED fixture directory (not this checkout's own root) is not flagged — several resolver suites build exactly this path on purpose", () => {
    const planted = plantFixtureText(
      [
        'import { join } from "node:path";',
        'const explicitCwd = "/tmp/some-fixture-root";',
        'const fakeLiveLooking = join(explicitCwd, "data", "crucible.db");',
        "console.log(fakeLiveLooking);",
      ].join("\n"),
    );
    expect(scanLiveStoreAccess(planted)).toEqual([]);
  });
});
