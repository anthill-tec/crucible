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
/** One calendar week — the iteration (DN §5: Crucible has no sprints). */
export const WEEK_MS = 7 * DAY_MS;
/** DN §5 — the displayed velocity is the mean of the last 3 completed weeks. */
export const VELOCITY_WINDOW_WEEKS = 3;
/** DN §7 — the Monte Carlo's draw count. */
export const FORECAST_DRAWS = 1000;
/**
 * A draw's safety stop, in simulated weeks. Unreachable in practice — the
 * history always holds at least one positive week, so every draw terminates —
 * but a loop over sampled values must never be able to spin forever.
 */
const MAX_SIMULATED_WEEKS = 10_000;

/**
 * The calendar week an instant falls in: its Monday 00:00 UTC (ISO-8601
 * weeks). The CR/DN pin no convention; ISO's Monday start is the one a week
 * label (`YYYY-MM-DD` of that Monday) reads unambiguously.
 */
export function weekStart(ts: number): number {
  const day = new Date(ts);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS;
}

function weekLabel(start: number): string {
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
 * The project's pointed velocity, per COMPLETED calendar week. `weeks` holds
 * only the weeks a pointed merge landed in (§S2 AC1). `history` is the
 * calendar series from the first pointed merge's week to the last completed
 * week — a week inside it with no merge is a real zero; weeks before the
 * first pointed merge are absent, not zero (DN §5).
 */
interface WeeklyVelocity {
  weeks: Array<{ week: string; points: number }>;
  history: number[];
}

function weeklyVelocity(
  merged: Map<string, number>,
  points: Map<string, number>,
  now: number,
): WeeklyVelocity {
  const currentWeek = weekStart(now);
  const byWeek = new Map<number, number>();
  for (const [cr, at] of merged) {
    const declared = points.get(cr);
    if (declared === undefined) continue; // unpointed: never counted as 1
    const week = weekStart(at);
    if (week >= currentWeek) continue; // the open week is not completed
    byWeek.set(week, (byWeek.get(week) ?? 0) + declared);
  }
  const starts = [...byWeek.keys()].sort((a, b) => a - b);
  const weeks = starts.map((start) => ({ week: weekLabel(start), points: byWeek.get(start)! }));
  const history: number[] = [];
  if (starts.length > 0) {
    for (let week = starts[0]!; week < currentWeek; week += WEEK_MS) {
      history.push(byWeek.get(week) ?? 0);
    }
  }
  return { weeks, history };
}

function pointsByCr(entries: QueueEntry[]): Map<string, number> {
  const points = new Map<string, number>();
  for (const entry of entries) {
    if (entry.points !== undefined) points.set(entry.cr, entry.points);
  }
  return points;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// ── §S2 — velocity ────────────────────────────────────────────────────────

export interface VelocityInput {
  plans: Plan[];
  entries: QueueEntry[];
  /** `exec(c)` per cycle id — Σ duration_ms of its cycle-linked runs. */
  execByCycle: Map<number, number>;
  now: number;
}

export interface VelocityPayload {
  /** Absent while no completed week has pointed velocity — never a fabricated 0. */
  pointsPerWeek?: number;
  weeks: Array<{ week: string; points: number }>;
  sampleWeeks: number;
  flow: { execMsPerCycle?: number; gateMsPerCycle?: number; sampleCycles: number };
}

/**
 * §S2 — `pointsPerWeek` is the mean over the last 3 COMPLETED calendar weeks
 * (fewer while the history is younger; `sampleWeeks` says how many). `flow`
 * keeps DN §3's two clocks per sealed cycle — exec = Σ its cycle-linked runs,
 * gate = loop − exec floored at 0 — reported beside velocity, never summed
 * into it.
 */
export function velocity(input: VelocityInput): VelocityPayload {
  const merged = mergedAtByCr(input.plans);
  const { weeks, history } = weeklyVelocity(merged, pointsByCr(input.entries), input.now);
  const window = history.slice(-VELOCITY_WINDOW_WEEKS);

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
    ...(window.length > 0 ? { pointsPerWeek: mean(window) } : {}),
    weeks,
    sampleWeeks: window.length,
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
  const members = new Set<string>();
  for (const entry of input.entries) {
    if (entry.release === release) members.add(entry.cr);
  }
  for (const row of input.journal) {
    const moved = releaseChange(row);
    if (moved !== undefined && (moved.from === release || moved.to === release)) {
      members.add(row.cr);
    }
  }
  if (members.size === 0) return null;

  const merged = mergedAtByCr(input.plans);
  const standings = new Map<string, CrStanding>();
  const events: ReplayEvent[] = [];
  let start = Number.POSITIVE_INFINITY;
  let startCr: string | undefined;

  for (const cr of members) {
    const entry = entryByCr.get(cr);
    const rows = rowsByCr.get(cr) ?? [];
    const filedAt = input.filedAt.get(cr);
    if (filedAt !== undefined && filedAt < start) {
      start = filedAt;
      startCr = cr;
    }
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

  const points: BurndownStep[] = [
    { ts: start, remaining: committed, event: "start", cr: startCr ?? [...members][0]!, delta: 0 },
    ...steps,
  ];

  return {
    release,
    committedPoints: committed,
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
  sampleWeeks: number;
  status: "ok" | "insufficient_history" | "unpointed";
  /** The release's live, unmerged crs that carry no points. Absent when none. */
  unpointed?: string[];
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * §S4 — Monte Carlo over the project's weekly pointed velocity (DN §7): each
 * of 1,000 draws samples whole weeks uniformly from the empirical weekly
 * history until the release's remaining points reach 0, completing that many
 * weeks from `now`. P50/P80 of those instants.
 *
 * Gates, both with NO band values: fewer than 3 completed weeks of history →
 * `insufficient_history`; any live, unmerged cr unpointed → `unpointed`,
 * naming them (`unpointed` is carried whenever such a cr exists, so the band
 * can say why). `scheduleHealth` only against a declared target (DN §8).
 */
export function forecast(input: ForecastInput): ForecastPayload {
  const merged = mergedAtByCr(input.plans);
  const { history } = weeklyVelocity(merged, pointsByCr(input.entries), input.now);
  const remaining = input.entries.filter(
    (entry) => entry.release === input.release && !isDeadCr(entry) && !merged.has(entry.cr),
  );
  const unpointed = remaining.filter((entry) => entry.points === undefined).map((entry) => entry.cr);
  const remainingPoints = remaining.reduce((sum, entry) => sum + (entry.points ?? 0), 0);
  const base = {
    release: input.release,
    remainingPoints,
    sampleWeeks: history.length,
    ...(unpointed.length > 0 ? { unpointed } : {}),
  };
  if (history.length < VELOCITY_WINDOW_WEEKS) return { ...base, status: "insufficient_history" };
  if (unpointed.length > 0) return { ...base, status: "unpointed" };

  const completions: number[] = [];
  for (let draw = 0; draw < FORECAST_DRAWS; draw += 1) {
    let burned = 0;
    let weeks = 0;
    while (burned < remainingPoints && weeks < MAX_SIMULATED_WEEKS) {
      burned += history[Math.floor(input.random() * history.length)]!;
      weeks += 1;
    }
    completions.push(input.now + weeks * WEEK_MS);
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
