#!/usr/bin/env bun
// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — the
// ONE command for a local WebKit phone-band pass:
//
//   bun run test:e2e:webkit
//
// Native install is CI-only (Playwright ships WebKit for Debian/Ubuntu only;
// the AUR route is explicitly REJECTED — DN, "not guaranteed" per the AUR
// maintainer's own note). Locally the ONLY working path is Playwright's own
// Docker Playwright Server: this script pulls nothing itself (`docker run`
// pulls on demand), starts the PINNED `run-server` image — DERIVED from
// package.json's `@playwright/test` devDependency, never a second literal
// (scripts/webkit-docker-runner.ts) — with `--add-host=hostmachine:host-gateway`
// so the browser INSIDE the container can reach this suite's own webServer
// (E2E_PORT, tests/e2e/steps/harness.ts — never the workstation's separately
// supervised :3849/:3850 boards), waits for it to report ready, sets
// PW_TEST_CONNECT_WS_ENDPOINT, runs `bddgen` + the `webkit-iphone` project,
// and ALWAYS tears the container down again (finally), so a crashed run does
// not leave a stray container for the next one to collide with.
//
// FAILS LOUD, NEVER SILENT (CR requirement): every early-return path below
// writes an ACTIONABLE remedy to stderr and exits non-zero — no bare "docker:
// command not found" stack, no hang waiting on a server that will never
// answer. `tests/e2e/steps/webkit-docker-preflight.steps.ts` is the SECOND
// line of defence for the path this script does not own (a bare
// `bun run test:e2e`, which still collects every project including
// webkit-iphone).
import { spawn, spawnSync } from "node:child_process";
import { REPO_ROOT } from "./test-targets";
import {
  CONTAINER_NAME,
  RUN_SERVER_PORT,
  dockerImageTag,
  dockerRunArgs,
  exactPlaywrightVersion,
  pinnedPlaywrightRange,
  runServerWsEndpoint,
} from "./webkit-docker-runner";

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

function dockerReachable(): boolean {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // run-server answers a plain WS upgrade request; a refused/timed-out
      // TCP connect is the only thing distinguishing "not ready yet" from
      // "ready", so a raw socket probe is enough — no protocol handshake
      // needed here, connectOptionsFromEnv() (playwright/lib/index.js) does
      // the real one once PW_TEST_CONNECT_WS_ENDPOINT is set below.
      const socket = await new Promise<boolean>((resolve) => {
        const net = require("node:net") as typeof import("node:net");
        const s = net.createConnection({ host: "127.0.0.1", port }, () => {
          s.end();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      if (socket) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function run(command: string, args: string[]): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  child.on("close", (code) => resolve(code ?? 1));
  return promise;
}

async function main(): Promise<number> {
  if (!dockerReachable()) {
    fail(
      "webkit-iphone needs the local Docker Playwright Server, and Docker is not reachable.\n" +
        "Remedy: start Docker (`sudo systemctl start docker` or Docker Desktop), then re-run\n" +
        "`bun run test:e2e:webkit`.",
    );
  }

  const range = pinnedPlaywrightRange();
  const version = exactPlaywrightVersion(range);
  const image = dockerImageTag(version);
  const port = RUN_SERVER_PORT;

  process.stderr.write(`[webkit-docker] starting ${image} (run-server on :${String(port)})\n`);
  const started = spawnSync("docker", dockerRunArgs({ image, port, playwrightVersion: version }), {
    encoding: "utf8",
  });
  if (started.status !== 0) {
    fail(
      `webkit-iphone: \`docker run\` failed to start the pinned ${image} container.\n` +
        `stderr: ${started.stderr}\n` +
        "Remedy: check the image tag still exists, or a stale " +
        `\`${CONTAINER_NAME}\` container is already running (\`docker ps -a\`).`,
    );
  }
  const containerId = started.stdout.trim();

  try {
    const ready = await waitForServer(port, 30_000);
    if (!ready) {
      const logs = spawnSync("docker", ["logs", CONTAINER_NAME], { encoding: "utf8" });
      fail(
        `webkit-iphone: the Docker Playwright Server never became reachable on 127.0.0.1:${String(port)}.\n` +
          `Container logs:\n${logs.stdout}${logs.stderr}\n` +
          "Remedy: re-run `bun run test:e2e:webkit`; if it keeps failing, run the container " +
          "by hand and read its logs directly.",
      );
    }

    process.stderr.write(`[webkit-docker] ready — running the webkit-iphone project\n`);
    const bddgen = await run("bunx", ["bddgen"]);
    if (bddgen !== 0) return bddgen;

    return await run("bunx", ["playwright", "test", "--project=webkit-iphone"]);
  } finally {
    process.stderr.write(`[webkit-docker] stopping ${containerId || CONTAINER_NAME}\n`);
    spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
  }
}

process.env.PW_TEST_CONNECT_WS_ENDPOINT = runServerWsEndpoint(RUN_SERVER_PORT);
main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    fail(`webkit-iphone: unexpected error — ${String(error)}`);
  });
