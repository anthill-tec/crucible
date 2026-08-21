// CR-CRU-014 §S1 — Queue registration (server, additive). C1 RED tests.
//
// Spec (§S1, verbatim): `POST /api/v2/projects/<key>/queue` — full replace:
// `{entries:[{cr, title?, wave, dependsOn:[cr…], size?}]}`; validation 400s
// name the field + index; unknown `dependsOn` targets are allowed (forward
// refs) but flagged in the response. `GET …/queue` returns entries with
// DERIVED `status` (PENDING/IN_PROGRESS/COMPLETED via plans) + the plan link
// when present. SSE on change.
//
// Derived-status rule (spec §Context, authoritative):
//   PENDING     = no plan filed for the cr
//   IN_PROGRESS = an OPEN plan exists for the cr
//   COMPLETED   = a plan for the cr is closed WITH a merge commit
// `plans.cr` is the STABLE (verbatim, never-normalized) join key (spec
// §Forward-compatibility contract).
//
// ── Contract field names this RED file PINS (RED's prerogative per §S1) ────
//   POST /queue reply : { ok:true, entries: QueueEntry[], unknownDependencies:
//                         string[] } — 200 or 202.
//   GET  /queue reply : { ok:true, entries: QueueEntry[] }.
//   QueueEntry        : { cr, title?, wave, dependsOn: string[], size?,
//                         status: "PENDING"|"IN_PROGRESS"|"COMPLETED",
//                         planId? } — planId is the plan link, present only
//                         when a plan exists for the cr.
//
// ── Schema design this file ASSUMES (stated per dispatch) ──────────────────
// The queue_entries table is created ADDITIVELY via CREATE TABLE IF NOT
// EXISTS inside createBaseTables (the same way CR-017's runs surface is
// seeded) — NO migration chain step. Therefore SCHEMA_VERSION stays 7 and a
// freshly booted store still reports schemaVersion === 7. (The alternative —
// a 7→8 chain step — is NOT what these tests expect; if GREEN adds one, the
// schema-unchanged assertion below is the signal it diverged from the
// forward-compat "no 0.1.0 table changes required" contract.)
// tests/store-migration.test.ts derives every version from schemaVersion()
// (reads SCHEMA_VERSION) — it pins NO literal — so either design keeps it
// green; this file's literal 7 is the design guard.
//
// Drives the REAL production server (startServer) — POST/GET
// /api/v2/projects/<key>/queue do not exist in the route table yet, so every
// call 404s through the generic catch-all until GREEN wires the route + the
// queue_entries table. The failures name the MISSING contract (a 404 where a
// 200/202 is required), not fixture bugs.
//
// SSE frame + reader technique: identical to tests/project-archive.test.ts /
// tests/v2-stream-paging.test.ts.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface QueueEntry {
  cr: string;
  title?: string;
  wave: string | number;
  dependsOn: string[];
  size?: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED";
  planId?: number;
  [key: string]: unknown;
}

interface QueuePostResponse extends OkResponse {
  entries: QueueEntry[];
  unknownDependencies: string[];
}

interface QueueGetResponse extends OkResponse {
  entries: QueueEntry[];
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  [key: string]: unknown;
}

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

// ── SSE frame reading helpers (same technique as tests/project-archive.test.ts) ──

interface ParsedFrame {
  raw: string;
  isComment: boolean;
  data?: Record<string, unknown>;
}

function parseFrame(raw: string): ParsedFrame {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length > 0 && lines.every((l) => l.startsWith(":"))) {
    return { raw, isComment: true };
  }
  const dataLine = lines.find((l) => l.startsWith("data:"));
  if (dataLine !== undefined) {
    const jsonStr = dataLine.slice("data:".length).trim();
    try {
      return { raw, isComment: false, data: JSON.parse(jsonStr) };
    } catch {
      return { raw, isComment: false };
    }
  }
  return { raw, isComment: false };
}

class SseReader {
  private buf = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async nextFrame(deadline: number): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx !== -1) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("SSE read deadline exceeded waiting for a full frame");
      }
      // Real timer, justified (ts-no-test-timers integration exception): this
      // races the live SSE reader against a wall-clock read deadline — there is
      // no promise/event to await for "the server never sent a frame", so a
      // real timeout is the only way to bound a genuinely open network stream.
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE read timed out")), remaining),
        ),
      ]);
      if (result.done) {
        throw new Error("SSE stream closed unexpectedly before a frame completed");
      }
      this.buf += this.decoder.decode(result.value, { stream: true });
    }
  }
}

async function nextFrameMatching(
  sse: SseReader,
  predicate: (frame: ParsedFrame) => boolean,
  timeoutMs: number,
): Promise<ParsedFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await sse.nextFrame(deadline);
    const parsed = parseFrame(raw);
    if (predicate(parsed)) {
      return parsed;
    }
  }
}

describe("CR-CRU-014 §S1 — queue registration (server, additive)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  /** An on-disk, per-boot ephemeral store — never data/crucible.db, and the
   *  server always takes an OS-assigned port (never 3849, the live board). */
  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru014-queue-"));
    return startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`${base()}${path}`);
  }

  const ORCH = "orchestrator-1";

  async function registerOrchestrator(projectKey: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  /** Creates a project and registers the default orchestrator (workflow
   *  verbs require a live registered caller — CR-CRU-056 §S2b). */
  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    await registerOrchestrator(body.project.key);
    return body.project.key;
  }

  function queuePath(key: string): string {
    return `/api/v2/projects/${key}/queue`;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  /** POST a queue full-replace body; agentId is carried in case the route
   *  gates on a registered caller (harmless extra field if it does not). */
  async function postQueue(
    key: string,
    entries: Array<Record<string, unknown>>,
  ): Promise<Response> {
    return postJson(queuePath(key), { agentId: ORCH, entries });
  }

  async function getQueue(key: string): Promise<QueueGetResponse> {
    const res = await getJson(queuePath(key));
    expect(res.status).toBe(200);
    return (await res.json()) as QueueGetResponse;
  }

  // ── plan-flow helpers (real HTTP, never store.filePlan directly) ─────────

  /** Files a one-cycle OPEN plan for `cr` → the cr's derived status becomes
   *  IN_PROGRESS. Returns the plan + cycle ids. */
  async function filePlan(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    const res = await postJson(plansPath(key), { agentId: ORCH, cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, cycleId: body.cycles[0]!.id };
  }

  /** Drives the plan to CLOSED-WITH-MERGE (activate cycle → done → close with
   *  a merge commit) → the cr's derived status becomes COMPLETED. */
  async function closePlanWithMerge(
    key: string,
    planId: number,
    cycleId: number,
    commit: string,
  ): Promise<void> {
    const act = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      agentId: ORCH,
      status: "active",
    });
    expect(act.status).toBe(200);
    const done = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      agentId: ORCH,
      status: "done",
    });
    expect(done.status).toBe(200);
    const close = await patchJson(plansPath(key, `/${planId}`), {
      agentId: ORCH,
      status: "closed",
      merge: { commit },
    });
    expect(close.status).toBe(200);
  }

  function findEntry(entries: QueueEntry[], cr: string): QueueEntry {
    const e = entries.find((x) => x.cr === cr);
    expect(e).toBeDefined();
    return e!;
  }

  // ── AC — derived status walks PENDING → IN_PROGRESS → COMPLETED ──────────
  describe("AC — POST /queue with 3 entries → GET /queue derives PENDING/IN_PROGRESS/COMPLETED", () => {
    test(
      "a single fixture walks all three: a queued cr with NO plan is PENDING; after a plan is " +
        "filed (open) it is IN_PROGRESS carrying that plan's id; after the plan closes WITH a " +
        "merge commit it is COMPLETED — the other two entries never drift from PENDING",
      async () => {
        handle = boot();
        const key = await createProject("queue-derived-status");

        const posted = await postQueue(key, [
          { cr: "CR-CRU-014", title: "roadmap", wave: 5, dependsOn: ["CR-CRU-011"] },
          { cr: "CR-CRU-011", title: "join key", wave: 4, dependsOn: [] },
          { cr: "CR-CRU-013", title: "milestones", wave: 4, dependsOn: [] },
        ]);
        expect([200, 202]).toContain(posted.status);

        // Phase 1 — no plans filed anywhere → all three PENDING, no plan link.
        {
          const q = await getQueue(key);
          expect(q.ok).toBe(true);
          expect(q.entries.length).toBe(3);
          const e = findEntry(q.entries, "CR-CRU-014");
          expect(e.status).toBe("PENDING");
          expect(e.planId).toBeUndefined();
          expect(findEntry(q.entries, "CR-CRU-011").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-CRU-013").status).toBe("PENDING");
        }

        // Phase 2 — file an OPEN plan for CR-CRU-014 → IN_PROGRESS + plan link.
        const { planId, cycleId } = await filePlan(key, "CR-CRU-014");
        {
          const q = await getQueue(key);
          const e = findEntry(q.entries, "CR-CRU-014");
          expect(e.status).toBe("IN_PROGRESS");
          expect(e.planId).toBe(planId);
          // The sibling CRs (no plan) must NOT flip — a runaway derivation fails here.
          expect(findEntry(q.entries, "CR-CRU-011").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-CRU-013").status).toBe("PENDING");
        }

        // Phase 3 — close that plan WITH a merge commit → COMPLETED.
        await closePlanWithMerge(key, planId, cycleId, "deadbee014");
        {
          const q = await getQueue(key);
          const e = findEntry(q.entries, "CR-CRU-014");
          expect(e.status).toBe("COMPLETED");
          expect(e.planId).toBe(planId);
          expect(findEntry(q.entries, "CR-CRU-011").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-CRU-013").status).toBe("PENDING");
        }
      },
    );

    test(
      "the queue preserves each entry's registered wave, title and dependsOn verbatim on read " +
        "back (dependsOn is a string[] of CR ids, never normalized)",
      async () => {
        handle = boot();
        const key = await createProject("queue-fields-verbatim");

        expect(
          [200, 202].includes(
            (
              await postQueue(key, [
                { cr: "CR-CRU-009", title: "release bundle", wave: 3, dependsOn: ["CR-CRU-004", "CR-CRU-005"], size: "L" },
              ])
            ).status,
          ),
        ).toBe(true);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(1);
        const e = q.entries[0]!;
        expect(e.cr).toBe("CR-CRU-009");
        expect(e.title).toBe("release bundle");
        expect(String(e.wave)).toBe("3");
        expect(e.dependsOn).toEqual(["CR-CRU-004", "CR-CRU-005"]);
        expect(e.size).toBe("L");
      },
    );
  });

  // ── AC — full replace + idempotency + unknown-dependsOn flagging ─────────
  describe("AC — Queue replace is idempotent + full-replace; unknown dependsOn flagged", () => {
    test(
      "POSTing the SAME set twice yields no duplicates — GET returns exactly the 3 crs once each",
      async () => {
        handle = boot();
        const key = await createProject("queue-idempotent");

        const set = [
          { cr: "CR-CRU-001", wave: 1, dependsOn: [] },
          { cr: "CR-CRU-002", wave: 1, dependsOn: ["CR-CRU-001"] },
          { cr: "CR-CRU-003", wave: 2, dependsOn: ["CR-CRU-002"] },
        ];
        expect([200, 202]).toContain((await postQueue(key, set)).status);
        expect([200, 202]).toContain((await postQueue(key, set)).status);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(3);
        const crs = q.entries.map((e) => e.cr).sort();
        expect(crs).toEqual(["CR-CRU-001", "CR-CRU-002", "CR-CRU-003"]);
      },
    );

    test(
      "a second POST with a CHANGED set is a FULL REPLACE: the absent entry is removed, a " +
        "surviving entry's edited wave takes effect, and no leftovers remain",
      async () => {
        handle = boot();
        const key = await createProject("queue-full-replace");

        expect(
          [200, 202].includes(
            (
              await postQueue(key, [
                { cr: "CR-CRU-001", wave: 1, dependsOn: [] },
                { cr: "CR-CRU-002", wave: 1, dependsOn: ["CR-CRU-001"] },
                { cr: "CR-CRU-003", wave: 2, dependsOn: ["CR-CRU-002"] },
              ])
            ).status,
          ),
        ).toBe(true);

        // Replace: drop CR-CRU-003 entirely, re-wave CR-CRU-002.
        expect(
          [200, 202].includes(
            (
              await postQueue(key, [
                { cr: "CR-CRU-001", wave: 1, dependsOn: [] },
                { cr: "CR-CRU-002", wave: 9, dependsOn: ["CR-CRU-001"] },
              ])
            ).status,
          ),
        ).toBe(true);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(2);
        expect(q.entries.map((e) => e.cr).sort()).toEqual(["CR-CRU-001", "CR-CRU-002"]);
        expect(q.entries.some((e) => e.cr === "CR-CRU-003")).toBe(false);
        expect(String(findEntry(q.entries, "CR-CRU-002").wave)).toBe("9");
      },
    );

    test(
      "an unknown dependsOn target (a forward ref to a not-yet-queued CR) is ACCEPTED (200/202) " +
        "AND flagged in the response's unknownDependencies field — never rejected; the entry is " +
        "still stored and readable",
      async () => {
        handle = boot();
        const key = await createProject("queue-unknown-depends");

        const res = await postQueue(key, [
          { cr: "CR-CRU-100", wave: 1, dependsOn: ["CR-CRU-999"] },
          { cr: "CR-CRU-101", wave: 1, dependsOn: ["CR-CRU-100"] },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse;
        expect(body.ok).toBe(true);
        // The forward ref is flagged...
        expect(Array.isArray(body.unknownDependencies)).toBe(true);
        expect(body.unknownDependencies).toContain("CR-CRU-999");
        // ...but a KNOWN, in-set dependency is NOT flagged.
        expect(body.unknownDependencies).not.toContain("CR-CRU-100");

        // ...and the entry with the forward ref is nonetheless stored.
        const q = await getQueue(key);
        expect(q.entries.length).toBe(2);
        expect(findEntry(q.entries, "CR-CRU-100").dependsOn).toEqual(["CR-CRU-999"]);
      },
    );
  });

  // ── AC — validation 400 names the offending FIELD + INDEX ────────────────
  describe("AC — validation 400 names the offending field + index", () => {
    test(
      "an entry missing `wave` at index 2 → 400 whose error names BOTH the field (`wave`) and " +
        "the index (2); the valid earlier entries do not mask the offender",
      async () => {
        handle = boot();
        const key = await createProject("queue-validation-index");

        const res = await postQueue(key, [
          { cr: "CR-CRU-001", wave: 1, dependsOn: [] },
          { cr: "CR-CRU-002", wave: 1, dependsOn: [] },
          { cr: "CR-CRU-003", dependsOn: [] }, // index 2 — no wave
        ]);
        expect(res.status).toBe(400);
        const err = (await res.json()) as ErrResponse;
        expect(err.ok).toBe(false);
        expect(err.error).toContain("wave");
        expect(err.error).toContain("2");
      },
    );

    test(
      "an entry missing the required `cr` at index 0 → 400 naming BOTH `cr` and the index 0",
      async () => {
        handle = boot();
        const key = await createProject("queue-validation-cr");

        const res = await postQueue(key, [
          { wave: 1, dependsOn: [] }, // index 0 — no cr
        ]);
        expect(res.status).toBe(400);
        const err = (await res.json()) as ErrResponse;
        expect(err.ok).toBe(false);
        expect(err.error).toContain("cr");
        expect(err.error).toContain("0");
      },
    );
  });

  // ── AC — archived project handled like the other project routes ──────────
  describe("AC — an archived project's queue is excluded like the other project routes", () => {
    test(
      "GET /queue on an archived project returns 200 with an empty entries array; unarchiving " +
        "restores the registered entries intact (records excluded, never deleted)",
      async () => {
        handle = boot();
        const key = await createProject("queue-archived");

        expect(
          [200, 202].includes(
            (await postQueue(key, [{ cr: "CR-CRU-050", wave: 1, dependsOn: [] }])).status,
          ),
        ).toBe(true);
        expect((await getQueue(key)).entries.length).toBe(1);

        expect((await postJson(`/api/v2/projects/${key}/archive`, {})).status).toBe(200);
        const whileArchived = await getQueue(key);
        expect(whileArchived.entries).toEqual([]);

        expect((await postJson(`/api/v2/projects/${key}/unarchive`, {})).status).toBe(200);
        const after = await getQueue(key);
        expect(after.entries.length).toBe(1);
        expect(after.entries[0]!.cr).toBe("CR-CRU-050");
      },
    );
  });

  // ── AC — SSE fires on queue change ───────────────────────────────────────
  describe("AC — SSE fires on a queue change", () => {
    test(
      "after the hello frame, a POST /queue emits an SSE change frame carrying this project's " +
        "key within 1s",
      async () => {
        handle = boot();
        const key = await createProject("queue-sse");

        const res = await fetch(`${base()}/api/stream`);
        const reader = res.body!.getReader();
        const sse = new SseReader(reader);
        await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

        expect(
          [200, 202].includes(
            (await postQueue(key, [{ cr: "CR-CRU-060", wave: 1, dependsOn: [] }])).status,
          ),
        ).toBe(true);

        const frame = await nextFrameMatching(
          sse,
          (f) => !f.isComment && f.data?.projectKey === key,
          1000,
        );
        expect(frame.data?.projectKey).toBe(key);

        await reader.cancel();
      },
    );
  });

  // ── Design guard — the queue table is additive, SCHEMA_VERSION unchanged ─
  describe("design guard — queue_entries is created additively (no migration bump)", () => {
    test(
      "a queue round-trip succeeds against a freshly booted store WHILE that store still reports " +
        "schemaVersion === 7 (CREATE TABLE IF NOT EXISTS, no 7→8 chain step)",
      async () => {
        handle = boot();
        const key = await createProject("queue-schema-additive");

        expect(
          [200, 202].includes(
            (await postQueue(key, [{ cr: "CR-CRU-070", wave: 1, dependsOn: [] }])).status,
          ),
        ).toBe(true);
        expect((await getQueue(key)).entries.length).toBe(1);

        expect(handle.store.schemaVersion).toBe(7);
      },
    );
  });
});
