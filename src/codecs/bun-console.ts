// bun's console failure detail — the reading of bun's console stream.
//
// bun's JUnit reporter writes a bare `<failure type="…"/>` for every failure
// kind (assertion mismatch, thrown Error, timeout alike); the human detail
// exists only on the console stream, as an `error: <detail>` block under a
// source echo of the code that raised. This module reads that stream into
// `{message, trace?}` per result-line name, by the rules the bun client
// applied before it handed its console to the board. It knows
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
  "^" + ANSI_SGR_RUN + "(?:(?<glyph>[✓»✎])" + ANSI_SGR_RUN + "|\\((?<word>pass|skip|todo)\\))\\s",
);
/** What each pass, skip or todo glyph reports. */
const GLYPH_STATUS: Record<string, "pass" | "skip" | "todo"> = { "✓": "pass", "»": "skip", "✎": "todo" };
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
/** Any character that is not Python's `str.strip` whitespace. */
const PY_NON_SPACE = new RegExp("[^" + PY_SPACE.slice(1));

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

/**
 * The whole lines of a console text read from a line's start, cut by the same
 * line breaks `splitLines` cuts by, and how many characters they span with
 * their breaks. A partial last line is not a line yet, and neither is a line
 * whose only break so far is a closing `\r`, which may open a `\r\n`: both
 * wait for the text that follows.
 */
export function wholeConsoleLines(text: string): { lines: string[]; consumed: number } {
  const lines: string[] = [];
  let start = 0;
  for (const found of text.matchAll(new RegExp(LINE_BREAK.source, "g"))) {
    const at = found.index;
    if (found[0] === "\r" && at + 1 === text.length) break;
    lines.push(text.slice(start, at));
    start = at + found[0].length;
  }
  return { lines, consumed: start };
}

function rstrip(text: string): string {
  return text.replace(PY_TRAILING, "");
}

function strip(text: string): string {
  return rstrip(text).replace(PY_LEADING, "");
}

// bun's marker for an error it caught outside any test: a file that failed
// to load, threw at import, or rejected at import or after its tests.
const UNHANDLED_MARKER = "# Unhandled error between tests";
// A `<path>:` file header bun prints, flush left, before each file's results:
// a path naming a JavaScript/TypeScript module, the only kind of file bun
// runs as a test file. A test's own flush-left console line (`results:`)
// names no such file, so it is never read as a header.
const FILE_HEADER = /^(?<path>[^\s#-]\S*\.[cm]?[jt]sx?):$/;
// The rule of dashes that opens and closes each unhandled-error block.
const BLOCK_RULE = /^-{10,}$/;
// The fallback message of a block that carries no `error:` line.
const LOAD_ERROR_FALLBACK = "unhandled error between tests";

/** The first `limit` characters, counted by code point. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

/** What the load-error reader holds between lines: readable and restorable. */
export interface BunLoadErrorState {
  /** The file whose header was read last. */
  current?: string;
  /** A block is being read. */
  block: boolean;
  /** The block's opening rule is behind us. */
  opened: boolean;
  /** The block's first `error:` line, without its label, cut. */
  errorText?: string;
}

/** What one line did to a load-error block: a line of its body, or its end. */
export type BunLoadErrorEvent =
  | { kind: "line"; text: string }
  | { kind: "end"; file?: string; message: string };

/**
 * bun's load-error reading, one line at a time. A block is the lines between
 * the two rules under `# Unhandled error between tests`, and belongs to the
 * file whose header was read last (none before any header). Each body line
 * is handed back as it is read, and the block's end names its file and its
 * message: its first `error:` line without the label (`unhandled error between
 * tests` when it has none), cut at 1000 characters. Everything handed back is
 * free of SGR escapes. Its state is small and restorable, so a reading may
 * stop after any line and resume.
 */
export class BunLoadErrorReader {
  private state: BunLoadErrorState;

  constructor(state?: BunLoadErrorState) {
    this.state = state !== undefined ? { ...state } : { block: false, opened: false };
  }

  /** The file whose header was read last, if any. */
  get currentFile(): string | undefined {
    return this.state.current;
  }

  /** The reader's state, to restore a later reader from. */
  snapshot(): BunLoadErrorState {
    return { ...this.state };
  }

  /** One console line read; what it did to a block, or null. */
  read(line: string): BunLoadErrorEvent | null {
    const s = this.state;
    const plain = rstrip(stripAnsi(line));
    if (s.block) {
      if (BLOCK_RULE.test(strip(plain))) {
        if (!s.opened) {
          s.opened = true;
          return null;
        }
        const message = cut(s.errorText || LOAD_ERROR_FALLBACK, MESSAGE_LIMIT);
        this.state = { ...(s.current !== undefined ? { current: s.current } : {}), block: false, opened: false };
        return { kind: "end", ...(s.current !== undefined ? { file: s.current } : {}), message };
      }
      if (!s.opened) return null;
      if (s.errorText === undefined && plain.startsWith("error:")) {
        s.errorText = cut(strip(plain.slice("error:".length)), MESSAGE_LIMIT);
      }
      return { kind: "line", text: plain };
    }
    if (strip(plain) === UNHANDLED_MARKER) {
      s.block = true;
      s.opened = false;
      delete s.errorText;
      return null;
    }
    const header = FILE_HEADER.exec(plain);
    if (header !== null && !plain.startsWith("error:")) {
      const path = header.groups?.["path"];
      if (path !== undefined) s.current = path;
    }
    return null;
  }
}

/**
 * The files bun named under `# Unhandled error between tests`, read from its
 * console in either wire form, each mapped to the failure of the one case its
 * load error is filed as, in the order bun named the files.
 *
 * A file header is a flush-left `<path>:` whose path ends in a JS/TS module
 * extension; an `error:` line never is one. A block is the lines between the
 * two rules under the marker, and belongs to the file whose header was read
 * last; a block before any header belongs to no file. The message is the
 * first block's `error:` line without its label (`unhandled error between
 * tests` when it has none), cut at 1000 characters; the trace is every block
 * for that file (each block's lines joined by "\n", the blocks by "\n\n",
 * trimmed), cut at 8000. Everything kept is free of SGR escapes. These are
 * the rules the bun client read load errors by, before the board read them,
 * and they are `BunLoadErrorReader`'s: the text is read line by line through
 * `given`, a fresh reader unless the caller hands its own.
 */
export function parseBunLoadErrors(
  consoleText: string,
  given?: BunLoadErrorReader,
): Record<string, BunConsoleDetail> {
  const reader = given ?? new BunLoadErrorReader();
  const errors = new Map<string, { message: string; blocks: string[][] }>();
  let block: string[] = []; // the body lines of the block being read
  for (const line of splitLines(consoleText)) {
    const event = reader.read(line);
    if (event === null) continue;
    if (event.kind === "line") {
      block.push(event.text);
      continue;
    }
    if (event.file !== undefined) {
      const held = errors.get(event.file);
      if (held === undefined) errors.set(event.file, { message: event.message, blocks: [block] });
      else held.blocks.push(block);
    }
    block = [];
  }
  const read: Record<string, BunConsoleDetail> = {};
  for (const [path, { message, blocks }] of errors) {
    const trace = strip(blocks.map((b) => strip(b.join("\n"))).join("\n\n"));
    const failure: BunConsoleDetail = { message };
    if (trace.length > 0) failure.trace = cut(trace, TRACE_LIMIT);
    read[path] = failure;
  }
  return read;
}

/**
 * A pending block's detail as the marriage reader holds it: the message, and
 * the trace cut at `TRACE_LIMIT` characters with whether any non-whitespace
 * was cut away (so the trace married is exactly the whole block's trace,
 * trailing whitespace dropped, cut).
 */
interface PendingDetail {
  message: string;
  trace: string;
  full: boolean;
  beyond: boolean;
}

/** What the marriage reader holds between lines: readable and restorable, and bounded. */
export interface BunConsoleFailureState {
  /** The producer named by the echo above the pending `error:` line. */
  echoName?: string;
  /** The last declaration echoed in the window being read. */
  window?: string;
  /** The window's caret is behind us. */
  caret: boolean;
  /** The pending block, from its latest `error:` line. */
  detail?: PendingDetail;
}

/** A result line as the marriage reader reads it. */
export type BunConsoleResult =
  | { status: "fail"; name: string; leaf: string; detail?: BunConsoleDetail }
  | { status: "pass" | "skip" | "todo" };

/** One more line of a pending block's trace, held to `TRACE_LIMIT` characters. */
function holdTrace(detail: PendingDetail, line: string): void {
  const piece = detail.trace.length === 0 && !detail.full ? line : `\n${line}`;
  if (detail.full) {
    if (!detail.beyond && PY_NON_SPACE.test(piece)) detail.beyond = true;
    return;
  }
  const joined = detail.trace + piece;
  if (joined.length <= TRACE_LIMIT) {
    detail.trace = joined;
    return;
  }
  const points = Array.from(joined);
  if (points.length <= TRACE_LIMIT) {
    detail.trace = joined;
    return;
  }
  detail.trace = points.slice(0, TRACE_LIMIT).join("");
  detail.full = true;
  detail.beyond = PY_NON_SPACE.test(points.slice(TRACE_LIMIT).join(""));
}

/**
 * bun's marriage of console detail to its result lines, one line at a time.
 * A block (from its `error:` line to the next result line) marries the
 * `(fail)`/`✗` result line that follows it when the echo's last test
 * declaration at or above the caret names that line's last ` > ` segment, or
 * when the echo names no test it can read (position decides). A block whose
 * echo names another test is that test's aftermath and marries no one. A
 * pass, skip or todo result line ends a pending block. Each result line is
 * handed back with its status; a fail line with its composed name, its last
 * segment, and the detail married to it, if any. The message is the `error:`
 * line's text cut at 1000 characters, the trace the block's lines joined by
 * "\n", trailing whitespace dropped, cut at 8000. Its state holds only the
 * pending block's message, echo name and cut trace, so it stays bounded, and
 * a reading may stop after any line and resume.
 */
export class BunConsoleFailureReader {
  private state: BunConsoleFailureState;

  constructor(state?: BunConsoleFailureState) {
    this.state =
      state !== undefined
        ? { ...state, ...(state.detail !== undefined ? { detail: { ...state.detail } } : {}) }
        : { caret: false };
  }

  /** The reader's state, to restore a later reader from. */
  snapshot(): BunConsoleFailureState {
    const s = this.state;
    return { ...s, ...(s.detail !== undefined ? { detail: { ...s.detail } } : {}) };
  }

  /** One console line read: the result it reports, or null. */
  read(line: string): BunConsoleResult | null {
    const s = this.state;
    const failed = FAIL_LINE.exec(line);
    if (failed !== null) {
      const name = strip(stripAnsi(failed.groups?.["name"] ?? ""));
      // Nested describes print "suite > name"; the echo names the bare test.
      const leaf = name.split(" > ").at(-1) ?? name;
      let married: BunConsoleDetail | undefined;
      if (s.detail !== undefined && (s.echoName === undefined || s.echoName === leaf)) {
        married = { message: s.detail.message };
        const trace = s.detail.beyond ? s.detail.trace : rstrip(s.detail.trace);
        if (trace.length > 0) married.trace = trace;
      }
      this.state = { caret: false };
      return { status: "fail", name, leaf, ...(married !== undefined ? { detail: married } : {}) };
    }
    const boundary = RESULT_BOUNDARY_LINE.exec(line);
    if (boundary !== null) {
      this.state = { caret: false };
      const glyph = boundary.groups?.["glyph"];
      const word = boundary.groups?.["word"];
      const status = glyph !== undefined ? GLYPH_STATUS[glyph] : word;
      return { status: status === "skip" || status === "todo" ? status : "pass" };
    }
    const plain = stripAnsi(line);
    if (plain.startsWith("error:")) {
      s.detail = {
        message: cut(strip(plain.slice("error:".length)), MESSAGE_LIMIT),
        trace: "",
        full: false,
        beyond: false,
      };
      // The window just read belongs to this block; the next starts fresh, so a
      // second `error:` under one window marries by position.
      if (s.window !== undefined) s.echoName = s.window;
      else delete s.echoName;
      delete s.window;
      s.caret = false;
    } else if (!s.caret) {
      if (ECHO_TEST_LINE.test(plain)) {
        const echoed = ECHO_TEST_DECL.exec(plain)?.groups?.["name"];
        // `test.each`, a variable, a split declaration, an interpolated
        // template or an escaped quote names no resolvable producer.
        if (echoed === undefined || echoed.includes("${") || echoed.includes("\\")) delete s.window;
        else s.window = echoed;
      } else if (ECHO_CARET.test(plain)) {
        s.caret = true;
      }
    }
    if (s.detail !== undefined) holdTrace(s.detail, plain);
    return null;
  }
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
 * whitespace dropped, cut at 8000. The rule is `BunConsoleFailureReader`'s:
 * the text is read line by line through `given`, a fresh reader unless the
 * caller hands its own.
 */
export function parseBunConsoleFailures(
  consoleText: string,
  given?: BunConsoleFailureReader,
): Record<string, BunConsoleDetail> {
  const reader = given ?? new BunConsoleFailureReader();
  const details = new Map<string, BunConsoleDetail>();
  for (const line of splitLines(consoleText)) {
    const result = reader.read(line);
    if (result?.status !== "fail" || result.detail === undefined) continue;
    details.set(result.name, result.detail);
    if (!details.has(result.leaf)) details.set(result.leaf, result.detail);
  }
  return Object.fromEntries(details);
}
