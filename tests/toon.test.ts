// CR-CRU-005 §S1 — TOON subset serializer: `toToon(obj): string` emitting exactly
// four constructs (scalar lines, nested-object indentation, uniform-table arrays,
// list arrays) with JSON-quoting for values/cells containing `\n : , { } [ ]`.
// src/toon.ts does not exist yet — this file is RED via module-resolution failure.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toToon } from "../src/toon.ts";

describe("toToon — scalar lines", () => {
  test("boolean and number scalars join as 'key: value' lines separated by \\n", () => {
    expect(toToon({ ok: true, n: 3 })).toBe("ok: true\nn: 3");
  });

  test("null renders as the literal 'null'; numbers and booleans stay unquoted", () => {
    expect(toToon({ k: null })).toBe("k: null");
    expect(toToon({ n: 42, b: true, f: false })).toBe("n: 42\nb: true\nf: false");
  });
});

describe("toToon — uniform object array (table form)", () => {
  test("a uniform object array renders as name[N]{col1,col2}: + one comma-joined row per item", () => {
    expect(toToon({ events: [{ id: "a", n: 1 }, { id: "b", n: 2 }] })).toBe(
      "events[2]{id,n}:\n  a,1\n  b,2",
    );
  });
});

describe("toToon — string / non-uniform arrays (list form)", () => {
  test("a string array renders as name[N]: + one indented line per item, no {cols} header", () => {
    expect(toToon({ help: ["do x", "see y"] })).toBe("help[2]:\n  do x\n  see y");
  });

  test("an empty array renders as name[0]: with no body lines", () => {
    expect(toToon({ items: [] })).toBe("items[0]:");
  });

  test("a non-uniform object array falls back to indented items, never emitting a {cols} header", () => {
    const result = toToon({ items: [{ a: 1, b: 2 }, { c: 3 }] });
    expect(result).not.toMatch(/items\[\d+\]\{[^}]*\}:/);
    // each item's keys/values must still be present somewhere in the fallback rendering
    expect(result).toContain("a: 1");
    expect(result).toContain("b: 2");
    expect(result).toContain("c: 3");
  });
});

describe("toToon — nested objects", () => {
  test("a nested object indents its own scalar lines by 2 spaces", () => {
    expect(toToon({ a: { b: 1 } })).toBe("a:\n  b: 1");
  });
});

describe("toToon — scalar string quoting", () => {
  test("a comma-containing value round-trips JSON-quoted", () => {
    const result = toToon({ msg: "a,b" });
    expect(result).toBe(`msg: ${JSON.stringify("a,b")}`);
    expect(result).toContain('"a,b"');
  });

  test("a newline-containing value is JSON-quoted", () => {
    const result = toToon({ msg: "a\nb" });
    expect(result).toBe(`msg: ${JSON.stringify("a\nb")}`);
  });

  test("a colon-containing value is JSON-quoted", () => {
    const result = toToon({ msg: "a:b" });
    expect(result).toBe(`msg: ${JSON.stringify("a:b")}`);
  });

  test("a brace-containing value is JSON-quoted", () => {
    const result = toToon({ msg: "a{b}c" });
    expect(result).toBe(`msg: ${JSON.stringify("a{b}c")}`);
  });

  test("a plain string with no special characters is left unquoted", () => {
    expect(toToon({ msg: "hello world" })).toBe("msg: hello world");
  });
});

describe("toToon — table cell quoting", () => {
  test("a table cell containing a comma is JSON-quoted within its row", () => {
    const result = toToon({ events: [{ id: "a,b", n: 1 }] });
    expect(result).toBe(`events[1]{id,n}:\n  ${JSON.stringify("a,b")},1`);
  });

  test("a table cell containing a double quote is JSON-quoted within its row", () => {
    const result = toToon({ events: [{ id: 'a"b', n: 1 }] });
    expect(result).toBe(`events[1]{id,n}:\n  ${JSON.stringify('a"b')},1`);
  });
});

describe("DN wire-spec doc — GREEN's deliverable alongside the serializer", () => {
  test("docs/research/DN-crucible-toon-subset.md exists and documents all four constructs", () => {
    const dnPath = join(import.meta.dir, "../docs/research/DN-crucible-toon-subset.md");
    expect(existsSync(dnPath)).toBe(true);

    const content = readFileSync(dnPath, "utf-8");
    // (1) scalar line: `key: value`
    expect(content).toMatch(/\b\w+:\s+\S+/);
    // (2) nested/indented object: a 2-space-indented `key: value` line
    expect(content).toMatch(/\n {2}\w+:\s+\S+/);
    // (3) uniform table: `name[N]{col1,col2}:`
    expect(content).toMatch(/\w+\[\d+\]\{[\w,]+\}:/);
    // (4) list form: `name[N]:`
    expect(content).toMatch(/\w+\[\d+\]:/);
  });
});
