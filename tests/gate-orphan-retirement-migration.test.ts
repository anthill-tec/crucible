// A declared store migration (the CR-CRU-071 chain mechanism) retires every
// gate snapshot that is marked in-flight, carries no release `version`, and
// has a LATER gate in the SAME project — a snapshot a later gate has
// superseded is not a run still in progress, even though nothing ever
// stamped `retired_at` on it (no client sends a release on an interim
// snapshot, so the normal delivery-time retirement never touches it).
//
// RED: this step does not exist yet. Today's build's chain ends at the
// version measured below (`bun -e "import('./src/store.ts').then(m =>
// console.log(m.SCHEMA_VERSION))"` read 19 on this branch); opening the
// fixture below only re-stamps it at the SAME version — no step ever
// touches `gates.retired_at` for a row that carries no `version` — so every
// "is retired now" assertion fails for that reason: the column it reads
// never moves off NULL.
//
// Fixture shape follows tests/store-migration.test.ts's own precedent
// (`makePreReleaseStore`): open a REAL Store to get the current production
// schema (this migration adds no column, so no walk-back is needed), insert
// rows with a second raw connection, and stamp `user_version` at the
// version this build writes today. The shape mirrors the real board's past
// (ten interim snapshots ~8 minutes apart, a seal shortly after the last
// one) without reusing any of its ids.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { handleV2 } from "../src/v2.ts";
import type { V2Deps } from "../src/v2.ts";

const PRE_RETIREMENT_VERSION = 19;
const PRE_UPGRADE_RE = /\.pre-upgrade-\d+$/;
const BASE = 1_700_000_000_000;
const STEP_MS = 8 * 60 * 1000; // ~8 minutes — the real board's interim cadence

const scratchDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-gate-retire-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

function schemaVersion(): number {
  const mod: object = storeModule;
  if (!("SCHEMA_VERSION" in mod) || typeof mod.SCHEMA_VERSION !== "number") {
    throw new Error("src/store.ts exports no numeric SCHEMA_VERSION");
  }
  return mod.SCHEMA_VERSION;
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

function siblings(dir: string, pattern: RegExp): string[] {
  return fs.readdirSync(dir).filter((f) => pattern.test(f));
}

interface GateFixtureRow {
  id: string;
  projectKey: string;
  timestamp: number;
  version: string | null;
  inFlight: boolean;
  retiredAt: number | null;
}

interface StoredGateRow {
  id: string;
  projectKey: string;
  version: string | null;
  retiredAt: number | null;
  payload: string | null;
}

function insertGate(db: Database, row: GateFixtureRow): void {
  const gate: Record<string, unknown> = {
    intent: `release ${row.version ?? "unspecified"} no-mistakes gate`,
    outcome: row.inFlight ? "checks-passed" : "passed",
    steps: [{ name: "intent", status: "passed" }],
  };
  if (row.inFlight) gate.inFlight = true;
  const payloadObj: Record<string, unknown> = { gate };
  if (row.version !== null) payloadObj.version = row.version;
  const payload = JSON.stringify(payloadObj);
  db.query(
    `INSERT INTO gates (id, project_key, agent_id, tier, codec, timestamp, version,
       payload, context, role, role_inferred, retired_at, cycle_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.projectKey,
    "orchestrator-1",
    "unit",
    "no-mistakes",
    row.timestamp,
    row.version,
    payload,
    null,
    null,
    null,
    row.retiredAt,
    null,
  );
}

// ── the fixture's own catalogue — read by every test below ──────────────

const BOARD_PROJECT = "p-gate-retire-board";
const LIVE_PROJECT = "p-gate-retire-live";
const VERSIONED_PROJECT = "p-gate-retire-versioned";
const PLAIN_PROJECT = "p-gate-retire-plain";

const BOARD_INTERIM_IDS = Array.from({ length: 10 }, (_, i) => `g-board-interim-${i}`);
const BOARD_SEAL_ID = "g-board-seal";
const BOARD_SEAL_RETIRED_AT = BASE + 10 * STEP_MS;
const LIVE_ID = "g-live-interim-0";
const VERSIONED_INTERIM_ID = "g-versioned-interim-0";
const VERSIONED_LATER_ID = "g-versioned-later";
const PLAIN_SEALED_ID = "g-plain-sealed";
const PLAIN_SEALED_RETIRED_AT = BASE;

function fixtureRows(): GateFixtureRow[] {
  const rows: GateFixtureRow[] = BOARD_INTERIM_IDS.map((id, i) => ({
    id,
    projectKey: BOARD_PROJECT,
    timestamp: BASE + i * STEP_MS,
    version: null,
    inFlight: true,
    retiredAt: null,
  }));
  rows.push({
    id: BOARD_SEAL_ID,
    projectKey: BOARD_PROJECT,
    timestamp: BOARD_SEAL_RETIRED_AT,
    version: "1.4.0",
    inFlight: false,
    // Already retired at delivery — the real board's `stampGatesRetired`
    // retires the seal too (it carries the version that matched).
    retiredAt: BOARD_SEAL_RETIRED_AT,
  });
  // A single version-less in-flight snapshot with NO later gate in ITS OWN
  // project — a run genuinely still going. Its timestamp sits inside the
  // board project's own span, so a predicate that checked "a later gate
  // exists ANYWHERE" rather than scoping by project would wrongly retire it.
  rows.push({
    id: LIVE_ID,
    projectKey: LIVE_PROJECT,
    timestamp: BASE + 1 * STEP_MS,
    version: null,
    inFlight: true,
    retiredAt: null,
  });
  // §S0's fixed world: an in-flight snapshot that DOES carry a version,
  // followed by a later gate in the SAME project. Must stay untouched —
  // only VERSION-LESS orphans are retired.
  rows.push({
    id: VERSIONED_INTERIM_ID,
    projectKey: VERSIONED_PROJECT,
    timestamp: BASE,
    version: "2.1.0",
    inFlight: true,
    retiredAt: null,
  });
  rows.push({
    id: VERSIONED_LATER_ID,
    projectKey: VERSIONED_PROJECT,
    timestamp: BASE + STEP_MS,
    version: "2.1.0",
    inFlight: false,
    retiredAt: null,
  });
  // An ordinary, already-sealed, already-retired gate in its own project —
  // proves the migration touches nothing outside its predicate.
  rows.push({
    id: PLAIN_SEALED_ID,
    projectKey: PLAIN_PROJECT,
    timestamp: BASE,
    version: "3.0.0",
    inFlight: false,
    retiredAt: PLAIN_SEALED_RETIRED_AT,
  });
  return rows;
}

/**
 * A store shaped like the one this CR's §S5 repairs: built from THIS
 * build's own current schema (`Store.open`, so the `gates` table already has
 * every column this migration needs — it adds none), with raw rows inserted
 * through a second connection and `user_version` stamped at the version this
 * build writes today, mirroring `tests/store-migration.test.ts`'s own
 * `makePreReleaseStore` precedent.
 */
function makeOrphanGateStore(dir: string): string {
  const dbPath = path.join(dir, "crucible.db");
  Store.open(dbPath);
  const db = new Database(dbPath);
  try {
    const insertProject = db.query(
      `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProject.run(BOARD_PROJECT, "Board", "backend", "/tmp/p-gate-retire-board", 1000);
    insertProject.run(LIVE_PROJECT, "Live", "backend", "/tmp/p-gate-retire-live", 1000);
    insertProject.run(VERSIONED_PROJECT, "Versioned", "backend", "/tmp/p-gate-retire-versioned", 1000);
    insertProject.run(PLAIN_PROJECT, "Plain", "backend", "/tmp/p-gate-retire-plain", 1000);
    for (const row of fixtureRows()) insertGate(db, row);
    db.exec(`PRAGMA user_version = ${PRE_RETIREMENT_VERSION}`);
  } finally {
    db.close();
  }
  return dbPath;
}

function storedGates(dbPath: string): Map<string, StoredGateRow> {
  const db = new Database(dbPath);
  try {
    const all = db
      .query<
        { id: string; project_key: string; version: string | null; retired_at: number | null; payload: string | null },
        []
      >(`SELECT id, project_key, version, retired_at, payload FROM gates`)
      .all();
    return new Map(
      all.map((r) => [
        r.id,
        { id: r.id, projectKey: r.project_key, version: r.version, retiredAt: r.retired_at, payload: r.payload },
      ]),
    );
  } finally {
    db.close();
  }
}

function countGates(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM gates`).get()?.n ?? -1;
  } finally {
    db.close();
  }
}

describe("a schema migration retires version-less in-flight gate snapshots a later gate has superseded", () => {
  test("ten version-less in-flight snapshots on one project, followed by a LATER retired seal, are all retired after the migration — the seal itself is untouched", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    // Precondition — every interim starts live, so the test can never pass
    // by testing nothing.
    const before = storedGates(dbPath);
    for (const id of BOARD_INTERIM_IDS) {
      expect(before.get(id)?.retiredAt, `${id} already retired before the migration ran`).toBeNull();
      expect(before.get(id)?.version).toBeNull();
    }
    expect(before.get(BOARD_SEAL_ID)?.retiredAt).toBe(BOARD_SEAL_RETIRED_AT);

    Store.open(dbPath);

    expect(userVersion(dbPath)).toBe(schemaVersion());
    expect(userVersion(dbPath)).toBeGreaterThan(PRE_RETIREMENT_VERSION);

    const after = storedGates(dbPath);
    for (const id of BOARD_INTERIM_IDS) {
      const row = after.get(id);
      expect(row, `${id} vanished`).toBeDefined();
      // THE PIN — retired now, by a later gate in its own project.
      expect(row!.retiredAt, `${id} was not retired`).not.toBeNull();
      // The column moves; nothing else about the row does.
      expect(row!.version).toBeNull();
      expect(row!.payload).toBe(before.get(id)!.payload);
    }
    // The seal was already retired, at delivery time — the migration must
    // not touch (or re-stamp) a row that already carried a retirement.
    const sealAfter = after.get(BOARD_SEAL_ID);
    expect(sealAfter).toEqual(before.get(BOARD_SEAL_ID));
  });

  test("a version-less in-flight snapshot with NO later gate in its own project stays live, even though another project's rows are later", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    expect(storedGates(dbPath).get(LIVE_ID)?.retiredAt).toBeNull();

    Store.open(dbPath);

    const row = storedGates(dbPath).get(LIVE_ID);
    expect(row, `${LIVE_ID} vanished`).toBeDefined();
    // THE PIN — still live: no later gate in ITS OWN project superseded it,
    // which a project-unscoped "any later row" predicate would have missed
    // (the board project's later rows sort after this one globally).
    expect(row!.retiredAt).toBeNull();
    expect(row!.version).toBeNull();
  });

  test("a VERSIONED in-flight snapshot stays untouched even with a later gate in the same project", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    expect(storedGates(dbPath).get(VERSIONED_INTERIM_ID)?.retiredAt).toBeNull();

    Store.open(dbPath);

    const row = storedGates(dbPath).get(VERSIONED_INTERIM_ID);
    expect(row, `${VERSIONED_INTERIM_ID} vanished`).toBeDefined();
    // THE PIN — only VERSION-LESS orphans are retired; a §S0-fixed snapshot
    // that already names its release is left exactly as it was, no matter
    // what lands after it.
    expect(row!.retiredAt).toBeNull();
    expect(row!.version).toBe("2.1.0");
    // The later gate in the same project is itself untouched too (it was
    // never in flight, so it was never a candidate in the first place).
    const later = storedGates(dbPath).get(VERSIONED_LATER_ID);
    expect(later!.retiredAt).toBeNull();
  });

  test("nothing is deleted or created: the gate row count is unchanged, and a row outside the predicate is byte-identical", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    const countBefore = countGates(dbPath);
    expect(countBefore).toBe(fixtureRows().length);
    const plainBefore = storedGates(dbPath).get(PLAIN_SEALED_ID);
    expect(plainBefore?.retiredAt).toBe(PLAIN_SEALED_RETIRED_AT);

    Store.open(dbPath);

    expect(countGates(dbPath)).toBe(countBefore);
    const plainAfter = storedGates(dbPath).get(PLAIN_SEALED_ID);
    expect(plainAfter).toEqual(plainBefore);
  });

  test("a second open changes nothing — idempotent", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    Store.open(dbPath);
    const afterFirst = storedGates(dbPath);
    const versionAfterFirst = userVersion(dbPath);

    Store.open(dbPath);
    const afterSecond = storedGates(dbPath);

    expect(userVersion(dbPath)).toBe(versionAfterFirst);
    expect(afterSecond).toEqual(afterFirst);
  });

  test("a pre-upgrade backup is written before the retirement runs", () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);

    expect(siblings(dir, PRE_UPGRADE_RE)).toEqual([]);

    Store.open(dbPath);

    expect(siblings(dir, PRE_UPGRADE_RE).length).toBeGreaterThan(0);
  });
});

describe("after the migration, the project's events read no longer answers the retired snapshots", () => {
  const deps: V2Deps = { version: "test-rehearsal", healthPayload: () => ({}) };

  async function eventIdsFor(dbPath: string, projectKey: string): Promise<string[]> {
    const store = Store.open(dbPath);
    const req = new Request(`http://localhost/api/v2/events?project=${projectKey}&limit=50`);
    const res = await handleV2(store, req, new URL(req.url), deps);
    if (res === null) throw new Error(`no v2 route matched the events read for ${projectKey}`);
    const body = (await res.json()) as { ok: boolean; events: Array<{ id: string }> };
    if (body.ok !== true) throw new Error(`events read for ${projectKey} answered not-ok`);
    return body.events.map((e) => e.id);
  }

  test("the board project's events read carries none of the ten retired interim ids, nor the already-retired seal", async () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);
    Store.open(dbPath); // runs the migration once, in-process

    const ids = await eventIdsFor(dbPath, BOARD_PROJECT);

    for (const id of BOARD_INTERIM_IDS) {
      expect(ids, `${id} still answers the board project's events read`).not.toContain(id);
    }
    expect(ids).not.toContain(BOARD_SEAL_ID);
  });

  test("the live project's un-superseded snapshot and the versioned project's un-retired gates still answer their events reads", async () => {
    const dir = tmpDir();
    const dbPath = makeOrphanGateStore(dir);
    Store.open(dbPath);

    const liveIds = await eventIdsFor(dbPath, LIVE_PROJECT);
    expect(liveIds).toContain(LIVE_ID);

    const versionedIds = await eventIdsFor(dbPath, VERSIONED_PROJECT);
    expect(versionedIds).toContain(VERSIONED_INTERIM_ID);
    expect(versionedIds).toContain(VERSIONED_LATER_ID);
  });
});
