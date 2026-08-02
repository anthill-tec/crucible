// CR-CRU-057 §S4 — one-time LABELED backfill (user-decided 2026-08-01).
//
// §S1 (event-phase-stamping.test.ts) already made every NEW run/lifecycle
// event stamp the posting agent's DECLARED phase, with `phase_inferred`
// always 0 on that write path — `phase_inferred = 1` is written NOWHERE in
// production yet. §S4 is the ONE place it is allowed to appear: a migration
// that backfills `events.phase` for PRE-EXISTING rows whose agent-id suffix
// parses to a valid phase enum member (mirroring the retired CR-CRU-007
// `phaseRole(agentId)` suffix contract: a `-RED`/`-GREEN`/`-FIX`/`-VERIFY`
// suffix, case-insensitive), setting `phase_inferred = 1`. Unparseable ids
// stay NULL and render unclassified — no guessing at render time, ever.
// The backfill must be additive (never touches an already-declared row) and
// idempotent (running it again is a no-op).
//
// RED phase: NONE of this exists in production yet (src/store.ts has no
// backfill/sweep logic at all — grep confirms `phase_inferred` is only ever
// written as 0 or NULL on the ingest path, src/store.ts:1134). Every
// assertion below that a NULL/parseable-id row gets backfilled fails today
// because nothing writes phase_inferred = 1 anywhere.
//
// Harness: raw bun:sqlite fixture matching the CURRENT production `events`
// schema (src/store.ts:318-342 — phase/phase_inferred already exist, C1
// shipped that ALTER TABLE) with rows seeded directly with phase/
// phase_inferred values, so the fixture models a server that has been
// running post-C1 with historical (pre-057, still-NULL) rows sitting
// alongside already-declared ones — exactly the mixed state §S4's backfill
// must reconcile. This is deliberately NOT the pre-C1 (no phase column at
// all) legacy-db convention tests/agent-phase.test.ts uses for ITS
// migration (that ALTER already shipped and ran; §S4 is a distinct,
// later migration step against rows the ALTER already created as NULL).
// Fresh OS tmpdir per test (never inside the repo), same convention as
// tests/agent-phase.test.ts / tests/checkpoint-stop.test.ts.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import type { RunEvent } from "../src/types.ts";

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crucible-event-phase-backfill-test-"));
}

interface SeedRow {
  id: string;
  agentId: string;
  phase: string | null;
  phaseInferred: number | null;
}

/**
 * Builds a raw sqlite file at `dbPath` with the CURRENT production `events`
 * schema (byte-for-byte src/store.ts:318-342, hand-copied rather than
 * driven through the Store class so the backfill assertions hold
 * regardless of what src/store.ts currently does) and inserts `rows`
 * directly — bypassing Store.recordTestEvent entirely so `phase` /
 * `phase_inferred` land EXACTLY as specified, including the pre-migration
 * NULL/NULL state §S4 must reconcile.
 */
function seedEventsDb(dbPath: string, projectKey: string, rows: SeedRow[]): void {
  const raw = new Database(dbPath, { create: true });
  raw.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      tier TEXT NOT NULL,
      stack TEXT,
      codec TEXT,
      timestamp INTEGER NOT NULL,
      name TEXT,
      total INTEGER,
      passed INTEGER,
      failed INTEGER,
      pending INTEGER,
      duration_ms INTEGER,
      tree TEXT,
      coverage TEXT,
      compile TEXT,
      context TEXT,
      action TEXT,
      first_seen INTEGER,
      payload TEXT,
      phase TEXT,
      phase_inferred INTEGER
    );
  `);
  let ts = Date.now();
  for (const row of rows) {
    raw
      .query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, phase, phase_inferred)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, projectKey, row.agentId, "test", "unit", ts++, row.phase, row.phaseInferred);
  }
  raw.close();
}

/** Raw read of one row's (phase, phase_inferred) straight from the db file, bypassing Store.toEvent. */
function rawPhaseRow(
  store: Store,
  id: string,
): { phase: string | null; phase_inferred: number | null } {
  const row = (store as unknown as { db: Database }).db
    .query<{ phase: string | null; phase_inferred: number | null }, [string]>(
      `SELECT phase, phase_inferred FROM events WHERE id = ?`,
    )
    .get(id);
  expect(row).not.toBeNull();
  return row!;
}

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

function findByAgent(events: RunEvent[], agentId: string): RunEvent | undefined {
  return events.find((e) => e.agentId === agentId);
}

describe("CR-CRU-057 §S4 — one-time labeled backfill", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  describe("parseable suffixes are backfilled, labeled", () => {
    test("agent ids ending -RED/-GREEN/-FIX/-VERIFY (case-insensitive) each backfill to the matching phase enum member with phase_inferred = 1", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "parseable.db");
      const projectKey = crypto.randomUUID();
      seedEventsDb(dbPath, projectKey, [
        { id: "evt-red", agentId: "CR-BF-1-RED", phase: null, phaseInferred: null },
        { id: "evt-green", agentId: "cr-bf-2-green", phase: null, phaseInferred: null },
        { id: "evt-fix", agentId: "CR-BF-3-Fix", phase: null, phaseInferred: null },
        { id: "evt-verify", agentId: "cr-bf-4-VERIFY", phase: null, phaseInferred: null },
      ]);

      const store = Store.open(dbPath);
      try {
        const events = store.listEvents(projectKey, 100);
        expect(events.length).toBe(4);

        const red = findByAgent(events, "CR-BF-1-RED");
        expect(red).toBeDefined();
        expect(red!.phase).toBe("RED");
        expect(red!.phaseInferred).toBe(true);

        const green = findByAgent(events, "cr-bf-2-green");
        expect(green).toBeDefined();
        expect(green!.phase).toBe("GREEN");
        expect(green!.phaseInferred).toBe(true);

        const fix = findByAgent(events, "CR-BF-3-Fix");
        expect(fix).toBeDefined();
        expect(fix!.phase).toBe("FIX");
        expect(fix!.phaseInferred).toBe(true);

        const verify = findByAgent(events, "cr-bf-4-VERIFY");
        expect(verify).toBeDefined();
        expect(verify!.phase).toBe("VERIFY");
        expect(verify!.phaseInferred).toBe(true);
      } finally {
        closeStore(store);
      }
    });
  });

  describe("unparseable ids stay NULL — no guessing, ever", () => {
    // Deliberately seeded ALONGSIDE a parseable row in the SAME db (rather
    // than an unparseable-only fixture, which would pass vacuously today —
    // nothing writes phase_inferred at all yet, so "stays NULL" would be
    // trivially true against a no-op). Mixing in "CR-BF-MIX-1-GREEN" makes
    // this test's own migration-ran assertion fail today for the right
    // reason, while still pinning the unparseable negative contract.
    test("ids that were negative cases under the retired phaseRole contract (claude-sandesh, plain-agent-1, redteam-agent, fixture-agent, greenhouse-bot) keep phase NULL and render unclassified, even while a parseable sibling row in the SAME db gets backfilled", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "unparseable.db");
      const projectKey = crypto.randomUUID();
      const unparseableIds = [
        "claude-sandesh",
        "plain-agent-1",
        "redteam-agent",
        "fixture-agent",
        "greenhouse-bot",
      ];
      const parseableId = "CR-BF-MIX-1-GREEN";
      seedEventsDb(dbPath, projectKey, [
        ...unparseableIds.map((agentId, i) => ({
          id: `evt-unparseable-${i}`,
          agentId,
          phase: null,
          phaseInferred: null,
        })),
        { id: "evt-mix-parseable", agentId: parseableId, phase: null, phaseInferred: null },
      ]);

      const store = Store.open(dbPath);
      try {
        const events = store.listEvents(projectKey, 100);
        expect(events.length).toBe(unparseableIds.length + 1);

        // Proves the migration actually executed against this db (not
        // skipped/no-op) — the parseable sibling gets backfilled labeled.
        const mixed = findByAgent(events, parseableId);
        expect(mixed).toBeDefined();
        expect(mixed!.phase).toBe("GREEN");
        expect(mixed!.phaseInferred).toBe(true);

        for (const agentId of unparseableIds) {
          const event = findByAgent(events, agentId);
          expect(event).toBeDefined();
          // POSITIVE — unclassified: no `phase` key at all (toEvent only
          // attaches phase/phaseInferred when row.phase !== null), matching
          // the "render unclassified" contract — never a fabricated guess.
          expect(event!.phase).toBeUndefined();
          expect(event!.phaseInferred).toBeUndefined();

          // NEGATIVE bound, at the raw row level too — explicitly NULL in
          // BOTH columns, never flipped to 0/false (which would read as
          // "declared nothing" rather than "never processed").
          const raw = rawPhaseRow(store, `evt-unparseable-${unparseableIds.indexOf(agentId)}`);
          expect(raw.phase).toBeNull();
          expect(raw.phase_inferred).toBeNull();
        }
      } finally {
        closeStore(store);
      }
    });
  });

  describe("idempotent — running the migration twice is a no-op", () => {
    test("opening the store twice against the same file leaves phase/phase_inferred identical the second time (no double-write, no row flipped)", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "idempotent.db");
      const projectKey = crypto.randomUUID();
      seedEventsDb(dbPath, projectKey, [
        { id: "evt-idem-red", agentId: "CR-BF-IDEM-RED", phase: null, phaseInferred: null },
        { id: "evt-idem-unparseable", agentId: "plain-agent-1", phase: null, phaseInferred: null },
      ]);

      const store1 = Store.open(dbPath);
      const first = store1.listEvents(projectKey, 100).map((e) => ({
        agentId: e.agentId,
        phase: e.phase ?? null,
        phaseInferred: e.phaseInferred ?? null,
      }));
      closeStore(store1);

      const store2 = Store.open(dbPath);
      try {
        const second = store2.listEvents(projectKey, 100).map((e) => ({
          agentId: e.agentId,
          phase: e.phase ?? null,
          phaseInferred: e.phaseInferred ?? null,
        }));

        // Same row count — the second open never inserted/duplicated rows.
        expect(second.length).toBe(first.length);
        expect(second.length).toBe(2);

        // Identical content — no re-processing changed a value the second
        // time around (a naive re-run that flips things twice, or a
        // counter that increments phase_inferred past 1, would fail here).
        const sortByAgent = (arr: typeof first) =>
          [...arr].sort((a, b) => a.agentId.localeCompare(b.agentId));
        expect(sortByAgent(second)).toEqual(sortByAgent(first));

        // Pin the exact expected steady state explicitly too (not just
        // self-consistency): the parseable row is backfilled labeled...
        const red = second.find((e) => e.agentId === "CR-BF-IDEM-RED");
        expect(red).toBeDefined();
        expect(red!.phase).toBe("RED");
        expect(red!.phaseInferred).toBe(true);

        // Raw row check: phase_inferred is EXACTLY 1, never 2 (a
        // run-again-doubles bug), after the second open.
        const rawRed = rawPhaseRow(store2, "evt-idem-red");
        expect(rawRed.phase_inferred).toBe(1);

        // ...and the unparseable row is still untouched by either open.
        const unparseable = second.find((e) => e.agentId === "plain-agent-1");
        expect(unparseable).toBeDefined();
        expect(unparseable!.phase).toBeNull();
        expect(unparseable!.phaseInferred).toBeNull();
      } finally {
        closeStore(store2);
      }
    });
  });

  describe("declared rows are never touched — the backfill only fills NULLs", () => {
    test("a row already carrying a declared (phase_inferred = 0) phase is left EXACTLY as-is by the backfill, even when its id would parse to a DIFFERENT phase", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "declared-untouched.db");
      const projectKey = crypto.randomUUID();
      seedEventsDb(dbPath, projectKey, [
        // Declared GREEN despite an id shape that would parse to RED under
        // the retired phaseRole suffix contract — the declaration must win
        // and the backfill must not re-derive/flip it from the id.
        { id: "evt-declared-1", agentId: "CR-BF-DECL-1-RED", phase: "GREEN", phaseInferred: 0 },
        // A genuinely untouched (pre-057) row in the SAME db, proving the
        // backfill actually ran rather than being vacuously skipped.
        { id: "evt-legacy-1", agentId: "CR-BF-DECL-2-FIX", phase: null, phaseInferred: null },
      ]);

      const store = Store.open(dbPath);
      try {
        const events = store.listEvents(projectKey, 100);

        const declared = findByAgent(events, "CR-BF-DECL-1-RED");
        expect(declared).toBeDefined();
        // POSITIVE — exactly the declared value, untouched.
        expect(declared!.phase).toBe("GREEN");
        expect(declared!.phaseInferred).toBe(false);
        // NEGATIVE bound — never flipped to what the id would suggest.
        expect(declared!.phase).not.toBe("RED");

        const rawDeclared = rawPhaseRow(store, "evt-declared-1");
        expect(rawDeclared.phase).toBe("GREEN");
        expect(rawDeclared.phase_inferred).toBe(0);

        // The legacy row in the SAME db DID get backfilled — proves the
        // migration executed rather than short-circuiting on this db.
        const legacy = findByAgent(events, "CR-BF-DECL-2-FIX");
        expect(legacy).toBeDefined();
        expect(legacy!.phase).toBe("FIX");
        expect(legacy!.phaseInferred).toBe(true);
      } finally {
        closeStore(store);
      }
    });
  });

  describe("the distinction survives to the read path — real data behind the C2 inferred marker", () => {
    test("a backfilled event's brief reports phaseInferred: true while a declared event reports phaseInferred: false, via the same store.listEvents read path the UI/API consume", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "read-path.db");
      const projectKey = crypto.randomUUID();
      seedEventsDb(dbPath, projectKey, [
        { id: "evt-readpath-inferred", agentId: "CR-BF-READ-1-VERIFY", phase: null, phaseInferred: null },
        { id: "evt-readpath-declared", agentId: "CR-BF-READ-2", phase: "RED", phaseInferred: 0 },
      ]);

      const store = Store.open(dbPath);
      try {
        const events = store.listEvents(projectKey, 100);

        const inferred = findByAgent(events, "CR-BF-READ-1-VERIFY");
        expect(inferred).toBeDefined();
        expect(inferred!.phase).toBe("VERIFY");
        // POSITIVE — the backfilled row's brief carries phaseInferred: true.
        expect(inferred!.phaseInferred).toBe(true);

        const declared = findByAgent(events, "CR-BF-READ-2");
        expect(declared).toBeDefined();
        expect(declared!.phase).toBe("RED");
        // POSITIVE — the declared row's brief carries phaseInferred: false
        // (present and explicitly false — not absent, not true).
        expect(declared!.phaseInferred).toBe(false);
        expect(declared!.phaseInferred).not.toBeUndefined();

        // NEGATIVE bound — the two must disagree; a stub that always
        // reports the same phaseInferred value for every row would fail.
        expect(inferred!.phaseInferred).not.toBe(declared!.phaseInferred);
      } finally {
        closeStore(store);
      }
    });
  });
});
