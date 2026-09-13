// CR-CRU-129 §S3 — the `cr-merged` read becomes a QUERY, which needs a server
// surface that can answer one.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `cr_merged_crs` (clients/_crucible_axi.py:1692) never asks for `cr-merged`
// records. It asks `GET /api/v2/events?project=<key>&limit=QUEUE_EVENTS_LIMIT`
// and filters the answer client-side, because that route accepts a `limit` and
// nothing else (src/v2.ts:3748). The window counts ALL events, and on this
// project 1,957 of 2,013 rows were telemetry — so the read works by luck, and
// when the luck runs out it returns FEWER cr ids with no error, which is how a
// release ceremony silently loses provenance. §S3's ruling: the constant is
// DELETED, not raised, because a bounded window over unbounded content cannot
// be fixed by choosing a larger bound. Deleting it requires a read that is not
// a window, and no such read exists on the wire yet.
//
// ── The seam GREEN must expose (this suite is written against it) ──────────
//
//   GET /api/v2/projects/<key>/milestones?type=<milestone type>
//        -> {ok, milestones: [{id, kind:"milestone", type, label, timestamp, …}],
//            totalCount}
//
// SHAPE CHOICE, STATED SO GREEN MAY OVERRULE IT. `segments.length === 2` plus a
// collection name is how EVERY project-scoped record read in src/v2.ts is
// already declared — `releases` (src/v2.ts:3657), `release-proposals` (:3673),
// `queue` (:3661) — and `milestones` is the collection these rows now live in.
// Two spellings were equally idiomatic (a `?type=` filter on the flat
// `/api/v2/events` feed was the other); this one is chosen because the feed's
// contract IS recency-plus-limit and §S3 needs a read with no window at all.
// If GREEN rules differently, `milestonesByType` and `recordsOf` below are the
// ONLY two functions that move: every assertion in this file is about
// BEHAVIOUR — which records come back, and whether the project's telemetry
// volume can change the answer — so a different route costs one helper rather
// than the suite.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:`. The live `data/crucible.db` is never opened,
// copied or migrated, and no test in this file talks to the running board.
// Fixture cr ids are drawn from the REGISTERED synthetic namespaces the
// project-namespace tripwire allows (`CR-SHIPPED-*`, `CR-AUTH-*`) — never a
// real board id, which would decay the day the board moves.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

/**
 * The window `QUEUE_EVENTS_LIMIT` scanned, quoted as HISTORY rather than
 * adopted as a limit: it is the number §S3 DELETES. The only thing this suite
 * does with it is build a project that demonstrably exceeds it. Nothing here
 * configures a cap to it, and no assertion treats it as a bound on any answer.
 */
const DELETED_SCAN_WINDOW = 5000;

const AGENT = "cr129-c2-fixture";

interface MilestoneWire {
  id: string;
  kind?: string;
  type?: string;
  label?: string;
  timestamp?: number;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  milestones?: MilestoneWire[];
  events?: MilestoneWire[];
  totalCount?: number;
  project?: { key: string };
  [key: string]: unknown;
}

describe("CR-CRU-129 §S3 — milestone records are QUERYABLE by type, not scannable", () => {
  let handle: ServerHandle | undefined;
  let savedDefaultRetention: string | undefined;

  beforeEach(() => {
    // §S2 left the fallback cap in the operator's environment, read per sweep.
    // This suite needs a project whose telemetry is NOT pruned, and the honest
    // way to arrange that is to configure the real surface to its "no cap"
    // value rather than to pick a big number. An ambient cap would silently
    // shrink the fixture, and the measured assertion in the mutation test
    // below would then fail loudly rather than pass over a small window.
    savedDefaultRetention = process.env.CRUCIBLE_DEFAULT_RETENTION;
    delete process.env.CRUCIBLE_DEFAULT_RETENTION;
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    if (savedDefaultRetention === undefined) {
      delete process.env.CRUCIBLE_DEFAULT_RETENTION;
    } else {
      process.env.CRUCIBLE_DEFAULT_RETENTION = savedDefaultRetention;
    }
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  function base(): string {
    return `http://localhost:${String(handle!.server.port)}`;
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  // ── the ONE route-shape decision, isolated ───────────────────────────────

  function milestonesByType(key: string, type: string): string {
    return `/api/v2/projects/${key}/milestones?type=${encodeURIComponent(type)}`;
  }

  function recordsOf(body: AnyBody): MilestoneWire[] {
    return body.milestones ?? [];
  }

  // ── fixture ──────────────────────────────────────────────────────────────

  async function seedProject(name: string): Promise<string> {
    const res = await fetch(`${base()}/api/v2/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const created = (await res.json()) as AnyBody;
    return created.project!.key;
  }

  function store(): Store {
    return handle!.store;
  }

  function recordMerged(key: string, cr: string): string {
    return store().recordMilestoneEvent(key, AGENT, "cr-merged", { label: cr }).event.id;
  }

  /** One disposable telemetry row, on the production write path. */
  function recordTelemetry(key: string): void {
    store().recordTestEvent(key, AGENT, {
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [],
    });
  }

  /** How many DISPOSABLE rows the capped buffer is actually holding. */
  function disposableHeld(key: string): number {
    return (handle!.store as unknown as { db: Database }).db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events
          WHERE project_key = ? AND kind IN ('test', 'compile', 'lifecycle')`,
      )
      .get(key)!.n;
  }

  /** How many RECORDS are still sitting in the capped buffer (must be zero). */
  function recordsLeftInTheBuffer(key: string): number {
    return (handle!.store as unknown as { db: Database }).db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events
          WHERE project_key = ? AND kind IN ('milestone', 'gate')`,
      )
      .get(key)!.n;
  }

  function labelsOf(records: MilestoneWire[]): string[] {
    return records.flatMap((record) => (record.label === undefined ? [] : [record.label])).sort();
  }

  // ── AC2 — the read is a query by type ────────────────────────────────────

  test("answers with every `cr-merged` record the project holds, and with its label and type on each row", async () => {
    boot();
    const key = await seedProject("cru129-merged-query");
    for (const cr of ["CR-SHIPPED-1", "CR-SHIPPED-2", "CR-SHIPPED-3"]) recordMerged(key, cr);

    const answered = await get(milestonesByType(key, "cr-merged"));

    expect(answered.status).toBe(200);
    expect(answered.body.ok).toBe(true);
    expect(labelsOf(recordsOf(answered.body))).toEqual(["CR-SHIPPED-1", "CR-SHIPPED-2", "CR-SHIPPED-3"]);
    // The two fields `cr_merged_crs` reads off each row. A surface that
    // answered with bare ids would satisfy the labels assertion above only by
    // accident and would be useless to the client, so both are named.
    for (const record of recordsOf(answered.body)) {
      expect(record.type).toBe("cr-merged");
      expect(typeof record.label).toBe("string");
      expect(typeof record.id).toBe("string");
    }
  });

  test("serves the requested type ONLY — a release, a proposal and a stage flip are not `cr-merged`", async () => {
    boot();
    const key = await seedProject("cru129-type-scope");
    recordMerged(key, "CR-SHIPPED-9");
    store().recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.3",
      commit: "abc1234",
      crs: ["CR-SHIPPED-9"],
    });
    store().recordReleaseProposal(key, AGENT, { label: "0.2.0", targetAt: 1_800_000_000 });
    store().recordMilestoneEvent(key, AGENT, "stage-flip", { label: "wave-6" });

    const merged = await get(milestonesByType(key, "cr-merged"));

    expect(labelsOf(recordsOf(merged.body))).toEqual(["CR-SHIPPED-9"]);
    // Bounded: exactly one row came back, so a surface that ignored `type` and
    // returned the whole milestone table fails here rather than passing a
    // "contains what I asked for" check.
    expect(recordsOf(merged.body).length).toBe(1);
    expect(labelsOf(recordsOf(merged.body))).not.toContain("0.1.3");
    expect(labelsOf(recordsOf(merged.body))).not.toContain("0.2.0");

    // …and the same surface answers for another type, so "only cr-merged"
    // above is a filter and not a hardcoded answer.
    const releases = await get(milestonesByType(key, "release"));
    expect(labelsOf(recordsOf(releases.body))).toEqual(["0.1.3"]);
  });

  test("reads the record table, not the capped buffer: it answers while `events` holds no milestone row at all", async () => {
    boot();
    const key = await seedProject("cru129-not-the-buffer");
    recordMerged(key, "CR-SHIPPED-4");

    // The premise, measured rather than assumed: §S1 already moved the write.
    expect(recordsLeftInTheBuffer(key)).toBe(0);

    const answered = await get(milestonesByType(key, "cr-merged"));

    expect(labelsOf(recordsOf(answered.body))).toEqual(["CR-SHIPPED-4"]);
  });

  // ── AC3 — the mutation: past the deleted window ──────────────────────────

  test("a project holding MORE disposable events than the deleted 5,000-event window still yields every `cr-merged` id", async () => {
    boot();
    const key = await seedProject("cru129-over-the-window");
    const merged = ["CR-SHIPPED-1", "CR-SHIPPED-2", "CR-SHIPPED-3", "CR-SHIPPED-4"];
    const ids = merged.map((cr) => recordMerged(key, cr));

    // Bury them under more telemetry than the deleted window could ever have
    // reached. This is the 2026-09-13 shape, at the scale that breaks it.
    for (let i = 0; i <= DELETED_SCAN_WINDOW; i += 1) recordTelemetry(key);

    // NON-VACUITY, MEASURED, AND ASSERTED BEFORE THE SUBJECT so it is reached
    // while the suite is still red: the fixture really did cross the window,
    // and all four records really did survive it. If an ambient cap pruned the
    // telemetry, or a record was evicted, this names which rather than letting
    // the query assertion below fail for an unrelated reason.
    expect(disposableHeld(key)).toBeGreaterThan(DELETED_SCAN_WINDOW);
    expect(ids.map((id) => store().getEvent(id)?.label)).toEqual(merged);
    expect(recordsLeftInTheBuffer(key)).toBe(0);

    const afterTheFlood = await get(milestonesByType(key, "cr-merged"));

    expect(afterTheFlood.status).toBe(200);
    // The whole claim in one line: telemetry volume cannot change this answer.
    expect(labelsOf(recordsOf(afterTheFlood.body))).toEqual([...merged].sort());
  });

  test("the deleted window really does lose those records — the recency feed the client used to scan misses all four", async () => {
    boot();
    const key = await seedProject("cru129-window-loses-them");
    const merged = ["CR-SHIPPED-1", "CR-SHIPPED-2", "CR-SHIPPED-3", "CR-SHIPPED-4"];
    for (const cr of merged) recordMerged(key, cr);
    for (let i = 0; i <= DELETED_SCAN_WINDOW; i += 1) recordTelemetry(key);

    // Exactly the call `cmd_queue` makes today, at exactly its window.
    const scanned = await get(
      `/api/v2/events?project=${key}&limit=${String(DELETED_SCAN_WINDOW)}`,
    );
    const scannedLabels = labelsOf(
      (scanned.body.events ?? []).filter((row) => row.kind === "milestone"),
    );

    // This is the defect, characterised: the window is full of telemetry and
    // the records fell off the end. It is what makes the mutation test above
    // measure something — without it, "the query returned all four" could be
    // true of a scan as well.
    expect(scanned.body.events!.length).toBe(DELETED_SCAN_WINDOW);
    expect(scannedLabels).toEqual([]);
    for (const cr of merged) expect(scannedLabels).not.toContain(cr);
  });

  // ── edges ────────────────────────────────────────────────────────────────

  test("the type is a PARAMETER, not a closed list: a type invented at runtime is queried back by name", async () => {
    boot();
    const key = await seedProject("cru129-open-vocabulary");
    // C1 stored `type` as unconstrained TEXT with no CHECK, so the STORE is
    // already open to a vocabulary nobody compiled in. The query surface must
    // be open on the same terms — it answers "give me the records of THIS
    // type", never "give me the records of one of the types I know about", so
    // it keeps working for a type the server learned after it shipped.
    const invented = "deployment-window";
    store().recordMilestoneEvent(key, AGENT, invented, { label: "window-a" });
    store().recordMilestoneEvent(key, AGENT, invented, { label: "window-b" });
    recordMerged(key, "CR-SHIPPED-9");

    const answered = await get(milestonesByType(key, invented));

    expect(answered.status).toBe(200);
    expect(labelsOf(recordsOf(answered.body))).toEqual(["window-a", "window-b"]);
    // The filter is the caller's string, not a known-type lookup: the
    // `cr-merged` record recorded beside them is excluded, and the invented
    // type is excluded from ITS answer.
    expect(recordsOf(answered.body).every((row) => row.type === invented)).toBe(true);
    const merged = await get(milestonesByType(key, "cr-merged"));
    expect(labelsOf(recordsOf(merged.body))).toEqual(["CR-SHIPPED-9"]);
  });

  test("a type the project has never recorded answers 200 with an empty set, not a 404", async () => {
    boot();
    const key = await seedProject("cru129-unknown-type");
    recordMerged(key, "CR-SHIPPED-9");

    const answered = await get(milestonesByType(key, "design-review"));

    expect(answered.status).toBe(200);
    expect(answered.body.ok).toBe(true);
    expect(recordsOf(answered.body)).toEqual([]);
  });

  test("a projectKey that is not a UUID is refused 400, the way every other project-scoped read refuses one", async () => {
    boot();

    const refused = await get(milestonesByType("not-a-uuid", "cr-merged"));

    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain("projectKey");
  });

  test("one project's records never leak into another's answer", async () => {
    boot();
    const mine = await seedProject("cru129-scope-mine");
    const theirs = await seedProject("cru129-scope-theirs");
    recordMerged(mine, "CR-SHIPPED-11");
    recordMerged(theirs, "CR-SHIPPED-12");

    const answered = await get(milestonesByType(mine, "cr-merged"));

    expect(labelsOf(recordsOf(answered.body))).toEqual(["CR-SHIPPED-11"]);
    expect(labelsOf(recordsOf(answered.body))).not.toContain("CR-SHIPPED-12");
  });
});
