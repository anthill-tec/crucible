// A store written before the `run_coverage_files` table (a base-pass table:
// no chain step, no schema version of its own) gains it when it opens:
//
//  - a store at the current schema version without the table opens, gains
//    it, and changes nothing else — no other table, index or row, and the
//    same schema version;
//  - an unstamped store that has the six earlier run-detail tables and not
//    this one is baselined exactly as an unstamped store that has it: every
//    chain step's own "already done?" probe answers the same, the same steps
//    run, and none runs again because the table is missing.
//
// Each aged store is BUILT here: a real `Store.open` over an mkdtemp file with
// real seed rows (a project, a green run with a tree and coverage totals, a
// failing run), then aged by dropping the table, the way a store written by
// the build before the table arrived looks. The version an unstamped store is
// baselined at is measured on a reference store by this build, never written
// here as a number. The ingest into an aged store goes through the real
// production HTTP surface (`startServer`, port 0) on that scratch file. The
// live store is never read.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerHandle } from "../../src/server.ts";
import { MIGRATIONS, SCHEMA_VERSION, Store } from "../../src/store.ts";
import type { MigrationStep } from "../../src/store.ts";
import type { SuiteNode } from "../../src/types.ts";
import { bootOn, register } from "../helpers/run-stream-harness.ts";
import { dbOf, eventIdOf, FILES_TABLE, fileRowCount, ingestRun, lcovText } from "../helpers/coverage-files-harness.ts";

/** The six run-detail tables a store held before this one. */
const EARLIER_RUN_DETAIL_TABLES = ["run_case_steps", "run_cases", "run_suites", "run_diagnostics", "run_compiles", "run_details"];

/** A table name admitted only as a plain identifier and quoted — the one name a statement here is built from. */
function tableIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unexpected table name: ${name}`);
  return `"${name}"`;
}

interface SchemaEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface Snapshot {
  userVersion: number;
  schema: SchemaEntry[];
  rows: Record<string, string[]>;
}

/** Every schema object and every row of the store at `dbPath`, read raw. */
function snapshot(dbPath: string): Snapshot {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const userVersion = raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const schema = raw
      .query<SchemaEntry, []>(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
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

/** The snapshot with the files table, and anything declared on it, set aside. */
function withoutFilesTable(snap: Snapshot): Snapshot {
  const rows = { ...snap.rows };
  delete rows[FILES_TABLE];
  return { ...snap, schema: snap.schema.filter((entry) => entry.tbl_name !== FILES_TABLE), rows };
}

function tree(prefix: string, status: "pass" | "fail"): SuiteNode[] {
  return [
    {
      name: `${prefix} suite`,
      status,
      children: [
        { name: `${prefix} first`, status: "pass", duration_ms: 3 },
        status === "pass"
          ? { name: `${prefix} second`, status: "pass", duration_ms: 4 }
          : { name: `${prefix} second`, status: "fail", duration_ms: 4, failure: { message: "expected 1" } },
      ],
    },
  ];
}

const SEED_COVERAGE = {
  lines: { total: 80, covered: 31, percent: 38.8 },
  functions: { total: 4, covered: 2, percent: 50 },
};

const scratchDirs: string[] = [];
const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

interface Aging {
  /** Tables dropped after the seed, as a store that never had them. */
  drop: readonly string[];
  /** Put the store back into the unstamped condition (`user_version` 0). */
  unstamp?: boolean;
}

/** A real store with real rows, then aged. */
function agedStore(aging: Aging): { dbPath: string; projectKey: string } {
  const dir = mkdtempSync(join(tmpdir(), "aged-coverage-files-"));
  scratchDirs.push(dir);
  const dbPath = join(dir, "aged.db");
  const projectKey = crypto.randomUUID();
  const store = Store.open(dbPath);
  store.addProject({ key: projectKey, name: "aged-coverage", type: "backend", sutRoot: "/tmp/aged-coverage" });
  store.addProject({ key: crypto.randomUUID(), name: "aged-coverage-other", type: "backend", sutRoot: "/tmp/aged-other" });
  store.recordTestEvent(
    projectKey,
    "aged-runner",
    { summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 }, tree: tree("green", "pass"), coverage: SEED_COVERAGE },
    { tier: "unit", stack: "bun" },
  );
  store.recordTestEvent(
    projectKey,
    "aged-runner",
    { summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 }, tree: tree("red", "fail") },
    { tier: "unit", stack: "bun" },
  );
  dbOf(store).close();

  const raw = new Database(dbPath);
  try {
    raw.exec("PRAGMA journal_mode = DELETE;");
    for (const table of aging.drop) raw.exec("DROP TABLE IF EXISTS " + tableIdentifier(table));
    if (aging.unstamp === true) raw.exec("PRAGMA user_version = 0");
  } finally {
    raw.close();
  }
  return { dbPath, projectKey };
}

function tableNames(dbPath: string): string[] {
  return snapshot(dbPath)
    .schema.filter((entry) => entry.type === "table")
    .map((entry) => entry.name);
}

// ── A store at the current schema version ───────────────────────────────────

describe("a store at the current schema version without run_coverage_files", () => {
  test("opens, gains the table, and leaves every other table, index, row and the schema version as they were", () => {
    const { dbPath } = agedStore({ drop: [FILES_TABLE] });
    const before = snapshot(dbPath);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    expect(before.schema.map((entry) => entry.name)).not.toContain(FILES_TABLE);
    // The seed is real: runs with trees and coverage totals are held, so "unchanged" is never vacuous.
    expect(before.rows.events!.length).toBe(2);
    expect(before.rows.run_suites!.length).toBe(2);
    expect(before.rows.run_cases!.length).toBe(4);
    expect(before.rows.projects!.length).toBe(2);
    expect(before.rows.events!.filter((row) => row.includes("38.8")).length).toBe(1);

    const store = Store.open(dbPath);
    dbOf(store).close();

    const after = snapshot(dbPath);
    expect(after.schema.filter((entry) => entry.name === FILES_TABLE).map((entry) => entry.type)).toEqual(["table"]);
    // The runs already stored keep their totals and gain no file row: their report text was never kept.
    expect(after.rows[FILES_TABLE]).toEqual([]);
    expect(withoutFilesTable(after)).toEqual(before);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    // Nothing migrated, so no recovery point was written beside the store.
    expect(readdirSync(dirname(dbPath)).filter((name) => name.includes(".pre-upgrade-"))).toEqual([]);
  });

  test("opened again after gaining it, the store is unchanged: the table is written once", () => {
    const { dbPath } = agedStore({ drop: [FILES_TABLE] });
    dbOf(Store.open(dbPath)).close();
    const once = snapshot(dbPath);
    dbOf(Store.open(dbPath)).close();
    expect(snapshot(dbPath)).toEqual(once);
    expect(once.schema.filter((entry) => entry.name === FILES_TABLE && entry.type === "table").length).toBe(1);
  });

  test("once opened, a green run ingested with a coverage block stores its files in the gained table", async () => {
    const { dbPath, projectKey } = agedStore({ drop: [FILES_TABLE] });
    const handle = bootOn(dbPath);
    handles.push(handle);
    const earlier = handle.store
      .listEvents(projectKey)
      .filter((event) => event.kind === "test")
      .map((event) => event.id);
    expect(earlier.length).toBe(2);
    await register(handle, projectKey, "aged-ingester");

    const eventId = eventIdOf(
      await ingestRun(handle, projectKey, "aged-ingester", {
        codec: "lcov",
        data: lcovText([
          { path: "src/a.ts", lf: 4, lh: 2 },
          { path: "src/b.ts", lf: 6, lh: 6, fnf: 1, fnh: 1 },
        ]),
      }),
    );

    const db = dbOf(handle.store);
    expect(fileRowCount(db, eventId)).toBe(2);
    // The runs the aged store already held have no file row.
    expect(earlier.map((id) => fileRowCount(db, id))).toEqual([0, 0]);
  });
});

// ── An unstamped store ──────────────────────────────────────────────────────

/** Each chain step's own "already done?" probe on the store file: true, false, or null for a step with none. */
function stepProbes(dbPath: string): Array<boolean | null> {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return MIGRATIONS.map((step) => (step.satisfiedBy === undefined ? null : step.satisfiedBy(raw) === true));
  } finally {
    raw.close();
  }
}

/** The version an unstamped store with these probes is baselined at: one per leading step already done. */
function baselinedAt(probes: ReadonlyArray<boolean | null>): number {
  const firstOwed = probes.findIndex((probe) => probe !== true);
  return firstOwed < 0 ? probes.length : firstOwed;
}

interface Opened {
  /** The `from` of every chain step this open ran, in order. */
  ran: number[];
  migration: { from: number; to: number } | null;
  userVersion: number;
}

/** Opens the store on the real chain, recording each step it runs. */
function openRecordingSteps(dbPath: string): Opened {
  const ran: number[] = [];
  const chain: MigrationStep[] = MIGRATIONS.map((step) => ({
    ...step,
    apply(db: Database): void {
      ran.push(step.from);
      step.apply(db);
    },
  }));
  const store = Store.open(dbPath, { migrations: chain });
  const migration = store.migration === null ? null : { from: store.migration.from, to: store.migration.to };
  const userVersion = store.schemaVersion;
  dbOf(store).close();
  return { ran, migration, userVersion };
}

describe("an unstamped store with the six earlier run-detail tables and without run_coverage_files", () => {
  test("is baselined at the version an unstamped store that has the table is, runs the same steps, and gains the table", () => {
    // The reference: this build's own store put back into the unstamped condition, nothing dropped.
    const reference = agedStore({ drop: [], unstamp: true }).dbPath;
    const subject = agedStore({ drop: [FILES_TABLE], unstamp: true }).dbPath;
    expect(snapshot(subject).userVersion).toBe(0);
    expect(tableNames(subject)).toEqual(expect.arrayContaining(EARLIER_RUN_DETAIL_TABLES));
    expect(tableNames(subject)).not.toContain(FILES_TABLE);

    // Every step's own probe answers the same without the table as with it.
    const referenceProbes = stepProbes(reference);
    const subjectProbes = stepProbes(subject);
    expect(subjectProbes).toEqual(referenceProbes);
    expect(baselinedAt(subjectProbes)).toBe(baselinedAt(referenceProbes));

    // The probes do bite on the run-detail tables: a store missing one of the six is baselined lower.
    for (const earlier of EARLIER_RUN_DETAIL_TABLES) {
      const missingOne = agedStore({ drop: [earlier], unstamp: true }).dbPath;
      expect(baselinedAt(stepProbes(missingOne)), `without ${earlier}`).toBeLessThan(baselinedAt(referenceProbes));
    }

    // And the real open agrees: the same steps run, from the same version to the same version.
    const referenceOpen = openRecordingSteps(reference);
    const subjectOpen = openRecordingSteps(subject);
    expect(subjectOpen.ran).toEqual(referenceOpen.ran);
    expect(subjectOpen.ran).toEqual(MIGRATIONS.map((step) => step.from).filter((from) => from >= baselinedAt(referenceProbes)));
    expect(subjectOpen.migration).toEqual(referenceOpen.migration);
    expect(subjectOpen.userVersion).toBe(SCHEMA_VERSION);

    // The base pass runs after the chain, so the store has the table once opened.
    expect(tableNames(subject)).toContain(FILES_TABLE);
  });

  test("keeps every row it held, and its runs gain no file row", () => {
    const { dbPath } = agedStore({ drop: [FILES_TABLE], unstamp: true });
    const before = snapshot(dbPath);

    const opened = openRecordingSteps(dbPath);

    const after = snapshot(dbPath);
    expect(opened.userVersion).toBe(SCHEMA_VERSION);
    expect(withoutFilesTable(after).rows).toEqual(before.rows);
    expect(after.rows[FILES_TABLE]).toEqual([]);
  });
});
