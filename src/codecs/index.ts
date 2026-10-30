// CR-CRU-002 §S3 — codec registry. Ingest paths look up a codec by name so
// adding a codec never touches core.
import type { Coverage, RunSchema, SuiteNode } from "../types.ts";
import { coverageCodecs, decodeCoverage } from "./coverage.ts";
import type { CoverageCodec } from "./coverage.ts";
import { parseCrucibleEvents } from "./crucible-events.ts";
import { parseJunit, parseJunitPath, readJunitRawOutput } from "./junit.ts";
import { parsePlaywright, parsePlaywrightPath } from "./playwright.ts";

/**
 * What a codec is told about the run it decodes. `stack` is the run's
 * effective stack (the ingest's, else its start's), resolved before the codec
 * runs; `onSkip` hears of each report a path read skips as undecodable.
 */
export interface DecodeOptions {
  stack?: string;
  onSkip?: (report: string, error: string) => void;
  /** CR-CRU-200 §S1 — a stream codec's stream was cut at `ingest_body_bytes`. */
  cut?: boolean;
}

/**
 * A run as a codec decodes it: the run, plus the distinct files its cases
 * name. The files are counted in an ingest's response and never stored.
 */
export interface DecodedRun extends RunSchema {
  files?: string[];
  /** CR-CRU-200 §S1 — a stream codec's reasons its stream cannot be trusted; absent when none. */
  incomplete?: string;
}

export interface Codec {
  parse(data: string, options?: DecodeOptions): DecodedRun | Promise<DecodedRun>;
  parsePath?(path: string, options?: DecodeOptions): DecodedRun | Promise<DecodedRun>;
  /**
   * Reads the run's whole raw output into its decoded tree, before anything caps it;
   * returns the files the reading filed cases for, counted in the run's files.
   */
  readRaw?(tree: SuiteNode[], raw: string, options?: DecodeOptions): string[];
  /**
   * CR-CRU-200 §S1 — a STREAM codec: it decodes an open run's held stream
   * (`POST /api/v2/runs/<runId>/stream`), synchronously, at the run's close.
   */
  stream?: true;
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
      parse: (data: string, options?: DecodeOptions) => parseJunit(data, options?.stack),
      parsePath: (path: string, options?: DecodeOptions) =>
        parseJunitPath(path, options?.onSkip, options?.stack),
      readRaw: (tree: SuiteNode[], raw: string, options?: DecodeOptions) =>
        readJunitRawOutput(tree, raw, options?.stack),
    },
  ],
  [
    "playwright",
    {
      parse: (data: string) => parsePlaywright(data),
      parsePath: (path: string) => parsePlaywrightPath(path),
    },
  ],
  [
    "crucible-events",
    {
      parse: (data: string, options?: DecodeOptions) => parseCrucibleEvents(data, options?.cut === true),
      stream: true,
    },
  ],
]);

/** The names this board decodes, for health: test and coverage codecs, sorted. */
export function codecNames(): { test: string[]; coverage: string[] } {
  return { test: [...codecs.keys()].sort(), coverage: [...coverageCodecs.keys()].sort() };
}

interface CoverageBlock {
  name: string;
  codec: CoverageCodec;
  texts: unknown[];
}

/**
 * A body's `coverage` block, `{codec, data}` with `data` one text or a
 * non-empty list of them: absent, valid, or refused (the run is NOT stored).
 */
function readCoverageBlock(value: unknown): { block?: CoverageBlock } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") {
    return { error: "coverage must be {codec, data} — run NOT stored" };
  }
  const { codec: name, data } = value as { codec?: unknown; data?: unknown };
  if (typeof name !== "string") return { error: "coverage.codec is required — run NOT stored" };
  const codec = coverageCodecs.get(name);
  if (codec === undefined) return { error: `unknown coverage codec: ${name} — run NOT stored` };
  if (typeof data === "string") return { block: { name, codec, texts: [data] } };
  if (Array.isArray(data) && data.length > 0) return { block: { name, codec, texts: data } };
  return {
    error: "coverage.data must be a coverage text or a non-empty list of them — run NOT stored",
  };
}

/** The block's texts summed as one coverage; one undecodable text drops it, with a warning. */
function decodeCoverageBlock(block: CoverageBlock, warnings: IngestWarning[]): Coverage | undefined {
  try {
    const texts = block.texts.map((text, index) => {
      if (typeof text !== "string") throw new Error(`coverage text ${index} is not a text`);
      return text;
    });
    return decodeCoverage(block.codec, texts);
  } catch (cause) {
    warnings.push({
      code: "coverage-dropped",
      detail: `${block.name} coverage dropped: ${errorText(cause)}`,
    });
    return undefined;
  }
}

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

/** The run's counts recomputed from its (amended) tree; its duration kept. */
function recount(tree: SuiteNode[], durationMs: number): RunSchema["summary"] {
  const summary = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: durationMs };
  for (const suite of tree) {
    for (const leaf of suite.children) {
      summary.total += 1;
      if (leaf.status === "pass") summary.passed += 1;
      else if (leaf.status === "fail") summary.failed += 1;
      else summary.pending += 1;
    }
  }
  return summary;
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
 * {ok:false, error} contract instead of leaking a plain-text 500. `files` is
 * the count of distinct files the decoded reports name, across all of them;
 * it is answered, never stored.
 */
export async function parseRunBody(
  codec: Codec,
  body: { data?: unknown; dataPath?: unknown; raw?: unknown; coverage?: unknown },
  codecName: string,
  stack?: string,
): Promise<{ run: RunSchema; warnings: IngestWarning[]; files: number } | { error: string }> {
  const coverageBlock = readCoverageBlock(body.coverage);
  if ("error" in coverageBlock) return coverageBlock;
  const warnings: IngestWarning[] = [];
  const skip = (report: string, error: string): void => {
    warnings.push({ code: "report-skipped", detail: `report ${report} skipped: ${error}` });
  };
  const options: DecodeOptions = { ...(stack !== undefined ? { stack } : {}), onSkip: skip };
  const decoded: DecodedRun[] = [];
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
  return { ...assembleRun(codec, decoded, body, options, coverageBlock.block, warnings), warnings };
}

/**
 * CR-CRU-200 §S3 — a stream close's run: the run's held stream decoded by
 * the stream codec, SYNCHRONOUSLY so the store can decode it inside the
 * close's transaction, then read as `parseRunBody` reads a report — the
 * body's `raw` and `coverage` as today. `cut` tells the codec the board
 * refused a batch at `ingest_body_bytes`; `incomplete` is the codec's
 * reasons the stream cannot be trusted, absent when it states none.
 */
export function parseStreamBody(
  codec: Codec,
  held: { text: string; cut: boolean },
  body: { raw?: unknown; coverage?: unknown },
  codecName: string,
  stack?: string,
): { run: RunSchema; warnings: IngestWarning[]; files: number; incomplete?: string } | { error: string } {
  const coverageBlock = readCoverageBlock(body.coverage);
  if ("error" in coverageBlock) return coverageBlock;
  const warnings: IngestWarning[] = [];
  const options: DecodeOptions = { ...(stack !== undefined ? { stack } : {}), cut: held.cut };
  let decoded: DecodedRun | Promise<DecodedRun>;
  try {
    decoded = codec.parse(held.text, options);
  } catch (cause) {
    return { error: `${errorText(cause)} — run NOT stored` };
  }
  if (decoded instanceof Promise) {
    return { error: `codec ${codecName} does not decode a stream synchronously — run NOT stored` };
  }
  return {
    ...assembleRun(codec, [decoded], body, options, coverageBlock.block, warnings),
    warnings,
    ...(decoded.incomplete !== undefined ? { incomplete: decoded.incomplete } : {}),
  };
}

/**
 * The decoded reports as the run an ingest stores: merged, the raw output
 * read into the tree, and the coverage block decoded (a failure to decode it
 * is a warning). `files` is the count of distinct files the reports name.
 */
function assembleRun(
  codec: Codec,
  decoded: DecodedRun[],
  body: { raw?: unknown },
  options: DecodeOptions,
  coverageBlock: CoverageBlock | undefined,
  warnings: IngestWarning[],
): { run: RunSchema; files: number } {
  const merged = mergeRuns(decoded);
  const raw = joinRaw(body.raw, decoded.map((report) => report.raw));
  const files = new Set(decoded.flatMap((report) => report.files ?? []));
  let summary = merged.summary;
  if (raw !== undefined && codec.readRaw !== undefined) {
    for (const file of codec.readRaw(merged.tree, raw, options)) files.add(file);
    summary = recount(merged.tree, summary.duration_ms);
  }
  const coverage =
    coverageBlock !== undefined ? decodeCoverageBlock(coverageBlock, warnings) : merged.coverage;
  const run: RunSchema = {
    summary,
    tree: merged.tree,
    ...(coverage !== undefined ? { coverage } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
  return { run, files: files.size };
}
