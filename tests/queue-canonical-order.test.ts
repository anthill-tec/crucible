// CR-CRU-095 §S1 — the SERVER publishes ONE canonical queue order. C1 RED tests.
//
// Covers AC1-AC5 and AC8 at the two boundaries that hold an ordering decision:
// `Store.listQueue` (the publisher) and the REST reads that consume it. §S2's
// warning scope (cycle 306), §S3's bulk-post defaulting (cycle 307) and the
// client (AC6 — `resolve_next` stays UNCHANGED) are NOT touched here.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `seq` is written on two scales and nothing orders across containers:
//
//   `wave-sequence` (authored)  waveSeqBase(wave) + index + 1   wave 5 -> 5001+
//   bulk queue post (defaulted) `declaredSeq ?? index`          wave 6 -> 62
//
// `listQueue` is `ORDER BY seq ASC` (src/store.ts:3465-3470) — ONE column, no
// container key — so a positional value from an unauthored wave sorts ahead of
// every authored wave. On the live board (94 rows, read 2026-09-02) that is not
// an edge case: 66 of 94 rows carry NO release at all, the 28 authored 0.2.0
// rows sit at seq 5001..5028, and the deferred wave-6 rows sit at 62/64/65 —
// so `next` answers CR-CRU-015 ahead of the entire active release.
//
// ── The seam GREEN must expose ────────────────────────────────────────────
//
// ONE comparator, shared. `compareVersionLabels` is already exported
// (src/store.ts:359) and a container comparator already exists as
// `compareContainers` (src/v2.ts:1927-1932, module-private); CR-091's comment
// on it warns that "a second one would order them differently". §S1 therefore
// LIFTS that one comparator so `listQueue` and the write-path warnings share
// it. This suite never imports it and never greps for it: AC2 is asserted as a
// BEHAVIOURAL agreement invariant (below), which is the only form that a
// second, independently-written comparator can actually fail.
//
// ── AC2, behaviourally ───────────────────────────────────────────────────
//
// The write path already PUBLISHES its container verdict: `cross-wave-backwards`
// fires exactly when a dependant's container sorts strictly BEFORE its
// dependency's (src/v2.ts:1995-2011). So for any pair of DISTINCT containers,
//
//     warning fires  <=>  the dependant precedes the dependency in listQueue
//
// is an invariant that holds iff both paths make the same decision. The corpus
// is chosen to be exactly where a re-implementation diverges: `0.3.0` vs
// `0.10.0` (numeric components, not codepoints), wave-leads-release, equal
// leading components with unequal lengths, componentless labels, and a declared
// release against an UNDECLARED one on both sides of it (wave 4 and wave 6).
// Each probe asserts the canonical verdict AND the agreement, because agreement
// alone would be satisfied by two paths that are wrong together.
//
// ── THE RULED ORDER: a SORT KEY, not a comparator (spec 6b35f46, §S1) ──────
//
// RED found the spec's own instruction self-defeating twice, and it was
// amended twice. What is pinned below is the second ruling:
//
//     (wave number, release version with an UNDECLARED release sorting LAST
//      within its wave, seq)
//
// Round 1 — `compareContainers` reads `a.release ?? ""`, and
// `compareVersionLabels("", "0.2.0")` is NEGATIVE (a label with FEWER numeric
// components sorts first, src/store.ts:365), so applied verbatim every
// release-LESS row sorts BEFORE every declared release — 66 of the live
// board's 94 rows, CR-CRU-015 among them — and AC7 would still fail. RED's
// proposal "every undeclared row sorts LAST (globally)" was OVERRULED: the
// same rule decides `cross-wave-backwards`, and measured against the live
// dependency graph it emits 15 FALSE warnings — every 0.2.0 cr depending on
// shipped wave-4 history reads as "depends backwards" (014 -> 011, 068 -> 066).
//
// Round 2 — the replacement (release when both declare, else wave) was PAIRWISE
// and RED proved it INTRANSITIVE: A = 0.3.0/5 seq 5004, B = undeclared/5 seq
// 5002, C = 0.10.0/5 seq 5001 gives A < C (release), C < B (seq), B < A (seq),
// a strict cycle, and Array.sort then returned three different orders across
// the six input permutations. Release-first has no transitive extension to an
// undeclared row — sentinel-first is the verbatim comparator, sentinel-last is
// the 15-false-warning rule, and the pairwise fallback was the attempt to dodge
// both. Wave-first HAS one: the queue has numbered its waves monotonically
// across releases since CR-CRU-014, which is the premise CR-091 §S4's seq-block
// arithmetic already rests on. So wave leads, release breaks a tie between two
// releases sharing a wave number (AC4), undeclared sorts last within its wave
// (declared work is scheduled; undeclared is not), and seq orders the
// container. AC1d pins the total order; AC1b/AC1c pin the warning measurement.
//
// Every store here is `:memory:` or an mkdtempSync scratch file, and every
// server is booted on an OS-assigned port. The live data/crucible.db and port
// 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { QueueEntryInput } from "../src/store.ts";
import type { QueueEntry } from "../src/types.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes (the routes test's, narrowed to what this suite reads) ─────

interface QueueEntryWire {
  cr: string;
  wave: string;
  seq: number;
  release?: string;
  status: string;
  [key: string]: unknown;
}

interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  project?: { key: string };
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  [key: string]: unknown;
}

// ── store-level helpers ────────────────────────────────────────────────────

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "canonical-order", type: "backend", sutRoot: "/tmp" });
  return key;
}

/** The PUBLISHED order, as a reader consumes it: cr ids, in array order. */
function publishedOrder(entries: Array<{ cr: string }>): string[] {
  return entries.map((entry) => entry.cr);
}

/** The span a set of crs occupies in the published order. */
function spanOf(order: string[], members: string[]): { first: number; last: number } {
  const positions = members.map((cr) => {
    const at = order.indexOf(cr);
    if (at === -1) throw new Error(`CR-CRU-095: ${cr} is absent from the published order`);
    return at;
  });
  return { first: Math.min(...positions), last: Math.max(...positions) };
}

/**
 * The oracle's candidate set, by the client's OWN two-axis rule
 * (`_is_actionable`, clients/_crucible_axi.py:1310-1319): PENDING on the
 * server-derived status axis AND carrying no `lifecycle` disposition, because
 * `deriveQueueStatus` cannot see `lifecycle` by signature, so a VOID cr with
 * no plan still reads PENDING. Modelled here rather than imported: AC6 keeps
 * the client UNCHANGED, so this suite may read its rule but never edit it.
 */
function firstActionable(entries: QueueEntry[]): QueueEntry | undefined {
  return entries.find((entry) => entry.status === "PENDING" && entry.lifecycle === undefined);
}

// ── THE BOARD SNAPSHOT — HISTORY, NOT A REQUIREMENT ────────────────────────
//
// A row-for-row transcription of THIS repository's own Crucible queue board
// (project `crucible`, the board `worktree-flow status` prints), read on
// 2026-09-02. It exists for ONE reason: this arrangement is what PRODUCED
// CR-CRU-095's reported defect — the oracle recommending deferred CR-CRU-015
// ahead of the entire active 0.2.0 release — and a synthetic id would have
// made that reproduction a fiction (CR-CRU-097 §S3).
//
// IT IS ALREADY OUT OF DATE, AND THAT IS CORRECT. On 2026-09-03 CR-CRU-097,
// 099 and 100 were sequenced into wave 5 and the declared block below moved
// from 5024..5028 to 5027..5031 — five of the nine pinned positions. Nobody
// may "fix" these numbers to match today's board: re-pinning them would only
// re-arm the same trap with a fresher date. The single thing this constant
// owes a reader is fidelity to 2026-09-02.
//
// Every assertion in this file that states a product RULE runs on synthetic
// ids instead (CR-CRU-097 §S5/AC4). Only the REPRODUCTION test reads this
// snapshot, and what it asserts is the reproduction, not the rule (AC5).
const BOARD_SNAPSHOT_2026_09_02 = {
  /**
   * The board's own two scales, in the order a real board acquired them: the
   * positional rows first (a bulk `queue-file` post that could not author a
   * release for a shipped or a deferred wave), the authored 0.2.0 block last.
   * Every cr id, wave, seq and disposition is a value read off the board.
   */
  rows: [
    { cr: "CR-CRU-009", wave: "4", dependsOn: [], seq: 8 },
    { cr: "CR-CRU-016", wave: "4", dependsOn: [], seq: 10 },
    { cr: "CR-CRU-011", wave: "4", dependsOn: [], seq: 12 },
    { cr: "CR-CRU-066", wave: "4", dependsOn: [], seq: 60 },
    { cr: "CR-CRU-015", wave: "6", dependsOn: [], seq: 62 },
    { cr: "CR-CRU-018", wave: "6", dependsOn: [], seq: 64 },
    { cr: "CR-CRU-022", wave: "6", dependsOn: [], seq: 65 },
    // Undeclared and at wave 5, so it sorts INSIDE wave 5 but AFTER every
    // declared row there, whatever its seq (AC1e). VOID on the board — the
    // second axis, which keeps it out of the candidate set without moving it
    // in the order.
    {
      cr: "CR-CRU-082",
      wave: "5",
      dependsOn: [],
      seq: 75,
      lifecycle: { state: "VOID", reason: "voided in the queue README", at: 1_788_338_086_125 },
    },
    // The board's second undeclared wave-5 row. COMPLETED there (a closed
    // plan with a merge commit); PENDING in this fixture, which changes
    // nothing it is asked about — it sorts after the declared block, so it
    // can never be the candidate the oracle reaches first.
    { cr: "CR-CRU-090", wave: "5", dependsOn: [], seq: 81 },
    { cr: "CR-CRU-095", wave: "5", dependsOn: [], seq: 5022, release: "0.2.0" },
    { cr: "CR-CRU-096", wave: "5", dependsOn: [], seq: 5023, release: "0.2.0" },
    { cr: "CR-CRU-079", wave: "5", dependsOn: [], seq: 5024, release: "0.2.0" },
    { cr: "CR-CRU-085", wave: "5", dependsOn: [], seq: 5025, release: "0.2.0" },
    { cr: "CR-CRU-093", wave: "5", dependsOn: [], seq: 5026, release: "0.2.0" },
    { cr: "CR-CRU-075", wave: "5", dependsOn: [], seq: 5027, release: "0.2.0" },
    { cr: "CR-CRU-094", wave: "5", dependsOn: [], seq: 5028, release: "0.2.0" },
  ] satisfies QueueEntryInput[],

  /**
   * `0.1.0`'s recorded `crs`. Waves 1-4 are SHIPPED history on that board,
   * which is why they carry no release (CR-091 §S6 refuses to plan a shipped
   * one) and why they are not candidates. Release membership is how the store
   * derives that without synthesising a plan (COMPLETED_UNTRACKED, CR-083 §S2).
   */
  shippedCrs: ["CR-CRU-009", "CR-CRU-016", "CR-CRU-011", "CR-CRU-066"],

  /**
   * What those rows publish under §S1's ruled key: wave leads, so the
   * undeclared shipped waves 1-4 come first (by seq); inside wave 5 the
   * DECLARED 0.2.0 block precedes the two undeclared rows regardless of their
   * lower seq; and the deferred undeclared wave 6 lands LAST.
   */
  publishedOrder: [
    "CR-CRU-009",
    "CR-CRU-016",
    "CR-CRU-011",
    "CR-CRU-066",
    "CR-CRU-095",
    "CR-CRU-096",
    "CR-CRU-079",
    "CR-CRU-085",
    "CR-CRU-093",
    "CR-CRU-075",
    "CR-CRU-094",
    "CR-CRU-082",
    "CR-CRU-090",
    "CR-CRU-015",
    "CR-CRU-018",
    "CR-CRU-022",
  ],

  /** The row the oracle must reach first — the defect said CR-CRU-015. */
  firstActionableCr: "CR-CRU-095",
  /** The 0.2.0 block's endpoints, for the span assertion. */
  releaseEnds: ["CR-CRU-095", "CR-CRU-094"],
  /** The deferred wave-6 block's endpoints — the rows that used to outrank it. */
  deferredEnds: ["CR-CRU-015", "CR-CRU-022"],
};

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-095 §S1 — listQueue publishes ONE canonical container order", () => {
  test(
    "REPRODUCTION (AC1/AC1a/AC7/AC17) — the 2026-09-02 board snapshot's MIXTURE: authored 0.2.0 " +
      "wave-5 rows at seq 5022..5028 beside DEFAULTED release-less wave-6 rows at seq 62/64/65 " +
      "publishes the 0.2.0 rows FIRST, so the oracle stops recommending the deferred wave-6 row",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // The arrangement that produced the defect, read off this project's own
      // board on 2026-09-02 and frozen in BOARD_SNAPSHOT_2026_09_02. This test
      // asserts the REPRODUCTION — that those exact rows no longer publish the
      // deferred work ahead of the release — never a product rule; the rules
      // live in the synthetic-id tests below (CR-CRU-097 §S5/AC4, AC5).
      store.replaceQueue(key, BOARD_SNAPSHOT_2026_09_02.rows);
      store.recordMilestoneEvent(key, "fixture-agent", "release", {
        label: "0.1.0",
        commit: "0000000000000000000000000000000000000001",
        releasedAt: 1_760_000_000,
        crs: BOARD_SNAPSHOT_2026_09_02.shippedCrs,
      });

      const entries = store.listQueue(key);

      // The whole canonical order, in one assertion, so the failure diff IS
      // the report.
      expect(publishedOrder(entries)).toEqual(BOARD_SNAPSHOT_2026_09_02.publishedOrder);

      // The oracle's recommendation, as the oracle derives it: the FIRST
      // actionable row of the published order (`actionable[0]`,
      // clients/_crucible_axi.py:1530). It must belong to the active release —
      // before §S1 the wave-6 deferred rows reached it first.
      expect(firstActionable(entries)?.release).toBe("0.2.0");
      expect(firstActionable(entries)?.cr).toBe(BOARD_SNAPSHOT_2026_09_02.firstActionableCr);

      // And the defect, named directly: no wave-6 row may outrank the release.
      const order = publishedOrder(entries);
      const release = spanOf(order, BOARD_SNAPSHOT_2026_09_02.releaseEnds);
      const deferred = spanOf(order, BOARD_SNAPSHOT_2026_09_02.deferredEnds);
      expect(release.last).toBeLessThan(deferred.first);
    },
  );

  test(
    "AC1a — an UNDECLARED row orders against a declared one by WAVE NUMBER: an undeclared " +
      "wave-4 row precedes a 0.2.0/wave-5 row and an undeclared wave-6 row follows it",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // Every seq contradicts the ruled order, so a seq-only read cannot pass
      // this by accident: the wave-4 row holds the HIGHEST positional value
      // (900) and the wave-6 row the lowest (62).
      store.replaceQueue(key, [
        { cr: "CR-UNDECLARED-W6", wave: "6", dependsOn: [], seq: 62 },
        { cr: "CR-UNDECLARED-W4", wave: "4", dependsOn: [], seq: 900 },
        { cr: "CR-DECLARED-W5", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
      ]);

      expect(publishedOrder(store.listQueue(key))).toEqual([
        "CR-UNDECLARED-W4",
        "CR-DECLARED-W5",
        "CR-UNDECLARED-W6",
      ]);
    },
  );

  test(
    "AC1d — the order is a TOTAL order: 0.3.0/5 seq 5004, undeclared/5 seq 5002 and 0.10.0/5 " +
      "seq 5001 publish as (0.3.0, 0.10.0, undeclared) from EVERY one of the six insertion " +
      "permutations — the pairwise rule this replaced returned three different orders",
    () => {
      // The exact triple RED used to prove the first ruling intransitive:
      // A < C by release, C < B and B < A by seq, a strict cycle. A KEY cannot
      // cycle, so the published order must not depend on insertion order — the
      // property a comparator-shaped rule silently loses.
      const rows: QueueEntryInput[] = [
        { cr: "CR-A-030", wave: "5", dependsOn: [], seq: 5004, release: "0.3.0" },
        { cr: "CR-B-UNDECLARED", wave: "5", dependsOn: [], seq: 5002 },
        { cr: "CR-C-0100", wave: "5", dependsOn: [], seq: 5001, release: "0.10.0" },
      ];
      const permutations: QueueEntryInput[][] = [
        [rows[0]!, rows[1]!, rows[2]!],
        [rows[0]!, rows[2]!, rows[1]!],
        [rows[1]!, rows[0]!, rows[2]!],
        [rows[1]!, rows[2]!, rows[0]!],
        [rows[2]!, rows[0]!, rows[1]!],
        [rows[2]!, rows[1]!, rows[0]!],
      ];

      const published = permutations.map((permutation) => {
        const store = new Store(":memory:");
        const key = seedProject(store);
        store.replaceQueue(key, permutation);
        return publishedOrder(store.listQueue(key));
      });

      // ONE answer, six times: declared before undeclared inside the wave, and
      // 0.3.0 before 0.10.0 on the release key.
      const expected = ["CR-A-030", "CR-C-0100", "CR-B-UNDECLARED"];
      expect(published).toEqual([expected, expected, expected, expected, expected, expected]);
    },
  );

  test(
    "AC1e — within ONE wave every declared row precedes every undeclared row regardless of seq: " +
      "undeclared -/5 at seq 75 AND at seq 6000 both follow the whole 0.2.0/5 block, and order " +
      "between themselves by seq",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // One undeclared row sits BELOW the block's seq range and one ABOVE it,
      // so seq alone cannot produce the ruled answer: the release key, not the
      // number, is what places them.
      store.replaceQueue(key, [
        { cr: "CR-UNDECLARED-LOW", wave: "5", dependsOn: [], seq: 75 },
        { cr: "CR-DECLARED-1", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-DECLARED-2", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-UNDECLARED-HIGH", wave: "5", dependsOn: [], seq: 6000 },
      ]);

      expect(publishedOrder(store.listQueue(key))).toEqual([
        "CR-DECLARED-1",
        "CR-DECLARED-2",
        "CR-UNDECLARED-LOW",
        "CR-UNDECLARED-HIGH",
      ]);
    },
  );

  test(
    "AC1 — the key is (wave, release, seq) on CONVENTION-CONFORMING data, where it equals " +
      "release-then-wave: 0.1.0/1 before 0.2.0/5 before 0.10.0/9, and 0.10.0 is LAST despite " +
      "sorting first by codepoint and holding the lowest positional seq",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // Monotonic waves across releases (the CR-014 convention §S1 rests on),
      // so wave-first and release-first agree — which is what AC1 asserts. The
      // SEQ values are the live board's real mixture: the old waves carry
      // positional values (12, 65) and only the active wave is authored (5001),
      // so a seq-only read gets this backwards.
      store.replaceQueue(key, [
        { cr: "CR-R100-W9", wave: "9", dependsOn: [], seq: 65, release: "0.10.0" },
        { cr: "CR-R001-W1", wave: "1", dependsOn: [], seq: 12, release: "0.1.0" },
        { cr: "CR-R020-W5-a", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-R020-W5-b", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
      ]);

      const entries = store.listQueue(key);

      // 0.10.0 is the LAST release, not the first: a codepoint compare of the
      // labels would put it before 0.2.0, which is the bug
      // `compareVersionLabels` exists to avoid (src/store.ts:344-353), and its
      // seq of 65 would put it second. Neither decides — the key does.
      expect(publishedOrder(entries)).toEqual([
        "CR-R001-W1",
        "CR-R020-W5-a",
        "CR-R020-W5-b",
        "CR-R100-W9",
      ]);
      // Ordering is the ONLY thing §S1 changes: every stored seq is republished
      // verbatim (CR-091 AC18 — `seq` never becomes a response index).
      expect(Object.fromEntries(entries.map((entry) => [entry.cr, entry.seq]))).toEqual({
        "CR-R001-W1": 12,
        "CR-R020-W5-a": 5001,
        "CR-R020-W5-b": 5002,
        "CR-R100-W9": 65,
      });
    },
  );

  test(
    "AC3 — inside ONE container the authored seq order is preserved EXACTLY: the wave-5 block " +
      "authored 5001..5005 keeps that relative order while only the BETWEEN-container order moves",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      const authored = [
        "CR-AUTH-1",
        "CR-AUTH-2",
        "CR-AUTH-3",
        "CR-AUTH-4",
        "CR-AUTH-5",
      ];
      // The authored block is posted SHUFFLED — array position is not the
      // authored order here; `seq` is, exactly as `wave-sequence` wrote it.
      store.replaceQueue(key, [
        { cr: "CR-DEFERRED", wave: "6", dependsOn: [], seq: 62 },
        { cr: "CR-AUTH-3", wave: "5", dependsOn: [], seq: 5003, release: "0.2.0" },
        { cr: "CR-AUTH-1", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-AUTH-5", wave: "5", dependsOn: [], seq: 5005, release: "0.2.0" },
        { cr: "CR-AUTH-2", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-AUTH-4", wave: "5", dependsOn: [], seq: 5004, release: "0.2.0" },
        { cr: "CR-EARLIER", wave: "1", dependsOn: [], seq: 1001, release: "0.1.0" },
      ]);

      const order = publishedOrder(store.listQueue(key));

      // The container's own order: 5001..5005, unchanged and uninterleaved.
      expect(order.filter((cr) => authored.includes(cr))).toEqual(authored);
      // ...and it is a CONTIGUOUS block, so no cross-container reorder walked
      // through the middle of an authored wave.
      const block = spanOf(order, authored);
      expect(block.last - block.first).toBe(authored.length - 1);
      // The between-container move is the only change: 0.1.0, then 0.2.0's
      // block, then the undeclared deferred row.
      expect(order).toEqual(["CR-EARLIER", ...authored, "CR-DEFERRED"]);
    },
  );

  test(
    "AC4 — two releases sharing wave NUMBER 5 order by RELEASE VERSION and never tie: 0.3.0's " +
      "whole block precedes 0.10.0's even though both hold seq 5001 and 5002",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // CR-091 §S4/§S8 tolerates the shared seq block precisely because "the
      // ordering anomaly is confined to a comparison across releases that no
      // read makes" (src/store.ts:386-392). This read makes it.
      store.replaceQueue(key, [
        { cr: "CR-R010-a", wave: "5", dependsOn: [], seq: 5001, release: "0.10.0" },
        { cr: "CR-R010-b", wave: "5", dependsOn: [], seq: 5002, release: "0.10.0" },
        { cr: "CR-R030-a", wave: "5", dependsOn: [], seq: 5001, release: "0.3.0" },
        { cr: "CR-R030-b", wave: "5", dependsOn: [], seq: 5002, release: "0.3.0" },
      ]);

      const order = publishedOrder(store.listQueue(key));

      expect(order).toEqual(["CR-R030-a", "CR-R030-b", "CR-R010-a", "CR-R010-b"]);
      // "never tie" as a property, not just as a happy array: the two blocks
      // are disjoint and 0.3.0's ends before 0.10.0's begins.
      const lower = spanOf(order, ["CR-R030-a", "CR-R030-b"]);
      const higher = spanOf(order, ["CR-R010-a", "CR-R010-b"]);
      expect(lower.last).toBeLessThan(higher.first);
    },
  );

  test(
    "AC5 — a wave cell carrying NO integer takes block 0 and still orders deterministically: it " +
      "precedes wave 1 of its release, two such cells order by seq, and repeated reads agree",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // `waveSeqBase` reads the LEADING integer and gives a cell without one
      // block 0 (src/store.ts:396-405), so block 0 sorts before wave 1 — and
      // the two block-0 cells, being one container for ordering purposes, fall
      // through to seq. The seq values here deliberately contradict that: a
      // seq-only read puts both block-0 rows LAST.
      store.replaceQueue(key, [
        { cr: "CR-W1", wave: "1", dependsOn: [], seq: 1001, release: "0.2.0" },
        { cr: "CR-W2", wave: "2", dependsOn: [], seq: 2001, release: "0.2.0" },
        { cr: "CR-BACKLOG", wave: "backlog", dependsOn: [], seq: 5555, release: "0.2.0" },
        { cr: "CR-SOMEDAY", wave: "someday", dependsOn: [], seq: 6000, release: "0.2.0" },
      ]);

      const expected = ["CR-BACKLOG", "CR-SOMEDAY", "CR-W1", "CR-W2"];
      expect(publishedOrder(store.listQueue(key))).toEqual(expected);

      // Deterministic, not merely "some order": three reads, one answer.
      expect(publishedOrder(store.listQueue(key))).toEqual(expected);
      expect(publishedOrder(store.listQueue(key))).toEqual(expected);
    },
  );
});

describe("CR-CRU-095 §S1 — the READS consume the published order verbatim (AC8)", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru095-order-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await send("POST", path, body);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await send("GET", path);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  const ORCH = "orchestrator-1";

  /** A project and the one caller the roadmap verbs' role gate accepts. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    expect(created.status).toBe(200);
    const key = created.body.project!.key;
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key;
  }

  test(
    "AC8 — the POST /queue reply and GET /queue both carry the CANONICAL order, and neither " +
      "reader re-derives it: an undeclared wave-5 row at seq 5001 precedes an undeclared " +
      "wave-6 row at seq 62",
    async () => {
      boot();
      const key = await seed("ac8-wire-order");

      // Both rows are undeclared — one container axis left, the wave number —
      // so a seq-only read inverts them.
      const posted = await post(`/api/v2/projects/${key}/queue`, {
        agentId: ORCH,
        entries: [
          { cr: "CR-WIRE-W6", wave: 6, dependsOn: [], seq: 62 },
          { cr: "CR-WIRE-W5", wave: 5, dependsOn: [], seq: 5001 },
        ],
      });
      expect(posted.status).toBe(200);
      // The write's own reply is a READER too (src/v2.ts:1870).
      expect(publishedOrder(posted.body.entries!)).toEqual(["CR-WIRE-W5", "CR-WIRE-W6"]);

      const read = await get(`/api/v2/projects/${key}/queue`);
      expect(read.status).toBe(200);
      expect(publishedOrder(read.body.entries!)).toEqual(["CR-WIRE-W5", "CR-WIRE-W6"]);
    },
  );

  test(
    "AC8 — GET /queue is byte-for-byte the order the store published, on a two-scale mixture " +
      "(declared 0.2.0/5 at 5023..5024 beside undeclared /6 at 62/64): the reader adds no " +
      "ordering of its own (CR-091 AC18 regression)",
    async () => {
      const booted = boot();
      const key = await seed("ac8-no-rederivation");

      // The two-scale SHAPE the 2026-09-02 board carried — a declared release
      // block on the wave-block scale beside deferred rows on the legacy
      // positional one — on synthetic ids: what is under test is the RULE that
      // the reader re-derives nothing (CR-CRU-097 §S5/AC4).
      // Declarations ride the store directly: POST /queue carries no `release`
      // (src/v2.ts:1848-1859), and this test is about the READ, not the verb.
      booted.store.replaceQueue(key, [
        { cr: "CR-UNDECLARED-W6-A", wave: "6", dependsOn: [], seq: 62 },
        { cr: "CR-UNDECLARED-W6-B", wave: "6", dependsOn: [], seq: 64 },
        { cr: "CR-DECLARED-W5-A", wave: "5", dependsOn: [], seq: 5023, release: "0.2.0" },
        { cr: "CR-DECLARED-W5-B", wave: "5", dependsOn: [], seq: 5024, release: "0.2.0" },
      ]);

      const canonical = [
        "CR-DECLARED-W5-A",
        "CR-DECLARED-W5-B",
        "CR-UNDECLARED-W6-A",
        "CR-UNDECLARED-W6-B",
      ];
      const published = publishedOrder(booted.store.listQueue(key));
      const read = await get(`/api/v2/projects/${key}/queue`);
      expect(read.status).toBe(200);

      expect(published).toEqual(canonical);
      expect(publishedOrder(read.body.entries!)).toEqual(published);
    },
  );

  // ── AC1b / AC1c — the measurement the ruling rests on ─────────────────────

  test(
    "AC1b — a DECLARED row depending on an UNDECLARED row of a LOWER wave (shipped history) " +
      "emits NO cross-wave-backwards: two such edges warn zero times",
    async () => {
      boot();
      const key = await seed("ac1b-shipped-history");

      // The SHAPE the ruling was measured against: a wave-4 dependency cannot
      // be declared at all (CR-091 §S6 refuses to plan a shipped release),
      // which is exactly why "undeclared sorts last" produced 15 false
      // warnings when it was measured on this project's own dependency graph
      // on 2026-09-02 (the real edges were CR-014 -> CR-011 and CR-068 ->
      // CR-066). The rule is id-independent, so the rows are synthetic
      // (CR-CRU-097 §S5/AC4); the measurement stays in this comment.
      const seeded = await post(`/api/v2/projects/${key}/queue`, {
        agentId: ORCH,
        entries: [
          { cr: "CR-SHIPPED-W4-A", wave: 4, dependsOn: [], seq: 12 },
          { cr: "CR-SHIPPED-W4-B", wave: 4, dependsOn: [], seq: 60 },
          { cr: "CR-DEPENDANT-A", wave: 5, dependsOn: ["CR-SHIPPED-W4-A"], seq: 5001 },
          { cr: "CR-DEPENDANT-B", wave: 5, dependsOn: ["CR-SHIPPED-W4-B"], seq: 5003 },
        ],
      });
      expect(seeded.status).toBe(200);
      const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
        agentId: ORCH,
        label: "0.2.0",
      });
      expect(proposed.status).toBe(200);

      for (const cr of ["CR-DEPENDANT-A", "CR-DEPENDANT-B"]) {
        const planned = await post(`/api/v2/projects/${key}/queue/plan`, {
          agentId: ORCH,
          cr,
          release: "0.2.0",
          wave: 5,
          title: `${cr} depends on shipped history`,
        });
        expect(planned.status).toBe(200);
        expect(
          (planned.body.warnings ?? []).filter((w) => w.code === "cross-wave-backwards"),
        ).toEqual([]);
      }

      // ...and the same comparator puts that history BEFORE the release.
      expect(publishedOrder((await get(`/api/v2/projects/${key}/queue`)).body.entries!)).toEqual([
        "CR-SHIPPED-W4-A",
        "CR-SHIPPED-W4-B",
        "CR-DEPENDANT-A",
        "CR-DEPENDANT-B",
      ]);
    },
  );

  test(
    "AC1c — a DECLARED row depending on an UNDECLARED row of a HIGHER wave (deferred work) " +
      "DOES emit cross-wave-backwards, naming both containers",
    async () => {
      boot();
      const key = await seed("ac1c-deferred-backwards");

      const seeded = await post(`/api/v2/projects/${key}/queue`, {
        agentId: ORCH,
        entries: [
          { cr: "CR-DEFERRED-W6", wave: 6, dependsOn: [], seq: 62 },
          { cr: "CR-DECLARED-W5", wave: 5, dependsOn: ["CR-DEFERRED-W6"], seq: 5023 },
        ],
      });
      expect(seeded.status).toBe(200);
      const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
        agentId: ORCH,
        label: "0.2.0",
      });
      expect(proposed.status).toBe(200);

      const planned = await post(`/api/v2/projects/${key}/queue/plan`, {
        agentId: ORCH,
        cr: "CR-DECLARED-W5",
        release: "0.2.0",
        wave: 5,
        title: "depends on deferred work",
      });
      expect(planned.status).toBe(200);

      const warning = (planned.body.warnings ?? []).find(
        (w) => w.code === "cross-wave-backwards",
      );
      expect(warning).toBeDefined();
      // CR-091's shape, reused verbatim: the CONTAINERS, not the two crs, and
      // an undeclared container renders as `-/<wave>` (src/v2.ts:1911-1913).
      expect(warning!.containers).toEqual(["0.2.0/5", "-/6"]);
      expect(warning!.crs).toBeUndefined();
    },
  );

  // ── AC2 — ONE comparator, asserted as an agreement invariant ──────────────

  interface ContainerSpec {
    release?: string;
    wave: string;
  }

  interface Probe {
    label: string;
    /** The dependant's container. Always declared: `cr-plan` writes it. */
    dependant: ContainerSpec & { release: string };
    dependency: ContainerSpec;
    /** The canonical verdict: does the dependant's container sort BEFORE? */
    dependantFirst: boolean;
    why: string;
  }

  const probes: Probe[] = [
    {
      label: "0.3.0/5 vs 0.10.0/5",
      dependant: { release: "0.3.0", wave: "5" },
      dependency: { release: "0.10.0", wave: "5" },
      dependantFirst: true,
      why: "numeric components, not codepoints: 0.3.0 precedes 0.10.0",
    },
    {
      label: "0.10.0/1 vs 0.2.0/9",
      dependant: { release: "0.10.0", wave: "1" },
      dependency: { release: "0.2.0", wave: "9" },
      dependantFirst: true,
      why:
        "the WAVE key leads and the release key only breaks a tie WITHIN a wave, so 0.10.0/1 " +
        "precedes 0.2.0/9 — data that violates the monotonic-wave convention, kept because the " +
        "agreement invariant must hold on it too",
    },
    {
      label: "0.2.0/4 vs 0.2.0/5",
      dependant: { release: "0.2.0", wave: "4" },
      dependency: { release: "0.2.0", wave: "5" },
      dependantFirst: true,
      why: "one release orders by wave number (CR-091's own cross-wave case)",
    },
    {
      label: "0.2/5 vs 0.2.1/5",
      dependant: { release: "0.2", wave: "5" },
      dependency: { release: "0.2.1", wave: "5" },
      dependantFirst: true,
      why: "equal leading components: the SHORTER label sorts first",
    },
    {
      label: "nightly/1 vs main/1",
      dependant: { release: "nightly", wave: "1" },
      dependency: { release: "main", wave: "1" },
      dependantFirst: false,
      why: "componentless labels fall back to a codepoint compare: main, then nightly",
    },
    {
      label: "0.2.0/5 vs an UNDECLARED release at wave 6",
      dependant: { release: "0.2.0", wave: "5" },
      dependency: { wave: "6" },
      dependantFirst: true,
      why:
        "THE LIVE BOARD'S CASE — either side undeclared, so WAVE decides: the active release " +
        "precedes deferred work (AC1c warns on this very edge)",
    },
    {
      label: "0.2.0/5 vs an UNDECLARED release at wave 4",
      dependant: { release: "0.2.0", wave: "5" },
      dependency: { wave: "4" },
      dependantFirst: false,
      why:
        "the ruling's other half — shipped history at a LOWER wave precedes the active " +
        "release, and AC1b's zero warnings are the same decision seen from the write path",
    },
  ];

  const DEPENDANT = "CR-DEPENDANT";
  const DEPENDENCY = "CR-DEPENDENCY";

  for (const probe of probes) {
    test(
      `AC2 — ONE comparator: ${probe.label} — the cross-wave-backwards verdict the write path ` +
        `publishes AGREES with the order listQueue publishes (${probe.why})`,
      async () => {
        boot();
        const key = await seed(`ac2-${probe.label.replace(/[^a-z0-9]+/gi, "-")}`);

        // Seeded in the REVERSE of the canonical order, so the positional seq
        // this bulk post assigns contradicts the container order and cannot
        // make the canonical assertion pass by accident.
        const rows: Array<Record<string, unknown>> = probe.dependantFirst
          ? [
              { cr: DEPENDENCY, wave: probe.dependency.wave, dependsOn: [] },
              { cr: DEPENDANT, wave: probe.dependant.wave, dependsOn: [DEPENDENCY] },
            ]
          : [
              { cr: DEPENDANT, wave: probe.dependant.wave, dependsOn: [DEPENDENCY] },
              { cr: DEPENDENCY, wave: probe.dependency.wave, dependsOn: [] },
            ];
        const seeded = await post(`/api/v2/projects/${key}/queue`, { agentId: ORCH, entries: rows });
        expect(seeded.status).toBe(200);

        // The labels this probe must propose: both, unless they are one.
        const labels =
          probe.dependency.release === undefined ||
          probe.dependency.release === probe.dependant.release
            ? [probe.dependant.release]
            : [probe.dependant.release, probe.dependency.release];
        for (const label of labels) {
          const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
            agentId: ORCH,
            label,
          });
          expect(proposed.status).toBe(200);
        }

        // The dependency is planned FIRST so its container is already definite
        // when the dependant's write computes the verdict.
        if (probe.dependency.release !== undefined) {
          const plannedDependency = await post(`/api/v2/projects/${key}/queue/plan`, {
            agentId: ORCH,
            cr: DEPENDENCY,
            release: probe.dependency.release,
            wave: probe.dependency.wave,
            title: "the dependency",
          });
          expect(plannedDependency.status).toBe(200);
        }

        const plannedDependant = await post(`/api/v2/projects/${key}/queue/plan`, {
          agentId: ORCH,
          cr: DEPENDANT,
          release: probe.dependant.release,
          wave: probe.dependant.wave,
          title: "the dependant",
        });
        expect(plannedDependant.status).toBe(200);

        // The write path's container verdict, as it publishes it.
        const writeSaysDependantFirst = (plannedDependant.body.warnings ?? []).some(
          (warning) => warning.code === "cross-wave-backwards",
        );

        const order = publishedOrder((await get(`/api/v2/projects/${key}/queue`)).body.entries!);
        const readSaysDependantFirst = order.indexOf(DEPENDANT) < order.indexOf(DEPENDENCY);

        // AC2 — the invariant: BOTH paths decided the same container order.
        // Two comparators that disagree anywhere in this corpus fail here,
        // which is what makes "no second comparator" checkable behaviourally.
        expect(writeSaysDependantFirst).toBe(readSaysDependantFirst);
        // ...and the shared decision is the CANONICAL one (AC1/AC4/AC5), so
        // two paths that are wrong TOGETHER do not satisfy the pair.
        expect(readSaysDependantFirst).toBe(probe.dependantFirst);
      },
    );
  }
});
