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

// ── AC5 oracle — today's Python help[] builders, run live via subprocess ───
//
// "Derive AC5's expected strings by running today's Python helpers on the same
// fixtures, not by retyping them" (dispatch prompt item 2). Computed IN-TEST via
// a subprocess against `clients/_crucible_axi.py:_next_start_help` /
// `_hold_help` / `_drained_help` — never a checked-in fixture file, so a future
// change to the Python wording is caught here without anyone updating a copy.
const PY_HELP_PROBE = `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("cr098_help_probe", "clients/_crucible_axi.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
req = json.loads(sys.argv[1])
fn = req["fn"]
if fn == "start":
    out = m._next_start_help(req["entry"])
elif fn == "hold":
    out = m._hold_help(req["trigger"])
elif fn == "drained":
    out = m._drained_help(req["reason"], req["lane"], req.get("nextWave"))
else:
    raise SystemExit(f"unknown fn {fn!r}")
print(json.dumps(out))
`;

function pythonHelp(req: Record<string, unknown>): string[] {
  const proc = Bun.spawnSync(["python3", "-c", PY_HELP_PROBE, JSON.stringify(req)], {
    cwd: REPO_ROOT,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `python help probe failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
    );
  }
  return JSON.parse(proc.stdout.toString());
}

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — track spellings scope the lane the same way `wave-sequence` accepts
// them (ports CanonicalTrackTest's spellings onto the resolver's own surface,
// since the standalone `canonical_track` helper is retired — AC10)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-098 AC6 — every spelling 091 accepts resolves the same lane", () => {
  const TWO_TRACK = [entry("CR-NEXTPTR-100", 10, { track: "track-1" }), entry("CR-NEXTPTR-200", 20, { track: "track-2" })];

  const ACCEPTED = ["2", "track-2", "Track 2", "TRACK-2", "  2  ", "track-02", "1", "track-11"];

  test("every accepted spelling of track 2 answers CR-NEXTPTR-200, and 1/11 answer their own lanes or drain", () => {
    for (const spelling of ["2", "track-2", "Track 2", "TRACK-2", "  2  ", "track-02"]) {
      const answer = fields(TWO_TRACK, { track: spelling });
      expect(answer.decision, `--track ${JSON.stringify(spelling)}`).toBe("NEXT");
      expect(answer.cr).toBe("CR-NEXTPTR-200");
    }
    // "1" and "track-11" name lanes this fixture declares none of — awaiting-assignment,
    // never a match against track-1/track-2 by accident. Both are members of ACCEPTED
    // (091's accepted spellings) so this loop, together with the one above, exercises
    // every value ACCEPTED declares.
    for (const spelling of ACCEPTED.filter((s) => s === "1" || s === "track-11")) {
      const answer = fields(TWO_TRACK, { track: spelling });
      expect(answer.decision).toBe("DRAINED");
      expect(answer.reason).toBe("awaiting-assignment");
    }
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
});
