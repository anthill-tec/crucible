// CR-CRU-106 — a dependency is declared by its own verb: THE ENVELOPE, THE
// REMEDY HINT AND THE MIGRATION DOOR (cycle 2 of the CR's plan).
//
// Covers §S2b (the cycle refusal's remedy stops naming the migration door)
// and §S3 (the migration door is unchanged, and the asymmetry is stated) —
// ACs 7, 8 and 9. The verb, its gates and its writer (ACs 1-6, 10, 11) are
// cycle 1's, in the sibling `cr-depends-declaration.test.ts`, and nothing
// here re-asserts them.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// AC9. `handleCrDepends` answers `{ok, converged, entry, unknownDependencies}`
// and NO `warnings[]` at all. `cr-plan` and `wave-sequence` both answer
// `warnings: dependencyWarnings(entries, touched)` on a changed call and `[]`
// on a converged one (§S7 — a converged call earns no warning). A declaration
// that puts a cr BEFORE its own dependency in the same wave is exactly the
// finding `out-of-order` exists to name, and today the verb that creates it
// is the one verb that stays silent about it.
//
// §S2b. `roadmapHints.dependencyCycle`'s first line reads "POST …/queue —
// re-post the queue with X's dependsOn corrected": it answers a cycle by
// sending the caller through the migration door this CR routes around, and a
// natively-authored project has no queue to re-post.
//
// AC7/AC8 are truth to KEEP, asserted so nobody closes them by accident: a
// `dependsOn` riding a `cr-plan` body must stay ignored (shape B was
// rejected), and the migration door's accept-and-flag for an unknown target
// must stay what CR-CRU-014 §S1 made it. The client half of AC7 — no
// dependency flag on `cr-plan`/`wave-sequence` in any of the five clients —
// is the fleet census's to read (`tests/client/…fleet_envelope_census.py`),
// because that is the harness that reads every client's argparse.
//
// Every server here is booted on an OS-assigned port against an mkdtempSync
// scratch db. The live data/crucible.db and port 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

interface QueueEntryWire {
  cr: string;
  wave: string;
  dependsOn: string[];
  seq: number;
  [key: string]: unknown;
}

interface QueueWarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: QueueWarningWire[];
  unknownDependencies?: string[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";
const RELEASE = "9.9.0";
const WAVE = "5";

// Three rows planned in this order, so A sits BEFORE B and B before C in the
// wave. A dependency that points FORWARD (A on B) is the out-of-order finding;
// one that points back (B on A) is sound.
const A = "CR-ENVELOPE-1";
const B = "CR-ENVELOPE-2";
const C = "CR-ENVELOPE-3";
const UNKNOWN_TARGET = "CR-NEW-9";

describe("CR-CRU-106 §S2b/§S3 — cr-depends: the envelope, the remedy hint and the migration door", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function boot(): void {
    const dir = mkdtempSync(join(tmpdir(), "cru106-env-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<AnyBody> {
    return (await (await fetch(`${base()}${path}`)).json()) as AnyBody;
  }

  /** A project with ONE orchestrator; the role gate itself is cycle 1's. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    expect(
      (await post("/api/v2/agents/register", { projectKey: key, agentId: ORCH, role: "ORCHESTRATOR" }))
        .status,
    ).toBe(200);
    return key;
  }

  function dependsPath(key: string): string {
    return `/api/v2/projects/${key}/queue/depends`;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }

  async function depends(key: string, cr: string, dependsOn: string[]): Promise<{ status: number; body: AnyBody }> {
    return post(dependsPath(key), { agentId: ORCH, cr, dependsOn });
  }

  async function plan(key: string, cr: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: AnyBody }> {
    return post(planPath(key), { agentId: ORCH, cr, release: RELEASE, wave: WAVE, title: `row ${cr}`, ...extra });
  }

  /** The three rows through the approved API, in A, B, C order, no deps. */
  async function planThreeRows(key: string): Promise<void> {
    expect((await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label: RELEASE })).status).toBe(
      200,
    );
    for (const cr of [A, B, C]) {
      const planned = await plan(key, cr);
      expect(planned.status).toBe(200);
      expect(planned.body.entry!.dependsOn).toEqual([]);
    }
    // The premise every order finding below rests on: A < B < C in seq.
    const entries = (await get(`/api/v2/projects/${key}/queue`)).entries!;
    const seq = (cr: string): number => entries.find((entry) => entry.cr === cr)!.seq;
    expect(seq(A)).toBeLessThan(seq(B));
    expect(seq(B)).toBeLessThan(seq(C));
  }

  async function wireDeps(key: string, cr: string): Promise<string[] | undefined> {
    return (await get(`/api/v2/projects/${key}/queue`)).entries!.find((entry) => entry.cr === cr)?.dependsOn;
  }

  // ── AC9 — the reporting envelope, scoped to the cr the call touched ───────

  test("AC9 — a declaration that puts a cr BEFORE its own dependency answers 200 with the out-of-order warning NAMING the pair", async () => {
    boot();
    const key = await seed("ac9-out-of-order");
    await planThreeRows(key);

    const declared = await depends(key, A, [B]);
    expect(declared.status).toBe(200);
    expect(declared.body.ok).toBe(true);
    expect(declared.body.converged).toBe(false);
    // The write LANDED — the finding warns, it never refuses (§S5).
    expect(await wireDeps(key, A)).toEqual([B]);
    // …and the envelope names it, in the shape cr-plan's does.
    expect(Array.isArray(declared.body.warnings)).toBe(true);
    expect(declared.body.warnings!.length).toBe(1);
    const warning = declared.body.warnings![0]!;
    expect(warning.code).toBe("out-of-order");
    expect(warning.crs).toEqual([A, B]);
    expect(warning.message).toContain(A);
    expect(warning.message).toContain(B);
  });

  test("AC9 — re-sending the SAME set converges and earns NO warning, even though the finding still stands (§S7)", async () => {
    boot();
    const key = await seed("ac9-converged");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).body.warnings!.length).toBe(1);

    const again = await depends(key, A, [B]);
    expect(again.status).toBe(200);
    expect(again.body.converged).toBe(true);
    // The board still holds A before B — silence here is the §S7 rule (a
    // converged call wrote nothing and warns about nothing), not the finding
    // going away. A verb that recomputed warnings regardless of convergence
    // would name the pair again here.
    expect(again.body.warnings).toEqual([]);
    expect(await wireDeps(key, A)).toEqual([B]);
  });

  test("AC9 — a changed declaration whose order is sound earns no warning", async () => {
    boot();
    const key = await seed("ac9-sound");
    await planThreeRows(key);

    // B after A in the wave, depending on A: the dependency comes first.
    const declared = await depends(key, B, [A]);
    expect(declared.status).toBe(200);
    expect(declared.body.converged).toBe(false);
    expect(declared.body.warnings).toEqual([]);
  });

  test("AC9 — the warnings are SCOPED to the cr the call touched, never the whole backlog's history", async () => {
    boot();
    const key = await seed("ac9-scoped");
    await planThreeRows(key);
    // A standing finding on ANOTHER pair: B before C, depending on C.
    const other = await depends(key, B, [C]);
    expect(other.body.warnings!.map((warning) => warning.crs)).toEqual([[B, C]]);

    // A's own declaration reports A's own finding and not B's.
    const declared = await depends(key, A, [C]);
    expect(declared.status).toBe(200);
    expect(declared.body.warnings!.map((warning) => warning.crs)).toEqual([[A, C]]);
  });

  // ── §S2b — the cycle refusal's remedy names cr-depends ────────────────────

  test("§S2b — the 409's help[0] names cr-depends for the ring's first member and no longer names the bulk POST", async () => {
    boot();
    const key = await seed("s2b-hint");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).status).toBe(200);

    const refused = await depends(key, B, [A]);
    expect(refused.status).toBe(409);
    expect(refused.body.help!.length).toBeGreaterThanOrEqual(2);
    const remedy = refused.body.help![0]!;
    // The remedy is the verb this CR gives the axis, aimed at the subject
    // whose declaration closes the ring, with the ring still named so the
    // caller can see which edge to drop.
    expect(remedy).toContain(`cr-depends --cr ${B} --on`);
    expect(remedy).toContain(`${B} → ${A} → ${B}`);
    // The migration door is gone from the remedy: a natively-authored
    // project has no queue to re-post.
    const help = refused.body.help!.join("\n");
    expect(help).not.toContain("re-post");
    expect(help).not.toContain("POST /api/v2/projects/<key>/queue");
    // The second line — why a cycle is the ONE finding that refuses — stays.
    expect(refused.body.help![1]).toContain("a cycle is the only one that refuses");
  });

  test("§S2b — the SAME remedy reaches cr-plan's refusal: the hint is the shared guard's, not the verb's", async () => {
    boot();
    const key = await seed("s2b-shared");
    // Only the migration door can seed a board that already holds a ring
    // (CR-CRU-104's open ruling), which is what a re-plan then trips over.
    const seeded = await post(`/api/v2/projects/${key}/queue`, {
      entries: [
        { cr: A, title: "a", wave: WAVE, dependsOn: [B] },
        { cr: B, title: "b", wave: WAVE, dependsOn: [A] },
      ],
    });
    expect(seeded.status).toBe(200);
    expect((await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label: RELEASE })).status).toBe(
      200,
    );

    const refused = await plan(key, A);
    expect(refused.status).toBe(409);
    expect(refused.body.help![0]).toContain(`cr-depends --cr ${A} --on`);
    expect(refused.body.help!.join("\n")).not.toContain("re-post");
  });

  // ── AC7 — no dependency flag or argument on cr-plan or wave-sequence ──────

  test("AC7 — a `dependsOn` riding a cr-plan body is IGNORED: not stored on a new row, not written over a declared set on a re-plan", async () => {
    boot();
    const key = await seed("ac7-plan");
    expect((await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label: RELEASE })).status).toBe(
      200,
    );
    for (const cr of [B, C]) expect((await plan(key, cr)).status).toBe(200);

    // Shape B — a dependency on the planning verb — was REJECTED. The field
    // is neither refused nor honoured: it simply is not this verb's axis.
    const planned = await plan(key, A, { dependsOn: [B] });
    expect(planned.status).toBe(200);
    expect(planned.body.entry!.dependsOn).toEqual([]);
    expect(await wireDeps(key, A)).toEqual([]);

    // And a re-plan cannot restate OR lose a set the dependency verb declared
    // — the exact accident-of-arrival failure shape B was rejected for.
    expect((await depends(key, A, [B])).status).toBe(200);
    const replanned = await plan(key, A, { dependsOn: [C] });
    expect(replanned.status).toBe(200);
    expect(await wireDeps(key, A)).toEqual([B]);
    const replannedEmpty = await plan(key, A, { dependsOn: [] });
    expect(replannedEmpty.status).toBe(200);
    expect(await wireDeps(key, A)).toEqual([B]);
  });

  test("AC7 — a `dependsOn` riding a wave-sequence body is ignored too: shape C was rejected", async () => {
    boot();
    const key = await seed("ac7-sequence");
    await planThreeRows(key);
    expect((await depends(key, A, [B])).status).toBe(200);

    const sequenced = await post(`/api/v2/projects/${key}/queue/sequence`, {
      agentId: ORCH,
      release: RELEASE,
      wave: WAVE,
      crs: [B, A, C],
      dependsOn: { [A]: [C], [B]: [A] },
    });
    expect(sequenced.status).toBe(200);
    // The order moved, the dependency axis did not.
    expect(await wireDeps(key, A)).toEqual([B]);
    expect(await wireDeps(key, B)).toEqual([]);
  });

  // ── AC8 / §S3 — the migration door is unchanged, and the asymmetry stated ─

  test(
    "AC8 — the migration door still ACCEPTS and FLAGS an unknown dependency target: the ruling AC5 gives the verb, " +
      "and DELIBERATELY unlike cr-plan's refusal of an unproposed release — a bulk import cannot require its own " +
      "targets to exist yet, because the whole set arrives in one call",
    async () => {
      boot();
      const key = await seed("ac8-asymmetry");

      // The asymmetry §S3 states is on the RELEASE axis, not between the two
      // dependency doors: AC8 was written while AC5 was still open, and the
      // user's ruling (accept and flag, for the reasons AC5 records) aligned
      // the verb with the door. What stays asymmetric — and deliberately so —
      // is that a dependency TARGET may be unknown on either door while a
      // declared RELEASE must be a live proposal on `cr-plan`. Both halves are
      // measured here, on one board, so the difference is a fact and never a
      // silently inherited one.
      const posted = await post(`/api/v2/projects/${key}/queue`, {
        entries: [
          { cr: A, title: "a", wave: WAVE, dependsOn: [UNKNOWN_TARGET] },
          { cr: B, title: "b", wave: WAVE, dependsOn: [] },
        ],
      });
      expect(posted.status).toBe(200);
      expect(posted.body.ok).toBe(true);
      expect(posted.body.unknownDependencies).toEqual([UNKNOWN_TARGET]);
      // Accepted means STORED verbatim, exactly as CR-CRU-014 §S1 left it.
      expect(await wireDeps(key, A)).toEqual([UNKNOWN_TARGET]);

      // The verb on the SAME board gives the same target the same verdict.
      const declared = await depends(key, B, [UNKNOWN_TARGET]);
      expect(declared.status).toBe(200);
      expect(declared.body.unknownDependencies).toEqual([UNKNOWN_TARGET]);
      expect(await wireDeps(key, B)).toEqual([UNKNOWN_TARGET]);

      // The other axis, on the same board: an unproposed release is REFUSED.
      const refused = await plan(key, C, { release: "7.7.7" });
      expect(refused.status).toBe(404);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toContain("7.7.7");
    },
  );
});
