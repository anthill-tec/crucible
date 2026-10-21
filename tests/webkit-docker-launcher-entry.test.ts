// `bun run webkit:docker`'s CLI entry (scripts/webkit-docker-server.ts) is a
// thin shell over runWebkitPass (scripts/webkit-docker-runner.ts), and its two
// fail-loud paths that start no container survive the move to the client.
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the WebKit pass goes through the client" and its criterion
// "WebKit runs through the client" (docs/changes/, filed for wave 8).
//
// The real entry is spawned with a FAKE `docker` first on PATH. The fake never
// lets `docker run` succeed, so no run-server wait, no client and no browser
// can ever be reached; DOCKER_HOST additionally points at a socket that does
// not exist, so even a real `docker` binary could not start a container. The
// child's output is the script's own remedy text — no environment value is
// ever printed or compared.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_NAME } from "../scripts/webkit-docker-runner.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "scripts", "webkit-docker-server.ts");

const scratch = mkdtempSync(join(tmpdir(), "webkit-docker-entry-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$FAKE_DOCKER_MODE" = "unreachable" ]; then
  echo "Cannot connect to the Docker daemon" >&2
  exit 1
fi
case "$1" in
  run)
    echo "docker: Error response from daemon: Conflict. The container name is already in use." >&2
    exit 125
    ;;
  *)
    exit 0
    ;;
esac
`;

interface EntryRun {
  code: number;
  stderr: string;
  dockerCalls: string[];
}

async function runEntry(mode: "unreachable" | "run-fails", passArgs: string[]): Promise<EntryRun> {
  const dir = mkdtempSync(join(scratch, `${mode}-`));
  const log = join(dir, "docker.log");
  // <binDir>/docker — the `docker` the entry resolves first on PATH.
  const binDir = mkdtempSync(join(dir, "bin-"));
  const shim = join(binDir, "docker");
  writeFileSync(shim, FAKE_DOCKER);
  chmodSync(shim, 0o755);

  const proc = Bun.spawn(["bun", ENTRY, ...passArgs], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_MODE: mode,
      DOCKER_HOST: "unix:///nonexistent/crucible-webkit-entry-test.sock",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const guard = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  await new Response(proc.stdout).text();
  clearTimeout(guard);
  const dockerCalls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
  return { code, stderr, dockerCalls };
}

describe("webkit:docker entry — wired to runWebkitPass, with no bddgen or direct Playwright of its own", () => {
  test("scripts/webkit-docker-server.ts calls runWebkitPass, and spawns neither bddgen nor `playwright test` itself", () => {
    const source = readFileSync(ENTRY, "utf8");
    expect(source).toMatch(/\brunWebkitPass\s*\(/);
    expect(source).not.toMatch(/["']bddgen["']/);
    expect(source).not.toMatch(/["']playwright["']\s*,\s*["']test["']/);
  });
});

describe("webkit:docker entry — fails loud, and starts no container, when Docker cannot start one", () => {
  test("Docker unreachable: the real entry exits non-zero naming the remedy and never issues `docker run`", async () => {
    const run = await runEntry("unreachable", ["--agent", "X"]);

    expect(run.code, `stderr:\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toMatch(/remedy/i);
    expect(run.stderr).toMatch(/start docker/i);
    expect(run.dockerCalls.length, "the entry never consulted docker").toBeGreaterThanOrEqual(1);
    expect(run.dockerCalls.filter((line) => line.startsWith("run "))).toEqual([]);
  }, 30_000);

  test("a failed `docker run`: the real entry exits non-zero naming the remedy and the stale container to look for", async () => {
    const run = await runEntry("run-fails", ["--agent", "X"]);

    expect(run.code, `stderr:\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toMatch(/remedy/i);
    expect(run.stderr).toContain(CONTAINER_NAME);
    expect(run.dockerCalls.filter((line) => line.startsWith("run ")).length).toBe(1);
  }, 30_000);
});
