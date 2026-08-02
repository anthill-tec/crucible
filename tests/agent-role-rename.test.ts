// CR-CRU-059 C1 (server + storage) — the registration identity contract
// renames the wire field/enum/columns `phase` -> `role` fleet-wide.
//
// Context (docs/changes/CR-CRU-059-identity-source-validation.md):
//   §S0 — rename surface: CLI --phase -> --role (enum values unchanged:
//   RED|GREEN|FIX|VERIFY|ORCHESTRATOR|report); wire body field phase -> role;
//   server AGENT_PHASES/AgentPhase -> AGENT_ROLES/AgentRole; storage
//   agents.phase -> agents.role, events.phase/phase_inferred ->
//   events.role/role_inferred (rename, not additive-copy); CR-044 semantics
//   (required + enumerated + never-blanked-by-heartbeat) and CR-056 semantics
//   (TDD roles require a cycle binding; ORCHESTRATOR/report may register
//   unbound) both survive the rename intact, just renamed.
//
//   COMPATIBILITY RULING (user-decided 2026-08-02): CLEAN BREAK. The server
//   accepts `role` only — no `phase` alias, no dual-key handling, no
//   deprecation path. A legacy body sending `phase` (and no `role`) is
//   refused exactly like a body declaring nothing at all.
//
//   🚨 The migration MUST preserve CR-057's backfilled classification
//   history (299 of 338 live events carry a classification) — a rename that
//   recreates the column instead of migrating it would silently discard that
//   data. §6 below builds an independent live-shaped fixture (declared +
//   inferred + unclassified events) and asserts the counts survive the
//   rename identically, and that the migration is idempotent.
//
// RED phase: NONE of this exists in production yet. `body.role` is not read
// anywhere on the register/heartbeat route (only `body.phase` is), Agent/
// RunEvent carry no `role`/`roleInferred` field, and the agents/events tables
// carry `phase`/`phase_inferred` columns, not `role`/`role_inferred`. Every
// assertion below fails today for that reason.
//
// Harness: drives the REAL production server (startServer) + real HTTP, same
// pattern as tests/agent-phase.test.ts / tests/event-phase-stamping.test.ts.
// The §6 migration fixture builds a genuinely INDEPENDENT live-shaped schema
// with a raw bun:sqlite Database (never through the Store class, which would
// just re-apply whatever migration already exists in THIS checkout), mirror-
// ing tests/agent-phase.test.ts's `seedLegacyDb` convention.
//
// Does NOT touch src/, clients/, or any existing test file — tests only.

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface OkResponse {
  ok: true;
  changed?: boolean;
  role?: string;
  context?: { cycleId?: number };
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error?: unknown;
  help?: unknown;
  [key: string]: unknown;
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness?: string;
  role?: string | null;
  phase?: string | null;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

interface EventBrief {
  id: string;
  agentId: string;
  kind: string;
  role?: string | null;
  roleInferred?: boolean;
  phase?: string | null;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: EventBrief[];
}

/** The exact enumeration §S0 requires — values unchanged by the rename,
 * only the wire field name and server type names change. */
const ROLE_ENUM = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"] as const;
const TDD_ROLES: readonly string[] = ["RED", "GREEN", "FIX", "VERIFY"];

/** Concatenate every string-ish field an AXI error could carry the
 * enumeration/wording in — order-independent membership check. */
function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`;
}

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crucible-agent-role-rename-test-"));
}

describe("CR-CRU-059 C1 — phase -> role rename (server + storage)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function postJson(path_: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path_}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path_: string): Promise<Response> {
    return fetch(`${base()}${path_}`);
  }

  async function patchJson(path_: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path_}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
    return key;
  }

  /** Same "orchestrator registers unbound" fixture primitive as
   * agent-phase.test.ts's ensureFixtureOrchestrator, on the RENAMED field. */
  async function ensureFixtureOrchestrator(key: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: "fixture-orch",
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    await ensureFixtureOrchestrator(key);
    const fileRes = await postJson(`/api/v2/projects/${key}/plans`, {
      cr,
      cycles: [{ label: "solo" }],
      agentId: "fixture-orch",
    });
    expect(fileRes.status).toBe(201);
    const fileBody = (await fileRes.json()) as { planId: number; cycles: Array<{ id: number }> };
    const planId = fileBody.planId;
    const cycleId = fileBody.cycles[0]!.id;
    const activateRes = await patchJson(`/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
      status: "active",
      agentId: "fixture-orch",
    });
    expect(activateRes.status).toBe(200);
    return { planId, cycleId };
  }

  // ── §1 wire — POST /api/v2/agents/register accepts `role`, per member ──

  describe("§1 wire — register accepts `role` (not `phase`), every enum member round-trips", () => {
    test("every ROLE_ENUM member registers (200, ok:true) with `role`, and GET /api/v2/agents reads back the EXACT declared value under `role`", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-059-role-accept-all");

      for (const value of ROLE_ENUM) {
        const agentId = `role-accept-${value}`;
        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: value,
          ...(TDD_ROLES.includes(value) ? { cycleId } : {}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as OkResponse;
        expect(body.ok).toBe(true);

        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        // POSITIVE — the exact declared value, under the RENAMED key.
        expect(agent!.role).toBe(value);
      }
    });
  });

  // ── §2 CLEAN BREAK — legacy `phase` alone is refused, no alias ─────────

  describe("§2 CLEAN BREAK (user ruling 2026-08-02) — a legacy `phase`-only body is refused exactly like an absent role, no alias", () => {
    test('registering with {phase: "RED"} and NO `role` field is REFUSED (400, ok:false), help[] names `role` — nothing stored', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "clean-break-legacy-phase",
        phase: "RED",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      const surface = errorSurface(body).toLowerCase();
      // The rejection vocabulary must have MOVED to "role" — the clean
      // break's whole point is that the legacy field name buys nothing.
      expect(surface).toContain("role");
      // NEGATIVE bound: sending a legacy phase value must NOT have been
      // silently accepted as if it were the new field — no partial write.
      expect(store.hasAgent(key, "clean-break-legacy-phase")).toBe(false);
    });

    test('a {phase: "RED"} body produces the IDENTICAL refusal (status code) as a body with neither `phase` nor `role` — the legacy key earns no special-case handling', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store);

      const withLegacyPhase = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "clean-break-a",
        phase: "RED",
      });
      const withNeither = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "clean-break-b",
      });

      expect(withLegacyPhase.status).toBe(400);
      expect(withNeither.status).toBe(400);
      expect(withLegacyPhase.status).toBe(withNeither.status);
    });
  });

  // ── §3 CR-044 semantics survive the rename ──────────────────────────────

  describe("§3 CR-044 semantics survive under `role` — required, enum-constrained, never blanked by heartbeat", () => {
    test("registering with NO `role` field is REJECTED (400, ok:false) naming the accepted enumeration", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "role-required-1",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      const surface = errorSurface(body);
      for (const value of ROLE_ENUM) {
        expect(surface).toContain(value);
      }
      // The error vocabulary itself must have moved to "role" — a message
      // that still only says "phase" (today's actual wording) is the OLD
      // contract wearing the new test's clothes, not the rename.
      expect(surface.toLowerCase()).toContain("role");
      expect(store.hasAgent(key, "role-required-1")).toBe(false);
    });

    test('registering with an out-of-enum role ("banana") is REJECTED the same way (400, ok:false, enumeration named)', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "role-invalid-1",
        role: "banana",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      const surface = errorSurface(body);
      for (const value of ROLE_ENUM) {
        expect(surface).toContain(value);
      }
      expect(surface.toLowerCase()).toContain("role");
      // NEGATIVE bound: this is the OUT-OF-ENUM case (a role was DECLARED,
      // just an invalid one) — the error must name the received value, not
      // read as the missing-field case (today's actual behavior: `role` is
      // never read, so the server sees NO phase at all and produces the
      // exact same "missing field" wording as the test above — asserting
      // the value is named catches that false-positive).
      expect(surface).toContain("banana");
      expect(store.hasAgent(key, "role-invalid-1")).toBe(false);
    });

    test("a heartbeat with no `role` field on an already-registered agent succeeds AND does not blank the stored role", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store);
      const agentId = "role-heartbeat-1";

      const regRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
      });
      expect(regRes.status).toBe(200);

      const hbRes = await postJson("/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId,
        message: "still working",
      });
      expect(hbRes.status).toBe(200);
      const hbBody = (await hbRes.json()) as OkResponse;
      expect(hbBody.ok).toBe(true);

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === agentId);
      expect(agent).toBeDefined();
      // POSITIVE — still exactly "report".
      expect(agent!.role).toBe("report");
      // NEGATIVE bound — the heartbeat must not have erased it.
      expect(agent!.role).not.toBeNull();
      expect(agent!.role).not.toBeUndefined();
    });
  });

  // ── §4 CR-056 semantics survive the rename ──────────────────────────────

  describe("§4 CR-056 semantics survive under `role` — TDD roles bind to a cycle, ORCHESTRATOR/report may register unbound", () => {
    test("registering role: RED with NO cycleId is REFUSED (409, ok:false), help names the cycle-binding requirement", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "role-unbound-red",
        role: "RED",
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      const surface = errorSurface(body).toLowerCase();
      expect(surface).toContain("cycle");
      expect(store.hasAgent(key, "role-unbound-red")).toBe(false);
    });

    test("registering role: ORCHESTRATOR with NO cycleId SUCCEEDS (200, ok:true) — orchestrator/report stay exempt from the binding requirement", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "role-unbound-orch",
        role: "ORCHESTRATOR",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(store.hasAgent(key, "role-unbound-orch")).toBe(true);

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === "role-unbound-orch");
      expect(agent!.role).toBe("ORCHESTRATOR");
    });
  });

  // ── §5 storage + read path expose role / roleInferred ───────────────────
  //
  // These bypass the (currently role-blind) HTTP register route by seeding
  // the agent row directly through Store.touchAgent with a `role`-shaped
  // opts object (cast past TouchAgentOpts, which today only recognizes
  // `phase` — the not-yet-existing SUT surface this CR adds). That isolates
  // the STORAGE + read-path contract from the route-level acceptance already
  // pinned in §1-§4 above.

  describe("§5 storage + read path — agents/events expose `role`/`roleInferred`, ingest echoes `role`", () => {
    test("Store.touchAgent persists a `role` option and Store.getAgent/GET /api/v2/agents both read it back", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "storage-role-1";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.touchAgent(key, agentId, { role: "RED" } as any);

      const direct = store.getAgent(key, agentId) as unknown as { role?: string };
      expect(direct.role).toBe("RED");

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === agentId);
      expect(agent).toBeDefined();
      expect(agent!.role).toBe("RED");
    });

    test("Store.recordTestEvent persists `role` (declared, roleInferred:false) and GET /api/v2/events reads both back", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "storage-role-event-1";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const event = store.recordTestEvent(
        key,
        agentId,
        { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
        { role: "VERIFY" } as any,
      );

      const stored = event as unknown as { role?: string; roleInferred?: boolean };
      expect(stored.role).toBe("VERIFY");
      expect(stored.roleInferred).toBe(false);

      const listRes = await getJson(`/api/v2/events?project=${key}`);
      const listBody = (await listRes.json()) as EventsListResponse;
      const brief = listBody.events.find((e) => e.id === event.id);
      expect(brief).toBeDefined();
      expect(brief!.role).toBe("VERIFY");
      expect(brief!.roleInferred).toBe(false);
    });

    test("POST /api/v2/runs/parsed echoes `role` top-level in its response, mirroring the agent's stored role", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "storage-role-echo-1";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.touchAgent(key, agentId, { role: "FIX" } as any);

      const runRes = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        agentId,
        summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 12 },
        tree: [],
      });
      expect(runRes.status).toBe(200);
      const runBody = (await runRes.json()) as OkResponse;
      expect(runBody.ok).toBe(true);
      // POSITIVE — the echo carries the exact stored role.
      expect(runBody.role).toBe("FIX");
    });
  });

  // ── §6 migration preserves CR-057's classification history under rename ──
  //
  // 🚨 highest-risk AC: 299 of 338 LIVE events carry a classification
  // (declared + §S4-inferred). A rename that recreates the column instead of
  // migrating it would silently discard that. This fixture mirrors that
  // shape independently of the live db: a mix of declared (role_inferred=0),
  // inferred (role_inferred=1) and unclassified (both NULL) rows, built with
  // a raw bun:sqlite Database against the CURRENT (pre-rename) column names
  // `phase`/`phase_inferred` — exactly the schema this checkout's Store
  // writes today, so the migration assertions are meaningful regardless of
  // RED/GREEN state (same independent-fixture principle as
  // tests/agent-phase.test.ts's seedLegacyDb).

  describe("§6 migration idempotently RENAMES phase->role/phase_inferred->role_inferred, preserving CR-057's classification counts exactly", () => {
    let tmpDir: string | undefined;

    afterEach(() => {
      if (tmpDir !== undefined) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    const ROLE_CYCLE = ["RED", "GREEN", "FIX", "VERIFY"] as const;

    interface LiveShapedFixture {
      projectKey: string;
      declaredCount: number;
      inferredCount: number;
      unclassifiedCount: number;
      /** id -> expected {role, roleInferred} for a few spot-checked rows. */
      spotChecks: Array<{ id: string; role: string; roleInferred: 0 | 1 }>;
      legacyAgentId: string; // phase = NULL (pre-CR-044 shape)
      declaredAgentId: string; // phase = "GREEN"
    }

    /**
     * Builds a raw sqlite file using the CURRENT (pre-CR-059) `projects` +
     * `agents` + `events` CREATE TABLE statements (byte-for-byte the shapes
     * at src/store.ts:330-379, hand-copied — NOT driven through the Store
     * class), seeded with a mix mirroring the live board's declared/
     * inferred/unclassified split (299 of 338 classified live; here 18 of
     * 20, same "mostly classified, small unclassified tail" shape).
     */
    function seedLiveShapedDb(dbPath: string): LiveShapedFixture {
      const raw = new Database(dbPath, { create: true });
      raw.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          key TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          sut_root TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          liveness TEXT,
          retention INTEGER,
          archived_at INTEGER,
          allow_run_deletion INTEGER
        );
        CREATE TABLE IF NOT EXISTS agents (
          project_key TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          identity TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          phase TEXT,
          bound_cycle_id INTEGER,
          PRIMARY KEY (project_key, agent_id)
        );
        CREATE TABLE IF NOT EXISTS events (
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

      const projectKey = crypto.randomUUID();
      raw
        .query(`INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(projectKey, "live-shaped-project", "backend", "/tmp/live", Date.now());

      const declaredAgentId = "live-agent-declared";
      const legacyAgentId = "live-agent-legacy";
      raw
        .query(
          `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen, phase)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectKey, declaredAgentId, "online", "declared agent", "{}", Date.now(), Date.now(), "GREEN");
      raw
        .query(
          `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen, phase)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectKey, legacyAgentId, "online", "legacy agent", "{}", Date.now(), Date.now(), null);

      const insertEvent = raw.query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, phase, phase_inferred)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const DECLARED_N = 10;
      const INFERRED_N = 8;
      const UNCLASSIFIED_N = 2;
      const spotChecks: LiveShapedFixture["spotChecks"] = [];

      let ts = Date.now();
      for (let i = 0; i < DECLARED_N; i++) {
        const id = `evt-declared-${i}`;
        const role = ROLE_CYCLE[i % ROLE_CYCLE.length]!;
        insertEvent.run(id, projectKey, "declaring-agent", "test", "unit", ts++, role, 0);
        if (i === 3) spotChecks.push({ id, role, roleInferred: 0 });
      }
      for (let i = 0; i < INFERRED_N; i++) {
        const id = `evt-inferred-${i}`;
        const role = ROLE_CYCLE[i % ROLE_CYCLE.length]!;
        insertEvent.run(id, projectKey, `some-agent-suffix-${role}`, "test", "unit", ts++, role, 1);
        if (i === 2) spotChecks.push({ id, role, roleInferred: 1 });
      }
      for (let i = 0; i < UNCLASSIFIED_N; i++) {
        const id = `evt-unclassified-${i}`;
        insertEvent.run(id, projectKey, "plain-agent", "test", "unit", ts++, null, null);
      }

      raw.close();

      return {
        projectKey,
        declaredCount: DECLARED_N,
        inferredCount: INFERRED_N,
        unclassifiedCount: UNCLASSIFIED_N,
        spotChecks,
        legacyAgentId,
        declaredAgentId,
      };
    }

    function tableInfoColumns(store: Store, table: string): Set<string> {
      return new Set(
        (store as unknown as { db: Database }).db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name),
      );
    }

    function rawDb(store: Store): Database {
      return (store as unknown as { db: Database }).db;
    }

    test("opening a live-shaped pre-rename db migrates agents.phase->role and events.phase/phase_inferred->role/role_inferred, with IDENTICAL classification counts before and after", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "live-shaped.db");
      const fixture = seedLiveShapedDb(dbPath);

      const store = Store.open(dbPath);
      try {
        // Columns actually RENAMED — the old names must be gone, not merely
        // shadowed by an additive copy (a rename discards nothing but also
        // duplicates nothing).
        const eventCols = tableInfoColumns(store, "events");
        expect(eventCols.has("role")).toBe(true);
        expect(eventCols.has("role_inferred")).toBe(true);
        expect(eventCols.has("phase")).toBe(false);
        expect(eventCols.has("phase_inferred")).toBe(false);

        const agentCols = tableInfoColumns(store, "agents");
        expect(agentCols.has("role")).toBe(true);
        expect(agentCols.has("phase")).toBe(false);

        const db = rawDb(store);
        const declaredCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role_inferred = 0`)
          .get()!.c;
        const inferredCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role_inferred = 1`)
          .get()!.c;
        const nullCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role IS NULL`)
          .get()!.c;
        const classifiedCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role IS NOT NULL`)
          .get()!.c;

        // Counts IDENTICAL to what was seeded — nothing dropped, nothing
        // fabricated by the rename.
        expect(declaredCount).toBe(fixture.declaredCount);
        expect(inferredCount).toBe(fixture.inferredCount);
        expect(nullCount).toBe(fixture.unclassifiedCount);
        expect(classifiedCount).toBe(fixture.declaredCount + fixture.inferredCount);

        // Spot-check exact per-row preservation (not just aggregate counts).
        for (const expected of fixture.spotChecks) {
          const row = db
            .query<{ role: string | null; role_inferred: number | null }, [string]>(
              `SELECT role, role_inferred FROM events WHERE id = ?`,
            )
            .get(expected.id);
          expect(row).not.toBeNull();
          expect(row!.role).toBe(expected.role);
          expect(row!.role_inferred).toBe(expected.roleInferred);
        }

        // Agents row: the declared value survives under `role`; the legacy
        // (pre-CR-044, phase=NULL) row still reads as absent, never
        // fabricated.
        const declaredAgent = store.getAgent(fixture.projectKey, fixture.declaredAgentId) as unknown as {
          role?: string;
        };
        expect(declaredAgent.role).toBe("GREEN");
        const legacyAgent = store.getAgent(fixture.projectKey, fixture.legacyAgentId) as unknown as {
          role?: string | null;
        };
        expect(legacyAgent.role === undefined || legacyAgent.role === null).toBe(true);
      } finally {
        rawDb(store).close();
      }
    });

    test("the migration is IDEMPOTENT: opening the same db a second time does not duplicate columns, error, or alter the preserved counts", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "live-shaped-idempotent.db");
      const fixture = seedLiveShapedDb(dbPath);

      const first = Store.open(dbPath);
      rawDb(first).close();

      // Second open must not throw (no "duplicate column" / RENAME-onto-
      // existing-name errors) and must leave the schema/counts unchanged.
      const second = Store.open(dbPath);
      try {
        const eventCols = tableInfoColumns(second, "events");
        // Exactly one "role" column, one "role_inferred" column — no
        // accumulated duplicates from re-running the rename.
        expect([...eventCols].filter((c) => c === "role")).toHaveLength(1);
        expect([...eventCols].filter((c) => c === "role_inferred")).toHaveLength(1);
        expect(eventCols.has("phase")).toBe(false);
        expect(eventCols.has("phase_inferred")).toBe(false);

        const db = rawDb(second);
        const classifiedCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role IS NOT NULL`)
          .get()!.c;
        const nullCount = db
          .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM events WHERE role IS NULL`)
          .get()!.c;
        expect(classifiedCount).toBe(fixture.declaredCount + fixture.inferredCount);
        expect(nullCount).toBe(fixture.unclassifiedCount);
      } finally {
        rawDb(second).close();
      }
    });
  });
});
