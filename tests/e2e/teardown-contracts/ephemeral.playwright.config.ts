// CR-CRU-052 §S2/§S3 RED — dedicated, ISOLATED Playwright config proving
// harness.ts's teardown + ephemeral-guard contracts against a REAL server
// bound to the real e2e port. Kept separate from the main
// tests/e2e/features BDD suite (playwright.config.ts — GREEN-owned, not
// touched here): one of the scenarios in ephemeral.contract.ts deliberately
// FAILS (§S2 AC — "teardown also runs when a scenario fails"), and a
// permanently-red scenario inside the real regression suite would be a
// standing false alarm forever, not a genuine assertion. See
// ephemeral.contract.ts's header for the full contract rationale.
//
// RED-FIXUP (cycle 180) — two defects fixed here:
//  1. The source files were originally named `ephemeral.spec.ts` /
//     `non-ephemeral.spec.ts`. Bun's default `bun test` file discovery
//     matches any file whose name carries one of the four markers `.test.`,
//     `.spec.`, `_test.` or `_spec.` immediately before its extension —
//     CONFIRMED empirically this cycle by a throwaway glob probe over
//     scratch files outside the repo. The finding is recorded by MARKER
//     rather than by example filename deliberately: those probe files were
//     never committed, and naming a file that does not exist on disk is
//     exactly what CR-CRU-053's dangling-citation guard forbids. What the
//     probe showed: a bare `bun test` collected the probe files whose names
//     carried a `.spec.` or `.test.` marker, and ignored the ones carrying
//     a `.contract.` or `.pw.` marker instead — so both files here were
//     being swept into the plain `bun test` regression gate
//     despite this CR's own stated premise that they stay OUT of it (one of
//     them contains a deliberately-failing scenario, and BOTH require a live
//     server this config boots, which a bare `bun test` never does — hence
//     the "Playwright Test did not expect test() to be called here." errors
//     the plain regression gate was reporting). `bunfig.toml`'s
//     `pathIgnorePatterns` is NOT an available fix: CR-CRU-047 §S1 forbids a
//     permanently-excluded `tests/` directory, and
//     `tests/suite-integrity.test.ts` (out of this agent's scope) asserts
//     `bunfig.toml` carries no such key at all. Renamed instead — to
//     `ephemeral.contract.ts` / `non-ephemeral.contract.ts` — since neither
//     substring matches bun's discovery rule, so plain `bun test` no longer
//     collects them, while THIS config's own `testMatch` below still finds
//     them explicitly by name.
//  2. `testMatch: /ephemeral\.spec\.ts$/` matched `non-ephemeral.spec.ts`
//     too, as a trailing SUBSTRING — so this config ran BOTH files' tests,
//     including non-ephemeral's (which requires no live server and expects
//     a connection to FAIL), against a config that DOES boot a live server
//     on the expected port, defeating that file's own "no listener at all"
//     premise. Fixed by anchoring the match to require nothing (start of
//     path, or a path separator) immediately before "ephemeral", so
//     "non-ephemeral..." — where "ephemeral" is preceded by "non-", never
//     "/" or the start of the string — can never match.
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
  // Anchored so "non-ephemeral.contract.ts" (which ALSO ends with
  // "ephemeral.contract.ts" as a trailing substring) can never match — see
  // the RED-FIXUP header comment above.
  testMatch: /(^|\/)ephemeral\.contract\.ts$/,
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
