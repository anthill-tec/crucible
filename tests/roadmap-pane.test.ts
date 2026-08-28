// CR-CRU-014 §S3 — the Roadmap workspace tab + TABLE view. Drives the REAL
// production public/app.js shell inside a happy-dom window — the SAME harness
// pattern as tests/workflow-tab.test.ts / tests/workflow-primary-tab.test.ts:
// real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; `fetch` is scripted, including the C1 queue endpoint
// (GET /api/v2/projects/<key>/queue), the CR-CRU-074 releases endpoint
// (GET /api/v2/projects/<key>/releases) and the project-scoped plans endpoint
// (GET /api/v2/projects/<key>/plans) the roadmap live-overlay joins against.
//
// RED phase: expected to FAIL against CURRENT production, whose
// public/app-logic.mjs TAB_NAMES has NO "Roadmap" entry and whose
// public/app.js WorkspaceBody() ternary has no "Roadmap" branch, no Roadmap
// pane, no `roadmap-empty`/`roadmap-row`/`roadmap-chip` testids, and whose
// routeParse ignores the `/p/<key>/roadmap` deep-link segment — every test
// below fails at its "the Roadmap tab / pane does not exist yet" assertion.
//
// SCOPE — §S3 TABLE view ONLY. The graph-view toggle (Cytoscape) is the NEXT
// cycle and is deliberately NOT exercised here.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── Fixture shapes (queue = the GET …/queue wire contract, §S1) ────────────
type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
interface QueueEntryFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  size?: string;
  status: QueueStatus;
  planId?: number;
  // CR-CRU-091/AC18 — the STORED authored position the live read publishes on
  // every entry. `listQueue` is `ORDER BY seq`, so a fixture's ARRAY order and
  // its stamped `seq` are the same authored fact arriving on two channels; a
  // fixture that permutes one without the other is not a re-authored queue.
  seq?: number;
}
interface ReleaseFixture {
  version: string;
  commit?: string;
  timestamp: number;
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestCoverageEventId?: string;
}
interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}
interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: CycleFixture[];
}
interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  queue: QueueEntryFixture[];
  releases?: ReleaseFixture[];
  plans?: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    // Order matters: /queue and /releases both contain "/api/v2/projects".
    if (/\/api\/v2\/projects\/[^/]+\/queue/.test(url)) {
      body = { ok: true, entries: opts.queue };
    } else if (/\/api\/v2\/projects\/[^/]+\/releases/.test(url)) {
      body = { ok: true, releases: opts.releases ?? [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans ?? [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`roadmap-pane.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapPane=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function tabButton(name: string): HTMLElement | undefined {
  return findByText(document, '[data-testid="workspace-tab"]', name);
}

function tabIsOn(name: string): boolean {
  const tab = tabButton(name);
  return tab !== undefined && tab.classList.contains("on");
}

function roadmapRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="roadmap-row"]'));
}

function roadmapRow(cr: string): HTMLElement | undefined {
  return roadmapRows().find((r) => r.getAttribute("data-cr") === cr);
}

/** The rendered row order — the CR ids, top to bottom. */
function rowOrder(): (string | null)[] {
  return roadmapRows().map((r) => r.getAttribute("data-cr"));
}

/** Every wave divider's text, in the order the table renders them. */
function waveDividerText(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="roadmap-wave-divider"]'),
  ).map((d) => (d.textContent ?? "").trim());
}

/** The CRs whose row carries an authored-order warning (CR-CRU-078 AC15). */
function warnedRows(): string[] {
  return roadmapRows()
    .filter((r) => r.querySelector('[data-testid="roadmap-order-warning"]') !== null)
    .map((r) => r.getAttribute("data-cr") ?? "");
}

/**
 * A dependency-only walk of the queue: the order a renderer that RE-DERIVES
 * sequence from `dependsOn` produces (DFS post-order, deps first). Present so
 * the AC13 fixture's disagreement with such a walk is PROVEN in the test
 * rather than asserted by comment — a fixture whose authored order and
 * dependency walk agree proves nothing about which one the renderer used.
 */
function dependencyWalk(entries: QueueEntryFixture[]): string[] {
  const byCr = new Map(entries.map((e) => [e.cr, e]));
  const visited = new Set<string>();
  const out: string[] = [];
  const visit = (cr: string, stack: Set<string>): void => {
    const entry = byCr.get(cr);
    if (entry === undefined || visited.has(cr) || stack.has(cr)) return;
    stack.add(cr);
    for (const dep of entry.dependsOn) visit(dep, stack);
    stack.delete(cr);
    visited.add(cr);
    out.push(cr);
  };
  for (const entry of entries) visit(entry.cr, new Set());
  return out;
}

// ── AC (tab-list AC) — the Roadmap tab exists and the deep-link opens it ────

describe("§S3 — Roadmap is a first-class workspace tab", () => {
  test("cold /p/<key>/roadmap load renders the workspace with the Roadmap tab `on` and its pane mounted", async () => {
    const key = "roadmap-deeplink-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Deep Link Project" })],
      queue: [],
    });

    const tab = tabButton("Roadmap");
    expect(tab).toBeDefined();
    expect(tab!.classList.contains("on")).toBe(true);
    // The Roadmap pane (empty-state here, no queue) is what mounted, not Runs.
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
    expect(tabIsOn("Workflow")).toBe(false);
  });

  test("the Project pane's 🗺 roadmap chip activates the Roadmap tab (same destination, one-rule tab swap)", async () => {
    const key = "roadmap-chip-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Chip Project" })],
      queue: [],
    });

    // Cold /p/<key> defaults to Workflow — the chip must flip to Roadmap.
    expect(tabIsOn("Workflow")).toBe(true);
    const chip = document.querySelector<HTMLElement>('[data-testid="roadmap-chip"]');
    expect(chip).not.toBeNull();
    expect((chip!.textContent ?? "")).toContain("🗺");

    chip!.click();
    await settle();

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
  });

  test("the Roadmap surface is a TAB, not a slide-over — no scrim and no overlay element exist while it is active", async () => {
    const key = "roadmap-noscrim-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "No Scrim Project" })],
      queue: [],
    });

    expect(tabIsOn("Roadmap")).toBe(true);
    // The tabs ROW stays present (a tab surface), unlike a detail overlay
    // which parks it (`workspace-tabs-parked`).
    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();
    // No slide-over / scrim chrome of any kind.
    expect(document.querySelector(".app-scrim")).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-overlay"]')).toBeNull();
  });
});

// ── AC (roadmap-empty AC) — the Model-B imperative empty state ──────────────

describe("§S3 — Roadmap empty state carries the register imperative", () => {
  test("with no queue registered the Roadmap pane renders `roadmap-empty` containing exactly `POST /projects/<key>/queue`", async () => {
    const key = "roadmap-empty-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Empty Roadmap Project" })],
      queue: [],
    });

    const empty = document.querySelector<HTMLElement>('[data-testid="roadmap-empty"]');
    expect(empty).not.toBeNull();
    // The imperative names the tool the way §S3 pins it — a LITERAL `<key>`
    // placeholder, the same copy an orchestrator sees in the tool.
    expect(empty!.textContent ?? "").toContain("POST /projects/<key>/queue");
    // bound: no data rows when the queue is empty.
    expect(roadmapRows().length).toBe(0);
  });
});

// ── AC13/AC15 (rows carry the authored order) — one row per CR, as authored ──
//
// CORRECTED by CR-CRU-078 §S6, and the correction is the point of the cycle.
// This suite previously asserted rows in DEPENDS-ON (topological) order, on a
// fixture "deliberately POSTed out of order so a plain seq-order render would
// fail" — it encoded `roadmapTopoOrder`'s re-sequencing as the contract. §S6
// retires that: topology VALIDATES, it does not re-sequence. The fixture is
// kept EXACTLY as it was, because an authored order that disagrees with a
// dependency walk is now the interesting case rather than the broken one; only
// the expected order flips to the authored one, and the inverted row's AC15
// warning is asserted where the reshuffle used to be.

describe("CR-CRU-078 §S6/AC13 — Roadmap table renders CR rows in the AUTHORED order", () => {
  test("rows appear in the order the queue publishes (never re-derived from depends-on), one per CR, each carrying CR · title · wave · depends-on chips · status badge matching GET /queue", async () => {
    const key = "roadmap-topo-1";
    // The authored order places CR-RM-003 before CR-RM-002, which it depends
    // on: an authoring error, and therefore an AC15 warning — never a licence
    // to reshuffle. `seq` is stamped to match, since `listQueue` is
    // `ORDER BY seq` and the two channels cannot disagree on the wire.
    const queue: QueueEntryFixture[] = [
      { cr: "CR-RM-003", title: "Third", wave: "5", dependsOn: ["CR-RM-002"], status: "PENDING", seq: 10 },
      { cr: "CR-RM-001", title: "First", wave: "5", dependsOn: [], status: "COMPLETED", planId: 71, seq: 20 },
      { cr: "CR-RM-002", title: "Second", wave: "5", dependsOn: ["CR-RM-001"], status: "IN_PROGRESS", planId: 72, seq: 30 },
    ];
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Topo Project" })],
      queue,
      plans: [
        { planId: 71, cr: "CR-RM-001", projectKey: key, status: "closed", cycles: [{ id: 1, label: "C1", status: "done" }] },
        { planId: 72, cr: "CR-RM-002", projectKey: key, status: "open", cycles: [{ id: 2, label: "C1", status: "active" }] },
      ],
    });

    // Non-vacuity: the authored order really does disagree with a dependency
    // walk, so this assertion can only pass on a renderer that carries the
    // authored order rather than deriving one.
    expect(dependencyWalk(queue)).not.toEqual(queue.map((e) => e.cr));
    expect(rowOrder()).toEqual(["CR-RM-003", "CR-RM-001", "CR-RM-002"]);

    // AC15 — the inversion is FLAGGED on its own row, and only there.
    expect(warnedRows()).toEqual(["CR-RM-003"]);

    // Row content — CR id, title, wave, and the derived status badge.
    const second = roadmapRow("CR-RM-002")!;
    expect(second.textContent ?? "").toContain("CR-RM-002");
    expect(second.textContent ?? "").toContain("Second");
    expect(second.textContent ?? "").toContain("5");
    const badge = second.querySelector<HTMLElement>('[data-testid="roadmap-status-badge"]');
    expect(badge).not.toBeNull();
    expect((badge!.textContent ?? "").trim()).toBe("IN_PROGRESS");

    // depends-on rendered as chips (not free text), naming the upstream CR.
    const chips = Array.from(
      second.querySelectorAll<HTMLElement>('[data-testid="roadmap-depends-chip"]'),
    ).map((c) => (c.textContent ?? "").trim());
    expect(chips).toEqual(["CR-RM-001"]);

    // Each derived status badge matches GET /queue exactly.
    expect(
      (roadmapRow("CR-RM-001")!.querySelector('[data-testid="roadmap-status-badge"]')!.textContent ?? "").trim(),
    ).toBe("COMPLETED");
    expect(
      (roadmapRow("CR-RM-003")!.querySelector('[data-testid="roadmap-status-badge"]')!.textContent ?? "").trim(),
    ).toBe("PENDING");
  });
});

// ── AC (topological-rows AC, dividers) — wave + release boundary rows ───────

describe("§S3 — Roadmap table carries wave and release boundary dividers", () => {
  test("a wave-boundary divider heads the change into a new wave, and a release-boundary divider (from GET /releases, never wave numbers) carries the release version", async () => {
    const key = "roadmap-dividers-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Dividers Project" })],
      queue: [
        { cr: "CR-RM-010", title: "Wave five A", wave: "5", dependsOn: [], status: "COMPLETED", planId: 81 },
        { cr: "CR-RM-011", title: "Wave six A", wave: "6", dependsOn: ["CR-RM-010"], status: "PENDING" },
      ],
      releases: [{ version: "0.1.0", commit: "abc1234", timestamp: Date.now() }],
      plans: [
        { planId: 81, cr: "CR-RM-010", projectKey: key, status: "closed", cycles: [{ id: 1, label: "C1", status: "done" }] },
      ],
    });

    // A wave-boundary divider marks the transition into wave 6.
    const waveDividers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="roadmap-wave-divider"]'),
    );
    expect(waveDividers.length).toBeGreaterThan(0);
    expect(waveDividers.some((d) => (d.textContent ?? "").includes("6"))).toBe(true);

    // A release-boundary divider carries the release version from listReleases.
    const releaseDividers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="roadmap-release-divider"]'),
    );
    expect(releaseDividers.length).toBeGreaterThan(0);
    expect(releaseDividers.some((d) => (d.textContent ?? "").includes("0.1.0"))).toBe(true);

    // Execution sequence: the wave-5 CR row precedes the wave-6 CR row.
    const order = roadmapRows().map((r) => r.getAttribute("data-cr"));
    expect(order.indexOf("CR-RM-010")).toBeLessThan(order.indexOf("CR-RM-011"));
  });
});

// ── AC (topological-rows AC, row interactions) — highlight + tab swap ───────

describe("§S3 — Roadmap row interactions swap tabs by status", () => {
  test("the open-plan (IN_PROGRESS) row carries the active highlight and clicking it swaps to the Workflow tab (one-rule, no overlay)", async () => {
    const key = "roadmap-open-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Open Plan Project" })],
      queue: [
        { cr: "CR-RM-020", title: "Running now", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 91 },
      ],
      plans: [
        { planId: 91, cr: "CR-RM-020", projectKey: key, status: "open", track: "track-1", cycles: [{ id: 1, label: "C1", status: "active" }] },
      ],
    });

    const row = roadmapRow("CR-RM-020");
    expect(row).toBeDefined();
    // The open-plan row is the one carrying the active highlight.
    expect(row!.getAttribute("data-active")).toBe("true");

    row!.click();
    await settle();

    // A one-rule tab swap — Workflow becomes active, no overlay opens.
    expect(tabIsOn("Workflow")).toBe(true);
    expect(document.querySelector('[data-testid="workspace-tabs-parked"]')).toBeNull();
  });

  test("a PENDING row is inert beyond its badge (clicking it does NOT change tab); a COMPLETED row swaps to the Workflow tab", async () => {
    const key = "roadmap-status-clicks-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Status Clicks Project" })],
      queue: [
        { cr: "CR-RM-030", title: "Pending one", wave: "5", dependsOn: [], status: "PENDING" },
        { cr: "CR-RM-031", title: "Done one", wave: "5", dependsOn: [], status: "COMPLETED", planId: 95 },
      ],
      plans: [
        { planId: 95, cr: "CR-RM-031", projectKey: key, status: "closed", cycles: [{ id: 1, label: "C1", status: "done" }] },
      ],
    });

    // PENDING: inert — the Roadmap tab stays active, Workflow does not.
    const pending = roadmapRow("CR-RM-030")!;
    expect(pending.getAttribute("data-active")).not.toBe("true");
    pending.click();
    await settle();
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    // COMPLETED: lands on the Workflow tab (its expanded history group).
    roadmapRow("CR-RM-031")!.click();
    await settle();
    expect(tabIsOn("Workflow")).toBe(true);
  });
});

// ── AC (live-overlay AC) — lane badge + cycle position vs plain highlight ───

describe("§S3 — Roadmap live execution overlay (multi-track vs single-track)", () => {
  test("with two open plans on track-1/track-2, each in-progress row shows its lane badge + live cycle position (track-N ▶ cycle a/b)", async () => {
    const key = "roadmap-multitrack-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Multi Track Project" })],
      queue: [
        { cr: "CR-RM-040", title: "Lane one", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 201 },
        { cr: "CR-RM-041", title: "Lane two", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 202 },
      ],
      plans: [
        {
          planId: 201,
          cr: "CR-RM-040",
          projectKey: key,
          status: "open",
          track: "track-1",
          cycles: [
            { id: 1, label: "C1", status: "active" },
            { id: 2, label: "C2", status: "pending" },
          ],
        },
        {
          planId: 202,
          cr: "CR-RM-041",
          projectKey: key,
          status: "open",
          track: "track-2",
          cycles: [
            { id: 3, label: "C1", status: "done" },
            { id: 4, label: "C2", status: "active" },
            { id: 5, label: "C3", status: "pending" },
          ],
        },
      ],
    });

    const laneOne = roadmapRow("CR-RM-040")!.querySelector<HTMLElement>(
      '[data-testid="roadmap-lane-badge"]',
    );
    expect(laneOne).not.toBeNull();
    const laneOneText = (laneOne!.textContent ?? "").trim();
    expect(laneOneText).toContain("track-1");
    expect(laneOneText).toContain("▶");
    expect(laneOneText).toContain("cycle 1/2");

    const laneTwo = roadmapRow("CR-RM-041")!.querySelector<HTMLElement>(
      '[data-testid="roadmap-lane-badge"]',
    );
    expect(laneTwo).not.toBeNull();
    const laneTwoText = (laneTwo!.textContent ?? "").trim();
    expect(laneTwoText).toContain("track-2");
    expect(laneTwoText).toContain("cycle 2/3");
  });

  test("a single-track project's active row shows the plain highlight with NO lane badge", async () => {
    const key = "roadmap-singletrack-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Single Track Project" })],
      queue: [
        { cr: "CR-RM-050", title: "Only lane", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 301 },
      ],
      plans: [
        {
          planId: 301,
          cr: "CR-RM-050",
          projectKey: key,
          status: "open",
          track: "track-1",
          cycles: [{ id: 1, label: "C1", status: "active" }],
        },
      ],
    });

    const row = roadmapRow("CR-RM-050")!;
    // Plain active highlight, but no lane noise for a single-track project.
    expect(row.getAttribute("data-active")).toBe("true");
    expect(row.querySelector('[data-testid="roadmap-lane-badge"]')).toBeNull();
  });
});

// ── CR-CRU-083 §S2 + AC3/AC7 — the fourth derived status, COMPLETED_UNTRACKED ─
// A CR that shipped in a release but carries NO plan record: completed, with
// its execution history absent. §S2 names both the wire value and the badge
// copy, so both are contract surface asserted verbatim here.

describe("CR-CRU-083 §S2 — COMPLETED_UNTRACKED is a distinct roadmap consumer state", () => {
  test("AC3 — the untracked row's badge reads `completed · tracking absent` on its own status class, and a COMPLETED sibling still reads COMPLETED", async () => {
    const key = "roadmap-untracked-badge-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Untracked Completion Project" })],
      queue: [
        // Shipped inside a release, no plan record → no planId on the wire.
        { cr: "CR-RM-060", title: "Shipped untracked", wave: "5", dependsOn: [], status: "COMPLETED_UNTRACKED" },
        { cr: "CR-RM-061", title: "Shipped tracked", wave: "5", dependsOn: [], status: "COMPLETED", planId: 96 },
      ],
      plans: [
        { planId: 96, cr: "CR-RM-061", projectKey: key, status: "closed", cycles: [{ id: 1, label: "C1", status: "done" }] },
      ],
    });

    const untracked = roadmapRow("CR-RM-060");
    expect(untracked).toBeDefined();
    const badge = untracked!.querySelector<HTMLElement>('[data-testid="roadmap-status-badge"]');
    expect(badge).not.toBeNull();
    // §S2 verbatim copy: middle dot U+00B7, single spaces.
    expect((badge!.textContent ?? "").trim()).toBe("completed · tracking absent");
    expect(Array.from(badge!.classList)).toContain("completed_untracked");

    // AC3 — the two completion states never collapse into one badge.
    const tracked = roadmapRow("CR-RM-061")!.querySelector<HTMLElement>(
      '[data-testid="roadmap-status-badge"]',
    )!;
    expect((tracked.textContent ?? "").trim()).toBe("COMPLETED");
    expect(Array.from(tracked.classList)).toContain("completed");
    expect(Array.from(tracked.classList)).not.toContain("completed_untracked");
  });

  test("AC7 — clicking an untracked row is inert (there is no plan to land on); a COMPLETED row in the same table still swaps to Workflow", async () => {
    const key = "roadmap-untracked-clicks-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Untracked Clicks Project" })],
      queue: [
        { cr: "CR-RM-070", title: "Shipped untracked", wave: "5", dependsOn: [], status: "COMPLETED_UNTRACKED" },
        { cr: "CR-RM-071", title: "Shipped tracked", wave: "5", dependsOn: [], status: "COMPLETED", planId: 97 },
      ],
      plans: [
        { planId: 97, cr: "CR-RM-071", projectKey: key, status: "closed", cycles: [{ id: 1, label: "C1", status: "done" }] },
      ],
    });

    // Inert exactly like PENDING: no highlight, no tab change.
    const untracked = roadmapRow("CR-RM-070")!;
    expect(untracked.getAttribute("data-active")).not.toBe("true");
    untracked.click();
    await settle();
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    // The tracked sibling DOES land on Workflow — inertness is a distinction,
    // not a dead surface.
    roadmapRow("CR-RM-071")!.click();
    await settle();
    expect(tabIsOn("Workflow")).toBe(true);
  });
});

// ── CR-CRU-078 §S6 — the live repeated-wave shape, reproduced ───────────────
//
// THE DEFECT, exactly as the live board showed it: `roadmapTopoOrder` walks
// `dependsOn` depth-first and pulls a CR whose dependency is authored LATER
// forward, so the wave-contiguous authored order is shredded and the wave
// dividers repeat — `Wave 1,2,3,4,3,4,5,6,5,6,5`.
//
// This fixture reproduces that string byte-for-byte. The authored order is
// wave-contiguous (1,1,3,3,4,4,5,5,5,6,6 by wave), and THREE rows are authored
// before a dependency of their own: CR-RM-105 (dep CR-RM-104), CR-RM-109 (dep
// CR-RM-108) and CR-RM-111 (dep CR-RM-110). A depth-first walk therefore pulls
// 104, 108 and 110 forward, producing the interleaving above; carrying the
// authored order produces each wave exactly once.
const INTERLEAVED_QUEUE: QueueEntryFixture[] = [
  { cr: "CR-RM-101", title: "One", wave: "1", dependsOn: [], status: "COMPLETED", seq: 10 },
  { cr: "CR-RM-102", title: "Two", wave: "2", dependsOn: ["CR-RM-101"], status: "COMPLETED", seq: 20 },
  { cr: "CR-RM-103", title: "Three", wave: "3", dependsOn: ["CR-RM-102"], status: "COMPLETED", seq: 30 },
  { cr: "CR-RM-105", title: "Five", wave: "3", dependsOn: ["CR-RM-104"], status: "PENDING", seq: 40 },
  { cr: "CR-RM-104", title: "Four", wave: "4", dependsOn: ["CR-RM-103"], status: "COMPLETED", seq: 50 },
  { cr: "CR-RM-106", title: "Six", wave: "4", dependsOn: ["CR-RM-104"], status: "PENDING", seq: 60 },
  { cr: "CR-RM-107", title: "Seven", wave: "5", dependsOn: ["CR-RM-106"], status: "PENDING", seq: 70 },
  { cr: "CR-RM-109", title: "Nine", wave: "5", dependsOn: ["CR-RM-108"], status: "PENDING", seq: 80 },
  { cr: "CR-RM-111", title: "Eleven", wave: "5", dependsOn: ["CR-RM-110"], status: "PENDING", seq: 90 },
  { cr: "CR-RM-108", title: "Eight", wave: "6", dependsOn: ["CR-RM-107"], status: "PENDING", seq: 100 },
  { cr: "CR-RM-110", title: "Ten", wave: "6", dependsOn: ["CR-RM-109"], status: "PENDING", seq: 110 },
];

/** The wave dividers a divider-per-wave-CHANGE render emits over the walk. */
const REPEATED_WAVES = [1, 2, 3, 4, 3, 4, 5, 6, 5, 6, 5].map((w) => `Wave ${w}`);

describe("CR-CRU-078 §S6/AC16 — no wave is rendered twice inside one region", () => {
  test("the live repeated sequence (Wave 1,2,3,4,3,4,5,6,5,6,5) is gone: each wave heads its rows exactly once, in authored first-appearance order", async () => {
    const key = "roadmap-waves-1";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Interleaved Waves Project" })],
      queue: INTERLEAVED_QUEUE,
    });

    // Non-vacuity: a dependency walk really does interleave this fixture's
    // waves into the live sequence, so the assertion below is a claim about a
    // shape that reproduces the defect rather than about a tidy queue.
    const walkWaves = dependencyWalk(INTERLEAVED_QUEUE).map(
      (cr) => `Wave ${INTERLEAVED_QUEUE.find((e) => e.cr === cr)!.wave}`,
    );
    expect(walkWaves).toEqual(REPEATED_WAVES);

    const dividers = waveDividerText();
    expect(dividers).toEqual(["Wave 1", "Wave 2", "Wave 3", "Wave 4", "Wave 5", "Wave 6"]);
    // Stated as its own claim, so a future render that adds chrome still owes
    // uniqueness: no wave label appears twice.
    expect(new Set(dividers).size).toBe(dividers.length);
  });

  test("AC13 — and the rows themselves keep the authored order, dependency inversions and all", async () => {
    const key = "roadmap-waves-2";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Interleaved Waves Project" })],
      queue: INTERLEAVED_QUEUE,
    });

    const authored = INTERLEAVED_QUEUE.map((e) => e.cr);
    expect(dependencyWalk(INTERLEAVED_QUEUE)).not.toEqual(authored);
    expect(rowOrder()).toEqual(authored);
  });

  test("AC15 — every inverted row is warned, and no other row is; the warning names the dependency", async () => {
    const key = "roadmap-waves-3";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "Interleaved Waves Project" })],
      queue: INTERLEAVED_QUEUE,
    });

    expect(warnedRows()).toEqual(["CR-RM-105", "CR-RM-109", "CR-RM-111"]);
    // The warning is actionable: it says WHICH dependency is authored later.
    const warning = roadmapRow("CR-RM-105")!.querySelector<HTMLElement>(
      '[data-testid="roadmap-order-warning"]',
    )!;
    expect(warning.getAttribute("title") ?? "").toContain("CR-RM-104");
  });

  test("AC16 — a single wave carries no information, so it renders no wave chrome at all", async () => {
    const key = "roadmap-waves-4";
    await mountApp({
      pathname: `/p/${key}/roadmap`,
      projects: [project({ key, name: "One Wave Project" })],
      queue: [
        { cr: "CR-RM-121", title: "A", wave: "7", dependsOn: [], status: "COMPLETED", seq: 10 },
        { cr: "CR-RM-122", title: "B", wave: "7", dependsOn: ["CR-RM-121"], status: "PENDING", seq: 20 },
        { cr: "CR-RM-123", title: "C", wave: "7", dependsOn: ["CR-RM-122"], status: "PENDING", seq: 30 },
      ],
    });

    // The rows are there — the absence below is chrome, not an empty table.
    expect(roadmapRows().length).toBe(3);
    expect(waveDividerText()).toEqual([]);
    // A clean authoring warns nowhere: the AC15 assertions above are not a
    // warning the table paints on every row.
    expect(warnedRows()).toEqual([]);
  });
});

// ── CR-CRU-078 §S6/AC14 — the authored order is EDITABLE ───────────────────
//
// Re-registering the queue with two CRs swapped is the orchestrator changing
// its mind, and the render owes it obedience. The pair shares a wave and a
// dependency, so nothing but the authoring can order them — and `seq` is
// re-stamped rather than the array merely permuted, because `listQueue` is
// `ORDER BY seq` and a permutation without a re-stamp is not a re-authored
// queue at all (CR-CRU-091/AC18).

describe("CR-CRU-078 §S6/AC14 — swapping two CRs in the queue swaps their rows", () => {
  const ROOT: QueueEntryFixture = {
    cr: "CR-RM-130",
    title: "Shared prerequisite",
    wave: "2",
    dependsOn: [],
    status: "COMPLETED",
    seq: 10,
  };
  const pair = (first: string, second: string): QueueEntryFixture[] => [
    ROOT,
    { cr: first, title: first, wave: "3", dependsOn: [ROOT.cr], status: "PENDING", seq: 20 },
    { cr: second, title: second, wave: "3", dependsOn: [ROOT.cr], status: "PENDING", seq: 30 },
  ];

  test("as authored the rows read 131 then 132; re-authored the other way round they read 132 then 131, with nothing else changed", async () => {
    await mountApp({
      pathname: "/p/roadmap-editable-1/roadmap",
      projects: [project({ key: "roadmap-editable-1", name: "Editable Order Project" })],
      queue: pair("CR-RM-131", "CR-RM-132"),
    });
    expect(rowOrder()).toEqual([ROOT.cr, "CR-RM-131", "CR-RM-132"]);
    // Neither ordering is an authoring error, so neither is warned.
    expect(warnedRows()).toEqual([]);

    await mountApp({
      pathname: "/p/roadmap-editable-2/roadmap",
      projects: [project({ key: "roadmap-editable-2", name: "Editable Order Project" })],
      queue: pair("CR-RM-132", "CR-RM-131"),
    });
    expect(rowOrder()).toEqual([ROOT.cr, "CR-RM-132", "CR-RM-131"]);
    expect(warnedRows()).toEqual([]);
  });
});
