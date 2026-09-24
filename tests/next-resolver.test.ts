// CR-CRU-098 C1 RED — the `next` decision resolver, moved to the server.
//
// Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md §S1, AC1/AC3/AC4/AC5/AC6
// Classification: docs/changes/CR-CRU-098-test-classification.md
//
// THE API THIS RED PINS (GREEN builds to it — stated per the dispatch prompt's
// "pick the export name/path" instruction):
//
//     src/next.ts
//       export const HOLD_TRIGGER_KINDS: readonly string[]   // the 4 kinds, fixed order
//       export const DRAINED_REASONS: readonly string[]      // the 3 reasons
//       export function resolveNext(
//         entries: QueueEntry[], tracks: string[],
//         scope: { track?: string; release?: string; wave?: string },
//       ): { ok: boolean; code: number; fields: Record<string, unknown>;
//            warnings: Array<{ code: string; detail: string }> }
//
// A PURE function over `(entries, tracks, scope)` — AC1. No HTTP, no store: every
// fixture below is a plain `QueueEntry[]`, exactly the shape `Store.listQueue`
// publishes (src/types.ts:437-469), so the SAME fixture shape a route-level test
// would seed via `replaceQueue` is legible here without booting a server.
//
// PORTED FROM (per the classification table): CanonicalTrackTest, TrackScopingTest,
// NextDecisionTest, HoldDecisionTest, DrainedDecisionTest, LaneOrderTest
// (tests/client/test_cr092_next_decision_resolver.py) and
// PublishedOrderIsConsumedTest + SeqlessRowKeepsItsPublishedPositionTest
// (tests/client/test_cr095_next_consumes_published_order.py) — semantics preserved
// exactly (CR's own Non-goals), re-expressed as bun tests of the pure function.
//
// RED expectation: `src/next.ts` does not exist yet, so THIS ENTIRE FILE fails to
// collect (module-not-found on the top-level import) — every test below reports
// failed, which is the missing contract, not a broken harness (Mode 1, compile/
// import error from a not-yet-existing SUT symbol IS red).
//
// AC13 — every fixture below is synthetic: `CR-NEXTPTR-*` ids (registered in
// tests/project-namespace-tripwire.test.ts's SYNTHETIC_NAMESPACES in this same
// commit) or bare placeholder ids (`CR-A`, `CR-TARGET`, …) that name no real CR.

import { readFileSync } from "node:fs";
import { describe, test, expect } from "bun:test";
import type { QueueEntry, QueueLifecycle } from "../src/types.ts";
// RED — src/next.ts does not exist yet (GREEN creates it). This import failure
// is the intended collection-level RED for every test in this file (Mode 1:
// a not-yet-existing SUT symbol). See the file banner above.
import { resolveNext, HOLD_TRIGGER_KINDS, DRAINED_REASONS } from "../src/next.ts";

interface ResolveWarning {
  code: string;
  detail: string;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// ── fixtures — mirrors clients/_crucible_axi.py test fixtures' `_entry()` ──

function entry(cr: string, seq: number, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return { cr, wave: "5", dependsOn: [], status: "PENDING", seq, ...overrides };
}

function voidLc(reason = "not happening"): QueueLifecycle {
  return { state: "VOID", reason, at: 0 };
}

function supersededLc(by: string): QueueLifecycle {
  return { state: "SUPERSEDED", by, at: 0 };
}

/** The published `tracks` list `declaredTracks` would publish (src/store.ts:430) —
 *  sorted distinct non-blank trimmed values. Copied here (never imported) so this
 *  file's fixtures stay self-contained plain data, matching the pure function's
 *  own contract of taking `tracks` as an explicit argument (AC1). */
function publishedTracks(entries: QueueEntry[]): string[] {
  return Array.from(
    new Set(entries.map((e) => (e.track ?? "").trim()).filter((t) => t.length > 0)),
  ).sort();
}

function resolve(entries: QueueEntry[], scope: { track?: string; release?: string; wave?: string } = {}) {
  return resolveNext(entries, publishedTracks(entries), scope);
}

function fields(entries: QueueEntry[], scope: { track?: string; release?: string; wave?: string } = {}) {
  return resolve(entries, scope).fields;
}

// ── AC5 oracle — today's Python help[] builders, FROZEN before AC10 deleted them ───
//
// "Derive AC5's expected strings by running today's Python helpers on the same
// fixtures, not by retyping them" (dispatch prompt item 2). They WERE run live by
// subprocess against `clients/_crucible_axi.py:_next_start_help` / `_hold_help` /
// `_drained_help` until CR-CRU-098 C3 deleted those helpers (AC10). Per the C3
// ruling (option (c), widened) their answers are now read from ONE frozen record,
// tests/fixtures/cr098-next-oracle.json, which
// tests/fixtures/cr098-next-oracle.gen.py generates by running the PRE-DELETION
// client out of git (the JSON's `source.commit`) — still derived, never retyped.
// The same record freezes today's `resolve_next` answers; the AC5 group below
// holds `resolveNext` equal to every one of them.
interface OracleResolverCase {
  entries: QueueEntry[];
  tracks: string[];
  scope: { track?: string; release?: string; wave?: string };
  result: { ok: boolean; code: number; fields: Record<string, unknown>; warnings: ResolveWarning[] };
}

interface OracleHelpCase {
  request: Record<string, unknown>;
  help: string[];
}

interface NextOracle {
  source: { commit: string; path: string };
  resolver: OracleResolverCase[];
  help: OracleHelpCase[];
}

const ORACLE = JSON.parse(
  readFileSync(`${REPO_ROOT}tests/fixtures/cr098-next-oracle.json`, "utf8"),
) as NextOracle;

/** One spelling per value — keys sorted, `undefined` dropped exactly as the old
 *  subprocess's `JSON.stringify(req)` dropped it — so a lookup keys on CONTENT. */
function canonical(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, sortKeys(rec[k])]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))));
}

function pythonHelp(req: Record<string, unknown>): string[] {
  const wanted = canonical(req);
  const hit = ORACLE.help.find((c) => canonical(c.request) === wanted);
  if (hit === undefined) {
    throw new Error(
      `no frozen help[] for ${wanted} in cr098-next-oracle.json — regenerate it: ` +
        "python3 tests/fixtures/cr098-next-oracle.gen.py",
    );
  }
  return hit.help;
}

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — track spellings scope the lane the same way `wave-sequence` accepts
// them (ports CanonicalTrackTest's spellings onto the resolver's own surface,
// since the standalone `canonical_track` helper is retired — AC10)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC6 — every spelling 091 accepts resolves the same lane", () => {
  const TWO_TRACK = [entry("CR-NEXTPTR-100", 10, { track: "track-1" }), entry("CR-NEXTPTR-200", 20, { track: "track-2" })];

  const ACCEPTED = ["2", "track-2", "Track 2", "TRACK-2", "  2  ", "track-02", "1", "track-11"];

  test("every accepted spelling of track 2 answers CR-NEXTPTR-200; '1' resolves the declared track-1, 'track-11' is refused as an undeclared lane", () => {
    for (const spelling of ["2", "track-2", "Track 2", "TRACK-2", "  2  ", "track-02"]) {
      const answer = fields(TWO_TRACK, { track: spelling });
      expect(answer.decision, `--track ${JSON.stringify(spelling)}`).toBe("NEXT");
      expect(answer.cr).toBe("CR-NEXTPTR-200");
    }
    // CR-CRU-098 C2 — the RED port asserted DRAINED, which the Python oracle never produced; corrected to the oracle's measured answers.
    // "1" and "track-11" are both members of ACCEPTED (091's accepted spellings), so this
    // block, together with the loop above, exercises every value ACCEPTED declares.
    expect(ACCEPTED).toContain("1");
    const one = fields(TWO_TRACK, { track: "1" });
    expect(one.decision).toBe("NEXT");
    expect(one.cr).toBe("CR-NEXTPTR-100");
    expect(one.track).toBe("track-1");

    expect(ACCEPTED).toContain("track-11");
    const eleven = resolve(TWO_TRACK, { track: "track-11" });
    expect(eleven.ok).toBe(false);
    expect(eleven.code).toBe(2);
    expect(eleven.fields.needs).toEqual(["track"]);
    expect(eleven.fields.tracks).toEqual(["track-1", "track-2"]);
    expect(eleven.fields.totalCount).toBe(2);
    expect(eleven.fields.decision).toBeUndefined();
  });

  test("a value naming no integer is refused exactly as no --track at all, in a multi-track project", () => {
    for (const spelling of ["", "track", "lane", "Track N", "   "]) {
      const result = resolve(TWO_TRACK, { track: spelling });
      expect(result.ok).toBe(false);
      expect(result.code).toBe(2);
      expect(result.fields.needs).toEqual(["track"]);
      expect(result.fields.tracks).toEqual(["track-1", "track-2"]);
      expect(result.fields.decision).toBeUndefined();
    }
  });

  test("a non-canonical stored track ('2') still matches the canonical flag ('track-2')", () => {
    const entries = [entry("CR-NEXTPTR-A", 10, { track: "track-1" }), entry("CR-NEXTPTR-B", 20, { track: "2" })];
    const answer = fields(entries, { track: "track-2" });
    expect(answer.decision).toBe("NEXT");
    expect(answer.cr).toBe("CR-NEXTPTR-B");
  });

  test("the refusal's tracks[] echoes the STORED spelling, never the caller's", () => {
    const entries = [entry("CR-NEXTPTR-A", 10, { track: "track-1" }), entry("CR-NEXTPTR-B", 20, { track: "2" })];
    const result = resolve(entries);
    expect(result.fields.tracks).toEqual(["2", "track-1"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — track scoping is conditional on the data (TrackScopingTest)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC6 — multi-track refusal never picks a lane", () => {
  const TWO_TRACK = [entry("CR-NEXTPTR-100", 10, { track: "track-1" }), entry("CR-NEXTPTR-200", 20, { track: "track-2" })];

  test("no --track in a two-lane project refuses with needs/tracks/totalCount/help, never a decision", () => {
    const result = resolve(TWO_TRACK);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.fields.needs).toEqual(["track"]);
    expect(result.fields.tracks).toEqual(["track-1", "track-2"]);
    expect(result.fields.totalCount).toBe(2);
    expect(Array.isArray(result.fields.help)).toBe(true);
    expect((result.fields.help as unknown[]).length).toBeGreaterThan(0);
    expect(result.fields.decision).toBeUndefined();
  });

  test("a --track outside the live list is refused with the SAME live list, not a made-up one", () => {
    const result = resolve(TWO_TRACK, { track: "9" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.fields.tracks).toEqual(["track-1", "track-2"]);
  });

  test("a single-track project answers bare — no needs, no tracks[] key at all", () => {
    const entries = [entry("CR-NEXTPTR-A", 10, { track: "track-1" }), entry("CR-NEXTPTR-B", 20, { track: "track-1" })];
    const result = resolve(entries);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.fields.decision).toBe("NEXT");
    expect(result.fields.cr).toBe("CR-NEXTPTR-A");
    expect(result.fields).not.toHaveProperty("needs");
    expect(result.fields).not.toHaveProperty("tracks");
  });

  test("a project declaring no track at all is the SAME shape as single-track — never a silent needs=[track]", () => {
    const entries = [entry("CR-NEXTPTR-A", 10), entry("CR-NEXTPTR-B", 20)];
    const result = resolve(entries);
    expect(result.ok).toBe(true);
    expect(result.fields.decision).toBe("NEXT");
    expect(result.fields).not.toHaveProperty("needs");
    expect(result.fields).not.toHaveProperty("tracks");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1/AC4 — NEXT (NextDecisionTest)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC1/AC4 — NEXT names the cr and its published seq, verbatim", () => {
  test("NEXT names the first published entry and its own seq, never index-derived", () => {
    const entries = [entry("CR-NEXTPTR-100", 10), entry("CR-NEXTPTR-101", 20)];
    const answer = fields(entries);
    expect(answer.decision).toBe("NEXT");
    expect(answer.cr).toBe("CR-NEXTPTR-100");
    expect(answer.seq).toBe(10);
  });

  test("a LANDED dependency (COMPLETED or COMPLETED_UNTRACKED) never blocks", () => {
    for (const status of ["COMPLETED", "COMPLETED_UNTRACKED"] as const) {
      const entries = [
        entry("CR-NEXTPTR-DEP", 10, { status }),
        entry("CR-NEXTPTR-100", 20, { dependsOn: ["CR-NEXTPTR-DEP"] }),
      ];
      const answer = fields(entries);
      expect(answer.decision).toBe("NEXT");
      expect(answer.cr).toBe("CR-NEXTPTR-100");
    }
  });

  test("declared fields (release, track when >1 lane) ride the answer verbatim; absent ones are OMITTED, never null", () => {
    const entries = [
      entry("CR-NEXTPTR-BARE", 10, { wave: "5" }),
      entry("CR-NEXTPTR-REL", 20, { wave: "5", release: "0.2.0" }),
    ];
    const answer = fields(entries);
    expect(answer.decision).toBe("NEXT");
    expect(answer.cr).toBe("CR-NEXTPTR-BARE");
    expect(answer.seq).toBe(10);
    expect(answer.wave).toBe("5");
    expect(answer).not.toHaveProperty("release");
    expect(answer.release === null).toBe(false);
  });

  test("seq is never substituted by the wave or the cr id", () => {
    const answer = fields([entry("CR-NEXTPTR-100", 30, { wave: "5" })]);
    expect(answer.seq).toBe(30);
    expect(answer.seq).not.toBe(0);
    expect(answer.seq).not.toBe("5");
  });

  test("a VOID or SUPERSEDED entry is never offered as the next work — the second, live entry is", () => {
    for (const lifecycle of [voidLc(), supersededLc("CR-NEXTPTR-ALIVE")]) {
      const entries = [
        entry("CR-NEXTPTR-DEAD", 10, { lifecycle }),
        entry("CR-NEXTPTR-ALIVE", 20),
      ];
      const answer = fields(entries);
      expect(answer.decision).toBe("NEXT");
      expect(answer.cr).toBe("CR-NEXTPTR-ALIVE");
      expect(answer.seq).toBe(20);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1/AC4/AC5 — HOLD and its four triggers, fixed precedence (HoldDecisionTest)
// ═══════════════════════════════════════════════════════════════════════════

const HOLD_FIXTURES: Record<string, { entries: QueueEntry[]; track?: string; held: string }> = {
  "in-flight": {
    entries: [entry("CR-NEXTPTR-RUN", 10, { status: "IN_PROGRESS" }), entry("CR-NEXTPTR-WAIT", 20)],
    held: "CR-NEXTPTR-WAIT",
  },
  dependency: {
    entries: [
      entry("CR-NEXTPTR-DEP", 10, { track: "track-2" }),
      entry("CR-NEXTPTR-TARGET", 20, { track: "track-1", dependsOn: ["CR-NEXTPTR-DEP"] }),
    ],
    track: "track-1",
    held: "CR-NEXTPTR-TARGET",
  },
  "unknown-dependency": {
    entries: [entry("CR-NEXTPTR-TARGET", 10, { dependsOn: ["CR-NEXTPTR-GHOST"] })],
    held: "CR-NEXTPTR-TARGET",
  },
  "dead-dependency": {
    entries: [
      entry("CR-NEXTPTR-DEAD", 10, { lifecycle: voidLc() }),
      entry("CR-NEXTPTR-TARGET", 20, { dependsOn: ["CR-NEXTPTR-DEAD"] }),
    ],
    held: "CR-NEXTPTR-TARGET",
  },
};

describe("CR-CRU-098 AC1/AC4 — HOLD's four trigger kinds", () => {
  test("every HOLD names its kind, the held cr and its seq, with a structured trigger", () => {
    for (const kind of Object.keys(HOLD_FIXTURES)) {
      const fixture = HOLD_FIXTURES[kind]!;
      const answer = fields(fixture.entries, { track: fixture.track });
      expect(answer.decision).toBe("HOLD");
      expect(answer.cr).toBe(fixture.held);
      expect(typeof answer.seq).toBe("number");
      const trigger = answer.trigger as Record<string, unknown>;
      expect(trigger).toBeTruthy();
      expect(trigger.kind).toBe(kind);
    }
  });

  test("the decision vocabulary is exactly the four HOLD trigger kinds and the three DRAINED reasons, in their declared order (ported from DecisionVocabularyIsUnchangedTest)", () => {
    expect([...HOLD_TRIGGER_KINDS]).toEqual(["in-flight", "dead-dependency", "dependency", "unknown-dependency"]);
    expect([...DRAINED_REASONS]).toEqual(["wave-complete", "awaiting-assignment", "no-roadmap"]);
  });

  test("the declared HOLD_TRIGGER_KINDS constant is exactly the four kinds the fixtures produce", () => {
    expect([...HOLD_TRIGGER_KINDS].sort()).toEqual(Object.keys(HOLD_FIXTURES).sort());
  });

  test("in-flight names the occupying cr", () => {
    const fixture = HOLD_FIXTURES["in-flight"]!;
    const trigger = fields(fixture.entries).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("in-flight");
    expect(trigger.cr).toBe("CR-NEXTPTR-RUN");
  });

  test("dependency lists EVERY live blocker with its live status, not just the first", () => {
    const entries = [
      entry("CR-NEXTPTR-D1", 10, { track: "track-2" }),
      entry("CR-NEXTPTR-D2", 20, { track: "track-2" }),
      entry("CR-NEXTPTR-TARGET", 30, { track: "track-1", dependsOn: ["CR-NEXTPTR-D1", "CR-NEXTPTR-D2"] }),
    ];
    const trigger = fields(entries, { track: "1" }).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("dependency");
    expect(trigger.blockedBy).toEqual([
      { cr: "CR-NEXTPTR-D1", status: "PENDING" },
      { cr: "CR-NEXTPTR-D2", status: "PENDING" },
    ]);
  });

  test("unknown-dependency names the dep and rides a structured warning naming it", () => {
    const fixture = HOLD_FIXTURES["unknown-dependency"]!;
    const result = resolve(fixture.entries);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    const trigger = result.fields.trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("unknown-dependency");
    expect(trigger.cr).toBe("CR-NEXTPTR-GHOST");
    const codes = (result.warnings as ResolveWarning[]).map((w) => w.code);
    expect(codes).toContain("unknown-dependency");
    const detail = (result.warnings as ResolveWarning[]).find((w) => w.code === "unknown-dependency")!.detail;
    expect(detail).toContain("CR-NEXTPTR-GHOST");
  });

  test("occupancy is evaluated BEFORE the dependency axis — an in-flight lane never reports dependency", () => {
    const entries = [
      entry("CR-NEXTPTR-RUN", 10, { status: "IN_PROGRESS" }),
      entry("CR-NEXTPTR-DEP", 20),
      entry("CR-NEXTPTR-WAIT", 30, { dependsOn: ["CR-NEXTPTR-DEP"] }),
    ];
    const trigger = fields(entries).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("in-flight");
    expect(trigger.cr).toBe("CR-NEXTPTR-RUN");
  });

  test("HOLD is never a skip — a blocked front cr is answered, not scanned past for a startable one behind it", () => {
    const entries = [
      entry("CR-NEXTPTR-Z", 5, { track: "track-2" }),
      entry("CR-NEXTPTR-A", 1, { track: "track-1", dependsOn: ["CR-NEXTPTR-Z"] }),
      entry("CR-NEXTPTR-B", 2, { track: "track-1" }),
    ];
    const answer = fields(entries, { track: "1" });
    expect(answer.decision).toBe("HOLD");
    expect(answer.cr).toBe("CR-NEXTPTR-A");
    expect(answer.seq).toBe(1);
  });

  test("a VOID dependency reports dead-dependency, never an ordinary dependency waiting would clear", () => {
    const fixture = HOLD_FIXTURES["dead-dependency"]!;
    const trigger = fields(fixture.entries).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("dead-dependency");
    expect(trigger.cr).toBe("CR-NEXTPTR-DEAD");
    expect(trigger.state).toBe("VOID");
    expect(trigger).not.toHaveProperty("by");
  });

  test("a SUPERSEDED dependency's trigger carries its successor's cr as `by`", () => {
    const entries = [
      entry("CR-NEXTPTR-DEAD", 10, { lifecycle: supersededLc("CR-NEXTPTR-NEW") }),
      entry("CR-NEXTPTR-TARGET", 20, { dependsOn: ["CR-NEXTPTR-DEAD"] }),
    ];
    const trigger = fields(entries).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("dead-dependency");
    expect(trigger.cr).toBe("CR-NEXTPTR-DEAD");
    expect(trigger.state).toBe("SUPERSEDED");
    expect(trigger.by).toBe("CR-NEXTPTR-NEW");
  });

  test("dead-dependency outranks a live one when a lane is blocked by both", () => {
    const entries = [
      entry("CR-NEXTPTR-LIVE", 10, { track: "track-2" }),
      entry("CR-NEXTPTR-DEAD", 20, { track: "track-2", lifecycle: voidLc() }),
      entry("CR-NEXTPTR-TARGET", 30, {
        track: "track-1",
        dependsOn: ["CR-NEXTPTR-LIVE", "CR-NEXTPTR-DEAD"],
      }),
    ];
    const trigger = fields(entries, { track: "1" }).trigger as Record<string, unknown>;
    expect(trigger.kind).toBe("dead-dependency");
    expect(trigger.cr).toBe("CR-NEXTPTR-DEAD");
  });

  test("a dependency LANDED before it was superseded does not block — status decides landed first", () => {
    const entries = [
      entry("CR-NEXTPTR-DONE", 10, { status: "COMPLETED", lifecycle: supersededLc("CR-NEXTPTR-NEW") }),
      entry("CR-NEXTPTR-TARGET", 20, { dependsOn: ["CR-NEXTPTR-DONE"] }),
    ];
    const answer = fields(entries);
    expect(answer.decision).toBe("NEXT");
    expect(answer.cr).toBe("CR-NEXTPTR-TARGET");
  });

  test("dependencies resolve across the WHOLE queue; occupancy stays scoped to the LANE", () => {
    const crossTrackDep = [
      entry("CR-NEXTPTR-OTHER", 10, { track: "track-1" }),
      entry("CR-NEXTPTR-TARGET", 20, { track: "track-2", dependsOn: ["CR-NEXTPTR-OTHER"] }),
    ];
    const blocked = fields(crossTrackDep, { track: "2" });
    expect(blocked.decision).toBe("HOLD");
    expect((blocked.trigger as Record<string, unknown>).kind).toBe("dependency");

    const crossTrackOccupancy = [
      entry("CR-NEXTPTR-OTHER", 10, { track: "track-1", status: "IN_PROGRESS" }),
      entry("CR-NEXTPTR-TARGET", 20, { track: "track-2" }),
    ];
    const unblocked = fields(crossTrackOccupancy, { track: "track-2" });
    expect(unblocked.decision).toBe("NEXT");
    expect(unblocked.cr).toBe("CR-NEXTPTR-TARGET");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1/AC4 — DRAINED and its three reasons, plus the dead-CR axis (DrainedDecisionTest)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC1/AC4 — DRAINED's three reasons", () => {
  test("zero entries at all is no-roadmap", () => {
    const result = resolve([]);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.fields.decision).toBe("DRAINED");
    expect(result.fields.reason).toBe("no-roadmap");
    expect(Array.isArray(result.fields.help)).toBe(true);
    expect((result.fields.help as unknown[]).length).toBeGreaterThan(0);
  });

  test("entries exist but none is in the asked-for lane is awaiting-assignment, not a refusal", () => {
    const entries = [entry("CR-NEXTPTR-A", 10, { track: "track-1" }), entry("CR-NEXTPTR-B", 20, { track: "track-1" })];
    const result = resolve(entries, { track: "9" });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.fields.decision).toBe("DRAINED");
    expect(result.fields.reason).toBe("awaiting-assignment");
    expect(result.fields).not.toHaveProperty("needs");
  });

  test("a lane whose entire work landed is wave-complete", () => {
    const entries = [
      entry("CR-NEXTPTR-A", 10, { status: "COMPLETED" }),
      entry("CR-NEXTPTR-B", 20, { status: "COMPLETED_UNTRACKED" }),
    ];
    const answer = fields(entries);
    expect(answer.decision).toBe("DRAINED");
    expect(answer.reason).toBe("wave-complete");
  });

  test("DRAINED never answers with a bare empty list or a null cr — always a named reason, never a cr key", () => {
    for (const entries of [[], [entry("CR-NEXTPTR-A", 10, { status: "COMPLETED" })]]) {
      const answer = fields(entries);
      expect(DRAINED_REASONS).toContain(answer.reason as string);
      expect(answer).not.toHaveProperty("cr");
    }
  });

  test("skipping a DEAD entry is not skipping a BLOCKED one — the dead cr is passed over, the blocked one stops the answer", () => {
    const entries = [
      entry("CR-NEXTPTR-DEAD", 10, { track: "track-1", lifecycle: voidLc() }),
      entry("CR-NEXTPTR-BLOCKER", 20, { track: "track-2" }),
      entry("CR-NEXTPTR-BLOCKED", 30, { track: "track-1", dependsOn: ["CR-NEXTPTR-BLOCKER"] }),
    ];
    const answer = fields(entries, { track: "1" });
    expect(answer.decision).toBe("HOLD");
    expect(answer.cr).toBe("CR-NEXTPTR-BLOCKED");
    expect((answer.trigger as Record<string, unknown>).kind).toBe("dependency");
  });

  test("a lane of nothing but corpses drains wave-complete and NAMES them in help[]; a lane that merely finished names none", () => {
    const corpses = [
      entry("CR-NEXTPTR-DEAD1", 10, { lifecycle: voidLc() }),
      entry("CR-NEXTPTR-DEAD2", 20, { lifecycle: supersededLc("CR-NEXTPTR-NEW") }),
      entry("CR-NEXTPTR-DONE", 30, { status: "COMPLETED" }),
    ];
    const drained = fields(corpses);
    expect(drained.decision).toBe("DRAINED");
    expect(drained.reason).toBe("wave-complete");
    const joined = (drained.help as string[]).join(" | ");
    expect(joined).toContain("CR-NEXTPTR-DEAD1");
    expect(joined).toContain("CR-NEXTPTR-DEAD2");

    const clean = fields([entry("CR-NEXTPTR-DONE2", 10, { status: "COMPLETED" })]);
    const cleanJoined = (clean.help as string[]).join(" | ");
    expect(cleanJoined).not.toContain("declared dead");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — the published order is the order: no sort, no seq comparison
// (LaneOrderTest + cr095's PublishedOrderIsConsumedTest, minus the client-side
// resolve_next AST guard, which is RETIRED — the client-side function is gone)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC1 — resolveNext consumes the PUBLISHED order, never re-sorts by seq value", () => {
  test("a deliberately scrambled input [seq 30, 10, 20] is answered by its FIRST published row, not the lowest seq", () => {
    const entries = [entry("CR-NEXTPTR-THIRD", 30), entry("CR-NEXTPTR-FIRST", 10), entry("CR-NEXTPTR-SECOND", 20)];
    const answer = fields(entries);
    expect(answer.cr).toBe("CR-NEXTPTR-THIRD");
    expect(answer.seq).toBe(30);
  });

  test("published order beats seq VALUE order even across a release/wave-6 divide (the live-board shape CR-095 fixed)", () => {
    const entries = [
      entry("CR-NEXTPTR-PUB-FIRST", 5001, { release: "0.2.0" }),
      entry("CR-NEXTPTR-PUB-SECOND", 62, { wave: "6" }),
    ];
    const answer = fields(entries);
    expect(answer.cr).toBe("CR-NEXTPTR-PUB-FIRST");
    expect(answer.seq).toBe(5001);
  });

  test("a non-actionable row published first is skipped WITHOUT promoting a lower-seq row from further down the lane", () => {
    const entries = [
      entry("CR-NEXTPTR-DONE", 5001, { status: "COMPLETED", release: "0.2.0" }),
      entry("CR-NEXTPTR-VOIDED", 5002, { release: "0.2.0", lifecycle: voidLc() }),
      entry("CR-NEXTPTR-ANSWER", 5003, { release: "0.2.0" }),
      entry("CR-NEXTPTR-DEFERRED", 62, { wave: "6" }),
    ];
    const answer = fields(entries);
    expect(answer.cr).toBe("CR-NEXTPTR-ANSWER");
  });

  test("an entry published without a seq keeps its PUBLISHED POSITION (never moved last) and still fires missing-seq", () => {
    const noSeq = { cr: "CR-NEXTPTR-NOSEQ", wave: "5", dependsOn: [], status: "PENDING" } as unknown as QueueEntry;
    const entries = [noSeq, entry("CR-NEXTPTR-OK", 10)];
    const result = resolve(entries);
    expect(result.fields.cr).toBe("CR-NEXTPTR-NOSEQ");
    const codes = (result.warnings as ResolveWarning[]).map((w) => w.code);
    expect(codes).toContain("missing-seq");
    const detail = (result.warnings as ResolveWarning[]).find((w) => w.code === "missing-seq")!.detail;
    expect(detail).toContain("CR-NEXTPTR-NOSEQ");
  });

  test("`src/next.ts` contains no comparator — no `.sort(` anywhere in the pure resolver's own module", async () => {
    const source = await Bun.file(`${REPO_ROOT}src/next.ts`).text();
    const sortCalls = source.match(/\.sort\s*\(/g) ?? [];
    expect(
      sortCalls,
      "AC1 forbids ANY sort/seq comparison in the resolver — §S1 makes the server " +
        "the single source of ordering truth, and a reader that re-sorts is the " +
        "reader-side derivation CR-091 AC18 outlawed",
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — the pure function is deterministic: same input, same answer, twice
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC3 — resolveNext is deterministic over an unchanged input", () => {
  test("two calls with the identical entries/tracks/scope produce byte-identical (deep-equal) results", () => {
    const entries = [entry("CR-NEXTPTR-A", 10), entry("CR-NEXTPTR-B", 20, { dependsOn: ["CR-NEXTPTR-A"] })];
    const first = resolve(entries);
    const second = resolve(entries);
    expect(second).toEqual(first);
  });

  test("a resolve AFTER a mutated entries array reflects the mutation — nothing is cached across calls", () => {
    const entries = [entry("CR-NEXTPTR-A", 10)];
    const before = fields(entries);
    expect(before.cr).toBe("CR-NEXTPTR-A");
    entries[0] = entry("CR-NEXTPTR-A", 10, { lifecycle: voidLc() });
    const after = fields(entries);
    expect(after.decision).toBe("DRAINED");
    expect(after.reason).toBe("wave-complete");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — help[] is STRING-IDENTICAL to today's Python `_next_start_help` /
// `_hold_help` / `_drained_help`, computed live via subprocess, never retyped
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC5 — help[] matches clients/_crucible_axi.py's helpers byte for byte", () => {
  test("NEXT's help[] matches _next_start_help — with and without a declared wave", () => {
    for (const waveEntry of [{ cr: "CR-NEXTPTR-100", wave: "7" }, { cr: "CR-NEXTPTR-100", wave: null }]) {
      const built = waveEntry.wave
        ? fields([entry("CR-NEXTPTR-100", 10, { wave: waveEntry.wave })])
        : fields([{ cr: "CR-NEXTPTR-100", wave: "", dependsOn: [], status: "PENDING", seq: 10 } as QueueEntry]);
      const expected = pythonHelp({ fn: "start", entry: waveEntry });
      expect(built.help).toEqual(expected);
    }
  });

  test("HOLD's help[] matches _hold_help for all four trigger kinds", () => {
    const triggers: Record<string, Record<string, unknown>> = {
      "in-flight": { kind: "in-flight", cr: "CR-NEXTPTR-RUN" },
      dependency: {
        kind: "dependency",
        blockedBy: [{ cr: "CR-NEXTPTR-DEP", status: "PENDING" }],
      },
      "dead-dependency": { kind: "dead-dependency", cr: "CR-NEXTPTR-DEAD", state: "VOID" },
      "unknown-dependency": { kind: "unknown-dependency", cr: "CR-NEXTPTR-GHOST" },
    };
    for (const [kind, fixture] of Object.entries(HOLD_FIXTURES)) {
      const answer = fields(fixture.entries, { track: fixture.track });
      const trigger = answer.trigger as Record<string, unknown>;
      const expected = pythonHelp({ fn: "hold", trigger });
      expect(answer.help, `HOLD help[] for ${kind}`).toEqual(expected);
    }
    void triggers; // kept for readability of the mapping above; assertions read `answer.trigger`
  });

  test("DRAINED's help[] matches _drained_help for all three reasons, including the wave-complete corpse list", () => {
    const noRoadmap = fields([]);
    expect(noRoadmap.help).toEqual(pythonHelp({ fn: "drained", reason: "no-roadmap", lane: [] }));

    const awaiting = fields(
      [entry("CR-NEXTPTR-A", 10, { track: "track-1" })],
      { track: "9" },
    );
    expect(awaiting.help).toEqual(pythonHelp({ fn: "drained", reason: "awaiting-assignment", lane: [] }));

    const corpseLane = [
      entry("CR-NEXTPTR-DEAD1", 10, { lifecycle: voidLc() }),
      entry("CR-NEXTPTR-DEAD2", 20, { lifecycle: supersededLc("CR-NEXTPTR-NEW") }),
    ];
    const waveComplete = fields(corpseLane);
    const pyLane = corpseLane.map((e) => ({
      cr: e.cr,
      lifecycle: e.lifecycle ? { state: e.lifecycle.state, by: e.lifecycle.by } : undefined,
    }));
    expect(waveComplete.help).toEqual(
      pythonHelp({ fn: "drained", reason: "wave-complete", lane: pyLane }),
    );
  });

  test("resolveNext answers every board the frozen oracle recorded exactly as today's client resolve_next did (C3 ruling: the server matches the old resolver)", () => {
    // Non-vacuity: both the python route test's boards and this file's AC5
    // boards are recorded, and the record names the commit it came from.
    expect(ORACLE.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ORACLE.resolver.length).toBeGreaterThanOrEqual(10);
    for (const c of ORACLE.resolver) {
      const got = resolveNext(c.entries, c.tracks, c.scope);
      const label = canonical({ entries: c.entries, scope: c.scope });
      expect(got.ok, label).toBe(c.result.ok);
      expect(got.code, label).toBe(c.result.code);
      expect(got.fields, label).toEqual(c.result.fields);
      expect(got.warnings, label).toEqual(c.result.warnings);
    }
  });

  test("NEXT's start template hands back the repeatable --cycle form, never legacy --cycles, repeated 2-3 times (CR-107 AC8, ported from test_plan_file_cycle_flag_help.py)", () => {
    const step = fields([entry("CR-NEXTPTR-100", 10, { wave: "7" })]).help as string[];
    const template = step[0]!;
    expect(template).not.toMatch(/--cycles /);
    const repeatable = template.match(/--cycle "/g) ?? [];
    expect(repeatable.length).toBeGreaterThanOrEqual(2);
    expect(repeatable.length).toBeLessThanOrEqual(3);
  });
});

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// AC2 CENSUS EXPANSION (2nd RED pass) \u2014 tests/client/test_next_announces_the_wave_boundary.py
// (20 tests: 18 reach `cmd_next`, PORTED below; 2 assert AXI.DRAINED_REASONS/
// HOLD_TRIGGER_KINDS \u2014 ported at C3 to the exact-vocabulary test in the HOLD group)
// and tests/client/test_next_lane_carries_release_and_wave.py (13 of its 20
// tests reach `cmd_next` and are PORTED below; 2 are KEPT \u2014
// tests/client/test_cr098_next_verb_reads_the_route.py; 5 are OUT OF the AC2
// census \u2014 they never reach an AC10 symbol \u2014 and 1 is a black-box E2E
// subprocess test, unaffected by an internal refactor). See
// docs/changes/CR-CRU-098-test-classification.md for the full census table.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

describe("CR-CRU-098 \u00a7S2/AC4 \u2014 waveCompleted: the crossing is announced and expires", () => {
  const PREDECESSOR_WAVE = "5";
  const RESOLVED_WAVE = "6";

  const boundaryJustCrossed = () => [
    entry("CR-A5-1", 5001, { status: "COMPLETED", wave: PREDECESSOR_WAVE }),
    entry("CR-A5-2", 5002, { status: "COMPLETED", wave: PREDECESSOR_WAVE }),
    entry("CR-A5-3", 5003, { wave: PREDECESSOR_WAVE, lifecycle: { state: "VOID", by: "CR-A5-1" } as unknown as QueueLifecycle }),
    entry("CR-B6-1", 6001, { wave: RESOLVED_WAVE }),
    entry("CR-B6-2", 6002, { wave: RESOLVED_WAVE }),
  ];
  const boundaryAlreadyCrossed = () =>
    boundaryJustCrossed().map((e) => (e.cr === "CR-B6-1" ? { ...e, status: "COMPLETED" as const } : e));

  test("a crossing states the predecessor completed beside its decision", () => {
    const answer = fields(boundaryJustCrossed());
    expect({ decision: answer.decision, cr: answer.cr, wave: answer.wave, waveCompleted: answer.waveCompleted })
      .toEqual({ decision: "NEXT", cr: "CR-B6-1", wave: RESOLVED_WAVE, waveCompleted: PREDECESSOR_WAVE });
  });

  test("the announcement expires the moment the new wave lands its first cr, and the decision is unaffected", () => {
    expect(fields(boundaryJustCrossed()).waveCompleted).toBe(PREDECESSOR_WAVE);
    const after = fields(boundaryAlreadyCrossed());
    expect(after.waveCompleted).toBeUndefined();
    expect(after).not.toHaveProperty("waveCompleted");
    expect(after.decision).toBe("NEXT");
    expect(after.cr).toBe("CR-B6-2");
  });

  test("the predecessor is the previous DISTINCT label in PUBLISHED order, never parsed as an integer or re-derived from seq", () => {
    const entries = [
      entry("CR-C6-1", 601, { status: "COMPLETED", wave: "06" }),
      entry("CR-C6-2", 602, { status: "COMPLETED", wave: "06" }),
      entry("CR-D1-1", 1001, { status: "COMPLETED", wave: "10" }),
      entry("CR-D1-2", 1002, { status: "COMPLETED", wave: "10" }),
      entry("CR-E9-1", 901, { wave: "9" }),
      entry("CR-E9-2", 902, { wave: "9" }),
    ];
    const answer = fields(entries);
    expect(answer.wave).toBe("9");
    expect(answer.waveCompleted).toBe("10");
    expect(answer.waveCompleted).not.toBe("06");
  });

  test("the announcement rides every decision \u2014 NEXT, HOLD and DRAINED all state the predecessor completed", () => {
    const next = fields(boundaryJustCrossed());
    const holdEntries = boundaryJustCrossed().slice(0, 3).concat([
      entry("CR-M6-1", 6001, { wave: RESOLVED_WAVE, status: "IN_PROGRESS" }),
      entry("CR-M6-2", 6002, { wave: RESOLVED_WAVE }),
    ]);
    const hold = fields(holdEntries);
    const drainedEntries = boundaryJustCrossed().slice(0, 3).concat([
      entry("CR-M6-3", 6001, { wave: RESOLVED_WAVE, track: "track-1", lifecycle: { state: "VOID", by: "CR-M6-4" } as unknown as QueueLifecycle }),
      entry("CR-M6-4", 6002, { wave: RESOLVED_WAVE, track: "track-2" }),
    ]);
    const drained = fields(drainedEntries, { track: "1" });
    expect({ NEXT: next.decision, HOLD: hold.decision, DRAINED: drained.decision })
      .toEqual({ NEXT: "NEXT", HOLD: "HOLD", DRAINED: "DRAINED" });
    expect({ NEXT: next.waveCompleted, HOLD: hold.waveCompleted, DRAINED: drained.waveCompleted })
      .toEqual({ NEXT: PREDECESSOR_WAVE, HOLD: PREDECESSOR_WAVE, DRAINED: PREDECESSOR_WAVE });
  });

  test("DRAINED's help[] names the NEXT wave's label VERBATIM \u2014 zero-padded and non-numeric labels both ride as data", () => {
    const zeroPadded = [
      entry("CR-F6-1", 601, { status: "COMPLETED", wave: "06" }),
      entry("CR-F6-2", 602, { wave: "06", lifecycle: { state: "VOID", by: "CR-F6-1" } as unknown as QueueLifecycle }),
      entry("CR-G7-1", 701, { wave: "07" }),
    ];
    const padded = fields(zeroPadded, { wave: "06" });
    expect(padded.decision).toBe("DRAINED");
    expect(padded.reason).toBe("wave-complete");
    const paddedHelp = (padded.help as string[]).join(" | ");
    expect(paddedHelp).toContain("--wave 07");
    expect(paddedHelp).not.toMatch(/--wave 7\b/);

    const nonNumeric = [
      entry("CR-J1-1", 101, { status: "COMPLETED", wave: "alpha" }),
      entry("CR-K2-1", 201, { wave: "beta" }),
    ];
    const named = fields(nonNumeric, { wave: "alpha" });
    const namedHelp = (named.help as string[]).join(" | ");
    expect(namedHelp).toContain("--wave beta");
  });

  test("the earliest published wave announces no completed predecessor \u2014 nothing precedes it", () => {
    const answer = fields([entry("CR-N1-1", 101, { wave: "1" }), entry("CR-N1-2", 102, { wave: "1" })]);
    expect(answer.decision).toBe("NEXT");
    expect(answer.cr).toBe("CR-N1-1");
    expect(answer).not.toHaveProperty("waveCompleted");
  });

  test("the announcement is scoped to the CONTAINER asked about \u2014 a release-scoped read announces within it, the unscoped read announces nothing", () => {
    const entries = [
      entry("CR-V5-1", 5001, { status: "COMPLETED", wave: PREDECESSOR_WAVE, release: "0.2.0" }),
      entry("CR-V5-2", 5002, { wave: PREDECESSOR_WAVE }),
      entry("CR-W6-1", 6001, { wave: RESOLVED_WAVE, release: "0.2.0" }),
    ];
    const scoped = fields(entries, { release: "0.2.0" });
    expect({ decision: scoped.decision, cr: scoped.cr, wave: scoped.wave, release: scoped.release, waveCompleted: scoped.waveCompleted })
      .toEqual({ decision: "NEXT", cr: "CR-W6-1", wave: RESOLVED_WAVE, release: "0.2.0", waveCompleted: PREDECESSOR_WAVE });

    const unscoped = fields(entries);
    expect(unscoped.decision).toBe("NEXT");
    expect(unscoped.cr).toBe("CR-V5-2");
    expect(unscoped).not.toHaveProperty("waveCompleted");
  });

  test("an explicit --wave against a fully-landed-or-dead wave answers DRAINED wave-complete for THAT wave, even while a later wave holds actionable work", () => {
    const answer = fields(boundaryJustCrossed(), { wave: PREDECESSOR_WAVE });
    expect({ decision: answer.decision, reason: answer.reason, wave: answer.wave })
      .toEqual({ decision: "DRAINED", reason: "wave-complete", wave: PREDECESSOR_WAVE });
  });

  test("a wave holding only corpses (VOID + SUPERSEDED, no PENDING) is complete", () => {
    const entries = [
      entry("CR-P6-1", 601, { wave: "06", lifecycle: { state: "VOID", by: "CR-P6-2" } as unknown as QueueLifecycle }),
      entry("CR-P6-2", 602, { wave: "06", lifecycle: { state: "SUPERSEDED", by: "CR-P6-1" } as unknown as QueueLifecycle }),
      entry("CR-Q7-1", 701, { wave: "07" }),
    ];
    const answer = fields(entries, { wave: "06" });
    expect({ decision: answer.decision, reason: answer.reason, wave: answer.wave })
      .toEqual({ decision: "DRAINED", reason: "wave-complete", wave: "06" });
  });

  test("a blocked front cr HOLDs its own wave rather than scanning on into a later, startable wave", () => {
    const entries = boundaryJustCrossed().slice(0, 3).concat([
      entry("CR-S6-1", 6001, { wave: RESOLVED_WAVE, dependsOn: ["CR-S6-2"] }),
      entry("CR-S6-2", 6002, { wave: RESOLVED_WAVE }),
      entry("CR-T7-1", 7001, { wave: "7" }),
    ]);
    const later = fields(entries, { wave: "7" });
    expect(later.decision).toBe("NEXT");
    expect(later.cr).toBe("CR-T7-1");

    const answer = fields(entries);
    expect({ decision: answer.decision, cr: answer.cr, wave: answer.wave, kind: (answer.trigger as Record<string, unknown> | undefined)?.kind })
      .toEqual({ decision: "HOLD", cr: "CR-S6-1", wave: RESOLVED_WAVE, kind: "dependency" });
  });

  test("a declared container selecting no row announces no crossing and is awaiting-assignment, never wave-complete", () => {
    const board = boundaryJustCrossed();
    const byWave = fields(board, { wave: "99" });
    const byRelease = fields(board, { release: "9.9.9" });
    for (const answer of [byWave, byRelease]) {
      expect(answer).not.toHaveProperty("waveCompleted");
      expect(answer.decision).toBe("DRAINED");
      expect(answer.reason).toBe("awaiting-assignment");
    }
  });
});

describe("CR-CRU-098 \u00a7S1/AC1/AC4/AC6 \u2014 wave/release lane details (ported from test_next_lane_carries_release_and_wave.py)", () => {
  test("the wave predicate reads `wave` alone \u2014 identical verdict from either lane and with no track at all", () => {
    const twoTrackIncompleteWave = [
      entry("CR-L6-1", 6001, { wave: "6", status: "COMPLETED", track: "track-1" }),
      entry("CR-L6-2", 6002, { wave: "6", status: "COMPLETED", track: "track-1" }),
      entry("CR-L6-3", 6003, { wave: "6", track: "track-2" }),
      entry("CR-L6-4", 6004, { wave: "6", track: "track-2" }),
    ];
    const untracked = twoTrackIncompleteWave.map(({ track: _track, ...rest }) => rest as QueueEntry);
    const verdict = (entries: QueueEntry[], scope: { track?: string } = {}) => {
      const answer = fields(entries, scope);
      return [answer.wave, answer.reason === "wave-complete"];
    };
    expect(verdict(twoTrackIncompleteWave, { track: "1" })).toEqual(["6", false]);
    expect(verdict(twoTrackIncompleteWave, { track: "2" })).toEqual(["6", false]);
    expect(verdict(untracked)).toEqual(["6", false]);
  });

  test("an explicit --wave answers about THAT wave alone, never the earlier or a later wave", () => {
    const entries = [
      entry("CR-L5-1", 5001, { wave: "5" }),
      entry("CR-L6-9", 6001, { wave: "6" }),
      entry("CR-L7-1", 7001, { wave: "7" }),
    ];
    const answer = fields(entries, { wave: "6" });
    expect(answer.wave).toBe("6");
    expect(answer.cr).toBe("CR-L6-9");
  });

  test("a release scope excludes an entry whose release is UNSET \u2014 membership is declared, never inferred", () => {
    const entries = [entry("CR-U1-1", 6001, { wave: "6" }), entry("CR-D2-1", 6002, { wave: "6", release: "0.2.0" })];
    const answer = fields(entries, { release: "0.2.0" });
    expect(answer.cr).toBe("CR-D2-1");
    expect(answer.release).toBe("0.2.0");
  });

  test("a release label is matched VERBATIM and never normalised \u2014 'v0.2.0' and '0.2.0' are two releases", () => {
    const entries = [entry("CR-R1-1", 6001, { wave: "6", release: "0.2.0" }), entry("CR-R2-1", 6002, { wave: "6", release: "v0.2.0" })];
    const answer = fields(entries, { release: "v0.2.0" });
    expect(answer.release).toBe("v0.2.0");
    expect(answer.cr).toBe("CR-R2-1");
  });

  test("a duplicated seq within a wave resolves to the row PUBLISHED FIRST, never a tie-break of the reader's own", () => {
    const entries = [entry("CR-P1-1", 6001, { wave: "6" }), entry("CR-P2-1", 6001, { wave: "6" })];
    const answer = fields(entries);
    expect(answer.cr).toBe("CR-P1-1");
    expect(answer.seq).toBe(6001);
  });

  test("a fully-landed lane inside an unfinished wave is awaiting-assignment, never wave-complete \u2014 the sibling lane proves it", () => {
    const twoTrackIncompleteWave = [
      entry("CR-L6-1", 6001, { wave: "6", status: "COMPLETED", track: "track-1" }),
      entry("CR-L6-2", 6002, { wave: "6", status: "COMPLETED", track: "track-1" }),
      entry("CR-L6-3", 6003, { wave: "6", track: "track-2" }),
      entry("CR-L6-4", 6004, { wave: "6", track: "track-2" }),
    ];
    const landedLane = fields(twoTrackIncompleteWave, { track: "1" });
    expect(landedLane.decision).toBe("DRAINED");
    expect(landedLane.reason).toBe("awaiting-assignment");
    const siblingLane = fields(twoTrackIncompleteWave, { track: "2" });
    expect(siblingLane.decision).toBe("NEXT");
    expect(siblingLane.cr).toBe("CR-L6-3");
  });

  test("every decision \u2014 NEXT, HOLD, DRAINED \u2014 carries the resolved wave, the release when in scope, and the track only when more than one lane is declared", () => {
    const common = { wave: "6", release: "0.2.0" };
    const nextE = [entry("CR-N1-1", 6001, common)];
    const holdE = [entry("CR-H1-1", 6001, { ...common, status: "IN_PROGRESS" }), entry("CR-H2-1", 6002, common)];
    const drainedE = [entry("CR-X1-1", 6001, { ...common, status: "COMPLETED" })];
    for (const [name, entries] of [["NEXT", nextE], ["HOLD", holdE], ["DRAINED", drainedE]] as const) {
      const answer = fields(entries, { release: "0.2.0" });
      expect(answer.wave, `${name} wave`).toBe("6");
      expect(answer.release, `${name} release`).toBe("0.2.0");
    }

    const sibling = entry("CR-S1-1", 6100, { wave: "6", track: "track-1" });
    const trackedNext = fields([sibling, entry("CR-N2-1", 6001, { wave: "6", track: "track-2" })], { track: "2" });
    expect(trackedNext.track).toBe("track-2");

    const singleLaneEntries = [entry("CR-Z1-1", 6001, { wave: "6", track: "track-1" })];
    const singleLane = fields(singleLaneEntries);
    expect(singleLane).not.toHaveProperty("track");
  });

  test("a waveless row (published wave '') sitting first in the published order resolves NO wave", () => {
    const entries = [entry("CR-B0-1", 60, { wave: "" }), entry("CR-L6-1", 6002, { wave: "6" })];
    const answer = fields(entries);
    expect(answer.wave).toBe("6");
    expect(answer.wave).not.toBe("");
    expect(answer.cr).not.toBe("CR-B0-1");
  });
});
