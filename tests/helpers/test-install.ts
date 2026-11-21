/**
 * CR-CRU-260 — the bun suite reaches its clients through a TEST INSTALL it
 * owns, never through the checkout's own `clients/`.
 *
 * A client derives its install dir from its own location
 * (`dirname(abspath(__file__))`), so a client loaded or spawned from the
 * checkout takes the REPO ROOT as its install and reads the operator's
 * git-ignored root `crucible.toml`. This module therefore lays down, once per
 * process, a test install outside the repo: a directory named
 * `<TEST_INSTALL_PREFIX><pid>-…` holding a `clients` symlink to the checkout's
 * client source and a `crucible.toml` that declares nothing. It mirrors the
 * python package `tests/client/__init__.py` (same prefix, same marker), so a
 * python child of a bun test reuses the bun run's install.
 *
 * The suite reaches its clients only through here:
 *
 *   - LOAD or SPAWN a client: `clientScript(name)`, `TEST_INSTALL_CLIENTS`;
 *   - READ client source or COPY it into a test's own install:
 *     `CLIENT_SOURCE_DIR`.
 *
 * Ownership: the process that CREATES the install removes it at exit (the
 * preload's root `afterAll` makes `exit` fire under `bun test`); a process
 * that finds it through `TEST_INSTALL_MARKER` reuses it and never removes it.
 * A run killed before its exit leaves an install the NEXT creation sweeps
 * (any prefixed install whose creator PID is dead).
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout's client source: for READING client source or COPYING it
 *  into a test's own install — never for loading or spawning a client. */
export const CLIENT_SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "clients");

/** The fixed name prefix of a test install; the creator's PID follows it. */
export const TEST_INSTALL_PREFIX = "crucible-client-suite-install-";

/** The environment variable naming this run's test install for child processes. */
export const TEST_INSTALL_MARKER = "CRUCIBLE_CLIENT_SUITE_TEST_INSTALL";

/** The test install's own `crucible.toml`: it declares nothing, so a client
 *  that resolves past its project refuses naming this file, never the
 *  operator's root configuration. */
const TEST_INSTALL_CONFIG_TEXT =
  "# The bun suite's test install (tests/helpers/test-install.ts).\n" +
  "# It declares no board, no [lint] or [run] table and no limits: a test\n" +
  "# declares what it needs in a project directory it owns.\n";

export type PidAlive = (pid: number) => boolean;

export interface EstablishOptions {
  pid: number;
  pidAlive: PidAlive;
  atExit: (remove: () => void) => void;
  tempRoot: string;
}

/** True when a process with `pid` exists (signal 0 probes, never signals). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The creator PID a test install's name carries, or null when the name has
 *  no prefix or no numeric PID. */
export function installOwnerPid(nameOrPath: string): number | null {
  const name = path.basename(path.normalize(nameOrPath));
  if (!name.startsWith(TEST_INSTALL_PREFIX)) return null;
  const pidText = name.slice(TEST_INSTALL_PREFIX.length).split("-", 1)[0] ?? "";
  return /^\d+$/.test(pidText) ? Number(pidText) : null;
}

/** Remove a test install without following its `clients` link. */
function removeInstall(install: string): void {
  const link = path.join(install, "clients");
  if (isLink(link)) unlinkSync(link);
  rmSync(install, { recursive: true, force: true });
}

/** True when `p` is a symlink; false when it is anything else or absent. */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Remove every prefixed test install in `directory` whose creator PID is
 *  dead; keep live, unattributable and foreign entries. Answers the removed
 *  paths, sorted. */
export function sweepDeadInstalls(directory: string, alive: PidAlive): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const owner = installOwnerPid(name);
    if (owner === null || alive(owner)) continue;
    const install = path.join(directory, name);
    const stat = lstatSync(install);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    removeInstall(install);
    removed.push(install);
  }
  return removed.sort();
}

/** The test install `environ`'s marker names, when it exists (nothing is
 *  created or registered); else a new one under `tempRoot`, created after
 *  sweeping it, with its removal registered once through `atExit` and the
 *  marker set in `environ` (only). */
export function establishTestInstall(
  environ: Record<string, string | undefined>,
  { pid, pidAlive: alive, atExit, tempRoot }: EstablishOptions,
): string {
  const existing = environ[TEST_INSTALL_MARKER];
  if (existing && existsSync(existing) && lstatSync(existing).isDirectory()) return existing;
  sweepDeadInstalls(tempRoot, alive);
  const install = mkdtempSync(path.join(tempRoot, `${TEST_INSTALL_PREFIX}${String(pid)}-`));
  symlinkSync(CLIENT_SOURCE_DIR, path.join(install, "clients"), "dir");
  writeFileSync(path.join(install, "crucible.toml"), TEST_INSTALL_CONFIG_TEXT);
  atExit(() => {
    removeInstall(install);
  });
  environ[TEST_INSTALL_MARKER] = install;
  return install;
}

/** This process's test install. */
export const TEST_INSTALL_DIR = establishTestInstall(process.env, {
  pid: process.pid,
  pidAlive,
  atExit: (remove) => {
    process.on("exit", remove);
  },
  tempRoot: os.tmpdir(),
});
export const TEST_INSTALL_CLIENTS = path.join(TEST_INSTALL_DIR, "clients");
export const TEST_INSTALL_CONFIG = path.join(TEST_INSTALL_DIR, "crucible.toml");

/** `<test install>/clients/<name>`: the path to LOAD or SPAWN a client by. */
export function clientScript(name: string): string {
  return path.join(TEST_INSTALL_CLIENTS, name);
}
