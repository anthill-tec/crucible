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
  if (parts[0] === "p" && parts.length >= 2) {
    const route = { page: "workspace", projectKey: decodeURIComponent(parts[1]) };
    if (overlay !== undefined) route.overlay = overlay;
    return route;
  }
  const route = { page: "home" };
  if (overlay !== undefined) route.overlay = overlay;
  return route;
}

// CR-CRU-007 §S5.2 — Agents dropped: agents nest under the workspace's
// Project pane instead of owning a tab.
const TAB_NAMES = ["Runs", "Coverage", "Compile", "BDD"];

/** §S4 workspace tabs — fixed order; BDD disabled unless frontend project. */
export function workspaceTabs(project) {
  return TAB_NAMES.map((name) => ({
    name,
    disabled: name === "BDD" && project.type !== "frontend",
  }));
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
 * CR-CRU-007 §S2 — RED→GREEN transition markers (= Cycles), pure pairing.
 * Same projectKey + same agent stem (agentId with a trailing -RED|-GREEN|-FIX
 * suffix stripped, case-insensitive): a failing test run followed by a
 * passing test run within 24h pairs into one marker. Pass-then-pass,
 * different stems, or >24h apart pair nothing. Input order agnostic; never
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
  const paired = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const red = sorted[i];
    if (!(red.failed > 0)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const green = sorted[j];
      if (green.timestamp - red.timestamp > CYCLE_WINDOW_MS) break;
      if (paired.has(green)) continue;
      if (green.failed > 0) continue;
      if (green.projectKey !== red.projectKey) continue;
      if (stemKey(green.agentId) !== stemKey(red.agentId)) continue;
      markers.push({
        redEvent: red,
        greenEvent: green,
        projectKey: red.projectKey,
        stem: stemRaw(red.agentId),
      });
      paired.add(green);
      break;
    }
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

/**
 * §S4.0 — the user's manual override is remembered per tier GROUP (two
 * localStorage keys: broad vs focused), seeded by the tier defaults.
 */
export function drillinModeStorageKey(tier) {
  return BROAD_TIERS.has(tier)
    ? "crucible.drillin.mode.broad"
    : "crucible.drillin.mode.focused";
}

// Bridge for the nomodule app shell (app.js consumes window.CrucibleLogic).
if (typeof window !== "undefined") {
  window.CrucibleLogic = {
    filterEvents,
    relativeTime,
    livenessGlyph,
    routeParse,
    workspaceTabs,
    projectRollupLabel,
    projectActivity,
    orderProjects,
    emptyStates,
    pairTransitions,
    drillinDefaultMode,
    drillinModeStorageKey,
  };
}
