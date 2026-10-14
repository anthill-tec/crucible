// A POPULATED store, built by the test itself — the stand-in for "a board that
// has been used for months" that the real-scale cases need, without ever
// reading the operator's own dev store.
//
// Every row is written through the ordinary `Store` door, under a pinned
// clock, from fixed keys and labels, so two builds hold the same rows in the
// same order. The population is deliberately varied rather than large: each
// shape below is one a real board holds and a careless migration or read
// would get wrong.
//
//   * Three projects; the last is ARCHIVED once its rows are written, and the
//     second keeps a small retention cap, so its oldest test/compile rows are
//     evicted into day ROLLUPS across several days.
//   * Per project, plans of every status: closed with a merge (one to three
//     cycles, runs interleaved across them, git context on runs, gates and
//     milestones), closed without a merge, aborted (its cycles carry the
//     abort record), and open — one with an ACTIVE cycle, an appended cycle,
//     a renamed one, a skipped one and a failed one, every change recorded.
//     Plans carry a title, orchestrator, wave and track where a real one does.
//   * Test runs and compile reports under DECLARED roles and under agent ids
//     whose role is left undeclared; lifecycle register/unregister rows; gate
//     snapshots.
//   * Milestones of every built-in type and a project-defined one, carrying
//     every combination of target and delivered date: a delivered release
//     with no proposal, a live proposal with no release, a proposal a release
//     later fulfilled, and a revised proposal. Labels are distinct per
//     project.
//   * A queue for `POPULATED_RELEASE`: pointed, unpointed, re-pointed, voided,
//     superseded and moved-out entries, and one whose plan merged — plus
//     entries in a second release.
//
// It never opens, copies or backs up `data/crucible.db`, and touches no port.
import { setSystemTime } from "bun:test";
import type { Store } from "../../src/store.ts";
import type { CompileReport } from "../../src/codecs/compile.ts";
import type { ChangeRecord, Plan, PlanCycle, RunSchema } from "../../src/types.ts";

/** The release the populated queue is built around. */
export const POPULATED_RELEASE = "4.2.0";
/** The second release the queue holds, and the one an entry moves out to. */
export const POPULATED_OTHER_RELEASE = "4.3.0";

/** Where the pinned clock starts: 2027-01-01T00:00:00Z. */
const START = Date.UTC(2027, 0, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Epoch SECONDS, the unit milestone dates are carried in. */
const START_S = START / 1000;
const DAY_S = 86_400;

export interface PopulatedProject {
  key: string;
  archived: boolean;
}

export interface PopulatedStore {
  projects: PopulatedProject[];
}

export interface PopulateOptions {
  /** Archive the last project once its rows are written. Default true. */
  archiveLast?: boolean;
}

function ok<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`populated store: refused: ${String(result.error)}`);
  return result as Exclude<T, { error: string }>;
}

function change(tag: string): ChangeRecord {
  return { reason: `populated ${tag}`, cause: "spec-design", specRef: `populated-spec-${tag}` };
}

function run(passed: number, failed: number): RunSchema {
  const cases = [
    ...Array.from({ length: passed }, (_, i) => ({ name: `passes ${String(i)}`, status: "pass" as const, duration_ms: 3 })),
    ...Array.from({ length: failed }, (_, i) => ({ name: `fails ${String(i)}`, status: "fail" as const, duration_ms: 5 })),
  ];
  return {
    summary: { total: passed + failed, passed, failed, pending: 0, duration_ms: 3 * passed + 5 * failed },
    tree: [{ name: "populated suite", status: failed > 0 ? "fail" : "pass", children: cases }],
  };
}

const COMPILE: CompileReport = {
  format: "tsc",
  errorCount: 1,
  warningCount: 1,
  diagnostics: [
    { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
    { file: "src/b.ts", line: 2, col: 3, code: "TS6133", message: "'y' is declared but never used.", level: "warning" },
  ],
  raw: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\nsrc/b.ts(2,3): warning TS6133: 'y' is declared but never used.",
};

/**
 * Write the population into `store` (which should be empty) and answer the
 * projects it made. The clock is pinned while it writes and released when it
 * returns.
 */
export function populateStore(store: Store, options: PopulateOptions = {}): PopulatedStore {
  const archiveLast = options.archiveLast ?? true;
  let clock = START;
  const at = (ms: number): number => {
    clock += ms;
    setSystemTime(clock);
    return clock;
  };
  setSystemTime(clock);
  try {
    const projects: PopulatedProject[] = [];
    for (let p = 0; p < 3; p++) {
      // Fixed, and UUID-shaped: the routes refuse any other project key.
      const key = `00000000-0000-4000-8000-00000000000${String(p)}`;
      store.addProject({
        key,
        name: `populated ${String(p)}`,
        type: "backend",
        sutRoot: `/tmp/populated-${String(p)}`,
        retention: p === 1 ? 12 : 1_000_000,
      });
      populateProject(store, key, p, at);
      projects.push({ key, archived: false });
    }
    if (archiveLast) {
      at(HOUR);
      const last = projects[projects.length - 1]!;
      store.archiveProject(last.key);
      last.archived = true;
    }
    return { projects };
  } finally {
    setSystemTime();
  }
}

function populateProject(store: Store, key: string, p: number, at: (ms: number) => number): void {
  const branch = `feat/populated-${String(p)}`;
  const orchestrator = `populated-orch-${String(p)}`;
  const commit = (tag: string): string => `p${String(p)}${tag}`;
  const cr = (tag: string): string => `POP-${String(p)}-${tag}`;

  // ── merged plans, one to three cycles, runs interleaved across them ──────
  for (let m = 0; m < 4; m++) {
    at(DAY);
    const cycleCount = 1 + (m % 3);
    const plan = ok(
      store.filePlan(key, {
        cr: cr(`M${String(m)}`),
        ...(m % 2 === 0 ? { title: `merged plan ${String(m)}` } : {}),
        ...(m !== 3 ? { orchestrator } : {}),
        ...(m < 2 ? { wave: String(m + 1) } : {}),
        ...(m === 1 ? { track: "track-a" } : {}),
        cycles: Array.from({ length: cycleCount }, (_, c) => ({
          label: `c${String(c + 1)}`,
          kind: c === 1 ? ("verify" as const) : ("red-green" as const),
        })),
      }),
    );
    const cycleIds = plan.cycles.map((cycle: PlanCycle) => cycle.id);
    for (const [c, cycleId] of cycleIds.entries()) {
      const activatedAt = at(HOUR);
      ok(store.transitionCycle(key, plan.planId, cycleId, "active"));
      store.recordLifecycleEvent(key, `populated-${String(p)}-${String(m)}-RED`, "registered", activatedAt, "RED", cycleId);
      for (let r = 0; r < 3; r++) {
        at(r === 1 ? 0 : 7 * 60_000);
        const withGit = (r + c + m) % 3 !== 2;
        store.recordTestEvent(key, `populated-${String(p)}-${String(m)}-RED`, run(4 + r, r === 0 ? 1 : 0), {
          ...(r === 2 ? {} : { role: r === 0 ? ("RED" as const) : ("GREEN" as const) }),
          context: {
            cycleId,
            ...(withGit ? { git: { branch, commit: commit(`-m${String(m)}-c${String(c)}-r${String(r)}`) } } : {}),
          },
        });
      }
      if (c === 0) {
        at(60_000);
        store.recordCompileEvent(key, `populated-${String(p)}-builder`, COMPILE, {
          context: { cycleId, git: { branch, commit: commit(`-m${String(m)}-compile`) } },
        });
      }
      at(60_000);
      store.recordLifecycleEvent(key, `populated-${String(p)}-${String(m)}-RED`, "unregistered", undefined, "RED", cycleId);
      at(60_000);
      ok(store.transitionCycle(key, plan.planId, cycleId, "done"));
    }
    at(10 * 60_000);
    store.recordGateEvent(
      key,
      orchestrator,
      { outcome: "passed", steps: [{ name: "review", status: "passed", findings: m }], run: { id: `populated-gate-${String(p)}-${String(m)}` } },
      { role: "ORCHESTRATOR", context: { cycleId: cycleIds[cycleIds.length - 1]!, git: { branch, commit: commit(`-m${String(m)}-gate`) } } },
    );
    at(10 * 60_000);
    ok(store.closePlan(key, plan.planId, { commit: commit(`-merge-${String(m)}`) }));
    store.recordMilestoneEvent(key, orchestrator, "cr-merged", {
      label: cr(`M${String(m)}`),
      commit: commit(`-merge-${String(m)}`),
      context: { cycleId: cycleIds[0]!, git: { branch, commit: commit(`-m${String(m)}-landed`) } },
    });
  }

  // ── closed WITHOUT a merge ────────────────────────────────────────────────
  at(DAY);
  const unmerged = ok(store.filePlan(key, { cr: cr("U"), cycles: [{ label: "c1", kind: "red-green" }] }));
  ok(store.transitionCycle(key, unmerged.planId, unmerged.cycles[0]!.id, "active"));
  at(HOUR);
  store.recordTestEvent(key, `populated-${String(p)}-unmerged-GREEN`, run(2, 0), {
    context: { cycleId: unmerged.cycles[0]!.id, git: { branch, commit: commit("-unmerged") } },
  });
  ok(store.transitionCycle(key, unmerged.planId, unmerged.cycles[0]!.id, "done"));
  at(HOUR);
  ok(store.closePlan(key, unmerged.planId));

  // ── aborted: its cycles carry the abort record ───────────────────────────
  at(DAY);
  const aborted: Plan = ok(
    store.filePlan(key, {
      cr: cr("A"),
      title: "aborted plan",
      cycles: [
        { label: "c1", kind: "red-green" },
        { label: "c2", kind: "verify" },
      ],
    }),
  );
  ok(store.transitionCycle(key, aborted.planId, aborted.cycles[0]!.id, "active"));
  at(HOUR);
  ok(store.abortPlan(key, aborted.planId, change(`abort-${String(p)}`)));

  // ── open: an active cycle, and every recorded change a plan can carry ────
  at(DAY);
  const open = ok(
    store.filePlan(key, {
      cr: cr("O"),
      title: "open plan",
      orchestrator,
      wave: "3",
      track: "track-b",
      cycles: [
        { label: "c1", kind: "red-green" },
        { label: "c2", kind: "red-green" },
        { label: "c3", kind: "red-green" },
        { label: "c4", kind: "verify" },
      ],
    }),
  );
  const [o1, o2, o3] = open.cycles.map((cycle: PlanCycle) => cycle.id);
  ok(store.transitionCycle(key, open.planId, o1!, "active"));
  at(HOUR);
  store.recordTestEvent(key, `populated-${String(p)}-open-RED`, run(1, 2), {
    role: "RED",
    context: { cycleId: o1!, git: { branch, commit: commit("-open-1") } },
  });
  at(HOUR);
  ok(store.transitionCycle(key, open.planId, o1!, "failed"));
  ok(store.editCycleLabel(key, open.planId, o2!, "c2-renamed", change(`rename-${String(p)}`)));
  ok(store.transitionCycle(key, open.planId, o3!, "skipped", change(`skip-${String(p)}`)));
  ok(store.appendCycle(key, open.planId, { label: "c5", kind: "red-green" }, undefined, change(`append-${String(p)}`)));
  at(HOUR);
  ok(store.transitionCycle(key, open.planId, o2!, "active"));
  at(HOUR);
  store.recordTestEvent(key, `populated-${String(p)}-open-GREEN`, run(3, 0), {
    role: "GREEN",
    context: { cycleId: o2! },
  });

  // ── unbound telemetry, under undeclared roles ────────────────────────────
  for (let u = 0; u < 4; u++) {
    at(DAY / 2);
    store.recordTestEvent(key, u % 2 === 0 ? `populated-${String(p)}-adhoc-FIX` : `populated-${String(p)}-adhoc`, run(5, u % 2));
  }

  // ── milestones of every shape ────────────────────────────────────────────
  const major = String(p + 1);
  at(HOUR);
  // A delivered release that never had a proposal.
  store.recordMilestoneEvent(key, orchestrator, "release", {
    label: `${major}.0.0`,
    commit: commit("-release-0"),
    releasedAt: START_S + (10 + p) * DAY_S,
    crs: [cr("M0"), cr("M1")],
    packages: [{ registry: "npm", name: "@populated/server", version: `${major}.0.0` }],
  });
  at(HOUR);
  // A live proposal matching no release.
  store.recordReleaseProposal(key, orchestrator, { label: `${major}.1.0`, targetAt: START_S + (40 + p) * DAY_S });
  at(HOUR);
  // A proposal a release later fulfilled.
  store.recordReleaseProposal(key, orchestrator, { label: `${major}.2.0`, targetAt: START_S + (20 + p) * DAY_S });
  at(HOUR);
  store.recordMilestoneEvent(key, orchestrator, "release", {
    label: `${major}.2.0`,
    commit: commit("-release-2"),
    releasedAt: START_S + (21 + p) * DAY_S,
    crs: [cr("M2")],
  });
  at(HOUR);
  // A revised proposal: the superseded row and the live one.
  store.recordReleaseProposal(key, orchestrator, { label: `${major}.3.0`, targetAt: START_S + (50 + p) * DAY_S });
  at(HOUR);
  store.recordReleaseProposal(key, orchestrator, { label: `${major}.3.0`, targetAt: START_S + (57 + p) * DAY_S });
  // The other built-in types, and one the project defines, across every
  // combination of the two dates.
  const others: Array<[string, { targetAt?: number; deliveredAt?: number }]> = [
    ["gap-analysis", {}],
    ["design-review", { deliveredAt: START_S + (5 + p) * DAY_S }],
    ["stage-flip", { targetAt: START_S + (30 + p) * DAY_S }],
    ["custom", { targetAt: START_S + (31 + p) * DAY_S, deliveredAt: START_S + (32 + p) * DAY_S }],
    ["roadmap-review", { deliveredAt: START_S + (33 + p) * DAY_S }],
  ];
  for (const [index, [type, dates]] of others.entries()) {
    at(HOUR);
    store.recordMilestoneEvent(key, orchestrator, type, {
      label: `${type}-${String(p)}`,
      ...dates,
      ...(index === 0 ? { context: { cycleId: o2! } } : {}),
    });
  }

  // ── the queue ────────────────────────────────────────────────────────────
  const scale = p + 1;
  const queue: Array<[string, string, string, number | undefined]> = [
    [cr("Q-A"), POPULATED_RELEASE, "1", 5],
    [cr("Q-B"), POPULATED_RELEASE, "1", 8],
    [cr("Q-C"), POPULATED_RELEASE, "1", 3],
    [cr("Q-D"), POPULATED_RELEASE, "2", 2],
    [cr("Q-E"), POPULATED_RELEASE, "2", undefined],
    [cr("Q-F"), POPULATED_RELEASE, "2", scale === 1 ? 1 : 13],
    [cr("Q-G"), POPULATED_RELEASE, "2", 1],
    [cr("Q-H"), POPULATED_OTHER_RELEASE, "3", 5],
  ];
  for (const [entryCr, release, wave, points] of queue) {
    at(HOUR);
    store.upsertQueueEntry(key, {
      cr: entryCr,
      release,
      wave,
      title: entryCr,
      ...(points === undefined ? {} : { points }),
    });
  }
  at(HOUR);
  store.setQueueLifecycle(key, cr("Q-C"), { state: "VOID", reason: "dropped" });
  at(HOUR);
  store.setQueueLifecycle(key, cr("Q-D"), { state: "SUPERSEDED", by: cr("Q-H") });
  at(HOUR);
  // A re-point, so the CURRENT points are not the first ones declared.
  store.upsertQueueEntry(key, { cr: cr("Q-B"), release: POPULATED_RELEASE, wave: "1", title: cr("Q-B"), points: 13 });
  at(HOUR);
  // A move-out to the other release.
  store.upsertQueueEntry(key, { cr: cr("Q-F"), release: POPULATED_OTHER_RELEASE, wave: "3", title: cr("Q-F") });
  // A queued cr whose plan merged.
  at(HOUR);
  const landed = ok(store.filePlan(key, { cr: cr("Q-A"), cycles: [{ label: "c1", kind: "red-green" }] }));
  ok(store.transitionCycle(key, landed.planId, landed.cycles[0]!.id, "active"));
  ok(store.transitionCycle(key, landed.planId, landed.cycles[0]!.id, "done"));
  at(HOUR);
  ok(store.closePlan(key, landed.planId, { commit: commit("-queue-merge") }));
}
