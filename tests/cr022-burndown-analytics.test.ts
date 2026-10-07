// CR-CRU-022 §S3 — burndown (release-level): GET …/analytics/burndown.
//
// Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S3 + its three ACs.
// Design: docs/research/DN-crucible-analytics.md §6 (burndown), whose
// "steps up when points are added... steps down when points leave by
// declaration" IS the declaration journal's only OBSERVABLE surface — the
// spec publishes no journal-read API (the "API surface" table lists three
// GET routes, no fourth for the journal), so this file is also §S1/AC3's
// only test: a step naming a CR and a verb IS a journal row, read back.
//
// Baseline (measured 2026-09-24, re-confirmed): no `/analytics/*` route
// exists in src/v2.ts's dispatch, `upsertQueueEntry` ignores `points`
// entirely (see tests/cr022-story-points.test.ts), and nothing in
// src/store.ts appends any kind of scope-change log. Every assertion below
// is expected to FAIL.
//
// FIXTURE DESIGN:
//   * Release "9.9.0" starts when CR-BURN-A is filed (points 5) — the
//     EARLIEST filed_at among its CRs — so committedPoints === 5 (§S3's own
//     words: "its point total THEN", i.e. at that instant, before anything
//     else is declared). CR-BURN-B is filed a day later with 3 points: a
//     release-established CR's OWN points are the baseline and must not
//     ALSO appear as a scope-addition delta (that would double-count it:
//     committedPoints already carries CR-BURN-A's 5), which is why the test
//     below asserts CR-BURN-A carries no positive-delta step of its own.
//   * CR-BURN-A's plan later closes with a merge (event: "merged", the
//     AC's own literal string) — a −5 step.
//   * CR-BURN-C (points 2) is filed after the release start — a +2 scope
//     step (verb "cr-plan"), exactly like CR-BURN-B's +3 — then VOIDed — a
//     −2 step whose `verb`
//     is "cr-void" (§S1/AC3's own journal-verb vocabulary: cr-plan,
//     cr-void, cr-supersede — the literal CLI verb names, which is the one
//     concrete string the spec pins for a non-merge step; "event" strings
//     for scope/void are NOT pinned by the CR text the way "merged" is, so
//     this file asserts `verb` for them instead of guessing an `event`
//     spelling).
//   * CR-BURN-D carries no points at all: it must show up in `unpointed`
//     and contribute NO step and NO amount to any total.
//   * The correctness check walks `points[]` in `ts` order and re-derives
//     `remaining` from `committedPoints + Σdelta`, which is ROBUST to
//     whatever order the implementation emits the array in and proves the
//     whole arithmetic chain in one assertion, independent of guessing the
//     exact set/order of steps the real implementation emits.
//
// A second, target-less release ("9.8.0") proves the "no declared target →
// no ideal line" half of the second AC: it carries a CR but no
// release-proposal was ever recorded for it (a plannable-but-unproposed
// release, reachable because these fixtures write the queue directly and
// skip `declareMembership`'s live-proposal gate — that gate is
// cr-plan-the-HTTP-route's, not the store's, and is out of scope here).
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueuePlanInput } from "../src/store.ts";

function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  return result as Exclude<T, { error: string }>;
}

interface BurndownPoint {
  ts: number;
  remaining: number;
  event?: string;
  cr: string;
  verb?: string;
  delta: number;
}

interface BurndownBody {
  ok?: boolean;
  release?: string;
  committedPoints?: number;
  target?: number;
  ideal?: Array<{ ts: number; remaining: number }>;
  points?: BurndownPoint[];
  unpointed?: string[];
  [key: string]: unknown;
}

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "cru022-burn-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getBurndown(
  key: string,
  release: string,
): Promise<{ status: number; body: BurndownBody }> {
  const res = await fetch(
    `${base()}/api/v2/projects/${key}/analytics/burndown?release=${encodeURIComponent(release)}`,
  );
  let body: BurndownBody = {};
  try {
    body = (await res.json()) as BurndownBody;
  } catch {
    // Not-yet-existing route: no JSON body. Fail on the FIELDS below.
  }
  return { status: res.status, body };
}

function fileWithPoints(
  key: string,
  cr: string,
  release: string,
  points: number | undefined,
  filedAt: string,
): void {
  setSystemTime(new Date(filedAt));
  const input: QueuePlanInput & { points?: number } = {
    cr,
    release,
    wave: "1",
    title: cr,
    ...(points === undefined ? {} : { points }),
  };
  handle!.store.upsertQueueEntry(key, input);
}

describe("CR-CRU-022 §S3 — burndown: GET …/analytics/burndown", () => {
  test("committedPoints is the release's point total AT ITS START; the series steps down on merge (event: \"merged\"), up on a scope addition (verb cr-plan), and down on a void (verb cr-void); unpointed CRs are excluded and named", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000b01";
    handle!.store.addProject({ key, name: "burn", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const RELEASE = "9.9.0";
    // CR-CRU-091's declared target, read the same way the release strip
    // reads it (`recordReleaseProposal`'s `targetAt`, epoch SECONDS).
    const TARGET_AT_SECONDS = 1_791_158_400; // 2026-10-04T00:00:00Z

    setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: RELEASE,
      targetAt: TARGET_AT_SECONDS,
    });

    // RELEASE START — CR-BURN-A, 5 points, the earliest filed_at.
    const RELEASE_START = "2026-09-07T09:00:00.000Z";
    fileWithPoints(key, "CR-BURN-A", RELEASE, 5, RELEASE_START);

    // Scope addition the next day: CR-BURN-B, 3 points, filed AFTER start.
    fileWithPoints(key, "CR-BURN-B", RELEASE, 3, "2026-09-08T09:00:00.000Z");

    // CR-BURN-C, 2 points, filed then later VOIDed.
    fileWithPoints(key, "CR-BURN-C", RELEASE, 2, "2026-09-08T10:00:00.000Z");

    // An unpointed CR in the same release — must never enter a total.
    fileWithPoints(key, "CR-BURN-D", RELEASE, undefined, "2026-09-08T11:00:00.000Z");

    // CR-BURN-A's plan closes with a merge.
    const planA = planned(
      handle!.store.filePlan(key, { cr: "CR-BURN-A", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(handle!.store.transitionCycle(key, planA.planId, planA.cycles[0]!.id, "active"));
    planned(handle!.store.transitionCycle(key, planA.planId, planA.cycles[0]!.id, "done"));
    setSystemTime(new Date("2026-09-10T09:00:00.000Z"));
    planned(handle!.store.closePlan(key, planA.planId, { commit: "aaa0001" }));

    // CR-BURN-C is voided.
    setSystemTime(new Date("2026-09-11T09:00:00.000Z"));
    const voided = handle!.store.setQueueLifecycle(key, "CR-BURN-C", {
      state: "VOID",
      reason: "folded into CR-BURN-A",
    });
    expect(voided).not.toBeNull();

    setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const { status, body } = await getBurndown(key, RELEASE);
    expect(status).toBe(200);
    expect(body.ok).not.toBe(false);
    expect(body.release).toBe(RELEASE);

    // §S3/AC1 — committedPoints is CR-BURN-A's 5 alone: CR-BURN-B/C/D were
    // all filed AFTER the release's start instant.
    expect(body.committedPoints).toBe(5);

    // §S3/AC2 — a declared target produces the ideal line.
    expect(body.target).toBe(TARGET_AT_SECONDS);
    expect(Array.isArray(body.ideal)).toBe(true);
    expect(body.ideal!.length).toBeGreaterThanOrEqual(2);
    expect(body.ideal![0]!.remaining).toBe(5);
    expect(body.ideal![body.ideal!.length - 1]!.remaining).toBe(0);

    // §S3/AC3 — a VOID CR contributes nothing, an unpointed CR is excluded
    // and named — never counted as 1.
    expect(body.unpointed).toEqual(["CR-BURN-D"]);
    expect((body.points ?? []).some((p) => p.cr === "CR-BURN-D")).toBe(false);

    const points = body.points ?? [];
    // The scope addition: CR-BURN-B raises remaining by its own 3 points.
    const scopeStep = points.find((p) => p.cr === "CR-BURN-B");
    expect(scopeStep).toBeDefined();
    expect(scopeStep!.delta).toBe(3);
    expect(scopeStep!.verb).toBe("cr-plan");

    // The merge: CR-BURN-A drops remaining by its own 5 points, labelled
    // event: "merged" — the ONE literal string the AC itself pins.
    const mergeStep = points.find((p) => p.cr === "CR-BURN-A" && p.delta < 0);
    expect(mergeStep).toBeDefined();
    expect(mergeStep!.event).toBe("merged");
    expect(mergeStep!.delta).toBe(-5);

    // CR-BURN-A's OWN filing (which established the release) must not ALSO
    // appear as a positive-delta scope step — that value is already inside
    // committedPoints, and double-counting it would break every total.
    expect(points.some((p) => p.cr === "CR-BURN-A" && p.delta > 0)).toBe(false);

    // The void: CR-BURN-C drops remaining by its own 2 points.
    const voidStep = points.find((p) => p.cr === "CR-BURN-C" && p.verb === "cr-void");
    expect(voidStep).toBeDefined();
    expect(voidStep!.delta).toBe(-2);
    expect(voidStep!.verb).toBe("cr-void");

    // CR-BURN-C's post-start filing stays visible as its own +2 scope step:
    // a voided CR's addition is history, never rewritten away (DN §2.4).
    const voidedAddition = points.find((p) => p.cr === "CR-BURN-C" && p.verb === "cr-plan");
    expect(voidedAddition).toBeDefined();
    expect(voidedAddition!.delta).toBe(2);

    // Order-independent arithmetic proof: walk `points[]` in ts order and
    // re-derive `remaining` from committedPoints + the running delta sum.
    // committed 5 (+3 B scope, +2 C scope, −5 A merge, −2 C void):
    // 5 +3 +2 −5 −2 = 3 remaining at the end (CR-BURN-B's open 3 points).
    const chronological = [...points].sort((a, b) => a.ts - b.ts);
    let running = body.committedPoints!;
    for (const p of chronological) {
      running += p.delta;
      expect(p.remaining).toBe(running);
    }
    expect(running).toBe(3);
  });

  test("a release with no declared target carries no ideal line and no target field (absent, not null/0)", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000b02";
    handle!.store.addProject({ key, name: "burn-notarget", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const RELEASE = "9.8.0";
    // No `recordReleaseProposal` call at all for this release — a queue
    // membership exists with no live target ever declared.
    fileWithPoints(key, "CR-BURN-NT-1", RELEASE, 5, "2026-09-07T09:00:00.000Z");

    setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const { status, body } = await getBurndown(key, RELEASE);
    expect(status).toBe(200);
    expect(body.committedPoints).toBe(5);
    expect(body.target).toBeUndefined();
    expect(body.ideal).toBeUndefined();
  });
});

describe("burndown answers per project and per release", () => {
  test("each burndown answer names its own release, and two projects sharing a release label never share an answer", async () => {
    boot();
    const P1 = "00000000-0000-4000-8000-0000a0000001";
    const P2 = "00000000-0000-4000-8000-0000a0000002";
    const release1 = "9.9.0";
    const release2 = "9.8.0";

    // P1: a 3-point member of release1 with a filed plan, plus a 5-point
    // member of a SECOND release in the same project.
    handle!.store.addProject({ key: P1, name: "burn-sep-1", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    handle!.store.upsertQueueEntry(P1, { cr: "CR-BURN-SEP-A", release: release1, wave: "1", title: "CR-BURN-SEP-A", points: 3 });
    planned(handle!.store.filePlan(P1, { cr: "CR-BURN-SEP-A", cycles: [{ label: "c1", kind: "red-green" }] }));
    handle!.store.upsertQueueEntry(P1, { cr: "CR-BURN-SEP-C", release: release2, wave: "1", title: "CR-BURN-SEP-C", points: 5 });

    // P2: an 8-point member of the SAME release label, in another project.
    handle!.store.addProject({ key: P2, name: "burn-sep-2", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    handle!.store.upsertQueueEntry(P2, { cr: "CR-BURN-SEP-B", release: release1, wave: "1", title: "CR-BURN-SEP-B", points: 8 });
    planned(handle!.store.filePlan(P2, { cr: "CR-BURN-SEP-B", cycles: [{ label: "c1", kind: "red-green" }] }));

    const p1r1 = await getBurndown(P1, release1);
    const p1r2 = await getBurndown(P1, release2);
    const p2r1 = await getBurndown(P2, release1);

    // POSITIVE — each answer names its OWN release, never a neighbour's.
    expect(p1r1.body.release).toBe(release1);
    expect(p1r2.body.release).toBe(release2);
    expect(p2r1.body.release).toBe(release1);
    // NEGATIVE — the two release1 answers (different projects, SAME release
    // label) differ: the 3-point burndown is not the 8-point one.
    expect(JSON.stringify(p1r1.body)).not.toBe(JSON.stringify(p2r1.body));
  });
});
