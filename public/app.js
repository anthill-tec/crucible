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
    const { a, b, button, div, input, label, option, pre, select, span } = van.tags;

    // ── State ───────────────────────────────────────────────────────────
    const state = vanX.reactive({
      projects: [],
      agents: [],
      events: [],
      plans: [], // CR-CRU-011 §S3 — the workspace project's cycle plans
      // CR-CRU-014 §S3 — the Roadmap tab's data slices: the execution queue
      // (GET /api/v2/projects/<key>/queue, §S1) and the release ledger
      // (GET /api/v2/projects/<key>/releases, CR-CRU-074). vanX reactive
      // arrays, refetched over the same cadence as plans while a workspace
      // is open, so the roadmap table + live overlay stay current.
      queue: [],
      releases: [],
      // CR-CRU-078 §S9 — the release strip's SECOND read: the LIVE release
      // proposals (GET /api/v2/projects/<key>/release-proposals, CR-CRU-091
      // §S8, answering `{ok, proposals:[{label, targetAt?, timestamp,
      // waves[]}], totalCount}`). Held SEPARATELY from `releases` and
      // concatenated only at render: CR-091 §S1 fixed the two reads' sort
      // directions deliberately opposite — `listReleases` newest-first,
      // `listReleaseProposals` ascending by version — so a consumer appends
      // "shipped, then proposed" with NO reversal, and merging them here
      // would throw that away. Records are held VERBATIM: `targetAt` is
      // optional (an absent target must stay absent, never 0/1970) and in
      // epoch SECONDS like `releasedAt`, `waves` is joined server-side so
      // five clients cannot join it differently, and there is no `status` —
      // every returned proposal is live by construction.
      releaseProposals: [],
      // CR-CRU-017 §S3 — the runs opened through /runs/start that have NOT
      // settled yet, as served by the additive `openRuns` field on
      // GET /api/v2/events. Each one is painted as a live "running…" card and
      // leaves this slice the moment its ingest (or the server's auto-abort)
      // turns it into a real event — which is what makes the card resolve IN
      // PLACE with no reload. A vanX reactive array, replaced wholesale on
      // every refetch tick exactly like `events`.
      openRuns: [],

      health: null,
      selectedProject: null, // home filter pulldown (null = all projects)
      selectedAgent: null, // agent sub-row click filter (null = all)
      route: L.routeParse(location.pathname),
      workspaceTab: "Workflow",
      backendUp: true,
      lastSynced: null,
      // CR-CRU-025 §S2b — the Run Timeline accordion's per-cycleId collapse
      // set (cycleIds whose declared-marker is currently collapsed). Pure UI
      // session state: default EMPTY (everything expanded), no URL/persistence,
      // and untouched by refetchCore/refetchPlans — so a poll/SSE re-render
      // naturally preserves it. A vanX reactive array so a toggle re-runs the
      // Runs feed binding (mutated via vanX.replace, like state.events).
      collapsedCycles: [],
      // CR-CRU-032 §S3 — the cycleId whose `→ Runs` anchor-fetch resolved
      // empty with NO `cycle` field (server-confirmed truly-pruned boundary),
      // so the Runs pane can surface explicit "pruned" feedback instead of a
      // silent tab-switch-and-nothing. null = no pending feedback.
      anchorFeedback: null,
      // CR-CRU-032 §S3 (VERIFY 1B) — the set of cycleIds whose `→ Runs`
      // anchor-fetch came back server-confirmed truly-pruned (empty events,
      // NO `cycle` field). Unlike the transient `anchorFeedback` (cleared on
      // the next click), this is a STORED, permanent per-cycle verdict: once
      // a boundary is confirmed pruned its `→ Runs` pill renders DIM for good.
      // A vanX reactive array (mutated via vanX.replace, like collapsedCycles)
      // so the Workflow binding re-runs and the pill flips dim on confirm.
      prunedCycles: [],
      // CR-CRU-028 §S2 — the OPEN coverage-trend drill PATH: the representative
      // `day` of the open bucket at each depth (index 0 = the top-level bar,
      // index 1 = the revealed bar unfolded inside it, …), so the drill-down
      // CASCADES month→week→day→heat strip (DN §3.3). Accordion PER DEPTH: at
      // most one branch open at each depth (opening a sibling at depth d
      // truncates the path to d and drops anything deeper). [] = nothing
      // unfolded. A reactive array (reassigned wholesale, like a scalar) so a
      // click re-renders the CoverageTrendCard.
      coverageDrillPath: [],
    });

    // CR-CRU-014 §S3 — a cold /p/<key>/roadmap deep-link lands on the Roadmap
    // tab (mirrors how a /run/<id> deep-link lands the run overlay); every
    // other workspace entry keeps the Workflow primary default.
    if (state.route.roadmap === true) state.workspaceTab = "Roadmap";

    // ── Routing (§S2 — hash-free History routing, parse in app-logic) ───
    // CR-CRU-016 §S1 — the run detail is a PANE STATE of the ACTIVE central
    // pane (home timeline / workspace Runs / Compile / Coverage). The pane's
    // OWN scroller position is captured when a detail opens and restored
    // when it closes — the window never scrolls (styles.css app frame).
    let savedPaneScroll = 0;

    // The active central pane's scroller element: the home timeline pane on
    // "/", else whichever tab pane currently fills the workspace body.
    // CR-CRU-029 §S1 — the active pane's SCROLLER is now the bounded
    // `[data-testid="pane-scroll"]` box itself (mechanism a), not the outer
    // `.app-center` wrapper (which no longer scrolls). Exactly one pane-scroll
    // renders per route, so its scrollTop is the reading position CR-016 AC2
    // saves/restores.
    function activePaneEl() {
      return document.querySelector('[data-testid="pane-scroll"]');
    }

    function navigate(pathname) {
      const next = L.routeParse(pathname);
      // CR-CRU-016 AC2 — opening a detail: remember the ACTIVE pane's own
      // scrollTop so closing can restore the feed at its exact position.
      const opening = next.overlay !== undefined && state.route.overlay === undefined;
      if (opening) {
        const pane = activePaneEl();
        savedPaneScroll = pane === null ? 0 : pane.scrollTop;
      }
      // ONE RULE (CR-CRU-016 §S1, user-approved 2026-07-16) — navigation
      // within the SAME surface (detail open/close, tab-owned pane swaps)
      // never touches the active workspace tab or the agent filter; only a
      // surface change (home↔workspace, project→project) lands on Workflow
      // (the CR-CRU-021 §S1 primary tab).
      const sameSurface =
        next.page === state.route.page &&
        (next.page !== "workspace" || next.projectKey === state.route.projectKey);
      history.pushState(null, "", pathname);
      state.route = next;
      if (!sameSurface) {
        state.workspaceTab = "Workflow";
        state.selectedAgent = null;
        scopeChanged();
      }
    }

    // CR-CRU-026 §S1 — a scope-changing transition (home↔workspace,
    // project→project; click-driven OR popstate) synchronously removes the
    // previous scope's plan data — no frame may paint another project's
    // plans — and, when landing on a workspace, immediately fires the scoped
    // plans fetch plus the core refetch slice. SSE/poll stays the
    // steady-state refresh; navigation no longer depends on it.
    function scopeChanged() {
      vanX.replace(state.plans, () => []);
      vanX.replace(state.queue, () => []);
      vanX.replace(state.releases, () => []);
      // CR-CRU-078 §S9 — the proposals slice is cleared with `releases`, in
      // the same synchronous scope-change step: a project switch whose
      // proposals read then fails or lags must not leave the previous
      // project's plan painted under this one's shipped gates.
      vanX.replace(state.releaseProposals, () => []);
      // CR-CRU-028 §S2 — bucket keys (YYYY-MM-DD / week-N / month-YYYY-MM) are
      // deterministic and collide across projects, so a leftover open drill
      // path would render a row pre-unfolded on the newly-navigated project.
      // Reset the coverage drill closed on every scope change (both click-nav
      // and popstate route here), symmetric with the plan-data clear above.
      state.coverageDrillPath = [];
      // CR-CRU-026 §S3.2 — refetchPlans is surface-aware (home → the global
      // route, workspace → the scoped one), so EVERY scope change refetches
      // the landing surface's plan slice. CR-CRU-032 §S4 made state.events
      // surface-scoped (refetchCore REPLACES the shared feed with a
      // surface-scoped set), so the core slice must ALSO refetch on EVERY
      // scope change, symmetric with refetchPlans: a home landing re-fetches
      // the global ?limit=50 feed to restore the collective marker
      // vocabulary (CR-026 §S0 equivalence), not just a workspace landing.
      void refetchPlans();
      void refetchCore();
      void refetchRoadmap();
    }

    // CR-CRU-016 AC2 — close the detail back to the underlying surface path
    // (strip the /run/<id> suffix); the pane's saved scrollTop is restored
    // by paneSwap when the feed re-mounts (also covers browser-back).
    function closeDetail() {
      if (state.route.overlay === undefined) return;
      // CR-CRU-038 §S3 — drop the shared RunDetailBody so a reopen builds a
      // fresh body (fresh ?depth=suites fetch + fresh showRaw/expand state).
      openDetailKey = undefined;
      openDetailBody = null;
      const base = location.pathname.replace(/\/run\/[^/]+\/?$/, "") || "/";
      history.pushState(null, "", base);
      state.route = L.routeParse(base);
    }

    window.addEventListener("popstate", () => {
      // CR-CRU-026 §S1 — popstate parity: back/forward across scopes gets
      // the same clear + scoped-refetch treatment as navigate().
      const prev = state.route;
      const next = L.routeParse(location.pathname);
      state.route = next;
      const sameSurface =
        next.page === prev.page &&
        (next.page !== "workspace" || next.projectKey === prev.projectKey);
      if (!sameSurface) scopeChanged();
    });

    // CR-CRU-012 §S2 — close the Projects manager slide-over back to home
    // (history-consistent: same pushState + route-state shape as closeDetail).
    function closeManager() {
      if (state.route.manage !== true) return;
      history.pushState(null, "", "/");
      state.route = L.routeParse("/");
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.route.overlay !== undefined) closeDetail();
      else if (state.route.manage === true) closeManager();
    });

    // ── Data plumbing (§S5 — v2 surface only) ───────────────────────────
    async function getJson(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return res.json();
    }

    async function refetch() {
      await refetchCore();
      await refetchPlans();
      await refetchRoadmap();
    }

    // CR-CRU-026 §S1 — the core slice (projects/agents/events/health) split
    // out of refetch() so a scope-changing navigation can fire it alongside
    // refetchPlans() without double-fetching the plans route.
    async function refetchCore() {
      try {
        // CR-CRU-032 §S4 — the workspace Runs window is governed by the routed
        // project's own `retention`. Load projects FIRST so state.projects is
        // populated before we size the events window from it (on a cold
        // workspace mount the boot refetch runs before any project is known).
        const projects = await getJson("/api/v2/projects");
        vanX.replace(state.projects, () => projects.projects ?? []);

        // Surface-aware events fetch (mirrors refetchPlans' §S3.2 split): a
        // WORKSPACE scopes the call to its project and caps it at that
        // project's `retention` (falling back to MANAGER_RETENTION_DEFAULT
        // when unset or not yet loaded); HOME keeps the unchanged collective
        // recent-50 call byte-for-byte.
        let eventsUrl = "/api/v2/events?limit=50";
        if (state.route.page === "workspace") {
          const key = state.route.projectKey;
          const routed = state.projects.find((p) => p.key === key);
          const retention = routed?.retention ?? MANAGER_RETENTION_DEFAULT;
          eventsUrl = `/api/v2/events?project=${encodeURIComponent(key)}&limit=${retention}`;
        }

        const [agents, events, health] = await Promise.all([
          getJson("/api/v2/agents"),
          getJson(eventsUrl),
          getJson("/api/v2/health"),
        ]);
        vanX.replace(state.agents, () => agents.agents ?? []);
        vanX.replace(state.events, () => events.events ?? []);
        // CR-CRU-017 §S3 — same feed, same tick: the running cards and the
        // settled cards can never disagree about a run, because one response
        // carries both. A server without the field degrades to no running
        // cards, never to a stale one.
        vanX.replace(state.openRuns, () => events.openRuns ?? []);
        state.health = health;
        state.backendUp = true;
        state.lastSynced = Date.now();
      } catch {
        // Reachability is owned by the watchdog below; keep stale data visible.
      }
    }

    // CR-CRU-011 §S3 — the Workflow tab's plan slice (the C1 project-scoped
    // route). Fetched on every refetch tick while a workspace is open, so the
    // active todo view refreshes over the SAME SSE/poll cadence as the feed.
    // Guarded separately from the core slice: a plans failure never poisons
    // projects/agents/events, and reachability stays the watchdog's concern.
    // CR-CRU-026 §S3.2 — surface-aware: a workspace stays on the C1
    // project-scoped route; every other surface (home) reads the additive
    // global `GET /api/v2/plans` (all non-archived projects' plans), so the
    // home timeline gets declared plan data over the same refetch cadence.
    async function refetchPlans() {
      const url =
        state.route.page === "workspace"
          ? `/api/v2/projects/${encodeURIComponent(state.route.projectKey)}/plans`
          : "/api/v2/plans";
      try {
        const body = await getJson(url);
        vanX.replace(state.plans, () => body.plans ?? []);
      } catch {
        // Keep the last-known plans visible while the route is unreachable.
      }
    }

    // CR-CRU-014 §S3 — the Roadmap tab's queue + releases slices, plus
    // CR-CRU-078 §S9's release-proposals slice. Only a workspace has a scoped
    // queue/release ledger; on home all three stay empty.
    // Guarded independently of core/plans so a queue hiccup never poisons
    // the rest of the surface, and the last-known table survives a blip.
    async function refetchRoadmap() {
      if (state.route.page !== "workspace") {
        vanX.replace(state.queue, () => []);
        vanX.replace(state.releases, () => []);
        vanX.replace(state.releaseProposals, () => []);
        return;
      }
      const key = encodeURIComponent(state.route.projectKey);
      try {
        const body = await getJson(`/api/v2/projects/${key}/queue`);
        vanX.replace(state.queue, () => body.entries ?? []);
      } catch {
        // Keep the last-known queue visible while the route is unreachable.
      }
      try {
        const body = await getJson(`/api/v2/projects/${key}/releases`);
        vanX.replace(state.releases, () => body.releases ?? []);
      } catch {
        // Keep the last-known releases visible while the route is unreachable.
      }
      try {
        // CR-CRU-078 §S9 / CR-CRU-091 §S8 — the strip's second read, on the
        // SAME path and cadence as the ledger above so the two halves of one
        // sequence can never be a tick apart. Its own try/catch: the reads
        // fail INDEPENDENTLY, and shipped gates with proposals unavailable is
        // a legitimate degraded strip (never the AC19 empty state, which
        // means nothing is registered at all).
        const body = await getJson(`/api/v2/projects/${key}/release-proposals`);
        vanX.replace(state.releaseProposals, () => body.proposals ?? []);
      } catch {
        // Degraded, not broken: keep the last-known proposals and leave
        // state.releases entirely alone. No sentinel, no error state — this
        // cycle renders nothing, and a banner over working data is precisely
        // what §S9 forbids.
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
      // CR-CRU-011 §S1/§S2 (DRIFT-4) — lifecycle events are data for runtime
      // computation and the workflow lens, never Runs-timeline cards.
      return L.filterEvents(state.events, activeFilters()).filter(
        (e) => e.kind !== "lifecycle",
      );
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
        // ⚙ manage chip — opens the Projects manager slide-over (CR-CRU-012
        // §S2, F12) at /manage.
        button(
          {
            "data-testid": "manage-chip",
            class: "app-chip",
            title: "manage projects",
            onclick: () => navigate("/manage"),
          },
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
        // CR-CRU-011 §S2 — server-computed runtime: live rows tick with each
        // refetched runtime_ms; tombstoned rows render the sealed value.
        typeof agent.runtime_ms === "number"
          ? span(
              { "data-testid": "agent-runtime", class: "app-card-meta" },
              fmtDuration(agent.runtime_ms),
            )
          : null,
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

    // CR-CRU-021 §S3 — cycle-timer format: OWN zero-padded-seconds form
    // (`⏱ 4m 05s`, F13 contract), deliberately NOT fmtDuration (which
    // renders `4m 5s`).
    function fmtCycleTimer(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      return `⏱ ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    }

    // §S3 (cycle 18, live-review defect) — the ACTIVE badge must SELF-TICK:
    // recomputing `Date.now()` only at render time froze the badge whenever
    // no poll/SSE tick observed changed data. A SINGLETON module-level 10s
    // interval bumps `tickNow`; each active badge's text is a van-derived
    // binding on it, so ONLY the timer text re-derives — never a whole-pane
    // rebuild, and no per-mount/per-row interval accumulation across pane
    // swaps (created exactly once here, at module init).
    const tickNow = van.state(Date.now());
    setInterval(() => {
      tickNow.val = Date.now();
    }, 10_000);

    // CR-CRU-017 §S3 — a RUN's elapsed timer needs SECOND resolution: a run is
    // over in seconds, so the cycle badge's 10s cadence would render a card
    // that looks frozen for most of its life. Its own singleton 1s interval,
    // created once at module init for the same reason `tickNow` is: the ticking
    // text is a van-derived binding, so a tick with no running card mounted
    // re-derives nothing at all.
    const runTickNow = van.state(Date.now());
    setInterval(() => {
      runTickNow.val = Date.now();
    }, 1000);

    // §S3 — active-cycle timer: an ACTIVE cycle ticks `now − activatedAt`
    // (ember badge; `tickNow` supplies the visible updating at a ≤10s
    // cadence, on top of the poll/SSE refetch cadence);
    // a terminal cycle shows the sealed `doneAt − activatedAt` (dim, never
    // advancing). Cycles predating the timestamp migration (no activatedAt,
    // or terminal without doneAt) render NO timer — never a fabricated value.
    const CycleTimer = (cycle) => {
      if (cycle.activatedAt === undefined) return null;
      if (cycle.status === "active") {
        // CR-CRU-023 §S3 (a) — the ticking badge derives from the SERVER-fed
        // accumulated attention time (`activeMs`, restart-resume semantics),
        // advanced locally by `tickNow` from the render instant between
        // polls — NEVER from wall-clock-since-activatedAt (which reads
        // downtime as attention). Pre-epoch payloads without `activeMs`
        // fall back to the wall-clock base, which reduces this derivation
        // exactly to the previous `tickNow − activatedAt` behavior.
        const renderedAt = Date.now();
        const baseMs =
          cycle.activeMs !== undefined ? cycle.activeMs : renderedAt - cycle.activatedAt;
        return span(
          { "data-testid": "cycle-timer", class: "app-cycle-timer-slot app-cycle-timer-ember" },
          () => fmtCycleTimer(baseMs + (tickNow.val - renderedAt)),
        );
      }
      if (cycle.doneAt === undefined) return null;
      return span(
        {
          "data-testid": "cycle-timer",
          class: "app-card-meta app-cycle-timer-slot app-cycle-timer-sealed",
        },
        fmtCycleTimer(cycle.doneAt - cycle.activatedAt),
      );
    };

    // Ratio pill — UNIVERSAL status palette (user-corrected 2026-07-15):
    // `N/N` pass-green / `F ✗ of N` fail-red / compile `E errors` fail-red
    // when E>0 and pass-green when clean (compile cards NEVER show a
    // test-ratio shape; the amber compile pill is retired).
    const RatioPill = (e) => {
      if (e.kind === "compile") {
        const errors = e.errors ?? 0;
        return span(
          {
            "data-testid": "ratio-pill",
            class: `app-pill ${errors > 0 ? "app-ratio-fail" : "app-ratio-pass"}`,
          },
          `${errors} errors`,
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

    // CR-CRU-016 §S4 F7 (user defect 2026-07-16) — regression-run
    // differentiation on the CARD: a `regression`-tier event whose brief
    // carries `coverageLines` reads codec `<codec>+lcov` and renders an
    // inline mini coverage meter. Gated on tier:"regression", not merely
    // coverage presence (a unit run's coverage never decorates its card).
    const cardCoverage = (e) =>
      e.tier === "regression" && typeof e.coverageLines === "number"
        ? e.coverageLines
        : null;

    // F7 card meter — same `.app-meter` anatomy as the Project pane's
    // coverage meter, inline on the card, fill width = lines percent.
    const CardCoverageMeter = (percent) =>
      div(
        { "data-testid": "card-coverage-meter", class: "app-meter app-card-meter" },
        div({
          class: "app-meter-fill",
          style: `width:${Math.min(100, percent)}%;`,
        }),
      );

    // CR-CRU-044 §S2 / CR-CRU-057 §S2 — an event is tinted by a STORED role,
    // never by the shape of its agentId. A LIVE agent's declaration wins (it is
    // resolved off the `state.agents` slice by agentId, the same lookup
    // CrAgentRuntime uses); once that agent unregisters its record is gone, so
    // classification falls through to the role stamped onto the EVENT itself
    // at ingest time (§S1), which outlives the agent. Neither present -> the
    // event is simply unclassified.
    const eventRoleDecl = (e) => {
      const live = state.agents.find((a) => a.agentId === e.agentId)?.role;
      if (live !== undefined && live !== null) return { role: live, inferred: false };
      const stored = e.role;
      if (stored === undefined || stored === null) return { role: null, inferred: false };
      // §S4 — a role recovered by the one-time backfill is DOM-distinguishable
      // from a declared one, so backfilled history is never read as declared.
      return { role: stored, inferred: e.roleInferred === true };
    };

    const eventRole = (e) => L.agentRole({ agentId: e.agentId, role: eventRoleDecl(e).role });

    // The tintable card-icon wrapper, shared by every run-entry render site.
    const eventIconProps = (e) => {
      const { inferred } = eventRoleDecl(e);
      const role = eventRole(e);
      const props = {
        "data-testid": "card-icon",
        "data-icon-tintable": "true",
        class: `app-card-icon${role !== null ? ` app-role-${role}` : ""}`,
      };
      if (inferred) props["data-role-inferred"] = "true";
      return props;
    };

    const EventCard = (e) =>
      div(
        {
          "data-testid": "event-card",
          // CR-CRU-019 §P1 AC-3 — the card is addressable by its run id, so
          // declared-span membership is assertable against real ingested runs.
          "data-run-id": e.id,
          class: "app-evt",
          onclick: () => openDrillin(e.id),
        },
        // §S1 — the kind icon is tinted by the agent's declared role (RED red /
        // GREEN green / VERIFY purple / FIX yellow); roleless stays neutral.
        // CR-CRU-044 §S2 / CR-CRU-057 §S2 — the tint comes from a stored
        // role only: the live agent's, else the event's own stamped one.
        // Tintable-icon contract: the wrapper carries the role color; the
        // glyph is a monochrome CSS-mask child painted `currentColor` —
        // never color-emoji text, which CSS `color` cannot tint.
        span(
          eventIconProps(e),
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
              ? span(
                  { "data-testid": "codec-badge", class: "app-pill app-codec-badge" },
                  // §S4 F7 — the +lcov suffix marks a coverage-bearing
                  // regression run's codec.
                  cardCoverage(e) !== null ? `${e.codec}+lcov` : e.codec,
                )
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
          cardCoverage(e) !== null ? CardCoverageMeter(cardCoverage(e)) : null,
          DiagPreview(e),
        ),
        RatioPill(e),
      );

    // ── CR-CRU-017 §S3 — the run lifecycle's two extra presentations ─────
    //
    // A RUNNING card and an ABORTED card sit BESIDE the pass/fail/pending
    // palette, never inside it: an open run has no result yet, and an aborted
    // run ended for non-test reasons (§S2), so neither may borrow a ratio pill
    // or a pass/fail tint. Both are additive — `EventCard` above is unchanged
    // for every run that passed, failed or is pending.

    /** The live `⏱ 0m 07s` since `startedAt`, re-derived once a second. */
    const RunningElapsed = (startedAt) =>
      span(
        { "data-testid": "running-elapsed", class: "app-running-elapsed" },
        () => fmtCycleTimer(runTickNow.val - startedAt),
      );

    // §S3 — the open run's card: pulsing, elapsed timer off the SERVER's
    // `startedAt`, and NOT CLICKABLE (user rule). "Not clickable" is enforced
    // where it cannot drift: there is NO `onclick` handler at all, so no
    // drill-in exists to fire, and the card's own class carries the default
    // cursor. It resolves in place because the next refetch drops this run from
    // `state.openRuns` in the same tick the settled event enters `state.events`.
    const RunningCard = (run) =>
      div(
        {
          "data-testid": "running-card",
          "data-run-id": run.runId,
          class: "app-evt app-evt-running",
        },
        span(
          eventIconProps(run),
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": "test",
          }),
        ),
        div(
          { class: "app-evt-body" },
          div(
            { class: "app-evt-line" },
            span({ class: "app-agent-id" }, run.agentId),
            run.tier !== undefined && run.tier !== null
              ? span({ "data-testid": "tier-badge", class: "app-pill app-tier-badge" }, run.tier)
              : null,
          ),
          div(
            { class: "app-evt-line app-card-meta" },
            span({ "data-testid": "running-label", class: "app-running-label" }, "running…"),
            RunningElapsed(run.startedAt),
          ),
        ),
      );

    // §S3 — the ABORTED run's card: struck/grey, carrying the reason, and
    // clickable (its drill-in shows that reason plus whatever partial context
    // the run left behind). Its own testid, not `event-card`: an abort is a
    // fourth state, and every existing surface that counts run cards is asking
    // about runs that produced a result.
    const AbortedCard = (e) =>
      div(
        {
          "data-testid": "aborted-card",
          "data-run-id": e.id,
          class: "app-evt app-evt-aborted",
          onclick: () => openDrillin(e.id),
        },
        span(
          eventIconProps(e),
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": "test",
          }),
        ),
        div(
          { class: "app-evt-body" },
          div(
            { class: "app-evt-line" },
            span({ class: "app-agent-id" }, e.agentId),
            span({ "data-testid": "tier-badge", class: "app-pill app-tier-badge" }, e.tier),
            CardBadges(e),
          ),
          div(
            { class: "app-evt-line app-card-meta" },
            span({ "data-testid": "card-time" }, rel(e.timestamp)),
            // The RUN's wall-clock runtime is the only duration an aborted run
            // has: it never reported a tool duration, because it never finished.
            typeof e.runtime_ms === "number"
              ? span({ "data-testid": "card-duration" }, fmtDuration(e.runtime_ms))
              : null,
          ),
        ),
        span(
          { "data-testid": "abort-reason", class: "app-pill app-abort-reason" },
          `aborted — ${e.abortReason ?? "reason unrecorded"}`,
        ),
      );

    /** §S3 — an event whose RUN was aborted (never a plan's abort — §S2). */
    const isAbortedRun = (e) => e.status === "aborted";

    // The open runs this surface should paint, under the SAME project/agent
    // filters the event feed obeys, so a filtered timeline never shows a
    // running card it would not show a finished card for.
    function visibleOpenRuns() {
      const { projectKey, agentId } = activeFilters();
      return state.openRuns.filter(
        (run) =>
          (projectKey === null || projectKey === undefined || run.projectKey === projectKey) &&
          (agentId === null || agentId === undefined || run.agentId === agentId),
      );
    }

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

    // CR-CRU-016 §S1 (C5) — markers open through the SAME workspace-aware
    // path as cards (openDrillin): a workspace marker opens the GREEN run
    // in-pane at /p/<key>/run/<id>; home markers keep /run/<id>.
    const TransitionMarkerRow = (m) =>
      div(
        {
          "data-testid": "transition-marker",
          class: "app-transition-marker",
          onclick: () => openDrillin(m.greenEvent.id),
        },
        markerLabel(m),
      );

    // CR-CRU-011 §S0b — declared plan boundaries on the Runs timeline. The
    // ACTIVE cycle's linked runs collect under an open-span header; a `done`
    // cycle renders a declared marker row (same structural weight as the
    // heuristic marker) with the active→done span from the §S0b timestamps.
    const KIND_GLYPHS = { "red-green": "⟲", verify: "☑", fix: "✚" };

    const CycleSpanOpenRow = (cycle, plan) =>
      div(
        { "data-testid": "cycle-span-open", class: "app-cycle-span-open" },
        `${KIND_GLYPHS[cycle.kind] ?? KIND_GLYPHS["red-green"]} Cycle · ${cycle.label} · ${plan.cr} · active`,
      );

    // CR-CRU-025 §S2b — the Run Timeline accordion's collapse predicate +
    // toggle. Reading the reactive `state.collapsedCycles` inside the Runs feed
    // binding subscribes it, so a toggle re-runs the feed. The toggle mutates
    // via vanX.replace (the reactive-array convention used for state.events),
    // which both persists the flag on `state` (surviving poll re-renders) and
    // re-renders the timeline. Only a declared (done) cycle's marker ever calls
    // the toggle, so the ACTIVE cycle's id can never enter the set.
    const isCycleCollapsed = (cycleId) => state.collapsedCycles.includes(cycleId);
    const toggleCycleCollapsed = (cycleId) => {
      const next = state.collapsedCycles.includes(cycleId)
        ? state.collapsedCycles.filter((id) => id !== cycleId)
        : [...state.collapsedCycles, cycleId];
      vanX.replace(state.collapsedCycles, () => next);
    };

    const DeclaredMarkerRow = (cycle, plan) => {
      const parts = [
        `${KIND_GLYPHS[cycle.kind] ?? KIND_GLYPHS["red-green"]} Cycle done`,
        cycle.label,
        plan.cr,
      ];
      if (cycle.activatedAt !== undefined && cycle.doneAt !== undefined) {
        parts.push(`closed in ${fmtDuration(cycle.doneAt - cycle.activatedAt)}`);
      }
      // CR-CRU-025 §S2b — the marker body is the accordion handle. Collapsed:
      // this cycle's linked run cards are omitted from the feed (runFeed) and a
      // `▸ <N> runs` cue renders here. The nested `boundary-to-cycle` badge
      // already stopPropagation's (C2), so it never trips this toggle.
      const collapsed = isCycleCollapsed(cycle.id);
      return div(
        {
          "data-testid": "declared-marker",
          // CR-CRU-025 §S1 — carry the declared cycle id (mirrors the
          // `data-run-id`/`data-cr` convention) so cycle→Runs navigation can
          // match the boundary by cycleId.
          "data-cycle-id": cycle.id,
          class: `app-transition-marker${collapsed ? " app-accordion-collapsed" : ""}`,
          onclick: () => toggleCycleCollapsed(cycle.id),
        },
        parts.join(" · "),
        // CR-CRU-025 §S2 — the trailing "⚑ Cycle" affordance that jumps back
        // to this cycle's row in the Workflow pane (inverse of §S1's
        // "→ Runs"). A SEPARATE trailing node; the heuristic RED➜GREEN
        // `transition-marker` never routes through here, so it stays badge-less.
        " ",
        BoundaryToCycleBadge(cycle, plan),
        // CR-CRU-025 §S2b — collapsed cue: exact `▸ <N> runs`, N = this cycle's
        // current linked-run count. Absent when expanded.
        collapsed
          ? span(
              {
                "data-testid": "accordion-collapsed-cue",
                class: "app-accordion-collapsed-cue app-card-meta",
              },
              `▸ ${linkedRunsFor(cycle.id).length} runs`,
            )
          : null,
      );
    };

    // CR-CRU-013 §S2/§S3/§S4 — gate + milestone timeline rows. Gate events
    // seal a wave's no-mistakes run as a full-width cycle-done marker (never a
    // run card); milestone events narrate design/process beats and CR merges.
    const shortCommit = (c) => String(c ?? "").slice(0, 7);

    // Outcome-conditioned class stem: passed/checks-passed → pass, failed →
    // fail, cancelled → a distinct grey/cancel token (never pass/fail).
    const gateOutcomeClass = (outcome) => {
      const o = String(outcome ?? "");
      if (/cancel/i.test(o)) return "cancel";
      if (/fail/i.test(o)) return "fail";
      return "pass";
    };

    // §S2 exact seal text: 🛡 Wave <n> gate · no-mistakes <outcome> · <N>
    // steps · <fixed> findings fixed · pushed <shortcommit>. `<fixed>` is the
    // SUM of every submitted step's findings.fixed (the only "fixed" figure
    // the §S1 payload carries).
    const gateCardText = (e) => {
      const g = e.gate ?? {};
      const steps = g.steps ?? [];
      const fixed = steps.reduce((n, s) => n + (s.findings?.fixed ?? 0), 0);
      return `🛡 Wave ${e.context?.wave ?? ""} gate · no-mistakes ${g.outcome} · ${steps.length} steps · ${fixed} findings fixed · pushed ${shortCommit(g.push?.commit)}`;
    };

    // §S2 — full-width gate seal (workspace). The trailing ⊙ Detail badge is
    // the ONLY drill affordance; the card body itself is a bound no-op.
    const GateCardRow = (e) =>
      div(
        {
          "data-testid": "gate-card",
          class: `app-transition-marker app-gate-card app-gate-${gateOutcomeClass(e.gate?.outcome)}`,
        },
        // §S2 — the exact seal text is isolated in its own child so the
        // whole-card textContent (which also carries the ⊙ Detail badge) never
        // over-constrains the seal string.
        span({ "data-testid": "gate-seal", class: "app-gate-seal" }, gateCardText(e)),
        span(
          {
            "data-testid": "gate-detail-badge",
            class: "app-pill app-gate-detail-badge",
            onclick: (ev) => {
              ev.stopPropagation();
              openDrillin(e.id);
            },
          },
          "⊙ Detail",
        ),
      );

    // §S4b/§S4c — home compact gate one-liner (distinct testid).
    const GateCardCompact = (e) =>
      div(
        {
          "data-testid": "gate-card-compact",
          class: `app-gate-compact app-gate-${gateOutcomeClass(e.gate?.outcome)}`,
          onclick: () => openDrillin(e.id),
        },
        `🛡 no-mistakes ${e.gate?.outcome} · ${shortCommit(e.gate?.push?.commit)}`,
      );

    // §S4b — slim workspace milestone row: ◇ glyph · type · label · CR badge
    // (only when context.cr) · relative time.
    const MilestoneEntryRow = (e) => {
      const hasLabel = e.label !== undefined && e.label !== null;
      const hasCr = e.context?.cr !== undefined && e.context.cr !== null;
      return div(
        { "data-testid": "milestone-entry", class: "app-milestone-entry app-tree-line" },
        span({ class: "app-milestone-glyph" }, "◇"),
        " ",
        span({ class: "app-milestone-type" }, e.type),
        hasLabel ? " · " : null,
        hasLabel ? span({ class: "app-milestone-label" }, e.label) : null,
        hasCr ? " · " : null,
        hasCr
          ? span(
              { "data-testid": "milestone-cr-badge", class: "app-pill app-milestone-cr-badge" },
              e.context.cr,
            )
          : null,
        " · ",
        span({ class: "app-card-meta" }, rel(e.timestamp)),
      );
    };

    // §S4c — cycles count via the CR-CRU-011 plans.cr linkage: the plan
    // sharing this merge's `cr` (context.cr ?? label) supplies cycles.length.
    const mergeCycles = (e) => {
      const cr = e.context?.cr ?? e.label;
      const plan = (state.plans ?? []).find((p) => p.cr === cr);
      return plan !== undefined ? (plan.cycles ?? []).length : null;
    };

    const mergeCr = (e) => e.context?.cr ?? e.label ?? "";

    // §S4c — full-width ⚑ merge break row (same structural weight as the
    // RED→GREEN transition marker).
    const MergeMarkerRow = (e) => {
      const parts = [`⚑ ${mergeCr(e)} merged`];
      const cycles = mergeCycles(e);
      if (cycles !== null) parts.push(`${cycles} cycles`);
      parts.push(shortCommit(e.commit));
      return div(
        {
          "data-testid": "merge-marker",
          class: "app-transition-marker app-merge-marker",
          onclick: () => openDrillin(e.id),
        },
        parts.join(" · "),
      );
    };

    // §S4c — home compact merge one-liner (distinct testid).
    const MergeMarkerCompact = (e) =>
      div(
        {
          "data-testid": "merge-marker-compact",
          class: "app-merge-compact",
          onclick: () => openDrillin(e.id),
        },
        `⚑ ${mergeCr(e)} · ${shortCommit(e.commit)}`,
      );

    // Feed rows: each Cycle's marker renders directly above its pair — i.e.
    // immediately before the GREEN run's card in the (newest-first) feed.
    // §S0b — the row plan is pure (app-logic timelineRows): cycleId-linked
    // runs suppress the streak heuristic and carry declared boundaries;
    // unlinked runs / planless projects keep the heuristic byte-identical.
    // CR-CRU-013 §S4b — `surface` ("home" | "workspace") scopes gate/merge to
    // compact on home, and milestone-entries to workspace only.
    function runFeed(events, surface) {
      const home = surface === "home";
      const rows = [];
      // CR-CRU-017 §S3 — a run that is happening NOW belongs at the head of a
      // newest-first feed, above every settled row. They live outside
      // `timelineRows` on purpose: an open run has no event, so it takes part in
      // no transition pair, no declared span and no rollup — it is a card, not
      // history.
      for (const run of visibleOpenRuns()) rows.push(RunningCard(run));
      for (const row of L.timelineRows(events, state.plans)) {
        if (row.kind === "marker") rows.push(TransitionMarkerRow(row.marker));
        else if (row.kind === "cycle-span-open") rows.push(CycleSpanOpenRow(row.cycle, row.plan));
        else if (row.kind === "declared-marker") rows.push(DeclaredMarkerRow(row.cycle, row.plan));
        else if (row.event.kind === "gate")
          rows.push(home ? GateCardCompact(row.event) : GateCardRow(row.event));
        else if (row.event.kind === "milestone") {
          if (row.event.type === "cr-merged")
            rows.push(home ? MergeMarkerCompact(row.event) : MergeMarkerRow(row.event));
          else if (!home) rows.push(MilestoneEntryRow(row.event));
          // home + non-merge milestone: workspace-only, render nothing.
        } else {
          // CR-CRU-025 §S2b — a run card linked to a COLLAPSED declared cycle
          // is omitted from the DOM entirely (mirrors OpenSpan's no-container
          // convention, never CSS-hidden). Only that cycle's linked cards are
          // affected; unlinked cards (no context.cycleId) always render, and
          // the active cycle's id can never be in the collapse set.
          const cid = row.event.context?.cycleId;
          if (cid !== undefined && cid !== null && isCycleCollapsed(cid)) continue;
          rows.push(isAbortedRun(row.event) ? AbortedCard(row.event) : EventCard(row.event));
        }
      }
      return rows;
    }

    const EmptyState = () => {
      // CR-CRU-017 §S3 — a live run is content: while one is running the feed
      // has something to show, so the "no runs yet" face must yield to it (the
      // no-projects face is unaffected — there is no project to run under).
      if (visibleOpenRuns().length > 0) return null;
      const empty = L.emptyStates({ projects: state.projects, events: state.events });
      if (empty === null) return null;
      return div(
        { class: "app-empty" },
        empty.kind === "no-projects"
          ? "no projects registered — register a project to light the forge"
          : "no runs yet — ingest a run to light the forge",
      );
    };

    // CR-CRU-016 §S1 tabs-hide + tab-in-header (user decisions 2026-07-16,
    // gate review) — the detail header is the single navigation context and
    // NAMES where back goes: the back chip carries the ACTIVE workspace
    // tab's name (`← runs` / `← coverage` / `← compile`, the one-rule's
    // preserved workspaceTab); home (no tabs) stays `← timeline`.
    const backChipLabel = () =>
      state.route.page === "workspace"
        ? `← ${String(state.workspaceTab).toLowerCase()}`
        : "← timeline";

    // Shared detail-header content: back chip · RUN DETAIL · density chip.
    // The chip closes exactly like Escape (same closeDetail — same
    // route/pane-scroll restore). §S4.0 FINAL — no mode switch here (or
    // anywhere): presentation is purely tier-contextual.
    // CR-CRU-038 §S3 — `controls` (RunDetailBody.headerControls) mounts the
    // failure-jump + raw-toggle as SIBLINGS of the density chip in the header
    // (retired from the body's FailuresFooter). Absent for headers with no
    // body handle (the visible home band); the drill-in suites scope the
    // controls to the overlay's inhead copy / the workspace header.
    const DetailHeadContent = (eventId, controls) => [
      button({ class: "app-chip", onclick: () => closeDetail() }, () => backChipLabel()),
      span({ class: "app-rail-title" }, `Run detail · ${eventId}`),
      // §S5 fidelity #3 — the density toggle renders in the drill-in header.
      DensityToggle(),
      ...(controls ?? []),
    ];

    // CR-CRU-016 §S1 — pane-state swap: a central pane renders EITHER its
    // CR-CRU-029 §S1 — the CR-CRU-016 AC2 scroll runway, RELOCATED from the
    // pane-scroll box itself onto its CONTENT: a single wrapper inside the
    // now-bounded pane-scroll reserving `calc(100% + 260px)` (styles.css
    // `.app-pane-content > .app-pane-runway`) so a restored reading position
    // stays reachable however short the feed. It is also the CR-CRU-023 660px
    // floor child (`.app-pane-content > *`). Central FEED panes wrap their
    // content in it; the run detail (opens at top, no restore) does not.
    const paneRunway = (...children) => div({ class: "app-pane-runway" }, ...children);

    // own feed content or the run detail, never both. The pane CONTAINER
    // node stays mounted (marker/no-remount contract); only its content
    // swaps. The scroll discipline lives here so it runs exactly when the
    // swapped content is actually in the DOM (a microtask after VanJS
    // mounts the new child): the detail opens at the top of its pane; the
    // feed returns at its exact prior scrollTop (AC2).
    const paneSwap = (Feed) => {
      let showingDetail = false;
      return () => {
        if (state.route.overlay !== undefined) {
          const detailDom = RunDetail(state.route.overlay);
          if (!showingDetail) {
            showingDetail = true;
            queueMicrotask(() => {
              // CR-CRU-029 §S1 — the detail's OWN pane-scroll box is the
              // scroller now; open it at the top.
              const sc = detailDom.querySelector('[data-testid="pane-scroll"]');
              if (sc !== null) sc.scrollTop = 0;
            });
          }
          return detailDom;
        }
        const feedDom = Feed();
        if (showingDetail) {
          showingDetail = false;
          queueMicrotask(() => {
            // CR-CRU-029 §S1 — Feed() returns the pane-scroll box itself (the
            // bounded scroller); restore its exact prior scrollTop (AC2).
            feedDom.scrollTop = savedPaneScroll;
          });
        }
        return feedDom;
      };
    };

    // §S5.1 — home body: the collective all-projects timeline, interleaved
    // newest-first (server order), filter pulldown in this pane's header.
    const TimelineFeed = () =>
      div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
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
          () => EmptyState() ?? div(runFeed(visibleEvents(), "home")),
        ),
      );

    const Timeline = () =>
      div({ "data-testid": "timeline", class: greyed("app-center") }, paneSwap(TimelineFeed));

    // CR-CRU-038 §S3 — ONE shared RunDetailBody per open detail, keyed by
    // eventId (mirrors paneSwap's showingDetail memo idiom). Home's VISIBLE
    // pinned band and RunDetail()'s body/inhead both consume the SAME
    // instance, so the relocated header controls (failure-jump/raw-toggle)
    // are wired to one body state — no duplicate build, no second
    // ?depth=suites fetch, no stale showRaw/expand between the band and the
    // body. closeDetail() clears it so a reopen builds fresh.
    let openDetailKey;
    let openDetailBody = null;
    const detailBodyFor = (eventId) => {
      if (openDetailBody === null || openDetailKey !== eventId) {
        openDetailKey = eventId;
        openDetailBody = RunDetailBody(eventId);
      }
      return openDetailBody;
    };

    // CR-CRU-016 §S1 header-always-visible — with a detail open, home pins
    // the detail header ABOVE the timeline pane's scroller in its own band;
    // scrolling a long drill-down never moves it. Closed: the band is empty.
    const Home = () =>
      div(
        { class: "app-main app-home" },
        () =>
          state.route.overlay !== undefined
            ? div(
                { class: "app-drillin-head app-top" },
                // CR-CRU-038 §S3 — thread the SHARED body's headerControls
                // into the VISIBLE band (failure-jump + raw-toggle sit beside
                // the density chip here, not only in the hidden inhead copy).
                DetailHeadContent(
                  state.route.overlay,
                  detailBodyFor(state.route.overlay).headerControls,
                ),
              )
            : "",
        Timeline(),
      );

    // ── CR-CRU-012 §S2 — Projects manager slide-over (/manage, F12) ─────
    // Its OWN scrim/slide-over contract (the CR-016 in-pane refactor retired
    // the run-detail sheet; styles.css notes /manage is a separate contract).
    // List + parameters + edit-in-place + add; archive UI is cycle 28's.
    // Defaults are client-render-time facts mirroring the server's
    // omit-when-unset Project shape (src/types.ts DEFAULT_LIVENESS 60s/300s/
    // 1h, DEFAULT_RETENTION 100) — F12 mock text verbatim.
    const MANAGER_LIVENESS_DEFAULTS = {
      staleAfterMs: 60000,
      tombstoneAfterMs: 300000,
      pruneAfterMs: 3600000,
    };
    const MANAGER_RETENTION_DEFAULT = 100;

    const fmtLivenessMs = (ms) =>
      ms >= 3600000 && ms % 3600000 === 0 ? `${ms / 3600000}h` : `${Math.round(ms / 1000)}s`;

    // "liveness T1 60s / T2 300s / T3 1h (defaults)" — the "(defaults)"
    // label ONLY when the project carries no override at all; any override
    // renders the merged values with no defaults label (F12 editing row).
    function livenessLabel(project) {
      const overrides = project.liveness ?? {};
      const hasOverride =
        typeof overrides.staleAfterMs === "number" ||
        typeof overrides.tombstoneAfterMs === "number" ||
        typeof overrides.pruneAfterMs === "number";
      const v = { ...MANAGER_LIVENESS_DEFAULTS, ...overrides };
      const core =
        `liveness T1 ${fmtLivenessMs(v.staleAfterMs)}` +
        ` / T2 ${fmtLivenessMs(v.tombstoneAfterMs)}` +
        ` / T3 ${fmtLivenessMs(v.pruneAfterMs)}`;
      return hasOverride ? core : `${core} (defaults)`;
    }

    // CR-CRU-012 §S2 (cycle 28) — archive/unarchive UI state, shared across
    // manager rows: at most ONE row holds a pending archive confirm at a
    // time (any row's trigger click claims it, resetting the others), and
    // the archived list backs the bottom "archived (N)" fold.
    const managerArchivePending = van.state(null); // project key awaiting confirm
    const managerArchivedOpen = van.state(false); // fold expanded?
    const managerArchived = van.state([]); // archived projects (?archived=true)

    async function refetchArchived() {
      try {
        const body = await getJson("/api/v2/projects?archived=true");
        // Copy: a same-reference (mutated-in-place) payload must still
        // propagate — van only re-renders on a reference CHANGE.
        managerArchived.val = [...(body.projects ?? [])];
      } catch {
        // Reachability is the watchdog's concern; keep stale data visible.
      }
    }

    // POST /api/v2/projects/<key>/archive | /unarchive ({} body — §S1b),
    // then refetch BOTH slices: the core refetch updates the home projects
    // row live (same contract the SSE projects frame drives), and the
    // archived refetch keeps the fold count/rows tracking the move.
    async function postProjectLifecycle(key, action) {
      try {
        await fetch(`/api/v2/projects/${encodeURIComponent(key)}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        // Reachability is the watchdog's concern; keep stale data visible.
      }
      refetch();
      refetchArchived();
    }

    // Display view — canonical name + type badge + ✎ edit chip + archive
    // trigger (confirm-gated: the first click only reveals the in-row
    // confirm; only that second click POSTs), parameters line beneath
    // (sutRoot · liveness · retention · immutable key as TEXT, never bound
    // to an input).
    const ManagerRowView = (project, startEdit) =>
      div(
        div(
          { class: "app-manager-row-head" },
          // The canonical name renders in a DIV on purpose: the storyboard's
          // "✎ edit" chip is found by text, and a project NAMED "Edit …"
          // must never shadow the row's real edit trigger.
          div({ class: "app-card-name" }, project.name || project.key),
          span({ class: "app-type-badge" }, project.type),
          button({ class: "app-chip app-manager-edit", onclick: startEdit }, "✎ edit"),
          button(
            {
              "data-testid": "manager-archive",
              class: "app-chip app-manager-archive",
              onclick: () => (managerArchivePending.val = project.key),
            },
            "archive",
          ),
          () =>
            managerArchivePending.val === project.key
              ? button(
                  {
                    "data-testid": "manager-archive-confirm",
                    class: "app-chip app-manager-archive-confirm",
                    onclick: () => {
                      managerArchivePending.val = null;
                      postProjectLifecycle(project.key, "archive");
                    },
                  },
                  "confirm archive",
                )
              : "",
        ),
        div(
          { class: "app-card-meta app-manager-params" },
          `sutRoot: ${project.sutRoot ?? ""} · ${livenessLabel(project)}` +
            ` · retention ${project.retention ?? MANAGER_RETENTION_DEFAULT} runs` +
            // §S4 (CR-CRU-008) — surface the danger state ONLY when enabled;
            // the default (absent/false) posture stays silent.
            (project.allowRunDeletion === true ? " · run deletion: enabled" : "") +
            ` · key ${project.key} (immutable)`,
        ),
      );

    // Edit-in-place — name/type/sutRoot + liveness overrides (t1/t2/t3,
    // edited in seconds, wired as ms) + retention; PATCH carries ONLY the
    // fields the user actually changed and NEVER the immutable key (§S1,
    // src/v2.ts:771-773 — an echoed key would 400 against the live server).
    // PATCH doesn't echo the updated project, so refetch to observe the edit.
    //
    // Cycle-28 fix (pre-existing cycle-27 defect): the name/type/sutRoot
    // states used to be CREATED here, inside the view/edit-swapping binding
    // that ManagerProjectRow wraps this component in — so that binding's
    // dependency tracking captured their `.val` reads (`value: name.val`),
    // and every input tick re-ran the scope and REBUILT the form with fresh
    // states, resetting the field before save() could read it. The states
    // now live in ManagerProjectRow (created once per row, next to
    // `editing`) and are handed in as `edit`; the inputs bind them as STATE
    // props (`value: edit.name`), never `.val`-reads, so the swapping
    // binding tracks only `editing` and typed values survive ticks.
    const ManagerRowEdit = (project, editing, edit) => {
      const { name, type, sutRoot, t1, t2, t3, retention, allowDeletion } = edit;
      // Diff baseline: the same effective values the fields were seeded with.
      const eff = { ...MANAGER_LIVENESS_DEFAULTS, ...(project.liveness ?? {}) };
      const effRetention = project.retention ?? MANAGER_RETENTION_DEFAULT;
      // Non-numeric input never PATCHes: a native number input sanitizes
      // junk to "" — empty (or unparseable) counts as UNCHANGED.
      const numOr = (raw) => {
        const s = String(raw).trim();
        if (s === "") return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
      };
      const save = async () => {
        const body = {};
        if (name.val !== (project.name ?? "")) body.name = name.val;
        if (type.val !== project.type) body.type = type.val;
        if (sutRoot.val !== (project.sutRoot ?? "")) body.sutRoot = sutRoot.val;
        // Liveness: seconds in the form, ms on the wire; ONLY changed keys
        // (the server partial-merges — unchanged siblings must be omitted).
        const liveness = {};
        const t1s = numOr(t1.val);
        if (t1s !== undefined && t1s * 1000 !== eff.staleAfterMs) liveness.t1_ms = t1s * 1000;
        const t2s = numOr(t2.val);
        if (t2s !== undefined && t2s * 1000 !== eff.tombstoneAfterMs) liveness.t2_ms = t2s * 1000;
        const t3s = numOr(t3.val);
        if (t3s !== undefined && t3s * 1000 !== eff.pruneAfterMs) liveness.t3_ms = t3s * 1000;
        if (Object.keys(liveness).length > 0) body.liveness = liveness;
        const ret = numOr(retention.val);
        if (ret !== undefined && ret !== effRetention) body.retention = ret;
        // §S4 (CR-CRU-008) — changed-keys-only, like every field above: the
        // danger toggle PATCHes only when it differs from the project's
        // current effective value (absent counts as false).
        if (allowDeletion.val !== (project.allowRunDeletion === true)) {
          body.allowRunDeletion = allowDeletion.val;
        }
        if (Object.keys(body).length > 0) {
          try {
            await fetch(`/api/v2/projects/${encodeURIComponent(project.key)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
          } catch {
            // Reachability is the watchdog's concern; keep stale data visible.
          }
        }
        editing.val = false;
        refetch();
      };
      return div(
        { class: "app-manager-edit-form" },
        label(
          { "data-testid": "manager-edit-name-label", class: "app-manager-edit-label" },
          "Name",
          input({
            "data-testid": "manager-edit-name",
            value: name,
            oninput: (e) => (name.val = e.target.value),
          }),
        ),
        label(
          { "data-testid": "manager-edit-type-label", class: "app-manager-edit-label" },
          "Type",
          select(
            {
              "data-testid": "manager-edit-type",
              onchange: (e) => (type.val = e.target.value),
            },
            option({ value: "backend", selected: project.type === "backend" }, "backend"),
            option({ value: "frontend", selected: project.type === "frontend" }, "frontend"),
          ),
        ),
        label(
          { "data-testid": "manager-edit-sutroot-label", class: "app-manager-edit-label" },
          "SUT root",
          input({
            "data-testid": "manager-edit-sutroot",
            value: sutRoot,
            oninput: (e) => (sutRoot.val = e.target.value),
          }),
        ),
        label(
          { "data-testid": "manager-edit-t1-label", class: "app-manager-edit-label" },
          "Stale after (T1, seconds)",
          input({
            "data-testid": "manager-edit-t1",
            type: "number",
            value: t1,
            oninput: (e) => (t1.val = e.target.value),
          }),
        ),
        label(
          { "data-testid": "manager-edit-t2-label", class: "app-manager-edit-label" },
          "Tombstone after (T2, seconds)",
          input({
            "data-testid": "manager-edit-t2",
            type: "number",
            value: t2,
            oninput: (e) => (t2.val = e.target.value),
          }),
        ),
        label(
          { "data-testid": "manager-edit-t3-label", class: "app-manager-edit-label" },
          "Prune after (T3, seconds)",
          input({
            "data-testid": "manager-edit-t3",
            type: "number",
            value: t3,
            oninput: (e) => (t3.val = e.target.value),
          }),
        ),
        label(
          { "data-testid": "manager-edit-retention-label", class: "app-manager-edit-label" },
          "Retention (runs shown in the timeline window)",
          input({
            "data-testid": "manager-edit-retention",
            type: "number",
            value: retention,
            oninput: (e) => (retention.val = e.target.value),
          }),
        ),
        // §S4 (CR-CRU-008) — the guarded-deletion DANGER toggle: enabling it
        // lets agents delete runs (with per-call user approval), so it wears
        // the destructive styling.
        label(
          { "data-testid": "manager-edit-allow-deletion-label", class: "app-manager-edit-label" },
          "Allow agents to delete runs (guarded — per-call approval)",
          input({
            "data-testid": "manager-edit-allow-deletion",
            type: "checkbox",
            class: "app-manager-danger-toggle",
            checked: allowDeletion,
            onchange: (e) => (allowDeletion.val = e.target.checked),
          }),
        ),
        button({ "data-testid": "manager-edit-save", class: "app-chip on", onclick: save }, "save"),
        button({ class: "app-chip", onclick: () => (editing.val = false) }, "cancel"),
        div(
          { class: "app-card-meta app-manager-params" },
          `key ${project.key} (immutable)`,
        ),
      );
    };

    const ManagerProjectRow = (project) => {
      const editing = van.state(false);
      // Edit-field states live HERE — outside the swapping binding below —
      // so input ticks never rebuild the form (see ManagerRowEdit's note).
      // startEdit re-seeds them from the project on every ✎ edit click, so
      // a cancel-then-re-edit never shows stale draft values.
      // Liveness fields edit in SECONDS (the wire is ms — save() converts);
      // prefill is the current EFFECTIVE value: defaults merged with any
      // project.liveness override (§S2 verify fix round, cycle 29).
      const effLiveness = () => ({ ...MANAGER_LIVENESS_DEFAULTS, ...(project.liveness ?? {}) });
      const edit = {
        name: van.state(project.name ?? ""),
        type: van.state(project.type),
        sutRoot: van.state(project.sutRoot ?? ""),
        t1: van.state(String(effLiveness().staleAfterMs / 1000)),
        t2: van.state(String(effLiveness().tombstoneAfterMs / 1000)),
        t3: van.state(String(effLiveness().pruneAfterMs / 1000)),
        retention: van.state(String(project.retention ?? MANAGER_RETENTION_DEFAULT)),
        // §S4 (CR-CRU-008) — guarded-deletion config gate; absent = false.
        allowDeletion: van.state(project.allowRunDeletion === true),
      };
      const startEdit = () => {
        const eff = effLiveness();
        edit.name.val = project.name ?? "";
        edit.type.val = project.type;
        edit.sutRoot.val = project.sutRoot ?? "";
        edit.t1.val = String(eff.staleAfterMs / 1000);
        edit.t2.val = String(eff.tombstoneAfterMs / 1000);
        edit.t3.val = String(eff.pruneAfterMs / 1000);
        edit.retention.val = String(project.retention ?? MANAGER_RETENTION_DEFAULT);
        edit.allowDeletion.val = project.allowRunDeletion === true;
        editing.val = true;
      };
      return div(
        {
          "data-testid": "manager-project-row",
          "data-project-key": project.key,
          class: "app-manager-row",
        },
        () =>
          editing.val ? ManagerRowEdit(project, editing, edit) : ManagerRowView(project, startEdit),
      );
    };

    // "archived (N)" fold row — the project's name + type + the unarchive
    // action (POST …/unarchive, then the same refetch pair brings the home
    // badge back live).
    const ManagerArchivedRow = (project) =>
      div(
        {
          "data-testid": "manager-archived-row",
          "data-project-key": project.key,
          class: "app-manager-row app-manager-archived-row",
        },
        div(
          { class: "app-manager-row-head" },
          div({ class: "app-card-name" }, project.name || project.key),
          span({ class: "app-type-badge" }, project.type),
          button(
            {
              "data-testid": "manager-unarchive",
              class: "app-chip",
              onclick: () => postProjectLifecycle(project.key, "unarchive"),
            },
            "unarchive",
          ),
        ),
      );

    // The fold itself: header text EXACTLY `archived (N)`, ABSENT at N=0
    // (never "archived (0)"), collapsed by default; rows render only while
    // expanded. Bound as a function child so it tracks managerArchived.
    const ManagerArchivedFold = () => {
      const archived = managerArchived.val;
      if (archived.length === 0) return "";
      return div(
        { class: "app-manager-archived" },
        button(
          {
            "data-testid": "manager-archived-fold",
            class: "app-manager-fold",
            onclick: () => (managerArchivedOpen.val = !managerArchivedOpen.val),
          },
          `archived (${archived.length})`,
        ),
        () => (managerArchivedOpen.val ? div(archived.map(ManagerArchivedRow)) : ""),
      );
    };

    // + Add project — exactly name/type/sutRoot (never a key field); POST
    // /api/v2/projects, then refetch so the new badge appears in the
    // projects row without reload (the SSE projects frame drives the same
    // refetch when a change arrives from elsewhere).
    const ManagerAddForm = () => {
      const name = van.state("");
      const type = van.state("backend");
      const sutRoot = van.state("");
      const submit = async () => {
        try {
          await fetch("/api/v2/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name.val, type: type.val, sutRoot: sutRoot.val }),
          });
        } catch {
          // Reachability is the watchdog's concern; keep stale data visible.
        }
        refetch();
      };
      return div(
        { "data-testid": "manager-add-form", class: "app-manager-add" },
        span({ class: "app-rail-title" }, "+ Add project"),
        input({
          "data-testid": "manager-add-name",
          placeholder: "name",
          oninput: (e) => (name.val = e.target.value),
        }),
        select(
          { "data-testid": "manager-add-type", onchange: (e) => (type.val = e.target.value) },
          option({ value: "backend" }, "backend"),
          option({ value: "frontend" }, "frontend"),
        ),
        input({
          "data-testid": "manager-add-sutroot",
          placeholder: "sutRoot",
          oninput: (e) => (sutRoot.val = e.target.value),
        }),
        button({ "data-testid": "manager-add-submit", class: "app-chip on", onclick: submit }, "add"),
      );
    };

    // The slide-over layer: scrim (click-to-close) + dark right sheet with
    // the ← home chip; home stays mounted beneath (route composes exactly
    // like the run-detail overlay — same surface, no chrome rebuild).
    const ProjectsManager = () => {
      // Fresh open: no dangling pending confirm, fold collapsed, and pull
      // the archived slice so the fold count is honest without a click.
      managerArchivePending.val = null;
      managerArchivedOpen.val = false;
      refetchArchived();
      return div(
        { class: "app-manager-layer" },
        div({
          "data-testid": "manager-scrim",
          class: "app-manager-scrim",
          onclick: () => closeManager(),
        }),
        div(
          { "data-testid": "projects-manager", class: "app-manager" },
          div(
            { class: "app-manager-head" },
            button({ class: "app-chip", onclick: () => closeManager() }, "← home"),
            span({ class: "app-rail-title" }, "Projects manager · /manage"),
          ),
          div(
            { class: "app-pane-content" },
            () => div([...state.projects].map(ManagerProjectRow)),
            ManagerAddForm(),
            ManagerArchivedFold,
          ),
        ),
      );
    };

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

    // CR-CRU-016 §S1 tabs-hide (user decision 2026-07-16: "the
    // Runs/Coverage/Compile/BDD row is incongruent at the same level as the
    // drill-down — the navigation conflicts") — while a detail is open the
    // tabs ROW is retired from the surface: its `workspace-tabs` handle is
    // parked and the row hidden. The tab BUTTONS stay mounted so the active
    // tab's `on` state survives the detail (the one-rule's preserved tab
    // state) and every close path (chip / Escape / popstate) restores the
    // row with the same tab still selected.
    const WorkspaceTabs = () =>
      div(
        {
          "data-testid": () =>
            state.route.overlay === undefined ? "workspace-tabs" : "workspace-tabs-parked",
          class: () =>
            `app-top${state.route.overlay === undefined ? "" : " app-tabs-parked"}`,
        },
        () => {
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
                // Reactive class — the tab BUTTON node stays mounted while
                // the active tab flips (CR-CRU-016: switching tabs or
                // opening a detail must not rebuild the tabs row).
                class: () =>
                  `app-chip${state.workspaceTab === t.name ? " on" : ""}${
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

    const WorkspaceRunsFeed = () =>
      div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
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
            // CR-CRU-017 §S3 — a project whose FIRST run is still running has
            // no events yet, and "no runs yet" would be a lie: the run is right
            // there. The empty state is therefore about having nothing at all,
            // open or settled.
            return runs.length === 0 && visibleOpenRuns().length === 0
              ? div({ class: "app-empty" }, "no runs yet — ingest a run to light the forge")
              : div(runFeed(runs, "workspace"));
          },
        ),
      );

    // CR-CRU-016 §S1 (C5) — the workspace detail is hosted by WorkspaceBody
    // (see WorkspaceRunDetail), so the tab panes render their feeds
    // directly; only the home timeline still paneSwaps.
    // CR-CRU-032 §S3 — explicit, accurate feedback when a `→ Runs` click's
    // anchor-fetch confirmed the boundary is truly pruned (empty events, no
    // `cycle`). A real DOM node in the Runs pane, never a silent no-op or the
    // old inaccurate `title` channel. Reactive on state.anchorFeedback.
    const AnchorFetchFeedback = () => {
      const fb = state.anchorFeedback;
      if (fb === null || fb === undefined) return null;
      return div(
        { "data-testid": "anchor-fetch-feedback", class: "app-anchor-fetch-feedback app-card-meta" },
        "This cycle's Runs boundary has been pruned from the retained timeline — nothing to jump to.",
      );
    };

    const WorkspaceRuns = () =>
      div(
        { "data-testid": "workspace-runs", class: greyed("app-center") },
        // Always yield a node (empty placeholder when no feedback) so VanJS
        // keeps this reactive binding alive — a `null`-first derived child is
        // GC'd and never re-renders (same guard as the home feed at §S0b).
        () => AnchorFetchFeedback() ?? span({ "aria-hidden": "true" }),
        WorkspaceRunsFeed(),
      );

    // §S5 fidelity #5 + §S5.2 F8 anatomy (user defect 2026-07-15) — Vitals.
    // Both cards follow the F8 label-over-value hierarchy: a dim uppercase
    // label ABOVE a bright/600 value line. CYCLE HEALTH renders from
    // transition pairs alone, independent of coverage; the coverage-trend
    // card renders ONLY when coverage actually exists, with one bar per
    // green-coverage point from the already-loaded timeline slice.
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
        div(
          { "data-testid": "vitals-card-label", class: "app-vitals-label" },
          "CYCLE HEALTH (7d)",
        ),
        div(
          { "data-testid": "vitals-card-value", class: "app-vitals-value" },
          pairs.length === 0
            ? "no cycles yet"
            : [
                `${pairs.length} `,
                // §S5.2 (f) — the RED/GREEN tokens carry the SAME status
                // classes the timeline uses, never neutral dim ink.
                span({ class: "app-ratio-fail" }, "RED"),
                "→",
                span({ class: "app-ratio-pass" }, "GREEN"),
                ` · median ${fmtDuration(
                  medianMs(pairs.map((m) => m.greenEvent.timestamp - m.redEvent.timestamp)),
                )}`,
              ],
        ),
      );
    };

    // CR-CRU-023 §S2 — trend points come from the DURABLE server-side
    // rollup series (project.coverageTrend), NOT the transient state.events
    // feed (retention pruning collapsed that slice — the §S2 regression).
    const CoverageTrendCard = () => {
      const project = currentProject();
      const percent = project?.latestGreenCoverage?.lines?.percent;
      if (typeof percent !== "number") return null;
      // CR-CRU-028 §S1 — auto-coarsen the date-keyed { day, percent }[] series
      // (CR-CRU-033 §S3) into ≤16 zoom-level bucket bars: day/week/month width
      // hints, orange/yellow/green level color, latest bucket emphasized. The
      // caption reads the first/last BUCKET percent so text and bars agree.
      const buckets = L.coarsenCoverageTrend(project?.coverageTrend ?? []);
      const projectKey = project?.key;
      const points = project?.coverageTrend ?? [];
      const caption =
        buckets.length >= 2
          ? `${buckets[0].percent} → ${buckets[buckets.length - 1].percent}% lines`
          : `latest green coverage ${buckets.length === 1 ? buckets[0].percent : percent}%`;
      // CR-CRU-028 §S2 — a DAY bar with no matching within-retention regression
      // coverage event is retention-dimmed (DN §3.4): its rollup value still
      // renders, but the drill affordance is gone (no dead heat strip).
      const dayIsDim = (b) =>
        b.level === "day" &&
        L.coverageHeatSlices(state.events, projectKey, b.day).length === 0;
      // §S2 — accordion PER DEPTH over a drill PATH (state.coverageDrillPath):
      // path[d] is the representative `day` of the open bucket at depth d.
      // Clicking a bar at depth d opens it (path truncated to d, then this
      // node appended — replacing any sibling at d and dropping deeper), or
      // toggles it shut when it is already the open node at d. A reactive
      // array reassigned wholesale, so the card re-renders on change.
      const toggleAt = (depth, nodeDay) => {
        const p = state.coverageDrillPath;
        state.coverageDrillPath =
          p[depth] === nodeDay ? p.slice(0, depth) : [...p.slice(0, depth), nodeDay];
      };
      // The top-level open bucket (depth 0), keyed by its representative day
      // (unique per bucket). null = nothing unfolded.
      const openTop =
        state.coverageDrillPath.length === 0
          ? null
          : buckets.find((b) => b.day === state.coverageDrillPath[0]) ?? null;
      // §S2/§3.4 — a day bar (top OR revealed) with no matching within-
      // retention event unfolds no heat strip; used both to dim the affordance
      // and to suppress a dead strip.
      const heatStrip = (day) => {
        const slices = L.coverageHeatSlices(state.events, projectKey, day);
        if (slices.length === 0) return null;
        return div(
          { "data-testid": "coverage-drill-row", class: "app-drill-row" },
          div(
            { "data-testid": "coverage-heat-strip", class: "app-cov-heat-strip" },
            slices.map((s) =>
              div({
                "data-testid": "coverage-heat-slice",
                "data-event-id": s.eventId,
                class: `app-cov-heat-slice app-heat-slice-${s.level}`,
                onclick: () => openDrillin(s.eventId),
              }),
            ),
          ),
        );
      };
      // §S2 — the open drill row for the bucket/bar at `depth`, rendered
      // BENEATH the top bars (a sibling of the bars container, so its inner
      // bars are never counted as top-level bars). A day node unfolds a per-run
      // heat strip; a month/week node unfolds its finer bars — and each revealed
      // bar CASCADES one level deeper (month→week→day→heat strip, DN §3.3) by
      // re-scoping onto the `members` the unfold carries. Accordion per depth:
      // the child open below is whichever finer bar's day matches
      // coverageDrillPath[depth + 1].
      const DrillNode = (node, depth) => {
        if (node.level === "day") return heatStrip(node.day);
        const finer =
          depth === 0
            ? L.unfoldCoverageBucket(points, node.bucketKey, node.level)
            : L.unfoldCoverageSubset(node.members, node.level);
        const childDay = state.coverageDrillPath[depth + 1];
        const childNode =
          childDay === undefined ? null : finer.find((f) => f.day === childDay) ?? null;
        return div(
          { "data-testid": "coverage-drill-row", class: "app-drill-row" },
          div(
            { class: "app-trend-bars app-drill-bars" },
            finer.map((f) => {
              const dim = dayIsDim(f);
              const attrs = {
                "data-testid": "coverage-trend-bar",
                class: `app-trend-bar app-trend-bar-${f.level} app-trend-bar-${L.coverageLevelClass(
                  f.percent,
                )}${dim ? " app-trend-bar-retention-dim" : ""}`,
                style: `height:${f.percent}%;`,
              };
              // A revealed DAY bar with no within-retention event is inert
              // (dim + aria-disabled, no onclick, no heat strip) — same rule as
              // the top day bars (DN §3.4). Every other revealed bar drills one
              // level deeper.
              if (dim) attrs["aria-disabled"] = "true";
              else attrs.onclick = () => toggleAt(depth + 1, f.day);
              return div(attrs);
            }),
          ),
          childNode === null ? null : DrillNode(childNode, depth + 1),
        );
      };
      return div(
        { "data-testid": "coverage-trend-card", class: "app-card app-vitals-card" },
        div(
          { "data-testid": "vitals-card-label", class: "app-vitals-label" },
          "COVERAGE TREND (green regressions)",
        ),
        // §S1 — bars render whenever the series coarsens to ≥1 bucket.
        buckets.length > 0
          ? div(
              { "data-testid": "coverage-trend-bars", class: "app-trend-bars" },
              buckets.map((b) => {
                const dim = dayIsDim(b);
                const attrs = {
                  "data-testid": "coverage-trend-bar",
                  class: `app-trend-bar app-trend-bar-${b.level} app-trend-bar-${L.coverageLevelClass(
                    b.percent,
                  )}${b.isLatest ? " app-trend-bar-latest" : ""}${
                    dim ? " app-trend-bar-retention-dim" : ""
                  }`,
                  style: `height:${b.percent}%;`,
                };
                // §S2 — a dimmed day bar is inert (aria-disabled, no onclick):
                // clicking it never opens a drill row or a dead heat strip.
                if (dim) attrs["aria-disabled"] = "true";
                else attrs.onclick = () => toggleAt(0, b.day);
                return div(attrs);
              }),
            )
          : null,
        () => (openTop === null ? null : DrillNode(openTop, 0)) ?? span(),
        div({ "data-testid": "vitals-card-value", class: "app-vitals-value" }, caption),
      );
    };

    const VitalsRail = () =>
      div(
        { "data-testid": "vitals-rail", class: "app-rail-section" },
        div(
          { "data-testid": "pane-section-title", class: "app-pane-section-title" },
          "Vitals",
        ),
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
      // §S5.2 (c) — the caption carries BOTH metrics when functions coverage
      // exists: `cov <lines>% lines · fn <functions>%`.
      const fnPercent = project.latestGreenCoverage?.functions?.percent;
      const caption =
        typeof fnPercent === "number"
          ? `cov ${percent}% lines · fn ${fnPercent}%`
          : `cov ${percent}% lines`;
      return div(
        props,
        div({ class: "app-card-meta" }, caption),
        div(
          { class: "app-meter" },
          div({ class: "app-meter-fill", style: `width:${Math.min(100, percent)}%;` }),
        ),
      );
    };

    // §S5.2 (f) — the latest-run status line carries the universal status
    // palette (pass-green when passing / fail-red when failing), never only
    // neutral dim ink.
    const ProjectStatusLine = (project) => {
      const last = project.lastEvent;
      const statusCls =
        last === null || last === undefined
          ? ""
          : last.failed > 0
            ? " app-ratio-fail"
            : " app-ratio-pass";
      return div(
        {
          "data-testid": "project-status-line",
          class: `app-card-meta app-status-line${statusCls}`,
        },
        () => L.projectRollupLabel(project),
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
        ProjectStatusLine(project),
        CoverageMeter(project),
      );

    // §S5.2 — the workspace's right rail: project card, then the project's
    // agents (live + tombstoned) as ⌁-marked indented sub-rows, then Vitals.
    // This pane exists ONLY inside the workspace.
    const ProjectPane = () =>
      div(
        { "data-testid": "project-pane", class: greyed("app-pane") },
        // §S5.2 (a) — F8 section title above the project card (uppercase
        // mono, ember accent, wide letter-spacing — styles.css).
        div(
          { "data-testid": "pane-section-title", class: "app-pane-section-title" },
          "Project",
        ),
        () => {
          const p = currentProject();
          return p === null ? div() : ProjectPaneCard(p);
        },
        // CR-CRU-014 §S3 — the 🗺 roadmap chip: a one-rule tab swap to the
        // Roadmap tab (same destination as the /p/<key>/roadmap deep-link),
        // no slide-over.
        button(
          {
            "data-testid": "roadmap-chip",
            class: "app-chip app-roadmap-chip",
            onclick: () => (state.workspaceTab = "Roadmap"),
          },
          "🗺 roadmap",
        ),
        div({ class: "app-agent-subrows" }, () =>
          visibleAgents().length === 0
            ? div({ class: "app-empty" }, "no agents yet")
            : div(visibleAgents().map(AgentRow)),
        ),
        VitalsRail(),
      );

    // §S5.5 (user defect 2026-07-15) — the Coverage tab renders the real
    // latest-green-coverage panel: lines + functions meter rows and a
    // `view run` control opening the latest coverage event's drill-in (same
    // wiring as the §nav coverage-meter click). Gating unchanged.
    const CoveragePanelBody = () => {
      const p = currentProject();
      const cov = p?.latestGreenCoverage;
      const lines = cov?.lines;
      const fns = cov?.functions;
      const eventId = p?.latestCoverageEventId;
      return div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
          div(
            { "data-testid": "coverage-panel", class: "app-coverage-panel" },
            div({ class: "app-rail-title" }, "Coverage — latest green regression"),
            lines !== undefined && lines !== null
              ? div(
                  { class: "app-coverage-row" },
                  `lines ${lines.covered}/${lines.total} · ${lines.percent}%`,
                )
              : null,
            fns !== undefined && fns !== null
              ? div(
                  { class: "app-coverage-row" },
                  `functions ${fns.covered}/${fns.total} · ${fns.percent}%`,
                )
              : null,
            eventId !== undefined && eventId !== null
              ? button(
                  {
                    "data-testid": "coverage-view-run",
                    class: "app-chip",
                    onclick: () =>
                      navigate(
                        `/p/${encodeURIComponent(p.key)}/run/${encodeURIComponent(eventId)}`,
                      ),
                  },
                  "view run",
                )
              : null,
          ),
        ),
      );
    };

    // CR-CRU-016 ONE RULE — coverage-view-run / coverage-meter clicks never
    // switch the tab; the detail replaces this pane via WorkspaceBody.
    const CoveragePanel = () =>
      div({ class: greyed("app-center") }, () => CoveragePanelBody());

    // §S5.5 — F5 COMPILE PANEL: the workspace timeline filtered to compile
    // events, identical card anatomy/testids as Runs.
    const CompileFeed = () =>
      div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
          div(
            { class: "app-timeline-head" },
            div({ class: "app-rail-title" }, () => {
              const p = currentProject();
              return `Compile — ${p ? p.name || p.key : state.route.projectKey}`;
            }),
          ),
          () => {
            const compiles = visibleEvents().filter((e) => e.kind === "compile");
            return compiles.length === 0
              ? div({ class: "app-empty" }, "no compile events yet")
              : div(compiles.map(EventCard));
          },
        ),
      );

    // CR-CRU-016 ONE RULE — a Compile-tab card swaps the content region to
    // the detail (via WorkspaceBody); the tab stays "Compile".
    const CompilePanel = () =>
      div({ class: greyed("app-center") }, CompileFeed());

    // §S5.5 — BDD keeps a placeholder naming the REAL landing CR (0.2.0).
    const BddFeed = () =>
      div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
          div(
            { class: "app-empty" },
            "BDD run results already stream into the Runs timeline — " +
              "the dedicated BDD surface lands in CR-CRU-015 (0.2.0)",
          ),
        ),
      );

    const BddPlaceholder = () =>
      div({ class: greyed("app-center") }, BddFeed());

    // ── CR-CRU-014 §S3, re-scoped by CR-CRU-078 §S1 — the Roadmap tab's ZONE 3:
    // the table over the execution queue. It is one of three zones that render
    // together (RoadmapPanel below); the exclusive table|graph toggle it once
    // shared the surface with is retired (AC1).

    // CR-CRU-078 §S6 — the authored order is CARRIED, never re-derived. There
    // is deliberately no ordering helper here: `listQueue` is `ORDER BY seq`,
    // so the payload arrives in the orchestrator's own order and the render's
    // whole duty is to leave it alone. What stood here was `roadmapTopoOrder`,
    // a depends-on DFS that pulled any CR whose dependency sat later in `seq`
    // forward — discarding the assigned order under a comment claiming to
    // preserve it, and shredding the wave-contiguous authoring into the live
    // board's repeated `Wave 1,2,3,4,3,4,5,6,5,6,5`. Topology VALIDATES now:
    // an inversion is flagged where it stands (`roadmapLateDeps`) and never
    // reshuffled, the same commitment CR-CRU-091 §S5 makes on the write path.

    // The plan's live cycle position — `cycle a/b` where a is the 1-based
    // index of the single active cycle and b the cycle count. null when no
    // cycle is currently active.
    const roadmapCyclePosition = (plan) => {
      const cycles = plan.cycles ?? [];
      const idx = cycles.findIndex((c) => c.status === "active");
      return idx >= 0 ? `cycle ${idx + 1}/${cycles.length}` : null;
    };

    const roadmapLaneText = (plan) => {
      const pos = roadmapCyclePosition(plan);
      return pos === null ? `${plan.track} ▶` : `${plan.track} ▶ ${pos}`;
    };

    // CR-CRU-083 §S2 — a derived status whose wire value is not readable copy.
    // Only COMPLETED_UNTRACKED is re-worded; every other status renders its raw
    // wire value, so the badge stays a faithful echo of the queue.
    const ROADMAP_STATUS_LABELS = { COMPLETED_UNTRACKED: "completed · tracking absent" };
    const roadmapStatusLabel = (status) => ROADMAP_STATUS_LABELS[status] ?? status;

    // CR-CRU-078 §S6/AC15 — the dependencies of `entry` the AUTHORING places
    // after it. A dependency outside the rendered region is not an inversion:
    // it is either unqueued (already named in the write path's
    // `unknownDependencies`, CR-CRU-091 §S5) or simply not in view.
    const roadmapLateDeps = (entry, positionOf, at) =>
      (entry.dependsOn ?? []).filter((dep) => {
        const depAt = positionOf.get(dep);
        return depAt !== undefined && depAt > at;
      });

    // §S5 — the row's COLUMN HEADS. `wave` and `track` appear only when
    // `roadmapTableColumns` says the region spans more than one (AC12), so the
    // head and every cell are driven by ONE list and cannot disagree.
    const ROADMAP_COLUMN_LABELS = {
      cr: "CR",
      title: "title",
      deps: "depends on",
      status: "status",
      wave: "wave",
      track: "track",
    };

    const RoadmapTableHead = (columns) =>
      div(
        { "data-testid": "roadmap-table-head", class: "app-roadmap-row app-roadmap-head" },
        columns.map((column) =>
          span(
            { "data-column": column, class: `app-roadmap-cell app-roadmap-${column}` },
            ROADMAP_COLUMN_LABELS[column] ?? column,
          ),
        ),
      );

    // §S5 — the row grammar: CR id + BRIEF title + bare depends-on + status +
    // cycle overlay, plus AC12's two conditional columns and AC27's lifecycle.
    // The full title used to ride every row, which §S5 calls out as bloat —
    // the identifier competed with a sentence, and the id was already in the
    // column beside it.
    const RoadmapRow = (entry, opts) => {
      const active = entry.status === "IN_PROGRESS";
      const deps = entry.dependsOn ?? [];
      const lateDeps = opts.lateDeps ?? [];
      const columns = opts.columns;
      // AC27 — the SECOND axis. Additive: the derived `status` badge below is
      // rendered whatever this says, because "what happened to the work" and
      // "is the work still wanted" are different questions (CR-CRU-091 §S2).
      const lifecycle = L.lifecycleBadge(entry.lifecycle);
      const laneBadge =
        active && opts.multiTrack && opts.plan
          ? span(
              { "data-testid": "roadmap-lane-badge", class: "app-roadmap-lane" },
              roadmapLaneText(opts.plan),
            )
          : null;
      // AC15 — an authoring error is REPORTED, never silently repaired: the row
      // stays exactly where the orchestrator put it and says what is wrong.
      const orderWarning =
        lateDeps.length === 0
          ? null
          : span(
              {
                "data-testid": "roadmap-order-warning",
                class: "app-roadmap-order-warning",
                title: `authored before its dependency ${lateDeps.join(", ")}`,
              },
              "⚠ before its dependency",
            );
      const props = {
        "data-testid": "roadmap-row",
        "data-cr": entry.cr,
        "data-active": active ? "true" : "false",
        class: `app-roadmap-row${active ? " on" : ""}`,
        // One-rule tab swap (no overlay), the SAME gate the flowchart node
        // uses: an open (IN_PROGRESS) row lands on the Workflow tab at that
        // CR's active section; a COMPLETED row lands on its Workflow history
        // group; a PENDING or COMPLETED_UNTRACKED row is inert — there is no
        // plan to land on.
        onclick: () => roadmapDrillIn(entry.status),
      };
      // CR-CRU-091/AC18 — the STORED position, verbatim, omitted when absent.
      if (typeof entry.seq === "number" && Number.isFinite(entry.seq)) {
        props["data-seq"] = String(entry.seq);
      }
      if (lifecycle !== null) props["data-lifecycle"] = lifecycle.state;
      const cell = (column, ...children) =>
        columns.includes(column)
          ? span(
              { "data-column": column, class: `app-roadmap-cell app-roadmap-${column}` },
              ...children,
            )
          : null;
      return div(
        props,
        cell("cr", entry.cr),
        // AC11 — the brief title, the row's one required new column.
        cell("title", L.briefCrTitle(entry.title, entry.cr)),
        cell(
          "deps",
          // AC20 — dependency is stated HERE and nowhere else on this surface.
          deps.map((d) =>
            span(
              { "data-testid": "roadmap-depends-chip", class: "app-chip app-roadmap-dep" },
              d,
            ),
          ),
        ),
        cell(
          "status",
          span(
            {
              "data-testid": "roadmap-status-badge",
              class: `app-badge app-roadmap-status ${entry.status.toLowerCase()}`,
            },
            roadmapStatusLabel(entry.status),
          ),
        ),
        cell("wave", entry.wave),
        cell("track", entry.track ?? ""),
        lifecycle === null
          ? null
          : span(
              {
                "data-testid": "roadmap-lifecycle-badge",
                "data-lifecycle": lifecycle.state,
                class: `app-badge app-roadmap-lifecycle ${lifecycle.state.toLowerCase()}`,
              },
              lifecycle.text,
            ),
        orderWarning,
        laneBadge,
      );
    };

    // CR-CRU-078 §S5/AC10 — ZONE 3's body: the FOCUSED release's CRs and
    // nothing else, never the whole project. The pane wrapper belongs to
    // RoadmapPanel: all three zones share ONE scrolling pane, so this returns
    // its own content and nothing around it.
    const RoadmapTableZone = (view, entries) => {
      if (entries.length === 0) {
        return div(
          { "data-testid": "roadmap-empty", class: "app-empty" },
          // The imperative names the tool exactly as §S3 pins it — a
          // LITERAL `<key>` placeholder, the orchestrator's own copy.
          "No execution queue registered yet — register one via " +
            "POST /projects/<key>/queue",
        );
      }
      // The rows are the focused release's MEMBERSHIP. With no release
      // registered at all there is no container to scope by, so the whole
      // queue stands: hiding a registered queue behind a release nobody has
      // declared would lose the board entirely, and §S5 is silent on that
      // state — it describes what the table does once a release is focused.
      // (AC19's empty state — no queue AND no releases — is C4's.)
      const rows = view === null ? entries : view.members;
      // AC12 — one decision, made from the rows, for the head and the cells.
      const columns = L.roadmapTableColumns(rows);
      // AC13 — the rendered order IS the published order. No sort, no walk.
      const plans = Array.from(state.plans);
      const openPlans = plans.filter((p) => p.status === "open");
      const multiTrack = openPlans.length > 1;
      const planFor = (entry) =>
        entry.planId === undefined
          ? undefined
          : plans.find((p) => String(p.planId) === String(entry.planId));
      const children = [RoadmapTableHead(columns)];
      // AC16 — each wave heads its rows AT MOST ONCE inside this region. The
      // divider used to fire on every wave CHANGE, which repeated a wave the
      // moment the authoring was not wave-contiguous; a re-appearance now adds
      // no second heading, and the rows stay where they were authored either
      // way. A wave with no name is no heading, and a region carrying a single
      // wave carries no information — the SAME condition that withholds the
      // wave column, read off the one column list so the two cannot drift.
      const waveOf = (entry) =>
        entry.wave === undefined || entry.wave === null || String(entry.wave).trim() === ""
          ? undefined
          : String(entry.wave);
      const waveChrome = columns.includes("wave");
      const headed = new Set();
      // AC15 — the authored POSITION of every CR in view, for the inversion
      // check. A dependency outside the focused release is not an inversion:
      // it is not in this region. Last row wins on a duplicated id: a repeated
      // CR is a queue defect this render neither hides nor adjudicates.
      const positionOf = new Map(rows.map((entry, at) => [entry.cr, at]));
      rows.forEach((entry, at) => {
        const wave = waveOf(entry);
        if (waveChrome && wave !== undefined && !headed.has(wave)) {
          headed.add(wave);
          children.push(
            div(
              { "data-testid": "roadmap-wave-divider", class: "app-roadmap-divider" },
              `Wave ${wave}`,
            ),
          );
        }
        children.push(
          RoadmapRow(entry, {
            columns,
            multiTrack,
            plan: planFor(entry),
            lateDeps: roadmapLateDeps(entry, positionOf, at),
          }),
        );
      });
      return div({ "data-testid": "roadmap-table", class: "app-roadmap-table" }, children);
    };

    // ── CR-CRU-078 §S4 — ZONE 2: the FOCUSED release's flowchart ───────────
    //
    // What stood here was CR-CRU-077's composition: a dependency-composed
    // whole-project DAG mounted into a Cytoscape canvas and laid out by
    // cytoscape-dagre — 94 nodes and 208 edges on the live board, 160 of them
    // `dependsOn`, which is the relationship web this surface exists to
    // eliminate. It is REPLACED, not adjusted (spec Problem + AC20):
    //
    //   • AC20 — zero dependency edges are drawn. Nothing below draws an edge
    //     of any kind; dependency is stated once, as the table's column.
    //   • AC26 — no layout engine decides position. Position IS the declared
    //     containment (release ⊃ wave ⊃ CR, DN §9) and the authored `seq`, so
    //     dagre's crossing minimisation has nothing left to decide.
    //   • AC23 — every state is legible as TEXT, which a <canvas> cannot be:
    //     nodes are DOM, so a greyscale reading still resolves them.
    //
    // Only the FOCUSED release is drawn. In flight it is
    // `Start → wave container(s) → ◇gate → End`; shipped, it states what it
    // DELIVERED and reconstructs no waves at all — the Workflow history view
    // owns those, and duplicating them here is an explicit non-goal (§S4/AC8).

    // CR-CRU-083 AC7 — the one-rule Workflow swap, status-gated: only a CR
    // with a plan to land on is landable, so a PENDING or COMPLETED_UNTRACKED
    // node is inert. Node and row share the predicate because they are two
    // renderings of one entry, and they must not disagree about it.
    const roadmapDrillIn = (status) => {
      if (status === "IN_PROGRESS" || status === "COMPLETED") state.workspaceTab = "Workflow";
    };

    const RoadmapFlowTerminal = (which) =>
      span(
        {
          "data-testid": "roadmap-flow-terminal",
          "data-terminal": which,
          class: `app-flow-terminal ${which}`,
        },
        which === "start" ? "Start" : "End",
      );

    // AC11 — the node states its id and its terse status and NEVER its title:
    // a node box carrying a sentence buries the identifier, and the title has
    // exactly one home, the table's column.
    //
    // AC27 — the lifecycle axis rides BESIDE the status, never instead of it.
    // An entry with no `lifecycle` key gets no attribute and no span: absent,
    // never defaulted.
    const RoadmapFlowNode = (entry) => {
      const lifecycle = L.lifecycleBadge(entry.lifecycle);
      const props = {
        "data-testid": "roadmap-node",
        "data-cr": entry.cr,
        "data-status": entry.status,
        class: `app-flow-node ${String(entry.status).toLowerCase()}`,
        onclick: () => roadmapDrillIn(entry.status),
      };
      // CR-CRU-091/AC18 — the STORED position, published verbatim and OMITTED
      // when the payload carries none. Nothing here SORTS on it: the payload
      // is already `ORDER BY seq`, so the position is observable rather than
      // load-bearing, and `?? 0` would invent one the queue never authored.
      if (typeof entry.seq === "number" && Number.isFinite(entry.seq)) {
        props["data-seq"] = String(entry.seq);
      }
      if (lifecycle !== null) props["data-lifecycle"] = lifecycle.state;
      return div(
        props,
        span({ class: "app-flow-node-cr" }, entry.cr),
        span(
          { "data-testid": "roadmap-node-status", class: "app-flow-node-status" },
          L.crStatusMark(entry.status),
        ),
        lifecycle === null
          ? null
          : span(
              {
                "data-testid": "roadmap-node-lifecycle",
                class: `app-flow-node-lifecycle ${lifecycle.state.toLowerCase()}`,
              },
              lifecycle.text,
            ),
      );
    };

    // AC9/AC16 — one container per wave, in first-appearance order, holding
    // that wave's CRs in the order they were AUTHORED. A wave interleaved by
    // the authoring opens exactly one container, and a member declaring no
    // wave has no container to head: its nodes are drawn bare rather than
    // under a heading reading `Wave `.
    const RoadmapFlowWave = (box) =>
      box.wave === null
        ? div({ class: "app-flow-loose" }, box.entries.map(RoadmapFlowNode))
        : div(
            {
              "data-testid": "roadmap-wave",
              "data-wave": box.wave,
              "data-cr-count": String(box.entries.length),
              class: "app-flow-wave",
            },
            span({ class: "app-flow-wave-label" }, `Wave ${box.wave}`),
            div({ class: "app-flow-wave-body" }, box.entries.map(RoadmapFlowNode)),
          );

    const RoadmapPackage = (pkg) =>
      span(
        { "data-testid": "roadmap-package", class: "app-flow-package" },
        `${pkg.registry} · ${pkg.name} ${pkg.version}`,
      );

    // AC8 — what a SHIPPED release delivered: its CR count, the waves it
    // spanned, its ship date and its packages. CR-CRU-084 kept `packages`
    // EMPTY and `packages` ABSENT distinguishable on the wire because they are
    // different facts, so they stay distinguishable here on
    // `data-packages-state` — but NEITHER may read as an apparently complete
    // release, so both say in words that no package was recorded.
    const RoadmapDelivered = (view) => {
      const waves = view.waves.map((box) => box.wave).filter((wave) => wave !== null);
      return div(
        { "data-testid": "roadmap-delivered", class: "app-flow-delivered" },
        span(
          { "data-testid": "roadmap-delivered-crs", class: "app-flow-delivered-crs" },
          `${view.crCount} ${view.crCount === 1 ? "CR" : "CRs"}`,
        ),
        span(
          { "data-testid": "roadmap-delivered-waves", class: "app-flow-delivered-waves" },
          waves.length === 0
            ? "no wave recorded"
            : `${waves.length === 1 ? "wave" : "waves"} ${waves.join(", ")}`,
        ),
        span(
          { "data-testid": "roadmap-delivered-date", class: "app-flow-delivered-date" },
          // AC30 — `resolveGateDate`'s own answer, carried through the gate.
          view.dateState === "dated"
            ? `shipped ${view.date}`
            : (ROADMAP_GATE_NO_DATE[`shipped:${view.dateState}`] ?? ""),
        ),
        div(
          {
            "data-testid": "roadmap-delivered-packages",
            "data-packages-state": view.packagesState,
            class: `app-flow-packages ${view.packagesState}`,
          },
          view.packagesState === "listed"
            ? view.packages.map(RoadmapPackage)
            : span({ class: "app-flow-no-package" }, "no package recorded"),
        ),
      );
    };

    // The focused release's own gate, drawn INSIDE its flowchart: the same
    // release zone 1 shows, stated once more where the flow ends, with the
    // same date and the same dashed-when-proposed grammar.
    const RoadmapFlowGate = (view) =>
      div(
        {
          "data-testid": "roadmap-flow-gate",
          "data-version": view.version,
          "data-kind": view.kind,
          "data-date-state": view.dateState,
          class: `app-flow-gate ${view.kind}`,
        },
        span({ class: "app-flow-gate-version" }, view.version),
        span(
          { class: `app-flow-gate-date ${view.dateState}` },
          view.dateState === "dated"
            ? view.date
            : (ROADMAP_GATE_NO_DATE[`${view.kind}:${view.dateState}`] ?? ""),
        ),
      );

    const RoadmapFlowZone = (view) => {
      // No release registered at all draws NO chrome — no terminals, no gate,
      // no wave box. AC19's one definitive empty state is C4's, and the two
      // orphan terminals the old graph drew over an empty board are exactly
      // what it fails.
      if (view === null) return null;
      return div(
        {
          "data-testid": "roadmap-flow",
          "data-version": view.version,
          "data-kind": view.kind,
          "data-cr-count": String(view.crCount),
          class: `app-roadmap-flow ${view.kind}`,
        },
        RoadmapFlowTerminal("start"),
        view.kind === "shipped"
          ? RoadmapDelivered(view)
          : div({ class: "app-flow-waves" }, view.waves.map(RoadmapFlowWave)),
        RoadmapFlowGate(view),
        RoadmapFlowTerminal("end"),
      );
    };

    // ── CR-CRU-078 §S2 — ZONE 1: the paged release strip ───────────────────
    //
    // The strip is the release SEQUENCE, `Start → ◇release … → End`. It is the
    // only zone that grows without bound and it does NOT scroll: the window
    // holds floor(track width / gate pitch) gates and NEVER a fraction of one
    // (AC3), and the remainder becomes the clickable tag on each side that is
    // both the hidden count and the affordance (AC4).
    //
    // Both inputs are MEASURED — the gate track's own box, and the pitch of the
    // CSS-owned ruler the strip renders inside that track. A constant would
    // satisfy every fixture and still be wrong the moment the project rail
    // collapses (CR-093), so nothing here carries a width: the stylesheet owns
    // the pitch (`--app-strip-gate-pitch`) and the strip publishes what it
    // measured (`data-track-width`, `data-gate-pitch`, `data-window-size`).
    const roadmapStripMetrics = van.state({ width: 0, pitch: 0 });

    // §S8 — the page window lives OUTSIDE the render tree, keyed by project
    // exactly like `state.collapsedCycles` and `lensOpenKeys`: the roadmap
    // body re-runs on every queue/plans/releases frame, so a mount-local
    // offset would page itself back to the landing window on the next SSE
    // tick. `rev` is the reactive handle a paging click flips, since a Map
    // cannot notify a binding.
    const roadmapStripOffsets = new Map();
    const roadmapStripRev = van.state(0);

    // §S8 — and so does the FOCUSED release, for exactly the same reason and
    // in exactly the same shape. CR-CRU-077's release expansion had to be
    // hoisted for this precise bug, and CR-CRU-093 then had to add its own
    // §S3/§S4 after it bit the project rail too: a mount-local holder
    // re-defaults the user's choice on the very next SSE tick. Keyed by
    // PROJECT so one workspace's focus cannot surface in another's strip.
    // Undefined until the user clicks a gate — landing still focuses the
    // release in progress (§S5), because the DEFAULT is a fallback rather
    // than a stored value.
    const roadmapFocusVersions = new Map();
    const roadmapFocusRev = van.state(0);
    // Reading `rev` is what subscribes a binding to the out-of-tree Map; the
    // comparison keeps that read honest rather than discarded.
    const roadmapFocusedVersion = () =>
      roadmapFocusRev.val >= 0 ? roadmapFocusVersions.get(state.route.projectKey) : undefined;
    const roadmapFocusOn = (version) => {
      roadmapFocusVersions.set(state.route.projectKey, version);
      roadmapFocusRev.val += 1;
    };

    // The mounted strip's measurement listeners, or null — each mount retires
    // the previous mount's listeners instead of stacking another one onto a
    // dead element.
    let roadmapStripTeardown = null;

    const roadmapBoxWidth = (el) => {
      if (el === null || el === undefined) return 0;
      const width = el.getBoundingClientRect().width;
      return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 0;
    };

    const measureRoadmapStrip = (strip) => {
      const width = roadmapBoxWidth(strip.querySelector('[data-testid="roadmap-strip-track"]'));
      const pitch = roadmapBoxWidth(strip.querySelector('[data-testid="roadmap-strip-ruler"]'));
      const now = roadmapStripMetrics.val;
      // Guarded: an unchanged measurement must not notify, or every re-render
      // would re-render itself.
      if (now.width !== width || now.pitch !== pitch) roadmapStripMetrics.val = { width, pitch };
    };

    const observeRoadmapStrip = (strip) => {
      if (roadmapStripTeardown !== null) roadmapStripTeardown();
      roadmapStripTeardown = null;
      const remeasure = () => {
        if (strip.isConnected) measureRoadmapStrip(strip);
      };
      // The first pass waits for ATTACHMENT: a detached box measures 0, which
      // is a strip with no window at all.
      setTimeout(remeasure, 0);
      // A rail collapse (CR-093) changes the TRACK's box while the window's
      // stays put, so the observer is the honest trigger; the resize listener
      // is the portable half.
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(remeasure) : null;
      if (observer !== null) observer.observe(strip);
      window.addEventListener("resize", remeasure);
      roadmapStripTeardown = () => {
        window.removeEventListener("resize", remeasure);
        if (observer !== null) observer.disconnect();
      };
    };

    // §S3/AC6/AC7 — what a gate says when it has no usable date. `absent` is
    // AC6's declared empty state (an undeclared target, an undated legacy tag);
    // `unusable` is a data defect and must not read as a plan nobody authored.
    // No entry here is a forecast: AC7 forbids one while CR-022 is unshipped.
    // Shared by zone 1's gate and zone 2's: one release, one wording.
    const ROADMAP_GATE_NO_DATE = {
      "shipped:absent": "no ship date recorded",
      "shipped:unusable": "ship date unreadable",
      "proposed:absent": "no target declared",
      "proposed:unusable": "target unreadable",
    };

    // AC10 — the gate is the FOCUS affordance: a click refocuses zones 2 and 3
    // on that release, and the strip says which one they are following. Focus
    // is the strip's, so nothing below it decides again.
    const RoadmapGate = (gate, focused) =>
      div(
        {
          "data-testid": "roadmap-gate",
          "data-version": gate.version,
          "data-kind": gate.kind,
          "data-date-state": gate.dateState,
          ...(focused === true ? { "data-focused": "true" } : {}),
          class: `app-strip-gate ${gate.kind}${focused === true ? " on" : ""}`,
          onclick: () => roadmapFocusOn(gate.version),
        },
        span({ class: "app-strip-gate-version" }, gate.version),
        span(
          { "data-testid": "roadmap-gate-date", class: `app-strip-gate-date ${gate.dateState}` },
          // AC30 — the date is `resolveGateDate`'s own answer, carried
          // verbatim. Nothing on this surface constructs one.
          gate.dateState === "dated"
            ? gate.date
            : (ROADMAP_GATE_NO_DATE[`${gate.kind}:${gate.dateState}`] ?? ""),
        ),
      );

    const RoadmapStripTag = (side, count, onclick) =>
      button(
        {
          "data-testid": `roadmap-strip-${side}`,
          "data-hidden-count": String(count),
          class: `app-strip-tag ${side}`,
          onclick,
        },
        side === "earlier" ? `◀ ${count} earlier` : `${count} later ▶`,
      );

    const RoadmapStripTerminal = (which) =>
      span(
        {
          "data-testid": "roadmap-strip-terminal",
          "data-terminal": which,
          class: `app-strip-terminal ${which}`,
        },
        which === "start" ? "Start" : "End",
      );

    // The gate SEQUENCE and the focused index are RoadmapPanel's — this zone
    // owns the window, not the data (AC28's concatenation happens once, there).
    const RoadmapStripZone = (gates, focusIndex) => {
      // Nothing registered draws NO chrome — no strip, no terminals. AC19's
      // one definitive empty state is C4's, and skeleton chrome would be
      // exactly what it fails.
      if (gates.length === 0) return null;
      // `focusIndex` is the panel's answer; the landing window is the page
      // that CONTAINS it (AC5), so a click on a visible gate never pages.
      const projectKey = state.route.projectKey;
      const windowSize = () => {
        const metrics = roadmapStripMetrics.val;
        return L.stripWindowSize(metrics.width, metrics.pitch);
      };
      // Reading `rev` is what subscribes a binding to the out-of-tree offset;
      // the comparison keeps that read honest rather than discarded.
      const pageNow = () =>
        L.releaseStripPage({
          count: gates.length,
          size: windowSize(),
          focusIndex,
          offset: roadmapStripRev.val >= 0 ? roadmapStripOffsets.get(projectKey) : undefined,
        });
      // AC4 — one click moves a WHOLE window. The resolved (snapped, clamped)
      // offset is what gets stored, so a click at either end is idempotent
      // instead of drifting into offsets no window occupies.
      const pageBy = (windows) => {
        const size = windowSize();
        if (size === 0) return;
        const next = L.releaseStripPage({
          count: gates.length,
          size,
          focusIndex,
          offset: pageNow().offset + windows * size,
        });
        roadmapStripOffsets.set(projectKey, next.offset);
        roadmapStripRev.val += 1;
      };
      const strip = div(
        {
          "data-testid": "roadmap-strip",
          class: "app-roadmap-strip",
          "data-gate-count": String(gates.length),
          // What the strip MEASURED and what it derived from it — the paging
          // arithmetic is observable rather than asserted.
          "data-track-width": () => String(roadmapStripMetrics.val.width),
          "data-gate-pitch": () => String(roadmapStripMetrics.val.pitch),
          "data-window-size": () => String(windowSize()),
          "data-window-offset": () => String(pageNow().offset),
          "data-hidden-earlier": () => String(pageNow().earlier),
          "data-hidden-later": () => String(pageNow().later),
        },
        RoadmapStripTerminal("start"),
        // The tag SLOT is always laid out; the tag itself exists only when
        // something is hidden behind it (AC4 — absent, never disabled).
        // Reserving the space is what stops the window size oscillating: the
        // window is measured from the track, and a tag that changed the track's
        // width would change the count that decides whether the tag exists.
        //
        // The RAIL is what the binding produces, never the tag: a binding that
        // returns null yields no node for van to reconnect, so the next
        // measurement would never reach it and the tag would stay missing.
        () => {
          const page = pageNow();
          return div(
            { class: "app-strip-rail earlier" },
            page.earlier === 0 ? null : RoadmapStripTag("earlier", page.earlier, () => pageBy(-1)),
          );
        },
        div(
          { "data-testid": "roadmap-strip-track", class: "app-strip-track" },
          // The pitch PROBE — out of flow, so it takes no width from the track
          // it is measured inside.
          span({ "data-testid": "roadmap-strip-ruler", class: "app-strip-ruler" }),
          () => {
            const page = pageNow();
            return div(
              { class: "app-strip-gates" },
              gates
                .slice(page.offset, page.offset + page.size)
                .map((gate, at) => RoadmapGate(gate, page.offset + at === focusIndex)),
            );
          },
        ),
        () => {
          const page = pageNow();
          return div(
            { class: "app-strip-rail later" },
            page.later === 0 ? null : RoadmapStripTag("later", page.later, () => pageBy(1)),
          );
        },
        RoadmapStripTerminal("end"),
      );
      observeRoadmapStrip(strip);
      return strip;
    };

    // AC1/AC2 — every zone renders, in order, inside ONE scrolling pane: the
    // strip, then the focused release's flowchart, then its table. There is no
    // view state left to select one of them.
    //
    // The three zones share ONE notion of focus, resolved HERE and handed
    // down. The strip owns which release is focused (§S2/§S4/§S5); zones 2 and
    // 3 are told and never re-decide, because two derivations of "the focused
    // release" is precisely the desynchronised surface the CR's Risk section
    // names — and a second `releaseStripGates` call would be a second
    // sequence, one SSE frame away from disagreeing with the first.
    const RoadmapPanel = () =>
      div({ class: greyed("app-center") }, () => {
        const releases = Array.from(state.releases);
        const proposals = Array.from(state.releaseProposals);
        const entries = Array.from(state.queue);
        // AC28 — shipped as the ledger published it, then proposals as the
        // proposals read published it. Concatenated here and nowhere else,
        // and neither half re-sorted.
        const gates = L.releaseStripGates(releases, proposals);
        const focusIndex = L.releaseStripFocusIndex(gates, roadmapFocusedVersion());
        const focused = focusIndex >= 0 ? gates[focusIndex] : undefined;
        const view =
          focused === undefined ? null : L.focusedReleaseView(focused, releases, entries);
        return div(
          { "data-testid": "pane-scroll", class: "app-pane-content" },
          paneRunway(
            div(
              { "data-testid": "roadmap-zones", class: "app-roadmap-zones" },
              RoadmapStripZone(gates, focusIndex),
              RoadmapFlowZone(view),
              RoadmapTableZone(view, entries),
            ),
          ),
        );
      });

    // ── CR-CRU-011 §S3 — Workflow tab: ACTIVE view (per-CR todo over the
    // open plan) + gate-pane placeholder. The HISTORY lens lands in C4.
    // Cycle-status glyphs: active ▶ / done ✓ / failed ✗ are the CR's literal
    // glyphs; pending ○ / skipped ⊘ are the distinct text-only markers.
    const CYCLE_GLYPHS = {
      pending: "○",
      active: "▶",
      done: "✓",
      skipped: "⊘",
      failed: "✗",
    };

    // CR-CRU-020 §S1.2/§S2 — expand/collapse state for CR groups and
    // cycle rows. Keyed OUTSIDE the render tree
    // (surface-keyed — the CR-016 one-rule precedent) so poll-tick
    // re-renders and the detail pane swap never reset an expansion. The
    // van.state rev is the reactive handle each slot's OWN child binding
    // reads, so a toggle re-renders only that slot — row/group element
    // identity is preserved across clicks.
    const lensOpenKeys = new Set();
    const lensOpenRev = van.state(0);
    const lensKey = (kind, id) => `${kind}:${state.route.projectKey}:${id}`;
    const lensOpen = (key) => {
      lensOpenRev.val; // subscribe the enclosing binding to toggle flips
      return lensOpenKeys.has(key);
    };
    const lensToggle = (key) => {
      if (!lensOpenKeys.delete(key)) lensOpenKeys.add(key);
      lensOpenRev.val += 1;
    };
    // ▸/▾ — the drill-in tree's expand affordance (design language: rows
    // stay text-color only; the glyph is the visual cue).
    const ToggleGlyph = (key) =>
      span({ class: "app-toggle-glyph" }, () => (lensOpen(key) ? "▾" : "▸"));

    // Runs linked to a cycle via the §S0 `context.cycleId` passthrough.
    // §S6 #3 (re-baselined 2026-07-17) — CHRONOLOGICAL, latest LAST: run
    // lists inside a cycle sort by timestamp ascending regardless of the
    // events array's arrival order (latest-first stays EXCLUSIVELY the
    // History section's wave/CR-group ordering).
    const linkedRunsFor = (cycleId) =>
      state.events
        .filter(
          (e) =>
            e.projectKey === state.route.projectKey &&
            e.kind !== "lifecycle" &&
            e.context?.cycleId === cycleId,
        )
        .sort((a, b) => a.timestamp - b.timestamp);

    // CR-CRU-016 binding — a linked run opens as a pane state of the
    // WORKFLOW pane through the SAME openDrillin path as cards/markers
    // (one-rule: no tab switch, tabs-hide, `← workflow` back chip).
    // CR-CRU-021 §S6 #3 — the run entry carries the CR-007 mask-icon (never
    // the mock's literal 🧪 emoji) and the PLAIN `P/T` ratio for pass AND
    // fail, colored via class only.
    const LinkedRunRow = (e) =>
      div(
        {
          "data-testid": "linked-run-row",
          "data-run-id": e.id,
          class: "app-linked-run-row",
          onclick: () => openDrillin(e.id),
        },
        span(
          eventIconProps(e),
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": "test",
          }),
        ),
        span({ class: "app-agent-id" }, e.agentId),
        span(
          { class: e.failed > 0 ? "app-ratio-fail" : "app-ratio-pass" },
          `${e.passed}/${e.total}`,
        ),
        span({ class: "app-card-meta" }, rel(e.timestamp)),
      );

    // §S6 #3 (cycle 13, gap 1) — the ACTIVE cycle's open span renders its
    // linked runs as ONE INLINE FLOW: `<icon> <agent> <ratio> · … · awaiting
    // orchestrator confirm`. Inline-level entries (span, `app-inline-run`),
    // literal `·` text-node separators, NO per-run age stamp (the mock has
    // none — the stacked block rows with "ago" were the drift this fixes).
    const InlineRunEntry = (e) =>
      span(
        {
          "data-testid": "linked-run-row",
          "data-run-id": e.id,
          class: "app-inline-run",
          onclick: () => openDrillin(e.id),
        },
        span(
          eventIconProps(e),
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": "test",
          }),
        ),
        span({ class: "app-agent-id" }, e.agentId),
        " ",
        span(
          { class: e.failed > 0 ? "app-ratio-fail" : "app-ratio-pass" },
          `${e.passed}/${e.total}`,
        ),
      );

    // CR-CRU-017 §S3 — the same inline entry for a run that is STILL RUNNING:
    // agent + live elapsed timer instead of a ratio it does not have, and no
    // click handler (the not-clickable-while-running rule holds wherever a
    // running run is rendered, not just on the timeline card).
    const InlineRunningEntry = (run) =>
      span(
        {
          "data-testid": "open-span-running-entry",
          "data-run-id": run.runId,
          class: "app-inline-run app-inline-run-running",
        },
        span(
          eventIconProps(run),
          span({
            "data-testid": "icon-glyph",
            class: "app-icon-mask",
            "data-kind": "test",
          }),
        ),
        span({ class: "app-agent-id" }, run.agentId),
        " ",
        RunningElapsed(run.startedAt),
      );

    /** §S3 — this cycle's currently-running runs, from the open-run slice. */
    const runningRunsFor = (cycleId) =>
      state.openRuns.filter(
        (run) =>
          run.projectKey === state.route.projectKey && run.context?.cycleId === cycleId,
      );

    // §S6 #3 (cycle 18, live-review) — the open-span row exists only WITH
    // linked runs; with ZERO cycleId-linked runs there is nothing awaiting
    // confirm, so NO container (and no annotation) renders at all.
    // CR-CRU-017 §S3 — a currently-RUNNING run counts as content for the same
    // reason: the active cycle's span must show it live. So the span renders
    // when there is either a settled linked run or a running one.
    const OpenSpan = (cycleId) => {
      const runs = linkedRunsFor(cycleId);
      const running = runningRunsFor(cycleId);
      if (runs.length === 0 && running.length === 0) return null;
      const parts = [];
      for (const run of runs) {
        parts.push(InlineRunEntry(run), " · ");
      }
      // Running entries come LAST in this chronological flow: they started
      // after everything already settled in the span.
      for (const run of running) {
        parts.push(InlineRunningEntry(run), " · ");
      }
      parts.push(
        span(
          {
            "data-testid": "open-span-annotation",
            class: "app-card-meta app-open-span-annotation",
          },
          "awaiting orchestrator confirm",
        ),
      );
      return div({ "data-testid": "open-span", class: "app-open-span" }, parts);
    };

    // CR-CRU-021 §S6 #2 (re-baselined 2026-07-17) — DONE rows are BARE: the
    // ✓ glyph IS the done signal, no status narration at all (the removed
    // "done — GREEN confirmed[ by X]" / "done — report accepted" forms; the
    // orchestrator identity stamps the CR ROOT instead). ACTIVE keeps
    // `· ACTIVE`; pending/skipped/failed keep their status word.
    const cycleNarration = (cycle) => {
      if (cycle.status === "active") return "ACTIVE";
      if (cycle.status === "done") return null;
      return cycle.status;
    };

    // CR-CRU-025 §S1 — shared 10s locate-blink. Adds a marker CSS class to a
    // target element and schedules a JS timer that removes it after EXACTLY
    // 10s ("CSS animation with a JS-cleared marker class"). Re-triggering
    // resets the clock: any prior timer is cleared first so the blink never
    // stacks. Reusable — C2 drives the inverse (run→cycle) direction through
    // this same helper.
    const LOCATE_BLINK_CLASS = "app-locate-blink";
    let locateBlinkTimer = null;
    let locateBlinkTarget = null;
    const locateBlink = (el) => {
      if (locateBlinkTimer !== null) {
        clearTimeout(locateBlinkTimer);
        locateBlinkTimer = null;
      }
      if (locateBlinkTarget !== null && locateBlinkTarget !== el) {
        locateBlinkTarget.classList.remove(LOCATE_BLINK_CLASS);
      }
      locateBlinkTarget = el;
      el.classList.add(LOCATE_BLINK_CLASS);
      locateBlinkTimer = setTimeout(() => {
        el.classList.remove(LOCATE_BLINK_CLASS);
        locateBlinkTimer = null;
        locateBlinkTarget = null;
      }, 10000);
    };

    // CR-CRU-032 §S3 (VERIFY 1B) — the accurate reason a `→ Runs` pill wears
    // once its boundary is server-confirmed pruned, shared by the render-time
    // dim (fresh re-mounts) and the imperative reflect on the clicked pill.
    const PRUNED_PILL_REASON =
      "This cycle's Runs boundary has been pruned from the retained timeline";

    // §S3 (VERIFY 1B) — reflect the confirmed-pruned verdict onto the exact
    // `→ Runs` element the user activated. The stored state.prunedCycles below
    // dims every FRESH render of this cycle's pill; this reflects the same
    // verdict on the ALREADY-rendered node that triggered the anchor-fetch
    // (the tab has swapped to Runs by now, detaching that node from the live
    // tree — VanJS no longer rebinds it, so the clicked control updates itself
    // directly). Idempotent; mirrors the render-time dim styling exactly.
    const reflectPrunedPill = (pillEl) => {
      if (pillEl === null || pillEl === undefined) return;
      pillEl.classList.add("app-pill-dim");
      pillEl.setAttribute("aria-disabled", "true");
      pillEl.setAttribute("title", PRUNED_PILL_REASON);
      pillEl.setAttribute("aria-label", PRUNED_PILL_REASON);
    };

    // CR-CRU-025 §S1 — after the one-rule tab swap to Runs, the declared
    // boundary for `cycleId` re-renders asynchronously; retry (real timers,
    // never the 10s blink delay) until it mounts, then scroll it into view
    // and blink it. `pillEl` (CR-CRU-032 §S3) is the clicked `→ Runs` node,
    // threaded through so a confirmed-pruned anchor-fetch can reflect the dim
    // verdict back onto it.
    const revealDeclaredMarker = (cycleId, attempts = 0, anchored = false, pillEl = null) => {
      const marker = document.querySelector(
        `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
      );
      if (marker !== null) {
        marker.scrollIntoView();
        locateBlink(marker);
        return;
      }
      if (attempts < 30) {
        setTimeout(() => revealDeclaredMarker(cycleId, attempts + 1, anchored, pillEl), 5);
        return;
      }
      // CR-CRU-032 §S2 — the marker never mounted from the loaded window: this
      // cycle's boundary is beyond the loaded feed (not necessarily pruned).
      // Anchor-fetch it ONCE (`anchored` guards against a fetch loop) — a
      // beyond-window boundary comes back with events to merge, a truly-pruned
      // one comes back empty and surfaces §S3 feedback. Never a silent give-up.
      if (!anchored) anchorFetchRuns(cycleId, pillEl);
    };

    // CR-CRU-032 §S2/§S3 — the beyond-window resolver behind `revealDeclaredMarker`.
    // Issues the §S1 anchored route `GET /api/v2/events?project=<key>&cycleId=<id>`
    // (`{events, cycle?}`): a non-empty `events` payload is merged into the Runs
    // feed (sufficient on its own for `timelineRows` to mount the declared
    // marker) and the reveal is retried; an EMPTY payload with NO `cycle` field
    // is the server's "truly pruned" signal, surfaced as explicit feedback.
    const anchorFetchRuns = async (cycleId, pillEl = null) => {
      const key = state.route.projectKey;
      if (key === undefined || key === null) return;
      let body;
      try {
        body = await getJson(
          `/api/v2/events?project=${encodeURIComponent(key)}&cycleId=${encodeURIComponent(cycleId)}`,
        );
      } catch {
        return;
      }
      const fetched = Array.isArray(body.events) ? body.events : [];
      if (fetched.length > 0) {
        const seen = new Set(state.events.map((e) => e.id));
        const additions = fetched.filter((e) => !seen.has(e.id));
        if (additions.length > 0) {
          const merged = state.events.concat(additions);
          vanX.replace(state.events, () => merged);
        }
        // Re-reveal with a fresh retry budget; `anchored` blocks a second fetch.
        revealDeclaredMarker(cycleId, 0, true);
        return;
      }
      // Empty events + absent `cycle` field ⇒ server confirms the boundary is
      // truly gone (mirrors the §S1 "unknown cycleId" case). Surface §S3 feedback.
      if (body.cycle === undefined || body.cycle === null) {
        state.anchorFeedback = cycleId;
        // §S3 (VERIFY 1B) — record the PERMANENT pruned verdict for this
        // cycle so its `→ Runs` pill dims and STAYS dim across later renders
        // and other pills' clicks (do NOT clear this the way anchorFeedback
        // is cleared — the feedback text is transient, the dim is permanent).
        if (!state.prunedCycles.includes(cycleId)) {
          vanX.replace(state.prunedCycles, () => [...state.prunedCycles, cycleId]);
        }
        // Reflect the same verdict onto the clicked pill (now tab-detached).
        reflectPrunedPill(pillEl);
      }
    };

    // CR-CRU-025 §S1/§S0 — the trailing "→ Runs" affordance on a COMPLETED
    // cycle row. A SEPARATE node from the history `cycle-toggle` (never a
    // rebinding). Clicking flips the workspace tab to Runs (the one-rule
    // `state.workspaceTab` swap, NOT a navigate() pathname change), scrolls the
    // matching `declared-marker` (by cycleId) into view, and blinks it 10s.
    // CR-CRU-032 §S3 — the badge is LIVE for EVERY completed cycle: a boundary
    // absent from the loaded window is beyond-window (reachable via §S2's
    // anchor-fetch), NOT pruned. The old `linkedRunsFor(...).length > 0` dim
    // gate conflated the two and lied — a cycle earns the pruned verdict only
    // AFTER a click's anchor-fetch comes back empty (state.anchorFeedback),
    // never at static render time.
    const CycleToRunsBadge = (cycleId) => {
      const live = cycleId !== undefined && cycleId !== null;
      // §S3 (VERIFY 1B) — a cycle earns the DIM/pruned state ONLY after its
      // own click's anchor-fetch confirmed the boundary is truly gone
      // (membership in the stored, reactive state.prunedCycles). Never at
      // static render time, and never for a boundary that merely isn't in the
      // loaded window (that's beyond-window/reachable — AC1/AC3 stay LIVE).
      // `pruned` is a plain boolean read ONCE here from the durable reactive
      // store state.prunedCycles (the same way state.collapsedCycles is read);
      // the dim attributes below are STATIC per render — NOT `() => …` reactive
      // attribute bindings. Dim is achieved by TWO cooperating mechanisms:
      //   (b) durable store — any FRESH render of this pill (initial mount, a
      //   poll refresh, or returning to the Workflow tab, which fully
      //   unmounts/remounts WorkspaceBody via its reactive `() => WorkspaceBody()`
      //   child) re-invokes CycleToRunsBadge, re-reads state.prunedCycles, and
      //   renders dim when this cycleId carries the pruned verdict. This is the
      //   real, durable UX (proven by AC6, which dims a brand-new node the
      //   reflection never touched).
      //   (a) reflection — the node the user JUST clicked is detached by the
      //   state.workspaceTab = "Runs" swap ~150ms BEFORE the async anchor-fetch
      //   resolves, so no re-render can reach it; reflectPrunedPill imperatively
      //   dims that exact detached node so its own click reflects the pruned
      //   outcome immediately.
      const pruned = live && state.prunedCycles.includes(cycleId);
      return span(
        {
          "data-testid": "cycle-to-runs",
          class: pruned
            ? "app-pill app-cycle-to-runs app-pill-dim"
            : "app-pill app-cycle-to-runs",
          "aria-disabled": pruned ? "true" : "false",
          title: pruned ? PRUNED_PILL_REASON : "Jump to this cycle's Runs boundary",
          ...(pruned ? { "aria-label": PRUNED_PILL_REASON } : {}),
          onclick: (ev) => {
            ev.stopPropagation();
            if (!live) return;
            // A pruned pill is NOT a silent no-op — re-run the reveal so the
            // anchor-fetch re-confirms and the §S3 anchor-fetch-feedback text
            // resurfaces. It simply never pretends to be a normal live jump.
            // Clear any stale pruned feedback from a prior cycle's click.
            state.anchorFeedback = null;
            state.workspaceTab = "Runs";
            revealDeclaredMarker(cycleId, 0, false, ev.currentTarget);
          },
        },
        "→ Runs",
      );
    };

    // CR-CRU-025 §S2 — the inverse of `revealDeclaredMarker`: after the
    // one-rule tab swap to Workflow, the target cycle row re-renders
    // asynchronously (and, in History, only once its collapsed cr-group has
    // been expanded). Retry (real timers, never the 10s blink delay) until the
    // ACTIVE `cycle-row` OR the HISTORY `lens-cycle-row` for `cycleId` mounts,
    // then scroll it into view and blink it through the SAME shared util.
    const revealCycleRow = (cycleId, attempts = 0) => {
      const row = document.querySelector(
        `[data-testid="cycle-row"][data-cycle-id="${cycleId}"], ` +
          `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
      );
      if (row !== null) {
        row.scrollIntoView();
        locateBlink(row);
        return;
      }
      if (attempts < 30) {
        setTimeout(() => revealCycleRow(cycleId, attempts + 1), 5);
      }
    };

    // CR-CRU-025 §S2 — the trailing "⚑ Cycle" badge on a declared boundary
    // marker. A SEPARATE node from the marker body; clicking it (and ONLY it —
    // stopPropagation keeps the click off C3's future accordion body) flips the
    // workspace tab to Workflow (the one-rule swap, inverse of §S1), expands
    // the containing COLLAPSED history cr-group when the plan is closed, then
    // scrolls+blinks the exact cycle row matched by cycleId.
    const BoundaryToCycleBadge = (cycle, plan) => {
      const cycleId = cycle.id;
      const isHistory = plan.status === "closed";
      return span(
        {
          "data-testid": "boundary-to-cycle",
          class: "app-pill app-boundary-to-cycle",
          title: "Jump to this cycle in Workflow",
          onclick: (ev) => {
            ev.stopPropagation();
            state.workspaceTab = "Workflow";
            if (isHistory) {
              const crKey = lensKey("cr", plan.cr);
              if (!lensOpenKeys.has(crKey)) {
                lensOpenKeys.add(crKey);
                lensOpenRev.val += 1;
              }
            }
            revealCycleRow(cycleId);
          },
        },
        "⚑ Cycle",
      );
    };

    // Completed cycles (done/skipped/failed) carry the §S1 navigation badge.
    const cycleIsCompleted = (cycle) =>
      cycle.status === "done" || cycle.status === "skipped" || cycle.status === "failed";

    // One todo row per cycle: `<glyph> cycle <n> · "<label>" · <status>`
    // (§S6 #2, label QUOTED, ACTIVE row bold, inline `[<kind>]` badge for
    // non-default kinds, §S6 #4). RULED (a) — the ACTIVE cycle's open span
    // renders its linked runs ALWAYS inline (no toggle element at all; the
    // toggle contract narrows to History), trailed by the dim
    // `awaiting orchestrator confirm` annotation (§S6 #3).
    const CycleRow = (cycle, ordinal) => {
      // §S3 — ember badge inline after `· ACTIVE`, before the open span;
      // dim sealed timer trailing the bare done label. Null when the cycle
      // predates the timestamp migration (F13 fixtures stay byte-identical).
      const timer = CycleTimer(cycle);
      const narration = cycleNarration(cycle);
      const lineParts = [
        `cycle ${ordinal} · "${cycle.label}"`,
        ...(cycle.kind !== undefined && cycle.kind !== "red-green"
          ? [
              " [",
              span(
                { "data-testid": "cycle-kind-badge", class: "app-cycle-kind-badge" },
                cycle.kind,
              ),
              "]",
            ]
          : []),
        ...(narration !== null ? [` · ${narration}`] : []),
      ];
      return div(
        {
          "data-testid": "cycle-row",
          "data-status": cycle.status,
          // CR-CRU-025 §S2 — carry the cycle id (mirrors §S1's
          // `declared-marker`) so a Runs boundary → cycle jump can match this
          // active row by cycleId.
          "data-cycle-id": cycle.id,
          class: `app-cycle-row cycle-status-${cycle.status}`,
        },
        div(
          { class: "app-cycle-line" },
          span(
            { "data-testid": "cycle-glyph", class: "app-cycle-glyph" },
            CYCLE_GLYPHS[cycle.status] ?? CYCLE_GLYPHS.pending,
          ),
          cycle.status === "active"
            ? b({ class: "app-cycle-text" }, ...lineParts)
            : span({ class: "app-cycle-text" }, ...lineParts),
          ...(timer !== null ? [" ", timer] : []),
          // CR-CRU-025 §S1 — trailing Runs-boundary affordance, AFTER the
          // timer, on completed rows only (a separate node — never rebinding).
          ...(cycleIsCompleted(cycle) ? [" ", CycleToRunsBadge(cycle.id)] : []),
        ),
        cycle.status === "active" ? OpenSpan(cycle.id) : null,
      );
    };

    // §S6 #1 — `Active workflow — <cr> · <track> · wave <n>` (track segment
    // omitted when absent — solo model; wave segment likewise).
    const activeHeaderText = (plan) =>
      ["Active workflow — " + plan.cr]
        .concat(plan.track !== undefined ? [plan.track] : [])
        .concat(plan.wave !== undefined ? [`wave ${plan.wave}`] : [])
        .join(" · ");

    // CR-CRU-026 §S2 — STRICT render guard: the Workflow lens paints ONLY
    // plans DECLARING the routed project's key (defense in depth over the
    // §S1 clear — even if stale data survives a race, a plan tagged for
    // another project, or one with NO projectKey at all, never renders
    // here). C1's undefined-tolerance is dropped (sanctioned follow-up).
    const scopedPlans = () =>
      state.plans.filter((p) => p.projectKey === state.route.projectKey);

    const WorkflowActive = () => {
      const openPlans = scopedPlans().filter((p) => p.status === "open");
      return div(
        { "data-testid": "workflow-active", class: "app-workflow-active" },
        openPlans.length === 0
          ? div(
              { class: "app-empty" },
              "no open plan — file one via POST /api/v2/projects/<key>/plans",
            )
          : openPlans.map((plan) =>
              div(
                { class: "app-workflow-plan" },
                div(
                  {
                    "data-testid": "workflow-active-header",
                    class: "app-pane-section-title",
                  },
                  activeHeaderText(plan),
                ),
                // §S6 #11 (re-baselined 2026-07-17) — the CR ROOT:
                // heat-highlighted id, ` · <title>` when the plan carries
                // one, ` — <orchestrator>` when stamped (each segment
                // independently omitted when absent), the cycle rows
                // INDENTED beneath it.
                div(
                  { "data-testid": "workflow-cr-root", "data-cr": plan.cr, class: "app-cr-root" },
                  span(
                    { "data-testid": "cr-root-id", class: "app-heat-ink" },
                    plan.cr,
                  ),
                  plan.title !== undefined ? ` · ${plan.title}` : null,
                  plan.title !== undefined && plan.orchestrator !== undefined
                    ? ` — ${plan.orchestrator}`
                    : null,
                ),
                div(
                  { class: "app-cr-root-cycles" },
                  (plan.cycles ?? []).map((cycle, i) => CycleRow(cycle, i + 1)),
                ),
              ),
            ),
      );
    };

    // CR-CRU-013 §S4 — shared no-mistakes gate rendering body (ONE form,
    // reused by both the §S3 timeline drill-in GateBody AND the Workflow-tab
    // contextual widget below): outcome banner → one step-row per submitted
    // step → one fix-row per submitted fix → the push/PR line.
    const gateBodyContent = (g) => {
      const steps = g.steps ?? [];
      const fixes = g.fixes ?? [];
      const push = g.push ?? {};
      return [
        div(
          {
            "data-testid": "gate-outcome-banner",
            class: `app-pill app-gate-banner app-gate-${gateOutcomeClass(g.outcome)}`,
          },
          `no-mistakes ${g.outcome}`,
        ),
        steps.map((s) =>
          div(
            { "data-testid": "gate-step-row", class: "app-gate-step-row app-tree-line" },
            span({ class: "app-gate-step-name" }, s.name),
            " · ",
            span({ class: "app-gate-step-status" }, s.status),
            s.findings !== undefined && s.findings !== null ? " · " : null,
            s.findings !== undefined && s.findings !== null
              ? span({ class: "app-gate-step-findings" }, `${s.findings.total} findings`)
              : null,
          ),
        ),
        fixes.map((f) =>
          div(
            { "data-testid": "gate-fix-row", class: "app-gate-fix-row app-tree-line" },
            span({ class: "app-gate-fix-id" }, f.id),
            " · ",
            span({ class: "app-gate-fix-file" }, f.file),
            " · ",
            span({ class: "app-gate-fix-desc" }, f.description),
          ),
        ),
        div(
          { "data-testid": "gate-push-line", class: "app-gate-push-line" },
          `pushed ${shortCommit(push.commit)} → ${push.remote ?? ""}${
            g.pr ? ` · ${g.pr}` : ""
          }`,
        ),
      ];
    };

    // §S4 — scoped gate events for the routed project (kind:"gate" only).
    const scopedGateEvents = () =>
      state.events.filter(
        (e) => e.projectKey === state.route.projectKey && e.kind === "gate",
      );

    // §S4 — the Workflow-tab primary zone is CONTEXTUAL and mutually
    // exclusive: it shows the LIVE PLAN during normal execution, OR the
    // no-mistakes gate widget ONLY at the wave/release boundary (every
    // scoped plan closed — no CR active — AND a gate event exists). The
    // boundary gate is the LATEST scoped gate (latest wins). Returns null
    // when the live plan should own the zone (so no gate element mounts).
    const boundaryGate = () => {
      const plans = scopedPlans();
      if (plans.length === 0) return null;
      if (plans.some((p) => p.status === "open")) return null; // a CR is active
      const gates = scopedGateEvents();
      if (gates.length === 0) return null;
      return gates.reduce(
        (latest, e) => (latest === null || e.timestamp > latest.timestamp ? e : latest),
        null,
      );
    };

    // §S4 — the contextual gate widget, mounted under the SAME `gate-pane`
    // testid the removed CR-011 placeholder used (in place, not a new name),
    // reusing the shared gate body so its outcome banner + step ladder carry
    // the identical `gate-outcome-banner` / `gate-step-row` testids.
    const GateWidget = (event) =>
      div(
        { "data-testid": "gate-pane", class: "app-gate-pane" },
        div({ class: "app-pane-section-title" }, "Gate"),
        div({ class: "app-drillin-gate" }, gateBodyContent(event.gate ?? {})),
      );

    // §S4 — exactly one of the live plan or the gate widget, never both.
    const WorkflowPrimary = () => {
      const gate = boundaryGate();
      return gate !== null ? GateWidget(gate) : WorkflowActive();
    };

    // ── §S3 history lens — Wave → [Track] → CR → Cycle (C4) ─────────────
    // Grouping is pure (app-logic workflowLens); this is the render layer.
    // Rows are text-color only; chips/badges are the boxed elements.

    // Participating-agent runtime (§S2 surface): the server-computed
    // runtime_ms off the agents slice, sealed or ticking as the row is.
    const CrAgentRuntime = (agentId) => {
      const agent = state.agents.find((a) => a.agentId === agentId);
      return div(
        { "data-testid": "cr-agent-runtime", class: "app-card-meta" },
        span({ class: "app-agent-id" }, agentId),
        ` · ${fmtDuration(agent?.runtime_ms ?? 0)}`,
      );
    };

    // CR-CRU-020 §S2.1 — history cycle rows own a DISTINCT toggle level for
    // their linked runs (collapsed by default); done + active rows are the
    // expandable ones. Inferred cycles carry no id — key on cr + label.
    const LensCycleRow = (cycle, crName) => {
      const expandable = cycle.status === "done" || cycle.status === "active";
      const key = lensKey("cycle", cycle.id ?? `${crName}:${cycle.label}`);
      // §S3 — history rows show the SAME sealed `doneAt − activatedAt`
      // timer as the active section (null when timestamps predate C4).
      const timer = CycleTimer(cycle);
      return div(
        {
          "data-testid": "lens-cycle-row",
          "data-status": cycle.status,
          // CR-CRU-025 §S2 — carry the cycle id (mirrors §S1's
          // `declared-marker`) so a Runs boundary → cycle jump can match this
          // history row by cycleId.
          "data-cycle-id": cycle.id,
          class: `app-cycle-row cycle-status-${cycle.status}`,
        },
        div(
          { class: "app-cycle-line" },
          expandable
            ? span(
                {
                  "data-testid": "cycle-toggle",
                  class: "app-cycle-toggle",
                  onclick: () => lensToggle(key),
                },
                ToggleGlyph(key),
              )
            : null,
          span(
            { class: "app-cycle-glyph" },
            CYCLE_GLYPHS[cycle.status] ?? CYCLE_GLYPHS.pending,
          ),
          span({ class: "app-cycle-label" }, cycle.label),
          ...(timer !== null ? [" ", timer] : []),
          // CR-CRU-025 §S1/§S0 — the Runs-boundary badge, a SEPARATE node
          // from the existing `cycle-toggle` drill-down glyph, on completed
          // rows only.
          ...(cycleIsCompleted(cycle) ? [" ", CycleToRunsBadge(cycle.id)] : []),
          // CR-CRU-021 §S6 #8 — collapsed rows hint at their linked runs.
          expandable
            ? () =>
                !lensOpen(key) && cycle.runs.length > 0
                  ? span(
                      { class: "app-card-meta app-run-count-hint" },
                      `▸ ${cycle.runs.length} run${cycle.runs.length === 1 ? "" : "s"}`,
                    )
                  : ""
            : null,
        ),
        // A done cycle is a CLOSED span wrapping its linked runs; the active
        // cycle keeps collecting its runs live (open span, §S3). Both sit
        // behind the row's own toggle (§S2.1/§S2.2 drill-down).
        expandable
          ? () => {
              if (!lensOpen(key)) return "";
              return cycle.status === "done"
                ? div(
                    { "data-testid": "cycle-span-closed", class: "app-cycle-span-closed" },
                    cycle.runs.map(LinkedRunRow),
                  )
                : cycle.runs.length > 0
                  ? div({ class: "app-cycle-runs" }, cycle.runs.map(LinkedRunRow))
                  : "";
            }
          : null,
      );
    };

    const LensCrGroup = (node) => {
      const key = lensKey("cr", node.cr);
      return div(
        {
          "data-testid": "cr-group",
          "data-cr": node.cr,
          "data-status": node.status ?? "inferred",
          class: "app-cr-group",
        },
        // CR-CRU-020 §S1.2 — the existing header row IS the toggle; only the
        // cycle list collapses (by default) beneath it. CR-CRU-021 §S6 #6/#9
        // — the collapsed form is INLINE DIM TEXT, not pill-chips:
        // `▸ [<track> › ]<cr> · <n> cycles ✓ · merged <sha>` (no `@`).
        // CR-CRU-023 §S4 #2 — the hidden `.app-hidden-data` cr-rollup
        // compatibility span is retired; the visible rollup form carries
        // the done/total figures.
        div(
          {
            "data-testid": "cr-group-toggle",
            class: "app-cr-line app-lens-toggle app-card-meta",
            onclick: () => lensToggle(key),
          },
          ToggleGlyph(key),
          " ",
          node.track !== undefined
            ? [
                span({ "data-testid": "track-badge", class: "app-cr-track" }, node.track),
                " › ",
              ]
            : null,
          span({ class: "app-cr-name" }, node.cr),
          node.rollup.total > 0 && node.rollup.done === node.rollup.total
            ? ` · ${node.rollup.total} cycles ✓`
            : ` · ${node.rollup.done}/${node.rollup.total} cycles`,
          node.merge !== undefined
            ? [
                " · ",
                span(
                  { "data-testid": "cr-merge-commit", class: "app-cr-merge" },
                  `merged ${node.merge.commit}`,
                ),
              ]
            : null,
        ),
        () =>
          lensOpen(key)
            ? div(
                { class: "app-cr-cycles" },
                node.cycles.map((c) => LensCycleRow(c, node.cr)),
              )
            : "",
        // CR-CRU-021 §S4 — the collapsed header carries ZERO agentId-bearing
        // elements; participating agents surface as an aggregate `N agents`
        // pill in the header REGION, and per-agent runtime rows render only
        // behind the group's expansion (CR-011's information survives, one
        // level down). CR-CRU-020 §S2 (C3) fleet-registered semantics are
        // unchanged: a raw run agentId with no fleet record never fabricates
        // a 0ms row and is excluded from the pill count. Zero registered
        // participants → no pill at all (never `0 agents`).
        () => {
          if (!lensOpen(key)) return "";
          const registered = node.agents.filter((id) =>
            state.agents.some((a) => a.agentId === id),
          );
          if (registered.length === 0) return "";
          return div(
            { class: "app-cr-agents" },
            span(
              { "data-testid": "cr-agents-pill", class: "app-pill app-card-meta" },
              `${registered.length} agent${registered.length === 1 ? "" : "s"}`,
            ),
            registered.map(CrAgentRuntime),
          );
        },
      );
    };

    // CR-CRU-021 §S6 #5 — ONE combined header line per wave:
    // `History — Wave <n> · lanes: <chips> · <state>` (wave, lane chips and
    // boundary state inline — never separate rows).
    const WaveHeader = (wave) => {
      const chips = wave.state?.chips ?? [];
      return div(
        { "data-testid": "wave-header", class: "app-wave-header" },
        span({ class: "app-pane-section-title" }, `History — Wave ${wave.wave}`),
        chips.length > 0
          ? [
              " · lanes: ",
              ...chips.flatMap((chip, i) => [
                i > 0 ? " · " : null,
                span({ "data-testid": "lane-chip", class: "app-lane-chip" }, chip),
              ]),
              span({ class: "app-card-meta" }, ` · ${wave.state.label}`),
            ]
          : wave.state !== null
            ? span({ class: "app-card-meta" }, ` · ${wave.state.label}`)
            : null,
      );
    };

    const WaveGroup = (wave) =>
      div(
        {
          "data-testid": "wave-group",
          "data-wave": wave.wave,
          "data-source": wave.source,
          class: "app-wave-group",
        },
        WaveHeader(wave),
        wave.tracks !== null
          ? wave.tracks.map((t) =>
              div(
                { "data-testid": "track-group", "data-track": t.track, class: "app-track-group" },
                t.crs.map(LensCrGroup),
              ),
            )
          : null,
        wave.crs.map(LensCrGroup),
      );

    // CR-CRU-020 §S1.4 (corrected at the 2026-07-16 gate review) — the
    // Workflow view renders plan/cycle structure ONLY: no ungrouped run
    // listing of any form. Unlinked runs remain fully visible on the Runs
    // timeline (the never-hidden rule lives there).
    const WorkflowHistory = () => {
      const lens = L.workflowLens({
        plans: scopedPlans(), // CR-CRU-026 §S2 — same guard as Active
        events: state.events.filter((e) => e.projectKey === state.route.projectKey),
      });
      return div(
        // §S6 #5 — no standalone "History" title row; each wave's combined
        // `History — Wave <n> · …` header line carries the section naming.
        { "data-testid": "workflow-history", class: "app-workflow-history" },
        lens.waves.length === 0
          ? div({ class: "app-empty" }, "no workflow history yet")
          : lens.waves.map(WaveGroup),
      );
    };

    // CR-CRU-021 §S6 #10 — NO `Workflow — <project>` rail-title above the
    // active header: the F13 header structure is the pane's whole top.
    const WorkflowFeed = () =>
      div(
        { "data-testid": "pane-scroll", class: "app-pane-content" },
        paneRunway(
          div(
            { class: "app-workflow-cols" },
            () => WorkflowPrimary(),
          ),
          // §S3 history lens — the grouped Wave → [Track] → CR → Cycle tree.
          () => WorkflowHistory(),
        ),
      );

    const WorkflowPanel = () =>
      div({ class: greyed("app-center") }, WorkflowFeed());

    // CR-CRU-016 §S1 (C5) — the workspace detail: run-overlay wraps the
    // detail header AND the detail's own scroller, so the header (back chip ·
    // RUN DETAIL · density) sits ABOVE the scrolling content and never moves
    // with it (header-always-visible), while the overlay container still
    // carries the chip/anatomy for the drill-in contracts.
    const WorkspaceRunDetail = (eventId) => {
      // CR-CRU-034 §S1 — the pane-scroll box owns the run-detail body's
      // vertical scroll AND sources §S4.4 virtualization (onscroll).
      // CR-CRU-038 §S3 — build the body FIRST so the header can mount its
      // failure-jump + raw-toggle controls (wired to this body's state).
      const detailBody = RunDetailBody(eventId);
      return div(
        { "data-testid": "run-overlay", class: "app-drillin app-inpane app-detail-col" },
        div(
          { class: "app-drillin-head app-top" },
          ...DetailHeadContent(eventId, detailBody.headerControls),
        ),
        div(
          { "data-testid": "workspace-runs", class: greyed("app-center") },
          // CR-CRU-023 §S1 — the in-pane run detail renders inside the SAME
          // shared pane-content wrapper as every other central pane, so the
          // horizontal scroll floor is one mechanism, not a per-pane one-off.
          div(
            {
              "data-testid": "pane-scroll",
              class: "app-pane-content",
              onscroll: detailBody.handlePaneScroll,
            },
            detailBody.body,
          ),
        ),
      );
    };

    // AC2 — the feed pane returns at its exact prior scrollTop after a
    // detail closes (same discipline as home's paneSwap, hoisted to the
    // body slot because the detail replaces the whole tab pane here).
    let wsShowingDetail = false;
    const WorkspaceBody = () => {
      // ONE RULE — the detail is a state of WHICHEVER tab pane is active;
      // no tab switching happens on open or close.
      if (state.route.overlay !== undefined) {
        wsShowingDetail = true;
        return WorkspaceRunDetail(state.route.overlay);
      }
      const pane =
        state.workspaceTab === "Workflow"
          ? WorkflowPanel()
          : state.workspaceTab === "Coverage"
            ? CoveragePanel()
            : state.workspaceTab === "Compile"
              ? CompilePanel()
              : state.workspaceTab === "Roadmap"
                ? RoadmapPanel()
                : state.workspaceTab === "BDD"
                  ? BddPlaceholder()
                  : WorkspaceRuns();
      if (wsShowingDetail) {
        wsShowingDetail = false;
        queueMicrotask(() => {
          // CR-CRU-029 §S1 — the pane's `[data-testid="pane-scroll"]` box is
          // the scroller now (not the `.app-center` wrapper); restore onto it.
          const sc = pane.querySelector('[data-testid="pane-scroll"]');
          if (sc !== null) sc.scrollTop = savedPaneScroll;
        });
      }
      return pane;
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

    // ── §S3 (CR-CRU-007) — codec-aware drill-in, in-pane (CR-CRU-016) ───
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

    // Body factory shared by BOTH detail containers (home in-pane form and
    // the workspace's WorkspaceRunDetail wrapper): owns the fetch/suite
    // state and renders the codec-aware body.
    const RunDetailBody = (eventId) => {
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
          // CR-CRU-038 §S1 — an error run opens MINIMIZED: NO suite (failing
          // or not) is auto-expanded/fetched on open. Every suite renders as
          // a collapsed header (▸) carrying its inline ✗/✓ counts; leaves
          // load only on an explicit suite-row click or when the failure-jump
          // walks to a failing leaf. All-pass runs are unchanged (they never
          // had a failing suite to auto-expand).
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

      // F4 — a failed leaf's failure box: inline (no click) in Detail until
      // the user focuses a leaf; after any leaf click only the focused
      // failed leaf shows its box. Density starts with boxes closed —
      // heat-cell / leaf clicks focus-open them.
      function failureBoxVisible(key, presentation) {
        const focused = focusedLeaf.val;
        if (focused === null) return presentation === "Detail";
        return focused === key;
      }

      // One leaf row (+ its failure box when visible). §S3 failure-box
      // degradation (user defect 2026-07-15): the box NEVER renders empty —
      // message → else failure.type → else `test failed`; when the message
      // is absent a dim reporter note is appended; the trace block renders
      // only when a trace exists.
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
        if (failed && failureBoxVisible(key, presentation)) {
          const failure = leaf.failure ?? null;
          const hasMessage =
            typeof failure?.message === "string" && failure.message.length > 0;
          const hasType = typeof failure?.type === "string" && failure.type.length > 0;
          const messageLine = hasMessage
            ? failure.message
            : hasType
              ? failure.type
              : "test failed";
          const hasTrace = typeof failure?.trace === "string" && failure.trace.length > 0;
          nodes.push(
            div(
              { "data-testid": "failure-box", class: "app-failure-box" },
              div({ class: "app-failure-message" }, messageLine),
              hasMessage
                ? null
                : div(
                    { class: "app-failure-note" },
                    "no failure detail captured by the reporter",
                  ),
              hasTrace ? div({ class: "app-failure-trace" }, failure.trace) : null,
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
            "data-suite": suiteName, // §S1 — window offset lookup off pane-scroll
            class: "app-tree-scroll app-leaf-list",
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
          onclick: async () => {
            // CR-CRU-038 §S1 — a heat cell on a suite that is still collapsed
            // (the minimized-error-run default) is synthetic. Clicking it
            // EXPANDS the suite (loads its leaves); a red cell additionally
            // focus-opens the suite's first failing leaf's failure box (the
            // CR-016 one-box focus model), so the click takes the user
            // straight to that failure instead of just unfolding the tree.
            await loadSuite(suiteName);
            if (status !== "fail") return;
            const leaves = suiteLeaves.val[suiteName] ?? [];
            const failIdx = leaves.findIndex((l) => l.status === "fail");
            if (failIdx < 0) return;
            suiteWindow.val = {
              ...suiteWindow.val,
              [suiteName]: Math.max(0, failIdx - Math.floor(VIRT_WINDOW / 2)),
            };
            const leaf = leaves[failIdx];
            if (leaf.failure !== undefined) {
              openGroups.val = {
                ...openGroups.val,
                [`${suiteName}::${leaf.failure.message}`]: true,
              };
            }
            focusedLeaf.val = `${suiteName}::${leaf.name}`;
          },
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

      // §S2 focus-model contract (CR-CRU-016) — the footer jump ADVANCES to
      // the next failing leaf and FOCUSES it: exactly that leaf's failure
      // box opens (focusedLeaf keeps ONE box open at a time — repeated
      // jumps move the box, they never accumulate) and its row scrolls
      // into the pane's viewport.
      async function jumpToNextFailure(d) {
        // CR-CRU-038 §S1 — from the minimized default the failing suites'
        // leaves aren't loaded yet, so failingLeafKeys() would be empty. Load
        // (and thereby expand ▾) the failing suites on demand so the walk can
        // reach every failing leaf; then advance the one-box focus cursor.
        for (const name of L.foldSuites(d.tree ?? [])) await loadSuite(name);
        const keys = failingLeafKeys(d);
        if (keys.length === 0) return;
        jumpPos = (jumpPos + 1) % keys.length;
        const target = keys[jumpPos];
        const sep = target.indexOf("::");
        const suiteName = target.slice(0, sep);
        const leafName = target.slice(sep + 2);
        const leaf = (suiteLeaves.val[suiteName] ?? []).find((l) => l.name === leafName);
        if (typeof leaf?.failure?.message === "string") {
          // A digest-grouped target expands its group so the row is visible.
          openGroups.val = {
            ...openGroups.val,
            [`${suiteName}::${leaf.failure.message}`]: true,
          };
        }
        focusedLeaf.val = target;
        // CR-CRU-034 §S1 — DEFER **and CONVERGE** the row scroll until AFTER
        // VanJS has actually finished re-rendering. Setting focusedLeaf/
        // openGroups above only SCHEDULES an async VanJS render: the
        // previously-focused failure box (mounted ABOVE the target) is removed
        // and the target's own box opens directly below its row, which shifts
        // every offsetTop below the old box. A single requestAnimationFrame
        // RACES that render — it can fire before VanJS flushes and scroll the
        // STALE pre-render layout, leaving the focused row stuck above the
        // pane top (a longer fixed delay "fixes" it only by luck). Polling on
        // offsetTop-stability is unsafe too: the stale offsetTop reads
        // "stable" until the render lands. So, like `revealDeclaredMarker`,
        // retry on a bounded real-timer loop, re-querying the fresh
        // `[data-leaf-key]` row each attempt, and only scroll ONCE the render
        // has SETTLED — detected by the target row's OWN failure box being
        // mounted as its next sibling. The CR-016 one-box-at-a-time focus
        // model guarantees that signal flips false→true exactly when the old
        // box has been removed and the layout is final, so the scroll always
        // measures the settled positions regardless of VanJS's scheduler
        // timing. A bounded attempt cap falls back to a best-effort scroll so
        // the jump can never silently stall. scrollIntoView still fires on the
        // target row (block:"start") into the SAME bounded pane-scroll
        // viewport, exactly once.
        const scrollFocusedRowIntoView = (attempts = 0) => {
          let row = null;
          const rows = document.querySelectorAll('[data-testid="leaf-row"]');
          for (const r of rows) {
            if (r.getAttribute("data-leaf-key") === target) {
              row = r;
              break;
            }
          }
          // CR-CRU-034 §S1 — the focus collapse is COMPLETE only when exactly
          // ONE `[data-testid="failure-box"]` remains in the run-overlay AND it
          // is the TARGET's own box (its `previousElementSibling` is the target
          // `[data-leaf-key]` row). The old signal ("the target row has a
          // failure-box next sibling") is TRUE too early: in tier-"unit" Detail
          // mode every failing leaf renders its box while nothing is focused, so
          // the target's own box already sits below its row BEFORE VanJS removes
          // the OTHER boxes. Scrolling then measures the STALE tall content and
          // the scrollTop is CLAMPED away once the collapse shrinks the content
          // to its final height. Waiting for the single-box terminal state
          // guarantees the content is at its final height, so scrollIntoView
          // lands (and is not clamped). Holds for the one-box→one-box move
          // (old box removed, new mounted) and the multi-suite case alike.
          const overlay = document.querySelector('[data-testid="run-overlay"]');
          const boxes = (overlay ?? document).querySelectorAll(
            '[data-testid="failure-box"]',
          );
          const settled =
            row !== null &&
            boxes.length === 1 &&
            boxes[0].previousElementSibling === row;
          if (!settled && attempts < 30) {
            setTimeout(() => scrollFocusedRowIntoView(attempts + 1), 5);
            return;
          }
          if (row !== null && typeof row.scrollIntoView === "function") {
            row.scrollIntoView({ block: "start" });
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => scrollFocusedRowIntoView(0));
        } else {
          queueMicrotask(() => scrollFocusedRowIntoView(0));
        }
      }

      // CR-CRU-038 §S2 — resolve the raw blob to surface: the focused/failing
      // leaf's own `raw` capture (a forward-compat per-leaf field) is PREFERRED
      // over the run-level `d.raw` blob; when neither exists the raw content is
      // absent (and the raw-toggle control is withheld entirely — no more
      // "toggle that reveals nothing"). Reads suiteLeaves.val / focusedLeaf.val
      // so it re-resolves reactively as suites load.
      function resolveRaw(d) {
        const focused = focusedLeaf.val;
        const leavesMap = suiteLeaves.val;
        const leafRawOf = (predicate) => {
          for (const suite of d.tree ?? []) {
            const leaves = leavesMap[suite.name];
            if (leaves === undefined) continue;
            for (const leaf of leaves) {
              const key = `${suite.name}::${leaf.name}`;
              if (!predicate(leaf, key)) continue;
              if (typeof leaf.raw === "string" && leaf.raw.length > 0) return leaf.raw;
            }
          }
          return null;
        };
        // 1) the focused leaf's raw, 2) any failing leaf's raw, 3) the run blob.
        const focusedRaw =
          focused !== null ? leafRawOf((_leaf, key) => key === focused) : null;
        if (focusedRaw !== null) return focusedRaw;
        const failingRaw = leafRawOf((leaf) => leaf.status === "fail");
        if (failingRaw !== null) return failingRaw;
        if (typeof d.raw === "string" && d.raw.length > 0) return d.raw;
        return null;
      }

      // CR-CRU-038 §S3 — the failure-jump + raw-toggle relocate to the drill-in
      // HEADER (siblings of the density chip via DetailHeadContent's `controls`
      // slot); the FailuresFooter that used to carry them in the body is
      // retired. Each control is an independent reactive child so both sit
      // directly under the header container. failure-jump: test kind, ≥1
      // failure. raw-toggle: only when raw content EXISTS (§S2).
      const headerControls = [
        // CR-CRU-038 §S3 — each control is a standalone reactive child of the
        // header; it must return "" (not null) when withheld — a null-returning
        // derived child is dropped as static and never re-renders when detail
        // loads (matches the App-level `manage ? … : ""` idiom).
        () => {
          const d = detail.val;
          if (d === null || d.kind !== "test") return "";
          const failed = d.summary?.failed ?? 0;
          if (failed < 1) return "";
          return button(
            {
              "data-testid": "failure-jump",
              class: "app-chip app-drillin-headchip",
              onclick: () => jumpToNextFailure(d),
            },
            `▸ ${failed - 1} more failures`,
          );
        },
        () => {
          const d = detail.val;
          if (d === null || d.kind !== "test") return "";
          if (resolveRaw(d) === null) return "";
          return button(
            {
              "data-testid": "raw-toggle",
              class: "app-chip app-drillin-headchip",
              onclick: () => {
                showRaw.val = !showRaw.val;
              },
            },
            "toggle raw output",
          );
        },
      ];

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
          // CR-CRU-038 §S2/§S3 — the failure-jump + raw-toggle moved to the
          // header; only the raw <pre> OUTPUT stays in the body scroller,
          // showing the RESOLVED raw (per-leaf preferred over the run blob).
          // Read synchronously so the enclosing body derivation tracks showRaw
          // and rebuilds TestBody on toggle.
          showRaw.val && resolveRaw(d) !== null
            ? pre({ "data-testid": "raw-output", class: "app-raw-output" }, resolveRaw(d))
            : null,
        );
      };

      // Compile body — §S3 (user defect 2026-07-15): a status line ALWAYS
      // renders first (`<format> · N errors · M warnings`, pass-green when
      // errorCount is 0, fail-red otherwise), then diagnostics grouped by
      // file (level-colored lines) when present, else the empty-state line
      // `clean compile — no diagnostics`; the raw-output toggle renders
      // ONLY when a non-empty raw is stored. No mode switch renders for
      // compile events.
      const CompileBody = (d) => {
        const compile = d.compile ?? {};
        const errorCount = compile.errorCount ?? 0;
        const warningCount = compile.warningCount ?? 0;
        const format = compile.format ?? "compile";
        const hasRaw = typeof compile.raw === "string" && compile.raw.length > 0;
        const groups = new Map();
        for (const diag of compile.diagnostics ?? []) {
          const file = diag.file ?? "(unknown file)";
          if (!groups.has(file)) groups.set(file, []);
          groups.get(file).push(diag);
        }
        return div(
          { class: "app-drillin-diags" },
          div(
            {
              "data-testid": "compile-status",
              class: `app-pill app-compile-status ${
                errorCount > 0 ? "app-ratio-fail" : "app-ratio-pass"
              }`,
            },
            `${format} · ${errorCount} errors · ${warningCount} warnings`,
          ),
          groups.size === 0
            ? div({ class: "app-empty" }, "clean compile — no diagnostics")
            : [...groups.entries()].map(([file, lines]) =>
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
          hasRaw
            ? button(
                {
                  "data-testid": "raw-toggle",
                  class: "app-chip app-raw-toggle",
                  onclick: () => {
                    showRaw.val = !showRaw.val;
                  },
                },
                showRaw.val ? "hide raw output" : "show raw output",
              )
            : null,
          showRaw.val && hasRaw
            ? pre(
                { "data-testid": "raw-output", class: "app-raw-output" },
                compile.raw,
              )
            : null,
        );
      };

      // CR-CRU-013 §S3 — GateBody drill-in (codec-aware, single form like
      // compile: no Detail/Density switch). Outcome banner → one step-row per
      // submitted step (name + status; the review step shows its findings
      // count) → one fix-row per submitted fix (id/file/description) → the
      // push/PR line. A gate event never falls through to TestBody's
      // suite/leaf anatomy.
      const GateBody = (d) =>
        div({ class: "app-drillin-gate" }, gateBodyContent(d.gate ?? {}));

      // CR-CRU-034 §S1 — virtualization re-sourced off the bounded pane
      // scroller. The retired per-suite `.app-tree-scroll` no longer owns a
      // scroll listener; instead the ONE `[data-testid="pane-scroll"]` box
      // (this body's ancestor) drives every expanded suite's window. Each
      // suite's window start = the pane's scroll depth INTO that suite
      // (pane.scrollTop − the suite list's offsetTop within the pane), in
      // rows; SuiteLeafList clamps it to the suite's own bounds.
      const handlePaneScroll = (e) => {
        const pane = e.target;
        if (pane === null || pane === undefined) return;
        const scrollTop = pane.scrollTop ?? 0;
        const lists = pane.querySelectorAll('[data-testid="tree-scroll"]');
        let next = null;
        for (const list of lists) {
          const name = list.getAttribute("data-suite");
          if (name === null) continue;
          const into = scrollTop - (list.offsetTop ?? 0);
          const start = Math.max(0, Math.floor(into / VIRT_ROW_HEIGHT));
          if ((suiteWindow.val[name] ?? 0) !== start) {
            if (next === null) next = { ...suiteWindow.val };
            next[name] = start;
          }
        }
        if (next !== null) suiteWindow.val = next;
      };

      // CR-CRU-017 §S3 — an aborted run's drill-in leads with WHY it was
      // aborted, above whatever partial context the run left behind. It is a
      // banner, not a replacement body: the run's suites/leaves (if it produced
      // any before dying) still render underneath, which is exactly the
      // "whatever partial context exists" the CR asks for.
      const AbortBanner = (d) =>
        div(
          { class: "app-drillin-abort" },
          span(
            { "data-testid": "abort-reason", class: "app-pill app-abort-reason" },
            `aborted — ${d.abortReason ?? "reason unrecorded"}`,
          ),
          typeof d.runtimeMs === "number"
            ? span(
                { "data-testid": "abort-runtime", class: "app-card-meta" },
                `ran for ${fmtDuration(d.runtimeMs)} before it was aborted`,
              )
            : null,
        );

      const body = div({ class: "app-drillin-body" }, () => {
        if (loadError.val !== null)
          return div({ class: "app-empty" }, loadError.val);
        const d = detail.val;
        if (d === null)
          return div({ class: "app-empty" }, "loading run detail…");
        if (d.kind === "gate") return GateBody(d);
        if (d.kind === "compile") return CompileBody(d);
        return d.status === "aborted"
          ? div(AbortBanner(d), TestBody(d))
          : TestBody(d);
      });

      return { body, handlePaneScroll, headerControls };
    };

    // CR-CRU-016 §S1 — home's pane-state container: the detail renders
    // INSIDE the timeline pane. The scrim + right slide-over sheet are
    // RETIRED (no fixed positioning, no backdrop — /manage and /roadmap
    // overlays are unaffected). The `run-overlay` testid is kept as the
    // detail container's stable handle (RED's deliberate compatibility
    // choice — the drill-in/density anatomy suites scope by it), and the
    // in-overlay head is a hidden COMPAT copy of the same contract (chip +
    // title + density) for the pre-C5 overlay-scoped assertions — the
    // VISIBLE home header is the band Home() pins above this pane's
    // scroller (§S1 header-always-visible).
    const RunDetail = (eventId) => {
      // CR-CRU-034 §S1 — the pane-scroll box owns the run-detail body's
      // vertical scroll AND sources §S4.4 virtualization (onscroll).
      // CR-CRU-038 §S3 — SHARED instance: the home visible band consumes the
      // same body's headerControls, so this build happens once per open.
      const detailBody = detailBodyFor(eventId);
      return div(
        { "data-testid": "run-overlay", class: "app-drillin app-inpane" },
        div(
          { class: "app-drillin-inhead" },
          DetailHeadContent(eventId, detailBody.headerControls),
        ),
        // CR-CRU-023 §S1 — same shared pane-content wrapper as the
        // workspace's WorkspaceRunDetail form: the run detail is one of the
        // seven floored pane surfaces wherever it renders. Post CR-CRU-029
        // §S1/§S2, paneSwap's scroll save/restore reads the run-detail's OWN
        // inner `pane-scroll` box (detailDom.querySelector('[data-testid=
        // "pane-scroll"]')) — this wrapper — not the outer timeline
        // `.app-center` (see the paneSwap comment at ~1059-1063).
        div(
          {
            "data-testid": "pane-scroll",
            class: "app-pane-content",
            onscroll: detailBody.handlePaneScroll,
          },
          detailBody.body,
        ),
      );
    };

    // §S5.1/§S5.3 — home chrome is title bar + projects row; the workspace
    // swaps in its own top bar (← projects + project chip + Health Pill).
    const HomeChrome = () => div(TopBar(), ProjectsRow());

    // CR-CRU-016 AC1 — surface stability: while the surface identity (home,
    // or workspace + projectKey) is unchanged, the SAME chrome/surface DOM
    // nodes are returned (VanJS keeps an identical node in place), so
    // opening/closing a run detail never remounts the Project pane, the
    // topbar, or the projects row. A surface change rebuilds fresh DOM.
    const surfaceKeyOf = () =>
      state.route.page === "workspace"
        ? `workspace:${state.route.projectKey}`
        : "home";
    let chromeKey = null;
    let chromeDom = null;
    let surfaceKey = null;
    let surfaceDom = null;

    const App = () =>
      div(
        () => {
          const key = surfaceKeyOf();
          if (chromeKey !== key) {
            chromeKey = key;
            chromeDom =
              state.route.page === "workspace" ? WorkspaceHeader() : HomeChrome();
          }
          return chromeDom;
        },
        () => {
          const key = surfaceKeyOf();
          if (surfaceKey !== key) {
            surfaceKey = key;
            surfaceDom = state.route.page === "workspace" ? Workspace() : Home();
          }
          return surfaceDom;
        },
        // CR-CRU-012 §S2 — /manage slide-over ABOVE the home surface (the
        // surface key stays "home", so chrome/surface DOM never rebuild).
        () => (state.route.manage === true ? ProjectsManager() : ""),
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
