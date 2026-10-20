#!/usr/bin/env bun
// The ONE command for a local WebKit phone-band pass (DN-crucible-responsive-model,
// "WebKit provisioning"):
//
//   bun run webkit:docker [-- <args>]
//
// Native install is CI-only (Playwright ships WebKit for Debian/Ubuntu only;
// the AUR route is REJECTED in the DN). Locally the ONLY working path is
// Playwright's own Docker Playwright Server. This entry is a thin shell over
// runWebkitPass (scripts/webkit-docker-runner.ts): it starts the PINNED
// `run-server` image (derived from package.json's `@playwright/test`), waits
// for it, runs `bun-crucible.py e2e <args> -- --project=webkit-iphone` with
// PW_TEST_CONNECT_WS_ENDPOINT and PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>
// set (Playwright's own tethering, so the browser INSIDE the container reaches
// this suite's loopback-only webServer on E2E_PORT, tests/e2e/steps/harness.ts),
// and exits with the client's exit code. `--agent`, `--cycle` and `--release`
// among the arguments file the run. The container is removed on every path
// that started it, signals included (the client is let finish filing first).
//
// FAILS LOUD, NEVER SILENT: every early-return path writes an ACTIONABLE
// remedy to stderr and exits non-zero. `tests/e2e/steps/webkit-docker-preflight.steps.ts`
// is the SECOND line of defence, behind playwright.config.ts's endpoint gate.
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { REPO_ROOT } from "./test-targets";
import {
  EXPOSE_NETWORK,
  RUN_SERVER_PORT,
  runServerWsEndpoint,
  runWebkitPass,
  type ClientChild,
  type DockerResult,
} from "./webkit-docker-runner";

function docker(args: string[]): DockerResult {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A TCP connect is NOT readiness: Docker's port proxy accepts on the
    // published port the moment the container starts, then resets the
    // connection until `npx playwright run-server` is really listening.
    // run-server answers a plain HTTP GET with 200 once it listens, so an
    // HTTP response is the readiness signal.
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

function spawnClient(argv: string[], env: Record<string, string | undefined>): ClientChild {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("the client argv is empty");
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
  const { promise, resolve } = Promise.withResolvers<number>();
  child.on("error", (error) => {
    process.stderr.write(`webkit-iphone: the client could not start: ${String(error)}\n`);
    resolve(1);
  });
  child.on("close", (code, signal) => {
    resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
  });
  return {
    exited: promise,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

process.env.PW_TEST_CONNECT_WS_ENDPOINT = runServerWsEndpoint(RUN_SERVER_PORT);
process.env.PW_TEST_CONNECT_EXPOSE_NETWORK = EXPOSE_NETWORK;
runWebkitPass(process.argv.slice(2), {
  docker,
  waitForServer,
  spawn: spawnClient,
  signals: process,
  stderr: (text) => {
    process.stderr.write(text);
  },
})
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`\nwebkit-iphone: unexpected error: ${String(error)}\n\n`);
    process.exit(1);
  });
