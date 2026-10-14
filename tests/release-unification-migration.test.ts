// CR-CRU-130 §S2 — the migration that rewrites two types into one record.
//
// ── What the step must do ─────────────────────────────────────────────────
//
//   * Leave NO `release-proposal` record behind — not in the `type` column and
//     not in the payload blob the column is derived from.
//   * A LIVE proposal becomes an UNDELIVERED `release`: its `targetAt`
//     survives, its `deliveredAt` stays absent.
//   * A DELIVERED release keeps its form exactly — commit, `crs`, `packages`,
//     delivered date.
//   * A proposal ALREADY CONSUMED by a shipped release becomes that release's
//     DELIVERY — one record carrying both the target it declared and the date
//     it was met — never a duplicate row.
//   * INVENT NOTHING: a release that declared no target keeps none, and a
//     milestone of any other type is byte-identical afterwards.
//   * Be IDEMPOTENT: a second boot changes nothing at all.
//
// ── THE TRAP THIS FIXTURE IS BUILT AROUND ─────────────────────────────────
//
// Measured on a read-only replica of the live store, 2026-09-13:
//
//     release          0.1.0 0.1.1 0.1.2 0.1.3   delivered, NO proposal left
//     release-proposal 0.2.0 0.3.0                LIVE, matching NO release
//
// So the live population contains NEITHER of the two shapes a careless
// migration would assume. A step written as "join every proposal to its
// release" silently drops `0.2.0` and `0.3.0`; a step written as "every
// release once had a proposal" fabricates or loses a target for `0.1.0`-`0.1.3`.
// BOTH shapes are in the synthetic population below, beside the consumed pair
// and the revised pair that the live store happens not to hold today — because
// it held one yesterday and will again.
//
// ── The step is found BY ITS DESCRIPTION ──────────────────────────────────
//
// Never by index and never by the chain's length, exactly as
// tests/milestone-record-migration.test.ts and tests/milestone-dates-migration
// .test.ts find their own. THIS CR now owns TWO steps (§S1's date columns and
// §S2's unification), so the locator here matches `§S2` specifically rather
// than the CR id alone.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every case is a scratch file this suite builds itself; the real-scale case
// builds a POPULATED store (tests/helpers/populated-store.ts) and ages it the
// same way the synthetic case does. Nothing here reads the operator's dev
// store or talks to the running board.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";
import { populateStore } from "./helpers/populated-store.ts";

const ORCH = "cru130-c2-migration";

/** The type name §S2 retires. Pinned once, here, because "no record of this
 *  type survives" is unstatable without naming it. */
const RETIRED_TYPE = "release-proposal";

/** Epoch SECONDS. */
const SHIPPED_AT = 1_787_149_125;
const TARGET_AT = 1_789_171_200;
const DAY = 86_400;

interface ChainStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
}

/** One record row, as it is STORED — the blob compared as a string. */
interface StoredRow {
  id: string;
  project_key: string;
  agent_id: string;
  tier: string;
  codec: string | null;
  timestamp: number;
  type: string | null;
  label: string | null;
  payload: string | null;
  context: string | null;
  role: string | null;
  role_inferred: number | null;
  retired_at: number | null;
  cycle_id: number | null;
  target_at: number | null;
  delivered_at: number | null;
}

interface AnyBody {
  ok: boolean;
  proposals?: Array<{ label: string; targetAt?: number }>;
  releases?: Array<{ version?: string; releasedAt?: number; crs?: string[] }>;
  [key: string]: unknown;
}

/** What ONE label must look like after the step, derived from the rows that
 *  were there BEFORE it — never hand-pinned, so the same rule judges the
 *  synthetic population and the populated one. */
interface Expectation {
  projectKey: string;
  label: string;
  targetAt: number | null;
  deliveredAt: number | null;
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-130 §S2: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/** The ONE step this section owns, found by what it DECLARES. */
function unificationStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => /CR-(CRU-)?130 §S2/.test(step.description ?? ""));
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-130 §S2: expected exactly ONE step in the ${String(chain.length)}-step migration ` +
        `chain to declare the release unification (its description must name CR-130 §S2), found ` +
        `${String(owned.length)}. Without it, every existing board keeps two records pretending ` +
        `to be two types: the roadmap renders a shipped release beside the ghost of the proposal ` +
        `it fulfilled, and "what is outstanding" cannot be asked of a release at all.`,
    );
  }
  return owned[0]!;
}

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

/**
 * The chain position this CR's §S2 step occupies, or the chain's length while
 * it does not exist yet.
 *
 * Deliberately NOT `unificationStep()`: the two helpers below need the version
 * the step upgrades FROM in order to BUILD their fixture, and a fixture builder
 * that threw would bury the evidence its case collects behind a duplicate of
 * the failure the case above already states. That case — "exactly ONE step
 * declares the unification" — is where the step's absence is reported.
 */
function unificationPosition(): number {
  const chain = migrationChain();
  const at = chain.findIndex((step) => /CR-(CRU-)?130 §S2/.test(step.description ?? ""));
  return at === -1 ? chain.length : at;
}

/**
 * Put an AGED store back to the version §S2's step upgrades from.
 *
 * Post-GREEN an ordinary `Store.open` stamps the chain's END, so the step this
 * file is about would never run against the rows `ageToPreUnification` just
 * wrote. Before GREEN the store already sits at that version and this is a
 * no-op — the same statement, doing real work only once there is a step to
 * re-run.
 */
function stampToStepFrom(db: Database): void {
  db.exec(`PRAGMA user_version = ${String(unificationPosition())}`);
}

function storedRows(db: Database): StoredRow[] {
  return db
    .query<StoredRow, []>(
      `SELECT id, project_key, agent_id, tier, codec, timestamp, type, label, payload, context,
              role, role_inferred, retired_at, cycle_id, target_at, delivered_at
         FROM milestones ORDER BY id`,
    )
    .all();
}

function payloadOf(row: StoredRow): Record<string, unknown> {
  return JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * THE RULE, written once and applied to both populations.
 *
 * For every (project, label) the store holds a release or a proposal for:
 *   DELIVERED — whatever the `release` row already said (`deliveredAt`, or
 *     `releasedAt`, the same date under its older name). A label with no
 *     release row is OUTSTANDING, and stays so.
 *   TARGET — the LIVE proposal's, or, if every proposal for the label was
 *     consumed or superseded, the newest one's; failing that, whatever target
 *     the release itself declared. Never invented: a label that never declared
 *     one keeps NULL.
 */
function expectationsFrom(rows: StoredRow[]): Expectation[] {
  const groups = new Map<string, StoredRow[]>();
  for (const row of rows) {
    if (row.type !== "release" && row.type !== RETIRED_TYPE) continue;
    if (row.label === null) continue;
    const groupKey = `${row.project_key}\u0000${row.label}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  return [...groups.entries()].map(([groupKey, members]) => {
    const [projectKey, label] = groupKey.split("\u0000") as [string, string];
    const releases = members.filter((row) => row.type === "release");
    const proposals = members
      .filter((row) => row.type === RETIRED_TYPE)
      .sort((a, b) => b.timestamp - a.timestamp);
    const delivered = releases
      .map((row) => {
        const payload = payloadOf(row);
        return numberOr(payload.deliveredAt) ?? numberOr(payload.releasedAt);
      })
      .find((value) => value !== null);
    const live = proposals.find((row) => row.retired_at === null);
    const target =
      numberOr(live === undefined ? undefined : payloadOf(live).targetAt) ??
      numberOr(proposals[0] === undefined ? undefined : payloadOf(proposals[0]).targetAt) ??
      numberOr(releases[0] === undefined ? undefined : payloadOf(releases[0]).targetAt);
    return {
      projectKey,
      label,
      targetAt: target ?? null,
      deliveredAt: delivered ?? null,
    };
  });
}

/**
 * Turn a store into the shape a PRE-§S2 board really has.
 *
 * Built by AGEING what the ordinary door wrote rather than by hand-INSERTing
 * rows, the idiom tests/milestone-dates-migration.test.ts established: a
 * fixture that could only be produced by a pre-GREEN build would stop testing
 * the migration the moment the migration existed. Every statement here is a
 * no-op against today's build — which already writes this shape — and does
 * real work against a post-GREEN one, so the fixture is the same either way.
 */
function ageToPreUnification(db: Database, at: number): void {
  // 1. An UNDELIVERED release is what a proposal became. Put it back.
  db.query(
    `UPDATE milestones
        SET type = ?, payload = json_set(payload, '$.type', ?)
      WHERE type = 'release' AND delivered_at IS NULL`,
  ).run(RETIRED_TYPE, RETIRED_TYPE);
  // 2. Pre-§S2, shipping CONSUMED the proposal for its label by stamping
  //    `retired_at` — the use of the column this CR removes.
  db.query(
    `UPDATE milestones
        SET retired_at = COALESCE(retired_at, ?)
      WHERE type = ? AND retired_at IS NULL
        AND label IN (SELECT label FROM milestones
                       WHERE type = 'release' AND delivered_at IS NOT NULL)`,
  ).run(at, RETIRED_TYPE);
  // 3. A release written before CR-130 §S1 spells its delivery `releasedAt`
  //    and nothing else. `json_remove` touches only that key.
  db.exec(
    `UPDATE milestones SET payload = json_remove(payload, '$.deliveredAt')
      WHERE type = 'release' AND json_extract(payload, '$.releasedAt') IS NOT NULL`,
  );
  // 4. CR-CRU-130 §S2, GREEN — the CONSUMED PAIR, which steps 1-3 cannot
  //    reconstruct and which this helper's own claim ("the fixture is the same
  //    either way") silently missed.
  //
  //    Post-§S2 a proposal that was shipped is ONE row carrying both the
  //    target it declared and the date it was met; steps 1-3 only re-type an
  //    UNDELIVERED release and re-stamp `retired_at`, so neither can SPLIT
  //    that row back into the pair a pre-§S2 board really held. Without this,
  //    the guards below count 3 proposals where a pre-§S2 board has 4, and the
  //    case's whole subject — a proposal a shipped release consumed — is
  //    absent from the population it claims to cover.
  //
  //    So the pair is put back the way a pre-§S2 board wrote it: the target
  //    moves OFF the delivered release (which never carried one before this
  //    CR) and onto a `release-proposal` row for the same label, stamped
  //    `retired_at` because shipping is what consumed it. A no-op on a
  //    pre-§S2 build, where no delivered release carries a target for it to
  //    move — measured on both builds rather than assumed.
  for (const row of db
    .query<{ id: string; project_key: string; agent_id: string; tier: string;
             label: string | null; timestamp: number; target_at: number | null }, []>(
      `SELECT id, project_key, agent_id, tier, label, timestamp,
              json_extract(payload, '$.targetAt') AS target_at
         FROM milestones
        WHERE type = 'release' AND delivered_at IS NOT NULL
          AND json_extract(payload, '$.targetAt') IS NOT NULL`,
    )
    .all()) {
    db.query(
      `INSERT INTO milestones (id, project_key, agent_id, tier, timestamp, type, label,
         target_at, payload, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${row.id}-consumed-proposal`,
      row.project_key,
      row.agent_id,
      row.tier,
      row.timestamp - 1,
      RETIRED_TYPE,
      row.label,
      row.target_at,
      JSON.stringify({ type: RETIRED_TYPE, label: row.label, targetAt: row.target_at }),
      at,
    );
    db.query(
      `UPDATE milestones SET payload = json_remove(payload, '$.targetAt'), target_at = NULL
        WHERE id = ?`,
    ).run(row.id);
  }
}

describe("CR-CRU-130 §S2 — two types become one record, and history keeps everything else", () => {
  const scratchDirs: string[] = [];
  const openDbs: Database[] = [];
  const handles: ServerHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  /** A direct handle on a SCRATCH file this suite built — never the
   *  operator's dev store. */
  function raw(dbPath: string): Database {
    const db = new Database(dbPath);
    openDbs.push(db);
    return db;
  }

  function closeRaw(db: Database): void {
    db.close();
    const at = openDbs.indexOf(db);
    if (at >= 0) openDbs.splice(at, 1);
  }

  function boot(dbPath: string): ServerHandle {
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);
    return handle;
  }

  async function get(handle: ServerHandle, path: string): Promise<AnyBody> {
    const res = await fetch(`http://localhost:${String(handle.server.port)}${path}`);
    return (await res.json()) as AnyBody;
  }

  // ── AC — the step exists, and it ENDS the chain ─────────────────────────

  test(
    "exactly ONE migration step declares the release unification, at version 13, following its " +
      "predecessor in the chain",
    () => {
      const step = unificationStep();

      // The chain's positions ARE the version numbers (CR-CRU-071 §S1), so a
      // step that does not end the chain means this build writes a version it
      // does not produce. C1 ended the chain at 12 and this step took it to
      // 13; later steps may follow it, so the pin is its own rung, not the end.
      expect(step.to).toBe(13);
      expect(step.to).toBe(step.from + 1);
      expect(migrationChain()[step.from]).toBe(step);
      expect(SCHEMA_VERSION).toBe(migrationChain().length);
      // …and it is a step BEYOND §S1's, never a rewrite of it: the two are
      // separate rungs, so a board already migrated by C1 is not re-migrated.
      expect(step.from).toBeGreaterThanOrEqual(12);
    },
  );

  // ── AC — the whole proof, over whatever population it is handed ─────────

  /**
   * Migrate the store at `dbPath` to the end of the chain and prove the four
   * things §S2's step promises:
   *
   *   1. NO `release-proposal` RECORD SURVIVES — column or payload.
   *   2. EVERY LABEL IS ONE RECORD, carrying the target and the delivery the
   *      pre-state's rows said it had, by the rule in `expectationsFrom`.
   *   3. EVERY OTHER MILESTONE IS BYTE-IDENTICAL — a `cr-merged`, a `custom`,
   *      a `gap-analysis` row keeps every column including its payload blob.
   *   4. A SECOND BOOT CHANGES NOTHING.
   */
  async function proveUnification(dbPath: string): Promise<{
    before: StoredRow[];
    expectations: Expectation[];
    untouched: number;
  }> {
    const pre = raw(dbPath);
    const before = storedRows(pre);
    closeRaw(pre);

    const expectations = expectationsFrom(before);
    const untouchedBefore = before.filter(
      (row) => row.type !== "release" && row.type !== RETIRED_TYPE,
    );

    const handle = boot(dbPath);
    const after = raw(dbPath);
    const now = storedRows(after);

    // 1. THE TYPE IS GONE, in both representations.
    expect(now.filter((row) => row.type === RETIRED_TYPE).map((row) => row.id)).toEqual([]);
    expect(
      now.filter((row) => payloadOf(row).type === RETIRED_TYPE).map((row) => row.id),
    ).toEqual([]);

    // 2. EVERY LABEL IS ONE RECORD, carrying what the pre-state said.
    const faults: string[] = [];
    for (const expectation of expectations) {
      const held = now.filter(
        (row) =>
          row.project_key === expectation.projectKey &&
          row.label === expectation.label &&
          row.type === "release",
      );
      if (held.length !== 1) {
        faults.push(
          `${expectation.label}: ${String(held.length)} release records, expected exactly 1`,
        );
        continue;
      }
      const row = held[0]!;
      const payload = payloadOf(row);
      if (row.target_at !== expectation.targetAt) {
        faults.push(
          `${expectation.label}: target_at=${String(row.target_at)} expected ${String(expectation.targetAt)}`,
        );
      }
      if (row.delivered_at !== expectation.deliveredAt) {
        faults.push(
          `${expectation.label}: delivered_at=${String(row.delivered_at)} expected ${String(expectation.deliveredAt)}`,
        );
      }
      // The column and the blob cannot disagree — CR-CRU-129's rule, which a
      // migration that wrote only columns would break on every rewritten row.
      if (numberOr(payload.targetAt) !== expectation.targetAt) {
        faults.push(
          `${expectation.label}: payload targetAt=${String(payload.targetAt)} expected ${String(expectation.targetAt)}`,
        );
      }
      if (payload.type !== "release") {
        faults.push(`${expectation.label}: payload type=${String(payload.type)} expected release`);
      }
      // `retired_at` no longer carries delivery.
      if (row.retired_at !== null) {
        faults.push(`${expectation.label}: retired_at=${String(row.retired_at)} expected NULL`);
      }
    }
    expect(faults).toEqual([]);

    // 3. EVERY OTHER MILESTONE IS BYTE-IDENTICAL.
    const untouchedAfter = new Map(
      now.filter((row) => row.type !== "release").map((row) => [row.id, row]),
    );
    for (const was of untouchedBefore) {
      const found = untouchedAfter.get(was.id);
      expect(found).toBeDefined();
      expect({ ...found! }).toEqual({ ...was });
    }

    // 4. A SECOND BOOT CHANGES NOTHING.
    closeRaw(after);
    handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    const second = boot(dbPath);
    const rerun = raw(dbPath);
    const settled = storedRows(rerun);
    expect(settled).toEqual(now);
    closeRaw(rerun);
    // The re-booted server still ANSWERS, rather than refusing an
    // already-migrated store — a non-idempotent rewrite's failure mode.
    expect((await get(second, `/api/v2/projects/${before[0]!.project_key}/releases`)).ok).toBe(true);

    return { before, expectations, untouched: untouchedBefore.length };
  }

  // ── AC — a synthetic population holding all four shapes ─────────────────

  test(
    "a live proposal with no release, a delivered release with no proposal, a CONSUMED pair and a " +
      "REVISED proposal all migrate into one record each",
    async () => {
      const dbPath = join(scratch("cru130-c2-synthetic-"), "crucible.db");
      const store = Store.open(dbPath);
      const key = crypto.randomUUID();
      store.addProject({ key, name: "cru130-c2-synthetic", type: "backend", sutRoot: "/tmp" });

      // L1 — an OUTSTANDING proposal matching NO release. The live store's
      // `0.2.0`/`0.3.0` shape: a migration that joins proposals to releases
      // drops it.
      store.recordReleaseProposal(key, ORCH, { label: "0.2.0", targetAt: TARGET_AT });
      // L2 — a DELIVERED release that never had a proposal, and declared no
      // target. The live store's `0.1.0`-`0.1.3` shape: a migration that
      // assumes every release once had one invents or loses a date.
      store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.1.0",
        commit: "a".repeat(40),
        releasedAt: SHIPPED_AT,
        crs: ["CR-SHIPPED-1"],
        packages: [{ registry: "npm", name: "@anthill-tec/crucible-server", version: "0.1.0" }],
      });
      // L3 — a proposal ALREADY CONSUMED by a shipped release: it must become
      // that release's DELIVERY, carrying the target it declared, not a
      // duplicate row.
      store.recordReleaseProposal(key, ORCH, { label: "0.5.0", targetAt: TARGET_AT + 7 * DAY });
      store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.5.0",
        commit: "b".repeat(40),
        releasedAt: SHIPPED_AT + 7 * DAY,
        crs: ["CR-SHIPPED-2"],
      });
      // L4 — a REVISED proposal: the superseded row and the live one, one
      // label. The live target wins; the record stays OUTSTANDING.
      store.recordReleaseProposal(key, ORCH, { label: "0.6.0", targetAt: TARGET_AT + 14 * DAY });
      store.recordReleaseProposal(key, ORCH, { label: "0.6.0", targetAt: TARGET_AT + 21 * DAY });
      // …and the milestones that are none of this CR's business.
      store.recordMilestoneEvent(key, ORCH, "cr-merged", {
        label: "CR-SHIPPED-1",
        commit: "c".repeat(40),
        context: { cycleId: 451 },
      });
      store.recordMilestoneEvent(key, ORCH, "custom", {
        label: "a dated goal of another kind",
        targetAt: TARGET_AT + 28 * DAY,
      });
      store.recordMilestoneEvent(key, ORCH, "gap-analysis", { label: "CR-SHIPPED-2" });
      closeStore(store);

      const aging = raw(dbPath);
      ageToPreUnification(aging, SHIPPED_AT * 1000);
      // THE AGEING REALLY PRODUCED THE PRE-§S2 SHAPE — otherwise the case
      // below would be migrating a store that needed no migration.
      const aged = storedRows(aging);
      expect(aged.filter((row) => row.type === RETIRED_TYPE).length).toBe(4);
      expect(
        aged.filter((row) => row.type === RETIRED_TYPE && row.retired_at !== null).length,
      ).toBe(2);
      expect(aged.filter((row) => row.type === "release").length).toBe(2);
      stampToStepFrom(aging);
      closeRaw(aging);

      const proof = await proveUnification(dbPath);

      // NON-VACUITY — the four shapes really were there, and the untouched
      // types really were compared.
      expect(proof.expectations.map((e) => e.label).sort()).toEqual([
        "0.1.0",
        "0.2.0",
        "0.5.0",
        "0.6.0",
      ]);
      expect(proof.untouched).toBe(3);

      const byLabel = new Map(proof.expectations.map((e) => [e.label, e]));
      // Each shape's own answer, stated rather than inferred from the rule.
      expect(byLabel.get("0.2.0")).toMatchObject({
        targetAt: TARGET_AT,
        deliveredAt: null,
      });
      expect(byLabel.get("0.1.0")).toMatchObject({ targetAt: null, deliveredAt: SHIPPED_AT });
      expect(byLabel.get("0.5.0")).toMatchObject({
        targetAt: TARGET_AT + 7 * DAY,
        deliveredAt: SHIPPED_AT + 7 * DAY,
      });
      expect(byLabel.get("0.6.0")).toMatchObject({
        targetAt: TARGET_AT + 21 * DAY,
        deliveredAt: null,
      });

      // AND THE TWO READS ANSWER THE MIGRATED POPULATION.
      const handle = handles[handles.length - 1]!;
      const key0 = proof.before[0]!.project_key;
      const releases = (await get(handle, `/api/v2/projects/${key0}/releases`)).releases ?? [];
      expect(releases.map((r) => r.version).sort()).toEqual(["0.1.0", "0.5.0"]);
      // The delivered release keeps its provenance verbatim.
      expect(releases.find((r) => r.version === "0.1.0")?.crs).toEqual(["CR-SHIPPED-1"]);
      const proposals =
        (await get(handle, `/api/v2/projects/${key0}/release-proposals`)).proposals ?? [];
      expect(proposals.map((p) => p.label)).toEqual(["0.2.0", "0.6.0"]);
      expect(proposals.map((p) => p.targetAt)).toEqual([TARGET_AT, TARGET_AT + 21 * DAY]);
    },
  );

  // ── AC — and at REAL scale, over a populated store ──────────────────────
  //
  // The synthetic case above holds each shape once. A long-used board holds
  // them many times over, across several projects (one archived), beside
  // dozens of milestones of other types — so the population here is built by
  // tests/helpers/populated-store.ts and aged by the SAME `ageToPreUnification`
  // the synthetic case uses, then judged by the same rule.

  test(
    "at real scale — several projects, where a proposal has no matching release and a release " +
      "has no surviving proposal — every label migrates into exactly one record",
    async () => {
      const dbPath = join(scratch("cru130-c2-populated-"), "crucible.db");
      const built = Store.open(dbPath);
      const populated = populateStore(built);
      closeStore(built);

      const aging = raw(dbPath);
      ageToPreUnification(aging, SHIPPED_AT * 1000);
      stampToStepFrom(aging);
      closeRaw(aging);

      const proof = await proveUnification(dbPath);

      // REAL SCALE, and the two partnerless shapes are really present.
      const proposalsBefore = proof.before.filter((row) => row.type === RETIRED_TYPE);
      const releasesBefore = proof.before.filter((row) => row.type === "release");
      expect(new Set(proof.before.map((row) => row.project_key)).size).toBe(populated.projects.length);
      expect(proposalsBefore.length).toBeGreaterThan(populated.projects.length);
      expect(releasesBefore.length).toBeGreaterThan(populated.projects.length);
      expect(proof.untouched).toBeGreaterThan(10);
      // THE TRAP, asserted as a property of the fixture rather than assumed:
      // at least one proposal whose label NO release shares, and at least one
      // release whose label NO proposal shares.
      const releaseLabels = new Set(releasesBefore.map((row) => row.label));
      const proposalLabels = new Set(proposalsBefore.map((row) => row.label));
      expect(proposalsBefore.filter((row) => !releaseLabels.has(row.label)).length).toBeGreaterThan(
        0,
      );
      expect(releasesBefore.filter((row) => !proposalLabels.has(row.label)).length).toBeGreaterThan(
        0,
      );
      // A CONSUMED pair and a REVISED proposal are there too.
      expect(
        proposalsBefore.filter((row) => row.retired_at !== null && releaseLabels.has(row.label)).length,
      ).toBeGreaterThan(0);
      const perLabel = new Map<string, number>();
      for (const row of proposalsBefore) {
        const groupKey = `${row.project_key}\u0000${row.label ?? ""}`;
        perLabel.set(groupKey, (perLabel.get(groupKey) ?? 0) + 1);
      }
      expect([...perLabel.values()].some((count) => count > 1)).toBe(true);
      // Both halves really exist after the rewrite.
      expect(proof.expectations.filter((e) => e.deliveredAt !== null).length).toBeGreaterThan(0);
      expect(proof.expectations.filter((e) => e.deliveredAt === null).length).toBeGreaterThan(0);
    },
  );
});
