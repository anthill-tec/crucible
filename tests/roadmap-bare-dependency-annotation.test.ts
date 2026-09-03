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
// states (`deps 078`, `deps 014, 091, 092, 095`) are reproduced byte-for-byte
// without naming one real CR of the project running Crucible. The live board
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
  test("a one-dependency row reads `deps 078` and the four-dependency row reads `deps 014, 091, 092, 095`", async () => {
    await mountApp(BARE_QUEUE);

    // NON-VACUITY: all three rows really are drawn, so an assertion below
    // cannot pass because its row is missing.
    expect(all('[data-testid="roadmap-node"]').map((n) => n.getAttribute("data-cr"))).toEqual([
      "CR-B-000",
      "CR-B-075",
      "CR-B-096",
    ]);

    // AC1's two strings, byte-exact on the rendered slot.
    expect(annotationOf("CR-B-096")).toBe("deps 078");
    expect(annotationOf("CR-B-075")).toBe("deps 014, 091, 092, 095");

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
    expect(`deps ${chipsOf("CR-B-075").join(", ")}`).toBe(annotationOf("CR-B-075"));
    expect(`deps ${chipsOf("CR-B-096").join(", ")}`).toBe(annotationOf("CR-B-096"));
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
// carries 186 occurrences of the shape in provenance narration that CR-CRU-097
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
