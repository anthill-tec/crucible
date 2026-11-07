// The dashboard's utility styles are a static stylesheet: nothing generates
// CSS for a class name at run time any more, so a Tailwind utility class
// written into the dashboard's source would silently do nothing. This guard
// fails when the dashboard's source (public/) uses a Tailwind utility class
// that the static stylesheet does not define. The two utilities it does
// define, `start` and `end` (the Roadmap's terminal markers), stay allowed.
//
// How a class is found: the dashboard writes its classes as the `class` prop
// of its VanJS tags, through `classList.add/remove/toggle/replace`, and in
// constants whose name says they hold a class (`LOCATE_BLINK_CLASS`,
// `railClass`). Every string literal inside those expressions is split into
// class tokens; a token built around a `${…}` substitution is only part of a
// name and is skipped. The HTML's own `class="…"` attributes are read too.
//
// How a Tailwind utility is recognised: by Tailwind 4.2.4's own vocabulary,
// read from the runtime's utility registry and committed as
// tests/fixtures/tailwind-4.2.4-utility-vocabulary.json. A token is a utility
// when, after its variants (`hover:`, `md:`…), its important mark (`!`), its
// modifier (`/50`) and its negative sign are stripped, it is a static utility
// name, an arbitrary property (`[color:red]`), a functional root that draws a
// rule on its own (`border`), or a functional root followed by a value
// (`p-4`, `w-[3px]`).
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");
const VENDOR_DIR = path.join(PUBLIC_DIR, "vendor");

interface Vocabulary {
  static: string[];
  functional: string[];
  functionalWithoutValue: string[];
}

const VOCABULARY = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "tailwind-4.2.4-utility-vocabulary.json"), "utf8"),
) as Vocabulary;
const STATIC = new Set(VOCABULARY.static);
const FUNCTIONAL = new Set(VOCABULARY.functional);
const FUNCTIONAL_ALONE = new Set(VOCABULARY.functionalWithoutValue);

/** The utilities the static stylesheet carries by name, allowed whatever the stylesheet parses to. */
const ALLOWED = new Set(["start", "end"]);

/** Split on `sep` outside `[…]` and `(…)`. */
function splitOutside(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function isTailwindUtility(token: string): boolean {
  const parts = splitOutside(token, ":");
  if (parts.some((p) => p === "")) return false;
  let base = parts[parts.length - 1] as string;
  if (base.endsWith("!")) base = base.slice(0, -1);
  else if (base.startsWith("!")) base = base.slice(1);
  if (/^\[[a-zA-Z-]+:.+\]$/.test(base)) return true;
  base = splitOutside(base, "/")[0] as string;
  if (base.startsWith("-")) base = base.slice(1);
  if (base === "") return false;
  if (STATIC.has(base) || FUNCTIONAL_ALONE.has(base)) return true;
  for (let i = base.length - 1; i > 0; i -= 1) {
    if (base[i] === "-" && FUNCTIONAL.has(base.slice(0, i)) && base.slice(i + 1) !== "") return true;
  }
  return false;
}

// ── Reading the dashboard's class names out of its source ────────────────

/** Marks the edge of a `${…}` substitution inside a template literal's text. */
const HOLE = "\u0000";

interface Token {
  kind: "word" | "punct" | "text";
  value: string;
}

/** A small JavaScript tokenizer: words, punctuation and string/template text (comments and regexes dropped). */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const braces: ("block" | "hole")[] = [];
  let i = 0;
  const readTemplate = (afterHole: boolean): void => {
    let text = afterHole ? HOLE : "";
    while (i < src.length) {
      const c = src[i] as string;
      if (c === "\\") {
        text += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        out.push({ kind: "text", value: text });
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        out.push({ kind: "text", value: text + HOLE });
        out.push({ kind: "punct", value: "(" });
        braces.push("hole");
        return;
      }
      text += c;
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let text = "";
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          text += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        text += src[i];
        i += 1;
      }
      i += 1;
      out.push({ kind: "text", value: text });
      continue;
    }
    if (c === "`") {
      i += 1;
      readTemplate(false);
      continue;
    }
    if (c === "{") {
      braces.push("block");
      out.push({ kind: "punct", value: "{" });
      i += 1;
      continue;
    }
    if (c === "}") {
      const closing = braces.pop();
      i += 1;
      if (closing === "hole") {
        out.push({ kind: "punct", value: ")" });
        readTemplate(true);
      } else out.push({ kind: "punct", value: "}" });
      continue;
    }
    if (c === "/") {
      const prev = out[out.length - 1];
      const startsRegex =
        prev === undefined ||
        (prev.kind === "punct" && prev.value !== ")" && prev.value !== "]" && prev.value !== "}") ||
        (prev.kind === "word" && /^(return|typeof|case|in|of|void|delete|new|throw)$/.test(prev.value));
      if (startsRegex) {
        i += 1;
        let inClass = false;
        while (i < src.length) {
          const d = src[i];
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          i += 1;
        }
        i += 1;
        while (/[a-z]/.test(src[i] ?? "")) i += 1;
        out.push({ kind: "text", value: "" });
        continue;
      }
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let word = "";
      while (i < src.length && /[A-Za-z_$0-9]/.test(src[i] as string)) {
        word += src[i];
        i += 1;
      }
      out.push({ kind: "word", value: word });
      continue;
    }
    out.push({ kind: "punct", value: c });
    i += 1;
  }
  return out;
}

/** Every string text from `from` to the end of the expression (a stop token at depth 0, or a closing bracket). */
function textsOfExpression(tokens: Token[], from: number, stops: readonly string[]): string[] {
  const texts: string[] = [];
  let depth = 0;
  for (let j = from; j < tokens.length; j += 1) {
    const t = tokens[j] as Token;
    if (t.kind === "punct") {
      if ("([{".includes(t.value)) depth += 1;
      else if (")]}".includes(t.value)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && stops.includes(t.value)) break;
    } else if (t.kind === "text") texts.push(t.value);
  }
  return texts;
}

/** The class tokens a script writes. */
function scriptClassTokens(src: string): string[] {
  const tokens = tokenize(src);
  const texts: string[] = [];
  for (let j = 0; j < tokens.length; j += 1) {
    const t = tokens[j] as Token;
    const next = tokens[j + 1];
    const isClassKey =
      (t.kind === "word" && (t.value === "class" || t.value === "className")) ||
      (t.kind === "text" && (t.value === "class" || t.value === "className"));
    if (isClassKey && next?.value === ":") {
      texts.push(...textsOfExpression(tokens, j + 2, [","]));
    } else if (
      t.kind === "word" &&
      /^(add|remove|toggle|replace)$/.test(t.value) &&
      tokens[j - 1]?.value === "." &&
      tokens[j - 2]?.value === "classList" &&
      next?.value === "("
    ) {
      texts.push(...textsOfExpression(tokens, j + 2, []));
    } else if (
      t.kind === "word" &&
      /class/i.test(t.value) &&
      next?.value === "=" &&
      tokens[j + 2]?.value !== "=" &&
      /^(const|let|var)$/.test(tokens[j - 1]?.value ?? "")
    ) {
      texts.push(...textsOfExpression(tokens, j + 2, [";"]));
    }
  }
  return texts.flatMap((text) => text.split(/\s+/)).filter((token) => token !== "" && !token.includes(HOLE));
}

/** The class tokens an HTML page writes. */
function htmlClassTokens(src: string): string[] {
  return [...src.matchAll(/\sclass\s*=\s*["']([^"']*)["']/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter((t) => t !== "");
}

/** The class tokens of every source file under public/ (vendored files excluded), by file. */
function dashboardClassTokens(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const name of readdirSync(PUBLIC_DIR)) {
    const file = path.join(PUBLIC_DIR, name);
    if (/\.(m?js)$/.test(name)) byFile.set(name, scriptClassTokens(readFileSync(file, "utf8")));
    else if (/\.html$/.test(name)) byFile.set(name, htmlClassTokens(readFileSync(file, "utf8")));
  }
  return byFile;
}

// ── The static stylesheet's own class names ──────────────────────────────

/** The vendored stylesheet whose header names tailwindcss 4.2.4, or null when there is none. */
function staticTailwindStylesheet(): string | null {
  for (const name of readdirSync(VENDOR_DIR)) {
    if (!name.endsWith(".css")) continue;
    const css = readFileSync(path.join(VENDOR_DIR, name), "utf8");
    const head = css.slice(0, 300);
    if (/tailwindcss/i.test(head) && /4\.2\.4/.test(head)) return css;
  }
  return null;
}

/** Every class a stylesheet's selectors name (CSS escapes undone). */
function classesDefinedBy(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const defined = new Set<string>();
  for (const m of withoutComments.matchAll(/\.((?:[_a-zA-Z-]|\\.)(?:[\w-]|\\.)*)/g)) {
    defined.add((m[1] ?? "").replace(/\\(.)/g, "$1"));
  }
  return defined;
}

/** The Tailwind utilities `byFile` uses that `defined` does not define and that are not allowed by name. */
function undefinedUtilities(byFile: Map<string, string[]>, defined: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const [file, tokens] of byFile) {
    for (const token of new Set(tokens)) {
      if (isTailwindUtility(token) && !defined.has(token) && !ALLOWED.has(token)) found.push(`${file}: ${token}`);
    }
  }
  return found.sort();
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a Tailwind utility class is recognised by Tailwind 4.2.4's own vocabulary", () => {
  test("utility classes are recognised, with their variants, important mark, modifier, negative sign and arbitrary values", () => {
    const utilities = [
      "flex",
      "hidden",
      "items-center",
      "p-4",
      "md:flex",
      "hover:bg-red-500",
      "-mt-2",
      "w-[3px]",
      "[color:red]",
      "text-sm/6",
      "font-bold!",
      "!font-bold",
      "grid-cols-3",
      "sr-only",
      "border",
      "start",
      "end",
    ];
    expect(utilities.filter((u) => !isTailwindUtility(u))).toEqual([]);
  });

  test("the dashboard's own classes and daisyUI's components are not recognised as utilities", () => {
    const notUtilities = ["app-evt", "app-transition-marker", "app-chip", "on", "open", "btn", "card", "badge", "", ":", "md:"];
    expect(notUtilities.filter((c) => isTailwindUtility(c))).toEqual([]);
  });
});

describe("the dashboard's class names are read out of its source", () => {
  test("the scan finds the dashboard's own classes in public/app.js, whole and never cut at a substitution", () => {
    const tokens = new Set(dashboardClassTokens().get("app.js") ?? []);
    for (const expected of ["app-evt", "app-abort-reason", "app-transition-marker", "app-pane-runway", "app-chip", "app-empty", "on"]) {
      expect(tokens.has(expected), `the scan reads "${expected}" from public/app.js`).toBe(true);
    }
    // `app-gate-${…}` is only part of a name.
    expect([...tokens].filter((t) => t.endsWith("-"))).toEqual([]);
  });

  test("a utility written as a class prop, through classList or in a class constant is caught, and the same word outside a class is not", () => {
    const planted = [
      'const RAIL_CLASS = "app-rail gap-2";',
      'div({ class: "app-evt flex items-center" }, "hidden in text");',
      'div({ class: () => (on ? "app-on md:block" : "app-off") });',
      'el.classList.add("p-4");',
      'const position = "fixed";',
      "span({ class: `app-gate-${stem} w-[3px]` });",
    ].join("\n");
    const found = undefinedUtilities(new Map([["planted.js", scriptClassTokens(planted)]]), new Set());
    expect(found).toEqual([
      "planted.js: flex",
      "planted.js: gap-2",
      "planted.js: items-center",
      "planted.js: md:block",
      "planted.js: p-4",
      "planted.js: w-[3px]",
    ]);
  });

  test("a utility the static stylesheet defines is allowed, and so are start and end", () => {
    const tokens = new Map([["planted.js", scriptClassTokens('div({ class: "flex start end" });')]]);
    expect(undefinedUtilities(tokens, new Set())).toEqual(["planted.js: flex"]);
    expect(undefinedUtilities(tokens, classesDefinedBy(".flex{display:flex}"))).toEqual([]);
  });
});

describe("the dashboard adds no Tailwind utility class the static stylesheet does not define", () => {
  test("every Tailwind utility class in public/ is one the static stylesheet defines, or start or end", () => {
    const css = staticTailwindStylesheet();
    const defined = css === null ? new Set<string>() : classesDefinedBy(css);
    expect(undefinedUtilities(dashboardClassTokens(), defined)).toEqual([]);
  });
});
