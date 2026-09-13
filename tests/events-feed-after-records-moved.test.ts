// CR-CRU-129 §S3 — the question the CR says §S3 must ANSWER rather than
// inherit: what `GET /api/v2/events` serves once milestone and gate rows leave
// `events`.
//
// ── The answer, and why ───────────────────────────────────────────────────
//
// READ OFF THE CONSUMERS, not off taste. `public/app.js` renders the timeline
// straight out of `state.events`, which is this route's `events[]`: a gate row
// becomes a `GateCardRow`/`GateCardCompact` (app.js:1347), a milestone row
// becomes a milestone card and a `cr-merged` one gets its own branch
// (app.js:1349-1350), and the project's whole gate pane is
// `state.events.filter(e => e.kind === "gate")` (app.js:4478-4482). If the feed
// stopped carrying the two kinds, the gate pane would render empty and the
// merge cards would vanish — with no error anywhere, which is the same silent
// failure mode this CR exists to remove.
//
// So the decision is: THE FEED IS UNCHANGED. It still carries milestones and
// gates; they simply come from the tables they now live in. "Wire shapes do not
// change" is a REQUIREMENT on this route, and this file is where it is asserted
// rather than assumed.
//
// The three halves of that decision, each asserted here:
//   1. the pane feed still renders what it rendered before — both kinds, from
//      their new home, merged into one newest-first window with the SAME limit
//      semantics (the `limit` newest rows overall, not `limit` per table);
//   2. a moved record is still readable BY ID through `GET /api/v2/events/<id>`
//      — including the two rows NO live list serves, a RETIRED gate and a
//      CONSUMED proposal, which is the store's own standing promise;
//   3. the retired-gate exclusion CR-CRU-073 §S1 put on the feed is PRESERVED,
//      not retired: a retired gate stays out of the pane and stays available to
//      the audit read. Explicitly asserted in both directions so the rule is
//      not left ambiguous by the move.
//
// The two project-scoped record ROUTES in §S3's consumer table (`GET …/releases`
// and `GET …/release-proposals`) are asserted here too, because they are wire
// reads and this is the wire file; the STORE-level sites are in
// tests/milestone-record-read-sites.test.ts, one test each.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:`. The live `data/crucible.db` is never opened,
// copied or migrated, and no test in this file talks to the running board.
// Fixture cr ids are drawn from the REGISTERED synthetic namespaces the
// project-namespace tripwire allows (`CR-SHIPPED-*`) — never a real board id.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

const AGENT = "cr129-c2-feed";

interface EventWire {
  id: string;
  kind?: string;
  type?: string;
  label?: string;
  version?: string;
  retiredAt?: number;
  timestamp?: number;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  events?: EventWire[];
  event?: EventWire;
  releases?: Array<Record<string, unknown>>;
  proposals?: Array<Record<string, unknown>>;
  totalCount?: number;
  project?: { key: string };
  [key: string]: unknown;
}

describe("CR-CRU-129 §S3 — what `GET /api/v2/events` serves once the records moved", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
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

  async function seedProject(name: string): Promise<string> {
    const res = await fetch(`${base()}/api/v2/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return ((await res.json()) as AnyBody).project!.key;
  }

  function store(): Store {
    return handle!.store;
  }

  function telemetry(key: string): string {
    return store().recordTestEvent(key, AGENT, {
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [],
    }).id;
  }

  /**
   * The premise every assertion in this file rests on, measured rather than
   * assumed: §S1 already moved the write, so a feed that still read `events`
   * would answer with nothing and each test below would fail for the right
   * reason.
   */
  function expectNoRecordsLeftInTheBuffer(key: string): void {
    const held = (store() as unknown as { db: Database }).db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events
          WHERE project_key = ? AND kind IN ('milestone', 'gate')`,
      )
      .get(key)!.n;
    expect(held).toBe(0);
  }

  function feedIds(body: AnyBody): string[] {
    return (body.events ?? []).map((row) => row.id);
  }

  // ── 1. the pane feed renders what it rendered before ─────────────────────

  test("the pane feed still carries a milestone row, with its type and label, now that milestones are records", async () => {
    boot();
    const key = await seedProject("cru129-feed-milestone");
    const merged = store().recordMilestoneEvent(key, AGENT, "cr-merged", {
      label: "CR-SHIPPED-9",
    }).event;
    expectNoRecordsLeftInTheBuffer(key);

    const feed = await get(`/api/v2/events?project=${key}`);

    const row = (feed.body.events ?? []).find((candidate) => candidate.id === merged.id);
    expect(row).toBeDefined();
    // `public/app.js:1349-1350` branches on exactly these two fields to pick
    // the merge card, so a row arriving without them renders as the wrong
    // thing even though it arrived.
    expect(row!.kind).toBe("milestone");
    expect(row!.type).toBe("cr-merged");
    expect(row!.label).toBe("CR-SHIPPED-9");
  });

  test("the pane feed still carries a gate row, with its gate object, now that gates are records", async () => {
    boot();
    const key = await seedProject("cru129-feed-gate");
    const gate = store().recordGateEvent(key, AGENT, { status: "pass", steps: [] });
    expectNoRecordsLeftInTheBuffer(key);

    const feed = await get(`/api/v2/events?project=${key}`);

    const row = (feed.body.events ?? []).find((candidate) => candidate.id === gate.id);
    expect(row).toBeDefined();
    // `public/app.js:4478-4482` selects the whole gate pane on `kind === "gate"`.
    expect(row!.kind).toBe("gate");
    expect(row!.gate).toEqual({ status: "pass", steps: [] });
  });

  test("`limit` still means the N NEWEST rows across telemetry and records together, not N per table", async () => {
    boot();
    const key = await seedProject("cru129-feed-limit");
    const oldest = telemetry(key);
    const second = telemetry(key);
    const milestone = store().recordMilestoneEvent(key, AGENT, "stage-flip", {
      label: "wave-6",
    }).event.id;
    const newest = store().recordGateEvent(key, AGENT, { status: "pass" }).id;
    expectNoRecordsLeftInTheBuffer(key);

    const feed = await get(`/api/v2/events?project=${key}&limit=3`);

    // BOUNDED, and in order: a feed that took 3 from each of the three tables
    // would answer with 4 rows, and one that lost the cross-table ordering
    // would put the telemetry first. Both fail here.
    expect(feedIds(feed.body)).toEqual([newest, milestone, second]);
    expect(feedIds(feed.body)).not.toContain(oldest);
  });

  // ── 2. a moved record is still readable BY ID ────────────────────────────

  test("a moved milestone record is still served by `GET /api/v2/events/<id>`", async () => {
    boot();
    const key = await seedProject("cru129-byid-milestone");
    const merged = store().recordMilestoneEvent(key, AGENT, "cr-merged", {
      label: "CR-SHIPPED-5",
    }).event;
    expectNoRecordsLeftInTheBuffer(key);

    const audit = await get(`/api/v2/events/${merged.id}`);

    expect(audit.status).toBe(200);
    expect(audit.body.event!.id).toBe(merged.id);
    expect(audit.body.event!.kind).toBe("milestone");
    expect(audit.body.event!.label).toBe("CR-SHIPPED-5");
  });

  test("a moved gate record is still served by `GET /api/v2/events/<id>`", async () => {
    boot();
    const key = await seedProject("cru129-byid-gate");
    const gate = store().recordGateEvent(key, AGENT, { status: "fail" }, { version: "0.2.0" });
    expectNoRecordsLeftInTheBuffer(key);

    const audit = await get(`/api/v2/events/${gate.id}`);

    expect(audit.status).toBe(200);
    expect(audit.body.event!.id).toBe(gate.id);
    expect(audit.body.event!.kind).toBe("gate");
    expect(audit.body.event!.version).toBe("0.2.0");
  });

  test("an id no table holds still 404s — the by-id read did not become a silent empty", async () => {
    boot();
    await seedProject("cru129-byid-missing");

    const missing = await get("/api/v2/events/evt-1700000000000-9999");

    expect(missing.status).toBe(404);
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error).toContain("evt-1700000000000-9999");
  });

  // ── 3. the retired-gate exclusion is PRESERVED, in both directions ───────

  test("a gate retired by its release is EXCLUDED from the pane feed and STILL readable by id", async () => {
    boot();
    const key = await seedProject("cru129-retired-gate");
    const gate = store().recordGateEvent(key, AGENT, { status: "pass" }, { version: "0.1.3" });
    const live = await get(`/api/v2/events?project=${key}`);
    // The gate IS in the feed before the release retires it — so the exclusion
    // below is the release's doing and not an artefact of the move.
    expect(feedIds(live.body)).toContain(gate.id);

    store().recordMilestoneEvent(key, AGENT, "release", { label: "0.1.3", commit: "abc1234" });
    expectNoRecordsLeftInTheBuffer(key);

    const afterRelease = await get(`/api/v2/events?project=${key}`);
    expect(feedIds(afterRelease.body)).not.toContain(gate.id);

    const audit = await get(`/api/v2/events/${gate.id}`);
    expect(audit.status).toBe(200);
    expect(audit.body.event!.id).toBe(gate.id);
    expect(typeof audit.body.event!.retiredAt).toBe("number");
  });

  test("a CONSUMED release proposal leaves the live list and stays readable by id — the store's standing promise", async () => {
    boot();
    const key = await seedProject("cru129-consumed-proposal");
    const proposal = store().recordReleaseProposal(key, AGENT, {
      label: "0.1.3",
      targetAt: 1_800_000_000,
    }).event;
    const beforeShipping = await get(`/api/v2/projects/${key}/release-proposals`);
    expect(
      (beforeShipping.body.proposals ?? []).map((row) => row.label as string),
    ).toEqual(["0.1.3"]);

    store().recordMilestoneEvent(key, AGENT, "release", { label: "0.1.3", commit: "def5678" });
    expectNoRecordsLeftInTheBuffer(key);

    const afterShipping = await get(`/api/v2/projects/${key}/release-proposals`);
    expect(afterShipping.body.proposals).toEqual([]);

    const audit = await get(`/api/v2/events/${proposal.id}`);
    expect(audit.status).toBe(200);
    expect(audit.body.event!.type).toBe("release-proposal");
    expect(audit.body.event!.label).toBe("0.1.3");
  });

  // ── §S3 consumer table — the two record ROUTES ───────────────────────────

  test("§S3 site — `GET …/projects/<key>/releases` answers from the record table", async () => {
    boot();
    const key = await seedProject("cru129-site-releases");
    store().recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.3",
      commit: "abc1234",
      crs: ["CR-SHIPPED-3", "CR-SHIPPED-4"],
    });
    expectNoRecordsLeftInTheBuffer(key);

    const answered = await get(`/api/v2/projects/${key}/releases`);

    expect(answered.status).toBe(200);
    expect(answered.body.releases!.length).toBe(1);
    const brief = { ...answered.body.releases![0]! };
    // The ingest instant is the one value a fixture cannot name; every OTHER
    // key is pinned, so a dropped `crs` or a renamed `version` fails here.
    expect(typeof brief.timestamp).toBe("number");
    delete brief.timestamp;
    expect(brief).toEqual({
      version: "0.1.3",
      commit: "abc1234",
      crs: ["CR-SHIPPED-3", "CR-SHIPPED-4"],
    });
  });

  test("§S3 site — `GET …/projects/<key>/release-proposals` answers from the record table", async () => {
    boot();
    const key = await seedProject("cru129-site-proposals");
    store().recordReleaseProposal(key, AGENT, { label: "0.2.0", targetAt: 1_800_000_000 });
    expectNoRecordsLeftInTheBuffer(key);

    const answered = await get(`/api/v2/projects/${key}/release-proposals`);

    expect(answered.status).toBe(200);
    expect((answered.body.proposals ?? []).map((row) => row.label as string)).toEqual(["0.2.0"]);
    expect(answered.body.totalCount).toBe(1);
  });
});
