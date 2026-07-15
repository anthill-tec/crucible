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
    const { a, button, div, option, pre, select, span } = van.tags;

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
      if (hadOverlay && state.route.overlay === undefined) {
        restoreScroll();
      }
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

    // ── §S4.6 (CR-CRU-007) — density toggle: comfortable / compact / ultra,
    // independent of the drill-in's Detail↔Density switch. Persisted under
    // localStorage "crucible.density.mode"; the root class
    // `app-density-<mode>` on <html> drives row spacing (styles.css).
    const DENSITY_MODES = ["comfortable", "compact", "ultra"];
    const DENSITY_STORAGE_KEY = "crucible.density.mode";
    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    const densityMode = van.state(
      DENSITY_MODES.includes(storedDensity) ? storedDensity : "comfortable",
    );

    van.derive(() => {
      const root = document.documentElement;
      for (const known of DENSITY_MODES) root.classList.remove(`app-density-${known}`);
      root.classList.add(`app-density-${densityMode.val}`);
    });

    const DensityToggle = () =>
      button(
        {
          "data-testid": "density-toggle",
          "data-density": () => densityMode.val,
          class: "app-chip app-density-toggle",
          title: "row density",
          onclick: () => {
            const next =
              DENSITY_MODES[(DENSITY_MODES.indexOf(densityMode.val) + 1) % DENSITY_MODES.length];
            densityMode.val = next;
            window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
          },
        },
        () => `density: ${densityMode.val}`,
      );

    // Shared app logo — the workspace top bar renders the SAME element/class/
    // text as home (§S5 fidelity #6).
    const Logo = () =>
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
      );

    // §S5.1 — title bar: logo + slogan + Health Pill ONLY (no project chips,
    // no density toggle — §S5 fidelity #3: the toggle lives in pane headers).
    const TopBar = () =>
      div(
        { "data-testid": "app-topbar", class: "app-top" },
        Logo(),
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

    // ── §S1 (CR-CRU-007) — run card anatomy ─────────────────────────────
    function fmtDuration(ms) {
      const n = Math.max(0, Math.floor(ms));
      if (n < 1000) return `${n}ms`;
      const s = Math.floor(n / 1000);
      if (s < 60) return `${s}s`;
      return `${Math.floor(s / 60)}m ${s % 60}s`;
    }

    // Ratio pill: `N/N` green / `F ✗ of N` red / `E errors` amber (compile
    // cards NEVER show a test-ratio shape).
    const RatioPill = (e) => {
      if (e.kind === "compile") {
        return span(
          { "data-testid": "ratio-pill", class: "app-pill app-ratio-error" },
          `${e.errors ?? 0} errors`,
        );
      }
      if (e.failed > 0) {
        return span(
          { "data-testid": "ratio-pill", class: "app-pill app-ratio-fail" },
          `${e.failed} ✗ of ${e.total}`,
        );
      }
      return span(
        { "data-testid": "ratio-pill", class: "app-pill app-ratio-pass" },
        `${e.passed}/${e.total}`,
      );
    };

    // AC1 — context badges (branch@shortcommit + wave) render ONLY when the
    // event carries a context; a context-less card renders an empty badge
    // area (no placeholder text).
    const CardBadges = (e) =>
      div(
        { "data-testid": "card-badges", class: "app-card-badges" },
        e.context?.git !== undefined
          ? span(
              { "data-testid": "context-badge", class: "app-pill app-ctx-badge" },
              `${e.context.git.branch}@${String(e.context.git.commit).slice(0, 7)}`,
            )
          : null,
        e.context?.wave !== undefined && e.context?.wave !== null
          ? span(
              { "data-testid": "wave-badge", class: "app-pill app-ctx-badge" },
              `W${e.context.wave}`,
            )
          : null,
      );

    // Compile cards preview the first 2 diagnostics inline (`file:line — msg`).
    const DiagPreview = (e) =>
      e.kind === "compile" && Array.isArray(e.diagnostics) && e.diagnostics.length > 0
        ? div(
            { "data-testid": "diag-preview", class: "app-diag-preview" },
            e.diagnostics
              .slice(0, 2)
              .map((d) =>
                div(
                  { "data-testid": "diag-line", class: "app-diag-line" },
                  `${d.file}:${d.line} — ${d.message}`,
                ),
              ),
          )
        : null;

    // §S3 — a run card opens its drill-in: /run/<id> from home,
    // /p/<key>/run/<id> from the workspace (the overlay route suffix).
    function openDrillin(eventId) {
      const prefix =
        state.route.page === "workspace"
          ? `/p/${encodeURIComponent(state.route.projectKey)}`
          : "";
      navigate(`${prefix}/run/${encodeURIComponent(eventId)}`);
    }

    const EventCard = (e) =>
      div(
        {
          "data-testid": "event-card",
          class: "app-evt",
          onclick: () => openDrillin(e.id),
        },
        // §S1 — the kind icon is tinted by the agent's phase role (RED red /
        // GREEN green / VERIFY purple / FIX yellow); roleless stays neutral.
        // Tintable-icon contract: the wrapper carries the role color; the
        // glyph is a monochrome CSS-mask child painted `currentColor` —
        // never color-emoji text, which CSS `color` cannot tint.
        span(
          {
            "data-testid": "card-icon",
            "data-icon-tintable": "true",
            class: (() => {
              const role = L.phaseRole(e.agentId);
              return `app-card-icon${role !== null ? ` app-role-${role}` : ""}`;
            })(),
          },
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": e.kind === "compile" ? "compile" : "test",
          }),
        ),
        div(
          { class: "app-evt-body" },
          div(
            { class: "app-evt-line" },
            span({ class: "app-agent-id" }, e.agentId),
            span({ "data-testid": "tier-badge", class: "app-pill app-tier-badge" }, e.tier),
            e.codec !== undefined && e.codec !== null
              ? span({ "data-testid": "codec-badge", class: "app-pill app-codec-badge" }, e.codec)
              : null,
            CardBadges(e),
          ),
          div(
            { class: "app-evt-line app-card-meta" },
            span({ "data-testid": "card-time" }, rel(e.timestamp)),
            e.kind === "test"
              ? span({ "data-testid": "card-duration" }, fmtDuration(e.duration_ms ?? 0))
              : null,
          ),
          DiagPreview(e),
        ),
        RatioPill(e),
      );

    // ── §S2 (CR-CRU-007) — RED→GREEN transition markers (= Cycles) ──────
    // `RED f/t ➜ GREEN t/t · Cycle: "<label>" · <stem> · <tier> · closed in
    // <duration>` — the Cycle segment ONLY when the GREEN run's context.cycle
    // is present. Click opens the GREEN run's drill-in.
    function markerLabel(m) {
      const red = m.redEvent;
      const green = m.greenEvent;
      const parts = [`RED ${red.failed}/${red.total} ➜ GREEN ${green.passed}/${green.total}`];
      const cycle = green.context?.cycle;
      if (typeof cycle === "string" && cycle.length > 0) parts.push(`Cycle: "${cycle}"`);
      parts.push(m.stem);
      if (green.tier !== undefined) parts.push(green.tier);
      parts.push(`closed in ${fmtDuration(green.timestamp - red.timestamp)}`);
      return parts.join(" · ");
    }

    const TransitionMarkerRow = (m) =>
      div(
        {
          "data-testid": "transition-marker",
          class: "app-transition-marker",
          onclick: () => navigate(`/run/${encodeURIComponent(m.greenEvent.id)}`),
        },
        markerLabel(m),
      );

    // Feed rows: each Cycle's marker renders directly above its pair — i.e.
    // immediately before the GREEN run's card in the (newest-first) feed.
    function runFeed(events) {
      const markers = L.pairTransitions(events);
      const byGreenId = new Map(markers.map((m) => [m.greenEvent.id, m]));
      const rows = [];
      for (const e of events) {
        const marker = byGreenId.get(e.id);
        if (marker !== undefined) rows.push(TransitionMarkerRow(marker));
        rows.push(EventCard(e));
      }
      return rows;
    }

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
          // §S5 fidelity #4 — "Run timeline — <scope>": all projects, or the
          // filter pulldown's selected project.
          div({ "data-testid": "pane-heading", class: "app-rail-title" }, () => {
            const selected = state.projects.find((p) => p.key === state.selectedProject);
            return selected !== undefined
              ? `Run timeline — ${selected.name || selected.key}`
              : "Run timeline — all projects";
          }),
          // §S5 fidelity #3 — density toggle next to the filter pulldown.
          div({ class: "app-pane-controls" }, DensityToggle(), () => FilterPulldown()),
        ),
        () =>
          state.backendUp ? span() : span({ class: "app-synced" }, syncedStamp()),
        () => EmptyState() ?? div(runFeed(visibleEvents())),
      );

    const Home = () => div({ class: "app-main app-home" }, Timeline());

    // ── Workspace (§S4 header/tabs/runs + §S5.2 Project pane) ───────────
    // §S5.4 + fidelity #6 — the workspace top bar's locked composition:
    // logo FIRST (same element as home), then ← projects chip, then the
    // current project chip (name + type badge), then the Health Pill —
    // nothing else (no density toggle, no agent-count chip).
    const WorkspaceHeader = () =>
      div(
        { "data-testid": "workspace-header", class: "app-top" },
        Logo(),
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
        // §S1 addendum — pass the coverage field through so the Coverage tab
        // gates until the project has green-regression coverage.
        const tabs = L.workspaceTabs({
          type: project?.type ?? "backend",
          latestCoverageEventId: project?.latestCoverageEventId,
        });
        return div(
          tabs.map((t) =>
            button(
              {
                "data-testid": "workspace-tab",
                class: `app-chip${state.workspaceTab === t.name ? " on" : ""}${
                  t.disabled ? " disabled" : ""
                }`,
                disabled: t.disabled,
                title: t.hint ?? "",
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
        div(
          { class: "app-timeline-head" },
          // §S5 fidelity #4 — workspace Runs pane label; #3 — density toggle
          // in this pane's header.
          div({ "data-testid": "pane-heading", class: "app-rail-title" }, () => {
            const p = currentProject();
            return `Run timeline — ${p ? p.name || p.key : state.route.projectKey}`;
          }),
          div({ class: "app-pane-controls" }, DensityToggle()),
        ),
        () => {
          const runs = visibleEvents();
          return runs.length === 0
            ? div({ class: "app-empty" }, "no runs yet — ingest a run to light the forge")
            : div(runFeed(runs));
        },
      );

    // §S5 fidelity #5 — Vitals. CYCLE HEALTH renders from transition pairs
    // alone ("N RED→GREEN · median <duration>"), independent of coverage;
    // the coverage-trend card renders ONLY when coverage actually exists.
    function medianMs(values) {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((x, y) => x - y);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    const CycleHealthCard = () => {
      const pairs = L.pairTransitions(
        L.filterEvents(state.events, { projectKey: state.route.projectKey }),
      );
      return div(
        { "data-testid": "cycle-health-card", class: "app-card app-vitals-card" },
        div({ class: "app-card-name" }, "cycle health"),
        div(
          { class: "app-card-meta" },
          pairs.length === 0
            ? "no cycles yet"
            : `${pairs.length} RED→GREEN · median ${fmtDuration(
                medianMs(pairs.map((m) => m.greenEvent.timestamp - m.redEvent.timestamp)),
              )}`,
        ),
      );
    };

    const CoverageTrendCard = () => {
      const percent = currentProject()?.latestGreenCoverage?.lines?.percent;
      if (typeof percent !== "number") return null;
      return div(
        { "data-testid": "coverage-trend-card", class: "app-card app-vitals-card" },
        div({ class: "app-card-name" }, "coverage trend"),
        div({ class: "app-card-meta" }, `latest green coverage ${percent}%`),
      );
    };

    const VitalsRail = () =>
      div(
        { "data-testid": "vitals-rail", class: "app-rail-section" },
        div({ class: "app-rail-title" }, "vitals"),
        () => CycleHealthCard(),
        () => CoverageTrendCard() ?? span(),
      );

    // §S5.2 — coverage meter on the project card (latest green coverage).
    // Integration AC (§nav table): clicking the meter opens the drill-in of
    // the project's latest-green-coverage event; without one there is no
    // meter (and nothing clickable), just "no coverage yet".
    const CoverageMeter = (project) => {
      const percent = project.latestGreenCoverage?.lines?.percent;
      if (typeof percent !== "number") {
        return div({ class: "app-card-meta" }, "no coverage yet");
      }
      const eventId = project.latestCoverageEventId;
      const props = { "data-testid": "coverage-meter", class: "app-coverage" };
      if (eventId !== undefined && eventId !== null) {
        props.class = "app-coverage clickable";
        props.onclick = () =>
          navigate(
            `/p/${encodeURIComponent(project.key)}/run/${encodeURIComponent(eventId)}`,
          );
      }
      return div(
        props,
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
        CoverageMeter(project),
      );

    // §S5.2 — the workspace's right rail: project card, then the project's
    // agents (live + tombstoned) as ⌁-marked indented sub-rows, then Vitals.
    // This pane exists ONLY inside the workspace.
    const ProjectPane = () =>
      div(
        { "data-testid": "project-pane", class: greyed("app-pane") },
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

    // §S5 fidelity #1 — the workspace has NO left rail: the tabs row is a
    // full-width horizontal strip directly beneath the top bar, and the body
    // is exactly [main content | right Project pane], same on every tab.
    const Workspace = () =>
      div(
        { "data-testid": "workspace", class: "app-main" },
        WorkspaceTabs(),
        div(
          { "data-testid": "workspace-body", class: "app-workspace-body" },
          () => WorkspaceBody(),
          ProjectPane(),
        ),
      );

    // ── §S3 (CR-CRU-007) — codec-aware drill-in slide-over ──────────────
    // Test body: suite→test tree, suites-first (§S4.5 progressive payload —
    // ?depth=suites first, ?suite=<name> on expand; the server side landed
    // in CR-CRU-004 §S4, consumed here). F4 anatomy: flat mono TREE LINES
    // (▾/▸ suite headers with fail-first colored counts, colored leaf
    // glyphs), failing suites auto-expand, failed leaves show their failure
    // box inline (Detail), failures-footer with jump + raw toggle. Compile
    // body: diagnostics grouped by file + raw-output toggle.
    // §S4.0 FINAL — presentation is purely tier-contextual
    // (L.drillinDefaultMode(tier)): regression/e2e render Density,
    // unit/module/integration render Detail; NO mode switch exists.
    function drillinLeafGlyph(status) {
      if (status === "fail") return "✗";
      if (status === "pending") return "⏭";
      return "✓";
    }

    function countsOfLeaves(leaves) {
      const counts = { passed: 0, failed: 0, pending: 0 };
      for (const leaf of leaves ?? []) {
        if (leaf.status === "pass") counts.passed += 1;
        else if (leaf.status === "fail") counts.failed += 1;
        else counts.pending += 1;
      }
      return counts;
    }

    // §S4.4 — virtualized tree window: fixed row-count window over a suite's
    // (digested) entry list, positioned by scrollTop / row-height. Mounted
    // suite-row + leaf-row nodes stay well under 200 at any leaf count.
    const VIRT_ROW_HEIGHT = 28;
    const VIRT_WINDOW = 120;

    const RunOverlay = () => {
      const eventId = state.route.overlay;
      const detail = van.state(null); // suites-depth event detail
      const loadError = van.state(null);
      const suiteLeaves = van.state({}); // suiteName -> that suite's leaves
      const focusedLeaf = van.state(null); // "suite::leaf" — failure focus
      const openGroups = van.state({}); // §S4.3 — "suite::message" -> true
      const suiteWindow = van.state({}); // §S4.4 — suiteName -> window start index
      const showRaw = van.state(false);
      let jumpPos = 0; // failures-footer jump cursor

      // §S4.0 FINAL — purely tier-contextual presentation.
      const presentationOf = (ev) =>
        ev !== null && ev !== undefined && ev.kind === "test"
          ? L.drillinDefaultMode(ev.tier)
          : "Detail";

      // §S4.5 — the FIRST fetch is ?depth=suites (never the full leaf tree).
      (async () => {
        try {
          const res = await fetch(
            `/api/v2/events/${encodeURIComponent(eventId)}?depth=suites`,
          );
          const body = await res.json();
          const ev =
            body !== null && typeof body === "object" ? body.event : undefined;
          if (ev === undefined || ev === null) {
            loadError.val = "run detail unavailable";
            return;
          }
          detail.val = ev;
          // §S4.1/F4 (§S3: no cold-load carve-out) — failures float:
          // auto-expand ONLY the failing suites (fetch their leaves) on
          // EVERY open — in-app clicks AND cold deep-link mounts, both
          // presentations; all-pass suites stay folded and are never
          // fetched until clicked.
          autoExpandFailing(ev);
        } catch (err) {
          loadError.val = `run detail failed to load — ${String(err)}`;
        }
      })();

      // §S4.5 — a suite's leaves arrive only via ?suite=<name>.
      async function loadSuite(name) {
        if (suiteLeaves.val[name] !== undefined) return;
        try {
          const res = await fetch(
            `/api/v2/events/${encodeURIComponent(eventId)}?suite=${encodeURIComponent(name)}`,
          );
          const body = await res.json();
          const match = (body?.event?.tree ?? []).find((s) => s.name === name);
          suiteLeaves.val = { ...suiteLeaves.val, [name]: match?.children ?? [] };
        } catch (err) {
          loadError.val = `suite "${name}" failed to load — ${String(err)}`;
        }
      }

      // F4 — suite-row click expands (fetches) a collapsed suite; clicking
      // an already-expanded suite keeps it expanded (auto-expanded failing
      // suites stay open — status lives in the ▾/▸ affordance).
      async function expandSuite(name) {
        if (suiteLeaves.val[name] !== undefined) return;
        await loadSuite(name);
      }

      // §S4.1 — fetch (and thereby expand) exactly the failing suites.
      function autoExpandFailing(ev) {
        if (ev === null || ev === undefined || ev.kind !== "test") return;
        for (const name of L.foldSuites(ev.tree ?? [])) void loadSuite(name);
      }

      // F4 — a failed leaf's failure box: inline (no click) in Detail until
      // the user focuses a leaf; after any leaf click only the focused
      // failed leaf shows its box. Density starts with boxes closed —
      // heat-cell / leaf clicks focus-open them.
      function failureBoxVisible(key, presentation) {
        const focused = focusedLeaf.val;
        if (focused === null) return presentation === "Detail";
        return focused === key;
      }

      // One leaf row (+ its failure box when visible). Graceful degradation:
      // a failed leaf with NO failure data renders its ✗ line and no box.
      const LeafRows = (suiteName, leaf, presentation) => {
        const key = `${suiteName}::${leaf.name}`;
        const failed = leaf.status === "fail";
        const nodes = [
          div(
            {
              "data-testid": "leaf-row",
              "data-leaf-key": key, // §S4.4 — stable identity for the window
              class: `app-leaf-row app-tree-line app-leaf-${leaf.status} ${leaf.status}`,
              onclick: () => {
                focusedLeaf.val = key;
              },
            },
            span(
              { class: "app-leaf-name" },
              `${drillinLeafGlyph(leaf.status)} ${leaf.name}`,
            ),
            span({ class: "app-card-meta" }, fmtDuration(leaf.duration_ms ?? 0)),
          ),
        ];
        if (
          failed &&
          leaf.failure !== undefined &&
          leaf.failure !== null &&
          failureBoxVisible(key, presentation)
        ) {
          nodes.push(
            div(
              { "data-testid": "failure-box", class: "app-failure-box" },
              div({ class: "app-failure-message" }, leaf.failure.message),
              leaf.failure.trace !== undefined && leaf.failure.trace !== null
                ? div({ class: "app-failure-trace" }, leaf.failure.trace)
                : null,
            ),
          );
        }
        return nodes;
      };

      // §S4.3 — failure digest: identical-message failed leaves collapse to
      // one digest row + "+N identical" expander (Density mode only; the
      // grouping itself is L.digestFailures).
      const DigestRows = (suiteName, group, presentation) => {
        const groupKey = `${suiteName}::${group.message}`;
        const expanded = openGroups.val[groupKey] === true;
        const nodes = [
          div(
            { "data-testid": "digest-row", class: "app-digest-row" },
            span({ class: "app-digest-message" }, `✗ ${group.message}`),
            button(
              {
                "data-testid": "digest-expander",
                class: "app-chip app-digest-expander",
                onclick: () => {
                  const next = { ...openGroups.val };
                  if (next[groupKey] === true) delete next[groupKey];
                  else next[groupKey] = true;
                  openGroups.val = next;
                },
              },
              `+${group.extraCount} identical`,
            ),
          ),
        ];
        if (expanded) {
          for (const leaf of group.leaves) {
            nodes.push(...LeafRows(suiteName, leaf, presentation));
          }
        }
        return nodes;
      };

      // §S4.4 — one suite's (digested) entry list inside its virtualized
      // scroll container: only the VIRT_WINDOW entries at the current scroll
      // position mount; spacer divs keep the scrollbar honest.
      const SuiteLeafList = (suiteName, leaves, presentation) => {
        const entries =
          presentation === "Density"
            ? L.digestFailures(leaves)
            : leaves.map((leaf) => ({ kind: "leaf", leaf }));
        const total = entries.length;
        const start = Math.max(
          0,
          Math.min(suiteWindow.val[suiteName] ?? 0, Math.max(0, total - VIRT_WINDOW)),
        );
        const end = Math.min(total, start + VIRT_WINDOW);
        const rows = [];
        for (let i = start; i < end; i++) {
          const entry = entries[i];
          if (entry.kind === "group") {
            rows.push(...DigestRows(suiteName, entry, presentation));
          } else {
            rows.push(...LeafRows(suiteName, entry.leaf, presentation));
          }
        }
        return div(
          {
            "data-testid": "tree-scroll",
            class: "app-tree-scroll app-leaf-list",
            onscroll: (e) => {
              suiteWindow.val = {
                ...suiteWindow.val,
                [suiteName]: Math.floor((e.target.scrollTop ?? 0) / VIRT_ROW_HEIGHT),
              };
            },
          },
          div({ class: "app-virt-spacer", style: `height:${start * VIRT_ROW_HEIGHT}px;` }),
          rows,
          div({ class: "app-virt-spacer", style: `height:${(total - end) * VIRT_ROW_HEIGHT}px;` }),
        );
      };

      // §S4.2 — heat-strip minimap: one cell per test, any run size. Loaded
      // suites contribute identity-bearing cells (click scrolls to + expands
      // that test); folded suites synthesize cells from their counts (click
      // loads the suite).
      const HeatCell = (suiteName, leaf, index) =>
        span({
          "data-testid": "heat-cell",
          class: `app-heat-cell app-heat-${leaf.status === "fail" ? "fail" : leaf.status === "pending" ? "pending" : "pass"}`,
          title: `${suiteName} › ${leaf.name}`,
          onclick: () => {
            suiteWindow.val = {
              ...suiteWindow.val,
              [suiteName]: Math.max(0, index - Math.floor(VIRT_WINDOW / 2)),
            };
            if (leaf.status === "fail" && leaf.failure !== undefined) {
              openGroups.val = {
                ...openGroups.val,
                [`${suiteName}::${leaf.failure.message}`]: true,
              };
              focusedLeaf.val = `${suiteName}::${leaf.name}`;
            }
          },
        });

      const SynthHeatCell = (suiteName, status) =>
        span({
          "data-testid": "heat-cell",
          class: `app-heat-cell app-heat-${status}`,
          title: suiteName,
          onclick: () => void loadSuite(suiteName),
        });

      const HeatStrip = (d) => {
        const leavesMap = suiteLeaves.val;
        const cells = [];
        for (const suite of d.tree ?? []) {
          const leaves = leavesMap[suite.name];
          if (leaves !== undefined) {
            leaves.forEach((leaf, i) => cells.push(HeatCell(suite.name, leaf, i)));
          } else {
            const c = suite.counts ?? {};
            for (let i = 0; i < (c.failed ?? 0); i++) cells.push(SynthHeatCell(suite.name, "fail"));
            for (let i = 0; i < (c.pending ?? 0); i++) cells.push(SynthHeatCell(suite.name, "pending"));
            for (let i = 0; i < (c.passed ?? 0); i++) cells.push(SynthHeatCell(suite.name, "pass"));
          }
        }
        return div({ "data-testid": "heat-strip", class: "app-heat-strip" }, cells);
      };

      // F4½ — Density status chips row, above the heat-strip.
      const StatusChips = (d) => {
        const s = d.summary ?? {};
        return div(
          { "data-testid": "density-status-chips", class: "app-density-chips" },
          span({ class: "app-count-fail" }, `✗ failures ${s.failed ?? 0}`),
          " · ",
          span({ class: "app-count-pending" }, `⏭ pending ${s.pending ?? 0}`),
          " · ",
          span({ class: "app-count-pass" }, `✓ passed ${s.passed ?? 0}`),
        );
      };

      // F4 — suite-header inline counts: fail-first, per-status colored
      // spans (`F ✗ [P ⏭] P ✓`); a folded all-pass Density suite compacts
      // to its `✓N` counted row (§S4.1 green folds).
      const SuiteCountSpans = (counts, foldedAllPass) => {
        if (foldedAllPass) {
          return span(
            { class: "app-suite-counts app-count-pass" },
            `✓${counts.passed ?? 0}`,
          );
        }
        const parts = [
          span(
            { "data-testid": "suite-count-fail", class: "app-count-fail" },
            `${counts.failed ?? 0} ✗`,
          ),
          " ",
        ];
        if ((counts.pending ?? 0) > 0) {
          parts.push(
            span(
              { "data-testid": "suite-count-pending", class: "app-count-pending" },
              `${counts.pending} ⏭`,
            ),
            " ",
          );
        }
        parts.push(
          span(
            { "data-testid": "suite-count-pass", class: "app-count-pass" },
            `${counts.passed ?? 0} ✓`,
          ),
        );
        return span({ class: "app-suite-counts" }, parts);
      };

      // F4 — failures-footer (test events with ≥1 failure): jump advances to
      // the next failing leaf; the raw toggle reveals the stored raw output.
      function failingLeafKeys(d) {
        const keys = [];
        for (const suite of d.tree ?? []) {
          const leaves = suiteLeaves.val[suite.name];
          if (leaves === undefined) continue;
          for (const leaf of leaves) {
            if (leaf.status === "fail") keys.push(`${suite.name}::${leaf.name}`);
          }
        }
        return keys;
      }

      function jumpToNextFailure(d) {
        const keys = failingLeafKeys(d);
        if (keys.length === 0) return;
        jumpPos = (jumpPos + 1) % keys.length;
        const target = keys[jumpPos];
        const rows = document.querySelectorAll('[data-testid="leaf-row"]');
        for (const row of rows) {
          if (row.getAttribute("data-leaf-key") === target) {
            if (typeof row.scrollIntoView === "function") row.scrollIntoView();
            break;
          }
        }
      }

      const FailuresFooter = (d) => {
        const failed = d.summary?.failed ?? 0;
        if (failed < 1) return null;
        return div(
          { "data-testid": "failures-footer", class: "app-failures-footer" },
          button(
            {
              "data-testid": "failure-jump",
              class: "app-chip app-footer-chip",
              onclick: () => jumpToNextFailure(d),
            },
            `▸ ${failed - 1} more failures`,
          ),
          " · ",
          button(
            {
              "data-testid": "raw-toggle",
              class: "app-chip app-footer-chip",
              onclick: () => {
                showRaw.val = !showRaw.val;
              },
            },
            "toggle raw output",
          ),
        );
      };

      // Suite tree — §S4.0 FINAL: the tier decides everything. Detail (unit/
      // module/integration) renders the plain tree; Density (regression/e2e)
      // adds the status chips (F4½), heat-strip (§S4.2), failure digest
      // (§S4.3) and failures-float folding (§S4.1). Virtualization (§S4.4)
      // applies in BOTH presentations.
      const TestBody = (d) => {
        const presentation = presentationOf(d);
        const density = presentation === "Density";
        const leavesMap = suiteLeaves.val;
        return div(
          { class: "app-drillin-tree" },
          density ? StatusChips(d) : null,
          density ? HeatStrip(d) : null,
          (d.tree ?? []).map((suite) => {
            const leaves = leavesMap[suite.name];
            const expanded = leaves !== undefined;
            const counts = suite.counts ?? countsOfLeaves(leaves ?? suite.children);
            const foldedAllPass = density && !expanded && (counts.failed ?? 0) === 0;
            return div(
              { class: "app-suite-group" },
              div(
                {
                  "data-testid": "suite-row",
                  class: `app-suite-row app-tree-line ${suite.status}`,
                  onclick: () => expandSuite(suite.name),
                },
                span(
                  { "data-testid": "tree-toggle", class: "app-tree-toggle" },
                  expanded ? "▾" : "▸",
                ),
                span({ class: "app-suite-name" }, suite.name),
                SuiteCountSpans(counts, foldedAllPass),
              ),
              expanded ? SuiteLeafList(suite.name, leaves, presentation) : null,
            );
          }),
          FailuresFooter(d),
          showRaw.val && typeof d.raw === "string"
            ? pre({ "data-testid": "raw-output", class: "app-raw-output" }, d.raw)
            : null,
        );
      };

      // Compile body — diagnostics grouped by file, level-colored lines,
      // raw-output toggle. No mode switch renders for compile events.
      const CompileBody = (d) => {
        const compile = d.compile ?? {};
        const groups = new Map();
        for (const diag of compile.diagnostics ?? []) {
          const file = diag.file ?? "(unknown file)";
          if (!groups.has(file)) groups.set(file, []);
          groups.get(file).push(diag);
        }
        return div(
          { class: "app-drillin-diags" },
          [...groups.entries()].map(([file, lines]) =>
            div(
              { "data-testid": "diag-group", class: "app-diag-group" },
              div({ class: "app-diag-file" }, file),
              lines.map((diag) =>
                div(
                  {
                    "data-testid": "diag-line",
                    class: `app-diag-line app-diag-${diag.level}`,
                  },
                  `${file}:${diag.line}:${diag.col} — ${diag.message}`,
                ),
              ),
            ),
          ),
          button(
            {
              "data-testid": "raw-toggle",
              class: "app-chip app-raw-toggle",
              onclick: () => {
                showRaw.val = !showRaw.val;
              },
            },
            showRaw.val ? "hide raw output" : "show raw output",
          ),
          showRaw.val
            ? pre(
                { "data-testid": "raw-output", class: "app-raw-output" },
                compile.raw ?? "",
              )
            : null,
        );
      };

      // AC 10b(c) — the overlay sits on a scrim: a fixed full-viewport
      // backdrop whose outside-the-panel surface closes the overlay the
      // same way Escape does.
      return div(
        {
          "data-testid": "run-overlay-scrim",
          class: "app-overlay-scrim",
          style: "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:20;",
          onclick: (e) => {
            if (e.target === e.currentTarget) closeOverlay();
          },
        },
        // §S5 fidelity #2 — the drill-in is a RIGHT-HAND SLIDE-OVER sheet:
        // anchored to the right edge, full viewport height, ember left
        // border (styles.css .app-slideover-right).
        div(
          {
            "data-testid": "run-overlay",
            class: "app-drillin app-slideover-right",
            style:
              "position:fixed;top:0;right:0;bottom:0;" +
              "width:min(720px,92vw);z-index:21;",
          },
          // §S5.3 — '← timeline' back chip: closes exactly like Escape
          // (same closeOverlay — same route/scroll restore).
          // §S4.0 FINAL — no mode switch here (or anywhere): presentation is
          // purely tier-contextual. Header: back chip + title + density toggle.
          div(
            { class: "app-drillin-head" },
            button(
              { class: "app-chip", onclick: () => closeOverlay() },
              "← timeline",
            ),
            span({ class: "app-rail-title" }, `Run detail · ${eventId}`),
            // §S5 fidelity #3 — the density toggle renders in the drill-in
            // header (comfortable/compact/ultra — the only user control).
            DensityToggle(),
          ),
          () => {
            if (loadError.val !== null)
              return div({ class: "app-empty" }, loadError.val);
            const d = detail.val;
            if (d === null)
              return div({ class: "app-empty" }, "loading run detail…");
            return d.kind === "compile" ? CompileBody(d) : TestBody(d);
          },
        ),
      );
    };

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
