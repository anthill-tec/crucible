// bun's console is read by ONE rule, shared by the record and the live view
// (CR-CRU-201 §S3, AC3 "the shared reader"):
//  - the marriage (CR-CRU-088's rule, today `parseBunConsoleFailures`' line
//    loop) becomes one exported, resumable reader in
//    src/codecs/bun-console.ts, and the load-error reading
//    (`parseBunLoadErrors`' loop) is shared the same way;
//  - both callers — the JUnit raw-output reading (src/codecs/junit.ts) and
//    the `bun-console` view codec's module — import both readers from
//    ./bun-console.ts as values and call them;
//  - the whole-text readings that stay in src/codecs/bun-console.ts are built
//    on the readers, and neither caller holds a copy of the rule (the
//    `(fail)` result-line pattern, the pass/skip/todo glyphs, or the
//    unhandled-error marker).
//
// The check is proved on synthetic sources both ways before it is run on the
// real ones. Comments never count; an import of types only is no import.
//
// INTERFACE CHOICES (named here for the ruling):
//  - the resumable marriage reader is exported as `BunConsoleFailureReader`,
//    the resumable load-error reader as `BunLoadErrorReader` (a class or a
//    factory: the check only needs the names exported, imported and used);
//  - the view codec lives in its own module, src/codecs/bun-console-view.ts.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { balancedEnd, jsLiveCode, jsUncommented } from "./helpers/source-scan.ts";

const REPO = join(import.meta.dir, "..");
const BUN_CONSOLE_SOURCE = join(REPO, "src", "codecs", "bun-console.ts");
const JUNIT_SOURCE = join(REPO, "src", "codecs", "junit.ts");
const VIEW_CODEC_SOURCE = join(REPO, "src", "codecs", "bun-console-view.ts");

/** Each shared reader, and the whole-text reading in bun-console.ts that must be built on it. */
const READERS = [
  { reader: "BunConsoleFailureReader", wholeText: "parseBunConsoleFailures" },
  { reader: "BunLoadErrorReader", wholeText: "parseBunLoadErrors" },
] as const;

/** What a copy of the rule looks like in a caller's code (comments stripped, strings kept). */
const COPIES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "the (fail) result-line pattern", pattern: /\(fail\\*\)/ },
  { what: "the pass/skip/todo glyphs", pattern: /[✓»✎]/ },
  { what: "the unhandled-error marker", pattern: /Unhandled error between tests/ },
];

function exportsName(live: string, name: string): boolean {
  return (
    new RegExp(`\\bexport\\s+(?:class|function|const|let)\\s+${name}\\b`).test(live) ||
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(live)
  );
}

/** The body of `function <name>` in live code, or undefined when it is not declared. */
function functionBody(live: string, name: string): string | undefined {
  const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(live);
  if (declared === null) return undefined;
  const paramsEnd = balancedEnd(live, declared.index + declared[0].length - 1);
  const open = live.indexOf("{", paramsEnd);
  return open === -1 ? undefined : live.slice(open, balancedEnd(live, open));
}

/** Value imports from "./bun-console.ts": imported name → local name. */
function bunConsoleImports(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of jsUncommented(source).matchAll(
    /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'])\.\/bun-console(?:\.ts)?\3/g,
  )) {
    if (m[1] !== undefined) continue;
    for (const part of (m[2] ?? "").split(",")) {
      const spec = part.trim();
      if (spec.length === 0 || spec.startsWith("type ")) continue;
      const [imported, local] = spec.split(/\s+as\s+/);
      if (imported !== undefined) found.set(imported.trim(), (local ?? imported).trim());
    }
  }
  return found;
}

/** What a caller (junit.ts or the view codec module) breaks: an unimported or unused reader, or a copy of the rule. */
function callerViolations(label: string, source: string): string[] {
  const violations: string[] = [];
  const imported = bunConsoleImports(source);
  const live = jsLiveCode(source).replace(/\bimport\b[^;]*;/g, "");
  for (const { reader } of READERS) {
    const local = imported.get(reader);
    if (local === undefined) violations.push(`${label} does not import ${reader} from ./bun-console.ts`);
    else if (!new RegExp(`\\b${local}\\b`).test(live)) violations.push(`${label} does not use ${reader}`);
  }
  const code = jsUncommented(source);
  for (const { what, pattern } of COPIES) {
    if (pattern.test(code)) violations.push(`${label} holds a copy of ${what}`);
  }
  return violations;
}

/**
 * What the three sources break of the shared reading: bun-console.ts exports
 * both readers and builds its whole-text readings on them; junit.ts and the
 * view codec module each import and use both, and copy nothing.
 */
function sharedReaderViolations(sources: { bunConsole: string; junit: string; viewCodec: string | null }): string[] {
  const violations: string[] = [];
  const live = jsLiveCode(sources.bunConsole);
  for (const { reader, wholeText } of READERS) {
    if (!exportsName(live, reader)) violations.push(`bun-console.ts does not export ${reader}`);
    const body = functionBody(live, wholeText);
    if (body !== undefined && !new RegExp(`\\b${reader}\\b`).test(body)) {
      violations.push(`${wholeText} is not built on ${reader}`);
    }
  }
  violations.push(...callerViolations("junit.ts", sources.junit));
  if (sources.viewCodec === null) violations.push("the view codec module does not exist");
  else violations.push(...callerViolations("bun-console-view.ts", sources.viewCodec));
  return violations;
}

// ── Synthetic sources ───────────────────────────────────────────────────────

const SYNTHETIC_BUN_CONSOLE_SHARED = `
const FAIL_LINE = /^(?:✗|\\(fail\\))\\s+(?<name>.*)$/;
const UNHANDLED_MARKER = "# Unhandled error between tests";
export class BunConsoleFailureReader {
  read(line: string) { return FAIL_LINE.exec(line); }
}
export class BunLoadErrorReader {
  read(line: string) { return line === UNHANDLED_MARKER; }
}
export function parseBunConsoleFailures(text: string) {
  const reader = new BunConsoleFailureReader();
  return text.split("\\n").map((line) => reader.read(line));
}
export function parseBunLoadErrors(text: string) {
  const reader = new BunLoadErrorReader();
  return text.split("\\n").map((line) => reader.read(line));
}
`;

const SYNTHETIC_JUNIT_SHARED = `
import { BunConsoleFailureReader, BunLoadErrorReader as LoadReader } from "./bun-console.ts";
// a comment naming (fail) lines and # Unhandled error between tests never counts
export function readJunitRawOutput(tree, raw: string) {
  const marriage = new BunConsoleFailureReader();
  const loads = new LoadReader();
  for (const line of raw.split("\\n")) { marriage.read(line); loads.read(line); }
  return [];
}
`;

const SYNTHETIC_VIEW_SHARED = `
import type { RunLiveFailure } from "../types.ts";
import { BunConsoleFailureReader, BunLoadErrorReader } from "./bun-console.ts";
export const bunConsoleView = {
  name: "bun-console",
  fill(text: string, offset: number, readerState: string | null, live) {
    const marriage = new BunConsoleFailureReader();
    const loads = new BunLoadErrorReader();
    return { offset, readerState };
  },
};
`;

const SYNTHETIC_BUN_CONSOLE_COPIED = `
export class BunConsoleFailureReader {
  read(line: string) { return line; }
}
export function parseBunConsoleFailures(text: string) {
  const FAIL_LINE = /^(?:✗|\\(fail\\))\\s+(?<name>.*)$/;
  return text.split("\\n").filter((line) => FAIL_LINE.test(line));
}
export function parseBunLoadErrors(text: string) {
  return text.includes("# Unhandled error between tests");
}
`;

const SYNTHETIC_JUNIT_COPIED = `
import { parseBunConsoleFailures, parseBunLoadErrors } from "./bun-console.ts";
export function readJunitRawOutput(tree, raw: string) {
  parseBunConsoleFailures(raw);
  return Object.keys(parseBunLoadErrors(raw));
}
`;

const SYNTHETIC_VIEW_COPIED = `
import type { BunLoadErrorReader } from "./bun-console.ts";
import { BunConsoleFailureReader } from "./bun-console.ts";
const RESULT = /^(?:[✓»✎]|\\((?:pass|skip|todo)\\))\\s/;
export const bunConsoleView = {
  name: "bun-console",
  fill(text: string) {
    const reader = new BunConsoleFailureReader();
    return text.split("\\n").filter((line) => RESULT.test(line) || reader.read(line));
  },
};
`;

describe("a source check holds that the marriage and load-error readers are shared, never copied", () => {
  test("proved on synthetic sources that share both readers: no violation, an aliased import and a comment naming the rule included", () => {
    expect(
      sharedReaderViolations({
        bunConsole: SYNTHETIC_BUN_CONSOLE_SHARED,
        junit: SYNTHETIC_JUNIT_SHARED,
        viewCodec: SYNTHETIC_VIEW_SHARED,
      }),
    ).toEqual([]);
  });

  test("proved on synthetic sources that copy the rule: every missing export, unbuilt reading, unimported reader and copy is caught", () => {
    expect(
      sharedReaderViolations({
        bunConsole: SYNTHETIC_BUN_CONSOLE_COPIED,
        junit: SYNTHETIC_JUNIT_COPIED,
        viewCodec: SYNTHETIC_VIEW_COPIED,
      }),
    ).toEqual([
      "parseBunConsoleFailures is not built on BunConsoleFailureReader",
      "bun-console.ts does not export BunLoadErrorReader",
      "parseBunLoadErrors is not built on BunLoadErrorReader",
      "junit.ts does not import BunConsoleFailureReader from ./bun-console.ts",
      "junit.ts does not import BunLoadErrorReader from ./bun-console.ts",
      "bun-console-view.ts does not import BunLoadErrorReader from ./bun-console.ts",
      "bun-console-view.ts holds a copy of the pass/skip/todo glyphs",
    ]);
  });

  test("proved on a missing view codec module: it is named as missing", () => {
    expect(
      sharedReaderViolations({ bunConsole: SYNTHETIC_BUN_CONSOLE_SHARED, junit: SYNTHETIC_JUNIT_SHARED, viewCodec: null }),
    ).toEqual(["the view codec module does not exist"]);
  });

  test("src/codecs/bun-console.ts exports both readers and builds on them; junit.ts and bun-console-view.ts import and use both and copy nothing", () => {
    expect(existsSync(VIEW_CODEC_SOURCE), `${VIEW_CODEC_SOURCE} — the bun-console view codec module`).toBe(true);
    const violations = sharedReaderViolations({
      bunConsole: readFileSync(BUN_CONSOLE_SOURCE, "utf8"),
      junit: readFileSync(JUNIT_SOURCE, "utf8"),
      viewCodec: existsSync(VIEW_CODEC_SOURCE) ? readFileSync(VIEW_CODEC_SOURCE, "utf8") : null,
    });
    expect(violations).toEqual([]);
  });
});
