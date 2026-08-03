// CR-CRU-059 C3 (server) — §S1 `identity.source` validation.
//
// Context (docs/changes/CR-CRU-059-identity-source-validation.md):
//   Every client documents `--source {claude-md,package-json,git-repo,manual}`
//   and argparse enforces it, but the server's ENTIRE handling today
//   (src/v2.ts:485, inside handleAgentTouch) is a bare type ASSERTION:
//
//     if (typeof body.identity === "object" && body.identity !== null) {
//       opts.identity = body.identity as AgentIdentity;
//     }
//
//   `AgentIdentity.source` is typed `string?` (src/types.ts:29-33) — any
//   string at all stores cleanly. This was not hypothetical: CR-CRU-054's
//   inventory found rust/mvn/arduino building the register payload directly
//   with a hardcoded `source: "openclaw"` — a value OUTSIDE their own
//   documented enum — shipping undetected for months.
//
//   §S1 requires `IDENTITY_SOURCES = ["claude-md","package-json","git-repo",
//   "manual"]` enforced at the route boundary alongside the existing `role`
//   check: an out-of-enum source -> 409, ok:false, state-derived help[]
//   naming the received value and the valid set; nothing stored. An ABSENT
//   source stays legal (optional today, this CR does not make it required).
//
// RED phase: NONE of this exists in production yet. `body.identity` passes
// through as a bare assertion with zero validation, so every out-of-enum
// case below currently returns 200/ok:true and stores the bad value instead
// of the 409 this file asserts. Every assertion fails today for that reason.
//
// Harness: drives the REAL production server (startServer) + real HTTP, same
// pattern as tests/agent-role-required.test.ts (whose `errorSurface` /
// `postJson` / `getJson` / `seedProject` conventions this file mirrors).
//
// Does NOT touch src/ or clients/ — tests only.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

type ServerHandle = ReturnType<typeof startServer>;

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

interface AgentIdentityBrief {
  displayName?: string;
  source?: string;
  repoPath?: string;
  [key: string]: unknown;
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: string;
  role?: string | null;
  identity?: AgentIdentityBrief;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

/** The exact four-member enumeration §S1 requires the server to accept and
 * to name in its rejection error (docs/changes/CR-CRU-059 §S1, mirroring
 * the clients' `--source {claude-md,package-json,git-repo,manual}`). */
const SOURCE_ENUM = ["claude-md", "package-json", "git-repo", "manual"] as const;

/** Concatenate every string-ish field an AXI error could carry content in,
 * mirroring tests/agent-role-required.test.ts's `errorSurface` so the
 * assertion survives whatever exact wording GREEN picks while still
 * requiring the accepted values (and the received one) to be NAMED. */
function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`;
}

describe("CR-CRU-059 §S1 — identity.source validated at the route boundary (server)", () => {
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

  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
    return key;
  }

  async function findAgent(key: string, agentId: string): Promise<AgentBrief | undefined> {
    const listRes = await getJson(`/api/v2/agents?project=${key}`);
    const listBody = (await listRes.json()) as AgentsListResponse;
    return listBody.agents.find((a) => a.agentId === agentId);
  }

  // ── every valid enum member registers ──────────────────────────────────

  describe("§S1 every valid enum member registers successfully", () => {
    for (const value of SOURCE_ENUM) {
      test(`identity.source:"${value}" is ACCEPTED (200, ok:true) and round-trips exactly`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = `source-accept-${value}`;

        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "report",
          identity: { displayName: agentId, source: value, repoPath: "/tmp/p" },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as OkResponse;
        expect(body.ok).toBe(true);
        expect(store.hasAgent(key, agentId)).toBe(true);

        // Not just "accepted" — the EXACT declared value is what's stored
        // and returned (a validator that accepts everything but discards or
        // coerces the value would still pass the checks above but fail here).
        const agent = await findAgent(key, agentId);
        expect(agent).toBeDefined();
        expect(agent!.identity?.source).toBe(value);
      });
    }
  });

  // ── out-of-enum source is refused ──────────────────────────────────────

  describe("§S1 an out-of-enum source is REJECTED (409, ok:false, help[] naming received value + valid set); nothing stored", () => {
    test(
      'the historical drift case: identity.source:"openclaw" (CR-CRU-054\'s hardcoded, ' +
        "outside-the-enum value) is refused",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = "source-reject-openclaw";

        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "report",
          identity: { displayName: agentId, source: "openclaw" },
        });

        expect(res.status).toBe(409);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        expect(Array.isArray(body.help)).toBe(true);
        expect((body.help as unknown[]).length).toBeGreaterThan(0);

        const surface = errorSurface(body);
        // NAMES the received value.
        expect(surface).toContain("openclaw");
        // NAMES the whole valid set.
        for (const value of SOURCE_ENUM) {
          expect(surface).toContain(value);
        }
        // Nothing stored — no partial write on a rejected registration.
        expect(store.hasAgent(key, agentId)).toBe(false);
      },
    );

    test("an empty-string source is refused the same way", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-reject-empty";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: { displayName: agentId, source: "" },
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);

      const surface = errorSurface(body);
      // The received (empty-string) value is named — JSON.stringify("")
      // renders as the two-character token `""`, mirroring the existing
      // role-required error's `JSON.stringify(role)` convention
      // (src/v2.ts:453).
      expect(surface).toContain('""');
      for (const value of SOURCE_ENUM) {
        expect(surface).toContain(value);
      }
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("a non-string source (a number) is refused the same way", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-reject-number";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: { displayName: agentId, source: 42 },
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);

      const surface = errorSurface(body);
      expect(surface).toContain("42");
      for (const value of SOURCE_ENUM) {
        expect(surface).toContain(value);
      }
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("a non-string source (an object) is refused the same way", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-reject-object";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: { displayName: agentId, source: { nested: true } },
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);

      const surface = errorSurface(body);
      // JSON.stringify({nested:true}) => '{"nested":true}' — the received
      // value must be named, not merely "invalid type".
      expect(surface).toContain("nested");
      for (const value of SOURCE_ENUM) {
        expect(surface).toContain(value);
      }
      expect(store.hasAgent(key, agentId)).toBe(false);
    });
  });

  // ── absent source / absent identity stay legal ─────────────────────────

  describe("§S1 an ABSENT source (or absent identity entirely) still registers — this CR does not make it required", () => {
    test("identity present but with NO source field registers successfully (200, ok:true)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-absent-field";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: { displayName: agentId },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(store.hasAgent(key, agentId)).toBe(true);

      const agent = await findAgent(key, agentId);
      expect(agent).toBeDefined();
      expect(agent!.identity?.source === undefined || agent!.identity?.source === null).toBe(
        true,
      );
      // The sibling field still stored correctly.
      expect(agent!.identity?.displayName).toBe(agentId);
    });

    test("NO identity object at all registers successfully (200, ok:true)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-absent-identity";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(store.hasAgent(key, agentId)).toBe(true);
    });
  });

  // ── sibling identity fields are unaffected (regression guard) ──────────

  describe("§S1 displayName/repoPath are unaffected by the source validator (regression guard)", () => {
    test("a valid source alongside displayName + repoPath stores ALL THREE fields exactly", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-siblings-1";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: {
          displayName: "Sibling Display Name",
          source: "git-repo",
          repoPath: "/home/example/repo",
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const agent = await findAgent(key, agentId);
      expect(agent).toBeDefined();
      // A careless validator that rejects the whole object, or a sloppy one
      // that mutates siblings while checking source, would fail here.
      expect(agent!.identity?.displayName).toBe("Sibling Display Name");
      expect(agent!.identity?.source).toBe("git-repo");
      expect(agent!.identity?.repoPath).toBe("/home/example/repo");
    });
  });

  // ── the heartbeat path shares the same validation seam ─────────────────

  describe("§S1 heartbeat shares the validation seam (handleAgentTouch)", () => {
    test("a heartbeat carrying a valid source succeeds (200, ok:true) and updates the stored value", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "source-heartbeat-valid";

      const regRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        role: "report",
        identity: { displayName: agentId, source: "claude-md" },
      });
      expect(regRes.status).toBe(200);

      const hbRes = await postJson("/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId,
        identity: { source: "package-json" },
      });
      expect(hbRes.status).toBe(200);
      const hbBody = (await hbRes.json()) as OkResponse;
      expect(hbBody.ok).toBe(true);

      const agent = await findAgent(key, agentId);
      expect(agent).toBeDefined();
      expect(agent!.identity?.source).toBe("package-json");
    });

    test(
      "a heartbeat carrying an out-of-enum source is refused the SAME way (409, ok:false, " +
        "help[] naming the received value + valid set) and does NOT overwrite the stored value",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = "source-heartbeat-invalid";

        const regRes = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "report",
          identity: { displayName: agentId, source: "manual" },
        });
        expect(regRes.status).toBe(200);

        const hbRes = await postJson("/api/v2/agents/heartbeat", {
          projectKey: key,
          agentId,
          identity: { source: "openclaw" },
        });

        expect(hbRes.status).toBe(409);
        const hbBody = (await hbRes.json()) as ErrResponse;
        expect(hbBody.ok).toBe(false);
        expect(Array.isArray(hbBody.help)).toBe(true);
        expect((hbBody.help as unknown[]).length).toBeGreaterThan(0);

        const surface = errorSurface(hbBody);
        expect(surface).toContain("openclaw");
        for (const value of SOURCE_ENUM) {
          expect(surface).toContain(value);
        }

        // NEGATIVE bound — the rejected heartbeat must not have clobbered
        // the previously-registered valid value.
        const agent = await findAgent(key, agentId);
        expect(agent).toBeDefined();
        expect(agent!.identity?.source).toBe("manual");
        expect(agent!.identity?.source).not.toBe("openclaw");
      },
    );
  });
});
