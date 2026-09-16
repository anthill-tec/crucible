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
import * as os from "node:os";
import * as path from "node:path";

process.env.CRUCIBLE_DB = path.join(
  os.tmpdir(),
  "crucible-test-suite-store",
  "crucible.db",
);
