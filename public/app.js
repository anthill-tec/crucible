/* CR-CRU-006 §S2–§S5 + CR-CRU-007 §S5 — Crucible v2 app shell (VanJS + VanX,
   no build step), board-design-iteration final form: title bar + projects row
   + collective timeline on home; workspace Project pane with ⌁-nested agents;
   Health Pill fidelity on both surfaces.
   `van` / `vanX` are globals from the vendored nomodule bundles; pure app
   logic lives in app-logic.mjs and arrives here as `window.CrucibleLogic`
   (the module script sets it before deferred scripts would normally need it,
   but boot guards on its presence anyway). */
/* global van, vanX */
(() => {
  "use strict";

  function main(L) {
    const { a, button, div, option, select, span } = van.tags;

    // ── State ───────────────────────────────────────────────────────────
    const state = vanX.reactive({
      projects: [],
      agents: [],
      events: [],
      health: null,
      selectedProject: null, // home filter pulldown (null = all projects)
      selectedAgent: null, // agent sub-row click filter (null = all)
      route: L.routeParse(location.pathname),
      workspaceTab: "Runs",
      backendUp: true,
      lastSynced: null,
      savedScrollY: 0, // §S2/AC 10b — scroll position under the run overlay
    });

    // ── Routing (§S2 — hash-free History routing, parse in app-logic) ───
    function navigate(pathname) {
      const next = L.routeParse(pathname);
      // AC 10b(a) — opening the run overlay: remember where the underlying
      // surface was scrolled so closing can restore it.
      if (next.overlay !== undefined && state.route.overlay === undefined) {
        state.savedScrollY = window.scrollY;
      }
      history.pushState(null, "", pathname);
      state.route = next;
      state.workspaceTab = "Runs";
      state.selectedAgent = null;
    }

    function restoreScroll() {
      const y = state.savedScrollY;
      // After the reactive re-render (VanJS applies state-derived DOM this
      // frame), put the underlying surface back where it was.
      requestAnimationFrame(() => window.scrollTo(0, y));
    }

    // AC 10b(b/c) — close the overlay back to the underlying surface path
    // (strip the /run/<id> suffix) and restore the saved scroll position.
    function closeOverlay() {
      if (state.route.overlay === undefined) return;
      const base = location.pathname.replace(/\/run\/[^/]+\/?$/, "") || "/";
      history.pushState(null, "", base);
      state.route = L.routeParse(base);
      restoreScroll();
    }

    window.addEventListener("popstate", () => {
      // AC 10b(d) — browser-back out of the overlay restores scroll too.
      const hadOverlay = state.route.overlay !== undefined;
      state.route = L.routeParse(location.pathname);
      if (hadOverlay && state.route.overlay === undefined) restoreScroll();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.route.overlay !== undefined) closeOverlay();
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

    // SSE client with watchdog (§S5): data frames (hello/changes) prove
    // liveness via onopen/onmessage; the server's comment keep-alives never
    // reach EventSource handlers, so during quiet periods liveness rests on
    // the watchdog probing /api/v2/health after >20s of silence — only a
    // failing probe flips the pill. Poll fallback every 5s when SSE is
    // unavailable.
    let lastFrameAt = Date.now();
    let sse = null;
    let pollTimer = null;

    function connectStream() {
      if (sse !== null) return; // one live EventSource, however many callers race
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
        const res = await fetch("/api/v2/health");
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

    function currentProject() {
      return state.projects.find((p) => p.key === state.route.projectKey) ?? null;
    }

    function uptimeLabel(seconds) {
      const s = Math.max(0, Math.floor(seconds));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      return `${Math.floor(s / 3600)}h`;
    }

    // ── Components ──────────────────────────────────────────────────────
    // §S5.4 (CR-CRU-007) — server-liveness fidelity on BOTH surfaces:
    // healthy·live / healthy·up <duration>, unreachable·retrying… — never
    // version or event counts.
    const HealthPill = () =>
      span(
        {
          "data-testid": "health-pill",
          class: () => `app-chip app-health${state.backendUp ? "" : " down"}`,
        },
        span({ class: () => `app-dot ${state.backendUp ? "g" : "r"}` }),
        () => {
          if (!state.backendUp) return "server unreachable · retrying…";
          const up = state.health?.uptime_s;
          return typeof up === "number"
            ? `server healthy · up ${uptimeLabel(up)}`
            : "server healthy · live";
        },
      );

    // §S5.1 — title bar: logo + slogan + Health Pill ONLY (no project chips).
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
        span({ class: "app-slogan" }, "where agentic TDD forges green"),
        HealthPill(),
      );

    // §S5.1 — projects row: canonical badge (name + type badge + liveness
    // dot); click drills down to /p/<key>, never filters.
    const ProjectBadge = (project) =>
      button(
        {
          "data-testid": "project-badge",
          class: `app-chip app-badge ${project.active === false ? "inactive" : "active"}`,
          onclick: () => navigate(`/p/${encodeURIComponent(project.key)}`),
        },
        span({ class: `app-dot ${project.active === false ? "o" : "g"}` }),
        project.name || project.key,
        span({ class: "app-type-badge" }, project.type),
      );

    const ProjectsRow = () =>
      div(
        { "data-testid": "projects-row", class: "app-top app-projects-row" },
        () =>
          div(
            { class: "app-badge-flow" },
            L.orderProjects([...state.projects]).map(ProjectBadge),
          ),
        // ⚙ manage chip — renders here; the manager surface lands in CR-CRU-012.
        button(
          { "data-testid": "manage-chip", class: "app-chip", title: "manage projects" },
          "⚙",
        ),
      );

    // §S5.1 — filter pulldown lives in the timeline pane's own header and
    // filters the collective home timeline in place (route stays "/").
    const FilterPulldown = () =>
      select(
        {
          "data-testid": "filter-pulldown",
          class: "app-filter",
          onchange: (e) => {
            state.selectedProject = e.target.value === "" ? null : e.target.value;
          },
        },
        option({ value: "", selected: state.selectedProject === null }, "All projects"),
        [...state.projects].map((p) =>
          option({ value: p.key, selected: state.selectedProject === p.key }, p.name || p.key),
        ),
      );

    // Card treatment (user-directed polish): agent rows share the project-card
    // family. §S5.2 — every agent row is a ⌁-marked (heat-amber) sub-row now,
    // rendered only inside the workspace Project pane; click filters the
    // visible timeline to that agent, in place.
    const AgentRow = (agent) => {
      const glyph = L.livenessGlyph(agent);
      const busy = agent.liveness === "online" && agent.status === "busy";
      return div(
        {
          "data-testid": "agent-row",
          class: () =>
            `app-agent-row app-card app-agent-subrow${glyph.tombstone ? " tombstoned" : ""}${
              state.selectedAgent === agent.agentId ? " on" : ""
            }`,
          onclick: () => {
            state.selectedAgent =
              state.selectedAgent === agent.agentId ? null : agent.agentId;
          },
        },
        span(
          { class: "app-agent-id" },
          span({ class: "app-agent-glyph" }, "⌁ "),
          glyph.tombstone
            ? span("⚰ ")
            : span({ class: `app-dot ${busy ? "r" : glyph.cls}` }),
          agent.identity?.displayName ?? agent.agentId,
        ),
        span({ class: "app-agent-msg" }, agent.message || "—"),
        // Small last-seen / died-ago line (card-meta family).
        glyph.tombstone
          ? span({ class: "app-card-meta" }, `died ${glyph.diedAgo}`)
          : agent.lastSeen !== undefined
            ? span({ class: "app-card-meta" }, `seen ${rel(agent.lastSeen)}`)
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

    // §S5.1 — home body: the collective all-projects timeline, interleaved
    // newest-first (server order), filter pulldown in this pane's header.
    const Timeline = () =>
      div(
        { "data-testid": "timeline", class: greyed("app-center") },
        div(
          { class: "app-timeline-head" },
          div({ class: "app-rail-title" }, "timeline"),
          () => FilterPulldown(),
        ),
        () =>
          state.backendUp ? span() : span({ class: "app-synced" }, syncedStamp()),
        () => EmptyState() ?? div(visibleEvents().map(EventCard)),
      );

    const Home = () => div({ class: "app-main app-home" }, Timeline());

    // ── Workspace (§S4 header/tabs/runs + §S5.2 Project pane) ───────────
    // §S5.4 — the workspace top bar carries ← projects + the current project
    // chip (name + type badge) + the Health Pill; no agent-count chip.
    const WorkspaceHeader = () =>
      div(
        { "data-testid": "workspace-header", class: "app-top" },
        button({ class: "app-chip", onclick: () => navigate("/") }, "← projects"),
        () => {
          const p = currentProject();
          return span(
            { class: "app-chip on" },
            p ? p.name || p.key : state.route.projectKey,
            span({ class: "app-type-badge" }, p ? p.type : ""),
          );
        },
        HealthPill(),
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
        { "data-testid": "vitals-rail", class: "app-rail-section" },
        div({ class: "app-rail-title" }, "vitals"),
        div({ class: "app-empty" }, "vitals land with the drill-in cycles"),
      );

    // §S5.2 — coverage meter on the project card (latest green coverage).
    const CoverageMeter = (coverage) => {
      const percent = coverage?.lines?.percent;
      if (typeof percent !== "number") {
        return div({ class: "app-card-meta" }, "no coverage yet");
      }
      return div(
        { class: "app-coverage" },
        div({ class: "app-card-meta" }, `coverage ${percent}%`),
        div(
          { class: "app-meter" },
          div({ class: "app-meter-fill", style: `width:${Math.min(100, percent)}%;` }),
        ),
      );
    };

    const ProjectPaneCard = (project) =>
      div(
        { class: "app-card app-pane-card" },
        div({ class: "app-card-name" }, project.name || project.key),
        div(
          { class: "app-card-meta" },
          `${project.type} · ${project.agentsOnline}/${project.agentsTotal} agents online`,
        ),
        div({ class: "app-card-meta" }, () => L.projectRollupLabel(project)),
        CoverageMeter(project.latestGreenCoverage),
      );

    // §S5.2 — the workspace's right rail: project card, then the project's
    // agents (live + tombstoned) as ⌁-marked indented sub-rows, then Vitals.
    // This pane exists ONLY inside the workspace.
    const ProjectPane = () =>
      div(
        { "data-testid": "project-pane", class: greyed("app-rail") },
        () => {
          const p = currentProject();
          return p === null ? div() : ProjectPaneCard(p);
        },
        div({ class: "app-agent-subrows" }, () =>
          visibleAgents().length === 0
            ? div({ class: "app-empty" }, "no agents yet")
            : div(visibleAgents().map(AgentRow)),
        ),
        VitalsRail(),
      );

    const WorkspaceBody = () => {
      if (state.workspaceTab === "Runs") return WorkspaceRuns();
      return div(
        { class: greyed("app-center") },
        div({ class: "app-empty" }, `${state.workspaceTab} lands in CR-CRU-007`),
      );
    };

    const Workspace = () =>
      div(
        { "data-testid": "workspace", class: "app-main" },
        div({ class: greyed("app-rail") }, WorkspaceTabs()),
        () => WorkspaceBody(),
        ProjectPane(),
      );

    // AC 10b(c) — the overlay sits on a scrim: a fixed full-viewport backdrop
    // whose outside-the-panel surface is a click target that closes the
    // overlay the same way Escape does. Styles are inline — the placeholder
    // panel had no positioning of its own to inherit.
    const RunOverlay = () =>
      div(
        {
          "data-testid": "run-overlay-scrim",
          class: "app-overlay-scrim",
          style:
            "position:fixed;inset:0;background:rgba(0,0,0,0.45);" +
            "display:flex;align-items:center;justify-content:center;z-index:20;",
          onclick: (e) => {
            if (e.target === e.currentTarget) closeOverlay();
          },
        },
        div(
          {
            "data-testid": "run-overlay",
            class: "app-rail",
            style: "min-width:320px;max-width:70vw;",
          },
          div({ class: "app-rail-title" }, () => `run · ${state.route.overlay}`),
          div({ class: "app-empty" }, "run detail lands in CR-CRU-007"),
        ),
      );

    // §S5.1/§S5.3 — home chrome is title bar + projects row; the workspace
    // swaps in its own top bar (← projects + project chip + Health Pill).
    const HomeChrome = () => div(TopBar(), ProjectsRow());

    const App = () =>
      div(
        () => (state.route.page === "workspace" ? WorkspaceHeader() : HomeChrome()),
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
