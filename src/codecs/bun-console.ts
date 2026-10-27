// bun's console failure detail — the reading of bun's console stream.
//
// bun's JUnit reporter writes a bare `<failure type="…"/>` for every failure
// kind (assertion mismatch, thrown Error, timeout alike); the human detail
// exists only on the console stream, as an `error: <detail>` block under a
// source echo of the code that raised. This module reads that stream into
// `{message, trace?}` per result-line name, by the rules the bun client
// applies (`_parse_console_failures` in clients/bun-crucible.py). It knows
// nothing of JUnit or of any route: a caller hands it console text and decides
// what to do with what it reads.

/** One block of console detail, married to a result-line name. */
export interface BunConsoleDetail {
  message: string;
  trace?: string;
}

/** A message is cut to this many characters. */
const MESSAGE_LIMIT = 1000;
/** A trace is cut to this many characters. */
const TRACE_LIMIT = 8000;

// bun colourises its stream even through a pipe, so both wire forms are read:
// the plain `(fail) name [0.15ms]` and the ANSI `✗ name [0.15ms]`, each token
// possibly wrapped in SGR escape runs.
const ANSI_SGR_RUN = "(?:\\x1b\\[[0-9;]*m)*";
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const DURATION_TAIL =
  "(?:\\s+" + ANSI_SGR_RUN + "\\[" + ANSI_SGR_RUN + "[0-9.]+\\s*m?s" + ANSI_SGR_RUN + "\\])?";
const FAIL_LINE = new RegExp(
  "^" + ANSI_SGR_RUN + "(?:✗|\\(fail\\))" + ANSI_SGR_RUN + "\\s+(?<name>.*?)" +
    ANSI_SGR_RUN + DURATION_TAIL + ANSI_SGR_RUN + "\\s*$",
);
// A pass, skip or todo result line (ANSI ✓ » ✎, or plain `(pass)`/`(skip)`/
// `(todo)`) ends the preceding detail block, so a block never crosses a
// finished test to marry the wrong leaf.
const RESULT_BOUNDARY_LINE = new RegExp(
  "^" + ANSI_SGR_RUN + "(?:[✓»✎]" + ANSI_SGR_RUN + "|\\((?:pass|skip|todo)\\))\\s",
);
// The block's producer, named by the source echo bun prints above the caret:
// `N | test("<name>", …`, matched on the stripped line, gutter right-aligned.
// `describe(` deliberately does not match.
const ECHO_TEST_DECL = /^\s*\d+\s*\|\s*(?:test|it)(?:\.\w+)*\s*\(\s*(?<q>["'`])(?<name>.*?)\k<q>/;
// The declaration line, whether or not its name is readable: an unreadable one
// nulls the window rather than leave the previous declaration's name standing.
const ECHO_TEST_LINE = /^\s*\d+\s*\|\s*(?:test|it)(?:\.\w+)*\s*\(/;
// The caret marking the offending column: the producer is the last
// declaration echoed at or above it.
const ECHO_CARET = /^\s*\^\s*$/;

// The line boundaries Python's `str.splitlines` splits on, so the stream is
// cut into exactly the lines the bun client reads.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// Python's `str.strip` whitespace: JS `\s` less U+FEFF, plus the separators
// `\s` omits.
const PY_SPACE = "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_LEADING = new RegExp("^" + PY_SPACE + "+");
const PY_TRAILING = new RegExp(PY_SPACE + "+$");

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(LINE_BREAK);
  // A trailing line break ends the last line; it does not open an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function rstrip(text: string): string {
  return text.replace(PY_TRAILING, "");
}

function strip(text: string): string {
  return rstrip(text).replace(PY_LEADING, "");
}

/** The first `limit` characters, counted by code point. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

/**
 * Bun's console stream read into failure detail, keyed by result-line name.
 *
 * A block (from its `error:` line to the next result line) marries the
 * `(fail)`/`✗` result line that follows it when the echo's last test
 * declaration at or above the caret names that line's last ` > ` segment, or
 * when the echo names no test it can read (position decides). A block whose
 * echo names another test is that test's aftermath and marries no one. A
 * pass, skip or todo result line ends a pending block, so detail printed after
 * its own result line stays unmatched. Each married block is indexed under the
 * composed result-line name and — first come — its last segment; everything
 * kept is free of SGR escapes. The message is the `error:` line's text cut at
 * 1000 characters, the trace the block's lines joined by "\n", trailing
 * whitespace dropped, cut at 8000.
 */
export function parseBunConsoleFailures(consoleText: string): Record<string, BunConsoleDetail> {
  const details = new Map<string, BunConsoleDetail>();
  let block: string[] = []; // stripped lines since the last result-line boundary
  let errorIdx: number | undefined; // index in `block` of the latest `error:` line
  let echoName: string | undefined; // producer named by the echo above that line
  let window: string | undefined; // last declaration echoed in the window being read
  let caret = false; // the window's caret is behind us
  for (const line of splitLines(consoleText)) {
    const failed = FAIL_LINE.exec(line);
    if (failed !== null) {
      const name = strip(stripAnsi(failed.groups?.["name"] ?? ""));
      // Nested describes print "suite > name"; the echo names the bare test.
      const leaf = name.split(" > ").at(-1) ?? name;
      if (errorIdx !== undefined && (echoName === undefined || echoName === leaf)) {
        const detail = block.slice(errorIdx);
        const message = strip((detail[0] ?? "").slice("error:".length));
        const married: BunConsoleDetail = { message: cut(message, MESSAGE_LIMIT) };
        const trace = rstrip(detail.join("\n"));
        if (trace.length > 0) married.trace = cut(trace, TRACE_LIMIT);
        details.set(name, married);
        if (!details.has(leaf)) details.set(leaf, married);
      }
      block = [];
      errorIdx = undefined;
      echoName = undefined;
      window = undefined;
      caret = false;
      continue;
    }
    if (RESULT_BOUNDARY_LINE.test(line)) {
      block = [];
      errorIdx = undefined;
      echoName = undefined;
      window = undefined;
      caret = false;
      continue;
    }
    const plain = stripAnsi(line);
    if (plain.startsWith("error:")) {
      errorIdx = block.length;
      // The window just read belongs to this block; the next starts fresh, so a
      // second `error:` under one window marries by position.
      echoName = window;
      window = undefined;
      caret = false;
    } else if (!caret) {
      if (ECHO_TEST_LINE.test(plain)) {
        const echoed = ECHO_TEST_DECL.exec(plain)?.groups?.["name"];
        // `test.each`, a variable, a split declaration, an interpolated
        // template or an escaped quote names no resolvable producer.
        window =
          echoed === undefined || echoed.includes("${") || echoed.includes("\\") ? undefined : echoed;
      } else if (ECHO_CARET.test(plain)) {
        caret = true;
      }
    }
    block.push(plain);
  }
  return Object.fromEntries(details);
}
