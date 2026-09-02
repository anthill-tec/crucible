// CR-CRU-078 — VISUAL FIDELITY: AC21–AC26.
//
// Spec: docs/changes/CR-CRU-078-roadmap-graph-and-table-together.md
//       "Visual fidelity — asserted against the design document, not taste"
//       AC21 (shape grammar), AC22 (colour semantics),
//       AC23 (colour is never the only channel), AC24 (motion means live),
//       AC25 (zone order and identity), AC26 (no layout engine).
//
// BINDING DESIGN SOURCE, in the order the DN itself declares:
//   docs/research/DN-crucible-roadmap-view.md
//     §"Visual contract (approved 2026-08-28) — BINDING on implementation"
//   .lavish/crucible-workflow-flowchart.html §1–§8/§14 — the richer reference
//     WHERE PRESENT (it is gitignored, so the DN section governs when it is
//     not). Every shape, colour token and motion rule asserted below is read
//     off one of those two and never off taste.
//
// WHY THIS IS A SIBLING SUITE and not an edit to the C1–C4 files.
// The four landed roadmap suites are BEHAVIOURAL and run entirely in happy-dom,
// which has no layout engine and no cascade: tests/roadmap-release-focus.test.ts
// says so in as many words ("happy-dom runs no layout engine, so the strip would
// measure a zero track") and installs a stubbed `getBoundingClientRect`. AC21 and
// AC25 are asserted on GEOMETRY and COMPUTED STYLE, so they cannot live in a
// suite whose geometry is a stub — a rotated square's bounding box, a resolved
// `border-radius` and an animated `border-color` only exist where a real engine
// runs. This file therefore does two things no other roadmap suite does:
//   1. it renders the REAL production components in happy-dom and serialises
//      the resulting markup — so the fixture under measurement is the shipped
//      DOM, never a hand-written stand-in;
//   2. it serves that markup, with the REAL public/styles.css fetched over HTTP
//      from a throwaway static server on a free port, into headless Chromium,
//      and measures it there.
// Retiring or widening a behavioural suite to carry this would couple paging
// correctness to a browser launch. The split is the point.
//
// RED phase — expected to FAIL against current production, which by C4's own
// admission left the look alone: public/styles.css §S2/§S4 say "the shape
// grammar, the colour semantics and the motion are CR-CRU-078 C5" and §S7 says
// "the palette, weight and motion of both are the design document's".
// Concretely:
//   • a release gate is a 4px-radius RECTANGLE, not a diamond — no `transform`
//     anywhere on the strip or the flow gate, so AC21's rotation and diagonal
//     bounding box are absent;
//   • no node carries a state colour at all: `.app-flow-node` has one neutral
//     `var(--line)` border for COMPLETED, COMPLETED_UNTRACKED, IN_PROGRESS and
//     PENDING alike, so AC22 has nothing to read;
//   • nothing on the roadmap animates, so AC24's IN_PROGRESS node never changes
//     across frames;
//   • the three zones carry no `data-zone` identity, so AC25 cannot name them.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";
import type { Browser, Page } from "playwright";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

/** Six sources are read in lockstep and every one must resolve against the
 *  repo root rather than the cwd the runner happens to have. */
const readSource = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const VAN_SRC = readSource("public/vendor/van-1.5.5.nomodule.min.js");
const VAN_X_SRC = readSource("public/vendor/van-x-0.6.3.nomodule.min.js");
const APP_JS_SRC = readSource("public/app.js");
const APP_LOGIC_SRC = readSource("public/app-logic.mjs");
const INDEX_HTML_SRC = readSource("public/index.html");
const STYLES_SRC = readSource("public/styles.css");
const APP_LOGIC_PATH = path.join(PUBLIC_DIR, "app-logic.mjs");

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// ONE board, shaped so that every AC21–AC25 assertion has a live subject AND a
// counter-subject on the same page:
//   • two SHIPPED gates and two PROPOSED ones, so the dashed-border diamond
//     (AC21) is measured beside a solid one and the DIMMED non-focused release
//     (AC22) beside the focused one;
//   • focus lands on `0.2.0` — `releaseStripFocusIndex` picks the first
//     PROPOSED gate, and only a proposed release draws wave containers (a
//     shipped one draws AC8's delivered summary), so zone 2 has CR leaves to
//     measure;
//   • `0.2.0` carries all FOUR `QueueStatus` values, so AC22 has one node per
//     colour and AC24 has static nodes to prove nothing else moves;
//   • two of its PENDING rows carry AC27's lifecycle second axis (`SUPERSEDED`
//     and `VOID`), which AC23 must keep legible with colour stripped;
//   • members spread over TWO waves, so AC21's "box containing its CRs" is
//     measured on two containers and not on a single degenerate one.

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
}

interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  seq?: number;
  release?: string;
  track?: string;
  lifecycle?: LifecycleFixture;
}

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
  timestamp: number;
}

interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** Epoch SECONDS, as `releaseBrief` publishes them. */
const SHIP_010 = 1787149125; // 2026-08-19
const SHIP_011 = SHIP_010 + 86_400;
const TARGET_020 = 1790000000; // 2026-09-21
const RETIRED_AT = 1787200000000; // a lifecycle `at` is epoch MILLISECONDS

const SHIPPED: ReleaseFixture[] = [
  {
    version: "0.1.0",
    commit: "c07274c",
    releasedAt: SHIP_010,
    crs: ["CR-V-SHIPPED-A", "CR-V-SHIPPED-B"],
    packages: [{ registry: "npm", name: "@anthill-tec/crucible-server", version: "0.1.0" }],
    timestamp: SHIP_010 * 1000,
  },
  {
    version: "0.1.1",
    commit: "d18395d",
    releasedAt: SHIP_011,
    crs: ["CR-V-SHIPPED-B"],
    packages: [],
    timestamp: SHIP_011 * 1000,
  },
];

/**
 * AC28's ORDER fixture: THREE shipped tags, newest-first exactly as
 * `listReleases` publishes them. Three, not the two above, because two gates
 * cannot distinguish ascending from descending under a stable sort — which is
 * how the blocker §S9 corrected on 2026-08-28 passed review in the first place.
 * Kept a SEPARATE fixture so the geometry every other test measures (four
 * gates at a fixed board width) is untouched.
 */
const ORDERED_SHIPPED: ReleaseFixture[] = [
  {
    version: "0.1.2",
    commit: "9ef24b1",
    releasedAt: SHIP_010 + 86_400 * 2,
    crs: [],
    packages: [],
    timestamp: (SHIP_010 + 86_400 * 2) * 1000,
  },
  {
    version: "0.1.1",
    commit: "d18395d",
    releasedAt: SHIP_011,
    crs: [],
    packages: [],
    timestamp: SHIP_011 * 1000,
  },
  {
    version: "0.1.0",
    commit: "c07274c",
    releasedAt: SHIP_010,
    crs: [],
    packages: [],
    timestamp: SHIP_010 * 1000,
  },
];

/** `0.2.0` first (it is the focus target), `0.3.0` second and DATELESS — the
 *  AC6 "no target declared" gate, kept here so a NON-FOCUSED proposed diamond
 *  exists to measure the dash and the dimming against. */
const PROPOSALS: ProposalFixture[] = [
  { label: "0.2.0", targetAt: TARGET_020, timestamp: RETIRED_AT, waves: ["W1", "W2"] },
  { label: "0.3.0", timestamp: RETIRED_AT, waves: ["W3"] },
];

/** The CRs of the FOCUSED release, in the order the assertions expect them —
 *  which is the authored `seq` order, because nothing may re-derive it (AC26). */
const FOCUSED_CRS = [
  "CR-V-DONE",
  "CR-V-UNTRACKED",
  "CR-V-LIVE",
  "CR-V-PEND",
  "CR-V-SUP",
  "CR-V-VOID",
];

const QUEUE: QueueFixture[] = [
  {
    cr: "CR-V-SHIPPED-A",
    title: "CR-V-SHIPPED-A — the first delivered change",
    wave: "W0",
    dependsOn: [],
    status: "COMPLETED",
    seq: 1,
    release: "0.1.0",
  },
  {
    cr: "CR-V-SHIPPED-B",
    title: "CR-V-SHIPPED-B — the second delivered change",
    wave: "W0",
    dependsOn: [],
    status: "COMPLETED",
    seq: 2,
    release: "0.1.0",
  },
  // ── 0.2.0, wave W1 — the three states that carry a colour of their own ──
  {
    cr: "CR-V-DONE",
    title: "CR-V-DONE — merged inside the focused release",
    wave: "W1",
    dependsOn: [],
    status: "COMPLETED",
    seq: 10,
    release: "0.2.0",
    track: "1",
  },
  {
    cr: "CR-V-UNTRACKED",
    title: "CR-V-UNTRACKED — shipped before plan tracking existed",
    wave: "W1",
    dependsOn: [],
    status: "COMPLETED_UNTRACKED",
    seq: 11,
    release: "0.2.0",
    track: "1",
  },
  {
    cr: "CR-V-LIVE",
    title: "CR-V-LIVE — the one thing that is happening right now",
    wave: "W1",
    dependsOn: ["CR-V-DONE"],
    status: "IN_PROGRESS",
    seq: 12,
    release: "0.2.0",
    track: "1",
  },
  // ── 0.2.0, wave W2 — PENDING, plus AC27's second axis on two of them ────
  {
    cr: "CR-V-PEND",
    title: "CR-V-PEND — nothing to report yet",
    wave: "W2",
    dependsOn: [],
    status: "PENDING",
    seq: 13,
    release: "0.2.0",
    track: "2",
  },
  {
    cr: "CR-V-SUP",
    title: "CR-V-SUP — the work moved elsewhere",
    wave: "W2",
    dependsOn: [],
    status: "PENDING",
    seq: 14,
    release: "0.2.0",
    track: "2",
    lifecycle: { state: "SUPERSEDED", by: "CR-V-LIVE", at: RETIRED_AT },
  },
  {
    cr: "CR-V-VOID",
    title: "CR-V-VOID — abandoned outright",
    wave: "W2",
    dependsOn: [],
    status: "PENDING",
    seq: 15,
    release: "0.2.0",
    track: "2",
    lifecycle: { state: "VOID", reason: "the surface it targeted was retired", at: RETIRED_AT },
  },
];

/** CR-CRU-096 §S5/AC9/AC9a — what a WAVE box draws once the trim lands: the
 *  top of the scheduled queue plus what is running. `CR-V-DONE` and
 *  `CR-V-UNTRACKED` are merged and roll up; `CR-V-SUP` and `CR-V-VOID` carry a
 *  disposition and are not work. So the two boxes above draw one row each. */
const DRAWN_CRS = ["CR-V-LIVE", "CR-V-PEND"];

/** The SAME six CRs, declaring NO wave (`wave: ""` — the wire's own way of
 *  declaring none, `src/types.ts:392`).
 *
 *  CR-CRU-096 AC18a rules that the `wave: null` group takes the row
 *  ARRANGEMENT but NOT the trim: with no header it has nowhere to state whole
 *  membership and no anchor for a `+N more` pointer, so it draws every member.
 *  That makes it the surface on which the merged and dimmed FACES this suite
 *  measures are still rendered — the stylesheet still declares them
 *  (`public/styles.css` `.app-flow-node.completed`, `.completed_untracked`),
 *  and a face is measured where it is drawn. */
const LOOSE_QUEUE: QueueFixture[] = QUEUE.map((entry) =>
  entry.release === "0.2.0" ? { ...entry, wave: "" } : entry,
);

// ── happy-dom capture: the REAL production DOM, serialised ───────────────────
//
// The subject under measurement must be what public/app.js actually renders, so
// it is rendered by public/app.js — mounted in happy-dom against a scripted
// fetch, exactly the harness tests/roadmap-release-focus.test.ts established —
// and then serialised. Nothing here writes roadmap markup by hand.

const TRACK_W = 1200;
const PITCH = 132; // the stylesheet's own `--app-strip-gate-pitch`

function stubRect(left: number, width: number): DOMRect {
  const box = {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => box,
  };
  // A DOMRect the harness fabricates: happy-dom has no layout engine, so there
  // is no real rect to narrow from.
  const asRect = box as unknown as DOMRect;
  return asRect;
}

/** happy-dom measures every box as zero, and the strip's window size is a
 *  MEASUREMENT — an unmeasured strip renders no gates at all (C2's
 *  `stripWindowSize` returns 0 deliberately, never a fallback constant). Only
 *  the track and the ruler are answered, and with the real 132px pitch, so the
 *  captured markup is the window a real 1200px track would hold. */
function installLayout(): void {
  // `Element.prototype` is a happy-dom global with no declared mutable
  // `getBoundingClientRect` slot; the cast names the one member being patched.
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip-track") return stubRect(0, TRACK_W);
    if (testid === "roadmap-strip-ruler") return stubRect(0, PITCH);
    return stubRect(0, 0);
  };
}

interface CaptureOpts {
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
}

let cacheBust = 0;

/** Mount the production shell on the Roadmap route and return the serialised
 *  `[data-testid="roadmap-zones"]` subtree. */
async function captureZones(opts: CaptureOpts = {}): Promise<string> {
  const key = "visual-key";
  // Saved and restored by hand: the scripted fetch below is installed AFTER
  // registration, so `GlobalRegistrator.unregister` would not put it back.
  const realFetch = globalThis.fetch;
  try {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
    document.body.innerHTML = '<div id="app"></div>';
    installLayout();

    const okResponse = (body: unknown): Response => {
      // A minimal stand-in for the two members app.js reads off a Response.
      const stub = { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
      return stub as unknown as Response;
    };

    const scriptedFetch = async (url: string): Promise<Response> => {
      // Order matters: `/release-proposals` must not be swallowed by `/releases`.
      if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
        const proposals = opts.proposals ?? PROPOSALS;
        return okResponse({ ok: true, proposals, totalCount: proposals.length });
      }
      if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
        return okResponse({ ok: true, releases: opts.releases ?? SHIPPED });
      }
      if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
        return okResponse({ ok: true, entries: opts.queue ?? QUEUE });
      }
      if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
        return okResponse({ ok: true, plans: [] });
      }
      if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
      if (url.includes("/api/v2/projects")) {
        return okResponse({
          ok: true,
          projects: [
            {
              key,
              name: key,
              type: "backend",
              agentsOnline: 0,
              agentsTotal: 0,
              active: true,
              lastActivity: Date.now(),
            },
          ],
        });
      }
      if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
      if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
      if (url.includes("/api/v2/health")) {
        return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
      }
      throw new Error(`roadmap-visual-grammar captureZones: unexpected fetch url ${url}`);
    };
    // `globalThis.fetch` is typed as the readonly platform binding; the cast
    // names the single slot the harness scripts.
    const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
    scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

    (0, eval)(VAN_SRC);
    (0, eval)(VAN_X_SRC);

    // Dynamic import is REQUIRED, not a style choice: the specifier carries a
    // per-capture cache-bust query so the module re-evaluates into the FRESH
    // happy-dom global each time. A static import would bind once, to the
    // globals of the first capture. House harness pattern, shared with
    // tests/roadmap-release-strip.test.ts and tests/roadmap-release-focus.test.ts.
    cacheBust += 1;
    await import(`${APP_LOGIC_PATH}?roadmapVisualGrammar=${cacheBust}`);

    (0, eval)(APP_JS_SRC);

    // REAL timers, deliberately: the subject is the production shell driving
    // its own fetch chain and van.js's real reactive scheduler inside
    // happy-dom, plus the strip's own measure tick. A faked clock would freeze
    // the render pass being captured. Same reasoning, verbatim, as
    // tests/roadmap-release-focus.test.ts's `settle`.
    for (let i = 0; i < 10; i++) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }

    const zones = document.querySelector('[data-testid="roadmap-zones"]');
    if (zones === null) throw new Error("captureZones: no [data-testid=roadmap-zones] rendered");
    return zones.outerHTML;
  } finally {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    const restore = globalThis as unknown as { fetch: typeof fetch };
    restore.fetch = realFetch;
  }
}

// ── The throwaway static server + Chromium ──────────────────────────────────
//
// The stylesheet is fetched over HTTP from public/ rather than inlined: an
// inlined copy would assert a string this test built, and the AC is about the
// stylesheet the app ships. Port 0 — the OS picks a free one.

let server: Server<undefined> | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let populatedZones = "";
let emptyZones = "";
let orderedZones = "";
let looseZones = "";
let fixtureUrl = "";
let emptyFixtureUrl = "";
let orderedFixtureUrl = "";
let looseFixtureUrl = "";

/** A page that is the app's own document shell (theme attribute, real
 *  stylesheet link) wrapping the captured zones — and NO script at all, so
 *  nothing can re-lay-out what is being measured. */
const fixtureDocument = (zones: string): string =>
  `<!doctype html>
<html lang="en" data-theme="forge">
<head>
<meta charset="utf-8">
<title>CR-CRU-078 AC21-AC26 fixture</title>
<link rel="stylesheet" href="/styles.css">
<style>
  /* The measured board sits at a FIXED width so every geometry assertion is
     deterministic, and wide enough that the strip's four gates are never
     clipped by the .app-strip-track overflow. */
  body { margin: 0; }
  #app { width: 1360px; }
</style>
</head>
<body>
<div id="app"><div class="app-pane-content" data-testid="pane-scroll">${zones}</div></div>
</body>
</html>`;

/** The page handle, narrowed once for the ~30 call sites that would otherwise
 *  each repeat the null check. */
const pageEl = (): Page => {
  if (page === null) throw new Error("roadmap-visual-grammar: no Chromium page");
  return page;
};

beforeAll(async () => {
  populatedZones = await captureZones();
  emptyZones = await captureZones({ releases: [], proposals: [], queue: [] });
  // Only the DATED proposal: AC28's seam clause compares the last shipped date
  // with the first proposed one, and the shared fixture's second proposal is
  // deliberately dateless (AC6), which is a different assertion's subject.
  orderedZones = await captureZones({ releases: ORDERED_SHIPPED, proposals: [PROPOSALS[0]!] });
  looseZones = await captureZones({ queue: LOOSE_QUEUE });

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/" || pathname === "/fixture") {
        return new Response(fixtureDocument(populatedZones), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-empty") {
        return new Response(fixtureDocument(emptyZones), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-order") {
        return new Response(fixtureDocument(orderedZones), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-loose") {
        return new Response(fixtureDocument(looseZones), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // Static passthrough for public/, restricted to a flat file name so the
      // throwaway server cannot be walked out of the directory it serves.
      const name = pathname.replace(/^\/+/, "");
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        return new Response(Bun.file(path.join(PUBLIC_DIR, name)));
      }
      return new Response("not found", { status: 404 });
    },
  });
  fixtureUrl = `http://127.0.0.1:${server.port}/fixture`;
  emptyFixtureUrl = `http://127.0.0.1:${server.port}/fixture-empty`;
  orderedFixtureUrl = `http://127.0.0.1:${server.port}/fixture-order`;
  looseFixtureUrl = `http://127.0.0.1:${server.port}/fixture-loose`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
}, 180_000);

afterAll(async () => {
  if (page !== null) await page.close();
  if (browser !== null) await browser.close();
  if (server !== null) server.stop(true);
  page = null;
  browser = null;
  server = null;
});

/** Every test starts from a clean load: the AC23 experiment strips colour from
 *  the live document, so no test may inherit another's mutations. */
beforeEach(async () => {
  await pageEl().goto(fixtureUrl, { waitUntil: "load" });
});

/** The AC18a board: every one of the six focused CRs drawn, because the
 *  wave-less group takes no trim. Used by the assertions whose subject is a
 *  FACE a wave box no longer draws (merged, dimmed-merged). */
const looseBoard = async (): Promise<void> => {
  await pageEl().goto(looseFixtureUrl, { waitUntil: "load" });
};

// ── In-browser measurement primitives ──────────────────────────────────────
//
// Injected as a source string, because it runs inside the page. Each reading is
// a MEASUREMENT — a resolved length, a decomposed transform matrix, a rendered
// colour — and never a class name.

interface Measured {
  cr: string;
  status: string;
  testid: string;
  /** The untransformed layout box. */
  boxW: number;
  boxH: number;
  /** The box the rendered shape actually occupies, transform included. */
  bboxW: number;
  bboxH: number;
  /** Rotation decomposed from the computed transform matrix, in degrees. */
  rotation: number;
  /** Where the shape's local top-left corner is actually PAINTED, relative to
   *  the centre of its bounding box. For a 45°-rotated square this is the
   *  apex: dead centre horizontally, at the very top vertically. */
  cornerDx: number;
  cornerDy: number;
  radius: number;
  borderStyle: string;
  borderWidth: number;
  color: string;
  borderColor: string;
  opacity: number;
  text: string;
}

const MEASURE_FN = `
function __measure(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform);
  const rotation = Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI);
  const boxW = el.offsetWidth;
  const boxH = el.offsetHeight;
  // The local top-left corner, pushed through the SAME matrix the browser
  // composited with, expressed against the centre of the painted bounding box.
  // This is what makes "diamond" a measurement rather than a class reading: a
  // rectangle paints that corner at its bbox's own top-left, while a
  // 45deg-rotated square paints it at the top APEX.
  const corner = m.transformPoint(new DOMPoint(-boxW / 2, -boxH / 2));
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  return {
    cr: el.getAttribute("data-cr") || "",
    status: el.getAttribute("data-status") || "",
    testid: el.getAttribute("data-testid") || "",
    boxW: boxW,
    boxH: boxH,
    bboxW: r.width,
    bboxH: r.height,
    rotation: rotation,
    cornerDx: corner.x,
    cornerDy: corner.y,
    radius: px(cs.borderTopLeftRadius),
    borderStyle: cs.borderTopStyle,
    borderWidth: px(cs.borderTopWidth),
    color: cs.color,
    borderColor: cs.borderTopColor,
    opacity: px(cs.opacity),
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
  };
}
function __measureAll(selector) {
  return Array.from(document.querySelectorAll(selector)).map(__measure);
}
`;

async function measureAll(selector: string): Promise<Measured[]> {
  const raw = await pageEl().evaluate(
    `(() => { ${MEASURE_FN} return __measureAll(${JSON.stringify(selector)}); })()`,
  );
  // The shape is fixed by `__measure` three lines above, in this same file.
  const measured = raw as Measured[];
  return measured;
}

/** The RESOLVED value of one of the app's own custom properties, normalised to
 *  the `rgb(...)` form Chromium reports for `color`. AC22 forbids inventing a
 *  hex value, so every expected colour below is read out of the shipped
 *  stylesheet at runtime instead of being written here. */
async function tokenColor(name: string): Promise<string> {
  const raw = await pageEl().evaluate(
    `(() => {
       const declared = getComputedStyle(document.documentElement)
         .getPropertyValue(${JSON.stringify(name)}).trim();
       if (declared === "") return "";
       const probe = document.createElement("span");
       probe.style.color = declared;
       document.body.appendChild(probe);
       const resolved = getComputedStyle(probe).color;
       probe.remove();
       return resolved;
     })()`,
  );
  const resolved = raw as string;
  return resolved;
}

/** Chromium reports `rgb(r, g, b)` or `rgba(r, g, b, a)`. A token compared
 *  against a rule that tints or fades it must compare on the CHANNELS, with a
 *  ±2 tolerance for the browser's own 8-bit rounding. */
const sameHue = (a: string, b: string): boolean => {
  const channels = (colour: string): [number, number, number] => {
    const m = colour.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (m === null) throw new Error(`unparseable colour ${colour}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return Math.abs(ar - br) <= 2 && Math.abs(ag - bg) <= 2 && Math.abs(ab - bb) <= 2;
};

const nodeFor = (nodes: Measured[], cr: string): Measured => {
  const found = nodes.find((n) => n.cr === cr);
  if (found === undefined) throw new Error(`no measured flowchart node for ${cr}`);
  return found;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC21 — SHAPE GRAMMAR, measured
// ═══════════════════════════════════════════════════════════════════════════
//
// DN §"Shape says what a thing IS": stadium = terminal, diamond = release
// gate, dashed diamond = a proposed release, box = a wave container, leaf
// rectangle = one CR. Nothing below reads a class to decide WHAT it measured;
// the class only says which element to measure, and the assertion is geometry.

describe("AC21 — every element renders as its DECLARED shape (measured)", () => {
  // A stadium is the shape whose ends are FULLY round: its corner radius
  // reaches the half-height, at which point the rounding is a semicircle and
  // no more radius is visible. A 4px-radius rectangle fails this by
  // construction, whatever its class says.
  const expectStadium = (m: Measured, what: string): void => {
    expect(m.rotation, `${what} is not axis-aligned`).toBe(0);
    expect(m.boxH, `${what} has no measurable height`).toBeGreaterThan(0);
    expect(
      m.radius >= m.boxH / 2 - 0.5,
      `${what}: corner radius ${m.radius}px does not reach the half-height ` +
        `${m.boxH / 2}px, so its ends are not round — it is a rectangle`,
    ).toBe(true);
    expect(
      m.boxW > m.boxH,
      `${what}: ${m.boxW}x${m.boxH} — a stadium is longer than it is tall`,
    ).toBe(true);
  };

  // A diamond is a SQUARE turned 45°, and the measurements that prove it are
  // the ones a rectangle can never fake: the painted bounding box is the
  // square's DIAGONAL, and the local top-left corner is painted at the top
  // APEX, centred horizontally. Both are read off the composited matrix.
  const expectDiamond = (m: Measured, what: string): void => {
    expect(Math.abs(m.rotation), `${what}: transform is not a 45° rotation`).toBe(45);
    expect(
      Math.abs(m.boxW - m.boxH) <= 1,
      `${what}: layout box ${m.boxW}x${m.boxH} is not square, so rotating it is not a diamond`,
    ).toBe(true);
    const diagonal = m.boxW * Math.SQRT2;
    expect(
      Math.abs(m.bboxW - diagonal) <= 2,
      `${what}: painted width ${m.bboxW}px is not the ${diagonal.toFixed(1)}px diagonal ` +
        `of its ${m.boxW}px side — it is not drawn on the diagonal`,
    ).toBe(true);
    expect(
      Math.abs(m.bboxH - diagonal) <= 2,
      `${what}: painted height ${m.bboxH}px is not the ${diagonal.toFixed(1)}px diagonal`,
    ).toBe(true);
    expect(
      Math.abs(m.cornerDx) <= 1.5,
      `${what}: its corner is painted ${m.cornerDx.toFixed(1)}px off centre, ` +
        `so no vertex points up — this is a rectangle`,
    ).toBe(true);
    expect(
      Math.abs(m.cornerDy + m.bboxH / 2) <= 1.5,
      `${what}: its corner is painted at dy ${m.cornerDy.toFixed(1)}px, not at the ` +
        `${(-m.bboxH / 2).toFixed(1)}px apex`,
    ).toBe(true);
  };

  // A box / leaf rectangle: axis-aligned, a real border so it is a box at all,
  // and a radius that stops short of the half-height so it never reads as a pill.
  const expectRectangle = (m: Measured, what: string): void => {
    expect(m.rotation, `${what} is not axis-aligned`).toBe(0);
    expect(m.boxW, `${what} has no measurable width`).toBeGreaterThan(0);
    expect(m.boxH, `${what} has no measurable height`).toBeGreaterThan(0);
    expect(Math.abs(m.bboxW - m.boxW), `${what} is transformed`).toBeLessThanOrEqual(0.5);
    expect(m.borderWidth, `${what} draws no border, so it is not a box`).toBeGreaterThan(0);
    expect(
      m.radius < m.boxH / 2,
      `${what}: radius ${m.radius}px reaches the half-height, so it reads as a pill`,
    ).toBe(true);
  };

  /** The gate's own SHAPE element: a gate cell holds its shape and its date
   *  caption, and only the shape is rotated. Found by measurement, not class. */
  const gateShapes = async (selector: string): Promise<Measured[]> => {
    const children = await measureAll(`${selector} > span`);
    return children.filter((c) => Math.abs(c.rotation) === 45);
  };

  test("zone 1 draws exactly one Start and one End, each a stadium", async () => {
    const terminals = await measureAll(
      '[data-testid="roadmap-strip"] [data-testid="roadmap-strip-terminal"]',
    );
    expect(terminals.length).toBe(2);
    const starts = await measureAll('[data-testid="roadmap-strip"] [data-terminal="start"]');
    const ends = await measureAll('[data-testid="roadmap-strip"] [data-terminal="end"]');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(starts[0]!.text).toBe("Start");
    expect(ends[0]!.text).toBe("End");
    expectStadium(starts[0]!, "zone 1 Start terminal");
    expectStadium(ends[0]!, "zone 1 End terminal");
  });

  // The DN's "exactly one Start, one End" is PER FLOW, not per board: the
  // design artifact .lavish/crucible-workflow-flowchart.html draws a `.term`
  // pair inside zone 1's `.flow` AND another inside zone 2's (its lines
  // 142/154 and 159/172), so a board showing both zones shows two pairs.
  // Asserted per zone for exactly that reason.
  test("zone 2 draws exactly one Start and one End, each a stadium", async () => {
    const terminals = await measureAll(
      '[data-testid="roadmap-flow"] [data-testid="roadmap-flow-terminal"]',
    );
    expect(terminals.length).toBe(2);
    const starts = await measureAll('[data-testid="roadmap-flow"] [data-terminal="start"]');
    const ends = await measureAll('[data-testid="roadmap-flow"] [data-terminal="end"]');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expectStadium(starts[0]!, "zone 2 Start terminal");
    expectStadium(ends[0]!, "zone 2 End terminal");
  });

  test("a SHIPPED release is a solid diamond in the strip", async () => {
    const gates = await measureAll('[data-testid="roadmap-gate"][data-kind="shipped"]');
    expect(gates.length).toBe(2);
    const children = await measureAll('[data-testid="roadmap-gate"][data-kind="shipped"] > span');
    const diamonds = await gateShapes('[data-testid="roadmap-gate"][data-kind="shipped"]');
    expect(
      diamonds.length,
      `neither shipped gate draws a diamond — measured rotations ` +
        `[${children.map((c) => c.rotation).join(", ")}]`,
    ).toBe(2);
    for (const diamond of diamonds) {
      expectDiamond(diamond, "a shipped release gate");
      expect(diamond.borderStyle, "a shipped gate's border is not solid").toBe("solid");
    }
  });

  test("a PROPOSED release is a diamond with a DASHED border", async () => {
    const children = await measureAll('[data-testid="roadmap-gate"][data-kind="proposed"] > span');
    const diamonds = await gateShapes('[data-testid="roadmap-gate"][data-kind="proposed"]');
    expect(
      diamonds.length,
      `both proposed gates must draw a diamond — measured rotations ` +
        `[${children.map((c) => c.rotation).join(", ")}]`,
    ).toBe(2);
    for (const diamond of diamonds) {
      expectDiamond(diamond, "a proposed release gate");
      expect(
        diamond.borderStyle,
        "a proposed release's diamond is not dashed, so it reads as already cut",
      ).toBe("dashed");
    }
  });

  test("the focused release's own gate inside zone 2 is a diamond too", async () => {
    const diamonds = await gateShapes('[data-testid="roadmap-flow-gate"]');
    expect(diamonds.length).toBe(1);
    expectDiamond(diamonds[0]!, "zone 2's terminating gate");
    // The focused release is `0.2.0`, a proposal — so this diamond is dashed
    // for the same reason its strip twin is.
    expect(diamonds[0]!.borderStyle).toBe("dashed");
  });

  test("a wave is a BOX that geometrically CONTAINS its CRs", async () => {
    const waves = await measureAll('[data-testid="roadmap-wave"]');
    expect(waves.length).toBe(2);
    for (const wave of waves) expectRectangle(wave, "a wave container");
    // Containment is the whole claim of "a box CONTAINING its CRs", so it is
    // measured as containment: every member's painted box lies inside its
    // wave's painted box.
    const raw = await pageEl().evaluate(
      `(() => {
         const out = [];
         for (const box of document.querySelectorAll('[data-testid="roadmap-wave"]')) {
           const b = box.getBoundingClientRect();
           for (const n of box.querySelectorAll('[data-testid="roadmap-node"]')) {
             const r = n.getBoundingClientRect();
             out.push({
               wave: box.getAttribute("data-wave"),
               cr: n.getAttribute("data-cr"),
               inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 &&
                       r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
             });
           }
         }
         return out;
       })()`,
    );
    const contained = raw as { wave: string; cr: string; inside: boolean }[];
    // CR-CRU-096 §S5 — the rows a wave box DRAWS, not its whole membership:
    // containment is a claim about what is painted, and the merged and
    // dispositioned members are no longer painted here.
    expect(contained.map((entry) => entry.cr)).toEqual(DRAWN_CRS);
    for (const entry of contained) {
      expect(entry.inside, `${entry.cr} is painted outside wave ${entry.wave}'s box`).toBe(true);
    }
  });

  test("a CR is a LEAF rectangle — a box with no node inside it", async () => {
    const nodes = await measureAll('[data-testid="roadmap-node"]');
    expect(nodes.map((n) => n.cr)).toEqual(DRAWN_CRS);
    for (const node of nodes) expectRectangle(node, `CR node ${node.cr}`);
    // …and on the AC18a board, where every FACE is drawn: a merged leaf and a
    // dimmed-merged one are rectangles too, which is the half a trimmed wave
    // box can no longer show.
    await looseBoard();
    const everyFace = await measureAll('[data-testid="roadmap-node"]');
    expect(everyFace.map((n) => n.cr)).toEqual(FOCUSED_CRS);
    for (const node of everyFace) expectRectangle(node, `CR node ${node.cr}`);
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-node"]'))
         .map((n) => n.querySelectorAll('[data-testid="roadmap-node"]').length)`,
    );
    const nested = raw as number[];
    expect(
      nested.every((count) => count === 0),
      "a CR node contains another node, so it is not a leaf",
    ).toBe(true);
  });

  test("no CR leaf and no wave box is rotated — only a gate is", async () => {
    const nodes = await measureAll('[data-testid="roadmap-node"]');
    const waves = await measureAll('[data-testid="roadmap-wave"]');
    for (const m of [...nodes, ...waves]) {
      expect(m.rotation, `${m.cr || m.testid} is rotated, so it reads as a gate`).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC22 — COLOUR SEMANTICS, per state, against the RENDERED colour
// ═══════════════════════════════════════════════════════════════════════════
//
// DN §"Colour says WHERE IT STANDS": COMPLETED green, COMPLETED_UNTRACKED
// dimmed green, IN_PROGRESS ember, PENDING plain/neutral, a release amber, a
// non-focused release dimmed. Every expected colour is READ from the app's own
// custom properties inside the page, never written as a hex literal here.

describe("AC22 — each state renders its declared colour", () => {
  test("COMPLETED is green, drawn from the app's own token", async () => {
    // The merged FACE is drawn on the wave-less board (AC18a): a wave box
    // rolls its merged members up and draws none of them (§S5/AC9).
    await looseBoard();
    const green = await tokenColor("--pass");
    expect(green).not.toBe("");
    const node = nodeFor(await measureAll('[data-testid="roadmap-node"]'), "CR-V-DONE");
    expect(node.status).toBe("COMPLETED");
    expect(
      sameHue(node.color, green),
      `COMPLETED renders ${node.color}, not the --pass green ${green}`,
    ).toBe(true);
  });

  test("COMPLETED_UNTRACKED is the SAME green, DIMMED", async () => {
    await looseBoard();
    const green = await tokenColor("--pass");
    const nodes = await measureAll('[data-testid="roadmap-node"]');
    const tracked = nodeFor(nodes, "CR-V-DONE");
    const untracked = nodeFor(nodes, "CR-V-UNTRACKED");
    expect(untracked.status).toBe("COMPLETED_UNTRACKED");
    expect(
      sameHue(untracked.color, green),
      `COMPLETED_UNTRACKED renders ${untracked.color}, not green — the DN calls it ` +
        `"green, dimmed", so it must stay the same hue`,
    ).toBe(true);
    // Dimmed is a LUMINANCE channel, not a second hue: it must be measurably
    // fainter than the tracked green beside it.
    expect(
      untracked.opacity < tracked.opacity,
      `COMPLETED_UNTRACKED renders at opacity ${untracked.opacity}, the same as ` +
        `COMPLETED's ${tracked.opacity} — it is not dimmed`,
    ).toBe(true);
  });

  test("IN_PROGRESS is ember", async () => {
    const ember = await tokenColor("--ember");
    const node = nodeFor(await measureAll('[data-testid="roadmap-node"]'), "CR-V-LIVE");
    expect(node.status).toBe("IN_PROGRESS");
    expect(
      sameHue(node.color, ember),
      `IN_PROGRESS renders ${node.color}, not the --ember ${ember}`,
    ).toBe(true);
  });

  test("PENDING is plain/neutral — it borrows no state hue", async () => {
    const dim = await tokenColor("--ink-dim");
    const green = await tokenColor("--pass");
    const ember = await tokenColor("--ember");
    const amber = await tokenColor("--heat");
    const node = nodeFor(await measureAll('[data-testid="roadmap-node"]'), "CR-V-PEND");
    expect(node.status).toBe("PENDING");
    expect(
      sameHue(node.color, dim),
      `PENDING renders ${node.color}, not the neutral --ink-dim ${dim}`,
    ).toBe(true);
    for (const [name, taken] of [
      ["green", green],
      ["ember", ember],
      ["amber", amber],
    ] as const) {
      expect(sameHue(node.color, taken), `PENDING has borrowed the ${name} state colour`).toBe(
        false,
      );
    }
  });

  test("the four states are four DISTINGUISHABLE rendered faces", async () => {
    await looseBoard();
    const nodes = await measureAll('[data-testid="roadmap-node"]');
    const faces = new Map<string, string>();
    for (const cr of ["CR-V-DONE", "CR-V-UNTRACKED", "CR-V-LIVE", "CR-V-PEND"]) {
      const node = nodeFor(nodes, cr);
      // Colour AND opacity together: "green" and "green, dimmed" are one hue
      // at two luminances by design, so neither channel alone separates them.
      faces.set(cr, `${node.color}|${node.opacity}`);
    }
    expect(
      new Set(faces.values()).size,
      `two states render identically: ${[...faces].map(([k, v]) => `${k}=${v}`).join(" ")}`,
    ).toBe(4);
  });

  test("a release gate is AMBER", async () => {
    const amber = await tokenColor("--heat");
    const shapes = (await measureAll('[data-testid="roadmap-gate"] > span')).filter(
      (s) => Math.abs(s.rotation) === 45,
    );
    expect(shapes.length).toBe(4);
    for (const shape of shapes) {
      expect(
        sameHue(shape.borderColor, amber) || sameHue(shape.color, amber),
        `a release gate renders border ${shape.borderColor} / ink ${shape.color}, ` +
          `neither of which is the --heat amber ${amber}`,
      ).toBe(true);
    }
  });

  test("a NON-FOCUSED release is dimmed, and the focused one is not", async () => {
    expect((await measureAll('[data-testid="roadmap-gate"]')).length).toBe(4);
    const focused = await measureAll('[data-testid="roadmap-gate"][data-focused="true"]');
    expect(focused.length, "exactly one gate is focused").toBe(1);
    const others = await measureAll(
      '[data-testid="roadmap-gate"]:not([data-focused="true"])',
    );
    expect(others.length).toBe(3);
    expect(
      focused[0]!.opacity,
      "the focused release is itself dimmed, so nothing marks it as followed",
    ).toBe(1);
    for (const other of others) {
      expect(
        other.opacity < focused[0]!.opacity,
        `a non-focused release renders at opacity ${other.opacity}, the same as the ` +
          `focused one — the strip does not say which release zones 2 and 3 follow`,
      ).toBe(true);
    }
  });

  test("SUPERSEDED and VOID render distinguishably from each other — on the NODE's own badge and on zone 3's row", async () => {
    // CR-CRU-096 AC9b — AC9a trims the dispositioned PENDING ROW out of a
    // TRIMMED wave box and nothing more: the node's badge STAYS and renders
    // wherever a node renders. So the axis is measured on BOTH surfaces that
    // draw it — zone 3's row here, and the node badge on the AC18a loose
    // board, the untrimmed group where a dispositioned member is drawn.
    const rows = await measureAll('[data-testid="roadmap-lifecycle-badge"]');
    expect(rows.length).toBe(2);
    expect(
      new Set(rows.map((b) => `${b.color}|${b.text}`)).size,
      "the two lifecycle states render identically on zone 3's row",
    ).toBe(2);
    // This board's waves are all declared, so every box is TRIMMED and draws
    // no dispositioned row — hence no node badge on THIS board (AC9a).
    expect((await measureAll('[data-testid="roadmap-node-lifecycle"]')).length).toBe(0);

    await looseBoard();
    const nodes = await measureAll('[data-testid="roadmap-node-lifecycle"]');
    expect(nodes.length, "the untrimmed loose group draws no node badge").toBe(2);
    expect(
      new Set(nodes.map((b) => `${b.color}|${b.text}`)).size,
      "the two lifecycle states render identically on the node badge",
    ).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC23 — COLOUR IS NEVER THE ONLY CHANNEL
// ═══════════════════════════════════════════════════════════════════════════
//
// The test the AC names: strip the colour and check every node's state is still
// determinable. Stripping here is TOTAL and enforced with `!important` — ink,
// border, background AND opacity, so even the "dimmed" luminance channel is
// taken away and only TEXT can be left standing.

const STRIP_COLOUR = `
  *, *::before, *::after {
    color: #000 !important;
    border-color: #000 !important;
    background: #fff !important;
    background-color: #fff !important;
    box-shadow: none !important;
    opacity: 1 !important;
    filter: grayscale(1) !important;
    text-decoration-color: #000 !important;
  }
`;

describe("AC23 — with colour stripped, every state is still determinable", () => {
  beforeEach(async () => {
    await pageEl().addStyleTag({ content: STRIP_COLOUR });
  });

  /** The AC18a board, colour-stripped. Navigating drops an injected style tag,
   *  so the strip is re-applied after the load. Used where the subject is
   *  every FACE, including the merged ones a trimmed wave box no longer draws. */
  const looseBoardStripped = async (): Promise<void> => {
    await looseBoard();
    await pageEl().addStyleTag({ content: STRIP_COLOUR });
  };

  test("colour stripping really does flatten the rendered colours", async () => {
    await looseBoardStripped();
    // The premise, asserted rather than assumed: after the strip there is ONE
    // ink, ONE border colour and ONE opacity across every node, so anything
    // that still separates them is provably not colour.
    const nodes = await measureAll('[data-testid="roadmap-node"]');
    expect(nodes.length).toBe(FOCUSED_CRS.length);
    expect(new Set(nodes.map((n) => n.color)).size).toBe(1);
    expect(new Set(nodes.map((n) => n.borderColor)).size).toBe(1);
    expect(new Set(nodes.map((n) => n.opacity)).size).toBe(1);
  });

  test("each flowchart node states its status in WORDS", async () => {
    await looseBoardStripped();
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-node"]')).map((n) => ({
         cr: n.getAttribute("data-cr"),
         status: n.getAttribute("data-status"),
         statusText: (n.querySelector('[data-testid="roadmap-node-status"]')?.textContent || "")
           .replace(/\\s+/g, " ").trim(),
       }))`,
    );
    const rows = raw as { cr: string; status: string; statusText: string }[];
    expect(rows.length).toBe(FOCUSED_CRS.length);
    for (const row of rows) {
      expect(
        row.statusText,
        `${row.cr} (${row.status}) writes no status text, so with colour gone ` +
          `its state is unreadable`,
      ).not.toBe("");
    }
    // "Determinable" means the text→state mapping is a FUNCTION: one status
    // text must never stand for two different statuses.
    const statesByText = new Map<string, Set<string>>();
    for (const row of rows) {
      const states = statesByText.get(row.statusText) ?? new Set<string>();
      states.add(row.status);
      statesByText.set(row.statusText, states);
    }
    for (const [text, states] of statesByText) {
      expect(
        states.size,
        `the words "${text}" stand for ${[...states].join(" and ")}`,
      ).toBe(1);
    }
    expect(
      new Set(rows.map((r) => r.statusText)).size,
      "the distinct statuses do not produce as many distinct texts",
    ).toBe(new Set(rows.map((r) => r.status)).size);
  });

  test("the table's status badge states its status in WORDS too", async () => {
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-row"]')).map((r) => ({
         cr: r.getAttribute("data-cr"),
         badge: (r.querySelector('[data-testid="roadmap-status-badge"]')?.textContent || "")
           .replace(/\\s+/g, " ").trim(),
       }))`,
    );
    const rows = raw as { cr: string; badge: string }[];
    expect(rows.length).toBe(FOCUSED_CRS.length);
    for (const row of rows) {
      expect(row.badge, `${row.cr}'s row states no status in words`).not.toBe("");
    }
  });

  test("the LIFECYCLE axis survives the strip on BOTH surfaces — the node badge and zone 3's row", async () => {
    // CR-CRU-096 AC9b — measured on the AC18a loose board, the untrimmed
    // group where a dispositioned member still draws a NODE. AC9a's trim only
    // removes such a row from a wave BOX; it never removed the badge, and
    // §S8 forbids `data-lifecycle` being the disposition's only channel — an
    // attribute is not text and does not survive a greyscale screenshot.
    await looseBoardStripped();
    const raw = await pageEl().evaluate(
      `(() => {
         const grab = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => ({
           state: e.getAttribute("data-lifecycle") ||
                  e.closest("[data-lifecycle]")?.getAttribute("data-lifecycle") || "",
           text: (e.textContent || "").replace(/\\s+/g, " ").trim(),
         }));
         return {
           nodes: grab('[data-testid="roadmap-node-lifecycle"]'),
           rows: grab('[data-testid="roadmap-lifecycle-badge"]'),
         };
       })()`,
    );
    const seen = raw as {
      nodes: { state: string; text: string }[];
      rows: { state: string; text: string }[];
    };
    expect(seen.nodes.length).toBe(2);
    expect(seen.rows.length).toBe(2);
    for (const surface of [seen.nodes, seen.rows]) {
      const superseded = surface.find((e) => e.state === "SUPERSEDED");
      const dead = surface.find((e) => e.state === "VOID");
      expect(superseded, "no SUPERSEDED marker").toBeDefined();
      expect(dead, "no VOID marker").toBeDefined();
      expect(superseded!.text.toLowerCase()).toContain("superseded");
      expect(dead!.text.toLowerCase()).toContain("void");
      expect(superseded!.text).not.toBe(dead!.text);
    }
  });

  test("a gate says whether it is shipped or proposed without colour", async () => {
    // The dash is a SHAPE channel, not a colour one, so it must survive the
    // strip: a proposed gate stays dashed and a shipped one stays solid.
    const shipped = (
      await measureAll('[data-testid="roadmap-gate"][data-kind="shipped"] > span')
    ).filter((s) => s.borderWidth > 0);
    const proposed = (
      await measureAll('[data-testid="roadmap-gate"][data-kind="proposed"] > span')
    ).filter((s) => s.borderWidth > 0);
    expect(shipped.length).toBe(2);
    expect(proposed.length).toBe(2);
    expect(shipped.every((s) => s.borderStyle === "solid")).toBe(true);
    expect(proposed.every((s) => s.borderStyle === "dashed")).toBe(true);
    // And each gate carries its date, or its declared absence, in words.
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-gate-date"]'))
         .map((e) => (e.textContent || "").trim())`,
    );
    const dates = raw as string[];
    expect(dates.length).toBe(4);
    expect(dates.every((d) => d !== "")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC24 — MOTION MEANS LIVE, AND ONLY THAT
// ═══════════════════════════════════════════════════════════════════════════
//
// Sampled across frames, as the AC requires: ten readings spanning ~2s, which
// covers more than one full period of the app's established 1.6s
// `app-run-pulse`. A static node that changes fails; an IN_PROGRESS node that
// never changes fails.
//
// REAL elapsed time is unavoidable and correct here: a CSS animation is driven
// by the browser's own compositor clock in another process, and no fake timer
// in the test runner can advance it. This is precisely the
// "integration test exercising real timer behaviour against the platform
// clock" case, and the AC's wording ("sampling rendered state across at least
// two animation frames") is a requirement about that clock.

interface Sampled {
  cr: string;
  status: string;
  /** How many DISTINCT rendered faces this node showed across the samples. */
  faces: number;
  animationName: string;
}

async function sampleFrames(): Promise<Sampled[]> {
  const raw = await pageEl().evaluate(
    `(async () => {
       const read = () => Array.from(document.querySelectorAll('[data-testid="roadmap-node"]'))
         .map((n) => {
           const cs = getComputedStyle(n);
           const r = n.getBoundingClientRect();
           return {
             cr: n.getAttribute("data-cr"),
             status: n.getAttribute("data-status"),
             animationName: cs.animationName,
             // Everything a pulse, a blink, a glow or a nudge could move.
             face: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor,
                    cs.borderLeftColor, cs.backgroundColor, cs.color, cs.opacity,
                    cs.boxShadow, cs.transform, cs.filter, cs.outlineColor,
                    r.width.toFixed(2), r.height.toFixed(2),
                    r.left.toFixed(2), r.top.toFixed(2)].join("~"),
           };
         });
       const frames = [];
       for (let i = 0; i < 10; i++) {
         frames.push(read());
         await new Promise((done) => setTimeout(done, 200));
       }
       return frames;
     })()`,
  );
  const frames = raw as { cr: string; status: string; animationName: string; face: string }[][];

  const perCr = new Map<string, { status: string; animationName: string; faces: Set<string> }>();
  for (const frame of frames) {
    for (const entry of frame) {
      const slot = perCr.get(entry.cr) ?? {
        status: entry.status,
        animationName: entry.animationName,
        faces: new Set<string>(),
      };
      slot.faces.add(entry.face);
      perCr.set(entry.cr, slot);
    }
  }
  return [...perCr].map(([cr, slot]) => ({
    cr,
    status: slot.status,
    faces: slot.faces.size,
    animationName: slot.animationName,
  }));
}

describe("AC24 — only an IN_PROGRESS CR moves (sampled across frames)", () => {
  test(
    "the IN_PROGRESS node changes between frames",
    async () => {
      const sampled = await sampleFrames();
      const live = sampled.find((s) => s.cr === "CR-V-LIVE");
      expect(live).toBeDefined();
      expect(live!.status).toBe("IN_PROGRESS");
      expect(
        live!.faces,
        `the IN_PROGRESS node rendered ${live!.faces} distinct state(s) across 10 frames ` +
          `spanning ~2s — it never moves, so nothing on the board says work is live`,
      ).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );

  test(
    "COMPLETED, COMPLETED_UNTRACKED and PENDING nodes are completely static",
    async () => {
      // Every static FACE, which after CR-CRU-096 §S5 means the wave-less
      // board (AC18a): a trimmed wave box draws neither merged member, so
      // "COMPLETED and COMPLETED_UNTRACKED do not move" is only observable
      // where they are drawn.
      await looseBoard();
      const sampled = await sampleFrames();
      const statics = sampled.filter((s) => s.cr !== "CR-V-LIVE");
      expect(statics.length).toBe(FOCUSED_CRS.length - 1);
      for (const node of statics) {
        expect(
          node.faces,
          `${node.cr} (${node.status}) changed across frames — motion means LIVE, ` +
            `and it is not`,
        ).toBe(1);
        expect(
          node.animationName,
          `${node.cr} (${node.status}) carries animation "${node.animationName}"`,
        ).toBe("none");
      }
    },
    30_000,
  );

  test("nothing ELSE on the board animates — not a gate, a wave or a terminal", async () => {
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll(
         '[data-testid="roadmap-gate"], [data-testid="roadmap-gate"] *,' +
         '[data-testid="roadmap-wave"], [data-testid="roadmap-flow-gate"],' +
         '[data-testid="roadmap-flow-gate"] *,' +
         '[data-testid="roadmap-strip-terminal"], [data-testid="roadmap-flow-terminal"],' +
         '[data-testid="roadmap-row"]'
       )).map((e) => ({
         what: e.getAttribute("data-testid") || e.className,
         animationName: getComputedStyle(e).animationName,
       }))`,
    );
    const elements = raw as { what: string; animationName: string }[];
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(
        element.animationName,
        `${element.what} animates, but it is not live work`,
      ).toBe("none");
    }
  });

  test("the ONE animation the roadmap uses is the app's established pulse", async () => {
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-zones"] *'))
         .map((e) => getComputedStyle(e).animationName)
         .filter((name) => name !== "none")`,
    );
    const names = raw as string[];
    expect(
      new Set(names).size,
      `the roadmap runs ${new Set(names).size} distinct animations, not one`,
    ).toBe(1);
    // REUSE, not a third vocabulary: `app-run-pulse` and `app-locate-blink`
    // are the only keyframes public/styles.css declares.
    expect(["app-run-pulse", "app-locate-blink"]).toContain(names[0]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC25 — ZONE ORDER AND IDENTITY, measured geometrically
// ═══════════════════════════════════════════════════════════════════════════

describe("AC25 — exactly three zones, in order, each identifiable", () => {
  test("three zones render and each names itself", async () => {
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-zone]')).map((e) => ({
         zone: e.getAttribute("data-zone"),
         testid: e.getAttribute("data-testid"),
       }))`,
    );
    const zones = raw as { zone: string; testid: string }[];
    expect(zones.length, "the board does not identify its zones").toBe(3);
    expect(zones.map((z) => z.zone)).toEqual(["1", "2", "3"]);
    expect(zones.map((z) => z.testid)).toEqual(["roadmap-strip", "roadmap-flow", "roadmap-table"]);
  });

  test("the zones stack VERTICALLY in order: strip, flowchart, table", async () => {
    const raw = await pageEl().evaluate(
      `["1", "2", "3"].map((z) => {
         const el = document.querySelector('[data-zone="' + z + '"]');
         if (el === null) return null;
         const r = el.getBoundingClientRect();
         return { zone: z, top: r.top, bottom: r.bottom, height: r.height };
       })`,
    );
    const boxes = raw as ({ zone: string; top: number; bottom: number; height: number } | null)[];
    expect(boxes.every((b) => b !== null), "a zone is missing from the board").toBe(true);
    const [one, two, three] = boxes as { zone: string; top: number; bottom: number }[];
    expect(one!.top).toBeLessThan(two!.top);
    expect(two!.top).toBeLessThan(three!.top);
    // Ordered AND separated: a zone that overlaps the next is not a zone.
    expect(one!.bottom, "zone 1 overlaps zone 2").toBeLessThanOrEqual(two!.top + 0.5);
    expect(two!.bottom, "zone 2 overlaps zone 3").toBeLessThanOrEqual(three!.top + 0.5);
  });

  test("zone 2 is the FOCUSED release's flowchart and zone 3 its table", async () => {
    const raw = await pageEl().evaluate(
      `(() => {
         const focused =
           document.querySelector('[data-testid="roadmap-gate"][data-focused="true"]');
         const flow = document.querySelector('[data-zone="2"]');
         return {
           focusedVersion: focused?.getAttribute("data-version") || "",
           flowVersion: flow?.getAttribute("data-version") || "",
           rowCrs: Array.from(document.querySelectorAll('[data-testid="roadmap-row"]'))
             .map((r) => r.getAttribute("data-cr")),
         };
       })()`,
    );
    const identity = raw as { focusedVersion: string; flowVersion: string; rowCrs: string[] };
    expect(identity.focusedVersion).toBe("0.2.0");
    expect(identity.flowVersion).toBe("0.2.0");
    expect(identity.rowCrs).toEqual(FOCUSED_CRS);
  });

  // AC19 is C4's and this must not trample it: AC25 is about a POPULATED
  // board. An empty one draws no zones at all, so the zone identity that
  // satisfies AC25 must not appear there.
  test("an EMPTY board renders NO zones — AC19 still wins", async () => {
    await pageEl().goto(emptyFixtureUrl, { waitUntil: "load" });
    const raw = await pageEl().evaluate(
      `({
         zones: document.querySelectorAll('[data-zone]').length,
         terminals: document.querySelectorAll('[data-testid$="-terminal"]').length,
         waves: document.querySelectorAll('[data-testid="roadmap-wave"]').length,
         empty: document.querySelectorAll('[data-testid="roadmap-empty"]').length,
       })`,
    );
    const found = raw as { zones: number; terminals: number; waves: number; empty: number };
    expect(found.zones).toBe(0);
    expect(found.terminals).toBe(0);
    expect(found.waves).toBe(0);
    expect(found.empty).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC26 — NO LAYOUT ENGINE DECIDES POSITION
// ═══════════════════════════════════════════════════════════════════════════
//
// C3 deleted cytoscape and `buildRoadmapGraph`, so this is a REGRESSION guard:
// it must fail the moment a future cycle quietly reintroduces one. Two halves —
// nothing heuristic is LOADED or REFERENCED, and every rendered position is
// still the one the declared data implies.

/** Layout engines and graph-drawing libraries, by the name each would appear
 *  under in a script tag, an import specifier or a dependency list. */
const LAYOUT_ENGINES = [
  "cytoscape",
  "dagre",
  "elkjs",
  "d3-force",
  "forceSimulation",
  "vis-network",
  "mermaid",
  "graphviz",
  "viz.js",
  "webcola",
  "springy",
  "buildRoadmapGraph",
];

/** Comments narrate the reverted CR-CRU-077 ON PURPOSE — public/app.js §S4
 *  names cytoscape-dagre to say what it REPLACED, and a scan that failed on a
 *  history lesson would push the project into deleting the lesson. So the scan
 *  runs on EXECUTABLE source and comments are removed first. Over-stripping
 *  can only ever weaken this guard, never make it fire falsely. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

describe("AC26 — position comes from declared data, never a layout engine", () => {
  test("index.html loads no layout or graph-drawing library", () => {
    const srcs = [...INDEX_HTML_SRC.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!);
    const hrefs = [...INDEX_HTML_SRC.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBeGreaterThan(0);
    for (const url of [...srcs, ...hrefs]) {
      for (const engine of LAYOUT_ENGINES) {
        expect(
          url.toLowerCase().includes(engine.toLowerCase()),
          `index.html loads ${url}, which is ${engine}`,
        ).toBe(false);
      }
    }
    // And the loaded set is exactly the shell's own five scripts — three
    // vendored, plus the pure logic module and the shell itself — so a sixth
    // has to be justified by editing this assertion.
    expect(srcs).toEqual([
      "/vendor/tailwind-browser-4.2.4.js",
      "/vendor/van-1.5.5.nomodule.min.js",
      "/vendor/van-x-0.6.3.nomodule.min.js",
      "/app-logic.mjs",
      "/app.js",
    ]);
  });

  test("public/vendor ships no layout or graph-drawing library", () => {
    const vendored = readdirSync(path.join(PUBLIC_DIR, "vendor"));
    expect(vendored.length).toBeGreaterThan(0);
    for (const file of vendored) {
      for (const engine of LAYOUT_ENGINES) {
        expect(
          file.toLowerCase().includes(engine.toLowerCase()),
          `public/vendor ships ${file}`,
        ).toBe(false);
      }
    }
  });

  test("no roadmap source REFERENCES a layout engine outside a comment", () => {
    for (const [name, source] of [
      ["public/app.js", APP_JS_SRC],
      ["public/app-logic.mjs", APP_LOGIC_SRC],
      ["public/styles.css", STYLES_SRC],
    ] as const) {
      const code = stripComments(source).toLowerCase();
      for (const engine of LAYOUT_ENGINES) {
        expect(
          code.includes(engine.toLowerCase()),
          `${name} references ${engine} in executable source`,
        ).toBe(false);
      }
    }
  });

  test("no roadmap element is positioned out of its declared place", async () => {
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll(
         '[data-testid="roadmap-node"], [data-testid="roadmap-wave"],' +
         '[data-testid="roadmap-gate"], [data-testid="roadmap-flow-gate"],' +
         '[data-testid="roadmap-row"]'
       )).map((e) => {
         const cs = getComputedStyle(e);
         return {
           what: e.getAttribute("data-cr") || e.getAttribute("data-version") ||
                 e.getAttribute("data-wave") || "",
           testid: e.getAttribute("data-testid"),
           position: cs.position,
           top: cs.top,
           left: cs.left,
         };
       })`,
    );
    const elements = raw as {
      what: string;
      testid: string;
      position: string;
      top: string;
      left: string;
    }[];
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(
        element.position,
        `${element.testid} ${element.what} is ${element.position}-positioned at ` +
          `${element.left}/${element.top} — a coordinate nothing declared`,
      ).toBe("static");
    }
  });

  test("node order in the flowchart IS the authored seq order", async () => {
    // The wave-less board (AC18a), where all six are drawn: order is the
    // subject here, and a trimmed box would leave only two to order.
    await looseBoard();
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-node"]'))
         .map((n) => ({ cr: n.getAttribute("data-cr"), seq: n.getAttribute("data-seq") }))`,
    );
    const nodes = raw as { cr: string; seq: string }[];
    expect(nodes.map((n) => n.seq)).toEqual(["10", "11", "12", "13", "14", "15"]);
    expect(nodes.map((n) => n.cr)).toEqual(FOCUSED_CRS);
  });

  test("every node is PAINTED in that declared order — no reordering by layout", async () => {
    await looseBoard();
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-node"]')).map((n) => {
         const r = n.getBoundingClientRect();
         return { cr: n.getAttribute("data-cr"), top: r.top, left: r.left };
       })`,
    );
    const painted = raw as { cr: string; top: number; left: number }[];
    expect(painted.length).toBe(FOCUSED_CRS.length);
    // Reading order: a node never appears ABOVE an earlier sibling, and within
    // one row never to its LEFT. Anything a force layout or a crossing
    // heuristic did would break one of the two.
    for (let i = 1; i < painted.length; i++) {
      const previous = painted[i - 1]!;
      const here = painted[i]!;
      const sameRow = Math.abs(here.top - previous.top) <= 1;
      expect(
        sameRow ? here.left > previous.left : here.top > previous.top,
        `${here.cr} is painted before ${previous.cr}, which the authored order puts first`,
      ).toBe(true);
    }
  });

  test("the strip's gates sit at exactly one DECLARED pitch apart", async () => {
    const raw = await pageEl().evaluate(
      `(() => {
         const strip = document.querySelector('[data-testid="roadmap-strip"]');
         return {
           pitch: parseFloat(
             getComputedStyle(strip).getPropertyValue("--app-strip-gate-pitch"),
           ),
           lefts: Array.from(document.querySelectorAll('[data-testid="roadmap-gate"]'))
             .map((g) => g.getBoundingClientRect().left),
         };
       })()`,
    );
    const measured = raw as { pitch: number; lefts: number[] };
    expect(measured.pitch).toBeGreaterThan(0);
    expect(measured.lefts.length).toBe(4);
    for (let i = 1; i < measured.lefts.length; i++) {
      const step = measured.lefts[i]! - measured.lefts[i - 1]!;
      expect(
        Math.abs(step - measured.pitch),
        `gate ${i} sits ${step.toFixed(1)}px after its neighbour, not the declared ` +
          `${measured.pitch}px pitch`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("no edge element of any kind is drawn (AC20 holds under the new look)", async () => {
    const raw = await pageEl().evaluate(
      `({
         svg: document.querySelectorAll('[data-testid="roadmap-zones"] svg').length,
         canvas: document.querySelectorAll('[data-testid="roadmap-zones"] canvas').length,
         edges: document.querySelectorAll('[data-testid*="edge"]').length,
       })`,
    );
    const drawn = raw as { svg: number; canvas: number; edges: number };
    expect(drawn.svg).toBe(0);
    expect(drawn.canvas).toBe(0);
    expect(drawn.edges).toBe(0);
  });
});

// ── AC28 — the order the user actually SEES ────────────────────────────────
//
// The blocker §S9 corrected on 2026-08-28 was a VISUAL defect: the strip read
// `Start → 0.1.3 → 0.1.2 → 0.1.1 → 0.1.0 → 0.2.0 → End`, ship dates decreasing
// left to right and then jumping to the future. happy-dom runs no layout
// engine, so every other AC28 assertion in this repo is about DOM order and
// takes "document order is visual order" on the CSS's word. This is the one
// place with real pixels, so this is where left-to-right is measured.

describe("CR-CRU-078 AC28 — in a real browser, left to right, the strip ASCENDS", () => {
  test("each shipped gate is painted to the RIGHT of the one that shipped before it, and the proposal is rightmost of all", async () => {
    await pageEl().goto(orderedFixtureUrl, { waitUntil: "load" });
    const raw = await pageEl().evaluate(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-gate"]')).map((g) => ({
         version: g.getAttribute("data-version"),
         kind: g.getAttribute("data-kind"),
         left: g.getBoundingClientRect().left,
         date: (g.querySelector('[data-testid="roadmap-gate-date"]') || {}).textContent || "",
       }))`,
    );
    const painted = raw as { version: string; kind: string; left: number; date: string }[];

    // Fixture guard: THREE shipped tags plus the in-flight proposal really did
    // reach the page — two could not tell ascending from descending.
    expect(painted.filter((g) => g.kind === "shipped").length).toBe(3);
    expect(painted.filter((g) => g.kind === "proposed").length).toBe(1);

    // Sorted by where they are PAINTED, not by document order: this is the
    // sequence a reader's eye follows across the track.
    const leftToRight = [...painted].sort((a, b) => a.left - b.left);
    for (let i = 1; i < leftToRight.length; i++) {
      expect(
        leftToRight[i]!.left,
        `gate ${leftToRight[i]!.version} is painted at the same x as its neighbour`,
      ).toBeGreaterThan(leftToRight[i - 1]!.left);
    }
    expect(leftToRight.map((g) => g.version)).toEqual(["0.1.0", "0.1.1", "0.1.2", "0.2.0"]);

    // The ACs' own two clauses, read off the pixels: every shipped gate's date
    // is >= its left neighbour's (ISO days compare lexicographically), and the
    // last shipped one precedes the first proposed one.
    const shipped = leftToRight.filter((g) => g.kind === "shipped");
    for (const gate of shipped) expect(gate.date.trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < shipped.length; i++) {
      expect(
        shipped[i]!.date.trim() >= shipped[i - 1]!.date.trim(),
        `${shipped[i]!.version} (${shipped[i]!.date.trim()}) is painted to the right of ` +
          `${shipped[i - 1]!.version} (${shipped[i - 1]!.date.trim()}) but shipped EARLIER`,
      ).toBe(true);
    }
    const proposed = leftToRight.filter((g) => g.kind === "proposed")[0]!;
    expect(shipped[shipped.length - 1]!.left).toBeLessThan(proposed.left);
    expect(shipped[shipped.length - 1]!.date.trim() < proposed.date.trim()).toBe(true);

    // …and the Start/End terminals really do bracket that run, so "left to
    // right" is the direction the strip reads in and not an accident of flex.
    const terminals = await pageEl().evaluate(
      `(() => {
         const strip = document.querySelector('[data-testid="roadmap-strip"]');
         return {
           start: strip
             .querySelector('[data-terminal="start"]')
             .getBoundingClientRect().right,
           end: strip.querySelector('[data-terminal="end"]').getBoundingClientRect().left,
         };
       })()`,
    );
    const bracket = terminals as { start: number; end: number };
    expect(bracket.start).toBeLessThanOrEqual(leftToRight[0]!.left);
    expect(bracket.end).toBeGreaterThanOrEqual(leftToRight[leftToRight.length - 1]!.left);
  });
});
