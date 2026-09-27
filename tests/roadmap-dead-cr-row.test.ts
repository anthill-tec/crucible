// CR-CRU-147 §S2 (cycle 526, C4) — a dead CR's roadmap TABLE ROW shows it dead:
// the grid is kept, the STATUS cell names the state, the reason moves into a
// tooltip on the status badge.
//
// Spec: docs/changes/CR-CRU-147-a-voided-cr-is-not-queued-work.md
//       §S2 ("The row keeps the table's grid" / "The STATUS cell names the
//       state" / "The reason is a tooltip") and its four §S2 ACs.
// Storyboard: .lavish/crucible-v2-design.html, F17 (APPROVED 2026-09-24) —
//       the row has the SAME six cells as a live row (id, title, points,
//       depends-on, status[, track/wave when the region carries them]); the
//       id, title and points are struck through and dimmed; the depends-on
//       chips fade; the STATUS cell reads `VOID` or `SUPERSEDED → <successor>`
//       and nothing is added to the row.
//
// SCOPE — the RENDERED DOM only (structural contract: which elements exist,
// which classes and attributes they carry, what text the STATUS cell states).
// Real computed style (actual `text-decoration: line-through`) and geometry
// (no column overflow, no horizontal scrollbar) need a layout engine happy-dom
// does not have — tests/roadmap-visual-grammar.test.ts already establishes
// the pattern of splitting that half into real Chromium, and this CR's own
// geometry AC is asserted there / in the e2e suite instead. Tooltip
// reachability by hover (desktop) and tap (phone) is likewise e2e-only: a
// static DOM has no pointer.
//
// CONTRACT THIS FILE PINS (not yet built — every assertion below is RED
// against current production):
//   • the row's id/title cells (`[data-column="cr"]`/`[data-column="title"]`)
//     and its points span (`[data-testid="roadmap-points"]`) each carry a
//     `dead` class when the entry carries a `lifecycle`, and never otherwise;
//   • each depends-on chip (`[data-testid="roadmap-depends-chip"]`) carries a
//     `faded` class under the same condition;
//   • the row's separate `[data-testid="roadmap-lifecycle-badge"]` (the OLD
//     surface that used to carry the reason inline) is GONE — the reason
//     never renders as row text again;
//   • the existing `[data-testid="roadmap-status-badge"]` gains a
//     `data-lifecycle` attribute and reads `VOID` / `SUPERSEDED → <successor>`
//     (never `PENDING`) when the entry is dead, with `PENDING`'s own
//     `.pending` class token removed;
//   • the badge is linked, via `aria-describedby`, to a
//     `[data-testid="roadmap-status-tooltip"][role="tooltip"]` element that
//     states the lifecycle state and the full, untruncated reason.
//
// ESCALATION (documented, not guessed): §S2's own scope text asks the tooltip
// to read "state · date · who, then the full reason". `QueueLifecycle`
// (`src/types.ts`) carries `state`, `by` (the SUPERSEDED successor only),
// `reason` and `at` — there is no author/"who voided this" field on the wire
// at all, for either state. F17's mock names a person ("vidushi") in that
// slot, but nothing in this CR's own scope (§S1/§S2/§S3) adds an authoring
// field to `QueueLifecycle`, and the gap-analysis box does not address it.
// This file does NOT invent a source for "who" — it pins what the schema
// actually carries (state, the reason verbatim, and — for SUPERSEDED — the
// successor `by`) and leaves the "who" segment's exact source/format for the
// GREEN implementer to resolve against the CR author, flagged here rather
// than asserted on a guess.
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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

/** Same single-match technique as tests/coverage-trend-geometry.test.ts's
 * `ruleBody()` (itself following tests/f13-fidelity.test.ts) \u2014 the FIRST rule
 * in styles.css whose selector is the exact literal text given, returning its
 * declaration body, or `undefined` if no such rule exists. Used below (ruling
 * 7) to assert the `[hidden]`-attribute hiding rule is GONE, not merely that
 * some rule happens not to match. */
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES_SRC);
  return match?.[1];
}

// ── Fixture types (the wire shapes, `tests/roadmap-wave-drops-dead-crs.test.ts`
//    verbatim) ────────────────────────────────────────────────────────────

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
  /** Ruling 6 (2026-09-25, C4) — `cr-void`/`cr-supersede` now store the
   *  registered caller as `author` on the lifecycle, the same value the
   *  declaration journal already records (`src/store.ts` `setQueueLifecycle`
   *  / `appendDeclaration`); absent on a lifecycle written before the ruling. */
  author?: string;
}

interface QueueFixture {
  cr: string;
  title: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  points?: number;
  seq: number;
  release: string;
  lifecycle?: LifecycleFixture;
}

// ── AC29 (CR-CRU-096 convention) — every id below is synthetic (`CR-DR-*`):
//    this file's assertions do not depend on the shape of this project's own
//    backlog ─────────────────────────────────────────────────────────────

const RELEASE = "0.9.0";
const TARGET_AT = 1790500000;
const WAVE = "9";

/** 2026-09-24T00:00:00Z, epoch MILLISECONDS — `QueueLifecycle.at`'s own unit
 *  (`QueueLifecycle` in `src/types.ts`). Not asserted byte-exact below
 *  (see the file-header
 *  ESCALATION on date FORMAT), only that the tooltip carries the state and
 *  the reason. */
const RETIRED_AT = Date.UTC(2026, 8, 24);

const VOID_REASON =
  "Voided at gap analysis 2026-09-24 (user ruling): the surface it targeted " +
  "was retired and the repo went public, so the CI run it guarded is free now.";
const SUPERSEDED_REASON = "Rolled into the broader rewrite CR-DR-SUCC delivers instead.";
/** Ruling 6 (C4) — the registered caller a `cr-void`/`cr-supersede` write
 *  carries on the lifecycle as `author` (never a display-name guess). */
const AUTHORED_AUTHOR = "orchestrator-9";

/** The one board every test in this file reuses: one LIVE row (AC4's own
 *  regression guard), one VOID row and one SUPERSEDED row, all in the SAME
 *  wave so `roadmapTableColumns` (`public/app-logic.mjs`) computes the
 *  SAME column set for all three — the base four (`cr, title, deps, status`),
 *  with neither `wave` nor `track` (a single wave, no track declared), so the
 *  "same cells, same columns" claim is provable without a column-set filter
 *  getting in the way. */
const QUEUE: QueueFixture[] = [
  {
    cr: "CR-DR-LIVE",
    title: "CR-DR-LIVE — a scheduled row, unaffected",
    wave: WAVE,
    dependsOn: [],
    status: "PENDING",
    points: 5,
    seq: 10,
    release: RELEASE,
  },
  {
    cr: "CR-DR-VOID",
    title: "CR-DR-VOID — abandoned outright",
    wave: WAVE,
    dependsOn: ["CR-DR-LIVE"],
    status: "PENDING",
    points: 3,
    seq: 20,
    release: RELEASE,
    lifecycle: { state: "VOID", reason: VOID_REASON, at: RETIRED_AT },
  },
  {
    cr: "CR-DR-SUP",
    title: "CR-DR-SUP — the work moved elsewhere",
    wave: WAVE,
    dependsOn: [],
    status: "PENDING",
    points: 8,
    seq: 30,
    release: RELEASE,
    lifecycle: { state: "SUPERSEDED", by: "CR-DR-SUCC", reason: SUPERSEDED_REASON, at: RETIRED_AT },
  },
  {
    cr: "CR-DR-VOID-AUTHORED",
    title: "CR-DR-VOID-AUTHORED — voided with an author on the lifecycle",
    wave: WAVE,
    dependsOn: [],
    status: "PENDING",
    points: 2,
    seq: 40,
    release: RELEASE,
    lifecycle: { state: "VOID", reason: VOID_REASON, at: RETIRED_AT, author: AUTHORED_AUTHOR },
  },
];

// A snapshot of the fixture's OWN `status` values, taken before mounting —
// AC2/Risk's own guard: "the queue's `status` field stays derived… the change
// is to the cell, not the data." Mutating the fixture in place would make
// this comparison vacuous, so the check re-reads `QUEUE` itself after mount.
const STATUS_BEFORE_MOUNT = new Map(QUEUE.map((e) => [e.cr, e.status]));

// ── Harness (`tests/roadmap-bare-dependency-annotation.test.ts` pattern) ───

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
  return box as unknown as DOMRect;
}

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

async function mountApp(): Promise<void> {
  const key = "dead-cr-row-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return okResponse({
        ok: true,
        proposals: [{ label: RELEASE, targetAt: TARGET_AT, timestamp: 1_787_000_000, waves: [WAVE] }],
        totalCount: 1,
      });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: QUEUE });
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
    throw new Error(`roadmap-dead-cr-row.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?deadCrRow=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

const rowFor = (cr: string): HTMLElement => {
  const row = all('[data-testid="roadmap-row"]').find((r) => r.getAttribute("data-cr") === cr);
  if (row === undefined) throw new Error(`no table row rendered for ${cr}`);
  return row;
};

const columnsOf = (row: HTMLElement): string[] =>
  Array.from(row.querySelectorAll<HTMLElement>("[data-column]")).map(
    (el) => el.getAttribute("data-column") ?? "",
  );

const statusBadgeOf = (cr: string): HTMLElement => {
  const badge = rowFor(cr).querySelector<HTMLElement>('[data-testid="roadmap-status-badge"]');
  if (badge === null) throw new Error(`${cr}'s row renders no [data-testid="roadmap-status-badge"]`);
  return badge;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC1 (+AC4) — the row keeps the table's grid; a dead row marks itself dead
// and never leaks its reason into the row; a live row is untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-147 §S2 AC1/AC4 (cycle 526, C4) — the dead row's grid, and the live row beside it", () => {
  test("a VOID and a SUPERSEDED row render the SAME columns as the live row, mark their id/title/points dead and their deps faded, and never render the reason as row text", async () => {
    await mountApp();

    const live = rowFor("CR-DR-LIVE");
    const void_ = rowFor("CR-DR-VOID");
    const sup = rowFor("CR-DR-SUP");

    // "The row has the same cells, in the same columns, as a live row."
    const liveColumns = columnsOf(live);
    expect(liveColumns, "the fixture's own base column set").toEqual([
      "cr",
      "title",
      "deps",
      "status",
    ]);
    expect(columnsOf(void_), "the VOID row must carry the same columns as the live row").toEqual(
      liveColumns,
    );
    expect(columnsOf(sup), "the SUPERSEDED row must carry the same columns as the live row").toEqual(
      liveColumns,
    );

    // "Nothing is added to the row" — the OLD separate lifecycle badge, whose
    // text used to carry the whole reason inline, is retired by §S2.
    for (const row of [void_, sup]) {
      expect(
        row.querySelector('[data-testid="roadmap-lifecycle-badge"]'),
        `${row.getAttribute("data-cr")} still renders the old [data-testid="roadmap-lifecycle-badge"]`,
      ).toBeNull();
    }

    // The reason never renders as row text — it belongs in the tooltip only
    // (AC3, asserted structurally below).
    expect(norm(void_.textContent)).not.toContain(VOID_REASON);
    expect(norm(sup.textContent)).not.toContain(SUPERSEDED_REASON);

    // "The id, title and points are struck through" and "the depends-on
    // chips fade" — the `dead`/`faded` class contract this file's header
    // documents.
    for (const [row, label] of [
      [void_, "VOID"],
      [sup, "SUPERSEDED"],
    ] as const) {
      const cr = row.querySelector<HTMLElement>('[data-column="cr"]');
      const title = row.querySelector<HTMLElement>('[data-column="title"]');
      const points = row.querySelector<HTMLElement>('[data-testid="roadmap-points"]');
      expect(cr, `${label} row renders no id cell`).not.toBeNull();
      expect(title, `${label} row renders no title cell`).not.toBeNull();
      expect(points, `${label} row renders no points span`).not.toBeNull();
      expect(cr!.classList.contains("dead"), `${label} row's id cell carries no "dead" class`).toBe(
        true,
      );
      expect(
        title!.classList.contains("dead"),
        `${label} row's title cell carries no "dead" class`,
      ).toBe(true);
      expect(
        points!.classList.contains("dead"),
        `${label} row's points span carries no "dead" class`,
      ).toBe(true);
    }
    const voidChip = void_.querySelector<HTMLElement>('[data-testid="roadmap-depends-chip"]');
    expect(voidChip, "CR-DR-VOID declares one dependency and must render its chip").not.toBeNull();
    expect(voidChip!.classList.contains("faded"), "the VOID row's depends-on chip is not faded").toBe(
      true,
    );

    // AC4 — the LIVE row is untouched: same cells, no strikethrough marker,
    // no default lifecycle attribute.
    expect(live.hasAttribute("data-lifecycle"), "the live row must carry no data-lifecycle").toBe(
      false,
    );
    const liveCr = live.querySelector<HTMLElement>('[data-column="cr"]');
    const liveTitle = live.querySelector<HTMLElement>('[data-column="title"]');
    const livePoints = live.querySelector<HTMLElement>('[data-testid="roadmap-points"]');
    expect(liveCr!.classList.contains("dead"), "the live row's id cell must not be marked dead").toBe(
      false,
    );
    expect(
      liveTitle!.classList.contains("dead"),
      "the live row's title cell must not be marked dead",
    ).toBe(false);
    expect(
      livePoints!.classList.contains("dead"),
      "the live row's points span must not be marked dead",
    ).toBe(false);
    expect(
      live.querySelector('[data-testid="roadmap-status-tooltip"]'),
      "the live row must render no status tooltip",
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — the STATUS cell names the lifecycle state, never PENDING; the
// entry's own `status` field stays derived (display only)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-147 §S2 AC2 (cycle 526, C4) — the STATUS cell, and the untouched data beneath it", () => {
  test("VOID reads `VOID`, SUPERSEDED reads `SUPERSEDED → <successor>`, and the row is never marked PENDING while dead", async () => {
    await mountApp();

    const voidBadge = statusBadgeOf("CR-DR-VOID");
    const supBadge = statusBadgeOf("CR-DR-SUP");
    const liveBadge = statusBadgeOf("CR-DR-LIVE");

    expect(norm(voidBadge.textContent), "the VOID row's STATUS cell").toBe("VOID");
    expect(
      norm(supBadge.textContent),
      "the SUPERSEDED row's STATUS cell (078 AC27: names its successor)",
    ).toBe("SUPERSEDED → CR-DR-SUCC");

    // "never PENDING" — the badge's own `pending` class token, which
    // `entry.status.toLowerCase()` gives every PENDING row today, must not
    // survive on a dead one; the badge instead names the lifecycle.
    expect(voidBadge.classList.contains("pending"), "VOID row's badge still reads pending").toBe(
      false,
    );
    expect(supBadge.classList.contains("pending"), "SUPERSEDED row's badge still reads pending").toBe(
      false,
    );
    expect(voidBadge.getAttribute("data-lifecycle")).toBe("VOID");
    expect(supBadge.getAttribute("data-lifecycle")).toBe("SUPERSEDED");

    // The live row's own badge is unaffected.
    expect(norm(liveBadge.textContent)).toBe("PENDING");
    expect(liveBadge.hasAttribute("data-lifecycle")).toBe(false);

    // "The queue read's `status` for the same CR is still the derived value:
    // the change is to the cell, not the data." — the fixture object itself
    // (what the mocked `GET …/queue` served) must be unmutated by the render.
    expect(STATUS_BEFORE_MOUNT.get("CR-DR-VOID")).toBe("PENDING");
    expect(STATUS_BEFORE_MOUNT.get("CR-DR-SUP")).toBe("PENDING");
    expect(QUEUE.find((e) => e.cr === "CR-DR-VOID")!.status, "the stored status must stay derived").toBe(
      "PENDING",
    );
    expect(QUEUE.find((e) => e.cr === "CR-DR-SUP")!.status, "the stored status must stay derived").toBe(
      "PENDING",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 (unit half) — the reason lives in a tooltip on the status badge,
// reachable via aria-describedby; e2e half (hover/tap reachability) lives in
// tests/e2e/features/roadmap.feature and mobile-viewport-responsive.feature
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-147 §S2 AC3 (cycle 526, C4) — the reason is the status badge's tooltip", () => {
  test("the VOID and SUPERSEDED badges are described by a role=tooltip element carrying the state and the full, untruncated reason", async () => {
    await mountApp();

    for (const [cr, state, reason] of [
      ["CR-DR-VOID", "VOID", VOID_REASON],
      ["CR-DR-SUP", "SUPERSEDED", SUPERSEDED_REASON],
    ] as const) {
      const badge = statusBadgeOf(cr);
      const describedBy = badge.getAttribute("aria-describedby");
      expect(
        describedBy,
        `${cr}'s status badge carries no aria-describedby — the reason is not linked to it`,
      ).not.toBeNull();
      expect(describedBy, `${cr}'s aria-describedby is empty`).not.toBe("");

      const tooltip = document.getElementById(describedBy!);
      expect(tooltip, `${cr}: aria-describedby="${describedBy}" points at no element`).not.toBeNull();
      expect(
        tooltip!.getAttribute("data-testid"),
        `${cr}'s tooltip carries the wrong data-testid`,
      ).toBe("roadmap-status-tooltip");
      expect(tooltip!.getAttribute("role"), `${cr}'s tooltip carries no role="tooltip"`).toBe(
        "tooltip",
      );

      const text = norm(tooltip!.textContent);
      expect(text.startsWith(state), `${cr}'s tooltip does not open with its own state "${state}"`).toBe(
        true,
      );
      expect(
        text.includes(reason),
        `${cr}'s tooltip does not carry the full reason verbatim (got: "${text}")`,
      ).toBe(true);

      // The reason must not be a TRUNCATED prefix — "the full reason,
      // wrapped" (§S2), never clipped.
      expect(text.length).toBeGreaterThanOrEqual(reason.length);
    }

    // The successor is named on the badge itself (AC2/078 AC27); the tooltip
    // is not required to repeat it, but must not OMIT the lifecycle state it
    // opens with — already asserted above via `startsWith`.
    const liveBadge = statusBadgeOf("CR-DR-LIVE");
    expect(
      liveBadge.hasAttribute("aria-describedby"),
      "the live row's badge must carry no aria-describedby — it has no lifecycle reason to point at",
    ).toBe(false);
  });
});

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Ruling 6 (2026-09-25, at C4) \u2014 the lifecycle carries who: `cr-void` and
// `cr-supersede` store the registered caller as `author` on the lifecycle
// (the same value `src/store.ts`'s declaration journal already records), and
// the tooltip names it, in order state \u00b7 date \u00b7 who \u00b7 reason. A lifecycle
// with no `author` (written before this change) renders its tooltip without
// one \u2014 never a placeholder such as "unknown" or "\u2014" standing in for it.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

describe("CR-CRU-147 §S2 ruling 6 (cycle 526, C4) — the lifecycle's author, named in the tooltip", () => {
  test("a lifecycle carrying `author` renders a tooltip naming it, positioned after the state and before the reason", async () => {
    await mountApp();

    // Fixture sanity — this row's lifecycle really does carry an author, so
    // a passing assertion below is a real behavioural claim, not an accident
    // of an undefined field stringifying to something matching.
    expect(
      QUEUE.find((e) => e.cr === "CR-DR-VOID-AUTHORED")!.lifecycle!.author,
      "fixture sanity: CR-DR-VOID-AUTHORED must carry an author",
    ).toBe(AUTHORED_AUTHOR);

    const badge = statusBadgeOf("CR-DR-VOID-AUTHORED");
    const describedBy = badge.getAttribute("aria-describedby");
    expect(
      describedBy,
      "CR-DR-VOID-AUTHORED's status badge carries no aria-describedby — the reason (and who) is not linked to it",
    ).not.toBeNull();

    const tooltip = document.getElementById(describedBy!);
    expect(
      tooltip,
      `CR-DR-VOID-AUTHORED: aria-describedby="${describedBy}" points at no element`,
    ).not.toBeNull();

    const text = norm(tooltip!.textContent);
    expect(
      text.includes(AUTHORED_AUTHOR),
      `the tooltip does not name the lifecycle's author "${AUTHORED_AUTHOR}" (got: "${text}")`,
    ).toBe(true);

    // "state · date · who · reason" — who renders strictly between the state
    // and the full reason. The date's own FORMAT stays unasserted, as the
    // file-header ESCALATION already establishes for AC3; only WHO's order
    // relative to state and reason is pinned here.
    const stateIdx = text.indexOf("VOID");
    const authorIdx = text.indexOf(AUTHORED_AUTHOR);
    const reasonIdx = text.indexOf(VOID_REASON);
    expect(stateIdx, "the tooltip's own state segment is missing").toBeGreaterThanOrEqual(0);
    expect(reasonIdx, "the tooltip's full reason is missing").toBeGreaterThanOrEqual(0);
    expect(
      stateIdx < authorIdx,
      `the author "${AUTHORED_AUTHOR}" must render AFTER the state (got tooltip: "${text}")`,
    ).toBe(true);
    expect(
      authorIdx < reasonIdx,
      `the author "${AUTHORED_AUTHOR}" must render BEFORE the reason (got tooltip: "${text}")`,
    ).toBe(true);
  });

  test("a lifecycle with no `author` renders a tooltip with state, date and reason but no who segment, and no placeholder stands in for it", async () => {
    await mountApp();

    // CR-DR-VOID's fixture lifecycle carries no `author` at all — exactly
    // "a lifecycle with no author (written before this change)" the ruling
    // names.
    expect(
      QUEUE.find((e) => e.cr === "CR-DR-VOID")!.lifecycle!.author,
      "fixture sanity: CR-DR-VOID must carry no author",
    ).toBeUndefined();

    const badge = statusBadgeOf("CR-DR-VOID");
    const describedBy = badge.getAttribute("aria-describedby");
    expect(describedBy, "CR-DR-VOID's status badge carries no aria-describedby").not.toBeNull();
    const tooltip = document.getElementById(describedBy!);
    expect(tooltip, `CR-DR-VOID: aria-describedby="${describedBy}" points at no element`).not.toBeNull();

    const text = norm(tooltip!.textContent);
    // The state and the reason still render — the ruling only says the WHO
    // segment is dropped, not the rest of the tooltip's contract.
    expect(text.startsWith("VOID"), `the tooltip must still open with its own state (got: "${text}")`).toBe(
      true,
    );
    expect(
      text.includes(VOID_REASON),
      "the tooltip must still carry the full reason verbatim",
    ).toBe(true);

    // No placeholder stands in for the missing author — the exact two the
    // ruling names.
    expect(
      /unknown/i.test(text),
      `the tooltip must not use "unknown" as a stand-in for a missing author (got: "${text}")`,
    ).toBe(false);
    expect(
      text.includes("—"),
      `the tooltip must not use an em-dash placeholder for a missing author (got: "${text}")`,
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ruling 7 (2026-09-25, at VERIFY) — the tooltip is reachable by keyboard.
// The badge already takes focus (`tabindex="0"`) and carries
// `aria-describedby`; VERIFY found focus did not open the tooltip and the
// closed bubble used the native `hidden` attribute, which drops it from the
// accessibility tree — so `aria-describedby` announces nothing while closed.
// Two contracts, pinned separately below:
//   1. focusing the badge opens the tooltip; moving focus away closes it
//      again (an observable state change either way — proven WITHOUT
//      assuming which CSS technique renders "closed");
//   2. whatever "closed" looks like, it is never the `hidden` attribute and
//      never `display:none`/`visibility:hidden` on the tooltip itself — a
//      visually-hidden-but-accessible pattern instead (asserted on the
//      PROPERTY, not on a specific class name, per the CR's own note that
//      happy-dom applies no stylesheet cascade: the DOM attribute and the
//      styles.css source are the two things this file CAN check).
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-147 §S2 ruling 7 (VERIFY) — the tooltip is reachable by keyboard", () => {
  test("focusing a dead row's status badge opens its tooltip; moving focus away closes it again", async () => {
    await mountApp();

    const badge = statusBadgeOf("CR-DR-VOID");
    const describedBy = badge.getAttribute("aria-describedby");
    expect(describedBy, "CR-DR-VOID's status badge carries no aria-describedby").not.toBeNull();
    const tooltip = document.getElementById(describedBy!);
    expect(tooltip, `CR-DR-VOID: aria-describedby="${describedBy}" points at no element`).not.toBeNull();
    const tip = tooltip!;

    // A snapshot of every observable signal the tooltip could use to render
    // "open" vs. "closed" (inline style + the hidden attribute) — deliberately
    // NOT pinned to one specific property, since ruling 7 leaves the exact
    // visually-hidden technique to the implementer. What must be true is that
    // focus and blur each produce SOME observable change, in opposite
    // directions, on this element.
    const snapshot = (): string =>
      `${tip.getAttribute("style") ?? ""}|class=${tip.className}|hidden=${tip.hasAttribute("hidden")}`;

    const closedBeforeFocus = snapshot();

    badge.focus();
    await settle();
    expect(
      document.activeElement,
      "harness sanity: badge.focus() did not move DOM focus onto the badge itself",
    ).toBe(badge);

    const openedAfterFocus = snapshot();
    expect(
      openedAfterFocus,
      `focusing the badge produced no observable change on its tooltip (still "${openedAfterFocus}") — focusing the badge does not open the tooltip`,
    ).not.toBe(closedBeforeFocus);

    badge.blur();
    await settle();
    expect(
      document.activeElement,
      "harness sanity: badge.blur() did not move focus away from the badge",
    ).not.toBe(badge);

    const closedAfterBlur = snapshot();
    expect(
      closedAfterBlur,
      `blurring the badge left its tooltip in the OPEN state ("${closedAfterBlur}") — moving focus away must close it`,
    ).not.toBe(openedAfterFocus);
  });

  test("while closed, a dead row's status tooltip carries no hidden attribute and is not hidden via display:none/visibility:hidden, and still states the reason", async () => {
    await mountApp();

    const badge = statusBadgeOf("CR-DR-VOID");
    const describedBy = badge.getAttribute("aria-describedby");
    const tooltip = document.getElementById(describedBy!);
    expect(tooltip, `CR-DR-VOID: aria-describedby="${describedBy}" points at no element`).not.toBeNull();
    const tip = tooltip!;

    // Closed (no interaction has happened yet since mount) — the tooltip must
    // still be IN the accessibility tree: no `hidden` attribute at all.
    expect(
      tip.hasAttribute("hidden"),
      'the closed tooltip carries a `hidden` attribute — ruling 7 forbids hiding it that way, since `hidden` drops it from the accessibility tree and "aria-describedby announces the reason" while closed would then announce nothing',
    ).toBe(false);

    // Nor may it be hidden via an inline style forcing the same outcome by a
    // different name.
    expect(tip.style.display, "the closed tooltip's inline style sets display:none").not.toBe("none");
    expect(
      tip.style.visibility,
      "the closed tooltip's inline style sets visibility:hidden",
    ).not.toBe("hidden");

    // happy-dom applies no stylesheet cascade (established by
    // tests/coverage-trend-geometry.test.ts and this file's siblings), so the
    // CSS half of the same requirement is checked against the styles.css
    // SOURCE directly: the rule that hides the tooltip via the `[hidden]`
    // attribute selector must be gone — that selector is exactly the
    // mechanism ruling 7 retires.
    expect(
      ruleBody(".app-roadmap-status-tip[hidden]"),
      'public/styles.css still declares a `.app-roadmap-status-tip[hidden] { display: none; }` rule — ruling 7 requires the closed state to stay in the accessibility tree, which the native `hidden` attribute (and any rule keyed on it) cannot do',
    ).toBeUndefined();

    // The reason is still readable in the markup while closed — a
    // visually-hidden bubble still carries its text, it just is not painted.
    expect(norm(tip.textContent)).toContain(VOID_REASON);
  });
});
