// No test reads the operator's board, and no test process loads the repo
// root's `.env` (AC9).
//
// The repo root's `.env` names the operator's LIVE project and its
// git-ignored `crucible.toml` names the operator's development board. A test
// that reads either is green on the operator's machine and red on a clean
// clone, and a census leg that reads the dev board reports the operator's
// rows, not a fixture's. Three guards over `tests/`, plus the suite's own
// process:
//
//   1. No test reads the repo root's `.env`: no `.env` joined to a repo-derived
//      base (`REPO_ROOT` and its aliases, `import.meta.dir`, `__dirname`,
//      `process.cwd()`), in TypeScript or python, and no relative `.env` read.
//   2. No test resolves a board from the repo root: every `declaredClientBoard`
//      call names its directory, never the repo root, and the helper's
//      signature carries no `REPO_ROOT` default (user ruling 2026-11-15).
//   3. No test-spawned board loads `<cwd>/.env`: every argv that runs
//      `src/server.ts` under bun, in either suite, carries `--no-env-file`
//      (bun 1.4.4 loads `<cwd>/.env` by default; a live check would need a
//      board start, so this is pinned statically).
//   4. The bun suite's own process carries no `CRUCIBLE_PROJECT_KEY`.
//
// Each scan is proved on planted sources, both ways, before it is run over
// the tree. The Playwright e2e suite (`tests/e2e/`) is out of scope (the
// CR's non-goals).
//
// Tier: unit. It reads source files and this process's environment.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { balancedEnd, jsLiveCode, jsUncommented, listFiles } from "./helpers/source-scan.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BOARD_HELPER = "tests/helpers/client-board.ts";

/** A base that names the repo root (or the run's working directory, which is
 *  the repo root for this suite). */
const REPO_BASE =
  "(?:_?(?:REPO_ROOT|REPO|ROOT|REPO_DIR|PROJECT_ROOT|CHECKOUT|CHECKOUT_ROOT|REPOSITORY_ROOT)\\b|" +
  "import\\.meta\\.dirname\\b|import\\.meta\\.dir\\b|__dirname\\b|process\\.cwd\\(\\))";
const DOTDOT = "(?:\\s*,\\s*[\"']\\.\\.[\"'])*";
const DOT_ENV = "[\"']\\.env[\"']";

const TS_DOTENV_READS: Array<[RegExp, string]> = [
  [new RegExp(`(?:path\\.)?(?:join|resolve)\\(\\s*${REPO_BASE}${DOTDOT}\\s*,\\s*${DOT_ENV}\\s*\\)`, "g"), "join(<repo base>, \".env\")"],
  [new RegExp(`\\$\\{\\s*${REPO_BASE}\\s*\\}\\/\\.env\\b`, "g"), "`${<repo base>}/.env`"],
  [new RegExp(`(?:readFileSync|readFile|Bun\\.file|existsSync|openSync)\\(\\s*${DOT_ENV}`, "g"), "a relative \".env\" read"],
];

const PY_DOTENV_READS: Array<[RegExp, string]> = [
  [new RegExp(`${REPO_BASE}\\s*\\/\\s*${DOT_ENV}`, "g"), "<repo base> / \".env\""],
  [new RegExp(`os\\.path\\.join\\(\\s*${REPO_BASE}${DOTDOT}\\s*,\\s*${DOT_ENV}`, "g"), "os.path.join(<repo base>, \".env\")"],
  [new RegExp(`\\bopen\\(\\s*${DOT_ENV}`, "g"), "a relative \".env\" read"],
];

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** A python source with its triple-quoted strings and its comment lines
 *  blanked, newlines kept, so a docstring or a planted sample cannot match. */
function pythonCode(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return text
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blank)
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? blank(line) : line))
    .join("\n");
}

function isPython(relPath: string): boolean {
  return relPath.endsWith(".py");
}

/** `["<line>: <spelling>"]` for each read of the repo root's `.env`. */
function dotenvReads(text: string, relPath: string): string[] {
  const code = isPython(relPath) ? pythonCode(text) : jsUncommented(text);
  const found: string[] = [];
  for (const [pattern, spelling] of isPython(relPath) ? PY_DOTENV_READS : TS_DOTENV_READS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) found.push(`${String(lineOf(code, match.index))}: ${spelling}`);
  }
  return found.sort();
}

/** `["<line>: <why>"]` for each `declaredClientBoard` call that names no
 *  directory or names the repo root. */
function undirectedBoardReads(text: string): string[] {
  const code = jsUncommented(text);
  const live = jsLiveCode(text);
  const found: string[] = [];
  for (const match of code.matchAll(/\bdeclaredClientBoard\s*\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue;
    const open = match.index + match[0].length - 1;
    const close = balancedEnd(live, open);
    const args = code.slice(open + 1, close - 1).trim();
    const line = String(lineOf(code, match.index));
    if (args === "" || args === "undefined") found.push(`${line}: declaredClientBoard() names no directory`);
    else if (new RegExp(`^${REPO_BASE}$`).test(args)) found.push(`${line}: declaredClientBoard(<the repo root>)`);
  }
  return found;
}

/** `["<line>: <argv>"]` for each argv that runs `src/server.ts` under bun
 *  without `--no-env-file`. */
function serverSpawnsWithDotenv(text: string, relPath: string): string[] {
  const code = isPython(relPath) ? pythonCode(text) : jsUncommented(text);
  const found: string[] = [];
  for (const match of code.matchAll(/\[[^[\]]*\]/g)) {
    const list = match[0];
    const runsServer = /["'](?:src\/)?server\.ts["']/.test(list) || /["']src["']\s*(?:,|\/)\s*["']server\.ts["']/.test(list);
    const underBun = /["']run["']/.test(list) || /(?:^|[\s,[])(?:["']bun["']|_?REAL_BUN|bun|BUN)\s*,/.test(list);
    if (!runsServer || !underBun) continue;
    if (list.includes("--no-env-file")) continue;
    found.push(`${String(lineOf(code, match.index))}: ${list.replace(/\s+/g, " ")}`);
  }
  return found;
}

/** Every `.ts` and `.py` source under `tests/`, outside the e2e suite,
 *  repo-relative and sorted. */
function scannedSources(): string[] {
  return listFiles("tests", [".ts", ".py"])
    .map((file) => path.relative(REPO_ROOT, file))
    .filter((relPath) => !relPath.startsWith("tests/e2e/"))
    .sort();
}

function scanTree(scan: (text: string, relPath: string) => string[]): string[] {
  const offenders: string[] = [];
  for (const relPath of scannedSources()) {
    const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    for (const hit of scan(text, relPath)) offenders.push(`${relPath}:${hit}`);
  }
  return offenders;
}

/** Planted samples spell their tell-tale tokens through placeholders, so this
 *  file's own text never matches the scans it proves. */
function planted(lines: string[]): string {
  return lines
    .join("\n")
    .replaceAll("__ENV__", '".env"')
    .replaceAll("__DOTENV__", ".env")
    .replaceAll("__SERVER__", `"${["src", "server.ts"].join("/")}"`)
    .replaceAll("__NOENV__", `"${["--no", "env", "file"].join("-")}"`)
    .replaceAll("__BOARD__", ["declared", "Client", "Board"].join(""));
}

describe("no test reads the repo root's .env — the scan, on planted sources", () => {
  const offending: Record<string, [string, string]> = {
    "TypeScript join on REPO_ROOT": ['const env = readFileSync(join(REPO_ROOT, __ENV__), "utf8");', "tests/x.test.ts"],
    "TypeScript path.join on REPO_ROOT": ['const env = readFileSync(path.join(REPO_ROOT, __ENV__), "utf8");', "tests/x.test.ts"],
    "TypeScript join on import.meta.dir and ..": ['readFileSync(join(import.meta.dir, "..", __ENV__));', "tests/x.test.ts"],
    "TypeScript template on REPO_ROOT": ["const p = `${REPO_ROOT}/__DOTENV__`;", "tests/x.test.ts"],
    "TypeScript relative read": ["const env = readFileSync(__ENV__);", "tests/x.test.ts"],
    "python / on REPO_ROOT": ["env = (REPO_ROOT / __ENV__).read_text()", "tests/client/test_x.py"],
    "python os.path.join on REPO_ROOT": ["env = open(os.path.join(REPO_ROOT, __ENV__)).read()", "tests/client/test_x.py"],
  };
  for (const [spelling, [line, relPath]] of Object.entries(offending)) {
    test(`flags a ${spelling} read exactly once`, () => {
      expect(dotenvReads(planted([line]), relPath)).toHaveLength(1);
    });
  }

  const clean: Record<string, [string, string]> = {
    "TypeScript .env planted in a temp dir": ['writeFileSync(join(dir, __ENV__), "CRUCIBLE_PROJECT_KEY=k\\n");', "tests/x.test.ts"],
    "TypeScript comment naming the root .env": ["// the repo root's .env: join(REPO_ROOT, __ENV__)", "tests/x.test.ts"],
    "python .env planted in a temp dir": ['(Path(tmp) / __ENV__).write_text("CRUCIBLE_PROJECT_KEY=k\\n")', "tests/client/test_x.py"],
    "python docstring naming the root .env": ['"""Never reads REPO_ROOT / __ENV__."""', "tests/client/test_x.py"],
  };
  for (const [use, [line, relPath]] of Object.entries(clean)) {
    test(`passes a ${use}`, () => {
      expect(dotenvReads(planted([line]), relPath)).toEqual([]);
    });
  }
});

describe("no test reads the repo root's .env — the tree", () => {
  test("no source under tests/ reads the repo root's .env", () => {
    expect(scanTree(dotenvReads)).toEqual([]);
  });

  test("the bun suite's own process carries no CRUCIBLE_PROJECT_KEY", () => {
    expect("CRUCIBLE_PROJECT_KEY" in process.env ? "present" : "absent").toBe("absent");
  });
});

describe("no test resolves a board from the repo root — the scan, on planted sources", () => {
  test("flags a call that names no directory, and one that names the repo root", () => {
    const text = planted(["const a = __BOARD__();", "const b = __BOARD__(REPO_ROOT);", "const c = __BOARD__(process.cwd());"]);
    expect(undirectedBoardReads(text)).toEqual([
      "1: declaredClientBoard() names no directory",
      "2: declaredClientBoard(<the repo root>)",
      "3: declaredClientBoard(<the repo root>)",
    ]);
  });

  test("passes a call that names a directory the test owns, and the function's own definition", () => {
    const text = planted([
      "const a = __BOARD__(projectDir);",
      'const b = __BOARD__(join(tmp, "project"));',
      "export function __BOARD__(dir: string): DeclaredBoard {",
      "  return { skip: dir };",
      "}",
      "// __BOARD__() in a comment is prose",
    ]);
    expect(undirectedBoardReads(text)).toEqual([]);
  });
});

describe("no test resolves a board from the repo root — the tree", () => {
  test("every declaredClientBoard call under tests/ names its directory, and never the repo root", () => {
    const offenders = scanTree((text, relPath) => (isPython(relPath) ? [] : undirectedBoardReads(text)));
    expect(offenders).toEqual([]);
  });

  test("declaredClientBoard takes its directory explicitly: its signature has no default", () => {
    const text = jsLiveCode(readFileSync(path.join(REPO_ROOT, BOARD_HELPER), "utf8"));
    const signature = /export\s+function\s+declaredClientBoard\s*\(([^)]*)\)/.exec(text);
    expect(signature === null ? "not found" : "found").toBe("found");
    const params = (signature?.[1] ?? "").replace(/\s+/g, " ").trim();
    expect(params).toBe("dir: string");
  });
});

describe("no test-spawned board loads <cwd>/.env — the scan, on planted sources", () => {
  const offending: Record<string, [string, string]> = {
    "python argv with cwd at the repo root": ['proc = subprocess.Popen([bun, "run", __SERVER__], cwd=str(REPO_ROOT))', "tests/client/test_x.py"],
    "python argv of a named bun": ['subprocess.Popen([_REAL_BUN, "run", __SERVER__], cwd=root)', "tests/client/test_x.py"],
    "TypeScript argv": ['const proc = spawn("bun", ["run", __SERVER__], { cwd: staged });', "tests/x.test.ts"],
    "TypeScript cmd list": ['const proc = run({ cmd: ["bun", "run", __SERVER__], cwd: staged });', "tests/x.test.ts"],
  };
  for (const [spelling, [line, relPath]] of Object.entries(offending)) {
    test(`flags a ${spelling} without the switch, exactly once`, () => {
      expect(serverSpawnsWithDotenv(planted([line]), relPath)).toHaveLength(1);
    });
  }

  const clean: Record<string, [string, string]> = {
    "python argv carrying the switch": ['subprocess.Popen([bun, "run", __NOENV__, __SERVER__], cwd=root)', "tests/client/test_x.py"],
    "TypeScript argv carrying the switch": ['spawn("bun", [__NOENV__, "run", __SERVER__], { cwd: staged });', "tests/x.test.ts"],
    "python list of files that merely names the server": ['SCANNED = [__SERVER__, "src/v2.ts"]', "tests/client/test_x.py"],
    "python docstring quoting an argv": ['"""Starts [bun, "run", __SERVER__] on a free port."""', "tests/client/test_x.py"],
    "TypeScript comment quoting an argv": ['// spawns ["bun", "run", __SERVER__]', "tests/x.test.ts"],
  };
  for (const [use, [line, relPath]] of Object.entries(clean)) {
    test(`passes a ${use}`, () => {
      expect(serverSpawnsWithDotenv(planted([line]), relPath)).toEqual([]);
    });
  }
});

describe("no test-spawned board loads <cwd>/.env — the tree", () => {
  test("every argv under tests/ that runs src/server.ts under bun turns .env loading off", () => {
    expect(scanTree(serverSpawnsWithDotenv)).toEqual([]);
  });
});
