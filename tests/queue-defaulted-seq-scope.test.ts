// CR-CRU-095 §S2 — `defaulted-seq` widens from same-WAVE to same-wave OR same-RELEASE. C2 RED.
//
// Covers AC9, AC9a, AC9b, AC10 and AC11 at the two boundaries that emit the
// warning: the store (`replaceQueue` / `upsertQueueEntry` return `defaultedSeq`)
// and the two REST writes that turn it into a `defaulted-seq` warning (the bulk
// queue post and `cr-plan`). §S1 (C1, done) and §S3's bulk-post defaulting
// (cycle 307) are NOT touched here.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `upsertQueueEntry` (src/store.ts:3635-3641) compares only the target wave's
// siblings, and only when the cr MOVED. So `cr-plan` declaring a row that
// HOLDS a positional seq into a release whose other wave is authored (`5001+`)
// preserves that seq (CR-091 carry-forward), leaves a mixture of two scales
// inside a plannable release — and says nothing. That is the ONE reachable
// cross-wave producer (spec §S2, ruled 2026-09-02): the bulk route never
// forwards `release`, a held row always carries a `seq`, and after §S3 a bulk
// default lands in its own block — so a bulk cross-wave case cannot occur and
// is not pinned here.
//
// ── The seam GREEN must expose ────────────────────────────────────────────
//
// The SAME `defaultedSeq` report and the SAME `defaulted-seq` code
// (src/v2.ts:1896-1908), reached when the mismatched sibling sits in another
// wave of the SAME RELEASE — a mixture is a DIFFERENCE OF SCALE, never "this
// write chose the value". The message gains the words "or release" and is
// otherwise unchanged. The two axes are a UNION: rows carrying no release are
// still compared on the wave axis (AC11, CR-091 AC23 unchanged) and never on
// the release axis (AC9a): the live board's 66 release-less rows beside 28
// authored 0.2.0 rows name nobody.
//
// Every store here is `:memory:`, every server boots on an OS-assigned port
// against an mkdtempSync scratch db. The live data/crucible.db and port 3849
// are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, WAVE_SEQ_STRIDE } from "../src/store.ts";
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
  converged?: boolean;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";

/**
 * §S2/AC11 — the warning's wording is REUSED with ONE addition: "or release".
 * Pinned once so the same-wave (preserved) and the same-release (widened)
 * cases are asserted against ONE string. src/v2.ts:1902-1904 still carries
 * the same-wave-only sentence, which is why the AC11 pins are RED with AC9.
 */
function defaultedSeqMessage(crs: string[]): string {
  return (
    `seq was defaulted for ${crs.join(", ")} while a sibling in the same wave or release carries ` +
    `one on a DIFFERENT SCALE — the two interleave in an order nobody authored; run ` +
    `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`
  );
}

function expectDefaultedSeqWarning(warnings: WarningWire[] | undefined, crs: string[]): void {
  expect(warnings).toBeDefined();
  const warning = warnings!.find((w) => w.code === "defaulted-seq");
  expect(warning).toBeDefined();
  expect(warning!.crs).toEqual(crs);
  expect(warning!.message).toBe(defaultedSeqMessage(crs));
  for (const cr of crs) expect(warning!.message).toContain(cr);
  expect(warning!.message).toContain("wave-sequence");
}

/**
 * AC9a — the live board's SHAPE (read 2026-09-02): 66 release-less rows —
 * 53 in shipped waves 1-4 and 13 deferred in wave 6 — beside 28 authored
 * 0.2.0 rows in wave 5. Ids are synthetic; the counts are the board's.
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

// ── store-level helpers ────────────────────────────────────────────────────

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "defaulted-seq-scope", type: "backend", sutRoot: "/tmp" });
  return key;
}

function seqOf(store: Store, key: string): Map<string, number> {
  return new Map(store.listQueue(key).map((entry) => [entry.cr, entry.seq]));
}

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-095 §S2 — the STORE names a defaulted row beside an authored one in the SAME RELEASE", () => {
  test(
    "AC9 (cr-plan) — upsertQueueEntry: declaring 0.2.0 on a positional wave-6 row while wave 5 " +
      "of 0.2.0 is authored at 5001+ names that row in defaultedSeq; the declaration still lands",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      // The board acquires its rows the way the live one did: a bulk bootstrap
      // that carries no release. Wave 5 defaults into its block (CR-CRU-095
      // §S3); CR-C DECLARES a legacy positional seq, standing in for what a
      // pre-§S3 import wrote (the fixture AC13's legacy guard uses).
      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [], seq: 2 },
      ]);
      expect([...seqOf(store, key).values()]).toEqual([5001, 5002, 2]);

      // Wave 5 is planned into 0.2.0 and AUTHORED.
      store.upsertQueueEntry(key, { cr: "CR-A", release: "0.2.0", wave: "5", title: "a" });
      store.upsertQueueEntry(key, { cr: "CR-B", release: "0.2.0", wave: "5", title: "b" });
      store.sequenceQueueWave(key, { release: "0.2.0", wave: "5", crs: ["CR-A", "CR-B"] });
      expect([seqOf(store, key).get("CR-A"), seqOf(store, key).get("CR-B")]).toEqual([
        5001, 5002,
      ]);

      // Wave 6's row is planned into the SAME release. It stays in its wave,
      // so its positional seq rides along — beside 5001/5002 in 0.2.0, that
      // is a mixture on two scales inside a plannable release.
      const planned = store.upsertQueueEntry(key, {
        cr: "CR-C",
        release: "0.2.0",
        wave: "6",
        title: "deferred into the release",
      });
      expect(planned.changed).toBe(true);
      expect(planned.defaultedSeq).toEqual(["CR-C"]);

      const landed = store.listQueue(key).find((entry) => entry.cr === "CR-C");
      expect(landed!.release).toBe("0.2.0");
      expect(landed!.wave).toBe("6");
      // The mismatch the report names is real: the positional value is still
      // outside wave 6's block while its release siblings sit in wave 5's.
      expect(landed!.seq).toBe(2);
    },
  );

  test(
    "AC12e (cr-plan) — upsertQueueEntry takes the SAME next-free-slot as the bulk post " +
      "(max in-block seq + 1, never a count): authored A..E 5001..5005, a re-post dropping C, D " +
      "and adding F (5006), then cr-plan G into 0.2.0/5 -> 5007, never a held value",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const crs = ["CR-A", "CR-B", "CR-C", "CR-D", "CR-E"];

      store.replaceQueue(
        key,
        crs.map((cr) => ({ cr, wave: "5", dependsOn: [] })),
      );
      for (const cr of crs) {
        store.upsertQueueEntry(key, { cr, release: "0.2.0", wave: "5", title: cr });
      }
      store.sequenceQueueWave(key, { release: "0.2.0", wave: "5", crs });
      expect([...seqOf(store, key).values()]).toEqual([5001, 5002, 5003, 5004, 5005]);

      // The README dropped C and D and gained F: the gapped block 5001, 5002,
      // 5005 is held, F is appended after it (AC12a).
      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-E", wave: "5", dependsOn: [] },
        { cr: "CR-F", wave: "5", dependsOn: [] },
      ]);
      expect(seqOf(store, key).get("CR-F")).toBe(5006);

      const planned = store.upsertQueueEntry(key, {
        cr: "CR-G",
        release: "0.2.0",
        wave: "5",
        title: "planned into the gapped block",
      });

      const seqs = seqOf(store, key);
      // base + count + 1 would be 5005 — E's. The slot is max + 1.
      expect(seqs.get("CR-G")).toBe(5007);
      const others = [...seqs.entries()].filter(([cr]) => cr !== "CR-G").map(([, seq]) => seq);
      expect(others).not.toContain(seqs.get("CR-G"));
      expect(new Set(seqs.values()).size).toBe(seqs.size);
      // Every wave-5 value is in-block: one scale, nothing named.
      expect(planned.defaultedSeq).toEqual([]);
    },
  );

  test(
    "AC11a (cr-plan) — a write names ITS OWN ROW, and only when this write chose the seq or the " +
      "held seq is the out-of-block one: retitling authored A (5001, 0.2.0/5) beside positional " +
      "C (2, 0.2.0/6) names nothing; retitling C names C",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [], seq: 2 },
      ]);
      store.upsertQueueEntry(key, { cr: "CR-A", release: "0.2.0", wave: "5", title: "a" });
      store.upsertQueueEntry(key, { cr: "CR-B", release: "0.2.0", wave: "5", title: "b" });
      store.sequenceQueueWave(key, { release: "0.2.0", wave: "5", crs: ["CR-A", "CR-B"] });
      // AC9: the positional row's own write into the release names it.
      expect(
        store.upsertQueueEntry(key, { cr: "CR-C", release: "0.2.0", wave: "6", title: "c" })
          .defaultedSeq,
      ).toEqual(["CR-C"]);

      // A retitle that preserves A's authored in-block seq: the mixture in
      // 0.2.0 pre-exists and C's write named it; A's seq was neither chosen
      // here nor out of its block.
      const retitledA = store.upsertQueueEntry(key, {
        cr: "CR-A",
        release: "0.2.0",
        wave: "5",
        title: "a, retitled",
      });
      expect(retitledA.changed).toBe(true);
      expect(retitledA.defaultedSeq).toEqual([]);
      expect(seqOf(store, key).get("CR-A")).toBe(5001);

      // The same shape on the positional row: its held seq IS the
      // out-of-block one, so it is named again.
      const retitledC = store.upsertQueueEntry(key, {
        cr: "CR-C",
        release: "0.2.0",
        wave: "6",
        title: "c, retitled",
      });
      expect(retitledC.changed).toBe(true);
      expect(retitledC.defaultedSeq).toEqual(["CR-C"]);
      expect(seqOf(store, key).get("CR-C")).toBe(2);
    },
  );

  test(
    "AC9a — REGRESSION GUARD (release axis) against any-container scoping: a FRESH IMPORT of the " +
      "live board's shape (53 shipped + 13 deferred release-less rows, all defaulted, beside 28 " +
      "authored 0.2.0 rows) names NOBODY — a release-less row is never compared on the release axis",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const board = liveBoardShape();

      const entries: QueueEntryInput[] = [
        // Shipped history and the deferred wave: no release (CR-091 §S6
        // refuses to plan a shipped release; a deferred row has none) and no
        // seq — this write defaults every one of them.
        ...board.shipped.map((row) => ({ cr: row.cr, wave: row.wave, dependsOn: [] })),
        ...board.deferred.map((row) => ({ cr: row.cr, wave: row.wave, dependsOn: [] })),
        // The authored 0.2.0 block, as `wave-sequence` wrote it.
        ...board.authored.map((cr, index) => ({
          cr,
          wave: "5",
          dependsOn: [],
          seq: 5001 + index,
          release: "0.2.0",
        })),
      ];
      expect(entries).toHaveLength(94);

      const report = store.replaceQueue(key, entries);

      expect(report.defaultedSeq).toEqual([]);
      expect(store.listQueue(key)).toHaveLength(94);
    },
  );

  test(
    "AC9a — REGRESSION GUARD (release axis) against comparing HELD values: re-posting the live " +
      "board (every row carried forward, positional and authored alike) names NOBODY",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);
      const board = liveBoardShape();

      const rows = (withSeq: boolean): QueueEntryInput[] => [
        ...board.shipped.map((row, index) => ({
          cr: row.cr,
          wave: row.wave,
          dependsOn: [],
          ...(withSeq ? { seq: index } : {}),
        })),
        ...board.deferred.map((row, index) => ({
          cr: row.cr,
          wave: row.wave,
          dependsOn: [],
          ...(withSeq ? { seq: 60 + index } : {}),
        })),
        ...board.authored.map((cr, index) => ({
          cr,
          wave: "5",
          dependsOn: [],
          ...(withSeq ? { seq: 5001 + index, release: "0.2.0" } : {}),
        })),
      ];
      expect(store.replaceQueue(key, rows(true)).defaultedSeq).toEqual([]);

      // The real `queue-file` re-post: no seq, no release on any row — every
      // value is carried forward, nothing is chosen, nothing is named.
      const report = store.replaceQueue(key, rows(false));

      expect(report.defaultedSeq).toEqual([]);
      const seqs = seqOf(store, key);
      expect(board.authored.map((cr) => seqs.get(cr))).toEqual(
        board.authored.map((_, index) => 5001 + index),
      );
      expect(seqs.get("CR-DEFERRED-01")).toBe(60);
    },
  );

  test(
    "AC10 — a release whose EVERY compared row shares a scale is silent: waves 5 and 6 of 0.2.0 " +
      "both authored, re-posted and then appended to by cr-plan, name nobody",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      const authored = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
        { cr: "CR-C", wave: "6", dependsOn: [], seq: 6001, release: "0.2.0" },
        { cr: "CR-D", wave: "6", dependsOn: [], seq: 6002, release: "0.2.0" },
      ]);
      expect(authored.defaultedSeq).toEqual([]);

      const reposted = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [] },
        { cr: "CR-B", wave: "5", dependsOn: [] },
        { cr: "CR-C", wave: "6", dependsOn: [] },
        { cr: "CR-D", wave: "6", dependsOn: [] },
      ]);
      expect(reposted.defaultedSeq).toEqual([]);

      // cr-plan appends inside wave 6's own block — the same scale as every
      // sibling in the release, so the ordinary case, and silent.
      const appended = store.upsertQueueEntry(key, {
        cr: "CR-E",
        release: "0.2.0",
        wave: "6",
        title: "appended",
      });
      expect(appended.changed).toBe(true);
      expect(appended.defaultedSeq).toEqual([]);
      expect(seqOf(store, key).get("CR-E")).toBe(6003);
    },
  );

  test(
    "AC9b — GUARD: cr-plan into a NOT-YET-SEQUENCED wave of a partly-authored release takes a " +
      "wave-block seq, in scale with the authored wave, and is silent",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], seq: 5001, release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], seq: 5002, release: "0.2.0" },
      ]);

      const planned = store.upsertQueueEntry(key, {
        cr: "CR-C",
        release: "0.2.0",
        wave: "6",
        title: "first into an unsequenced wave",
      });
      expect(planned.changed).toBe(true);
      expect(planned.defaultedSeq).toEqual([]);
      expect(seqOf(store, key).get("CR-C")).toBe(6001);
    },
  );

  test(
    "AC10 — a release with NO authored wave at all (every row positional) is ONE scale, and silent",
    () => {
      const store = new Store(":memory:");
      const key = seedProject(store);

      const report = store.replaceQueue(key, [
        { cr: "CR-A", wave: "5", dependsOn: [], release: "0.2.0" },
        { cr: "CR-B", wave: "5", dependsOn: [], release: "0.2.0" },
        { cr: "CR-C", wave: "6", dependsOn: [], release: "0.2.0" },
      ]);
      expect(report.defaultedSeq).toEqual([]);

      // Declaring the release on rows that already hold it moves nothing and
      // names nobody either — still one scale.
      const declared = store.upsertQueueEntry(key, {
        cr: "CR-C",
        release: "0.2.0",
        wave: "6",
        title: "re-declared",
      });
      expect(declared.defaultedSeq).toEqual([]);
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-095 §S2 — the WIRE: the bulk post and cr-plan warn across waves of one release", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru095-seq-scope-"));
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

  test(
    "AC9 (cr-plan) — planning a positional wave-6 row into 0.2.0 while wave 5 of 0.2.0 is " +
      "authored at 5001+ answers ok:true with a defaulted-seq warning naming it (wave-sequence " +
      "as the remedy), and the declaration lands",
    async () => {
      boot();
      const key = await seed("ac9-cr-plan");
      await propose(key, "0.2.0");

      // The bulk bootstrap: no release; wave 5 defaults into its block
      // (CR-CRU-095 §S3), CR-C holds a legacy positional seq.
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-C", wave: 6, dependsOn: [], seq: 2 },
      ]);
      expect(seeded.status).toBe(200);
      expect(seeded.body.warnings).toEqual([]);

      expect((await plan(key, "CR-A", "0.2.0", 5, "a")).status).toBe(200);
      expect((await plan(key, "CR-B", "0.2.0", 5, "b")).status).toBe(200);
      const authored = await sequence(key, "0.2.0", 5, ["CR-A", "CR-B"]);
      expect(authored.status).toBe(200);
      expect([(await seqs(key)).get("CR-A"), (await seqs(key)).get("CR-B")]).toEqual([
        5001, 5002,
      ]);

      const planned = await plan(key, "CR-C", "0.2.0", 6, "deferred into the release");

      expect(planned.status).toBe(200);
      expect(planned.body.ok).toBe(true);
      expect(planned.body.converged).toBe(false);
      expectDefaultedSeqWarning(planned.body.warnings, ["CR-C"]);
      // Warn-and-write: refused nothing.
      expect(planned.body.entry!.release).toBe("0.2.0");
      expect(planned.body.entry!.wave).toBe("6");
      // The mismatch the warning reports is real: 2 beside 5001/5002.
      expect(planned.body.entry!.seq).toBe(2);
    },
  );

  test(
    "AC9a — REGRESSION GUARD (release axis) against any-container scoping: the live board (66 " +
      "release-less rows beside 28 authored 0.2.0 rows) re-posted through queue-file carries " +
      "ZERO defaulted-seq warnings",
    async () => {
      boot();
      const key = await seed("ac9a-live-board");
      await propose(key, "0.2.0");
      const board = liveBoardShape();
      const table = [
        ...board.shipped.map((row) => ({ cr: row.cr, wave: Number(row.wave), dependsOn: [] })),
        ...board.deferred.map((row) => ({ cr: row.cr, wave: 6, dependsOn: [] })),
        ...board.authored.map((cr) => ({ cr, wave: 5, dependsOn: [] })),
      ];
      expect(table).toHaveLength(94);

      const bootstrapped = await bulk(key, table);
      expect(bootstrapped.status).toBe(200);
      expect(bootstrapped.body.warnings).toEqual([]);

      for (const cr of board.authored) {
        expect((await plan(key, cr, "0.2.0", 5, `title ${cr}`)).status).toBe(200);
      }
      const authored = await sequence(key, "0.2.0", 5, board.authored);
      expect(authored.status).toBe(200);
      expect(board.authored.map((cr) => authored.body.entries!.find((e) => e.cr === cr)!.seq)).toEqual(
        board.authored.map((_, index) => 5001 + index),
      );

      // The re-post the orchestrator runs on every README edit.
      const reposted = await bulk(key, table);

      expect(reposted.status).toBe(200);
      expect(reposted.body.ok).toBe(true);
      expect(reposted.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);
      const carried = await seqs(key);
      expect(board.authored.map((cr) => carried.get(cr))).toEqual(
        board.authored.map((_, index) => 5001 + index),
      );
      // The deferred row carries the in-block value its bootstrap defaulted
      // (CR-CRU-095 §S3), not an array index.
      expect(carried.get("CR-DEFERRED-01")).toBe(6001);
    },
  );

  test(
    "AC10 — 0.2.0 with waves 5 AND 6 both authored: the bulk re-post and a cr-plan append " +
      "into wave 6 are both silent",
    async () => {
      boot();
      const key = await seed("ac10-both-authored");
      await propose(key, "0.2.0");
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-C", wave: 6, dependsOn: [] },
        { cr: "CR-D", wave: 6, dependsOn: [] },
      ]);
      expect(seeded.status).toBe(200);
      for (const [cr, wave] of [
        ["CR-A", 5],
        ["CR-B", 5],
        ["CR-C", 6],
        ["CR-D", 6],
      ] as const) {
        expect((await plan(key, cr, "0.2.0", wave, `title ${cr}`)).status).toBe(200);
      }
      expect((await sequence(key, "0.2.0", 5, ["CR-A", "CR-B"])).status).toBe(200);
      expect((await sequence(key, "0.2.0", 6, ["CR-C", "CR-D"])).status).toBe(200);

      const reposted = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-C", wave: 6, dependsOn: [] },
        { cr: "CR-D", wave: 6, dependsOn: [] },
      ]);
      expect(reposted.status).toBe(200);
      expect(reposted.body.warnings).toEqual([]);
      expect([...(await seqs(key)).values()].sort((a, b) => a - b)).toEqual([
        5001, 5002, 6001, 6002,
      ]);

      const appended = await plan(key, "CR-E", "0.2.0", 6, "appended into the authored wave");
      expect(appended.status).toBe(200);
      expect(appended.body.warnings).toEqual([]);
      expect(appended.body.entry!.seq).toBe(6003);
    },
  );

  test(
    "AC9b — GUARD: cr-plan into a NOT-YET-SEQUENCED wave 6 of 0.2.0 while wave 5 is authored " +
      "takes 6001 (in scale) and answers with NO defaulted-seq warning",
    async () => {
      boot();
      const key = await seed("ac9b-unsequenced-wave");
      await propose(key, "0.2.0");
      expect((await plan(key, "CR-A", "0.2.0", 5, "a")).status).toBe(200);
      expect((await plan(key, "CR-B", "0.2.0", 5, "b")).status).toBe(200);
      expect((await sequence(key, "0.2.0", 5, ["CR-A", "CR-B"])).status).toBe(200);

      const first = await plan(key, "CR-C", "0.2.0", 6, "first into an unsequenced wave");
      expect(first.status).toBe(200);
      expect(first.body.warnings).toEqual([]);
      expect(first.body.entry!.seq).toBe(6001);

      const second = await plan(key, "CR-D", "0.2.0", 6, "second into an unsequenced wave");
      expect(second.status).toBe(200);
      expect(second.body.warnings).toEqual([]);
      expect(second.body.entry!.seq).toBe(6002);
    },
  );

  // ── AC11 — the WAVE axis is preserved ─────────────────────────────────────
  //
  // The two shapes are already pinned by tests/roadmap-registration-routes.test.ts
  // "AC23 — a defaulted seq is reported, never silently invented" (the bulk
  // post that ADDS a cr to a wave carrying explicit seq values; cr-plan into a
  // wave whose siblings carry seq values from ANOTHER scale). Those assert the
  // named cr and `wave-sequence` by containment only (read 2026-09-02:
  // `toContain("CR-NEW")` / `toContain("wave-sequence")`), so they survive the
  // "or release" wording unchanged. The two below re-run the same shapes
  // against the FULL message so the wording the widened cases reuse is
  // provably the one the same-wave cases emit. The third pins the axis rule:
  // a release-less row is still compared on the WAVE axis.

  test(
    "AC11 (bulk) — a defaulted row beside an authored one in the SAME WAVE still warns with " +
      "the same code and the same wording",
    async () => {
      boot();
      const key = await seed("ac11-bulk");
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [], seq: 10 },
        { cr: "CR-B", wave: 5, dependsOn: [], seq: 20 },
      ]);
      expect(seeded.status).toBe(200);
      expect(seeded.body.warnings).toEqual([]);

      const added = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-NEW", wave: 5, dependsOn: [] },
      ]);

      expect(added.status).toBe(200);
      expect(added.body.ok).toBe(true);
      expectDefaultedSeqWarning(added.body.warnings, ["CR-NEW"]);
      const carried = await seqs(key);
      expect([carried.get("CR-A"), carried.get("CR-B")]).toEqual([10, 20]);
      expect(carried.has("CR-NEW")).toBe(true);
    },
  );

  test(
    "AC11 (cr-plan) — cr-plan into a wave whose siblings sit outside its block still warns " +
      "with the same code and the same wording",
    async () => {
      boot();
      const key = await seed("ac11-cr-plan");
      await propose(key, "0.2.0");
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [], seq: 10 },
        { cr: "CR-B", wave: 5, dependsOn: [], seq: 20 },
      ]);
      expect(seeded.status).toBe(200);

      const added = await plan(key, "CR-NEW", "0.2.0", 5, "unauthored position");

      expect(added.status).toBe(200);
      expect(added.body.ok).toBe(true);
      expectDefaultedSeqWarning(added.body.warnings, ["CR-NEW"]);
      expect(added.body.entry!.release).toBe("0.2.0");
      // Wave 5's block — not the positional siblings' scale. Out-of-block
      // values do not count toward the slot (AC12b; one slot function for
      // cr-plan and the bulk post, AC12e), so the block's FIRST position.
      expect(added.body.entry!.seq).toBe(5001);
    },
  );

  test(
    "AC11 (wave axis, release-less) — a RELEASE-LESS row defaulted beside same-wave siblings " +
      "on ANOTHER scale is still named: 'never compared' is the RELEASE axis only, the wave " +
      "axis is CR-091 AC23 unchanged",
    async () => {
      boot();
      const key = await seed("ac11-release-less");
      await propose(key, "0.2.0");
      // A pre-§S3 board: wave 5 holds legacy positional values (declared here
      // to stand in for what an earlier import wrote), then planned into
      // 0.2.0 — cr-plan keeps a held seq, so the wave stays on that scale.
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [], seq: 10 },
        { cr: "CR-B", wave: 5, dependsOn: [], seq: 20 },
      ]);
      expect(seeded.status).toBe(200);
      expect((await plan(key, "CR-A", "0.2.0", 5, "a")).status).toBe(200);
      expect((await plan(key, "CR-B", "0.2.0", 5, "b")).status).toBe(200);

      // The queue-file re-post adds a wave-5 row it cannot give a release:
      // its slot is wave 5's block (CR-CRU-095 §S3), beside 10/20 in the same
      // wave — two scales, and the release axis never sees a release-less row.
      const added = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-NEW", wave: 5, dependsOn: [] },
      ]);

      expect(added.status).toBe(200);
      expect(added.body.ok).toBe(true);
      // The same-wave rule names it (release-less or not) and says so once.
      expect(added.body.warnings!.filter((w) => w.code === "defaulted-seq")).toHaveLength(1);
      const warning = added.body.warnings!.find((w) => w.code === "defaulted-seq")!;
      expect(warning.crs).toEqual(["CR-NEW"]);
      expect(warning.message).toContain("CR-NEW");
      expect(warning.message).toContain("wave-sequence");
      const carried = await seqs(key);
      expect([carried.get("CR-A"), carried.get("CR-B")]).toEqual([10, 20]);
      const landed = (await get(`/api/v2/projects/${key}/queue`)).body.entries!.find(
        (entry) => entry.cr === "CR-NEW",
      );
      expect(landed).toBeDefined();
      expect(landed!.release).toBeUndefined();
    },
  );

  test(
    "AC12f (cr-plan) — planning a row into a wave whose block is FULL (999 in-block members) is " +
      "REFUSED with the shared overflow wording and the shared help[]; nothing is written",
    async () => {
      boot();
      const key = await seed("ac12f-cr-plan-overflow");
      await propose(key, "0.2.0");
      const rows = Array.from({ length: WAVE_SEQ_STRIDE - 1 }, (_, index) => ({
        cr: `CR-W5-${String(index + 1).padStart(4, "0")}`,
        wave: 5,
        dependsOn: [],
      }));
      expect((await bulk(key, rows)).status).toBe(200);

      const refused = await plan(key, "CR-W5-1000", "0.2.0", 5, "the thousandth member");

      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      // The seq that would leave the block, in wave-sequence's own wording.
      expect(refused.body.error).toBe(
        `wave 5 would reach seq 6000, outside its block — a wave's seq block is ` +
          `${WAVE_SEQ_STRIDE} positions wide, so it carries at most ${WAVE_SEQ_STRIDE - 1}; ` +
          `nothing was written`,
      );
      expect(refused.body.help).toEqual([
        `split 0.2.0/5 across two waves: cr-plan --cr <cr> --release <v> --wave <n+1> ` +
          `--title <brief> moves a cr out, then re-send --crs for each wave`,
        `seq 6000 is past the block a wave's seq values live in — nothing was written, so the ` +
          `stored order is still the last authored one`,
      ]);
      const after = await get(`/api/v2/projects/${key}/queue`);
      expect(after.body.entries).toHaveLength(WAVE_SEQ_STRIDE - 1);
      expect(after.body.entries!.some((entry) => entry.cr === "CR-W5-1000")).toBe(false);
      expect(after.body.entries!.every((entry) => entry.seq < 6000)).toBe(true);
    },
  );

  test(
    "AC11a (cr-plan, wire) — a retitle of authored A (5001, 0.2.0/5) beside positional C (2, " +
      "0.2.0/6) carries NO defaulted-seq warning; the same retitle on C names C",
    async () => {
      boot();
      const key = await seed("ac11a-retitle");
      await propose(key, "0.2.0");
      const seeded = await bulk(key, [
        { cr: "CR-A", wave: 5, dependsOn: [] },
        { cr: "CR-B", wave: 5, dependsOn: [] },
        { cr: "CR-C", wave: 6, dependsOn: [], seq: 2 },
      ]);
      expect(seeded.status).toBe(200);
      expect((await plan(key, "CR-A", "0.2.0", 5, "a")).status).toBe(200);
      expect((await plan(key, "CR-B", "0.2.0", 5, "b")).status).toBe(200);
      expect((await sequence(key, "0.2.0", 5, ["CR-A", "CR-B"])).status).toBe(200);
      // AC9 — C's own write into the release names C.
      expectDefaultedSeqWarning((await plan(key, "CR-C", "0.2.0", 6, "c")).body.warnings, ["CR-C"]);

      const retitledA = await plan(key, "CR-A", "0.2.0", 5, "a, retitled");

      expect(retitledA.status).toBe(200);
      expect(retitledA.body.ok).toBe(true);
      expect(retitledA.body.converged).toBe(false);
      expect(retitledA.body.entry!.seq).toBe(5001);
      expect(retitledA.body.warnings!.filter((w) => w.code === "defaulted-seq")).toEqual([]);

      const retitledC = await plan(key, "CR-C", "0.2.0", 6, "c, retitled");

      expect(retitledC.status).toBe(200);
      expect(retitledC.body.converged).toBe(false);
      expect(retitledC.body.entry!.seq).toBe(2);
      expectDefaultedSeqWarning(retitledC.body.warnings, ["CR-C"]);
    },
  );
});
