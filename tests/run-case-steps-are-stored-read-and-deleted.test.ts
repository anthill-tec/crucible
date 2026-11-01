// A test's steps are stored under it, read back, and removed with its run:
//  - a closed `crucible-events` stream (and `/runs/parsed`) stores each
//    test's steps in a `run_case_steps` table, in order;
//  - the full read (`GET /api/v2/events/<id>`) and the one-suite read
//    (`?suite=<s>&browser=<b>`, `Store#getEventSuite`) answer each test's
//    steps; `?depth=suites` (`Store#getEventSuites`) reads no step row —
//    proved as the existing zero-row reads prove theirs, by recording every
//    query the store's own connection issues and the rows each handed back;
//  - a suite's stored counts count its tests, never its steps;
//  - every path that removes a run removes its steps: `Store#deleteEvent`
//    (`deleteRunDetail`), `Store#clearEvents` (`deleteProjectRunDetail`) and
//    the milestone and gate move (`migrateMilestoneRecords`' `dropDetail`);
//  - `/runs/parsed` takes a leaf's `steps` under the rules a leaf follows, and
//    refuses an ill-formed one with a 400 that stores nothing;
//  - `feature`: a suite of a run whose framework is `playwright-bdd` stores
//    its own name as its feature; a run of any other framework keeps the
//    split at the first ` › `.
//
// Interface choices (stated for the orchestrator's ruling):
//  - the step row's columns are `event_id`, `suite_position`,
//    `case_position`, `position`, `name`, `status`, `duration_ms`,
//    `has_failure`, `failure_message`, `failure_type`, `failure_trace` —
//    `run_cases`' own, with the case's position beside its suite's; the
//    queries below read `suite_position`, `case_position` and `position`;
//  - `TestLeaf.steps` is `TestStep[]`, a step being `{name, status,
//    duration_ms, failure?}`; a test with no steps answers no `steps` key.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import { Store, migrateMilestoneRecords } from "../src/store.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (stores.length > 0) dbOf(stores.pop() as Store).close();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

const AGENT = "steps-runner";

// ── The stream every read test stores ───────────────────────────────────────

const CARD_STEPS = [
  { name: "Given a cart holding one book", status: "pass", duration_ms: 10 },
  { name: "When I pay by card", status: "pass", duration_ms: 15 },
  { name: "Then I see a receipt", status: "pass", duration_ms: 5 },
];

const CARD_FAILING_STEPS = [
  { name: "Given a cart holding two books", status: "pass", duration_ms: 10 },
  { name: "When I pay by card again", status: "pass", duration_ms: 20 },
  {
    name: "Then I see a second receipt",
    status: "fail",
    duration_ms: 10,
    failure: { message: "receipt missing", type: "AssertionError" },
  },
];

const VOUCHER_STEPS = [
  { name: "Given a voucher worth ten", status: "pass", duration_ms: 4 },
  { name: "When I redeem it", status: "pass", duration_ms: 6 },
];

const STEPS_STREAM =
  eventLine({ event: "run-start", total: 3 }) +
  eventLine({
    event: "test-end",
    id: "card-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 30,
    steps: CARD_STEPS,
  }) +
  eventLine({
    event: "test-end",
    id: "card-firefox",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "firefox",
    status: "fail",
    duration_ms: 40,
    failure: { message: "receipt missing" },
    steps: CARD_FAILING_STEPS,
  }) +
  eventLine({
    event: "test-end",
    id: "voucher-chromium",
    name: "Pay by voucher",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 10,
    steps: VOUCHER_STEPS,
  }) +
  eventLine({ event: "run-end", total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 });

const CHROMIUM_SUITE = {
  name: "Checkout",
  status: "pass",
  browser: "chromium",
  children: [
    { name: "Pay by card", status: "pass", duration_ms: 30, steps: CARD_STEPS },
    { name: "Pay by voucher", status: "pass", duration_ms: 10, steps: VOUCHER_STEPS },
  ],
};

const FIREFOX_SUITE = {
  name: "Checkout",
  status: "fail",
  browser: "firefox",
  children: [
    {
      name: "Pay by card",
      status: "fail",
      duration_ms: 40,
      failure: { message: "receipt missing" },
      steps: CARD_FAILING_STEPS,
    },
  ],
};

/** Every stored step name of a run, in suite, case and step order. */
const STORED_STEP_ORDER = [
  "Given a cart holding one book",
  "When I pay by card",
  "Then I see a receipt",
  "Given a voucher worth ten",
  "When I redeem it",
  "Given a cart holding two books",
  "When I pay by card again",
  "Then I see a second receipt",
];

/** A run opened, streamed and closed over HTTP; answers the event it stored. */
async function streamedRun(
  handle: ServerHandle,
  text: string,
  start: Record<string, unknown> = { stack: "bun", framework: "playwright-bdd" },
): Promise<{ key: string; eventId: string }> {
  const key = await readyProject(handle, [AGENT], "steps-subject");
  const runId = await openRun(handle, key, AGENT, start);
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(typeof closed.body.event).toBe("string");
  return { key, eventId: closed.body.event as string };
}

function stepNamesOf(db: Database, eventId: string): string[] {
  return db
    .query<{ name: string }, [string]>(
      `SELECT name FROM run_case_steps WHERE event_id = ? ORDER BY suite_position, case_position, position`,
    )
    .all(eventId)
    .map((row) => row.name);
}

function stepRowCount(db: Database, eventId: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM run_case_steps WHERE event_id = ?`).get(eventId)?.n ?? -1;
}

// ── Query recording, as the existing zero-row read tests record ─────────────

interface QueryRecord {
  sql: string;
  rows: number;
}

/** Every query the store's own connection issues while `body` runs, with the rows `.all()`/`.get()` handed back. */
async function recordQueries(store: Store, body: () => Promise<unknown>): Promise<QueryRecord[]> {
  const db = dbOf(store);
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

// ── Storage and the reads ───────────────────────────────────────────────────

describe("run_case_steps stores a test's steps, and the full and one-suite reads answer them", () => {
  test("a closed stream's steps are stored in order, and the full read answers every test's steps under its feature and browser", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);

    const detail = await getJson(handle, `/api/v2/events/${eventId}`);
    const event = detail.event as Record<string, unknown>;
    expect(event.tree).toEqual([CHROMIUM_SUITE, FIREFOX_SUITE]);
    expect(event.summary).toEqual({ total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 });

    expect(stepNamesOf(dbOf(handle.store), eventId)).toEqual(STORED_STEP_ORDER);
  });

  test("a stored failing step keeps its failure, and a stored passing step answers no failure key", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);

    const rows = dbOf(handle.store)
      .query<{ name: string; status: string; duration_ms: number; has_failure: number; failure_message: string | null; failure_type: string | null }, [string]>(
        `SELECT name, status, duration_ms, has_failure, failure_message, failure_type FROM run_case_steps
          WHERE event_id = ? AND suite_position = 1 AND case_position = 0 ORDER BY position`,
      )
      .all(eventId);
    expect(rows).toEqual([
      { name: "Given a cart holding two books", status: "pass", duration_ms: 10, has_failure: 0, failure_message: null, failure_type: null },
      { name: "When I pay by card again", status: "pass", duration_ms: 20, has_failure: 0, failure_message: null, failure_type: null },
      {
        name: "Then I see a second receipt",
        status: "fail",
        duration_ms: 10,
        has_failure: 1,
        failure_message: "receipt missing",
        failure_type: "AssertionError",
      },
    ]);

    const detail = await getJson(handle, `/api/v2/events/${eventId}`);
    const tree = (detail.event as { tree: Array<{ children: Array<{ steps?: Array<Record<string, unknown>> }> }> }).tree;
    expect(tree[1]?.children[0]?.steps?.[0]).not.toHaveProperty("failure");
  });

  test("?suite=Checkout&browser=firefox answers that browser's suite alone, its test carrying its steps; &browser=chromium answers the other", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);

    const firefox = await getJson(handle, `/api/v2/events/${eventId}?suite=Checkout&browser=firefox`);
    expect((firefox.event as Record<string, unknown>).tree).toEqual([FIREFOX_SUITE]);

    const chromium = await getJson(handle, `/api/v2/events/${eventId}?suite=Checkout&browser=chromium`);
    expect((chromium.event as Record<string, unknown>).tree).toEqual([CHROMIUM_SUITE]);
  });

  test("Store#getEventSuite answers the named suite under the named browser with its tests' steps", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);

    const read = handle.store.getEventSuite(eventId, "Checkout", "firefox");
    expect(read?.suite as unknown).toEqual(FIREFOX_SUITE);
  });

  test("?depth=suites lists one suite per browser with counts of its tests, never its steps, and reads no run_case_steps row", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);
    // The steps are stored, so a zero below is never a read of an empty table.
    expect(stepRowCount(dbOf(handle.store), eventId)).toBe(STORED_STEP_ORDER.length);

    let body!: Record<string, unknown>;
    const records = await recordQueries(handle.store, async () => {
      body = await getJson(handle, `/api/v2/events/${eventId}?depth=suites`);
    });

    expect((body.event as Record<string, unknown>).tree).toEqual([
      { name: "Checkout", status: "pass", browser: "chromium", counts: { passed: 2, failed: 0, pending: 0 } },
      { name: "Checkout", status: "fail", browser: "firefox", counts: { passed: 0, failed: 1, pending: 0 } },
    ]);
    // NEGATIVE/bound — exactly zero step rows: a suites read has no business with steps.
    expect(rowsFromTable(records, "run_case_steps")).toBe(0);
    expect(rowsFromTable(records, "run_suites")).toBeGreaterThan(0);
  });

  test("Store#getEventSuites reads no run_case_steps row and its suites carry no children", async () => {
    const handle = boot();
    const { eventId } = await streamedRun(handle, STEPS_STREAM);
    expect(stepRowCount(dbOf(handle.store), eventId)).toBe(STORED_STEP_ORDER.length);

    const reads: Array<ReturnType<Store["getEventSuites"]>> = [];
    const records = await recordQueries(handle.store, async () => {
      reads.push(handle.store.getEventSuites(eventId));
    });

    expect(reads[0]?.suites?.map((suite) => [suite.browser, suite.counts])).toEqual([
      ["chromium", { passed: 2, failed: 0, pending: 0 }],
      ["firefox", { passed: 0, failed: 1, pending: 0 }],
    ]);
    expect(rowsFromTable(records, "run_case_steps")).toBe(0);
  });
});

// ── Every delete path ───────────────────────────────────────────────────────

/** A tree of one suite whose two tests carry two and one steps. */
function treeWithSteps(prefix: string): SuiteNode[] {
  return [
    {
      name: `${prefix} feature`,
      status: "fail",
      browser: "chromium",
      children: [
        {
          name: `${prefix} scenario one`,
          status: "pass",
          duration_ms: 3,
          steps: [
            { name: `${prefix} given`, status: "pass", duration_ms: 1 },
            { name: `${prefix} then`, status: "pass", duration_ms: 2 },
          ],
        },
        {
          name: `${prefix} scenario two`,
          status: "fail",
          duration_ms: 4,
          failure: { message: "nope" },
          steps: [{ name: `${prefix} when`, status: "fail", duration_ms: 4, failure: { message: "nope" } }],
        },
      ],
    },
  ] as unknown as SuiteNode[];
}

const TREE_SUMMARY = { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 };

function storeWithProject(name: string): { store: Store; key: string } {
  const store = Store.open(":memory:");
  stores.push(store);
  const key = crypto.randomUUID();
  store.addProject({ key, name, type: "backend", sutRoot: `/tmp/${name}` });
  return { store, key };
}

function recordStepRun(store: Store, key: string, prefix: string): string {
  return store.recordTestEvent(
    key,
    AGENT,
    { summary: TREE_SUMMARY, tree: treeWithSteps(prefix) },
    { tier: "bdd", framework: "playwright-bdd" },
  ).id;
}

describe("every delete path removes a run's steps", () => {
  test("Store#deleteEvent removes the deleted run's step rows and leaves another run's", () => {
    const { store, key } = storeWithProject("delete-one");
    const doomed = recordStepRun(store, key, "doomed");
    const kept = recordStepRun(store, key, "kept");
    const db = dbOf(store);
    expect(stepRowCount(db, doomed)).toBe(3);
    expect(stepRowCount(db, kept)).toBe(3);

    expect(store.deleteEvent(doomed, key)).toBe(true);

    expect(stepRowCount(db, doomed)).toBe(0);
    expect(stepRowCount(db, kept)).toBe(3);
  });

  test("Store#clearEvents removes the step rows of every run of the project and leaves another project's", () => {
    const { store, key } = storeWithProject("clear-all");
    const other = crypto.randomUUID();
    store.addProject({ key: other, name: "kept-project", type: "backend", sutRoot: "/tmp/kept-project" });
    const first = recordStepRun(store, key, "first");
    const second = recordStepRun(store, key, "second");
    const kept = recordStepRun(store, other, "kept");
    const db = dbOf(store);
    expect([stepRowCount(db, first), stepRowCount(db, second), stepRowCount(db, kept)]).toEqual([3, 3, 3]);

    store.clearEvents(key);

    expect([stepRowCount(db, first), stepRowCount(db, second), stepRowCount(db, kept)]).toEqual([0, 0, 3]);
  });

  test("the milestone and gate move (migrateMilestoneRecords) leaves no step row of a moved record behind", () => {
    const { store, key } = storeWithProject("record-move");
    const moved = recordStepRun(store, key, "moved");
    const kept = recordStepRun(store, key, "kept");
    const db = dbOf(store);
    expect(stepRowCount(db, moved)).toBe(3);
    // A record still held in `events`, as a store from before the move holds one.
    db.query(`UPDATE events SET kind = 'milestone' WHERE id = ?`).run(moved);

    const report = migrateMilestoneRecords(db);

    expect(report.tally.moved).toBe(1);
    expect(stepRowCount(db, moved)).toBe(0);
    expect(stepRowCount(db, kept)).toBe(3);
  });
});

// ── /runs/parsed ────────────────────────────────────────────────────────────

/** A parsed-run body whose one test carries `steps`. */
function parsedBody(key: string, steps: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectKey: key,
    agentId: AGENT,
    summary: { total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 9 },
    tree: [
      {
        name: "Account",
        status: "fail",
        browser: "webkit",
        children: [
          { name: "Change my password", status: "fail", duration_ms: 9, failure: { message: "still old" }, steps },
        ],
      },
    ],
    ...extra,
  };
}

const PARSED_STEPS = [
  { name: "Given I am signed in", status: "pass", duration_ms: 2 },
  { name: "When I change my password", status: "pass", duration_ms: 3 },
  { name: "Then the new one works", status: "fail", duration_ms: 4, failure: { message: "still old", type: "AssertionError" } },
];

describe("/runs/parsed takes a leaf's steps", () => {
  test("a parsed run's steps are stored in order and the full read answers them", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "parsed-steps");

    const res = await postJson(handle, "/api/v2/runs/parsed", parsedBody(key, PARSED_STEPS));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const eventId = res.body.event as string;

    const detail = await getJson(handle, `/api/v2/events/${eventId}`);
    expect((detail.event as Record<string, unknown>).tree).toEqual([
      {
        name: "Account",
        status: "fail",
        browser: "webkit",
        children: [
          { name: "Change my password", status: "fail", duration_ms: 9, failure: { message: "still old" }, steps: PARSED_STEPS },
        ],
      },
    ]);
    expect(stepNamesOf(dbOf(handle.store), eventId)).toEqual(PARSED_STEPS.map((step) => step.name));
  });

  const REFUSED: ReadonlyArray<[string, unknown]> = [
    ["steps is a string", "Given I am signed in"],
    ["steps is an object, not an array", { name: "Given I am signed in", status: "pass", duration_ms: 1 }],
    ["a step is not an object", ["Given I am signed in"]],
    ["a step's name is not a string", [{ name: 5, status: "pass", duration_ms: 1 }]],
    ["a step's status is outside pass, fail, pending", [{ name: "Given I am signed in", status: "skipped", duration_ms: 1 }]],
    ["a step's duration_ms is a string", [{ name: "Given I am signed in", status: "pass", duration_ms: "1" }]],
    ["a step's failure is a string", [{ name: "Then it works", status: "fail", duration_ms: 1, failure: "boom" }]],
    ["a step's failure part is not a string", [{ name: "Then it works", status: "fail", duration_ms: 1, failure: { type: 5 } }]],
  ];

  for (const [why, steps] of REFUSED) {
    test(`a parsed run is refused 400 and stores nothing when ${why}`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "parsed-refused");
      const before = handle.store.countEvents(key);

      const res = await postJson(handle, "/api/v2/runs/parsed", parsedBody(key, steps));

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(handle.store.countEvents(key)).toBe(before);
    });
  }
});

// ── feature ─────────────────────────────────────────────────────────────────

function featuresOf(db: Database, eventId: string): Array<[string, string | null]> {
  return db
    .query<{ name: string; feature: string | null }, [string]>(
      `SELECT name, feature FROM run_suites WHERE event_id = ? ORDER BY position`,
    )
    .all(eventId)
    .map((row) => [row.name, row.feature]);
}

describe("a playwright-bdd suite stores its own name as its feature", () => {
  test("a streamed playwright-bdd run's suites store their whole names as features, a ' › ' inside one included", async () => {
    const handle = boot();
    const text =
      eventLine({ event: "test-end", name: "Pay by card", suite: "Checkout", browser: "chromium", status: "pass", duration_ms: 1, steps: [{ name: "Given a cart", status: "pass", duration_ms: 1 }] }) +
      eventLine({ event: "test-end", name: "Change my password", suite: "Account › Settings", browser: "chromium", status: "pass", duration_ms: 1, steps: [{ name: "Given I am signed in", status: "pass", duration_ms: 1 }] }) +
      eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0 });
    const { eventId } = await streamedRun(handle, text);

    expect(featuresOf(dbOf(handle.store), eventId)).toEqual([
      ["Checkout", "Checkout"],
      ["Account › Settings", "Account › Settings"],
    ]);
  });

  test("a parsed playwright-bdd run's suite stores its own name as its feature, while a run of no framework and one of another keep the split", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "feature-split");
    const suite = (name: string): Record<string, unknown> => ({
      name,
      status: "pass",
      children: [{ name: "a scenario", status: "pass", duration_ms: 1 }],
    });
    const post = async (tree: unknown[], extra: Record<string, unknown>): Promise<string> => {
      const res = await postJson(handle, "/api/v2/runs/parsed", {
        projectKey: key,
        agentId: AGENT,
        summary: { total: tree.length, passed: tree.length, failed: 0, pending: 0, duration_ms: 1 },
        tree,
        ...extra,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.event as string;
    };

    const bdd = await post([suite("Account › Settings"), suite("Checkout")], { framework: "playwright-bdd" });
    const plain = await post([suite("Account › Settings"), suite("Checkout")], {});
    const other = await post([suite("Account › Settings")], { framework: "playwright" });
    const db = dbOf(handle.store);

    expect(featuresOf(db, bdd)).toEqual([
      ["Account › Settings", "Account › Settings"],
      ["Checkout", "Checkout"],
    ]);
    expect(featuresOf(db, plain)).toEqual([
      ["Account › Settings", "Account"],
      ["Checkout", null],
    ]);
    expect(featuresOf(db, other)).toEqual([["Account › Settings", "Account"]]);
  });
});
