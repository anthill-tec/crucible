// CR-CRU-130 §S1 — the questions the dates exist to answer.
//
// "A project can ask what is outstanding and what slipped: milestones are
//  queryable by delivered/undelivered and by target date, and the answer
//  includes project-defined types" — and that query EXTENDS CR-CRU-129 §S3's
// existing record read (`GET …/projects/<key>/milestones`,
// `listMilestonesByType`, `idx_milestones_project_type`) rather than adding a
// second one. It stays UNWINDOWED and PROJECTION-FREE, as that route's own
// rationale requires (src/v2.ts:1939-1971).
//
// ── THE ONE SPELLING DECISION, isolated in `milestonesQuery` below ────────
//
//   GET …/projects/<key>/milestones?delivered=false          → outstanding
//   GET …/projects/<key>/milestones?delivered=true           → met
//   GET …/projects/<key>/milestones?targetBefore=<epoch s>   → due before
//   GET …/projects/<key>/milestones?targetAfter=<epoch s>    → due after
//   …each combinable with the EXISTING `?type=`, which keeps its meaning.
//
// `type` becomes OPTIONAL when a date filter is present, because "what is
// outstanding" is a question ACROSS types — the AC says the answer includes
// project-defined types — while a request naming NO parameter at all stays
// refused exactly as it is today (that is the "whole timeline" question, and
// `GET /api/v2/events` is what answers it).
//
// Every assertion below is about BEHAVIOUR — which records come back, and
// whether anything can bound or narrow the answer — so if GREEN rules a
// different spelling, `milestonesQuery` is the only thing in this file that
// moves.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:`. The live `data/crucible.db` is never
// opened, copied or migrated, and nothing here talks to the running board.
// Fixture cr ids come from the synthetic namespaces the project-namespace
// tripwire registers (`CR-SHIPPED-*`) — never a real board id.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { Store } from "../src/store.ts";

const ORCH = "cru130-c1-query";

/** Epoch SECONDS (the unit `targetAt`/`releasedAt` already use). */
const DAY = 86_400;
const EARLY_TARGET = 1_800_000_000;
const LATE_TARGET = EARLY_TARGET + 30 * DAY;
const CUTOFF = EARLY_TARGET + 15 * DAY;
const DELIVERED_AT = 1_780_000_000;

/**
 * A population big enough that ANY window a lazy implementation might reach
 * for would be visible as a short answer. Nothing here configures a limit and
 * no assertion treats this as a bound: every expectation is derived from the
 * ids actually written.
 */
const WIDE_POPULATION = 120;

type DatedMeta = NonNullable<Parameters<Store["recordMilestoneEvent"]>[3]> & {
  deliveredAt?: number;
};

interface DatedWire {
  id: string;
  type?: string;
  label?: string;
  commit?: string;
  targetAt?: number;
  deliveredAt?: number;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  milestones?: DatedWire[];
  totalCount?: number;
  project?: { key: string };
  [key: string]: unknown;
}

describe("what is outstanding, and what slipped — milestones answer by date", () => {
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

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

  // ── the ONE route-shape decision, isolated ───────────────────────────────

  function milestonesQuery(
    key: string,
    params: { type?: string; delivered?: boolean; targetBefore?: number; targetAfter?: number },
  ): string {
    const query = new URLSearchParams();
    if (params.type !== undefined) query.set("type", params.type);
    if (params.delivered !== undefined) query.set("delivered", String(params.delivered));
    if (params.targetBefore !== undefined) query.set("targetBefore", String(params.targetBefore));
    if (params.targetAfter !== undefined) query.set("targetAfter", String(params.targetAfter));
    return `/api/v2/projects/${key}/milestones?${query.toString()}`;
  }

  async function ask(
    key: string,
    params: { type?: string; delivered?: boolean; targetBefore?: number; targetAfter?: number },
  ): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${milestonesQuery(key, params)}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function answeredIds(
    key: string,
    params: { type?: string; delivered?: boolean; targetBefore?: number; targetAfter?: number },
  ): Promise<string[]> {
    const answered = await ask(key, params);
    expect(answered.status).toBe(200);
    return (answered.body.milestones ?? []).map((row) => row.id).sort();
  }

  // ── fixture ──────────────────────────────────────────────────────────────

  /**
   * The project-defined type is written through the STORE, deliberately: the
   * POST validator is still closed until §S4 opens it, while the store's
   * `type` column is unconstrained TEXT and the read route refuses to check
   * the type against anything (src/v2.ts:1950-1958). So a type the server
   * learned at runtime is recordable and readable TODAY, which is what makes
   * the AC's "the answer includes project-defined types" testable now.
   */
  function record(key: string, type: string, meta: DatedMeta): string {
    return store().recordMilestoneEvent(key, ORCH, type, meta).event.id;
  }

  interface Population {
    readonly key: string;
    /** met, with a delivered date */
    readonly deliveredIds: string[];
    /** dated but not met — the outstanding ones */
    readonly outstandingIds: string[];
    /** no dates at all */
    readonly undatedId: string;
    /** outstanding AND of a type the server never heard of */
    readonly projectDefinedId: string;
    /** outstanding, due BEFORE the cutoff */
    readonly dueEarlyIds: string[];
    /** outstanding, due AFTER the cutoff */
    readonly dueLateIds: string[];
    /** every record of type `custom`, delivered and outstanding alike */
    readonly customIds: string[];
    /** the `custom` one that HAS been delivered */
    readonly deliveredCustomId: string;
  }

  async function seedPopulation(name: string): Promise<Population> {
    const key = await seedProject(name);

    const deliveredRelease = record(key, "release", {
      label: "9.8.0",
      commit: "aaa1111",
      releasedAt: DELIVERED_AT,
      targetAt: EARLY_TARGET,
      deliveredAt: DELIVERED_AT,
    } as DatedMeta);
    const deliveredMerge = record(key, "cr-merged", {
      label: "CR-SHIPPED-1",
      commit: "bbb2222",
      deliveredAt: DELIVERED_AT + DAY,
    } as DatedMeta);

    const dueEarly = record(key, "stage-flip", { label: "beta", targetAt: EARLY_TARGET });
    const dueLate = record(key, "custom", { label: "hardening", targetAt: LATE_TARGET });
    // A SECOND `custom` record, delivered — so `?type=custom` and
    // `?type=custom&delivered=false` have DIFFERENT answers. Without it the
    // combination test would pass on a server that ignored the date filter
    // entirely, which is exactly what today's server does.
    const deliveredCustom = record(key, "custom", {
      label: "shipped hardening",
      targetAt: EARLY_TARGET,
      deliveredAt: DELIVERED_AT + 2 * DAY,
    } as DatedMeta);
    const projectDefined = record(key, "roadmap-review", {
      label: "wave-6 review",
      targetAt: EARLY_TARGET + DAY,
    });

    const undated = record(key, "design-review", { label: "ad-hoc" });

    return {
      key,
      deliveredIds: [deliveredRelease, deliveredMerge, deliveredCustom].sort(),
      outstandingIds: [dueEarly, dueLate, projectDefined, undated].sort(),
      undatedId: undated,
      projectDefinedId: projectDefined,
      dueEarlyIds: [dueEarly, projectDefined].sort(),
      dueLateIds: [dueLate].sort(),
      customIds: [dueLate, deliveredCustom].sort(),
      deliveredCustomId: deliveredCustom,
    };
  }

  // ── AC — queryable by delivered / undelivered ────────────────────────────

  test(
    "asking what is OUTSTANDING answers every undelivered milestone across every type, including " +
      "a type the server learned at runtime, and none of the delivered ones",
    async () => {
      boot();
      const population = await seedPopulation("cru130-outstanding-query");

      const outstanding = await answeredIds(population.key, { delivered: false });

      // POSITIVE — the exact set, not a count: every undelivered record, of
      // four different types, one of which the server has never heard of.
      expect(outstanding).toEqual(population.outstandingIds);
      expect(outstanding).toContain(population.projectDefinedId);
      // NEGATIVE — nothing delivered leaked in. A filter that answered
      // "everything" would pass a containment check and fail here.
      for (const delivered of population.deliveredIds) {
        expect(outstanding).not.toContain(delivered);
      }
      // BOUND — non-vacuity: the project really does hold delivered records
      // too, so the answer above is a NARROWING rather than the whole table.
      expect(population.deliveredIds.length).toBeGreaterThan(0);
    },
  );

  test("asking what has been DELIVERED answers exactly the met milestones", async () => {
    boot();
    const population = await seedPopulation("cru130-delivered-query");

    const delivered = await answeredIds(population.key, { delivered: true });

    expect(delivered).toEqual(population.deliveredIds);
    // NEGATIVE — an UNDATED record is not delivered, and neither is a merely
    // targeted one: absence of `deliveredAt` is the whole signal.
    expect(delivered).not.toContain(population.undatedId);
    expect(delivered).not.toContain(population.projectDefinedId);
  });

  // ── AC — queryable by target date ────────────────────────────────────────

  test(
    "asking what is due BEFORE a date answers only the milestones targeted before it — and never " +
      "the undated ones, which are due at no time at all",
    async () => {
      boot();
      const population = await seedPopulation("cru130-target-before");

      const dueBefore = await answeredIds(population.key, {
        delivered: false,
        targetBefore: CUTOFF,
      });

      expect(dueBefore).toEqual(population.dueEarlyIds);
      // NEGATIVE — the later target is excluded (so the bound is really
      // applied) and the UNDATED record is excluded (so absence is not being
      // read as zero, which would make every undated milestone permanently
      // overdue).
      for (const late of population.dueLateIds) expect(dueBefore).not.toContain(late);
      expect(dueBefore).not.toContain(population.undatedId);
    },
  );

  test("asking what is due AFTER a date answers only the milestones targeted after it", async () => {
    boot();
    const population = await seedPopulation("cru130-target-after");

    const dueAfter = await answeredIds(population.key, { delivered: false, targetAfter: CUTOFF });

    expect(dueAfter).toEqual(population.dueLateIds);
    for (const early of population.dueEarlyIds) expect(dueAfter).not.toContain(early);
    expect(dueAfter).not.toContain(population.undatedId);
  });

  // ── AC — it EXTENDS the existing surface ─────────────────────────────────

  test(
    "the date filters COMBINE with the existing `?type=` rather than replacing it: one type, " +
      "outstanding only",
    async () => {
      boot();
      const population = await seedPopulation("cru130-type-plus-dates");

      const everyCustom = await answeredIds(population.key, { type: "custom" });
      const outstandingCustom = await answeredIds(population.key, {
        type: "custom",
        delivered: false,
      });

      // The type filter still means what CR-CRU-129 §S3 made it mean…
      expect(everyCustom).toEqual(population.customIds);
      // …and the date filter NARROWS within it. The project holds two `custom`
      // records, one delivered and one not, so a server that ignored the date
      // filter would answer both here and fail — which is what makes this a
      // test of the combination rather than of the type filter alone.
      expect(outstandingCustom).toEqual(population.dueLateIds);
      expect(outstandingCustom).not.toContain(population.deliveredCustomId);
      expect(everyCustom.length).toBeGreaterThan(outstandingCustom.length);
      // …and no record of another type answered a `custom` question.
      expect(outstandingCustom).not.toContain(population.projectDefinedId);
    },
  );

  test(
    "a request naming NO parameter at all is still refused, exactly as CR-CRU-129 §S3 left it — " +
      "the date filters open the route, they do not un-parameterise it",
    async () => {
      boot();
      const population = await seedPopulation("cru130-no-parameter");

      const res = await fetch(`${base()}/api/v2/projects/${population.key}/milestones`);
      const body = (await res.json()) as AnyBody;

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(String(body.error ?? "")).toContain("required");
    },
  );

  test(
    "the dated answer is UNWINDOWED and PROJECTION-FREE: every outstanding record comes back, " +
      "each carrying the fields its record holds",
    async () => {
      boot();
      const key = await seedProject("cru130-unwindowed");

      const written: string[] = [];
      for (let index = 0; index < WIDE_POPULATION; index += 1) {
        written.push(
          record(key, "custom", {
            label: `outstanding-${String(index)}`,
            commit: `c${String(index).padStart(6, "0")}`,
            targetAt: EARLY_TARGET + index,
            context: { cycle: `outstanding-${String(index)}` },
          }),
        );
      }

      const answered = await ask(key, { delivered: false });
      expect(answered.status).toBe(200);
      const rows = answered.body.milestones ?? [];

      // POSITIVE + BOUND — every id written, and nothing else. A bounded read
      // would answer a prefix of this and pass any "non-empty" check.
      expect(rows.map((row) => row.id).sort()).toEqual([...written].sort());
      expect(answered.body.totalCount).toBe(written.length);

      // PROJECTION-FREE — the rows are whole records, not a per-type brief
      // that would be lossy for the first field it did not anticipate.
      const sample = rows.find((row) => row.label === "outstanding-7")!;
      expect(sample.commit).toBe("c000007");
      expect(sample.targetAt).toBe(EARLY_TARGET + 7);
      expect(sample.context).toEqual({ cycle: "outstanding-7" });
    },
  );
});
