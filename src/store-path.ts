// Where the store is: the one rule that finds the server's database, and so
// the directory its own `crucible.toml` sits in.
//
// It lives apart from src/server.ts because two modules need it — the server,
// which opens the store, and src/limits.ts, which reads the configuration file
// beside it — and src/server.ts itself imports src/limits.ts. Held here, the
// rule is reached by both without either importing the other, so no module
// ever meets another half-loaded. It imports nothing of this project's own.

import { existsSync } from "node:fs";
import * as path from "node:path";

/** CR-CRU-043 §S1-§S3 — inputs to the DB path resolver (all defaulted). */
export interface ResolveDbPathOpts {
  /** Base directory for the rule-3 `./data/crucible.db` probe; defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment to read `CRUCIBLE_DB` / `XDG_DATA_HOME` / `HOME` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** An explicit path (including `":memory:"`), which outranks everything else. */
  dbPath?: string;
}

/** CR-CRU-068 §S1 — which of the four cascade rules picked the store. */
export type StoreRule = "explicit" | "CRUCIBLE_DB" | "cwd-data" | "user-data";

/** CR-CRU-068 §S1 — a resolved store path together with the rule that matched. */
export interface StoreResolution {
  path: string;
  rule: StoreRule;
}

/**
 * CR-CRU-043 §S1-§S3 — resolve the store path, first match wins:
 *   1. explicit `opts.dbPath` (returned verbatim, `":memory:"` included);
 *   2. `CRUCIBLE_DB`;
 *   3. an ALREADY-EXISTING `<cwd>/data/crucible.db` — adopt only, never created here,
 *      which is what keeps the live dog-food instance in use from the repo root;
 *   4. `<XDG_DATA_HOME or <HOME>/.local/share>/crucible/crucible.db`.
 *
 * CR-CRU-068 §S1 — reports WHICH rule matched alongside the path, so a surprising
 * store is explicable instead of merely observable. Rule 3 is CWD-relative, so the
 * same binary opens a different database depending on where it was launched from.
 *
 * Pure: computes a string and never touches the filesystem beyond the rule-3
 * existence probe. The `HOME` fallback deliberately reads `env.HOME` rather than
 * `os.homedir()` — Bun caches `HOME` at process startup, so `os.homedir()` cannot
 * observe an injected env and the contract would be untestable.
 */
export function resolveStore(opts?: ResolveDbPathOpts): StoreResolution {
  if (opts?.dbPath !== undefined) {
    return { path: opts.dbPath, rule: "explicit" };
  }
  const env = opts?.env ?? process.env;
  const fromEnv = env.CRUCIBLE_DB;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { path: fromEnv, rule: "CRUCIBLE_DB" };
  }
  const cwd = opts?.cwd ?? process.cwd();
  const cwdDb = path.join(cwd, "data", "crucible.db");
  if (existsSync(cwdDb)) {
    return { path: cwdDb, rule: "cwd-data" };
  }
  const xdg = env.XDG_DATA_HOME;
  const dataHome =
    xdg !== undefined && xdg !== "" ? xdg : path.join(env.HOME ?? "", ".local", "share");
  return { path: path.join(dataHome, "crucible", "crucible.db"), rule: "user-data" };
}
