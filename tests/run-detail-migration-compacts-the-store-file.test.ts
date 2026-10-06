// After the migration (§S3) compacts the store, a store that held one run's
// large tree and raw output in its legacy columns must not be more than
// 1.25x its pre-migration size — the whole point of moving that detail into
// rows and running VACUUM afterwards. RED: there is no data-moving step yet,
// so a legacy store opened today keeps every byte of its legacy columns
// (proven directly below), and nothing ever runs VACUUM on the live file.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MIGRATIONS, Store } from "../src/store.ts";
import type { SuiteNode } from "../src/types.ts";

const PRE_DATA_MOVE_VERSION = 16; // see tests/run-detail-rows-migrated-from-legacy-columns.test.ts

const BIG_RUN_ID = "big-legacy-run";

/** 50 suites of 40 cases (2000 cases), a chunky trace on every 7th failure,
 *  and ~190 KB of raw output — a run whose detail genuinely dominates the
 *  file, the way the AC's own "a store whose detail is large" describes. */
function bigLegacyTree(): SuiteNode[] {
  const suites: SuiteNode[] = [];
  for (let s = 0; s < 50; s++) {
    const children = Array.from({ length: 40 }, (_, i) => {
      const failed = i % 7 === 0;
      return {
        name: `case-${s}-${i}`,
        status: (failed ? "fail" : "pass") as "fail" | "pass",
        duration_ms: i,
        ...(failed
          ? { failure: { message: `boom-${s}-${i}`, type: "AssertionError", trace: "x".repeat(200) } }
          : {}),
      };
    });
    suites.push({ name: `Suite${s}`, status: "pass", children });
  }
  return suites;
}

function buildBigLegacyStore(dbPath: string): void {
  const boot = new Store(dbPath);
  const db = (boot as unknown as { db: Database }).db;
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec(`
    DROP INDEX IF EXISTS idx_run_suites_name;
    DROP INDEX IF EXISTS idx_run_suites_feature;
    DROP TABLE IF EXISTS run_cases;
    DROP TABLE IF EXISTS run_suites;
    DROP TABLE IF EXISTS run_diagnostics;
    DROP TABLE IF EXISTS run_compiles;
    DROP TABLE IF EXISTS run_details;
  `);
  db.query(
    `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run("big-legacy-proj", "Big", "backend", "/tmp/big", 1000);
  const raw = "runner output line\n".repeat(10_000); // ~190 KB
  db.query(
    `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp,
       total, passed, failed, pending, duration_ms, tree, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    BIG_RUN_ID,
    "big-legacy-proj",
    "legacy-agent",
    "test",
    "unit",
    1_000_000,
    2000,
    2000 - Math.ceil(2000 / 7),
    Math.ceil(2000 / 7),
    0,
    2000,
    JSON.stringify(bigLegacyTree()),
    JSON.stringify({ raw }),
  );
  db.exec("PRAGMA user_version = 15;");
  db.close();
}

function legacyTreeColumn(dbPath: string, id: string): string | null {
  const db = new Database(dbPath);
  try {
    return (
      db.query<{ tree: string | null }, [string]>(`SELECT tree FROM events WHERE id = ?`).get(id)?.tree ?? null
    );
  } finally {
    db.close();
  }
}

describe("migrating a store with one run's large detail", () => {
  test("the file afterwards is no more than 1.25x its pre-migration size", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-detail-migration-size-"));
    try {
      const baseDir = path.join(dir, "base");
      const beforeDir = path.join(dir, "before");
      const afterDir = path.join(dir, "after");
      fs.mkdirSync(baseDir);
      fs.mkdirSync(beforeDir);
      fs.mkdirSync(afterDir);

      const baseDbPath = path.join(baseDir, "crucible.db");
      buildBigLegacyStore(baseDbPath);

      const beforeDbPath = path.join(beforeDir, "crucible.db");
      const afterDbPath = path.join(afterDir, "crucible.db");
      fs.copyFileSync(baseDbPath, beforeDbPath);
      fs.copyFileSync(baseDbPath, afterDbPath);

      Store.open(beforeDbPath, { migrations: MIGRATIONS.slice(0, PRE_DATA_MOVE_VERSION) });
      const beforeSize = fs.statSync(beforeDbPath).size;
      // Precondition: this really is a "large detail" store, not a trivial one.
      expect(beforeSize).toBeGreaterThan(200_000);

      Store.open(afterDbPath);

      // The defect this fails on TODAY: nothing has moved the legacy column
      // out yet, so it still holds the whole tree and the file cannot have
      // shrunk at all.
      expect(legacyTreeColumn(afterDbPath, BIG_RUN_ID)).toBeNull();

      const afterSize = fs.statSync(afterDbPath).size;
      expect(
        afterSize,
        `after=${afterSize} before=${beforeSize} ratio=${(afterSize / beforeSize).toFixed(3)}`,
      ).toBeLessThanOrEqual(Math.ceil(beforeSize * 1.25));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
