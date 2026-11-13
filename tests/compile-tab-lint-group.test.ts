// The Compile tab keeps lint records apart from compile records, and a lint
// record says "lint" wherever it is shown.
//
// A lint record is a compile-kind event whose brief carries `lint: "<tool>"`
// (the linter's name). On the Compile tab:
//  - compile records and lint records sit in two groups, each headed with its
//    name and its count ("Compile · 1", "Lint · 2" — the approved storyboard
//    frame);
//  - with no lint record there is no Lint group;
//  - with only lint records the Lint group shows, and the empty line
//    `no compile events yet` does not;
//  - a lint card names its tool and reads `N lint errors` (fail-red) or
//    `lint clean` (pass-green), never "compile"; its icon glyph carries
//    `data-kind="lint"`, painted by its own mask (the broom), inside the same
//    tintable wrapper every card uses;
//  - a lint record's drill-in groups its findings by file with each finding's
//    rule code shown, reads `clean lint — no findings` when it has none, and
//    keeps the raw-output toggle.
// A compile card and a compile drill-in are unchanged (the guards below).
//
// Hooks named here for the group markup:
//  - `[data-testid="compile-group"]` with `data-group="compile"` or
//    `data-group="lint"`, holding that group's cards;
//  - `[data-testid="compile-group-heading"]` inside each group, its text the
//    group's name and count.
//
// Drives the REAL public/app.js shell inside happy-dom — the same harness as
// tests/drill-in.test.ts and tests/inpane-drill-in.test.ts: real VanJS/VanX
// vendor bundles, real public/app-logic.mjs, real public/app.js; only `fetch`
// is scripted.
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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

interface DiagnosticFixture {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
}

interface CompileFixture {
  format: string;
  errorCount: number;
  warningCount: number;
  diagnostics: DiagnosticFixture[];
  raw: string;
}

/** The events-list brief, in the board's own shape (`eventBrief`, src/v2.ts). */
interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  hasCoverage: boolean;
  errors?: number;
  warnings?: number;
  diagnostics?: DiagnosticFixture[];
  lint?: string;
}

/** The single-event read (`GET /api/v2/events/<id>`). */
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  compile: CompileFixture;
  lint?: string;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active: boolean;
  lastActivity: number;
  lastEvent: unknown;
  latestGreenCoverage: unknown;
}

interface MountOpts {
  key: string;
  events: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;

function project(key: string): ProjectFixture {
  return {
    key,
    name: `Lint Group ${key}`,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: Date.now(),
    lastEvent: null,
    latestGreenCoverage: null,
  };
}

/** Mounts the workspace of `opts.key` with the given events and details. */
async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`compile-tab-lint-group.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      body = { ok: true, event: detail };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: [project(opts.key)] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`compile-tab-lint-group.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?compileTabLintGroup=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

/** Clicks the workspace's Compile tab and answers the workspace body. */
async function openCompileTab(): Promise<Element> {
  const compileTab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
    (el) => (el.textContent ?? "").trim() === "Compile",
  );
  expect(compileTab).toBeDefined();
  compileTab!.click();
  await settle();
  const body = document.querySelector('[data-testid="workspace-body"]');
  expect(body).not.toBeNull();
  return body!;
}

function group(root: ParentNode, name: "compile" | "lint"): Element | null {
  return root.querySelector(`[data-testid="compile-group"][data-group="${name}"]`);
}

function headingText(groupEl: Element): string {
  const heading = groupEl.querySelector('[data-testid="compile-group-heading"]');
  expect(heading).not.toBeNull();
  return (heading!.textContent ?? "").replace(/\s+/g, " ").trim();
}

function cardIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[data-testid="event-card"]'))
    .map((c) => c.getAttribute("data-run-id") ?? "")
    .sort();
}

function card(root: ParentNode, id: string): Element {
  const el = root.querySelector(`[data-testid="event-card"][data-run-id="${id}"]`);
  expect(el).not.toBeNull();
  return el!;
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function compileBrief(key: string, id: string, timestamp: number): EventBriefFixture {
  return {
    id,
    projectKey: key,
    agentId: "build-agent-RED",
    kind: "compile",
    tier: "unit",
    codec: "rustc",
    timestamp,
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    duration_ms: 0,
    hasCoverage: false,
    errors: 1,
    warnings: 0,
    diagnostics: [{ file: "src/checkpoint.rs", line: 142, col: 9, code: "E0308", message: "mismatched types", level: "error" }],
  };
}

/** A failing `go vet` lint record: two errors, decoded through `go`. */
function goVetBrief(key: string, id: string, timestamp: number): EventBriefFixture {
  return {
    id,
    projectKey: key,
    agentId: "vet-agent-GREEN",
    kind: "compile",
    tier: "unit",
    codec: "go",
    timestamp,
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    duration_ms: 0,
    hasCoverage: false,
    errors: 2,
    warnings: 0,
    diagnostics: [
      { file: "store/store.go", line: 91, col: 2, code: "printf", message: "fmt.Sprintf format %d has arg name of wrong type string", level: "error" },
      { file: "store/checkpoint.go", line: 57, col: 4, code: "copylocks", message: "assignment copies lock value to c: sync.Mutex", level: "error" },
    ],
    lint: "go vet",
  };
}

/** A clean `ruff` lint record: no findings. */
function ruffCleanBrief(key: string, id: string, timestamp: number): EventBriefFixture {
  return {
    id,
    projectKey: key,
    agentId: "vidushi",
    kind: "compile",
    tier: "unit",
    codec: "ruff",
    timestamp,
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    duration_ms: 0,
    hasCoverage: false,
    errors: 0,
    warnings: 0,
    diagnostics: [],
    lint: "ruff",
  };
}

// ── The groups ──────────────────────────────────────────────────────────────

describe("the Compile tab groups lint records apart from compile records", () => {
  test("one compile record and one lint record show a Compile group and a Lint group, each headed with its count of one and holding only its own card", async () => {
    const key = "lint-groups-both-1";
    const now = Date.now();
    await mountApp({
      key,
      events: [compileBrief(key, "lg-compile-1", now - 2000), goVetBrief(key, "lg-lint-1", now - 1000)],
    });
    const body = await openCompileTab();

    const compileGroup = group(body, "compile");
    const lintGroup = group(body, "lint");
    expect(compileGroup).not.toBeNull();
    expect(lintGroup).not.toBeNull();
    expect(headingText(compileGroup!)).toMatch(/^Compile\s*·\s*1$/);
    expect(headingText(lintGroup!)).toMatch(/^Lint\s*·\s*1$/);
    expect(cardIds(compileGroup!)).toEqual(["lg-compile-1"]);
    expect(cardIds(lintGroup!)).toEqual(["lg-lint-1"]);
    // Exactly two groups, and no card outside them.
    expect(body.querySelectorAll('[data-testid="compile-group"]').length).toBe(2);
    expect(cardIds(body)).toEqual(["lg-compile-1", "lg-lint-1"]);
  });

  test("one compile record and two lint records head the Lint group with a count of two and the Compile group with a count of one", async () => {
    const key = "lint-groups-count-1";
    const now = Date.now();
    await mountApp({
      key,
      events: [
        compileBrief(key, "lc-compile-1", now - 3000),
        goVetBrief(key, "lc-lint-fail", now - 2000),
        ruffCleanBrief(key, "lc-lint-clean", now - 1000),
      ],
    });
    const body = await openCompileTab();

    const compileGroup = group(body, "compile");
    const lintGroup = group(body, "lint");
    expect(compileGroup).not.toBeNull();
    expect(lintGroup).not.toBeNull();
    expect(headingText(compileGroup!)).toMatch(/^Compile\s*·\s*1$/);
    expect(headingText(lintGroup!)).toMatch(/^Lint\s*·\s*2$/);
    expect(cardIds(lintGroup!)).toEqual(["lc-lint-clean", "lc-lint-fail"]);
    expect(cardIds(compileGroup!)).toEqual(["lc-compile-1"]);
  });

  // GUARD — passes today: with no lint record there is no Lint group. It
  // fails against a Lint group rendered unconditionally (an empty
  // "Lint · 0" group, or a heading with no records under it).
  test("with no lint record the tab shows no Lint group and no Lint heading, and keeps every compile card", async () => {
    const key = "lint-groups-none-1";
    const now = Date.now();
    await mountApp({
      key,
      events: [compileBrief(key, "ln-compile-1", now - 2000), compileBrief(key, "ln-compile-2", now - 1000)],
    });
    const body = await openCompileTab();

    expect(group(body, "lint")).toBeNull();
    const lintHeadings = Array.from(body.querySelectorAll('[data-testid="compile-group-heading"]')).filter((h) =>
      textOf(h).startsWith("Lint"),
    );
    expect(lintHeadings.length).toBe(0);
    expect(cardIds(body)).toEqual(["ln-compile-1", "ln-compile-2"]);
  });

  test("with only lint records the tab shows the Lint group holding both, and no 'no compile events yet' line", async () => {
    const key = "lint-groups-only-1";
    const now = Date.now();
    await mountApp({
      key,
      events: [goVetBrief(key, "lo-lint-fail", now - 2000), ruffCleanBrief(key, "lo-lint-clean", now - 1000)],
    });
    const body = await openCompileTab();

    const lintGroup = group(body, "lint");
    expect(lintGroup).not.toBeNull();
    expect(headingText(lintGroup!)).toMatch(/^Lint\s*·\s*2$/);
    expect(cardIds(lintGroup!)).toEqual(["lo-lint-clean", "lo-lint-fail"]);
    expect(body.textContent ?? "").not.toContain("no compile events yet");
  });
});

// ── The card ────────────────────────────────────────────────────────────────

describe("a lint record's card says lint, never compile", () => {
  test("a failing lint card names its tool, reads '2 lint errors' in the fail-red class, says 'compile' nowhere, and its glyph carries data-kind 'lint'", async () => {
    const key = "lint-card-fail-1";
    const now = Date.now();
    await mountApp({ key, events: [goVetBrief(key, "lcf-lint-1", now - 1000)] });
    const body = await openCompileTab();

    const lintCard = card(body, "lcf-lint-1");
    expect(textOf(lintCard)).toContain("go vet");
    const pill = lintCard.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect(textOf(pill)).toBe("2 lint errors");
    expect(pill!.className).toContain("app-ratio-fail");
    expect(pill!.className).not.toContain("app-ratio-pass");
    expect((lintCard.textContent ?? "").toLowerCase()).not.toContain("compile");
    const glyph = lintCard.querySelector('[data-testid="icon-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("data-kind")).toBe("lint");
  });

  test("a clean lint card names its tool, reads 'lint clean' in the pass-green class, says 'compile' nowhere, and its glyph carries data-kind 'lint'", async () => {
    const key = "lint-card-clean-1";
    const now = Date.now();
    await mountApp({ key, events: [ruffCleanBrief(key, "lcc-lint-1", now - 1000)] });
    const body = await openCompileTab();

    const lintCard = card(body, "lcc-lint-1");
    expect(textOf(lintCard)).toContain("ruff");
    const pill = lintCard.querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect(textOf(pill)).toBe("lint clean");
    expect(pill!.className).toContain("app-ratio-pass");
    expect(pill!.className).not.toContain("app-ratio-fail");
    expect((lintCard.textContent ?? "").toLowerCase()).not.toContain("compile");
    const glyph = lintCard.querySelector('[data-testid="icon-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("data-kind")).toBe("lint");
  });

  test("a lint card's glyph is the tintable mask of kind 'lint' inside a wrapper that holds no emoji text", async () => {
    const key = "lint-card-icon-1";
    const now = Date.now();
    await mountApp({ key, events: [goVetBrief(key, "lci-lint-1", now - 1000)] });
    const body = await openCompileTab();

    const icon = card(body, "lci-lint-1").querySelector('[data-testid="card-icon"]');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("data-icon-tintable")).toBe("true");
    expect(icon!.textContent ?? "").toBe("");
    const glyph = icon!.querySelector('[data-testid="icon-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.className).toMatch(/\bapp-icon-mask\b/);
    expect(glyph!.getAttribute("data-kind")).toBe("lint");
  });

  test("the stylesheet paints the lint glyph with a mask of its own, distinct from the compile wrench and the test flask", () => {
    const maskOf = (kind: string): string | undefined => {
      const selector = `.app-icon-mask[data-kind="${kind}"]`;
      const at = STYLES_SRC.indexOf(selector);
      if (at === -1) return undefined;
      const open = STYLES_SRC.indexOf("{", at);
      const close = STYLES_SRC.indexOf("}", open);
      const ruleBody = STYLES_SRC.slice(open + 1, close);
      const mask = /--icon-mask:\s*([^;]+);/.exec(ruleBody);
      return mask === null ? undefined : mask[1]!.trim();
    };
    const lint = maskOf("lint");
    const compile = maskOf("compile");
    const testMask = maskOf("test");
    expect(compile).toBeDefined();
    expect(testMask).toBeDefined();
    expect(lint).toBeDefined();
    expect(lint!).toMatch(/^url\(/);
    expect(lint).not.toBe(compile);
    expect(lint).not.toBe(testMask);
  });

  // GUARD — passes today: a compile card beside lint cards is unchanged.
  // It fails if the lint wording or icon leaks onto compile records.
  test("a compile card beside lint cards is unchanged: '1 errors' in the fail-red class and a glyph of data-kind 'compile'", async () => {
    const key = "lint-card-guard-1";
    const now = Date.now();
    await mountApp({
      key,
      events: [
        compileBrief(key, "lcg-compile-1", now - 3000),
        goVetBrief(key, "lcg-lint-fail", now - 2000),
        ruffCleanBrief(key, "lcg-lint-clean", now - 1000),
      ],
    });
    const body = await openCompileTab();

    const compileCard = card(body, "lcg-compile-1");
    const pill = compileCard.querySelector('[data-testid="ratio-pill"]');
    expect(textOf(pill)).toBe("1 errors");
    expect(pill!.className).toContain("app-ratio-fail");
    expect(compileCard.querySelector('[data-testid="icon-glyph"]')!.getAttribute("data-kind")).toBe("compile");
    expect(textOf(compileCard)).not.toContain("lint");
  });

  test("a failing lint card with one error reads '1 lint error' (singular) in the fail-red class", async () => {
    const key = "lint-card-one-1";
    const now = Date.now();
    const failing = goVetBrief(key, "lco-lint-1", now - 1000);
    await mountApp({
      key,
      events: [{ ...failing, errors: 1, diagnostics: failing.diagnostics!.slice(0, 1) }],
    });
    const body = await openCompileTab();

    const pill = card(body, "lco-lint-1").querySelector('[data-testid="ratio-pill"]');
    expect(pill).not.toBeNull();
    expect(textOf(pill)).toBe("1 lint error");
    expect(pill!.className).toContain("app-ratio-fail");
  });
});

// ── The drill-in ────────────────────────────────────────────────────────────

const CLIPPY_RAW = [
  "error: unneeded `return` statement",
  "  --> src/store.rs:91:9",
  "error: redundant clone",
  "  --> src/checkpoint.rs:57:22",
  "warning: this let-binding has unit value",
  "  --> src/store.rs:120:5",
].join("\n");

function clippyLint(key: string, id: string, timestamp: number): { brief: EventBriefFixture; detail: EventDetailFixture } {
  const diagnostics: DiagnosticFixture[] = [
    { file: "src/store.rs", line: 91, col: 9, code: "clippy::needless_return", message: "unneeded `return` statement", level: "error" },
    { file: "src/checkpoint.rs", line: 57, col: 22, code: "clippy::redundant_clone", message: "redundant clone", level: "error" },
    { file: "src/store.rs", line: 120, col: 5, code: "clippy::let_unit_value", message: "this let-binding has unit value", level: "warning" },
  ];
  return {
    brief: {
      id,
      projectKey: key,
      agentId: "tidy-agent-GREEN",
      kind: "compile",
      tier: "unit",
      codec: "clippy",
      timestamp,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      duration_ms: 0,
      hasCoverage: false,
      errors: 2,
      warnings: 1,
      diagnostics: diagnostics.slice(0, 2),
      lint: "clippy",
    },
    detail: {
      id,
      projectKey: key,
      agentId: "tidy-agent-GREEN",
      kind: "compile",
      tier: "unit",
      codec: "clippy",
      timestamp,
      compile: { format: "clippy", errorCount: 2, warningCount: 1, diagnostics, raw: CLIPPY_RAW },
      lint: "clippy",
    },
  };
}

/** Opens the Compile tab, clicks the card `id`, and answers the workspace body. */
async function openDrillIn(id: string): Promise<Element> {
  const body = await openCompileTab();
  (card(body, id) as HTMLElement).click();
  await settle();
  const after = document.querySelector('[data-testid="workspace-body"]');
  expect(after).not.toBeNull();
  // The detail has opened in the pane: its status line is there.
  expect(after!.querySelector('[data-testid="compile-status"]')).not.toBeNull();
  return after!;
}

function diagGroup(root: ParentNode, file: string): Element {
  const hit = Array.from(root.querySelectorAll('[data-testid="diag-group"]')).filter((g) =>
    (g.textContent ?? "").includes(file),
  );
  expect(hit.length).toBe(1);
  return hit[0]!;
}

describe("a lint record's drill-in shows its findings by file with their rule codes", () => {
  test("a failing clippy lint record's drill-in groups its findings by file, each group showing its own findings' clippy codes, and keeps the raw-output toggle", async () => {
    const key = "lint-drill-clippy-1";
    const now = Date.now();
    const fx = clippyLint(key, "ldc-lint-1", now - 1000);
    await mountApp({ key, events: [fx.brief], eventDetails: { "ldc-lint-1": fx.detail } });
    const body = await openDrillIn("ldc-lint-1");

    expect(body.querySelectorAll('[data-testid="diag-group"]').length).toBe(2);
    const store = diagGroup(body, "src/store.rs");
    const checkpoint = diagGroup(body, "src/checkpoint.rs");
    expect(store.textContent ?? "").toContain("clippy::needless_return");
    expect(store.textContent ?? "").toContain("clippy::let_unit_value");
    expect(store.textContent ?? "").not.toContain("clippy::redundant_clone");
    expect(checkpoint.textContent ?? "").toContain("clippy::redundant_clone");
    expect(checkpoint.textContent ?? "").not.toContain("clippy::needless_return");
    expect(store.querySelectorAll('[data-testid="diag-line"]').length).toBe(2);
    expect(checkpoint.querySelectorAll('[data-testid="diag-line"]').length).toBe(1);

    const rawToggle = body.querySelector('[data-testid="raw-toggle"]') as HTMLElement | null;
    expect(rawToggle).not.toBeNull();
    rawToggle!.click();
    await settle();
    const raw = document.querySelector('[data-testid="raw-output"]');
    expect(raw).not.toBeNull();
    expect(raw!.textContent ?? "").toContain("unneeded `return` statement");
  });

  test("a ruff lint record's drill-in shows the F401 code on its file's finding", async () => {
    const key = "lint-drill-ruff-1";
    const now = Date.now();
    const id = "ldr-lint-1";
    const diagnostics: DiagnosticFixture[] = [
      { file: "app/main.py", line: 1, col: 8, code: "F401", message: "`os` imported but unused", level: "error" },
    ];
    await mountApp({
      key,
      events: [{ ...ruffCleanBrief(key, id, now - 1000), errors: 1, diagnostics }],
      eventDetails: {
        [id]: {
          id,
          projectKey: key,
          agentId: "vidushi",
          kind: "compile",
          tier: "unit",
          codec: "ruff",
          timestamp: now - 1000,
          compile: {
            format: "ruff",
            errorCount: 1,
            warningCount: 0,
            diagnostics,
            raw: "app/main.py:1:8: F401 [*] `os` imported but unused\nFound 1 error.",
          },
          lint: "ruff",
        },
      },
    });
    const body = await openDrillIn(id);

    const main = diagGroup(body, "app/main.py");
    expect(main.textContent ?? "").toContain("F401");
    expect(main.textContent ?? "").toContain("`os` imported but unused");
  });

  test("a clean lint record's drill-in reads 'clean lint — no findings', never the compile empty line", async () => {
    const key = "lint-drill-clean-1";
    const now = Date.now();
    const id = "ldl-lint-1";
    await mountApp({
      key,
      events: [ruffCleanBrief(key, id, now - 1000)],
      eventDetails: {
        [id]: {
          id,
          projectKey: key,
          agentId: "vidushi",
          kind: "compile",
          tier: "unit",
          codec: "ruff",
          timestamp: now - 1000,
          compile: { format: "ruff", errorCount: 0, warningCount: 0, diagnostics: [], raw: "All checks passed!" },
          lint: "ruff",
        },
      },
    });
    const body = await openDrillIn(id);

    expect(body.textContent ?? "").toContain("clean lint — no findings");
    expect(body.textContent ?? "").not.toContain("clean compile — no diagnostics");
    expect(body.querySelector('[data-testid="diag-group"]')).toBeNull();
  });

  // GUARD — passes today: a compile record's drill-in is unchanged — its
  // diagnostic line shows no code, and a clean one keeps the compile empty
  // line. It fails if the lint drill-in's codes or wording leak onto compile.
  test("a compile record's drill-in is unchanged: its line reads 'file:line:col — message' with no code, and a clean one reads 'clean compile — no diagnostics'", async () => {
    const key = "lint-drill-guard-1";
    const now = Date.now();
    const brief = compileBrief(key, "ldg-compile-1", now - 2000);
    const clean: EventBriefFixture = { ...compileBrief(key, "ldg-compile-clean", now - 1000), errors: 0, diagnostics: [] };
    const details: Record<string, EventDetailFixture> = {
      "ldg-compile-1": {
        id: "ldg-compile-1",
        projectKey: key,
        agentId: "build-agent-RED",
        kind: "compile",
        tier: "unit",
        codec: "rustc",
        timestamp: now - 2000,
        compile: {
          format: "rustc",
          errorCount: 1,
          warningCount: 0,
          diagnostics: brief.diagnostics!,
          raw: "error[E0308]: mismatched types\n --> src/checkpoint.rs:142:9",
        },
      },
      "ldg-compile-clean": {
        id: "ldg-compile-clean",
        projectKey: key,
        agentId: "build-agent-RED",
        kind: "compile",
        tier: "unit",
        codec: "rustc",
        timestamp: now - 1000,
        compile: { format: "rustc", errorCount: 0, warningCount: 0, diagnostics: [], raw: "" },
      },
    };

    await mountApp({ key, events: [brief, clean], eventDetails: details });
    let body = await openDrillIn("ldg-compile-1");
    const lines = body.querySelectorAll('[data-testid="diag-line"]');
    expect(lines.length).toBe(1);
    expect(textOf(lines[0]!)).toBe("src/checkpoint.rs:142:9 — mismatched types");
    expect(textOf(diagGroup(body, "src/checkpoint.rs"))).not.toContain("E0308");

    await mountApp({ key, events: [brief, clean], eventDetails: details });
    body = await openDrillIn("ldg-compile-clean");
    expect(body.textContent ?? "").toContain("clean compile — no diagnostics");
    expect(body.textContent ?? "").not.toContain("clean lint");
  });
});

// ── The drill-in's heading ──────────────────────────────────────────────────────────
//
// A lint record's drill-in is headed by its tool — `<tool> lint · N errors ·
// M warnings` — never by the decoder that read its output. A compile record's
// is headed by its format, as before.

/** The drill-in's heading line (`[data-testid="compile-status"]`), as text. */
function drillInHeading(body: Element): string {
  const heading = body.querySelector('[data-testid="compile-status"]');
  expect(heading).not.toBeNull();
  return textOf(heading);
}

/** A failing clang-tidy lint record, decoded through gcc: two errors, no warning. */
function clangTidyLint(key: string, id: string, timestamp: number): { brief: EventBriefFixture; detail: EventDetailFixture } {
  const diagnostics: DiagnosticFixture[] = [
    { file: "src/main.c", line: 4, col: 13, code: "readability-braces-around-statements", message: "statement should be inside braces", level: "error" },
    { file: "src/util.c", line: 9, col: 5, code: "bugprone-branch-clone", message: "repeated branch body in conditional chain", level: "error" },
  ];
  const common = { id, projectKey: key, agentId: "tidy-agent-GREEN", kind: "compile" as const, tier: "unit", codec: "gcc", timestamp };
  return {
    brief: {
      ...common,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      duration_ms: 0,
      hasCoverage: false,
      errors: 2,
      warnings: 0,
      diagnostics,
      lint: "clang-tidy",
    },
    detail: {
      ...common,
      compile: {
        format: "gcc",
        errorCount: 2,
        warningCount: 0,
        diagnostics,
        raw: [
          "src/main.c:4:13: error: statement should be inside braces [readability-braces-around-statements,-warnings-as-errors]",
          "src/util.c:9:5: error: repeated branch body in conditional chain [bugprone-branch-clone,-warnings-as-errors]",
        ].join("\n"),
      },
      lint: "clang-tidy",
    },
  };
}

describe("a lint record's drill-in is headed '<tool> lint · N errors · M warnings'", () => {
  test("a clang-tidy lint record decoded through gcc is headed exactly 'clang-tidy lint · 2 errors · 0 warnings', never by gcc", async () => {
    const key = "lint-heading-tidy-1";
    const now = Date.now();
    const fx = clangTidyLint(key, "lht-lint-1", now - 1000);
    await mountApp({ key, events: [fx.brief], eventDetails: { "lht-lint-1": fx.detail } });
    const body = await openDrillIn("lht-lint-1");

    const heading = drillInHeading(body);
    expect(heading).toBe("clang-tidy lint · 2 errors · 0 warnings");
    expect(heading).not.toContain("gcc");
  });

  test("a clippy lint record is headed exactly 'clippy lint · 2 errors · 2 warnings'", async () => {
    const key = "lint-heading-clippy-1";
    const now = Date.now();
    const fx = clippyLint(key, "lhc-lint-1", now - 1000);
    const extraWarning: DiagnosticFixture = {
      file: "src/checkpoint.rs",
      line: 60,
      col: 1,
      code: "clippy::let_unit_value",
      message: "this let-binding has unit value",
      level: "warning",
    };
    const detail: EventDetailFixture = {
      ...fx.detail,
      compile: { ...fx.detail.compile, warningCount: 2, diagnostics: [...fx.detail.compile.diagnostics, extraWarning] },
    };
    await mountApp({ key, events: [{ ...fx.brief, warnings: 2 }], eventDetails: { "lhc-lint-1": detail } });
    const body = await openDrillIn("lhc-lint-1");

    expect(drillInHeading(body)).toBe("clippy lint · 2 errors · 2 warnings");
  });

  // GUARD — passes today: a compile record's drill-in keeps its format as its
  // heading. It fails if the lint heading leaks onto compile records.
  test("a compile record's drill-in heading is unchanged: exactly 'rustc · 1 errors · 0 warnings', with no 'lint'", async () => {
    const key = "lint-heading-guard-1";
    const now = Date.now();
    const brief = compileBrief(key, "lhg-compile-1", now - 1000);
    const detail: EventDetailFixture = {
      id: "lhg-compile-1",
      projectKey: key,
      agentId: "build-agent-RED",
      kind: "compile",
      tier: "unit",
      codec: "rustc",
      timestamp: now - 1000,
      compile: {
        format: "rustc",
        errorCount: 1,
        warningCount: 0,
        diagnostics: brief.diagnostics!,
        raw: "error[E0308]: mismatched types\n --> src/checkpoint.rs:142:9",
      },
    };
    await mountApp({ key, events: [brief], eventDetails: { "lhg-compile-1": detail } });
    const body = await openDrillIn("lhg-compile-1");

    const heading = drillInHeading(body);
    expect(heading).toBe("rustc · 1 errors · 0 warnings");
    expect(heading).not.toContain("lint");
  });
});
