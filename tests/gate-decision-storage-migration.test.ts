// CR-CRU-162 §G4/§S1 C1 (server) RED — storage migration to schema v15: a
// gate decision is its own record, in a new `gate_decisions` table, never
// back-filled onto a pre-existing gate.
//
// RED phase: today SCHEMA_VERSION (src/store.ts) is 14 — MIGRATIONS has no
// step whose description names this CR, so a pre-this-CR board opens and
// stays at 14 with no `gate_decisions` table. Every assertion below that
// expects a 15th step, the new table, or a successful post-migration
// gate-decision round trip fails against production as it stands.
//
// Legacy fixture: built via `Store.open` (so it is byte-consistent with
// every OTHER table this build writes, with real seed data), then
// DOWNGRADED to the version just before this CR's step — `DROP TABLE
// gate_decisions` (a no-op today, since it does not exist yet) and
// `PRAGMA user_version` stamped to the step's OWN `.from`, found BY WHAT THE
// STEP DECLARES, never by index or by "SCHEMA_VERSION - 1" — the SAME
// technique tests/release-unification-migration.test.ts's unificationStep
// and tests/milestone-dates-migration.test.ts's datesStep use. That keeps
// this file correct after GREEN lands, and correct again the day a LATER CR
// appends a step after this one.
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
  readonly apply: (db: Database) => void;
}

interface OkResponse {
  ok: true;
  changed?: boolean;
  event?: string;
  [key: string]: unknown;
}

interface DecisionWire {
  id?: string;
  runId?: string;
  action?: string;
  [key: string]: unknown;
}

interface EventDetail {
  id: string;
  kind: string;
  runId?: string;
  decisions?: DecisionWire[];
  [key: string]: unknown;
}

interface EventDetailResponse {
  ok: true;
  event: EventDetail;
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-162: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/** The ONE step this CR owns, found by what it DECLARES — never by index. */
function gateDecisionStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => /CR-(CRU-)?162/.test(step.description ?? ""));
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-162: expected exactly ONE step in the ${String(chain.length)}-step migration chain ` +
        `to declare the gate_decisions storage (its description must name CR-162), found ` +
        `${String(owned.length)}. Without it, a recorded gate decision has nowhere durable to ` +
        `live, and "the run id ties them together" (G5) has no table to join against.`,
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

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)?.n ?? 0
  ) > 0;
}

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

/**
 * A byte-consistent "pre-CR-162" board: built by opening a REAL Store (every
 * table this build writes, in its current shape, with real seed data — one
 * project, one registered agent, one gate event carrying a no-mistakes
 * run id), then downgraded to the version just before this CR's own step —
 * never a hand-maintained literal DDL copy of the whole schema.
 */
function makeLegacyStore(dir: string): { dbPath: string; legacyGateEventId: string; legacyRunId: string } {
  const dbPath = join(dir, "pre-gate-decisions.db");
  const key = crypto.randomUUID();
  const legacyRunId = "legacy-run-pre-162";
  let legacyGateEventId: string;
  {
    const store = Store.open(dbPath);
    store.addProject({ key, name: "legacy-gate-decisions", type: "backend", sutRoot: "/tmp/p" });
    const event = store.recordGateEvent(key, "legacy-agent", {
      intent: "ship 0.2.0",
      outcome: "passed",
      steps: [],
      run: { id: legacyRunId },
    });
    legacyGateEventId = event.id;
    dbOf(store).close();
  }
  const step = gateDecisionStep();
  const raw = new Database(dbPath);
  try {
    raw.exec(`PRAGMA journal_mode = DELETE;`);
    raw.exec(`DROP TABLE IF EXISTS gate_decisions`);
    raw.exec(`PRAGMA user_version = ${String(step.from)};`);
  } finally {
    raw.close();
  }
  return { dbPath, legacyGateEventId, legacyRunId };
}

describe("CR-CRU-162 storage migration — schema v15 carries gate_decisions, the decision's own record", () => {
  const scratchDirs: string[] = [];
  const handles: ServerHandle[] = [];
  const openDbs: Database[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "cru162-migration-"));
    scratchDirs.push(dir);
    return dir;
  }

  test("exactly ONE migration step declares CR-162's gate_decisions storage, at its OWN rung (v15), following its predecessor in the chain", () => {
    const step = gateDecisionStep();
    // The step's OWN position — stable even once a later CR appends more
    // steps after it (the release-unification-migration.test.ts precedent:
    // "later steps may follow it, so the pin is its own rung, not the end").
    expect(step.to).toBe(15);
    expect(step.to).toBe(step.from + 1);
    expect(migrationChain()[step.from]).toBe(step);
    // The chain's end is NEVER a hand-edited literal — only ever derived.
    expect(SCHEMA_VERSION).toBe(migrationChain().length);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(step.to);
  });

  test("opening a pre-CR-162 (user_version = step.from) board stamps it forward and CREATES gate_decisions — the pre-existing gate event is byte-identical afterwards", () => {
    const dir = scratch();
    const { dbPath, legacyGateEventId } = makeLegacyStore(dir);

    const legacyDb = new Database(dbPath);
    const gateRowBefore = legacyDb
      .query<{ id: string; agent_id: string; payload: string | null }, [string]>(
        `SELECT id, agent_id, payload FROM gates WHERE id = ?`,
      )
      .get(legacyGateEventId);
    legacyDb.close();
    expect(gateRowBefore).toBeDefined();
    expect(tableExists(new Database(dbPath), "gate_decisions")).toBe(false);

    const store = Store.open(dbPath);
    openDbs.push(dbOf(store));
    const raw = dbOf(store);

    expect(tableExists(raw, "gate_decisions")).toBe(true);
    const cols = columnsOf(raw, "gate_decisions");
    // New storage, discovered by NAME rather than hardcoding a column count:
    // the three identity/tie fields every record of this kind needs.
    expect(cols).toContain("run_id");
    expect(cols).toContain("action");
    expect(cols).toContain("project_key");

    const gateRowAfter = raw
      .query<{ id: string; agent_id: string; payload: string | null }, [string]>(
        `SELECT id, agent_id, payload FROM gates WHERE id = ?`,
      )
      .get(legacyGateEventId);
    expect(gateRowAfter).toEqual(gateRowBefore);

    const version = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    expect(version).toBe(SCHEMA_VERSION);
  });

  test("a freshly created store and a migrated-from-legacy store hold IDENTICAL gate_decisions column sets — the base DDL and the migration step add the same table in the same shape", () => {
    const freshPath = join(scratch(), "fresh.db");
    const fresh = Store.open(freshPath);
    openDbs.push(dbOf(fresh));
    const freshCols = columnsOf(dbOf(fresh), "gate_decisions").sort();
    expect(freshCols.length).toBeGreaterThan(0);

    const { dbPath } = makeLegacyStore(scratch());
    const migrated = Store.open(dbPath);
    openDbs.push(dbOf(migrated));
    const migratedCols = columnsOf(dbOf(migrated), "gate_decisions").sort();

    expect(migratedCols).toEqual(freshCols);
  });

  test("§S2/G4 — the historical gate predating this CR is NEVER back-filled: migration creates the table, but invents NO decision row for it", () => {
    const dir = scratch();
    const { dbPath, legacyGateEventId } = makeLegacyStore(dir);
    const store = Store.open(dbPath);
    openDbs.push(dbOf(store));
    const raw = dbOf(store);

    const decisionCount = raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM gate_decisions`).get()!.n;
    expect(decisionCount).toBe(0);

    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);
    const res = fetchJson(handle, `/api/v2/events/${legacyGateEventId}`);
    return res.then((body) => {
      expect(body.ok).toBe(true);
      const event = body.event;
      expect("decisions" in event).toBe(false);
    });
  });

  test("a migrated board accepts a NEW gate-decision through the real HTTP routes, and the legacy pre-migration gate's own read stays untouched (never fabricated history for an old run)", async () => {
    const dir = scratch();
    const { dbPath, legacyGateEventId } = makeLegacyStore(dir);
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);

    const key = crypto.randomUUID();
    // The legacy fixture's own project key is unknown to this scope — file a
    // FRESH project+agent against the now-migrated board instead, proving
    // the migrated store's new route works going forward.
    const createRes = await postJson(handle, "/api/v2/projects", { name: "post-migration-gate-decisions" });
    const created = (await createRes.json()) as OkResponse & { project: { key: string } };
    const freshKey = created.project.key;
    await postJson(handle, "/api/v2/agents/register", {
      projectKey: freshKey,
      agentId: "post-migration-orch",
      role: "ORCHESTRATOR",
    });
    const gateRes = await postJson(handle, "/api/v2/gates", {
      projectKey: freshKey,
      agentId: "post-migration-orch",
      gate: { intent: "verify", outcome: "passed", steps: [], run: { id: "run-162-post-migration" } },
    });
    expect(gateRes.status).toBe(201);
    const gateBody = (await gateRes.json()) as OkResponse;
    const freshGateEventId = gateBody.event as string;

    const decisionRes = await postJson(handle, "/api/v2/gate-decisions", {
      projectKey: freshKey,
      agentId: "post-migration-orch",
      decision: { runId: "run-162-post-migration", action: "approve" },
    });
    expect(decisionRes.status).toBe(201);

    const freshEvent = await fetchJson(handle, `/api/v2/events/${freshGateEventId}`);
    const freshDetail = freshEvent.event;
    expect(freshDetail.decisions).toHaveLength(1);
    expect(freshDetail.decisions![0]!.action).toBe("approve");

    // The legacy, pre-migration gate (a DIFFERENT run id) still reads with
    // NO decisions — the new route never retroactively attaches anything.
    const legacyEvent = await fetchJson(handle, `/api/v2/events/${legacyGateEventId}`);
    const legacyDetail = legacyEvent.event;
    expect("decisions" in legacyDetail).toBe(false);
    void key;
  });
});

async function postJson(handle: ServerHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchJson(handle: ServerHandle, path: string): Promise<EventDetailResponse> {
  const res = await fetch(`http://localhost:${handle.server.port}${path}`);
  return (await res.json()) as EventDetailResponse;
}
