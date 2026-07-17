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
// Orchestrator pin (live-review, same session as this RED) — cycle-timer
// badges must never wrap at narrow widths; reuses the styles.css
// source-assertion technique tests/f13-fidelity.test.ts's §S6 #7
// GLYPH-ONLY-coloring block already established (`ruleBody` regex over the
// real stylesheet source, independent of happy-dom's lack of real layout).
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES_SRC);
  return match?.[1];
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  // CR-CRU-011 C4 — server-stamped, additive, optional.
  activatedAt?: number;
  doneAt?: number;
  // CR-CRU-023 §S3 (a) — additive: server-fed accumulated attention time in
  // ms (persisted `activeMs`, restart-resume semantics — store/server side
  // pinned in tests/cycle-epochs.test.ts). ACTIVE rows must derive their
  // ticking badge from THIS field, not from `Date.now() - activatedAt`.
  activeMs?: number;
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
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
        projectKey: "proj-timer-1",
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
        projectKey: "proj-timer-2",
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
        projectKey: "proj-timer-3",
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
            projectKey: "proj-timer-3a",
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
    'RE-BASELINED (user, 2026-07-17): a done cycle\'s sealed timer renders alongside the BARE label — NO "done — GREEN confirmed" narration anywhere (the ✓ glyph IS the done signal; F13 composition: `cycle 1 · "checkpoint persistence" ⏱ 12m 40s`)',
    async () => {
      const plan: PlanFixture = {
        planId: 4,
        cr: "CR-TIMER-4",
        projectKey: "proj-timer-4",
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
      const rowText = norm(row.textContent);
      // RE-BASELINED §S6 #2 — the removed narration, in every form.
      expect(rowText).not.toContain("GREEN confirmed");
      expect(rowText).not.toContain("report accepted");
      expect(rowText).not.toContain(" by ");
      expect(rowText).not.toContain(" · done");

      const timer = row.querySelector('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();
      expect(norm(timer!.textContent)).toBe("⏱ 12m 40s");

      // Bare label text precedes the timer, in the aligned column.
      expect(rowText).toContain('cycle 1 · "checkpoint persistence"');
      const labelIdx = rowText.indexOf('cycle 1 · "checkpoint persistence"');
      const timerIdx = rowText.indexOf("⏱ 12m 40s");
      expect(timerIdx).toBeGreaterThan(labelIdx);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════
// PLAN CYCLE 19 — §S6 RE-BASELINE (user, 2026-07-17): ALIGNED TIMERS.
// "Row timers (§S3) render in an ALIGNED right-hand column so rows read
// clean regardless of label length." Neither variant currently carries a
// shared class: the ACTIVE badge is `app-cycle-timer-ember` alone, the
// sealed badge is `app-card-meta app-cycle-timer-sealed` — no common token
// between them for a shared right-alignment rule to hook into. This pins
// CLASS PRESENCE (a structural, additive shared class both variants must
// carry) — not pixel values; happy-dom performs no layout, so GREEN's exact
// CSS technique (flex `margin-left: auto`, grid column, etc.) is its own
// choice as long as both variants expose the same alignment class.
describe("§S3 (re-baselined 2026-07-17) — ALIGNED TIMERS: cycle-row timers share a common right-aligned class regardless of status", () => {
  test("the ACTIVE ember timer badge and a DONE sealed timer badge both carry the SAME shared alignment class, additively alongside each variant's own distinct modifier class", async () => {
    const activePlan: PlanFixture = {
      planId: 201,
      cr: "CR-ALIGN-1",
      projectKey: "proj-align-1",
      status: "open",
      wave: "1",
      cycles: [
        { id: 1001, label: "compile fallback", status: "active", activatedAt: ACTIVATED_AT },
      ],
    };
    setSystemTime(ACTIVATED_AT + 100_000);
    await mountApp({
      pathname: "/p/proj-align-1",
      projects: [project({ key: "proj-align-1", name: "Align Project" })],
      plans: [activePlan],
    });
    await openWorkflowTab();
    const activeRow = cycleRowFor(active(), "cycle-row", "compile fallback");
    const activeTimer = activeRow.querySelector<HTMLElement>('[data-testid="cycle-timer"]');
    expect(activeTimer).not.toBeNull();
    const activeTokens = new Set((activeTimer!.className ?? "").split(/\s+/).filter(Boolean));

    const donePlan: PlanFixture = {
      planId: 202,
      cr: "CR-ALIGN-2",
      projectKey: "proj-align-2",
      status: "open",
      wave: "1",
      cycles: [
        {
          id: 1002,
          label: "compile fallback",
          status: "done",
          activatedAt: ACTIVATED_AT,
          doneAt: ACTIVATED_AT + 760_000,
        },
      ],
    };
    await mountApp({
      pathname: "/p/proj-align-2",
      projects: [project({ key: "proj-align-2", name: "Align Project 2" })],
      plans: [donePlan],
    });
    await openWorkflowTab();
    const doneRow = cycleRowFor(active(), "cycle-row", "compile fallback");
    const doneTimer = doneRow.querySelector<HTMLElement>('[data-testid="cycle-timer"]');
    expect(doneTimer).not.toBeNull();
    const doneTokens = new Set((doneTimer!.className ?? "").split(/\s+/).filter(Boolean));

    // Structural shared class — the same token on both variants.
    const shared = [...activeTokens].filter((t) => doneTokens.has(t));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared).toContain("app-cycle-timer-slot");

    // Bound — additive, not a replacement: each variant keeps its OWN
    // distinct modifier class too.
    expect(activeTokens.has("app-cycle-timer-ember")).toBe(true);
    expect(doneTokens.has("app-cycle-timer-sealed")).toBe(true);
  });

  test("a HISTORY lens-cycle-row's sealed timer carries the SAME shared alignment class (parity across the active section and history)", async () => {
    const plan: PlanFixture = {
      planId: 203,
      cr: "CR-ALIGN-HIST-1",
      projectKey: "proj-align-hist-1",
      status: "closed",
      wave: "1",
      track: "track-1",
      merge: { commit: "align001" },
      cycles: [
        {
          id: 1003,
          label: "schema groundwork",
          status: "done",
          activatedAt: ACTIVATED_AT,
          doneAt: ACTIVATED_AT + 441_000,
        },
      ],
    };
    setSystemTime(ACTIVATED_AT + 1_000_000);
    await mountApp({
      pathname: "/p/proj-align-hist-1",
      projects: [project({ key: "proj-align-hist-1", name: "Align History Project" })],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ALIGN-HIST-1"]',
    );
    expect(crGroup).not.toBeNull();
    const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(groupToggle).not.toBeNull();
    groupToggle!.click();
    await settle();

    const row = cycleRowFor(crGroup!, "lens-cycle-row", "schema groundwork");
    const timer = row.querySelector<HTMLElement>('[data-testid="cycle-timer"]');
    expect(timer).not.toBeNull();
    const tokens = new Set((timer!.className ?? "").split(/\s+/).filter(Boolean));
    expect(tokens.has("app-cycle-timer-slot")).toBe(true);
    expect(tokens.has("app-cycle-timer-sealed")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ORCHESTRATOR PIN (live-review, same §S6 item-2 aligned-timers scope,
// mid-cycle-19 correction) — a user screenshot showed the ember timer badge
// DISTORTING at narrow widths: its text wraps onto two lines ("246m" /
// "56s") and the pill squishes into a blob. Cycle-timer badges (both the
// ACTIVE ember form and the sealed dim form) must never wrap.
//
// happy-dom performs no real layout (no true visual line-wrapping to
// observe), so the primary, genuinely-failing-today pin is a STYLES.CSS
// SOURCE assertion — the exact technique tests/f13-fidelity.test.ts's §S6 #7
// GLYPH-ONLY-coloring block already uses (`ruleBody` regex over the real
// stylesheet). Today neither `.app-cycle-timer-ember` nor
// `.app-cycle-timer-sealed` declares `white-space: nowrap` anywhere in
// public/styles.css (confirmed: the only existing `white-space: nowrap`
// rules in the file are `.app-hidden-data` and unrelated selectors) — this
// fails against CURRENT production. The DOM-level guard alongside it is a
// bound/regression check (not independently RED-failing under happy-dom's
// no-layout model, same caveat this file's own "ITEM 4" note above
// documents): it pins that GREEN's fix is a pure CSS property, never a
// manual `<br>`/embedded-newline workaround splitting the badge text.
describe("§S6 item 2 (aligned timers, orchestrator pin) — cycle-timer badges NEVER WRAP at narrow widths", () => {
  test("both the ACTIVE ember badge rule and the DONE sealed badge rule declare `white-space: nowrap` in styles.css (source-assertion technique)", () => {
    const emberRule = ruleBody(".app-cycle-timer-ember");
    expect(emberRule).toBeDefined();
    expect(emberRule ?? "").toMatch(/white-space\s*:\s*nowrap/);

    const sealedRule = ruleBody(".app-cycle-timer-sealed");
    expect(sealedRule).toBeDefined();
    expect(sealedRule ?? "").toMatch(/white-space\s*:\s*nowrap/);
  });

  test(
    "an ACTIVE cycle with a long label renders its ticking timer badge as ONE unbroken text node at a multi-hour-scale elapsed value ('246m 56s'-scale) — no <br>, no embedded newline, no split text nodes (bound: no manual line-break workaround)",
    async () => {
      const elapsedMs = 246 * 60_000 + 56_000; // 246m 56s — matches the reported screenshot scale.
      const longActivatedAt = ACTIVATED_AT - elapsedMs;
      const plan: PlanFixture = {
        planId: 211,
        cr: "CR-NOWRAP-1",
        projectKey: "proj-nowrap-1",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 1101,
            label:
              "an extremely long cycle label meant to squeeze the aligned timer column at narrow pane widths",
            status: "active",
            activatedAt: longActivatedAt,
          },
        ],
      };
      setSystemTime(ACTIVATED_AT);
      await mountApp({
        pathname: "/p/proj-nowrap-1",
        projects: [project({ key: "proj-nowrap-1", name: "Nowrap Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "an extremely long cycle label");
      const timer = row.querySelector<HTMLElement>('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();

      expect(timer!.querySelectorAll("br").length).toBe(0);
      const rawText = timer!.textContent ?? "";
      expect(rawText).not.toMatch(/[\n\r]/);
      expect(timer!.childNodes.length).toBe(1);
      expect(timer!.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
      expect(norm(rawText)).toBe("⏱ 246m 56s");
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
        projectKey: "proj-timer-hist-1",
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
        projectKey: "proj-timer-nots-1",
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
        projectKey: "proj-timer-nots-2",
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
        projectKey: "proj-timer-nots-3",
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

// ═══════════════════════════════════════════════════════════════════════
// PLAN CYCLE 18 — live-review DEFECT: "the timer is working but the badge
// is not getting live updated! Preferably the badge should be updated
// every 10 seconds." (user report, 2026-07-16, verbatim)
//
// Root cause: the GREEN-phase cycle-timer render (public/app.js) computes
// `Date.now() - activatedAt` only at RENDER time, and the app only
// re-renders when a poll/SSE tick observes CHANGED fetched data. With no
// new data flowing — the common steady-state case, e.g. a long-running
// cycle sitting between poll ticks with nothing else changing on the
// project — `Date.now()` is never recomputed and the on-screen badge
// freezes, even though §S3 requires the elapsed time to be "visibly
// updating while it runs".
//
// Every test ABOVE this line only ever observes a "tick" by tearing down
// and re-mounting under a NEW injected `setSystemTime()` value (a fresh
// render each time) — never by holding ONE mount open across real elapsed
// time with the fetch mock returning UNCHANGED data. That is exactly why
// the existing suite is green today even though the live UI is frozen: it
// never actually exercises "does the SAME mounted badge move on its own".
// The tests below close that gap.
//
// ── SELF-TICK TECHNIQUE FINDING (this RED session) ────────────────────
// Per the dispatch brief, bun's fake-timer API was checked FIRST, before
// falling back to a real wait:
//   - `bun:test` DOES expose `jest.useFakeTimers()` / `jest.advanceTimersByTime()`
//     (node_modules/bun-types/test.d.ts:98-104), and a throwaway probe
//     confirmed it correctly advances a plain `setInterval` — including one
//     registered on `globalThis` AFTER `GlobalRegistrator.register()` — with
//     zero real wall-clock wait, and that `Date.now()` itself moves under
//     `advanceTimersByTime()`.
//   - However, wiring fake timers into THIS harness is not viable: the
//     shared `mountApp()`/`settle()` helper (used by every test in this
//     file, matching `tests/f13-fidelity.test.ts` / `tests/workflow-lens.test.ts`)
//     flushes van-x's rendering pipeline via REAL `await new Promise((r) =>
//     setTimeout(r, 20))` loops. A second probe reproduced that exact shape
//     under `jest.useFakeTimers()` and it hung indefinitely (killed by an
//     external 15s timeout, never resolving): once fake timers are
//     installed, ALL `setTimeout` calls become fake — including the
//     harness's own flush loop — and nothing outside that `await` chain is
//     free to call `advanceTimersByTime()` to unblock it, because the test
//     is synchronously blocked awaiting `mountApp()` itself.
//   - Enabling fake timers only AFTER `mountApp()` resolves does not help
//     either: `jest.useFakeTimers()` does not retroactively intercept a
//     `setInterval` handle that a real-timer mount already created — it only
//     fakes timer calls made AFTER installation.
//   - Conclusion: no clock-injection technique is available that both (a)
//     drives the real production render path through the existing,
//     precedented `mountApp` harness and (b) deterministically advances an
//     internal ticker without a real wait. The tests below use a BOUNDED
//     REAL wall-clock wait instead — the same technique already established
//     in this repo by `tests/agent-runtime-pane.test.ts`'s `waitForPollTick`
//     (a real `setTimeout` wait bracketing the production poll interval) —
//     scaled to the user-reported "every 10 seconds" cadence, with a
//     generous per-test timeout.
//
// All elapsed offsets below are chosen to keep the rendered minutes
// component >= 1 throughout (this file's own FORMAT FINDING above notes the
// zero-minute case is not a contract pinned anywhere in this suite), so a
// `parseTimerMs` mismatch here can only mean a genuine ticking failure, not
// an untested zero-minute formatting edge case.

/** Parses the pinned `⏱ <m>m <ss>s` (zero-padded seconds) format back to ms. */
function parseTimerMs(text: string): number {
  const m = /^⏱\s+(\d+)m\s+(\d{2})s$/.exec(text.trim());
  expect(m).not.toBeNull();
  const minutes = Number(m![1]);
  const seconds = Number(m![2]);
  return minutes * 60_000 + seconds * 1_000;
}

describe("§S3 — LIVE-REVIEW DEFECT (cycle 18): the badge self-ticks without new poll/SSE data", () => {
  test(
    "an ACTIVE cycle's cycle-timer badge advances on its own, across a real >=10s wait, on the SAME mount with UNCHANGED fetch data (no remount, no fixture mutation)",
    async () => {
      const activatedAt = Date.now() - 62_000; // real clock, ~1m 02s elapsed at mount
      const plan: PlanFixture = {
        planId: 101,
        cr: "CR-TIMER-LIVE-1",
        projectKey: "proj-timer-live-1",
        status: "open",
        wave: "1",
        cycles: [{ id: 901, label: "compile fallback", status: "active", activatedAt }],
      };
      await mountApp({
        pathname: "/p/proj-timer-live-1",
        projects: [project({ key: "proj-timer-live-1", name: "Live Tick Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const rowBefore = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerBefore = rowBefore.querySelector('[data-testid="cycle-timer"]');
      expect(timerBefore).not.toBeNull();
      const msBefore = parseTimerMs(norm(timerBefore!.textContent));

      // Real wall-clock wait, comfortably past the user-requested 10s
      // cadence, with NO change to the plan/fixture and NO remount — the
      // mocked fetch keeps returning the identical `activatedAt` every poll.
      // If the badge only recomputes `Date.now()` at render time and only
      // re-renders on a data-changing poll (today's bug), this observes the
      // SAME frozen text.
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await settle();

      const rowAfter = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerAfter = rowAfter.querySelector('[data-testid="cycle-timer"]');
      expect(timerAfter).not.toBeNull();
      const msAfter = parseTimerMs(norm(timerAfter!.textContent));

      // Self-ticking: elapsed time advanced by roughly the real wait, purely
      // from the wall clock passing — never from a data change (the fixture
      // object was never mutated).
      expect(msAfter).toBeGreaterThan(msBefore);
      expect(msAfter - msBefore).toBeGreaterThanOrEqual(9_000);
    },
    20_000,
  );

  test(
    "the self-tick cadence is <=10s: TWO consecutive real waits of ~10.7s each (same mount, unchanged data) EACH show a further advance — not one eventual catch-up jump after a long wait",
    async () => {
      const activatedAt = Date.now() - 65_000; // ~1m 05s elapsed at mount
      const plan: PlanFixture = {
        planId: 102,
        cr: "CR-TIMER-LIVE-2",
        projectKey: "proj-timer-live-2",
        status: "open",
        wave: "1",
        cycles: [{ id: 902, label: "compile fallback", status: "active", activatedAt }],
      };
      await mountApp({
        pathname: "/p/proj-timer-live-2",
        projects: [project({ key: "proj-timer-live-2", name: "Live Tick Cadence Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const readMs = (): number => {
        const row = cycleRowFor(active(), "cycle-row", "compile fallback");
        const timer = row.querySelector('[data-testid="cycle-timer"]');
        expect(timer).not.toBeNull();
        return parseTimerMs(norm(timer!.textContent));
      };

      const msSample0 = readMs();

      // Window 1 — a hair over 10s, matching the user's "every 10 seconds"
      // cadence request (a CADENCE bound, not merely an eventual-freshness
      // bound).
      await new Promise((resolve) => setTimeout(resolve, 10_700));
      await settle();
      const msSample1 = readMs();
      expect(msSample1).toBeGreaterThan(msSample0);
      expect(msSample1 - msSample0).toBeGreaterThanOrEqual(9_000);
      expect(msSample1 - msSample0).toBeLessThanOrEqual(15_000);

      // Window 2 — a SECOND ~10s-scale window also shows a further advance,
      // pinning ONGOING cadence rather than a single one-off catch-up tick.
      await new Promise((resolve) => setTimeout(resolve, 10_700));
      await settle();
      const msSample2 = readMs();
      expect(msSample2).toBeGreaterThan(msSample1);
      expect(msSample2 - msSample1).toBeGreaterThanOrEqual(9_000);
      expect(msSample2 - msSample1).toBeLessThanOrEqual(15_000);
    },
    35_000,
  );
});

describe("§S3 — LIVE-REVIEW DEFECT (cycle 18): sealed rows never tick even across a real wait", () => {
  test(
    "a DONE cycle's sealed cycle-timer text is UNCHANGED across an >=10s real wall-clock wait on the SAME mount (no re-seal, no drift)",
    async () => {
      const activatedAt = Date.now() - 800_000;
      const doneAt = activatedAt + 760_000; // 12m 40s sealed span
      const plan: PlanFixture = {
        planId: 103,
        cr: "CR-TIMER-LIVE-3",
        projectKey: "proj-timer-live-3",
        status: "open",
        wave: "1",
        cycles: [{ id: 903, label: "compile fallback", status: "done", activatedAt, doneAt }],
      };
      await mountApp({
        pathname: "/p/proj-timer-live-3",
        projects: [project({ key: "proj-timer-live-3", name: "Sealed Live Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const rowBefore = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerBefore = rowBefore.querySelector('[data-testid="cycle-timer"]');
      expect(timerBefore).not.toBeNull();
      const textBefore = norm(timerBefore!.textContent);
      expect(textBefore).toBe("⏱ 12m 40s");

      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await settle();

      const rowAfter = cycleRowFor(active(), "cycle-row", "compile fallback");
      const timerAfter = rowAfter.querySelector('[data-testid="cycle-timer"]');
      expect(timerAfter).not.toBeNull();
      const textAfter = norm(timerAfter!.textContent);
      expect(textAfter).toBe(textBefore);
      expect(textAfter).toBe("⏱ 12m 40s");
    },
    20_000,
  );
});

// ── ITEM 4 (unmount/pane-swap clears the interval) — DEFERRED, not RED-valid ──
// The dispatch brief allows skipping this item "if happy-dom can't observe
// it" — but happy-dom is NOT the blocker here. A throwaway probe confirmed
// `spyOn(globalThis, "setInterval")` / `spyOn(globalThis, "clearInterval")`
// installed AFTER `GlobalRegistrator.register()` correctly survive the
// registration and accurately count real calls in this exact harness.
// The actual blocker: TODAY (pre-GREEN, this RED phase) there is NO
// cycle-timer interval of any kind — mounting a plan with an active timered
// cycle and mounting one without create the IDENTICAL set of app-wide
// intervals (the existing poll timer + watchdog timer, public/app.js:174 /
// :2295), so a "no NEW interval leaks past teardown" assertion would be
// vacuously true (0 new intervals created, 0 to leak) against the CURRENT
// no-op state. Per the RED self-check rule ("would this pass against a
// no-op stub?") that disqualifies it as a RED assertion. Whether GREEN even
// needs a DEDICATED per-row interval (vs. piggybacking the existing 5s
// poll/watchdog cadence to recompute the badge) is exactly the
// implementation choice GREEN has yet to make — pinning a specific
// interval-count contract now would presume that choice rather than
// specify required behavior. This is left as a GREEN-phase regression
// follow-up: once a ticker mechanism exists to potentially leak an
// interval, assert (via the spy technique confirmed feasible above) that
// mounting a plan with an active timered cycle creates no more NEW
// `setInterval` handles than are `clearInterval`'d by the time the pane is
// torn down / swapped away from.

// ── CR-CRU-023 §S3 (a) — ACTIVE-TIMER RESTART SEMANTICS: epoch coexistence ──
// (cycle 22, RED). User-sanctioned outcome (a): "resume from the old
// setpoint — accumulate active time in server-up epochs (persist
// accumulated `activeMs` per active cycle; on service restart resume the
// count, excluding downtime)". The server/store side of this contract
// (persisted `activeMs`, restart-resume-excludes-downtime) is pinned in
// tests/cycle-epochs.test.ts; THIS block pins the UI-CONSUMER side of the
// SAME contract: once the server feeds an additive `activeMs` on the cycle
// payload, the ACTIVE ticking badge must derive its value from THAT field —
// never from client-side `Date.now() - activatedAt`, which is exactly the
// "wall-clock-since-activation" behavior option (a) REJECTS (it is what
// produced the reported "246m on a cycle that had minutes of real
// attention" defect after a power outage). Sealed (done) rows are
// UNCHANGED by this feature — they keep the existing `doneAt - activatedAt`
// contract regardless of any (possibly stale) `activeMs` on the fixture.
describe("§S3 (a) — CR-CRU-023: ACTIVE badge derives from server-fed activeMs, not client wall-since-activatedAt", () => {
  test(
    "an ACTIVE cycle with a STALE activatedAt (4h before 'now') but a SMALL server-fed activeMs (5m 03s) renders the activeMs-scale badge, not the activatedAt-scale one",
    async () => {
      const nowA = ACTIVATED_AT + 10_000_000; // arbitrary fixed "now", independent of activatedAt below
      const oldActivatedAt = nowA - 4 * 3_600_000; // 4 hours before "now"
      const plan: PlanFixture = {
        planId: 301,
        cr: "CR-EPOCH-UI-1",
        projectKey: "proj-epoch-ui-1",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 2001,
            label: "long-running epoch cycle",
            status: "active",
            activatedAt: oldActivatedAt,
            activeMs: 303_000, // 5m 03s — server-accumulated attention time.
          },
        ],
      };
      setSystemTime(nowA);
      await mountApp({
        pathname: "/p/proj-epoch-ui-1",
        projects: [project({ key: "proj-epoch-ui-1", name: "Epoch UI Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "long-running epoch cycle");
      const timer = row.querySelector('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();
      const text = norm(timer!.textContent);

      // The activeMs-scale value — NOT the activatedAt-scale one (which
      // would read "⏱ 240m 03s": 4h + 5m03s of wall-clock-since-activation,
      // today's behavior since production has no notion of `activeMs` yet).
      expect(text).toBe("⏱ 5m 03s");
      expect(text).not.toBe("⏱ 240m 03s");
    },
  );

  test(
    "an ACTIVE cycle's badge, server-fed with a SMALL activeMs against a STALE activatedAt, ticks FORWARD from the activeMs baseline over a real >=10s wait (the existing self-tick cadence) — never jumps to the activatedAt-scale value",
    async () => {
      const oldActivatedAt = Date.now() - 4 * 3_600_000; // real 4h ago
      const plan: PlanFixture = {
        planId: 302,
        cr: "CR-EPOCH-UI-2",
        projectKey: "proj-epoch-ui-2",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 2002,
            label: "long-running epoch cycle",
            status: "active",
            activatedAt: oldActivatedAt,
            activeMs: 305_000, // 5m 05s baseline fed by the "server" at mount time.
          },
        ],
      };
      await mountApp({
        pathname: "/p/proj-epoch-ui-2",
        projects: [project({ key: "proj-epoch-ui-2", name: "Epoch UI Ticking Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const rowBefore = cycleRowFor(active(), "cycle-row", "long-running epoch cycle");
      const timerBefore = rowBefore.querySelector('[data-testid="cycle-timer"]');
      expect(timerBefore).not.toBeNull();
      const msBefore = parseTimerMs(norm(timerBefore!.textContent));

      // Anchored to the activeMs baseline, NOT the stale activatedAt (which
      // would read ~4h == 240m-scale, i.e. >= 14_400_000ms).
      expect(msBefore).toBeGreaterThanOrEqual(300_000);
      expect(msBefore).toBeLessThan(320_000);

      // Bounded real wall-clock wait — the SAME technique (and rationale,
      // documented above at "§S3 — LIVE-REVIEW DEFECT (cycle 18)") already
      // established in this file for the self-ticking badge; fake timers
      // hang this exact mountApp/settle harness (see that section's note).
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await settle();

      const rowAfter = cycleRowFor(active(), "cycle-row", "long-running epoch cycle");
      const timerAfter = rowAfter.querySelector('[data-testid="cycle-timer"]');
      expect(timerAfter).not.toBeNull();
      const msAfter = parseTimerMs(norm(timerAfter!.textContent));

      expect(msAfter).toBeGreaterThan(msBefore);
      expect(msAfter - msBefore).toBeGreaterThanOrEqual(9_000);
      expect(msAfter - msBefore).toBeLessThanOrEqual(15_000);
      // Bound — still nowhere near the activatedAt-scale value (~240m).
      expect(msAfter).toBeLessThan(320_000 + 15_000);
    },
    20_000,
  );

  // Coexistence bound (per §S3 AC: "Sealed history rows keep `doneAt −
  // activatedAt` untouched either way"). NOTE (RED self-check, same
  // disclosure convention as this file's other bound-only assertions, e.g.
  // the §S6 item-2 nowrap DOM-level guard above): this assertion already
  // PASSES against TODAY's pre-GREEN code too, since production currently
  // has no notion of `activeMs` at all and a done row's badge is computed
  // purely from `doneAt - activatedAt` regardless. It is included here as a
  // REGRESSION bound so GREEN cannot wire `activeMs` in a way that lets it
  // leak into (or override) the sealed-row computation; the independently
  // failing pin for this feature is the two ACTIVE-row tests above.
  test(
    "a DONE cycle's sealed badge ignores a (stale) activeMs field entirely — it stays exactly doneAt - activatedAt, coexisting with the epochs feature",
    async () => {
      const plan: PlanFixture = {
        planId: 303,
        cr: "CR-EPOCH-UI-3",
        projectKey: "proj-epoch-ui-3",
        status: "open",
        wave: "1",
        cycles: [
          {
            id: 2003,
            label: "sealed epoch cycle",
            status: "done",
            activatedAt: ACTIVATED_AT,
            doneAt: ACTIVATED_AT + 760_000, // 12m 40s sealed span
            activeMs: 999_000, // stale/irrelevant once sealed — must be ignored (would render "16m 39s" if it leaked through).
          },
        ],
      };
      setSystemTime(ACTIVATED_AT + 5_000_000);
      await mountApp({
        pathname: "/p/proj-epoch-ui-3",
        projects: [project({ key: "proj-epoch-ui-3", name: "Epoch UI Sealed Project" })],
        plans: [plan],
      });
      await openWorkflowTab();

      const row = cycleRowFor(active(), "cycle-row", "sealed epoch cycle");
      const timer = row.querySelector('[data-testid="cycle-timer"]');
      expect(timer).not.toBeNull();
      expect(norm(timer!.textContent)).toBe("⏱ 12m 40s");
      expect(norm(timer!.textContent)).not.toBe("⏱ 16m 39s");
    },
  );
});
