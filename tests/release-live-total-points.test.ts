// CR-CRU-174 §S1 — the burndown answer gains the release's LIVE total: the
// points of its live CRs (merged + pending; voided and superseded excluded;
// current points, so a re-point moves it). `committedPoints` keeps its
// existing meaning (the start-anchored figure the ideal line starts from)
// and every replayed step is unaffected by this addition.
//
// Spec: docs/changes/CR-CRU-174-0.3.0s-fix-list-the-page.md §S1 + its first
// acceptance criterion ("The burndown answer carries the release's live
// total, and on fixed fixtures adding a CR raises it, voiding or
// superseding one lowers it, and a re-point moves it, while committedPoints
// is unchanged").
//
// Baseline (measured against this checkout): `BurndownPayload` in
// src/analytics.ts declares {release, committedPoints, target?, ideal?,
// points, unpointed} — no `totalPoints` field exists, and `burndown()`
// never computes one. So every `totalPoints` assertion below fails because
// the field reads `undefined`, never because of a typo.
//
// FIXTURE DESIGN — one release, one timeline, every mutation on the AC's own
// checklist, all points on the Fibonacci scale `STORY_POINT_SCALE` actually
// ships (1,2,3,5,8,13) even though this file calls the store door directly
// (which does not itself enforce the scale) — so nothing here could only
// pass against a value the real `cr-plan --points` route would refuse:
//   * CR-TOTAL-A, 5 pts, filed first — the release's start, so
//     committedPoints === 5 for the rest of the file.
//   * CR-TOTAL-B, 8 pts, filed after start — a live member throughout.
//   * CR-TOTAL-C, 3 pts, filed after B, then VOIDed (add, then void).
//   * CR-TOTAL-D, 2 pts, filed after C's void, then SUPERSEDEd (add, then
//     supersede).
//   * CR-TOTAL-B is then RE-POINTED 8 -> 13, then MOVED OUT to a second
//     release label — proving the move-out subtracts its CURRENT (13, not
//     8) points.
//   * CR-TOTAL-A's plan is finally closed with a merge commit — the total
//     must NOT move (merged stays live "work done", still in scope).
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
  totalPoints?: number;
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
  const dir = mkdtempSync(join(tmpdir(), "release-live-total-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getBurndown(key: string, release: string): Promise<{ status: number; body: BurndownBody }> {
  const res = await fetch(
    `${base()}/api/v2/projects/${key}/analytics/burndown?release=${encodeURIComponent(release)}`,
  );
  let body: BurndownBody = {};
  try {
    body = (await res.json()) as BurndownBody;
  } catch {
    // No JSON body: fail on the FIELD assertions below.
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
  const input: QueuePlanInput = { cr, release, wave: "1", title: cr, ...(points === undefined ? {} : { points }) };
  handle!.store.upsertQueueEntry(key, input);
}

describe("CR-CRU-174 §S1 — the burndown answer's live total points", () => {
  test("totalPoints is the release's live-CR sum, rising on an add or a re-point, falling on a void, a supersede or a move-out, unmoved by a merge — while committedPoints and every replayed step stay exactly what they were before this field existed", async () => {
    boot();
    const key = crypto.randomUUID();
    handle!.store.addProject({ key, name: "release-live-total", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const RELEASE = "7.7.0";
    const OTHER_RELEASE = "7.8.0";

    // RELEASE START — CR-TOTAL-A, 5 points, the earliest filed_at.
    fileWithPoints(key, "CR-TOTAL-A", RELEASE, 5, "2027-01-01T00:00:00.000Z");
    // A live member filed after start.
    fileWithPoints(key, "CR-TOTAL-B", RELEASE, 8, "2027-01-01T01:00:00.000Z");

    const afterStart = await getBurndown(key, RELEASE);
    expect(afterStart.status).toBe(200);
    expect(afterStart.body.committedPoints).toBe(5);
    // totalPoints = A(5) + B(8), both live and pending.
    expect(afterStart.body.totalPoints).toBe(13);

    // ── adding a CR to the release raises it ──────────────────────────────
    fileWithPoints(key, "CR-TOTAL-C", RELEASE, 3, "2027-01-01T02:00:00.000Z");
    const afterAdd = await getBurndown(key, RELEASE);
    expect(afterAdd.body.totalPoints).toBe(16); // 13 + 3
    expect(afterAdd.body.committedPoints).toBe(5); // unchanged by the add

    // ── voiding one lowers it ──────────────────────────────────────────────
    setSystemTime(new Date("2027-01-01T03:00:00.000Z"));
    const voided = handle!.store.setQueueLifecycle(key, "CR-TOTAL-C", { state: "VOID", reason: "dropped" });
    expect(voided).not.toBeNull();
    const afterVoid = await getBurndown(key, RELEASE);
    expect(afterVoid.body.totalPoints).toBe(13); // 16 − 3
    expect(afterVoid.body.committedPoints).toBe(5);

    // A second add/supersede pair, so superseding is proven independently of voiding.
    fileWithPoints(key, "CR-TOTAL-D", RELEASE, 2, "2027-01-01T04:00:00.000Z");
    const afterSecondAdd = await getBurndown(key, RELEASE);
    expect(afterSecondAdd.body.totalPoints).toBe(15); // 13 + 2

    // ── superseding one lowers it ──────────────────────────────────────────
    setSystemTime(new Date("2027-01-01T05:00:00.000Z"));
    const superseded = handle!.store.setQueueLifecycle(key, "CR-TOTAL-D", { state: "SUPERSEDED", by: "CR-TOTAL-D2" });
    expect(superseded).not.toBeNull();
    const afterSupersede = await getBurndown(key, RELEASE);
    expect(afterSupersede.body.totalPoints).toBe(13); // 15 − 2
    expect(afterSupersede.body.committedPoints).toBe(5);

    // ── a re-point moves it ─────────────────────────────────────────────── 
    fileWithPoints(key, "CR-TOTAL-B", RELEASE, 13, "2027-01-01T06:00:00.000Z");
    const afterRepoint = await getBurndown(key, RELEASE);
    expect(afterRepoint.body.totalPoints).toBe(18); // 13 + (13 − 8)
    expect(afterRepoint.body.committedPoints).toBe(5);

    // ── moving a CR out lowers it (by its CURRENT points, 13, not its
    //    original 8) ──────────────────────────────────────────────────────
    fileWithPoints(key, "CR-TOTAL-B", OTHER_RELEASE, undefined, "2027-01-01T07:00:00.000Z");
    const afterMoveOut = await getBurndown(key, RELEASE);
    expect(afterMoveOut.body.totalPoints).toBe(5); // 18 − 13, only CR-TOTAL-A left
    expect(afterMoveOut.body.committedPoints).toBe(5);

    // ── merging one does NOT change it ──────────────────────────────────── 
    setSystemTime(new Date("2027-01-01T07:30:00.000Z"));
    const planA = planned(
      handle!.store.filePlan(key, { cr: "CR-TOTAL-A", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    planned(handle!.store.transitionCycle(key, planA.planId, planA.cycles[0]!.id, "active"));
    planned(handle!.store.transitionCycle(key, planA.planId, planA.cycles[0]!.id, "done"));
    setSystemTime(new Date("2027-01-01T08:00:00.000Z"));
    planned(handle!.store.closePlan(key, planA.planId, { commit: "aaa0001" }));

    const afterMerge = await getBurndown(key, RELEASE);
    expect(afterMerge.status).toBe(200);
    expect(afterMerge.body.totalPoints).toBe(5); // unchanged by the merge
    expect(afterMerge.body.committedPoints).toBe(5); // pinned, start-anchored, throughout

    // ── every replayed step is unaffected by totalPoints' arrival ─────────
    // The exact same 8 steps the pre-totalPoints replay would have produced:
    // B's own +8 filing, C's +3 filing then −3 void, D's +2 filing then −2
    // supersede, B's +5 re-point, B's −13 move-out, and A's −5 merge.
    const points = afterMerge.body.points ?? [];
    expect(points).toHaveLength(9); // the "start" step + the 8 above

    const byEvent = (cr: string, predicate: (p: BurndownPoint) => boolean) =>
      points.find((p) => p.cr === cr && predicate(p));

    const bFiled = byEvent("CR-TOTAL-B", (p) => p.verb === "cr-plan" && p.delta === 8);
    expect(bFiled).toBeDefined();
    const cFiled = byEvent("CR-TOTAL-C", (p) => p.verb === "cr-plan" && p.delta === 3);
    expect(cFiled).toBeDefined();
    const cVoided = byEvent("CR-TOTAL-C", (p) => p.event === "voided" && p.verb === "cr-void");
    expect(cVoided).toBeDefined();
    expect(cVoided!.delta).toBe(-3);
    const dFiled = byEvent("CR-TOTAL-D", (p) => p.verb === "cr-plan" && p.delta === 2);
    expect(dFiled).toBeDefined();
    const dSuperseded = byEvent("CR-TOTAL-D", (p) => p.event === "superseded" && p.verb === "cr-supersede");
    expect(dSuperseded).toBeDefined();
    expect(dSuperseded!.delta).toBe(-2);
    const bRepointed = byEvent("CR-TOTAL-B", (p) => p.delta === 5);
    expect(bRepointed).toBeDefined();
    const bMovedOut = byEvent("CR-TOTAL-B", (p) => p.delta === -13);
    expect(bMovedOut).toBeDefined();
    const aMerged = byEvent("CR-TOTAL-A", (p) => p.event === "merged" && p.verb === "cr-close");
    expect(aMerged).toBeDefined();
    expect(aMerged!.delta).toBe(-5);

    // Order-independent arithmetic proof, exactly like the pre-existing
    // (pinned, unchanged) burndown replay: walk `points[]` in ts order and
    // re-derive `remaining` from committedPoints + the running delta sum.
    const chronological = [...points].sort((a, b) => a.ts - b.ts);
    let running = afterMerge.body.committedPoints!;
    for (const p of chronological) {
      running += p.delta;
      expect(p.remaining).toBe(running);
    }
    expect(running).toBe(0); // A merged (contributes 0), B moved out, C/D dead
  });
});
