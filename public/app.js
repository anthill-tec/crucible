/* CR-CRU-006 §S2–§S5 — Crucible v2 app shell (VanJS + VanX, no build step).
   `van` / `vanX` are globals from the vendored nomodule bundles. */
/* global van, vanX */
(() => {
  "use strict";

  const { a, button, div, span } = van.tags;

  // ── State ─────────────────────────────────────────────────────────────
  const state = vanX.reactive({
    projects: [],
    agents: [],
    events: [],
    health: null,
    selectedProject: null, // chip filter on Mission Control (null = all)
    route: parseRoute(location.pathname),
    backendUp: true,
    lastSynced: null,
  });

  // ── Routing (§S2 — hash-free History routing) ─────────────────────────
  // "/"                     → { page: "home", runId: null }
  // "/run/<id>"             → { page: "home", runId }
  // "/p/<key>"              → { page: "workspace", projectKey, runId: null }
  // "/p/<key>/run/<id>"     → { page: "workspace", projectKey, runId }
  function parseRoute(pathname) {
    const parts = pathname.split("/").filter((p) => p.length > 0);
    let runId = null;
    if (parts.length >= 2 && parts[parts.length - 2] === "run") {
      runId = decodeURIComponent(parts.pop());
      parts.pop();
    }
    if (parts[0] === "p" && parts.length >= 2) {
      return { page: "workspace", projectKey: decodeURIComponent(parts[1]), runId };
    }
    return { page: "home", projectKey: null, runId };
  }

  function navigate(pathname) {
    history.pushState(null, "", pathname);
    state.route = parseRoute(pathname);
  }

  window.addEventListener("popstate", () => {
    state.route = parseRoute(location.pathname);
  });

  // ── Data plumbing (§S5 — v2 surface only) ─────────────────────────────
  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function refetch() {
    try {
      const [projects, agents, events, health] = await Promise.all([
        getJson("/api/v2/projects"),
        getJson("/api/v2/agents"),
        getJson("/api/v2/events?limit=50"),
        getJson("/api/v2/health"),
      ]);
      vanX.replace(state.projects, () => projects.projects ?? []);
      vanX.replace(state.agents, () => agents.agents ?? []);
      vanX.replace(state.events, () => events.events ?? []);
      state.health = health;
      state.backendUp = true;
      state.lastSynced = Date.now();
    } catch {
      // Reachability is owned by the watchdog below; keep stale data visible.
    }
  }

  // SSE client with keep-alive watchdog (§S5): any frame (data OR comment
  // keep-alive) proves liveness via onmessage/readyState; silence >20s AND a
  // failing /api/health flips the pill. Poll fallback every 5s when SSE is
  // unavailable.
  let lastFrameAt = Date.now();
  let sse = null;
  let pollTimer = null;

  function connectStream() {
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    sse = new EventSource("/api/stream");
    sse.onopen = () => {
      lastFrameAt = Date.now();
      stopPolling();
      refetch();
    };
    sse.onmessage = () => {
      lastFrameAt = Date.now();
      refetch(); // change frames trigger slice refetch
    };
    sse.onerror = () => {
      startPolling(); // §S5 poll fallback while SSE is down
      if (sse !== null && sse.readyState === EventSource.CLOSED) {
        sse.close();
        sse = null;
        setTimeout(connectStream, 5000); // auto-recover on reconnect
      }
    };
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(refetch, 5000);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function watchdogTick() {
    if (Date.now() - lastFrameAt <= 20000) return;
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        lastFrameAt = Date.now();
        if (!state.backendUp) {
          state.backendUp = true; // auto-recover
          refetch();
          if (sse === null) connectStream();
        }
        return;
      }
      state.backendUp = false;
    } catch {
      state.backendUp = false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function timeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function syncedStamp() {
    return state.lastSynced === null
      ? "never synced"
      : `last synced ${timeAgo(state.lastSynced)}`;
  }

  function dotClass(agent) {
    if (agent.liveness === "online") return agent.status === "busy" ? "app-dot r" : "app-dot g";
    if (agent.liveness === "stale") return "app-dot y";
    return "app-dot o";
  }

  function greyed(cls) {
    return () => (state.backendUp ? cls : `${cls} greyed`);
  }

  // ── Components ────────────────────────────────────────────────────────
  const HealthPill = () =>
    span(
      {
        "data-testid": "health-pill",
        class: () => `app-chip app-health${state.backendUp ? "" : " down"}`,
      },
      span({ class: () => `app-dot ${state.backendUp ? "g" : "r"}` }),
      () =>
        state.backendUp
          ? `crucible ${state.health?.version ?? ""} · ${state.health?.counts?.events ?? 0} events`
          : `backend unreachable · ${syncedStamp()}`,
    );

  const ProjectChip = (project) =>
    button(
      {
        "data-testid": "project-chip",
        class: () =>
          `app-chip${state.selectedProject === (project?.key ?? null) ? " on" : ""}`,
        onclick: () => {
          state.selectedProject = project?.key ?? null;
        },
      },
      project?.name ?? "All projects",
    );

  const TopBar = () =>
    div(
      { "data-testid": "app-topbar", class: "app-top" },
      a(
        {
          class: "app-logo",
          href: "/",
          onclick: (e) => {
            e.preventDefault();
            navigate("/");
          },
        },
        "⚒ Crucible ",
        span("v2"),
      ),
      vanX.list(div, state.projects, (p) => ProjectChip(p.val)),
      ProjectChip(null),
      HealthPill(),
    );

  const ProjectCard = (project) =>
    div(
      {
        "data-testid": "project-card",
        class: "app-card",
        onclick: () => navigate(`/p/${encodeURIComponent(project.key)}`),
      },
      div({ class: "app-card-name" }, project.name || project.key),
      div(
        { class: "app-card-meta" },
        `${project.type} · ${project.agentsOnline}/${project.agentsTotal} agents online`,
      ),
      div({ class: "app-card-meta" }, () => {
        const last = project.lastEvent;
        if (last === null || last === undefined) return "no runs yet";
        const verdict = last.failed > 0 ? "✗ red" : "✓ green";
        return `${verdict} · ${last.passed}/${last.total} · ${timeAgo(last.timestamp)}`;
      }),
    );

  const AgentRow = (agent) => {
    const tombstoned = agent.liveness === "tombstoned";
    return div(
      {
        "data-testid": "agent-row",
        class: `app-agent-row${tombstoned ? " tombstoned" : ""}`,
      },
      span(
        { class: "app-agent-id" },
        tombstoned ? span("⚰ ") : span({ class: dotClass(agent) }),
        agent.identity?.displayName ?? agent.agentId,
      ),
      span({ class: "app-agent-msg" }, agent.message || "—"),
      tombstoned
        ? span({ class: "app-agent-msg" }, `died ${timeAgo(agent.lastSeen)}`)
        : null,
    );
  };

  function visibleAgents() {
    const key = state.route.page === "workspace" ? state.route.projectKey : state.selectedProject;
    return key === null ? state.agents : state.agents.filter((a2) => a2.projectKey === key);
  }

  function visibleProjects() {
    return state.selectedProject === null
      ? state.projects
      : state.projects.filter((p) => p.key === state.selectedProject);
  }

  const Timeline = () =>
    div(
      { "data-testid": "timeline", class: greyed("app-center") },
      div({ class: "app-rail-title" }, "timeline"),
      () =>
        state.backendUp ? span() : span({ class: "app-synced" }, syncedStamp()),
      () =>
        state.events.length === 0
          ? div({ class: "app-empty" }, "no runs yet — ingest a run to light the forge")
          : div(
              state.events.map((e) =>
                div(
                  { class: "app-evt" },
                  span(e.failed > 0 ? "✗" : "✓"),
                  span(`${e.agentId} · ${e.kind}/${e.tier} · ${e.passed}/${e.total} · ${timeAgo(e.timestamp)}`),
                ),
              ),
            ),
    );

  const ProjectsRail = () =>
    div(
      { class: greyed("app-rail") },
      div({ class: "app-rail-title" }, "projects"),
      () =>
        visibleProjects().length === 0
          ? div({ class: "app-empty" }, "no projects registered")
          : div(visibleProjects().map(ProjectCard)),
    );

  const AgentsRail = () =>
    div(
      { class: greyed("app-rail") },
      div({ class: "app-rail-title" }, "agents"),
      () =>
        visibleAgents().length === 0
          ? div({ class: "app-empty" }, "no agents online")
          : div(visibleAgents().map(AgentRow)),
    );

  // Home = Mission Control (§S3 rails); workspace/overlay are minimal
  // placeholders this cycle (fleshed out in C3/CR-CRU-007).
  const Home = () => div({ class: "app-main" }, ProjectsRail(), Timeline(), AgentsRail());

  const Workspace = () =>
    div(
      { class: "app-main" },
      div(
        { class: greyed("app-rail") },
        button(
          { class: "app-chip", onclick: () => navigate("/") },
          "← projects",
        ),
        div({ class: "app-rail-title" }, () => `workspace · ${state.route.projectKey}`),
      ),
      Timeline(),
      AgentsRail(),
    );

  const RunOverlay = () =>
    div(
      { "data-testid": "run-overlay", class: "app-rail" },
      div({ class: "app-rail-title" }, () => `run · ${state.route.runId}`),
      div({ class: "app-empty" }, "run detail lands in CR-CRU-007"),
    );

  const App = () =>
    div(
      TopBar(),
      () => (state.route.page === "workspace" ? Workspace() : Home()),
      () => (state.route.runId !== null ? RunOverlay() : span()),
    );

  // ── Boot ──────────────────────────────────────────────────────────────
  van.add(document.getElementById("app"), App());
  refetch();
  connectStream();
  setInterval(watchdogTick, 5000);
})();
