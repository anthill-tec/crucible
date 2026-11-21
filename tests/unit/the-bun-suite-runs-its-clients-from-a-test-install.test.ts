// The bun suite reaches its clients through a TEST INSTALL it owns, never
// through the checkout's own `clients/`.
//
// A client derives its install dir from its own location (`_INSTALL_DIR`,
// `dirname(abspath(__file__))`), so a client spawned from the checkout takes
// the REPO ROOT as its install and reads the operator's git-ignored root
// `crucible.toml`: its board, its limits, its `[lint]` and `[run]` tables. The
// TypeScript half of the harness therefore lays down, once per run, a
// temporary install directory outside the repo holding a `clients` symlink to
// the checkout's client source and a `crucible.toml` of its own that declares
// nothing. It is wired through the preload (`tests/helpers/isolated-store-
// preload.ts`), mirrors the python package `tests/client/__init__.py`, and
// lives in `tests/helpers/test-install.ts`.
//
// Tier: unit. Everything here runs in this process over directories this file
// owns. The PID-liveness check and the exit hook are passed in as recording
// fakes: no process is started, none is signalled, nothing waits on real
// time. The one leg that needs a real child (an exit leaves no install
// behind) is `a-child-bun-test-run-is-isolated-from-the-checkout.test.ts`.
//
// The helper's surface, as these tests pin it:
//
//   TEST_INSTALL_PREFIX     the fixed name prefix; the creator's PID follows it
//   TEST_INSTALL_MARKER     the environment variable naming the run's install
//   CLIENT_SOURCE_DIR       the checkout's client source — to READ client
//                           source or COPY it, never to load or spawn
//   TEST_INSTALL_DIR        this run's test install
//   TEST_INSTALL_CLIENTS    `<TEST_INSTALL_DIR>/clients`
//   TEST_INSTALL_CONFIG     `<TEST_INSTALL_DIR>/crucible.toml`
//   clientScript(name)      `<TEST_INSTALL_CLIENTS>/<name>` — the path to spawn
//   pidAlive(pid)           the real liveness check (signal 0)
//   installOwnerPid(name)   the creator PID a prefixed name carries, or null
//   sweepDeadInstalls(directory, pidAlive)
//                           removes every prefixed install in `directory`
//                           whose PID is dead; answers the removed paths, sorted
//   establishTestInstall(environ, { pid, pidAlive, atExit, tempRoot })
//                           the install `environ`'s marker names when it
//                           exists (nothing registered); else a new one under
//                           `tempRoot` named `<prefix><pid>-…`, created after
//                           sweeping `tempRoot`, its removal registered once
//                           through `atExit`, the marker set in `environ` only
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const HELPER_PATH = path.join(import.meta.dir, "../helpers", "test-install.ts");
const HELPER_NAME = "tests/helpers/test-install.ts";

/** PIDs no live process carries (above every Linux `pid_max`); the liveness
 *  seam decides, so nothing is ever signalled with them. */
const DEAD_PID = 999_999_901;
const LIVE_PID = 999_999_902;
const CREATOR_PID = 999_999_903;

let helper: Record<string, unknown> | null = null;
let helperLoadError = "";
try {
  helper = (await import(HELPER_PATH)) as Record<string, unknown>;
} catch (error) {
  helperLoadError = error instanceof Error ? error.message : String(error);
}

/** One export of the helper, or a failure naming what is missing. */
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

type PidAlive = (pid: number) => boolean;
type Establish = (
  environ: Record<string, string | undefined>,
  opts: { pid: number; pidAlive: PidAlive; atExit: (remove: () => void) => void; tempRoot: string },
) => string;

/** A recording liveness seam: alive for `pids`, dead otherwise. */
function aliveOnly(...pids: number[]): PidAlive & { asked: number[] } {
  const asked: number[] = [];
  const check = ((pid: number) => {
    asked.push(pid);
    return pids.includes(pid);
  }) as PidAlive & { asked: number[] };
  check.asked = asked;
  return check;
}

/** Records what `establishTestInstall` registers to run at exit. */
class ExitHook {
  readonly calls: Array<() => void> = [];
  readonly register = (remove: () => void): void => {
    this.calls.push(remove);
  };
  run(): void {
    for (const remove of this.calls) remove();
  }
}

function real(p: string): string {
  return realpathSync(path.resolve(p));
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

describe("the bun suite's test install — its surface", () => {
  test("the client source constant names the checkout's own client directory, by absolute path", () => {
    const source = surface<string>("CLIENT_SOURCE_DIR");
    expect(path.isAbsolute(source)).toBe(true);
    expect(path.dirname(source)).toBe(REPO_ROOT);
    expect(path.basename(source)).toBe("clients");
    expect(existsSync(path.join(source, "_crucible_axi.py"))).toBe(true);
  });

  test("this run's test install lives outside the repo, under the run's temp root, named for the process that created it", () => {
    const prefix = surface<string>("TEST_INSTALL_PREFIX");
    const ownerOf = surface<(name: string) => number | null>("installOwnerPid");
    const root = surface<string>("TEST_INSTALL_DIR");

    expect(path.isAbsolute(root)).toBe(true);
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(isInside(real(root), real(REPO_ROOT))).toBe(false);
    expect(isInside(real(root), real(tmpdir()))).toBe(true);
    const owner = ownerOf(path.basename(root));
    expect(typeof owner).toBe("number");
    expect(path.basename(root).startsWith(`${prefix}${String(owner)}-`)).toBe(true);
  });

  test("the run's marker variable names this process's test install, so a child process reuses it", () => {
    const marker = surface<string>("TEST_INSTALL_MARKER");
    const root = surface<string>("TEST_INSTALL_DIR");
    expect(process.env[marker]).toBe(root);
  });

  test("the test install's clients entry is a symlink to the checkout's client source, and the constant names it", () => {
    const root = surface<string>("TEST_INSTALL_DIR");
    const clients = surface<string>("TEST_INSTALL_CLIENTS");
    const source = surface<string>("CLIENT_SOURCE_DIR");

    expect(path.dirname(clients)).toBe(root);
    expect(path.basename(clients)).toBe("clients");
    expect(lstatSync(clients).isSymbolicLink()).toBe(true);
    expect(real(clients)).toBe(real(source));
  });

  test("the test install's crucible.toml declares nothing: no [client] url, no [lint] or [run] table, no limits", () => {
    const root = surface<string>("TEST_INSTALL_DIR");
    const config = surface<string>("TEST_INSTALL_CONFIG");

    expect(config).toBe(path.join(root, "crucible.toml"));
    expect(lstatSync(config).isFile()).toBe(true);
    const declared = Bun.TOML.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    expect(declared).toEqual({});
  });

  test("a client script is spawned from the test install, never from the client source", () => {
    const clientScript = surface<(name: string) => string>("clientScript");
    const clients = surface<string>("TEST_INSTALL_CLIENTS");
    const source = surface<string>("CLIENT_SOURCE_DIR");

    const script = clientScript("bun-crucible.py");
    expect(script).toBe(path.join(clients, "bun-crucible.py"));
    expect(script.startsWith(`${source}/`)).toBe(false);
    expect(isInside(script, REPO_ROOT)).toBe(false);
    // Reached through the link, the script is the checkout's own file.
    expect(real(script)).toBe(real(path.join(source, "bun-crucible.py")));
  });
});

/** A parent directory the test owns, holding planted installs. */
let parent = "";

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "test-install-ownership-"));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/** A prefixed install holding a `clients` symlink to a canary directory this
 *  test owns: removing the install must never follow the link. */
function plantInstall(pid: number, suffix = "planted"): { install: string; canary: string } {
  const prefix = surface<string>("TEST_INSTALL_PREFIX");
  const install = path.join(parent, `${prefix}${String(pid)}-${suffix}`);
  mkdirSync(install);
  const canary = path.join(parent, `canary-${String(pid)}-${suffix}`);
  mkdirSync(canary);
  writeFileSync(path.join(canary, "kept.py"), "# canary\n");
  symlinkSync(canary, path.join(install, "clients"), "dir");
  writeFileSync(path.join(install, "crucible.toml"), "");
  return { install, canary };
}

function prefixedEntries(): string[] {
  const prefix = surface<string>("TEST_INSTALL_PREFIX");
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

describe("the bun suite's test install — a name carries its creator", () => {
  test("the owner PID is read back from a prefixed name or path", () => {
    const prefix = surface<string>("TEST_INSTALL_PREFIX");
    const ownerOf = surface<(name: string) => number | null>("installOwnerPid");
    expect(ownerOf(`${prefix}${String(DEAD_PID)}-abc123`)).toBe(DEAD_PID);
    expect(ownerOf(path.join(parent, `${prefix}42-x`))).toBe(42);
  });

  test("a name without the prefix, or without a numeric PID, has no owner", () => {
    const prefix = surface<string>("TEST_INSTALL_PREFIX");
    const ownerOf = surface<(name: string) => number | null>("installOwnerPid");
    expect(ownerOf(`other-${String(DEAD_PID)}-abc`)).toBeNull();
    expect(ownerOf(`${prefix}notapid-abc`)).toBeNull();
    expect(ownerOf(prefix)).toBeNull();
  });
});

describe("the bun suite's test install — the sweep removes only a dead run's install", () => {
  test("an install whose PID is dead is removed and one whose PID is alive is kept, and neither link is followed", () => {
    const sweep = surface<(directory: string, pidAlive: PidAlive) => string[]>("sweepDeadInstalls");
    const dead = plantInstall(DEAD_PID);
    const live = plantInstall(LIVE_PID);
    const pidAlive = aliveOnly(LIVE_PID);

    const removed = sweep(parent, pidAlive);

    expect(removed.map((p) => path.resolve(p))).toEqual([dead.install]);
    expect(existsSync(dead.install)).toBe(false);
    expect(lstatSync(path.join(live.install, "clients")).isSymbolicLink()).toBe(true);
    expect([...new Set(pidAlive.asked)].sort()).toEqual([DEAD_PID, LIVE_PID]);
    expect(existsSync(path.join(dead.canary, "kept.py"))).toBe(true);
    expect(existsSync(path.join(live.canary, "kept.py"))).toBe(true);
  });

  test("the sweep leaves an entry it cannot attribute and one that is not an install", () => {
    const sweep = surface<(directory: string, pidAlive: PidAlive) => string[]>("sweepDeadInstalls");
    const prefix = surface<string>("TEST_INSTALL_PREFIX");
    const unattributed = path.join(parent, `${prefix}notapid-x`);
    mkdirSync(unattributed);
    const foreign = path.join(parent, `someone-elses-${String(DEAD_PID)}-x`);
    mkdirSync(foreign);

    const removed = sweep(parent, aliveOnly());

    expect(removed).toEqual([]);
    expect(lstatSync(unattributed).isDirectory()).toBe(true);
    expect(lstatSync(foreign).isDirectory()).toBe(true);
  });

  test("the real liveness check answers alive for this process and dead for a PID no process can carry", () => {
    const pidAlive = surface<PidAlive>("pidAlive");
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(DEAD_PID)).toBe(false);
  });
});

describe("the bun suite's test install — the process that creates it owns it", () => {
  function establish(environ: Record<string, string | undefined>, pidAlive: PidAlive, atExit: ExitHook): string {
    const create = surface<Establish>("establishTestInstall");
    return create(environ, { pid: CREATOR_PID, pidAlive, atExit: atExit.register, tempRoot: parent });
  }

  test("a process with no marker creates an install named for itself, sets the marker only in the environment it was given, and registers one removal", () => {
    const prefix = surface<string>("TEST_INSTALL_PREFIX");
    const marker = surface<string>("TEST_INSTALL_MARKER");
    const source = surface<string>("CLIENT_SOURCE_DIR");
    const before = process.env[marker];
    const environ: Record<string, string | undefined> = {};
    const atExit = new ExitHook();

    const install = establish(environ, aliveOnly(), atExit);

    expect(path.dirname(path.resolve(install))).toBe(parent);
    expect(path.basename(install).startsWith(`${prefix}${String(CREATOR_PID)}-`)).toBe(true);
    expect(lstatSync(path.join(install, "clients")).isSymbolicLink()).toBe(true);
    expect(real(path.join(install, "clients"))).toBe(real(source));
    expect(Bun.TOML.parse(readFileSync(path.join(install, "crucible.toml"), "utf8"))).toEqual({});
    expect(environ).toEqual({ [marker]: install });
    expect(process.env[marker]).toBe(before);
    expect(atExit.calls).toHaveLength(1);
  });

  test("the registered removal takes the install and never follows its link into the client source", () => {
    const source = surface<string>("CLIENT_SOURCE_DIR");
    const atExit = new ExitHook();
    const install = establish({}, aliveOnly(), atExit);

    atExit.run();

    expect(existsSync(install)).toBe(false);
    expect(prefixedEntries()).toEqual([]);
    expect(existsSync(path.join(source, "_crucible_axi.py"))).toBe(true);
  });

  test("creating an install sweeps a killed run's install and keeps a live run's", () => {
    const dead = plantInstall(DEAD_PID);
    const live = plantInstall(LIVE_PID);
    const atExit = new ExitHook();

    const install = establish({}, aliveOnly(LIVE_PID, CREATOR_PID), atExit);

    expect(existsSync(dead.install)).toBe(false);
    expect(lstatSync(live.install).isDirectory()).toBe(true);
    expect(prefixedEntries()).toEqual([path.basename(live.install), path.basename(install)].sort());
  });

  test("a marker naming an install that is gone creates a new one and points the marker at it", () => {
    const marker = surface<string>("TEST_INSTALL_MARKER");
    const gone = path.join(parent, "an-install-that-is-gone");
    const environ: Record<string, string | undefined> = { [marker]: gone };
    const atExit = new ExitHook();

    const install = establish(environ, aliveOnly(), atExit);

    expect(path.resolve(install)).not.toBe(gone);
    expect(lstatSync(install).isDirectory()).toBe(true);
    expect(environ[marker]).toBe(install);
    expect(atExit.calls).toHaveLength(1);
  });
});

describe("the bun suite's test install — a reusing process never removes its parent's", () => {
  test("a process whose marker names an existing install reuses it, creates nothing and registers no removal", () => {
    const marker = surface<string>("TEST_INSTALL_MARKER");
    const create = surface<Establish>("establishTestInstall");
    const parents = plantInstall(LIVE_PID, "parents");
    const environ: Record<string, string | undefined> = { [marker]: parents.install };
    const atExit = new ExitHook();

    const install = create(environ, {
      pid: CREATOR_PID,
      pidAlive: aliveOnly(LIVE_PID),
      atExit: atExit.register,
      tempRoot: parent,
    });
    atExit.run();

    expect(path.resolve(install)).toBe(parents.install);
    expect(atExit.calls).toEqual([]);
    expect(lstatSync(parents.install).isDirectory()).toBe(true);
    expect(prefixedEntries()).toEqual([path.basename(parents.install)]);
    expect(environ).toEqual({ [marker]: parents.install });
  });
});
