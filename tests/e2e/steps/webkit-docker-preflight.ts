// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — pure
// decision logic for the webkit-iphone local-launch guard, split out so
// tests/webkit-docker-local-guard.test.ts can assert it directly (no
// Playwright, no browser, no worker) — see
// tests/e2e/steps/webkit-docker-preflight.steps.ts for the one caller.

/** The ONE command a developer runs for a local WebKit pass — package.json's
 *  own script name (asserted directly against package.json by
 *  tests/webkit-docker-local-guard.test.ts, so this literal and that
 *  declaration cannot drift apart unnoticed). */
export const WEBKIT_DOCKER_NPM_SCRIPT = "bun run test:e2e:webkit";

export interface WebkitGuardInput {
  /** Playwright's own built-in WORKER fixture — resolved from the running
   *  project's `use.defaultBrowserType`/`browserName`, so "webkit" here means
   *  Playwright is ABOUT to attempt a webkit launch, native or connected. */
  browserName: string;
  isCI: boolean;
  /** `process.env.PW_TEST_CONNECT_WS_ENDPOINT` — Playwright's OWN env var
   *  (verified: node_modules/playwright/lib/index.js's connectOptionsFromEnv()
   *  reads exactly this name for every browser launch in the process). */
  wsEndpoint: string | undefined;
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
  if (input.isCI) return undefined;
  if (input.wsEndpoint !== undefined && input.wsEndpoint.trim() !== "") return undefined;

  return (
    "webkit-iphone needs WebKit, and this host cannot launch it natively — Playwright " +
    "ships WebKit for Debian/Ubuntu only (docs/research/DN-crucible-responsive-model.md, " +
    '"WebKit provisioning — the two paths"; measured: this host\u2019s system ICU (78.3) is ' +
    "not what the prebuilt WebKit links against, and the AUR route is explicitly REJECTED " +
    "— \"not guaranteed\" per its own maintainer's note). Start the local Docker Playwright " +
    `Server and re-run: \`${WEBKIT_DOCKER_NPM_SCRIPT}\` — it starts the pinned ` +
    "mcr.microsoft.com/playwright:v<version>-noble image's run-server, sets " +
    "PW_TEST_CONNECT_WS_ENDPOINT, and points this project's baseURL at `hostmachine` for you."
  );
}
