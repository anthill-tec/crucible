// Every constant the project-namespace tripwire exempts by name still exists
// in the file it exempts (CR-CRU-260 cycle 963, GREEN 962's finding 4).
//
// `tests/project-namespace-tripwire.test.ts` lets a few named constants hold
// real board ids (`EXEMPT_CONSTANTS`: a name, the file it lives in, and a
// reason). An entry whose constant is gone exempts nothing today. But it is a
// standing permission: a constant re-created under that name in that file
// would be exempt with no one having read it. The list must say only what is
// true of the tree.
//
// `EXEMPT_CONSTANTS` is file-local, so this pin reads the tripwire's source,
// takes each entry's name and `file:` (a string literal or a `join` of
// literals), and looks for a definition in that file: the name followed by
// `=` or `:` in live code (comments and string contents blanked), outside the
// exemption list itself. That is what the tripwire's own exempt-span matcher
// keys on. The reader is proved on planted sources first.
//
// Tier: unit. It reads source files.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { balancedEnd, jsLiveCode, jsUncommented, REPO_ROOT } from "./helpers/source-scan.ts";

const TRIPWIRE_MODULE = path.join("tests", "project-namespace-tripwire.test.ts");
const LIST_NAME = "EXEMPT_CONSTANTS";

interface Exemption {
  name: string;
  file: string;
}

/** The `[start, end)` range of the exemption list's object literal. */
function listRange(code: string): [number, number] {
  const declaration = new RegExp(`\\bconst\\s+${LIST_NAME}\\s*(?::[^=]+)?=\\s*\\{`).exec(code);
  if (declaration === null) throw new Error(`no \`const ${LIST_NAME} = {\` in the module`);
  const open = declaration.index + declaration[0].length - 1;
  return [open, balancedEnd(code, open)];
}

/** A `file:` value: a string literal or a `join` of string literals. */
function fileValue(expr: string): string {
  const trimmed = expr.trim();
  const literal = /^(["'`])([^"'`$]*)\1$/.exec(trimmed);
  if (literal) return literal[2] ?? "";
  const call = /^(?:path\.)?join\(([\s\S]*)\)$/.exec(trimmed);
  if (call) {
    const parts = (call[1] ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
    return path.join(...parts.map(fileValue));
  }
  throw new Error(`cannot read the exemption's file expression \`${trimmed}\``);
}

/** The exemption list's entries, in order. */
function exemptions(source: string): Exemption[] {
  const code = jsUncommented(source);
  const live = jsLiveCode(source);
  const [open, close] = listRange(code);
  const found: Exemption[] = [];
  const key = /([A-Za-z_$][\w$]*)\s*:\s*\{/g;
  key.lastIndex = open + 1;
  for (let match = key.exec(live); match !== null && match.index < close; match = key.exec(live)) {
    const braceAt = match.index + match[0].length - 1;
    const entryEnd = balancedEnd(live, braceAt);
    const body = code.slice(braceAt + 1, entryEnd - 1);
    const file = /\bfile\s*:\s*((?:path\.)?join\([^)]*\)|(["'`])[^"'`]*\2)/.exec(body);
    if (file === null) throw new Error(`the exemption \`${match[1] ?? ""}\` names no file`);
    found.push({ name: match[1] ?? "", file: fileValue(file[1] ?? "") });
    key.lastIndex = entryEnd;
  }
  return found;
}

/** Does `text` define `name` in live code (name, then `=` or `:`), outside
 *  the `skip` range? */
function defines(text: string, name: string, skip: [number, number] | null): boolean {
  const live = jsLiveCode(text);
  const definition = new RegExp(`(?:^|[^\\w$.])${name}\\s*(?::|=(?![=>]))`, "g");
  for (const match of live.matchAll(definition)) {
    const at = match.index;
    if (skip !== null && at >= skip[0] && at < skip[1]) continue;
    return true;
  }
  return false;
}

/** The exemptions whose constant the exempted file no longer defines. */
function staleExemptions(
  tripwireRel: string,
  tripwireSource: string,
  readSource: (rel: string) => string,
): string[] {
  const ownRange = listRange(jsUncommented(tripwireSource));
  return exemptions(tripwireSource)
    .filter(({ name, file }) => {
      const own = file === tripwireRel;
      const text = own ? tripwireSource : readSource(file);
      return !defines(text, name, own ? ownRange : null);
    })
    .map(({ name, file }) => `${name} (${file})`);
}

const PLANTED_TRIPWIRE = [
  `const ${LIST_NAME}: Record<string, { file: string; reason: string }> = {`,
  "  KEPT_SNAPSHOT: {",
  '    file: join("tests", "kept.test.ts"),',
  '    reason: "a dated reproduction, " + "still in the file.",',
  "  },",
  "  OWN_FIXTURE: {",
  '    file: join("tests", "tripwire.test.ts"),',
  '    reason: "this file\'s own fixture.",',
  "  },",
  "  GONE_SNAPSHOT: {",
  '    file: "tests/gone.test.ts",',
  '    reason: "its suite was removed.",',
  "  },",
  "};",
  "const OWN_FIXTURE = { ids: [] };",
].join("\n");

const PLANTED_FILES: Record<string, string> = {
  "tests/kept.test.ts": "const KEPT_SNAPSHOT = { rows: [] };\n",
  "tests/gone.test.ts": [
    "// GONE_SNAPSHOT = { rows } went with the live legs.",
    'const note = "GONE_SNAPSHOT: removed";',
  ].join("\n"),
};

function plantedReader(rel: string): string {
  const text = PLANTED_FILES[rel];
  if (text === undefined) throw new Error(`no planted file ${rel}`);
  return text;
}

describe("the tripwire's exemption list — the reader, on a planted tripwire", () => {
  test("reads every entry's name and file, a join or a literal", () => {
    expect(exemptions(PLANTED_TRIPWIRE)).toEqual([
      { name: "KEPT_SNAPSHOT", file: path.join("tests", "kept.test.ts") },
      { name: "OWN_FIXTURE", file: path.join("tests", "tripwire.test.ts") },
      { name: "GONE_SNAPSHOT", file: path.join("tests", "gone.test.ts") },
    ]);
  });

  test("flags exactly the entry whose constant survives only in a comment and a string", () => {
    expect(staleExemptions(path.join("tests", "tripwire.test.ts"), PLANTED_TRIPWIRE, plantedReader)).toEqual([
      "GONE_SNAPSHOT (tests/gone.test.ts)",
    ]);
  });

  test("an entry exempting the tripwire's own constant is stale when only its key in the list remains", () => {
    const withoutFixture = PLANTED_TRIPWIRE.replace("const OWN_FIXTURE = { ids: [] };", "");
    expect(staleExemptions(path.join("tests", "tripwire.test.ts"), withoutFixture, plantedReader)).toEqual([
      "OWN_FIXTURE (tests/tripwire.test.ts)",
      "GONE_SNAPSHOT (tests/gone.test.ts)",
    ]);
  });
});

describe("the project-namespace tripwire exempts only constants that exist", () => {
  const source = readFileSync(path.join(REPO_ROOT, TRIPWIRE_MODULE), "utf8");

  test("every exemption names a file that exists", () => {
    const entries = exemptions(source);
    expect(entries.length, `${TRIPWIRE_MODULE} has no ${LIST_NAME} entries: the pin would check nothing`).toBeGreaterThan(0);
    expect(entries.filter(({ file }) => !existsSync(path.join(REPO_ROOT, file))).map(({ file }) => file)).toEqual([]);
  });

  test("every name in EXEMPT_CONSTANTS is still defined in the file it exempts", () => {
    expect(
      staleExemptions(TRIPWIRE_MODULE, source, (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8")),
      `${TRIPWIRE_MODULE}'s ${LIST_NAME} exempts a constant its file no longer defines. A stale ` +
        "exemption is a standing permission: a constant re-created under that name would hold " +
        "real board ids unread. Remove the entry with the constant.",
    ).toEqual([]);
  });
});
