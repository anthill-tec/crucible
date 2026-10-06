// `GET /api/v2/events/:id?depth=suites` and `?suite=<name>` must answer
// without reading more than they need, and without leaking the run's raw
// output — only the full read (`GET /api/v2/events/:id`, no query) carries
// it. RED: today `handleEventGet` always hydrates the WHOLE run (every
// suite's every case) through `store.getEvent`, regardless of `depth`/
// `suite`, and then spreads `...event` verbatim onto both progressive
// branches — so `?depth=suites` reads every case row it never serves, `?
// suite=` reads every OTHER suite's case rows too, and both branches still
// carry `raw` whenever the run has one.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}
interface RunsParsedResponse extends OkResponse {
  event: string;
}
interface EventGetResponse extends OkResponse {
  event: { id: string; tree?: unknown; raw?: unknown; [key: string]: unknown };
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function postJson(p: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function getJson(p: string): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${p}`);
}
async function createProject(name: string): Promise<string> {
  const res = await postJson("/api/v2/projects", { name });
  const body = (await res.json()) as OkResponse & { project: { key: string } };
  return body.project.key;
}
async function registerAgent(projectKey: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey, agentId, role: "ORCHESTRATOR" });
  expect(res.status).toBe(200);
}

/** 3 suites of 1000 cases each — the AC's own "a 3000-test run" scale. */
function bigTree(): SuiteNode[] {
  const suites: SuiteNode[] = [];
  for (let s = 0; s < 3; s++) {
    const children = Array.from({ length: 1000 }, (_, i) => ({
      name: `case-${s}-${i}`,
      status: "pass" as const,
      duration_ms: 1,
    }));
    suites.push({ name: `Suite${s}`, status: "pass", children });
  }
  return suites;
}

async function seedBigRun(): Promise<string> {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  const key = await createProject("bounded-reads");
  await registerAgent(key, "bounded-reads-agent");
  const res = await postJson("/api/v2/runs/parsed", {
    projectKey: key,
    agentId: "bounded-reads-agent",
    summary: { total: 3000, passed: 3000, failed: 0, pending: 0, duration_ms: 3000 },
    tree: bigTree(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as RunsParsedResponse;
  return body.event;
}

interface QueryRecord {
  sql: string;
  rows: number;
}

/** Every query the store's OWN connection issues while `body` runs, with the
 *  row count `.all()`/`.get()` actually handed back — never timing. */
async function recordQueries(body: () => Promise<unknown>): Promise<QueryRecord[]> {
  const db = (handle!.store as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  const records: QueryRecord[] = [];
  const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
    const stmt = query(sql) as Statement;
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "all" || prop === "values") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            records.push({ sql, rows: out.length });
            return out;
          };
        }
        if (prop === "get") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            records.push({ sql, rows: out !== null && out !== undefined ? 1 : 0 });
            return out;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }) as typeof db.query);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return records;
}

function rowsFromTable(records: QueryRecord[], table: string): number {
  const re = new RegExp(`\\bFROM\\s+${table}\\b`, "i");
  return records.filter((r) => re.test(r.sql)).reduce((sum, r) => sum + r.rows, 0);
}

describe("progressive run-detail reads stay bounded to what they actually answer", () => {
  test("?depth=suites reads no run_cases row, even on a 3000-test run", async () => {
    const eventId = await seedBigRun();

    let res!: Response;
    const records = await recordQueries(async () => {
      res = await getJson(`/api/v2/events/${eventId}?depth=suites`);
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as EventGetResponse;
    expect((body.event.tree as unknown[]).length).toBe(3);
    // NEGATIVE/bound — exactly zero, not "fewer than before": a `?depth=suites`
    // read has no business touching the cases table at all.
    expect(rowsFromTable(records, "run_cases")).toBe(0);
    expect(rowsFromTable(records, "run_suites")).toBeGreaterThan(0);
  });

  test("?suite= reads only the requested suite's 1000 case rows, not the run's other 2000", async () => {
    const eventId = await seedBigRun();

    let res!: Response;
    const records = await recordQueries(async () => {
      res = await getJson(`/api/v2/events/${eventId}?suite=Suite1`);
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as EventGetResponse;
    const tree = body.event.tree as Array<{ name: string; children: unknown[] }>;
    expect(tree.map((n) => n.name)).toEqual(["Suite1"]);
    expect(tree[0]!.children.length).toBe(1000);
    // POSITIVE, exact bound — 1000 (this suite's own cases), never 3000 (the
    // whole run's).
    expect(rowsFromTable(records, "run_cases")).toBe(1000);
  });
});

describe("the run's raw output rides only the full read", () => {
  test("GET .../events/:id carries raw; ?depth=suites and ?suite= do not", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("raw-only-full-read");
    await registerAgent(key, "raw-agent");
    const rawOutput = "$ bun test\n3 pass\nraw tail";
    const tree: SuiteNode[] = [
      { name: "OnlySuite", status: "pass", children: [{ name: "c1", status: "pass", duration_ms: 1 }] },
    ];
    const ingestRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "raw-agent",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree,
      raw: rawOutput,
    });
    expect(ingestRes.status).toBe(200);
    const { event: eventId } = (await ingestRes.json()) as RunsParsedResponse;

    const full = (await (await getJson(`/api/v2/events/${eventId}`)).json()) as EventGetResponse;
    expect(full.event.raw).toBe(rawOutput);

    const suites = (await (await getJson(`/api/v2/events/${eventId}?depth=suites`)).json()) as EventGetResponse;
    expect("raw" in suites.event).toBe(false);
    expect(suites.event.tree).toEqual([
      { name: "OnlySuite", status: "pass", counts: { passed: 1, failed: 0, pending: 0 } },
    ]);

    const suite = (await (await getJson(`/api/v2/events/${eventId}?suite=OnlySuite`)).json()) as EventGetResponse;
    expect("raw" in suite.event).toBe(false);
    expect((suite.event.tree as unknown[]).length).toBe(1);
  });
});
