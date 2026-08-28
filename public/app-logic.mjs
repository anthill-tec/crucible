// CR-CRU-006 §S3/§S4 — pure app-logic for the Crucible v2 SPA.
// ES module (no build step): imported directly by tests, and attached to
// `window.CrucibleLogic` for the nomodule VanJS shell (app.js) to consume.
// Shapes documented in tests/app-logic.d.ts.

/** Chip / agent-row filtering — projectKey and agentId apply as AND. */
export function filterEvents(events, filters) {
  return events.filter((e) => {
    if (filters.projectKey !== undefined && filters.projectKey !== null) {
      if (e.projectKey !== filters.projectKey) return false;
    }
    if (filters.agentId !== undefined && filters.agentId !== null) {
      if (e.agentId !== filters.agentId) return false;
    }
    return true;
  });
}

/** Storyboard card labels — "just now" under 10s, then s/m/h/d tiers. */
export function relativeTime(ts, now) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * CR-CRU-091 §S1/AC3 — the ONE way a git-sourced release date is rendered.
 *
 * Takes epoch SECONDS, the unit BOTH `releasedAt` (a tag's own commit date)
 * and `targetAt` (a proposal's declared target) are stored in, and answers the
 * UTC day as ISO `YYYY-MM-DD` — the same day form `coverageHeatSlices` already
 * uses below and the storyboard's gate dates use. A day, because that is what
 * a release date is: no clock component, and no locale, which would render one
 * ledger differently per viewer.
 *
 * Two conventions on one surface renders 1970: `releasedAt = 1787149125` is
 * 2026-08-19 in seconds and 1970-01-21 read as milliseconds. So no call site
 * constructs a date from either field itself — it calls this.
 *
 * An ABSENT or unusable value renders the EMPTY STRING, never a date: an
 * undeclared `targetAt` has no day to show, and conjuring 1970-01-01 out of it
 * would be the very lie this formatter exists to prevent. A real 0 is still a
 * real date.
 */
export function formatReleaseDate(epochSeconds) {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Agent rail dot + tombstone marker. tombstoned carries diedAgo from lastSeen. */
export function livenessGlyph(agent) {
  if (agent.liveness === "tombstoned") {
    return {
      cls: "o",
      tombstone: true,
      diedAgo: relativeTime(agent.lastSeen, Date.now()),
    };
  }
  return { cls: agent.liveness === "online" ? "g" : "y", tombstone: false };
}

/** §S2 hash-free History routing. Unknown paths fall back to home. */
export function routeParse(pathname) {
  const parts = pathname.split("/").filter((p) => p.length > 0);
  let overlay;
  if (parts.length >= 2 && parts[parts.length - 2] === "run") {
    overlay = decodeURIComponent(parts.pop());
    parts.pop();
  }
  // CR-CRU-014 §S3 — /p/<key>/roadmap: the Roadmap is a workspace TAB, not an
  // overlay, so the trailing `roadmap` segment rides on the workspace route
  // as a tab hint (mirrors how /run/<id> rides as `overlay`).
  let roadmap = false;
  if (parts[0] === "p" && parts.length >= 3 && parts[2] === "roadmap") {
    roadmap = true;
  }
  if (parts[0] === "p" && parts.length >= 2) {
    const route = { page: "workspace", projectKey: decodeURIComponent(parts[1]) };
    if (overlay !== undefined) route.overlay = overlay;
    if (roadmap) route.roadmap = true;
    return route;
  }
  const route = { page: "home" };
  // CR-CRU-012 §S2 — /manage: home renders BENEATH, the Projects manager
  // slide-over above (same overlay-composition shape as /run/<id>).
  if (parts[0] === "manage") route.manage = true;
  if (overlay !== undefined) route.overlay = overlay;
  return route;
}

// CR-CRU-007 §S5.2 — Agents dropped: agents nest under the workspace's
// Project pane instead of owning a tab.
// CR-CRU-076 §S1 — Roadmap LEADS the band (fixed order
// "Roadmap · Workflow · Runs · Coverage · Compile · BDD"): a project begins
// with roadmap creation — the CR backlog is registered up front, at design
// time — while Workflow is the RUNTIME view of that roadmap executing, so
// the origin document leads and the runtime views follow. Supersedes
// CR-CRU-021 §S1 AC1 (Workflow-first), which predated the Roadmap tab;
// CR-CRU-021 §S1 AC2 (the workspace LANDS on the Workflow pane) is
// untouched — the landing is hard-coded, never TAB_NAMES[0]. Workflow is
// still NEVER gated — enabled for both project types, same as Runs/Compile.
const TAB_NAMES = ["Roadmap", "Workflow", "Runs", "Coverage", "Compile", "BDD"];

/**
 * §S4 workspace tabs — fixed order; BDD disabled unless frontend project.
 * §S1 addendum (CR-CRU-007): the Coverage tab gates like BDD — disabled with
 * a hint until the project has green-regression coverage data
 * (`latestCoverageEventId` present, same field the v2 projects listing
 * emits), enabled once it exists.
 */
export function workspaceTabs(project) {
  return TAB_NAMES.map((name) => {
    if (name === "Coverage") {
      const hasCoverage =
        project.latestCoverageEventId !== undefined &&
        project.latestCoverageEventId !== null;
      return hasCoverage
        ? { name, disabled: false }
        : { name, disabled: true, hint: "coverage lands with the first green regression" };
    }
    return {
      name,
      disabled: name === "BDD" && project.type !== "frontend",
    };
  });
}

/**
 * CR-CRU-044 §S2 / CR-CRU-057 §S3 — classify by the STORED role, and by
 * nothing else. A declared role (the agent's own, or the one stamped onto
 * the event at ingest, §S1) is the ONLY classification input: when `role` is
 * present (non-null, non-undefined) it decides, including when it maps to no
 * tint ("ORCHESTRATOR"/"report" render neutral) or is unrecognized. When no
 * role is declared the result is unclassified (null) — CR-CRU-057 deleted
 * the id-shape fallback outright, so a name NEVER resolves a role.
 *
 * CR-CRU-059 §S0 — the field is `role` fleet-wide; `agentRole()` keeps its
 * name, which was correct from the start.
 */
const ROLE_TINTS = {
  RED: "red",
  GREEN: "green",
  FIX: "fix",
  VERIFY: "verify",
  ORCHESTRATOR: null,
  report: null,
};

export function agentRole(agent) {
  const role = agent?.role;
  if (role === undefined || role === null) return null;
  return Object.prototype.hasOwnProperty.call(ROLE_TINTS, role)
    ? ROLE_TINTS[role]
    : null;
}

/** Project rollup card sub-label. */
export function projectRollupLabel(project) {
  const last = project.lastEvent;
  if (last === null || last === undefined) return "no runs yet";
  const rel = relativeTime(last.timestamp, Date.now());
  if (last.failed > 0) return `✗ ${last.failed} failed of ${last.total} · ${rel}`;
  return `✓ green · ${last.passed}/${last.total} · ${rel}`;
}

/**
 * CR-CRU-007 §S5.1 — activity state rule (user-locked round 13, pure).
 * A project is `active` while it has ≥1 live (online/stale) agent; with none
 * left it turns `inactive` once now − lastActivity EXCEEDS the timeout.
 * `lastActivity` = max(project's last event timestamp, agents' last-seen).
 */
export function projectActivity(project, now, inactiveMs) {
  const agents = project.agents ?? [];
  let lastActivity = project.lastEventAt ?? 0;
  for (const agent of agents) {
    if (agent.lastSeen > lastActivity) lastActivity = agent.lastSeen;
  }
  const hasLiveAgent = agents.some(
    (a) => a.liveness === "online" || a.liveness === "stale",
  );
  const active = hasLiveAgent || now - lastActivity <= inactiveMs;
  return { active, lastActivity };
}

/**
 * CR-CRU-007 §S5.1 — projects-row badge ordering: most-recently-active
 * first, inactive last (each group by lastActivity descending). Pure — never
 * mutates the input array.
 */
export function orderProjects(projects) {
  return [...projects].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
}

/** Storyboard F1 empty states — no-projects wins over no-runs. */
export function emptyStates(state) {
  if (state.projects.length === 0) return { kind: "no-projects" };
  if (state.events.length === 0) return { kind: "no-runs" };
  return null;
}

/**
 * CR-CRU-007 §S2 (re-baselined, STREAK-BASED) — RED→GREEN transition markers
 * (= Cycles), pure pairing. Same projectKey + same agent stem (agentId with a
 * trailing -RED|-GREEN|-FIX suffix stripped, case-insensitive), runs
 * timestamp-ordered: ONE marker per MAXIMAL failing streak closed by its
 * FIRST subsequent passing run within 24h of the streak's FIRST fail. The
 * marker's RED counts come from the streak's FIRST failing run; intermediate
 * failing runs are absorbed into the same cycle (never paired separately);
 * pass-after-pass never creates a marker. Input order agnostic; never
 * mutates the input array.
 */
export function pairTransitions(events) {
  const CYCLE_WINDOW_MS = 24 * 60 * 60 * 1000;
  const stemRaw = (agentId) => String(agentId).replace(/-(RED|GREEN|FIX)$/i, "");
  const stemKey = (agentId) => stemRaw(agentId).toLowerCase();
  const sorted = events
    .filter((e) => e.kind === "test")
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const markers = [];
  // projectKey + stem -> the FIRST failing run of the currently-open streak.
  const openStreaks = new Map();
  for (const event of sorted) {
    const groupKey = `${event.projectKey} ${stemKey(event.agentId)}`;
    if (event.failed > 0) {
      // A failing run opens a streak (or is absorbed into the open one).
      if (!openStreaks.has(groupKey)) openStreaks.set(groupKey, event);
      continue;
    }
    // A passing run always CLOSES the group's open streak; it only yields a
    // marker when it lands within 24h of the streak's first fail. A pass
    // with no open streak (pass-after-pass) pairs nothing.
    const firstFail = openStreaks.get(groupKey);
    if (firstFail === undefined) continue;
    openStreaks.delete(groupKey);
    if (event.timestamp - firstFail.timestamp > CYCLE_WINDOW_MS) continue;
    markers.push({
      redEvent: firstFail,
      greenEvent: event,
      projectKey: firstFail.projectKey,
      stem: stemRaw(firstFail.agentId),
    });
  }
  return markers;
}

// CR-CRU-007 §S4.0 (round-10 revision) — tier-default drill-in mode.
// The BROAD tier group (regression, e2e) opens in Density; every other tier
// (unit / module / integration — the focused cycle runs) opens in Detail.
// Single-argument on purpose: NO code path selects the mode from test count.
const BROAD_TIERS = new Set(["regression", "e2e"]);

/** §S4.0 — contextual default: "Density" for broad tiers, else "Detail". */
export function drillinDefaultMode(tier) {
  return BROAD_TIERS.has(tier) ? "Density" : "Detail";
}

// CR-CRU-007 §S4.0 FINAL re-baseline: the mode badge/switch is removed
// entirely — presentation is purely tier-contextual, so there is nothing to
// persist and no storage-key helper anymore.

// CR-CRU-007 §S4.1 — failures float / green folds (pure). Returns the names
// of suites (input order) whose status is "fail" — the suites Density mode
// auto-expands. A 0-failure run returns [] (every suite folds); "pending" is
// NOT "fail", so pending-only suites fold too.
export function foldSuites(suites) {
  return suites.filter((s) => s.status === "fail").map((s) => s.name);
}

// CR-CRU-007 §S4.3 — failure digest (pure). Groups 2+ failed leaves sharing
// an IDENTICAL failure.message into one {kind:"group"} entry (placed at the
// first grouped leaf's position, leaves in input order, extraCount =
// leaves.length - 1 — the "+N identical" label count); every other leaf
// (pass, pending, or a uniquely-failing leaf) passes through as
// {kind:"leaf", leaf} in input order. Never mutates the input.
export function digestFailures(leaves) {
  const messageCounts = new Map();
  for (const leaf of leaves) {
    const message = leaf.status === "fail" ? leaf.failure?.message : undefined;
    if (typeof message === "string") {
      messageCounts.set(message, (messageCounts.get(message) ?? 0) + 1);
    }
  }
  const groupsByMessage = new Map();
  const entries = [];
  for (const leaf of leaves) {
    const message = leaf.status === "fail" ? leaf.failure?.message : undefined;
    if (typeof message === "string" && (messageCounts.get(message) ?? 0) >= 2) {
      let group = groupsByMessage.get(message);
      if (group === undefined) {
        group = { kind: "group", message, leaves: [], extraCount: 0 };
        groupsByMessage.set(message, group);
        entries.push(group);
      }
      group.leaves.push(leaf);
      group.extraCount = group.leaves.length - 1;
    } else {
      entries.push({ kind: "leaf", leaf });
    }
  }
  return entries;
}

// ── CR-CRU-028 §S1 — auto-coarsening level-colored coverage-trend buckets ──

/** DN §3.2 coverage ramp thresholds (pinned): orange < 65, yellow [65,80),
 * green >= 80. */
export const COVERAGE_LEVEL_ORANGE_MAX = 65;
export const COVERAGE_LEVEL_YELLOW_MAX = 80;

/** DN §3.2 — orange/yellow/green ramp classification for a coverage percent. */
export function coverageLevelClass(percent) {
  if (percent < COVERAGE_LEVEL_ORANGE_MAX) return "orange";
  if (percent < COVERAGE_LEVEL_YELLOW_MAX) return "yellow";
  return "green";
}

/**
 * CR-CRU-028 §S1 — coarsen a date-keyed { day, percent }[] series (oldest→
 * newest) into ≤16 zoom-level bucket bars. `daysAgo` is measured relative to
 * the series' OWN most-recent day (MAX day — deterministic, not wall-clock):
 *   daysAgo < 7            → DAY bucket   (bucketKey = the "YYYY-MM-DD" day)
 *   7 <= daysAgo < 63      → WEEK bucket  (bucketKey = `week-${floor((daysAgo-7)/7)}`)
 *   daysAgo >= 63          → MONTH bucket (bucketKey = `month-${day.slice(0,7)}`)
 * Each bucket's representative { day, percent } is the point with the SMALLEST
 * daysAgo in it (most-recent wins). Buckets are ordered oldest→newest by
 * representative day and capped to the most-recent 16 (oldest dropped first).
 * `isLatest` is true for exactly the final bucket. `level` is the zoom level
 * (day/week/month), driving the per-level width class in the render.
 */
export function coarsenCoverageTrend(points) {
  const series = points ?? [];
  if (series.length === 0) return [];
  let latestDay = series[0].day;
  for (const p of series) if (p.day > latestDay) latestDay = p.day;
  const latestMs = Date.parse(`${latestDay}T00:00:00.000Z`);
  const buckets = new Map();
  for (const p of series) {
    const dayMs = Date.parse(`${p.day}T00:00:00.000Z`);
    const daysAgo = Math.round((latestMs - dayMs) / 86_400_000);
    let level;
    let bucketKey;
    if (daysAgo < 7) {
      level = "day";
      bucketKey = p.day;
    } else if (daysAgo < 63) {
      level = "week";
      bucketKey = `week-${Math.floor((daysAgo - 7) / 7)}`;
    } else {
      level = "month";
      bucketKey = `month-${p.day.slice(0, 7)}`;
    }
    const existing = buckets.get(bucketKey);
    if (existing === undefined || daysAgo < existing.daysAgo) {
      buckets.set(bucketKey, { level, bucketKey, day: p.day, percent: p.percent, daysAgo });
    }
  }
  const ordered = [...buckets.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const capped = ordered.slice(-16);
  return capped.map((b, i) => ({
    level: b.level,
    bucketKey: b.bucketKey,
    day: b.day,
    percent: b.percent,
    isLatest: i === capped.length - 1,
  }));
}

/** CR-CRU-028 §S2 — the top-level bucketKey a raw point folds into, using the
 * SAME day/week/month classification `coarsenCoverageTrend` applies against
 * the whole series' latest day (`latestMs`). */
function topBucketKey(day, latestMs) {
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  const daysAgo = Math.round((latestMs - dayMs) / 86_400_000);
  if (daysAgo < 7) return day;
  if (daysAgo < 63) return `week-${Math.floor((daysAgo - 7) / 7)}`;
  return `month-${day.slice(0, 7)}`;
}

/**
 * CR-CRU-028 §S2 — produce the finer bars hidden inside an ALREADY-SCOPED
 * subset of raw `{ day, percent }` points, given the `parentLevel` of the
 * bucket/bar being unfolded (oldest→newest):
 *   month → WEEK bars: the subset grouped into 7-day windows RE-ANCHORED to
 *     the subset's own most-recent day (representative = the most-recent
 *     point in each window).
 *   week  → DAY bars: one bar per raw point in the subset, verbatim.
 *   day   → [] (a day unfolds to a per-run heat strip, not finer bars).
 * Each finer bar's `level` is forced to the next-finer zoom level regardless
 * of its own age, and carries `members` — the raw points it groups — so the
 * drill-down accordion can CASCADE (unfold a revealed bar one level deeper by
 * re-scoping onto its `members`, DN §3.3 continuous drill).
 */
function finerBarsOf(subset, parentLevel) {
  if (subset.length === 0) return [];
  const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  if (parentLevel === "week") {
    return subset
      .slice()
      .sort(byDay)
      .map((p) => ({ level: "day", day: p.day, percent: p.percent, members: [p] }));
  }
  if (parentLevel === "month") {
    let subLatest = subset[0].day;
    for (const p of subset) if (p.day > subLatest) subLatest = p.day;
    const subLatestMs = Date.parse(`${subLatest}T00:00:00.000Z`);
    const windows = new Map();
    for (const p of subset) {
      const dayMs = Date.parse(`${p.day}T00:00:00.000Z`);
      const daysAgo = Math.round((subLatestMs - dayMs) / 86_400_000);
      const win = Math.floor(daysAgo / 7);
      const existing = windows.get(win);
      if (existing === undefined) {
        windows.set(win, { rep: { day: p.day, percent: p.percent, daysAgo }, members: [p] });
      } else {
        existing.members.push(p);
        if (daysAgo < existing.rep.daysAgo) {
          existing.rep = { day: p.day, percent: p.percent, daysAgo };
        }
      }
    }
    return [...windows.values()]
      .sort((a, b) => byDay(a.rep, b.rep))
      .map((w) => ({
        level: "week",
        day: w.rep.day,
        percent: w.rep.percent,
        members: w.members.slice().sort(byDay),
      }));
  }
  return [];
}

/**
 * CR-CRU-028 §S2 — unfold a TOP-LEVEL coverage bucket one zoom level finer,
 * for the drill-down accordion. Takes the raw `{ day, percent }[]` series, the
 * clicked bucket's `bucketKey`, and its `level`, and returns the finer bars
 * (oldest→newest) hidden inside it (see `finerBarsOf` for the month→week /
 * week→day rules). A day-level bucket returns [] (heat strip instead). Each
 * finer bar carries `members` so a revealed bar can itself be drilled deeper.
 */
export function unfoldCoverageBucket(points, bucketKey, level) {
  const series = points ?? [];
  if (series.length === 0) return [];
  let latestDay = series[0].day;
  for (const p of series) if (p.day > latestDay) latestDay = p.day;
  const latestMs = Date.parse(`${latestDay}T00:00:00.000Z`);
  const subset = series.filter((p) => topBucketKey(p.day, latestMs) === bucketKey);
  return finerBarsOf(subset, level);
}

/**
 * CR-CRU-028 §S2 — cascade helper: unfold a REVEALED drill bar one level finer
 * by re-scoping onto the `members` it already carries (its own subset of raw
 * points), applying the SAME month→week / week→day rules `unfoldCoverageBucket`
 * uses at the top level. This is what lets the drill-down continue past the
 * first level (month→week→day→heat strip, DN §3.3) without re-deriving the
 * top-level bucketKey a revealed bar no longer has.
 */
export function unfoldCoverageSubset(members, parentLevel) {
  return finerBarsOf(members ?? [], parentLevel);
}

/**
 * CR-CRU-028 §S2 — the per-run HEAT SLICES for a project's coverage DAY bar:
 * every within-retention `regression`-tier event on that UTC day carrying a
 * numeric `coverageLines`, in chronological (ascending-timestamp) order, each
 * classified by its OWN coverage level. Events for other projects, other days,
 * non-regression tiers, or with no coverage payload are excluded. An empty
 * result marks the day bar as retention-dimmed (no live run to drill into).
 */
export function coverageHeatSlices(events, projectKey, day) {
  return (events ?? [])
    .filter(
      (e) =>
        e.projectKey === projectKey &&
        e.tier === "regression" &&
        typeof e.coverageLines === "number" &&
        new Date(e.timestamp).toISOString().slice(0, 10) === day,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => ({
      eventId: e.id,
      percent: e.coverageLines,
      level: coverageLevelClass(e.coverageLines),
    }));
}

// ── CR-CRU-011 C4 — §S0b timeline plan integration + §S3 history lens ──────

// Shared agent-stem helpers (same rule pairTransitions uses): a trailing
// -RED|-GREEN|-FIX suffix stripped, case-insensitive.
const agentStemRaw = (agentId) => String(agentId).replace(/-(RED|GREEN|FIX)$/i, "");

/** Numeric-first ordering for wave/track labels ("track-2" < "track-10"). */
function numericLabelCompare(a, b) {
  const num = (s) => {
    const m = /\d+/.exec(String(s));
    return m === null ? Number.POSITIVE_INFINITY : Number(m[0]);
  };
  const d = num(a) - num(b);
  return d !== 0 ? d : String(a).localeCompare(String(b));
}

/** CR-CRU-026 §S3.3 — a plan cycle's index key: COMPOUND
 * `<projectKey> <cycleId>` (space-separated, the same convention
 * pairTransitions uses) for declared plans (cycle ids are PER-PROJECT
 * and must not collide across projects on the home feed). The space is
 * collision-safe: projectKey is always UUID-shaped and cannot contain
 * spaces, and the string keys cannot collide with the bare-number
 * legacy keys. Legacy plans with NO projectKey keep the pre-026
 * bare-id key (matched by cycleId alone), preserving their original
 * linkage semantics. */
const planCycleIndexKey = (plan, cycleId) =>
  plan.projectKey === undefined ? cycleId : `${plan.projectKey} ${cycleId}`;

/** §S3.3 — resolve an EVENT's (projectKey, cycleId) against the index:
 * the compound key first, then the legacy bare-id fallback (only ever
 * populated by undeclared-projectKey plans). */
const planCycleLookupKey = (index, event) => {
  const cycleId = event.context?.cycleId;
  const compound = `${event.projectKey} ${cycleId}`;
  return index.has(compound) ? compound : cycleId;
};

/** §S0b — (projectKey, cycleId) → {cycle, plan} across plans (§S3.3
 * compound keys — see planCycleIndexKey). */
export function planCycleIndex(plans) {
  const index = new Map();
  for (const plan of plans ?? []) {
    for (const cycle of plan.cycles ?? []) {
      index.set(planCycleIndexKey(plan, cycle.id), { cycle, plan });
    }
  }
  return index;
}

/**
 * §S0b — the Runs timeline row plan (pure). Runs linked to a KNOWN plan
 * cycle via `context.cycleId` are the declared plan's territory: they NEVER
 * feed the streak heuristic (suppression), and the cycle's boundary renders
 * declaratively — an open-span header above an ACTIVE cycle's linked runs,
 * a declared marker row above a `done` cycle's. Unlinked runs keep the
 * CR-007 §S2 heuristic byte-identical; with no plans the output is exactly
 * the pre-CR-011 marker+card interleave.
 */
export function timelineRows(events, plans) {
  const index = planCycleIndex(plans);
  const isLinked = (e) =>
    typeof e.context?.cycleId === "number" && index.has(planCycleLookupKey(index, e));
  // CR-CRU-026 §S3.4 — capability-conditional heuristic: a project that
  // DECLARES plans narrates cycles ONLY from declared data — its events
  // (linked or not) never feed pairTransitions, so a stray unlinked run
  // renders a plain card, never a phantom pair. Planless projects (and
  // legacy undeclared-projectKey plans) keep the CR-007 heuristic
  // byte-identical.
  const planBacked = new Set();
  for (const plan of plans ?? []) {
    if (plan.projectKey !== undefined) planBacked.add(plan.projectKey);
  }
  const markers = pairTransitions(
    events.filter((e) => !isLinked(e) && !planBacked.has(e.projectKey)),
  );
  const byGreenId = new Map(markers.map((m) => [m.greenEvent.id, m]));
  const rows = [];
  const headed = new Set();
  for (const event of events) {
    const marker = byGreenId.get(event.id);
    if (marker !== undefined) rows.push({ kind: "marker", marker });
    if (isLinked(event)) {
      const cycleKey = planCycleLookupKey(index, event);
      if (!headed.has(cycleKey)) {
        headed.add(cycleKey);
        const { cycle, plan } = index.get(cycleKey);
        if (cycle.status === "active") {
          rows.push({ kind: "cycle-span-open", cycle, plan });
        } else if (cycle.status === "done") {
          rows.push({ kind: "declared-marker", cycle, plan });
        }
      }
    }
    rows.push({ kind: "card", event });
  }
  return rows;
}

/**
 * §S3 — the history lens tree (pure): Wave → [Track] → CR → Cycle.
 * Declared-plan first — where a plan exists the tree IS the plan; inferred
 * fallback (context.wave + agent stem + context.cycle) where none does;
 * runs lacking any linkage land in the ungrouped tail, never dropped.
 */
export function workflowLens({ plans, events }) {
  const index = planCycleIndex(plans);
  const runs = (events ?? []).filter((e) => e.kind === "test");

  // CR-CRU-013 §S6 — wave labels a qualifying no-mistakes gate has sealed:
  // a `passed` OR `checks-passed` gate event flips the wave to `gated`;
  // `failed`/`cancelled` do NOT. Inferred from events only (zero wave API).
  const gatedWaveLabels = new Set(
    (events ?? [])
      .filter(
        (e) =>
          e.kind === "gate" &&
          (e.gate?.outcome === "passed" || e.gate?.outcome === "checks-passed"),
      )
      .map((e) => e.context?.wave)
      .filter((w) => w !== undefined && w !== null)
      .map((w) => String(w)),
  );

  // Split: plan-linked runs attach to their cycles; the rest infer or tail.
  // §S3.3 — keyed by the plan-cycle index key (compound for declared
  // plans, bare cycleId for legacy undeclared ones — see planCycleIndexKey).
  const linkedRuns = new Map(); // index key -> runs (chronological, latest LAST)
  const unlinked = [];
  for (const run of runs) {
    const cycleId = run.context?.cycleId;
    const cycleKey = planCycleLookupKey(index, run);
    if (typeof cycleId === "number" && index.has(cycleKey)) {
      if (!linkedRuns.has(cycleKey)) linkedRuns.set(cycleKey, []);
      linkedRuns.get(cycleKey).push(run);
    } else {
      unlinked.push(run);
    }
  }
  // §S6 #3 (re-baselined 2026-07-17) — a cycle's run list orders
  // CHRONOLOGICALLY (timestamp ascending, latest LAST) regardless of the
  // events array's arrival order; latest-first stays EXCLUSIVELY the
  // History section's wave/CR-group ordering (CR-020 §S1.1).
  for (const list of linkedRuns.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  const waves = new Map(); // wave label -> wave node
  const waveNode = (label) => {
    if (!waves.has(label)) {
      waves.set(label, { wave: label, source: "inferred", state: null, tracks: null, crs: [] });
    }
    return waves.get(label);
  };
  const crAgents = (crRuns) => [...new Set(crRuns.map((r) => r.agentId))];

  // Declared: one CR node per plan.
  for (const plan of plans ?? []) {
    const cycles = (plan.cycles ?? []).map((cycle) => ({
      id: cycle.id,
      label: cycle.label,
      status: cycle.status,
      // CR-CRU-021 §S3 — timestamp passthrough (server-stamped since
      // CR-011 C4) so history rows can render sealed cycle timers.
      ...(cycle.activatedAt !== undefined ? { activatedAt: cycle.activatedAt } : {}),
      ...(cycle.doneAt !== undefined ? { doneAt: cycle.doneAt } : {}),
      runs: linkedRuns.get(planCycleIndexKey(plan, cycle.id)) ?? [],
    }));
    const node = {
      cr: plan.cr,
      source: "declared",
      status: plan.status,
      ...(plan.track !== undefined ? { track: plan.track } : {}),
      ...(plan.merge !== undefined ? { merge: plan.merge } : {}),
      // CR-CRU-020 §S1.1 — closedAt passthrough (real server field,
      // Plan.closedAt) so the lens can order CR groups newest-first.
      ...(plan.closedAt !== undefined ? { closedAt: plan.closedAt } : {}),
      cycles,
      rollup: {
        done: cycles.filter((c) => c.status === "done").length,
        total: cycles.length,
      },
      agents: crAgents(cycles.flatMap((c) => c.runs)),
    };
    const wave = waveNode(plan.wave ?? "");
    wave.source = "declared";
    wave.crs.push(node);
  }

  // Inferred fallback: wave from context.wave, CR from the agent stem,
  // cycle = the context.cycle label. No wave linkage → ungrouped tail.
  const ungrouped = [];
  const inferred = new Map(); // wave   stemKey -> node
  for (const run of unlinked) {
    const waveLabel = run.context?.wave;
    if (waveLabel === undefined || waveLabel === null) {
      ungrouped.push(run);
      continue;
    }
    const stem = agentStemRaw(run.agentId);
    const key = `${waveLabel} ${stem.toLowerCase()}`;
    if (!inferred.has(key)) {
      inferred.set(key, { wave: String(waveLabel), cr: stem, cycleRuns: new Map() });
    }
    const node = inferred.get(key);
    const cycleLabel = run.context?.cycle ?? "";
    if (!node.cycleRuns.has(cycleLabel)) node.cycleRuns.set(cycleLabel, []);
    node.cycleRuns.get(cycleLabel).push(run);
  }
  for (const raw of inferred.values()) {
    const cycles = [...raw.cycleRuns.entries()].map(([label, cycleRuns]) => {
      const ordered = [...cycleRuns].sort((a, b) => a.timestamp - b.timestamp);
      const last = ordered[ordered.length - 1];
      return {
        label,
        status: last !== undefined && last.failed === 0 ? "done" : "active",
        runs: cycleRuns,
      };
    });
    waveNode(raw.wave).crs.push({
      cr: raw.cr,
      source: "inferred",
      cycles,
      rollup: {
        done: cycles.filter((c) => c.status === "done").length,
        total: cycles.length,
      },
      agents: crAgents(cycles.flatMap((c) => c.runs)),
    });
  }

  // Per-wave finish: track level (only when >1 distinct track), wave state.
  // CR-CRU-020 §S1.1 — waves render newest-first.
  const orderedWaves = [...waves.values()].sort((a, b) =>
    numericLabelCompare(b.wave, a.wave),
  );
  // Wave labels holding ANY declared plan (open or closed) — the superseded
  // check below must see them even after §S1.3 strips open CR nodes.
  const declaredWaveLabels = new Set((plans ?? []).map((p) => p.wave ?? ""));
  for (const wave of orderedWaves) {
    const declared = wave.crs.filter((c) => c.source === "declared");
    // CR-CRU-020 §S1.3 — the history lens is closed-plans-only: an OPEN
    // plan's CR node renders solely in the ACTIVE view. The wave itself
    // keeps rendering — its boundary state below still reads ALL declared
    // plans (open ones included), so state inference is unaffected.
    wave.crs = wave.crs.filter((c) => c.status !== "open");
    // CR-CRU-020 §S1.1 — CR groups newest-first within the wave: closed
    // plans by closedAt descending; nodes without a closedAt (inferred, or
    // closed before the field existed) keep filing order (stable sort).
    wave.crs.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    const tracks = [...new Set(declared.map((c) => c.track).filter((t) => t !== undefined))];
    tracks.sort(numericLabelCompare);
    if (tracks.length > 1) {
      wave.tracks = tracks.map((track) => ({
        track,
        crs: wave.crs.filter((c) => c.track === track),
      }));
      wave.crs = wave.crs.filter((c) => c.track === undefined);
    }
    // Wave boundary state (§S3, inferred from plan states only): running
    // (≥1 open plan) → lanes complete · awaiting review (all closed, no
    // later wave has plans) → superseded (a newer wave opened).
    if (declared.length > 0) {
      const open = declared.filter((c) => c.status === "open");
      if (open.length > 0) {
        // CR-CRU-021 §S6 #5 — a lane's chip reads off its CLOSED material
        // when any exists (history's own state is independent of a same-wave
        // cr still open elsewhere, §S1.3); an all-open lane falls back to
        // its live rollup. ✓ only when the closed material is fully done.
        const chips =
          tracks.length > 0
            ? tracks.map((track) => {
                const lane = declared.filter((c) => c.track === track);
                const closedLane = lane.filter((c) => c.status === "closed");
                const material = closedLane.length > 0 ? closedLane : lane;
                const done = material.reduce((n, c) => n + c.rollup.done, 0);
                const total = material.reduce((n, c) => n + c.rollup.total, 0);
                return closedLane.length > 0 && done === total
                  ? `${track} ✓`
                  : `${track} ${done}/${total}`;
              })
            : [];
        // §S6 #5 — the header's trailing state reads off history's own
        // closed material: any closed plan awaits review; none yet → running.
        const closed = declared.filter((c) => c.status === "closed");
        wave.state = { label: closed.length > 0 ? "awaiting review" : "running", chips };
      } else {
        const superseded = orderedWaves.some(
          (other) =>
            other !== wave &&
            numericLabelCompare(other.wave, wave.wave) > 0 &&
            declaredWaveLabels.has(other.wave),
        );
        wave.state = superseded
          ? { label: "superseded", chips: [] }
          : gatedWaveLabels.has(String(wave.wave))
            ? { label: "gated", chips: [] }
            : { label: "lanes complete · awaiting review", chips: [] };
      }
    }
  }

  // CR-CRU-021 §S6 (cycle 13, gap 2) — a wave with ZERO visible CR nodes
  // (e.g. its only material is an OPEN plan, stripped by §S1.3 above) must
  // render NOTHING: drop it from the lens output entirely, no header-only
  // ghost entry. The superseded detection above reads declaredWaveLabels
  // off the RAW plans list, so it still sees the dropped wave's plan.
  const visibleWaves = orderedWaves.filter(
    (wave) => wave.crs.length > 0 || (wave.tracks ?? []).some((t) => t.crs.length > 0),
  );

  return { waves: visibleWaves, ungrouped };
}

/**
 * CR-CRU-077 §S4/AC6 — the terse status suffix a CR node's label carries after
 * its id, keyed by the four derived `QueueStatus` values. Each is derivable
 * from the status value ALONE, so the builder's own two inputs are enough:
 * `COMPLETED` is a merged plan, `COMPLETED_UNTRACKED` is shipped-but-never-
 * tracked (CR-CRU-083's fourth value, which must not read as "merged"),
 * `IN_PROGRESS` is active, and `PENDING` has nothing to say yet.
 *
 * A cycle position (`2/3`) is deliberately NOT here: it lives on `plan.cycles`
 * and the builder is handed queue entries + releases only, so rendering one
 * would pin fabricated data. The active marker stands alone instead — the same
 * degradation the table's lane badge already makes when the position is null.
 */
const CR_STATUS_SUFFIX = new Map([
  ["COMPLETED", " ✓ merged"],
  ["COMPLETED_UNTRACKED", " ✓ untracked"],
  ["IN_PROGRESS", " ▶"],
  ["PENDING", ""],
]);

/**
 * AC6's whole CR node label: the CR id plus that suffix, and NOTHING else. The
 * title is absent by design — it crowds the identifier out of the node box —
 * and the raw wire status never appears as text either; it stays on
 * `data.status`, where the stylesheet selects on it.
 *
 * An unknown or absent status yields the BARE id: a suffix is a claim about
 * execution state, and an unrecognised value supports no claim. So the node
 * still reads (and never renders `undefined`) without inventing a marker.
 */
const crNodeLabel = (e) => `${e.cr}${CR_STATUS_SUFFIX.get(e.status) ?? ""}`;

/**
 * CR-CRU-014 §S3 + CR-CRU-077 §S1 — pure, browser-free roadmap graph-data
 * builder. Maps the execution queue + release ledger into a Cytoscape elements
 * shape ({nodes, edges}): one rectangle type:"cr" node per entry (wave/track/
 * status ride DATA fields, never the label — the label is the CR id plus a
 * terse status suffix and never the title, CR-CRU-077 §S4/AC6); one directed
 * edge per dependsOn (prereq SOURCE →
 * dependant TARGET); one diamond type:"milestone" node per release, wired INTO
 * the flow (DN decision 3) — the CRs a release shipped flow into its diamond,
 * the diamond gates the CRs that follow it, and the diamonds chain in ship
 * order; and a single Start/End ellipse type:"terminal" pair bracketing
 * whatever the flow itself does not already feed or drain.
 *
 * No edge is invented to express sequence (DN decision 5): every edge comes
 * from `dependsOn`, from `crs` membership, or from the release chain. The
 * orchestrator-assigned queue position instead RIDES the CR node as
 * `data.seq` — a monotonic tie-break a layout can rank same-rank siblings on.
 * It is DATA and not an edge for two independent reasons: decision 5 forbids
 * inventing any edge to express sequence whatever it is typed, and an edge
 * a→b would make b reachable from a, which is exactly the CHAIN that §S1/AC3
 * rules out for two same-wave CRs with no dependency between them. Do not
 * "improve" this into an edge.
 */
export function buildRoadmapGraph(entries, releases) {
  const nodes = [];
  const edges = [];
  const queue = entries ?? [];
  const crIds = new Set(queue.map((e) => e.cr));

  for (const e of queue) {
    const data = {
      id: e.cr,
      type: "cr",
      label: crNodeLabel(e),
      cr: e.cr,
      wave: e.wave,
      status: e.status,
    };
    // The AUTHORED position, and nothing else: never the CR id, never the
    // wave (AC8), never the status. Re-author the queue and this follows.
    // Absent on milestone and terminal nodes — a release boundary and a
    // bracket hold no queue position — and never rendered into `label`.
    //
    // CR-CRU-091/AC18 — the STORED `seq` the read publishes on every entry
    // (`src/types.ts:397-404`), carried VERBATIM. Never the response index:
    // `listQueue` is `ORDER BY seq`, so an index derivation preserves the
    // authored ORDER and therefore survives every other assertion while making
    // `seq` mean two different numbers on one surface. A payload arriving
    // without a usable `seq` is a defect, so the position is OMITTED — the
    // "no carried position" state milestone nodes already occupy — rather than
    // defaulted to the index, which is that same ambiguity by another name.
    if (typeof e.seq === "number" && Number.isFinite(e.seq)) data.seq = e.seq;
    if (e.track !== undefined && e.track !== null) data.track = e.track;
    nodes.push({ data });
  }

  // Dependency edges: the prerequisite is the SOURCE (execution flows
  // deps-first). Guard against dangling deps (a dep not in the queue).
  for (const e of queue) {
    for (const dep of e.dependsOn ?? []) {
      if (!crIds.has(dep)) continue;
      edges.push({ data: { id: `dep:${dep}->${e.cr}`, source: dep, target: e.cr } });
    }
  }

  // Ship order is `releasedAt` (the tag's OWN commit date, epoch SECONDS), not
  // the payload order — the live ledger arrives newest-first, and `timestamp`
  // is only the ingest instant. A release with no `releasedAt` (a pre-CR-080
  // ledger row) sorts OLDEST: an undated tag is legacy history, and calling it
  // the newest would hand it the gating of every unshipped CR on a date nobody
  // recorded. Ties — and the undated group — fall back to the payload order
  // reversed, which is that newest-first arrival read as ship order.
  const ordered = (releases ?? [])
    .map((rel, index) => ({
      rel,
      index,
      at: Number.isFinite(rel.releasedAt) ? rel.releasedAt : null,
    }))
    .sort((a, b) => {
      if (a.at === b.at) return b.index - a.index;
      if (a.at === null) return -1;
      if (b.at === null) return 1;
      return a.at - b.at;
    })
    .map((o) => o.rel);
  const milestoneId = (rel) => `milestone:${rel.version}`;
  for (const rel of ordered) {
    nodes.push({
      data: {
        id: milestoneId(rel),
        type: "milestone",
        version: rel.version,
        label: rel.version,
        // CR-CRU-077 §S2/AC4 — how many CRs this release shipped, derived from
        // the ledger's `crs` and therefore builder data, not render state. A
        // release that shipped none carries 0 (never absent): "zero CRs" is a
        // measured fact about the tag, the same as sixty. The RENDER layer owns
        // whether that region is folded (`data.collapsed`) — expansion is UI
        // state and is not persisted, so it never appears here.
        crCount: (rel.crs ?? []).length,
      },
    });
  }

  // Membership is `crs` and NOTHING else — never an ingest timestamp, never
  // wave structure. A missing `crs` is EMPTY membership (the live 0.1.1), never
  // unknown; if two tags claim one CR the older claim wins, since that is when
  // it shipped.
  const shipStage = new Map();
  ordered.forEach((rel, stage) => {
    for (const cr of rel.crs ?? []) {
      if (crIds.has(cr) && !shipStage.has(cr)) shipStage.set(cr, stage);
    }
  });
  // The unshipped region is the ledger's COMPLEMENT, so it exists only once the
  // ledger actually places a CR: a membership-free ledger (every `crs` absent
  // or empty, as the whole pre-CR-080 payload was) orders no CR at all, and
  // gating one off a boundary there would be exactly the synthetic sequence
  // decision 5 forbids. The diamonds still chain — a release is a real,
  // ordered fact on its own.
  const unshipped = ordered.length;
  const stageOf = (cr) => shipStage.get(cr) ?? (shipStage.size > 0 ? unshipped : null);

  // A diamond brackets its region the way the terminals bracket the DAG: it
  // takes the region's SINKS as inflow and gates the next region's ROOTS,
  // leaving every intra-region position to `dependsOn` alone.
  const stagePrereq = new Set();
  const stageDependant = new Set();
  for (const e of queue) {
    const stage = stageOf(e.cr);
    if (stage === null) continue;
    for (const dep of e.dependsOn ?? []) {
      if (!crIds.has(dep) || stageOf(dep) !== stage) continue;
      stagePrereq.add(e.cr);
      stageDependant.add(dep);
    }
  }
  for (const e of queue) {
    const stage = stageOf(e.cr);
    if (stage === null) continue;
    if (stage < unshipped && !stageDependant.has(e.cr)) {
      const rel = ordered[stage];
      edges.push({
        data: { id: `rel:ship:${e.cr}->${rel.version}`, source: e.cr, target: milestoneId(rel) },
      });
    }
    if (stage > 0 && !stagePrereq.has(e.cr)) {
      const gate = ordered[stage - 1];
      edges.push({
        data: { id: `rel:gate:${gate.version}->${e.cr}`, source: milestoneId(gate), target: e.cr },
      });
    }
  }
  // The boundaries chain in ship order, so a release that shipped ZERO CRs
  // still sits IN the flow instead of floating beside it.
  for (let i = 1; i < ordered.length; i += 1) {
    const from = ordered[i - 1];
    const to = ordered[i];
    edges.push({
      data: {
        id: `rel:chain:${from.version}->${to.version}`,
        source: milestoneId(from),
        target: milestoneId(to),
      },
    });
  }

  // Start/End terminals bracket the DAG: every flow node nothing else feeds
  // hangs off Start, every one that feeds nothing hangs onto End — CR node and
  // release diamond alike. A CR a diamond gates is NOT also bracketed straight
  // off Start: work after a release boundary does not start before it.
  const startId = "__roadmap_start__";
  const endId = "__roadmap_end__";
  const flowIds = nodes.map((n) => n.data.id);
  nodes.push({ data: { id: startId, type: "terminal", terminal: "start", label: "Start" } });
  nodes.push({ data: { id: endId, type: "terminal", terminal: "end", label: "End" } });
  const fed = new Set(edges.map((e) => e.data.target));
  const feeds = new Set(edges.map((e) => e.data.source));
  for (const id of flowIds) {
    if (!fed.has(id)) edges.push({ data: { id: `start->${id}`, source: startId, target: id } });
    if (!feeds.has(id)) edges.push({ data: { id: `${id}->end`, source: id, target: endId } });
  }

  return { nodes, edges };
}

// Bridge for the nomodule app shell (app.js consumes window.CrucibleLogic).
if (typeof window !== "undefined") {
  window.CrucibleLogic = {
    filterEvents,
    relativeTime,
    formatReleaseDate,
    livenessGlyph,
    routeParse,
    workspaceTabs,
    buildRoadmapGraph,
    projectRollupLabel,
    projectActivity,
    orderProjects,
    emptyStates,
    pairTransitions,
    planCycleIndex,
    timelineRows,
    workflowLens,
    drillinDefaultMode,
    agentRole,
    foldSuites,
    digestFailures,
    COVERAGE_LEVEL_ORANGE_MAX,
    COVERAGE_LEVEL_YELLOW_MAX,
    coverageLevelClass,
    coarsenCoverageTrend,
    unfoldCoverageBucket,
    unfoldCoverageSubset,
    coverageHeatSlices,
  };
}
