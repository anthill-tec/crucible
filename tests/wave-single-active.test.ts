// CR-CRU-116 §S1/§S2/§S3 — only ONE wave is active, and Crucible refuses the
// alternative. C1 RED.
//
// The rule this CR lifts already ships one container down. `transitionCycle`
// (src/store.ts:3269-3295) refuses a second active sibling with
// `code: "already-active"` and refuses activating ahead of a seq-earlier
// pending sibling with `code: "out-of-order"`; `CycleTransitionError`
// (src/store.ts:589-596) already names both codes. A WAVE is the same kind of
// object one level up, so this suite drives the SAME two codes out of the
// plans POST — the write that opens work — and asserts no third code string
// is invented for the wave scope.
//
// ── RE-PINNED 2026-09-09 (CR-CRU-116 close-out) ───────────────────────────
//
// Every `src/` range in this header was written against the PRE-guard tree
// and re-read at HEAD before it was rewritten. All four shifts are OURS:
// §S1/§S2/§S3 inserted 31 lines at src/store.ts:603 and 8 at the top of
// src/v2.ts, and §S1 lifted the in-flight rule into `Store.queueStatusOf`
// ABOVE `deriveQueueStatus`.
//   `transitionCycle`'s refusals   store.ts:3238-3264 -> :3269-3295
//   `deriveQueueStatus`            store.ts:4098-4111 -> :4256-4262
//   `handlePlanFile`               v2.ts:1367-1436    -> :1375-1460
//   its dispatch in `handlePlansRoute`  v2.ts:2918-2928 -> :2941-2951
// The CR that moves a file re-pins what cites it — in the files it authored
// as well as in the one file a guard happens to watch. The snapshot below is
// dated because it describes the tree at RED; its ranges now name the SAME
// constructs at their HEAD positions, where the guard this CR added lives.
//
// ── WHAT WAS BROKEN AT RED (read 2026-09-09, before §S2's guard) ──────────
//
// `handlePlanFile` (src/v2.ts:1375-1460), which `handlePlansRoute` dispatches
// at :2941-2951, validates `cr`, `cycles`, `title`, `orchestrator`, `wave` and
// `track` and then calls `store.filePlan` — it never read the queue and asked
// nothing about waves. So every refusal asserted below answered
// `201 {ok:true}`, which is exactly the RED signal: the guard did not exist.
//
// ── THE ONE SOURCE OF ACTIVENESS ──────────────────────────────────────────
//
// A wave is ACTIVE while it holds a CR the queue derives as `IN_PROGRESS`.
// That derivation is `deriveQueueStatus` (src/store.ts:4256-4262), which
// since §S1 delegates to `Store.queueStatusOf` (:4270-4292) where the rule is
// spelled once: `plans.find((plan) => plan.status === "open")` (:4279).
// `plan.status` has THREE values — `open`, `closed`, `aborted` — and only
// `open` confers activeness, which is why the aborted-plan fixture below is a
// fixture and not a footnote: the live board carries 6 aborted plans across
// waves 4 and 5 and 0 open ones, so a rule keyed on "a plan that is not
// closed" would mark both of those waves active forever.
//
// The guard reads the wave from the QUEUE ENTRY, never from `plan.wave`. The
// two disagree in live data (plan 95 carries `wave: 6` while the queue
// declares `CR-CRU-092` in wave 5), and the §S1 fixture below reproduces
// exactly that disagreement.
//
// Every server here boots on an OS-assigned port against an mkdtempSync
// scratch db. The live data/crucible.db and port 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes this suite PINS ───────────────────────────────────────────

interface LifecycleWire {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
}

interface QueueEntryWire {
  cr: string;
  wave: string;
  status: string;
  planId?: number;
  lifecycle?: LifecycleWire;
}

interface CycleWire {
  id: number;
  label: string;
  status: string;
}

interface PlanWire {
  planId: number;
  cr: string;
  status: string;
  wave?: string;
}

interface AnyBody {
  ok?: boolean;
  error?: string;
  /** CR-CRU-116 §S1/§S2 — the refusal discriminator, reused VERBATIM from the
   *  cycle scope: `already-active` | `out-of-order`, and nothing else. */
  code?: string;
  help?: string[];
  project?: { key: string };
  entries?: QueueEntryWire[];
  plans?: PlanWire[];
  planId?: number;
  cr?: string;
  status?: string;
  wave?: string;
  cycles?: CycleWire[];
  plan?: PlanWire;
}

/** The two codes `CycleTransitionError` already declares. §S1's census
 *  asserts the wave scope introduces NOTHING beyond this pair. */
const WAVE_REFUSAL_CODES = ["already-active", "out-of-order"] as const;

const ORCH = "cru116-orchestrator";

// Every cr id below is DIGIT-FREE on purpose: the ACs require the refusal to
// NAME the wave, and a `toContain("6")` assertion is only a statement about
// the wave if no cr id can supply that digit.
const SIX_OPEN = "CR-WAVE-SIX-OPEN";
const SIX_SIBLING = "CR-WAVE-SIX-SIBLING";
const SIX_PENDING = "CR-WAVE-SIX-PENDING";
const SIX_TARGET = "CR-WAVE-SIX-TARGET";
const SIX_VOIDED = "CR-WAVE-SIX-VOIDED";
const SIX_SUPERSEDED = "CR-WAVE-SIX-SUPERSEDED";
const SEVEN_NEXT = "CR-WAVE-SEVEN-NEXT";
const FOUR_RESTARTED = "CR-WAVE-FOUR-RESTARTED";
const FIVE_LANDED = "CR-WAVE-FIVE-LANDED";
const FIVE_VOIDED = "CR-WAVE-FIVE-VOIDED";
const FIVE_OPEN = "CR-WAVE-FIVE-OPEN";
const FIVE_SIBLING = "CR-WAVE-FIVE-SIBLING";
const FIVE_LATE = "CR-WAVE-FIVE-LATE";
const LOOSE = "CR-WAVE-LOOSE";

describe("CR-CRU-116 §S1/§S2/§S3 — one active wave, ascending, refused actionably", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru116-wave-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  async function send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    // The server's own JSON envelope; `AnyBody` is this suite's boundary type.
    const parsed: AnyBody = await res.json();
    return { status: res.status, body: parsed };
  }

  /** A project with the orchestrator every declaring route requires. */
  async function seed(name: string): Promise<string> {
    const created = await send("POST", "/api/v2/projects", { name });
    expect(created.status).toBe(200);
    const key = created.body.project!.key;
    const registered = await send("POST", "/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key;
  }

  /** The bulk queue post is a FULL REPLACE, so every call names the WHOLE
   *  board this test intends. */
  async function queue(
    key: string,
    entries: Array<Record<string, unknown>>,
  ): Promise<QueueEntryWire[]> {
    const res = await send("POST", `/api/v2/projects/${key}/queue`, {
      agentId: ORCH,
      entries,
    });
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  async function queueEntries(key: string): Promise<QueueEntryWire[]> {
    const res = await send("GET", `/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  function entry(entries: QueueEntryWire[], cr: string): QueueEntryWire {
    const found = entries.find((candidate) => candidate.cr === cr);
    expect(found).toBeDefined();
    return found!;
  }

  /** THE WRITE UNDER TEST — `POST …/projects/<key>/plans`, the route
   *  `handlePlansRoute` dispatches to `handlePlanFile`. Never a store call:
   *  §S1 requires the refusal to be the SERVER's. */
  async function postPlan(
    key: string,
    cr: string,
    wave?: string,
  ): Promise<{ status: number; body: AnyBody }> {
    return send("POST", `/api/v2/projects/${key}/plans`, {
      agentId: ORCH,
      cr,
      ...(wave === undefined ? {} : { wave }),
      cycles: [{ label: `${cr} — cycle 1`, kind: "red-green" }],
    });
  }

  /** File a plan that MUST be accepted, and return it. Used only where the
   *  guard itself must permit the write — a fixture that the shipped guard
   *  would refuse is a fixture that lies. */
  async function openPlan(key: string, cr: string, wave?: string): Promise<AnyBody> {
    const filed = await postPlan(key, cr, wave);
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe("open");
    return filed.body;
  }

  async function abortPlan(key: string, planId: number): Promise<void> {
    const res = await send("POST", `/api/v2/projects/${key}/plans/${planId}/abort`, {
      agentId: ORCH,
      userApproved: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.plan!.status).toBe("aborted");
  }

  /** Drive a cr to `COMPLETED`: file a plan, take every cycle to a terminal
   *  state (`pending → skipped`, the cheapest legal edge), then close WITH a
   *  merge — `deriveQueueStatus` reads COMPLETED off exactly that pair. */
  async function land(key: string, cr: string, wave?: string): Promise<void> {
    const plan = await openPlan(key, cr, wave);
    const planId = plan.planId!;
    for (const cycle of plan.cycles!) {
      const moved = await send(
        "PATCH",
        `/api/v2/projects/${key}/plans/${planId}/cycles/${cycle.id}`,
        { agentId: ORCH, status: "skipped" },
      );
      expect(moved.status).toBe(200);
    }
    const closed = await send("PATCH", `/api/v2/projects/${key}/plans/${planId}`, {
      agentId: ORCH,
      status: "closed",
      merge: { commit: `merge-of-${cr}` },
    });
    expect(closed.status).toBe(200);
    expect(closed.body.plan!.status).toBe("closed");
  }

  async function plansOf(key: string, cr: string): Promise<PlanWire[]> {
    const res = await send("GET", `/api/v2/projects/${key}/plans?cr=${cr}`);
    expect(res.status).toBe(200);
    return res.body.plans!;
  }

  const VOID_AT = 1_757_000_000_000;

  // ── §S1 — a wave is active when it holds open work, and only one may ─────

  describe("§S1 — only one wave holds open work", () => {
    test(
      "with an open plan for a wave-6 cr, a plans POST for a wave-7 cr is REFUSED with " +
        "ok:false and code already-active, naming wave 6 and the cr whose plan is open",
      async () => {
        boot();
        const key = await seed("cru116-s1-already-active");
        await queue(key, [
          { cr: SIX_OPEN, title: "the open one", wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
        ]);
        const open = await openPlan(key, SIX_OPEN);
        // The ONE source of activeness, read back from the published queue:
        // the cr is IN_PROGRESS because a plan of status `open` exists.
        expect(entry(await queueEntries(key), SIX_OPEN).status).toBe("IN_PROGRESS");

        const refused = await postPlan(key, SEVEN_NEXT);
        expect(refused.status).toBe(400);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.code).toBe("already-active");
        // Names the ACTIVE wave (the only digit any cr id here can supply is
        // none — every id is digit-free) and the cr holding the open plan.
        expect(refused.body.error).toContain("6");
        expect(refused.body.error).toContain(SIX_OPEN);
        // NOTHING WRITTEN: the refused cr gained no plan, and the open one is
        // still the only work in flight.
        expect(await plansOf(key, SEVEN_NEXT)).toEqual([]);
        expect(entry(await queueEntries(key), SEVEN_NEXT).status).toBe("PENDING");
        expect(entry(await queueEntries(key), SIX_OPEN).planId).toBe(open.planId!);
      },
    );

    test(
      "with an open plan for a wave-6 cr, a plans POST for a SECOND wave-6 cr SUCCEEDS — the " +
        "constraint is one active WAVE, never one open plan",
      async () => {
        boot();
        const key = await seed("cru116-s1-second-in-wave");
        await queue(key, [
          { cr: SIX_OPEN, title: "the open one", wave: "6", dependsOn: [] },
          { cr: SIX_SIBLING, title: "its wave sibling", wave: "6", dependsOn: [] },
        ]);
        await openPlan(key, SIX_OPEN);

        const second = await postPlan(key, SIX_SIBLING);
        expect(second.status).toBe(201);
        expect(second.body.ok).toBe(true);
        expect(second.body.cr).toBe(SIX_SIBLING);
        expect(second.body.status).toBe("open");
        // Both crs are in flight, in the SAME wave — two open plans is not the
        // shape this CR refuses.
        const entries = await queueEntries(key);
        expect(entry(entries, SIX_OPEN).status).toBe("IN_PROGRESS");
        expect(entry(entries, SIX_SIBLING).status).toBe("IN_PROGRESS");
        expect(second.body.code).toBeUndefined();
      },
    );

    test(
      "with no open plan and no IN_PROGRESS cr anywhere, a plans POST for a cr in the EARLIEST " +
        "unfinished wave succeeds",
      async () => {
        boot();
        const key = await seed("cru116-s1-nothing-active");
        await queue(key, [
          { cr: SIX_PENDING, title: "earliest unfinished", wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
        ]);
        // The precondition, asserted rather than assumed: nothing is in flight.
        expect(
          (await queueEntries(key)).filter((e) => e.status === "IN_PROGRESS"),
        ).toEqual([]);

        const filed = await postPlan(key, SIX_PENDING);
        expect(filed.status).toBe(201);
        expect(filed.body.ok).toBe(true);
        expect(filed.body.status).toBe("open");
        expect(entry(await queueEntries(key), SIX_PENDING).status).toBe("IN_PROGRESS");
      },
    );

    test(
      "an ABORTED plan confers no activeness: wave 4 holds an aborted plan and nothing is open, " +
        "so a plans POST for a wave-6 cr succeeds",
      async () => {
        boot();
        const key = await seed("cru116-s1-aborted-is-not-open");
        await queue(key, [
          { cr: FOUR_RESTARTED, title: "abandoned once, then landed", wave: "4", dependsOn: [] },
          { cr: SIX_TARGET, title: "the write under test", wave: "6", dependsOn: [] },
        ]);
        // The live shape, reproduced: an aborted plan sitting on a COMPLETED
        // cr. A rule keyed on "a plan that is not closed" would read wave 4 as
        // active forever and refuse the write below.
        const abandoned = await openPlan(key, FOUR_RESTARTED);
        await abortPlan(key, abandoned.planId!);
        await land(key, FOUR_RESTARTED);

        const statuses = (await plansOf(key, FOUR_RESTARTED))
          .map((plan) => plan.status)
          .sort();
        expect(statuses).toEqual(["aborted", "closed"]);
        expect(entry(await queueEntries(key), FOUR_RESTARTED).status).toBe("COMPLETED");

        const filed = await postPlan(key, SIX_TARGET);
        expect(filed.status).toBe(201);
        expect(filed.body.ok).toBe(true);
        expect(filed.body.status).toBe("open");
      },
    );

    test(
      "the guard reads the QUEUE's wave, never plan.wave: a plan carrying wave 6 on a cr the " +
        "queue declares in wave 5 leaves wave 5 the active one",
      async () => {
        boot();
        const key = await seed("cru116-s1-queue-wave-wins");
        await queue(key, [
          { cr: FIVE_OPEN, title: "queue says five", wave: "5", dependsOn: [] },
          { cr: FIVE_SIBLING, title: "its wave sibling", wave: "5", dependsOn: [] },
          { cr: SIX_TARGET, title: "a genuinely later wave", wave: "6", dependsOn: [] },
        ]);
        // THE DISAGREEMENT, asserted as a fixture precondition: the plan says
        // 6, the queue says 5 (live: plan 95 vs CR-CRU-092).
        const open = await openPlan(key, FIVE_OPEN, "6");
        expect(open.wave).toBe("6");
        expect(entry(await queueEntries(key), FIVE_OPEN).wave).toBe("5");

        // Reading plan.wave would make 6 the active wave and let this through.
        const refused = await postPlan(key, SIX_TARGET);
        expect(refused.status).toBe(400);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.code).toBe("already-active");
        expect(refused.body.error).toContain("5");
        expect(refused.body.error).toContain(FIVE_OPEN);

        // …and the mirror: reading plan.wave would make a wave-5 write the
        // cross-wave one and refuse it. The queue's wave says it is the SAME
        // wave as the open work, so it lands.
        const sibling = await postPlan(key, FIVE_SIBLING);
        expect(sibling.status).toBe(201);
        expect(sibling.body.ok).toBe(true);
      },
    );

    test(
      "CENSUS — every wave-scope refusal answers one of the two codes CycleTransitionError " +
        "already declares, and the whole scope introduces no third code string",
      async () => {
        const observed: string[] = [];

        // (a) a later wave while wave 6 holds open work.
        boot();
        const active = await seed("cru116-census-already-active");
        await queue(active, [
          { cr: SIX_OPEN, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        await openPlan(active, SIX_OPEN);
        const refusedActive = await postPlan(active, SEVEN_NEXT);

        // (b) a later wave while an earlier one is merely unfinished.
        const ordered = await seed("cru116-census-out-of-order");
        await queue(ordered, [
          { cr: SIX_PENDING, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        const refusedOrder = await postPlan(ordered, SEVEN_NEXT);

        // (c) BOTH conditions at once — a cr inserted into an EARLIER wave
        // after wave 6's work opened. §S1's precedence is asserted on this
        // very fixture below: `already-active` wins, the order
        // `transitionCycle` uses (src/store.ts:3269-3295; re-pinned
        // 2026-09-09 from :3238-3264, the header records why).
        const both = await seed("cru116-census-both");
        await queue(both, [
          { cr: SIX_OPEN, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        await openPlan(both, SIX_OPEN);
        await queue(both, [
          { cr: FIVE_LATE, wave: "5", dependsOn: [] },
          { cr: SIX_OPEN, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        expect(entry(await queueEntries(both), FIVE_LATE).status).toBe("PENDING");
        const refusedBoth = await postPlan(both, SEVEN_NEXT);

        // §S1 PRECEDENCE — both rules are tripped by this one write, and the
        // wave scope answers the SAME one `transitionCycle` answers first.
        // Without this line the two codes are interchangeable here and the
        // spec's ordering rule has no instrument at all.
        expect(refusedBoth.body.code).toBe("already-active");

        for (const refused of [refusedActive, refusedOrder, refusedBoth]) {
          expect(refused.status).toBe(400);
          expect(refused.body.ok).toBe(false);
          expect(typeof refused.body.code).toBe("string");
          observed.push(refused.body.code!);
        }
        // Exactly the shipped pair — no more (a wave-specific code string
        // invented for this scope) and no fewer (a scope collapsed onto one).
        expect([...new Set(observed)].sort()).toEqual([...WAVE_REFUSAL_CODES].sort());
      },
    );
  });

  // ── §S2 — waves open in order ────────────────────────────────────────────

  describe("§S2 — a wave does not open ahead of an unfinished predecessor", () => {
    test(
      "wave 6 holding one PENDING cr and wave 7 holding one: a plans POST for the wave-7 cr is " +
        "REFUSED with code out-of-order, naming wave 6 and its blocking cr",
      async () => {
        boot();
        const key = await seed("cru116-s2-out-of-order");
        await queue(key, [
          { cr: SIX_PENDING, title: "the blocker", wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
        ]);
        // Nothing is in flight — this refusal is about ORDER, not activeness.
        expect(
          (await queueEntries(key)).filter((e) => e.status === "IN_PROGRESS"),
        ).toEqual([]);

        const refused = await postPlan(key, SEVEN_NEXT);
        expect(refused.status).toBe(400);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.code).toBe("out-of-order");
        expect(refused.body.error).toContain("6");
        expect(refused.body.error).toContain(SIX_PENDING);
        expect(await plansOf(key, SEVEN_NEXT)).toEqual([]);
      },
    );

    test(
      "a wave whose only unfinished entries are VOID and SUPERSEDED does not block its successor: " +
        "a plans POST for the wave-7 cr SUCCEEDS",
      async () => {
        boot();
        const key = await seed("cru116-s2-dead-do-not-block");
        const entries = await queue(key, [
          {
            cr: SIX_VOIDED,
            wave: "6",
            dependsOn: [],
            lifecycle: { state: "VOID", reason: "the surface it targeted was retired", at: VOID_AT },
          },
          {
            cr: SIX_SUPERSEDED,
            wave: "6",
            dependsOn: [],
            lifecycle: { state: "SUPERSEDED", by: SEVEN_NEXT, at: VOID_AT },
          },
          { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
        ]);
        // The fixture's whole point: both wave-6 entries are UNLANDED
        // (`PENDING`) yet DECLARED DEAD on the second axis.
        expect(entry(entries, SIX_VOIDED).status).toBe("PENDING");
        expect(entry(entries, SIX_VOIDED).lifecycle!.state).toBe("VOID");
        expect(entry(entries, SIX_SUPERSEDED).status).toBe("PENDING");
        expect(entry(entries, SIX_SUPERSEDED).lifecycle!.state).toBe("SUPERSEDED");

        const filed = await postPlan(key, SEVEN_NEXT);
        expect(filed.status).toBe(201);
        expect(filed.body.ok).toBe(true);
        expect(filed.body.status).toBe("open");
      },
    );

    test(
      "wave 5 fully landed and wave 6 PENDING: a plans POST for the wave-6 cr succeeds",
      async () => {
        boot();
        const key = await seed("cru116-s2-predecessor-landed");
        await queue(key, [
          { cr: FIVE_LANDED, title: "merged", wave: "5", dependsOn: [] },
          {
            cr: FIVE_VOIDED,
            title: "declared dead",
            wave: "5",
            dependsOn: [],
            lifecycle: { state: "VOID", reason: "withdrawn", at: VOID_AT },
          },
          { cr: SIX_TARGET, title: "the write under test", wave: "6", dependsOn: [] },
        ]);
        // The live shape of wave 5: everything landed except the VOIDs.
        await land(key, FIVE_LANDED);
        const entries = await queueEntries(key);
        expect(entry(entries, FIVE_LANDED).status).toBe("COMPLETED");
        expect(entry(entries, FIVE_VOIDED).lifecycle!.state).toBe("VOID");
        expect(entries.filter((e) => e.status === "IN_PROGRESS")).toEqual([]);

        const filed = await postPlan(key, SIX_TARGET);
        expect(filed.status).toBe(201);
        expect(filed.body.ok).toBe(true);
        expect(filed.body.status).toBe("open");
      },
    );

    test(
      "an entry whose wave is UNSET never blocks a wave and is never reported as the blocker",
      async () => {
        boot();
        const key = await seed("cru116-s2-waveless-never-blocks");
        const entries = await queue(key, [
          // `wave: ""` is the wire's own way of declaring NO wave
          // (src/types.ts:392). It is PENDING and unlanded, and it sorts ahead
          // of every numbered wave — so a guard that treats it as a container
          // would report it as wave 0's blocker.
          { cr: LOOSE, title: "belongs to no wave", wave: "", dependsOn: [] },
          { cr: SIX_PENDING, title: "the real blocker", wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
        ]);
        expect(entry(entries, LOOSE).wave).toBe("");
        expect(entry(entries, LOOSE).status).toBe("PENDING");

        // NEVER REPORTED: the wave-7 refusal names wave 6 and its cr, and the
        // wave-less entry appears nowhere in it.
        const refused = await postPlan(key, SEVEN_NEXT);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe("out-of-order");
        expect(refused.body.error).toContain(SIX_PENDING);
        expect(refused.body.error).not.toContain(LOOSE);
        expect((refused.body.help ?? []).join(" ")).not.toContain(LOOSE);

        // NEVER BLOCKS: wave 6 is still the earliest unfinished wave, so its
        // own write lands even though an unlanded wave-less entry exists.
        const filed = await postPlan(key, SIX_PENDING);
        expect(filed.status).toBe(201);
        expect(filed.body.ok).toBe(true);
      },
    );
  });

  // ── §S3 — the refusal names the move that clears it ──────────────────────

  describe("§S3 — both refusals are actionable 400s", () => {
    test(
      "already-active carries a non-empty help[] naming the plan-closing move and the cr holding " +
        "the open plan; out-of-order's names the blocking cr by id",
      async () => {
        boot();
        const active = await seed("cru116-s3-help-already-active");
        await queue(active, [
          { cr: SIX_OPEN, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        await openPlan(active, SIX_OPEN);
        const refusedActive = await postPlan(active, SEVEN_NEXT);
        expect(refusedActive.body.code).toBe("already-active");
        const activeHelp = refusedActive.body.help;
        expect(Array.isArray(activeHelp)).toBe(true);
        expect(activeHelp!.length).toBeGreaterThan(0);
        for (const line of activeHelp!) expect(typeof line).toBe("string");
        const activeText = activeHelp!.join("\n");
        // §S3 — "closing or aborting the open plan in the active wave".
        expect(activeText).toContain(SIX_OPEN);
        expect(activeText).toMatch(/clos/i);
        expect(activeText).toMatch(/abort/i);

        const ordered = await seed("cru116-s3-help-out-of-order");
        await queue(ordered, [
          { cr: SIX_PENDING, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        const refusedOrder = await postPlan(ordered, SEVEN_NEXT);
        expect(refusedOrder.body.code).toBe("out-of-order");
        const orderHelp = refusedOrder.body.help;
        expect(Array.isArray(orderHelp)).toBe(true);
        expect(orderHelp!.length).toBeGreaterThan(0);
        for (const line of orderHelp!) expect(typeof line).toBe("string");
        // §S3 — the blocking cr, by id, and that it must land or be declared
        // dead.
        expect(orderHelp!.join("\n")).toContain(SIX_PENDING);
      },
    );

    test(
      "neither refusal is a 500: both answer 400 with an ok:false envelope carrying a non-empty " +
        "error sentence, matching the plans route's existing refusal shape",
      async () => {
        boot();
        const active = await seed("cru116-s3-not-a-500-active");
        await queue(active, [
          { cr: SIX_OPEN, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        await openPlan(active, SIX_OPEN);
        const refusedActive = await postPlan(active, SEVEN_NEXT);

        const ordered = await seed("cru116-s3-not-a-500-order");
        await queue(ordered, [
          { cr: SIX_PENDING, wave: "6", dependsOn: [] },
          { cr: SEVEN_NEXT, wave: "7", dependsOn: [] },
        ]);
        const refusedOrder = await postPlan(ordered, SEVEN_NEXT);

        for (const refused of [refusedActive, refusedOrder]) {
          expect(refused.status).toBe(400);
          expect(refused.body.ok).toBe(false);
          expect(typeof refused.body.error).toBe("string");
          expect(refused.body.error!.length).toBeGreaterThan(0);
        }
      },
    );
  });
});
