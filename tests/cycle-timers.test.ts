// CR-CRU-021 §S3 — Active-cycle timer (user input 2026-07-16).
//
// Spec (verbatim): "Cycle rows carry a live timer: an ACTIVE cycle shows a
// ticking elapsed time anchored to its `activatedAt` (server-stamped since
// CR-011 C4), visibly updating while it runs; on transition to `done` (or any
// terminal state) the timer stops and the row shows the sealed duration
// (`doneAt − activatedAt`). Applies to the Workflow active section and
// history cycle rows alike (history shows sealed durations). Cycles
// predating the timestamp migration (no `activatedAt`) show no timer, never
// a fabricated value."
//
// AC (verbatim): "an active cycle row renders `data-testid="cycle-timer"`
// whose text advances across two samples with an injected clock (ticking,
// anchored to `activatedAt`); PATCHing the cycle `done` seals it — the timer
// text equals the formatted `doneAt − activatedAt` and no longer advances; a
// done history cycle row shows the same sealed duration; a cycle with no
// `activatedAt` renders NO `cycle-timer` element."
//
// RED phase: `data-testid="cycle-timer"` does not exist anywhere in
// production yet — `CycleRow` (public/app.js ~1283, Workflow active section)
// and `LensCycleRow` (public/app.js ~1391, History section) render cycle
// rows with NO timer element at all, so every `cycle-timer` query below
// returns null and every exact-text assertion fails.
//
// ── CLOCK-INJECTION FINDING ──────────────────────────────────────────────
// The dispatch brief pointed at tests/agent-runtime-pane.test.ts as the
// "existing agent-runtime ticker test" precedent for deterministic clock
// injection. On inspection, that file's ticking assertions
// (`waitForPollTick`) use a REAL wall-clock `setTimeout` wait of
// POLL_INTERVAL_MS + 700 (~5.7s) around the production 5000ms poll — NOT an
// injected clock. There is no clock-injection precedent for DOM ticking
// tests anywhere in this repo. The nearest precedent for "explicit,
// controllable time" is the PURE `relativeTime(ts, now)` app-logic function
// (tests/app-logic.test.ts), which takes `now` as an explicit parameter
// rather than reading the wall clock — but that is a pure-logic pattern, not
// a DOM one, and this CR's AC is about the rendered `cycle-timer` element.
//
// The deterministic, zero-real-wait mechanism actually available for DOM
// tests is `bun:test`'s native `setSystemTime()` (mocks `Date.now()` /
// `new Date()` process-wide — see node_modules/bun-types/test.d.ts). Since
// existing production render call sites already compute "now" via a direct
// `Date.now()` call at the call site (`const rel = (ts) =>
// L.relativeTime(ts, Date.now());`, public/app.js:204) rather than through
// any injectable parameter, `setSystemTime()` is the correct injection point
// regardless of how GREEN wires the new cycle-timer computation — it does
// not presume an internal poll/ticker mechanism.
//
// Each "two samples" test below performs two independent fresh mounts under
// two different injected system times (same fixed `activatedAt`/`doneAt`)
// rather than waiting for an in-session poll tick to fire — fully
// deterministic, and it still drives the real production public/app.js
// render path both times, matching the mountApp harness pattern used by
// tests/f13-fidelity.test.ts / tests/workflow-lens.test.ts.
//
// ── FORMAT FINDING ────────────────────────────────────────────────────────
// The existing `fmtDuration` helper (public/app.js:418 — reused by
// `agent-runtime`, `declared-marker`'s "closed in …", and `cr-agent-
// runtime`) formats as `${m}m ${s}s` with NO zero-padding on seconds, e.g.
// 543_000ms -> "9m 3s". The F13 mock (.lavish/crucible-v2-design.html:649)
// renders the SAME 543s-class value zero-padded — "⏱ 9m 03s" — so the new
// cycle-timer badge needs its OWN zero-padded-seconds format; it is NOT a
// bare reuse of `fmtDuration`. Every exact-text assertion below pins the
// `⏱ <m>m <ss>s` zero-padded contract (glyph + space + minutes + "m" + space
// + zero-padded seconds + "s"), including at least one value whose seconds
// component is a single digit (05, 03) to force the zero-pad requirement.
//
// Hour rollover (`Xh Ym Zs`) is intentionally NOT asserted here: neither the
// F13 mock nor the AC shows an hour-scale example, and `fmtDuration` itself
// has no hour rollover either (a 61-minute value renders "61m Ns", never
// "1h 1m Ns") — there is no concrete contract to pin beyond minute-scale.

import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
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

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  // CR-CRU-011 C4 — server-stamped, additive, optional.
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  orchestrator?: string;
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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/f13-fidelity.test.ts. */
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
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`cycle-timers.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cycleTimers=${cacheBust}`);

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
  setSystemTime(); // reset the injected clock so it never leaks to other files
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

function cycleRowFor(root: HTMLElement, testid: string, label: string): HTMLElement {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
  const row = rows.find((r) => (r.textContent ?? "").includes(label));
  expect(row).toBeDefined();
  return row!;
}

// A fixed epoch anchor for `activatedAt` — arbitrary but constant across
// tests so every assertion below is a pure function of the injected system
// time, never of real wall-clock time.
const ACTIVATED_AT = 1_750_000_000_000;

describe("§S3 — active-cycle timer: ticking, anchored to activatedAt (Workflow active section)", () => {
  test(
    'an ACTIVE cycle row renders data-testid="cycle-timer" whose zero-padded-seconds text advances across two samples taken under an injected clock (activatedAt fixed, system time varies)',
    async () => {
      const plan = (): PlanFixture => ({
        planId: 1,
        cr: "CR-TIMER-1",
        status: "open",
        wave: "1",
        cycles: [
          { id: 501, label: "compile fallback", status: "active", activatedAt: ACTIVATED_AT },
        ],
      });

      // Sample A — elapsed 245_000ms = 4m 05s (single-digit seconds: forces
      // the zero-pad requirement).
      setSystemTime(ACTIVATED_AT + 245_000);
      await mountApp({
        pathname: "/p/proj-timer-1",
        projects: [project({ key: "proj-timer-1", name: "Timer Project" })],
        plans: [plan()],
      });
      await openWorkflowTab();
      const rowA = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerA = rowA.querySelector('[data-testid="cycle-timer"]');
      expect(timerA).not.toBeNull();
      const textA = norm(timerA!.textContent);
      expect(textA).toBe("⏱ 4m 05s");

      // Sample B — SAME activatedAt, LATER injected system time: elapsed
      // 252_000ms = 4m 12s.
      setSystemTime(ACTIVATED_AT + 252_000);
      await mountApp({
        pathname: "/p/proj-timer-1",
        projects: [project({ key: "proj-timer-1", name: "Timer Project" })],
        plans: [plan()],
      });
      await openWorkflowTab();
      const rowB = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerB = rowB.querySelector('[data-testid="cycle-timer"]');
      expect(timerB).not.toBeNull();
      const textB = norm(timerB!.textContent);
      expect(textB).toBe("⏱ 4m 12s");

      // Ticking — advances between the two samples, never a frozen/fabricated value.
      expect(textB).not.toBe(textA);
    },
  );

  test(
    "the ACTIVE cycle's timer badge sits inline AFTER the ACTIVE narration and BEFORE the open span (F13 composition: `▶ cycle 2 · \"compile fallback\" · ACTIVE ⏱ 4m 12s`)",
    async () => {
      const plan: PlanFixture = {
        planId: 2,
        cr: "CR-TIMER-2",
        status: "open",
        wave: "1",
        cycles: [
          { id: 502, label: "compile fallback", status: "active", activatedAt: ACTIVATED_AT },
        ],
      };
      setSystemTime(ACTIVATED_AT + 252_000);
      await mountApp({
        pathname: "/p/proj-timer-2",
        projects: [project({ key: "proj-timer-2", name: "Timer Project 2" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timer = row.querySelector('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();
      expect(norm(timer!.textContent)).toBe("⏱ 4m 12s");

      const rowText = norm(row.textContent);
      const activeIdx = rowText.indexOf("ACTIVE");
      const timerIdx = rowText.indexOf("⏱ 4m 12s");
      expect(activeIdx).toBeGreaterThanOrEqual(0);
      expect(timerIdx).toBeGreaterThan(activeIdx);

      // Bound — the timer element is a descendant of the cycle row (loose
      // composition; not asserting an exact DOM nesting depth so this does
      // not collide with tests/f13-fidelity.test.ts's row-level toContain
      // assertions on the same fixture shape).
      expect(row.contains(timer)).toBe(true);
    },
  );
});

describe("§S3 — PATCH-to-done seals the timer (Workflow active section)", () => {
  test(
    'PATCHing a cycle to "done" seals its timer: the rendered text equals the formatted `doneAt − activatedAt` and no longer advances, even when sampled at a much later injected system time',
    async () => {
      const DONE_AT = ACTIVATED_AT + 760_000; // 12m 40s span — matches the F13 mock exactly.

      const donePlan = (): PlanFixture => ({
        planId: 3,
        cr: "CR-TIMER-3",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 503,
            label: "compile fallback",
            status: "done",
            activatedAt: ACTIVATED_AT,
            doneAt: DONE_AT,
          },
        ],
      });

      // Pre-PATCH sanity sample: while still ACTIVE (no doneAt) at the same
      // elapsed offset, the ticking value would read the same "⏱ 12m 40s" —
      // establishing that the sealed text below is not a coincidence of a
      // different format, just the SAME clock frozen at the seal point.
      setSystemTime(DONE_AT);
      await mountApp({
        pathname: "/p/proj-timer-3a",
        projects: [project({ key: "proj-timer-3a", name: "Pre-seal Project" })],
        plans: [
          {
            planId: 30,
            cr: "CR-TIMER-3A",
            status: "open",
            wave: "1",
            cycles: [
              { id: 5030, label: "compile fallback", status: "active", activatedAt: ACTIVATED_AT },
            ],
          },
        ],
      });
      await openWorkflowTab();
      const preRow = cycleRowFor(active(), "cycle-row", "compile fallback");
      const preTimer = preRow.querySelector('[data-testid="cycle-timer"]');
      expect(preTimer).not.toBeNull();
      expect(norm(preTimer!.textContent)).toBe("⏱ 12m 40s");

      // Sample 1 (post-PATCH), sampled shortly after doneAt.
      setSystemTime(DONE_AT + 500_000);
      await mountApp({
        pathname: "/p/proj-timer-3",
        projects: [project({ key: "proj-timer-3", name: "Sealed Project" })],
        plans: [donePlan()],
      });
      await openWorkflowTab();
      const row1 = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timer1 = row1.querySelector('[data-testid="cycle-timer"]');
      expect(timer1).not.toBeNull();
      const text1 = norm(timer1!.textContent);
      expect(text1).toBe("⏱ 12m 40s");

      // Sample 2 (post-PATCH), sampled MUCH later — if the render were still
      // ticking off `Date.now() - activatedAt` this would read ~83m+, not
      // the sealed 12m 40s.
      setSystemTime(DONE_AT + 5_000_000);
      await mountApp({
        pathname: "/p/proj-timer-3",
        projects: [project({ key: "proj-timer-3", name: "Sealed Project" })],
        plans: [donePlan()],
      });
      await openWorkflowTab();
      const row2 = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timer2 = row2.querySelector('[data-testid="cycle-timer"]');
      expect(timer2).not.toBeNull();
      const text2 = norm(timer2!.textContent);
      expect(text2).toBe("⏱ 12m 40s");

      // No longer advances — identical across both post-seal samples.
      expect(text2).toBe(text1);
    },
  );

  test(
    'a done cycle\'s sealed timer trails the "done — GREEN confirmed" narration (F13 composition: `… · done — GREEN confirmed ⏱ 12m 40s`) without breaking the existing narration substring contract',
    async () => {
      const plan: PlanFixture = {
        planId: 4,
        cr: "CR-TIMER-4",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 504,
            label: "checkpoint persistence",
            status: "done",
            activatedAt: ACTIVATED_AT,
            doneAt: ACTIVATED_AT + 760_000,
          },
        ],
      };
      setSystemTime(ACTIVATED_AT + 900_000);
      await mountApp({
        pathname: "/p/proj-timer-4",
        projects: [project({ key: "proj-timer-4", name: "Narration Timer Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "checkpoint persistence");
      // Existing §S6 narration contract (tests/f13-fidelity.test.ts) — must
      // still hold with the timer added.
      expect(norm(row.textContent)).toContain(
        'cycle 1 · "checkpoint persistence" · done — GREEN confirmed',
      );

      const timer = row.querySelector('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();
      expect(norm(timer!.textContent)).toBe("⏱ 12m 40s");

      const rowText = norm(row.textContent);
      const narrationIdx = rowText.indexOf("GREEN confirmed");
      const timerIdx = rowText.indexOf("⏱ 12m 40s");
      expect(timerIdx).toBeGreaterThan(narrationIdx);
    },
  );
});

describe("§S3 — history cycle rows show the same sealed duration", () => {
  test(
    'a done history cycle row (LensCycleRow, inside an expanded closed-CR group) renders data-testid="cycle-timer" with the SAME sealed `doneAt − activatedAt` format as the active section, zero-padded seconds included',
    async () => {
      const DONE_AT_1 = ACTIVATED_AT + 441_000; // 7m 21s — matches the F13 mock exactly.
      const DONE_AT_2 = ACTIVATED_AT + 543_000; // 9m 03s — single-digit seconds, forces zero-pad.

      const plan: PlanFixture = {
        planId: 5,
        cr: "CR-TIMER-HIST-1",
        status: "closed",
        wave: "1",
        track: "track-1",
        merge: { commit: "abc0001" },
        cycles: [
          {
            id: 601,
            label: "schema groundwork",
            status: "done",
            activatedAt: ACTIVATED_AT,
            doneAt: DONE_AT_1,
          },
          {
            id: 602,
            label: "wire the API",
            status: "done",
            activatedAt: ACTIVATED_AT,
            doneAt: DONE_AT_2,
          },
        ],
      };

      setSystemTime(DONE_AT_2 + 1_000_000);
      await mountApp({
        pathname: "/p/proj-timer-hist-1",
        projects: [project({ key: "proj-timer-hist-1", name: "History Timer Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-TIMER-HIST-1"]',
      );
      expect(crGroup).not.toBeNull();
      const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
      expect(groupToggle).not.toBeNull();
      groupToggle!.click();
      await settle();

      const row1 = cycleRowFor(crGroup!, "lens-cycle-row", "schema groundwork");
      const timer1 = row1.querySelector('[data-testid="cycle-timer"]');
      expect(timer1).not.toBeNull();
      expect(norm(timer1!.textContent)).toBe("⏱ 7m 21s");
      expect(row1.contains(timer1)).toBe(true);

      const row2 = cycleRowFor(crGroup!, "lens-cycle-row", "wire the API");
      const timer2 = row2.querySelector('[data-testid="cycle-timer"]');
      expect(timer2).not.toBeNull();
      expect(norm(timer2!.textContent)).toBe("⏱ 9m 03s");
    },
  );
});

describe('§S3 — no activatedAt renders NO cycle-timer element (never a fabricated value)', () => {
  test(
    "an ACTIVE cycle predating the timestamp migration (no activatedAt) renders NO cycle-timer element",
    async () => {
      const plan: PlanFixture = {
        planId: 6,
        cr: "CR-TIMER-NOTS-1",
        status: "open",
        wave: "1",
        cycles: [{ id: 701, label: "legacy active cycle", status: "active" }],
      };
      await mountApp({
        pathname: "/p/proj-timer-nots-1",
        projects: [project({ key: "proj-timer-nots-1", name: "No Timestamp Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "legacy active cycle");
      expect(row.querySelector('[data-testid="cycle-timer"]')).toBeNull();
    },
  );

  test(
    "a DONE cycle predating the timestamp migration (no activatedAt/doneAt) renders NO cycle-timer element in the active section",
    async () => {
      const plan: PlanFixture = {
        planId: 7,
        cr: "CR-TIMER-NOTS-2",
        status: "open",
        wave: "1",
        cycles: [{ id: 702, label: "legacy done cycle", status: "done" }],
      };
      await mountApp({
        pathname: "/p/proj-timer-nots-2",
        projects: [project({ key: "proj-timer-nots-2", name: "No Timestamp Project 2" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "legacy done cycle");
      expect(row.querySelector('[data-testid="cycle-timer"]')).toBeNull();
    },
  );

  test(
    "a DONE history cycle predating the timestamp migration (no activatedAt/doneAt) renders NO cycle-timer element in its lens-cycle-row",
    async () => {
      const plan: PlanFixture = {
        planId: 8,
        cr: "CR-TIMER-NOTS-3",
        status: "closed",
        wave: "1",
        track: "track-1",
        merge: { commit: "abc0002" },
        cycles: [{ id: 801, label: "legacy history cycle", status: "done" }],
      };
      await mountApp({
        pathname: "/p/proj-timer-nots-3",
        projects: [project({ key: "proj-timer-nots-3", name: "No Timestamp History Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-TIMER-NOTS-3"]',
      );
      expect(crGroup).not.toBeNull();
      const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
      expect(groupToggle).not.toBeNull();
      groupToggle!.click();
      await settle();

      const row = cycleRowFor(crGroup!, "lens-cycle-row", "legacy history cycle");
      expect(row.querySelector('[data-testid="cycle-timer"]')).toBeNull();
    },
  );
});
