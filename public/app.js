/* CR-CRU-006 §S2–§S5 — Crucible v2 app shell (VanJS + VanX, no build step).
   `van` / `vanX` are globals from the vendored nomodule bundles; pure app
   logic lives in app-logic.mjs and arrives here as `window.CrucibleLogic`
   (the module script sets it before deferred scripts would normally need it,
   but boot guards on its presence anyway). */
/* global van, vanX */
(() => {
  "use strict";

  function main(L) {
    const { a, button, div, span } = van.tags;

    // ── State ───────────────────────────────────────────────────────────
    const state = vanX.reactive({
      projects: [],
      agents: [],
      events: [],
      health: null,
      selectedProject: null, // chip filter on Mission Control (null = all)
      selectedAgent: null, // agent-row click filter (null = all)
      route: L.routeParse(location.pathname),
      workspaceTab: "Runs",
      backendUp: true,
      lastSynced: null,
    });

    // ── Routing (§S2 — hash-free History routing, parse in app-logic) ───
    function navigate(pathname) {
      history.pushState(null, "", pathname);
      state.route = L.routeParse(pathname);
      state.workspaceTab = "Runs";
    }

    window.addEventListener("popstate", () => {
      state.route = L.routeParse(location.pathname);
    });

    // ── Data plumbing (§S5 — v2 surface only) ───────────────────────────
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

    // ── Helpers ─────────────────────────────────────────────────────────
    const rel = (ts) => L.relativeTime(ts, Date.now());

    function syncedStamp() {
      return state.lastSynced === null
        ? "never synced"
        : `last synced ${rel(state.lastSynced)}`;
    }

    function greyed(cls) {
      return () => (state.backendUp ? cls : `${cls} greyed`);
    }

    function activeFilters() {
      const projectKey =
        state.route.page === "workspace" ? state.route.projectKey : state.selectedProject;
      return { projectKey, agentId: state.selectedAgent };
    }

    function visibleEvents() {
      return L.filterEvents(state.events, activeFilters());
    }

    function visibleAgents() {
      // Agents carry projectKey/agentId too — same filter shape applies.
      return L.filterEvents(state.agents, { projectKey: activeFilters().projectKey });
    }

    function visibleProjects() {
      return state.selectedProject === null
        ? state.projects
        : state.projects.filter((p) => p.key === state.selectedProject);
    }

    function currentProject() {
      return state.projects.find((p) => p.key === state.route.projectKey) ?? null;
    }

    // ── Components ──────────────────────────────────────────────────────
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
            state.selectedAgent = null;
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
        div({ class: "app-card-meta" }, () => L.projectRollupLabel(project)),
      );

    const AgentRow = (agent) => {
      const glyph = L.livenessGlyph(agent);
      const busy = agent.liveness === "online" && agent.status === "busy";
      return div(
        {
          "data-testid": "agent-row",
          class: () =>
            `app-agent-row${glyph.tombstone ? " tombstoned" : ""}${
              state.selectedAgent === agent.agentId ? " on" : ""
            }`,
          onclick: () => {
            state.selectedAgent =
              state.selectedAgent === agent.agentId ? null : agent.agentId;
          },
        },
        span(
          { class: "app-agent-id" },
          glyph.tombstone
            ? span("⚰ ")
            : span({ class: `app-dot ${busy ? "r" : glyph.cls}` }),
          agent.identity?.displayName ?? agent.agentId,
        ),
        span({ class: "app-agent-msg" }, agent.message || "—"),
        glyph.tombstone
          ? span({ class: "app-agent-msg" }, `died ${glyph.diedAgo}`)
          : null,
      );
    };

    const EventCard = (e) =>
      div(
        { class: "app-evt" },
        span(e.failed > 0 ? "✗" : "✓"),
        span(
          `${e.agentId} · ${e.kind}/${e.tier} · ${e.passed}/${e.total} · ${rel(e.timestamp)}`,
        ),
      );

    const EmptyState = () => {
      const empty = L.emptyStates({ projects: state.projects, events: state.events });
      if (empty === null) return null;
      return div(
        { class: "app-empty" },
        empty.kind === "no-projects"
          ? "no projects registered — register a project to light the forge"
          : "no runs yet — ingest a run to light the forge",
      );
    };

    const Timeline = () =>
      div(
        { "data-testid": "timeline", class: greyed("app-center") },
        div({ class: "app-rail-title" }, "timeline"),
        () =>
          state.backendUp ? span() : span({ class: "app-synced" }, syncedStamp()),
        () => EmptyState() ?? div(visibleEvents().map(EventCard)),
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

    // Home = Mission Control (§S3 rails)
    const Home = () => div({ class: "app-main" }, ProjectsRail(), Timeline(), AgentsRail());

    // ── Workspace (§S4 — header, tabs, Runs listing, vitals rail) ───────
    const WorkspaceHeader = () =>
      div(
        { "data-testid": "workspace-header", class: "app-top" },
        button({ class: "app-chip", onclick: () => navigate("/") }, "← projects"),
        () => {
          const p = currentProject();
          return span(
            { class: "app-card-name" },
            p ? p.name || p.key : state.route.projectKey,
          );
        },
        () => {
          const p = currentProject();
          return span(
            { class: "app-card-meta" },
            p ? `${p.type} · ${p.agentsOnline}/${p.agentsTotal} agents online` : "",
          );
        },
      );

    const WorkspaceTabs = () =>
      div({ "data-testid": "workspace-tabs", class: "app-top" }, () => {
        const project = currentProject();
        const tabs = L.workspaceTabs({ type: project?.type ?? "backend" });
        return div(
          tabs.map((t) =>
            button(
              {
                "data-testid": "workspace-tab",
                class: `app-chip${state.workspaceTab === t.name ? " on" : ""}${
                  t.disabled ? " disabled" : ""
                }`,
                disabled: t.disabled,
                onclick: () => {
                  if (!t.disabled) state.workspaceTab = t.name;
                },
              },
              t.name,
            ),
          ),
        );
      });

    const WorkspaceRuns = () =>
      div(
        { "data-testid": "workspace-runs", class: greyed("app-center") },
        div({ class: "app-rail-title" }, "runs"),
        () => {
          const runs = visibleEvents();
          return runs.length === 0
            ? div({ class: "app-empty" }, "no runs yet — ingest a run to light the forge")
            : div(runs.map(EventCard));
        },
      );

    const VitalsRail = () =>
      div(
        { "data-testid": "vitals-rail", class: greyed("app-rail") },
        div({ class: "app-rail-title" }, "vitals"),
        div({ class: "app-empty" }, "vitals land in CR-CRU-007"),
      );

    const WorkspaceBody = () => {
      if (state.workspaceTab === "Runs") return WorkspaceRuns();
      if (state.workspaceTab === "Agents")
        return div({ class: greyed("app-center") }, AgentsRail());
      return div(
        { class: greyed("app-center") },
        div({ class: "app-empty" }, `${state.workspaceTab} lands in CR-CRU-007`),
      );
    };

    const Workspace = () =>
      div(
        { "data-testid": "workspace", class: "app-main" },
        div(
          { class: greyed("app-rail") },
          WorkspaceHeader(),
          WorkspaceTabs(),
        ),
        () => WorkspaceBody(),
        div(AgentsRail(), VitalsRail()),
      );

    const RunOverlay = () =>
      div(
        { "data-testid": "run-overlay", class: "app-rail" },
        div({ class: "app-rail-title" }, () => `run · ${state.route.overlay}`),
        div({ class: "app-empty" }, "run detail lands in CR-CRU-007"),
      );

    const App = () =>
      div(
        TopBar(),
        () => (state.route.page === "workspace" ? Workspace() : Home()),
        () => (state.route.overlay !== undefined ? RunOverlay() : span()),
      );

    // ── Boot ────────────────────────────────────────────────────────────
    van.add(document.getElementById("app"), App());
    refetch();
    connectStream();
    setInterval(watchdogTick, 5000);
  }

  // app.js is a deferred classic script; app-logic.mjs is a module script.
  // Both run after parsing, but guard on window.CrucibleLogic anyway and
  // retry a tick if the module hasn't evaluated yet.
  function boot() {
    if (typeof window !== "undefined" && window.CrucibleLogic !== undefined) {
      main(window.CrucibleLogic);
    } else {
      setTimeout(boot, 0);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
