// CR-CRU-130 §S1 — a milestone is a dated GOAL: what we intend to deliver,
// when it is due, and when it actually landed.
//
// ── What §S1 adds ─────────────────────────────────────────────────────────
//
//   `targetAt`    — when the milestone is DUE.   Absent = undated.
//   `deliveredAt` — when the milestone was MET.  Absent = outstanding.
//
// Both on EVERY type, both filtered COLUMNS on the `milestones` record table,
// derived at the one insert seam from the same payload fields the blob
// carries — the seam CR-CRU-129 established for `type`/`label` and CR-CRU-094
// established for `cycle_id`, so the two representations cannot disagree.
//
// ── The recorded decision this SUPERSEDES ─────────────────────────────────
//
// src/store.ts:2677-2680 today states, as a CR-CRU-091 §S1 decision, that "a
// declared target belongs to a PROPOSAL and nothing else" and that "a target
// it was once aimed at is not a fact about it", and ENFORCES it with
//
//     const targetAt = type === "release-proposal" ? meta?.targetAt : undefined;
//
// which silently DISCARDS a target sent for any other type. The user's
// 2026-09-13 ruling supersedes that narrower stance: a milestone is a dated
// goal, so what it was aimed at and when it landed are both facts about it,
// and the distance between them is the only thing that can say a deliverable
// slipped. The comment and the gate go together — a comment left asserting the
// opposite of shipped behaviour is the defect CR-CRU-128 spent a FIX round
// deleting — so this file asserts BOTH: the behaviour, and the absence of the
// claim. The comment assertion is scoped to the two SPECIFIC claims, never to
// any wording about targets, so a corrected comment explaining the
// supersession is free to stay.
//
// ── Two spellings are assumed here, and ONLY here ─────────────────────────
//
// The wire field names are the spec's own (`targetAt`, `deliveredAt`). The
// COLUMN names are a GREEN decision this file has to name in order to prove
// column/payload agreement at all; they are the schema's existing snake_case
// convention (`retired_at`, `cycle_id`) applied to the two new fields, and
// they are isolated in the two constants below. If GREEN spells them
// differently, those two constants move and nothing else in this file does.
//
// ── Units ─────────────────────────────────────────────────────────────────
// Epoch SECONDS, deliberately: `releasedAt` and `targetAt` are already
// seconds (src/types.ts:387-389, "because they are git's, not ours"), and
// `deliveredAt` is `releasedAt` generalised.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:`. The live `data/crucible.db` is never
// opened, copied or migrated, and nothing here talks to the running board.
// Fixture cr ids are drawn from the synthetic namespaces the project-namespace
// tripwire registers (`CR-SHIPPED-*`) — never a real board id.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { Store } from "../src/store.ts";
import type { RunEvent } from "../src/types.ts";

/** THE TWO SPELLING DECISIONS, isolated — see the header. */
const TARGET_COLUMN = "target_at";
const DELIVERED_COLUMN = "delivered_at";

const ORCH = "cru130-c1-fixture";

/** Epoch SECONDS. Distinct primes-ish offsets so no two fixtures collide. */
const TARGET_AT = 1_800_000_000;
const DELIVERED_AT = 1_801_234_567;
const DAY = 86_400;

/** The meta a dated milestone is written with — `deliveredAt` is what §S1 adds. */
type DatedMeta = NonNullable<Parameters<Store["recordMilestoneEvent"]>[3]> & {
  deliveredAt?: number;
};

/** A record as the wire serves it, with the two fields §S1 adds. */
interface DatedWire {
  id: string;
  kind?: string;
  type?: string;
  label?: string;
  commit?: string;
  releasedAt?: number;
  targetAt?: number;
  deliveredAt?: number;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  event?: string;
  milestones?: DatedWire[];
  totalCount?: number;
  project?: { key: string };
  [key: string]: unknown;
}

/** One raw row of the record table, columns and blob side by side. */
interface RawRecordRow {
  id: string;
  type: string | null;
  target_at: number | null;
  delivered_at: number | null;
  payload: string | null;
}

describe("a milestone carries its dates — every type, both dates, column and payload agreeing", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  function base(): string {
    return `http://localhost:${String(handle!.server.port)}`;
  }

  function store(): Store {
    return handle!.store;
  }

  function rawDb(): Database {
    return (handle!.store as unknown as { db: Database }).db;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function seedProject(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = (created.body.project as { key: string } | undefined)?.key;
    expect(typeof key).toBe("string");
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key!;
  }

  /**
   * The accepted milestone vocabulary, READ OFF THE SERVER — the refusal is
   * the only channel that publishes it, and it publishes it verbatim
   * (tests/milestone-records-survive-retention.test.ts:147 established this
   * read; this file reuses it rather than holding a second copy of the list).
   * A test that typed the six types would go stale the day a seventh lands.
   */
  async function milestoneVocabulary(key: string): Promise<string[]> {
    const refused = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "__definitely-not-a-milestone-type__",
    });
    expect(refused.status).toBe(400);
    const message = String(refused.body.error ?? "");
    const match = /type must be one of:\s*(.+)$/.exec(message);
    if (match === null) {
      throw new Error(
        `CR-CRU-130 §S1: cannot read the accepted milestone vocabulary off the server's own ` +
          `refusal — POST /api/v2/milestones answered ${JSON.stringify(message)}. This suite ` +
          `reads the vocabulary rather than holding a copy of it; fix the read, never pin a list.`,
      );
    }
    return match[1]!
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  /** A label that suits the type, so no fixture leans on a type's own rules. */
  function labelFor(type: string, index: number): string {
    if (type === "cr-merged") return `CR-SHIPPED-${String(index)}`;
    if (type === "release") return `9.${String(index)}.0`;
    return `${type}-goal-${String(index)}`;
  }

  async function postMilestone(key: string, body: Record<string, unknown>): Promise<string> {
    const res = await post("/api/v2/milestones", { projectKey: key, agentId: ORCH, ...body });
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.event).toBe("string");
    return res.body.event!;
  }

  async function recordsOfType(key: string, type: string): Promise<DatedWire[]> {
    const answered = await get(
      `/api/v2/projects/${key}/milestones?type=${encodeURIComponent(type)}`,
    );
    expect(answered.status).toBe(200);
    return answered.body.milestones ?? [];
  }

  async function recordById(key: string, type: string, id: string): Promise<DatedWire> {
    const found = (await recordsOfType(key, type)).find((row) => row.id === id);
    if (found === undefined) {
      throw new Error(
        `CR-CRU-130 §S1: the record just written (${id}, type ${type}) is not served by ` +
          `GET …/projects/<key>/milestones?type=${type} — the fixture, not the dates, is broken.`,
      );
    }
    return found;
  }

  function rawRows(): RawRecordRow[] {
    return rawDb()
      .query<RawRecordRow, []>(
        `SELECT id, type, ${TARGET_COLUMN}, ${DELIVERED_COLUMN}, payload FROM milestones`,
      )
      .all();
  }

  function milestoneColumns(): string[] {
    return rawDb()
      .query<{ name: string }, []>(`PRAGMA table_info(milestones)`)
      .all()
      .map((column) => column.name);
  }

  // ── AC — every type accepts and returns both dates, PER TYPE ─────────────

  test(
    "every milestone type the server accepts round-trips BOTH dates — one entry per type, " +
      "with the vocabulary read off the server rather than typed into the test",
    async () => {
      boot();
      const key = await seedProject("cru130-per-type");
      const types = await milestoneVocabulary(key);

      // NON-VACUITY: the loop below is the whole test. An empty or
      // one-element vocabulary would make it assert nothing, so the list is
      // proved non-empty AND proved to be the server's own answer (it came
      // back on a 400 refusal above, not from a literal here).
      expect(types.length).toBeGreaterThan(1);

      const expected: Record<string, { targetAt: number; deliveredAt: number }> = {};
      const observed: Record<string, { targetAt?: number; deliveredAt?: number }> = {};

      for (const [index, type] of types.entries()) {
        const targetAt = TARGET_AT + index * DAY;
        const deliveredAt = DELIVERED_AT + index * DAY;
        expected[type] = { targetAt, deliveredAt };
        const id = await postMilestone(key, {
          type,
          label: labelFor(type, index),
          targetAt,
          deliveredAt,
        });
        const row = await recordById(key, type, id);
        observed[type] = { targetAt: row.targetAt, deliveredAt: row.deliveredAt };
      }

      // Every type is named in this comparison, so a type that discards a date
      // is identified by NAME in the diff rather than hidden in an aggregate.
      expect(observed).toEqual(expected);
      // …and every type the server named was actually exercised.
      expect(Object.keys(observed).sort()).toEqual([...types].sort());
    },
  );

  // ── AC — the superseded gate: a release round-trips a target ─────────────

  test(
    "a `release` round-trips the `targetAt` it was aimed at, through the store's own write path, " +
      "without displacing the date it shipped",
    async () => {
      boot();
      const key = await seedProject("cru130-release-target");
      const meta: DatedMeta = {
        label: "9.9.0",
        commit: "c0ffee1",
        releasedAt: DELIVERED_AT,
        targetAt: TARGET_AT,
      };

      const written = store().recordMilestoneEvent(key, ORCH, "release", meta);

      // POSITIVE — the exact value, on the event the write returns…
      expect(written.changed).toBe(true);
      expect((written.event as RunEvent).targetAt).toBe(TARGET_AT);
      // …and on the record when it is read back, which is what "stored" means.
      const held = store().listReleases(key);
      expect(held).toHaveLength(1);
      expect(held[0]!.targetAt).toBe(TARGET_AT);
      // NEGATIVE — the target did not displace the ship date, and the label is
      // untouched: the two dates coexist on one record (§S1), which is the
      // whole point of unifying them.
      expect(held[0]!.releasedAt).toBe(DELIVERED_AT);
      expect(held[0]!.label).toBe("9.9.0");
    },
  );

  test("a `release` posted at the wire with a `targetAt` serves that target back", async () => {
    boot();
    const key = await seedProject("cru130-release-target-wire");

    const id = await postMilestone(key, {
      type: "release",
      label: "9.9.1",
      commit: "c0ffee2",
      releasedAt: DELIVERED_AT,
      targetAt: TARGET_AT,
    });

    const row = await recordById(key, "release", id);
    expect(row.targetAt).toBe(TARGET_AT);
    // NEGATIVE — the provenance the release already carried is unchanged.
    expect(row.releasedAt).toBe(DELIVERED_AT);
    expect(row.label).toBe("9.9.1");
  });

  test(
    "no comment in src/store.ts still claims a declared target belongs to a proposal alone, " +
      "or that a target is not a fact about the release it was aimed at",
    () => {
      const source = readFileSync(join(process.cwd(), "src", "store.ts"), "utf8");
      // NON-VACUITY: a mistyped path or an empty read would pass every
      // "contains no…" assertion below without looking at anything.
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toContain("recordMilestoneEvent");

      // Comment text, unwrapped: both claims are wrapped across `//` lines in
      // the source, so they are unreadable to a line-wise regex.
      const prose = source.replace(/^\s*\/\/ ?/gm, " ").replace(/\s+/g, " ");

      // SCOPED TO THE TWO CLAIMS, not to any wording about targets: a
      // corrected comment that explains WHY the narrower stance was
      // superseded is free to mention proposals, releases and targets.
      expect(prose).not.toMatch(/a declared target belongs to a PROPOSAL and nothing else/i);
      expect(prose).not.toMatch(/a target it was once aimed at is not a fact about it/i);
    },
  );

  // ── AC — column and payload cannot disagree ──────────────────────────────

  test(
    "both dates are filtered COLUMNS derived at the single insert seam: across records carrying " +
      "both, one, the other and neither, no row's column disagrees with its payload",
    async () => {
      boot();
      const key = await seedProject("cru130-columns");

      // Four shapes, written through the production route — the only door a
      // caller has, which is what makes divergence unreachable rather than
      // merely absent.
      const both = await postMilestone(key, {
        type: "custom",
        label: "both",
        targetAt: TARGET_AT,
        deliveredAt: DELIVERED_AT,
      });
      const targetOnly = await postMilestone(key, {
        type: "custom",
        label: "target-only",
        targetAt: TARGET_AT + DAY,
      });
      const deliveredOnly = await postMilestone(key, {
        type: "custom",
        label: "delivered-only",
        deliveredAt: DELIVERED_AT + DAY,
      });
      const neither = await postMilestone(key, { type: "custom", label: "neither" });

      expect(milestoneColumns()).toContain(TARGET_COLUMN);
      expect(milestoneColumns()).toContain(DELIVERED_COLUMN);

      const rows = rawRows();
      // BOUND — exactly the four written, so a fifth row (a second
      // representation written beside the first) fails here.
      expect(rows.map((row) => row.id).sort()).toEqual(
        [both, targetOnly, deliveredOnly, neither].sort(),
      );

      const disagreements = rows.flatMap((row) => {
        const payload = JSON.parse(row.payload ?? "{}") as {
          targetAt?: number;
          deliveredAt?: number;
        };
        const mismatch: string[] = [];
        if (row[TARGET_COLUMN] !== (payload.targetAt ?? null)) {
          mismatch.push(
            `${row.id}: ${TARGET_COLUMN}=${String(row[TARGET_COLUMN])} payload.targetAt=${String(payload.targetAt)}`,
          );
        }
        if (row[DELIVERED_COLUMN] !== (payload.deliveredAt ?? null)) {
          mismatch.push(
            `${row.id}: ${DELIVERED_COLUMN}=${String(row[DELIVERED_COLUMN])} payload.deliveredAt=${String(payload.deliveredAt)}`,
          );
        }
        return mismatch;
      });
      expect(disagreements).toEqual([]);

      // NON-VACUITY — the comparison above is trivially satisfied by four rows
      // that all hold NULL/NULL. Each of the four shapes is asserted to be
      // present and DISTINCT, so the agreement is proved over real values.
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(both)![TARGET_COLUMN]).toBe(TARGET_AT);
      expect(byId.get(both)![DELIVERED_COLUMN]).toBe(DELIVERED_AT);
      expect(byId.get(targetOnly)![TARGET_COLUMN]).toBe(TARGET_AT + DAY);
      expect(byId.get(targetOnly)![DELIVERED_COLUMN]).toBeNull();
      expect(byId.get(deliveredOnly)![TARGET_COLUMN]).toBeNull();
      expect(byId.get(deliveredOnly)![DELIVERED_COLUMN]).toBe(DELIVERED_AT + DAY);
      expect(byId.get(neither)![TARGET_COLUMN]).toBeNull();
      expect(byId.get(neither)![DELIVERED_COLUMN]).toBeNull();
    },
  );

  // ── AC — absent is a real state ──────────────────────────────────────────

  test(
    "an UNDATED milestone round-trips with both fields absent — not zero, not epoch, not null",
    async () => {
      boot();
      const key = await seedProject("cru130-undated");

      const id = await postMilestone(key, { type: "design-review", label: "undated" });

      const row = await recordById(key, "design-review", id);
      // The KEY is absent, which is the distinction the AC is about: a wire
      // that answered `null` or `0` would satisfy a bare falsiness check and
      // would make "what is outstanding" unanswerable.
      expect(Object.keys(row)).not.toContain("targetAt");
      expect(Object.keys(row)).not.toContain("deliveredAt");
      expect(row.targetAt).toBeUndefined();
      expect(row.deliveredAt).toBeUndefined();
      // …and the columns hold NULL rather than 0.
      const stored = rawRows().find((raw) => raw.id === id)!;
      expect(stored[TARGET_COLUMN]).toBeNull();
      expect(stored[DELIVERED_COLUMN]).toBeNull();
    },
  );

  test(
    "an OUTSTANDING milestone — dated but not met — round-trips with `deliveredAt` absent while " +
      "its target comes back exactly",
    async () => {
      boot();
      const key = await seedProject("cru130-outstanding");

      const id = await postMilestone(key, {
        type: "stage-flip",
        label: "outstanding",
        targetAt: TARGET_AT,
      });

      const row = await recordById(key, "stage-flip", id);
      expect(row.targetAt).toBe(TARGET_AT);
      expect(Object.keys(row)).not.toContain("deliveredAt");
      expect(row.deliveredAt).toBeUndefined();
      const stored = rawRows().find((raw) => raw.id === id)!;
      expect(stored[TARGET_COLUMN]).toBe(TARGET_AT);
      expect(stored[DELIVERED_COLUMN]).toBeNull();
    },
  );

  // ── AC — a project-defined type carries them too ─────────────────────────

  test(
    "a type the server learned at RUNTIME carries both dates, under its own name, and is never " +
      "rewritten to `custom`",
    async () => {
      boot();
      const key = await seedProject("cru130-project-defined");
      const projectType = "roadmap-review";

      // NON-VACUITY — this type really is one the server does not know, so the
      // assertions below are about a PROJECT-defined type rather than about a
      // seventh built-in. (Opening the POST validator is CR-CRU-130 §S4's job,
      // a later cycle; the store's `type` column is unconstrained TEXT, so the
      // record is writable today and the read must serve it.)
      expect(await milestoneVocabulary(key)).not.toContain(projectType);

      const meta: DatedMeta = {
        label: "wave-6 roadmap review",
        targetAt: TARGET_AT,
        deliveredAt: DELIVERED_AT,
      };
      const written = store().recordMilestoneEvent(key, ORCH, projectType, meta);

      const row = await recordById(key, projectType, written.event.id);
      expect(row.targetAt).toBe(TARGET_AT);
      expect(row.deliveredAt).toBe(DELIVERED_AT);
      expect(row.type).toBe(projectType);
      // NEGATIVE — it did not collapse into `custom`, the thing §S1's dates
      // would be useless for if it did.
      expect((await recordsOfType(key, "custom")).map((entry) => entry.id)).toEqual([]);
    },
  );
});
