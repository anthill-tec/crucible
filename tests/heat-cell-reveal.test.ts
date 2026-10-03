// CR-CRU-159 C1 — heat-strip reveal: plain/non-spec Density runs (home
// mount). Same happy-dom harness pattern as tests/density.test.ts /
// tests/drill-in.test.ts: real production public/app.js, real
// public/app-logic.mjs, real VanJS/VanX vendor bundles; `fetch` is scripted.
//
// RED phase: expected to fail against the CURRENT public/app.js `HeatCell`
// / `SynthHeatCell` handlers (CR-CRU-159's own Gap analysis, "Found
// 2026-09-27"), which move the suite's virtualisation window, open a
// failure's group and focus it, but never call `scrollIntoView` and never
// add the shared `app-locate-blink` class (`locateBlink`) — every assertion
// below that checks for the reveal (the scroll + the blink) fails against
// today's code for exactly that missing behaviour. The digest-window test
// additionally fails because `HeatCell`'s window-set math uses the clicked
// leaf's RAW index into `suiteLeaves`, not its index in the DIGESTED entry
// list `SuiteLeafList` actually windows over (`L.digestFailures`), so a
// digest group ahead of the target can push it outside the mounted window
// (G4 in the CR's Gap analysis).
//
// Contract this file defines for GREEN (identifiers verbatim):
//   - a loaded suite's heat cell (green or red) calls `scrollIntoView()` on
//     its leaf-row (`[data-leaf-key]`) and the row carries `app-locate-blink`.
//   - every `[data-testid="suite-row"]` — loaded or still collapsed, plain
//     run or spec run — carries `data-suite-key` (today only spec runs do).
//   - a green synthetic cell of a collapsed suite expands AND blinks the
//     suite's own row; a red synthetic cell blinks the suite's first failing
//     leaf row (whose failure box already opens today — only the blink is new).
//   - a digest group ahead of the target in a >120-entry (digested) suite
//     does not keep the target's row out of the mounted virtualised window.
//   - the blink is held as STATE: it survives the whole-body rebuild a
//     suite-window-changing pane scroll causes, and is cleared (by a real
//     10s timer, flushed by hand here) after exactly 10s.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

interface FailureFixture {
  message: string;
}
interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree: SuiteFixture[];
}
interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
}
interface MountOpts {
  pathname?: string;
  projects?: unknown[];
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** Same mountApp harness pattern as tests/density.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`heat-cell-reveal.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = detail.tree.find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = detail.tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects ?? [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`heat-cell-reveal.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?heatCellReveal=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 6): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

async function mountAtRunCold(eventId: string, detail: EventDetailFixture, brief: EventBriefFixture): Promise<void> {
  await mountApp({
    pathname: `/run/${eventId}`,
    projects: [],
    events: [brief],
    eventDetails: { [eventId]: detail },
  });
}

function briefOf(detail: EventDetailFixture): EventBriefFixture {
  const c = suiteCounts(detail.tree.flatMap((s) => s.children));
  return {
    id: detail.id,
    projectKey: detail.projectKey,
    agentId: detail.agentId,
    kind: "test",
    tier: detail.tier,
    codec: detail.codec,
    timestamp: detail.timestamp,
    total: c.passed + c.failed + c.pending,
    passed: c.passed,
    failed: c.failed,
    pending: c.pending,
    duration_ms: 500,
    hasCoverage: false,
  };
}

/** §S1 AC1/AC6 — a single suite of `total` leaves with a named passing leaf
 *  and a named failing leaf (a UNIQUE failure message, so Density never
 *  digests it) planted at the given 0-based positions; every other leaf
 *  passes. A large `total` makes the suite's own virtualized leaf list, once
 *  loaded, tall enough that a mid-list target sits below the VIRT_WINDOW's
 *  mounted range without any extra filler content. */
function targetedSuite(
  suiteName: string,
  total: number,
  green: { name: string; position: number },
  red: { name: string; position: number },
): SuiteFixture {
  const children: LeafFixture[] = [];
  for (let i = 0; i < total; i++) {
    if (i === green.position) {
      children.push({ name: green.name, status: "pass", duration_ms: 5 });
    } else if (i === red.position) {
      children.push({ name: red.name, status: "fail", duration_ms: 5, failure: { message: `${red.name}-failure` } });
    } else {
      children.push({ name: `${suiteName}-filler-${i}`, status: "pass", duration_ms: 5 });
    }
  }
  return { name: suiteName, status: "fail", children };
}

/** §S1 G4/AC4 — a suite whose DENSITY ENTRIES exceed VIRT_WINDOW (120) once a
 *  `groupSize`-leaf identical-failure group collapses to ONE digest entry. */
function digestWindowSuite(suiteName: string, groupSize: number, targetName: string, trailing: number): SuiteFixture {
  const children: LeafFixture[] = [];
  for (let i = 0; i < groupSize; i++) {
    children.push({
      name: `${suiteName}-dup${i}`,
      status: "fail",
      duration_ms: 5,
      failure: { message: "shared-digest-failure" },
    });
  }
  children.push({ name: targetName, status: "pass", duration_ms: 5 });
  for (let i = 0; i < trailing; i++) {
    children.push({ name: `${suiteName}-trail${i}`, status: "pass", duration_ms: 5 });
  }
  return { name: suiteName, status: "fail", children };
}

function interceptScrollIntoView(): { calls: HTMLElement[]; restore: () => void } {
  const calls: HTMLElement[] = [];
  const original = (
    HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
  ).scrollIntoView;
  (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
    function (this: HTMLElement) {
      calls.push(this);
    };
  return {
    calls,
    restore: () => {
      (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
        original;
    },
  };
}

/** Mirrors tests/cycle-run-navigation.test.ts's 10s-blink-flush pattern:
 *  intercept `setTimeout(fn, 10_000)` calls and flush them by hand — never a
 *  real 10s sleep. */
function interceptBlinkTimer(): {
  pending: Array<() => void>;
  restore: () => void;
} {
  const original = globalThis.setTimeout;
  const pending: Array<() => void> = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 10_000) {
      pending.push(() => fn(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return original(fn as TimerHandler, delay as number | undefined, ...args);
  }) as typeof setTimeout;
  return {
    pending,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

// ── §S1 AC1 — a loaded suite's heat cell (green, and red) ──────────────────

describe("§S1 AC1 — a loaded suite's heat cell scrolls + blinks its leaf row", () => {
  test("a green (passing) leaf's heat cell calls scrollIntoView on its leaf-row and the row carries app-locate-blink", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac1-green";
    const suite = targetedSuite(
      "SuiteLoadedGreen",
      200,
      { name: "leaf-green-target", position: 100 },
      { name: "leaf-red-target", position: 150 },
    );
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac1",
      agentId: "heat-ac1-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [suite],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteLoadedGreen");
    expect(suiteRow).toBeDefined();
    suiteRow!.click();
    await settle();

    const cell = overlay.querySelector('[title="SuiteLoadedGreen › leaf-green-target"]') as HTMLElement | null;
    expect(cell).not.toBeNull();

    const { calls: scrollCalls, restore } = interceptScrollIntoView();
    try {
      cell!.click();
      await settle();

      const row = overlay.querySelector('[data-leaf-key="SuiteLoadedGreen::leaf-green-target"]');
      expect(row).not.toBeNull();
      expect(scrollCalls).toContain(row as HTMLElement);
      expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);
    } finally {
      restore();
    }
  });

  test("a red (failing) leaf's heat cell calls scrollIntoView on its leaf-row, the row carries app-locate-blink, and its failure box is visible", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac1-red";
    const suite = targetedSuite(
      "SuiteLoadedRed",
      200,
      { name: "leaf-green-target", position: 100 },
      { name: "leaf-red-target", position: 150 },
    );
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac1",
      agentId: "heat-ac1-agent-2",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [suite],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteLoadedRed");
    expect(suiteRow).toBeDefined();
    suiteRow!.click();
    await settle();

    const cell = overlay.querySelector('[title="SuiteLoadedRed › leaf-red-target"]') as HTMLElement | null;
    expect(cell).not.toBeNull();

    const { calls: scrollCalls, restore } = interceptScrollIntoView();
    try {
      cell!.click();
      await settle();

      const row = overlay.querySelector('[data-leaf-key="SuiteLoadedRed::leaf-red-target"]');
      expect(row).not.toBeNull();
      expect(scrollCalls).toContain(row as HTMLElement);
      expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

      const failureBox = overlay.querySelector('[data-testid="failure-box"]');
      expect(failureBox).not.toBeNull();
      expect(failureBox!.textContent ?? "").toContain("leaf-red-target-failure");
    } finally {
      restore();
    }
  });
});

// ── §S1 G6 — every suite row carries data-suite-key, spec or plain ─────────

describe("§S1 G6 — every suite row carries data-suite-key, not only spec runs", () => {
  test("a plain (non-spec) run's suite-row already carries data-suite-key on mount, before any load", async () => {
    const now = Date.now();
    const eventId = "evt-heat-g6-key";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-g6",
      agentId: "heat-g6-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [
        {
          name: "SuiteKeyPlain",
          status: "pass",
          children: [{ name: "k1", status: "pass", duration_ms: 5 }],
        },
      ],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteKeyPlain") as HTMLElement | undefined;
    expect(suiteRow).toBeDefined();
    expect(suiteRow!.getAttribute("data-suite-key")).toBe("SuiteKeyPlain");
  });
});

// ── §S1 AC2 — a synthetic cell of a collapsed suite ─────────────────────────

describe("§S1 AC2 — a synthetic cell of a collapsed suite", () => {
  test("a green synthetic cell loads the suite, blinks its (now-expanded) own row, and the row carries data-suite-key", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac2-green";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac2",
      agentId: "heat-ac2-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [
        {
          name: "SynthGreenSuite",
          status: "pass",
          children: [
            { name: "SynthGreenSuite-p1", status: "pass", duration_ms: 5 },
            { name: "SynthGreenSuite-p2", status: "pass", duration_ms: 5 },
          ],
        },
      ],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    // Still collapsed: a SynthHeatCell, not an identity-bearing HeatCell.
    const cell = overlay.querySelector('.app-heat-pass[title="SynthGreenSuite"]') as HTMLElement | null;
    expect(cell).not.toBeNull();

    cell!.click();
    await settle();

    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SynthGreenSuite") as HTMLElement | undefined;
    expect(suiteRow).toBeDefined();
    expect(suiteRow!.querySelector('[data-testid="tree-toggle"]')!.textContent?.trim()).toBe("▾");
    expect(suiteRow!.getAttribute("data-suite-key")).toBe("SynthGreenSuite");
    expect(suiteRow!.classList.contains("app-locate-blink")).toBe(true);
  });

  test("a red synthetic cell loads the suite and blinks its first failing leaf row, whose failure box is visible", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac2-red";
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac2",
      agentId: "heat-ac2-agent-2",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [
        {
          name: "SynthRedSuite",
          status: "fail",
          children: [
            { name: "SynthRedSuite-p1", status: "pass", duration_ms: 5 },
            {
              name: "synth-red-leaf",
              status: "fail",
              duration_ms: 5,
              failure: { message: "synth-red-leaf-failure" },
            },
          ],
        },
      ],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const cell = overlay.querySelector('.app-heat-fail[title="SynthRedSuite"]') as HTMLElement | null;
    expect(cell).not.toBeNull();

    cell!.click();
    await settle();

    const row = overlay.querySelector('[data-leaf-key="SynthRedSuite::synth-red-leaf"]');
    expect(row).not.toBeNull();
    expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

    const failureBox = overlay.querySelector('[data-testid="failure-box"]');
    expect(failureBox).not.toBeNull();
    expect(failureBox!.textContent ?? "").toContain("synth-red-leaf-failure");
  });
});

// ── §S1 G4/AC4 — a digest group before the target in a >120-entry suite ────

describe("§S1 G4/AC4 — a digest group before the target in a >120-entry (digested) suite", () => {
  test("a 70-failure digest group ahead of the target in a 271-leaf suite (202 digested entries) does not keep the target's row out of the mounted window", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac4-window";
    const suite = digestWindowSuite("WindowFixSuite", 70, "window-fix-target", 200);
    expect(suite.children.length).toBe(271);
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac4",
      agentId: "heat-ac4-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [suite],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "WindowFixSuite");
    expect(suiteRow).toBeDefined();
    suiteRow!.click();
    await settle();

    const cell = overlay.querySelector('[title="WindowFixSuite › window-fix-target"]') as HTMLElement | null;
    expect(cell).not.toBeNull();

    cell!.click();
    await settle();

    // The G4 bug: HeatCell windows off the leaf's RAW index (70) rather than
    // its DIGESTED entry index (1, right after the collapsed 70-leaf group),
    // so today's window (entries[10,130)) excludes entry 1 and this row never
    // mounts at all.
    const row = overlay.querySelector('[data-leaf-key="WindowFixSuite::window-fix-target"]');
    expect(row).not.toBeNull();
    expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);
  });
});

// ── §S1 G2/AC5 — the blink is state: it survives the rebuild, clears at 10s ─

describe("§S1 G2/AC5 — the blink survives a suite-window-changing rebuild, and clears after exactly 10s", () => {
  test("clicking a loaded leaf's heat cell blinks its row; a pane scroll that moves the suite's window rebuilds the whole body yet the SAME leaf's (freshly-rendered) row still carries the blink class; flushing the 10s timer then clears it", async () => {
    const now = Date.now();
    const eventId = "evt-heat-ac5-blink";
    const children: LeafFixture[] = [];
    for (let i = 0; i < 150; i++) {
      children.push(
        i === 5
          ? { name: "blink-target", status: "pass", duration_ms: 5 }
          : { name: `SuiteBlink-filler-${i}`, status: "pass", duration_ms: 5 },
      );
    }
    const detail: EventDetailFixture = {
      id: eventId,
      projectKey: "proj-heat-ac5",
      agentId: "heat-ac5-agent",
      kind: "test",
      tier: "regression",
      codec: "junit",
      timestamp: now,
      tree: [{ name: "SuiteBlink", status: "pass", children }],
    };
    await mountAtRunCold(eventId, detail, briefOf(detail));

    const overlay = document.querySelector('[data-testid="run-overlay"]')!;
    const suiteRow = findByText(overlay, '[data-testid="suite-row"]', "SuiteBlink");
    expect(suiteRow).toBeDefined();
    suiteRow!.click();
    await settle();

    const { restore: restoreScroll } = interceptScrollIntoView();
    const { pending, restore: restoreTimer } = interceptBlinkTimer();
    try {
      const cell = overlay.querySelector('[title="SuiteBlink › blink-target"]') as HTMLElement | null;
      expect(cell).not.toBeNull();
      cell!.click();
      await settle();

      let row = overlay.querySelector('[data-leaf-key="SuiteBlink::blink-target"]');
      expect(row).not.toBeNull();
      expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);
      expect(pending.length).toBeGreaterThan(0);

      // Force the whole-body rebuild G2 describes: a pane scroll that moves
      // this suite's virtualisation window (`handlePaneScroll` writes a NEW
      // `suiteWindow.val[name]`, which `RunDetailBody`'s single body
      // derivation depends on and therefore rebuilds from). `blink-target`
      // sits at leaf index 5, still inside the new window (start index 3),
      // so it stays mounted — as a BRAND NEW DOM node.
      const scrollContainer = overlay.querySelector('[data-testid="pane-scroll"]') as HTMLElement;
      expect(scrollContainer).not.toBeNull();
      scrollContainer.scrollTop = 90; // floor(90/28) = 3
      scrollContainer.dispatchEvent(new Event("scroll"));
      await settle();

      row = overlay.querySelector('[data-leaf-key="SuiteBlink::blink-target"]');
      expect(row).not.toBeNull();
      expect((row as HTMLElement).classList.contains("app-locate-blink")).toBe(true);

      // Flush the 10s cleanup — a STATE-held blink clears regardless of which
      // DOM node currently renders the key; a naive classList-only
      // implementation would have lost the class at the rebuild above
      // already, and a leaked timer here would leave it stuck on forever.
      const toRun = pending.splice(0, pending.length);
      for (const cb of toRun) cb();
      await settle();

      const after = overlay.querySelector('[data-leaf-key="SuiteBlink::blink-target"]');
      expect(after).not.toBeNull();
      expect((after as HTMLElement).classList.contains("app-locate-blink")).toBe(false);
    } finally {
      restoreScroll();
      restoreTimer();
    }
  });
});
