// CR-CRU-002 §S3 — codec registry. Ingest paths look up a codec by name so
// adding a codec never touches core.
import type { RunSchema } from "../types.ts";
import { parseJunit } from "./junit.ts";

export interface Codec {
  parse(data: string): RunSchema | Promise<RunSchema>;
}

export const codecs: Map<string, Codec> = new Map<string, Codec>([
  ["junit", { parse: (data: string) => parseJunit(data) }],
]);
