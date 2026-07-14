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

const TAB_NAMES = ["Runs", "Agents", "Coverage", "Compile", "BDD"];

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

/** Storyboard F1 empty states — no-projects wins over no-runs. */
export function emptyStates(state) {
  if (state.projects.length === 0) return { kind: "no-projects" };
  if (state.events.length === 0) return { kind: "no-runs" };
  return null;
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
    emptyStates,
  };
}
