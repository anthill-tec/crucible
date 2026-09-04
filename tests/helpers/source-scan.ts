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

// Lexes a `.ts`/`.js`-family source file's COMMENT layer the way
// `pythonStatementStrings` above lexes Python's string layer: by walking the
// text ONCE and consuming whole string literals, template literals and regex
// literals, so a `//` that is not a comment is never read as one.
//
// ADDED in CR-CRU-097's C4 fix round, closing a defect the lift inherited
// verbatim. The previous version found line comments with `/\/\/[^\n]*/g`
// over the RAW file, which cannot tell a comment from a `//` inside a
// string or a regex: `const u = "http://board/CR-X-1";` classified `CR-X-1`
// as PROSE. Every namespace-tripwire dimension filters on `!isProse`, so the
// whole class "a shipped string carrying a URL, a path or a regex beside a
// CR id" was invisible to all of them. Nothing was red the day it was found;
// the claim being defended is that a future leak fails on the day it is
// WRITTEN, and that class would have passed silently.
//
// THE ONE AMBIGUITY IN THE GRAMMAR, and the direction it is resolved in: a
// bare `/` is a regex opener or a division operator depending on the
// preceding token, which no lexer can decide without the expression
// grammar. The rule here is the standard one — a regex may begin where a
// VALUE may begin, i.e. after an operator, an opening bracket, a comma, a
// semicolon, a newline or one of the value-position keywords — and where it
// is still ambiguous (after `}`, which closes a block AND an object
// literal) the `/` is read as a REGEX. That is the loud direction: reading a
// division as a regex can only make the scan consume too little prose, which
// makes a guard REPORT more, while the reverse would hide a `//` inside a
// regex and open a silent hole. Both slips are then bounded by the
// newline guard below: a regex literal cannot span a line, so a mis-opened
// one is abandoned at the newline instead of swallowing the file.
// The value-position keywords, as a static lookup: a `/` directly after one
// of these opens a regex (`return /x/.test(s)`), never a division.
const JS_VALUE_KEYWORDS: Record<string, true> = {
  await: true,
  case: true,
  delete: true,
  do: true,
  else: true,
  in: true,
  instanceof: true,
  new: true,
  of: true,
  return: true,
  throw: true,
  typeof: true,
  void: true,
  yield: true,
};

function regexMayOpenAt(text: string, slash: number): boolean {
  let k = slash - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  if (k < 0) return true;
  const prev = text[k];
  if (!/[A-Za-z0-9_$]/.test(prev)) return !(prev === ")" || prev === "]" || prev === ".");
  let start = k;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start--;
  return JS_VALUE_KEYWORDS[text.slice(start + 1, k + 1)] === true;
}

// Consumes the literal opening at `open` and returns the index just past it,
// or `open + 1` when the text does not in fact close a literal there (an
// apostrophe in a comment-free line, a `/` that was division after all) — so
// a misread never swallows the rest of the file. `'` and `"` bail at a
// newline; a template literal may span lines and tracks `${...}` brace depth
// so a `}` inside a substitution does not end it early; a regex tracks its
// `[...]` class, inside which `/` is literal.
//
// `holes`, when passed, collects the LIVE-CODE ranges inside a template
// literal — the interior of each top-level `${...}` — because that text is
// expression code wearing a literal's clothes: `` `sent ${String(x.y)}` ``
// names `x.y` in code, while the prose around it names nothing. Only the
// outermost substitution of a nest is recorded, which keeps the whole nest
// on the live-code side. Callers that only need the literal's end pass
// nothing and are unaffected.
function skipLiteral(
  text: string,
  open: number,
  kind: "quote" | "regex",
  holes?: { start: number; end: number }[],
): number {
  const quote = text[open];
  const template = quote === "`";
  let depth = 0;
  let inClass = false;
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n" && !template) return open + 1;
    if (kind === "regex") {
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return i + 1;
      i++;
      continue;
    }
    if (template) {
      if (c === "$" && text[i + 1] === "{") {
        depth++;
        if (depth === 1 && holes !== undefined) holes.push({ start: i + 2, end: text.length });
        i += 2;
        continue;
      }
      if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0 && holes !== undefined) holes[holes.length - 1]!.end = i;
        i++;
        continue;
      }
    }
    if (c === quote && depth === 0) return i + 1;
    i++;
  }
  return open + 1;
}

// THE INERT LAYER as spans over the original text: everything that is NOT
// live code — comment runs, and the prose inside string literals. This is
// what the walk above actually determines; `jsCommentRuns` is a projection of
// it and `jsLiveCode` is its complement, so there is still exactly ONE walk
// of this grammar in the repo.
//
// ADDED in CR-CRU-099 §S2 for the accepted-field guard, which needs the
// MIRROR IMAGE of what the citation scans need: a file's live CODE, with the
// prose taken out. Both halves of that guard's determination — which keys an
// interface declares, which fields a handler dereferences — are wrong if
// prose counts. `handleQueuePost` carries a comment naming `fields.release`
// two lines above the code that reads it, so a scan over raw text would keep
// reporting the field READ long after the read was deleted; a `help=` string
// naming a field would do the same. Both are the silent direction. Extending
// here rather than stripping locally is §S6's standing rule: CR-CRU-096
// shipped a hand-rolled stripper and a provenance comment leaked into a
// selector string.
//
// A template literal contributes its PROSE only — each `${...}` interior is
// live code and is left standing (see `skipLiteral`'s `holes`), which is why
// `` `... ${String(fields.track)}` `` still reads as a field dereference.
export interface JsInertSpan {
  start: number;
  end: number;
  kind: "block" | "line" | "string";
}

export function jsInertSpans(text: string): JsInertSpan[] {
  const spans: JsInertSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j++;
      spans.push({ start: i, end: j, kind: "line" });
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      spans.push({ start: i, end, kind: "block" });
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const holes: { start: number; end: number }[] = [];
      const end = skipLiteral(text, i, "quote", holes);
      // A MISREAD — `skipLiteral` found no closing quote and answered
      // `open + 1` — contributes no span at all, exactly as the walk did
      // before it reported string spans: an apostrophe in live code must not
      // blank the rest of the file.
      if (end <= i + 1) {
        i = i + 1;
        continue;
      }
      // The literal minus its substitutions: prose runs from the opening
      // quote (or from the end of the previous hole) to the next hole.
      let cursor = i;
      for (const hole of holes) {
        if (hole.start > cursor) spans.push({ start: cursor, end: hole.start, kind: "string" });
        cursor = hole.end;
      }
      if (end > cursor) spans.push({ start: cursor, end, kind: "string" });
      i = end;
      continue;
    }
    if (c === "/" && regexMayOpenAt(text, i)) {
      i = skipLiteral(text, i, "regex");
      continue;
    }
    i++;
  }
  return spans;
}

// Unchanged in behaviour by the span refactor: the same comment runs, in the
// same order, sliced from the same offsets — `blocks` and `lines` are the two
// comment kinds separated, exactly as the previous loop pushed them, and the
// string spans this walk now also reports are not comments and are dropped
// here.
export function jsCommentRuns(text: string): { blocks: string[]; lines: string[] } {
  const blocks: string[] = [];
  const lines: string[] = [];
  for (const span of jsInertSpans(text)) {
    if (span.kind === "string") continue;
    (span.kind === "block" ? blocks : lines).push(text.slice(span.start, span.end));
  }
  return { blocks, lines };
}

// Blanks the given spans of `text` — every byte replaced by a space, newlines
// KEPT — so the result is offset- and line-identical to the input: an index
// found in it is an index into the original file, and a line number derived
// from it is the line a reader will open. The one blanking loop, shared by
// both projections below so they cannot drift apart.
function blankSpans(text: string, spans: JsInertSpan[]): string {
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

// The COMPLEMENT of the inert layer: every comment run and every string's
// prose blanked, every other byte left exactly where it was.
export function jsLiveCode(text: string): string {
  return blankSpans(text, jsInertSpans(text));
}

// Walks from `from` to the end of the balanced bracket group it opens, or to
// the `;` that ends the statement when one arrives at depth 0 — so an
// unterminated group can never swallow the rest of the file.
//
// LIFTED in CR-CRU-104 §S3 from tests/project-namespace-tripwire.test.ts,
// which proved it (its assertion-span and object-literal walks both call it),
// because the accepted-field guard needs the same walk to find the span of
// the object literal handed to the store — and a second hand-rolled brace
// counter is §S6's standing prohibition. Behaviour is unchanged by the lift:
// the body moved verbatim.
//
// Run it on `jsLiveCode(text)`, whose offsets are identical to the raw file's,
// and a brace inside a string or a comment cannot be counted.
export function balancedEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  let opened = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      opened = true;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (opened && depth <= 0) return i + 1;
    } else if (c === ";" && depth <= 0 && opened) {
      return i;
    }
    i++;
  }
  return text.length;
}

// The COMPANION walk, for a span whose start is NOT a bracket: from `from`,
// to the first character of `terminators` that is not nested inside a bracket
// group, or to the closer of the group that ENCLOSES `from` — so a matcher
// chained after a closing paren stays inside the span
// (`expect(v).toBe("CR-X-1")` puts the literal in the matcher, not in
// `expect`'s own arguments, and `balancedEnd` above would stop one call too
// early and see nothing), and an unterminated span can never swallow the rest
// of the file.
//
// LIFTED in CR-CRU-104 §S3 from tests/project-namespace-tripwire.test.ts's
// `statementEnd`, PARAMETERISED by the terminator set rather than copied: the
// tripwire ends a statement (`;`), the accepted-field guard ends an object
// property's value expression (`;` or `,`), and the two bodies were otherwise
// character-identical. A second copy differing by one character in a set is
// the CR-CRU-096 defect shape.
export function unnestedEnd(text: string, from: number, terminators: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return i;
    } else if (terminators.includes(c) && depth === 0) return i;
  }
  return text.length;
}

// THE THIRD PROJECTION of the same walk: only COMMENT runs blanked, so live
// code AND the prose inside string literals both stand. It is the mirror of
// what `jsLiveCode` reports and it exists because the two guards need
// OPPOSITE halves of the same determination.
//
// ADDED in CR-CRU-102 §S1 for the AC6 prefix guard, which asks whether the
// shipped tree spells a project's id PREFIX anywhere the product can read
// it. That literal lives INSIDE a string (`"CR-CRU-"`), which is exactly
// what `jsLiveCode` blanks — so the accepted-field guard's projection would
// hide the leak this one exists to find. Comments must still be exempt,
// because `public/app.js` carries 197 OCCURRENCES of the shape in its
// provenance narration (CR-CRU-097 AC8 protects those) — occurrences, not
// lines: `(readFileSync("public/app.js","utf8").match(/CR-[A-Z]{2,}-/g) ?? [])
// .length` is 197 where the same count over `jsUncommented(text)` is 0 — and a
// scan of raw text would report every one of them.
//
// Extending here rather than stripping locally is §S6's standing rule: a
// second walk of this grammar is the CR-CRU-096 defect (a hand-rolled
// stripper never stripped comments, so a provenance comment leaked into a
// selector string and a test asserted on it).
export function jsUncommented(text: string): string {
  return blankSpans(
    text,
    jsInertSpans(text).filter((span) => span.kind !== "string"),
  );
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
  // The comment RUNS come from the lexer above, not from a regex over the
  // raw file; everything downstream of this point is unchanged, so the
  // output shape (blocks first, then all line comments joined as one wrapped
  // run) is exactly what it was before C4.
  const runs = jsCommentRuns(text);
  const blockComments = runs.blocks
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
  const lineComments = joinWrapped(runs.lines.map((line) => line.replace(/^\/\/\s?/, "")));
  return `${blockComments}\n${lineComments}`;
}
