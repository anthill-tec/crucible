// CR-CRU-091 C4 — the UI half of roadmap registration: ONE date formatter for
// both git-sourced dates (§S1 / AC3) and CONSUMPTION of the published `seq`
// instead of a re-derivation from the response index (AC18).
//
// Scope note: this file asserts the two `public/app-logic.mjs` contracts §S9
// assigns to the server's half. The roadmap SURFACE — graph rendering, the
// table, lifecycle rendering, paging — is CR-CRU-078 and is NOT touched here.
//
// ── §S1 / AC3, verbatim ────────────────────────────────────────────────────
// "One formatter for both dates. `formatReleaseDate(epochSeconds)` is exported
// from `public/app-logic.mjs` beside `relativeTime` and takes epoch SECONDS.
// No call site constructs a date from `releasedAt` or `targetAt` itself — two
// conventions on one surface renders 1970."
//
// The trap is measured, not hypothetical: the 0.1.0 ledger row carries
// `releasedAt = 1787149125`, which is 2026-08-19 read as SECONDS and
// 1970-01-21 read as MILLISECONDS. Both fields use seconds
// (`src/types.ts:218-223`, `src/store.ts:2154`, `public/app-logic.mjs:874`).
//
// ── AC18, verbatim ─────────────────────────────────────────────────────────
// "The published `seq` is consumed, not re-derived, by its only in-tree
// consumer. `buildRoadmapGraph` emits `data.seq` equal to the entry's
// published `seq`. Fixture: entries whose stored `seq` values are `10, 20, 30`
// yield `data.seq` `10, 20, 30` — the surviving `seq: index` derivation yields
// `0, 1, 2`."
// `QueueEntry.seq` is published on EVERY entry, read verbatim from the column
// (`src/types.ts:397-404`), so a payload without one is a DEFECT, not a shape
// to paper over. Contract this file pins for that case: the position is
// OMITTED entirely — the same "no carried position" state a container node
// occupies. An index fallback would reintroduce exactly the two-meanings
// ambiguity AC18 removes.
//
// ── THE CONSUMER MOVED, and AC18 moved with it ─────────────────────────────
// AC18 names `buildRoadmapGraph` because that was `seq`'s only in-tree
// consumer when CR-CRU-091 shipped. CR-CRU-078 C3 replaced that composition
// wholesale (its 160 `dependsOn` edges are what AC20 forbids), so the builder
// no longer exists and the quote above is history rather than a live citation.
// The CONTRACT is unchanged and is asserted here against what replaced it:
// `focusedReleaseView` hands the renderer each member with its own stored
// `seq`, and the renderer publishes it as `data-seq`, omitted when unusable.
// The rendered half is proven on the real DOM in
// tests/roadmap-release-focus.test.ts; what is proven HERE is the pure
// boundary and the executable scan that no defaulting survives in the render.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_LOGIC_SRC = readFileSync(path.join(REPO_ROOT, "public/app-logic.mjs"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");

// The ambient tests/app-logic.d.ts predates both exports, so the module is
// cast to the boundary under test ONCE.
interface QueueEntryLike {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
  track?: string;
  seq?: number;
  release?: string;
}
interface StripGateLike {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}
const Logic = AppLogic as unknown as {
  formatReleaseDate: (epochSeconds: unknown) => string;
  focusedReleaseView: (
    gate: StripGateLike,
    releases: unknown[],
    entries: QueueEntryLike[],
  ) => { members: QueueEntryLike[] };
};

/** The in-flight release every AC18 fixture below is declared into. */
const PROPOSED: StripGateLike = {
  version: "0.2.0",
  kind: "proposed",
  date: "",
  dateState: "absent",
};

const membersOf = (entries: QueueEntryLike[]): QueueEntryLike[] =>
  Logic.focusedReleaseView(PROPOSED, [], entries).members;

const seqOf = (entries: QueueEntryLike[], cr: string): number | undefined =>
  membersOf(entries).find((entry) => entry.cr === cr)?.seq;

// ── AC3 ────────────────────────────────────────────────────────────────────

describe("CR-CRU-091 §S1/AC3 — ONE formatter, taking epoch SECONDS, for both git-sourced dates", () => {
  test("`formatReleaseDate` is exported from public/app-logic.mjs and reaches the nomodule shell", () => {
    expect(typeof Logic.formatReleaseDate).toBe("function");
    // The shell consumes logic through the window bridge only, so a formatter
    // absent from that list is a formatter no call site can route through.
    expect(/^\s+formatReleaseDate,$/m.test(APP_LOGIC_SRC)).toBe(true);
  });

  test("the measured 0.1.0 ledger date renders 2026-08-19 — the milliseconds reading (1970-01-21) FAILS", () => {
    const RELEASED_AT = 1787149125;
    expect(Logic.formatReleaseDate(RELEASED_AT)).toBe("2026-08-19");
    // The trap is live: reading the same number as milliseconds really does
    // land in 1970, so the assertion above is not satisfiable by both units.
    expect(new Date(RELEASED_AT).toISOString().slice(0, 10)).toBe("1970-01-21");
    expect(Logic.formatReleaseDate(RELEASED_AT)).not.toStartWith("1970");
  });

  test("`releasedAt` and `targetAt` render through the SAME function, and the unit really is seconds", () => {
    // Both fields are epoch SECONDS, so one formatter answers both: a shipped
    // release's date and a proposal's declared target are the same call.
    expect(Logic.formatReleaseDate(1787151205)).toBe("2026-08-19"); // 0.1.1 releasedAt
    expect(Logic.formatReleaseDate(1787233524)).toBe("2026-08-20"); // releasedAt, next day
    expect(Logic.formatReleaseDate(1790000000)).toBe("2026-09-21"); // a declared targetAt
    // Seconds scaling, pinned at the origin: one day is 86400, not 86400000.
    expect(Logic.formatReleaseDate(0)).toBe("1970-01-01");
    expect(Logic.formatReleaseDate(86400)).toBe("1970-01-02");
    expect(Logic.formatReleaseDate(86400000)).not.toBe("1970-01-02");
  });

  test("ISO `YYYY-MM-DD`, UTC — the format the surface already uses for a day, to the day", () => {
    // `coverageHeatSlices` already buckets a day as
    // `new Date(ts).toISOString().slice(0, 10)` (public/app-logic.mjs:463), and
    // the storyboard gate dates are ISO. A release date is a DAY: no clock
    // component, and no locale, which would render differently per viewer.
    const rendered = Logic.formatReleaseDate(1787149125);
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rendered).not.toContain("T");
    expect(rendered).not.toContain(":");
    // A time-of-day that crosses local midnight but not UTC midnight still
    // renders the UTC day — the ledger's day, not the reader's.
    expect(Logic.formatReleaseDate(1787149125 + 3600)).toBe("2026-08-19");
  });

  test("an ABSENT date renders nothing — never 1970-01-01, never `Invalid Date`", () => {
    // `targetAt` is optional (§S1: "`--target` is optional and revisable"), so
    // the formatter is called with nothing on every undated proposal. The empty
    // string is the only answer a caller can concatenate without lying about a
    // date; 0 is a real date and must NOT be conjured from absence.
    for (const absent of [undefined, null, Number.NaN, Infinity, -Infinity, "2026-08-19", {}]) {
      expect({ input: absent, rendered: Logic.formatReleaseDate(absent) }).toEqual({
        input: absent,
        rendered: "",
      });
    }
    // …and a real 0 is still a real date, so absence and the epoch differ.
    expect(Logic.formatReleaseDate(0)).toBe("1970-01-01");
  });

  test("NO other date construction is applied to `releasedAt` or `targetAt`, anywhere in public/", () => {
    // AC3's grep, executable: every construction the two-conventions bug needs
    // — a Date built from the field, a hand-rolled ×1000, an ISO/locale render
    // reached off it — matched against the field names themselves.
    const CONSTRUCTIONS = [
      /new\s+Date\s*\([^;\n]*\b(?:releasedAt|targetAt)\b/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\*\s*1000/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\.\s*to(?:ISOString|LocaleDateString|LocaleString)/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\bDate\s*\.\s*(?:parse|UTC)\b/,
    ];
    // Comment prose names both fields freely; only CODE is under test.
    const code = (src: string): string =>
      src
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join("\n");
    const offenders: string[] = [];
    for (const [name, src] of [
      ["public/app-logic.mjs", APP_LOGIC_SRC],
      ["public/app.js", APP_JS_SRC],
    ] as const) {
      const body = code(src);
      for (const pattern of CONSTRUCTIONS) {
        const hit = pattern.exec(body);
        if (hit !== null) offenders.push(`${name}: ${hit[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the scan really does catch the bug it is guarding against.
    const bad = "const shipped = new Date(rel.releasedAt).toISOString().slice(0, 10);";
    expect(CONSTRUCTIONS.some((p) => p.test(bad))).toBe(true);
    expect(CONSTRUCTIONS.some((p) => p.test("const at = rel.targetAt * 1000;"))).toBe(true);
  });
});

// ── AC18 ───────────────────────────────────────────────────────────────────

/** Three CRs whose STORED `seq` values are decidedly not their array indices,
 *  all declared into the in-flight release so they are its membership. */
const STORED_SEQ_ENTRIES: QueueEntryLike[] = [
  { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED", seq: 10, release: "0.2.0" },
  { cr: "CR-B", title: "Beta", wave: "5", dependsOn: ["CR-A"], status: "IN_PROGRESS", seq: 20, release: "0.2.0" },
  { cr: "CR-C", title: "Gamma", wave: "6", dependsOn: ["CR-B"], status: "PENDING", seq: 30, release: "0.2.0" },
];

describe("CR-CRU-091/AC18 — the published `seq` is CONSUMED, never re-derived from the response index", () => {
  test("stored `seq` 10, 20, 30 reaches the renderer as 10, 20, 30 — not the index's 0, 1, 2", () => {
    const members = membersOf(STORED_SEQ_ENTRIES);
    expect(members.map((entry) => entry.seq)).toEqual([10, 20, 30]);
    // Named explicitly: the derivation this AC retires, and the fixture that
    // makes the two answers distinguishable at all.
    expect(members.map((entry) => entry.seq)).not.toEqual([0, 1, 2]);
    expect(STORED_SEQ_ENTRIES.map((e) => e.seq)).not.toEqual([0, 1, 2]);
    // Nothing else about the membership moved: `seq` is the only field here.
    expect(members.map((entry) => entry.cr)).toEqual(["CR-A", "CR-B", "CR-C"]);
  });

  test("VERBATIM per entry: a payload whose order and `seq` disagree carries each entry's OWN stored value", () => {
    // `listQueue` is `ORDER BY seq`, so array order and `seq` order normally
    // agree — which is exactly why an index derivation survives every other
    // AC. Break the agreement and the two answers separate per entry.
    const shuffled: QueueEntryLike[] = [
      STORED_SEQ_ENTRIES[2]!,
      STORED_SEQ_ENTRIES[0]!,
      STORED_SEQ_ENTRIES[1]!,
    ];
    expect({
      "CR-A": seqOf(shuffled, "CR-A"),
      "CR-B": seqOf(shuffled, "CR-B"),
      "CR-C": seqOf(shuffled, "CR-C"),
    }).toEqual({ "CR-A": 10, "CR-B": 20, "CR-C": 30 });
    // Membership order still follows the PAYLOAD — CR-CRU-078 §S6 carries the
    // authored order and re-derives nothing, so consuming `seq` changed the
    // carried VALUE, never which entry comes first.
    expect(membersOf(shuffled).map((entry) => entry.cr)).toEqual(["CR-C", "CR-A", "CR-B"]);
  });

  test("a stored `seq` is carried whatever its shape — sparse, wide, zero-based, fractional", () => {
    const entries: QueueEntryLike[] = [
      { cr: "CR-P", wave: "1", dependsOn: [], status: "PENDING", seq: 0, release: "0.2.0" },
      { cr: "CR-Q", wave: "1", dependsOn: [], status: "PENDING", seq: 1.5, release: "0.2.0" },
      { cr: "CR-R", wave: "1", dependsOn: [], status: "PENDING", seq: 4096, release: "0.2.0" },
    ];
    expect(membersOf(entries).map((entry) => entry.seq)).toEqual([0, 1.5, 4096]);
  });

  test("a MISSING `seq` is OMITTED by the render, never defaulted — the ambiguity stays closed", () => {
    // AC18's absence half is a RENDER contract now (the entry itself simply
    // has no key), so it is pinned where the render can be seen: the two
    // places `public/app.js` publishes a position both guard on
    // `Number.isFinite`, and NO defaulting expression survives anywhere on the
    // surface. The rendered proof — `data-seq` absent on the node and on the
    // row — is in tests/roadmap-release-focus.test.ts.
    const code = APP_JS_SRC.split("\n")
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const guarded = code.match(/Number\.isFinite\(entry\.seq\)/g) ?? [];
    expect(guarded.length).toBe(2);
    const published = code.match(/"data-seq"/g) ?? [];
    expect(published.length).toBe(2);
    // The defaulting this AC exists to prevent, in every shape it took.
    const DEFAULTS = [
      /\bseq\b[^;\n]*\?\?\s*0\b/,
      /\bseq\s*:\s*index\b/,
      /\bseq\s*:\s*at\b/,
      /\bseq\b[^;\n]*\|\|\s*0\b/,
    ];
    expect(DEFAULTS.filter((pattern) => pattern.test(code))).toEqual([]);
    // Non-vacuity: the scan really does catch the derivation it guards against.
    expect(DEFAULTS.some((p) => p.test("const at = (a.data(\"seq\") ?? 0);"))).toBe(true);
    expect(DEFAULTS.some((p) => p.test("nodes.push({ seq: index });"))).toBe(true);
  });
});
