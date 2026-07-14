// CR-CRU-002 §S2 — Compile codecs: parseCompile / detectFormat.
// Parses compiler error output (rustc / javac / python / tsc) into a CompileReport.
// Never rejects: unrecognized input falls back to format "raw".

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
};

const RUSTC_HEAD = /^(error|warning)(?:\[(E\d+)\])?:\s*(.*)$/;
const RUSTC_LOCATION = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
// ANY rustc summary trailer ("… generated N warnings") is excluded from diagnostics.
const RUSTC_SUMMARY = /generated \d+ warnings?/;
const JAVAC_LINE = /^\[(ERROR|WARNING)\]\s+(.+?):\[(\d+),(\d+)\]\s+(.*)$/;
const PYTHON_FRAME = /^\s*File "([^"]+)", line (\d+)/;
const PYTHON_FINAL = /^\w*(?:Error|Exception)\b.*$/;
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

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
  return "raw";
}

function parseRustc(lines: string[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]?.match(RUSTC_HEAD);
    if (!head) continue;
    const [, levelWord, code, message] = head;
    if (RUSTC_SUMMARY.test(message ?? "")) continue; // summary trailer, not a diagnostic
    const diagnostic: CompileDiagnostic = {
      message: message ?? "",
      level: levelWord === "error" ? "error" : "warning",
    };
    if (code !== undefined) diagnostic.code = code;
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

/** Counts from conventional markers for unstructured ("raw") input. */
function rawCounts(errors: string): { errorCount: number; warningCount: number } {
  return {
    errorCount: (errors.match(/\berror\b/gi) ?? []).length,
    warningCount: (errors.match(/\bwarning\b/gi) ?? []).length,
  };
}

export function parseCompile(errors: string, formatHint?: string): CompileReport {
  try {
    const format = detectFormat(errors, formatHint);
    const lines = errors.split("\n");

    let diagnostics: CompileDiagnostic[];
    switch (format) {
      case "rustc":
        diagnostics = parseRustc(lines);
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
      default: {
        const counts = rawCounts(errors);
        return {
          format: "raw",
          errorCount: counts.errorCount,
          warningCount: counts.warningCount,
          diagnostics: [],
          raw: errors,
        };
      }
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
