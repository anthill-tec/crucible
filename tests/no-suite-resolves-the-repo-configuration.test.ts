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
//   (a) the test process DECLARES its own store, outside the checkout, so rule
//       3's `<cwd>/data/crucible.db` probe is never the thing that decides.
//       Declared, not merely absent — a suite that is isolated only because a
//       file happens not to exist is isolated by luck.
//   (b) every limit-sensitive suite owns that isolation too, asserted over the
//       test tree so a suite written next month inherits it.
//
// (a) is what makes this deterministic rather than machine-dependent: it is
// RED on a developer's machine and RED in CI, for the same reason, and the fix
// is the same in both.
//
// ── HOW IT FAILS IF THE CODE DOES NOTHING ────────────────────────────────
//
// Today nothing sets `$CRUCIBLE_DB` for the suite as a whole — only the seven
// suites C2 migrated set it, each for itself, inside their own fixtures. So
// (a) reports `CRUCIBLE_DB is not set`, and on this machine
// `serverConfigPath()` answers `<repo>/data/crucible.toml` — the live board's
// own operator file, which is exactly what a test must never read.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Nothing here opens a Store, boots a server, or writes anything anywhere.
// `resolveStore` is pure apart from one `existsSync` probe, and it is driven
// with an INJECTED environment for the control, so no process state is
// mutated. `data/crucible.toml` is never read and `data/crucible.db` is never
// opened.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { serverConfigPath, SERVER_LIMIT_NAMES } from "../src/limits.ts";
import { resolveStore } from "../src/server.ts";
import { listFiles, REPO_ROOT } from "./helpers/source-scan.ts";

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

// ── The tree scan's two halves ────────────────────────────────────────────
//
// SENSITIVE: a suite whose outcome a resolved limit can change — it names a
// limit (or the file limits live in, or the resolver) AND it stands up the
// machinery that enforces one. Both halves are required, and the second is
// what keeps the pure source-scanning guards out: tests/project-namespace-
// tripwire.test.ts reads `src/limits.ts` as TEXT and opens nothing, so no
// limit can reach it.
//
// ISOLATED: the suite names `CRUCIBLE_DB` itself, or imports the shared
// fixture that sets it (tests/helpers/server-limits-fixture.ts) — the one
// place this repo writes a scratch config, lifted there in C2 precisely so a
// second hand-rolled copy never gets written.
const LIMIT_WORDS = [...SERVER_LIMIT_NAMES, "crucible.toml", "src/limits.ts"];
const ENFORCEMENT_MARKERS = ["Store.open", "startServer", "boot("];
const ISOLATION_MARKERS = ["CRUCIBLE_DB", "server-limits-fixture"];

const names = (file: string): string => relative(REPO_ROOT, file);

describe("CR-CRU-131 §S1c — no suite resolves the server's configuration from the repo's own data/", () => {
  test("the test process declares a store outside the checkout, and every limit-sensitive suite owns its own configuration", () => {
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

    // ── (a) THE PROCESS DECLARES ITS OWN STORE. ───────────────────────────
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
    expect(configured).not.toBe(join(REPO_ROOT, "data", "crucible.toml"));
    expect(
      insideRepo(configured),
      `the server's configuration resolves to ${configured}, inside the checkout — the live ` +
        `board's own operator file, which decides what this repo's :3849 instance caps at`,
    ).toBe(false);

    // ── (b) EVERY LIMIT-SENSITIVE SUITE OWNS ITS OWN. ─────────────────────
    const suites = listFiles("tests", [".ts"]).filter((f) => f.endsWith(".test.ts"));
    expect(suites.length, "the test tree must be real").toBeGreaterThan(100);

    const sensitive: string[] = [];
    const offenders: string[] = [];
    for (const file of suites) {
      const text = readFileSync(file, "utf8");
      const caresAboutALimit = LIMIT_WORDS.some((word) => text.includes(word));
      const enforcesOne = ENFORCEMENT_MARKERS.some((marker) => text.includes(marker));
      if (!caresAboutALimit || !enforcesOne) continue;
      sensitive.push(names(file));
      if (!ISOLATION_MARKERS.some((marker) => text.includes(marker))) offenders.push(names(file));
    }

    // The scan's OWN control: it must actually select suites, and it must not
    // select all of them — a predicate that matched everything or nothing
    // would make the verdict below meaningless either way.
    expect(sensitive.length, "the predicate selected no suite at all").toBeGreaterThan(4);
    expect(
      sensitive.length,
      "the predicate selected the whole tree, so it is not discriminating",
    ).toBeLessThan(suites.length);
    // The suite C2 found by hand must be among them — it is the measured
    // instance of this hazard, and a predicate that missed it would be
    // policing a class that excludes its own exemplar.
    expect(sensitive).toContain("tests/milestone-records-are-queryable-by-type.test.ts");

    if (offenders.length > 0) {
      throw new Error(
        `CR-CRU-131 §S1c: ${String(offenders.length)} limit-sensitive suite(s) resolve their ` +
          `configuration from wherever the machine puts it — ${offenders.join(", ")}. Each must ` +
          `point $CRUCIBLE_DB at a temporary directory and own its own config file (the shared ` +
          `fixture tests/helpers/server-limits-fixture.ts does both). Otherwise the suite passes ` +
          `on a machine carrying data/crucible.toml and fails on one that does not, for a reason ` +
          `nothing in its own text mentions.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
