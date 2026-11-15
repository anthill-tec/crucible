// The bun suite cannot reach the live project.
//
// Every client resolves its project as `--project-dir`, else its own
// `<STACK>_CRUCIBLE_PROJECT_DIR`, else the git repo of its working directory.
// This repo's root holds the operator's `.env` and `crucible.toml`, which name
// the LIVE project on the development board, and a project's files come before
// the install's — so a client a bun test spawns from the repo root with no
// `--project-dir` resolves the repo root as its project, test install or not.
//
// The bun preload (`tests/helpers/isolated-store-preload.ts`) therefore points
// all six variables at one fresh, empty directory it owns, overriding any
// inherited value, exactly as `tests/client/__init__.py` does for the python
// suite (guarded there by `test_the_client_suite_cannot_reach_the_live_project`).
// This guard reads the environment the suite's own process carries — it never
// sets a variable itself.
//
// Tier: unit. It reads this process's environment and stats one directory.
// Hygiene: no message prints any environment value but the isolation
// directory's own path, and no `.env` is ever opened — the isolation directory
// is checked only for the ABSENCE of the two files.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The six client-steering variables, one per stack. */
const PROJECT_DIR_VARIABLES = [
  "PY_CRUCIBLE_PROJECT_DIR",
  "BUN_CRUCIBLE_PROJECT_DIR",
  "MVN_CRUCIBLE_PROJECT_DIR",
  "RUST_CRUCIBLE_PROJECT_DIR",
  "ARDUINO_CRUCIBLE_PROJECT_DIR",
  "GO_CRUCIBLE_PROJECT_DIR",
] as const;

/** The two files that make a directory a Crucible project. */
const PROJECT_FILES = [".env", "crucible.toml"] as const;

function real(p: string): string {
  return existsSync(p) ? realpathSync(path.resolve(p)) : path.resolve(p);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** What each variable names in this process, or `null` when unset — the
 *  values themselves never reach a message. */
function named(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const variable of PROJECT_DIR_VARIABLES) {
    const value = process.env[variable];
    out[variable] = value ? real(value) : null;
  }
  return out;
}

describe("the bun suite cannot reach the live project — the preload's project-dir rule", () => {
  test("all six <STACK>_CRUCIBLE_PROJECT_DIR variables are set in the suite's own process", () => {
    const unset = PROJECT_DIR_VARIABLES.filter((variable) => !process.env[variable]);
    expect(unset).toEqual([]);
  });

  test("the six variables name ONE directory", () => {
    const values = Object.values(named());
    expect(values.includes(null)).toBe(false);
    expect(new Set(values).size).toBe(1);
  });

  for (const variable of PROJECT_DIR_VARIABLES) {
    test(`${variable} names neither the repo root nor any directory inside the repo`, () => {
      const value = named()[variable] ?? null;
      expect(value === null ? "unset" : "set").toBe("set");
      if (value === null) return;
      expect(value === real(REPO_ROOT) ? "the repo root" : "elsewhere").toBe("elsewhere");
      expect(isInside(value, real(REPO_ROOT)) ? "inside the repo" : "outside the repo").toBe("outside the repo");
    });
  }

  test("the directory they name exists and holds no project: no .env, no crucible.toml", () => {
    const values = Object.values(named());
    expect(values.includes(null)).toBe(false);
    const directory = values[0] ?? "";
    expect(existsSync(directory) && lstatSync(directory).isDirectory()).toBe(true);
    const present = PROJECT_FILES.filter((name) => existsSync(path.join(directory, name)));
    expect(present).toEqual([]);
  });
});
