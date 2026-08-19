// CR-CRU-044 C1 (server) — role becomes a required, enumerated, persisted
// field on agent registration instead of an agentId-string-matching guess.
//
// §S1 gap-analysis notes this pins:
//   (a) /agents/register and /agents/heartbeat share ONE handler
//       (handleAgentTouch, src/v2.ts:1471-1473). DECISION TAKEN HERE (see
//       report): the routes SPLIT — role is REQUIRED on register, but
//       heartbeat stays role-optional (matches src/hints.ts:44's existing
//       "only needed while idle" contract and does not re-demand a value an
//       already-registered agent already declared). The heartbeat-side
//       tests below pin that choice; if GREEN instead requires role on
//       both, those specific tests must be revisited together with the
//       hints.ts wording — not silently reinterpreted.
//   (b) the requirement lives at the ROUTE boundary, never inside
//       Store.touchAgent (which stays role-optional so ingest never
//       breaks) — the ingest test below is the regression pin for that.
//   (c) an ingest touch must never blank a stored role — dedicated test.
//   (d) `role` is its own column via the established
//       PRAGMA table_info + ALTER TABLE retrofit pattern — a legacy
//       (pre-CR-044) db file must open and migrate cleanly.
//
// CR-CRU-059 C2 — fleet-wide phase->role rename reaches this file too (was
// tests/agent-phase.test.ts): the wire field, enum type, and stored column
// are all `role` now; the migration test below (§1(d)) is re-pointed at the
// RENAMED column, matching src/store.ts's `agentCols.has("phase") &&
// !agentCols.has("role")` in-place rename path.
//
// Drives the REAL production server (startServer) + real HTTP, same harness
// pattern as tests/agent-lifecycle.test.ts / tests/v2-core.test.ts. The
// legacy-db fixtures build a genuinely INDEPENDENT pre-migration schema with
// a raw bun:sqlite Database (not via the Store class, which would just
// re-apply whatever migration already exists in THIS checkout) so the
// migration assertions are meaningful regardless of RED/GREEN state.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

interface OkResponse {
  ok: true;
  changed?: boolean;
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
  liveness: string;
  role?: string | null;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

/** The exact enumeration §S1 requires the server to accept and to name in
 * its rejection error — order-independent membership check below. */
const ROLE_ENUM = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"] as const;

/** Concatenate every string-ish field an AXI error could carry the
 * enumeration in, so the assertion survives whatever exact wording GREEN
 * picks while still requiring the accepted values to be NAMED (per the
 * dispatch prompt: "a definitive AXI error naming the accepted values"). */
function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`;
}

function freshTmpDir(): string {
  // NEVER inside the repo — a fresh OS tmpdir per test (same convention as
  // tests/db-path-resolution.test.ts).
  return fs.mkdtempSync(path.join(os.tmpdir(), "crucible-agent-role-test-"));
}

/**
 * Builds a raw sqlite file at `dbPath` using the PRE-CR-044 `projects` +
 * `agents` schema (byte-for-byte the CREATE TABLE statements at
 * src/store.ts:263-284, deliberately hand-copied rather than driven through
 * the Store class) with ONE project and ONE legacy agent row that has never
 * heard of a `role` column. Exercises the real production migration path
 * (Store.open / startServer) against a schema this test fully controls, so
 * the migration assertions hold regardless of what src/store.ts currently
 * does.
 */
function seedLegacyDb(dbPath: string, projectKey: string, agentId: string): void {
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
      PRIMARY KEY (project_key, agent_id)
    );
  `);
  raw
    .query(
      `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectKey, "legacy-project", "backend", "/tmp/legacy", Date.now());
  raw
    .query(
      `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(projectKey, agentId, "online", "pre-CR-044 message", "{}", Date.now(), Date.now());
  raw.close();
}

describe("CR-CRU-044 C1 — role as first-class data (server)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

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

  // CR-CRU-056 §S2 — TDD-role (RED/GREEN/FIX/VERIFY) registration now
  // REQUIRES a cycle binding. Where a test's actual subject is the ROLE
  // enumeration/declaration itself (not incidental to some other CR-044
  // behaviour), it must supply one — same fixture primitive as
  // tests/agent-cycle-binding.test.ts: files a real ONE-cycle plan through
  // the plans API and activates that cycle through the real PATCH transition
  // route (never store.filePlan/direct DB writes).
  // CR-CRU-056 §S2b fixture-repair (C3): plan-file/cycle-transition are
  // mutating v2 workflow verbs and now refuse an unregistered caller (409) —
  // register a fixture orchestrator for this project before either call.
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
    const fileBody = (await fileRes.json()) as {
      planId: number;
      cycles: Array<{ id: number }>;
    };
    const planId = fileBody.planId;
    const cycleId = fileBody.cycles[0]!.id;
    const activateRes = await patchJson(`/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
      status: "active",
      agentId: "fixture-orch",
    });
    expect(activateRes.status).toBe(200);
    return { planId, cycleId };
  }

  // ── §S1 required + enumerated (register) ──────────────────────────────

  describe("§S1 required + enumerated — POST /api/v2/agents/register", () => {
    test("registering with NO role field is REJECTED (400, ok:false) with an AXI error naming the accepted enumeration", async () => {
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
      // The rejected call must not register the agent (no partial write).
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
      expect(store.hasAgent(key, "role-invalid-1")).toBe(false);
    });

    test("every enum value is individually ACCEPTED (200, ok:true) on register AND round-trips exactly via GET /api/v2/agents", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      // CR-CRU-056 §S2 — TDD roles (RED/GREEN/FIX/VERIFY) now REQUIRE a
      // cycle binding; ORCHESTRATOR/report register unbound as before. The
      // role enumeration itself IS this test's subject, so every TDD value
      // must still be exercised — bound, not swapped for an incidental one.
      const { cycleId } = await fileAndActivate(key, "CR-CRU-044-role-accept-all");
      const TDD_ROLES: readonly string[] = ["RED", "GREEN", "FIX", "VERIFY"];

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
        expect(store.hasAgent(key, agentId)).toBe(true);

        // Not just "accepted" — the EXACT declared value must be the one
        // stored and returned (a validator that accepts everything but
        // discards the value, or coerces it, would still pass the 200/ok
        // checks above but fail here).
        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        expect(agent!.role).toBe(value);
      }
    });
  });

  // ── §S1 persisted + returned ────────────────────────────────────────────

  describe("§S1 persisted + returned — GET /api/v2/agents", () => {
    // CR-CRU-056 C2 final sweep: the persisted VALUE round-tripping is this
    // test's subject, not specifically the GREEN TDD role (the enumeration
    // loop above already exercises every TDD value bound) — "report" keeps
    // the assertion exactly as strong (still an exact declared-value
    // round-trip) without dragging in a cycle-binding fixture incidental to
    // this test's actual purpose.
    test('register with role:"report" -> GET /api/v2/agents returns role:"report" for that agent', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store);
      const agentId = "role-roundtrip-1";

      const regRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
      });
      expect(regRes.status).toBe(200);

      const listRes = await getJson(`/api/v2/agents?project=${key}`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as AgentsListResponse;
      const agent = listBody.agents.find((a) => a.agentId === agentId);
      expect(agent).toBeDefined();
      expect(agent!.role).toBe("report");
    });
  });

  // ── §S1 declaration beats the label — the defect's regression test ────

  describe("§S1 the declaration beats the label (defect regression)", () => {
    test(
      "an agentId that does NOT end in '-GREEN' (CR-CRU-041-C1-GREEN-bun) registered with " +
        'role:"GREEN" classifies as GREEN — the declared value, not a guess from the id shape',
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = seedProject(handle.store);
        const agentId = "CR-CRU-041-C1-GREEN-bun";
        // CR-CRU-056 §S2 — the SPECIFIC GREEN value is this test's genuine
        // subject (proving the declaration, not the id shape, wins), so it
        // is bound rather than swapped for an incidental role.
        const { cycleId } = await fileAndActivate(key, "CR-CRU-041-C1-GREEN-bun-cycle");

        await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "GREEN",
          cycleId,
        });

        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        expect(agent!.role).toBe("GREEN");
      },
    );

    test(
      "an agentId ENDING in '-GREEN' registered with role:\"RED\" classifies as RED, " +
        "NEGATIVE: never GREEN — the id's trailing label must not override the declaration",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = seedProject(handle.store);
        const agentId = "some-agent-suffix-GREEN";
        // CR-CRU-056 §S2 — RED is this test's genuine subject too (proving
        // the id's "-GREEN" suffix never overrides the declared RED), so it
        // is bound rather than swapped for an incidental role.
        const { cycleId } = await fileAndActivate(key, "some-agent-suffix-GREEN-cycle");

        await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "RED",
          cycleId,
        });

        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        expect(agent!.role).toBe("RED");
        expect(agent!.role).not.toBe("GREEN");
      },
    );
  });

  // ── §S1(a) — the heartbeat/register split decision ─────────────────────

  describe('§S1(a) heartbeat contract — DECISION: role is required on register but NOT on heartbeat', () => {
    test(
      "POST /api/v2/agents/heartbeat with NO role field on an already-registered agent still " +
        "succeeds (200, ok:true) AND does NOT blank the agent's stored role — heartbeat is not " +
        "a re-declaration",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = seedProject(handle.store);
        const agentId = "role-heartbeat-1";

        // CR-CRU-056 C2 final sweep: the heartbeat/blank-preservation
        // contract is this test's actual subject, not the specific VERIFY
        // TDD role (already covered bound in the enumeration-loop test
        // above) — "report" keeps the assertion exactly as strong without
        // an incidental cycle-binding fixture.
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

        // The behavioural crux of the decision: a heartbeat that never
        // declared a role must not have erased the one register set.
        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        expect(agent!.role).toBe("report");
      },
    );
  });

  // ── §S1(c) — an ingest must NEVER de-role an agent ─────────────────────

  describe("§S1(c) an ingest never de-roles an agent (defect's second door)", () => {
    // CR-CRU-056 C2 final sweep: this describe already exercises TWO roles
    // ("report" here, "ORCHESTRATOR" in the next test) to prove the
    // ingest-never-blanks contract holds regardless of the registered
    // role — the specific value is incidental to that purpose (the
    // enumeration itself, including every TDD role bound, is covered by
    // the loop test above), so "report" avoids an incidental cycle-binding
    // fixture without weakening this test's assertions at all.
    test(
      "register with role:\"report\", then POST a run to /api/v2/runs/parsed for the SAME " +
        "agent (runs carry no role) -> GET /api/v2/agents still reads role:\"report\", not null",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = seedProject(handle.store);
        const agentId = "role-ingest-1";

        await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });

        const runRes = await postJson("/api/v2/runs/parsed", {
          projectKey: key,
          agentId,
          summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 10 },
          tree: [],
        });
        expect(runRes.status).toBe(200);
        const runBody = (await runRes.json()) as OkResponse;
        expect(runBody.ok).toBe(true);

        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        // POSITIVE — still exactly report.
        expect(agent!.role).toBe("report");
        // NEGATIVE bound — the ingest touch must never have written null/undefined over it.
        expect(agent!.role).not.toBeNull();
        expect(agent!.role).not.toBeUndefined();
      },
    );

    test(
      "role survives MULTIPLE role-less ingests in a row (repeated touchAgent calls with no " +
        "options must each preserve, never progressively erase, the stored value)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = seedProject(handle.store);
        const agentId = "role-ingest-2";

        await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });

        for (let i = 0; i < 3; i++) {
          const res = await postJson("/api/v2/runs/parsed", {
            projectKey: key,
            agentId,
            summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
            tree: [],
          });
          expect(res.status).toBe(200);
        }

        const listRes = await getJson(`/api/v2/agents?project=${key}`);
        const listBody = (await listRes.json()) as AgentsListResponse;
        const agent = listBody.agents.find((a) => a.agentId === agentId);
        expect(agent!.role).toBe("ORCHESTRATOR");
      },
    );
  });

  // ── §S1(d) — historical records + migration ────────────────────────────

  describe("§S1(d) historical records read back cleanly + the agents table migrates", () => {
    let tmpDir: string | undefined;

    afterEach(() => {
      if (tmpDir !== undefined) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    test("opening a pre-CR-044 db (agents table with no role column) via the real Store.open migrates the column in cleanly, preserving the legacy row's other fields", async () => {
      tmpDir = freshTmpDir();
      const dbPath = path.join(tmpDir, "legacy.db");
      const projectKey = crypto.randomUUID();
      const agentId = "legacy-agent-1";
      seedLegacyDb(dbPath, projectKey, agentId);

      const store = Store.open(dbPath);
      try {
        // The ALTER TABLE retrofit (src/store.ts:358-431 pattern) must have
        // added the column — checked via the same raw-db escape hatch
        // tests/agent-lifecycle.test.ts already uses.
        const columns = (store as unknown as { db: Database })
          .db.query<{ name: string }, []>(`PRAGMA table_info(agents)`)
          .all()
          .map((col) => col.name);
        expect(columns).toContain("role");

        // The pre-existing row must still read back cleanly through the
        // public API — no throw, other fields intact.
        const legacyAgent = store.getAgent(projectKey, agentId);
        expect(legacyAgent).not.toBeNull();
        expect(legacyAgent!.message).toBe("pre-CR-044 message");
        expect(legacyAgent!.status).toBe("online");
      } finally {
        (store as unknown as { db: Database }).db.close();
      }
    });

    test(
      "via the real HTTP API: a legacy agent (seeded pre-migration, no role) coexists with a " +
        "freshly-registered agent that DOES carry role — the legacy entry's role is absent/null " +
        "(never an error, never fabricated), the fresh entry's role is exactly what it declared",
      async () => {
        tmpDir = freshTmpDir();
        const dbPath = path.join(tmpDir, "legacy-api.db");
        const projectKey = crypto.randomUUID();
        const legacyAgentId = "legacy-agent-2";
        seedLegacyDb(dbPath, projectKey, legacyAgentId);

        handle = startServer({ port: 0, dbPath });

        // CR-CRU-056 C2 final sweep: this test's subject is legacy/fresh
        // coexistence + exact-value round-trip, not the RED TDD role
        // specifically (already covered bound in the enumeration-loop test
        // above) — "report" registers unbound, avoiding an incidental
        // plan/cycle fixture on a project seeded via a raw pre-migration
        // schema.
        const freshAgentId = "fresh-agent-1";
        const regRes = await postJson("/api/v2/agents/register", {
          projectKey,
          agentId: freshAgentId,
          role: "report",
        });
        expect(regRes.status).toBe(200);

        const listRes = await getJson(`/api/v2/agents?project=${projectKey}`);
        expect(listRes.status).toBe(200);
        const listBody = (await listRes.json()) as AgentsListResponse;

        const legacy = listBody.agents.find((a) => a.agentId === legacyAgentId);
        const fresh = listBody.agents.find((a) => a.agentId === freshAgentId);
        expect(legacy).toBeDefined();
        expect(fresh).toBeDefined();

        // No back-fill (Non-goals) — the legacy row never had a role and
        // must not be silently assigned one.
        expect(legacy!.role === undefined || legacy!.role === null).toBe(true);
        // The fresh registration's declared value round-trips exactly.
        expect(fresh!.role).toBe("report");
      },
    );
  });
});
