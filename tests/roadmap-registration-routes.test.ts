// CR-CRU-091 — roadmap registration is declared: the WIRE half (cycle C2).
//
// Covers §S3 (the verbs + the ORCHESTRATOR-only role gate), §S4 (`wave-sequence`
// is ONE call carrying the whole ordered list), §S5 (dependency validation
// severities), §S7 (idempotency / `converged`) and §S8 (the five routes, named)
// at the REST boundary, plus the three settled decisions C1 handed forward:
// AC21 (a revision retires its predecessor), AC22 (a live proposal survives the
// retention cap) and AC23 (a defaulted `seq` is named in a warning).
//
// The client verbs (C3, `clients/**`) and the roadmap render (C4, `public/**`)
// are NOT touched here.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// C1 landed the storage: `queue_entries` carries `release` / `track` /
// `lifecycle_json`, `listQueue` publishes `seq`, `listReleaseProposals` reads
// the live proposals, and `replaceQueue` carries a declaration forward. NOTHING
// on the wire can reach any of it. `src/v2.ts`'s project-scoped dispatch
// (src/v2.ts:2268-2301) knows `plans`, `archive`, `stop`, `releases` and
// `queue`, and not one of §S8's five routes exists — so a release cannot be
// proposed, a CR cannot be planned, a wave cannot be sequenced, and a dead CR
// can only be deleted by omission from a full replace. There is no role gate
// either: `requireRegisteredCaller` (src/v2.ts:221-236) accepts a RED agent on
// every mutating verb in the system.
//
// ── The seams GREEN must expose (this suite is written against them) ───────
//
//   POST …/projects/<key>/release-proposals  {label, targetAt?}
//        → {ok, converged, proposal:{label, targetAt?}}
//   GET  …/projects/<key>/release-proposals
//        → {ok, proposals:[{label, targetAt?, timestamp, waves[]}], totalCount}
//   POST …/projects/<key>/queue/plan         {cr, release, wave, title}
//        → {ok, converged, entry, warnings[], unknownDependencies[]}
//   POST …/projects/<key>/queue/sequence     {release, wave, crs[], track?}
//        → {ok, converged, entries[], warnings[], unknownDependencies[]}
//   POST …/projects/<key>/queue/<cr>/supersede {by}
//        → {ok, converged, entry, resolvedDependants[]}
//   POST …/projects/<key>/queue/<cr>/void      {reason}
//        → {ok, converged, entry, brokenDependants[]}
//
//   A `warnings[]` member is an OBJECT: {code, message, crs?, containers?} —
//   structured because the five clients RENDER it and must not parse prose.
//
// Every server here is booted on an OS-assigned port against an mkdtempSync
// scratch db. The live data/crucible.db and port 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes this suite PINS ────────────────────────────────────────────

interface QueueEntryWire {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: string;
  seq: number;
  release?: string;
  track?: string;
  lifecycle?: { state: string; by?: string; reason?: string; at: number };
  [key: string]: unknown;
}

interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
  [key: string]: unknown;
}

interface ProposalWire {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  proposal?: { label: string; targetAt?: number };
  proposals?: ProposalWire[];
  totalCount?: number;
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  unknownDependencies?: string[];
  resolvedDependants?: string[];
  brokenDependants?: string[];
  planId?: number;
  cycles?: Array<{ id: number; label: string }>;
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";
const RED_AGENT = "red-1";
const ROLELESS = "legacy-pre-cr044";

describe("CR-CRU-091 §S3/§S4/§S5/§S7/§S8 — the wire: five routes + the role gate", () => {
  let handle: ServerHandle | undefined;
  let dbPath = "";
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru091-routes-"));
    scratchDirs.push(dir);
    dbPath = join(dir, "crucible.db");
    handle = startServer({ port: 0, dbPath });
    return handle;
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await send("POST", path, body);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await send("GET", path);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  /** A project plus the three callers the role gate is asserted against.
   *
   *  The RED caller cannot register unbound (CR-CRU-056 §S1 refuses an
   *  unbound TDD registration, 409), so the fixture files a throwaway plan on
   *  a cr that never enters the queue and binds RED to its ACTIVE cycle. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    const orchestrator = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(orchestrator.status).toBe(200);

    const filed = await post(`/api/v2/projects/${key}/plans`, {
      agentId: ORCH,
      cr: "CR-FIXTURE-BIND",
      cycles: [{ label: "solo" }],
    });
    expect(filed.status).toBe(201);
    const planId = filed.body.planId;
    const cycleId = filed.body.cycles![0]!.id;
    const activated = await send(
      "PATCH",
      `/api/v2/projects/${key}/plans/${String(planId)}/cycles/${String(cycleId)}`,
      { agentId: ORCH, status: "active" },
    );
    expect(activated.status).toBe(200);
    const red = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: RED_AGENT,
      role: "RED",
      cycleId,
    });
    expect(red.status).toBe(200);

    // A pre-CR-044 row: registered, LIVE, and carrying no role at all. The
    // register route cannot make one (role is required there), and it is never
    // fabricated — so the gate must refuse it rather than assume orchestrator.
    handle!.store.touchAgent(key, ROLELESS);
    expect(handle!.store.getAgent(key, ROLELESS)?.role).toBeUndefined();
    return key;
  }

  function proposalsPath(key: string): string {
    return `/api/v2/projects/${key}/release-proposals`;
  }

  function queuePath(key: string): string {
    return `/api/v2/projects/${key}/queue`;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }

  function sequencePath(key: string): string {
    return `/api/v2/projects/${key}/queue/sequence`;
  }

  function lifecyclePath(key: string, cr: string, verb: string): string {
    return `/api/v2/projects/${key}/queue/${cr}/${verb}`;
  }

  async function propose(
    key: string,
    label: string,
    targetAt?: number,
    agentId: string = ORCH,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(proposalsPath(key), {
      agentId,
      label,
      ...(targetAt !== undefined ? { targetAt } : {}),
    });
  }

  async function plan(
    key: string,
    cr: string,
    release: string,
    wave: number | string,
    title: string,
    agentId: string = ORCH,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(planPath(key), { agentId, cr, release, wave, title });
  }

  async function sequence(
    key: string,
    release: string,
    wave: number | string,
    crs: unknown[],
    track?: string,
    agentId: string = ORCH,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(sequencePath(key), {
      agentId,
      release,
      wave,
      crs,
      ...(track !== undefined ? { track } : {}),
    });
  }

  async function queueEntries(key: string): Promise<QueueEntryWire[]> {
    const res = await get(queuePath(key));
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  async function entryOf(key: string, cr: string): Promise<QueueEntryWire | undefined> {
    return (await queueEntries(key)).find((e) => e.cr === cr);
  }

  /** Reads the stored rows through a SECOND connection — `filed_at` is not on
   *  the wire, and AC12 turns on it not moving. */
  function storedRows(key: string): Array<Record<string, unknown>> {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .query(`SELECT * FROM queue_entries WHERE project_key = ? ORDER BY cr ASC`)
        .all(key) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  /** The same rows keyed by cr. AC8's "no row in any other wave or release
   *  changes ANY field" is a WHOLE-ROW comparison — a seq-only one would miss
   *  a stray `track`. */
  function rowsByCr(key: string): Map<string, Record<string, unknown>> {
    return new Map(storedRows(key).map((row) => [String(row.cr), row]));
  }

  // ── §S8 — the five routes answer at exactly their named path/method ───────

  describe("§S8 — the five routes, at the exact method + path + body the table names", () => {
    test(
      "release-propose → POST …/release-proposals {label,targetAt} answers " +
        "{ok,converged,proposal}, and GET …/release-proposals reads it back",
      async () => {
        boot();
        const key = await seed("s8-propose");

        const posted = await propose(key, "0.2.0", 1_787_149_125);
        expect(posted.status).toBe(200);
        expect(posted.body.ok).toBe(true);
        expect(posted.body.converged).toBe(false);
        expect(posted.body.proposal).toEqual({ label: "0.2.0", targetAt: 1_787_149_125 });

        const read = await get(proposalsPath(key));
        expect(read.status).toBe(200);
        expect(read.body.ok).toBe(true);
        expect(read.body.totalCount).toBe(1);
        const [only] = read.body.proposals!;
        expect(only!.label).toBe("0.2.0");
        expect(only!.targetAt).toBe(1_787_149_125);
        expect(typeof only!.timestamp).toBe("number");
        expect(only!.waves).toEqual([]);
      },
    );

    test(
      "GET …/release-proposals lists LIVE proposals ASCENDING by version, with the " +
        "waves already planned against each",
      async () => {
        boot();
        const key = await seed("s8-proposal-read");
        await propose(key, "0.3.0");
        await propose(key, "0.2.1");
        await plan(key, "CR-CRU-070", "0.2.1", 4, "an earlier wave");
        await plan(key, "CR-CRU-071", "0.2.1", 5, "a later wave");

        const read = await get(proposalsPath(key));
        expect(read.body.proposals!.map((p) => p.label)).toEqual(["0.2.1", "0.3.0"]);
        expect(read.body.proposals![0]!.waves).toEqual(["4", "5"]);
        expect(read.body.proposals![1]!.waves).toEqual([]);
        // A proposal carrying no target declares none — never a fabricated 0.
        expect("targetAt" in read.body.proposals![1]!).toBe(false);
      },
    );

    test(
      "cr-plan → POST …/queue/plan {cr,release,wave,title} answers " +
        "{ok,converged,entry,warnings} and upserts ONE row",
      async () => {
        boot();
        const key = await seed("s8-cr-plan");
        await propose(key, "0.2.0");

        const planned = await plan(key, "CR-CRU-091", "0.2.0", 5, "roadmap registration");
        expect(planned.status).toBe(200);
        expect(planned.body.ok).toBe(true);
        expect(planned.body.converged).toBe(false);
        expect(Array.isArray(planned.body.warnings)).toBe(true);
        expect(planned.body.entry!.cr).toBe("CR-CRU-091");
        expect(planned.body.entry!.release).toBe("0.2.0");
        expect(planned.body.entry!.wave).toBe("5");
        expect(planned.body.entry!.title).toBe("roadmap registration");
        expect(typeof planned.body.entry!.seq).toBe("number");

        const stored = await entryOf(key, "CR-CRU-091");
        expect(stored!.release).toBe("0.2.0");
        expect(stored!.wave).toBe("5");
        expect(stored!.title).toBe("roadmap registration");

        // A RE-plan is legitimate, not an error: the same row moves.
        const replanned = await plan(key, "CR-CRU-091", "0.2.0", 6, "roadmap registration");
        expect(replanned.status).toBe(200);
        expect(replanned.body.converged).toBe(false);
        expect((await queueEntries(key)).filter((e) => e.cr === "CR-CRU-091")).toHaveLength(1);
        expect((await entryOf(key, "CR-CRU-091"))!.wave).toBe("6");
      },
    );

    test(
      "wave-sequence → POST …/queue/sequence {release,wave,crs,track} answers " +
        "{ok,converged,entries,warnings} and the ARRAY POSITION becomes seq",
      async () => {
        boot();
        const key = await seed("s8-wave-sequence");
        await propose(key, "0.2.0");
        for (const cr of ["CR-A", "CR-B", "CR-C"]) {
          await plan(key, cr, "0.2.0", 5, `title ${cr}`);
        }

        // §S4 — ONE call carrying the WHOLE ordered list; the order is the payload.
        const sequenced = await sequence(key, "0.2.0", 5, ["CR-C", "CR-A", "CR-B"], "2");
        expect(sequenced.status).toBe(200);
        expect(sequenced.body.ok).toBe(true);
        expect(sequenced.body.converged).toBe(false);
        expect(sequenced.body.entries!.map((e) => e.cr)).toEqual(["CR-C", "CR-A", "CR-B"]);

        const stored = (await queueEntries(key)).filter((e) => e.wave === "5");
        // listQueue is ORDER BY seq, so the read order IS the authored order.
        expect(stored.map((e) => e.cr)).toEqual(["CR-C", "CR-A", "CR-B"]);
        const seqs = stored.map((e) => e.seq);
        expect(seqs[0]! < seqs[1]!).toBe(true);
        expect(seqs[1]! < seqs[2]!).toBe(true);
        // Dense across the wave: strictly increasing by exactly one.
        expect(seqs[1]! - seqs[0]!).toBe(1);
        expect(seqs[2]! - seqs[1]!).toBe(1);
        // §S4 — --track applies to EVERY cr in the list.
        expect(stored.map((e) => e.track)).toEqual(["track-2", "track-2", "track-2"]);
      },
    );

    test(
      "cr-supersede → POST …/queue/<cr>/supersede {by} answers " +
        "{ok,converged,entry,resolvedDependants} and NEVER deletes the row",
      async () => {
        boot();
        const key = await seed("s8-supersede");
        await propose(key, "0.2.0");
        await plan(key, "CR-X", "0.2.0", 5, "the superseded one");

        const res = await post(lifecyclePath(key, "CR-X", "supersede"), {
          agentId: ORCH,
          by: "CR-Y",
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.converged).toBe(false);
        expect(res.body.entry!.lifecycle!.state).toBe("SUPERSEDED");
        expect(res.body.entry!.lifecycle!.by).toBe("CR-Y");
        expect(typeof res.body.entry!.lifecycle!.at).toBe("number");
        expect(Array.isArray(res.body.resolvedDependants)).toBe(true);

        const stored = await entryOf(key, "CR-X");
        expect(stored).toBeDefined();
        expect(stored!.lifecycle!.state).toBe("SUPERSEDED");
        // §S2 — lifecycle is a SECOND AXIS: status is untouched by it.
        expect(stored!.status).toBe("PENDING");
      },
    );

    test(
      "cr-void → POST …/queue/<cr>/void {reason} answers " +
        "{ok,converged,entry,brokenDependants} and NEVER deletes the row",
      async () => {
        boot();
        const key = await seed("s8-void");
        await propose(key, "0.2.0");
        await plan(key, "CR-X", "0.2.0", 5, "the voided one");

        const res = await post(lifecyclePath(key, "CR-X", "void"), {
          agentId: ORCH,
          reason: "folded into CR-CRU-078",
        });
        expect(res.status).toBe(200);
        expect(res.body.converged).toBe(false);
        expect(res.body.entry!.lifecycle!.state).toBe("VOID");
        expect(res.body.entry!.lifecycle!.reason).toBe("folded into CR-CRU-078");
        expect(Array.isArray(res.body.brokenDependants)).toBe(true);

        const stored = await entryOf(key, "CR-X");
        expect(stored).toBeDefined();
        expect(stored!.lifecycle!.state).toBe("VOID");
      },
    );
  });

  // ── AC20 — the two halves meet EXACTLY at §S8, and nowhere else ───────────

  describe("AC20 — the neighbouring shapes a guess would produce are 404", () => {
    test(
      "POST …/queue/cr-plan, POST …/proposals and PATCH …/queue/<cr> all 404; " +
        "no PATCH/PUT/DELETE route was added",
      async () => {
        boot();
        const key = await seed("ac20-neighbours");
        await propose(key, "0.2.0");
        await plan(key, "CR-X", "0.2.0", 5, "planned");

        // The verb name is NOT the path segment — the path is `queue/plan`.
        expect(
          (await send("POST", `/api/v2/projects/${key}/queue/cr-plan`, { agentId: ORCH })).status,
        ).toBe(404);
        expect(
          (await send("POST", `/api/v2/projects/${key}/queue/wave-sequence`, { agentId: ORCH }))
            .status,
        ).toBe(404);
        // The proposals read is `release-proposals`, never `proposals`.
        expect((await send("GET", `/api/v2/projects/${key}/proposals`)).status).toBe(404);
        expect((await send("POST", `/api/v2/projects/${key}/proposals`, { agentId: ORCH })).status)
          .toBe(404);
        // §S8 — no PATCH, no PUT, no DELETE: re-planning is a re-POST.
        expect(
          (await send("PATCH", `/api/v2/projects/${key}/queue/CR-X`, { agentId: ORCH })).status,
        ).toBe(404);
        expect(
          (await send("PUT", `/api/v2/projects/${key}/queue/plan`, { agentId: ORCH })).status,
        ).toBe(404);
        expect((await send("DELETE", `/api/v2/projects/${key}/queue/CR-X`)).status).toBe(404);
        expect((await send("PATCH", proposalsPath(key), { agentId: ORCH })).status).toBe(404);
        expect((await send("DELETE", proposalsPath(key))).status).toBe(404);
      },
    );
  });

  // ── AC16 — ORCHESTRATOR only, on every one of the five routes ─────────────

  describe("AC16 — the role gate refuses three ways, and writes nothing on any of them", () => {
    /** The five §S8 write routes, each with a valid body minus the caller. */
    function routes(key: string): Array<{ name: string; path: string; body: Record<string, unknown> }> {
      return [
        { name: "release-propose", path: proposalsPath(key), body: { label: "0.9.9" } },
        {
          name: "cr-plan",
          path: planPath(key),
          body: { cr: "CR-GATE", release: "0.2.0", wave: 5, title: "gate probe" },
        },
        {
          name: "wave-sequence",
          path: sequencePath(key),
          body: { release: "0.2.0", wave: 5, crs: ["CR-SEEDED"] },
        },
        {
          name: "cr-supersede",
          path: lifecyclePath(key, "CR-SEEDED", "supersede"),
          body: { by: "CR-OTHER" },
        },
        {
          name: "cr-void",
          path: lifecyclePath(key, "CR-SEEDED", "void"),
          body: { reason: "gate probe" },
        },
      ];
    }

    async function snapshot(key: string): Promise<string> {
      const queue = await queueEntries(key);
      const proposals = (await get(proposalsPath(key))).body.proposals;
      return JSON.stringify({ queue, proposals });
    }

    test("an UNREGISTERED caller gets 409 on all five routes and nothing is written", async () => {
      boot();
      const key = await seed("ac16-unregistered");
      await propose(key, "0.2.0");
      await plan(key, "CR-SEEDED", "0.2.0", 5, "seeded");
      const before = await snapshot(key);

      for (const route of routes(key)) {
        const res = await post(route.path, { ...route.body, agentId: "ghost-agent" });
        expect(`${route.name}:${res.status}`).toBe(`${route.name}:409`);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toContain("ghost-agent");
        expect(Array.isArray(res.body.help)).toBe(true);
      }
      expect(await snapshot(key)).toBe(before);
    });

    test(
      "a caller registered RED is refused on all five routes with an error NAMING " +
        "the required role, and nothing is written",
      async () => {
        boot();
        const key = await seed("ac16-red");
        await propose(key, "0.2.0");
        await plan(key, "CR-SEEDED", "0.2.0", 5, "seeded");
        const before = await snapshot(key);

        for (const route of routes(key)) {
          const res = await post(route.path, { ...route.body, agentId: RED_AGENT });
          expect(`${route.name}:${res.status}`).toBe(`${route.name}:409`);
          expect(res.body.ok).toBe(false);
          expect(res.body.error).toContain("ORCHESTRATOR");
          expect(res.body.error).toContain("RED");
          expect(res.body.error).toContain(RED_AGENT);
          expect(Array.isArray(res.body.help)).toBe(true);
        }
        expect(await snapshot(key)).toBe(before);
      },
    );

    test(
      "an agent row with NO stored role is REFUSED rather than assumed to be an " +
        "orchestrator, on all five routes, and nothing is written",
      async () => {
        boot();
        const key = await seed("ac16-roleless");
        await propose(key, "0.2.0");
        await plan(key, "CR-SEEDED", "0.2.0", 5, "seeded");
        const before = await snapshot(key);

        for (const route of routes(key)) {
          const res = await post(route.path, { ...route.body, agentId: ROLELESS });
          expect(`${route.name}:${res.status}`).toBe(`${route.name}:409`);
          expect(res.body.ok).toBe(false);
          expect(res.body.error).toContain("ORCHESTRATOR");
          expect(res.body.error).toContain(ROLELESS);
        }
        expect(await snapshot(key)).toBe(before);
      },
    );

    test("a caller registered ORCHESTRATOR succeeds on all five routes", async () => {
      boot();
      const key = await seed("ac16-orchestrator");
      await propose(key, "0.2.0");
      await plan(key, "CR-SEEDED", "0.2.0", 5, "seeded");

      for (const route of routes(key)) {
        const res = await post(route.path, { ...route.body, agentId: ORCH });
        expect(`${route.name}:${res.status}`).toBe(`${route.name}:200`);
        expect(res.body.ok).toBe(true);
      }
    });
  });

  // ── AC6 / 400 — referential refusals that NAME the state found ────────────

  describe("AC6 + §S8 failure envelopes", () => {
    test(
      "cr-plan against a release with no live proposal is 404 NAMING it, with a " +
        "release-propose help[] entry, and no row created",
      async () => {
        boot();
        const key = await seed("ac6-cr-plan");

        const res = await plan(key, "CR-CRU-091", "9.9.9", 5, "unproposed target");
        expect(res.status).toBe(404);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toContain("9.9.9");
        expect(res.body.help!.join("\n")).toContain("release-propose --label 9.9.9");
        expect(await queueEntries(key)).toEqual([]);
      },
    );

    test("wave-sequence against an unproposed release is 404 naming it, nothing written", async () => {
      boot();
      const key = await seed("ac6-wave-sequence");
      await propose(key, "0.2.0");
      await plan(key, "CR-A", "0.2.0", 5, "planned");
      const before = JSON.stringify(await queueEntries(key));

      const res = await sequence(key, "9.9.9", 5, ["CR-A"]);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("9.9.9");
      expect(JSON.stringify(await queueEntries(key))).toBe(before);
    });

    test(
      "a consumed proposal is no longer a plannable target: once 0.2.0 SHIPS, " +
        "cr-plan --release 0.2.0 is refused naming it",
      async () => {
        boot();
        const key = await seed("ac6-consumed");
        await propose(key, "0.2.0");
        const shipped = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release",
          label: "0.2.0",
          commit: "a".repeat(40),
          releasedAt: 1_787_149_125,
        });
        expect(shipped.status).toBe(201);

        const res = await plan(key, "CR-LATE", "0.2.0", 5, "too late");
        expect(res.status).toBe(404);
        expect(res.body.error).toContain("0.2.0");
        expect(await queueEntries(key)).toEqual([]);
      },
    );

    test("a malformed body 400s NAMING the offending field, and the crs INDEX", async () => {
      boot();
      const key = await seed("ac6-400");
      await propose(key, "0.2.0");
      await plan(key, "CR-A", "0.2.0", 5, "planned");

      const noLabel = await post(proposalsPath(key), { agentId: ORCH });
      expect(noLabel.status).toBe(400);
      expect(noLabel.body.error).toContain("label");

      const badTarget = await post(proposalsPath(key), {
        agentId: ORCH,
        label: "0.7.0",
        targetAt: "yesterday",
      });
      expect(badTarget.status).toBe(400);
      expect(badTarget.body.error).toContain("targetAt");

      const noTitle = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-B",
        release: "0.2.0",
        wave: 5,
      });
      expect(noTitle.status).toBe(400);
      expect(noTitle.body.error).toContain("title");

      const noCr = await post(planPath(key), {
        agentId: ORCH,
        release: "0.2.0",
        wave: 5,
        title: "no cr",
      });
      expect(noCr.status).toBe(400);
      expect(noCr.body.error).toContain("cr");

      // handleQueuePost's precedent: the field AND the index.
      const badMember = await sequence(key, "0.2.0", 5, ["CR-A", 7, "CR-C"]);
      expect(badMember.status).toBe(400);
      expect(badMember.body.error).toContain("crs");
      expect(badMember.body.error).toContain("1");

      const emptyList = await sequence(key, "0.2.0", 5, []);
      expect(emptyList.status).toBe(400);
      expect(emptyList.body.error).toContain("crs");

      const duplicated = await sequence(key, "0.2.0", 5, ["CR-A", "CR-A"]);
      expect(duplicated.status).toBe(400);
      expect(duplicated.body.error).toContain("CR-A");
      expect(duplicated.body.error).toContain("1");

      const noBy = await post(lifecyclePath(key, "CR-A", "supersede"), { agentId: ORCH });
      expect(noBy.status).toBe(400);
      expect(noBy.body.error).toContain("by");

      const noReason = await post(lifecyclePath(key, "CR-A", "void"), { agentId: ORCH });
      expect(noReason.status).toBe(400);
      expect(noReason.body.error).toContain("reason");

      // An unregistered cr has no row to give a lifecycle to — 404 by name.
      const unknownCr = await post(lifecyclePath(key, "CR-NOPE", "void"), {
        agentId: ORCH,
        reason: "never planned",
      });
      expect(unknownCr.status).toBe(404);
      expect(unknownCr.body.error).toContain("CR-NOPE");
    });
  });

  // ── AC7 / AC8 — wave-sequence's referential rules and its blast radius ────

  describe("AC7 + AC8 — sequencing never plans, and touches exactly one container", () => {
    test(
      "an UNPLANNED cr refuses by name and applies nothing; a cr planned into a " +
        "DIFFERENT container refuses naming both containers",
      async () => {
        boot();
        const key = await seed("ac7");
        await propose(key, "0.2.0");
        await plan(key, "CR-CRU-092", "0.2.0", 5, "planned here");
        await plan(key, "CR-CRU-093", "0.2.0", 4, "planned elsewhere");
        const before = JSON.stringify(await queueEntries(key));

        const unplanned = await sequence(key, "0.2.0", 5, ["CR-CRU-092", "CR-CRU-100"]);
        expect(unplanned.status).toBe(404);
        expect(unplanned.body.error).toContain("CR-CRU-100");
        expect(JSON.stringify(await queueEntries(key))).toBe(before);

        const elsewhere = await sequence(key, "0.2.0", 5, ["CR-CRU-092", "CR-CRU-093"]);
        expect(elsewhere.status).toBe(404);
        expect(elsewhere.body.error).toContain("CR-CRU-093");
        // Both containers named: where it IS, and where the call looked.
        expect(elsewhere.body.error).toContain("0.2.0/4");
        expect(elsewhere.body.error).toContain("0.2.0/5");
        expect(JSON.stringify(await queueEntries(key))).toBe(before);
      },
    );

    test(
      "re-sending with two crs swapped exchanges ONLY their seq; an insert shifts " +
        "the tail and touches no other wave or release",
      async () => {
        boot();
        const key = await seed("ac8");
        await propose(key, "0.2.0");
        await propose(key, "0.3.0");
        for (const cr of ["A", "B", "C", "D", "X"]) {
          await plan(key, cr, "0.2.0", 5, `title ${cr}`);
        }
        await plan(key, "OTHER-WAVE", "0.2.0", 6, "another wave");
        // §S8 settled that two releases sharing a wave NUMBER share the seq
        // block, so the other release is planned into wave 5 TOO. Sharing the
        // block is the documented concession; having a row rewritten by the
        // other release's call never was.
        await plan(key, "OTHER-RELEASE", "0.3.0", 5, "another release");
        await sequence(key, "0.2.0", 6, ["OTHER-WAVE"]);
        await sequence(key, "0.3.0", 5, ["OTHER-RELEASE"], "7");

        await sequence(key, "0.2.0", 5, ["A", "B", "C", "D"]);
        const first = rowsByCr(key);

        const swapped = await sequence(key, "0.2.0", 5, ["A", "C", "B", "D"]);
        expect(swapped.status).toBe(200);
        const after = rowsByCr(key);
        expect(after.get("A")!.seq).toBe(first.get("A")!.seq);
        expect(after.get("D")!.seq).toBe(first.get("D")!.seq);
        expect(after.get("B")!.seq).toBe(first.get("C")!.seq);
        expect(after.get("C")!.seq).toBe(first.get("B")!.seq);
        // "changes any field" — whole row, so seq, track, filed_at and
        // lifecycle_json are all inside the comparison.
        expect(after.get("OTHER-WAVE")).toEqual(first.get("OTHER-WAVE")!);
        expect(after.get("OTHER-RELEASE")).toEqual(first.get("OTHER-RELEASE")!);

        // Inserting X shifts C and D by one and leaves every other container alone.
        await sequence(key, "0.2.0", 5, ["A", "B", "X", "C", "D"]);
        const inserted = rowsByCr(key);
        expect(inserted.get("A")!.seq).toBe(first.get("A")!.seq);
        expect(inserted.get("B")!.seq).toBe(first.get("B")!.seq);
        expect(inserted.get("X")!.seq).toBe(first.get("C")!.seq);
        expect(inserted.get("C")!.seq).toBe(first.get("D")!.seq);
        expect(inserted.get("D")!.seq).toBe((first.get("D")!.seq as number) + 1);
        expect(inserted.get("OTHER-WAVE")).toEqual(first.get("OTHER-WAVE")!);
        expect(inserted.get("OTHER-RELEASE")).toEqual(first.get("OTHER-RELEASE")!);
      },
    );

    test(
      "§S4 — --track lands on the crs the list NAMES and on no other member of " +
        "the wave, while an omitted member is still re-seqed after the authored block",
      async () => {
        boot();
        const key = await seed("s4-track-scope");
        await propose(key, "0.13.0");
        for (const cr of ["CR-W1", "CR-W2", "CR-W3"]) {
          await plan(key, cr, "0.13.0", 13, `title ${cr}`);
        }
        await sequence(key, "0.13.0", 13, ["CR-W1", "CR-W2", "CR-W3"], "4");

        const res = await sequence(key, "0.13.0", 13, ["CR-W2", "CR-W1"], "9");
        expect(res.status).toBe(200);
        const rows = rowsByCr(key);
        expect(rows.get("CR-W1")!.track).toBe("track-9");
        expect(rows.get("CR-W2")!.track).toBe("track-9");
        // "--track applies to every cr in the list" — CR-W3 is not in the list,
        // so it keeps the track it already held.
        expect(rows.get("CR-W3")!.track).toBe("track-4");
        // It IS still re-seqed and appended after the authored block (§S8).
        expect(rows.get("CR-W2")!.seq).toBe(13001);
        expect(rows.get("CR-W1")!.seq).toBe(13002);
        expect(rows.get("CR-W3")!.seq).toBe(13003);
        expect(res.body.warnings!.find((w) => w.code === "unsequenced-members")!.crs).toEqual([
          "CR-W3",
        ]);
      },
    );

    test(
      "§S4/AC8 — a call naming ONE release does not touch a row of ANOTHER " +
        "release sharing the wave number: not its seq, not its track, no field",
      async () => {
        boot();
        const key = await seed("s4-release-scope");
        await propose(key, "0.11.0");
        await propose(key, "0.12.0");
        for (const cr of ["CR-U1", "CR-U2", "CR-U3"]) {
          await plan(key, cr, "0.11.0", 11, `title ${cr}`);
        }
        await plan(key, "CR-OTHER-REL", "0.12.0", 11, "same wave number, other release");
        await sequence(key, "0.12.0", 11, ["CR-OTHER-REL"], "8");
        const before = rowsByCr(key).get("CR-OTHER-REL")!;

        const res = await sequence(key, "0.11.0", 11, ["CR-U1", "CR-U2", "CR-U3"], "5");
        expect(res.status).toBe(200);
        // The other release is not a member of this container, so it is not an
        // omitted member either — the answer names exactly the three.
        expect(res.body.entries!.map((e) => e.cr).sort()).toEqual(["CR-U1", "CR-U2", "CR-U3"]);
        expect(res.body.warnings!.find((w) => w.code === "unsequenced-members")).toBeUndefined();

        const after = rowsByCr(key);
        expect(after.get("CR-OTHER-REL")).toEqual(before);
        expect([...new Set(["CR-U1", "CR-U2", "CR-U3"].map((cr) => after.get(cr)!.track))]).toEqual(
          ["track-5"],
        );
        // §S8's tolerated consequence, pinned: the two releases SHARE the wave's
        // block, so they can hold the same seq VALUE. What is not tolerated is
        // one release's call rewriting the other release's row.
        expect(after.get("CR-OTHER-REL")!.seq).toBe(after.get("CR-U1")!.seq);
      },
    );

    test(
      "§S4 — a wave-sequence whose member count would REACH the seq stride is " +
        "refused naming the limit and the count, and writes nothing",
      async () => {
        boot();
        const key = await seed("s4-stride");
        await propose(key, "0.2.0");
        await plan(key, "CR-1", "0.2.0", 5, "title CR-1");
        const before = storedRows(key);

        const crs = Array.from({ length: 1001 }, (_, index) => `CR-${index + 1}`);
        const refused = await sequence(key, "0.2.0", 5, crs);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain("wave 5");
        expect(refused.body.error).toContain("1001");
        expect(refused.body.error).toContain("999");
        expect(storedRows(key)).toEqual(before);
      },
    );

    test("a wave's block sits AFTER every earlier wave of the same release", async () => {
      boot();
      const key = await seed("ac8-global-order");
      await propose(key, "0.2.0");
      await plan(key, "W6-A", "0.2.0", 6, "later wave, planned first");
      await plan(key, "W4-A", "0.2.0", 4, "earlier wave, planned second");
      await sequence(key, "0.2.0", 6, ["W6-A"]);
      await sequence(key, "0.2.0", 4, ["W4-A"]);

      const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
      expect(seqs.get("W4-A")! < seqs.get("W6-A")!).toBe(true);
    });
  });

  // ── AC17 — one track format, `track-<n>` ──────────────────────────────────

  describe("AC17 — --track normalises to track-<n> before storing", () => {
    test(
      "`2`, `track-2` and `Track 2` all store the IDENTICAL value track-2 (one " +
        "distinct value across the three calls); `main` is refused naming it",
      async () => {
        boot();
        const key = await seed("ac17");
        await propose(key, "0.2.0");
        for (const cr of ["CR-1", "CR-2", "CR-3"]) {
          await plan(key, cr, "0.2.0", 5, `title ${cr}`);
        }

        for (const spelling of ["2", "track-2", "Track 2"]) {
          const res = await sequence(key, "0.2.0", 5, ["CR-1", "CR-2", "CR-3"], spelling);
          expect(res.status).toBe(200);
        }
        const tracks = new Set((await queueEntries(key)).map((e) => e.track));
        expect([...tracks]).toEqual(["track-2"]);

        const refused = await sequence(key, "0.2.0", 5, ["CR-1", "CR-2", "CR-3"], "main");
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain("track");
        expect(refused.body.error).toContain("main");
        expect([...new Set((await queueEntries(key)).map((e) => e.track))]).toEqual(["track-2"]);
      },
    );
  });

  // ── §S7 / AC12 — convergence on all five verbs ────────────────────────────

  describe("§S7 + AC12 — a second identical run converges and mutates nothing", () => {
    test("release-propose converges on an identical re-post and writes no second event", async () => {
      boot();
      const key = await seed("s7-propose");
      const first = await propose(key, "0.2.0", 1_787_149_125);
      expect(first.body.converged).toBe(false);

      const again = await propose(key, "0.2.0", 1_787_149_125);
      expect(again.status).toBe(200);
      expect(again.body.converged).toBe(true);
      expect(again.body.proposal).toEqual({ label: "0.2.0", targetAt: 1_787_149_125 });

      const read = await get(proposalsPath(key));
      expect(read.body.proposals).toHaveLength(1);
      expect(read.body.proposals![0]!.timestamp).toBe(
        (await get(proposalsPath(key))).body.proposals![0]!.timestamp,
      );
    });

    test(
      "cr-plan converges when release + wave + title already match, and the " +
        "converged upsert writes NOTHING — filed_at included",
      async () => {
        boot();
        const key = await seed("s7-cr-plan");
        await propose(key, "0.2.0");
        await plan(key, "CR-CRU-091", "0.2.0", 5, "roadmap registration");
        const before = storedRows(key);
        expect(before).toHaveLength(1);

        const again = await plan(key, "CR-CRU-091", "0.2.0", 5, "roadmap registration");
        expect(again.status).toBe(200);
        expect(again.body.converged).toBe(true);
        expect(again.body.warnings).toEqual([]);
        expect(storedRows(key)).toEqual(before);

        // A DIFFERENT title is a real change, not a convergence.
        const retitled = await plan(key, "CR-CRU-091", "0.2.0", 5, "roadmap registration v2");
        expect(retitled.body.converged).toBe(false);
        expect(storedRows(key)[0]!.title).toBe("roadmap registration v2");
        // filed_at is the FILING instant and survives a re-plan.
        expect(storedRows(key)[0]!.filed_at).toBe(before[0]!.filed_at);
      },
    );

    test("wave-sequence converges when the stored order AND track already match", async () => {
      boot();
      const key = await seed("s7-wave-sequence");
      await propose(key, "0.2.0");
      for (const cr of ["CR-1", "CR-2"]) {
        await plan(key, cr, "0.2.0", 5, `title ${cr}`);
      }
      const first = await sequence(key, "0.2.0", 5, ["CR-2", "CR-1"], "3");
      expect(first.body.converged).toBe(false);
      const rows = storedRows(key);

      const again = await sequence(key, "0.2.0", 5, ["CR-2", "CR-1"], "3");
      expect(again.body.converged).toBe(true);
      expect(again.body.warnings).toEqual([]);
      expect(storedRows(key)).toEqual(rows);

      // A different ORDER is a real change; so is a different track.
      expect((await sequence(key, "0.2.0", 5, ["CR-1", "CR-2"], "3")).body.converged).toBe(false);
      expect((await sequence(key, "0.2.0", 5, ["CR-1", "CR-2"], "4")).body.converged).toBe(false);
    });

    test("cr-supersede and cr-void converge on the same state and reference", async () => {
      boot();
      const key = await seed("s7-lifecycle");
      await propose(key, "0.2.0");
      await plan(key, "CR-S", "0.2.0", 5, "to supersede");
      await plan(key, "CR-V", "0.2.0", 5, "to void");

      expect(
        (await post(lifecyclePath(key, "CR-S", "supersede"), { agentId: ORCH, by: "CR-Y" })).body
          .converged,
      ).toBe(false);
      const superseded = storedRows(key);
      const againS = await post(lifecyclePath(key, "CR-S", "supersede"), {
        agentId: ORCH,
        by: "CR-Y",
      });
      expect(againS.body.converged).toBe(true);
      expect(storedRows(key)).toEqual(superseded);
      // A DIFFERENT successor is a real change.
      expect(
        (await post(lifecyclePath(key, "CR-S", "supersede"), { agentId: ORCH, by: "CR-Z" })).body
          .converged,
      ).toBe(false);

      expect(
        (await post(lifecyclePath(key, "CR-V", "void"), { agentId: ORCH, reason: "dropped" })).body
          .converged,
      ).toBe(false);
      const voided = storedRows(key);
      const againV = await post(lifecyclePath(key, "CR-V", "void"), {
        agentId: ORCH,
        reason: "dropped",
      });
      expect(againV.body.converged).toBe(true);
      expect(storedRows(key)).toEqual(voided);
      expect(
        (await post(lifecyclePath(key, "CR-V", "void"), { agentId: ORCH, reason: "other" })).body
          .converged,
      ).toBe(false);
    });

    test(
      "AC12 — a whole generation run end to end TWICE reports converged on every " +
        "verb the second time and leaves every row byte-identical",
      async () => {
        boot();
        const key = await seed("ac12-generation");

        async function generation(): Promise<boolean[]> {
          const converged: boolean[] = [];
          converged.push((await propose(key, "0.2.0", 1_787_149_125)).body.converged!);
          converged.push((await propose(key, "0.3.0")).body.converged!);
          for (const [cr, wave] of [
            ["CR-A", 4],
            ["CR-B", 4],
            ["CR-C", 5],
          ] as const) {
            converged.push((await plan(key, cr, "0.2.0", wave, `title ${cr}`)).body.converged!);
          }
          converged.push((await sequence(key, "0.2.0", 4, ["CR-B", "CR-A"], "1")).body.converged!);
          converged.push((await sequence(key, "0.2.0", 5, ["CR-C"], "2")).body.converged!);
          converged.push(
            (await post(lifecyclePath(key, "CR-A", "supersede"), { agentId: ORCH, by: "CR-B" }))
              .body.converged!,
          );
          converged.push(
            (await post(lifecyclePath(key, "CR-C", "void"), { agentId: ORCH, reason: "dropped" }))
              .body.converged!,
          );
          return converged;
        }

        expect(await generation()).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ]);
        const rows = storedRows(key);
        const proposals = (await get(proposalsPath(key))).body.proposals;

        const second = await generation();
        expect(second.every((c) => c === true)).toBe(true);
        expect(storedRows(key)).toEqual(rows);
        expect((await get(proposalsPath(key))).body.proposals).toEqual(proposals);
      },
    );
  });

  // ── §S5 / AC9 / AC10 — the four dependency severities ─────────────────────

  describe("§S5 — a cycle refuses; everything else warns and stands as authored", () => {
    /** Seeds the dependency graph through the EXISTING full-replace route. */
    async function seedGraph(
      key: string,
      entries: Array<Record<string, unknown>>,
    ): Promise<void> {
      const res = await post(queuePath(key), { agentId: ORCH, entries });
      expect(res.status).toBe(200);
    }

    test(
      "AC9 — a cycle is refused 409 naming its members in order and writes nothing, " +
        "while an unknown dependency is only FLAGGED",
      async () => {
        boot();
        const key = await seed("ac9");
        await propose(key, "0.2.0");
        // Plan FIRST, then declare the graph: `wave-sequence` refuses a cr the
        // container does not hold, so the cycle check is only reachable once
        // both members are planned into it. The full replace carries the
        // declaration forward (§S2), which is what makes that possible.
        for (const cr of ["CR-A", "CR-B", "CR-C"]) {
          await plan(key, cr, "0.2.0", 5, `title ${cr}`);
        }
        await seedGraph(key, [
          { cr: "CR-A", wave: 5, dependsOn: ["CR-B"] },
          { cr: "CR-B", wave: 5, dependsOn: ["CR-A"] },
          { cr: "CR-C", wave: 5, dependsOn: ["CR-CRU-999"] },
        ]);
        const before = JSON.stringify(await queueEntries(key));

        const cyclic = await plan(key, "CR-A", "0.2.0", 5, "in a cycle");
        expect(cyclic.status).toBe(409);
        expect(cyclic.body.ok).toBe(false);
        // AC9 — the members named IN ORDER, closing the ring: a set-shaped
        // error naming the same two crs does not satisfy it.
        expect(cyclic.body.error).toContain("CR-A → CR-B → CR-A");
        expect(JSON.stringify(await queueEntries(key))).toBe(before);

        const cyclicSequence = await sequence(key, "0.2.0", 5, ["CR-A", "CR-B"]);
        expect(cyclicSequence.status).toBe(409);
        expect(cyclicSequence.body.error).toContain("CR-A → CR-B → CR-A");
        expect(JSON.stringify(await queueEntries(key))).toBe(before);

        // The OTHER severity, in the same fixture: accepted and flagged.
        const unknown = await plan(key, "CR-C", "0.2.0", 5, "forward ref");
        expect(unknown.status).toBe(200);
        expect(unknown.body.unknownDependencies).toEqual(["CR-CRU-999"]);
        expect((await entryOf(key, "CR-C"))!.release).toBe("0.2.0");
      },
    );

    test(
      "§S8 — a cycle refusal OUTRANKS convergence: an IDENTICAL re-post of a cr " +
        "sitting in a cycle is still 409 and still writes nothing",
      async () => {
        boot();
        const key = await seed("s8-cycle-outranks");
        await propose(key, "0.2.0");
        await plan(key, "CR-C1", "0.2.0", 5, "title CR-C1");
        await plan(key, "CR-C2", "0.2.0", 5, "title CR-C2");
        // The graph rides the full replace, which carries release and seq
        // forward; the titles are re-declared so the re-post below is IDENTICAL
        // to the held row — the case §S7 would otherwise converge on.
        await seedGraph(key, [
          { cr: "CR-C1", wave: 5, title: "title CR-C1", dependsOn: ["CR-C2"] },
          { cr: "CR-C2", wave: 5, title: "title CR-C2", dependsOn: ["CR-C1"] },
        ]);
        const before = storedRows(key);

        const identical = await plan(key, "CR-C1", "0.2.0", 5, "title CR-C1");
        expect(identical.status).toBe(409);
        expect(identical.body.ok).toBe(false);
        expect(identical.body.error).toContain("CR-C1 → CR-C2 → CR-C1");
        expect(identical.body.converged).toBeUndefined();
        expect(storedRows(key)).toEqual(before);
      },
    );

    test(
      "AC10 — an out-of-order sequence is STORED AS AUTHORED with a warning naming " +
        "the [dependant, dependency] pair",
      async () => {
        boot();
        const key = await seed("ac10-out-of-order");
        await propose(key, "0.2.0");
        await seedGraph(key, [
          { cr: "CR-A", wave: 5, dependsOn: [] },
          { cr: "CR-B", wave: 5, dependsOn: ["CR-A"] },
        ]);
        await plan(key, "CR-A", "0.2.0", 5, "the dependency");
        await plan(key, "CR-B", "0.2.0", 5, "the dependant");

        const res = await sequence(key, "0.2.0", 5, ["CR-B", "CR-A"]);
        expect(res.status).toBe(200);
        expect(res.body.entries!.map((e) => e.cr)).toEqual(["CR-B", "CR-A"]);
        const warning = res.body.warnings!.find((w) => w.code === "out-of-order");
        expect(warning).toBeDefined();
        expect(warning!.crs).toEqual(["CR-B", "CR-A"]);
        expect(warning!.message).toContain("CR-B");
        expect(warning!.message).toContain("CR-A");

        const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
        expect(seqs.get("CR-B")! < seqs.get("CR-A")!).toBe(true);
      },
    );

    test(
      "AC10 — a wave-4 cr depending on a wave-5 cr is stored and warns naming BOTH " +
        "CONTAINERS, not the two crs",
      async () => {
        boot();
        const key = await seed("ac10-cross-wave");
        await propose(key, "0.2.0");
        await seedGraph(key, [
          { cr: "CR-EARLY", wave: 4, dependsOn: ["CR-LATE"] },
          { cr: "CR-LATE", wave: 5, dependsOn: [] },
        ]);
        await plan(key, "CR-LATE", "0.2.0", 5, "the later one");

        const res = await plan(key, "CR-EARLY", "0.2.0", 4, "the earlier one");
        expect(res.status).toBe(200);
        const warning = res.body.warnings!.find((w) => w.code === "cross-wave-backwards");
        expect(warning).toBeDefined();
        expect(warning!.containers).toEqual(["0.2.0/4", "0.2.0/5"]);
        // "naming BOTH CONTAINERS, not the two crs" — so no `crs` at all.
        expect(warning!.crs).toBeUndefined();
        expect((await entryOf(key, "CR-EARLY"))!.wave).toBe("4");
      },
    );
  });

  // ── AC14 / AC15 — the two lifecycle verbs ─────────────────────────────────

  describe("AC14 + AC15 — supersede resolves, void breaks, and a cut release is immutable", () => {
    test(
      "both verbs are REFUSED on a cr named in a cut release's crs, naming that " +
        "release's label, and lifecycle_json stays NULL",
      async () => {
        boot();
        const key = await seed("ac14");
        await propose(key, "0.2.0");
        await plan(key, "CR-CRU-080", "0.2.0", 5, "already shipped");
        const shipped = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release",
          label: "0.1.9",
          commit: "b".repeat(40),
          releasedAt: 1_787_000_000,
          crs: ["CR-CRU-080"],
        });
        expect(shipped.status).toBe(201);

        const sup = await post(lifecyclePath(key, "CR-CRU-080", "supersede"), {
          agentId: ORCH,
          by: "CR-CRU-088",
        });
        expect(sup.body.ok).toBe(false);
        expect(sup.status).toBe(409);
        expect(sup.body.error).toContain("0.1.9");

        const voided = await post(lifecyclePath(key, "CR-CRU-080", "void"), {
          agentId: ORCH,
          reason: "changed my mind",
        });
        expect(voided.body.ok).toBe(false);
        expect(voided.status).toBe(409);
        expect(voided.body.error).toContain("0.1.9");

        expect(storedRows(key)[0]!.lifecycle_json).toBeNull();
        expect((await entryOf(key, "CR-CRU-080"))!.lifecycle).toBeUndefined();
      },
    );

    test(
      "AC15 — void names the BROKEN dependants; supersede reports them RESOLVING " +
        "through the successor and carries no broken list",
      async () => {
        boot();
        const key = await seed("ac15");
        await propose(key, "0.2.0");
        const res = await post(queuePath(key), {
          agentId: ORCH,
          entries: [
            { cr: "CR-X", wave: 5, dependsOn: [] },
            { cr: "CR-C", wave: 5, dependsOn: ["CR-X"] },
            { cr: "CR-D", wave: 5, dependsOn: ["CR-X"] },
            { cr: "CR-E", wave: 5, dependsOn: [] },
          ],
        });
        expect(res.status).toBe(200);

        const voided = await post(lifecyclePath(key, "CR-X", "void"), {
          agentId: ORCH,
          reason: "the work is not happening",
        });
        expect(voided.status).toBe(200);
        expect(voided.body.brokenDependants!.sort()).toEqual(["CR-C", "CR-D"]);
        expect("resolvedDependants" in voided.body).toBe(false);
        expect((await entryOf(key, "CR-X"))!.lifecycle!.state).toBe("VOID");

        const superseded = await post(lifecyclePath(key, "CR-X", "supersede"), {
          agentId: ORCH,
          by: "CR-Y",
        });
        expect(superseded.status).toBe(200);
        expect(superseded.body.resolvedDependants!.sort()).toEqual(["CR-C", "CR-D"]);
        expect("brokenDependants" in superseded.body).toBe(false);
        const x = await entryOf(key, "CR-X");
        expect(x!.lifecycle!.state).toBe("SUPERSEDED");
        expect(x!.lifecycle!.by).toBe("CR-Y");
      },
    );
  });

  // ── AC21 — a revision retires its predecessor, in one transaction ─────────

  describe("AC21 — release-propose revises by retiring, never by editing in place", () => {
    test(
      "re-proposing the same label with a DIFFERENT target leaves exactly ONE live " +
        "proposal carrying the new target; the predecessor is retired and still " +
        "retrievable by id",
      async () => {
        boot();
        const key = await seed("ac21");
        const first = await propose(key, "0.4.0", 1_787_000_000);
        expect(first.body.converged).toBe(false);
        const firstEventId = handle!.store
          .listEvents(key, 200)
          .find((e) => e.type === "release-proposal")!.id;

        const revised = await propose(key, "0.4.0", 1_790_000_000);
        expect(revised.status).toBe(200);
        expect(revised.body.converged).toBe(false);
        expect(revised.body.proposal).toEqual({ label: "0.4.0", targetAt: 1_790_000_000 });

        const live = (await get(proposalsPath(key))).body.proposals!;
        expect(live).toHaveLength(1);
        expect(live[0]!.targetAt).toBe(1_790_000_000);
        // The predecessor left the live feed…
        expect(handle!.store.listEvents(key, 200).map((e) => e.id)).not.toContain(firstEventId);
        // …and stays auditable: the target MOVED, and that fact survives.
        const retired = handle!.store.getEvent(firstEventId);
        expect(retired?.targetAt).toBe(1_787_000_000);
        expect(typeof retired?.retiredAt).toBe("number");

        // Same label + SAME target writes nothing.
        const same = await propose(key, "0.4.0", 1_790_000_000);
        expect(same.body.converged).toBe(true);
        expect((await get(proposalsPath(key))).body.proposals).toHaveLength(1);
      },
    );

    test("listing returns live rows only, ascending by version — 0.3.0 then 0.2.1 reads back 0.2.1, 0.3.0", async () => {
      boot();
      const key = await seed("ac21-order");
      await propose(key, "0.3.0");
      await propose(key, "0.2.1");
      await propose(key, "0.10.0");
      expect((await get(proposalsPath(key))).body.proposals!.map((p) => p.label)).toEqual([
        "0.2.1",
        "0.3.0",
        "0.10.0",
      ]);
    });

    // ── the tripwire that keeps AC21's enforcement the ONLY write path ─────
    //
    // AC21 (one LIVE proposal per label, revision retiring its predecessor in
    // one transaction) is enforced in `store.recordReleaseProposal`, reached
    // only through POST …/projects/<key>/release-proposals. The generic
    // `store.recordMilestoneEvent` deliberately does NOT enforce it — called
    // directly it will happily write two live `release-proposal` rows for one
    // label. That is safe today for exactly ONE reason: `release-proposal` is
    // absent from MILESTONE_TYPES (src/v2.ts), so POST /api/v2/milestones
    // refuses the type with a 400 and the unguarded writer is unreachable from
    // any HTTP surface.
    //
    // Adding "release-proposal" to MILESTONE_TYPES would open a SECOND write
    // path straight into the unguarded writer, and the invariant would regress
    // silently — every AC21 assertion above would still pass, because they all
    // go through the sanctioned route. This test is the tripwire: such a change
    // makes it FAIL (the refusal becomes a 201, and the unguarded row appears)
    // instead of quietly licensing two live proposals for one label.
    //
    // The accepted types are asserted as individual LITERALS rather than by
    // importing MILESTONE_TYPES — an imported set would make the assertion
    // vacuous the instant the set changes (the tests/releases.test.ts rule).
    test(
      "a `release-proposal` CANNOT be created through the generic milestone surface: " +
        "POST /api/v2/milestones 400s naming the accepted types and writes no row, " +
        "while the sanctioned route enforces one live proposal per label",
      async () => {
        boot();
        const key = await seed("ac21-tripwire");

        // Otherwise-valid body, registered ORCHESTRATOR caller, real label and
        // target — so the refusal can only be about the TYPE.
        const bypass = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release-proposal",
          label: "0.5.0",
          targetAt: 1_790_000_000,
        });
        expect(bypass.status).toBe(400);
        expect(bypass.body.ok).toBe(false);
        // The error names the accepted set, which does NOT include this type.
        expect(bypass.body.error).toContain("type must be one of");
        for (const accepted of [
          "gap-analysis",
          "design-review",
          "stage-flip",
          "custom",
          "cr-merged",
          "release",
        ]) {
          expect(bypass.body.error).toContain(accepted);
        }
        expect(bypass.body.error).not.toContain("release-proposal");
        expect(Array.isArray(bypass.body.help)).toBe(true);

        // Refused BEFORE any write: the unguarded writer never ran.
        expect(
          handle!.store.listEvents(key, 200).some((e) => e.type === "release-proposal"),
        ).toBe(false);
        expect((await get(proposalsPath(key))).body.proposals).toHaveLength(0);

        // The positive half of the same rule: the SANCTIONED route does
        // enforce it — the same label proposed twice with a DIFFERENT target
        // leaves exactly ONE live proposal, carrying the newer target. (The
        // retirement/audit half of that contract is the first test above.)
        expect((await propose(key, "0.5.0", 1_790_000_000)).status).toBe(200);
        expect((await propose(key, "0.5.0", 1_795_000_000)).status).toBe(200);
        const live = (await get(proposalsPath(key))).body.proposals!;
        expect(live).toHaveLength(1);
        expect(live[0]!.label).toBe("0.5.0");
        expect(live[0]!.targetAt).toBe(1_795_000_000);
      },
    );
  });

  // ── AC22 — a live proposal outlives the retention cap ─────────────────────

  describe("AC22 — a live proposal survives pruning; a consumed one does not", () => {
    test(
      "with the count cap driven below the event total the live release-proposal " +
        "survives and is still readable, while a CONSUMED proposal prunes away",
      async () => {
        boot();
        const key = await seed("ac22");
        const capped = await send("PATCH", `/api/v2/projects/${key}`, { retention: 2 });
        expect(capped.status).toBe(200);

        await propose(key, "0.5.0", 1_790_000_000);
        const proposalId = handle!.store
          .listEvents(key, 200)
          .find((e) => e.type === "release-proposal")!.id;

        // Drive the count far past the cap with ordinary, prunable events.
        for (let index = 0; index < 8; index += 1) {
          const res = await post("/api/v2/milestones", {
            projectKey: key,
            agentId: ORCH,
            type: "custom",
            label: `filler-${index}`,
          });
          expect(res.status).toBe(201);
        }

        // A pruned proposal has no git tag to rebuild it from, so it survives.
        expect((await get(proposalsPath(key))).body.proposals!.map((p) => p.label)).toEqual([
          "0.5.0",
        ]);
        expect(handle!.store.getEvent(proposalId)?.type).toBe("release-proposal");

        // Once the release SHIPS, the proposal is consumed — and prunable again.
        const shipped = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release",
          label: "0.5.0",
          commit: "c".repeat(40),
          releasedAt: 1_790_000_000,
        });
        expect(shipped.status).toBe(201);
        for (let index = 0; index < 8; index += 1) {
          await post("/api/v2/milestones", {
            projectKey: key,
            agentId: ORCH,
            type: "custom",
            label: `after-${index}`,
          });
        }
        expect(handle!.store.getEvent(proposalId)).toBeNull();
        expect((await get(proposalsPath(key))).body.proposals).toEqual([]);
      },
    );
  });

  // ── AC23 — a defaulted seq is named in a warning, and the write lands ─────

  describe("AC23 — a defaulted seq is reported, never silently invented", () => {
    test(
      "a full replace that ADDS a cr to a wave already carrying explicit seq values " +
        "keeps them, still writes, and warns naming the new cr with wave-sequence " +
        "as the remedy",
      async () => {
        boot();
        const key = await seed("ac23");
        const seeded = await post(queuePath(key), {
          agentId: ORCH,
          entries: [
            { cr: "CR-A", wave: 5, dependsOn: [], seq: 10 },
            { cr: "CR-B", wave: 5, dependsOn: [], seq: 20 },
            { cr: "CR-C", wave: 5, dependsOn: [], seq: 30 },
          ],
        });
        expect(seeded.status).toBe(200);
        expect(seeded.body.entries!.map((e) => e.seq)).toEqual([10, 20, 30]);

        const added = await post(queuePath(key), {
          agentId: ORCH,
          entries: [
            { cr: "CR-A", wave: 5, dependsOn: [] },
            { cr: "CR-B", wave: 5, dependsOn: [] },
            { cr: "CR-C", wave: 5, dependsOn: [] },
            { cr: "CR-NEW", wave: 5, dependsOn: [] },
          ],
        });
        expect(added.status).toBe(200);
        const carried = new Map(added.body.entries!.map((e) => [e.cr, e.seq]));
        expect(carried.get("CR-A")).toBe(10);
        expect(carried.get("CR-B")).toBe(20);
        expect(carried.get("CR-C")).toBe(30);

        const warning = added.body.warnings!.find((w) => w.code === "defaulted-seq");
        expect(warning).toBeDefined();
        expect(warning!.crs).toEqual(["CR-NEW"]);
        expect(warning!.message).toContain("CR-NEW");
        expect(warning!.message).toContain("wave-sequence");
      },
    );

    test("a post where NO entry carries an explicit seq emits NO such warning", async () => {
      boot();
      const key = await seed("ac23-quiet");
      const posted = await post(queuePath(key), {
        agentId: ORCH,
        entries: [
          { cr: "CR-A", wave: 5, dependsOn: [] },
          { cr: "CR-B", wave: 5, dependsOn: [] },
        ],
      });
      expect(posted.status).toBe(200);
      expect(posted.body.warnings).toEqual([]);
    });

    test(
      "cr-plan into a wave whose siblings carry seq values from ANOTHER scale " +
        "warns naming the new cr, and STILL WRITES (warn-and-write)",
      async () => {
        boot();
        const key = await seed("ac23-cr-plan");
        await propose(key, "0.2.0");
        // The only way into the mixed-scale case: an explicitly authored seq
        // riding the bulk post, outside wave 5's own block.
        const seeded = await post(queuePath(key), {
          agentId: ORCH,
          entries: [
            { cr: "CR-A", wave: 5, dependsOn: [], seq: 10 },
            { cr: "CR-B", wave: 5, dependsOn: [], seq: 20 },
          ],
        });
        expect(seeded.status).toBe(200);

        const added = await plan(key, "CR-NEW", "0.2.0", 5, "unauthored position");
        expect(added.status).toBe(200);
        const warning = added.body.warnings!.find((w) => w.code === "defaulted-seq");
        expect(warning).toBeDefined();
        expect(warning!.crs).toEqual(["CR-NEW"]);
        expect(warning!.message).toContain("CR-NEW");
        expect(warning!.message).toContain("wave-sequence");
        expect((await entryOf(key, "CR-NEW"))!.release).toBe("0.2.0");
        // The mismatch the warning reports is real: the siblings kept 10 and 20
        // while the new position came from wave 5's block.
        const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
        expect([seqs.get("CR-A"), seqs.get("CR-B")]).toEqual([10, 20]);
        expect(seqs.get("CR-NEW")! > 5000).toBe(true);
      },
    );

    test(
      "cr-plan into a wave whose seq values were NEVER authored emits no " +
        "defaulted-seq warning — an appended block position is the ordinary case",
      async () => {
        boot();
        const key = await seed("ac23-cr-plan-quiet");
        await propose(key, "0.2.0");
        const first = await plan(key, "CR-N1", "0.2.0", 9, "first into the wave");
        expect(first.status).toBe(200);
        expect(first.body.warnings).toEqual([]);

        const second = await plan(key, "CR-N2", "0.2.0", 9, "second into the wave");
        expect(second.status).toBe(200);
        expect(second.body.warnings).toEqual([]);
        const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
        expect([seqs.get("CR-N1"), seqs.get("CR-N2")]).toEqual([9001, 9002]);
      },
    );
  });

  // ── §S8 — an omitted member is appended and NAMED, never interleaved ──────

  describe("§S8 — the posted list is the wave's WHOLE order, and says so when it is not", () => {
    test(
      "the members the posted list omits keep their RELATIVE order, land AFTER " +
        "the authored block, and are named in an unsequenced-members warning",
      async () => {
        boot();
        const key = await seed("s8-unsequenced");
        await propose(key, "0.11.0");
        for (const cr of ["CR-U1", "CR-U2", "CR-U3", "CR-U4"]) {
          await plan(key, cr, "0.11.0", 11, `title ${cr}`);
        }
        await sequence(key, "0.11.0", 11, ["CR-U1", "CR-U2", "CR-U3", "CR-U4"]);

        const res = await sequence(key, "0.11.0", 11, ["CR-U4"]);
        expect(res.status).toBe(200);
        const warning = res.body.warnings!.find((w) => w.code === "unsequenced-members");
        expect(warning).toBeDefined();
        expect(warning!.crs).toEqual(["CR-U1", "CR-U2", "CR-U3"]);
        expect(warning!.message).toContain("CR-U1");
        expect(warning!.message).toContain("wave 11");

        // The authored block first, then the omitted three in their own order.
        const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
        expect(["CR-U4", "CR-U1", "CR-U2", "CR-U3"].map((cr) => seqs.get(cr))).toEqual([
          11001, 11002, 11003, 11004,
        ]);
      },
    );

    test("a posted list covering the WHOLE wave emits no such warning", async () => {
      boot();
      const key = await seed("s8-sequenced-whole");
      await propose(key, "0.11.0");
      for (const cr of ["CR-U1", "CR-U2"]) {
        await plan(key, cr, "0.11.0", 11, `title ${cr}`);
      }

      const res = await sequence(key, "0.11.0", 11, ["CR-U2", "CR-U1"]);
      expect(res.status).toBe(200);
      expect(res.body.warnings!.find((w) => w.code === "unsequenced-members")).toBeUndefined();
      const seqs = new Map((await queueEntries(key)).map((e) => [e.cr, e.seq]));
      expect([seqs.get("CR-U2"), seqs.get("CR-U1")]).toEqual([11001, 11002]);
    });
  });

  // ── §S3 — moving a cr out of a wave leaves that wave dense ────────────────

  describe("§S3 — cr-plan moves ONE cr and closes the gap behind it", () => {
    test("moving the middle cr out of wave 5 leaves the remaining two dense", async () => {
      boot();
      const key = await seed("s3-dense");
      await propose(key, "0.2.0");
      for (const cr of ["CR-1", "CR-2", "CR-3"]) {
        await plan(key, cr, "0.2.0", 5, `title ${cr}`);
      }
      await sequence(key, "0.2.0", 5, ["CR-1", "CR-2", "CR-3"]);

      const moved = await plan(key, "CR-2", "0.2.0", 6, "title CR-2");
      expect(moved.status).toBe(200);
      expect(moved.body.entry!.wave).toBe("6");

      const wave5 = (await queueEntries(key)).filter((e) => e.wave === "5");
      expect(wave5.map((e) => e.cr)).toEqual(["CR-1", "CR-3"]);
      expect(wave5[1]!.seq - wave5[0]!.seq).toBe(1);
    });
  });
});
