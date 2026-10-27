// CR-CRU-002 §S3 — codec registry. Ingest paths look up a codec by name so
// adding a codec never touches core.
import type { RunSchema } from "../types.ts";
import { parseJunit, parseJunitPath } from "./junit.ts";
import { parsePlaywright, parsePlaywrightPath } from "./playwright.ts";

/**
 * What a codec is told about the run it decodes. `stack` is the run's
 * effective stack (the ingest's, else its start's), resolved before the codec
 * runs; `onSkip` hears of each report a path read skips as undecodable.
 */
export interface DecodeOptions {
  stack?: string;
  onSkip?: (report: string, error: string) => void;
}

export interface Codec {
  parse(data: string, options?: DecodeOptions): RunSchema | Promise<RunSchema>;
  parsePath?(path: string, options?: DecodeOptions): RunSchema | Promise<RunSchema>;
}

/** One `warnings[]` entry of an ingest response, the shape the client envelopes use. */
export interface IngestWarning {
  code: string;
  detail: string;
}

export const codecs: Map<string, Codec> = new Map<string, Codec>([
  [
    "junit",
    {
      parse: (data: string) => parseJunit(data),
      parsePath: (path: string, options?: DecodeOptions) => parseJunitPath(path, options?.onSkip),
    },
  ],
  [
    "playwright",
    {
      parse: (data: string) => parsePlaywright(data),
      parsePath: (path: string) => parsePlaywrightPath(path),
    },
  ],
]);

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Several decoded reports as ONE run: tree nodes in report order, counts summed. */
function mergeRuns(runs: RunSchema[]): RunSchema {
  if (runs.length === 1) return runs[0]!;
  const summary = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 };
  for (const run of runs) {
    summary.total += run.summary.total;
    summary.passed += run.summary.passed;
    summary.failed += run.summary.failed;
    summary.pending += run.summary.pending;
    summary.duration_ms += run.summary.duration_ms;
  }
  return { summary, tree: runs.flatMap((run) => run.tree) };
}

/**
 * The run's raw output: the body's `raw`, then each decoded report's own
 * output in report order — each part trimmed, empty parts dropped, the rest
 * joined by "\n". Absent when no part is left.
 */
function joinRaw(bodyRaw: unknown, reportRaws: Array<string | undefined>): string | undefined {
  const parts = [typeof bodyRaw === "string" ? bodyRaw : undefined, ...reportRaws]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Shared ingest core for the v2 runs route: resolve the run from inline
 * `data` — one report text or a non-empty list of them, decoded in list order
 * and merged into one run — or from `dataPath` (via the codec's optional
 * `parsePath` — CR-CRU-010 §S1: registry-only resolution), under the run's effective `stack`.
 * A report that cannot be decoded is skipped and named in `warnings`; when no
 * report decodes, or the list is empty, the run is refused. Parse and
 * filesystem failures surface as an error string so callers keep the JSON
 * {ok:false, error} contract instead of leaking a plain-text 500.
 */
export async function parseRunBody(
  codec: Codec,
  body: { data?: unknown; dataPath?: unknown; raw?: unknown },
  codecName: string,
  stack?: string,
): Promise<{ run: RunSchema; warnings: IngestWarning[] } | { error: string }> {
  const warnings: IngestWarning[] = [];
  const skip = (report: string, error: string): void => {
    warnings.push({ code: "report-skipped", detail: `report ${report} skipped: ${error}` });
  };
  const options: DecodeOptions = { ...(stack !== undefined ? { stack } : {}), onSkip: skip };
  const decoded: RunSchema[] = [];
  try {
    if (typeof body.data === "string") {
      decoded.push(await codec.parse(body.data, options));
    } else if (Array.isArray(body.data)) {
      if (body.data.length === 0) {
        return { error: "data must be a report text or a non-empty list of them — run NOT stored" };
      }
      for (const [index, text] of body.data.entries()) {
        if (typeof text !== "string") {
          skip(String(index), "not a report text");
          continue;
        }
        try {
          decoded.push(await codec.parse(text, options));
        } catch (cause) {
          skip(String(index), errorText(cause));
        }
      }
      if (decoded.length === 0) {
        const details = warnings.map((w) => w.detail).join("; ");
        return { error: `no report in data could be decoded (${details}) — run NOT stored` };
      }
    } else if (typeof body.dataPath === "string") {
      if (codec.parsePath === undefined) {
        return { error: `codec ${codecName} does not support dataPath` };
      }
      decoded.push(await codec.parsePath(body.dataPath, options));
    } else {
      return { error: "either data or dataPath is required" };
    }
  } catch (cause) {
    return { error: errorText(cause) };
  }
  const merged = mergeRuns(decoded);
  const raw = joinRaw(body.raw, decoded.map((report) => report.raw));
  const run: RunSchema = {
    summary: merged.summary,
    tree: merged.tree,
    ...(merged.coverage !== undefined ? { coverage: merged.coverage } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
  return { run, warnings };
}
