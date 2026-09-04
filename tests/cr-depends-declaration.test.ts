// CR-CRU-106 — a dependency is declared by its own verb: THE VERB AND ITS
// WRITER (cycle 1 of the CR's plan).
//
// Covers §S1 (the verb, and the WHOLE set as payload), §S2 (the ORCHESTRATOR
// gate and the PROSPECTIVE-graph cycle refusal) and §S2a (a dependency needs a
// row to belong to) — ACs 1, 2, 3, 4, 5, 6, 10 and 11.
//
// NOT this cycle, and deliberately unasserted here: the reporting envelope's
// warnings (AC9), the cycle refusal's remedy hint retarget (§S2b), the
// migration door's stated asymmetry (AC8) and the no-flag-on-cr-plan census
// (AC7). They are the next cycle's.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// The approved API cannot declare a dependency at all. `src/v2.ts`'s
// project-scoped dispatch knows `queue/plan` and `queue/sequence` and nothing
// else under `queue/`, so `queue/depends` 404s through the catch-all. Below
// that, no per-CR writer can reach the column even if a route existed:
// `upsertQueueEntry` hardcodes `'[]'` on INSERT and never updates
// `depends_on_json`, and `replaceQueue` — the migration door's whole-queue
// writer — is the only thing in the store that writes it.
//
// And the cycle guard cannot be reused unchanged. `refuseDependencyCycle`
// documents its own precondition — "Neither verb edits `dependsOn`, so the
// stored graph is the graph the write would leave behind" — and both existing
// callers hand it `store.listQueue(...)`. This verb is the FIRST that edits
// `dependsOn`, so for it the stored graph is precisely NOT the post-write
// graph: EVERY cycle a declaration could close is invisible to a stored-graph
// read, because the closing edge is the one still in the request body. AC11
// is that case, and it is the load-bearing test of this suite.
//
// ── The seams GREEN must expose (this suite is written against them) ───────
//
//   POST …/projects/<key>/queue/depends  {cr, dependsOn[], agentId}
//        → {ok, converged, entry, unknownDependencies[]}
//
//   cr-depends --cr <id> --on <a,b,c>    (python client, shared module)
//        → the ask when `--on` is undeclared: ok:false, exit 2, nothing posted
//
// Every server here is booted on an OS-assigned port against an mkdtempSync
// scratch db. The live data/crucible.db and port 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const PYTHON_CLIENT = join(import.meta.dir, "..", "clients", "python-crucible.py");

interface QueueEntryWire {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: string;
  seq: number;
  release?: string;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  unknownDependencies?: string[];
  planId?: number;
  cycles?: Array<{ id: number; label: string }>;
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";
const RED_AGENT = "red-1";
const ROLELESS = "legacy-pre-cr044";
const RELEASE = "9.9.0";
const WAVE = "5";

// The three rows every cycle case is built from, plus the two ids the board
// never holds: a dependency TARGET that was never planned (AC5, accepted and
// flagged) and a declaration SUBJECT that was never planned (AC10, refused).
const A = "CR-DECLARED-1";
const B = "CR-DECLARED-2";
const C = "CR-DECLARED-3";
const UNKNOWN_TARGET = "CR-NEW-9";
const UNREGISTERED_SUBJECT = "CR-DEAD-1";

describe("CR-CRU-106 §S1/§S2/§S2a — cr-depends: the verb, its gates and its writer", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: join(scratch("cru106-"), "crucible.db") });
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

  /** A project plus the three callers the role gate is asserted against — the
   *  same fixture shape `roadmap-registration-routes.test.ts` uses, because
   *  AC3 requires this verb to answer with the MEANING `cr-plan` gives. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    expect(
      (await post("/api/v2/agents/register", { projectKey: key, agentId: ORCH, role: "ORCHESTRATOR" }))
        .status,
    ).toBe(200);

    // A RED caller cannot register unbound, so bind it to a throwaway plan's
    // active cycle on a cr that never enters the queue.
    const filed = await post(`/api/v2/projects/${key}/plans`, {
      agentId: ORCH,
      cr: "CR-SOLO-1",
      cycles: [{ label: "solo" }],
    });
    expect(filed.status).toBe(201);
    const cycleId = filed.body.cycles![0]!.id;
    expect(
      (
        await send(
          "PATCH",
          `/api/v2/projects/${key}/plans/${String(filed.body.planId)}/cycles/${String(cycleId)}`,
          { agentId: ORCH, status: "active" },
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/api/v2/agents/register", { projectKey: key, agentId: RED_AGENT, role: "RED", cycleId }))
        .status,
    ).toBe(200);

    // A pre-CR-044 row: registered, live, carrying no role at all.
    handle!.store.touchAgent(key, ROLELESS);
    expect(handle!.store.getAgent(key, ROLELESS)?.role).toBeUndefined();
    return key;
  }

  function dependsPath(key: string): string {
    return `/api/v2/projects/${key}/queue/depends`;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }

  async function depends(
    key: string,
    cr: string,
    dependsOn: string[],
    agentId: string = ORCH,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(dependsPath(key), { agentId, cr, dependsOn });
  }

  /** The three rows, planned through the approved API — `release-propose` then
   *  `cr-plan`, never the migration door, so nothing here depends on the bulk
   *  post to exist. Every row starts with NO dependencies. */
  async function planThreeRows(key: string): Promise<void> {
    expect((await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label: RELEASE })).status).toBe(
      200,
    );
    for (const cr of [A, B, C]) {
      const planned = await post(planPath(key), {
        agentId: ORCH,
        cr,
        release: RELEASE,
        wave: WAVE,
        title: `row ${cr}`,
      });
      expect(planned.status).toBe(200);
      expect(planned.body.entry!.dependsOn).toEqual([]);
    }
  }

  /** The dependency set the WIRE publishes for one cr — the read-back channel
   *  AC1 names ("asserted through the wire, not the store"). */
  async function wireDeps(key: string, cr: string): Promise<string[] | undefined> {
    const queue = await get(`/api/v2/projects/${key}/queue`);
    return queue.body.entries!.find((entry) => entry.cr === cr)?.dependsOn;
  }

  async function wireRow(key: string, cr: string): Promise<QueueEntryWire | undefined> {
    const queue = await get(`/api/v2/projects/${key}/queue`);
    return queue.body.entries!.find((entry) => entry.cr === cr);
  }

  // ── AC1 — the declaration reads back byte-identically, through the wire ───

  test("AC1 — a declared set reads back through the wire exactly as it was sent", async () => {
    boot();
    const key = await seed("ac1");
    await planThreeRows(key);

    const declared = await depends(key, A, [B, C]);
    expect(declared.status).toBe(200);
    expect(declared.body.ok).toBe(true);
    // The verb's own answer carries the row it wrote.
    expect(declared.body.entry!.cr).toBe(A);
    expect(declared.body.entry!.dependsOn).toEqual([B, C]);
    // And the queue read-back agrees, in the declared ORDER: the column holds
    // the verbatim id list, so a reordering writer would be visible here.
    expect(await wireDeps(key, A)).toEqual([B, C]);
    // Declaring one cr's set touches no other cr's.
    expect(await wireDeps(key, B)).toEqual([]);
    expect(await wireDeps(key, C)).toEqual([]);
  });

  test("AC1 — the declaration writes ONLY the dependency axis", async () => {
    boot();
    const key = await seed("ac1-axis");
    await planThreeRows(key);
    const before = await wireRow(key, A);

    expect((await depends(key, A, [B])).status).toBe(200);

    const after = await wireRow(key, A);
    expect(after!.dependsOn).toEqual([B]);
    // Release, wave, title and position are the OTHER axes' declarations and
    // this verb restates none of them (the §S1 argument for its own verb).
    expect({ ...after, dependsOn: [] }).toEqual({ ...before, dependsOn: [] });
  });

  // ── AC2 — re-sending REPLACES; an empty set is a declaration ──────────────

  test("AC2 — a second, smaller set REPLACES the first and the dropped dependency is gone", async () => {
    boot();
    const key = await seed("ac2-replace");
    await planThreeRows(key);

    expect((await depends(key, A, [B, C])).status).toBe(200);
    const resent = await depends(key, A, [B]);
    expect(resent.status).toBe(200);
    expect(resent.body.converged).toBe(false);
    expect(await wireDeps(key, A)).toEqual([B]);
    expect(await wireDeps(key, A)).not.toContain(C);
  });

  test("AC2 — an EMPTY set is accepted and leaves no dependencies", async () => {
    boot();
    const key = await seed("ac2-empty");
    await planThreeRows(key);

    expect((await depends(key, A, [B, C])).status).toBe(200);
    const emptied = await depends(key, A, []);
    expect(emptied.status).toBe(200);
    expect(emptied.body.ok).toBe(true);
    expect(emptied.body.entry!.dependsOn).toEqual([]);
    expect(await wireDeps(key, A)).toEqual([]);
  });

  test("AC2 — re-sending the SAME set converges and writes nothing", async () => {
    boot();
    const key = await seed("ac2-converge");
    await planThreeRows(key);

    const first = await depends(key, A, [B, C]);
    expect(first.body.converged).toBe(false);
    const again = await depends(key, A, [B, C]);
    expect(again.status).toBe(200);
    expect(again.body.converged).toBe(true);
    expect(await wireDeps(key, A)).toEqual([B, C]);
  });

  // ── AC3 — the ORCHESTRATOR gate, with cr-plan's own meaning ───────────────

  test("AC3 — an unregistered caller is refused with the meaning cr-plan gives that case", async () => {
    boot();
    const key = await seed("ac3-unregistered");
    await planThreeRows(key);

    const refused = await depends(key, A, [B], "nobody-at-all");
    const planRefused = await post(planPath(key), {
      agentId: "nobody-at-all",
      cr: A,
      release: RELEASE,
      wave: WAVE,
      title: "same caller",
    });
    expect(refused.status).toBe(planRefused.status);
    expect(refused.body.error).toBe(planRefused.body.error);
    expect(refused.body.help).toEqual(planRefused.body.help);
    expect(await wireDeps(key, A)).toEqual([]);
  });

  test("AC3 — a registered NON-orchestrator is refused with the meaning cr-plan gives that case", async () => {
    boot();
    const key = await seed("ac3-role");
    await planThreeRows(key);

    for (const caller of [RED_AGENT, ROLELESS]) {
      const refused = await depends(key, A, [B], caller);
      const planRefused = await post(planPath(key), {
        agentId: caller,
        cr: A,
        release: RELEASE,
        wave: WAVE,
        title: "same caller",
      });
      expect(refused.status).toBe(planRefused.status);
      expect(refused.body.error).toBe(planRefused.body.error);
      expect(refused.body.help).toEqual(planRefused.body.help);
    }
    expect(await wireDeps(key, A)).toEqual([]);
  });

  // ── AC4 — a cycle on a board that ALREADY holds one ───────────────────────

  test("AC4 — a declaration into a ring the board already holds is refused naming the pair, and nothing is written", async () => {
    boot();
    const key = await seed("ac4");
    // The migration door is the only writer that can seed an already-cyclic
    // board, and it does not refuse a cycle (CR-CRU-104's open ruling). This
    // is the "real cycle on a real board" AC4 names, never a mock.
    const seeded = await post(`/api/v2/projects/${key}/queue`, {
      entries: [
        { cr: A, title: "a", wave: WAVE, dependsOn: [B] },
        { cr: B, title: "b", wave: WAVE, dependsOn: [A] },
        { cr: C, title: "c", wave: WAVE, dependsOn: [] },
      ],
    });
    expect(seeded.status).toBe(200);
    expect(await wireDeps(key, A)).toEqual([B]);

    const refused = await depends(key, A, [B, C]);
    expect(refused.status).toBe(409);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain(A);
    expect(refused.body.error).toContain(B);
    expect(refused.body.error).toContain("nothing was written");
    // NOTHING was written: the row still carries the set it held, not the one
    // the refused call declared.
    expect(await wireDeps(key, A)).toEqual([B]);
  });

  // ── AC11 — the PROSPECTIVE graph: a ring the board does not yet hold ──────

  test("AC11 — a declaration that WOULD CLOSE a three-cr ring is refused, and nothing is written", async () => {
    boot();
    const key = await seed("ac11-chain");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).status).toBe(200);
    expect((await depends(key, B, [C])).status).toBe(200);

    // THE PREMISE, and the whole reason the guard cannot be reused unchanged:
    // the STORED graph is acyclic. The edge that closes the ring is still in
    // the request body, so a guard reading `store.listQueue` sees C depending
    // on nothing and accepts.
    expect(await wireDeps(key, C)).toEqual([]);

    const refused = await depends(key, C, [A]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(C);
    expect(refused.body.error).toContain(A);
    expect(refused.body.error).toContain("nothing was written");
    // And the write really did not land — read the row back, do not take the
    // refusal's word for it.
    expect(await wireDeps(key, C)).toEqual([]);
  });

  test("AC11 — the minimal would-close ring, two crs, is refused too", async () => {
    boot();
    const key = await seed("ac11-pair");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).status).toBe(200);
    expect(await wireDeps(key, B)).toEqual([]);

    const refused = await depends(key, B, [A]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(A);
    expect(refused.body.error).toContain(B);
    expect(await wireDeps(key, B)).toEqual([]);
  });

  test("AC11 — a cr may not declare itself a dependency of itself", async () => {
    boot();
    const key = await seed("ac11-self");
    await planThreeRows(key);

    const refused = await depends(key, A, [A]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(A);
    expect(await wireDeps(key, A)).toEqual([]);
  });

  test("AC11 — a declaration that leaves the graph acyclic is accepted", async () => {
    boot();
    const key = await seed("ac11-negative");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).status).toBe(200);
    expect((await depends(key, B, [C])).status).toBe(200);

    // The mirror of the refusal: the prospective graph must not refuse an
    // ordinary forward declaration, or the guard would be a wall.
    const accepted = await depends(key, A, [B, C]);
    expect(accepted.status).toBe(200);
    expect(await wireDeps(key, A)).toEqual([B, C]);
  });

  // ── AC5 — an unknown TARGET is accepted and flagged ───────────────────────

  test("AC5 — an unknown dependency target is ACCEPTED and reported in unknownDependencies", async () => {
    boot();
    const key = await seed("ac5");
    await planThreeRows(key);

    const declared = await depends(key, A, [B, UNKNOWN_TARGET]);
    expect(declared.status).toBe(200);
    expect(declared.body.ok).toBe(true);
    expect(declared.body.unknownDependencies).toEqual([UNKNOWN_TARGET]);
    // Accepted means STORED, verbatim, alongside the known one.
    expect(await wireDeps(key, A)).toEqual([B, UNKNOWN_TARGET]);
  });

  test("AC5 — a wholly known set reports no unknown dependencies", async () => {
    boot();
    const key = await seed("ac5-clean");
    await planThreeRows(key);

    const declared = await depends(key, A, [B, C]);
    expect(declared.body.unknownDependencies).toEqual([]);
  });

  // ── AC10 — the SUBJECT must be a registered cr ────────────────────────────

  test("AC10 — --cr naming a cr the board does not hold is refused, and NOTHING is created", async () => {
    boot();
    const key = await seed("ac10");
    await planThreeRows(key);

    const refused = await depends(key, UNREGISTERED_SUBJECT, [A]);
    expect(refused.status).toBe(404);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain(UNREGISTERED_SUBJECT);
    // The lifecycle verbs' settled precedent: the hint points at cr-plan and
    // says the verb creates no row.
    expect(refused.body.help!.join(" ")).toContain("cr-plan");
    // Nothing was CONJURED: a follow-up read shows no row at all — not a row
    // with no release and no title, hanging dependencies off nothing.
    const queue = await get(`/api/v2/projects/${key}/queue`);
    expect(queue.body.entries!.map((entry) => entry.cr)).not.toContain(UNREGISTERED_SUBJECT);
    expect(queue.body.entries!.length).toBe(3);
  });

  test("AC10 — the subject refusal outranks an unknown target on the same call", async () => {
    boot();
    const key = await seed("ac10-both");
    await planThreeRows(key);

    // AC10 governs the SUBJECT, AC5 the TARGETS, and the two rulings differ on
    // purpose. A call that is wrong on both is refused, never half-accepted.
    const refused = await depends(key, UNREGISTERED_SUBJECT, [UNKNOWN_TARGET]);
    expect(refused.status).toBe(404);
    // The refusal names the SUBJECT, not the target: an unrouted 404 would
    // otherwise satisfy this test without the verb existing at all.
    expect(refused.body.error).toContain(UNREGISTERED_SUBJECT);
    expect(refused.body.error).not.toContain(UNKNOWN_TARGET);
    const queue = await get(`/api/v2/projects/${key}/queue`);
    expect(queue.body.entries!.length).toBe(3);
  });

  // ── the body's own shape ──────────────────────────────────────────────────

  test("a malformed dependsOn is refused BY NAME, in handleQueuePost's field+index shape", async () => {
    boot();
    const key = await seed("shape");
    await planThreeRows(key);

    const noSet = await post(dependsPath(key), { agentId: ORCH, cr: A });
    expect(noSet.status).toBe(400);
    expect(noSet.body.error).toContain("dependsOn");

    const badEntry = await post(dependsPath(key), { agentId: ORCH, cr: A, dependsOn: [B, 7] });
    expect(badEntry.status).toBe(400);
    expect(badEntry.body.error).toContain("index 1");

    const twice = await post(dependsPath(key), { agentId: ORCH, cr: A, dependsOn: [B, B] });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toContain(B);

    const noCr = await post(dependsPath(key), { agentId: ORCH, dependsOn: [B] });
    expect(noCr.status).toBe(400);
    expect(noCr.body.error).toContain("`cr` is required");

    expect(await wireDeps(key, A)).toEqual([]);
  });

  // ── AC6 — the client ASKS rather than failing blankly ─────────────────────

  interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  async function runClient(args: string[], projectDir: string): Promise<RunResult> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("WORKFLOW_")) delete env[k];
    const proc = Bun.spawn({
      cmd: ["uv", "run", PYTHON_CLIENT, ...args],
      cwd: projectDir,
      env: { ...env, CRUCIBLE_URL: base() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  function clientFixture(key: string): string {
    const dir = scratch("cru106-client-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return dir;
  }

  test("AC6 — cr-depends with no --on lists the live candidates, exits 2 and posts nothing", async () => {
    boot();
    const key = await seed("ac6");
    await planThreeRows(key);
    const dir = clientFixture(key);

    const res = await runClient(["cr-depends", "--cr", A, "--agent", ORCH, "--project-dir", dir], dir);
    expect(res.code).toBe(2);
    expect(res.stdout).toContain("verb: cr-depends");
    expect(res.stdout).toContain("ok: false");
    // The undeclared field is NAMED, never inferred.
    expect(res.stdout).toContain("on");
    // The LIVE candidates — the crs this board actually holds, which is what a
    // caller needs in order to name a dependency at all.
    for (const cr of [A, B, C]) expect(res.stdout).toContain(cr);
    // …and it is an ASK, not a write: nothing reached the wire.
    expect(await wireDeps(key, A)).toEqual([]);
  });

  test("AC6 — the ask is never a blank argparse failure", async () => {
    boot();
    const key = await seed("ac6-blank");
    await planThreeRows(key);
    const dir = clientFixture(key);

    const res = await runClient(["cr-depends", "--cr", A, "--agent", ORCH, "--project-dir", dir], dir);
    // argparse's own failure exits 2 with a bare "usage:" on stderr and an
    // EMPTY stdout. The ask exits 2 with a real envelope on stdout.
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stderr).not.toContain("usage: python-crucible cr-depends");
  });

  test("AC1/AC2 through the CLIENT — --on declares the set and an empty --on declares none", async () => {
    boot();
    const key = await seed("ac6-declares");
    await planThreeRows(key);
    const dir = clientFixture(key);

    const declared = await runClient(
      ["cr-depends", "--cr", A, "--on", `${B},${C}`, "--agent", ORCH, "--project-dir", dir],
      dir,
    );
    expect(declared.code).toBe(0);
    expect(declared.stdout).toContain("ok: true");
    expect(await wireDeps(key, A)).toEqual([B, C]);

    // The spec's "sending an empty set is a legitimate declaration", spelled
    // on the command line: an EXPLICIT empty `--on` declares none, while an
    // ABSENT `--on` asks. The two cases are different facts.
    const emptied = await runClient(
      ["cr-depends", "--cr", A, "--on", "", "--agent", ORCH, "--project-dir", dir],
      dir,
    );
    expect(emptied.code).toBe(0);
    expect(await wireDeps(key, A)).toEqual([]);
  });

  test("AC3/AC10 through the CLIENT — a server refusal is an envelope, exit 1", async () => {
    boot();
    const key = await seed("ac6-refusal");
    await planThreeRows(key);
    const dir = clientFixture(key);

    const refused = await runClient(
      ["cr-depends", "--cr", UNREGISTERED_SUBJECT, "--on", A, "--agent", ORCH, "--project-dir", dir],
      dir,
    );
    // A refusal that came back FROM the server keeps the fleet's exit 1; only
    // a client-resolved usage failure exits 2.
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("verb: cr-depends");
    expect(refused.stdout).toContain("ok: false");
    expect(refused.stdout).toContain("requiredRole: ORCHESTRATOR");
  });
});
