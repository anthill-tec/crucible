// CR-CRU-052 §S5 RED (new contract, cycle 180) — proves the e2e suite's DB
// isolation is REAL, not merely ambient.
//
// Measured 2026-08-03 (CR context, "corrected" paragraph): `playwright.config.ts`
// isolates by pointing the server's `cwd` at a `mkdtempSync` scratch dir and
// genuinely never touches `data/crucible.db` — but `resolveDbPath`
// (`src/server.ts:47-66`, CR-CRU-043) falls through when neither `CRUCIBLE_DB`
// nor `<cwd>/data/crucible.db` is present (which is EXACTLY what a scratch
// cwd guarantees) to `~/.local/share/crucible/crucible.db` — a PERSISTENT,
// USER-LEVEL database. That file was measured holding 79 projects / 259
// events, every one from `/tmp/e2e` fixtures accumulated across e2e runs
// since CR-CRU-043 shipped.
//
// This is deliberately a plain `bun:test` file, not a Playwright spec: no
// live server or worker process is needed to prove this — `resolveDbPath` is
// a pure, synchronous, exported function that takes injectable `env`/`cwd`
// (`ResolveDbPathOpts`, `src/server.ts:25-31`) precisely so this is testable
// without booting anything. This file is naturally excluded from the
// standalone Playwright configs in this directory (their `testMatch`
// anchors only match `ephemeral.contract.ts` / `non-ephemeral.contract.ts`)
// and naturally INCLUDED in the plain `bun test` regression gate, which is
// exactly where a fast pure-function contract like this belongs.
//
// Design note (per dispatch): a text-match/grep on playwright.config.ts's
// source for the string "CRUCIBLE_DB" was deliberately NOT used — it would
// pass on `CRUCIBLE_DB: someUndefinedVariable` or a key nested somewhere
// that never reaches the actual child-process env, proving nothing about
// runtime behaviour. Instead this test imports the REAL, evaluated
// `webServer.env` object from the real config module and feeds it into the
// REAL `resolveDbPath` from a scratch cwd guaranteed to hold no
// `data/crucible.db` (mirroring exactly the shape that caused the measured
// leak), then asserts the resulting path is neither the user-level default
// nor the `XDG_DATA_HOME` fallback — a genuine behavioural/round-trip proof
// that the config's env, not an accidental cwd/HOME coincidence, is what
// drives isolation.
//
// TODAY (pre-GREEN): `playwright.config.ts`'s `webServer.env` carries only
// `{ CRUCIBLE_PORT }` (verified this cycle by importing the real config
// module) — no `CRUCIBLE_DB` key at all — so the first assertion below fails
// for a real, non-vacuous reason.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDbPath } from "../../../src/server.ts";
// eslint-disable-next-line import/no-relative-parent-imports
import playwrightConfig from "../../../playwright.config.ts";

/** `webServer` is typed as a single entry OR an array of entries — this repo
 * only ever configures one, so unwrap defensively rather than assume the
 * shape. */
function webServerEnvOf(
  config: typeof playwrightConfig,
): Record<string, string | undefined> | undefined {
  const ws = config.webServer;
  if (ws === undefined) return undefined;
  const entry = Array.isArray(ws) ? ws[0] : ws;
  return entry?.env as Record<string, string | undefined> | undefined;
}

describe(
  "§S5 — playwright.config.ts sets CRUCIBLE_DB explicitly, so a default e2e " +
    "run cannot resolve to the persistent user-level database",
  () => {
    test(
      "webServer.env carries an explicit, non-empty CRUCIBLE_DB (not left " +
        "for cwd/XDG fallthrough to resolve)",
      () => {
        const webServerEnv = webServerEnvOf(playwrightConfig);

        // POSITIVE — this is the exact AC: "playwright.config.ts sets
        // CRUCIBLE_DB explicitly". `resolveDbPath`'s own env-lookup treats
        // undefined AND "" as "not set" (`fromEnv !== undefined && fromEnv
        // !== ""`), so both must be ruled out here, not just "the key is
        // present".
        const crucibleDb = webServerEnv?.CRUCIBLE_DB;
        expect(typeof crucibleDb).toBe("string");
        expect(crucibleDb).not.toBe("");
        // Runtime-verified above to be a non-empty string; cast satisfies
        // the type checker for the resolveDbPath call and equality check
        // below (a failed expect() already throws before this line runs).
        const crucibleDbValue = crucibleDb as string;

        // BEHAVIOURAL — feed the config's ACTUAL declared env (nothing
        // merged in from this test process's own environment, so a
        // contaminating ambient CRUCIBLE_DB here could never launder a
        // missing one in the config) into the REAL resolveDbPath, from a
        // freshly created scratch cwd guaranteed to hold no
        // `data/crucible.db` — precisely the shape `playwright.config.ts`'s
        // own SCRATCH_CWD guarantees for every real e2e run.
        const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cr052-s5-resolve-"));
        try {
          const resolved = resolveDbPath({
            env: (webServerEnv ?? {}) as NodeJS.ProcessEnv,
            cwd: scratchCwd,
          });

          const home = process.env.HOME ?? os.homedir();
          const userLevelDefault = path.join(home, ".local", "share", "crucible", "crucible.db");
          const xdgDataHome = process.env.XDG_DATA_HOME;
          const xdgFallback =
            xdgDataHome !== undefined && xdgDataHome !== ""
              ? path.join(xdgDataHome, "crucible", "crucible.db")
              : undefined;

          // NEGATIVE / bound — the exact defect this contract exists to
          // catch: resolution must NEVER land on the persistent user-level
          // DB the measurement found holding 79 projects / 259 events.
          expect(resolved).not.toBe(userLevelDefault);
          if (xdgFallback !== undefined) {
            expect(resolved).not.toBe(xdgFallback);
          }

          // POSITIVE — resolution must land on EXACTLY the value the
          // config's CRUCIBLE_DB declared, proving the explicit env var —
          // not an accidental cwd/HOME/XDG side effect — drove the result.
          expect(resolved).toBe(crucibleDbValue);
        } finally {
          fs.rmSync(scratchCwd, { recursive: true, force: true });
        }
      },
    );

    test(
      "resolveDbPath demonstrably falls through to the user-level default " +
        "from the SAME scratch-cwd shape when CRUCIBLE_DB is absent " +
        "(corroborates why the config-level guard above is necessary, not " +
        "an assertion on production code)",
      () => {
        const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cr052-s5-corroborate-"));
        try {
          // An explicitly empty `env` — no CRUCIBLE_DB, no XDG_DATA_HOME, no
          // HOME — isolates this corroboration from whatever this test
          // process's own environment happens to carry.
          const resolved = resolveDbPath({ env: {}, cwd: scratchCwd });

          // With no CRUCIBLE_DB, no cwd/data/crucible.db, and no
          // XDG_DATA_HOME, resolveDbPath's rule 4 falls through to
          // `<HOME>/.local/share/crucible/crucible.db`. This corroborates
          // the CR's diagnosis of the defect; it is not itself part of the
          // §S5 AC (which is about the CONFIG setting CRUCIBLE_DB), so it
          // intentionally does not assert a specific HOME-derived value —
          // only that it lands in the `.local/share/crucible` shape the
          // defect describes.
          expect(resolved.endsWith(path.join(".local", "share", "crucible", "crucible.db"))).toBe(
            true,
          );
        } finally {
          fs.rmSync(scratchCwd, { recursive: true, force: true });
        }
      },
    );
  },
);
