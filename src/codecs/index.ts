// CR-CRU-002 §S3 — codec registry. Ingest paths look up a codec by name so
// adding a codec never touches core.
import type { RunSchema } from "../types.ts";
import { parseJunit, parseJunitPath } from "./junit.ts";

export interface Codec {
  parse(data: string): RunSchema | Promise<RunSchema>;
}

export const codecs: Map<string, Codec> = new Map<string, Codec>([
  ["junit", { parse: (data: string) => parseJunit(data) }],
]);

/**
 * Shared ingest core for the v1 shim and v2 runs routes: resolve the run from
 * inline `data` (via the codec) or `dataPath` (JUnit file/dir). Parse and
 * filesystem failures surface as an error string so callers keep the JSON
 * {ok:false, error} contract instead of leaking a plain-text 500.
 */
export async function parseRunBody(
  codec: Codec,
  body: { data?: unknown; dataPath?: unknown },
): Promise<{ run: RunSchema } | { error: string }> {
  try {
    if (typeof body.data === "string") {
      return { run: await codec.parse(body.data) };
    }
    if (typeof body.dataPath === "string") {
      return { run: await parseJunitPath(body.dataPath) };
    }
    return { error: "either data or dataPath is required" };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
