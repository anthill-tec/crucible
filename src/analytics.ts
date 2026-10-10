// CR-CRU-022 §S2–§S4 — roadmap analytics: velocity, burndown and forecast.
//
// Design: docs/research/DN-crucible-analytics.md §3 (the two clocks, "flow"),
// §5 (velocity), §6 (burndown), §7 (forecast) and §8 (schedule health). Pure
// derivations over what the board already holds — plans, cycle-linked runs,
// the queue, its internal `filed_at`, the declaration journal and the
// release's declared target. Nothing here writes, and nothing is persisted:
// every answer is recomputed per request (§S4 "Nothing is persisted").
import type { QueueDeclaration } from "./store.ts";
import { isDeadCr } from "./types.ts";
import type { Plan, QueueEntry } from "./types.ts";

const DAY_MS = 86_400_000;
/** DN §7 — the Monte Carlo's draw count. */
export const FORECAST_DRAWS = 1000;
/**
 * A draw's safety stop, in simulated days. Unreachable while the release's
 * history holds a positive day — every such draw terminates — but a loop over
 * sampled values must never be able to spin forever.
 */
const MAX_SIMULATED_DAYS = 100_000;

/** The UTC calendar day an instant falls on: its 00:00 UTC. */
function dayStart(ts: number): number {
  const day = new Date(ts);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

function dayLabel(start: number): string {
  return new Date(start).toISOString().slice(0, 10);
}

/**
 * Each cr's merge instant: when its plan CLOSED WITH A MERGE (DN §5). A cr
 * refiled after an abort merges once; the earliest merged close is the one
 * that counts, so it is never counted twice.
 */
export function mergedAtByCr(plans: Plan[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const plan of plans) {
    if (plan.status !== "closed" || plan.merge === undefined || plan.closedAt === undefined) {
      continue;
    }
    const held = merged.get(plan.cr);
    if (held === undefined || plan.closedAt < held) merged.set(plan.cr, plan.closedAt);
  }
  return merged;
}

/**
 * The crs ever planned into `release`: its present members, plus every cr a
 * journalled release move took into or out of it (DN §6).
 */
function releaseMembers(release: string, entries: QueueEntry[], journal: QueueDeclaration[]): Set<string> {
  const members = new Set<string>();
  for (const entry of entries) {
    if (entry.release === release) members.add(entry.cr);
  }
  for (const row of journal) {
    const moved = releaseChange(row);
    if (moved !== undefined && (moved.from === release || moved.to === release)) {
      members.add(row.cr);
    }
  }
  return members;
}

/**
 * DN §6 — the release's start: the earliest `filed_at` among its crs, and
 * the cr that set it. Undefined when none of them carries a `filed_at`.
 */
function releaseStart(
  members: Iterable<string>,
  filedAt: Map<string, number>,
): { ts: number; cr: string } | undefined {
  let start: { ts: number; cr: string } | undefined;
  for (const cr of members) {
    const ts = filedAt.get(cr);
    if (ts !== undefined && (start === undefined || ts < start.ts)) start = { ts, cr };
  }
  return start;
}

/** The release's pointed throughput per UTC day, since its start. */
interface ReleaseDays {
  /** Undefined only when no member carries a `filed_at` — then `days` is empty. */
  startTs?: number;
  /** One entry per UTC day from the start's day to today inclusive; a day with no merge is 0. */
  days: Array<{ day: string; points: number }>;
  /** How many of the release's pointed crs have merged inside `days`. */
  pointedMerges: number;
}

/**
 * DN §5/§7 — the release's daily series: each pointed cr of the release
 * counts its points on the UTC day its plan closed with a merge. Unpointed
 * crs never count, and neither does another release's merge.
 */
function releaseDays(
  release: string,
  members: Set<string>,
  entries: QueueEntry[],
  plans: Plan[],
  filedAt: Map<string, number>,
  now: number,
): ReleaseDays {
  const start = releaseStart(members, filedAt);
  if (start === undefined) return { days: [], pointedMerges: 0 };
  const merged = mergedAtByCr(plans);
  const firstDay = dayStart(start.ts);
  const today = dayStart(now);
  const byDay = new Map<number, number>();
  let pointedMerges = 0;
  for (const entry of entries) {
    if (entry.release !== release || entry.points === undefined) continue;
    const at = merged.get(entry.cr);
    if (at === undefined) continue;
    const day = dayStart(at);
    if (day < firstDay || day > today) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + entry.points);
    pointedMerges += 1;
  }
  const days: Array<{ day: string; points: number }> = [];
  for (let day = firstDay; day <= today; day += DAY_MS) {
    days.push({ day: dayLabel(day), points: byDay.get(day) ?? 0 });
  }
  return { startTs: start.ts, days, pointedMerges };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// ── §S2 — velocity ────────────────────────────────────────────────────────

export interface VelocityInput {
  release: string;
  plans: Plan[];
  entries: QueueEntry[];
  /** Each queued cr's internal `filed_at` (epoch ms) — sets the release's start. */
  filedAt: Map<string, number>;
  /** The declaration journal — the release's membership, as `burndown` reads it. Absent: the present queue only. */
  journal?: QueueDeclaration[];
  /** `exec(c)` per cycle id — Σ duration_ms of its cycle-linked runs. */
  execByCycle: Map<number, number>;
  now: number;
}

export interface VelocityPayload {
  release: string;
  /** The release's start (its earliest `filed_at`). Absent only when no member carries one. */
  startTs?: number;
  /** Absent while the series covers no day — never a fabricated 0. */
  pointsPerDay?: number;
  days: Array<{ day: string; points: number }>;
  sampleDays: number;
  flow: { execMsPerCycle?: number; gateMsPerCycle?: number; sampleCycles: number };
}

/**
 * DN §5 — the release's pace so far: its pointed points
 * merged since its start, divided by the days since that start, today
 * included (`pointsPerDay`), with the per-day series (`days`, zero-filled)
 * and how many days it covers (`sampleDays`). `flow` keeps DN §3's two
 * clocks per sealed cycle, project-level — exec = Σ its cycle-linked runs,
 * gate = loop − exec floored at 0 — reported beside velocity, never summed
 * into it. `null` when no cr was ever planned into the release.
 */
export function velocity(input: VelocityInput): VelocityPayload | null {
  const members = releaseMembers(input.release, input.entries, input.journal ?? []);
  if (members.size === 0) return null;
  const { startTs, days } = releaseDays(
    input.release,
    members,
    input.entries,
    input.plans,
    input.filedAt,
    input.now,
  );
  const merged = days.reduce((sum, day) => sum + day.points, 0);

  const execs: number[] = [];
  const gates: number[] = [];
  for (const plan of input.plans) {
    for (const cycle of plan.cycles) {
      if (cycle.activatedAt === undefined || cycle.doneAt === undefined) continue;
      const exec = input.execByCycle.get(cycle.id) ?? 0;
      execs.push(exec);
      gates.push(Math.max(0, cycle.doneAt - cycle.activatedAt - exec));
    }
  }

  return {
    release: input.release,
    ...(startTs !== undefined ? { startTs } : {}),
    ...(days.length > 0 ? { pointsPerDay: merged / days.length } : {}),
    days,
    sampleDays: days.length,
    flow: {
      ...(execs.length > 0
        ? {
            execMsPerCycle: Math.round(mean(execs)),
            gateMsPerCycle: Math.round(mean(gates)),
          }
        : {}),
      sampleCycles: execs.length,
    },
  };
}

// ── §S3 — burndown ────────────────────────────────────────────────────────

export interface BurndownInput {
  release: string;
  entries: QueueEntry[];
  filedAt: Map<string, number>;
  journal: QueueDeclaration[];
  plans: Plan[];
  /** The release's declared target (CR-CRU-091), epoch SECONDS. */
  targetAt?: number;
}

export interface BurndownStep {
  ts: number;
  remaining: number;
  event: string;
  cr: string;
  /** The verb that moved it. Absent only for a pre-journal fact no verb recorded. */
  verb?: string;
  delta: number;
}

export interface BurndownPayload {
  release: string;
  committedPoints: number;
  /** The release's live total: the current points of its live crs, merged and pending. */
  totalPoints: number;
  target?: number;
  ideal?: Array<{ ts: number; remaining: number }>;
  points: BurndownStep[];
  unpointed: string[];
}

/** One cr's standing in the release at a point of the replay. */
interface CrStanding {
  inRelease: boolean;
  alive: boolean;
  merged: boolean;
  points?: number;
}

/** What one cr contributes to the release's remaining total. */
function contribution(standing: CrStanding): number {
  return standing.inRelease && standing.alive && !standing.merged && standing.points !== undefined
    ? standing.points
    : 0;
}

interface ReplayEvent {
  ts: number;
  cr: string;
  event: string;
  verb?: string;
  apply: (standing: CrStanding) => void;
}

function releaseChange(row: QueueDeclaration): { from: unknown; to: unknown } | undefined {
  return row.change.release;
}

/** The journal row's own lifecycle `to` value, judged by the ONE dead-CR predicate. */
function rowKillsCr(row: QueueDeclaration): boolean {
  const to = row.change.lifecycle?.to;
  const state =
    typeof to === "object" && to !== null && "state" in to ? (to as { state: unknown }).state : null;
  return isDeadCr({
    lifecycle: state === "VOID" || state === "SUPERSEDED" ? { state } : null,
  });
}

function planEventName(row: QueueDeclaration, release: string): string {
  const moved = releaseChange(row);
  if (moved !== undefined) return moved.to === release ? "planned" : "moved-out";
  return "repointed";
}

/**
 * §S3 — the release's SCRUM burndown, replayed from the declaration journal,
 * the merges and each cr's internal `filed_at`.
 *
 * - The release starts at the earliest `filed_at` among its crs; everything
 *   declared up to that instant folds into `committedPoints`.
 * - A cr's FIRST points declaration is its estimate and applies from when it
 *   entered the release (DN §4: points are declared once, at design); every
 *   LATER points declaration is a re-point, journalled and shown as a step.
 * - Steps: `merged` (verb `cr-close`) when its plan closes with a merge;
 *   `planned`/`moved-out`/`repointed` (verb `cr-plan`); `voided`/`superseded`
 *   (verb `cr-void`/`cr-supersede`). Each names its cr; a zero-delta event
 *   is not a step.
 * - A dead cr contributes nothing (`isDeadCr`); an unpointed cr is named in
 *   `unpointed` and contributes to no total.
 *
 * `null` when no cr was ever planned into the release.
 */
export function burndown(input: BurndownInput): BurndownPayload | null {
  const { release } = input;
  const entryByCr = new Map(input.entries.map((entry) => [entry.cr, entry]));
  const rowsByCr = new Map<string, QueueDeclaration[]>();
  for (const row of input.journal) {
    const rows = rowsByCr.get(row.cr) ?? [];
    rows.push(row);
    rowsByCr.set(row.cr, rows);
  }
  const members = releaseMembers(release, input.entries, input.journal);
  if (members.size === 0) return null;

  const merged = mergedAtByCr(input.plans);
  const standings = new Map<string, CrStanding>();
  const events: ReplayEvent[] = [];
  const filed = releaseStart(members, input.filedAt);
  let start = filed?.ts ?? Number.POSITIVE_INFINITY;
  let startCr: string | undefined = filed?.cr;

  for (const cr of members) {
    const entry = entryByCr.get(cr);
    const rows = rowsByCr.get(cr) ?? [];
    const filedAt = input.filedAt.get(cr);
    const firstPointed = rows.find((row) => row.points !== undefined);
    standings.set(cr, {
      inRelease: false,
      alive: true,
      merged: false,
      ...(firstPointed?.points !== undefined ? { points: firstPointed.points } : {}),
    });

    // Membership that predates the journal: the cr sat in this release
    // before any journalled release move, so it entered when it was filed.
    const firstMove = rows.find((row) => releaseChange(row) !== undefined);
    const heldBeforeJournal =
      firstMove !== undefined ? releaseChange(firstMove)!.from === release : entry?.release === release;
    if (heldBeforeJournal) {
      events.push({
        ts: filedAt ?? Number.NEGATIVE_INFINITY,
        cr,
        event: "filed",
        apply: (standing) => {
          standing.inRelease = true;
        },
      });
    }

    for (const row of rows) {
      if (row.verb === "cr-plan") {
        events.push({
          ts: row.at,
          cr,
          event: planEventName(row, release),
          verb: row.verb,
          apply: (standing) => {
            const moved = releaseChange(row);
            if (moved !== undefined) standing.inRelease = moved.to === release;
            if (row.points !== undefined && row !== firstPointed) standing.points = row.points;
          },
        });
      } else {
        const kills = rowKillsCr(row);
        events.push({
          ts: row.at,
          cr,
          event: row.verb === "cr-void" ? "voided" : "superseded",
          verb: row.verb,
          apply: (standing) => {
            standing.alive = !kills;
          },
        });
      }
    }

    // A lifecycle no journal row recorded (declared before the journal, or
    // through the migration door): still dead, from its own stamp.
    const journalledLifecycle = rows.some((row) => row.verb !== "cr-plan");
    if (entry !== undefined && isDeadCr(entry) && !journalledLifecycle) {
      events.push({
        ts: entry.lifecycle!.at,
        cr,
        event: entry.lifecycle!.state === "VOID" ? "voided" : "superseded",
        apply: (standing) => {
          standing.alive = false;
        },
      });
    }

    const mergedAt = merged.get(cr);
    if (mergedAt !== undefined) {
      events.push({
        ts: mergedAt,
        cr,
        event: "merged",
        verb: "cr-close",
        apply: (standing) => {
          standing.merged = true;
        },
      });
    }
  }

  // Stable: a cr's own events keep their push order at an equal instant.
  events.sort((a, b) => a.ts - b.ts);
  if (!Number.isFinite(start)) {
    start = events.length > 0 && Number.isFinite(events[0]!.ts) ? events[0]!.ts : 0;
    startCr = events[0]?.cr;
  }

  let running = 0;
  let committed = 0;
  const steps: BurndownStep[] = [];
  for (const ev of events) {
    const standing = standings.get(ev.cr)!;
    const before = contribution(standing);
    ev.apply(standing);
    const delta = contribution(standing) - before;
    running += delta;
    if (ev.ts <= start) {
      committed = running;
      continue;
    }
    if (delta === 0) continue;
    steps.push({
      ts: ev.ts,
      remaining: running,
      event: ev.event,
      cr: ev.cr,
      ...(ev.verb !== undefined ? { verb: ev.verb } : {}),
      delta,
    });
  }

  const unpointed = input.entries
    .filter((entry) => entry.release === release && !isDeadCr(entry) && entry.points === undefined)
    .map((entry) => entry.cr);
  const totalPoints = input.entries
    .filter((entry) => entry.release === release && !isDeadCr(entry) && entry.points !== undefined)
    .reduce((sum, entry) => sum + (entry.points ?? 0), 0);

  const points: BurndownStep[] = [
    { ts: start, remaining: committed, event: "start", cr: startCr ?? [...members][0]!, delta: 0 },
    ...steps,
  ];

  return {
    release,
    committedPoints: committed,
    totalPoints,
    ...(input.targetAt !== undefined
      ? {
          target: input.targetAt,
          ideal: [
            { ts: start, remaining: committed },
            { ts: input.targetAt * 1000, remaining: 0 },
          ],
        }
      : {}),
    points,
    unpointed,
  };
}

// ── §S4 — forecast ────────────────────────────────────────────────────────

/**
 * mulberry32 — a small, well-distributed 32-bit PRNG, used ONLY when the
 * caller passes the test-only seed (DN §7 "Determinism for tests"). Unseeded
 * draws use `Math.random`.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface ForecastInput {
  release: string;
  entries: QueueEntry[];
  plans: Plan[];
  /** Each queued cr's internal `filed_at` (epoch ms) — sets the release's start, as `burndown` reads it. */
  filedAt: Map<string, number>;
  /** The declaration journal — the release's membership, as `burndown` reads it. Absent: the present queue only. */
  journal?: QueueDeclaration[];
  now: number;
  /** The release's declared target (CR-CRU-091), epoch SECONDS. */
  targetAt?: number;
  random: () => number;
}

export type ScheduleHealth = "ahead" | "at-risk" | "behind";

export interface ForecastPayload {
  release: string;
  remainingPoints: number;
  p50Ts?: number;
  p80Ts?: number;
  scheduleHealth?: ScheduleHealth;
  /** How many days of the release's history the forecast rests on. */
  sampleDays: number;
  status: "ok" | "insufficient_history" | "unpointed";
  /** The release's live, unmerged crs that carry no points. Absent when none. */
  unpointed?: string[];
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * DN §7 — Monte Carlo over the release's DAILY pointed
 * throughput since its start (a day with no merge is a real zero): each of
 * 1,000 draws samples whole days uniformly from that series until the
 * release's remaining points reach 0, completing that many days from `now`.
 * P50/P80 of those instants. `sampleDays` says how many days it rests on.
 *
 * Gates, both with NO band values: no pointed cr of the release has merged
 * yet → `insufficient_history`; any live, unmerged cr unpointed →
 * `unpointed`, naming them (`unpointed` is carried whenever such a cr
 * exists, so the band can say why). `scheduleHealth` only against a
 * declared target (DN §8).
 */
export function forecast(input: ForecastInput): ForecastPayload {
  const merged = mergedAtByCr(input.plans);
  const members = releaseMembers(input.release, input.entries, input.journal ?? []);
  const { days, pointedMerges } = releaseDays(
    input.release,
    members,
    input.entries,
    input.plans,
    input.filedAt,
    input.now,
  );
  const history = days.map((day) => day.points);
  const remaining = input.entries.filter(
    (entry) => entry.release === input.release && !isDeadCr(entry) && !merged.has(entry.cr),
  );
  const unpointed = remaining.filter((entry) => entry.points === undefined).map((entry) => entry.cr);
  const remainingPoints = remaining.reduce((sum, entry) => sum + (entry.points ?? 0), 0);
  const base = {
    release: input.release,
    remainingPoints,
    sampleDays: history.length,
    ...(unpointed.length > 0 ? { unpointed } : {}),
  };
  if (pointedMerges === 0) return { ...base, status: "insufficient_history" };
  if (unpointed.length > 0) return { ...base, status: "unpointed" };

  const completions: number[] = [];
  for (let draw = 0; draw < FORECAST_DRAWS; draw += 1) {
    let burned = 0;
    let elapsed = 0;
    while (burned < remainingPoints && elapsed < MAX_SIMULATED_DAYS) {
      burned += history[Math.floor(input.random() * history.length)]!;
      elapsed += 1;
    }
    completions.push(input.now + elapsed * DAY_MS);
  }
  completions.sort((a, b) => a - b);
  const p50Ts = percentile(completions, 0.5);
  const p80Ts = percentile(completions, 0.8);

  let scheduleHealth: ScheduleHealth | undefined;
  if (input.targetAt !== undefined) {
    const target = input.targetAt * 1000;
    scheduleHealth = p80Ts <= target ? "ahead" : p50Ts <= target ? "at-risk" : "behind";
  }
  return {
    ...base,
    p50Ts,
    p80Ts,
    ...(scheduleHealth !== undefined ? { scheduleHealth } : {}),
    status: "ok",
  };
}

// ── §S3/AC12 — recorded plan changes and aborts, per release, by cause ──

/** One count per cause, plus the records that predate the fields. */
export interface ChangeCounts {
  "spec-design": number;
  "gap-analysis": number;
  unrecorded: number;
}

export interface PlanChangesInput {
  release: string;
  entries: QueueEntry[];
  plans: Plan[];
}

export interface PlanChangesPayload {
  release: string;
  changes: ChangeCounts;
  aborts: ChangeCounts;
}

const emptyCounts = (): ChangeCounts => ({ "spec-design": 0, "gap-analysis": 0, unrecorded: 0 });

/**
 * §S3 — the defect signal for a release's retrospective: every recorded plan
 * change (insert, rename, non-FIX append, skip) its CURRENT members' plans
 * carry, and every abort of one of those plans, each counted by cause.
 * Membership is the queue's present `release` field — a count has no time
 * dimension to replay. A skipped cycle with no record (every skip made before
 * the fields existed) and an aborted plan with no cause count as
 * `unrecorded`, never guessed. A cycle an abort skipped (`changeKind:
 * "abort"`) is counted once, as the plan's abort, never again as a change.
 * Null when the release has no members.
 */
export function planChanges(input: PlanChangesInput): PlanChangesPayload | null {
  const members = new Set(
    input.entries.filter((entry) => entry.release === input.release).map((entry) => entry.cr),
  );
  if (members.size === 0) return null;
  const changes = emptyCounts();
  const aborts = emptyCounts();
  for (const plan of input.plans) {
    if (!members.has(plan.cr)) continue;
    if (plan.status === "aborted") aborts[plan.cause ?? "unrecorded"] += 1;
    for (const cycle of plan.cycles) {
      if (cycle.changeKind === "abort") continue;
      if (cycle.changeKind !== undefined || cycle.status === "skipped") {
        changes[cycle.cause ?? "unrecorded"] += 1;
      }
    }
  }
  return { release: input.release, changes, aborts };
}
