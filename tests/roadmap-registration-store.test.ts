// CR-CRU-091 — roadmap registration is declared: the STORAGE half (cycle C1).
//
// Covers §S1 (a proposed release is its own record kind) and §S2 (`queue_entries`
// carries the declaration, and the read publishes it) at the Store boundary.
// The five REST routes (§S8), the role gate (§S3), the client verbs and
// `public/app-logic.mjs` are cycles C2/C3/C4 and are NOT touched here.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `queue_entries` has eight columns (src/store.ts:1146-1156) and none of them
// can hold a declared release, a declared track or a lifecycle disposition, so
// the containment model release ⊃ wave ⊃ CR is undeclarable. `listQueue`'s
// projection (src/store.ts:3094-3104) omits the `seq` the column already
// stores, which is why the renderer re-derives it from the array index
// (public/app-logic.mjs:859). `replaceQueue` (src/store.ts:3032) DELETEs a
// project's rows and re-INSERTs the posted set, so any declaration it was not
// handed is destroyed. And `recordMilestoneEvent` (src/store.ts:1709) has no
// notion of a PROPOSED release: `targetAt` cannot be carried and a shipped
// release cannot consume the proposal it fulfils.
//
// ── The seams GREEN must expose (this suite is written against them) ───────
//
//   // src/store.ts
//   export function normalizeTrack(value: string): string | null;
//     // "2" | "track-2" | "Track 2" -> "track-2"; null when the value carries
//     // NO integer (the caller names the field; the write refuses).
//   class Store {
//     listReleaseProposals(projectKey: string): RunEvent[];  // LIVE, version-ordered
//   }
//   MIGRATION_BODIES gains ONE appended step (queue_entries: release, track,
//   lifecycle_json) so SCHEMA_VERSION === MIGRATIONS.length advances 7 -> 8.
//
//   // src/types.ts
//   QueueEntry     gains seq (ALWAYS), release?, track?, lifecycle?
//   QueueEntryInput gains release?, track?, seq?, lifecycle?
//   RunEvent       gains targetAt? (epoch SECONDS, beside releasedAt)
//   QueueStatus    is UNCHANGED — §S2's second-axis rule.
//
// Every store here is `:memory:` or an mkdtempSync scratch file. The live
// data/crucible.db is never opened.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as storeModule from "../src/store.ts";
import { Store, MIGRATIONS, SCHEMA_VERSION } from "../src/store.ts";
import type { QueueEntryInput } from "../src/store.ts";
import type { QueueEntry, QueueStatus, RunEvent } from "../src/types.ts";

// ── scratch dirs ───────────────────────────────────────────────────────────

const scratchDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru091-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

// ── seam accessors: each fails naming the MISSING CONTRACT, not a TypeError ─

/** §S2 — the ONE normaliser that makes `2` and `track-2` the same lane. */
function normalizeTrack(value: string): string | null {
  const mod = storeModule as { normalizeTrack?: unknown };
  if (typeof mod.normalizeTrack !== "function") {
    throw new Error(
      "CR-CRU-091 §S2: src/store.ts exports no `normalizeTrack` — nothing normalises `--track` " +
        "to the PRD's locked wire format `track-<n>`, so two clients writing `2` and `track-2` " +
        "produce two lanes for one track.",
    );
  }
  return (mod.normalizeTrack as (value: string) => string | null)(value);
}

/** §S1 — the proposals read, beside `listReleases` and isolated from it. */
function listReleaseProposals(store: Store, projectKey: string): RunEvent[] {
  const s = store as { listReleaseProposals?: unknown };
  if (typeof s.listReleaseProposals !== "function") {
    throw new Error(
      "CR-CRU-091 §S1: Store exposes no `listReleaseProposals` — a proposed release cannot be " +
        "read at all without repurposing `listReleases`, which §S1 forbids.",
    );
  }
  return (s.listReleaseProposals as (key: string) => RunEvent[]).call(store, projectKey);
}

// ── raw-sqlite helpers (never a Store — these must not migrate anything) ───

function columnsOf(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()!.user_version;
  } finally {
    db.close();
  }
}

interface StoredDeclaration {
  cr: string;
  wave: string;
  title: string | null;
  seq: number;
  release: string | null;
  track: string | null;
  lifecycle_json: string | null;
}

function storedRows(dbPath: string): StoredDeclaration[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<StoredDeclaration, []>(
        `SELECT cr, wave, title, seq, release, track, lifecycle_json
           FROM queue_entries ORDER BY seq ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

/**
 * A store shaped exactly like the version JUST BEFORE this CR's step: the
 * `queue_entries` table in its pre-091 eight-column shape, carrying rows, and
 * stamped at `SCHEMA_VERSION - 1`. Every OTHER chain step guards on
 * `tableExists`, so on this fixture the ONLY unsatisfied step in the chain is
 * the one this CR appends — which is how the suite identifies it BY EFFECT
 * rather than by index.
 */
function makePreDeclarationStore(dir: string): string {
  const dbPath = join(dir, "crucible.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`
      CREATE TABLE queue_entries (
        project_key TEXT NOT NULL,
        cr TEXT NOT NULL,
        title TEXT,
        wave TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        size TEXT,
        filed_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (project_key, cr)
      );
    `);
    const insert = db.query(
      `INSERT INTO queue_entries
         (project_key, cr, title, wave, depends_on_json, size, filed_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(PRE_KEY, "CR-CRU-014", "queue registration", "1", "[]", "M", 1_700_000_000_000, 10);
    insert.run(PRE_KEY, "CR-CRU-078", "roadmap surface", "5", '["CR-CRU-091"]', "L", 1_700_000_000_001, 20);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
  } finally {
    db.close();
  }
  return dbPath;
}

const PRE_KEY = "pre-091-project";

// ── Store fixtures ─────────────────────────────────────────────────────────

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "roadmap", type: "backend", sutRoot: "/tmp" });
  return key;
}

function entryOf(entries: QueueEntry[], cr: string): QueueEntry {
  const found = entries.find((entry) => entry.cr === cr);
  if (found === undefined) {
    throw new Error(`CR-CRU-091: ${cr} is absent from the queue read (${entries.length} entries)`);
  }
  return found;
}

const A = "CR-CRU-A01";
const B = "CR-CRU-B02";
const C = "CR-CRU-C03";

/** The three declared entries AC5 re-posts undeclared. */
function threeDeclared(): QueueEntryInput[] {
  return [
    {
      cr: A,
      title: "first",
      wave: "5",
      dependsOn: [],
      release: "0.2.0",
      track: "2",
      seq: 10,
    },
    {
      cr: B,
      title: "second",
      wave: "5",
      dependsOn: [A],
      release: "0.2.0",
      track: "2",
      seq: 20,
    },
    {
      cr: C,
      title: "third",
      wave: "6",
      dependsOn: [],
      release: "0.3.0",
      track: "track-3",
      seq: 30,
      lifecycle: { state: "SUPERSEDED", by: "CR-CRU-088", at: 1_787_149_125_000 },
    },
  ];
}

/** The same three CRs, re-posted by `queue-file` with NO declaration at all. */
function threeUndeclared(): QueueEntryInput[] {
  return [
    { cr: A, title: "first", wave: "5", dependsOn: [] },
    { cr: B, title: "second", wave: "5", dependsOn: [A] },
    { cr: C, title: "third", wave: "6", dependsOn: [] },
  ];
}

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-091 §S2 — the migration adds the three declaration columns", () => {
  test("SCHEMA_VERSION is MIGRATIONS.length and has advanced by exactly one, to 8", () => {
    // A LITERAL on purpose: the value is the tripwire that forces a human to
    // notice a chain step. The MECHANISM (derived, never hand-edited) is
    // asserted beside it — the two do different jobs.
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(SCHEMA_VERSION).toBe(8);
    MIGRATIONS.forEach((step, index) => {
      expect(step.from).toBe(index);
      expect(step.to).toBe(index + 1);
    });
  });

  test(
    "a PRE-migration store gains release/track/lifecycle_json, loses no queue row, reports the " +
      "new SCHEMA_VERSION, and the appended step's satisfiedBy then returns true",
    () => {
      const dir = tmpDir();
      const dbPath = makePreDeclarationStore(dir);

      // Before: the three columns are absent and the store says so.
      expect(userVersion(dbPath)).toBe(SCHEMA_VERSION - 1);
      const before = columnsOf(dbPath, "queue_entries");
      expect(before).not.toContain("release");
      expect(before).not.toContain("track");
      expect(before).not.toContain("lifecycle_json");

      // The step is identified BY EFFECT: on this fixture it is the only one in
      // the whole chain that is not already satisfied.
      const probe = new Database(dbPath);
      const unsatisfied = MIGRATIONS.filter((step) => step.satisfiedBy?.(probe) === false);
      probe.close();
      expect(unsatisfied.length).toBe(1);
      expect(unsatisfied[0]!.to).toBe(SCHEMA_VERSION);

      const store = Store.open(dbPath);

      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
      expect(columnsOf(dbPath, "queue_entries")).toEqual(
        expect.arrayContaining(["release", "track", "lifecycle_json"]),
      );
      // Lossless: both rows survive with their stored seq and wave.
      expect(storedRows(dbPath).map((row) => [row.cr, row.seq, row.wave])).toEqual([
        ["CR-CRU-014", 10, "1"],
        ["CR-CRU-078", 20, "5"],
      ]);
      // Retrofitted rows declare nothing — NULL, never a fabricated default.
      expect(storedRows(dbPath).map((row) => row.release)).toEqual([null, null]);
      expect(storedRows(dbPath).map((row) => row.track)).toEqual([null, null]);
      expect(storedRows(dbPath).map((row) => row.lifecycle_json)).toEqual([null, null]);

      // The probe the baseline path relies on now answers for this store.
      const after = new Database(dbPath);
      const satisfied = unsatisfied[0]!.satisfiedBy?.(after);
      after.close();
      expect(satisfied).toBe(true);

      // A pre-upgrade recovery point was written before the first mutation.
      expect(store.migration).not.toBeNull();
      expect(store.migration?.to).toBe(SCHEMA_VERSION);
      expect(readdirSync(dir).filter((f) => /\.pre-upgrade-\d+$/.test(f)).length).toBe(1);
    },
  );

  test("a FRESH store never runs the retrofit yet already carries the three columns", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "fresh.db");

    const store = Store.open(dbPath);

    // Nothing migrated: the base CREATE TABLE wrote the current shape whole.
    expect(store.migration).toBeNull();
    expect(readdirSync(dir).filter((f) => /\.pre-upgrade-\d+$/.test(f))).toEqual([]);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(columnsOf(dbPath, "queue_entries")).toEqual(
      expect.arrayContaining(["release", "track", "lifecycle_json"]),
    );
  });
});

describe("CR-CRU-091 §S2 — `track` is stored in ONE format, `track-<n>`", () => {
  test("2, track-2 and Track 2 all normalise to the identical value `track-2`", () => {
    expect(normalizeTrack("2")).toBe("track-2");
    expect(normalizeTrack("track-2")).toBe("track-2");
    expect(normalizeTrack("Track 2")).toBe("track-2");
    // Multi-digit lanes are lanes too (a single-digit regex fails here).
    expect(normalizeTrack("Track 10")).toBe("track-10");
    expect(normalizeTrack("track-10")).toBe("track-10");
  });

  test("the three spellings produce ONE distinct stored track value across three writes", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    for (const [index, spelling] of ["2", "track-2", "Track 2"].entries()) {
      store.replaceQueue(key, [
        { cr: `CR-CRU-T${index}`, wave: "5", dependsOn: [], track: spelling },
      ]);
      // Each write is a full replace, so read it back before the next one.
      expect(entryOf(store.listQueue(key), `CR-CRU-T${index}`).track).toBe("track-2");
    }

    store.replaceQueue(key, [
      { cr: A, wave: "5", dependsOn: [], track: "2" },
      { cr: B, wave: "5", dependsOn: [], track: "track-2" },
      { cr: C, wave: "5", dependsOn: [], track: "Track 2" },
    ]);
    const tracks = new Set(store.listQueue(key).map((entry) => entry.track));
    expect([...tracks]).toEqual(["track-2"]);
  });

  test("a value carrying no integer is refused BY NAME and nothing is written", () => {
    // The pure normaliser answers "not a lane" without throwing, so the route
    // half (§S8) can 400 naming the field...
    expect(normalizeTrack("main")).toBeNull();
    expect(normalizeTrack("")).toBeNull();

    // ...and the WRITE refuses rather than storing the caller's spelling.
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, [{ cr: A, wave: "5", dependsOn: [] }]);

    let message = "";
    try {
      store.replaceQueue(key, [
        { cr: B, wave: "5", dependsOn: [], track: "main" },
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("track");
    expect(message).toContain("main");

    // Refusal is not a partial write: the prior queue is intact and untouched.
    expect(store.listQueue(key).map((entry) => entry.cr)).toEqual([A]);
  });
});

describe("CR-CRU-091 §S2 — the read publishes the declaration", () => {
  test("`seq` is published on EVERY entry, verbatim from the column, never the array index", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, threeDeclared());

    const entries = store.listQueue(key);

    // The fixture AC18 pins: stored 10, 20, 30 — the index derivation yields
    // 0, 1, 2 and fails here.
    expect(entries.map((entry) => entry.seq)).toEqual([10, 20, 30]);
    entries.forEach((entry, index) => {
      expect(entry.seq).not.toBe(index);
      expect(typeof entry.seq).toBe("number");
    });
  });

  test("`release`/`track` are OMITTED (not null) for an entry declaring neither", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, [
      { cr: A, title: "undeclared", wave: "5", dependsOn: [] },
      { cr: B, wave: "5", dependsOn: [], release: "0.2.0", track: "Track 2" },
    ]);

    const undeclaredEntry = entryOf(store.listQueue(key), A);
    expect("release" in undeclaredEntry).toBe(false);
    expect("track" in undeclaredEntry).toBe(false);
    expect("lifecycle" in undeclaredEntry).toBe(false);
    // ...and seq is NOT conditional: it is always published.
    expect("seq" in undeclaredEntry).toBe(true);

    const declaredEntry = entryOf(store.listQueue(key), B);
    expect(declaredEntry.release).toBe("0.2.0");
    expect(declaredEntry.track).toBe("track-2");
  });

  test("`lifecycle` is projected as the PARSED object, never the raw JSON string", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, [
      {
        cr: A,
        wave: "5",
        dependsOn: [],
        lifecycle: { state: "SUPERSEDED", by: "CR-CRU-088", at: 1_787_149_125_000 },
      },
      {
        cr: B,
        wave: "5",
        dependsOn: [],
        lifecycle: { state: "VOID", reason: "folded into CR-CRU-091", at: 1_787_149_126_000 },
      },
    ]);

    const entries = store.listQueue(key);
    expect(entryOf(entries, A).lifecycle).toEqual({
      state: "SUPERSEDED",
      by: "CR-CRU-088",
      at: 1_787_149_125_000,
    });
    expect(entryOf(entries, B).lifecycle).toEqual({
      state: "VOID",
      reason: "folded into CR-CRU-091",
      at: 1_787_149_126_000,
    });
    expect(typeof entryOf(entries, A).lifecycle).toBe("object");
  });
});

describe("CR-CRU-091 §S2 — `lifecycle` is a SECOND AXIS, never folded into `status`", () => {
  test("a SUPERSEDED entry whose plan is OPEN still derives IN_PROGRESS", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, [
      {
        cr: A,
        wave: "5",
        dependsOn: [],
        lifecycle: { state: "SUPERSEDED", by: "CR-CRU-088", at: 1_787_149_125_000 },
      },
      {
        cr: B,
        wave: "5",
        dependsOn: [],
        lifecycle: { state: "VOID", reason: "not happening", at: 1_787_149_125_000 },
      },
    ]);
    const filed = store.filePlan(key, { cr: A, cycles: [{ label: "C1", kind: "red-green" }] });
    expect("error" in filed).toBe(false);

    const superseded = entryOf(store.listQueue(key), A);
    // The work IS happening — that is true, and lifecycle does not override it.
    expect(superseded.status).toBe("IN_PROGRESS");
    expect(superseded.lifecycle?.state).toBe("SUPERSEDED");
    // The VOID entry has no plan, so its OWN axis still reads PENDING.
    const voided = entryOf(store.listQueue(key), B);
    expect(voided.status).toBe("PENDING");
    expect(voided.lifecycle?.state).toBe("VOID");
  });

  test("QueueStatus gains NO member — the four derived values are exactly PENDING/IN_PROGRESS/COMPLETED/COMPLETED_UNTRACKED", () => {
    // An exhaustive record: adding a member to QueueStatus makes this fail to
    // compile (missing key), and removing one fails at runtime below.
    const members: Record<QueueStatus, true> = {
      PENDING: true,
      IN_PROGRESS: true,
      COMPLETED: true,
      COMPLETED_UNTRACKED: true,
    };
    expect(Object.keys(members).sort()).toEqual([
      "COMPLETED",
      "COMPLETED_UNTRACKED",
      "IN_PROGRESS",
      "PENDING",
    ]);

    // @ts-expect-error — §S2: SUPERSEDED is a LIFECYCLE state. If this stops
    // being a type error, the two axes have been collapsed into one.
    const notAStatus: QueueStatus = "SUPERSEDED";
    expect(members[notAStatus]).toBeUndefined();
  });
});

describe("CR-CRU-091 §S2 — a full replace does not erase a declaration", () => {
  test("re-posting the same CR ids with NO declaration preserves release, track, seq and lifecycle", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, threeDeclared());
    const before = store.listQueue(key);

    // The `queue-file` bulk bootstrap: same ids, no declaration in sight.
    store.replaceQueue(key, threeUndeclared());

    const after = store.listQueue(key);
    expect(after.map((entry) => entry.cr)).toEqual([A, B, C]);
    for (const cr of [A, B, C]) {
      const kept = entryOf(after, cr);
      const original = entryOf(before, cr);
      expect({
        cr,
        release: kept.release,
        track: kept.track,
        seq: kept.seq,
        lifecycle: kept.lifecycle,
      }).toEqual({
        cr,
        release: original.release,
        track: original.track,
        seq: original.seq,
        lifecycle: original.lifecycle,
      });
    }
    // Sanity: the carried values are the DECLARED ones, not defaults.
    expect(entryOf(after, A).release).toBe("0.2.0");
    expect(entryOf(after, A).track).toBe("track-2");
    expect(entryOf(after, A).seq).toBe(10);
    expect(entryOf(after, C).lifecycle).toEqual({
      state: "SUPERSEDED",
      by: "CR-CRU-088",
      at: 1_787_149_125_000,
    });
  });

  test("a posted declaration OVERRIDES the snapshot, field by field", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, threeDeclared());

    store.replaceQueue(key, [
      // A re-declares everything...
      {
        cr: A,
        title: "first",
        wave: "6",
        dependsOn: [],
        release: "0.3.0",
        track: "Track 7",
        seq: 99,
        lifecycle: { state: "VOID", reason: "replanned", at: 1_787_149_200_000 },
      },
      // ...B declares one field only, and keeps the rest of its snapshot.
      { cr: B, title: "second", wave: "5", dependsOn: [A], release: "0.4.0" },
      { cr: C, title: "third", wave: "6", dependsOn: [] },
    ]);

    const after = store.listQueue(key);
    const overridden = entryOf(after, A);
    expect(overridden.release).toBe("0.3.0");
    expect(overridden.track).toBe("track-7");
    expect(overridden.seq).toBe(99);
    expect(overridden.lifecycle).toEqual({
      state: "VOID",
      reason: "replanned",
      at: 1_787_149_200_000,
    });
    // Posted non-declaration data is the POST's, as it always was.
    expect(overridden.wave).toBe("6");

    const partial = entryOf(after, B);
    expect(partial.release).toBe("0.4.0");
    expect(partial.track).toBe("track-2");
    expect(partial.seq).toBe(20);
  });

  test("a CR absent from the posted set is STILL dropped, and the survivors keep their declarations", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, threeDeclared());

    store.replaceQueue(key, threeUndeclared().filter((entry) => entry.cr !== C));

    const after = store.listQueue(key);
    expect(after.map((entry) => entry.cr)).toEqual([A, B]);
    expect(entryOf(after, A).release).toBe("0.2.0");
    expect(entryOf(after, B).seq).toBe(20);
  });

  test("a CR the store never held takes the posted order as its seq, exactly as before this CR", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    store.replaceQueue(key, threeUndeclared());

    // No snapshot, no declaration: the post's own order stands (today's rule).
    expect(store.listQueue(key).map((entry) => [entry.cr, entry.seq])).toEqual([
      [A, 0],
      [B, 1],
      [C, 2],
    ]);
  });
});

describe("CR-CRU-091 §S1 — a proposed release is its own record kind", () => {
  const AGENT = "orchestrator-1";

  test("`targetAt` is accepted for a release-proposal and round-trips as epoch SECONDS", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    const { event } = store.recordMilestoneEvent(key, AGENT, "release-proposal", {
      label: "0.2.0",
      targetAt: 1_787_149_125,
    });

    expect(event.type).toBe("release-proposal");
    expect(event.targetAt).toBe(1_787_149_125);
    // Same unit as releasedAt: seconds, so nothing renders 1970 (AC3's class).
    expect(event.targetAt! < 2_000_000_000).toBe(true);
    expect(store.getEvent(event.id)?.targetAt).toBe(1_787_149_125);
  });

  test("a proposal with ZERO CRs and NO target is legal — a declared intent, not an error", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    const { event, changed } = store.recordMilestoneEvent(key, AGENT, "release-proposal", {
      label: "0.4.0",
    });

    expect(changed).toBe(true);
    expect("targetAt" in event).toBe(false);
    expect("crs" in event).toBe(false);
    expect(listReleaseProposals(store, key).map((proposal) => proposal.label)).toEqual(["0.4.0"]);
  });

  test("`targetAt` is STRIPPED for every other milestone type", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    const release = store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.0",
      commit: "a".repeat(40),
      releasedAt: 1_787_149_125,
      targetAt: 1_787_000_000,
    }).event;
    expect("targetAt" in release).toBe(false);
    expect(release.releasedAt).toBe(1_787_149_125);
    expect("targetAt" in (store.getEvent(release.id) ?? {})).toBe(false);

    const other = store.recordMilestoneEvent(key, AGENT, "merge", {
      label: "feature",
      targetAt: 1_787_000_000,
    }).event;
    expect("targetAt" in other).toBe(false);
  });

  test("a proposal is invisible to `listReleases`, and proposals order among themselves by version", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.0",
      commit: "b".repeat(40),
      releasedAt: 1_787_000_000,
    });
    // Proposed NEWEST-version-first on purpose: version orders the strip, and
    // arrival order must not.
    store.recordMilestoneEvent(key, AGENT, "release-proposal", { label: "0.3.0" });
    store.recordMilestoneEvent(key, AGENT, "release-proposal", {
      label: "0.2.1",
      targetAt: 1_900_000_000,
    });
    store.recordMilestoneEvent(key, AGENT, "release-proposal", { label: "0.10.0" });

    expect(store.listReleases(key).map((release) => release.label)).toEqual(["0.1.0"]);
    expect(store.listReleases(key).some((r) => r.type === "release-proposal")).toBe(false);

    // Numeric-COMPONENT compare: 0.10.0 is after 0.3.0, not before it.
    expect(listReleaseProposals(store, key).map((p) => p.label)).toEqual([
      "0.2.1",
      "0.3.0",
      "0.10.0",
    ]);
  });

  test("a non-semver label orders DETERMINISTICALLY rather than throwing", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    // Four DISTINCT labels by design: AC21 allows a label at most ONE live
    // proposal, so a repeated label here would document a state the sanctioned
    // route forbids. Distinctness costs no coverage — the four hard ordering
    // cases are each still present: a bare word with no digits at all
    // (`nightly`), a `v`-prefix, a pre-release suffix, and a MULTI-DIGIT
    // component (`0.10.0`, which a lexical compare would wrongly put before
    // `0.3.0`).
    for (const label of ["nightly", "0.10.0", "v1.0.0-rc.1", "0.3.0"]) {
      store.recordMilestoneEvent(key, AGENT, "release-proposal", { label });
    }

    const first = listReleaseProposals(store, key).map((p) => p.label);
    const second = listReleaseProposals(store, key).map((p) => p.label);
    expect(first.length).toBe(4);
    // Deterministic AND correct: the componentless label sorts first, and
    // 0.10.0 sorts AFTER 0.3.0 on numeric components.
    expect(first).toEqual(["nightly", "0.3.0", "0.10.0", "v1.0.0-rc.1"]);
    // The read is idempotent — a second call orders identically.
    expect(second).toEqual(first);
  });

  test("a shipped release CONSUMES the proposal it fulfils, in the same call, and touches no other", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const target = store.recordMilestoneEvent(key, AGENT, "release-proposal", {
      label: "0.2.0",
      targetAt: 1_787_000_000,
    }).event;
    const survivor = store.recordMilestoneEvent(key, AGENT, "release-proposal", {
      label: "0.3.0",
    }).event;
    // §S1 — a PROPOSAL retires no gate: the 0.2.0 gate is still live.
    const gate = store.recordGateEvent(key, AGENT, { verdict: "pass" }, { version: "0.2.0" });
    expect(store.getEvent(gate.id)?.retiredAt).toBeUndefined();

    const release = store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.2.0",
      commit: "c".repeat(40),
      releasedAt: 1_787_149_125,
    }).event;

    // One call, both effects: the release is held AND its proposal is retired.
    expect(store.listReleases(key).map((r) => r.label)).toEqual(["0.2.0"]);
    expect(typeof store.getEvent(target.id)?.retiredAt).toBe("number");
    // Retired means "no longer live, still auditable": out of the live feed…
    const live = store.listEvents(key, 200).map((event) => event.id);
    expect(live).not.toContain(target.id);
    expect(live).toContain(release.id);
    // …and still retrievable by id.
    expect(store.getEvent(target.id)?.type).toBe("release-proposal");
    expect(store.getEvent(target.id)?.label).toBe("0.2.0");
    expect(store.getEvent(target.id)?.targetAt).toBe(1_787_000_000);

    // ONE 0.2.0 record renders, never a pair.
    expect(listReleaseProposals(store, key).map((p) => p.label)).toEqual(["0.3.0"]);
    // A proposal for any other label is untouched.
    expect(store.getEvent(survivor.id)?.retiredAt).toBeUndefined();
    // And CR-CRU-073's gate retirement still fires in that same call.
    expect(typeof store.getEvent(gate.id)?.retiredAt).toBe("number");
  });
});
