// Shared SOURCE-SCANNING primitives for the guard tests that read the tree
// as text: the tree walker and the comment-vs-live-text classifier.
//
// LIFTED, not re-derived (CR-CRU-097 §S6). Every function here was
// file-local to tests/docs-retired-mirror-references.test.ts, which proved
// them; CR-CRU-097's namespace tripwire needs the same
// comment-vs-string discrimination, and writing a second stripper is
// exactly the failure CR-CRU-096's C1 fix round was opened for (a
// hand-rolled one never stripped comments, so a provenance comment leaked
// into a selector string and a test asserted on it). Behaviour is
// unchanged by the lift — the bodies and their derivation comments moved
// verbatim.
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

// Recursively lists files under `relDir` (repo-root relative) whose
// extension is in `exts`, skipping __pycache__ — stale `.pyc` bodies of
// deleted/renamed test modules (test_bun_crucible_context.py,
// test_toon.py) still embed their old docstrings verbatim and would
// produce phantom hits; the CR's own Context section names this exact
// trap ("10 extra hits... polluted this very enumeration").
export function listFiles(relDir: string, exts: string[]): string[] {
  const abs = join(REPO_ROOT, relDir);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__pycache__" || entry === "node_modules" || entry === ".git") {
        continue;
      }
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (exts.includes(extname(entry))) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

// Joins prose lines the way a reader would: a normal line break becomes a
// space, but a line ending in a bare hyphen (a mid-word wrap, e.g.
// "workflow-" / "tab.test.ts" split across two `//`/`#`/` * ` comment
// lines) is joined with NO separator so the wrapped filename reassembles
// correctly instead of shearing off its prefix.
export function joinWrapped(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (out.endsWith("-")) out += line;
    else if (out.length > 0) out += ` ${line}`;
    else out = line;
  }
  return out;
}

// Lexes a Python source file's STRING-LITERAL layer (not its grammar — no
// parser, no AST) and returns every triple-quoted literal that stands ALONE
// at statement position, i.e. nothing but whitespace and an optional string
// prefix (`r`/`b`/`u`/`f`) sits between the start of its line and the opening
// quote. That shape IS the docstring form, at every level Python allows one:
// module, class, function, async function, and nested/inner function. It is a
// structural rule, not a keyword heuristic — no "looks like a def above it"
// guessing is involved.
//
// The lexer exists because a line-oriented regex cannot tell an OPENING quote
// from a `"""` sitting inside another string or after a `#`. Walking the
// text once, consuming `#`-to-EOL runs and whole string literals (honouring
// backslash escapes, which suppress a closing quote in raw and non-raw
// strings alike), makes that determination exact.
//
// What statement position deliberately EXCLUDES is the fixture shape this
// extractor exists to keep out: `FIXTURE = """<testsuite name="toon.test.ts"/>"""`
// and `f("""...""")` both carry non-whitespace before the quote on their line,
// so neither is ever mistaken for prose.
//
// Only TRIPLE-quoted literals are collected. Python does permit a docstring
// written with a single- or double-quoted literal (`def f():` / `    "doc"`),
// and such a docstring is NOT scanned — deliberately, not by oversight: at
// statement position a plain `"..."` is indistinguishable from a wrapped
// argument or list element (`parser.add_argument(\n  "--foo",\n  "help",\n)`),
// so collecting them would drag argv and fixture literals back in. There are
// zero non-triple-quoted docstrings under `tests/` today (verified against a
// throwaway `ast.get_docstring` walk of all 48 modules), and that same walk
// confirmed this lexer captures 412 of 412 real docstrings with zero extra
// blocks — but a future one written in that form would evade this scan.
export function pythonStatementStrings(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = ++i;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch !== '"' && ch !== "'") {
      i++;
      continue;
    }
    const triple = text.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    const statementPosition = /^\s*(?:[rRbBuUfF]{0,2})$/.test(text.slice(lineStart, i));
    const bodyStart = i + quote.length;
    let j = bodyStart;
    let terminated = false;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text.startsWith(quote, j)) {
        terminated = true;
        break;
      }
      // An unterminated single-quoted literal cannot span a newline — bail
      // rather than swallowing the rest of the file as one string.
      if (!triple && text[j] === "\n") break;
      j++;
    }
    const bodyEnd = Math.min(j, text.length);
    if (triple && statementPosition && terminated) out.push(text.slice(bodyStart, bodyEnd));
    const consumedEnd = terminated ? bodyEnd + quote.length : bodyEnd;
    const lastNewline = text.slice(i, consumedEnd).lastIndexOf("\n");
    if (lastNewline !== -1) lineStart = i + lastNewline + 1;
    i = Math.max(consumedEnd, i + 1);
  }
  return out;
}

// Extracts ONLY docstring/comment prose from a file — never string literals
// (fixture JUnit XML bodies, argv arrays, tmp-file names written by a test)
// — so a fixture like `<testsuite name="toon.test.ts">` or a dynamically
// written `test_probe.py` never counts as a "citation". For `.py` files:
// every docstring — module, class AND function (see pythonStatementStrings
// above for how they are identified, and for the one docstring form it
// deliberately does not cover) — plus every `#` line comment. For `.ts`
// files: every `/* ... */` block (JSDoc marker lines stripped) plus every
// `//` line comment.
//
// FUNCTION/CLASS docstrings were added in the CR-CRU-053 C2 fix round. The
// previous version read only the module docstring (the file's very first
// statement), which made every function and class docstring in the tree
// invisible to this guard — and two real dangling `test_toon.py` citations
// were in fact living in function docstrings
// (test_cr046_official_toon_roundtrip.py's `_load_toon_module`,
// test_crucible_axi_shared.py's `_load_axi_module`, both since narrated as
// history). VERIFY caught those by hand, not by this scan. Closing the gap
// beat documenting it because the fix needed no Python parser and no
// heuristic — just an exact lexical rule — and it reclassified nothing:
// measured across `tests/` immediately before and after, the (file, cited
// name, verdict) set is IDENTICAL, 0 live both sides, history 24 -> 26 (the
// two function-docstring occurrences above, newly visible, both correctly
// carved out as history by their own retirement narration).
export function extractCitableText(relPath: string, text: string): string {
  if (relPath.endsWith(".py")) {
    const docstrings = pythonStatementStrings(text)
      .map((body) => joinWrapped(body.split("\n").map((l) => l.trim())))
      .join("\n");
    const lineComments = joinWrapped(
      text
        .split("\n")
        .filter((line) => line.trim().startsWith("#"))
        .map((line) => line.trim().replace(/^#+\s?/, "")),
    );
    return `${docstrings}\n${lineComments}`;
  }
  const blockComments = (text.match(/\/\*[\s\S]*?\*\//g) ?? [])
    .map((block) =>
      joinWrapped(
        block
          .replace(/^\/\*\*?/, "")
          .replace(/\*\/$/, "")
          .split("\n")
          .map((l) => l.trim().replace(/^\*\s?/, "")),
      ),
    )
    .join("\n");
  const lineComments = joinWrapped(
    (text.match(/\/\/[^\n]*/g) ?? []).map((line) => line.replace(/^\/\/\s?/, "")),
  );
  return `${blockComments}\n${lineComments}`;
}
