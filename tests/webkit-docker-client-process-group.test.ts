// The local WebKit pass (`bun run webkit:docker`) spawns the bun Crucible
// client in its OWN process group, so a signal reaches the client once — by
// the launcher's forward — and never a second time from the terminal. A
// terminal delivers Ctrl-C to its whole foreground process group; a client
// left in the launcher's group would receive that SIGINT directly AND the
// launcher's forwarded copy, so its abandoned-run filing would be interrupted
// by the second one.
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the WebKit pass goes through the client" and its criterion
// "WebKit runs through the client" (docs/changes/).
//
// THE SEAM. The production launcher (scripts/webkit-docker-server.ts) is
// driven end to end as a real process, with no Docker daemon and no real
// client run:
//   - `docker` on the launcher's PATH is a fake that records its argv,
//     answers `info` and `run` successfully and removes nothing real;
//   - run-server's readiness is a throwaway HTTP server on RUN_SERVER_PORT
//     answering 200, which is all the launcher's readiness probe asks;
//   - `python3` on the launcher's PATH is a fake client that records its own
//     process group, its parent's, and every signal it receives.
// The launcher is started as the leader of its own process group, exactly as
// a shell starts a foreground job, and the "terminal" Ctrl-C is a SIGINT sent
// to that whole group. Environment VALUES are never printed.
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_NAME, RUN_SERVER_PORT } from "../scripts/webkit-docker-runner.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const LAUNCHER = join(REPO_ROOT, "scripts", "webkit-docker-server.ts");
const SIGINT_EXIT_CODE = 130;

interface ClientRecord {
  pid: number;
  pgid: number;
  parentPid: number;
  parentPgid: number;
}

interface Rig {
  dir: string;
  dockerLog: string;
  clientInfo: string;
  clientSignals: string;
  server: ReturnType<typeof Bun.serve>;
  launcher?: ChildProcess;
}

let rig: Rig | undefined;

afterEach(() => {
  if (rig === undefined) return;
  const { launcher, server, dir } = rig;
  if (launcher?.pid !== undefined && launcher.exitCode === null && launcher.signalCode === null) {
    try {
      process.kill(-launcher.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  // a fake client left behind (its own group once detached) must not outlive the test
  try {
    const info = JSON.parse(readFileSync(rig.clientInfo, "utf8")) as ClientRecord;
    process.kill(info.pid, "SIGKILL");
  } catch {
    // never started, or already gone
  }
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rig = undefined;
});

/** A fake `docker` (records argv; `info`/`run` succeed) and a fake `python3`
 *  client (records its process groups and every SIGINT/SIGTERM it receives,
 *  then exits 130 a moment after the first so a second copy can still land). */
function buildRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "webkit-client-pgroup-"));
  const dockerLog = join(dir, "docker.log");
  const clientInfo = join(dir, "client.json");
  const clientSignals = join(dir, "client-signals.log");

  const fakeDocker = join(dir, "docker");
  writeFileSync(
    fakeDocker,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${dockerLog}'`,
      'case "$1" in',
      "  run) echo fakecontainer0001 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeDocker, 0o755);

  const fakeClient = join(dir, "python3");
  writeFileSync(
    fakeClient,
    [
      `#!${process.execPath}`,
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const pgidOf = (pid) => Number(spawnSync(\"ps\", [\"-o\", \"pgid=\", \"-p\", String(pid)], { encoding: \"utf8\" }).stdout.trim());",
      "let first = true;",
      'for (const sig of ["SIGINT", "SIGTERM"]) {',
      "  process.on(sig, () => {",
      `    appendFileSync(${JSON.stringify(clientSignals)}, sig + "\\n");`,
      "    if (first) { first = false; setTimeout(() => process.exit(130), 1500); }",
      "  });",
      "}",
      `writeFileSync(${JSON.stringify(clientInfo)}, JSON.stringify({ pid: process.pid, pgid: pgidOf(process.pid), parentPid: process.ppid, parentPgid: pgidOf(process.ppid) }));`,
      "setTimeout(() => process.exit(0), 20000);",
      "",
    ].join("\n"),
  );
  chmodSync(fakeClient, 0o755);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: RUN_SERVER_PORT,
    fetch: () => new Response("ok"),
  });

  return { dir, dockerLog, clientInfo, clientSignals, server };
}

/** Start the production launcher as its own process-group leader, the way a
 *  shell starts a foreground job, with the fakes first on its PATH. */
function startLauncher(r: Rig): { launcher: ChildProcess; exited: Promise<number | null> } {
  const launcher = spawnChild(process.execPath, [LAUNCHER], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${r.dir}:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  const exited = new Promise<number | null>((resolve) => {
    launcher.on("close", (code) => resolve(code));
  });
  r.launcher = launcher;
  return { launcher, exited };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").length > 0) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("webkit:docker — the client runs in its own process group", () => {
  test(
    "the client the launcher spawns leads a process group of its own, not the launcher's",
    async () => {
      rig = buildRig();
      const { launcher } = startLauncher(rig);
      expect(await waitForFile(rig.clientInfo, 15_000)).toBe(true);
      const client = JSON.parse(readFileSync(rig.clientInfo, "utf8")) as ClientRecord;

      // the fake client really is the launcher's child, so the groups compared are the right two
      expect(client.parentPid).toBe(launcher.pid as number);
      // its own group: it leads one, and it is not the launcher's
      expect(client.pgid).toBe(client.pid);
      expect(client.pgid).not.toBe(client.parentPgid);
    },
    30_000,
  );

  test(
    "a terminal SIGINT to the launcher's foreground group reaches the client exactly once, by the forward, and the container is still removed",
    async () => {
      rig = buildRig();
      const { launcher, exited } = startLauncher(rig);
      expect(await waitForFile(rig.clientInfo, 15_000)).toBe(true);

      // Ctrl-C at the terminal: SIGINT to the whole foreground process group
      process.kill(-(launcher.pid as number), "SIGINT");

      // the launcher forwards it, waits for the client to exit, then removes the container
      expect(await exited).toBe(SIGINT_EXIT_CODE);

      const received = readFileSync(rig.clientSignals, "utf8").split("\n").filter((line) => line !== "");
      expect(received).toEqual(["SIGINT"]);

      const dockerCalls = readFileSync(rig.dockerLog, "utf8").split("\n").filter((line) => line !== "");
      expect(dockerCalls.filter((line) => line === `rm -f ${CONTAINER_NAME}`)).toHaveLength(1);
      expect(dockerCalls.at(-1)).toBe(`rm -f ${CONTAINER_NAME}`);
    },
    30_000,
  );
});
