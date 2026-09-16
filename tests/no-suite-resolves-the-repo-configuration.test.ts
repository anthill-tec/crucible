// CR-CRU-131 §S1c — the ISOLATION GUARD: no suite resolves the server's
// configuration from the repo's own `data/`.
//
// ── The hazard, measured ──────────────────────────────────────────────────
//
// `data/crucible.toml` is UNTRACKED operator state, deliberately: tracking it
// would turn an operator's edit into a git diff on every install, which is the
// whole reason the installer split exists. But `resolveStore` (src/server.ts:
// 61) rule 3 ADOPTS an already-existing `<cwd>/data/crucible.db`, and
// `serverConfigPath()` (src/limits.ts) puts the config beside it. So with
// `$CRUCIBLE_DB` unset, a suite run from the repo root resolves
// `<repo>/data/crucible.toml` ON A DEVELOPER'S MACHINE and resolves nothing on
// a fresh clone or in CI. Same code, same command, two different caps — green
// here, red there, surfacing at gate time wearing an unrelated face.
//
// C2 RED found the first instance BY MEASUREMENT rather than by policy:
// tests/milestone-records-are-queryable-by-type.test.ts ingests 5001 events
// and asserts more than 5000 are held, so the moment a 5000-row retention
// recommendation became resolvable from the repo root it would have capped at
// EXACTLY 5000 and failed for a reason nothing in its own text mentions. C2
// migrated that one suite by hand. Nothing stopped the next one.
//
// ── What this guard asserts, and why in this shape ────────────────────────
//
// The property is NOT "that one suite was fixed". It is that resolution can
// never depend on what happens to exist on the machine running the suite:
//
//   the test process DECLARES its own store, outside the checkout, so rule 3's
//   `<cwd>/data/crucible.db` probe is never the thing that decides. Declared,
//   not merely absent — a suite that is isolated only because a file happens
//   not to exist is isolated by luck.
//
// That is what makes this deterministic rather than machine-dependent: it is
// RED on a developer's machine and RED in CI, for the same reason, and the fix
// is the same in both. `bunfig.toml`'s `[test] preload` is where it is wired
// (tests/helpers/isolated-store-preload.ts).
//
// ── The clause this REPLACED, and why it is gone ──────────────────────────
//
// RED carried a second half: a scan requiring every limit-sensitive suite's
// own SOURCE TEXT to name `CRUCIBLE_DB` or the shared fixture. It is removed
// because the process-wide declaration SUBSUMES it, not because it was
// inconvenient — and the difference matters to anyone tempted to restore it on
// the grounds that it looks stricter.
//
// Sixteen text markers assert that sixteen authors remembered. A wired preload
// asserts that forgetting is impossible, and it covers suites nobody has
// written yet. The measurement that settled it (2026-09-14): all sixteen suites
// the scan reported already pass `:memory:` or their own scratch file to
// `startServer`/`Store.open`, so no store was ever ambient. The only thing that
// resolved ambiently was `serverConfigPath()`, and it now resolves outside the
// checkout for every suite at once. Restoring the scan would add sixteen
// redundant restatements of process-wide state and teach the next author that
// per-file isolation is the convention — the opposite of what §S1c asks for.
//
// ── The edge the declaration does NOT reach ───────────────────────────────
//
// A child process spawned with an EXPLICIT env dict that omits `CRUCIBLE_DB`
// does not inherit it. Measured across every `Bun.spawn`/`spawnSync` in this
// tree on 2026-09-14: that set is EMPTY of anything at risk. Every client
// harness spreads `process.env`, the two curated-env children
// (tests/cr072-installer-upgrade.test.ts, the e2e webServer) run from scratch
// cwds where rule 3 cannot reach this checkout's `data/`, and this file's own
// probes inject an env into the PURE resolver rather than spawning. So no
// clause is asserted here — inventing one against an empty set would be the
// same proxy in new clothes. If you are adding a child that constructs its own
// env AND resolves a limit, this is the property you have stepped outside of:
// pass `CRUCIBLE_DB` through.
//
// ── HOW IT FAILS IF THE CODE DOES NOTHING ────────────────────────────────
//
// With nothing setting `$CRUCIBLE_DB` for the suite as a whole, this reports
// `CRUCIBLE_DB is not set`, and on a developer's machine `serverConfigPath()`
// answers `<repo>/data/crucible.toml` — the live board's own operator file,
// which is exactly what a test must never read.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Nothing here opens a Store, boots a server, or writes anything anywhere.
// `resolveStore` is pure apart from one `existsSync` probe, and it is driven
// with an INJECTED environment for the control, so no process state is
// mutated. `data/crucible.toml` is never read and `data/crucible.db` is never
// opened.
import { describe, expect, test } from "bun:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { serverConfigPath } from "../src/limits.ts";
import { resolveStore } from "../src/server.ts";
import { REPO_ROOT } from "./helpers/source-scan.ts";

// Captured at MODULE LOAD, before any `beforeEach` in this file can touch it:
// what the suite handed this file, not what this file arranged for itself.
const AMBIENT_DB = process.env.CRUCIBLE_DB;

/** Is `candidate` inside this checkout? The one containment rule, shared by
 *  the control and the assertion so they cannot disagree. A path that escapes
 *  the root relativises to something starting `..`; one on another volume
 *  relativises to an ABSOLUTE path, which is why both halves are needed. */
function insideRepo(candidate: string): boolean {
  const rel = relative(REPO_ROOT, resolve(candidate));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

describe("CR-CRU-131 §S1c — no suite resolves the server's configuration from the repo's own data/", () => {
  test("the test process declares a store outside the checkout, so no suite can resolve the repo's own configuration", () => {
    // ── THE CONTROL. ──────────────────────────────────────────────────────
    // The containment predicate has to be able to SEE a path inside the repo,
    // or every assertion below passes by being blind. Driven through the real
    // resolver with an injected environment: pure, writes nothing.
    const repoStore = resolveStore({
      env: { CRUCIBLE_DB: join(REPO_ROOT, "data", "crucible.db") },
    });
    expect(repoStore.rule).toBe("CRUCIBLE_DB");
    expect(
      insideRepo(repoStore.path),
      "the containment check cannot see a store inside the checkout, so a green result below " +
        "would be an empty walk rather than the isolation's doing",
    ).toBe(true);
    expect(insideRepo(resolveStore({ env: { CRUCIBLE_DB: "/tmp/elsewhere/crucible.db" } }).path))
      .toBe(false);

    // ── THE PROCESS DECLARES ITS OWN STORE. ──────────────────────────────
    expect(
      AMBIENT_DB,
      "$CRUCIBLE_DB is not set for the test process, so `resolveStore` falls through to rule 3 " +
        "and ADOPTS `<cwd>/data/crucible.db` wherever that file happens to exist. On a " +
        "developer's machine it does, so the server's `crucible.toml` beside it caps retention " +
        "at the recommendation it declares; on a fresh clone and in CI it does not, so there is " +
        "no cap at all. The suite must DECLARE its store rather than inherit whichever one the " +
        "machine happens to carry.",
    ).toBeDefined();
    expect(AMBIENT_DB ?? "").not.toBe("");
    expect(
      insideRepo(AMBIENT_DB ?? ""),
      `the suite's store resolves INSIDE the checkout (${String(AMBIENT_DB)}); its configuration ` +
        `is then the repo's own untracked operator state`,
    ).toBe(false);

    // …and therefore the file the server would read is not the repo's.
    const configured = serverConfigPath();
    expect(
      insideRepo(configured),
      `the server's configuration resolves to ${configured}, inside the checkout — the live ` +
        `board's own operator file, which decides what this repo's :3849 instance caps at`,
    ).toBe(false);

    // …and the SPECIFIC file C2 found by hand is unreachable. The measured
    // instance of this hazard was a 5001-event ingest capped at exactly 5000 by
    // a `retention` recommendation that only exists on a developer's machine,
    // so naming that file is naming the defect rather than restating the rule.
    expect(
      configured,
      "the resolved configuration is the very file whose `retention` capped " +
        "tests/milestone-records-are-queryable-by-type.test.ts at 5000 on one machine and left " +
        "it uncapped on another",
    ).not.toBe(join(REPO_ROOT, "data", "crucible.toml"));
  });
});
