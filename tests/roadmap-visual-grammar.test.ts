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
//   .lavish/crucible-workflow-flowchart.html §1–§8/§14 — the richer reference,
//     TRACKED since CR-CRU-096 AC27a (`.gitignore:12` ignores `.lavish/*`,
//     `.gitignore:18` negates this file back in), so it is present in a clean
//     clone and AC27 fails rather than degrades when it cannot be read. The DN
//     section still governs wherever the artifact says nothing. Every shape,
//     colour token and motion rule asserted below is read off one of those two
//     and never off taste.
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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// ── CR-CRU-096 C5 — the boards the MEASUREMENT cycle needs ─────────────────
//
// C1–C4 deferred seven readings to a real engine, and each needs a board the
// four existing ones cannot supply:
//   • a 29-member wave drawing 5 rows BESIDE a 10-member one drawing 5 —
//     AC17's "height grows with the rows shown, not with membership" is only a
//     claim if two DIFFERENT memberships drawing the SAME rows measure the
//     same height. One box can never say that;
//   • the same 29 members declaring NO wave, which AC18a draws UNTRIMMED, so
//     the trimmed height is compared against a MEASURED counterfactual rather
//     than an estimate of one;
//   • a SHIPPED focus: zone 2 draws exactly one gate, and only a shipped one
//     carries AC23's `shipped` word — AC25 needs both words and AC27 needs
//     both of the artifact's panels.
//
// AC29 — every id below is synthetic. `CR-H-*` is this board's own prefix.

/** §S6's own numbers, so the measurement has something to be measured
 *  AGAINST: the "available surface" column and the viewport it was taken at.
 *  AC20's second clause is stated in exactly these two figures. */
const SURFACE_W = 1130;
const WIDE_VIEWPORT = { width: 1600, height: 1200 };

/** §S6's horizontal budget table, the third column ("§S5 rows, trimmed"):
 *  `Start + arrow + wave + arrow + gate + arrow + End`. Recorded so a
 *  measurement can be REPORTED against it — the table is the CR's argument,
 *  the measurement is the fact, and where they differ the difference is the
 *  finding. Nothing below fails on a budget line. */
const BUDGET = { terminals: 100, wave: 300, gate: 76, connectors: 72, gaps: 48, total: 596 };

const HEIGHT_RELEASE = "0.4.0";

const HEIGHT_PROPOSALS: ProposalFixture[] = [
  { label: HEIGHT_RELEASE, targetAt: TARGET_020, timestamp: RETIRED_AT, waves: ["H1", "H2"] },
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Merged members: AC6a's PAIR, because `COMPLETED` and `COMPLETED_UNTRACKED`
 *  are one fact at two luminances and both must roll up rather than draw. */
const mergedMembers = (prefix: string, wave: string, count: number, from: number): QueueFixture[] =>
  Array.from({ length: count }, (_slot, at) => ({
    cr: `${prefix}${pad2(at + 1)}`,
    title: `${prefix}${pad2(at + 1)} — merged, and rolled up`,
    wave,
    dependsOn: [] as string[],
    status: (at % 5 === 4 ? "COMPLETED_UNTRACKED" : "COMPLETED") as QueueStatus,
    seq: from + at,
    release: HEIGHT_RELEASE,
    track: "1",
  }));

/** Scheduled members — `PENDING` with the `lifecycle` key ABSENT, which is
 *  what `roadmapActionable` tests (`!("lifecycle" in entry)`), so a fixture
 *  that declared `lifecycle: undefined` would draw no rows at all. */
const scheduledMembers = (
  prefix: string,
  wave: string,
  count: number,
  from: number,
  deps: readonly (readonly string[])[] = [],
): QueueFixture[] =>
  Array.from({ length: count }, (_slot, at) => ({
    cr: `${prefix}${pad2(at + 1)}`,
    title: `${prefix}${pad2(at + 1)} — scheduled, not started`,
    wave,
    dependsOn: [...(deps[at] ?? [])],
    status: "PENDING" as QueueStatus,
    seq: from + at,
    release: HEIGHT_RELEASE,
    track: "2",
  }));

/** Wave `H1` holds 29 and draws 5; wave `H2` holds 10 and draws 5. The two
 *  shipped members ride along so zone 1 still has its tags to draw. */
const HEIGHT_QUEUE: QueueFixture[] = [
  ...QUEUE.slice(0, 2),
  ...mergedMembers("CR-H-M", "H1", 20, 100),
  ...scheduledMembers("CR-H-P", "H1", 9, 200, [[], ["CR-H-M01", "CR-H-M02"]]),
  ...mergedMembers("CR-H-N", "H2", 1, 300),
  ...scheduledMembers("CR-H-Q", "H2", 9, 400, [["CR-H-N01"]]),
];

/** AC17's counterfactual: `H1`'s 29 members declaring NO wave, which AC18a
 *  draws untrimmed. Same members, same row markup, one trimmed and one not —
 *  so "shorter than it would be" is a subtraction of two measurements. */
const HEIGHT_LOOSE_QUEUE: QueueFixture[] = HEIGHT_QUEUE.filter(
  (entry) => entry.wave === "H1",
).map((entry) => ({ ...entry, wave: "" }));

/** §S6's budget table is stated PER WAVE BOX, and its "§S5 rows, trimmed"
 *  column is a ONE-box release: 28 members, five rows, a roll-up and a
 *  pointer. This is that board — the same `H1` wave alone, so the measured
 *  spine can be reported against the 596px the table claims without a second
 *  box in the way. AC19a — `H2` draws no box because no member declares it. */
const SINGLE_WAVE_QUEUE: QueueFixture[] = HEIGHT_QUEUE.filter(
  (entry) => entry.release !== HEIGHT_RELEASE || entry.wave === "H1",
);

/** AC20d — the surface the app ACTUALLY reports. `SURFACE_W` is a CONTROLLED
 *  figure (§S6's own table at a 1600px viewport); measured in the user's own
 *  Chrome at a 1465px window the Project rail takes the remainder and zone 2
 *  gets 991px. A budget pinned only to 1130 is green on a surface nobody
 *  browses at, so the second AC20 case is served at this width and measured
 *  against the width the APP reports rather than against either constant. */
const REAL_SURFACE_W = 991;

/** AC19d — the WRAP board. AC13's widest real annotation is a FOUR-dep row,
 *  and a wave box carrying one is far wider than half the surface, so a
 *  two-wave release at this width genuinely CANNOT lay both boxes on one
 *  line. The landed AC19c fixture (`HEIGHT_QUEUE`) tops out at a TWO-dep row
 *  and therefore fits — which is why it never exercised the degradation.
 *  AC29 — `CR-W1-*` / `CR-W2-*` are synthetic ids of this board alone. */
const WRAP_DEPS: readonly string[] = ["CR-W1-M01", "CR-W1-M02", "CR-W1-M03", "CR-W1-M04"];

const WRAP_PROPOSALS: ProposalFixture[] = [
  { label: HEIGHT_RELEASE, targetAt: TARGET_020, timestamp: RETIRED_AT, waves: ["W1", "W2"] },
];

/** Every DRAWN row carries the four-dep annotation, so the box's width is set
 *  by the widest case §S6's budget is stated against and not by an average. */
const WRAP_QUEUE: QueueFixture[] = [
  ...QUEUE.slice(0, 2),
  ...mergedMembers("CR-W1-M", "W1", 4, 500),
  ...scheduledMembers("CR-W1-P", "W1", 5, 520, [
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
  ]),
  ...mergedMembers("CR-W2-M", "W2", 4, 560),
  ...scheduledMembers("CR-W2-P", "W2", 5, 580, [
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
    WRAP_DEPS,
  ]),
];

/** The artifact IS the binding design source AC27 compares against, and since
 *  CR-CRU-096 AC27a it is TRACKED: `.gitignore:12` ignores `.lavish/*` and
 *  `.gitignore:18` negates this one file back in. So a clean clone has it, and
 *  the AC27 tests HARD-FAIL on an unreadable artifact (`expect(artifactFailure)
 *  .toBe("")`) rather than stating its absence. The read stays guarded only so
 *  the failure is reported by AC27 instead of taking the other assertions in
 *  this file down with it. */
const ARTIFACT_REL = ".lavish/crucible-workflow-flowchart.html";

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
  /** AC26's baseline: the shell source as of the commit BEFORE this CR, so
   *  "byte-identical before and after" is a comparison of two renders rather
   *  than a promise. */
  appJs?: string;
  logicPath?: string;
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

    // Dynamic import is REQUIRED, not a style choice, on two counts: the
    // specifier carries a per-capture cache-bust query so the module
    // re-evaluates into the FRESH happy-dom global each time (a static import
    // would bind once, to the globals of the first capture), and AC26 selects
    // the module at RUNTIME — the baseline capture imports the pre-CR
    // `app-logic.mjs` written to a temp dir, a path no static specifier can
    // name. House harness pattern, shared with
    // tests/roadmap-release-strip.test.ts and tests/roadmap-release-focus.test.ts.
    cacheBust += 1;
    await import(`${opts.logicPath ?? APP_LOGIC_PATH}?roadmapVisualGrammar=${cacheBust}`);

    (0, eval)(opts.appJs ?? APP_JS_SRC);

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
// CR-CRU-096 C5 — the boards, pages and sources the deferred readings need.
let heightZones = "";
let heightLooseZones = "";
let shippedZones = "";
let singleZones = "";
let baselineZones = "";
let surfaceFixtureUrl = "";
let heightFixtureUrl = "";
let heightLooseFixtureUrl = "";
let shippedFixtureUrl = "";
let baselineFixtureUrl = "";
let singleFixtureUrl = "";
let artifactUrl = "";
// CR-CRU-096 C6 — AC19d's wrap board and AC20d's real surface.
let wrapZones = "";
let wrapFixtureUrl = "";
let realSurfaceFixtureUrl = "";
/** A SECOND page, at §S6's own 1600px viewport. A second page rather than a
 *  `setViewportSize` on the shared one: the 38 landed assertions are measured
 *  at 1440×1000 and a viewport this suite forgot to put back would silently
 *  re-measure them. */
let widePage: Page | null = null;
let artifactHtml = "";
let artifactFailure = "";
/** The commit CR-CRU-096 was filed against — `develop` at the moment the
 *  feature branch was cut, and the state every "pre-CR" assertion below
 *  describes. Pinned rather than derived from `git merge-base`, which answers
 *  the pre-CR commit only while the branch is unmerged (see the note in
 *  `beforeAll`). Verified an ancestor of `develop`; if it is ever unreachable
 *  the AC26 test reports that instead of the suite silently comparing a render
 *  against itself. */
const PRE_CR_COMMIT = "63f07f5bf79ca00f53f3cf402bbca802ba57fc4c";

let baselineFailure = "";
let baselineCommit = "";
/** The pre-CR STYLESHEET, served beside the pre-CR markup. Swapping only the
 *  two scripts would render the old DOM under the NEW cascade — which is how
 *  the first attempt at the non-vacuity block measured a HORIZONTAL pre-CR
 *  spine: `.app-roadmap-flow { flex-direction: column }` is a stylesheet fact
 *  (`styles.css` at that commit), so the before-state needs its own CSS. */
let baselineStyles = "";

/** A page that is the app's own document shell (theme attribute, real
 *  stylesheet link) wrapping the captured zones — and NO script at all, so
 *  nothing can re-lay-out what is being measured. */
const fixtureDocument = (zones: string, appWidth = 1360, stylesheet = "/styles.css"): string =>
  `<!doctype html>
<html lang="en" data-theme="forge">
<head>
<meta charset="utf-8">
<title>CR-CRU-078 AC21-AC26 fixture</title>
<link rel="stylesheet" href="${stylesheet}">
<style>
  /* The measured board sits at a FIXED width so every geometry assertion is
     deterministic, and wide enough that the strip's four gates are never
     clipped by the .app-strip-track overflow. */
  body { margin: 0; }
  #app { width: ${appWidth}px; }
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
  heightZones = await captureZones({ proposals: HEIGHT_PROPOSALS, queue: HEIGHT_QUEUE });
  heightLooseZones = await captureZones({
    proposals: HEIGHT_PROPOSALS,
    queue: HEIGHT_LOOSE_QUEUE,
  });
  singleZones = await captureZones({ proposals: HEIGHT_PROPOSALS, queue: SINGLE_WAVE_QUEUE });
  wrapZones = await captureZones({ proposals: WRAP_PROPOSALS, queue: WRAP_QUEUE });
  // No proposal at all, so `releaseStripFocusIndex` falls through to the last
  // gate — the newest SHIPPED tag. That is the only way to reach §S7's
  // delivered path, and with it AC23's `shipped` word and AC24's shipped axis.
  shippedZones = await captureZones({ releases: [SHIPPED[0]!], proposals: [] });

  // AC26's BASELINE. "Byte-identical before and after this CR" is a claim
  // about two renders, so the before-state is rendered too: the shell as of
  // the commit this CR was filed against.
  //
  // PINNED, not derived. This read `git merge-base develop HEAD`, which is
  // correct exactly once — on the feature branch. After the merge, HEAD IS
  // develop, so the merge-base is the merged commit and the "before" build
  // becomes the "after" build: every pre-CR counterfactual below inverts and
  // AC26 compares a render against itself. The guard destroyed itself on
  // merge, and the pre-merge gate could not see it because the branch still
  // resolved the base correctly. A before/after comparison must name its
  // before-state as settled fact, the way release provenance does.
  try {
    baselineCommit = PRE_CR_COMMIT;
    const showAt = (rel: string): string =>
      execFileSync("git", ["show", `${baselineCommit}:${rel}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const baseDir = mkdtempSync(path.join(tmpdir(), "roadmap-ac26-"));
    const basePath = path.join(baseDir, "app-logic.mjs");
    writeFileSync(basePath, showAt("public/app-logic.mjs"));
    baselineStyles = showAt("public/styles.css");
    baselineZones = await captureZones({
      appJs: showAt("public/app.js"),
      logicPath: basePath,
    });
  } catch (failure) {
    baselineFailure = failure instanceof Error ? failure.message : String(failure);
  }

  try {
    artifactHtml = readFileSync(path.join(REPO_ROOT, ARTIFACT_REL), "utf8");
  } catch (failure) {
    artifactFailure = failure instanceof Error ? failure.message : String(failure);
  }

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
      // The C5 boards, every one of them served at §S6's measured SURFACE
      // width so AC20's second clause has the surface it is stated against.
      if (pathname === "/fixture-surface") {
        return new Response(fixtureDocument(populatedZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-height") {
        return new Response(fixtureDocument(heightZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-single") {
        return new Response(fixtureDocument(singleZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // AC19d — the four-dep board, served at the SAME surface as every other
      // C5 fixture: the wrap is forced by the boxes' own width, not by a
      // narrowed stage.
      if (pathname === "/fixture-wrap") {
        return new Response(fixtureDocument(wrapZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // AC20d — the same one-box board at the surface the user's own Chrome
      // reports, so the budget is asserted somewhere it is actually browsed.
      if (pathname === "/fixture-real-surface") {
        return new Response(fixtureDocument(singleZones, REAL_SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-height-loose") {
        return new Response(fixtureDocument(heightLooseZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-shipped") {
        return new Response(fixtureDocument(shippedZones, SURFACE_W), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/fixture-baseline") {
        return new Response(fixtureDocument(baselineZones, SURFACE_W, "/styles-baseline.css"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // Explicit, and BEFORE the public/ passthrough, which would otherwise
      // try to open a file that does not exist on disk.
      if (pathname === "/styles-baseline.css") {
        return new Response(baselineStyles, {
          headers: { "content-type": "text/css; charset=utf-8" },
        });
      }
      // AC27's binding source, rendered by the same engine as the live board
      // so the comparison is render-to-render and not render-to-my-reading.
      if (pathname === "/artifact") {
        return new Response(artifactHtml, {
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
  surfaceFixtureUrl = `http://127.0.0.1:${server.port}/fixture-surface`;
  heightFixtureUrl = `http://127.0.0.1:${server.port}/fixture-height`;
  heightLooseFixtureUrl = `http://127.0.0.1:${server.port}/fixture-height-loose`;
  shippedFixtureUrl = `http://127.0.0.1:${server.port}/fixture-shipped`;
  baselineFixtureUrl = `http://127.0.0.1:${server.port}/fixture-baseline`;
  singleFixtureUrl = `http://127.0.0.1:${server.port}/fixture-single`;
  artifactUrl = `http://127.0.0.1:${server.port}/artifact`;
  wrapFixtureUrl = `http://127.0.0.1:${server.port}/fixture-wrap`;
  realSurfaceFixtureUrl = `http://127.0.0.1:${server.port}/fixture-real-surface`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  widePage = await browser.newPage({ viewport: WIDE_VIEWPORT });
}, 180_000);

afterAll(async () => {
  if (page !== null) await page.close();
  if (widePage !== null) await widePage.close();
  if (browser !== null) await browser.close();
  if (server !== null) server.stop(true);
  page = null;
  widePage = null;
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

async function measureAll(selector: string, target: Page = pageEl()): Promise<Measured[]> {
  const raw = await target.evaluate(
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
async function tokenColor(name: string, target: Page = pageEl()): Promise<string> {
  const raw = await target.evaluate(
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

// ═══════════════════════════════════════════════════════════════════════════
// CR-CRU-096 C5 — THE READINGS FOUR CYCLES DEFERRED TO A REAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S6 (the axis and its budget), §S7 (the shipped path), §S8 (the two
//       grammar invariants), AC2/AC4, AC7/AC12, AC17, AC20, AC25, AC26, AC27.
//
// Every one of the deferral notes C1–C4 wrote says the same thing in different
// words: happy-dom runs no layout engine and applies no cascade, so a resolved
// length, a resolved colour, a painted position and a compositor-driven
// animation do not exist there. C1 read the active marker off the STYLESHEET
// SOURCE, C2 took `overflow` on the stylesheet's word, C3 read the roll-up's
// face and the marker's ink off their rules, and C4 did AC20's width ON PAPER.
// This section is the place those readings exist, and it reuses the harness
// above rather than standing up a second one: same happy-dom capture of the
// REAL production DOM, same throwaway server handing Chromium the REAL
// public/styles.css over HTTP, same browser.
//
// Some of these assertions PASS on arrival. That is the expected shape of a
// measurement cycle: C1–C4 landed the production code and deferred only the
// reading. A passing assertion here is only worth its non-vacuity argument, so
// each block states what would have failed it — a counter-subject measured on
// the same page, or a token proved distinct before it is compared against.

/** §S6's own viewport, narrowed once. */
const wide = (): Page => {
  if (widePage === null) throw new Error("roadmap-visual-grammar: no wide Chromium page");
  return widePage;
};

const openWide = async (url: string): Promise<void> => {
  await wide().goto(url, { waitUntil: "load" });
};

async function readWide<T>(expression: string): Promise<T> {
  const raw = await wide().evaluate(expression);
  // Every call site below fixes the shape in the expression it passes.
  const value = raw as T;
  return value;
}

/** One rendered box: its geometry, its resolved overflow, its resolved face.
 *  Distinct from `Measured` above, which decomposes a transform matrix for
 *  AC21's shape grammar and carries no overflow or cursor. */
interface Boxed {
  testid: string;
  cls: string;
  text: string;
  x: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  overflow: string;
  overflowX: string;
  overflowY: string;
  animationName: string;
  borderTopWidth: number;
  borderMax: number;
  borderTopStyle: string;
  borderTopColor: string;
  backgroundColor: string;
  color: string;
  fontWeight: string;
  cursor: string;
}

const BOX_FN = `
function __box(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  return {
    testid: el.getAttribute("data-testid") || "",
    cls: String(el.className || "").trim(),
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
    x: r.left, right: r.right, top: r.top, bottom: r.bottom,
    width: r.width, height: r.height,
    overflow: cs.overflow, overflowX: cs.overflowX, overflowY: cs.overflowY,
    animationName: cs.animationName,
    borderTopWidth: px(cs.borderTopWidth),
    borderMax: Math.max(px(cs.borderTopWidth), px(cs.borderRightWidth),
                        px(cs.borderBottomWidth), px(cs.borderLeftWidth)),
    borderTopStyle: cs.borderTopStyle,
    borderTopColor: cs.borderTopColor,
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    fontWeight: cs.fontWeight,
    cursor: cs.cursor,
  };
}
`;

async function boxesOf(selector: string): Promise<Boxed[]> {
  return await readWide<Boxed[]>(
    `(() => { ${BOX_FN} return Array.from(document.querySelectorAll(${JSON.stringify(
      selector,
    )})).map(__box); })()`,
  );
}

/** The one element a selector must match, named so a fixture that drifted
 *  reports WHAT it matched instead of throwing on `[0]!`. */
const one = (found: Boxed[], what: string): Boxed => {
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${what}, measured ${found.length}`);
  }
  return found[0]!;
};

/** Which piece of the spine a flow child IS, decided from what it PUBLISHES —
 *  never from its position, which is the thing under test. */
const spineRole = (piece: Boxed): string => {
  if (piece.testid === "roadmap-flow-terminal") return "terminal";
  if (piece.testid === "roadmap-flow-connector") return "connector";
  if (piece.testid === "roadmap-flow-gate") return "gate";
  if (piece.testid === "roadmap-delivered") return "delivered";
  if (piece.cls.split(/\s+/).includes("app-flow-waves")) return "waves";
  return `unknown(${piece.testid === "" ? piece.cls : piece.testid})`;
};

/** Two boxes OVERLAP vertically — the geometric statement of "these sit side
 *  by side on one axis" and the exact negation of "these are stacked". */
const yOverlap = (a: Boxed, b: Boxed): number =>
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

const round1 = (n: number): number => Math.round(n * 10) / 10;

// ── AC20 (C4's deferral) — the axis is HORIZONTAL by GEOMETRY ──────────────
//
// C4's AC20 note landed the `flex-direction: row` and checked the budget with
// arithmetic on the stylesheet's declared lengths. Two things that cannot
// establish: that the declared `row` SURVIVES the cascade (a later rule, a
// `@media` block, an inherited `flex-direction: column` on an ancestor or a
// `flex-wrap` that breaks the line all leave the declaration intact and the
// axis vertical), and that the result fits. Both are measured here, and the
// axis is read off the PAINTED positions: x increasing while y overlaps. A
// stacked spine has x equal and y disjoint, which is precisely what the
// pre-CR build drew.

describe("CR-CRU-096 AC20 — zone 2's spine is horizontal in a real engine, and fits the surface", () => {
  test("the flow draws FOUR stages and THREE connectors, in the artifact's own order", async () => {
    await openWide(singleFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    expect(pieces.map(spineRole)).toEqual([
      "terminal",
      "connector",
      "waves",
      "connector",
      "gate",
      "connector",
      "terminal",
    ]);
  });

  test("the four stages lie on ONE HORIZONTAL axis — x increases while y overlaps", async () => {
    await openWide(singleFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    const stages = pieces.filter((piece) => spineRole(piece) !== "connector");
    expect(stages.length).toBe(4);

    for (let at = 1; at < stages.length; at++) {
      const before = stages[at - 1]!;
      const here = stages[at]!;
      expect(
        here.x,
        `stage ${spineRole(here)} is painted at x=${round1(here.x)}, which is not to the ` +
          `RIGHT of ${spineRole(before)} (right edge ${round1(before.right)}) — the axis is ` +
          `not horizontal`,
      ).toBeGreaterThanOrEqual(before.right - 0.5);
      expect(
        yOverlap(before, here),
        `stage ${spineRole(here)} (y ${round1(here.top)}–${round1(here.bottom)}) shares no ` +
          `vertical span with ${spineRole(before)} (y ${round1(before.top)}–` +
          `${round1(before.bottom)}), which is what a STACKED spine looks like`,
      ).toBeGreaterThan(0);
    }

    // Every pair, not just neighbours: a spine that wrapped after two stages
    // would pass the pairwise walk above and still read as two lines.
    for (const outer of stages) {
      for (const inner of stages) {
        expect(yOverlap(outer, inner)).toBeGreaterThan(0);
      }
    }

    // And each connector really is BETWEEN the two stages it joins, so the
    // three lines read as one spine rather than as decoration parked anywhere.
    for (let at = 1; at < pieces.length; at += 2) {
      const link = pieces[at]!;
      expect(spineRole(link)).toBe("connector");
      expect(link.x).toBeGreaterThanOrEqual(pieces[at - 1]!.right - 0.5);
      expect(link.right).toBeLessThanOrEqual(pieces[at + 1]!.x + 0.5);
    }
  });

  test("the rendered flow does not exceed the 1130px surface at a 1600px viewport", async () => {
    await openWide(singleFixtureUrl);
    const surface = await readWide<{
      viewport: number;
      offsetWidth: number;
      clientWidth: number;
      scrollWidth: number;
      paintedLeft: number;
      paintedRight: number;
      boxLeft: number;
      boxRight: number;
    }>(
      `(() => {
         const flow = document.querySelector('[data-zone="2"]');
         const own = flow.getBoundingClientRect();
         const kids = Array.from(flow.querySelectorAll("*")).map((e) => e.getBoundingClientRect());
         return {
           viewport: window.innerWidth,
           offsetWidth: flow.offsetWidth,
           clientWidth: flow.clientWidth,
           scrollWidth: flow.scrollWidth,
           paintedLeft: Math.min.apply(null, kids.map((r) => r.left)),
           paintedRight: Math.max.apply(null, kids.map((r) => r.right)),
           boxLeft: own.left,
           boxRight: own.right,
         };
       })()`,
    );

    // Fixture guard: the surface really IS the one §S6 measured against.
    expect(surface.viewport).toBe(WIDE_VIEWPORT.width);
    expect(surface.offsetWidth).toBe(SURFACE_W);

    const painted = surface.paintedRight - surface.paintedLeft;
    expect(
      painted,
      `zone 2 paints ${round1(painted)}px of spine into the ${SURFACE_W}px surface §S6 ` +
        `measured at a ${WIDE_VIEWPORT.width}px viewport`,
    ).toBeLessThanOrEqual(SURFACE_W);

    // "Does not exceed the surface" the second way: nothing overflows the
    // element. A flow wider than its box would report scrollWidth > clientWidth
    // whatever the arithmetic said.
    expect(
      surface.scrollWidth - surface.clientWidth,
      `zone 2 overflows its own box by ${surface.scrollWidth - surface.clientWidth}px`,
    ).toBeLessThanOrEqual(0.5);

    // …and nothing is painted outside it either — the 45°-rotated gate hangs
    // ~15.8px past its 76px layout box on each side, so the layout arithmetic
    // alone cannot answer this.
    expect(surface.paintedLeft).toBeGreaterThanOrEqual(surface.boxLeft - 0.5);
    expect(surface.paintedRight).toBeLessThanOrEqual(surface.boxRight + 0.5);
  });

  test("the spine's measured pieces account for its whole width — §S6's budget, read off the pixels", async () => {
    await openWide(singleFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    const gap = await readWide<number>(
      `parseFloat(getComputedStyle(document.querySelector('[data-zone="2"]')).columnGap) || 0`,
    );
    expect(pieces.length).toBe(7);

    const extent = pieces[6]!.right - pieces[0]!.x;
    const summed = pieces.reduce((total, piece) => total + piece.width, 0) + gap * 6;
    expect(
      Math.abs(summed - extent),
      `the seven pieces plus six ${gap}px gaps sum to ${round1(summed)}px but the spine ` +
        `measures ${round1(extent)}px — something else is taking width`,
    ).toBeLessThanOrEqual(1);

    const connectors = pieces.filter((piece) => spineRole(piece) === "connector");
    const terminals = pieces.filter((piece) => spineRole(piece) === "terminal");
    const gate = one(
      pieces.filter((piece) => spineRole(piece) === "gate"),
      "gate stage",
    );
    const waves = one(
      pieces.filter((piece) => spineRole(piece) === "waves"),
      "wave stage",
    );

    // The pieces §S6's budget names by a fixed length, measured: three 24px
    // connectors and a 76px gate (`--app-gate-side`, shared with zone 1 so the
    // same release draws the same size in both).
    expect(connectors.length).toBe(3);
    for (const link of connectors) expect(link.width).toBeCloseTo(BUDGET.connectors / 3, 1);
    expect(gate.width).toBeCloseTo(BUDGET.gate, 1);
    expect(terminals.length).toBe(2);

    // The two pieces the budget ESTIMATES rather than declares — the terminals
    // at 100px for the pair and the wave box at 300px. They are content-sized,
    // so this reports them against the table instead of pinning them: §S6 is
    // the argument and the measurement is the fact. The AC's own clause is the
    // surface bound asserted above.
    const spent = terminals.reduce((total, term) => total + term.width, 0) + waves.width;
    expect(
      extent,
      `measured spine ${round1(extent)}px = terminals ` +
        `${terminals.map((t) => round1(t.width)).join(" + ")} (budget ${BUDGET.terminals}) + ` +
        `wave ${round1(waves.width)} (budget ${BUDGET.wave}) + gate ${round1(gate.width)} ` +
        `(budget ${BUDGET.gate}) + connectors ${round1(BUDGET.connectors)} + gaps ` +
        `${gap * 6} (budget ${BUDGET.gaps}); §S6's total is ${BUDGET.total}px, content-sized ` +
        `pieces measured ${round1(spent)}px`,
    ).toBeLessThanOrEqual(SURFACE_W);
  });

  test("a MULTI-WAVE release still fits, and its boxes lie ALONG the axis (AC19c)", async () => {
    await openWide(heightFixtureUrl);
    const stage = one(await boxesOf('[data-zone="2"] .app-flow-waves'), "wave stage");
    const boxes = await boxesOf('[data-testid="roadmap-wave"]');
    expect(boxes.length).toBe(2);
    // AC19c is the case where the boxes FIT: this board's widest annotation is
    // a TWO-dep row, so both boxes sit on one line and "along the axis" is
    // what the geometry below measures. AC19d takes the case where they do not
    // fit — the two criteria are stated against two different boards, and this
    // guard keeps them from collapsing into one.
    expect(
      boxes[0]!.width + boxes[1]!.width,
      `the AC19c board's boxes cannot share one line (stage ${round1(stage.width)}px), so this ` +
        `test is measuring AC19d's wrap and AC19c's axis is no longer asserted anywhere`,
    ).toBeLessThanOrEqual(stage.width);
    expect(
      boxes[1]!.x,
      `the second wave box is painted at x=${round1(boxes[1]!.x)}, not to the right of the ` +
        `first (right edge ${round1(boxes[0]!.right)}) — the boxes are stacked ACROSS the axis`,
    ).toBeGreaterThanOrEqual(boxes[0]!.right - 0.5);
    expect(yOverlap(boxes[0]!, boxes[1]!)).toBeGreaterThan(0);

    const surface = await readWide<{ scrollWidth: number; clientWidth: number; painted: number }>(
      `(() => {
         const flow = document.querySelector('[data-zone="2"]');
         const kids = Array.from(flow.querySelectorAll("*")).map((e) => e.getBoundingClientRect());
         return {
           scrollWidth: flow.scrollWidth,
           clientWidth: flow.clientWidth,
           painted: Math.max.apply(null, kids.map((r) => r.right)) -
                    Math.min.apply(null, kids.map((r) => r.left)),
         };
       })()`,
    );
    expect(
      surface.painted,
      `a two-wave release paints ${round1(surface.painted)}px (wave stage ` +
        `${round1(stage.width)}px) into the ${SURFACE_W}px surface`,
    ).toBeLessThanOrEqual(SURFACE_W);
    expect(surface.scrollWidth - surface.clientWidth).toBeLessThanOrEqual(0.5);
  });

  // AC19d — the DEGRADATION, measured. §S5's rule is that a partially drawn
  // container is a defect, and `flex-wrap: wrap` obeys it: a wrapped box is
  // still WHOLLY drawn, where `nowrap` would overflow the surface or clip a
  // box. So the wrap is not a drift to be removed — it is the correct
  // behaviour at a width the axis cannot hold, and it is asserted as such.
  test("when the axis genuinely CANNOT hold the boxes they WRAP, wholly painted (AC19d)", async () => {
    await openWide(wrapFixtureUrl);
    const stage = one(await boxesOf('[data-zone="2"] .app-flow-waves'), "wave stage");
    const boxes = await boxesOf('[data-testid="roadmap-wave"]');
    expect(boxes.length).toBe(2);

    // Non-vacuity: the boxes' own widths REALLY exceed the line. Without this
    // the test would pass on a board that simply chose to stack.
    expect(
      boxes[0]!.width + boxes[1]!.width,
      `the four-dep boxes measure ${round1(boxes[0]!.width)}px and ` +
        `${round1(boxes[1]!.width)}px, which still fit the ${round1(stage.width)}px stage — ` +
        `this board no longer reaches AC19d's case`,
    ).toBeGreaterThan(stage.width);

    // WRAPPED, not overflowed: the second box starts a further LINE, back at
    // the stage's own left edge and below the first.
    expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom - 0.5);
    expect(yOverlap(boxes[0]!, boxes[1]!)).toBeLessThanOrEqual(0);
    expect(Math.abs(boxes[1]!.x - stage.x)).toBeLessThanOrEqual(0.5);

    const wrapped = await readWide<{
      scrollWidth: number;
      clientWidth: number;
      client: { left: number; right: number; top: number; bottom: number };
      boxes: {
        left: number;
        right: number;
        top: number;
        bottom: number;
        overflowX: number;
        overflowY: number;
        outside: number;
      }[];
    }>(
      `(() => {
         const flow = document.querySelector('[data-zone="2"]');
         const fr = flow.getBoundingClientRect();
         const client = {
           left: fr.left + flow.clientLeft,
           top: fr.top + flow.clientTop,
           right: fr.left + flow.clientLeft + flow.clientWidth,
           bottom: fr.top + flow.clientTop + flow.clientHeight,
         };
         const boxes = Array.from(
           document.querySelectorAll('[data-testid="roadmap-wave"]'),
         ).map((el) => {
           const r = el.getBoundingClientRect();
           const inner = {
             left: r.left + el.clientLeft,
             top: r.top + el.clientTop,
             right: r.left + el.clientLeft + el.clientWidth,
             bottom: r.top + el.clientTop + el.clientHeight,
           };
           const outside = Array.from(el.querySelectorAll("*")).filter((kid) => {
             const k = kid.getBoundingClientRect();
             if (k.width === 0 && k.height === 0) return false;
             return (
               k.left < inner.left - 0.5 ||
               k.right > inner.right + 0.5 ||
               k.top < inner.top - 0.5 ||
               k.bottom > inner.bottom + 0.5
             );
           }).length;
           return {
             left: r.left,
             right: r.right,
             top: r.top,
             bottom: r.bottom,
             overflowX: el.scrollWidth - el.clientWidth,
             overflowY: el.scrollHeight - el.clientHeight,
             outside,
           };
         });
         return { scrollWidth: flow.scrollWidth, clientWidth: flow.clientWidth, client, boxes };
       })()`,
    );

    // WHOLLY PAINTED: every box lies inside the surface's own client box, and
    // holds all of its own content — nothing is cut off at either boundary.
    for (const [at, box] of wrapped.boxes.entries()) {
      expect(
        box.left >= wrapped.client.left - 0.5 &&
          box.right <= wrapped.client.right + 0.5 &&
          box.top >= wrapped.client.top - 0.5 &&
          box.bottom <= wrapped.client.bottom + 0.5,
        `wave box ${at} is painted at ` +
          `${round1(box.left)}..${round1(box.right)} x ${round1(box.top)}..${round1(box.bottom)}, ` +
          `outside the surface's ${round1(wrapped.client.left)}..${round1(wrapped.client.right)} x ` +
          `${round1(wrapped.client.top)}..${round1(wrapped.client.bottom)} — it is CLIPPED, ` +
          `which §S5 calls a defect`,
      ).toBe(true);
      expect(
        box.outside,
        `wave box ${at} paints ${box.outside} descendant(s) outside its own content box, so the ` +
          `box is drawn but its contents are not`,
      ).toBe(0);
      expect(box.overflowX).toBeLessThanOrEqual(0.5);
      expect(box.overflowY).toBeLessThanOrEqual(0.5);
    }
    // AND IT NEVER SCROLLS: the wrap is what keeps the surface intact.
    expect(
      wrapped.scrollWidth - wrapped.clientWidth,
      `zone 2 scrolls ${round1(wrapped.scrollWidth - wrapped.clientWidth)}px past its ` +
        `${round1(wrapped.clientWidth)}px surface, so the boxes overflowed rather than wrapped`,
    ).toBeLessThanOrEqual(0.5);
  });

  // AC20d — the budget at the REAL surface. AC20's 1130px is a CONTROLLED
  // figure and stays measured above; a criterion pinned only to it is green on
  // a viewport nobody browses at, because the Project rail takes the remainder
  // and the user's own Chrome reports 991px. This case asks the APP for its
  // surface and measures the spine against THAT, so the criterion tracks the
  // app instead of a constant this file happens to hold.
  test("AC20d — the spine also fits the surface the APP itself reports, not just 1130px", async () => {
    await openWide(realSurfaceFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    expect(pieces.length).toBeGreaterThan(0);
    const extent =
      Math.max(...pieces.map((piece) => piece.right)) - Math.min(...pieces.map((piece) => piece.x));

    const reported = await readWide<{ scrollWidth: number; clientWidth: number }>(
      `(() => {
         const flow = document.querySelector('[data-zone="2"]');
         return { scrollWidth: flow.scrollWidth, clientWidth: flow.clientWidth };
       })()`,
    );

    // Non-vacuity: the surface the app reports here is NARROWER than AC20's
    // constant, so this is a second measurement and not the first one again.
    expect(
      reported.clientWidth,
      `the app reports a ${round1(reported.clientWidth)}px surface, which is not narrower than ` +
        `AC20's controlled ${SURFACE_W}px — AC20d would be re-measuring AC20`,
    ).toBeLessThan(SURFACE_W);
    expect(
      extent,
      `the spine measures ${round1(extent)}px against the ${round1(reported.clientWidth)}px ` +
        `surface the app reports at a ${REAL_SURFACE_W}px shell (headroom ` +
        `${round1(reported.clientWidth - extent)}px)`,
    ).toBeLessThanOrEqual(reported.clientWidth + 0.5);
    expect(reported.scrollWidth - reported.clientWidth).toBeLessThanOrEqual(0.5);
  });

  test("AC24 — the SHIPPED path takes the same horizontal axis", async () => {
    await openWide(shippedFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    expect(pieces.map(spineRole)).toEqual([
      "terminal",
      "connector",
      "delivered",
      "connector",
      "gate",
      "connector",
      "terminal",
    ]);
    const stages = pieces.filter((piece) => spineRole(piece) !== "connector");
    for (let at = 1; at < stages.length; at++) {
      expect(stages[at]!.x).toBeGreaterThanOrEqual(stages[at - 1]!.right - 0.5);
      expect(yOverlap(stages[at - 1]!, stages[at]!)).toBeGreaterThan(0);
    }
    // AC21 — and it reconstructs no waves while doing it.
    const empties = await readWide<{ waves: number; nodes: number }>(
      `({
         waves: document.querySelectorAll('[data-testid="roadmap-wave"]').length,
         nodes: document.querySelectorAll('[data-zone="2"] [data-testid="roadmap-node"]').length,
       })`,
    );
    expect(empties.waves).toBe(0);
    expect(empties.nodes).toBe(0);
  });

  test("zones 1, 2 and 3 still stack without overlap at the measured surface", async () => {
    await openWide(singleFixtureUrl);
    const zones = await boxesOf("[data-zone]");
    expect(zones.length).toBe(3);
    for (let at = 1; at < zones.length; at++) {
      expect(
        zones[at]!.top,
        `zone ${at + 1} starts at y=${round1(zones[at]!.top)}, above zone ${at}'s bottom ` +
          `edge ${round1(zones[at - 1]!.bottom)} — the horizontal spine broke the stack`,
      ).toBeGreaterThanOrEqual(zones[at - 1]!.bottom - 0.5);
      // Horizontally they are one column, so the spine cannot have pushed a
      // zone sideways either.
      expect(Math.abs(zones[at]!.x - zones[at - 1]!.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(zones[at]!.width - zones[at - 1]!.width)).toBeLessThanOrEqual(0.5);
    }
  });
});

// ── AC2 / AC4 (C1's deferral) — the marker is a BORDER, and it does not move ─
//
// C1's note: it asserted `.app-flow-wave[data-active="true"] { border-color:
// var(--ember) }` off the stylesheet SOURCE. A declaration is not a rendered
// border — the selector may not match, the token may not resolve, a later rule
// may win. Measured here, with the neutral token proved distinct first so the
// comparison cannot pass on two names for one colour.

describe("CR-CRU-096 AC2/AC4 — the active wave's marker is a RENDERED border, and it never moves", () => {
  test("an active wave renders the ember token as its border, not the neutral line", async () => {
    await openWide(heightFixtureUrl);
    const ember = await tokenColor("--ember", wide());
    const line = await tokenColor("--line", wide());
    expect(ember).not.toBe("");
    expect(line).not.toBe("");
    // Non-vacuity: the two tokens are different colours, so "renders ember"
    // cannot be satisfied by the neutral border the pre-CR build drew.
    expect(sameHue(ember, line), `--ember and --line resolve to the same colour`).toBe(false);

    const waves = await boxesOf('[data-testid="roadmap-wave"]');
    expect(waves.length).toBe(2);
    const active = await readWide<string[]>(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]'))
         .map((w) => w.getAttribute("data-active"))`,
    );
    expect(active).toEqual(["true", "true"]);
    for (const box of waves) {
      expect(
        sameHue(box.borderTopColor, ember),
        `an active wave renders a ${box.borderTopColor} border, not the ember ${ember}`,
      ).toBe(true);
      expect(box.borderTopStyle).toBe("solid");
      // A border that RENDERS, not a declared one. Deliberately not pinned to
      // the stylesheet's `1.5px`: Chromium resolves a border width to a whole
      // number of device pixels, so at DPR 1 the declared 1.5px is USED as
      // 1px. AC2 asks for "a word and a border" and names no width, so the
      // rounding is a measurement to record, not a criterion to fail.
      expect(
        box.borderTopWidth,
        `an active wave renders a ${box.borderTopWidth}px border`,
      ).toBeGreaterThanOrEqual(1);
      // AC2's own clause: a border and a word, NEVER motion.
      expect(box.animationName).toBe("none");
    }
  });

  test("…and the marker is also a WORD, in the same ember", async () => {
    await openWide(heightFixtureUrl);
    const ember = await tokenColor("--ember", wide());
    const dim = await tokenColor("--ink-dim", wide());
    expect(sameHue(ember, dim)).toBe(false);
    const labels = await boxesOf('[data-testid="roadmap-wave"] .app-flow-wave-label');
    expect(labels.length).toBe(2);
    for (const label of labels) {
      expect(label.text).toContain("· active");
      expect(
        sameHue(label.color, ember),
        `the label renders ${label.color}, not the ember ${ember}`,
      ).toBe(true);
      expect(label.animationName).toBe("none");
    }
  });

  test("an active wave with NO running CR renders NO animation anywhere in its subtree", async () => {
    await openWide(heightFixtureUrl);
    const seen = await readWide<{
      statuses: string[];
      elements: number;
      animated: { what: string; animationName: string }[];
    }>(
      `(() => {
         const waves = Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]'));
         const all = waves.flatMap((w) => [w, ...Array.from(w.querySelectorAll("*"))]);
         return {
           statuses: Array.from(
             document.querySelectorAll('[data-zone="2"] [data-testid="roadmap-node"]'),
           ).map((n) => n.getAttribute("data-status")),
           elements: all.length,
           animated: all
             .filter((e) => getComputedStyle(e).animationName !== "none")
             .map((e) => ({
               what: e.getAttribute("data-testid") || String(e.className || ""),
               animationName: getComputedStyle(e).animationName,
             })),
         };
       })()`,
    );
    // The premise: this board's waves are ACTIVE and hold nothing running.
    expect(seen.statuses.length).toBe(10);
    expect(seen.statuses).not.toContain("IN_PROGRESS");
    expect(seen.elements).toBeGreaterThan(20);
    expect(
      seen.animated.map((e) => `${e.what}=${e.animationName}`),
      "an active wave with nothing running animates something",
    ).toEqual([]);
  });

  test("…which is NOT because nothing on this board can animate — a running CR does", async () => {
    // The counter-subject, on the board that HAS one: the same probe finds the
    // IN_PROGRESS row's animation, so the empty list above is a fact about the
    // wave and not about the probe.
    await openWide(surfaceFixtureUrl);
    const animated = await readWide<{ cr: string; animationName: string }[]>(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]'))
         .flatMap((w) => [w, ...Array.from(w.querySelectorAll("*"))])
         .filter((e) => getComputedStyle(e).animationName !== "none")
         .map((e) => ({
           cr: e.getAttribute("data-cr") || "",
           animationName: getComputedStyle(e).animationName,
         }))`,
    );
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.every((e) => e.cr === "CR-V-LIVE")).toBe(true);
  });

  test(
    "an active wave's rendered face never CHANGES across frames",
    async () => {
      // The compositor's own clock, sampled: `animation-name: none` says no
      // animation is declared, and this says nothing actually moved. A
      // transition, a `steps()` keyframe on a pseudo-element or a JS-driven
      // nudge would slip past the computed-style reading and not past this.
      //
      // REAL elapsed time, deliberately, and for the same reason the AC24
      // section above states: a CSS animation is driven by the browser's own
      // compositor clock in ANOTHER PROCESS, and no fake timer in the test
      // runner can advance it. Deterministic time control cannot reach it, so
      // this is the "integration test exercising real timer behaviour against
      // the platform clock" case. The sleep is inside the page, not the runner.
      await openWide(heightFixtureUrl);
      const sampled = await readWide<{ wave: string; faces: string[] }[]>(
        `(async () => {
           const read = () => Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]'))
             .map((w) => {
               const parts = [w, ...Array.from(w.querySelectorAll("*"))].map((e) => {
                 const cs = getComputedStyle(e);
                 const r = e.getBoundingClientRect();
                 return [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor,
                         cs.borderLeftColor, cs.backgroundColor, cs.color, cs.opacity,
                         cs.boxShadow, cs.transform, cs.filter, cs.outlineColor,
                         r.width.toFixed(2), r.height.toFixed(2),
                         r.left.toFixed(2), r.top.toFixed(2)].join("~");
               });
               return { wave: w.getAttribute("data-wave"), face: parts.join("|") };
             });
           const frames = [];
           for (let i = 0; i < 10; i++) {
             frames.push(read());
             await new Promise((done) => setTimeout(done, 200));
           }
           const byWave = new Map();
           for (const frame of frames) {
             for (const entry of frame) {
               const seen = byWave.get(entry.wave) || [];
               if (!seen.includes(entry.face)) seen.push(entry.face);
               byWave.set(entry.wave, seen);
             }
           }
           return Array.from(byWave).map(([wave, faces]) => ({ wave, faces }));
         })()`,
      );
      expect(sampled.length).toBe(2);
      for (const wave of sampled) {
        expect(
          wave.faces.length,
          `wave ${wave.wave} rendered ${wave.faces.length} distinct faces across 10 frames ` +
            `spanning ~2s, but nothing in it is running`,
        ).toBe(1);
      }
    },
    30_000,
  );
});

// ── AC17 (C2's deferral) — the real `overflow`, and height by ROWS ─────────
//
// C2's note: happy-dom resolves no cascade, so `getComputedStyle(wave).overflow`
// there answers the inline style or the empty string, never the stylesheet's.
// And "the wave's height grows with the rows shown, not with membership" is a
// statement about a rendered height, which happy-dom measures as zero.

describe("CR-CRU-096 AC17 — no scroll container inside the wave, and height comes from the ROWS", () => {
  test("nothing inside the wave is a scroll container", async () => {
    await openWide(heightFixtureUrl);
    const inside = await boxesOf(
      '[data-testid="roadmap-wave"], [data-testid="roadmap-wave"] *',
    );
    expect(inside.length).toBeGreaterThan(20);
    for (const el of inside) {
      const what = el.testid === "" ? el.cls : el.testid;
      expect(el.overflowX, `${what} resolves overflow-x: ${el.overflowX}`).toBe("visible");
      expect(el.overflowY, `${what} resolves overflow-y: ${el.overflowY}`).toBe("visible");
    }
  });

  test("…which the probe could have detected — zone 1's track really is a clipper", async () => {
    // Non-vacuity. `overflow: visible` everywhere is only news if a
    // non-visible value on this page WOULD have been read: zone 1's
    // `.app-strip-track` declares `overflow: hidden` and the same probe finds
    // it. AC18's scoping is the reason it may: the strip is zone 1's business.
    await openWide(heightFixtureUrl);
    const track = one(await boxesOf('[data-testid="roadmap-strip-track"]'), "strip track");
    expect(track.overflowX).toBe("hidden");
    expect(track.overflowY).toBe("hidden");
  });

  test("the wave's height is its DRAWN rows times their pitch, and nothing else", async () => {
    await openWide(heightFixtureUrl);
    const measured = await readWide<
      {
        wave: string;
        membership: number;
        headerCount: string;
        rowCrs: string[];
        rowHeights: number[];
        rowGap: number;
        boxH: number;
        bodyH: number;
        headerH: number;
        rollupH: number;
        moreH: number;
        padTop: number;
        padBottom: number;
        borderTop: number;
        borderBottom: number;
      }[]
    >(
      `Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]')).map((w) => {
         const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
         const h = (el) => el === null ? 0 : el.getBoundingClientRect().height;
         const rows = Array.from(w.querySelectorAll('[data-testid="roadmap-node"]'));
         const body = w.querySelector(".app-flow-wave-body");
         const cs = getComputedStyle(w);
         return {
           wave: w.getAttribute("data-wave"),
           membership: Number(w.getAttribute("data-cr-count")),
           headerCount: (w.querySelector('[data-testid="roadmap-wave-count"]') || {}).textContent
             || "",
           rowCrs: rows.map((r) => r.getAttribute("data-cr")),
           rowHeights: rows.map((r) => r.getBoundingClientRect().height),
           rowGap: px(getComputedStyle(body).rowGap),
           boxH: w.getBoundingClientRect().height,
           bodyH: h(body),
           headerH: h(w.querySelector('[data-testid="roadmap-wave-header"]')),
           rollupH: h(w.querySelector('[data-testid="roadmap-wave-rollup"]')),
           moreH: h(w.querySelector('[data-testid="roadmap-wave-more"]')),
           padTop: px(cs.paddingTop),
           padBottom: px(cs.paddingBottom),
           borderTop: px(cs.borderTopWidth),
           borderBottom: px(cs.borderBottomWidth),
         };
       })`,
    );

    expect(measured.length).toBe(2);
    expect(measured.map((box) => box.membership)).toEqual([29, 10]);
    expect(measured.map((box) => box.rowCrs.length)).toEqual([5, 5]);

    for (const box of measured) {
      const rowH = box.rowHeights[0]!;
      // Every drawn row is one pitch: the body is a column flex of equal rows.
      for (const height of box.rowHeights) expect(height).toBeCloseTo(rowH, 1);

      // The body is exactly its five rows, the pointer, and the gaps between
      // the six of them. Membership appears nowhere in this arithmetic.
      const items = box.rowCrs.length + (box.moreH > 0 ? 1 : 0);
      const bodyFromRows =
        box.rowCrs.length * rowH + box.moreH + (items - 1) * box.rowGap;
      expect(
        Math.abs(box.bodyH - bodyFromRows),
        `wave ${box.wave} (membership ${box.membership}) draws a ${round1(box.bodyH)}px body, ` +
          `but ${box.rowCrs.length} rows of ${round1(rowH)}px + a ${round1(box.moreH)}px ` +
          `pointer + ${items - 1} gaps of ${box.rowGap}px is ${round1(bodyFromRows)}px`,
      ).toBeLessThanOrEqual(1);

      // And the box is its chrome plus that body — no membership-sized
      // reservation, no scroller's phantom track.
      const boxFromParts =
        box.borderTop +
        box.padTop +
        box.headerH +
        box.rollupH +
        box.bodyH +
        box.padBottom +
        box.borderBottom;
      expect(
        Math.abs(box.boxH - boxFromParts),
        `wave ${box.wave} measures ${round1(box.boxH)}px tall, but header ` +
          `${round1(box.headerH)} + roll-up ${round1(box.rollupH)} + body ` +
          `${round1(box.bodyH)} + padding ${box.padTop}/${box.padBottom} + borders ` +
          `${box.borderTop}/${box.borderBottom} is ${round1(boxFromParts)}px`,
      ).toBeLessThanOrEqual(1);
    }

    // The claim itself, stated as the comparison only two boxes can make:
    // 29 members and 10 members, five rows each, ONE height. A box that grew
    // with membership would differ here by 24 rows' worth of pitch.
    const [big, small] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(big.headerCount.trim()).toBe("29");
    expect(small.headerCount.trim()).toBe("10");
    expect(
      Math.abs(big.boxH - small.boxH),
      `a 29-member wave measures ${round1(big.boxH)}px and a 10-member one ` +
        `${round1(small.boxH)}px, though both draw ${big.rowCrs.length} rows — the height ` +
        `is tracking MEMBERSHIP`,
    ).toBeLessThanOrEqual(1);
  });

  test("the same 29 members drawn UNTRIMMED are several times taller — the trim is what shortens the box", async () => {
    // The counterfactual, MEASURED rather than estimated: AC18a's `wave: null`
    // group renders the identical 29 members with the identical row markup and
    // takes no trim, so the difference between the two heights is the trim.
    await openWide(heightFixtureUrl);
    const trimmed = await readWide<{ boxH: number; bodyH: number; rowH: number; rows: number }>(
      `(() => {
         const w = document.querySelector('[data-testid="roadmap-wave"]');
         const rows = Array.from(w.querySelectorAll('[data-testid="roadmap-node"]'));
         return {
           boxH: w.getBoundingClientRect().height,
           bodyH: w.querySelector(".app-flow-wave-body").getBoundingClientRect().height,
           rowH: rows[0].getBoundingClientRect().height,
           rows: rows.length,
         };
       })()`,
    );

    await openWide(heightLooseFixtureUrl);
    const untrimmed = await readWide<{ looseH: number; rowH: number; rows: number }>(
      `(() => {
         const loose = document.querySelector(".app-flow-loose");
         const rows = Array.from(loose.querySelectorAll('[data-testid="roadmap-node"]'));
         return {
           looseH: loose.getBoundingClientRect().height,
           rowH: rows[0].getBoundingClientRect().height,
           rows: rows.length,
         };
       })()`,
    );

    // Premise: same members, same row height, one trimmed to five and one not.
    expect(trimmed.rows).toBe(5);
    expect(untrimmed.rows).toBe(29);
    expect(untrimmed.rowH).toBeCloseTo(trimmed.rowH, 1);

    expect(
      untrimmed.looseH / trimmed.bodyH,
      `29 rows draw ${round1(untrimmed.looseH)}px of rows and the trimmed wave draws ` +
        `${round1(trimmed.bodyH)}px — a ratio of ` +
        `${round1(untrimmed.looseH / trimmed.bodyH)}×`,
    ).toBeGreaterThanOrEqual(4);
    expect(
      trimmed.boxH,
      `the trimmed wave box measures ${round1(trimmed.boxH)}px against ` +
        `${round1(untrimmed.looseH)}px of untrimmed rows`,
    ).toBeLessThan(untrimmed.looseH * 0.4);
  });
});

// ── AC7 / AC12 (C3's deferral) — the roll-up's face, the marker's ink ──────
//
// C3's note: it asserted `.app-flow-wave-rollup` carries no `border` and no
// `background` by reading its RULE, and the `next` marker's colour by reading
// that it declares none. Both are cascade questions — a rule elsewhere could
// give either a border or an ember, and `color: inherit` resolves against a
// chain happy-dom does not walk.

describe("CR-CRU-096 AC7/AC12 — the roll-up cannot read as a CR, and the marker takes no state channel", () => {
  test("the roll-up renders unbordered and unfilled, beside CR rectangles that are both", async () => {
    await openWide(heightFixtureUrl);
    const rollups = await boxesOf('[data-testid="roadmap-wave-rollup"]');
    const pointers = await boxesOf('[data-testid="roadmap-wave-more"]');
    const rows = await boxesOf('[data-zone="2"] [data-testid="roadmap-node"]');
    expect(rollups.length).toBe(2);
    expect(pointers.length).toBe(2);
    expect(rows.length).toBe(10);

    // Non-vacuity, on the same page: the rectangle an aggregate must not
    // resemble DOES render a border and a fill, so "no border, no fill" is a
    // distinction the engine can draw.
    for (const row of rows) {
      expect(row.borderMax).toBeGreaterThanOrEqual(1);
      expect(row.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(row.cursor).toBe("pointer");
    }

    for (const chrome of [...rollups, ...pointers]) {
      const what = chrome.testid;
      expect(chrome.borderMax, `${what} renders a ${chrome.borderMax}px border`).toBe(0);
      expect(
        chrome.backgroundColor,
        `${what} renders a ${chrome.backgroundColor} fill`,
      ).toBe("rgba(0, 0, 0, 0)");
      expect(chrome.cursor, `${what} renders as a control`).not.toBe("pointer");
    }

    // AC7's other half: it is not selectable or drillable as a CR either.
    const identity = await readWide<{ cr: string | null; status: string | null }[]>(
      `Array.from(document.querySelectorAll(
         '[data-testid="roadmap-wave-rollup"], [data-testid="roadmap-wave-more"]'
       )).map((e) => ({ cr: e.getAttribute("data-cr"), status: e.getAttribute("data-status") }))`,
    );
    expect(identity.length).toBe(4);
    expect(identity.filter((e) => e.cr !== null || e.status !== null).length).toBe(0);
    for (const rollup of rollups) expect(rollup.text).toContain("merged");
  });

  test("the `next` marker renders in the annotation's own faint ink, never the ember", async () => {
    await openWide(surfaceFixtureUrl);
    const ember = await tokenColor("--ember", wide());
    const faint = await tokenColor("--ink-faint", wide());
    expect(ember).not.toBe("");
    expect(faint).not.toBe("");
    // Non-vacuity: the state channel the marker must not borrow is a
    // measurably different colour, and this board renders it — on the running
    // row, three lines down.
    expect(sameHue(ember, faint)).toBe(false);

    const marker = one(await boxesOf(".app-flow-node-next"), "`next` marker");
    expect(marker.text).toBe("next");
    expect(marker.text).not.toContain("▸");
    expect(
      sameHue(marker.color, faint),
      `the marker renders ${marker.color}, not the annotation's ${faint}`,
    ).toBe(true);
    expect(
      sameHue(marker.color, ember),
      `the marker renders the ember ${ember}, which §S8 reserves for IN_PROGRESS`,
    ).toBe(false);
    expect(marker.animationName).toBe("none");

    // The emphasis is WEIGHT, and it is the marker's alone: the slot it rides
    // in stays at the annotation's own weight.
    const slot = one(
      (await boxesOf('[data-testid="roadmap-node-annotation"]')).filter((s) =>
        s.text.includes("next"),
      ),
      "annotation slot holding the marker",
    );
    expect(Number(marker.fontWeight)).toBeGreaterThan(Number(slot.fontWeight));
    expect(Number(marker.fontWeight)).toBe(700);

    // And the ROW keeps PENDING styling: the same rendered face as a pending
    // row with no marker, and demonstrably not the running row's.
    const faces = await readWide<
      { cr: string; status: string; color: string; borderTopColor: string; animation: string }[]
    >(
      `Array.from(document.querySelectorAll('[data-zone="2"] [data-testid="roadmap-node"]'))
         .map((n) => {
           const cs = getComputedStyle(n);
           return {
             cr: n.getAttribute("data-cr"),
             status: n.getAttribute("data-status"),
             color: cs.color,
             borderTopColor: cs.borderTopColor,
             animation: cs.animationName,
           };
         })`,
    );
    const marked = faces.find((f) => f.cr === "CR-V-PEND")!;
    const running = faces.find((f) => f.status === "IN_PROGRESS")!;
    expect(marked.status).toBe("PENDING");
    expect(marked.animation).toBe("none");
    expect(sameHue(marked.color, ember)).toBe(false);
    expect(sameHue(running.color, ember)).toBe(true);
    expect(running.animation).not.toBe("none");
  });

  test("exactly ONE row in the whole zone renders the marker (AC12b), measured", async () => {
    await openWide(heightFixtureUrl);
    const markers = await readWide<{ count: number; onCr: (string | null)[] }>(
      `(() => {
         const marks = Array.from(document.querySelectorAll('[data-zone="2"] .app-flow-node-next'));
         return {
           count: marks.length,
           onCr: marks.map((m) => m.closest('[data-testid="roadmap-node"]').getAttribute("data-cr")),
         };
       })()`,
    );
    // Two wave boxes, ten drawn rows, one marker — on the first actionable row
    // in the published order across the whole zone.
    expect(markers.count).toBe(1);
    expect(markers.onCr).toEqual(["CR-H-P01"]);
  });
});

// ── AC25 — the greyscale invariant ─────────────────────────────────────────
//
// §S8's two invariants are what this tests: colour never encodes anything
// shape already says, and no element relies on colour alone — status is also
// written as text, so the view survives a colour-blind reader and a greyscale
// screenshot. The strip is the suite's own `STRIP_COLOUR`, total and
// `!important`: ink, border, background AND opacity, so even the dimmed
// luminance channel is taken away and only TEXT can be left standing.

describe("CR-CRU-096 AC25 — with colour removed, every row, roll-up, marker and gate word still states its status", () => {
  const strippedHeightBoard = async (): Promise<void> => {
    await openWide(heightFixtureUrl);
    await wide().addStyleTag({ content: STRIP_COLOUR });
  };

  test("the strip really does flatten this board's colours", async () => {
    // The premise, asserted rather than assumed: after the strip there is ONE
    // ink, ONE border colour and ONE opacity across every drawn row, so
    // anything still telling them apart is provably not colour.
    await strippedHeightBoard();
    const rows = await boxesOf('[data-zone="2"] [data-testid="roadmap-node"]');
    expect(rows.length).toBe(10);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
    expect(new Set(rows.map((row) => row.borderTopColor)).size).toBe(1);
    expect(new Set(rows.map((row) => row.backgroundColor)).size).toBe(1);
  });

  test("every drawn row still states its status in WORDS", async () => {
    await strippedHeightBoard();
    const rows = await readWide<{ cr: string; status: string; statusText: string }[]>(
      `Array.from(document.querySelectorAll('[data-zone="2"] [data-testid="roadmap-node"]'))
         .map((n) => ({
           cr: n.getAttribute("data-cr"),
           status: n.getAttribute("data-status"),
           statusText: ((n.querySelector('[data-testid="roadmap-node-status"]') || {}).textContent
             || "").replace(/\\s+/g, " ").trim(),
         }))`,
    );
    expect(rows.length).toBe(10);
    for (const row of rows) {
      expect(
        row.statusText,
        `${row.cr} (${row.status}) writes no status text, so with colour gone its state ` +
          `is unreadable`,
      ).not.toBe("");
    }
    // Determinable, not merely present: one status text may never stand for
    // two statuses.
    const byText = new Map<string, Set<string>>();
    for (const row of rows) {
      const states = byText.get(row.statusText) ?? new Set<string>();
      states.add(row.status);
      byText.set(row.statusText, states);
    }
    for (const [text, states] of byText) {
      expect(states.size, `the words "${text}" stand for ${[...states].join(" and ")}`).toBe(1);
    }
  });

  test("the roll-up, the `+N more` pointer, the `next` marker and the deps list all still read", async () => {
    await strippedHeightBoard();
    const read = await readWide<{
      rollups: string[];
      pointers: string[];
      markers: string[];
      deps: string[];
      counts: string[];
      labels: string[];
    }>(
      `(() => {
         const texts = (sel) => Array.from(document.querySelectorAll(sel))
           .map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim());
         return {
           rollups: texts('[data-testid="roadmap-wave-rollup"]'),
           pointers: texts('[data-testid="roadmap-wave-more"]'),
           markers: texts('[data-zone="2"] .app-flow-node-next'),
           deps: texts('[data-testid="roadmap-node-annotation"]')
             .filter((t) => t.includes("deps")),
           counts: texts('[data-testid="roadmap-wave-count"]'),
           labels: texts('[data-zone="2"] .app-flow-wave-label'),
         };
       })()`,
    );

    // §S3/AC5/AC25 — the roll-up's greyscale CHANNEL is the WORD `merged`,
    // never the ✓: with the glyph deleted from the string the count still
    // reads, which is the claim, and it is asserted on the stripped text so
    // the glyph cannot be what satisfies it.
    //
    // AC5d is a SECOND, independent fact: the artifact draws `21 merged ✓ ·
    // awaiting the tag`, so the glyph is rendered too — as decoration. Both
    // hold, and the glyph assertion is what would fail if it were dropped from
    // the renderer, which until now nothing anywhere noticed.
    expect(read.rollups.length).toBe(2);
    for (const rollup of read.rollups) {
      expect(rollup.replace(/✓/g, "").replace(/\s+/g, " ").trim()).toMatch(/\d+ merged/);
      expect(rollup.toLowerCase()).toContain("awaiting the tag");
      expect(
        rollup,
        `the roll-up reads "${rollup}" — the approved artifact's ✓ is not rendered (AC5d)`,
      ).toContain("✓");
    }
    // §S5.4/AC16 — the pointer states its remainder in words and numerals.
    expect(read.pointers.length).toBe(2);
    for (const pointer of read.pointers) expect(pointer).toMatch(/^\+\d+ more/);
    // §S4/AC12 — the marker is the word.
    expect(read.markers).toEqual(["next"]);
    // AC13/AC13a — the deps list names full published ids, in text.
    expect(read.deps.length).toBe(2);
    for (const dep of read.deps) expect(dep).toMatch(/deps CR-H-[A-Z]\d\d/);
    // §S1/§S2/AC2/AC3 — the header's two facts survive as words and numerals.
    expect(read.counts).toEqual(["29", "10"]);
    for (const label of read.labels) expect(label).toContain("· active");
  });

  test("BOTH gate words still read — `planned` in flight, `shipped` once tagged (AC23/AC23a)", async () => {
    await strippedHeightBoard();
    const inFlight = await readWide<{ kind: string; word: string; version: string }>(
      `(() => {
         const gate = document.querySelector('[data-testid="roadmap-flow-gate"]');
         return {
           kind: gate.getAttribute("data-kind"),
           version: gate.getAttribute("data-version"),
           word: ((gate.querySelector(".app-flow-gate-state") || {}).textContent || "").trim(),
         };
       })()`,
    );
    expect(inFlight.kind).toBe("proposed");
    expect(inFlight.word).toBe("planned");

    await openWide(shippedFixtureUrl);
    await wide().addStyleTag({ content: STRIP_COLOUR });
    const tagged = await readWide<{ kind: string; word: string; delivered: string }>(
      `(() => {
         const gate = document.querySelector('[data-testid="roadmap-flow-gate"]');
         return {
           kind: gate.getAttribute("data-kind"),
           word: ((gate.querySelector(".app-flow-gate-state") || {}).textContent || "").trim(),
           delivered: ((document.querySelector('[data-testid="roadmap-delivered"]') || {})
             .textContent || "").replace(/\\s+/g, " ").trim(),
         };
       })()`,
    );
    expect(tagged.kind).toBe("shipped");
    expect(tagged.word).toBe("shipped");
    // …and the delivered summary states its own facts in words too.
    expect(tagged.delivered).toMatch(/\d+ CRs?/);
    expect(tagged.delivered).toMatch(/waves? /);
    expect(tagged.delivered.toLowerCase()).toContain("shipped");

    // The two words are DIFFERENT, so the diamond's state is readable with
    // both colour and the dash reduced to shape alone.
    expect(inFlight.word).not.toBe(tagged.word);
  });
});

// ── AC27 — the panel match against the APPROVED artifact ───────────────────
//
// The artifact is rendered by the SAME Chromium that renders the live board,
// so this is a render-to-render comparison and not a comparison against my
// reading of the file. Its own structure is read out of its own DOM: nothing
// below hardcodes what the artifact says.
//
// AC27 compares AXIS, HEADER, ROLL-UP, ROW ARRANGEMENT and MARKERS. It does
// NOT compare type scale — §S7's own non-goal records the artifact's
// `.big`/`.cue` hierarchy in the shipped summary as out of scope — and it does
// not compare annotation TEXT, because AC13a deliberately departs from the
// artifact's project-dependent `deps 091, 092` abbreviation.

interface PanelShape {
  roles: string[];
  stages: { role: string; x: number; right: number; top: number; bottom: number }[];
  waveBoxes: number;
  headerParts: string[];
  headerSameLine: boolean;
  headerLabelFirst: boolean;
  rollup: string;
  rowCount: number;
  rowsFullWidth: boolean;
  rowsStacked: boolean;
  slotRightAligned: boolean;
  more: string;
  markers: number;
  gateWord: string;
  delivered: string | null;
}

/** The artifact's own zone-2 panels, read out of the artifact's own DOM. */
const ARTIFACT_SHAPES = `
function __artifactPanels() {
  const text = (el) => el === null ? "" : (el.textContent || "").replace(/\\s+/g, " ").trim();
  const rect = (el) => { const r = el.getBoundingClientRect();
    return { x: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width }; };
  const roleOf = (el) => {
    if (el.classList.contains("term")) return "terminal";
    if (el.classList.contains("arrow")) return "connector";
    if (el.classList.contains("wave")) return "waves";
    if (el.classList.contains("gatecol")) return "gate";
    if (el.classList.contains("delivered")) return "delivered";
    if (el.classList.contains("empty")) return "empty";
    return "unknown(" + el.className + ")";
  };
  const flows = Array.from(document.querySelectorAll(".zone"))
    .filter((z) => text(z).toLowerCase().indexOf("zone 2") === 0)
    .map((z) => {
      let node = z.nextElementSibling;
      while (node !== null && !node.classList.contains("flow")) node = node.nextElementSibling;
      return node;
    })
    .filter((node) => node !== null);
  return flows.map((flow) => {
    const kids = Array.from(flow.children);
    const wave = flow.querySelector(".wave");
    const delivered = flow.querySelector(".delivered");
    const gate = flow.querySelector(".gate");
    const crs = wave === null ? null : wave.querySelector(".crs");
    const rows = crs === null ? [] : Array.from(crs.querySelectorAll(":scope > .cr"));
    const header = wave === null ? null : wave.querySelector("h4");
    const headerKids = header === null ? [] : Array.from(header.children);
    const slots = rows.map((r) => r.querySelector(".t")).filter((s) => s !== null);
    return {
      roles: kids.map(roleOf),
      stages: kids.filter((k) => roleOf(k) !== "connector")
        .map((k) => Object.assign({ role: roleOf(k) }, rect(k))),
      waveBoxes: flow.querySelectorAll(".wave").length,
      headerParts: headerKids.map(text),
      headerSameLine: headerKids.length === 2 &&
        Math.abs(rect(headerKids[0]).top - rect(headerKids[1]).top) <= 3,
      headerLabelFirst: headerKids.length === 2 &&
        rect(headerKids[0]).x < rect(headerKids[1]).x,
      rollup: wave === null ? "" : text(wave.querySelector(".wsum")),
      rowCount: rows.length,
      rowsFullWidth: rows.length > 0 && crs !== null &&
        rows.every((r) => Math.abs(rect(r).w - rect(crs).w) <= 1),
      rowsStacked: rows.length > 1 &&
        rows.every((r, at) => at === 0 ||
          (Math.abs(rect(r).x - rect(rows[at - 1]).x) <= 1 &&
           rect(r).top >= rect(rows[at - 1]).bottom - 1)),
      slotRightAligned: slots.length > 0 &&
        slots.every((s) => rect(s).right > rect(s.closest(".cr")).x +
          rect(s.closest(".cr")).w / 2),
      more: wave === null ? "" : text(wave.querySelector(".more")),
      markers: wave === null ? 0 : wave.querySelectorAll(".crs .t b").length,
      gateWord: gate === null ? "" : text(gate.querySelector("b")),
      delivered: delivered === null ? null : text(delivered),
    };
  });
}
`;

/** The LIVE board's zone-2 panel, read the same way off what it publishes. */
const LIVE_SHAPE = `
function __livePanel() {
  const text = (el) => el === null ? "" : (el.textContent || "").replace(/\\s+/g, " ").trim();
  const rect = (el) => { const r = el.getBoundingClientRect();
    return { x: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width }; };
  const roleOf = (el) => {
    const id = el.getAttribute("data-testid") || "";
    if (id === "roadmap-flow-terminal") return "terminal";
    if (id === "roadmap-flow-connector") return "connector";
    if (id === "roadmap-flow-gate") return "gate";
    if (id === "roadmap-delivered") return "delivered";
    if (el.classList.contains("app-flow-waves")) return "waves";
    return "unknown(" + (id || el.className) + ")";
  };
  const flow = document.querySelector('[data-zone="2"]');
  const kids = Array.from(flow.children);
  const wave = flow.querySelector('[data-testid="roadmap-wave"]');
  const delivered = flow.querySelector('[data-testid="roadmap-delivered"]');
  const gate = flow.querySelector('[data-testid="roadmap-flow-gate"]');
  const body = wave === null ? null : wave.querySelector(".app-flow-wave-body");
  const rows = body === null ? [] : Array.from(body.querySelectorAll('[data-testid="roadmap-node"]'));
  const header = wave === null ? null : wave.querySelector('[data-testid="roadmap-wave-header"]');
  const headerKids = header === null ? [] : Array.from(header.children);
  const slots = rows.map((r) => r.querySelector('[data-testid="roadmap-node-annotation"]'))
    .filter((s) => s !== null);
  return {
    roles: kids.map(roleOf),
    stages: kids.filter((k) => roleOf(k) !== "connector")
      .map((k) => Object.assign({ role: roleOf(k) }, rect(k))),
    waveBoxes: flow.querySelectorAll('[data-testid="roadmap-wave"]').length,
    headerParts: headerKids.map(text),
    headerSameLine: headerKids.length === 2 &&
      Math.abs(rect(headerKids[0]).top - rect(headerKids[1]).top) <= 3,
    headerLabelFirst: headerKids.length === 2 &&
      rect(headerKids[0]).x < rect(headerKids[1]).x,
    rollup: wave === null ? "" : text(wave.querySelector('[data-testid="roadmap-wave-rollup"]')),
    rowCount: rows.length,
    rowsFullWidth: rows.length > 0 && body !== null &&
      rows.every((r) => Math.abs(rect(r).w - rect(body).w) <= 1),
    rowsStacked: rows.length > 1 &&
      rows.every((r, at) => at === 0 ||
        (Math.abs(rect(r).x - rect(rows[at - 1]).x) <= 1 &&
         rect(r).top >= rect(rows[at - 1]).bottom - 1)),
    slotRightAligned: slots.length > 0 &&
      slots.every((s) => rect(s).right > rect(s.closest('[data-testid="roadmap-node"]')).x +
        rect(s.closest('[data-testid="roadmap-node"]')).w / 2),
    more: wave === null ? "" : text(wave.querySelector('[data-testid="roadmap-wave-more"]')),
    markers: wave === null ? 0 : wave.querySelectorAll(".app-flow-node-next").length,
    gateWord: gate === null ? "" : text(gate.querySelector(".app-flow-gate-state")),
    delivered: delivered === null ? null : text(delivered),
  };
}
`;

const artifactPanels = async (): Promise<PanelShape[]> => {
  await openWide(artifactUrl);
  return await readWide<PanelShape[]>(
    `(() => { ${ARTIFACT_SHAPES} return __artifactPanels(); })()`,
  );
};

const livePanel = async (url: string): Promise<PanelShape> => {
  await openWide(url);
  return await readWide<PanelShape>(`(() => { ${LIVE_SHAPE} return __livePanel(); })()`);
};

/** Horizontal, stated once for both sides of the comparison. */
const isHorizontal = (shape: PanelShape): boolean =>
  shape.stages.length > 1 &&
  shape.stages.every(
    (stage, at) =>
      at === 0 ||
      (stage.x >= shape.stages[at - 1]!.right - 1 &&
        Math.min(stage.bottom, shape.stages[at - 1]!.bottom) -
          Math.max(stage.top, shape.stages[at - 1]!.top) >
          0),
  );

describe("CR-CRU-096 AC27 — zone 2 rendered against the live board matches the artifact's panels", () => {
  test("the artifact's own zone-2 panels are readable and horizontal", async () => {
    expect(
      artifactFailure,
      `AC27's binding design source could not be read (${ARTIFACT_REL} is TRACKED since ` +
        `AC27a — .gitignore:18 negates it back in, so a clean clone has it): ${artifactFailure}`,
    ).toBe("");
    const panels = await artifactPanels();
    expect(panels.length).toBeGreaterThanOrEqual(2);
    // The premise of the whole comparison: the artifact really does draw the
    // spine horizontally, so "the same axis" is a claim about a measured axis.
    for (const panel of panels) {
      expect(panel.roles.filter((role) => role === "connector").length).toBe(3);
      expect(panel.roles.length).toBe(7);
      expect(isHorizontal(panel), `an artifact panel is not laid out horizontally`).toBe(true);
    }
  });

  test("the ACTIVE panel: axis, header, roll-up, row arrangement and markers all match", async () => {
    expect(artifactFailure).toBe("");
    const panels = await artifactPanels();
    const design = panels.find((panel) => panel.waveBoxes > 0);
    expect(design, "the artifact draws no zone-2 panel with a wave box").toBeDefined();
    const live = await livePanel(singleFixtureUrl);

    // AXIS — the same role sequence, and horizontal in both.
    expect(live.roles).toEqual(design!.roles);
    expect(isHorizontal(live)).toBe(true);

    // ONE BOX PER WAVE — the artifact's release spans one wave and draws one.
    expect(live.waveBoxes).toBe(design!.waveBoxes);

    // HEADER — a label carrying the `· active` marker and a bare count, on one
    // line, label first. Compared as a SHAPE: the artifact's numbers are its
    // own board's.
    expect(live.headerParts.length).toBe(design!.headerParts.length);
    expect(live.headerSameLine).toBe(design!.headerSameLine);
    expect(live.headerLabelFirst).toBe(design!.headerLabelFirst);
    expect(design!.headerParts[0]).toMatch(/· active$/i);
    expect(live.headerParts[0]).toMatch(/· active$/i);
    expect(design!.headerParts[1]).toMatch(/^\d+$/);
    expect(live.headerParts[1]).toMatch(/^\d+$/);

    // ROLL-UP — one line, a merged count and the release's gate state.
    expect(design!.rollup).toMatch(/^\d+ merged/);
    expect(live.rollup).toMatch(/^\d+ merged/);
    expect(live.rollup.toLowerCase()).toContain("awaiting the tag");
    expect(design!.rollup.toLowerCase()).toContain("awaiting the tag");

    // ROW ARRANGEMENT — one CR per FULL-WIDTH row, stacked, with the
    // annotation slot on the right. Measured on both, not read off a class.
    expect(live.rowCount).toBe(design!.rowCount);
    expect(design!.rowsFullWidth).toBe(true);
    expect(live.rowsFullWidth).toBe(true);
    expect(design!.rowsStacked).toBe(true);
    expect(live.rowsStacked).toBe(true);
    expect(design!.slotRightAligned).toBe(true);
    expect(live.slotRightAligned).toBe(true);

    // MARKERS — the `+N more` pointer and exactly one `next`.
    expect(design!.more).toMatch(/^\+\d+ more/);
    expect(live.more).toMatch(/^\+\d+ more/);
    expect(live.markers).toBe(design!.markers);
    expect(live.markers).toBe(1);

    // The gate states its own state, in the artifact's own word.
    expect(live.gateWord).toBe(design!.gateWord);
  });

  test("the SHIPPED panel: the delivered summary, on the same axis, with the same gate word", async () => {
    expect(artifactFailure).toBe("");
    const panels = await artifactPanels();
    const design = panels.find((panel) => panel.delivered !== null);
    expect(design, "the artifact draws no zone-2 delivered panel").toBeDefined();
    const live = await livePanel(shippedFixtureUrl);

    expect(live.roles).toEqual(design!.roles);
    expect(isHorizontal(live)).toBe(true);
    // §S7 — a delivered summary, not a wave reconstruction, on both sides.
    expect(design!.waveBoxes).toBe(0);
    expect(live.waveBoxes).toBe(0);
    expect(live.rowCount).toBe(0);
    expect(live.gateWord).toBe(design!.gateWord);
    expect(live.gateWord).toBe("shipped");

    // The FACTS the summary states, matched as facts. Its internal line
    // grouping and type scale are §S7's recorded non-goal, so the comparison
    // is on the text the panel carries and not on how many lines carry it.
    for (const summary of [design!.delivered ?? "", live.delivered ?? ""]) {
      expect(summary).toMatch(/\d+ CRs?/);
      expect(summary).toMatch(/waves? /);
      expect(summary.toLowerCase()).toContain("shipped");
    }
  });
});

// ── AC26 — zone 1 and zone 3, byte-identical ──────────────────────────────
//
// "Before and after this CR" is a claim about two RENDERS, so the before-state
// is rendered: `beforeAll` captures the same board through the shell as of
// `git merge-base develop HEAD` — the commit this feature branch was cut from
// and the state the CR was filed against — and serves it beside the current
// one. Both strings then pass through the SAME Chromium parser and serialiser,
// so a real difference in either zone survives and a serialisation artefact
// cannot manufacture one.

describe("CR-CRU-096 AC26 — zones 1 and 3 are untouched by this CR", () => {
  const zoneMarkup = async (url: string): Promise<{ one: string; three: string }> => {
    await openWide(url);
    return await readWide<{ one: string; three: string }>(
      `({
         one: (document.querySelector('[data-zone="1"]') || {}).outerHTML || "",
         three: (document.querySelector('[data-zone="3"]') || {}).outerHTML || "",
       })`,
    );
  };

  test("the pre-CR baseline really did render", async () => {
    expect(
      baselineFailure,
      `the pre-CR shell could not be captured, so AC26 has nothing to compare against: ` +
        `${baselineFailure}`,
    ).toBe("");
    expect(baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    const before = await zoneMarkup(baselineFixtureUrl);
    expect(before.one, `the baseline rendered no zone 1`).not.toBe("");
    expect(before.three, `the baseline rendered no zone 3`).not.toBe("");
    // Non-vacuity for the two comparisons below: zone 2 DID change, so the
    // baseline is a different build and not the current one by accident.
    const beforeTwo = await readWide<string>(
      `(document.querySelector('[data-zone="2"]') || {}).outerHTML || ""`,
    );
    const after = await zoneMarkup(surfaceFixtureUrl);
    const afterTwo = await readWide<string>(
      `(document.querySelector('[data-zone="2"]') || {}).outerHTML || ""`,
    );
    expect(after.one).not.toBe("");
    expect(
      afterTwo,
      `zone 2's markup is unchanged from ${baselineCommit.slice(0, 7)}, so either the CR ` +
        `landed nothing or the baseline is the current build`,
    ).not.toBe(beforeTwo);
  });

  test("zone 1's markup is byte-identical to the pre-CR baseline", async () => {
    expect(baselineFailure).toBe("");
    const before = await zoneMarkup(baselineFixtureUrl);
    const after = await zoneMarkup(surfaceFixtureUrl);
    expect(
      after.one,
      `zone 1's markup changed against ${baselineCommit.slice(0, 7)}, which AC26 freezes`,
    ).toBe(before.one);
  });

  test("zone 3's markup is byte-identical to the pre-CR baseline", async () => {
    expect(baselineFailure).toBe("");
    const before = await zoneMarkup(baselineFixtureUrl);
    const after = await zoneMarkup(surfaceFixtureUrl);
    expect(
      after.three,
      `zone 3's markup changed against ${baselineCommit.slice(0, 7)}, which AC26 freezes`,
    ).toBe(before.three);
  });
});

// ── NON-VACUITY, MEASURED — the same probes on the PRE-CR render ───────────
//
// C1–C4 landed the production code, so most of the readings above pass on
// arrival. A measurement that passes is only worth the argument that it COULD
// have failed, and the strongest form of that argument is not prose: it is the
// same probe, pointed at the render this CR was filed against, reporting the
// drift the CR's own Problem table names.
//
// | | approved design | live implementation | § |
// | flow axis | horizontal `Start → wave → gate → End`, connectors | vertical
//   stack, no connectors | S6 |
// | wave header | `WAVE 5 · ACTIVE` + right-aligned count | `Wave 5` — no
//   marker, no count | S1, S2 |
// | wave roll-up | `21 merged ✓ awaiting the tag` | absent | S3 |
// | per-CR annotation | right-aligned `next` / `deps 078` | none | S4 |
// | CR arrangement | full-width rows, one CR per row | chips wrapped
//   7-per-row | S5 |
//
// Each row of that table is one assertion below, taken off the pre-CR pixels.
// If a future cycle reverts any of §S1–§S6, THIS block stops passing too —
// which is the point: it is what makes the blocks above non-vacuous.

describe("CR-CRU-096 — the same probes on the PRE-CR render report the drift the CR names", () => {
  test("the pre-CR spine was VERTICAL and drew no connectors (§S6)", async () => {
    expect(baselineFailure).toBe("");
    await openWide(baselineFixtureUrl);
    const pieces = await boxesOf('[data-zone="2"] > *');
    expect(pieces.length).toBeGreaterThan(0);
    expect(
      pieces.filter((piece) => spineRole(piece) === "connector").length,
      `the pre-CR build already drew connectors, so AC20's connector assertion proves nothing`,
    ).toBe(0);

    // Stacked: each child begins BELOW the previous one and shares no vertical
    // span with it — the exact negation of the horizontal reading measured
    // above. Deliberately NOT "and shares an x": the pre-CR terminals were
    // `align-self: center` inside an `align-items: stretch` column, so a
    // centred 52px pill and a full-width wave box legitimately start at
    // different x while still being stacked. The first draft of this
    // assertion said otherwise and the measurement corrected it.
    const stacked = pieces.every(
      (piece, at) =>
        at === 0 ||
        (yOverlap(pieces[at - 1]!, piece) <= 0 && piece.top >= pieces[at - 1]!.bottom - 0.5),
    );
    expect(
      stacked,
      `the pre-CR zone 2 was not a vertical stack, so the horizontal measurement above is ` +
        `not discriminating: ${JSON.stringify(
          pieces.map((p) => [spineRole(p), round1(p.x), round1(p.top)]),
        )}`,
    ).toBe(true);
  });

  test("the pre-CR wave header carried NO `· active` marker and NO count (§S1/§S2)", async () => {
    expect(baselineFailure).toBe("");
    await openWide(baselineFixtureUrl);
    const header = await readWide<{ labels: string[]; counts: number; markers: number }>(
      `(() => {
         const waves = Array.from(document.querySelectorAll('[data-testid="roadmap-wave"]'));
         return {
           labels: waves.map((w) => (w.textContent || "").replace(/\\s+/g, " ").trim()),
           counts: document.querySelectorAll('[data-testid="roadmap-wave-count"]').length,
           markers: waves.filter((w) => (w.textContent || "").includes("· active")).length,
         };
       })()`,
    );
    expect(header.labels.length).toBeGreaterThan(0);
    expect(header.counts, `the pre-CR header already rendered a count`).toBe(0);
    expect(header.markers, `the pre-CR header already rendered the '· active' marker`).toBe(0);
  });

  test("the pre-CR wave drew NO roll-up and NO annotation slot (§S3/§S4)", async () => {
    expect(baselineFailure).toBe("");
    await openWide(baselineFixtureUrl);
    const absent = await readWide<{
      rollups: number;
      pointers: number;
      slots: number;
      markers: number;
    }>(
      `({
         rollups: document.querySelectorAll('[data-testid="roadmap-wave-rollup"]').length,
         pointers: document.querySelectorAll('[data-testid="roadmap-wave-more"]').length,
         slots: document.querySelectorAll('[data-testid="roadmap-node-annotation"]').length,
         markers: document.querySelectorAll('.app-flow-node-next').length,
       })`,
    );
    expect(absent.rollups, `the pre-CR wave already drew a roll-up`).toBe(0);
    expect(absent.pointers, `the pre-CR wave already drew a '+N more' pointer`).toBe(0);
    expect(absent.slots, `the pre-CR row already had an annotation slot`).toBe(0);
    expect(absent.markers, `the pre-CR row already carried a 'next' marker`).toBe(0);
  });

  test("the pre-CR CRs were CHIPS side by side, not full-width rows (§S5)", async () => {
    expect(baselineFailure).toBe("");
    await openWide(baselineFixtureUrl);
    const chips = await readWide<{ cr: string; x: number; top: number; width: number }[]>(
      `Array.from(document.querySelectorAll('[data-zone="2"] [data-testid="roadmap-node"]'))
         .map((n) => {
           const r = n.getBoundingClientRect();
           return { cr: n.getAttribute("data-cr"), x: r.left, top: r.top, width: r.width };
         })`,
    );
    expect(chips.length).toBeGreaterThan(1);
    // Two CRs sharing a line at different x is a WRAPPED GRID, and it is what
    // the full-width-row measurement above rules out.
    const sideBySide = chips.some((chip, at) =>
      chips.some(
        (other, other_at) =>
          other_at !== at && Math.abs(other.top - chip.top) <= 1 && other.x !== chip.x,
      ),
    );
    expect(
      sideBySide,
      `the pre-CR build already drew one CR per row, so AC8/AC27's row arrangement ` +
        `measurement proves nothing: ${JSON.stringify(chips)}`,
    ).toBe(true);

    // …and the pre-CR trim did not exist either: every member drew a chip.
    expect(chips.length).toBe(FOCUSED_CRS.length);
  });
});
