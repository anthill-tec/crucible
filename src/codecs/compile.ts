// CR-CRU-002 §S2 — Compile codecs: parseCompile / detectFormat.
// Parses compiler error output (rustc / javac / python / tsc / gcc / go) and linter output
// (ruff, cargo clippy; clang-tidy through gcc, go vet through go) into a CompileReport.
// Never rejects: unrecognized input falls back to format "raw"; so does a gcc report
// holding no error diagnostic, so a failed build is never shown as clean. A go report
// holding no positioned diagnostic is one message-only error, for the same reason.

export interface CompileDiagnostic {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
}

export interface CompileReport {
  format: string;
  errorCount: number;
  warningCount: number;
  diagnostics: CompileDiagnostic[];
  raw: string;
}

const HINT_ALIASES: Record<string, string> = {
  rust: "rustc",
  rustc: "rustc",
  java: "javac",
  maven: "javac",
  javac: "javac",
  py: "python",
  python: "python",
  ts: "tsc",
  typescript: "tsc",
  tsc: "tsc",
  gcc: "gcc",
  "g++": "gcc",
  arduino: "gcc",
  go: "go",
  golang: "go",
  ruff: "ruff",
  clippy: "clippy",
  "go vet": "go",
  "clang-tidy": "gcc",
};

const RUSTC_HEAD = /^(error|warning)(?:\[(E\d+)\])?:\s*(.*)$/;
const RUSTC_LOCATION = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
// ANY rustc summary trailer ("… generated N warnings") is excluded from diagnostics.
const RUSTC_SUMMARY = /generated \d+ warnings?/;
// cargo's per-crate trailer: `could not compile `NAME` … due to N previous error…`.
const CARGO_TRAILER = /^could not compile /;
// rustc's own lint, named by its level note: `= note: `#[warn(unused_variables)]` …`, or the
// command-line form `-D warnings` prints: `= note: `-D unused-variables` implied by …`.
const RUSTC_LINT_NOTE = /^\s*= note: `(?:#\[(?:warn|deny|forbid)\(([a-z_][a-z0-9_]*)\)\]|-[DWF] ([a-z_][a-z0-9_-]*))`/;
// A clippy lint's help URL, on master or a versioned `rust-<v>` path: `…/index.html#<name>`.
const CLIPPY_URL = /rust-lang\.github\.io\/rust-clippy\/(?:master|rust-[\d.]+)\/index\.html#([\w-]+)/;
// A clippy lint's level note: `#[warn(clippy::<name>)]`, `#[deny(clippy::<name>)]` or `-D clippy::<name>`.
// Only the lint the note opens with counts, never the group it is implied by.
const CLIPPY_NOTE = /^\s*= note: `(?:#\[(?:warn|deny|forbid)\(|-[DWF] )clippy::([\w-]+)/;
// ruff `--output-format concise`: `PATH:LINE:COL: CODE [*] message`, or a syntax error
// `PATH:LINE:COL: invalid-syntax: message`. Summary lines never take this shape.
const RUFF_LINE = /^(?!\[)((?:(?!: ).)+?):(\d+):(\d+): (?:(invalid-syntax): |([A-Z]+[0-9]+) )(?:\[\*\] )?(.*)$/;
const JAVAC_LINE = /^\[(ERROR|WARNING)\]\s+(.+?):\[(\d+),(\d+)\]\s+(.*)$/;
const PYTHON_FRAME = /^\s*File "([^"]+)", line (\d+)/;
const PYTHON_FINAL = /^\w*(?:Error|Exception)\b.*$/;
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
// GCC: FILE never starts with `[` and never contains `: ` (it may contain spaces).
const GCC_DIAGNOSTIC = /^(?!\[)((?:(?!: ).)+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/;
// A trailing bracket: a compiler flag (`[-Wunused-variable]`) or a linter's check
// (`[readability-braces-around-statements]`, `[check,-warnings-as-errors]`).
const GCC_BRACKET = /^(.*) \[([^\]]+)\]$/;
// Sourced link error, older (`FILE:LINE: …`) and newer (`FILE:LINE:(SECTION+OFFSET): …`) linkers.
// SECTION holds neither `(` nor `)`, so a long line with an unclosed `(` decodes in linear time.
const GCC_LINK_SOURCED = /^(?!\[)((?:(?!: ).)+?):(\d+):(?:\([^()]*\):)? (undefined reference to .*)$/;
// Object-only link error: `…: OBJECT:(SECTION+OFFSET): undefined reference to …`.
const GCC_LINK_OBJECT = /^.*?: [^:\s][^:]*:\([^()]*\): (undefined reference to .*)$/;
// Go: `PATH:LINE:COL: message`, or `PATH:LINE: message` with no column (a go.mod error).
const GO_DIAGNOSTIC = /^(?!\[)((?:(?!: ).)+?):(\d+)(?::(\d+))?: (.*)$/;
// Unhinted detection needs a `<file>.go:LINE:COL: ` line.
const GO_DETECT = /^(?!\[)(?:(?!: ).)+?\.go:\d+:\d+: /;
const GO_CONTINUATION = /^\t+/;
// A line the go command prints about itself or the module, not about a source file.
const GO_TOOL_LINE = /^go: /;
const GO_TOO_MANY = "too many errors";
// Lines that are never a go diagnostic: package headers, `go:` lines, the test compile's status lines.
const GO_NOT_DIAGNOSTIC = /^(?:# |go: |(?:ok|\?|FAIL)(?:\s|$))/;

export function detectFormat(errors: string, hint?: string): string {
  if (hint !== undefined) {
    const alias = HINT_ALIASES[hint.toLowerCase()];
    if (alias !== undefined) return alias;
  }
  const lines = errors.split("\n");
  if (lines.some((line) => RUSTC_HEAD.test(line)) && lines.some((line) => RUSTC_LOCATION.test(line))) {
    return "rustc";
  }
  if (lines.some((line) => JAVAC_LINE.test(line))) return "javac";
  if (lines.some((line) => PYTHON_FRAME.test(line))) return "python";
  if (lines.some((line) => TSC_LINE.test(line))) return "tsc";
  if (lines.some((line) => GCC_DIAGNOSTIC.test(line) || GCC_LINK_SOURCED.test(line))) return "gcc";
  if (lines.some((line) => GO_DETECT.test(line))) return "go";
  return "raw";
}

/**
 * rustc's human output; cargo clippy's when `clippy` is set. An `E####` keeps its code;
 * a lint with no such code is coded by its level note. Under clippy a clippy lint is
 * coded `clippy::<name>` and cargo's `could not compile` trailer is not a finding.
 */
function parseRustc(lines: string[], clippy = false): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]?.match(RUSTC_HEAD);
    if (!head) continue;
    const [, levelWord, code, message] = head;
    if (RUSTC_SUMMARY.test(message ?? "")) continue; // summary trailer, not a diagnostic
    if (clippy && CARGO_TRAILER.test(message ?? "")) continue;
    const diagnostic: CompileDiagnostic = {
      message: message ?? "",
      level: levelWord === "error" ? "error" : "warning",
    };
    const lintCode = code === undefined ? lintName(lines, i + 1, clippy) : undefined;
    if (code !== undefined) diagnostic.code = code;
    else if (lintCode !== undefined) diagnostic.code = lintCode;
    const location = lines[i + 1]?.match(RUSTC_LOCATION);
    if (location) {
      diagnostic.file = location[1];
      diagnostic.line = Number(location[2]);
      diagnostic.col = Number(location[3]);
      i++;
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/**
 * The lint a diagnostic reports, read from its own lines (up to the next diagnostic head).
 * Under clippy a clippy lint's help URL wins, then its level note, kebab case read as snake
 * case; a quoted source line is never read. Otherwise rustc's own lint note names it.
 */
function lintName(lines: string[], from: number, clippy: boolean): string | undefined {
  let clippyNote: string | undefined;
  let rustcNote: string | undefined;
  for (let j = from; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (RUSTC_HEAD.test(line)) break;
    if (clippy) {
      const url = line.match(CLIPPY_URL);
      if (url) return `clippy::${snakeCase(url[1] ?? "")}`;
      const note = line.match(CLIPPY_NOTE);
      if (note && clippyNote === undefined) clippyNote = `clippy::${snakeCase(note[1] ?? "")}`;
    }
    const rustc = line.match(RUSTC_LINT_NOTE);
    if (rustc && rustcNote === undefined) rustcNote = snakeCase(rustc[1] ?? rustc[2] ?? "");
  }
  return clippyNote ?? rustcNote;
}

function snakeCase(name: string): string {
  return name.replaceAll("-", "_");
}

function parseRuff(lines: string[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of lines) {
    const match = line.match(RUFF_LINE);
    if (!match) continue;
    diagnostics.push({
      file: match[1] ?? "",
      line: Number(match[2]),
      col: Number(match[3]),
      code: match[4] ?? match[5] ?? "",
      message: match[6] ?? "",
      level: "error",
    });
  }
  return diagnostics;
}

function parseJavac(lines: string[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of lines) {
    const match = line.match(JAVAC_LINE);
    if (!match) continue;
    diagnostics.push({
      file: match[2] ?? "",
      line: Number(match[3]),
      col: Number(match[4]),
      message: match[5] ?? "",
      level: match[1] === "ERROR" ? "error" : "warning",
    });
  }
  return diagnostics;
}

function parsePython(lines: string[]): CompileDiagnostic[] {
  // Key off the LAST "File …, line N" frame, regardless of frame count.
  let lastFrame: RegExpMatchArray | null = null;
  let finalLine: string | undefined;
  for (const line of lines) {
    const frame = line.match(PYTHON_FRAME);
    if (frame) lastFrame = frame;
    if (PYTHON_FINAL.test(line)) finalLine = line;
  }
  if (!lastFrame || finalLine === undefined) return [];
  return [
    {
      file: lastFrame[1] ?? "",
      line: Number(lastFrame[2]),
      message: finalLine,
      level: "error",
    },
  ];
}

function parseTsc(lines: string[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of lines) {
    const match = line.match(TSC_LINE);
    if (!match) continue;
    diagnostics.push({
      file: match[1] ?? "",
      line: Number(match[2]),
      col: Number(match[3]),
      code: match[5] ?? "",
      message: match[6] ?? "",
      level: match[4] === "error" ? "error" : "warning",
    });
  }
  return diagnostics;
}

function parseGcc(lines: string[]): CompileDiagnostic[] {
  const sourced = lines.some((line) => GCC_LINK_SOURCED.test(line));
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of lines) {
    const compiler = line.match(GCC_DIAGNOSTIC);
    if (compiler) {
      const diagnostic: CompileDiagnostic = {
        file: compiler[1] ?? "",
        line: Number(compiler[2]),
        col: Number(compiler[3]),
        level: compiler[4] === "warning" ? "warning" : "error",
        message: compiler[5] ?? "",
      };
      const bracket = diagnostic.message.match(GCC_BRACKET);
      const code = bracket ? bracketCode(bracket[2] ?? "") : undefined;
      if (bracket && code !== undefined) {
        diagnostic.message = bracket[1] ?? "";
        diagnostic.code = code;
      }
      diagnostics.push(diagnostic);
      continue;
    }
    const link = line.match(GCC_LINK_SOURCED);
    if (link) {
      diagnostics.push({
        file: link[1] ?? "",
        line: Number(link[2]),
        level: "error",
        message: link[3] ?? "",
      });
      continue;
    }
    // An object-only link line is context beside a sourced one, else an error of its own.
    const object = sourced ? null : line.match(GCC_LINK_OBJECT);
    if (object) diagnostics.push({ level: "error", message: object[1] ?? "" });
  }
  return diagnostics;
}

/**
 * The code a trailing bracket names, or undefined when it is not a flag or check list.
 * A single item is the code as written. Of several comma-separated items the code is
 * the first that is not a flag (`-warnings-as-errors` is dropped); when every item is
 * a flag the whole bracket stays the code.
 */
function bracketCode(content: string): string | undefined {
  if (!content.startsWith("-") && /\s/.test(content)) return undefined;
  const items = content.split(",");
  if (items.length === 1) return content;
  return items.find((item) => item !== "" && !item.startsWith("-")) ?? content;
}

function parseGo(lines: string[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  let current: CompileDiagnostic | null = null;
  for (const line of lines) {
    if (current !== null && GO_CONTINUATION.test(line)) {
      current.message += `\n${line.replace(GO_CONTINUATION, "")}`;
      continue;
    }
    current = null;
    if (GO_NOT_DIAGNOSTIC.test(line)) continue;
    const match = line.match(GO_DIAGNOSTIC);
    if (!match) continue;
    const message = match[4] ?? "";
    if (message === GO_TOO_MANY) continue; // printed after the tenth error, not a diagnostic
    const diagnostic: CompileDiagnostic = {
      file: match[1] ?? "",
      line: Number(match[2]),
      message,
      level: "error",
    };
    if (match[3] !== undefined) diagnostic.col = Number(match[3]);
    diagnostics.push(diagnostic);
    current = diagnostic;
  }
  return diagnostics;
}

/**
 * A go report with no positioned diagnostic: one error from its lines that are not headers,
 * status lines or `go:` lines. A tab-indented line belongs to the line it follows, so it goes
 * with a `go:` line. When nothing else is left, the `go:` lines are the message.
 */
function goMessageOnly(lines: string[]): CompileDiagnostic {
  const kept: string[] = [];
  const goLines: string[] = [];
  let afterGoLine = false;
  for (const line of lines) {
    if (GO_CONTINUATION.test(line)) {
      const text = line.replace(GO_CONTINUATION, "");
      if (text.trim() !== "") (afterGoLine ? goLines : kept).push(text);
      continue;
    }
    afterGoLine = GO_TOOL_LINE.test(line);
    if (afterGoLine) goLines.push(line);
    else if (line.trim() !== "" && !GO_NOT_DIAGNOSTIC.test(line)) kept.push(line);
  }
  const message = (kept.length > 0 ? kept : goLines).join("\n");
  return { message, level: "error" };
}

/** Counts from conventional markers for unstructured ("raw") input. */
function rawCounts(errors: string): { errorCount: number; warningCount: number } {
  return {
    errorCount: (errors.match(/\berror\b/gi) ?? []).length,
    warningCount: (errors.match(/\bwarning\b/gi) ?? []).length,
  };
}

function rawReport(errors: string): CompileReport {
  const counts = rawCounts(errors);
  return {
    format: "raw",
    errorCount: counts.errorCount,
    warningCount: counts.warningCount,
    diagnostics: [],
    raw: errors,
  };
}

/**
 * Which decoders' "a failed build is never shown as clean" guards apply. Each
 * defaults to on; a caller that knows the run succeeded (a linter that exited
 * 0) turns one off so an empty or finding-free report stays clean.
 */
export interface CompileGuards {
  /** gcc: a report holding no error diagnostic falls back to raw. */
  gccNoErrorToRaw?: boolean;
  /** go: a report with no positioned diagnostic becomes one message-only error. */
  goMessageOnly?: boolean;
}

export function parseCompile(
  errors: string,
  formatHint?: string,
  guards: CompileGuards = {},
): CompileReport {
  try {
    const format = detectFormat(errors, formatHint);
    const lines = errors.split("\n");

    let diagnostics: CompileDiagnostic[];
    switch (format) {
      case "rustc":
        diagnostics = parseRustc(lines);
        break;
      case "clippy":
        diagnostics = parseRustc(lines, true);
        break;
      case "ruff":
        diagnostics = parseRuff(lines);
        break;
      case "javac":
        diagnostics = parseJavac(lines);
        break;
      case "python":
        diagnostics = parsePython(lines);
        break;
      case "tsc":
        diagnostics = parseTsc(lines);
        break;
      case "gcc":
        diagnostics = parseGcc(lines);
        // A gcc report with no error diagnostic is never shown as clean.
        if (guards.gccNoErrorToRaw !== false && !diagnostics.some((d) => d.level === "error")) {
          return rawReport(errors);
        }
        break;
      case "go":
        diagnostics = parseGo(lines);
        // A go report with no positioned diagnostic is still a failure, never shown as clean.
        if (guards.goMessageOnly !== false && diagnostics.length === 0) {
          diagnostics = [goMessageOnly(lines)];
        }
        break;
      default:
        return rawReport(errors);
    }

    return {
      format,
      errorCount: diagnostics.filter((d) => d.level === "error").length,
      warningCount: diagnostics.filter((d) => d.level === "warning").length,
      diagnostics,
      raw: errors,
    };
  } catch {
    // Never rejects: any parse failure degrades to the raw fallback.
    return { format: "raw", errorCount: 0, warningCount: 0, diagnostics: [], raw: errors };
  }
}
