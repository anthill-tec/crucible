// CR-CRU-052 §S2/§S3 RED — dedicated, ISOLATED Playwright config proving
// harness.ts's teardown + ephemeral-guard contracts against a REAL server
// bound to the real e2e port. Kept separate from the main
// tests/e2e/features BDD suite (playwright.config.ts — GREEN-owned, not
// touched here): one of the scenarios in ephemeral.spec.ts deliberately
// FAILS (§S2 AC — "teardown also runs when a scenario fails"), and a
// permanently-red scenario inside the real regression suite would be a
// standing false alarm forever, not a genuine assertion. See
// ephemeral.spec.ts's header for the full contract rationale.
//
// Boots the server via a REAL BUN SUBPROCESS (Playwright's `webServer`
// stanza, `bun run <SERVER_ENTRY>`) — mirroring the main playwright.config.ts
// exactly — rather than importing src/server.ts directly into this config
// or the spec file. Verified this cycle: Playwright's own test/config
// processes (even invoked via `bunx playwright test`) load under Node's ESM
// loader, which cannot resolve `bun:sqlite` (src/store.ts's dependency) —
// a direct `import { startServer }` here reproduced
// `SyntaxError: Only URLs with a scheme in: file, data, and node are
// supported... Received protocol 'bun:'` in a RED-phase smoke probe. The
// main suite already avoids this by spawning the server as its OWN `bun
// run` child process instead of importing it — the same fix applies here.
// `:memory:` isolation is passed via `CRUCIBLE_DB` (CR-CRU-043), so no
// scratch-cwd juggling is needed either.
//
// Binds the SAME port the main e2e suite uses (39_877 / harness.ts's
// `E2E_PORT`, once GREEN adds it) because seedProject's §S3 guard is
// expected to require exactly that port — this config and the main e2e
// suite must therefore never run concurrently. Run standalone:
//   bunx playwright test --config=tests/e2e/teardown-contracts/ephemeral.playwright.config.ts
//
// Imports `E2E_PORT` from harness.ts, which does not exist pre-GREEN — this
// config fails to even LOAD today (a genuine collection-level RED, sanctioned
// by the RED-phase rules: "a compile/collection error... counts as RED").
import { defineConfig } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_PORT } from "../steps/harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");

export default defineConfig({
  testDir: HERE,
  testMatch: /ephemeral\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // Nested under its own subdir (not the shared test-reports/junit.xml the
  // main e2e suite + bun-crucible.py's default `test`/`regression` verbs
  // use) so `auto-ingest --reports tests/e2e/teardown-contracts/test-reports/ephemeral`
  // ingests exactly THIS run, never clobbering / being clobbered by another.
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-reports/ephemeral/junit.xml" }],
  ],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
  },
  webServer: {
    command: `bun run ${SERVER_ENTRY}`,
    env: { CRUCIBLE_PORT: String(E2E_PORT), CRUCIBLE_DB: ":memory:" },
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
