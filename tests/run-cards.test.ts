// CR-CRU-007 §S1 — run card anatomy: kind icon, agentId, tier+codec badges,
// context badges (branch@shortcommit + wave, omitted when absent), relative
// time, duration, ratio pill (`N/N` green / `F ✗ of N` red / `E errors`
// pass-green when E=0 else fail-red for compile — RECONCILED 2026-07-15,
// user defect: the original amber `app-ratio-error` compile pill predated
// the UNIVERSAL status palette rule, see docs/changes/CR-CRU-007-timeline-drill-in.md
// §S1), and the compile-card diagnostics preview (first 2 lines,
// `file:line — message`).
//
// Drives the REAL production public/app.js shell inside a happy-dom window
// — same harness pattern as tests/shell-final-form.test.ts (idempotent
// register since ec6fe6d): real VanJS/VanX vendor bundles, real
// public/app-logic.mjs, real public/app.js; only `fetch` is scripted to
// serve canned v2 API payloads.
//
// RED phase: expected to fail against the CURRENT public/app.js EventCard,
// which renders only a bare `div.app-evt` (✓/✗ glyph + one text line) — no
// data-testid="event-card"/"card-icon"/"tier-badge"/"codec-badge"/
// "card-time"/"card-duration"/"ratio-pill"/"card-badges"/"context-badge"/
// "wave-badge"/"diag-preview"/"diag-line" elements exist yet.
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

interface ContextFixture {
  git?: { branch: string; commit: string };
  wave?: string;
  orchestrator?: string;
  cycle?: string;
}

interface DiagnosticFixture {
  file?: string;
  line?: number;
  message: string;
}

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: ContextFixture;
  errors?: number;
  warnings?: number;
  diagnostics?: DiagnosticFixture[];
  // CR-CRU-016 §S4 (F7 card differentiation) — coverage-bearing events'
  // brief additive field (src/v2.ts eventBrief, landed CR-007 fix round 3).
  coverageLines?: number;
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
  projects?: ProjectFixture[];
  events?: EventFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/shell-final-form.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`run-cards.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?runCards=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  // GREEN-escalated fix: guarded — the grep-only "no amber compile pill"
  // test never calls mountApp/register happy-dom, so an unconditional
  // unregister() threw "Happy DOM has not previously been globally
  // registered" and masked that test's real result (same fix as
  // tests/coverage-click.test.ts:244-247 / tests/storyboard-fidelity.test.ts).
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

describe("§S1 run card anatomy", () => {
  test("test-event card renders kind icon, agentId, tier+codec badges, relative time, duration, and an all-pass green ratio pill", async () => {
    const now = Date.now();
    const ts = now - 5 * 60 * 1000; // 5m ago
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cards",
          name: "Cards",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-pass-1",
          projectKey: "proj-cards",
          agentId: "pass-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: ts,
          total: 5,
          passed: 5,
          failed: 0,
          pending: 0,
          duration_ms: 5000,
          hasCoverage: false,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    // CR-CRU-007 VERIFY-findings fix 2 (2026-07-15) — the tintable-icon
    // contract (public/app.js ~452, public/styles.css .app-icon-mask):
    // card-icon is a wrapper (`data-icon-tintable="true"`, NO emoji text)
    // around a CSS-mask-driven `[data-testid="icon-glyph"]` child carrying
    // `data-kind="test"` — CSS `color` cannot tint color-emoji text, so the
    // glyph is a monochrome mask painted with `currentColor` instead.
    const cardIcon = card!.querySelector('[data-testid="card-icon"]');
    expect(cardIcon).not.toBeNull();
    expect(cardIcon!.getAttribute("data-icon-tintable")).toBe("true");
    expect((cardIcon!.textContent ?? "")).toBe("");
    const iconGlyph = cardIcon!.querySelector('[data-testid="icon-glyph"]');
    expect(iconGlyph).not.toBeNull();
    expect(iconGlyph!.className).toMatch(/\bapp-icon-mask\b/);
    expect(iconGlyph!.getAttribute("data-kind")).toBe("test");
    expect(card!.textContent ?? "").toContain("pass-agent");

    const tierBadge = card!.querySelector('[data-testid="tier-badge"]');
    expect(tierBadge).not.toBeNull();
    expect((tierBadge!.textContent ?? "")).toContain("unit");

    const codecBadge = card!.querySelector('[data-testid="codec-badge"]');
    expect(codecBadge).not.toBeNull();
    expect((codecBadge!.textContent ?? "")).toContain("junit");

    const timeEl = card!.querySelector('[data-testid="card-time"]');
    expect(timeEl).not.toBeNull();
    expect((timeEl!.textContent ?? "").trim()).toBe("5m ago");

    const durationEl = card!.querySelector('[data-testid="card-duration"]');
    expect(durationEl).not.toBeNull();
    expect((durationEl!.textContent ?? "").trim()).toBe("5s");

    const pill = card!.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect((pill!.textContent ?? "").trim()).toBe("5/5");
    expect(pill!.className).toContain("app-ratio-pass");
  });

  test("test-event card with failures renders the red 'F ✗ of N' ratio pill", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cards-2",
          name: "Cards 2",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-fail-1",
          projectKey: "proj-cards-2",
          agentId: "fail-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 5,
          passed: 3,
          failed: 2,
          pending: 0,
          duration_ms: 3000,
          hasCoverage: false,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    const pill = card!.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect((pill!.textContent ?? "").trim()).toBe("2 ✗ of 5");
    expect(pill!.className).toContain("app-ratio-fail");
  });

  test("compile-event card renders 🛠 icon, a fail-red error-count pill when errors>0 (never a test ratio), and the first 2 diagnostics inline (file:line — message)", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cards-3",
          name: "Cards 3",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-compile-1",
          projectKey: "proj-cards-3",
          agentId: "compile-agent",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          hasCoverage: false,
          errors: 3,
          warnings: 1,
          diagnostics: [
            { file: "src/lib.rs", line: 12, message: "mismatched types" },
            { file: "src/a.rs", line: 1, message: "unused import" },
            { file: "src/b.rs", line: 9, message: "third diagnostic, must not appear" },
          ],
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    // CR-CRU-007 VERIFY-findings fix 2 — same tintable-icon contract as the
    // test-event card above, for the compile glyph (`data-kind="compile"`).
    const cardIcon = card!.querySelector('[data-testid="card-icon"]');
    expect(cardIcon).not.toBeNull();
    expect(cardIcon!.getAttribute("data-icon-tintable")).toBe("true");
    expect((cardIcon!.textContent ?? "")).toBe("");
    const iconGlyph = cardIcon!.querySelector('[data-testid="icon-glyph"]');
    expect(iconGlyph).not.toBeNull();
    expect(iconGlyph!.className).toMatch(/\bapp-icon-mask\b/);
    expect(iconGlyph!.getAttribute("data-kind")).toBe("compile");

    const pill = card!.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    const pillText = (pill!.textContent ?? "").trim();
    expect(pillText).toBe("3 errors");
    // RECONCILED (2026-07-15, user defect — pill palette): errors>0 is
    // fail-red (SAME class a failing N/N test pill carries), never the
    // retired amber `app-ratio-error` class — was:
    // `expect(pill!.className).toContain("app-ratio-error")`.
    expect(pill!.className).toContain("app-ratio-fail");
    expect(pill!.className).not.toContain("app-ratio-error");
    // bound: never a test-ratio shape (no "/" fraction, no "✗").
    expect(pillText).not.toContain("/");
    expect(pillText).not.toContain("✗");

    const diagPreview = card!.querySelector('[data-testid="diag-preview"]');
    expect(diagPreview).not.toBeNull();
    const lines = diagPreview!.querySelectorAll('[data-testid="diag-line"]');
    expect(lines.length).toBe(2);
    expect((lines[0]!.textContent ?? "").trim()).toBe("src/lib.rs:12 — mismatched types");
    expect((lines[1]!.textContent ?? "").trim()).toBe("src/a.rs:1 — unused import");
    expect(diagPreview!.textContent ?? "").not.toContain("third diagnostic");
  });
});

// CR-CRU-007 §S1 (user defect 2026-07-15) — compile card pill palette: a
// compile card with `errors:0` renders its `0 errors` pill with the SAME
// pass-green class as an N/N test pill; with `errors:3` the `3 errors` pill
// carries the fail-red class (covered above); no amber compile pill exists
// anywhere (class-level assertion, both DOM-rendered instances AND a
// source-level grep — the retired `app-ratio-error` class string must not
// appear in public/app.js at all once GREEN removes it).
describe("§S1 — compile card pill palette (user defect 2026-07-15)", () => {
  test("compile-event card with errors:0 renders a pass-green '0 errors' pill — the SAME class as an all-pass N/N test pill", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cards-pill-0",
          name: "Cards Pill 0",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-compile-pill-0",
          projectKey: "proj-cards-pill-0",
          agentId: "compile-pill-0-agent",
          kind: "compile",
          tier: "unit",
          codec: "tsc",
          timestamp: now,
          hasCoverage: false,
          errors: 0,
          warnings: 0,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    const pill = card!.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect((pill!.textContent ?? "").trim()).toBe("0 errors");
    // SAME pass-green class an N/N test pill carries (see the all-pass test
    // above: `expect(pill!.className).toContain("app-ratio-pass")`).
    expect(pill!.className).toContain("app-ratio-pass");
    expect(pill!.className).not.toContain("app-ratio-error");
    expect(pill!.className).not.toContain("app-ratio-fail");
  });

  test("no amber compile pill exists anywhere — the retired 'app-ratio-error' class string is never referenced by public/app.js", () => {
    expect(APP_JS_SRC).not.toContain("app-ratio-error");
  });
});

describe("§S1 AC1 — context badges", () => {
  test("context-bearing event's card shows branch@shortcommit (7-char) + a wave badge", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-ctx-1",
          name: "Ctx 1",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-ctx-1",
          projectKey: "proj-ctx-1",
          agentId: "ctx-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          duration_ms: 200,
          hasCoverage: false,
          context: { git: { branch: "feat/x", commit: "abc1234def" }, wave: "2" },
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();
    const badges = card!.querySelector('[data-testid="card-badges"]');
    expect(badges).not.toBeNull();

    const contextBadge = badges!.querySelector('[data-testid="context-badge"]');
    expect(contextBadge).not.toBeNull();
    expect((contextBadge!.textContent ?? "").trim()).toBe("feat/x@abc1234");

    const waveBadge = badges!.querySelector('[data-testid="wave-badge"]');
    expect(waveBadge).not.toBeNull();
    expect((waveBadge!.textContent ?? "")).toContain("2");
  });

  test("context-less event's card shows no context/wave badges and no placeholder text in the badge area", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-ctx-2",
          name: "Ctx 2",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-ctx-2",
          projectKey: "proj-ctx-2",
          agentId: "no-ctx-agent",
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now,
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          duration_ms: 200,
          hasCoverage: false,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();
    const badges = card!.querySelector('[data-testid="card-badges"]');
    expect(badges).not.toBeNull();

    expect(badges!.querySelector('[data-testid="context-badge"]')).toBeNull();
    expect(badges!.querySelector('[data-testid="wave-badge"]')).toBeNull();

    const badgeText = badges!.textContent ?? "";
    expect(badgeText).not.toContain("branch");
    expect(badgeText).not.toContain("wave");
    expect(badgeText).not.toContain("—");
  });
});

// CR-CRU-016 §S4 F7 card differentiation (user defect 2026-07-16): "the
// close-out regression card rendered `unit · parsed · 482/482`,
// indistinguishable from a unit run" — a regression-tier card with
// coverage-bearing brief now renders its tier badge (already automatic),
// a `parsed+lcov` codec badge, and an inline `.app-meter`/`.app-meter-fill`
// mini coverage meter (`data-testid="card-coverage-meter"`); a regression
// card with no coverage stays codec `parsed` and renders no meter; a
// unit-tier card (even carrying coverageLines) never gets the +lcov suffix
// or the meter — the differentiation gates on tier:"regression", not
// merely on coverage presence.
//
// RED phase: expected to fail against the CURRENT public/app.js EventCard
// (~line 500), which renders the codec badge as `e.codec` verbatim (no
// tier-gated "+lcov" suffix) and has no card-coverage-meter element at all.
describe("§S4 F7 card differentiation (user defect 2026-07-16)", () => {
  test("regression-tier event with coverageLines:94.4 renders the regression tier badge, 'parsed+lcov' codec badge, and an inline card-coverage-meter (.app-meter/.app-meter-fill width 94.4%)", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-s4-1",
          name: "S4 Regression",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-s4-regression-cov",
          projectKey: "proj-s4-1",
          agentId: "regression-agent",
          kind: "test",
          tier: "regression",
          codec: "parsed",
          timestamp: now,
          total: 482,
          passed: 482,
          failed: 0,
          pending: 0,
          duration_ms: 12000,
          hasCoverage: true,
          coverageLines: 94.4,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    const tierBadge = card!.querySelector('[data-testid="tier-badge"]');
    expect(tierBadge).not.toBeNull();
    expect((tierBadge!.textContent ?? "").trim()).toBe("regression");

    const codecBadge = card!.querySelector('[data-testid="codec-badge"]');
    expect(codecBadge).not.toBeNull();
    expect((codecBadge!.textContent ?? "").trim()).toBe("parsed+lcov");

    const meter = card!.querySelector('[data-testid="card-coverage-meter"]');
    expect(meter).not.toBeNull();
    expect(meter!.className).toContain("app-meter");

    const fill = meter!.querySelector(".app-meter-fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.getAttribute("style") ?? "").toMatch(/width:\s*94\.4%/);
  });

  test("regression-tier event WITHOUT coverage renders the regression tier badge, plain 'parsed' codec badge, and NO card-coverage-meter", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-s4-2",
          name: "S4 Regression No Cov",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-s4-regression-nocov",
          projectKey: "proj-s4-2",
          agentId: "regression-agent-2",
          kind: "test",
          tier: "regression",
          codec: "parsed",
          timestamp: now,
          total: 40,
          passed: 38,
          failed: 2,
          pending: 0,
          duration_ms: 9000,
          hasCoverage: false,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    const tierBadge = card!.querySelector('[data-testid="tier-badge"]');
    expect(tierBadge).not.toBeNull();
    expect((tierBadge!.textContent ?? "").trim()).toBe("regression");

    const codecBadge = card!.querySelector('[data-testid="codec-badge"]');
    expect(codecBadge).not.toBeNull();
    expect((codecBadge!.textContent ?? "").trim()).toBe("parsed");

    expect(card!.querySelector('[data-testid="card-coverage-meter"]')).toBeNull();
  });

  test("unit-tier event — even one carrying coverageLines — renders no card-coverage-meter and a plain 'parsed' codec badge (gated on tier:regression, not merely coverage presence)", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-s4-3",
          name: "S4 Unit",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "evt-s4-unit",
          projectKey: "proj-s4-3",
          agentId: "unit-agent",
          kind: "test",
          tier: "unit",
          codec: "parsed",
          timestamp: now,
          total: 12,
          passed: 12,
          failed: 0,
          pending: 0,
          duration_ms: 800,
          hasCoverage: true,
          coverageLines: 88.0,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();

    const tierBadge = card!.querySelector('[data-testid="tier-badge"]');
    expect(tierBadge).not.toBeNull();
    expect((tierBadge!.textContent ?? "").trim()).toBe("unit");

    const codecBadge = card!.querySelector('[data-testid="codec-badge"]');
    expect(codecBadge).not.toBeNull();
    expect((codecBadge!.textContent ?? "").trim()).toBe("parsed");

    expect(card!.querySelector('[data-testid="card-coverage-meter"]')).toBeNull();
  });
});
