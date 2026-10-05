// CR-CRU-165 §G6/§S2/§S2b — storage migration to schema v14: the three
// recorded-reason columns (cycle-skip's reason/cause/spec-ref, carried onto
// `plan_cycles`; abort's own reason/cause/spec-ref, carried onto `plans`).
//
// RED phase: today SCHEMA_VERSION (src/store.ts) is 13 — MIGRATIONS has 13
// entries, none of whose descriptions mention CR-165. A pre-this-CR board
// (`plan_cycles`/`plans` built from TODAY's literal CREATE TABLE DDL, read
// directly off src/store.ts's createBaseTables()) therefore carries NEITHER
// table's new columns, and opening it with the current code leaves it at
// version 13 with the pre-CR-165 shape — every assertion below that expects
// a 14th step, new columns, or a successful post-migration skip/abort
// round-trip fails against production as it stands.
//
// Legacy fixture: hand-written DDL (never a downgrade of a future build) —
// the SAME technique tests/store-migration.test.ts's makePreCycleIdStore and
// tests/milestone-record-migration.test.ts use, because a fixture built by
// opening a POST-GREEN Store would stop testing the migration the moment the
// migration existed.
//
// New column NAMES are intentionally never pinned here (unlike
// tests/milestone-dates-migration.test.ts's TARGET_COLUMN/DELIVERED_COLUMN):
// this suite discovers what the step adds by diffing `PRAGMA table_info`
// before/after, and proves the storage works by round-tripping reason/cause/
// specRef through the real HTTP skip/abort routes — never through hand-typed
// column SQL. That keeps this file correct no matter which column names
// GREEN picks.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

interface ChainStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
}

interface PlanCyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  reason?: string;
  cause?: string;
  specRef?: string;
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  cycles: PlanCyclePayload[];
  reason?: string;
  cause?: string;
  specRef?: string;
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-165: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/** The ONE step this CR owns, found by what it DECLARES — never by index. */
function recordedReasonStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => /CR-(CRU-)?165/.test(step.description ?? ""));
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-165: expected exactly ONE step in the ${String(chain.length)}-step migration chain ` +
        `to declare the skip/abort reason-cause-spec-ref storage (its description must name ` +
        `CR-165), found ${String(owned.length)}. Without it, a cycle-skip or abort on an ` +
        `upgraded board has nowhere to write the three fields the AXI contract requires.`,
    );
  }
  return owned[0]!;
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

/**
 * A pre-CR-165 file, built from TODAY's literal `CREATE TABLE` DDL
 * (src/store.ts createBaseTables(), read verbatim 2026-10, before this CR's
 * migration exists) — NEVER a downgrade of a future build. Holds:
 *   - plan 9001 (open, cr CR-LEGACY-OPEN) with cycle 1 PENDING (untouched —
 *     the live fixture for the post-migration skip round-trip);
 *   - plan 9002 (ABORTED, cr CR-LEGACY-ABORTED) with cycle 2 already
 *     SKIPPED (one of the CR's own "23 historical skips, no reason") —
 *     stamped user_version 13 (SCHEMA_VERSION today), so a correct GREEN
 *     upgrades it from exactly where a real pre-CR-165 board sits.
 */
function makeLegacyStore(dir: string): string {
  const dbPath = join(dir, "legacy.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(`PRAGMA journal_mode = DELETE;`);
    db.exec(`
      CREATE TABLE plans (
        plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        cr TEXT NOT NULL,
        title TEXT,
        orchestrator TEXT,
        wave TEXT,
        track TEXT,
        status TEXT NOT NULL,
        merge_commit TEXT,
        closed_at INTEGER
      );
      CREATE TABLE plan_cycles (
        project_key TEXT NOT NULL,
        cycle_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        activated_at INTEGER,
        done_at INTEGER,
        active_ms_accumulated INTEGER,
        seq REAL,
        PRIMARY KEY (project_key, cycle_id)
      );
      CREATE TABLE projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sut_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        liveness TEXT,
        retention INTEGER,
        archived_at INTEGER,
        allow_run_deletion INTEGER
      );
    `);
    const key = "11111111-1111-1111-1111-111111111111";
    db.query(
      `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, 'legacy-cru165', 'backend', '/tmp', 1700000000000)`,
    ).run(key);
    db.query(
      `INSERT INTO plans (plan_id, project_key, cr, status) VALUES (9001, ?, 'CR-LEGACY-OPEN', 'open')`,
    ).run(key);
    db.query(
      `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status, seq)
       VALUES (?, 1, 9001, 'legacy pending', 'fix', 'pending', 1)`,
    ).run(key);
    db.query(
      `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status, seq)
       VALUES (?, 3, 9001, 'legacy pending 2', 'fix', 'pending', 2)`,
    ).run(key);
    db.query(
      `INSERT INTO plans (plan_id, project_key, cr, status) VALUES (9002, ?, 'CR-LEGACY-ABORTED', 'aborted')`,
    ).run(key);
    db.query(
      `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status, seq, done_at)
       VALUES (?, 2, 9002, 'legacy skipped (no reason)', 'red-green', 'skipped', 1, 1700000000000)`,
    ).run(key);
    db.exec(`PRAGMA user_version = 13;`);
  } finally {
    db.close();
  }
  return dbPath;
}

describe("CR-CRU-165 storage migration — schema v14 carries reason/cause/spec-ref", () => {
  const scratchDirs: string[] = [];
  const handles: ServerHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "cru165-migration-"));
    scratchDirs.push(dir);
    return dir;
  }

  test("exactly ONE migration step declares CR-165's storage, and SCHEMA_VERSION/MIGRATIONS agree the chain now ends at 14", () => {
    const step = recordedReasonStep();
    expect(step.to).toBe(step.from + 1);
    expect(migrationChain()[step.from]).toBe(step);
    expect(SCHEMA_VERSION).toBe(14);
    expect(SCHEMA_VERSION).toBe(migrationChain().length);
  });

  test("opening a pre-CR-165 (user_version 13) board stamps it to 14 and ADDS columns to both plan_cycles and plans — the pre-existing rows' original fields are byte-identical afterwards", () => {
    const dir = scratch();
    const dbPath = makeLegacyStore(dir);

    const legacyDb = new Database(dbPath);
    const cyclesBefore = columnsOf(legacyDb, "plan_cycles");
    const plansBefore = columnsOf(legacyDb, "plans");
    const pendingRowBefore = legacyDb
      .query<{ label: string; kind: string; status: string }, []>(
        `SELECT label, kind, status FROM plan_cycles WHERE cycle_id = 1`,
      )
      .get();
    const abortedPlanBefore = legacyDb
      .query<{ cr: string; status: string }, []>(`SELECT cr, status FROM plans WHERE plan_id = 9002`)
      .get();
    legacyDb.close();

    const store = Store.open(dbPath);
    const raw = (store as unknown as { db: Database }).db;
    const cyclesAfter = columnsOf(raw, "plan_cycles");
    const plansAfter = columnsOf(raw, "plans");

    // New storage landed on BOTH tables — cycle-skip's three fields on
    // plan_cycles, abort's three fields on plans — without pinning names.
    expect(cyclesAfter.length).toBeGreaterThan(cyclesBefore.length);
    expect(plansAfter.length).toBeGreaterThan(plansBefore.length);
    for (const col of cyclesBefore) expect(cyclesAfter).toContain(col);
    for (const col of plansBefore) expect(plansAfter).toContain(col);

    const pendingRowAfter = raw
      .query<{ label: string; kind: string; status: string }, []>(
        `SELECT label, kind, status FROM plan_cycles WHERE cycle_id = 1`,
      )
      .get();
    expect(pendingRowAfter).toEqual(pendingRowBefore);
    const abortedPlanAfter = raw
      .query<{ cr: string; status: string }, []>(`SELECT cr, status FROM plans WHERE plan_id = 9002`)
      .get();
    expect(abortedPlanAfter).toEqual(abortedPlanBefore);

    const version = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    expect(version).toBe(14);
    raw.close();
  });

  test("a freshly created v14 store and a v13 store migrated to v14 hold IDENTICAL column sets on plan_cycles and plans: the base DDL and the migration step add the same columns, with the same type, nullability and key role", () => {
    // Shape of each column, order-free: the step ALTERs columns onto the end
    // of the table, while the base DDL declares them inline.
    function shapeOf(db: Database, table: string): string[] {
      return db
        .query<{ name: string; type: string; notnull: number; pk: number }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => `${c.name}:${c.type}:${String(c.notnull)}:${String(c.pk)}`)
        .sort();
    }

    const migrated = Store.open(makeLegacyStore(scratch()));
    const migratedDb = (migrated as unknown as { db: Database }).db;
    const fresh = Store.open(join(scratch(), "fresh.db"));
    const freshDb = (fresh as unknown as { db: Database }).db;
    try {
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(fresh.schemaVersion).toBe(SCHEMA_VERSION);
      for (const table of ["plan_cycles", "plans"]) {
        const freshShape = shapeOf(freshDb, table);
        expect(freshShape.length).toBeGreaterThan(0);
        expect(shapeOf(migratedDb, table)).toEqual(freshShape);
      }
    } finally {
      migratedDb.close();
      freshDb.close();
    }
  });

  test("§S3 — the historical skip/abort predating this CR is NEVER back-filled: after migration, its cycle and its plan carry NO reason/cause/specRef", async () => {
    const dir = scratch();
    const dbPath = makeLegacyStore(dir);
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);

    const res = await fetch(
      `http://localhost:${handle.server.port}/api/v2/projects/11111111-1111-1111-1111-111111111111/plans`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    const legacySkipped = body.plans.find((p) => p.cr === "CR-LEGACY-ABORTED");
    expect(legacySkipped).toBeDefined();
    expect(legacySkipped!.reason).toBeUndefined();
    expect(legacySkipped!.cause).toBeUndefined();
    expect(legacySkipped!.specRef).toBeUndefined();
    const legacyCycle = legacySkipped!.cycles.find((c) => c.id === 2);
    expect(legacyCycle).toBeDefined();
    expect(legacyCycle!.status).toBe("skipped");
    expect(legacyCycle!.reason).toBeUndefined();
    expect(legacyCycle!.cause).toBeUndefined();
    expect(legacyCycle!.specRef).toBeUndefined();
  });

  test("after migration, the pre-existing PENDING cycle is immediately skippable with reason/cause/specRef via the real PATCH route, and they round-trip on GET", async () => {
    const dir = scratch();
    const dbPath = makeLegacyStore(dir);
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);
    const key = "11111111-1111-1111-1111-111111111111";

    const registerRes = await fetch(`http://localhost:${handle.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId: "migrated-orch", role: "ORCHESTRATOR" }),
    });
    expect(registerRes.status).toBe(200);

    const skipRes = await fetch(
      `http://localhost:${handle.server.port}/api/v2/projects/${key}/plans/9001/cycles/1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "skipped",
          reason: "the legacy spec no longer applies",
          cause: "spec-design",
          specRef: "the spec's gap analysis, §G1",
          agentId: "migrated-orch",
        }),
      },
    );
    expect(skipRes.status).toBe(200);

    const res = await fetch(`http://localhost:${handle.server.port}/api/v2/projects/${key}/plans`);
    const body = (await res.json()) as PlansListResponse;
    const plan = body.plans.find((p) => p.cr === "CR-LEGACY-OPEN");
    const cycle = plan!.cycles.find((c) => c.id === 1);
    expect(cycle!.status).toBe("skipped");
    expect(cycle!.reason).toBe("the legacy spec no longer applies");
    expect(cycle!.cause).toBe("spec-design");
    expect(cycle!.specRef).toBe("the spec's gap analysis, §G1");
  });
});
