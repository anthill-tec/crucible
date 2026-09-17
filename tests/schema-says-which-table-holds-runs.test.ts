// CR-CRU-140 §S2 — the schema stops misleading the reader who opens the
// database.
//
// THE TRAP. `runs` holds the OPEN/STREAMING row (`run_state`, `settled_at`,
// `abort_reason`, `event_id`); an ingested result is an `events` row of
// `kind='test'`. The one table whose NAME promises to hold runs is the one
// place a filer's evidence is not. An orchestrator walked straight into it
// on 2026-09-17, read `runs`, found nothing, and published a false
// accusation. This CR does not rename a shipped table (CR-CRU-129's eviction
// history is a standing warning about moving this data, and a migration is
// out of proportion to a naming complaint) — it closes the trap where it is
// cheap and honest, by making each table SAY what it holds and what the
// other holds.
//
// WHY THE ASSERTION IS AGAINST `sqlite_master`, not a grep of src/store.ts.
// The reader this CR is about had a sqlite prompt open, not an editor. Only
// text INSIDE the `CREATE TABLE …( … )` statement survives into
// `sqlite_master.sql` — a comment written ABOVE the statement in
// `src/store.ts` is invisible to `.schema` and would leave that reader
// exactly as misled as before. So the guard reads the schema back out of a
// store THIS BUILD created, which is both the shipped CREATE TABLE text
// verbatim (SQLite records the statement as given) and precisely what the
// reader sees. A future table change that drops the warning fails here.
//
// SAFETY. Every store below is created fresh under an OS tmpdir and removed
// afterwards. `data/crucible.db` is never opened and the live board is never
// contacted.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, Store } from "../src/store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/** A store THIS build created, from scratch — no retrofit, no fixture. */
function freshStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cr140-schema-"));
  dirs.push(dir);
  const path = join(dir, "crucible.db");
  // `Store` has no close verb — tests/store-migration.test.ts opens a store
  // and then reads the file back through a second connection exactly so.
  Store.open(path);
  return path;
}

/** What a second connection reads back — the schema, in the store's words. */
function shippedSchema(path: string, table: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    return row?.sql ?? "";
  } finally {
    db.close();
  }
}

function tableNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

/** The `--` prose the statement itself carries, which is all a reader gets. */
function schemaComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => line.includes("--"))
    .map((line) => line.slice(line.indexOf("--")))
    .join("\n");
}

describe("CR-CRU-140 §S2 — the schema states which table holds what", () => {
  test("the shipped `runs` statement tells a reader it holds the OPEN/streaming row and that ingested results live in `events`", () => {
    const path = freshStorePath();
    const sql = shippedSchema(path, "runs");

    // Control: the right object was read, and read whole.
    expect(sql.startsWith("CREATE TABLE runs")).toBe(true);
    expect(sql).toContain("run_state");

    // POSITIVE — the statement NAMES the other table, and says what each
    // holds. Wording is the author's; the three facts are not. The name is
    // required BACKTICKED, this file's own convention for an identifier
    // (`run_state`, `context.cycleId`, … throughout src/store.ts), because
    // the bare words are ordinary English here: the events block already
    // says "runs on a store this build created", and a guard that accepted
    // that would pass against prose naming no table at all.
    const prose = schemaComments(sql);
    expect(prose).toMatch(/`events`/);
    expect(prose).toMatch(/ingest/i);
    expect(prose).toMatch(/open|streaming|in-flight/i);
  });

  test("the shipped `events` statement states the converse — ingested results land HERE, while `runs` holds the open row", () => {
    const path = freshStorePath();
    const sql = shippedSchema(path, "events");

    expect(sql.startsWith("CREATE TABLE events")).toBe(true);
    expect(sql).toContain("kind");

    const prose = schemaComments(sql);
    expect(prose).toMatch(/`runs`/);
    expect(prose).toMatch(/ingest/i);
    expect(prose).toMatch(/open|streaming|in-flight/i);
  });

  test("neither table is renamed: a store this build creates still holds `runs` and `events` under those names", () => {
    const path = freshStorePath();
    const names = tableNames(path);

    expect(names).toContain("runs");
    expect(names).toContain("events");
  });

  test("this CR introduces no migration: the chain still ends where the stamp says, and no step is attributed to it", () => {
    // A LITERAL `=== 13` is deliberately NOT asserted. This repo ruled on
    // 2026-09-12 (tests/store-migration.test.ts) that a pinned chain length
    // describes the world on the day it lands and is falsified by the next
    // CR that legitimately appends a body — a pin that outlives its CR is
    // removed, not re-pinned. What THIS CR claims is narrower and does not
    // expire: it appends NO body, so the chain is still self-consistent and
    // carries no step of its own.
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(userVersion(freshStorePath())).toBe(SCHEMA_VERSION);

    const mine = MIGRATIONS.filter((step) => /CR-(CRU-)?140\b/.test(step.description ?? ""));
    expect(mine).toEqual([]);
  });
});
