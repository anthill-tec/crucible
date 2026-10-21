// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — the
// pure, unit-testable pieces of the LOCAL WebKit-via-Docker path. Split out
// from scripts/webkit-docker-server.ts (the CLI entry that actually shells to
// `docker`) so tests/webkit-docker-local-guard.test.ts can assert the exact
// image tag, port and container shape without a Docker daemon, mirroring the
// existing scripts/test-targets.ts (pure lib) + scripts/run-test-target.ts
// (CLI entry) split.
//
// MEASURED 2026-09-23, against this exact host's Docker 29.8.1 (RED phase —
// this cycle's own verification, container removed afterwards):
//   `bun playwright-core@1.63.0` (bun's GLOBAL cache, not this repo's pinned
//   node_modules) connecting to a `v1.61.1-noble` `run-server` failed outright:
//     428 Precondition Required
//     Playwright version mismatch: server version: v1.61 / client version: v1.63
//   — exactly the defect DN "WebKit provisioning" warns of ("a mismatch leaves
//   it unable to locate browser executables"; here it surfaces one step
//   earlier, as a protocol handshake refusal, which is the SAME root cause:
//   the image tag and the resolved playwright package must name one version.
//   Running the connect from INSIDE this repo (so module resolution hits
//   node_modules/playwright-core@1.61.1, the pinned version) fixed the
//   handshake immediately — `browser.newPage()` succeeded and the WebKit
//   engine was fully controllable.
//
//   REACHING THE HOST (C4, orchestrator ruling): the container's localhost is
//   not the host's, and the earlier `--add-host=hostmachine:host-gateway`
//   route is RETIRED. It needed the e2e server bound beyond loopback, a host
//   firewall rule, and a `hostmachine` baseURL the host-side `request`
//   fixture cannot resolve. Playwright's own tethering replaces it:
//   PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback> (EXPOSE_NETWORK below), which
//   routes the remote browser's loopback requests back through the client.
import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-targets";

/** The container this script starts/stops — named so a stale one from a
 *  previous crashed run is unambiguously identifiable (`docker ps -a`). */
export const CONTAINER_NAME = "crucible-webkit-iphone-docker";

/** `run-server`'s port, both inside the container and published to the host
 *  (127.0.0.1 only — never 0.0.0.0 on the host side, so this never competes
 *  with the workstation's own supervised boards on :3849/:3850). Distinct
 *  from E2E_PORT (39877, tests/e2e/steps/harness.ts) — that port is the
 *  suite's OWN webServer, which the container's WebKit browser reaches
 *  through the EXPOSE_NETWORK tether, never via this one. */
export const RUN_SERVER_PORT = 53_333;

/** PW_TEST_CONNECT_EXPOSE_NETWORK's value: Playwright's `exposeNetwork`
 *  rule matching localhost, *.localhost, 127.0.0.1 and [::1]. The remote
 *  browser's requests to those hosts are made from THIS process, so every
 *  baseURL stays `localhost` and the e2e server stays loopback-only. */
export const EXPOSE_NETWORK = "<loopback>";

/** An EXACT semver, same shape package.json's own devDependency range starts
 *  with — `^1.61.1` -> `1.61.1`. Anything looser (a range, `latest`, no
 *  version at all) cannot name a single Docker tag. */
const EXACT_VERSION_PREFIX = /^[\^~]?(\d+\.\d+\.\d+)/;

/** package.json's `devDependencies["@playwright/test"]` range, read fresh
 *  each call rather than cached at import time — so a version bump is picked
 *  up by re-running the script, never by editing this file. */
export function pinnedPlaywrightRange(repoRoot: string = REPO_ROOT): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  let pkg: { devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw) as { devDependencies?: Record<string, string> };
  } catch (cause) {
    throw new Error(`package.json is not valid JSON — cannot derive the pinned Playwright version`, {
      cause,
    });
  }
  const range = pkg.devDependencies?.["@playwright/test"];
  if (typeof range !== "string" || range.trim() === "") {
    throw new Error(
      "package.json declares no devDependencies['@playwright/test'] — the Docker " +
        "image tag has nothing to derive from",
    );
  }
  return range;
}

/** `^1.61.1` -> `1.61.1` — the EXACT version this repository's pinned
 *  @playwright/test resolves to, for the two places that must name it
 *  identically: the `npx playwright@<version> run-server` command run INSIDE
 *  the container (so the server matches the image its OWN base already
 *  carries) and the client (this repo's node_modules) that connects to it. */
export function exactPlaywrightVersion(range: string): string {
  const match = EXACT_VERSION_PREFIX.exec(range.trim());
  if (!match) {
    throw new Error(
      `cannot derive an exact version from @playwright/test's package.json range "${range}" ` +
        '— expected a semver like "^1.61.1"',
    );
  }
  return match[1] as string;
}

/** `1.61.1` -> `mcr.microsoft.com/playwright:v1.61.1-noble` — DN's own stated
 *  rule: "The image version must match @playwright/test EXACTLY". DERIVED,
 *  never a second literal beside package.json's, so a version bump this repo
 *  makes is a version bump the Docker path picks up with no second edit —
 *  and a bump nobody makes here cannot drift the two apart either. */
export function dockerImageTag(exactVersion: string): string {
  return `mcr.microsoft.com/playwright:v${exactVersion}-noble`;
}

/** `ws://127.0.0.1:<port>/` — what this script hands to
 *  PW_TEST_CONNECT_WS_ENDPOINT once the container reports ready. */
export function runServerWsEndpoint(port: number = RUN_SERVER_PORT): string {
  return `ws://127.0.0.1:${String(port)}/`;
}

/** The exact `docker run` argv this script spawns — a pure function so
 *  tests/webkit-docker-local-guard.test.ts can assert its shape (the pinned
 *  image, the published port, the exact `run-server` command) without a
 *  Docker daemon. `--rm` so a crashed run leaves nothing behind for the NEXT
 *  one to collide with; `--init` so `run-server`'s child browser processes
 *  are reaped correctly (the same flag Playwright's own Docker docs use). */
export function dockerRunArgs(opts: { image: string; port: number; playwrightVersion: string }): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "-p",
    `127.0.0.1:${String(opts.port)}:${String(opts.port)}`,
    "--init",
    opts.image,
    "/bin/sh",
    "-c",
    // The pinned image ships no DejaVu, so its `monospace` falls back to a
    // narrower face than GitHub's runner renders. Font-dependent layouts (a
    // label that wraps under DejaVu Sans Mono and not under the fallback) then
    // pass here and fail in CI; installing the runner's font first makes a
    // local WebKit run lay out as CI does.
    "apt-get update -qq && apt-get install -y -qq --no-install-recommends fonts-dejavu-core >/dev/null && " +
      `npx -y playwright@${opts.playwrightVersion} run-server --port ${String(opts.port)} --host 0.0.0.0`,
  ];
}

/** The bun Crucible client the pass runs, so a WebKit run is filed like any
 *  other e2e run. */
export const CLIENT_SCRIPT = join(REPO_ROOT, "clients", "bun-crucible.py");

/** The Playwright project the Docker pass exists for. */
export const WEBKIT_PROJECT = "webkit-iphone";

/** How long run-server may take to listen: the container installs CI's font
 *  first (see dockerRunArgs), so allow for the package download. */
export const SERVER_READY_TIMEOUT_MS = 120_000;

export interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ClientChild {
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

/** Every side effect of the pass, injected so it is testable without a
 *  Docker daemon, a browser or a real client run. */
export interface WebkitPassDeps {
  docker: (args: string[]) => DockerResult;
  waitForServer: (port: number, timeoutMs: number) => Promise<boolean>;
  spawn: (argv: string[], env: Record<string, string | undefined>) => ClientChild;
  signals: EventEmitter;
  stderr: (text: string) => void;
}

const TRAPPED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type TrappedSignal = (typeof TRAPPED_SIGNALS)[number];

/** The shell convention for a run ended by a signal: 128 + its number. */
const SIGNAL_EXIT_CODE: Record<TrappedSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/** The client's argv: `bun-crucible.py e2e <passArgs> -- --project=webkit-iphone`.
 *  `--agent`, `--cycle` and `--release` among `passArgs` file the run; with
 *  none it is unfiled, as a bare `e2e` is. */
export function clientArgv(passArgs: string[]): string[] {
  return ["python3", CLIENT_SCRIPT, "e2e", ...passArgs, "--", `--project=${WEBKIT_PROJECT}`];
}

/** One local WebKit pass: start the pinned run-server container, wait for it,
 *  run the webkit-iphone project through the bun Crucible client with the
 *  run-server endpoint set, and resolve with the client's exit code. It never
 *  exits the process itself, so every path that started a container removes
 *  it: a pass, a failure, a server that never becomes ready, SIGINT and
 *  SIGTERM (on a signal the client is forwarded it and let finish filing its
 *  abandoned run first). */
export async function runWebkitPass(passArgs: string[], deps: WebkitPassDeps): Promise<number> {
  if (deps.docker(["info"]).status !== 0) {
    deps.stderr(
      "\nwebkit-iphone needs the local Docker Playwright Server, and Docker is not reachable.\n" +
        "Remedy: start Docker (`sudo systemctl start docker` or Docker Desktop), then re-run\n" +
        "`bun run webkit:docker`.\n\n",
    );
    return 1;
  }

  const version = exactPlaywrightVersion(pinnedPlaywrightRange());
  const image = dockerImageTag(version);
  const port = RUN_SERVER_PORT;

  deps.stderr(`[webkit-docker] starting ${image} (run-server on :${String(port)})\n`);
  const started = deps.docker(dockerRunArgs({ image, port, playwrightVersion: version }));
  if (started.status !== 0) {
    deps.stderr(
      `\nwebkit-iphone: \`docker run\` failed to start the pinned ${image} container.\n` +
        `stderr: ${started.stderr}\n` +
        "Remedy: check the image tag still exists, or a stale " +
        `\`${CONTAINER_NAME}\` container is already running (\`docker ps -a\`).\n\n`,
    );
    return 1;
  }
  const containerId = started.stdout.trim();

  let received: TrappedSignal | undefined;
  let client: ClientChild | undefined;
  const { promise: signalled, resolve: resolveSignalled } = Promise.withResolvers<TrappedSignal>();
  const handlers = TRAPPED_SIGNALS.map((signal) => {
    const handler = (): void => {
      received ??= signal;
      client?.kill(signal);
      resolveSignalled(signal);
    };
    deps.signals.on(signal, handler);
    return { signal, handler };
  });

  try {
    const ready = await Promise.race([deps.waitForServer(port, SERVER_READY_TIMEOUT_MS), signalled]);
    if (received !== undefined) {
      deps.stderr(`[webkit-docker] ${received} before run-server was ready; no run started\n`);
      return SIGNAL_EXIT_CODE[received];
    }
    if (ready !== true) {
      const logs = deps.docker(["logs", CONTAINER_NAME]);
      deps.stderr(
        `\nwebkit-iphone: the Docker Playwright Server never became reachable on 127.0.0.1:${String(port)}.\n` +
          `Container logs:\n${logs.stdout}${logs.stderr}\n` +
          "Remedy: re-run `bun run webkit:docker`; if it keeps failing, run the container " +
          "by hand and read its logs directly.\n\n",
      );
      return 1;
    }

    deps.stderr(`[webkit-docker] ready, running the ${WEBKIT_PROJECT} project through the client\n`);
    client = deps.spawn(clientArgv(passArgs), {
      ...process.env,
      PW_TEST_CONNECT_WS_ENDPOINT: runServerWsEndpoint(port),
      PW_TEST_CONNECT_EXPOSE_NETWORK: EXPOSE_NETWORK,
    });
    // A signal forwarded to the client lets it file its abandoned run; the
    // pass waits for that exit before the container goes.
    return await client.exited;
  } finally {
    for (const { signal, handler } of handlers) deps.signals.off(signal, handler);
    deps.stderr(`[webkit-docker] stopping ${containerId || CONTAINER_NAME}\n`);
    deps.docker(["rm", "-f", CONTAINER_NAME]);
  }
}
