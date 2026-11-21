// page-styles-are-static.feature — steps. The page's utility styles (Tailwind's
// theme variables, base reset and the two utilities the Roadmap's terminal
// markers carry) are served as a static stylesheet: the page loads no script
// that generates a stylesheet, links the static one after the dashboard's own
// `/styles.css`, never changes a stylesheet while it runs, and every named
// element keeps the computed styles it had under the runtime.
//
// The computed styles are compared with a baseline committed as a fixture
// (tests/fixtures/page-computed-styles-baseline.json), recorded in a real
// browser while the runtime still loaded. The fixture names each element's
// selector (a Playwright selector), the computed properties compared, and the
// viewport, `data-theme` and density it was taken at.
//
// Recording: with RECORD_PAGE_STYLE_BASELINE=1 the comparison step writes the
// element's computed styles into the fixture instead of comparing, and then
// FAILS on purpose, so a recording run can never be read as a pass.
//
// Reuses seeding.steps.ts (project, agents, runs), navigation.steps.ts,
// workflow.steps.ts (the tab click), run-lifecycle.steps.ts (the run start),
// run-stream-live-page.steps.ts (the streaming agent, the running card's
// count, the close), runs-tab-stays-responsive-while-a-run-streams.steps.ts
// (the five-batch stream), roadmap.steps.ts (the CR queue), manager.steps.ts
// (the drawer), drillin.steps.ts (the run detail) and pane-scroll.steps.ts
// (the viewport).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { Step } from "./world.ts";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "page-computed-styles-baseline.json",
);

const RECORDING = process.env.RECORD_PAGE_STYLE_BASELINE === "1";

/** The computed properties compared on every element. */
const PROPERTIES: readonly string[] = [
  "display",
  "box-sizing",
  "position",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-top-color",
  "border-top-left-radius",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "text-align",
  "text-decoration-line",
  "text-transform",
  "white-space",
  "list-style-type",
  "vertical-align",
  "cursor",
  "appearance",
  "outline-style",
  "tab-size",
  "-webkit-font-smoothing",
  "-webkit-tap-highlight-color",
];

/** What the recording takes, by element name: the selector it is found by. */
const RECORDED_ELEMENTS: Record<string, string> = {
  "home timeline card": '[data-testid="timeline"] [data-testid="event-card"]:has-text("ssb-history")',
  "home filter pulldown": '[data-testid="filter-pulldown"]',
  "manager drawer": '[data-testid="projects-manager"]',
  "manager form control": '[data-testid="projects-manager"] input >> nth=0',
  "runs timeline card": '[data-testid="workspace-runs"] [data-testid="event-card"]:has-text("ssb-history")',
  "running card": '[data-testid="workspace-runs"] [data-testid="running-card"]:has-text("ssb-streamer")',
  "agent card": '[data-testid="project-pane"] [data-testid="agent-row"]:has-text("ssb-streamer")',
  "run detail header": '[data-testid="run-overlay"] .app-drillin-head',
  "run detail back button": '[data-testid="run-overlay"] .app-drillin-head button >> nth=0',
  "roadmap start terminal": '[data-terminal="start"] >> nth=0',
  "roadmap end terminal": '[data-terminal="end"] >> nth=0',
};

interface BaselineElement {
  selector: string;
  styles: Record<string, string>;
}

interface Baseline {
  about: string;
  recordedUnder: string;
  viewport: { width: number; height: number };
  dataTheme: string;
  density: string;
  properties: string[];
  elements: Record<string, BaselineElement>;
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Baseline;
}

interface PageConditions {
  viewport: { width: number; height: number };
  dataTheme: string;
  density: string;
}

async function pageConditions(page: Page): Promise<PageConditions> {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const { dataTheme, density } = await page.evaluate(() => {
    const root = document.documentElement;
    const densityClass = Array.from(root.classList).find((c) => c.startsWith("app-density-")) ?? "";
    return { dataTheme: root.getAttribute("data-theme") ?? "", density: densityClass.replace("app-density-", "") };
  });
  return { viewport, dataTheme, density };
}

/** Freeze every animation at its start and move the pointer off the page's content. */
async function steadyPage(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 0;
    }
  });
}

async function computedStyles(page: Page, selector: string, properties: readonly string[]): Promise<Record<string, string>> {
  const element = page.locator(selector);
  await expect(element, `the page draws exactly one element for ${selector}`).toHaveCount(1, { timeout: 10_000 });
  await steadyPage(page);
  return element.evaluate((el, props) => {
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  }, properties as string[]);
}

Step("the board is drawn at the baseline's viewport, theme and density", async ({ page }) => {
  const now = await pageConditions(page);
  if (RECORDING) {
    const prior = existsSync(FIXTURE) ? readBaseline() : null;
    const baseline: Baseline = {
      about:
        "Computed styles of named dashboard elements, recorded in a real browser (Playwright chromium) while the page " +
        "still loaded the Tailwind browser runtime. The page's utility styles must keep these values once they are " +
        "served as a static stylesheet. Selectors are Playwright selectors.",
      recordedUnder: "tailwindcss 4.2.4 browser runtime (/vendor/tailwind-browser-4.2.4.js)",
      viewport: now.viewport,
      dataTheme: now.dataTheme,
      density: now.density,
      properties: [...PROPERTIES],
      elements: prior?.elements ?? {},
    };
    writeFileSync(FIXTURE, `${JSON.stringify(baseline, null, 2)}\n`);
    return;
  }
  const baseline = readBaseline();
  expect(now).toEqual({ viewport: baseline.viewport, dataTheme: baseline.dataTheme, density: baseline.density });
});

Step("the baseline's {string} keeps its recorded computed styles", async ({ page }, name: string) => {
  if (RECORDING) {
    const selector = RECORDED_ELEMENTS[name];
    expect(selector, `the recording names a selector for "${name}"`).toBeDefined();
    const styles = await computedStyles(page, selector as string, PROPERTIES);
    const baseline = readBaseline();
    baseline.elements[name] = { selector: selector as string, styles };
    writeFileSync(FIXTURE, `${JSON.stringify(baseline, null, 2)}\n`);
    return;
  }
  const baseline = readBaseline();
  const recorded = baseline.elements[name];
  expect(recorded, `the baseline records "${name}"`).toBeDefined();
  const { selector, styles: expected } = recorded as BaselineElement;
  const actual = await computedStyles(page, selector, baseline.properties);
  const differences = baseline.properties
    .filter((p) => actual[p] !== expected[p])
    .map((p) => `${p}: recorded "${String(expected[p])}", now "${String(actual[p])}"`);
  expect(differences, `${name} (${selector})`).toEqual([]);
});

Step("the baseline recording is complete", () => {
  // A recording run writes the fixture and must never read as a pass.
  expect(RECORDING, "the baseline was recorded, not compared: run again without RECORD_PAGE_STYLE_BASELINE").toBe(
    false,
  );
});

Step("the page loads no Tailwind runtime script", async ({ page }) => {
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).map((s) => s.getAttribute("src") ?? ""),
  );
  expect(scripts.length, "the page loads its scripts").toBeGreaterThan(0);
  expect(scripts.filter((src) => /tailwind/i.test(src))).toEqual([]);
});

Step("the page links the static Tailwind stylesheet after {string}", async ({ page }, own: string) => {
  const links = await page.evaluate(async () => {
    const out: { href: string; head: string; layered: boolean; loaded: boolean }[] = [];
    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
      const href = link.getAttribute("href") ?? "";
      const text = await (await fetch(href)).text();
      let loaded = false;
      try {
        loaded = (link.sheet?.cssRules.length ?? 0) > 0;
      } catch {
        loaded = false;
      }
      out.push({ href, head: text.slice(0, 300), layered: text.includes("@layer"), loaded });
    }
    return out;
  });
  const hrefs = links.map((l) => l.href);
  const ownAt = hrefs.indexOf(own);
  expect(ownAt, `the page links ${own}; it links ${hrefs.join(", ")}`).toBeGreaterThanOrEqual(0);
  const isStatic = (l: { head: string }): boolean => /tailwindcss/i.test(l.head) && /4\.2\.4/.test(l.head);
  const statics = links.filter(isStatic);
  expect(
    statics.map((l) => l.href),
    `exactly one linked stylesheet's header names tailwindcss 4.2.4; the page links ${hrefs.join(", ")}`,
  ).toHaveLength(1);
  const sheet = statics[0] as (typeof links)[number];
  expect(hrefs.indexOf(sheet.href), `${sheet.href} is linked after ${own}`).toBeGreaterThan(ownAt);
  expect(sheet.href.startsWith("/vendor/"), `${sheet.href} is vendored`).toBe(true);
  expect(sheet.layered, `${sheet.href} keeps the runtime's @layer blocks`).toBe(true);
  expect(sheet.loaded, `${sheet.href} loaded its rules`).toBe(true);
});

interface SheetWatch {
  changes: string[];
  fingerprint: string[];
  observer: MutationObserver;
}

Step("I start watching the document's stylesheets", async ({ page }) => {
  await page.evaluate(() => {
    // The one exemption: uPlot's own stylesheet, which the Roadmap's release
    // band adds lazily when it warms the chart library (uPlot stays off the
    // page load). Its addition, and its presence afterwards, are not counted.
    const UPLOT_CSS = "/vendor/uplot-1.6.32.min.css";
    const isUplotLink = (n: Node): boolean =>
      n.nodeName === "LINK" && (n as HTMLLinkElement).getAttribute("href") === UPLOT_CSS;
    const isSheetNode = (n: Node): boolean =>
      n.nodeName === "STYLE" || (n.nodeName === "LINK" && /stylesheet/i.test((n as HTMLLinkElement).rel));
    const insideStyle = (n: Node | null): boolean => {
      for (let node = n; node !== null; node = node.parentNode) if (node.nodeName === "STYLE") return true;
      return false;
    };
    const fingerprint = (): string[] =>
      Array.from(document.styleSheets)
        .filter((sheet) => sheet.ownerNode === null || !isUplotLink(sheet.ownerNode))
        .map((sheet) => {
        let rules = -1;
        let size = -1;
        try {
          rules = sheet.cssRules.length;
          size = Array.from(sheet.cssRules).reduce((sum, r) => sum + r.cssText.length, 0);
        } catch {
          rules = -1;
        }
        return `${sheet.href ?? `<${sheet.ownerNode?.nodeName.toLowerCase() ?? "adopted"}>`} ${String(rules)} rules ${String(size)} chars`;
      });
    const changes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) if (isSheetNode(n) && !isUplotLink(n)) changes.push(`a <${n.nodeName.toLowerCase()}> was added`);
        for (const n of Array.from(r.removedNodes)) if (isSheetNode(n)) changes.push(`a <${n.nodeName.toLowerCase()}> was removed`);
        if ((r.type === "childList" || r.type === "characterData") && insideStyle(r.target)) changes.push("a <style> was rewritten");
        if (r.type === "attributes" && isSheetNode(r.target)) changes.push(`a <${r.target.nodeName.toLowerCase()}>'s ${String(r.attributeName)} changed`);
      }
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "media", "disabled", "rel"],
    });
    const proto = CSSStyleSheet.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["insertRule", "deleteRule", "replace", "replaceSync", "addRule", "removeRule"]) {
      const original = proto[method];
      if (typeof original !== "function") continue;
      proto[method] = function (this: CSSStyleSheet, ...args: unknown[]) {
        changes.push(`CSSStyleSheet.${method} was called`);
        return original.apply(this, args);
      };
    }
    (window as unknown as { __sheetWatch: unknown }).__sheetWatch = { changes, fingerprint: fingerprint(), observer };
    (window as unknown as { __sheetFingerprint: () => string[] }).__sheetFingerprint = fingerprint;
  });
});

Step("no stylesheet in the document changed while I watched", async ({ page }) => {
  // Let the last frame's work land before the watch is read.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(), 300))));
  const seen = await page.evaluate(() => {
    const w = window as unknown as { __sheetWatch?: SheetWatch; __sheetFingerprint?: () => string[] };
    const watch = w.__sheetWatch;
    if (watch === undefined || w.__sheetFingerprint === undefined) return null;
    for (const r of watch.observer.takeRecords()) {
      if (r.target.nodeName === "STYLE" || r.target.parentNode?.nodeName === "STYLE") watch.changes.push("a <style> was rewritten");
    }
    watch.observer.disconnect();
    return { changes: [...new Set(watch.changes)], before: watch.fingerprint, after: w.__sheetFingerprint() };
  });
  expect(seen, "the document's stylesheets were being watched").not.toBeNull();
  const { changes, before, after } = seen as { changes: string[]; before: string[]; after: string[] };
  expect(changes).toEqual([]);
  expect(after).toEqual(before);
});

Step("the page has drawn no Roadmap terminal yet", async ({ page }) => {
  const drawn = await page.evaluate(() => document.querySelectorAll("[data-terminal]").length);
  expect(drawn, "Roadmap terminals already in the page").toBe(0);
});

Step("the Roadmap's start and end terminals are drawn within {int} seconds", async ({ page }, seconds: number) => {
  await expect(page.locator('[data-terminal="start"]').first()).toBeVisible({ timeout: seconds * 1_000 });
  await expect(page.locator('[data-terminal="end"]').first()).toBeVisible({ timeout: seconds * 1_000 });
});
