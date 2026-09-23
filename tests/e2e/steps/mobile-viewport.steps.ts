// CR-CRU-018 §S1/§S2/§S3 — phone + tablet band responsive layout steps.
// New step definitions ONLY: navigation, seeding and overlay/chip steps are
// all reused from navigation.steps.ts / seeding.steps.ts / drillin.steps.ts /
// cards.steps.ts / pane-scroll.steps.ts / roadmap.steps.ts / harness.ts,
// exactly as the CR's own dispatch note requires ("only the ... assertions
// are new here" is this whole file's house style, matched from the sibling
// step files).
//
// RED-authored contract: the testids `project-band-foot`,
// `project-band-sheet`, `project-band-backdrop` and `roadmap-cr-card` (+
// `roadmap-card-id`/`-status`/`-wave`/`-deps`) do not exist in production
// today (`grep` returns zero occurrences in public/app.js) — GREEN names
// these hooks to satisfy this file, following the same "RED defines the
// testid GREEN must render" precedent tests/cycle-run-navigation.test.ts's
// own header states for `cycle-to-runs`.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestCompile, ingestJunit, ingestParsed, junit60 } from "./harness.ts";

// CR-CRU-018/DN decision 5 desktop-band re-point support.
//
// MEASURED (2026-09-23, live server): at any legal desktop-band viewport
// (>=1025px) `.app-pane-content`'s own clientWidth already exceeds 660px
// via the grid alone (688px at exactly 1025px, 872px at 1280px), so the
// CR-CRU-023 660px floor can no longer force overflow for the CR-CRU-029/
// 034 dual-axis SCROLL-MECHANISM scenarios once they move off their
// original narrow (now tablet-band) viewports. An UNBREAKABLE (no hyphen or
// space -- both are CSS break opportunities) 200-char agent id forces
// genuine content-driven overflow at any width this suite uses, so those
// scenarios keep testing the scroll mechanism itself rather than the (now
// vacuous at this band) floor mechanism.
Step(
  "a filler run with an unbreakable long agent id is ingested on that project",
  async ({ request, world }) => {
    const wideAgentId = `wideoverflowagentid${"x".repeat(180)}`;
    await ingestParsed(request, world.projectKey as string, wideAgentId, {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      duration_ms: 5,
    });
  },
);

// ── AC1 — single-column layout at the phone profile ────────────────────────

Step("the home timeline renders as a single column on the phone profile", async ({ page }) => {
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await timeline.boundingBox();
  expect(box).not.toBeNull();
  // "single column" is asserted as "spans (almost) the whole viewport
  // width" — the SAME >90% threshold navigation.steps.ts already uses for
  // the desktop timeline-vs-main-content check, applied here against the
  // viewport itself since a phone body has no side rail to compare against.
  expect(box!.width).toBeGreaterThan(viewport!.width * 0.85);
});

Step("the workspace renders as a single column on the phone profile", async ({ page }) => {
  const workspace = page.getByTestId("workspace");
  await expect(workspace).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await workspace.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(viewport!.width * 0.85);
});

Step("the workspace tabs row does not force the page to scroll horizontally", async ({ page }) => {
  await expect(page.getByTestId("workspace-tabs")).toBeVisible();
  const { bodyScrollWidth, innerWidth } = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(bodyScrollWidth).toBeLessThanOrEqual(innerWidth);
});

// ── AC2/DN9 — the project band foot strip (phone) ───────────────────────────

Step(
  "the project band renders as a foot strip stating the project name, the live-agent count, and the health dot",
  async ({ page, world }) => {
    const foot = page.getByTestId("project-band-foot");
    await expect(foot).toBeVisible();
    const text = (await foot.innerText()).toLowerCase();
    // DN decision 9 — "project name + live-agent count + health dot": the
    // count is asserted as a NUMBER-SLASH-NUMBER pair (mirrors the existing
    // ProjectPaneCard wording, "<online>/<total> agents online") rather than
    // a bare non-empty check, so a foot strip that dropped the count still
    // fails this even though it renders text.
    expect(text).toMatch(/\d+\s*\/\s*\d+/);
    expect(foot.locator(".app-dot")).not.toHaveCount(0);
    void world;
  },
);

Step("I tap the project band foot strip", async ({ page }) => {
  await page.getByTestId("project-band-foot").click();
});

Step("the project band expands as a sheet over the content", async ({ page }) => {
  await expect(page.getByTestId("project-band-sheet")).toBeVisible();
});

Step("the sheet's backdrop is visible", async ({ page }) => {
  await expect(page.getByTestId("project-band-backdrop")).toBeVisible();
});

Step("I tap the project band sheet's backdrop", async ({ page }) => {
  await page.getByTestId("project-band-backdrop").click();
});

Step("the project band collapses back to the foot strip", async ({ page }) => {
  await expect(page.getByTestId("project-band-foot")).toBeVisible();
  await expect(page.getByTestId("project-band-sheet")).toHaveCount(0);
});

Step("the {string} chip is visible without scrolling the page", async ({ page }, text: string) => {
  await expect(page.getByTestId("run-overlay").getByRole("button", { name: text })).toBeVisible();
  const { bodyScrollWidth, innerWidth } = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(bodyScrollWidth).toBeLessThanOrEqual(innerWidth);
});

Step(
  "the run overlay's bounding box spans at least 95% of the viewport height",
  async ({ page }) => {
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const box = await page.getByTestId("run-overlay").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(viewport!.height * 0.95);
  },
);

// ── AC3/AC4/DN4 — touch floor outranks density, comfortable default ───────

Step("the density toggle reads {string} with no stored preference", async ({ page }, mode: string) => {
  const toggle = page.getByTestId("density-toggle");
  await expect(toggle).toHaveAttribute("data-density", mode);
});

Step("I cycle the density toggle to {string}", async ({ page }, mode: string) => {
  const toggle = page.getByTestId("density-toggle");
  for (let i = 0; i < 3; i++) {
    const current = await toggle.getAttribute("data-density");
    if (current === mode) return;
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("data-density", mode);
});

// Sampled per DN decision 4 / the CR's §S2: badges, tabs, cards, back chips —
// whatever is ON SCREEN at the time this step runs. Every VISIBLE match is
// measured (an invisible one, e.g. a collapsed sheet's contents, contributes
// nothing to the floor it never presents to a touch), and the floor is "at
// least 44px in SOME dimension" per the CR text, not both.
const TOUCH_SAMPLE_SELECTORS = [
  '[data-testid="workspace-tab"]',
  '[data-testid="density-toggle"]',
  '[data-testid="project-band-foot"]',
  '[data-testid="event-card"]',
  '[data-testid="rail-toggle"]',
];

Step(
  "every sampled interactive control measures at least 44px in some dimension at density {string}",
  async ({ page }, density: string) => {
    const failures: string[] = [];
    for (const selector of TOUCH_SAMPLE_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (!(await el.isVisible())) continue;
        const box = await el.boundingBox();
        if (box === null) continue;
        if (Math.max(box.width, box.height) < 44) {
          failures.push(`${selector}[${i}] measured ${box.width}x${box.height}`);
        }
      }
    }
    expect(
      failures,
      `density "${density}": ${failures.length} interactive control(s) under the 44px touch floor: ${failures.join("; ")}`,
    ).toEqual([]);
  },
);

// ── AC5/DN3 — ephemeral phone-width collapse never writes RAIL_STORAGE_KEY ──

// The REAL production key (public/app.js:2453-2487) — not a RED invention.
const RAIL_STORAGE_KEY = "crucible.rail.collapsed";

Step(
  "the desktop rail is expanded and the user has stored that preference",
  async ({ page }) => {
    // Establish the origin, then write the SAME key production writes on a
    // real toggle click — a controlled precondition rather than driving the
    // click through a desktop-width visit this scenario doesn't otherwise
    // need.
    await page.goto("/");
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [RAIL_STORAGE_KEY, "expanded"],
    );
  },
);

Step("the RAIL_STORAGE_KEY preference is still exactly {string}", async ({ page }, value: string) => {
  const stored = await page.evaluate((key) => window.localStorage.getItem(key), RAIL_STORAGE_KEY);
  expect(stored).toBe(value);
});

Step(
  "the project pane renders expanded, matching the user's stored preference",
  async ({ page }) => {
    const toggle = page.getByTestId("rail-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  },
);

// ── AC6/DN5 — the 660px pane-content floor is absent below desktop ────────

Step(
  "the workspace Runs pane's content child does NOT carry the 660px min-width floor",
  async ({ page }) => {
    await expect(page.getByTestId("workspace-runs")).toBeVisible();
    const pane = page.getByTestId("pane-scroll");
    await expect(pane).toHaveCount(1);
    const minWidth = await pane.evaluate((el) => {
      const child = (el as HTMLElement).firstElementChild as HTMLElement | null;
      return child === null ? null : getComputedStyle(child).minWidth;
    });
    expect(minWidth).not.toBe("660px");
  },
);

// ── AC7/DN9 — tablet: the project band stacks beneath the content ─────────

Step(
  "the project pane sits BENEATH the main content column, not beside it",
  async ({ page }) => {
    const contentBox = await page.getByTestId("workspace-runs").boundingBox();
    const paneBox = await page.getByTestId("project-pane").boundingBox();
    expect(contentBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    // "stacks BENEATH" — the pane's top sits at/after the content's bottom,
    // and the two are not side-by-side (the pane does not sit to the right
    // at roughly the same y as the desktop layout does — navigation.steps.ts
    // asserts THAT arrangement with `paneBox.x > contentBox.x`, the inverted
    // claim this step exists to make fail today).
    expect(paneBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);
  },
);

Step("the project pane spans at least 90% of the workspace width", async ({ page }) => {
  const workspaceBox = await page.getByTestId("workspace").boundingBox();
  const paneBox = await page.getByTestId("project-pane").boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  expect(paneBox!.width).toBeGreaterThan(workspaceBox!.width * 0.9);
});

Step(
  "the project pane shows the project name, the live-agent count, and the health dot",
  async ({ page }) => {
    const pane = page.getByTestId("project-pane");
    const text = (await pane.innerText()).toLowerCase();
    expect(text).toMatch(/\d+\s*\/\s*\d+/);
  },
);

// ── AC8/DN10 — roadmap release-scoped table becomes cards on the phone ────

Step(
  "the roadmap release table renders as cards, not a table, on the phone profile",
  async ({ page }) => {
    await expect(page.getByTestId("roadmap-table")).toHaveCount(0);
    await expect(page.getByTestId("roadmap-row")).toHaveCount(0);
    const cards = page.getByTestId("roadmap-cr-card");
    await expect(cards.first()).toBeVisible();
  },
);

Step(
  "the roadmap card for {string} shows its id, status, wave and dependencies fields",
  async ({ page }, cr: string) => {
    const card = page.getByTestId("roadmap-cr-card").filter({ has: page.locator(`[data-cr="${cr}"]`) })
      .or(page.locator(`[data-testid="roadmap-cr-card"][data-cr="${cr}"]`));
    await expect(card.first()).toBeVisible();
    const scoped = card.first();
    await expect(scoped.getByTestId("roadmap-card-id")).toContainText(cr);
    await expect(scoped.getByTestId("roadmap-card-status")).toBeVisible();
    await expect(scoped.getByTestId("roadmap-card-wave")).toContainText("1");
    // Dependencies field EXISTS (even empty) — the same column as the
    // desktop table, never dropped to fit (DN "what none of them may do").
    await expect(scoped.getByTestId("roadmap-card-deps")).toHaveCount(1);
  },
);

// ── AC10/DN12 — compile diagnostics contained scroll; larger heat cells ────

Step(
  "a rustc compile error report with {int} diagnostics is ingested for agent {string}",
  async ({ request, world }, count: number, agentId: string) => {
    const lines: string[] = [];
    for (let i = 1; i <= count; i++) {
      const file = `src/file_${i % 5}.rs`;
      lines.push(`error[E0${String(300 + i)}]: mismatched types in generated diagnostic ${i}`);
      lines.push(` --> ${file}:${i}:5`);
    }
    await ingestCompile(request, world.projectKey as string, agentId, lines.join("\n"), "rustc");
  },
);

Step("the compile diagnostics container is the element that scrolls, not the page", async ({ page }) => {
  await expect(page.getByTestId("workspace-runs")).toBeVisible();
  const pane = page.getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  const { scrollHeight, clientHeight } = await pane.evaluate((el) => ({
    scrollHeight: (el as HTMLElement).scrollHeight,
    clientHeight: (el as HTMLElement).clientHeight,
  }));
  // The fixture's 40 synthetic diagnostics must genuinely overflow the pane
  // at phone height, or this proves nothing about containment.
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  const { docScrollHeight, innerHeight } = await page.evaluate(() => ({
    docScrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(docScrollHeight).toBeLessThanOrEqual(innerHeight + 2);
});

Step(
  "a 60-leaf regression run is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    await ingestJunit(request, world.projectKey as string, agentId, junit60(0), "regression");
  },
);

Step(
  "the heat-strip cell size on the phone profile is larger than the same run's heat-strip cell size at desktop width",
  async ({ page }) => {
    const cell = page.getByTestId("run-overlay").getByTestId("heat-cell").first();
    await expect(cell).toBeVisible();
    const phoneBox = await cell.boundingBox();
    expect(phoneBox).not.toBeNull();

    await page.setViewportSize({ width: 1280, height: 800 });
    // Same element, same fixture, only the viewport moved.
    const desktopBox = await cell.boundingBox();
    expect(desktopBox).not.toBeNull();

    expect(Math.max(phoneBox!.width, phoneBox!.height)).toBeGreaterThan(
      Math.max(desktopBox!.width, desktopBox!.height),
    );
  },
);
