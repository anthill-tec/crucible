// CR-CRU-023 §S1 — Global pane scroll floor (user live review 2026-07-17:
// "when the screen size goes too small introduce a horizontal scroll in the
// Active workflow window. This can be a global behaviour for all panes,
// minimum expected size on standard computer screens is 1024x640.").
//
// Spec (verbatim, §S1): "Every central content pane (workspace tab panes —
// Workflow/Runs/Coverage/Compile/BDD —, the home timeline pane, and the
// in-pane run detail) gains a MINIMUM CONTENT WIDTH floor with
// `overflow-x: auto` on the pane container: when the viewport is narrower
// than the supported minimum, the pane scrolls horizontally instead of
// crushing its content. One shared mechanism (a pane container class), not
// per-pane one-offs. Panes never wrap/distort content to fit below the
// floor; the page body never scrolls horizontally at ≥1024px (the pane
// scrolls inside itself below its floor)."
//
// AC (verbatim, first bullet — unit scope): "A shared pane-container class
// carries `overflow-x: auto` and a `min-width` floor (styles.css source
// assertion names the class; every central pane — `workflow`, `runs`,
// `coverage`, `compile`, `bdd` panes, home timeline, run detail — renders
// inside it, asserted via DOM class presence per pane)."
//
// The remaining two §S1 ACs ("E2E (Playwright, viewport 800×640): the
// Workflow pane with a long-label active plan renders a horizontal
// scrollbar on the PANE ... and `document.body.scrollWidth <=
// window.innerWidth`" and "E2E (viewport 1024×640): standard fixture
// content renders with NO horizontal scroll on any pane") are Playwright
// viewport-geometry assertions — happy-dom performs no real layout/paint, so
// `scrollWidth`/`clientWidth` are meaningless here. The e2e harness DOES
// have viewport control (`page.setViewportSize`, native Playwright, no
// existing precedent in tests/e2e/ but nothing blocks adding it), so this
// is NOT deferred for lack of harness support — it is deferred for a
// concrete DOM gap found while scoping the extension: `[data-testid=
// "workspace-body"]` (public/app.js:1727) is the only testid wrapping ANY
// active workspace-tab pane, and it wraps the WHOLE tab-or-detail region,
// not the individual scrolling boundary — Workflow/Coverage/Compile/BDD
// have no testid on their own `.app-center`/`.app-pane-content` pair (only
// Runs and the in-pane run detail share `[data-testid="workspace-runs"]`;
// home has `[data-testid="timeline"]`). Which DOM node is "the pane" for a
// `scrollWidth > clientWidth` measurement on Workflow specifically is
// therefore GREEN's call (may need a new pane-level testid) — asserting a
// guess now risks pinning the wrong element and false-failing a valid
// GREEN. Flagged for gap analysis / the orchestrator; deferred to
// tests/e2e/features/pane-scroll-floor.feature (+ tests/e2e/steps/
// viewport.steps.ts, not yet created) once the target element is settled:
//   - "the Workflow pane with a long-label active plan scrolls horizontally
//     at 800×640 without crushing the cycle-timer badge or the page body"
//   - "at the supported 1024×640 floor, no central pane scrolls
//     horizontally"
//
// RED phase: `.app-pane-content` (the existing shared class — already host
// to all SIX named panes except the in-pane run detail, per public/app.js:
// 764/873/1099/1141/1165/1661) currently declares ONLY
// `.app-center > .app-pane-content { min-height: calc(100% + 260px); }`
// (public/styles.css:236) — no `overflow-x: auto`, no `min-width` anywhere.
// The in-pane run detail (WorkspaceRunDetail, public/app.js:1679 — its
// `[data-testid="workspace-runs"]` wrapper around RunDetailBody) does not
// carry `.app-pane-content` at all. Both gaps are pinned RED below; the
// other five panes' DOM-presence assertions already hold today (regression
// pins, not RED) since the class is already wired there — GREEN's job is
// the CSS floor + wiring the run-detail pane.
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
// §S1 styles.css source assertion — same `ruleBody` technique established by
// tests/f13-fidelity.test.ts's §S6 #7 GLYPH-ONLY-coloring block and reused
// by tests/cycle-timers.test.ts (independent of happy-dom's lack of real
// layout/paint).
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

/**
 * Collects EVERY CSS rule body whose selector list contains `.<cls>` as a
 * standalone class token (e.g. matches both a bare `.app-pane-content {`
 * rule AND a compound `.app-center > .app-pane-content {` rule), returning
 * the concatenation of all matched rule bodies. Unlike the single-match
 * `ruleBody(selector)` helper used elsewhere (exact literal selector text),
 * this does not assume GREEN lands the floor on a specific selector
 * shape — only that the declarations exist SOMEWHERE the shared class is
 * targeted, matching the AC's "styles.css source assertion names the
 * class" wording (the class, not one specific selector string).
 */
function allRuleBodiesForClass(cls: string): string {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A rule's selector list is everything since the previous "}" (or file
  // start) up to this rule's own "{". Match any selector list that contains
  // `.<cls>` as a class token (preceded by start/whitespace/combinator,
  // followed by non-identifier or end) so `.app-pane-content-foo` doesn't
  // false-match `.app-pane-content`.
  const re = new RegExp(
    `([^{}]*(?:^|[\\s,>+~])\\.${escaped}(?![\\w-])[^{}]*)\\{([^}]*)\\}`,
    "gs",
  );
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(STYLES_SRC)) !== null) {
    bodies.push(m[2] ?? "");
  }
  return bodies.join("\n");
}

/** Same single-match `ruleBody` technique as tests/f13-fidelity.test.ts /
 * tests/cycle-timers.test.ts — used here only for the negative body/root
 * bound, where the selector is a plain, unambiguous tag name. */
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  const bodies: string[] = [];
  while ((m = re.exec(STYLES_SRC)) !== null) {
    bodies.push(m[1] ?? "");
  }
  return bodies.length === 0 ? undefined : bodies.join("\n");
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  title?: string;
  orchestrator?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
}

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycleId?: number };
}

interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: { name: string; status: "pass" | "fail" | "pending"; children: { name: string; status: "pass" | "fail" | "pending"; duration_ms: number }[] }[];
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  // §S1 addendum (CR-CRU-007, public/app-logic.mjs) — the Coverage tab
  // gates on this field being present; BDD gates on type === "frontend".
  latestCoverageEventId?: string;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/f13-fidelity.test.ts (plans fetch)
 * merged with tests/drill-in.test.ts (per-event-id depth=suites fetch). */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`pane-scroll-floor.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      const parsed = new URL(url, "http://localhost");
      const depthParam = parsed.searchParams.get("depth");
      if (depthParam === "suites") {
        const tree = (detail.tree ?? []).map((n) => ({
          name: n.name,
          status: n.status,
          counts: {
            passed: n.children.filter((c) => c.status === "pass").length,
            failed: n.children.filter((c) => c.status === "fail").length,
            pending: n.children.filter((c) => c.status === "pending").length,
          },
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`pane-scroll-floor.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?paneScrollFloor=${cacheBust}`);

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

async function clickWorkspaceTab(name: string): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

// ── AC1a — styles.css source: shared class carries overflow-x:auto + min-width ──

describe("§S1 pane-container class — styles.css source (overflow-x: auto + min-width floor)", () => {
  test("the shared .app-pane-content class declares overflow-x: auto somewhere in its rule set", () => {
    const combined = allRuleBodiesForClass("app-pane-content");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).toMatch(/overflow-x\s*:\s*auto\s*;?/);
  });

  test("the shared .app-pane-content class declares a min-width floor (non-zero px/rem/ch value) somewhere in its rule set", () => {
    const combined = allRuleBodiesForClass("app-pane-content");
    const minWidthMatch = /min-width\s*:\s*([0-9.]+)(px|rem|ch|em)\s*;?/.exec(combined);
    expect(minWidthMatch).not.toBeNull();
    expect(Number(minWidthMatch![1])).toBeGreaterThan(0);
  });
});

// ── AC1a negative bound — the page body never gains a horizontal-overflow style ──

describe("§S1 negative bound — the page body is never the horizontal-overflow surface", () => {
  test("no body{} or html{} rule in styles.css sets overflow-x: auto or overflow-x: scroll (the floor is pane-internal, not page-level)", () => {
    const bodyBody = ruleBody("body") ?? "";
    const htmlBody = ruleBody("html") ?? "";
    expect(bodyBody).not.toMatch(/overflow-x\s*:\s*(auto|scroll)/);
    expect(htmlBody).not.toMatch(/overflow-x\s*:\s*(auto|scroll)/);
  });

  test("public/app.js never sets an inline overflow-x style or class on document.body", () => {
    expect(APP_JS_SRC).not.toMatch(/document\.body\.style\.overflowX/);
    expect(APP_JS_SRC).not.toContain("document.body.className");
  });
});

// ── AC1b — DOM: every central pane renders inside the shared class ──

describe("§S1 pane-container class — DOM class presence per central pane", () => {
  test("the home timeline pane renders inside .app-pane-content", async () => {
    await mountApp({
      pathname: "/",
      projects: [project({ key: "psf-home" })],
      events: [],
      plans: [],
    });
    const timeline = document.querySelector('[data-testid="timeline"]');
    expect(timeline).not.toBeNull();
    expect(timeline!.querySelector(".app-pane-content")).not.toBeNull();
  });

  test("the workspace Workflow pane renders inside .app-pane-content", async () => {
    await mountApp({
      pathname: "/p/psf-ws",
      projects: [project({ key: "psf-ws" })],
      events: [],
      plans: [],
    });
    await clickWorkspaceTab("Workflow");
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect(body!.querySelector(".app-pane-content")).not.toBeNull();
  });

  test("the workspace Runs pane renders inside .app-pane-content", async () => {
    await mountApp({
      pathname: "/p/psf-ws",
      projects: [project({ key: "psf-ws" })],
      events: [],
      plans: [],
    });
    await clickWorkspaceTab("Runs");
    const runs = document.querySelector('[data-testid="workspace-runs"]');
    expect(runs).not.toBeNull();
    expect(runs!.classList.contains("app-pane-content") || runs!.querySelector(".app-pane-content") !== null).toBe(true);
  });

  test("the workspace Coverage pane renders inside .app-pane-content", async () => {
    // Coverage gates on `latestCoverageEventId` (app-logic.mjs workspaceTabs)
    // — without it the tab is disabled and clicking it is a no-op.
    await mountApp({
      pathname: "/p/psf-ws",
      projects: [project({ key: "psf-ws", latestCoverageEventId: "psf-cov-evt" })],
      events: [],
      plans: [],
    });
    await clickWorkspaceTab("Coverage");
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect(body!.querySelector(".app-pane-content")).not.toBeNull();
  });

  test("the workspace Compile pane renders inside .app-pane-content", async () => {
    await mountApp({
      pathname: "/p/psf-ws",
      projects: [project({ key: "psf-ws" })],
      events: [],
      plans: [],
    });
    await clickWorkspaceTab("Compile");
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect(body!.querySelector(".app-pane-content")).not.toBeNull();
  });

  test("the workspace BDD pane renders inside .app-pane-content", async () => {
    // BDD gates on project.type === "frontend" (app-logic.mjs workspaceTabs)
    // — a backend project's BDD tab is disabled and clicking it is a no-op.
    await mountApp({
      pathname: "/p/psf-ws",
      projects: [project({ key: "psf-ws", type: "frontend" })],
      events: [],
      plans: [],
    });
    await clickWorkspaceTab("BDD");
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect(body!.querySelector(".app-pane-content")).not.toBeNull();
  });

  test("the in-pane run detail renders inside .app-pane-content (RED — WorkspaceRunDetail/RunDetailBody carry no app-pane-content today)", async () => {
    const now = Date.now();
    const eventId = "psf-run-detail-evt";
    const projectKey = "psf-detail";
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey })],
      events: [
        {
          id: eventId,
          projectKey,
          agentId: "psf-agent",
          kind: "test",
          tier: "unit",
          timestamp: now,
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          duration_ms: 10,
        },
      ],
      plans: [],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey,
          agentId: "psf-agent",
          kind: "test",
          tier: "unit",
          timestamp: now,
          summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 10 },
          tree: [
            {
              name: "PsfSuite",
              status: "pass",
              children: [
                { name: "leaf1", status: "pass", duration_ms: 3 },
                { name: "leaf2", status: "pass", duration_ms: 4 },
              ],
            },
          ],
        },
      },
    });

    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains("app-detail-col")).toBe(true); // sanity: this IS the in-pane (non-cold-load) form
    expect(overlay!.querySelector(".app-pane-content")).not.toBeNull();
  });
});
