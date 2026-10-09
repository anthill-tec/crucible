// CR-CRU-173 §S1 (page half) + §S2's page-side consumer — "History is told
// by release". Spec: docs/changes/CR-CRU-173-history-is-told-by-release.md.
// Storyboard F22 (.lavish/crucible-v2-design.html, "Workflow in two panes —
// Now, and a History of releases, each holding the waves that led up to
// it") is the approved design this file drives against; where F22's own
// mock and its own "The rules" panel disagree (the mock sketches a folded
// `▸ 🛡 gate passed · 3 runs` summary line; the rules panel and AC2 both say
// "gate runs (one row each …)") this file follows AC2's own words — the
// acceptance criterion, not an illustrative sketch — "A release's gate runs
// are listed one row per no-mistakes run with outcome, stop step, fix
// rounds and duration derived from its snapshots".
//
// Cycle 636 (GREEN, merged) already built the server read this page now
// drives: GET /api/v2/projects/<key>/history (src/v2.ts
// `handleProjectHistory`, tests/history-by-release-read.test.ts). THIS file
// pins the PAGE half only — fetch mocked, never the real server — AC1's
// release tree (order, folding, expansion) and AC2's page half (gate-run
// rows, `→ gate`, the verification line, packages, the not-started line),
// a wave split across releases, and that the History title and Now are
// unaffected.
//
// Current-code facts verified against public/app.js on this branch:
//   - `WorkflowHistory()` (public/app.js, ~6790) renders `lens.waves` (from
//     `workflowLens({plans, events})`) directly as top-level
//     `[data-testid="wave-group"]` children of `[data-testid="workflow-
//     history"]` — it issues NO fetch of any kind and holds no concept of a
//     release row. Every assertion below expecting a
//     `[data-testid="history-release"]` row is therefore genuine RED: no
//     such element exists today, and the page never calls
//     `/api/v2/projects/<key>/history` at all (confirmed by `grep`ping
//     `public/app.js` for the literal path — zero hits).
//
// RED-agent-defined DOM/testid contract (the spec leaves the page's own
// markup open — chosen to read naturally off AC1/AC2 and to reuse the
// EXISTING wave/CR-group rendering `WaveGroup`/`LensCrGroup` already gives
// History today, per the CR's own dimension-4 analysis: "workflowLens's
// wave → CR → cycle grouping (now nested under a release)"):
//   - `[data-testid="history-release"]` (`data-release="<label>"`,
//     `data-open="true"|"false"`) — one per release row, in the EXACT order
//     the `/history` response lists them (the server already answers
//     newest-first — the page re-sorts nothing).
//   - `[data-testid="history-release-toggle"]` — the release's own summary
//     line; clicking it flips `data-open`. DEFAULT-OPEN RULE (RED's own
//     call, the spec names "the open release" but never HOW it is chosen):
//     the release FIRST in the `/history` response (newest) starts open;
//     every other release starts folded — AC1's own words ("the open
//     release … expanded, every other release folded").
//   - `[data-testid="history-release-workflow"]` — the release's own
//     workflow (gate runs, verification, packages/not-started), rendered
//     ONLY while the release is open, and BEFORE its waves in document
//     order ("its release workflow (on top — it came last)", §S1 item 1).
//   - `[data-testid="history-gate-run"]` (`data-event-id`, `data-outcome`)
//     — one row per `HistoryGateRun`, in the wire's own order (newest
//     first, already server-sorted). Carries `[data-testid="history-gate-
//     run-outcome"]`, `[data-testid="history-gate-run-stop-step"]` (absent
//     when the wire carries no `stopStep`), `[data-testid="history-gate-
//     run-fix-rounds"]`, `[data-testid="history-gate-run-duration"]`
//     (`fmtDuration`, the SAME formatter `public/app.js` already uses for
//     agent runtimes) and `[data-testid="history-gate-run-link"]` (the
//     `→ gate` button; `onclick` is the SAME `openDrillin(eventId)` every
//     other run card already uses, so it opens `/run/<eventId>` exactly as
//     pinned by tests/f13-fidelity.test.ts's sibling run-card contracts).
//   - `[data-testid="history-verification-line"]` — a `<button>` when
//     `verificationRuns > 0` (clicking it is the SAME `navigate(workspacePath(""),
//     "?release=<label>")` CR-CRU-164's `VerifiedRunsChip` already drives —
//     reused, not reinvented), a plain `<div>` reading "verified · no runs
//     filed under the release" (F22's own wording) when 0.
//   - `[data-testid="history-workflow-packages"]` wrapping one
//     `[data-testid="history-package"]` per entry, rendered ONLY when the
//     wire's `workflow.packages` key is PRESENT (iff shipped, per the wire
//     contract tests/history-by-release-read.test.ts already pins) — reusing
//     the EXISTING package line format `public/app.js`'s `RoadmapPackage`
//     already renders elsewhere (`${registry} · ${name} ${version}`), the
//     one established convention for a package line on this board.
//   - `[data-testid="history-workflow-not-started"]` — renders INSTEAD of
//     gate-run rows / the verification line / packages, containing F22's
//     own wording, "not started — it runs after the last wave", when the
//     wire's workflow carries zero gate runs, zero verification runs and no
//     packages key at all.
//   - Waves and CR groups: UNCHANGED existing `[data-testid="wave-group"]`/
//     `[data-testid="wave-header"]`/`[data-testid="cr-group"]` (public/
//     app.js's `WaveGroup`/`LensCrGroup`, driven by the SAME
//     `workflowLens({plans, events})` as today), now rendered as children of
//     `[data-testid="history-release"]` instead of `[data-testid="workflow-
//     history"]` directly, and FILTERED to the wire's own
//     `release.waves[].crs` id list (the CR-CRU-173 §S2 mechanism a wave
//     split across two releases relies on).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── wire shapes (mirrors tests/history-by-release-read.test.ts's own) ──────

interface PackageRefWire {
  registry: string;
  name: string;
  version: string;
}
interface HistoryGateRunWire {
  runId?: string;
  outcome: string;
  stopStep?: string;
  fixRounds: number;
  durationMs: number;
  pushedCommit?: string;
  eventId: string;
  retired: boolean;
}
interface HistoryWorkflowWire {
  label: string;
  gateRuns: HistoryGateRunWire[];
  verificationRuns: number;
  packages?: PackageRefWire[];
}
interface HistoryWaveWire {
  wave: string;
  crs: string[];
  // CR-CRU-177 \u00a7S2: optional here (RED's call) so the many EXISTING
  // fixtures above need no churn; absent reads as 0, matching the server's
  // always-present \"0 when none\" contract (tests/history-by-release-read.test.ts).
  pendingCount?: number;
}
interface HistoryReleaseWire {
  labels: string[];
  state: "shipped" | "in progress" | "ship not recorded";
  shippedAt?: number;
  tag?: string;
  commit?: string;
  targetAt?: number;
  crCount: number;
  pendingCount?: number; // CR-CRU-177 \u00a7S2 \u2014 see HistoryWaveWire's note
  waves: HistoryWaveWire[];
  workflows: HistoryWorkflowWire[];
}

// ── page fixtures ────────────────────────────────────────────────────────

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
  wave?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
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
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "gate";
  codec: "no-mistakes";
  timestamp: number;
  gate: { intent: string; outcome: string; steps: Array<{ name: string; status: string }> };
  decisions?: unknown[];
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  plans?: PlanFixture[];
  history: HistoryReleaseWire[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;

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

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventDetailMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isEventsListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      body = { ok: true, releases: opts.history };
    } else if (eventDetailMatch !== null && !isEventsListEndpoint) {
      const id = decodeURIComponent(eventDetailMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`workflow-history-release-tree.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      body = { ok: true, event: detail };
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
      throw new Error(`workflow-history-release-tree.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowHistoryReleaseTree=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => textOf(el) === text);
}

async function openWorkflowTab(): Promise<void> {
  const tab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function releaseRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="history-release"]'));
}
function releaseRow(label: string): HTMLElement {
  const row = releaseRows().find((r) => r.getAttribute("data-release") === label);
  expect(row).toBeDefined();
  return row!;
}
function releaseToggle(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>('[data-testid="history-release-toggle"]');
  expect(el).not.toBeNull();
  return el!;
}
async function clickToggle(row: HTMLElement): Promise<void> {
  releaseToggle(row).click();
  await settle();
}

// Same fmtDuration() public/app.js already uses for agent runtimes
// (AgentRow's `runtime_ms` display) — not reinvented here.
function fmtDuration(ms: number): string {
  const n = Math.max(0, Math.floor(ms));
  if (n < 1000) return `${n}ms`;
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function gateRun(overrides: Partial<HistoryGateRunWire> & { eventId: string; outcome: string }): HistoryGateRunWire {
  return { fixRounds: 0, durationMs: 0, retired: false, ...overrides };
}

function plan(overrides: Partial<PlanFixture> & { planId: number | string; cr: string; projectKey: string }): PlanFixture {
  return {
    status: "closed",
    cycles: [{ id: 1, label: "c1", status: "done" }],
    merge: { commit: "deadbee" },
    ...overrides,
  };
}

// ── AC1 — release tree: order, folding, expansion ───────────────────────

describe("CR-CRU-173 §S1/AC1 — History's release tree: order, folding and expansion", () => {
  function threeReleases(key: string): HistoryReleaseWire[] {
    const rows: HistoryReleaseWire[] = [
      {
        labels: ["0.5.0"],
        state: "in progress",
        crCount: 1,
        waves: [{ wave: "9", crs: ["HIST-RT-900"] }],
        workflows: [{ label: "0.5.0", gateRuns: [], verificationRuns: 0 }],
      },
      {
        labels: ["0.4.0"],
        state: "ship not recorded",
        crCount: 1,
        waves: [{ wave: "8", crs: ["HIST-RT-800"] }],
        workflows: [{ label: "0.4.0", gateRuns: [], verificationRuns: 0 }],
      },
      {
        labels: ["0.2.0"],
        state: "shipped",
        shippedAt: 1_758_000_000,
        tag: "v0.2.0",
        commit: "eb6e33f0",
        crCount: 1,
        waves: [{ wave: "6", crs: ["HIST-RT-600"] }],
        workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 0 }],
      },
    ];
    void key;
    return rows.map((r) => ({ ...r }));
  }

  test("renders exactly one row per release, in the EXACT order the /history response lists them — never re-sorted on the page", async () => {
    const key = "hist-rt-order";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Order" })],
      history: threeReleases(key),
    });
    await openWorkflowTab();

    expect(releaseRows().map((r) => r.getAttribute("data-release"))).toEqual(["0.5.0", "0.4.0", "0.2.0"]);
  });

  test("the newest release (first in the wire order) starts OPEN — its workflow and waves render; every other release starts FOLDED — one line, no workflow, no waves", async () => {
    const key = "hist-rt-fold";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Fold" })],
      history: threeReleases(key),
    });
    await openWorkflowTab();

    const newest = releaseRow("0.5.0");
    expect(newest.getAttribute("data-open")).toBe("true");
    expect(newest.querySelector('[data-testid="history-release-workflow"]')).not.toBeNull();
    expect(newest.querySelector('[data-testid="wave-group"][data-wave="9"]')).not.toBeNull();

    for (const label of ["0.4.0", "0.2.0"]) {
      const row = releaseRow(label);
      expect(row.getAttribute("data-open")).toBe("false");
      expect(row.querySelector('[data-testid="history-release-workflow"]')).toBeNull();
      expect(row.querySelector('[data-testid="wave-group"]')).toBeNull();
    }
  });

  test("clicking a folded release's toggle opens it (workflow + waves appear); clicking it again folds it back (both removed from the DOM, not merely hidden)", async () => {
    const key = "hist-rt-toggle";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Toggle" })],
      history: threeReleases(key),
    });
    await openWorkflowTab();

    let folded = releaseRow("0.4.0");
    await clickToggle(folded);
    folded = releaseRow("0.4.0");
    expect(folded.getAttribute("data-open")).toBe("true");
    expect(folded.querySelector('[data-testid="wave-group"][data-wave="8"]')).not.toBeNull();
    // A release opened by its row folds its waves (F22, user ruling
    // 2026-10-09): open wave 8 before reading its CR group.
    folded.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="8"] [data-testid="wave-header"]')!.click();
    await settle();
    expect(folded.querySelector('[data-testid="cr-group"][data-cr="HIST-RT-800"]')).not.toBeNull();

    await clickToggle(folded);
    folded = releaseRow("0.4.0");
    expect(folded.getAttribute("data-open")).toBe("false");
    expect(folded.querySelector('[data-testid="wave-group"]')).toBeNull();
  });

  test("within an open release, the release workflow renders BEFORE its waves in document order (\"its release workflow — on top, it came last\")", async () => {
    const key = "hist-rt-docorder";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Doc Order" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          tag: "v0.2.0",
          commit: "eb6e33f0",
          crCount: 1,
          waves: [{ wave: "6", crs: ["HIST-RT-DOC-1"] }],
          workflows: [{ label: "0.2.0", gateRuns: [gateRun({ eventId: "evt-rt-docorder", outcome: "passed" })], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const workflow = row.querySelector('[data-testid="history-release-workflow"]');
    const wave = row.querySelector('[data-testid="wave-group"][data-wave="6"]');
    expect(workflow).not.toBeNull();
    expect(wave).not.toBeNull();
    expect(Boolean(workflow!.compareDocumentPosition(wave!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  test("waves within an open release render latest-first, and still open to their CRs exactly as History does today (a CR group's toggle reveals its cycle rows)", async () => {
    const key = "hist-rt-waves";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Waves" })],
      plans: [
        plan({ planId: 1, cr: "HIST-RT-W6", projectKey: key, wave: "6" }),
        plan({ planId: 2, cr: "HIST-RT-W5", projectKey: key, wave: "5" }),
      ],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 2,
          waves: [
            { wave: "6", crs: ["HIST-RT-W6"] },
            { wave: "5", crs: ["HIST-RT-W5"] },
          ],
          workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const waveLabels = Array.from(row.querySelectorAll<HTMLElement>('[data-testid="wave-group"]')).map((w) =>
      w.getAttribute("data-wave"),
    );
    expect(waveLabels).toEqual(["6", "5"]);

    const crGroup = row.querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="HIST-RT-W6"]');
    expect(crGroup).not.toBeNull();
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);
    crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();
    expect(
      row.querySelector('[data-testid="cr-group"][data-cr="HIST-RT-W6"]')!.querySelectorAll('[data-testid="lens-cycle-row"]')
        .length,
    ).toBe(1);
  });
});

// ── AC1 — a release's waves fold as F22 draws them ───────────────────────
// F22's rule: "the open release and its open wave expanded" — inside the
// open release only its latest wave starts expanded; every other wave (in it,
// or in a release opened later) is one line, its header, until opened.

describe("History — a release's waves fold: only the open release's open wave starts expanded", () => {
  function foldFixture(key: string): { plans: PlanFixture[]; history: HistoryReleaseWire[] } {
    return {
      plans: [
        plan({ planId: 1, cr: "HIST-91", projectKey: key, wave: "9" }),
        plan({ planId: 2, cr: "HIST-81", projectKey: key, wave: "8" }),
        plan({ planId: 3, cr: "HIST-71", projectKey: key, wave: "7" }),
        plan({ planId: 4, cr: "HIST-61", projectKey: key, wave: "6" }),
      ],
      history: [
        {
          labels: ["0.5.0"],
          state: "in progress",
          crCount: 3,
          waves: [
            { wave: "9", crs: ["HIST-91"] },
            { wave: "8", crs: ["HIST-81"] },
            { wave: "7", crs: ["HIST-71"] },
          ],
          workflows: [{ label: "0.5.0", gateRuns: [], verificationRuns: 0 }],
        },
        {
          labels: ["0.4.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 1,
          waves: [{ wave: "6", crs: ["HIST-61"] }],
          workflows: [{ label: "0.4.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    };
  }
  function waveOf(row: HTMLElement, wave: string): HTMLElement {
    const el = row.querySelector<HTMLElement>(`[data-testid="wave-group"][data-wave="${wave}"]`);
    expect(el).not.toBeNull();
    return el!;
  }
  function crGroupsOf(wave: HTMLElement): string[] {
    return Array.from(wave.querySelectorAll<HTMLElement>('[data-testid="cr-group"]')).map((g) => g.getAttribute("data-cr") ?? "");
  }

  test("HIST-1: in the open release, the open (latest) wave renders its CR groups and every older wave renders only its header line", async () => {
    const key = "hist-fold-open";
    const { plans, history } = foldFixture(key);
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fold Open" })], plans, history });
    await openWorkflowTab();

    const row = releaseRow("0.5.0");
    expect(row.getAttribute("data-open")).toBe("true");
    const open = waveOf(row, "9");
    expect(open.getAttribute("data-open")).toBe("true");
    expect(crGroupsOf(open)).toEqual(["HIST-91"]);

    for (const [wave, cr] of [["8", "HIST-81"], ["7", "HIST-71"]] as const) {
      const folded = waveOf(row, wave);
      expect(folded.getAttribute("data-open")).toBe("false");
      expect(folded.querySelector('[data-testid="wave-header"]')).not.toBeNull();
      expect(crGroupsOf(folded)).toEqual([]);
      expect(row.querySelector(`[data-testid="cr-group"][data-cr="${cr}"]`)).toBeNull();
    }
  });

  test("HIST-2: clicking a folded wave's header opens it — its CR groups appear; clicking again folds it back to its header line", async () => {
    const key = "hist-fold-click";
    const { plans, history } = foldFixture(key);
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fold Click" })], plans, history });
    await openWorkflowTab();

    waveOf(releaseRow("0.5.0"), "8").querySelector<HTMLElement>('[data-testid="wave-header"]')!.click();
    await settle();
    let wave8 = waveOf(releaseRow("0.5.0"), "8");
    expect(wave8.getAttribute("data-open")).toBe("true");
    expect(crGroupsOf(wave8)).toEqual(["HIST-81"]);
    // Opening one wave leaves the others as they were.
    expect(crGroupsOf(waveOf(releaseRow("0.5.0"), "9"))).toEqual(["HIST-91"]);
    expect(crGroupsOf(waveOf(releaseRow("0.5.0"), "7"))).toEqual([]);

    wave8.querySelector<HTMLElement>('[data-testid="wave-header"]')!.click();
    await settle();
    wave8 = waveOf(releaseRow("0.5.0"), "8");
    expect(wave8.getAttribute("data-open")).toBe("false");
    expect(crGroupsOf(wave8)).toEqual([]);
  });

  test("HIST-3: a release opened by its row shows every one of its waves as one line until that wave is opened", async () => {
    const key = "hist-fold-older";
    const { plans, history } = foldFixture(key);
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fold Older" })], plans, history });
    await openWorkflowTab();

    await clickToggle(releaseRow("0.4.0"));
    let wave6 = waveOf(releaseRow("0.4.0"), "6");
    expect(wave6.getAttribute("data-open")).toBe("false");
    expect(crGroupsOf(wave6)).toEqual([]);

    wave6.querySelector<HTMLElement>('[data-testid="wave-header"]')!.click();
    await settle();
    wave6 = waveOf(releaseRow("0.4.0"), "6");
    expect(wave6.getAttribute("data-open")).toBe("true");
    expect(crGroupsOf(wave6)).toEqual(["HIST-61"]);
  });

  test("HIST-4: an open release's header line carries no wave list (its waves show below it); a folded release's header line names its waves", async () => {
    const key = "hist-fold-header-waves";
    const { plans, history } = foldFixture(key);
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fold Header" })], plans, history });
    await openWorkflowTab();

    // CR-CRU-177 \u00a7S2 re-pin: the CR count segment now reads "completed"
    // (pendingCount 0 here \u2014 the fixture's 3 CRs all have plans \u2014 omits
    // the " \u00b7 N pending" suffix).
    expect(textOf(releaseToggle(releaseRow("0.5.0")))).toBe("▾ 🚀 release 0.5.0 · in progress · 3 CRs completed");
    expect(textOf(releaseToggle(releaseRow("0.4.0")))).toContain(" · wave 6");
  });

  test("HIST-5: folding the open release brings its wave list back to its header line; opening a folded one takes the list away", async () => {
    const key = "hist-fold-header-toggle";
    const { plans, history } = foldFixture(key);
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fold Header Toggle" })], plans, history });
    await openWorkflowTab();

    await clickToggle(releaseRow("0.5.0"));
    expect(textOf(releaseToggle(releaseRow("0.5.0")))).toContain(" · waves 9, 8, 7");

    await clickToggle(releaseRow("0.4.0"));
    expect(releaseRow("0.4.0").getAttribute("data-open")).toBe("true");
    expect(textOf(releaseToggle(releaseRow("0.4.0")))).not.toContain("wave");
  });
});

// ── AC2 (page half) — a release's workflow: gate runs, → gate, verification, packages, not started ──

describe("CR-CRU-173 §S1/AC2 (page half) — a release's workflow", () => {
  test("gate runs render ONE ROW EACH, in the wire's own (newest-first) order, with outcome, stop step, fix rounds and duration", async () => {
    const key = "hist-rt-gateruns";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Gate Runs" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 0,
          waves: [],
          workflows: [
            {
              label: "0.2.0",
              gateRuns: [
                gateRun({ eventId: "evt-rt-seal", outcome: "passed", fixRounds: 1, durationMs: 20 * 60_000, pushedCommit: "4cda68f0" }),
                gateRun({ eventId: "evt-rt-cancel", outcome: "cancelled", stopStep: "review", fixRounds: 0, durationMs: 0 }),
              ],
              verificationRuns: 0,
            },
          ],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const rows = row.querySelectorAll<HTMLElement>('[data-testid="history-gate-run"]');
    expect(rows.length).toBe(2);
    expect(Array.from(rows).map((r) => r.getAttribute("data-event-id"))).toEqual(["evt-rt-seal", "evt-rt-cancel"]);

    const seal = rows[0]!;
    expect(seal.getAttribute("data-outcome")).toBe("passed");
    expect(textOf(seal.querySelector('[data-testid="history-gate-run-outcome"]'))).toContain("passed");
    expect(seal.querySelector('[data-testid="history-gate-run-stop-step"]')).toBeNull();
    expect(textOf(seal.querySelector('[data-testid="history-gate-run-fix-rounds"]'))).toContain("1");
    expect(textOf(seal.querySelector('[data-testid="history-gate-run-duration"]'))).toBe(fmtDuration(20 * 60_000));

    const cancelled = rows[1]!;
    expect(textOf(cancelled.querySelector('[data-testid="history-gate-run-outcome"]'))).toContain("cancelled");
    expect(textOf(cancelled.querySelector('[data-testid="history-gate-run-stop-step"]'))).toContain("review");
    expect(textOf(cancelled.querySelector('[data-testid="history-gate-run-fix-rounds"]'))).toContain("0");
    expect(textOf(cancelled.querySelector('[data-testid="history-gate-run-duration"]'))).toBe(fmtDuration(0));
  });

  test("a gate run's own `→ gate` opens the run drill-in for THAT run's eventId — the same openDrillin() navigation every other run card uses", async () => {
    const key = "hist-rt-draftgate";
    const eventId = "evt-rt-drillin";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Drillin" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.2.0", gateRuns: [gateRun({ eventId, outcome: "passed" })], verificationRuns: 0 }],
        },
      ],
      eventDetails: {
        [eventId]: {
          id: eventId,
          projectKey: key,
          agentId: "fixture-agent",
          kind: "gate",
          codec: "no-mistakes",
          timestamp: Date.now(),
          gate: { intent: "release gate", outcome: "passed", steps: [{ name: "review", status: "passed" }] },
          decisions: [],
        },
      },
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const link = row.querySelector<HTMLElement>(
      `[data-testid="history-gate-run"][data-event-id="${eventId}"] [data-testid="history-gate-run-link"]`,
    );
    expect(link).not.toBeNull();
    expect(textOf(link)).toContain("→ gate");

    link!.click();
    await settle();

    // MOCK verification — navigated to exactly THIS run's eventId, not a
    // sibling's, and the run overlay actually opened for it.
    expect(location.pathname).toBe(`/p/${encodeURIComponent(key)}/run/${encodeURIComponent(eventId)}`);
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
  });

  test("with zero runs filed under the release, the verification line reads F22's own wording and is NOT clickable", async () => {
    const key = "hist-rt-verif-zero";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Verif Zero" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const line = row.querySelector<HTMLElement>('[data-testid="history-verification-line"]');
    expect(line).not.toBeNull();
    expect(textOf(line)).toBe("verified · no runs filed under the release");
    expect(line!.tagName.toLowerCase()).not.toBe("button");
  });

  test("with runs filed under the release, the verification line is clickable and opens the Runs tab filtered to THIS release (?release=<label>, CR-CRU-164's own mechanism)", async () => {
    const key = "hist-rt-verif-some";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Verif Some" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 3 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.0");
    const line = row.querySelector<HTMLElement>('[data-testid="history-verification-line"]');
    expect(line).not.toBeNull();
    expect(textOf(line)).toContain("3");
    expect(textOf(line)).toContain("verified");

    line!.click();
    await settle();

    const url = new URL(location.href);
    expect(url.searchParams.getAll("release")).toEqual(["0.2.0"]);
    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab?.classList.contains("on")).toBe(true);
  });

  test("packages are listed when the wire carries them, and NOT rendered at all when the wire carries none", async () => {
    const key = "hist-rt-packages";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Packages" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          crCount: 0,
          waves: [],
          workflows: [
            {
              label: "0.2.0",
              gateRuns: [],
              verificationRuns: 0,
              packages: [
                { registry: "npm", name: "@fixture/crucible-history", version: "0.2.0" },
                { registry: "pypi", name: "crucible-axi", version: "0.2.0" },
              ],
            },
          ],
        },
        {
          labels: ["0.2.2"],
          state: "ship not recorded",
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.2.2", gateRuns: [], verificationRuns: 2 }],
        },
      ],
    });
    await openWorkflowTab();

    const shipped = releaseRow("0.2.0");
    const packagesBox = shipped.querySelector<HTMLElement>('[data-testid="history-workflow-packages"]');
    expect(packagesBox).not.toBeNull();
    const pkgs = packagesBox!.querySelectorAll<HTMLElement>('[data-testid="history-package"]');
    expect(pkgs.length).toBe(2);
    expect(Array.from(pkgs).map((p) => textOf(p))).toEqual([
      "npm · @fixture/crucible-history 0.2.0",
      "pypi · crucible-axi 0.2.0",
    ]);

    // 0.2.2 is folded by default (second row); open it to read its workflow.
    const unshipped = releaseRow("0.2.2");
    await clickToggle(unshipped);
    const reopened = releaseRow("0.2.2");
    expect(reopened.querySelector('[data-testid="history-workflow-packages"]')).toBeNull();
  });

  test("a release whose workflow has not started says so — F22's own wording — and renders no gate-run rows, no verification line and no packages alongside it", async () => {
    const key = "hist-rt-notstarted";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Not Started" })],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          targetAt: 1_800_000_000,
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.3.0");
    const notStarted = row.querySelector<HTMLElement>('[data-testid="history-workflow-not-started"]');
    expect(notStarted).not.toBeNull();
    expect(textOf(notStarted)).toContain("not started — it runs after the last wave");

    expect(row.querySelector('[data-testid="history-gate-run"]')).toBeNull();
    expect(row.querySelector('[data-testid="history-verification-line"]')).toBeNull();
    expect(row.querySelector('[data-testid="history-workflow-packages"]')).toBeNull();
  });

  test("a workflow with SOME activity (verification runs but zero gate runs) is NOT the not-started state — its verification line renders, no not-started line appears", async () => {
    const key = "hist-rt-partial";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Partial" })],
      history: [
        {
          labels: ["0.2.2"],
          state: "ship not recorded",
          crCount: 0,
          waves: [],
          workflows: [{ label: "0.2.2", gateRuns: [], verificationRuns: 2 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.2.2");
    expect(row.querySelector('[data-testid="history-workflow-not-started"]')).toBeNull();
    expect(row.querySelector('[data-testid="history-gate-run"]')).toBeNull();
    const line = row.querySelector<HTMLElement>('[data-testid="history-verification-line"]');
    expect(line).not.toBeNull();
    expect(textOf(line)).toContain("2");
  });
});

// ── a wave split across two releases ─────────────────────────────────────

describe("CR-CRU-173 §S2 (page consumer) — a wave split across two releases", () => {
  test("the SAME wave number, named by two releases, renders under EACH — each copy holding only that release's own CRs, never the sibling's", async () => {
    const key = "hist-rt-split";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Split" })],
      plans: [
        plan({ planId: 1, cr: "HIST-RT-SPLIT-A1", projectKey: key, wave: "7" }),
        plan({ planId: 2, cr: "HIST-RT-SPLIT-A2", projectKey: key, wave: "7" }),
        plan({ planId: 3, cr: "HIST-RT-SPLIT-B1", projectKey: key, wave: "7" }),
      ],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          crCount: 2,
          waves: [{ wave: "7", crs: ["HIST-RT-SPLIT-A1", "HIST-RT-SPLIT-A2"] }],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
        {
          labels: ["0.2.2"],
          state: "ship not recorded",
          crCount: 1,
          waves: [{ wave: "7", crs: ["HIST-RT-SPLIT-B1"] }],
          workflows: [{ label: "0.2.2", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    // 0.3.0 is newest — open by default.
    const newest = releaseRow("0.3.0");
    const newestWave = newest.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="7"]');
    expect(newestWave).not.toBeNull();
    expect(
      Array.from(newestWave!.querySelectorAll<HTMLElement>('[data-testid="cr-group"]')).map((g) => g.getAttribute("data-cr")).sort(),
    ).toEqual(["HIST-RT-SPLIT-A1", "HIST-RT-SPLIT-A2"]);
    expect(newestWave!.querySelector('[data-testid="cr-group"][data-cr="HIST-RT-SPLIT-B1"]')).toBeNull();

    // 0.2.2 is folded by default — open it to read its OWN copy of wave 7.
    await clickToggle(releaseRow("0.2.2"));
    const older = releaseRow("0.2.2");
    const olderWave = older.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="7"]');
    expect(olderWave).not.toBeNull();
    // A release opened by its row folds its waves (F22, user ruling
    // 2026-10-09): open this copy of wave 7 before reading it.
    olderWave!.querySelector<HTMLElement>('[data-testid="wave-header"]')!.click();
    await settle();
    expect(Array.from(olderWave!.querySelectorAll<HTMLElement>('[data-testid="cr-group"]')).map((g) => g.getAttribute("data-cr"))).toEqual(
      ["HIST-RT-SPLIT-B1"],
    );
    expect(olderWave!.querySelector('[data-testid="cr-group"][data-cr="HIST-RT-SPLIT-A1"]')).toBeNull();
    expect(olderWave!.querySelector('[data-testid="cr-group"][data-cr="HIST-RT-SPLIT-A2"]')).toBeNull();
  });
});

// ── regression — the History title and Now are unaffected ────────────────

describe("CR-CRU-173 §S1 — Now and the History title are unaffected by the release tree", () => {
  test("the desktop pane titles still read exactly 'Now' and 'History', and the Now pane still renders with nothing running", async () => {
    const key = "hist-rt-regression";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "RT Regression" })],
      history: [],
    });
    await openWorkflowTab();

    expect(textOf(document.querySelector('[data-testid="workflow-now-title"]'))).toBe("Now");
    expect(textOf(document.querySelector('[data-testid="workflow-history-title"]'))).toBe("History");
    expect(document.querySelector('[data-testid="workflow-now"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workflow-history"]')).not.toBeNull();
    // An empty /history answer renders no release rows at all — never a
    // crash, never a stray placeholder reading as a real release.
    expect(document.querySelectorAll('[data-testid="history-release"]').length).toBe(0);
  });
});

// ── CR-CRU-177 — "History shows only the past": the page half of \u00a7S1/\u00a7S2 ──
//
// RED's call on the exact wave-line format (NOT pinned by any CR or F22
// verbatim text — the storyboard's own wording, "wave 7 \u00b7 30 merged \u00b7 1
// pending", is reused literally, appended to the EXISTING `[data-testid=
// "wave-header"]` line after its current "History \u2014 Wave <n>" title and
// lane-chip/state segment, so the existing wave-header tests above (which
// never pin its exact text) keep passing unmodified).
//
// The "no row for a pending CR" half of the pin needs NO new page logic at
// all: `historyWave()` (public/app.js) already builds its CR list purely
// from `wire.crs`, and CR-CRU-177 \u00a7S2 moves the pending-CR filtering onto
// the SERVER (`crs` now holds completed CRs only) — a pending CR is simply
// never IN the wire payload the page receives, so it can render no row
// without the page itself changing. The test below still pins this
// end-to-end (a real regression guard, not a no-op): it feeds the page a
// wire shape that matches the NEW server contract and asserts the DOM
// has no trace of the pending CR anywhere, including the OLD "no plan
// filed" wording DRIFT-3 flags — proving the removal holds even once GREEN
// lands pendingCount/wave-line rendering alongside it.
describe("CR-CRU-177 \u00a7S1/\u00a7S2 (page half) — the release row and wave line read completed/pending counts; a pending CR renders no row", () => {
  test("the release row reads '<n> CRs completed · <p> pending' when the wire's pendingCount is non-zero", async () => {
    const key = "hist-cru177-release-pending";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CRU-177 Release Pending" })],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          crCount: 2,
          pendingCount: 1,
          waves: [{ wave: "8", crs: ["HIST-CRU177-800"], pendingCount: 0 }],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    expect(textOf(releaseToggle(releaseRow("0.3.0")))).toContain("2 CRs completed · 1 pending");
  });

  test("the release row reads '<n> CRs completed' with NO pending segment at all when the wire's pendingCount is 0", async () => {
    const key = "hist-cru177-release-no-pending";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CRU-177 Release No Pending" })],
      history: [
        {
          labels: ["0.2.0"],
          state: "shipped",
          shippedAt: 1_758_000_000,
          tag: "v0.2.0",
          commit: "eb6e33f0",
          crCount: 4,
          pendingCount: 0,
          waves: [{ wave: "6", crs: ["HIST-CRU177-600"], pendingCount: 0 }],
          workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const text = textOf(releaseToggle(releaseRow("0.2.0")));
    expect(text).toContain("4 CRs completed");
    expect(text).not.toContain("pending");
  });

  test("an open wave's header line reads 'wave <n> · <m> merged · <p> pending' alongside its existing title", async () => {
    const key = "hist-cru177-wave-line";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CRU-177 Wave Line" })],
      plans: [plan({ planId: 1, cr: "HIST-CRU177-801", projectKey: key, wave: "8" })],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          crCount: 1,
          pendingCount: 1,
          waves: [{ wave: "8", crs: ["HIST-CRU177-801"], pendingCount: 1 }],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const header = releaseRow("0.3.0").querySelector('[data-testid="wave-group"][data-wave="8"] [data-testid="wave-header"]');
    expect(header).not.toBeNull();
    expect(textOf(header)).toContain("wave 8 · 1 merged · 1 pending");
  });

  test("a wave whose CRs are ALL pending (wire sends pendingCount with an empty crs list) renders NO wave-group row at all — folded into the release's own pendingCount only", async () => {
    const key = "hist-cru177-wave-all-pending";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CRU-177 Wave All Pending" })],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          crCount: 0,
          pendingCount: 2,
          waves: [],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.3.0");
    expect(row.querySelectorAll('[data-testid="wave-group"]').length).toBe(0);
    expect(textOf(releaseToggle(row))).toContain("0 CRs completed · 2 pending");
  });

  test("a pending CR (the wire's `crs` no longer names it, per CR-CRU-177 \u00a7S2) renders no row ANYWHERE in History — not even the old 'no plan filed' row DRIFT-3 flagged for removal", async () => {
    const key = "hist-cru177-no-pending-row";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CRU-177 No Pending Row" })],
      // A real plan DOES exist for the pending CR (HIST-CRU177-802), proving
      // the row's absence is driven by the wire's `crs` list, not by a
      // missing plan (which is what produced the OLD 'no plan filed' text).
      plans: [
        plan({ planId: 1, cr: "HIST-CRU177-801", projectKey: key, wave: "8" }),
        plan({ planId: 2, cr: "HIST-CRU177-802", projectKey: key, wave: "8", status: "open", merge: undefined }),
      ],
      history: [
        {
          labels: ["0.3.0"],
          state: "in progress",
          crCount: 1,
          pendingCount: 1,
          // HIST-CRU177-802 (pending, filed but unmerged) is absent here —
          // the new server contract never sends it.
          waves: [{ wave: "8", crs: ["HIST-CRU177-801"], pendingCount: 1 }],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    });
    await openWorkflowTab();

    const row = releaseRow("0.3.0");
    expect(row.querySelector('[data-testid="cr-group"][data-cr="HIST-CRU177-801"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="cr-group"][data-cr="HIST-CRU177-802"]')).toBeNull();
    expect(textOf(row)).not.toContain("no plan filed");
    // The row-absence half of this test already holds against UNMODIFIED
    // page code (documented above) \u2014 this assertion is what makes the test
    // genuinely RED: the release row must also surface the pending CR as a
    // COUNT, not drop it silently.
    expect(textOf(releaseToggle(row))).toContain("1 pending");
  });
});
