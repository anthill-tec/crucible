// CR-CRU-095 §S3 — the bulk post defaults a seq-less, snapshot-less row INTO ITS OWN WAVE BLOCK.
// C3 RED (cycle 307).
//
// Covers AC12 (values AND order), AC13, AC14, AC15, the §S2 interaction guard
// and the non-integer wave, at the two boundaries that hold the default:
// `Store.replaceQueue` (the writer) and the bulk queue route that fronts it.
// §S1 (`listQueue` / `compareQueueOrder`, C1) and §S2 (`upsertQueueEntry` /
// `defaultedSeqWarnings`, C2) are consumed here as guards and never re-pinned.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `replaceQueue` writes `declaredSeq ?? index` (src/store.ts:3498), where
// `declaredSeq = entry.seq ?? snapshot?.seq` (:3476). A declared seq wins, a
// HELD seq survives a re-import (CR-091 carry-forward), and a row with NEITHER
// takes its ARRAY POSITION in the post — 0..93 on the live board. That value
// is on a different scale from `wave-sequence`'s `waveSeqBase(wave) + n`
// blocks, and the board keeps GENERATING that mixture on every fresh import
// and on every row added later.
//
// ── The seam GREEN must expose ────────────────────────────────────────────
//
// The fallback becomes THE NEXT FREE SLOT in the row's own wave block (spec
// 0d3d3c3, ruled 2026-09-02 after this RED asked): rows are processed in
// post order, and a seq-less, snapshot-less row takes `max(seq already held
// or assigned in that wave AND inside its block) + 1`, or `waveSeqBase(wave)
// + 1` when the block is empty. For an all-defaulted wave (a fresh import)
// that is exactly `base + position`, mirroring `wave-sequence`'s `base +
// index + 1` (src/store.ts:3733/3749); for a wave already holding an
// authored block, a row added later is APPENDED after it (AC12a) — never a
// collision, never a disturbed authored order. A held value OUTSIDE the block
// (legacy positional `62`) does not count toward the slot (AC12b) — the next
// row lands at `6001`, the wave then holds two scales, and CR-091's
// pre-existing same-wave `defaulted-seq` fires for it, truthfully. Overflow
// is REFUSED with `wave-sequence`'s own message, never spilled (AC12c).
// Nothing else moves: a declared seq still wins, a held seq still survives a
// re-post that omits it (§S3: "does not retroactively fix an existing
// board"), and `wave-sequence` is untouched.
//
// `waveSeqBase` is exported from src/store.ts beside `waveNumber` and
// `WAVE_SEQ_STRIDE` (§S3), so this suite consumes the store's one arithmetic
// rather than re-deriving `waveNumber × WAVE_SEQ_STRIDE`.
//
// Every store here is `:memory:`, every server boots on an OS-assigned port
// against an mkdtempSync scratch db. The live data/crucible.db and port 3849
// are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, WAVE_SEQ_STRIDE, compareQueueOrder, inWaveBlock, waveSeqBase } from "../src/store.ts";
import type { QueueEntryInput } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes (the routes test's, narrowed to what this suite reads) ─────

interface QueueEntryWire {
  cr: string;
  wave: string;
  seq: number;
  release?: string;
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
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";

/** §S2's one predicate (`inWaveBlock`, src/store.ts:462-465), imported rather than re-derived. */
function expectInBlock(cr: string, wave: string, seq: number | undefined): void {
  expect(seq, `${cr} (wave ${JSON.stringify(wave)}) has no seq`).toBeDefined();
  expect(
    inWaveBlock(seq!, wave),
    `${cr} (wave ${JSON.stringify(wave)}) seq ${seq} is outside its block ` +
      `(${waveSeqBase(wave)}, ${waveSeqBase(wave) + WAVE_SEQ_STRIDE})`,
  ).toBe(true);
}

/**
 * §S3 — the value every row of an ALL-DEFAULTED post must take: its wave's
 * block base plus its 1-based position among the rows of that wave in the
 * post. Only used on posts where NO row declares or holds a seq, so the
 * position counter has exactly one reading (see the spec silence recorded
 * in the "row added later" test below).
 */
function expectedInBlockSeqs(rows: Array<{ cr: string; wave: string }>): Map<string, number> {
  const positions = new Map<string, number>();
  const expected = new Map<string, number>();
  for (const row of rows) {
    const position = (positions.get(row.wave) ?? 0) + 1;
    positions.set(row.wave, position);
    expected.set(row.cr, waveSeqBase(row.wave) + position);
  }
  return expected;
}

/**
 * AC12 fixture A — a small multi-wave board whose post order INTERLEAVES
 * waves, so a row's position within its wave differs from its array index
 * (the third row of wave 4 sits at index 6 and must take 4003, not 6). The
 * three "backlog" rows carry no integer and belong to block 0 (AC5 seen from
 * the write side): they sit LAST in the post so their array indices (8, 9,
 * 10) can never coincide with the in-block values `1, 2, 3`.
 */
function multiWaveBoard(): Array<{ cr: string; wave: string }> {
  return [
    { cr: "CR-W1-A", wave: "1" },
    { cr: "CR-W2-A", wave: "2" },
    { cr: "CR-W1-B", wave: "1" },
    { cr: "CR-W4-A", wave: "4" },
    { cr: "CR-W4-B", wave: "4" },
    { cr: "CR-W2-B", wave: "2" },
    { cr: "CR-W4-C", wave: "4" },
    { cr: "CR-W1-C", wave: "1" },
    { cr: "CR-BACKLOG-A", wave: "backlog" },
    { cr: "CR-BACKLOG-B", wave: "backlog" },
    { cr: "CR-BACKLOG-C", wave: "backlog" },
  ];
}

/** The README's wave grouping of `multiWaveBoard`: lane 0 first, then 1, 2, 4, post order within a lane. */
const MULTI_WAVE_README_ORDER = [
  "CR-BACKLOG-A",
  "CR-BACKLOG-B",
  "CR-BACKLOG-C",
  "CR-W1-A",
  "CR-W1-B",
  "CR-W1-C",
  "CR-W2-A",
  "CR-W2-B",
  "CR-W4-A",
  "CR-W4-B",
  "CR-W4-C",
];

/**
 * AC12 fixture B — the live board's SHAPE (read 2026-09-02, C2's fixture):
 * 53 shipped rows in waves 1-4, 13 deferred rows in wave 6, 28 rows in wave 5
 * that `wave-sequence` later authors. Ids are synthetic; the counts are the
 * board's. Posted FRESH with neither seq nor release on any row.
 */
function liveBoardShape(): {
  shipped: Array<{ cr: string; wave: string }>;
  deferred: Array<{ cr: string; wave: string }>;
  authored: string[];
} {
  const shipped = Array.from({ length: 53 }, (_, index) => ({
    cr: `CR-SHIPPED-${String(index + 1).padStart(2, "0")}`,
    wave: String((index % 4) + 1),
  }));
  const deferred = Array.from({ length: 13 }, (_, index) => ({
    cr: `CR-DEFERRED-${String(index + 1).padStart(2, "0")}`,
    wave: "6",
  }));
  const authored = Array.from(
    { length: 28 },
    (_, index) => `CR-AUTHORED-${String(index + 1).padStart(2, "0")}`,
  );
  return { shipped, deferred, authored };
}

function liveBoardRows(): Array<{ cr: string; wave: string }> {
  const board = liveBoardShape();
  return [...board.shipped, ...board.deferred, ...board.authored.map((cr) => ({ cr, wave: "5" }))];
}

// ── store-level helpers ────────────────────────────────────────────────────

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "default-into-wave-block", type: "backend", sutRoot: "/tmp" });
  return key;
}

function seqOf(store: Store, key: string): Map<string, number> {
  return new Map(store.listQueue(key).map((entry) => [entry.cr, entry.seq]));
}

function seqless(rows: Array<{ cr: string; wave: string }>): QueueEntryInput[] {
  return rows.map((row) => ({ cr: row.cr, wave: row.wave, dependsOn: [] }));
}

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-095 §S3 — the STORE defaults a seq-less, snapshot-less row into its OWN wave block", () => {
  test(
    "AC12 (values) — a fresh import of an interleaved multi-wave board lands EVERY row inside " +
      "its own wave's block at base + 1-based position within the wave (today: the array index)",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const rows = multiWaveBoard();

      store.replaceQueue(key, seqless(rows));

      const seqs = seqOf(store, key);
      for (const row of rows) expectInBlock(row.cr, row.wave, seqs.get(row.cr));
      // One row per wave, with the exact value, so the failure diff names the
      // scale: today CR-W4-C is 6 (its array index), never 4003.
      expect(seqs.get("CR-W1-A")).toBe(1001);
      expect(seqs.get("CR-W2-B")).toBe(2002);
      expect(seqs.get("CR-W4-C")).toBe(4003);
      expect(seqs).toEqual(expectedInBlockSeqs(rows));
    },
  );

  test(
    "AC12 (order) — within one wave the post's relative order IS the relative seq order inside " +
      "the block, and listQueue publishes exactly compareQueueOrder over those in-block values — " +
      "the README's wave grouping",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const rows = multiWaveBoard();

      store.replaceQueue(key, seqless(rows));
      const entries = store.listQueue(key);

      // Wave 4's three rows, in post order, take 4001 < 4002 < 4003.
      const wave4 = entries.filter((entry) => entry.wave === "4").map((entry) => entry.seq);
      expect(wave4).toEqual([4001, 4002, 4003]);
      const wave1 = entries.filter((entry) => entry.wave === "1").map((entry) => entry.seq);
      expect(wave1).toEqual([1001, 1002, 1003]);
      // The published order is the canonical key over the in-block values —
      // no reader has to re-derive anything.
      const published = entries.map((entry) => entry.cr);
      expect(published).toEqual([...entries].sort(compareQueueOrder).map((entry) => entry.cr));
      expect(published).toEqual(MULTI_WAVE_README_ORDER);
    },
  );

  test(
    "AC12 (fixture B) — a FRESH import of the live board's 94-row shape lands every row in-block: " +
      "waves 1-4 at 1001+/2001+/3001+/4001+, wave 5 at 5001+, wave 6 at 6001+ (today: 0..93)",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const rows = liveBoardRows();
      expect(rows).toHaveLength(94);

      const report = store.replaceQueue(key, seqless(rows));

      const seqs = seqOf(store, key);
      expect(seqs.size).toBe(94);
      for (const row of rows) expectInBlock(row.cr, row.wave, seqs.get(row.cr));
      // One row per wave, exact: the first row of each lane in the post.
      expect(seqs.get("CR-SHIPPED-01")).toBe(1001); // wave 1, position 1 (index 0)
      expect(seqs.get("CR-SHIPPED-02")).toBe(2001); // wave 2, position 1 (index 1)
      expect(seqs.get("CR-SHIPPED-03")).toBe(3001); // wave 3, position 1 (index 2)
      expect(seqs.get("CR-SHIPPED-04")).toBe(4001); // wave 4, position 1 (index 3)
      expect(seqs.get("CR-SHIPPED-53")).toBe(1014); // wave 1, position 14 (index 52)
      expect(seqs.get("CR-DEFERRED-01")).toBe(6001); // wave 6, position 1 (index 53)
      expect(seqs.get("CR-DEFERRED-13")).toBe(6013); // wave 6, position 13 (index 65)
      expect(seqs.get("CR-AUTHORED-01")).toBe(5001); // wave 5, position 1 (index 66)
      expect(seqs.get("CR-AUTHORED-28")).toBe(5028); // wave 5, position 28 (index 93)
      expect(seqs).toEqual(expectedInBlockSeqs(rows));
      // §S2 interaction: every defaulted row is in scale with its siblings.
      expect(report.defaultedSeq).toEqual([]);
    },
  );

  test(
    "AC12d — a wave cell carrying no integer takes block 0 (waveNumber 0), so its rows default " +
      "to 1, 2, 3 in post order (AC5 from the write side)",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        // Two integer-wave rows FIRST, so the backlog rows sit at indices
        // 2, 3, 4 and the array-index fallback cannot pass by coincidence.
        { cr: "CR-W3-A", wave: "3", dependsOn: [] },
        { cr: "CR-W3-B", wave: "3", dependsOn: [] },
        { cr: "CR-TBD-A", wave: "TBD", dependsOn: [] },
        { cr: "CR-TBD-B", wave: "TBD", dependsOn: [] },
        { cr: "CR-TBD-C", wave: "TBD", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      expect(waveSeqBase("TBD")).toBe(0);
      expect([seqs.get("CR-TBD-A"), seqs.get("CR-TBD-B"), seqs.get("CR-TBD-C")]).toEqual([
        1, 2, 3,
      ]);
      expect([seqs.get("CR-W3-A"), seqs.get("CR-W3-B")]).toEqual([3001, 3002]);
      // Block 0 sorts first under the canonical key (C1 AC5), unchanged here.
      expect(store.listQueue(key).map((entry) => entry.cr)).toEqual([
        "CR-TBD-A",
        "CR-TBD-B",
        "CR-TBD-C",
        "CR-W3-A",
        "CR-W3-B",
      ]);
    },
  );

  test(
    "AC13 — CARRY-FORWARD GUARD (authored): a row holding an authored 5001/5002 keeps it across a " +
      "re-post that omits seq; §S3 governs only rows with neither a declared nor a held seq",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // The bootstrap, then wave 5 authored by `wave-sequence` itself.
      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [] },
        { cr: "CR-D", wave: "6", dependsOn: [] },
      ]);
      store.upsertQueueEntry(key, { cr: "CR-A", release: "0.2.0", wave: "5", title: "a" });
      store.upsertQueueEntry(key, { cr: "CR-B", release: "0.2.0", wave: "5", title: "b" });
      store.sequenceQueueWave(key, { release: "0.2.0", wave: "5", crs: ["CR-B", "CR-A"] });
      const before = seqOf(store, key);
      expect([before.get("CR-B"), before.get("CR-A")]).toEqual([5001, 5002]);

      // The re-post the orchestrator runs on every README edit: no seq, no
      // release, same rows.
      const report = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [] },
        { cr: "CR-D", wave: "6", dependsOn: [] },
      ]);

      const after = seqOf(store, key);
      // The authored order survives — NOT re-defaulted to post order (A then B).
      expect([after.get("CR-B"), after.get("CR-A")]).toEqual([5001, 5002]);
      // Every held value is carried forward, whatever scale the first post chose.
      expect(after).toEqual(before);
      expect(report.defaultedSeq).toEqual([]);
    },
  );

  test(
    "AC13 — CARRY-FORWARD GUARD (legacy positional): a row that HOLDS a positional 62 keeps it " +
      "across a seq-less re-post — §S3 does NOT retroactively fix an existing board",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // A board that already stores positional values, as every pre-§S3
      // board does: the values are DECLARED here to stand in for what an
      // earlier import wrote. The SHAPE (a wave-6 pair at 62/64 and a wave-4
      // row at 7) is the pre-§S3 arrangement this project's own board carried;
      // the rule under test is id-independent, so the rows are synthetic
      // (CR-CRU-097 §S5/AC4).
      store.replaceQueue(key, [
        { cr: "CR-W6-A", wave: "6", dependsOn: [], seq: 62 },
        { cr: "CR-W6-B", wave: "6", dependsOn: [], seq: 64 },
        { cr: "CR-W4-L", wave: "4", dependsOn: [], seq: 7 },
      ]);
      expect(seqOf(store, key).get("CR-W6-A")).toBe(62);

      const report = store.replaceQueue(key, [
        { cr: "CR-W6-A", wave: "6", dependsOn: [] },
        { cr: "CR-W6-B", wave: "6", dependsOn: [] },
        { cr: "CR-W4-L", wave: "4", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      expect(seqs.get("CR-W6-A")).toBe(62);
      expect(seqs.get("CR-W6-B")).toBe(64);
      expect(seqs.get("CR-W4-L")).toBe(7);
      // Nothing was chosen, so nothing is named (one scale per wave).
      expect(report.defaultedSeq).toEqual([]);
    },
  );

  test(
    "AC12a — a row ADDED LATER to a wave holding an authored block is APPENDED after it (the " +
      "next free in-block slot), never collides, and the authored values are untouched: held " +
      "5001, 5002 + a seq-less row placed MID-POST -> 5003",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-C", wave: "6", dependsOn: [], seq: 6001 },
      ]);

      // The README gained one row in wave 5 — inserted BETWEEN the authored
      // ones, so neither "whole-post position" (-> 5002, colliding with
      // CR-B) nor "defaulted-only counter" (-> 5001, colliding with CR-A)
      // can pass — and one in wave 6.
      const report = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-NEW-5", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [] },
        { cr: "CR-NEW-6", wave: "6", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      expect([seqs.get("CR-A"), seqs.get("CR-B"), seqs.get("CR-C")]).toEqual([5001, 5002, 6001]);
      expect(seqs.get("CR-NEW-5")).toBe(5003);
      expect(seqs.get("CR-NEW-6")).toBe(6002);
      // One scale per wave: the appended row is in scale with its siblings.
      expect(report.defaultedSeq).toEqual([]);
      // The published order inside wave 5 is the AUTHORED one, the new row last.
      expect(store.listQueue(key).map((entry) => entry.cr)).toEqual([
        "CR-A",
        "CR-B",
        "CR-NEW-5",
        "CR-C",
        "CR-NEW-6",
      ]);
    },
  );

  test(
    "AC12a (gap) — the slot is max(in-block seq held or assigned in the wave) + 1, not a count: " +
      "held 5001, 5005 + two seq-less rows -> 5006, 5007",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5005, release: "0.2.0" },
      ]);

      store.replaceQueue(key, [
        { cr: "CR-NEW-1", wave: "5", dependsOn: [] },
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-NEW-2", wave: "5", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      expect([seqs.get("CR-A"), seqs.get("CR-B")]).toEqual([5001, 5005]);
      // Post order among the DEFAULTED rows decides who is first after the block.
      expect([seqs.get("CR-NEW-1"), seqs.get("CR-NEW-2")]).toEqual([5006, 5007]);
    },
  );

  test(
    "AC12b — a held value OUTSIDE the block does not count toward the slot: a wave holding legacy " +
      "positional 62 (carried forward) gets its next seq-less row at 6001, not 63 — and the " +
      "store names that row in defaultedSeq (a TRUE same-wave mixture, CR-091's wave axis)",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // A pre-§S3 board: wave 6 stores positional values.
      store.replaceQueue(key, [
        { cr: "CR-W6-A", wave: "6", dependsOn: [], seq: 62 },
        { cr: "CR-W6-B", wave: "6", dependsOn: [], seq: 64 },
      ]);

      const report = store.replaceQueue(key, [
        { cr: "CR-W6-A", wave: "6", dependsOn: [] },
        { cr: "CR-W6-B", wave: "6", dependsOn: [] },
        { cr: "CR-NEW", wave: "6", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      // §S3 does not retroactively fix the board...
      expect([seqs.get("CR-W6-A"), seqs.get("CR-W6-B")]).toEqual([62, 64]);
      // ...and does not extend the positional scale either.
      expect(seqs.get("CR-NEW")).toBe(6001);
      // 62/64 beside 6001 IS two scales in one wave — the pre-existing
      // same-wave rule (CR-091 AC23, unchanged by §S2) names the new row.
      expect(report.defaultedSeq).toEqual(["CR-NEW"]);
    },
  );

  test(
    "AC12g — a held row whose WAVE CHANGES in a re-post is RE-SLOTTED into the new wave's block " +
      "(held means held IN THAT WAVE): B(0.2.0/5, 5002) re-posted as wave 6 lands after wave 6's " +
      "held block, is published after wave 5, and names nobody — a row that keeps its wave keeps " +
      "its seq",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-C", wave: "6", dependsOn: [], seq: 6001 },
      ]);

      // The README moved B to wave 6 and gained N there; nothing carries a seq.
      const report = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [] },
        { cr: "CR-B", wave: "6", dependsOn: [] },
        { cr: "CR-N", wave: "6", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      // Kept their wave, kept their seq (AC13).
      expect([seqs.get("CR-A"), seqs.get("CR-C")]).toEqual([5001, 6001]);
      // 5002 is not a wave-6 value: B takes the next free slot of wave 6's
      // block, in post order with the other seq-less row.
      expect([seqs.get("CR-B"), seqs.get("CR-N")]).toEqual([6002, 6003]);
      expectInBlock("CR-B", "6", seqs.get("CR-B"));
      // One scale in wave 6, so nothing is named — least of all N for B's move.
      expect(report.defaultedSeq).toEqual([]);
      // Published after wave 5. B carries its release forward (CR-091), so
      // inside wave 6 it is the declared `0.2.0/6` row and leads the
      // undeclared `-/6` ones (§S1/AC1e) — its seq decides nothing across
      // containers, and inside its own it is alone.
      expect(store.listQueue(key).map((entry) => entry.cr)).toEqual([
        "CR-A",
        "CR-B",
        "CR-C",
        "CR-N",
      ]);
    },
  );

  test(
    "AC12g (mixture) — when the re-slotted row lands beside a legacy positional sibling, the " +
      "row NAMED is the moved row itself (its seq was chosen by this write), never a sibling " +
      "for it",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-W6-A", wave: "6", dependsOn: [], seq: 62 },
      ]);

      const report = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-W6-A", wave: "6", dependsOn: [] },
        { cr: "CR-B", wave: "6", dependsOn: [] },
      ]);

      const seqs = seqOf(store, key);
      expect([seqs.get("CR-A"), seqs.get("CR-W6-A")]).toEqual([5001, 62]);
      expect(seqs.get("CR-B")).toBe(6001);
      // 62 beside 6001 is two scales in wave 6, and B is the row this write
      // slotted: B is named, CR-W6-A (held, untouched) is not.
      expect(report.defaultedSeq).toEqual(["CR-B"]);
      // After wave 5; the declared `0.2.0/6` row before the undeclared `-/6` one.
      expect(store.listQueue(key).map((entry) => entry.cr)).toEqual([
        "CR-A",
        "CR-B",
        "CR-W6-A",
      ]);
    },
  );

  test(
    "AC14 — IDEMPOTENT: posting the same seq-less payload twice on a fresh store yields " +
      "identical seq values, and those values are IN-BLOCK (the second post carries forward " +
      "what the first defaulted)",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const rows = multiWaveBoard();

      store.replaceQueue(key, seqless(rows));
      const first = seqOf(store, key);
      const report = store.replaceQueue(key, seqless(rows));
      const second = seqOf(store, key);

      expect(second).toEqual(first);
      expect(report.defaultedSeq).toEqual([]);
      // Equal is not enough: 0..10 twice is also equal. The values must be
      // the block values, or the board is idempotently wrong.
      for (const row of rows) expectInBlock(row.cr, row.wave, second.get(row.cr));
      expect(second).toEqual(expectedInBlockSeqs(rows));
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-095 §S3 — the WIRE: the bulk queue post defaults into the wave block", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru095-wave-block-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  /** A project plus the ORCHESTRATOR the role gate admits to the roadmap verbs. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    const orchestrator = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(orchestrator.status).toBe(200);
    return key;
  }

  async function propose(key: string, label: string): Promise<void> {
    const res = await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label });
    expect(res.status).toBe(200);
  }

  async function ship(key: string, label: string): Promise<void> {
    const res = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "release",
      label,
      commit: "a".repeat(40),
      releasedAt: 1_787_149_125,
    });
    expect(res.status).toBe(201);
  }

  async function plan(
    key: string,
    cr: string,
    release: string,
    wave: number | string,
    title: string,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(`/api/v2/projects/${key}/queue/plan`, { agentId: ORCH, cr, release, wave, title });
  }

  async function sequence(
    key: string,
    release: string,
    wave: number | string,
    crs: string[],
  ): Promise<{ status: number; body: AnyBody }> {
    return post(`/api/v2/projects/${key}/queue/sequence`, { agentId: ORCH, release, wave, crs });
  }

  async function bulk(
    key: string,
    entries: Array<Record<string, unknown>>,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(`/api/v2/projects/${key}/queue`, { agentId: ORCH, entries });
  }

  async function seqs(key: string): Promise<Map<string, number>> {
    const res = await get(`/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    return new Map(res.body.entries!.map((entry) => [entry.cr, entry.seq]));
  }

  /** The README table as `queue-file` posts it: integer waves as numbers, no seq, no release. */
  function table(rows: Array<{ cr: string; wave: string }>): Array<Record<string, unknown>> {
    return rows.map((row) => ({
      cr: row.cr,
      wave: /^\d+$/.test(row.wave) ? Number(row.wave) : row.wave,
      dependsOn: [],
    }));
  }

  /**
   * §S3/AC12c, AC12h, AC12i — the ONE overflow wording (src/store.ts
   * `waveOverflowMessage`) as `wave-sequence`, the bulk post and cr-plan all
   * answer it. `seq` is the value that would LEAVE the block (AC12h) — never
   * the post's row count, which is false the moment a declared seq near the
   * block's end trips the refusal early.
   */
  function overflowMessage(wave: string, seq: number): string {
    return (
      `wave ${wave} would reach seq ${seq}, outside its block — a wave's seq block is ` +
      `${WAVE_SEQ_STRIDE} positions wide, so it carries at most ${WAVE_SEQ_STRIDE - 1}; ` +
      `nothing was written`
    );
  }

  /** AC12i — the ONE `help[]` (`roadmapHints.waveOverflow`) every overflow 400 carries. */
  function overflowHelp(container: string, seq: number): string[] {
    return [
      `split ${container} across two waves: cr-plan --cr <cr> --release <v> --wave <n+1> ` +
        `--title <brief> moves a cr out, then re-send --crs for each wave`,
      `seq ${seq} is past the block a wave's seq values live in — nothing was written, so the ` +
        `stored order is still the last authored one`,
    ];
  }

  /** `count` seq-less wave-5 rows, `CR-W5-0001`… */
  function wave5Rows(count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, index) => ({
      cr: `CR-W5-${String(index + 1).padStart(4, "0")}`,
      wave: 5,
      dependsOn: [],
    }));
  }

  test(
    "§S2 INTERACTION GUARD — a FRESH import of the live board's 94-row shape carries ZERO " +
      "defaulted-seq warnings (C2's AC9a shape): nothing in the post declares or holds a seq, so " +
      "one scale per wave today and one scale per wave after §S3 — no mixture on either axis",
    async () => {
      boot();
      const key = await seed("s2-interaction-guard");
      const rows = liveBoardRows();

      const imported = await bulk(key, table(rows));

      expect(imported.status).toBe(200);
      expect(imported.body.ok).toBe(true);
      expect(imported.body.entries).toHaveLength(94);
      expect(imported.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);
    },
  );

  test(
    "AC12 (wire, fixture A) — queue-file's fresh import of the interleaved multi-wave board " +
      "answers every row in-block, the third row of wave 4 at 4003, and publishes the README's " +
      "wave grouping",
    async () => {
      boot();
      const key = await seed("ac12-multi-wave");
      const rows = multiWaveBoard();

      const imported = await bulk(key, table(rows));

      expect(imported.status).toBe(200);
      expect(imported.body.ok).toBe(true);
      const answered = new Map(imported.body.entries!.map((entry) => [entry.cr, entry.seq]));
      for (const row of rows) expectInBlock(row.cr, row.wave, answered.get(row.cr));
      expect(answered.get("CR-W4-C")).toBe(4003);
      expect(answered.get("CR-BACKLOG-C")).toBe(3);
      expect(answered).toEqual(expectedInBlockSeqs(rows));
      expect(imported.body.entries!.map((entry) => entry.cr)).toEqual(MULTI_WAVE_README_ORDER);
      // The read agrees with the write's answer.
      expect(await seqs(key)).toEqual(answered);
    },
  );

  test(
    "AC12 (wire, fixture B) + §S2 INTERACTION GUARD — a FRESH import of the live board's 94-row " +
      "shape lands every row in-block AND carries ZERO defaulted-seq warnings: every defaulted " +
      "row is in scale and release-less, so no mixture exists on either axis",
    async () => {
      boot();
      const key = await seed("ac12-live-board");
      const rows = liveBoardRows();
      expect(rows).toHaveLength(94);

      const imported = await bulk(key, table(rows));

      expect(imported.status).toBe(200);
      expect(imported.body.ok).toBe(true);
      expect(imported.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);
      const answered = new Map(imported.body.entries!.map((entry) => [entry.cr, entry.seq]));
      expect(answered.size).toBe(94);
      for (const row of rows) expectInBlock(row.cr, row.wave, answered.get(row.cr));
      expect(answered.get("CR-SHIPPED-01")).toBe(1001);
      expect(answered.get("CR-SHIPPED-04")).toBe(4001);
      expect(answered.get("CR-DEFERRED-01")).toBe(6001);
      expect(answered.get("CR-AUTHORED-01")).toBe(5001);
      expect(answered).toEqual(expectedInBlockSeqs(rows));
    },
  );

  test(
    "AC13 (wire) — CARRY-FORWARD GUARD: an authored 5001+ block AND a legacy positional 62 both " +
      "survive queue-file's seq-less re-post untouched",
    async () => {
      boot();
      const key = await seed("ac13-carry-forward");
      await propose(key, "0.2.0");

      // A pre-§S3 board: wave 6 holds positional values (declared here to
      // stand in for what an earlier import wrote), wave 5 is then authored.
      const bootstrapped = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-W6-A", wave: 6, dependsOn: [], seq: 62 },
        { cr: "CR-W6-B", wave: 6, dependsOn: [], seq: 64 },
      ]);
      expect(bootstrapped.status).toBe(200);
      expect((await plan(key, "CR-A", "0.2.0", 5, "a")).status).toBe(200);
      expect((await plan(key, "CR-B", "0.2.0", 5, "b")).status).toBe(200);
      expect((await sequence(key, "0.2.0", 5, ["CR-B", "CR-A"])).status).toBe(200);
      const before = await seqs(key);
      expect([before.get("CR-B"), before.get("CR-A")]).toEqual([5001, 5002]);
      expect(before.get("CR-W6-A")).toBe(62);

      // The re-post the orchestrator runs on every README edit.
      const reposted = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-W6-A", wave: 6, dependsOn: [] },
        { cr: "CR-W6-B", wave: 6, dependsOn: [] },
      ]);

      expect(reposted.status).toBe(200);
      expect(reposted.body.ok).toBe(true);
      expect(reposted.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);
      const after = await seqs(key);
      expect([after.get("CR-B"), after.get("CR-A")]).toEqual([5001, 5002]);
      // §S3 does not retroactively fix a board: 62 stays 62, not 6001.
      expect(after.get("CR-W6-A")).toBe(62);
      expect(after.get("CR-W6-B")).toBe(64);
      expect(after).toEqual(before);
    },
  );

  test(
    "AC12b (wire) — a wave carrying legacy positional 62 (held) gets its next seq-less row at " +
      "6001, and the bulk post's response carries a same-wave defaulted-seq warning NAMING that " +
      "row: 62 beside 6001 is a true mixture, CR-091's wave axis unchanged",
    async () => {
      boot();
      const key = await seed("ac12b-legacy-beside-block");

      const bootstrapped = await bulk(key, [
        { cr: "CR-W6-A", wave: 6, dependsOn: [], seq: 62 },
        { cr: "CR-W6-B", wave: 6, dependsOn: [], seq: 64 },
      ]);
      expect(bootstrapped.status).toBe(200);

      // The README gained a row in wave 6; the re-post carries no seq at all.
      const reposted = await bulk(key, [
        { cr: "CR-W6-A", wave: 6, dependsOn: [] },
        { cr: "CR-W6-B", wave: 6, dependsOn: [] },
        { cr: "CR-NEW", wave: 6, dependsOn: [] },
      ]);

      expect(reposted.status).toBe(200);
      expect(reposted.body.ok).toBe(true);
      const seqs = new Map(reposted.body.entries!.map((entry) => [entry.cr, entry.seq]));
      expect([seqs.get("CR-W6-A"), seqs.get("CR-W6-B")]).toEqual([62, 64]);
      expect(seqs.get("CR-NEW")).toBe(6001);
      // Warn-and-write: the row landed AND the mixture is named, with the remedy.
      const warning = reposted.body.warnings!.find((w) => w.code === "defaulted-seq");
      expect(warning).toBeDefined();
      expect(warning!.crs).toEqual(["CR-NEW"]);
      expect(warning!.message).toContain("CR-NEW");
      expect(warning!.message).toContain("wave-sequence");
    },
  );

  test(
    "AC12c — a bulk post whose defaults would reach WAVE_SEQ_STRIDE members in one wave is " +
      "REFUSED with wave-sequence's own message and nothing is written; WAVE_SEQ_STRIDE - 1 " +
      "members are accepted, the last at base + 999",
    async () => {
      boot();
      const key = await seed("ac12c-overflow");
      const rows = wave5Rows;

      // The thousandth member would take wave 6's base: refused BY NAME, as
      // wave-sequence refuses it (src/v2.ts:2245-2248), in ONE wording that
      // states the seq that would leave the block (AC12h) and ONE help[] (AC12i).
      const refused = await bulk(key, rows(WAVE_SEQ_STRIDE));

      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toContain("wave 5");
      expect(refused.body.error).toContain(
        `a wave's seq block is ${WAVE_SEQ_STRIDE} positions wide, so it carries at most ` +
          `${WAVE_SEQ_STRIDE - 1}; nothing was written`,
      );
      expect(refused.body.error).toBe(overflowMessage("5", waveSeqBase("5") + WAVE_SEQ_STRIDE));
      expect(refused.body.help).toEqual(overflowHelp("-/5", waveSeqBase("5") + WAVE_SEQ_STRIDE));
      const untouched = await get(`/api/v2/projects/${key}/queue`);
      expect(untouched.status).toBe(200);
      expect(untouched.body.entries).toEqual([]);

      // One fewer fills the block exactly: the last row sits at base + 999,
      // still strictly inside (5000, 6000).
      const filled = await bulk(key, rows(WAVE_SEQ_STRIDE - 1));
      expect(filled.status).toBe(200);
      expect(filled.body.entries).toHaveLength(WAVE_SEQ_STRIDE - 1);
      const seqs = new Map(filled.body.entries!.map((entry) => [entry.cr, entry.seq]));
      expect(seqs.get("CR-W5-0001")).toBe(5001);
      expect(seqs.get(`CR-W5-${String(WAVE_SEQ_STRIDE - 1).padStart(4, "0")}`)).toBe(
        waveSeqBase("5") + WAVE_SEQ_STRIDE - 1,
      );
      expectInBlock("CR-W5-0999", "5", seqs.get("CR-W5-0999"));
    },
  );

  test(
    "AC12h — the overflow message states the SEQ that would leave the block, not the post's row " +
      "count: 5999 declared plus ONE seq-less row is refused naming 6000, never 'would hold 2 " +
      "crs'; 5998 plus one lands the row at 5999 (the safe side of AC12c)",
    async () => {
      boot();
      const key = await seed("ac12h-early-trip");

      const refused = await bulk(key, [
        { cr: "CR-NEAR-END", wave: 5, dependsOn: [], seq: 5999 },
        { cr: "CR-NEW", wave: 5, dependsOn: [] },
      ]);

      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toBe(overflowMessage("5", 6000));
      expect(refused.body.error).not.toContain("would hold");
      expect(refused.body.error).not.toContain("2 crs");
      expect(refused.body.help).toEqual(overflowHelp("-/5", 6000));
      expect((await get(`/api/v2/projects/${key}/queue`)).body.entries).toEqual([]);

      const accepted = await bulk(key, [
        { cr: "CR-NEAR-END", wave: 5, dependsOn: [], seq: 5998 },
        { cr: "CR-NEW", wave: 5, dependsOn: [] },
      ]);
      expect(accepted.status).toBe(200);
      expect((await seqs(key)).get("CR-NEW")).toBe(5999);
    },
  );

  test(
    "AC12i — the bulk overflow 400 is the SAME ENVELOPE as wave-sequence's: for one wave and one " +
      "overflowing seq the two refusals carry byte-identical `error` and `help[]`",
    async () => {
      boot();
      const key = await seed("ac12i-one-envelope");
      await propose(key, "0.2.0");

      // Wave 5 is full (999 in-block rows); CR-MOVER sits in wave 6, planned
      // into 0.2.0 so that its container is the one wave-sequence names.
      const filled = await bulk(key, [...wave5Rows(WAVE_SEQ_STRIDE - 1), { cr: "CR-MOVER", wave: 6, dependsOn: [] }]);
      expect(filled.status).toBe(200);
      expect((await plan(key, "CR-MOVER", "0.2.0", 6, "about to move")).status).toBe(200);
      const before = await seqs(key);

      // The README moves CR-MOVER into wave 5: re-slotted (AC12g), its slot
      // would be 6000 — refused.
      const viaBulk = await bulk(key, [...wave5Rows(WAVE_SEQ_STRIDE - 1), { cr: "CR-MOVER", wave: 5, dependsOn: [] }]);
      // wave-sequence carrying a thousandth member of 0.2.0/5: refused by the
      // same arithmetic, before any per-cr lookup.
      const viaSequence = await sequence(
        key,
        "0.2.0",
        5,
        wave5Rows(WAVE_SEQ_STRIDE).map((row) => row.cr as string),
      );

      expect(viaBulk.status).toBe(400);
      expect(viaSequence.status).toBe(400);
      expect(viaBulk.body.error).toBe(overflowMessage("5", 6000));
      expect(viaBulk.body.error).toBe(viaSequence.body.error!);
      expect(viaBulk.body.help).toEqual(overflowHelp("0.2.0/5", 6000));
      expect(viaBulk.body.help).toEqual(viaSequence.body.help!);
      // Neither wrote anything: CR-MOVER still sits in wave 6 with its seq.
      expect(await seqs(key)).toEqual(before);
      const mover = (await get(`/api/v2/projects/${key}/queue`)).body.entries!.find(
        (entry) => entry.cr === "CR-MOVER",
      );
      expect(mover!.wave).toBe("6");
    },
  );

  test(
    "AC12i (wave-sequence's OWN text) — 999 members of 0.2.0/5 are sequenced; the thousandth " +
      "is refused with the shared wording naming seq 6000 and the shared help[]",
    async () => {
      boot();
      const key = await seed("ac12i-wave-sequence-pin");
      await propose(key, "0.2.0");
      const rows = wave5Rows(WAVE_SEQ_STRIDE - 1);
      expect((await bulk(key, rows)).status).toBe(200);
      const crs = rows.map((row) => row.cr as string);
      // 999 cr-plans; each keeps its wave (and so its held seq), so order is
      // immaterial and they go out together.
      const planned = await Promise.all(crs.map((cr) => plan(key, cr, "0.2.0", 5, `title ${cr}`)));
      expect(planned.every((res) => res.status === 200)).toBe(true);

      const full = await sequence(key, "0.2.0", 5, crs);
      expect(full.status).toBe(200);
      expect(full.body.ok).toBe(true);
      expect((await seqs(key)).get(`CR-W5-${String(WAVE_SEQ_STRIDE - 1).padStart(4, "0")}`)).toBe(
        waveSeqBase("5") + WAVE_SEQ_STRIDE - 1,
      );

      const refused = await sequence(key, "0.2.0", 5, [...crs, "CR-W5-1000"]);
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toBe(overflowMessage("5", waveSeqBase("5") + WAVE_SEQ_STRIDE));
      expect(refused.body.help).toEqual(overflowHelp("0.2.0/5", waveSeqBase("5") + WAVE_SEQ_STRIDE));
      // Nothing written: the authored block stands.
      expect((await seqs(key)).get("CR-W5-0001")).toBe(5001);
      expect((await seqs(key)).has("CR-W5-1000")).toBe(false);
    },
    30_000,
  );

  test(
    "AC14 (wire) — IDEMPOTENT: queue-file posted twice on a fresh project answers identical " +
      "in-block values both times",
    async () => {
      boot();
      const key = await seed("ac14-idempotent");
      const rows = liveBoardRows();

      const first = await bulk(key, table(rows));
      const second = await bulk(key, table(rows));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstSeqs = new Map(first.body.entries!.map((entry) => [entry.cr, entry.seq]));
      const secondSeqs = new Map(second.body.entries!.map((entry) => [entry.cr, entry.seq]));
      expect(secondSeqs).toEqual(firstSeqs);
      expect(second.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);
      for (const row of rows) expectInBlock(row.cr, row.wave, secondSeqs.get(row.cr));
      expect(secondSeqs).toEqual(expectedInBlockSeqs(rows));
    },
  );

  test(
    "AC15 — wave-sequence is UNCHANGED after a fresh in-block import: it still assigns " +
      "base + index + 1 in the posted order, its write is scoped to (release, wave), and it " +
      "still refuses a SHIPPED release",
    async () => {
      boot();
      const key = await seed("ac15-wave-sequence");
      await propose(key, "0.1.0");
      await propose(key, "0.2.0");

      const imported = await bulk(key, [
        { cr: "CR-OLD", wave: 4, dependsOn: [] },
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-C", wave: 5, dependsOn: [] },
        { cr: "CR-D", wave: 6, dependsOn: [] },
        { cr: "CR-E", wave: 6, dependsOn: [] },
      ]);
      expect(imported.status).toBe(200);
      const beforeAuthoring = await seqs(key);

      // 0.1.0 SHIPS: its proposal is consumed, and it is settled history.
      expect((await plan(key, "CR-OLD", "0.1.0", 4, "shipped history")).status).toBe(200);
      await ship(key, "0.1.0");
      const refused = await sequence(key, "0.1.0", 4, ["CR-OLD"]);
      expect(refused.status).toBe(404);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toContain("0.1.0");
      expect(refused.body.error).toContain("no live proposal");
      expect(refused.body.help!.some((line) => line.includes("SHIPPED"))).toBe(true);
      expect((await seqs(key)).get("CR-OLD")).toBe(beforeAuthoring.get("CR-OLD"));

      // 0.2.0 wave 5 is authored in a DIFFERENT order from the post's.
      for (const cr of ["CR-A", "CR-B", "CR-C"]) {
        expect((await plan(key, cr, "0.2.0", 5, `title ${cr}`)).status).toBe(200);
      }
      const authored = await sequence(key, "0.2.0", 5, ["CR-C", "CR-A", "CR-B"]);
      expect(authored.status).toBe(200);
      expect(authored.body.ok).toBe(true);
      expect(authored.body.converged).toBe(false);
      const afterAuthoring = await seqs(key);
      expect([afterAuthoring.get("CR-C"), afterAuthoring.get("CR-A"), afterAuthoring.get("CR-B")]).toEqual([
        5001, 5002, 5003,
      ]);
      // (release, wave) scoping: wave 6 and the shipped wave 4 are untouched.
      for (const cr of ["CR-OLD", "CR-D", "CR-E"]) {
        expect(afterAuthoring.get(cr)).toBe(beforeAuthoring.get(cr));
      }
      // Re-sending the same list converges — nothing rewritten.
      const again = await sequence(key, "0.2.0", 5, ["CR-C", "CR-A", "CR-B"]);
      expect(again.status).toBe(200);
      expect(again.body.converged).toBe(true);
      expect(await seqs(key)).toEqual(afterAuthoring);
    },
  );
});
