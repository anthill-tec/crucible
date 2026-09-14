// CR-CRU-131 §S1b — a limit has NO environment-variable layer, and the
// transition off the one it had does not change what this fleet runs at.
//
// ── What C1 left standing, and why it had to ───────────────────────────────
//
// C1 made every server limit resolve from a `crucible.toml` read at the point
// of use, and deliberately left three overrides in front of that file:
//
//   src/store.ts:747   Number(process.env.CRUCIBLE_DEFAULT_RETENTION)
//   src/store.ts:843   Number(process.env.CRUCIBLE_RUN_ABANDON_MS)
//   src/v2.ts:371      Number(process.env.CRUCIBLE_PROJECT_INACTIVE_MS ?? "")
//
// They are retired here. The reason is the CR's own: a limit read from the
// environment is a limit with no `description`, no `recommended`, no `min` and
// no `max` — no record of what we advise or of what is supportable — which is
// the exact condition PRD §4.13 exists to end, and "a second way to say the
// same thing is a second place to look when a value is not what you expected"
// (CR-CRU-131 Context).
//
// `CRUCIBLE_DB`, `CRUCIBLE_PORT` and `CRUCIBLE_PROJECT_KEY` are NOT limits and
// are untouched — they answer *where am I* and *who am I*, which must be
// answerable BEFORE any file can be found. The scan at the bottom EXCLUDES
// them by name and proves they are still there, which is what stops it
// degenerating into "no CRUCIBLE_* string anywhere".
//
// ── THE TRANSITION IS THE LOAD-BEARING PART ────────────────────────────────
//
// This project's board runs today with `CRUCIBLE_DEFAULT_RETENTION=5000` in
// its process environment, set by hand at CR-CRU-129's close-out. Retention's
// documented exception (§S1b) is that an ABSENT or MALFORMED file means the
// operator configured NOTHING and there is therefore NO cap. So retiring the
// variable on a board with no `crucible.toml` would turn a 5000-row cap into
// an unbounded one, silently, and the only symptom would be a disk filling up
// months later.
//
// That is why `transitionPreservesTheCap` below compares two EVICTIONS rather
// than reading a number back: a test that only asserted "the variable is
// ignored" passes perfectly on a board that has just gone unbounded. This one
// fails there twice over — it asserts that the documentation-only file EVICTED
// something, and that what it left is exactly `recommended` rows.
//
// ── No test pins a limit VALUE (PRD §4.13, user ruling) ────────────────────
//
// Nothing below spells 5000, 1_800_000 or any other limit. Every expectation
// is derived from the shipped declaration read off `shippedLimits()`, and the
// only numbers written out are arithmetic on values read back. A test that
// hardcoded the limit it checks would freeze the same defect from the other
// side.
//
// ── Safety ─────────────────────────────────────────────────────────────────
//
// Every Store is ":memory:" and every `crucible.toml` is in a fresh OS tmpdir
// (tests/helpers/server-limits-fixture.ts). `CRUCIBLE_DB` is set only so the
// config path resolves beside it; no database is opened there, `data/crucible.db`
// is never touched, and nothing here talks to the running board.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Store } from "../src/store.ts";
import { retentionDisclosure } from "../src/server.ts";
import { serverConfigPath, shippedLimits } from "../src/limits.ts";
import {
  BOOTSTRAP_ENV,
  RETIRED_LIMIT_ENV,
  activeFlags,
  boot,
  declare,
  documentOnly,
  eventCount,
  ingest,
  projectLastActiveAgo,
  projectOutlivingHorizon,
  restoreServerLimitsFixture,
  seedProject,
  serverConfigDir,
  setEnv,
  survivingIds,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";
import { REPO_ROOT, listFiles } from "./helpers/source-scan.ts";

afterEach(restoreServerLimitsFixture);

/**
 * Set a retired variable AND hold on to the exact string, so the behavioural
 * assertion that follows can prove it was STILL SET at the moment the limit
 * was observed.
 *
 * Without that proof, "the override had no effect" and "the override was never
 * applied" are the same observation — and the second is a fixture bug that
 * would make every test in this section vacuous. `serverConfigDir()` clears
 * all three variables on the way in, which is precisely what makes the hazard
 * real rather than hypothetical.
 */
function override(name: string, value: number): string {
  setEnv(name, String(value));
  return String(value);
}

function stillSet(name: string, raw: string): void {
  expect(
    process.env[name],
    `$${name} must still be SET where the limit is observed, or "no effect" is ` +
      `indistinguishable from "never applied"`,
  ).toBe(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — the override has NO EFFECT, per variable, per limit
// ═══════════════════════════════════════════════════════════════════════════
//
// RED, all three. Today each resolver reads its variable FIRST and returns it
// whenever it is finite and positive (src/store.ts:747, :843, src/v2.ts:371),
// so each test below observes the OVERRIDE's number at the enforcement site
// where the FILE's is asserted.
//
// Observed at the real site in every case — the eviction the store performs,
// the sweep's own verdict, the `active` flag the dashboard's route serves —
// never by reading a resolver's return value, because a resolver that returned
// the right number and was wired to nothing would pass that.

describe("CR-CRU-131 §S1b — $CRUCIBLE_DEFAULT_RETENTION no longer decides what the store keeps", () => {
  test("with the variable set far from the file's `value`, eviction stops at the FILE's cap", () => {
    const dir = serverConfigDir();
    const shipped = shippedLimits().retention!;
    // The file's number and the variable's, distinguishable by construction so
    // a resolver obeying either one lands somewhere the other does not.
    const configured = shipped.min;
    const ignored = shipped.min * 4;
    expect(ignored, "the two numbers must be distinguishable").toBeGreaterThan(configured);
    writeConfig(dir, { retention: declare(shipped, configured) });
    const raw = override("CRUCIBLE_DEFAULT_RETENTION", ignored);

    const store = Store.open(":memory:");
    const key = seedProject(store, "retention-override-subject");
    const written = ingest(store, key, ignored * 2);

    stillSet("CRUCIBLE_DEFAULT_RETENTION", raw);
    // POSITIVE — the file's cap, exactly.
    expect(eventCount(store, key)).toBe(configured);
    // NEGATIVE — not the variable's cap, and not unbounded either: both are
    // the failures this retirement could produce, and they are different bugs.
    expect(eventCount(store, key)).not.toBe(ignored);
    expect(eventCount(store, key)).toBeLessThan(written.length);
    // The rows that went are the OLDEST ones, so this is retention and not a
    // fixture that simply wrote fewer events than it claimed.
    expect(survivingIds(store, key)).toEqual(written.slice(written.length - configured));
  });
});

describe("CR-CRU-131 §S1b — $CRUCIBLE_RUN_ABANDON_MS no longer decides when the sweep gives up", () => {
  test("with the variable set to a far longer deadline, the sweep abandons at the FILE's", () => {
    const dir = serverConfigDir();
    const shipped = shippedLimits().run_abandon_ms!;
    const deadline = shipped.min;
    const ignored = shipped.max;
    // The sweep is driven to a moment PAST the file's deadline and far short of
    // the variable's, which is the only instant at which the two disagree.
    const drivenTo = deadline * 2;
    expect(drivenTo).toBeGreaterThan(deadline);
    expect(drivenTo, "the two deadlines must be distinguishable").toBeLessThan(ignored);
    writeConfig(dir, { run_abandon_ms: declare(shipped, deadline) });
    const raw = override("CRUCIBLE_RUN_ABANDON_MS", ignored);

    const store = Store.open(":memory:");
    // The horizon is the LONGER of the two, so the agent cannot tombstone at
    // the instant swept — `agent died` is checked before the deadline is
    // (src/store.ts:3745) and would settle the run for the wrong reason.
    const key = projectOutlivingHorizon(store, ignored, "abandon-override-subject");
    const run = store.startRun(key, "abandon-override-agent");

    stillSet("CRUCIBLE_RUN_ABANDON_MS", raw);
    // NEGATIVE — one millisecond short of the FILE's deadline settles nothing,
    // so the abort below is that deadline arriving and not a sweep that
    // abandons everything it sees.
    expect(store.sweepOpenRuns(run.startedAt + deadline - 1)).toEqual([]);
    expect(store.listOpenRuns(key).map((r) => r.runId)).toEqual([run.runId]);

    // POSITIVE — settled at the file's deadline, for the deadline's own reason.
    const settled = store.sweepOpenRuns(run.startedAt + drivenTo);
    expect(settled.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(store.listOpenRuns(key)).toEqual([]);
  });
});

describe("CR-CRU-131 §S1b — $CRUCIBLE_PROJECT_INACTIVE_MS no longer decides the activity verdict", () => {
  test("with the variable set to a far wider window, GET /api/v2/projects judges by the FILE's", async () => {
    const dir = serverConfigDir();
    const shipped = shippedLimits().project_inactive_ms!;
    const window = shipped.min;
    const ignored = shipped.max;
    // Older than the file's window, comfortably inside the variable's: the one
    // age at which the two answers differ.
    const age = window * 2;
    expect(age).toBeGreaterThan(window);
    expect(age, "the two windows must be distinguishable").toBeLessThan(ignored);
    writeConfig(dir, { project_inactive_ms: declare(shipped, window) });
    const raw = override("CRUCIBLE_PROJECT_INACTIVE_MS", ignored);

    const handle = boot();
    const past = projectLastActiveAgo(handle.store, age, "inactive-override-subject");
    // NEGATIVE control — a project INSIDE the file's window, so a route that
    // simply called everything inactive could not pass.
    const within = projectLastActiveAgo(
      handle.store,
      Math.floor(window / 2),
      "active-override-control",
    );

    stillSet("CRUCIBLE_PROJECT_INACTIVE_MS", raw);
    const flags = await activeFlags(handle);
    expect(flags.get(past)).toBe(false);
    expect(flags.get(within)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — THE TRANSITION: retiring the variable must not move this fleet's cap
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-131 §S1b — the retirement preserves the cap this board already runs at", () => {
  test("a documentation-only crucible.toml evicts to the same surviving rows whether the retired variable is set or gone", () => {
    const dir = serverConfigDir();
    const shipped = shippedLimits().retention!;
    // The cap an unedited, installed file resolves: four fields of
    // documentation and no `value` anywhere. On this fleet that is the number
    // CR-CRU-129's close-out put into the environment by hand, which is the
    // whole reason the retirement is safe — but the test derives it from the
    // declaration rather than spelling it, so it stays true if the
    // recommendation ever moves.
    const cap = shipped.recommended;
    const overshoot = 3;
    writeConfig(dir, { retention: documentOnly(shipped) });

    // HALF ONE — the retired variable still in the environment, carrying a
    // number nothing like the file's.
    const raw = override("CRUCIBLE_DEFAULT_RETENTION", shipped.min);
    expect(shipped.min, "the variable must carry a number the file does not").not.toBe(cap);
    const withVariable = Store.open(":memory:");
    const keyA = seedProject(withVariable, "transition-with-variable");
    const writtenA = ingest(withVariable, keyA, cap + overshoot);
    stillSet("CRUCIBLE_DEFAULT_RETENTION", raw);
    const survivorsA = survivingIds(withVariable, keyA);

    // HALF TWO — the variable gone, the SAME file.
    for (const name of RETIRED_LIMIT_ENV) delete process.env[name];
    expect(process.env.CRUCIBLE_DEFAULT_RETENTION).toBeUndefined();
    const withoutVariable = Store.open(":memory:");
    const keyB = seedProject(withoutVariable, "transition-without-variable");
    const writtenB = ingest(withoutVariable, keyB, cap + overshoot);
    const survivorsB = survivingIds(withoutVariable, keyB);

    // NON-VACUITY — both halves genuinely EVICTED. Two empty result sets, or
    // two untouched ones, are trivially equal: this is the assertion that
    // fails on a board which has quietly become unbounded, because there
    // nothing is ever evicted and `survivorsB` is the whole fixture.
    expect(writtenA.length - survivorsA.length).toBe(overshoot);
    expect(writtenB.length - survivorsB.length).toBe(overshoot);

    // THE SAME ROWS SURVIVE — the newest `cap` of each fixture, so the cap did
    // not merely have the same size, it fell in the same place.
    expect(survivorsA).toEqual(writtenA.slice(overshoot));
    expect(survivorsB).toEqual(writtenB.slice(overshoot));
    expect(survivorsA.length).toBe(survivorsB.length);
    expect(survivorsB.length).toBe(cap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — retention's DOCUMENTED exception survives the retirement unchanged
// ═══════════════════════════════════════════════════════════════════════════
//
// GREEN-GUARD, not RED: this is CR-CRU-129's behaviour, and the point is that
// the variable was never what produced it. It passes today and must keep
// passing — a retirement that also deleted the no-cap-when-unconfigured rule
// would be a different CR, and one that silently started evicting on every
// board with no file.

describe("CR-CRU-131 §S1b — with no variable AND no file, retention is still UNCAPPED and still says so", () => {
  test("nothing is evicted and the boot disclosure names the uncapped project", () => {
    const dir = serverConfigDir(); // no crucible.toml is written at all
    expect(existsSync(join(dir, "crucible.toml"))).toBe(false);
    for (const name of RETIRED_LIMIT_ENV) expect(process.env[name]).toBeUndefined();

    const store = Store.open(":memory:");
    const key = seedProject(store, "bounded-by-nothing");
    const written = ingest(store, key, shippedLimits().retention!.min * 4);

    // Nothing evicted: the count is the fixture's own, not a cap.
    expect(eventCount(store, key)).toBe(written.length);

    // And the SUFFICIENT half, because a fixture smaller than the
    // recommendation would survive a cap too: `retentionDisclosure` returns
    // `null` the moment ANY cap resolves (src/server.ts:321), so a line here
    // is the observable form of "no cap resolves at all".
    const disclosure = retentionDisclosure(store);
    expect(disclosure).not.toBeNull();
    expect(disclosure).toContain(store.getProject(key)!.name);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — the advice stops naming a lever that no longer exists
// ═══════════════════════════════════════════════════════════════════════════
//
// RED. `retentionDisclosure()` (src/server.ts:325, :327) currently tells an
// operator to "Set $CRUCIBLE_DEFAULT_RETENTION to bound every project". After
// this cycle that instruction is unfollowable, and unfollowable advice on the
// boot banner is worse than none: it sends an operator to a lever, they pull
// it, and the board stays unbounded with nothing saying why.

describe("CR-CRU-131 §S1b — the uncapped-retention disclosure names the FILE and the LIMIT", () => {
  test("it names the crucible.toml to edit and the `retention` limit to set there, and no retired variable", () => {
    const dir = serverConfigDir();
    const store = Store.open(":memory:");
    seedProject(store, "advice-subject");

    const disclosure = retentionDisclosure(store);
    expect(disclosure).not.toBeNull();

    // The FILE, by the path this server would actually read — named rather
    // than described, because "a config file" on a machine carrying two of
    // them tells an operator nothing (src/limits.ts `unreadableLine`).
    expect(serverConfigPath()).toBe(join(dir, "crucible.toml"));
    expect(disclosure).toContain(serverConfigPath());

    // The LIMIT they must configure in it, by its own name.
    expect(disclosure).toContain("retention");

    // NEGATIVE — the advice cannot name a lever this cycle removed.
    for (const name of RETIRED_LIMIT_ENV) {
      expect(disclosure, `the disclosure still sends the operator to $${name}`).not.toContain(name);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — a retired NAME survives nowhere in the shipped tree, source or prose
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE scan, both stacks: `src/` is the server's, `clients/` is the clients',
// `public/` is what a browser is served. Prose counts as well as code, and
// deliberately: `clients/bun-crucible.py:928` is not a comment, it is text a
// CLIENT EMITS to a user — "older than CRUCIBLE_RUN_ABANDON_MS" — and
// src/server.ts:303 is a comment that would go on teaching the next author a
// mechanism that no longer exists. Neither may survive.
//
// `docs/` is NOT scanned, and that is the distinction: a CR, the PRD and the
// RUNBOOK must be free to RECORD that these variables existed and were
// retired. An operator who learned one from the source has to be able to find
// out it is gone.

const SHIPPED_TREES = ["src", "clients", "public"];
const SCANNED_EXTS = [".ts", ".js", ".mjs", ".py", ".html", ".css"];

interface Hit {
  name: string;
  where: string;
  line: string;
}

function hitsFor(names: readonly string[], corpus: Map<string, string>): Hit[] {
  const hits: Hit[] = [];
  for (const [file, text] of corpus) {
    const lines = text.split("\n");
    for (const name of names) {
      lines.forEach((line, index) => {
        if (line.includes(name)) {
          hits.push({ name, where: `${file}:${index + 1}`, line: line.trim() });
        }
      });
    }
  }
  return hits;
}

describe("CR-CRU-131 §S1b — no retired limit variable is named in the shipped tree", () => {
  test("neither src/, clients/ nor public/ still names one, in code or in the prose it emits", () => {
    const corpus = new Map(
      SHIPPED_TREES.flatMap((dir) => listFiles(dir, SCANNED_EXTS)).map((file) => [
        relative(REPO_ROOT, file),
        readFileSync(file, "utf8"),
      ]),
    );

    // NON-VACUITY, in both directions. The corpus is real...
    expect(corpus.size).toBeGreaterThan(20);
    // ...and this scan can see an environment variable's name when one is
    // there. `CRUCIBLE_DB`, `CRUCIBLE_PORT` and `CRUCIBLE_PROJECT_KEY` are
    // EXCLUDED from the retirement by name, not by prefix: they are bootstrap
    // and identity — the store to open, the port to listen on, the project a
    // client belongs to — and they must be answerable BEFORE any file can be
    // found, because finding the file is what they decide. A limit is the
    // opposite: it has a description, a recommendation and a supportable
    // range, and it is only ever needed once the process is already running.
    // They are still in the tree, so a green result below is the retirement's
    // doing and not an empty walk.
    const kept = BOOTSTRAP_ENV.filter((name) =>
      [...corpus.values()].some((text) => text.includes(name)),
    );
    expect(kept).toEqual([...BOOTSTRAP_ENV]);
    // The two sets are disjoint, so "retire one" can never quietly mean
    // "retire a bootstrap variable".
    expect(RETIRED_LIMIT_ENV.filter((name) => BOOTSTRAP_ENV.includes(name))).toEqual([]);

    const offenders = hitsFor(RETIRED_LIMIT_ENV, corpus);
    if (offenders.length > 0) {
      throw new Error(
        `CR-CRU-131 §S1b: ${offenders.length} occurrence(s) of a RETIRED limit variable remain ` +
          `in the shipped tree — ${offenders.map((h) => `${h.where} (${h.name})`).join(" | ")}. ` +
          `A limit is CONFIGURATION, declared with a description, a recommendation and a ` +
          `supportable range in a \`crucible.toml\`; an environment variable carries none of ` +
          `those, and a second way to set a limit is a second place to look when a value is not ` +
          `what you expected. Code must resolve it through the file, and prose — including text ` +
          `a client EMITS to a user — must name the LIMIT rather than the variable. First line: ` +
          `${offenders[0]!.line}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
