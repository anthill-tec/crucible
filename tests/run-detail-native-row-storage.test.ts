// CR-CRU-167 §S1 — RED (C1): a test run's detail (suites, cases, compile
// diagnostics) lands as native rows, never as JSON text, and ingest writes
// ONLY that native storage. The new tables are described by the CR by ROLE
// ("a suites table", "a cases table", "the feature column") and never by a
// literal name, so every helper below discovers structure by role — does
// some table grow when a run lands? does some column hold this exact value?
// — rather than guessing a name GREEN never committed to.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { startServer } from "../src/server.ts";
import { parseJunit } from "../src/codecs/junit.ts";
import { parsePlaywright } from "../src/codecs/playwright.ts";
import { parseCompile } from "../src/codecs/compile.ts";
import type { Project, RunSummary, SuiteNode } from "../src/types.ts";

// ── generic, naming-agnostic raw-SQLite introspection ───────────────────────

function userTables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);
}

function tableColumns(db: Database, table: string): { name: string; type: string }[] {
  return db.query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`).all();
}

function textColumnsOf(db: Database, table: string): string[] {
  return tableColumns(db, table)
    .filter((c) => c.type.toUpperCase() === "TEXT")
    .map((c) => c.name);
}

/** Every "table.column" location where a TEXT column of SOME row equals
 *  `value` exactly, EXCLUDING `events` itself — the generic stand-in for
 *  "detail rows that belong to run R" (a suite/case/diagnostic row), never
 *  the run's own primary-key row (which trivially always "references" its
 *  own id and would make this check pass vacuously), whatever the new
 *  tables end up naming their foreign key. */
function countDetailRowsReferencing(db: Database, value: string): number {
  let total = 0;
  for (const table of userTables(db)) {
    if (table === "events") continue;
    for (const col of textColumnsOf(db, table)) {
      const row = db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) as n FROM "${table}" WHERE "${col}" = ?`)
        .get(value);
      total += row?.n ?? 0;
    }
  }
  return total;
}

function looksLikeSuiteTree(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (node) =>
        node !== null &&
        typeof node === "object" &&
        typeof (node as { name?: unknown }).name === "string" &&
        typeof (node as { status?: unknown }).status === "string" &&
        Array.isArray((node as { children?: unknown }).children),
    )
  );
}

function looksLikeCompileReport(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { format?: unknown }).format === "string" &&
    typeof (value as { errorCount?: unknown }).errorCount === "number" &&
    Array.isArray((value as { diagnostics?: unknown }).diagnostics)
  );
}

/** Every "table.column" that holds a suite-tree or a compile-report
 *  serialised as JSON TEXT, ANYWHERE in the store. */
function jsonSuiteOrCompileColumns(db: Database): string[] {
  const hits: string[] = [];
  for (const table of userTables(db)) {
    for (const col of textColumnsOf(db, table)) {
      const rows = db
        .query<{ v: string | null }, []>(
          `SELECT "${col}" as v FROM "${table}" WHERE "${col}" IS NOT NULL`,
        )
        .all();
      for (const { v } of rows) {
        if (v === null) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          continue;
        }
        if (looksLikeSuiteTree(parsed) || looksLikeCompileReport(parsed)) {
          hits.push(`${table}.${col}`);
          break;
        }
      }
    }
  }
  return hits;
}

/** Locates whichever table carries a column by this exact name — the ROLE
 *  the CR text names ("the feature column") without a literal table name.
 *  Fails with the MISSING CONTRACT, not a bare `no such table` SQLite error. */
function tableWithColumn(db: Database, columnName: string): string {
  for (const table of userTables(db)) {
    if (tableColumns(db, table).some((c) => c.name === columnName)) return table;
  }
  throw new Error(
    `no table in the store carries a "${columnName}" column — the native ` +
      `per-test-detail storage this step describes does not exist yet`,
  );
}

function orderingColumn(db: Database, table: string): string {
  return tableColumns(db, table).some((c) => c.name === "position") ? "position" : "rowid";
}

// ── shared fixtures ──────────────────────────────────────────────────────

function seedProject(store: Store, extra?: Partial<Project>): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp", ...(extra ?? {}) });
  return key;
}

function summary(overrides?: Partial<RunSummary>): RunSummary {
  return { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5, ...overrides };
}

function richTree(): SuiteNode[] {
  return [
    {
      name: "suite-one",
      status: "fail",
      browser: "chromium",
      children: [
        { name: "case-1a", status: "pass", duration_ms: 12 },
        {
          name: "case-1b",
          status: "fail",
          duration_ms: 34,
          failure: { message: "boom", type: "AssertionError", trace: "at x:1:1" },
        },
      ],
    },
    {
      name: "suite-two",
      status: "pass",
      children: [{ name: "case-2a", status: "pass", duration_ms: 5 }],
    },
  ];
}

function richSummary(): RunSummary {
  return { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 51 };
}

function freshFileStore(): { store: Store; db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "run-detail-rows-"));
  const dbPath = join(dir, "crucible.db");
  const store = new Store(dbPath);
  const db = new Database(dbPath);
  return { store, db, dir };
}

const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

// ───────────────────────────────────────────────────────────────────────────
// Route-level: ingest through the real server writes ONLY native storage,
// and every existing read keeps answering the same JSON value it always has.
// ───────────────────────────────────────────────────────────────────────────

describe("ingest via the real routes stores no suite/test/compile JSON, and reads stay value-equal", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let dirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function boot(): { port: number; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "run-detail-rows-route-"));
    dirs.push(dir);
    const dbPath = join(dir, "crucible.db");
    handle = startServer({ port: 0, dbPath });
    return { port: handle.server.port!, dbPath };
  }

  async function postJson(port: number, path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(port: number, path: string): Promise<Response> {
    return fetch(`http://localhost:${port}${path}`);
  }

  async function createProject(port: number, name: string): Promise<string> {
    const res = await postJson(port, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    return body.project.key;
  }

  async function registerAgent(port: number, key: string, agentId: string): Promise<void> {
    const res = await postJson(port, "/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  test("a junit run with a failing case (message+type+trace) reads back value-equal to the codec's own output, and no table/column anywhere holds it as JSON", async () => {
    const { port, dbPath } = boot();
    const key = await createProject(port, "junit-native");
    await registerAgent(port, key, "a1");

    const xml = [
      '<testsuite name="Suite1" tests="3">',
      '<testcase name="t1" time="0.01"/>',
      '<testcase name="t2" time="0.02"/>',
      '<testcase name="t3" time="0.03"><failure message="boom" type="AssertionError">at x:1:1</failure></testcase>',
      "</testsuite>",
    ].join("\n");
    const expected = parseJunit(xml);

    const runRes = await postJson(port, "/api/v2/runs", {
      projectKey: key,
      agentId: "a1",
      codec: "junit",
      data: xml,
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { event: string };

    const getRes = await getJson(port, `/api/v2/events/${runBody.event}`);
    const getBody = (await getRes.json()) as { event: { tree: SuiteNode[]; summary: RunSummary } };
    expect(getBody.event.tree).toEqual(expected.tree);
    expect(getBody.event.summary).toEqual(expected.summary);

    const db = new Database(dbPath);
    try {
      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("two suites sharing (name, browser) keep their posted order, and ?suite= still answers the first", async () => {
    const { port, dbPath } = boot();
    const key = await createProject(port, "dup-suites-native");
    await registerAgent(port, key, "a1");

    const tree = [
      {
        name: "Login",
        status: "pass",
        browser: "chromium",
        children: [{ name: "first-attempt", status: "pass", duration_ms: 1 }],
      },
      {
        name: "Login",
        status: "fail",
        browser: "chromium",
        children: [
          { name: "second-attempt", status: "fail", duration_ms: 2, failure: { message: "nope" } },
        ],
      },
    ];

    const runRes = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 3 },
      tree,
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { event: string };

    const fullRes = await getJson(port, `/api/v2/events/${runBody.event}`);
    const fullBody = (await fullRes.json()) as { event: { tree: SuiteNode[] } };
    expect(fullBody.event.tree).toEqual(tree as unknown as SuiteNode[]);

    const suiteRes = await getJson(
      port,
      `/api/v2/events/${runBody.event}?suite=Login&browser=chromium`,
    );
    const suiteBody = (await suiteRes.json()) as { event: { tree: SuiteNode[] } };
    expect(suiteBody.event.tree).toEqual([tree[0]] as unknown as SuiteNode[]);

    const db = new Database(dbPath);
    try {
      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a compile report (1 rustc error + 1 warning) reads back value-equal to the codec's own output, and no table/column anywhere holds it as JSON", async () => {
    const { port, dbPath } = boot();
    const key = await createProject(port, "compile-native");
    await registerAgent(port, key, "a1");

    const expected = parseCompile(RUSTC_ERRORS, "rustc");

    const runRes = await postJson(port, "/api/v2/runs/compile", {
      projectKey: key,
      agentId: "a1",
      errors: RUSTC_ERRORS,
      format: "rustc",
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { event: string };

    const getRes = await getJson(port, `/api/v2/events/${runBody.event}`);
    const getBody = (await getRes.json()) as { event: { compile: unknown } };
    expect(getBody.event.compile).toEqual(expected);

    const db = new Database(dbPath);
    try {
      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a failure recorded with only `type` (no message, no trace) round-trips exactly — nothing fabricated", async () => {
    const { port, dbPath } = boot();
    const key = await createProject(port, "failure-type-only");
    await registerAgent(port, key, "a1");

    const tree = [
      {
        name: "suite-a",
        status: "fail",
        children: [
          { name: "t1", status: "fail", duration_ms: 9, failure: { type: "AssertionError" } },
        ],
      },
    ];

    const runRes = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 9 },
      tree,
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { event: string };

    const getRes = await getJson(port, `/api/v2/events/${runBody.event}`);
    const getBody = (await getRes.json()) as { event: { tree: SuiteNode[] } };
    const leaf = getBody.event.tree[0]?.children[0] as unknown as Record<string, unknown>;
    expect(leaf?.failure).toEqual({ type: "AssertionError" });
    expect("message" in (leaf?.failure as object)).toBe(false);
    expect("trace" in (leaf?.failure as object)).toBe(false);

    const db = new Database(dbPath);
    try {
      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Store-level: BDD feature column, Store#recordCompileEvent directly, and
// the run-level raw output living outside `payload`.
// ───────────────────────────────────────────────────────────────────────────

describe("Store#recordTestEvent — a BDD scenario's feature is stored, and a feature's scenarios answer in one query", () => {
  test("two interleaved features, each with its own scenarios, are told apart by a single query on the feature column", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const featureA = `Checkout-${crypto.randomUUID()}`;
      const featureB = `Search-${crypto.randomUUID()}`;

      function spec(title: string, status: string) {
        return {
          title,
          tests: [
            {
              projectName: "chromium",
              results: [{ status, steps: [{ title: "a step", duration: 1 }] }],
            },
          ],
        };
      }
      const report = {
        suites: [
          {
            title: "features/sample.feature.spec.js",
            specs: [],
            suites: [
              {
                title: featureA,
                specs: [spec("scenario one", "passed"), spec("scenario two", "failed")],
                suites: [],
              },
              {
                title: featureB,
                specs: [spec("scenario three", "passed")],
                suites: [],
              },
            ],
          },
        ],
      };
      const parsed = parsePlaywright(JSON.stringify(report));
      const event = store.recordTestEvent(pk, "a1", { summary: parsed.summary, tree: parsed.tree });

      // The wire name is UNCHANGED: "<Feature> › <Scenario>".
      expect(event.tree?.map((n) => n.name)).toEqual([
        `${featureA} › scenario one`,
        `${featureA} › scenario two`,
        `${featureB} › scenario three`,
      ]);

      const table = tableWithColumn(db, "feature");
      const order = orderingColumn(db, table);
      const rows = db
        .query<{ name: string }, [string]>(
          `SELECT name FROM "${table}" WHERE feature = ? ORDER BY "${order}"`,
        )
        .all(featureA);
      expect(rows.map((r) => r.name)).toEqual([
        `${featureA} › scenario one`,
        `${featureA} › scenario two`,
      ]);

      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Store#recordCompileEvent — the compile recorder writes native storage", () => {
  test("a compile report lands with no JSON compile column and reads back value-equal", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const report = parseCompile(RUSTC_ERRORS, "rustc");

      const event = store.recordCompileEvent(pk, "a1", report, { tier: "module", stack: "rust" });
      expect(event.compile).toEqual(report);

      const fetched = store.getEvent(event.id);
      expect(fetched?.compile).toEqual(report);

      expect(jsonSuiteOrCompileColumns(db)).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Store#recordTestEvent — the run-level raw output is stored outside `payload`", () => {
  test("a run with raw output reads it back unchanged, and the payload column carries no `raw` key", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const rawOutput = "$ bun test\n3 pass, 0 fail\nraw runner output here";

      const event = store.recordTestEvent(pk, "a1", {
        summary: summary(),
        tree: richTree(),
        raw: rawOutput,
      });
      expect(event.raw).toBe(rawOutput);

      const fetched = store.getEvent(event.id);
      expect(fetched?.raw).toBe(rawOutput);

      const row = db
        .query<{ payload: string | null }, [string]>(`SELECT payload FROM events WHERE id = ?`)
        .get(event.id);
      const payloadObj: Record<string, unknown> =
        row?.payload !== null && row?.payload !== undefined
          ? (JSON.parse(row.payload) as Record<string, unknown>)
          : {};
      expect("raw" in payloadObj).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A run's detail rows go with it on every path that removes the run.
// ───────────────────────────────────────────────────────────────────────────

describe("a run's detail rows are removed wherever the run itself is removed", () => {
  test("Store#deleteEvent removes the run's detail rows along with the event", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const event = store.recordTestEvent(pk, "a1", { summary: richSummary(), tree: richTree() });
      expect(countDetailRowsReferencing(db, event.id)).toBeGreaterThan(0);

      const removed = store.deleteEvent(event.id, pk);
      expect(removed).toBe(true);
      expect(countDetailRowsReferencing(db, event.id)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Store#clearEvents removes every cleared run's detail rows", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const a = store.recordTestEvent(pk, "a1", { summary: richSummary(), tree: richTree() });
      const b = store.recordTestEvent(pk, "a1", { summary: richSummary(), tree: richTree() });
      expect(countDetailRowsReferencing(db, a.id)).toBeGreaterThan(0);
      expect(countDetailRowsReferencing(db, b.id)).toBeGreaterThan(0);

      const removed = store.clearEvents(pk);
      expect(removed).toBe(2);
      expect(countDetailRowsReferencing(db, a.id)).toBe(0);
      expect(countDetailRowsReferencing(db, b.id)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retention eviction removes the evicted run's detail rows", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = crypto.randomUUID();
      store.addProject({ key: pk, name: "retention-detail", type: "backend", sutRoot: "/tmp", retention: 2 });

      const rich = store.recordTestEvent(pk, "a1", { summary: richSummary(), tree: richTree() });
      expect(countDetailRowsReferencing(db, rich.id)).toBeGreaterThan(0);

      // 3 more inserts push the cap (2) past the rich run — it is the
      // OLDEST, so it is the one that evicts.
      for (let i = 0; i < 3; i++) {
        store.recordTestEvent(pk, "a1", { summary: summary(), tree: [] });
      }

      expect(store.getEvent(rich.id)).toBeNull();
      expect(countDetailRowsReferencing(db, rich.id)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Store#deleteProjectCascade removes the project's runs' detail rows with it", () => {
    const { store, db, dir } = freshFileStore();
    try {
      const pk = seedProject(store);
      const event = store.recordTestEvent(pk, "a1", { summary: richSummary(), tree: richTree() });
      expect(countDetailRowsReferencing(db, event.id)).toBeGreaterThan(0);

      store.deleteProjectCascade(pk);
      expect(countDetailRowsReferencing(db, event.id)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
