// CR-CRU-131 §S1c — the TEST PROCESS declares its own store, before any suite
// loads. Wired in `bunfig.toml` as `[test] preload`, so it applies to every
// invocation of the runner: a bare `bun test`, a narrowed target from
// `scripts/run-test-target.ts`, and a single file run by hand.
//
// ── The hazard this closes ────────────────────────────────────────────────
//
// `resolveStore` (src/server.ts) rule 3 ADOPTS an already-existing
// `<cwd>/data/crucible.db`, and `serverConfigPath()` (src/limits.ts) puts the
// server's configuration beside it. `data/` is untracked operator state —
// deliberately, because tracking it would turn an operator's edit into a git
// diff on every install. So with `$CRUCIBLE_DB` unset, a suite run from the
// repo root resolved `<repo>/data/crucible.toml` on a developer's machine and
// resolved nothing on a fresh clone or in CI. Same code, same command, two
// different caps — green here, red there, surfacing at gate time wearing an
// unrelated face. C2 found the first instance by measurement
// (tests/milestone-records-are-queryable-by-type.test.ts ingests 5001 events)
// and migrated that one suite by hand; nothing stopped the next one.
//
// DECLARED, not merely absent: a suite that is isolated only because a file
// happens not to exist is isolated by luck. Setting it unconditionally is the
// point — an inherited `$CRUCIBLE_DB` from the shell that launched the runner
// is exactly the ambient state a test must not resolve against, and this
// project's own board runs from this checkout.
//
// ── Why a fixed path, and why nothing creates it ──────────────────────────
//
// `resolveStore` only COMPUTES this path; the rule-3 probe never fires once
// rule 2 matches, and nothing here touches the filesystem. Every suite that
// wants a store opens `:memory:` or its own scratch file (see
// tests/helpers/server-limits-fixture.ts), so this path is a declaration of
// where the process would look rather than a database anybody uses. A fixed
// name under the OS temp dir keeps it inspectable when something does open it
// by accident — which is the bug, and is then visible outside the checkout
// instead of silently landing on the live board's own database.
//
// ── A run-scoped temp root ────────────────────────────────────────────────
//
// A test that forgets to remove its scratch directory must not leave it in
// the system temp root. So, before any suite loads, this preload makes ONE
// directory for the whole run UNDER the inherited temp root, points `TMPDIR`
// at it (so `os.tmpdir()`, and every child spawned with this process's
// environment, resolves inside it) and removes it when the run exits — on a
// passing run, a failing run, or an interrupt. Because it lives under the
// inherited root, a path a test checks against that root still matches.
//
// `CRUCIBLE_TEST_TMPROOT_DISABLE=1` skips it entirely, so a check can prove
// a suite cleans up on its own rather than being swept up after.
//
// "When the run exits" needs one more thing under this runner: `bun test`
// (measured on 1.4.2) ends without emitting the process `exit` event, so an
// `exit` listener — the one end-of-process hook a module can register
// whether it is loaded by `bun test`, by plain `bun`, or by Node (a
// Playwright config is all three) — never runs. A root-level `afterAll`
// here runs after every file's own hooks, and emits that event once, so a
// module's own `exit` cleanup runs at the end of a test run exactly as it
// does at the end of any other process. This is independent of the switch
// above: it removes nothing itself, it only lets a module's own cleanup run.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMPROOT_DISABLE_ENV = "CRUCIBLE_TEST_TMPROOT_DISABLE";

afterAll(() => {
  process.emit("exit", typeof process.exitCode === "number" ? process.exitCode : 0);
});

if (process.env[TMPROOT_DISABLE_ENV] !== "1") {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "crucible-test-run-"));
  process.env.TMPDIR = runDir;
  const removeRunDir = (): void => {
    rmSync(runDir, { recursive: true, force: true });
  };
  process.on("exit", removeRunDir);
  const exitOnSignal = (code: number) => (): void => {
    removeRunDir();
    process.exit(code);
  };
  process.once("SIGINT", exitOnSignal(130));
  process.once("SIGTERM", exitOnSignal(143));
}

process.env.CRUCIBLE_DB = path.join(
  os.tmpdir(),
  "crucible-test-suite-store",
  "crucible.db",
);
