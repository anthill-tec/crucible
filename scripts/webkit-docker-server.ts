#!/usr/bin/env bun
// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — the
// ONE command for a local WebKit phone-band pass:
//
//   bun run webkit:docker
//
// Native install is CI-only (Playwright ships WebKit for Debian/Ubuntu only;
// the AUR route is explicitly REJECTED — DN, "not guaranteed" per the AUR
// maintainer's own note). Locally the ONLY working path is Playwright's own
// Docker Playwright Server: this script pulls nothing itself (`docker run`
// pulls on demand), starts the PINNED `run-server` image — DERIVED from
// package.json's `@playwright/test` devDependency, never a second literal
// (scripts/webkit-docker-runner.ts), waits for it to report ready, sets
// PW_TEST_CONNECT_WS_ENDPOINT together with
// PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback> (Playwright's own tethering, so
// the browser INSIDE the container reaches this suite's own loopback-only
// webServer on E2E_PORT, tests/e2e/steps/harness.ts, through the client:
// never the workstation's separately supervised :3849/:3850 boards), runs `bddgen` + the `webkit-iphone` project,
// and ALWAYS tears the container down again (finally), so a crashed run does
// not leave a stray container for the next one to collide with.
//
// FAILS LOUD, NEVER SILENT (CR requirement): every early-return path below
// writes an ACTIONABLE remedy to stderr and exits non-zero — no bare "docker:
// command not found" stack, no hang waiting on a server that will never
// answer. `tests/e2e/steps/webkit-docker-preflight.steps.ts` is the SECOND
// line of defence, behind playwright.config.ts's endpoint gate (a bare
// `bun run test:e2e` has no endpoint, so its webkit-iphone project collects
// nothing).
import { spawn, spawnSync } from "node:child_process";
import { REPO_ROOT } from "./test-targets";
import {
  CONTAINER_NAME,
  EXPOSE_NETWORK,
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
    // A TCP connect is NOT readiness: Docker's port proxy accepts on the
    // published port the moment the container starts, then resets the
    // connection until `npx playwright run-server` is really listening
    // (measured C4: curl exit 56 for ~2s, then `200 Running`). That early
    // accept is what made the first real run fail with a websocket
    // ECONNRESET. run-server answers a plain HTTP GET with 200 once it
    // listens, so an HTTP response is the readiness signal.
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return true;
    } catch {
      // reset / refused / timed out: not listening yet, keep polling
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
        "`bun run webkit:docker`.",
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
          "Remedy: re-run `bun run webkit:docker`; if it keeps failing, run the container " +
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
process.env.PW_TEST_CONNECT_EXPOSE_NETWORK = EXPOSE_NETWORK;
main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    fail(`webkit-iphone: unexpected error — ${String(error)}`);
  });
