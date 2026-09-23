// CR-CRU-018 §S1 AC13/AC14 (DN "WebKit provisioning — the two paths") — the
// webkit-iphone project has NO native launch path on this host (Playwright
// ships WebKit for Debian/Ubuntu only; the AUR route is explicitly REJECTED).
// Locally it runs ONLY against the local Docker Playwright Server
// (scripts/webkit-docker-server.ts, `bun run test:e2e:webkit`), which sets
// PW_TEST_CONNECT_WS_ENDPOINT before ever invoking Playwright.
//
// This worker-level hook is the SECOND line of defence, for the path that
// script does not own: a bare `bun run test:e2e` (or a direct
// `bunx playwright test`, no `--project` filter) still collects EVERY
// project, webkit-iphone included. Without this guard Playwright would
// attempt a NATIVE webkit launch on this Arch/CachyOS host right there — the
// exact "confusing browser-not-found stack" the CR forbids (DN, measured:
// this host wants libicu74 + libflite1 against a system carrying ICU 78.3).
//
// `browserName` is a genuine Playwright WORKER-scoped built-in fixture,
// resolved per-project from `use.defaultBrowserType`/`browserName`
// (playwright.config.ts's webkit-iphone project spreads
// `devices["iPhone 15"]`, whose own descriptor declares
// `defaultBrowserType: "webkit"` — verified against this pinned Playwright
// version's own node_modules/playwright-core/lib/server/
// deviceDescriptorsSource.json, not assumed). Requesting ONLY `browserName`
// — never `browser`/`page`/`context` — means this hook costs nothing but a
// string compare and, critically, never itself triggers a launch: the guard
// fires (if it fires) before any browser process is spawned.
import { BeforeAll } from "./world.ts";
import { webkitLocalGuardMessage } from "./webkit-docker-preflight.ts";

BeforeAll(async ({ browserName }: { browserName: string }) => {
  const message = webkitLocalGuardMessage({
    browserName,
    isCI: Boolean(process.env.CI),
    wsEndpoint: process.env.PW_TEST_CONNECT_WS_ENDPOINT,
  });
  if (message !== undefined) {
    throw new Error(message);
  }
});
