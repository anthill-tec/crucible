// CR-CRU-102 §S1 — THE DEPENDENCY ANNOTATION'S BARE FORM, DERIVED FROM THE DATA.
//
// Spec: docs/changes/CR-CRU-102-dependency-annotations-return-to-the-designs-bare-form.md
//       §S1 (the annotation renders a DATA-DERIVED bare form, both zones)
//       AC1, AC2, AC3, AC6, AC7, AC8
//
// WHAT THIS IS NOT: a reversal of CR-CRU-096's `AC13a`. That AC ruled the
// artifact's `deps 091, 092` OUT because stripping `CR-CRU-` is knowledge of
// one project's id shape, and `AC29` forbids a criterion that only holds while
// our own backlog looks a certain way. The ruling was correct and the conflict
// was real. §S1 resolves it in favour of BOTH by never naming a prefix: given
// the row's OWN id and a dependency id, the product finds their common leading
// text, trims it back to the last character that is not a digit, and renders
// the dependency's remainder only if that remainder is entirely digits. Two
// strings compared; no prefix known. What abbreviates does so because the DATA
// says so, and what cannot abbreviate renders its full published id.
//
// THE TWO DIRECTIONS ARE BOTH ASSERTED HERE, and the second is the one a
// future reader is most likely to mistake for a bug (AC7 says so in as many
// words): the tree's existing synthetic boards — `CR-W1-A`/`CR-W2-A` in
// tests/roadmap-release-focus.test.ts, `CR-H-P02`/`CR-H-M01` in
// tests/roadmap-visual-grammar.test.ts, `CR-K-1`/`CR-D-11` in
// tests/roadmap-wave-rollup.test.ts — all keep showing FULL ids, and every one
// of those assertions is UNCHANGED by this CR. None of their remainders is
// numeric, so no project-independent rule can abbreviate them. Their staying
// green IS the fallback working, and this file states the same fallback on a
// board of its own so the claim does not rest on reading someone else's file.
//
// AC8/AC29 — every id below is INVENTED. `CR-B-*` is this board's own
// namespace, and the numeric tails are chosen so the rendered strings AC1
// states (`deps 078`, and the four bare ids `014, 091, 092, 095`) are
// reproduced byte-for-byte without naming one real CR of the project running
// Crucible. CR-CRU-109 §S1 later capped what ZONE 2 states from those four to
// `deps 014, 091 +2`; zone 3's chips still read all four, so both halves of
// AC1's example are still rendered by this board, one per zone. The live board
// was the ONLY thing exercising the abbreviating path when this CR opened,
// which is the gap AC8 closes.
//
// RED phase — expected to FAIL against current production, which:
//   • exports no `bareDependencyId` from public/app-logic.mjs, so every pure
//     call is "not a function";
//   • pushes `deps ${deps.join(", ")}` in zone 2's annotation slot and renders
//     `d` verbatim in zone 3's depends-on chip, so both zones read
//     `deps CR-B-014, CR-B-091, CR-B-092, CR-B-095` where AC1 wants
//     `deps 014, 091, 092, 095`. Measured on this tree before the change:
//       zone2 CR-B-096: "deps CR-B-078"
//       zone3 CR-B-096: chips ["CR-B-078"]
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as AppLogic from "../public/app-logic.mjs";
import { REPO_ROOT, jsUncommented, listFiles } from "./helpers/source-scan";

const VAN_SRC = readFileSync(join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = join(REPO_ROOT, "public/app-logic.mjs");

// ── The pure boundary ──────────────────────────────────────────────────────
//
// The ambient tests/app-logic.d.ts predates this export, so the module is cast
// to the boundary under test ONCE (the tests/roadmap-release-focus.test.ts
// pattern). Until GREEN adds it, every call is "is not a function" — the
// intended missing-export RED signal.
const Logic = AppLogic as unknown as {
  bareDependencyId: (cr: unknown, dependency: unknown) => string;
};

// ── CR-CRU-109 §S1/AC8 — the DISPLAY CAP, read from its ONE definition ─────
//
// The number has already moved once BEFORE implementation (three ids, then
// two, on §S1's measurement of the live board), which is exactly why nothing
// in this repo spells it except the AC8 test at the foot of this file. Every
// other expectation is composed from what the product publishes, so a cap
// that moves again moves the suites with it.

/** The cap the product publishes. Absent until it exists, and this assertion
 *  NAMES that absence rather than letting an `undefined` leak into a template
 *  and fail as arithmetic on `NaN` — the RED signal must read as "no cap",
 *  not as a broken expectation. */
const capOf = (): number => {
  const value = (AppLogic as unknown as { DEPENDENCY_ANNOTATION_CAP?: unknown })
    .DEPENDENCY_ANNOTATION_CAP;
  expect(
    typeof value,
    "public/app-logic.mjs exports no numeric DEPENDENCY_ANNOTATION_CAP — CR-CRU-109 §S1/AC8's " +
      "display cap has no single definition for this suite to read",
  ).toBe("number");
  return value as number;
};

/** What zone 2's `deps` part reads for ids ALREADY in their rendered bare
 *  form: the first `cap` of them in AUTHORED order, then the COUNT of the
 *  rest — and never a `+0` (AC2). */
const cappedDeps = (ids: readonly string[]): string => {
  const cap = capOf();
  const rest = ids.length - cap;
  return `deps ${ids.slice(0, cap).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
};

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

/** `src/types.ts` (`QueueEntry`) — what `GET …/queue` publishes, `ORDER BY seq`. */
interface QueueFixture {
  cr: string;
  title: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  planId?: number;
  seq: number;
  release: string;
  track?: string;
}

const RELEASE = "0.2.0";
const TARGET_AT = 1790000000;

const pending = (cr: string, seq: number, dependsOn: string[]): QueueFixture => ({
  cr,
  title: `${cr} — a scheduled row`,
  wave: "5",
  dependsOn,
  status: "PENDING",
  seq,
  release: RELEASE,
  track: "1",
});

// ── Fixtures ───────────────────────────────────────────────────────────────

/** AC1/AC2/AC8's board — the ABBREVIATING path, on invented ids.
 *
 *  `CR-B-000` leads and declares nothing, so it takes AC12's ONE `next`
 *  marker and the two rows below it carry a `deps` slot and nothing else:
 *  AC1's two rendered strings are then the whole annotation, not a substring
 *  of one that also says `next`.
 *
 *  The tails are the arithmetic AC1 turns on. `CR-B-075` beside `CR-B-014`
 *  shares `CR-B-0`, which trims to `CR-B-` because `0` is a digit, leaving
 *  `014` — entirely digits, so `014` renders. `CR-B-096` beside `CR-B-078`
 *  does the same and leaves `078`. */
const BARE_QUEUE: QueueFixture[] = [
  pending("CR-B-000", 10, []),
  pending("CR-B-075", 20, ["CR-B-014", "CR-B-091", "CR-B-092", "CR-B-095"]),
  pending("CR-B-096", 30, ["CR-B-078"]),
];

/** AC7's board — the FALLBACK path, on invented ids whose remainder is not
 *  numeric, so the full published id is what renders.
 *
 *  `CR-W2-A` beside `CR-W1-A` is the pair §S1 names: the common leading text
 *  is `CR-W`, which needs no trim (`W` is not a digit), and the remainder
 *  `1-A` is not entirely digits. `CR-H-A01` beside `CR-H-M02` is the second
 *  shape §S1 names — a numeric-LOOKING id whose distinguishing character is a
 *  letter, so `M02` fails the all-digits test even though `01`/`02` are
 *  digits. Both are the shapes the tree's existing synthetic suites already
 *  assert full ids on, restated here so this file states its own fallback. */
const FALLBACK_QUEUE: QueueFixture[] = [
  pending("CR-W2-A", 10, ["CR-W1-A"]),
  pending("CR-H-A01", 20, ["CR-H-M02"]),
];

/** AC3's board — the abbreviation ON, and every non-rendering consumer read
 *  beside it. `CR-B-101` is authored BEFORE the dependency it declares, which
 *  is CR-CRU-078/AC15's inversion, so the order warning renders on the one
 *  row whose chip is abbreviated: the chip reads `102` and the warning must
 *  still name `CR-B-102`. `CR-B-102` runs, so it is the board's one drillable
 *  row (`roadmapDrillable` is `IN_PROGRESS || COMPLETED`). */
const CONSUMER_QUEUE: QueueFixture[] = [
  pending("CR-B-101", 10, ["CR-B-102"]),
  {
    cr: "CR-B-102",
    title: "CR-B-102 — under way, and the row a click drills through",
    wave: "5",
    dependsOn: [],
    status: "IN_PROGRESS",
    planId: 41,
    seq: 20,
    release: RELEASE,
    track: "1",
  },
];

// ── CR-CRU-109 §S1's boards — the CAP, one row per declared COUNT ──────────

/** `count` declared dependencies in AUTHORED order. Every one of them
 *  abbreviates: `CR-B-011` beside a `CR-B-0NN` row shares `CR-B-0`, which
 *  trims back to `CR-B-` because `0` is a digit, leaving a three-digit tail
 *  (`011`, `022`, …). So the bare form is settled for every board below and
 *  the only thing the asserted strings vary is HOW MANY ids are stated. */
const declared = (count: number): string[] =>
  Array.from({ length: count }, (_slot, at) => `CR-B-${String(11 * (at + 1)).padStart(3, "0")}`);

/** The bare form `declared(count)` renders as — the tail after `CR-B-`, which
 *  is what CR-CRU-102's rule leaves and what this file already pins
 *  byte-exact for this namespace. */
const declaredBare = (count: number): string[] =>
  declared(count).map((dep) => dep.slice("CR-B-".length));

/** AC1/AC3/AC8's board — three, five and seven declared dependencies, so the
 *  remainder is a different number on every row and no assertion can pass on
 *  another row's string.
 *
 *  `CR-B-000` leads and declares nothing, so it takes AC12's ONE `next` marker
 *  and every row below states a `deps` part and NOTHING else: the strings
 *  asserted are then the whole annotation rather than a substring of one that
 *  also says `next` (AC4 asserts that composition on its own board). Four rows
 *  is what §S5's trim draws, so no `+N more` pointer stands between this board
 *  and its own rows. */
const CAP_QUEUE: QueueFixture[] = [
  pending("CR-B-000", 10, []),
  pending("CR-B-030", 20, declared(3)),
  pending("CR-B-050", 30, declared(5)),
  pending("CR-B-070", 40, declared(7)),
];

/** AC1's ORDERING board — the one board here whose AUTHORED dependency order
 *  is NOT its sorted order, which is what makes "the FIRST ones, in AUTHORED
 *  order" an INDEPENDENT claim. Every other board declares its ids ascending,
 *  so a renderer that sorted before slicing would satisfy their whole-string
 *  pins unchanged; on this row sorting states `deps 011, 044` and taking the
 *  last two states `deps 044, 077`, and neither is what it declares first.
 *  `CR-B-000` leads and declares nothing so it takes AC12's one `next` marker,
 *  leaving the subject row's slot a `deps` part and nothing else. */
const SHUFFLED_QUEUE: QueueFixture[] = [
  pending("CR-B-000", 10, []),
  pending("CR-B-060", 20, ["CR-B-077", "CR-B-011", "CR-B-044"]),
];

/** AC2's board — the counts AT and BELOW the cap, which it must leave exactly
 *  as CR-CRU-102 left them: no remainder token at all, and never a `+0`. */
const UNCAPPED_QUEUE: QueueFixture[] = [
  pending("CR-B-000", 10, []),
  pending("CR-B-010", 20, declared(1)),
  pending("CR-B-020", 30, declared(2)),
];

/** AC4's board — the LIVE-SHAPED row: the zone's one `next` marker on the
 *  SAME row that declares four dependencies. That is the arrangement that
 *  broke the budget (§S1: `CR-CRU-075 next · deps 014, 091, 092, 095` measured
 *  332.4px against ~300px), and it is the row §S1's measurement table records
 *  at 292.5px once capped. The ids are `BARE_QUEUE`'s own, so the string this
 *  board asserts is the table's own string. `CR-B-096` follows so the marker
 *  landing on the four-dependency row is a FACT about the board and not the
 *  only row there is. */
const MARKED_QUEUE: QueueFixture[] = [
  pending("CR-B-075", 10, ["CR-B-014", "CR-B-091", "CR-B-092", "CR-B-095"]),
  pending("CR-B-096", 20, ["CR-B-078"]),
];

/** AC6/AC7's board — a FIVE-dependency row whose five dependencies are all
 *  DRAWN below it, so every consumer that resolves an id has something real to
 *  resolve and the cap has somewhere to leak to:
 *    • `roadmapLateDeps` sees five inversions (CR-CRU-078/AC15 — each
 *      dependency is authored AFTER the row declaring it), and the order
 *      warning it renders names all five in FULL;
 *    • `CR-B-102` is declared LAST, so it is one of the ids the cap does not
 *      state — and it is the board's one running row, so it is also the row a
 *      click drills through to (`roadmapSelectOn`/`roadmapDrillIn`, off the
 *      full id). It carries `planId: 41`, the plan the harness serves.
 *    • `CR-B-033` is also unstated, and is PENDING — an inert row, so clicking
 *      it SELECTS without navigating and both zones can be read afterwards.
 *
 *  Five PENDING rows is exactly what §S5's trim draws and the running row is
 *  drawn whatever the trim (§S5/AC11), so nothing here is hidden. */
const CAP_CONSUMER_QUEUE: QueueFixture[] = [
  pending("CR-B-060", 10, [...declared(4), "CR-B-102"]),
  ...declared(4).map((cr, at) => pending(cr, 20 + at * 10, [])),
  {
    cr: "CR-B-102",
    title: "CR-B-102 — the dependency the cap does not state, and still drills",
    wave: "5",
    dependsOn: [],
    status: "IN_PROGRESS",
    planId: 41,
    seq: 60,
    release: RELEASE,
    track: "1",
  },
];

// ── Harness (tests/roadmap-release-focus.test.ts, verbatim) ────────────────

const TRACK_W = 800;
const PITCH = 100;

function rect(left: number, width: number): DOMRect {
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
  // happy-dom hands out no layout; this IS the box model under test's control.
  return box as unknown as DOMRect;
}

/** happy-dom runs no layout engine, so the release strip would measure a zero
 *  track and render a zero-gate window — and zones 2/3 read their focus from
 *  the strip's own sequence. Supplied exactly as the sibling roadmap suites
 *  supply it: wide enough that every gate fits one window. */
function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip-track") return rect(0, TRACK_W);
    if (testid === "roadmap-strip-ruler") return rect(0, PITCH);
    return rect(0, 0);
  };
}

let cacheBust = 0;

async function mountApp(queue: QueueFixture[]): Promise<void> {
  const key = "bare-deps-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals` must not be swallowed by `/releases`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return okResponse({
        ok: true,
        proposals: [{ label: RELEASE, targetAt: TARGET_AT, timestamp: 1787000000, waves: ["5"] }],
        totalCount: 1,
      });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: queue });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({
        ok: true,
        plans: [
          {
            planId: 41,
            cr: "CR-B-102",
            projectKey: key,
            status: "open",
            cycles: [{ id: 1, label: "C1 RED", status: "active" }],
          },
        ],
      });
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
    throw new Error(`roadmap-bare-dependency-annotation.test.ts: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern, shared with
  // tests/roadmap-release-focus.test.ts).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?bareDeps=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production `public/app.js`
 *  shell driving its own fetch chain and van.js's real reactive scheduler
 *  inside happy-dom. Faking the clock would freeze the very render pass under
 *  test (and the strip's own measure tick) — the sibling roadmap suites tick
 *  the real clock for the same reason. */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

const nodeFor = (cr: string): HTMLElement => {
  const node = all('[data-testid="roadmap-node"]').find((n) => n.getAttribute("data-cr") === cr);
  if (node === undefined) throw new Error(`no flowchart node rendered for ${cr}`);
  return node;
};

/** Zone 2's ANNOTATION SLOT, as text. */
const annotationOf = (cr: string): string =>
  norm(nodeFor(cr).querySelector('[data-testid="roadmap-node-annotation"]')?.textContent);

const rowFor = (cr: string): HTMLElement => {
  const row = all('[data-testid="roadmap-row"]').find((r) => r.getAttribute("data-cr") === cr);
  if (row === undefined) throw new Error(`no table row rendered for ${cr}`);
  return row;
};

/** Zone 3's DEPENDS-ON cell, chip by chip. */
const chipsOf = (cr: string): string[] =>
  Array.from(rowFor(cr).querySelectorAll<HTMLElement>('[data-testid="roadmap-depends-chip"]')).map(
    (chip) => norm(chip.textContent),
  );

const tabIsOn = (name: string): boolean =>
  all('[data-testid="workspace-tab"]').some(
    (tab) => norm(tab.textContent) === name && tab.classList.contains("on"),
  );

/** The rows carrying CR-CRU-096 AC12's `next` marker, by id. */
const markedCrs = (): string[] =>
  all('[data-testid="roadmap-node"]')
    .filter((node) => node.querySelector(".app-flow-node-next") !== null)
    .map((node) => node.getAttribute("data-cr") ?? "");

// ── AC1 — the RULE, driven with planted inputs ─────────────────────────────
//
// Driven pure as well as through the DOM because the boundary cases are the
// whole content of the rule and a render can only show one of them at a time.

describe("CR-CRU-102 §S1/AC1 — the abbreviation is computed from the two ids in hand, never from a known prefix", () => {
  test("the common leading text is trimmed back to the last NON-DIGIT, and the remainder renders only when it is all digits", () => {
    const cases: [string, string, string][] = [
      // The shape the design draws: the shared text ends mid-number, so the
      // trim gives the number back whole.
      ["CR-B-096", "CR-B-078", "078"],
      ["CR-B-075", "CR-B-014", "014"],
      ["CR-B-075", "CR-B-091", "091"],
      // A dependency sharing MORE than the prefix — `CR-B-09` is common here —
      // still renders the whole number, because the trim walks back over every
      // digit it reached and not merely the one that differed.
      ["CR-B-075", "CR-B-092", "092"],
      ["CR-B-075", "CR-B-095", "095"],
      // The FALLBACK, both shapes §S1 names.
      ["CR-W2-A", "CR-W1-A", "CR-W1-A"],
      ["CR-H-A01", "CR-H-M02", "CR-H-M02"],
      // A remainder that is numeric but for one letter — `A01` — is not
      // numeric, so nothing is stripped. This is the case AC7 is about.
      ["CR-H-B01", "CR-H-A01", "CR-H-A01"],
      // NOTHING in common: the remainder is the whole id, and it renders
      // whole unless it happens to be all digits already (below).
      ["CR-B-096", "TICKET-4198", "TICKET-4198"],
      // An id that is ALREADY bare abbreviates to itself — no information is
      // lost by the rule reporting a remainder that equals its input.
      ["CR-B-096", "078", "078"],
      // The row's own id is never consulted for its SHAPE, only compared: two
      // ids from a namespace that looks nothing like this project's abbreviate
      // exactly the same way, which is what makes the rule derived.
      ["TICKET-4211", "TICKET-4198", "4198"],
      ["PROJ/12", "PROJ/7", "7"],
      ["build-2026-09-04", "build-2026-09-01", "01"],
      // A shared run of digits with NO non-digit before it: the trim reaches
      // the start of the string, so the remainder is the whole dependency and
      // the full id renders.
      ["12ab", "12cd", "12cd"],
    ];
    const wrong = cases
      .map(([cr, dependency, want]) => ({
        cr,
        dependency,
        want,
        got: Logic.bareDependencyId(cr, dependency),
      }))
      .filter((row) => row.got !== row.want);
    expect(wrong).toEqual([]);
  });

  test("an unusable pair states nothing rather than inventing an abbreviation", () => {
    // A dependency that is not a published id names nothing, so there is
    // nothing to render — the `crStatusMark` rule ("an unrecognised value
    // supports no claim") applied to this slot.
    for (const dependency of ["", undefined, null, 7, {}, []]) {
      expect(Logic.bareDependencyId("CR-B-096", dependency)).toBe("");
    }
    // An unusable ROW id is different: the dependency is still a published id
    // and must still be named, so it is named in FULL. Nothing is compared,
    // and nothing is guessed.
    for (const cr of ["", undefined, null, 7, {}]) {
      expect(Logic.bareDependencyId(cr, "CR-B-078")).toBe("CR-B-078");
    }
  });
});

// ── AC1 — ZONE 2, on the rendered DOM ─────────────────────────────────────

describe("CR-CRU-102 §S1/AC1 — zone 2's annotation renders the bare form", () => {
  test("a one-dependency row reads `deps 078` and the four-dependency row reads `deps 014, 091 +2` (capped by CR-CRU-109 §S1)", async () => {
    await mountApp(BARE_QUEUE);

    // NON-VACUITY: all three rows really are drawn, so an assertion below
    // cannot pass because its row is missing.
    expect(all('[data-testid="roadmap-node"]').map((n) => n.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-075",
      "CR-B-096",
    ]);

    // AC1's two strings, byte-exact on the rendered slot.
    //
    // CR-CRU-109 §S1 supersedes the four-dependency EXAMPLE (user-confirmed
    // 2026-09-07): the row states the first two declared ids and then how many
    // it did not state, because the unbounded list put the live wave box at
    // 333.0px against the design's ~300px budget. What THIS test is about is
    // unchanged and is still asserted below — the ids it states are the BARE
    // form (`014`, never `CR-B-014`), which is CR-CRU-102's rule and is not
    // what this CR touches. §S1's measurement table records this exact string
    // for this exact row at 292.5px, so it is pinned byte-exact.
    expect(annotationOf("CR-B-096")).toBe("deps 078");
    expect(annotationOf("CR-B-075")).toBe("deps 014, 091 +2");

    // …and it is the CAP that wrote that string, not a coincidence of this
    // board: composed from the row's own four declared ids through the
    // published constant (AC8).
    expect(annotationOf("CR-B-075")).toBe(cappedDeps(["014", "091", "092", "095"]));

    // The full id is GONE from the slot — the abbreviation is not a prefix
    // added beside what was already there.
    expect(annotationOf("CR-B-075")).not.toContain("CR-B-");
    expect(annotationOf("CR-B-096")).not.toContain("CR-B-");

    // AC12/AC12b still hold beside it: the ONE marker went to the leading
    // actionable row, and it is the only row whose slot says anything else.
    expect(annotationOf("CR-B-000")).toBe("next");
  });
});

// ── AC2 — ZONE 3, on the rendered DOM ─────────────────────────────────────

describe("CR-CRU-102 §S1/AC2 — zone 3's depends-on cell abbreviates under the same rule", () => {
  test("the chips read the bare form, one chip per declared dependency", async () => {
    await mountApp(BARE_QUEUE);

    expect(all('[data-testid="roadmap-row"]').map((r) => r.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-075",
      "CR-B-096",
    ]);

    // Chip by chip, so the cell's own concatenation cannot hide a missing one.
    expect(chipsOf("CR-B-075")).toEqual(["014", "091", "092", "095"]);
    expect(chipsOf("CR-B-096")).toEqual(["078"]);
    expect(chipsOf("CR-B-000")).toEqual([]);

    // ONE RULE, TWO CALLERS — the two zones are the same entry drawn twice and
    // must not disagree about how they write it. Asserted as the composition
    // of the cell against the slot rather than as two independent literals,
    // which is the fact a duplicated implementation would break.
    //
    // CR-CRU-109 §S1 puts the CAP between them and nothing else: zone 3 states
    // the WHOLE set (AC7, the four chips above) and zone 2 states that same
    // cell capped, so the composition is still the fact that fails when the
    // two zones abbreviate an id differently.
    expect(cappedDeps(chipsOf("CR-B-075"))).toBe(annotationOf("CR-B-075"));
    expect(cappedDeps(chipsOf("CR-B-096"))).toBe(annotationOf("CR-B-096"));
  });
});

// ── AC7 — the FALLBACK, in both zones ─────────────────────────────────────

describe("CR-CRU-102 AC7 — a pair whose remainder is not numeric renders the FULL published id", () => {
  test("both zones fall back, and the fallback is the rule working rather than a regression", async () => {
    await mountApp(FALLBACK_QUEUE);

    // `1-A` is not entirely digits, so `CR-W1-A` renders whole.
    expect(annotationOf("CR-W2-A")).toBe("next · deps CR-W1-A");
    expect(chipsOf("CR-W2-A")).toEqual(["CR-W1-A"]);

    // `M02` is not entirely digits either, even though it ends in two.
    expect(annotationOf("CR-H-A01")).toBe("deps CR-H-M02");
    expect(chipsOf("CR-H-A01")).toEqual(["CR-H-M02"]);

    // Stated as the pure rule too, so a future reader who finds these full
    // ids on a board can see WHY they are full without mounting anything.
    expect(Logic.bareDependencyId("CR-W2-A", "CR-W1-A")).toBe("CR-W1-A");
    expect(Logic.bareDependencyId("CR-H-A01", "CR-H-M02")).toBe("CR-H-M02");
  });
});

// ── AC3 — the non-rendering consumers, PROVEN BY EXERCISE ─────────────────
//
// Exercised on the ABBREVIATING board, which is the only place a regression
// could hide: on a fallback board a consumer reading the rendered text would
// pass by coincidence.

describe("CR-CRU-102 AC3 — every non-rendering consumer still reads the FULL id while the cell shows the bare one", () => {
  test("the order warning names the offending pair in full, beside a chip that does not", async () => {
    await mountApp(CONSUMER_QUEUE);

    // The chip is abbreviated — without this the assertion below would hold
    // trivially on a board where nothing abbreviates at all.
    expect(chipsOf("CR-B-101")).toEqual(["102"]);

    // AC15's warning is the consumer that NAMES ids, and it names them whole.
    const warning = rowFor("CR-B-101").querySelector<HTMLElement>(
      '[data-testid="roadmap-order-warning"]',
    );
    expect(warning).not.toBeNull();
    expect(warning!.getAttribute("title")).toBe("authored before its dependency CR-B-102");
  });

  test("selection targets the full id from either zone, so node and row still highlight together", async () => {
    await mountApp(CONSUMER_QUEUE);

    // The targeting handle both zones publish is the FULL id, whatever the
    // deps cell shows.
    expect(rowFor("CR-B-101").getAttribute("data-cr")).toBe("CR-B-101");
    expect(nodeFor("CR-B-101").getAttribute("data-cr")).toBe("CR-B-101");
    expect(chipsOf("CR-B-101")).toEqual(["102"]);

    // Clicking the ROW resolves the NODE — one selection, two renderings
    // (CR-CRU-078/AC17). A selection keyed on rendered text would miss.
    expect(nodeFor("CR-B-101").getAttribute("data-selected")).toBe("false");
    rowFor("CR-B-101").click();
    await settle(2);
    expect(rowFor("CR-B-101").getAttribute("data-selected")).toBe("true");
    expect(nodeFor("CR-B-101").getAttribute("data-selected")).toBe("true");
    expect(nodeFor("CR-B-102").getAttribute("data-selected")).toBe("false");
  });

  test("drill-through still advertises and still lands, on the same board", async () => {
    await mountApp(CONSUMER_QUEUE);

    const runner = rowFor("CR-B-102");
    expect(runner.getAttribute("data-drill-source")).toBe("true");
    expect(tabIsOn("Workflow")).toBe(false);
    runner.click();
    await settle(2);
    expect(tabIsOn("Workflow")).toBe(true);
  });
});

// ── AC6 — THE PRODUCT KNOWS NO ID PREFIX ──────────────────────────────────
//
// A guard over the SHIPPED SOURCE TEXT, because the behavioural tests above
// cannot tell a derived rule from a hardcoded `"CR-CRU-"` that happens to
// agree with it on this file's fixtures.
//
// WHAT IS SCANNED, and why that is the whole of AC6's source half: the
// authored files under `public/` — the tree that ships to every project's
// browser and the only tree the rule lives in. A prefix literal anywhere in
// it is product knowledge of one project's id shape, whether or not the
// abbreviation reads it, which is why the scan is not narrowed to one
// function.
//
// THE PATTERN IS NAMESPACE-AGNOSTIC, exactly as CR-CRU-097 §S6 argued: the
// defect class is "some real project's prefix", not "ours" — `rust-crucible.py`
// once taught `CR-NAI-203`, a different project's namespace, so a criterion
// naming our own literal would have shipped green over it.
//
// COMMENTS ARE EXEMPT and that exemption is load-bearing: `public/app.js`
// carries 197 OCCURRENCES of the shape — occurrences, not lines: matching
// `NAMESPACE_PREFIX` over the raw text counts 197, the same match over
// `jsUncommented(text)` counts 0 — in provenance narration that CR-CRU-097
// AC8 requires be kept. The discrimination is NOT hand-rolled here — it is
// `jsUncommented`, added to tests/helpers/source-scan.ts by this CR as the
// third projection of the walk that file already performs. The
// accepted-field guard's `jsLiveCode` is the WRONG half for this question: it
// blanks string prose, which is precisely where a hardcoded prefix would live.
//
// AC6's TEST half is discharged by the pure table above rather than by a
// second scan: a test's synthetic fixtures legitimately spell invented
// prefixes (`CR-B-`, `CR-W1-`), so a text scan over `tests/` would report the
// remedy AC8 prescribes. What no hardcoded prefix and no lookup table can
// satisfy is the rule abbreviating `TICKET-4211`/`TICKET-4198`, `PROJ/12`/
// `PROJ/7` and `build-2026-09-04`/`build-2026-09-01` — three namespaces that
// share no shape with each other or with this project — and that is asserted
// there.

/** A CR id's NAMESPACE PREFIX, namespace-agnostic: `CR-` plus a project
 *  segment of two or more capitals plus its separator. The digits are
 *  deliberately NOT required — a full id is what CR-CRU-097's tripwire already
 *  forbids in shipped strings; the PREFIX alone is what would make the
 *  abbreviation project-dependent, and it slips past a pattern that demands a
 *  number after it. */
const NAMESPACE_PREFIX = /CR-[A-Z]{2,}-/g;

/** The authored `public/` files. `public/vendor/` is excluded BY NAME: those
 *  are third-party VanJS bundles, not authored here, and nothing in this repo
 *  may edit them — including them would measure someone else's tree. */
function shippedSources(): { relPath: string; text: string }[] {
  return listFiles("public", [".js", ".mjs"])
    .map((abs) => ({ relPath: abs.slice(REPO_ROOT.length + 1), text: readFileSync(abs, "utf8") }))
    .filter((file) => !file.relPath.startsWith(join("public", "vendor")));
}

describe("CR-CRU-102 AC6 — no shipped source spells a project's id prefix outside a comment", () => {
  test("the scan is non-vacuous: the files exist, and their comments DO carry the shape", () => {
    const files = shippedSources();
    expect(files.map((f) => f.relPath).sort()).toEqual([
      join("public", "app-logic.mjs"),
      join("public", "app.js"),
    ]);
    // The guard is discriminating rather than trivially satisfied: the RAW
    // text of both files matches many times over, and every one of those is
    // provenance the scan must NOT report.
    for (const file of files) {
      expect((file.text.match(NAMESPACE_PREFIX) ?? []).length).toBeGreaterThan(0);
    }
  });

  test("no prefix literal survives the comment strip", () => {
    const leaks: { relPath: string; line: number; text: string }[] = [];
    for (const { relPath, text } of shippedSources()) {
      const lines = text.split("\n");
      for (const hit of jsUncommented(text).matchAll(NAMESPACE_PREFIX)) {
        // `jsUncommented` is offset-identical to its input, so the index is an
        // index into the ORIGINAL file and this line number is the line a
        // reader will open.
        const line = text.slice(0, hit.index).split("\n").length;
        leaks.push({ relPath, line, text: norm(lines[line - 1]) });
      }
    }
    expect(leaks).toEqual([]);
  });

  test("the guard FIRES on a planted prefix, in a string and in an identifier alike", () => {
    // Planted rather than measured against a real file: neither shape exists
    // in `public/` today, and planting them is the only way to assert that the
    // strip is what decides. `CR-ZQ` belongs to no project and appears nowhere
    // else in this repo.
    const planted = [
      '// CR-ZQ-001 — provenance, which must NOT be reported\n',
      'const bare = (dep) => dep.replace("CR-ZQ-", "");\n',
      'const shape = /^CR-ZQ-\\d+$/;\n',
      'const message = `dropped CR-ZQ- from ${dep}`;\n',
    ].join("");
    const found = (jsUncommented(planted).match(/CR-[A-Z]{2}-/g) ?? []).length;
    // Three live occurrences: the string argument, the regex literal and the
    // template literal's prose. The comment is the fourth and is exempt.
    expect(found).toBe(3);
  });
});

// ══ CR-CRU-109 §S1 — THE ROW STATES AT MOST TWO IDS, THEN A COUNT ══════════
//
// Spec: docs/changes/CR-CRU-109-a-wave-row-annotation-fits-its-box.md
//       §S1 (the cap, its measurement table, and the two supersessions),
//       AC1, AC2, AC3, AC4, AC6, AC7, AC8
//
// WHY HERE: this file already owns the annotation's RENDERED FORM — which
// zone writes it, and how each id is written. HOW MANY of them the row states
// is the same claim about the same span, decidable in the same harness and
// against fixtures that already establish the bare form, so a second file
// would have to re-establish both zones before it could say anything.
//
// WHAT THE CAP IS NOT: a change to `bareDependencyId`. Every string below is
// still the bare form and the pure table above is untouched — §S1 bounds the
// COUNT, and CR-CRU-102's rule writes each id that count admits.
//
// WHY THE CAP EXISTS, because a bound with no reason invites removal: the
// unbounded list put the LIVE wave box at 333.0px against the design's ~300px
// budget (CR-CRU-096's own live-board probe), and no per-id abbreviation is
// left to make — `014` is already as short as `CR-CRU-014` gets. §S1 measured
// the alternatives on the running board: three ids still overflow at 321.0px,
// two fit at 292.5px.
//
// RED phase — expected to FAIL against current production, which pushes
// `deps ${deps.map(bare).join(", ")}` with no bound at all, so the
// four-dependency row reads `deps 014, 091, 092, 095` and
// `public/app-logic.mjs` exports no `DEPENDENCY_ANNOTATION_CAP` for a test to
// read.

/** The remainder token a slot states, as a NUMBER, or `null` when it states
 *  none. Read off the rendered text so an ellipsis, a `and 1 more`, or a
 *  silent truncation all answer `null` rather than passing for a count. */
const remainderOf = (annotation: string): number | null => {
  const hit = / \+(\d+)$/.exec(annotation);
  return hit === null ? null : Number(hit[1]);
};

// ── AC1 — ABOVE THE CAP: the capped prefix, then the count of the rest ────

describe("CR-CRU-109 §S1/AC1 — a row declaring MORE than the cap states the capped prefix and the count of the rest", () => {
  test("three, five and seven declared each state the cap's worth of ids in authored order and then how many are left", async () => {
    await mountApp(CAP_QUEUE);

    // NON-VACUITY: the rows really are drawn, and they really declare the
    // counts this test turns on — an assertion below cannot pass because its
    // row is missing or because the board declares something else.
    expect(all('[data-testid="roadmap-node"]').map((n) => n.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-030",
      "CR-B-050",
      "CR-B-070",
    ]);
    expect(CAP_QUEUE.map((entry) => entry.dependsOn.length)).toEqual([0, 3, 5, 7]);

    // Composed from each row's OWN declared list through the published cap,
    // so what is asserted is the RULE and not three copied strings.
    expect(annotationOf("CR-B-030")).toBe(cappedDeps(declaredBare(3)));
    expect(annotationOf("CR-B-050")).toBe(cappedDeps(declaredBare(5)));
    expect(annotationOf("CR-B-070")).toBe(cappedDeps(declaredBare(7)));

    // THE FIRST ones, in AUTHORED order, and the withheld ids named nowhere:
    // both are already pinned by the three whole-string expectations above,
    // each composed from its own row's declaration. On THIS board they cannot
    // discriminate an authored slice from a sorted one — its ids ascend — so
    // the ordering claim is stated on its own board, in the test below.

    // AC1's second half — ONE span, the same testid, and VISIBLE TEXT: the
    // cap does not move what it removed into a `title` or a hover
    // (CR-CRU-102 AC14, which the cap gives something new to hide behind).
    const slots = nodeFor("CR-B-070").querySelectorAll<HTMLElement>(
      '[data-testid="roadmap-node-annotation"]',
    );
    expect(slots.length).toBe(1);
    expect(slots[0]!.getAttribute("title")).toBeNull();
    expect(slots[0]!.getAttribute("aria-describedby")).toBeNull();
    expect(nodeFor("CR-B-070").querySelectorAll("[title]").length).toBe(0);
  });

  test("the ids stated are the AUTHORED first ones, read on a board that does not declare them sorted", async () => {
    await mountApp(SHUFFLED_QUEUE);
    const authored = ["077", "011", "044"];

    // NON-VACUITY: the row is drawn, it declares what this test turns on, and
    // the board really DISCRIMINATES — a renderer that sorted the ids before
    // slicing would state a DIFFERENT string, which is the only reason the
    // pin below says anything the whole-string pins above did not.
    expect(all('[data-testid="roadmap-node"]').map((n) => n.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-060",
    ]);
    expect(SHUFFLED_QUEUE[1]!.dependsOn).toEqual(["CR-B-077", "CR-B-011", "CR-B-044"]);
    expect(
      cappedDeps([...authored].sort()),
      "the ordering board declares its ids in sorted order after all, so a renderer that " +
        "sorted them would pass this test unchanged",
    ).not.toBe(cappedDeps(authored));

    expect(annotationOf("CR-B-060")).toBe(cappedDeps(authored));
  });
});

// ── AC2 — AT OR BELOW THE CAP: unchanged, and never `+0` ─────────────────

describe("CR-CRU-109 §S1/AC2 — a row declaring no more than the cap is UNCHANGED, and never states `+0`", () => {
  test("one and two declared dependencies render with no remainder token at all", async () => {
    await mountApp(UNCAPPED_QUEUE);

    expect(all('[data-testid="roadmap-node"]').map((n) => n.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-010",
      "CR-B-020",
    ]);

    // Byte-exact, because "unchanged" is a claim about the exact string
    // CR-CRU-102 already renders for these two rows.
    expect(annotationOf("CR-B-010")).toBe("deps 011");
    expect(annotationOf("CR-B-020")).toBe("deps 011, 022");

    // `+0` is the defect AC2 forbids — a row telling a reader that nothing is
    // hidden, at the cost of saying it — and the two byte-exact strings above
    // are what forbids it: neither carries a remainder token, an ellipsis or
    // any other tail, because each IS the whole rendered slot.

    // The row AT the cap states EVERY id it declares: the cap bounds, it does
    // not truncate to fewer than it admits.
    expect(annotationOf("CR-B-020")).toBe(cappedDeps(declaredBare(2)));
    expect(annotationOf("CR-B-000")).toBe("next");
  });
});

// ── AC3 — the remainder is a COUNT, never an ellipsis ─────────────────────

describe("CR-CRU-109 §S1/AC3 — the remainder states HOW MANY, so five declared and seven declared read differently", () => {
  test("a five-dependency row states `+3` and a seven-dependency row `+5`, and neither elides", async () => {
    await mountApp(CAP_QUEUE);
    const cap = capOf();
    const five = annotationOf("CR-B-050");
    const seven = annotationOf("CR-B-070");

    // The COUNT of what was not stated, derived from each row's own
    // declaration — the number a reader needs to know the size of what the
    // table below holds.
    expect(remainderOf(five), `the five-dependency row reads ${JSON.stringify(five)}`).toBe(
      5 - cap,
    );
    expect(remainderOf(seven), `the seven-dependency row reads ${JSON.stringify(seven)}`).toBe(
      7 - cap,
    );

    // DISTINGUISHABLE from the row alone, which is the whole reason the
    // remainder is a number: an ellipsis renders these two identically, and a
    // reader could not tell four dependencies from seven without opening the
    // table.
    expect(five).not.toBe(seven);
    for (const text of [five, seven]) {
      expect(text).not.toContain("…");
      expect(text).not.toContain("...");
      expect(text.toLowerCase()).not.toMatch(/\bmore\b/);
    }
  });
});

// ── AC4 — the `next` marker composes with the capped list ─────────────────

describe("CR-CRU-109 §S1/AC4 — the marker composes unchanged with the capped list", () => {
  test("the marked four-dependency row reads `next · deps 014, 091 +2` — marker first, one separator", async () => {
    await mountApp(MARKED_QUEUE);

    // NON-VACUITY: the marker really is on the FOUR-dependency row. That is
    // the arrangement §S1 measured at 332.4px and the one this file's other
    // boards deliberately avoid, where the marker sits on a dep-free row.
    expect(markedCrs()).toEqual(["CR-B-075"]);
    expect(MARKED_QUEUE[0]!.dependsOn.length).toBe(4);

    // §S1's measurement table records THIS string for THIS row at 292.5px
    // against the ~300px budget, so it is pinned byte-exact…
    expect(annotationOf("CR-B-075")).toBe("next · deps 014, 091 +2");
    // …and composed, so the string is the cap's output and not a literal that
    // happens to agree with it today.
    expect(annotationOf("CR-B-075")).toBe(
      `next · ${cappedDeps(["014", "091", "092", "095"])}`,
    );

    // ONE separator between the two parts, and the marker FIRST.
    expect(annotationOf("CR-B-075").split(" · ").length).toBe(2);
    expect(annotationOf("CR-B-075").indexOf("next")).toBeLessThan(
      annotationOf("CR-B-075").indexOf("deps"),
    );

    // The marker keeps its own element (CR-CRU-096 AC12's emphasis by WEIGHT):
    // the cap did not flatten the slot into one undifferentiated string.
    expect(nodeFor("CR-B-075").querySelectorAll(".app-flow-node-next").length).toBe(1);

    // The unmarked row on the same board keeps its own unchanged form, so the
    // marker is what the composition adds and not the board.
    expect(annotationOf("CR-B-096")).toBe("deps 078");
  });
});

// ── AC6 — the cap is a DISPLAY rule, and stops at the display ─────────────
//
// The failure this guards is the one that would do REAL damage: a cap applied
// to `entry.dependsOn` instead of to the text drawn from it. The row would
// still LOOK right while the drill-through lost a target and the inversion
// check stopped seeing two of the five dependencies it validates.

describe("CR-CRU-109 AC6 — the cap is DISPLAY only: every consumer still resolves the ids the row does not state", () => {
  test("a five-dependency row states two, while the order warning names all five in FULL and an unstated id still selects and still drills", async () => {
    await mountApp(CAP_CONSUMER_QUEUE);
    const cap = capOf();
    const ids = CAP_CONSUMER_QUEUE[0]!.dependsOn;
    expect(ids).toEqual(["CR-B-011", "CR-B-022", "CR-B-033", "CR-B-044", "CR-B-102"]);

    // NON-VACUITY: the cap really is ON for this row, and the ids the
    // assertions below chase really are among the ones it withheld. Without
    // this the test would pass on an uncapped board, where nothing is
    // withheld and no consumer could disagree with the slot.
    expect(annotationOf("CR-B-060")).toBe(
      `next · ${cappedDeps(["011", "022", "033", "044", "102"])}`,
    );
    const withheld = ids.slice(cap);
    expect(withheld).toContain("CR-B-033");
    expect(withheld).toContain("CR-B-102");

    // `roadmapLateDeps` — the inversion check reads `entry.dependsOn`, and the
    // warning it renders NAMES every offending dependency, in full and in
    // authored order. A cap that reached the data would shorten this title to
    // two ids and silently stop reporting three real inversions.
    const warning = rowFor("CR-B-060").querySelector<HTMLElement>(
      '[data-testid="roadmap-order-warning"]',
    );
    expect(warning).not.toBeNull();
    expect(warning!.getAttribute("title")).toBe(
      `authored before its dependency ${ids.join(", ")}`,
    );

    // SELECTION targets the full id of a dependency the slot does not state:
    // `CR-B-033` is PENDING, so the click selects without navigating and both
    // zones can be read after it (CR-CRU-078/AC17 — one selection, two
    // renderings).
    expect(nodeFor("CR-B-033").getAttribute("data-selected")).toBe("false");
    rowFor("CR-B-033").click();
    await settle(2);
    expect(rowFor("CR-B-033").getAttribute("data-selected")).toBe("true");
    expect(nodeFor("CR-B-033").getAttribute("data-selected")).toBe("true");
    expect(nodeFor("CR-B-060").getAttribute("data-selected")).toBe("false");

    // DRILL-THROUGH still lands, on the id the slot withheld LAST: `CR-B-102`
    // is running, so it advertises a target and a click routes to it.
    const runner = rowFor("CR-B-102");
    expect(runner.getAttribute("data-drill-source")).toBe("true");
    expect(tabIsOn("Workflow")).toBe(false);
    runner.click();
    await settle(2);
    expect(tabIsOn("Workflow")).toBe(true);
  });
});

// ── AC7 — zone 3 still states the WHOLE set, in the SAME render ───────────

describe("CR-CRU-109 AC7 — zone 3's deps column is unchanged, so a capped row has a place to be read in full", () => {
  test("one render, both zones: the slot states two and a count, the column states all five", async () => {
    await mountApp(CAP_CONSUMER_QUEUE);
    const ids = CAP_CONSUMER_QUEUE[0]!.dependsOn;

    // ZONE 2 — capped.
    const slot = annotationOf("CR-B-060");
    expect(slot).toBe(`next · ${cappedDeps(["011", "022", "033", "044", "102"])}`);

    // ZONE 3 — WHOLE, chip by chip and in authored order, so the cell's own
    // concatenation cannot hide a missing one. This is the surface the cap
    // sends a reader to, so "unchanged" is load-bearing rather than incidental.
    expect(chipsOf("CR-B-060")).toEqual(["011", "022", "033", "044", "102"]);
    expect(chipsOf("CR-B-060").length).toBe(ids.length);

    // ONE RULE, TWO CALLERS, one CAP between them — asserted as a composition
    // of the cell against the slot in the SAME render, which is what fails if
    // the two zones ever drift apart.
    expect(`next · ${cappedDeps(chipsOf("CR-B-060"))}`).toBe(slot);
  });
});

// ── AC8 — ONE definition of the number ────────────────────────────────────
//
// The cap moved once (three → two) before a line of it was written, on §S1's
// measurement of the live board: three ids leave the box at 321.0px against a
// ~300px budget and two bring it to 292.5px. A literal at the call site would
// have to be found and changed again next time the design is re-measured,
// which is what the SOURCE half below forbids.

describe("CR-CRU-109 AC8 — the cap is a NAMED CONSTANT with a single definition, and the render reads it", () => {
  test("`DEPENDENCY_ANNOTATION_CAP` is TWO by §S1's measurement, and it is what a seven-dependency row states", async () => {
    // The ONE place in this repo that spells the number.
    expect(
      capOf(),
      "§S1's table measured the alternatives on the live board: three ids leave the wave box " +
        "at 321.0px against the design's ~300px, two bring it to 292.5px",
    ).toBe(2);

    await mountApp(CAP_QUEUE);
    // The RENDER follows the constant: the ids stated are counted off the
    // rendered slot and compared with what the product publishes, so a call
    // site holding its own literal disagrees the moment the constant moves.
    const stated = annotationOf("CR-B-070")
      .replace(/^deps /, "")
      .replace(/ \+\d+$/, "")
      .split(", ");
    expect(stated).toEqual(declaredBare(7).slice(0, capOf()));
    expect(stated.length).toBe(capOf());
  });

  test("the constant is DEFINED once in the shipped tree, and zone 2's call site bounds the list by NAME", () => {
    // `shippedSources`/`jsUncommented` are CR-CRU-102 AC6's own projection of
    // the authored `public/` tree: definitions are counted in LIVE code, so a
    // second copy narrated in a comment is not mistaken for one.
    const definitions = shippedSources().flatMap(({ relPath, text }) =>
      Array.from(jsUncommented(text).matchAll(/\bDEPENDENCY_ANNOTATION_CAP\s*=/g)).map(
        () => relPath,
      ),
    );
    expect(definitions).toEqual([join("public", "app-logic.mjs")]);

    // …and `RoadmapFlowNode` bounds the list by that NAME rather than by a
    // literal of its own, which is the defect AC8 exists to forbid. The NAME
    // has to BE the bound: a call site that kept `slice(0, 2)` and mentioned
    // the constant anywhere else — a log line, a comment's neighbour, a
    // re-export — would satisfy a bare mention, so this reads the SHAPE.
    expect(
      jsUncommented(APP_JS_SRC),
      "public/app.js bounds zone 2's dependency list with something other than " +
        "`slice(0, L.DEPENDENCY_ANNOTATION_CAP)`, so the constant is not what the call site " +
        "cuts the list at",
    ).toMatch(/\.slice\(\s*0\s*,\s*L\.DEPENDENCY_ANNOTATION_CAP\s*\)/);
  });
});
