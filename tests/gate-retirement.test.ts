// CR-CRU-073 — a finished release retires its no-mistakes gate (design (a):
// a STORED events.retired_at marker, stamped in the release-milestone
// transaction). RED suite for cycle C1 — the server + schema mechanism only
// (the §UI pane wiring is C2 and is NOT tested here).
//
// ── The contract these tests are written against (absent until GREEN) ───────
//
//   POST /api/v2/gates gains an optional top-level `version` (bare SemVer),
//   stored first-class on the resulting gate event (`event.version`) — never
//   parsed back out of the free-text intent, and NOT a change to the gate
//   object / no-mistakes ladder (Scope non-goal).
//
//   Store.recordGateEvent(pk, agent, gate, { version? })  — version rides the
//     payload blob and surfaces as `event.version`.
//   Store.recordMilestoneEvent(pk, agent, "release", { label: V }) — in the
//     SAME transaction that inserts the release, stamps `events.retired_at`
//     (epoch ms) on EVERY gate whose `version === V`. A gate that arrives for
//     an already-released version is stamped retired on insert.
//   events.retired_at  — new nullable column (NULL = live). RunEvent surfaces
//     it as `event.retiredAt`.
//   Store.listEvents  — the pane/timeline feed EXCLUDES retired gates
//     (retired_at IS NULL). Store.getEvent — the audit/direct read still
//     returns a retired gate WITH its full gate object and retiredAt.
//   enforceRetention — a gate with retired_at IS NULL is EXEMPT from the
//     per-project count cap (a live gate is never pruned); once retired it is
//     retention-eligible like any other event.
//   SCHEMA_VERSION — the retired_at column is CR-CRU-071 chain step 6 → 7, and
//     that same migration stamps retired_at on every gate that predates the
//     column (the three versionless strays). The value the chain now ends at is
//     8: CR-CRU-091 §S2 appended the queue_entries declaration step.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// Every store here is an mkdtempSync scratch file or ":memory:"; the live
// data/crucible.db is NEVER opened. Every server binds port 0 (ephemeral),
// NEVER :3849.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── scratch-dir bookkeeping ─────────────────────────────────────────────────
const scratchDirs: string[] = [];
const handles: ServerHandle[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cru-gate-retire-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

// ── typed views over the not-yet-existing contract (cast, so a failure is a
//    clean assertion about the MISSING behaviour, not a transpile artefact) ──
type GateMeta = { version?: string; context?: unknown; role?: unknown };
type ReleaseMeta = { label?: string; commit?: string; context?: unknown };

interface RetireEvent {
  id: string;
  kind: string;
  version?: string;
  retiredAt?: number;
  gate?: unknown;
}

function recordGate(
  store: Store,
  pk: string,
  agent: string,
  gate: Record<string, unknown>,
  version?: string,
): RetireEvent {
  const meta: GateMeta = version !== undefined ? { version } : {};
  return store.recordGateEvent(pk, agent, gate, meta as never) as unknown as RetireEvent;
}

function recordRelease(store: Store, pk: string, agent: string, version: string): void {
  const meta: ReleaseMeta = { label: version, commit: `sha-${version}` };
  store.recordMilestoneEvent(pk, agent, "release", meta as never);
}

function getEvent(store: Store, id: string): RetireEvent | null {
  return store.getEvent(id) as unknown as RetireEvent | null;
}

function schemaVersion(): number {
  const mod = storeModule as { SCHEMA_VERSION?: unknown };
  if (typeof mod.SCHEMA_VERSION !== "number") {
    throw new Error("CR-CRU-073: src/store.ts exports no numeric SCHEMA_VERSION");
  }
  return mod.SCHEMA_VERSION;
}

const GATE = {
  intent: "Ship Crucible release",
  outcome: "passed",
  steps: [{ name: "test", status: "passed" }],
};

function seed(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp" });
  return key;
}

function makeTest(store: Store, pk: string, agent: string): string {
  const run = {
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
    tree: [],
  };
  return store.recordTestEvent(pk, agent, run as never).id;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("CR-CRU-073 AC1 — a gate names the release it gated, first-class", () => {
  test("POST /api/v2/gates accepts a top-level version and stores it first-class on the event", async () => {
    const handle = startServer({ port: 0, dbPath: ":memory:" });
    handles.push(handle);
    const base = `http://localhost:${handle.server.port}`;

    const pRes = await fetch(`${base}/api/v2/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gate-version" }),
    });
    const pk = ((await pRes.json()) as { project: { key: string } }).project.key;
    await fetch(`${base}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: pk, agentId: "orch-1", role: "ORCHESTRATOR" }),
    });

    const res = await fetch(`${base}/api/v2/gates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: pk, agentId: "orch-1", version: "0.2.0", gate: GATE }),
    });
    expect(res.status).toBe(201);

    const listed = (await (
      await fetch(`${base}/api/v2/events?project=${pk}`)
    ).json()) as { events: RetireEvent[] };
    const gate = listed.events.find((e) => e.kind === "gate");
    expect(gate).toBeDefined();
    // First-class: the version is on the event, NOT buried in the free-text intent.
    expect(gate!.version).toBe("0.2.0");
    expect(JSON.stringify(gate!.gate)).not.toContain("0.2.0");
  });

  test("a versionless gate is still accepted and never becomes retire-eligible", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    const gateId = recordGate(store, pk, "orch-1", GATE).id; // no version
    expect(getEvent(store, gateId)).not.toBeNull();
    expect(getEvent(store, gateId)!.version).toBeUndefined();

    // A release for ANY version cannot retire a versionless gate.
    recordRelease(store, pk, "orch-1", "0.2.0");
    expect(getEvent(store, gateId)!.retiredAt).toBeUndefined();
  });
});

describe("CR-CRU-073 AC2 — finishing a release retires its gates atomically", () => {
  test("recordMilestoneEvent(release, V) stamps retired_at on every gate whose version === V, and only those", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    const g020 = recordGate(store, pk, "orch-1", GATE, "0.2.0").id;
    const g019 = recordGate(store, pk, "orch-1", GATE, "0.1.9").id;

    recordRelease(store, pk, "orch-1", "0.2.0");

    const retired = getEvent(store, g020)!;
    expect(typeof retired.retiredAt).toBe("number");
    expect(retired.retiredAt).toBeGreaterThan(0);
    // The full gate object survives — the row is stamped, never rewritten.
    expect(retired.gate).toEqual(GATE);

    // A non-matching version is untouched.
    expect(getEvent(store, g019)!.retiredAt).toBeUndefined();
  });

  test("a release with no matching gate still succeeds; a gate arriving afterward is retired on insert", () => {
    const store = new Store(":memory:");
    const pk = seed(store);

    // No gate for 0.3.0 exists yet — the release must still record.
    recordRelease(store, pk, "orch-1", "0.3.0");
    expect(store.listReleases(pk).some((r) => r.label === "0.3.0")).toBe(true);

    // A late-arriving gate for the already-released version is retired on insert.
    const late = recordGate(store, pk, "orch-1", GATE, "0.3.0").id;
    expect(typeof getEvent(store, late)!.retiredAt).toBe("number");
  });
});

describe("CR-CRU-073 AC3 — retention: a live gate is cap-exempt, a retired gate is not", () => {
  test("a live (retired_at NULL) gate survives the count cap while ordinary events prune", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    store.updateProject(pk, { retention: 3 });

    const gateId = recordGate(store, pk, "orch-1", GATE, "0.2.0").id; // oldest row
    const firstTest = makeTest(store, pk, "worker-GREEN");
    makeTest(store, pk, "worker-GREEN");
    makeTest(store, pk, "worker-GREEN");
    makeTest(store, pk, "worker-GREEN");
    const lastTest = makeTest(store, pk, "worker-GREEN");

    // The live gate is EXEMPT: it survives despite being the oldest row.
    expect(getEvent(store, gateId)).not.toBeNull();
    expect(getEvent(store, gateId)!.retiredAt).toBeUndefined();
    // An ordinary old event is pruned by the same cap; a recent one survives.
    expect(getEvent(store, firstTest)).toBeNull();
    expect(getEvent(store, lastTest)).not.toBeNull();
  });

  test("once retired, a gate is retention-eligible again and prunes like any other event", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    store.updateProject(pk, { retention: 3 });

    const gateId = recordGate(store, pk, "orch-1", GATE, "0.2.0").id;
    recordRelease(store, pk, "orch-1", "0.2.0"); // retires the gate
    expect(typeof getEvent(store, gateId)!.retiredAt).toBe("number");

    // Drive the project well over the cap with newer traffic; the retired
    // gate (now the oldest ordinary row) is eligible and prunes.
    for (let i = 0; i < 6; i++) makeTest(store, pk, "worker-GREEN");
    expect(getEvent(store, gateId)).toBeNull();
  });
});

describe("CR-CRU-073 AC4 — retired is a stored marker: excluded from the pane, kept for audit", () => {
  test("the pane feed (listEvents) omits a retired gate; a direct read still returns it with retiredAt + full gate", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    const gateId = recordGate(store, pk, "orch-1", GATE, "0.2.0").id;

    // Before retirement: the gate is in the pane feed.
    expect(store.listEvents(pk, 100).some((e) => e.id === gateId)).toBe(true);

    recordRelease(store, pk, "orch-1", "0.2.0");

    // Pane feed excludes the retired gate...
    expect(store.listEvents(pk, 100).some((e) => e.id === gateId)).toBe(false);
    // ...but the row and its full gate object still exist on a direct fetch.
    const audit = getEvent(store, gateId)!;
    expect(audit).not.toBeNull();
    expect(typeof audit.retiredAt).toBe("number");
    expect(audit.gate).toEqual(GATE);
  });
});

describe("CR-CRU-073 AC5 — the migration adds retired_at and retires pre-column gates", () => {
  test("SCHEMA_VERSION derives to 8", () => {
    // A LITERAL on purpose (a tripwire, not a tautology): a chain step must
    // make a human look. It fired for CR-CRU-091 §S2's queue_entries step,
    // which is legitimate, so it is consciously RE-ARMED at 8 — the retired_at
    // step this file owns is still 6 → 7 and is asserted by effect below.
    expect(schemaVersion()).toBe(8);
  });

  test("a v6 store with versionless gate rows migrates: retired_at added and stamped on every pre-column gate, losslessly and idempotently", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "crucible.db");

    // Build a store shaped exactly like a v6 db: full events schema, NO
    // retired_at column, gate rows that predate the feature (the strays).
    const raw = new Database(dbPath, { create: true });
    try {
      raw.exec("PRAGMA journal_mode = DELETE;");
      raw.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY, project_key TEXT NOT NULL, agent_id TEXT NOT NULL,
          kind TEXT NOT NULL, tier TEXT NOT NULL, stack TEXT, codec TEXT,
          timestamp INTEGER NOT NULL, name TEXT, total INTEGER, passed INTEGER,
          failed INTEGER, pending INTEGER, duration_ms INTEGER, tree TEXT,
          coverage TEXT, compile TEXT, context TEXT, action TEXT, first_seen INTEGER,
          payload TEXT, role TEXT, role_inferred INTEGER, started_at INTEGER,
          runtime_ms INTEGER, status TEXT
        );
      `);
      const gatePayload = JSON.stringify({ gate: GATE });
      for (const [id, ts] of [
        ["evt-1787147319990-5", 1787147319990],
        ["evt-1787148416296-6", 1787148416296],
        ["evt-1787162398203-39", 1787162398203],
      ] as const) {
        raw
          .query(
            `INSERT INTO events (id, project_key, agent_id, kind, tier, codec, timestamp, payload)
             VALUES (?, 'p1', 'orch-1', 'gate', 'unit', 'no-mistakes', ?, ?)`,
          )
          .run(id, ts, gatePayload);
      }
      // A non-gate row that the migration must NOT stamp.
      raw
        .query(
          `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp)
           VALUES ('evt-test-1', 'p1', 'w-1', 'test', 'unit', 1787000000000)`,
        )
        .run();
      raw.exec("PRAGMA user_version = 6;");
    } finally {
      raw.close();
    }

    const countEvents = (p: string): number => {
      const db = new Database(p);
      try {
        return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events`).get()!.n;
      } finally {
        db.close();
      }
    };
    const retiredOf = (p: string, id: string): number | null => {
      const db = new Database(p);
      try {
        return (
          db
            .query<{ retired_at: number | null }, [string]>(
              `SELECT retired_at FROM events WHERE id = ?`,
            )
            .get(id)?.retired_at ?? null
        );
      } finally {
        db.close();
      }
    };
    const columnsOf = (p: string): string[] => {
      const db = new Database(p);
      try {
        return db
          .query<{ name: string }, []>(`PRAGMA table_info(events)`)
          .all()
          .map((c) => c.name);
      } finally {
        db.close();
      }
    };
    const userVersion = (p: string): number => {
      const db = new Database(p);
      try {
        return db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()!.user_version;
      } finally {
        db.close();
      }
    };

    const before = countEvents(dbPath);

    // Open through the real migration chain.
    Store.open(dbPath);

    // The column now exists and the store is at v7.
    expect(columnsOf(dbPath)).toContain("retired_at");
    expect(userVersion(dbPath)).toBe(schemaVersion());

    // Every pre-column gate is retired; the non-gate row is untouched.
    const stampA = retiredOf(dbPath, "evt-1787147319990-5");
    const stampB = retiredOf(dbPath, "evt-1787148416296-6");
    const stampC = retiredOf(dbPath, "evt-1787162398203-39");
    expect(typeof stampA).toBe("number");
    expect(typeof stampB).toBe("number");
    expect(typeof stampC).toBe("number");
    expect(retiredOf(dbPath, "evt-test-1")).toBeNull();

    // Lossless: no row added or removed.
    expect(countEvents(dbPath)).toBe(before);

    // Idempotent: re-opening stamps nothing new and moves no data.
    Store.open(dbPath);
    expect(retiredOf(dbPath, "evt-1787147319990-5")).toBe(stampA);
    expect(retiredOf(dbPath, "evt-1787148416296-6")).toBe(stampB);
    expect(retiredOf(dbPath, "evt-1787162398203-39")).toBe(stampC);
    expect(countEvents(dbPath)).toBe(before);
  });
});

describe("CR-CRU-073 AC6 — duplicate runs of one release retire together", () => {
  test("two gate runs sharing a version are both retired by the single release stamp", () => {
    const store = new Store(":memory:");
    const pk = seed(store);
    const first = recordGate(store, pk, "orch-1", GATE, "0.1.0").id;
    const second = recordGate(store, pk, "orch-1", GATE, "0.1.0").id;

    recordRelease(store, pk, "orch-1", "0.1.0");

    expect(typeof getEvent(store, first)!.retiredAt).toBe("number");
    expect(typeof getEvent(store, second)!.retiredAt).toBe("number");
    // Neither is left as a live gate in the pane feed.
    const paneIds = store.listEvents(pk, 100).map((e) => e.id);
    expect(paneIds).not.toContain(first);
    expect(paneIds).not.toContain(second);
  });
});
