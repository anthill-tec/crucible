// TEST TARGETS — which files are unit and which are integration, DERIVED.
//
// WHY TARGETS EXIST. Measured 2026-09-08 with `bun test --reporter=junit` over
// this repo: 2183 tests in 525s, of which 81 files (993 tests) finished in
// 5.4s while 13 files took 302s — 58% of the run. An agent checking a pure
// function paid for a browser launch, ~168 `python3` spawns, seven throwaway
// HTTP servers and five ~11s timer waits. The targets give that agent a switch:
// `unit` for a quick check on code, `integration` for behaviour that needs the
// real thing, `regression` for both plus the python client suite.
//
// MEMBERSHIP IS DERIVED, NEVER LISTED. A hand-maintained manifest drifts the
// moment someone adds a test, and a file missing from every target would be a
// test nothing runs — the same hazard `bunfig.toml`'s no-`pathIgnorePatterns`
// rule (CR-CRU-047 §S1, guarded by tests/suite-integrity.test.ts) exists to
// prevent, one level up. So a file is INTEGRATION iff its source names one of
// the markers below, and `unit` is the COMPLEMENT — every file on disk is in
// exactly one target by construction, and a new browser test is integration on
// the day it is written without anyone editing a list.
//
// THE TARGETS ARE ADDITIVE, NOT EXCLUSIONS. `bunfig.toml` still carries no
// discovery exclusion and a bare `bun test` still collects all 152 files;
// `regression` runs the whole suite in one invocation exactly as before. A
// target narrows ONE invocation by naming paths, which is what `bun test`
// already supports.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

export const REPO_ROOT = path.dirname(import.meta.dir);

/** What makes a test file INTEGRATION, with the cost each marker buys.
 *  Every entry was measured in the 2026-09-08 census, not guessed. */
export const INTEGRATION_MARKERS = [
  // Launches real Chromium through Playwright — the only such file today
  // (tests/roadmap-visual-grammar.test.ts, 90 tests, 13.5s).
  "chromium.launch",
  // Spawns real processes: the client fleet's `--help` surfaces and the
  // narration/provenance suites (20 files, 99s).
  "Bun.spawn",
  "spawnSync",
  // Stands up a throwaway HTTP server on a real port (7 files).
  "Bun.serve",
  // Corroborates against the LIVE board, which must be running (12 files).
  "3849",
] as const;

export type TargetName = "unit" | "integration";

//
// CLASSIFICATION READS RAW TEXT, and that is deliberate. A marker mentioned in
// a comment or a string classifies the file as integration even if it never
// calls the thing — the error direction is a file in the SLOWER bucket, never a
// browser test hiding in the fast one. (Proven on arrival: the partition
// guard's own header quoted a marker and the guard duly refused to sit in
// `unit` until the prose was reworded.)
//
// A SECOND DIMENSION, added after measuring the first one wrong: waiting on
// REAL TIME. The marker list alone put `unit` at 1440 tests in 257s, because
// tests/cycle-timers.test.ts spawns nothing, serves nothing and launches
// nothing — it just sleeps through five ~11s production timers. A test that
// observes the app's own clock (a 5s poll tick, a 10s badge cadence) is
// behavioural by nature: its subject IS elapsed time. So a file declaring any
// wait of a second or more is integration too, and `unit` means "no browser,
// no process, no server, no live board AND no waiting".
const REAL_WAIT = /(?:setTimeout|setInterval|Bun\.sleep|sleep)\s*\(\s*[^,)]*,?\s*([\d_]+)\s*\)/g;
const NAMED_WAIT = /(?:MS|INTERVAL|WAIT|TIMEOUT|CADENCE)\w*\s*=\s*([\d_]+)/g;

/** Does the file wait on real time — a second or more, anywhere? */
export function declaresRealWait(source: string): boolean {
  for (const pattern of [REAL_WAIT, NAMED_WAIT]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (Number(match[1]?.replaceAll("_", "") ?? "0") >= 1_000) return true;
    }
  }
  return false;
}

/** PURE — the rule, over a file's own source. */
export function classifyTestSource(source: string): TargetName {
  const namesMarker = INTEGRATION_MARKERS.some((marker) => source.includes(marker));
  return namesMarker || declaresRealWait(source) ? "integration" : "unit";
}

/** Every `.test.ts` under `tests/`, repo-relative, sorted. */
export async function enumerateTestFiles(root = path.join(REPO_ROOT, "tests")): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)))
    .sort();
}

export interface Partition {
  unit: string[];
  integration: string[];
}

/** The partition, read off the files themselves. */
export async function partitionTestFiles(files?: string[]): Promise<Partition> {
  const all = files ?? (await enumerateTestFiles());
  const partition: Partition = { unit: [], integration: [] };
  for (const file of all) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    partition[classifyTestSource(source)].push(file);
  }
  return partition;
}
