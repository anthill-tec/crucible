// CR-CRU-052 §S3 RED — proves seedProject refuses a non-ephemeral target
// (contract 4). Deliberately configured with a baseURL that is NEITHER
// harness.ts's expected `E2E_PORT` (39_877) NOR anything ever bound in this
// suite: the invented §S3 guard (see ephemeral.contract.ts's header) is
// expected to reject BEFORE any network attempt — a config-introspection
// check (`test.info().project.use.baseURL`), not a round trip — so this
// config's baseURL having NO listener at all is itself part of the proof:
// a connection-refused error would mean the guard ran too late, or never
// ran. Kept fully separate from ephemeral.playwright.config.ts (different
// baseURL) and from the main e2e suite (playwright.config.ts, not touched
// here). Run standalone:
//   bunx playwright test --config=tests/e2e/teardown-contracts/non-ephemeral.playwright.config.ts
//
// Deliberately does NOT import anything from harness.ts beyond the
// already-existing `seedProject` (no E2E_PORT import here) — this config
// and its spec load and RUN cleanly today, producing a genuine assertion
// failure (not a bare collection error) that turns green only once §S3
// actually ships. See non-ephemeral.contract.ts.
//
// RED-FIXUP (cycle 180) — renamed from non-ephemeral.spec.ts (and
// testMatch updated to match) so plain `bun test` no longer sweeps this
// file into the regression gate — see ephemeral.playwright.config.ts's
// header for the full rationale (bun's `.spec.`/`.test.` discovery rule,
// and why `bunfig.toml` exclusion isn't available).
import { defineConfig } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Arbitrary, deliberately NOT harness.ts's E2E_PORT (39_877) — far enough
// away to never collide with the real e2e suite or a stray dev server.
// Nothing is ever bound to it anywhere in this repo's test suite.
const NON_EPHEMERAL_PORT = 48_231;

export default defineConfig({
  testDir: HERE,
  testMatch: /(^|\/)non-ephemeral\.contract\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // Nested under its own subdir (not the shared test-reports/junit.xml the
  // main e2e suite + bun-crucible.py's default `test`/`regression` verbs
  // use) so `auto-ingest --reports tests/e2e/teardown-contracts/test-reports/non-ephemeral`
  // ingests exactly THIS run, never clobbering / being clobbered by another.
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-reports/non-ephemeral/junit.xml" }],
  ],
  use: {
    baseURL: `http://localhost:${NON_EPHEMERAL_PORT}`,
  },
});
