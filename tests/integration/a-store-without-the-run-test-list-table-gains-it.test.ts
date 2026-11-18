// An aged store at the current schema version that predates the
// `run_test_lists` table (a base-pass table: no chain step, no schema
// version) opens, gains the table, and changes nothing else — no other table,
// index, row or the schema version.
//
// The aged store is BUILT here: a real `Store.open` over an mkdtemp file with
// real seed rows (a project, an open run that has streamed two batches, one a
// failure, and a second project), then aged by dropping the table, the way a
// store written by the build before the table arrived looks. The live store is
// never read.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store } from "../../src/store.ts";
import { listOf, suiteStarted, testName, testOk } from "../helpers/nextest-harness.ts";
import { eventLine, utf8 } from "../helpers/run-stream-harness.ts";

const TABLE = "run_test_lists";

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

/** The snapshot with the list's table, and every index on it, set aside. */
function withoutTable(snap: Snapshot): Snapshot {
  const rows = { ...snap.rows };
  delete rows[TABLE];
  return {
    ...snap,
    schema: snap.schema.filter((entry) => entry.name !== TABLE && !(entry.sql ?? "").includes(` ON ${TABLE}`)),
    rows,
  };
}

const L_START = eventLine({ event: "run-start", total: 2 });
const L_PASS = eventLine({ event: "test-end", id: "t1", name: "adds", suite: "math", file: "src/math.ts", status: "pass" });
const L_FAIL = eventLine({
  event: "test-end",
  id: "t2",
  name: "divides",
  suite: "math",
  file: "src/math.ts",
  status: "fail",
  failure: { message: "expected 1" },
});

describe("a store at the current schema version without run_test_lists", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  /** A real store with real rows — an open run's held stream and live state among them — aged by dropping the table. */
  function agedStore(): { dbPath: string; projectKey: string; streamedRunId: string } {
    const dir = mkdtempSync(join(tmpdir(), "aged-run-test-lists-"));
    scratchDirs.push(dir);
    const dbPath = join(dir, "aged.db");
    const projectKey = crypto.randomUUID();
    const store = Store.open(dbPath);
    store.addProject({ key: projectKey, name: "aged-lists", type: "backend", sutRoot: "/tmp/aged-lists" });
    store.addProject({ key: crypto.randomUUID(), name: "aged-lists-other", type: "backend", sutRoot: "/tmp/aged-other" });
    const streamedRunId = store.startRun(projectKey, "aged-streamer", { tier: "unit", stack: "bun" }).runId;
    const first = L_START + L_PASS;
    for (const [from, data] of [
      [0, first],
      [utf8(first), L_FAIL],
    ] as const) {
      const outcome = store.appendRunStream(streamedRunId, { codec: "crucible-events", from, data, limit: 1 << 20 });
      if (!outcome.ok) throw new Error(`fixture: batch from ${from} refused: ${JSON.stringify(outcome)}`);
    }
    dbOf(store).close();

    const raw = new Database(dbPath);
    try {
      raw.exec("PRAGMA journal_mode = DELETE;");
      raw.exec("DROP TABLE run_test_lists");
    } finally {
      raw.close();
    }
    return { dbPath, projectKey, streamedRunId };
  }

  test("opens, gains the table, and leaves every other table, index, row and the schema version as they were", () => {
    const { dbPath } = agedStore();
    const before = snapshot(dbPath);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    expect(before.schema.map((entry) => entry.name)).not.toContain(TABLE);
    // The seed is real: the open run's stream and live state are held, so "unchanged" is never vacuous.
    expect(before.rows.run_stream_batches!.length).toBe(2);
    expect(before.rows.run_live!.length).toBe(1);
    expect(before.rows.run_live_failures!.length).toBe(1);
    expect(before.rows.projects!.length).toBe(2);

    const store = Store.open(dbPath);
    dbOf(store).close();

    const after = snapshot(dbPath);
    const gained = after.schema.filter((entry) => entry.name === TABLE);
    expect(gained.map((entry) => entry.type)).toEqual(["table"]);
    expect(after.rows[TABLE]).toEqual([]);
    expect(withoutTable(after)).toEqual(before);
  });

  test("opened again after gaining it, the store is unchanged: the table is written once", () => {
    const { dbPath } = agedStore();
    dbOf(Store.open(dbPath)).close();
    const once = snapshot(dbPath);
    dbOf(Store.open(dbPath)).close();
    expect(snapshot(dbPath)).toEqual(once);
    expect(once.schema.filter((entry) => entry.name === TABLE).length).toBe(1);
  });

  test("once opened, an open run takes its test list into the gained table, and its live total is the listed one", () => {
    const { dbPath, projectKey, streamedRunId } = agedStore();
    const store = Store.open(dbPath);
    try {
      const runId = store.startRun(projectKey, "aged-lister", { tier: "unit", stack: "rust" }).runId;
      const list = listOf([
        {
          crate: "nxaged",
          binaryName: "nxaged",
          kind: "lib",
          tests: [
            { path: "tests::a", matches: true },
            { path: "tests::b", matches: true },
            { path: "tests::c", matches: true },
          ],
        },
      ]);
      expect(store.takeRunTestList(runId, list, 3)).toEqual({ ok: true });
      const batch = suiteStarted("nxaged", "nxaged", "lib", 3) + testOk(testName("nxaged", "nxaged", "tests::a"), 0.001);
      const appended = store.appendRunStream(runId, { codec: "nextest", from: 0, data: batch, limit: 1 << 20 });
      expect(appended).toEqual({ ok: true, held: utf8(batch) });
      expect(store.runLive(runId)).toMatchObject({ completed: 1, total: 3, passed: 1, failed: 0 });
      const held = dbOf(store)
        .query<{ run_id: string }, []>("SELECT run_id FROM run_test_lists")
        .all()
        .map((row) => row.run_id);
      expect(held).toEqual([runId]);
      // The aged store's own open run is untouched by the other run's list.
      expect(store.runLive(streamedRunId)).toMatchObject({ completed: 2, total: 2, passed: 1, failed: 1 });
    } finally {
      dbOf(store).close();
    }
  });
});
