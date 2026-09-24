// CR-CRU-098 §S1 — the `next` pointer, resolved on the server.
//
// A PURE function over `(entries, tracks, {track, release, wave})`: the
// entries arrive in `listQueue`'s PUBLISHED order (CR-CRU-095 §S1) and are
// consumed in that order — this module never re-orders them and never compares
// one `seq` against another (AC1). Ported from the client's `resolve_next`
// block with its semantics preserved exactly (CR-CRU-092, -095, -108); its
// `help[]` wording lives in `src/hints.ts` beside every other v2 hint.
import { nextHints } from "./hints.ts";
import { normalizeTrack } from "./store.ts";
import type { QueueEntry, QueueLifecycle } from "./types.ts";

/** §S2 — the four HOLD trigger kinds, in their fixed precedence. */
export const HOLD_TRIGGER_KINDS: readonly string[] = ["in-flight", "dead-dependency", "dependency", "unknown-dependency"];

/** §S2 — the three DRAINED reasons. */
export const DRAINED_REASONS: readonly string[] = ["wave-complete", "awaiting-assignment", "no-roadmap"];

type DrainedReason = "wave-complete" | "awaiting-assignment" | "no-roadmap";

/** The process exit code of the multi-track usage refusal (the client's `EXIT_USAGE`). */
const EXIT_USAGE = 2;

/**
 * A CR has LANDED iff its server-derived status is one of these
 * (`deriveQueueStatus`). Anything else — PENDING, IN_PROGRESS — is unmerged.
 */
const LANDED_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "COMPLETED_UNTRACKED"]);

export type NextTrigger =
  | { kind: "in-flight"; cr: string }
  | { kind: "dead-dependency"; cr: string; state: string; by?: string }
  | { kind: "dependency"; blockedBy: Array<{ cr: string; status: string }> }
  | { kind: "unknown-dependency"; cr: string };

export interface NextWarning {
  code: string;
  detail: string;
}

export interface NextScope {
  track?: string | undefined;
  release?: string | undefined;
  wave?: string | undefined;
}

export interface NextResult {
  /** false only for the multi-track refusal; every decision is an answer. */
  ok: boolean;
  /** The client's process exit code: 0 for every decision, 2 for the refusal. */
  code: number;
  fields: Record<string, unknown>;
  warnings: NextWarning[];
}

/**
 * §S2/§S3 (PURE) — the decision resolver: the lane's published sequence plus
 * live state in, exactly one decision out. `release` and `wave` are
 * CONTAINERS matched VERBATIM; `track` is SCHEDULING and keeps the server's
 * own lane rule (`normalizeTrack`). `tracks` is the project's declared lanes
 * (`declaredTracks`), handed in rather than derived here.
 */
export function resolveNext(entries: readonly QueueEntry[], tracks: readonly string[], scope: NextScope): NextResult {
  const { track, release, wave } = scope;
  const wanted = canonicalTrack(track);

  // §S3 — track scoping is required only when the DATA justifies it; with more
  // than one lane the pointer refuses to guess and names the live lanes.
  if (tracks.length > 1 && (wanted === null || !tracks.some((t) => canonicalTrack(t) === wanted))) {
    return {
      ok: false,
      code: EXIT_USAGE,
      fields: {
        needs: ["track"],
        tracks: [...tracks],
        totalCount: tracks.length,
        help: nextHints.needsTrack(tracks),
      },
      warnings: [],
    };
  }

  // The CONTAINER, resolved before any lane is chosen and never from the lane.
  const scoped = release === undefined ? [...entries] : entries.filter((e) => e.release === release);
  const resolvedWave = waveOfTheLane(scoped, wave);
  const container = resolvedWave === undefined ? scoped : scoped.filter((e) => e.wave === resolvedWave);

  // The lane is consumed in the order the server PUBLISHED.
  const lane = wanted === null ? container : container.filter((e) => canonicalTrack(e.track) === wanted);
  const resolvedTrack = tracks.length > 1 ? wanted : null;
  const laneFields = laneFieldsOf(release, resolvedWave, resolvedTrack);
  const announced = boundaryAnnouncement(scoped, container, resolvedWave);

  const warnings: NextWarning[] = [];
  const unpositioned = lane.filter((e) => entrySeq(e) === undefined).map((e) => e.cr);
  if (unpositioned.length > 0) {
    warnings.push({
      code: "missing-seq",
      detail:
        `the queue published no seq for ${unpositioned.join(", ")} — the roadmap declares ` +
        `one on every entry, so this is a roadmap defect; re-run wave-sequence for its wave`,
    });
  }

  const answer = (fields: Record<string, unknown>): NextResult => ({ ok: true, code: 0, fields, warnings });

  if (entries.length === 0) {
    return answer(drainedAnswer("no-roadmap", lane, laneFields, announced));
  }
  if (container.length === 0) {
    // Nothing is SCHEDULED here — which is not the claim that a wave finished.
    return answer(drainedAnswer("awaiting-assignment", lane, laneFields, announced));
  }
  if (!container.some(isActionable)) {
    // A MEMBERSHIP claim, read off the container alone: the wave is finished.
    return answer(
      drainedAnswer("wave-complete", container, laneFields, announced, nextPublishedWave(scoped, resolvedWave)),
    );
  }

  const actionable = lane.filter(isActionable);
  const target = actionable[0];
  if (target === undefined) {
    // The wave still holds actionable work — a sibling lane's, or unscheduled.
    return answer(drainedAnswer("awaiting-assignment", lane, laneFields, announced));
  }

  const targetFields = laneFieldsOf(release, resolvedWave, resolvedTrack, target);
  const { trigger, warnings: triggerWarnings } = nextTrigger(target, lane, entries);
  warnings.push(...triggerWarnings);
  if (trigger === null) {
    return answer(nextAnswer(target, targetFields, announced));
  }

  const fields: Record<string, unknown> = { decision: "HOLD", cr: target.cr };
  const seq = entrySeq(target);
  if (seq !== undefined) fields.seq = seq;
  Object.assign(fields, targetFields);
  announcedFields(fields, announced);
  fields.trigger = trigger;
  fields.help = nextHints.hold(trigger);
  return answer(fields);
}

// ── helpers ───────────────────────────────────────────────────────────────

/** The server's lane rule over an optional value: no value names no lane. */
function canonicalTrack(value: string | undefined): string | null {
  return value ? normalizeTrack(value) : null;
}

/** The DECLARED position, or undefined when the row published none. */
function entrySeq(entry: QueueEntry): number | undefined {
  const seq: unknown = entry.seq;
  return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}

/**
 * §S2 — the TWO axes: `PENDING` on the derived status axis AND no `lifecycle`
 * disposition at all. Keyed on the lifecycle's PRESENCE, exactly as the
 * ported resolver keyed it — deliberately not `isDeadCr`, which judges the
 * lifecycle's `state` value rather than its presence. Unifying the two
 * predicates is CR-CRU-147's to do (see `isDeadCr`, src/types.ts) — until
 * then `next` draws the line here, on presence.
 */
function isActionable(entry: QueueEntry): boolean {
  return entry.status === "PENDING" && entry.lifecycle === undefined;
}

/** A lifecycle disposition carried as an object (the resolver's `dict` test). */
function lifecycleOf(entry: QueueEntry): QueueLifecycle | null {
  const lifecycle: unknown = entry.lifecycle;
  return typeof lifecycle === "object" && lifecycle !== null ? (lifecycle as QueueLifecycle) : null;
}

/** The rows declared dead, named with their state and successor. */
function deadEntries(rows: readonly QueueEntry[]): Array<{ cr: string; state: string; by?: string }> {
  const dead: Array<{ cr: string; state: string; by?: string }> = [];
  for (const row of rows) {
    const lifecycle = lifecycleOf(row);
    if (lifecycle === null) continue;
    dead.push({ cr: row.cr, state: lifecycle.state, ...(lifecycle.by ? { by: lifecycle.by } : {}) });
  }
  return dead;
}

/**
 * §S2 (PURE) — the ONE cause holding `target`, or null. Evaluated in the fixed
 * order: in-flight, dead-dependency, dependency, unknown-dependency.
 * Occupancy is scoped to the LANE; dependencies resolve across the WHOLE queue.
 */
function nextTrigger(
  target: QueueEntry,
  lane: readonly QueueEntry[],
  entries: readonly QueueEntry[],
): { trigger: NextTrigger | null; warnings: NextWarning[] } {
  const running = lane.find((e) => e.status === "IN_PROGRESS");
  if (running !== undefined) {
    return { trigger: { kind: "in-flight", cr: running.cr }, warnings: [] };
  }

  const byCr = new Map<string, QueueEntry>();
  for (const e of entries) if (e.cr) byCr.set(e.cr, e);
  const dead: Array<{ cr: string; lifecycle: QueueLifecycle }> = [];
  const blockedBy: Array<{ cr: string; status: string }> = [];
  const unknown: string[] = [];
  for (const dep of target.dependsOn ?? []) {
    const entry = byCr.get(dep);
    if (entry === undefined) {
      unknown.push(dep);
      continue;
    }
    // The status axis decides LANDED first.
    if (LANDED_STATUSES.has(entry.status)) continue;
    const lifecycle = lifecycleOf(entry);
    if (lifecycle !== null) dead.push({ cr: dep, lifecycle });
    else blockedBy.push({ cr: dep, status: entry.status });
  }

  const warnings: NextWarning[] = [];
  if (unknown.length > 0) {
    warnings.push({
      code: "unknown-dependency",
      detail:
        `${target.cr} declares a dependsOn the queue does not hold: ${unknown.join(", ")} — ` +
        `a roadmap authored forwards reads back this way until the dep is filed with cr-plan`,
    });
  }

  const firstDead = dead[0];
  if (firstDead !== undefined) {
    const trigger: NextTrigger = { kind: "dead-dependency", cr: firstDead.cr, state: firstDead.lifecycle.state };
    if (firstDead.lifecycle.by) trigger.by = firstDead.lifecycle.by;
    return { trigger, warnings };
  }
  if (blockedBy.length > 0) return { trigger: { kind: "dependency", blockedBy }, warnings };
  const firstUnknown = unknown[0];
  if (firstUnknown !== undefined) return { trigger: { kind: "unknown-dependency", cr: firstUnknown }, warnings };
  return { trigger: null, warnings };
}

/**
 * The CONTAINER an answer is about: its release when one is in scope (or the
 * answer's own row declares one), its wave, and its track only when the
 * project declares more than one lane. Absent, never null or defaulted.
 */
function laneFieldsOf(
  release: string | undefined,
  wave: string | undefined,
  track: string | null,
  entry?: QueueEntry,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const declared = release || entry?.release;
  if (declared) fields.release = declared;
  if (wave) fields.wave = wave;
  if (track) fields.track = track;
  return fields;
}

/** §S2 — the boundary statement, ABSENT rather than empty when there is none. */
function announcedFields(fields: Record<string, unknown>, announced: string | undefined): Record<string, unknown> {
  if (announced) fields.waveCompleted = announced;
  return fields;
}

function nextAnswer(
  entry: QueueEntry,
  laneFields: Record<string, unknown>,
  announced: string | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { decision: "NEXT", cr: entry.cr };
  const seq = entrySeq(entry);
  if (seq !== undefined) fields.seq = seq;
  Object.assign(fields, laneFields);
  announcedFields(fields, announced);
  fields.help = nextHints.start(entry.cr, entry.wave);
  return fields;
}

/** `rows` is the set the reason is a claim about — named in help[] when dead. */
function drainedAnswer(
  reason: DrainedReason,
  rows: readonly QueueEntry[],
  laneFields: Record<string, unknown>,
  announced: string | undefined,
  nextWave?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { decision: "DRAINED", reason };
  Object.assign(fields, laneFields);
  announcedFields(fields, announced);
  fields.help = nextHints.drained(reason, deadEntries(rows), nextWave);
  return fields;
}

/**
 * §S2 (PURE) — the ONE wave an answer is about: an explicit wave, else the
 * wave of the first ACTIONABLE row in published order, else the last wave
 * published. A row whose wave is "" is in no wave and resolves none.
 */
function waveOfTheLane(scoped: readonly QueueEntry[], wave: string | undefined): string | undefined {
  if (wave !== undefined) return wave;
  let published: string | undefined;
  for (const entry of scoped) {
    const declared = entry.wave;
    if (!declared) continue;
    if (isActionable(entry)) return declared;
    published = declared;
  }
  return published;
}

/** §S2 (PURE) — the previous DISTINCT published wave label, verbatim. */
function previousPublishedWave(scoped: readonly QueueEntry[], wave: string | undefined): string | undefined {
  if (wave === undefined) return undefined;
  let previous: string | undefined;
  for (const entry of scoped) {
    const declared = entry.wave;
    if (!declared) continue;
    if (declared === wave) return previous;
    previous = declared;
  }
  return undefined;
}

/** §S2 (PURE) — the next distinct published wave label after the resolved one. */
function nextPublishedWave(scoped: readonly QueueEntry[], wave: string | undefined): string | undefined {
  if (wave === undefined) return undefined;
  let reached = false;
  for (const entry of scoped) {
    const declared = entry.wave;
    if (!declared) continue;
    if (declared === wave) reached = true;
    else if (reached) return declared;
  }
  return undefined;
}

/**
 * §S2 (PURE) — the predecessor wave this read PROVES has completed: it holds no
 * actionable entry AND the resolved wave has landed nothing yet. Scoped to the
 * container asked about (the release narrowing).
 */
function boundaryAnnouncement(
  scoped: readonly QueueEntry[],
  container: readonly QueueEntry[],
  wave: string | undefined,
): string | undefined {
  const predecessor = previousPublishedWave(scoped, wave);
  if (predecessor === undefined) return undefined;
  if (scoped.some((e) => e.wave === predecessor && isActionable(e))) return undefined;
  if (container.some((e) => LANDED_STATUSES.has(e.status))) return undefined;
  return predecessor;
}
