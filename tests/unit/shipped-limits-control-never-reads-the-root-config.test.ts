// The shipped-limits control reads SHIPPED data only, never the repo root's
// operator `crucible.toml` (CR-CRU-260, the cardinal test rule).
//
// `tests/integration/shipped-limits-ship-as-package-data.test.ts` proves its matchers on
// the checkout's own limit data files before it scans `src/` and `clients/`.
// It finds those files through `CANDIDATE_DATA_FILES`, a list of paths it
// joins to the repo root and reads when they exist. The repo root's
// `crucible.toml` is the operator's git-ignored configuration (it names the
// development board), so a test that lists it reads operator state whenever
// it is present: a fresh clone and the operator's checkout run different
// tests. The data the control is about is shipped data: the client's
// `clients/crucible.toml` (reached through the test install helper's
// `CLIENT_SOURCE_DIR`) and the packages' copies.
//
// The list is file-local to that module, so this pin reads the module's
// source and evaluates the list's entries the way the module does: string
// literals, `join`/`resolve`/`relative` over them, and the module's own
// constants (`CLIENT_TREE`), with `REPO_ROOT` and `CLIENT_SOURCE_DIR` bound to
// their real values. The evaluator is proved on planted lists first.
//
// Tier: unit. It reads one source file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CLIENT_SOURCE_DIR } from "../helpers/test-install.ts";
import { balancedEnd, jsUncommented, REPO_ROOT } from "../helpers/source-scan.ts";

const SHIPPED_LIMITS_MODULE = path.join("tests", "integration", "shipped-limits-ship-as-package-data.test.ts");
const LIST_NAME = "CANDIDATE_DATA_FILES";

/** The operator's configuration: never a file a test reads. */
const ROOT_CONFIG = path.join(REPO_ROOT, "crucible.toml");

/** The trees whose `crucible.toml` is shipped data: the client fleet, the
 *  server package, and the python package. */
const SHIPPED_TREES = [CLIENT_SOURCE_DIR, path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "crucible_axi")];

/** Split a bracketed argument or element list at its top-level commas. */
function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? "";
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Evaluate a path expression of the module: literals, path calls, and
 *  constants (looked up in the module's own source). */
function evaluate(expr: string, source: string, seen: Set<string> = new Set()): string {
  const trimmed = expr.trim();
  const literal = /^(["'`])([^"'`$]*)\1$/.exec(trimmed);
  if (literal) return literal[2] ?? "";
  const call = /^(?:path\.)?(join|resolve|relative)\(([\s\S]*)\)$/.exec(trimmed);
  if (call) {
    const args = topLevelItems(call[2] ?? "").map((arg) => evaluate(arg, source, seen));
    if (call[1] === "join") return path.join(...args);
    if (call[1] === "resolve") return path.resolve(...args);
    return path.relative(args[0] ?? "", args[1] ?? "");
  }
  if (trimmed === "REPO_ROOT") return REPO_ROOT;
  if (trimmed === "CLIENT_SOURCE_DIR") return CLIENT_SOURCE_DIR;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && !seen.has(trimmed)) {
    const binding = new RegExp(`\\bconst\\s+${trimmed}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(source);
    if (binding) return evaluate(binding[1] ?? "", source, new Set([...seen, trimmed]));
  }
  throw new Error(`cannot evaluate the data-file path expression \`${trimmed}\``);
}

/** The absolute paths the module's candidate list names, as its reader joins
 *  them to the repo root (an absolute entry stands as it is). */
function candidateDataFiles(source: string): string[] {
  const code = jsUncommented(source);
  const declaration = new RegExp(`\\bconst\\s+${LIST_NAME}\\s*(?::[^=]+)?=\\s*\\[`).exec(code);
  if (declaration === null) throw new Error(`no \`const ${LIST_NAME} = [\` in the module`);
  const open = declaration.index + declaration[0].length - 1;
  const close = balancedEnd(code, open);
  return topLevelItems(code.slice(open + 1, close - 1)).map((entry) => {
    const value = evaluate(entry, code);
    return path.isAbsolute(value) ? path.normalize(value) : path.join(REPO_ROOT, value);
  });
}

function plantedModule(entries: string[]): string {
  return [
    'import { CLIENT_SOURCE_DIR } from "./helpers/test-install.ts";',
    "const CLIENT_TREE = relative(REPO_ROOT, CLIENT_SOURCE_DIR);",
    "// The data files a reader reads.",
    `const ${LIST_NAME} = [`,
    ...entries.map((entry) => `  ${entry},`),
    "];",
  ].join("\n");
}

describe("the shipped-limits control's data-file list — the evaluator, on planted lists", () => {
  test("a bare `crucible.toml` entry names the repo root's operator config", () => {
    expect(candidateDataFiles(plantedModule(['"crucible.toml"']))).toEqual([ROOT_CONFIG]);
  });

  test("a `./crucible.toml` entry and a join on REPO_ROOT name the repo root's operator config too", () => {
    expect(candidateDataFiles(plantedModule(['"./crucible.toml"', 'join(REPO_ROOT, "crucible.toml")']))).toEqual([
      ROOT_CONFIG,
      ROOT_CONFIG,
    ]);
  });

  test("a join on the module's CLIENT_TREE names the client's shipped crucible.toml, not the root's", () => {
    const files = candidateDataFiles(plantedModule(['join(CLIENT_TREE, "crucible.toml")', '"src/crucible.toml"']));
    expect(files).toEqual([path.join(CLIENT_SOURCE_DIR, "crucible.toml"), path.join(REPO_ROOT, "src", "crucible.toml")]);
    expect(files).not.toContain(ROOT_CONFIG);
  });

  test("a commented-out root entry is not an entry", () => {
    expect(candidateDataFiles(plantedModule(['// "crucible.toml"', '"src/crucible.toml"']))).toEqual([
      path.join(REPO_ROOT, "src", "crucible.toml"),
    ]);
  });

  test("an entry it cannot evaluate fails naming the expression, never passes silently", () => {
    expect(() => candidateDataFiles(plantedModule(["somewhereElse()"]))).toThrow(
      "cannot evaluate the data-file path expression `somewhereElse()`",
    );
  });
});

describe("the shipped-limits control reads shipped data only, never the repo root's crucible.toml", () => {
  const source = readFileSync(path.join(REPO_ROOT, SHIPPED_LIMITS_MODULE), "utf8");

  test("its CANDIDATE_DATA_FILES never names the repo root's operator crucible.toml", () => {
    const files = candidateDataFiles(source);
    expect(files.length, "the module's candidate list is empty: the control would scan nothing").toBeGreaterThan(0);
    expect(
      files.filter((file) => file === ROOT_CONFIG),
      `${SHIPPED_LIMITS_MODULE}'s ${LIST_NAME} names the repo root's crucible.toml, the operator's ` +
        "git-ignored configuration. The test then reads operator state whenever that file exists " +
        "(the cardinal test rule). The control's data is shipped data: clients/crucible.toml " +
        "through CLIENT_SOURCE_DIR, and the packages' copies.",
    ).toEqual([]);
  });

  test("its CANDIDATE_DATA_FILES names the client's shipped crucible.toml through CLIENT_SOURCE_DIR", () => {
    expect(candidateDataFiles(source)).toContain(path.join(CLIENT_SOURCE_DIR, "crucible.toml"));
  });

  test("every CANDIDATE_DATA_FILES entry lies inside a shipped tree (clients, src or crucible_axi)", () => {
    const outside = candidateDataFiles(source).filter(
      (file) => !SHIPPED_TREES.some((tree) => file.startsWith(`${tree}${path.sep}`)),
    );
    expect(
      outside.map((file) => path.relative(REPO_ROOT, file)),
      `${SHIPPED_LIMITS_MODULE}'s ${LIST_NAME} names a file outside the shipped trees`,
    ).toEqual([]);
  });
});
