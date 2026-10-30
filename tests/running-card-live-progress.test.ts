// The running card shows an open run's progress (CR-CRU-223 §S2, AC1; the
// card's half of AC5). Storyboard F25, option A:
//
//   CR-CRU-224-830-GREEN  unit                         3 ✗
//   ████████░░░░░░░░░░░░░░░░░░░░░░░░  (32 %)
//   412/1280 · <the fixture's currentFile>  ⏱ 0m 41s  › open
//
// When the open run's brief carries `live`, `RunningCard` (public/app.js)
// gains a progress bar at completed/total (clamped at 100 %, none without a
// total), `<completed>/<total>` or `<completed> done`, the current file
// (truncated on one line), `<failed> ✗` in the fail colour when failed > 0,
// and the timer as today — and it becomes clickable, opening /run/<runId>
// with the pointer cursor, its progress line ending, after the timer, in the
// faint `› open` hint F25 draws there. Without `live` it is today's card: no
// handler, no hint.
//
// Drives the REAL public/app.js through tests/helpers/live-run-harness.ts; the
// brief's `live` is fixture data on the events feed (a stubbed read — filling
// it is CR-CRU-200's).
//
// Testids this file names for the new parts of the card (the card's own is
// `running-card`, the timer's `running-elapsed`, both existing):
//   running-progress       the bar's track (absent without a total)
//   running-progress-fill  its fill, whose inline width is the percentage
//   running-count          `412/1280` or `412 done`
//   running-file           the current file
//   running-failed         `3 ✗` (absent when nothing has failed)
//   running-open-hint      `› open`, last on the progress line (absent without `live`)
import { describe, test, expect, afterEach } from "bun:test";
import {
  cascaded,
  cascadeOver,
  liveReads,
  mountLive,
  settle,
  truncatesOnOneLine,
  unmountLive,
  type LiveCounts,
  type LiveMountOpts,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-live-card";
const AGENT_ID = "CR-CRU-224-830-GREEN";
const RUN_ID = "run-0190aaaa-live-card-0001";

const F25_LIVE: LiveCounts = {
  completed: 412,
  total: 1280,
  passed: 409,
  failed: 3,
  pending: 0,
  currentFile: "test_relay.py",
};

function homeWithRun(live: LiveCounts | undefined): LiveMountOpts {
  return {
    pathname: "/",
    projects: [
      {
        key: PROJECT_KEY,
        name: "Live Card Project",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: Date.now(),
      },
    ],
    agents: [{ agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: Date.now(), message: "running" }],
    events: [],
    eventDetails: {},
    openRuns: [
      {
        runId: RUN_ID,
        projectKey: PROJECT_KEY,
        agentId: AGENT_ID,
        startedAt: Date.now() - 41_000,
        tier: "unit",
        ...(live !== undefined ? { live } : {}),
      },
    ],
    live: {},
  };
}

function theCard(): HTMLElement {
  const cards = document.querySelectorAll('[data-testid="running-card"]');
  expect(cards.length).toBe(1);
  return cards[0] as HTMLElement;
}

function part(card: HTMLElement, testid: string): HTMLElement | null {
  return card.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The bar fill's width, in percent, read off its inline style. */
function fillPercent(card: HTMLElement): number {
  const fill = part(card, "running-progress-fill");
  expect(fill).not.toBeNull();
  const width = fill!.style.width;
  expect(width.endsWith("%")).toBe(true);
  return Number.parseFloat(width);
}

describe("RunningCard with `live` — the open run's progress on one line beneath the agent id and tier", () => {
  test("412 of 1280 with 3 failures in test_relay.py: a bar at 32 %, `412/1280`, `test_relay.py`, `3 ✗` in the fail colour, the timer, and the pointer cursor", async () => {
    await mountLive(homeWithRun(F25_LIVE));
    const card = theCard();

    expect(part(card, "running-progress")).not.toBeNull();
    expect(Math.round(fillPercent(card))).toBe(32);
    expect(text(part(card, "running-count"))).toBe("412/1280");
    expect(text(part(card, "running-file"))).toBe("test_relay.py");
    const failed = part(card, "running-failed");
    expect(text(failed)).toBe("3 ✗");
    expect(cascaded(failed!, "color")).toContain("var(--fail)");
    // The timer, as today, still counting from the server's startedAt.
    expect(text(part(card, "running-elapsed"))).toMatch(/^⏱ \d+m \d{2}s$/);
    // The card still names the agent and its tier.
    expect(text(card)).toContain(AGENT_ID);
    expect(text(part(card, "tier-badge"))).toBe("unit");
    expect(cascaded(card, "cursor")).toBe("pointer");
  });

  test("clicking a card with `live` navigates to /run/<runId> — pushed as a history entry", async () => {
    const page = await mountLive(homeWithRun(F25_LIVE));
    theCard().click();
    await settle();

    expect(location.pathname).toBe(`/run/${RUN_ID}`);
    expect(page.pushed).toEqual([`/run/${RUN_ID}`]);
  });

  test("with no total the card reads `412 done` and draws NO bar", async () => {
    const noTotal: LiveCounts = { completed: 412, passed: 409, failed: 3, pending: 0, currentFile: "test_relay.py" };
    await mountLive(homeWithRun(noTotal));
    const card = theCard();

    expect(text(part(card, "running-count"))).toBe("412 done");
    expect(part(card, "running-progress")).toBeNull();
    expect(part(card, "running-progress-fill")).toBeNull();
    // Everything else on the line is still there.
    expect(text(part(card, "running-file"))).toBe("test_relay.py");
    expect(text(part(card, "running-failed"))).toBe("3 ✗");
  });

  test("with a total of 0 the card reads `412 done` and draws NO bar — a zero total is no total", async () => {
    await mountLive(homeWithRun({ ...F25_LIVE, total: 0 }));
    const card = theCard();

    expect(text(part(card, "running-count"))).toBe("412 done");
    expect(part(card, "running-progress")).toBeNull();
    expect(text(card)).not.toContain("412/0");
  });

  test("1300 finished of a stated 1280 draws a FULL bar, clamped at 100 %, and still reads `1300/1280`", async () => {
    await mountLive(homeWithRun({ ...F25_LIVE, completed: 1300, passed: 1297 }));
    const card = theCard();

    expect(fillPercent(card)).toBe(100);
    expect(text(part(card, "running-count"))).toBe("1300/1280");
  });

  test("with nothing failed there is NO failure count on the card, and no ✗ anywhere on it", async () => {
    await mountLive(homeWithRun({ ...F25_LIVE, passed: 412, failed: 0 }));
    const card = theCard();

    expect(part(card, "running-failed")).toBeNull();
    expect(text(card)).not.toContain("✗");
    // The rest of the progress line still renders.
    expect(text(part(card, "running-count"))).toBe("412/1280");
  });

  test("the current file truncates on one line (no wrap, clipped, ellipsis) however long it is", async () => {
    const longFile = `tests/${"very_long_directory_name/".repeat(8)}test_relay_with_a_long_name.py`;
    await mountLive(homeWithRun({ ...F25_LIVE, currentFile: longFile }));
    const file = part(theCard(), "running-file");

    expect(text(file)).toBe(longFile);
    expect(truncatesOnOneLine(file!)).toBe(true);
  });
});

describe("RunningCard WITHOUT `live` — today's card, unchanged, not clickable", () => {
  test("no bar, no count, no file, no failure count; `running…` and the timer as today; the default cursor", async () => {
    await mountLive(homeWithRun(undefined));
    const card = theCard();

    for (const testid of ["running-progress", "running-progress-fill", "running-count", "running-file", "running-failed"]) {
      expect(part(card, testid)).toBeNull();
    }
    expect(text(part(card, "running-label"))).toBe("running…");
    expect(text(part(card, "running-elapsed"))).toMatch(/^⏱ \d+m \d{2}s$/);
    expect(cascaded(card, "cursor")).toBe("default");
  });

  test("clicking it does nothing: no navigation, no history entry, no live read", async () => {
    const page = await mountLive(homeWithRun(undefined));
    theCard().click();
    await settle();

    expect(location.pathname).toBe("/");
    expect(page.pushed).toEqual([]);
    expect(liveReads(page.fetchLog, RUN_ID)).toEqual([]);
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
  });
});

describe("RunningCard's open hint — F25 option A ends a live card's progress line with a faint `› open`", () => {
  test("a card with `live` shows `› open` as the LAST thing on its progress line, straight after the timer, in the faint ink of the card's meta line", async () => {
    await mountLive(homeWithRun(F25_LIVE));
    const card = theCard();
    const hints = card.querySelectorAll('[data-testid="running-open-hint"]');
    expect(hints).toHaveLength(1);
    const hint = hints[0] as HTMLElement;

    expect(text(hint)).toBe("› open");
    // On the one progress line, with the count, the file and the timer…
    const elapsed = part(card, "running-elapsed");
    expect(elapsed).not.toBeNull();
    expect(hint.parentElement).toBe(elapsed!.parentElement);
    expect(hint.parentElement).toBe(part(card, "running-count")!.parentElement);
    // …directly after the timer, and nothing after it.
    expect(hint.previousElementSibling).toBe(elapsed);
    expect(hint.nextElementSibling).toBeNull();
    // F25 draws it as the timer's faint caption (`agent-ts`: --ink-faint).
    expect(cascaded(hint, "color")).toBe("var(--ink-faint)");
    // Exactly once on the card.
    expect(text(card).split("› open")).toHaveLength(2);
  });

  test("the hint shows on every live card — with no total and nothing failed it still ends the line after the timer", async () => {
    await mountLive(homeWithRun({ completed: 412, passed: 412, failed: 0, pending: 0, currentFile: "test_relay.py" }));
    const card = theCard();
    const hint = part(card, "running-open-hint");

    expect(text(hint)).toBe("› open");
    expect(hint!.previousElementSibling).toBe(part(card, "running-elapsed"));
    expect(hint!.nextElementSibling).toBeNull();
  });

  test("clicking the hint opens the live drill-in, as the card does", async () => {
    const page = await mountLive(homeWithRun(F25_LIVE));
    const hint = part(theCard(), "running-open-hint");
    expect(hint).not.toBeNull();
    hint!.click();
    await settle();

    expect(location.pathname).toBe(`/run/${RUN_ID}`);
    expect(page.pushed).toEqual([`/run/${RUN_ID}`]);
  });

  test("a card WITHOUT `live` has no open hint — it opens nothing, so it offers nothing", async () => {
    await mountLive(homeWithRun(undefined));
    const card = theCard();

    expect(part(card, "running-open-hint")).toBeNull();
    expect(text(card)).not.toContain("›");
    expect(text(card)).not.toContain("open");
    // Today's line is untouched: `running…` then the timer, and nothing after it.
    expect(part(card, "running-elapsed")!.previousElementSibling).toBe(part(card, "running-label"));
    expect(part(card, "running-elapsed")!.nextElementSibling).toBeNull();
  });
});

describe("the harness cascade fails loudly on a selector it cannot evaluate", () => {
  async function probe(): Promise<HTMLElement> {
    await mountLive(homeWithRun(undefined));
    const el = document.createElement("div");
    el.className = "probe";
    document.body.appendChild(el);
    return el;
  }

  test("a stylesheet whose rule for the asked property has an unparseable selector throws EVERY time it is asked of the same element, naming that selector — it never reads as `no match`", async () => {
    const el = await probe();
    const resolve = cascadeOver(".probe { color: red; }\n.probe[data-state { color: blue; }\n.probe:: { color: green; }");

    expect(() => resolve(el, "color")).toThrow(".probe[data-state");
    // happy-dom's Element.matches throws on an unparseable selector only the
    // first time an element is asked; the cascade must not go quiet after it.
    expect(() => resolve(el, "color")).toThrow("cannot evaluate 1 selector(s) declaring color");
    expect(() => resolve(el, "color")).toThrow(".probe[data-state");
  });

  test("a clean stylesheet resolves by the cascade, and an unparseable selector on ANOTHER property does not touch this one", async () => {
    const el = await probe();
    const clean = cascadeOver(".probe { color: red; }\n.other { color: blue; }\ndiv.probe { color: teal; }");
    expect(clean(el, "color")).toBe("teal");

    const elsewhere = cascadeOver(".probe { color: red; }\n.probe[data-state { cursor: pointer; }");
    expect(elsewhere(el, "color")).toBe("red");
    expect(() => elsewhere(el, "cursor")).toThrow(".probe[data-state");
  });
});
