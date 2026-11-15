// A child `bun test` run is isolated from the checkout: it owns its test
// install, leaves nothing behind when it exits, never removes a parent's, and
// loads no `.env` from its working directory.
//
// Tier: integration. Each case starts ONE small child — `bun test` on a probe
// module this file writes — with no board, no socket and no client. The child
// runs in a working directory this test owns, under a `bunfig.toml` that is
// the repo's own with its relative paths made absolute (Bun reads `bunfig.toml`
// from the working directory only, so this is how the child gets the suite's
// real preload and the suite's real `.env` switch without running in the repo
// root, whose `.env` is the operator's). Its environment is built from nothing
// but PATH and HOME, so no marker, project dir or key of THIS process leaks in;
// its `TMPDIR` is an empty directory this test owns and checks afterwards.
//
//   - AC6 (bun half): a child with no marker CREATES an install named for its
//     own PID and its exit removes it — proved with the run-scoped temp root
//     on, and with `CRUCIBLE_TEST_TMPROOT_DISABLE=1` (the shape of
//     `run-scoped-temp-root.test.ts`), where nothing else would sweep it; a
//     child given a parent's marker REUSES that install and leaves it.
//   - The project-dir rule: the child's six `<STACK>_CRUCIBLE_PROJECT_DIR`
//     variables are overridden away from an inherited repo root, to one
//     directory the child owns and removes.
//   - AC9: a `.env` planted in the child's working directory does not reach
//     the child's `process.env` — the suite runs with `.env` loading off.
//
// The ownership rules themselves (sweep, liveness, exit hook) are proved in
// process in `the-bun-suite-runs-its-clients-from-a-test-install.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const HELPER_PATH = path.join(import.meta.dir, "helpers", "test-install.ts");
const HELPER_NAME = "tests/helpers/test-install.ts";
const TMPROOT_DISABLE_ENV = "CRUCIBLE_TEST_TMPROOT_DISABLE";
const CHILD_TIMEOUT_MS = 60_000;

const PROJECT_DIR_VARIABLES = [
  "PY_CRUCIBLE_PROJECT_DIR",
  "BUN_CRUCIBLE_PROJECT_DIR",
  "MVN_CRUCIBLE_PROJECT_DIR",
  "RUST_CRUCIBLE_PROJECT_DIR",
  "ARDUINO_CRUCIBLE_PROJECT_DIR",
  "GO_CRUCIBLE_PROJECT_DIR",
] as const;

let helper: Record<string, unknown> | null = null;
let helperLoadError = "";
try {
  helper = (await import(HELPER_PATH)) as Record<string, unknown>;
} catch (error) {
  helperLoadError = error instanceof Error ? error.message : String(error);
}

function surface<T>(name: string): T {
  if (helper === null) {
    throw new Error(
      `${HELPER_NAME} does not load (${helperLoadError}): the bun suite has no test install helper yet`,
    );
  }
  if (!(name in helper)) {
    throw new Error(`${HELPER_NAME} exports no \`${name}\`: the bun suite has no test install ${name} yet`);
  }
  return helper[name] as T;
}

/** What the probe module reports from inside the child, while it is alive. */
interface Seen {
  pid: number;
  install: string | null;
  clientsIsLink: boolean;
  hasConfig: boolean;
  projectDirs: Record<string, string | null>;
  projectDirsExist: boolean;
  hasProjectKey: boolean;
  hasDotenvCanary: boolean;
  passedThrough: string | null;
}

const PROBE_MODULE = [
  'import { test } from "bun:test";',
  'import { existsSync, lstatSync, writeFileSync } from "node:fs";',
  'import * as path from "node:path";',
  `const VARIABLES = ${JSON.stringify(PROJECT_DIR_VARIABLES)};`,
  'test("probe", () => {',
  '  const markerName = process.env.PROBE_MARKER ?? "";',
  "  const install = markerName ? (process.env[markerName] ?? null) : null;",
  "  const projectDirs: Record<string, string | null> = {};",
  "  for (const variable of VARIABLES) projectDirs[variable] = process.env[variable] ?? null;",
  '  const link = install === null ? "" : path.join(install, "clients");',
  "  writeFileSync(String(process.env.PROBE_OUT), JSON.stringify({",
  "    pid: process.pid,",
  "    install,",
  "    clientsIsLink: link !== \"\" && existsSync(link) && lstatSync(link).isSymbolicLink(),",
  '    hasConfig: install !== null && existsSync(path.join(install, "crucible.toml")),',
  "    projectDirs,",
  "    projectDirsExist: Object.values(projectDirs).every((d) => d !== null && existsSync(d)),",
  '    hasProjectKey: "CRUCIBLE_PROJECT_KEY" in process.env,',
  '    hasDotenvCanary: "CRUCIBLE_DOTENV_CANARY" in process.env,',
  "    passedThrough: process.env.PROBE_PASSED_THROUGH ?? null,",
  "  }));",
  "});",
  "",
].join("\n");

/** The repo's own `bunfig.toml`, its relative paths made absolute so a child
 *  started in another directory runs under exactly the suite's configuration. */
function suiteBunfig(): string {
  return readFileSync(path.join(REPO_ROOT, "bunfig.toml"), "utf8").replaceAll('"./', `"${REPO_ROOT}/`);
}

let owned = "";
let work = "";
let childTemp = "";

beforeEach(() => {
  owned = mkdtempSync(path.join(tmpdir(), "child-bun-test-isolation-"));
  work = path.join(owned, "work");
  childTemp = path.join(owned, "temp");
  mkdirSync(work);
  mkdirSync(childTemp);
  writeFileSync(path.join(work, "bunfig.toml"), suiteBunfig());
  writeFileSync(path.join(work, "probe.test.ts"), PROBE_MODULE);
});

afterEach(() => {
  rmSync(owned, { recursive: true, force: true });
});

interface ChildRun {
  exitCode: number | null;
  stderr: string;
  seen: Seen | null;
}

/** ONE child `bun test` of the probe, in `work`, with `TMPDIR` = `childTemp`
 *  and an environment of PATH, HOME and `extra` only. */
function runChild(extra: Record<string, string>): ChildRun {
  const out = path.join(owned, "probe-out.json");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: childTemp,
    PROBE_OUT: out,
    ...extra,
  };
  const child = Bun.spawnSync({
    cmd: [process.execPath, "test", path.join(work, "probe.test.ts")],
    cwd: work,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const seen = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Seen) : null;
  return { exitCode: child.exitCode, stderr: child.stderr.toString(), seen };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Every inherited project-dir variable pointed at the repo root: the child's
 *  preload must override them, never take them. */
function repoRootProjectDirs(): Record<string, string> {
  return Object.fromEntries(PROJECT_DIR_VARIABLES.map((variable) => [variable, REPO_ROOT]));
}

function assertCreatedAndRemoved(run: ChildRun, opts: { directlyUnderTemp: boolean }): void {
  const prefix = surface<string>("TEST_INSTALL_PREFIX");
  expect(run.seen === null ? `the probe reported nothing: ${run.stderr.slice(-1500)}` : "reported").toBe("reported");
  const seen = run.seen as Seen;
  expect(run.exitCode).toBe(0);

  // The child created its OWN install, named for its own PID, under its temp root.
  expect(seen.install === null ? "no install" : "an install").toBe("an install");
  const install = seen.install ?? "";
  expect(isInside(install, childTemp)).toBe(true);
  if (opts.directlyUnderTemp) expect(path.dirname(install)).toBe(childTemp);
  expect(path.basename(install).startsWith(`${prefix}${String(seen.pid)}-`)).toBe(true);
  expect(seen.clientsIsLink).toBe(true);
  expect(seen.hasConfig).toBe(true);

  // Its six project-dir variables were overridden away from the inherited
  // repo root, to one directory that existed while the child ran.
  const dirs = Object.values(seen.projectDirs);
  expect(dirs.includes(REPO_ROOT)).toBe(false);
  expect(new Set(dirs).size).toBe(1);
  expect(seen.projectDirsExist).toBe(true);

  // Its exit removed the install and its project directory: the temp root it
  // was handed is exactly as empty as it was before.
  expect(existsSync(install)).toBe(false);
  expect(existsSync(dirs[0] ?? "")).toBe(false);
  expect(readdirSync(childTemp)).toEqual([]);
}

describe("a child bun test run owns the test install it creates", () => {
  test(
    "with the run-scoped temp root disabled, a child with no marker creates its own install and its exit removes it",
    () => {
      const marker = surface<string>("TEST_INSTALL_MARKER");
      const run = runChild({ PROBE_MARKER: marker, [TMPROOT_DISABLE_ENV]: "1", ...repoRootProjectDirs() });
      assertCreatedAndRemoved(run, { directlyUnderTemp: true });
    },
    CHILD_TIMEOUT_MS,
  );

  test(
    "with the run-scoped temp root on, a child with no marker creates its own install and leaves its temp root empty",
    () => {
      const marker = surface<string>("TEST_INSTALL_MARKER");
      const run = runChild({ PROBE_MARKER: marker, ...repoRootProjectDirs() });
      assertCreatedAndRemoved(run, { directlyUnderTemp: false });
    },
    CHILD_TIMEOUT_MS,
  );

  test(
    "a child given its parent's marker reuses the parent's install and its exit leaves it in place",
    () => {
      const marker = surface<string>("TEST_INSTALL_MARKER");
      const prefix = surface<string>("TEST_INSTALL_PREFIX");
      // The "parent's" install: named for THIS (live) process, its `clients`
      // a link to a canary this test owns — a removal must not follow it.
      const parentsDir = path.join(owned, "parents");
      mkdirSync(parentsDir);
      const parents = path.join(parentsDir, `${prefix}${String(process.pid)}-parents`);
      mkdirSync(parents);
      const canary = path.join(owned, "canary");
      mkdirSync(canary);
      writeFileSync(path.join(canary, "kept.py"), "# canary\n");
      symlinkSync(canary, path.join(parents, "clients"), "dir");
      writeFileSync(path.join(parents, "crucible.toml"), "");

      const run = runChild({ PROBE_MARKER: marker, [marker]: parents, [TMPROOT_DISABLE_ENV]: "1" });

      expect(run.seen === null ? `the probe reported nothing: ${run.stderr.slice(-1500)}` : "reported").toBe(
        "reported",
      );
      expect(run.exitCode).toBe(0);
      expect(run.seen?.install).toBe(parents);
      expect(lstatSync(parents).isDirectory()).toBe(true);
      expect(lstatSync(path.join(parents, "clients")).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(parents, "crucible.toml"))).toBe(true);
      expect(existsSync(path.join(canary, "kept.py"))).toBe(true);
      expect(readdirSync(parentsDir)).toEqual([path.basename(parents)]);
      expect(readdirSync(childTemp).filter((name) => name.startsWith(prefix))).toEqual([]);
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("a child bun test run loads no .env from its working directory", () => {
  test(
    "a .env planted in the working directory does not reach the child's process.env, while its real environment does",
    () => {
      writeFileSync(
        path.join(work, ".env"),
        `CRUCIBLE_PROJECT_KEY=${crypto.randomUUID()}\nCRUCIBLE_DOTENV_CANARY=planted\n`,
      );

      const run = runChild({ PROBE_PASSED_THROUGH: "through-the-environment" });

      expect(run.seen === null ? `the probe reported nothing: ${run.stderr.slice(-1500)}` : "reported").toBe(
        "reported",
      );
      // Control: the probe does see what the child's real environment carries.
      expect(run.seen?.passedThrough).toBe("through-the-environment");
      // The planted file's variables are absent: .env loading is off.
      expect(run.seen?.hasProjectKey).toBe(false);
      expect(run.seen?.hasDotenvCanary).toBe(false);
    },
    CHILD_TIMEOUT_MS,
  );
});
