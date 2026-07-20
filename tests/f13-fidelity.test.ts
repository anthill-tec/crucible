// CR-CRU-021 §S6 — F13 EXACT look-and-feel fidelity + RULED (a) (user-ordered
// 2026-07-16: "I like this look. Implement EXACTLY the same in UI"). This file
// pins the eleven numbered format contracts in §S6 verbatim against a plan
// fixture matching the F13 mock, plus the RULED (a) always-inline active span.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/workflow-lens.test.ts / tests/workflow-tab.
// test.ts (workspace pathname, scripted `/api/v2/projects/<key>/plans` fetch).
//
// RED phase: expected to fail against CURRENT production, which:
//   - renders the Active section header as nothing at all (WorkflowActive,
//     public/app.js ~1236 renders only a bare `plan.cr` title div, no
//     "Active workflow — <cr> · <track> · wave <n>" line, no CR-root element,
//     no title support at all — `title` doesn't exist on Plan anywhere).
//   - narrates NOTHING on cycle rows beyond the bare label (no "done — GREEN
//     confirmed", no kind badge, no orchestrator suffix).
//   - the active cycle's linked runs sit behind a click toggle (CR-CRU-020
//     §S2.3), not always inline (RULED (a) reverses this).
//   - LinkedRunRow (public/app.js ~1179) has NO icon at all (no mask-icon
//     wrapper) and renders a fail ratio as "N ✗ of T", not the plain "P/T"
//     form the mock/AC uses for both pass and fail.
//   - the History section renders "History" and "Wave N" as SEPARATE
//     elements (public/app.js ~1380/~1427), not the combined one-line
//     "History — Wave N · lanes: … · state" form; the CR-group's collapsed
//     row shows PILL CHIPS ("3/3", "merged @ e41d2aa" — note the wrong "@"),
//     not the inline dim text form; no per-cycle "▸ N runs" hint exists.
//   - the Workflow feed's `app-rail-title` STILL renders "Workflow — <project>"
//     above the active header (public/app.js ~1439) — §S6 #10 forbids this.
//   - styles.css colors the WHOLE `.app-cycle-line` per status (~700-705),
//     not just the glyph (§S6 #7).
//
// Testid/attribute contract this file introduces for GREEN (none of these
// exist yet):
//   - `[data-testid="workflow-active-header"]` — the Active section's own
//     header line (item 1).
//   - `[data-testid="workflow-cr-root"]` (`data-cr`) — the CR-root grouping
//     element (item 11); `[data-testid="cr-root-id"]` — the heat-highlighted
//     id segment within it.
//   - `[data-testid="cycle-kind-badge"]` — the inline `[verify]`-style kind
//     badge on a non-default-kind cycle row (item 4).
//   - `[data-testid="open-span-annotation"]` — the dim trailing annotation on
//     the active cycle's open span (item 3).
// Reused, unchanged testids: `cycle-row`, `cycle-glyph`, `cycle-toggle`,
// `linked-run-row`, `wave-group`, `wave-header`, `cr-group`, `cr-group-
// toggle`, `lens-cycle-row`, `card-icon`, `icon-glyph` (CR-007 mask-icon,
// public/app.js ~535-548 / tests/phase-role.test.ts, tests/run-cards.test.ts).
//
// SANCTIONED RE-TARGET (CR-CRU-021 §S6 RULED (a), this CR's authority): the
// "§S2.3 active-cycle drill-down parity" describe block in tests/workflow-
// history-refinements.test.ts (asserting the ACTIVE cycle's runs are
// collapsed-by-default behind its own toggle, CR-CRU-020 §S2.3) is retargeted
// in THIS cycle to always-inline — done in the same commit as this file.
// History's own cycle-row toggle (§S2.1/§S2.2) is UNTOUCHED.
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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  // §S6.11 — additive, optional: CR-root title, captured at plan filing.
  title?: string;
  // §S6 #2 — additive, optional: the confirming orchestrator's identity.
  orchestrator?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
}

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycleId?: number };
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`f13-fidelity.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?f13Fidelity=${cacheBust}`);

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

function runEvent(
  overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "agentId" | "timestamp">,
): EventFixture {
  return {
    kind: "test",
    tier: "unit",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    ...overrides,
  };
}

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function active(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
  expect(el).not.toBeNull();
  return el!;
}

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

// ── §S6 main fixture — the F13 mock, EXACT strings (AC ‐ acceptance criteria line 114) ──

describe("§S6 F13 exact fidelity — Active section + History header (F13 mock fixture)", () => {
  test(
    "the Workflow active section renders the EXACT F13-fidelity strings: header, CR-root (heat + title), narrated cycle rows, always-inline mask-icon open span (plain ratio), inline [verify] badge, and the combined History+Wave+lanes+state header line with its dim collapsed row",
    async () => {
      const key = "f13-fidelity-1";
      const now = Date.now();

      const activePlan: PlanFixture = {
        planId: 9001,
        cr: "CR-NAI-042",
        projectKey: "f13-fidelity-1",
        status: "open",
        wave: "1",
        track: "track-1",
        title: "Runtime checkpoint persistence",
        // RE-BASELINED (user, 2026-07-17) — the confirming orchestrator's
        // identity now stamps the CR ROOT line (`— <orchestrator>`),
        // replacing the removed per-row "by <orchestrator>" narration.
        orchestrator: "vidushi",
        cycles: [
          { id: 4201, label: "checkpoint persistence", status: "done" },
          { id: 4202, label: "compile fallback", status: "active" },
          { id: 4203, label: "verify sweep", kind: "verify", status: "pending" },
        ],
      };
      // History — track-1's PRIOR cr, fully merged (the collapsed row target).
      const historyTrack1: PlanFixture = {
        planId: 9002,
        cr: "CR-NAI-041",
        projectKey: "f13-fidelity-1",
        status: "closed",
        wave: "1",
        track: "track-1",
        merge: { commit: "e41d2aa" },
        cycles: [
          { id: 4101, label: "schema groundwork", status: "done" },
          { id: 4102, label: "wire the API", status: "done" },
          { id: 4103, label: "verify sweep", status: "done" },
        ],
      };
      // History — track-2, CLOSED but not every cycle "done" (1 done + 1
      // skipped, both terminal — a plan may legally close this way, §S0):
      // the fixture the header's "track-2 1/2" chip needs. Track-1's NEXT cr
      // (CR-NAI-042, the ACTIVE plan above) stays exclusively in Active
      // (§S1.3) — History's own boundary state reads off its OWN closed
      // material, independent of a same-wave cr still open elsewhere.
      const historyTrack2: PlanFixture = {
        planId: 9003,
        cr: "CR-NAI-040",
        projectKey: "f13-fidelity-1",
        status: "closed",
        wave: "1",
        track: "track-2",
        cycles: [
          { id: 4001, label: "c1", status: "done" },
          { id: 4002, label: "c2", status: "skipped" },
        ],
      };

      const redRun = runEvent({
        id: "evt-f13-red-1",
        projectKey: key,
        agentId: "CR-NAI-042-RED",
        timestamp: now,
        total: 5,
        passed: 2,
        failed: 3,
        context: { cycleId: 4202 },
      });
      const greenRun = runEvent({
        id: "evt-f13-green-1",
        projectKey: key,
        agentId: "CR-NAI-042-GREEN",
        timestamp: now + 10,
        total: 5,
        passed: 5,
        failed: 0,
        context: { cycleId: 4202 },
      });

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "F13 Fidelity Project" })],
        events: [redRun, greenRun],
        plans: [activePlan, historyTrack1, historyTrack2],
      });
      await openWorkflowTab();

      const activeSection = active();

      // ── item 1 — active section header ──────────────────────────────
      const header = activeSection.querySelector('[data-testid="workflow-active-header"]');
      expect(header).not.toBeNull();
      expect(norm(header!.textContent)).toBe("Active workflow — CR-NAI-042 · track-1 · wave 1");

      // ── item 11 — CR ROOT: heat id + title, cycles grouped beneath ────
      const root = activeSection.querySelector<HTMLElement>(
        '[data-testid="workflow-cr-root"][data-cr="CR-NAI-042"]',
      );
      expect(root).not.toBeNull();
      // RE-BASELINED (user, 2026-07-17) — the root now carries the
      // orchestrator identity too: `<cr> · <title> — <orchestrator>`.
      expect(norm(root!.textContent)).toBe(
        "CR-NAI-042 · Runtime checkpoint persistence — vidushi",
      );
      const rootId = root!.querySelector('[data-testid="cr-root-id"]');
      expect(rootId).not.toBeNull();
      expect(norm(rootId!.textContent)).toBe("CR-NAI-042");
      // heat-highlighted — class or inline style references the heat token.
      expect(`${rootId!.className} ${rootId!.getAttribute("style") ?? ""}`).toMatch(/heat/i);

      const cycleRows = Array.from(
        activeSection.querySelectorAll<HTMLElement>('[data-testid="cycle-row"]'),
      );
      expect(cycleRows.length).toBe(3);
      const groupContainer = root!.parentElement!;
      for (const row of cycleRows) {
        expect(groupContainer.contains(row)).toBe(true);
      }

      function rowFor(label: string): HTMLElement {
        const row = cycleRows.find((r) => (r.textContent ?? "").includes(label));
        expect(row).toBeDefined();
        return row!;
      }

      // ── item 2 — RE-BASELINED (user, 2026-07-17): done row is BARE — no
      // status narration at all (the ✓ glyph IS the done signal); the
      // plan's orchestrator identity now stamps the CR ROOT line instead
      // (asserted above), never a per-row "by <orchestrator>".
      const doneRow = rowFor("checkpoint persistence");
      expect(doneRow.getAttribute("data-status")).toBe("done");
      expect(norm(doneRow.textContent)).toContain('cycle 1 · "checkpoint persistence"');
      expect(doneRow.textContent ?? "").not.toContain(" by ");
      expect(doneRow.textContent ?? "").not.toContain("GREEN confirmed");
      expect(doneRow.textContent ?? "").not.toContain("report accepted");
      // CR-CRU-025 §S1: the → Runs affordance is a separate node; the "bare done
      // row" contract means no NARRATION trails, not "no affordance". The badge
      // IS present + separate; the label proper still ends bare once it is removed.
      const doneToRuns = doneRow.querySelector('[data-testid="cycle-to-runs"]');
      expect(doneToRuns).not.toBeNull();
      const doneBare = doneRow.cloneNode(true) as HTMLElement;
      doneBare.querySelector('[data-testid="cycle-to-runs"]')!.remove();
      expect(norm(doneBare.textContent)).toMatch(/cycle 1 · "checkpoint persistence"\s*$/);

      // ── item 2/3 — active row: bold, ember; inline always-visible open span ──
      const activeRow = rowFor("compile fallback");
      expect(activeRow.getAttribute("data-status")).toBe("active");
      const boldEl = Array.from(activeRow.querySelectorAll("b")).find((b) =>
        norm(b.textContent).includes('cycle 2 · "compile fallback" · ACTIVE'),
      );
      expect(boldEl).toBeDefined();

      // RULED (a) — always inline, NO toggle click needed to see them.
      const linkedRows = Array.from(
        activeRow.querySelectorAll<HTMLElement>('[data-testid="linked-run-row"]'),
      );
      expect(linkedRows.length).toBe(2);

      const redRow = linkedRows.find((r) => r.getAttribute("data-run-id") === "evt-f13-red-1");
      const greenRow = linkedRows.find((r) => r.getAttribute("data-run-id") === "evt-f13-green-1");
      expect(redRow).toBeDefined();
      expect(greenRow).toBeDefined();

      // RE-BASELINED (user, 2026-07-17) — CHRONOLOGICAL order, latest LAST:
      // the RED run (timestamp `now`) was ingested BEFORE the GREEN run
      // (`now + 10`), so RED renders FIRST in DOM order.
      expect(linkedRows[0]!.getAttribute("data-run-id")).toBe("evt-f13-red-1");
      expect(linkedRows[1]!.getAttribute("data-run-id")).toBe("evt-f13-green-1");

      // Run-entry icons follow the CR-007 mask-icon system — never the
      // mock's literal 🧪 emoji (CSS `color` cannot tint color-emoji text).
      for (const row of [redRow!, greenRow!]) {
        const cardIcon = row.querySelector('[data-testid="card-icon"]');
        expect(cardIcon).not.toBeNull();
        expect(cardIcon!.getAttribute("data-icon-tintable")).toBe("true");
        const iconGlyph = cardIcon!.querySelector('[data-testid="icon-glyph"]');
        expect(iconGlyph).not.toBeNull();
        expect(iconGlyph!.className).toMatch(/\bapp-icon-mask\b/);
        expect(iconGlyph!.getAttribute("data-kind")).toBe("test");
        expect(row.textContent ?? "").not.toContain("🧪");
      }

      expect(redRow!.textContent ?? "").toContain("CR-NAI-042-RED");
      expect(greenRow!.textContent ?? "").toContain("CR-NAI-042-GREEN");

      // Ratio text is the PLAIN num/total form for BOTH pass and fail
      // (never "N ✗ of T"), colored pass/fail via class only.
      const redRatio = redRow!.querySelector(".app-ratio-fail, .app-ratio-pass");
      expect(redRatio).not.toBeNull();
      expect(norm(redRatio!.textContent)).toBe("2/5");
      expect(redRatio!.className).toMatch(/\bapp-ratio-fail\b/);

      const greenRatio = greenRow!.querySelector(".app-ratio-fail, .app-ratio-pass");
      expect(greenRatio).not.toBeNull();
      expect(norm(greenRatio!.textContent)).toBe("5/5");
      expect(greenRatio!.className).toMatch(/\bapp-ratio-pass\b/);

      // Trailing dim annotation, exactly once.
      const annotation = activeRow.querySelector('[data-testid="open-span-annotation"]');
      expect(annotation).not.toBeNull();
      expect(norm(annotation!.textContent)).toBe("awaiting orchestrator confirm");
      expect(annotation!.className).toMatch(/app-card-meta/);

      // ── item 4 — pending verify cycle: inline [verify] kind badge ─────
      const pendingRow = rowFor("verify sweep");
      expect(pendingRow.getAttribute("data-status")).toBe("pending");
      const kindBadge = pendingRow.querySelector('[data-testid="cycle-kind-badge"]');
      expect(kindBadge).not.toBeNull();
      expect(norm(kindBadge!.textContent)).toBe("verify");
      expect(norm(pendingRow.textContent)).toContain('cycle 3 · "verify sweep"');
      expect(norm(pendingRow.textContent)).toContain("pending");
      // bound: the badge is INLINE within the row line, not a separate block.
      expect(kindBadge!.closest('[data-testid="cycle-row"]')).toBe(pendingRow);

      // ── item 10 — no extra "WORKFLOW — <project>" rail title above it ──
      const workspaceBody = document.querySelector('[data-testid="workspace-body"]')!;
      expect(workspaceBody.querySelector(".app-rail-title") === null).toBe(true);

      // ── item 5 — combined History header: Wave + lanes + state, ONE line ──
      const hist = history();
      const wave1 = hist.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="1"]');
      expect(wave1).not.toBeNull();
      const waveHeader = wave1!.querySelector('[data-testid="wave-header"]');
      expect(waveHeader).not.toBeNull();
      expect(norm(waveHeader!.textContent)).toBe(
        "History — Wave 1 · lanes: track-1 ✓ · track-2 1/2 · awaiting review",
      );

      // ── item 6/8/9 — collapsed history row: inline dim text, "merged <sha>" (no "@") ──
      const crGroup1 = wave1!.querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-NAI-041"]',
      );
      expect(crGroup1).not.toBeNull();
      // Collapsed by default (§S1.2, unchanged) — no cycle rows mounted yet.
      expect(crGroup1!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);
      const collapsedText = norm(crGroup1!.textContent);
      expect(collapsedText).toContain("▸ track-1 › CR-NAI-041 · 3 cycles ✓ · merged e41d2aa");
      expect(collapsedText).not.toContain("merged @");
      expect(collapsedText).not.toContain("@");
    },
  );

  test("a plan with no title renders the id-only CR root (§S6.11 graceful degradation)", async () => {
    const key = "f13-fidelity-notitle";
    const plan: PlanFixture = {
      planId: 9101,
      cr: "CR-NT-1",
      projectKey: "f13-fidelity-notitle",
      status: "open",
      track: "track-1",
      wave: "1",
      cycles: [{ id: 5001, label: "c1", status: "pending" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "No Title Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const root = active().querySelector('[data-testid="workflow-cr-root"][data-cr="CR-NT-1"]');
    expect(root).not.toBeNull();
    expect(norm(root!.textContent)).toBe("CR-NT-1");
  });

  test("the active header omits the track segment when the plan carries no track (solo model, item 1)", async () => {
    const key = "f13-fidelity-solo";
    const plan: PlanFixture = {
      planId: 9102,
      cr: "CR-SOLO-1",
      projectKey: "f13-fidelity-solo",
      status: "open",
      wave: "2",
      cycles: [{ id: 5101, label: "c1", status: "pending" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Solo Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const header = active().querySelector('[data-testid="workflow-active-header"]');
    expect(header).not.toBeNull();
    expect(norm(header!.textContent)).toBe("Active workflow — CR-SOLO-1 · wave 2");
  });

  // ── §S6.11 RE-BASELINE (2026-07-17) — orchestrator/title CR-root combinations ──
  test('a plan with a TITLE but NO orchestrator renders `<cr> · <title>` (no "— …" segment)', async () => {
    const key = "f13-fidelity-title-only";
    const plan: PlanFixture = {
      planId: 9103,
      cr: "CR-TITLE-ONLY-1",
      projectKey: "f13-fidelity-title-only",
      status: "open",
      track: "track-1",
      wave: "1",
      title: "Title Without Orchestrator",
      cycles: [{ id: 5201, label: "c1", status: "pending" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Title Only Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const root = active().querySelector(
      '[data-testid="workflow-cr-root"][data-cr="CR-TITLE-ONLY-1"]',
    );
    expect(root).not.toBeNull();
    expect(norm(root!.textContent)).toBe("CR-TITLE-ONLY-1 · Title Without Orchestrator");
    expect(root!.textContent ?? "").not.toContain("—");
  });

  test('a plan with an ORCHESTRATOR but NO title renders `<cr> — <orchestrator>` (id-only root plus the orchestrator segment, no " · <title>")', async () => {
    const key = "f13-fidelity-orch-only";
    const plan: PlanFixture = {
      planId: 9104,
      cr: "CR-ORCH-ONLY-1",
      projectKey: "f13-fidelity-orch-only",
      status: "open",
      track: "track-1",
      wave: "1",
      orchestrator: "vidushi",
      cycles: [{ id: 5202, label: "c1", status: "pending" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Orchestrator Only Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const root = active().querySelector(
      '[data-testid="workflow-cr-root"][data-cr="CR-ORCH-ONLY-1"]',
    );
    expect(root).not.toBeNull();
    expect(norm(root!.textContent)).toBe("CR-ORCH-ONLY-1 — vidushi");
  });
});

// ── §S6 #2 — RE-BASELINED 2026-07-17: bare done rows carry NO narration ────
// SANCTIONED RE-TARGET (CR-CRU-021 §S6 re-baseline, this cycle's authority):
// the user removed done-row status narration entirely ("done — GREEN
// confirmed" / "done — report accepted" and the per-row "by <orchestrator>"
// suffix) — the ✓ glyph alone is now the done signal. The orchestrator
// identity that used to trail a done row moved to the CR ROOT line instead
// (§S6.11, tests/plans.test.ts + the main fixture test above). These two
// tests previously asserted the REMOVED narration text; they are retargeted
// here to assert its ABSENCE instead, so the orchestrator-carrying and
// verify-kind done-row cases both keep a dedicated regression guard.

describe("§S6 #2 (re-baselined 2026-07-17) — bare done rows carry NO narration", () => {
  test('a done cycle whose PLAN carries an orchestrator identity still reads the BARE `✓ cycle N · "<label>"` form — the removed "done — GREEN confirmed by <orchestrator>" narration never appears on the row (it now stamps the CR root only)', async () => {
    const key = "f13-narration-1";
    const plan: PlanFixture = {
      planId: 9201,
      cr: "CR-NARR-1",
      projectKey: "f13-narration-1",
      status: "open",
      track: "track-1",
      wave: "1",
      orchestrator: "vidushi",
      cycles: [{ id: 6001, label: "checkpoint persistence", status: "done" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Narration Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-status="done"]')!;
    expect(row).not.toBeNull();
    expect(norm(row.textContent)).toContain('cycle 1 · "checkpoint persistence"');
    expect(row.textContent ?? "").not.toContain("GREEN confirmed");
    expect(row.textContent ?? "").not.toContain(" by ");
    // CR-CRU-025 §S1: the → Runs affordance is a separate node; the "bare done
    // row" contract means no NARRATION trails, not "no affordance". The badge
    // IS present + separate; the label proper still ends bare once it is removed.
    const rowToRuns = row.querySelector('[data-testid="cycle-to-runs"]');
    expect(rowToRuns).not.toBeNull();
    const rowBare = row.cloneNode(true) as HTMLElement;
    rowBare.querySelector('[data-testid="cycle-to-runs"]')!.remove();
    expect(norm(rowBare.textContent)).toMatch(/cycle 1 · "checkpoint persistence"\s*$/);

    // The orchestrator identity DOES appear — but on the CR root, not here.
    const root = active().querySelector('[data-testid="workflow-cr-root"][data-cr="CR-NARR-1"]');
    expect(root).not.toBeNull();
    expect(norm(root!.textContent)).toContain("— vidushi");
  });

  test('a done VERIFY-kind cycle also reads bare — `✓ cycle N · "<label>" [verify]` — with NEITHER the removed "done — report accepted" NOR "GREEN confirmed" narration', async () => {
    const key = "f13-narration-2";
    const plan: PlanFixture = {
      planId: 9202,
      cr: "CR-NARR-2",
      projectKey: "f13-narration-2",
      status: "open",
      track: "track-1",
      wave: "1",
      cycles: [{ id: 6002, label: "verify sweep", kind: "verify", status: "done" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Narration Verify Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-status="done"]')!;
    expect(row).not.toBeNull();
    const text = norm(row.textContent);
    expect(text).not.toContain("done — report accepted");
    expect(text).not.toContain("GREEN confirmed");
    // Bare form — label + kind badge, no trailing narration segment.
    expect(text).toContain('cycle 1 · "verify sweep"');
    const kindBadge = row.querySelector('[data-testid="cycle-kind-badge"]');
    expect(kindBadge).not.toBeNull();
    expect(norm(kindBadge!.textContent)).toBe("verify");
  });
});

// ── §S6 #7 — GLYPH-ONLY status coloring (styles.css source) ───────────────

describe("§S6 #7 — GLYPH-ONLY status coloring (styles.css)", () => {
  function ruleBody(selector: string): string | undefined {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES_SRC);
    return match?.[1];
  }

  test("each status's cycle-GLYPH carries its OWN `color` declaration (pass-green done / ember active / faint pending)", () => {
    const doneGlyph = ruleBody(".cycle-status-done .app-cycle-glyph");
    expect(doneGlyph).toBeDefined();
    expect(doneGlyph ?? "").toMatch(/color\s*:\s*var\(--pass\)/);

    const activeGlyph = ruleBody(".cycle-status-active .app-cycle-glyph");
    expect(activeGlyph).toBeDefined();
    expect(activeGlyph ?? "").toMatch(/color\s*:\s*var\(--ember\)/);

    const pendingGlyph = ruleBody(".cycle-status-pending .app-cycle-glyph");
    expect(pendingGlyph).toBeDefined();
    expect(pendingGlyph ?? "").toMatch(/color\s*:\s*var\(--ink-faint\)/);
  });

  test("the ROW TEXT (`.app-cycle-line`) carries NO status color anymore — the live-UI regression this CR fixes (glyph-only, not whole-row)", () => {
    for (const status of ["pending", "active", "done", "skipped", "failed"]) {
      const lineRule = ruleBody(`.cycle-status-${status} .app-cycle-line`);
      if (lineRule !== undefined) {
        expect(lineRule).not.toMatch(/color\s*:/);
      }
    }
  });
});

// ── §S6 #8 — collapsed HISTORY cycle rows carry a run-count hint ──────────

describe("§S6 #8 — collapsed history cycle rows carry a run-count hint (▸ N runs)", () => {
  test("a done history cycle with 2 linked runs, before its OWN toggle is clicked, shows '▸ 2 runs' inline", async () => {
    const key = "f13-runcount-1";
    const now = Date.now();
    const run1 = runEvent({
      id: "evt-rc-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId: 7001 },
    });
    const run2 = runEvent({
      id: "evt-rc-2",
      projectKey: key,
      agentId: "agent-b",
      timestamp: now + 10,
      context: { cycleId: 7001 },
    });
    const plan: PlanFixture = {
      planId: 9301,
      cr: "CR-RC-1",
      projectKey: "f13-runcount-1",
      status: "closed",
      wave: "1",
      merge: { commit: "rc0000a" },
      cycles: [{ id: 7001, label: "wire the API", status: "done" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Run Count Project" })],
      events: [run1, run2],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="CR-RC-1"]');
    expect(crGroup).not.toBeNull();
    const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;
    expect(groupToggle).not.toBeNull();
    groupToggle.click();
    await settle();

    const cycleRow = crGroup!.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(cycleRow).not.toBeNull();
    // the cycle's OWN toggle (for its linked runs) is untouched — collapsed.
    expect(cycleRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
    expect(norm(cycleRow.textContent)).toContain("▸ 2 runs");
  });

  // CR-CRU-023 §S4 #1 — singular run hint: N=1 pins "▸ 1 run", not "▸ 1 runs"
  // (app.js:~1491 region hard-codes the plural "runs" suffix regardless of
  // count — the AC requires the N=1 singular form).
  test("a done history cycle with EXACTLY 1 linked run, before its OWN toggle is clicked, shows '▸ 1 run' (singular, not '▸ 1 runs')", async () => {
    const key = "f13-runcount-singular-1";
    const now = Date.now();
    const run1 = runEvent({
      id: "evt-rc-single-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId: 7101 },
    });
    const plan: PlanFixture = {
      planId: 9302,
      cr: "CR-RC-SINGULAR-1",
      projectKey: "f13-runcount-singular-1",
      status: "closed",
      wave: "1",
      merge: { commit: "rc0000b" },
      cycles: [{ id: 7101, label: "wire the API", status: "done" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Run Count Singular Project" })],
      events: [run1],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="CR-RC-SINGULAR-1"]');
    expect(crGroup).not.toBeNull();
    const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;
    expect(groupToggle).not.toBeNull();
    groupToggle.click();
    await settle();

    const cycleRow = crGroup!.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(cycleRow).not.toBeNull();
    // the cycle's OWN toggle (for its linked runs) is untouched — collapsed.
    expect(cycleRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
    const hintText = norm(cycleRow.textContent);
    expect(hintText).toContain("▸ 1 run");
    // negative pin — the plural suffix must NOT survive at N=1.
    expect(hintText).not.toContain("▸ 1 runs");
  });
});

// ── §S6 #10 — no extra rail-title above the active header (dedicated) ─────

describe("§S6 #10 — no extra rail-title above the active header", () => {
  test("the Workflow pane renders no separate 'Workflow — <project>' rail-title anywhere in its body", async () => {
    const key = "f13-norail-1";
    const plan: PlanFixture = {
      planId: 9401,
      cr: "CR-NORAIL-1",
      projectKey: "f13-norail-1",
      status: "open",
      wave: "1",
      cycles: [{ id: 8001, label: "c1", status: "pending" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "No Rail Title Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const workspaceBody = document.querySelector('[data-testid="workspace-body"]')!;
    expect(workspaceBody.querySelector(".app-rail-title") === null).toBe(true);
    expect(workspaceBody.textContent ?? "").not.toMatch(/^\s*Workflow\s*—/);
  });
});

// ── RULED (a) — active cycle's open span is ALWAYS inline, no toggle ──────

describe("RULED (a) — the ACTIVE cycle's open span is ALWAYS inline; no toggle exists on it", () => {
  test("the active cycle's linked runs render immediately on mount with no click needed, and the row carries NO cycle-toggle element (the toggle narrows to History only)", async () => {
    const key = "f13-ruled-a-1";
    const now = Date.now();
    const run = runEvent({
      id: "evt-ruled-a-1",
      projectKey: key,
      agentId: "agent-x-RED",
      timestamp: now,
      context: { cycleId: 9601 },
    });
    const plan: PlanFixture = {
      planId: 9501,
      cr: "CR-RULED-A",
      projectKey: "f13-ruled-a-1",
      status: "open",
      wave: "1",
      track: "track-1",
      cycles: [{ id: 9601, label: "c1", status: "active" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Ruled A Project" })],
      events: [run],
      plans: [plan],
    });
    await openWorkflowTab();

    const activeRow = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(activeRow).not.toBeNull();
    expect(activeRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(1);
    expect(
      activeRow.querySelector('[data-testid="linked-run-row"]')!.getAttribute("data-run-id"),
    ).toBe("evt-ruled-a-1");
    expect(activeRow.querySelector('[data-testid="cycle-toggle"]')).toBeNull();
  });
});

// ── RED ADDENDUM (cycle 13, gap 1) — open-span runs are ONE INLINE FLOW ────
// §S6 #3 literal text: "renders its linked runs INLINE on one row: `🧪
// <agent> <ratio> · 🧪 <agent> <ratio> · awaiting orchestrator confirm`".
// Chrome side-by-side against F13 found the live UI renders each linked run
// as its OWN block row with a per-run relative-age stamp ("...ago") — the
// mock has NO ages and uses `·` text-node separators on a single flowing
// line. This pins: ONE container (`[data-testid="open-span"]`) whose
// normalized visible text is the EXACT mock string (mask-icon elements
// excluded from text, asserted present separately), no "ago" anywhere, and
// run entries that are inline-level (a `<span>` tag, or a container class
// `app-inline-run`), joined by literal `·` text nodes.
function collectDotTextNodes(root: Node): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text.includes("·")) found.push(text);
    } else {
      node.childNodes.forEach(walk);
    }
  };
  walk(root);
  return found;
}

describe("§S6 #3 RED addendum (cycle 13, gap 1) — open-span runs render as ONE INLINE FLOW, not stacked per-run block rows with ages", () => {
  test("the active cycle's open span is a single container whose normalized text is EXACTLY the mock string, has no relative-age text, carries the mask-icon elements as non-text siblings, and joins its run entries with literal '·' text nodes on inline-level elements", async () => {
    const key = "f13-inline-span-1";
    const now = Date.now();

    const redRun = runEvent({
      id: "evt-inline-red-1",
      projectKey: key,
      agentId: "CR-NAI-042-RED",
      timestamp: now,
      total: 5,
      passed: 2,
      failed: 3,
      context: { cycleId: 4202 },
    });
    const greenRun = runEvent({
      id: "evt-inline-green-1",
      projectKey: key,
      agentId: "CR-NAI-042-GREEN",
      timestamp: now + 10,
      total: 5,
      passed: 5,
      failed: 0,
      context: { cycleId: 4202 },
    });
    const plan: PlanFixture = {
      planId: 9801,
      cr: "CR-NAI-042",
      projectKey: "f13-inline-span-1",
      status: "open",
      wave: "1",
      track: "track-1",
      cycles: [{ id: 4202, label: "compile fallback", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Inline Span Project" })],
      events: [redRun, greenRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const activeRow = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(activeRow).not.toBeNull();

    // ONE container hosting the whole open span (item 3's introduced testid
    // — none of `open-span` exists yet on production).
    const spanContainer = activeRow.querySelector<HTMLElement>('[data-testid="open-span"]');
    expect(spanContainer).not.toBeNull();

    // Normalized visible text equals the mock string EXACTLY — mask-icon
    // glyph elements carry no text of their own (asserted separately below),
    // so they don't leak into this comparison.
    expect(norm(spanContainer!.textContent)).toBe(
      "CR-NAI-042-RED 2/5 · CR-NAI-042-GREEN 5/5 · awaiting orchestrator confirm",
    );

    // NO relative-age text anywhere in the span — the mock has none, the
    // live UI's per-run age stamp is the defect this pins away.
    expect(spanContainer!.textContent ?? "").not.toMatch(/\bago\b/);

    // Mask-icon elements are present — asserted separately from the text.
    const icons = Array.from(
      spanContainer!.querySelectorAll<HTMLElement>('[data-testid="card-icon"]'),
    );
    expect(icons.length).toBe(2);
    for (const icon of icons) {
      expect(icon.getAttribute("data-icon-tintable")).toBe("true");
    }

    // Run entries are inline-level elements: a `<span>` tag, or a container
    // carrying the `app-inline-run` class.
    const runRows = Array.from(
      spanContainer!.querySelectorAll<HTMLElement>('[data-testid="linked-run-row"]'),
    );
    expect(runRows.length).toBe(2);
    for (const row of runRows) {
      const isInlineTag = row.tagName.toLowerCase() === "span";
      const hasInlineClass = /\bapp-inline-run\b/.test(row.className);
      expect(isInlineTag || hasInlineClass).toBe(true);
    }

    // The two runs + the trailing annotation are joined by literal '·' TEXT
    // NODES within the one flowing container — never separate block rows.
    const dotTextNodes = collectDotTextNodes(spanContainer!);
    expect(dotTextNodes.length).toBeGreaterThanOrEqual(2);

    // The trailing annotation stays nested inside the same flowing container.
    const annotation = spanContainer!.querySelector('[data-testid="open-span-annotation"]');
    expect(annotation).not.toBeNull();
    expect(norm(annotation!.textContent)).toBe("awaiting orchestrator confirm");
  });
});

// ── RED ADDENDUM (cycle 18, live-review) — ZERO linked runs renders NO open-span row at all ──
// Orchestrator live-review pin (2026-07-16, same UI domain as the cycle-18
// timer defect): §S6 #3's open-span contract ("renders its linked runs
// INLINE on one row: `🧪 <agent> <ratio> · 🧪 <agent> <ratio> · awaiting
// orchestrator confirm`") is a contract for the case where the active cycle
// HAS linked runs. On inspection, `public/app.js` `OpenSpan(cycleId)`
// (~line 1278) unconditionally pushes the trailing "awaiting orchestrator
// confirm" annotation regardless of how many entries `linkedRunsFor(cycleId)`
// returns, and `CycleRow` (~line 1348) unconditionally calls `OpenSpan` for
// ANY `active` cycle — so with ZERO cycleId-linked runs, today's UI still
// renders a bare `[data-testid="open-span"]` container holding nothing but
// the annotation: an "awaiting orchestrator confirm" floating with nothing
// to confirm. The mock never shows this — the span row exists only WITH
// runs. This pins the negative case.
describe("§S6 #3 RED addendum (cycle 18, live-review) — ZERO linked runs renders NO open-span row at all", () => {
  test("an ACTIVE cycle with NO events anywhere (so none can carry its cycleId) renders NO open-span container, NO open-span-annotation, and NO 'awaiting orchestrator confirm' text anywhere in its row", async () => {
    const key = "f13-no-runs-1";

    const plan: PlanFixture = {
      planId: 9802,
      cr: "CR-NAI-043",
      projectKey: "f13-no-runs-1",
      status: "open",
      wave: "1",
      track: "track-1",
      cycles: [{ id: 4302, label: "compile fallback", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "No Linked Runs Project" })],
      events: [], // zero events anywhere — nothing can link to cycleId 4302
      plans: [plan],
    });
    await openWorkflowTab();

    const activeRow = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(activeRow).not.toBeNull();

    expect(activeRow.querySelector('[data-testid="open-span"]')).toBeNull();
    expect(activeRow.querySelector('[data-testid="open-span-annotation"]')).toBeNull();
    expect(norm(activeRow.textContent)).not.toContain("awaiting orchestrator confirm");
  });

  test("an ACTIVE cycle whose only events link to a DIFFERENT cycle's id (no match for THIS cycle) also renders NO open-span row", async () => {
    const key = "f13-no-runs-2";
    const now = Date.now();

    const otherCycleRun = runEvent({
      id: "evt-other-cycle-1",
      projectKey: key,
      agentId: "CR-NAI-044-RED",
      timestamp: now,
      context: { cycleId: 9999 }, // some OTHER cycle's id, never this one
    });

    const plan: PlanFixture = {
      planId: 9803,
      cr: "CR-NAI-044",
      projectKey: "f13-no-runs-2",
      status: "open",
      wave: "1",
      track: "track-1",
      cycles: [{ id: 4402, label: "compile fallback", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Mismatched Linked Runs Project" })],
      events: [otherCycleRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const activeRow = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(activeRow).not.toBeNull();

    expect(activeRow.querySelector('[data-testid="open-span"]')).toBeNull();
    expect(activeRow.querySelector('[data-testid="open-span-annotation"]')).toBeNull();
    expect(norm(activeRow.textContent)).not.toContain("awaiting orchestrator confirm");
  });
});
