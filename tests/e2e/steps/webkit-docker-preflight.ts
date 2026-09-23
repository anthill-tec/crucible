// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — pure
// decision logic for the webkit-iphone local-launch guard, split out so
// tests/webkit-docker-local-guard.test.ts can assert it directly (no
// Playwright, no browser, no worker) — see
// tests/e2e/steps/webkit-docker-preflight.steps.ts for the one caller.

/** The ONE command a developer runs for a local WebKit pass — package.json's
 *  own script name (asserted directly against package.json by
 *  tests/webkit-docker-local-guard.test.ts, so this literal and that
 *  declaration cannot drift apart unnoticed). */
export const WEBKIT_DOCKER_NPM_SCRIPT = "bun run webkit:docker";

export interface WebkitEngineInput {
  isCI: boolean;
  /** `process.env.PW_TEST_CONNECT_WS_ENDPOINT`: Playwright's OWN env var
   *  (verified: node_modules/playwright/lib/index.js's connectOptionsFromEnv()
   *  reads exactly this name for every browser launch in the process). */
  wsEndpoint: string | undefined;
}

/** Docker mode: the run is pointed at the local Docker Playwright Server
 *  (`bun run webkit:docker` sets PW_TEST_CONNECT_WS_ENDPOINT). A blank value
 *  is not an endpoint. In this mode EVERY browser launch in the process runs
 *  inside the container, whatever its project. */
export function webkitDockerMode(wsEndpoint: string | undefined): boolean {
  return wsEndpoint !== undefined && wsEndpoint.trim() !== "";
}

/** Whether this run HAS a WebKit engine at all: CI's native install, or the
 *  local Docker Playwright Server. The ONE predicate that gates the
 *  webkit-iphone project in playwright.config.ts AND tells
 *  tests/e2e-suite-reaches-the-board.test.ts whether the phone scenarios run
 *  on a second engine, so the two cannot disagree. */
export function webkitEngineAvailable(input: WebkitEngineInput): boolean {
  return input.isCI || webkitDockerMode(input.wsEndpoint);
}

export interface WebkitGuardInput extends WebkitEngineInput {
  /** Playwright's own built-in WORKER fixture, resolved from the running
   *  project's `use.defaultBrowserType`/`browserName`, so "webkit" here means
   *  Playwright is ABOUT to attempt a webkit launch, native or connected. */
  browserName: string;
}

/** The remedy message when a run is ABOUT to attempt a NATIVE webkit launch on
 *  a host that cannot make one — `undefined` when the run is safe to proceed:
 *  a non-webkit project, CI's native install (DN: CI installs WebKit for
 *  real), or a run already pointed at the Docker Playwright Server via
 *  PW_TEST_CONNECT_WS_ENDPOINT (scripts/webkit-docker-server.ts sets it).
 *  Never a silent skip (CR requirement): a caller that gets a defined message
 *  back must THROW it, not swallow it. */
export function webkitLocalGuardMessage(input: WebkitGuardInput): string | undefined {
  if (input.browserName !== "webkit") return undefined;
  if (webkitEngineAvailable(input)) return undefined;

  return (
    "webkit-iphone needs WebKit, and this host cannot launch it natively — Playwright " +
    "ships WebKit for Debian/Ubuntu only (docs/research/DN-crucible-responsive-model.md, " +
    '"WebKit provisioning — the two paths"; measured: this host\u2019s system ICU (78.3) is ' +
    "not what the prebuilt WebKit links against, and the AUR route is explicitly REJECTED " +
    "— \"not guaranteed\" per its own maintainer's note). Start the local Docker Playwright " +
    `Server and re-run: \`${WEBKIT_DOCKER_NPM_SCRIPT}\` — it starts the pinned ` +
    "mcr.microsoft.com/playwright:v<version>-noble image's run-server, sets " +
    "PW_TEST_CONNECT_WS_ENDPOINT and PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback> for you."
  );
}
