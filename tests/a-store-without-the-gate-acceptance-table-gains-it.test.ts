// An aged store at the CURRENT schema version that predates the
// `plan_gate_acceptances` table (it is a base-pass table: no chain step, no
// schema version) opens, gains the table, and changes nothing else — no other
// table, index, row or the schema version.
//
// The aged store is BUILT here: a real `Store.open` over an mkdtemp file with
// real seed rows (a project, a plan whose cycle ran, closed over a commit),
// then aged by dropping the table, the way a store written by the build before
// the table arrived looks. The live store is never read.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store } from "../src/store.ts";

const TABLE = "plan_gate_acceptances";

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

/** A table name read from `sqlite_master`, admitted only as a plain
 *  identifier and quoted — the one name a query here is built from. */
function tableIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unexpected table name: ${name}`);
  return `"${name}"`;
}

interface Snapshot {
  userVersion: number;
  schema: Array<{ type: string; name: string; sql: string | null }>;
  rows: Record<string, string[]>;
}

/** Every schema object and every row of the store at `dbPath`, read raw. */
function snapshot(dbPath: string): Snapshot {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const userVersion = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const schema = raw
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const rows: Record<string, string[]> = {};
    for (const { name } of schema.filter((entry) => entry.type === "table")) {
      rows[name] = raw
        .query<Record<string, unknown>, []>("SELECT * FROM " + tableIdentifier(name))
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
    }
    return { userVersion, schema, rows };
  } finally {
    raw.close();
  }
}

function withoutTable(snap: Snapshot): Snapshot {
  const rows = { ...snap.rows };
  delete rows[TABLE];
  return { ...snap, schema: snap.schema.filter((entry) => entry.name !== TABLE), rows };
}

describe("a store at the current schema version without plan_gate_acceptances", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  /** A real store with real rows, aged by dropping the table. */
  function agedStore(): { dbPath: string; projectKey: string } {
    const dir = mkdtempSync(join(tmpdir(), "aged-gate-acceptances-"));
    scratchDirs.push(dir);
    const dbPath = join(dir, "aged.db");
    const projectKey = crypto.randomUUID();
    const store = Store.open(dbPath);
    store.addProject({ key: projectKey, name: "aged-store", type: "backend", sutRoot: "/tmp/aged" });
    const plan = store.filePlan(projectKey, { cr: "AGED-GATE-1", cycles: [{ label: "solo", kind: "red-green" }] });
    if ("error" in plan) throw new Error(`fixture: filePlan refused: ${plan.error}`);
    const cycleId = plan.cycles[0]!.id;
    for (const to of ["active", "done"] as const) {
      const moved = store.transitionCycle(projectKey, plan.planId, cycleId, to);
      if ("error" in moved) throw new Error(`fixture: cycle -> ${to} refused: ${moved.error}`);
    }
    const closed = store.closePlan(projectKey, plan.planId, { commit: "0a1b2c3" });
    if ("error" in closed) throw new Error(`fixture: closePlan refused: ${closed.error}`);
    dbOf(store).close();

    const raw = new Database(dbPath);
    try {
      raw.exec("PRAGMA journal_mode = DELETE;");
      raw.exec("DROP TABLE plan_gate_acceptances");
    } finally {
      raw.close();
    }
    return { dbPath, projectKey };
  }

  test("opens, gains the table, and leaves every other table, index, row and the schema version as they were", () => {
    const { dbPath } = agedStore();
    const before = snapshot(dbPath);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    expect(before.schema.map((entry) => entry.name)).not.toContain(TABLE);
    expect(before.rows.plans!.length).toBe(1);

    const store = Store.open(dbPath);
    dbOf(store).close();

    const after = snapshot(dbPath);
    const gained = after.schema.find((entry) => entry.name === TABLE);
    expect(gained?.type).toBe("table");
    const raw = new Database(dbPath, { readonly: true });
    try {
      const columns = raw
        .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .all(TABLE)
        .map((column) => column.name);
      expect(columns).toEqual(["plan_id", "project_key", "reason"]);
    } finally {
      raw.close();
    }
    expect(after.rows[TABLE]).toEqual([]);
    expect(withoutTable(after)).toEqual(before);
  });

  test("once opened, a plan closed over a red gate stores its reason in the gained table", () => {
    const { dbPath, projectKey } = agedStore();
    const store = Store.open(dbPath);
    try {
      const plan = store.filePlan(projectKey, { cr: "AGED-GATE-2", cycles: [{ label: "solo", kind: "red-green" }] });
      if ("error" in plan) throw new Error(`filePlan refused: ${plan.error}`);
      const active = store.transitionCycle(projectKey, plan.planId, plan.cycles[0]!.id, "active");
      if ("error" in active) throw new Error(`cycle -> active refused: ${active.error}`);
      const done = store.transitionCycle(projectKey, plan.planId, plan.cycles[0]!.id, "done");
      if ("error" in done) throw new Error(`cycle -> done refused: ${done.error}`);
      const closed = store.closePlan(projectKey, plan.planId, {
        commit: "4d5e6f7",
        acceptedFailingGateReason: "a known flake, fixed next",
      });
      if ("error" in closed) throw new Error(`closePlan refused: ${closed.error}`);
      const listed = store.listPlans(projectKey).find((entry) => entry.cr === "AGED-GATE-2");
      expect(listed?.merge?.acceptedFailingGateReason).toBe("a known flake, fixed next");
    } finally {
      dbOf(store).close();
    }
  });
});
