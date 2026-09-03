// CR-CRU-014 §S1 — Queue registration (server, additive). C1 RED tests.
//
// Spec (§S1, verbatim): `POST /api/v2/projects/<key>/queue` — full replace:
// `{entries:[{cr, title?, wave, dependsOn:[cr…], size?}]}`; validation 400s
// name the field + index; unknown `dependsOn` targets are allowed (forward
// refs) but flagged in the response. `GET …/queue` returns entries with
// DERIVED `status` (PENDING/IN_PROGRESS/COMPLETED via plans) + the plan link
// when present. SSE on change.
//
// Derived-status rule — AUTHORITATIVE, as amended by CR-CRU-083 §S1/§S2 (it
// was three plan-only values; the fourth consults release membership, because
// a CR that a release SHIPPED cannot honestly read "never started"). In
// PRECEDENCE order, for a cr registered in the queue:
//   1. an OPEN plan for the cr                      → IN_PROGRESS (+ planId)
//   2. a plan for the cr CLOSED WITH a merge commit → COMPLETED    (+ planId)
//   3. no such plan, but the cr appears in SOME release's `crs`
//                                                   → COMPLETED_UNTRACKED
//                                                      (NO planId — there is no
//                                                      plan to link to)
//   4. otherwise                                    → PENDING
// A plan record ALWAYS outranks release membership (CR-CRU-083 AC4), and
// nothing synthesises plan or cycle rows to make the answer tidy (AC5).
// `plans.cr` is the STABLE (verbatim, never-normalized) join key (spec
// §Forward-compatibility contract).
//
// ── Contract field names this RED file PINS (RED's prerogative per §S1) ────
//   POST /queue reply : { ok:true, entries: QueueEntry[], unknownDependencies:
//                         string[] } — 200 or 202.
//   GET  /queue reply : { ok:true, entries: QueueEntry[] }.
//   QueueEntry        : { cr, title?, wave, dependsOn: string[], size?,
//                         status: "PENDING"|"IN_PROGRESS"|"COMPLETED"
//                                 |"COMPLETED_UNTRACKED" (CR-CRU-083 §S2),
//                         planId? } — planId is the plan link, present only
//                         when a plan exists for the cr, so a
//                         COMPLETED_UNTRACKED entry never carries one.
//
// ── Schema design this file ASSUMES (stated per dispatch) ──────────────────
// The queue_entries TABLE is created ADDITIVELY via CREATE TABLE IF NOT
// EXISTS inside createBaseTables (the same way CR-017's runs surface is
// seeded), so CR-CRU-014 itself needed no migration chain step and
// SCHEMA_VERSION stayed 7 for this CR.
//
// The literal below is a TRIPWIRE, not a tautology: a chain step must make a
// human look. It fired for CR-CRU-091 §S2, which appends a step retrofitting
// this very table with release/track/lifecycle_json — legitimate and specified
// — so it is consciously RE-ARMED at 8 rather than derived from
// SCHEMA_VERSION, which would defend nothing. What this guard still asserts is
// unchanged: a freshly booted store round-trips the queue without any
// per-boot retrofit, and the version it reports is a value someone chose.
// tests/store-migration.test.ts derives every version from schemaVersion()
// (reads SCHEMA_VERSION) — it pins NO literal — so the two do different jobs.
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
import * as AppLogic from "../public/app-logic.mjs";

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
  /** CR-CRU-083 §S2 — the fourth derived value: shipped by a release, never
   *  plan-tracked. */
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
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

// ── CR-CRU-099 §S1 — the consumers this route's dropped fields feed ────────

/** §S2/AC23 as widened by CR-CRU-095 §S2 — the ONE warning wording, pinned
 *  once (the same string tests/queue-defaulted-seq-scope.test.ts pins) so the
 *  regression ACs below assert CR-CRU-095's shipped message and not a
 *  paraphrase of it. */
interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
  [key: string]: unknown;
}

function defaultedSeqMessage(crs: string[]): string {
  return (
    `seq was defaulted for ${crs.join(", ")} while a sibling in the same wave or release carries ` +
    `one on a DIFFERENT SCALE — the two interleave in an order nobody authored; run ` +
    `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`
  );
}

function expectDefaultedSeqWarning(warnings: WarningWire[] | undefined, crs: string[]): void {
  expect(warnings).toBeDefined();
  const warning = warnings!.find((w) => w.code === "defaulted-seq");
  expect(warning).toBeDefined();
  expect(warning!.crs).toEqual(crs);
  expect(warning!.message).toBe(defaultedSeqMessage(crs));
  expect(warning!.message).toContain("wave-sequence");
}

/** CR-CRU-078 §S4 — the strip gate `focusedReleaseView` answers zone 2 for.
 *  The ambient tests/app-logic.d.ts predates that export, so the module is
 *  cast to the one boundary read here (the house pattern, shared with
 *  tests/wave-loose-box-truthful.test.ts). */
interface StripGateLike {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}

interface WaveBoxLike {
  wave: string | null;
  active: boolean;
  entries: Array<{ cr: string }>;
  rows: Array<{ cr: string }>;
}

const Logic = AppLogic as unknown as {
  focusedReleaseView: (
    gate: StripGateLike,
    releases: unknown[],
    entries: unknown[],
  ) => { members: Array<{ cr: string }>; waves: WaveBoxLike[] };
};

const PROPOSED_020: StripGateLike = {
  version: "0.2.0",
  kind: "proposed",
  date: "",
  dateState: "absent",
};

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
          { cr: "CR-Q-1", title: "roadmap", wave: 5, dependsOn: ["CR-Q-2"] },
          { cr: "CR-Q-2", title: "join key", wave: 4, dependsOn: [] },
          { cr: "CR-Q-3", title: "milestones", wave: 4, dependsOn: [] },
        ]);
        expect([200, 202]).toContain(posted.status);

        // Phase 1 — no plans filed anywhere → all three PENDING, no plan link.
        {
          const q = await getQueue(key);
          expect(q.ok).toBe(true);
          expect(q.entries.length).toBe(3);
          const e = findEntry(q.entries, "CR-Q-1");
          expect(e.status).toBe("PENDING");
          expect(e.planId).toBeUndefined();
          expect(findEntry(q.entries, "CR-Q-2").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-Q-3").status).toBe("PENDING");
        }

        // Phase 2 — file an OPEN plan for CR-Q-1 → IN_PROGRESS + plan link.
        const { planId, cycleId } = await filePlan(key, "CR-Q-1");
        {
          const q = await getQueue(key);
          const e = findEntry(q.entries, "CR-Q-1");
          expect(e.status).toBe("IN_PROGRESS");
          expect(e.planId).toBe(planId);
          // The sibling CRs (no plan) must NOT flip — a runaway derivation fails here.
          expect(findEntry(q.entries, "CR-Q-2").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-Q-3").status).toBe("PENDING");
        }

        // Phase 3 — close that plan WITH a merge commit → COMPLETED.
        await closePlanWithMerge(key, planId, cycleId, "deadbee014");
        {
          const q = await getQueue(key);
          const e = findEntry(q.entries, "CR-Q-1");
          expect(e.status).toBe("COMPLETED");
          expect(e.planId).toBe(planId);
          expect(findEntry(q.entries, "CR-Q-2").status).toBe("PENDING");
          expect(findEntry(q.entries, "CR-Q-3").status).toBe("PENDING");
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
                { cr: "CR-Q-1", title: "release bundle", wave: 3, dependsOn: ["CR-Q-2", "CR-Q-3"], size: "L" },
              ])
            ).status,
          ),
        ).toBe(true);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(1);
        const e = q.entries[0]!;
        expect(e.cr).toBe("CR-Q-1");
        expect(e.title).toBe("release bundle");
        expect(String(e.wave)).toBe("3");
        expect(e.dependsOn).toEqual(["CR-Q-2", "CR-Q-3"]);
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
          { cr: "CR-Q-1", wave: 1, dependsOn: [] },
          { cr: "CR-Q-2", wave: 1, dependsOn: ["CR-Q-1"] },
          { cr: "CR-Q-3", wave: 2, dependsOn: ["CR-Q-2"] },
        ];
        expect([200, 202]).toContain((await postQueue(key, set)).status);
        expect([200, 202]).toContain((await postQueue(key, set)).status);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(3);
        const crs = q.entries.map((e) => e.cr).sort();
        expect(crs).toEqual(["CR-Q-1", "CR-Q-2", "CR-Q-3"]);
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
                { cr: "CR-Q-1", wave: 1, dependsOn: [] },
                { cr: "CR-Q-2", wave: 1, dependsOn: ["CR-Q-1"] },
                { cr: "CR-Q-3", wave: 2, dependsOn: ["CR-Q-2"] },
              ])
            ).status,
          ),
        ).toBe(true);

        // Replace: drop CR-Q-3 entirely, re-wave CR-Q-2.
        expect(
          [200, 202].includes(
            (
              await postQueue(key, [
                { cr: "CR-Q-1", wave: 1, dependsOn: [] },
                { cr: "CR-Q-2", wave: 9, dependsOn: ["CR-Q-1"] },
              ])
            ).status,
          ),
        ).toBe(true);

        const q = await getQueue(key);
        expect(q.entries.length).toBe(2);
        expect(q.entries.map((e) => e.cr).sort()).toEqual(["CR-Q-1", "CR-Q-2"]);
        expect(q.entries.some((e) => e.cr === "CR-Q-3")).toBe(false);
        expect(String(findEntry(q.entries, "CR-Q-2").wave)).toBe("9");
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
          { cr: "CR-Q-1", wave: 1, dependsOn: ["CR-Q-ABSENT"] },
          { cr: "CR-Q-2", wave: 1, dependsOn: ["CR-Q-1"] },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse;
        expect(body.ok).toBe(true);
        // The forward ref is flagged...
        expect(Array.isArray(body.unknownDependencies)).toBe(true);
        expect(body.unknownDependencies).toContain("CR-Q-ABSENT");
        // ...but a KNOWN, in-set dependency is NOT flagged.
        expect(body.unknownDependencies).not.toContain("CR-Q-1");

        // ...and the entry with the forward ref is nonetheless stored.
        const q = await getQueue(key);
        expect(q.entries.length).toBe(2);
        expect(findEntry(q.entries, "CR-Q-1").dependsOn).toEqual(["CR-Q-ABSENT"]);
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
          { cr: "CR-Q-1", wave: 1, dependsOn: [] },
          { cr: "CR-Q-2", wave: 1, dependsOn: [] },
          { cr: "CR-Q-3", dependsOn: [] }, // index 2 — no wave
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
            (await postQueue(key, [{ cr: "CR-Q-1", wave: 1, dependsOn: [] }])).status,
          ),
        ).toBe(true);
        expect((await getQueue(key)).entries.length).toBe(1);

        expect((await postJson(`/api/v2/projects/${key}/archive`, {})).status).toBe(200);
        const whileArchived = await getQueue(key);
        expect(whileArchived.entries).toEqual([]);

        expect((await postJson(`/api/v2/projects/${key}/unarchive`, {})).status).toBe(200);
        const after = await getQueue(key);
        expect(after.entries.length).toBe(1);
        expect(after.entries[0]!.cr).toBe("CR-Q-1");
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
            (await postQueue(key, [{ cr: "CR-Q-1", wave: 1, dependsOn: [] }])).status,
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

  // ── Design guard — the queue round-trip works at a KNOWN schema version ──
  describe("design guard — queue_entries needs no per-boot retrofit", () => {
    test(
      "a queue round-trip succeeds against a freshly booted store WHILE that store still reports " +
        "schemaVersion === 8 (the base CREATE TABLE writes the current shape whole)",
      async () => {
        handle = boot();
        const key = await createProject("queue-schema-additive");

        expect(
          [200, 202].includes(
            (await postQueue(key, [{ cr: "CR-Q-1", wave: 1, dependsOn: [] }])).status,
          ),
        ).toBe(true);
        expect((await getQueue(key)).entries.length).toBe(1);

        expect(handle.store.schemaVersion).toBe(8);
      },
    );
  });

  // ── CR-CRU-083 §S1/§S2/§S3 — the FOURTH derived value ───────────────────
  //
  // Spec: docs/changes/CR-CRU-083-derived-status-cannot-say-done.md
  //       §S1/§S2/§S3 + AC1/AC2/AC3/AC4/AC5/AC6/AC8/AC9. (AC7 — the badge,
  //       the inert row click and the graph node style — is a UI cycle and is
  //       deliberately NOT touched here.)
  //
  // WHY THESE EXIST. `PENDING` carries two incompatible meanings today: "not
  // started" and "finished before plan tracking existed". Measured on the live
  // board, CR-CRU-001–007, 010 and 016 render PENDING while `0.1.0`'s `crs`
  // carries all nine — the same board asserting both "never started" and "a
  // release bundled and shipped it". §S1 makes release membership authoritative
  // evidence of completion; §S2 names the honest state COMPLETED_UNTRACKED
  // rather than borrowing the fully-tracked COMPLETED presentation.
  //
  // RED expectation (measured against src/store.ts:3052): `deriveQueueStatus`
  // reads `listPlans` ALONE — zero plans returns `{ status: "PENDING" }` and no
  // second source is ever consulted — and `QueueStatus` (src/types.ts:310) has
  // three members. So every COMPLETED_UNTRACKED assertion below fails with the
  // derivation answering "PENDING": the missing contract, not a fixture bug.
  //
  // A release is recorded through the ceremony's OWN production entry — POST
  // /api/v2/milestones with {type:"release", label:<version>, commit,
  // releasedAt, crs} — the same route and body shape
  // tests/release-provenance.test.ts drives (CR-CRU-080 §S4/AC9). No route is
  // invented, `handleMilestones` (src/v2.ts:1164) carries `crs` verbatim and
  // `listReleases` (src/store.ts:2111) serves it, so membership here is real
  // stored evidence read back off the wire, never a fixture side-channel.
  describe("CR-CRU-083 §S1/§S2 — a shipped CR derives COMPLETED_UNTRACKED, never PENDING", () => {
    /**
     * Shipped in a release, never plan-tracked. The class was MEASURED on this
     * project's own board (CR-CRU-001–007, 010, 016 on 2026-09-02 — see the
     * block comment above), but the contract under test is id-independent, so
     * the fixture id is synthetic: what these tests assert is the RULE, not a
     * reproduction of any one row (CR-CRU-097 §S5/AC4).
     */
    const SHIPPED_CR = "CR-Q-SHIPPED";
    /** Genuinely unstarted: no plan, in no release's `crs` (AC2's class). */
    const UNSTARTED_CR = "CR-Q-UNSTARTED";
    /** Fully plan-tracked through merge — the COMPLETED comparison arm (AC3). */
    const TRACKED_CR = "CR-Q-TRACKED";

    /** Epoch SECONDS — the unit §S4 names as `releasedAt`'s source (`git log
     *  -1 --format=%ct <tag>`). A month back, so it can never be read as the
     *  ingest clock. */
    const SHIPPED_AT = Date.UTC(2026, 6, 10, 12, 0, 0) / 1000;

    interface ReleaseBrief {
      version?: string;
      crs?: string[];
      [key: string]: unknown;
    }

    interface ReleasesResponse extends OkResponse {
      releases: ReleaseBrief[];
    }

    interface PlansResponse extends OkResponse {
      plans: Array<Record<string, unknown>>;
    }

    async function listReleases(key: string): Promise<ReleaseBrief[]> {
      const res = await getJson(`/api/v2/projects/${key}/releases`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReleasesResponse;
      return body.releases;
    }

    /** Records a real `release` milestone carrying `crs` exactly as the
     *  ceremony does, then PROVES the membership landed by reading it back off
     *  GET …/releases — so no membership assertion below can pass, or fail, on
     *  a release that was never actually recorded. */
    async function recordRelease(
      key: string,
      version: string,
      commit: string,
      crs: readonly string[],
    ): Promise<void> {
      const res = await postJson("/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "release",
        label: version,
        commit,
        releasedAt: SHIPPED_AT,
        crs,
      });
      expect(res.status).toBe(201);
      const rel = (await listReleases(key)).find((r) => r.version === version);
      expect(rel).toBeDefined();
      expect([...(rel!.crs ?? [])].sort()).toEqual([...crs].sort());
    }

    /** The project's plan rows, optionally narrowed to one cr — AC5's
     *  instrument (a synthesised plan would show up here). */
    async function plansFor(key: string, cr?: string): Promise<Array<Record<string, unknown>>> {
      const res = await getJson(plansPath(key, cr === undefined ? "" : `?cr=${cr}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as PlansResponse;
      return body.plans;
    }

    /** Every entry's derived answer, cr-keyed and order-independent — the unit
     *  AC6/AC9 compare across a re-registration. */
    function derivations(entries: QueueEntry[]): Record<string, string> {
      const out: Record<string, string> = {};
      for (const e of entries) {
        out[e.cr] = `${e.status}/${e.planId ?? "-"}`;
      }
      return out;
    }

    /** Drives the plan to CLOSED-WITHOUT-MERGE — the ABANDONED plan: the
     *  cycle is activated then done (a plan cannot close over a non-terminal
     *  cycle), and the closing PATCH omits `merge` entirely. `merge` is
     *  OPTIONAL on PATCH …/plans/<id> (src/v2.ts:1480-1491) — the body is
     *  `{agentId, status:"closed"}` and nothing else — so this is a reachable
     *  production state, not a contrived one. Mirrors closePlanWithMerge in
     *  every other respect. */
    async function closePlanWithoutMerge(
      key: string,
      planId: number,
      cycleId: number,
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
      });
      expect(close.status).toBe(200);
      // PROVE the plan really is closed WITHOUT a merge — otherwise every
      // assertion below would be measuring a plan that never closed, or one
      // that closed with a merge and is legitimately COMPLETED.
      const plans = await plansFor(key);
      const row = plans.find((p) => p.planId === planId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("closed");
      expect(row!.merge).toBeUndefined();
    }

    test(
      "AC1 a queued cr with NO plan that a recorded release's crs names derives " +
        "COMPLETED_UNTRACKED and carries NO planId — the plan-only derivation answers PENDING, " +
        "which is the contradiction: the same board would say both 'never started' and 'shipped'",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-completed-untracked");

        expect(
          [200, 202],
        ).toContain(
          (
            await postQueue(key, [
              { cr: SHIPPED_CR, title: "pre-tracking work", wave: 1, dependsOn: [] },
              { cr: UNSTARTED_CR, title: "not started", wave: 1, dependsOn: [] },
            ])
          ).status,
        );

        // PRECONDITION — with no release recorded yet BOTH read PENDING, so the
        // flip below is caused by the release membership and nothing else.
        {
          const q = await getQueue(key);
          expect(findEntry(q.entries, SHIPPED_CR).status).toBe("PENDING");
          expect(findEntry(q.entries, UNSTARTED_CR).status).toBe("PENDING");
        }

        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        const q = await getQueue(key);
        const shipped = findEntry(q.entries, SHIPPED_CR);
        expect(shipped.status).toBe("COMPLETED_UNTRACKED");
        // NO plan link: there is no plan, and §S3/AC5 forbid inventing one.
        expect(shipped.planId).toBeUndefined();
        expect("planId" in shipped).toBe(false);
        // AC3 — distinct from BOTH neighbours; the values never collapse.
        expect(shipped.status).not.toBe("COMPLETED");
        expect(shipped.status).not.toBe("PENDING");
        // NON-VACUITY — membership is read PER CR, not "some release exists":
        // the cr this release did not ship is untouched.
        expect(findEntry(q.entries, UNSTARTED_CR).status).toBe("PENDING");
      },
    );

    test(
      "AC2 a queued cr with no plan and in NO release's crs stays PENDING: PENDING now carries " +
        "exactly one meaning — Crucible holds no evidence for this cr — so the genuinely " +
        "unstarted case is unchanged even while a sibling in the same queue is shipped",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-pending-unchanged");

        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: SHIPPED_CR, wave: 1, dependsOn: [] },
              { cr: UNSTARTED_CR, wave: 2, dependsOn: [] },
              { cr: "CR-Q-UNSTARTED-2", wave: 2, dependsOn: [] },
            ])
          ).status,
        );

        // Two releases exist and neither names the unstarted CRs — the
        // exclusion is membership-based, not "no releases recorded".
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);
        await recordRelease(key, "0.1.1", "aaa0002", ["CR-Q-OTHER"]);

        const q = await getQueue(key);
        // GUARD — the new contract must EXIST, or the PENDING claims below are
        // vacuous (a plan-only derivation would satisfy them by accident).
        expect(findEntry(q.entries, SHIPPED_CR).status).toBe("COMPLETED_UNTRACKED");

        for (const cr of [UNSTARTED_CR, "CR-Q-UNSTARTED-2"]) {
          const e = findEntry(q.entries, cr);
          expect(e.status).toBe("PENDING");
          expect(e.planId).toBeUndefined();
        }
      },
    );

    test(
      "AC4 a plan record ALWAYS outranks release membership: the SAME cr, present in a release's " +
        "crs, reads IN_PROGRESS while its plan is open and COMPLETED once that plan closes with " +
        "a merge — never COMPLETED_UNTRACKED, and carrying that plan's id throughout",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-plan-outranks-release");

        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: SHIPPED_CR, wave: 1, dependsOn: [] }])).status,
        );
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        // GUARD — release membership genuinely drives this cr's status first,
        // so "the plan outranks it" is a real precedence claim and not a
        // statement about a source the derivation never consulted.
        expect(findEntry((await getQueue(key)).entries, SHIPPED_CR).status).toBe(
          "COMPLETED_UNTRACKED",
        );

        const { planId, cycleId } = await filePlan(key, SHIPPED_CR);
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("IN_PROGRESS");
          expect(e.planId).toBe(planId);
          expect(e.status).not.toBe("COMPLETED_UNTRACKED");
        }

        await closePlanWithMerge(key, planId, cycleId, "deadbee001");
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("COMPLETED");
          expect(e.planId).toBe(planId);
          expect(e.status).not.toBe("COMPLETED_UNTRACKED");
        }
      },
    );

    test(
      "AC5 no synthetic plan or cycle row is created to satisfy the derivation: a cr reading " +
        "COMPLETED_UNTRACKED still has NO plan row on GET …/plans — before the read, and " +
        "unchanged after it — so nothing was fabricated to make the answer tidy",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-no-synthetic-rows");

        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: SHIPPED_CR, wave: 1, dependsOn: [] }])).status,
        );
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        // Before: the project holds no plans at all.
        expect(await plansFor(key)).toEqual([]);

        expect(findEntry((await getQueue(key)).entries, SHIPPED_CR).status).toBe(
          "COMPLETED_UNTRACKED",
        );

        // After: still none — neither for this cr nor anywhere in the project,
        // and therefore no cycles either (cycles hang off a plan row).
        expect(await plansFor(key, SHIPPED_CR)).toEqual([]);
        expect(await plansFor(key)).toEqual([]);
      },
    );

    test(
      "AC6 re-registering the queue changes no derived status: a full REPLACE with the identical " +
        "entries reads back byte-identical derivations, COMPLETED_UNTRACKED included — status is " +
        "derived at read time, never queue data",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-replace-preserves");

        const set = [
          { cr: SHIPPED_CR, title: "pre-tracking work", wave: 1, dependsOn: [] },
          { cr: TRACKED_CR, title: "tracked", wave: 2, dependsOn: [SHIPPED_CR] },
          { cr: UNSTARTED_CR, title: "not started", wave: 3, dependsOn: [] },
        ];
        expect([200, 202]).toContain((await postQueue(key, set)).status);

        // One of each: shipped-without-tracking, tracked through merge, unstarted.
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);
        const tracked = await filePlan(key, TRACKED_CR);
        await closePlanWithMerge(key, tracked.planId, tracked.cycleId, "deadbee021");

        const before = derivations((await getQueue(key)).entries);
        // GUARD — all three distinct values are actually present, so the
        // equality below is not three PENDINGs matching three PENDINGs.
        expect(before[SHIPPED_CR]).toBe("COMPLETED_UNTRACKED/-");
        expect(before[TRACKED_CR]).toBe(`COMPLETED/${tracked.planId}`);
        expect(before[UNSTARTED_CR]).toBe("PENDING/-");

        expect([200, 202]).toContain((await postQueue(key, set)).status);

        const after = derivations((await getQueue(key)).entries);
        expect(after).toEqual(before);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      },
    );

    test(
      "AC8 tracking attaches AFTER the cr exists and status follows it with NO queue " +
        "re-registration: one fixture walks PENDING → COMPLETED_UNTRACKED (a release names it) " +
        "→ IN_PROGRESS (an open plan is filed) → COMPLETED (that plan closes with a merge)",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-attach-after-creation");

        // Registered ONCE — the queue is never posted again in this walk.
        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: SHIPPED_CR, wave: 1, dependsOn: [] }])).status,
        );

        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("PENDING");
          expect(e.planId).toBeUndefined();
        }

        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("COMPLETED_UNTRACKED");
          expect(e.planId).toBeUndefined();
        }

        const { planId, cycleId } = await filePlan(key, SHIPPED_CR);
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("IN_PROGRESS");
          expect(e.planId).toBe(planId);
        }

        await closePlanWithMerge(key, planId, cycleId, "deadbee101");
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("COMPLETED");
          expect(e.planId).toBe(planId);
        }
      },
    );

    test(
      "AC9 an implemented cr never reads back PENDING: with one cr COMPLETED (plan closed with a " +
        "merge) and one COMPLETED_UNTRACKED (release membership), a full queue replace AND a " +
        "further unrelated release recording both leave the two statuses exactly as they were",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-implemented-never-pending");

        const set = [
          { cr: TRACKED_CR, wave: 1, dependsOn: [] },
          { cr: SHIPPED_CR, wave: 1, dependsOn: [] },
          { cr: UNSTARTED_CR, wave: 2, dependsOn: [] },
        ];
        expect([200, 202]).toContain((await postQueue(key, set)).status);

        const tracked = await filePlan(key, TRACKED_CR);
        await closePlanWithMerge(key, tracked.planId, tracked.cycleId, "deadbee021");
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        const before = derivations((await getQueue(key)).entries);
        expect(before[TRACKED_CR]).toBe(`COMPLETED/${tracked.planId}`);
        expect(before[SHIPPED_CR]).toBe("COMPLETED_UNTRACKED/-");

        // Two things that could plausibly rewrite settled fact: a full queue
        // replace, and a later release that names neither cr.
        expect([200, 202]).toContain((await postQueue(key, set)).status);
        await recordRelease(key, "0.2.0", "aaa0002", ["CR-Q-ELSEWHERE"]);

        const after = derivations((await getQueue(key)).entries);
        expect(after[TRACKED_CR]).toBe(before[TRACKED_CR]);
        expect(after[SHIPPED_CR]).toBe(before[SHIPPED_CR]);
        // Stated as the invariant itself: neither implemented state moves
        // backwards to PENDING.
        const implemented = findEntry((await getQueue(key)).entries, TRACKED_CR);
        expect(implemented.status).not.toBe("PENDING");
        const shipped = findEntry((await getQueue(key)).entries, SHIPPED_CR);
        expect(shipped.status).not.toBe("PENDING");
        expect(shipped.status).toBe("COMPLETED_UNTRACKED");
        // And the genuinely unstarted cr is still PENDING (nothing drifted).
        expect(after[UNSTARTED_CR]).toBe("PENDING/-");
      },
    );

    // ── AC4 (amended) / AC9 — the ABANDONED-plan backwards path ────────────
    //
    // The gap the VERIFY of cycle 253 measured. `deriveQueueStatus`
    // (src/store.ts:3095) consults `shipped` ONLY on the zero-plans path; the
    // fallthrough — plans exist, none open, none closed-with-merge — returns
    // PENDING without ever asking whether a release shipped the cr. Because
    // `merge` is OPTIONAL on PATCH …/plans/<id> (src/v2.ts:1480-1491), closing
    // a plan with no merge body is a plain production route call, so a shipped
    // cr that reads COMPLETED_UNTRACKED can be walked BACKWARDS to PENDING by
    // filing a plan and abandoning it. That is exactly the contradiction AC9
    // forbids ("an implemented cr never reads back PENDING").
    //
    // AC4 as amended by this CR settles the answer: an abandoned plan is not
    // evidence of work and does NOT un-ship a release — for a cr in some
    // release's `crs` whose plans are all closed-or-aborted WITHOUT a merge
    // the answer stays COMPLETED_UNTRACKED. Open plans and merged plans keep
    // their current answers untouched.
    test(
      "AC4/AC9 an ABANDONED plan does not un-ship a release: a shipped cr walks " +
        "COMPLETED_UNTRACKED → IN_PROGRESS (plan filed) → back to COMPLETED_UNTRACKED once that " +
        "plan closes with NO merge commit — never backwards to PENDING",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-abandoned-plan-shipped");

        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: SHIPPED_CR, wave: 1, dependsOn: [] },
              { cr: UNSTARTED_CR, wave: 2, dependsOn: [] },
            ])
          ).status,
        );
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        // GUARD — release membership genuinely drives this cr before any plan
        // exists, so the final assertion is a real "the plan did not un-ship
        // it" claim and not a value that was never there.
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("COMPLETED_UNTRACKED");
        }

        // An open plan still outranks membership (AC4's untouched half).
        const { planId, cycleId } = await filePlan(key, SHIPPED_CR);
        {
          const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
          expect(e.status).toBe("IN_PROGRESS");
          expect(e.planId).toBe(planId);
        }

        // The plan is ABANDONED — closed through the production route with no
        // `merge` in the body. The release that shipped this cr is unchanged.
        await closePlanWithoutMerge(key, planId, cycleId);

        const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
        // The invariant, stated as AC9 words it…
        expect(e.status).not.toBe("PENDING");
        // …and the value AC4 (amended) names.
        expect(e.status).toBe("COMPLETED_UNTRACKED");
        // Nothing else drifted: the unshipped, unplanned sibling is untouched.
        expect(findEntry((await getQueue(key)).entries, UNSTARTED_CR).status).toBe("PENDING");
      },
    );

    test(
      "AC4 boundary — the fix is membership-gated, not a blanket rewrite: a cr in NO release's " +
        "crs whose only plan closed WITHOUT a merge still reads PENDING, and still carries that " +
        "trailing plan's id",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-abandoned-plan-unshipped");

        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: UNSTARTED_CR, wave: 1, dependsOn: [] }])).status,
        );
        // A release EXISTS but names a different cr — so PENDING below is a
        // membership decision, not "no releases were ever recorded".
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        const { planId, cycleId } = await filePlan(key, UNSTARTED_CR);
        expect(findEntry((await getQueue(key)).entries, UNSTARTED_CR).status).toBe("IN_PROGRESS");

        await closePlanWithoutMerge(key, planId, cycleId);

        const e = findEntry((await getQueue(key)).entries, UNSTARTED_CR);
        expect(e.status).toBe("PENDING");
        expect(e.status).not.toBe("COMPLETED_UNTRACKED");
        // The trailing plan link survives — an abandoned plan is still the
        // plan record this cr has, and the wire keeps pointing at it.
        expect(e.planId).toBe(planId);
      },
    );

    test(
      "AC5/§S2 wire shape — a shipped cr whose plan was abandoned carries NO planId: " +
        "COMPLETED_UNTRACKED omits the key entirely (QueueEntry, src/types.ts), so no consumer " +
        "can link an untracked completion to a plan that never delivered it",
      async () => {
        handle = boot();
        const key = await createProject("queue-083-abandoned-plan-no-planid");

        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: SHIPPED_CR, wave: 1, dependsOn: [] }])).status,
        );
        await recordRelease(key, "0.1.0", "aaa0001", [SHIPPED_CR]);

        const { planId, cycleId } = await filePlan(key, SHIPPED_CR);
        await closePlanWithoutMerge(key, planId, cycleId);

        const e = findEntry((await getQueue(key)).entries, SHIPPED_CR);
        expect(e.status).toBe("COMPLETED_UNTRACKED");
        // The KEY is absent, not merely undefined — `planId is present only
        // when a plan exists, so a COMPLETED_UNTRACKED entry never carries
        // one` (src/types.ts QueueEntry doc), pinned as written.
        expect("planId" in e).toBe(false);
        // AC5 — and nothing was synthesised or deleted to make that tidy: the
        // abandoned plan row is still there, exactly one of it.
        const plans = await plansFor(key, SHIPPED_CR);
        expect(plans.length).toBe(1);
        expect(plans[0]!.planId).toBe(planId);
        expect(plans[0]!.status).toBe("closed");
      },
    );
  });

  // ── CR-CRU-099 §S1 — the handler reads the fields it accepts ─────────────
  //
  // WHY HERE. This is the bulk route's own suite and the established home of
  // its `entries[]` field contract — `cr`, `title`, `wave`, `dependsOn` and
  // `size` are each pinned above, and the validation 400s that name a field
  // AND an index with them. A field this route ACCEPTS and DROPS belongs
  // beside them. The two alternatives were rejected:
  // tests/queue-defaulted-seq-scope.test.ts is CR-CRU-095's, which is shipped
  // and not edited, and tests/roadmap-registration-routes.test.ts is the five
  // per-CR verbs' suite — this route is not one of them.
  //
  // WHAT IS BROKEN TODAY. `handleQueuePost` builds its `QueueEntryInput` from
  // `cr/title/wave/dependsOn/size/seq` (src/v2.ts:1865-1876) and never reads
  // `fields.release`, `fields.track` or `fields.lifecycle` — three keys
  // `QueueEntryInput` DECLARES (src/store.ts:283-287) and which `replaceQueue`
  // already accepts, normalises and stores. The route still answers 200, so
  // the loss is indistinguishable from success at the call site.
  //
  // WHY EVERY FIXTURE POSTS A CR THE STORE HAS NEVER SEEN. Carry-forward hides
  // the defect on a live board: `replaceQueue` writes
  // `entry.release ?? snapshot?.release ?? null` (src/store.ts:3599), so a
  // re-post preserves the release `cr-plan` set. The loss lands only on rows
  // the bulk post CREATES — which is the e2e scenario's shape
  // (tests/e2e/features/roadmap-graph.feature:38) and a fresh board's.
  describe("CR-CRU-099 §S1 — the bulk queue post READS the fields it accepts", () => {
    /** The declared target release every fixture below posts into. */
    const RELEASE = "0.2.0";

    test(
      "AC1 a declared `release` is STORED: the POST reply and the subsequent GET both carry it " +
        "byte-identically to what was sent — today the route never reads `fields.release`, so the " +
        "row reads back release-less",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-stored");
        const res = await postQueue(key, [
          { cr: "CR-Q99-A", title: "Graph CR", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        // BOTH boundaries: the reply the caller reads, and the row the next
        // reader gets. A route that answered one while dropping the other
        // would still be this defect.
        const posted = (await res.json()) as QueuePostResponse;
        expect(findEntry(posted.entries, "CR-Q99-A").release).toBe(RELEASE);
        const stored = findEntry((await getQueue(key)).entries, "CR-Q99-A");
        expect(stored.release).toBe(RELEASE);
        // BYTE-identical — no normalisation, no re-labelling, no defaulting.
        expect(JSON.stringify(stored.release)).toBe(JSON.stringify(RELEASE));
      },
    );

    test(
      "AC2 the posted row is then a MEMBER of its release: `focusedReleaseView` over the PUBLISHED " +
        "payload names it and hands zone 2 its wave box — while the same payload with `release` " +
        "dropped, which is what the route stores today, is a member of nothing",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-membership");
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-M", title: "Graph CR", wave: "5", dependsOn: [], release: RELEASE },
            ])
          ).status,
        );
        // The PUBLISHED payload, consumed verbatim by the pure view the
        // roadmap renders from. Membership is decided here, not in the DOM.
        const entries = (await getQueue(key)).entries;
        const view = Logic.focusedReleaseView(PROPOSED_020, [], entries);
        expect(view.members.map((member) => member.cr)).toEqual(["CR-Q99-M"]);
        const box = view.waves.find((candidate) => candidate.wave === "5");
        expect(box).toBeDefined();
        expect(box!.entries.map((member) => member.cr)).toEqual(["CR-Q99-M"]);
        expect(box!.rows.map((member) => member.cr)).toEqual(["CR-Q99-M"]);
        expect(box!.active).toBe(true);
        // NON-VACUITY — membership is filtered on `entry?.release === version`
        // (public/app-logic.mjs:1275), so the release-less row today's route
        // stores is a member of nothing: no wave box, no rows, no warning.
        const releaseless = entries.map((entry) => {
          const copy: Record<string, unknown> = { ...entry };
          delete copy.release;
          return copy;
        });
        const blind = Logic.focusedReleaseView(PROPOSED_020, [], releaseless);
        expect(blind.members).toEqual([]);
        expect(blind.waves).toEqual([]);
      },
    );

    test(
      "AC4 `track` and `lifecycle` store on the SAME FOOTING as `release`: one post declaring every " +
        "key `QueueEntryInput` accepts reads back carrying all of them, so the route silently " +
        "ignores none of them",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-every-declared-key");
        // `at` is epoch MILLISECONDS — the unit `QueueLifecycle` declares
        // (src/types.ts:360-363).
        const lifecycle = { state: "VOID", reason: "folded into CR-Q99-A", at: 1_787_149_125_000 };
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              {
                cr: "CR-Q99-B",
                title: "declares everything",
                wave: "5",
                dependsOn: ["CR-Q99-A"],
                size: "M",
                release: RELEASE,
                track: "Track 2",
                seq: 5007,
                lifecycle,
              },
            ])
          ).status,
        );
        const e = findEntry((await getQueue(key)).entries, "CR-Q99-B");
        // The six the route already read — unchanged by this CR.
        expect(e.title).toBe("declares everything");
        expect(String(e.wave)).toBe("5");
        expect(e.dependsOn).toEqual(["CR-Q99-A"]);
        expect(e.size).toBe("M");
        expect(e.seq).toBe(5007);
        // The three it dropped.
        expect(e.release).toBe(RELEASE);
        // `track` is the ONE declared field carrying a normaliser: any
        // accepted spelling is stored in the PRD's locked wire format
        // (`normalizeTrack`, src/store.ts:345-348), so "Track 2" reads back
        // `track-2` — normalised on write, never verbatim and never refused.
        expect(e.track).toBe("track-2");
        expect(e.lifecycle).toEqual(lifecycle);
      },
    );

    test(
      "AC4a a `track` carrying no lane number is refused 400 naming BOTH the field and the index — " +
        "never the 500 `replaceQueue`'s plain Error would answer — and the queue it would have " +
        "replaced is untouched",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-track-refusal");
        // A queue the refusal must leave EXACTLY as it stands: `replaceQueue`
        // is a full replace, so a refusal that ran the write would be visible
        // here as a lost row.
        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: "CR-Q99-HELD", wave: "5", dependsOn: [] }])).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-HELD", wave: "5", dependsOn: [] },
          { cr: "CR-Q99-BAD", wave: "5", dependsOn: [], track: "the fast lane" },
        ]);
        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        // The route's OWN shape for a malformed field, as `dependsOn` and
        // `seq` already answer it (src/v2.ts:1851-1864): the field by name and
        // the INDEX of the offender — 1, never the valid entry at 0.
        expect(body.error).toContain("track");
        expect(body.error).toMatch(/index 1\b/);
        const entries = (await getQueue(key)).entries;
        expect(entries.map((entry) => entry.cr)).toEqual(["CR-Q99-HELD"]);
      },
    );

    test(
      "AC4b a `lifecycle` that is not one is refused 400 by name and index — the shape `dependsOn` " +
        "and `seq` already use — rather than stringified into `lifecycle_json`, where the next " +
        "reader publishes it as a `QueueLifecycle` it is not",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-lifecycle-shape");
        // Exactly what `QueueLifecycle` DECLARES (src/types.ts:365-372) and
        // nothing about the disposition itself: a scalar is not a lifecycle, a
        // `state` outside the two declared values is not one, and `at` — epoch
        // MILLISECONDS, required — is not optional. Which disposition is
        // legitimate for a cr is `cr-supersede`/`cr-void`'s business
        // (`handleCrLifecycle` in `src/v2.ts`), not this route's.
        const rejected: unknown[] = [
          "VOID",
          42,
          [{ state: "VOID", at: 1 }],
          { state: "RETIRED", at: 1_787_149_125_000 },
          { state: "VOID" },
          { state: "VOID", at: "1787149125000" },
        ];
        for (const lifecycle of rejected) {
          const res = await postQueue(key, [
            { cr: "CR-Q99-OK", wave: "5", dependsOn: [] },
            { cr: "CR-Q99-LC", wave: "5", dependsOn: [], lifecycle },
          ]);
          expect(res.status).toBe(400);
          const body = (await res.json()) as ErrResponse;
          expect(body.error).toContain("lifecycle");
          expect(body.error).toMatch(/index 1\b/);
          // Refused before the write: the full replace never ran.
          expect((await getQueue(key)).entries).toEqual([]);
        }
        // NON-VACUITY — a lifecycle that IS one lands, so the refusals above
        // are a shape verdict and not a blanket rejection of the field.
        const ok = await postQueue(key, [
          {
            cr: "CR-Q99-LC",
            wave: "5",
            dependsOn: [],
            lifecycle: { state: "SUPERSEDED", by: "CR-Q99-OK", at: 1_787_149_125_000 },
          },
        ]);
        expect([200, 202]).toContain(ok.status);
        expect(findEntry((await getQueue(key)).entries, "CR-Q99-LC").lifecycle).toEqual({
          state: "SUPERSEDED",
          by: "CR-Q99-OK",
          at: 1_787_149_125_000,
        });
      },
    );

    test(
      "AC6 regression — `release` is NOT mandatory: a post without it still lands and still stores a " +
        "release-LESS row (the key ABSENT, never a fabricated default), and a fresh import still " +
        "warns about nothing",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-optional");
        const res = await postQueue(key, [
          { cr: "CR-Q99-N1", wave: "5", dependsOn: [] },
          { cr: "CR-Q99-N2", wave: "5", dependsOn: [] },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        // CR-CRU-095 AC12b — "a fresh import raises no warning at all".
        expect(body.warnings ?? []).toEqual([]);
        const entries = (await getQueue(key)).entries;
        for (const cr of ["CR-Q99-N1", "CR-Q99-N2"]) {
          // ABSENT, not null: an undeclared release is a fact
          // (src/store.ts:262-266) and `listQueue` omits the key entirely.
          expect("release" in findEntry(entries, cr)).toBe(false);
        }
        // CR-CRU-095 §S3 unchanged — both still default into wave 5's block.
        expect(findEntry(entries, "CR-Q99-N1").seq).toBe(5001);
        expect(findEntry(entries, "CR-Q99-N2").seq).toBe(5002);
        // And a release-less row is a member of nothing — CR-CRU-095's own
        // rule, not a regression this CR introduces.
        expect(Logic.focusedReleaseView(PROPOSED_020, [], entries).members).toEqual([]);
      },
    );

    test(
      "AC6 regression — the WAVE axis still warns exactly as CR-CRU-095 §S2 requires: a release-less " +
        "defaulted row beside a HELD positional same-wave sibling is named, in that CR's own code and " +
        "wording, and the sibling is not",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-releaseless-wave-axis");
        // A HELD positional seq: `10` is outside wave 5's block (5001–5999,
        // `inWaveBlock`), and an explicit seq rides the bulk post
        // (CR-CRU-091 §S2).
        expect([200, 202]).toContain(
          (await postQueue(key, [{ cr: "CR-Q99-P", wave: "5", dependsOn: [], seq: 10 }])).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-P", wave: "5", dependsOn: [] },
          { cr: "CR-Q99-D", wave: "5", dependsOn: [] },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        expectDefaultedSeqWarning(body.warnings, ["CR-Q99-D"]);
        const entries = (await getQueue(key)).entries;
        // The held positional value is carried forward untouched, and the
        // defaulted row takes its own block's first slot — the two scales the
        // warning is about.
        expect(findEntry(entries, "CR-Q99-P").seq).toBe(10);
        expect(findEntry(entries, "CR-Q99-D").seq).toBe(5001);
      },
    );

    test(
      "AC7 the shape CR-CRU-095 §S2 declared unreachable now OCCURS: a NEW row posted WITH `release` " +
        "and no `seq` is defaulted AND release-bearing — and it lands in its own wave block, so it " +
        "is IN SCALE beside its authored siblings and warns about nothing",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-defaulted-and-release-bearing");
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-A1", wave: "5", dependsOn: [], release: RELEASE, seq: 5001 },
              { cr: "CR-Q99-A2", wave: "5", dependsOn: [], release: RELEASE, seq: 5002 },
            ])
          ).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-A1", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-A2", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-NEW", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        const entries = (await getQueue(key)).entries;
        const fresh = findEntry(entries, "CR-Q99-NEW");
        // BOTH halves of the shape §S2 ruled impossible — "a row the bulk post
        // defaults is always new and release-less" — in ONE row.
        expect(fresh.release).toBe(RELEASE);
        expect(fresh.seq).toBe(5003);
        // Carry-forward left the authored block exactly where it was
        // (CR-CRU-095 AC12a: appended after it, never colliding).
        expect(findEntry(entries, "CR-Q99-A1").seq).toBe(5001);
        expect(findEntry(entries, "CR-Q99-A2").seq).toBe(5002);
        // IN SCALE ⇒ SILENT. A mixture is a DIFFERENCE OF SCALE, never "this
        // write chose the value" (CR-CRU-095 §S2, ruled 2026-09-02), and every
        // compared row here sits inside wave 5's own block.
        expect(body.warnings ?? []).toEqual([]);
      },
    );

    test(
      "AC7 and a GENUINE difference of scale still warns: the release-BEARING defaulted row is named " +
        "when its own wave holds a held positional sibling — the pre-existing wave axis " +
        "(CR-CRU-095 AC11/AC12b), now reached by a row that carries a release",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-bearing-wave-axis");
        // Legacy positional `62` in wave 6's terms is wave 5's out-of-block
        // value here: held, carried forward, and not counted toward the slot.
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-L", wave: "5", dependsOn: [], release: RELEASE, seq: 62 },
            ])
          ).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-L", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-F", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        // A write names ITS OWN ROW, and only it: the legacy positional value
        // was named by the write that chose it (CR-CRU-095 AC11a).
        expectDefaultedSeqWarning(body.warnings, ["CR-Q99-F"]);
        const entries = (await getQueue(key)).entries;
        const fresh = findEntry(entries, "CR-Q99-F");
        expect(fresh.seq).toBe(5001);
        expect(fresh.release).toBe(RELEASE);
        const legacy = findEntry(entries, "CR-Q99-L");
        expect(legacy.seq).toBe(62);
        expect(legacy.release).toBe(RELEASE);
      },
    );

    // ── AC7's own axis — the RELEASE one, unreachable through this route
    // until §S1 ───────────────────────────────────────────────────────────
    //
    // CR-CRU-095 §S2 widened `defaulted-seq` from "a sibling in the same wave"
    // to "the same wave OR the same release", and implemented the release half
    // in `upsertQueueEntry` ALONE (its `const scale` / `const mixed` pair,
    // whose sibling query is `(wave = ? OR release = ?)`) for one stated
    // reason: *"the bulk route never forwards `release` … a row the bulk post
    // defaults is always new and release-less … so a bulk cross-wave
    // `defaulted-seq` is unreachable by construction"*. §S1 forwards it, so
    // the premise is gone and the axis is reachable from here.
    //
    // MEASURED before this test existed, on ONE configuration (0.2.0 wave 5
    // authored at 5001, 0.2.0 wave 6 holding positional 2, then a new
    // release-bearing seq-less row into wave 5): the bulk post answered
    // `defaultedSeq: []` and `cr-plan` answered `["NEW"]` for the same board.
    // A release on two scales is a property of the RELEASE, not of the writer
    // that got there, so the two must converge — ruled by the user 2026-09-03
    // on this cycle's report.
    test(
      "AC7 the RELEASE axis, now reachable: a NEW release-bearing defaulted row is NAMED when ANOTHER " +
        "wave of the SAME RELEASE holds a positional seq — the same code, the same wording and the " +
        "same `wave-sequence` remedy `cr-plan` already answers the identical board with",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-axis");
        // CR-CRU-095 AC9's fixture, reached through the BULK route: release
        // 0.2.0 with wave 5 authored (5001+) and a wave-6 row of the SAME
        // release holding positional seq 2.
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-AU", wave: "5", dependsOn: [], release: RELEASE, seq: 5001 },
              { cr: "CR-Q99-W6", wave: "6", dependsOn: [], release: RELEASE, seq: 2 },
            ])
          ).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-AU", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-W6", wave: "6", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-RB", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        // Named — and ONLY its own row: the positional wave-6 value was named
        // by the write that chose it (CR-CRU-095 AC11a).
        expectDefaultedSeqWarning(body.warnings, ["CR-Q99-RB"]);
        const entries = (await getQueue(key)).entries;
        const fresh = findEntry(entries, "CR-Q99-RB");
        // It is the RELEASE axis and nothing else: the row's own wave holds no
        // out-of-block value, so the wave axis is silent for it, and its slot
        // is its own block's next free one.
        expect(fresh.seq).toBe(5002);
        expect(fresh.release).toBe(RELEASE);
        expect(findEntry(entries, "CR-Q99-AU").seq).toBe(5001);
        expect(findEntry(entries, "CR-Q99-W6").seq).toBe(2);
        // warn-and-WRITE — the post landed, nothing was refused.
        expect(body.ok).toBe(true);
      },
    );

    test(
      "AC7 release-axis CONVERSE — a release whose every compared row shares a scale is SILENT: waves " +
        "5 and 6 of 0.2.0 both authored in their own blocks, and the new release-bearing defaulted " +
        "row beside them names nobody (CR-CRU-095 AC10 through this route)",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-axis-one-scale");
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-S5", wave: "5", dependsOn: [], release: RELEASE, seq: 5001 },
              { cr: "CR-Q99-S6", wave: "6", dependsOn: [], release: RELEASE, seq: 6001 },
            ])
          ).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-S5", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-S6", wave: "6", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-SN", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        // A mixture is a DIFFERENCE OF SCALE, never "this write chose the
        // value" (CR-CRU-095 §S2, ruled 2026-09-02) — so a row defaulted
        // in-block beside in-block siblings warns about nothing.
        expect(body.warnings ?? []).toEqual([]);
        const entries = (await getQueue(key)).entries;
        expect(findEntry(entries, "CR-Q99-SN").seq).toBe(5002);
        expect(findEntry(entries, "CR-Q99-SN").release).toBe(RELEASE);
      },
    );

    test(
      "AC7 release-axis NULL semantics — a positional sibling declaring NO release is never compared " +
        "on the release axis: the same fixture with the wave-6 row release-less names NOBODY, which " +
        "is what keeps the live board's 66 release-less rows silent (CR-CRU-095 AC9a)",
      async () => {
        handle = boot();
        const key = await createProject("queue-099-release-axis-null");
        expect([200, 202]).toContain(
          (
            await postQueue(key, [
              { cr: "CR-Q99-NU", wave: "5", dependsOn: [], release: RELEASE, seq: 5001 },
              // The ONE difference from the naming fixture above: no release.
              { cr: "CR-Q99-NW", wave: "6", dependsOn: [], seq: 2 },
            ])
          ).status,
        );
        const res = await postQueue(key, [
          { cr: "CR-Q99-NU", wave: "5", dependsOn: [], release: RELEASE },
          { cr: "CR-Q99-NW", wave: "6", dependsOn: [] },
          { cr: "CR-Q99-NN", wave: "5", dependsOn: [], release: RELEASE },
        ]);
        expect([200, 202]).toContain(res.status);
        const body = (await res.json()) as QueuePostResponse & { warnings?: WarningWire[] };
        expect(body.warnings ?? []).toEqual([]);
        const entries = (await getQueue(key)).entries;
        // The positional row is still there, still out of block, still
        // release-less — the silence is the NULL semantics, not a missing row.
        expect(findEntry(entries, "CR-Q99-NW").seq).toBe(2);
        expect("release" in findEntry(entries, "CR-Q99-NW")).toBe(false);
        expect(findEntry(entries, "CR-Q99-NN").seq).toBe(5002);
      },
    );
  });
});
