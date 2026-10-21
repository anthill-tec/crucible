// The phone band's History cycle line keeps every tap: `→ Runs` leaves the
// line and becomes the last row of the line's expanded runs.
//
// At the phone band (`isPhoneBand()` in public/app.js, read from the `--band`
// token) a History cycle line (`LensCycleRow`) renders NO `→ Runs` pill
// (`[data-testid="cycle-to-runs"]`) — nothing clickable borders the line's
// empty space. Every line whose cycle has a runs boundary
// (`cycleHasRunsBoundary`: done, active, failed, skipped) is a toggle, and
// its expanded runs END with `→ Runs` as their own row, rendered even when no
// run of that cycle is in the loaded window (then the row is all the line
// opens to). The row navigates as the pill does and follows the pill's pruned
// path (`app-pill-dim`, `aria-disabled="true"`, the pruned title and label).
// Crossing the band swaps pill and row; tablet and desktop keep the pill on
// the line, as before.
//
// PINNED CONTRACT (the spec names no testid for the new row):
//   - The row is `[data-testid="cycle-to-runs-row"]`, a node of its own —
//     never inside `.app-cycle-line`, never inside a `linked-run-row`. The
//     element carrying that testid is the one that is clicked and the one
//     that wears the pruned dim (the same node, as the pill is one node).
//
// Harness: the happy-dom + real public/app.js / public/app-logic.mjs mount
// used by tests/workflow-cycle-row-toggle.test.ts and
// tests/cycle-runs-anchor-fetch.test.ts. The band is forced with an INLINE
// `--band` on the root element (as tests/workflow-now-pane.test.ts does);
// a band CROSSING is driven through the one listener public/app.js registers
// with `window.matchMedia(...)` — stubbed here so the test can fire its
// `change` event after re-writing `--band`.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { singleReleaseHistoryStub } from "./helpers/history-stub";

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

// The `→ Runs` pill's pruned reason (`PRUNED_PILL_REASON`, public/app.js):
// its title and its aria-label once the boundary is confirmed pruned. The
// row follows the pill's pruned path, so it wears the same words.
const PRUNED_REASON = "This cycle's Runs boundary has been pruned from the retained timeline";

const PILL = '[data-testid="cycle-to-runs"]';
const ROW = '[data-testid="cycle-to-runs-row"]';
const LINKED_RUN = '[data-testid="linked-run-row"]';

type Band = "desktop" | "tablet" | "phone";
type CycleStatus = "pending" | "active" | "done" | "skipped" | "failed";

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

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: CycleStatus;
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "closed";
  wave: string;
  merge: { commit: string };
  cycles: CycleFixture[];
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend";
  agentsOnline: number;
  agentsTotal: number;
  active: boolean;
  lastActivity: number;
}

interface MountOpts {
  key: string;
  plan: PlanFixture;
  events: EventFixture[];
  band?: Band;
  // Stub `window.matchMedia` and publish `--bp-phone-max`, so the band
  // listener public/app.js registers is captured and can be fired.
  bandListener?: boolean;
}

let cacheBust = 0;
let anchorCalls: string[] = [];
let bandListeners: Array<() => void> = [];

async function mountApp(opts: MountOpts): Promise<void> {
  anchorCalls = [];
  bandListeners = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';
  if (opts.band !== undefined) {
    document.documentElement.style.setProperty("--band", opts.band);
  }
  if (opts.bandListener === true) {
    document.documentElement.style.setProperty("--bp-phone-max", "599px");
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (type: string, fn: () => void) => {
        if (type === "change") bandListeners.push(fn);
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  const projects: ProjectFixture[] = [
    {
      key: opts.key,
      name: opts.key,
      type: "backend",
      agentsOnline: 0,
      agentsTotal: 0,
      active: true,
      lastActivity: Date.now(),
    },
  ];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      body = singleReleaseHistoryStub([opts.plan]);
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: [opts.plan] };
    } else if (url.includes("/api/v2/events") && /[?&]cycleId=/.test(url)) {
      // The anchored boundary read the `→ Runs` click falls back to when the
      // boundary is not in the loaded window. Empty events and NO `cycle`
      // field is the server's "truly pruned" answer.
      anchorCalls.push(url);
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-history-phone-runs-row.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowHistoryPhoneRunsRow=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

// `revealDeclaredMarker` retries on a real 5ms timer up to 30 times before
// it anchor-fetches; padded, never faked.
async function waitForRetryBudget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// Re-write the `--band` token and fire the band listener, as a rotation
// across the phone boundary does.
async function crossBand(band: Band): Promise<void> {
  expect(bandListeners.length).toBeGreaterThan(0);
  document.documentElement.style.setProperty("--band", band);
  for (const fn of bandListeners) fn();
  await settle();
}

function runEvent(key: string, id: string, cycleId: number, timestamp: number): EventFixture {
  return {
    id,
    projectKey: key,
    agentId: `agent-${id}`,
    kind: "test",
    tier: "unit",
    timestamp,
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    context: { cycleId },
  };
}

function closedPlan(key: string, cr: string, planId: number, cycles: CycleFixture[]): PlanFixture {
  return {
    planId,
    cr,
    projectKey: key,
    status: "closed",
    wave: "1",
    merge: { commit: `${cr.toLowerCase()}-merge` },
    cycles,
  };
}

function tabIsOn(name: string): boolean {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  return tab !== undefined && /\bon\b/.test(tab.className);
}

async function clickTab(name: string): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

// The History tree's CR groups start collapsed; open the one under test.
async function openCrGroup(cr: string): Promise<void> {
  const group = crGroup(cr);
  group.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
  await settle();
}

// Re-queried on every call: a band crossing re-renders the whole History tree.
function crGroup(cr: string): HTMLElement {
  const hist = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(hist).not.toBeNull();
  const group = hist!.querySelector<HTMLElement>(`[data-testid="cr-group"][data-cr="${cr}"]`);
  expect(group).not.toBeNull();
  return group!;
}

function lensRow(cr: string, cycleId: number): HTMLElement {
  const row = crGroup(cr).querySelector<HTMLElement>(
    `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

function lineOf(row: HTMLElement): HTMLElement {
  const line = row.querySelector<HTMLElement>(".app-cycle-line");
  expect(line).not.toBeNull();
  return line!;
}

function linkedRunIds(row: HTMLElement): Array<string | null> {
  return Array.from(row.querySelectorAll(LINKED_RUN)).map((r) => r.getAttribute("data-run-id"));
}

// The expanded runs END with the `→ Runs` row: exactly one row, a node of its
// own (outside the line and outside every run row), after every loaded run
// of the cycle in document order.
function expectRowEndsExpandedRuns(row: HTMLElement, runIds: string[]): HTMLElement {
  const rows = row.querySelectorAll<HTMLElement>(ROW);
  expect(rows.length, "exactly one → Runs row in the expanded runs").toBe(1);
  const toRuns = rows[0]!;
  expect((toRuns.textContent ?? "").trim()).toContain("→ Runs");
  expect(lineOf(row).contains(toRuns), "the → Runs row is not on the line").toBe(false);
  expect(linkedRunIds(row)).toEqual(runIds);
  for (const run of Array.from(row.querySelectorAll(LINKED_RUN))) {
    expect(run.contains(toRuns)).toBe(false);
    // DOCUMENT_POSITION_FOLLOWING = 4: the row comes after this run.
    expect((run.compareDocumentPosition(toRuns) & 4) !== 0, "the → Runs row follows every run").toBe(true);
  }
  // The pill never rides along into the expanded runs at the phone band.
  expect(row.querySelectorAll(PILL).length).toBe(0);
  return toRuns;
}

describe("phone band — a closed History cycle line carries no → Runs", () => {
  test("done, active, failed and skipped History lines render no → Runs pill and no row while closed, and each is a toggle; a pending line is neither", async () => {
    const key = "phone-closed-lines";
    const cr = "CR-PHONE-CLOSED";
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7301, [
        { id: 7311, label: "done cycle", kind: "red-green", status: "done" },
        { id: 7312, label: "active cycle", kind: "red-green", status: "active" },
        { id: 7313, label: "failed cycle", kind: "fix", status: "failed" },
        { id: 7314, label: "skipped cycle", kind: "verify", status: "skipped" },
        { id: 7315, label: "pending cycle", kind: "verify", status: "pending" },
      ]),
      events: [runEvent(key, "evt-phone-closed-1", 7311, now - 2000)],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const group = crGroup(cr);
    expect(group.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(5);
    // Nothing clickable borders any line: no pill anywhere in the group, and
    // no row before a line is opened.
    expect(group.querySelectorAll(PILL).length).toBe(0);
    expect(group.querySelectorAll(ROW).length).toBe(0);

    for (const id of [7311, 7312, 7313, 7314]) {
      const line = lineOf(lensRow(cr, id));
      expect(line.classList.contains("app-lens-toggle"), `cycle ${id}'s line is a toggle`).toBe(true);
    }
    // A pending cycle has no runs boundary: no toggle on its line.
    expect(lineOf(lensRow(cr, 7315)).classList.contains("app-lens-toggle")).toBe(false);
  });

  test("the closed done line keeps its '▸ N runs' hint while carrying no → Runs pill", async () => {
    const key = "phone-closed-hint";
    const cr = "CR-PHONE-HINT";
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7321, [
        { id: 7322, label: "runner choice declared", kind: "red-green", status: "done" },
      ]),
      events: [
        runEvent(key, "evt-phone-hint-1", 7322, now - 3000),
        runEvent(key, "evt-phone-hint-2", 7322, now - 1000),
      ],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, 7322);
    const hint = row.querySelector<HTMLElement>(".app-run-count-hint");
    expect(hint).not.toBeNull();
    expect((hint!.textContent ?? "").trim()).toBe("▸ 2 runs");
    expect(row.querySelectorAll(PILL).length).toBe(0);
    expect(row.querySelectorAll(ROW).length).toBe(0);
  });
});

describe("phone band — every runs boundary expands, and its expanded runs end with the → Runs row", () => {
  test("a done line opens on a tap to its runs then the → Runs row, and a second tap hides both", async () => {
    const key = "phone-done-open";
    const cr = "CR-PHONE-DONE";
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7331, [
        { id: 7332, label: "runner choice declared", kind: "red-green", status: "done" },
      ]),
      events: [
        runEvent(key, "evt-phone-done-red", 7332, now - 3000),
        runEvent(key, "evt-phone-done-green", 7332, now - 1000),
      ],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, 7332);
    lineOf(row).click();
    await settle();
    expectRowEndsExpandedRuns(row, ["evt-phone-done-red", "evt-phone-done-green"]);

    lineOf(row).click();
    await settle();
    expect(row.querySelectorAll(LINKED_RUN).length).toBe(0);
    expect(row.querySelectorAll(ROW).length).toBe(0);
  });

  test("a failed line with no run in the loaded window opens on a tap to the → Runs row alone, and a second tap hides it", async () => {
    const key = "phone-failed-empty";
    const cr = "CR-PHONE-FAILED-EMPTY";
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7341, [{ id: 7342, label: "exits", kind: "fix", status: "failed" }]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, 7342);
    expect(row.querySelectorAll(ROW).length).toBe(0);
    lineOf(row).click();
    await settle();
    expectRowEndsExpandedRuns(row, []);

    lineOf(row).click();
    await settle();
    expect(row.querySelectorAll(ROW).length).toBe(0);
  });

  test("a failed line with its run loaded opens to that run then the → Runs row", async () => {
    const key = "phone-failed-run";
    const cr = "CR-PHONE-FAILED-RUN";
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7351, [{ id: 7352, label: "red run", kind: "red-green", status: "failed" }]),
      events: [runEvent(key, "evt-phone-failed-run", 7352, now - 1000)],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, 7352);
    lineOf(row).click();
    await settle();
    expectRowEndsExpandedRuns(row, ["evt-phone-failed-run"]);
  });

  test("a skipped line opens on a tap to the → Runs row, while a pending line beside it opens to nothing", async () => {
    const key = "phone-skipped";
    const cr = "CR-PHONE-SKIPPED";
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7361, [
        { id: 7362, label: "verify skipped", kind: "verify", status: "skipped" },
        { id: 7363, label: "never started", kind: "verify", status: "pending" },
      ]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const skipped = lensRow(cr, 7362);
    lineOf(skipped).click();
    await settle();
    expectRowEndsExpandedRuns(skipped, []);

    const pending = lensRow(cr, 7363);
    lineOf(pending).click();
    await settle();
    expect(pending.querySelectorAll(ROW).length).toBe(0);
    expect(pending.querySelectorAll(PILL).length).toBe(0);
    // Bounded: the skipped line's row is the only one in the group.
    expect(crGroup(cr).querySelectorAll(ROW).length).toBe(1);
  });

  test("an active line with no runs opens on a tap to the → Runs row alone", async () => {
    const key = "phone-active-empty";
    const cr = "CR-PHONE-ACTIVE";
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7371, [
        { id: 7372, label: "still active", kind: "red-green", status: "active" },
      ]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, 7372);
    lineOf(row).click();
    await settle();
    expectRowEndsExpandedRuns(row, []);

    lineOf(row).click();
    await settle();
    expect(row.querySelectorAll(ROW).length).toBe(0);
  });

  test("a tap on a failed line's status glyph, label, timer or empty space each opens it to the → Runs row", async () => {
    const key = "phone-failed-targets";
    const cr = "CR-PHONE-FAILED-TARGETS";
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7381, [
        {
          id: 7382,
          label: "a failed cycle whose label is long enough to wrap on a phone",
          kind: "fix",
          status: "failed",
          activatedAt: now - 12 * 60_000,
          doneAt: now - 60_000,
        },
      ]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const targets: Array<[string, (row: HTMLElement) => Element | null]> = [
      ["status glyph", (row) => row.querySelector(".app-cycle-glyph")],
      ["label", (row) => row.querySelector(".app-cycle-label")],
      ["timer", (row) => row.querySelector('[data-testid="cycle-timer"]')],
      ["empty space (the line itself)", (row) => row.querySelector(".app-cycle-line")],
    ];
    for (const [name, find] of targets) {
      const row = lensRow(cr, 7382);
      expect(row.querySelectorAll(ROW).length, `${name}: the line starts closed`).toBe(0);
      const target = find(row);
      expect(target, `${name}: renders on the closed line`).not.toBeNull();
      (target as HTMLElement).click();
      await settle();
      expect(lensRow(cr, 7382).querySelectorAll(ROW).length, `a tap on the ${name} opens the line`).toBe(1);

      lineOf(lensRow(cr, 7382)).click();
      await settle();
      expect(lensRow(cr, 7382).querySelectorAll(ROW).length, `${name}: a second tap closes it`).toBe(0);
    }
  });
});

describe("phone band — the → Runs row navigates as the pill does", () => {
  test("a tap on the row of a done line whose boundary is loaded shows the Runs tab with that boundary scrolled into view, and fires no anchored read", async () => {
    const key = "phone-row-navigates";
    const cr = "CR-PHONE-ROW-NAV";
    const cycleId = 7392;
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7391, [{ id: cycleId, label: "navigates", kind: "red-green", status: "done" }]),
      events: [runEvent(key, "evt-phone-row-nav", cycleId, now - 1000)],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, cycleId);
    lineOf(row).click();
    await settle();
    const toRuns = expectRowEndsExpandedRuns(row, ["evt-phone-row-nav"]);
    // A live boundary: not dim.
    expect(toRuns.classList.contains("app-pill-dim")).toBe(false);
    expect(toRuns.getAttribute("aria-disabled")).not.toBe("true");

    const scrolled: HTMLElement[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (...a: unknown[]) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    try {
      expect(tabIsOn("Runs")).toBe(false);
      toRuns.click();
      await settle();
      expect(tabIsOn("Runs")).toBe(true);
      expect(document.querySelector('[data-testid="workspace-runs"]')).not.toBeNull();
      const marker = document.querySelector<HTMLElement>(
        `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
      );
      expect(marker).not.toBeNull();
      expect(scrolled).toContain(marker!);
      await waitForRetryBudget();
      expect(anchorCalls.length).toBe(0);
    } finally {
      proto.scrollIntoView = original;
    }
  });
});

describe("phone band — a pruned boundary dims the → Runs row as it dims the pill", () => {
  test("the row tapped on a boundary the server confirms pruned shows the Runs tab and is itself dimmed with the pruned title and label", async () => {
    const key = "phone-row-pruned-reflect";
    const cr = "CR-PHONE-ROW-PRUNED-1";
    const cycleId = 7402;
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7401, [{ id: cycleId, label: "old cycle", kind: "red-green", status: "done" }]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    const row = lensRow(cr, cycleId);
    lineOf(row).click();
    await settle();
    const toRuns = expectRowEndsExpandedRuns(row, []);
    // Pruning is unknown until a tap's anchored read says so: live at first.
    expect(toRuns.classList.contains("app-pill-dim")).toBe(false);
    expect(toRuns.getAttribute("aria-disabled")).not.toBe("true");

    toRuns.click();
    await waitForRetryBudget();
    await settle();

    expect(tabIsOn("Runs")).toBe(true);
    expect(anchorCalls.length).toBe(1);
    expect(new URLSearchParams(anchorCalls[0]!.slice(anchorCalls[0]!.indexOf("?") + 1)).get("cycleId")).toBe(
      String(cycleId),
    );
    expect(toRuns.classList.contains("app-pill-dim")).toBe(true);
    expect(toRuns.getAttribute("aria-disabled")).toBe("true");
    expect(toRuns.getAttribute("title")).toBe(PRUNED_REASON);
    expect(toRuns.getAttribute("aria-label")).toBe(PRUNED_REASON);
  });

  test("once pruned, a fresh render of the row is dim with the pruned title and label, and a tap on it still shows the Runs tab", async () => {
    const key = "phone-row-pruned-fresh";
    const cr = "CR-PHONE-ROW-PRUNED-2";
    const cycleId = 7412;
    await mountApp({
      key,
      band: "phone",
      plan: closedPlan(key, cr, 7411, [{ id: cycleId, label: "old cycle", kind: "red-green", status: "done" }]),
      events: [],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);

    lineOf(lensRow(cr, cycleId)).click();
    await settle();
    const first = expectRowEndsExpandedRuns(lensRow(cr, cycleId), []);
    first.click();
    await waitForRetryBudget();
    await settle();
    expect(tabIsOn("Runs")).toBe(true);
    expect(anchorCalls.length).toBe(1);

    // Back to Workflow: the pane re-mounts, the line stays open, and the row
    // is a brand-new node the tap never touched.
    await clickTab("Workflow");
    const fresh = expectRowEndsExpandedRuns(lensRow(cr, cycleId), []);
    expect(fresh).not.toBe(first);
    expect(fresh.classList.contains("app-pill-dim")).toBe(true);
    expect(fresh.getAttribute("aria-disabled")).toBe("true");
    expect(fresh.getAttribute("title")).toBe(PRUNED_REASON);
    expect(fresh.getAttribute("aria-label")).toBe(PRUNED_REASON);

    // Dim is not dead: a tap still shows the Runs tab (and re-confirms).
    fresh.click();
    await waitForRetryBudget();
    await settle();
    expect(tabIsOn("Runs")).toBe(true);
    expect(anchorCalls.length).toBe(2);
  });
});

describe("crossing the phone boundary swaps the → Runs pill and the → Runs row", () => {
  test("phone → tablet → phone: the open line shows the row and no pill on the phone, the pill on the line and no row on the tablet, and the row again back on the phone", async () => {
    const key = "phone-band-swap";
    const cr = "CR-PHONE-SWAP";
    const cycleId = 7422;
    const now = Date.now();
    await mountApp({
      key,
      band: "phone",
      bandListener: true,
      plan: closedPlan(key, cr, 7421, [{ id: cycleId, label: "rotates", kind: "red-green", status: "done" }]),
      events: [runEvent(key, "evt-phone-swap", cycleId, now - 1000)],
    });
    await clickTab("Workflow");
    await openCrGroup(cr);
    lineOf(lensRow(cr, cycleId)).click();
    await settle();

    // Phone: the row ends the open runs; no pill.
    expectRowEndsExpandedRuns(lensRow(cr, cycleId), ["evt-phone-swap"]);

    // Tablet: the pill is back on the line, and no row renders anywhere.
    await crossBand("tablet");
    const tabletRow = lensRow(cr, cycleId);
    expect(lineOf(tabletRow).querySelectorAll(PILL).length).toBe(1);
    expect(tabletRow.querySelectorAll(PILL).length).toBe(1);
    expect(document.querySelectorAll(ROW).length).toBe(0);

    // Phone again: the pill leaves the line and the row returns.
    await crossBand("phone");
    expectRowEndsExpandedRuns(lensRow(cr, cycleId), ["evt-phone-swap"]);
  });
});

describe("tablet and desktop — the History line keeps its → Runs pill (unchanged)", () => {
  for (const band of ["tablet", "desktop"] as const) {
    test(`${band}: done, active, failed and skipped lines each carry the pill on the line, and an opened done line shows its runs with no → Runs row`, async () => {
      const key = `history-pill-${band}`;
      const cr = `CR-PILL-${band.toUpperCase()}`;
      const now = Date.now();
      await mountApp({
        key,
        band,
        plan: closedPlan(key, cr, 7431, [
          { id: 7432, label: "done cycle", kind: "red-green", status: "done" },
          { id: 7433, label: "active cycle", kind: "red-green", status: "active" },
          { id: 7434, label: "failed cycle", kind: "fix", status: "failed" },
          { id: 7435, label: "skipped cycle", kind: "verify", status: "skipped" },
          { id: 7436, label: "pending cycle", kind: "verify", status: "pending" },
        ]),
        events: [runEvent(key, `evt-pill-${band}`, 7432, now - 1000)],
      });
      await clickTab("Workflow");
      await openCrGroup(cr);

      for (const id of [7432, 7433, 7434, 7435]) {
        expect(lineOf(lensRow(cr, id)).querySelectorAll(PILL).length, `cycle ${id} has its pill`).toBe(1);
      }
      expect(lensRow(cr, 7436).querySelectorAll(PILL).length).toBe(0);
      expect(crGroup(cr).querySelectorAll(PILL).length).toBe(4);

      const done = lensRow(cr, 7432);
      lineOf(done).click();
      await settle();
      expect(linkedRunIds(done)).toEqual([`evt-pill-${band}`]);
      expect(document.querySelectorAll(ROW).length).toBe(0);
    });
  }
});
