// LOADING A PLAYWRIGHT CONFIG IN-PROCESS LEAVES STATE IN `process.env`.
//
// playwright-bdd's `defineBddConfig` records the config dir it was called
// from in `process.env.PLAYWRIGHT_BDD_CONFIGS` (`saveConfigToEnv` in
// node_modules/playwright-bdd/dist/config/env.js) — that is how it hands its
// config to Playwright's workers. A bun test file that imports
// `playwright.config.ts` therefore writes the repo root's entry into the ONE
// environment every later file in the same `bun test` process inherits, and a
// later file that spawns its own Playwright config with `{ ...process.env }`
// hands that stale entry on: the child then sees two `defineBddConfig()`
// calls and refuses with "please manually provide different "outputDir"".
//
// So every test file that loads a Playwright config in-process brackets the
// load: it takes a snapshot BEFORE the config module is evaluated (a dynamic
// `await import` inside `beforeAll`, since a static import would run first)
// and restores it in `afterAll`, leaving `process.env` exactly as it found it.

/** Snapshot `process.env` now; the returned function puts it back — every key
 *  the snapshot lacked is deleted, every key it held gets its old value. */
export function snapshotProcessEnv(): () => void {
  const before: Record<string, string | undefined> = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(before, key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else if (process.env[key] !== value) process.env[key] = value;
    }
  };
}
