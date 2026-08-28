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
//
// `QueueEntry.seq` is published on EVERY entry, read verbatim from the column
// (`src/types.ts:397-404`), so a payload without one is a DEFECT, not a shape
// to paper over. Contract this file pins for that case: the node OMITS `seq`
// entirely — the state `bySeq`/`missingSeq` in tests/roadmap-graph.test.ts
// already report as `<id>:no-seq`, and the state milestone and terminal nodes
// already occupy. An index fallback would reintroduce exactly the two-meanings
// ambiguity AC18 removes.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_LOGIC_SRC = readFileSync(path.join(REPO_ROOT, "public/app-logic.mjs"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");

// The ambient tests/app-logic.d.ts predates both exports, so cast the module to
// the boundary under test ONCE (GREEN adds the runtime export and its
// declaration). Until then `formatReleaseDate` is `undefined` and every call
// below throws "is not a function" — the intended missing-export RED signal.
interface QueueEntryLike {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
  track?: string;
  seq?: number;
}
interface GraphNodeLike {
  data: { id: string; type: string; seq?: number };
}
const Logic = AppLogic as unknown as {
  formatReleaseDate: (epochSeconds: unknown) => string;
  buildRoadmapGraph: (
    entries: QueueEntryLike[],
    releases: unknown[],
  ) => { nodes: GraphNodeLike[]; edges: unknown[] };
};

const crNodes = (g: { nodes: GraphNodeLike[] }): GraphNodeLike[] =>
  g.nodes.filter((n) => n.data.type === "cr");
const seqOf = (g: { nodes: GraphNodeLike[] }, id: string): number | undefined =>
  g.nodes.find((n) => n.data.id === id)!.data.seq;

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

/** Three CRs whose STORED `seq` values are decidedly not their array indices. */
const STORED_SEQ_ENTRIES: QueueEntryLike[] = [
  { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED", seq: 10 },
  { cr: "CR-B", title: "Beta", wave: "5", dependsOn: ["CR-A"], status: "IN_PROGRESS", seq: 20 },
  { cr: "CR-C", title: "Gamma", wave: "6", dependsOn: ["CR-B"], status: "PENDING", seq: 30 },
];

describe("CR-CRU-091/AC18 — the published `seq` is CONSUMED, never re-derived from the response index", () => {
  test("stored `seq` 10, 20, 30 yields `data.seq` 10, 20, 30 — not the index's 0, 1, 2", () => {
    const g = Logic.buildRoadmapGraph(STORED_SEQ_ENTRIES, []);
    expect(crNodes(g).map((n) => n.data.seq)).toEqual([10, 20, 30]);
    // Named explicitly: the derivation this AC retires, and the fixture that
    // makes the two answers distinguishable at all.
    expect(crNodes(g).map((n) => n.data.seq)).not.toEqual([0, 1, 2]);
    expect(STORED_SEQ_ENTRIES.map((e) => e.seq)).not.toEqual([0, 1, 2]);
    // Nothing else about the node moved: `seq` is the only field under test.
    expect(crNodes(g).map((n) => n.data.id)).toEqual(["CR-A", "CR-B", "CR-C"]);
  });

  test("VERBATIM per entry: a payload whose order and `seq` disagree carries each entry's OWN stored value", () => {
    // `listQueue` is `ORDER BY seq`, so array order and `seq` order normally
    // agree — which is exactly why an index derivation survives every other
    // AC. Break the agreement and the two answers separate per node.
    const shuffled: QueueEntryLike[] = [
      STORED_SEQ_ENTRIES[2],
      STORED_SEQ_ENTRIES[0],
      STORED_SEQ_ENTRIES[1],
    ];
    const g = Logic.buildRoadmapGraph(shuffled, []);
    expect({
      "CR-A": seqOf(g, "CR-A"),
      "CR-B": seqOf(g, "CR-B"),
      "CR-C": seqOf(g, "CR-C"),
    }).toEqual({ "CR-A": 10, "CR-B": 20, "CR-C": 30 });
    // Emission order still follows the payload — consuming `seq` changed the
    // carried VALUE, not which node the builder pushes first.
    expect(crNodes(g).map((n) => n.data.id)).toEqual(["CR-C", "CR-A", "CR-B"]);
  });

  test("a stored `seq` is carried whatever its shape — sparse, wide, zero-based, fractional", () => {
    const entries: QueueEntryLike[] = [
      { cr: "CR-P", wave: "1", dependsOn: [], status: "PENDING", seq: 0 },
      { cr: "CR-Q", wave: "1", dependsOn: [], status: "PENDING", seq: 1.5 },
      { cr: "CR-R", wave: "1", dependsOn: [], status: "PENDING", seq: 4096 },
    ];
    const g = Logic.buildRoadmapGraph(entries, []);
    expect(crNodes(g).map((n) => n.data.seq)).toEqual([0, 1.5, 4096]);
  });

  test("a MISSING `seq` is OMITTED, never defaulted to the index — the ambiguity stays closed", () => {
    const entries: QueueEntryLike[] = [
      { cr: "CR-A", wave: "5", dependsOn: [], status: "COMPLETED", seq: 10 },
      { cr: "CR-NO-SEQ", wave: "5", dependsOn: [], status: "PENDING" },
      { cr: "CR-C", wave: "6", dependsOn: [], status: "PENDING", seq: 30 },
    ];
    const g = Logic.buildRoadmapGraph(entries, []);
    const undated = g.nodes.find((n) => n.data.id === "CR-NO-SEQ")!;
    // The key is ABSENT, so the node reads as "no carried position" rather
    // than claiming position 1 (the index) or 0 (a falsy default).
    expect(Object.prototype.hasOwnProperty.call(undated.data, "seq")).toBe(false);
    expect(undated.data.seq).toBeUndefined();
    // The entry is still a node — a defective `seq` drops the position, never
    // the CR — and its declared neighbours keep their stored values.
    expect(crNodes(g).map((n) => n.data.id)).toEqual(["CR-A", "CR-NO-SEQ", "CR-C"]);
    expect([seqOf(g, "CR-A"), seqOf(g, "CR-C")]).toEqual([10, 30]);
    // A non-numeric `seq` is no `seq` either: it cannot rank anything.
    for (const junk of [null, "20", Number.NaN, Infinity]) {
      const junked = Logic.buildRoadmapGraph(
        [{ cr: "CR-J", wave: "1", dependsOn: [], status: "PENDING", seq: junk as number }],
        [],
      );
      expect({ junk, has: Object.prototype.hasOwnProperty.call(junked.nodes[0].data, "seq") }).toEqual(
        { junk, has: false },
      );
    }
  });

  test("`seq` stays a CR-node field: milestone and terminal nodes carry none", () => {
    const g = Logic.buildRoadmapGraph(STORED_SEQ_ENTRIES, [
      { version: "0.1.0", commit: "c07274c", releasedAt: 1787149125, crs: ["CR-A"], timestamp: 1 },
    ]);
    expect(
      g.nodes.filter((n) => n.data.type !== "cr" && n.data.seq !== undefined).map((n) => n.data.id),
    ).toEqual([]);
    // Non-vacuous: the release really did produce a non-CR node.
    expect(g.nodes.filter((n) => n.data.type !== "cr").length).toBeGreaterThan(0);
  });
});
