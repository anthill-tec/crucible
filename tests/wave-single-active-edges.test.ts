// CR-CRU-116 §S1/§S2 — the EDGES of the single-active-wave guard: what it is
// required NOT to refuse, and what it is required not to invent. C2.
//
// Spec: docs/changes/CR-CRU-116-only-one-wave-is-active.md §S1 ("a cr the
//       queue does not hold", "a cr with no declared wave", "activeness is
//       computed from the same derivation the queue publishes") and §S2
//       ("a digit-free label numbers 0, exactly as its seq block already
//       does").
//
// WHY THIS FILE EXISTS BESIDE tests/wave-single-active.test.ts. That file is
// C1's committed contract — the two REFUSALS and their help. Four ACs were
// ruled after its RED phase was written and shipped in C1's GREEN with no
// test naming them, so they are asserted here rather than by reopening a
// landed file. Every test below therefore PASSES on arrival: it is coverage
// for behaviour already in `Store.waveScopeRefusal` (src/store.ts), and a
// FAILURE here is a defect in that guard, never a fixture to adjust.
//
// THE SUBJECT IS THE SERVER. Every assertion drives
// `POST /api/v2/projects/<key>/plans` — the write that opens work — because
// §S1 requires the refusal (and the non-refusal) to be the route's, not a
// store unit's. Every server here boots on an OS-assigned port against an
// mkdtempSync scratch db; the live data/crucible.db and port 3849 are never
// touched.
//
// NON-VACUITY IS THE POINT OF EVERY FIXTURE HERE. "The write succeeded" is
// worth nothing unless the guard was ARMED — a guard that never refuses
// anything also never refuses these. So each permissive case also drives a
// write the guard MUST refuse on the same board, in the same test.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
// §S2 — the ONE ordering function the store publishes. Imported rather than
// restated: the digit-free case below asserts the ORDER it answers, so a
// second ordering rule written anywhere would have to disagree with this
// import to pass.
import { waveNumber } from "../src/store.ts";

// ── wire shapes this suite PINS (tests/wave-single-active.test.ts's, so the
//    two files cannot describe the envelope two ways) ──────────────────────

interface QueueEntryWire {
  cr: string;
  wave: string;
  status: string;
  planId?: number;
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
  code?: string;
  help?: string[];
  project?: { key: string };
  entries?: QueueEntryWire[];
  plans?: PlanWire[];
  planId?: number;
  cr?: string;
  status?: string;
  wave?: string;
  cycles?: { id: number; label: string; status: string }[];
  plan?: PlanWire;
}

const ORCH = "cru116-edges-orchestrator";

// Digit-free cr ids, for the same reason C1's are: a `toContain("6")`
// assertion is only a statement about the WAVE if no cr id can supply that
// digit.
const SIX_OPEN = "CR-EDGE-SIX-OPEN";
const SIX_TARGET = "CR-EDGE-SIX-TARGET";
const SEVEN_NEXT = "CR-EDGE-SEVEN-NEXT";
const UNQUEUED = "CR-EDGE-NEVER-QUEUED";
const LOOSE = "CR-EDGE-NO-WAVE";
const ALPHA = "CR-EDGE-ALPHA-LABEL";
const ABORTED_ONLY = "CR-EDGE-ABORTED-ONLY";
const LANDED = "CR-EDGE-LANDED";

/** The digit-free wave label §S2 numbers 0. */
const ALPHA_WAVE = "alpha";

describe("CR-CRU-116 §S1/§S2 — the guard's edges: outside the constraint, and one ordering rule", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru116-edges-"));
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
    const res = await send("POST", `/api/v2/projects/${key}/queue`, { agentId: ORCH, entries });
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

  /** THE WRITE UNDER TEST — `POST …/projects/<key>/plans`. Never a store
   *  call: §S1 requires the answer to be the SERVER's. */
  async function postPlan(
    key: string,
    cr: string,
  ): Promise<{ status: number; body: AnyBody }> {
    return send("POST", `/api/v2/projects/${key}/plans`, {
      agentId: ORCH,
      cr,
      cycles: [{ label: `${cr} — cycle 1`, kind: "red-green" }],
    });
  }

  /** File a plan that MUST be accepted, and return it. */
  async function openPlan(key: string, cr: string): Promise<AnyBody> {
    const filed = await postPlan(key, cr);
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
   *  state, then close WITH a merge — `deriveQueueStatus` reads COMPLETED off
   *  exactly that pair. */
  async function land(key: string, cr: string): Promise<void> {
    const plan = await openPlan(key, cr);
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

  // ── §S1 — a cr the queue does not hold is outside the constraint ────────

  test(
    "a plans POST for a cr the QUEUE DOES NOT HOLD succeeds with the constraint armed — wave 6 " +
      "is active, the unqueued cr is written anyway, and it makes no wave active",
    async () => {
      boot();
      const key = await seed("cru116-edges-unqueued");
      await queue(key, [
        { cr: SIX_OPEN, title: "the open one", wave: "6", dependsOn: [] },
        { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
      ]);
      await openPlan(key, SIX_OPEN);
      // ARMED, on this board, in this test: wave 6 holds open work, so a
      // wave-7 write IS refused. The success below is therefore permission,
      // not the absence of a guard.
      const refused = await postPlan(key, SEVEN_NEXT);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("already-active");

      // The cr the queue does not hold: membership is DECLARED, and a guard
      // that refused an undeclared cr would be inventing it.
      expect((await queueEntries(key)).map((e) => e.cr)).not.toContain(UNQUEUED);
      const filed = await postPlan(key, UNQUEUED);
      expect(filed.status).toBe(201);
      expect(filed.body.ok).toBe(true);
      expect(filed.body.cr).toBe(UNQUEUED);
      expect(filed.body.status).toBe("open");
      expect(filed.body.code).toBeUndefined();

      // …and it changed no wave's activeness: the queue still names exactly
      // one cr in flight, the wave-6 one, and the unqueued cr is still not a
      // queue member at all.
      const entries = await queueEntries(key);
      expect(entries.filter((e) => e.status === "IN_PROGRESS").map((e) => e.cr)).toEqual([
        SIX_OPEN,
      ]);
      expect(entries.map((e) => e.cr)).not.toContain(UNQUEUED);
    },
  );

  // ── §S1 — an EMPTY wave is the wire's way of declaring none ─────────────

  test(
    "a cr whose wave is EMPTY is outside the constraint both ways: its plans POST succeeds while " +
      "a numbered wave is active, and its own open plan then makes NO wave active",
    async () => {
      boot();
      const key = await seed("cru116-edges-empty-wave");
      const declared = await queue(key, [
        { cr: LOOSE, title: "declares no wave", wave: "", dependsOn: [] },
        { cr: SIX_OPEN, title: "the open one", wave: "6", dependsOn: [] },
        { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
      ]);
      // The wire really carries an EMPTY wave — not absent, not "0".
      expect(entry(declared, LOOSE).wave).toBe("");

      // HALF ONE — NEVER BLOCKED. Wave 6 is active (a wave-7 write is refused
      // on this very board), and the unwaved cr is written regardless.
      const sixPlan = await openPlan(key, SIX_OPEN);
      const refused = await postPlan(key, SEVEN_NEXT);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("already-active");

      const loose = await postPlan(key, LOOSE);
      expect(loose.status).toBe(201);
      expect(loose.body.ok).toBe(true);
      expect(loose.body.status).toBe("open");
      expect(loose.body.code).toBeUndefined();

      // HALF TWO — NEVER BLOCKING. Close the numbered wave's work, leaving
      // the unwaved cr as the ONLY thing in flight anywhere…
      await abortPlan(key, sixPlan.planId!);
      const midway = await queueEntries(key);
      expect(midway.filter((e) => e.status === "IN_PROGRESS").map((e) => e.cr)).toEqual([LOOSE]);

      // …and a numbered wave's write still succeeds: an open plan on a cr
      // that declares no wave confers activeness on nothing, so there is no
      // active wave for `already-active` to name and no unfinished EARLIER
      // wave for `out-of-order` to name either.
      const behind = await postPlan(key, SIX_OPEN);
      expect(behind.status).toBe(201);
      expect(behind.body.ok).toBe(true);
      expect(behind.body.status).toBe("open");
      expect(behind.body.code).toBeUndefined();
    },
  );

  // ── §S2 — a digit-free label numbers 0, by the ONE ordering function ────

  test(
    "a digit-free wave label orders as wave 0 via waveNumber: it BLOCKS a wave-6 write with " +
      "out-of-order naming itself, while its own write succeeds",
    async () => {
      boot();
      const key = await seed("cru116-edges-digit-free");
      // The ordering fact this test drives, read off the ONE published
      // function rather than restated: `alpha` is lane 0, so it precedes 6.
      expect(waveNumber(ALPHA_WAVE)).toBe(0);
      expect(waveNumber("6")).toBe(6);

      await queue(key, [
        { cr: ALPHA, title: "a digit-free lane", wave: ALPHA_WAVE, dependsOn: [] },
        { cr: SIX_TARGET, title: "the write under test", wave: "6", dependsOn: [] },
      ]);
      // Nothing is in flight, so nothing can be `already-active`: whatever
      // answers below answers on ORDER alone.
      expect((await queueEntries(key)).filter((e) => e.status === "IN_PROGRESS")).toEqual([]);

      const refused = await postPlan(key, SIX_TARGET);
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.code).toBe("out-of-order");
      // Names the blocking lane and the cr that blocks — the digit-free label
      // verbatim, never a `0` the guard made up.
      expect(refused.body.error).toContain(ALPHA_WAVE);
      expect(refused.body.error).toContain(ALPHA);
      expect(refused.body.help!.length).toBeGreaterThan(0);
      expect(await plansOf(key, SIX_TARGET)).toEqual([]);

      // Lane 0 is a LANE, not a limbo: its own write is the earliest
      // unfinished wave's and succeeds.
      const filed = await postPlan(key, ALPHA);
      expect(filed.status).toBe(201);
      expect(filed.body.ok).toBe(true);
      expect(filed.body.status).toBe("open");
      expect(filed.body.code).toBeUndefined();
      expect(entry(await queueEntries(key), ALPHA).status).toBe("IN_PROGRESS");
    },
  );

  // ── §S1 — activeness IS `deriveQueueStatus`'s IN_PROGRESS, and nothing
  //    else the guard invented ─────────────────────────────────────────────

  test(
    "the census: neither an ABORTED plan nor a CLOSED-with-merge one confers activeness — " +
      "activeness tracks the queue's IN_PROGRESS alone",
    async () => {
      boot();
      const key = await seed("cru116-edges-census");
      await queue(key, [
        {
          cr: ABORTED_ONLY,
          title: "abandoned, never restarted",
          wave: "4",
          dependsOn: [],
          // DECLARED DEAD on purpose, and only for that: an aborted plan
          // leaves its cr PENDING, which would block wave 6 as `out-of-order`
          // and mask the question this test asks. Lifecycle silences the
          // ORDER rule only — the IN_PROGRESS branch of the guard is read
          // before any lifecycle is, so if `aborted` conferred activeness,
          // wave 4 would be active here and the wave-6 write below would be
          // refused `already-active` regardless of this VOID.
          lifecycle: { state: "VOID", reason: "the surface it targeted was retired", at: VOID_AT },
        },
        { cr: LANDED, title: "landed with a merge", wave: "5", dependsOn: [] },
        { cr: SIX_TARGET, title: "the write under test", wave: "6", dependsOn: [] },
        { cr: SEVEN_NEXT, title: "the successor", wave: "7", dependsOn: [] },
      ]);

      // Drive the two non-open plan states the store actually has.
      const abandoned = await openPlan(key, ABORTED_ONLY);
      await abortPlan(key, abandoned.planId!);
      await land(key, LANDED);

      // The census's own precondition: `plan.status` has three values, and
      // this board holds exactly the two that are not `open`.
      expect((await plansOf(key, ABORTED_ONLY)).map((p) => p.status)).toEqual(["aborted"]);
      expect((await plansOf(key, LANDED)).map((p) => p.status)).toEqual(["closed"]);
      const before = await queueEntries(key);
      expect(entry(before, ABORTED_ONLY).status).toBe("PENDING");
      expect(entry(before, LANDED).status).toBe("COMPLETED");
      expect(before.filter((e) => e.status === "IN_PROGRESS")).toEqual([]);

      // THE CENSUS — with an aborted plan in wave 4 and a closed one in wave
      // 5, a wave-6 write SUCCEEDS. A guard carrying any second in-flight
      // rule ("a plan exists", "a plan that is not closed", "a cr that ever
      // had a plan") would make wave 4 or wave 5 active and refuse this.
      const filed = await postPlan(key, SIX_TARGET);
      expect(filed.status).toBe(201);
      expect(filed.body.ok).toBe(true);
      expect(filed.body.status).toBe("open");
      expect(filed.body.code).toBeUndefined();

      // …and the ONE rule that IS the derivation still bites, on the same
      // board, one line later: the wave-6 plan is `open`, wave 6 is now
      // IN_PROGRESS, and the wave-7 write is refused naming wave 6 — so the
      // success above measured the absence of a SECOND rule, not the absence
      // of the guard.
      expect(entry(await queueEntries(key), SIX_TARGET).status).toBe("IN_PROGRESS");
      const refused = await postPlan(key, SEVEN_NEXT);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("already-active");
      expect(refused.body.error).toContain(SIX_TARGET);
    },
  );
});
