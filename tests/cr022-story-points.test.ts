// CR-CRU-022 §S1 — story points: `cr-plan --points N` (RED, C1).
//
// Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S1 + its first AC block
// Design: docs/research/DN-crucible-analytics.md §4
//
// Baseline (measured 2026-09-24 gap analysis, still true at this RED pass,
// re-confirmed against `handleCrPlan` (src/v2.ts) and `upsertQueueEntry`
// (src/store.ts) / `QueuePlanInput` (src/store.ts) / `QueueEntry`
// (src/types.ts)): no `--points`
// exists on `cr-plan`, `QueuePlanInput` carries only {cr,release,wave,
// title}, `upsertQueueEntry` never reads or stores a `points` field (0/144
// queue rows carried the old `size`, and nothing has since changed that),
// and `QueueEntry`'s published shape has no `points` key at all. Every test
// below is expected to FAIL: `points` is silently dropped on write, so the
// queue read never carries it and no out-of-scale value is ever refused.
//
// Scope: the SERVER half of §S1's first AC (storage, the Fibonacci refusal,
// omission-not-defaulting). The CLIENT half (the flag exists identically,
// wired through the ONE shared `_crucible_axi.py`, on all five stack
// clients) is tests/client/test_cr022_points_declaration.py.
//
// The declaration JOURNAL (§S1's third AC) has no read API of its own — the
// CR's API surface table lists only the three GET …/analytics/* routes, no
// journal endpoint. Its effects are asserted through the burndown endpoint's
// `points[]` steps in tests/cr022-burndown-analytics.test.ts (naming the CR
// and the verb that moved the release), which is the only OBSERVABLE
// contract the spec actually publishes for it — asserting against a guessed
// internal table/column name here would test this RED agent's guess, not
// the spec.
//
// Every server here is booted on an OS-assigned port against an
// mkdtempSync scratch db. The live data/crucible.db and port 3849 are never
// touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

interface QueueEntryWire {
  cr: string;
  points?: number;
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
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";
// CR-CRU-118 §S4 — release-propose requires a declared target; the value
// itself is not this file's subject, so one plausible date serves every
// fixture here.
const TARGET_AT = 1_788_220_800; // 2026-09-01T00:00:00Z

describe("CR-CRU-022 §S1 — story points: storage, the Fibonacci scale, omission", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru022-points-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
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

  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = (created.body.project as { key: string }).key;
    const orchestrator = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(orchestrator.status).toBe(200);
    const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
      label: "9.1.0",
      targetAt: TARGET_AT,
      agentId: ORCH,
    });
    expect(proposed.status).toBe(200);
    return key;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }
  function queuePath(key: string): string {
    return `/api/v2/projects/${key}/queue`;
  }

  async function planCr(
    key: string,
    cr: string,
    points?: number,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(planPath(key), {
      cr,
      release: "9.1.0",
      wave: "1",
      title: `story for ${cr}`,
      agentId: ORCH,
      ...(points === undefined ? {} : { points }),
    });
  }

  function entryFor(entries: QueueEntryWire[], cr: string): QueueEntryWire {
    const found = entries.find((e) => e.cr === cr);
    if (found === undefined) throw new Error(`no queue entry for ${cr}`);
    return found;
  }

  test("cr-plan --points 5 stores 5, and the queue read returns points: 5", async () => {
    boot();
    const key = await seed("points-basic");
    const planned = await planCr(key, "CR-PTS-1", 5);
    expect(planned.status).toBe(200);
    expect(planned.body.ok).toBe(true);
    expect(planned.body.entry?.points).toBe(5);

    const queue = await get(queuePath(key));
    expect(entryFor(queue.body.entries!, "CR-PTS-1").points).toBe(5);
  });

  test("every Fibonacci value 1, 2, 3, 5, 8, 13 is accepted and stored verbatim", async () => {
    boot();
    const key = await seed("points-scale");
    for (const value of [1, 2, 3, 5, 8, 13]) {
      const cr = `CR-PTS-SCALE-${value}`;
      const planned = await planCr(key, cr, value);
      expect(planned.status).toBe(200);
      expect(planned.body.ok).toBe(true);
      expect(planned.body.entry?.points).toBe(value);
    }
  });

  test("--points 4 is refused, naming the Fibonacci scale, and nothing is stored", async () => {
    boot();
    const key = await seed("points-refused");
    const refused = await planCr(key, "CR-PTS-BAD", 4);
    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    const msg = (refused.body.error ?? "").toLowerCase();
    expect(msg).toContain("fibonacci");
    for (const token of ["1", "2", "3", "5", "8", "13"]) {
      expect(new RegExp(`\\b${token}\\b`).test(msg)).toBe(true);
    }
    // Refused before any write reaches the row: the entry either was never
    // created, or was created (by cr-plan's own release/wave/title
    // requirement) but carries no points key.
    const queue = await get(queuePath(key));
    const entry = queue.body.entries?.find((e) => e.cr === "CR-PTS-BAD");
    expect(entry === undefined || entry.points === undefined).toBe(true);
  });

  test("out-of-scale values beyond 4 (0, 6, 7, 9, 14, -1) are all refused", async () => {
    boot();
    const key = await seed("points-refused-many");
    for (const value of [0, 6, 7, 9, 14, -1]) {
      const refused = await planCr(key, `CR-PTS-BAD-${value}`, value);
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
    }
  });

  test("an unpointed cr-plan omits `points` from the queue read, while a pointed sibling in the same release carries it — never a blanket omission", async () => {
    boot();
    const key = await seed("points-omitted");
    const planned = await planCr(key, "CR-PTS-NONE"); // no --points at all
    expect(planned.status).toBe(200);
    expect(planned.body.entry === undefined || !("points" in planned.body.entry)).toBe(true);

    // The sibling MUST carry its declared value — proves the omission above
    // is a real per-entry fact, not just "points is never published at all"
    // (which would make the first assertion vacuously true today).
    const pointedSibling = await planCr(key, "CR-PTS-SIBLING", 5);
    expect(pointedSibling.body.entry?.points).toBe(5);

    const queue = await get(queuePath(key));
    const entry = entryFor(queue.body.entries!, "CR-PTS-NONE");
    expect("points" in entry).toBe(false);
    expect(entryFor(queue.body.entries!, "CR-PTS-SIBLING").points).toBe(5);
  });

  test("re-pointing an already-pointed cr updates the stored value", async () => {
    boot();
    const key = await seed("points-repoint");
    const first = await planCr(key, "CR-PTS-REPOINT", 3);
    expect(first.body.entry?.points).toBe(3);
    const repointed = await planCr(key, "CR-PTS-REPOINT", 8);
    expect(repointed.status).toBe(200);
    expect(repointed.body.entry?.points).toBe(8);
    const queue = await get(queuePath(key));
    expect(entryFor(queue.body.entries!, "CR-PTS-REPOINT").points).toBe(8);
  });
});
