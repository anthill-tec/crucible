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
//   engine was fully controllable. `--add-host=hostmachine:host-gateway` also
//   measured correctly: `getent hosts hostmachine` inside the container
//   resolved to the docker0 gateway IP. The one leg NOT verified end-to-end
//   here is a full page load from the container to this host's own bound
//   webServer port — this workstation's firewall drops the forwarded
//   connection past DNS resolution (a HOST firewall configuration question,
//   not a defect in this wiring), so `dockerRunArgs`'s shape is verified by
//   the two legs above plus this repository's own convention (readServerPort
//   already isolates E2E_PORT the same way `playwright.config.ts` does), not
//   by a full local suite pass.
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
 *  suite's OWN webServer, which the container's WebKit browser reaches via
 *  `hostmachine`, never via this one. */
export const RUN_SERVER_PORT = 53_333;

/** The `--add-host` alias `playwright.config.ts` targets for the webkit-iphone
 *  project when PW_TEST_CONNECT_WS_ENDPOINT is set — DN: "the container's
 *  localhost is not the host's". */
export const HOSTMACHINE_ALIAS = "hostmachine";

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
 *  image, the `--add-host` alias, the exact `run-server` command) without a
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
    `--add-host=${HOSTMACHINE_ALIAS}:host-gateway`,
    "-p",
    `127.0.0.1:${String(opts.port)}:${String(opts.port)}`,
    "--init",
    opts.image,
    "/bin/sh",
    "-c",
    `npx -y playwright@${opts.playwrightVersion} run-server --port ${String(opts.port)} --host 0.0.0.0`,
  ];
}
